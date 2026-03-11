/**
 * Relay server - Bun.serve() WebSocket server with self-registration
 *
 * Endpoints:
 * - GET /ws?role=<machine|client> - WebSocket upgrade
 * - GET /health - Health check
 *
 * Protocol:
 * - Machines authenticate via Ed25519 challenge-response
 * - Owner clients connect directly to owner-owned machines
 * - Data is routed point-to-point using connectionId
 */

import { join, resolve, sep } from "path";
import { randomBytes } from "crypto";
import type { Server, ServerWebSocket } from "bun";
import type { RelayConfig, WebSocketData } from "./types";
import { ed25519 } from "@noble/curves/ed25519.js";
import { signMessage, verifySignedMessage, getSignerPublicKey, type SignedMessage } from "./signing.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { formatRelayFingerprint, type RelayIdentity } from "./identity.js";
import { deriveIdentityId } from "../lib/tmux-lite/crypto/identity.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { seal } from "../lib/tmux-lite/crypto/secretbox.js";
import {
  validateX25519PublicKey,
  x25519SharedSecret,
} from "../lib/tmux-lite/crypto/keyexchange.js";
import {
  consumeCloudBootstrapTokenForUnlock,
  consumeCloudRegisterPermit,
  getCloudWorkspace,
  getCloudWorkspaceByMachinePublicKey,
  markCloudBootstrapReady,
} from "./control/store.js";
import { getWorkspaceIdentity } from "./control/workspace-identity.js";
import { deriveUnlockKey } from "./unlock-kdf.js";

/**
 * Candidate paths to web terminal dist files (built by Vite).
 *
 * In source mode, relay runs from src/relay and Vite builds to web/dist at repo root.
 * In some environments, process.cwd() is a better anchor than import.meta.dir.
 */
const WEB_DIST_CANDIDATES = [
  join(import.meta.dir, "../web/dist"),
  join(import.meta.dir, "../../web/dist"),
  join(process.cwd(), "web/dist"),
];

/**
 * Try to import embedded assets (only available in compiled binary)
 */
let embeddedAssets: typeof import("./embedded-assets.generated") | null = null;
try {
  embeddedAssets = await import("./embedded-assets.generated.js");
} catch {
  // Not running as compiled binary - use filesystem
}

/**
 * Check if we have embedded assets available
 */
function hasEmbeddedAssets(): boolean {
  return embeddedAssets?.hasEmbeddedAssets() ?? false;
}

/**
 * Get content type for a file extension
 */
function getContentType(pathname: string): string {
  const ext = pathname.split(".").pop();
  const contentTypes: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "application/javascript",
    css: "text/css",
    wasm: "application/wasm",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    ico: "image/x-icon",
  };
  return contentTypes[ext || ""] || "application/octet-stream";
}

function getStaticCacheControl(pathname: string): string {
  if (pathname === "/" || pathname === "/index.html") {
    return "no-cache";
  }
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

/**
 * Serve a static file - tries embedded assets first, falls back to filesystem
 */
async function serveStaticFile(pathname: string): Promise<Response | null> {
  // Normalize path for content type (/ -> /index.html)
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;

  // Try embedded assets first (compiled binary)
  if (hasEmbeddedAssets() && embeddedAssets) {
    const blob = embeddedAssets.getEmbeddedFile(pathname);
    if (blob) {
      return new Response(blob, {
        headers: {
          "Content-Type": getContentType(normalizedPath),
          "Cache-Control": getStaticCacheControl(pathname),
        },
      });
    }
  }

  // Fall back to filesystem (development mode)
  for (const resolvedPath of resolveAssetPaths(normalizedPath)) {
    const file = Bun.file(resolvedPath);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "Content-Type": getContentType(normalizedPath),
          "Cache-Control": getStaticCacheControl(pathname),
        },
      });
    }
  }

  return null;
}
import {
  registerMachine,
  getAllMachines,
  getMachine,
  setMachineConnection,
  getRegistryStats,
} from "./registries";
import {
  parseMessage,
  serializeMessage,
  createErrorMessage,
  isMachineDataMessage,
  isClientDataMessage,
  isClientHandshakeMessage,
  type ProtocolMessage,
  type RegisterMachineMessage,
  type UnlockRequestMessage,
  type ListMachinesMessage,
  type ConnectToMachineMessage,
  type UnlockRelayMessage,
  type CreateRootInviteMessage,
  type ListRootInvitesMessage,
  type RevokeRootInviteMessage,
  type OwnerSyncCompareMessage,
  type OwnerSyncPullMessage,
  type OwnerSyncLockMessage,
  type OwnerSyncPushMessage,
  type OwnerSyncUnlockMessage,
} from "./protocol";
import {
  compareOwnerSync,
  createOwnerSyncRuntimeState,
  lockOwnerSync,
  pullOwnerSync,
  pushOwnerSync,
  unlockOwnerSync,
  type OwnerSyncRuntimeState,
  type SyncCategory,
  OwnerSyncRuntimeError,
} from "./sync/runtime.js";
import {
  isVaultUnlocked,
  isVaultMetadataComplete,
  unlockVault,
  initializeVault,
  openAllMachineUnlockKeys,
  getVaultLockState,
} from "./vault.js";
import {
  registerPersistentMachine,
  setPersistentMachineConnection,
} from "./persistent-registry.js";
import {
  getVaultMachine,
  getVaultMeta,
  isVaultInitialized,
  upsertVaultMachine,
} from "./control/store.js";
import {
  listRootInvites,
  registerRootInvite,
  revokeRootInvite,
  consumeRootInviteToken,
} from "./auth/store.js";
import {
  getMachineIdFromCert,
  getUserRootIdFromCert,
  isDeviceCertExpired,
  verifyDeviceCertificate,
} from "../lib/tmux-lite/crypto/device-cert.js";
import type { DeviceCertificate } from "../types/identity.js";
import {
  isRootInviteExpired,
  parseRootInviteToken,
} from "../lib/tmux-lite/crypto/root-invites.js";

/**
 * Generate a unique connection ID using cryptographically secure randomness
 *
 * Security: Uses crypto.randomBytes instead of Math.random to prevent
 * connection ID prediction attacks.
 */
function generateConnectionId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Challenge timeout in milliseconds (30 seconds)
 */
const CHALLENGE_TIMEOUT_MS = 30000;

