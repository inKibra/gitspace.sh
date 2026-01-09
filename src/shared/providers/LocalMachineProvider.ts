/**
 * LocalMachineProvider
 *
 * MachineProvider implementation for the local machine.
 * Wraps existing TUI state functions and tmux-lite CLI.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { createBufferedSocketWriter } from '../../utils/bun-socket-writer.js';
import {
  getAllProjectNames,
  readProjectConfig,
  getCurrentProject,
  getProjectWorkspacesDir,
} from '../../core/config.js';
import { getWorktreeInfo } from '../../core/git.js';
import {
  listSessions as tmuxListSessions,
  createSession as tmuxCreateSession,
  getInbox as tmuxGetInbox,
  markInboxRead as tmuxMarkInboxRead,
  clearInbox as tmuxClearInbox,
  ensureServer,
  send,
  type Session as TmuxSession,
} from '../../lib/tmux-lite/cli.js';
import type {
  MachineProvider,
  CreateSessionOptions,
  AttachSessionOptions,
  MachineProviderEvent,
  MachineProviderEventHandler,
  EventedMachineProvider,
} from './MachineProvider.js';
import type {
  MachineInfo,
  Project,
  Workspace,
  WorkspaceSession,
  InboxItem,
  SessionStream,
} from '../types.js';

const STALE_DAYS = 30;
const LOCAL_MACHINE_ID = 'local';

/**
 * Convert tmux-lite session to shared WorkspaceSession type
 */
function toWorkspaceSession(session: TmuxSession): WorkspaceSession {
  return {
    id: session.id,
    name: session.name,
    attached: session.attached,
    createdAt: session.createdAt,
    processTitle: session.processTitle,
  };
}

/**
 * LocalMachineProvider - access local machine resources
 *
 * @example
 * ```typescript
 * const provider = new LocalMachineProvider();
 * const projects = await provider.listProjects();
 * const workspaces = await provider.listWorkspaces('my-project');
 * ```
 */
export class LocalMachineProvider implements EventedMachineProvider {
  private eventHandlers: Set<MachineProviderEventHandler> = new Set();
  private disposed = false;

  /**
   * Get information about the local machine
   */
  async getMachineInfo(): Promise<MachineInfo> {
    return {
      id: LOCAL_MACHINE_ID,
      label: hostname() || 'Local',
      isLocal: true,
      status: 'connected',
    };
  }

  /**
   * List all projects on the local machine
   */
  async listProjects(): Promise<Project[]> {
    const projectNames = getAllProjectNames();
    const currentProject = getCurrentProject();

    return projectNames.map((name) => {
      const config = readProjectConfig(name);
      const workspacesDir = getProjectWorkspacesDir(name);
      let workspaceCount = 0;

      if (existsSync(workspacesDir)) {
        workspaceCount = readdirSync(workspacesDir).filter((entry) => {
          const path = join(workspacesDir, entry);
          return existsSync(path) && readdirSync(path).length > 0;
        }).length;
      }

      return {
        name,
        repository: config.repository,
        workspaceCount,
        isCurrent: name === currentProject,
      };
    });
  }

