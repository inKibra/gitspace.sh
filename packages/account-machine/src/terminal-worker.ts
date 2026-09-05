import { parentPort } from 'node:worker_threads';
import { declareWorkerHostEntry, installWorkerInbox } from '@oh-my-pi/pi-utils/worker-host';
import { DAEMON_BROKER_WORKER_ARG } from '@oh-my-pi/pi-coding-agent/launch/protocol';
import { TERMINAL_OUTPUT_WORKER_ARG } from '@oh-my-pi/pi-coding-agent/launch/terminal-output-worker-protocol';

// Terminal workers are machine infrastructure, never agent-session executors.
declareWorkerHostEntry();
const selector = process.argv[2];
if (selector === DAEMON_BROKER_WORKER_ARG) {
  // Loading is selector-gated so xterm/broker side effects stay out of unrelated worker threads.
  const { startDaemonBrokerFromEnvironment } = await import('@oh-my-pi/pi-coding-agent/launch/broker');
  await startDaemonBrokerFromEnvironment();
} else if (selector === TERMINAL_OUTPUT_WORKER_ARG) {
  if (parentPort) installWorkerInbox(parentPort);
  // Buffer messages before importing the worker that installs its real handler.
  await import('@oh-my-pi/pi-coding-agent/launch/terminal-output-worker');
} else {
  throw new Error(`Unsupported machine worker selector: ${selector}`);
}