/**
 * Connection rate limiting (best-effort, in-memory)
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CONNECTIONS_PER_IP = 20;
const connectionRateLimits = new Map<string, { count: number; lastReset: number }>();

function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  const cfConnecting = req.headers.get("cf-connecting-ip");
  if (cfConnecting) {
    return cfConnecting.trim();
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}

function consumeConnectionSlot(ip: string): boolean {
  const now = Date.now();
  const record = connectionRateLimits.get(ip);
  if (!record || now - record.lastReset > RATE_LIMIT_WINDOW_MS) {
    connectionRateLimits.set(ip, { count: 1, lastReset: now });
    return true;
  }
  if (record.count >= MAX_CONNECTIONS_PER_IP) {
    return false;
  }
  record.count += 1;
  return true;
}

function resolveAssetPaths(pathname: string): string[] {
  const relativePath = pathname.replace(/^\/+/, "");
  const paths: string[] = [];

  for (const candidate of WEB_DIST_CANDIDATES) {
    const webRoot = resolve(candidate);
    const resolvedPath = resolve(webRoot, relativePath);

    if (!resolvedPath.startsWith(webRoot + sep)) {
      continue;
    }

    paths.push(resolvedPath);
  }

  return paths;
}

type SignedClientMessageType =
  | "list_machines"
  | "connect_to_machine"
  | "unlock_relay"
  | "create_root_invite"
  | "list_root_invites"
  | "revoke_root_invite"
  | "owner_sync_compare"
  | "owner_sync_pull"
  | "owner_sync_lock"
  | "owner_sync_push"
  | "owner_sync_unlock";
const SIGNED_CLIENT_MESSAGE_TYPES = new Set<SignedClientMessageType>([
  "list_machines",
  "connect_to_machine",
  "unlock_relay",
  "create_root_invite",
  "list_root_invites",
  "revoke_root_invite",
  "owner_sync_compare",
  "owner_sync_pull",
  "owner_sync_lock",
  "owner_sync_push",
  "owner_sync_unlock",
]);

function createSealedUnlockPayload(
  machineEphemeralPublicKeyBase64: string,
  payload: string
): { ciphertext: string; relayEphemeralKey: string; salt: string } {
  const machineEphemeralPublicKey = new Uint8Array(
    Buffer.from(machineEphemeralPublicKeyBase64, "base64")
  );
  if (!validateX25519PublicKey(machineEphemeralPublicKey)) {
    throw new Error("Invalid machine ephemeral key");
  }

  let relayEphemeralPrivateKey: Uint8Array | null = null;
  let sharedSecret: Uint8Array | null = null;
  let key: Uint8Array | null = null;

  try {
    relayEphemeralPrivateKey = randomBytes(32);
    const relayEphemeralPublicKey = x25519.getPublicKey(relayEphemeralPrivateKey);
    sharedSecret = x25519SharedSecret(relayEphemeralPrivateKey, machineEphemeralPublicKey);
    const salt = randomBytes(32);
    key = deriveUnlockKey(sharedSecret, salt);

    const sealed = seal(Buffer.from(payload, "utf-8"), key);
    return {
      ciphertext: sealed.toString("base64"),
      relayEphemeralKey: Buffer.from(relayEphemeralPublicKey).toString("base64"),
      salt: Buffer.from(salt).toString("base64"),
    };
  } finally {
    relayEphemeralPrivateKey?.fill(0);
    sharedSecret?.fill(0);
    key?.fill(0);
  }
}

function isSignedClientMessageType(type: unknown): type is SignedClientMessageType {
  return typeof type === "string" && SIGNED_CLIENT_MESSAGE_TYPES.has(type as SignedClientMessageType);
}

function hasSignatureFields(signature: unknown): boolean {
  if (!signature || typeof signature !== "object") return false;
  const sig = signature as Record<string, unknown>;
  return typeof sig.sig === "string" && typeof sig.pub === "string" && typeof sig.ts === "number";
}

function rejectUnsignedClientMessage(
  ws: ServerWebSocket<WebSocketData>,
  rawMsg: unknown
): boolean {
  if (ws.data.role !== "client") return false;
  if (!rawMsg || typeof rawMsg !== "object") return false;
  const msg = rawMsg as Record<string, unknown>;
  if (!isSignedClientMessageType(msg.type)) return false;
  if (hasSignatureFields(msg.signature)) return false;
  ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature missing or invalid")));
  return true;
}

function verifyClientIdentity<T extends { clientIdentityId: string }>(
  msg: SignedMessage<T>
): T | null {
  const verified = verifySignedMessage(msg);
  if (!verified) {
    return null;
  }

  const signerKey = getSignerPublicKey(msg);
  if (!signerKey) {
    return null;
  }

  let derivedId: string;
  try {
    derivedId = deriveIdentityId(signerKey);
  } catch {
    return null;
  }

  if (derivedId !== verified.clientIdentityId) {
    return null;
  }

  return verified;
}

function deriveClientUserRootIdFromCertificate(
  deviceCertificate: string,
  clientIdentityId: string,
): { success: true; userRootId: string } | { success: false; error: string } {
  let cert: DeviceCertificate;
  try {
    cert = JSON.parse(deviceCertificate) as DeviceCertificate;
  } catch {
    return { success: false, error: "Invalid device certificate format" };
  }

  if (!verifyDeviceCertificate(cert)) {
    return { success: false, error: "Invalid device certificate signature" };
  }

  if (isDeviceCertExpired(cert)) {
    return { success: false, error: "Device certificate expired" };
  }

  const certMachineId = getMachineIdFromCert(cert);
  if (certMachineId !== clientIdentityId) {
    return { success: false, error: "Device certificate identity mismatch" };
  }

  return {
    success: true,
    userRootId: getUserRootIdFromCert(cert),
  };
}

function isClientAllowedForMachine(
  machineId: string,
  clientUserRootId: string,
  ownerUserRootIdHint: string | null,
): boolean {
  const machineRecord = getVaultMachine(machineId);
  const ownerUserRootId = machineRecord?.ownerUserRootId ?? ownerUserRootIdHint;
  if (!ownerUserRootId) {
    return false;
  }

  return clientUserRootId === ownerUserRootId;
}

function authenticateOwnerClient<T extends {
  clientIdentityId: string;
  deviceCertificate: string;
}>(
  state: RelayServerState,
  ws: ServerWebSocket<WebSocketData>,
  message: SignedMessage<T>,
): { clientIdentityId: string; ownerUserRootId: string } | null {
  const verified = verifyClientIdentity(message);
  if (!verified) {
    ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature invalid")));
    return null;
  }

  if (ws.data.clientIdentityId && ws.data.clientIdentityId !== verified.clientIdentityId) {
    ws.send(serializeMessage(createErrorMessage("IDENTITY_MISMATCH", "Client identity does not match connection")));
    return null;
  }
  ws.data.clientIdentityId = verified.clientIdentityId;

  const clientRootResult = deriveClientUserRootIdFromCertificate(
    verified.deviceCertificate,
    verified.clientIdentityId,
  );
  if (!clientRootResult.success) {
    ws.send(serializeMessage(createErrorMessage("FORBIDDEN", clientRootResult.error)));
    return null;
  }

  const configuredOwnerUserRootId = state.ownerUserRootId ?? getVaultMeta("owner_user_root_id") ?? null;
  if (!configuredOwnerUserRootId) {
    ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Relay owner user root is not configured")));
    return null;
  }

  if (clientRootResult.userRootId !== configuredOwnerUserRootId) {
    ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "User root is not the relay owner")));
    return null;
  }

  if (!state.ownerUserRootId) {
    state.ownerUserRootId = configuredOwnerUserRootId;
  }

  return {
    clientIdentityId: verified.clientIdentityId,
    ownerUserRootId: configuredOwnerUserRootId,
  };
}

interface RelayServerState {
  clientConnections: Map<string, ServerWebSocket<WebSocketData>>;
  machineClients: Map<string, Set<string>>;
  pendingChallenges: Map<string, { nonce: Uint8Array; timestamp: number }>;
  preAuthorizedMachines: Set<string>;
  signRelayMessage: <T extends object>(msg: T) => T;
  /** Owner user root ID (set after vault initialization or unlock) */
  ownerUserRootId: string | null;
  ownerSyncState: OwnerSyncRuntimeState;
}

/**
 * Set up a client connection to a machine
 * Tracks the connection and updates machineClients map
 */
