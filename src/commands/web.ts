import { spawn, type Subprocess } from 'bun';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { loadUserRootIdentity, createLocalDeviceCertificate } from '../core/user-identity.js';
import { keypairExists } from '../core/identity.js';
import { getVaultMeta } from '../relay/control/store.js';
import { generateIdentity, serializeIdentity } from '../lib/tmux-lite/crypto/identity.js';
import type { RelayOneTimeBrowserEnrollment } from '../relay/types.js';
import { hasRelayWebUiAssets } from '../relay/server.js';
import { buildLocalRelayUrl, getRelayStatusSnapshot } from './relay.js';
import { isServeRunning, queryServeStatus } from '../serve/daemon.js';
import { openBrowserUrl } from '../utils/open-browser.js';

const DEFAULT_WEB_PORT = 4480;
const RELAY_START_TIMEOUT_MS = 15_000;
const SERVE_START_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface WebCommandOptions {
  port?: number;
  yes?: boolean;
  takeover?: boolean;
  passwordStdin?: boolean;
}

function buildCliCommand(args: string[]): string[] {
  return process.execPath.endsWith('bun')
    ? ['bun', process.argv[1]!, ...args]
    : [process.execPath, ...args];
}

function buildLocalWebUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/?enroll=${encodeURIComponent(token)}`;
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
    response = await fetch(`http://${host}:${port}/__dev_identity`, {
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


  const configuredOwnerUserRootId = getVaultMeta('owner_user_root_id');


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
    const relaySnapshot = getRelayStatusSnapshot();
    let relayWsUrl: string;
    let relayHttpHost: string;
    if (relaySnapshot.running) {
      if (!configuredOwnerUserRootId) {
        throw new SpacesError(
          'The running relay has no owner identity bound. Stop it first so `gssh web` can restart it with your current identity.',
          'USER_ERROR',
          1,
        );
      }
      if (configuredOwnerUserRootId !== userRoot.id) {
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
      relayWsUrl = relaySnapshot.relayUrl;
      relayHttpHost = relaySnapshot.bind === '0.0.0.0' ? '127.0.0.1' : relaySnapshot.bind === '::' ? '::1' : relaySnapshot.bind;
      logger.info(`Reusing local relay on port ${port}`);
    } else {
      logger.info(`Starting local relay on port ${port}...`);
      relayChild = spawn({
        cmd: buildCliCommand(['relay', 'start', '--foreground', '--mode', 'local', '--bind', '127.0.0.1', '--port', String(port), ...(options.yes ? ['--yes'] : []), ...(options.takeover ? ['--takeover'] : [])]),
        cwd: process.cwd(),
        env: process.env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      relayStartedByThisInvocation = true;
      await Promise.race([
        waitForRelayHttpReady(port, RELAY_START_TIMEOUT_MS),
        watchUnexpectedExit(relayChild, 'relay', () => shuttingDown),
      ]);
      relayWsUrl = buildLocalRelayUrl('127.0.0.1', port);
      relayHttpHost = '127.0.0.1';
    }

    if (isServeRunning()) {
      const status = await queryServeStatus();
      if (!status) {
        throw new SpacesError('Serve daemon is running but did not answer its status socket. Stop it and retry.', 'SYSTEM_ERROR', 2);
      }
      if (status.relay.url !== relayWsUrl) {
        throw new SpacesError(
          `Serve daemon is already running against ${status.relay.url}. Stop it first before using \`gssh web\` with ${relayWsUrl}.`,
          'USER_ERROR',
          1,
        );
      }
      if (status.relay.status !== 'connected') {
        logger.info('Waiting for existing serve daemon to connect to relay...');
        await waitForServeReady(relayWsUrl, SERVE_START_TIMEOUT_MS);
      }
      logger.info('Reusing running machine serve daemon');
    } else {
      logger.info('Starting machine serve...');
      serveChild = spawn({
        cmd: buildCliCommand(['machine', 'serve', 'start', '--foreground', '--relay', relayWsUrl, ...(options.passwordStdin ? ['--password-stdin'] : []), ...(options.yes ? ['--yes'] : []), ...(options.takeover ? ['--takeover'] : [])]),
        cwd: process.cwd(),
        env: process.env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      serveStartedByThisInvocation = true;
      await Promise.race([
        waitForServeReady(relayWsUrl, SERVE_START_TIMEOUT_MS),
        watchUnexpectedExit(serveChild, 'machine serve', () => shuttingDown),
      ]);
    }

    const browserIdentity = generateIdentity('Browser Local Web');
    const enrollment: RelayOneTimeBrowserEnrollment = {
      token: crypto.randomUUID(),
      identity: serializeIdentity(browserIdentity),
      deviceCert: await createLocalDeviceCertificate(browserIdentity),
    };
    await registerBrowserEnrollment(relayHttpHost, port, enrollment);

    const browserUrl = buildLocalWebUrl(relayHttpHost, port, enrollment.token);
    logger.success(`Local web UI: ${browserUrl}`);

    const browserResult = await openBrowserUrl(browserUrl);
    if (!browserResult.ok) {
      logger.warning(`Failed to open browser automatically: ${browserResult.message}`);
      logger.log(`Open this URL manually: ${browserUrl}`);
    }

    logger.dim('Press Ctrl+C to stop the local web stack.');

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
