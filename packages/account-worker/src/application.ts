import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
import { runtimeMachineControl } from './account-runtime-control.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { storedVaultCredentialSchema } from '@gitspace/provider-auth';
import { z } from 'zod';
import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import { storageMigrationStatusInputSchema } from '@gitspace/protocol/storage-migration';
import { MachineDiscardRequired, machineDiscardConfirmationSchema, type MachineDiscardConfirmation, type MachineDiscardScope } from '@gitspace/protocol/machine-discard';
import { defaultReleasePinSchema } from '@gitspace/protocol/default-release';
import { GITSPACE_SOURCE_REPOSITORY, hostedServiceRouteSchema, hostedServiceUrlKind } from '@gitspace/protocol/project-authority';
import { FiledIssueListInputSchema, FiledIssueResolveInputSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { readAdvertisedRefs } from '@gitspace/runtime-workspace-do';
import { beginLogin, respondLogin, pollLogin, publicLogin, loginStateSchema, workerOAuthProviderSchema, gitspaceOAuthProviderSchema, type LoginState, type UpstreamOAuthProvider } from '@gitspace/provider-auth';
import { isUpstreamOAuthProvider, tokenEmail, loopbackCallback, refreshUpstreamCredential, storedUpstreamCredential, upstreamLoginEvent, upstreamOAuth, upstreamPromptText, upstreamRequestAuth } from './upstream-oauth.js';
import { collectUsage, ProviderUsageError, providerUsageReportSchema, usageObservation, type UsageObservation } from '@gitspace/provider-auth';
import { describeCloudProviders, listCloudModels } from '@gitspace/runtime-core/inference';
import type { AccountFailure, CredentialAccount, ResolvedCredential } from '@gitspace/runtime-core/inference';
import type { ProviderView, ProviderLoginEvent, ProviderUsage } from '@gitspace/protocol';
import { ProviderLoginEventCodec } from '@gitspace/protocol';
import { cloudImageProviderCall, resolveCloudImage } from './sandbox-rollout.js';
import { cloudImageOperationActive, cloudImageProviderStatusSchema, cloudImageSelectionSchema, type CloudImageSelection } from '@gitspace/protocol/cloud-image';
import { handleAccountCloudRpc } from './account-cloud-rpc.js';
import { serveArtifactShare } from './account-inspector-data.js';
import { serveArtifactFile } from './artifact-file-url.js';
import { serveRuntimeImage } from './runtime-images.js';
import { serveGuideShare } from './guide-shares.js';
import { ensureAccountGitSpaceProject } from './gitspace-project.js';
import { createDeviceBinding, encodeApiKey } from '@gitspace/protocol/device-grant';
import { mcpAccessStatusRequestSchema, mcpAccessChangeRequestSchema, mcpAccessEnableRequestSchema, type McpAccessOperation, type McpAccessResult, type McpAccessView } from '@gitspace/protocol/mcp-access';
import { GitLfsObjectSchema, GitLfsProtectionSchema, GitLfsSnapshotSchema, projectStorageRoot } from '@gitspace/protocol-workspace';
import {
  credentialAccessRequestSchema,
  gitIdentityUpdateSchema,
  credentialProtocolBase64,
  sealCredentialForMachine,
  signedControlRequestSchema,
  SIGNED_REQUEST_EXPIRED_CODE,
  SIGNED_REQUEST_EXPIRED_MESSAGE,
  SIGNED_REQUEST_MAX_AGE_MS,
  SIGNED_UPLOAD_MAX_AGE_MS,
  verifyCredentialAccessRequest,
  verifyCredentialAuthorityGrant,
  signCredentialAuthorityGrant,
  verifyRelayAuthorization,
  signedCredentialAuthorityGrantSchema,
  type CredentialAccessRequest,
  type SignedControlRequest,
  type SignedCredentialAuthorityGrant,
  deviceBindingSchema,
  deviceGrantExpiresAt,
  signedDeviceInviteSchema,
  deviceInvitePayload,
  verifyDeviceInvite,
  verifyDeviceBinding,
  verifyDeviceGrantRecord,
  type DeviceBinding,
  type DeviceGrantRecord,
  type SignedDeviceInvite,
  decodeSignedRpcHeader,
  verifyRpcSignature,
  RPC_DEVICE_HEADER,
  MACHINE_PAIRING_TTL_MS,
  credentialAuthorityGrantPayload,
  type CredentialAuthorityGrant,
  type DeviceCapability,
  type VerifiedDevice,
  runtimeSettingValueSchema,
  dataObjectReadSchema,
  dataObjectWriteSchema,
  dataMultipartPartSchema,
  dataMultipartCompleteSchema,
  dataMultipartAbortSchema,
  DATA_PUT_MAX_BYTES,
  TENANT_OBJECT_PART_BYTES,
} from '@gitspace/protocol';
import {
  DEFAULT_INFERENCE_PROFILE_ID, inferenceCreateInputSchema, inferenceUpdateInputSchema,
  inferenceDeleteInputSchema, inferenceAssignInputSchema,
  type InferenceProfile, type InferenceState,
} from '@gitspace/protocol/inference';
import { HostedIngressRegistrationSchema, LifecycleMutationSchema, authorizeLifecycleMachineMutation, environmentFailure, executionHash, parseServiceIngressContent, type LifecycleState } from '@gitspace/protocol-environment';
import { LiveChanges } from './live-changes.js';
import { sendSized, tenantNamespace, tenantStore, TenantObjectIntegrityError, verifying, type TenantNamespace } from './tenant-store.js';
import { requireWorkspaceAccess } from './runtime-access.js';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { migratedRoleSettings } from './inference-role-migration.js';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { notifyBrowsers } from './live-notices.js';
import {
  stageReleaseInputSchema,
  machineProtocolInputSchema,
  launchProgressSchema,
  launcherStartedInputSchema,
  WORKER_VERSION_HEADER,
  GITSPACE_CANONICAL_BRANCH,
  type DeploymentStatus,
} from '@gitspace/protocol/deployment';
import { refreshCredential, ProviderRefreshError, type StoredOAuthCredential } from './providers.js';
import { ComposioPluginGateway } from './composio-plugins.js';
import { githubRequest, importGitHubAppPrivateKey, signGitHubAppJwt, verifyGitHubSignature } from './github-api.js';
import { githubRoute } from './github-app.js';
import { ProjectSecretsDO } from './project-secrets.js';
import {
  InspectorConflictError,
  InspectorStateError,
} from './space-context.js';
import {
  ProjectAuthorityDO,
  UserProjectIndexDO,
} from './project-authority.js';
export * from './project-authority.js';
export * from './storage.js';
export * from './fleet-catalog.js';
export * from './space-authority.js';
export * from './user-settings.js';
export * from './sandbox-provisioner.js';
export * from './machine-providers.js';
export * from './project-secrets.js';
export * from './user-skills.js';
export * from './project-automations.js';
export * from './space-context.js';
export * from './local-mcp.js';
export * from './composio-plugins.js';
export * from './hosted-route-registry.js';
export * from './account-state.js';
export * from './github-app.js';
export { TenantReleasesDO } from './tenant-releases.js';
import type { TenantReleasesDO } from './tenant-releases.js';
import { SpaceAuthorityDO } from './space-authority.js';
import { UserStorageDO } from './storage.js';
import { FleetCatalogDO, type FleetMachineDefinition, type PortableSpaceDefinition } from './fleet-catalog.js';
import { SettingsRevisionConflict, UserSettingsDO } from './user-settings.js';
import { AccountStateDO } from './account-state.js';
import { platformSwap, tenantPlatformFetch, tenantPlatformJson, tenantProvider, tenantWorkerVersion, type WorkerSwap } from './tenant-platform.js';
import { accountDistributionResponse } from './distribution.js';
import { admitPortableRelease } from './portable-release.js';
import { forwardTunnelRequest, tunnelTarget } from './relay-request.js';
import { accountAccessResponse, accountStatus, activeAccount, authorizeControl } from './account-access.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, DeviceVerifier, invalidateDeviceAuthority, withDeviceAuthority, type DeviceRegistrySnapshot, type MachineCredential } from './device-authority.js';
import { machineProviderFor } from './machine-providers.js';
import { releaseMachineAttachments } from './runtime-machine-loss.js';
import { notifyMachines } from './machine-notices.js';
import {
  McpConnectionNotFoundError,
  McpConnectionRevisionConflictError,
  McpConnectionValidationError,
  UserMcpConnectionsDO,
} from './local-mcp.js';
import {
  launchReleaseInputSchema,
  machineAppliedInputSchema,
  machineChannelAppliedInputSchema,
  ReleaseNotFoundError,
  WORKER_VERSION,
  type LaunchResult,
} from './tenant-releases.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

// Pi's variable-specifier Bedrock import cannot run inside a Worker bundle.
setBedrockProviderModule(bedrockProviderModule);

/**
 * Tolerated clock skew for persisted enrollment material (invite `issuedAt`, binding
 * `boundAt`). Not a request-signature window: it bounds pre-dating inside the
 * five-minute invitation lifetime, which a wider window would make vacuous.
 */
const ENROLLMENT_CLOCK_SKEW_MS = 60_000;
export const REQUEST_MAX_BYTES = 512 * 1024;
/** Release objects (plaintext, outside tenant storage) keep their whole-object limit. */
const DATA_OBJECT_MAX_BYTES = 64 * 1024 * 1024;
/** Root wrap key per version: HMAC(vault_key, label). New scope keys are wrapped under the current version. */
const SCOPE_KEY_ROOT_VERSION = 1;
const SCOPE_KEY_ROOT_LABELS: Record<number, string> = { 1: 'gitspace/scope-key-wrap/v1' };
const DATA_REQUEST_HEADER_MAX_BYTES = 8 * 1024;
const ACCESS_REFRESH_SKEW_MS = 60_000;
const SUPPORTED_PROVIDERS = new Set<string>(workerOAuthProviderSchema.options);
const REMOTE_REFRESH_SENTINEL = '__remote__' as const;
const ACCOUNT_ID_BYTES = 16;

const BROWSER_INVITATION_TTL_MS = 5 * 60_000;
const browserInvitationCreateSchema = z.strictObject({
  userId: z.string().regex(/^u-[a-f0-9]{32}$/u),
  invite: signedDeviceInviteSchema,
});
const browserInvitationReferenceSchema = z.strictObject({
  userId: z.string().regex(/^u-[a-f0-9]{32}$/u),
  inviteId: z.uuid(),
});
interface BrowserInvitationRow extends Record<string, SqlStorageValue> {
  invite_id: string;
  creator_device_id: string;
  invite_payload: string;
  expires_at: number;
  status: 'pending' | 'redeemed' | 'cancelled' | 'expired';
  device_id: string | null;
}
interface BrowserInvitationValue {
  inviteId: string;
  expiresAt: number;
  status: BrowserInvitationRow['status'];
  deviceId: string | null;
}
const credentialUploadSchema = z.strictObject({
  provider: z.string().trim().min(1).max(160),
  credential: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('api_key'), key: z.string().min(1), source: z.literal('login').optional() }),
    z.object({
      type: z.literal('oauth'),
      refresh: z.string().min(1).refine((value) => value !== REMOTE_REFRESH_SENTINEL),
      access: z.string().min(1),
      expires: z.number().nonnegative(),
      apiEndpoint: z.string().optional(),
      enterpriseUrl: z.string().optional(),
      accountId: z.string().optional(),
      email: z.string().optional(),
      orgId: z.string().optional(),
      orgName: z.string().optional(),
      projectId: z.string().optional(),
      authorizedAt: z.number().optional(),
    }).passthrough(),
  ]),
}).refine(({ provider, credential }) => credential.type !== 'oauth' || SUPPORTED_PROVIDERS.has(provider));
type StoredVaultOAuthCredential = StoredOAuthCredential & { type?: 'oauth' };
type StoredVaultCredential = StoredVaultOAuthCredential | (Extract<z.infer<typeof credentialUploadSchema>['credential'], { type: 'api_key' }> & { provider: string });
const pairingMachineSchema = z.strictObject({
  machineId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  label: z.string().trim().min(1).max(160),
  signingPublicKey: z.string().min(40).max(64),
  exchangePublicKey: z.string().min(40).max(64),
});
interface PairingRow extends Record<string, SqlStorageValue> {
  pairing_id: string;
  creator_device_id: string;
  token_hash: string;
  expires_at: number;
  state: 'created' | 'claimed' | 'approved' | 'enrolled' | 'cancelled';
  machine_json: string | null;
  grant_json: string | null;
}
type MachinePairingValue =
  | { pairingId: string; token: string; expiresAt: number }
  | { pairingId: string; state: PairingRow['state'] }
  | { pairingId: string; state: PairingRow['state']; expiresAt: number; machine: z.infer<typeof pairingMachineSchema> | null; grant: CredentialAuthorityGrant | null; issuerChain: DeviceGrantRecord[] }
  | { state: 'pending' }
  | { state: 'enrolled'; userId: string; handle: string; accountUrl: string; relayUrl: string; apiUrl: string; rootPublicKey: string; machineId: string; grant: SignedCredentialAuthorityGrant };
const PAIRING_CAPABILITIES: DeviceCapability[] = ['devices.manage', 'fleet.control', 'rpc.write', 'session.prompt', 'deployment.control'];

const SignedInAccountSchema = z.object({ type: z.enum(['api_key', 'oauth']), identity: z.string().nullable(), email: z.string().nullable() });
function credentialAccount(credential: StoredVaultCredential): z.infer<typeof SignedInAccountSchema> {
  return credential.type === 'api_key'
    ? { type: 'api_key', identity: null, email: null }
    : { type: 'oauth', identity: credentialIdentity(credential), email: credential.email ?? tokenEmail(credential.access) ?? null };
}

function credentialIdentity(credential: StoredVaultCredential): string | null {
  if (credential.type === 'api_key') return null;
  const account = credential.accountId?.trim();
  const email = credential.email?.trim().toLowerCase();
  const project = credential.projectId?.trim();
  if (credential.provider === 'anthropic' || credential.provider === 'openai-codex' || credential.provider === 'openai') {
    const base = email ? `email:${email}` : account ? `account:${account}` : project ? `project:${project}` : null;
    const org = credential.orgId?.trim();
    return org ? (base ? `${base}|org:${org}` : `org:${org}`) : base;
  }
  return account ? `account:${account}` : email ? `email:${email}` : project ? `project:${project}` : null;
}

type SignedInAccount = z.infer<typeof SignedInAccountSchema>;
/** How an account is named to its owner, on the providers screen and in a turn it ran out of. */
function accountLabel(id: string, account: SignedInAccount | null): string {
  return account?.email ?? account?.identity ?? (account?.type === 'api_key' ? 'API key' : `Account ${id}`);
}

type AccountHealthRow = { credential_id: string; cooldown_until: number; cooldown_reason: string | null; report_json: string | null };
/** An account's latest usage observation, and until when inference skips it and why: the later of a failure's
 * cooldown and the reset of a usage window it has used up. */
function accountHealth(row: AccountHealthRow | undefined, now: number): { usage?: UsageObservation; out: { until: number; reason: string } | null } {
  if (!row) return { out: null };
  const usage = row.report_json ? usageObservation(providerUsageReportSchema.parse(JSON.parse(row.report_json))) : undefined;
  const out = usage?.exhausted && usage.exhausted.until > row.cooldown_until
    ? { until: usage.exhausted.until, reason: `${usage.exhausted.label} usage limit reached` }
    : { until: row.cooldown_until, reason: row.cooldown_reason ?? 'The provider refused this account' };
  return { ...(usage ? { usage } : {}), out: out.until > now ? out : null };
}


