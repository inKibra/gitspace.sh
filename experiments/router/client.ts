#!/usr/bin/env bun
/**
 * Client - connects to router, attaches to session
 *
 * Usage: bun client.ts [project] [workspace]
 */

import { select } from "@inquirer/prompts";
import {
  ROUTER_SOCKET,
  type RouterCommand,
  type RouterResponse,
  type SessionInfo,
  type AttachMode,
  encodeControl,
  isControl,
  decodeControl,
  type SessionEvent,
} from "./protocol";

const [project = "test", workspace = "default"] = process.argv.slice(2);

// Connect to router
async function routerCommand(cmd: RouterCommand): Promise<RouterResponse> {
  return new Promise(async (resolve, reject) => {
    const socket = await Bun.connect({
      unix: ROUTER_SOCKET,
      socket: {
        data(socket, data) {
          resolve(JSON.parse(data.toString()));
          socket.end();
        },
        error(socket, error) {
          reject(error);
        },
        connectError(socket, error) {
          reject(new Error("Router not running. Start with: bun router.ts"));
        }
      }
    });

    socket.write(JSON.stringify(cmd));
  });
}

// Get or create session
console.log(`Connecting to ${project}/${workspace}...`);

let session: SessionInfo;

try {
  let response = await routerCommand({
    type: "create",
    project,
    workspace,
    cwd: process.cwd()
  });

  // Handle already-attached case
  if (response.type === "already-attached") {
    console.log(`\nSession "${project}/${workspace}" is already attached.\n`);

    const choice = await select({
      message: "What would you like to do?",
      choices: [
        { value: "take-over", name: "Take over (disconnect other client)" },
        { value: "new", name: "Create new session for this workspace" },
        { value: "cancel", name: "Cancel" },
      ]
    }) as AttachMode;

    if (choice === "cancel") {
      console.log("Cancelled.");
      process.exit(0);
    }

    if (choice === "take-over") {
      // Attach with take-over mode
      response = await routerCommand({
        type: "attach",
        sessionId: response.session.id,
        mode: "take-over"
      });
    } else if (choice === "new") {
      // Force create new session (kill old one first, then create)
      await routerCommand({ type: "kill", sessionId: response.session.id });
      response = await routerCommand({
        type: "create",
        project,
        workspace,
        cwd: process.cwd()
      });
    }
  }

  if (response.type === "error") {
    console.error("Error:", response.message);
    process.exit(1);
  }

  if (response.type !== "created") {
    console.error("Unexpected response:", response);
    process.exit(1);
  }

  session = response.session;
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
}

console.log(`Attached to session ${session.id}`);
console.log("Press Ctrl+D to detach\n");

// Connect to session
const sessionSocket = await Bun.connect({
  unix: session.socketPath,
  socket: {
    data(socket, data) {
      const buf = Buffer.from(data);

      if (isControl(buf)) {
        const event = decodeControl(buf) as SessionEvent;

        switch (event.type) {
          case "attached":
            // Replay scrollback
            if (event.scrollback) {
              const scrollback = Buffer.from(event.scrollback, "base64");
              process.stdout.write(scrollback);
            }
            break;

          case "exited":
            process.stdin.setRawMode(false);
            console.log(`\nSession exited with code ${event.code}`);
            process.exit(event.code);
            break;

          case "kicked":
            process.stdin.setRawMode(false);
            console.log("\n\nAnother client took over this session.");
            process.exit(0);
            break;

          case "pong":
            break;
        }
      } else {
        // PTY output - write to terminal
        process.stdout.write(buf);
      }
    },

    close() {
      process.stdin.setRawMode(false);
      console.log("\nDisconnected from session");
      process.exit(0);
    },

    error(socket, error) {
      process.stdin.setRawMode(false);
      console.error("\nSession error:", error.message);
      process.exit(1);
    }
  }
});

// Send initial resize
sessionSocket.write(encodeControl({
  type: "resize",
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24
}));

// Handle terminal resize
process.stdout.on("resize", () => {
  sessionSocket.write(encodeControl({
    type: "resize",
    cols: process.stdout.columns,
    rows: process.stdout.rows
  }));
});

// Forward stdin to session
process.stdin.setRawMode(true);
process.stdin.resume();

for await (const chunk of process.stdin) {
  // Check for Ctrl+D (detach)
  if (chunk[0] === 4) {
    sessionSocket.write(encodeControl({ type: "detach" }));
    process.stdin.setRawMode(false);
    console.log("\nDetached (session still running)");
    process.exit(0);
  }

  sessionSocket.write(chunk);
}
