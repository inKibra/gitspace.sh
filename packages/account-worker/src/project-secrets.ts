import { DurableObject } from 'cloudflare:workers';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import type { AccountSecretMetadata, EffectiveSecretMetadata } from '@gitspace/protocol/rpc-contract';

// This scope cannot be a valid project id, keeping AES-GCM account/project data distinct.
const ACCOUNT_SECRET_SCOPE = 'account:';

export interface ProjectSecretMetadata {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

interface SecretRow extends Record<string, SqlStorageValue> {
  project_id: string;
  name: string;
  sealed_value: string;
  revision: number;
  updated_at: string;
  updated_by: string;
}

interface AccountSecretGrantRow extends Record<string, SqlStorageValue> {
  name: string;
  project_id: string;
  project_space_enabled: number;
  workspaces_enabled: number;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function validateProjectId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error('Project id is invalid');
  return value;
}

function validateSecretName(value: string): string {
  const name = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) throw new Error('Secret name must be an uppercase environment variable name');
  return name;
}

function validateSecretValue(value: string): string {
  if (!value || new TextEncoder().encode(value).byteLength > 64 * 1_024) throw new Error('Secret value must be between 1 byte and 64 KiB');
  return value;
}

async function cryptoKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ownedBuffer(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function additionalData(projectId: string, name: string, revision: number): ArrayBuffer {
  return ownedBuffer(new TextEncoder().encode(`${projectId}\n${name}\n${revision}`));
}

async function seal(value: string, key: Uint8Array, projectId: string, name: string, revision: number): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ownedBuffer(nonce), additionalData: additionalData(projectId, name, revision) }, await cryptoKey(key), ownedBuffer(new TextEncoder().encode(value)));
  const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  sealed.set(nonce);
  sealed.set(new Uint8Array(ciphertext), nonce.byteLength);
  return credentialProtocolBase64.encode(sealed);
}

async function open(row: SecretRow, key: Uint8Array): Promise<string> {
  const sealed = credentialProtocolBase64.decode(row.sealed_value);
  if (sealed.byteLength <= 12) throw new Error('Stored secret is malformed');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ownedBuffer(sealed.subarray(0, 12)), additionalData: additionalData(row.project_id, row.name, row.revision) }, await cryptoKey(key), ownedBuffer(sealed.subarray(12)));
  return new TextDecoder().decode(plaintext);
}