async function accountIdForRootPublicKey(rootPublicKey: string): Promise<string | null> {
  try {
    const decoded = credentialProtocolBase64.decode(rootPublicKey);
    if (decoded.byteLength !== 32) return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(decoded).buffer));
    return `u-${Array.from(digest.subarray(0, ACCOUNT_ID_BYTES), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

export type CredentialVaultResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: { code: string; message: string; retryAfterMs?: number } };

interface MachineRow extends Record<string, SqlStorageValue> {
  machine_id: string;
  signing_public_key: string;
  exchange_public_key: string;
  capabilities_json: string;
  generation: number;
  grant_json: string | null;
}

/** A row whose stored grant or capabilities no longer parse is not a credential: it authorizes nothing. */
function machineCredential(row: MachineRow): MachineCredential | null {
  const capabilities = z.array(z.string()).safeParse(JSON.parse(row.capabilities_json));
  const grant = row.grant_json === null ? null : signedCredentialAuthorityGrantSchema.safeParse(JSON.parse(row.grant_json));
  if (!capabilities.success || (grant && !grant.success)) return null;
  return {
    machineId: row.machine_id,
    signingPublicKey: row.signing_public_key,
    exchangePublicKey: row.exchange_public_key,
    capabilities: capabilities.data,
    generation: row.generation,
    grant: grant ? grant.data : null,
  };
}

interface CredentialRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: string;
  sealed_json: string;
  revision: number;
  expires_at: number;
  state: string;
}

interface InferenceProfileRow extends Record<string, SqlStorageValue> {
  profile_id: string;
  profile_json: string;
  deleted_at: string | null;
  credential_generation: number;
}
export interface CloudInferenceCatalog {
  profile: InferenceProfile;
  assignmentRevision: number;
  accounts: CredentialAccount[];
}
export type InferenceWriteResult =
  | { status: 'ok'; value: InferenceState }
  | { status: 'conflict'; resource: 'inference-profile' | 'inference-assignment'; expected: number; actual: number };

interface ProfileCredentialRow extends CredentialRow {
  row_id: number;
  updated_at: string;
}
interface ProviderSecretRow extends Record<string, SqlStorageValue> {
  provider: string;
  sealed_json: string;
  revision: number;
  updated_at: string;
}
interface GitHubAppSecretRow extends Record<string, SqlStorageValue> {
  app_id: number;
  sealed_private_key: string;
  sealed_webhook_secret: string;
  sealed_client_secret: string;
  revision: number;
}
interface GitHubAppSecrets {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  clientSecret: string;
}
/** Sealing context: binds each secret to its App, field and revision, so no sealed value can be replayed into another. */
function githubSecretContext(appId: number, field: 'private-key' | 'webhook-secret' | 'client-secret', revision: number): string {
  return `github-app:${appId}:${field}\n${revision}`;
}
/** A shared-guide reader's GitHub session lasts at most this long. */
const GITHUB_READER_SECONDS = 8 * 60 * 60;
const githubReaderSessionSchema = z.object({ token: z.string().min(1), login: z.string().min(1), expiresAt: z.number().int() }).strict();
function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

async function vaultCryptoKey(vaultKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ownedBuffer(vaultKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealVaultCredential(credential: StoredVaultCredential, vaultKey: Uint8Array, id: string, revision: number): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(nonce),
    additionalData: ownedBuffer(new TextEncoder().encode(`${id}\n${revision}`)),
  }, await vaultCryptoKey(vaultKey), ownedBuffer(new TextEncoder().encode(JSON.stringify(credential))));
  const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  sealed.set(nonce);
  sealed.set(new Uint8Array(ciphertext), nonce.byteLength);
  return credentialProtocolBase64.encode(sealed);
}

async function openVaultCredential(row: CredentialRow, vaultKey: Uint8Array): Promise<StoredVaultCredential> {
  const sealed = credentialProtocolBase64.decode(row.sealed_json);
  if (sealed.byteLength <= 12) throw new Error('Stored credential is malformed');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(sealed.subarray(0, 12)),
    additionalData: ownedBuffer(new TextEncoder().encode(`${row.id}\n${row.revision}`)),
  }, await vaultCryptoKey(vaultKey), ownedBuffer(sealed.subarray(12)));
  return storedVaultCredentialSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
}
async function sealVaultText(value: string, vaultKey: Uint8Array, context: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(nonce),
    additionalData: ownedBuffer(new TextEncoder().encode(context)),
  }, await vaultCryptoKey(vaultKey), ownedBuffer(new TextEncoder().encode(value)));
  const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  sealed.set(nonce);
  sealed.set(new Uint8Array(ciphertext), nonce.byteLength);
  return credentialProtocolBase64.encode(sealed);
}

async function openVaultText(sealedValue: string, vaultKey: Uint8Array, context: string): Promise<string> {
  const sealed = credentialProtocolBase64.decode(sealedValue);
  if (sealed.byteLength <= 12) throw new Error('Stored provider credential is malformed');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(sealed.subarray(0, 12)),
    additionalData: ownedBuffer(new TextEncoder().encode(context)),
  }, await vaultCryptoKey(vaultKey), ownedBuffer(sealed.subarray(12)));
  return new TextDecoder().decode(plaintext);
}

type UpstreamLogin = { abort: AbortController; answer: { promptId: string; resolve(value: string): void } | null };
type CloudLoginRow = {
  flow_id: string; profile_id: string; provider: string; revision: number; sealed_state: string;
  events_json: string; status: 'pending' | 'busy' | 'done'; expires_at: number;
};
function publicError(code: string, message: string, retryAfterMs?: number): CredentialVaultResult<never> {

  return { status: 'error', error: { code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } };
}

export class CredentialVaultDO extends BudgetedDurableObject {
  private inferenceMigration: Promise<InferenceState> | null = null;
  private readonly inferenceChanges: LiveChanges;
  private readonly activeLoginAttempts = new Set<string>();
  /** Pi sign-in flows run in this object's memory; a restart abandons them (the row then reports an interruption). */
  private readonly upstreamLogins = new Map<string, UpstreamLogin>();
  /** Refreshes in flight, one per credential; see `singleFlight`. */
  private readonly profileRefreshes = new Map<string, Promise<void>>();
  private readonly legacyRefreshes = new Map<string, Promise<StoredVaultOAuthCredential>>();
  /** A device credential changed: this isolate's registry drops its view, the relay rechecks its machine sockets and
   * service sessions against it, and connected machines refetch their device list. */
  private deviceCredentialsChanged(): void {
    invalidateDeviceAuthority();
    this.ctx.waitUntil(this.env.RELAY.getByName(this.env.RELAY_NAME).machineCredentialsChanged().catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'relay_credentials_recheck_failed', message: error instanceof Error ? error.message : String(error) }));
    }));
    this.ctx.waitUntil(notifyMachines(this.env, 'all', ['devices']));
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.inferenceChanges = new LiveChanges(ctx.storage, (notices) => { ctx.waitUntil(notifyBrowsers(env, notices)); });
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS vault_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          user_id TEXT NOT NULL,
          root_public_key TEXT NOT NULL,
          vault_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credential_devices (
          machine_id TEXT PRIMARY KEY,
          signing_public_key TEXT NOT NULL,
          exchange_public_key TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          generation INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS device_grants (
          device_id TEXT PRIMARY KEY,
          invite_id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          record_json TEXT NOT NULL,
          generation INTEGER NOT NULL,
          revoked_at INTEGER,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS browser_invitations (
          invite_id TEXT PRIMARY KEY,
          creator_device_id TEXT NOT NULL,
          invite_payload TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'redeemed', 'cancelled', 'expired')),
          device_id TEXT
        );
        CREATE TABLE IF NOT EXISTS machine_pairings (
          pairing_id TEXT PRIMARY KEY,
          creator_device_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('created', 'claimed', 'approved', 'enrolled', 'cancelled')),
          machine_json TEXT,
          grant_json TEXT
        );
        CREATE TABLE IF NOT EXISTS oauth_credentials (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          sealed_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'refresh-uncertain', 'disabled')),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_secrets (
          provider TEXT PRIMARY KEY,
          sealed_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS github_app_secrets (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          app_id INTEGER NOT NULL,
          sealed_private_key TEXT NOT NULL,
          sealed_webhook_secret TEXT NOT NULL,
          sealed_client_secret TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_access (
          id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
          device_id TEXT, sealed_key TEXT, token_hash TEXT, updated_at TEXT NOT NULL
        );
        DROP TABLE IF EXISTS request_nonces;
        DROP TABLE IF EXISTS refresh_leases;
        UPDATE oauth_credentials SET state = 'active' WHERE state = 'refresh-uncertain';
        CREATE TABLE IF NOT EXISTS retired_credential_rowid (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          row_id INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credential_snapshot (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generation INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inference_profiles (
          profile_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL,
          deleted_at TEXT, credential_generation INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inference_assignments (
          project_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inference_deleted_projects (project_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS inference_migration (
          id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
          revision INTEGER NOT NULL, settings_generation INTEGER
        );
        CREATE TABLE IF NOT EXISTS scope_keys (
          scope TEXT PRIMARY KEY, wrapped BLOB NOT NULL, root_version INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO inference_migration(id, version, revision) VALUES (1, 0, 0);
      `);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO credential_snapshot(id, generation) VALUES (1, ?)', Date.now());
      const columns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(credential_devices)').toArray();
      if (!columns.some((column) => column.name === 'grant_json')) this.ctx.storage.sql.exec('ALTER TABLE credential_devices ADD COLUMN grant_json TEXT');
      const legacyColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(oauth_credentials)').toArray();
      if (!legacyColumns.some(column => column.name === 'profile_id')) this.ctx.storage.sql.exec("ALTER TABLE oauth_credentials ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'");
      // The non-secret account a credential signs in as, so listing providers decrypts nothing; filled on write, or once on first list.
      for (const table of ['oauth_credentials', 'inference_credentials']) {
        const tableColumns = this.ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
        if (tableColumns.length && !tableColumns.some(column => column.name === 'account_json')) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN account_json TEXT`);
      }
      if (this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inference_credentials'").toArray().length) {
        this.ctx.storage.sql.exec("UPDATE inference_credentials SET state = 'active' WHERE state = 'refresh-uncertain'");
      }
      // Approval mode was removed; profiles drop its stored default once.
      for (const row of this.ctx.storage.sql.exec<InferenceProfileRow>("SELECT * FROM inference_profiles WHERE profile_json LIKE '%\"approval%'").toArray()) {
        const profile = z.looseObject({ settings: z.record(z.string(), z.json()) }).parse(JSON.parse(row.profile_json));
        profile.settings = Object.fromEntries(Object.entries(profile.settings).filter(([path]) => path !== 'approval' && !path.startsWith('approval.')));
        this.ctx.storage.sql.exec('UPDATE inference_profiles SET profile_json = ? WHERE profile_id = ?', JSON.stringify(profile), row.profile_id);
      }
      // OMP-era settings no profile reads were removed and Thinking/Fast became Deep/Fast; profiles are rewritten once.
      for (const row of this.ctx.storage.sql.exec<InferenceProfileRow>('SELECT * FROM inference_profiles').toArray()) {
        const profile = z.looseObject({ revision: z.number(), settings: z.record(z.string(), runtimeSettingValueSchema) }).parse(JSON.parse(row.profile_json));
        const settings = migratedRoleSettings(profile.settings);
        if (JSON.stringify(settings) === JSON.stringify(profile.settings)) continue;
        this.ctx.storage.sql.exec('UPDATE inference_profiles SET profile_json = ? WHERE profile_id = ?', JSON.stringify({ ...profile, settings, revision: profile.revision + 1, updatedAt: new Date().toISOString() }), row.profile_id);
      }
    });
  }

  /** Local lifecycle hook; never calls a project authority and cannot deadlock registration. */
  ensureProjectInference(projectId: string): void {
    if (!projectId) throw new Error('Project identity is required');
    this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec('SELECT project_id FROM inference_deleted_projects WHERE project_id = ?', projectId).toArray().length) return;
      this.ensureDefaultProfile();
      if (this.ctx.storage.sql.exec('INSERT OR IGNORE INTO inference_assignments(project_id, profile_id, revision) VALUES (?, ?, 0)', projectId, DEFAULT_INFERENCE_PROFILE_ID).rowsWritten) this.inferenceChanged();
    });
  }

  removeProjectInference(projectId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO inference_deleted_projects(project_id) VALUES (?)', projectId);
      if (this.ctx.storage.sql.exec('DELETE FROM inference_assignments WHERE project_id = ?', projectId).rowsWritten) this.inferenceChanged();
    });
  }

  inferenceCutover(): boolean {
    const row = this.ctx.storage.sql.exec<{ version: number; settings_generation: number | null }>('SELECT version, settings_generation FROM inference_migration WHERE id = 1').one();
    return row.version === 1 || row.settings_generation !== null;
  }

  private legacyCredentialConflict(): boolean {
    return this.inferenceCutover()
      && this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_credentials'").toArray().length > 0
      && this.ctx.storage.sql.exec('SELECT id FROM oauth_credentials LIMIT 1').toArray().length > 0;
  }

  private ensureDefaultProfile(): void {
    const now = new Date().toISOString();
    const profile: InferenceProfile = { version: 1, id: DEFAULT_INFERENCE_PROFILE_ID, name: 'Default', revision: 0, settings: {}, createdAt: now, updatedAt: now };
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO inference_profiles(profile_id, profile_json, credential_generation) VALUES (?, ?, ?)',
      profile.id, JSON.stringify(profile), this.ctx.storage.sql.exec<{ generation: number }>('SELECT generation FROM credential_snapshot WHERE id = 1').one().generation);
  }

  /** Retryable two-authority migration; no public state is returned before both halves agree. */
  async ensureInference(): Promise<InferenceState> {
    if (this.legacyCredentialConflict()) throw new Error('Legacy credentials were written after inference cutover; protected forward repair is required');
    if (this.ctx.storage.sql.exec<{ version: number }>('SELECT version FROM inference_migration WHERE id = 1').one().version === 1) return this.inferenceState();
    if (this.inferenceMigration) return this.inferenceMigration;
    this.inferenceMigration = this.migrateInference();
    try { return await this.inferenceMigration; } finally { this.inferenceMigration = null; }
  }

  private async migrateInference(): Promise<InferenceState> {
    const config = this.config();
    if (!config) throw new Error('Account credential vault is unavailable');
    const settings = (this.env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(config.user_id);
    const prepared = await settings.prepareInferenceMigration();
    const projects = await (this.env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(config.user_id).list();
    this.ctx.storage.transactionSync(() => {
      const scoped = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inference_credentials'").toArray().length > 0;
      if (!scoped) {
        // Renaming preserves rowids, encrypted AAD and every existing refresh lease.
        this.ctx.storage.sql.exec('ALTER TABLE oauth_credentials RENAME TO inference_credentials');
        this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS credentials_profile ON inference_credentials(profile_id, provider, state)');
      } else if (this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_credentials'").toArray().length
        && this.ctx.storage.sql.exec('SELECT id FROM oauth_credentials LIMIT 1').toArray().length) {
        throw new Error('Legacy credentials were written after inference cutover; protected forward repair is required');
      }
      this.ensureDefaultProfile();
      const migration = this.ctx.storage.sql.exec<{ settings_generation: number | null }>('SELECT settings_generation FROM inference_migration WHERE id = 1').one();
      if (migration.settings_generation === null) {
        const profile = this.requireInferenceProfile(DEFAULT_INFERENCE_PROFILE_ID);
        profile.settings = prepared.settings;
        this.ctx.storage.sql.exec('UPDATE inference_profiles SET profile_json = ? WHERE profile_id = ?', JSON.stringify(profile), profile.id);
        this.ctx.storage.sql.exec('UPDATE inference_migration SET settings_generation = ? WHERE id = 1', prepared.generation);
      } else if (migration.settings_generation !== prepared.generation) throw new Error('Inference migration settings changed; forward repair is required');
      for (const project of projects) if (project.lifecycle !== 'deleting') this.ensureProjectInference(project.id);
    });
    await settings.finishInferenceMigration(prepared.generation);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE inference_migration SET version = 1 WHERE id = 1');
      this.inferenceChanged();
    });
    return this.inferenceState();
  }

  private inferenceState(): InferenceState {
    return {
      version: 1,
      revision: this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM inference_migration WHERE id = 1').one().revision,
      profiles: this.ctx.storage.sql.exec<InferenceProfileRow>('SELECT * FROM inference_profiles WHERE deleted_at IS NULL ORDER BY rowid').toArray().map(row => JSON.parse(row.profile_json) as InferenceProfile),
      assignments: this.ctx.storage.sql.exec<{ project_id: string; profile_id: string; revision: number }>('SELECT project_id, profile_id, revision FROM inference_assignments ORDER BY project_id').toArray()
        .map(row => ({ projectId: row.project_id, profileId: row.profile_id, revision: row.revision })),
    };
  }

  private requireInferenceProfile(profileId: string): InferenceProfile {
    const row = this.ctx.storage.sql.exec<InferenceProfileRow>('SELECT * FROM inference_profiles WHERE profile_id = ? AND deleted_at IS NULL', profileId).toArray()[0];
    if (!row) throw new Error('Inference profile is unavailable');
    return JSON.parse(row.profile_json) as InferenceProfile;
  }

  private inferenceChanged(): void {
    this.ctx.storage.sql.exec('UPDATE inference_migration SET revision = revision + 1 WHERE id = 1');
    if (this.ctx.storage.sql.exec<{ version: number }>('SELECT version FROM inference_migration WHERE id = 1').one().version === 1) {
      this.inferenceChanges.mark('inference');
      this.ctx.waitUntil(Promise.resolve().then(() => this.inferenceChanges.wake()));
    }
    const config = this.config();
    if (config) {
      const revision = this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM inference_migration WHERE id = 1').one().revision;
      this.ctx.waitUntil((this.env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(config.user_id).inferenceChanged(revision));
    }
  }

  async createInferenceProfile(input: z.infer<typeof inferenceCreateInputSchema>): Promise<InferenceState> {
    const parsed = inferenceCreateInputSchema.parse(input);
    await this.ensureInference();
    return this.ctx.storage.transactionSync(() => {
      const source = this.requireInferenceProfile(parsed.sourceProfileId ?? DEFAULT_INFERENCE_PROFILE_ID);
      const now = new Date().toISOString();
      const profile: InferenceProfile = { ...source, id: crypto.randomUUID(), name: parsed.name, revision: 0, createdAt: now, updatedAt: now };
      this.ctx.storage.sql.exec('INSERT INTO inference_profiles(profile_id, profile_json, credential_generation) VALUES (?, ?, 0)', profile.id, JSON.stringify(profile));
      this.inferenceChanged();
      return this.inferenceState();
    });
  }

  async updateInferenceProfile(input: z.infer<typeof inferenceUpdateInputSchema>): Promise<InferenceWriteResult> {
    const validated = inferenceUpdateInputSchema.safeParse(input);
    if (!validated.success) throw new Error('Inference settings are invalid; keep credentials in the profile provider vault');
    const parsed = validated.data;
    await this.ensureInference();
    return this.ctx.storage.transactionSync(() => {
      const profile = this.requireInferenceProfile(parsed.profileId);
      if (profile.revision !== parsed.expectedRevision) return { status: 'conflict', resource: 'inference-profile', expected: parsed.expectedRevision, actual: profile.revision };
      const next: InferenceProfile = { ...profile, name: parsed.name, settings: parsed.settings, revision: profile.revision + 1, updatedAt: new Date().toISOString() };
      this.ctx.storage.sql.exec('UPDATE inference_profiles SET profile_json = ? WHERE profile_id = ?', JSON.stringify(next), profile.id);
      this.inferenceChanged();
      return { status: 'ok', value: this.inferenceState() };
    });
  }

  async deleteInferenceProfile(input: z.infer<typeof inferenceDeleteInputSchema>): Promise<InferenceWriteResult> {
    const parsed = inferenceDeleteInputSchema.parse(input);
    await this.ensureInference();
    return this.ctx.storage.transactionSync(() => {
      const profile = this.requireInferenceProfile(parsed.profileId);
      if (profile.revision !== parsed.expectedRevision) return { status: 'conflict', resource: 'inference-profile', expected: parsed.expectedRevision, actual: profile.revision };
      if (profile.id === DEFAULT_INFERENCE_PROFILE_ID) throw new Error('Default inference profile cannot be deleted');
      // Projects that used this profile move to Default rather than refusing the delete.
      this.ctx.storage.sql.exec('UPDATE inference_assignments SET profile_id = ?, revision = revision + 1 WHERE profile_id = ?', DEFAULT_INFERENCE_PROFILE_ID, profile.id);
      this.ctx.storage.sql.exec('UPDATE inference_profiles SET deleted_at = ?, credential_generation = credential_generation + 1 WHERE profile_id = ?', new Date().toISOString(), profile.id);
      this.ctx.storage.sql.exec("UPDATE inference_credentials SET state = 'disabled' WHERE profile_id = ?", profile.id);
      this.inferenceChanged();
      return { status: 'ok', value: this.inferenceState() };
    });
  }

  async assignInferenceProfile(input: z.infer<typeof inferenceAssignInputSchema>): Promise<InferenceWriteResult> {
    const parsed = inferenceAssignInputSchema.parse(input);
    await this.ensureInference();
    await this.requireInferenceProject(parsed.projectId);
    return this.ctx.storage.transactionSync(() => {
      this.requireInferenceProfile(parsed.profileId);
      if (this.ctx.storage.sql.exec('SELECT project_id FROM inference_deleted_projects WHERE project_id = ?', parsed.projectId).toArray().length) throw new Error('Project has been deleted');
      const current = this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM inference_assignments WHERE project_id = ?', parsed.projectId).toArray()[0];
      if (!current) throw new Error('Project inference assignment is unavailable');
      if (current.revision !== parsed.expectedRevision) return { status: 'conflict', resource: 'inference-assignment', expected: parsed.expectedRevision, actual: current.revision };
      this.ctx.storage.sql.exec('UPDATE inference_assignments SET profile_id = ?, revision = revision + 1 WHERE project_id = ?', parsed.profileId, parsed.projectId);
      this.inferenceChanged();
      return { status: 'ok', value: this.inferenceState() };
    });
  }

  private async requireInferenceProject(projectId: string): Promise<void> {
    const config = this.config();
    if (!config) throw new Error('Account credential vault is unavailable');
    const authority = await requireConfigurationProject(this.env, config.user_id, projectId);
    const project = await authority.getProject();
    if (!project || project.id !== projectId || project.lifecycle === 'deleting') throw new Error('Project is unavailable');
  }


  bootstrap(input: { userId: string; rootPublicKey: string; vaultKey: string }): CredentialVaultResult<{ userId: string }> {
    let rootPublicKey: Uint8Array;
    let vaultKey: Uint8Array;
    try {
      rootPublicKey = credentialProtocolBase64.decode(input.rootPublicKey);
      vaultKey = credentialProtocolBase64.decode(input.vaultKey);
    } catch {
      return publicError('INVALID_BOOTSTRAP', 'Vault bootstrap input is invalid');
    }
    if (!input.userId || rootPublicKey.byteLength !== 32 || vaultKey.byteLength !== 32) {
      return publicError('INVALID_BOOTSTRAP', 'Vault bootstrap input is invalid');
    }
    const existing = this.ctx.storage.sql.exec<{ user_id: string }>('SELECT user_id FROM vault_config WHERE id = 1').toArray()[0];
    if (existing) {
      return existing.user_id === input.userId
        ? { status: 'ok', value: { userId: existing.user_id } }
        : publicError('VAULT_ALREADY_BOOTSTRAPPED', 'Vault belongs to another user');
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO vault_config(id, user_id, root_public_key, vault_key, created_at) VALUES (1, ?, ?, ?, ?)',
      input.userId,
      input.rootPublicKey,
      input.vaultKey,
      new Date().toISOString(),
    );
    this.deviceCredentialsChanged();
    return { status: 'ok', value: { userId: input.userId } };
  }

  /** The one read per-request authentication makes: each isolate caches it (`device-authority.ts`). */
  deviceRegistrySnapshot(): DeviceRegistrySnapshot | null {
    const config = this.config();
    if (!config) return null;
    const machines = this.ctx.storage.sql.exec<MachineRow>(
      'SELECT machine_id, signing_public_key, exchange_public_key, capabilities_json, generation, grant_json FROM credential_devices',
    ).toArray().flatMap((row) => machineCredential(row) ?? []);
    return { userId: config.user_id, rootPublicKey: config.root_public_key, machines, devices: this.listDeviceGrants() };
  }

  /** The same checks the worker runs on its snapshot, over this vault's current rows. */
  private verifier(): DeviceVerifier {
    const config = this.config();
    return new DeviceVerifier(config ? {
      userId: config.user_id,
      rootPublicKey: config.root_public_key,
      machine: (machineId) => {
        const row = this.ctx.storage.sql.exec<MachineRow>(
          'SELECT machine_id, signing_public_key, exchange_public_key, capabilities_json, generation, grant_json FROM credential_devices WHERE machine_id = ?', machineId,
        ).toArray()[0];
        return row ? machineCredential(row) : null;
      },
      device: (deviceId) => this.deviceGrant(deviceId),
    } : null);
  }

  registerDevice(input: SignedCredentialAuthorityGrant): CredentialVaultResult<{ machineId: string; generation: number }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    let grant;
    try {
      grant = verifyCredentialAuthorityGrant(input, credentialProtocolBase64.decode(config.root_public_key), Date.now(), (deviceId) => this.deviceGrant(deviceId));
      if (!grant || grant.userId !== config.user_id) return publicError('INVALID_DEVICE_GRANT', 'Device grant is invalid');
      if (credentialProtocolBase64.decode(grant.signingPublicKey).byteLength !== 32 || credentialProtocolBase64.decode(grant.exchangePublicKey).byteLength !== 32) {
        return publicError('INVALID_DEVICE_GRANT', 'Device grant keys are invalid');
      }
    } catch {
      return publicError('INVALID_DEVICE_GRANT', 'Device grant is invalid');
    }
    const current = this.ctx.storage.sql.exec<{ generation: number }>(
      'SELECT generation FROM credential_devices WHERE machine_id = ?',
      grant.machineId,
    ).toArray()[0];
    if (current && current.generation >= grant.generation) {
      return publicError('STALE_DEVICE_GRANT', 'Device grant generation is stale');
    }
    this.ctx.storage.sql.exec(`
      INSERT INTO credential_devices(machine_id, signing_public_key, exchange_public_key, capabilities_json, generation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET
        signing_public_key = excluded.signing_public_key,
        exchange_public_key = excluded.exchange_public_key,
        capabilities_json = excluded.capabilities_json,
        generation = excluded.generation,
        updated_at = excluded.updated_at
    `, grant.machineId, grant.signingPublicKey, grant.exchangePublicKey, JSON.stringify(grant.capabilities), grant.generation, new Date().toISOString());
    this.ctx.storage.sql.exec('UPDATE credential_devices SET grant_json = ? WHERE machine_id = ?', JSON.stringify(input), grant.machineId);
    this.deviceCredentialsChanged();
    return { status: 'ok', value: { machineId: grant.machineId, generation: grant.generation } };
  }
  registerManagedDevice(input: {
    userId: string;
    machineId: string;
    signingPublicKey: string;
    exchangePublicKey: string;
    capabilities: Array<'storage.access' | 'space.control' | 'credential.access'>;
  }): CredentialVaultResult<{ machineId: string; generation: number }> {
    const config = this.config();
    if (!config || input.userId !== config.user_id || !input.machineId || input.capabilities.length === 0) {
      return publicError('INVALID_MANAGED_DEVICE', 'Managed device input is invalid');
    }
    try {
      if (credentialProtocolBase64.decode(input.signingPublicKey).byteLength !== 32 || credentialProtocolBase64.decode(input.exchangePublicKey).byteLength !== 32) {
        return publicError('INVALID_MANAGED_DEVICE', 'Managed device keys are invalid');
      }
    } catch {
      return publicError('INVALID_MANAGED_DEVICE', 'Managed device keys are invalid');
    }
    const current = this.ctx.storage.sql.exec<{ generation: number }>('SELECT generation FROM credential_devices WHERE machine_id = ?', input.machineId).toArray()[0];
    const generation = (current?.generation ?? 0) + 1;
    this.ctx.storage.sql.exec(`
      INSERT INTO credential_devices(machine_id, signing_public_key, exchange_public_key, capabilities_json, generation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET signing_public_key = excluded.signing_public_key,
        exchange_public_key = excluded.exchange_public_key, capabilities_json = excluded.capabilities_json,
        generation = excluded.generation, updated_at = excluded.updated_at
    `, input.machineId, input.signingPublicKey, input.exchangePublicKey, JSON.stringify(input.capabilities), generation, new Date().toISOString());
    this.ctx.storage.sql.exec('UPDATE credential_devices SET grant_json = NULL WHERE machine_id = ?', input.machineId);
    this.deviceCredentialsChanged();
    return { status: 'ok', value: { machineId: input.machineId, generation } };
  }
  rootPublicKey(): string | null {
    return this.config()?.root_public_key ?? null;
  }
  /** Root-signed account operations (bootstrap, enrollment, recovery, revocation) are rare and stay here. */
  authorizeRoot(header: string | null, target: string): CredentialVaultResult<{ authorized: true }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const verified = verifyRelayAuthorization({
      header,
      signingPublicKey: config.root_public_key,
      target,
      maxSkewMs: SIGNED_REQUEST_MAX_AGE_MS,
    });
    if (verified.status === 'ok') return { status: 'ok', value: { authorized: true } };
    return verified.error.expired ? publicError(SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE) : publicError('ROOT_UNAUTHORIZED', verified.error.message);
  }

  /** Browser-only account management this vault still owns: invitations, pairing and MCP setup. */
  private authorizeBrowserRequest(input: { header: string | null; target: string; body: Uint8Array; capabilities: DeviceCapability[] }): CredentialVaultResult<{ deviceId: string }> {
    const authorized = this.verifier().authorizeRequest({ ...input, method: 'POST', browserOnly: true, accountScope: true }, Date.now());
    return authorized.status === 'ok' ? { status: 'ok', value: { deviceId: authorized.value.device.deviceId } } : { status: 'error', error: authorized.error };
  }

  /** Current tenant-local authority, including issuer revocation and expiration. */
  private currentDeviceGrant(deviceId: string): VerifiedDevice | null {
    const config = this.config();
    if (!config || config.user_id !== this.env.ACCOUNT_ID || config.root_public_key !== this.env.AUTH_PUBLIC_KEY) return null;
    return this.verifier().device(deviceId, Date.now());
  }
  private mcpAccessRow() {
    return this.ctx.storage.sql.exec<{ revision: number; device_id: string | null; sealed_key: string | null; token_hash: string | null; updated_at: string }>(
      'SELECT revision, device_id, sealed_key, token_hash, updated_at FROM mcp_access WHERE id = 1',
    ).toArray()[0];
  }

  private mcpAccessView(): McpAccessView {
    const row = this.mcpAccessRow();
    const record = row?.device_id ? this.deviceGrant(row.device_id) : null;
    return {
      revision: row?.revision ?? 0, enabled: !!row?.token_hash,
      active: !!row?.token_hash && !!row.device_id && !!this.currentDeviceGrant(row.device_id),
      endpoint: new URL('/mcp', this.env.ACCOUNT_URL).href, deviceId: row?.device_id ?? null,
      scope: record?.invite.invite.scope ?? null, capabilities: record?.invite.invite.capabilities ?? [],
      expiresAt: record ? deviceGrantExpiresAt(record) : null, updatedAt: row?.updated_at ?? null,
    };
  }

  private async mcpTokenHash(token: string): Promise<string> {
    return credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
  }

  /** Browser-only setup; no signing material is ever returned to the caller. */
  async mcpAccessRequest(input: { operation: McpAccessOperation; header: string | null; target: string; body: Uint8Array }): Promise<McpAccessResult> {
    const schema = input.operation === 'enable' ? mcpAccessEnableRequestSchema : input.operation === 'status' ? mcpAccessStatusRequestSchema : mcpAccessChangeRequestSchema;
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(input.body)));
    const config = this.config();
    if (!parsed.success || !config || parsed.data.userId !== config.user_id || config.user_id !== this.env.ACCOUNT_ID || config.root_public_key !== this.env.AUTH_PUBLIC_KEY) {
      return publicError('INVALID_MCP_ACCESS', 'MCP setup belongs to another account or is invalid');
    }
    const authorized = this.authorizeBrowserRequest({ ...input, capabilities: ['devices.manage'] });
    if (authorized.status === 'error') return authorized;
    if (input.operation === 'status') return { status: 'ok', value: this.mcpAccessView() };
    const change = mcpAccessChangeRequestSchema.parse({ userId: parsed.data.userId, expectedRevision: 'expectedRevision' in parsed.data ? parsed.data.expectedRevision : undefined });
    const revision = this.mcpAccessRow()?.revision ?? 0;
    if (revision !== change.expectedRevision) return publicError('MCP_ACCESS_CONFLICT', 'MCP access changed; reload before trying again');
    let binding: DeviceBinding | undefined;
    let invite: SignedDeviceInvite | undefined;
    let sealedKey: string | undefined;
    let token: string | undefined;
    let tokenHash: string | undefined;
    if (input.operation === 'enable') {
      if (this.mcpAccessRow()?.token_hash) return publicError('MCP_ALREADY_ENABLED', 'Disable existing MCP access before enabling a new grant');
      invite = mcpAccessEnableRequestSchema.parse(parsed.data).invite;
      const issuer = this.currentDeviceGrant(authorized.value.deviceId);
      if (!issuer?.canDelegate || invite.issuer.kind !== 'device' || invite.issuer.deviceId !== issuer.deviceId
        || invite.invite.userId !== config.user_id || invite.invite.kind !== 'client' || invite.invite.canDelegate) {
        return publicError('RPC_FORBIDDEN', 'MCP requires a non-delegating client invitation from this browser');
      }
      const privateKey = ed25519.utils.randomSecretKey();
      binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(),
        signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey)),
        label: 'GitSpace MCP', boundAt: Date.now(), signingPrivateKey: privateKey });
      const key = encodeApiKey({ version: 2, userId: config.user_id, deviceId: binding.deviceId,
        signingPrivateKey: credentialProtocolBase64.encode(privateKey),
        rpcUrl: new URL('/rpc', this.env.ACCOUNT_URL).href, enrollUrl: new URL('/v1/devices/enroll', this.env.ACCOUNT_URL).href });
      sealedKey = await sealVaultText(key, credentialProtocolBase64.decode(config.vault_key), `mcp:${binding.deviceId}`);
    }
    if (input.operation !== 'disable') {
      token = credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
      tokenHash = await this.mcpTokenHash(token);
    }
    // Crypto yields: revalidate authority and revision immediately before the synchronous transaction.
    const revalidated = this.authorizeBrowserRequest({ ...input, capabilities: ['devices.manage'] });
    if (revalidated.status === 'error') return revalidated;
    if ((this.mcpAccessRow()?.revision ?? 0) !== revision) return publicError('MCP_ACCESS_CONFLICT', 'MCP access changed; reload before trying again');
    const row = this.mcpAccessRow();
    if (input.operation === 'rotate' && (!row?.token_hash || !row.device_id || !this.currentDeviceGrant(row.device_id))) {
      return publicError('MCP_NOT_ACTIVE', 'Enable an active MCP grant before rotating its token');
    }
    const result: McpAccessResult = this.ctx.storage.transactionSync(() => {
      if (invite && binding) {
        const enrolled = this.enrollDevice({ invite, binding });
        if (enrolled.status === 'error') return enrolled;
      }
      if (input.operation === 'disable' && row?.device_id) this.recordDeviceRevocation(row.device_id);
      this.ctx.storage.sql.exec(`
        INSERT INTO mcp_access(id, revision, device_id, sealed_key, token_hash, updated_at) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,device_id=excluded.device_id,sealed_key=excluded.sealed_key,token_hash=excluded.token_hash,updated_at=excluded.updated_at
      `, revision + 1, binding?.deviceId ?? row?.device_id ?? null,
      input.operation === 'disable' ? null : sealedKey ?? row?.sealed_key ?? null,
      tokenHash ?? null, new Date().toISOString());
      return { status: 'ok', value: { ...this.mcpAccessView(), ...(token ? { token } : {}) } };
    });
    if (result.status === 'ok' && input.operation === 'disable' && row?.device_id) await this.env.RELAY.getByName(this.env.RELAY_NAME).serviceRevokeDevice(row.device_id);
    return result;
  }

  /** Internal DO RPC only. Authenticate the bearer before decrypting signing material. */
  async resolveMcpAccess(token: string): Promise<{ key: string; device: VerifiedDevice } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const hash = await this.mcpTokenHash(token);
    const row = this.mcpAccessRow();
    if (!row?.token_hash || !row.device_id || !row.sealed_key || hash.length !== row.token_hash.length) return null;
    let difference = 0;
    for (let index = 0; index < hash.length; index++) difference |= hash.charCodeAt(index) ^ row.token_hash.charCodeAt(index);
    if (difference) return null;
    const config = this.config();
    if (!config || !this.currentDeviceGrant(row.device_id)) return null;
    const key = await openVaultText(row.sealed_key, credentialProtocolBase64.decode(config.vault_key), `mcp:${row.device_id}`);
    const current = this.mcpAccessRow();
    const device = this.currentDeviceGrant(row.device_id);
    if (current?.revision !== row.revision || !device || device.kind !== 'client') return null;
    return { key, device };
  }

  browserInvitationRequest(input: { operation: string; header: string | null; target: string; body: Uint8Array }): CredentialVaultResult<BrowserInvitationValue> {
    const config = this.config();
    if (!config || input.body.byteLength > REQUEST_MAX_BYTES) return publicError('INVALID_BROWSER_INVITATION', 'Browser invitation request is invalid');
    const body = JSON.parse(new TextDecoder().decode(input.body));
    const parsed = input.operation === 'create' ? browserInvitationCreateSchema.parse(body) : browserInvitationReferenceSchema.parse(body);
    if (parsed.userId !== config.user_id) return publicError('INVALID_BROWSER_INVITATION', 'Browser invitation belongs to another account');
    const authorized = this.authorizeBrowserRequest({ ...input, capabilities: ['devices.manage'] });
    if (authorized.status === 'error') return authorized;
    const issuer = this.deviceGrant(authorized.value.deviceId)!;
    if (!issuer.invite.invite.canDelegate) return publicError('RPC_FORBIDDEN', 'Browser may not delegate access');
    const now = Date.now();
    if ('invite' in parsed) {
      const signed = parsed.invite;
      const invite = signed.invite;
      if (signed.issuer.kind !== 'device' || signed.issuer.deviceId !== authorized.value.deviceId
        || invite.userId !== config.user_id || invite.kind !== 'browser' || invite.scope.kind !== 'user') {
        return publicError('INVALID_DEVICE_INVITE', 'Browser invitation must belong to this account and issuing browser');
      }
      const parent = verifyDeviceGrantRecord(issuer, credentialProtocolBase64.decode(config.root_public_key), now, (deviceId) => this.deviceGrant(deviceId), 1);
      if (!parent || !verifyDeviceInvite(signed, parent.signingPublicKey)
        || !invite.capabilities.every((capability) => parent.capabilities.includes(capability))) {
        return publicError('INVALID_DEVICE_INVITE', 'Browser invitation is invalid or exceeds its issuer authority');
      }
      if (invite.expiresAt <= now) return publicError('DEVICE_INVITE_EXPIRED', 'Browser invitation has expired');
      if (invite.issuedAt > now + ENROLLMENT_CLOCK_SKEW_MS || invite.expiresAt <= invite.issuedAt
        || invite.expiresAt - invite.issuedAt > BROWSER_INVITATION_TTL_MS || invite.expiresAt > now + BROWSER_INVITATION_TTL_MS) {
        return publicError('INVALID_DEVICE_INVITE', 'Browser invitation lifetime must not exceed five minutes');
      }
      let ancestor: DeviceGrantRecord | null = issuer;
      let authorityExpiresAt = Infinity;
      while (ancestor) {
        authorityExpiresAt = Math.min(authorityExpiresAt, deviceGrantExpiresAt(ancestor) ?? Infinity);
        ancestor = ancestor.invite.issuer.kind === 'device' ? this.deviceGrant(ancestor.invite.issuer.deviceId) : null;
      }
      if (authorityExpiresAt !== Infinity && (invite.grantTtlMs === null || invite.expiresAt + invite.grantTtlMs > authorityExpiresAt)) {
        return publicError('INVALID_DEVICE_INVITE', 'Browser access may not outlive its issuer authority');
      }
      if (this.ctx.storage.sql.exec('SELECT device_id FROM device_grants WHERE invite_id = ?', invite.inviteId).toArray().length
        || this.browserInvitation(invite.inviteId, now)) {
        return publicError('DEVICE_INVITE_EXISTS', 'Browser invitation was already registered or redeemed');
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO browser_invitations(invite_id, creator_device_id, invite_payload, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
        invite.inviteId, authorized.value.deviceId, credentialProtocolBase64.encode(deviceInvitePayload(invite)), invite.expiresAt,
      );
      return { status: 'ok', value: { inviteId: invite.inviteId, expiresAt: invite.expiresAt, status: 'pending', deviceId: null } };
    }
    const invitation = this.browserInvitation(parsed.inviteId, now);
    if (!invitation) return publicError('BROWSER_INVITATION_UNAVAILABLE', 'Browser invitation is unavailable');
    if (input.operation === 'cancel' && invitation.status === 'pending') {
      this.ctx.storage.sql.exec("UPDATE browser_invitations SET status = 'cancelled' WHERE invite_id = ? AND status = 'pending'", invitation.invite_id);
      invitation.status = 'cancelled';
    }
    return { status: 'ok', value: { inviteId: invitation.invite_id, expiresAt: invitation.expires_at, status: invitation.status, deviceId: invitation.device_id } };
  }

  private browserInvitation(inviteId: string, now: number): BrowserInvitationRow | null {
    this.ctx.storage.sql.exec("UPDATE browser_invitations SET status = 'expired' WHERE invite_id = ? AND status = 'pending' AND expires_at <= ?", inviteId, now);
    return this.ctx.storage.sql.exec<BrowserInvitationRow>('SELECT * FROM browser_invitations WHERE invite_id = ?', inviteId).toArray()[0] ?? null;
  }

  /** No lock: every transition is a conditional write made with no await between its read and write, and a poll that
   * waits on the settings and fleet objects re-reads the pairing before it marks it enrolled. */
  async machinePairingRequest(input: { operation: string; header: string | null; target: string; body: Uint8Array; apiUrl: string }): Promise<CredentialVaultResult<MachinePairingValue>> {
    const config = this.config();
    if (!config || input.body.byteLength > REQUEST_MAX_BYTES) return publicError('INVALID_PAIRING', 'Pairing request is invalid');
    const body = JSON.parse(new TextDecoder().decode(input.body)) as Record<string, unknown>;
    if (body.userId !== config.user_id) return publicError('INVALID_PAIRING', 'Pairing belongs to another account');
    const browserOperation = ['create', 'inspect', 'approve', 'cancel'].includes(input.operation);
    let browserDeviceId: string | undefined;
    if (browserOperation) {
      const authorized = this.authorizeBrowserRequest({ ...input, capabilities: PAIRING_CAPABILITIES });
      if (authorized.status === 'error') return authorized;
      browserDeviceId = authorized.value.deviceId;
    }
    const now = Date.now();
    if (input.operation === 'create') {
      const issuer = this.deviceGrant(browserDeviceId!)!;
      if (!issuer.invite.invite.canDelegate) return publicError('PAIRING_FORBIDDEN', 'Browser may not delegate machine access');
      const pairingId = crypto.randomUUID();
      const token = credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
      const tokenHash = credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
      // The limit check and the insert run with no await between them.
      this.ctx.storage.sql.exec('DELETE FROM machine_pairings WHERE expires_at <= ?', now);
      const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM machine_pairings WHERE creator_device_id = ? AND state != 'cancelled'", browserDeviceId!).one().count;
      if (count >= 5) return publicError('PAIRING_LIMIT', 'Too many active pairing sessions');
      const expiresAt = now + MACHINE_PAIRING_TTL_MS;
      this.ctx.storage.sql.exec("INSERT INTO machine_pairings(pairing_id, creator_device_id, token_hash, expires_at, state) VALUES (?, ?, ?, ?, 'created')", pairingId, browserDeviceId!, tokenHash, expiresAt);
      return { status: 'ok', value: { pairingId, token, expiresAt } };
    }
    const pairingId = z.uuid().parse(body.pairingId);
    const row = this.ctx.storage.sql.exec<PairingRow>('SELECT * FROM machine_pairings WHERE pairing_id = ?', pairingId).toArray()[0];
    if (!row || row.expires_at <= now || row.state === 'cancelled') return publicError('PAIRING_UNAVAILABLE', 'Pairing is expired, cancelled or unavailable');
    let machine = row.machine_json ? pairingMachineSchema.parse(JSON.parse(row.machine_json)) : null;
    if (!browserOperation) {
      const header = input.header ? decodeSignedRpcHeader(input.header) : null;
      const claimant = input.operation === 'claim' ? pairingMachineSchema.parse({
        machineId: body.machineId, label: body.label, signingPublicKey: body.signingPublicKey, exchangePublicKey: body.exchangePublicKey,
      }) : machine;
      if (!claimant || !header || header.deviceId !== pairingId) return publicError('PAIRING_UNAUTHORIZED', 'Machine proof is missing');
      let signingPublicKey: Uint8Array;
      try {
        signingPublicKey = credentialProtocolBase64.decode(claimant.signingPublicKey);
        if (signingPublicKey.byteLength !== 32 || credentialProtocolBase64.decode(claimant.exchangePublicKey).byteLength !== 32) throw new Error('Invalid keys');
      } catch {
        return publicError('PAIRING_UNAUTHORIZED', 'Machine keys are invalid');
      }
      if (!verifyRpcSignature(header, { method: 'POST', path: input.target, body: input.body }, signingPublicKey)) return publicError('PAIRING_UNAUTHORIZED', 'Machine proof does not match request');
      if (Math.abs(now - header.timestamp) > SIGNED_REQUEST_MAX_AGE_MS) return publicError(SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE);
      if (input.operation === 'claim') {
        if (machine && row.state !== 'created' && claimant.machineId === machine.machineId && claimant.label === machine.label
          && claimant.signingPublicKey === machine.signingPublicKey && claimant.exchangePublicKey === machine.exchangePublicKey) {
          return { status: 'ok', value: { pairingId, state: row.state } };
        }
        if (row.state !== 'created' || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(body.token)) return publicError('PAIRING_USED', 'Pairing token has already been claimed');
        const tokenHash = credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.token))));
        if (tokenHash !== row.token_hash) return publicError('PAIRING_UNAUTHORIZED', 'Pairing token is invalid');
        if (this.ctx.storage.sql.exec('SELECT machine_id FROM credential_devices WHERE machine_id = ?', claimant.machineId).toArray().length) return publicError('MACHINE_EXISTS', 'Choose a new machine identity');
        const changed = this.ctx.storage.sql.exec("UPDATE machine_pairings SET state = 'claimed', machine_json = ?, token_hash = '' WHERE pairing_id = ? AND state = 'created' AND expires_at > ?", JSON.stringify(claimant), pairingId, Date.now()).rowsWritten;
        return changed === 1 ? { status: 'ok', value: { pairingId, state: 'claimed' } } : publicError('PAIRING_USED', 'Pairing token is expired or already claimed');
      }
    }
    const issuerChain: DeviceGrantRecord[] = [];
    let issuerId: string | null = row.creator_device_id;
    while (issuerId && issuerChain.length < 4) {
      const issuer = this.deviceGrant(issuerId);
      if (!issuer || issuerChain.some((record) => record.binding.deviceId === issuerId)) return publicError('PAIRING_FORBIDDEN', 'Browser issuer chain is unavailable');
      issuerChain.push(issuer);
      issuerId = issuer.invite.issuer.kind === 'device' ? issuer.invite.issuer.deviceId : null;
    }
    if (issuerId) return publicError('PAIRING_FORBIDDEN', 'Browser issuer chain is too deep');
    const expiresAt = Math.min(row.expires_at + 365 * 24 * 60 * 60_000, ...issuerChain.map((record) => deviceGrantExpiresAt(record) ?? Infinity));
    const grant: CredentialAuthorityGrant | null = machine ? {
      version: 1, userId: config.user_id, machineId: machine.machineId,
      signingPublicKey: machine.signingPublicKey, exchangePublicKey: machine.exchangePublicKey,
      capabilities: ['storage.access', 'space.control', 'credential.access'],
      generation: 1, issuerDeviceId: row.creator_device_id, expiresAt,
    } : null;
    if (input.operation === 'inspect') return { status: 'ok', value: { pairingId, state: row.state, expiresAt: row.expires_at, machine, grant, issuerChain } };
    if (input.operation === 'cancel') {
      if (row.state === 'enrolled') return publicError('PAIRING_USED', 'Machine is enrolled; revoke it from the fleet');
      if (machine && row.state === 'approved') this.removeManagedDevice(machine.machineId);
      this.ctx.storage.sql.exec("UPDATE machine_pairings SET state = 'cancelled', token_hash = '' WHERE pairing_id = ?", pairingId);
      return { status: 'ok', value: { pairingId, state: 'cancelled' } };
    }
    if (input.operation === 'approve') {
      if (row.state !== 'claimed' || !grant) return publicError('PAIRING_NOT_CLAIMED', 'Pairing must be claimed before approval');
      const signed = signedCredentialAuthorityGrantSchema.parse(body.grant);
      if (credentialProtocolBase64.encode(credentialAuthorityGrantPayload(signed.grant)) !== credentialProtocolBase64.encode(credentialAuthorityGrantPayload(grant))) return publicError('PAIRING_GRANT_MISMATCH', 'Approval does not match the claimed machine');
      return this.ctx.storage.transactionSync(() => {
        const registered = this.registerDevice(signed);
        if (registered.status === 'error') return registered;
        this.ctx.storage.sql.exec("UPDATE machine_pairings SET state = 'approved', grant_json = ? WHERE pairing_id = ? AND state = 'claimed'", JSON.stringify(signed), pairingId);
        return { status: 'ok', value: { pairingId, state: 'approved' } };
      });
    }
    if (input.operation !== 'poll' || !machine) return publicError('INVALID_PAIRING', 'Unknown pairing operation');
    if (row.state === 'claimed') return { status: 'ok', value: { state: 'pending' } };
    if ((row.state !== 'approved' && row.state !== 'enrolled') || !row.grant_json) return publicError('PAIRING_UNAVAILABLE', 'Pairing is not approved');
    const signed = signedCredentialAuthorityGrantSchema.parse(JSON.parse(row.grant_json));
    const authorized = this.verifier().authorizeRelayGrant(signed, 'space.control', Date.now());
    if (authorized.status === 'error') return { status: 'error', error: authorized.error };
    const settings = await (this.env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(config.user_id).get(machine.machineId);
    const handle = settings.profile.handle;
    if (!handle) return publicError('ACCOUNT_UNPROVISIONED', 'Account tenant is not provisioned');
    const relayUrl = `https://${handle}.gssh.dev`;
    if (row.state === 'approved') await (this.env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(config.user_id).putMachine({
      id: machine.machineId, label: machine.label, state: 'offline', rpcEndpoint: `${relayUrl}/tunnel/${encodeURIComponent(machine.machineId)}/rpc`,
      kind: 'physical', provider: 'physical', notes: '', desiredState: 'online', lifecycleRevision: signed.grant.generation, operationId: null, error: null,
    });
    // Retrieval is retryable for the same proof-bound grant until the original
    // short expiry; a lost HTTP response never strands a newly enrolled CLI.
    // The pairing may have been cancelled while this poll waited on the settings and fleet objects.
    const latest = this.ctx.storage.sql.exec<PairingRow>('SELECT * FROM machine_pairings WHERE pairing_id = ?', pairingId).toArray()[0];
    if (!latest || latest.expires_at <= Date.now()) return publicError('PAIRING_UNAVAILABLE', 'Pairing has expired');
    if (latest.state !== 'approved' && latest.state !== 'enrolled') return publicError('PAIRING_UNAVAILABLE', 'Pairing was cancelled; start a new pairing from the browser');
    this.ctx.storage.sql.exec("UPDATE machine_pairings SET state = 'enrolled' WHERE pairing_id = ? AND state = 'approved'", pairingId);
    return { status: 'ok', value: {
      state: 'enrolled', userId: config.user_id, handle, accountUrl: `https://${handle}.gitspace.sh`, relayUrl,
      apiUrl: input.apiUrl, rootPublicKey: config.root_public_key, machineId: machine.machineId, grant: signed,
    } };
  }
  removeManagedDevice(machineId: string): void {
    this.ctx.storage.sql.exec("UPDATE credential_devices SET capabilities_json = '[]', updated_at = ? WHERE machine_id = ?", new Date().toISOString(), machineId);
    this.deviceCredentialsChanged();
  }

  /**
   * Redeem a signed invite with a device binding. Delegated browser invites
   * must also be pending in this vault. First bind wins; registering the
   * device and consuming that invitation commit together. The vault never
   * signs anything here; it records what the issuer and device signed.
   */
  enrollDevice(input: { invite: SignedDeviceInvite; binding: DeviceBinding }): CredentialVaultResult<{ deviceId: string; expiresAt: number | null }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const invite = input.invite.invite;
    const now = Date.now();
    if (invite.userId !== config.user_id) return publicError('INVALID_DEVICE_INVITE', 'Device invite is invalid');
    if (invite.expiresAt <= now) return publicError('DEVICE_INVITE_EXPIRED', 'Device invite has expired');
    if (!verifyDeviceBinding(input.binding) || input.binding.inviteId !== invite.inviteId) return publicError('INVALID_DEVICE_BINDING', 'Device binding is invalid');
    if (Math.abs(input.binding.boundAt - now) > ENROLLMENT_CLOCK_SKEW_MS) return publicError('INVALID_DEVICE_BINDING', 'Device binding clock is out of range');
    const record: DeviceGrantRecord = { invite: input.invite, binding: input.binding, generation: 1, revokedAt: null };
    // The whole chain is checked here exactly as machines check it later: root
    // signature, or a delegating issuer that is itself valid and holds what it hands out.
    const rootPublicKey = credentialProtocolBase64.decode(config.root_public_key);
    if (!verifyDeviceGrantRecord(record, rootPublicKey, now, (deviceId) => this.deviceGrant(deviceId))) return publicError('INVALID_DEVICE_INVITE', 'Device invite is invalid or its issuer cannot delegate it');
    const invitation = this.browserInvitation(invite.inviteId, now);
    if (invite.kind === 'browser' && input.invite.issuer.kind === 'device' && !invitation) {
      return publicError('BROWSER_INVITATION_UNREGISTERED', 'Browser invitation is not registered');
    }
    if (invitation) {
      if (input.invite.issuer.kind !== 'device' || invitation.creator_device_id !== input.invite.issuer.deviceId
        || invitation.invite_payload !== credentialProtocolBase64.encode(deviceInvitePayload(invite))) {
        return publicError('INVALID_DEVICE_INVITE', 'Browser invitation does not match its registration');
      }
      if (invitation.status === 'cancelled') return publicError('DEVICE_INVITE_CANCELLED', 'Browser invitation was cancelled');
      if (invitation.status === 'expired') return publicError('DEVICE_INVITE_EXPIRED', 'Browser invitation has expired');
      if (invitation.status === 'redeemed') return publicError('DEVICE_INVITE_USED', 'Browser invitation was already redeemed');
    }
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          'INSERT INTO device_grants(device_id, invite_id, kind, record_json, generation, revoked_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, ?)',
          input.binding.deviceId, invite.inviteId, invite.kind, JSON.stringify(record), new Date(now).toISOString(),
        );
        if (invitation) this.ctx.storage.sql.exec("UPDATE browser_invitations SET status = 'redeemed', device_id = ? WHERE invite_id = ? AND status = 'pending'", input.binding.deviceId, invite.inviteId);
      });
    } catch {
      return publicError('DEVICE_INVITE_USED', 'Device invite was already redeemed');
    }
    this.deviceCredentialsChanged();
    return { status: 'ok', value: { deviceId: input.binding.deviceId, expiresAt: deviceGrantExpiresAt(record) } };
  }
  private deviceGrant(deviceId: string): DeviceGrantRecord | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string; generation: number; revoked_at: number | null }>(
      'SELECT record_json, generation, revoked_at FROM device_grants WHERE device_id = ?', deviceId,
    ).toArray()[0];
    return row ? { ...(JSON.parse(row.record_json) as DeviceGrantRecord), generation: row.generation, revokedAt: row.revoked_at } : null;
  }
  listDeviceGrants(): DeviceGrantRecord[] {
    return this.ctx.storage.sql.exec<{ record_json: string; generation: number; revoked_at: number | null }>(
      'SELECT record_json, generation, revoked_at FROM device_grants ORDER BY updated_at',
    ).toArray().map((row) => ({ ...(JSON.parse(row.record_json) as DeviceGrantRecord), generation: row.generation, revokedAt: row.revoked_at }));
  }
  async revokeDeviceGrant(deviceId: string): Promise<CredentialVaultResult<{ deviceId: string; revokedAt: number }>> {
    // Machines paired through this browser lose their credential with it: detach them like any revoked machine.
    const paired = this.ctx.storage.sql.exec<{ machine_id: string }>('SELECT machine_id FROM credential_devices WHERE grant_json IS NOT NULL').toArray()
      .map((row) => row.machine_id).filter((machineId) => this.verifier().machine(machineId, Date.now()) !== null);
    const result = this.recordDeviceRevocation(deviceId);
    if (result.status === 'error') return result;
    await this.env.RELAY.getByName(this.env.RELAY_NAME).serviceRevokeDevice(deviceId);
    for (const machineId of paired) {
      if (!this.verifier().machine(machineId, Date.now())) await releaseMachineAttachments(this.env, this.env.ACCOUNT_ID, machineId, 'machine-revoked');
    }
    return result;
  }
  private recordDeviceRevocation(deviceId: string): CredentialVaultResult<{ deviceId: string; revokedAt: number }> {
    const revokedAt = Date.now();
    const row = this.ctx.storage.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM device_grants WHERE device_id = ?', deviceId).toArray()[0];
    if (!row) return publicError('DEVICE_NOT_FOUND', 'Device is not enrolled');
    if (row.revoked_at !== null) return { status: 'ok', value: { deviceId, revokedAt: row.revoked_at } };
    this.ctx.storage.sql.exec(
      'UPDATE device_grants SET revoked_at = ?, generation = generation + 1, updated_at = ? WHERE device_id = ?',
      revokedAt, new Date(revokedAt).toISOString(), deviceId,
    );
    this.deviceCredentialsChanged();
    return { status: 'ok', value: { deviceId, revokedAt } };
  }

  providerSecretMetadata(provider: 'composio'): { configured: boolean; revision: number; updatedAt: string | null } {
    const row = this.providerSecretRow(provider);
    return { configured: row !== undefined, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null };
  }

  async putProviderSecret(provider: 'composio', value: string): Promise<{ configured: true; revision: number; updatedAt: string }> {
    const config = this.config();
    const normalized = value.trim();
    if (!config || normalized.length < 16 || normalized.length > 8_192) throw new Error('Provider credential is invalid');
    const revision = (this.providerSecretRow(provider)?.revision ?? 0) + 1;
    const updatedAt = new Date().toISOString();
    const sealed = await sealVaultText(normalized, credentialProtocolBase64.decode(config.vault_key), `provider:${provider}\n${revision}`);
    this.ctx.storage.sql.exec(`
      INSERT INTO provider_secrets(provider, sealed_json, revision, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET sealed_json=excluded.sealed_json,revision=excluded.revision,updated_at=excluded.updated_at
    `, provider, sealed, revision, updatedAt);
    return { configured: true, revision, updatedAt };
  }

  async getProviderSecret(provider: 'composio'): Promise<string | null> {
    const config = this.config();
    const row = this.providerSecretRow(provider);
    if (!config || !row) return null;
    return openVaultText(row.sealed_json, credentialProtocolBase64.decode(config.vault_key), `provider:${provider}\n${row.revision}`);
  }

  deleteProviderSecret(provider: 'composio'): { deleted: boolean } {
    return { deleted: this.ctx.storage.sql.exec('DELETE FROM provider_secrets WHERE provider = ?', provider).rowsWritten === 1 };
  }

  /** The App's secrets from its manifest conversion, sealed; the private key never leaves the vault. */
  async putGitHubApp(input: GitHubAppSecrets): Promise<void> {
    await importGitHubAppPrivateKey(input.privateKey);
    if (!input.webhookSecret || !input.clientSecret) throw new Error('GitHub sent incomplete App credentials');
    await this.storeGitHubApp(input, this.githubAppRow()?.revision ?? 0);
  }

  /** A ten-minute App JWT signed with the stored key; callers exchange it with GitHub, never the key itself. */
  async githubAppJwt(): Promise<string> {
    const secrets = await this.openGitHubApp();
    return signGitHubAppJwt(await importGitHubAppPrivateKey(secrets.privateKey), secrets.appId);
  }

  /** False without an App, so a tenant that never created one accepts no deliveries. */
  async verifyGitHubWebhook(body: Uint8Array<ArrayBuffer>, signature: string): Promise<boolean> {
    if (!this.githubAppRow()) return false;
    return verifyGitHubSignature((await this.openGitHubApp()).webhookSecret, body, signature);
  }

  /** Exchanges a reader's GitHub App user-authorization code for their token, sealed with their login and expiry into
   * the cookie that carries it. The vault keeps nothing. The sealing context binds the cookie to this App. */
  async sealGitHubReader(clientId: string, code: string, redirectUri: string): Promise<{ sealed: string; expiresAt: number }> {
    const config = this.config();
    if (!config) throw new Error('This account has no credential vault');
    const secrets = await this.openGitHubApp();
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'GitSpace' },
      body: JSON.stringify({ client_id: clientId, client_secret: secrets.clientSecret, code, redirect_uri: redirectUri }),
    });
    const answer = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().optional() })
      .safeParse(await response.json().catch(() => null));
    if (!response.ok || !answer.success) throw new Error('GitHub did not accept this sign-in. Open the shared link again.');
    const user = await githubRequest('/user', { token: answer.data.access_token, schema: z.object({ login: z.string().min(1) }) });
    const expiresAt = Date.now() + Math.min(answer.data.expires_in ?? GITHUB_READER_SECONDS, GITHUB_READER_SECONDS) * 1000;
    const session = JSON.stringify({ token: answer.data.access_token, login: user.login, expiresAt });
    return { sealed: await sealVaultText(session, credentialProtocolBase64.decode(config.vault_key), `github-reader:${secrets.appId}`), expiresAt };
  }

  /** The reader a cookie names, or null when it is malformed, sealed for another App, or expired. */
  async openGitHubReader(sealed: string): Promise<{ token: string; login: string } | null> {
    const config = this.config();
    const row = this.githubAppRow();
    if (!config || !row) return null;
    try {
      const opened = await openVaultText(sealed, credentialProtocolBase64.decode(config.vault_key), `github-reader:${row.app_id}`);
      const session = githubReaderSessionSchema.parse(JSON.parse(opened));
      return session.expiresAt > Date.now() ? { token: session.token, login: session.login } : null;
    } catch {
      return null;
    }
  }

  /** Switches to a key generated on GitHub only once GitHub accepts a JWT it signed and names this same App. */
  async rotateGitHubAppKey(privateKey: string): Promise<void> {
    const revision = this.githubAppRow()?.revision ?? 0;
    const current = await this.openGitHubApp();
    const token = await signGitHubAppJwt(await importGitHubAppPrivateKey(privateKey), current.appId);
    const app = await githubRequest('/app', { token, schema: z.object({ id: z.number() }) }).catch((error: unknown) => {
      throw new Error(`GitHub did not accept this private key, so the current key stays. ${error instanceof Error ? error.message : String(error)}`);
    });
    if (app.id !== current.appId) throw new Error('This private key belongs to a different GitHub App, so the current key stays');
    await this.storeGitHubApp({ ...current, privateKey }, revision);
  }

  private githubAppRow(): GitHubAppSecretRow | undefined {
    return this.ctx.storage.sql.exec<GitHubAppSecretRow>(
      'SELECT app_id, sealed_private_key, sealed_webhook_secret, sealed_client_secret, revision FROM github_app_secrets WHERE id = 1',
    ).toArray()[0];
  }

  private async openGitHubApp(): Promise<GitHubAppSecrets> {
    const config = this.config();
    const row = this.githubAppRow();
    if (!config || !row) throw new Error('This account has no GitHub App');
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const [privateKey, webhookSecret, clientSecret] = await Promise.all([
      openVaultText(row.sealed_private_key, vaultKey, githubSecretContext(row.app_id, 'private-key', row.revision)),
      openVaultText(row.sealed_webhook_secret, vaultKey, githubSecretContext(row.app_id, 'webhook-secret', row.revision)),
      openVaultText(row.sealed_client_secret, vaultKey, githubSecretContext(row.app_id, 'client-secret', row.revision)),
    ]);
    return { appId: row.app_id, privateKey, webhookSecret, clientSecret };
  }

  /** Seals all three under the next revision; the write happens only if no other write landed while sealing. */
  private async storeGitHubApp(secrets: GitHubAppSecrets, expectedRevision: number): Promise<void> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const revision = expectedRevision + 1;
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const [privateKey, webhookSecret, clientSecret] = await Promise.all([
      sealVaultText(secrets.privateKey.trim(), vaultKey, githubSecretContext(secrets.appId, 'private-key', revision)),
      sealVaultText(secrets.webhookSecret, vaultKey, githubSecretContext(secrets.appId, 'webhook-secret', revision)),
      sealVaultText(secrets.clientSecret, vaultKey, githubSecretContext(secrets.appId, 'client-secret', revision)),
    ]);
    if ((this.githubAppRow()?.revision ?? 0) !== expectedRevision) throw new Error('The GitHub App credentials changed meanwhile; try again');
    this.ctx.storage.sql.exec(`
      INSERT INTO github_app_secrets(id, app_id, sealed_private_key, sealed_webhook_secret, sealed_client_secret, revision, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id, sealed_private_key=excluded.sealed_private_key, sealed_webhook_secret=excluded.sealed_webhook_secret,
        sealed_client_secret=excluded.sealed_client_secret, revision=excluded.revision, updated_at=excluded.updated_at
    `, secrets.appId, privateKey, webhookSecret, clientSecret, revision, new Date().toISOString());
  }

  async putCredential(input: { id: string; credential: StoredOAuthCredential }): Promise<CredentialVaultResult<{ id: string; revision: number }>> {
    if (this.inferenceCutover()) return publicError('INFERENCE_SCOPE_REQUIRED', 'Use profile-scoped credential management');
    if (!this.config() || !input.id || !credentialUploadSchema.safeParse({ provider: input.credential.provider, credential: { ...input.credential, type: 'oauth' } }).success) {
      return publicError('INVALID_CREDENTIAL', 'Credential input is invalid');
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const revision = await this.storeCredential(input.id, input.credential);
      return { status: 'ok' as const, value: { id: input.id, revision } };
    });
  }

  private async storeCredential(id: string, credential: StoredVaultCredential, profileId = DEFAULT_INFERENCE_PROFILE_ID): Promise<number> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const scoped = this.inferenceCutover();
    const table = scoped ? 'inference_credentials' : 'oauth_credentials';
    const revision = (this.credential(id, profileId)?.revision ?? 0) + 1;
    const sealed = await sealVaultCredential(credential, credentialProtocolBase64.decode(config.vault_key), id, revision);
    this.ctx.storage.transactionSync(() => {
      if (scoped !== this.inferenceCutover()) throw new Error('Credential scope migrated; retry through profile management');
      this.ctx.storage.sql.exec(`
        INSERT INTO ${table}(rowid, id, provider, sealed_json, revision, expires_at, state, updated_at, profile_id, account_json)
        VALUES ((SELECT MAX(row_id) + 1 FROM (SELECT MAX(rowid) AS row_id FROM ${table} UNION ALL SELECT row_id FROM retired_credential_rowid)), ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider, sealed_json = excluded.sealed_json, revision = excluded.revision,
          expires_at = excluded.expires_at, state = 'active', updated_at = excluded.updated_at, account_json = excluded.account_json
          WHERE ${table}.profile_id = excluded.profile_id
      `, id, credential.provider, sealed, revision, credential.type === 'api_key' ? 0 : credential.expires, new Date().toISOString(), profileId, JSON.stringify(credentialAccount(credential)));
      this.credentialsChanged(profileId);
    });
    return revision;
  }


  /** Internal DO RPC; the caller must authorize workspace scope before obtaining a capability. */
  async sealRuntimeGrant(secret: string, scope: { projectId: string; workspaceId: string; attachmentId: string; generation: number }): Promise<string> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    return sealVaultText(secret, credentialProtocolBase64.decode(config.vault_key), JSON.stringify(['runtime-grant/v1', config.user_id, scope.projectId, scope.workspaceId, scope.attachmentId, scope.generation]));
  }

  async openRuntimeGrant(ciphertext: string, scope: { projectId: string; workspaceId: string; attachmentId: string; generation: number }): Promise<string> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    return openVaultText(ciphertext, credentialProtocolBase64.decode(config.vault_key), JSON.stringify(['runtime-grant/v1', config.user_id, scope.projectId, scope.workspaceId, scope.attachmentId, scope.generation]));
  }

  /** Passive runtime reads never initialize profiles, unseal credentials, or repair account health. */
  cloudInferenceCatalog(projectId: string): CloudInferenceCatalog | null {
    if (!this.config() || this.ctx.storage.sql.exec<{ version: number }>('SELECT version FROM inference_migration WHERE id = 1').one().version !== 1) return null;
    const assignment = this.ctx.storage.sql.exec<{ profile_id: string; revision: number }>('SELECT profile_id, revision FROM inference_assignments WHERE project_id = ?', projectId).toArray()[0];
    if (!assignment) return null;
    const row = this.ctx.storage.sql.exec<InferenceProfileRow>('SELECT * FROM inference_profiles WHERE profile_id = ? AND deleted_at IS NULL', assignment.profile_id).toArray()[0];
    if (!row) return null;
    const accounts = this.ctx.storage.sql.exec<{ row_id: number; provider: string; revision: number; expires_at: number }>("SELECT rowid AS row_id, provider, revision, expires_at FROM inference_credentials WHERE profile_id = ? AND state = 'active' ORDER BY rowid", assignment.profile_id).toArray();
    return {
      profile: JSON.parse(row.profile_json) as InferenceProfile,
      assignmentRevision: assignment.revision,
      accounts: accounts.map(account => ({
        id: String(account.row_id), provider: account.provider, revision: account.revision,
        type: account.expires_at === 0 ? 'api_key' : 'oauth',
        expiresAt: account.expires_at === 0 ? null : account.expires_at, identity: null,
      })),
    };
  }

  async resolveCloudInference(projectId: string, profileId?: string) {
    await this.ensureInference();
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const assignment = this.ctx.storage.sql.exec<{ profile_id: string; revision: number }>('SELECT profile_id, revision FROM inference_assignments WHERE project_id = ?', projectId).toArray()[0];
    if (!assignment && !profileId) throw new Error('Project inference assignment is unavailable');
    const profile = this.requireInferenceProfile(profileId ?? assignment!.profile_id);
    this.assertProfileAccess(profile.id);
    return { projectId, assignmentRevision: assignment?.revision ?? null, profile };
  }

  async cloudCredentialAccounts(profileId: string, provider?: string): Promise<CredentialAccount[]> {
    await this.ensureInference();
    this.assertProfileAccess(profileId);
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    this.ensureCloudAccountHealth();
    const rows = this.ctx.storage.sql.exec<ProfileCredentialRow>("SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM inference_credentials WHERE profile_id = ? AND state = 'active' ORDER BY rowid", profileId).toArray();
    const now = Date.now();
    const result = await Promise.all(rows.filter(row => provider === undefined || row.provider === provider).map(async row => {
      const credential = await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key));
      const { usage, out } = accountHealth(this.ctx.storage.sql.exec<AccountHealthRow>('SELECT credential_id, cooldown_until, cooldown_reason, report_json FROM cloud_account_health WHERE profile_id = ? AND credential_id = ?', profileId, String(row.row_id)).toArray()[0], now);
      return { id: String(row.row_id), provider: row.provider, type: credential.type === 'api_key' ? 'api_key' as const : 'oauth' as const, revision: row.revision, expiresAt: credential.type === 'api_key' ? null : credential.expires, identity: credentialIdentity(credential), ...(out ? { cooldownUntil: out.until } : {}), ...(usage ? { usage } : {}) };
    }));
    this.assertProfileAccess(profileId);
    return result;
  }

  async cloudResolveCredential(input: { profileId: string; credentialId: string; forceRefresh?: boolean }): Promise<ResolvedCredential> {
    await this.ensureInference();
    this.assertProfileAccess(input.profileId);
    const config = this.config();
    const rowId = Number(input.credentialId);
    if (!config || !Number.isSafeInteger(rowId) || rowId <= 0) throw new Error('Credential is unavailable');
    let row = this.ctx.storage.sql.exec<ProfileCredentialRow>("SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM inference_credentials WHERE profile_id = ? AND rowid = ? AND state = 'active'", input.profileId, rowId).toArray()[0];
    if (!row) throw new Error('Credential is unavailable');
    let credential = await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key));
    if (credential.type !== 'api_key' && (input.forceRefresh || credential.expires <= Date.now() + ACCESS_REFRESH_SKEW_MS)) {
      await this.refreshProfileCredential(input.profileId, rowId);
      const refreshed = this.ctx.storage.sql.exec<ProfileCredentialRow>("SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM inference_credentials WHERE profile_id = ? AND rowid = ? AND state = 'active'", input.profileId, rowId).toArray()[0];
      if (!refreshed) throw new Error('Credential was revoked during refresh');
      row = refreshed;
      credential = await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key));
    }
    this.assertProfileAccess(input.profileId);
    const current = this.credential(row.id, input.profileId);
    if (!current || current.state !== 'active' || current.revision !== row.revision) throw new Error('Credential changed during resolution');
    // Pi's providers derive request auth themselves (e.g. GitHub Copilot's per-account endpoint, Kimi's headers).
    const auth = credential.type !== 'api_key' && isUpstreamOAuthProvider(credential.provider) ? await upstreamRequestAuth(credential.provider, credential) : null;
    const headers = auth?.headers ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : null;
    return { id: input.credentialId, provider: credential.provider, revision: row.revision, credential: credential.type === 'api_key'
      ? { type: 'api_key', key: credential.key }
      : { type: 'oauth', access: auth?.apiKey ?? credential.access, expires: credential.expires, ...(credential.accountId ? { accountId: credential.accountId } : {}), ...(credential.projectId ? { projectId: credential.projectId } : {}), ...(credential.email ? { email: credential.email } : {}), ...(credential.orgId ? { orgId: credential.orgId } : {}), ...(auth?.baseUrl ? { baseUrl: auth.baseUrl } : {}), ...(headers ? { headers } : {}) } };
  }

  async cloudProviders(profileId: string): Promise<ProviderView[]> {
    await this.ensureInference();
    this.assertProfileAccess(profileId);
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    this.ensureCloudAccountHealth();
    const health = new Map(this.ctx.storage.sql.exec<AccountHealthRow>('SELECT credential_id, cooldown_until, cooldown_reason, report_json FROM cloud_account_health WHERE profile_id = ?', profileId).toArray().map(row => [row.credential_id, row]));
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec<ProfileCredentialRow & { account_json: string | null }>('SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at, account_json FROM inference_credentials WHERE profile_id = ? ORDER BY rowid', profileId).toArray();
    const accounts = await Promise.all(rows.map(async row => {
      let account = row.account_json === null ? null : SignedInAccountSchema.parse(JSON.parse(row.account_json));
      // A credential stored before accounts were recorded, or recorded without a name, is opened to record its account.
      if (!account || (account.type === 'oauth' && account.email === null && account.identity === null)) {
        account = credentialAccount(await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key)));
        this.ctx.storage.sql.exec('UPDATE inference_credentials SET account_json = ? WHERE rowid = ? AND revision = ?', JSON.stringify(account), row.row_id, row.revision);
      }
      return { id: String(row.row_id), provider: row.provider, ...account, disabled: row.state !== 'active' };
    }));
    this.assertProfileAccess(profileId);
    const descriptors = describeCloudProviders(this.requireInferenceProfile(profileId).settings);
    const providers = new Set<string>([...descriptors.map(provider => provider.id), ...accounts.map(account => account.provider)]);
    return [...providers].map(provider => {
      const owned = accounts.filter(account => account.provider === provider);
      const active = owned.filter(account => !account.disabled);
      const descriptor = descriptors.find(item => item.id === provider);
      const oauth = descriptor?.supportsOAuth ?? false;
      return { id: provider, credentialProvider: descriptor?.credentialProvider ?? provider, name: descriptor?.name ?? provider, available: descriptor !== undefined, loginable: oauth || descriptor?.supportsApiKey === true,
        supportsOAuth: oauth, supportsApiKey: descriptor?.supportsApiKey ?? false,
        authKind: active.some(account => account.type === 'oauth') ? 'oauth' : active.length ? 'api_key' : 'none',
        hasAuth: active.length > 0, source: active.length ? 'Inference profile' : null, hasUsage: ['anthropic', 'openai-codex', 'cursor', 'google-antigravity'].includes(provider),
        accounts: owned.map(account => {
          const { out } = accountHealth(health.get(account.id), now);
          return { id: account.id, type: account.type, label: accountLabel(account.id, account), email: account.email, disabled: account.disabled, outUntil: out ? new Date(out.until).toISOString() : null, outReason: out?.reason ?? null };
        }) };
    });
  }

  async cloudUsage(profileId: string, providerId: string | null, refresh = false): Promise<ProviderUsage> {
    const accounts = await this.cloudCredentialAccounts(profileId, providerId ?? undefined);
    const result: { generatedAt: string; reports: ProviderUsage['reports'][number][]; accountsWithoutUsage: string[]; errors: ProviderUsage['errors'][number][] } = { generatedAt: new Date().toISOString(), reports: [], accountsWithoutUsage: [], errors: [] };
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    await Promise.all(accounts.map(async account => {
      const cached = this.ctx.storage.sql.exec<{ observed_at: number; report_json: string | null; error: string | null }>('SELECT observed_at, report_json, error FROM cloud_account_health WHERE profile_id = ? AND credential_id = ?', profileId, account.id).toArray()[0];
      if (!refresh && cached && Date.now() - cached.observed_at < 60_000) {
        if (cached.report_json) result.reports.push(providerUsageReportSchema.parse(JSON.parse(cached.report_json)));
        else result.accountsWithoutUsage.push(account.identity ?? `${account.provider}:${account.id}`);
        if (cached.error) result.errors.push({ provider: account.provider, message: cached.error });
        return;
      }
      try {
        const row = this.ctx.storage.sql.exec<ProfileCredentialRow>("SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM inference_credentials WHERE profile_id = ? AND rowid = ? AND state = 'active'", profileId, Number(account.id)).toArray()[0];
        if (!row) throw new Error('Account is no longer active');
        const credential = await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key));
        if (credential.type === 'api_key') throw new Error('Usage reporting is unavailable for this API key');
        const report = await collectUsage(credential);
        this.assertProfileAccess(profileId);
        if (this.credential(row.id, profileId)?.state !== 'active') return;
        this.ctx.storage.sql.exec('INSERT INTO cloud_account_health(profile_id, credential_id, cooldown_until, observed_at, report_json, error) VALUES (?, ?, 0, ?, ?, NULL) ON CONFLICT(profile_id, credential_id) DO UPDATE SET observed_at = excluded.observed_at, report_json = excluded.report_json, error = NULL', profileId, account.id, Date.now(), JSON.stringify(report));
        result.reports.push(report);
      } catch (error) {
        // Which way the provider's usage read failed, so the screen says what is wrong; inference is unaffected.
        const reason = error instanceof ProviderUsageError ? `the provider's usage read was ${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}` : error instanceof Error ? error.message : String(error);
        const message = `Usage reporting is unavailable: ${reason}; inference remains enabled`;
        this.ctx.storage.sql.exec('INSERT INTO cloud_account_health(profile_id, credential_id, cooldown_until, observed_at, report_json, error) VALUES (?, ?, 0, ?, NULL, ?) ON CONFLICT(profile_id, credential_id) DO UPDATE SET observed_at = excluded.observed_at, report_json = NULL, error = excluded.error', profileId, account.id, Date.now(), message);
        result.accountsWithoutUsage.push(account.identity ?? `${account.provider}:${account.id}`);
        result.errors.push({ provider: account.provider, message });
      }
    }));
    this.assertProfileAccess(profileId);
    return result;
  }

  private cloudAccountHealthReady = false;
  private ensureCloudAccountHealth(): void {
    if (this.cloudAccountHealthReady) return;
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS cloud_account_health(profile_id TEXT NOT NULL, credential_id TEXT NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0, observed_at INTEGER NOT NULL DEFAULT 0, report_json TEXT, error TEXT, cooldown_reason TEXT, PRIMARY KEY(profile_id, credential_id))');
    // Health recorded before a cooldown kept its reason.
    if (!this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(cloud_account_health)').toArray().some(column => column.name === 'cooldown_reason')) this.ctx.storage.sql.exec('ALTER TABLE cloud_account_health ADD COLUMN cooldown_reason TEXT');
    this.cloudAccountHealthReady = true;
  }

  /** Takes an account out until the provider's reset when it named one, up to a week (a used-up weekly window), else
   * for a short backoff; a used-up usage window keeps it out longer. Answers its label and when it is usable again. */
  async cloudCredentialFailure(input: AccountFailure): Promise<{ label: string; until: number }> {
    await this.ensureInference();
    this.assertProfileAccess(input.profileId);
    this.ensureCloudAccountHealth();
    const now = Date.now();
    const until = input.until === undefined ? now + (input.kind === 'rotate' ? 60_000 : 5_000) : Math.max(now + 1_000, Math.min(input.until, now + 7 * 24 * 3_600_000));
    const reason = input.reason.slice(0, 500) || (input.kind === 'rotate' ? 'The provider refused this account' : 'The provider rejected its sign-in');
    this.ctx.storage.sql.exec(`INSERT INTO cloud_account_health(profile_id, credential_id, cooldown_until, cooldown_reason) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, credential_id) DO UPDATE SET
      cooldown_reason = CASE WHEN excluded.cooldown_until >= cooldown_until THEN excluded.cooldown_reason ELSE cooldown_reason END, cooldown_until = MAX(cooldown_until, excluded.cooldown_until)`, input.profileId, input.credentialId, until, reason);
    const { out } = accountHealth(this.ctx.storage.sql.exec<AccountHealthRow>('SELECT credential_id, cooldown_until, cooldown_reason, report_json FROM cloud_account_health WHERE profile_id = ? AND credential_id = ?', input.profileId, input.credentialId).toArray()[0], now);
    const account = this.ctx.storage.sql.exec<{ account_json: string | null }>('SELECT account_json FROM inference_credentials WHERE profile_id = ? AND rowid = ?', input.profileId, Number(input.credentialId)).toArray()[0]?.account_json;
    return { label: accountLabel(input.credentialId, account ? SignedInAccountSchema.parse(JSON.parse(account)) : null), until: out?.until ?? until };
  }

  async cloudSetApiKey(input: { profileId: string; providerId: string; key: string }): Promise<void> {
    await this.ensureInference();
    this.assertProfileAccess(input.profileId);
    const descriptor = describeCloudProviders(this.requireInferenceProfile(input.profileId).settings).find(provider => provider.id === input.providerId);
    if (!descriptor?.supportsApiKey) throw new Error('This provider does not accept API-key credentials');
    await this.putBrowserApiKey(input.profileId, descriptor.credentialProvider, input.key);
  }

  async cloudModels(profileId: string) {
    const accounts = await this.cloudCredentialAccounts(profileId);
    const profile = this.requireInferenceProfile(profileId);
    return listCloudModels(profile.settings, accounts.map(account => account.provider));
  }

  private ensureCloudLoginStorage(): void {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_provider_logins (flow_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, provider TEXT NOT NULL, revision INTEGER NOT NULL, sealed_state TEXT NOT NULL, events_json TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  }

  private async scheduleLoginAlarm(at: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.getAlarm();
      const next = Math.max(Date.now() + 1_000, at);
      if (current === null || next < current) await this.ctx.storage.setAlarm(next);
    });
  }

  private scheduleLoginState(state: LoginState): Promise<void> {
    return this.scheduleLoginAlarm(Math.min(Date.parse(state.expiresAt), 'nextPollAt' in state ? Date.parse(state.nextPollAt) : Infinity));
  }

  async alarm(): Promise<void> {
    this.ensureCloudLoginStorage();
    const rows = this.ctx.storage.sql.exec<CloudLoginRow>("SELECT * FROM cloud_provider_logins WHERE status != 'done'").toArray();
    if (rows.length) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    for (const row of rows) {
      try {
        await this.advanceCloudLogin({ profileId: row.profile_id, flowId: row.flow_id });
      } catch {
        this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'done', sealed_state = '', events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND revision = ? AND status != 'done'", JSON.stringify({ type: 'done', ok: false, error: 'Authorization is no longer available; start a new login' }), row.flow_id, row.revision);
        this.loginChanged(row.flow_id);
      }
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const config = this.config();
      const pending = this.ctx.storage.sql.exec<CloudLoginRow>("SELECT * FROM cloud_provider_logins WHERE status != 'done'").toArray();
      let next = Infinity;
      for (const row of pending) {
        if (row.status === 'busy') { next = Math.min(next, Date.now() + 30_000); continue; }
        if (isUpstreamOAuthProvider(row.provider)) { next = Math.min(next, Date.now() + 20_000, row.expires_at); continue; }
        if (!config) throw new Error('Vault is not configured');
        const state = loginStateSchema.parse(JSON.parse(await openVaultText(row.sealed_state, credentialProtocolBase64.decode(config.vault_key), JSON.stringify(['provider-login/v1', row.profile_id, row.flow_id, row.revision]))));
        next = Math.min(next, Date.parse(state.expiresAt), 'nextPollAt' in state ? Date.parse(state.nextPollAt) : Infinity);
      }
      if (next === Infinity) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, next));
    });
  }

  private loginRow(profileId: string, flowId: string): CloudLoginRow {
    this.ensureCloudLoginStorage();
    this.assertProfileAccess(profileId);
    const row = this.ctx.storage.sql.exec<CloudLoginRow>('SELECT * FROM cloud_provider_logins WHERE flow_id = ? AND profile_id = ?', flowId, profileId).toArray()[0];
    if (!row) throw new Error('Login flow is unavailable');
    return row;
  }

  private async loginEventsForState(profileId: string, flowId: string, revision: number, state: LoginState): Promise<ProviderLoginEvent[]> {
    const view = publicLogin(state);
    switch (view.kind) {
      case 'code': return [{ type: 'auth', url: view.authorizationUrl, launchUrl: view.authorizationUrl, instructions: view.prompt }, { type: 'prompt', promptId: `${flowId}:${revision}`, message: view.prompt, placeholder: 'Paste the full authorization response' }];
      case 'project-input': return [{ type: 'prompt', promptId: `${flowId}:${revision}`, message: view.prompt, placeholder: 'Google Cloud project ID' }];
      case 'device': return [{ type: 'auth', url: view.authorizationUrl, launchUrl: view.authorizationUrl, instructions: `Enter code ${view.userCode}` }];
      case 'poll': return view.authorizationUrl ? [{ type: 'auth', url: view.authorizationUrl, launchUrl: view.authorizationUrl, instructions: 'Complete authorization in your browser' }] : [{ type: 'progress', message: 'Waiting for provider authorization' }];
      case 'cancelled': return [{ type: 'done', ok: false, error: 'Login cancelled' }];
      case 'complete': {
        const provider = (await this.cloudProviders(profileId)).find(provider => provider.id === view.provider);
        if (!provider) throw new Error('Authorized provider is unavailable');
        return [{ type: 'done', ok: true, provider }];
      }
    }
  }

  /** OpenAI identifies each installation ("agent host") by a stable UUID; one per GitSpace account. */
  private async agentHostId(): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`gitspace-agent-host/v1\n${this.env.ACCOUNT_ID}`)));
    digest[6] = (digest[6]! & 0x0f) | 0x40;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private async startUpstreamLogin(profileId: string, provider: UpstreamOAuthProvider): Promise<{ flowId: string }> {
    const flowId = crypto.randomUUID();
    const deviceId = await this.agentHostId();
    this.ensureCloudLoginStorage();
    this.assertProfileAccess(profileId);
    // Nothing secret persists for these flows: their state lives in this object's memory.
    this.ctx.storage.sql.exec("INSERT INTO cloud_provider_logins VALUES (?, ?, ?, 0, '', '[]', 'pending', ?)", flowId, profileId, provider, Date.now() + 15 * 60_000);
    const running: UpstreamLogin = { abort: new AbortController(), answer: null };
    this.upstreamLogins.set(flowId, running);
    const append = (event: ProviderLoginEvent) => {
      this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND status != 'done'", JSON.stringify(event), flowId);
      this.loginChanged(flowId);
    };
    const finish = (event: ProviderLoginEvent) => {
      this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'done', events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND status != 'done'", JSON.stringify(event), flowId);
      this.loginChanged(flowId);
    };
    void (async () => {
      try {
        const credential = await upstreamOAuth(provider).login({
          signal: running.abort.signal,
          notify: event => { const shown = upstreamLoginEvent(event); if (shown) append(shown); },
          prompt: prompt => {
            const { promise, resolve, reject } = Promise.withResolvers<string>();
            const cancel = () => reject(new Error('Login prompt was cancelled'));
            prompt.signal?.addEventListener('abort', cancel, { once: true });
            running.abort.signal.addEventListener('abort', cancel, { once: true });
            const revision = this.ctx.storage.sql.exec<{ revision: number }>("UPDATE cloud_provider_logins SET revision = revision + 1 WHERE flow_id = ? RETURNING revision", flowId).one().revision;
            const promptId = `${flowId}:${revision}`;
            running.answer = { promptId, resolve };
            append({ type: 'prompt', promptId, ...upstreamPromptText(prompt) });
            return promise;
          },
        }, { getDeviceId: () => deviceId });
        await this.ctx.blockConcurrencyWhile(async () => {
          if (this.loginRow(profileId, flowId).status === 'done') return;
          await this.uploadCredential(profileId, { provider, credential: { ...storedUpstreamCredential(provider, credential), type: 'oauth' } });
          const view = (await this.cloudProviders(profileId)).find(candidate => candidate.id === provider);
          finish(view ? { type: 'done', ok: true, provider: view } : { type: 'done', ok: false, error: 'Authorized provider is unavailable' });
        });
      } catch (error) {
        const reason = running.abort.signal.reason instanceof Error ? running.abort.signal.reason.message : null;
        finish({ type: 'done', ok: false, error: reason ?? `Sign-in failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 240)}` });
      } finally {
        this.upstreamLogins.delete(flowId);
      }
    })();
    // Alarms keep this object resident while the in-memory flow waits on the provider.
    await this.scheduleLoginAlarm(Date.now() + 20_000);
    return { flowId };
  }

  async cloudLoginStart(input: { profileId: string; providerId: string }): Promise<{ flowId: string }> {
    await this.ensureInference();
    this.assertProfileAccess(input.profileId);
    const descriptor = describeCloudProviders(this.requireInferenceProfile(input.profileId).settings).find(provider => provider.id === input.providerId);
    if (!descriptor?.supportsOAuth) throw new Error('This provider is unavailable for OAuth sign-in');
    if (isUpstreamOAuthProvider(input.providerId)) return this.startUpstreamLogin(input.profileId, input.providerId);
    const provider = gitspaceOAuthProviderSchema.parse(input.providerId);
    const transition = await beginLogin({ provider });
    this.assertProfileAccess(input.profileId);
    const flowId = crypto.randomUUID();
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const sealed = await sealVaultText(JSON.stringify(transition.state), credentialProtocolBase64.decode(config.vault_key), JSON.stringify(['provider-login/v1', input.profileId, flowId, 0]));
    const events = await this.loginEventsForState(input.profileId, flowId, 0, transition.state);
    this.ensureCloudLoginStorage();
    this.assertProfileAccess(input.profileId);
    this.ctx.storage.sql.exec("INSERT INTO cloud_provider_logins VALUES (?, ?, ?, 0, ?, ?, 'pending', ?)", flowId, input.profileId, provider, sealed, JSON.stringify(events), Date.parse(transition.state.expiresAt));
    await this.scheduleLoginState(transition.state);
    return { flowId };
  }

  /** A watching tab hears of every event the step appended. */
  private async advanceCloudLogin(input: { profileId: string; flowId: string }, response?: { promptId: string; value: string }): Promise<void> {
    const before = this.loginEventCount(input.flowId);
    try { await this.stepCloudLogin(input, response); }
    finally { if (this.loginEventCount(input.flowId) !== before) this.loginChanged(input.flowId); }
  }

  private async stepCloudLogin(input: { profileId: string; flowId: string }, response?: { promptId: string; value: string }): Promise<void> {
    const row = this.loginRow(input.profileId, input.flowId);
    if (row.status === 'done') return;
    if (isUpstreamOAuthProvider(row.provider)) {
      const running = this.upstreamLogins.get(row.flow_id);
      if (!running) {
        this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'done', events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND status != 'done'", JSON.stringify({ type: 'done', ok: false, error: 'Sign-in was interrupted; start again' }), row.flow_id);
        return;
      }
      if (row.expires_at <= Date.now()) { running.abort.abort(new Error('Login expired; start again')); return; }
      if (!response) return;
      if (!running.answer || running.answer.promptId !== response.promptId) throw new Error('Login prompt is no longer current');
      const { resolve } = running.answer;
      running.answer = null;
      // Retire the answered prompt so the dialog stops offering it.
      this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET revision = revision + 1, events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ?", JSON.stringify({ type: 'progress', message: 'Authorization response received' }), row.flow_id);
      resolve(loopbackCallback(response.value));
      return;
    }
    if (row.status === 'busy' && this.activeLoginAttempts.has(row.flow_id)) return;
    if (row.status === 'busy') {
      this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'done', sealed_state = '', events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND revision = ?", JSON.stringify({ type: 'done', ok: false, error: 'Authorization was interrupted; start a new login' }), row.flow_id, row.revision);
      return;
    }
    if (row.expires_at <= Date.now()) {
      this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'done', events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND revision = ?", JSON.stringify({ type: 'done', ok: false, error: 'Login expired; start again' }), row.flow_id, row.revision);
      return;
    }
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const state = loginStateSchema.parse(JSON.parse(await openVaultText(row.sealed_state, credentialProtocolBase64.decode(config.vault_key), JSON.stringify(['provider-login/v1', row.profile_id, row.flow_id, row.revision]))));
    if (response && response.promptId !== `${row.flow_id}:${row.revision}`) throw new Error('Login prompt is no longer current');
    if (!response && (state.kind === 'code' || state.kind === 'project-input' || state.kind === 'complete' || state.kind === 'cancelled')) return;
    if (!response && 'nextPollAt' in state && Date.parse(state.nextPollAt) > Date.now()) return;
    const claimed = this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'busy', events_json = CASE WHEN ? THEN json_insert(events_json, '$[#]', json(?)) ELSE events_json END WHERE flow_id = ? AND revision = ? AND status = 'pending'", response ? 1 : 0, JSON.stringify({ type: 'progress', message: 'Authorization response received' }), row.flow_id, row.revision).rowsWritten;
    if (!claimed) return;
    this.activeLoginAttempts.add(row.flow_id);
    try {
      // Commit a recovery wakeup before any non-replayable provider exchange.
      await this.scheduleLoginAlarm(Date.now() + 30_000);
      const transition = response ? await respondLogin(state, { code: response.value }) : await pollLogin(state);
      await this.ctx.blockConcurrencyWhile(async () => {
        const current = this.loginRow(row.profile_id, row.flow_id);
        if (current.status !== 'busy' || current.revision !== row.revision) return;
        if (transition.kind === 'complete') await this.uploadCredential(row.profile_id, { provider: transition.credential.provider, credential: { ...transition.credential, type: 'oauth' } });
        const revision = row.revision + 1;
        const sealed = await sealVaultText(JSON.stringify(transition.state), credentialProtocolBase64.decode(config.vault_key), JSON.stringify(['provider-login/v1', row.profile_id, row.flow_id, revision]));
        const events = await this.loginEventsForState(row.profile_id, row.flow_id, revision, transition.state);
        this.assertProfileAccess(row.profile_id);
        this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET revision = ?, sealed_state = ?, status = ?, events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND revision = ? AND status = 'busy'", revision, sealed, transition.kind === 'complete' ? 'done' : 'pending', JSON.stringify(events), row.flow_id, row.revision);
      });
      if (transition.kind !== 'complete') await this.scheduleLoginState(transition.state);
    } catch {
      this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'done', events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ? AND revision = ? AND status = 'busy'", JSON.stringify({ type: 'done', ok: false, error: 'Provider authorization failed; start a new login' }), row.flow_id, row.revision);
    } finally {
      this.activeLoginAttempts.delete(row.flow_id);
    }
  }

  async cloudLoginRespond(input: { profileId: string; flowId: string; promptId: string; value: string }): Promise<void> {
    await this.advanceCloudLogin(input, input);
  }

  cloudLoginCancel(input: { profileId: string; flowId: string }): void {
    const row = this.loginRow(input.profileId, input.flowId);
    if (row.status === 'done') return;
    this.ctx.storage.sql.exec("UPDATE cloud_provider_logins SET status = 'done', revision = revision + 1, sealed_state = '', events_json = json_insert(events_json, '$[#]', json(?)) WHERE flow_id = ?", JSON.stringify({ type: 'done', ok: false, error: 'Login cancelled' }), row.flow_id);
    this.loginChanged(row.flow_id);
    this.upstreamLogins.get(row.flow_id)?.abort.abort();
  }

  async cloudLoginEvents(input: { profileId: string; flowId: string; after?: number }): Promise<{ events: ProviderLoginEvent[]; done: boolean }> {
    await this.advanceCloudLogin(input);
    const row = this.loginRow(input.profileId, input.flowId);
    const stored = z.array(z.unknown()).parse(JSON.parse(row.events_json)).flat();
    const events = stored.map(value => {
      const decoded = ProviderLoginEventCodec.decode(value);
      if (!decoded.ok) throw new Error('Stored login event is malformed');
      if (decoded.value.type === 'prompt' && (row.status !== 'pending' || decoded.value.promptId !== `${row.flow_id}:${row.revision}`)) {
        return { type: 'progress' as const, message: 'Authorization response received' };
      }
      return decoded.value;
    });
    return { events: events.slice(input.after ?? 0), done: row.status === 'done' };
  }

  private loginEventCount(flowId: string): number {
    return this.ctx.storage.sql.exec<{ events: number }>('SELECT json_array_length(events_json) AS events FROM cloud_provider_logins WHERE flow_id = ?', flowId).toArray()[0]?.events ?? 0;
  }

  /** The flow gained events: a watching tab refetches them (`providers.login.events`). */
  private loginChanged(flowId: string): void {
    this.ctx.waitUntil(notifyBrowsers(this.env, [{ ...accountLiveKey(`provider-login:${flowId}`), version: this.loginEventCount(flowId) }]));
  }

  async putBrowserApiKey(profileId: string, provider: string, key: string): Promise<void> {
    await this.ensureInference();
    await this.ctx.blockConcurrencyWhile(() => this.uploadCredential(profileId, { provider, credential: { type: 'api_key', key } }));
  }

  /** Signing out a provider disables its active accounts; none is removed. */
  async logoutBrowserCredentials(profileId: string, provider: string): Promise<void> {
    await this.ensureInference();
    this.requireInferenceProfile(profileId);
    const rows = this.ctx.storage.sql.exec<{ row_id: number }>("SELECT rowid AS row_id FROM inference_credentials WHERE profile_id = ? AND provider = ? AND state = 'active'", profileId, provider).toArray();
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) this.disableCredentialRow(profileId, row.row_id);
    });
  }

  private providerAccount(profileId: string, provider: string, credentialId: string): { row_id: number; state: string; account_json: string | null } {
    const rowId = Number(credentialId);
    const row = Number.isSafeInteger(rowId) && rowId > 0
      ? this.ctx.storage.sql.exec<{ row_id: number; state: string; account_json: string | null }>('SELECT rowid AS row_id, state, account_json FROM inference_credentials WHERE profile_id = ? AND provider = ? AND rowid = ?', profileId, provider, rowId).toArray()[0]
      : undefined;
    if (!row) throw new Error('Account is unavailable');
    return row;
  }

  /** Inference stops using the account; its credential is kept for `enableProviderAccount`. */
  async disableProviderAccount(profileId: string, provider: string, credentialId: string): Promise<void> {
    await this.ensureInference();
    this.requireInferenceProfile(profileId);
    this.ctx.storage.transactionSync(() => { this.disableCredentialRow(profileId, this.providerAccount(profileId, provider, credentialId).row_id); });
  }

  /** Inference may use a disabled account again, under the same id. As an upload would, it supersedes another active
   * account of the same signed-in identity, or another API key. A failure's cooldown ends; a used-up usage window
   * still holds until its reset. */
  async enableProviderAccount(profileId: string, provider: string, credentialId: string): Promise<void> {
    await this.ensureInference();
    this.requireInferenceProfile(profileId);
    this.ensureCloudAccountHealth();
    this.ctx.storage.transactionSync(() => {
      const row = this.providerAccount(profileId, provider, credentialId);
      if (row.state === 'active') return;
      this.ctx.storage.sql.exec("UPDATE inference_credentials SET state = 'active', updated_at = ? WHERE profile_id = ? AND rowid = ?", new Date().toISOString(), profileId, row.row_id);
      this.ctx.storage.sql.exec('UPDATE cloud_account_health SET cooldown_until = 0, cooldown_reason = NULL WHERE profile_id = ? AND credential_id = ?', profileId, String(row.row_id));
      const account = row.account_json === null ? null : SignedInAccountSchema.parse(JSON.parse(row.account_json));
      const others = this.ctx.storage.sql.exec<{ row_id: number; account_json: string | null }>("SELECT rowid AS row_id, account_json FROM inference_credentials WHERE profile_id = ? AND provider = ? AND state = 'active' AND rowid != ?", profileId, provider, row.row_id).toArray();
      for (const other of others) {
        const current = other.account_json === null ? null : SignedInAccountSchema.parse(JSON.parse(other.account_json));
        if (account && current && (account.type === 'api_key' ? current.type === 'api_key' : account.identity !== null && current.identity === account.identity)) this.disableCredentialRow(profileId, other.row_id);
      }
      this.credentialsChanged(profileId);
    });
  }

  /** Deletes an account's credential for good; only its owner's explicit Remove does this. */
  async removeProviderAccount(profileId: string, provider: string, credentialId: string): Promise<void> {
    await this.ensureInference();
    this.requireInferenceProfile(profileId);
    this.ensureCloudAccountHealth();
    this.ctx.storage.transactionSync(() => {
      const { row_id: rowId } = this.providerAccount(profileId, provider, credentialId);
      this.ctx.storage.sql.exec('DELETE FROM cloud_account_health WHERE profile_id = ? AND credential_id = ?', profileId, String(rowId));
      this.ctx.storage.sql.exec('DELETE FROM inference_credentials WHERE profile_id = ? AND rowid = ?', profileId, rowId);
      // Account ids are rowids: never hand a removed account's id to a later upload.
      this.ctx.storage.sql.exec('INSERT INTO retired_credential_rowid(id, row_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET row_id = MAX(row_id, excluded.row_id)', rowId);
      this.credentialsChanged(profileId);
    });
  }

  private async uploadCredential(profileId: string, input: unknown): Promise<void> {
      this.requireInferenceProfile(profileId);
      const parsed = credentialUploadSchema.parse(input);
      const credential = storedVaultCredentialSchema.parse({ ...parsed.credential, provider: parsed.provider });
      const config = this.config();
      if (!config) throw new Error('Vault is not configured');
      const rows = this.ctx.storage.sql.exec<ProfileCredentialRow>(
        "SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM inference_credentials WHERE profile_id = ? AND provider = ? AND state = 'active' ORDER BY rowid", profileId, parsed.provider,
      ).toArray();
      const existing = await Promise.all(rows.map(async (row) => ({ row, credential: await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key)) })));
      const identity = credentialIdentity(credential);
      const matches = existing.filter(({ credential: current }) => credential.type === 'api_key'
        ? current.type === 'api_key'
        : current.type !== 'api_key' && (identity !== null ? credentialIdentity(current) === identity : current.refresh === credential.refresh));
      const target = matches[0]?.row;
      // Retain row ids on an identity upsert, but never reuse a disabled row: a delayed
      // logout from another client must not disable a subsequently uploaded key.
      await this.storeCredential(target?.id ?? crypto.randomUUID(), credential, profileId);
      for (const { row, credential: current } of existing) {
        if (row.id !== target?.id && (matches.some((match) => match.row.id === row.id) || (credential.type !== 'api_key' && current.type === 'api_key'))) {
          this.disableCredentialRow(profileId, row.row_id);
        }
      }
  }


  private disableCredentialRow(profileId: string, rowId: number): boolean {
    if (!Number.isSafeInteger(rowId) || rowId <= 0) return false;
    return this.ctx.storage.transactionSync(() => {
      this.requireInferenceProfile(profileId);
      const changed = this.ctx.storage.sql.exec("UPDATE inference_credentials SET state = 'disabled', updated_at = ? WHERE profile_id = ? AND rowid = ? AND state != 'disabled'", new Date().toISOString(), profileId, rowId).rowsWritten;
      if (changed === 0) return false;
      this.credentialsChanged(profileId);
      return true;
    });
  }


  private credentialsChanged(profileId = DEFAULT_INFERENCE_PROFILE_ID): void {
    this.ctx.storage.sql.exec('UPDATE inference_profiles SET credential_generation = MAX(credential_generation + 1, ?) WHERE profile_id = ?', Date.now(), profileId);
    if (profileId === DEFAULT_INFERENCE_PROFILE_ID) this.ctx.storage.sql.exec('UPDATE credential_snapshot SET generation = MAX(generation + 1, ?) WHERE id = 1', Date.now());
  }

  private assertProfileAccess(profileId: string): void {
    if (this.legacyCredentialConflict()) throw new Error('Legacy credentials were written after inference cutover; protected forward repair is required');
    this.requireInferenceProfile(profileId);
  }
  /** One refresh per credential at a time: a caller arriving during a refresh shares its outcome instead of starting
   * another (OAuth refresh tokens rotate). A failure is reported to the caller; the next attempt refreshes again. */
  private singleFlight<T>(running: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
    const current = running.get(key);
    if (current) return current;
    const started = run().finally(() => running.delete(key));
    running.set(key, started);
    return started;
  }

  private refreshProfileCredential(profileId: string, rowId: number): Promise<void> {
    return this.singleFlight(this.profileRefreshes, `${profileId}:${rowId}`, async () => {
      this.assertProfileAccess(profileId);
      const config = this.config();
      if (!config || !Number.isSafeInteger(rowId) || rowId <= 0) throw new Error('Credential is unavailable');
      const row = this.ctx.storage.sql.exec<ProfileCredentialRow>(
        'SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM inference_credentials WHERE profile_id = ? AND rowid = ? AND state = ?',
        profileId, rowId, 'active',
      ).toArray()[0];
      if (!row) throw new Error('Credential is unavailable');
      const vaultKey = credentialProtocolBase64.decode(config.vault_key);
      const credential = await openVaultCredential(row, vaultKey);
      this.assertProfileAccess(profileId);
      if (credential.type === 'api_key') return;
      const refreshed = isUpstreamOAuthProvider(credential.provider) ? await refreshUpstreamCredential(credential.provider, credential) : await refreshCredential(credential);
      const revision = row.revision + 1;
      const sealed = await sealVaultCredential(refreshed, vaultKey, row.id, revision);
      const changed = this.ctx.storage.sql.exec(
        "UPDATE inference_credentials SET sealed_json = ?, revision = ?, expires_at = ?, updated_at = ?, account_json = ? WHERE profile_id = ? AND rowid = ? AND revision = ? AND state = 'active'",
        sealed, revision, refreshed.expires, new Date().toISOString(), JSON.stringify(credentialAccount(refreshed)), profileId, rowId, row.revision,
      ).rowsWritten;
      if (changed !== 1) throw new Error('Credential changed during refresh');
      this.credentialsChanged(profileId);
      this.assertProfileAccess(profileId);
    });
  }

  async getAccess(request: CredentialAccessRequest): Promise<CredentialVaultResult<{
    credentialId: string;
    provider: string;
    expiresAt: number;
    revision: number;
    envelope: Awaited<ReturnType<typeof sealCredentialForMachine>>;
  }>> {
    if (this.inferenceCutover()) return publicError('INFERENCE_SCOPE_REQUIRED', 'Upgrade to the profile-scoped credential broker');
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const parsed = credentialAccessRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.userId !== config.user_id) {
      return publicError('INVALID_REQUEST', 'Credential request is invalid');
    }
    const now = Date.now();
    const machine = this.verifier().machine(parsed.data.machineId, now);
    if (!machine || !verifyCredentialAccessRequest(parsed.data, credentialProtocolBase64.decode(machine.signingPublicKey))) {
      return publicError('DEVICE_UNAUTHORIZED', 'Device is not authorized');
    }
    if (!machine.capabilities.includes('credential.access')) return publicError('ACCESS_DENIED', 'Device cannot access credentials');
    if (Math.abs(now - parsed.data.timestamp) > SIGNED_REQUEST_MAX_AGE_MS) return publicError(SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE);

    let row = this.credential(parsed.data.credentialId);
    if (!row || row.state !== 'active') return publicError('CREDENTIAL_NOT_FOUND', 'Credential is unavailable');
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const stored = await openVaultCredential(row, vaultKey);
    if (this.inferenceCutover()) return publicError('INFERENCE_SCOPE_REQUIRED', 'Upgrade to the profile-scoped credential broker');
    if (stored.type === 'api_key') return publicError('INVALID_CREDENTIAL_TYPE', 'Use the OMP broker snapshot for API keys');
    let credential: StoredVaultOAuthCredential = stored;
    if (Date.now() + ACCESS_REFRESH_SKEW_MS >= credential.expires) {
      const refreshRow = row;
      const expiring = credential;
      try {
        credential = await this.singleFlight(this.legacyRefreshes, refreshRow.id, async () => {
          const next = await refreshCredential(expiring);
          const nextRevision = refreshRow.revision + 1;
          const sealed = await sealVaultCredential(next, vaultKey, refreshRow.id, nextRevision);
          const table = this.inferenceCutover() ? 'inference_credentials' : 'oauth_credentials';
          const changed = this.ctx.storage.sql.exec(
            `UPDATE ${table} SET sealed_json = ?, revision = ?, expires_at = ?, updated_at = ?, account_json = ? WHERE profile_id = 'default' AND id = ? AND revision = ? AND state = 'active'`,
            sealed, nextRevision, next.expires, new Date().toISOString(), JSON.stringify(credentialAccount(next)), refreshRow.id, refreshRow.revision,
          ).rowsWritten;
          if (changed !== 1) throw new Error('Credential changed during refresh');
          this.credentialsChanged();
          return next;
        });
        row = this.credential(refreshRow.id)!;
      } catch (error) {
        if (error instanceof ProviderRefreshError) {
          return publicError(
            error.kind === 'rejected' ? 'REFRESH_REJECTED' : 'REFRESH_FAILED',
            error.kind === 'rejected' ? 'Provider rejected the refresh credential' : 'Provider refresh failed',
            error.kind === 'network' ? 1_000 : undefined,
          );
        }
        return publicError('REFRESH_FAILED', error instanceof Error ? error.message : 'Provider refresh failed', 1_000);
      }
    }

    const accessPayload = new TextEncoder().encode(JSON.stringify({
      credentialId: row.id,
      provider: credential.provider,
      access: credential.access,
      expiresAt: credential.expires,
      revision: row.revision,
    }));
    const context = `${config.user_id}\n${parsed.data.machineId}\n${row.id}\n${parsed.data.nonce}\n${row.revision}`;
    const envelope = await sealCredentialForMachine({
      plaintext: accessPayload,
      machineExchangePublicKey: credentialProtocolBase64.decode(machine.exchangePublicKey),
      context,
    });
    if (this.inferenceCutover()) return publicError('INFERENCE_SCOPE_REQUIRED', 'Upgrade to the profile-scoped credential broker');
    return { status: 'ok', value: { credentialId: row.id, provider: credential.provider, expiresAt: credential.expires, revision: row.revision, envelope } };
  }

  /** The 32-byte key that encrypts one storage scope's objects at rest (R2 SSE-C). Created on first use, stored only
   * wrapped under this vault's root wrap key and bound to its scope; every caller gets the stored row's key. */
  async scopeKey(scope: string): Promise<Uint8Array> {
    if (!scope || scope.length > 256) throw new Error('Storage scope is invalid');
    if (!this.scopeKeyRow(scope)) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(scope) },
        await this.scopeWrapKey(SCOPE_KEY_ROOT_VERSION),
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const wrapped = new Uint8Array(nonce.byteLength + sealed.byteLength);
      wrapped.set(nonce);
      wrapped.set(new Uint8Array(sealed), nonce.byteLength);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO scope_keys(scope, wrapped, root_version, created_at) VALUES (?, ?, ?, ?)', scope, wrapped.buffer, SCOPE_KEY_ROOT_VERSION, new Date().toISOString());
    }
    const row = this.scopeKeyRow(scope);
    if (!row) throw new Error('Storage scope key is unavailable');
    const wrapped = new Uint8Array(row.wrapped);
    const key = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrapped.subarray(0, 12), additionalData: new TextEncoder().encode(scope) },
      await this.scopeWrapKey(row.root_version),
      wrapped.subarray(12),
    );
    return new Uint8Array(key);
  }

  /** Deleting a workspace or project forgets its scopes' keys: whatever their objects still hold is unreadable. */
  forgetScope(scope: string): void {
    this.ctx.storage.sql.exec('DELETE FROM scope_keys WHERE scope = ?', scope);
  }

  private scopeKeyRow(scope: string): { wrapped: ArrayBuffer; root_version: number } | undefined {
    return this.ctx.storage.sql.exec<{ wrapped: ArrayBuffer; root_version: number }>('SELECT wrapped, root_version FROM scope_keys WHERE scope = ?', scope).toArray()[0];
  }

  /** Root wrap keys never leave this object; rotating one is a new version and a rewrap of every row. */
  private async scopeWrapKey(version: number): Promise<CryptoKey> {
    const config = this.config();
    const label = SCOPE_KEY_ROOT_LABELS[version];
    if (!config || !label) throw new Error('Account credential vault is unavailable');
    const root = await crypto.subtle.importKey('raw', ownedBuffer(credentialProtocolBase64.decode(config.vault_key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const material = await crypto.subtle.sign('HMAC', root, new TextEncoder().encode(label));
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  /** The tenant key every object was sealed under before storage moved to R2 SSE-C. Only the storage migration reads it;
   * it is deleted with the migration. */
  async legacyArtifactKey(userId: string): Promise<Uint8Array> {
    const config = this.config();
    if (!config || config.user_id !== userId) throw new Error('Account credential vault is unavailable');
    const key = await crypto.subtle.importKey('raw', ownedBuffer(credentialProtocolBase64.decode(config.vault_key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`gitspace/artifact-encryption/v1\n${userId}`)));
  }

  private config(): { user_id: string; root_public_key: string; vault_key: string } | undefined {
    return this.ctx.storage.sql.exec<{ user_id: string; root_public_key: string; vault_key: string }>(
      'SELECT user_id, root_public_key, vault_key FROM vault_config WHERE id = 1',
    ).toArray()[0];
  }

  private credential(id: string, profileId = DEFAULT_INFERENCE_PROFILE_ID): CredentialRow | undefined {
    const table = this.inferenceCutover() ? 'inference_credentials' : 'oauth_credentials';
    return this.ctx.storage.sql.exec<CredentialRow>(
      `SELECT id, provider, sealed_json, revision, expires_at, state FROM ${table} WHERE id = ? AND profile_id = ?`,
      id, profileId,
    ).toArray()[0];
  }

  private providerSecretRow(provider: 'composio'): ProviderSecretRow | undefined {
    return this.ctx.storage.sql.exec<ProviderSecretRow>(
      'SELECT provider, sealed_json, revision, updated_at FROM provider_secrets WHERE provider = ?',
      provider,
    ).toArray()[0];
  }

}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > REQUEST_MAX_BYTES) throw new Error('request too large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > REQUEST_MAX_BYTES) throw new Error('request too large');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function credentialVault(env: Env, userId: string) {
  const namespace = env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>;
  return namespace.get(namespace.idFromName(userId));
}

function projectSecrets(env: Env, userId: string) {
  const namespace = env.PROJECT_SECRETS as DurableObjectNamespace<ProjectSecretsDO>;
  return namespace.get(namespace.idFromName(userId));
}

async function requireConfigurationProject(env: Env, userId: string, projectId: string) {
  const projects = (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId);
  if (!(await projects.list()).some(project => project.id === projectId)) throw new Error('Project does not belong to this account');
  return projectAuthority(env, userId, projectId);
}

async function requireSecretContext(env: Env, userId: string, projectId: string, workspaceId: unknown): Promise<string | null> {
  const authority = await requireConfigurationProject(env, userId, projectId);
  if (workspaceId === null) return null;
  if (typeof workspaceId !== 'string') throw new Error('Secret resolution requires an explicit session context');
  const workspace = (await authority.listWorkspaces()).find(workspace => workspace.id === workspaceId);
  if (!workspace || workspace.kind !== 'worktree') throw new Error('Secret workspace does not belong to this project');
  return workspaceId;
}

function accountState(env: Env) {
  const namespace = env.ACCOUNT_STATE as DurableObjectNamespace<AccountStateDO>;
  return namespace.get(namespace.idFromName('account'));
}


function userMcpConnections(env: Env, userId: string) {
  const namespace = env.USER_MCP_CONNECTIONS as DurableObjectNamespace<UserMcpConnectionsDO>;
  return namespace.get(namespace.idFromName(userId));
}

function projectAuthority(env: Env, userId: string, projectId: string) {
  const namespace = env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>;
  return namespace.get(namespace.idFromName(`${userId}:${projectId}`));
}

function composioStatePayload(principalId: string, state: string): ArrayBuffer {
  return new TextEncoder().encode(`${principalId}\n${state}`).buffer;
}

async function composioStateKey(env: Env, accountApiKey?: string | null): Promise<CryptoKey> {
  const secret = accountApiKey?.trim() || env.COMPOSIO_API_KEY?.trim();
  if (!secret) throw new Error('Composio is not configured');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signComposioState(env: Env, principalId: string, state: string, accountApiKey?: string | null): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await composioStateKey(env, accountApiKey), composioStatePayload(principalId, state)));
  return btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function verifyComposioState(env: Env, principalId: string, state: string, encodedSignature: string, accountApiKey?: string | null): Promise<boolean> {
  try {
    const padded = `${encodedSignature.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - encodedSignature.length % 4) % 4)}`;
    const signature = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
    return crypto.subtle.verify('HMAC', await composioStateKey(env, accountApiKey), signature, composioStatePayload(principalId, state));
  } catch {
    return false;
  }
}

function tenantReleases(env: Env, userId: string) {
  // `get(idFromName)` rather than `getByName`: the dev Miniflare runtime predates the latter.
  const namespace = env.TENANT_RELEASES as DurableObjectNamespace<TenantReleasesDO>;
  return namespace.get(namespace.idFromName(userId));
}

/** What this script reports as its own version: the build stamp, or `dev` for unstamped builds. */
const WORKER_STAMP = { sha: WORKER_VERSION ?? null, version: WORKER_VERSION ?? 'dev' } as const;

/** What the account runs, read from cloud state; no machine is consulted. */
export async function readTenantDeployment(env: Env, userId: string): Promise<DeploymentStatus> {
  return tenantReleases(env, userId).status(userId, await tenantWorkerVersion(env, userId));
}
/** Starts Back to stable, or finds the one already running; the release object runs it to its end whether or not the
 * caller stays, and status reports it as `revert`. */
export async function revertTenantRelease(env: Env, userId: string): Promise<DeploymentStatus> {
  await tenantReleases(env, userId).startRevert(userId);
  return readTenantDeployment(env, userId);
}
/** Reads the canonical branch head from the public canonical repository (one ref advertisement, no clone) and stores
 * it; status serves the stored head. */
export async function discardTenantLaunch(env: Env, userId: string, launchId: string): Promise<DeploymentStatus> {
  await tenantReleases(env, userId).discardLaunch(launchId);
  return readTenantDeployment(env, userId);
}
export async function checkCanonicalHead(env: Env, userId: string): Promise<DeploymentStatus> {
  const ref = `refs/heads/${GITSPACE_CANONICAL_BRANCH}`;
  const commit = (await readAdvertisedRefs({ remote: GITSPACE_SOURCE_REPOSITORY, auth: null, refPrefix: ref })).get(ref);
  if (!commit) throw new Error(`${GITSPACE_SOURCE_REPOSITORY} has no ${GITSPACE_CANONICAL_BRANCH} branch`);
  await tenantReleases(env, userId).recordCanonicalHead({ repository: GITSPACE_SOURCE_REPOSITORY, branch: GITSPACE_CANONICAL_BRANCH, commit, checkedAt: new Date().toISOString() });
  return readTenantDeployment(env, userId);
}


/** Every workspace object hears of the new release; one still resident on older code restarts on it when idle. */
async function restartSpacesForRelease(env: Env, userId: string, sha: string): Promise<void> {
  const definitions = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).listSpaces();
  const namespace = env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>;
  const outcomes = await Promise.all(definitions.map(definition => namespace.getByName(`${userId}:${definition.spaceId}`).restartForRelease(sha).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'release_restart_failed', sha, workspaceId: definition.spaceId, message: error instanceof Error ? error.message : String(error) }));
    return 'failed';
  })));
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  console.info(JSON.stringify({ event: 'release_restarts', sha, ...counts }));
}

