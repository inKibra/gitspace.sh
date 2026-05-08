import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
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
  });

  it('shares one in-flight open operation for concurrent callers', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR);

    const firstCall = coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'first message');
    const secondCall = coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'second message');

    await Promise.all([firstCall, secondCall]);

    expect(openPiSessionCalls).toBe(1);
    expect(subscribeCalls).toBe(1);
    expect(promptCalls).toBe(2);
  });

  it('clears active-session in-flight state after a failed open so a retry can proceed', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR);
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
    const coordinator = new PiCoordinator(SESSIONS_DIR);

    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, '/space review list');

    expect(openPiSessionCalls).toBe(1);
    expect(promptCalls).toBe(1);
  });

  it('acknowledges /compact immediately without waiting for compaction to finish', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR);
    blockCompact = true;

    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, '/compact keep the summary');

    expect(openPiSessionCalls).toBe(1);
    expect(compactCalls).toBe(1);
    expect(promptCalls).toBe(0);
    resolveCompact?.();
    blockCompact = false;
  });

  it('includes extension and skill commands in available command listings', async () => {
    const coordinator = new PiCoordinator(SESSIONS_DIR);

    await coordinator.promptAgentSession(sessionTarget, AGENT_SESSION_ID, 'prime session');
    const commands = await coordinator.listAvailableCommands(sessionTarget);

    expect(commands).toEqual(expect.arrayContaining([
      { name: 'compact', description: 'Compact the session context', kind: 'extension' },
      { name: 'space', description: 'Run GitSpace workspace-scoped commands', kind: 'extension' },
      { name: 'skill:space-review', description: 'Review GitSpace workspace changes with grounded evidence and focused verification.', kind: 'extension' },
    ]));
  });
});
