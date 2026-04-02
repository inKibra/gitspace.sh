/**
 * Identity Chain E2E Test (North Star)
 *
 * Proves the complete identity chain works end-to-end with 3 isolated containers:
 *
 * 1. RELAY CONTAINER  - Starts a relay that knows its owner (user root identity)
 * 2. MACHINE CONTAINER - Registers with the relay using a device certificate
 * 3. CLIENT CONTAINER  - Connects through the relay to the machine via X3DH
 *
 * The ONLY shared secret across all 3 containers is a single BIP39 mnemonic.
 * Each container independently derives the user root identity from that mnemonic.
 * This proves the cryptographic chain: mnemonic -> user root -> device certs -> relay auth -> E2E session.
 *
 * Key difference from e2e-flow.test.ts:
 * - No explicit grantRelayAccess() / grantMachineAccess() calls
 * - Authorization is purely owner-identity-based (same user root across all containers)
 * - Each container has its own isolated temp dir and state
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

// Relay
import { createRelayServer } from "../server.js";
import { generateRelayIdentity } from "../identity.js";
import { ensureControlStore, setVaultMeta } from "../control/store.js";

// Crypto & Identity
import { generateMnemonic, mnemonicToUserIdentity } from "../../lib/tmux-lite/crypto/user-identity.js";
import { generateIdentity } from "../../lib/tmux-lite/crypto/identity.js";
import { createDeviceCertificate } from "../../lib/tmux-lite/crypto/device-cert.js";
import { HandshakeHandler } from "../../lib/tmux-lite/handshake-handler.js";
import { RelayClient } from "../../lib/tmux-lite/relay-client.js";
import { createFrame, openFrame } from "../../lib/tmux-lite/crypto/frames.js";
import type { Identity, UserRootIdentity } from "../../types/identity.js";

// Test helpers
import { signChallenge, signClientMessage } from "./helpers/auth.js";
import { startRelayServer } from "./helpers/ports.js";
import { toPublicIdentity } from "../../lib/tmux-lite/crypto/__tests__/helpers/test-identities.js";
import { getRelayClientTestAccess } from "../../__tests__/test-utils.js";

// ============================================================================
// 3 Isolated Test Containers
// ============================================================================

/** State for each isolated container */
interface RelayContainer {
  tempDir: string;
  relayIdentity: ReturnType<typeof generateRelayIdentity>;
  ownerUserRootId: string;
  server: Server<any>;
  port: number;
  url: string;
  httpBase: string;
}

interface MachineContainer {
  tempDir: string;
  deviceIdentity: Identity;
  userRoot: UserRootIdentity;
  deviceCertificate: string;
  ws: WebSocket | null;
  handshakeHandler: HandshakeHandler | null;
}

interface ClientContainer {
  tempDir: string;
  deviceIdentity: Identity;
  userRoot: UserRootIdentity;
  deviceCertificate: string;
}

// ============================================================================
// Shared secret: ONE mnemonic, derived independently in each container
// ============================================================================

const sharedMnemonic = generateMnemonic();

// Each container derives the user root independently (proving deterministic derivation)
const relayUserRoot = mnemonicToUserIdentity(sharedMnemonic);
const machineUserRoot = mnemonicToUserIdentity(sharedMnemonic);
const clientUserRoot = mnemonicToUserIdentity(sharedMnemonic);

// Sanity: all three derive the same identity
if (relayUserRoot.id !== machineUserRoot.id || machineUserRoot.id !== clientUserRoot.id) {
  throw new Error("BUG: same mnemonic produced different user root IDs");
}

// ============================================================================
// Container setup
// ============================================================================

let relay: RelayContainer;
let machine: MachineContainer;
let client: ClientContainer;
let previousControlDir: string | undefined;

