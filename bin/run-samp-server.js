#!/usr/bin/env node

'use strict';

var path = require('path');
var sampServer = require('../lib/samp-server');

var serverBinary = process.argv[2];

if (!serverBinary) {
  console.error('Usage: run-samp-server [server binary]');

  process.exit();
}

serverBinary = path.resolve(process.cwd(), serverBinary);

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

var server = new sampServer.Server({
  binary: serverBinary
});

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