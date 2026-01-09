import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  // Machine registry
  registerMachine,
  unregisterMachine,
  getMachine,
  hasMachine,
  isMachineOnline,
  getAllMachines,
  setMachineConnection,
  // Invite registry
  registerInvite,
  revokeInvite,
  getInvite,
  useInvite,
  isInviteValid,
  getInvitesForMachine,
  cleanupExpiredInvites,
  // Authorization registry
  authorizeClient,
  revokeClientAuthorization,
  isClientAuthorized,
  getMachinesForClient,
  getAuthorizedClients,
  getClientAuthorization,
  // Stats and cleanup
  getRegistryStats,
  clearAllRegistries,
} from "./registries";
import type { WebSocketData } from "./types";
import type { ServerWebSocket } from "bun";

/**
 * Mock WebSocket interface for testing.
 * Uses bun:test mock functions for call tracking.
 */
interface MockWebSocketForRegistry {
  data: WebSocketData;
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}

/**
 * Create a type-safe mock WebSocket for registry testing.
 * Returns a mock cast to ServerWebSocket<WebSocketData> for use with registry functions.
 */
function createMockWs(connectionId: string): ServerWebSocket<WebSocketData> {
  const mockWs: MockWebSocketForRegistry = {
    data: {
      machineId: "test-machine",
      role: "machine",
      connectionId,
      accountId: "test-account",
    },
    send: mock(() => {}),
    close: mock(() => {}),
  };
  // Cast to expected type - the mock implements the minimal interface needed for tests
  return mockWs as unknown as ServerWebSocket<WebSocketData>;
}

beforeEach(() => {
  clearAllRegistries();
});

describe("Machine Registry", () => {
  test("registers a machine", () => {
    const ws = createMockWs("conn-1");
    registerMachine(
      "machine-1",
      "account-1",
      "signing-key",
      "kx-key",
      ws,
      "My Machine"
    );

    const machine = getMachine("machine-1");
    expect(machine).not.toBeUndefined();
    expect(machine?.machineId).toBe("machine-1");
    expect(machine?.accountId).toBe("account-1");
    expect(machine?.label).toBe("My Machine");
  });

  test("hasMachine returns true for registered machine", () => {
    const ws = createMockWs("conn-1");
    registerMachine("machine-1", "account-1", "signing-key", "kx-key", ws);

    expect(hasMachine("machine-1")).toBe(true);
    expect(hasMachine("non-existent")).toBe(false);
  });

  test("returns undefined for non-existent machine", () => {
    const machine = getMachine("non-existent");
    expect(machine).toBeUndefined();
  });

  test("unregisters a machine", () => {
    const ws = createMockWs("conn-1");
    registerMachine("machine-1", "account-1", "signing-key", "kx-key", ws);

    expect(getMachine("machine-1")).not.toBeUndefined();

    unregisterMachine("machine-1");

    expect(getMachine("machine-1")).toBeUndefined();
  });

  test("checks if machine is online", () => {
    // Non-existent machine returns false
    expect(isMachineOnline("machine-1")).toBe(false);

    const ws = createMockWs("conn-1");
    registerMachine("machine-1", "account-1", "signing-key", "kx-key", ws);

    expect(isMachineOnline("machine-1")).toBe(true);

    // Set connection to null (offline)
    setMachineConnection("machine-1", null);

    expect(isMachineOnline("machine-1")).toBe(false);
  });

  test("replaces existing machine registration connection with same keys", () => {
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");

    // First registration
    const result1 = registerMachine("machine-1", "account-1", "key-1", "kx-key-1", ws1);
    expect(result1.success).toBe(true);

    // Re-registration with same account and keys should succeed
    const result2 = registerMachine("machine-1", "account-1", "key-1", "kx-key-1", ws2);
    expect(result2.success).toBe(true);

    const machine = getMachine("machine-1");
    expect(machine?.ws).toBe(ws2);
  });

  test("rejects re-registration with different signing key", () => {
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");

    // First registration
    const result1 = registerMachine("machine-1", "account-1", "key-1", "kx-key-1", ws1);
    expect(result1.success).toBe(true);

    // Re-registration with different signing key should fail
    const result2 = registerMachine("machine-1", "account-1", "key-2", "kx-key-1", ws2);
    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.error).toContain("Signing key mismatch");
    }

    // Original connection should be unchanged
    const machine = getMachine("machine-1");
    expect(machine?.ws).toBe(ws1);
  });

  test("rejects re-registration from different account", () => {
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");

    // First registration
    const result1 = registerMachine("machine-1", "account-1", "key-1", "kx-key-1", ws1);
    expect(result1.success).toBe(true);

    // Re-registration with different account should fail
    const result2 = registerMachine("machine-1", "account-2", "key-1", "kx-key-1", ws2);
    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.error).toContain("different account");
    }

    // Original connection should be unchanged
    const machine = getMachine("machine-1");
    expect(machine?.ws).toBe(ws1);
  });

  test("getAllMachines returns all registered machines", () => {
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");

    registerMachine("machine-1", "account-1", "key", "kx-key", ws1);
    registerMachine("machine-2", "account-1", "key", "kx-key", ws2);

    const machines = getAllMachines();
    expect(machines).toHaveLength(2);
    expect(machines.map((m) => m.machineId).sort()).toEqual([
      "machine-1",
      "machine-2",
    ]);
  });
});

