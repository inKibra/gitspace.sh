import { DurableObject } from 'cloudflare:workers';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import type { CredentialRefreshResponse, SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';
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
} from '@gitspace/protocol';
import {
  platformDeployResponseSchema,
  stageReleaseInputSchema,
  WORKER_VERSION_HEADER,
  type PlatformDeployRequest,
  type ReleaseStatus,
} from '@gitspace/protocol/deployment';
import { refreshCredential, ProviderRefreshError, type StoredOAuthCredential } from './providers.js';
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
export { TenantReleasesDO } from './tenant-releases.js';
import type { TenantReleasesDO } from './tenant-releases.js';
import { SpaceAuthorityDO } from './space-authority.js';
import { CloudflareR2PlatformClient, UserStorageDO } from './storage.js';
import { FleetCatalogDO, type FleetMachineDefinition, type PortableSpaceDefinition } from './fleet-catalog.js';
import { HandleRegistryDO, HandleUnavailable, SettingsRevisionConflict, UserSettingsDO } from './user-settings.js';
import { controlCloudflareSandboxMachine, createCloudflareSandboxMachine } from './sandbox-provisioner.js';
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
  ReleaseNotFoundError,
  TENANT_OWNER_INSTANCE,
  WORKER_VERSION,
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
const OMP_USAGE_CACHE_MS = 30_000;

export type CredentialVaultResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: { code: string; message: string; retryAfterMs?: number } };

interface DeviceRow extends Record<string, SqlStorageValue> {
  signing_public_key: string;
  exchange_public_key: string;
  capabilities_json: string;
  generation: number;
}

interface CredentialRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: StoredOAuthCredential['provider'];
  sealed_json: string;
  revision: number;
  expires_at: number;
  state: string;
}

