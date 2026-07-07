/**
 * In-process command dispatch registry (docs/DAEMON-UNIFICATION.md P3).
 *
 * The tmux-lite server registers its dispatchCommand at boot; the remote
 * session-handler (which runs INSIDE the same daemon since P1/P2) calls it
 * directly instead of round-tripping every typed command through the unix
 * socket to its own process. External CLIs keep using the socket unchanged.
 */

import type { Command, Response } from './protocol.js';

type Dispatcher = (cmd: Command) => Promise<Response | null>;

let dispatcher: Dispatcher | null = null;

export function setCommandDispatcher(d: Dispatcher): void {
  dispatcher = d;
}

export function hasInProcessDispatcher(): boolean {
  return dispatcher !== null;
}

export async function dispatchInProcess(cmd: Command): Promise<Response> {
  if (!dispatcher) {
    throw new Error('In-process command dispatcher not initialized (tmux-lite server has not booted in this process)');
  }
  const res = await dispatcher(cmd);
  return res ?? { type: 'error', message: `Unknown command: ${(cmd as { type?: string }).type}` };
}
