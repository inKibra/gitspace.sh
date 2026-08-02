import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// This file unit-tests the coordinator's session-open serialization and command
// routing against an IN-PROCESS host, injected via the PiCoordinator
// `hostFactory` seam (mock.module of pi-runtime + the SDK can't reach a worker
// child process). Worker hosting is mandatory in production; the real worker
// path has live coverage in pi-busy.integration. The injected factory boots a
// LocalSessionHost — the exact host logic the worker child runs internally.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeSessionDirName } from '../pi-session-files.js';

const AGENT_SESSION_ID = 'agent-session';

let shouldFailOpenOnce = false;
let openPiSessionCalls = 0;
let promptCalls = 0;
let compactCalls = 0;
let subscribeCalls = 0;

let blockCompact = false;

let resolveCompact: (() => void) | null = null;
let goalToolAvailable = true;
let activeToolNames = ['bash', 'read', 'custom'];
let persistedGoalModeState: unknown;
let createdGoalObjectives: string[] = [];
let droppedGoalCount = 0;
let setGoalModeStateCount = 0;
let failNextToolUpdate = false;
let shakeCalls: Array<'elide' | 'images'> = [];
let blockShake = false;
let resolveShake: (() => void) | null = null;
let notifyShakeStarted: (() => void) | null = null;

function createSession() {
  return {
    sessionId: AGENT_SESSION_ID,
    prompt: mock(async () => {
      promptCalls += 1;
    }),
    compact: mock(async () => {
      compactCalls += 1;
      if (blockCompact) {
        await new Promise<void>((resolve) => {
          resolveCompact = resolve;
        });
      }
    }),
    subscribe: mock(() => {
      subscribeCalls += 1;
      return () => {};
    }),
    getAllToolNames: mock(() => (goalToolAvailable ? ['bash', 'read', 'goal'] : ['bash', 'read'])),
    getActiveToolNames: mock(() => activeToolNames),
    setActiveToolsByName: mock(async (toolNames: string[]) => {
      activeToolNames = [...toolNames];
      if (failNextToolUpdate) {
        failNextToolUpdate = false;
        throw new Error('tool update interrupted');
      }
    }),
    getGoalModeState: mock(() => persistedGoalModeState),
    goalRuntime: {
      createGoal: mock(async ({ objective }: { objective: string }) => {
        createdGoalObjectives.push(objective);
        persistedGoalModeState = { enabled: true, objective };
      }),
      dropGoal: mock(async () => {
        droppedGoalCount += 1;
      }),
    },
    setGoalModeState: mock((state: undefined) => {
      setGoalModeStateCount += 1;
      persistedGoalModeState = state;
    }),
    skills: [
      {
        name: 'space-review',
        description: 'Review GitSpace workspace changes with grounded evidence and focused verification.',
        filePath: '/tmp/space-review/SKILL.md',
        baseDir: '/tmp/space-review',
        source: 'gitspace-managed:native',
      },
    ],
    extensionRunner: {
      getRegisteredCommands: mock(() => ([{ name: 'space', description: 'Run GitSpace workspace-scoped commands' }])),
    },
    dispose: mock(() => {}),
    shake: mock(async (mode: 'elide' | 'images') => {
      shakeCalls.push(mode);
      if (blockShake) {
        notifyShakeStarted?.();
        await new Promise<void>((resolve) => {
          resolveShake = resolve;
        });
      }
      return mode === 'elide'
        ? {
          mode,
          toolResultsDropped: 3,
          blocksDropped: 2,
          tokensFreed: 1800,
          artifactId: 'artifact://recover-elided-output',
        }
        : {
          mode,
          toolResultsDropped: 0,
          blocksDropped: 0,
          imagesDropped: 4,
          tokensFreed: 0,
        };
    }),
  };
}

mock.module('../pi-runtime.js', () => ({
  getPiAgentDir: mock(() => '/tmp/mock-pi-agent-dir'),
  setupPiEnvironment: mock(() => ({})),
  createPiSessionManager: mock(async () => ({
    agentDir: '/tmp/pi-agent',
    sessionManager: {},
  })),
  openPiSession: mock(async () => {
    openPiSessionCalls += 1;
    if (shouldFailOpenOnce && openPiSessionCalls === 1) {
      throw new Error('open failed');
    }
    return {
      session: createSession(),
    };
  }),
  persistInitialPiSessionModel: mock(async () => {}),
}));

mock.module('@oh-my-pi/pi-coding-agent/sdk', () => ({
  createAgentSession: mock(async () => ({
    session: createSession(),
    setToolUIContext: mock(() => {}),
  })),
}));

