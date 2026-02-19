/**
 * Process watchdog tests - restart policy enforcement with injected deps
 *
 * NOTE: The watchdog uses a module-level restartState map keyed by "name:instance".
 * Each test uses a unique process name to avoid state leaking between tests.
 */

import { describe, expect, it, mock } from 'bun:test';
import { reconcileProcessRestarts, type ProcessWatchdogDeps } from '../watchdog.js';
import type { ProcessInstanceSpec } from '../../../types/processes.js';

let testCounter = 0;
function uniqueName(): string {
  return `test-proc-${++testCounter}`;
}

function makeSpec(overrides: {
  name?: string;
  instance?: number;
  policy?: 'always' | 'on-failure' | 'never';
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
} = {}): ProcessInstanceSpec {
  const name = overrides.name ?? uniqueName();
  return {
    name,
    instance: overrides.instance ?? 1,
    definition: {
      name,
      command: 'npm start',
      restart: {
        policy: overrides.policy ?? 'always',
        maxAttempts: overrides.maxAttempts ?? 5,
        backoffMs: overrides.backoffMs ?? 1000,
        maxBackoffMs: overrides.maxBackoffMs ?? 30000,
      },
    },
  };
}

function makeDeps(overrides: Partial<ProcessWatchdogDeps> = {}): ProcessWatchdogDeps {
  return {
    listSessions: mock(() => Promise.resolve([])),
    startProcessInstance: mock(() => Promise.resolve({ sessionId: 'sess-1', created: true })),
    isProcessRestartDisabled: mock(() => false),
    disableProcessRestart: mock(() => {}),
    hasProcessStarted: mock(() => true),
    readProcessExit: mock(() => null),
    now: mock(() => Date.now()),
    ...overrides,
  };
}

// ============================================================================
// reconcileProcessRestarts
// ============================================================================

describe('reconcileProcessRestarts', () => {
  it('should skip processes with restart policy "never"', async () => {
    const deps = makeDeps();
    const specs = [makeSpec({ policy: 'never' })];

    await reconcileProcessRestarts('/tmp/ws', specs, deps);

    expect(deps.startProcessInstance).not.toHaveBeenCalled();
  });

  it('should skip processes that are currently running', async () => {
    const spec = makeSpec();
    const deps = makeDeps({
      listSessions: mock(() =>
        Promise.resolve([
          { id: 's1', name: `proc:ws:${spec.name}:1`, socketPath: '/tmp/s', pid: 1, attached: false, cwd: '/tmp/ws', createdAt: 0 },
        ])
      ),
    });

    await reconcileProcessRestarts('/tmp/ws', [spec], deps);

    expect(deps.startProcessInstance).not.toHaveBeenCalled();
  });

  it('should skip processes where restart is externally disabled', async () => {
    const deps = makeDeps({
      isProcessRestartDisabled: mock(() => true),
    });
    const specs = [makeSpec()];

    await reconcileProcessRestarts('/tmp/ws', specs, deps);

    expect(deps.startProcessInstance).not.toHaveBeenCalled();
  });

  it('should skip processes that have never been started', async () => {
    const deps = makeDeps({
      hasProcessStarted: mock(() => false),
    });
    const specs = [makeSpec()];

    await reconcileProcessRestarts('/tmp/ws', specs, deps);

    expect(deps.startProcessInstance).not.toHaveBeenCalled();
  });

  it('should restart a crashed process with "always" policy', async () => {
    const deps = makeDeps();
    const specs = [makeSpec({ policy: 'always' })];

    await reconcileProcessRestarts('/tmp/ws', specs, deps);

    expect(deps.startProcessInstance).toHaveBeenCalledTimes(1);
  });

  it('should restart a process with "on-failure" policy when exit code is non-zero', async () => {
    const deps = makeDeps({
      readProcessExit: mock(() => ({ exitCode: 1, exitedAt: Date.now() })),
    });
    const specs = [makeSpec({ policy: 'on-failure' })];

    await reconcileProcessRestarts('/tmp/ws', specs, deps);

    expect(deps.startProcessInstance).toHaveBeenCalledTimes(1);
  });

  it('should NOT restart a process with "on-failure" policy when exit code is 0', async () => {
    const deps = makeDeps({
      readProcessExit: mock(() => ({ exitCode: 0, exitedAt: Date.now() })),
    });
    const specs = [makeSpec({ policy: 'on-failure' })];

    await reconcileProcessRestarts('/tmp/ws', specs, deps);

    expect(deps.startProcessInstance).not.toHaveBeenCalled();
  });

  it('should disable restart after maxAttempts exceeded', async () => {
    const startMock = mock(() => Promise.resolve({ sessionId: 's', created: true }));
    let currentTime = 1000;

    const deps = makeDeps({
      startProcessInstance: startMock,
      now: mock(() => {
        currentTime += 100000; // jump forward enough to skip backoff
        return currentTime;
      }),
    });

    const spec = makeSpec({ maxAttempts: 2, backoffMs: 1 });
    const specs = [spec];

    // First call: attempt 1
    await reconcileProcessRestarts('/tmp/ws', specs, deps);
    expect(startMock).toHaveBeenCalledTimes(1);

    // Second call: attempt 2
    await reconcileProcessRestarts('/tmp/ws', specs, deps);
    expect(startMock).toHaveBeenCalledTimes(2);

    // Third call: maxAttempts exceeded, should disable
    await reconcileProcessRestarts('/tmp/ws', specs, deps);
    expect(deps.disableProcessRestart).toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledTimes(2); // no additional start
  });

  it('should respect backoff delay', async () => {
    let currentTime = 1000;
    const deps = makeDeps({
      now: mock(() => currentTime),
    });

    const specs = [makeSpec({ backoffMs: 5000 })];

    // First call starts the process
    await reconcileProcessRestarts('/tmp/ws', specs, deps);
    expect(deps.startProcessInstance).toHaveBeenCalledTimes(1);

    // Second call too soon - should skip due to backoff
    currentTime += 1000; // only 1 second later, but backoff doubled to 10000
    await reconcileProcessRestarts('/tmp/ws', specs, deps);
    expect(deps.startProcessInstance).toHaveBeenCalledTimes(1); // still 1

    // Third call after backoff - should restart
    currentTime += 20000; // well past doubled backoff
    await reconcileProcessRestarts('/tmp/ws', specs, deps);
    expect(deps.startProcessInstance).toHaveBeenCalledTimes(2);
  });
});