/** A Worker target must reach its account-owned platform script; an unavailable platform is a failed release. */
async function launchRelease(env: Env, userId: string, payload: Record<string, unknown>): Promise<LaunchResult> {
  const input = launchReleaseInputSchema.parse(payload);
  const releases = tenantReleases(env, userId);
  const launched = await releases.launch(input);
  if (!launched) throw new ReleaseNotFoundError(input.sha);
  if (launched.record.status.worker !== 'pending') { await releases.finishLaunch(launched.record, input.targets); return launched; }
  const worker = launched.record.artifacts.worker;
  const metadata = launched.record.worker;
  let outcome: WorkerSwap;
  try {
    if (!worker || !metadata) throw new Error('Worker artifact and metadata are required');
    outcome = await platformSwap(env, '/deploy', { sha: input.sha, manifestKey: dataObjectKey(userId, worker.key), manifestHash: worker.hash, metadata, accountId: userId });
  } catch (error) {
    outcome = { status: 'failed', error: error instanceof Error ? error.message : 'Worker deployment failed' };
  }
  const record = await releases.setWorkerStatus(input.sha, outcome.status, outcome.error) ?? launched.record;
  if (outcome.status === 'applied') await restartSpacesForRelease(env, userId, input.sha);
  await releases.finishLaunch(record, input.targets);
  return { ...launched, record };
}