mock.module('@oh-my-pi/pi-coding-agent/extensibility/slash-commands', () => ({
  loadSlashCommands: mock(async () => []),
}));

const { PiCoordinator } = await import('../pi-coordinator.js');
const { LocalSessionHost } = await import('../local-session-host.js');

// Inject an in-process LocalSessionHost so the coordinator's real open/prompt/
// command logic runs against the mocked pi-runtime + SDK (a worker child would
// re-import the un-mocked modules in its own process).
const inProcessHostFactory = { hostFactory: LocalSessionHost.boot };

const testSinks = {
  onEvent: () => {},
  onDialogRequest: () => {},
  onUiEvent: () => {},
  onTerminalOutput: () => {},
  onAgentReport: () => {},
};

async function bootGoalTestHost() {
  return LocalSessionHost.boot(
    sessionTarget,
    { mode: 'open', sessionFilePath: '/tmp/mock-goal-session.jsonl' },
    testSinks,
  );
}

// One shared temp workspace + sessions root, created once for all tests.
// The session file is permanent for the test run — each test creates a fresh
// PiCoordinator instance so there is no state leakage between cases.
const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'pi-coord-ws-'));
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'pi-coord-ses-'));

{
  const encoded = encodeSessionDirName(WORKSPACE_DIR);
  const sessionDir = join(SESSIONS_DIR, encoded);
  mkdirSync(sessionDir, { recursive: true });
  const header = JSON.stringify({
    type: 'session',
    id: AGENT_SESSION_ID,
    cwd: WORKSPACE_DIR,
    timestamp: '2026-03-27T00:00:00.000Z',
  });
  writeFileSync(join(sessionDir, `2026-03-27T00-00-00-000Z_${AGENT_SESSION_ID}.jsonl`), header + '\n');
}

const sessionTarget = {
  workspaceId: 'test:ws',
  workspaceName: 'test-workspace',
  workspacePath: WORKSPACE_DIR,
  projectName: 'test-project',
};

afterAll(() => {
  mock.restore();
  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
});

describe('PiCoordinator active session open serialization', () => {
  beforeEach(() => {
    openPiSessionCalls = 0;
    promptCalls = 0;
    compactCalls = 0;
    subscribeCalls = 0;
    shouldFailOpenOnce = false;
    blockCompact = false;
    resolveCompact = null;
    goalToolAvailable = true;
    activeToolNames = ['bash', 'read', 'custom'];
    persistedGoalModeState = undefined;
    createdGoalObjectives = [];
    droppedGoalCount = 0;
    setGoalModeStateCount = 0;
    failNextToolUpdate = false;
  });

  it('shares one in-flight open operation for concurrent callers', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);

    const firstCall = coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'first message');
    const secondCall = coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'second message');

    await Promise.all([firstCall, secondCall]);

    expect(openPiSessionCalls).toBe(1);
    expect(subscribeCalls).toBe(1);
    expect(promptCalls).toBe(2);
  });

  it('clears active-session in-flight state after a failed open so a retry can proceed', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);
    shouldFailOpenOnce = true;

    await expect(
      coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'first message'),
    ).rejects.toThrow('open failed');
    expect(openPiSessionCalls).toBe(1);

    shouldFailOpenOnce = false;
    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'retry message');
    expect(openPiSessionCalls).toBe(2);
    expect(promptCalls).toBe(1);
  });

  it('passes /space commands through to the Pi session extension handler', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);

    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, '/space review list');

    expect(openPiSessionCalls).toBe(1);
    expect(promptCalls).toBe(1);
  });

  it('acknowledges /compact immediately without waiting for compaction to finish', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);
    blockCompact = true;

    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, '/compact keep the summary');

    expect(openPiSessionCalls).toBe(1);
    expect(compactCalls).toBe(1);
    expect(promptCalls).toBe(0);
    resolveCompact?.();
    blockCompact = false;
  });


  it('includes built-in commands before a session is active', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);

    const commands = await coordinator.listAvailableCommands(sessionTarget);

    expect(commands).toEqual(expect.arrayContaining([
      { name: 'compact', description: 'Compact the session context', kind: 'extension' },
      { name: 'space', description: 'Run GitSpace workspace-scoped commands', kind: 'extension' },
    ]));
  });
  it('includes extension and skill commands in available command listings', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);

    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');
    const commands = await coordinator.listAvailableCommands(sessionTarget);

    expect(commands).toEqual(expect.arrayContaining([
      { name: 'compact', description: 'Compact the session context', kind: 'extension' },
      { name: 'space', description: 'Run GitSpace workspace-scoped commands', kind: 'extension' },
      { name: 'skill:space-review', description: 'Review GitSpace workspace changes with grounded evidence and focused verification.', kind: 'extension' },
    ]));
  });
});

