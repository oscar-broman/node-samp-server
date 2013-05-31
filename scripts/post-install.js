/* jshint camelcase:false */

'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

process.chdir(path.resolve(__dirname, '..'));

var pkg = fs.readFileSync('package.json');

pkg = JSON.parse(pkg.toString());

var deps;

if (process.platform === 'win32') {
  deps = pkg.dependencies_win32 || {};
} else {
  deps = pkg.dependencies_unix || {};
}

var depKeys = Object.keys(deps);

installStep();

function installStep(err) {
  if (err) throw err;

  var dep = depKeys.pop();

  if (!dep) {
    return;
  }
  
  dep += '@"' + deps[dep] + '"';

  console.log('Installing ' + dep);

  childProcess.exec('npm install ' + dep, {
    stdio: ['ignore', process.stdout, process.stderr]
  }, installStep);
}