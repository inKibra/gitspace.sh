import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildProcessHostname } from '../../utils/hostnames.js';

let hostingState: { baseHost?: string; machineName?: string; enabled: boolean; updatedAt: number } | null = null;

mock.module('../tmux-lite/hosting/state.js', () => ({
  readTmuxHostingState: mock(() => hostingState),
  writeTmuxHostingState: mock(() => hostingState ?? { enabled: true, updatedAt: Date.now() }),
  resolveTmuxHostingState: mock(() => hostingState ?? { enabled: false, updatedAt: Date.now() }),
  clearTmuxHostingState: mock(() => undefined),
}));

const mockResolveHostedServiceUrl = mock((args: { baseHost?: string; machineName?: string; workspaceId: string; processName: string; instance: number; portLabel: string; protocol: 'http' | 'tcp' }) => {
  return args.protocol === 'http' && args.baseHost
    ? `http://${buildProcessHostname('gitspace.sh', 'brad', args.workspaceId, args.processName, args.instance, args.portLabel, args.machineName)}`
    : undefined;
});

mock.module('../tmux-lite/hosting/routes.js', () => ({
  resolveHostedServiceUrl: mockResolveHostedServiceUrl,
}));

const { getHostingRouteState, buildServiceEndpoints } = await import('./endpoints.js');

describe('service endpoints hosting cutover', () => {
  const originalServeDomain = process.env.GITSPACE_SERVE_DOMAIN;
  const originalMachineName = process.env.GITSPACE_MACHINE_NAME;

  beforeEach(() => {
    hostingState = null;
    if (originalServeDomain === undefined) {
      delete process.env.GITSPACE_SERVE_DOMAIN;
    } else {
      process.env.GITSPACE_SERVE_DOMAIN = originalServeDomain;
    }
    if (originalMachineName === undefined) {
      delete process.env.GITSPACE_MACHINE_NAME;
    } else {
      process.env.GITSPACE_MACHINE_NAME = originalMachineName;
    }
    mockResolveHostedServiceUrl.mockClear();
  });

  it('prefers persisted tmux hosting state over legacy process env', () => {
    process.env.GITSPACE_SERVE_DOMAIN = 'legacy.gitspace.sh';
    process.env.GITSPACE_MACHINE_NAME = 'legacy-machine';
    hostingState = {
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: Date.now(),
    };

    expect(getHostingRouteState()).toEqual({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
    });
  });

  it('builds remote urls from tmux hosting state', () => {
    hostingState = {
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: Date.now(),
    };

    const endpoints = buildServiceEndpoints({
      workspaceId: 'demo',
      processName: 'web',
      instance: 1,
      ports: [{ instance: 1, name: 'app', port: 3000, protocol: 'http' }],
    });

    expect(endpoints).toEqual([
      {
        protocol: 'http',
        port: 3000,
        portLabel: 'app',
        localUrl: 'http://localhost:3000',
        remoteUrl: `http://${buildProcessHostname('gitspace.sh', 'brad', 'demo', 'web', 1, 'app', 'macbook')}`,
        hostingEnabled: true,
      },
    ]);
  });
});
