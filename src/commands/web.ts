import { spawn, type Subprocess } from 'bun';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { loadUserRootIdentity, createLocalDeviceCertificate } from '../core/user-identity.js';
import { keypairExists, loadKeypair } from '../core/identity.js';
import { getSpacesDir } from '../core/config.js';
import { getVaultMeta } from '../relay/control/store.js';
import { generateIdentity, serializeIdentity } from '../lib/tmux-lite/crypto/identity.js';
import type { RelayOneTimeBrowserEnrollment } from '../relay/types.js';
import { hasRelayWebUiAssets } from '../relay/server.js';
import { buildLocalRelayUrl, getRelayStatusSnapshot, selectRelaySubdomain } from './relay.js';
import { readHostConfig, resolveRelaySubdomains } from './host.js';
import { isCloudflaredInstalled } from '../utils/cloudflared.js';
import { isServeRunning, queryServeStatus } from '../serve/daemon.js';
import { openBrowserUrl } from '../utils/open-browser.js';
import { ensureDeviceIdentityPassword, createDeviceIdentityPasswordContext } from './device-identity-password.js';
import { fetchRelayIdentity } from './connect.js';
import { ensureServeOwnerBindingForStartup } from './serve.js';

const DEFAULT_WEB_PORT = 4480;
const RELAY_START_TIMEOUT_MS = 15_000;
const HOSTED_RELAY_START_TIMEOUT_MS = 30_000;
const SERVE_START_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface WebCommandOptions {
  port?: number;
  relay?: boolean;
  yes?: boolean;
  takeover?: boolean;
  passwordStdin?: boolean;
}

function buildCliCommand(args: string[]): string[] {
  return process.execPath.endsWith('bun')
    ? ['bun', process.argv[1]!, ...args]
    : [process.execPath, ...args];
}

function buildBrowserUrl(scheme: 'http' | 'https', host: string, port: number, token: string): string {
  const portSuffix = scheme === 'https' ? '' : `:${port}`;
  return `${scheme}://${host}${portSuffix}/?enroll=${encodeURIComponent(token)}`;
}

async function waitForRelayHttpReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(100);
  }

  throw new SpacesError(
    `Timed out waiting for relay on port ${port}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
    'SYSTEM_ERROR',
    2,
  );
}

async function waitForServeReady(expectedRelayUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await queryServeStatus();
    if (status?.relay.url === expectedRelayUrl && status.relay.status === 'connected') {
      return;
    }
    await Bun.sleep(200);
  }

  throw new SpacesError(
    `Timed out waiting for machine serve to connect to ${expectedRelayUrl}`,
    'SYSTEM_ERROR',
    2,
  );
}

async function registerBrowserEnrollment(host: string, port: number, enrollment: RelayOneTimeBrowserEnrollment): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/__enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enrollment),
    });
  } catch (error) {
    throw new SpacesError(
      `Failed to register browser enrollment with local relay: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2,
    );
  }

  if (response.status === 404 || response.status === 405) {
    throw new SpacesError(
      'The running relay does not support one-time browser enrollment registration. Stop it and rerun `gssh web` so it can be restarted with the current code.',
      'USER_ERROR',
      1,
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new SpacesError(
      `Local relay rejected browser enrollment registration (${response.status}): ${detail || 'unknown error'}`,
      'SYSTEM_ERROR',
      2,
    );
  }
}

async function terminateChild(child: Subprocess | null, label: string): Promise<void> {
  if (!child) {
    return;
  }

  logger.info(`Stopping ${label}...`);
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }

  const gracefulExit = await Promise.race([
    child.exited.catch(() => 1),
    Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => null),
  ]);
  if (gracefulExit !== null) {
    return;
  }

  try {
    child.kill('SIGKILL');
    await child.exited.catch(() => 1);
  } catch {
    // Best effort: the process may have exited between SIGTERM and SIGKILL.
  }
}

function watchUnexpectedExit(child: Subprocess, label: string, isShuttingDown: () => boolean): Promise<never> {
  return new Promise((_, reject) => {
    child.exited.then((code) => {
      if (isShuttingDown()) {
        return;
      }
      reject(new SpacesError(describeUnexpectedExit(label, code, child.signalCode ?? null), 'SYSTEM_ERROR', 2));
    }).catch((error) => {
      if (isShuttingDown()) {
        return;
      }
      reject(new SpacesError(`Failed while waiting for ${label}: ${error instanceof Error ? error.message : String(error)}`, 'SYSTEM_ERROR', 2));
    });
  });
}

