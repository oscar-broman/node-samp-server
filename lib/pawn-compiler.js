'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var async = require('async');
var temp = require('temp');
var wineProxy = require('./wine-proxy.js');

var reErrorString = /^\s*(.+?)\((\d+)(?: -- (\d+))?\) : (warning|error|fatal error) (\d+): (.*?)\s*$/;

var pawnccBinary = path.resolve(__dirname, '..', 'bin', 'pawncc', 'pawncc.exe');

var compilerFlags = {
  dataAlignment:      {flag: 'A',  type: 'string'},
  outputAsm:          {flag: 'a',  type: 'enable'},
  compactEncoding:    {flag: 'C',  type: 'bool'},
  codepage:           {flag: 'c',  type: 'string'},
  workingDirectory:   {flag: 'D',  type: 'path'},
  debugLevel:         {flag: 'd',  type: 'string'},
  errorFile:          {flag: 'e',  type: 'path'},
  notifyHWND:         {flag: 'H',  type: 'string'},
  includeDirectory:   {flag: 'i',  type: 'path'},
  outputLst:          {flag: 'l',  type: 'enable'},
  outputFile:         {flag: 'o',  type: 'path'},
  optimizationLevel:  {flag: 'O',  type: 'string'},
  prefixFile:         {flag: 'p',  type: 'path'},
  crossReference:     {flag: 'r',  type: 'path'},
  stackHeapSize:      {flag: 'S',  type: 'string'},
  skipLines:          {flag: 's',  type: 'string'},
  tabsize:            {flag: 't',  type: 'string'},
  verbosityLevel:     {flag: 'v',  type: 'string'},
  disableWarning:     {flag: 'w',  type: 'string'},
  amSizeLimit:        {flag: 'X',  type: 'string'},
  amDataSizeLimit:    {flag: 'XD', type: 'string'},
  backslashEscape:    {flag: '\\', type: 'enable'},
  caretEscape:        {flag: '^',  type: 'enable'},
  requireSemicolons:  {flag: ';',  type: 'bool'},
  requireParentheses: {flag: '(',  type: 'bool'},
  symbols:            {            type: 'symbols'}
};

// Error constructor
function PawnCompilerError(info) {
  this.file = info.file;
  this.startLine = info.startLine;
  this.endLine = info.endLine;
  this.type = info.type;
  this.number = info.number;
  this.message = info.message;
  this.fatal = info.fatal || false;
}

PawnCompilerError.prototype.toString = function() {
  var errstr = '';

  errstr += this.file;

  if (this.startLine === this.endLine) {
    errstr += '(' + this.startLine + ') : ';
  } else {
    errstr += '(' + this.startLine + ' -- ' + this.endLine + ') : ';
  }

  if (this.fatal) {
    errstr += 'fatal ';
  }

  errstr += this.type + ' ';
  errstr += this.number + ': ';
  errstr += this.message;

  return errstr;
};

// Parse an error string
function parseErrorString(errstr) {
  var match = errstr.match(reErrorString);

  if (match) {
    var error = {
      file: match[1],
      startLine: +match[2],
      endLine: match[3] === undefined ? +match[2] : +match[3],
      type: match[4],
      number: +match[5],
      message: match[6] || ''
    };

    if (error.type === 'fatal error') {
      error.fatal = true;
      error.type = 'error';
    }

    return new PawnCompilerError(error);
  }

  return null;
}

function buildFlags(opts, fn) {
  var flags = [];

  for (var k in opts) {
    if (!compilerFlags.hasOwnProperty(k)) {
      continue;
    }

    if (util.isArray(opts[k])) {
      for (var i = 0, len = opts[k].length; i < len; i++) {
        flags.push({
          info: compilerFlags[k],
          value: opts[k][i]
        });
      }
    } else if (typeof opts[k] === 'object') {
      for (var sym in opts[k]) {
        if (opts[k].hasOwnProperty(sym)) {
          flags.push({
            info: compilerFlags[k],
            sym: sym,
            value: opts[k][sym]
          });
        }
      }
    } else {
      flags.push({
        info: compilerFlags[k],
        value: opts[k]
      });
    }
  }

  async.map(flags, buildFlag, function(err, flags) {
    if (err) return fn(err);

    fn(null, flags.filter(function(flag) {
      return flag !== null;
    }));
  });
}

