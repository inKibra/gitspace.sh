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
import { spawn, type Subprocess } from 'bun';
import { logger } from '../utils/logger.js';
import { promptPassword, promptConfirm } from '../utils/prompts.js';
import { getSecret } from '../utils/secrets.js';
import {
  isRelayTrusted,
  addTrustedRelay,
  getTrustedRelay,
  isLocalhost,
  computeRelayFingerprint,
  type RelayTrustStatus,
} from '../core/trusted-relays.js';
import {
  loadKeypair,
  keypairExists,
  readMachineIdentity,
  getPublicKeyWithoutPassword,
  writeRelayConfig,
  clearRelayConfig,
} from '../core/identity.js';
import { loadUserRootIdentity } from '../core/user-identity.js';
import { ClientSessionManager } from '../serve/client-session-manager.js';
import type { ServeEventHandler } from '../serve/types.js';
import type { Identity, StoredIdentity } from '../types/identity.js';
import {
  NoIdentityError,
  SpacesError,
} from '../types/errors.js';
import { getServeTokenKey, readHostConfig, type HostConfig } from './host.js';
import { createRelayServer } from '../relay/server.js';
import { formatRelayFingerprint, loadOrCreateRelayIdentity } from '../relay/identity.js';
import { deserializeIdentity, getPublicIdentity as getPublicIdentityFromPrivate } from '../lib/tmux-lite/crypto/identity.js';
import { generateEphemeralKeypair, validateX25519PublicKey, x25519SharedSecret } from '../lib/tmux-lite/crypto/keyexchange.js';
import { open } from '../lib/tmux-lite/crypto/secretbox.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
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
import { listSessions } from '../lib/tmux-lite/cli.js';
import { loadProcessesConfig } from '../lib/processes/config.js';
import { parseProcessSessionName } from '../lib/processes/names.js';
import { resolveWorkspaceRef } from '../lib/events/paths.js';
import { getGitspaceDir } from '../core/config.js';
import { buildProcessHostname, normalizeHostLabel } from '../utils/hostnames.js';
import type { ProcessPortConfig } from '../types/processes.js';
import {
  bindControlOwner,
  bindControlRelayIdentity,
  ensureControlStore,
  getVaultMeta,
  setVaultMeta,
} from '../relay/control/store.js';
import {
  connectMachineRelay,
  requestUnlockGrantViaRelay,
  type PublicIdentity,
} from '../relay-client/machine-relay-client.js';

/** Package version for daemon status */
const PACKAGE_VERSION = '1.0.0';

/** Default relay URL */
// No default relay - must use hosting or explicit --relay

/** Local relay port for gitspace.sh hosting */
const LOCAL_RELAY_PORT = 4480;

/** Cloudflared process reference */
let cloudflaredProcess: Subprocess | null = null;
let cloudflaredSubdomain: string | null = null;
let cloudflaredRestartAttempts = 0;
const MAX_CLOUDFLARED_RESTARTS = 5;
const CLOUDFLARED_RESTART_DELAY = 5000;

// ============================================================================
// Helper Functions
// ============================================================================

interface UserRootAuthorizationConfig {
  ownerUserRootId: string;
}

async function resolveUserRootAuthorizationConfig(): Promise<UserRootAuthorizationConfig> {
  const userRoot = await loadUserRootIdentity();
  if (!userRoot) {
    throw new SpacesError(
      'User root identity is required for serve authorization. Run `gssh user identity init` or `gssh user identity recover` first.',
      'USER_ERROR',
      1,
    );
  }

  ensureControlStore();

  const existingOwner = getVaultMeta('owner_user_root_id');
  if (existingOwner && existingOwner !== userRoot.id) {
    throw new SpacesError(
      `Relay owner mismatch: store is bound to ${existingOwner}, current user root is ${userRoot.id}`,
      'USER_ERROR',
      1,
    );
  }

  if (!existingOwner) {
    setVaultMeta('owner_user_root_id', userRoot.id);
  }

  return {
    ownerUserRootId: userRoot.id,
  };
}

/**
 * Result of relay trust verification
 */
