/**
 * E2E Flow Tests
 *
 * Tests the complete flow of:
 * 1. Relay server running
 * 2. Machine connecting and registering
 * 3. Client connecting via ACL-authorized direct connect
 * 4. X3DH handshake completing
 * 5. Encrypted data exchange
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayServer } from "../server";
import { generateRelayIdentity } from "../identity";
import { clearAllRegistries } from "../registries";
import type { Server } from "bun";

import { RelayClient } from "../../lib/tmux-lite/relay-client";
import { HandshakeHandler } from "../../lib/tmux-lite/handshake-handler";
import { AccessControlList } from "../../lib/tmux-lite/crypto/access-control";
import {
  createTestIdentity,
  createIdentityFixtures,
  toPublicIdentity,
} from "../../lib/tmux-lite/crypto/__tests__/helpers/test-identities";
import { createDeviceCertificate } from "../../lib/tmux-lite/crypto/device-cert";
import { generateMnemonic, mnemonicToUserIdentity } from "../../lib/tmux-lite/crypto/user-identity";
import type { Identity, AccessType } from "../../types/identity";
import { getRelayClientTestAccess } from "../../__tests__/test-utils";
import { signChallenge, getSigningKeyBase64 } from "./helpers/auth";
import { startRelayServer } from "./helpers/ports";
import { ensureControlStore, setVaultMeta } from "../control/store";
import { grantMachineAccess, grantRelayAccess } from "../auth/store";

const TEST_HOST = "127.0.0.1";
let relayUrl = "";
let relayHttpBase = "";
let tempControlDir: string;
let previousControlDir: string | undefined;

// Generate test identities
const testRelayIdentity = generateRelayIdentity("e2e-test-relay");
const testFixtures = createIdentityFixtures();
const testUserRoot = mnemonicToUserIdentity(generateMnemonic());
const testOwnerUserRootId = testUserRoot.id;

function createTestDeviceCertificate(
  identity: Identity,
  userRoot = testUserRoot,
): string {
  return JSON.stringify(createDeviceCertificate(
    userRoot,
    identity.signing.publicKey,
    identity.keyExchange.publicKey,
  ));
}

let server: Server<any>;

beforeAll(async () => {
  previousControlDir = process.env.GITSPACE_CONTROL_DIR;
  tempControlDir = mkdtempSync(join(tmpdir(), "gssh-relay-e2e-test-"));
  process.env.GITSPACE_CONTROL_DIR = tempControlDir;
  ensureControlStore();
  setVaultMeta("vault_initialized", "1");
  setVaultMeta("owner_user_root_id", testOwnerUserRootId);

  // Pre-authorize the machine identity used in tests
  server = startRelayServer({
    bind: TEST_HOST,
    hostname: TEST_HOST,
    disableRateLimit: true,
    identity: testRelayIdentity,
    preAuthorizedMachines: new Set([
      getSigningKeyBase64(testFixtures.machine),
    ]),
  });
  relayUrl = `ws://${TEST_HOST}:${server.port}/ws`;
  relayHttpBase = `http://${TEST_HOST}:${server.port}`;

  // Wait for the server to start accepting connections (avoid flakiness/races).
  const deadline = Date.now() + 3000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`${relayHttpBase}/health`);
      if (res.ok) break;
    } catch {
      // ignore until deadline
    }
    if (Date.now() > deadline) {
      throw new Error("Relay server did not become healthy in time");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(() => {
  if (server) {
    server.stop(true);
  }

  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  if (tempControlDir) {
    rmSync(tempControlDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearAllRegistries();
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a machine connection that registers with relay using challenge-response auth
 */