function describeUnexpectedExit(label: string, code: number, signalCode: NodeJS.Signals | null): string {
  const signalDetail = signalCode === null ? '' : ` (signal ${signalCode})`;
  return `${label} exited unexpectedly with code ${code}${signalDetail}`;
}

// ============================================================================
// Relay startup strategies
// ============================================================================

interface RelayResult {
  relayWsUrl: string;
  relayHttpHost: string;
  browserHost: string;
  browserScheme: 'http' | 'https';
  enrollment: RelayOneTimeBrowserEnrollment | null;
  child: Subprocess | null;
  started: boolean;
}

async function startHostedRelay(
  port: number,
  options: WebCommandOptions,
  shuttingDown: () => boolean,
): Promise<RelayResult> {
  const relaySnapshot = getRelayStatusSnapshot();
  if (relaySnapshot.running) {
    throw new SpacesError(
      'A relay is already running. Stop it with `gssh relay stop` first — `gssh web --relay` needs to start its own relay with the enrollment payload pre-configured.',
      'USER_ERROR',
      1,
    );
  }

  if (!await isCloudflaredInstalled()) {
    throw new SpacesError(
      'cloudflared is required for `gssh web --relay`. Install it with: brew install cloudflared',
      'USER_ERROR',
      1,
    );
  }

  const hostConfig = readHostConfig();
  const subdomains = await resolveRelaySubdomains(hostConfig);
  if (subdomains.length === 0) {
    throw new SpacesError(
      'No gitspace.sh subdomain configured. Set one up first:\n\n  gssh user auth login\n  gssh user host reserve <name>',
      'USER_ERROR',
      1,
    );
  }
  const subdomain = await selectRelaySubdomain(subdomains, {
    primarySubdomain: hostConfig?.subdomain,
    interactive: Boolean(process.stdout.isTTY && process.stdin.isTTY),
  });
  if (!subdomain) {
    throw new SpacesError('No subdomain selected. Cannot start hosted relay.', 'USER_ERROR', 1);
  }

  // Generate browser enrollment and write to a temp file for the relay
  // child to consume at startup (POST is blocked on hosted relays).
  const browserIdentity = generateIdentity('Browser Local Web');
  const enrollment: RelayOneTimeBrowserEnrollment = {
    token: crypto.randomUUID(),
    identity: serializeIdentity(browserIdentity),
    deviceCert: await createLocalDeviceCertificate(browserIdentity),
  };
  const runtimeDir = join(getSpacesDir(), '.relay', 'runtime');
  if (!existsSync(runtimeDir)) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  }
  const enrollmentFilePath = join(runtimeDir, `enroll-${process.pid}.json`);
  writeFileSync(enrollmentFilePath, JSON.stringify(enrollment), { mode: 0o600 });

  logger.info(`Starting hosted relay on port ${port} with tunnel to ${subdomain}.gitspace.sh...`);
  const child = spawn({
    cmd: buildCliCommand([
      'relay', 'start', '--foreground', '--mode', 'hosted', '--port', String(port),
      ...(options.yes ? ['--yes'] : []),
      ...(options.takeover ? ['--takeover'] : []),
    ]),
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITSPACE_RELAY_SELECTED_SUBDOMAIN: subdomain,
      GITSPACE_RELAY_SELECTED_HOSTNAME: `${subdomain}.gitspace.sh`,
      GITSPACE_RELAY_ENROLLMENT_FILE: enrollmentFilePath,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await Promise.race([
    waitForRelayHttpReady(port, HOSTED_RELAY_START_TIMEOUT_MS),
    watchUnexpectedExit(child, 'relay', shuttingDown),
  ]);

  return {
    relayWsUrl: buildLocalRelayUrl('0.0.0.0', port),
    relayHttpHost: '127.0.0.1',
    browserHost: `${subdomain}.gitspace.sh`,
    browserScheme: 'https',
    enrollment,
    child,
    started: true,
  };
}

function resolveBindHost(bind: string): string {
  if (bind === '0.0.0.0') return '127.0.0.1';
  if (bind === '::') return '::1';
  return bind;
}

async function startOrReuseLocalRelay(
  port: number,
  userRootId: string,
  options: WebCommandOptions,
  shuttingDown: () => boolean,
): Promise<RelayResult> {
  const relaySnapshot = getRelayStatusSnapshot();
  const configuredOwnerUserRootId = getVaultMeta('owner_user_root_id');

  if (relaySnapshot.running) {
    // Refuse to reuse a hosted relay in local-only mode.
    if (relaySnapshot.hostname) {
      throw new SpacesError(
        'A hosted relay is running. Stop it with `gssh relay stop` first, or use `gssh web --relay` to start a hosted web stack.',
        'USER_ERROR',
        1,
      );
    }
    if (!configuredOwnerUserRootId) {
      throw new SpacesError(
        'The running relay has no owner identity bound. Stop it first so `gssh web` can restart it with your current identity.',
        'USER_ERROR',
        1,
      );
    }
    if (configuredOwnerUserRootId !== userRootId) {
      throw new SpacesError(
        'The running relay is bound to a different user root identity. Stop it first, or recover the original identity before using `gssh web`.',
        'USER_ERROR',
        1,
      );
    }
    if (relaySnapshot.port !== port) {
      throw new SpacesError(
        `Relay is already running on port ${relaySnapshot.port}. Stop it first or rerun \`gssh web --port ${relaySnapshot.port}\` to reuse it.`,
        'USER_ERROR',
        1,
      );
    }
    if (!relaySnapshot.bind || !relaySnapshot.relayUrl) {
      throw new SpacesError('Relay runtime state is incomplete. Stop the relay and retry.', 'SYSTEM_ERROR', 2);
    }

    const host = resolveBindHost(relaySnapshot.bind);
    logger.info(`Reusing local relay on port ${port}`);
    return {
      relayWsUrl: relaySnapshot.relayUrl,
      relayHttpHost: host,
      browserHost: host,
      browserScheme: 'http',
      enrollment: null,
      child: null,
      started: false,
    };
  }

  logger.info(`Starting local relay on port ${port}...`);
  const child = spawn({
    cmd: buildCliCommand([
      'relay', 'start', '--foreground', '--mode', 'local', '--bind', '127.0.0.1', '--port', String(port),
      ...(options.yes ? ['--yes'] : []),
      ...(options.takeover ? ['--takeover'] : []),
    ]),
    cwd: process.cwd(),
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await Promise.race([
    waitForRelayHttpReady(port, RELAY_START_TIMEOUT_MS),
    watchUnexpectedExit(child, 'relay', shuttingDown),
  ]);

  return {
    relayWsUrl: buildLocalRelayUrl('127.0.0.1', port),
    relayHttpHost: '127.0.0.1',
    browserHost: '127.0.0.1',
    browserScheme: 'http',
    enrollment: null,
    child,
    started: true,
  };
}

// ============================================================================
// Main entry point
// ============================================================================

export async function startLocalWeb(options: WebCommandOptions = {}): Promise<void> {
  const port = options.port ?? DEFAULT_WEB_PORT;

  if (!await hasRelayWebUiAssets()) {
    throw new SpacesError(
      'Web UI assets not found. Build them with: bun run build:web',
      'USER_ERROR',
      1,
    );
  }

  const userRoot = await loadUserRootIdentity();
  if (!userRoot) {
    throw new SpacesError(
      'User root identity is required for `gssh web`. Run `gssh user identity init` or `gssh user identity recover` first.',
      'USER_ERROR',
      1,
    );
  }

  if (!keypairExists()) {
    throw new SpacesError(
      'Local device identity is required for `gssh web`. Run `gssh user auth login` or create a device identity before starting the local web stack.',
      'USER_ERROR',
      1,
    );
  }

  // Resolve the device identity password now (interactive prompt if needed)
  // so we can pipe it to the serve child process and avoid buried prompts.
  const devicePasswordContext = createDeviceIdentityPasswordContext({ passwordStdin: options.passwordStdin });
  const password = await ensureDeviceIdentityPassword({ yes: options.yes }, devicePasswordContext);
  if (!password) {
    logger.info('Cancelled');
    return;
  }

  // Validate password early so we don't start relay/tunnel only to discover
  // a bad password when serve tries to unlock.
  const loadedIdentity = await loadKeypair(password);
  if (!loadedIdentity) {
    throw new SpacesError('Failed to unlock identity. Check your password.', 'USER_ERROR', 1);
  }

  let relayStartedByThisInvocation = false;
  let serveStartedByThisInvocation = false;
  let relayChild: Subprocess | null = null;
  let serveChild: Subprocess | null = null;
  let shuttingDown = false;
  let signalResolve: (() => void) | null = null;

  const shutdownPromise = new Promise<void>((resolve) => {
    signalResolve = resolve;
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (serveStartedByThisInvocation) {
      await terminateChild(serveChild, 'machine serve');
    }
    if (relayStartedByThisInvocation) {
      await terminateChild(relayChild, 'relay');
    }
  };

  const onSignal = (): void => {
    signalResolve?.();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // Phase 1: Start or reuse relay.
    const relay = options.relay
      ? await startHostedRelay(port, options, () => shuttingDown)
      : await startOrReuseLocalRelay(port, userRoot.id, options, () => shuttingDown);

    relayChild = relay.child;
    relayStartedByThisInvocation = relay.started;
    let enrollment = relay.enrollment;

    // Phase 2: Start or reuse machine serve.
    if (isServeRunning()) {
      const status = await queryServeStatus();
      if (!status) {
        throw new SpacesError('Serve daemon is running but did not answer its status socket. Stop it and retry.', 'SYSTEM_ERROR', 2);
      }
      if (status.relay.url !== relay.relayWsUrl) {
        throw new SpacesError(
          `Serve daemon is already running against ${status.relay.url}. Stop it first before using \`gssh web\` with ${relay.relayWsUrl}.`,
          'USER_ERROR',
          1,
        );
      }
      if (status.relay.status !== 'connected') {
        logger.info('Waiting for existing serve daemon to connect to relay...');
        await waitForServeReady(relay.relayWsUrl, SERVE_START_TIMEOUT_MS);
      }
      logger.info('Reusing running machine serve daemon');
    } else {
      // Pre-verify relay trust and owner binding in the supervisor so the
      // serve child can skip interactive prompts (GITSPACE_SKIP_OWNER_BINDING_CHECK).
      const relayIdentity = await fetchRelayIdentity(relay.relayWsUrl);
      await ensureServeOwnerBindingForStartup(userRoot.id, {
        takeover: options.takeover,
        yes: true,
        currentRelay: relayIdentity,
      });

      logger.info('Starting machine serve...');
      serveChild = spawn({
        cmd: buildCliCommand([
          'machine', 'serve', 'start', '--foreground', '--relay', relay.relayWsUrl,
          '--relay-pubkey', relayIdentity.publicKey,
          '--password-stdin',
          '--yes',
        ]),
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITSPACE_SKIP_OWNER_BINDING_CHECK: '1',
        },
        stdin: 'pipe',
        stdout: 'inherit',
        stderr: 'inherit',
      });

      const serveStdin = serveChild.stdin as import('bun').FileSink;
      serveStdin.write(password);
      serveStdin.end();

      serveStartedByThisInvocation = true;
      await Promise.race([
        waitForServeReady(relay.relayWsUrl, SERVE_START_TIMEOUT_MS),
        watchUnexpectedExit(serveChild, 'machine serve', () => shuttingDown),
      ]);
    }

    // Phase 3: Register enrollment (unless already seeded via config file
    // in the hosted relay path).
    if (!enrollment) {
      const browserIdentity = generateIdentity('Browser Local Web');
      enrollment = {
        token: crypto.randomUUID(),
        identity: serializeIdentity(browserIdentity),
        deviceCert: await createLocalDeviceCertificate(browserIdentity),
      };
      await registerBrowserEnrollment(relay.relayHttpHost, port, enrollment);
    }

    // Phase 4: Open browser.
    const browserUrl = buildBrowserUrl(relay.browserScheme, relay.browserHost, port, enrollment.token);
    logger.success(`Local web UI: ${browserUrl}`);

    const browserResult = await openBrowserUrl(browserUrl);
    if (!browserResult.ok) {
      logger.warning(`Failed to open browser automatically: ${browserResult.message}`);
      logger.log(`Open this URL manually: ${browserUrl}`);
    }

    logger.dim('Press Ctrl+C to stop the local web stack.');

    // Phase 5: Wait until interrupted or a child exits unexpectedly.
    const childFailures: Array<Promise<never>> = [];
    if (relayChild) {
      childFailures.push(watchUnexpectedExit(relayChild, 'relay', () => shuttingDown));
    }
    if (serveChild) {
      childFailures.push(watchUnexpectedExit(serveChild, 'machine serve', () => shuttingDown));
    }

    if (childFailures.length === 0) {
      await shutdownPromise;
    } else {
      await Promise.race([shutdownPromise, ...childFailures]);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await shutdown();
  }
}
