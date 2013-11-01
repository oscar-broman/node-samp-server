/* jshint camelcase:false */

'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var childProcess = require('child_process');
var events = require('events');
var async = require('async');
var net = require('net');
var temp = require('temp');
var rimraf = require('rimraf');
var pty = require('pty.js');

var isWindows = (process.platform === 'win32');
var RconConnection;

if (!isWindows) {
  RconConnection = require('samp-rcon');
}

var useLinuxBinary = (!isWindows && process.platform !== 'darwin');
var activeServers = [];
var reSplitSpace = /\s+/;
var reIsWindowsBinary = /\.exe$/i;
var reCfgLine = /^\s*([a-z0-9_]+)(?:\s+(.+?))?\s*$/i;
var cfgArrayKeys = ['plugins', 'filterscripts'];
var cfgNumberKeys = [
  'lanmode', 'maxplayers', 'port', 'announce', 'query', 'chatlogging',
  'onfoot_rate', 'incar_rate', 'weapon_rate', 'stream_distance',
  'stream_rate', 'maxnpc', 'output'
];

function closeAll(signal, sync) {
  if (signal === undefined) {
    signal = 'SIGTERM';
  }

  var server;

  while ((server = activeServers.pop())) {
    server.stop(signal, sync);
  }
}

function closeAllSync(signal) {
  closeAll(signal, true);
}

function tempServer(amx, opts, fn) {
  if (typeof opts !== 'object' || !opts.binary) {
    throw new Error('Server binary not specified');
  }

  if (opts.plugins && !util.isArray(opts.plugins)) {
    throw new TypeError('"plugins" should be an array');
  }

  var cfg = getDefaultCfg();
  var operations = {
    tempDir: temp.mkdir.bind(null, 'samp-')
  };

  cfg.query = 1;
  cfg.announce = 0;
  cfg.rcon_password = null;
  cfg.port = null;
  cfg.gamemodes = [{
    name: 'gm',
    repeat: 1
  }];

  var amxData = null;

  if (amx instanceof Buffer) {
    amxData = amx;
  } else {
    operations.amxRead = fs.readFile.bind(null, amx);
  }

  for (var key in opts) {
    if (cfg.hasOwnProperty(key)) {
      cfg[key] = opts[key];
    }
  }

  if (!cfg.rcon_password) {
    cfg.rcon_password = Math.random().toString(36).substring(2, 12);
  }

  if (cfg.port === null) {
    operations.freePort = getFreePort;
  }

  async.series(operations, function(err, results) {
    if (err) return fn(err);

    if (results.freePort) {
      cfg.port = results.freePort;
    }

    if (results.amxRead) {
      amxData = results.amxRead;
    }

    var amxPath = path.join(results.tempDir, 'gamemodes', 'gm.amx');
    var cfgPath = path.join(results.tempDir, 'server.cfg');
    var cfgString = buildCfg(cfg, results.tempDir);

    var operations = [
      fs.symlink.bind(null, '/dev/null', path.join(results.tempDir, 'server_log.txt')),
      fs.mkdir.bind(null, path.join(results.tempDir, 'gamemodes')),
      fs.mkdir.bind(null, path.join(results.tempDir, 'plugins')),
      fs.mkdir.bind(null, path.join(results.tempDir, 'filterscripts')),
      fs.mkdir.bind(null, path.join(results.tempDir, 'scriptfiles')),
      fs.writeFile.bind(null, amxPath, amxData),
      fs.writeFile.bind(null, cfgPath, cfgString)
    ];

    async.series(operations, function(err) {
      if (err) {
        rimraf(results.tempDir, function() {
          fn(err);
        });

        return;
      }

      var server = new Server({
        binary: opts.binary,
        maxTime: opts.maxTime,
        cwd: results.tempDir,
        temporary: true
      });

      fn(null, server);
    });
  });
}

function getFreePort(fn) {
  var server = net.createServer();
  var calledFn = false;

  server.on('error', function(err) {
    server.close();

    if (!calledFn) {
      calledFn = true;
      fn(err);
    }
  });

  server.listen(0, function() {
    var port = server.address().port;

    server.close();

    if (!calledFn) {
      calledFn = true;

      if (!port) {
        fn(new Error('Unable to get the server\'s given port'));
      } else {
        fn(null, port);
      }
    }
  });
}

function getDefaultCfg() {
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
    output: 1,
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
}

