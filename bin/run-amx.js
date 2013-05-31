#!/usr/bin/env node

'use strict';

var path = require('path');
var sampServer = require('../samp-server');

var amx = process.argv[2];

if (!amx) {
  console.error('Usage: run-amx [file]');

  process.exit();
}

amx = path.resolve(process.cwd, amx);

var serverBinary;

if (process.platform === 'win32' || process.platform === 'darwin') {
  serverBinary = 'samp-server.exe';
} else {
  serverBinary = 'samp03svr';
}

serverBinary = path.join(__dirname, serverBinary);

var quitting = false;

['SIGQUIT', 'SIGTERM', 'SIGHUP', 'SIGINT', 'exit'].forEach(function(event) {
  process.on(event, shutdown);
});

process.once('uncaughtException', function(e) {
  shutdown();

  throw e;
});

function shutdown() {
  if (quitting) {
    return;
  }

  quitting = true;

  sampServer.closeAllSync('SIGKILL');
}

sampServer.tempServer(
  amx, {
    binary: serverBinary
  }, function(err, server) {
    if (err) throw err;

    process.stdin.resume();
    process.stdin.on('data', function(data) {
      server.send(data.toString().trim());
    });

    server
      .on('error', function(err) {
        throw err;
      })
      .on('output', function(data) {
        console.log(data.trim());
      })
      .on('stop', function() {
        console.log('The server stopped');

        process.exit();
      })
      .start();
  }
);