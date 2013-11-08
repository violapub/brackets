/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, appshell, $, window, IDBFS */

define(function (require, exports, module) {
    "use strict";

    var FileSystemStats     = require("filesystem/FileSystemStats"),
        FileSystemError     = require("filesystem/FileSystemError");

    // IDBFS File System object - https://github.com/js-platform/idbfs
    var _fs;

    /**
     * @const
     * Amount of time to wait before automatically rejecting the connection
     * deferred. If we hit this timeout, we'll never have a node connection
     * for the file watcher in this run of Brackets.
     */
    var NODE_CONNECTION_TIMEOUT = 30000,    // 30 seconds - TODO: share with StaticServer & Package?
        FILE_WATCHER_BATCH_TIMEOUT = 200;   // 200ms - granularity of file watcher changes

    var _changeCallback,            // Callback to notify FileSystem of watcher changes
        _changeTimeout,             // Timeout used to batch up file watcher changes
        _pendingChanges = {};       // Pending file watcher changes

    function _mapError(err) {
        if (!err) {
            return null;
        }

        // TODO: better error mapping...
        switch (err.name) {
        case "ENoEntry":
            return FileSystemError.NOT_FOUND;
        case "EExists":
            return FileSystemError.ALREADY_EXISTS;
        }
        return FileSystemError.UNKNOWN;
    }

    /** Returns the path of the item's containing directory (item may be a file or a directory) */
    function _parentPath(path) {
        var lastSlash = path.lastIndexOf("/");
        if (lastSlash === path.length - 1) {
            lastSlash = path.lastIndexOf("/", lastSlash - 1);
        }
        return path.substr(0, lastSlash + 1);
    }

    function init(callback) {
        // Create new fs
        _fs = new IDBFS.FileSystem('local');

        // Don't want to block on _nodeConnectionDeferred because we're needed as the 'root' fs
        // at startup -- and the Node-side stuff isn't needed for most functionality anyway.
        if (callback) {
            callback();
        }
    }

    function _wrap(cb) {
        return function (err) {
            var args = Array.prototype.slice.call(arguments);
            args[0] = _mapError(args[0]);
            cb.apply(null, args);
        };
    }

    function showOpenDialog(allowMultipleSelection, chooseDirectories, title, initialPath, fileTypes, callback) {
        callback(null, "/index.html");
      //  appshell.fs.showOpenDialog(allowMultipleSelection, chooseDirectories, title, initialPath, fileTypes, _wrap(callback));
    }

    function showSaveDialog(title, initialPath, proposedNewFilename, callback) {
      callback(null, "/index.html");
    //    appshell.fs.showSaveDialog(title, initialPath, proposedNewFilename, _wrap(callback));
    }

    function stat(path, callback) {
        _fs.stat(path, function (err, stats) {
            if (err) {
                callback(_mapError(err));
            } else {
                var options = { isFile: stats.isFile(), mtime: stats.mtime, size: stats.size },
                    fsStats = new FileSystemStats(options);

                callback(null, fsStats);
            }
        });
    }

    function exists(path, callback) {
        stat(path, function (err) {
            if (err) {
                callback(false);
            } else {
                callback(true);
            }
        });
    }

    function readdir(path, callback) {
        _fs.readdir(path, function (err, contents) {
            if (err) {
                callback(_mapError(err));
                return;
            }

            var count = contents.length;
            if (!count) {
                callback(null, [], []);
                return;
            }

            var stats = [];
            contents.forEach(function (val, idx) {
                stat(path + "/" + val, function (err, stat) {
                    stats[idx] = err || stat;
                    count--;
                    if (count <= 0) {
                        callback(null, contents, stats);
                    }
                });
            });
        });
    }

    function mkdir(path, mode, callback) {
        if (typeof mode === "function") {
            callback = mode;
            mode = parseInt("0755", 8);
        }
        _fs.mkdir(path, mode, function (err) {
            if (err) {
                callback(_mapError(err));
            } else {
                stat(path, function (err, stat) {
                    try {
                        callback(err, stat);
                    } finally {
                        // Fake a file-watcher result until real watchers respond quickly
                        _changeCallback(_parentPath(path));
                    }
                });
            }
        });
    }

    function rename(oldPath, newPath, callback) {
        appshell.fs.mv(oldPath, newPath, _wrap(callback));
        // No need to fake a file-watcher result here: FileSystem already updates index on rename()
    }

    /*
     * Note: if either the read or the stat call fails then neither the read data
     * or stat will be passed back, and the call should be considered to have failed.
     * If both calls fail, the error from the read call is passed back.
     */
    function readFile(path, options, callback) {
        var encoding = options.encoding || "utf8";

        // Execute the read and stat calls in parallel
        var done = false, data, stat, err;

        _fs.readFile(path, encoding, function (_err, _data) {
            if (_err) {
                callback(_mapError(_err));
                return;
            }

            if (done) {
                callback(err, err ? null : _data, stat);
            } else {
                done = true;
                data = _data;
            }
        });

        exports.stat(path, function (_err, _stat) {
            if (done) {
                callback(_err, _err ? null : data, _stat);
            } else {
                done = true;
                stat = _stat;
                err = _err;
            }
        });
    }

    function writeFile(path, data, options, callback) {
        var encoding = options.encoding || "utf8";
debugger;
        exists(path, function (alreadyExists) {
            _fs.writeFile(path, data, encoding, function (err) {
                if (err) {
                    callback(_mapError(err));
                } else {
                    stat(path, function (err, stat) {
                        try {
                            callback(err, stat);
                        } finally {
                            // Fake a file-watcher result until real watchers respond quickly
                            if (alreadyExists) {
                                _changeCallback(path, stat);        // existing file modified
                            } else {
                                _changeCallback(_parentPath(path)); // new file created
                            }
                        }
                    });
                }
            });
        });

    }

    function unlink(path, callback) {
        _fs.unlink(path, function (err) {
            try {
                callback(_mapError(err));
            } finally {
                // Fake a file-watcher result until real watchers respond quickly
                _changeCallback(_parentPath(path));
            }
        });
    }

    function moveToTrash(path, callback) {
        appshell.fs.moveToTrash(path, function (err) {
            try {
                callback(_mapError(err));
            } finally {
                // Fake a file-watcher result until real watchers respond quickly
                _changeCallback(_parentPath(path));
            }
        });
    }

    function initWatchers(callback) {
        _changeCallback = callback;

        /* File watchers are temporarily disabled. For now, send
           a "wholesale" change when the window is focused.
        */
        $(window).on("focus", function () {
            callback(null);
        });
    }

    function watchPath(path) {
    }

    function unwatchPath(path) {
    }

    function unwatchAll() {
    }

    // Export public API
    exports.init            = init;
    exports.showOpenDialog  = showOpenDialog;
    exports.showSaveDialog  = showSaveDialog;
    exports.exists          = exists;
    exports.readdir         = readdir;
    exports.mkdir           = mkdir;
    exports.rename          = rename;
    exports.stat            = stat;
    exports.readFile        = readFile;
    exports.writeFile       = writeFile;
    exports.unlink          = unlink;
    exports.moveToTrash     = moveToTrash;
    exports.initWatchers    = initWatchers;
    exports.watchPath       = watchPath;
    exports.unwatchPath     = unwatchPath;
    exports.unwatchAll      = unwatchAll;
});