type RelayTrustResult =
  | { trusted: true }
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
  explicitPubkey?: string
): Promise<RelayTrustResult> {
  const trustStatus = isRelayTrusted(relayUrl, relayPublicKey);

  if (trustStatus === 'mismatch') {
    // SECURITY: Relay key changed - HARD FAIL
    logger.log('');
    logger.error('SECURITY WARNING: Relay public key mismatch!');
    logger.error(`Expected:  ${getTrustedRelay(relayUrl)?.fingerprint}`);
    logger.error(`Received:  ${relayFingerprint}`);
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
        logger.error(`Expected:  ${computeRelayFingerprint(explicitPubkey)}`);
        logger.error(`Received:  ${relayFingerprint}`);
        return { trusted: false, reason: 'Relay public key does not match --relay-pubkey' };
      }
    } else {
      // Unknown remote relay - prompt for confirmation
      logger.log('');
      logger.bold('Unknown Relay');
      logger.log(`  URL:         ${relayUrl}`);
      logger.log(`  Fingerprint: ${relayFingerprint}`);
      if (relayLabel) {
        logger.log(`  Label:       ${relayLabel}`);
      }
      logger.log('');

      // Ask for confirmation
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

  return { trusted: true };
}

const UNLOCK_KDF_INFO = new TextEncoder().encode('gitspace-unlock-v1');
const UNLOCK_KDF_KEY_LENGTH = 32;

function deriveUnlockKey(sharedSecret: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, salt, UNLOCK_KDF_INFO, UNLOCK_KDF_KEY_LENGTH);
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
// Cloudflared Management
// ============================================================================

/**
 * Check if cloudflared is installed
 */
