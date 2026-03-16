import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { signMessage } from '../relay/signing.js';
import { PROTOCOL_VERSION } from '../relay/protocol.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { ServeEventHandler } from '../serve/types.js';
import { SpacesError } from '../types/errors.js';

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
    const ws = new WebSocket(url.toString());
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

function createDataMessage(connectionId: string, data: Uint8Array | Buffer): string {
  return JSON.stringify({
    type: 'data',
    connectionId,
    data: Buffer.from(data).toString('base64'),
  });
}

function createSendCallback(
  ws: WebSocket,
  connectionId: string
): (data: Buffer) => void {
  return (sendData) => {
    ws.send(createDataMessage(connectionId, sendData));
  };
}

// ============================================================================
// Heartbeat constants
// ============================================================================

/**
 * Interval (ms) at which the machine sends application-level ping messages to
 * the relay.  Three missed responses within HEARTBEAT_STALE_MS trigger a
 * proactive reconnect.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long (ms) without a pong response before we consider the connection dead
 * and forcibly close the WebSocket so the reconnect loop can re-establish.
 * 3 × HEARTBEAT_INTERVAL_MS = 90 s.
 */
const HEARTBEAT_STALE_MS = 90_000;

/**
 * Backoff cap (ms) used after the initial connection has been established.
 * We cap at 5 minutes so a long relay outage is handled gracefully without
 * hammering the relay every 30 s forever.
 */
