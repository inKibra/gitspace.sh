import { describe, expect, it, mock } from 'bun:test';
import { attachWorkspaceSession } from '../attach-workspace-session.js';
import { buildWorkspaceSessionEnv } from '../workspace-shell-hooks.js';

describe('attachWorkspaceSession command sessions', () => {
  it('injects workspace session env vars for direct command attaches', async () => {
    const createSession = mock(async () => ({
      id: 'session-1',
      name: 'acme:feature-1:1',
      socketPath: '/tmp/session.sock',
      pid: 123,
      attached: false,
      cwd: '/tmp/acme/feature-1',
      createdAt: Date.now(),
    }));
    const prepareWorkspaceForSession = mock(async () => ({ success: true as const }));

    const result = await attachWorkspaceSession({
      scanWorkspaces: async () => [{
        id: 'feature-1',
        path: '/tmp/acme/feature-1',
        projectName: 'acme',
      }],
      listSessions: async () => [],
      createSession,
      prepareWorkspaceForSession,
    }, {
      workspaceId: 'acme:feature-1',
      command: 'gssh',
      args: ['space', 'commit'],
      env: { EXTRA_FLAG: '1' },
    });

    expect(result.workspace).toEqual({
      id: 'feature-1',
      path: '/tmp/acme/feature-1',
      projectName: 'acme',
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      'acme:feature-1:1',
      '/tmp/acme/feature-1',
      {
        command: 'gssh',
        args: ['space', 'commit'],
        env: {
          // Mirrors buildWorkspaceSessionEnv: GITSPACE_WORKSPACE_ROOT propagates
          // the resolved workspace root into the session. Computed, not
          // hardcoded, because it follows HOME/GITSPACE_WORKSPACE_ROOT.
          ...buildWorkspaceSessionEnv('acme', 'feature-1'),
          EXTRA_FLAG: '1',
        },
      },
    );
    expect(prepareWorkspaceForSession).not.toHaveBeenCalled();
  });
});

describe('attachWorkspaceSession skip policy', () => {
  it('uses skip bundle mode when scriptPolicy is skip', async () => {
    const prepareWorkspaceForSession = mock(async () => ({ success: true as const }));
    const createSession = mock(async () => ({
      id: 'session-2',
      name: 'acme:feature-1:1',
      socketPath: '/tmp/session-2.sock',
      pid: 456,
      attached: false,
      cwd: '/tmp/acme/feature-1',
      createdAt: Date.now(),
    }));

    await attachWorkspaceSession({
      scanWorkspaces: async () => [{
        id: 'feature-1',
        path: '/tmp/acme/feature-1',
        projectName: 'acme',
      }],
      listSessions: async () => [],
      createSession,
      prepareWorkspaceForSession,
    }, {
      workspaceId: 'acme:feature-1',
      scriptPolicy: 'skip',
    });

    expect(prepareWorkspaceForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'acme',
        workspaceName: 'feature-1',
        bundleMode: 'skip',
        scriptPolicy: 'skip',
      })
    );
  });
});
