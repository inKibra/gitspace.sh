import { input } from '@inquirer/prompts';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { getPublicKeyWithoutPassword, keypairExists, readRelayConfig } from '../core/identity.js';
import {
  queryControlMeta,
  queryServeStatus,
  sendAssertOwnerCommand,
  sendListCloudWorkspacesCommand,
} from '../serve/daemon.js';
import { readHostConfig } from './host.js';
import {
  clearSpritesToken,
  getSpritesToken,
  setSpritesToken,
} from '../relay/control/provider-config.js';
import {
  assertControlOwner,
  bindControlRelayIdentity,
  createCloudBootstrapToken,
  createCloudUnlockToken,
  getCloudWorkspace,
  logCloudEvent,
  markCloudBootstrapVmCreated,
  readControlMeta,
  tombstoneCloudWorkspace,
  updateCloudWorkspaceStatus,
  upsertCloudWorkspace,
} from '../relay/control/store.js';
import { formatRelayFingerprint, getRelayPublicIdentity } from '../relay/identity.js';
import { SpritesProvider } from '../relay/control/sprites-provider.js';
import { ensureWorkspaceIdentity, getWorkspaceIdentity } from '../relay/control/workspace-identity.js';

function requireLocalIdentityId(): string {
  if (!keypairExists()) {
    throw new SpacesError(
      'No local identity found. Initialize identity first:\n  gssh identity init',
      'USER_ERROR',
      1
    );
  }

  const localIdentity = getPublicKeyWithoutPassword();
  if (!localIdentity) {
    throw new SpacesError(
      'Failed to read local identity.',
      'SYSTEM_ERROR',
      2
    );
  }

  return localIdentity.id;
}

interface CloudBootstrapRelayInfo {
  relayUrl: string;
  relaySigningPublicKey: string;
  relayFingerprint: string;
}

function resolveCloudBootstrapRelayInfo(ownerIdentityId: string): CloudBootstrapRelayInfo {
  const hostConfig = readHostConfig();
  const relayConfig = readRelayConfig();

  // External URL for hosted mode, saved relay URL for explicit relay mode.
  const relayUrl = hostConfig?.subdomain
    ? `wss://${hostConfig.subdomain}.gitspace.sh/ws`
    : relayConfig?.relayUrl;

  if (!relayUrl) {
    throw new SpacesError(
      'No relay URL found for cloud bootstrap. Start `gssh serve start` once (or configure hosting) before launching cloud workspaces.',
      'USER_ERROR',
      1
    );
  }

  const controlMeta = readControlMeta();
  if (
    controlMeta.relayIdentityId &&
    controlMeta.relaySigningPublicKey &&
    controlMeta.relayFingerprint
  ) {
    return {
      relayUrl,
      relaySigningPublicKey: controlMeta.relaySigningPublicKey,
      relayFingerprint: controlMeta.relayFingerprint,
    };
  }

  const relayPublicIdentity = getRelayPublicIdentity();
  if (!relayPublicIdentity) {
    throw new SpacesError(
      'Relay identity is not initialized yet. Start `gssh serve start` (hosted mode) to initialize and pin relay identity first.',
      'USER_ERROR',
      1
    );
  }

  const relayFingerprint = formatRelayFingerprint(relayPublicIdentity.signingPublicKey);
  bindControlRelayIdentity({
    relayIdentityId: relayPublicIdentity.id,
    relaySigningPublicKey: relayPublicIdentity.signingPublicKey,
    relayFingerprint,
  });

  // Keep owner assertion strict whenever we bind relay metadata from launch path.
  assertControlOwner(ownerIdentityId);

  return {
    relayUrl,
    relaySigningPublicKey: relayPublicIdentity.signingPublicKey,
    relayFingerprint,
  };
}

