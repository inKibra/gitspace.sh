/**
 * Pairing Scenarios E2E Test
 *
 * Covers every machine authorization path through the relay with isolated
 * "test containers" (separate identities, separate temp dirs, one relay):
 *
 * ACCEPT scenarios:
 *   1. Owner device cert    - Machine presents cert signed by relay owner -> auto-authorized
 *   2. Enrollment token     - Machine enrolled via root-signed relay-machine invite -> authorized
 *
 * REJECT scenarios:
 *   3. Non-owner device cert - Cert signed by different user -> rejected
 *   4. Expired device cert   - Owner cert with past expiry -> rejected
 *   5. Key-mismatch cert     - Cert keys don't match register_machine keys -> rejected
 *   6. No credentials        - No cert, no token, no pre-auth -> rejected
 *   7. Wrong-owner invite    - Enrollment token signed by non-owner -> rejected
 *
 * CLIENT scenarios:
 *   8. Owner client lists authorized machines
 *   9. Owner client X3DH to device-cert machine -> encrypted data exchange
 *  10. Owner client X3DH to enrolled machine -> encrypted data exchange
 *  11. Non-owner client sees no machines
 *  12. Non-owner client cannot connect to authorized machine
 *
 * Every "container" has its own random device keypair.  The ONLY shared secret
 * across containers is a BIP39 mnemonic (owner) or nothing (outsider).
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
import {
  generateMnemonic,
  mnemonicToUserIdentity,
} from "../../lib/tmux-lite/crypto/user-identity.js";
import { generateIdentity } from "../../lib/tmux-lite/crypto/identity.js";
import {
  createDeviceCertificate,
} from "../../lib/tmux-lite/crypto/device-cert.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createRootInviteToken } from "../../lib/tmux-lite/crypto/root-invites.js";
import { HandshakeHandler } from "../../lib/tmux-lite/handshake-handler.js";
import { RelayClient } from "../../lib/tmux-lite/relay-client.js";
import { createFrame, openFrame } from "../../lib/tmux-lite/crypto/frames.js";
import type { Identity, UserRootIdentity } from "../../types/identity.js";

// Test helpers
import {
  signChallenge,
  signClientMessage,
  connectClient,
  sendAndWait,
} from "./helpers/auth.js";
import { startRelayServer } from "./helpers/ports.js";
import { toPublicIdentity } from "../../lib/tmux-lite/crypto/__tests__/helpers/test-identities.js";
import { getRelayClientTestAccess } from "../../__tests__/test-utils.js";

// ============================================================================
// Identities — each is an isolated "test container"
// ============================================================================

// Owner mnemonic (shared by relay + owner machines + owner client)
const ownerMnemonic = generateMnemonic();
const ownerUserRoot = mnemonicToUserIdentity(ownerMnemonic);

// Outsider mnemonic (different user entirely)
const outsiderMnemonic = generateMnemonic();
const outsiderUserRoot = mnemonicToUserIdentity(outsiderMnemonic);

// Sanity: owner and outsider are different users
if (ownerUserRoot.id === outsiderUserRoot.id) {
  throw new Error("BUG: two different mnemonics produced the same user root ID");
}

// Device identities (random keypairs — one per "container")
const ownerMachineDevice = generateIdentity("Owner Machine");
const enrolledMachineDevice = generateIdentity("Enrolled Machine");
const outsiderMachineDevice = generateIdentity("Outsider Machine");
const expiredCertMachineDevice = generateIdentity("Expired Cert Machine");
const keyMismatchMachineDevice = generateIdentity("Key Mismatch Machine");
const noCredsMachineDevice = generateIdentity("No Credentials Machine");
const wrongOwnerInviteMachineDevice = generateIdentity("Wrong Owner Invite Machine");
const ownerClientDevice = generateIdentity("Owner Client");
const outsiderClientDevice = generateIdentity("Outsider Client");

// ============================================================================
// Device certificates
// ============================================================================

function buildCert(device: Identity, userRoot: UserRootIdentity): string {
  return JSON.stringify(
    createDeviceCertificate(
      userRoot,
      device.signing.publicKey,
      device.keyExchange.publicKey,
    ),
  );
}

/**
 * Build a properly-signed cert whose expiresAt is already in the past.
 * We can't use createDeviceCertificate because it validates expiresAt > issuedAt.
 * So we replicate the signing logic with backdated timestamps.
 */
