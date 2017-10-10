'use strict';

const os = require('os');
const cluster = require('cluster');
const util = require('util');
const setTimeoutPromise = util.promisify(setTimeout);

const DEFAULT_DEADLINE_MS = 30000;

function makeWorker(workerFunc) {
  var server = workerFunc(cluster.worker.id);

  server.on('close', function() {
    process.exit();
  });

  process.on('SIGTERM', function() {
    server.close();
  });

  return server;
}

const Regiment = function(workerFunc, options) {
  if (cluster.isWorker) return makeWorker(workerFunc);

  options = options || {};

  const numCpus = os.cpus().length;
  let running = true;

  const deadline = options.deadline || DEFAULT_DEADLINE_MS;
  const numWorkers = options.numWorkers || numCpus;
  const logger = options.logger || console;

  function messageHandler(msg) {
    if (running && msg.cmd && msg.cmd === 'need_replacement') {
      const workerId = msg.workerId;
      const replacement = spawn();
      logger.log(`Replacing worker ${workerId} with worker ${replacement.id}`);
      replacement.on('listening', (address) => {
	logger.log(`Replacement ${replacement.id} is listening, killing ${workerId}`);
	kill(cluster.workers[workerId]);
      })
    }
  }

  function spawn() {
    const worker = cluster.fork();
    worker.on('message', messageHandler);
    return worker;
  }

  function fork() {
    for (var i=0; i<numWorkers; i++) {
      spawn();
    }
  }

  function kill(worker) {
    logger.log(`Killing ${worker.id}`);
    worker.process.kill();
    return ensureDeath(worker);
  }

  async function ensureDeath(worker) {
    await setTimeoutPromise(deadline);
    logger.log(`Ensured death of ${worker.id}`);
    worker.kill();
    worker.disconnect();
  }

  function respawn(worker, code, signal) {
    if (running && !worker.exitedAfterDisconnect ) {
      logger.log(`Respawning ${worker.id} after suicide`);
      spawn();
    }
  }

  function listen() {
    process.on('SIGINT', shutdown(130, 'SIGINT'));
    process.on('SIGTERM', shutdown(130, 'SIGTERM'));
    cluster.on('exit', respawn);
  }

  function shutdown(code, signal) {
    return async () => {
      running = false;
      logger.log(`Shutting down!`);
      for (var id in cluster.workers) {
	await kill(cluster.workers[id]);
      }

      console.log(`Master process killed by ${signal}`);
      process.exit(code);
    }
  }

  listen();
  fork();
}

Regiment.middleware = require('./middleware');

module.exports = Regiment;