async function createMachineConnection(
  machineIdentity: Identity,
  _accessList?: AccessControlList,
): Promise<{
  ws: WebSocket;
  handshakeHandler: HandshakeHandler;
  connectionId: string;
}> {
  const url = new URL(relayUrl);
  url.searchParams.set("role", "machine");
  // No token needed - auth via challenge-response

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Machine connection failed"));
    setTimeout(() => reject(new Error("Timeout")), 5000);
  });

  // Wait for relay_identity with challenge
  const challenge = await new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Challenge timeout")), 5000);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "relay_identity" && msg.challenge) {
          clearTimeout(timeout);
          resolve(Buffer.from(msg.challenge, "base64"));
        }
      } catch {
        // Ignore
      }
    };
  });

  // Sign challenge
  const signature = signChallenge(challenge, machineIdentity.signing.secretKey);
  const publicIdentity = toPublicIdentity(machineIdentity);

  // Register machine with challenge response
  ws.send(JSON.stringify({
    type: "register_machine",
    machineId: machineIdentity.id,
    signingKey: publicIdentity.signingPublicKey,
    keyExchangeKey: publicIdentity.keyExchangePublicKey,
    challengeResponse: signature,
    label: machineIdentity.label,
  }));

  // Wait for registration confirmation
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Registration timeout")), 5000);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "registered") {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.message));
        }
      } catch {
        // Ignore
      }
    };
  });

  // Create handshake handler for this machine
  const handshakeHandler = new HandshakeHandler({
    identity: machineIdentity,
    handshakeTimeoutMs: 30000,
    ownerUserRootId: testOwnerUserRootId,
    checkUserRootAccess: async (ownerUserRootId, clientUserRootId) => (
      ownerUserRootId === testOwnerUserRootId && clientUserRootId === testOwnerUserRootId
    ),
  });

  return {
    ws,
    handshakeHandler,
    connectionId: machineIdentity.id,
  };
}

// ============================================================================
// E2E Flow Tests
// ============================================================================

describe("E2E: Machine Registration", () => {
  test("machine can register with relay", async () => {
    const accessList = new AccessControlList();

    const { ws } = await createMachineConnection(testFixtures.machine, accessList);

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("machine registration is visible to ACL-authorized clients", async () => {
    const accessList = new AccessControlList();

    const { ws } = await createMachineConnection(testFixtures.machine, accessList);

    grantRelayAccess({
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-list',
    });
    grantMachineAccess({
      machineId: testFixtures.machine.id,
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-list',
    });

    const client = new RelayClient({
      relayUrl,
      machineId: testFixtures.machine.id,
      identity: testFixtures.alice,
      deviceCertificate: createTestDeviceCertificate(testFixtures.alice),
    });

    await client.connect();

    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const state = client.getState();
        if (state === 'handshaking' || state === 'connected') {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error(`Client did not reach handshaking state (current: ${client.getState()})`));
      }, 2000);
    });

    expect(['handshaking', 'connected']).toContain(client.getState());
    client.disconnect();

    ws.close();
  });
});

describe("E2E: Client Connection via ACL", () => {
  test("client can connect to machine via direct ACL auth", async () => {
    // Set up access list with alice authorized
    const accessList = new AccessControlList();
    accessList.addEntry(toPublicIdentity(testFixtures.alice), 'full');

    // Create machine connection
    const { ws: machineWs, handshakeHandler } = await createMachineConnection(
      testFixtures.machine,
      accessList
    );

    grantRelayAccess({
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-connect',
    });
    grantMachineAccess({
      machineId: testFixtures.machine.id,
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-connect',
    });

    // Track handshake on machine side
    let machineHandshakeComplete = false;
    let machineReceivedClientId: string | null = null;

    // Set up machine message handler
    machineWs.onmessage = async (event) => {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(data);

      if (msg.type === "client_connected") {
        // New client connecting
        const connectionId = msg.connectionId;
        console.log("[test] Machine received client_connected:", connectionId);
      } else if (msg.type === "data" && msg.connectionId) {
        // Handshake data from client
        const msgData = Buffer.from(msg.data, "base64");
        const jsonStr = new TextDecoder().decode(msgData);
        const envelope = JSON.parse(jsonStr);

        if (envelope.type === "handshake") {
          const result = await handshakeHandler.processMessage(msg.connectionId, envelope);

          if (result.type === "reply" || result.type === "established") {
            const response = JSON.stringify(result.message);
            machineWs.send(JSON.stringify({
              type: "data",
              connectionId: msg.connectionId,
              data: Buffer.from(response).toString("base64"),
            }));

            if (result.type === "established") {
              machineHandshakeComplete = true;
              machineReceivedClientId = result.session.peerIdentityId;
            }
          }
        }
      }
    };

    // Create client using RelayClient (no token needed)
    let clientConnected = false;
    let clientHandshakeComplete = false;
    let clientPeerIdentityId: string | null = null;
    let clientAccessType: AccessType | null = null;

    const client = new RelayClient(
      {
        relayUrl: relayUrl,
        machineId: testFixtures.machine.id,
        identity: testFixtures.alice,
        deviceCertificate: createTestDeviceCertificate(testFixtures.alice),
      },
      {
        onConnect: () => {
          clientConnected = true;
        },
        onHandshakeComplete: (peerIdentityId, accessType) => {
          clientHandshakeComplete = true;
          clientPeerIdentityId = peerIdentityId;
          clientAccessType = accessType;
        },
        onError: (error) => {
          console.error("[test] Client error:", error);
        },
      }
    );

    await client.connect();

    // Wait for handshakes to complete
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (clientHandshakeComplete && machineHandshakeComplete) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Handshake timeout"));
      }, 10000);
    });

    // Verify handshake completed on both sides
    expect(clientConnected).toBe(true);
    expect(clientHandshakeComplete).toBe(true);
    expect(clientPeerIdentityId).not.toBeNull();
    expect(clientPeerIdentityId!).toBe(testFixtures.machine.id);
    expect(clientAccessType).not.toBeNull();
    expect(clientAccessType!).toBe('full');

    expect(machineHandshakeComplete).toBe(true);
    expect(machineReceivedClientId).not.toBeNull();
    expect(machineReceivedClientId!).toBe(testFixtures.alice.id);

    client.disconnect();
    machineWs.close();
  });
});

