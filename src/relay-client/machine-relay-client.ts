import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { signMessage } from '../relay/signing.js';
import { PROTOCOL_VERSION, RELAY_MAX_WS_PAYLOAD } from '../relay/protocol.js';
import { chunkFrame, FrameChunkReassembler, FRAME_CHUNK_SIZE } from '../lib/tmux-lite/crypto/frame-chunk.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { ServeEventHandler } from '../serve/types.js';

export type RelayTrustResult =
  | { trusted: true }
  | { trusted: false; reason: string };

export interface PublicIdentity {
  id: string;
  signingPublicKey: string;
  keyExchangePublicKey: string;
  label?: string;
}

export interface MachineSessionBridge {
  handleConnect(connectionId: string): void;
  setSendCallback(connectionId: string, callback: (data: Buffer) => void): void;
  getSession(connectionId: string): unknown;
  handleDisconnect(connectionId: string, reason: string): void;
  handleMessage(connectionId: string, data: Uint8Array): Promise<Uint8Array | null>;
}

export interface UnlockGrantResponse {
  ciphertext: string;
  relayEphemeralKey: string;
  salt: string;
  registerPermit: string;
}

export async function requestUnlockGrantViaRelay(options: {
  relayUrl: string;
  relayPubkey?: string;
  workspaceId: string;
  unlockToken: string;
  ephemeralKey: string;
  verifyRelayTrust: (
    relayUrl: string,
    relayPublicKey: string,
    relayFingerprint: string,
    relayLabel: string | undefined,
    explicitPubkey?: string,
  ) => Promise<RelayTrustResult>;
}): Promise<UnlockGrantResponse> {
  const url = new URL(options.relayUrl);
  url.searchParams.set('role', 'machine');
  url.searchParams.set('m', `unlock-${Date.now().toString(36)}`);

  const configuredTimeoutMs = Number.parseInt(process.env.GSSH_UNLOCK_REQUEST_TIMEOUT_MS ?? '30000', 10);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : 30000;

  return await new Promise<UnlockGrantResponse>((resolve, reject) => {
    let completed = false;
    // NOTE (verified empirically, Bun 1.3): the `ws` package's `maxPayload`
    // option is a NO-OP under Bun — the client accepts frames of ANY size
    // regardless of this value (it fails lenient, not strict). The ONLY frame
    // size enforcer in the whole path is the relay's Bun.serve maxPayloadLength
    // (RELAY_MAX_WS_PAYLOAD = 64MB), which 1006s ("Received too big message") on
    // receive over the cap. This option is kept for correctness under Node/`ws`
    // but is NOT what prevents the 1006 — the durable fix is ticket #42.3
    // chunking (frame-chunk.ts), which keeps every frame far below the cap.
    const ws = new WebSocket(url.toString(), { maxPayload: RELAY_MAX_WS_PAYLOAD });
    const timeoutId = setTimeout(() => {
      fail('Timed out waiting for relay unlock grant');
    }, timeoutMs);

    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutId);
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(message));
    };

    ws.onerror = () => {
      fail('Failed to connect to relay for unlock request');
    };

    ws.onclose = () => {
      if (!completed) {
        fail('Relay closed unlock connection before unlock grant was received');
      }
    };

    ws.onmessage = async (event) => {
      let msg: Record<string, unknown>;
      try {
        const raw = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        fail('Invalid unlock response from relay');
        return;
      }

      if (msg.type === 'relay_identity') {
        const trust = await options.verifyRelayTrust(
          options.relayUrl,
          String(msg.publicKey ?? ''),
          String(msg.fingerprint ?? ''),
          typeof msg.label === 'string' ? msg.label : undefined,
          options.relayPubkey,
        );

        if (!trust.trusted) {
          fail(trust.reason);
          return;
        }

        ws.send(JSON.stringify({
          type: 'unlock_request',
          workspaceId: options.workspaceId,
          unlockToken: options.unlockToken,
          ephemeralKey: options.ephemeralKey,
        }));
        return;
      }

      if (msg.type === 'unlock_grant') {
        const ciphertext = typeof msg.ciphertext === 'string' ? msg.ciphertext : '';
        const relayEphemeralKey = typeof msg.relayEphemeralKey === 'string' ? msg.relayEphemeralKey : '';
        const salt = typeof msg.salt === 'string' ? msg.salt : '';
        const registerPermit = typeof msg.registerPermit === 'string' ? msg.registerPermit : '';
        if (!ciphertext || !relayEphemeralKey || !salt || !registerPermit) {
          fail('Unlock grant did not include identity material');
          return;
        }

        if (completed) return;
        completed = true;
        clearTimeout(timeoutId);
        ws.close();
        resolve({
          ciphertext,
          relayEphemeralKey,
          salt,
          registerPermit,
        });
        return;
      }

      if (msg.type === 'error') {
        const code = typeof msg.code === 'string' ? msg.code : 'ERROR';
        const message = typeof msg.message === 'string' ? msg.message : 'Unlock request failed';
        fail(`[${code}] ${message}`);
      }
    };
  });
}

