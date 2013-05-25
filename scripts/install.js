'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

process.chdir(path.resolve(__dirname, '..'));

var pkg = fs.readFileSync('package.json');
var deps = 'dependencies_' + process.platform;

pkg = JSON.parse(pkg.toString());

if (pkg[deps]) {
  for (var module in pkg[deps]) {
    if (pkg[deps][module]) {
      pkg['dependencies_all'][module] = pkg[deps][module];
    } else {
      delete pkg['dependencies_all'][module];
    }
  }
}

var deps = [];

for (var module in pkg['dependencies_all']) {
  deps.push(module + '@"' + pkg['dependencies_all'][module] + '"');
}

installStep();

function installStep(err) {
  if (err) throw err;

  var dep = deps.pop();

  if (!dep) {
    return;
  }

  console.log('Installing ' + dep);

  childProcess.exec('npm install ' + dep, {
    stdio: ['ignore', process.stdout, process.stderr]
  }, installStep);
}