import { afterEach, describe, expect, it, jest, mock } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act, useState } from 'react';
import { ReplayTerminal } from '../ReplayTerminal.tui.js';
import type { ReplayInfo } from '../SpacesBrowser.js';
import type { ReplayFrame, ReplayFrameTarget, ReplayTimeline } from '../../lib/tmux-lite/replay/index.js';

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
    durationMs: 1_200,
    eventCount: 10,
    checkpointCount: 2,
    lastSeq: 3,
    ...overrides,
  };
}

function makeTimeline(overrides: Partial<ReplayTimeline> = {}): ReplayTimeline {
  return {
    replayId: 'replay-1',
    durationMs: 1_200,
    latestTimeMs: 1_200,
    steps: [
      { timeMs: 0, seq: 0 },
      { timeMs: 200, seq: 1 },
      { timeMs: 500, seq: 2 },
      { timeMs: 1_200, seq: 3 },
    ],
    checkpointSteps: [
      { timeMs: 0, seq: 0 },
      { timeMs: 500, seq: 2 },
    ],
    ...overrides,
  };
}

function textToBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function makeFrame(target?: ReplayFrameTarget): ReplayFrame {
  const label = `frame:${target?.atMs ?? -1}:${target?.atSeq ?? -1}`;
  return {
    replayId: 'replay-1',
    checkpoint: null,
    events: [
      { seq: target?.atSeq ?? 0, t: target?.atMs ?? 0, type: 'output', data: textToBase64(label) },
    ],
  };
}

async function renderAndFlush(renderOnce: () => Promise<void>) {
  // Allow terminal mount microtask + async frame loads to settle
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await renderOnce();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

let destroyRenderer: (() => void) | null = null;

afterEach(async () => {
  jest.useRealTimers();

  if (destroyRenderer) {
    await act(async () => {
      destroyRenderer?.();
    });
    destroyRenderer = null;
  }
});

describe('ReplayTerminal TUI', () => {
  it('shows restore hint for dismissed replays', async () => {
    const loadReplayFrame = mock(async (_replayId: string, target?: ReplayFrameTarget) => makeFrame(target));
    const loadReplayTimeline = mock(async () => makeTimeline());

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <ReplayTerminal
        replay={makeReplay({ dismissedAt: Date.now() - 1_000, dismissedBy: 'tester' })}
        loadReplayFrame={loadReplayFrame}
        loadReplayTimeline={loadReplayTimeline}
        onBack={mock(() => {})}
        onDismiss={mock(async () => {})}
      />,
      { width: 170, height: 20 },
    );
    destroyRenderer = () => renderer.destroy();

    await renderAndFlush(renderOnce);
    const frame = captureCharFrame();

    expect(frame).toContain('[d] Restore');
    expect(frame).not.toContain('[d] Dismiss');
  });

  it('does not reload the replay on unrelated parent rerenders', async () => {
    const loadReplayFrame = mock(async (_replayId: string, target?: ReplayFrameTarget) => makeFrame(target));
    const loadReplayTimeline = mock(async () => makeTimeline());

    let bump = () => {};

    function Harness() {
      const [, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);

      return (
        <ReplayTerminal
          replay={makeReplay()}
          loadReplayFrame={loadReplayFrame}
          loadReplayTimeline={loadReplayTimeline}
          onBack={mock(() => {})}
        />
      );
    }

    const { renderer, renderOnce, captureCharFrame } = await testRender(<Harness />, {
      width: 170,
      height: 20,
    });
    destroyRenderer = () => renderer.destroy();

    await renderAndFlush(renderOnce);
    expect(loadReplayFrame).toHaveBeenCalledTimes(1);
    expect(captureCharFrame()).toContain('frame:1200:3');

    await act(async () => {
      bump();
    });
    await renderAndFlush(renderOnce);

    expect(loadReplayFrame).toHaveBeenCalledTimes(1);
    expect(captureCharFrame()).toContain('frame:1200:3');
    expect(captureCharFrame()).not.toContain('Loading replay');
  });

  it('steps through replay points when paused', async () => {
    const loadReplayFrame = mock(async (_replayId: string, target?: ReplayFrameTarget) => makeFrame(target));
    const loadReplayTimeline = mock(async () => makeTimeline());

    const { renderer, renderOnce, mockInput, captureCharFrame } = await testRender(
      <ReplayTerminal
        replay={makeReplay()}
        loadReplayFrame={loadReplayFrame}
        loadReplayTimeline={loadReplayTimeline}
        onBack={mock(() => {})}
      />,
      { width: 170, height: 20 },
    );
    destroyRenderer = () => renderer.destroy();

    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('frame:1200:3');

    await act(async () => {
      mockInput.pressArrow('left');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('frame:500:2');

    await act(async () => {
      mockInput.pressArrow('left', { shift: true });
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('frame:0:0');

    await act(async () => {
      mockInput.pressArrow('right');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('frame:200:1');

    await act(async () => {
      mockInput.pressArrow('right', { shift: true });
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('frame:1200:3');
  });

  it('plays in real time and lets arrows adjust playback speed while playing', async () => {
    jest.useFakeTimers();

    const loadReplayFrame = mock(async (_replayId: string, target?: ReplayFrameTarget) => makeFrame(target));
    const loadReplayTimeline = mock(async () => makeTimeline());

    const { renderer, renderOnce, mockInput, captureCharFrame } = await testRender(
      <ReplayTerminal
        replay={makeReplay()}
        loadReplayFrame={loadReplayFrame}
        loadReplayTimeline={loadReplayTimeline}
        onBack={mock(() => {})}
      />,
      { width: 170, height: 20 },
    );
    destroyRenderer = () => renderer.destroy();

    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('[paused]');
    expect(captureCharFrame()).toContain('1.0x');

    await act(async () => {
      mockInput.pressKey(' ');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('[playing]');
    expect(captureCharFrame()).toContain('frame:0:0');

    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('frame:200:1');

    await act(async () => {
      mockInput.pressArrow('right');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('1.5x');

    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('frame:500:2');
  });
});