async function isCloudflaredInstalled(): Promise<boolean> {
  try {
    const proc = spawn(['which', 'cloudflared'], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Start cloudflared tunnel for a subdomain
 *
 * @param subdomain - The subdomain to tunnel (e.g., 'brad' for brad.gitspace.sh)
 * @returns true if started successfully
 */
async function startCloudflared(subdomain: string): Promise<boolean> {
  // Get tunnel token from keychain
  const tunnelToken = await getSecret(`TUNNEL_TOKEN_${subdomain}`);
  if (!tunnelToken) {
    logger.warning(`No tunnel token found for ${subdomain}.gitspace.sh`);
    logger.dim('Run: gssh user host reserve ' + subdomain + ' (to get token)');
    return false;
  }

  // Check if cloudflared is installed
  if (!await isCloudflaredInstalled()) {
    logger.warning('cloudflared is not installed');
    logger.dim('Install: brew install cloudflared (macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    return false;
  }

  cloudflaredSubdomain = subdomain;

  // Start cloudflared with tunnel token via TUNNEL_TOKEN env var to avoid argv exposure
  logger.info(`Starting tunnel for ${subdomain}.gitspace.sh...`);

  try {
    cloudflaredProcess = spawn(['cloudflared', 'tunnel', 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: tunnelToken },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Handle cloudflared output
    handleCloudflaredOutput(cloudflaredProcess);

    // Monitor process exit
    cloudflaredProcess.exited.then((exitCode) => {
      if (exitCode !== 0 && cloudflaredSubdomain) {
        logger.warning(`cloudflared exited with code ${exitCode}`);
        handleCloudflaredCrash();
      }
    });

    logger.success(`Tunnel active: https://${subdomain}.gitspace.sh`);
    logger.dim(`  Wildcard: https://*.${subdomain}.gitspace.sh`);
    return true;
  } catch (error) {
    logger.error(`Failed to start cloudflared: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Handle cloudflared stdout/stderr
 */
function handleCloudflaredOutput(proc: Subprocess): void {
  // Read stdout
  const stdout = proc.stdout;
  if (stdout && typeof stdout !== 'number') {
    (async () => {
      const reader = stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          // Only log important messages, skip routine output
          if (text.includes('ERR') || text.includes('error') || text.includes('failed')) {
            logger.dim(`[cloudflared] ${text.trim()}`);
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }

  // Read stderr
  const stderr = proc.stderr;
  if (stderr && typeof stderr !== 'number') {
    (async () => {
      const reader = stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          // cloudflared logs most output to stderr
          if (text.includes('ERR') || text.includes('error') || text.includes('failed')) {
            logger.warning(`[cloudflared] ${text.trim()}`);
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }
}

/**
 * Handle cloudflared crash and restart
 */
function handleCloudflaredCrash(): void {
  if (!cloudflaredSubdomain) return;

  cloudflaredRestartAttempts++;

  if (cloudflaredRestartAttempts > MAX_CLOUDFLARED_RESTARTS) {
    logger.error(`cloudflared crashed ${MAX_CLOUDFLARED_RESTARTS} times, giving up`);
    logger.dim('Check your tunnel token or network connection');
    cloudflaredSubdomain = null;
    return;
  }

  logger.info(`Restarting cloudflared (attempt ${cloudflaredRestartAttempts}/${MAX_CLOUDFLARED_RESTARTS})...`);

  setTimeout(async () => {
    if (cloudflaredSubdomain) {
      await startCloudflared(cloudflaredSubdomain);
    }
  }, CLOUDFLARED_RESTART_DELAY);
}

/**
 * Stop cloudflared process
 */
function stopCloudflared(): void {
  if (cloudflaredProcess) {
    logger.dim('Stopping cloudflared...');
    cloudflaredProcess.kill();
    cloudflaredProcess = null;
    cloudflaredSubdomain = null;
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

    handleCloudflaredOutput(proc);

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
): Promise<void> {
  await connectMachineRelay(
    relayUrl,
    machineId,
    publicIdentity,
    sessionManager,
    eventHandler,
    verifyRelayTrust,
    signingPrivateKey,
    relayPubkey,
    bootstrapToken,
    registerPermit,
    enrollmentToken,
  );
}

/**
 * Set up shutdown handlers
 */
function setupShutdownHandlers(
  sessionManager: ClientSessionManager,
  isDaemon: boolean = false,
  cleanup?: () => void
): void {
  const shutdown = () => {
    logger.log('');
    logger.info('Shutting down...');

    // Stop cloudflared if running
    stopCloudflared();
    cleanup?.();

    clearRelayConfig();
    sessionManager.cleanup();

    // Clean up daemon files if in daemon mode
    if (isDaemon) {
      stopStatusServer();
      cleanupServeFiles();
    }

    process.exit(0);
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
} = {}): Promise<void> {
  // Check if already running
  if (isServeRunning()) {
    const pid = getServePid();
    logger.info(`serve daemon already running${pid ? ` (pid ${pid})` : ''}`);
    return;
  }

  const usingUnlockMode = Boolean(options.unlockToken);

  let password: string | null = null;
  let identity: Identity | null = null;
  let signingPrivateKey: Uint8Array | null = null;
  let publicIdentity: PublicIdentity | null = null;
  let registerPermit: string | undefined;
  let enrollmentToken = options.enrollmentToken;

  const loadPasswordFromStdin = async (): Promise<string> => {
    const reader = process.stdin;
    const chunks: Buffer[] = [];

    const onData = (chunk: Buffer) => chunks.push(chunk);
    reader.on('data', onData);

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Timeout reading password from stdin')), 10000);
      const onEnd = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      const onError = (err: Error) => {
        clearTimeout(timeoutId);
        reject(err);
      };
      reader.once('end', onEnd);
      reader.once('error', onError);
    });

    reader.removeListener('data', onData);
    reader.pause();

    const result = Buffer.concat(chunks).toString().trim();
    if (!result) {
      throw new SpacesError('No password provided via stdin', 'USER_ERROR', 1);
    }
    return result;
  };

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
      if (!keypairExists()) {
        throw new NoIdentityError();
      }

      if (options.passwordStdin) {
        password = await loadPasswordFromStdin();
      } else {
        password = await promptPassword('Enter password to unlock identity:');
        if (!password) {
          logger.info('Cancelled');
          return;
        }
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
      env: process.env,
    });

    // Send password via stdin (non-unlock mode)
    if (!usingUnlockMode) {
      child.stdin.write(password ?? '');
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
    if (!keypairExists()) {
      cleanupServeFiles();
      throw new NoIdentityError();
    }

    if (options.passwordStdin) {
      password = await loadPasswordFromStdin();
    } else {
      password = await promptPassword('Enter password to unlock identity:');
      if (!password) {
        logger.info('Cancelled');
        cleanupServeFiles();
        return;
      }
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

  let userRootAuth: UserRootAuthorizationConfig;
  try {
    userRootAuth = await resolveUserRootAuthorizationConfig();
  } catch (error) {
    stopStatusServer();
    cleanupServeFiles();
    throw error;
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
  const relayUrl = options.relay; // No default - must use hosting or explicit --relay

  // If no hosting config and no explicit relay, error out
  if (!hostConfig?.subdomain && !relayUrl) {
    cleanupServeFiles();
    throw new SpacesError(
      'No relay configured.\n\n' +
      'Either set up gitspace.sh hosting:\n' +
      '  gssh user auth login\n' +
      '  gssh user host reserve <subdomain>\n\n' +
      'Or specify a relay explicitly:\n' +
      '  gssh machine serve start --relay ws://localhost:4480/ws',
      'USER_ERROR'
    );
  }

  let localRelayServer: ReturnType<typeof createRelayServer> | null = null;
  let localRelayIdentity: Awaited<ReturnType<typeof loadOrCreateRelayIdentity>> | null = null;
  let effectiveRelayUrl = relayUrl || '';
  let processHostManager: ServeProcessHostManager | null = null;
  let processHostRefreshTimer: ReturnType<typeof setInterval> | null = null;

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
    ensureControlStore();
    bindControlOwner(identity.id);

    // Load or create persistent relay identity for control mode
    localRelayIdentity = await loadOrCreateRelayIdentity('control-relay');
    bindControlRelayIdentity({
      relayIdentityId: localRelayIdentity.id,
      relaySigningPublicKey: localRelayIdentity.signingPublicKey,
      relayFingerprint: formatRelayFingerprint(localRelayIdentity.signingPublicKey),
    });

    // Start local relay server with this machine pre-authorized
    try {
      localRelayServer = createRelayServer({
        port: LOCAL_RELAY_PORT,
        bind: '127.0.0.1',
        identity: localRelayIdentity,
        preAuthorizedMachines: [publicIdentity.signingPublicKey],
      });
      logger.success(`Local relay started on port ${LOCAL_RELAY_PORT}`);
    } catch (error) {
      cleanupServeFiles();
      throw new SpacesError('Failed to start local relay server', 'SYSTEM_ERROR', 2);
    }

    // Start cloudflared tunnel
    const tunnelStarted = await startCloudflared(hostConfig.subdomain);
    if (tunnelStarted) {
      updateDaemonState({
        hosting: {
          subdomain: hostConfig.subdomain,
          tunnelActive: true,
        },
      });
    }

    processHostManager = await startServeProcessHosting(hostConfig);
    if (processHostManager) {
      processHostRefreshTimer = setInterval(() => {
        void processHostManager?.refresh();
      }, SERVE_REFRESH_INTERVAL_MS);
    }

    // Use local relay (machine will authenticate via challenge-response)
    effectiveRelayUrl = `ws://127.0.0.1:${LOCAL_RELAY_PORT}/ws`;
  }

  const remoteSessionOptions = processHostManager
    ? {
        processHostDomain: processHostManager.domain,
        onProcessesChanged: () => processHostManager?.refresh(),
      }
    : undefined;

  // Create session manager
  const sessionManager = new ClientSessionManager({
    relay: effectiveRelayUrl,
    identity,
    remoteSessionOptions,
    ownerUserRootId: userRootAuth.ownerUserRootId,
  });

  // Initialize session manager (starts tmux-lite server)
  await sessionManager.initialize();

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
      case 'client_authenticated':
      case 'client_disconnected':
        updateDaemonState({ clients: sessionManager.establishedSessionCount });
        break;
    }
  };

  sessionManager.onEvent(eventHandler);

  // Connect to relay
  try {
    await connectToRelay(
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
    );
    updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'connected' } });
  } catch (error) {
    localRelayServer?.stop();
    stopCloudflared();
    cleanupServeFiles();
    throw new SpacesError(
      `Failed to connect to relay: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2
    );
  }

  // Save relay config for reconnect/bootstrap flows
  writeRelayConfig({
    relayUrl: effectiveRelayUrl,
    machineId,
    savedAt: Date.now(),
  });

  // Set up shutdown handlers with daemon cleanup
  setupShutdownHandlers(sessionManager, true, () => stopServeProcessHosting(processHostManager, processHostRefreshTimer));

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