const MAX_RECONNECT_DELAY_AFTER_CONNECT_MS = 300_000; // 5 minutes

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
): Promise<void> {
  const url = new URL(relayUrl);
  url.searchParams.set('role', 'machine');

  return new Promise((resolve, reject) => {
    // -----------------------------------------------------------------------
    // Reconnect state
    // -----------------------------------------------------------------------

    /**
     * Number of consecutive failed connection attempts since the last
     * successful registration.  Reset to 0 on each successful registration.
     */
    let reconnectAttempts = 0;

    /**
     * Base delay used for the *first* reconnect after an initial connection
     * is established.  After every failed attempt the delay is doubled up to
     * MAX_RECONNECT_DELAY_AFTER_CONNECT_MS.  Before the initial connection we
     * use the shorter 30 s cap so startup failures surface quickly.
     */
    const baseReconnectDelay = 1_000;

    /**
     * Cap used before the very first successful registration (quick failures
     * are visible faster).
     */
    const maxReconnectDelayBeforeConnect = 30_000;

    /**
     * Whether the outer promise has already been resolved (i.e. the first
     * successful registration has happened).  After this point we never
     * reject – we simply keep retrying indefinitely.
     */
    let resolved = false;

    // -----------------------------------------------------------------------
    // Signing helpers
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Heartbeat management
    // -----------------------------------------------------------------------

    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let markHeartbeatAcked: (() => void) | null = null;

    /** Start the application-level heartbeat after successful registration. */
    const startHeartbeat = (ws: WebSocket) => {
      stopHeartbeat();

      // Record first heartbeat baseline so the stale timer has a reference.
      let lastPongAt = Date.now();

      heartbeatInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          stopHeartbeat();
          return;
        }

        // Send the ping first so the stale check on the *next* tick accounts
        // for the full HEARTBEAT_STALE_MS window rather than adding an extra
        // HEARTBEAT_INTERVAL_MS of latency to detection.
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));

        // Check if the connection has gone silent (no heartbeat ack in HEARTBEAT_STALE_MS).
        if (Date.now() - lastPongAt >= HEARTBEAT_STALE_MS) {
          logger.log(`[serve] Heartbeat stale – no heartbeat ack received within ${HEARTBEAT_STALE_MS}ms. Forcing reconnect.`);
          stopHeartbeat();
          ws.close(4001, 'Heartbeat timeout');
        }
      }, HEARTBEAT_INTERVAL_MS);

      markHeartbeatAcked = () => {
        lastPongAt = Date.now();
      };
    };

    const stopHeartbeat = () => {
      if (heartbeatInterval !== null) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      markHeartbeatAcked = null;
    };

    // -----------------------------------------------------------------------
    // Connection factory
    // -----------------------------------------------------------------------

    const connect = () => {
      console.log(`[serve] Connecting to relay: ${url.toString()}`);
      const ws = new WebSocket(url.toString());
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log('[serve] WebSocket connected, waiting for relay identity...');
        // Do NOT reset reconnectAttempts here. Resetting on open would mask
        // repeated registration failures (the relay keeps accepting the TCP
        // connection but rejecting the register_machine) and would prevent
        // the backoff from growing. The counter is reset only on a successful
        // `registered` response so every failure between open and registered
        // is correctly counted towards the backoff.
      };

      ws.onclose = (event) => {
        stopHeartbeat();

        console.log(`[serve] WebSocket closed: code=${event.code} reason=${event.reason || 'none'}`);
        eventHandler({
          type: 'relay_disconnected',
          code: event.code,
          reason: event.reason || 'Connection closed',
        });

        // Before the first successful connection: behave like before but with
        // a shorter cap so startup failures surface quickly.
        if (!resolved) {
          if (reconnectAttempts < 10) {
            reconnectAttempts++;
            const delay = Math.min(
              baseReconnectDelay * Math.pow(2, reconnectAttempts - 1) + Math.random() * 1_000,
              maxReconnectDelayBeforeConnect,
            );
            eventHandler({ type: 'relay_reconnecting', attempt: reconnectAttempts, nextRetryMs: delay });
            setTimeout(connect, delay);
          } else {
            // Exhausted fast-start attempts – give up and let serve.ts surface
            // the startup failure to the user.
            reject(new SpacesError(
              `Failed to connect to relay after ${reconnectAttempts} attempts`,
              'SYSTEM_ERROR',
              1,
            ));
          }
          return;
        }

        // After the first successful registration: retry forever with an
        // increasing backoff capped at MAX_RECONNECT_DELAY_AFTER_CONNECT_MS.
        reconnectAttempts++;
        const delay = Math.min(
          baseReconnectDelay * Math.pow(2, Math.min(reconnectAttempts - 1, 18)) + Math.random() * 2_000,
          MAX_RECONNECT_DELAY_AFTER_CONNECT_MS,
        );
        const delaySeconds = Math.round(delay / 1_000);
        console.log(`[serve] Relay disconnected. Reconnecting in ${delaySeconds}s (attempt ${reconnectAttempts})...`);
        eventHandler({ type: 'relay_reconnecting', attempt: reconnectAttempts, nextRetryMs: delay });
        setTimeout(connect, delay);
      };

      ws.onerror = (err) => {
        console.log('[serve] WebSocket error:', err);
        // Only reject the outer promise on the very first connection attempt
        // before any reconnect attempts have started.
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

          // Handle pong responses from relay heartbeat.
          if (msg.type === 'pong') {
            markHeartbeatAcked?.();
            return;
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

            case 'registered': {
              // Successful registration – start heartbeat and resolve the
              // outer promise (only once, on first connection).
              startHeartbeat(ws);

              // Reset the backoff counter so the next disconnect starts fresh.
              reconnectAttempts = 0;

              eventHandler({ type: 'relay_connected' });

              if (!resolved) {
                resolved = true;
                resolve();
              } else {
                // Subsequent successful reconnections are logged for observability.
                console.log('[serve] Reconnected to relay successfully.');
              }
              break;
            }

            case 'client_connected':
              sessionManager.handleConnect(msg.connectionId);
              sessionManager.setSendCallback(msg.connectionId, createSendCallback(ws, msg.connectionId));
              break;

            case 'client_disconnected':
              sessionManager.handleDisconnect(msg.connectionId, msg.reason || 'Client disconnected');
              break;

            case 'data':
              if (msg.data && msg.connectionId) {
                const messageData = Buffer.from(msg.data, 'base64');

                if (!sessionManager.getSession(msg.connectionId)) {
                  sessionManager.setSendCallback(msg.connectionId, createSendCallback(ws, msg.connectionId));
                }

                const response = await sessionManager.handleMessage(
                  msg.connectionId,
                  messageData
                );

                if (response) {
                  ws.send(createDataMessage(msg.connectionId, response));
                }
              }
              break;

            case 'error':
              logger.error(`Relay error: ${msg.message} (${msg.code})`);
              if (!resolved) {
                reject(new Error(msg.message));
              }
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
