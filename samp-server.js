/* jshint camelcase:false */

'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var childProcess = require('child_process');
var events = require('events');
var wineProxy = require('./wine-proxy');
var RconConnection = require('samp-rcon');
var async = require('async');
var watchr = require('watchr');

wineProxy.initSync();

var isWindows = (process.platform === 'win32');
var useLinuxBinary = (!isWindows && process.platform !== 'darwin');
var activeServers = [];
var reSplitSpace = /\s+/;
var reIsWindowsBinary = /\.exe$/i;
var reCfgLine = /^\s*([a-z0-9_]+)(?:\s+(.+?))?\s*$/i;
var cfgArrayKeys = ['plugins', 'filterscripts'];
var cfgNumberKeys = [
  'lanmode', 'maxplayers', 'port', 'announce', 'query', 'chatlogging',
  'onfoot_rate', 'incar_rate', 'weapon_rate', 'stream_distance',
  'stream_rate', 'maxnpc'
];

function closeAll(signal) {
  if (signal === undefined) {
    signal = 'SIGTERM';
  }

  var server;

  while ((server = activeServers.pop())) {
    server.stop(signal);
  }
}

var Server = function SampServer(opts) {
  events.EventEmitter.call(this);

  if (typeof opts !== 'object' || !opts.binary) {
    throw new Error('Server binary not specified');
  }

  this.binary = path.resolve(opts.binary);
  this.started = false;
  this.starting = false;
  this.rcon = null;
  this.cfg = null;
  this.logFd = null;
  this.rconConnection = null;
  this.rconQueue = [];

  if (opts.cwd) {
    this.cwd = path.resolve(opts.cwd);
  } else {
    this.cwd = path.dirname(this.binary);
  }
};

util.inherits(Server, events.EventEmitter);

Server.prototype.start = function() {
  var self = this;

  if (this.child || this.starting) {
    this.stop('SIGKILL');
  }

  this.started = false;
  this.starting = true;

  activeServers.push(this);

  var operations = [this.readCfg.bind(this),
                    this.openLog.bind(this),
                    this.watchLog.bind(this)];

  async.parallel(operations, function(err) {
    if (err) {
      self.starting = false;
      self.emit('error', err);

      return;
    }

    var opts = {
      cwd: self.cwd
    };

    if (useLinuxBinary && !reIsWindowsBinary.test(self.binary)) {
      self.child = childProcess.spawn(self.binary, opts);
    } else {
      self.child = wineProxy.spawn(self.binary, opts);
    }

    self.child.on('error', function(err) {
      self.emit('error', err);
    });

    self.child.on('exit', function(code, signal) {
      if (self.starting) {
        self.emit('error', new Error(
          'The server process encountered an error; ' +
          'exit code: ' + code + ', signal: ' + signal,
          'NOSTART'
        ));
      } else if (self.started) {
        self.stop();
      }
    });

    if (self.rconConnection) {
      self.rconConnection.close();
    }

    self.rconConnection = new RconConnection(
      self.cfg.bind,
      self.cfg.port,
      self.cfg.rcon_password,
      '0.0.0.0'
    );

    self.rconConnection
      .on('error', self.emit.bind(self))
      .on('ready', function() {
        var command;

        while ((command = self.rconQueue.pop())) {
          self.send(command);
        }
      });

    self.on('output', function(data) {
      if (data.indexOf('Unable to start server on') !== -1) {
        self.emit('error', new Error(
          'Unable to start the server. Invalid bind IP or port in use?'
        ));
      }
    });

    self.starting = false;
    self.started = true;
  });

  return this;
};

Server.prototype.openLog = function(fn) {
  var self = this;
  var file = path.join(this.cwd, 'server_log.txt');

  if (this.logFd !== null) {
    try {
      fs.closeSync(this.logFd);
    } catch (e) {
      return fn(e);
    }

    this.logFd = null;
  }

  fs.stat(file, function(err, stats) {
    var flags = 'r';

    if (err) {
      if (err.code === 'ENOENT') {
        self.logSize = 0;
        flags = 'a+';
      } else {
        return fn.call(self, err);
      }
    } else {
      self.logSize = stats.size;
    }

    fs.open(file, flags, function(err, fd) {
      if (err) return fn.call(self, err);

      self.logFd = fd;

      fn.call(self);
    });
  });

  return this;
};

