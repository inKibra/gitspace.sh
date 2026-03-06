import { afterEach, describe, expect, it } from 'bun:test';
import { act } from '@testing-library/react';
import { testRender } from '@opentui/react/test-utils';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ScriptTerminal } from '../ScriptTerminal.tui.js';

type ScriptPhase = 'pre' | 'setup' | 'select' | 'remove';

interface HarnessState {
  phase: ScriptPhase;
  isRunning: boolean;
  error?: string;
  exitCode?: number;
  modalOpen?: boolean;
}

interface HarnessControls {
  update: (patch: Partial<HarnessState>) => void;
  getWriter: () => ((data: Uint8Array) => void) | null;
  feedText: (text: string) => void;
}

function createHarness(initial: HarnessState): {
  Component: () => ReactElement;
  controls: HarnessControls;
} {
  let writer: ((data: Uint8Array) => void) | null = null;
  let updateState: ((patch: Partial<HarnessState>) => void) | null = null;

  const controls: HarnessControls = {
    update: (patch) => {
      updateState?.(patch);
    },
    getWriter: () => writer,
    feedText: (text) => {
      writer?.(new TextEncoder().encode(text));
    },
  };

  function Component(): ReactElement {
    const [state, setState] = useState<HarnessState>(initial);
    const handleWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
      writer = fn;
    }, []);

    useEffect(() => {
      updateState = (patch) => {
        setState((prev) => ({ ...prev, ...patch }));
      };

      return () => {
        updateState = null;
      };
    }, []);

    return (
      <ScriptTerminal
        phase={state.phase}
        workspaceName="alpha-ws"
        isRunning={state.isRunning}
        error={state.error}
        exitCode={state.exitCode}
        modalOpen={state.modalOpen}
        setWriteCallback={handleWriteCallback}
      />
    ) as ReactElement;
  }

  return { Component, controls };
}

async function renderAndFlush(renderOnce: () => Promise<void>): Promise<void> {
  await renderOnce();
  await Bun.sleep(0);
  await renderOnce();
}

let destroyRenderer: (() => void) | null = null;

afterEach(() => {
  if (destroyRenderer) {
    destroyRenderer();
    destroyRenderer = null;
  }
});

describe('ScriptTerminal TUI', () => {
  it('renders live script output while running', async () => {
    const { Component, controls } = createHarness({
      phase: 'pre',
      isRunning: true,
    });

    const { renderer, renderOnce, captureCharFrame } = await testRender(<Component />, {
      width: 90,
      height: 24,
    });
    destroyRenderer = () => renderer.destroy();

    await renderAndFlush(renderOnce);
    expect(controls.getWriter()).toBeDefined();
    expect(captureCharFrame()).toContain('Waiting for Pre script output...');

    await act(async () => {
      controls.feedText('pre-live-output\n');
    });

    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('pre-live-output');
  });

  it('keeps showing current running phase output even after manual phase navigation', async () => {
    const { Component, controls } = createHarness({
      phase: 'pre',
      isRunning: true,
    });

    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(<Component />, {
      width: 90,
      height: 24,
    });
    destroyRenderer = () => renderer.destroy();

    await renderAndFlush(renderOnce);

    await act(async () => {
      controls.feedText('pre-start\n');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('pre-start');

    await act(async () => {
      controls.update({ phase: 'setup', isRunning: true });
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('[Setup ...]');
    expect(captureCharFrame()).toContain('Waiting for Setup script output...');

    await act(async () => {
      controls.feedText('setup-live-1\n');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('setup-live-1');

    await act(async () => {
      mockInput.pressArrow('left');
    });
    await renderAndFlush(renderOnce);

    await act(async () => {
      controls.feedText('setup-live-2\n');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('setup-live-2');
  });

  it('keeps phase output segregated when phase banner arrives before prop phase update', async () => {
    const { Component, controls } = createHarness({
      phase: 'pre',
      isRunning: true,
    });

    const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(<Component />, {
      width: 90,
      height: 24,
    });
    destroyRenderer = () => renderer.destroy();

    await renderAndFlush(renderOnce);

    await act(async () => {
      controls.feedText('pre-only\n');
      controls.feedText('\r\n==> setup scripts...\r\nsetup-only\n');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('[Setup ...]');

    await act(async () => {
      controls.update({ phase: 'setup', isRunning: false });
    });
    await renderAndFlush(renderOnce);

    const setupFrame = captureCharFrame();
    expect(setupFrame).toContain('setup-only');

    await act(async () => {
      mockInput.pressArrow('left');
    });
    await renderAndFlush(renderOnce);
    const preFrame = captureCharFrame();
    expect(preFrame).toContain('pre-only');
    expect(preFrame).not.toContain('setup-only');

    await act(async () => {
      mockInput.pressArrow('right');
    });
    await renderAndFlush(renderOnce);
    expect(captureCharFrame()).toContain('setup-only');
  });
});
