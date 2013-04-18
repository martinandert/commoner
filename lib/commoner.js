var assert = require("assert");
var path = require("path");
var Q = require("q");
var Watcher = require("./watcher").Watcher;
var BuildContext = require("./context").BuildContext;
var ModuleReader = require("./reader").ModuleReader;
var util = require("./util");
var log = util.log;
var Ap = Array.prototype;
var each = Ap.forEach;

function Commoner() {
    var self = this;
    assert.ok(self instanceof Commoner);

    Object.defineProperties(self, {
        resolvers: { value: [] },
        processors: { value: [] }
    });
}

var Cp = Commoner.prototype;

// A resolver is a function that takes a module identifier and returns
// the unmodified source of the corresponding module, either as a string
// or as a promise for a string.
Cp.resolve = function() {
    each.call(arguments, function(resolver) {
        assert.strictEqual(typeof resolver, "function");
        this.resolvers.push(resolver);
    }, this);

    return this; // For chaining.
};

// A processor is a function that takes a module identifier and a string
// representing the source of the module and returns a modified version of
// the source, either as a string or as a promise for a string.
Cp.process = function(processor) {
    each.call(arguments, function(processor) {
        assert.strictEqual(typeof processor, "function");
        this.processors.push(processor);
    }, this);

    return this; // For chaining.
};

// This default can be overridden by individual Commoner instances.
Object.defineProperty(Cp, "persistent", { value: false });

Cp.buildP = function(config, rootFile, outputDir) {
    var self = this;
    var sourceDir = path.dirname(rootFile);
    var rootId = path.basename(rootFile).replace(/\.js$/i, "");
    var watcher = new Watcher(sourceDir, self.persistent);
    var waiting = 0;

    watcher.on("changed", function(file) {
        if (self.persistent) {
            log.err(file + " changed; rebuilding...", "yellow");
            rebuild();
        }
    });

    function rebuild() {
        if (rebuild.ing) {
            waiting += 1;
            return;
        }

        rebuild.ing = true;

        return new ModuleReader(
            new BuildContext(config, watcher, outputDir),
            self.resolvers,
            self.processors
        ).readModuleP(rootId)
            .then(collectDepsP)
            .then(writeVersionsP)
            .then(printModuleIds)
            .finally(function(err) {
                rebuild.ing = false;

                if (waiting > 0) {
                    waiting = 0;
                    process.nextTick(rebuild);
                }

                if (err) {
                    log.err(err.stack);
                }
            });
    }

    return lockOutputDirP(outputDir).then(rebuild);
};

function collectDepsP(module) {
    var modules = [];
    var seenIds = {};

    function traverse(module) {
        if (seenIds.hasOwnProperty(module.id))
            return Q.resolve(modules);
        seenIds[module.id] = true;

        return module.getRequiredP().then(function(reqs) {
            return Q.all(reqs.map(traverse));
        }).then(function() {
            modules.push(module);
            return modules;
        });
    }

    return traverse(module);
}

function writeVersionsP(modules) {
    return Q.all(modules.map(function(module) {
        return module.writeVersionP().then(function() {
            return module;
        });
    }));
}

function printModuleIds(modules) {
    var ids = modules.map(function(module) {
        return module.id;
    });

    log.out(JSON.stringify(ids));

    return modules;
}

function lockOutputDirP(outputDir) {
    return util.mkdirP(outputDir).then(function(dir) {
        var lockFile = path.join(outputDir, ".lock.pid");
        return util.acquireLockFileP(lockFile).then(function() {
            return dir;
        }, function(err) {
            throw new Error("output directory " + outputDir + " currently in use");
        });
    });
}

Cp.cliBuildP = function(version) {
    var commoner = this;
    var options = require("commander");
    var workingDir = process.cwd();

    options.version(version)
        .option("-r, --root <file>", "Root module file in top-level module directory")
        .option("-o, --output <directory>", "Output directory")
        .option("-c, --config [file]", "JSON configuration file (no file means STDIN)")
        .option("-w, --watch", "Continually rebuild")
        .parse(process.argv.slice(0));

    return Q.all([
        getConfigP(workingDir, options.config),
        absolutePath(workingDir, options.root),
        absolutePath(workingDir, options.output)
    ]).spread(commoner.buildP.bind(commoner));
};

function absolutePath(workingDir, pathToJoin) {
    workingDir = path.normalize(workingDir);
    pathToJoin = path.normalize(pathToJoin);
    if (pathToJoin.charAt(0) !== "/")
        pathToJoin = path.join(workingDir, pathToJoin);
    return pathToJoin;
}

function getConfigP(workingDir, configFile) {
    if (typeof configFile === "undefined")
        return {}; // Empty config.

    var stdin = "/dev/stdin";
    if (configFile === true) {
        // When --config is present but has no argument, default to STDIN.
        configFile = stdin;
    }

    configFile = absolutePath(workingDir, configFile);

    if (configFile === stdin) {
        log.err(
            "Expecting configuration from STDIN (pass --config <file> " +
            "if stuck here)...",
            "yellow");
        return util.readJsonFromStdinP();
    }

    return util.readJsonFileP(configFile);
}

exports.Commoner = Commoner;