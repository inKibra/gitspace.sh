/**
 * Who gets to name an agent session.
 *
 * Every project agent was called "project agent" because boot seeded a session
 * name. Pi's title generator only applies when the session has NO name —
 * `generateTitle(...).then(u => { if (u && !this.sessionName) setSessionName(u, "auto") })`
 * — so seeding one won that race every time and the generated title was computed
 * and thrown away.
 *
 * Two behaviours follow: boot must NOT name the session (it only sets a display
 * label), and a client rename must be recorded with source `user`, which the SDK
 * treats as final.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { OmpAgentSession } from '../omp-types.js';

const workspacePath = mkdtempSync(join('/tmp', 'gitspace-session-naming-'));
mkdirSync(workspacePath, { recursive: true });

/** Every name written through the session manager, in order. */
const managerNames: Array<[string, string | undefined]> = [];
/** Every name written through the session itself, in order. */
const sessionNames: Array<[string, string | undefined]> = [];
let nameChangedCb: (() => void) | null = null;
let currentName: string | undefined;

const session = {
  sessionId: 'naming-test-session',
  subscribe: mock(() => () => {}),
  dispose: mock(() => {}),
  prompt: mock(async () => true),
  abort: mock(async () => {}),
  setModel: mock(async () => ({ switched: true })),
  getGoalModeState: mock(() => undefined),
  setSessionName: mock(async (name: string, source?: string) => {
    sessionNames.push([name, source]);
    return true;
  }),
} as unknown as OmpAgentSession;

const sessionManager = {
  buildSessionContext: mock(() => ({})),
  rewriteEntries: mock(async () => {}),
  setSessionName: mock(async (name: string, source?: string) => {
    managerNames.push([name, source]);
    return true;
  }),
  onSessionNameChanged: mock((cb: () => void) => {
    nameChangedCb = cb;
    return () => {};
  }),
  getSessionName: mock(() => currentName),
};

// The mock must cover every member local-session-host imports: a partial module
// mock fails the whole import graph, not just the members this test calls.
mock.module('../pi-runtime.js', () => ({
  createPiAuthStorage: mock(async () => ({})),
  createPiModelRegistry: mock(async () => ({ find: () => undefined, list: () => [] })),
  createPiSessionManager: mock(async () => ({ agentDir: '/tmp/pi-agent', sessionManager })),
  getManagedPiExtensionPaths: mock(() => []),
  getPiAgentDir: mock(() => '/tmp/pi-agent'),
  getPiSettings: mock(async () => null),
  openPiSession: mock(async () => ({ session, setToolUIContext: mock(() => {}), compactionStatus: null })),
  persistInitialPiSessionModel: mock(async () => {}),
  makeLocalProtocolOptions: mock(() => ({ options: {}, bind: mock(() => {}) })),
  readCycleOrder: mock(() => undefined),
  setupPiEnvironment: mock(async () => {}),
  createCompactionStatusExtension: mock(() => ({ extension: {}, holder: null })),
}));

// The naming path is on the CREATE branch: `mode: 'open'` reopens a session that
// already carries its own name, and returns before any of this.
mock.module('@oh-my-pi/pi-coding-agent/sdk', () => ({
  createAgentSession: mock(async () => ({ session, setToolUIContext: mock(() => {}) })),
  discoverSkills: mock(async () => []),
}));
mock.module('../managed-defaults.js', () => ({
  getManagedSessionBootstrap: mock(async () => ({ skills: [] })),
}));

// Imported after the mock is installed — that ordering is the point.
const { LocalSessionHost } = await import('../local-session-host.js');

const target = {
  workspaceId: 'test:workspace',
  workspaceName: 'test-workspace',
  workspacePath,
  projectName: 'test-project',
};

const sinks = {
  onEvent: mock(() => {}),
  onDialogRequest: mock(() => {}),
  onUiEvent: mock(() => {}),
  onTerminalOutput: mock(() => {}),
  onAgentReport: mock(() => {}),
};

afterAll(() => {
  mock.restore();
  rmSync(workspacePath, { recursive: true, force: true });
});

describe('agent session naming', () => {
  it('does not name the session at boot, so Pi can generate one', async () => {
    managerNames.length = 0;
    const host = await LocalSessionHost.boot(
      target,
      { mode: 'create', title: 'project agent' },
      sinks,
    );
    // The regression in one line: any setSessionName here beats the generator.
    expect(managerNames).toEqual([]);
    await host.dispose();
  });

  it('keeps the boot string as a display label', async () => {
    const host = await LocalSessionHost.boot(
      target,
      { mode: 'create', title: 'project agent' },
      sinks,
    );
    expect(host.displayTitle).toBe('project agent');
    await host.dispose();
  });

  it('adopts the generated name once Pi produces one', async () => {
    const host = await LocalSessionHost.boot(
      target,
      { mode: 'create', title: 'project agent' },
      sinks,
    );
    currentName = 'Investigate billing drift';
    nameChangedCb?.();
    expect(host.displayTitle).toBe('Investigate billing drift');
    await host.dispose();
  });

  it('records a client rename with source user, which Pi treats as final', async () => {
    sessionNames.length = 0;
    const host = await LocalSessionHost.boot(
      target,
      { mode: 'create', title: 'project agent' },
      sinks,
    );
    await host.rename('  billing spike  ');
    expect(sessionNames).toEqual([['billing spike', 'user']]);
    expect(host.displayTitle).toBe('billing spike');
    await host.dispose();
  });

  it('ignores an empty rename rather than clearing the name', async () => {
    sessionNames.length = 0;
    const host = await LocalSessionHost.boot(
      target,
      { mode: 'create', title: 'project agent' },
      sinks,
    );
    await host.rename('   ');
    expect(sessionNames).toEqual([]);
    expect(host.displayTitle).toBe('project agent');
    await host.dispose();
  });
});