function buildFlag(flag, fn) {
  switch (flag.info.type) {
  case 'path':
    wineProxy.convertPath('w', flag.value, function(err, p) {
      if (err) return fn(err);

      fn(null, '-' + flag.info.flag + '=' + p);
    });

    break;

  case 'enable':
    if (flag.value) {
      fn(null, '-' + flag.info.flag);
    } else {
      fn(null, null);
    }

    break;

  case 'bool':
    fn(null, '-' + flag.info.flag + (flag.value ? '+' : '-'));

    break;

  case 'string':
    fn(null, '-' + flag.info.flag + '=' + flag.value);

    break;

  case 'symbols':
    if (flag.value === null) {
      flag.value = '';
    }

    fn(null, flag.sym + '=' + flag.value);

    break;

  default:
    fn(new Error('Unknown flag type: ' + flag.info.type));

    break;
  }
}

function compile(pwn, opts, fn) {
  var operations = {
    flags: buildFlags.bind(null, opts)
  };

  if (!opts.workingDirectory) {
    opts.workingDirectory = process.cwd();
  }

  // TODO: cleanup
  if (pwn instanceof Buffer) {
    var pwnName = temp.path({suffix: '.pwn'});

    operations.pwn = fs.writeFile.bind(null, pwnName, pwn, {});

    pwn = pwnName;
  } else {
    pwn = path.resolve(opts.workingDirectory, pwn);
  }

  operations.pwnName = wineProxy.convertPath.bind(null, 'w', pwn);

  if (!opts.outputFile) {
    var ext = '.amx';

    if (opts.outputLst) {
      ext = '.lst';
    } else if (opts.outputAsm) {
      ext = '.asm';
    }

    opts.outputFile = pwn.replace(/\.[^.]+$/, '') + ext;
  } else {
    opts.outputFile = path.resolve(opts.workingDirectory, opts.outputFile);
  }

  operations.outputExists = function(fn) {
    fs.exists(opts.outputFile, function(exists) {
      if (exists) {
        fs.unlink(opts.outputFile, fn);
      } else {
        fn(null);
      }
    });
  };

  if (opts.errorFile) {
    throw new Error('Using outputFile is not yet supported.');
  }

  async.series(operations, function(err, results) {
    if (err) return fn(err);

    var args = results.flags.join(' ') + ' ' + results.pwnName;

    // TODO: use wineProxy.spawn to avoid this
    args = args.replace(/(["'$`\\();])/g, '\\$1');

    wineProxy.exec(pawnccBinary + ' ' + args, {
      cwd: opts.workingDirectory,
      timeout: opts.timeout || 10000,
      killSignal: 'SIGKILL',
      env: {
        DISPLAY: ''
      }
    }, function(err, stdout, stderr) {
      var errors;

      if (stderr) {
        errors = stderr
                   .split('\n')
                   .map(parseErrorString)
                   .filter(function(v) {
                      return v !== null;
                    });
      } else {
        errors = [];
      }

      if (err) {
        if (err.killed) {
          return fn(new Error('The compiler was killed for taking too long.'));
        } else {
          resolveErrorPaths(errors, function() {
            fn(new Error('The compiler failed.'), errors);
          });
        }
      }

      resolveErrorPaths(errors, function() {
        fs.stat(opts.outputFile, function(err, stats) {
          if (err) {
            return fn(err);
          } else if (!stats.size) {
            return fn(new Error(
              'The compiler generated an empty output file.'
            ), errors);
          }

          return fn(null, errors, opts.outputFile);
        });
      });
    });
  });
}

function resolveErrorPaths(errors, fn) {
  var paths = {};

  if (!errors.length || process.platform === 'win32') {
    return fn(null);
  }

  for (var i = 0; i < errors.length; i++) {
    paths[errors[i].file] = true;
  }

  paths = Object.keys(paths);

  wineProxy.convertPath('u', paths, function(err, newPaths) {
    if (err) return fn(err);

    for (var i = 0; i < errors.length; i++) {
      errors[i].file = newPaths[paths.indexOf(errors[i].file)];
    }

    fn(null);
  });
}

module.exports = exports = {
  PawnCompilerError: PawnCompilerError,
  buildFlags: buildFlags,
  compile: compile
};