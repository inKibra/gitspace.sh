import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockTerminateSession = mock(async () => undefined);
const mockCreateSession = mock(async () => ({ id: 'sess-1', name: 'proc:test:web:1' }));
const mockIsProcessRunning = mock(() => false);
const mockIsServerRunning = mock(async () => true);
const mockListSessionsFromRunningServer = mock(async () => [] as Array<{
  id: string;
  name: string;
  pid: number;
}>);

mock.module('../tmux-lite/cli.js', () => ({
  terminateSession: mockTerminateSession,
  killServer: mock(async () => undefined),
  createSession: mockCreateSession,
  isProcessRunning: mockIsProcessRunning,
  isServerRunning: mockIsServerRunning,
  listSessions: mockListSessionsFromRunningServer,
  listSessionsFromRunningServer: mockListSessionsFromRunningServer,
}));

const { resolveManagedSession } = await import('./ports.js');

describe('resolveManagedSession', () => {
  beforeEach(() => {
    mockTerminateSession.mockReset();
    mockCreateSession.mockReset();
    mockIsProcessRunning.mockReset();
    mockIsServerRunning.mockReset();
    mockListSessionsFromRunningServer.mockReset();
    mockIsProcessRunning.mockReturnValue(false);
    mockIsServerRunning.mockResolvedValue(true);
    mockListSessionsFromRunningServer.mockResolvedValue([]);
  });

  it('returns null when the tmux server is not running', async () => {
    mockIsServerRunning.mockResolvedValue(false);

    await expect(resolveManagedSession(4242)).resolves.toBeNull();
    expect(mockListSessionsFromRunningServer).not.toHaveBeenCalled();
  });

  it('returns null when listing running sessions fails', async () => {
    mockListSessionsFromRunningServer.mockRejectedValue(new Error('list failed'));

    await expect(resolveManagedSession(4242)).resolves.toBeNull();
  });

  it('resolves a managed process session directly from the session pid', async () => {
    mockListSessionsFromRunningServer.mockResolvedValue([
      {
        id: 'sess-1',
        name: 'proc:figma-based-redesign:sample-server:1',
        pid: 4242,
      },
    ] as Array<any>);

    await expect(resolveManagedSession(4242)).resolves.toMatchObject({
      pid: 4242,
      managedSessionId: 'sess-1',
      managedSessionName: 'proc:figma-based-redesign:sample-server:1',
      managedWorkspaceId: 'figma-based-redesign',
      managedProcessName: 'sample-server',
      managedInstance: 1,
    });
  });

  it('uses session metadata (not the truncated name) for identity on long-named workspaces', async () => {
    // The session name is capped at 64 chars, so a long workspace id is
    // truncated in `name` but preserved in full in `metadata`. Ownership
    // resolution must return the untruncated metadata id, otherwise the
    // running process is never recognised as the owner of its port and its
    // allocation gets reassigned (the port-flicker bug).
    const fullWorkspaceId = 'core:bradleat-ink-404-zerbly-demo-voice-session-with-grok-voice-clone-call-prep';
    mockListSessionsFromRunningServer.mockResolvedValue([
      {
        id: 'sess-9',
        name: 'proc:bradleat-ink-404-zerbly-demo-voice-session-with-grok-:web:1', // truncated to 64
        pid: 5150,
        metadata: {
          role: 'process',
          workspaceId: fullWorkspaceId,
          processName: 'web',
          processInstance: '1',
        },
      },
    ] as Array<any>);

    await expect(resolveManagedSession(5150)).resolves.toMatchObject({
      pid: 5150,
      managedSessionId: 'sess-9',
      managedWorkspaceId: fullWorkspaceId,
      managedProcessName: 'web',
      managedInstance: 1,
    });
  });
});
