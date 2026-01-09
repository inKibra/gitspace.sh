import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
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
import type { Identity } from "../types/identity";

const TEST_HOST = "127.0.0.1";
let relayUrl = "";
let relayHttpBase = "";

// Generate identities for testing
const testRelayIdentity = generateRelayIdentity("test-relay");
const testMachine1 = createTestIdentity("Test Machine 1");
const testMachine2 = createTestIdentity("Test Machine 2");
const testClient1 = createTestIdentity("Test Client 1");
const testClient2 = createTestIdentity("Test Client 2");

let server: Server<any>;

beforeAll(async () => {
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
});

beforeEach(() => {
  // Clear registries between tests
  clearAllRegistries();
});

// ============================================================================
// Helper to connect a machine with full challenge-response flow
// ============================================================================

async function connectAndRegisterMachine(
  identity: Identity,
  options?: { label?: string }
): Promise<WebSocket> {
  const { label = identity.label } = options ?? {};

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
  ws.send(JSON.stringify({
    type: "register_machine",
    machineId: identity.id,
    signingKey: publicIdentity.signingPublicKey,
    keyExchangeKey: publicIdentity.keyExchangePublicKey,
    challengeResponse: signature,
    label,
  }));

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
  test("invite registration flow", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteId = "test-invite-001";

    // Register invite
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() + 3600000,
      maxUses: 5,
    }));

    const response = await new Promise<any>((resolve, reject) => {
      machineWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("registered");
    expect(response.machineId).toBe(testMachine1.id);

    machineWs.close();
  });

  test("client connect with invite flow", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteId = "test-invite-002";
    const clientIdentityId = testClient1.id;

    // Register invite
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() + 3600000,
      maxUses: null,
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Set up machine to receive client_connected
    const machineReceivedConnection = new Promise<any>((resolve) => {
      machineWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
    });

    // Connect client (no token needed)
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = () => reject(new Error("Client connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    // Client connects with invite
    const signedConnect = signClientMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedConnect));

    // Wait for connection_established
    const clientResponse = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(clientResponse.type).toBe("connection_established");
    expect(clientResponse.machineId).toBe(testMachine1.id);

    // Machine should have received client_connected
    const machineMsg = await machineReceivedConnection;
    expect(machineMsg.type).toBe("client_connected");
    expect(machineMsg.clientIdentityId).toBe(clientIdentityId);
    expect(machineMsg.viaInvite).toBe(inviteId);

    machineWs.close();
    clientWs.close();
  });

  test("machine to client data routing", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteId = "test-invite-003";
    const clientIdentityId = testClient1.id;

    // Register invite
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() + 3600000,
      maxUses: null,
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Store connectionId when machine receives client_connected
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

    // Connect client
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = () => reject(new Error("Client connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    const signedConnect = signClientMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedConnect));

    // Wait for connection established
    await new Promise<void>((resolve) => {
      clientWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "connection_established") resolve();
      };
    });

    await gotConnectionId;

    // Set up client to receive data
    const clientReceivedData = new Promise<any>((resolve) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
    });

    // Machine sends data to client
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
    const inviteId = "test-invite-004";
    const clientIdentityId = testClient1.id;

    // Register invite
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() + 3600000,
      maxUses: null,
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Wait for client_connected
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

    // Connect client
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = () => reject(new Error("Client connection failed"));
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    const signedConnect = signClientMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedConnect));

    // Wait for connection established
    await new Promise<void>((resolve) => {
      clientWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "connection_established") resolve();
      };
    });

    await clientConnectedPromise;

    // Set up machine to receive data
    const machineReceivedData = new Promise<any>((resolve) => {
      machineWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
    });

    // Client sends data to machine
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

  test("connect_with_invite rejects missing signature", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteId = "test-invite-unsigned";

    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() + 3600000,
      maxUses: 1,
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    const clientWs = await connectClient(relayUrl);

    const response = await sendAndWait<any>(
      clientWs,
      {
        type: "connect_with_invite",
        inviteId,
        clientIdentityId: testClient1.id,
      },
      "error"
    );

    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_SIGNATURE");

    machineWs.close();
    clientWs.close();
  });

  test("connect_to_machine rejects mismatched signature", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const clientWs = await connectClient(relayUrl);

    const signed = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine1.id,
      clientIdentityId: testClient2.id,
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
  test("client can list machines they are authorized for", async () => {
    const clientIdentityId = testClient1.id;

    // Register two machines
    const machine1Ws = await connectAndRegisterMachine(testMachine1, { label: "Machine One" });
    const machine2Ws = await connectAndRegisterMachine(testMachine2, { label: "Machine Two" });

    // Authorize client on both machines
    machine1Ws.send(JSON.stringify({
      type: "authorize_client",
      machineId: testMachine1.id,
      clientIdentityId,
      signingKey: "client-key",
      keyExchangeKey: "client-kx",
      accessType: "full",
    }));

    await new Promise<void>((resolve) => {
      machine1Ws.onmessage = () => resolve();
    });

    machine2Ws.send(JSON.stringify({
      type: "authorize_client",
      machineId: testMachine2.id,
      clientIdentityId,
      signingKey: "client-key",
      keyExchangeKey: "client-kx",
      accessType: "full",
    }));

    await new Promise<void>((resolve) => {
      machine2Ws.onmessage = () => resolve();
    });

    // Connect client and list machines
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedList));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("machine_list");
    expect(response.machines).toHaveLength(2);

    const machineIds = response.machines.map((m: any) => m.machineId).sort();
    expect(machineIds).toEqual([testMachine1.id, testMachine2.id].sort());

    // Both should be online
    expect(response.machines.every((m: any) => m.online)).toBe(true);

    machine1Ws.close();
    machine2Ws.close();
    clientWs.close();
  });

  test("client sees empty list when not authorized for any machine", async () => {
    const clientIdentityId = testClient2.id;

    // Register a machine but don't authorize the client
    const machineWs = await connectAndRegisterMachine(testMachine1);

    // Connect client and list machines
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId,
    }, testClient2);
    clientWs.send(JSON.stringify(signedList));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("machine_list");
    expect(response.machines).toHaveLength(0);

    machineWs.close();
    clientWs.close();
  });

  test("machine shows offline status when disconnected", async () => {
    const clientIdentityId = testClient2.id;

    // Register machine
    const machineWs = await connectAndRegisterMachine(testMachine1, { label: "Offline Test Machine" });

    // Authorize client
    machineWs.send(JSON.stringify({
      type: "authorize_client",
      machineId: testMachine1.id,
      clientIdentityId,
      signingKey: "client-key",
      keyExchangeKey: "client-kx",
      accessType: "full",
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Disconnect machine
    machineWs.close();

    // Give server time to process disconnect
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Connect client and list machines
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId,
    }, testClient2);
    clientWs.send(JSON.stringify(signedList));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

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
  test("client can connect directly to machine", async () => {
    const clientIdentityId = testClient1.id;

    // Register machine
    const machineWs = await connectAndRegisterMachine(testMachine1);

    // Set up machine to receive client_connected
    const machineReceivedConnection = new Promise<any>((resolve) => {
      machineWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
    });

    // Connect client directly (no invite needed in new flow - auth at X3DH level)
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine1.id,
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedConnect));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    // In new auth model, connect_to_machine succeeds - auth happens via X3DH
    expect(response.type).toBe("connection_established");
    expect(response.machineId).toBe(testMachine1.id);

    // Machine should receive client_connected WITHOUT viaInvite
    const machineMsg = await machineReceivedConnection;
    expect(machineMsg.type).toBe("client_connected");
    expect(machineMsg.clientIdentityId).toBe(clientIdentityId);
    expect(machineMsg.viaInvite).toBeUndefined();

    machineWs.close();
    clientWs.close();
  });

  test("client cannot connect to non-existent machine", async () => {
    const clientIdentityId = testClient2.id;

    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: "non-existent-machine",
      clientIdentityId,
    }, testClient2);
    clientWs.send(JSON.stringify(signedConnect));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("not found");

    clientWs.close();
  });

  test("client cannot connect to offline machine", async () => {
    const clientIdentityId = testClient2.id;

    // Register machine then disconnect
    const machineWs = await connectAndRegisterMachine(testMachine1);
    machineWs.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Try to connect
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedConnect = signClientMessage({
      type: "connect_to_machine",
      machineId: testMachine1.id,
      clientIdentityId,
    }, testClient2);
    clientWs.send(JSON.stringify(signedConnect));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("offline");

    clientWs.close();
  });
});

