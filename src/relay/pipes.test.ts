import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  openPipe,
  closePipe,
  getPipe,
  hasPipe,
  connectMachine,
  disconnectMachine,
  connectClient,
  disconnectClient,
  broadcast,
  getStats,
} from "./pipes";
import type { WebSocketData } from "./types";

// Mock WebSocket for testing
function createMockWs(data: Omit<WebSocketData, 'accountId'> & { accountId?: string }): any {
  const messages: any[] = [];
  return {
    data: { ...data, accountId: data.accountId ?? 'test-account' },
    send: mock((msg: any) => messages.push(msg)),
    close: mock(() => {}),
    _messages: messages,
  };
}

// We need to reset the pipes between tests
// Since pipes is a module-level Map, we'll close all pipes before each test
beforeEach(() => {
  // Get all pipe machineIds and close them
  const stats = getStats();
  // We can't directly access the map, so we'll test with unique machineIds
});

describe("openPipe", () => {
  test("creates a new pipe", () => {
    const machineId = `test-machine-${Date.now()}-1`;
    const pipe = openPipe(machineId);

    expect(pipe.machineId).toBe(machineId);
    expect(pipe.machine).toBeNull();
    expect(pipe.clients.size).toBe(0);
    expect(pipe.openedAt).toBeGreaterThan(0);

    closePipe(machineId); // Cleanup
  });

  test("returns existing pipe if already open", () => {
    const machineId = `test-machine-${Date.now()}-2`;
    const pipe1 = openPipe(machineId);
    const pipe2 = openPipe(machineId);

    expect(pipe1).toBe(pipe2);
    expect(pipe1.openedAt).toBe(pipe2.openedAt);

    closePipe(machineId);
  });
});

describe("closePipe", () => {
  test("removes pipe", () => {
    const machineId = `test-machine-${Date.now()}-3`;
    openPipe(machineId);
    expect(hasPipe(machineId)).toBe(true);

    closePipe(machineId);
    expect(hasPipe(machineId)).toBe(false);
  });

  test("closes machine connection", () => {
    const machineId = `test-machine-${Date.now()}-4`;
    openPipe(machineId);

    const machineWs = createMockWs({
      machineId,
      role: "machine",
      connectionId: "m1",
    });
    connectMachine(machineId, machineWs);

    closePipe(machineId);

    expect(machineWs.close).toHaveBeenCalledWith(1000, "Pipe closed");
  });

  test("closes all client connections", () => {
    const machineId = `test-machine-${Date.now()}-5`;
    openPipe(machineId);

    const client1 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c1",
    });
    const client2 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c2",
    });

    connectClient(machineId, client1);
    connectClient(machineId, client2);

    closePipe(machineId);

    expect(client1.close).toHaveBeenCalledWith(1000, "Pipe closed");
    expect(client2.close).toHaveBeenCalledWith(1000, "Pipe closed");
  });

  test("handles closing non-existent pipe", () => {
    // Should not throw
    closePipe("non-existent-machine");
  });
});

describe("getPipe/hasPipe", () => {
  test("getPipe returns pipe if exists", () => {
    const machineId = `test-machine-${Date.now()}-6`;
    openPipe(machineId);

    const pipe = getPipe(machineId);
    expect(pipe).not.toBeUndefined();
    expect(pipe!.machineId).toBe(machineId);

    closePipe(machineId);
  });

  test("getPipe returns undefined if not exists", () => {
    const pipe = getPipe("non-existent");
    expect(pipe).toBeUndefined();
  });

  test("hasPipe returns true if exists", () => {
    const machineId = `test-machine-${Date.now()}-7`;
    openPipe(machineId);

    expect(hasPipe(machineId)).toBe(true);

    closePipe(machineId);
  });

  test("hasPipe returns false if not exists", () => {
    expect(hasPipe("non-existent")).toBe(false);
  });
});

describe("connectMachine/disconnectMachine", () => {
  test("connects machine to pipe", () => {
    const machineId = `test-machine-${Date.now()}-8`;
    openPipe(machineId);

    const machineWs = createMockWs({
      machineId,
      role: "machine",
      connectionId: "m1",
    });

    const result = connectMachine(machineId, machineWs);

    expect(result).toBe(true);
    expect(getPipe(machineId)!.machine).toBe(machineWs);

    closePipe(machineId);
  });

  test("returns false if pipe not exists", () => {
    const machineWs = createMockWs({
      machineId: "non-existent",
      role: "machine",
      connectionId: "m1",
    });

    const result = connectMachine("non-existent", machineWs);
    expect(result).toBe(false);
  });

  test("replaces existing machine connection", () => {
    const machineId = `test-machine-${Date.now()}-9`;
    openPipe(machineId);

    const machine1 = createMockWs({
      machineId,
      role: "machine",
      connectionId: "m1",
    });
    const machine2 = createMockWs({
      machineId,
      role: "machine",
      connectionId: "m2",
    });

    connectMachine(machineId, machine1);
    connectMachine(machineId, machine2);

    expect(machine1.close).toHaveBeenCalledWith(1000, "Replaced by new connection");
    expect(getPipe(machineId)!.machine).toBe(machine2);

    closePipe(machineId);
  });

  test("disconnects machine", () => {
    const machineId = `test-machine-${Date.now()}-10`;
    openPipe(machineId);

    const machineWs = createMockWs({
      machineId,
      role: "machine",
      connectionId: "m1",
    });
    connectMachine(machineId, machineWs);

    disconnectMachine(machineId);

    expect(getPipe(machineId)!.machine).toBeNull();

    closePipe(machineId);
  });
});

