'use strict';

var fs = require('fs');
var path = require('path');

process.chdir(path.resolve(__dirname, '..'));

if (fs.existsSync('package.original.json')) {
  try {
    fs.unlinkSync('package.json');
  } catch (e) {}

  fs.renameSync('package.original.json', 'package.json');
}

if (process.env.npm_lifecycle_event === 'postinstall') {
  process.exit();
}

var pkg = fs.readFileSync('package.json');
var deps = 'dependencies-' + process.platform;

pkg = JSON.parse(pkg.toString());

if (pkg[deps]) {
  for (var module in pkg[deps]) {
    if (pkg[deps][module]) {
      pkg.dependencies[module] = pkg[deps][module];
    } else {
      delete pkg.dependencies[module];
    }
  }
}

for (var key in pkg) {
  if (/^dependencies-/.test(key)) {
    delete pkg[key];
  }
}

fs.renameSync('package.json', 'package.original.json');
fs.writeFileSync('package.json', JSON.stringify(pkg, null, '  '));