function buildCfg(cfg, dir) {
  var output = '';
  var gamemodes = path.resolve(dir, 'gamemodes');
  var filterscripts = path.resolve(dir, 'filterscripts');
  var plugins = path.resolve(dir, 'plugins');

  function relativePath(d, p) {
    p = path.resolve(d, p);

    return path.relative(d, p);
  }

  function putGamemode(gm) {
    output += 'gamemode' + idx + ' ';
    idx += 1;

    if (typeof gm === 'string') {
      output += relativePath(gamemodes, gm) + ' 1';
    } else {
      output += relativePath(gamemodes, gm.name) + ' ' + gm.repeat;
    }

    output += '\n';
  }

  for (var key in cfg) {
    if (!cfg.hasOwnProperty(key)) {
      continue;
    }

    if (key === 'plugins') {
      output += 'plugins ';
      output += cfg[key].map(relativePath.bind(null, plugins)).join(' ');
      output += '\n';
    } else if (key === 'filterscripts') {
      output += 'filterscripts ';
      output += cfg[key].map(relativePath.bind(null, filterscripts)).join(' ');
      output += '\n';
    } else if (key === 'gamemodes') {
      var idx = 0;

      cfg[key].forEach(putGamemode);
    } else {
      output += key + ' ' + cfg[key] + '\n';
    }
  }

  return output;
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
  this.temporary = opts.temporary || false;
  this.maxTime = opts.maxTime || false;
  this.timeout = null;

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

  if (this.term || this.starting) {
    this.stop();
  }

  this.started = false;
  this.starting = true;

  if (this.maxTime) {
    this.timeout = setTimeout(
      this.stop.bind(this, 'SIGKILL', false, true),
      this.maxTime
    );
  }

  activeServers.push(this);

  var operations = [this.readCfg.bind(this)];

  async.series(operations, function(err) {
    if (err) {
      self.starting = false;
      self.stop('SIGKILL');
      self.emit('error', err);

      return;
    }

    if (!isWindows && self.windowsBinary) {
      self.term = pty.spawn('wine', [self.binary], {
        name: 'xterm-color',
        cols: 800,
        rows: 30,
        cwd: self.cwd,
        env: process.env
      });
    } else {
      self.term = pty.spawn(self.binary, [], {
        name: 'xterm-color',
        cols: 800,
        rows: 30,
        cwd: self.cwd,
        env: process.env
      });
    }

    self.term
      .on('error', self.emit.bind(self, 'error'))
      .on('exit', function() {
        if (self.starting) {
          self.emit('error', new Error(
            'Failed to start the server',
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
    
    self.hasOutput = false;
    self.outputBuf = '';

    self.term.on('data', function(data) {
      if (!self.hasOutput) {
        if (data.indexOf('----------') !== -1) {
          self.hasOutput = true;
        } else {
          return;
        }
      }
      
      if (data.trim() === self.rconConnection.connectMessage) {
        return;
      }
      
      self.outputBuf += data;
      
      var idx;
      
      while (-1 !== (idx = self.outputBuf.indexOf('\n'))) {
        self.emit('output', self.outputBuf.substr(0, idx).replace(/\r+$/, ''));
        
        self.outputBuf = self.outputBuf.substr(idx + 1);
      }
      
      if (data.indexOf('Unable to start server on') !== -1) {
        self.stop();
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

Server.prototype.stop = function(signal, sync, timeout) {
  if (this.stopping || !this.started) {
    return;
  }

  var operations = [];
  var self = this;

  this.stopping = !sync;
  this.starting = false;
  this.started = false;

  if (this.timeout !== null) {
    clearTimeout(this.timeout);

    this.timeout = null;
  }

  if (this.term) {
    this.term.kill(signal);
    this.term = null;
  }

  if (this.temporary) {
    if (sync) {
      try {
        rimraf.sync(this.cwd);
      } catch (e) {}
    } else {
      operations.push(rimraf.bind(null, this.cwd));
    }
  }

  if (sync) {
    this.emit('stop', timeout);
  } else {
    async.series(operations, function() {
      self.stopping = false;

      self.emit('stop', timeout);
    });
  }

  return this;
};

Server.prototype.stopSync = function(signal) {
  this.stop(signal, true);
};

Server.prototype.readCfg = function(fn) {
  var self = this;
  var file = path.join(this.cwd, 'server.cfg');

  this.cfg = null;

  fs.readFile(file, function(err, data) {
    if (err) return fn.call(self, err);

    data = data.toString().split('\n');

    // Start off with the defaults, as that's how the server behaves
    var cfg = getDefaultCfg();

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
            name: path.resolve(self.cwd, 'gamemodes', value[0]),
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

    // Resolve filterscript paths
    cfg.filterscripts.forEach(function(val, i, arr) {
      arr[i] = path.resolve(self.cwd, 'filterscripts', val);
    });

    // Resolve plugin paths
    cfg.plugins.forEach(function(val, i, arr) {
      arr[i] = path.resolve(self.cwd, 'plugins', val);
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
  closeAll: closeAll,
  closeAllSync: closeAllSync,
  tempServer: tempServer,
  buildCfg: buildCfg
};