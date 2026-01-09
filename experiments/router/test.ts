#!/usr/bin/env bun
/**
 * Test router + session architecture (single client per session)
 */

import {
  ROUTER_SOCKET,
  type RouterCommand,
  type RouterResponse,
  encodeControl,
  isControl,
  decodeControl,
  type SessionEvent,
} from "./protocol";

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
      }
    });
    socket.write(JSON.stringify(cmd));
  });
}

console.log("=== Testing Router Architecture (Single Client) ===\n");

// 1. Create a session
console.log("1. Create session test/workspace-1");
const create1 = await routerCommand({
  type: "create",
  project: "test",
  workspace: "workspace-1",
  cwd: process.cwd()
});
console.log("   Response:", create1.type);
if (create1.type !== "created") process.exit(1);
const session1 = create1.session;

// 2. Connect a client
console.log("\n2. Connect client to session");
let client1Kicked = false;
const client1 = await Bun.connect({
  unix: session1.socketPath,
  socket: {
    data(socket, data) {
      const buf = Buffer.from(data);
      if (isControl(buf)) {
        const event = decodeControl(buf) as SessionEvent;
        if (event.type === "kicked") {
          client1Kicked = true;
          console.log("   Client 1 received: kicked");
        }
      }
    }
  }
});
await Bun.sleep(100);

// 3. Check attached state
console.log("\n3. Check session is attached");
const list1 = await routerCommand({ type: "list" });
const attached = (list1 as any).sessions[0]?.attached;
console.log("   Attached:", attached ? "✓" : "✗");

// 4. Try to create same session again (should return already-attached)
console.log("\n4. Try to create same session again");
const create2 = await routerCommand({
  type: "create",
  project: "test",
  workspace: "workspace-1",
  cwd: process.cwd()
});
console.log("   Response:", create2.type, create2.type === "already-attached" ? "✓" : "✗");

// 5. Take over with kick
console.log("\n5. Take over session (kick client 1)");
const attach = await routerCommand({
  type: "attach",
  sessionId: session1.id,
  mode: "take-over"
});
console.log("   Response:", attach.type);
await Bun.sleep(100);
console.log("   Client 1 was kicked:", client1Kicked ? "✓" : "✗");

// 6. Connect new client after kick
console.log("\n6. Connect new client after kick");
const client2 = await Bun.connect({
  unix: session1.socketPath,
  socket: { data() {} }
});
await Bun.sleep(100);

// 7. Detach client 2, check session still exists
console.log("\n7. Detach client 2");
client2.write(encodeControl({ type: "detach" }));
await Bun.sleep(100);

const list2 = await routerCommand({ type: "list" });
const stillExists = (list2 as any).sessions.length === 1;
const nowDetached = !(list2 as any).sessions[0]?.attached;
console.log("   Session still exists:", stillExists ? "✓" : "✗");
console.log("   Now detached:", nowDetached ? "✓" : "✗");

// 8. Reattach to detached session (no prompt needed)
console.log("\n8. Reattach to detached session");
const create3 = await routerCommand({
  type: "create",
  project: "test",
  workspace: "workspace-1",
  cwd: process.cwd()
});
console.log("   Response:", create3.type, create3.type === "created" ? "✓" : "✗");

// 9. Clean up
console.log("\n9. Kill session");
const kill = await routerCommand({ type: "kill", sessionId: session1.id });
console.log("   Response:", kill.type);

const list3 = await routerCommand({ type: "list" });
console.log("   Sessions remaining:", (list3 as any).sessions.length);

console.log("\n=== Test Complete ===");
process.exit(0);
