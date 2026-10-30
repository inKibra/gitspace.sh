import { DAEMON_BROKER_WORKER_ARG, TERMINAL_OUTPUT_WORKER_ARG } from '@gitspace/supervisor';
import { startDaemonBrokerFromEnvironment } from '@gitspace/supervisor/broker';
import { startTerminalOutputWorker } from '@gitspace/supervisor/terminal-output';

const selector = process.argv[2];
// No top-level await: the bundle is CommonJS so that it can carry bytecode. A failed start ends the worker.
if (selector === DAEMON_BROKER_WORKER_ARG) {
  startDaemonBrokerFromEnvironment().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
} else if (selector === TERMINAL_OUTPUT_WORKER_ARG) {
  startTerminalOutputWorker();
} else {
  throw new Error(`Unsupported machine worker selector: ${selector}`);
}
