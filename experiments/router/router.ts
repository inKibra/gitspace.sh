#!/usr/bin/env bun
/**
 * Router - manages session lifecycle
 * Always running, spawns sessions on demand
 *
 * Usage: bun router.ts
 */

import { unlinkSync, existsSync } from "fs";
import { spawn } from "bun";
import {
  ROUTER_SOCKET,
  SESSION_SOCKET_PREFIX,
  type RouterCommand,
  type RouterResponse,
  type SessionInfo,
} from "./protocol";

// Clean up existing socket
try { unlinkSync(ROUTER_SOCKET); } catch {}

// Active sessions
const sessions = new Map<string, {
  info: SessionInfo;
  proc: Bun.Subprocess;
  stdin: WritableStream<Uint8Array>;
}>();

// Generate session ID
function genId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// Find session by project/workspace
function findSession(project: string, workspace: string) {
  for (const [id, session] of sessions) {
    if (session.info.project === project && session.info.workspace === workspace) {
      return session;
    }
  }
  return null;
}

// Spawn a new session
async function createSession(project: string, workspace: string, cwd: string): Promise<SessionInfo> {
  const id = genId();
  const socketPath = `${SESSION_SOCKET_PREFIX}${id}.sock`;

  const proc = spawn({
    cmd: ["bun", "run", `${import.meta.dir}/session.ts`, socketPath, cwd, project, workspace],
    stdout: "pipe",
    stdin: "pipe",
    stderr: "inherit",
  });

  // Wait for ready event
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  const ready = JSON.parse(new TextDecoder().decode(value));

  if (ready.event !== "ready") {
    throw new Error("Session failed to start");
  }

  const info: SessionInfo = {
    id,
    project,
    workspace,
    socketPath,
    pid: ready.pid,
    attached: false,
    createdAt: Date.now(),
  };

  const sessionData = { info, proc, stdin: proc.stdin };
  sessions.set(id, sessionData);

  // Monitor session stdout for state updates
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      try {
        const lines = new TextDecoder().decode(value).trim().split('\n');
        for (const line of lines) {
          const event = JSON.parse(line);
          if (event.attached !== undefined) {
            const session = sessions.get(id);
            if (session) session.info.attached = event.attached;
          }
        }
      } catch {}
    }

    // Session ended
    sessions.delete(id);
    console.log(`[router] Session ${id} ended`);
  })();

  console.log(`[router] Created session ${id} for ${project}/${workspace}`);
  return info;
}

// Kick client from session
async function kickSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;

  const writer = session.stdin.getWriter();
  await writer.write(new TextEncoder().encode("kick\n"));
  writer.releaseLock();
  return true;
}

// Start router server
const server = Bun.listen({
  unix: ROUTER_SOCKET,
  socket: {
    async data(socket, data) {
      try {
        const cmd: RouterCommand = JSON.parse(data.toString());
        let response: RouterResponse;

        switch (cmd.type) {
          case "list":
            response = {
              type: "sessions",
              sessions: Array.from(sessions.values()).map(s => s.info)
            };
            break;

          case "create": {
            // Check if session already exists for this workspace
            const existing = findSession(cmd.project, cmd.workspace);

            if (existing) {
              if (existing.info.attached) {
                // Session exists and has a client
                response = { type: "already-attached", session: existing.info };
              } else {
                // Session exists but detached - reuse it
                response = { type: "created", session: existing.info };
              }
            } else {
              // Create new session
              const session = await createSession(cmd.project, cmd.workspace, cmd.cwd);
              response = { type: "created", session };
            }
            break;
          }

          case "attach": {
            const session = sessions.get(cmd.sessionId);
            if (!session) {
              response = { type: "error", message: "Session not found" };
            } else if (session.info.attached && cmd.mode !== "take-over") {
              response = { type: "already-attached", session: session.info };
            } else {
              if (cmd.mode === "take-over" && session.info.attached) {
                await kickSession(cmd.sessionId);
                await Bun.sleep(50); // Let kick propagate
              }
              response = { type: "created", session: session.info };
            }
            break;
          }

          case "kick": {
            const kicked = await kickSession(cmd.sessionId);
            response = kicked ? { type: "ok" } : { type: "error", message: "Session not found" };
            break;
          }

          case "kill": {
            const toKill = sessions.get(cmd.sessionId);
            if (toKill) {
              toKill.proc.kill();
              sessions.delete(cmd.sessionId);
              response = { type: "ok" };
            } else {
              response = { type: "error", message: "Session not found" };
            }
            break;
          }

          default:
            response = { type: "error", message: "Unknown command" };
        }

        socket.write(JSON.stringify(response));
      } catch (e: any) {
        socket.write(JSON.stringify({ type: "error", message: e.message }));
      }
    },
    error(socket, error) {
      console.error("[router] Client error:", error.message);
    }
  }
});

console.log(`[router] Listening on ${ROUTER_SOCKET}`);
console.log("[router] Ready");

// Cleanup on exit
process.on("SIGTERM", () => {
  for (const [id, session] of sessions) {
    session.proc.kill();
  }
  server.stop();
  try { unlinkSync(ROUTER_SOCKET); } catch {}
  process.exit(0);
});

process.on("SIGINT", () => {
  process.emit("SIGTERM" as any);
});
