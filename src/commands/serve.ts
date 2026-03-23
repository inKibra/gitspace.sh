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
import { createHash } from 'crypto';
import os from 'os';
import { spawn, type Subprocess } from 'bun';
import { logger } from '../utils/logger.js';
import { promptConfirm, selectOne } from '../utils/prompts.js';
import { getSecret } from '../utils/secrets.js';
import {
  isRelayTrusted,
  addTrustedRelay,
  getTrustedRelay,
  isCloudReachableRelayUrl,
  isLocalhost,
  type RelayTrustStatus,
} from '../core/trusted-relays.js';
import {
  loadKeypair,
  readMachineIdentity,
  getPublicKeyWithoutPassword,
  shouldDeferLocalStoreUnlockForLegacyIdentityMigration,
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
  getServeTokenKey,
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
  getServeDaemonDir,
  type StatusResponse,
} from '../serve/daemon.js';
import { initializeSecretRuntime } from '../core/secret-runtime.js';
import { getAgentState, listSessions, watchAgentState } from '../lib/tmux-lite/cli.js';
import { loadProcessesConfig } from '../lib/processes/config.js';
import { parseProcessSessionName } from '../lib/processes/names.js';
import { resolveWorkspaceRef } from '../lib/events/paths.js';
import { fetchRelayIdentity } from './connect.js';
import { getGitspaceDir } from '../core/config.js';
import { buildProcessHostname, normalizeHostLabel } from '../utils/hostnames.js';
import type { ProcessPortConfig } from '../types/processes.js';
import {
  discoverRelayCandidates as discoverRelayCandidatesBase,
  isRelayHealthy,
  type RelayCandidate,
} from '../core/relay-discovery.js';
import {
  bindPersistedOwnerIdentity,
  bindControlRelayIdentity,
  ensureControlStore,
  resetControlStore,
} from '../relay/control/store.js';
import {
  connectMachineRelay,
  requestUnlockGrantViaRelay,
  type PublicIdentity,
} from '../relay-client/machine-relay-client.js';
import { deriveUnlockKey } from '../relay/unlock-kdf.js';
import { parseRootInviteToken } from '../lib/tmux-lite/crypto/root-invites.js';
import { computeIdentityId, formatRelayFingerprint } from '../relay/identity.js';
import { isCloudflaredInstalled, trackCloudflaredOutput } from '../utils/cloudflared.js';
import {
  createDeviceIdentityPasswordContext,
  ensureDeviceIdentityPassword,
  type DeviceIdentityPasswordContext,
} from './device-identity-password.js';
import { ensureUserRootIdentityWithRecovery } from './identity-recovery.js';
import {
  ensureLocalStorePassword,
  LOCAL_STORE_PASSWORD_ENV,
  type LocalStorePasswordContext,
} from './local-store-password.js';
import { unlockLocalSecureStore } from '../core/local-secure-store.js';
import {
  formatStartupControlStateMismatch,
  formatStartupControlStateTakeoverPrompt,
  formatStartupControlStateTakeoverWarning,
  planStartupControlState,
} from '../core/control-state-startup.js';

/** Package version for daemon status */
const PACKAGE_VERSION = '1.0.0';

/** Default relay URL */
// No default relay - must use hosting or explicit --relay

