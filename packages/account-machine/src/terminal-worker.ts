import { DAEMON_BROKER_WORKER_ARG, TERMINAL_OUTPUT_WORKER_ARG } from '@gitspace/supervisor';
import { startDaemonBrokerFromEnvironment } from '@gitspace/supervisor/broker';
import { startTerminalOutputWorker } from '@gitspace/supervisor/terminal-output';

const selector = process.argv[2];
if (selector === DAEMON_BROKER_WORKER_ARG) {
  await startDaemonBrokerFromEnvironment();
} else if (selector === TERMINAL_OUTPUT_WORKER_ARG) {
  startTerminalOutputWorker();
} else {
  throw new Error(`Unsupported machine worker selector: ${selector}`);
}