describe("Invite Registry", () => {
  test("registers an invite", () => {
    registerInvite(
      "invite-1",
      "machine-1",
      Date.now() + 3600000, // 1 hour from now
      5
    );

    const invite = getInvite("invite-1");
    expect(invite).not.toBeUndefined();
    expect(invite?.machineId).toBe("machine-1");
    expect(invite?.maxUses).toBe(5);
    expect(invite?.usedCount).toBe(0);
  });

  test("returns undefined for non-existent invite", () => {
    const invite = getInvite("non-existent");
    expect(invite).toBeUndefined();
  });

  test("revokes an invite", () => {
    registerInvite("invite-1", "machine-1", Date.now() + 3600000, null);

    expect(getInvite("invite-1")).not.toBeUndefined();

    revokeInvite("invite-1");

    expect(getInvite("invite-1")).toBeUndefined();
  });

  test("validates unexpired invite", () => {
    registerInvite(
      "invite-1",
      "machine-1",
      Date.now() + 3600000, // 1 hour from now
      null
    );

    expect(isInviteValid("invite-1")).toBe(true);
  });

  test("invalidates expired invite", () => {
    registerInvite(
      "invite-1",
      "machine-1",
      Date.now() - 1000, // 1 second ago
      null
    );

    expect(isInviteValid("invite-1")).toBe(false);
  });

  test("invalidates invite that exceeded max uses", () => {
    registerInvite("invite-1", "machine-1", Date.now() + 3600000, 2);

    // Use the invite twice
    useInvite("invite-1");
    useInvite("invite-1");

    // After max uses reached, invite is removed
    expect(getInvite("invite-1")).toBeUndefined();
    expect(isInviteValid("invite-1")).toBe(false);
  });

  test("increments use count", () => {
    registerInvite("invite-1", "machine-1", Date.now() + 3600000, 10);

    expect(getInvite("invite-1")?.usedCount).toBe(0);

    useInvite("invite-1");
    expect(getInvite("invite-1")?.usedCount).toBe(1);

    useInvite("invite-1");
    expect(getInvite("invite-1")?.usedCount).toBe(2);
  });

  test("null maxUses means unlimited", () => {
    registerInvite("invite-1", "machine-1", Date.now() + 3600000, null);

    // Use many times
    for (let i = 0; i < 100; i++) {
      useInvite("invite-1");
    }

    expect(isInviteValid("invite-1")).toBe(true);
    expect(getInvite("invite-1")?.usedCount).toBe(100);
  });

  test("getInvitesForMachine returns invites for a machine", () => {
    registerInvite("invite-1", "machine-1", Date.now() + 3600000, null);
    registerInvite("invite-2", "machine-1", Date.now() + 3600000, null);
    registerInvite("invite-3", "machine-2", Date.now() + 3600000, null);

    const invites = getInvitesForMachine("machine-1");
    expect(invites).toHaveLength(2);
    expect(invites.map((i) => i.inviteId).sort()).toEqual([
      "invite-1",
      "invite-2",
    ]);
  });

  test("cleanupExpiredInvites removes expired invites", () => {
    registerInvite("invite-1", "machine-1", Date.now() - 1000, null); // expired
    registerInvite("invite-2", "machine-1", Date.now() + 3600000, null); // valid

    const removed = cleanupExpiredInvites();
    expect(removed).toBe(1);
    expect(getInvite("invite-1")).toBeUndefined();
    expect(getInvite("invite-2")).not.toBeUndefined();
  });
});

