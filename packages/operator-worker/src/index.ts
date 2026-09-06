import { DurableObject } from 'cloudflare:workers';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import type { CredentialRefreshResponse, CredentialUploadResponse, SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';
import { z } from 'zod';
import { handleSandboxRollout } from './sandbox-rollout.js';
import { handleAccountCloudRpc } from './account-cloud-rpc.js';
import { serveArtifactShare } from './account-inspector-data.js';
import { ensureAccountGitSpaceProject } from './gitspace-project.js';
import {
  credentialAccessRequestSchema,
  gitIdentityUpdateSchema,
  credentialProtocolBase64,
  ompConfigUpdateSchema,
  sealCredentialForMachine,
  signedControlRequestSchema,
  userSettingsUpdateSchema,
  verifyCredentialAccessRequest,
  skillUpdateSchema,
  verifyCredentialAuthorityGrant,
  verifySignedControlRequest,
  verifyRelayAuthorization,
  signedCredentialAuthorityGrantSchema,
  type CredentialAccessRequest,
  type SignedControlRequest,
  type SignedCredentialAuthorityGrant,
  deviceBindingSchema,
  deviceGrantExpiresAt,
  signedDeviceInviteSchema,
  verifyDeviceBinding,
  verifyDeviceGrantRecord,
  type DeviceBinding,
  type DeviceGrantRecord,
  type SignedDeviceInvite,
  decodeSignedRpcHeader,
  verifyRpcSignature,
  RPC_DEVICE_HEADER,
  RPC_SIGNATURE_MAX_SKEW_MS,
  MACHINE_PAIRING_TTL_MS,
  credentialAuthorityGrantPayload,
  type CredentialAuthorityGrant,
  type DeviceCapability,
} from '@gitspace/protocol';
import {
  platformDeployResponseSchema,
  stageReleaseInputSchema,
  WORKER_VERSION_HEADER,
  type PlatformDeployRequest,
  type ReleaseStatus,
} from '@gitspace/protocol/deployment';
import { refreshCredential, ProviderRefreshError, type StoredOAuthCredential } from './providers.js';
import { ComposioPluginGateway } from './composio-plugins.js';
import { fetchUsageReports, type OmpUsageResponse } from './omp-usage.js';
import { ProjectSecretsDO } from './project-secrets.js';
import {
  ProjectCronAlreadyRunningError,
  ProjectCronNotFoundError,
  ProjectCronRevisionConflictError,
  ProjectCronRunNotCompletableError,
  ProjectCronValidationError,
  ProjectCronsDO,
} from './project-crons.js';
import {
  InspectorConflictError,
  InspectorStateError,
  SpaceContextDO,
} from './space-context.js';
import { SkillRevisionConflict, UserSkillsDO } from './user-skills.js';
import {
  ProjectAuthorityDO,
  ProjectMcpGrantNotFoundError,
  ProjectMcpGrantRevisionConflictError,
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
export * from './project-crons.js';
export * from './space-context.js';
export * from './local-mcp.js';
export * from './composio-plugins.js';
export * from './hosted-route-registry.js';
export * from './invite-registry.js';
export * from './account-registry.js';
export { TenantReleasesDO } from './tenant-releases.js';
import type { TenantReleasesDO } from './tenant-releases.js';
import { SpaceAuthorityDO } from './space-authority.js';
import { CloudflareR2PlatformClient, UserStorageDO } from './storage.js';
import { FleetCatalogDO, type FleetMachineDefinition, type PortableSpaceDefinition } from './fleet-catalog.js';
import { HandleRegistryDO, HandleUnavailable, SettingsRevisionConflict, UserSettingsDO } from './user-settings.js';
import { controlCloudflareSandboxMachine, createCloudflareSandboxMachine } from './sandbox-provisioner.js';
import { HostedRouteRegistryDO } from './hosted-route-registry.js';
import { InviteRegistryDO } from './invite-registry.js';
import { AccountRegistryDO, type OperatorAccountRecord } from './account-registry.js';
import { operatorIdentity } from './access-auth.js';
import { accountAccessResponse, machineBrokerToken, verifyMachineBrokerToken, activeAccount, authorizeControl } from './account-access.js';
import { machineProviderFor } from './machine-providers.js';
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
  type WorkerVersion,
  type LaunchResult,
} from './tenant-releases.js';

const REQUEST_MAX_SKEW_MS = 60_000;
const REQUEST_MAX_BYTES = 512 * 1024;
const DATA_OBJECT_MAX_BYTES = 64 * 1024 * 1024;
const DATA_REQUEST_HEADER_MAX_BYTES = 8 * 1024;
const REFRESH_LEASE_MS = 20_000;
const ACCESS_REFRESH_SKEW_MS = 60_000;
const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai-codex', 'google-gemini-cli', 'google-antigravity', 'cursor']);
const REMOTE_REFRESH_SENTINEL = '__remote__' as const;
const ACCOUNT_ID_BYTES = 16;

// OMP 18.1.10's write contract, without importing its Bun-only auth-storage runtime.
const brokerUploadSchema = z.strictObject({
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
const brokerDisableSchema = z.strictObject({ cause: z.string().optional() });
type StoredVaultOAuthCredential = StoredOAuthCredential & { type?: 'oauth' };
type StoredVaultCredential = StoredVaultOAuthCredential | (Extract<z.infer<typeof brokerUploadSchema>['credential'], { type: 'api_key' }> & { provider: string });
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
  | { state: 'enrolled'; userId: string; handle: string; accountUrl: string; relayUrl: string; operatorUrl: string; rootPublicKey: string; machineId: string; grant: SignedCredentialAuthorityGrant; brokerUrl: string; brokerToken: string; artifactKey: string };
const PAIRING_CAPABILITIES: DeviceCapability[] = ['devices.manage', 'fleet.control', 'rpc.write', 'session.prompt', 'deployment.control'];

function brokerCredentialIdentity(credential: StoredVaultCredential): string | null {
  if (credential.type === 'api_key') return null;
  const account = credential.accountId?.trim();
  const email = credential.email?.trim().toLowerCase();
  const project = credential.projectId?.trim();
  if (credential.provider === 'anthropic' || credential.provider === 'openai-codex') {
    const base = email ? `email:${email}` : account ? `account:${account}` : project ? `project:${project}` : null;
    const org = credential.orgId?.trim();
    return org ? (base ? `${base}|org:${org}` : `org:${org}`) : base;
  }
  return account ? `account:${account}` : email ? `email:${email}` : project ? `project:${project}` : null;
}

function brokerCredentialEntry(id: number, credential: StoredVaultCredential): CredentialRefreshResponse['entry'] {
  if (credential.type === 'api_key') {
    return { id, provider: credential.provider, identityKey: null, credential: { type: 'api_key', key: credential.key, ...(credential.source ? { source: credential.source } : {}) } };
  }
  const { provider, ...value } = credential;
  return { id, provider, identityKey: brokerCredentialIdentity(credential), credential: { ...value, type: 'oauth', refresh: REMOTE_REFRESH_SENTINEL } };
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

async function bootstrapTenant(env: Env, handle: string, rootPublicKey: string, blobBucket: string): Promise<{ relayUrl: string; accountUrl: string; release: string | null }> {
  if (!env.PLATFORM_URL || !env.PLATFORM_BOOTSTRAP_TOKEN) throw new Error('Production tenant platform is not configured');
  const response = await fetch(`${env.PLATFORM_URL.replace(/\/+$/u, '')}/__platform/bootstrap/${encodeURIComponent(handle)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.PLATFORM_BOOTSTRAP_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ rootPublicKey, blobBucket }),
  });
  const body = await response.json() as { relayUrl?: unknown; accountUrl?: unknown; deployment?: { sha?: unknown }; error?: { message?: unknown } };
  if (!response.ok || typeof body.relayUrl !== 'string' || typeof body.accountUrl !== 'string') {
    throw new Error(typeof body.error?.message === 'string' ? body.error.message : `Tenant bootstrap failed with HTTP ${response.status}`);
  }
  return { relayUrl: body.relayUrl, accountUrl: body.accountUrl, release: typeof body.deployment?.sha === 'string' ? body.deployment.sha : null };
}

const OMP_USAGE_CACHE_MS = 30_000;

export type CredentialVaultResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: { code: string; message: string; retryAfterMs?: number } };

interface DeviceRow extends Record<string, SqlStorageValue> {
  signing_public_key: string;
  exchange_public_key: string;
  capabilities_json: string;
  generation: number;
  grant_json: string | null;
}

interface CredentialRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: string;
  sealed_json: string;
  revision: number;
  expires_at: number;
  state: string;
}

interface OmpCredentialRow extends CredentialRow {
  row_id: number;
  updated_at: string;
}
interface ProviderSecretRow extends Record<string, SqlStorageValue> {
  provider: string;
  sealed_json: string;
  revision: number;
  updated_at: string;
}
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
  return JSON.parse(new TextDecoder().decode(plaintext)) as StoredVaultCredential;
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

function publicError(code: string, message: string, retryAfterMs?: number): CredentialVaultResult<never> {
  return { status: 'error', error: { code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } };
}

export class CredentialVaultDO extends DurableObject<Env> {
  /** Aggregated usage reports, cached in-memory for OMP_USAGE_CACHE_MS so widget polls don't hammer provider endpoints. */
  private usageCache: { expiresAt: number; value: OmpUsageResponse } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
        CREATE TABLE IF NOT EXISTS request_nonces (
          nonce TEXT PRIMARY KEY,
          used_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS refresh_leases (
          credential_id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          revision INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credential_snapshot (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generation INTEGER NOT NULL
        );
      `);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO credential_snapshot(id, generation) VALUES (1, ?)', Date.now());
      const columns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(credential_devices)').toArray();
      if (!columns.some((column) => column.name === 'grant_json')) this.ctx.storage.sql.exec('ALTER TABLE credential_devices ADD COLUMN grant_json TEXT');
    });
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
    return { status: 'ok', value: { userId: input.userId } };
  }

  authorizeRelayGrant(input: SignedCredentialAuthorityGrant, capability: 'space.control' | 'storage.access'): CredentialVaultResult<{ authorized: true }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const grant = verifyCredentialAuthorityGrant(input, credentialProtocolBase64.decode(config.root_public_key), Date.now(), (deviceId) => this.deviceGrant(deviceId));
    if (!grant || grant.userId !== config.user_id) return publicError('DEVICE_UNAUTHORIZED', 'Device grant is invalid');
    const device = this.device(grant.machineId);
    if (!device || device.generation !== grant.generation
      || device.signing_public_key !== grant.signingPublicKey
      || device.exchange_public_key !== grant.exchangePublicKey
      || !grant.capabilities.includes(capability)
      || !(JSON.parse(device.capabilities_json) as string[]).includes(capability)) {
      return publicError('DEVICE_UNAUTHORIZED', 'Device grant is revoked, superseded, or lacks the required capability');
    }
    return { status: 'ok', value: { authorized: true } };
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
    return { status: 'ok', value: { machineId: grant.machineId, generation: grant.generation } };
  }
  registerManagedDevice(input: {
    userId: string;
    machineId: string;
    signingPublicKey: string;
    exchangePublicKey: string;
    capabilities: Array<'storage.access' | 'space.control' | 'credential.access' | 'credential.manage'>;
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
    return { status: 'ok', value: { machineId: input.machineId, generation } };
  }
  rootPublicKey(): string | null {
    return this.config()?.root_public_key ?? null;
  }
  authorizeRoot(header: string | null, target: string): CredentialVaultResult<{ authorized: true }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const verified = verifyRelayAuthorization({
      header,
      signingPublicKey: config.root_public_key,
      target,
      maxSkewMs: REQUEST_MAX_SKEW_MS,
    });
    if (verified.status === 'error') return publicError('ROOT_UNAUTHORIZED', verified.error.message);
    return this.consumeRequestNonce(verified.value.nonce, verified.value.timestamp);
  }
  authorizeBrowserRequest(input: { header: string | null; target: string; body: Uint8Array; capabilities: DeviceCapability[] }): CredentialVaultResult<{ deviceId: string }> {
    return this.authorizeRpcRequest(input, true);
  }

  authorizeAccountDeviceRequest(input: { header: string | null; target: string; body: Uint8Array; capabilities: DeviceCapability[] }): CredentialVaultResult<{ deviceId: string }> {
    return this.authorizeRpcRequest(input, false);
  }

  private authorizeRpcRequest(input: { header: string | null; target: string; body: Uint8Array; capabilities: DeviceCapability[] }, browserOnly: boolean): CredentialVaultResult<{ deviceId: string }> {
    const config = this.config();
    const header = input.header ? decodeSignedRpcHeader(input.header) : null;
    const now = Date.now();
    if (!config || !header || input.body.byteLength > REQUEST_MAX_BYTES || Math.abs(now - header.timestamp) > RPC_SIGNATURE_MAX_SKEW_MS) {
      return publicError('RPC_UNAUTHORIZED', 'Device signature is missing, invalid or expired');
    }
    const record = this.deviceGrant(header.deviceId);
    const resolve = (deviceId: string) => {
      const candidate = this.deviceGrant(deviceId);
      return candidate?.invite.invite.userId === config.user_id ? candidate : null;
    };
    const device = record?.invite.invite.userId === config.user_id
      ? verifyDeviceGrantRecord(record, credentialProtocolBase64.decode(config.root_public_key), now, resolve) : null;
    if (!device || !verifyRpcSignature(header, { method: 'POST', path: input.target, body: input.body }, device.signingPublicKey)) {
      return publicError('RPC_UNAUTHORIZED', 'Device signature is invalid or its grant is revoked');
    }
    if ((browserOnly && device.kind !== 'browser') || device.scope.kind !== 'user'
      || !input.capabilities.every((capability) => device.capabilities.includes(capability))) {
      return publicError('RPC_FORBIDDEN', 'Device is out of scope or lacks permission');
    }
    const nonce = this.consumeRequestNonce(header.nonce, header.timestamp);
    return nonce.status === 'error' ? nonce : { status: 'ok', value: { deviceId: device.deviceId } };
  }

  async machinePairingRequest(input: { operation: string; header: string | null; target: string; body: Uint8Array; operatorUrl: string }): Promise<CredentialVaultResult<MachinePairingValue>> {
    return this.ctx.blockConcurrencyWhile(async () => {
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
        this.ctx.storage.sql.exec('DELETE FROM machine_pairings WHERE expires_at <= ?', now);
        const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM machine_pairings WHERE creator_device_id = ? AND state != 'cancelled'", browserDeviceId!).one().count;
        if (count >= 5) return publicError('PAIRING_LIMIT', 'Too many active pairing sessions');
        const pairingId = crypto.randomUUID();
        const token = credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
        const tokenHash = credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
        const expiresAt = now + MACHINE_PAIRING_TTL_MS;
        this.ctx.storage.sql.exec("INSERT INTO machine_pairings(pairing_id, creator_device_id, token_hash, expires_at, state) VALUES (?, ?, ?, ?, 'created')", pairingId, browserDeviceId!, tokenHash, expiresAt);
        return { status: 'ok', value: { pairingId, token, expiresAt } };
      }
      const pairingId = z.uuid().parse(body.pairingId);
      const row = this.ctx.storage.sql.exec<PairingRow>('SELECT * FROM machine_pairings WHERE pairing_id = ?', pairingId).toArray()[0];
      if (!row || row.expires_at <= now || row.state === 'cancelled') return publicError('PAIRING_UNAVAILABLE', 'Pairing is expired, cancelled or unavailable');
      if (browserOperation && row.creator_device_id !== browserDeviceId) return publicError('PAIRING_FORBIDDEN', 'Pairing belongs to another browser');
      let machine = row.machine_json ? pairingMachineSchema.parse(JSON.parse(row.machine_json)) : null;
      if (!browserOperation) {
        const header = input.header ? decodeSignedRpcHeader(input.header) : null;
        const claimant = input.operation === 'claim' ? pairingMachineSchema.parse({
          machineId: body.machineId, label: body.label, signingPublicKey: body.signingPublicKey, exchangePublicKey: body.exchangePublicKey,
        }) : machine;
        if (!claimant || !header || header.deviceId !== pairingId || Math.abs(now - header.timestamp) > RPC_SIGNATURE_MAX_SKEW_MS) return publicError('PAIRING_UNAUTHORIZED', 'Machine proof is missing or expired');
        let signingPublicKey: Uint8Array;
        try {
          signingPublicKey = credentialProtocolBase64.decode(claimant.signingPublicKey);
          if (signingPublicKey.byteLength !== 32 || credentialProtocolBase64.decode(claimant.exchangePublicKey).byteLength !== 32) throw new Error('Invalid keys');
        } catch {
          return publicError('PAIRING_UNAUTHORIZED', 'Machine keys are invalid');
        }
        if (!verifyRpcSignature(header, { method: 'POST', path: input.target, body: input.body }, signingPublicKey)) return publicError('PAIRING_UNAUTHORIZED', 'Machine proof does not match request');
        const nonce = this.consumeRequestNonce(header.nonce, header.timestamp);
        if (nonce.status === 'error') return nonce;
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
        capabilities: ['storage.access', 'space.control', 'credential.access', 'credential.manage'],
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
      const authorized = this.authorizeRelayGrant(signed, 'space.control');
      if (authorized.status === 'error') return authorized;
      const settings = await (this.env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(config.user_id).get(machine.machineId);
      const handle = settings.profile.handle;
      if (!handle) return publicError('ACCOUNT_UNPROVISIONED', 'Account tenant is not provisioned');
      const relayUrl = `https://${handle}.gssh.dev`;
      if (row.state === 'approved') await (this.env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(config.user_id).putMachine({
        id: machine.machineId, label: machine.label, state: 'offline', rpcEndpoint: `${relayUrl}/tunnel/${encodeURIComponent(machine.machineId)}/rpc`,
        kind: 'physical', provider: 'physical', notes: '', desiredState: 'online', lifecycleRevision: signed.grant.generation, operationId: null, error: null,
      });
      const brokerSecret = this.env.GITSPACE_OMP_BROKER_TOKEN;
      if (!brokerSecret) return publicError('BROKER_UNAVAILABLE', 'The account credential broker is not configured');
      const brokerToken = await machineBrokerToken(brokerSecret, config.user_id, machine.machineId, signed.grant.generation);
      const artifactKey = await this.artifactKey(config.user_id);
      // Retrieval is retryable for the same proof-bound key until the original
      // short expiry; a lost HTTP response never strands a newly enrolled CLI.
      if (row.expires_at <= Date.now()) return publicError('PAIRING_UNAVAILABLE', 'Pairing has expired');
      const current = this.authorizeRelayGrant(signed, 'space.control');
      if (current.status === 'error') return current;
      this.ctx.storage.sql.exec("UPDATE machine_pairings SET state = 'enrolled' WHERE pairing_id = ?", pairingId);
      return { status: 'ok', value: {
        state: 'enrolled', userId: config.user_id, handle, accountUrl: `https://${handle}.gitspace.sh`, relayUrl,
        operatorUrl: input.operatorUrl, rootPublicKey: config.root_public_key, machineId: machine.machineId, grant: signed,
        brokerUrl: `${input.operatorUrl}/omp/users/${encodeURIComponent(config.user_id)}`, brokerToken, artifactKey,
      } };
    });
  }


  authorizeMachineRequest(header: string | null, target: string, machineId: string): CredentialVaultResult<{ authorized: true }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const device = this.device(machineId);
    if (!device || (JSON.parse(device.capabilities_json) as string[]).length === 0) return publicError('DEVICE_UNAUTHORIZED', 'Machine is not enrolled');
    const verified = verifyRelayAuthorization({
      header,
      signingPublicKey: device.signing_public_key,
      target,
      maxSkewMs: REQUEST_MAX_SKEW_MS,
    });
    if (verified.status === 'error') return publicError('DEVICE_UNAUTHORIZED', verified.error.message);
    return this.consumeRequestNonce(verified.value.nonce, verified.value.timestamp);
  }

  removeManagedDevice(machineId: string): void {
    this.ctx.storage.sql.exec("UPDATE credential_devices SET capabilities_json = '[]', updated_at = ? WHERE machine_id = ?", new Date().toISOString(), machineId);
  }

  /**
   * Redeem a root-signed invite with a device binding. First bind wins: the
   * invite id is unique, so a second redemption - including one from the
   * worker itself - is rejected. The vault never signs anything here; it only
   * records what the root and the device already signed.
   */
  enrollDevice(input: { invite: SignedDeviceInvite; binding: DeviceBinding }): CredentialVaultResult<{ deviceId: string; expiresAt: number | null }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const invite = input.invite.invite;
    const now = Date.now();
    if (invite.userId !== config.user_id) return publicError('INVALID_DEVICE_INVITE', 'Device invite is invalid');
    if (invite.expiresAt <= now) return publicError('DEVICE_INVITE_EXPIRED', 'Device invite has expired');
    if (!verifyDeviceBinding(input.binding) || input.binding.inviteId !== invite.inviteId) return publicError('INVALID_DEVICE_BINDING', 'Device binding is invalid');
    if (Math.abs(input.binding.boundAt - now) > REQUEST_MAX_SKEW_MS) return publicError('INVALID_DEVICE_BINDING', 'Device binding clock is out of range');
    const record: DeviceGrantRecord = { invite: input.invite, binding: input.binding, generation: 1, revokedAt: null };
    // The whole chain is checked here exactly as machines check it later: root
    // signature, or a delegating issuer that is itself valid and holds what it hands out.
    const rootPublicKey = credentialProtocolBase64.decode(config.root_public_key);
    if (!verifyDeviceGrantRecord(record, rootPublicKey, now, (deviceId) => this.deviceGrant(deviceId))) return publicError('INVALID_DEVICE_INVITE', 'Device invite is invalid or its issuer cannot delegate it');
    try {
      this.ctx.storage.sql.exec(
        'INSERT INTO device_grants(device_id, invite_id, kind, record_json, generation, revoked_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, ?)',
        input.binding.deviceId, invite.inviteId, invite.kind, JSON.stringify(record), new Date(now).toISOString(),
      );
    } catch {
      return publicError('DEVICE_INVITE_USED', 'Device invite was already redeemed');
    }
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
  revokeDeviceGrant(deviceId: string): CredentialVaultResult<{ deviceId: string; revokedAt: number }> {
    const revokedAt = Date.now();
    const row = this.ctx.storage.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM device_grants WHERE device_id = ?', deviceId).toArray()[0];
    if (!row) return publicError('DEVICE_NOT_FOUND', 'Device is not enrolled');
    if (row.revoked_at !== null) return { status: 'ok', value: { deviceId, revokedAt: row.revoked_at } };
    this.ctx.storage.sql.exec(
      'UPDATE device_grants SET revoked_at = ?, generation = generation + 1, updated_at = ? WHERE device_id = ?',
      revokedAt, new Date(revokedAt).toISOString(), deviceId,
    );
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

  async putCredential(input: { id: string; credential: StoredOAuthCredential }): Promise<CredentialVaultResult<{ id: string; revision: number }>> {
    if (!this.config() || !input.id || !brokerUploadSchema.safeParse({ provider: input.credential.provider, credential: { ...input.credential, type: 'oauth' } }).success) {
      return publicError('INVALID_CREDENTIAL', 'Credential input is invalid');
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const revision = await this.storeCredential(input.id, input.credential);
      return { status: 'ok' as const, value: { id: input.id, revision } };
    });
  }

  private async storeCredential(id: string, credential: StoredVaultCredential): Promise<number> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const revision = (this.credential(id)?.revision ?? 0) + 1;
    const sealed = await sealVaultCredential(credential, credentialProtocolBase64.decode(config.vault_key), id, revision);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        INSERT INTO oauth_credentials(id, provider, sealed_json, revision, expires_at, state, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider, sealed_json = excluded.sealed_json, revision = excluded.revision,
          expires_at = excluded.expires_at, state = 'active', updated_at = excluded.updated_at
      `, id, credential.provider, sealed, revision, credential.type === 'api_key' ? 0 : credential.expires, new Date().toISOString());
      this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE credential_id = ?', id);
      this.credentialsChanged();
    });
    return revision;
  }

  async ompUpload(input: unknown, machineId: string, generation: number): Promise<CredentialUploadResponse | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.authorizeBroker(machineId, generation, 'credential.manage')) return null;
      return this.uploadCredential(input);
    });
  }

  async putBrowserApiKey(provider: string, key: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.uploadCredential({ provider, credential: { type: 'api_key', key } }));
  }

  disableBrowserCredentials(provider: string, credentialId: string | null): void {
    const rows = credentialId === null
      ? this.ctx.storage.sql.exec<{ row_id: number }>("SELECT rowid AS row_id FROM oauth_credentials WHERE provider = ? AND state = 'active'", provider).toArray()
      : this.ctx.storage.sql.exec<{ row_id: number }>("SELECT rowid AS row_id FROM oauth_credentials WHERE provider = ? AND rowid = ? AND state = 'active'", provider, Number(credentialId)).toArray();
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) this.disableCredentialRow(row.row_id);
    });
  }

  private async uploadCredential(input: unknown): Promise<CredentialUploadResponse> {
      const parsed = brokerUploadSchema.parse(input);
      const credential = { ...parsed.credential, provider: parsed.provider } as StoredVaultCredential;
      const config = this.config();
      if (!config) throw new Error('Vault is not configured');
      const rows = this.ctx.storage.sql.exec<OmpCredentialRow>(
        "SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM oauth_credentials WHERE provider = ? AND state = 'active' ORDER BY rowid", parsed.provider,
      ).toArray();
      const existing = await Promise.all(rows.map(async (row) => ({ row, credential: await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key)) })));
      const identity = brokerCredentialIdentity(credential);
      const matches = existing.filter(({ credential: current }) => credential.type === 'api_key'
        ? current.type === 'api_key'
        : current.type !== 'api_key' && (identity !== null ? brokerCredentialIdentity(current) === identity : current.refresh === credential.refresh));
      const target = matches[0]?.row;
      // Retain row ids on an identity upsert, but never reuse a disabled row: a delayed
      // logout from another client must not disable a subsequently uploaded key.
      await this.storeCredential(target?.id ?? crypto.randomUUID(), credential);
      for (const { row, credential: current } of existing) {
        if (row.id !== target?.id && (matches.some((match) => match.row.id === row.id) || (credential.type !== 'api_key' && current.type === 'api_key'))) {
          this.disableCredentialRow(row.row_id);
        }
      }
      const snapshot = await this.ompSnapshot();
      return { entries: snapshot.credentials.filter((entry) => entry.provider === parsed.provider).map(({ rotatesInMs: _rotates, ...entry }) => entry) };
  }

  ompDisable(rowId: number, machineId: string, generation: number): boolean | null {
    if (!this.authorizeBroker(machineId, generation, 'credential.manage')) return null;
    return this.disableCredentialRow(rowId);
  }

  private disableCredentialRow(rowId: number): boolean {
    if (!Number.isSafeInteger(rowId) || rowId <= 0) return false;
    return this.ctx.storage.transactionSync(() => {
      const changed = this.ctx.storage.sql.exec("UPDATE oauth_credentials SET state = 'disabled', updated_at = ? WHERE rowid = ? AND state != 'disabled'", new Date().toISOString(), rowId).rowsWritten;
      if (changed === 0) return false;
      this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE credential_id = (SELECT id FROM oauth_credentials WHERE rowid = ?)', rowId);
      this.credentialsChanged();
      return true;
    });
  }

  private credentialGeneration(): number {
    return this.ctx.storage.sql.exec<{ generation: number }>('SELECT generation FROM credential_snapshot WHERE id = 1').one().generation;
  }

  private credentialsChanged(): void {
    this.ctx.storage.sql.exec('UPDATE credential_snapshot SET generation = MAX(generation + 1, ?) WHERE id = 1', Date.now());
    this.usageCache = undefined;
  }

  async ompUsage(): Promise<OmpUsageResponse> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const now = Date.now();
    if (this.usageCache && this.usageCache.expiresAt > now) return this.usageCache.value;
    const generation = this.credentialGeneration();
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const rows = this.ctx.storage.sql.exec<CredentialRow>(
      "SELECT id, provider, sealed_json, revision, expires_at, state FROM oauth_credentials WHERE state = 'active' ORDER BY rowid",
    ).toArray();
    const credentials = await Promise.all(rows.map((row) => openVaultCredential(row, vaultKey)));
    const value = { generatedAt: now, reports: await fetchUsageReports(credentials.filter((credential): credential is StoredVaultOAuthCredential => credential.type !== 'api_key')) };
    if (generation === this.credentialGeneration()) this.usageCache = { expiresAt: now + OMP_USAGE_CACHE_MS, value };
    return value;
  }


  async ompSnapshot(): Promise<SnapshotResponse> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const now = Date.now();
    const generation = this.credentialGeneration();
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const rows = this.ctx.storage.sql.exec<OmpCredentialRow>(
      "SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM oauth_credentials WHERE state = 'active' ORDER BY rowid",
    ).toArray();
    const credentials = await Promise.all(rows.map(async (row) => {
      const credential = await openVaultCredential(row, vaultKey);
      return {
        ...brokerCredentialEntry(row.row_id, credential),
        rotatesInMs: credential.type === 'api_key' ? null : Math.max(0, credential.expires - now),
      };
    }));
    return {
      generation,
      generatedAt: now,
      serverNowMs: now,
      refresher: {
        enabled: true,
        intervalMs: 60_000,
        skewMs: 5 * 60_000,
        nextSweepInMs: 60_000,
      },
      credentials,
    };
  }
  async ompRefresh(rowId: number): Promise<CredentialRefreshResponse> {
    const config = this.config();
    if (!config || !Number.isSafeInteger(rowId) || rowId <= 0) throw new Error('Credential is unavailable');
    const row = this.ctx.storage.sql.exec<OmpCredentialRow>(
      'SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM oauth_credentials WHERE rowid = ? AND state = ?',
      rowId,
      'active',
    ).toArray()[0];
    if (!row) throw new Error('Credential is unavailable');
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const credential = await openVaultCredential(row, vaultKey);
    if (credential.type === 'api_key') return { entry: brokerCredentialEntry(rowId, credential) };
    const owner = crypto.randomUUID();
    if (!this.acquireRefreshLease(row, owner)) throw new Error('Credential refresh is already in progress');
    let refreshed: StoredVaultOAuthCredential;
    try {
      refreshed = await refreshCredential(credential);
    } catch (error) {
      this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE credential_id = ? AND owner = ?', row.id, owner);
      throw error;
    }
    const revision = row.revision + 1;
    const sealed = await sealVaultCredential(refreshed, vaultKey, row.id, revision);
    const committed = this.ctx.storage.transactionSync(() => {
      const changed = this.ctx.storage.sql.exec(
        "UPDATE oauth_credentials SET sealed_json = ?, revision = ?, expires_at = ?, updated_at = ? WHERE rowid = ? AND revision = ? AND state = 'active' AND EXISTS (SELECT 1 FROM refresh_leases WHERE credential_id = ? AND owner = ? AND revision = ? AND expires_at > ?)",
        sealed, revision, refreshed.expires, new Date().toISOString(), rowId, row.revision, row.id, owner, row.revision, Date.now(),
      ).rowsWritten;
      this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE credential_id = ? AND owner = ?', row.id, owner);
      const uncertain = changed === 0 && this.ctx.storage.sql.exec(
        "UPDATE oauth_credentials SET state = 'refresh-uncertain', updated_at = ? WHERE id = ? AND revision = ? AND state = 'active'",
        new Date().toISOString(), row.id, row.revision,
      ).rowsWritten === 1;
      if (changed === 1 || uncertain) this.credentialsChanged();
      return changed === 1;
    });
    if (!committed) throw new Error('Credential changed during refresh');
    return { entry: brokerCredentialEntry(rowId, refreshed) };
  }


  authorizeControl(request: SignedControlRequest, capability: 'storage.provision' | 'storage.access' | 'space.control'): CredentialVaultResult<{ authorized: true }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const parsed = signedControlRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.userId !== config.user_id || Math.abs(Date.now() - parsed.data.timestamp) > REQUEST_MAX_SKEW_MS) {
      return publicError('INVALID_REQUEST', 'Control request is invalid or expired');
    }
    const device = this.device(parsed.data.machineId);
    if (!device || !verifySignedControlRequest(parsed.data, credentialProtocolBase64.decode(device.signing_public_key))) {
      return publicError('DEVICE_UNAUTHORIZED', 'Device is not authorized');
    }
    const capabilities = JSON.parse(device.capabilities_json) as unknown;
    if (!Array.isArray(capabilities) || !capabilities.includes(capability)) {
      return publicError('ACCESS_DENIED', `Device lacks ${capability}`);
    }
    const inserted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM request_nonces WHERE used_at < ?', Date.now() - RPC_SIGNATURE_MAX_SKEW_MS);
      try {
        this.ctx.storage.sql.exec('INSERT INTO request_nonces(nonce, used_at) VALUES (?, ?)', parsed.data.nonce, Date.now());
        return true;
      } catch {
        return false;
      }
    });
    return inserted ? { status: 'ok', value: { authorized: true } } : publicError('REQUEST_REPLAY', 'Control request was already used');
  }
  authorizeSubscription(request: SignedControlRequest, capability: 'storage.access' | 'space.control'): number | null {
    const config = this.config();
    const device = this.device(request.machineId);
    return config && request.userId === config.user_id && device
      && verifySignedControlRequest(request, credentialProtocolBase64.decode(device.signing_public_key))
      && (JSON.parse(device.capabilities_json) as string[]).includes(capability)
      ? device.generation : null;
  }
  authorizeBroker(machineId: string, generation: number, capability: 'credential.access' | 'credential.manage' = 'credential.access'): boolean {
    const device = this.device(machineId);
    const capabilities = device ? JSON.parse(device.capabilities_json) as string[] : [];
    return Boolean(device && device.generation === generation
      && capabilities.includes('credential.access') && capabilities.includes(capability));
  }
  async getAccess(request: CredentialAccessRequest): Promise<CredentialVaultResult<{
    credentialId: string;
    provider: string;
    expiresAt: number;
    revision: number;
    envelope: Awaited<ReturnType<typeof sealCredentialForMachine>>;
  }>> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    const parsed = credentialAccessRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.userId !== config.user_id || Math.abs(Date.now() - parsed.data.timestamp) > REQUEST_MAX_SKEW_MS) {
      return publicError('INVALID_REQUEST', 'Credential request is invalid or expired');
    }
    const device = this.device(parsed.data.machineId);
    if (!device || !verifyCredentialAccessRequest(parsed.data, credentialProtocolBase64.decode(device.signing_public_key))) {
      return publicError('DEVICE_UNAUTHORIZED', 'Device is not authorized');
    }
    const capabilities = JSON.parse(device.capabilities_json) as unknown;
    if (!Array.isArray(capabilities) || !capabilities.includes('credential.access')) {
      return publicError('ACCESS_DENIED', 'Device cannot access credentials');
    }
    const nonceInserted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM request_nonces WHERE used_at < ?', Date.now() - RPC_SIGNATURE_MAX_SKEW_MS);
      try {
        this.ctx.storage.sql.exec('INSERT INTO request_nonces(nonce, used_at) VALUES (?, ?)', parsed.data.nonce, Date.now());
        return true;
      } catch {
        return false;
      }
    });
    if (!nonceInserted) return publicError('REQUEST_REPLAY', 'Credential request was already used');

    let row = this.credential(parsed.data.credentialId);
    if (!row || row.state === 'disabled') return publicError('CREDENTIAL_NOT_FOUND', 'Credential is unavailable');
    if (row.state === 'refresh-uncertain') return publicError('REFRESH_UNCERTAIN', 'Credential refresh outcome is uncertain; interactive recovery is required');
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const stored = await openVaultCredential(row, vaultKey);
    if (stored.type === 'api_key') return publicError('INVALID_CREDENTIAL_TYPE', 'Use the OMP broker snapshot for API keys');
    let credential: StoredVaultOAuthCredential = stored;
    if (Date.now() + ACCESS_REFRESH_SKEW_MS >= credential.expires) {
      const refreshRow = row;
      if (!this.acquireRefreshLease(refreshRow, parsed.data.nonce)) {
        return publicError('REFRESH_BUSY', 'Credential refresh is already in progress', 250);
      }
      try {
        credential = await refreshCredential(credential);
        const nextRevision = refreshRow.revision + 1;
        const sealed = await sealVaultCredential(credential, vaultKey, refreshRow.id, nextRevision);
        const committed = this.ctx.storage.transactionSync(() => {
          const changed = this.ctx.storage.sql.exec(`
            UPDATE oauth_credentials
            SET sealed_json = ?, revision = ?, expires_at = ?, state = 'active', updated_at = ?
            WHERE id = ? AND revision = ? AND state = 'active' AND EXISTS (
              SELECT 1 FROM refresh_leases WHERE credential_id = ? AND owner = ? AND revision = ? AND expires_at > ?
            )
          `, sealed, nextRevision, credential.expires, new Date().toISOString(), refreshRow.id, refreshRow.revision, refreshRow.id, parsed.data.nonce, refreshRow.revision, Date.now()).rowsWritten;
          this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE credential_id = ? AND owner = ?', refreshRow.id, parsed.data.nonce);
          if (changed === 1) this.credentialsChanged();
          return changed === 1;
        });
        if (!committed) {
          const changed = this.ctx.storage.sql.exec("UPDATE oauth_credentials SET state = 'refresh-uncertain', updated_at = ? WHERE id = ? AND revision = ? AND state = 'active'", new Date().toISOString(), refreshRow.id, refreshRow.revision).rowsWritten;
          if (changed === 1) this.credentialsChanged();
          return publicError('REFRESH_UNCERTAIN', 'Provider refreshed the credential but the vault commit was not confirmed');
        }
        row = this.credential(refreshRow.id)!;
      } catch (error) {
        this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE credential_id = ? AND owner = ?', refreshRow.id, parsed.data.nonce);
        if (error instanceof ProviderRefreshError) {
          return publicError(
            error.kind === 'rejected' ? 'REFRESH_REJECTED' : 'REFRESH_FAILED',
            error.kind === 'rejected' ? 'Provider rejected the refresh credential' : 'Provider refresh failed',
            error.kind === 'network' ? 1_000 : undefined,
          );
        }
        return publicError('REFRESH_FAILED', 'Provider refresh failed', 1_000);
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
      machineExchangePublicKey: credentialProtocolBase64.decode(device.exchange_public_key),
      context,
    });
    return { status: 'ok', value: { credentialId: row.id, provider: credential.provider, expiresAt: credential.expires, revision: row.revision, envelope } };
  }

  async artifactKey(userId: string): Promise<string> {
    const config = this.config();
    if (!config || config.user_id !== userId) throw new Error('Account credential vault is unavailable');
    const key = await crypto.subtle.importKey(
      'raw',
      ownedBuffer(credentialProtocolBase64.decode(config.vault_key)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const derived = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`gitspace/artifact-encryption/v1\n${userId}`),
    );
    return credentialProtocolBase64.encode(new Uint8Array(derived));
  }

  private consumeRequestNonce(nonce: string, timestamp: number): CredentialVaultResult<{ authorized: true }> {
    const inserted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM request_nonces WHERE used_at < ?', Date.now() - RPC_SIGNATURE_MAX_SKEW_MS);
      try {
        this.ctx.storage.sql.exec('INSERT INTO request_nonces(nonce, used_at) VALUES (?, ?)', nonce, Math.max(Date.now(), timestamp));
        return true;
      } catch {
        return false;
      }
    });
    return inserted ? { status: 'ok', value: { authorized: true } } : publicError('REQUEST_REPLAY', 'Signed request was already used');
  }

  private config(): { user_id: string; root_public_key: string; vault_key: string } | undefined {
    return this.ctx.storage.sql.exec<{ user_id: string; root_public_key: string; vault_key: string }>(
      'SELECT user_id, root_public_key, vault_key FROM vault_config WHERE id = 1',
    ).toArray()[0];
  }

  private device(machineId: string): DeviceRow | undefined {
    const row = this.ctx.storage.sql.exec<DeviceRow>(
      'SELECT signing_public_key, exchange_public_key, capabilities_json, generation, grant_json FROM credential_devices WHERE machine_id = ?',
      machineId,
    ).toArray()[0];
    if (!row) return undefined;
    if (row.grant_json) {
      const config = this.config();
      if (!config || !verifyCredentialAuthorityGrant(JSON.parse(row.grant_json) as SignedCredentialAuthorityGrant,
        credentialProtocolBase64.decode(config.root_public_key), Date.now(), (deviceId) => this.deviceGrant(deviceId))) return undefined;
    }
    return row;
  }

  private credential(id: string): CredentialRow | undefined {
    return this.ctx.storage.sql.exec<CredentialRow>(
      'SELECT id, provider, sealed_json, revision, expires_at, state FROM oauth_credentials WHERE id = ?',
      id,
    ).toArray()[0];
  }

  private providerSecretRow(provider: 'composio'): ProviderSecretRow | undefined {
    return this.ctx.storage.sql.exec<ProviderSecretRow>(
      'SELECT provider, sealed_json, revision, updated_at FROM provider_secrets WHERE provider = ?',
      provider,
    ).toArray()[0];
  }

  private acquireRefreshLease(row: CredentialRow, owner: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE expires_at <= ?', Date.now());
      try {
        this.ctx.storage.sql.exec(
          'INSERT INTO refresh_leases(credential_id, owner, revision, expires_at) VALUES (?, ?, ?, ?)',
          row.id,
          owner,
          row.revision,
          Date.now() + REFRESH_LEASE_MS,
        );
        return true;
      } catch {
        return false;
      }
    });
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
function inviteRegistry(env: Env) {
  const namespace = env.INVITES as DurableObjectNamespace<InviteRegistryDO>;
  return namespace.get(namespace.idFromName('global'));
}
function accountRegistry(env: Env) {
  const namespace = env.ACCOUNTS as DurableObjectNamespace<AccountRegistryDO>;
  return namespace.get(namespace.idFromName('global'));
}

interface OperatorPlatformState {
  control: { status: 'active' | 'quarantined' | 'suspended'; reason: string | null; updatedAt: string | null };
  credits: { balanceMicros: number; reservedMicros: number; riskReserveMicros: number; status: 'active' | 'quarantined'; reason: string | null; updatedAt: string } | null;
  usage: { records: number; debitedMicros: number };
  deployment: { active: string | null; uploadedAt: string | null; appliedMigrationTag: string | null };
}

async function operatorPlatformRequest(env: Env, handle: string, init?: RequestInit): Promise<OperatorPlatformState> {
  if (!env.PLATFORM_URL || !env.PLATFORM_BOOTSTRAP_TOKEN) throw new Error('Platform operator connection is not configured');
  const response = await fetch(`${env.PLATFORM_URL.replace(/\/+$/u, '')}/__platform/operator/tenants/${encodeURIComponent(handle)}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.PLATFORM_BOOTSTRAP_TOKEN}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const body = await response.json() as OperatorPlatformState | { error?: { message?: unknown } };
  if (!response.ok || !('control' in body)) {
    throw new Error('error' in body && typeof body.error?.message === 'string' ? body.error.message : `Platform operator request failed with HTTP ${response.status}`);
  }
  return body;
}

async function operatorAccountView(env: Env, account: OperatorAccountRecord) {
  const [machines, platform] = await Promise.all([
    (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(account.userId).listMachines(),
    operatorPlatformRequest(env, account.handle).catch(() => null),
  ]);
  return {
    ...account,
    status: account.status !== 'active' ? account.status : platform?.credits?.status === 'quarantined' ? 'quarantined' : platform?.control.status ?? account.status,
    reason: account.status !== 'active' ? account.reason : platform?.credits?.status === 'quarantined' ? platform.credits.reason : platform?.control.reason ?? account.reason,
    tenantRelease: platform?.deployment.active ?? account.tenantRelease,
    fleet: {
      total: machines.length,
      online: machines.filter((machine) => machine.state === 'online').length,
      physical: machines.filter((machine) => machine.kind === 'physical').length,
      sandboxes: machines.filter((machine) => machine.kind === 'sandbox').length,
      lastSeenAt: null,
    },
    credits: platform?.credits ?? null,
    usage: platform?.usage ?? { records: 0, debitedMicros: 0 },
    deployment: platform?.deployment ?? { active: account.tenantRelease, uploadedAt: null, appliedMigrationTag: null },
  };
}

function projectCrons(env: Env, userId: string, projectId: string) {
  const namespace = env.PROJECT_CRONS as DurableObjectNamespace<ProjectCronsDO>;
  return namespace.get(namespace.idFromName(JSON.stringify([userId, projectId])));
}

function spaceContext(env: Env, userId: string, projectId: string, spaceId: string) {
  const namespace = env.SPACE_CONTEXT as DurableObjectNamespace<SpaceContextDO>;
  return namespace.get(namespace.idFromName(JSON.stringify([userId, projectId, spaceId])));
}

function userSkills(env: Env, userId: string) {
  const namespace = env.USER_SKILLS as DurableObjectNamespace<UserSkillsDO>;
  return namespace.get(namespace.idFromName(userId));
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

async function signComposioState(env: Env, principalId: string, state: string, accountApiKey?: string | null): Promise<string> {
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

interface PlatformConfig {
  url: string;
  tenant: string;
  userId: string;
  token: string;
}


async function tenantWorkerVersion(env: Env, userId: string): Promise<WorkerVersion> {
  if (!env.PLATFORM_URL) return { sha: null, version: null };
  const account = await accountRegistry(env).get(userId);
  if (!account) throw new Error('Account deployment binding is missing');
  const state = await operatorPlatformRequest(env, account.handle);
  if (!state.deployment || (state.deployment.active !== null && typeof state.deployment.active !== 'string')) {
    throw new Error('Platform deployment authority returned invalid state');
  }
  const version = state.deployment.active;
  return { sha: version === 'channel' || version?.startsWith('channel:') ? null : version, version };
}
async function platformConfig(env: Env, userId: string): Promise<PlatformConfig> {
  const account = await activeAccount(env, userId);
  if (account.status === 'error') throw new Error(account.error.message);
  if (!env.PLATFORM_URL || !env.PLATFORM_BOOTSTRAP_TOKEN) throw new Error('Account Worker deployment platform is not configured');
  return { url: env.PLATFORM_URL.replace(/\/+$/u, ''), tenant: account.value.handle, userId, token: env.PLATFORM_BOOTSTRAP_TOKEN };
}

async function platformCall(platform: PlatformConfig, action: 'deploy' | 'revert', body: PlatformDeployRequest | { to: 'previous' | 'channel' }): Promise<{ status: ReleaseStatus; error: string | null }> {
  try {
    const response = await fetch(`${platform.url}/__platform/operator/tenants/${encodeURIComponent(platform.tenant)}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${platform.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, accountId: platform.userId }),
    });
    if (!response.ok) return { status: 'failed', error: `Platform ${action} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 512)}` };
    const result = platformDeployResponseSchema.parse(await response.json());
    if (result.revertedTo !== null) return { status: 'failed', error: `Platform reverted to ${result.revertedTo}: ${result.sha} did not pass its health probe` };
    if (!result.healthy) return { status: 'failed', error: `Platform reported ${result.sha} unhealthy` };
    return { status: 'applied', error: null };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : `Platform ${action} failed` };
  }
}

/** A Worker target must reach its account-owned platform script; an unavailable platform is a failed release. */
async function launchRelease(env: Env, userId: string, payload: Record<string, unknown>): Promise<LaunchResult> {
  const input = launchReleaseInputSchema.parse(payload);
  const releases = tenantReleases(env, userId);
  const launched = await releases.launch(input);
  if (!launched) throw new ReleaseNotFoundError(input.sha);
  if (launched.record.status.worker !== 'pending') return launched;
  const worker = launched.record.artifacts.worker;
  const metadata = launched.record.worker;
  let outcome: { status: ReleaseStatus; error: string | null };
  try {
    if (!worker || !metadata) throw new Error('Worker artifact and metadata are required');
    outcome = await platformCall(await platformConfig(env, userId), 'deploy', { sha: input.sha, bundleKey: dataObjectKey(userId, worker.key), bundleHash: worker.hash, metadata });
  } catch (error) {
    outcome = { status: 'failed', error: error instanceof Error ? error.message : 'Worker deployment failed' };
  }
  const record = await releases.setWorkerStatus(input.sha, outcome.status, outcome.error);
  return { ...launched, record: record ?? launched.record };
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

/** Fetch the account tree directly through ASSETS; canonical redirects stay inside that tree. */
async function accountChannelResponse(request: Request, assets: Fetcher, pathname: string): Promise<Response> {
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

/** Serves either the account's selected frontend tree or its bundled channel frontend. */
async function releaseFrontendResponse(request: Request, env: Env, pathname: string): Promise<Response | null> {
    const hostname = new URL(request.url).hostname.toLowerCase();
    const match = /^([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)\.gitspace\.sh$/u.exec(hostname);
    if (!match || match[1] === 'api' || match[1] === 'www') return null;
    const account = await accountRegistry(env).getByHandle(match[1]!);
    if (!account) return new Response('Account not found', { status: 404 });
    const denied = accountAccessResponse(await activeAccount(env, account.userId));
    if (denied) return denied;
    const ownerId = account.userId;
  const frontend = await tenantReleases(env, ownerId).frontend();
    if (frontend === null) {
      if (!env.ASSETS) return new Response('Account frontend unavailable', { status: 503 });
      return accountChannelResponse(request, env.ASSETS, pathname);
    }
  const prefix = `users/${ownerId}/${frontend.keyPrefix}/`;
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  if (requested.includes('..')) return new Response('Not found', { status: 404 });
  let path = requested;
  let object = await env.DATA.get(prefix + path);
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


function decodeSignedHeader(value: string | null): SignedControlRequest {
  if (!value || value.length > DATA_REQUEST_HEADER_MAX_BYTES) throw new Error('Signed data request is missing or too large');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return signedControlRequestSchema.parse(JSON.parse(atob(base64)) as unknown);
}

function dataObjectKey(userId: string, key: unknown): string {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('..') || key.length > 1_024) {
    throw new Error('Application object key is invalid');
  }
  return `users/${userId}/${key}`;
}

function expectedDataOperation(method: string): 'data.head' | 'data.get' | 'data.put' {
  if (method === 'HEAD') return 'data.head';
  if (method === 'GET') return 'data.get';
  if (method === 'PUT') return 'data.put';
  throw new Error('Application object method is invalid');
}

async function dataObjectResponse(request: Request, env: Env, keyFromPath: string): Promise<Response> {
  const signed = decodeSignedHeader(request.headers.get('x-gitspace-control'));
  const operation = expectedDataOperation(request.method);
  if (signed.operation !== operation || signed.payload.key !== keyFromPath) throw new Error('Signed data request does not match the request');
  const authorized = await authorizeControl(env, signed, 'storage.access');
  if (authorized.status === 'error') return accountAccessResponse(authorized)!;
  const objectKey = dataObjectKey(signed.userId, signed.payload.key);
  if (operation === 'data.put') {
    const hash = signed.payload.hash;
    const size = signed.payload.size;
    if (typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(hash) || !Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > DATA_OBJECT_MAX_BYTES) {
      throw new Error('Application object metadata is invalid');
    }
    const declared = Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(declared) || declared !== size || !request.body) throw new Error('Application object body length does not match');
    const existing = await env.DATA.head(objectKey);
    if (existing) {
      return existing.size === size && existing.customMetadata?.sha256 === hash
        ? new Response(null, { status: 204 })
        : Response.json({ status: 'error', error: { code: 'OBJECT_CONFLICT', message: 'Application object key already has different content' } }, { status: 409 });
    }
    const stored = await env.DATA.put(objectKey, request.body, {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { sha256: hash },
      sha256: hash.slice('sha256:'.length),
    });
    if (!stored) {
      const raced = await env.DATA.head(objectKey);
      if (!raced || raced.size !== size || raced.customMetadata?.sha256 !== hash) {
        return Response.json({ status: 'error', error: { code: 'OBJECT_CONFLICT', message: 'Application object publication raced with different content' } }, { status: 409 });
      }
    }
    return new Response(null, { status: 201 });
  }
  const object = operation === 'data.head' ? await env.DATA.head(objectKey) : await env.DATA.get(objectKey);
  if (!object) return new Response(null, { status: 404 });
  const expectedHash = signed.payload.hash;
  if (expectedHash !== undefined && expectedHash !== object.customMetadata?.sha256) {
    return Response.json({ status: 'error', error: { code: 'HASH_MISMATCH', message: 'Application object hash does not match' } }, { status: 409 });
  }
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'content-length': String(object.size),
    'content-type': 'application/octet-stream',
    etag: object.httpEtag,
  });
  const storedHash = object.customMetadata?.sha256;
  if (storedHash) headers.set('x-gitspace-sha256', storedHash);
  if (operation === 'data.head') return new Response(null, { headers });
  if (!('body' in object) || !(object.body instanceof ReadableStream)) throw new Error('Application object body is missing');
  return new Response(object.body, { headers });
}

async function ompBrokerResponse(request: Request, env: Env, userId: string, operation: string): Promise<Response> {
  if (operation === 'healthz') return Response.json({ ok: true, version: 'gitspace-omp-broker-v1' });
  const identity = env.GITSPACE_OMP_BROKER_TOKEN
    ? await verifyMachineBrokerToken(env.GITSPACE_OMP_BROKER_TOKEN, userId, request.headers.get('authorization'))
    : null;
  if (!identity || !await credentialVault(env, userId).authorizeBroker(identity.machineId, identity.generation)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'private, no-store' } });
  }
  const denied = accountAccessResponse(await activeAccount(env, userId));
  if (denied) return denied;
  const vault = credentialVault(env, userId);
  const disableMatch = /^credential\/(\d+)\/disable$/u.exec(operation);
  if (request.method === 'POST' && (operation === 'credential' || disableMatch)) {
    const headers = { 'cache-control': 'private, no-store' };
    if (!await vault.authorizeBroker(identity.machineId, identity.generation, 'credential.manage')) {
      return Response.json({ error: 'credential management is not authorized' }, { status: 403, headers });
    }
    let body: unknown;
    try {
      body = await readBoundedJson(request);
    } catch {
      return Response.json({ error: 'Invalid credential request' }, { status: 400, headers });
    }
    if (operation === 'credential') {
      const parsed = brokerUploadSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: 'Invalid credential request' }, { status: 400, headers });
      const result = await vault.ompUpload(parsed.data, identity.machineId, identity.generation);
      return result ? Response.json(result, { headers }) : Response.json({ error: 'credential management is not authorized' }, { status: 403, headers });
    }
    if (!brokerDisableSchema.safeParse(body).success) return Response.json({ error: 'Invalid credential request' }, { status: 400, headers });
    const result = await vault.ompDisable(Number(disableMatch![1]), identity.machineId, identity.generation);
    return result === null
      ? Response.json({ error: 'credential management is not authorized' }, { status: 403, headers })
      : Response.json(result ? { ok: true } : { error: 'Credential is unavailable' }, { status: result ? 200 : 404, headers });
  }
  const refreshMatch = /^credential\/(\d+)\/refresh$/u.exec(operation);
  if (refreshMatch && request.method === 'POST') {
    return Response.json(await vault.ompRefresh(Number(refreshMatch[1]!)), { headers: { 'cache-control': 'private, no-store' } });
  }
  if (operation === 'usage' && request.method === 'GET') {
    try {
      return Response.json(await vault.ompUsage(), { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502, headers: { 'cache-control': 'private, no-store' } });
    }
  }
  if (operation === 'snapshot/stream') return new Response('Not found', { status: 404 });
  if (operation !== 'snapshot' || request.method !== 'GET') return new Response('Not found', { status: 404 });
  const snapshot = await vault.ompSnapshot();
  const etag = `\"${snapshot.generation}\"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  return Response.json(snapshot, { headers: { etag, 'cache-control': 'private, no-store' } });
}
function catalogSpacePayload(payload: Record<string, unknown>): PortableSpaceDefinition {
  return {
    projectId: String(payload.projectId ?? ''),
    projectName: String(payload.projectName ?? ''),
    repositoryReference: typeof payload.repositoryReference === 'string' ? payload.repositoryReference : null,
    baseBranch: String(payload.baseBranch ?? ''),
    spaceId: String(payload.spaceId ?? ''),
    kind: payload.kind === 'base' ? 'base' : 'worktree',
    name: String(payload.name ?? ''),
    branch: String(payload.branch ?? ''),
    phase: payload.phase === 'plan' || payload.phase === 'code' || payload.phase === 'review' || payload.phase === 'ship' ? payload.phase : null,
  };
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
}, current: FleetMachineDefinition, observed?: FleetMachineDefinition): Promise<FleetMachineDefinition> {
  const provider = machineProviderFor(env, userId, current);
  if (provider.id === 'physical') return provider.sleep(current);
  // Offline intent is committed only after stopping. An interrupted or failed save
  // must never become permission for a later reconciliation to discard live work.
  const transition = await catalog.putMachine({
    ...current, state: 'sleeping', desiredState: 'online',
    lifecycleRevision: current.lifecycleRevision + 1, operationId: crypto.randomUUID(), error: null,
  });
  let preparationAttempted = false;
  try {
    observed ??= await provider.status(current);
    const alreadyStopped = observed.state === 'offline' && observed.desiredState === 'offline';
    if (!alreadyStopped) {
      preparationAttempted = true;
      await provider.prepareReplacement(transition);
    }
    // Also check cloud ownership: a stale runtime cannot acknowledge spaces it
    // never loaded. An already stopped machine cannot save any remaining owners.
    await assertMachineHasNoOpenSpaces(env, userId, catalog, current.id);
    const stopped = alreadyStopped ? observed : await provider.sleep(transition);
    return await catalog.putMachine({
      ...stopped, desiredState: 'offline', lifecycleRevision: Math.max(transition.lifecycleRevision, stopped.lifecycleRevision) + 1,
      operationId: null, error: null,
    });
  } catch (error) {
    let failure = error;
    let recovered = true;
    if (preparationAttempted) {
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
      ...(observed ?? current), state: recovered ? (observed ?? current).state : 'error', desiredState: 'online',
      lifecycleRevision: Math.max(transition.lifecycleRevision, observed?.lifecycleRevision ?? 0) + 1, operationId: null,
      error: failure instanceof Error ? failure.message : String(failure),
    });
    throw failure;
  }
}


export async function reconcileFleetMachines(env: Env, userId: string, catalog: {
  listMachines(): Promise<FleetMachineDefinition[]>;
  listSpaces(): Promise<PortableSpaceDefinition[]>;
  putMachine(machine: FleetMachineDefinition): Promise<FleetMachineDefinition>;
  removeMachine(machineId: string): Promise<boolean>;
}): Promise<FleetMachineDefinition[]> {
  for (const current of await catalog.listMachines()) {
    if (current.provider === 'physical') continue;
    const provider = machineProviderFor(env, userId, current);
    let stopping = false;
    try {
      let observed = await provider.status(current);
      if (current.desiredState === 'online' && observed.state !== 'online') observed = await provider.resume(current);
      else if (current.desiredState === 'offline' && (observed.state !== 'offline' || observed.desiredState !== 'offline')) {
        stopping = true;
        await checkpointAndStopFleetMachine(env, userId, catalog, current, observed);
        continue;
      } else if (current.desiredState === 'removed') {
        await assertMachineHasNoOpenSpaces(env, userId, catalog, current.id);
        await provider.destroy(current);
        await catalog.removeMachine(current.id);
        await credentialVault(env, userId).removeManagedDevice(current.id);
        continue;
      }
      if (current.state !== observed.state || current.rpcEndpoint !== observed.rpcEndpoint || current.operationId !== null || current.error !== null) {
        await catalog.putMachine({ ...observed, desiredState: current.desiredState, lifecycleRevision: Math.max(current.lifecycleRevision, observed.lifecycleRevision) + 1, operationId: null, error: null });
      }
    } catch (error) {
      if (!stopping) await catalog.putMachine({ ...current, state: 'error', lifecycleRevision: current.lifecycleRevision + 1, operationId: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return catalog.listMachines();
}


export function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'sleep' | 'resume'): Promise<FleetMachineDefinition>;
export function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'destroy'): Promise<{ machineId: string; removed: true }>;
export function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'sleep' | 'resume' | 'destroy'): Promise<FleetMachineDefinition | { machineId: string; removed: true }>;
export async function controlFleetMachine(env: Env, userId: string, machineId: string, action: 'sleep' | 'resume' | 'destroy'): Promise<FleetMachineDefinition | { machineId: string; removed: true }> {
  if (action !== 'destroy' && await accountRegistry(env).sandboxRollout()) throw new Error('Cloud machine replacement has fenced machine lifecycle changes');
  const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
  const existing = await catalog.getMachine(machineId);
  if (!existing) {
    if (action === 'destroy') return { machineId, removed: true };
    throw new Error('Machine does not exist');
  }
  if ((action === 'sleep' && existing.state === 'offline' && existing.desiredState === 'offline') || (action === 'resume' && existing.state === 'online' && existing.desiredState === 'online' && existing.error === null)) return existing;
  if (action === 'sleep') return checkpointAndStopFleetMachine(env, userId, catalog, existing);
  const desiredState = action === 'resume' ? 'online' : 'removed';
  if (action === 'destroy') await assertMachineHasNoOpenSpaces(env, userId, catalog, machineId);
  const transition = await catalog.putMachine({
    ...existing, state: action === 'resume' ? 'resuming' : 'deleting',
    desiredState, lifecycleRevision: existing.lifecycleRevision + 1, operationId: existing.operationId ?? crypto.randomUUID(), error: null,
  });
  const provider = machineProviderFor(env, userId, transition);
  try {
    if (action === 'destroy') {
      await provider.destroy(transition);
      await catalog.removeMachine(machineId);
      await credentialVault(env, userId).removeManagedDevice(machineId);
      return { machineId, removed: true };
    }
    const machine = await provider.resume(transition);
    return await catalog.putMachine({ ...machine, desiredState, lifecycleRevision: transition.lifecycleRevision + 1, operationId: null, error: null });
  } catch (error) {
    await catalog.putMachine({ ...transition, state: 'error', lifecycleRevision: transition.lifecycleRevision + 1, operationId: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export async function provisionManagedSandbox(env: Env, userId: string, controlUrl: string): Promise<FleetMachineDefinition> {
  const storageNamespace = env.USER_STORAGE as DurableObjectNamespace<UserStorageDO>;
  await storageNamespace.getByName(userId).requireReady(userId);
  const machineId = `sandbox-${crypto.randomUUID().slice(0, 8)}`;
  const signingPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const exchangePrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = credentialVault(env, userId);
  const registered = await vault.registerManagedDevice({
    userId,
    machineId,
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(exchangePrivateKey)),
    capabilities: ['storage.access', 'space.control', 'credential.access', 'credential.manage'],
  });
  if (registered.status === 'error') throw new Error(registered.error.message);
  // Sandboxes are worker-provisioned, so the worker hands them the root key to
  // pin; their trust in it is the same trust that installed their machine key.
  const rootPublicKey = await vault.rootPublicKey();
  if (!rootPublicKey) throw new Error('Vault is not configured');
  const accountSettings = await (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(userId).get(machineId);
  if (!accountSettings.profile.handle) throw new Error('Account tenant is not provisioned');
  const catalogNamespace = env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>;
  const catalog = catalogNamespace.getByName(userId);
  const operationId = crypto.randomUUID();
  await catalog.putMachine({
    id: machineId,
    label: `Cloudflare ${machineId.slice('sandbox-'.length)}`,
    state: 'provisioning',
    rpcEndpoint: null,
    kind: 'sandbox',
    provider: 'cloudflare-sandbox',
    notes: 'Provisioning Cloudflare Sandbox machine runtime.',
    desiredState: 'online',
    lifecycleRevision: 1,
    operationId,
    error: null,
  });
  try {
    if (!env.GITSPACE_OMP_BROKER_TOKEN) throw new Error('Account credential broker is not configured');
    const created = await createCloudflareSandboxMachine({
      env,
      userId,
      machineId,
      environment: {
        GITSPACE_ENVIRONMENT_ROOT: '/workspace/gitspace',
        GITSPACE_MACHINE_ID: machineId,
        GITSPACE_MACHINE_LABEL: `Cloudflare ${machineId.slice('sandbox-'.length)}`,
        GITSPACE_CONTROL_URL: controlUrl,
        OMP_AUTH_BROKER_URL: `${controlUrl.replace(/\/+$/u, '')}/omp/users/${encodeURIComponent(userId)}`,
        OMP_AUTH_BROKER_TOKEN: await machineBrokerToken(env.GITSPACE_OMP_BROKER_TOKEN, userId, machineId, registered.value.generation),
        GITSPACE_USER_ID: userId,
        GITSPACE_ROOT_PUBLIC_KEY: rootPublicKey,
        GITSPACE_MACHINE_SIGNING_PRIVATE_KEY: credentialProtocolBase64.encode(signingPrivateKey),
        GITSPACE_ARTIFACT_KEY: await credentialVault(env, userId).artifactKey(userId),
        GITSPACE_CONTROL_TOKEN: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))),
        GITSPACE_SERVICE_DOMAIN: 'gssh.dev',
        GITSPACE_SERVICE_NAMESPACE: accountSettings.profile.handle,
        GITSPACE_OMP_AGENT_DIR: '/workspace/.omp',
        GITSPACE_MANAGED_SPACE_ROOT: '/workspace/spaces',
        GITSPACE_MIGRATIONS_FOLDER: '/opt/gitspace/drizzle',
        GITSPACE_RPC_PORT: '8081',
        GITSPACE_RPC_HOST: '0.0.0.0',
        GITSPACE_WALGIT_BINARY: '/usr/local/bin/walgit',
      },
    });
    return await catalog.putMachine({ ...created, lifecycleRevision: 2, operationId: null, error: null });
  } catch (error) {
    await vault.removeManagedDevice(machineId);
    await catalog.putMachine({
      id: machineId,
      label: `Cloudflare ${machineId.slice('sandbox-'.length)}`,
      state: 'error',
      rpcEndpoint: null,
      kind: 'sandbox',
      provider: 'cloudflare-sandbox',
      notes: 'Cloudflare Sandbox provisioning failed.',
      desiredState: 'online',
      lifecycleRevision: 2,
      operationId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}


/** Forwards the original signed envelope to the selected online machines. */
export async function proxyAccountMachineRpc(request: Request, env: Env, userId: string, candidates: FleetMachineDefinition[]): Promise<Response> {
  const body = await request.arrayBuffer();
  for (const machine of candidates) {
    const headers = new Headers(request.headers);
    headers.delete('x-gitspace-user');
    headers.delete('host');
    headers.set('x-gitspace-signed-target', `${new URL(request.url).pathname}${new URL(request.url).search}`);
    const managedSandbox = machine.provider === 'cloudflare-sandbox';
    if (managedSandbox) headers.set('x-gitspace-user-id', userId);
    const upstream = new Request(managedSandbox
      ? `https://sandbox.internal/v1/sandboxes/${encodeURIComponent(machine.id)}/rpc`
      : machine.rpcEndpoint!, {
      method: request.method,
      headers,
      body: body.byteLength > 0 ? body.slice(0) : null,
      redirect: 'manual',
    });
    const response = managedSandbox
      ? await env.SANDBOX_PROVISIONER.fetch(upstream)
      : await fetch(upstream);
    if (response.status !== 503) return response;
  }
  return Response.json(publicError('FLEET_OFFLINE', 'Every account machine is offline'), { status: 503 });
}

async function accountRpcResponse(request: Request, env: Env): Promise<Response> {
  const userId = request.headers.get('x-gitspace-user');
  if (!userId || !/^u-[a-f0-9]{32}$/u.test(userId)) {
    return Response.json(publicError('ACCOUNT_REQUIRED', 'Account identity is missing'), { status: 401 });
  }
  const account = await activeAccount(env, userId);
  const denied = accountAccessResponse(account);
  if (denied) return denied;
  const settings = await (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(userId).get('account-router');
  const handle = settings.profile.handle;
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!handle || hostname !== `${handle}.gitspace.sh`) {
    return Response.json(publicError('ACCOUNT_HOST_MISMATCH', 'Request does not belong to this account hostname'), { status: 403 });
  }
  const cloud = await handleAccountCloudRpc(request, env, userId);
  if (cloud) return cloud;
  const machines = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).listMachines();
  const candidates = machines.filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint);
  if (candidates.length === 0) {
    return Response.json(publicError('FLEET_OFFLINE', 'No account machine is available'), { status: 503 });
  }
  return proxyAccountMachineRpc(request, env, userId, candidates);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/shared-artifacts/')) return serveArtifactShare(request, env);
    if (url.pathname.startsWith('/distribution/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      const stable = /^\/distribution\/v1\/stable\/(?:darwin|linux)-(?:arm64|x64)\.(?:json|txt)$/u.test(url.pathname);
      const release = /^\/distribution\/v1\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:darwin|linux)-(?:arm64|x64)\/(?:gitspace|manifest\.json|runtime\.bin\.gz|provenance\.json)$/u.test(url.pathname);
      if (!stable && !release) return new Response('Not found', { status: 404 });
      const key = url.pathname.slice(1);
      const object = request.method === 'HEAD' ? await env.DATA.head(key) : await env.DATA.get(key);
      if (!object) return new Response('Not found', { status: 404 });
      const headers = new Headers({
        'content-type': key.endsWith('.json') ? 'application/json' : key.endsWith('.txt') ? 'text/plain; charset=utf-8' : key.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
        'content-length': String(object.size),
        'cache-control': stable ? 'no-cache' : 'public, max-age=31536000, immutable',
        'etag': object.httpEtag,
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
      });
      return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, { headers });
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
          operation: pairingRoute[1]!, header: request.headers.get(RPC_DEVICE_HEADER), target: `${url.pathname}${url.search}`, body, operatorUrl: url.origin,
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
    if (url.pathname === '/__platform/hosted-route' && request.method === 'GET') {
      if (!env.PLATFORM_BOOTSTRAP_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PLATFORM_BOOTSTRAP_TOKEN}`) {
        return Response.json(publicError('ROUTE_LOOKUP_UNAUTHORIZED', 'Hosted route lookup is not authorized'), { status: 401 });
      }

      const hostname = url.searchParams.get('hostname')?.toLowerCase() ?? '';
      if (!/^[a-z0-9-]+\.gssh\.dev$/u.test(hostname)) {
        return Response.json(publicError('INVALID_HOSTNAME', 'Hosted route hostname is invalid'), { status: 400 });
      }
      const route = await (env.HOSTED_ROUTES as DurableObjectNamespace<HostedRouteRegistryDO>).getByName(hostname).get();
      if (!route) return Response.json(publicError('ROUTE_NOT_FOUND', 'Hosted route is not active'), { status: 404 });
      const accountId = route.tenant;
      const denied = accountAccessResponse(await activeAccount(env, accountId));
      if (denied) return denied;
      const accountSettings = await (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(accountId).get('hosted-route');
      if (!accountSettings.profile.handle) return Response.json(publicError('ACCOUNT_UNPROVISIONED', 'Hosted route account is not provisioned'), { status: 404 });
      const machine = (await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(accountId).listMachines())
        .find((candidate) => candidate.id === route.machineId);
      if (!machine?.rpcEndpoint) return Response.json(publicError('MACHINE_ROUTE_NOT_FOUND', 'Hosted route machine is unavailable'), { status: 404 });
      return Response.json({ ...route, tenant: accountSettings.profile.handle, rpcEndpoint: machine.rpcEndpoint }, { headers: { 'cache-control': 'private, no-store' } });
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
      if (await accountRegistry(env).sandboxRollout()) {
        return Response.json(publicError('SANDBOX_ROLLOUT_IN_PROGRESS', 'Cloud machines are checkpointing or restarting'), { status: 503, headers: cors });
      }
      const headers = new Headers(request.headers);
      headers.set('x-gitspace-user-id', userId);
      headers.delete('host');
      headers.set('x-gitspace-signed-target', `${url.pathname}${url.search}`);
      const response = await env.SANDBOX_PROVISIONER.fetch(new Request(`https://sandbox.internal/v1/sandboxes/${encodeURIComponent(machineId)}/rpc`, {
        method: 'POST',
        headers,
        body: request.body,
        redirect: 'manual',
      }));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
    }
    if (url.pathname.startsWith('/v1/operator/')) {
      const identity = await operatorIdentity(request, env);
      if (!identity) {
        return Response.json(publicError('OPERATOR_UNAUTHORIZED', 'A valid Cloudflare Access operator session is required'), {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        });
      }
      const rolloutResponse = await handleSandboxRollout(request, env);
      if (rolloutResponse) return rolloutResponse;
      const invites = inviteRegistry(env);
      const accounts = accountRegistry(env);
      if (url.pathname === '/v1/operator/session' && request.method === 'GET') {
        return Response.json({ status: 'ok', value: { authenticated: true, email: identity.email } }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/operator/overview' && request.method === 'GET') {
        const [accountViews, inviteViews] = await Promise.all([
          Promise.all((await accounts.list()).map((account) => operatorAccountView(env, account))),
          invites.list(),
        ]);
        return Response.json({
          status: 'ok',
          value: {
            accounts: {
              total: accountViews.length,
              active: accountViews.filter((account) => account.status === 'active').length,
              attention: accountViews.filter((account) => account.status !== 'active').length,
            },
            fleet: {
              total: accountViews.reduce((total, account) => total + account.fleet.total, 0),
              online: accountViews.reduce((total, account) => total + account.fleet.online, 0),
              physical: accountViews.reduce((total, account) => total + account.fleet.physical, 0),
              sandboxes: accountViews.reduce((total, account) => total + account.fleet.sandboxes, 0),
            },
            credits: {
              configuredAccounts: accountViews.filter((account) => account.credits !== null).length,
              balanceMicros: accountViews.reduce((total, account) => total + (account.credits?.balanceMicros ?? 0), 0),
              debitedMicros: accountViews.reduce((total, account) => total + account.usage.debitedMicros, 0),
            },
            invitations: {
              available: inviteViews.filter((invite) => invite.status === 'available').length,
              consumed: inviteViews.filter((invite) => invite.status === 'consumed').length,
            },
          },
        }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/operator/accounts' && request.method === 'GET') {
        const accountViews = await Promise.all((await accounts.list()).map((account) => operatorAccountView(env, account)));
        return Response.json({ status: 'ok', value: { accounts: accountViews } }, { headers: { 'cache-control': 'no-store' } });
      }
      const accountMatch = /^\/v1\/operator\/accounts\/(u-[a-f0-9]{32})$/u.exec(url.pathname);
      if (accountMatch && request.method === 'GET') {
        const account = await accounts.get(accountMatch[1]!);
        if (!account) return Response.json(publicError('ACCOUNT_NOT_FOUND', 'Operator account record was not found'), { status: 404 });
        const [view, events] = await Promise.all([operatorAccountView(env, account), accounts.listEvents(account.userId)]);
        return Response.json({ status: 'ok', value: { account: view, events } }, { headers: { 'cache-control': 'no-store' } });
      }
      const actionMatch = /^\/v1\/operator\/accounts\/(u-[a-f0-9]{32})\/actions$/u.exec(url.pathname);
      if (actionMatch && request.method === 'POST') {
        try {
          const account = await accounts.get(actionMatch[1]!);
          if (!account) return Response.json(publicError('ACCOUNT_NOT_FOUND', 'Operator account record was not found'), { status: 404 });
          const body = await readBoundedJson(request) as { action?: unknown; reason?: unknown };
          if (body.action !== 'suspend' && body.action !== 'quarantine' && body.action !== 'restore') {
            return Response.json(publicError('INVALID_ACCOUNT_ACTION', 'Account action must be suspend, quarantine, or restore'), { status: 400 });
          }
          const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
          // Restrict locally before the remote write; a platform outage must not
          // leave direct APIs open. Restore only after the platform accepts it.
          if (body.action !== 'restore') {
            await accounts.setStatus({
              userId: account.userId,
              status: body.action === 'suspend' ? 'suspended' : 'quarantined',
              reason,
              actor: identity.email,
              action: body.action,
            });
          }
          const platform = await operatorPlatformRequest(env, account.handle, {
            method: 'POST',
            body: JSON.stringify({ action: body.action, reason }),
          });
          const updated = body.action === 'restore'
            ? await accounts.setStatus({
              userId: account.userId,
              status: platform.control.status,
              reason: platform.control.reason,
              actor: identity.email,
              action: body.action,
            })
            : await accounts.get(account.userId);
          if (!updated) throw new Error('Account disappeared during operator action');
          return Response.json({ status: 'ok', value: { account: await operatorAccountView(env, updated) } }, { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json(publicError('ACCOUNT_ACTION_FAILED', error instanceof Error ? error.message : 'Account action failed'), { status: 502 });
        }
      }
      if (url.pathname === '/v1/operator/invites' && request.method === 'GET') {
        return Response.json({ status: 'ok', value: { invites: await invites.list() } }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/operator/invites' && request.method === 'POST') {
        try {
          const body = await readBoundedJson(request) as { note?: unknown; expiresInDays?: unknown };
          const note = typeof body.note === 'string' ? body.note.trim().slice(0, 160) : '';
          const expiresInDays = body.expiresInDays === null || body.expiresInDays === undefined ? 7 : body.expiresInDays;
          if (!Number.isInteger(expiresInDays) || Number(expiresInDays) < 1 || Number(expiresInDays) > 365) {
            return Response.json(publicError('INVALID_INVITE', 'Invite expiry must be between 1 and 365 days'), { status: 400 });
          }
          const created = await invites.create({ note, expiresAt: Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000 });
          return Response.json({
            status: 'ok',
            value: {
              ...created,
              signupUrl: `https://gitspace.sh/?invite=${encodeURIComponent(created.token)}#start`,
            },
          }, { status: 201, headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json(publicError('INVALID_INVITE', error instanceof Error ? error.message : 'Invite request is invalid'), { status: 400 });
        }
      }
      const inviteMatch = /^\/v1\/operator\/invites\/([0-9a-f-]{36})$/u.exec(url.pathname);
      if (inviteMatch && request.method === 'DELETE') {
        const result = await invites.revoke(inviteMatch[1]!);
        if (!result.revoked) return Response.json(publicError('INVITE_NOT_REVOCABLE', 'Invite is missing or no longer revocable'), { status: 409 });
        return Response.json({ status: 'ok', value: result }, { headers: { 'cache-control': 'no-store' } });
      }
      return new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/rpc') return accountRpcResponse(request, env);
    if (url.pathname === '/v1/relay/authorize' && request.method === 'POST') {
      try {
        const body = await readBoundedJson(request) as { grant?: unknown; capability?: unknown };
        if (body.capability !== 'space.control' && body.capability !== 'storage.access') {
          return Response.json(publicError('INVALID_CAPABILITY', 'Relay capability is invalid'), { status: 400 });
        }
        const grant = signedCredentialAuthorityGrantSchema.parse(body.grant);
        const account = await activeAccount(env, grant.grant.userId);
        if (account.status === 'error') return Response.json(account, { status: account.error.code === 'ACCOUNT_AUTHORITY_UNAVAILABLE' ? 503 : 401 });
        const result = await credentialVault(env, grant.grant.userId).authorizeRelayGrant(grant, body.capability);
        return Response.json(result, { status: result.status === 'ok' ? 200 : 401, headers: { 'cache-control': 'no-store' } });
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
      const account = await accountRegistry(env).get(userId);
      if (!account || account.handle !== body.handle.trim().toLowerCase()) {
        return Response.json(publicError('ACCOUNT_NOT_FOUND', 'No account matches this recovery key and handle'), { status: 404 });
      }
      if (account.status === 'provisioning' || account.status === 'failed') {
        return Response.json(publicError('ACCOUNT_INCOMPLETE', 'Account provisioning must be retried with the original invitation'), { status: 409 });
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
          relayUrl: `https://${account.tenantHostname}`,
          accountUrl: `https://${account.handle}.gitspace.sh`,
          apiUrl: url.origin,
        },
      }, { headers: { 'cache-control': 'private, no-store' } });
    }
    if (url.pathname === '/v1/accounts/bootstrap' && request.method === 'POST') {
      let activeInvite: { token: string; userId: string } | undefined;
      let registryAccountUserId: string | undefined;
      try {
        const body = await readBoundedJson(request) as { rootPublicKey?: unknown; vaultKey?: unknown; handle?: unknown; invite?: unknown };
        if (typeof body.rootPublicKey !== 'string' || typeof body.vaultKey !== 'string' || typeof body.handle !== 'string' || typeof body.invite !== 'string') {
          return Response.json(publicError('INVALID_BOOTSTRAP', 'Invitation, root public key, vault key, and handle are required'), { status: 400 });
        }
        const handle = body.handle.trim().toLowerCase();
        const invite = body.invite.trim();
        if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(handle)) {
          return Response.json(publicError('INVALID_HANDLE', 'Handle must be 1 to 30 lowercase letters, numbers, or hyphens'), { status: 400 });
        }
        const userId = await accountIdForRootPublicKey(body.rootPublicKey);
        if (!userId) return Response.json(publicError('INVALID_BOOTSTRAP', 'Root public key is invalid'), { status: 400 });
        const target = `${url.pathname}${url.search}`;
        const signature = verifyRelayAuthorization({
          header: request.headers.get('authorization'),
          signingPublicKey: body.rootPublicKey,
          target,
          maxSkewMs: REQUEST_MAX_SKEW_MS,
        });
        if (signature.status === 'error') return Response.json(publicError('ROOT_UNAUTHORIZED', signature.error.message), { status: 401 });

        const existingAccount = await accountRegistry(env).get(userId);
        if (existingAccount && (existingAccount.status === 'suspended' || existingAccount.status === 'quarantined')) {
          return Response.json(publicError('ACCOUNT_UNAVAILABLE', 'Account is not active; contact the operator'), { status: 403 });
        }
        if (existingAccount && existingAccount.handle !== handle) {
          return Response.json(publicError('HANDLE_MISMATCH', 'Recovery key belongs to a different permanent handle'), { status: 409 });
        }
        const registry = inviteRegistry(env);
        const reservation = await registry.reserve({ token: invite, userId, handle });
        if (reservation.status === 'invalid') {
          const expired = reservation.reason === 'expired';
          return Response.json(publicError(
            expired ? 'INVITE_EXPIRED' : 'INVITE_INVALID',
            expired ? 'This invitation has expired' : 'This invitation is invalid, already used, or currently in use',
          ), { status: 403, headers: { 'cache-control': 'no-store' } });
        }
        if (reservation.status === 'reserved') activeInvite = { token: invite, userId };

        const vault = credentialVault(env, userId);
        const handleRegistry = (env.USER_HANDLES as DurableObjectNamespace<HandleRegistryDO>).getByName(handle);
        const handleClaim = await handleRegistry.claim(userId);
        if (!handleClaim.claimed) {
          if (activeInvite) await registry.release(activeInvite);
          return Response.json(publicError('HANDLE_UNAVAILABLE', `Handle ${handle} is already reserved`), { status: 409 });
        }
        const accountDirectory = accountRegistry(env);
        await accountDirectory.upsertProvisioning({ userId, handle });
        registryAccountUserId = userId;
        const settings = (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(userId);
        const currentSettings = await settings.get('account-bootstrap');
        if (currentSettings.profile.handle !== handle) {
          const reserved = await settings.setHandle('account-bootstrap', currentSettings.revision, handle);
          if (reserved.status === 'conflict') throw new Error('Account settings changed during bootstrap');
        }
        const configured = await vault.bootstrap({ userId, rootPublicKey: body.rootPublicKey, vaultKey: body.vaultKey });
        if (configured.status === 'error') {
          if (activeInvite) await registry.release(activeInvite);
          return Response.json(configured, { status: 409 });
        }
        const authorized = await vault.authorizeRoot(request.headers.get('authorization'), target);
        if (authorized.status === 'error') {
          if (activeInvite) await registry.release(activeInvite);
          return Response.json(authorized, { status: 401 });
        }
        await projectSecrets(env, userId).bootstrap({ userId, vaultKey: body.vaultKey });
        const storage = (env.USER_STORAGE as DurableObjectNamespace<UserStorageDO>).getByName(userId);
        const gitBucketName = `gsp-u-${userId.toLowerCase().replace(/[^a-z0-9-]/gu, '-')}`.slice(0, 62);
        const r2 = new CloudflareR2PlatformClient({
          accountId: env.CF_ACCOUNT_ID,
          apiToken: env.CF_API_TOKEN,
          parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
        });
        const storageState = await storage.get();
        if (storageState?.state === 'deleting') throw new Error('Account storage is being deleted');
        if (storageState?.state !== 'ready') {
          await storage.beginProvisioning({ userId, gitBucketName });
          try {
            await r2.ensureBucket({ bucketName: gitBucketName });
            await storage.markReady({ userId, gitBucketName });
          } catch (error) {
            await storage.markFailed({ userId, gitBucketName, message: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        }
        const relayBucketName = `gsp-relay-${userId.toLowerCase().replace(/[^a-z0-9-]/gu, '-')}`.slice(0, 62).replace(/-+$/u, '');
        await r2.ensureBucket({ bucketName: relayBucketName });
        const tenant = await bootstrapTenant(env, handle, body.rootPublicKey, relayBucketName);
        if (activeInvite && !(await registry.consume({ ...activeInvite, handle })).consumed) {
          throw new Error('Invitation could not be consumed');
        }
        await accountDirectory.markActive({ userId, release: tenant.release });
        await ensureAccountGitSpaceProject(env, userId);
        activeInvite = undefined;
        return Response.json({
          status: 'ok',
          value: { userId, handle, relayUrl: tenant.relayUrl, accountUrl: tenant.accountUrl, apiUrl: url.origin },
        }, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) {
        if (activeInvite) await inviteRegistry(env).release(activeInvite);
        if (registryAccountUserId) {
          await accountRegistry(env).markFailed({
            userId: registryAccountUserId,
            message: error instanceof Error ? error.message : 'Account bootstrap failed',
          });
        }
        return Response.json(publicError('BOOTSTRAP_FAILED', error instanceof Error ? error.message : 'Account bootstrap failed'), { status: 502 });
      }
    }
    if (url.pathname === '/v1/machines/enroll' && request.method === 'POST') {
      try {
        const body = await readBoundedJson(request) as { userId?: unknown; label?: unknown; deviceGrant?: unknown };
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
          const current = await vault.authorizeRelayGrant(signedGrant, 'space.control');
          if (current.status === 'error') return Response.json(current, { status: 401 });
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
        return Response.json({ status: 'ok', value: { machine, relayUrl } }, { headers: { 'cache-control': 'private, no-store' } });
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
        const authorized = root.status === 'ok' ? root
          : await vault.authorizeMachineRequest(request.headers.get('authorization'), `${url.pathname}${url.search}`, body.machineId);
        if (authorized.status === 'error') return Response.json(authorized, { status: 401 });
        const denied = accountAccessResponse(await activeAccount(env, body.userId));
        if (denied) return denied;
        await vault.removeManagedDevice(body.machineId);
        const removed = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(body.userId).removeMachine(body.machineId);
        return Response.json({ status: 'ok', value: { machineId: body.machineId, removed } }, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) {
        return Response.json(publicError('INVALID_MACHINE', error instanceof Error ? error.message : 'Machine revocation failed'), { status: 400 });
      }
    }
    const ompBrokerMatch = /^\/omp\/users\/([^/]+)\/v1\/(healthz|snapshot|snapshot\/stream|usage|credential|credential\/\d+\/(?:refresh|disable))$/u.exec(url.pathname);
    if (ompBrokerMatch) {
      try {
        return await ompBrokerResponse(request, env, decodeURIComponent(ompBrokerMatch[1]!), ompBrokerMatch[2]!);
      } catch {
        return Response.json({ error: 'broker unavailable' }, { status: 503 });
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
        const accounts = accountRegistry(env);
        await accounts.upsertProvisioning({ userId: body.userId, handle: body.handle });
        const handles = (env.USER_HANDLES as DurableObjectNamespace<HandleRegistryDO>).getByName(body.handle);
        if (!(await handles.claim(body.userId)).claimed) throw new Error('Development account handle is already owned');
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
        await accounts.markActive({ userId: body.userId, release: null });
        await ensureAccountGitSpaceProject(env, body.userId);
        return Response.json(registered.status === 'ok' ? registered : { status: 'ok', value: { machineId: 'existing', generation: 0 } });
      } catch (error) {
        return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Development bootstrap is invalid' } }, { status: 400 });
      }
    }
    const dataMatch = /^\/v1\/data\/(.+)$/u.exec(url.pathname);
    if (dataMatch) {
      try {
        const key = dataMatch[1]!.split('/').map(decodeURIComponent).join('/');
        return await dataObjectResponse(request, env, key);
      } catch {
        return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: 'Application object request is invalid' } }, { status: 400 });
      }
    }
    if (url.pathname === '/v1/settings/events') {
      try {
        const signed = decodeSignedHeader(url.searchParams.get('control'));
        if (signed.operation !== 'settings.subscribe') throw new Error('Signed settings subscription is invalid');
        const authorized = await authorizeControl(env, signed, 'storage.access');
        if (authorized.status === 'error') return accountAccessResponse(authorized)!;
        const namespace = env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>;
        const settings = namespace.get(namespace.idFromName(signed.userId));
        return settings.fetch(request);
      } catch (error) {
        return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Settings subscription is invalid' } }, { status: 400 });
      }
    }
    if (url.pathname === '/v1/fleet/events') {
      try {
        const signed = decodeSignedHeader(url.searchParams.get('control'));
        if (signed.operation !== 'catalog.machine.subscribe') throw new Error('Signed fleet subscription is invalid');
        const authorized = await authorizeControl(env, signed, 'space.control');
        if (authorized.status === 'error') return accountAccessResponse(authorized)!;
        const namespace = env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>;
        return namespace.getByName(signed.userId).fetch(request);
      } catch (error) {
        return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Fleet subscription is invalid' } }, { status: 400 });
      }
    }
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
        const denied = accountAccessResponse(await activeAccount(env, invite.invite.userId));
        if (denied) return new Response(denied.body, { status: denied.status, headers: { ...cors, 'content-type': 'application/json' } });
        const result = await credentialVault(env, invite.invite.userId).enrollDevice({ invite, binding });
        return Response.json(result, { status: result.status === 'ok' ? 200 : 400, headers: cors });
      } catch (error) {
        return Response.json({ status: 'error', error: { code: 'INVALID_DEVICE_ENROLLMENT', message: error instanceof Error ? error.message : 'Invalid enrollment' } }, { status: 400, headers: cors });
      }
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
      try {
        const body = signedControlRequestSchema.parse(await readBoundedJson(request));
        const capability = body.operation.startsWith('settings.') ? 'storage.access'
          : body.operation.startsWith('space.')
            || body.operation.startsWith('catalog.')
            || body.operation.startsWith('crons.')
            || body.operation.startsWith('inspector.')
            || body.operation.startsWith('mcp.')
            || body.operation.startsWith('devices.')
            || body.operation.startsWith('deploy.')
            || body.operation === 'artifacts.key.get'
            || body.operation.startsWith('project.mcp.') ? 'space.control'
          : body.operation === 'storage.provision' ? 'storage.provision'
          : 'storage.access';
        const authorized = await authorizeControl(env, body, capability);
        if (authorized.status === 'error') return accountAccessResponse(authorized)!;
        const rollout = await accountRegistry(env).sandboxRollout();
        if (rollout && (
          body.operation === 'space.bootstrap'
          || body.operation === 'catalog.sandbox.create'
          || body.operation === 'catalog.machine.resume'
          || (body.operation === 'space.beginOpen' && !(rollout.recovering && rollout.machines.some(machine => machine.userId === body.userId && machine.machineId === body.machineId)))
        )) return Response.json(publicError('SANDBOX_ROLLOUT_IN_PROGRESS', 'Cloud machine replacement has fenced new work'), { status: 503, headers: { 'cache-control': 'no-store' } });
        if (body.operation === 'artifacts.key.get') {
          if (Object.keys(body.payload).length !== 0) throw new Error('Artifact key request must have an empty payload');
          const key = await credentialVault(env, body.userId).artifactKey(body.userId);
          return Response.json({ status: 'ok', value: { key } }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('deploy.')) {
          const releases = tenantReleases(env, body.userId);
          let value: unknown;
          switch (body.operation) {
            case 'deploy.stage':
              value = await releases.stage(stageReleaseInputSchema.parse(body.payload), body.machineId);
              break;
            case 'deploy.launch':
              value = await launchRelease(env, body.userId, body.payload);
              break;
            case 'deploy.status':
              value = await releases.status(await tenantWorkerVersion(env, body.userId));
              break;
            case 'deploy.revert': {
              const currentWorker = await tenantWorkerVersion(env, body.userId);
              if (currentWorker.sha !== null) {
                const outcome = await platformCall(await platformConfig(env, body.userId), 'revert', { to: 'channel' });
                if (outcome.status === 'failed') throw new Error(outcome.error ?? 'Platform revert failed');
              }
              await releases.revert();
              value = await releases.status(await tenantWorkerVersion(env, body.userId));
              break;
            }
            case 'deploy.machineApplied': {
              const input = machineAppliedInputSchema.parse(body.payload);
              value = await releases.machineApplied(body.machineId, input);
              if (value === null) throw new ReleaseNotFoundError(input.sha);
              break;
            }
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
        if (body.operation === 'devices.revoke') {
          const result = await credentialVault(env, body.userId).revokeDeviceGrant(String(body.payload.deviceId ?? ''));
          return Response.json(result, { status: result.status === 'ok' ? 200 : 404, headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('mcp.')) {
          const vault = credentialVault(env, body.userId);
          const connections = userMcpConnections(env, body.userId);
          const accountApiKey = await vault.getProviderSecret('composio');
          const composio = new ComposioPluginGateway(env, accountApiKey);
          let value: unknown;
          switch (body.operation) {
            case 'mcp.connections.list':
              value = await connections.list(body.userId);
              break;
            case 'mcp.connections.create':
              value = await connections.create(
                body.userId,
                body.payload.connection as Parameters<UserMcpConnectionsDO['create']>[1],
              );
              break;
            case 'mcp.connections.update':
              value = await connections.update(
                body.userId,
                String(body.payload.connectionId ?? ''),
                Number(body.payload.expectedRevision ?? -1),
                body.payload.connection as Parameters<UserMcpConnectionsDO['update']>[3],
              );
              break;
            case 'mcp.connections.delete': {
              const connectionId = String(body.payload.connectionId ?? '');
              const current = await connections.get(body.userId, connectionId);
              if (current?.transport.type === 'composio') {
                throw new McpConnectionValidationError('connectionId', 'Disconnect Composio plugins through the dedicated plugin operation');
              }
              value = {
                connectionId,
                deleted: await connections.delete(
                  body.userId,
                  connectionId,
                  Number(body.payload.expectedRevision ?? -1),
                ),
              };
              break;
            }
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
            case 'mcp.composio.setup.get': {
              const metadata = await vault.providerSecretMetadata('composio');
              value = metadata.configured
                ? { configured: true, source: 'account', updatedAt: metadata.updatedAt }
                : { configured: Boolean(env.COMPOSIO_API_KEY?.trim()), source: env.COMPOSIO_API_KEY?.trim() ? 'platform' : null, updatedAt: null };
              break;
            }
            case 'mcp.composio.setup.set': {
              const apiKey = String(body.payload.apiKey ?? '').trim();
              await new ComposioPluginGateway(env, apiKey).catalog();
              const metadata = await vault.putProviderSecret('composio', apiKey);
              value = { configured: true, source: 'account', updatedAt: metadata.updatedAt };
              break;
            }
            case 'mcp.composio.setup.delete': {
              await vault.deleteProviderSecret('composio');
              const platformConfigured = Boolean(env.COMPOSIO_API_KEY?.trim());
              value = { configured: platformConfigured, source: platformConfigured ? 'platform' : null, updatedAt: null };
              break;
            }
            case 'mcp.composio.catalog':
              value = await composio.catalog();
              break;
            case 'mcp.composio.authorize': {
              const toolkit = String(body.payload.toolkit ?? '').trim().toLowerCase();
              const label = String(body.payload.label ?? '').trim();
              if (!toolkit || !label) throw new McpConnectionValidationError('toolkit', 'Choose a Composio plugin and provide an account label');
              const state = crypto.randomUUID();
              const signature = await signComposioState(env, body.userId, state, accountApiKey);
              const callback = new URL('/v1/mcp/composio/callback', url.origin);
              callback.searchParams.set('principal', body.userId);
              callback.searchParams.set('gitspace_state', state);
              callback.searchParams.set('signature', signature);
              const authorization = await composio.authorize(body.userId, toolkit, callback.toString());
              const connectionId = `composio-${toolkit.slice(0, 80)}-${crypto.randomUUID().slice(0, 8)}`;
              const connection = await connections.createComposio(body.userId, {
                id: connectionId,
                label,
                toolkit,
                connectedAccountId: authorization.connectedAccountId,
                state,
                expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
              });
              value = { connection, redirectUrl: authorization.redirectUrl };
              break;
            }
            case 'mcp.composio.refresh': {
              const connectionId = String(body.payload.connectionId ?? '');
              const current = await connections.get(body.userId, connectionId);
              if (!current) throw new McpConnectionNotFoundError(connectionId);
              if (current.transport.type !== 'composio') throw new McpConnectionValidationError('connectionId', 'Connection is not a Composio plugin');
              const status = await composio.status(current.transport.connectedAccountId);
              value = await connections.updateComposioStatus(body.userId, connectionId, status.status, status.message);
              break;
            }
            case 'mcp.composio.tools': {
              const connectionId = String(body.payload.connectionId ?? '');
              const current = await connections.get(body.userId, connectionId);
              if (!current) throw new McpConnectionNotFoundError(connectionId);
              if (current.transport.type !== 'composio') throw new McpConnectionValidationError('connectionId', 'Connection is not a Composio plugin');
              value = await composio.tools(current.transport.toolkit);
              break;
            }
            case 'mcp.composio.updateTools': {
              const connectionId = String(body.payload.connectionId ?? '');
              const current = await connections.get(body.userId, connectionId);
              if (!current) throw new McpConnectionNotFoundError(connectionId);
              if (current.transport.type !== 'composio') throw new McpConnectionValidationError('connectionId', 'Connection is not a Composio plugin');
              const requested = Array.isArray(body.payload.allowedTools) ? body.payload.allowedTools.map(String) : [];
              const available = new Set((await composio.tools(current.transport.toolkit)).map((tool) => tool.slug));
              const invalid = requested.find((tool) => !available.has(tool));
              if (invalid) throw new McpConnectionValidationError('allowedTools', `Composio tool ${invalid} is unavailable`);
              value = await connections.updateComposioTools(body.userId, connectionId, Number(body.payload.expectedRevision ?? -1), requested);
              break;
            }
            case 'mcp.composio.disconnect': {
              const connectionId = String(body.payload.connectionId ?? '');
              const expectedRevision = Number(body.payload.expectedRevision ?? -1);
              const current = await connections.get(body.userId, connectionId);
              if (!current) throw new McpConnectionNotFoundError(connectionId);
              if (current.revision !== expectedRevision) throw new McpConnectionRevisionConflictError(connectionId, expectedRevision, current.revision);
              if (current.transport.type !== 'composio') throw new McpConnectionValidationError('connectionId', 'Connection is not a Composio plugin');
              await composio.disconnect(current.transport.connectedAccountId);
              value = { connectionId, deleted: await connections.delete(body.userId, connectionId, expectedRevision) };
              break;
            }
            case 'mcp.composio.materialize': {
              const projectId = String(body.payload.projectId ?? '');
              const workspaceId = typeof body.payload.workspaceId === 'string' ? body.payload.workspaceId : null;
              const connectionId = String(body.payload.connectionId ?? '');
              const grant = await projectAuthority(env, body.userId, projectId).getMcpGrant(connectionId);
              if (!grant?.enabled || (workspaceId === null ? !grant.projectSpaceEnabled : !grant.workspacesEnabled)) {
                throw new McpConnectionValidationError('grant', 'Composio plugin is not granted to this project session');
              }
              const current = await connections.get(body.userId, connectionId);
              if (!current) throw new McpConnectionNotFoundError(connectionId);
              if (!current.enabled || current.status !== 'ready' || current.transport.type !== 'composio') {
                throw new McpConnectionValidationError('connectionId', 'Composio plugin is not ready');
              }
              value = await composio.materialize(body.userId, current.transport);
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
            case 'mcp.audit.list':
              value = await connections.listAudit(
                body.userId,
                typeof body.payload.after === 'string' ? body.payload.after : null,
                Number(body.payload.limit ?? 200),
              );
              break;
            default:
              throw new Error('Unsupported MCP control operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('secrets.')) {
          const secrets = projectSecrets(env, body.userId);
          let value: unknown;
          switch (body.operation) {
            case 'secrets.list':
              value = await secrets.list(String(body.payload.projectId ?? ''));
              break;
            case 'secrets.put':
              value = await secrets.put({
                projectId: String(body.payload.projectId ?? ''),
                name: String(body.payload.name ?? ''),
                value: String(body.payload.value ?? ''),
                updatedBy: body.machineId,
              });
              break;
            case 'secrets.delete':
              value = { deleted: await secrets.delete(String(body.payload.projectId ?? ''), String(body.payload.name ?? '')) };
              break;
            case 'secrets.materialize':
              value = await secrets.materialize(
                String(body.payload.projectId ?? ''),
                Array.isArray(body.payload.names) ? body.payload.names.map(String) : [],
              );
              break;
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
        }
        if (body.operation.startsWith('skills.')) {
          const skills = userSkills(env, body.userId);
          const value = body.operation === 'skills.list'
            ? await skills.list()
            : await skills.update(skillUpdateSchema.parse(body.payload));
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('crons.')) {
          const projectId = String(body.payload.projectId ?? '');
          if (!projectId) throw new Error('Project id is required');
          const crons = projectCrons(env, body.userId, projectId);
          let value: unknown;
          switch (body.operation) {
            case 'crons.list':
              value = await crons.list(projectId);
              break;
            case 'crons.create':
              value = await crons.create({ ...body.payload, projectId } as Parameters<ProjectCronsDO['create']>[0]);
              break;
            case 'crons.update':
              value = await crons.update({ ...body.payload, projectId } as Parameters<ProjectCronsDO['update']>[0]);
              break;
            case 'crons.delete':
              value = await crons.delete({ ...body.payload, projectId } as Parameters<ProjectCronsDO['delete']>[0]);
              break;
            case 'crons.runNow':
              value = await crons.runNow({ ...body.payload, projectId } as Parameters<ProjectCronsDO['runNow']>[0]);
              break;
            case 'crons.history':
              value = await crons.history({ ...body.payload, projectId } as Parameters<ProjectCronsDO['history']>[0]);
              break;
            case 'crons.processDue':
              value = await crons.processDue({ projectId });
              break;
            case 'crons.claimNext':
              value = await crons.claimNext({
                projectId,
                claimedBy: body.machineId,
                ...(Array.isArray(body.payload.heldSpaceIds) ? { heldSpaceIds: body.payload.heldSpaceIds.filter((id): id is string => typeof id === 'string') } : {}),
              });
              break;
            case 'crons.completeRun':
              value = await crons.completeRun({ ...body.payload, projectId } as Parameters<ProjectCronsDO['completeRun']>[0]);
              break;
            default:
              throw new Error('Unsupported project cron operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('inspector.')) {
          const projectId = String(body.payload.projectId ?? '');
          const spaceId = String(body.payload.spaceId ?? '');
          if (!projectId || !spaceId) throw new Error('Project and space ids are required');
          const identity = { projectId, spaceId };
          const context = spaceContext(env, body.userId, projectId, spaceId);
          await context.bootstrap(identity);
          const candidate = body.payload.input;
          const input = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            ? { ...candidate, ...identity }
            : identity;
          const reviewContext = body.payload.context && typeof body.payload.context === 'object' && !Array.isArray(body.payload.context)
            ? body.payload.context
            : undefined;
          let value: unknown;
          switch (body.operation) {
            case 'inspector.bootstrap': value = identity; break;
            case 'inspector.getOverview': value = await context.getOverview(identity, reviewContext as Parameters<SpaceContextDO['getOverview']>[1]); break;
            case 'inspector.getGoal': value = await context.getGoal(identity); break;
            case 'inspector.putGoal': value = await context.putGoal(input as Parameters<SpaceContextDO['putGoal']>[0]); break;
            case 'inspector.attachRequirementEvidence': value = await context.attachRequirementEvidence(input as Parameters<SpaceContextDO['attachRequirementEvidence']>[0]); break;
            case 'inspector.getWorkflow': value = await context.getWorkflow(identity); break;
            case 'inspector.putWorkflow': value = await context.putWorkflow(input as Parameters<SpaceContextDO['putWorkflow']>[0]); break;
            case 'inspector.waiveWorkflowGate': value = await context.waiveWorkflowGate(input as Parameters<SpaceContextDO['waiveWorkflowGate']>[0]); break;
            case 'inspector.getRubric': value = await context.getRubric(identity); break;
            case 'inspector.putRubric': value = await context.putRubric(input as Parameters<SpaceContextDO['putRubric']>[0]); break;
            case 'inspector.appendRubricJudgment': value = await context.appendRubricJudgment(input as Parameters<SpaceContextDO['appendRubricJudgment']>[0]); break;
            case 'inspector.listJournal': value = await context.listJournal(identity); break;
            case 'inspector.startJournalPhase': value = await context.startJournalPhase(input as Parameters<SpaceContextDO['startJournalPhase']>[0]); break;
            case 'inspector.endJournalPhase': value = await context.endJournalPhase(input as Parameters<SpaceContextDO['endJournalPhase']>[0]); break;
            case 'inspector.appendJournalEntry': value = await context.appendJournalEntry(input as Parameters<SpaceContextDO['appendJournalEntry']>[0]); break;
            case 'inspector.getChangeGuide': value = await context.getChangeGuide(identity); break;
            case 'inspector.putChangeGuide': value = await context.putChangeGuide(input as Parameters<SpaceContextDO['putChangeGuide']>[0]); break;
            case 'inspector.markGuideSectionRead': value = await context.markGuideSectionRead(input as Parameters<SpaceContextDO['markGuideSectionRead']>[0]); break;
            case 'inspector.setGuideApproval': value = await context.setGuideApproval(input as Parameters<SpaceContextDO['setGuideApproval']>[0]); break;
            case 'inspector.listReviewThreads': value = await context.listReviewThreads(identity, reviewContext as Parameters<SpaceContextDO['listReviewThreads']>[1]); break;
            case 'inspector.createReviewThread': value = await context.createReviewThread(input as Parameters<SpaceContextDO['createReviewThread']>[0], reviewContext as Parameters<SpaceContextDO['createReviewThread']>[1]); break;
            case 'inspector.appendReviewMessage': value = await context.appendReviewMessage(input as Parameters<SpaceContextDO['appendReviewMessage']>[0], reviewContext as Parameters<SpaceContextDO['appendReviewMessage']>[1]); break;
            case 'inspector.resolveReviewThread': value = await context.resolveReviewThread(input as Parameters<SpaceContextDO['resolveReviewThread']>[0], reviewContext as Parameters<SpaceContextDO['resolveReviewThread']>[1]); break;
            default: throw new Error('Unsupported Inspector operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('settings.')) {
          const settingsNamespace = env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>;
          const settings = settingsNamespace.get(settingsNamespace.idFromName(body.userId));
          let value: unknown;
          switch (body.operation) {
            case 'settings.get':
              value = await settings.get(body.machineId);
              break;
            case 'settings.update': {
              const input = userSettingsUpdateSchema.parse(body.payload);
              const current = await settings.get(body.machineId);
              if (input.profile.handle !== current.profile.handle) throw new Error('Handle changes require settings.handle.reserve');
              const result = await settings.update(body.machineId, input);
              if (result.status === 'conflict') throw new SettingsRevisionConflict(result.resource, result.expected, result.actual);
              value = result.value;
              break;
            }
            case 'settings.git.get':
              value = await settings.getGitIdentity();
              break;
            case 'settings.git.update': {
              const result = await settings.updateGitIdentity(body.machineId, gitIdentityUpdateSchema.parse(body.payload));
              if (result.status === 'conflict') throw new SettingsRevisionConflict(result.resource, result.expected, result.actual);
              value = result.value;
              break;
            }
            case 'settings.omp.get':
              value = await settings.getOmp();
              break;
            case 'settings.omp.update': {
              const result = await settings.updateOmp(body.machineId, ompConfigUpdateSchema.parse(body.payload));
              if (result.status === 'conflict') throw new SettingsRevisionConflict(result.resource, result.expected, result.actual);
              value = result.value;
              break;
            }
            case 'settings.handle.reserve': {
              const handle = String(body.payload.handle ?? '').trim().toLowerCase();
              if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(handle)) throw new Error('Handle must be 1 to 30 lowercase letters, numbers, or hyphens');
              const current = await settings.get(body.machineId);
              if (current.profile.handle && current.profile.handle !== handle) throw new Error('GitSpace handles are permanent');
              const handles = env.USER_HANDLES as DurableObjectNamespace<HandleRegistryDO>;
              const nextHandle = handles.get(handles.idFromName(handle));
              const claim = await nextHandle.claim(body.userId);
              if (!claim.claimed) throw new HandleUnavailable(handle);
              const result = await settings.setHandle(body.machineId, Number(body.payload.expectedRevision ?? -1), handle);
              if (result.status === 'conflict') {
                if (claim.created) await nextHandle.release(body.userId);
                throw new SettingsRevisionConflict(result.resource, result.expected, result.actual);
              }
              value = result.value;
              break;
            }
            default:
              throw new Error('Unsupported settings operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (body.operation.startsWith('projects.')) {
          const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
          const projects = namespace.get(namespace.idFromName(body.userId));
          let value: unknown;
          switch (body.operation) {
            case 'projects.list':
              await ensureAccountGitSpaceProject(env, body.userId);
              value = await projects.list(
                body.payload.lifecycle === 'active' || body.payload.lifecycle === 'archived'
                  ? body.payload.lifecycle
                  : undefined,
              );
              break;
            case 'projects.put':
              value = await projects.put(body.payload.project as Parameters<UserProjectIndexDO['put']>[0]);
              break;
            case 'projects.remove':
              value = await projects.remove(String(body.payload.projectId ?? ''));
              break;
            case 'projects.workspaces.locate':
              value = await projects.locateWorkspace(String(body.payload.workspaceId ?? ''));
              break;
            default:
              throw new Error('Unsupported projects operation');
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
            case 'project.bootstrap': {
              const project = await authority.bootstrap({
                id: projectId,
                name: String(body.payload.name ?? ''),
                repositoryReference: typeof body.payload.repositoryReference === 'string'
                  ? body.payload.repositoryReference
                  : null,
                baseBranch: String(body.payload.baseBranch ?? 'main'),
                createdBy: body.machineId,
              });
              const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
              value = await namespace.get(namespace.idFromName(body.userId)).put(project);
              break;
            }
            case 'project.delete': {
              const project = await authority.deleteProject(Number(body.payload.expectedRevision ?? -1));
              const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
              await namespace.get(namespace.idFromName(body.userId)).remove(projectId);
              value = project;
              break;
            }
            case 'project.get':
              value = await authority.getProject();
              break;
            case 'project.setLifecycle': {
              const project = await authority.setProjectLifecycle(
                Number(body.payload.expectedRevision ?? -1),
                body.payload.lifecycle as Parameters<ProjectAuthorityDO['setProjectLifecycle']>[1],
              );
              const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
              value = await namespace.get(namespace.idFromName(body.userId)).put(project);
              break;
            }
            case 'project.activateSource': {
              const project = await authority.activateSourceProject(Number(body.payload.expectedRevision ?? -1), String(body.payload.baseBranch ?? ''));
              const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
              value = await namespace.get(namespace.idFromName(body.userId)).put(project);
              break;
            }
            case 'project.workspaces.list':
              value = await authority.listWorkspaces();
              break;
            case 'project.workspaces.put': {
              const workspace = await authority.putWorkspace(
                body.payload.workspace as Parameters<ProjectAuthorityDO['putWorkspace']>[0],
              );
              const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
              await namespace.get(namespace.idFromName(body.userId)).putWorkspaceLocation(workspace.id, projectId);
              value = workspace;
              break;
            }
            case 'project.workspaces.remove': {
              const workspaceId = String(body.payload.workspaceId ?? '');
              value = await authority.removeWorkspace(workspaceId, Number(body.payload.expectedRevision ?? -1));
              if (value) {
                const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
                await namespace.get(namespace.idFromName(body.userId)).removeWorkspaceLocation(workspaceId);
              }
              break;
            }
            case 'project.mcp.grants.list':
              value = await authority.listMcpGrants();
              break;
            case 'project.mcp.grants.put': {
              const connectionId = String(body.payload.connectionId ?? '');
              const owned = await userMcpConnections(env, body.userId).get(body.userId, connectionId);
              if (!owned) throw new McpConnectionNotFoundError(connectionId);
              value = await authority.putMcpGrant({
                connectionId,
                enabled: body.payload.enabled === true,
                projectSpaceEnabled: body.payload.projectSpaceEnabled !== false,
                workspacesEnabled: body.payload.workspacesEnabled !== false,
                expectedRevision: Number(body.payload.expectedRevision ?? -1),
                createdBy: body.machineId,
              });
              break;
            }
            case 'project.mcp.grants.delete':
              value = {
                projectId,
                connectionId: String(body.payload.connectionId ?? ''),
                deleted: await authority.deleteMcpGrant(
                  String(body.payload.connectionId ?? ''),
                  Number(body.payload.expectedRevision ?? -1),
                ),
              };
              break;
            case 'project.operations.create':
              value = await authority.createOperation(
                body.payload.operation as Parameters<ProjectAuthorityDO['createOperation']>[0],
              );
              break;
            case 'project.operations.get':
              value = await authority.getOperation(String(body.payload.operationId ?? ''));
              break;
            case 'project.operations.list':
              value = await authority.listOperations();
              break;
            case 'project.operations.update':
              value = await authority.updateOperation(
                body.payload.operation as Parameters<ProjectAuthorityDO['updateOperation']>[0],
              );
              break;
            case 'project.sessions.get':
              value = await authority.getCanonicalSession(String(body.payload.sessionId ?? ''));
              break;
            case 'project.sessions.list':
              value = await authority.listCanonicalSessions();
              break;
            case 'project.sessions.put':
              value = await authority.putCanonicalSession(
                body.payload.session as Parameters<ProjectAuthorityDO['putCanonicalSession']>[0],
              );
              break;
            case 'project.artifacts.get':
              value = await authority.getArtifactScope(String(body.payload.scopeId ?? ''));
              break;
            case 'project.artifacts.list':
              value = await authority.listArtifactScopes();
              break;
            case 'project.artifacts.put':
              value = await authority.putArtifactScope(
                body.payload.scope as Parameters<ProjectAuthorityDO['putArtifactScope']>[0],
              );
              break;
            case 'project.promotions.get':
              value = await authority.getArtifactPromotion(String(body.payload.promotionId ?? ''));
              break;
            case 'project.promotions.list':
              value = await authority.listArtifactPromotions();
              break;
            case 'project.promotions.put':
              value = await authority.putArtifactPromotion(
                body.payload.promotion as Parameters<ProjectAuthorityDO['putArtifactPromotion']>[0],
              );
              break;
            case 'project.routes.list':
              value = await authority.listHostedRoutes();
              break;
            case 'project.routes.lease': {
              const route = await authority.leaseHostedRoute(
                body.payload.route as Parameters<ProjectAuthorityDO['leaseHostedRoute']>[0],
              );
              await (env.HOSTED_ROUTES as DurableObjectNamespace<HostedRouteRegistryDO>).getByName(route.hostname).lease(body.userId, route);
              value = route;
              break;
            }
            case 'project.routes.release': {
              const hostname = String(body.payload.hostname ?? '');
              const released = await authority.releaseHostedRoute(hostname, body.machineId);
              if (released) {
                await (env.HOSTED_ROUTES as DurableObjectNamespace<HostedRouteRegistryDO>).getByName(hostname).release(body.userId, body.machineId);
              }
              value = released;
              break;
            }
            case 'project.events.append':
              value = await authority.appendEvent(
                body.payload.event as Parameters<ProjectAuthorityDO['appendEvent']>[0],
              );
              break;
            case 'project.events.list':
              value = await authority.listEvents(Number(body.payload.afterOffset ?? 0));
              break;
            case 'project.events.latest':
              value = await authority.latestEventOffset();
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
            case 'catalog.space.put': value = await catalog.putSpace(catalogSpacePayload(body.payload)); break;
            case 'catalog.space.get': value = await catalog.getSpace(String(body.payload.spaceId ?? '')); break;
            case 'catalog.space.list': value = await catalog.listSpaces(); break;
            case 'catalog.machine.put': value = await catalog.putMachine(catalogMachinePayload(body.payload)); break;
            case 'catalog.machine.list': value = rollout ? await catalog.listMachines() : await reconcileFleetMachines(env, body.userId, catalog); break;
            case 'catalog.sandbox.create': value = await provisionManagedSandbox(env, body.userId, url.origin); break;
            case 'catalog.machine.sleep':
            case 'catalog.machine.resume':
            case 'catalog.machine.destroy':
              value = await controlFleetMachine(env, body.userId, String(body.payload.machineId ?? ''), body.operation.slice('catalog.machine.'.length) as 'sleep' | 'resume' | 'destroy');
              break;
            default: throw new Error('Unsupported catalog operation');
          }
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
        }
        if (!body.operation.startsWith('space.')) {
          const storageNamespace = env.USER_STORAGE as DurableObjectNamespace<UserStorageDO>;
          const storage = storageNamespace.get(storageNamespace.idFromName(body.userId));
          const client = new CloudflareR2PlatformClient({
            accountId: env.CF_ACCOUNT_ID,
            apiToken: env.CF_API_TOKEN,
            parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
          });
          if (body.operation === 'storage.provision') {
            const gitBucketName = String(body.payload.gitBucketName ?? '');
            await storage.beginProvisioning({ userId: body.userId, gitBucketName });
            try {
              await client.createBucket({ bucketName: gitBucketName });
              const value = await storage.markReady({ userId: body.userId, gitBucketName });
              return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
            } catch (error) {
              await storage.markFailed({ userId: body.userId, gitBucketName, message: error instanceof Error ? error.message : String(error) });
              throw error;
            }
          }
          const record = await storage.requireReady(body.userId);
          if (body.operation === 'storage.binding') {
            return Response.json({ status: 'ok', value: { bucket: record.gitBucketName, endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: 'auto' } }, { headers: { 'cache-control': 'no-store' } });
          }
          const prefixes = Array.isArray(body.payload.prefixes) ? body.payload.prefixes.filter((value): value is string => typeof value === 'string') : [];
          const value = await client.mintTemporaryCredentials({
            bucketName: record.gitBucketName,
            prefixes,
            ttlSeconds: Number(body.payload.ttlSeconds ?? 3_600),
          });
          return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
        }
        const spaceId = typeof body.payload.spaceId === 'string' ? body.payload.spaceId : '';
        if (!spaceId) return Response.json({ status: 'error', error: { code: 'INVALID_SPACE', message: 'Space id is required' } }, { status: 400 });
        const authorityNamespace = env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>;
        const authority = authorityNamespace.get(authorityNamespace.idFromName(`${body.userId}:${spaceId}`));
        const common = { ...body.payload, machineId: body.machineId, projectId: String(body.payload.projectId ?? ''), spaceId };
        let value: unknown;
        switch (body.operation) {
          case 'space.bootstrap': value = await authority.bootstrap(common as Parameters<SpaceAuthorityDO['bootstrap']>[0]); break;
          case 'space.beginClose': value = await authority.beginClose(common as Parameters<SpaceAuthorityDO['beginClose']>[0]); break;
          case 'space.commitClosed': value = await authority.commitClosed(common as Parameters<SpaceAuthorityDO['commitClosed']>[0]); break;
          case 'space.abortClose': value = await authority.abortClose(common as Parameters<SpaceAuthorityDO['abortClose']>[0]); break;
          case 'space.beginOpen': value = await authority.beginOpen(common as Parameters<SpaceAuthorityDO['beginOpen']>[0]); break;
          case 'space.commitOpen': value = await authority.commitOpen(common as Parameters<SpaceAuthorityDO['commitOpen']>[0]); break;
          case 'space.failOpen': value = await authority.failOpen(common as Parameters<SpaceAuthorityDO['failOpen']>[0]); break;
          case 'space.get': value = await authority.get(); break;
          default: throw new Error('Unsupported control operation');
        }
        return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof ProjectCronRevisionConflictError) {
          return Response.json({ status: 'error', error: { code: 'CRON_REVISION_CONFLICT', message: error.message, cronId: error.cronId, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof ProjectCronAlreadyRunningError) {
          return Response.json({ status: 'error', error: { code: 'CRON_ALREADY_RUNNING', message: error.message, cronId: error.cronId, runId: error.runId, state: error.state } }, { status: 409 });
        }
        if (error instanceof ProjectCronRunNotCompletableError) {
          return Response.json({ status: 'error', error: { code: 'CRON_RUN_NOT_COMPLETABLE', message: error.message, runId: error.runId } }, { status: 409 });
        }
        if (error instanceof ProjectCronNotFoundError) {
          return Response.json({ status: 'error', error: { code: 'CRON_NOT_FOUND', message: error.message, projectId: error.projectId, cronId: error.cronId } }, { status: 404 });
        }
        if (error instanceof ProjectCronValidationError) {
          return Response.json({ status: 'error', error: { code: 'CRON_INVALID', message: error.message, field: error.field } }, { status: 400 });
        }
        if (error instanceof InspectorConflictError) {
          return Response.json({ status: 'error', error: { code: 'INSPECTOR_CONFLICT', message: error.message, resource: error.resource, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof InspectorStateError) {
          return Response.json({ status: 'error', error: { code: 'INSPECTOR_STATE', message: error.message, resource: 'inspector' } }, { status: 409 });
        }
        if (error instanceof SkillRevisionConflict) {
          return Response.json({ status: 'error', error: { code: 'SKILL_CONFLICT', message: error.message, skillId: error.skillId, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof SettingsRevisionConflict) {
          return Response.json({ status: 'error', error: { code: 'SETTINGS_CONFLICT', message: error.message, resource: error.resource, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof HandleUnavailable) {
          return Response.json({ status: 'error', error: { code: 'HANDLE_UNAVAILABLE', message: error.message } }, { status: 409 });
        }
        if (error instanceof McpConnectionRevisionConflictError) {
          return Response.json({ status: 'error', error: { code: 'MCP_CONNECTION_CONFLICT', message: error.message, resource: `connection:${error.connectionId}`, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof ProjectMcpGrantRevisionConflictError) {
          return Response.json({ status: 'error', error: { code: 'MCP_GRANT_CONFLICT', message: error.message, resource: `grant:${error.connectionId}`, expected: error.expected, actual: error.actual } }, { status: 409 });
        }
        if (error instanceof McpConnectionNotFoundError) {
          return Response.json({ status: 'error', error: { code: 'MCP_CONNECTION_NOT_FOUND', message: error.message, resource: 'connection', id: error.connectionId } }, { status: 404 });
        }
        if (error instanceof ProjectMcpGrantNotFoundError) {
          return Response.json({ status: 'error', error: { code: 'MCP_GRANT_NOT_FOUND', message: error.message, resource: 'grant', id: error.connectionId } }, { status: 404 });
        }
        if (error instanceof ReleaseNotFoundError) {
          return Response.json({ status: 'error', error: { code: 'RELEASE_NOT_FOUND', message: error.message, sha: error.sha } }, { status: 404 });
        }
        if (error instanceof McpConnectionValidationError) {
          return Response.json({ status: 'error', error: { code: 'MCP_INVALID', message: error.message, field: error.field } }, { status: 400 });
        }
        return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Control request is invalid' } }, { status: 400 });
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
      const status = result.status === 'ok' ? 200 : result.error.code === 'REFRESH_BUSY' ? 409 : result.error.code.includes('UNAUTHORIZED') ? 401 : 400;
      return Response.json(result, { status, headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: 'Credential request is invalid' } }, { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
