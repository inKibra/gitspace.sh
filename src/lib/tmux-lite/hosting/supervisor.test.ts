import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProcessHostname } from '../../../utils/hostnames.js';

type HostingState = {
  baseHost?: string;
  machineName?: string;
  enabled: boolean;
  cloudflaredPid?: number;
  cloudflaredConfigPath?: string;
  updatedAt: number;
};

let hostingState: HostingState | null = null;
let hostConfig: {
  serveNamespaces?: Record<string, {
    domain: string;
    tunnel?: {
      id: string;
      name: string;
      configSource: 'local';
      credentialsPath: string;
    };
  }>;
} | null = null;
let gitspaceDir: string;
let previousWorkspaceRootEnv: string | undefined;

const originalBunSleep = Bun.sleep;
const sleepMock = mock(async () => undefined);
const spawnMock = mock((_args: string[]) => ({
  pid: 4242,
  exited: new Promise<number>(() => {}),
  unref: mock(() => undefined),
}) as unknown);
const mockIsCloudflaredInstalled = mock(async () => true);
const mockListSessionsFromRunningServer = mock(async () => [] as Array<{ name: string; exitCode?: number; cwd: string }>);
const mockIsServerRunning = mock(async () => true);
const mockResolveWorkspaceRef = mock((cwd: string) => ({ workspaceId: 'demo', workspacePath: cwd }));
const mockLoadProcessesConfig = mock(() => ({
  processes: [{
    name: 'web',
    ports: [{ protocol: 'http', name: 'app' }],
  }],
}));
const mockReadAllocatedProcessPorts = mock(() => [
  { instance: 1, port: 7777, protocol: 'http' as const, name: 'app' },
]);
const mockSyncServeRouteHostnames = mock(async ({ hostnames }: { rootSubdomain: string; hostnames: string[] }) => ({
  serveDomain: 'gitspace.sh',
  syncedHostnames: hostnames,
  deletedHostnames: [] as string[],
}));

mock.module('bun', () => ({
  spawn: spawnMock,
}));

mock.module('../../../commands/host.js', () => ({
  readHostConfig: mock(() => hostConfig),
  syncServeRouteHostnames: mockSyncServeRouteHostnames,
}));

mock.module('../../../utils/cloudflared.js', () => ({
  isCloudflaredInstalled: mockIsCloudflaredInstalled,
}));

mock.module('../../../core/config.js', () => ({
  getGitspaceDir: mock(() => gitspaceDir),
}));

mock.module('./state.js', () => ({
  readTmuxHostingState: mock(() => hostingState),
  writeTmuxHostingState: mock((next: Partial<HostingState>) => {
    hostingState = {
      baseHost: next.baseHost ?? hostingState?.baseHost,
      machineName: next.machineName ?? hostingState?.machineName,
      enabled: next.enabled ?? hostingState?.enabled ?? true,
      cloudflaredPid: Object.prototype.hasOwnProperty.call(next, 'cloudflaredPid')
        ? next.cloudflaredPid
        : hostingState?.cloudflaredPid,
      cloudflaredConfigPath: Object.prototype.hasOwnProperty.call(next, 'cloudflaredConfigPath')
        ? next.cloudflaredConfigPath
        : hostingState?.cloudflaredConfigPath,
      updatedAt: Date.now(),
    };
    return hostingState;
  }),
}));

mock.module('../cli.js', () => ({
  listSessionsFromRunningServer: mockListSessionsFromRunningServer,
  isServerRunning: mockIsServerRunning,
  isProcessRunning: mock(() => false),
}));

mock.module('../../events/paths.js', () => ({
  resolveWorkspaceRef: mockResolveWorkspaceRef,
}));

mock.module('../../processes/config.js', () => ({
  loadProcessesConfig: mockLoadProcessesConfig,
}));
mock.module('../../processes/allocations.js', () => ({
  reconcileProcessPortAllocations: mock(() => undefined),
  readAllocatedProcessPorts: mockReadAllocatedProcessPorts,
}));