describe('session-local Goal Mode', () => {
  beforeEach(() => {
    openPiSessionCalls = 0;
    goalToolAvailable = true;
    activeToolNames = ['bash', 'read', 'custom'];
    persistedGoalModeState = undefined;
    createdGoalObjectives = [];
    droppedGoalCount = 0;
    setGoalModeStateCount = 0;
    failNextToolUpdate = false;
  });
  it('enables the live goal tool and restores the exact pre-enable tool set when disabled', async () => {
    const host = await bootGoalTestHost();

    expect(await host.setGoalMode({ enabled: true, objective: 'Finish the migration.' })).toEqual({
      enabled: true,
      available: true,
    });
    expect(createdGoalObjectives).toEqual(['Finish the migration.']);
    expect(activeToolNames).toEqual(['bash', 'read', 'custom', 'goal']);
    expect(await host.getGoalMode()).toEqual({ enabled: true, available: true });

    expect(await host.setGoalMode({ enabled: false })).toEqual({
      enabled: false,
      available: true,
    });
    expect(activeToolNames).toEqual(['bash', 'read', 'custom']);
    expect(droppedGoalCount).toBe(1);
    expect(await host.getGoalMode()).toEqual({ enabled: false, available: true });
  });

  it('cleans up a partially enabled runtime and reports Goal Mode off when adding the tool fails', async () => {
    const host = await bootGoalTestHost();
    failNextToolUpdate = true;

    expect(await host.setGoalMode({ enabled: true, objective: 'Finish the migration.' })).toEqual({
      enabled: false,
      available: true,
      message: 'Failed to enable Goal Mode: tool update interrupted.',
    });
    expect(activeToolNames).toEqual(['bash', 'read', 'custom']);
    expect(droppedGoalCount).toBe(1);
    expect(await host.getGoalMode()).toEqual({ enabled: false, available: true });
  });

  it('reports Goal Mode off when the runtime goal was dropped but tool restoration reports a failure', async () => {
    const host = await bootGoalTestHost();
    await host.setGoalMode({ enabled: true, objective: 'Finish the migration.' });
    failNextToolUpdate = true;

    expect(await host.setGoalMode({ enabled: false })).toEqual({
      enabled: false,
      available: true,
      message: 'Goal Mode is off, but its previous tool slate could not be restored: tool update interrupted',
    });
    expect(activeToolNames).toEqual(['bash', 'read', 'custom']);
    expect(droppedGoalCount).toBe(1);
    expect(await host.getGoalMode()).toEqual({ enabled: false, available: true });
  });

  it('rejects Goal Mode when the session lacks the goal tool without mutating its active tools or goal runtime', async () => {
    goalToolAvailable = false;
    const host = await bootGoalTestHost();

    expect(await host.setGoalMode({ enabled: true, objective: 'Finish the migration.' })).toEqual({
      enabled: false,
      available: false,
      message: 'Goal Mode is unavailable because this session was not created with the OMP goal tool and control APIs.',
    });
    expect(activeToolNames).toEqual(['bash', 'read', 'custom']);
    expect(createdGoalObjectives).toEqual([]);
    expect(droppedGoalCount).toBe(0);
  });

  it('starts a reopened session with Goal Mode off even if the SDK carries stale goal state', async () => {
    persistedGoalModeState = { enabled: true, objective: 'stale precursor must not revive' };

    const host = await bootGoalTestHost();

    expect(await host.getGoalMode()).toEqual({ enabled: false, available: true });
    expect(droppedGoalCount).toBe(1);
    expect(setGoalModeStateCount).toBe(1);
    expect(persistedGoalModeState).toBeUndefined();
  });

  it('does not reopen a dormant session to read or change Goal Mode', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);

    expect(await coordinator.getGoalMode(sessionTarget, AGENT_SESSION_ID)).toEqual({
      enabled: false,
      available: false,
      message: 'Goal Mode is available only while this agent session is active.',
    });
    expect(await coordinator.setGoalMode(sessionTarget, AGENT_SESSION_ID, { enabled: true })).toEqual({
      enabled: false,
      available: false,
      message: 'Goal Mode can only be changed while this agent session is active.',
    });
    expect(openPiSessionCalls).toBe(0);
  });

  it('rejects Goal Mode requests for a workspace other than the live host binding', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);
    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');
    const otherWorkspace = {
      workspaceId: 'other:workspace',
      workspaceName: 'other-workspace',
      workspacePath: '/tmp/other-workspace',
      projectName: 'other-project',
    };
    const expected = {
      enabled: false,
      available: false,
      message: 'This agent session is not bound to the requested workspace.',
    } as const;

    expect(await coordinator.getGoalMode(otherWorkspace, AGENT_SESSION_ID)).toEqual(expected);
    expect(await coordinator.setGoalMode(otherWorkspace, AGENT_SESSION_ID, { enabled: false })).toEqual(expected);
    expect(activeToolNames).toEqual(['bash', 'read', 'custom']);
    expect(createdGoalObjectives).toEqual([]);

    coordinator.shutdownHosts();
  });

  it('rejects enablement for an unbound workspace without changing a live host', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);
    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');

    expect(
      await coordinator.setGoalMode(sessionTarget, AGENT_SESSION_ID, {
        enabled: true,
        precursor: 'Do not persist this session-only context.',
      }),
    ).toEqual({
      enabled: false,
      available: true,
      message: 'Goal Mode requires a GoalRecord bound to this workspace.',
    });
    expect(activeToolNames).toEqual(['bash', 'read', 'custom']);
    expect(createdGoalObjectives).toEqual([]);
    expect(await coordinator.getGoalMode(sessionTarget, AGENT_SESSION_ID)).toEqual({
      enabled: false,
      available: true,
    });

    coordinator.shutdownHosts();
  });
});

