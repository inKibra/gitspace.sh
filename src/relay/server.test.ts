import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayServer } from "./server";
import { generateRelayIdentity } from "./identity";
import { clearAllRegistries } from "./registries";
import {
  createTestIdentity,
  toPublicIdentity,
} from "../lib/tmux-lite/crypto/__tests__/helpers/test-identities";
import {
  signChallenge,
  getSigningKeyBase64,
  connectMachineWithAuth,
  connectClient,
  signClientMessage,
  sendAndWait,
  waitForMessage,
} from "./__tests__/helpers/auth";
import { startRelayServer } from "./__tests__/helpers/ports";
import type { Server } from "bun";
import type { Identity, UserRootIdentity } from "../types/identity";
import { generateEphemeralKeypair } from "../lib/tmux-lite/crypto/keyexchange";
import {
  createCloudBootstrapToken,
  ensureControlStore,
  listVaultMachinesForOwner,
  setVaultMeta,
  upsertCloudWorkspace,
} from "./control/store";
import {
  grantMachineAccess,
  grantRelayAccess,
  listMachineAccessList,
  listRelayAccessList,
  registerRootInvite,
  revokeMachineAccess,
  revokeRelayAccess,
} from "./auth/store";
import { createDeviceCertificate } from "../lib/tmux-lite/crypto/device-cert";
import {
  createRootInviteToken,
  parseRootInviteToken,
} from "../lib/tmux-lite/crypto/root-invites";
import { generateMnemonic, mnemonicToUserIdentity } from "../lib/tmux-lite/crypto/user-identity";

const TEST_HOST = "127.0.0.1";
let relayUrl = "";
let relayHttpBase = "";

// Generate identities for testing
const testRelayIdentity = generateRelayIdentity("test-relay");
const testMachine1 = createTestIdentity("Test Machine 1");
const testMachine2 = createTestIdentity("Test Machine 2");
const testClient1 = createTestIdentity("Test Client 1");
const testClient2 = createTestIdentity("Test Client 2");
const ownerUserRoot = mnemonicToUserIdentity(generateMnemonic());
const client1UserRoot = mnemonicToUserIdentity(generateMnemonic());
const client2UserRoot = mnemonicToUserIdentity(generateMnemonic());
const outsiderUserRoot = mnemonicToUserIdentity(generateMnemonic());

let server: Server<any>;
let tempControlDir: string;
let previousControlDir: string | undefined;

