/**
 * Relay server - Bun.serve() WebSocket server with self-registration
 *
 * Endpoints:
 * - GET /ws?role=<machine|client> - WebSocket upgrade
 * - GET /health - Health check
 *
 * Protocol:
 * - Machines authenticate via Ed25519 challenge-response
 * - Clients connect via invites or directly if authorized
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
import {
  addAuthorizedMachine,
  formatSpacesPubKey,
  getAuthorizedMachine,
  isAuthorized,
} from "./authorization.js";
import { deriveIdentityId } from "../lib/tmux-lite/crypto/identity.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
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
  getMachine,
  setMachineConnection,
  registerInvite,
  getInvite,
  isInviteValid,
  useInvite,
  authorizeClient,
  revokeClientAuthorization,
  getAllMachinesWithAuthStatus,
  getRegistryStats,
  getEffectiveAccessList,
  addGlobalAccess,
  removeGlobalAccess,
  broadcastAccessUpdate,
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
  type RegisterInviteMessage,
  type AuthorizeClientMessage,
  type RevokeClientMessage,
  type ListMachinesMessage,
  type ConnectWithInviteMessage,
  type ConnectToMachineMessage,
  type AddGlobalAccessMessage,
  type RemoveGlobalAccessMessage,
  type AccessListMessage,
} from "./protocol";

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

type SignedClientMessageType = "list_machines" | "connect_with_invite" | "connect_to_machine";
const SIGNED_CLIENT_MESSAGE_TYPES = new Set<SignedClientMessageType>([
  "list_machines",
  "connect_with_invite",
  "connect_to_machine",
]);

const UNLOCK_KDF_INFO = new TextEncoder().encode("gitspace-unlock-v1");
const UNLOCK_KDF_KEY_LENGTH = 32;

function deriveUnlockKey(sharedSecret: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, salt, UNLOCK_KDF_INFO, UNLOCK_KDF_KEY_LENGTH);
}

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

  const relayEphemeralPrivateKey = randomBytes(32);
  const relayEphemeralPublicKey = x25519.getPublicKey(relayEphemeralPrivateKey);
  const sharedSecret = x25519SharedSecret(relayEphemeralPrivateKey, machineEphemeralPublicKey);
  const salt = randomBytes(32);
  const key = deriveUnlockKey(sharedSecret, salt);

  const sealed = seal(Buffer.from(payload, "utf-8"), key);
  return {
    ciphertext: sealed.toString("base64"),
    relayEphemeralKey: Buffer.from(relayEphemeralPublicKey).toString("base64"),
    salt: Buffer.from(salt).toString("base64"),
  };
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

interface RelayServerState {
  clientConnections: Map<string, ServerWebSocket<WebSocketData>>;
  machineClients: Map<string, Set<string>>;
  pendingChallenges: Map<string, { nonce: Uint8Array; timestamp: number }>;
  preAuthorizedMachines: Set<string>;
  signRelayMessage: <T extends object>(msg: T) => T;
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

  const state: RelayServerState = {
    clientConnections,
    machineClients,
    pendingChallenges,
    preAuthorizedMachines,
    signRelayMessage,
  };

  const server = Bun.serve<WebSocketData>({
    port,
    hostname: bind,

    async fetch(req, server) {
      const url = new URL(req.url);

      // Check Host header if hostname is specified
      if (hostname) {
        const hostHeader = req.headers.get("host");
        const host = hostHeader?.split(":")[0]; // Remove port
        console.log(`[relay] Request: ${url.pathname} Host: ${hostHeader} -> ${host} (expected: ${hostname})`);
        if (host !== hostname) {
          console.log(`[relay] Rejecting request - hostname mismatch`);
          return new Response("Not found", { status: 404 });
        }
      }

      // Health check
      if (url.pathname === "/health") {
        const stats = getRegistryStats();
        const clientCount = clientConnections.size;
        return Response.json({
          status: "ok",
          ...stats,
          connectedClients: clientCount,
        });
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
        if (!parsed && rejectUnsignedClientMessage(ws, rawMsg)) {
          return;
        }

        // Route data and handshake messages between client and machine
        // All other message types are protocol messages handled by the relay
        if (parsed && parsed.type !== "data" && parsed.type !== "handshake") {
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
          // Mark machine as offline
          setMachineConnection(machineId, null);

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

      // Check if machine is authorized to connect to this relay
      // Sources of authorization:
      // 1) pre-authorized (ephemeral local relay startup)
      // 2) on-disk authorized machine list
      // 3) valid one-time register permit (cloud unlock flow)
      const isPreAuthorized = state.preAuthorizedMachines.has(regMsg.signingKey);
      let isAuthorizedMachine = isPreAuthorized || isAuthorized(regMsg.signingKey);
      let bootstrapWorkspaceId: string | undefined;
      const cloudWorkspaceForKey = getCloudWorkspaceByMachinePublicKey(regMsg.signingKey);

      // Owner-gated wake flow for cloud workspaces:
      // if this machine key is tied to a cloud workspace in bootstrapping state,
      // require a fresh one-time register permit minted by unlock_request.
      const requiresRegisterPermit = cloudWorkspaceForKey?.status === 'bootstrapping';

      if (requiresRegisterPermit) {
        if (!regMsg.registerPermit) {
          ws.send(serializeMessage(createErrorMessage(
            "UNAUTHORIZED",
            "Register permit required while cloud workspace is bootstrapping"
          )));
          ws.close();
          return;
        }

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

          if (!isAuthorizedMachine) {
            const machinePub = formatSpacesPubKey(regMsg.signingKey, regMsg.keyExchangeKey);
            const authorized = addAuthorizedMachine(machinePub, `cloud:${consumedPermit.workspaceId}`);
            if (!authorized) {
              ws.send(serializeMessage(createErrorMessage("ERROR", "Failed to authorize machine from register permit")));
              ws.close();
              return;
            }
          }

          markCloudBootstrapReady(consumedPermit.workspaceId);
          bootstrapWorkspaceId = consumedPermit.workspaceId;
          isAuthorizedMachine = true;
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

      if (!isAuthorizedMachine) {
        console.warn(`[relay] Machine not authorized: ${regMsg.machineId} (signingKey not in authorized list)`);
        ws.send(serializeMessage(createErrorMessage("UNAUTHORIZED", "Machine not authorized for this relay")));
        ws.close();
        return;
      }

      // Get authorized machine info for account tracking
      const authorizedMachine = getAuthorizedMachine(regMsg.signingKey);
      const accountId = authorizedMachine?.fingerprint || regMsg.machineId;

      // Register the machine (with ownership verification for re-registration)
      const result = registerMachine(
        regMsg.machineId,
        accountId,
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

      // Update ws data
      ws.data.machineId = regMsg.machineId;
      ws.data.accountId = accountId;

      console.log(
        `[relay] Machine ${regMsg.machineId} registered (authorized: ${authorizedMachine?.label || authorizedMachine?.fingerprint || "unknown"}${bootstrapWorkspaceId ? `, bootstrapWorkspace=${bootstrapWorkspaceId}` : ""})`
      );

      ws.send(serializeMessage({
        type: "registered",
        machineId: regMsg.machineId,
      }));

      // Send global access list to newly registered machine (signed)
      const accessEntries = getEffectiveAccessList(accountId, regMsg.machineId);
      if (accessEntries.length > 0) {
        const accessListMsg: AccessListMessage = {
          type: "access_list",
          entries: accessEntries.map(e => ({
            clientIdentityId: e.clientIdentityId,
            signingKey: e.signingKey,
            keyExchangeKey: e.keyExchangeKey,
            label: e.label,
            accessType: e.accessType,
            sessionId: e.sessionId,
            grantedAt: e.grantedAt,
          })),
          protocolVersion: PROTOCOL_VERSION,
        };
        // Sign the access_list message
        const signedMsg = state.signRelayMessage(accessListMsg);
        ws.send(serializeMessage(signedMsg));
        console.log(`[relay] Sent ${accessEntries.length} access entries to machine ${regMsg.machineId} (signed)`);
      }
      break;
    }

    // Legacy challenge_response - kept for backwards compatibility
    case "challenge_response": {
      // In new flow, challenge response is part of register_machine message
      // This is kept for backwards compatibility with older clients
      ws.send(serializeMessage(createErrorMessage("DEPRECATED", "Use register_machine with challengeResponse field")));
      return;
    }

    case "register_invite": {
      if (role !== "machine") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only machines can register invites")));
        return;
      }

      const invMsg = msg as RegisterInviteMessage;

      // Verify machine is registered and owned by this connection
      const machine = getMachine(invMsg.machineId);
      if (!machine || machine.accountId !== ws.data.accountId) {
        ws.send(serializeMessage(createErrorMessage("NOT_FOUND", "Machine not registered or unauthorized")));
        return;
      }

      // Register the invite
      registerInvite(
        invMsg.inviteId,
        invMsg.machineId,
        invMsg.expiresAt,
        invMsg.maxUses
      );

      console.log(`[relay] Invite ${invMsg.inviteId} registered for machine ${invMsg.machineId}`);

      ws.send(serializeMessage({
        type: "registered",
        machineId: invMsg.machineId,
      }));
      break;
    }

    case "authorize_client": {
      if (role !== "machine") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only machines can authorize clients")));
        return;
      }

      const authMsg = msg as AuthorizeClientMessage;

      // Verify machine is registered and owned by this connection
      const machine = getMachine(authMsg.machineId);
      if (!machine || machine.accountId !== ws.data.accountId) {
        ws.send(serializeMessage(createErrorMessage("NOT_FOUND", "Machine not registered or unauthorized")));
        return;
      }

      // Authorize the client
      authorizeClient(
        authMsg.machineId,
        authMsg.clientIdentityId,
        authMsg.signingKey,
        authMsg.keyExchangeKey,
        authMsg.accessType,
        authMsg.sessionId
      );

      console.log(`[relay] Client ${authMsg.clientIdentityId} authorized for machine ${authMsg.machineId}`);

      ws.send(serializeMessage({
        type: "client_authorized",
        clientIdentityId: authMsg.clientIdentityId,
      }));
      break;
    }

    case "revoke_client": {
      if (role !== "machine") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only machines can revoke clients")));
        return;
      }

      const revokeMsg = msg as RevokeClientMessage;

      // Verify machine is registered and owned by this connection
      const machine = getMachine(revokeMsg.machineId);
      if (!machine || machine.accountId !== ws.data.accountId) {
        ws.send(serializeMessage(createErrorMessage("NOT_FOUND", "Machine not registered or unauthorized")));
        return;
      }

      // Revoke client authorization
      revokeClientAuthorization(revokeMsg.machineId, revokeMsg.clientIdentityId);

      console.log(`[relay] Client ${revokeMsg.clientIdentityId} revoked from machine ${revokeMsg.machineId}`);

      ws.send(serializeMessage({
        type: "client_revoked",
        clientIdentityId: revokeMsg.clientIdentityId,
      }));
      break;
    }

    case "add_global_access": {
      if (role !== "machine") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only machines can add global access")));
        return;
      }

      if (!ws.data.accountId) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Authentication required")));
        return;
      }

      const addMsg = msg as AddGlobalAccessMessage;

      // Add to global access list
      const entry = addGlobalAccess(ws.data.accountId, {
        clientIdentityId: addMsg.clientIdentityId,
        signingKey: addMsg.signingKey,
        keyExchangeKey: addMsg.keyExchangeKey,
        label: addMsg.label,
        accessType: addMsg.accessType,
        sessionId: addMsg.sessionId,
        machineIds: addMsg.machineIds,
      });

      console.log(`[relay] Global access added: ${addMsg.clientIdentityId} by ${ws.data.accountId}`);

      // Broadcast to all machines owned by this account (signed)
          broadcastAccessUpdate(ws.data.accountId, [entry], [], state.signRelayMessage);

      // Also authorize for per-machine tracking
      const machineId = ws.data.machineId;
      if (machineId) {
        authorizeClient(
          machineId,
          addMsg.clientIdentityId,
          addMsg.signingKey,
          addMsg.keyExchangeKey,
          addMsg.accessType,
          addMsg.sessionId
        );
      }

      ws.send(serializeMessage({
        type: "client_authorized",
        clientIdentityId: addMsg.clientIdentityId,
      }));
      break;
    }

    case "remove_global_access": {
      if (role !== "machine") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only machines can remove global access")));
        return;
      }

      if (!ws.data.accountId) {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Authentication required")));
        return;
      }

      const removeMsg = msg as RemoveGlobalAccessMessage;

      // Remove from global access list
      const removed = removeGlobalAccess(ws.data.accountId, removeMsg.clientIdentityId);

      if (removed) {
        console.log(`[relay] Global access removed: ${removeMsg.clientIdentityId} by ${ws.data.accountId}`);

        // Broadcast to all machines owned by this account (signed)
        broadcastAccessUpdate(ws.data.accountId, [], [removeMsg.clientIdentityId], state.signRelayMessage);
      }

      ws.send(serializeMessage({
        type: "client_revoked",
        clientIdentityId: removeMsg.clientIdentityId,
      }));
      break;
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

      // Get only AUTHORIZED machines for this client
      // Client must be in the machine's access list to see it
      const allMachines = getAllMachinesWithAuthStatus(verified.clientIdentityId);
      const authorizedMachines = allMachines.filter(m => m.isAuthorized);

      ws.send(serializeMessage({
        type: "machine_list",
        machines: authorizedMachines.map(({ machineId, machine, isAuthorized, accessType, sessionId }) => ({
          machineId,
          label: machine.label,
          online: machine.ws !== null,
          isAuthorized,
          accessType,
          sessionId,
          lastConnectedAt: machine.lastConnectedAt,
        })),
      }));
      break;
    }

    case "connect_with_invite": {
      if (role !== "client") {
        ws.send(serializeMessage(createErrorMessage("FORBIDDEN", "Only clients can connect with invites")));
        return;
      }

      const inviteMsg = msg as ConnectWithInviteMessage;
      const verified = verifyClientIdentity(inviteMsg);
      if (!verified) {
        ws.send(serializeMessage(createErrorMessage("INVALID_SIGNATURE", "Client message signature invalid")));
        return;
      }

      if (ws.data.clientIdentityId && ws.data.clientIdentityId !== verified.clientIdentityId) {
        ws.send(serializeMessage(createErrorMessage("IDENTITY_MISMATCH", "Client identity does not match connection")));
        return;
      }

      // Look up invite
      const invite = getInvite(inviteMsg.inviteId);
      if (!invite) {
        ws.send(serializeMessage(createErrorMessage("NOT_FOUND", "Invite not found")));
        return;
      }

      if (!isInviteValid(inviteMsg.inviteId)) {
        ws.send(serializeMessage(createErrorMessage("INVALID", "Invite expired or exhausted")));
        return;
      }

      // Check machine is online
      const machine = getMachine(invite.machineId);
      if (!machine || !machine.ws) {
        ws.send(serializeMessage(createErrorMessage("OFFLINE", "Machine is offline")));
        return;
      }

      // Use the invite (decrements use count)
      useInvite(inviteMsg.inviteId);

      // Set up client connection tracking
      setupClientConnection(state, invite.machineId, connectionId, ws, verified.clientIdentityId);

      // Notify machine of new client
      machine.ws.send(serializeMessage({
        type: "client_connected",
        connectionId,
        clientIdentityId: verified.clientIdentityId,
        viaInvite: inviteMsg.inviteId,
      }));

      // Send connection established to client
      ws.send(serializeMessage({
        type: "connection_established",
        machineId: invite.machineId,
        connectionId,
      }));

      console.log(`[relay] Client ${verified.clientIdentityId} connected to ${invite.machineId} via invite`);
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

      // NOTE: We don't check isClientAuthorized here anymore.
      // Authorization happens via X3DH handshake - the machine will
      // verify the client's identity and reject if not on ACL.

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
