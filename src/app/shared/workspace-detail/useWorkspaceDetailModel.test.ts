import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import { useWorkspaceDetailModel } from './useWorkspaceDetailModel.js';
import type { WorkspaceInfo } from '../../../components/SpacesBrowser.js';

const domWindow = new Window();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;

function makeWorkspace(): WorkspaceInfo {
  return {
    id: 'ws-1',
    name: 'feature-1',
    path: '/tmp/acme/feature-1',
    projectName: 'acme',
    sessionCount: 0,
    processes: [],
  };
}

beforeAll(() => {
  globalThis.window = domWindow as unknown as typeof globalThis.window;
  globalThis.document = domWindow.document as unknown as typeof globalThis.document;
  globalThis.navigator = domWindow.navigator as unknown as typeof globalThis.navigator;
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.navigator = originalNavigator;
});

describe('useWorkspaceDetailModel commit action', () => {
  it('includes a commit footer action and routes it to the workspace callback', async () => {
    const onLaunchCommit = mock(async () => undefined);

    const { result } = renderHook(() => useWorkspaceDetailModel({
      workspace: makeWorkspace(),
      sessions: [],
      replays: [],
      actions: { onLaunchCommit },
    }));

    expect(result.current.footerActions.some((action) => action.id === 'launch-commit')).toBe(true);

    await act(async () => {
      await result.current.actions.footerAction('launch-commit');
    });

    expect(onLaunchCommit).toHaveBeenCalledTimes(1);
    expect(onLaunchCommit).toHaveBeenCalledWith('ws-1');
  });
});

describe('useWorkspaceDetailModel footer ordering', () => {
  it('keeps review and config actions in the expected order', () => {
    const { result } = renderHook(() => useWorkspaceDetailModel({
      workspace: makeWorkspace(),
      sessions: [],
      replays: [],
      actions: {},
    }));

    expect(result.current.footerActions.map((action) => action.id)).toEqual([
      'open-review',
      'launch-commit',
      'edit-bundle-config',
      'edit-process-config',
      'change-status',
    ]);
  });
});