beforeAll(async () => {
  previousControlDir = process.env.GITSPACE_CONTROL_DIR;
  tempControlDir = mkdtempSync(join(tmpdir(), "gssh-relay-server-test-"));
  process.env.GITSPACE_CONTROL_DIR = tempControlDir;
  ensureControlStore();
  setVaultMeta("vault_initialized", "1");
  setVaultMeta("owner_user_root_id", ownerUserRoot.id);

  server = startRelayServer({
    bind: TEST_HOST,
    hostname: TEST_HOST,
    disableRateLimit: true,
    identity: testRelayIdentity,
    preAuthorizedMachines: new Set([
      getSigningKeyBase64(testMachine1),
      getSigningKeyBase64(testMachine2),
    ]),
  });
  relayUrl = `ws://${TEST_HOST}:${server.port}/ws`;
  relayHttpBase = `http://${TEST_HOST}:${server.port}`;

  // Wait for server to start accepting requests to avoid flakiness.
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
  server.stop(true);

  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  rmSync(tempControlDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear registries between tests
  clearAllRegistries();

  // Clear relay + machine ACL grants for owner between tests.
  for (const entry of listRelayAccessList(ownerUserRoot.id)) {
    revokeRelayAccess(ownerUserRoot.id, entry.clientUserRootId);
  }
  for (const machine of listVaultMachinesForOwner(ownerUserRoot.id)) {
    for (const entry of listMachineAccessList(machine.machineId, ownerUserRoot.id)) {
      revokeMachineAccess(machine.machineId, ownerUserRoot.id, entry.clientUserRootId);
    }
  }
});

function buildDeviceCertificate(identity: Identity, userRoot = client1UserRoot): string {
  const cert = createDeviceCertificate(
    userRoot,
    identity.signing.publicKey,
    identity.keyExchange.publicKey,
  );
  return JSON.stringify(cert);
}

function createRelayMachineEnrollmentInviteToken(
  machine: Identity,
  options: {
    owner?: UserRootIdentity;
    expiresAt?: number;
    maxUses?: number | null;
    label?: string;
  } = {},
): string {
  const {
    owner = ownerUserRoot,
    expiresAt = Date.now() + 60_000,
    maxUses = 1,
    label,
  } = options;

  return createRootInviteToken({
    type: 'relay-machine',
    owner,
    relayUrl,
    targetMachineSigningKey: Buffer.from(machine.signing.publicKey).toString('base64'),
    targetMachineKeyExchangeKey: Buffer.from(machine.keyExchange.publicKey).toString('base64'),
    expiresAt,
    maxUses,
    label,
  });
}

function registerRootInviteTokenForTests(token: string): void {
  const parsed = parseRootInviteToken(token);
  if (!parsed) {
    throw new Error('Failed to parse root invite token in test setup');
  }

  registerRootInvite({
    inviteId: parsed.inviteId,
    ownerUserRootId: parsed.ownerUserRootId,
    inviteType: parsed.type,
    relayUrl: parsed.relayUrl,
    token,
    maxUses: parsed.maxUses,
    expiresAt: new Date(parsed.expiresAt).toISOString(),
    label: parsed.label,
    targetUserRootId:
      parsed.type === 'relay-user' || parsed.type === 'machine-user'
        ? parsed.targetUserRootId
        : undefined,
    machineId:
      parsed.type === 'relay-machine'
        ? parsed.targetMachineId
        : parsed.type === 'machine-user'
          ? parsed.machineId
          : undefined,
    targetMachineSigningKey: parsed.type === 'relay-machine' ? parsed.targetMachineSigningKey : undefined,
    targetMachineKeyExchangeKey: parsed.type === 'relay-machine' ? parsed.targetMachineKeyExchangeKey : undefined,
  });
}

// ============================================================================
// Helper to connect a machine with full challenge-response flow
// ============================================================================

async function connectAndRegisterMachine(
  identity: Identity,
  options?: { label?: string; enrollmentToken?: string; registerPermit?: string }
): Promise<WebSocket> {
  const { label = identity.label, enrollmentToken, registerPermit } = options ?? {};

  const url = new URL(relayUrl);
  url.searchParams.set("role", "machine");

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  // Wait for open
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Connection failed"));
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
  const signature = signChallenge(challenge, identity.signing.secretKey);
  const publicIdentity = toPublicIdentity(identity);

  // Send register_machine
  const registerMessage: Record<string, unknown> = {
    type: "register_machine",
    machineId: identity.id,
    signingKey: publicIdentity.signingPublicKey,
    keyExchangeKey: publicIdentity.keyExchangePublicKey,
    challengeResponse: signature,
    label,
  };

  if (enrollmentToken) {
    registerMessage.enrollmentToken = enrollmentToken;
  }

  if (registerPermit) {
    registerMessage.registerPermit = registerPermit;
  }

  ws.send(JSON.stringify(registerMessage));

  // Wait for registered
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
          reject(new Error(msg.message || "Registration failed"));
        }
      } catch {
        // Ignore
      }
    };
  });

  return ws;
}

// ============================================================================
// HTTP Endpoints
// ============================================================================