  /**
   * List workspaces for a project
   */
  async listWorkspaces(projectName: string): Promise<Workspace[]> {
    const workspacesDir = getProjectWorkspacesDir(projectName);

    if (!existsSync(workspacesDir)) {
      return [];
    }

    const workspaceNames = readdirSync(workspacesDir).filter((entry) => {
      const path = join(workspacesDir, entry);
      return existsSync(path) && readdirSync(path).length > 0;
    });

    // Get all tmux-lite sessions
    let allSessions: TmuxSession[] = [];
    try {
      allSessions = await tmuxListSessions();
    } catch {
      // Server might not be running, that's fine
    }

    const workspaces: Workspace[] = [];
    const now = new Date();

    for (const name of workspaceNames) {
      const workspacePath = join(workspacesDir, name);
      const info = await getWorktreeInfo(workspacePath);

      if (info) {
        const daysSinceCommit = Math.floor(
          (now.getTime() - info.lastCommitDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        // Find sessions for this workspace (name pattern: project:workspace:n)
        const sessionPrefix = `${projectName}:${name}:`;
        const workspaceSessions = allSessions
          .filter(s => s.name.startsWith(sessionPrefix))
          .map(toWorkspaceSession);

        workspaces.push({
          name: info.name,
          path: info.path,
          branch: info.branch,
          ahead: info.ahead,
          behind: info.behind,
          uncommittedChanges: info.uncommittedChanges,
          lastCommitDate: info.lastCommitDate,
          isStale: daysSinceCommit > STALE_DAYS,
          sessions: workspaceSessions,
        });
      }
    }

    return workspaces;
  }

  /**
   * Create a new session in a workspace
   */
  async createSession(
    projectName: string,
    workspaceName: string,
    options?: CreateSessionOptions
  ): Promise<string> {
    const workspacesDir = getProjectWorkspacesDir(projectName);
    const workspacePath = join(workspacesDir, workspaceName);

    // Count existing sessions to generate unique name
    let allSessions: TmuxSession[] = [];
    try {
      allSessions = await tmuxListSessions();
    } catch {
      // Ignore
    }

    const sessionPrefix = `${projectName}:${workspaceName}:`;
    const existingCount = allSessions.filter(s => s.name.startsWith(sessionPrefix)).length;
    const sessionName = `${sessionPrefix}${existingCount + 1}`;

    const cwd = options?.cwd ?? workspacePath;
    const session = await tmuxCreateSession(sessionName, cwd);

    return session.id;
  }

  /**
   * Attach to an existing session
   *
   * Returns a SessionStream for terminal I/O.
   * For local sessions, this connects directly to the tmux-lite socket.
   */
  async attachSession(
    sessionId: string,
    options: AttachSessionOptions
  ): Promise<SessionStream> {
    await ensureServer();

    // Get session info
    const sessions = await tmuxListSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Connect to session socket
    const socketPath = session.socketPath;

    return new Promise((resolve, reject) => {
      let dataHandler: ((data: Uint8Array) => void) | null = null;
      let closeHandler: ((exitCode?: number) => void) | null = null;
      let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
      let socketWriter: ReturnType<typeof createBufferedSocketWriter> | null = null;
      let buffer = Buffer.alloc(0);

      const stream: SessionStream = {
        write(data: Uint8Array) {
          if (socket) {
            const { encodePTY } = require('../../lib/tmux-lite/protocol.js');
            const frame = encodePTY(Buffer.from(data));
            if (socketWriter) socketWriter.write(frame);
            else socket.write(frame);
          }
        },
        resize(cols: number, rows: number) {
          if (socket) {
            const { encodeControl } = require('../../lib/tmux-lite/protocol.js');
            const frame = encodeControl({ type: 'resize', cols, rows });
            if (socketWriter) socketWriter.write(frame);
            else socket.write(frame);
          }
        },
        detach() {
          if (socket) {
            const { encodeControl } = require('../../lib/tmux-lite/protocol.js');
            const frame = encodeControl({ type: 'detach' });
            if (socketWriter) socketWriter.write(frame);
            else socket.write(frame);
          }
        },
        close() {
          socket?.end();
          socket = null;
          socketWriter = null;
        },
        onData(handler: (data: Uint8Array) => void) {
          dataHandler = handler;
        },
        onClose(handler: (exitCode?: number) => void) {
          closeHandler = handler;
        },
      };

      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            socket = s;
            socketWriter = createBufferedSocketWriter(s);
            // Send attach-init
            const { encodeControl } = require('../../lib/tmux-lite/protocol.js');
            socketWriter.write(encodeControl({
              type: 'attach-init',
              cols: options.cols,
              rows: options.rows,
              clientType: options.clientType,
            }));
            resolve(stream);
          },
          drain() {
            socketWriter?.flush();
          },
          data(_, data) {
            const { parseFrames, decodeControl, FrameType } = require('../../lib/tmux-lite/protocol.js');
            buffer = Buffer.concat([buffer, Buffer.from(data)]);

            let frames;
            let remaining;
            try {
              const result = parseFrames(buffer);
              frames = result.frames;
              remaining = result.remaining;
            } catch (err) {
              // Protocol error - likely desync or corrupted data
              const msg = err instanceof Error ? err.message : 'Frame parse error';
              console.error(`[LocalMachineProvider] Frame parse error: ${msg}`);
              closeHandler?.();
              socket?.end();
              socket = null;
              return;
            }
            // Copy remaining bytes - subarray references can become invalid when Bun reuses buffers
            buffer = Buffer.from(remaining);

            for (const frame of frames) {
              if (frame.type === FrameType.CONTROL) {
                const event = decodeControl(frame.payload);
                if (event.type === 'exited') {
                  closeHandler?.(event.code);
                  socket?.end();
                  socket = null;
                } else if (event.type === 'kicked') {
                  closeHandler?.();
                  socket?.end();
                  socket = null;
                }
              } else if (frame.type === FrameType.PTY) {
                dataHandler?.(frame.payload);
              }
            }
          },
          close() {
            closeHandler?.();
            socket = null;
          },
          error(_, e) {
            reject(e);
          },
          connectError(_, e) {
            reject(e);
          },
        },
      }).catch(reject);
    });
  }

  /**
   * Detach from a session
   */
  async detachSession(sessionId: string): Promise<void> {
    // Detach is handled by the SessionStream.detach() method
    // This is a no-op for local sessions
  }

  /**
   * Get inbox notifications
   */
  async getInbox(): Promise<InboxItem[]> {
    try {
      const items = await tmuxGetInbox();
      return items.map(item => ({
        id: item.id,
        sessionId: item.sessionId,
        sessionName: item.sessionName,
        type: item.type,
        timestamp: item.timestamp,
        read: item.read,
        context: item.context,
        processTitle: item.processTitle,
        exitCode: item.exitCode,
      }));
    } catch {
      // Server might not be running
      return [];
    }
  }

  /**
   * Mark inbox item as read
   */
  async markInboxRead(itemId: string): Promise<void> {
    await tmuxMarkInboxRead(itemId);
  }

  /**
   * Clear all inbox items
   */
  async clearInbox(): Promise<void> {
    await tmuxClearInbox();
  }

  /**
   * Subscribe to provider events
   */
  onEvent(handler: MachineProviderEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Emit an event to all handlers
   */
  private emit(event: MachineProviderEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  /**
   * Dispose of the provider
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eventHandlers.clear();
  }
}

/**
 * Singleton instance for convenience
 */
let localProvider: LocalMachineProvider | null = null;

export function getLocalMachineProvider(): LocalMachineProvider {
  if (!localProvider) {
    localProvider = new LocalMachineProvider();
  }
  return localProvider;
}