export class ProjectSecretsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS project_secret_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          user_id TEXT NOT NULL,
          vault_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_secrets (
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          sealed_value TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          PRIMARY KEY(project_id, name)
        );
        CREATE TABLE IF NOT EXISTS account_secrets (
          name TEXT PRIMARY KEY,
          sealed_value TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS account_secret_grants (
          name TEXT NOT NULL REFERENCES account_secrets(name) ON DELETE CASCADE,
          project_id TEXT NOT NULL,
          project_space_enabled INTEGER NOT NULL CHECK (project_space_enabled IN (0, 1)),
          workspaces_enabled INTEGER NOT NULL CHECK (workspaces_enabled IN (0, 1)),
          PRIMARY KEY(name, project_id)
        );
      `);
    });
  }

  bootstrap(input: { userId: string; vaultKey: string }): void {
    const key = credentialProtocolBase64.decode(input.vaultKey);
    if (!input.userId || key.byteLength !== 32) throw new Error('Project secrets bootstrap is invalid');
    const current = this.ctx.storage.sql.exec<{ user_id: string }>('SELECT user_id FROM project_secret_config WHERE id = 1').toArray()[0];
    if (current) {
      if (current.user_id !== input.userId) throw new Error('Project secrets belong to another user');
      return;
    }
    this.ctx.storage.sql.exec('INSERT INTO project_secret_config(id, user_id, vault_key, created_at) VALUES (1, ?, ?, ?)', input.userId, input.vaultKey, new Date().toISOString());
  }

  list(projectId: string): ProjectSecretMetadata[] {
    return this.rows(validateProjectId(projectId)).map((row) => ({
      projectId: row.project_id,
      name: row.name,
      revision: row.revision,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  }

  async put(input: { projectId: string; name: string; value: string; updatedBy: string }): Promise<ProjectSecretMetadata> {
    const projectId = validateProjectId(input.projectId);
    const name = validateSecretName(input.name);
    const value = validateSecretValue(input.value);
    const config = this.config();
    if (!config) throw new Error('Project secrets are not configured');
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = this.row(projectId, name);
      const revision = (current?.revision ?? 0) + 1;
      const updatedAt = new Date().toISOString();
      const sealedValue = await seal(value, credentialProtocolBase64.decode(config.vault_key), projectId, name, revision);
      this.ctx.storage.sql.exec(`
        INSERT INTO project_secrets(project_id, name, sealed_value, revision, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, name) DO UPDATE SET sealed_value = excluded.sealed_value,
          revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `, projectId, name, sealedValue, revision, updatedAt, input.updatedBy);
      const saved = this.row(projectId, name)!;
      return { projectId: saved.project_id, name: saved.name, revision: saved.revision, updatedAt: saved.updated_at, updatedBy: saved.updated_by };
    });
  }

  delete(projectIdInput: string, nameInput: string): boolean {
    const projectId = validateProjectId(projectIdInput);
    const name = validateSecretName(nameInput);
    const changed = this.ctx.storage.sql.exec('DELETE FROM project_secrets WHERE project_id = ? AND name = ? RETURNING name', projectId, name).toArray();
    return changed.length > 0;
  }

  listAccount(): AccountSecretMetadata[] {
    const grants = new Map<string, Array<AccountSecretMetadata['grants'][number]>>();
    for (const row of this.ctx.storage.sql.exec<AccountSecretGrantRow>('SELECT name, project_id, project_space_enabled, workspaces_enabled FROM account_secret_grants ORDER BY name, project_id')) {
      const entries = grants.get(row.name) ?? [];
      entries.push({ projectId: row.project_id, projectSpaceEnabled: row.project_space_enabled === 1, workspacesEnabled: row.workspaces_enabled === 1 });
      grants.set(row.name, entries);
    }
    return this.ctx.storage.sql.exec<SecretRow>('SELECT name, revision, updated_at, updated_by FROM account_secrets ORDER BY name').toArray().map((row) => ({
      name: row.name,
      revision: row.revision,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      grants: grants.get(row.name) ?? [],
    }));
  }

  async putAccount(input: { name: string; value: string; updatedBy: string }): Promise<AccountSecretMetadata> {
    const name = validateSecretName(input.name);
    const value = validateSecretValue(input.value);
    const config = this.config();
    if (!config) throw new Error('Project secrets are not configured');
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = this.accountRow(name);
      const revision = (current?.revision ?? 0) + 1;
      const updatedAt = new Date().toISOString();
      const sealedValue = await seal(value, credentialProtocolBase64.decode(config.vault_key), ACCOUNT_SECRET_SCOPE, name, revision);
      this.ctx.storage.sql.exec(`
        INSERT INTO account_secrets(name, sealed_value, revision, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET sealed_value = excluded.sealed_value,
          revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `, name, sealedValue, revision, updatedAt, input.updatedBy);
      return this.accountMetadata(this.accountRow(name)!);
    });
  }

  deleteAccount(nameInput: string): boolean {
    const name = validateSecretName(nameInput);
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM account_secret_grants WHERE name = ?', name);
      return this.ctx.storage.sql.exec('DELETE FROM account_secrets WHERE name = ? RETURNING name', name).toArray().length > 0;
    });
  }

  grantAccount(input: { name: string; projectId: string; projectSpaceEnabled?: boolean; workspacesEnabled?: boolean }): AccountSecretMetadata {
    const name = validateSecretName(input.name);
    const projectId = validateProjectId(input.projectId);
    const row = this.accountRow(name);
    if (!row) throw new Error('Account secret does not exist');
    const projectSpaceEnabled = input.projectSpaceEnabled === undefined ? true : input.projectSpaceEnabled;
    const workspacesEnabled = input.workspacesEnabled === undefined ? true : input.workspacesEnabled;
    if (typeof projectSpaceEnabled !== 'boolean' || typeof workspacesEnabled !== 'boolean') throw new Error('Secret grant applicability must be boolean');
    this.ctx.storage.sql.exec(`
      INSERT INTO account_secret_grants(name, project_id, project_space_enabled, workspaces_enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name, project_id) DO UPDATE SET project_space_enabled = excluded.project_space_enabled,
        workspaces_enabled = excluded.workspaces_enabled
    `, name, projectId, projectSpaceEnabled ? 1 : 0, workspacesEnabled ? 1 : 0);
    return this.accountMetadata(row);
  }

  revokeAccount(nameInput: string, projectIdInput: string): AccountSecretMetadata {
    const name = validateSecretName(nameInput);
    const projectId = validateProjectId(projectIdInput);
    const row = this.accountRow(name);
    if (!row) throw new Error('Account secret does not exist');
    this.ctx.storage.sql.exec('DELETE FROM account_secret_grants WHERE name = ? AND project_id = ?', name, projectId);
    return this.accountMetadata(row);
  }

  listEffective(projectIdInput: string, workspaceId: string | null): EffectiveSecretMetadata[] {
    const projectId = validateProjectId(projectIdInput);
    return this.effectiveRows(projectId, workspaceId).map((row) => ({
      projectId,
      name: row.name,
      revision: row.revision,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      source: row.project_id === ACCOUNT_SECRET_SCOPE ? 'account' : 'project',
    }));
  }

  async materialize(projectIdInput: string, namesInput: string[], workspaceId: string | null): Promise<Record<string, string>> {
    const projectId = validateProjectId(projectIdInput);
    const names = [...new Set(namesInput.map(validateSecretName))];
    const config = this.config();
    if (!config) throw new Error('Project secrets are not configured');
    const rows = this.effectiveRows(projectId, workspaceId, names);
    const key = credentialProtocolBase64.decode(config.vault_key);
    const values = await Promise.all(rows.map(async (row) => [row.name, await open(row, key)] as const));
    return Object.fromEntries(values);
  }

  private config(): { user_id: string; vault_key: string } | undefined {
    return this.ctx.storage.sql.exec<{ user_id: string; vault_key: string }>('SELECT user_id, vault_key FROM project_secret_config WHERE id = 1').toArray()[0];
  }

  private accountRow(name: string): SecretRow | undefined {
    return this.ctx.storage.sql.exec<SecretRow>('SELECT ? AS project_id, name, sealed_value, revision, updated_at, updated_by FROM account_secrets WHERE name = ?', ACCOUNT_SECRET_SCOPE, name).toArray()[0];
  }

  private accountMetadata(row: SecretRow): AccountSecretMetadata {
    const grants = this.ctx.storage.sql.exec<AccountSecretGrantRow>('SELECT project_id, project_space_enabled, workspaces_enabled FROM account_secret_grants WHERE name = ? ORDER BY project_id', row.name).toArray();
    return {
      name: row.name,
      revision: row.revision,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      grants: grants.map((grant) => ({ projectId: grant.project_id, projectSpaceEnabled: grant.project_space_enabled === 1, workspacesEnabled: grant.workspaces_enabled === 1 })),
    };
  }

  private effectiveRows(projectId: string, workspaceId: string | null, names: string[] = []): SecretRow[] {
    if (workspaceId !== null && (typeof workspaceId !== 'string' || workspaceId.length === 0)) throw new Error('Secret resolution requires a workspace id or null');
    const applicability = workspaceId === null ? 'project_space_enabled' : 'workspaces_enabled';
    const selection = names.length > 0 ? `WHERE name IN (${names.map(() => '?').join(', ')})` : '';
    return this.ctx.storage.sql.exec<SecretRow>(`
      SELECT * FROM (
        SELECT project_id, name, sealed_value, revision, updated_at, updated_by
        FROM project_secrets WHERE project_id = ?
        UNION ALL
        SELECT ?, account.name, account.sealed_value, account.revision, account.updated_at, account.updated_by
        FROM account_secrets AS account
        JOIN account_secret_grants AS grants ON grants.name = account.name
        WHERE grants.project_id = ? AND grants.${applicability} = 1
          AND NOT EXISTS (SELECT 1 FROM project_secrets AS project WHERE project.project_id = ? AND project.name = account.name)
      ) ${selection} ORDER BY name
    `, projectId, ACCOUNT_SECRET_SCOPE, projectId, projectId, ...names).toArray();
  }

  private row(projectId: string, name: string): SecretRow | undefined {
    return this.ctx.storage.sql.exec<SecretRow>('SELECT project_id, name, sealed_value, revision, updated_at, updated_by FROM project_secrets WHERE project_id = ? AND name = ?', projectId, name).toArray()[0];
  }

  private rows(projectId: string): SecretRow[] {
    return this.ctx.storage.sql.exec<SecretRow>('SELECT project_id, name, sealed_value, revision, updated_at, updated_by FROM project_secrets WHERE project_id = ? ORDER BY name', projectId).toArray();
  }
}
