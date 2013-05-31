'use strict';

var path = require('path');
var sampServer = require('../samp-server');

['SIGHUP', 'SIGINT'].forEach(function(event) {
  process.on(event, process.exit.bind(0));
});

['SIGQUIT', 'SIGTERM', 'quit', 'exit'].forEach(function(event) {
  process.on(event, shutdown.bind(null, event));
});

function shutdown(event) {
  if (event === 'exit') {
    sampServer.closeAll();
  } else {
    sampServer.closeAll('SIGKILL');
  }
}

sampServer.tempServer(
  path.resolve('test', 'server', 'gamemodes', 'test.amx'), {
    binary: path.resolve('test', 'server', 'samp-server.exe')
  }, function(err, server) {
    if (err) throw err;

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
      .start()
      .send('echo hello world');
  }
);

/*
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
  .start()
  .send('echo hello world');
*/