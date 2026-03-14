import { afterEach, describe, expect, it, mock } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { ReplayTerminal } from '../ReplayTerminal.tui.js';
import type { ReplayInfo } from '../SpacesBrowser.js';

function makeReplay(overrides: Partial<ReplayInfo> = {}): ReplayInfo {
  return {
    replayId: 'replay-1',
    sessionId: 'session-1',
    sessionName: 'ghost-session',
    cwd: '/tmp/workspace',
    workspaceId: 'ws-1',
    projectName: 'proj',
    workspaceName: 'workspace',
    startedAt: Date.now() - 120_000,
    endedAt: Date.now() - 60_000,
    status: 'closed',
    durationMs: 60_000,
    eventCount: 10,
    checkpointCount: 2,
    lastSeq: 10,
    ...overrides,
  };
}

let destroyRenderer: (() => void) | null = null;

afterEach(async () => {
  if (destroyRenderer) {
    await act(async () => {
      destroyRenderer?.();
    });
    destroyRenderer = null;
  }
});

describe('ReplayTerminal TUI', () => {
  it('shows restore hint for dismissed replays', async () => {
    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <ReplayTerminal
        replay={makeReplay({ dismissedAt: Date.now() - 1_000, dismissedBy: 'tester' })}
        loadReplayAnsi={mock(() => new Promise<Buffer>(() => {}))}
        onBack={mock(() => {})}
        onDismiss={mock(async () => {})}
      />,
      { width: 100, height: 20 },
    );
    destroyRenderer = () => renderer.destroy();

    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain('[d] Restore');
    expect(frame).not.toContain('[d] Dismiss');
  });
});