function setupClientConnection(
  state: RelayServerState,
  machineId: string,
  connectionId: string,
  ws: ServerWebSocket<WebSocketData>,
  clientIdentityId: string
): void {
  ws.data.machineId = machineId;
  ws.data.clientIdentityId = clientIdentityId;

  // Track client connection
  state.clientConnections.set(connectionId, ws);

  let clients = state.machineClients.get(machineId);
  if (!clients) {
    clients = new Set();
    state.machineClients.set(machineId, clients);
  }
  clients.add(connectionId);
}

/**
 * Create the relay server
 */
export function createRelayServer(config: RelayConfig): Server<WebSocketData> {
  const { port, bind = "0.0.0.0", hostname, identity } = config;
  const disableRateLimit = config.disableRateLimit === true;

  // NOTE: This file can be used in Bun tests which run files in parallel.
  // Keep mutable state per-server instance (not module-global) so multiple
  // relay servers can coexist in the same process without interfering.
  const relayIdentity: RelayIdentity = identity;
  const fingerprint = formatRelayFingerprint(identity.signingPublicKey);
  console.log(`[relay] Using identity: ${fingerprint}${identity.label ? ` (${identity.label})` : ""}`);

  // Store pre-authorized machines (for ephemeral local relays)
  const preAuthorizedMachines: Set<string> = config.preAuthorizedMachines instanceof Set
    ? config.preAuthorizedMachines
    : new Set(config.preAuthorizedMachines || []);
  if (preAuthorizedMachines.size > 0) {
    console.log(`[relay] Pre-authorized ${preAuthorizedMachines.size} machine(s)`);
  }

  /**
   * Client connections by connectionId (for routing machine → client)
   */
  const clientConnections = new Map<string, ServerWebSocket<WebSocketData>>();

  /**
   * Track which clients are connected to which machine
   * machineId → Set<connectionId>
   */
  const machineClients = new Map<string, Set<string>>();

  /**
   * Track pending identity challenges for machine connections
   * connectionId → { nonce, timestamp }
   */
  interface PendingChallenge {
    nonce: Uint8Array;
    timestamp: number;
  }
  const pendingChallenges = new Map<string, PendingChallenge>();

  /**
   * Sign a message with the relay's private key
   * Returns the message with signature
   */
  const signRelayMessage = <T extends object>(msg: T): T => {
    const pubKeyBytes = new Uint8Array(Buffer.from(relayIdentity.signingPublicKey, "base64"));
    return signMessage(msg, relayIdentity.signingPrivateKey, pubKeyBytes);
  };

  // Determine owner from vault metadata when available
  const ownerUserRootId = getVaultMeta('owner_user_root_id') ?? null;
  if (ownerUserRootId) {
    console.log(`[relay] Vault owner: ${ownerUserRootId.slice(0, 8)}...`);
    console.log(`[relay] Vault state: ${isVaultInitialized() ? getVaultLockState() : 'uninitialized'}`);
  }

  const state: RelayServerState = {
    clientConnections,
    machineClients,
    pendingChallenges,
    preAuthorizedMachines,
    signRelayMessage,
    ownerUserRootId,
    ownerSyncState: createOwnerSyncRuntimeState(),
  };

  const server = Bun.serve<WebSocketData>({
    port,
    hostname: bind,

    async fetch(req, server) {
      const url = new URL(req.url);

      // Health check - always allowed regardless of hostname filter
      // (must be reachable from localhost for local relay discovery)
      if (url.pathname === "/health") {
        const stats = getRegistryStats();
        const clientCount = clientConnections.size;
        return Response.json({
          status: "ok",
          relayPublicKey: relayIdentity.signingPublicKey,
          relayFingerprint: formatRelayFingerprint(relayIdentity.signingPublicKey),
          relayLabel: relayIdentity.label ?? null,
          ...stats,
          connectedClients: clientCount,
        });
      }

      // Check Host header if hostname is specified (after health check which is always allowed)
      if (hostname) {
        const hostHeader = req.headers.get("host");
        const host = hostHeader?.split(":")[0]; // Remove port
        if (host !== hostname) {
          return new Response("Not found", { status: 404 });
        }
      }

      // WebSocket upgrade
      // - Machines and clients connect freely
      // - Machine authentication happens via challenge-response during registration
      // - Client authorization happens via X3DH handshake with machine
      if (url.pathname === "/ws") {
        if (!disableRateLimit) {
          const clientIp = getClientIp(req);
          if (!consumeConnectionSlot(clientIp)) {
            return new Response("Too many connections", { status: 429 });
          }
        }

        const role = url.searchParams.get("role") as "machine" | "client";

        if (!role || !["machine", "client"].includes(role)) {
          return new Response("Invalid role", { status: 400 });
        }

        const wsData: WebSocketData = {
          machineId: "", // Set later by protocol messages
          role,
          connectionId: generateConnectionId(),
        };

        // Upgrade to WebSocket
        const upgraded = server.upgrade(req, { data: wsData });

        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        return undefined;
      }

      // Serve web terminal UI/static assets (embedded or from filesystem)
      const staticResponse = await serveStaticFile(url.pathname);
      if (staticResponse) return staticResponse;

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response("Web UI assets not found. Build them with: bun run build:web", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        const { role, connectionId } = ws.data;
        console.log(`[ws] ${role} ${connectionId} connected`);

        // Send relay_identity message to machines (includes challenge nonce)
        if (role === "machine") {
          const nonce = randomBytes(32);
          const relayIdMsg = {
            type: "relay_identity" as const,
            publicKey: relayIdentity.signingPublicKey,
            fingerprint: formatRelayFingerprint(relayIdentity.signingPublicKey),
            label: relayIdentity.label,
            challenge: nonce.toString("base64"),
          };

          // Store pending challenge
          pendingChallenges.set(connectionId, {
            nonce,
            timestamp: Date.now(),
          });

          ws.send(serializeMessage(relayIdMsg));
          console.log(`[ws] Sent relay_identity to machine ${connectionId}`);
        }
      },

      message(ws, message) {
        // Try to parse as protocol message (JSON)
        const msgStr = typeof message === "string"
          ? message
          : new TextDecoder().decode(message instanceof ArrayBuffer ? message : message);

        let rawMsg: unknown = null;
        // Handle ping/pong for keepalive FIRST (before protocol parsing)
        // These are simple keepalive messages, not protocol messages
        try {
          rawMsg = JSON.parse(msgStr);
          if (rawMsg && typeof rawMsg === "object" && (rawMsg as { type?: string }).type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            return;
          }
        } catch {
          // Not valid JSON - continue with normal handling
        }

        const parsed = parseMessage(msgStr);
        if (!parsed) {
          if (rejectUnsignedClientMessage(ws, rawMsg)) {
            return;
          }
          ws.send(serializeMessage(createErrorMessage("INVALID_REQUEST", "Invalid message format")));
          return;
        }

        // Route data and handshake messages between client and machine
        // All other message types are protocol messages handled by the relay
        if (parsed.type !== "data" && parsed.type !== "handshake") {
          // Handle protocol message
          void handleProtocolMessage(state, ws, parsed);
          return;
        }

        // Handle data/handshake message - route based on role and connectionId
        handleDataMessage(state, ws, message);
      },

      close(ws, code, reason) {
        const { machineId, role, connectionId } = ws.data;
        console.log(
          `[ws] ${role} ${connectionId} disconnected (${code}: ${reason})`
        );

        // Clean up pending challenge if any
        pendingChallenges.delete(connectionId);

        if (role === "machine" && machineId) {
          // Mark machine as offline (in-memory + persistent)
          setMachineConnection(machineId, null);
          setPersistentMachineConnection(machineId, null);

          // Notify connected clients that machine is offline
          const clients = machineClients.get(machineId);
          if (clients) {
            for (const clientConnId of clients) {
              const clientWs = clientConnections.get(clientConnId);
              if (clientWs) {
                clientWs.send(serializeMessage({
                  type: "connection_failed",
                  reason: "Machine disconnected",
                }));
                clientWs.close(1000, "Machine disconnected");
              }
            }
            machineClients.delete(machineId);
          }
        } else if (role === "client") {
          // Remove from client connections
          clientConnections.delete(connectionId);

          // Remove from machine's client set
          if (machineId) {
            const clients = machineClients.get(machineId);
            if (clients) {
              clients.delete(connectionId);
            }

            // Notify machine of client disconnect
            const machine = getMachine(machineId);
            if (machine?.ws) {
              machine.ws.send(serializeMessage({
                type: "client_disconnected",
                connectionId,
                reason: reason || "Client disconnected",
              }));
            }
          }
        }
      },

      drain(_ws) {
        // Called when the socket is ready for more data
      },
    },
  });

  console.log(`[relay] Listening on ${bind}:${port}${hostname ? ` (serving ${hostname})` : ""}`);
  return server;
}

