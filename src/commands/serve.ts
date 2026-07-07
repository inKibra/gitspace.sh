/**
 * Serve command implementation
 *
 * Handles 'gssh machine serve ...' to start a machine-side daemon that accepts
 * remote connections, authenticates clients via X3DH, and spawns PTY sessions.
 *
 * Also handles gitspace.sh hosting via Cloudflare Tunnels when configured.
 *
 * Supports daemon mode with start/stop/status subcommands.
 */

import { appendFileSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { spawn } from 'bun';
import { getSessionDir } from '../lib/tmux-lite/protocol.js';
import { logger } from '../utils/logger.js';
import { promptConfirm, selectOne } from '../utils/prompts.js';
import {
  isRelayTrusted,
  addTrustedRelay,
  getTrustedRelay,
  removeTrustedRelay,
  isCloudReachableRelayUrl,
  isLocalhost,
  type RelayTrustStatus,
} from '../core/trusted-relays.js';
import {
  loadKeypair,
  readMachineIdentity,
  getPublicKeyWithoutPassword,
  writeRelayConfig,
} from '../core/identity.js';
import { loadUserRootIdentity, createLocalDeviceCertificate } from '../core/user-identity.js';
import { ClientSessionManager } from '../serve/client-session-manager.js';
import type { ServeEventHandler } from '../serve/types.js';
import type { Identity, StoredIdentity } from '../types/identity.js';
import {
  NoIdentityError,
  SpacesError,
} from '../types/errors.js';
import {
  readHostConfig,
  resolveRelaySubdomains,
  type HostConfig,
} from './host.js';
import {
  deserializeIdentity,
  getPublicIdentity as getPublicIdentityFromPrivate,
} from '../lib/tmux-lite/crypto/identity.js';
import { generateEphemeralKeypair, validateX25519PublicKey, x25519SharedSecret } from '../lib/tmux-lite/crypto/keyexchange.js';
import { open } from '../lib/tmux-lite/crypto/secretbox.js';
import {
  isServeRunning,
  getServePid,
  cleanupServeFiles,
} from '../serve/daemon.js';
import { initializeSecretRuntime } from '../core/secret-runtime.js';
import { fetchRelayIdentity } from './connect.js';
import {
  discoverRelayCandidates as discoverRelayCandidatesBase,
  isRelayHealthy,
  type RelayCandidate,
} from '../core/relay-discovery.js';
import {
  bindControlRelayIdentity,
  bindControlOwner,
  ensureControlStore,
  readControlMeta,
  getControlOwnerIdentityId,
  getVaultMeta,
  resetControlStore,
  setVaultMeta,
} from '../relay/control/store.js';
import {
  connectMachineRelay,
  requestUnlockGrantViaRelay,
  type PublicIdentity,
} from '../relay-client/machine-relay-client.js';
import { deriveUnlockKey } from '../relay/unlock-kdf.js';
import { parseRootInviteToken } from '../lib/tmux-lite/crypto/root-invites.js';
import { computeIdentityId, formatRelayFingerprint } from '../relay/identity.js';
import {
  createDeviceIdentityPasswordContext,
  ensureDeviceIdentityPassword,
  type DeviceIdentityPasswordContext,
} from './device-identity-password.js';
import { ensureUserRootIdentityWithRecovery } from './identity-recovery.js';

import { persistMachineIdentityFromServe } from './serve-machine-identity.js';

/** Package version for daemon status */
const PACKAGE_VERSION = '1.0.0';

/** Default relay URL */
// No default relay - must use hosting or explicit --relay

/** Local relay port for gitspace.sh hosting. */
const LOCAL_RELAY_PORT = 4480;

// ============================================================================
// Helper Functions
// ============================================================================

interface UserRootAuthorizationConfig {
  ownerUserRootId: string;
}

interface CurrentServeRelayBinding {
  publicKey: string;
  fingerprint: string;
}

export async function ensureServeOwnerBindingForStartup(
  ownerUserRootId: string,
  options: { takeover?: boolean; yes?: boolean; currentRelay?: CurrentServeRelayBinding } = {}
): Promise<{ tookOver: boolean }> {
  ensureControlStore();

  const currentVaultOwner = getVaultMeta('owner_user_root_id');
  const currentControlOwner = getControlOwnerIdentityId();
  const controlMeta = readControlMeta();
  const hasPinnedRelayIdentity = Boolean(
    controlMeta.relayIdentityId || controlMeta.relaySigningPublicKey || controlMeta.relayFingerprint,
  );
  const currentRelayIdentityId = options.currentRelay ? computeIdentityId(options.currentRelay.publicKey) : undefined;
  const relayMismatch = Boolean(
    options.currentRelay
      && (
        (controlMeta.relayIdentityId && controlMeta.relayIdentityId !== currentRelayIdentityId)
        || (controlMeta.relaySigningPublicKey && controlMeta.relaySigningPublicKey !== options.currentRelay.publicKey)
        || (controlMeta.relayFingerprint && controlMeta.relayFingerprint !== options.currentRelay.fingerprint)
      ),
  );

  const needsTakeover = (currentVaultOwner && currentVaultOwner !== ownerUserRootId)
    || (currentControlOwner && currentControlOwner !== ownerUserRootId)
    || relayMismatch;

  const shouldForceResetForTakeover = Boolean(
    options.takeover
    && !needsTakeover
    && (currentVaultOwner || currentControlOwner || hasPinnedRelayIdentity),
  );

  if (needsTakeover || shouldForceResetForTakeover) {
    if (!options.takeover) {
      const mismatchMessage = [
        'Persisted relay control state belongs to a different identity.',
        '',
        `  Current user: ${ownerUserRootId.slice(0, 8)}...`,
        currentControlOwner ? `  Control owner: ${currentControlOwner.slice(0, 8)}...` : null,
        currentVaultOwner ? `  Vault owner:   ${currentVaultOwner.slice(0, 8)}...` : null,
        relayMismatch ? `  Pinned relay:  ${controlMeta.relayFingerprint ?? controlMeta.relayIdentityId}` : null,
        relayMismatch ? `  Current relay: ${options.currentRelay?.fingerprint}` : null,
        '',
        'Re-run with `gssh machine serve start --takeover` to clear the persisted relay control state and bind it to the recovered identity.',
      ].filter((line): line is string => line !== null).join('\n');

      logger.error(`[serve] owner binding mismatch during startup.\n${mismatchMessage}`);
      throw new SpacesError(
        mismatchMessage,
        'USER_ERROR',
        1,
      );
    }

    if (!options.yes) {
      const confirmed = await promptConfirm(
        needsTakeover
          ? 'Persisted relay control state belongs to a different identity. Clear it and rebind this machine to the current recovered identity?'
          : 'Clear persisted relay control state and relay identity pins before starting machine serve?',
        false,
      );
      if (!confirmed) {
        throw new SpacesError('Cancelled', 'USER_ERROR', 1);
      }
    }

    logger.warning(
      needsTakeover
        ? 'Clearing persisted relay control state and rebinding machine serve ownership to the current identity.'
        : 'Clearing persisted relay control state and relay identity pins before machine serve startup.',
    );
    resetControlStore();
    ensureControlStore();
    bindControlOwner(ownerUserRootId);
    setVaultMeta('owner_user_root_id', ownerUserRootId);
    return { tookOver: true };
  }

  if (!currentControlOwner) {
    bindControlOwner(ownerUserRootId);
  }

  if (!currentVaultOwner) {
    setVaultMeta('owner_user_root_id', ownerUserRootId);
  }

  return { tookOver: false };
}

function resolveOwnerUserRootIdFromEnrollmentToken(enrollmentToken: string | undefined): string {
  if (!enrollmentToken) {
    throw new SpacesError('Unlock mode requires --enrollment-token', 'USER_ERROR', 1);
  }

  const parsed = parseRootInviteToken(enrollmentToken);
  if (!parsed || parsed.type !== 'relay-machine' || !parsed.ownerUserRootId) {
    throw new SpacesError('Unlock mode enrollment token is invalid', 'USER_ERROR', 1);
  }

  return parsed.ownerUserRootId;
}

async function resolveUserRootAuthorizationConfig(options: {
  yes?: boolean;
  devicePasswordContext?: DeviceIdentityPasswordContext;
} = {}): Promise<UserRootAuthorizationConfig> {
  const userRoot = await loadUserRootIdentity()
    ?? await ensureUserRootIdentityWithRecovery({
      devicePasswordContext: options.devicePasswordContext,
      yes: options.yes,
      context: 'machine serve authorization',
    });
  if (!userRoot) {
    throw new SpacesError(
      'User root identity is required for serve authorization. Run `gssh user identity init` or `gssh user identity recover` first.',
      'USER_ERROR',
      1,
    );
  }

  return {
    ownerUserRootId: userRoot.id,
  };
}

async function discoverRelayCandidates(hostConfig: HostConfig | null): Promise<RelayCandidate[]> {
	const candidates = await discoverRelayCandidatesBase({
		hostConfig,
		includeLocalRelay: true,
		includeCachedRelay: false,
	});
	const localCandidates = candidates.filter((candidate) => candidate.source === 'local');
	const remoteCandidates = candidates.filter((candidate) => candidate.source !== 'local');
	const localHealthChecks = await Promise.all(localCandidates.map((candidate) => isRelayHealthy(candidate.url)));
	const healthyLocalCandidates = localCandidates.filter((_, index) => localHealthChecks[index]);
	return [...healthyLocalCandidates, ...remoteCandidates];
}

async function resolveRelayUrlForServe(
  explicitRelayUrl: string | undefined,
  hostConfig: HostConfig | null,
): Promise<string> {
  if (explicitRelayUrl) {
    return explicitRelayUrl;
  }

  const candidates = await discoverRelayCandidates(hostConfig);
  if (candidates.length === 0) {
    throw new SpacesError(
      'No relay found.\n\n'
      + 'Start a local relay:\n'
      + '  gssh relay start\n\n'
      + 'Or configure account hosting:\n'
      + '  gssh user auth login\n'
      + '  gssh user host reserve <subdomain>\n\n'
      + 'Or pass one explicitly:\n'
      + '  gssh machine serve start --relay ws://localhost:4480/ws',
      'USER_ERROR',
      1,
    );
  }

  if (candidates.length === 1) {
    logger.info(`Using relay ${candidates[0].url}`);
    return candidates[0].url;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const optionsList = candidates.map((candidate) => `  - ${candidate.url}`).join('\n');
    throw new SpacesError(
      'Multiple relays available; choose one with --relay.\n\n'
      + `Available relays:\n${optionsList}`,
      'USER_ERROR',
      1,
    );
  }

  const selectedRelay = await selectOne(
    candidates.map((candidate) => ({
      label: candidate.label,
      value: candidate.url,
      description: candidate.description,
    })),
    'Select relay for machine serve',
  );

  if (!selectedRelay) {
    throw new SpacesError('Cancelled', 'USER_ERROR', 1);
  }

  return selectedRelay;
}

function isLocalRelayBindUrl(relayUrl: string): boolean {
  try {
    const parsed = new URL(relayUrl);
    return isLocalhost(relayUrl) || parsed.hostname === '0.0.0.0' || parsed.hostname === '::';
  } catch {
    return false;
  }
}

export function resolveCloudRelayUrlForConfig(relayUrl: string, hostConfig: HostConfig | null): string | undefined {
  if (isCloudReachableRelayUrl(relayUrl)) {
    return relayUrl;
  }

  if (!hostConfig?.subdomain) {
    return undefined;
  }

  try {
    const parsed = new URL(relayUrl);
    const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : parsed.protocol === 'ws:' ? '80' : '');
    if (port === String(LOCAL_RELAY_PORT) && isLocalRelayBindUrl(relayUrl)) {
      return `wss://${hostConfig.subdomain}.gitspace.sh/ws`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Result of relay trust verification
 */
type RelayTrustResult =
  | { trusted: true; fingerprint: string }
  | { trusted: false; reason: string };

/**
 * Verify and establish trust with a relay
 *
 * @param relayUrl - The relay URL
 * @param relayPublicKey - The relay's public key
 * @param relayFingerprint - The relay's fingerprint
 * @param relayLabel - Optional relay label
 * @param explicitPubkey - Optional explicit public key to trust
 * @returns Result indicating if trust was established
 */
async function verifyRelayTrust(
  relayUrl: string,
  relayPublicKey: string,
  relayFingerprint: string,
  relayLabel: string | undefined,
  explicitPubkey?: string,
  autoYes: boolean = false,
  takeover: boolean = false,
 ): Promise<RelayTrustResult> {
  const computedFingerprint = formatRelayFingerprint(relayPublicKey);
  if (relayFingerprint !== computedFingerprint) {
    logger.error(
      `Relay at ${relayUrl} reported fingerprint ${relayFingerprint}, but computed ${computedFingerprint} from relayPublicKey.`,
    );
    return { trusted: false, reason: 'Relay identity response is inconsistent' };
  }

  // --takeover is an explicit, operator-initiated trust reset. By passing
  // --takeover the caller has consented to rebinding to whatever relay
  // identity is currently reachable at `relayUrl`. We forget any existing
  // pin so the subsequent trust flow treats this relay as `unknown` and
  // re-anchors trust via the normal path (auto-trust on --yes, or prompt).
  // This is intentional for recovery from stale pins and for dev/CI use;
  // callers who want strict trust preservation must omit --takeover.
  if (takeover) {
    const removed = removeTrustedRelay(relayUrl);
    if (removed) {
      logger.warning(`Forgetting trusted relay pin for ${relayUrl} due to --takeover.`);
    }
  }

  const trustStatus = isRelayTrusted(relayUrl, relayPublicKey);

  if (trustStatus === 'mismatch') {
    // SECURITY: Relay key changed - HARD FAIL
    logger.log('');
    logger.error('SECURITY WARNING: Relay public key mismatch!');
    logger.error(`Expected:  ${getTrustedRelay(relayUrl)?.fingerprint}`);
    logger.error(`Received:  ${computedFingerprint}`);
    logger.log('');
    logger.error('The relay identity has changed. This could indicate a man-in-the-middle attack.');
    logger.error('If this is expected, remove the old relay entry from your configured identity directory (trusted-relays.json) and retry.');
    return { trusted: false, reason: 'Relay identity mismatch - possible security threat' };
  }

  if (trustStatus === 'unknown') {
    // Unknown relay - check if explicit trust was provided or auto-trust localhost
    if (isLocalhost(relayUrl)) {
      // Localhost auto-trust
      console.log('[serve] Localhost relay - auto-trusting');
      addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
    } else if (explicitPubkey) {
      // Explicit trust provided via --relay-pubkey
      if (explicitPubkey === relayPublicKey) {
        console.log('[serve] Explicit trust match - trusting relay');
        addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
      } else {
        logger.error('Relay public key does not match --relay-pubkey');
        logger.error(`Expected:  ${formatRelayFingerprint(explicitPubkey)}`);
        logger.error(`Received:  ${computedFingerprint}`);
        return { trusted: false, reason: 'Relay public key does not match --relay-pubkey' };
      }
    } else {
      // Unknown remote relay - prompt for confirmation
      logger.log('');
      logger.bold('Unknown Relay');
      logger.log(`  URL:         ${relayUrl}`);
      logger.log(`  Fingerprint: ${computedFingerprint}`);
      if (relayLabel) {
        logger.log(`  Label:       ${relayLabel}`);
      }
      logger.log('');

      // Ask for confirmation
      if (autoYes) {
        logger.error('Unknown relay requires interactive approval or --relay-pubkey.');
        return { trusted: false, reason: 'Unknown relay requires interactive approval or --relay-pubkey' };
      }

      const shouldTrust = await promptConfirm('Trust this relay?');

      if (!shouldTrust) {
        logger.info('Relay not trusted, aborting connection');
        return { trusted: false, reason: 'User declined to trust relay' };
      }

      // Save trust
      addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
      logger.success('Relay trusted and saved');
    }
  }

  return { trusted: true, fingerprint: computedFingerprint };
}

function decryptUnlockGrant(
  relayEphemeralKeyBase64: string,
  saltBase64: string,
  ciphertextBase64: string,
  machineEphemeralPrivateKey: Uint8Array
): StoredIdentity {
  const relayEphemeralPublicKey = new Uint8Array(Buffer.from(relayEphemeralKeyBase64, 'base64'));
  if (!validateX25519PublicKey(relayEphemeralPublicKey)) {
    throw new SpacesError('Relay unlock key is invalid', 'USER_ERROR', 1);
  }

  const salt = new Uint8Array(Buffer.from(saltBase64, 'base64'));
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');
  const sharedSecret = x25519SharedSecret(machineEphemeralPrivateKey, relayEphemeralPublicKey);
  const key = deriveUnlockKey(sharedSecret, salt);
  const plaintext = open(ciphertext, key);
  if (!plaintext) {
    throw new SpacesError('Failed to decrypt unlock grant', 'USER_ERROR', 1);
  }

  return JSON.parse(plaintext.toString('utf-8')) as StoredIdentity;
}

interface UnlockIdentityResult {
  identity: Identity;
  registerPermit: string;
}

async function fetchIdentityViaUnlockToken(
  relayUrl: string,
  relayPubkey: string | undefined,
  workspaceId: string,
  unlockToken: string
): Promise<UnlockIdentityResult> {
  const ephemeral = generateEphemeralKeypair();
  try {
    const grant = await requestUnlockGrantViaRelay({
      relayUrl,
      relayPubkey,
      workspaceId,
      unlockToken,
      ephemeralKey: Buffer.from(ephemeral.publicKey).toString('base64'),
      verifyRelayTrust,
    });

    const parsed = decryptUnlockGrant(
      grant.relayEphemeralKey,
      grant.salt,
      grant.ciphertext,
      ephemeral.privateKey,
    );
    const identity = deserializeIdentity(parsed);
    return {
      identity,
      registerPermit: grant.registerPermit,
    };
  } catch (error) {
    throw new SpacesError(
      error instanceof Error ? error.message : String(error),
      'USER_ERROR',
      1,
    );
  }
}

// ============================================================================
// Process Hosting (Serve Tunnel)
// ============================================================================

export interface ProcessHostEntry {
  hostname: string;
  service: string;
  protocol: 'http' | 'tcp';
  workspaceId: string;
  processName: string;
  instance: number;
  port: number;
  portName?: string;
}


export function buildServeIngressConfig(entries: ProcessHostEntry[]): string {
  const lines = ['ingress:'];
  for (const entry of entries) {
    lines.push(`  - hostname: ${entry.hostname}`);
    lines.push(`    service: ${entry.service}`);
  }
  lines.push('  - service: http_status:404');
  return `${lines.join('\n')}\n`;
}

// ============================================================================
// Relay Connection
// ============================================================================

/**
 * Connect to relay WebSocket with protocol message support
 */
/**
 * Set up shutdown handlers
 */
// ============================================================================
// Daemon Commands
// ============================================================================

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Start serve daemon
 */
export async function serveStart(options: {
  relay?: string;
  relayPubkey?: string;
  bootstrapToken?: string;
  enrollmentToken?: string;
  unlockToken?: string;
  workspaceId?: string;
  passwordStdin?: boolean;
  foreground?: boolean;
  ignoreKeychainAndSkipSecrets?: boolean;
  takeover?: boolean;
  yes?: boolean;
} = {}): Promise<void> {
  // Daemon-unification P2 (docs/DAEMON-UNIFICATION.md): serve start is a thin
  // ACTIVATOR now — unlock the identity, resolve relay trust interactively,
  // then hand the pinned config to the tmux-lite machine daemon over its
  // same-user unix socket. The daemon hosts the relay client + E2E session
  // manager in-process (serve-runtime.ts); there is no second daemon.
  const devicePasswordContext = createDeviceIdentityPasswordContext({ passwordStdin: options.passwordStdin });
  const skipOwnerBindingCheck = process.env.GITSPACE_SKIP_OWNER_BINDING_CHECK === '1';
  const usingUnlockMode = Boolean(options.unlockToken);
  const enrollmentToken = options.enrollmentToken;

  const { ensureServer, isServerRunning, send } = await import('../lib/tmux-lite/cli.js');

  if (await isServerRunning()) {
    const st = await send({ type: 'serve-status' });
    if (st.type === 'serve-status' && st.status.active) {
      logger.info(`serve already active (relay ${st.status.relayUrl ?? 'unknown'}) — run 'gssh machine serve stop' to deactivate.`);
      return;
    }
  }

  const hostConfig = readHostConfig();
  const relayUrl = await resolveRelayUrlForServe(options.relay, hostConfig);

  // Identity: unlock-token flow (cloud workspaces) or local keypair unlock.
  let identity: Identity | null = null;
  let registerPermit: string | undefined;
  if (usingUnlockMode) {
    if (!options.workspaceId) throw new SpacesError('Unlock mode requires --workspace-id', 'USER_ERROR', 1);
    if (!enrollmentToken) throw new SpacesError('Unlock mode requires --enrollment-token', 'USER_ERROR', 1);
    const unlocked = await fetchIdentityViaUnlockToken(relayUrl, options.relayPubkey, options.workspaceId, options.unlockToken ?? '');
    identity = unlocked.identity;
    registerPermit = unlocked.registerPermit;
  } else {
    const password = await ensureDeviceIdentityPassword({ yes: options.yes }, devicePasswordContext);
    if (!password) {
      logger.info('Cancelled');
      return;
    }
    identity = await loadKeypair(password);
    if (!identity) {
      throw new SpacesError('Failed to unlock identity. Check your password.', 'USER_ERROR', 1);
    }
  }

  const publicIdentity = getPublicIdentityFromPrivate(identity);
  const machineIdentity = readMachineIdentity();
  const machineId = machineIdentity?.machineId ?? identity.id;

  // Relay trust happens HERE, interactively; the daemon only ever compares
  // against the pubkey we pin into the activation config.
  const relayIdentity = await fetchRelayIdentity(relayUrl);
  let relayPubkey = options.relayPubkey ?? relayIdentity.publicKey;
  let ownerUserRootId: string | undefined;
  let deviceCertificate: string | undefined;
  if (usingUnlockMode) {
    ownerUserRootId = resolveOwnerUserRootIdFromEnrollmentToken(enrollmentToken!);
  } else {
    const trustResult = await verifyRelayTrust(
      relayUrl,
      relayIdentity.publicKey,
      relayIdentity.fingerprint,
      relayIdentity.label,
      options.relayPubkey,
      Boolean(options.yes),
      Boolean(options.takeover),
    );
    if (!trustResult.trusted) {
      throw new SpacesError(trustResult.reason, 'USER_ERROR', 1);
    }
    relayPubkey = relayIdentity.publicKey;
    const userRootAuth = await resolveUserRootAuthorizationConfig({ yes: options.yes, devicePasswordContext });
    ownerUserRootId = userRootAuth.ownerUserRootId;
    if (!skipOwnerBindingCheck) {
      await ensureServeOwnerBindingForStartup(ownerUserRootId, {
        takeover: options.takeover,
        yes: options.yes,
        currentRelay: relayIdentity,
      });
    }
    // Device certificate: proves this machine belongs to the user root so the
    // relay can auto-authorize without enrollment tokens. Best-effort.
    try {
      deviceCertificate = await createLocalDeviceCertificate(identity);
      logger.info(`[serve] Device certificate created for owner ${ownerUserRootId}`);
    } catch (error) {
      logger.warning(`[serve] Could not create device certificate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Ensure the machine daemon exists, then activate the serve runtime in it.
  await ensureServer();
  const b64 = (v: Uint8Array): string => Buffer.from(v).toString('base64');
  const res = await send({
    type: 'serve-activate',
    config: {
      relayUrl,
      relayPubkey,
      machineId,
      ownerUserRootId,
      identity: {
        id: identity.id,
        label: identity.label,
        createdAt: identity.createdAt,
        signingPublicKey: b64(identity.signing.publicKey),
        signingSecretKey: b64(identity.signing.secretKey),
        keyExchangePublicKey: b64(identity.keyExchange.publicKey),
        keyExchangeSecretKey: b64(identity.keyExchange.privateKey),
      },
      publicIdentity,
      bootstrapToken: options.bootstrapToken,
      registerPermit,
      enrollmentToken,
      deviceCertificate,
    },
  });
  const daemonLog = join(getSessionDir(), 'tmux-lite-daemon.log');
  if (res.type === 'error') {
    throw new SpacesError(`serve activation failed: ${res.message} (daemon log: ${daemonLog})`, 'SYSTEM_ERROR', 2);
  }
  if (res.type !== 'serve-status') {
    throw new SpacesError('Unexpected serve-activate response', 'SYSTEM_ERROR', 2);
  }

  // Persist relay + machine identity for reconnect/bootstrap flows.
  bindControlRelayIdentity({
    relayIdentityId: computeIdentityId(relayPubkey),
    relaySigningPublicKey: relayPubkey,
    relayFingerprint: relayIdentity.fingerprint,
  });
  writeRelayConfig({
    relayUrl,
    cloudRelayUrl: resolveCloudRelayUrlForConfig(relayUrl, hostConfig),
    machineId,
    savedAt: Date.now(),
  });
  persistMachineIdentityFromServe({
    existingIdentity: machineIdentity,
    machineId,
    relayUrl,
    publicIdentity,
  });

  logger.success(`serve active in the machine daemon — relay ${relayUrl} (${res.status.relayStatus ?? 'connected'})`);
  logger.info(`Daemon log: ${daemonLog}`);

  if (options.foreground) {
    logger.info('Following the daemon log (Ctrl+C stops following; serve stays active)...');
    await followDaemonLog(daemonLog);
  }

  // Force exit: inquirer prompts (password/trust) keep the event loop alive.
  process.exit(0);
}

/** Tail the daemon log until interrupted (serve --foreground). */
async function followDaemonLog(path: string): Promise<void> {
  const { openSync, readSync, fstatSync } = await import('node:fs');
  let offset = 0;
  try { offset = fstatSync(openSync(path, 'r')).size; } catch { /* not created yet */ }
  for (;;) {
    await Bun.sleep(500);
    try {
      const fd = openSync(path, 'r');
      const size = fstatSync(fd).size;
      if (size < offset) offset = 0; // rotated/truncated
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        process.stdout.write(buf);
      }
    } catch { /* file missing — keep waiting */ }
  }
}

export async function serveStop(): Promise<void> {
  const { isServerRunning, send } = await import('../lib/tmux-lite/cli.js');
  let deactivated = false;
  if (await isServerRunning()) {
    const res = await send({ type: 'serve-deactivate' });
    deactivated = res.type === 'serve-status';
  }

  // Legacy: a pre-unification standalone serve daemon may still be running.
  if (isServeRunning()) {
    const pid = getServePid();
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        await Bun.sleep(800);
        if (isServeRunning()) process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    cleanupServeFiles();
    logger.success('legacy serve daemon stopped');
    return;
  }

  logger.success(deactivated
    ? 'serve deactivated (the machine daemon keeps running for local use)'
    : 'serve was not active');
}

export async function serveStatus(): Promise<void> {
  const box = (lines: string[]) => {
    const width = 44;
    const top = '┌─ serve (machine daemon) ' + '─'.repeat(width - 26) + '┐';
    const bottom = '└' + '─'.repeat(width) + '┘';
    const padded = lines.map((l) => {
      const visible = l.replace(/\x1b\[[0-9;]*m/g, '');
      const padding = width - visible.length;
      return '│ ' + l + ' '.repeat(Math.max(0, padding - 1)) + '│';
    });
    return [top, ...padded, bottom].join('\n');
  };

  const { isServerRunning, send } = await import('../lib/tmux-lite/cli.js');
  if (!(await isServerRunning())) {
    logger.log(box([
      'Status:   \x1b[90m○ daemon not running\x1b[0m',
      '',
      'Run: \x1b[36mgssh machine serve start\x1b[0m',
    ]));
    return;
  }
  const res = await send({ type: 'serve-status' });
  if (res.type !== 'serve-status' || !res.status.active) {
    logger.log(box([
      'Status:   \x1b[90m○ inactive (daemon running, local-only)\x1b[0m',
      '',
      'Run: \x1b[36mgssh machine serve start\x1b[0m',
    ]));
    return;
  }
  const st = res.status;
  const statusIcon = st.relayStatus === 'connected' ? '\x1b[32m●\x1b[0m' : '\x1b[33m●\x1b[0m';
  logger.log(box([
    `Status:   ${statusIcon} active (in the machine daemon)`,
    `Relay:    ${st.relayUrl ?? 'unknown'}`,
    `          ${st.relayStatus ?? 'unknown'}`,
    `Clients:  ${st.clients ?? 0} active`,
    `Uptime:   ${st.startedAt ? formatUptime(Math.floor((Date.now() - st.startedAt) / 1000)) : 'unknown'}`,
  ]));
}
