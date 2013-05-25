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
var Tail = require('tailnative');

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
  this.cfg = null;
  this.rconConnection = null;
  this.commandQueue = [];

  if (!useLinuxBinary || reIsWindowsBinary.test(this.binary)) {
    this.windowsBinary = true;
  } else {
    this.windowsBinary = false;
  }

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
                    this.touchLog.bind(this),
                    this.tailLog.bind(this)];

  async.series(operations, function(err) {
    if (err) {
      self.starting = false;
      self.emit('error', err);

      return;
    }

    var opts = {
      cwd: self.cwd,
      stdio: 'ignore'
    };

    if (self.windowsBinary) {
      self.child = wineProxy.spawn(self.binary, opts);
    } else {
      self.child = childProcess.spawn(self.binary, opts);
    }

    self.child
      .on('error', self.emit.bind(self, 'error'))
      .on('exit', function(code, signal) {
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
      .on('error', self.emit.bind(self, 'error'))
      .on('ready', self.flushCommandQueue.bind(self));

    self.on('output', function(data) {
      if (data.indexOf('Unable to start server on') !== -1) {
        self.emit('error', new Error(
          'Unable to start the server. Invalid bind IP or port in use?'
        ));
        
        self.stop();
      }
    });

    self.starting = false;
    self.started = true;
  });

  return this;
};

Server.prototype.touchLog = function(fn) {
  var self = this;
  var file = path.join(this.cwd, 'server_log.txt');

  fs.stat(file, function(err, stats) {
    var flags = 'r';

    if (err) {
      if (err.code === 'ENOENT') {
        flags = 'a+';
      } else {
        return fn.call(self, err);
      }
    }

    fs.open(file, flags, function(err, fd) {
      if (err) return fn.call(self, err);

      fs.close(fd, fn.bind(self));
    });
  });

  return this;
};

Server.prototype.stop = function(signal) {
  this.starting = false;
  this.started = false;

  if (this.logTail) {
    this.logTail.close();

    this.logTail = null;
  }

  if (this.child) {
    this.child.kill(signal);
    this.child = null;

    this.emit('stop');
  }

  return this;
};

Server.prototype.tailLog = function(fn) {
  if (this.logTail) {
    this.logTail.close();
  }

  this.logTail = new Tail(path.join(this.cwd, 'server_log.txt'));

  this.logTail
    .on('data', this.emit.bind(this, 'output'))
    .on('error', this.emit.bind(this, 'error'))
    .on('end', function() {
      if (this.starting || this.started) {
        this.emit('error', new Error('Log tail ended unexpectedly'));
      }
    }.bind(this));

  fn();

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
    this.commandQueue.push(command);
  }

  return this;
};

Server.prototype.flushCommandQueue = function() {
  var command;

  while ((command = this.commandQueue.pop())) {
    this.send(command);
  }
};

module.exports = {
  Server: Server,
  closeAll: closeAll
};