export async function cloudStatus(): Promise<void> {
  const serveStatus = await queryServeStatus();
  if (!serveStatus) {
    throw new SpacesError(
      'Serve daemon is not running. Start it with:\n  gssh serve start',
      'USER_ERROR',
      1
    );
  }

  const controlMeta = await queryControlMeta();

  logger.log('');
  logger.bold('Cloud Control Status');
  logger.log('');
  logger.log(`  Serve PID:     ${serveStatus.pid}`);
  logger.log(`  Relay:         ${serveStatus.relay.url}`);
  logger.log(`  Relay status:  ${serveStatus.relay.status}`);

  if (!controlMeta) {
    logger.warning('  Control mode:  unavailable (no control metadata)');
    logger.log('');
    return;
  }

  logger.success('  Control mode:  active');
  logger.log(`  Schema:        v${controlMeta.schemaVersion}`);
  logger.log(`  Owner ID:      ${controlMeta.ownerIdentityId ?? '(unbound)'}`);
  logger.log(`  Relay ID:      ${controlMeta.relayIdentityId ?? '(unbound)'}`);
  logger.log(`  Relay FP:      ${controlMeta.relayFingerprint ?? '(unbound)'}`);
  logger.log(`  Updated:       ${controlMeta.updatedAt}`);

  if (keypairExists()) {
    const localIdentity = getPublicKeyWithoutPassword();
    if (localIdentity) {
      const ownerAssertion = await sendAssertOwnerCommand(localIdentity.id);
      logger.log(`  Local identity:${localIdentity.id}`);
      logger.log(`  Owner access:  ${ownerAssertion.success ? 'yes' : `no (${ownerAssertion.error ?? 'not owner'})`}`);
    }
  }

  logger.log('');
}

export async function cloudSetup(): Promise<void> {
  logger.log('');
  logger.bold('Cloud Provider Setup');
  logger.log('');

  const existing = await getSpritesToken();
  if (existing) {
    const masked = `${existing.slice(0, 6)}${'*'.repeat(Math.max(0, existing.length - 10))}${existing.slice(-4)}`;
    logger.log(`  Current Sprites token: ${masked}`);
    logger.log('');
  }

  const token = await input({
    message: 'Enter your Sprites.dev API token:',
    validate: (value) => {
      if (!value || !value.trim()) return 'Token cannot be empty';
      return true;
    },
  });

  await setSpritesToken(token);

  logger.log('');
  logger.success('  Sprites token saved to keychain.');
  logger.log('');
  logger.dim('  Run `gssh cloud status` to verify the control setup.');
  logger.log('');
}

export async function cloudSetupClear(): Promise<void> {
  const removed = await clearSpritesToken();
  logger.log('');
  if (removed) {
    logger.success('  Sprites token cleared from keychain.');
  } else {
    logger.dim('  No Sprites token was stored.');
  }
  logger.log('');
}

export interface CloudLaunchOptions {
  repo: string;
  branch?: string;
  image?: string;
}