interface OmpCredentialRow extends CredentialRow {
  row_id: number;
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

async function sealVaultCredential(credential: StoredOAuthCredential, vaultKey: Uint8Array, id: string, revision: number): Promise<string> {
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

async function openVaultCredential(row: CredentialRow, vaultKey: Uint8Array): Promise<StoredOAuthCredential> {
  const sealed = credentialProtocolBase64.decode(row.sealed_json);
  if (sealed.byteLength <= 12) throw new Error('Stored credential is malformed');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: ownedBuffer(sealed.subarray(0, 12)),
    additionalData: ownedBuffer(new TextEncoder().encode(`${row.id}\n${row.revision}`)),
  }, await vaultCryptoKey(vaultKey), ownedBuffer(sealed.subarray(12)));
  return JSON.parse(new TextDecoder().decode(plaintext)) as StoredOAuthCredential;
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
        CREATE TABLE IF NOT EXISTS oauth_credentials (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          sealed_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'refresh-uncertain', 'disabled')),
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
      `);
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

  registerDevice(input: SignedCredentialAuthorityGrant): CredentialVaultResult<{ machineId: string; generation: number }> {
    const config = this.config();
    if (!config) return publicError('VAULT_UNCONFIGURED', 'Vault is not configured');
    let grant;
    try {
      grant = verifyCredentialAuthorityGrant(input, credentialProtocolBase64.decode(config.root_public_key));
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
    return { status: 'ok', value: { machineId: grant.machineId, generation: grant.generation } };
  }
  registerManagedDevice(input: {
    userId: string;
    machineId: string;
    signingPublicKey: string;
    exchangePublicKey: string;
    capabilities: Array<'storage.access' | 'space.control'>;
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
    return { status: 'ok', value: { machineId: input.machineId, generation } };
  }
  rootPublicKey(): string | null {
    return this.config()?.root_public_key ?? null;
  }
  removeManagedDevice(machineId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM credential_devices WHERE machine_id = ?', machineId);
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

  async putCredential(input: { id: string; credential: StoredOAuthCredential }): Promise<CredentialVaultResult<{ id: string; revision: number }>> {
    const config = this.config();
    if (!config || !input.id || !input.credential.refresh || !input.credential.access || !SUPPORTED_PROVIDERS.has(input.credential.provider)) {
      return publicError('INVALID_CREDENTIAL', 'Credential input is invalid');
    }
    const revision = (this.credential(input.id)?.revision ?? 0) + 1;
    const sealed = await sealVaultCredential(input.credential, credentialProtocolBase64.decode(config.vault_key), input.id, revision);
    this.ctx.storage.sql.exec(`
      INSERT INTO oauth_credentials(id, provider, sealed_json, revision, expires_at, state, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        sealed_json = excluded.sealed_json,
        revision = excluded.revision,
        expires_at = excluded.expires_at,
        state = 'active',
        updated_at = excluded.updated_at
    `, input.id, input.credential.provider, sealed, revision, input.credential.expires, new Date().toISOString());
    this.usageCache = undefined;
    return { status: 'ok', value: { id: input.id, revision } };
  }

  async ompUsage(): Promise<OmpUsageResponse> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const now = Date.now();
    if (this.usageCache && this.usageCache.expiresAt > now) return this.usageCache.value;
    const vaultKey = credentialProtocolBase64.decode(config.vault_key);
    const rows = this.ctx.storage.sql.exec<CredentialRow>(
      "SELECT id, provider, sealed_json, revision, expires_at, state FROM oauth_credentials WHERE state = 'active' ORDER BY rowid",
    ).toArray();
    const credentials = await Promise.all(rows.map((row) => openVaultCredential(row, vaultKey)));
    const value = { generatedAt: now, reports: await fetchUsageReports(credentials) };
    this.usageCache = { expiresAt: now + OMP_USAGE_CACHE_MS, value };
    return value;
  }


  async ompSnapshot(): Promise<SnapshotResponse> {
    const config = this.config();
    if (!config) throw new Error('Vault is not configured');
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec<OmpCredentialRow>(
      "SELECT rowid AS row_id, id, provider, sealed_json, revision, expires_at, state, updated_at FROM oauth_credentials WHERE state = 'active' ORDER BY rowid",
    ).toArray();
    const credentials = await Promise.all(rows.map(async (row) => {
      const credential = await openVaultCredential(row, credentialProtocolBase64.decode(config.vault_key));
      const identityKey = credential.accountId ?? credential.email ?? credential.projectId ?? null;
      return {
        id: row.row_id,
        provider: credential.provider,
        identityKey,
        rotatesInMs: Math.max(0, credential.expires - now),
        credential: {
          type: 'oauth' as const,
          refresh: REMOTE_REFRESH_SENTINEL,
          access: credential.access,
          expires: credential.expires,
          ...(credential.accountId ? { accountId: credential.accountId } : {}),
          ...(credential.email ? { email: credential.email } : {}),
          ...(credential.orgId ? { orgId: credential.orgId } : {}),
          ...(credential.projectId ? { projectId: credential.projectId } : {}),
        },
      };
    }));
    const generation = rows.reduce((current, row) => Math.max(current, Date.parse(row.updated_at)), 0);
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
    const refreshed = await refreshCredential(await openVaultCredential(row, vaultKey));
    const revision = row.revision + 1;
    const sealed = await sealVaultCredential(refreshed, vaultKey, row.id, revision);
    const changed = this.ctx.storage.sql.exec(
      'UPDATE oauth_credentials SET sealed_json = ?, revision = ?, expires_at = ?, updated_at = ? WHERE rowid = ? AND revision = ?',
      sealed,
      revision,
      refreshed.expires,
      new Date().toISOString(),
      rowId,
      row.revision,
    ).rowsWritten;
    if (changed !== 1) throw new Error('Credential changed during refresh');
    return {
      entry: {
        id: rowId,
        provider: refreshed.provider,
        identityKey: refreshed.accountId ?? refreshed.email ?? refreshed.projectId ?? null,
        credential: {
          type: 'oauth',
          refresh: REMOTE_REFRESH_SENTINEL,
          access: refreshed.access,
          expires: refreshed.expires,
          ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
          ...(refreshed.email ? { email: refreshed.email } : {}),
          ...(refreshed.orgId ? { orgId: refreshed.orgId } : {}),
          ...(refreshed.projectId ? { projectId: refreshed.projectId } : {}),
        },
      },
    };
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
      this.ctx.storage.sql.exec('DELETE FROM request_nonces WHERE used_at < ?', Date.now() - REQUEST_MAX_SKEW_MS);
      try {
        this.ctx.storage.sql.exec('INSERT INTO request_nonces(nonce, used_at) VALUES (?, ?)', parsed.data.nonce, Date.now());
        return true;
      } catch {
        return false;
      }
    });
    return inserted ? { status: 'ok', value: { authorized: true } } : publicError('REQUEST_REPLAY', 'Control request was already used');
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
      this.ctx.storage.sql.exec('DELETE FROM request_nonces WHERE used_at < ?', Date.now() - REQUEST_MAX_SKEW_MS);
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
    let credential = await openVaultCredential(row, vaultKey);
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
            WHERE id = ? AND revision = ? AND EXISTS (
              SELECT 1 FROM refresh_leases WHERE credential_id = ? AND owner = ? AND revision = ? AND expires_at > ?
            )
          `, sealed, nextRevision, credential.expires, new Date().toISOString(), refreshRow.id, refreshRow.revision, refreshRow.id, parsed.data.nonce, refreshRow.revision, Date.now()).rowsWritten;
          this.ctx.storage.sql.exec('DELETE FROM refresh_leases WHERE credential_id = ? AND owner = ?', refreshRow.id, parsed.data.nonce);
          return changed === 1;
        });
        if (!committed) {
          this.ctx.storage.sql.exec("UPDATE oauth_credentials SET state = 'refresh-uncertain', updated_at = ? WHERE id = ?", new Date().toISOString(), refreshRow.id);
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

  private config(): { user_id: string; root_public_key: string; vault_key: string } | undefined {
    return this.ctx.storage.sql.exec<{ user_id: string; root_public_key: string; vault_key: string }>(
      'SELECT user_id, root_public_key, vault_key FROM vault_config WHERE id = 1',
    ).toArray()[0];
  }

  private device(machineId: string): DeviceRow | undefined {
    return this.ctx.storage.sql.exec<DeviceRow>(
      'SELECT signing_public_key, exchange_public_key, capabilities_json, generation FROM credential_devices WHERE machine_id = ?',
      machineId,
    ).toArray()[0];
  }

  private credential(id: string): CredentialRow | undefined {
    return this.ctx.storage.sql.exec<CredentialRow>(
      'SELECT id, provider, sealed_json, revision, expires_at, state FROM oauth_credentials WHERE id = ?',
      id,
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
  token: string;
}

function platformConfig(env: Env): PlatformConfig | null {
  if (!env.PLATFORM_URL || !env.PLATFORM_TENANT || !env.PLATFORM_TENANT_TOKEN) return null;
  return { url: env.PLATFORM_URL.replace(/\/+$/u, ''), tenant: env.PLATFORM_TENANT, token: env.PLATFORM_TENANT_TOKEN };
}

async function platformCall(platform: PlatformConfig, action: 'deploy' | 'revert', body: PlatformDeployRequest | { to: 'previous' | 'channel' }): Promise<{ status: ReleaseStatus; error: string | null }> {
  try {
    const response = await fetch(`${platform.url}/__platform/tenants/${encodeURIComponent(platform.tenant)}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${platform.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

/** `deploy.launch`: point desired at the release, then swap the worker through the platform when one is configured. */
async function launchRelease(env: Env, userId: string, payload: Record<string, unknown>): Promise<LaunchResult> {
  const input = launchReleaseInputSchema.parse(payload);
  const releases = tenantReleases(env, userId);
  const launched = await releases.launch(input);
  if (!launched) throw new ReleaseNotFoundError(input.sha);
  if (launched.record.status.worker !== 'pending') return launched;
  const worker = launched.record.artifacts.worker;
  const metadata = launched.record.worker;
  const platform = platformConfig(env);
  const outcome = platform && worker && metadata
    ? await platformCall(platform, 'deploy', { sha: input.sha, bundleKey: dataObjectKey(userId, worker.key), bundleHash: worker.hash, metadata })
    : { status: 'skipped' as const, error: null };
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

/**
 * Serves the launched release's frontend tree by hash. Returns null when the
 * tenant runs our channel build (no owner, no desired release, or the release
 * carries no frontend), so the caller falls through to today's behaviour.
 */
async function releaseFrontendResponse(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const ownerId = await tenantReleases(env, TENANT_OWNER_INSTANCE).owner();
  if (ownerId === null) return null;
  const frontend = await tenantReleases(env, ownerId).frontend();
  if (frontend === null) return null;
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
  const authorized = await credentialVault(env, signed.userId).authorizeControl(signed, 'storage.access');
  if (authorized.status === 'error') return Response.json(authorized, { status: 401 });
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
  if (!env.GITSPACE_OMP_BROKER_TOKEN || request.headers.get('authorization') !== `Bearer ${env.GITSPACE_OMP_BROKER_TOKEN}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const vault = credentialVault(env, userId);
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


export async function reconcileFleetMachines(env: Env, userId: string, catalog: {
  listMachines(): Promise<FleetMachineDefinition[]>;
  listSpaces(): Promise<PortableSpaceDefinition[]>;
  putMachine(machine: FleetMachineDefinition): Promise<FleetMachineDefinition>;
  removeMachine(machineId: string): Promise<boolean>;
}): Promise<FleetMachineDefinition[]> {
  for (const current of await catalog.listMachines()) {
    if (current.provider === 'physical') continue;
    const provider = machineProviderFor(env, userId, current);
    try {
      let observed = await provider.status(current);
      if (current.desiredState === 'online' && observed.state !== 'online') observed = await provider.resume(current);
      else if (current.desiredState === 'offline' && observed.state !== 'offline') {
        await assertMachineHasNoOpenSpaces(env, userId, catalog, current.id);
        observed = await provider.sleep(current);
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
      await catalog.putMachine({ ...current, state: 'error', lifecycleRevision: current.lifecycleRevision + 1, operationId: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return catalog.listMachines();
}

async function provisionManagedSandbox(env: Env, userId: string, controlUrl: string): Promise<FleetMachineDefinition> {
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
    capabilities: ['storage.access', 'space.control'],
  });
  if (registered.status === 'error') throw new Error(registered.error.message);
  // Sandboxes are worker-provisioned, so the worker hands them the root key to
  // pin; their trust in it is the same trust that installed their machine key.
  const rootPublicKey = await vault.rootPublicKey();
  if (!rootPublicKey) throw new Error('Vault is not configured');
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
    const created = await createCloudflareSandboxMachine({
      env,
      userId,
      machineId,
      environment: {
        GITSPACE_ENVIRONMENT_ROOT: '/workspace/gitspace',
        GITSPACE_MACHINE_ID: machineId,
        GITSPACE_MACHINE_LABEL: `Cloudflare ${machineId.slice('sandbox-'.length)}`,
        GITSPACE_CONTROL_URL: controlUrl,
        GITSPACE_USER_ID: userId,
        GITSPACE_ROOT_PUBLIC_KEY: rootPublicKey,
        GITSPACE_MACHINE_SIGNING_PRIVATE_KEY: credentialProtocolBase64.encode(signingPrivateKey),
        GITSPACE_ARTIFACT_KEY: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))),
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', providers: [...SUPPORTED_PROVIDERS] }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, version: WORKER_STAMP.version }, { headers: { 'cache-control': 'no-store', [WORKER_VERSION_HEADER]: WORKER_STAMP.version } });
    }
    const ompBrokerMatch = /^\/omp\/users\/([^/]+)\/v1\/(healthz|snapshot|snapshot\/stream|usage|credential\/\d+\/refresh)$/u.exec(url.pathname);
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
          rootPublicKey?: unknown;
          vaultKey?: unknown;
          deviceGrant?: unknown;
          gitBucketName?: unknown;
          credentials?: unknown;
        };
        if (typeof body.userId !== 'string' || typeof body.rootPublicKey !== 'string' || typeof body.vaultKey !== 'string') {
          throw new Error('Development bootstrap is invalid');
        }
        const vault = credentialVault(env, body.userId);
        const configured = await vault.bootstrap({ userId: body.userId, rootPublicKey: body.rootPublicKey, vaultKey: body.vaultKey });
        if (configured.status === 'error') return Response.json(configured, { status: 400 });
        const registered = await vault.registerDevice(body.deviceGrant as SignedCredentialAuthorityGrant);
        if (registered.status === 'error' && registered.error.code !== 'STALE_DEVICE_GRANT') return Response.json(registered, { status: 400 });
        if (typeof body.gitBucketName === 'string') {
          const namespace = env.USER_STORAGE as DurableObjectNamespace<UserStorageDO>;
          const storage = namespace.get(namespace.idFromName(body.userId));
          storage.beginProvisioning({ userId: body.userId, gitBucketName: body.gitBucketName });
          storage.markReady({ userId: body.userId, gitBucketName: body.gitBucketName });
        }
        projectSecrets(env, body.userId).bootstrap({ userId: body.userId, vaultKey: body.vaultKey });
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
        const authorized = await credentialVault(env, signed.userId).authorizeControl(signed, 'storage.access');
        if (authorized.status === 'error') return Response.json(authorized, { status: 401 });
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
        const authorized = await credentialVault(env, signed.userId).authorizeControl(signed, 'space.control');
        if (authorized.status === 'error') return Response.json(authorized, { status: 401 });
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
        const result = await credentialVault(env, invite.invite.userId).enrollDevice({ invite, binding });
        return Response.json(result, { status: result.status === 'ok' ? 200 : 400, headers: cors });
      } catch (error) {
        return Response.json({ status: 'error', error: { code: 'INVALID_DEVICE_ENROLLMENT', message: error instanceof Error ? error.message : 'Invalid enrollment' } }, { status: 400, headers: cors });
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
            || body.operation.startsWith('project.mcp.') ? 'space.control'
          : body.operation === 'storage.provision' ? 'storage.provision'
          : 'storage.access';
        const authorized = await credentialVault(env, body.userId).authorizeControl(body, capability);
        if (authorized.status === 'error') return Response.json(authorized, { status: 401 });
        if (body.operation.startsWith('deploy.')) {
          await tenantReleases(env, TENANT_OWNER_INSTANCE).setOwner(body.userId);
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
              value = await releases.status(WORKER_STAMP);
              break;
            case 'deploy.revert': {
              await releases.revert();
              const platform = platformConfig(env);
              if (platform) {
                const outcome = await platformCall(platform, 'revert', { to: 'channel' });
                if (outcome.status === 'failed') throw new Error(outcome.error ?? 'Platform revert failed');
              }
              value = await releases.status(WORKER_STAMP);
              break;
            }
            case 'deploy.machineApplied': {
              const input = machineAppliedInputSchema.parse(body.payload);
              value = await releases.machineApplied(body.machineId, input);
              if (value === null) throw new ReleaseNotFoundError(input.sha);
              break;
            }
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
          const connections = userMcpConnections(env, body.userId);
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
            case 'mcp.connections.delete':
              value = {
                connectionId: String(body.payload.connectionId ?? ''),
                deleted: await connections.delete(
                  body.userId,
                  String(body.payload.connectionId ?? ''),
                  Number(body.payload.expectedRevision ?? -1),
                ),
              };
              break;
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
              if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(handle)) throw new Error('Handle is invalid');
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
            case 'project.routes.lease':
              value = await authority.leaseHostedRoute(
                body.payload.route as Parameters<ProjectAuthorityDO['leaseHostedRoute']>[0],
              );
              break;
            case 'project.routes.release':
              value = await authority.releaseHostedRoute(
                String(body.payload.hostname ?? ''),
                body.machineId,
              );
              break;
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
            case 'catalog.machine.list': value = await reconcileFleetMachines(env, body.userId, catalog); break;
            case 'catalog.sandbox.create': value = await provisionManagedSandbox(env, body.userId, url.origin); break;
            case 'catalog.machine.sleep':
            case 'catalog.machine.resume':
            case 'catalog.machine.destroy': {
              const machineId = String(body.payload.machineId ?? '');
              const action = body.operation.slice('catalog.machine.'.length) as 'sleep' | 'resume' | 'destroy';
              const existing = await catalog.getMachine(machineId);
              if (!existing) {
                if (action === 'destroy') { value = { machineId, removed: true }; break; }
                throw new Error('Machine does not exist');
              }
              const desiredState = action === 'sleep' ? 'offline' : action === 'resume' ? 'online' : 'removed';
              if ((action === 'sleep' && existing.state === 'offline' && existing.desiredState === 'offline') || (action === 'resume' && existing.state === 'online' && existing.desiredState === 'online')) {
                value = existing;
                break;
              }
              if (action !== 'resume') await assertMachineHasNoOpenSpaces(env, body.userId, catalog, machineId);
              const operationId = existing.operationId ?? crypto.randomUUID();
              const transition = await catalog.putMachine({
                ...existing,
                state: action === 'sleep' ? 'sleeping' : action === 'resume' ? 'resuming' : 'deleting',
                desiredState,
                lifecycleRevision: existing.lifecycleRevision + 1,
                operationId,
                error: null,
              });
              const provider = machineProviderFor(env, body.userId, transition);
              try {
                if (action === 'destroy') {
                  await provider.destroy(transition);
                  await catalog.removeMachine(machineId);
                  await credentialVault(env, body.userId).removeManagedDevice(machineId);
                  value = { machineId, removed: true };
                } else {
                  const machine = action === 'sleep' ? await provider.sleep(transition) : await provider.resume(transition);
                  value = await catalog.putMachine({ ...machine, desiredState, lifecycleRevision: transition.lifecycleRevision + 1, operationId: null, error: null });
                }
              } catch (error) {
                await catalog.putMachine({ ...transition, state: 'error', lifecycleRevision: transition.lifecycleRevision + 1, operationId: null, error: error instanceof Error ? error.message : String(error) });
                throw error;
              }
              break;
            }
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
        const common = { ...body.payload, projectId: String(body.payload.projectId ?? ''), spaceId };
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
    const match = /^\/v1\/users\/([^/]+)\/credentials\/([^/]+)\/access$/u.exec(url.pathname);
    if (!match || request.method !== 'POST') return new Response('Not found', { status: 404 });
    try {
      const body = credentialAccessRequestSchema.parse(await readBoundedJson(request));
      if (body.userId !== decodeURIComponent(match[1]!) || body.credentialId !== decodeURIComponent(match[2]!)) {
        return Response.json({ status: 'error', error: { code: 'PATH_MISMATCH', message: 'Request path does not match signed body' } }, { status: 400 });
      }
      const result = await credentialVault(env, body.userId).getAccess(body);
      const status = result.status === 'ok' ? 200 : result.error.code === 'REFRESH_BUSY' ? 409 : result.error.code.includes('UNAUTHORIZED') ? 401 : 400;
      return Response.json(result, { status, headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json({ status: 'error', error: { code: 'BAD_REQUEST', message: 'Credential request is invalid' } }, { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
