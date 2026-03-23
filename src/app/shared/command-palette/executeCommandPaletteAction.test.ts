import { describe, expect, it, mock } from 'bun:test';
import { executeCommandPaletteAction } from './executeCommandPaletteAction.js';

function createWorkspace() {
  return {
    id: 'demo',
    name: 'Demo',
    path: '/tmp/demo',
    projectName: 'proj',
    sessionCount: 0,
    processes: [{ name: 'web', ports: [{ name: 'app', port: 3000, protocol: 'http' as const }] }],
  };
}

function createHandlers() {
  return {
    showSelect: mock(() => undefined),
    showMessage: mock(() => undefined),
    onOpenUrl: mock(() => undefined),
    onAddRepo: mock(() => undefined),
    onAddWorkspace: mock(() => undefined),
    onSetStatus: mock(() => undefined),
    onDeleteWorkspace: mock(() => undefined),
    onEditBundleConfig: mock(() => undefined),
    onEditProcessConfig: mock(() => undefined),
    onDeleteRepo: mock(() => undefined),
    onOpenGitHubPr: mock(() => undefined),
    onOpenReview: mock(() => undefined),
  };
}

describe('executeCommandPaletteAction', () => {
  it('shows missing workspace message for open-service', () => {
    const handlers = createHandlers();

    executeCommandPaletteAction({
      commandId: 'open-service',
      workspace: null,
      projectName: 'proj',
      ...handlers,
    });

    expect(handlers.showMessage).toHaveBeenCalledTimes(1);
  });

  it('runs shared open-service flow for selected workspace', () => {
    const handlers = createHandlers();

    executeCommandPaletteAction({
      commandId: 'open-service',
      workspace: createWorkspace(),
      projectName: 'proj',
      ...handlers,
    });

    expect(handlers.showSelect).toHaveBeenCalledTimes(1);
    const firstCall = (handlers.showSelect as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(firstCall?.[0]).toMatchObject({ title: 'Demo web#1' });
  });
});
