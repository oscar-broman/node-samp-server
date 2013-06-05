#!/usr/bin/env node

'use strict';

var path = require('path');
var fs = require('fs');
var pawnCompiler = require('../lib/pawn-compiler.js');

var pwn = process.argv[2];

if (!pwn) {
  console.error('Usage: run-pwn [file]');

  process.exit();
}

pwn = path.resolve(pwn);

if (!fs.existsSync(pwn)) {
  console.error('The input file doesn\'t exist.');

  process.exit();
}

pawnCompiler.compile(pwn, {
  debugLevel: 2,
  requireSemicolons: true,
  requireParentheses: true,
  tabsize: 4
}, function(err, errors, outputFile) {
  if (errors) {
    errors.forEach(function(error) {
      console.error(error.toString());
    });
  }

  if (err) {
    throw err;
  }

  process.argv[2] = outputFile;

  require('./run-amx');
});