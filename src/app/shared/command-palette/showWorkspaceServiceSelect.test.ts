import { describe, expect, it, mock } from 'bun:test';
import { showWorkspaceServiceSelect } from './showWorkspaceServiceSelect.js';

describe('showWorkspaceServiceSelect', () => {
  it('shows a service picker when multiple services exist', () => {
    const showSelect = mock(() => undefined);
    const showMessage = mock(() => undefined);

    showWorkspaceServiceSelect({
      workspace: {
        id: 'demo',
        name: 'Demo',
        path: '/tmp/demo',
        projectName: 'proj',
        sessionCount: 0,
        processes: [
          { name: 'web', ports: [{ instance: 1, name: 'app', port: 3000, protocol: 'http' }] },
          { name: 'api', ports: [{ instance: 1, name: 'api', port: 4000, protocol: 'http' }] },
        ],
      },
      showSelect,
      showMessage,
      onOpenUrl: () => undefined,
    });

    expect(showMessage).not.toHaveBeenCalled();
    expect(showSelect).toHaveBeenCalledTimes(1);
    const config = (showSelect as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      title: string;
      options: Array<{ label: string }>;
    };
    expect(config.title).toBe('Demo Services');
    expect(config.options.map((option) => option.label)).toEqual(['web#1', 'api#1']);
  });

  it('skips tcp-only services from the browser picker', () => {
    const showSelect = mock(() => undefined);
    const showMessage = mock(() => undefined);

    showWorkspaceServiceSelect({
      workspace: {
        id: 'demo',
        name: 'Demo',
        path: '/tmp/demo',
        projectName: 'proj',
        sessionCount: 0,
        processes: [
          { name: 'tcp-only', ports: [{ instance: 1, name: 'admin', port: 7000, protocol: 'tcp' }] },
        ],
      },
      showSelect,
      showMessage,
      onOpenUrl: () => undefined,
    });

    expect(showSelect).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith({
      title: 'Open Service',
      message: 'Demo has no browser-openable HTTP services.',
      variant: 'info',
    });
  });
});
