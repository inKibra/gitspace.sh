import { ed25519 } from '@noble/curves/ed25519.js';
import { logger } from '../utils/logger.js';
import { promptConfirm, promptPassword } from '../utils/prompts.js';
import {
  getPublicKeyWithoutPassword,
  keypairExists,
  loadKeypair,
  readRelayConfig,
  writeMachineIdentity,
  writeRelayConfig,
} from '../core/identity.js';
import {
  addTrustedRelay,
  getTrustedRelay,
  getTrustedRelays,
  isCloudReachableRelayUrl,
  isLocalhost,
  isRelayTrusted,
} from '../core/trusted-relays.js';
import { PROTOCOL_VERSION } from '../relay/protocol.js';
import { parseRootInviteToken } from '../lib/tmux-lite/crypto/root-invites.js';
import { NoIdentityError, SpacesError } from '../types/errors.js';

interface ParsedEnrollmentInput {
  relayUrl?: string;
  token: string;
}

function isRelayInviteToken(value: string): boolean {
  return value.startsWith('gssh-invite:');
}

function normalizeRelayUrl(url: URL): string {
  let protocol = url.protocol;
  if (protocol === 'http:') protocol = 'ws:';
  if (protocol === 'https:') protocol = 'wss:';
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    throw new SpacesError('Enrollment URL must use ws://, wss://, http://, or https://', 'USER_ERROR', 1);
  }

  const path = url.pathname && url.pathname !== '/' ? url.pathname : '/ws';
  return `${protocol}//${url.host}${path}`;
}

function extractTokenFromUrl(input: string): ParsedEnrollmentInput | null {
  try {
    const url = new URL(input);

    const hashRaw = url.hash.startsWith('#') ? url.hash.slice(1) : '';
    let token = '';
    if (hashRaw.startsWith('token=')) {
      token = decodeURIComponent(hashRaw.slice('token='.length));
    } else if (hashRaw.startsWith('invite=')) {
      token = decodeURIComponent(hashRaw.slice('invite='.length));
    } else if (hashRaw.length > 0) {
      token = decodeURIComponent(hashRaw);
    }

    if (!token) {
      const queryToken = url.searchParams.get('token') || url.searchParams.get('invite');
      if (queryToken) token = queryToken;
    }

    if (!token || !isRelayInviteToken(token)) {
      return null;
    }

    return {
      relayUrl: normalizeRelayUrl(url),
      token,
    };
  } catch {
    return null;
  }
}

function parseEnrollmentInput(input: string): ParsedEnrollmentInput {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new SpacesError('Enrollment token is required.', 'USER_ERROR', 1);
  }

  if (isRelayInviteToken(trimmed)) {
    return { token: trimmed };
  }

  const parsedUrl = extractTokenFromUrl(trimmed);
  if (parsedUrl) {
    return parsedUrl;
  }

  throw new SpacesError(
    'Invalid enrollment token. Use a relay-machine invite token or a URL with #<token>.',
    'USER_ERROR',
    1,
  );
}

function resolveRelayUrl(embeddedRelayUrl?: string): string {
  if (embeddedRelayUrl) {
    return embeddedRelayUrl;
  }

  const relayConfig = readRelayConfig();
  if (relayConfig?.relayUrl) {
    return relayConfig.relayUrl;
  }

  const trustedRelays = getTrustedRelays();
  if (trustedRelays.length === 1) {
    return trustedRelays[0].url;
  }

  if (trustedRelays.length > 1) {
    throw new SpacesError(
      'Multiple trusted relays found. Pass a URL token like wss://relay.example/ws#<token>.',
      'USER_ERROR',
      1,
    );
  }

  throw new SpacesError(
    'Relay URL is unknown. Pass a URL token like wss://relay.example/ws#<token>.',
    'USER_ERROR',
    1,
  );
}

async function verifyRelayTrust(
  relayUrl: string,
  relayPublicKey: string,
  relayFingerprint: string,
  relayLabel?: string,
): Promise<void> {
  const trustStatus = isRelayTrusted(relayUrl, relayPublicKey);

  if (trustStatus === 'mismatch') {
    throw new SpacesError(
      `Relay identity mismatch. Expected ${getTrustedRelay(relayUrl)?.fingerprint}, got ${relayFingerprint}.`,
      'USER_ERROR',
      1,
    );
  }

  if (trustStatus === 'unknown') {
    if (isLocalhost(relayUrl)) {
      addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
      return;
    }

    logger.log('');
    logger.bold('Unknown Relay');
    logger.log(`  URL:         ${relayUrl}`);
    logger.log(`  Fingerprint: ${relayFingerprint}`);
    if (relayLabel) {
      logger.log(`  Label:       ${relayLabel}`);
    }
    logger.log('');

    const shouldTrust = await promptConfirm('Trust this relay?', true);
    if (!shouldTrust) {
      throw new SpacesError('Relay not trusted.', 'USER_ERROR', 1);
    }

    addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
  }
}

interface EnrollResult {
  machineId: string;
  relayUrl: string;
}