/**
 * Handle protocol messages
 */
async function handleProtocolMessage(
  state: RelayServerState,
  ws: ServerWebSocket<WebSocketData>,
  msg: ProtocolMessage
): Promise<void> {
  const { role, connectionId } = ws.data;

  switch (msg.type) {
    // ========== Machine Messages ==========

    case 'unlock_request': {
      if (role !== 'machine') {
        ws.send(serializeMessage(createErrorMessage('FORBIDDEN', 'Only machines can request unlock grants')));
        return;
      }

      const unlockMsg = msg as UnlockRequestMessage;
      const workspace = getCloudWorkspace(unlockMsg.workspaceId);
      if (!workspace || workspace.status !== 'bootstrapping') {
        ws.send(serializeMessage(createErrorMessage('UNAUTHORIZED', 'Workspace is not in bootstrapping state')));
        ws.close();
        return;
      }

      try {
        const identity = await getWorkspaceIdentity(unlockMsg.workspaceId);
        if (!identity) {
          ws.send(serializeMessage(createErrorMessage('NOT_FOUND', 'Workspace identity not found')));
          ws.close();
          return;
        }

        const unlockGrant = consumeCloudBootstrapTokenForUnlock({
          token: unlockMsg.unlockToken,
          workspaceId: unlockMsg.workspaceId,
          machineSigningPublicKey: identity.signingPublicKey,
        });
        if (!unlockGrant) {
          ws.send(serializeMessage(createErrorMessage('UNAUTHORIZED', 'Invalid or expired unlock token')));
          ws.close();
          return;
        }

        const payload = JSON.stringify(identity);
        const sealed = createSealedUnlockPayload(unlockMsg.ephemeralKey, payload);

        ws.send(serializeMessage({
          type: 'unlock_grant',
          workspaceId: unlockMsg.workspaceId,
          tokenId: unlockGrant.tokenId,
          registerPermit: unlockGrant.registerPermit,
          ciphertext: sealed.ciphertext,
          relayEphemeralKey: sealed.relayEphemeralKey,
          salt: sealed.salt,
          expiresAt: unlockGrant.expiresAt,
        }));
      } catch (error) {
        ws.send(serializeMessage(createErrorMessage('ERROR', `Unlock grant failed: ${error instanceof Error ? error.message : String(error)}`)));
        ws.close();
      }
      return;
    }

    case "register_machine": {
      if (role !== "machine") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only machines can register")));
        return;
      }

      const regMsg = msg as RegisterMachineMessage;

      // Get pending challenge for this connection
      const pending = state.pendingChallenges.get(connectionId);
      if (!pending) {
        ws.send(serializeMessage(createErrorMessage("INVALID_STATE", "No pending challenge - reconnect required")));
        return;
      }

      // Check challenge timeout
      if (Date.now() - pending.timestamp > CHALLENGE_TIMEOUT_MS) {
        state.pendingChallenges.delete(connectionId);
        ws.send(serializeMessage(createErrorMessage("EXPIRED", "Challenge expired - reconnect required")));
        ws.close();
        return;
      }

      // Verify challenge response signature
      if (!regMsg.challengeResponse) {
        ws.send(serializeMessage(createErrorMessage("INVALID_REQUEST", "Challenge response required")));
        return;
      }

      try {
        const signatureBytes = new Uint8Array(Buffer.from(regMsg.challengeResponse, "base64"));
        const pubkeyBytes = new Uint8Array(Buffer.from(regMsg.signingKey, "base64"));

        if (!ed25519.verify(signatureBytes, pending.nonce, pubkeyBytes)) {
          console.warn(`[relay] Challenge verification failed for ${connectionId}`);
          state.pendingChallenges.delete(connectionId);
          ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Challenge response signature invalid")));
          ws.close();
          return;
        }
      } catch (err) {
        console.error(`[relay] Challenge verification error:`, err);
        state.pendingChallenges.delete(connectionId);
        ws.send(serializeMessage(createErrorMessage("ERROR", "Challenge verification failed")));
        ws.close();
        return;
      }

      // Challenge verified - clean up pending challenge
      state.pendingChallenges.delete(connectionId);

      // Check if machine is authorized to connect to this relay.
      // Sources of authorization (checked in order):
      // 1) pre-authorized key set (ephemeral local relay startup)
      // 2) persisted machine registration (vault_machines)
      // 3) device certificate signed by relay owner's user root identity
      // 4) valid one-time register permit (cloud unlock flow)
      // 5) valid root-signed relay-machine invite token
      const persistedMachine = getVaultMachine(regMsg.machineId);
      if (persistedMachine && persistedMachine.signingKey !== regMsg.signingKey) {
        ws.send(serializeMessage(createErrorMessage(
          "FORBIDDEN",
          "Machine signing key does not match persisted machine identity"
        )));
        ws.close();
        return;
      }

      if (
        persistedMachine &&
        state.ownerUserRootId &&
        persistedMachine.ownerUserRootId !== state.ownerUserRootId
      ) {
        ws.send(serializeMessage(createErrorMessage(
          "FORBIDDEN",
          "Persisted machine owner does not match relay owner"
        )));
        ws.close();
        return;
      }

      const isPreAuthorized = state.preAuthorizedMachines.has(regMsg.signingKey);
      const isPersistedMachine = Boolean(persistedMachine);
      let isAuthorizedMachine = isPreAuthorized || isPersistedMachine;
      let bootstrapWorkspaceId: string | undefined;
      let enrollmentOwnerUserRootId: string | null = null;
      let authorizationSource: string | null = isPreAuthorized
        ? 'pre-authorized'
        : isPersistedMachine
          ? 'persisted-machine'
          : null;

      // ── Auth path 3: Device certificate signed by relay owner ─────────
      // If the machine presents a valid device certificate signed by the
      // relay's owner, auto-authorize it. This enables same-machine and
      // remote-same-owner pairing without enrollment tokens.
      if (!isAuthorizedMachine && regMsg.deviceCertificate) {
        try {
          const cert: DeviceCertificate = JSON.parse(regMsg.deviceCertificate);

          // Verify cert signature is cryptographically valid
          if (!verifyDeviceCertificate(cert)) {
            console.warn(`[relay] Device certificate signature verification failed for ${regMsg.machineId}`);
            ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Device certificate signature invalid")));
            ws.close();
            return;
          }

          // Verify cert is not expired
          if (isDeviceCertExpired(cert)) {
            console.warn(`[relay] Device certificate expired for ${regMsg.machineId}`);
            ws.send(serializeMessage(createErrorMessage("EXPIRED", "Device certificate has expired")));
            ws.close();
            return;
          }

          // Verify the cert's device keys match the registration message keys
          if (cert.deviceSigningPublicKey !== regMsg.signingKey) {
            console.warn(`[relay] Device cert signing key mismatch for ${regMsg.machineId}`);
            ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Device certificate signing key does not match registration")));
            ws.close();
            return;
          }
          if (cert.deviceKeyExchangePublicKey !== regMsg.keyExchangeKey) {
            console.warn(`[relay] Device cert key exchange key mismatch for ${regMsg.machineId}`);
            ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Device certificate key exchange key does not match registration")));
            ws.close();
            return;
          }

          const certMachineId = getMachineIdFromCert(cert);
          if (certMachineId !== regMsg.machineId) {
            console.warn(`[relay] Device cert machine ID mismatch for ${regMsg.machineId}`);
            ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Device certificate machine ID does not match registration")));
            ws.close();
            return;
          }

          // Extract user root ID from the certificate and check against relay owner
          const certUserRootId = getUserRootIdFromCert(cert);
          const relayOwnerUserRootId = state.ownerUserRootId ?? getVaultMeta('owner_user_root_id') ?? null;

          if (relayOwnerUserRootId && certUserRootId === relayOwnerUserRootId) {
            // Certificate is signed by the relay's owner — auto-authorize
            isAuthorizedMachine = true;
            enrollmentOwnerUserRootId = certUserRootId;
            authorizationSource = 'owner-device-cert';
            console.log(`[relay] Machine ${regMsg.machineId.slice(0, 8)}... authorized via owner device certificate`);
          } else if (!relayOwnerUserRootId) {
            console.warn(`[relay] Device cert presented but relay has no owner set — cannot verify ownership`);
          } else {
            console.warn(`[relay] Device cert user root ${certUserRootId.slice(0, 8)}... does not match relay owner ${relayOwnerUserRootId.slice(0, 8)}...`);
          }
        } catch (err) {
          console.warn(`[relay] Failed to parse device certificate: ${err instanceof Error ? err.message : String(err)}`);
          // Don't reject — fall through to other auth paths
        }
      }

      const cloudWorkspaceForKey = getCloudWorkspaceByMachinePublicKey(regMsg.signingKey);

      // Owner-gated wake flow for cloud workspaces:
      // if this machine key is tied to a cloud workspace in bootstrapping state,
      // require a fresh one-time register permit minted by unlock_request.
      const requiresRegisterPermit = cloudWorkspaceForKey?.status === 'bootstrapping';

      if (!isAuthorizedMachine && requiresRegisterPermit && regMsg.registerPermit) {
        try {
          const consumedPermit = consumeCloudRegisterPermit({
            registerPermit: regMsg.registerPermit,
            workspaceId: cloudWorkspaceForKey.id,
            machineId: regMsg.machineId,
            machineSigningPublicKey: regMsg.signingKey,
          });

          if (!consumedPermit) {
            ws.send(serializeMessage(createErrorMessage("UNAUTHORIZED", "Invalid or expired register permit")));
            ws.close();
            return;
          }

          markCloudBootstrapReady(consumedPermit.workspaceId);
          bootstrapWorkspaceId = consumedPermit.workspaceId;
          isAuthorizedMachine = true;
          authorizationSource = `register-permit:${consumedPermit.workspaceId}`;
          console.log(
            `[relay] Register permit accepted for machine ${regMsg.machineId} (workspace ${consumedPermit.workspaceId})`
          );
        } catch (err) {
          console.warn(`[relay] Register permit validation failed: ${err instanceof Error ? err.message : String(err)}`);
          ws.send(serializeMessage(createErrorMessage("UNAUTHORIZED", "Register permit validation failed")));
          ws.close();
          return;
        }
      }

      if (!isAuthorizedMachine && regMsg.enrollmentToken) {
        const parsedInvite = parseRootInviteToken(regMsg.enrollmentToken);
        if (!parsedInvite || parsedInvite.type !== 'relay-machine') {
          ws.send(serializeMessage(createErrorMessage("UNAUTHORIZED", "Invalid relay-machine invite token")));
          ws.close();
          return;
        }

        if (isRootInviteExpired(parsedInvite)) {
          ws.send(serializeMessage(createErrorMessage("UNAUTHORIZED", "Relay-machine invite token expired")));
          ws.close();
          return;
        }

        if (parsedInvite.targetMachineId !== regMsg.machineId) {
          ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Invite machine ID does not match this machine")));
          ws.close();
          return;
        }

        if (parsedInvite.targetMachineSigningKey !== regMsg.signingKey) {
          ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Invite signing key does not match this machine")));
          ws.close();
          return;
        }

        if (parsedInvite.targetMachineKeyExchangeKey !== regMsg.keyExchangeKey) {
          ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Invite key exchange key does not match this machine")));
          ws.close();
          return;
        }

        const relayOwnerUserRootId = state.ownerUserRootId ?? getVaultMeta('owner_user_root_id') ?? null;
        if (relayOwnerUserRootId && relayOwnerUserRootId !== parsedInvite.ownerUserRootId) {
          ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Invite owner does not match relay owner")));
          ws.close();
          return;
        }

        const consumedInvite = consumeRootInviteToken(
          parsedInvite.inviteId,
          parsedInvite.ownerUserRootId,
          regMsg.enrollmentToken,
        );
        if (!consumedInvite) {
          ws.send(serializeMessage(createErrorMessage("UNAUTHORIZED", "Invite not found, revoked, expired, or exhausted")));
          ws.close();
          return;
        }

        enrollmentOwnerUserRootId = parsedInvite.ownerUserRootId;
        if (!state.ownerUserRootId) {
          state.ownerUserRootId = parsedInvite.ownerUserRootId;
        }
        isAuthorizedMachine = true;
        authorizationSource = `root-invite:${parsedInvite.inviteId}`;

        if (cloudWorkspaceForKey?.status === 'bootstrapping') {
          markCloudBootstrapReady(cloudWorkspaceForKey.id);
          bootstrapWorkspaceId = cloudWorkspaceForKey.id;
        }
      }

      if (!isAuthorizedMachine && requiresRegisterPermit) {
        ws.send(serializeMessage(createErrorMessage(
          "UNAUTHORIZED",
          "Relay-machine invite required while cloud workspace is bootstrapping"
        )));
        ws.close();
        return;
      }

      if (!isAuthorizedMachine) {
        console.warn(`[relay] Machine not authorized: ${regMsg.machineId} (no valid authorization source)`);
        ws.send(serializeMessage(createErrorMessage("UNAUTHORIZED", "Machine not authorized for this relay")));
        ws.close();
        return;
      }

      const resolvedOwnerUserRootId = enrollmentOwnerUserRootId
        ?? persistedMachine?.ownerUserRootId
        ?? state.ownerUserRootId
        ?? getVaultMeta('owner_user_root_id')
        ?? null;

      if (!resolvedOwnerUserRootId) {
        ws.send(serializeMessage(createErrorMessage(
          "FORBIDDEN",
          "Relay owner user root is not configured for machine registration"
        )));
        ws.close();
        return;
      }

      if (state.ownerUserRootId && state.ownerUserRootId !== resolvedOwnerUserRootId) {
        ws.send(serializeMessage(createErrorMessage(
          "FORBIDDEN",
          "Machine owner does not match relay owner"
        )));
        ws.close();
        return;
      }

      if (!state.ownerUserRootId) {
        state.ownerUserRootId = resolvedOwnerUserRootId;
      }

      // Register the machine (with ownership verification for re-registration)
      const result = registerMachine(
        regMsg.machineId,
        resolvedOwnerUserRootId,
        regMsg.signingKey,
        regMsg.keyExchangeKey,
        ws,
        regMsg.label
      );

      // Handle registration failure (e.g., machine hijacking attempt)
      if (!result.success) {
        console.warn(`[relay] Machine registration rejected: ${result.error} (machineId=${regMsg.machineId})`);
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", result.error)));
        return;
      }

      // Dual-write to persistent registry (SQLite-backed, survives restarts)
      const persistOwner = resolvedOwnerUserRootId;
      const persistResult = registerPersistentMachine(
        regMsg.machineId,
        persistOwner,
        regMsg.signingKey,
        regMsg.keyExchangeKey,
        ws,
        regMsg.label
      );
      if (!persistResult.success) {
        // Log but don't block — in-memory registry is the source of truth for now
        console.warn(`[relay] Persistent registry dual-write failed: ${persistResult.error} (machineId=${regMsg.machineId})`);
      }

      const vaultOwner = resolvedOwnerUserRootId;
      if (vaultOwner) {
        const vaultResult = upsertVaultMachine({
          machineId: regMsg.machineId,
          ownerUserRootId: vaultOwner,
          signingKey: regMsg.signingKey,
          keyExchangeKey: regMsg.keyExchangeKey,
          label: regMsg.label,
        });
        if (!vaultResult.success) {
          console.warn(`[relay] Vault machine registration rejected: ${vaultResult.error} (machineId=${regMsg.machineId})`);
          ws.send(serializeMessage(createErrorMessage("FORBIDDEN", vaultResult.error)));
          ws.close();
          return;
        }
      }

      // Update ws data
      ws.data.machineId = regMsg.machineId;
      ws.data.ownerUserRootId = resolvedOwnerUserRootId;

      console.log(
        `[relay] Machine ${regMsg.machineId} registered (authorized: ${authorizationSource ?? 'unknown'}${bootstrapWorkspaceId ? `, bootstrapWorkspace=${bootstrapWorkspaceId}` : ""})`
      );

      ws.send(serializeMessage({
        type: "registered",
        machineId: regMsg.machineId,
      }));

      break;
    }

    case "create_root_invite": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can create invites")));
        return;
      }

      const createMsg = msg as CreateRootInviteMessage;
      const verified = verifyClientIdentity(createMsg);
      if (!verified) {
        ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature invalid")));
        return;
      }

      if (ws.data.clientIdentityId && ws.data.clientIdentityId !== verified.clientIdentityId) {
        ws.send(serializeMessage(createErrorMessage("IDENTITY_MISMATCH", "Client identity does not match connection")));
        return;
      }
      ws.data.clientIdentityId = verified.clientIdentityId;

      const clientRootResult = deriveClientUserRootIdFromCertificate(
        createMsg.deviceCertificate,
        verified.clientIdentityId,
      );
      if (!clientRootResult.success) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", clientRootResult.error)));
        return;
      }

      const parsedInvite = parseRootInviteToken(createMsg.inviteToken);
      if (!parsedInvite) {
        ws.send(serializeMessage(createErrorMessage("INVALID_REQUEST", "Invalid invite token format or signature")));
        return;
      }

      if (isRootInviteExpired(parsedInvite)) {
        ws.send(serializeMessage(createErrorMessage("INVALID_REQUEST", "Invite token is already expired")));
        return;
      }

      if (parsedInvite.ownerUserRootId !== clientRootResult.userRootId) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Invite owner does not match authenticated user root")));
        return;
      }

      if (parsedInvite.type !== 'relay-machine') {
        ws.send(serializeMessage(createErrorMessage(
          "INVALID_REQUEST",
          "Only relay-machine invites are supported"
        )));
        return;
      }

      let expiresAtIso: string;
      try {
        expiresAtIso = new Date(parsedInvite.expiresAt).toISOString();
      } catch {
        ws.send(serializeMessage(createErrorMessage("INVALID_REQUEST", "Invite expiry is invalid")));
        return;
      }

      try {
        registerRootInvite({
          inviteId: parsedInvite.inviteId,
          ownerUserRootId: parsedInvite.ownerUserRootId,
          inviteType: parsedInvite.type,
          relayUrl: parsedInvite.relayUrl,
          token: createMsg.inviteToken,
          maxUses: parsedInvite.maxUses,
          expiresAt: expiresAtIso,
          label: parsedInvite.label,
          machineId: parsedInvite.targetMachineId,
          targetMachineSigningKey: parsedInvite.targetMachineSigningKey,
          targetMachineKeyExchangeKey: parsedInvite.targetMachineKeyExchangeKey,
        });
      } catch (error) {
        ws.send(serializeMessage(createErrorMessage(
          "INVALID_REQUEST",
          error instanceof Error ? error.message : 'Failed to register invite'
        )));
        return;
      }

      ws.send(serializeMessage({
        type: 'root_invite_created',
        inviteId: parsedInvite.inviteId,
      }));
      break;
    }

    case "list_root_invites": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can list invites")));
        return;
      }

      const listMsg = msg as ListRootInvitesMessage;
      const verified = verifyClientIdentity(listMsg);
      if (!verified) {
        ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature invalid")));
        return;
      }

      if (ws.data.clientIdentityId && ws.data.clientIdentityId !== verified.clientIdentityId) {
        ws.send(serializeMessage(createErrorMessage("IDENTITY_MISMATCH", "Client identity does not match connection")));
        return;
      }
      ws.data.clientIdentityId = verified.clientIdentityId;

      const clientRootResult = deriveClientUserRootIdFromCertificate(
        listMsg.deviceCertificate,
        verified.clientIdentityId,
      );
      if (!clientRootResult.success) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", clientRootResult.error)));
        return;
      }

      const invites = listRootInvites(clientRootResult.userRootId, {
        inviteType: listMsg.inviteType,
        includeRevoked: true,
        includeExpired: true,
      }).filter((invite) => invite.inviteType === 'relay-machine');

      ws.send(serializeMessage({
        type: 'root_invite_list',
        invites: invites.map((invite) => ({
          inviteId: invite.inviteId,
          inviteType: 'relay-machine' as const,
          relayUrl: invite.relayUrl,
          label: invite.label,
          maxUses: invite.maxUses,
          usedCount: invite.usedCount,
          expiresAt: invite.expiresAt,
          createdAt: invite.createdAt,
          revokedAt: invite.revokedAt,
          machineId: invite.machineId,
          targetMachineSigningKey: invite.targetMachineSigningKey,
          targetMachineKeyExchangeKey: invite.targetMachineKeyExchangeKey,
        })),
      }));
      break;
    }

    case "revoke_root_invite": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can revoke invites")));
        return;
      }

      const revokeMsg = msg as RevokeRootInviteMessage;
      const verified = verifyClientIdentity(revokeMsg);
      if (!verified) {
        ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature invalid")));
        return;
      }

      if (ws.data.clientIdentityId && ws.data.clientIdentityId !== verified.clientIdentityId) {
        ws.send(serializeMessage(createErrorMessage("IDENTITY_MISMATCH", "Client identity does not match connection")));
        return;
      }
      ws.data.clientIdentityId = verified.clientIdentityId;

      const clientRootResult = deriveClientUserRootIdFromCertificate(
        revokeMsg.deviceCertificate,
        verified.clientIdentityId,
      );
      if (!clientRootResult.success) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", clientRootResult.error)));
        return;
      }

      const revoked = revokeRootInvite(clientRootResult.userRootId, revokeMsg.inviteId);
      if (!revoked) {
        ws.send(serializeMessage(createErrorMessage("NOT_FOUND", "Invite not found or already revoked")));
        return;
      }

      ws.send(serializeMessage({
        type: 'root_invite_revoked',
        inviteId: revokeMsg.inviteId,
      }));
      break;
    }

    case "owner_sync_compare": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can compare owner sync state")));
        return;
      }

      const compareMsg = msg as OwnerSyncCompareMessage;
      const auth = authenticateOwnerClient(state, ws, compareMsg);
      if (!auth) {
        return;
      }

      const result = compareOwnerSync(auth.ownerUserRootId, compareMsg.localRevisions);
      ws.send(serializeMessage({
        type: "owner_sync_compare_result",
        serverRevisions: result.serverRevisions,
        changedCategories: result.changedCategories,
      }));
      break;
    }

    case "owner_sync_pull": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can pull owner sync state")));
        return;
      }

      const pullMsg = msg as OwnerSyncPullMessage;
      const auth = authenticateOwnerClient(state, ws, pullMsg);
      if (!auth) {
        return;
      }

      try {
        const records = pullOwnerSync(auth.ownerUserRootId, pullMsg.categories);
        ws.send(serializeMessage({
          type: "owner_sync_pull_result",
          records,
        }));
      } catch (error) {
        if (error instanceof OwnerSyncRuntimeError) {
          ws.send(serializeMessage(createErrorMessage(error.code, error.message)));
          return;
        }

        ws.send(serializeMessage(createErrorMessage(
          "ERROR",
          error instanceof Error ? error.message : "Failed to pull owner sync records",
        )));
      }
      break;
    }

    case "owner_sync_lock": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can acquire owner sync locks")));
        return;
      }

      const lockMsg = msg as OwnerSyncLockMessage;
      const auth = authenticateOwnerClient(state, ws, lockMsg);
      if (!auth) {
        return;
      }

      try {
        const lock = lockOwnerSync(
          state.ownerSyncState,
          auth.ownerUserRootId,
          lockMsg.writerId,
          lockMsg.ttlMs,
        );
        ws.send(serializeMessage({
          type: "owner_sync_lock_granted",
          scope: "global",
          lockId: lock.lockId,
          expiresAt: lock.expiresAt,
        }));
      } catch (error) {
        if (error instanceof OwnerSyncRuntimeError) {
          ws.send(serializeMessage(createErrorMessage(error.code, error.message)));
          return;
        }

        ws.send(serializeMessage(createErrorMessage(
          "ERROR",
          error instanceof Error ? error.message : "Failed to acquire owner sync lock",
        )));
      }
      break;
    }

    case "owner_sync_push": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can push owner sync records")));
        return;
      }

      const pushMsg = msg as OwnerSyncPushMessage;
      const auth = authenticateOwnerClient(state, ws, pushMsg);
      if (!auth) {
        return;
      }

      try {
        const result = pushOwnerSync(
          state.ownerSyncState,
          auth.ownerUserRootId,
          pushMsg.lockId,
          {
            category: pushMsg.record.category as SyncCategory,
            expectedRevision: pushMsg.record.expectedRevision,
            updatedAt: pushMsg.record.updatedAt,
            writerId: pushMsg.record.writerId,
            checksum: pushMsg.record.checksum,
            ciphertext: pushMsg.record.ciphertext,
          },
        );
        ws.send(serializeMessage({
          type: "owner_sync_push_result",
          category: result.category,
          revision: result.revision,
          updatedAt: result.updatedAt,
        }));
      } catch (error) {
        if (error instanceof OwnerSyncRuntimeError) {
          ws.send(serializeMessage(createErrorMessage(error.code, error.message)));
          return;
        }

        ws.send(serializeMessage(createErrorMessage(
          "ERROR",
          error instanceof Error ? error.message : "Failed to push owner sync record",
        )));
      }
      break;
    }

    case "owner_sync_unlock": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can release owner sync locks")));
        return;
      }

      const unlockMsg = msg as OwnerSyncUnlockMessage;
      const auth = authenticateOwnerClient(state, ws, unlockMsg);
      if (!auth) {
        return;
      }

      const released = unlockOwnerSync(
        state.ownerSyncState,
        auth.ownerUserRootId,
        unlockMsg.lockId,
      );
      ws.send(serializeMessage({
        type: "owner_sync_unlock_result",
        released,
      }));
      break;
    }

    // ========== Vault Unlock ==========

    case "unlock_relay": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can unlock the relay")));
        return;
      }

      const unlockMsg = msg as UnlockRelayMessage;

      const userRootPubBytes = new Uint8Array(Buffer.from(unlockMsg.userRootPublicKey, "base64"));
      if (userRootPubBytes.length !== 32) {
        ws.send(serializeMessage(createErrorMessage("INVALID_REQUEST", "Invalid user root public key")));
        return;
      }

      // Verify signature and bind signer to claimed userRootPublicKey.
      if (!verifySignedMessage(unlockMsg, userRootPubBytes)) {
        ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Signature verification failed")));
        return;
      }

      // Derive user root ID from the provided public key
      let userRootId: string;
      try {
        userRootId = deriveIdentityId(userRootPubBytes);
      } catch {
        ws.send(serializeMessage(createErrorMessage("INVALID_REQUEST", "Invalid user root public key")));
        return;
      }

      const storedOwner = state.ownerUserRootId ?? getVaultMeta('owner_user_root_id');
      if (storedOwner && storedOwner !== userRootId) {
        ws.send(serializeMessage({
          type: "unlock_relay_result",
          success: false,
          error: "Not the vault owner",
        }));
        return;
      }

      const needsVaultRepair = isVaultInitialized() && !isVaultMetadataComplete();

      // If vault is not initialized, initialize it with the proof as seed material.
      // The proof field carries the HKDF-derived material the vault needs.
      // Legacy relays may also have an incomplete init flag without salt/key-check;
      // allow a repair only for that broken state.
      if (!isVaultInitialized() || needsVaultRepair) {
        // First-time vault init: derive vault key from the proof
        // The proof is HMAC(challenge, userRootPrivateKey) — we use it as the key material
        const proofBytes = new Uint8Array(Buffer.from(unlockMsg.proof, "base64"));
        let success = false;
        try {
          success = initializeVault(proofBytes, { allowRepair: needsVaultRepair });
        } catch (error) {
          ws.send(serializeMessage({
            type: "unlock_relay_result",
            success: false,
            error: error instanceof Error ? error.message : "Vault initialization failed",
          }));
          return;
        }

        if (success) {
          // Store owner identity
          const { setVaultMeta: setMeta } = await import("./control/store.js");
          setMeta('owner_user_root_id', userRootId);
          state.ownerUserRootId = userRootId;
          console.log(
            `[relay] Vault ${needsVaultRepair ? 'repaired' : 'initialized'} by owner ${userRootId.slice(0, 8)}...`
          );
          ws.send(serializeMessage({
            type: "unlock_relay_result",
            success: true,
            machineCount: 0,
          }));
        } else {
          ws.send(serializeMessage({
            type: "unlock_relay_result",
            success: false,
            error: needsVaultRepair ? "Vault repair failed" : "Vault already initialized",
          }));
        }
        return;
      }

      // Vault exists — verify owner and unlock
      if (isVaultUnlocked()) {
        // Already unlocked
        const unlockKeys = openAllMachineUnlockKeys();
        ws.send(serializeMessage({
          type: "unlock_relay_result",
          success: true,
          machineCount: unlockKeys.size,
        }));
        return;
      }

      // Unlock with the proof material
      const proofBytes = new Uint8Array(Buffer.from(unlockMsg.proof, "base64"));
      const unlocked = unlockVault(proofBytes);

      if (unlocked) {
        state.ownerUserRootId = userRootId;
        const unlockKeys = openAllMachineUnlockKeys();
        console.log(`[relay] Vault unlocked by owner ${userRootId.slice(0, 8)}... (${unlockKeys.size} machine keys)`);
        ws.send(serializeMessage({
          type: "unlock_relay_result",
          success: true,
          machineCount: unlockKeys.size,
        }));
      } else {
        ws.send(serializeMessage({
          type: "unlock_relay_result",
          success: false,
          error: "Invalid proof — vault key derivation failed",
        }));
      }
      return;
    }

    // ========== Client Messages ==========

    case "list_machines": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can list machines")));
        return;
      }

      const listMsg = msg as ListMachinesMessage;
      const verified = verifyClientIdentity(listMsg);
      if (!verified) {
        ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature invalid")));
        return;
      }

      if (ws.data.clientIdentityId && ws.data.clientIdentityId !== verified.clientIdentityId) {
        ws.send(serializeMessage(createErrorMessage("IDENTITY_MISMATCH", "Client identity does not match connection")));
        return;
      }
      ws.data.clientIdentityId = verified.clientIdentityId;

      const clientRootResult = deriveClientUserRootIdFromCertificate(
        listMsg.deviceCertificate,
        verified.clientIdentityId,
      );
      if (!clientRootResult.success) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", clientRootResult.error)));
        return;
      }

      const machines = getAllMachines();
      const visibleMachines = machines.filter((machine) =>
        isClientAllowedForMachine(machine.machineId, clientRootResult.userRootId, state.ownerUserRootId)
      );

      ws.send(serializeMessage({
        type: "machine_list",
        machines: visibleMachines.map((machine) => ({
          machineId: machine.machineId,
          label: machine.label,
          online: machine.ws !== null,
          isAuthorized: true,
          accessType: "full" as const,
          lastConnectedAt: machine.lastConnectedAt,
        })),
      }));
      break;
    }

    case "connect_to_machine": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can connect to machines")));
        return;
      }

      const connectMsg = msg as ConnectToMachineMessage;
      const verified = verifyClientIdentity(connectMsg);
      if (!verified) {
        ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature invalid")));
        return;
      }

      if (ws.data.clientIdentityId && ws.data.clientIdentityId !== verified.clientIdentityId) {
        ws.send(serializeMessage(createErrorMessage("IDENTITY_MISMATCH", "Client identity does not match connection")));
        return;
      }

      const clientRootResult = deriveClientUserRootIdFromCertificate(
        connectMsg.deviceCertificate,
        verified.clientIdentityId,
      );
      if (!clientRootResult.success) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", clientRootResult.error)));
        return;
      }

      // Check machine exists
      const machine = getMachine(connectMsg.machineId);
      if (!machine) {
        ws.send(serializeMessage(createErrorMessage("NOT_FOUND", "Machine not found")));
        return;
      }

      // Check machine is online
      if (!machine.ws) {
        ws.send(serializeMessage(createErrorMessage("OFFLINE", "Machine is offline")));
        return;
      }

      if (!isClientAllowedForMachine(connectMsg.machineId, clientRootResult.userRootId, state.ownerUserRootId)) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "User root is not authorized for this machine")));
        return;
      }

      // Set up client connection tracking
      setupClientConnection(state, connectMsg.machineId, connectionId, ws, verified.clientIdentityId);

      // Notify machine of new client
      machine.ws.send(serializeMessage({
        type: "client_connected",
        connectionId,
        clientIdentityId: verified.clientIdentityId,
      }));

      // Send connection established to client
      ws.send(serializeMessage({
        type: "connection_established",
        machineId: connectMsg.machineId,
        connectionId,
      }));

      console.log(`[relay] Client ${verified.clientIdentityId} connected to ${connectMsg.machineId} directly`);
      break;
    }

    default: {
      // Log unhandled message types (data/handshake are handled separately)
      const unhandled = msg as { type: string };
      console.log(`[relay] Unknown message type: ${unhandled.type}`);
    }
  }
}

