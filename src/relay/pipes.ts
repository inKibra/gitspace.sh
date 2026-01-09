/**
 * Pipe management - manages machine-to-client connections
 *
 * A pipe is a channel between one machine and multiple clients.
 * The relay doesn't decrypt or interpret the data - it just broadcasts.
 */

import type { ServerWebSocket } from "bun";
import type { Pipe, WebSocketData } from "./types";

/** All active pipes, keyed by machineId */
const pipes: Map<string, Pipe> = new Map();

/**
 * Open a new pipe for a machine
 */
export function openPipe(machineId: string): Pipe {
  let pipe = pipes.get(machineId);
  if (pipe) {
    console.log(`[pipes] Pipe already exists for ${machineId}`);
    return pipe;
  }

  pipe = {
    machineId,
    machine: null,
    clients: new Set(),
    openedAt: Date.now(),
  };
  pipes.set(machineId, pipe);
  console.log(`[pipes] Opened pipe for ${machineId}`);
  return pipe;
}

/**
 * Close a pipe and disconnect all connections
 */
export function closePipe(machineId: string): void {
  const pipe = pipes.get(machineId);
  if (!pipe) {
    console.log(`[pipes] No pipe found for ${machineId}`);
    return;
  }

  // Close machine connection
  if (pipe.machine) {
    pipe.machine.close(1000, "Pipe closed");
  }

  // Close all client connections
  for (const client of pipe.clients) {
    client.close(1000, "Pipe closed");
  }

  pipes.delete(machineId);
  console.log(`[pipes] Closed pipe for ${machineId}`);
}

/**
 * Get a pipe by machineId
 */
export function getPipe(machineId: string): Pipe | undefined {
  return pipes.get(machineId);
}

/**
 * Check if a pipe exists
 */
export function hasPipe(machineId: string): boolean {
  return pipes.has(machineId);
}

/**
 * Connect a machine to its pipe
 */
export function connectMachine(
  machineId: string,
  ws: ServerWebSocket<WebSocketData>
): boolean {
  const pipe = pipes.get(machineId);
  if (!pipe) {
    console.log(`[pipes] No pipe for machine ${machineId}`);
    return false;
  }

  if (pipe.machine) {
    console.log(`[pipes] Machine ${machineId} already connected, replacing`);
    pipe.machine.close(1000, "Replaced by new connection");
  }

  pipe.machine = ws;
  console.log(
    `[pipes] Machine ${machineId} connected (${pipe.clients.size} clients)`
  );
  return true;
}

/**
 * Disconnect a machine from its pipe
 */
export function disconnectMachine(machineId: string): void {
  const pipe = pipes.get(machineId);
  if (!pipe) return;

  pipe.machine = null;
  console.log(`[pipes] Machine ${machineId} disconnected`);
}

/**
 * Connect a client to a machine's pipe
 */
export function connectClient(
  machineId: string,
  ws: ServerWebSocket<WebSocketData>
): boolean {
  const pipe = pipes.get(machineId);
  if (!pipe) {
    console.log(`[pipes] No pipe for client to connect to ${machineId}`);
    return false;
  }

  pipe.clients.add(ws);
  console.log(
    `[pipes] Client connected to ${machineId} (${pipe.clients.size} clients)`
  );
  return true;
}

/**
 * Disconnect a client from a machine's pipe
 */
export function disconnectClient(
  machineId: string,
  ws: ServerWebSocket<WebSocketData>
): void {
  const pipe = pipes.get(machineId);
  if (!pipe) return;

  pipe.clients.delete(ws);
  console.log(
    `[pipes] Client disconnected from ${machineId} (${pipe.clients.size} clients)`
  );
}

/**
 * Broadcast data from one connection to all others on the same pipe
 *
 * - If from machine: send to all clients
 * - If from client: send to machine only
 */
export function broadcast(
  machineId: string,
  data: ArrayBuffer | Uint8Array,
  from: ServerWebSocket<WebSocketData>
): void {
  const pipe = pipes.get(machineId);
  if (!pipe) return;

  const fromRole = from.data.role;

  if (fromRole === "machine") {
    // Machine -> all clients
    for (const client of pipe.clients) {
      client.send(data);
    }
  } else {
    // Client -> machine only
    if (pipe.machine) {
      pipe.machine.send(data);
    }
  }
}

/**
 * Get stats about all pipes
 */
export function getStats(): {
  pipeCount: number;
  totalClients: number;
  connectedMachines: number;
} {
  let totalClients = 0;
  let connectedMachines = 0;

  for (const pipe of pipes.values()) {
    totalClients += pipe.clients.size;
    if (pipe.machine) connectedMachines++;
  }

  return {
    pipeCount: pipes.size,
    totalClients,
    connectedMachines,
  };
}
