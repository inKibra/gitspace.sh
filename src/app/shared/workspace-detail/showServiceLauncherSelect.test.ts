import { describe, expect, it, mock } from 'bun:test';
import { buildProcessHostname } from '../../../utils/hostnames.js';

const mockReadTmuxHostingState = mock(() => ({
  baseHost: 'brad.gitspace.sh',
  machineName: 'macbook',
  enabled: true,
  updatedAt: Date.now(),
}));
const mockBuildServiceLauncherOptions = mock((args: { workspaceId: string; processName: string; instance: number; ports?: Array<{ instance: number; name: string; port: number; protocol?: 'http' | 'tcp' }>; hosting?: { baseHost?: string; machineName?: string; enabled: boolean } }) => {
  const port = args.ports?.find((candidate) => candidate.instance === args.instance && (candidate.protocol ?? 'http') === 'http');
  if (!port) return [];
  const portLabel = port.name;
  const remoteUrl = args.hosting?.baseHost
    ? `http://${buildProcessHostname('gitspace.sh', 'brad', args.workspaceId, args.processName, args.instance, portLabel, args.hosting.machineName)}`
    : undefined;
  return [
    ...(remoteUrl ? [{ label: `Open remote ${portLabel}`, description: remoteUrl, url: remoteUrl, target: 'remote' as const }] : []),
    { label: `Open local ${portLabel}`, description: `http://localhost:${port.port}`, url: `http://localhost:${port.port}`, target: 'local' as const },
  ];
});

mock.module('../../../lib/tmux-lite/hosting/state.js', () => ({
  readTmuxHostingState: mockReadTmuxHostingState,
}));

mock.module('../../../lib/services/endpoints.js', () => ({
  buildServiceLauncherOptions: mockBuildServiceLauncherOptions,
}));

const { showServiceLauncherSelect } = await import('./showServiceLauncherSelect.js');

describe('showServiceLauncherSelect', () => {
  it('shows remote and local launcher options for browser-openable ports', () => {
    const showSelect = mock(() => undefined);

    const shown = showServiceLauncherSelect({
      workspace: {
        id: 'demo',
        name: 'Demo',
        path: '/tmp/demo',
        projectName: 'proj',
        sessionCount: 0,
        serveDomain: 'brad.gitspace.sh',
        processes: [{
          name: 'web',
          ports: [
            { instance: 1, name: 'app', port: 3000, protocol: 'http' },
            { instance: 1, name: 'tcp-admin', port: 7000, protocol: 'tcp' },
          ],
        }],
      },
      processName: 'web',
      instance: 1,
      showSelect,
      onSelectUrl: () => undefined,
    });

    expect(shown).toBe(true);
    expect(showSelect).toHaveBeenCalledTimes(1);
    expect(mockBuildServiceLauncherOptions).toHaveBeenCalledWith(expect.objectContaining({
      hosting: expect.objectContaining({
        baseHost: 'brad.gitspace.sh',
        machineName: 'macbook',
        enabled: true,
      }),
    }));
    const firstCall = (showSelect as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(firstCall).toBeDefined();
    const config = firstCall![0] as unknown as { options: Array<{ label: string; description?: string }> };
    expect(config.options.map((option) => option.label)).toEqual(['Open remote app', 'Open local app']);
  });
});
