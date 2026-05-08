import { describe, expect, it, mock } from 'bun:test';

import { createFrame, openFrame } from '../../tmux-lite/crypto/frames.js';
import { parseRemoteMessage, serializeRemoteMessage } from '../protocol.js';
import { RemoteSessionHandler, canAccessReplayForSession, filterReplaysForSessionAccess, type RemoteClientSession } from '../session-handler.js';

describe('remote replay session access', () => {
  it('allows full access to all replays', () => {
    const replays = [
      { replayId: 'r1', sessionId: 's1' },
      { replayId: 'r2', sessionId: 's2' },
    ];

    expect(filterReplaysForSessionAccess('full', undefined, replays)).toEqual(replays);
    expect(canAccessReplayForSession('full', undefined, { sessionId: 's1' })).toBe(true);
  });

  it('limits view access to the granted session only', () => {
    const replays = [
      { replayId: 'r1', sessionId: 's1' },
      { replayId: 'r2', sessionId: 's2' },
    ];

    expect(filterReplaysForSessionAccess('view', 's2', replays)).toEqual([{ replayId: 'r2', sessionId: 's2' }]);
    expect(canAccessReplayForSession('view', 's2', { sessionId: 's2' })).toBe(true);
    expect(canAccessReplayForSession('view', 's2', { sessionId: 's1' })).toBe(false);
  });

  it('denies replay access when no session grant is present', () => {
    const replays = [{ replayId: 'r1', sessionId: 's1' }];
    expect(filterReplaysForSessionAccess('view', undefined, replays)).toEqual([]);
    expect(canAccessReplayForSession('view', undefined, { sessionId: 's1' })).toBe(false);
    expect(canAccessReplayForSession(undefined, undefined, { sessionId: 's1' })).toBe(false);
  });
});

describe('remote /space command responses', () => {
  it('encrypts run_space_command_response frames', async () => {
    mock.module('@oh-my-pi/pi-coding-agent/exec/exec', () => ({
      execCommand: async () => ({ stdout: 'event output', stderr: '', code: 0 }),
    }));

    const handler = new RemoteSessionHandler();
    const sendKey = new Uint8Array(32).fill(7);
    const receiveKey = new Uint8Array(32).fill(11);
    const session: RemoteClientSession = {
      connectionId: 'client-1',
      state: 'browsing',
      accessType: 'full',
      sessionKeys: {
        sendKey,
        receiveKey,
        sessionId: 'session-keys-1',
      },
    };

    const request = {
      type: 'run_space_command' as const,
      requestId: 'request-1',
      target: {
        workspaceId: 'project:workspace',
        workspaceName: 'workspace',
        projectName: 'project',
        workspacePath: process.cwd(),
      },
      argsText: 'events list',
    };

    const requestFrame = createFrame(0, new TextEncoder().encode(serializeRemoteMessage(request)), receiveKey);
    const responses: Uint8Array[] = [];

    await handler.handleMessage(session, requestFrame, (data) => {
      responses.push(data);
    });

    expect(responses).toHaveLength(1);
    expect(new TextDecoder().decode(responses[0]).startsWith('{')).toBe(false);

    const opened = openFrame(responses[0], sendKey);
    expect(opened).not.toBeNull();
    if (!opened) throw new Error('Expected encrypted response to decrypt');
    expect(opened.streamId).toBe(0);
    const message = parseRemoteMessage(new TextDecoder().decode(opened.data));
    expect(message).toEqual({
      type: 'run_space_command_response',
      requestId: 'request-1',
      output: 'Output from `space events list` in the current workspace:\n\nevent output',
    });
  });
});