describe('session-local Shake', () => {
  beforeEach(() => {
    openPiSessionCalls = 0;
    promptCalls = 0;
    shakeCalls = [];
    blockShake = false;
    resolveShake = null;
    notifyShakeStarted = null;
  });

  it('requires a live session bound to the exact workspace target before mutating OMP', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);

    await expect(coordinator.shake(sessionTarget, AGENT_SESSION_ID, 'elide')).rejects.toThrow(
      'Shake is available only while this agent session is active.',
    );
    expect(openPiSessionCalls).toBe(0);
    expect(shakeCalls).toEqual([]);

    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');
    await expect(
      coordinator.shake(
        { ...sessionTarget, workspacePath: `${WORKSPACE_DIR}-wrong-target` },
        AGENT_SESSION_ID,
        'images',
      ),
    ).rejects.toThrow('This agent session is not bound to the requested workspace.');
    expect(shakeCalls).toEqual([]);

    coordinator.shutdownHosts();
  });

  it('forwards both legal modes and preserves every structured OMP result field', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);
    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');

    expect(await coordinator.shake(sessionTarget, AGENT_SESSION_ID, 'elide')).toEqual({
      mode: 'elide',
      toolResultsDropped: 3,
      blocksDropped: 2,
      tokensFreed: 1800,
      artifactId: 'artifact://recover-elided-output',
    });
    expect(await coordinator.shake(sessionTarget, AGENT_SESSION_ID, 'images')).toEqual({
      mode: 'images',
      toolResultsDropped: 0,
      blocksDropped: 0,
      imagesDropped: 4,
      tokensFreed: 0,
    });
    expect(shakeCalls).toEqual(['elide', 'images']);

    coordinator.shutdownHosts();
  });

  it('rejects an unsupported mode before invoking OMP', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);
    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');

    await expect(
      coordinator.shake(sessionTarget, AGENT_SESSION_ID, 'truncate' as unknown as 'elide'),
    ).rejects.toThrow('Unknown Shake mode "truncate".');
    expect(shakeCalls).toEqual([]);

    coordinator.shutdownHosts();
  });

  it('rejects a second Shake while the first OMP mutation is in progress', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR, inProcessHostFactory);
    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');
    blockShake = true;
    let markShakeStarted: (() => void) | undefined;
    const shakeStarted = new Promise<void>((resolve) => {
      markShakeStarted = resolve;
    });
    notifyShakeStarted = markShakeStarted ?? null;

    const first = coordinator.shake(sessionTarget, AGENT_SESSION_ID, 'elide');
    await shakeStarted;

    await expect(coordinator.shake(sessionTarget, AGENT_SESSION_ID, 'images')).rejects.toThrow(
      'Shake is already in progress for this agent session.',
    );
    expect(shakeCalls).toEqual(['elide']);

    resolveShake?.();
    await expect(first).resolves.toEqual({
      mode: 'elide',
      toolResultsDropped: 3,
      blocksDropped: 2,
      tokensFreed: 1800,
      artifactId: 'artifact://recover-elided-output',
    });

    coordinator.shutdownHosts();
  });
});
