import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { promptInput } from '../utils/prompts.js';
import { readRelayConfig } from '../core/identity.js';
import { isCloudReachableRelayUrl } from '../core/trusted-relays.js';
import { loadUserRootIdentity } from '../core/user-identity.js';
import {
  queryControlMeta,
  queryServeStatus,
  sendAssertOwnerCommand,
  sendListCloudWorkspacesCommand,
} from '../serve/daemon.js';
import {
  clearSpritesToken,
  getSpritesToken,
  setSpritesToken,
} from '../relay/control/provider-config.js';
import {
  assertControlOwner,
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
import { SpritesProvider } from '../relay/control/sprites-provider.js';
import { getCloudBootstrapBundleSource, CLOUD_BOOTSTRAP_BUNDLE_FILENAME } from '../cloud/bootstrap-bundle.generated.js';
import { ensureWorkspaceIdentity, getWorkspaceIdentity } from '../relay/control/workspace-identity.js';
import { createRootInviteToken, parseRootInviteToken } from '../lib/tmux-lite/crypto/root-invites.js';
import { registerRootInvite } from '../relay/auth/store.js';

function getSavedCloudRelayUrl(): string | null {
  const relayConfig = readRelayConfig();
  if (!relayConfig) {
    return null;
  }

  if (relayConfig.cloudRelayUrl?.trim()) {
    return relayConfig.cloudRelayUrl.trim();
  }

  if (isCloudReachableRelayUrl(relayConfig.relayUrl)) {
    return relayConfig.relayUrl;
  }

  return null;
}

async function requireLocalIdentityId(): Promise<string> {
  const userRoot = await loadUserRootIdentity();
  if (!userRoot) {
    throw new SpacesError(
      'No local user root identity found. Initialize identity first:\n  gssh user identity init',
      'USER_ERROR',
      1
    );
  }

  return userRoot.id;
}

interface CloudBootstrapRelayInfo {
  relayUrl: string;
  relaySigningPublicKey: string;
  relayFingerprint: string;
}

interface CloudEnrollmentInvite {
  token: string;
  inviteId: string;
  expiresAt: string;
}

function resolveCloudBootstrapRelayInfo(ownerIdentityId: string): CloudBootstrapRelayInfo {
  const relayUrl = getSavedCloudRelayUrl();

  if (!relayUrl) {
    throw new SpacesError(
      'No cloud-reachable relay URL found for cloud bootstrap. Start `gssh machine serve start` once against your target hosted or external relay before launching cloud workspaces.',
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

  // Keep owner assertion strict whenever we bootstrap cloud flows from control metadata.
  assertControlOwner(ownerIdentityId);

  throw new SpacesError(
    'Relay identity is not pinned yet. Start `gssh machine serve start` against your target relay once to pin relay identity metadata before launching cloud workspaces.',
    'USER_ERROR',
    1
  );
}

async function createCloudEnrollmentInvite(
  workspaceId: string,
  relayInfo: CloudBootstrapRelayInfo,
  machineSigningKey: string,
  machineKeyExchangeKey: string,
  expiresAtIso: string,
): Promise<CloudEnrollmentInvite> {
  const owner = await loadUserRootIdentity();
  if (!owner) {
    throw new SpacesError(
      'User root identity is required for cloud enrollment invites. Run `gssh user identity init` first.',
      'USER_ERROR',
      1,
    );
  }

  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) {
    throw new SpacesError('Invalid cloud invite expiry value.', 'SYSTEM_ERROR', 2);
  }

  const token = createRootInviteToken({
    type: 'relay-machine',
    owner,
    relayUrl: relayInfo.relayUrl,
    targetMachineSigningKey: machineSigningKey,
    targetMachineKeyExchangeKey: machineKeyExchangeKey,
    expiresAt: expiresAtMs,
    maxUses: 1,
    label: `cloud:${workspaceId}`,
  });

  const parsed = parseRootInviteToken(token);
  if (!parsed || parsed.type !== 'relay-machine') {
    throw new SpacesError('Failed to create relay-machine invite token for cloud bootstrap.', 'SYSTEM_ERROR', 2);
  }

  registerRootInvite({
    inviteId: parsed.inviteId,
    ownerUserRootId: parsed.ownerUserRootId,
    inviteType: parsed.type,
    relayUrl: parsed.relayUrl,
    token,
    maxUses: parsed.maxUses,
    expiresAt: new Date(parsed.expiresAt).toISOString(),
    label: parsed.label,
    machineId: parsed.targetMachineId,
    targetMachineSigningKey: parsed.targetMachineSigningKey,
    targetMachineKeyExchangeKey: parsed.targetMachineKeyExchangeKey,
  });

  return {
    token,
    inviteId: parsed.inviteId,
    expiresAt: new Date(parsed.expiresAt).toISOString(),
  };
}

let runtimeBootstrapBundleCache: string | null = null;

async function resolveBootstrapBundleSource(): Promise<string> {
  const embedded = getCloudBootstrapBundleSource();
  if (embedded) {
    return embedded;
  }

  if (runtimeBootstrapBundleCache) {
    return runtimeBootstrapBundleCache;
  }

  const entryPath = join(import.meta.dir, '../cloud/bootstrap-entry.ts');
  if (!existsSync(entryPath)) {
    throw new SpacesError(
      'Cloud bootstrap bundle is missing. Run `bun scripts/build.ts` to generate embedded bootstrap assets.',
      'SYSTEM_ERROR',
      2,
    );
  }

  const result = await Bun.build({
    entrypoints: [entryPath],
    target: 'bun',
    format: 'esm',
    minify: true,
    splitting: false,
    sourcemap: 'none',
  });

  if (!result.success || result.outputs.length === 0) {
    const details = result.logs.map((log) => log.message).join('\n');
    throw new SpacesError(
      `Failed to build cloud bootstrap bundle${details ? `:\n${details}` : ''}`,
      'SYSTEM_ERROR',
      2,
    );
  }

  runtimeBootstrapBundleCache = await result.outputs[0]!.text();
  return runtimeBootstrapBundleCache;
}

export async function cloudStatus(): Promise<void> {
  const serveStatus = await queryServeStatus();
  if (!serveStatus) {
    throw new SpacesError(
      'Serve daemon is not running. Start it with:\n  gssh machine serve start',
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

  const localUserRoot = await loadUserRootIdentity();
  if (localUserRoot) {
    const ownerAssertion = await sendAssertOwnerCommand(localUserRoot.id);
    logger.log(`  Local owner root: ${localUserRoot.id}`);
    logger.log(`  Owner access:    ${ownerAssertion.success ? 'yes' : `no (${ownerAssertion.error ?? 'not owner'})`}`);
  }

  logger.log('');
}

export async function cloudSetup(): Promise<void> {
  logger.log('');
  logger.bold('Cloud Provider Setup');
  logger.log('');

  const existing = await getSpritesToken();
  if (existing) {
    const masked = existing.length > 10
      ? `${existing.slice(0, 6)}${'*'.repeat(existing.length - 10)}${existing.slice(-4)}`
      : '*'.repeat(existing.length);
    logger.log(`  Current Sprites token: ${masked}`);
    logger.log('');
  }

  const token = await promptInput('Enter your Sprites.dev API token:', {
    validate: (value) => {
      if (!value || !value.trim()) return 'Token cannot be empty';
      return true;
    },
  });

  if (!token) {
    logger.info('Cancelled');
    logger.log('');
    return;
  }

  await setSpritesToken(token.trim());

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

export interface CloudLaunchProvider {
  createWorkspace(options: {
    name: string;
    repo: string;
    branch: string;
    image?: string;
    env: Record<string, string>;
  }): Promise<{ providerWorkspaceId: string; rawState: string }>;
  execWorkspaceCommand(
    id: string,
    options: { command: string[]; env?: Record<string, string>; dir?: string }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeWorkspaceFile?(
    id: string,
    options: { path: string; contents: string | Uint8Array; workingDir?: string; mode?: string; mkdir?: boolean }
  ): Promise<{ path: string; size: number; mode?: string }>;
}

export interface CloudLaunchDependencies {
  identityId?: string;
  token?: string;
  relayInfo?: CloudBootstrapRelayInfo;
  workspaceId?: string;
  workspaceIdentity?: Awaited<ReturnType<typeof ensureWorkspaceIdentity>>;
  provider?: CloudLaunchProvider;
  createEnrollmentInvite?: (
    workspaceId: string,
    relayInfo: CloudBootstrapRelayInfo,
    machineSigningKey: string,
    machineKeyExchangeKey: string,
    expiresAtIso: string
  ) => Promise<CloudEnrollmentInvite>;
}

export async function cloudLaunch(
  options: CloudLaunchOptions,
  dependencies: CloudLaunchDependencies = {}
): Promise<void> {
  const { repo, branch = 'main', image } = options;

  // 1. Require identity
  const identityId = dependencies.identityId ?? await requireLocalIdentityId();

  // 2. Assert owner (reads control store directly — no daemon required for launch)
  assertControlOwner(identityId);

  // 3. Require Sprites token
  const token = dependencies.token ?? await getSpritesToken();
  if (!token) {
    throw new SpacesError(
      'No Sprites token configured. Run:\n  gssh cloud setup',
      'USER_ERROR',
      1
    );
  }

  // 4. Resolve relay bootstrap info and generate a local workspace ID
  const relayInfo = dependencies.relayInfo ?? resolveCloudBootstrapRelayInfo(identityId);
  const workspaceId = dependencies.workspaceId ?? `ws-${randomUUID().slice(0, 8)}`;
  const appId = `gssh-${identityId.slice(0, 12)}`;
  const workspaceIdentity = dependencies.workspaceIdentity ?? await ensureWorkspaceIdentity(workspaceId);

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

  const createEnrollmentInvite = dependencies.createEnrollmentInvite ?? createCloudEnrollmentInvite;
  let enrollmentInvite: Awaited<ReturnType<typeof createCloudEnrollmentInvite>>;
  try {
    enrollmentInvite = await createEnrollmentInvite(
      workspaceId,
      relayInfo,
      workspaceIdentity.signingPublicKey,
      workspaceIdentity.keyExchangePublicKey,
      bootstrap.expiresAt,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Tombstone the workspace record so it doesn't dangle in bootstrapping state
    tombstoneCloudWorkspace(workspaceId);
    logCloudEvent({ workspaceId, eventType: 'launch_failed', message: `Failed to create enrollment invite: ${msg}` });
    throw new SpacesError(`Failed to create enrollment invite: ${msg}`, 'SYSTEM_ERROR', 2);
  }

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
      enrollmentInviteId: enrollmentInvite.inviteId,
      enrollmentInviteExpiresAt: enrollmentInvite.expiresAt,
    },
  });

  // 6. Call Sprites API
  const provider = dependencies.provider ?? new SpritesProvider({ token, appId });
  let providerResult: Awaited<ReturnType<CloudLaunchProvider['createWorkspace']>>;

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
        GSSH_ENROLLMENT_TOKEN: enrollmentInvite.token,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    upsertCloudWorkspace({
      id: workspaceId,
      provider: 'sprites',
      providerWorkspaceId: '',
      machineId: workspaceIdentity.id,
      machinePublicKey: workspaceIdentity.signingPublicKey,
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
    machineId: workspaceIdentity.id,
    machinePublicKey: workspaceIdentity.signingPublicKey,
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
      enrollmentInviteId: enrollmentInvite.inviteId,
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
      bootstrap.token,
      enrollmentInvite.token,
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
  logger.log(`  Enroll invite ID:   ${enrollmentInvite.inviteId}`);
  logger.log(`  Enroll expires:     ${enrollmentInvite.expiresAt}`);
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
  writeWorkspaceFile?(
    id: string,
    options: { path: string; contents: string | Uint8Array; workingDir?: string; mode?: string; mkdir?: boolean }
  ): Promise<{ path: string; size: number; mode?: string }>;
  destroyWorkspace(id: string): Promise<void>;
}

export interface CloudLifecycleDependencies {
  identityId?: string;
  relayInfo?: CloudBootstrapRelayInfo;
  workspaceIdentity?: Awaited<ReturnType<typeof getWorkspaceIdentity>>;
  createEnrollmentInvite?: (
    workspaceId: string,
    relayInfo: CloudBootstrapRelayInfo,
    machineSigningKey: string,
    machineKeyExchangeKey: string,
    expiresAtIso: string
  ) => Promise<CloudEnrollmentInvite>;
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

function resolveRelayUrlForCloudConnect(explicitRelay?: string): string {
  if (explicitRelay?.trim()) {
    return explicitRelay.trim();
  }

  const relayUrl = getSavedCloudRelayUrl();
  if (relayUrl) {
    return relayUrl;
  }

  throw new SpacesError(
    'No cloud-reachable relay URL is saved. Pass --relay <url> or start `gssh machine serve start` once against your target hosted or external relay.',
    'USER_ERROR',
    1,
  );
}

const SPRITE_BOOTSTRAP_SCRIPT_PATH = `/tmp/${CLOUD_BOOTSTRAP_BUNDLE_FILENAME}`;

function buildLegacySpriteServeStartCommand(): string[] {
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
    'if pgrep -f "[g]ssh machine serve" >/dev/null 2>&1; then',
    '  if [ -n "${GSSH_UNLOCK_TOKEN:-}" ]; then',
    '    gssh machine serve stop >/dev/null 2>&1 || true',
    '  else',
    '    echo "gssh machine serve already running"',
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
    'if [ -z "${GSSH_ENROLLMENT_TOKEN:-}" ]; then',
    '  echo "GSSH_ENROLLMENT_TOKEN is required" >&2',
    '  exit 1',
    'fi',
    'if [ -z "${GSSH_UNLOCK_TOKEN:-}" ]; then',
    '  echo "GSSH_UNLOCK_TOKEN is required" >&2',
    '  exit 1',
    'fi',
    'gssh machine serve start --relay "$GSSH_RELAY_URL" --relay-pubkey "$GSSH_RELAY_PUBKEY" --workspace-id "$GSSH_WORKSPACE_ID" --unlock-token "$GSSH_UNLOCK_TOKEN" --enrollment-token "$GSSH_ENROLLMENT_TOKEN" --ignore-keychain-and-skip-secrets',
  ].join('\n');

  return ['bash', '-lc', script];
}

function buildBundleSpriteServeStartCommand(): string[] {
  const script = [
    'set -eu',
    'if [ -z "${GSSH_RELAY_URL:-}" ]; then',
    '  echo "GSSH_RELAY_URL is required" >&2',
    '  exit 1',
    'fi',
    'if [ -z "${GSSH_RELAY_PUBKEY:-}" ]; then',
    '  echo "GSSH_RELAY_PUBKEY is required" >&2',
    '  exit 1',
    'fi',
    'if [ -z "${GSSH_ENROLLMENT_TOKEN:-}" ]; then',
    '  echo "GSSH_ENROLLMENT_TOKEN is required" >&2',
    '  exit 1',
    'fi',
    'if [ -z "${GSSH_UNLOCK_TOKEN:-}" ]; then',
    '  echo "GSSH_UNLOCK_TOKEN is required" >&2',
    '  exit 1',
    'fi',
    'if ! command -v bun >/dev/null 2>&1; then',
    '  echo "bun runtime is required in the sprite image for cloud bootstrap" >&2',
    '  exit 127',
    'fi',
    `if [ ! -f "${SPRITE_BOOTSTRAP_SCRIPT_PATH}" ]; then`,
    `  echo "Bootstrap bundle not found at ${SPRITE_BOOTSTRAP_SCRIPT_PATH}" >&2`,
    '  exit 127',
    'fi',
    `nohup bun "${SPRITE_BOOTSTRAP_SCRIPT_PATH}" >/tmp/gssh-serve.log 2>&1 &`,
    'sleep 2',
    `if ! pgrep -f "${CLOUD_BOOTSTRAP_BUNDLE_FILENAME}" >/dev/null 2>&1 && ! pgrep -f "[g]ssh machine serve" >/dev/null 2>&1; then`,
    '  cat /tmp/gssh-serve.log >&2 || true',
    '  exit 1',
    'fi',
  ].join('\n');

  return ['bash', '-lc', script];
}

async function runWorkspaceBootstrapExec(
  provider: Pick<CloudLifecycleProvider, 'execWorkspaceCommand' | 'writeWorkspaceFile'>,
  providerWorkspaceId: string,
  workspaceId: string,
  relayInfo: CloudBootstrapRelayInfo,
  phase: 'launch' | 'resume',
  bootstrapToken: string,
  enrollmentToken: string,
): Promise<void> {
  logCloudEvent({
    workspaceId,
    eventType: `${phase}_exec_started`,
    message: 'Running bootstrap command via Sprites exec',
  });

  const hasBundleWriter = typeof provider.writeWorkspaceFile === 'function';

  if (hasBundleWriter) {
    const bundleSource = await resolveBootstrapBundleSource();
    await provider.writeWorkspaceFile!(providerWorkspaceId, {
      path: SPRITE_BOOTSTRAP_SCRIPT_PATH,
      workingDir: '/',
      mkdir: true,
      mode: '0644',
      contents: bundleSource,
    });
  }

  const command = hasBundleWriter
    ? buildBundleSpriteServeStartCommand()
    : buildLegacySpriteServeStartCommand();
  const env: Record<string, string> = {
    GSSH_WORKSPACE_ID: workspaceId,
    GSSH_RELAY_URL: relayInfo.relayUrl,
    GSSH_RELAY_PUBKEY: relayInfo.relaySigningPublicKey,
    GSSH_UNLOCK_TOKEN: bootstrapToken,
    GSSH_ENROLLMENT_TOKEN: enrollmentToken,
  };

  const execResult = await provider.execWorkspaceCommand(providerWorkspaceId, {
    command,
    env,
    dir: '/home/sprite',
  });

  if (execResult.exitCode !== 0) {
    const stderrSnippet = execResult.stderr.trim().slice(0, 200);
    const stdoutSnippet = execResult.stdout.trim().slice(0, 200);
    const outputSnippet = stderrSnippet || stdoutSnippet || 'no output';
    throw new SpacesError(
      `Bootstrap command exited with code ${execResult.exitCode}: ${outputSnippet}`,
      'SYSTEM_ERROR',
      2,
    );
  }

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
  injectedProvider?: CloudLifecycleProvider,
  dependencies: CloudLifecycleDependencies = {}
): Promise<void> {
  const identityId = dependencies.identityId ?? await requireLocalIdentityId();
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
  injectedProvider?: CloudLifecycleProvider,
  dependencies: CloudLifecycleDependencies = {}
): Promise<void> {
  const identityId = dependencies.identityId ?? await requireLocalIdentityId();
  const provider = injectedProvider ?? await makeSpritesProvider(identityId);
  const ws = requireWorkspace(workspaceId);
  const relayInfo = dependencies.relayInfo ?? resolveCloudBootstrapRelayInfo(identityId);

  const storedIdentity = dependencies.workspaceIdentity ?? await getWorkspaceIdentity(workspaceId);
  if (!storedIdentity) {
    throw new SpacesError(
      `No escrowed workspace identity found for '${workspaceId}'. This workspace cannot be resumed securely.`,
      'USER_ERROR',
      1
    );
  }

  const unlock = createCloudUnlockToken({
    workspaceId,
    ownerIdentityId: identityId,
  });

  const createEnrollmentInvite = dependencies.createEnrollmentInvite ?? createCloudEnrollmentInvite;
  const enrollmentInvite = await createEnrollmentInvite(
    workspaceId,
    relayInfo,
    storedIdentity.signingPublicKey,
    storedIdentity.keyExchangePublicKey,
    unlock.expiresAt,
  );

  logger.log('');
  logger.log(`Resuming workspace ${workspaceId}...`);

  let resumeResult: Awaited<ReturnType<CloudLifecycleProvider['resumeWorkspace']>>;
  try {
    resumeResult = await provider.resumeWorkspace(ws.providerWorkspaceId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateCloudWorkspaceStatus(workspaceId, 'error', msg);
    logCloudEvent({ workspaceId, eventType: 'resume_failed', message: msg });
    throw new SpacesError(`Failed to resume workspace: ${msg}`, 'SYSTEM_ERROR', 2);
  }

  updateCloudWorkspaceStatus(workspaceId, resumeResult.status === 'ready' ? 'bootstrapping' : resumeResult.status);
  logCloudEvent({
    workspaceId,
    eventType: 'workspace_resumed',
    message: `Workspace resumed`,
    metadata: {
      rawState: resumeResult.rawState,
      unlockTokenId: unlock.tokenId,
      enrollmentInviteId: enrollmentInvite.inviteId,
    },
  });

  try {
    await runWorkspaceBootstrapExec(
      provider,
      ws.providerWorkspaceId,
      workspaceId,
      relayInfo,
      'resume',
      unlock.token,
      enrollmentInvite.token,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateCloudWorkspaceStatus(workspaceId, 'error', msg);
    logCloudEvent({ workspaceId, eventType: 'resume_exec_failed', message: msg });
    throw new SpacesError(`Failed to run resume bootstrap command: ${msg}`, 'SYSTEM_ERROR', 2);
  }

  logger.log('');
  logger.success(`  Workspace ${workspaceId} resumed (status: bootstrapping).`);
  logger.log(`  Unlock token ID:    ${unlock.tokenId}`);
  logger.log(`  Enroll invite ID:   ${enrollmentInvite.inviteId}`);
  logger.log('');
}

// ── cloud destroy ─────────────────────────────────────────────────────────────

export async function cloudDestroy(
  workspaceId: string,
  injectedProvider?: CloudLifecycleProvider,
  dependencies: CloudLifecycleDependencies = {}
): Promise<void> {
  const identityId = dependencies.identityId ?? await requireLocalIdentityId();
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

export async function cloudConnect(
  workspaceId: string,
  options: { relay?: string; yes?: boolean; passwordStdin?: boolean } = {},
  dependencies: {
    resolveRelayUrl?: (explicitRelay?: string) => string;
    connectToRemote?: (
      target?: string,
      options?: { relay?: string; machine?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean },
    ) => Promise<void>;
  } = {},
): Promise<void> {
  const workspace = requireWorkspace(workspaceId);

  if (!workspace.machineId) {
    throw new SpacesError(
      `Workspace '${workspaceId}' does not have an attached machine identity yet.`,
      'USER_ERROR',
      1,
    );
  }

  if (workspace.status === 'hibernated') {
    throw new SpacesError(
      `Workspace '${workspaceId}' is hibernated. Resume it first:\n  gssh cloud resume ${workspaceId}`,
      'USER_ERROR',
      1,
    );
  }

  if (workspace.status === 'destroyed') {
    throw new SpacesError(
      `Workspace '${workspaceId}' is destroyed and cannot be connected.`,
      'USER_ERROR',
      1,
    );
  }

  if (workspace.status === 'error') {
    throw new SpacesError(
      `Workspace '${workspaceId}' is in error state. Inspect with:\n  gssh cloud list`,
      'USER_ERROR',
      1,
    );
  }

  if (workspace.status === 'provisioning' || workspace.status === 'bootstrapping' || workspace.status === 'offline') {
    throw new SpacesError(
      `Workspace '${workspaceId}' is currently '${workspace.status}'. Wait until it is ready, then retry.`,
      'USER_ERROR',
      1,
    );
  }

  const relayUrl = (dependencies.resolveRelayUrl ?? resolveRelayUrlForCloudConnect)(options.relay);
  const connectToRemote = dependencies.connectToRemote
    ?? (await import('./connect.js')).connectToRemote;

  logger.info(`Connecting to cloud workspace ${workspaceId} via machine ${workspace.machineId}...`);
  await connectToRemote(workspace.machineId, {
    relay: relayUrl,
    yes: options.yes,
    passwordStdin: options.passwordStdin,
  });
}

export async function cloudList(): Promise<void> {
  const serveStatus = await queryServeStatus();
  if (!serveStatus) {
    throw new SpacesError(
      'Serve daemon is not running. Start it with:\n  gssh machine serve start',
      'USER_ERROR',
      1
    );
  }

  const identityId = await requireLocalIdentityId();
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
    if (workspace.machineId) {
      logger.log(`    Machine:  ${workspace.machineId}`);
    }
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
    if (workspace.machineId && workspace.status === 'ready') {
      logger.dim(`    Connect:  gssh cloud connect ${workspace.id}`);
    }
  }

  logger.log('');
}
