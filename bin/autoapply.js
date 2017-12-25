#!/usr/bin/env node

const util = require('util');
const http = require('http');
const process = require('process');

const winston = require('winston');
const fsExtra = require('fs-extra');
const dateFormat = require('date-format');
const argparse = require('argparse');
const yaml = require('js-yaml');
const tmpPromise = require('tmp-promise');
const childProcessPromise = require('child-process-promise');
require('colors');

require('pkginfo')(module);

const logger = new winston.Logger({
    level: process.env.LOG_LEVEL || 'info',
    transports: [
        new winston.transports.Console({
            formatter: (msg) => {
                let s = dateFormat.asString() + ' ' + winston.config.colorize(msg.level);
                if (msg.message) {
                    s += ' ' + msg.message;
                }
                if (msg.meta && Object.keys(msg.meta).length) {
                    s += ' ' + util.inspect(msg.meta);
                }
                return s;
            }
        })
    ]
});

async function main() {
    const parser = new argparse.ArgumentParser({
        prog: module.exports.name,
        version: module.exports.version,
        addHelp: true,
        description: module.exports.description
    });
    parser.addArgument(['-d', '--debug'], {
        action: 'storeTrue',
        help: 'Show debugging output'
    });
    parser.addArgument(['config'], {
        nargs: '?',
        metavar: '<config-file>',
        help: 'Configuration file to use'
    });
    const args = parser.parseArgs();
    if (args.debug) {
        logger.level = 'debug';
    }
    try {
        let configFile;
        if (args.config) {
            configFile = args.config;
        } else if (await fsExtra.exists('autoapply.yaml')) {
            configFile = 'autoapply.yaml';
        } else if (await fsExtra.exists('autoapply.yml')) {
            configFile = 'autoapply.yml';
        } else {
            logger.error('no configuration file found and none given!');
            return 1;
        }
        const content = await fsExtra.readFile(configFile);
        const config = yaml.safeLoad(content);
        await run(config, args);
    } catch (e) {
        if (args.debug) {
            throw e;
        } else {
            logger.error(e.message || 'unknown error!');
            return 5;
        }
    }
    return 0;
}

async function run(config, options = {}) {
    if (!config.loop) {
        throw new Error('invalid configuration!');
    }

    if (!config.loop.commands || !config.loop.commands.length) {
        throw new Error('no loop commands given in the configuration file!');
    }

    const sleepSec = parseSleep(config.loop.sleep);
    const loopOnError = parseOnError(config.loop.onerror, 'continue');
    const loopCommands = config.loop.commands.map(cmd => new Command(cmd));

    const ctx = {};

    if (!config.server || config.server.enabled !== false) {
        const port = (config.server ? config.server.port : 0) || 3000;
        ctx.server = await startServer(port);
    }

    if (config.init && config.init.commands && config.init.commands.length) {
        logger.info('Running init commands...');
        const initOnError = parseOnError(config.init.onerror, 'fail');
        const initCommands = config.init.commands.map(cmd => new Command(cmd));
        await runCommands(initCommands, '.', initOnError, options.debug);
    } else {
        logger.info('No init commands.');
    }

    logger.info('Running loop commands...');

    let loop = 1;
    const loops = options.loops;
    while (true) {
        const tmpDir = await tmpPromise.dir();
        try {
            await runCommands(loopCommands, tmpDir.path, loopOnError, options.debug);
        } finally {
            logger.debug('Deleting directory...');
            await fsExtra.remove(tmpDir.path);
        }

        if (loops && ++loop > loops) {
            break;
        }

        if (sleepSec) {
            logger.info(`Sleeping for ${sleepSec}s...`);
            await sleep(sleepSec * 1000);
        } else {
            logger.debug(`Not sleeping (sleep = 0)`);
        }
    }

    return ctx;
}

function startServer(port = 3000) {
    const server = http.createServer(handleRequest);
    return new Promise((resolve, reject) => {
        server.listen(port, (err) => {
            if (err) {
                reject(err);
            } else {
                logger.info(`Server is listening on port ${port}...`);
                resolve(server);
            }
        });
    });
}