async function performEnrollment(
  relayUrl: string,
  token: string,
  machineId: string,
  signingPublicKey: string,
  keyExchangePublicKey: string,
  signingPrivateKey: Uint8Array,
  label?: string,
): Promise<EnrollResult> {
  const url = new URL(relayUrl);
  url.searchParams.set('role', 'machine');

  return await new Promise<EnrollResult>((resolve, reject) => {
    const ws = new WebSocket(url.toString());
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Timed out waiting for relay enrollment response'));
    }, 20000);

    let completed = false;

    const finish = (result: EnrollResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(result);
    };

    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      reject(new Error(message));
    };

    ws.onerror = () => {
      fail('Failed to connect to relay');
    };

    ws.onmessage = async (event) => {
      let msg: Record<string, unknown>;
      try {
        const raw = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        fail('Invalid response from relay');
        return;
      }

      if (msg.type === 'relay_identity') {
        const relayPublicKey = typeof msg.publicKey === 'string' ? msg.publicKey : '';
        const relayFingerprint = typeof msg.fingerprint === 'string' ? msg.fingerprint : '';
        const relayLabel = typeof msg.label === 'string' ? msg.label : undefined;
        const challenge = typeof msg.challenge === 'string' ? msg.challenge : '';

        if (!relayPublicKey || !relayFingerprint || !challenge) {
          fail('Relay identity message is missing required fields');
          return;
        }

        try {
          await verifyRelayTrust(relayUrl, relayPublicKey, relayFingerprint, relayLabel);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          return;
        }

        try {
          const nonceBytes = new Uint8Array(Buffer.from(challenge, 'base64'));
          const signature = ed25519.sign(nonceBytes, signingPrivateKey);
          const challengeResponse = Buffer.from(signature).toString('base64');

          ws.send(JSON.stringify({
            type: 'register_machine',
            machineId,
            signingKey: signingPublicKey,
            keyExchangeKey: keyExchangePublicKey,
            label,
            challengeResponse,
            protocolVersion: PROTOCOL_VERSION,
            enrollmentToken: token,
          }));
        } catch (error) {
          fail(`Failed to sign relay challenge: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (msg.type === 'registered') {
        finish({ machineId, relayUrl });
        return;
      }

      if (msg.type === 'error') {
        const message = typeof msg.message === 'string' ? msg.message : 'Enrollment failed';
        const code = typeof msg.code === 'string' ? msg.code : 'ERROR';
        fail(`[${code}] ${message}`);
      }
    };

    ws.onclose = () => {
      if (!completed) {
        fail('Relay closed the connection before enrollment completed');
      }
    };
  });
}

export async function enrollMachine(options: {
  invite: string;
  label?: string;
}): Promise<void> {
  const parsed = parseEnrollmentInput(options.invite);
  const parsedInvite = parseRootInviteToken(parsed.token);
  if (!parsedInvite || parsedInvite.type !== 'relay-machine') {
    throw new SpacesError('Invite must be a valid relay-machine invite token.', 'USER_ERROR', 1);
  }

  const relayUrl = parsed.relayUrl
    ? resolveRelayUrl(parsed.relayUrl)
    : resolveRelayUrl(parsedInvite.relayUrl);

  if (parsed.relayUrl && parsedInvite.relayUrl !== relayUrl) {
    throw new SpacesError('Invite relay URL does not match the relay URL in the provided link.', 'USER_ERROR', 1);
  }

  if (!keypairExists()) {
    throw new NoIdentityError();
  }

  const password = await promptPassword('Enter password to unlock local secure store identity:');
  if (!password) {
    logger.info('Cancelled');
    return;
  }

  const identity = await loadKeypair(password);
  const publicIdentity = getPublicKeyWithoutPassword();
  if (!publicIdentity) {
    throw new SpacesError('Failed to read public identity', 'SYSTEM_ERROR', 2);
  }

  const machineId = identity.id;
  const machineLabel = options.label || publicIdentity.label;
  const signingPrivateKey = identity.signing.secretKey.slice(0, 32);

  if (publicIdentity.signingPublicKey !== parsedInvite.targetMachineSigningKey) {
    throw new SpacesError('This invite is for a different machine signing key.', 'USER_ERROR', 1);
  }

  if (publicIdentity.keyExchangePublicKey !== parsedInvite.targetMachineKeyExchangeKey) {
    throw new SpacesError('This invite is for a different machine key exchange key.', 'USER_ERROR', 1);
  }

  if (machineId !== parsedInvite.targetMachineId) {
    throw new SpacesError('This invite is for a different machine identity.', 'USER_ERROR', 1);
  }

  logger.info(`Enrolling machine ${machineId} with relay...`);

  const result = await performEnrollment(
    relayUrl,
    parsed.token,
    machineId,
    publicIdentity.signingPublicKey,
    publicIdentity.keyExchangePublicKey,
    signingPrivateKey,
    machineLabel,
  );

  writeRelayConfig({
    relayUrl: result.relayUrl,
    cloudRelayUrl: isCloudReachableRelayUrl(result.relayUrl) ? result.relayUrl : undefined,
    machineId: result.machineId,
    savedAt: Date.now(),
  });

  writeMachineIdentity({
    machineId: result.machineId,
    machineName: machineLabel || result.machineId,
    relayUrl: result.relayUrl,
    registeredAt: new Date().toISOString(),
  });

  logger.success('Machine enrollment complete');
  logger.log(`  Machine: ${result.machineId}`);
  logger.log(`  Relay:   ${result.relayUrl}`);
  if (machineLabel) {
    logger.log(`  Label:   ${machineLabel}`);
  }
}
