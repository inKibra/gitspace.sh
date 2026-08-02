/**
 * Command-routing invariants (daemon-unification P3).
 *
 * Two shipped regressions shared one shape: the remote session-handler sends
 * a typed command that the in-process dispatcher can't handle —
 *   1. agent-prompt/terminate hitchhiked into the socket loop during the
 *      dispatch extraction → every remote prompt failed ("Pi session not
 *      found", because loop-resident commands lost @base normalization);
 *   2. agent-attach/agent-dialog-response are socket-coupled by design but
 *      were direct-dispatched → "Unknown command" on opening any agent pane.
 *
 * These tests parse the SOURCE of server.ts and session-handler.ts and
 * enforce the routing contract, so either mistake fails CI instead of a
 * user's click. Source-structural on purpose: importing server.ts boots a
 * daemon (listeners, schedulers) — not viable in a unit test.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const serverSrc = readFileSync(join(ROOT, 'src/lib/tmux-lite/server.ts'), 'utf8');
const handlerSrc = readFileSync(join(ROOT, 'src/lib/remote-session/session-handler.ts'), 'utf8');

/** Case labels inside a source region (both `case 'x':` and `case "x": {`). */
function caseLabels(region: string): Set<string> {
  const labels = new Set<string>();
  for (const m of region.matchAll(/^\s{6,12}case ['"]([\w-]+)['"]:/gm)) labels.add(m[1]);
  return labels;
}

function dispatchRegion(): string {
  const start = serverSrc.indexOf('export async function dispatchCommand');
  expect(start).toBeGreaterThan(-1);
  const end = serverSrc.indexOf('routerListener = Bun.listen', start);
  expect(end).toBeGreaterThan(start);
  return serverSrc.slice(start, end);
}

function loopRegion(): string {
  const start = serverSrc.indexOf('routerListener = Bun.listen');
  expect(start).toBeGreaterThan(-1);
  return serverSrc.slice(start);
}

/** Command types the session-handler forwards as typed tmux commands. */
function typedCommands(): Set<string> {
  const types = new Set<string>();
  // handleTypedCommand(session, msg.requestId, { type: 'x', ... }
  for (const m of handlerSrc.matchAll(/handleTypedCommand\([^{]*\{\s*type:\s*['"]([\w-]+)['"]/gs)) types.add(m[1]);
  // multi-line object literals: handleTypedCommand(..., {\n  type: 'x',
  for (const m of handlerSrc.matchAll(/handleTypedCommand\(session[^)]*?\{\s*\n\s*type:\s*['"]([\w-]+)['"]/gs)) types.add(m[1]);
  return types;
}

function socketCoupledSet(): Set<string> {
  const m = handlerSrc.match(/SOCKET_COUPLED_COMMANDS\s*=\s*new Set\(\[([^\]]*)\]\)/s);
  expect(m).not.toBeNull();
  const set = new Set<string>();
  for (const mm of m![1].matchAll(/['"]([\w-]+)['"]/g)) set.add(mm[1]);
  return set;
}

/** The cases that legitimately live in the socket loop: their handlers bind or
 *  stream on the calling socket. Growing this list is a deliberate act — a new
 *  loop-resident case is usually an extraction accident. */
const KNOWN_CONNECTION_COUPLED = new Set([
  'attach-prepare',
  'attach-cancel',
  'attach',
  'agent-watch',
  'machine-watch',
  'workspace-delete',
  'agent-dialog-response',
  'kill-server',
]);

describe('command routing (dispatch vs socket loop)', () => {
  const dispatchCases = caseLabels(dispatchRegion());
  const loopCases = caseLabels(loopRegion());
  const typed = typedCommands();
  const socketCoupled = socketCoupledSet();

  test('the socket loop holds only the known connection-coupled cases', () => {
    // Regression 1: a hitchhiked case here silently loses in-process dispatch
    // AND (historically) @base normalization.
    const unexpected = [...loopCases].filter((c) => !KNOWN_CONNECTION_COUPLED.has(c));
    expect(unexpected).toEqual([]);
  });

  test('dispatch and the loop do not double-handle a command', () => {
    const both = [...loopCases].filter((c) => dispatchCases.has(c));
    expect(both).toEqual([]);
  });

  test('every typed session-handler command is dispatchable or socket-routed', () => {
    // Regression 2: typed + loop-resident + not socket-routed = the exact
    // "invalid command" users saw opening an agent pane.
    const unreachable = [...typed].filter(
      (c) => !dispatchCases.has(c) && !(loopCases.has(c) && socketCoupled.has(c)),
    );
    expect(unreachable).toEqual([]);
  });

  test('socket-coupled overrides point at real loop cases', () => {
    const dangling = [...socketCoupled].filter((c) => !loopCases.has(c));
    expect(dangling).toEqual([]);
  });

  test('agent-watch subscribe pushes an initial agent-state catch-up snapshot', () => {
    // Ticket #5: a (re)subscribing watcher — notably the serve-runtime bridge
    // after a reconnect — must receive the current agent state immediately,
    // not wait for the next delta. Source-structural like the rest of this
    // file: the loop must follow 'agent-watch-started' with an 'agent-state'
    // push built from the live control snapshot.
    const loop = loopRegion();
    const gate = loop.indexOf("res.type === 'agent-watch-started'");
    expect(gate).toBeGreaterThan(-1);
    const pushWindow = loop.slice(gate, gate + 400);
    expect(pushWindow).toContain("type: 'agent-state'");
    expect(pushWindow).toContain('getAgentControlSnapshot()');
  });

  test('sanity: extraction found real case sets', () => {
    // Guard the parser itself — if server.ts is refactored such that these
    // regexes go blind, fail loudly instead of vacuously passing.
    expect(dispatchCases.size).toBeGreaterThan(80);
    expect(loopCases.size).toBe(KNOWN_CONNECTION_COUPLED.size);
    expect(typed.size).toBeGreaterThan(20);
    expect(dispatchCases.has('agent-prompt')).toBe(true);
    expect(dispatchCases.has('terminate')).toBe(true);
    expect(socketCoupled.has('agent-dialog-response')).toBe(true);
  });
});
