import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  registerMachine,
  unregisterMachine,
  getMachine,
  hasMachine,
  isMachineOnline,
  getAllMachines,
  setMachineConnection,
  getRegistryStats,
  clearAllRegistries,
} from "./registries";
import type { WebSocketData } from "./types";
import type { ServerWebSocket } from "bun";

interface MockWebSocketForRegistry {
  data: WebSocketData;
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}

function createMockWs(connectionId: string): ServerWebSocket<WebSocketData> {
  const mockWs: MockWebSocketForRegistry = {
    data: {
      machineId: "test-machine",
      role: "machine",
      connectionId,
      ownerUserRootId: "test-owner",
    },
    send: mock(() => {}),
    close: mock(() => {}),
  };

  return mockWs as unknown as ServerWebSocket<WebSocketData>;
}

beforeEach(() => {
  clearAllRegistries();
});

describe("Machine Registry", () => {
  test("registers a machine", () => {
    const ws = createMockWs("conn-1");
    const result = registerMachine(
      "machine-1",
      "owner-1",
      "signing-key",
      "kx-key",
      ws,
      "My Machine"
    );

    expect(result.success).toBe(true);
    const machine = getMachine("machine-1");
    expect(machine).not.toBeUndefined();
    expect(machine?.machineId).toBe("machine-1");
    expect(machine?.ownerUserRootId).toBe("owner-1");
    expect(machine?.label).toBe("My Machine");
  });

  test("hasMachine returns true for registered machine", () => {
    const ws = createMockWs("conn-1");
    registerMachine("machine-1", "owner-1", "signing-key", "kx-key", ws);

    expect(hasMachine("machine-1")).toBe(true);
    expect(hasMachine("non-existent")).toBe(false);
  });

  test("unregisters a machine", () => {
    const ws = createMockWs("conn-1");
    registerMachine("machine-1", "owner-1", "signing-key", "kx-key", ws);

    expect(getMachine("machine-1")).not.toBeUndefined();
    unregisterMachine("machine-1");
    expect(getMachine("machine-1")).toBeUndefined();
  });

  test("tracks online/offline state", () => {
    expect(isMachineOnline("machine-1")).toBe(false);

    const ws = createMockWs("conn-1");
    registerMachine("machine-1", "owner-1", "signing-key", "kx-key", ws);
    expect(isMachineOnline("machine-1")).toBe(true);

    setMachineConnection("machine-1", null);
    expect(isMachineOnline("machine-1")).toBe(false);
  });

  test("rejects re-registration with different owner", () => {
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");

    const first = registerMachine("machine-1", "owner-a", "key-1", "kx-1", ws1);
    expect(first.success).toBe(true);

    const second = registerMachine("machine-1", "owner-b", "key-1", "kx-1", ws2);
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toContain("different owner");
    }
  });

  test("rejects re-registration with different signing key", () => {
    const ws1 = createMockWs("conn-1");
    const ws2 = createMockWs("conn-2");

    const first = registerMachine("machine-1", "owner-a", "key-1", "kx-1", ws1);
    expect(first.success).toBe(true);

    const second = registerMachine("machine-1", "owner-a", "key-2", "kx-1", ws2);
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toContain("Signing key mismatch");
    }
  });

  test("getAllMachines returns all machines", () => {
    registerMachine("machine-1", "owner-1", "key-1", "kx-1", createMockWs("conn-1"));
    registerMachine("machine-2", "owner-1", "key-2", "kx-2", createMockWs("conn-2"));

    const machines = getAllMachines();
    expect(machines).toHaveLength(2);
    expect(machines.map((m) => m.machineId).sort()).toEqual(["machine-1", "machine-2"]);
  });
});

describe("Registry Stats", () => {
  test("reports machine totals", () => {
    let stats = getRegistryStats();
    expect(stats.machineCount).toBe(0);
    expect(stats.onlineMachineCount).toBe(0);

    registerMachine("machine-1", "owner-1", "key-1", "kx-1", createMockWs("conn-1"));
    registerMachine("machine-2", "owner-1", "key-2", "kx-2", createMockWs("conn-2"));

    stats = getRegistryStats();
    expect(stats.machineCount).toBe(2);
    expect(stats.onlineMachineCount).toBe(2);
  });

  test("clearAllRegistries resets everything", () => {
    registerMachine("machine-1", "owner-1", "key-1", "kx-1", createMockWs("conn-1"));

    clearAllRegistries();

    const stats = getRegistryStats();
    expect(stats.machineCount).toBe(0);
    expect(stats.onlineMachineCount).toBe(0);
  });
});