describe("E2E: Direct Connection (Pre-authorized)", () => {
  test.skip("pre-authorized client can connect directly", async () => {
    // Replaced by ACL-gated direct-connect coverage in relay/server.test.ts.
  });
});

describe("E2E: Encrypted Data Exchange", () => {
  test("client and machine can exchange encrypted data", async () => {
    // Set up access list
    const accessList = new AccessControlList();
    accessList.addEntry(toPublicIdentity(testFixtures.alice), 'full');

    // Create machine connection
    const { ws: machineWs, handshakeHandler } = await createMachineConnection(
      testFixtures.machine,
      accessList
    );

    grantRelayAccess({
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-encrypted',
    });
    grantMachineAccess({
      machineId: testFixtures.machine.id,
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-encrypted',
    });

    // Track received messages
    const machineReceivedMessages: Buffer[] = [];
    const clientReceivedMessages: Buffer[] = [];
    let machineSessionKeys: { sendKey: Uint8Array; receiveKey: Uint8Array } | null = null;
    let clientConnectionId: string | null = null;

    // Set up machine message handler
    machineWs.onmessage = async (event) => {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(data);

      if (msg.type === "client_connected") {
        clientConnectionId = msg.connectionId;
      } else if (msg.type === "data" && msg.connectionId) {
        const msgData = Buffer.from(msg.data, "base64");

        // Try to parse as handshake
        try {
          const jsonStr = new TextDecoder().decode(msgData);
          const envelope = JSON.parse(jsonStr);

          if (envelope.type === "handshake") {
            const result = await handshakeHandler.processMessage(msg.connectionId, envelope);

            if (result.type === "reply" || result.type === "established") {
              const response = JSON.stringify(result.message);
              machineWs.send(JSON.stringify({
                type: "data",
                connectionId: msg.connectionId,
                data: Buffer.from(response).toString("base64"),
              }));

              if (result.type === "established") {
                machineSessionKeys = {
                  sendKey: result.session.sessionKeys.sendKey,
                  receiveKey: result.session.sessionKeys.receiveKey,
                };
              }
            }
            return;
          }
        } catch {
          // Not JSON, treat as encrypted data
        }

        // Store encrypted data received by machine
        machineReceivedMessages.push(msgData);
      }
    };

    // Create client (no token needed)
    let clientConnected = false;

    const client = new RelayClient(
      {
        relayUrl: relayUrl,
        machineId: testFixtures.machine.id,
        identity: testFixtures.alice,
        deviceCertificate: createTestDeviceCertificate(testFixtures.alice),
      },
      {
        onConnect: () => {
          clientConnected = true;
        },
        onMessage: (streamId, data) => {
          clientReceivedMessages.push(data);
        },
        onError: (error) => {
          console.error("[test] Client error:", error);
        },
      }
    );

    await client.connect();

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (clientConnected && machineSessionKeys) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Connection timeout"));
      }, 10000);
    });

    // Test sending data from client to machine
    const testMessage = Buffer.from("Hello from client!");
    const sent = client.send(testMessage);
    expect(sent).toBe(true);

    // Wait for message to arrive
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Machine should have received encrypted data
    expect(machineReceivedMessages.length).toBeGreaterThan(0);

    // Clean up
    client.disconnect();
    machineWs.close();
  });
});