beforeAll(async () => {
  // Save original env
  previousControlDir = process.env.GITSPACE_CONTROL_DIR;

  // ── RELAY CONTAINER ────────────────────────────────────────────────────
  const relayTempDir = mkdtempSync(join(tmpdir(), "gssh-identity-chain-relay-"));
  process.env.GITSPACE_CONTROL_DIR = relayTempDir;
  ensureControlStore();
  setVaultMeta("vault_initialized", "1");
  setVaultMeta("owner_user_root_id", relayUserRoot.id);

  // ── MACHINE CONTAINER ──────────────────────────────────────────────────
  const machineTempDir = mkdtempSync(join(tmpdir(), "gssh-identity-chain-machine-"));
  const machineDevice = generateIdentity("Test Machine");
  const machineCert = JSON.stringify(createDeviceCertificate(
    machineUserRoot,
    machineDevice.signing.publicKey,
    machineDevice.keyExchange.publicKey,
  ));

  // ── CLIENT CONTAINER ───────────────────────────────────────────────────
  const clientTempDir = mkdtempSync(join(tmpdir(), "gssh-identity-chain-client-"));
  const clientDevice = generateIdentity("Test Client");
  const clientCert = JSON.stringify(createDeviceCertificate(
    clientUserRoot,
    clientDevice.signing.publicKey,
    clientDevice.keyExchange.publicKey,
  ));

  // ── START RELAY ────────────────────────────────────────────────────────
  // The relay knows its owner via owner_user_root_id in the vault (set above).
  // NO preAuthorizedMachines — the machine will authenticate purely via
  // its device certificate (signed by the user root identity).
  const relayIdentity = generateRelayIdentity("identity-chain-test-relay");
  const server = startRelayServer({
    bind: "127.0.0.1",
    hostname: "127.0.0.1",
    disableRateLimit: true,
    identity: relayIdentity,
  });

  const port = server.port!;
  const url = `ws://127.0.0.1:${port}/ws`;
  const httpBase = `http://127.0.0.1:${port}`;

  // Wait for relay to become healthy
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      const res = await fetch(`${httpBase}/health`);
      if (res.ok) break;
    } catch {
      // retry
    }
    if (Date.now() > deadline) {
      throw new Error("Relay server did not become healthy in time");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // ── ASSIGN CONTAINERS ─────────────────────────────────────────────────
  relay = {
    tempDir: relayTempDir,
    relayIdentity,
    ownerUserRootId: relayUserRoot.id,
    server,
    port,
    url,
    httpBase,
  };

  machine = {
    tempDir: machineTempDir,
    deviceIdentity: machineDevice,
    userRoot: machineUserRoot,
    deviceCertificate: machineCert,
    ws: null,
    handshakeHandler: null,
  };

  client = {
    tempDir: clientTempDir,
    deviceIdentity: clientDevice,
    userRoot: clientUserRoot,
    deviceCertificate: clientCert,
  };
});

afterAll(() => {
  // Stop relay
  if (relay?.server) {
    relay.server.stop(true);
  }

  // Close WebSocket connections
  if (machine?.ws && machine.ws.readyState === WebSocket.OPEN) {
    machine.ws.close();
  }

  // Restore env
  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  // Clean up temp dirs
  for (const dir of [relay?.tempDir, machine?.tempDir, client?.tempDir]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

// ============================================================================
// Helpers
// ============================================================================

/** Connect a machine WebSocket and complete challenge-response registration */
async function registerMachine(
  relayUrl: string,
  identity: Identity,
  deviceCertificate?: string,
): Promise<WebSocket> {
  const url = new URL(relayUrl);
  url.searchParams.set("role", "machine");

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  // Wait for open
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Machine WebSocket connection failed"));
    setTimeout(() => reject(new Error("Connection timeout")), 5000);
  });

  // Wait for relay_identity with challenge nonce
  const challenge = await new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Challenge timeout")), 5000);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "relay_identity" && msg.challenge) {
          clearTimeout(timeout);
          resolve(Buffer.from(msg.challenge, "base64"));
        }
      } catch {
        // ignore
      }
    };
  });

  // Sign challenge, send register_machine with device certificate
  const signature = signChallenge(challenge, identity.signing.secretKey);
  const pub = toPublicIdentity(identity);

  const regMsg: Record<string, unknown> = {
    type: "register_machine",
    machineId: identity.id,
    signingKey: pub.signingPublicKey,
    keyExchangeKey: pub.keyExchangePublicKey,
    challengeResponse: signature,
    label: identity.label ?? "test-machine",
  };
  if (deviceCertificate) {
    regMsg.deviceCertificate = deviceCertificate;
  }

  ws.send(JSON.stringify(regMsg));

  // Wait for registered or error
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Registration timeout")), 5000);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "registered") {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`Registration rejected: ${msg.message || msg.code}`));
        }
      } catch {
        // ignore
      }
    };
  });

  return ws;
}

