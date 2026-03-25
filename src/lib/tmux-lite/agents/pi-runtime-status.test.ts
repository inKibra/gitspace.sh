import { describe, expect, test } from 'bun:test';
import type { PendingQuestion, Permission } from '../../../agents/agent-runtime-types.js';
import {
  buildPiRuntimeChildEnvironment,
  createPiRuntimeUpdateCommand,
  verifyPiRuntimeUpdateCommand,
} from './pi-runtime-status.js';

const pendingPermission: Permission = {
  id: 'perm-1',
  type: 'permission',
  sessionID: 'session-1',
  messageID: 'msg-1',
  title: 'Permission requested',
  metadata: {},
  time: { created: Date.now() },
};

const pendingQuestion: PendingQuestion = {
  id: 'question-1',
  sessionID: 'session-1',
  questions: [{ question: 'Continue?', header: 'Question', options: [], custom: true }],
  tool: { messageID: 'msg-1', callID: 'call-1' },
};

describe('pi-runtime-status', () => {
  test('signs and verifies runtime update commands', () => {
    const env = buildPiRuntimeChildEnvironment('/tmp/tmux-lite-test.sock');
    const secret = env.GITSPACE_PI_RUNTIME_SECRET;
    expect(secret).toBeTruthy();

    const command = createPiRuntimeUpdateCommand({
      sessionId: 'session-1',
      terminalSessionId: 'pty-1',
      workspacePath: '/tmp/demo/ws-1',
      status: { type: 'busy' },
      pendingPermissions: [pendingPermission],
      pendingQuestions: [pendingQuestion],
      errorMessage: 'still waiting',
      lastMessage: 'preview',
    }, { timestamp: 1_700_000_000_000, secret });

    expect(verifyPiRuntimeUpdateCommand(command, { now: 1_700_000_000_100, secret })).toBe(true);
    expect(verifyPiRuntimeUpdateCommand({ ...command, signature: '00'.repeat(32) }, { now: 1_700_000_000_100, secret })).toBe(false);
  });

  test('rejects stale runtime update commands', () => {
    const env = buildPiRuntimeChildEnvironment('/tmp/tmux-lite-test.sock');
    const secret = env.GITSPACE_PI_RUNTIME_SECRET;
    const command = createPiRuntimeUpdateCommand({
      sessionId: 'session-1',
      terminalSessionId: 'pty-1',
      workspacePath: '/tmp/demo/ws-1',
      status: { type: 'idle' },
      pendingPermissions: [],
      pendingQuestions: [],
    }, { timestamp: 1_700_000_000_000, secret });

    expect(verifyPiRuntimeUpdateCommand(command, { now: 1_700_000_031_000, secret })).toBe(false);
  });
});