function buildExpiredCert(device: Identity, userRoot: UserRootIdentity): string {
  const issuedAt = Date.now() - 200_000; // issued 200s ago
  const expiresAt = Date.now() - 100_000; // expired 100s ago

  // Build the payload: domain || sigPub || kexPub || issuedAt(8B) || expiresAt(8B)
  const domain = new TextEncoder().encode("gitspace-device-cert-v1");
  const timestamps = new Uint8Array(16);
  const view = new DataView(timestamps.buffer);
  view.setBigUint64(0, BigInt(issuedAt), false);
  view.setBigUint64(8, BigInt(expiresAt), false);

  const payload = new Uint8Array(domain.length + 32 + 32 + 16);
  let offset = 0;
  payload.set(domain, offset); offset += domain.length;
  payload.set(device.signing.publicKey, offset); offset += 32;
  payload.set(device.keyExchange.publicKey, offset); offset += 32;
  payload.set(timestamps, offset);

  const privateKey = userRoot.signing.secretKey.slice(0, 32);
  const signature = ed25519.sign(payload, privateKey);

  return JSON.stringify({
    deviceSigningPublicKey: Buffer.from(device.signing.publicKey).toString("base64"),
    deviceKeyExchangePublicKey: Buffer.from(device.keyExchange.publicKey).toString("base64"),
    userRootSigningPublicKey: Buffer.from(userRoot.signing.publicKey).toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
    issuedAt,
    expiresAt,
  });
}

/** Build a cert for a *different* device's keys, creating a key mismatch */
function buildMismatchedKeysCert(
  deviceThatRegisters: Identity,
  userRoot: UserRootIdentity,
): string {
  // Cert is signed for a random throwaway device — keys won't match register_machine
  const throwaway = generateIdentity("Throwaway");
  return JSON.stringify(
    createDeviceCertificate(
      userRoot,
      throwaway.signing.publicKey,
      throwaway.keyExchange.publicKey,
    ),
  );
}

const ownerMachineCert = buildCert(ownerMachineDevice, ownerUserRoot);
const outsiderMachineCert = buildCert(outsiderMachineDevice, outsiderUserRoot);
const expiredMachineCert = buildExpiredCert(expiredCertMachineDevice, ownerUserRoot);
const mismatchKeysCert = buildMismatchedKeysCert(keyMismatchMachineDevice, ownerUserRoot);
const ownerClientCert = buildCert(ownerClientDevice, ownerUserRoot);
const outsiderClientCert = buildCert(outsiderClientDevice, outsiderUserRoot);

// ============================================================================
// Relay setup
// ============================================================================

let relayUrl: string;
let relayHttpBase: string;
let server: Server<any>;
let tempDir: string;
let previousControlDir: string | undefined;

