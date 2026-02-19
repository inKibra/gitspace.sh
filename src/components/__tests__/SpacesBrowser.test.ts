/**
 * SpacesBrowser hook tests
 *
 * Validates tree building, process/events item generation,
 * and activateSelected behavior for all item types.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import {
  useSpacesBrowser,
  type WorkspaceInfo,
  type SessionInfo,
  type UseSpacesBrowserProps,
} from '../SpacesBrowser.js';

// ============================================================================
// happy-dom setup (required for renderHook)
// ============================================================================

const domWindow = new Window();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

beforeAll(() => {
  // @ts-expect-error test DOM setup
  globalThis.window = domWindow;
  // @ts-expect-error test DOM setup
  globalThis.document = domWindow.document;
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

// ============================================================================
// Fixtures
// ============================================================================

function makeWorkspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: 'ws-1',
    name: 'my-workspace',
    path: '/home/user/gitspace/proj/workspaces/my-workspace',
    projectName: 'proj',
    branch: 'main',
    sessionCount: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    name: 'proj:my-workspace:default',
    workspaceId: 'ws-1',
    attached: false,
    createdAt: Date.now() - 60000,
    ...overrides,
  };
}

function makeProps(overrides: Partial<UseSpacesBrowserProps> = {}): UseSpacesBrowserProps {
  return {
    workspaces: [],
    sessions: [],
    onRequestSessions: mock(() => {}),
    onAttachSession: mock(async () => {}),
    onStartProcess: mock(() => {}),
    onStartProcessAttach: mock(() => {}),
    onStopProcess: mock(() => {}),
    onOpenEvents: mock(() => {}),
    onRefresh: mock(async () => {}),
    onBack: mock(() => {}),
    showProjectHeaders: false,
    ...overrides,
  };
}

// ============================================================================
// Tree building
// ============================================================================

describe('useSpacesBrowser tree building', () => {
  it('builds empty tree for no workspaces', () => {
    const props = makeProps();
    const { result } = renderHook(() => useSpacesBrowser(props));

    expect(result.current.isEmpty).toBe(true);
    expect(result.current.items).toHaveLength(0);
  });

  it('builds workspace items (collapsed)', () => {
    const ws = makeWorkspace();
    const props = makeProps({ workspaces: [ws] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].type).toBe('workspace');
  });

  it('shows sessions, events, and new-session when expanded', () => {
    const ws = makeWorkspace({ sessionCount: 1 });
    const session = makeSession();
    const props = makeProps({ workspaces: [ws], sessions: [session] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Expand the workspace
    act(() => { result.current.toggleWorkspace('ws-1'); });

    const types = result.current.items.map((item) => item.type);
    expect(types).toContain('workspace');
    expect(types).toContain('session');
    expect(types).toContain('events');
    expect(types).toContain('new-session');
  });

  it('includes process items when workspace has processes configured', () => {
    const ws = makeWorkspace({
      sessionCount: 0,
      processes: [
        { name: 'web-server', instances: 1, ports: [{ port: 3000, name: 'http', protocol: 'http' }] },
        { name: 'worker', instances: 2 },
      ],
    });
    const props = makeProps({ workspaces: [ws] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Expand
    act(() => { result.current.toggleWorkspace('ws-1'); });

    const processItems = result.current.items.filter((item) => item.type === 'process');
    // web-server has 1 instance, worker has 2 instances = 3 process items
    expect(processItems).toHaveLength(3);

    const names = processItems.map((item) =>
      item.type === 'process' ? `${item.processName}#${item.instance}` : ''
    );
    expect(names).toContain('web-server#1');
    expect(names).toContain('worker#1');
    expect(names).toContain('worker#2');
  });

  it('derives process status from sessions', () => {
    const ws = makeWorkspace({
      sessionCount: 1,
      processes: [{ name: 'web-server', instances: 1 }],
    });
    const session = makeSession({
      id: 'proc-sess-1',
      name: 'proc:ws-1:web-server:1',
      processName: 'web-server',
      processInstance: 1,
    });
    const props = makeProps({ workspaces: [ws], sessions: [session] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    act(() => { result.current.toggleWorkspace('ws-1'); });

    const processItem = result.current.items.find(
      (item) => item.type === 'process' && item.processName === 'web-server'
    );
    expect(processItem).toBeDefined();
    expect(processItem!.type === 'process' && processItem!.status).toBe('running');
  });

  it('marks process as failed when session has non-zero exitCode', () => {
    const ws = makeWorkspace({
      sessionCount: 1,
      processes: [{ name: 'crasher' }],
    });
    const session = makeSession({
      id: 'proc-sess-crash',
      name: 'proc:ws-1:crasher:1',
      processName: 'crasher',
      processInstance: 1,
      exitCode: 1,
    });
    const props = makeProps({ workspaces: [ws], sessions: [session] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    act(() => { result.current.toggleWorkspace('ws-1'); });

    const processItem = result.current.items.find(
      (item) => item.type === 'process' && item.processName === 'crasher'
    );
    expect(processItem).toBeDefined();
    expect(processItem!.type === 'process' && processItem!.status).toBe('failed');
  });

  it('prefers running session status over older exited sessions for same process instance', () => {
    const ws = makeWorkspace({
      sessionCount: 2,
      processes: [{ name: 'web-server', instances: 1 }],
    });
    const olderExited = makeSession({
      id: 'proc-old',
      name: 'a-old-exited',
      processName: 'web-server',
      processInstance: 1,
      exitCode: 1,
      createdAt: Date.now() - 120_000,
    });
    const newerRunning = makeSession({
      id: 'proc-new',
      name: 'z-new-running',
      processName: 'web-server',
      processInstance: 1,
      createdAt: Date.now() - 5_000,
    });
    const props = makeProps({ workspaces: [ws], sessions: [olderExited, newerRunning] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    act(() => { result.current.toggleWorkspace('ws-1'); });

    const processItem = result.current.items.find(
      (item) => item.type === 'process' && item.processName === 'web-server'
    );
    expect(processItem).toBeDefined();
    expect(processItem!.type === 'process' && processItem!.status).toBe('running');
  });

  it('always includes events item under expanded workspace', () => {
    const ws = makeWorkspace();
    const props = makeProps({ workspaces: [ws] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    act(() => { result.current.toggleWorkspace('ws-1'); });

    const eventsItem = result.current.items.find((item) => item.type === 'events');
    expect(eventsItem).toBeDefined();
    if (eventsItem && eventsItem.type === 'events') {
      expect(eventsItem.workspaceId).toBe('ws-1');
    }
  });
});

// ============================================================================
// activateSelected behavior
// ============================================================================

describe('useSpacesBrowser activateSelected', () => {
  it('toggles workspace on activate', async () => {
    const ws = makeWorkspace();
    const props = makeProps({ workspaces: [ws] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Workspace is at index 0, selected by default
    expect(result.current.selectedItem?.type).toBe('workspace');

    await act(async () => { await result.current.activateSelected(); });

    // Should have expanded (now shows children)
    expect(result.current.items.length).toBeGreaterThan(1);
  });

  it('attaches session on activate', async () => {
    const ws = makeWorkspace({ sessionCount: 1 });
    const session = makeSession();
    const onAttachSession = mock(async () => {});
    const props = makeProps({ workspaces: [ws], sessions: [session], onAttachSession });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Expand workspace
    act(() => { result.current.toggleWorkspace('ws-1'); });

    // Navigate to session item
    const sessionIndex = result.current.items.findIndex((item) => item.type === 'session');
    act(() => { result.current.selectIndex(sessionIndex); });

    await act(async () => { await result.current.activateSelected(); });

    expect(onAttachSession).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('calls onOpenEvents when events item is activated', async () => {
    const ws = makeWorkspace();
    const onOpenEvents = mock(() => {});
    const props = makeProps({ workspaces: [ws], onOpenEvents });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Expand workspace
    act(() => { result.current.toggleWorkspace('ws-1'); });

    // Navigate to events item
    const eventsIndex = result.current.items.findIndex((item) => item.type === 'events');
    act(() => { result.current.selectIndex(eventsIndex); });

    await act(async () => { await result.current.activateSelected(); });

    expect(onOpenEvents).toHaveBeenCalledWith('ws-1');
  });

  it('calls onEditProcesses when edit-processes item is activated', async () => {
    const ws = makeWorkspace();
    const onEditProcesses = mock(() => {});
    const props = makeProps({ workspaces: [ws], onEditProcesses });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Expand workspace
    act(() => { result.current.toggleWorkspace('ws-1'); });

    // Navigate to edit-processes item
    const editIndex = result.current.items.findIndex((item) => item.type === 'edit-processes');
    expect(editIndex).toBeGreaterThanOrEqual(0);
    act(() => { result.current.selectIndex(editIndex); });

    await act(async () => { await result.current.activateSelected(); });

    expect(onEditProcesses).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
  });

  it('edit-processes item appears before events item in expanded workspace', () => {
    const ws = makeWorkspace();
    const props = makeProps({ workspaces: [ws] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    act(() => { result.current.toggleWorkspace('ws-1'); });

    const types = result.current.items.map((item) => item.type);
    const editIdx = types.indexOf('edit-processes');
    const eventsIdx = types.indexOf('events');
    expect(editIdx).toBeGreaterThanOrEqual(0);
    expect(eventsIdx).toBeGreaterThanOrEqual(0);
    expect(editIdx).toBeLessThan(eventsIdx);
  });

  it('shows process-config-error item and routes activation to edit config', async () => {
    const ws = makeWorkspace({ processConfigError: 'Invalid config' });
    const onEditProcesses = mock(() => {});
    const props = makeProps({ workspaces: [ws], onEditProcesses });
    const { result } = renderHook(() => useSpacesBrowser(props));

    act(() => { result.current.toggleWorkspace('ws-1'); });

    const errorIndex = result.current.items.findIndex((item) => item.type === 'process-config-error');
    expect(errorIndex).toBeGreaterThanOrEqual(0);

    act(() => { result.current.selectIndex(errorIndex); });
    await act(async () => { await result.current.activateSelected(); });

    expect(onEditProcesses).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
  });

  it('calls onStartProcessAttach when stopped process is activated', async () => {
    const ws = makeWorkspace({
      processes: [{ name: 'web-server' }],
    });
    const onStartProcessAttach = mock(() => {});
    const props = makeProps({ workspaces: [ws], onStartProcessAttach });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Expand workspace
    act(() => { result.current.toggleWorkspace('ws-1'); });

    // Navigate to process item (should be stopped since no matching session)
    const processIndex = result.current.items.findIndex((item) => item.type === 'process');
    act(() => { result.current.selectIndex(processIndex); });

    await act(async () => { await result.current.activateSelected(); });

    expect(onStartProcessAttach).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      processName: 'web-server',
      instance: 1,
    });
  });

  it('attaches to session when running process is activated', async () => {
    const ws = makeWorkspace({
      sessionCount: 1,
      processes: [{ name: 'web-server' }],
    });
    const session = makeSession({
      id: 'proc-sess-1',
      processName: 'web-server',
      processInstance: 1,
    });
    const onAttachSession = mock(async () => {});
    const props = makeProps({ workspaces: [ws], sessions: [session], onAttachSession });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // Expand workspace
    act(() => { result.current.toggleWorkspace('ws-1'); });

    // Navigate to process item (should be running)
    const processIndex = result.current.items.findIndex((item) => item.type === 'process');
    act(() => { result.current.selectIndex(processIndex); });

    await act(async () => { await result.current.activateSelected(); });

    expect(onAttachSession).toHaveBeenCalledWith({ sessionId: 'proc-sess-1', viewOnly: true });
  });
});

// ============================================================================
// Navigation
// ============================================================================

describe('useSpacesBrowser navigation', () => {
  it('clamps selection when tree shrinks', () => {
    const ws1 = makeWorkspace({ id: 'ws-1', name: 'alpha' });
    const ws2 = makeWorkspace({ id: 'ws-2', name: 'beta' });
    const props = makeProps({ workspaces: [ws1, ws2] });
    const { result, rerender } = renderHook(
      ({ p }) => useSpacesBrowser(p),
      { initialProps: { p: props } }
    );

    // Select last item
    act(() => { result.current.selectIndex(1); });
    expect(result.current.selectedIndex).toBe(1);

    // Remove a workspace - tree shrinks
    const newProps = makeProps({ workspaces: [ws1] });
    rerender({ p: newProps });

    expect(result.current.selectedIndex).toBeLessThanOrEqual(result.current.items.length - 1);
  });

  it('moveUp/moveDown respects bounds', () => {
    const ws1 = makeWorkspace({ id: 'ws-1', name: 'alpha' });
    const ws2 = makeWorkspace({ id: 'ws-2', name: 'beta' });
    const props = makeProps({ workspaces: [ws1, ws2] });
    const { result } = renderHook(() => useSpacesBrowser(props));

    // At 0, moveUp stays at 0
    act(() => { result.current.moveUp(); });
    expect(result.current.selectedIndex).toBe(0);

    // Move to end
    act(() => { result.current.moveDown(); });
    expect(result.current.selectedIndex).toBe(1);

    // At end, moveDown stays
    act(() => { result.current.moveDown(); });
    expect(result.current.selectedIndex).toBe(1);
  });
});
