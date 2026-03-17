import { describe, expect, it, mock } from 'bun:test';
import { openAgentSession } from '../agent-session-actions';

interface ConfirmOptions {
  onConfirm: () => Promise<void> | void;
  onCancel?: () => Promise<void> | void;
  title: string;
  message: string;
}

describe('openAgentSession', () => {
  it('attaches immediately when takeover is not required', async () => {
    const attachAgentSession = mock(async () => {});
    const persistAgentSessionSelection = mock(() => {});
    const clearViewOnly = mock(() => {});

    await openAgentSession({
      flow: { showConfirm: mock(() => {}) },
      workspaceId: 'proj:ws-1',
      agentSessionId: 'agent-1',
      persistAgentSessionSelection,
      clearViewOnly,
      checkAgentSessionTakeover: mock(async () => ({ requiresTakeover: false })),
      attachAgentSession,
    });

    expect(persistAgentSessionSelection).toHaveBeenCalledWith('proj:ws-1', 'agent-1');
    expect(clearViewOnly).toHaveBeenCalledTimes(1);
    expect(attachAgentSession).toHaveBeenCalledWith('proj:ws-1', 'agent-1', undefined);
  });

  it('prompts before taking over an attached agent terminal', async () => {
    const attachAgentSession = mock(async () => {});
    const persistAgentSessionSelection = mock(() => {});
    const clearViewOnly = mock(() => {});
    let confirmOptions: ConfirmOptions | null = null;

    const pending = openAgentSession({
      flow: {
        showConfirm: mock((options) => {
          confirmOptions = options as ConfirmOptions;
        }),
      },
      workspaceId: 'proj:ws-1',
      agentSessionId: 'agent-1',
      persistAgentSessionSelection,
      clearViewOnly,
      checkAgentSessionTakeover: mock(async () => ({
        requiresTakeover: true,
        sessionName: 'agent:ws-1:1234abcd',
      })),
      attachAgentSession,
    });

    await Bun.sleep(0);

    expect(confirmOptions).not.toBeNull();
    expect(confirmOptions!.title).toBe('Take Over Agent Terminal?');
    expect(confirmOptions!.message).toContain('agent:ws-1:1234abcd');
    expect(attachAgentSession).not.toHaveBeenCalled();

    await confirmOptions!.onConfirm();
    await pending;

    expect(persistAgentSessionSelection).toHaveBeenCalledWith('proj:ws-1', 'agent-1');
    expect(clearViewOnly).toHaveBeenCalledTimes(1);
    expect(attachAgentSession).toHaveBeenCalledWith('proj:ws-1', 'agent-1', { force: true });
  });
});