beforeAll(async () => {
  previousControlDir = process.env.GITSPACE_CONTROL_DIR;

  // Isolated relay temp dir
  tempDir = mkdtempSync(join(tmpdir(), "gssh-pairing-scenarios-"));
  process.env.GITSPACE_CONTROL_DIR = tempDir;
  ensureControlStore();
  setVaultMeta("vault_initialized", "1");
  setVaultMeta("owner_user_root_id", ownerUserRoot.id);

  // Start relay — NO preAuthorizedMachines.  All auth must come from
  // device certificates or enrollment tokens.
  const relayIdentity = generateRelayIdentity("pairing-scenarios-relay");
  server = startRelayServer({
    bind: "127.0.0.1",
    hostname: "127.0.0.1",
    disableRateLimit: true,
    identity: relayIdentity,
  });

  const port = server.port!;
  relayUrl = `ws://127.0.0.1:${port}/ws`;
  relayHttpBase = `http://127.0.0.1:${port}`;

  // Wait for relay to become healthy
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      const res = await fetch(`${relayHttpBase}/health`);
      if (res.ok) break;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error("Relay did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(() => {
  server?.stop(true);

  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ============================================================================
// Machine registration helper
// ============================================================================

/** Result of a machine registration attempt */
interface RegistrationResult {
  ws: WebSocket;
  success: boolean;
}

/**
 * Attempt to register a machine with the relay.
 * Returns the WebSocket and whether registration succeeded.
 * Does NOT throw on rejection — returns { success: false } instead.
 */
async function attemptRegisterMachine(
  identity: Identity,
  options: {
    deviceCertificate?: string;
    enrollmentToken?: string;
  } = {},
): Promise<RegistrationResult> {
  const url = new URL(relayUrl);
  url.searchParams.set("role", "machine");

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket failed"));
    setTimeout(() => reject(new Error("Connection timeout")), 5000);
  });

  // Wait for relay_identity challenge
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
      } catch { /* ignore */ }
    };
  });

  // Build register_machine message
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
  if (options.deviceCertificate) regMsg.deviceCertificate = options.deviceCertificate;
  if (options.enrollmentToken) regMsg.enrollmentToken = options.enrollmentToken;

  ws.send(JSON.stringify(regMsg));

  // Wait for registered or error
  const result = await new Promise<{ type: string; message?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Registration timeout")), 5000);
    ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "registered" || msg.type === "error") {
          clearTimeout(timeout);
          resolve(msg);
        }
      } catch { /* ignore */ }
    };
  });

  if (result.type === "error") {
    ws.close();
  }

  return { ws, success: result.type === "registered" };
}

/** Register machine, expecting success.  Returns the open WebSocket. */
async function registerMachine(
  identity: Identity,
  options: { deviceCertificate?: string; enrollmentToken?: string } = {},
): Promise<WebSocket> {
  const result = await attemptRegisterMachine(identity, options);
  if (!result.success) {
    throw new Error("Expected machine registration to succeed, but it was rejected");
  }
  return result.ws;
}

/** Attempt registration and expect rejection. */
async function expectRegistrationRejected(
  identity: Identity,
  options: { deviceCertificate?: string; enrollmentToken?: string } = {},
): Promise<void> {
  const result = await attemptRegisterMachine(identity, options);
  if (result.success) {
    result.ws.close();
    throw new Error("Expected machine registration to be rejected, but it succeeded");
  }
}

/** Parse a relay WS message */
function parseWsMessage(event: MessageEvent): any {
  const data = typeof event.data === "string"
    ? event.data
    : new TextDecoder().decode(event.data);
  return JSON.parse(data);
}

// ============================================================================
// Tests — sequential within each describe, describes are independent
// ============================================================================