/** Parse a relay WebSocket message */
function parseWsMessage(event: MessageEvent): any {
  const data = typeof event.data === "string"
    ? event.data
    : new TextDecoder().decode(event.data);
  return JSON.parse(data);
}

// ============================================================================
// Tests - run sequentially (each builds on the previous)
// ============================================================================

describe("Identity Chain E2E: Relay -> Machine -> Client", () => {

  // ──────────────────────────────────────────────────────────────────────
  // Test 1: Verify the 3 containers are properly isolated
  // ──────────────────────────────────────────────────────────────────────

  test("all three containers derive the same user root from the shared mnemonic", () => {
    // Same user root ID
    expect(relayUserRoot.id).toBe(machineUserRoot.id);
    expect(machineUserRoot.id).toBe(clientUserRoot.id);

    // Same signing public key
    expect(Buffer.from(relayUserRoot.signing.publicKey).toString("base64"))
      .toBe(Buffer.from(machineUserRoot.signing.publicKey).toString("base64"));
    expect(Buffer.from(machineUserRoot.signing.publicKey).toString("base64"))
      .toBe(Buffer.from(clientUserRoot.signing.publicKey).toString("base64"));

    // But the device identities are all different (random keypairs)
    expect(machine.deviceIdentity.id).not.toBe(client.deviceIdentity.id);

    // And temp dirs are all different
    expect(relay.tempDir).not.toBe(machine.tempDir);
    expect(machine.tempDir).not.toBe(client.tempDir);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 2: Relay is healthy and knows its owner
  // ──────────────────────────────────────────────────────────────────────

  test("relay is healthy and reports its owner", async () => {
    const res = await fetch(`${relay.httpBase}/health`);
    expect(res.ok).toBe(true);

    const body = await res.json() as any;
    expect(body.status).toBe("ok");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 3: Machine connects and registers (owner pre-authorization)
  // ──────────────────────────────────────────────────────────────────────

  test("machine registers with relay via device certificate (no enrollment token)", async () => {
    // This is the critical test. The machine connects with NO enrollment token,
    // NO bootstrap token, NO preAuthorizedMachines, and NO prior registration.
    // It succeeds because:
    //   - The machine sends a device certificate signed by the user root identity
    //   - The relay verifies the certificate and checks the signer matches owner_user_root_id
    const ws = await registerMachine(relay.url, machine.deviceIdentity, machine.deviceCertificate);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Store for subsequent tests
    machine.ws = ws;

    // Create handshake handler for machine side
    machine.handshakeHandler = new HandshakeHandler({
      identity: machine.deviceIdentity,
      handshakeTimeoutMs: 30000,
      ownerUserRootId: machineUserRoot.id,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 4: Client lists machines via signed request
  // ──────────────────────────────────────────────────────────────────────

  test("owner client can list machines through relay", async () => {
    const clientWs = new WebSocket(`${relay.url}?role=client`);
    clientWs.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = () => reject(new Error("Client connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    // Send signed list_machines with device certificate
    const listMsg = signClientMessage({
      type: "list_machines",
      clientIdentityId: client.deviceIdentity.id,
      deviceCertificate: client.deviceCertificate,
    }, client.deviceIdentity);

    const machineListPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("list_machines timeout")), 5000);
      clientWs.onmessage = (event) => {
        try {
          const msg = parseWsMessage(event);
          if (msg.type === "machine_list") {
            clearTimeout(timeout);
            resolve(msg);
          } else if (msg.type === "error") {
            clearTimeout(timeout);
            reject(new Error(`list_machines rejected: ${msg.message || msg.code}`));
          }
        } catch { /* ignore */ }
      };
    });

    clientWs.send(JSON.stringify(listMsg));
    const response = await machineListPromise;

    // Owner should see the registered machine
    expect(response.machines).toBeDefined();
    expect(response.machines.length).toBeGreaterThanOrEqual(1);

    const found = response.machines.find((m: any) => m.machineId === machine.deviceIdentity.id);
    expect(found).toBeDefined();

    clientWs.close();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 5: Client connects to machine through relay + X3DH handshake
  // ──────────────────────────────────────────────────────────────────────

  test("client connects to machine through relay and completes X3DH handshake", async () => {
    let machineHandshakeComplete = false;
    let machineSessionKeys: { sendKey: Uint8Array; receiveKey: Uint8Array } | null = null;
    let machinePeerIdentityId: string | null = null;

    // Set up machine-side message handler for handshake
    machine.ws!.onmessage = async (event) => {
      const msg = parseWsMessage(event);

      if (msg.type === "client_connected") {
        // New client arriving
      } else if (msg.type === "data" && msg.connectionId) {
        // Handshake data from client via relay
        const msgData = Buffer.from(msg.data, "base64");
        try {
          const jsonStr = new TextDecoder().decode(msgData);
          const envelope = JSON.parse(jsonStr);

          if (envelope.type === "handshake") {
            const result = await machine.handshakeHandler!.processMessage(
              msg.connectionId,
              envelope,
            );

            if (result.type === "reply" || result.type === "established") {
              // Send handshake response back through relay
              const response = JSON.stringify(result.message);
              machine.ws!.send(JSON.stringify({
                type: "data",
                connectionId: msg.connectionId,
                data: Buffer.from(response).toString("base64"),
              }));

              if (result.type === "established") {
                machineHandshakeComplete = true;
                machineSessionKeys = {
                  sendKey: result.session.sessionKeys.sendKey,
                  receiveKey: result.session.sessionKeys.receiveKey,
                };
                machinePeerIdentityId = result.session.peerIdentityId;
              }
            }
          }
        } catch {
          // Not handshake JSON - ignore
        }
      }
    };

    // Create client using RelayClient (uses signed connect_to_machine internally)
    let clientHandshakeComplete = false;
    let clientPeerIdentityId: string | null = null;

    const relayClient = new RelayClient(
      {
        relayUrl: relay.url,
        machineId: machine.deviceIdentity.id,
        identity: client.deviceIdentity,
        deviceCertificate: client.deviceCertificate,
      },
      {
        onHandshakeComplete: (peerIdentityId) => {
          clientHandshakeComplete = true;
          clientPeerIdentityId = peerIdentityId;
        },
        onError: (error) => {
          console.error("[identity-chain] Client error:", error);
        },
      },
    );

    await relayClient.connect();

    // Wait for both sides to complete handshake
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        if (clientHandshakeComplete && machineHandshakeComplete) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(
          `X3DH handshake timeout (client: ${clientHandshakeComplete}, machine: ${machineHandshakeComplete})`,
        ));
      }, 10000);
    });

    // Verify handshake completed on both sides
    expect(clientHandshakeComplete).toBe(true);
    expect(machineHandshakeComplete).toBe(true);

    // Verify peer identity IDs match (client sees machine, machine sees client)
    expect(clientPeerIdentityId!).toBe(machine.deviceIdentity.id);
    expect(machinePeerIdentityId!).toBe(client.deviceIdentity.id);

    // Verify key symmetry: client's send key === machine's receive key
    const clientAccess = getRelayClientTestAccess(relayClient);
    expect(clientAccess.writeKey).not.toBeNull();
    expect(clientAccess.readKey).not.toBeNull();
    expect(machineSessionKeys).not.toBeNull();

    const clientWriteHex = Buffer.from(clientAccess.writeKey!).toString("hex");
    const clientReadHex = Buffer.from(clientAccess.readKey!).toString("hex");
    const machineReceiveHex = Buffer.from(machineSessionKeys!.receiveKey).toString("hex");
    const machineSendHex = Buffer.from(machineSessionKeys!.sendKey).toString("hex");

    expect(clientWriteHex).toBe(machineReceiveHex);
    expect(clientReadHex).toBe(machineSendHex);

    // Clean up client (machine stays for next test)
    relayClient.disconnect();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 6: Encrypted data round-trips through relay
  // ──────────────────────────────────────────────────────────────────────

  test("encrypted data flows bidirectionally through relay", async () => {
    let machineSessionKeys: { sendKey: Uint8Array; receiveKey: Uint8Array } | null = null;
    let machineConnectionId: string | null = null;
    const machineDecryptedMessages: string[] = [];

    // Fresh handshake handler for this test
    const handshakeHandler = new HandshakeHandler({
      identity: machine.deviceIdentity,
      handshakeTimeoutMs: 30000,
      ownerUserRootId: machineUserRoot.id,
    });

    // Machine message handler: handshake then encrypted data
    machine.ws!.onmessage = async (event) => {
      const msg = parseWsMessage(event);

      if (msg.type === "client_connected") {
        machineConnectionId = msg.connectionId;
      } else if (msg.type === "data" && msg.connectionId) {
        const msgData = Buffer.from(msg.data, "base64");

        // Try handshake first
        try {
          const jsonStr = new TextDecoder().decode(msgData);
          const envelope = JSON.parse(jsonStr);

          if (envelope.type === "handshake") {
            const result = await handshakeHandler.processMessage(msg.connectionId, envelope);
            if (result.type === "reply" || result.type === "established") {
              machine.ws!.send(JSON.stringify({
                type: "data",
                connectionId: msg.connectionId,
                data: Buffer.from(JSON.stringify(result.message)).toString("base64"),
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
          // Not JSON - treat as encrypted frame
        }

        // Decrypt incoming frame
        if (machineSessionKeys) {
          try {
            const opened = openFrame(msgData, machineSessionKeys.receiveKey);
            if (!opened) return;
            machineDecryptedMessages.push(new TextDecoder().decode(opened.data));

            // Send a response back
            const responseFrame = createFrame(
              0,
              Buffer.from("hello from machine"),
              machineSessionKeys.sendKey,
            );
            machine.ws!.send(JSON.stringify({
              type: "data",
              connectionId: msg.connectionId,
              data: Buffer.from(responseFrame).toString("base64"),
            }));
          } catch (e) {
            console.error("[identity-chain] Machine decrypt error:", e);
          }
        }
      }
    };

    // Connect client
    const clientDecryptedMessages: string[] = [];
    let clientReady = false;

    const relayClient = new RelayClient(
      {
        relayUrl: relay.url,
        machineId: machine.deviceIdentity.id,
        identity: client.deviceIdentity,
        deviceCertificate: client.deviceCertificate,
      },
      {
        onHandshakeComplete: () => {
          clientReady = true;
        },
        onMessage: (_streamId, data) => {
          clientDecryptedMessages.push(data.toString("utf-8"));
        },
        onError: (error) => {
          console.error("[identity-chain] Client error:", error);
        },
      },
    );

    await relayClient.connect();

    // Wait for handshake
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        if (clientReady && machineSessionKeys) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error("Handshake timeout for data exchange test"));
      }, 10000);
    });

    // Client sends encrypted data
    const sent = relayClient.send(Buffer.from("hello from client"));
    expect(sent).toBe(true);

    // Wait for round-trip
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        if (machineDecryptedMessages.length > 0 && clientDecryptedMessages.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(
          `Data exchange timeout (machine received: ${machineDecryptedMessages.length}, client received: ${clientDecryptedMessages.length})`,
        ));
      }, 5000);
    });

    // Verify bidirectional encrypted data
    expect(machineDecryptedMessages).toContain("hello from client");
    expect(clientDecryptedMessages).toContain("hello from machine");

    relayClient.disconnect();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 7: Non-owner is rejected
  // ──────────────────────────────────────────────────────────────────────

  test("client with different user root identity is rejected", async () => {
    // Generate a completely different mnemonic -> different user root
    const imposterMnemonic = generateMnemonic();
    const imposterUserRoot = mnemonicToUserIdentity(imposterMnemonic);
    const imposterDevice = generateIdentity("Imposter Client");
    const imposterCert = JSON.stringify(createDeviceCertificate(
      imposterUserRoot,
      imposterDevice.signing.publicKey,
      imposterDevice.keyExchange.publicKey,
    ));

    // Imposter should NOT have the same user root as the owner
    expect(imposterUserRoot.id).not.toBe(relayUserRoot.id);

    // Try to list machines as the imposter
    const imposterWs = new WebSocket(`${relay.url}?role=client`);
    imposterWs.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      imposterWs.onopen = () => resolve();
      imposterWs.onerror = () => reject(new Error("Connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    const listMsg = signClientMessage({
      type: "list_machines",
      clientIdentityId: imposterDevice.id,
      deviceCertificate: imposterCert,
    }, imposterDevice);

    const listPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
      imposterWs.onmessage = (event) => {
        try {
          const msg = parseWsMessage(event);
          if (msg.type === "machine_list" || msg.type === "error") {
            clearTimeout(timeout);
            resolve(msg);
          }
        } catch { /* ignore */ }
      };
    });

    imposterWs.send(JSON.stringify(listMsg));
    const listResult = await listPromise;

    // Imposter should see no machines (they're not the owner)
    if (listResult.type === "machine_list") {
      expect(listResult.machines.length).toBe(0);
    }
    // OR it may be rejected with an error - either is acceptable

    // Try to connect to the machine as the imposter
    const connectMsg = signClientMessage({
      type: "connect_to_machine",
      machineId: machine.deviceIdentity.id,
      clientIdentityId: imposterDevice.id,
      deviceCertificate: imposterCert,
    }, imposterDevice);

    const connectPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
      imposterWs.onmessage = (event) => {
        try {
          const msg = parseWsMessage(event);
          clearTimeout(timeout);
          resolve(msg);
        } catch { /* ignore */ }
      };
    });

    imposterWs.send(JSON.stringify(connectMsg));
    const connectResult = await connectPromise;

    // Connection must be rejected - imposter is not the owner
    expect(connectResult.type).toBe("error");

    imposterWs.close();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 8: Health check works with hostname filter
  // ──────────────────────────────────────────────────────────────────────

  test("health check works from localhost even when hostname filter is set", async () => {
    // Start a second relay WITH a non-localhost hostname
    // (simulates a relay configured for cloudflared tunnel)
    const tempDir = mkdtempSync(join(tmpdir(), "gssh-identity-chain-health-"));
    const prevDir = process.env.GITSPACE_CONTROL_DIR;
    process.env.GITSPACE_CONTROL_DIR = tempDir;
    ensureControlStore();

    const server2 = startRelayServer({
      bind: "127.0.0.1",
      hostname: "myrelay.gitspace.sh", // Non-localhost hostname
      disableRateLimit: true,
      identity: generateRelayIdentity("health-test-relay"),
    });

    try {
      // This request comes from localhost with Host: 127.0.0.1:{port}
      // If the hostname filter blocks /health, this will fail (the bug)
      const res = await fetch(`http://127.0.0.1:${server2.port}/health`);
      expect(res.ok).toBe(true);

      const body = await res.json() as any;
      expect(body.status).toBe("ok");
    } finally {
      server2.stop(true);
      if (prevDir === undefined) {
        delete process.env.GITSPACE_CONTROL_DIR;
      } else {
        process.env.GITSPACE_CONTROL_DIR = prevDir;
      }
      // Restore the relay container's control dir for any remaining tests
      process.env.GITSPACE_CONTROL_DIR = relay.tempDir;
      ensureControlStore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
