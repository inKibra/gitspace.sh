import { describe, expect, it } from 'bun:test';
import { LocalSessionBackend, type LocalSessionBackendDependencies } from '../backends/local-session-backend';
import type { BackendEvent } from '../events';
import type { NotificationConfig } from '../../notifications/types';

const notificationConfig: NotificationConfig = {
  enabled: true,
  minCommandDurationMs: 1000,
  types: {
    exit: true,
    idle: true,
    bell: true,
    title: true,
    osc: true,
  },
  toast: {
    enabled: true,
    holdWhenIdleMs: 5000,
  },
};

describe('LocalSessionBackend', () => {
  it('emits local project/workspace/session/inbox and attach events', async () => {
    const createdSessions: Array<{ name: string; cwd: string }> = [];
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [
        {
          name: 'alpha',
          repository: 'org/alpha',
          workspaceCount: 1,
          isCurrent: true,
        },
      ],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          branch: 'main',
          sessionCount: 0,
          isStale: false,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async (name, cwd) => {
        createdSessions.push({ name, cwd });
        return {
          id: 'sess-new',
          name,
          socketPath: '/tmp/socket-new',
          pid: 456,
          attached: false,
          cwd,
          createdAt: 456,
        };
      },
      prepareWorkspaceForSession: async (options) => {
        options.onPhaseStart?.('pre');
        options.onOutput?.(Buffer.from('pre-output'));
        options.onPhaseStart?.('setup');
        options.onOutput?.(Buffer.from('setup-output'));
        options.onPhaseStart?.('select');
        options.onOutput?.(Buffer.from('select-output'));
        return { success: true };
      },
      getInbox: async () => [
        {
          id: 'inbox-1',
          sessionId: 'sess-1',
          sessionName: 'alpha:ws-1:1',
          type: 'bell',
          timestamp: Date.now(),
          context: 'ding',
          read: false,
        },
      ],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: (updates) => ({
        ...notificationConfig,
        ...updates,
      }),
      connectSessionSocket: async (_socketPath, handlers) => {
        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = new LocalSessionBackend({
      descriptor: {
        key: 'local',
        kind: 'local',
        label: 'Local',
      },
      deps,
    });

    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.listProjects();
    await backend.listWorkspaces();
    await backend.listSessions();
    await backend.requestInbox();
    await backend.getNotificationConfig();
    await backend.attachSession({ workspaceId: 'ws-1' });

    expect(events).toContainEqual({ type: 'status', status: 'connected' });
    expect(events).toContainEqual({
      type: 'projects',
      projects: [
        {
          name: 'alpha',
          repository: 'org/alpha',
          workspaceCount: 1,
          isCurrent: true,
        },
      ],
    });

    expect(events).toContainEqual({
      type: 'sessions',
      sessions: [
        expect.objectContaining({
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          workspaceId: 'alpha:ws-1',
          attached: false,
          createdAt: 123,
          processTitle: undefined,
          exitCode: undefined,
          socketPath: '/tmp/socket-1',
          cwd: '/tmp/ws-1',
          pid: 123,
        }),
      ],
    });

    expect(events).toContainEqual({
      type: 'inbox',
      items: [
        expect.objectContaining({
          id: 'inbox-1',
          sessionId: 'sess-1',
          read: false,
        }),
      ],
      unreadCount: 1,
    });

    expect(events).toContainEqual({
      type: 'notification_config',
      config: notificationConfig,
    });

    expect(events).toContainEqual({
      type: 'attached',
      sessionId: 'sess-new',
      sessionName: 'alpha:ws-1:2',
      viewOnly: false,
    });

    const scriptStreamChunks = events
      .filter((event): event is Extract<BackendEvent, { type: 'script_output' }> =>
        event.type === 'script_output' && !event.done && event.data.length > 0
      )
      .map((event) => new TextDecoder().decode(event.data));

    expect(scriptStreamChunks).toEqual([
      '\r\n==> pre scripts...\r\n',
      'pre-output',
      '\r\n==> setup scripts...\r\n',
      'setup-output',
      '\r\n==> select scripts...\r\n',
      'select-output',
    ]);

    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'select',
      data: new Uint8Array(0),
      done: true,
    });

    expect(createdSessions).toEqual([
      {
        name: 'alpha:ws-1:2',
        cwd: '/tmp/ws-1',
      },
    ]);
  });

  it('does not include saved filters in workspace list payloads', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 0,
        },
      ],
      listSessions: async () => [],
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.listWorkspaces();

    const workspaceEvent = events.find((event) => event.type === 'workspaces');
    expect(workspaceEvent).toBeDefined();
    if (workspaceEvent && workspaceEvent.type === 'workspaces') {
      expect('savedEventFilters' in workspaceEvent).toBe(false);
    }
  });

  it('streams PTY data and control frames through local socket transport', async () => {
    const events: BackendEvent[] = [];
    const sentControls: Array<{
      type: string;
      cols?: number;
      rows?: number;
      clientType?: 'cli' | 'web';
    }> = [];
    const sentPty: Uint8Array[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => ({
        sendControl: (control) => {
          sentControls.push(control);
          if (control.type === 'attach-init') {
            handlers.onControl({ type: 'attached' });
          }
          if (control.type === 'detach') {
            handlers.onClose();
          }
        },
        sendPty: (data) => {
          sentPty.push(data);
        },
        close: () => {
          handlers.onClose();
        },
      }),
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1', cols: 120, rows: 40 });
    await backend.writePtyData(new Uint8Array([0x41]));
    await backend.resizePty(100, 30);
    await backend.detachSession();

    expect(sentControls).toContainEqual({ type: 'attach-init', cols: 120, rows: 40, clientType: 'cli' });
    expect(sentControls).toContainEqual({ type: 'resize', cols: 100, rows: 30 });
    expect(sentControls).toContainEqual({ type: 'detach' });
    expect(sentPty).toEqual([new Uint8Array([0x41])]);
    expect(events).toContainEqual({ type: 'attached', sessionId: 'sess-1', sessionName: 'alpha:ws-1:1', viewOnly: false });
    expect(events).toContainEqual({ type: 'detached' });
  });

  it('buffers PTY output while no callback is registered and flushes on restore', async () => {
    let socketHandlers:
      | {
          onPtyData: (data: Uint8Array) => void;
          onControl: (event: any) => void;
          onClose: () => void;
          onError: (error: Error) => void;
        }
      | undefined;
    const output: string[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        socketHandlers = handlers;
        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onPtyData(new TextEncoder().encode('snapshot-before-handler'));
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    backend.setPtyOutputHandler((data) => {
      output.push(new TextDecoder().decode(data));
    });

    socketHandlers?.onPtyData(new TextEncoder().encode('live-after-handler'));

    expect(output).toEqual(['snapshot-before-handler', 'live-after-handler']);
  });

  it('re-buffers PTY output after callback is cleared and flushes on re-register', async () => {
    let socketHandlers:
      | {
          onPtyData: (data: Uint8Array) => void;
          onControl: (event: any) => void;
          onClose: () => void;
          onError: (error: Error) => void;
        }
      | undefined;
    const callbackOneOutput: string[] = [];
    const callbackTwoOutput: string[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        socketHandlers = handlers;
        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    await backend.connect();

    backend.setPtyOutputHandler((data) => {
      callbackOneOutput.push(new TextDecoder().decode(data));
    });

    await backend.attachSession({ sessionId: 'sess-1' });

    socketHandlers?.onPtyData(new TextEncoder().encode('before-clear'));
    backend.setPtyOutputHandler(null);
    socketHandlers?.onPtyData(new TextEncoder().encode('while-cleared'));

    backend.setPtyOutputHandler((data) => {
      callbackTwoOutput.push(new TextDecoder().decode(data));
    });
    socketHandlers?.onPtyData(new TextEncoder().encode('after-restore'));

    expect(callbackOneOutput).toEqual(['before-clear']);
    expect(callbackTwoOutput).toEqual(['while-cleared', 'after-restore']);
  });

  it('handles attach/detach/reattach sequencing without losing attach snapshot output', async () => {
    let attachAttempt = 0;
    const handlersByAttempt: Array<{
      onPtyData: (data: Uint8Array) => void;
      onControl: (event: any) => void;
      onClose: () => void;
      onError: (error: Error) => void;
    }> = [];
    const firstAttachOutput: string[] = [];
    const secondAttachOutput: string[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        attachAttempt += 1;
        handlersByAttempt.push(handlers);

        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onPtyData(
                new TextEncoder().encode(
                  attachAttempt === 1 ? 'snapshot-first-attach' : 'snapshot-second-attach'
                )
              );
              handlers.onControl({ type: 'attached' });
              return;
            }

            if (control.type === 'detach') {
              handlers.onClose();
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    await backend.connect();

    backend.setPtyOutputHandler((data) => {
      firstAttachOutput.push(new TextDecoder().decode(data));
    });
    await backend.attachSession({ sessionId: 'sess-1' });

    backend.setPtyOutputHandler(null);
    await backend.detachSession();

    await backend.attachSession({ sessionId: 'sess-1' });

    backend.setPtyOutputHandler((data) => {
      secondAttachOutput.push(new TextDecoder().decode(data));
    });
    handlersByAttempt[1]?.onPtyData(new TextEncoder().encode('live-second-attach'));

    expect(firstAttachOutput).toEqual(['snapshot-first-attach']);
    expect(secondAttachOutput).toEqual(['snapshot-second-attach', 'live-second-attach']);
  });

  it('emits detached when switching sessions and new attach fails', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 2,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
        {
          id: 'sess-2',
          name: 'alpha:ws-1:2',
          socketPath: '/tmp/socket-2',
          pid: 456,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 456,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (socketPath, handlers) => {
        if (socketPath === '/tmp/socket-2') {
          throw new Error('socket connect failed');
        }

        return {
          sendControl: (control) => {
            if (control.type === 'attach-init') {
              handlers.onControl({ type: 'attached' });
            }
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    await expect(backend.attachSession({ sessionId: 'sess-2' })).rejects.toThrow(
      'socket connect failed'
    );

    const attachedEvents = events.filter((event) => event.type === 'attached');
    const detachedEvents = events.filter((event) => event.type === 'detached');

    expect(attachedEvents).toEqual([
      {
        type: 'attached',
        sessionId: 'sess-1',
        sessionName: 'alpha:ws-1:1',
        viewOnly: false,
      },
    ]);
    expect(detachedEvents).toEqual([{ type: 'detached' }]);
  });

  it('retries once when local session socket closes during attach', async () => {
    const events: BackendEvent[] = [];
    let connectAttempts = 0;

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        connectAttempts += 1;
        return {
          sendControl: (control) => {
            if (control.type !== 'attach-init') {
              return;
            }

            if (connectAttempts === 1) {
              handlers.onClose();
              return;
            }

            handlers.onControl({ type: 'attached' });
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    expect(connectAttempts).toBe(2);
    expect(events).toContainEqual({
      type: 'attached',
      sessionId: 'sess-1',
      sessionName: 'alpha:ws-1:1',
      viewOnly: false,
    });
  });

  it('fails fast when attaching to an exited session', async () => {
    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [],
      listSessions: async () => [
        {
          id: 'sess-exited',
          name: 'alpha:ws-1:old',
          socketPath: '/tmp/socket-old',
          pid: 999,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 100,
          exitCode: 1,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async () => {
        throw new Error('should not connect');
      },
    };

    const backend = new LocalSessionBackend({ deps });

    await backend.connect();
    await expect(backend.attachSession({ sessionId: 'sess-exited' })).rejects.toThrow(
      'Session has already exited'
    );
  });

  it('ignores stale close callbacks from previous attach attempt', async () => {
    const handlersByAttempt: Array<{
      onPtyData: (data: Uint8Array) => void;
      onControl: (event: any) => void;
      onClose: () => void;
      onError: (error: Error) => void;
    }> = [];
    let connectAttempts = 0;

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 1,
        },
      ],
      listSessions: async () => [
        {
          id: 'sess-1',
          name: 'alpha:ws-1:1',
          socketPath: '/tmp/socket-1',
          pid: 123,
          attached: false,
          cwd: '/tmp/ws-1',
          createdAt: 123,
        },
      ],
      createSession: async () => {
        throw new Error('not used in this test');
      },
      prepareWorkspaceForSession: async () => ({ success: true }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => {
        connectAttempts += 1;
        handlersByAttempt.push(handlers);

        return {
          sendControl: (control) => {
            if (control.type !== 'attach-init') {
              return;
            }

            if (connectAttempts === 1) {
              handlers.onError(new Error('Local session socket error: transient'));
              return;
            }

            handlers.onControl({ type: 'attached' });
          },
          sendPty: () => {},
          close: () => {
            handlers.onClose();
          },
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    await backend.connect();
    await backend.attachSession({ sessionId: 'sess-1' });

    // Simulate delayed close callback from first (failed) attach attempt.
    handlersByAttempt[0]?.onClose();

    // If stale callback was not ignored, this would throw "No attached local session".
    await expect(backend.writePtyData(new Uint8Array([0x41]))).resolves.toBeUndefined();
  });

  it('emits phase-specific command_error when setup scripts fail', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 0,
        },
      ],
      listSessions: async () => [],
      createSession: async () => {
        throw new Error('should not create session');
      },
      prepareWorkspaceForSession: async () => ({
        success: false,
        phase: 'setup',
        error: 'install failed',
      }),
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async () => {
        throw new Error('should not connect');
      },
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await backend.connect();
    await expect(backend.attachSession({ workspaceId: 'ws-1' })).rejects.toThrow('setup');

    expect(events).toContainEqual({
      type: 'command_error',
      code: 'SETUP_SCRIPT_FAILED',
      message: 'install failed',
    });
  });

  it('skips workspace scripts when scriptPolicy is skip', async () => {
    let prepareCalls = 0;

    const deps: Partial<LocalSessionBackendDependencies> = {
      ensureServer: async () => {},
      listProjectSummaries: () => [],
      scanWorkspaces: async () => [
        {
          id: 'ws-1',
          name: 'ws-1',
          path: '/tmp/ws-1',
          projectName: 'alpha',
          sessionCount: 0,
        },
      ],
      listSessions: async () => [],
      createSession: async () => ({
        id: 'sess-1',
        name: 'alpha:ws-1:1',
        socketPath: '/tmp/socket-1',
        pid: 123,
        attached: false,
        cwd: '/tmp/ws-1',
        createdAt: 100,
      }),
      prepareWorkspaceForSession: async () => {
        prepareCalls += 1;
        return { success: true };
      },
      getInbox: async () => [],
      clearInbox: async () => {},
      markInboxRead: async () => {},
      killSession: async () => {},
      deleteWorkspaceCore: async () => ({
        success: true,
        workspaceName: 'ws-1',
        branchDeleted: false,
        sessionsKilled: 0,
      }),
      getNotificationConfig: () => notificationConfig,
      updateNotificationConfig: () => notificationConfig,
      connectSessionSocket: async (_socketPath, handlers) => ({
        sendControl: (control) => {
          if (control.type === 'attach-init') {
            handlers.onControl({ type: 'attached' });
          }
        },
        sendPty: () => {},
        close: () => {
          handlers.onClose();
        },
      }),
    };

    const backend = new LocalSessionBackend({ deps });
    await backend.connect();
    await backend.attachSession({ workspaceId: 'ws-1', scriptPolicy: 'skip' });

    expect(prepareCalls).toBe(1);
  });

  it('streams remove script output and emits completion when deleting workspace', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      deleteWorkspaceCore: async (_projectName, workspaceId, options) => {
        options?.onScriptOutput?.(Buffer.from(`remove:${workspaceId}`));
        return {
          success: true,
          workspaceName: workspaceId,
          branchDeleted: false,
          sessionsKilled: 0,
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await backend.deleteWorkspace('alpha', 'alpha:ws-1');

    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'remove',
      data: new TextEncoder().encode('remove:ws-1'),
    });
    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'remove',
      data: new Uint8Array(0),
      done: true,
    });
  });

  it('allows retrying delete with scriptPolicy skip after remove script failure', async () => {
    const events: BackendEvent[] = [];
    const observedPolicies: Array<'enforce' | 'best-effort' | 'skip' | undefined> = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      deleteWorkspaceCore: async (_projectName, workspaceId, options) => {
        observedPolicies.push(options?.removeScriptPolicy);
        if (options?.removeScriptPolicy === 'skip') {
          return {
            success: true,
            workspaceName: workspaceId,
            branchDeleted: false,
            sessionsKilled: 0,
          };
        }

        options?.onScriptOutput?.(Buffer.from('cleanup failed'));
        return {
          success: false,
          workspaceName: workspaceId,
          branchDeleted: false,
          sessionsKilled: 0,
          errorCode: 'REMOVE_SCRIPT_FAILED',
          error: 'Remove scripts failed: cleanup failed',
          removeScriptError: 'cleanup failed',
        };
      },
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await expect(backend.deleteWorkspace('alpha', 'ws-1')).rejects.toMatchObject({
      message: 'Remove scripts failed: cleanup failed',
      code: 'REMOVE_SCRIPT_FAILED',
    });

    await expect(
      backend.deleteWorkspace('alpha', 'ws-1', { scriptPolicy: 'skip' })
    ).resolves.toBeUndefined();

    expect(observedPolicies).toEqual(['enforce', 'skip']);
    expect(events).toContainEqual({
      type: 'command_error',
      code: 'REMOVE_SCRIPT_FAILED',
      message: 'Remove scripts failed: cleanup failed',
    });
    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'remove',
      data: new Uint8Array(0),
      done: true,
      error: 'Remove scripts failed: cleanup failed',
    });
  });

  it('preserves workspace delete error code and throws typed error', async () => {
    const events: BackendEvent[] = [];

    const deps: Partial<LocalSessionBackendDependencies> = {
      deleteWorkspaceCore: async (_projectName, workspaceId) => ({
        success: false,
        workspaceName: workspaceId,
        branchDeleted: false,
        sessionsKilled: 0,
        errorCode: 'WORKSPACE_NOT_FOUND',
        error: 'Workspace "ws-missing" does not exist',
      }),
    };

    const backend = new LocalSessionBackend({ deps });
    backend.onEvent((event) => events.push(event));

    await expect(backend.deleteWorkspace('alpha', 'ws-missing')).rejects.toMatchObject({
      name: 'WorkspaceDeleteError',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'Workspace "ws-missing" does not exist',
    });

    expect(events).toContainEqual({
      type: 'command_error',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'Workspace "ws-missing" does not exist',
    });
  });
});