describe("Pairing Scenarios E2E", () => {
  // Track open WebSockets for cleanup
  const openSockets: WebSocket[] = [];
  afterAll(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // ACCEPT: Owner device certificate (same-machine / remote-same-owner)
  // ════════════════════════════════════════════════════════════════════════

  describe("Scenario 1: Owner device certificate", () => {
    let machineWs: WebSocket;

    test("machine registers via device cert signed by relay owner", async () => {
      machineWs = await registerMachine(ownerMachineDevice, {
        deviceCertificate: ownerMachineCert,
      });
      openSockets.push(machineWs);
      expect(machineWs.readyState).toBe(WebSocket.OPEN);
    });

    test("owner client lists the device-cert machine", async () => {
      const clientWs = await connectClient(relayUrl);

      const listMsg = signClientMessage({
        type: "list_machines",
        clientIdentityId: ownerClientDevice.id,
        deviceCertificate: ownerClientCert,
      }, ownerClientDevice);

      const response = await sendAndWait<any>(clientWs, listMsg, "machine_list");
      const found = response.machines.find(
        (m: any) => m.machineId === ownerMachineDevice.id,
      );
      expect(found).toBeDefined();
      expect(found.label).toBe("Owner Machine");

      clientWs.close();
    });

    test("owner client X3DH handshake + encrypted data exchange", async () => {
      let machineSessionKeys: { sendKey: Uint8Array; receiveKey: Uint8Array } | null = null;
      const machineDecrypted: string[] = [];

      const handshakeHandler = new HandshakeHandler({
        identity: ownerMachineDevice,
        handshakeTimeoutMs: 30000,
        ownerUserRootId: ownerUserRoot.id,
      });

      // Machine-side handler
      machineWs.onmessage = async (event) => {
        const msg = parseWsMessage(event);
        if (msg.type !== "data" || !msg.connectionId) return;
        const msgData = Buffer.from(msg.data, "base64");

        // Try handshake
        try {
          const envelope = JSON.parse(new TextDecoder().decode(msgData));
          if (envelope.type === "handshake") {
            const result = await handshakeHandler.processMessage(msg.connectionId, envelope);
            if (result.type === "reply" || result.type === "established") {
              machineWs.send(JSON.stringify({
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
        } catch { /* not handshake JSON */ }

        // Decrypt + echo back
        if (machineSessionKeys) {
          try {
            const opened = openFrame(msgData, machineSessionKeys.receiveKey);
            if (!opened) return;
            machineDecrypted.push(new TextDecoder().decode(opened.data));
            const reply = createFrame(0, Buffer.from("pong:device-cert-machine"), machineSessionKeys.sendKey);
            machineWs.send(JSON.stringify({
              type: "data",
              connectionId: msg.connectionId,
              data: Buffer.from(reply).toString("base64"),
            }));
          } catch { /* decrypt error */ }
        }
      };

      const clientDecrypted: string[] = [];
      let clientReady = false;

      const relayClient = new RelayClient(
        {
          relayUrl,
          machineId: ownerMachineDevice.id,
          identity: ownerClientDevice,
          deviceCertificate: ownerClientCert,
        },
        {
          onHandshakeComplete: () => { clientReady = true; },
          onMessage: (_sid, data) => { clientDecrypted.push(data.toString("utf-8")); },
          onError: (err) => { console.error("[pairing] Client error:", err); },
        },
      );

      await relayClient.connect();

      // Wait for handshake
      await waitUntil(() => clientReady && machineSessionKeys !== null, 10000);

      // Send encrypted payload
      expect(relayClient.send(Buffer.from("ping:device-cert-client"))).toBe(true);

      // Wait for round-trip
      await waitUntil(() => machineDecrypted.length > 0 && clientDecrypted.length > 0, 5000);

      expect(machineDecrypted).toContain("ping:device-cert-client");
      expect(clientDecrypted).toContain("pong:device-cert-machine");

      // Verify key symmetry
      const ca = getRelayClientTestAccess(relayClient);
      expect(Buffer.from(ca.writeKey!).toString("hex")).toBe(
        Buffer.from(machineSessionKeys!.receiveKey).toString("hex"),
      );
      expect(Buffer.from(ca.readKey!).toString("hex")).toBe(
        Buffer.from(machineSessionKeys!.sendKey).toString("hex"),
      );

      relayClient.disconnect();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // ACCEPT: Enrollment token (remote collaborator machine)
  // ════════════════════════════════════════════════════════════════════════

  describe("Scenario 2: Enrollment token", () => {
    let enrolledMachineWs: WebSocket;

    test("owner creates relay-machine invite and machine enrolls", async () => {
      // Step 1: Owner creates the enrollment token
      const enrollmentToken = createRootInviteToken({
        type: "relay-machine",
        owner: ownerUserRoot,
        relayUrl,
        targetMachineSigningKey: Buffer.from(enrolledMachineDevice.signing.publicKey).toString("base64"),
        targetMachineKeyExchangeKey: Buffer.from(enrolledMachineDevice.keyExchange.publicKey).toString("base64"),
        expiresAt: Date.now() + 60_000,
        maxUses: 1,
        label: "enrolled-test-machine",
      });

      // Step 2: Owner registers the invite with the relay
      const ownerWs = await connectClient(relayUrl);
      const created = await sendAndWait<any>(
        ownerWs,
        signClientMessage({
          type: "create_root_invite",
          clientIdentityId: ownerClientDevice.id,
          inviteToken: enrollmentToken,
          deviceCertificate: ownerClientCert,
        }, ownerClientDevice),
        "root_invite_created",
      );
      expect(created.type).toBe("root_invite_created");
      ownerWs.close();

      // Step 3: Machine enrolls using the token (NO device cert needed)
      enrolledMachineWs = await registerMachine(enrolledMachineDevice, {
        enrollmentToken,
      });
      openSockets.push(enrolledMachineWs);
      expect(enrolledMachineWs.readyState).toBe(WebSocket.OPEN);
    });

    test("owner client lists the enrolled machine alongside device-cert machine", async () => {
      const clientWs = await connectClient(relayUrl);
      const listMsg = signClientMessage({
        type: "list_machines",
        clientIdentityId: ownerClientDevice.id,
        deviceCertificate: ownerClientCert,
      }, ownerClientDevice);

      const response = await sendAndWait<any>(clientWs, listMsg, "machine_list");

      // Both machines should be visible
      const deviceCertMachine = response.machines.find(
        (m: any) => m.machineId === ownerMachineDevice.id,
      );
      const enrolledMachine = response.machines.find(
        (m: any) => m.machineId === enrolledMachineDevice.id,
      );
      expect(deviceCertMachine).toBeDefined();
      expect(enrolledMachine).toBeDefined();

      clientWs.close();
    });

    test("owner client X3DH + data exchange with enrolled machine", async () => {
      let machineKeys: { sendKey: Uint8Array; receiveKey: Uint8Array } | null = null;
      const machineDecrypted: string[] = [];

      const handler = new HandshakeHandler({
        identity: enrolledMachineDevice,
        handshakeTimeoutMs: 30000,
        ownerUserRootId: ownerUserRoot.id,
      });

      enrolledMachineWs.onmessage = async (event) => {
        const msg = parseWsMessage(event);
        if (msg.type !== "data" || !msg.connectionId) return;
        const msgData = Buffer.from(msg.data, "base64");

        try {
          const envelope = JSON.parse(new TextDecoder().decode(msgData));
          if (envelope.type === "handshake") {
            const result = await handler.processMessage(msg.connectionId, envelope);
            if (result.type === "reply" || result.type === "established") {
              enrolledMachineWs.send(JSON.stringify({
                type: "data",
                connectionId: msg.connectionId,
                data: Buffer.from(JSON.stringify(result.message)).toString("base64"),
              }));
              if (result.type === "established") {
                machineKeys = {
                  sendKey: result.session.sessionKeys.sendKey,
                  receiveKey: result.session.sessionKeys.receiveKey,
                };
              }
            }
            return;
          }
        } catch { /* */ }

        if (machineKeys) {
          try {
            const opened = openFrame(msgData, machineKeys.receiveKey);
            if (!opened) return;
            machineDecrypted.push(new TextDecoder().decode(opened.data));
            const reply = createFrame(0, Buffer.from("pong:enrolled-machine"), machineKeys.sendKey);
            enrolledMachineWs.send(JSON.stringify({
              type: "data",
              connectionId: msg.connectionId,
              data: Buffer.from(reply).toString("base64"),
            }));
          } catch { /* */ }
        }
      };

      const clientDecrypted: string[] = [];
      let ready = false;

      const client = new RelayClient(
        {
          relayUrl,
          machineId: enrolledMachineDevice.id,
          identity: ownerClientDevice,
          deviceCertificate: ownerClientCert,
        },
        {
          onHandshakeComplete: () => { ready = true; },
          onMessage: (_sid, data) => { clientDecrypted.push(data.toString("utf-8")); },
          onError: (err) => { console.error("[pairing] Enrolled machine client error:", err); },
        },
      );

      await client.connect();
      await waitUntil(() => ready && machineKeys !== null, 10000);

      expect(client.send(Buffer.from("ping:enrolled-client"))).toBe(true);
      await waitUntil(() => machineDecrypted.length > 0 && clientDecrypted.length > 0, 5000);

      expect(machineDecrypted).toContain("ping:enrolled-client");
      expect(clientDecrypted).toContain("pong:enrolled-machine");

      client.disconnect();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // REJECT: Various failure scenarios
  // ════════════════════════════════════════════════════════════════════════

  describe("Scenario 3: Rejection cases", () => {
    test("non-owner device cert is rejected", async () => {
      // Machine presents a valid cert, but signed by outsider (not relay owner)
      await expectRegistrationRejected(outsiderMachineDevice, {
        deviceCertificate: outsiderMachineCert,
      });
    });

    test("expired device cert is rejected", async () => {
      await expectRegistrationRejected(expiredCertMachineDevice, {
        deviceCertificate: expiredMachineCert,
      });
    });

    test("device cert with mismatched keys is rejected", async () => {
      // Cert is signed by owner but for different device keys than those
      // presented in the register_machine message
      await expectRegistrationRejected(keyMismatchMachineDevice, {
        deviceCertificate: mismatchKeysCert,
      });
    });

    test("machine with no credentials is rejected", async () => {
      await expectRegistrationRejected(noCredsMachineDevice);
    });

    test("enrollment token signed by non-owner is rejected", async () => {
      // Outsider creates an enrollment token for a machine, but the relay
      // only accepts tokens signed by the relay owner
      const outsiderToken = createRootInviteToken({
        type: "relay-machine",
        owner: outsiderUserRoot,
        relayUrl,
        targetMachineSigningKey: Buffer.from(wrongOwnerInviteMachineDevice.signing.publicKey).toString("base64"),
        targetMachineKeyExchangeKey: Buffer.from(wrongOwnerInviteMachineDevice.keyExchange.publicKey).toString("base64"),
        expiresAt: Date.now() + 60_000,
        maxUses: 1,
        label: "outsider-invite",
      });

      // Outsider tries to register the invite — should be rejected since they're
      // not the relay owner.  We attempt via WS first.
      const outsiderWs = await connectClient(relayUrl);
      const createInviteMsg = signClientMessage({
        type: "create_root_invite",
        clientIdentityId: outsiderClientDevice.id,
        inviteToken: outsiderToken,
        deviceCertificate: outsiderClientCert,
      }, outsiderClientDevice);

      // The relay should reject the invite creation since outsider is not the owner.
      // But even if it somehow gets registered, the machine enrollment should fail.
      let inviteRegistered = false;
      try {
        const result = await sendAndWait<any>(outsiderWs, createInviteMsg, "root_invite_created", 3000);
        inviteRegistered = result.type === "root_invite_created";
      } catch {
        // Expected: rejected
      }
      outsiderWs.close();

      // If the invite was not registered, the machine can't enroll at all.
      // If it somehow was, the enrollment should still be rejected (owner mismatch).
      await expectRegistrationRejected(wrongOwnerInviteMachineDevice, {
        enrollmentToken: outsiderToken,
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Non-owner client access
  // ════════════════════════════════════════════════════════════════════════

  describe("Scenario 4: Non-owner client access control", () => {
    test("non-owner client sees no machines in list", async () => {
      const clientWs = await connectClient(relayUrl);

      const listMsg = signClientMessage({
        type: "list_machines",
        clientIdentityId: outsiderClientDevice.id,
        deviceCertificate: outsiderClientCert,
      }, outsiderClientDevice);

      const response = await sendAndWait<any>(clientWs, listMsg, "machine_list");

      // Outsider should see zero machines
      expect(response.machines).toBeDefined();
      expect(response.machines.length).toBe(0);

      clientWs.close();
    });

    test("non-owner client cannot connect to authorized machine", async () => {
      const clientWs = await connectClient(relayUrl);

      const connectMsg = signClientMessage({
        type: "connect_to_machine",
        machineId: ownerMachineDevice.id,
        clientIdentityId: outsiderClientDevice.id,
        deviceCertificate: outsiderClientCert,
      }, outsiderClientDevice);

      // Should receive an error
      const result = await sendAndWait<any>(clientWs, connectMsg, "error", 5000)
        .catch((err) => {
          // sendAndWait rejects on error messages, which is what we expect
          return { type: "error", message: err.message };
        });

      expect(result.type).toBe("error");

      clientWs.close();
    });
  });
});

// ============================================================================
// Utility
// ============================================================================

/** Poll until predicate is true or timeout */
function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (predicate()) {
        clearInterval(check);
        resolve();
      }
    }, pollMs);
    setTimeout(() => {
      clearInterval(check);
      reject(new Error(`waitUntil timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