describe("HTTP endpoints", () => {
  test("GET /health returns stats", async () => {
    const res = await fetch(`${relayHttpBase}/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(typeof data.machineCount).toBe("number");
    expect(typeof data.connectedClients).toBe("number");
  });

  test("GET /unknown returns 404", async () => {
    const res = await fetch(`${relayHttpBase}/unknown`);
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// WebSocket Connections
// ============================================================================

describe("WebSocket connections", () => {
  test("rejects connection without role", async () => {
    // No role parameter - should be rejected with 400
    const ws = new WebSocket(relayUrl);

    const result = await new Promise<{ opened: boolean; error?: string }>((resolve) => {
      ws.onerror = () => {
        resolve({ opened: false, error: "Connection error" });
      };
      ws.onclose = (event) => {
        resolve({ opened: false, error: `Closed: ${event.code}` });
      };
      ws.onopen = () => {
        ws.close();
        resolve({ opened: true });
      };
      setTimeout(() => {
        ws.close();
        resolve({ opened: false, error: "Timeout" });
      }, 1000);
    });

    // Should be rejected at upgrade (role missing)
    expect(result.opened).toBe(false);
  });

  test("accepts machine connection and sends relay_identity", async () => {
    const ws = new WebSocket(`${relayUrl}?role=machine`);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Should receive relay_identity with challenge
    const relayIdentity = await new Promise<any>((resolve, reject) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "relay_identity") {
          resolve(msg);
        }
      };
      setTimeout(() => reject(new Error("Timeout waiting for relay_identity")), 2000);
    });

    expect(relayIdentity.type).toBe("relay_identity");
    expect(relayIdentity.publicKey).toBeDefined();
    expect(relayIdentity.fingerprint).toBeDefined();
    expect(relayIdentity.challenge).toBeDefined();

    ws.close();
  });

  test("accepts client connection", async () => {
    const ws = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ============================================================================
// Challenge-Response Authentication
// ============================================================================

describe("Challenge-response authentication", () => {
  test("machine registration with valid challenge response succeeds", async () => {
    const ws = await connectAndRegisterMachine(testMachine1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("machine registration with invalid challenge response fails", async () => {
    const ws = new WebSocket(`${relayUrl}?role=machine`);

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    // Wait for challenge
    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "relay_identity") resolve();
      };
    });

    // Send register_machine with invalid signature
    ws.send(JSON.stringify({
      type: "register_machine",
      machineId: testMachine1.id,
      signingKey: toPublicIdentity(testMachine1).signingPublicKey,
      keyExchangeKey: toPublicIdentity(testMachine1).keyExchangePublicKey,
      challengeResponse: Buffer.from("invalid-signature").toString("base64"),
      label: "Test",
    }));

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      ws.onclose = () => {
        resolve({ type: "closed" });
      };
      setTimeout(() => resolve({ type: "timeout" }), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message?.toLowerCase()).toMatch(/signature|verification|challenge/);

    ws.close();
  });

  test("unauthorized machine is rejected", async () => {
    // Create a machine that's not pre-authorized
    const unauthorizedMachine = createTestIdentity("Unauthorized Machine");

    const ws = new WebSocket(`${relayUrl}?role=machine`);

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    // Wait for challenge
    const challenge = await new Promise<Uint8Array>((resolve) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "relay_identity") {
          resolve(Buffer.from(msg.challenge, "base64"));
        }
      };
    });

    // Sign correctly but with unauthorized key
    const signature = signChallenge(challenge, unauthorizedMachine.signing.secretKey);
    const publicIdentity = toPublicIdentity(unauthorizedMachine);

    ws.send(JSON.stringify({
      type: "register_machine",
      machineId: unauthorizedMachine.id,
      signingKey: publicIdentity.signingPublicKey,
      keyExchangeKey: publicIdentity.keyExchangePublicKey,
      challengeResponse: signature,
      label: "Unauthorized",
    }));

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      ws.onclose = () => resolve({ type: "closed" });
      setTimeout(() => resolve({ type: "timeout" }), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message?.toLowerCase()).toMatch(/not authorized|unauthorized/);

    ws.close();
  });

  test("non-preauthorized machine can register with enrollment token", async () => {
    const enrollmentMachine = createTestIdentity("Enrollment Machine");
    const enrollmentToken = createRelayMachineEnrollmentInviteToken(enrollmentMachine, {
      label: "enroll-test",
    });
    registerRootInviteTokenForTests(enrollmentToken);

    const ws = await connectAndRegisterMachine(enrollmentMachine, {
      enrollmentToken,
    });

    const ownerMachines = listVaultMachinesForOwner(ownerUserRoot.id);
    expect(ownerMachines.some((m) => m.machineId === enrollmentMachine.id)).toBe(true);

    ws.close();
  });

  test("machine enrolled with token can reconnect without token", async () => {
    const enrollmentMachine = createTestIdentity("Enrollment Reconnect Machine");
    const enrollmentToken = createRelayMachineEnrollmentInviteToken(enrollmentMachine, {
      label: "enroll-reconnect",
    });
    registerRootInviteTokenForTests(enrollmentToken);

    const first = await connectAndRegisterMachine(enrollmentMachine, {
      enrollmentToken,
    });
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await connectAndRegisterMachine(enrollmentMachine);
    expect(second.readyState).toBe(WebSocket.OPEN);
    second.close();
  });

  test("enrollment token owner mismatch is rejected", async () => {
    const enrollmentMachine = createTestIdentity("Mismatched Enrollment Owner");
    const enrollmentToken = createRelayMachineEnrollmentInviteToken(enrollmentMachine, {
      owner: outsiderUserRoot,
      label: "owner-mismatch",
    });
    registerRootInviteTokenForTests(enrollmentToken);

    await expect(connectAndRegisterMachine(enrollmentMachine, {
      enrollmentToken,
    })).rejects.toThrow(/owner/i);
  });

  test("missing challengeResponse is rejected", async () => {
    const ws = new WebSocket(`${relayUrl}?role=machine`);

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    // Wait for challenge
    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "relay_identity") resolve();
      };
    });

    // Send register_machine WITHOUT challengeResponse
    ws.send(JSON.stringify({
      type: "register_machine",
      machineId: testMachine1.id,
      signingKey: toPublicIdentity(testMachine1).signingPublicKey,
      keyExchangeKey: toPublicIdentity(testMachine1).keyExchangePublicKey,
      // challengeResponse is missing
      label: "Test",
    }));

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => resolve({ type: "timeout" }), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message?.toLowerCase()).toContain("challenge");

    ws.close();
  });
});

// ============================================================================
// Protocol Messages
// ============================================================================

describe("Protocol messages", () => {
  test("create/list/revoke root invite flow", async () => {
    const ownerClient = createTestIdentity("Owner Invite Client");
    const inviteToken = createRootInviteToken({
      type: "relay-user",
      owner: ownerUserRoot,
      relayUrl,
      targetUserRootSigningKey: Buffer.from(client1UserRoot.signing.publicKey).toString("base64"),
      expiresAt: Date.now() + 60_000,
      maxUses: 2,
      label: "relay-user-flow",
    });
    const parsed = parseRootInviteToken(inviteToken);
    expect(parsed).not.toBeNull();

    const ownerWs = await connectClient(relayUrl);

    const created = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: "create_root_invite",
        clientIdentityId: ownerClient.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(ownerClient, ownerUserRoot),
      }, ownerClient),
      "root_invite_created",
    );

    expect(created.type).toBe("root_invite_created");
    expect(created.inviteId).toBe(parsed!.inviteId);

    const listed = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: "list_root_invites",
        clientIdentityId: ownerClient.id,
        deviceCertificate: buildDeviceCertificate(ownerClient, ownerUserRoot),
      }, ownerClient),
      "root_invite_list",
    );

    expect(listed.type).toBe("root_invite_list");
    expect(listed.invites.some((invite: { inviteId: string }) => invite.inviteId === parsed!.inviteId)).toBe(true);

    const revoked = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: "revoke_root_invite",
        clientIdentityId: ownerClient.id,
        inviteId: parsed!.inviteId,
        deviceCertificate: buildDeviceCertificate(ownerClient, ownerUserRoot),
      }, ownerClient),
      "root_invite_revoked",
    );

    expect(revoked.type).toBe("root_invite_revoked");
    expect(revoked.inviteId).toBe(parsed!.inviteId);

    ownerWs.close();
  });

  test("accept_root_invite grants relay access", async () => {
    const ownerClient = createTestIdentity("Owner Invite Creator");
    const inviteToken = createRootInviteToken({
      type: "relay-user",
      owner: ownerUserRoot,
      relayUrl,
      targetUserRootSigningKey: Buffer.from(client2UserRoot.signing.publicKey).toString("base64"),
      expiresAt: Date.now() + 60_000,
      maxUses: 1,
      label: "accept-relay-user",
    });

    const ownerWs = await connectClient(relayUrl);
    await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: "create_root_invite",
        clientIdentityId: ownerClient.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(ownerClient, ownerUserRoot),
      }, ownerClient),
      "root_invite_created",
    );

    const targetWs = await connectClient(relayUrl);
    const accepted = await sendAndWait<any>(
      targetWs,
      signClientMessage({
        type: "accept_root_invite",
        clientIdentityId: testClient2.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(testClient2, client2UserRoot),
      }, testClient2),
      "root_invite_accepted",
    );

    expect(accepted.type).toBe("root_invite_accepted");
    expect(accepted.inviteType).toBe("relay-user");
    expect(accepted.granted).toBe("relay");
    expect(
      listRelayAccessList(ownerUserRoot.id).some((entry) => entry.clientUserRootId === client2UserRoot.id),
    ).toBe(true);

    ownerWs.close();
    targetWs.close();
  });

  test("machine to client data routing", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "proto-routing",
    });
    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "proto-routing",
    });

    let clientConnectionId = "";
    const gotConnectionId = new Promise<void>((resolve) => {
      machineWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "client_connected") {
          clientConnectionId = msg.connectionId;
          resolve();
        }
      };
    });

    const clientWs = await connectClient(relayUrl);
    const connectResult = await sendAndWait<any>(
      clientWs,
      signClientMessage({
        type: "connect_to_machine",
        machineId: testMachine1.id,
        clientIdentityId: testClient1.id,
        deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
      }, testClient1),
      "connection_established",
    );

    expect(connectResult.type).toBe("connection_established");
    await gotConnectionId;

    const clientReceivedData = waitForMessage<any>(clientWs, "data", 2000);
    const testData = Buffer.from("Hello from machine").toString("base64");
    machineWs.send(JSON.stringify({
      type: "data",
      connectionId: clientConnectionId,
      data: testData,
    }));

    const receivedMsg = await clientReceivedData;
    expect(receivedMsg.type).toBe("data");
    expect(receivedMsg.data).toBe(testData);

    machineWs.close();
    clientWs.close();
  });

  test("client to machine data routing", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "proto-routing",
    });
    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "proto-routing",
    });

    let expectedClientConnectionId = "";
    const clientConnectedPromise = new Promise<void>((resolve) => {
      machineWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "client_connected") {
          expectedClientConnectionId = msg.connectionId;
          resolve();
        }
      };
    });

    const clientWs = await connectClient(relayUrl);
    const connectResult = await sendAndWait<any>(
      clientWs,
      signClientMessage({
        type: "connect_to_machine",
        machineId: testMachine1.id,
        clientIdentityId: testClient1.id,
        deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
      }, testClient1),
      "connection_established",
    );

    expect(connectResult.type).toBe("connection_established");
    await clientConnectedPromise;

    const machineReceivedData = waitForMessage<any>(machineWs, "data", 2000);
    const testData = Buffer.from("Hello from client").toString("base64");
    clientWs.send(JSON.stringify({
      type: "data",
      data: testData,
    }));

    const receivedMsg = await machineReceivedData;
    expect(receivedMsg.type).toBe("data");
    expect(receivedMsg.data).toBe(testData);
    expect(receivedMsg.connectionId).toBe(expectedClientConnectionId);

    machineWs.close();
    clientWs.close();
  });
});

describe("Unlock request gating", () => {
  test("rejects unlock_request with invalid token", async () => {
    const ws = new WebSocket(`${relayUrl}?role=machine`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "relay_identity") {
          const ephemeral = generateEphemeralKeypair();
          ws.send(JSON.stringify({
            type: "unlock_request",
            workspaceId: "ws-missing",
            unlockToken: "tok-invalid",
            ephemeralKey: Buffer.from(ephemeral.publicKey).toString("base64"),
          }));
          return;
        }

        if (msg.type === "error") {
          expect(msg.code).toBe("UNAUTHORIZED");
          const message = String(msg.message).toLowerCase();
          expect(message.includes("token") || message.includes("bootstrapping")).toBe(true);
          resolve();
          return;
        }
      };
      setTimeout(() => reject(new Error("Timeout waiting for unlock error")), 3000);
    });

    ws.close();
  });

  test("rejects unlock_request when workspace is not bootstrapping", async () => {
    const prevControlDir = process.env.GITSPACE_CONTROL_DIR;
    const tempControlDir = mkdtempSync(join(tmpdir(), "gssh-relay-unlock-test-"));
    process.env.GITSPACE_CONTROL_DIR = tempControlDir;

    try {
      ensureControlStore();
      upsertCloudWorkspace({
        id: "ws-not-bootstrapping",
        provider: "sprites",
        providerWorkspaceId: "sprite-1",
        machineId: "machine-1",
        machinePublicKey: "machine-signing-pub-1",
        status: "ready",
      });

      const token = createCloudBootstrapToken({
        workspaceId: "ws-not-bootstrapping",
        ownerIdentityId: "owner-1",
      });

      const ws = new WebSocket(`${relayUrl}?role=machine`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("Connection failed"));
        setTimeout(() => reject(new Error("Timeout")), 2000);
      });

      await new Promise<void>((resolve, reject) => {
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "relay_identity") {
            const ephemeral = generateEphemeralKeypair();
            ws.send(JSON.stringify({
              type: "unlock_request",
              workspaceId: "ws-not-bootstrapping",
              unlockToken: token.token,
              ephemeralKey: Buffer.from(ephemeral.publicKey).toString("base64"),
            }));
            return;
          }

          if (msg.type === "error") {
            expect(msg.code).toBe("UNAUTHORIZED");
            expect(String(msg.message).toLowerCase()).toContain("bootstrapping");
            resolve();
            return;
          }
        };
        setTimeout(() => reject(new Error("Timeout waiting for unlock state error")), 3000);
      });

      ws.close();
    } finally {
      if (prevControlDir === undefined) {
        delete process.env.GITSPACE_CONTROL_DIR;
      } else {
        process.env.GITSPACE_CONTROL_DIR = prevControlDir;
      }
      rmSync(tempControlDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Client Signature Enforcement
// ============================================================================

describe("Client signature enforcement", () => {
  test("list_machines rejects missing signature", async () => {
    const clientWs = await connectClient(relayUrl);

    const response = await sendAndWait<any>(
      clientWs,
      {
        type: "list_machines",
        clientIdentityId: testClient1.id,
      },
      "error"
    );

    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_SIGNATURE");

    clientWs.close();
  });

  test("legacy connect_with_invite is rejected", async () => {
    const clientWs = await connectClient(relayUrl);

    const response = await sendAndWait<any>(
      clientWs,
      {
        type: "connect_with_invite",
        inviteId: "legacy-invite",
        clientIdentityId: testClient1.id,
        deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
      },
      "error"
    );

    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_REQUEST");

    clientWs.close();
  });

  test("connect_to_machine rejects mismatched signature", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const clientWs = await connectClient(relayUrl);

    const signed = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine1.id,
      clientIdentityId: testClient2.id,
      deviceCertificate: "{}",
    }, testClient1);

    const response = await sendAndWait<any>(clientWs, signed, "error");

    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_SIGNATURE");

    machineWs.close();
    clientWs.close();
  });
});

// ============================================================================
// Machine Listing
// ============================================================================

describe("Machine listing flow", () => {
  test("lists only machines granted through relay + machine ACL", async () => {
    const machine1Ws = await connectAndRegisterMachine(testMachine1, { label: "Machine One" });
    const machine2Ws = await connectAndRegisterMachine(testMachine2, { label: "Machine Two" });

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "client-1",
    });
    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "machine-1-grant",
    });

    const clientWs = await connectClient(relayUrl);
    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId: testClient1.id,
      deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
    }, testClient1);
    const response = await sendAndWait<any>(clientWs, signedList, "machine_list");

    expect(response.type).toBe("machine_list");
    expect(response.machines).toHaveLength(1);
    expect(response.machines[0].machineId).toBe(testMachine1.id);
    expect(response.machines[0].online).toBe(true);

    machine1Ws.close();
    machine2Ws.close();
    clientWs.close();
  });

  test("returns empty list when machine ACL grant is missing", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client2UserRoot.id,
      label: "relay-only",
    });

    const clientWs = await connectClient(relayUrl);
    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId: testClient2.id,
      deviceCertificate: buildDeviceCertificate(testClient2, client2UserRoot),
    }, testClient2);
    const response = await sendAndWait<any>(clientWs, signedList, "machine_list");

    expect(response.type).toBe("machine_list");
    expect(response.machines).toHaveLength(0);

    machineWs.close();
    clientWs.close();
  });

  test("shows offline status for granted machine after disconnect", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1, { label: "Offline Test Machine" });

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "client-1",
    });
    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "machine-1-grant",
    });

    machineWs.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const clientWs = await connectClient(relayUrl);
    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId: testClient1.id,
      deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
    }, testClient1);
    const response = await sendAndWait<any>(clientWs, signedList, "machine_list");

    expect(response.type).toBe("machine_list");
    expect(response.machines).toHaveLength(1);
    expect(response.machines[0].machineId).toBe(testMachine1.id);
    expect(response.machines[0].online).toBe(false);

    clientWs.close();
  });
});

// ============================================================================
// Direct Machine Connection
// ============================================================================

describe("Direct machine connection", () => {
  test("connects directly when relay + machine ACL grants exist", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "client-1",
    });
    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "machine-1-grant",
    });

    const machineReceivedConnection = new Promise<any>((resolve) => {
      machineWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
    });

    const clientWs = await connectClient(relayUrl);
    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine1.id,
      clientIdentityId: testClient1.id,
      deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
    }, testClient1);

    const response = await sendAndWait<any>(clientWs, signedConnect, "connection_established");
    expect(response.type).toBe("connection_established");
    expect(response.machineId).toBe(testMachine1.id);

    const machineMsg = await machineReceivedConnection;
    expect(machineMsg.type).toBe("client_connected");
    expect(machineMsg.clientIdentityId).toBe(testClient1.id);

    machineWs.close();
    clientWs.close();
  });

  test("rejects direct connect when relay ACL grant is missing", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);

    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client2UserRoot.id,
      label: "machine-only",
    });

    const clientWs = await connectClient(relayUrl);
    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine1.id,
      clientIdentityId: testClient2.id,
      deviceCertificate: buildDeviceCertificate(testClient2, client2UserRoot),
    }, testClient2);

    const response = await sendAndWait<any>(clientWs, signedConnect, "error");
    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("not authorized");

    machineWs.close();
    clientWs.close();
  });

  test("rejects direct connect when machine ACL grant is missing", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client2UserRoot.id,
      label: "relay-only",
    });

    const clientWs = await connectClient(relayUrl);
    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine1.id,
      clientIdentityId: testClient2.id,
      deviceCertificate: buildDeviceCertificate(testClient2, client2UserRoot),
    }, testClient2);

    const response = await sendAndWait<any>(clientWs, signedConnect, "error");
    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("not authorized");

    machineWs.close();
    clientWs.close();
  });
});

// ============================================================================
// Authorization Management
// ============================================================================

describe("Authorization management", () => {
  test("granting machine ACL enables direct connect immediately", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client2UserRoot.id,
      label: "relay-only",
    });

    const clientWs = await connectClient(relayUrl);
    const connectMsg = {
      type: "connect_to_machine" as const,
      machineId: testMachine1.id,
      clientIdentityId: testClient2.id,
      deviceCertificate: buildDeviceCertificate(testClient2, client2UserRoot),
    };

    const denied = await sendAndWait<any>(clientWs, signClientMessage(connectMsg, testClient2), "error");
    expect(denied.type).toBe("error");

    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client2UserRoot.id,
      label: "machine-enabled",
    });

    const established = await sendAndWait<any>(clientWs, signClientMessage(connectMsg, testClient2), "connection_established");
    expect(established.type).toBe("connection_established");

    machineWs.close();
    clientWs.close();
  });

  test("revoking relay ACL removes machine visibility", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "client-1",
    });
    grantMachineAccess({
      machineId: testMachine1.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "machine-1-grant",
    });

    const clientWs = await connectClient(relayUrl);
    const listMsg = {
      type: "list_machines" as const,
      clientIdentityId: testClient1.id,
      deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
    };

    const beforeRevoke = await sendAndWait<any>(clientWs, signClientMessage(listMsg, testClient1), "machine_list");
    expect(beforeRevoke.machines).toHaveLength(1);

    revokeRelayAccess(ownerUserRoot.id, client1UserRoot.id);

    const afterRevoke = await sendAndWait<any>(clientWs, signClientMessage(listMsg, testClient1), "machine_list");
    expect(afterRevoke.machines).toHaveLength(0);

    machineWs.close();
    clientWs.close();
  });
});

// ============================================================================
// Invite Edge Cases
// ============================================================================

describe("Invite edge cases", () => {
  test("rejects expired root invite", async () => {
    const inviteToken = createRootInviteToken({
      type: "relay-user",
      owner: ownerUserRoot,
      relayUrl,
      targetUserRootSigningKey: Buffer.from(client1UserRoot.signing.publicKey).toString("base64"),
      expiresAt: Date.now() - 1_000,
      maxUses: 1,
      label: "expired-relay-user",
    });
    registerRootInviteTokenForTests(inviteToken);

    const clientWs = await connectClient(relayUrl);
    const response = await sendAndWait<any>(
      clientWs,
      signClientMessage({
        type: "accept_root_invite",
        clientIdentityId: testClient1.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
      }, testClient1),
      "error",
    );

    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("expired");

    clientWs.close();
  });

  test("rejects root invite after max uses exhausted", async () => {
    const inviteToken = createRootInviteToken({
      type: "relay-user",
      owner: ownerUserRoot,
      relayUrl,
      targetUserRootSigningKey: Buffer.from(client1UserRoot.signing.publicKey).toString("base64"),
      expiresAt: Date.now() + 60_000,
      maxUses: 1,
      label: "single-use-relay-user",
    });
    registerRootInviteTokenForTests(inviteToken);

    const firstClientWs = await connectClient(relayUrl);
    const firstAccepted = await sendAndWait<any>(
      firstClientWs,
      signClientMessage({
        type: "accept_root_invite",
        clientIdentityId: testClient1.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
      }, testClient1),
      "root_invite_accepted",
    );
    expect(firstAccepted.type).toBe("root_invite_accepted");
    firstClientWs.close();

    const secondClientWs = await connectClient(relayUrl);
    const secondResponse = await sendAndWait<any>(
      secondClientWs,
      signClientMessage({
        type: "accept_root_invite",
        clientIdentityId: testClient1.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
      }, testClient1),
      "error",
    );

    expect(secondResponse.type).toBe("error");
    expect(secondResponse.message.toLowerCase()).toMatch(/not found|exhausted/);

    secondClientWs.close();
  });

  test("rejects non-existent root invite", async () => {
    const inviteToken = createRootInviteToken({
      type: "relay-user",
      owner: ownerUserRoot,
      relayUrl,
      targetUserRootSigningKey: Buffer.from(client1UserRoot.signing.publicKey).toString("base64"),
      expiresAt: Date.now() + 60_000,
      maxUses: 1,
      label: "not-registered-relay-user",
    });

    const clientWs = await connectClient(relayUrl);
    const response = await sendAndWait<any>(
      clientWs,
      signClientMessage({
        type: "accept_root_invite",
        clientIdentityId: testClient1.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
      }, testClient1),
      "error",
    );

    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("not found");

    clientWs.close();
  });

  test("machine-user invite requires relay membership before acceptance", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteToken = createRootInviteToken({
      type: "machine-user",
      owner: ownerUserRoot,
      relayUrl,
      machineId: testMachine1.id,
      targetUserRootSigningKey: Buffer.from(client2UserRoot.signing.publicKey).toString("base64"),
      expiresAt: Date.now() + 60_000,
      maxUses: 1,
      label: "machine-user-relay-required",
    });
    registerRootInviteTokenForTests(inviteToken);

    const targetWs = await connectClient(relayUrl);
    const denied = await sendAndWait<any>(
      targetWs,
      signClientMessage({
        type: "accept_root_invite",
        clientIdentityId: testClient2.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(testClient2, client2UserRoot),
      }, testClient2),
      "error",
    );

    expect(denied.type).toBe("error");
    expect(denied.message.toLowerCase()).toContain("relay membership");

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client2UserRoot.id,
      label: "machine-user-accept",
    });

    const accepted = await sendAndWait<any>(
      targetWs,
      signClientMessage({
        type: "accept_root_invite",
        clientIdentityId: testClient2.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(testClient2, client2UserRoot),
      }, testClient2),
      "root_invite_accepted",
    );

    expect(accepted.type).toBe("root_invite_accepted");
    expect(accepted.inviteType).toBe("machine-user");
    expect(accepted.granted).toBe("machine");
    expect(
      listMachineAccessList(testMachine1.id, ownerUserRoot.id).some(
        (entry) => entry.clientUserRootId === client2UserRoot.id,
      ),
    ).toBe(true);

    machineWs.close();
    targetWs.close();
  });
});

// ============================================================================
// connect_to_machine: offline and nonexistent machine IDs
// ============================================================================

describe("connect_to_machine: offline and nonexistent targets", () => {
  test("returns error when connecting to a machine ID that has no ACL grant", async () => {
    // Machine was never registered — the relay rejects the request at ACL check
    // rather than forwarding it, so the client gets "not authorized".
    const GHOST_MACHINE_ID = "machine-that-never-existed";

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "relay-for-ghost",
    });
    // Intentionally NOT granting machine ACL — the machine was never registered

    const clientWs = await connectClient(relayUrl);
    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: GHOST_MACHINE_ID,
      clientIdentityId: testClient1.id,
      deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
    }, testClient1);

    const response = await sendAndWait<any>(clientWs, signedConnect, "error");
    expect(response.type).toBe("error");
    expect(
      response.message?.toLowerCase().includes("not authorized") ||
      response.message?.toLowerCase().includes("not found")
    ).toBe(true);

    clientWs.close();
  });

  test("returns error when connecting to a machine that was connected but then disconnected", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine2);

    grantRelayAccess({
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "relay-for-offline",
    });
    grantMachineAccess({
      machineId: testMachine2.id,
      ownerUserRootId: ownerUserRoot.id,
      clientUserRootId: client1UserRoot.id,
      label: "offline-machine-grant",
    });

    // Disconnect the machine
    machineWs.close();
    await new Promise((r) => setTimeout(r, 100));

    const clientWs = await connectClient(relayUrl);
    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine2.id,
      clientIdentityId: testClient1.id,
      deviceCertificate: buildDeviceCertificate(testClient1, client1UserRoot),
    }, testClient1);

    const response = await sendAndWait<any>(clientWs, signedConnect, "error");
    expect(response.type).toBe("error");
    expect(
      response.message?.toLowerCase().includes("offline") ||
      response.message?.toLowerCase().includes("not connected") ||
      response.message?.toLowerCase().includes("not found")
    ).toBe(true);

    clientWs.close();
  });
});

// ============================================================================
// handleDataMessage error branches
// ============================================================================

describe("handleDataMessage: error branches", () => {
  test("ignores binary data that is not a valid frame (too short)", async () => {
    // Machines communicate via binary PTY/CONTROL frames.
    // A frame that is too short to contain a valid stream ID should be silently
    // dropped — the connection should remain open.
    const machineWs = await connectAndRegisterMachine(testMachine1);

    // Send a 1-byte binary payload (too short to be a valid frame)
    const tinyBuffer = new Uint8Array([0x01]);
    machineWs.send(tinyBuffer.buffer);

    // Give the server a tick to process and verify the WS is still alive
    await new Promise((r) => setTimeout(r, 80));
    expect(machineWs.readyState).toBe(WebSocket.OPEN);

    machineWs.close();
  });

  test("returns error for unknown text message type from client", async () => {
    const clientWs = await connectClient(relayUrl);

    // Send a message with an unknown type (not a registered command)
    const response = await sendAndWait<any>(
      clientWs,
      { type: "totally_unknown_message_type", clientIdentityId: testClient1.id },
      "error",
    );

    expect(response.type).toBe("error");

    clientWs.close();
  });

  test("returns error for malformed JSON from client", async () => {
    const clientWs = await connectClient(relayUrl);

    // We cannot use sendAndWait here because sendAndWait JSON-serializes the
    // payload. Instead send raw malformed text and wait for the error.
    const errorPromise = new Promise<any>((resolve) => {
      clientWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(
            typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
          );
          if (msg.type === "error") resolve(msg);
        } catch {}
      };
    });

    clientWs.send("{invalid json!!");

    const response = await Promise.race([
      errorPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);

    // Server may either return an error message or silently drop the frame.
    // Either behavior is acceptable — we just verify the connection stays open.
    if (response !== null) {
      expect(response.type).toBe("error");
    } else {
      expect(clientWs.readyState).toBe(WebSocket.OPEN);
    }

    clientWs.close();
  });
});
