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
  writeServePid,
  cleanupServeFiles,
  startStatusServer,
  stopStatusServer,
  setDaemonState,
  updateDaemonState,
  queryServeStatus,
  sendShutdownCommand,
  getServeLogFile,
  ensureServeDaemonDir,
  type StatusResponse,
} from '../serve/daemon.js';
import { initializeSecretRuntime } from '../core/secret-runtime.js';
import { getAgentState, watchAgentState } from '../lib/tmux-lite/cli.js';
import { applyAgentDeltaToAgentState } from '../lib/tmux-lite/agent-state-reducer.js';
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

async function cleanupServeStartupFailure(
  sessionManager: ClientSessionManager | null,
): Promise<void> {
  stopStatusServer();

  if (sessionManager) {
    try {
      sessionManager.cleanup();
    } catch {
      // Best-effort cleanup.
    }
  }

  cleanupServeFiles();
}

// ============================================================================
// Relay Connection
// ============================================================================

/**
 * Connect to relay WebSocket with protocol message support
 */
async function connectToRelay(
  relayUrl: string,
  machineId: string,
  publicIdentity: PublicIdentity,
  sessionManager: ClientSessionManager,
  eventHandler: ServeEventHandler,
  signingPrivateKey?: Uint8Array,
  relayPubkey?: string,
  bootstrapToken?: string,
  registerPermit?: string,
  enrollmentToken?: string,
  deviceCertificate?: string,
  autoYes?: boolean,
  takeover?: boolean,
 ): Promise<{ relayPublicKey: string; relayFingerprint: string; relayLabel?: string } | null> {
  let trustedRelayIdentity: { relayPublicKey: string; relayFingerprint: string; relayLabel?: string } | null = null;

  await connectMachineRelay(
    relayUrl,
    machineId,
    publicIdentity,
    sessionManager,
    eventHandler,
    async (url, relayPublicKey, relayFingerprint, relayLabel, explicitPubkey) => {
      const trustResult = await verifyRelayTrust(
        url,
        relayPublicKey,
        relayFingerprint,
        relayLabel,
        explicitPubkey,
        Boolean(autoYes),
        Boolean(takeover),
      );

      if (trustResult.trusted) {
        trustedRelayIdentity = {
          relayPublicKey,
          relayFingerprint: trustResult.fingerprint,
          relayLabel,
        };
      }

      return trustResult;
    },
    signingPrivateKey,
    relayPubkey,
    bootstrapToken,
    registerPermit,
    enrollmentToken,
    deviceCertificate,
  );

  return trustedRelayIdentity;
}

/**
 * Set up shutdown handlers
 */