export async function cloudLaunch(options: CloudLaunchOptions): Promise<void> {
  const { repo, branch = 'main', image } = options;

  // 1. Require identity
  const identityId = requireLocalIdentityId();

  // 2. Assert owner (reads control store directly — no daemon required for launch)
  assertControlOwner(identityId);

  // 3. Require Sprites token
  const token = await getSpritesToken();
  if (!token) {
    throw new SpacesError(
      'No Sprites token configured. Run:\n  gssh cloud setup',
      'USER_ERROR',
      1
    );
  }

  // 4. Resolve relay bootstrap info and generate a local workspace ID
  const relayInfo = resolveCloudBootstrapRelayInfo(identityId);
  const workspaceId = `ws-${randomUUID().slice(0, 8)}`;
  const appId = `gssh-${identityId.slice(0, 12)}`;
  const workspaceIdentity = await ensureWorkspaceIdentity(workspaceId);

  logger.log(`  Relay URL:  ${relayInfo.relayUrl}`);
  logger.log(`  Relay FP:   ${relayInfo.relayFingerprint}`);
  logger.log('');
  logger.bold('Launching Cloud Workspace');
  logger.log('');
  logger.log(`  Workspace:  ${workspaceId}`);
  logger.log(`  Repo:       ${repo}`);
  logger.log(`  Branch:     ${branch}`);
  logger.log('');

  // 5. Create workspace record (bootstrapping state)
  upsertCloudWorkspace({
    id: workspaceId,
    provider: 'sprites',
    providerWorkspaceId: '',  // filled in after API call
    machineId: workspaceIdentity.id,
    machinePublicKey: workspaceIdentity.signingPublicKey,
    repo,
    branch,
    status: 'bootstrapping',
  });

  const bootstrap = createCloudBootstrapToken({
    workspaceId,
    ownerIdentityId: identityId,
  });

  logCloudEvent({
    workspaceId,
    eventType: 'launch_started',
    message: `Launching workspace for ${repo}@${branch}`,
    metadata: {
      identityId,
      repo,
      branch,
      relayUrl: relayInfo.relayUrl,
      relayFingerprint: relayInfo.relayFingerprint,
      bootstrapTokenId: bootstrap.tokenId,
      bootstrapExpiresAt: bootstrap.expiresAt,
    },
  });

  // 6. Call Sprites API
  const provider = new SpritesProvider({ token, appId });
  let providerResult: Awaited<ReturnType<SpritesProvider['createWorkspace']>>;

  try {
    logger.dim('  Creating Sprites VM...');
    providerResult = await provider.createWorkspace({
      name: workspaceId,
      repo,
      branch,
      image,
      env: {
        GSSH_BOOTSTRAP_TOKEN: bootstrap.token,
        GSSH_BOOTSTRAP_TOKEN_ID: bootstrap.tokenId,
        GSSH_WORKSPACE_ID: workspaceId,
        GSSH_OWNER_IDENTITY_ID: identityId,
        GSSH_RELAY_URL: relayInfo.relayUrl,
        GSSH_RELAY_PUBKEY: relayInfo.relaySigningPublicKey,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    upsertCloudWorkspace({
      id: workspaceId,
      provider: 'sprites',
      providerWorkspaceId: '',
      repo,
      branch,
      status: 'error',
      error: msg,
    });
    logCloudEvent({ workspaceId, eventType: 'launch_failed', message: msg });
    throw new SpacesError(`Failed to create Sprites VM: ${msg}`, 'SYSTEM_ERROR', 2);
  }

  // 7. Persist provider ID and bootstrap state
  upsertCloudWorkspace({
    id: workspaceId,
    provider: 'sprites',
    providerWorkspaceId: providerResult.providerWorkspaceId,
    repo,
    branch,
    status: 'bootstrapping',
  });

  markCloudBootstrapVmCreated(workspaceId);

  logCloudEvent({
    workspaceId,
    eventType: 'vm_created',
    message: `Sprites VM created`,
    metadata: {
      spriteId: providerResult.providerWorkspaceId,
      rawState: providerResult.rawState,
      bootstrapTokenId: bootstrap.tokenId,
      relayUrl: relayInfo.relayUrl,
    },
  });

  try {
    await runWorkspaceBootstrapExec(
      provider,
      providerResult.providerWorkspaceId,
      workspaceId,
      relayInfo,
      'launch',
      bootstrap.token
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateCloudWorkspaceStatus(workspaceId, 'error', msg);
    logCloudEvent({ workspaceId, eventType: 'launch_exec_failed', message: msg });
    throw new SpacesError(`Workspace VM created, but bootstrap command failed: ${msg}`, 'SYSTEM_ERROR', 2);
  }

  logger.log('');
  logger.success(`  Workspace launched: ${workspaceId}`);
  logger.log(`  Sprite ID:          ${providerResult.providerWorkspaceId}`);
  logger.log(`  Bootstrap token ID: ${bootstrap.tokenId}`);
  logger.log(`  Bootstrap expires:  ${bootstrap.expiresAt}`);
  logger.log(`  Status:             bootstrapping`);
  logger.log('');
  logger.dim('  The VM should bootstrap and connect back to the relay using the one-time token.');
  logger.dim('  Run `gssh cloud list` to track progress.');
  logger.log('');
}

// ── Provider interface for DI ─────────────────────────────────────────────────

/** Minimal interface for lifecycle operations — satisfied by SpritesProvider. */
export interface CloudLifecycleProvider {
  stopWorkspace(id: string): Promise<{ providerWorkspaceId: string; status: import('../relay/control/types.js').CloudWorkspaceStatus; rawState: string }>;
  resumeWorkspace(id: string): Promise<{ providerWorkspaceId: string; status: import('../relay/control/types.js').CloudWorkspaceStatus; rawState: string }>;
  execWorkspaceCommand(
    id: string,
    options: { command: string[]; env?: Record<string, string>; dir?: string }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  destroyWorkspace(id: string): Promise<void>;
}

// ── Shared provider factory ───────────────────────────────────────────────────

async function makeSpritesProvider(identityId: string): Promise<SpritesProvider> {
  assertControlOwner(identityId);

  const token = await getSpritesToken();
  if (!token) {
    throw new SpacesError(
      'No Sprites token configured. Run:\n  gssh cloud setup',
      'USER_ERROR',
      1
    );
  }

  // appId mirrors what launch uses
  const appId = `gssh-${identityId.slice(0, 12)}`;
  return new SpritesProvider({ token, appId });
}

function requireWorkspace(workspaceId: string) {
  const ws = getCloudWorkspace(workspaceId);
  if (!ws) {
    throw new SpacesError(
      `Workspace '${workspaceId}' not found in control store.`,
      'USER_ERROR',
      1
    );
  }
  return ws;
}

function buildSpriteServeStartCommand(): string[] {
  const script = [
    'set -eu',
    'if command -v npm >/dev/null 2>&1; then',
    '  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"',
    '  NPM_ROOT="$(npm root -g 2>/dev/null || true)"',
    '  NPM_BIN=""',
    '  if [ -z "$NPM_PREFIX" ] && [ -n "$NPM_ROOT" ]; then',
    '    NPM_PREFIX="$(dirname "$(dirname "$NPM_ROOT")")"',
    '  fi',
    '  if [ -n "$NPM_PREFIX" ]; then',
    '    NPM_BIN="$NPM_PREFIX/bin"',
    '  fi',
    '  if [ -n "$NPM_BIN" ]; then',
    '    export PATH="$NPM_BIN:$PATH"',
    '  fi',
    'fi',
    'if ! command -v gssh >/dev/null 2>&1; then',
    '  if command -v npm >/dev/null 2>&1; then',
    '    npm install -g gitspace >/tmp/gssh-install.log 2>&1 || { cat /tmp/gssh-install.log >&2; exit 127; }',
    '    NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"',
    '    NPM_ROOT="$(npm root -g 2>/dev/null || true)"',
    '    NPM_BIN=""',
    '    if [ -z "$NPM_PREFIX" ] && [ -n "$NPM_ROOT" ]; then',
    '      NPM_PREFIX="$(dirname "$(dirname "$NPM_ROOT")")"',
    '    fi',
    '    if [ -n "$NPM_PREFIX" ]; then',
    '      NPM_BIN="$NPM_PREFIX/bin"',
    '    fi',
    '    if [ -n "$NPM_BIN" ]; then',
    '      export PATH="$NPM_BIN:$PATH"',
    '    fi',
  '  fi',
    'fi',
    'if ! command -v gssh >/dev/null 2>&1; then',
    '  echo "gssh CLI not found in sprite image and auto-install failed" >&2',
    '  exit 127',
    'fi',
    'if pgrep -f "[g]ssh serve" >/dev/null 2>&1; then',
    '  if [ -n "${GSSH_UNLOCK_TOKEN:-}" ]; then',
    '    gssh serve stop >/dev/null 2>&1 || true',
    '  else',
    '    echo "gssh serve already running"',
    '    exit 0',
    '  fi',
    'fi',
    'if [ -z "${GSSH_RELAY_URL:-}" ]; then',
    '  echo "GSSH_RELAY_URL is required" >&2',
    '  exit 1',
    'fi',
    'if [ -z "${GSSH_RELAY_PUBKEY:-}" ]; then',
    '  echo "GSSH_RELAY_PUBKEY is required" >&2',
    '  exit 1',
    'fi',
    'if [ -n "${GSSH_UNLOCK_TOKEN:-}" ]; then',
    '  gssh serve start --relay "$GSSH_RELAY_URL" --relay-pubkey "$GSSH_RELAY_PUBKEY" --workspace-id "$GSSH_WORKSPACE_ID" --unlock-token "$GSSH_UNLOCK_TOKEN" --ignore-keychain-and-skip-secrets',
    'else',
    '  gssh serve start --relay "$GSSH_RELAY_URL" --relay-pubkey "$GSSH_RELAY_PUBKEY" --ignore-keychain-and-skip-secrets',
    'fi',
  ].join('\n');

  return ['bash', '-lc', script];
}

async function runWorkspaceBootstrapExec(
  provider: CloudLifecycleProvider,
  providerWorkspaceId: string,
  workspaceId: string,
  relayInfo: CloudBootstrapRelayInfo,
  phase: 'launch' | 'resume',
  bootstrapToken?: string
): Promise<void> {
  logCloudEvent({
    workspaceId,
    eventType: `${phase}_exec_started`,
    message: 'Running bootstrap command via Sprites exec',
  });

  const command = buildSpriteServeStartCommand();
  const env: Record<string, string> = {
    GSSH_WORKSPACE_ID: workspaceId,
    GSSH_RELAY_URL: relayInfo.relayUrl,
    GSSH_RELAY_PUBKEY: relayInfo.relaySigningPublicKey,
  };
  if (bootstrapToken) {
    env.GSSH_UNLOCK_TOKEN = bootstrapToken;
  }

  const execResult = await provider.execWorkspaceCommand(providerWorkspaceId, {
    command,
    env,
    dir: '/home/sprite',
  });

  logCloudEvent({
    workspaceId,
    eventType: `${phase}_exec_succeeded`,
    message: 'Bootstrap command executed successfully',
    metadata: {
      exitCode: execResult.exitCode,
      stdout: execResult.stdout.slice(0, 400),
      stderr: execResult.stderr.slice(0, 400),
    },
  });
}

// ── cloud stop ────────────────────────────────────────────────────────────────

export async function cloudStop(
  workspaceId: string,
  injectedProvider?: CloudLifecycleProvider
): Promise<void> {
  const identityId = requireLocalIdentityId();
  const provider = injectedProvider ?? await makeSpritesProvider(identityId);
  const ws = requireWorkspace(workspaceId);

  logger.log('');
  logger.log(`Stopping workspace ${workspaceId}...`);

  try {
    const result = await provider.stopWorkspace(ws.providerWorkspaceId);
    updateCloudWorkspaceStatus(workspaceId, result.status);
    logCloudEvent({
      workspaceId,
      eventType: 'workspace_stopped',
      message: `Workspace stopped`,
      metadata: { rawState: result.rawState },
    });
    logger.log('');
    logger.success(`  Workspace ${workspaceId} stopped (status: ${result.status}).`);
    logger.log('');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateCloudWorkspaceStatus(workspaceId, 'error', msg);
    logCloudEvent({ workspaceId, eventType: 'stop_failed', message: msg });
    throw new SpacesError(`Failed to stop workspace: ${msg}`, 'SYSTEM_ERROR', 2);
  }
}

// ── cloud resume ──────────────────────────────────────────────────────────────

export async function cloudResume(
  workspaceId: string,
  injectedProvider?: CloudLifecycleProvider
): Promise<void> {
  const identityId = requireLocalIdentityId();
  const provider = injectedProvider ?? await makeSpritesProvider(identityId);
  const ws = requireWorkspace(workspaceId);
  const relayInfo = resolveCloudBootstrapRelayInfo(identityId);

  if (!injectedProvider) {
    const storedIdentity = await getWorkspaceIdentity(workspaceId);
    if (!storedIdentity) {
      throw new SpacesError(
        `No escrowed workspace identity found for '${workspaceId}'. This workspace cannot be resumed securely.`,
        'USER_ERROR',
        1
      );
    }
  }

  const unlock = createCloudUnlockToken({
    workspaceId,
    ownerIdentityId: identityId,
  });

  logger.log('');
  logger.log(`Resuming workspace ${workspaceId}...`);

  try {
    const result = await provider.resumeWorkspace(ws.providerWorkspaceId);
    updateCloudWorkspaceStatus(workspaceId, result.status === 'ready' ? 'bootstrapping' : result.status);
    logCloudEvent({
      workspaceId,
      eventType: 'workspace_resumed',
      message: `Workspace resumed`,
      metadata: {
        rawState: result.rawState,
        unlockTokenId: unlock.tokenId,
      },
    });

    try {
      await runWorkspaceBootstrapExec(
        provider,
        ws.providerWorkspaceId,
        workspaceId,
        relayInfo,
        'resume',
        unlock.token
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      updateCloudWorkspaceStatus(workspaceId, 'error', msg);
      logCloudEvent({ workspaceId, eventType: 'resume_exec_failed', message: msg });
      throw new SpacesError(`Failed to run resume bootstrap command: ${msg}`, 'SYSTEM_ERROR', 2);
    }

    logger.log('');
    logger.success(`  Workspace ${workspaceId} resumed (status: bootstrapping).`);
    logger.log('');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateCloudWorkspaceStatus(workspaceId, 'error', msg);
    logCloudEvent({ workspaceId, eventType: 'resume_failed', message: msg });
    throw new SpacesError(`Failed to resume workspace: ${msg}`, 'SYSTEM_ERROR', 2);
  }
}

// ── cloud destroy ─────────────────────────────────────────────────────────────

export async function cloudDestroy(
  workspaceId: string,
  injectedProvider?: CloudLifecycleProvider
): Promise<void> {
  const identityId = requireLocalIdentityId();
  const provider = injectedProvider ?? await makeSpritesProvider(identityId);
  const ws = requireWorkspace(workspaceId);

  logger.log('');
  logger.log(`Destroying workspace ${workspaceId}...`);

  try {
    await provider.destroyWorkspace(ws.providerWorkspaceId);
  } catch (error) {
    // Best-effort: if the VM is already gone on Sprites side, still tombstone locally.
    const msg = error instanceof Error ? error.message : String(error);
    logCloudEvent({ workspaceId, eventType: 'destroy_provider_error', message: msg });
  }

  tombstoneCloudWorkspace(workspaceId);
  logCloudEvent({
    workspaceId,
    eventType: 'workspace_destroyed',
    message: `Workspace tombstoned`,
  });

  logger.log('');
  logger.success(`  Workspace ${workspaceId} destroyed.`);
  logger.log('');
}

export async function cloudList(): Promise<void> {
  const serveStatus = await queryServeStatus();
  if (!serveStatus) {
    throw new SpacesError(
      'Serve daemon is not running. Start it with:\n  gssh serve start',
      'USER_ERROR',
      1
    );
  }

  const identityId = requireLocalIdentityId();
  const workspacesResult = await sendListCloudWorkspacesCommand(identityId);

  if (!workspacesResult.success) {
    throw new SpacesError(
      workspacesResult.error ?? 'Failed to list cloud workspaces.',
      'USER_ERROR',
      1
    );
  }

  const workspaces = workspacesResult.workspaces ?? [];

  logger.log('');
  logger.bold('Cloud Workspaces');
  logger.log('');

  if (workspaces.length === 0) {
    logger.dim('  No cloud workspaces found.');
    logger.log('');
    return;
  }

  for (const workspace of workspaces) {
    logger.log(`  ${workspace.id}`);
    logger.log(`    Provider: ${workspace.provider}`);
    logger.log(`    Status:   ${workspace.status}`);
    if (workspace.repo) {
      logger.log(`    Repo:     ${workspace.repo}`);
    }
    if (workspace.branch) {
      logger.log(`    Branch:   ${workspace.branch}`);
    }
    logger.log(`    Updated:  ${workspace.updatedAt}`);
    if (workspace.error) {
      logger.warning(`    Error:    ${workspace.error}`);
    }
  }

  logger.log('');
}