// ============================================================================
// Authorization Management
// ============================================================================

describe("Authorization management", () => {
  test("machine can authorize a client", async () => {
    const clientIdentityId = testClient1.id;

    // Register machine
    const machineWs = await connectAndRegisterMachine(testMachine1);

    // Authorize client
    machineWs.send(JSON.stringify({
      type: "authorize_client",
      machineId: testMachine1.id,
      clientIdentityId,
      signingKey: "client-key",
      keyExchangeKey: "client-kx",
      accessType: "full",
    }));

    const response = await new Promise<any>((resolve, reject) => {
      machineWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("client_authorized");
    expect(response.clientIdentityId).toBe(clientIdentityId);

    // Verify by listing machines from client
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedList));

    const listResponse = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(listResponse.machines).toHaveLength(1);
    expect(listResponse.machines[0].machineId).toBe(testMachine1.id);

    machineWs.close();
    clientWs.close();
  });

  test("machine can revoke client authorization", async () => {
    const clientIdentityId = testClient2.id;

    // Register machine
    const machineWs = await connectAndRegisterMachine(testMachine1);

    // Authorize client
    machineWs.send(JSON.stringify({
      type: "authorize_client",
      machineId: testMachine1.id,
      clientIdentityId,
      signingKey: "client-key",
      keyExchangeKey: "client-kx",
      accessType: "full",
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Now revoke
    machineWs.send(JSON.stringify({
      type: "revoke_client",
      machineId: testMachine1.id,
      clientIdentityId,
    }));

    const response = await new Promise<any>((resolve, reject) => {
      machineWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("client_revoked");
    expect(response.clientIdentityId).toBe(clientIdentityId);

    // Verify by listing machines from client - should be empty
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedList = signClientMessage({
      type: "list_machines",
      clientIdentityId,
    }, testClient2);
    clientWs.send(JSON.stringify(signedList));

    const listResponse = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(listResponse.machines).toHaveLength(0);

    machineWs.close();
    clientWs.close();
  });
});

// ============================================================================
// Invite Edge Cases
// ============================================================================

describe("Invite edge cases", () => {
  test("rejects expired invite", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteId = "expired-invite-001";
    const clientIdentityId = testClient1.id;

    // Register expired invite
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() - 1000, // Already expired
      maxUses: null,
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Try to use expired invite
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedConnect = signClientMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedConnect));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toMatch(/expired|invalid/);

    machineWs.close();
    clientWs.close();
  });

  test("rejects invite after max uses exhausted", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteId = "limited-invite-001";

    // Register invite with maxUses = 1
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() + 3600000,
      maxUses: 1,
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Set up machine to receive client_connected
    const machineReceivedFirst = new Promise<void>((resolve) => {
      machineWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "client_connected") resolve();
      };
    });

    // First client uses the invite
    const client1Ws = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      client1Ws.onopen = () => resolve();
    });

    const signedFirst = signClientMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId: testClient1.id,
    }, testClient1);
    client1Ws.send(JSON.stringify(signedFirst));

    await new Promise<void>((resolve) => {
      client1Ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "connection_established") resolve();
      };
    });

    await machineReceivedFirst;

    // Second client tries to use the same invite
    const client2Ws = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      client2Ws.onopen = () => resolve();
    });

    const signedSecond = signClientMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId: testClient2.id,
    }, testClient2);
    client2Ws.send(JSON.stringify(signedSecond));

    const response = await new Promise<any>((resolve, reject) => {
      client2Ws.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toMatch(/not found|invalid|expired|exhausted/);

    machineWs.close();
    client1Ws.close();
    client2Ws.close();
  });

  test("rejects non-existent invite", async () => {
    const clientIdentityId = testClient1.id;

    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedConnect = signClientMessage({
      type: "connect_with_invite",
      inviteId: "non-existent-invite",
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedConnect));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("not found");

    clientWs.close();
  });

  test("invite fails when machine is offline", async () => {
    const machineWs = await connectAndRegisterMachine(testMachine1);
    const inviteId = "offline-machine-invite";
    const clientIdentityId = testClient1.id;

    // Register invite
    machineWs.send(JSON.stringify({
      type: "register_invite",
      inviteId,
      machineId: testMachine1.id,
      expiresAt: Date.now() + 3600000,
      maxUses: null,
    }));

    await new Promise<void>((resolve) => {
      machineWs.onmessage = () => resolve();
    });

    // Disconnect machine
    machineWs.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Try to use invite while machine is offline
    const clientWs = new WebSocket(`${relayUrl}?role=client`);

    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve();
    });

    const signedConnect = signClientMessage({
      type: "connect_with_invite",
      inviteId,
      clientIdentityId,
    }, testClient1);
    clientWs.send(JSON.stringify(signedConnect));

    const response = await new Promise<any>((resolve, reject) => {
      clientWs.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
      setTimeout(() => reject(new Error("Timeout")), 2000);
    });

    // Should fail because machine is offline
    expect(response.type).toBe("error");
    expect(response.message.toLowerCase()).toContain("offline");

    clientWs.close();
  });
});