/** Local relay port for gitspace.sh hosting */
const LOCAL_RELAY_PORT = 4480;
const MAX_CLOUDFLARED_RESTARTS = 5;
const CLOUDFLARED_RESTART_DELAY = 5000;

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

  const plan = planStartupControlState({
    ownerUserRootId,
    currentRelay: options.currentRelay,
  });

  const shouldForceResetForTakeover = Boolean(
    options.takeover
    && !plan.needsTakeover
    && (plan.ownerBinding.controlOwnerId || plan.ownerBinding.vaultOwnerId || plan.hasPinnedRelayIdentity),
  );

  if (plan.needsTakeover || shouldForceResetForTakeover) {
    if (!options.takeover) {
      const mismatchMessage = formatStartupControlStateMismatch(plan, {
        subject: 'machine serve',
        takeoverCommand: 'gssh machine serve start --takeover',
      });

      logger.error(`[serve] owner binding mismatch during startup.\n${mismatchMessage}`);
      throw new SpacesError(
        mismatchMessage,
        'USER_ERROR',
        1,
      );
    }

    if (!options.yes) {
        const confirmed = await promptConfirm(
          formatStartupControlStateTakeoverPrompt(plan, {
            subject: 'machine serve',
            takeoverCommand: 'gssh machine serve start --takeover',
          }),
        false,
      );
      if (!confirmed) {
        throw new SpacesError('Cancelled', 'USER_ERROR', 1);
      }
    }

    logger.warning(
      formatStartupControlStateTakeoverWarning(plan, {
        subject: 'machine serve',
        takeoverCommand: 'gssh machine serve start --takeover',
      }),
    );
    resetControlStore();
    ensureControlStore();
    bindPersistedOwnerIdentity(ownerUserRootId);
    return { tookOver: true };
  }

  bindPersistedOwnerIdentity(ownerUserRootId);

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
): Promise<RelayTrustResult> {
  const computedFingerprint = formatRelayFingerprint(relayPublicKey);
  if (relayFingerprint !== computedFingerprint) {
    logger.error(
      `Relay at ${relayUrl} reported fingerprint ${relayFingerprint}, but computed ${computedFingerprint} from relayPublicKey.`,
    );
    return { trusted: false, reason: 'Relay identity response is inconsistent' };
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
    logger.error('If this is expected, remove the old relay entry from ~/.gitspace/.identity/trusted-relays.json and retry.');
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

const SERVE_CONFIG_PATH = () => join(getServeDaemonDir(), 'serve-tunnel.yml');
const SERVE_REFRESH_INTERVAL_MS = 5000;
const SERVE_READY_TIMEOUT_MS = 5000;
const MAX_WORKSPACE_PATH_CACHE_SIZE = 256;

export function buildServeIngressConfig(entries: ProcessHostEntry[]): string {
  const lines = ['ingress:'];
  for (const entry of entries) {
    lines.push(`  - hostname: ${entry.hostname}`);
    lines.push(`    service: ${entry.service}`);
  }
  lines.push('  - service: http_status:404');
  return `${lines.join('\n')}\n`;
}

function hashConfig(config: string): string {
  return createHash('sha256').update(config).digest('hex');
}

function findWorkspacePathById(workspaceId: string): string | null {
  const spacesDir = getGitspaceDir();
  if (!existsSync(spacesDir)) {
    return null;
  }
  const entries = readdirSync(spacesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'app') continue;
    const candidate = join(spacesDir, entry.name, 'workspaces', workspaceId);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function waitForCloudflaredReady(proc: Subprocess): Promise<boolean> {
  const result = await Promise.race([
    proc.exited.then((code) => ({ code })),
    Bun.sleep(SERVE_READY_TIMEOUT_MS).then(() => ({ code: null })),
  ]);
  return result.code === null;
}

class ServeProcessHostManager {
  private serveDomain: string;
  private tunnelToken: string;
  private process: Subprocess | null = null;
  private configHash: string | null = null;
  private registry: ProcessHostEntry[] = [];
  private refreshPromise: Promise<void> | null = null;
  private restartAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private workspacePathCache = new Map<string, string>();

  constructor(options: { serveDomain: string; tunnelToken: string }) {
    this.serveDomain = options.serveDomain;
    this.tunnelToken = options.tunnelToken;
  }

  get domain(): string {
    return this.serveDomain;
  }

  get entries(): ProcessHostEntry[] {
    return [...this.registry];
  }

  get isActive(): boolean {
    return this.process !== null;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.refreshInternal().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  stop(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.workspacePathCache.clear();
  }

  private async refreshInternal(): Promise<void> {
    const entries = await this.collectProcessHosts();
    const sorted = entries.sort((a, b) => a.hostname.localeCompare(b.hostname));
    const config = buildServeIngressConfig(sorted);
    const nextHash = hashConfig(config);

    if (this.configHash === nextHash && this.process) {
      this.registry = sorted;
      return;
    }

    ensureServeDaemonDir();
    const configPath = SERVE_CONFIG_PATH();
    writeFileSync(configPath, config, 'utf-8');

    const swapped = await this.swapProcess(configPath);
    if (swapped) {
      this.registry = sorted;
      this.configHash = nextHash;
      logger.dim(`Serve tunnel updated (${sorted.length} routes)`);
      return;
    }

    this.handleStartupFailure();
  }

  private async collectProcessHosts(): Promise<ProcessHostEntry[]> {
    let sessions: Awaited<ReturnType<typeof listSessions>> = [];
    try {
      sessions = await listSessions();
    } catch {
      return [];
    }
    const configCache = new Map<string, ReturnType<typeof loadProcessesConfig>>();
    const entries: ProcessHostEntry[] = [];
    const seenWorkspaceIds = new Set<string>();

    for (const session of sessions) {
      const parsed = parseProcessSessionName(session.name);
      const processName = parsed?.processName;
      if (!processName) continue;
      const instance = parsed?.instance ?? 1;

      let workspaceRef = resolveWorkspaceRef(session.cwd);
      if (!workspaceRef && parsed?.workspaceId) {
        const cached = this.workspacePathCache.get(parsed.workspaceId);
        const workspacePath = cached ?? findWorkspacePathById(parsed.workspaceId);
        if (workspacePath) {
          this.setCachedWorkspacePath(parsed.workspaceId, workspacePath);
          workspaceRef = resolveWorkspaceRef(workspacePath);
          seenWorkspaceIds.add(parsed.workspaceId);
        }
      }
      if (!workspaceRef) continue;
      seenWorkspaceIds.add(workspaceRef.workspaceId);
      if (parsed?.workspaceId) {
        seenWorkspaceIds.add(parsed.workspaceId);
      }

      const config = configCache.get(workspaceRef.workspacePath) ?? loadProcessesConfig(workspaceRef.workspacePath);
      configCache.set(workspaceRef.workspacePath, config);
      const definition = config.processes.find((process) => process.name === processName);
      const ports = (definition?.ports ?? []).filter((port): port is ProcessPortConfig => Boolean(port));

      for (const port of ports) {
        if (!Number.isInteger(port.port) || port.port <= 0) {
          continue;
        }
        const trimmedPortName = port.name?.trim();
        const portLabel = trimmedPortName && trimmedPortName.length > 0 ? trimmedPortName : String(port.port);
        const hostname = buildProcessHostname(
          this.serveDomain,
          workspaceRef.workspaceId,
          processName,
          instance,
          portLabel
        );
        const protocol = port.protocol === 'tcp' ? 'tcp' : 'http';
        const service = `${protocol}://127.0.0.1:${port.port}`;
        entries.push({
          hostname,
          service,
          protocol,
          workspaceId: workspaceRef.workspaceId,
          processName,
          instance,
          port: port.port,
          portName: port.name,
        });
      }
    }

    const deduped = new Map<string, ProcessHostEntry>();
    for (const entry of entries) {
      if (!deduped.has(entry.hostname)) {
        deduped.set(entry.hostname, entry);
      }
    }
    this.pruneWorkspacePathCache(seenWorkspaceIds);
    return Array.from(deduped.values());
  }

  private async swapProcess(configPath: string): Promise<boolean> {
    const nextProcess = this.spawnProcess(configPath);
    const ready = await waitForCloudflaredReady(nextProcess);
    if (!ready) {
      nextProcess.kill();
      return false;
    }

    const previous = this.process;
    this.process = nextProcess;
    this.restartAttempts = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (previous) {
      previous.kill();
    }
    return true;
  }

  private spawnProcess(configPath: string): Subprocess {
    const proc = spawn(['cloudflared', 'tunnel', '--config', configPath, 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: this.tunnelToken },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    trackCloudflaredOutput(proc, {
      includeLine: (line) => line.includes('ERR') || line.includes('error') || line.includes('failed'),
    });

    proc.exited.then((exitCode) => {
      if (exitCode !== 0 && this.process === proc) {
        this.handleCrash();
      }
    });

    return proc;
  }

  private handleCrash(): void {
    this.process = null;
    this.scheduleRetry('crashed');
  }

  private handleStartupFailure(): void {
    this.scheduleRetry('failed to start');
  }

  private scheduleRetry(reason: 'crashed' | 'failed to start'): void {
    if (this.retryTimer) {
      return;
    }

    this.restartAttempts += 1;
    if (this.restartAttempts > MAX_CLOUDFLARED_RESTARTS) {
      logger.error(`serve tunnel ${reason} ${MAX_CLOUDFLARED_RESTARTS} times, giving up`);
      return;
    }

    logger.info(`Restarting serve tunnel (${reason}) (attempt ${this.restartAttempts}/${MAX_CLOUDFLARED_RESTARTS})...`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, CLOUDFLARED_RESTART_DELAY);
  }

  private setCachedWorkspacePath(workspaceId: string, workspacePath: string): void {
    if (this.workspacePathCache.has(workspaceId)) {
      this.workspacePathCache.delete(workspaceId);
    }
    this.workspacePathCache.set(workspaceId, workspacePath);

    while (this.workspacePathCache.size > MAX_WORKSPACE_PATH_CACHE_SIZE) {
      const oldest = this.workspacePathCache.keys().next().value;
      if (!oldest) {
        break;
      }
      this.workspacePathCache.delete(oldest);
    }
  }

  private pruneWorkspacePathCache(seenWorkspaceIds: Set<string>): void {
    for (const key of this.workspacePathCache.keys()) {
      if (!seenWorkspaceIds.has(key)) {
        this.workspacePathCache.delete(key);
      }
    }
  }
}

async function startServeProcessHosting(hostConfig: HostConfig): Promise<ServeProcessHostManager | null> {
  const serveSubdomain = hostConfig.serveSubdomain ?? `${hostConfig.subdomain}.serve`;
  const serveDomain = `${serveSubdomain}.gitspace.sh`;
  const tunnelToken = await getSecret(getServeTokenKey(hostConfig.subdomain));

  if (!tunnelToken) {
    logger.warning(`No serve tunnel token found for ${serveDomain}`);
    logger.dim(`Run: gssh user host reserve ${hostConfig.subdomain} (to get token)`);
    return null;
  }

  if (!await isCloudflaredInstalled()) {
    logger.warning('cloudflared is not installed');
    return null;
  }

  const manager = new ServeProcessHostManager({ serveDomain, tunnelToken });
  await manager.refresh();
  if (manager.isActive) {
    logger.success(`Serve tunnel active: https://${serveDomain}`);
    logger.dim(`  Wildcard: https://*.${serveDomain}`);
  } else {
    logger.warning(`Serve tunnel failed to start for https://${serveDomain}; retrying in background`);
  }
  return manager;
}

function stopServeProcessHosting(
  manager: ServeProcessHostManager | null,
  timer: ReturnType<typeof setInterval> | null
): void {
  if (timer) {
    clearInterval(timer);
  }
  manager?.stop();
}

async function cleanupServeStartupFailure(
  sessionManager: ClientSessionManager | null,
  processHostManager: ServeProcessHostManager | null,
  processHostRefreshTimer: ReturnType<typeof setInterval> | null,
): Promise<void> {
  stopServeProcessHosting(processHostManager, processHostRefreshTimer);
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
  const sharedPasswordContext: DeviceIdentityPasswordContext & LocalStorePasswordContext =
    createDeviceIdentityPasswordContext({ passwordStdin: options.passwordStdin });
  const devicePasswordContext: DeviceIdentityPasswordContext = sharedPasswordContext;
  const localStorePasswordContext: LocalStorePasswordContext = sharedPasswordContext;

  // Check if already running
  if (isServeRunning()) {
    const pid = getServePid();
    logger.info(`serve daemon already running${pid ? ` (pid ${pid})` : ''}`);
    return;
  }

  const usingUnlockMode = Boolean(options.unlockToken);
  const skipOwnerBindingCheck = process.env.GITSPACE_SKIP_OWNER_BINDING_CHECK === '1';

  let password: string | null = null;
  let localStorePassword: string | null = null;
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
      localStorePassword = await ensureLocalStorePassword({ yes: options.yes }, localStorePasswordContext);
      if (!localStorePassword) {
        logger.info('Cancelled');
        return;
      }
      if (!shouldDeferLocalStoreUnlockForLegacyIdentityMigration()) {
        await unlockLocalSecureStore(localStorePassword);
      }
      devicePasswordContext.password = localStorePassword;

      password = await ensureDeviceIdentityPassword({ yes: options.yes }, devicePasswordContext);
      if (!password) {
        logger.info('Cancelled');
        return;
      }

      // Validate secure store + identity before daemonizing
      const loadedIdentity = await loadKeypair(password);
      if (!loadedIdentity) {
        throw new SpacesError(
          'Failed to unlock local secure store identity. Check your password.',
          'USER_ERROR',
          1
        );
      }

    }

    if (usingUnlockMode) {
      localStorePassword = await ensureLocalStorePassword({ yes: options.yes }, localStorePasswordContext);
      if (!localStorePassword) {
        logger.info('Cancelled');
        return;
      }
      if (!shouldDeferLocalStoreUnlockForLegacyIdentityMigration()) {
        await unlockLocalSecureStore(localStorePassword);
      }
      devicePasswordContext.password = localStorePassword;
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
        ...(localStorePassword ? { [LOCAL_STORE_PASSWORD_ENV]: localStorePassword } : {}),
      },
    });

    // Send password via stdin (non-unlock mode)
    if (!usingUnlockMode) {
      if (!password) {
        throw new SpacesError('Failed to pass local secure store password to serve daemon startup.', 'SYSTEM_ERROR', 2);
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

  localStorePassword = await ensureLocalStorePassword({ yes: options.yes }, localStorePasswordContext);
  if (!localStorePassword) {
    logger.info('Cancelled');
    cleanupServeFiles();
    return;
  }
  if (!shouldDeferLocalStoreUnlockForLegacyIdentityMigration()) {
    await unlockLocalSecureStore(localStorePassword);
  }
  devicePasswordContext.password = localStorePassword;

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
        'Failed to unlock local secure store identity. Check your password.',
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

  // Check for gitspace.sh hosting
  const hostConfig = readHostConfig();
  let processHostManager: ServeProcessHostManager | null = null;
  let processHostRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let sessionManager: ClientSessionManager | null = null;

  let effectiveRelayUrl: string;
  try {
    effectiveRelayUrl = await resolveRelayUrlForServe(options.relay, hostConfig);
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager, processHostManager, processHostRefreshTimer);
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
      await cleanupServeStartupFailure(sessionManager, processHostManager, processHostRefreshTimer);
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
    hosting: hostConfig?.subdomain ? {
      subdomain: hostConfig.subdomain,
      tunnelActive: false,
    } : undefined,
  });

  if (hostConfig?.subdomain) {
    try {
      processHostManager = await startServeProcessHosting(hostConfig);
      if (processHostManager) {
        processHostRefreshTimer = setInterval(() => {
          void processHostManager?.refresh();
        }, SERVE_REFRESH_INTERVAL_MS);
      }
    } catch (error) {
      await cleanupServeStartupFailure(sessionManager, processHostManager, processHostRefreshTimer);
      throw new SpacesError(
        `Failed to initialize serve process hosting: ${error instanceof Error ? error.message : String(error)}`,
        'SYSTEM_ERROR',
        2,
      );
    }
  }

  const remoteSessionOptions = processHostManager
    ? {
        processHostDomain: processHostManager.domain,
        onProcessesChanged: () => processHostManager?.refresh(),
      }
    : undefined;

  // Create session manager
  sessionManager = new ClientSessionManager({
    relay: effectiveRelayUrl,
    identity,
    remoteSessionOptions,
    ownerUserRootId,
  });

  // Initialize session manager (starts tmux-lite server)
  try {
    await sessionManager.initialize();
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager, processHostManager, processHostRefreshTimer);
    throw error;
  }

  const applyAgentDelta = (delta: import('../serve/agent-event-manager.js').AgentStateUpdateDelta): void => {
    if (delta.type === 'agent_state_snapshot') {
      currentAgentSnapshot = { ...delta.workspaces };
      return;
    }
    if (!('workspaceId' in delta)) {
      return;
    }
    const state = currentAgentSnapshot[delta.workspaceId] ?? {
      workspaceId: delta.workspaceId,
      sessions: [],
      statuses: {},
      pendingPermissions: {},
      lastMessages: {},
    };
    currentAgentSnapshot[delta.workspaceId] = state;
    switch (delta.type) {
      case 'agent_session_status':
        state.statuses[delta.sessionId] = delta.status;
        break;
      case 'agent_permission_added':
        if (!state.pendingPermissions[delta.sessionId]) state.pendingPermissions[delta.sessionId] = [];
        state.pendingPermissions[delta.sessionId].push(delta.permission);
        break;
      case 'agent_permission_removed':
        if (state.pendingPermissions[delta.sessionId]) {
          state.pendingPermissions[delta.sessionId] = state.pendingPermissions[delta.sessionId].filter(
            (permission) => permission.id !== delta.permissionId,
          );
        }
        break;
      case 'agent_session_error':
        break;
      case 'agent_last_message':
        state.lastMessages[delta.sessionId] = delta.preview;
        break;
      case 'agent_session_created':
        if (!state.sessions.some((session) => session.id === delta.sessionId)) {
          state.sessions.push({ id: delta.sessionId, title: delta.title });
        }
        break;
      case 'agent_session_updated': {
        const index = state.sessions.findIndex((session) => session.id === delta.sessionId);
        if (index === -1) {
          state.sessions.push({ id: delta.sessionId, title: delta.title });
        } else {
          state.sessions[index] = { id: delta.sessionId, title: delta.title };
        }
        break;
      }
      case 'agent_session_deleted':
        state.sessions = state.sessions.filter((session) => session.id !== delta.sessionId);
        delete state.statuses[delta.sessionId];
        delete state.pendingPermissions[delta.sessionId];
        delete state.lastMessages[delta.sessionId];
        break;
    }
  };

  let currentAgentSnapshot: Record<string, import('../serve/agent-event-manager.js').WorkspaceAgentState> = {};
  let stopAgentWatch: (() => void) | null = null;
  try {
    currentAgentSnapshot = Object.fromEntries((await getAgentState()).map((workspace) => [workspace.workspaceId, workspace]));
    stopAgentWatch = await watchAgentState({
      onSnapshot: (workspaces) => {
        currentAgentSnapshot = Object.fromEntries(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
        void sessionManager.broadcastAgentStateSnapshot(currentAgentSnapshot);
      },
      onUpdate: (delta) => {
        applyAgentDelta(delta);
        void sessionManager.broadcastAgentStateUpdate(delta);
      },
      onError: (error) => {
        logger.error(`[serve] tmux-lite agent watch failed: ${error.message}`);
      },
    });
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager, processHostManager, processHostRefreshTimer);
    throw error;
  }

  // Event handler - update daemon state
  const eventHandler: ServeEventHandler = (event) => {
    switch (event.type) {
      case 'relay_connected':
        updateDaemonState({
          relay: {
            url: effectiveRelayUrl,
            status: 'connected',
            reconnectAttempt: 0,
            nextRetryAt: undefined,
          },
        });
        break;
      case 'relay_disconnected':
        updateDaemonState({
          relay: {
            url: effectiveRelayUrl,
            status: 'disconnected',
            reconnectAttempt: undefined,
            nextRetryAt: undefined,
          },
        });
        break;
      case 'relay_reconnecting': {
        const nextRetryAt = event.nextRetryMs !== undefined
          ? Date.now() + event.nextRetryMs
          : undefined;
        logger.log(
          `[serve] Relay reconnecting (attempt ${event.attempt})${nextRetryAt ? `, next retry in ${Math.round((nextRetryAt - Date.now()) / 1000)}s` : ''}`,
        );
        updateDaemonState({
          relay: {
            url: effectiveRelayUrl,
            status: 'reconnecting',
            reconnectAttempt: event.attempt,
            nextRetryAt,
          },
        });
        break;
      }
      case 'client_authenticated': {
        updateDaemonState({ clients: sessionManager.establishedSessionCount });
        void sessionManager.sendAgentStateSnapshot(event.connectionId, currentAgentSnapshot);
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
    );

    if (trustedRelayIdentity) {
      const relayIdentityId = computeIdentityId(trustedRelayIdentity.relayPublicKey);
      bindControlRelayIdentity({
        relayIdentityId,
        relaySigningPublicKey: trustedRelayIdentity.relayPublicKey,
        relayFingerprint: trustedRelayIdentity.relayFingerprint,
      });
    }
  } catch (error) {
    const originalError = error;
    try {
      await cleanupServeStartupFailure(sessionManager, processHostManager, processHostRefreshTimer);
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

  // Save relay config for reconnect/bootstrap flows
  try {
    writeRelayConfig({
      relayUrl: effectiveRelayUrl,
      cloudRelayUrl: resolveCloudRelayUrlForConfig(effectiveRelayUrl, hostConfig),
      machineId,
      savedAt: Date.now(),
    });
  } catch (error) {
    await cleanupServeStartupFailure(sessionManager, processHostManager, processHostRefreshTimer);
    throw new SpacesError(
      `Failed to persist relay config: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2,
    );
  }

  // Set up shutdown handlers with daemon cleanup
  setupShutdownHandlers(sessionManager, true, () => {
    stopAgentWatch?.();
    stopServeProcessHosting(processHostManager, processHostRefreshTimer);
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

    const relayStatusLine = (() => {
      if (status.relay.status === 'reconnecting' && status.relay.reconnectAttempt !== undefined) {
        const attempt = status.relay.reconnectAttempt;
        const nextRetryAt = status.relay.nextRetryAt;
        const countdown = nextRetryAt
          ? ` (next retry in ${Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000))}s)`
          : '';
        return `${relayStatus} — attempt ${attempt}${countdown}`;
      }
      return relayStatus;
    })();

    const lines = [
      `Status:   ${statusIcon} running (pid ${status.pid})`,
      `Version:  ${status.version}`,
      `Relay:    ${status.relay.url}`,
      `          ${relayStatusLine}`,
      `Clients:  ${status.clients} active`,
      `Uptime:   ${formatUptime(status.uptime)}`,
    ];

    if (status.hosting) {
      const tunnelIcon = status.hosting.tunnelActive ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
      lines.push(`Hosting:  ${tunnelIcon} ${status.hosting.subdomain}.gitspace.sh`);
    }

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