const FRONTEND_CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
};

/** Default accounts pin immutable UI files; development assets retain their own namespace. */
async function accountChannelResponse(request: Request, env: Env, pathname: string): Promise<Response> {
  if (env.DEFAULT_ACCOUNT_RELEASE !== undefined) {
    const pin = env.DEFAULT_ACCOUNT_RELEASE;
    if (!defaultReleasePinSchema.safeParse(pin).success) return new Response('Pinned account frontend unavailable', { status: 503 });
    try {
      const target = new URL(`/v1/default-releases/${pin}/frontend/${pathname.slice(1)}`, env.PLATFORM_URL);
      const assetRequest = new Request(target, { method: request.method, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const response = await (env.PLATFORM_SERVICE ? env.PLATFORM_SERVICE.fetch(assetRequest) : fetch(assetRequest));
      if ((response.status >= 300 && response.status < 400) || (response.ok && response.headers.get('x-gitspace-frontend-release') !== pin)) {
        await response.body?.cancel();
        return new Response('Pinned account frontend unavailable', { status: 503 });
      }
      if (pathname.startsWith('/assets/')) return response;
      // The document names the hashed assets of whichever release is pinned now, so the browser revalidates it.
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-cache');
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response('Pinned account frontend unavailable', { status: 503 }); }
  }
  const assets = env.ASSETS;
  if (!assets) return new Response('Account frontend unavailable', { status: 503 });
  const asset = pathname.startsWith('/assets/') || pathname.startsWith('/fonts/')
    || (/\.[a-z0-9]+$/iu.test(pathname) && !/\.html?$/iu.test(pathname));
  let target = new URL(request.url);
  target.pathname = asset ? `/__account${pathname}` : '/__account/';
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const response = await assets.fetch(new Request(target, { method: request.method, headers: request.headers, redirect: 'manual' }));
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      // ASSETS has a global SPA fallback for the operator app. It is not an
      // account asset, and returning it as CSS/JS would hide a broken publication.
      if (asset && response.headers.get('content-type')?.includes('text/html')) {
        await response.body?.cancel();
        return new Response('Not found', { status: 404 });
      }
      return response;
    }
    await response.body?.cancel();
    const next = new URL(location, target);
    if (next.origin !== target.origin || (next.pathname !== '/__account' && !next.pathname.startsWith('/__account/'))) {
      return new Response('Account asset redirect is invalid', { status: 502 });
    }
    target = next;
  }
  return new Response('Account asset canonicalization did not resolve', { status: 502 });
}

