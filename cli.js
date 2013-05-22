'use strict';

var path = require('path');
var sampServer = require('./samp-server');

['SIGHUP', 'SIGINT'].forEach(function(event) {
  process.on(event, process.exit.bind(0));
});

['SIGQUIT', 'SIGTERM',
 'SIGUSR1', 'SIGUSR2', 'quit', 'exit'].forEach(function(event) {
    process.on(event, shutdown.bind(null, event));
  });

function shutdown(event) {
  if (event === 'exit') {
    sampServer.closeAll();
  } else {
    sampServer.closeAll('SIGKILL');
  }
}

var server = new sampServer.Server({
  binary: path.resolve('server', 'samp-server.exe')
});

server
  .on('error', function(err) {
    shutdown('SIGKILL');

    throw err;
  })
  .on('output', function(data) {
    console.log(data);
  })
  .on('stop', function() {
    console.log('The server stopped');
  });

server.start();
server.send('varlist');