describe("E2E: Error Scenarios", () => {
  test.skip("unauthorized client is rejected", async () => {
    // Replaced by ACL-gated authorization coverage in relay/server.test.ts.
  });

  test("client handles machine disconnect gracefully", async () => {
    const accessList = new AccessControlList();
    accessList.addEntry(toPublicIdentity(testFixtures.alice), 'full');

    const { ws: machineWs, handshakeHandler } = await createMachineConnection(
      testFixtures.machine,
      accessList
    );

    grantRelayAccess({
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-disconnect',
    });
    grantMachineAccess({
      machineId: testFixtures.machine.id,
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-disconnect',
    });

    // Set up machine to handle handshake
    let handshakeComplete = false;
    machineWs.onmessage = async (event) => {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(data);
      if (msg.type === "data" && msg.connectionId) {
        const msgData = Buffer.from(msg.data, "base64");
        try {
          const jsonStr = new TextDecoder().decode(msgData);
          const envelope = JSON.parse(jsonStr);

          if (envelope.type === "handshake") {
            const result = await handshakeHandler.processMessage(msg.connectionId, envelope);
            if (result.type === "reply" || result.type === "established") {
              const response = JSON.stringify(result.message);
              machineWs.send(JSON.stringify({
                type: "data",
                connectionId: msg.connectionId,
                data: Buffer.from(response).toString("base64"),
              }));
              if (result.type === "established") {
                handshakeComplete = true;
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    };

    // Connect client (no token needed)
    let clientDisconnected = false;
    let disconnectCode = 0;
    let disconnectReason = "";

    const client = new RelayClient(
      {
        relayUrl: relayUrl,
        machineId: testFixtures.machine.id,
        identity: testFixtures.alice,
        deviceCertificate: createTestDeviceCertificate(testFixtures.alice),
      },
      {
        onDisconnect: (code, reason) => {
          clientDisconnected = true;
          disconnectCode = code;
          disconnectReason = reason;
        },
      }
    );

    await client.connect();

    // Wait for handshake
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (handshakeComplete) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Handshake timeout"));
      }, 10000);
    });

    // Close machine connection
    machineWs.close();

    // Wait for client to receive disconnect
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (clientDisconnected) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 3000);
    });

    expect(clientDisconnected).toBe(true);

    client.disconnect();
  });
});

// ============================================================================
// PTY Session E2E Tests - Proves actual terminal sessions work through relay
// ============================================================================

import { ClientSessionManager } from "../../serve/client-session-manager";
import { createFrame, openFrame } from "../../lib/tmux-lite/crypto/frames";
import { STREAM_ID } from "../../serve/types";

