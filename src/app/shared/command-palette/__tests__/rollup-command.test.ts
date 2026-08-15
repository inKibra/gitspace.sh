/**
 * Roll up sits next to Delete.
 *
 * Deleting a workspace now deletes its artifacts branch, so the action that
 * keeps that work has to be reachable from the same place as the one that
 * destroys it — not only from the project page.
 */
import { describe, expect, it } from 'bun:test';
import { resolveSharedCommand } from '../commands.js';
import { COMMAND_PALETTE_COMMAND_DEFS } from '../../../workspaces/commandPaletteCommands.js';

const workspace = { id: 'w1', name: 'feat-a', projectName: 'proj', selectionKey: 'local:w1' };

describe('rollup-workspace command', () => {
  it('is registered and listed immediately before Delete Workspace', () => {
    const ids = COMMAND_PALETTE_COMMAND_DEFS.map((c) => c.id);
    const rollup = ids.indexOf('rollup-workspace');
    const del = ids.indexOf('delete-workspace');
    expect(rollup).toBeGreaterThanOrEqual(0);
    // Adjacency is the point: the safe alternative must be beside the
    // destructive action, not buried elsewhere in the list.
    expect(del - rollup).toBe(1);
  });

  it('resolves to the selected workspace', () => {
    expect(resolveSharedCommand('rollup-workspace', { workspace, projectName: 'proj' }))
      .toEqual({ kind: 'rollup-workspace', workspace });
  });

  it('reports a missing selection rather than rolling up nothing', () => {
    expect(resolveSharedCommand('rollup-workspace', { workspace: null, projectName: 'proj' }))
      .toEqual({ kind: 'missing-workspace' });
  });
});
