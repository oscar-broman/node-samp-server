/* jshint camelcase:false */

'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

process.chdir(path.resolve(__dirname, '..'));

var pkg = fs.readFileSync('package.json');
var deps = 'dependencies_' + process.platform;

pkg = JSON.parse(pkg.toString());

if (pkg[deps]) {
  for (var m in pkg[deps]) {
    if (pkg[deps][m]) {
      pkg.dependencies_all[m] = pkg[deps][m];
    } else {
      delete pkg.dependencies_all[m];
    }
  }
}

var deps = [];

for (var m in pkg.dependencies_all) {
  deps.push(m + '@"' + pkg.dependencies_all[m] + '"');
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