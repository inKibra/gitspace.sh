import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { OmpAgentSession } from '../omp-types.js';

const workspacePath = mkdtempSync(join('/tmp', 'gitspace-extension-runtime-'));
mkdirSync(workspacePath, { recursive: true });

type ExtensionInitializeArgs = [unknown, unknown, unknown, unknown];

type TestExtensionRunner = {
  getRegisteredCommands: () => Array<{ name: string; description: string }>;
  initialize: (...args: ExtensionInitializeArgs) => void;
  onError: (...args: unknown[]) => void;
  emit: (event: { type: string }) => Promise<void>;
};

type BootSession = OmpAgentSession & { extensionRunner: TestExtensionRunner };

const extensionInitialize = mock((..._args: ExtensionInitializeArgs): void => {});
const extensionEmit = mock(async (_event: { type: string }): Promise<void> => {});

const extensionRunner: TestExtensionRunner = {
  getRegisteredCommands: mock(() => [{ name: 'space', description: 'Run GitSpace workspace-scoped commands' }]),
  initialize: extensionInitialize,
  onError: mock(() => {}),
  emit: extensionEmit,
};

const session = {
  sessionId: 'runtime-test-session',
  extensionRunner,
  subscribe: mock(() => () => {}),
  dispose: mock(() => {}),
  prompt: mock(async () => true),
  abort: mock(async () => {}),
  setModel: mock(async () => ({ switched: true })),
  getGoalModeState: mock(() => undefined),
} as unknown as BootSession;

mock.module('../pi-runtime.js', () => ({
  createPiAuthStorage: mock(async () => ({})),
  createPiModelRegistry: mock(async () => ({ find: () => undefined, list: () => [] })),
  createPiSessionManager: mock(async () => ({ agentDir: '/tmp/pi-agent', sessionManager: {} })),
  getManagedPiExtensionPaths: mock(() => []),
  getPiSettings: mock(async () => null),
  openPiSession: mock(async () => ({
    session,
    setToolUIContext: mock(() => {}),
    compactionStatus: null,
  })),
  persistInitialPiSessionModel: mock(async () => {}),
  makeLocalProtocolOptions: mock(() => ({ options: {}, bind: () => {} })),
  readCycleOrder: mock(() => undefined),
  createCompactionStatusExtension: mock(() => ({ extension: {}, holder: null })),
}));

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

beforeEach(() => {
  extensionInitialize.mockClear();
  extensionEmit.mockClear();
});

afterAll(() => {
  mock.restore();
  rmSync(workspacePath, { recursive: true, force: true });
});

describe('LocalSessionHost extension runtime boot', () => {
  it('initializes extensions once without starting a terminal and emits session_start once', async () => {
    const host = await LocalSessionHost.boot(
      target,
      { mode: 'open', sessionFilePath: '/tmp/runtime-test-session.jsonl' },
      sinks,
    );

    expect(extensionInitialize).toHaveBeenCalledTimes(1);
    expect(extensionInitialize.mock.calls[0]?.[3]).toBeDefined();
    expect(extensionEmit).toHaveBeenCalledTimes(1);
    expect(extensionEmit.mock.calls[0]?.[0]).toEqual({ type: 'session_start' });

    await host.dispose();
  });
});