function accountHandleForHostname(hostname: string): string | null {
  const match = /^([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)\.gitspace\.sh$/u.exec(hostname.toLowerCase());
  return match && match[1] !== 'api' && match[1] !== 'www' ? match[1]! : null;
}

/** Serves either the account's selected frontend tree or its bundled channel frontend. */
async function releaseFrontendResponse(request: Request, env: Env, pathname: string): Promise<Response | null> {
    const handle = accountHandleForHostname(new URL(request.url).hostname);
    if (!handle) return null;
    const account = await accountState(env).getByHandle(handle);
    if (!account) return new Response('Account not found', { status: 404 });
    const denied = accountAccessResponse(await activeAccount(env, account.userId));
    if (denied) return denied;
    const ownerId = account.userId;
  const frontend = await tenantReleases(env, ownerId).frontend();
    if (frontend === null) {
      return accountChannelResponse(request, env, pathname);
    }
  const prefix = `users/${ownerId}/${frontend.keyPrefix}/`;
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  if (requested.includes('..')) return new Response('Not found', { status: 404 });
  let path = requested;
  let object = await env.DATA.get(prefix + path);
  if (!object && (requested === 'favicon.png' || requested === 'favicon.ico')) {
    return accountChannelResponse(request, env, pathname);
  }
  if (!object && !/\.[a-z0-9]+$/iu.test(requested)) {
    path = 'index.html';
    object = await env.DATA.get(prefix + path);
  }
  if (!object) return new Response('Not found', { status: 404 });
  const dot = path.lastIndexOf('.');
  const headers = new Headers({
    'content-type': (dot === -1 ? undefined : FRONTEND_CONTENT_TYPES[path.slice(dot + 1).toLowerCase()]) ?? 'application/octet-stream',
    'content-length': String(object.size),
    'cache-control': path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    etag: object.httpEtag,
    [WORKER_VERSION_HEADER]: WORKER_STAMP.version,
    'x-gitspace-frontend-release': frontend.sha,
  });
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

interface SyncRequestDiagnostics {
  attemptId: string;
  route: 'control' | 'data';
  requestId?: string;
  operation?: SignedControlRequest['operation'];
  startedAt: string;
  started: number;
  cfRay?: string;
  stage: 'received' | 'parse' | 'validate' | 'authorize' | 'rollout' | 'processing' | 'r2.head' | 'r2.put' | 'r2.get';
  caughtError: boolean;
  /** Name and message of the error a route caught; never its request body or headers. */
  error?: { name: string; message: string };
}

const syncAttemptIdSchema = z.uuid();

function syncRequestDiagnostics(request: Request): SyncRequestDiagnostics | undefined {
  const attemptId = request.headers.get('x-gitspace-sync-attempt');
  if (!attemptId || attemptId.length !== 36 || !syncAttemptIdSchema.safeParse(attemptId).success) return;
  const pathname = new URL(request.url).pathname;
  const route = pathname === '/v1/control' ? 'control' : /^\/v1\/data\/(.+)$/u.test(pathname) ? 'data' : undefined;
  if (!route) return;
  const cfRay = request.headers.get('cf-ray');
  return {
    attemptId,
    route,
    startedAt: new Date().toISOString(),
    started: performance.now(),
    cfRay: cfRay && /^[a-f0-9]{16}(?:-[a-z]{3})?$/iu.test(cfRay) ? cfRay : undefined,
    stage: 'received',
    caughtError: false,
  };
}

function logSyncRequest(
  diagnostics: SyncRequestDiagnostics,
  outcome: 'received' | 'parsed' | 'response' | 'http_error' | 'caught_error' | 'exception',
  status?: number,
): void {
  try {
    console.info(JSON.stringify({
      event: 'artifact_sync_worker_request',
      attemptId: diagnostics.attemptId,
      route: diagnostics.route,
      requestId: diagnostics.requestId,
      operation: diagnostics.operation,
      startedAt: diagnostics.startedAt,
      elapsedMs: Math.max(0, performance.now() - diagnostics.started),
      stage: diagnostics.stage,
      outcome,
      status,
      cfRay: diagnostics.cfRay,
      error: diagnostics.error,
    }));
  } catch {
    // Diagnostics must not change request processing or response delivery.
  }
}

function recordSyncRequestParsed(diagnostics: SyncRequestDiagnostics | undefined, signed: SignedControlRequest): void {
  if (!diagnostics) return;
  diagnostics.requestId = signed.nonce;
  diagnostics.operation = signed.operation;
  diagnostics.stage = 'validate';
  logSyncRequest(diagnostics, 'parsed');
}


/** A data request the client must change before it can succeed: answered with `status` and `code`, never retried. */
class DataRequestError extends Error {
  override readonly name = 'DataRequestError';
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function decodeSignedHeader(value: string | null): SignedControlRequest {
  if (!value || value.length > DATA_REQUEST_HEADER_MAX_BYTES) throw new DataRequestError(400, 'INVALID_SIGNED_REQUEST', 'Signed data request is missing or too large');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(base64));
  } catch {
    throw new DataRequestError(400, 'INVALID_SIGNED_REQUEST', 'Signed data request is not base64url-encoded JSON');
  }
  const parsed = signedControlRequestSchema.safeParse(decoded);
  if (!parsed.success) throw new DataRequestError(400, 'INVALID_SIGNED_REQUEST', 'Signed data request is malformed');
  return parsed.data;
}

/** The object key a `/v1/data/` path names, each segment URI-decoded. */
function dataKeyFromPath(encoded: string): string {
  try {
    return encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new DataRequestError(400, 'INVALID_OBJECT_KEY', 'Application object key is not URI-encoded');
  }
}

function dataObjectKey(userId: string, key: unknown): string {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('..') || key.length > 1_024) {
    throw new DataRequestError(400, 'INVALID_OBJECT_KEY', 'Application object key is invalid');
  }
  return `users/${userId}/${key}`;
}

