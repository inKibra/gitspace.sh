import { describe, expect, it } from 'bun:test';
import {
  buildWorkspaceDetailStripDisplayItems,
  getVisibleWorkspaceDetailStripWorkspaces,
  getWorkspaceStripColor,
} from './strip.js';

const workspaceA = {
  id: 'ws-1',
  selectionKey: 'local:ws-1',
  name: 'ws-1',
  projectName: 'demo',
};

const workspaceB = {
  id: 'ws-2',
  selectionKey: 'local:ws-2',
  name: 'ws-2',
  projectName: 'demo',
};

describe('workspace detail strip', () => {
  it('reads strip colors from selection keys when provided', () => {
    const statusById = {
      'local:ws-2': { primaryColor: 'blue' as const },
    };

    expect(getWorkspaceStripColor(workspaceB, statusById)).toBe('blue');
  });

  it('keeps the current workspace visible when current id is a selection key', () => {
    const visible = getVisibleWorkspaceDetailStripWorkspaces({
      workspaces: [workspaceA, workspaceB],
      currentWorkspaceId: 'local:ws-1',
      workspaceStatusById: {
        'local:ws-2': { primaryColor: 'blue' as const },
      },
    });

    expect(visible.map((workspace) => workspace.id)).toEqual(['ws-1', 'ws-2']);
  });

  it('builds display items using selection-key status ordering', () => {
    const items = buildWorkspaceDetailStripDisplayItems({
      workspaces: [workspaceA, workspaceB],
      currentWorkspaceId: 'local:ws-1',
      workspaceStatusById: {
        'local:ws-2': { primaryColor: 'blue' as const },
      },
    });

    expect(items.filter((item) => item.type === 'workspace').map((item) => item.workspace.id)).toEqual(['ws-1', 'ws-2']);
  });
});
