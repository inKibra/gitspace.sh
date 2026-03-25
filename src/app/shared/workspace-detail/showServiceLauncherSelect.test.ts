import { describe, expect, it, mock } from 'bun:test';
import { showServiceLauncherSelect } from './showServiceLauncherSelect.js';

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
        processes: [{
          name: 'web',
          ports: [
            { name: 'app', port: 3000, protocol: 'http' },
            { name: 'tcp-admin', port: 7000, protocol: 'tcp' },
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
    const firstCall = (showSelect as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(firstCall).toBeDefined();
    const config = firstCall![0] as unknown as { options: Array<{ label: string; description?: string }> };
    expect(config.options.map((option) => option.label)).toContain('Open local app');
  });
});