/** The answer to a data request that threw. What the request carried decides a 4xx; any other failure (R2, Durable
 * Object RPC, network, internal) is 503 so the uploader retries it. */
function dataFailureResponse(error: unknown): Response {
  if (error instanceof DataRequestError) return dataError(error.status, error.code, error.message);
  return dataError(503, 'DATA_STORAGE_FAILED', 'Storing the object failed; try again');
}

const CAUGHT_ERROR_MESSAGE_MAX_CHARS = 512;

function caughtErrorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, CAUGHT_ERROR_MESSAGE_MAX_CHARS) };
  return { name: typeof error, message: '' };
}

/** Which signed operations each method of the data endpoint carries. */
const DATA_OPERATIONS: Record<string, readonly string[]> = {
  HEAD: ['data.head'],
  GET: ['data.get'],
  PUT: ['data.put', 'data.multipart.part'],
  POST: ['data.multipart.create', 'data.multipart.complete'],
  DELETE: ['data.multipart.abort'],
};
/** Body uploads may arrive long after signing: edges buffer whole bodies before the Worker runs. */
const DATA_UPLOAD_OPERATIONS: Record<string, true> = { 'data.put': true, 'data.multipart.part': true };
const DATA_WRITE_OPERATIONS: Record<string, true> = {
  'data.put': true, 'data.multipart.create': true, 'data.multipart.part': true, 'data.multipart.complete': true, 'data.multipart.abort': true,
};

function dataError(status: number, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return Response.json({ status: 'error', error: { code, message, ...details } }, { status });
}

/** An upload's body, when it has one whose Content-Length is its signed size, at most `maxBytes`. */
function dataUploadBody(request: Request, size: number, maxBytes: number): ReadableStream<Uint8Array> | Response {
  if (size > maxBytes) return dataError(413, 'OBJECT_TOO_LARGE', `Application object size ${size} bytes exceeds the maximum ${maxBytes} bytes`, { size, maxBytes });
  const contentLength = request.headers.get('content-length');
  const declared = contentLength === null ? null : Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared !== size || !request.body) {
    return dataError(400, 'OBJECT_BODY_LENGTH_MISMATCH', `Application object body requires Content-Length matching the signed size of ${size} bytes and a request body`, {
      size, declaredSize: Number.isSafeInteger(declared) && declared !== null && declared >= 0 ? declared : null,
    });
  }
  return request.body;
}

async function dataObjectResponse(request: Request, env: Env, keyFromPath: string, diagnostics?: SyncRequestDiagnostics): Promise<Response> {
  const signed = decodeSignedHeader(request.headers.get('x-gitspace-control'));
  recordSyncRequestParsed(diagnostics, signed);
  if (!DATA_OPERATIONS[request.method]?.includes(signed.operation) || signed.payload.key !== keyFromPath) throw new DataRequestError(400, 'SIGNED_REQUEST_MISMATCH', 'Signed data request does not match the request');
  const objectKey = dataObjectKey(signed.userId, keyFromPath);
  if (diagnostics) diagnostics.stage = 'authorize';
  const authorized = await authorizeControl(env, signed, 'storage.access', DATA_UPLOAD_OPERATIONS[signed.operation] ? SIGNED_UPLOAD_MAX_AGE_MS : SIGNED_REQUEST_MAX_AGE_MS);
  if (authorized.status === 'error') return accountAccessResponse(authorized)!;
  if (diagnostics) diagnostics.stage = 'validate';
  if (keyFromPath.startsWith('releases/') || keyFromPath.startsWith('distribution/v1/releases/') || /^objects\/sha256\/[a-f0-9]{64}$/u.test(keyFromPath)) {
    return releaseDataObjectResponse(request, env, signed, keyFromPath, objectKey, diagnostics);
  }
  const namespace = tenantNamespace(keyFromPath);
  if (!namespace || signed.userId !== env.ACCOUNT_ID) return dataError(400, 'OBJECT_NAMESPACE_REFUSED', 'The object name is outside every storage namespace');
  const denied = await dataScopeDenied(env, signed, namespace);
  if (denied) return denied;
  try {
    return await tenantDataObjectResponse(request, env, signed, keyFromPath, namespace.scope, diagnostics);
  } catch (error) {
    if (error instanceof TenantObjectIntegrityError) return dataError(409, 'OBJECT_INTEGRITY', error.message);
    throw error;
  }
}

/** Whether this machine may touch the scope a name's namespace maps to. LFS objects belong to a live project and are
 * written only under a durable publication pin; workspace objects need this machine's live checkout of the workspace.
 * A drive request names the workspace its machine is attached to: that workspace's own drive is writable, and it reads
 * the drives its sessions read (a worktree its project's base drive, the base its worktrees' drives). */
async function dataScopeDenied(env: Env, signed: SignedControlRequest, namespace: TenantNamespace): Promise<Response | null> {
  const write = DATA_WRITE_OPERATIONS[signed.operation] === true;
  if (namespace.kind === 'lfs') {
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${namespace.projectId}`);
    const project = await authority.getProject();
    if (!project || project.id !== namespace.projectId || project.lifecycle === 'deleting') return dataError(403, 'DATA_SCOPE_DENIED', 'LFS project is unavailable');
    const publishes = signed.operation === 'data.put' || signed.operation === 'data.multipart.create';
    if (publishes && signed.payload.hash !== `sha256:${namespace.oid}`) return dataError(400, 'INVALID_OBJECT_METADATA', 'An LFS object is named by the SHA-256 of its bytes');
    if ((publishes || signed.operation === 'data.multipart.complete') && !await authority.lfsObjectAccess(namespace.oid)) {
      return Response.json(publicError('LFS_PUBLICATION_REQUIRED', 'LFS upload requires a durable publication pin'), { status: 409 });
    }
    return null;
  }
  const workspace = RuntimeIdentitySchema.safeParse(namespace.kind === 'space' ? { projectId: namespace.projectId, workspaceId: namespace.spaceId } : signed.payload).data;
  if (!workspace) return dataError(400, 'INVALID_OBJECT_METADATA', 'Drive objects name the workspace the machine is attached to');
  try {
    const access = await requireWorkspaceAccess(env, env.ACCOUNT_ID, workspace, write);
    const attachments = await access.authority.runtimeAttachmentRecords(workspace);
    if (!attachments.some(item => item.machineId === signed.machineId && item.state !== 'detached')) return dataError(403, 'DATA_SCOPE_DENIED', 'This machine has no checkout of the workspace');
  } catch {
    return dataError(403, 'DATA_SCOPE_DENIED', 'The workspace is unavailable to this machine');
  }
  const { projectId, workspaceId }: { projectId: string; workspaceId: string } = workspace;
  // A drive file streamed before its digest was known is written by the account alone.
  if (write && namespace.kind === 'drive' && namespace.named === 'id') return dataError(400, 'OBJECT_NAMESPACE_REFUSED', 'Drive objects named by an upload id are read only');
  if (namespace.kind === 'space' || namespace.workspaceId === workspaceId) return null;
  if (!write && namespace.workspaceId === projectId) return null;
  if (!write && workspaceId === projectId) {
    const definition = await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).getWorkspace(namespace.workspaceId);
    if (definition?.projectId === projectId) return null;
  }
  return dataError(403, 'DATA_SCOPE_DENIED', 'This workspace cannot reach that drive');
}

/** Tenant objects carry plaintext both ways; the store encrypts them at rest under `scope`'s key and verifies whole reads. */
async function tenantDataObjectResponse(request: Request, env: Env, signed: SignedControlRequest, name: string, scope: string, diagnostics?: SyncRequestDiagnostics): Promise<Response> {
  const store = tenantStore(env);
  const noStore = { 'cache-control': 'private, no-store' };
  switch (signed.operation) {
    case 'data.head':
    case 'data.get': {
      if (diagnostics) diagnostics.stage = signed.operation === 'data.head' ? 'r2.head' : 'r2.get';
      const read = dataObjectReadSchema.safeParse(signed.payload);
      if (!read.success) return dataError(400, 'INVALID_OBJECT_METADATA', 'A read names the SHA-256 it expects, if any');
      // An object that records no digest of its own is read against the one its reader expects.
      const expected = read.data.hash ? { sha256: read.data.hash } : undefined;
      const object = signed.operation === 'data.get' ? await store.get(name, scope, expected ? { expected } : {}) : null;
      const metadata = signed.operation === 'data.get' ? object : await store.head(name, scope, expected);
      if (!metadata) return new Response(null, { status: 404 });
      if (read.data.hash !== undefined && read.data.hash !== metadata.sha256) {
        await object?.body.cancel();
        return dataError(409, 'HASH_MISMATCH', 'Application object hash does not match');
      }
      const headers = new Headers({
        ...noStore, 'content-length': String(metadata.size), 'content-type': 'application/octet-stream',
        'x-gitspace-sha256': metadata.sha256, 'x-gitspace-size': String(metadata.size),
      });
      // The verified body has no length of its own, so it would go out chunked without the content-length machines
      // read the size from; a fixed length keeps it.
      return new Response(object ? object.body.pipeThrough(new FixedLengthStream(metadata.size)) : null, { headers });
    }
    case 'data.put': {
      const declared = dataObjectWriteSchema.safeParse(signed.payload);
      if (!declared.success) return dataError(400, 'INVALID_OBJECT_METADATA', 'Application object metadata requires a SHA-256 hash and a non-negative safe integer size in bytes');
      const { hash, size } = declared.data;
      const body = dataUploadBody(request, size, DATA_PUT_MAX_BYTES);
      if (body instanceof Response) return body;
      if (diagnostics) diagnostics.stage = 'r2.head';
      const existing = await store.head(name, scope);
      if (existing) {
        await body.cancel();
        return existing.size === size && existing.sha256 === hash
          ? new Response(null, { status: 204 })
          : dataError(409, 'OBJECT_CONFLICT', 'Application object key already has different content');
      }
      if (diagnostics) diagnostics.stage = 'r2.put';
      if (!await store.put(name, scope, { stream: body, size, sha256: hash }, { onlyIfAbsent: true })) {
        if (diagnostics) diagnostics.stage = 'r2.head';
        const raced = await store.head(name, scope);
        if (raced?.size !== size || raced.sha256 !== hash) return dataError(409, 'OBJECT_CONFLICT', 'Application object publication raced with different content');
      }
      return new Response(null, { status: 201 });
    }
    case 'data.multipart.create': {
      const declared = dataObjectWriteSchema.safeParse(signed.payload);
      if (!declared.success) return dataError(400, 'INVALID_OBJECT_METADATA', 'A multipart object declares its SHA-256 hash and size in bytes');
      const uploadId = await store.createMultipart(name, scope, { sha256: declared.data.hash, size: declared.data.size });
      return Response.json({ status: 'ok', value: { uploadId, partBytes: TENANT_OBJECT_PART_BYTES } }, { headers: noStore });
    }
    case 'data.multipart.part': {
      const part = dataMultipartPartSchema.safeParse(signed.payload);
      if (!part.success) return dataError(400, 'INVALID_OBJECT_METADATA', 'A part names its upload, number, SHA-256 hash and size in bytes');
      const body = dataUploadBody(request, part.data.size, TENANT_OBJECT_PART_BYTES);
      if (body instanceof Response) return body;
      const uploaded = await store.uploadPart(name, scope, part.data.uploadId, part.data.partNumber, { stream: body, size: part.data.size, sha256: part.data.hash });
      return Response.json({ status: 'ok', value: { partNumber: uploaded.partNumber, etag: uploaded.etag } }, { headers: noStore });
    }
    case 'data.multipart.complete': {
      const completion = dataMultipartCompleteSchema.safeParse(signed.payload);
      if (!completion.success) return dataError(400, 'INVALID_OBJECT_METADATA', 'Completion names its upload and parts');
      const completed = await store.completeMultipart(name, scope, completion.data.uploadId, completion.data.parts);
      return Response.json({ status: 'ok', value: { hash: completed.sha256, size: completed.size } }, { status: 201, headers: noStore });
    }
    case 'data.multipart.abort': {
      const abort = dataMultipartAbortSchema.safeParse(signed.payload);
      if (!abort.success) return dataError(400, 'INVALID_OBJECT_METADATA', 'Abort names its upload');
      await store.abortMultipart(name, scope, abort.data.uploadId);
      return new Response(null, { status: 204 });
    }
    default: throw new DataRequestError(400, 'INVALID_OPERATION', 'Application object operation is invalid');
  }
}

/** Release objects machines publish and read in plain text (release trees, executable chunks, platform fallbacks): not
 * tenant storage, so neither scoped nor encrypted at rest, and written whole. */
async function releaseDataObjectResponse(request: Request, env: Env, signed: SignedControlRequest, keyFromPath: string, objectKey: string, diagnostics?: SyncRequestDiagnostics): Promise<Response> {
  const operation = signed.operation;
  if (operation === 'data.put') {
    const declared = dataObjectWriteSchema.safeParse(signed.payload);
    if (!declared.success) return dataError(400, 'INVALID_OBJECT_METADATA', 'Application object metadata requires a SHA-256 hash and a non-negative safe integer size in bytes');
    const { hash, size } = declared.data;
    const body = dataUploadBody(request, size, DATA_OBJECT_MAX_BYTES);
    if (body instanceof Response) return body;
    if (diagnostics) diagnostics.stage = 'r2.head';
    const existing = await env.DATA.head(objectKey);
    if (existing) {
      await body.cancel();
      return existing.size === size && existing.customMetadata?.sha256 === hash
        ? new Response(null, { status: 204 })
        : dataError(409, 'OBJECT_CONFLICT', 'Application object key already has different content');
    }
    if (diagnostics) diagnostics.stage = 'r2.put';
    // The bytes are checked against the signed digest and size as they pass, so a mismatch is reported as the
    // request's fault rather than as the R2 failure it causes; R2 checks the digest again.
    const stored = await sendSized(body.pipeThrough(verifying({ sha256: hash, size })), size, verified => env.DATA.put(objectKey, verified, {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { sha256: hash },
      sha256: hash.slice('sha256:'.length),
    })).catch((error: unknown) => {
      if (error instanceof TenantObjectIntegrityError) throw new DataRequestError(400, 'OBJECT_DIGEST_MISMATCH', 'Application object bytes do not match the signed SHA-256 and size');
      throw error;
    });
    if (!stored) {
      if (diagnostics) diagnostics.stage = 'r2.head';
      const raced = await env.DATA.head(objectKey);
      if (!raced || raced.size !== size || raced.customMetadata?.sha256 !== hash) return dataError(409, 'OBJECT_CONFLICT', 'Application object publication raced with different content');
    }
    return new Response(null, { status: 201 });
  }
  if (operation !== 'data.head' && operation !== 'data.get') return dataError(400, 'OBJECT_NAMESPACE_REFUSED', 'Release objects are written whole');
  if (diagnostics) diagnostics.stage = operation === 'data.head' ? 'r2.head' : 'r2.get';
  const object = operation === 'data.head' ? await env.DATA.head(objectKey) : await env.DATA.get(objectKey);
  if (!object) {
    if (keyFromPath.startsWith('distribution/v1/releases/') || /^objects\/sha256\/[a-f0-9]{64}$/u.test(keyFromPath)) {
      const response = await tenantPlatformFetch(env, `/machine-release/blob?${new URLSearchParams({ key: keyFromPath })}`, { signal: request.signal });
      const expectedHash = signed.payload.hash;
      if (response.ok && expectedHash !== undefined && expectedHash !== response.headers.get('x-gitspace-sha256')) {
        await response.body?.cancel();
        return dataError(409, 'HASH_MISMATCH', 'Machine release object hash does not match');
      }
      if (operation === 'data.head') {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      }
      return response;
    }
    return new Response(null, { status: 404 });
  }
  // An object stored with its hash is served only under that hash.
  const expectedHash = signed.payload.hash;
  const recordedHash = object.customMetadata?.sha256;
  if (expectedHash !== undefined && recordedHash !== undefined && expectedHash !== recordedHash) {
    return dataError(409, 'HASH_MISMATCH', 'Application object hash does not match');
  }
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'content-length': String(object.size),
    'content-type': 'application/octet-stream',
    etag: object.httpEtag,
  });
  if (recordedHash) headers.set('x-gitspace-sha256', recordedHash);
  if (operation === 'data.head') return new Response(null, { headers });
  if (!('body' in object) || !(object.body instanceof ReadableStream)) throw new Error('Application object body is missing');
  return new Response(object.body, { headers });
}

function catalogMachinePayload(payload: Record<string, unknown>): FleetMachineDefinition {
  return {
    id: String(payload.id ?? ''),
    label: String(payload.label ?? ''),
    state: payload.state === 'provisioning' || payload.state === 'sleeping' || payload.state === 'resuming' || payload.state === 'deleting' || payload.state === 'error' || payload.state === 'online' ? payload.state : 'offline',
    rpcEndpoint: typeof payload.rpcEndpoint === 'string' ? payload.rpcEndpoint : null,
    kind: payload.kind === 'sandbox' ? 'sandbox' : 'physical',
    notes: typeof payload.notes === 'string' ? payload.notes : '',
    provider: payload.provider === 'cloudflare-sandbox' ? 'cloudflare-sandbox' : 'physical',
    desiredState: payload.desiredState === 'offline' || payload.desiredState === 'removed' ? payload.desiredState : 'online',
    lifecycleRevision: Number.isInteger(payload.lifecycleRevision) ? Number(payload.lifecycleRevision) : 0,
    operationId: typeof payload.operationId === 'string' ? payload.operationId : null,
    error: typeof payload.error === 'string' ? payload.error : null,
  };
}

export async function assertMachineHasNoOpenSpaces(env: Env, userId: string, catalog: { listSpaces(): Promise<PortableSpaceDefinition[]> }, machineId: string): Promise<void> {
  const namespace = env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>;
  for (const definition of await catalog.listSpaces()) {
    const authority = namespace.getByName(`${userId}:${definition.spaceId}`);
    const placement = await authority.get();
    if (placement?.machineId === machineId && placement.state !== 'closed') {
      throw new Error(`Machine ${machineId} still owns open space ${definition.spaceId}`);
    }
  }
}

async function checkpointAndStopFleetMachine(env: Env, userId: string, catalog: {
  listSpaces(): Promise<PortableSpaceDefinition[]>;
  putMachine(machine: FleetMachineDefinition): Promise<FleetMachineDefinition>;
}, current: FleetMachineDefinition, observed?: FleetMachineDefinition, action: 'sleep' | 'destroy' = 'sleep', discardConfirmation?: MachineDiscardConfirmation): Promise<FleetMachineDefinition> {
  const provider = machineProviderFor(env, userId, current);
  if (provider.id === 'physical') return provider.sleep(current);
  const durableCatalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
  const pendingDiscard = await durableCatalog.pendingMachineDiscard(current.id);
  // Offline intent is committed only after stopping. An interrupted or failed save
  // must never become permission for a later reconciliation to discard live work.
  const transition = await catalog.putMachine({
    ...current, state: 'sleeping', desiredState: pendingDiscard ? 'offline' : 'online',
    lifecycleRevision: current.lifecycleRevision + 1, operationId: crypto.randomUUID(), error: null,
  });
  let preparationAttempted = false;
  let discard: MachineDiscardScope[] | undefined = pendingDiscard?.workspaces;
  let discardStopAttempted = pendingDiscard !== null;
  try {
    observed ??= await provider.status(current);
    const alreadyStopped = observed.state === 'offline' && observed.desiredState === 'offline';
    if (!alreadyStopped && !pendingDiscard) {
      preparationAttempted = true;
      discard = (await provider.prepareReplacement(transition, action, discardConfirmation)).discard;
      if (discard && (!discardConfirmation || discardConfirmation.machineId !== current.id || discardConfirmation.action !== action)) {
        throw new Error('Runtime returned discard permission without the matching explicit confirmation');
      }
    }
    // Also check cloud ownership: a stale runtime cannot acknowledge spaces it
    // never loaded. An already stopped machine cannot save any remaining owners.
    if (!discard) await assertMachineHasNoOpenSpaces(env, userId, catalog, current.id);
    else {
      for (const definition of await catalog.listSpaces()) {
        const placement = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${definition.spaceId}`).get();
        if (placement?.machineId === current.id && !discard.some(scope => scope.workspaceId === placement.spaceId && scope.projectId === placement.projectId && scope.generation === placement.generation)) {
          throw new Error('Cloud ownership changed after discard confirmation');
        }
      }
    }
    if (discard && !pendingDiscard) {
      if (!discardConfirmation) throw new Error('Explicit local discard confirmation is required');
      // A lost persistence acknowledgement may already have authorized recovery;
      // never reopen admission after crossing this uncertain-effect boundary.
      discardStopAttempted = true;
      await durableCatalog.beginMachineDiscard({ confirmation: discardConfirmation, workspaces: discard });
    }
    discardStopAttempted = discard !== undefined;
    const stopped = alreadyStopped ? observed : await provider.sleep(transition);
    if (discard) {
      for (const scope of discard) {
        const authority = (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${scope.workspaceId}`);
        const placement = await authority.get();
        // Stale disk work is discarded locally; it cannot fence a different holder.
        if (placement?.machineId !== current.id) continue;
        const fenced = await authority.discardStoppedLocalWork({ userId, machineId: current.id, projectId: scope.projectId, spaceId: scope.workspaceId, expectedGeneration: scope.generation });
        if (fenced.status === 'error') throw new Error(fenced.failure.message);
      }
      await assertMachineHasNoOpenSpaces(env, userId, catalog, current.id);
      await durableCatalog.finishMachineDiscard(current.id);
    }
    return await catalog.putMachine({
      ...stopped, desiredState: 'offline', lifecycleRevision: Math.max(transition.lifecycleRevision, stopped.lifecycleRevision) + 1,
      operationId: null, error: null,
    });
  } catch (error) {
    let failure = error;
    let recovered = true;
    if (preparationAttempted && !discardStopAttempted) {
      try {
        await provider.cancelReplacement(transition);
        observed = await provider.status(transition);
      }
      catch (cancellationError) {
        recovered = false;
        failure = new Error(`${error instanceof Error ? error.message : String(error)}; preparation recovery failed: ${cancellationError instanceof Error ? cancellationError.message : String(cancellationError)}`, { cause: error });
      }
    }
    await catalog.putMachine({
      ...(observed ?? current), state: discardStopAttempted ? 'error' : recovered ? (observed ?? current).state : 'error', desiredState: discardStopAttempted ? 'offline' : 'online',
      lifecycleRevision: Math.max(transition.lifecycleRevision, observed?.lifecycleRevision ?? 0) + 1, operationId: null,
      error: failure instanceof Error ? failure.message : String(failure),
    });
    throw failure;
  }
}


async function confirmProvisionedCloudImage(env: Env, userId: string, machine: FleetMachineDefinition): Promise<void> {
  const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
  const image = await catalog.cloudImage(machine.id);
  if (!image || image.operation || image.currentImage !== null || image.desiredImage === null) return;
  const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(env, `/v1/sandboxes/${encodeURIComponent(machine.id)}/image/status`));
  if (machine.state !== 'online' || provider.image !== image.desiredImage || provider.prepared) throw new Error('Provisioned machine has not confirmed its selected image is ready');
  await catalog.saveCloudImage({ ...image, currentImage: provider.image });
}



export function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'sleep' | 'resume', discardConfirmation?: MachineDiscardConfirmation): Promise<FleetMachineDefinition>;
export function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'destroy', discardConfirmation?: MachineDiscardConfirmation): Promise<{ machineId: string; removed: true }>;
export function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'sleep' | 'resume' | 'destroy', discardConfirmation?: MachineDiscardConfirmation): Promise<FleetMachineDefinition | { machineId: string; removed: true }>;
export async function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'sleep' | 'resume' | 'destroy', discardConfirmation?: MachineDiscardConfirmation): Promise<FleetMachineDefinition | { machineId: string; removed: true }> {
  if (userId !== env.ACCOUNT_ID) throw new Error('Machine belongs to another account');
  const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
  if (cloudImageOperationActive(await catalog.cloudImage(machineId))) throw new Error('Recover or cancel this machine’s cloud image operation before changing its lifecycle');
  let existing: FleetMachineDefinition | null = await catalog.getMachine(machineId);
  if (!existing) {
    if (action === 'destroy') return { machineId, removed: true };
    throw new Error('Machine does not exist');
  }
  if (action === 'resume') {
    if (await catalog.pendingMachineDiscard(machineId)) throw new Error('Finish the confirmed local discard and provider-stop recovery before starting this machine');
    const provisioning = await catalog.resumeSandboxProvisioning(userId, machineId);
    if (provisioning) return provisioning;
  } else if (action === 'sleep' && await catalog.hasPendingSandbox(machineId)) {
    throw new Error('Finish sandbox provisioning before sleeping the machine');
  } else if (action === 'sleep' && await catalog.abandonedSandbox(machineId)) {
    throw new Error(existing.error ?? 'Sandbox provisioning failed permanently; destroy this entry and create a new machine.');
  }
  if (action === 'sleep' && existing.state === 'offline' && existing.desiredState === 'offline' && !await catalog.pendingMachineDiscard(machineId)) return existing;
  if (discardConfirmation && (discardConfirmation.machineId !== machineId || discardConfirmation.action !== action)) throw new Error('Discard confirmation does not match this machine operation');
  if (action === 'sleep') return checkpointAndStopFleetMachine(env, userId, catalog, existing, undefined, action, discardConfirmation);
  if (action === 'destroy' && existing.provider !== 'physical' && !await catalog.hasPendingSandbox(machineId) && !await catalog.abandonedSandbox(machineId)) {
    const approved = discardConfirmation ? await catalog.forcedDiscardScope(discardConfirmation) : null;
    if (approved) return forceDestroyCloudMachine(env, userId, catalog, existing, approved);
    try {
      existing = await checkpointAndStopFleetMachine(env, userId, catalog, existing, undefined, action, discardConfirmation);
    } catch (error) {
      if (error instanceof MachineDiscardRequired) throw error;
      // The cloud can always end a cloud machine: when saving fails for any reason, offer explicit loss
      // back to each workspace's last completed checkpoint rather than leaving it undestroyable.
      const workspaces = await ownedWorkspaceScopes(env, userId, catalog, machineId);
      throw new MachineDiscardRequired({
        message: `Saving this machine failed (${(error instanceof Error ? error.message : String(error)).slice(0, 500)}). Destroying it now discards everything on it since each workspace's last completed checkpoint.`,
        confirmation: await catalog.issueForcedDiscard(machineId, workspaces), workspaces,
      });
    }
  }
  const desiredState = action === 'resume' ? 'online' : 'removed';
  if (action === 'destroy') await assertMachineHasNoOpenSpaces(env, userId, catalog, machineId);
  const transition = await catalog.putMachine({
    ...existing, state: action === 'resume' ? 'resuming' : 'deleting',
    desiredState, lifecycleRevision: existing.lifecycleRevision + 1, operationId: existing.operationId ?? crypto.randomUUID(), error: null,
  });
  const provider = machineProviderFor(env, userId, transition);
  try {
    if (action === 'destroy') {
      await releaseMachineAttachments(env, userId, machineId, 'machine-destroyed');
      await credentialVault(env, userId).removeManagedDevice(machineId);
      await provider.destroy(transition);
      await catalog.removeMachine(machineId, true);
      return { machineId, removed: true };
    }
    const machine = await provider.resume(transition);
    await confirmProvisionedCloudImage(env, userId, machine);
    return await catalog.putMachine({ ...machine, desiredState, lifecycleRevision: transition.lifecycleRevision + 1, operationId: null, error: null });
  } catch (error) {
    await catalog.putMachine({ ...transition, state: 'error', lifecycleRevision: transition.lifecycleRevision + 1, operationId: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Legacy machine-held workspaces this machine still owns, as the scope a discard of its local work would cover. */
export async function ownedWorkspaceScopes(env: Env, userId: string, catalog: { listSpaces(): Promise<PortableSpaceDefinition[]> }, machineId: string): Promise<MachineDiscardScope[]> {
  const scopes: MachineDiscardScope[] = [];
  for (const definition of await catalog.listSpaces()) {
    const placement = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${definition.spaceId}`).get();
    if (placement?.machineId === machineId && placement.state !== 'closed') scopes.push({ projectId: placement.projectId, workspaceId: placement.spaceId, generation: placement.generation, reason: 'unpublished-local-work' });
  }
  return scopes;
}

/** Ends a cloud machine whose runtime could not checkpoint, once the user approved the exact loss scope.
 * The provider destroy precedes fencing, so the machine cannot write after its workspaces return to their
 * last completed checkpoints. Every step is idempotent: a retry after a partial failure converges. */
async function forceDestroyCloudMachine(env: Env, userId: string, catalog: DurableObjectStub<FleetCatalogDO>, existing: FleetMachineDefinition, approved: MachineDiscardScope[]): Promise<{ machineId: string; removed: true }> {
  const owned = await ownedWorkspaceScopes(env, userId, catalog, existing.id);
  if (owned.some(scope => !approved.some(item => item.workspaceId === scope.workspaceId && item.projectId === scope.projectId && item.generation === scope.generation))) {
    throw new MachineDiscardRequired({
      message: 'Workspace ownership on this machine changed after you approved discarding its unsaved work. Review the current loss scope before destroying it.',
      confirmation: await catalog.issueForcedDiscard(existing.id, owned), workspaces: owned,
    });
  }
  const transition = await catalog.putMachine({ ...existing, state: 'deleting', desiredState: 'removed', lifecycleRevision: existing.lifecycleRevision + 1, operationId: crypto.randomUUID(), error: null });
  try {
    await releaseMachineAttachments(env, userId, existing.id, 'machine-destroyed');
    await credentialVault(env, userId).removeManagedDevice(existing.id);
    await machineProviderFor(env, userId, transition).destroy(transition);
    for (const scope of owned) {
      const fenced = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${scope.workspaceId}`)
        .discardStoppedLocalWork({ userId, machineId: existing.id, projectId: scope.projectId, spaceId: scope.workspaceId, expectedGeneration: scope.generation });
      if (fenced.status === 'error') throw new Error(fenced.failure.message);
    }
    await catalog.finishMachineDiscard(existing.id);
    await catalog.removeMachine(existing.id, true);
    return { machineId: existing.id, removed: true };
  } catch (error) {
    await catalog.putMachine({ ...transition, state: 'error', lifecycleRevision: transition.lifecycleRevision + 1, operationId: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export async function provisionManagedSandbox(env: Env, userId: string, controlUrl: string, imageSelection?: CloudImageSelection): Promise<FleetMachineDefinition> {
  if (userId !== env.ACCOUNT_ID) throw new Error('Machine belongs to another account');
  const storageNamespace = env.USER_STORAGE as DurableObjectNamespace<UserStorageDO>;
  await storageNamespace.getByName(userId).requireReady(userId);
  const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
  await catalog.assertCloudMachineCapacity();
  const choice = imageSelection ? await resolveCloudImage(env, cloudImageSelectionSchema.parse(imageSelection)) : await catalog.cloudImageDefault();
  const vault = credentialVault(env, userId);
  const rootPublicKey = await vault.rootPublicKey();
  if (!rootPublicKey) throw new Error('Vault is not configured');
  if (!env.GITSPACE_OMP_BROKER_TOKEN) throw new Error('Account credential broker is not configured');
  const machineId = `sandbox-${crypto.randomUUID().slice(0, 8)}`;
  const accountSettings = await (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(userId).get(machineId);
  if (!accountSettings.profile.handle) throw new Error('Account tenant is not provisioned');
  const signingPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const exchangePrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const device = {
    userId, machineId,
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(exchangePrivateKey)),
    capabilities: ['storage.access', 'space.control', 'credential.access'] satisfies Array<'storage.access' | 'space.control' | 'credential.access'>,
  };
  const registered = await vault.registerManagedDevice(device);
  if (registered.status === 'error') throw new Error(registered.error.message);
  // The worker holds no root key: the managed grant is self-signed and the vault's
  // managed-device row (this generation) is what the relay authorizes against.
  const machineGrant = signCredentialAuthorityGrant({ version: 1, ...device, generation: registered.value.generation }, signingPrivateKey);
  // The tenant commits this complete enrollment and immutable image before
  // acknowledging. Slow preparation/boot belongs to its durable background run.
  return catalog.beginSandboxProvisioning({
    userId, machineId, choice,
    environment: {
      GITSPACE_ENVIRONMENT_ROOT: '/workspace/gitspace',
      GITSPACE_MACHINE_ID: machineId,
      GITSPACE_MACHINE_LABEL: `Cloudflare ${machineId.slice('sandbox-'.length)}`,
      GITSPACE_CONTROL_URL: controlUrl,
      GITSPACE_USER_ID: userId,
      // Worker provisioning pins the same root that installed the machine key.
      GITSPACE_ROOT_PUBLIC_KEY: rootPublicKey,
      GITSPACE_MACHINE_SIGNING_PRIVATE_KEY: credentialProtocolBase64.encode(signingPrivateKey),
      // Every machine executes through the tenant relay, exactly like paired computers.
      GITSPACE_RELAY_URL: env.RELAY_URL,
      GITSPACE_MACHINE_GRANT: JSON.stringify(machineGrant),
      GITSPACE_CONTROL_TOKEN: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))),
      GITSPACE_SERVICE_DOMAIN: 'gssh.dev',
      GITSPACE_SERVICE_NAMESPACE: accountSettings.profile.handle,
      GITSPACE_MANAGED_SPACE_ROOT: '/workspace/spaces',
      GITSPACE_MIGRATIONS_FOLDER: '/opt/gitspace/drizzle',
      GITSPACE_RPC_PORT: '8081',
      GITSPACE_RPC_HOST: '0.0.0.0',
    },
  }).catch(async (error: unknown) => {
    // The cap can race between the early check and enrollment; a refused machine keeps no usable credential.
    await vault.removeManagedDevice(machineId);
    throw error;
  });
}


/** Forward once: a transport error cannot prove that the signed operation did not run. */
export async function proxyAccountMachineRpc(request: Request, env: Env, userId: string, machine: FleetMachineDefinition): Promise<Response> {
  if (machine.provider === 'cloudflare-sandbox' && (await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).cloudImage(machine.id))?.operation?.barrier) {
    return Response.json(publicError('CLOUD_IMAGE_IN_PROGRESS', 'This cloud machine is checkpointing or recovering'), { status: 503, headers: { 'cache-control': 'private, no-store' } });
  }
  const headers = new Headers(request.headers);
  headers.delete('x-gitspace-user');
  headers.delete('host');
  const target = new URL(request.url);
  headers.set('x-gitspace-signed-target', `${target.pathname}${target.search}`);
  const managedSandbox = machine.provider === 'cloudflare-sandbox';
  if (managedSandbox) headers.set('x-gitspace-user-id', userId);
  const upstream = new Request(managedSandbox
    ? `https://sandbox.internal/v1/sandboxes/${encodeURIComponent(machine.id)}/rpc`
    : machine.rpcEndpoint!, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    redirect: 'manual',
  });
  if (managedSandbox) return tenantProvider(env).fetch(upstream);
  const endpoint = new URL(upstream.url);
  const tunnel = endpoint.origin === new URL(env.RELAY_URL).origin ? tunnelTarget(endpoint) : null;
  return tunnel ? forwardTunnelRequest(upstream, env, tunnel) : fetch(upstream);
}

