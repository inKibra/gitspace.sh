/**
 * SpacesBrowser TUI renderer test
 *
 * POC: Uses OpenTUI testRender to verify that SpacesBrowserTUI
 * renders process and events items in the terminal frame output.
 */

import { describe, expect, it, mock, afterEach } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { SpacesBrowserTUI } from '../SpacesBrowser.tui.js';
import type { UseSpacesBrowserReturn, TreeItemWithState } from '../SpacesBrowser.js';

// ============================================================================
// Helpers
// ============================================================================

/** Build minimal props for SpacesBrowserTUI */
function makeTuiProps(overrides: Partial<UseSpacesBrowserReturn> = {}): UseSpacesBrowserReturn {
  return {
    items: [],
    selectedIndex: 0,
    selectedItem: null,
    expandedWorkspaces: new Set(),
    machineName: 'test-machine',
    isEmpty: false,
    moveUp: mock(() => {}),
    moveDown: mock(() => {}),
    selectIndex: mock(() => {}),
    toggleWorkspace: mock(() => {}),
    activateSelected: mock(async () => {}),
    activateIndex: mock(async () => {}),
    attachSession: mock(async () => {}),
    startProcessAttach: mock(() => {}),
    startProcess: mock(() => {}),
    stopProcess: mock(() => {}),
    createNewSession: mock(async () => {}),
    createWorkspace: mock(() => {}),
    refresh: mock(async () => {}),
    openEvents: mock(() => {}),
    editProcesses: mock(() => {}),
    back: mock(() => {}),
    ...overrides,
  };
}

function makeWorkspaceItem(overrides: Partial<Extract<TreeItemWithState, { type: 'workspace' }>> = {}): TreeItemWithState {
  return {
    type: 'workspace',
    workspace: {
      id: 'ws-1',
      name: 'my-workspace',
      path: '/workspaces/my-workspace',
      projectName: 'proj',
      branch: 'main',
      sessionCount: 2,
    },
    expanded: true,
    isSelected: false,
    index: 0,
    ...overrides,
  };
}

function makeSessionItem(overrides: Partial<Extract<TreeItemWithState, { type: 'session' }>> = {}): TreeItemWithState {
  return {
    type: 'session',
    session: {
      id: 'sess-1',
      name: 'proj:my-workspace:default',
      workspaceId: 'ws-1',
      attached: false,
      createdAt: Date.now() - 60000,
    },
    workspaceId: 'ws-1',
    isSelected: false,
    index: 1,
    ...overrides,
  };
}

function makeNewSessionItem(): TreeItemWithState {
  return {
    type: 'new-session',
    workspaceId: 'ws-1',
    isSelected: false,
    index: 2,
  };
}

// ============================================================================
// Cleanup
// ============================================================================

let destroyRenderer: (() => void) | null = null;

afterEach(() => {
  if (destroyRenderer) {
    destroyRenderer();
    destroyRenderer = null;
  }
});

// ============================================================================
// Tests
// ============================================================================

describe('SpacesBrowserTUI renderer', () => {
  it('renders workspace and session items in terminal frame', async () => {
    const items: TreeItemWithState[] = [
      makeWorkspaceItem(),
      makeSessionItem(),
      makeNewSessionItem(),
    ];

    const props = makeTuiProps({ items });

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <SpacesBrowserTUI {...props} />,
      { width: 80, height: 24 }
    );
    destroyRenderer = () => renderer.destroy();

    await renderOnce();
    const frame = captureCharFrame();

    // Should contain machine name header
    expect(frame).toContain('test-machine');
    // Should contain workspace name
    expect(frame).toContain('my-workspace');
    // Should contain new session action
    expect(frame).toContain('New Session');
  });

  it('renders empty state when isEmpty is true', async () => {
    const props = makeTuiProps({ isEmpty: true, items: [] });

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <SpacesBrowserTUI {...props} />,
      { width: 80, height: 24 }
    );
    destroyRenderer = () => renderer.destroy();

    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain('No workspaces found');
  });

  it('shows selection indicator on selected item', async () => {
    const items: TreeItemWithState[] = [
      makeWorkspaceItem({ isSelected: true, index: 0 }),
      makeSessionItem({ index: 1 }),
      makeNewSessionItem(),
    ];

    const props = makeTuiProps({ items, selectedIndex: 0 });

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <SpacesBrowserTUI {...props} />,
      { width: 80, height: 24 }
    );
    destroyRenderer = () => renderer.destroy();

    await renderOnce();
    const frame = captureCharFrame();

    // Selected workspace should show '>' prefix
    expect(frame).toContain('>');
    expect(frame).toContain('my-workspace');
  });

  it('renders process items with status indicators', async () => {
    const items: TreeItemWithState[] = [
      makeWorkspaceItem(),
      {
        type: 'process',
        processName: 'web-server',
        instance: 1,
        workspaceId: 'ws-1',
        status: 'running',
        ports: [{ port: 3000, name: 'http', protocol: 'http' as const }],
        isSelected: false,
        index: 1,
      },
      {
        type: 'process',
        processName: 'worker',
        instance: 1,
        workspaceId: 'ws-1',
        status: 'stopped',
        isSelected: false,
        index: 2,
      },
      {
        type: 'process',
        processName: 'crasher',
        instance: 1,
        workspaceId: 'ws-1',
        status: 'failed',
        isSelected: false,
        index: 3,
      },
      makeNewSessionItem(),
    ];

    const props = makeTuiProps({ items });

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <SpacesBrowserTUI {...props} />,
      { width: 80, height: 24 }
    );
    destroyRenderer = () => renderer.destroy();

    await renderOnce();
    const frame = captureCharFrame();

    // Process names should be visible in the frame
    expect(frame).toContain('web-server');
    expect(frame).toContain('worker');
    expect(frame).toContain('crasher');
  });

  it('renders events item', async () => {
    const items: TreeItemWithState[] = [
      makeWorkspaceItem(),
      {
        type: 'events',
        workspaceId: 'ws-1',
        isSelected: false,
        index: 1,
      },
      makeNewSessionItem(),
    ];

    const props = makeTuiProps({ items });

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <SpacesBrowserTUI {...props} />,
      { width: 80, height: 24 }
    );
    destroyRenderer = () => renderer.destroy();

    await renderOnce();
    const frame = captureCharFrame();

    // Events row should show something identifiable
    expect(frame).toContain('Events');
  });
});