/**
 * Handle data/handshake messages - route between machine and clients
 */
function handleDataMessage(
  state: RelayServerState,
  ws: ServerWebSocket<WebSocketData>,
  message: string | ArrayBuffer | Uint8Array
): void {
  const { role, machineId, connectionId } = ws.data;

  if (!machineId) {
    console.log(`[relay] Data from unconnected ${role} ${connectionId}`);
    return;
  }

  const msgStr = typeof message === "string"
    ? message
    : new TextDecoder().decode(message instanceof ArrayBuffer ? message : message);

  const parsed = parseMessage(msgStr);

  if (role === "machine") {
    // Machine sending data - parse to get target connectionId
    if (!parsed || !isMachineDataMessage(parsed)) {
      console.log(`[relay] Invalid data message from machine`);
      return;
    }

    // Route to specific client by connectionId (now properly typed)
    const targetConnId = parsed.connectionId;
    const clientWs = state.clientConnections.get(targetConnId);

    if (clientWs) {
      // Forward data to client (unwrap the connectionId since client knows their own)
      clientWs.send(serializeMessage({
        type: "data",
        data: parsed.data,
      }));
    } else {
      console.log(`[relay] Target client ${targetConnId} not found`);
    }
  } else {
    // Client sending data/handshake - wrap with connectionId for machine
    const machine = getMachine(machineId);
    if (!machine || !machine.ws) {
      console.log(`[relay] Machine ${machineId} not connected`);
      return;
    }

    if (!parsed) {
      console.log(`[relay] Invalid message from client`);
      return;
    }

    if (isClientHandshakeMessage(parsed)) {
      // Wrap handshake message in data envelope for machine
      // The machine handler will decode the base64 and process as handshake
      const handshakeJson = JSON.stringify(parsed);
      machine.ws.send(serializeMessage({
        type: "data",
        connectionId,
        data: Buffer.from(handshakeJson).toString("base64"),
      }));
    } else if (isClientDataMessage(parsed)) {
      // Forward data message with connectionId (now properly typed)
      machine.ws.send(serializeMessage({
        type: "data",
        connectionId,
        data: parsed.data,
      }));
    } else {
      console.log(`[relay] Invalid message from client: ${parsed.type}`);
    }
  }
}
