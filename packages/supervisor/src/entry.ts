import { startDaemonBrokerFromEnvironment } from './broker.js';
import { startTerminalOutputWorker } from './terminal-output.js';
import { DAEMON_BROKER_WORKER_ARG, TERMINAL_OUTPUT_WORKER_ARG } from './protocol.js';
if (process.argv[2] === DAEMON_BROKER_WORKER_ARG) {
  await startDaemonBrokerFromEnvironment();
} else if (process.argv[2] === TERMINAL_OUTPUT_WORKER_ARG) {
  startTerminalOutputWorker();
} else throw new Error('Unknown GitSpace supervisor worker selector');