Server.prototype.stop = function(signal) {
  if (this.logWatcher) {
    this.logWatcher.close();

    this.logWatcher = null;
  }

  if (this.logFd !== null) {
    try {
      fs.closeSync(this.logFd);
    } catch (e) {}

    this.logFd = null;
  }

  if (this.child) {
    this.child.kill(signal);
    this.child = null;

    this.emit('stop');
  }

  this.starting = false;
  this.started = false;

  return this;
};

Server.prototype.watchLog = function(fn) {
  var self = this;

  if (this.logWatcher) {
    this.logWatcher.close();
  }

  this.logWatcher = watchr.watch({
    path: this.cwd,
    next: function(err, watcherInstance) {
      if (err) return fn.call(self, err);

      fn.call(self);
    },
    listeners: {
      change: function(changeType, file, currentStat, previousStat) {
        if (path.basename(file).toLowerCase() !== 'server_log.txt') {
          return;
        }

        var len = currentStat.size - self.logSize;

        if (len < 0) {
          self.logSize = currentStat.size;

          return;
        } else if (len == 0) {
          return;
        }

        fs.read(
          self.logFd,
          new Buffer(len),
          0,
          len,
          self.logSize,
          function(err, bytesRead, buffer) {
            if (err) return self.emit('error', err);

            self.logSize += bytesRead;

            self.emit('output', buffer.toString());
          }
        );
      }
    }
  });

  return this;
};

Server.prototype.getDefaultCfg = function() {
  return {
    lanmode: 0,
    rcon_password: 'changeme',
    maxplayers: 50,
    port: 7777,
    hostname: 'SA-MP 0.3 Server',
    gamemodes: [],
    filterscripts: [],
    announce: 0,
    query: 1,
    chatlogging: 0,
    weburl: 'www.sa-mp.com',
    onfoot_rate: 40,
    incar_rate: 40,
    weapon_rate: 40,
    stream_distance: 300.0,
    stream_rate: 1000,
    maxnpc: 0,
    logtimeformat: '[%H:%M:%S]',
    bind: '0.0.0.0',
    plugins: []
  };
};

Server.prototype.readCfg = function(fn) {
  var self = this;
  var file = path.join(this.cwd, 'server.cfg');

  this.cfg = null;

  fs.readFile(file, function(err, data) {
    if (err) return fn.call(self, err);

    data = data.toString().split('\n');

    // Start off with the defaults, as that's how the server behaves
    var cfg = self.getDefaultCfg();

    for (var i = 0, len = data.length; i < len; i++) {
      var match = data[i].match(reCfgLine);

      if (match) {
        var key = match[1].toLowerCase();

        if (key === 'echo') {
          continue;
        }

        var value = match[2] ? match[2].toLowerCase() : null;

        if (key.indexOf('gamemode') === 0) {
          var n = +key.substr(8);

          value = value.split(reSplitSpace);

          cfg.gamemodes[n] = {
            name: path.resolve(self.cwd, value[0]),
            repeat: +value[1] || 1
          };

          continue;
        }

        if (cfgArrayKeys.indexOf(key) !== -1) {
          if (value) {
            value = value.split(reSplitSpace);
          } else {
            value = [];
          }
        } else if (value && cfgNumberKeys.indexOf(key) !== -1) {
          value = +value;
        }

        cfg[key] = value;
      }
    }

    // Resolve the filterscript paths
    cfg.filterscripts.forEach(function(val, i, arr) {
      arr[i] = path.resolve(self.cwd, val);
    });

    // Clean the gamemodes array from sparse slots
    cfg.gamemodes = cfg.gamemodes.filter(function(val) {
      return val;
    });

    self.cfg = cfg;

    fn.call(self);
  });

  return this;
};

Server.prototype.send = function(command) {
  if (this.rconConnection && this.rconConnection.ready) {
    this.rconConnection.send(command);
  } else {
    this.rconQueue.push(command);
  }

  return this;
};

module.exports = {
  Server: Server,
  closeAll: closeAll
};