interface RoutedAccountRpc {
  response: Response;
  procedures?: readonly string[];
  /** `cloud` when the account router answered; otherwise the machine it was forwarded to. */
  target?: string;
}

async function routeAccountRpc(request: Request, env: Env): Promise<RoutedAccountRpc> {
  const userId = request.headers.get('x-gitspace-user');
  if (!userId || !/^u-[a-f0-9]{32}$/u.test(userId)) {
    return { response: Response.json(publicError('ACCOUNT_REQUIRED', 'Account identity is missing'), { status: 401 }) };
  }
  const account = await activeAccount(env, userId);
  const denied = accountAccessResponse(account);
  if (denied) return { response: denied };
  const settings = await (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(userId).get('account-router');
  const handle = settings.profile.handle;
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!handle || hostname !== `${handle}.gitspace.sh`) {
    return { response: Response.json(publicError('ACCOUNT_HOST_MISMATCH', 'Request does not belong to this account hostname'), { status: 403 }) };
  }
  const route = await handleAccountCloudRpc(request, env, userId);
  if (route.kind === 'response') return route;
  return { response: await proxyAccountMachineRpc(request, env, userId, route.machine), procedures: route.procedures, target: route.machine.id };
}

const SLOW_RPC_BATCH_MS = 5_000;
const rpcErrorBodySchema = z.object({ error: z.object({ code: z.string() }) });

/** Workers observability records only the path (no query, headers or bodies):
 * name failed and slow batches. Proxied streams are timed to their response headers. */
async function accountRpcResponse(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const { response, procedures, target } = await routeAccountRpc(request, env);
  const durationMs = Date.now() - started;
  if (response.status < 400 && durationMs <= SLOW_RPC_BATCH_MS) return response;
  let code: string | undefined;
  if (response.status >= 400 && response.headers.get('content-type')?.includes('application/json')) {
    code = rpcErrorBodySchema.safeParse(await response.clone().json().catch(() => null)).data?.error.code;
  }
  console.log(JSON.stringify({
    event: 'rpc_batch',
    procedures: procedures ?? new URL(request.url).searchParams.get('p')?.split(',') ?? [],
    status: response.status, code, durationMs, target,
  }));
  return response;
}