describe("Authorization Registry", () => {
  test("authorizes a client", () => {
    authorizeClient(
      "machine-1",
      "client-1",
      "client-signing-key",
      "client-kx-key",
      "full"
    );

    expect(isClientAuthorized("machine-1", "client-1")).toBe(true);
  });

  test("returns false for unauthorized client", () => {
    expect(isClientAuthorized("machine-1", "client-1")).toBe(false);
  });

  test("revokes client authorization", () => {
    authorizeClient("machine-1", "client-1", "key", "kx-key", "full");

    expect(isClientAuthorized("machine-1", "client-1")).toBe(true);

    revokeClientAuthorization("machine-1", "client-1");

    expect(isClientAuthorized("machine-1", "client-1")).toBe(false);
  });

  test("gets machines for client", () => {
    // Register machines first
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");
    registerMachine("machine-1", "account-1", "signing-key", "kx-key", ws1, "Machine 1");
    registerMachine("machine-2", "account-1", "signing-key", "kx-key", ws2, "Machine 2");

    authorizeClient("machine-1", "client-1", "key", "kx-key", "full");
    authorizeClient("machine-2", "client-1", "key", "kx-key", "session-invite", "session-123");

    const machines = getMachinesForClient("client-1");

    expect(machines).toHaveLength(2);
    expect(machines.map((m) => m.machineId).sort()).toEqual([
      "machine-1",
      "machine-2",
    ]);
  });

  test("gets authorized clients for machine", () => {
    authorizeClient("machine-1", "client-1", "key", "kx-key", "full");
    authorizeClient("machine-1", "client-2", "key", "kx-key", "session-invite", "session-456");

    const clients = getAuthorizedClients("machine-1");

    expect(clients).toHaveLength(2);
    expect(clients.map((c) => c.clientIdentityId).sort()).toEqual([
      "client-1",
      "client-2",
    ]);
  });

  test("gets specific client authorization", () => {
    authorizeClient("machine-1", "client-1", "key", "kx-key", "full");

    const auth = getClientAuthorization("machine-1", "client-1");
    expect(auth).not.toBeUndefined();
    expect(auth?.accessType).toBe("full");
  });

  test("updates accessType for already authorized client", () => {
    authorizeClient("machine-1", "client-1", "key", "kx-key", "session-invite", "session-1");

    let clients = getAuthorizedClients("machine-1");
    expect(clients[0].accessType).toBe("session-invite");
    expect(clients[0].sessionId).toBe("session-1");

    authorizeClient("machine-1", "client-1", "key", "kx-key", "full");

    clients = getAuthorizedClients("machine-1");
    expect(clients).toHaveLength(1); // Still only one client
    expect(clients[0].accessType).toBe("full");
    expect(clients[0].sessionId).toBeUndefined();
  });
});

describe("Registry Stats", () => {
  test("returns correct stats", () => {
    // Initially empty
    let stats = getRegistryStats();
    expect(stats.machineCount).toBe(0);
    expect(stats.inviteCount).toBe(0);
    expect(stats.authorizationCount).toBe(0);

    // Add some data
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");
    registerMachine("machine-1", "account-1", "key", "kx-key", ws1);
    registerMachine("machine-2", "account-1", "key", "kx-key", ws2);

    registerInvite("invite-1", "machine-1", Date.now() + 3600000, null);

    authorizeClient("machine-1", "client-1", "key", "kx-key", "full");

    stats = getRegistryStats();
    expect(stats.machineCount).toBe(2);
    expect(stats.onlineMachineCount).toBe(2);
    expect(stats.inviteCount).toBe(1);
    expect(stats.authorizationCount).toBe(1);
  });
});

describe("clearAllRegistries", () => {
  test("clears all registries", () => {
    const ws = createMockWs("conn-1");
    registerMachine("machine-1", "account-1", "key", "kx-key", ws);
    registerInvite("invite-1", "machine-1", Date.now() + 3600000, null);
    authorizeClient("machine-1", "client-1", "key", "kx-key", "full");

    let stats = getRegistryStats();
    expect(stats.machineCount).toBe(1);
    expect(stats.inviteCount).toBe(1);
    expect(stats.authorizationCount).toBe(1);

    clearAllRegistries();

    stats = getRegistryStats();
    expect(stats.machineCount).toBe(0);
    expect(stats.inviteCount).toBe(0);
    expect(stats.authorizationCount).toBe(0);
  });
});
