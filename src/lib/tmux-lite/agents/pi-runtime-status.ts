import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';
import type { PendingQuestion, Permission, SessionStatus } from '../../../agents/agent-runtime-types.js';

export const PI_RUNTIME_SOCKET_ENV = 'GITSPACE_PI_RUNTIME_SOCKET';
export const PI_RUNTIME_SECRET_ENV = 'GITSPACE_PI_RUNTIME_SECRET';
export const PI_RUNTIME_TERMINAL_SESSION_ENV = 'GITSPACE_PI_TERMINAL_SESSION_ID';
const PI_RUNTIME_SIGNATURE_WINDOW_MS = 30_000;
const ROUTER_FRAME_HEADER_BYTES = 4;

let piRuntimeSecret: string | null = null;

export interface PiRuntimeStateSnapshot {
  sessionId: string;
  terminalSessionId: string;
  workspacePath: string;
  status: SessionStatus;
  pendingPermissions: Permission[];
  pendingQuestions: PendingQuestion[];
  errorMessage?: string;
  lastMessage?: string;
}

export interface PiRuntimeUpdateCommand extends PiRuntimeStateSnapshot {
  type: 'pi-runtime-update';
  timestamp: number;
  signature: string;
}

function serializePiRuntimePayload(update: Omit<PiRuntimeUpdateCommand, 'type' | 'signature'>): string {
  return JSON.stringify({
    timestamp: update.timestamp,
    sessionId: update.sessionId,
    terminalSessionId: update.terminalSessionId,
    workspacePath: update.workspacePath,
    status: update.status,
    pendingPermissions: update.pendingPermissions,
    pendingQuestions: update.pendingQuestions,
    errorMessage: update.errorMessage ?? null,
    lastMessage: update.lastMessage ?? null,
  });
}

export function initializePiRuntimeSecret(): string {
  if (!piRuntimeSecret) {
    piRuntimeSecret = randomBytes(32).toString('hex');
  }
  return piRuntimeSecret;
}

export function getPiRuntimeSecret(): string {
  return piRuntimeSecret ?? initializePiRuntimeSecret();
}

export function configurePiRuntimeEnvironment(socketPath: string): Record<string, string> {
  return buildPiRuntimeChildEnvironment(socketPath);
}

export function buildPiRuntimeChildEnvironment(socketPath: string): Record<string, string> {
  return {
    [PI_RUNTIME_SOCKET_ENV]: socketPath,
    [PI_RUNTIME_SECRET_ENV]: getPiRuntimeSecret(),
  };
}

export function createPiRuntimeUpdateCommand(
  snapshot: PiRuntimeStateSnapshot,
  options: { timestamp?: number; secret?: string } = {},
): PiRuntimeUpdateCommand {
  const timestamp = options.timestamp ?? Date.now();
  const payload = {
    timestamp,
    sessionId: snapshot.sessionId,
    terminalSessionId: snapshot.terminalSessionId,
    workspacePath: snapshot.workspacePath,
    status: snapshot.status,
    pendingPermissions: snapshot.pendingPermissions,
    pendingQuestions: snapshot.pendingQuestions,
    errorMessage: snapshot.errorMessage,
    lastMessage: snapshot.lastMessage,
  };
  const secret = options.secret ?? getPiRuntimeSecret();
  const signature = createHmac('sha256', secret).update(serializePiRuntimePayload(payload)).digest('hex');
  return {
    type: 'pi-runtime-update',
    ...payload,
    signature,
  };
}

export function verifyPiRuntimeUpdateCommand(
  command: PiRuntimeUpdateCommand,
  options: { now?: number; secret?: string } = {},
): boolean {
  const now = options.now ?? Date.now();
  if (Math.abs(now - command.timestamp) > PI_RUNTIME_SIGNATURE_WINDOW_MS) {
    return false;
  }

  const payload = {
    timestamp: command.timestamp,
    sessionId: command.sessionId,
    terminalSessionId: command.terminalSessionId,
    workspacePath: command.workspacePath,
    status: command.status,
    pendingPermissions: command.pendingPermissions,
    pendingQuestions: command.pendingQuestions,
    errorMessage: command.errorMessage,
    lastMessage: command.lastMessage,
  };
  const expected = createHmac('sha256', options.secret ?? getPiRuntimeSecret())
    .update(serializePiRuntimePayload(payload))
    .digest();
  const received = Buffer.from(command.signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function encodeRouterMessage(message: PiRuntimeUpdateCommand): Buffer {
  const json = JSON.stringify(message);
  const len = Buffer.byteLength(json);
  const buffer = Buffer.alloc(ROUTER_FRAME_HEADER_BYTES + len);
  buffer.writeUInt32BE(len, 0);
  buffer.write(json, ROUTER_FRAME_HEADER_BYTES);
  return buffer;
}

export async function sendPiRuntimeUpdate(snapshot: PiRuntimeStateSnapshot): Promise<void> {
  const socketPath = process.env[PI_RUNTIME_SOCKET_ENV]?.trim();
  const secret = process.env[PI_RUNTIME_SECRET_ENV]?.trim();
  if (!socketPath || !secret) {
    return;
  }

  const command = createPiRuntimeUpdateCommand(snapshot, { secret });
  const encoded = encodeRouterMessage(command);

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    socket.once('connect', () => {
      socket.end(encoded);
    });
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('close', () => finish(resolve));
  });
}
