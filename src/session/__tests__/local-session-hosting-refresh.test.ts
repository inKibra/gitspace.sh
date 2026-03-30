import { describe, expect, it, mock } from 'bun:test';

const mockRefreshTmuxHosting = mock(async () => ({ active: true, routes: [] as Array<{ hostname: string; service: string }> }));

mock.module('../../lib/tmux-lite/hosting/supervisor.js', () => ({
  refreshTmuxHosting: mockRefreshTmuxHosting,
}));

const { LocalSessionBackend } = await import('../backends/local-session-backend');

describe('LocalSessionBackend hosting refresh', () => {
  it('refreshes tmux hosting after starting a process', async () => {
    mockRefreshTmuxHosting.mockClear();
    const events: Array<{ type: string }> = [];
    const backend = new LocalSessionBackend({
      deps: {
        sendTmuxCommand: async (command) => {
          if (command.type !== 'service-start') {
            throw new Error(`Unexpected command: ${command.type}`);
          }
          return {
            type: 'service-started' as const,
            workspaceId: command.workspaceId,
            processName: command.processName,
            sessionId: 'sess-1',
            sessionIds: ['sess-1'],
          };
        },
      },
    });
    backend.onEvent((event) => events.push(event));

    await backend.startProcess('gitspace.sh:figma-based-redesign', 'sample-server', 1);

    expect(mockRefreshTmuxHosting).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'process_started',
    }));
  });

  it('refreshes tmux hosting after stopping a process', async () => {
    mockRefreshTmuxHosting.mockClear();
    const events: Array<{ type: string }> = [];
    const backend = new LocalSessionBackend({
      deps: {
        sendTmuxCommand: async (command) => {
          if (command.type !== 'service-stop') {
            throw new Error(`Unexpected command: ${command.type}`);
          }
          return {
            type: 'service-stopped' as const,
            workspaceId: command.workspaceId,
            processName: command.processName,
          };
        },
      },
    });
    backend.onEvent((event) => events.push(event));

    await backend.stopProcess('gitspace.sh:figma-based-redesign', 'sample-server');

    expect(mockRefreshTmuxHosting).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'process_stopped',
    }));
  });
});