mock.module('../../../utils/logger.js', () => ({
  logger: {
    log: mock(() => undefined),
    warning: mock(() => undefined),
    error: mock(() => undefined),
    dim: mock(() => undefined),
    success: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

const { refreshTmuxHosting, getTmuxHostingRuntimeStatus } = await import('./supervisor.js');

describe('tmux hosting supervisor', () => {
  beforeEach(() => {
    gitspaceDir = mkdtempSync(join(tmpdir(), 'tmux-hosting-supervisor-'));
    // supervisor.ts resolves its runtime dir via getWorkspaceRoot() (core/paths.js),
    // which honors this env override — keep the test writing into the temp dir.
    previousWorkspaceRootEnv = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = gitspaceDir;
    hostingState = null;
    hostConfig = null;
    sleepMock.mockClear();
    spawnMock.mockClear();
    mockIsCloudflaredInstalled.mockReset();
    mockListSessionsFromRunningServer.mockReset();
    mockIsServerRunning.mockReset();
    mockResolveWorkspaceRef.mockReset();
    mockLoadProcessesConfig.mockReset();
    mockReadAllocatedProcessPorts.mockReset();
    mockSyncServeRouteHostnames.mockReset();

    Bun.sleep = sleepMock as typeof Bun.sleep;
    mockIsCloudflaredInstalled.mockResolvedValue(true);
    mockListSessionsFromRunningServer.mockResolvedValue([]);
    mockIsServerRunning.mockResolvedValue(true);
    mockResolveWorkspaceRef.mockImplementation((cwd: string) => ({ workspaceId: 'demo', workspacePath: cwd }));
    mockLoadProcessesConfig.mockReturnValue({
      processes: [{
        name: 'web',
        ports: [{ protocol: 'http', name: 'app' }],
      }],
    });
    mockReadAllocatedProcessPorts.mockReturnValue([
      { instance: 1, port: 7777, protocol: 'http', name: 'app' },
    ]);
    mockSyncServeRouteHostnames.mockResolvedValue({
      serveDomain: 'gitspace.sh',
      syncedHostnames: [],
      deletedHostnames: [],
    });
  });

  afterEach(() => {
    if (typeof hostingState?.cloudflaredPid === 'number') {
      try {
        process.kill(hostingState.cloudflaredPid);
      } catch {
        // Best effort cleanup for real cloudflared processes when Bun module mocks are not applied.
      }
    }
    Bun.sleep = originalBunSleep;
    if (previousWorkspaceRootEnv === undefined) {
      delete process.env.GITSPACE_WORKSPACE_ROOT;
    } else {
      process.env.GITSPACE_WORKSPACE_ROOT = previousWorkspaceRootEnv;
    }
    rmSync(gitspaceDir, { recursive: true, force: true });
  });

  test('repairs persisted legacy serve hosts before looking up synced serve tunnel config', async () => {
    hostingState = {
      baseHost: 'brad.serve.serve.gitspace.sh',
      enabled: true,
      updatedAt: Date.now(),
    };

    const refreshed = await refreshTmuxHosting();

    expect(refreshed).toEqual({
      active: false,
      routes: [],
      reason: 'missing serve tunnel configuration for brad',
    });
  });

  test('syncs flattened service hostnames before writing local cloudflared config', async () => {
    const credentialsPath = join(gitspaceDir, 'serve-tunnel-1.json');
    hostingState = {
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: Date.now(),
    };
    hostConfig = {
      serveNamespaces: {
        brad: {
          domain: 'gitspace.sh',
          tunnel: {
            id: 'serve-tunnel-1',
            name: 'Serve Brad',
            configSource: 'local',
            credentialsPath,
          },
        },
      },
    };
    mockListSessionsFromRunningServer.mockResolvedValue([
      { name: 'proc:demo:web:1', cwd: join(gitspaceDir, 'workspace-demo') },
    ]);

    const refreshed = await refreshTmuxHosting();
    const expectedHostname = buildProcessHostname('gitspace.sh', 'brad', 'demo', 'web', 1, 'app', 'macbook');
    const runtimeDir = join(gitspaceDir, '.tmux-hosting');

    expect(mockSyncServeRouteHostnames).toHaveBeenCalledWith({
      rootSubdomain: 'brad',
      hostnames: [expectedHostname],
    });
    expect(refreshed).toEqual({
      active: true,
      routes: [{ hostname: expectedHostname, service: 'http://127.0.0.1:7777' }],
    });
    expect(readFileSync(join(runtimeDir, 'cloudflared.yml'), 'utf-8')).toContain('tunnel: serve-tunnel-1');
    expect(readFileSync(join(runtimeDir, 'cloudflared.yml'), 'utf-8')).toContain(`credentials-file: ${JSON.stringify(credentialsPath)}`);
    expect(readFileSync(join(runtimeDir, 'cloudflared.yml'), 'utf-8')).toContain(`hostname: ${expectedHostname}`);
    expect(JSON.parse(readFileSync(join(runtimeDir, 'hosted-routes.json'), 'utf-8'))).toEqual([
      { hostname: expectedHostname, service: 'http://127.0.0.1:7777' },
    ]);
  });

  test('stops publication when remote serve-route sync fails', async () => {
    hostingState = {
      baseHost: 'brad.gitspace.sh',
      enabled: true,
      updatedAt: Date.now(),
    };
    hostConfig = {
      serveNamespaces: {
        brad: {
          domain: 'gitspace.sh',
          tunnel: {
            id: 'serve-tunnel-1',
            name: 'Serve Brad',
            configSource: 'local',
            credentialsPath: join(gitspaceDir, 'serve-tunnel-1.json'),
          },
        },
      },
    };
    mockListSessionsFromRunningServer.mockResolvedValue([
      { name: 'proc:demo:web:1', cwd: join(gitspaceDir, 'workspace-demo') },
    ]);
    mockSyncServeRouteHostnames.mockRejectedValue(new Error('route sync failed'));

    const refreshed = await refreshTmuxHosting();

    expect(refreshed).toEqual({
      active: false,
      routes: [],
      reason: 'route sync failed',
    });
  });

  test('reports invalid stored hosts explicitly in runtime status', async () => {
    hostingState = {
      baseHost: 'brad.invalid.gitspace.sh',
      enabled: true,
      updatedAt: Date.now(),
    };

    const status = await getTmuxHostingRuntimeStatus();

    expect(status).toEqual({
      active: false,
      routeCount: 0,
      reason: 'invalid hosting base host',
    });
  });

  test('reports tmux-lite server not running without attempting session discovery', async () => {
    hostingState = {
      baseHost: 'brad.gitspace.sh',
      enabled: true,
      updatedAt: Date.now(),
    };
    hostConfig = {
      serveNamespaces: {
        brad: {
          domain: 'gitspace.sh',
          tunnel: {
            id: 'serve-tunnel-1',
            name: 'Serve Brad',
            configSource: 'local',
            credentialsPath: join(gitspaceDir, 'serve-tunnel-1.json'),
          },
        },
      },
    };
    mockIsServerRunning.mockResolvedValue(false);

    const refreshed = await refreshTmuxHosting();

    expect(mockListSessionsFromRunningServer).not.toHaveBeenCalled();
    expect(refreshed).toEqual({
      active: false,
      routes: [],
      reason: 'tmux-lite server not running',
    });
  });
});