describe("E2E: PTY Session Flow", () => {
  test("client can establish session and exchange encrypted terminal data", async () => {
    // Set up access list with alice authorized
    const accessList = new AccessControlList();
    accessList.addEntry(toPublicIdentity(testFixtures.alice), 'full');

    // Create ClientSessionManager (machine side)
    const sessionManager = new ClientSessionManager({
      relay: relayUrl,
      identity: testFixtures.machine,
      shell: "/bin/sh", // Use sh for portability
      ownerUserRootId: testOwnerUserRootId,
      checkUserRootAccess: async (ownerUserRootId, clientUserRootId) => (
        ownerUserRootId === testOwnerUserRootId && clientUserRootId === testOwnerUserRootId
      ),
    });

    // Track session events
    const events: any[] = [];
    sessionManager.onEvent((event) => {
      events.push(event);
    });

    // Create machine connection with challenge-response auth
    const machineUrl = new URL(relayUrl);
    machineUrl.searchParams.set("role", "machine");
    // No token needed

    const machineWs = new WebSocket(machineUrl.toString());
    machineWs.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      machineWs.onopen = () => resolve();
      machineWs.onerror = () => reject(new Error("Machine connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    // Wait for challenge
    const challenge = await new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Challenge timeout")), 5000);
      machineWs.onmessage = (event) => {
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
          const msg = JSON.parse(data);
          if (msg.type === "relay_identity" && msg.challenge) {
            clearTimeout(timeout);
            resolve(Buffer.from(msg.challenge, "base64"));
          }
        } catch {
          // Ignore
        }
      };
    });

    // Register machine with challenge response
    const signature = signChallenge(challenge, testFixtures.machine.signing.secretKey);
    const publicIdentity = toPublicIdentity(testFixtures.machine);
    machineWs.send(JSON.stringify({
      type: "register_machine",
      machineId: testFixtures.machine.id,
      signingKey: publicIdentity.signingPublicKey,
      keyExchangeKey: publicIdentity.keyExchangePublicKey,
      challengeResponse: signature,
      label: "Test Machine",
    }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Registration timeout")), 5000);
      machineWs.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "registered") {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.message));
        }
      };
    });

    grantRelayAccess({
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-pty-session',
    });
    grantMachineAccess({
      machineId: testFixtures.machine.id,
      ownerUserRootId: testOwnerUserRootId,
      clientUserRootId: testUserRoot.id,
      label: 'e2e-pty-session',
    });

    // Track data received from machine
    const machineReceivedData: Buffer[] = [];
    let clientConnectionId: string | null = null;

    // Machine message handler - routes to ClientSessionManager
    machineWs.onmessage = async (event) => {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(data);

      if (msg.type === "client_connected") {
        clientConnectionId = msg.connectionId;
        sessionManager.handleConnect(msg.connectionId);

        // Set up send callback for session manager
        sessionManager.setSendCallback(msg.connectionId, (sendData: Buffer) => {
          // Send encrypted data back through relay
          machineWs.send(JSON.stringify({
            type: "data",
            connectionId: msg.connectionId,
            data: sendData.toString("base64"),
          }));
        });
      } else if (msg.type === "data" && msg.connectionId) {
        // Decode and route to session manager
        const msgData = Buffer.from(msg.data, "base64");
        machineReceivedData.push(msgData);

        const response = await sessionManager.handleMessage(msg.connectionId, msgData);
        if (response) {
          // Send response back to client
          machineWs.send(JSON.stringify({
            type: "data",
            connectionId: msg.connectionId,
            data: Buffer.from(response).toString("base64"),
          }));
        }
      }
    };

    // Track client received data
    const clientReceivedData: Buffer[] = [];
    let clientHandshakeComplete = false;
    let clientSessionKeys: { sendKey: Uint8Array; receiveKey: Uint8Array } | null = null;

    // Create client connection (no token needed)
    const client = new RelayClient(
      {
        relayUrl: relayUrl,
        machineId: testFixtures.machine.id,
        identity: testFixtures.alice,
        deviceCertificate: createTestDeviceCertificate(testFixtures.alice),
      },
      {
        onHandshakeComplete: (peerIdentityId, accessType) => {
          clientHandshakeComplete = true;
          // Get session keys from client for verification using test utility
          const testAccess = getRelayClientTestAccess(client);
          clientSessionKeys = {
            sendKey: testAccess.writeKey!,
            receiveKey: testAccess.readKey!,
          };
        },
        onMessage: (streamId, data) => {
          clientReceivedData.push(data);
        },
        onError: (error) => {
          console.error("[test] Client error:", error);
        },
      }
    );

    await client.connect();

    // Wait for handshake to complete
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (clientHandshakeComplete) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Handshake timeout"));
      }, 10000);
    });

    // Verify session was established
    expect(clientHandshakeComplete).toBe(true);
    expect(events.some(e => e.type === "client_connected")).toBe(true);
    expect(events.some(e => e.type === "client_authenticated")).toBe(true);

    // Verify session manager has the session
    expect(sessionManager.activeSessionCount).toBe(1);
    expect(sessionManager.establishedSessionCount).toBe(1);

    // Get the session
    const session = sessionManager.getSession(clientConnectionId!);
    expect(session).toBeDefined();
    expect(session?.state).toBe("browsing");
    expect(session?.peerIdentityId).toBe(testFixtures.alice.id);

    // Send terminal input from client (e.g., "echo hello\n")
    // This creates an encrypted frame and sends it
    const testInput = Buffer.from("echo hello\n");
    const sent = client.send(testInput);
    expect(sent).toBe(true);

    // Wait for PTY to process and send output
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The machine should have received encrypted data
    expect(machineReceivedData.length).toBeGreaterThan(0);

    // Clean up
    client.disconnect();
    sessionManager.cleanup();
    machineWs.close();
  });

  test.skip("ClientSessionManager handles multiple concurrent clients", async () => {
    // Create a second client identity
    const bob = createTestIdentity("Bob");

    // Set up access list with both alice and bob authorized
    const accessList = new AccessControlList();
    accessList.addEntry(toPublicIdentity(testFixtures.alice), 'full');
    accessList.addEntry(toPublicIdentity(bob), 'view', 'test-session');

    // Create ClientSessionManager
    const sessionManager = new ClientSessionManager({
      relay: relayUrl,
      identity: testFixtures.machine,
      shell: "/bin/sh",
      ownerUserRootId: testOwnerUserRootId,
      checkUserRootAccess: async (ownerUserRootId, clientUserRootId) => (
        ownerUserRootId === testOwnerUserRootId && clientUserRootId === testOwnerUserRootId
      ),
    });

    const authenticatedClients: string[] = [];
    sessionManager.onEvent((event) => {
      if (event.type === "client_authenticated") {
        authenticatedClients.push(event.identityId);
      }
    });

    // Create machine connection with challenge-response
    const machineUrl = new URL(relayUrl);
    machineUrl.searchParams.set("role", "machine");

    const machineWs = new WebSocket(machineUrl.toString());
    machineWs.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      machineWs.onopen = () => resolve();
      machineWs.onerror = () => reject(new Error("Machine connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    // Challenge-response
    const challenge = await new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Challenge timeout")), 5000);
      machineWs.onmessage = (event) => {
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
          const msg = JSON.parse(data);
          if (msg.type === "relay_identity" && msg.challenge) {
            clearTimeout(timeout);
            resolve(Buffer.from(msg.challenge, "base64"));
          }
        } catch {
          // Ignore
        }
      };
    });

    const signature = signChallenge(challenge, testFixtures.machine.signing.secretKey);
    const publicIdentity = toPublicIdentity(testFixtures.machine);
    machineWs.send(JSON.stringify({
      type: "register_machine",
      machineId: testFixtures.machine.id,
      signingKey: publicIdentity.signingPublicKey,
      keyExchangeKey: publicIdentity.keyExchangePublicKey,
      challengeResponse: signature,
    }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
      machineWs.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "registered") {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.message));
        }
      };
    });

    // Relay-side ACL auth uses user-root access checks only.

    // Machine message handler
    machineWs.onmessage = async (event) => {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(data);

      if (msg.type === "client_connected") {
        sessionManager.handleConnect(msg.connectionId);
        sessionManager.setSendCallback(msg.connectionId, (sendData: Buffer) => {
          machineWs.send(JSON.stringify({
            type: "data",
            connectionId: msg.connectionId,
            data: sendData.toString("base64"),
          }));
        });
      } else if (msg.type === "data" && msg.connectionId) {
        const msgData = Buffer.from(msg.data, "base64");
        const response = await sessionManager.handleMessage(msg.connectionId, msgData);
        if (response) {
          machineWs.send(JSON.stringify({
            type: "data",
            connectionId: msg.connectionId,
            data: Buffer.from(response).toString("base64"),
          }));
        }
      }
    };

    // Connect both clients concurrently (no tokens needed)
    let aliceHandshakeComplete = false;
    let bobHandshakeComplete = false;

    const clientAlice = new RelayClient(
      {
        relayUrl: relayUrl,
        machineId: testFixtures.machine.id,
        identity: testFixtures.alice,
        deviceCertificate: createTestDeviceCertificate(testFixtures.alice),
        // No token needed
      },
      {
        onHandshakeComplete: () => {
          aliceHandshakeComplete = true;
        },
        onError: (error) => {
          console.error("[test] Alice error:", error);
        },
      }
    );

    const clientBob = new RelayClient(
      {
        relayUrl: relayUrl,
        machineId: testFixtures.machine.id,
        identity: bob,
        deviceCertificate: createTestDeviceCertificate(bob),
        // No token needed
      },
      {
        onHandshakeComplete: () => {
          bobHandshakeComplete = true;
        },
        onError: (error) => {
          console.error("[test] Bob error:", error);
        },
      }
    );

    // Connect both
    await Promise.all([clientAlice.connect(), clientBob.connect()]);

    // Wait for both handshakes
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (aliceHandshakeComplete && bobHandshakeComplete) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Handshake timeout"));
      }, 15000);
    });

    // Verify both sessions established
    expect(aliceHandshakeComplete).toBe(true);
    expect(bobHandshakeComplete).toBe(true);
    // Note: Session count may be >= 2 due to RelayClient auto-reconnection
    expect(sessionManager.activeSessionCount).toBeGreaterThanOrEqual(2);
    expect(sessionManager.establishedSessionCount).toBeGreaterThanOrEqual(2);

    // Verify both clients were authenticated
    expect(authenticatedClients).toContain(testFixtures.alice.id);
    expect(authenticatedClients).toContain(bob.id);

    // Clean up
    clientAlice.disconnect();
    clientBob.disconnect();
    sessionManager.cleanup();
    machineWs.close();
  });
});