describe("connectClient/disconnectClient", () => {
  test("connects client to pipe", () => {
    const machineId = `test-machine-${Date.now()}-11`;
    openPipe(machineId);

    const clientWs = createMockWs({
      machineId,
      role: "client",
      connectionId: "c1",
    });

    const result = connectClient(machineId, clientWs);

    expect(result).toBe(true);
    expect(getPipe(machineId)!.clients.has(clientWs)).toBe(true);

    closePipe(machineId);
  });

  test("connects multiple clients", () => {
    const machineId = `test-machine-${Date.now()}-12`;
    openPipe(machineId);

    const client1 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c1",
    });
    const client2 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c2",
    });

    connectClient(machineId, client1);
    connectClient(machineId, client2);

    expect(getPipe(machineId)!.clients.size).toBe(2);

    closePipe(machineId);
  });

  test("returns false if pipe not exists", () => {
    const clientWs = createMockWs({
      machineId: "non-existent",
      role: "client",
      connectionId: "c1",
    });

    const result = connectClient("non-existent", clientWs);
    expect(result).toBe(false);
  });

  test("disconnects client", () => {
    const machineId = `test-machine-${Date.now()}-13`;
    openPipe(machineId);

    const clientWs = createMockWs({
      machineId,
      role: "client",
      connectionId: "c1",
    });
    connectClient(machineId, clientWs);

    disconnectClient(machineId, clientWs);

    expect(getPipe(machineId)!.clients.has(clientWs)).toBe(false);

    closePipe(machineId);
  });
});

describe("broadcast", () => {
  test("machine broadcasts to all clients", () => {
    const machineId = `test-machine-${Date.now()}-14`;
    openPipe(machineId);

    const machineWs = createMockWs({
      machineId,
      role: "machine",
      connectionId: "m1",
    });
    const client1 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c1",
    });
    const client2 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c2",
    });

    connectMachine(machineId, machineWs);
    connectClient(machineId, client1);
    connectClient(machineId, client2);

    const data = new Uint8Array([1, 2, 3, 4]);
    broadcast(machineId, data, machineWs);

    expect(client1.send).toHaveBeenCalledWith(data);
    expect(client2.send).toHaveBeenCalledWith(data);
    expect(machineWs.send).not.toHaveBeenCalled(); // Machine doesn't receive its own message

    closePipe(machineId);
  });

  test("client broadcasts to machine only", () => {
    const machineId = `test-machine-${Date.now()}-15`;
    openPipe(machineId);

    const machineWs = createMockWs({
      machineId,
      role: "machine",
      connectionId: "m1",
    });
    const client1 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c1",
    });
    const client2 = createMockWs({
      machineId,
      role: "client",
      connectionId: "c2",
    });

    connectMachine(machineId, machineWs);
    connectClient(machineId, client1);
    connectClient(machineId, client2);

    const data = new Uint8Array([5, 6, 7, 8]);
    broadcast(machineId, data, client1);

    expect(machineWs.send).toHaveBeenCalledWith(data);
    expect(client1.send).not.toHaveBeenCalled();
    expect(client2.send).not.toHaveBeenCalled(); // Other clients don't get client->machine messages

    closePipe(machineId);
  });

  test("does nothing if pipe not exists", () => {
    const clientWs = createMockWs({
      machineId: "non-existent",
      role: "client",
      connectionId: "c1",
    });

    // Should not throw
    broadcast("non-existent", new Uint8Array([1, 2, 3]), clientWs);
  });

  test("does nothing if machine not connected", () => {
    const machineId = `test-machine-${Date.now()}-16`;
    openPipe(machineId);

    const clientWs = createMockWs({
      machineId,
      role: "client",
      connectionId: "c1",
    });
    connectClient(machineId, clientWs);

    // No machine connected, should not throw
    broadcast(machineId, new Uint8Array([1, 2, 3]), clientWs);

    closePipe(machineId);
  });
});

describe("getStats", () => {
  test("returns correct stats", () => {
    const machineId1 = `test-machine-${Date.now()}-17`;
    const machineId2 = `test-machine-${Date.now()}-18`;

    openPipe(machineId1);
    openPipe(machineId2);

    const machine1 = createMockWs({
      machineId: machineId1,
      role: "machine",
      connectionId: "m1",
    });
    connectMachine(machineId1, machine1);

    const client1 = createMockWs({
      machineId: machineId1,
      role: "client",
      connectionId: "c1",
    });
    const client2 = createMockWs({
      machineId: machineId1,
      role: "client",
      connectionId: "c2",
    });
    connectClient(machineId1, client1);
    connectClient(machineId1, client2);

    const stats = getStats();

    expect(stats.pipeCount).toBeGreaterThanOrEqual(2);
    expect(stats.connectedMachines).toBeGreaterThanOrEqual(1);
    expect(stats.totalClients).toBeGreaterThanOrEqual(2);

    closePipe(machineId1);
    closePipe(machineId2);
  });
});
