import { describe, expect, it } from 'bun:test';
import { resolveSelectedWorkspace } from './workspace-selection.js';

const workspaces = [
  {
    id: 'proj:alpha',
    selectionKey: '["local","proj:alpha"]',
    projectName: 'proj',
  },
  {
    id: 'proj:beta',
    selectionKey: '["remote","proj:beta"]',
    projectName: 'proj',
  },
];

describe('resolveSelectedWorkspace', () => {
  it('matches board selections by backend-scoped selection key', () => {
    expect(resolveSelectedWorkspace({
      selectedBoardWorkspaceId: '["remote","proj:beta"]',
      workspaces,
    })).toEqual(workspaces[1]);
  });

  it('still matches detail selections by raw workspace id', () => {
    expect(resolveSelectedWorkspace({
      selectedDetailWorkspaceId: 'proj:alpha',
      workspaces,
    })).toEqual(workspaces[0]);
  });
});
