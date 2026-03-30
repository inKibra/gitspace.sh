import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import type { AppClient } from '../client/index.js';
import { useLifecycleActions } from './useLifecycleActions.js';

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

function makeClient(): AppClient {
  return {
    agentSessions: {} as any,
    workspaceLifecycle: {} as any,
    processes: {} as any,
    inbox: {} as any,
    bundles: {} as any,
    replayReview: {} as any,
    sessions: {} as any,
    lifecycle: {
      listGithubRepos: mock(async () => ({ ok: true as const, value: ['acme/repo'] })),
      listRemoteBranches: mock(async () => ({ ok: true as const, value: ['main'] })),
      listLinearIssues: mock(async () => ({ ok: true as const, value: [] })),
      createProject: mock(async () => ({ ok: true as const, value: { repository: 'acme/repo' } })),
      prepareProjectCreation: mock(async () => ({ ok: true as const, value: { projectName: 'repo', repository: 'acme/repo', baseBranch: 'main' } })),
      finalizeProjectCreation: mock(async () => ({ ok: true as const, value: { projectName: 'repo', repository: 'acme/repo', baseBranch: 'main' } })),
      cancelProjectCreation: mock(async () => ({ ok: true as const, value: { projectName: 'repo' } })),
      createWorkspace: mock(async () => ({ ok: true as const, value: { projectName: 'acme', workspaceName: 'feat' } })),
      deleteProject: mock(async () => ({ ok: true as const, value: { projectName: 'acme' } })),
    },
  } as AppClient;
}

describe('useLifecycleActions', () => {
  it('exposes lifecycle controller API through app/react', () => {
    const client = makeClient();
    const { result } = renderHook(() => useLifecycleActions({
      client,
      backendKey: 'local',
      flow: { showLoading: () => undefined, showSelect: () => undefined, showInput: () => undefined, showConfirmTyped: () => undefined, showMessage: () => undefined, showWizard: () => undefined, close: () => undefined },
      getProjectNames: () => ['acme'],
    }));
    expect(typeof result.current.openCreateProjectFlow).toBe('function');
    expect(typeof result.current.openCreateWorkspaceFlow).toBe('function');
  });
});