#!/usr/bin/env bun
/**
 * Session server - manages a single PTY session
 * One client at a time, supports kick for takeover
 *
 * Usage: bun session.ts <socket-path> <cwd> <project> <workspace>
 */

import { unlinkSync } from "fs";
import {
  encodeControl,
  isControl,
  decodeControl,
  type SessionControl,
} from "./protocol";

const [socketPath, cwd, project, workspace] = process.argv.slice(2);

if (!socketPath || !cwd) {
  console.error("Usage: bun session.ts <socket-path> <cwd> <project> <workspace>");
  process.exit(1);
}

// Clean up existing socket
try { unlinkSync(socketPath); } catch {}

// Scrollback buffer (keep last 50KB)
const MAX_SCROLLBACK = 50 * 1024;
let scrollback = Buffer.alloc(0);

// Current attached client (only one allowed)
let client: any = null;

// Create PTY
const terminal = new Bun.Terminal({
  cols: 120,
  rows: 40,
  data(term, data) {
    // Add to scrollback
    scrollback = Buffer.concat([scrollback, data]);
    if (scrollback.length > MAX_SCROLLBACK) {
      scrollback = scrollback.subarray(-MAX_SCROLLBACK);
    }

    // Send to attached client
    if (client) {
      client.write(data);
    }
  }
});

// Spawn shell
const proc = Bun.spawn(["bash"], {
  terminal,
  cwd,
  env: {
    ...process.env,
    SPACES_PROJECT: project,
    SPACES_WORKSPACE: workspace,
  },
});

// Handle shell exit
proc.exited.then(code => {
  if (client) {
    client.write(encodeControl({ type: "exited", code }));
  }
  // Give client time to receive exit message
  setTimeout(() => {
    server.stop();
    try { unlinkSync(socketPath); } catch {}
    process.exit(code);
  }, 100);
});

// Report state to router
function reportState(event: string) {
  console.log(JSON.stringify({ event, attached: client !== null }));
}

// Kick current client
function kickClient() {
  if (client) {
    client.write(encodeControl({ type: "kicked" }));
    client.end();
    client = null;
    reportState("client_kicked");
  }
}

// Start server
const server = Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) {
      if (client) {
        // Already have a client - kick them
        kickClient();
      }

      client = socket;
      reportState("client_attached");

      // Send scrollback to new client
      const attachMsg = encodeControl({
        type: "attached",
        scrollback: scrollback.toString("base64")
      });
      socket.write(attachMsg);
    },

    data(socket, data) {
      const buf = Buffer.from(data);

      if (isControl(buf)) {
        const ctrl = decodeControl(buf) as SessionControl;

        switch (ctrl.type) {
          case "resize":
            terminal.resize(ctrl.cols, ctrl.rows);
            break;
          case "detach":
            if (socket === client) {
              client = null;
              reportState("client_detached");
            }
            socket.end();
            break;
          case "ping":
            socket.write(encodeControl({ type: "pong" }));
            break;
        }
      } else {
        // Raw input - write to PTY
        terminal.write(buf);
      }
    },

    close(socket) {
      if (socket === client) {
        client = null;
        reportState("client_disconnected");
      }
    },

    error(socket, error) {
      console.error(JSON.stringify({ event: "error", message: error.message }));
      if (socket === client) {
        client = null;
      }
    }
  }
});

console.log(JSON.stringify({
  event: "ready",
  socketPath,
  pid: process.pid,
  project,
  workspace,
  attached: false
}));

// Handle stdin commands from router (for kick)
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  const cmd = decoder.decode(chunk).trim();
  if (cmd === "kick") {
    kickClient();
  }
}

// Handle termination
process.on("SIGTERM", () => {
  proc.kill();
  terminal.close();
  server.stop();
  try { unlinkSync(socketPath); } catch {}
  process.exit(0);
});
