(function() {
  'use strict';

  var childProcess = require('child_process');
  var os = require('os');
  var util = require('util');
  var path = require('path');
  var async = require('async');
  var fs = require('fs');
  var funs = require('funs');
  var extend = require('xtend');
  var waitpid = require('waitpid');
  var temp = require('temp');

  var reWindowsPath = /^[a-z]:(\\|\/|$)/i;
  var options = {
    // Path to the wine binary
    winePath: null,
    // Path to the wineserver binary
    wineserverPath: null,
    // For OS X, helps Wine find libraries
    dyldFallbackLibraryPath: [
      '/opt/local/lib',
      '/usr/X11/lib',
      '/usr/lib'
    ].join(path.delimiter)
  };

  // Functions that will be conditionally created
  var init, initSync, exec, convertPath, startServer, stopServer;

  // Are we on Windows? Create mostly noop functions.
  if (process.platform === 'win32') {
    init = function(fn) {
      fn(null);
    };

    initSync = function() {

    };

    exec = function(command, opts, fn) {
      return childProcess.exec(command, opts, fn);
    };

    convertPath = function(type, p, fn) {
      fn(null, p);
    };

    startServer = function(killFirst, fn) {
      if (fn) {
        fn();
      }
    };

    stopServer = function(fn) {
      if (fn) {
        fn();
      }
    };
  } else {
    var initialized, initializing, initCallbacks;
    var wineVersion, wineBinary, winepathBinary, wineserverBinary;
    var pathCache = {};
    var serverChild = null;

    var versionInfoCommand = function(paths) {
      var cmd = '', first = true;

      paths.forEach(function(p, i) {
        if (!p) {
          return;
        }

        if (first) {
          first = false;
        } else {
          cmd += '||';
        }

        cmd += '(which ' + p + ' && (' + p + ' --version 2>&1))';
      });

      return cmd;
    };

    init = function(fn) {
      if (initialized) {
        return fn(null);
      } else if (initializing) {
        return initCallbacks.push(fn);
      }

      initializing = true;
      initCallbacks = [fn];

      fn = function(err) {
        for (var i = 0; i < initCallbacks.length; i++) {
          initCallbacks[i](err);
        }

        initializing = false;
        initCallbacks = null;
      };
      
      var cmd = [
          versionInfoCommand([options.winePath, 'wine.bin', 'wine']),
          versionInfoCommand([options.wineserverPath, 'wineserver'])
      ].join('&&');
      
      childProcess.exec(
        cmd, {
          maxBuffer: 1024,
          timeout: 1000
        }, function(err, stdout, stderr) {
          if (err) return fn(err);

          var info = stdout.trim().split('\n');

          if (info.length !== 4) {
            return fn(new Error(
              'Unexpected output: ' + JSON.stringify(stdout)
            ));
          }

          wineBinary = info[0];
          module.exports.wineVersion = wineVersion = info[1];
          winepathBinary = info[0].replace('.bin', '') + 'path';
          wineserverBinary = info[2];

          initialized = true;
          fn(null);
        }
      );
    };

    initSync = function() {
      if (initialized) return;
      if (initializing) throw new Error('initSync can\'t run after init');

      var outfile = temp.openSync();
      var cmd = [
          versionInfoCommand([options.winePath, 'wine.bin', 'wine']),
          versionInfoCommand([options.wineserverPath, 'wineserver'])
      ].join('&&');
      
      cmd = '(' + cmd + ') &> ' + outfile.path;

      try {
        var child = childProcess.exec(cmd, {
          maxBuffer: 1024,
          timeout: 1000
        });

        //waitpid doesn't work properly
        //var status = waitpid(child.pid);
        var status = {exitCode: 0};
        var t = new Date();
        while (new Date() - t < 100) {}

        if (status.exitCode !== 0) {
          throw new Error(
            'Wine version check failed with code ' + status.exitCode
          );
        }
      } catch (e) {
        fs.closeSync(outfile.fd);
        fs.unlinkSync(outfile.path);

        throw e;
      }

      var output;

      try {
        output = fs.readFileSync(outfile.path);
        output = output.toString().trim();
      } catch (e) {}

      fs.closeSync(outfile.fd);
      fs.unlinkSync(outfile.path);

      if (!output) {
        throw new Error('No output from the version check.');
      }

      var info = output.split('\n');

      if (info.length !== 4) {
        throw new Error('Unexpected output: ' + JSON.stringify(output));
      }

      wineBinary = info[0];
      module.exports.wineVersion = wineVersion = info[1];
      winepathBinary = info[0].replace('.bin', '') + 'path';
      wineserverBinary = info[2];

      initialized = true;
    };

    exec = function(command, opts, fn) {
      if (!initialized) throw new Error('wine-proxy is not initialized');

      opts = extend({
        env: {
          DYLD_FALLBACK_LIBRARY_PATH: options.dyldFallbackLibraryPath
        }
      }, opts);

      return childProcess.exec(wineBinary + ' ' + command, opts, fn);
    };

    // TODO: winepath cache
    convertPath = function(toType, p, fn) {
      var paths;
      var type = toType.charAt(0).toLowerCase();

      if (type !== 'w' && type !== 'u') {
        throw new TypeError('toType should be either windows or unix');
      }

      if (typeof p === 'string') {
        paths = ['-' + type, '--', p];
      } else {
        paths = ['-' + type, '--'].concat(p);
      }

      var child = childProcess.spawn(winepathBinary, paths);
      var output = '';

      child.stdout.on('data', function(data) {
        output += data;
      });

      child.stdout.on('end', function() {
        if (!output.length) {
          return fn(new Error('winepath failed (empty output)'));
        }

        output = output.trim();

        if (typeof p === 'string') {
          realpathRelaxed(p, pathCache, fn);

          return;
        } else {
          output = output.split('\n');

          if (output.length !== p.length) {
            return fn(new Error(
              'winepath returned an incorrect number of paths'
            ));
          }

          if (type === 'w') {
            return fn(null, output);
          }

          var operations = [];
          var operation = function(i, fn) {
            var p = output[i];

            if (pathCache[p]) {
              return fn(null, pathCache[p]);
            }

            realpathRelaxed(p, pathCache, function(err, resolvedPath) {
              if (err) {
                if (err.code === 'ENOENT') {
                  resolvedPath = p;
                } else {
                  return fn(err);
                }
              }

              pathCache[p] = resolvedPath;

              fn(null, resolvedPath);
            });
          };

          for (var i = 0; i < output.length; i++) {
            operations.push(operation.bind(null, i));
          }

          async.parallel(operations, fn);
        }
      });
    };
    
    startServer = function(killFirst, fn) {
      if (serverChild !== null) {
        serverChild.kill(9);
      }
      
      if (killFirst) {
        stopServer(start);
      } else {
        start();
      }
      
      function start(err) {
        if (err) return fn(err);
        
        try {
          serverChild = childProcess.spawn(wineserverBinary, ['-f', '-p', '-d0']);
        } catch (e) {
          fn(err);
        }
        
        fn(null);
      }
    };

    stopServer = function(fn) {
      try {
        childProcess.exec(wineserverBinary + ' -k', function(err) {
          if (err) {
            fn(err);
          } else {
            fn(null);
          }
        });
      } catch (e) {
        fn(e);
      }
    };
  }

  // Functions that are the same for win/non-win
  function option(key, value) {
    if (value === undefined) {
      if (key === 'dyldFallbackLibraryPath') {
        return options[key].split(path.delimiter);
      }

      return options[key];
    } else {
      if (key === 'dyldFallbackLibraryPath') {
        options[key] = value.join(path.delimiter);
      } else {
        options[key] = value;
      }
    }
  }

  function realpathRelaxed(p, cache, options, fn) {
    var tmp;

    // p can also be after cache/options
    if (typeof p === 'object') {
      tmp = p;

      if (typeof cache === 'string') {
        p = cache;
        cache = tmp;
      } else if (typeof options === 'string') {
        p = options;
        options = cache;
        cache = tmp;
      }
    }

    if (typeof cache === 'function') {
      fn = cache;
      cache = undefined;
    } else if (typeof options === 'function') {
      fn = options;
      options = {};
    }

    if (cache && cache[p]) {
      return fn(null, cache[p]);
    }

    realpathRelaxedStep(p, cache, [], options && options.steps || 2, fn);
  }

  function realpathRelaxedStep(p, cache, traversed, steps, fn) {
    fs.realpath(p, cache, function(err, resolvedPath) {
      if (err) {
        if (steps <= 0 || err.code !== 'ENOENT') {
          return fn(err);
        }

        traversed.unshift(path.basename(p));

        p = path.dirname(p);

        steps -= 1;

        realpathRelaxedStep(p, cache, traversed, steps, fn);

        return;
      }

      traversed.unshift(resolvedPath);

      p = path.resolve.apply(null, traversed);

      return fn(null, p);
    });
  }

  function isWindowsPath(p) {
    return reWindowsPath.test(p);
  }

  // Argument processing using funs
  init = funs('function', init);
  exec = funs('string,object?,function', exec);
  convertPath = funs('string,string|array,function', convertPath);
  startServer = funs('boolean?,function', startServer);
  stopServer = funs('function', stopServer);

  module.exports = {
    wineVersion: null,
    option: option,
    init: init,
    initSync: initSync,
    exec: exec,
    convertPath: convertPath,
    realpathRelaxed: realpathRelaxed,
    startServer: startServer,
    stopServer: stopServer,
    isWindowsPath: isWindowsPath
  };
}());