function signChallengeAndCreateRegistration(
  challenge: string,
  signingPrivateKey: Uint8Array,
  machineId: string,
  publicIdentity: PublicIdentity,
  bootstrapToken?: string,
  registerPermit?: string,
  enrollmentToken?: string,
  deviceCertificate?: string,
): { challengeResponse: string; message: object } | null {
  try {
    const nonceBytes = new Uint8Array(Buffer.from(challenge, 'base64'));
    const signature = ed25519.sign(nonceBytes, signingPrivateKey);
    const challengeResponse = Buffer.from(signature).toString('base64');

    return {
      challengeResponse,
      message: {
        type: 'register_machine',
        machineId,
        signingKey: publicIdentity.signingPublicKey,
        keyExchangeKey: publicIdentity.keyExchangePublicKey,
        label: publicIdentity.label,
        protocolVersion: PROTOCOL_VERSION,
        challengeResponse,
        bootstrapToken,
        registerPermit,
        enrollmentToken,
        deviceCertificate,
      },
    };
  } catch (err) {
    logger.error(`Failed to sign challenge: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Ticket #42.3 (the durable fix): split an oversize encrypted `data` frame into
// ordered chunks so no single WS frame is pathologically large. A single legit
// payload — e.g. a full machine_snapshot, which grows with workspace/agent count
// (a 6.68MB frame was seen in the field, and 1006'd the whole session with
// "Received too big message") — must never ride as one frame. Each chunk stays
// UNDER 1MB on the wire (FRAME_CHUNK_SIZE=512KB raw ⇒ ~683KB base64), matching
// the 1MB frame limit the whole system is designed around (tmux-lite
// MAX_FRAME_SIZE, PTY_CHUNK_SIZE, share-read) so oversize frames are safe on
// EVERY transport path, not just the local relay's 64MB backstop. Chunking wraps
// the already-encrypted ciphertext bytes, so E2E is intact and the relay keeps
// routing opaque payloads it cannot inspect. Small frames are returned unwrapped
// (backward compatible). Reassembly happens on the receiver before decryption.
function createDataMessages(connectionId: string, data: Uint8Array | Buffer): string[] {
  const frameBytes = data instanceof Uint8Array ? data : Buffer.from(data);
  const chunks = chunkFrame(frameBytes, FRAME_CHUNK_SIZE);
  if (chunks.length > 1) {
    logger.dim(
      `[serve] chunked oversize data frame: conn=${connectionId} ` +
      `raw=${(frameBytes.length / (1024 * 1024)).toFixed(2)}MB into ${chunks.length} chunks`,
    );
  }
  return chunks.map((chunk) =>
    JSON.stringify({
      type: 'data',
      connectionId,
      data: Buffer.from(chunk).toString('base64'),
    }),
  );
}

function createSendCallback(
  ws: WebSocket,
  connectionId: string
): (data: Buffer) => void {
  return (sendData) => {
    for (const message of createDataMessages(connectionId, sendData)) {
      ws.send(message);
    }
  };
}

export async function connectMachineRelay(
  relayUrl: string,
  machineId: string,
  publicIdentity: PublicIdentity,
  sessionManager: MachineSessionBridge,
  eventHandler: ServeEventHandler,
  verifyRelayTrust: (
    relayUrl: string,
    relayPublicKey: string,
    relayFingerprint: string,
    relayLabel: string | undefined,
    explicitPubkey?: string,
  ) => Promise<RelayTrustResult>,
  signingPrivateKey?: Uint8Array,
  relayPubkey?: string,
  bootstrapToken?: string,
  registerPermit?: string,
  enrollmentToken?: string,
  deviceCertificate?: string,
  /** Daemon-unification P1: receive a stop handle so an in-process host can
   *  deactivate (close the socket, stop pings, suppress reconnection). */
  lifecycle?: { onStop: (stop: () => void) => void },
): Promise<void> {
  const url = new URL(relayUrl);
  url.searchParams.set('role', 'machine');

  return new Promise((resolve, reject) => {
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const baseReconnectDelay = 1000;
    const maxReconnectDelay = 30000;
    const pingIntervalMs = 15_000;
    // No pong within this window ⇒ half-open socket: terminate so the normal
    // onclose → reconnect path runs (a dead TCP connection can otherwise sit
    // silently for many minutes while clients see the machine as online).
    const pongLivenessTimeoutMs = 45_000;
    let lastPongAtMs = 0;
    let resolved = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let currentWs: WebSocket | null = null;
    // Ticket #42.3: reassemble chunked client→machine data frames (keyed by
    // connectionId) before handing bytes to the session decrypt path.
    const dataReassemblers = new Map<string, FrameChunkReassembler>();
    lifecycle?.onStop(() => {
      stopped = true;
      stopPing();
      try { currentWs?.close(); } catch { /* already closed */ }
    });

    const signingPublicKey = signingPrivateKey
      ? new Uint8Array(Buffer.from(publicIdentity.signingPublicKey, 'base64'))
      : null;

    const signAndSend = (ws: WebSocket, msg: object) => {
      if (signingPrivateKey && signingPublicKey) {
        const signed = signMessage(msg, signingPrivateKey, signingPublicKey);
        ws.send(JSON.stringify(signed));
      } else {
        ws.send(JSON.stringify(msg));
      }
    };

    const stopPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const startPing = (ws: WebSocket) => {
      stopPing();
      lastPongAtMs = Date.now();
      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const sincePongMs = Date.now() - lastPongAtMs;
        if (sincePongMs > pongLivenessTimeoutMs) {
          console.log(`[serve] Relay liveness lost: no pong for ${Math.round(sincePongMs / 1000)}s, terminating connection`);
          stopPing();
          try {
            ws.terminate();
          } catch {
            try { ws.close(); } catch { /* already closed */ }
          }
          return;
        }
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }, pingIntervalMs);
    };

    const connect = () => {
      if (stopped) return;
      console.log(`[serve] Connecting to relay: ${url.toString()}`);
      // See note in requestUnlockGrantViaRelay: `ws` `maxPayload` is a no-op
      // under Bun (client accepts any size). The binding cap is the relay's
      // Bun.serve; ticket #42.3 chunking keeps frames well below it.
      const ws = new WebSocket(url.toString(), { maxPayload: RELAY_MAX_WS_PAYLOAD });
      currentWs = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log('[serve] WebSocket connected, waiting for relay identity...');
      };

      ws.onclose = (event) => {
        stopPing();
        console.log(`[serve] WebSocket closed: code=${event.code} reason=${event.reason || 'none'}`);
        eventHandler({
          type: 'relay_disconnected',
          code: event.code,
          reason: event.reason || 'Connection closed',
        });

        if (stopped) return;
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts += 1;
          const delay = Math.min(
            baseReconnectDelay * Math.pow(2, reconnectAttempts - 1) + Math.random() * 1000,
            maxReconnectDelay
          );
          eventHandler({ type: 'relay_reconnecting', attempt: reconnectAttempts });
          setTimeout(connect, delay);
        } else if (!resolved) {
          reject(new Error(`WebSocket reconnect failed after ${maxReconnectAttempts} attempts`));
        }
      };

      ws.onerror = (err) => {
        console.log('[serve] WebSocket error:', err);
        if (!resolved && reconnectAttempts === 0) {
          reject(new Error('WebSocket connection failed'));
        }
      };

      ws.onmessage = async (event) => {
        try {
          const data = event.data;
          let msg: any;

          if (typeof data === 'string') {
            msg = JSON.parse(data);
          } else {
            const str = new TextDecoder().decode(data as ArrayBuffer);
            try {
              msg = JSON.parse(str);
            } catch {
              logger.warning('Received binary data without JSON envelope');
              return;
            }
          }

          switch (msg.type) {
            case 'relay_identity': {
              const { publicKey: relayPublicKey, fingerprint: relayFingerprint, label: relayLabel, challenge } = msg;

              console.log(`[serve] Received relay identity: ${relayFingerprint}${relayLabel ? ` (${relayLabel})` : ''}`);

              const trustResult = await verifyRelayTrust(
                relayUrl,
                relayPublicKey,
                relayFingerprint,
                relayLabel,
                relayPubkey
              );

              if (!trustResult.trusted) {
                ws.close(1008, trustResult.reason);
                if (!resolved) {
                  reject(new Error(trustResult.reason));
                }
                return;
              }

              if (!signingPrivateKey) {
                logger.error('No signing key available for challenge-response');
                ws.close(1008, 'No signing key');
                return;
              }

              const registration = signChallengeAndCreateRegistration(
                challenge,
                signingPrivateKey,
                machineId,
                publicIdentity,
                bootstrapToken,
                registerPermit,
                enrollmentToken,
                deviceCertificate,
              );

              if (!registration) {
                ws.close(1008, 'Challenge signing failed');
                return;
              }

              signAndSend(ws, registration.message);
              console.log('[serve] Sent register_machine with challenge response');
              break;
            }

            case 'registered':
              reconnectAttempts = 0;
              startPing(ws);
              eventHandler({ type: 'relay_connected' });

              if (!resolved) {
                resolved = true;
                resolve();
              }
              break;

            case 'client_connected':
              sessionManager.handleConnect(msg.connectionId);
              sessionManager.setSendCallback(msg.connectionId, createSendCallback(ws, msg.connectionId));
              break;

            case 'client_disconnected':
              dataReassemblers.delete(msg.connectionId);
              sessionManager.handleDisconnect(msg.connectionId, msg.reason || 'Client disconnected');
              break;

            case 'data':
              if (msg.data && msg.connectionId) {
                const wireBytes = Buffer.from(msg.data, 'base64');

                // Ticket #42.3: reassemble chunked frames before decrypt. Small
                // (unchunked) frames pass straight through as a single chunk.
                let reassembler = dataReassemblers.get(msg.connectionId);
                if (!reassembler) {
                  reassembler = new FrameChunkReassembler();
                  dataReassemblers.set(msg.connectionId, reassembler);
                }
                const assembled = reassembler.receive(wireBytes);
                if (assembled.kind === 'partial') {
                  break;
                }
                if (assembled.kind === 'error') {
                  logger.warning(`[serve] dropping malformed data chunk (conn=${msg.connectionId}): ${assembled.message}`);
                  break;
                }
                const messageData = assembled.frame;

                if (!sessionManager.getSession(msg.connectionId)) {
                  sessionManager.setSendCallback(msg.connectionId, createSendCallback(ws, msg.connectionId));
                }

                const response = await sessionManager.handleMessage(
                  msg.connectionId,
                  messageData
                );

                if (response) {
                  for (const message of createDataMessages(msg.connectionId, response)) {
                    ws.send(message);
                  }
                }
              }
              break;

            case 'error':
              logger.error(`Relay error: ${msg.message} (${msg.code})`);
              if (!resolved) {
                reject(new Error(msg.message));
              }
              break;

            case 'share_read': {
              // Public share link fetch (docs/ARTIFACT-PROTOCOL.md Q3): verify
              // with OUR key, enforce the ledger, stream resolved bytes back
              // in ≤700KB frames (relay protocol caps messages at 1MB).
              const requestId = String((msg as { requestId?: unknown }).requestId ?? '');
              const token = String((msg as { token?: unknown }).token ?? '');
              const subPathRaw = (msg as { subPath?: unknown }).subPath;
              const subPath = typeof subPathRaw === 'string' ? subPathRaw : undefined;
              void (async () => {
                try {
                  const { consumeShareRead } = await import('../lib/tmux-lite/artifact-share.js');
                  const result = await consumeShareRead(token, subPath);
                  const CHUNK = 512 * 1024;
                  let seq = 0;
                  for (let off = 0; off < result.bytes.length || seq === 0; off += CHUNK) {
                    const slice = result.bytes.subarray(off, Math.min(off + CHUNK, result.bytes.length));
                    const done = off + CHUNK >= result.bytes.length;
                    signAndSend(ws, {
                      type: 'share_read_chunk',
                      requestId,
                      seq,
                      dataBase64: slice.length > 0 ? Buffer.from(slice).toString('base64') : undefined,
                      ...(seq === 0 ? {
                        contentType: result.contentType,
                        disposition: result.disposition,
                        fileName: result.fileName,
                        relPath: result.relPath,
                        ...(result.pinnedCommit ? { pinnedCommit: result.pinnedCommit } : {}),
                        expiresAt: result.expiresAt,
                      } : {}),
                      ...(done ? { done: true } : {}),
                    });
                    seq += 1;
                    if (done) break;
                  }
                } catch (error) {
                  signAndSend(ws, {
                    type: 'share_read_chunk',
                    requestId,
                    seq: 0,
                    error: error instanceof Error ? error.message.slice(0, 200) : 'share read failed',
                    done: true,
                  });
                }
              })();
              break;
            }

            case 'pong':
              lastPongAtMs = Date.now();
              break;

            default:
              logger.dim(`Unknown message type: ${msg.type}`);
          }
        } catch (error) {
          logger.error(`Message handling error: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    };

    connect();
  });
}
