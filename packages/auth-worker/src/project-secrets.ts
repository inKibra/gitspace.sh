import { DurableObject } from 'cloudflare:workers';
import { credentialProtocolBase64 } from '@gitspace/protocol';

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
  if (sealed.byteLength <= 12) throw new Error('Stored project secret is malformed');
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
  }

  delete(projectIdInput: string, nameInput: string): boolean {
    const projectId = validateProjectId(projectIdInput);
    const name = validateSecretName(nameInput);
    const changed = this.ctx.storage.sql.exec('DELETE FROM project_secrets WHERE project_id = ? AND name = ? RETURNING name', projectId, name).toArray();
    return changed.length > 0;
  }

  async materialize(projectIdInput: string, namesInput: string[]): Promise<Record<string, string>> {
    const projectId = validateProjectId(projectIdInput);
    const names = [...new Set(namesInput.map(validateSecretName))];
    const config = this.config();
    if (!config) throw new Error('Project secrets are not configured');
    const rows = names.length === 0 ? this.rows(projectId) : names.map((name) => this.row(projectId, name)).filter((row): row is SecretRow => !!row);
    const values = await Promise.all(rows.map(async (row) => [row.name, await open(row, credentialProtocolBase64.decode(config.vault_key))] as const));
    return Object.fromEntries(values);
  }

  private config(): { user_id: string; vault_key: string } | undefined {
    return this.ctx.storage.sql.exec<{ user_id: string; vault_key: string }>('SELECT user_id, vault_key FROM project_secret_config WHERE id = 1').toArray()[0];
  }

  private row(projectId: string, name: string): SecretRow | undefined {
    return this.ctx.storage.sql.exec<SecretRow>('SELECT project_id, name, sealed_value, revision, updated_at, updated_by FROM project_secrets WHERE project_id = ? AND name = ?', projectId, name).toArray()[0];
  }

  private rows(projectId: string): SecretRow[] {
    return this.ctx.storage.sql.exec<SecretRow>('SELECT project_id, name, sealed_value, revision, updated_at, updated_by FROM project_secrets WHERE project_id = ? ORDER BY name', projectId).toArray();
  }
}