function handleRequest(request, response) {
    logger.debug('Request received:', request.method, request.url);

    let handler;
    if (request.url === '/healthz') {
        handler = () => 'OK';
    } else {
        handler = null;
    }

    if (handler) {
        if (request.method === 'HEAD') {
            response.writeHead(200, http.STATUS_CODES[200]);
            response.end();
        } else if (request.method === 'GET') {
            let msg;
            try {
                msg = handler();
            } catch (e) {
                logger.info('Error handling request:', request.url, e.message || 'unknown error!');
                response.writeHead(500, http.STATUS_CODES[500]);
                response.end('Internal server error!');
                msg = null;
            }
            if (msg) {
                response.writeHead(200, http.STATUS_CODES[200]);
                response.end(msg);
            }
        } else {
            response.writeHead(405, http.STATUS_CODES[405]);
            response.end('Only GET or HEAD supported!');
        }
    } else {
        response.writeHead(404, http.STATUS_CODES[404]);
        response.end('Not found!');
    }
}

async function runCommands(commands, cwd, onerror, debug) {
    logger.debug('Executing in directory:', cwd);
    for (const command of commands) {
        try {
            await command.run(cwd);
        } catch (e) {
            if (onerror === 'fail') {
                throw e;
            } else {
                if (debug) {
                    logger.error('Command failed:', e);
                } else {
                    if (e.code === 'ENOENT') {
                        logger.error('Command not found!');
                    } else if (e.message) {
                        logger.error(e.message);
                    } else if (e.code) {
                        logger.error(`Command failed with exit code ${e.code}`);
                    } else {
                        logger.error('Command failed!');
                    }
                }
                if (onerror === 'ignore') {
                    continue;
                } else if (onerror === 'continue') {
                    // stop any remaining commands and continue with the next loop iteration
                    break;
                } else {
                    throw new Error('invalid onerror value!');
                }
            }
        }
    }
}

class Command {
    constructor(command) {
        if (isObject(command)) {
            this.command = command['command'];
            this.stdout = parseStdio(command['stdout']);
            this.stderr = parseStdio(command['stderr']);
        } else {
            this.command = command;
            this.stdout = 'pipe';
            this.stderr = 'pipe';
        }
        if (typeof this.command === 'string') {
            this.command = this.command.trim();
            if (!this.command) {
                throw new Error(`invalid command: ${this.command}`);
            }
        } else if (Array.isArray(this.command)) {
            if (!this.command.length || !this.command[0]) {
                throw new Error(`invalid command: ${this.command}`);
            }
        } else {
            throw new Error(`invalid command: ${this.command}`);
        }
    }

    run(cwd) {
        logger.info('Executing command:', JSON.stringify(this.command));

        const shell = (typeof this.command === 'string');
        const options = {
            'cwd': cwd,
            'stdio': ['ignore', this.stdout, this.stderr],
            'shell': shell
        };

        let promise;
        if (shell) {
            promise = childProcessPromise.spawn(this.command, [], options);
        } else {
            promise = childProcessPromise.spawn(this.command[0], this.command.slice(1), options);
        }

        const childProcess = promise.childProcess;
        if (this.stdout === 'pipe') {
            childProcess.stdout.on('data', data => process.stdout.write(data));
        }
        if (this.stderr === 'pipe') {
            childProcess.stderr.on('data', data => process.stderr.write(data));
        }

        return promise;
    }
}

function isObject(value) {
    return value && typeof value === 'object' && value.constructor === Object;
}

function parseOnError(value, defaultValue) {
    if (!value) {
        return defaultValue;
    } else if (value === 'ignore' || value === 'continue' || value === 'fail') {
        return value;
    } else {
        throw new Error(`invalid onerror value: ${value}`);
    }
}

function parseSleep(value) {
    if (value === 0 || value === '0') {
        return 0;
    } else if (!value || value < 0) {
        logger.debug('using default sleep value!');
        return 60;
    } else {
        const sleep = parseFloat(value);
        if (sleep || sleep === 0) {
            return sleep;
        } else {
            throw new Error(`invalid sleep value: ${value}`);
        }
    }
}

function parseStdio(value) {
    if (!value) {
        return 'pipe';
    } else if (value === 'ignore' || value === 'pipe') {
        return value;
    } else {
        throw new Error(`invalid stdio value: ${value}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports.logger = logger;
module.exports.run = run;

if (require.main === module) {
    main().then(status => process.exit(status)).catch(err => console.log(err));
}