const worker = {
  async fetch(request: Request, env: Env, diagnostics?: SyncRequestDiagnostics): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/directory/events') {
      return (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(env.ACCOUNT_ID).fetch(request);
    }
    if (url.pathname.startsWith('/shared-artifacts/')) return serveArtifactShare(request, env);
    const distribution = await accountDistributionResponse(request, env, url.pathname);
    if (distribution) return distribution;
    if (url.pathname.startsWith('/files/')) return serveArtifactFile(request, env);
    if (url.pathname.startsWith('/images/')) return serveRuntimeImage(request, env);
    if (url.pathname.startsWith('/v1/shared-guides/')) {
      const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
      return denied ?? serveGuideShare(request, env, url);
    }

    const mcpAccessRoute = /^\/v1\/mcp-access\/(status|enable|rotate|disable)$/u.exec(url.pathname);
    if (mcpAccessRoute) {
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': `content-type, ${RPC_DEVICE_HEADER}, x-gitspace-user`,
        'cache-control': 'private, no-store',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers });
      if (url.origin !== new URL(env.ACCOUNT_URL).origin) {
        return Response.json(publicError('ACCOUNT_HOST_MISMATCH', 'MCP setup belongs to this account origin'), { status: 403, headers });
      }
      try {
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (reader) {
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > REQUEST_MAX_BYTES) { await reader.cancel(); return new Response('Request too large', { status: 413, headers }); }
              chunks.push(chunk.value);
            }
          } finally { reader.releaseLock(); }
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { userId?: unknown };
        if (parsed.userId !== env.ACCOUNT_ID || request.headers.get('x-gitspace-user') !== env.ACCOUNT_ID) {
          return Response.json(publicError('RPC_FORBIDDEN', 'Account identity is invalid'), { status: 403, headers });
        }
        const account = await activeAccount(env, env.ACCOUNT_ID);
        const denied = accountAccessResponse(account);
        if (denied) return denied;
        if (account.status !== 'ok' || url.hostname !== `${account.value.handle}.gitspace.sh`) {
          return Response.json(publicError('ACCOUNT_HOST_MISMATCH', 'MCP setup belongs to the current account hostname'), { status: 403, headers });
        }
        const result = await credentialVault(env, env.ACCOUNT_ID).mcpAccessRequest({
          operation: mcpAccessRoute[1] as McpAccessOperation, header: request.headers.get(RPC_DEVICE_HEADER), target: `${url.pathname}${url.search}`, body,
        });
        return Response.json(result, { status: result.status === 'ok' ? 200 : result.error.code === 'MCP_ACCESS_CONFLICT' ? 409 : 403, headers });
      } catch {
        return Response.json(publicError('INVALID_MCP_ACCESS', 'MCP access request is invalid'), { status: 400, headers });
      }
    }
    const browserInvitationRoute = /^\/v1\/devices\/browser-invitations\/(create|status|cancel)$/u.exec(url.pathname);
    if (browserInvitationRoute) {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': `content-type, ${RPC_DEVICE_HEADER}, x-gitspace-user`,
        'cache-control': 'private, no-store',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
      try {
        const declared = Number(request.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > REQUEST_MAX_BYTES) throw new Error('Browser invitation request is too large');
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > REQUEST_MAX_BYTES) throw new Error('Browser invitation request is too large');
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { userId?: unknown };
        if (typeof parsed.userId !== 'string' || !/^u-[a-f0-9]{32}$/u.test(parsed.userId)
          || request.headers.get('x-gitspace-user') !== parsed.userId) throw new Error('Account identity is invalid');
        const account = await activeAccount(env, parsed.userId);
        if (account.status === 'error') {
          const denied = accountAccessResponse(account)!;
          return new Response(denied.body, { status: denied.status, headers: { ...Object.fromEntries(denied.headers), ...cors } });
        }
        const handle = accountHandleForHostname(url.hostname);
        if (handle && handle !== account.value.handle) return Response.json(publicError('ACCOUNT_HOST_MISMATCH', 'Request does not belong to this account hostname'), { status: 403, headers: cors });
        const result = await credentialVault(env, parsed.userId).browserInvitationRequest({
          operation: browserInvitationRoute[1]!, header: request.headers.get(RPC_DEVICE_HEADER), target: `${url.pathname}${url.search}`, body,
        });
        return Response.json(result, { status: result.status === 'ok' ? 200 : 403, headers: cors });
      } catch (error) {
        return Response.json(publicError('INVALID_BROWSER_INVITATION', error instanceof Error ? error.message : 'Invalid browser invitation request'), { status: 400, headers: cors });
      }
    }
    const pairingRoute = /^\/v1\/machine-pairings\/(create|inspect|approve|cancel|claim|poll)$/u.exec(url.pathname);
    if (pairingRoute) {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': `content-type, ${RPC_DEVICE_HEADER}, x-gitspace-user`,
        'cache-control': 'private, no-store',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
      try {
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > REQUEST_MAX_BYTES) throw new Error('Pairing request is too large');
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { userId?: unknown };
        if (typeof parsed.userId !== 'string' || !/^u-[a-f0-9]{32}$/u.test(parsed.userId)) throw new Error('Account identity is invalid');
        const denied = accountAccessResponse(await activeAccount(env, parsed.userId));
        if (denied) return new Response(denied.body, { status: denied.status, headers: { ...Object.fromEntries(denied.headers), ...cors } });
        const result = await credentialVault(env, parsed.userId).machinePairingRequest({
          operation: pairingRoute[1]!, header: request.headers.get(RPC_DEVICE_HEADER), target: `${url.pathname}${url.search}`, body, apiUrl: env.ACCOUNT_URL,
        });
        return Response.json(result, { status: result.status === 'ok' ? 200 : 403, headers: cors });
      } catch (error) {
        return Response.json(publicError('INVALID_PAIRING', error instanceof Error ? error.message : 'Invalid pairing request'), { status: 400, headers: cors });
      }
    }
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', providers: [...SUPPORTED_PROVIDERS] }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, version: WORKER_STAMP.version }, { headers: { 'cache-control': 'no-store', [WORKER_VERSION_HEADER]: WORKER_STAMP.version } });
    }
    
    const sandboxRpc = /^\/__sandbox\/([^/]+)\/([^/]+)\/rpc$/u.exec(url.pathname);
    if (sandboxRpc) {
      // Device signatures authorize RPC; this route does not use browser cookies.
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-gitspace-device, x-gitspace-user',
        'access-control-expose-headers': 'x-result-rpc-contract',
        'cache-control': 'private, no-store',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
      const userId = decodeURIComponent(sandboxRpc[1]!);
      const machineId = decodeURIComponent(sandboxRpc[2]!);
      if (!/^u-[a-f0-9]{32}$/u.test(userId) || !/^sandbox-[a-z0-9-]{1,64}$/u.test(machineId)) {
        return Response.json(publicError('INVALID_SANDBOX_ROUTE', 'Sandbox RPC route is invalid'), { status: 400, headers: cors });
      }
      const denied = accountAccessResponse(await activeAccount(env, userId));
      if (denied) return new Response(denied.body, { status: denied.status, headers: { ...Object.fromEntries(denied.headers), ...cors } });
      if ((await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).cloudImage(machineId))?.operation?.barrier) {
        return Response.json(publicError('CLOUD_IMAGE_IN_PROGRESS', 'This cloud machine is checkpointing or recovering'), { status: 503, headers: cors });
      }
      const headers = new Headers(request.headers);
      headers.set('x-gitspace-user-id', userId);
      headers.delete('host');
      headers.set('x-gitspace-signed-target', `${url.pathname}${url.search}`);
      const response = await tenantProvider(env).fetch(new Request(`https://sandbox.internal/v1/sandboxes/${encodeURIComponent(machineId)}/rpc`, {
        method: 'POST',
        headers,
        body: request.body,
        signal: request.signal,
        redirect: 'manual',
      }));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
    }

    if (url.pathname === '/rpc') return accountRpcResponse(request, env);
    if (url.pathname === '/v1/relay/authorize' && request.method === 'POST') {
      try {
        const body = await readBoundedJson(request) as { grant?: unknown; capability?: unknown };
        const capability = body.capability;
        if (capability !== 'space.control' && capability !== 'storage.access') {
          return Response.json(publicError('INVALID_CAPABILITY', 'Relay capability is invalid'), { status: 400 });
        }
        const grant = signedCredentialAuthorityGrantSchema.parse(body.grant);
        const result = await withDeviceAuthority(env, (view, now) => {
          const authorized = view.authorizeRelayGrant(grant, capability, now);
          if (authorized.status === 'error') return authorized;
          const account = accountStatus(env, view, grant.grant.userId);
          return account.status === 'error' ? { ...account, miss: false } : authorized;
        });
        if (result.status === 'ok') return Response.json({ status: 'ok', value: { authorized: true } }, { headers: { 'cache-control': 'no-store' } });
        const unavailable = result.error.code === 'ACCOUNT_AUTHORITY_UNAVAILABLE' || result.error.code === DEVICE_AUTHORITY_UNAVAILABLE;
        return Response.json(result, { status: unavailable ? 503 : 401, headers: { 'cache-control': 'no-store' } });
      } catch {
        return Response.json(publicError('DEVICE_UNAUTHORIZED', 'Invalid relay authorization'), { status: 401 });
      }
    }
    if (url.pathname === '/v1/accounts/recover' && request.method === 'POST') {
      const body = await readBoundedJson(request) as { rootPublicKey?: unknown; handle?: unknown };
      if (typeof body.rootPublicKey !== 'string' || typeof body.handle !== 'string') {
        return Response.json(publicError('INVALID_RECOVERY', 'Root public key and handle are required'), { status: 400 });
      }
      const userId = await accountIdForRootPublicKey(body.rootPublicKey);
      if (!userId) return Response.json(publicError('INVALID_RECOVERY', 'Root public key is invalid'), { status: 400 });
      const authorized = await credentialVault(env, userId).authorizeRoot(request.headers.get('authorization'), `${url.pathname}${url.search}`);
      if (authorized.status === 'error') return Response.json(authorized, { status: 401 });
      const account = await accountState(env).get(userId);
      if (!account || account.handle !== body.handle.trim().toLowerCase()) {
        return Response.json(publicError('ACCOUNT_NOT_FOUND', 'No account matches this recovery key and handle'), { status: 404 });
      }
      const handle = accountHandleForHostname(url.hostname);
      if (handle && handle !== account.handle) {
        return Response.json(publicError('ACCOUNT_HOST_MISMATCH', 'Request does not belong to this account hostname'), { status: 403 });
      }
      if (account.status !== 'active') {
        return Response.json(publicError('ACCOUNT_UNAVAILABLE', 'Account is not active; contact the operator'), { status: 409 });
      }
      const denied = accountAccessResponse(await activeAccount(env, userId));
      if (denied) return denied;
      return Response.json({
        status: 'ok',
        value: {
          userId,
          handle: account.handle,
          relayUrl: env.RELAY_URL,
          accountUrl: env.ACCOUNT_URL,
          apiUrl: env.ACCOUNT_URL,
        },
      }, { headers: { 'cache-control': 'private, no-store' } });
    }
    if (url.pathname === '/v1/accounts/bootstrap' && request.method === 'POST') {
      try {
        const body = await readBoundedJson(request) as { rootPublicKey?: unknown; vaultKey?: unknown; handle?: unknown };
        if (body.rootPublicKey !== env.AUTH_PUBLIC_KEY || body.handle !== env.TENANT_ID || typeof body.vaultKey !== 'string') return Response.json(publicError('TENANT_MISMATCH', 'Bootstrap identity does not own this tenant'), { status: 403 });
        const proof = verifyRelayAuthorization({ header: request.headers.get('authorization'), signingPublicKey: env.AUTH_PUBLIC_KEY, target: url.pathname + url.search, maxSkewMs: SIGNED_REQUEST_MAX_AGE_MS });
        if (proof.status === 'error') {
          return Response.json(proof.error.expired ? publicError(SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE) : publicError('ROOT_UNAUTHORIZED', proof.error.message), { status: 401 });
        }
        const userId = env.ACCOUNT_ID;
        const vault = credentialVault(env, userId);
        const configured = await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: body.vaultKey });
        if (configured.status === 'error') return Response.json(configured, { status: 409 });
        const settings = (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(userId);
        const current = await settings.get('account-bootstrap');
        if (current.profile.handle !== env.TENANT_ID) {
          const result = await settings.setHandle('account-bootstrap', current.revision, env.TENANT_ID);
          if (result.status === 'conflict') throw new Error('Account settings changed during bootstrap');
        }
        await projectSecrets(env, userId).bootstrap({ userId, vaultKey: body.vaultKey });
        const storage = (env.USER_STORAGE as DurableObjectNamespace<UserStorageDO>).getByName(userId);
        await storage.beginProvisioning({ userId, gitBucketName: env.STORAGE_BUCKET });
        await storage.markReady({ userId, gitBucketName: env.STORAGE_BUCKET });
        await ensureAccountGitSpaceProject(env, userId);
        return Response.json({ status: 'ok', value: { userId, handle: env.TENANT_ID, relayUrl: env.RELAY_URL, accountUrl: env.ACCOUNT_URL, apiUrl: env.ACCOUNT_URL } }, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return Response.json(publicError('BOOTSTRAP_FAILED', error instanceof Error ? error.message : 'Bootstrap failed'), { status: 502 }); }
    }
    if (url.pathname === '/v1/machines/enroll' && request.method === 'POST') {
      try {
        const body = await readBoundedJson(request) as { userId?: unknown; label?: unknown; deviceGrant?: unknown; machineProtocol?: unknown; machinePlatform?: unknown };
        if (typeof body.userId !== 'string' || typeof body.label !== 'string') {
          return Response.json(publicError('INVALID_MACHINE', 'Machine identity and label are required'), { status: 400 });
        }
        const vault = credentialVault(env, body.userId);
        const authorized = await vault.authorizeRoot(request.headers.get('authorization'), `${url.pathname}${url.search}`);
        if (authorized.status === 'error') return Response.json(authorized, { status: 401 });
        const denied = accountAccessResponse(await activeAccount(env, body.userId));
        if (denied) return denied;
        const signedGrant = signedCredentialAuthorityGrantSchema.parse(body.deviceGrant);
        if (signedGrant.grant.userId !== body.userId) return Response.json(publicError('INVALID_MACHINE', 'Machine grant belongs to another account'), { status: 400 });
        const registered = await vault.registerDevice(signedGrant);
        if (registered.status === 'error' && registered.error.code !== 'STALE_DEVICE_GRANT') {
          return Response.json(registered, { status: 400 });
        }
        if (registered.status === 'error') {
          const current = await withDeviceAuthority(env, (view, now) => view.authorizeRelayGrant(signedGrant, 'space.control', now));
          if (current.status === 'error') return accountAccessResponse(current)!;
        }
        const accountSettings = await (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(body.userId).get(signedGrant.grant.machineId);
        if (!accountSettings.profile.handle) return Response.json(publicError('ACCOUNT_UNPROVISIONED', 'Account tenant is not provisioned'), { status: 409 });
        const relayUrl = `https://${accountSettings.profile.handle}.gssh.dev`;
        const machine = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(body.userId).putMachine({
          id: signedGrant.grant.machineId,
          label: body.label.slice(0, 160),
          state: 'offline',
          rpcEndpoint: `${relayUrl}/tunnel/${encodeURIComponent(signedGrant.grant.machineId)}/rpc`,
          kind: 'physical',
          provider: 'physical',
          notes: '',
          desiredState: 'online',
          lifecycleRevision: registered.status === 'ok' ? registered.value.generation : signedGrant.grant.generation,
          operationId: null,
          error: null,
        });
        const machineExecution = await tenantReleases(env, body.userId).machineProtocol(machine.id, machineProtocolInputSchema.parse({ version: body.machineProtocol ?? null, platform: body.machinePlatform ?? null }));
        return Response.json({ status: 'ok', value: { machine, relayUrl, machineExecution } }, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) {
        return Response.json(publicError('INVALID_MACHINE', error instanceof Error ? error.message : 'Machine enrollment failed'), { status: 400 });
      }
    }
    if (url.pathname === '/v1/machines/revoke' && request.method === 'POST') {
      try {
        const body = await readBoundedJson(request) as { userId?: unknown; machineId?: unknown };
        if (typeof body.userId !== 'string' || typeof body.machineId !== 'string') {
          return Response.json(publicError('INVALID_MACHINE', 'Machine identity is required'), { status: 400 });
        }
        const vault = credentialVault(env, body.userId);
        const root = await vault.authorizeRoot(request.headers.get('authorization'), `${url.pathname}${url.search}`);
        const machineId = body.machineId;
        const authorized = root.status === 'ok' ? root
          : await withDeviceAuthority(env, (view, now) => view.authorizeMachineRelay(request.headers.get('authorization'), `${url.pathname}${url.search}`, machineId, now));
        if (authorized.status === 'error') return accountAccessResponse(authorized)!;
        const denied = accountAccessResponse(await activeAccount(env, body.userId));
        if (denied) return denied;
        await releaseMachineAttachments(env, body.userId, body.machineId, 'machine-revoked');
        await vault.removeManagedDevice(body.machineId);
        const removed = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(body.userId).removeMachine(body.machineId);
        return Response.json({ status: 'ok', value: { machineId: body.machineId, removed } }, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) {
        return Response.json(publicError('INVALID_MACHINE', error instanceof Error ? error.message : 'Machine revocation failed'), { status: 400 });
      }
    }
    if (url.pathname === '/__dev/bootstrap' && request.method === 'POST' && env.GITSPACE_DEV_BOOTSTRAP_TOKEN) {
      if (request.headers.get('authorization') !== `Bearer ${env.GITSPACE_DEV_BOOTSTRAP_TOKEN}`) return new Response('Unauthorized', { status: 401 });
      try {
        const body = await readBoundedJson(request) as {
          userId?: unknown;
          handle?: unknown;
          rootPublicKey?: unknown;
          vaultKey?: unknown;
          deviceGrant?: unknown;
          gitBucketName?: unknown;
          credentials?: unknown;
        };
        if (typeof body.userId !== 'string' || typeof body.rootPublicKey !== 'string' || typeof body.vaultKey !== 'string') {
          throw new Error('Development bootstrap is invalid');
        }
        if (typeof body.handle !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(body.handle)) {
          throw new Error('Development account handle is required');
        }
        if (body.userId !== env.ACCOUNT_ID || body.handle !== env.TENANT_ID || body.rootPublicKey !== env.AUTH_PUBLIC_KEY) throw new Error('Development tenant identity does not match');
        const settings = (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(body.userId);
        const current = await settings.get('development-bootstrap');
        if (current.profile.handle !== body.handle) {
          const changed = await settings.setHandle('development-bootstrap', current.revision, body.handle);
          if (changed.status === 'conflict') throw new Error('Development account settings changed');
        }
        const vault = credentialVault(env, body.userId);
        const configured = await vault.bootstrap({ userId: body.userId, rootPublicKey: body.rootPublicKey, vaultKey: body.vaultKey });
        if (configured.status === 'error') return Response.json(configured, { status: 400 });
        const registered = await vault.registerDevice(body.deviceGrant as SignedCredentialAuthorityGrant);
        if (registered.status === 'error' && registered.error.code !== 'STALE_DEVICE_GRANT') return Response.json(registered, { status: 400 });
        if (typeof body.gitBucketName === 'string') {
          const namespace = env.USER_STORAGE as DurableObjectNamespace<UserStorageDO>;
          const storage = namespace.get(namespace.idFromName(body.userId));
          await storage.beginProvisioning({ userId: body.userId, gitBucketName: body.gitBucketName });
          await storage.markReady({ userId: body.userId, gitBucketName: body.gitBucketName });
        }
        await projectSecrets(env, body.userId).bootstrap({ userId: body.userId, vaultKey: body.vaultKey });
        if (Array.isArray(body.credentials)) {
          for (const candidate of body.credentials) {
            if (!candidate || typeof candidate !== 'object') throw new Error('Development credential is invalid');
            const value = candidate as Record<string, unknown>;
            if (typeof value.id !== 'string' || typeof value.provider !== 'string' || !SUPPORTED_PROVIDERS.has(value.provider) || typeof value.access !== 'string' || typeof value.refresh !== 'string' || typeof value.expires !== 'number') {
              throw new Error('Development credential is invalid');
            }
            await vault.putCredential({
              id: value.id,
              credential: {
                provider: value.provider as StoredOAuthCredential['provider'],
                access: value.access,
                refresh: value.refresh,
                expires: value.expires,
                ...(typeof value.accountId === 'string' ? { accountId: value.accountId } : {}),
                ...(typeof value.email === 'string' ? { email: value.email } : {}),
                ...(typeof value.orgId === 'string' ? { orgId: value.orgId } : {}),
                ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
              },
            });
          }
        }
        await ensureAccountGitSpaceProject(env, body.userId);
        return Response.json(registered.status === 'ok' ? registered : { status: 'ok', value: { machineId: 'existing', generation: 0 } });
      } catch (error) {
        return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Development bootstrap is invalid' } }, { status: 400 });
      }
    }
    const dataMatch = /^\/v1\/data\/(.+)$/u.exec(url.pathname);
    if (dataMatch) {
      try {
        if (diagnostics) diagnostics.stage = 'parse';
        return await dataObjectResponse(request, env, dataKeyFromPath(dataMatch[1]!), diagnostics);
      } catch (error) {
        if (diagnostics) {
          diagnostics.caughtError = true;
          diagnostics.error = caughtErrorSummary(error);
        }
        return dataFailureResponse(error);
      }
    }
    // The settings object admits the socket; its signed proof rides in `Sec-WebSocket-Protocol`.
    if (url.pathname === '/v1/settings/events') return env.USER_SETTINGS.getByName(env.ACCOUNT_ID).fetch(request);
    if (url.pathname === '/v1/devices/enroll') {
      // Browsers enroll cross-origin from the machine-served app; the invite is
      // the credential, so the route is open to any origin.
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'cache-control': 'private, no-store' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
      try {
        const body = await readBoundedJson(request) as { invite?: unknown; binding?: unknown };
        const invite = signedDeviceInviteSchema.parse(body.invite);
        const binding = deviceBindingSchema.parse(body.binding);
        const account = await activeAccount(env, invite.invite.userId);
        if (account.status === 'error') {
          const denied = accountAccessResponse(account)!;
          return new Response(denied.body, { status: denied.status, headers: { ...cors, 'content-type': 'application/json' } });
        }
        const handle = accountHandleForHostname(url.hostname);
        if (handle && handle !== account.value.handle) return Response.json(publicError('ACCOUNT_HOST_MISMATCH', 'Request does not belong to this account hostname'), { status: 403, headers: cors });
        const result = await credentialVault(env, invite.invite.userId).enrollDevice({ invite, binding });
        return Response.json(result, { status: result.status === 'ok' ? 200 : 400, headers: cors });
      } catch (error) {
        return Response.json({ status: 'error', error: { code: 'INVALID_DEVICE_ENROLLMENT', message: error instanceof Error ? error.message : 'Invalid enrollment' } }, { status: 400, headers: cors });
      }
    }
    // GitHub reaches these without a GitSpace credential: webhooks carry the App's signature, callbacks a one-time state.
    if (url.pathname.startsWith('/github/')) {
      const github = await githubRoute(request, env, url);
      if (github) return github;
    }
    if (url.pathname === '/v1/mcp/composio/callback' && request.method === 'GET') {
      const principalId = url.searchParams.get('principal') ?? '';
      const state = url.searchParams.get('gitspace_state') ?? '';
      const signature = url.searchParams.get('signature') ?? '';
      const denied = accountAccessResponse(await activeAccount(env, principalId));
      if (denied) return denied;
      const accountApiKey = principalId ? await credentialVault(env, principalId).getProviderSecret('composio') : null;
      if (!principalId || !state || !await verifyComposioState(env, principalId, state, signature, accountApiKey)) {
        return new Response('Invalid or expired Composio authorization', { status: 400, headers: { 'cache-control': 'no-store' } });
      }
      try {
        await userMcpConnections(env, principalId).consumeComposioAuthorization(principalId, state);
        return new Response(`<!doctype html><meta charset=\"utf-8\"><title>Plugin connected</title><style>body{font:16px system-ui;margin:48px;color:#161616}p{color:#5f5f5f}</style><h1>Plugin connected</h1><p>You can close this window and return to GitSpace.</p><script>window.opener?.postMessage({type:'gitspace:composio-connected'},location.origin);window.close()</script>`, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      } catch (error) {
        return new Response(error instanceof Error ? error.message : 'Composio authorization failed', { status: 400, headers: { 'cache-control': 'no-store' } });
      }
    }
    if (url.pathname === '/v1/control' && request.method === 'POST') {
      let signedControl: SignedControlRequest | null = null;
      try {
        if (diagnostics) diagnostics.stage = 'parse';
        const body = signedControlRequestSchema.parse(await readBoundedJson(request));
        signedControl = body;
        recordSyncRequestParsed(diagnostics, body);
        if (body.operation === 'catalog.machine.put' && body.payload.id !== body.machineId) {
          return Response.json({ status: 'error', error: { code: 'MACHINE_FLEET_CONTROL_DENIED', message: 'A machine credential may only report its own machine.' } }, { status: 403, headers: { 'cache-control': 'no-store' } });
        }
        const capability = body.operation === 'secrets.materialize' ? 'credential.access'
          : body.operation.startsWith('runtime.repository.') || body.operation.startsWith('settings.') ? 'storage.access'
          : body.operation.startsWith('runtime.')
            || body.operation.startsWith('catalog.')
            || body.operation.startsWith('mcp.')
            || body.operation.startsWith('devices.')
            || body.operation.startsWith('account.issues.')
            || body.operation.startsWith('deploy.')
            || body.operation.startsWith('lfs.')
            || body.operation.startsWith('project.environment.')
            || body.operation.startsWith('project.mcp.') ? 'space.control'
          : 'storage.access';
        if (diagnostics) diagnostics.stage = 'authorize';
        const authorized = await authorizeControl(env, body, capability);
        if (authorized.status === 'error') return accountAccessResponse(authorized)!;
        if (body.operation.startsWith('runtime.')) {
          // A Durable Object that fails or resets answers only "internal error; reference = …"; the operation and
          // workspace are logged here so the failure can be found.
          const value = await runtimeMachineControl(env, body).catch((error: unknown) => {
            const payload = z.object({ workspaceId: z.string() }).partial().safeParse(body.payload).data;
            console.error(JSON.stringify({
              event: 'machine_control_failed', operation: body.operation, machineId: body.machineId, workspaceId: payload?.workspaceId ?? null,
              error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack ?? null : null,
            }));
            throw error;
          });
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (diagnostics) diagnostics.stage = 'processing';
        if (body.operation === 'lfs.pin' || body.operation === 'lfs.release') {
          const identity = z.object({ projectId: z.string().min(1), publicationId: z.string().min(1).max(256) });
          const input = body.operation === 'lfs.pin'
            ? { operation: body.operation, ...identity.extend({ objects: z.array(GitLfsObjectSchema).max(10_000) }).strict().parse(body.payload) }
            : { operation: body.operation, ...identity.strict().parse(body.payload) };
          if (body.userId !== env.ACCOUNT_ID) throw new Error('LFS account identity mismatch');
          projectStorageRoot(input.projectId);
          const authority = env.PROJECT_AUTHORITY.getByName(`${body.userId}:${input.projectId}`);
          const project = await authority.getProject();
          if (!project || project.id !== input.projectId || project.lifecycle === 'deleting') throw new Error('LFS project is unavailable');
          const publicationId = `${body.machineId}:${input.publicationId}`;
          if (input.operation === 'lfs.pin') return Response.json({ status: 'ok', value: GitLfsProtectionSchema.parse({ objects: await authority.lfsProtect({ publicationId, objects: input.objects }) }) }, { headers: { 'cache-control': 'private, no-store' } });
          await authority.lfsReleasePublication(publicationId);
          return Response.json({ status: 'ok', value: null }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('storage.migration.')) {
          if (body.userId !== env.ACCOUNT_ID) throw new Error('Storage migration account identity mismatch');
          const migration = env.STORAGE_MIGRATION.getByName(body.userId);
          let value: unknown;
          switch (body.operation) {
            case 'storage.migration.status':
              value = storageMigrationStatusInputSchema.parse(body.payload).dryRun ? { dryRun: true, inventory: await migration.inventory() } : await migration.status();
              break;
            case 'storage.migration.start':
              z.object({}).strict().parse(body.payload);
              value = await migration.start();
              break;
            case 'storage.migration.verify':
              z.object({}).strict().parse(body.payload);
              value = await migration.verify();
              break;
            case 'storage.migration.purge':
              z.object({}).strict().parse(body.payload);
              value = await migration.purge();
              break;
            default:
              throw new Error(`Unknown storage migration operation ${body.operation}`);
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('deploy.')) {
          const releases = tenantReleases(env, body.userId);
          let value: unknown;
          switch (body.operation) {
            case 'deploy.machineProtocol':
              value = await releases.machineProtocol(body.machineId, machineProtocolInputSchema.parse(body.payload));
              break;
            case 'deploy.stage': {
              const input = stageReleaseInputSchema.parse(body.payload);
              if (input.artifacts.portable) await admitPortableRelease(env, body.userId, input.sha, input.artifacts.portable);
              value = await releases.stage(input, body.machineId);
              break;
            }
            case 'deploy.launch':
              value = await launchRelease(env, body.userId, body.payload);
              break;
            case 'deploy.status':
              value = await releases.status(body.userId, await tenantWorkerVersion(env, body.userId), body.machineId);
              break;
            case 'deploy.launchProgress':
              await releases.recordLaunchProgress(body.machineId, launchProgressSchema.parse(body.payload));
              value = null;
              break;
            case 'deploy.machineApplied': {
              const input = machineAppliedInputSchema.parse(body.payload);
              value = await releases.machineApplied(body.machineId, input);
              if (value === null) throw new ReleaseNotFoundError(input.sha);
              break;
            }
            case 'deploy.launcherStarted':
              await releases.launcherStarted(body.machineId, launcherStartedInputSchema.parse(body.payload));
              value = null;
              break;
            case 'deploy.machineChannelApplied':
              await releases.machineChannelApplied(body.machineId, machineChannelAppliedInputSchema.parse(body.payload));
              value = null;
              break;
            default:
              throw new Error('Unsupported deployment operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation === 'devices.list') {
          return Response.json({ status: 'ok', value: await credentialVault(env, body.userId).listDeviceGrants() }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation === 'account.issues.list' || body.operation === 'account.issues.resolve') {
          // Read from the account object alone: listing never opens a workspace or project object.
          const state = env.ACCOUNT_STATE.getByName('account');
          const value = body.operation === 'account.issues.list'
            ? await state.listFiledIssues(FiledIssueListInputSchema.parse(body.payload))
            : await state.resolveFiledIssue(FiledIssueResolveInputSchema.parse(body.payload));
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('mcp.')) {
          const connections = userMcpConnections(env, body.userId);
          let value: unknown;
          switch (body.operation) {
            case 'mcp.connections.status': {
              if (body.payload.status === undefined) {
                value = await connections.get(body.userId, String(body.payload.connectionId ?? ''));
              } else {
                value = await connections.recordStatus({
                  principalId: body.userId,
                  connectionId: String(body.payload.connectionId ?? ''),
                  observedRevision: Number(body.payload.observedRevision ?? -1),
                  status: String(body.payload.status) as Parameters<UserMcpConnectionsDO['recordStatus']>[0]['status'],
                  message: typeof body.payload.message === 'string' ? body.payload.message : null,
                  serverFingerprint: typeof body.payload.serverFingerprint === 'string' ? body.payload.serverFingerprint : null,
                  serverVersion: typeof body.payload.serverVersion === 'string' ? body.payload.serverVersion : null,
                });
              }
              break;
            }
            case 'mcp.audit.append':
              value = await connections.appendAudit({
                principalId: body.userId,
                projectId: typeof body.payload.projectId === 'string' ? body.payload.projectId : null,
                connectionId: String(body.payload.connectionId ?? ''),
                machineId: body.machineId,
                type: body.payload.type as Parameters<UserMcpConnectionsDO['appendAudit']>[0]['type'],
                toolName: typeof body.payload.toolName === 'string' ? body.payload.toolName : null,
                outcome: body.payload.outcome as Parameters<UserMcpConnectionsDO['appendAudit']>[0]['outcome'],
                message: typeof body.payload.message === 'string' ? body.payload.message : null,
              });
              break;
            default:
              throw new Error('Unsupported MCP control operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('secrets.')) {
          const secrets = projectSecrets(env, body.userId);
          const projectId = String(body.payload.projectId ?? '');
          let value: unknown;
          switch (body.operation) {
            case 'secrets.effective.list':
              value = await secrets.listEffective(projectId, await requireSecretContext(env, body.userId, projectId, body.payload.workspaceId));
              break;
            case 'secrets.materialize':
              value = await secrets.materialize(
                String(body.payload.projectId ?? ''),
                Array.isArray(body.payload.names) ? body.payload.names.map(String) : [],
                await requireSecretContext(env, body.userId, projectId, body.payload.workspaceId),
              );
              break;
            default: throw new Error('Unsupported secret operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
        }
        if (body.operation.startsWith('settings.')) {
          const settingsNamespace = env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>;
          const settings = settingsNamespace.get(settingsNamespace.idFromName(body.userId));
          let value: unknown;
          switch (body.operation) {
            case 'settings.get':
              value = await settings.get(body.machineId);
              break;
            case 'settings.git.get':
              value = await settings.getGitIdentity();
              break;
            case 'settings.git.update': {
              const result = await settings.updateGitIdentity(body.machineId, gitIdentityUpdateSchema.parse(body.payload));
              if (result.status === 'conflict') throw new SettingsRevisionConflict(result.resource, result.expected, result.actual);
              value = result.value;
              break;
            }
            default:
              throw new Error('Unsupported settings operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('project.')) {
          const projectId = String(body.payload.projectId ?? '');
          if (!projectId) {
            return Response.json(
              { status: 'error', error: { code: 'INVALID_PROJECT', message: 'Project id is required' } },
              { status: 400 },
            );
          }
          const authorityNamespace = env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>;
          const authority = authorityNamespace.get(authorityNamespace.idFromName(`${body.userId}:${projectId}`));
          let value: unknown;
          switch (body.operation) {
            case 'project.environment.get':
            case 'project.environment.mutate':
            case 'project.environment.runLog': {
              const spaceId = String(body.payload.spaceId ?? '');
              // The workspace object owns the environment and checks the workspace belongs to the project.
              const space = env.SPACE_AUTHORITY.getByName(`${body.userId}:${spaceId}`);
              const identity = { projectId, workspaceId: spaceId };
              const projects = (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(body.userId);
              if (body.operation === 'project.environment.runLog') {
                value = await space.getLifecycleRunLog(identity, String(body.payload.runId ?? ''), Number(body.payload.offset ?? 0));
                break;
              }
              let state: LifecycleState;
              if (body.operation === 'project.environment.get') state = await space.currentLifecycleState(identity);
              else {
                const input = LifecycleMutationSchema.parse(body.payload.input);
                const machine = input.op === 'claim'
                  ? await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(body.userId).getMachine(body.machineId)
                  : null;
                const attachment = input.op === 'claim' && input.attachment
                  ? (await space.runtimeAttachmentRecords(identity)).find(item => item.attachmentId === input.attachment?.attachmentId && item.generation === input.attachment.generation && item.workspaceId === spaceId)
                  : undefined;
                authorizeLifecycleMachineMutation(input, {
                  machineId: body.machineId,
                  projectId,
                  machineOnline: machine?.state === 'online' && machine.desiredState === 'online',
                  attachment,
                });
                if (input.op === 'value' && input.scope === 'global') {
                  await projects.setEnvironmentValue(input.name, input.value);
                  state = await space.getLifecycleState(identity);
                } else {
                  const result = await space.mutateLifecycleState(identity, input, { machineId: body.machineId, actorId: body.machineId, kind: 'machine', lifecycleControl: false, ...(input.op === 'claim' && input.attachment && attachment ? { attachment: input.attachment } : {}) });
                  if (result.status === 'error') return Response.json({ status: 'error', error: result.failure }, { status: 409 });
                  state = result.state;
                }
              }
              state.values.global = await projects.getEnvironmentValues();
              value = state;
              break;
            }
            case 'project.get':
              value = await authority.getProject();
              break;
            case 'project.workspaces.list':
              value = await authority.listWorkspaces();
              break;
            case 'project.mcp.grants.list':
              value = await authority.listMcpGrants();
              break;
            case 'project.routes.list':
              value = { routes: await authority.listHostedRoutes(), pointers: await authority.listHostedPointers() };
              break;
            // The hosted route registry decides (a machine URL's one machine, a workspace URL's pointer); the project mirrors what it accepted.
            case 'project.routes.lease':
            case 'project.routes.pin': {
              const input = hostedServiceRouteSchema.omit({ updatedAt: true }).parse(body.payload.route);
              const ingress = new URL(input.ingress);
              if (input.machineId !== body.machineId || !input.hostname.endsWith(`--${env.TENANT_ID}-srv.gssh.dev`) || ingress.protocol !== 'http:' || ingress.hostname !== '127.0.0.1' || Number(ingress.port) !== input.port || ingress.pathname !== '/' || ingress.search || ingress.username || ingress.password) throw new Error('Invalid tenant service route');
              const workspace = (await authority.listWorkspaces()).find(item => item.id === input.workspaceId);
              if (!workspace) throw new Error('Service workspace does not belong to this project');
              const machineLabel = (await env.FLEET_CATALOG.getByName(body.userId).getMachine(body.machineId))?.label ?? body.machineId;
              const route = { ...input, updatedAt: new Date().toISOString() };
              const registry = env.HOSTED_ROUTES.getByName(route.hostname);
              const leased = body.operation === 'project.routes.pin'
                ? await registry.pin(body.userId, projectId, route, { hostname: route.hostname, workspaceId: route.workspaceId, machineId: route.machineId, machineLabel, serviceName: route.serviceName, source: route.source, portName: route.portName, setAt: route.updatedAt, setBy: 'pin' })
                : await registry.lease(body.userId, projectId, route, machineLabel);
              if (leased.route) {
                try {
                  await authority.leaseHostedRoute(input, leased.pointer);
                } catch (error) {
                  await registry.release(body.userId, route.machineId, route.generation);
                  throw error;
                }
              }
              value = leased;
              break;
            }
            case 'project.routes.release': {
              const hostname = String(body.payload.hostname ?? '');
              const generation = z.number().int().nonnegative().parse(body.payload.generation);
              const released = await authority.releaseHostedRoute(hostname, body.machineId, generation);
              if (released) {
                await env.HOSTED_ROUTES.getByName(hostname).release(body.userId, body.machineId, generation);
              }
              value = released;
              break;
            }
            // Signed callers: the machine running an approved provision or materialize script on the workspace replaces its registrations,
            // one per workspace URL with approved declared routes. The hosted route registries decide; the project mirrors which URLs to end at archive or delete.
            case 'project.routes.ingress': {
              const input = HostedIngressRegistrationSchema.parse(body.payload);
              if (input.projectId !== projectId) throw new Error('Signed caller registration names another project');
              if (!(await authority.listWorkspaces()).some(item => item.id === input.workspaceId && item.archivedAt === null)) throw new Error('Signed callers are registered only on an active workspace of this project');
              const state = await env.SPACE_AUTHORITY.getByName(`${body.userId}:${input.workspaceId}`).getLifecycleState({ projectId, workspaceId: input.workspaceId });
              const run = state.runs.find(item => item.id === input.runId);
              if (!run || run.machineId !== body.machineId || run.status !== 'running' || (run.phase !== 'cloud/provision' && run.phase !== 'workspace/materialize')) throw new Error('Signed callers are registered only by this machine\'s running provision or materialize run');
              const approved = await executionHash({ kind: 'ingress', command: input.ingress });
              if (!state.approvals.some(approval => approval.executionHash === approved)) throw new Error('Signed caller routes are not approved');
              const declared = new Map(parseServiceIngressContent(input.ingress).map(group => [`${group.service} ${group.port}`, group.routes]));
              const registrations = input.registrations.flatMap(item => {
                const routes = declared.get(`${item.service} ${item.port}`);
                return routes ? [{ ...item, routes }] : [];
              });
              const named = new Set(input.registrations.map(item => `${item.service} ${item.port}`));
              const hostnames = input.registrations.map(item => item.hostname);
              if (registrations.length !== input.registrations.length || named.size !== registrations.length || named.size !== declared.size) throw new Error('Signed callers register each declared service port once');
              if (new Set(hostnames).size !== hostnames.length || hostnames.some(hostname => hostedServiceUrlKind(hostname) !== 'workspace' || !hostname.endsWith(`--${env.TENANT_ID}-srv.gssh.dev`))) throw new Error('Signed callers are registered on distinct workspace URLs');
              const mirrored = await authority.addHostedIngress(input.workspaceId, hostnames);
              const registeredAt = new Date().toISOString();
              await Promise.all(registrations.map(item => env.HOSTED_ROUTES.getByName(item.hostname).registerIngress(body.userId, input.workspaceId, item.routes, item.credentials, registeredAt)));
              const ended = mirrored.filter(hostname => !hostnames.includes(hostname));
              await Promise.all(ended.map(hostname => env.HOSTED_ROUTES.getByName(hostname).clearIngress(body.userId, input.workspaceId)));
              await authority.removeHostedIngress(input.workspaceId, ended);
              value = { hostnames };
              break;
            }
            case 'project.events.append':
              value = await (await authority.appendEvent(
                body.payload.event as Parameters<ProjectAuthorityDO['appendEvent']>[0],
              )).json();
              break;
            default:
              throw new Error('Unsupported project operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('catalog.')) {
          const catalogNamespace = env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>;
          const catalog = catalogNamespace.get(catalogNamespace.idFromName(body.userId));
          let value: unknown;
          switch (body.operation) {
            case 'catalog.machine.put': value = await catalog.reportMachine(catalogMachinePayload(body.payload)); break;
            // Native startup reads this snapshot before readiness; provider reconciliation would wait on startup itself.
            case 'catalog.machine.list': value = await catalog.listMachines(); break;
            default: throw new Error('Unsupported catalog operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
        }
        throw new Error('Unsupported control operation');
      } catch (error) {
        if (diagnostics) {
          diagnostics.caughtError = true;
          diagnostics.error = caughtErrorSummary(error);
        }
        if (error instanceof MachineDiscardRequired) return Response.json({ status: 'error', error: {
          _tag: error._tag, message: error.message, confirmation: error.confirmation, workspaces: error.workspaces,
        } }, { status: 409, headers: { 'cache-control': 'no-store' } });
        const lifecycleFailure = environmentFailure(error);
        if (lifecycleFailure) {
          console.error(JSON.stringify({ event: 'control_request_failed', operation: signedControl?.operation ?? null, machineId: signedControl?.machineId ?? null, code: lifecycleFailure.code, message: lifecycleFailure.message }));
          return Response.json({ status: 'error', error: lifecycleFailure }, { status: 409 });
        }
        if (error instanceof InspectorConflictError) {
          return Response.json({ status: 'error', error: { code: 'INSPECTOR_CONFLICT', message: error.message, resource: error.resource, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof InspectorStateError) {
          return Response.json({ status: 'error', error: { code: 'INSPECTOR_STATE', message: error.message, resource: 'inspector' } }, { status: 409 });
        }
        if (error instanceof SettingsRevisionConflict) {
          return Response.json({ status: 'error', error: { code: 'SETTINGS_CONFLICT', message: error.message, resource: error.resource, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof McpConnectionRevisionConflictError) {
          return Response.json({ status: 'error', error: { code: 'MCP_CONNECTION_CONFLICT', message: error.message, resource: `connection:${error.connectionId}`, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof McpConnectionNotFoundError) {
          return Response.json({ status: 'error', error: { code: 'MCP_CONNECTION_NOT_FOUND', message: error.message, resource: 'connection', id: error.connectionId } }, { status: 404 });
        }
        if (error instanceof ReleaseNotFoundError) {
          return Response.json({ status: 'error', error: { code: 'RELEASE_NOT_FOUND', message: error.message, sha: error.sha } }, { status: 404 });
        }
        if (error instanceof McpConnectionValidationError) {
          return Response.json({ status: 'error', error: { code: 'MCP_INVALID', message: error.message, field: error.field } }, { status: 400 });
        }
        // The Workers runtime marks Durable Object failures it caused (reset, overload, broken connection) with
        // `retryable` or `overloaded`; the request itself was valid, so the caller may repeat it.
        if (error instanceof Error && (('retryable' in error && error.retryable === true) || ('overloaded' in error && error.overloaded === true))) {
          console.error(JSON.stringify({ event: 'control_request_failed', operation: signedControl?.operation ?? null, machineId: signedControl?.machineId ?? null, ...caughtErrorSummary(error) }));
          return Response.json({ status: 'error', error: { code: 'CONTROL_UNAVAILABLE', message: 'The control request failed; try again' } }, { status: 503 });
        }
        const message = error instanceof Error ? error.message : 'Control request is invalid';
        console.error(JSON.stringify({ event: 'control_request_failed', operation: signedControl?.operation ?? null, machineId: signedControl?.machineId ?? null, message }));
        return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message } }, { status: 400 });
      }
    }
    if ((request.method === 'GET' || request.method === 'HEAD')
      && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/omp/') && !url.pathname.startsWith('/__dev/')
      && !request.headers.has('x-gitspace-control')) {
      const served = await releaseFrontendResponse(request, env, url.pathname);
      if (served) return served;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/omp/') && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    const match = /^\/v1\/users\/([^/]+)\/credentials\/([^/]+)\/access$/u.exec(url.pathname);
    if (!match || request.method !== 'POST') return new Response('Not found', { status: 404 });
    try {
      const body = credentialAccessRequestSchema.parse(await readBoundedJson(request));
      if (body.userId !== decodeURIComponent(match[1]!) || body.credentialId !== decodeURIComponent(match[2]!)) {
        return Response.json({ status: 'error', error: { code: 'PATH_MISMATCH', message: 'Request path does not match signed body' } }, { status: 400 });
      }
      const denied = accountAccessResponse(await activeAccount(env, body.userId));
      if (denied) return denied;
      const result = await credentialVault(env, body.userId).getAccess(body);
      const status = result.status === 'ok' ? 200 : result.error.code.includes('UNAUTHORIZED') || result.error.code === 'REQUEST_EXPIRED' || result.error.code === 'INFERENCE_SCOPE_REQUIRED' ? 401 : 400;
      return Response.json(result, { status, headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: 'Credential request is invalid' } }, { status: 400 });
    }
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const diagnostics = syncRequestDiagnostics(request);
    if (!diagnostics) return worker.fetch(request, env);
    logSyncRequest(diagnostics, 'received');
    try {
      const response = await worker.fetch(request, env, diagnostics);
      // Response construction is complete; streaming bodies are intentionally untouched.
      logSyncRequest(diagnostics, diagnostics.caughtError ? 'caught_error' : response.status >= 400 ? 'http_error' : 'response', response.status);
      return response;
    } catch (error) {
      logSyncRequest(diagnostics, 'exception');
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
