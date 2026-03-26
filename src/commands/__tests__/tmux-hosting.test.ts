import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type HostingState = {
  baseHost?: string;
  machineName?: string;
  enabled: boolean;
  updatedAt: number;
};

const originalStdoutIsTTY = process.stdout.isTTY;
const originalStdinIsTTY = process.stdin.isTTY;

let hostingState: HostingState | null = null;

const mockResolveHostingSubdomains = mock(async (): Promise<string[]> => []);
const mockWriteTmuxHostingState = mock((next: Partial<HostingState>): HostingState => {
  hostingState = {
    baseHost: next.baseHost ?? hostingState?.baseHost,
    machineName: next.machineName ?? hostingState?.machineName ?? 'macbook',
    enabled: next.enabled ?? hostingState?.enabled ?? true,
    updatedAt: Date.now(),
  };
  return hostingState;
});
const mockRefreshTmuxHosting = mock(async () => ({ active: true, routes: [] as Array<{ hostname: string; service: string }> }));
const mockSelectOne = mock(async () => null as string | null);
const mockLogger = {
  warning: mock(() => undefined),
  dim: mock(() => undefined),
  info: mock(() => undefined),
  success: mock(() => undefined),
  log: mock(() => undefined),
  error: mock(() => undefined),
};

mock.module('../host.js', () => ({
  resolveHostingSubdomains: mockResolveHostingSubdomains,
}));

mock.module('../../lib/tmux-lite/hosting/state.js', () => ({
  clearTmuxHostingState: mock(() => undefined),
  readTmuxHostingState: mock(() => hostingState),
  resolveTmuxHostingState: mock(() => hostingState ?? { enabled: false, updatedAt: Date.now() }),
  writeTmuxHostingState: mockWriteTmuxHostingState,
}));

mock.module('../../lib/tmux-lite/hosting/supervisor.js', () => ({
  getTmuxHostingRuntimeStatus: mock(async () => ({ active: false, routeCount: 0, reason: 'disabled' })),
  refreshTmuxHosting: mockRefreshTmuxHosting,
  stopTmuxHosting: mock(async () => undefined),
}));

mock.module('../../utils/prompts.js', () => ({
  selectOne: mockSelectOne,
}));

mock.module('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

const { selectTmuxHosting } = await import('../tmux.js');

describe('tmux hosting route selection', () => {
  beforeEach(() => {
    hostingState = null;
    mockResolveHostingSubdomains.mockReset();
    mockWriteTmuxHostingState.mockClear();
    mockRefreshTmuxHosting.mockReset();
    mockSelectOne.mockReset();
    for (const method of Object.values(mockLogger)) {
      method.mockClear();
    }

    mockRefreshTmuxHosting.mockResolvedValue({ active: true, routes: [] });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });
  });

  test('canonicalizes root hosts returned from hosting route discovery', async () => {
    mockResolveHostingSubdomains.mockResolvedValue(['brad']);

    await selectTmuxHosting(undefined);

    expect(mockWriteTmuxHostingState).toHaveBeenCalledWith({
      baseHost: 'brad.gitspace.sh',
      enabled: true,
    });
    expect(hostingState?.baseHost).toBe('brad.gitspace.sh');
  });

  test('accepts a reserved root host and normalizes it to the relay fqdn', async () => {
    await selectTmuxHosting('Brad');

    expect(mockResolveHostingSubdomains).not.toHaveBeenCalled();
    expect(mockWriteTmuxHostingState).toHaveBeenCalledWith({
      baseHost: 'brad.gitspace.sh',
      enabled: true,
    });
    expect(hostingState?.baseHost).toBe('brad.gitspace.sh');
  });

  test('repairs explicit double-serve hosts before persisting them', async () => {
    await selectTmuxHosting('brad.serve.serve.gitspace.sh');

    expect(mockWriteTmuxHostingState).toHaveBeenCalledWith({
      baseHost: 'brad.gitspace.sh',
      enabled: true,
    });
    expect(hostingState?.baseHost).toBe('brad.gitspace.sh');
  });
});