export async function performServeShutdown(
  sessionManager: Pick<ClientSessionManager, 'cleanup'>,
  options: {
    isDaemon?: boolean;
    cleanup?: () => void | Promise<void>;
    exit?: (code: number) => never;
    timeoutMs?: number;
  } = {}
): Promise<never> {
  logger.log('');
  logger.info('Shutting down...');

  const timeoutMs = options.timeoutMs ?? 3_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const cleanupPromise = Promise.resolve(options.cleanup?.()).then(() => sessionManager.cleanup());
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([cleanupPromise, timeoutPromise]).catch((error) => {
    logger.error(`Shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });

  if (timedOut) {
    logger.warning(`Shutdown cleanup timed out after ${timeoutMs}ms; forcing exit.`);
  }

  if (options.isDaemon) {
    stopStatusServer();
    cleanupServeFiles();
  }

  const exit = options.exit ?? process.exit;
  return exit(0);
}

function setupShutdownHandlers(
  sessionManager: ClientSessionManager,
  isDaemon: boolean = false,
  cleanup?: () => void
): void {
  let shutdownPromise: Promise<never> | null = null;
  const shutdown = () => {
    if (shutdownPromise) {
      return;
    }
    shutdownPromise = performServeShutdown(sessionManager, { isDaemon, cleanup }).catch((error) => {
      logger.error(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

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
  const devicePasswordContext = createDeviceIdentityPasswordContext({ passwordStdin: options.passwordStdin });

  // Check if already running
  if (isServeRunning()) {
    const pid = getServePid();
    logger.info(`serve daemon already running${pid ? ` (pid ${pid})` : ''}`);
    return;
  }

  const usingUnlockMode = Boolean(options.unlockToken);
  const skipOwnerBindingCheck = process.env.GITSPACE_SKIP_OWNER_BINDING_CHECK === '1';

  let password: string | null = null;
  let identity: Identity | null = null;
  let signingPrivateKey: Uint8Array | null = null;
  let publicIdentity: PublicIdentity | null = null;
  let registerPermit: string | undefined;
  let enrollmentToken = options.enrollmentToken;

  // If not foreground mode, fork to background
  if (!options.foreground) {
    if (usingUnlockMode) {
      if (!options.relay) {
        throw new SpacesError('Unlock mode requires --relay', 'USER_ERROR', 1);
      }
      if (!options.workspaceId) {
        throw new SpacesError('Unlock mode requires --workspace-id', 'USER_ERROR', 1);
      }
      if (!options.enrollmentToken) {
        throw new SpacesError('Unlock mode requires --enrollment-token', 'USER_ERROR', 1);
      }
    } else {
      password = await ensureDeviceIdentityPassword({ yes: options.yes }, devicePasswordContext);
      if (!password) {
        logger.info('Cancelled');
        return;
      }

      // Validate password before daemonizing
      const loadedIdentity = await loadKeypair(password);
      if (!loadedIdentity) {
        throw new SpacesError(
          'Failed to unlock identity. Check your password.',
          'USER_ERROR',
          1
        );
      }

    }

    if (!options.relay) {
      const daemonHostConfig = readHostConfig();
      options.relay = await resolveRelayUrlForServe(undefined, daemonHostConfig);
    }

    if (!usingUnlockMode) {
      const userRootAuth = await resolveUserRootAuthorizationConfig({
        yes: options.yes,
        devicePasswordContext,
      });
      const relayIdentity = await fetchRelayIdentity(options.relay);
      const trustResult = await verifyRelayTrust(
        options.relay,
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

      options.relayPubkey ??= relayIdentity.publicKey;

      await ensureServeOwnerBindingForStartup(userRootAuth.ownerUserRootId, {
        takeover: options.takeover,
        yes: options.yes,
        currentRelay: relayIdentity,
      });
    }

    logger.log('Starting serve daemon...');

    // Build args for background process
    // Detect if we're running as a compiled binary vs dev mode
    const isCompiled = !process.execPath.endsWith('bun');

    const serveArgs = ['machine', 'serve', 'start', '--foreground'];
    if (options.relay) serveArgs.push('--relay', options.relay);
    if (options.relayPubkey) serveArgs.push('--relay-pubkey', options.relayPubkey);
    if (options.bootstrapToken) serveArgs.push('--bootstrap-token', options.bootstrapToken);
    if (options.enrollmentToken) serveArgs.push('--enrollment-token', options.enrollmentToken);
    if (options.unlockToken) serveArgs.push('--unlock-token', options.unlockToken);
    if (options.workspaceId) serveArgs.push('--workspace-id', options.workspaceId);
    if (options.ignoreKeychainAndSkipSecrets) {
      serveArgs.push('--ignore-keychain-and-skip-secrets');
    }
    if (options.yes) {
      serveArgs.push('--yes');
    }
    if (options.takeover) {
      serveArgs.push('--takeover');
    }
    if (!usingUnlockMode) {
      serveArgs.push('--password-stdin');
    }

    // Build command: compiled binary runs directly, dev mode uses bun
    const cmd = isCompiled
      ? [process.execPath, ...serveArgs]
      : ['bun', process.argv[1], ...serveArgs];

    // Write output to log file for debugging
    const logFile = getServeLogFile();
    ensureServeDaemonDir();

    // Truncate log file at start
    await Bun.write(logFile, `[${new Date().toISOString()}] Starting serve daemon...\n`);

    const child = spawn({
      cmd,
      stdin: 'pipe',
      stdout: Bun.file(logFile),
      stderr: Bun.file(logFile),
      env: {
        ...process.env,
        GITSPACE_SKIP_OWNER_BINDING_CHECK: '1',
      },
    });

    // Send password via stdin (non-unlock mode)
    if (!usingUnlockMode) {
      if (!password) {
        throw new SpacesError('Failed to pass identity password to serve daemon startup.', 'SYSTEM_ERROR', 2);
      }

      child.stdin.write(password);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    // Wait a bit for process to start
    await Bun.sleep(1000);

    // Check if it started
    if (isServeRunning()) {
      const pid = getServePid();
      logger.success(`serve daemon started${pid ? ` (pid ${pid})` : ''}`);
      // Force exit since inquirer prompts may keep event loop alive
      process.exit(0);
    } else {
      // Read log file for error message
      const logContent = await Bun.file(logFile).text();
      logger.error('Daemon log:');
      logger.log(logContent);
      throw new SpacesError('Failed to start serve daemon. Check log above for details.', 'SYSTEM_ERROR', 2);
    }
  }

  // Foreground mode identity resolution
  if (usingUnlockMode) {
    if (!options.relay) {
      cleanupServeFiles();
      throw new SpacesError('Unlock mode requires --relay', 'USER_ERROR', 1);
    }
    if (!options.workspaceId) {
      cleanupServeFiles();
      throw new SpacesError('Unlock mode requires --workspace-id', 'USER_ERROR', 1);
    }
    if (!options.enrollmentToken) {
      cleanupServeFiles();
      throw new SpacesError('Unlock mode requires --enrollment-token', 'USER_ERROR', 1);
    }

    const unlocked = await fetchIdentityViaUnlockToken(
      options.relay,
      options.relayPubkey,
      options.workspaceId,
      options.unlockToken ?? ''
    );
    identity = unlocked.identity;
    registerPermit = unlocked.registerPermit;
  } else {
    password = await ensureDeviceIdentityPassword({ yes: options.yes }, devicePasswordContext);
    if (!password) {
      logger.info('Cancelled');
      cleanupServeFiles();
      return;
    }

    identity = await loadKeypair(password);
    if (!identity) {
      cleanupServeFiles();
      throw new SpacesError(
        'Failed to unlock identity. Check your password.',
        'USER_ERROR',
        1
      );
    }
  }

  if (!identity) {
    cleanupServeFiles();
    throw new SpacesError('Failed to initialize identity for serve daemon', 'SYSTEM_ERROR', 2);
  }

  signingPrivateKey = identity.signing.secretKey.slice(0, 32);
  publicIdentity = getPublicIdentityFromPrivate(identity);

  // Foreground/daemon mode - write PID and start status server
  writeServePid(process.pid);
  startStatusServer();

  // Guard: clean up the PID file if the process crashes unexpectedly after it
  // has been written.  Without these handlers an orphaned PID file would cause
  // the parent (and subsequent `gssh machine serve start` invocations) to
  // believe the daemon is still running.
  const cleanupOnCrash = (reason: unknown) => {
    logger.error(`[serve] fatal: ${reason instanceof Error ? reason.message : String(reason)}`);
    stopStatusServer();
    cleanupServeFiles();
    process.exit(1);
  };
  process.once('uncaughtException', cleanupOnCrash);
  process.once('unhandledRejection', cleanupOnCrash);

  try {
    await initializeSecretRuntime({
      ignoreKeychainAndSkipSecrets: options.ignoreKeychainAndSkipSecrets,
    });
  } catch (error) {
    stopStatusServer();
    cleanupServeFiles();
    throw error;
  }

  let ownerUserRootId: string;
  let deviceCertificate: string | undefined;
  if (usingUnlockMode) {
    try {
      ownerUserRootId = resolveOwnerUserRootIdFromEnrollmentToken(enrollmentToken);
    } catch (error) {
      stopStatusServer();
      cleanupServeFiles();
      throw error;
    }
  } else {
    try {
      const userRootAuth = await resolveUserRootAuthorizationConfig({
        yes: options.yes,
        devicePasswordContext,
      });
      ownerUserRootId = userRootAuth.ownerUserRootId;
      await ensureServeOwnerBindingForStartup(ownerUserRootId, {
        takeover: options.takeover,
        yes: options.yes,
      });
    } catch (error) {
      stopStatusServer();
      cleanupServeFiles();
      throw error;
    }

    // Create a device certificate: proves this machine belongs to the user root.
    // The relay can verify this cert to auto-authorize the machine without
    // needing enrollment tokens or preAuthorizedMachines.
    try {
      deviceCertificate = await createLocalDeviceCertificate(identity!);
      logger.info(`[serve] Device certificate created for owner ${ownerUserRootId}`);
    } catch (error) {
      // Device cert is not strictly required — the machine may still be
      // authorized via vault_machines, enrollmentToken, or preAuthorizedMachines.
      // Log a warning but don't fail startup.
      logger.warning(
        `[serve] Could not create device certificate: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!signingPrivateKey || !publicIdentity) {
    stopStatusServer();
    cleanupServeFiles();
    throw new SpacesError('Failed to initialize identity for serve daemon', 'SYSTEM_ERROR', 2);
  }

  // Get config
  const machineIdentity = readMachineIdentity();
  const machineId = machineIdentity?.machineId ?? identity.id;

  // Check for gitspace.sh hosting (used for hosted relay selection only)
  const hostConfig = readHostConfig();
  let sessionManager: ClientSessionManager | null = null;

  let effectiveRelayUrl: string;
  try {
    effectiveRelayUrl = await resolveRelayUrlForServe(options.relay, hostConfig);
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager);
    throw error;
  }

  if (!usingUnlockMode) {
    try {
      const relayIdentity = await fetchRelayIdentity(effectiveRelayUrl);
      const trustResult = await verifyRelayTrust(
        effectiveRelayUrl,
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

      options.relayPubkey ??= relayIdentity.publicKey;
      if (!skipOwnerBindingCheck) {
        await ensureServeOwnerBindingForStartup(ownerUserRootId, {
          takeover: options.takeover,
          yes: options.yes,
          currentRelay: relayIdentity,
        });
      }
    } catch (error) {
      await cleanupServeStartupFailure(sessionManager);
      throw error;
    }
  }

  // Initialize daemon state
  setDaemonState({
    version: PACKAGE_VERSION,
    startTime: Date.now(),
    relay: {
      url: effectiveRelayUrl,
      status: 'connecting',
    },
    clients: 0,
  });

  // Create session manager
  sessionManager = new ClientSessionManager({
    relay: effectiveRelayUrl,
    identity,
    ownerUserRootId,
  });

  // Initialize session manager (starts tmux-lite server)
  try {
    await sessionManager.initialize();
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager);
    throw error;
  }

  const applyAgentDelta = (delta: import('../lib/tmux-lite/agent-event-manager.js').AgentStateUpdateDelta): void => {
    currentAgentSnapshot = applyAgentDeltaToAgentState(currentAgentSnapshot, delta);
  };

  let currentAgentSnapshot: Record<string, import('../lib/tmux-lite/agent-event-manager.js').WorkspaceAgentState> = {};
  let stopAgentWatch: (() => void) | null = null;
  try {
    currentAgentSnapshot = Object.fromEntries((await getAgentState()).map((workspace) => [workspace.workspaceId, workspace]));
    stopAgentWatch = await watchAgentState({
      onSnapshot: (workspaces) => {
        currentAgentSnapshot = Object.fromEntries(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
      },
      onUpdate: (delta) => {
        applyAgentDelta(delta);
        void sessionManager.broadcastAgentStateUpdate(delta);
      },
      onDialogRequest: (request) => {
        void sessionManager.broadcastRawMessage({ type: 'agent_dialog_request', request });
      },
      onUIEvent: (event) => {
        void sessionManager.broadcastRawMessage({ type: 'agent_ui_event', event });
      },
      onError: (error) => {
        logger.error(`[serve] tmux-lite agent watch failed: ${error.message}`);
      },
    });
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager);
    throw error;
  }

  // Event handler - update daemon state
  const eventHandler: ServeEventHandler = (event) => {
    switch (event.type) {
      case 'relay_connected':
        updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'connected' } });
        break;
      case 'relay_disconnected':
        updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'disconnected' } });
        break;
      case 'relay_reconnecting':
        updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'reconnecting' } });
        break;
      case 'client_authenticated': {
        updateDaemonState({ clients: sessionManager.establishedSessionCount });
        if (Object.keys(currentAgentSnapshot).length > 0) {
          void sessionManager.sendAgentStateSnapshot(event.connectionId, currentAgentSnapshot);
        }
        break;
      }
      case 'client_disconnected':
        updateDaemonState({ clients: sessionManager.establishedSessionCount });
        break;
    }
  };

  sessionManager.onEvent(eventHandler);

  // Connect to relay
  try {
    const trustedRelayIdentity = await connectToRelay(
      effectiveRelayUrl,
      machineId,
      publicIdentity,
      sessionManager,
      eventHandler,
      signingPrivateKey,
      options.relayPubkey,
      options.bootstrapToken,
      registerPermit,
      enrollmentToken,
      deviceCertificate,
      options.yes,
      options.takeover,
    );

    if (trustedRelayIdentity) {
      const relayIdentityId = computeIdentityId(trustedRelayIdentity.relayPublicKey);
      bindControlRelayIdentity({
        relayIdentityId,
        relaySigningPublicKey: trustedRelayIdentity.relayPublicKey,
        relayFingerprint: trustedRelayIdentity.relayFingerprint,
      });
    }

    updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'connected' } });
  } catch (error) {
    const originalError = error;
    try {
      await cleanupServeStartupFailure(sessionManager);
    } catch (cleanupError) {
      logger.error(
        `[serve] Cleanup after relay connection failure also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }

    if (originalError instanceof SpacesError) {
      throw originalError;
    }
    throw new SpacesError(
      `Failed to connect to relay: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
      'SYSTEM_ERROR',
      2
    );
  }

  // Save relay + machine identity config for reconnect/bootstrap flows
  try {
    writeRelayConfig({
      relayUrl: effectiveRelayUrl,
      cloudRelayUrl: resolveCloudRelayUrlForConfig(effectiveRelayUrl, hostConfig),
      machineId,
      savedAt: Date.now(),
    });
    persistMachineIdentityFromServe({
      existingIdentity: machineIdentity,
      machineId,
      relayUrl: effectiveRelayUrl,
      publicIdentity,
    });
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager);
    throw new SpacesError(
      `Failed to persist machine relay identity: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2,
    );
  }

  // Set up shutdown handlers with daemon cleanup
  setupShutdownHandlers(sessionManager, true, () => {
    stopAgentWatch?.();
  });

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Stop serve daemon
 */
export async function serveStop(): Promise<void> {
  if (!isServeRunning()) {
    logger.info('serve daemon not running');
    return;
  }

  logger.log('Stopping serve daemon...');

  // Try graceful shutdown via socket first
  const success = await sendShutdownCommand();

  if (success) {
    // Wait for process to exit
    await Bun.sleep(1000);

    if (!isServeRunning()) {
      logger.success('serve daemon stopped');
      return;
    }
  }

  // Fallback: send SIGTERM directly
  const pid = getServePid();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      await Bun.sleep(1000);

      if (!isServeRunning()) {
        logger.success('serve daemon stopped');
        return;
      }

      // Force kill
      process.kill(pid, 'SIGKILL');
      cleanupServeFiles();
      logger.success('serve daemon stopped (forced)');
    } catch {
      cleanupServeFiles();
      logger.success('serve daemon stopped');
    }
  }
}

/**
 * Show serve daemon status
 */
export async function serveStatus(): Promise<void> {
  // Build status output
  const box = (lines: string[]) => {
    const width = 44;
    const top = '┌─ serve daemon ' + '─'.repeat(width - 16) + '┐';
    const bottom = '└' + '─'.repeat(width) + '┘';
    const padded = lines.map((l) => {
      const visible = l.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI for length calc
      const padding = width - visible.length;
      return '│ ' + l + ' '.repeat(Math.max(0, padding - 1)) + '│';
    });
    return [top, ...padded, bottom].join('\n');
  };

  if (!isServeRunning()) {
    const lines = [
      'Status:   \x1b[90m○ not running\x1b[0m',
      '',
      'Run: \x1b[36mgssh machine serve start\x1b[0m',
    ];
    logger.log(box(lines));
    return;
  }

  // Query daemon for status
  const status = await queryServeStatus();

  if (status) {
    const statusIcon = status.relay.status === 'connected' ? '\x1b[32m●\x1b[0m' : '\x1b[33m●\x1b[0m';
    const relayStatus = status.relay.status === 'connected' ? 'connected' : status.relay.status;

    const lines = [
      `Status:   ${statusIcon} running (pid ${status.pid})`,
      `Version:  ${status.version}`,
      `Relay:    ${status.relay.url}`,
      `          ${relayStatus}`,
      `Clients:  ${status.clients} active`,
      `Uptime:   ${formatUptime(status.uptime)}`,
    ];


    logger.log(box(lines));
  } else {
    // Fallback if status query fails
    const pid = getServePid();
    const lines = [
      `Status:   \x1b[32m●\x1b[0m running${pid ? ` (pid ${pid})` : ''}`,
      `Version:  ${PACKAGE_VERSION}`,
    ];
    logger.log(box(lines));
  }
}
