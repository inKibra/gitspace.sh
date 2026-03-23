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
          { name: 'web', ports: [{ name: 'app', port: 3000, protocol: 'http' }] },
          { name: 'api', ports: [{ name: 'api', port: 4000, protocol: 'http' }] },
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
});
