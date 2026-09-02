import { DurableObject } from 'cloudflare:workers';
import {
  gitIdentityUpdateSchema,
  ompConfigUpdateSchema,
  userSettingsUpdateSchema,
  type GitIdentityDocument,
  type OmpConfigDocument,
  type UserSettings,
  type UserSettingsUpdate,
} from '@gitspace/protocol';

const EMPTY_SHA256 = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' as const;
export class SettingsRevisionConflict extends Error {
  constructor(readonly resource: 'user-settings' | 'omp-config', readonly expected: number, readonly actual: number) {
    super(`${resource} generation changed from ${expected} to ${actual}`); this.name = 'SettingsRevisionConflict';
  }
}
export class HandleUnavailable extends Error { constructor(readonly handle: string) { super(`Handle ${handle} is already reserved`); this.name = 'HandleUnavailable'; } }
export type SettingsWriteResult<T> = { status: 'ok'; value: T } | { status: 'conflict'; resource: 'user-settings' | 'omp-config'; expected: number; actual: number };
function defaultSettings(machineId: string): UserSettings {
  return { version: 1, revision: 0, onboardingComplete: false, profile: { displayName: '', handle: null }, git: { authorName: '', authorEmail: '' }, defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, updatedAt: new Date(0).toISOString(), updatedBy: machineId };
}
async function sha256(content: string): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
interface StoredSettingsRow { [key: string]: SqlStorageValue; revision: number; settings_json: string; updated_at: string; updated_by: string }
interface StoredOmpRow { [key: string]: SqlStorageValue; generation: number; content: string; checksum: string; updated_at: string; updated_by: string }
interface StoredGitIdentityRow { [key: string]: SqlStorageValue; generation: number; private_key: string; public_key: string; fingerprint: string; updated_at: string; updated_by: string }
interface SettingsChangedEvent { type: 'settings.changed'; userRevision: number; ompGeneration: number }

export class UserSettingsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS user_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, settings_json TEXT NOT NULL,
          updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS omp_config (
          id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, content TEXT NOT NULL,
          checksum TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS git_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, private_key TEXT NOT NULL,
          public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
        );
      `);
    });
  }
  get(machineId: string): UserSettings {
    const row = this.ctx.storage.sql.exec<StoredSettingsRow>('SELECT revision, settings_json, updated_at, updated_by FROM user_settings WHERE id = 1').toArray()[0];
    if (!row) return defaultSettings(machineId);
    const value = JSON.parse(row.settings_json) as Omit<UserSettings, 'revision' | 'updatedAt' | 'updatedBy' | 'defaults'> & { defaults: Partial<UserSettings['defaults']> & Omit<UserSettings['defaults'], 'appearance'> };
    // Rows written before `appearance` existed read as the system scheme.
    return { ...value, defaults: { appearance: 'system', ...value.defaults }, revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
  update(machineId: string, input: UserSettingsUpdate): SettingsWriteResult<UserSettings> {
    const parsed = userSettingsUpdateSchema.parse(input);
    const current = this.get(machineId);
    if (parsed.expectedRevision !== current.revision) return { status: 'conflict', resource: 'user-settings', expected: parsed.expectedRevision, actual: current.revision };
    const revision = current.revision + 1;
    const updatedAt = new Date().toISOString();
    const stored = { version: 1 as const, onboardingComplete: parsed.onboardingComplete, profile: parsed.profile, git: parsed.git, defaults: parsed.defaults };
    this.ctx.storage.sql.exec(`INSERT INTO user_settings(id, revision, settings_json, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, settings_json = excluded.settings_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, revision, JSON.stringify(stored), updatedAt, machineId);
    const value = { ...stored, revision, updatedAt, updatedBy: machineId };
    this.broadcast({ type: 'settings.changed', userRevision: revision, ompGeneration: this.getOmp().generation });
    return { status: 'ok', value };
  }
  setHandle(machineId: string, expectedRevision: number, handle: string): SettingsWriteResult<UserSettings> {
    const current = this.get(machineId);
    if (expectedRevision !== current.revision) return { status: 'conflict', resource: 'user-settings', expected: expectedRevision, actual: current.revision };
    return this.update(machineId, { expectedRevision, onboardingComplete: current.onboardingComplete, profile: { ...current.profile, handle }, git: current.git, defaults: current.defaults });
  }
  getOmp(): OmpConfigDocument {
    const row = this.ctx.storage.sql.exec<StoredOmpRow>('SELECT generation, content, checksum, updated_at, updated_by FROM omp_config WHERE id = 1').toArray()[0];
    return row ? { generation: row.generation, content: row.content, checksum: row.checksum, updatedAt: row.updated_at, updatedBy: row.updated_by }
      : { generation: 0, content: '', checksum: EMPTY_SHA256, updatedAt: new Date(0).toISOString(), updatedBy: 'uninitialized' };
  }
  async updateOmp(machineId: string, input: { expectedGeneration: number; content: string; checksum: string }): Promise<SettingsWriteResult<OmpConfigDocument>> {
    const parsed = ompConfigUpdateSchema.parse(input);
    const current = this.getOmp();
    if (parsed.expectedGeneration !== current.generation) return { status: 'conflict', resource: 'omp-config', expected: parsed.expectedGeneration, actual: current.generation };
    const computed = await sha256(parsed.content);
    if (computed !== parsed.checksum) throw new Error('OMP configuration checksum does not match its content');
    if (computed === current.checksum) return { status: 'ok', value: current };
    const generation = current.generation + 1;
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(`INSERT INTO omp_config(id, generation, content, checksum, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, content = excluded.content, checksum = excluded.checksum, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, generation, parsed.content, parsed.checksum, updatedAt, machineId);
    const value = { generation, content: parsed.content, checksum: parsed.checksum, updatedAt, updatedBy: machineId };
    this.broadcast({ type: 'settings.changed', userRevision: this.get(machineId).revision, ompGeneration: generation });
    return { status: 'ok', value };
  }
  getGitIdentity(): GitIdentityDocument | null {
    const row = this.ctx.storage.sql.exec<StoredGitIdentityRow>('SELECT generation, private_key, public_key, fingerprint, updated_at, updated_by FROM git_identity WHERE id = 1').toArray()[0];
    return row ? { generation: row.generation, privateKey: row.private_key, publicKey: row.public_key, fingerprint: row.fingerprint, updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
  }
  updateGitIdentity(machineId: string, input: { expectedGeneration: number; privateKey: string; publicKey: string; fingerprint: string }): SettingsWriteResult<GitIdentityDocument> {
    const parsed = gitIdentityUpdateSchema.parse(input);
    const current = this.getGitIdentity();
    const actual = current?.generation ?? 0;
    if (parsed.expectedGeneration !== actual) return { status: 'conflict', resource: 'user-settings', expected: parsed.expectedGeneration, actual };
    const generation = actual + 1;
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(`INSERT INTO git_identity(id, generation, private_key, public_key, fingerprint, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, private_key = excluded.private_key, public_key = excluded.public_key,
        fingerprint = excluded.fingerprint, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, generation, parsed.privateKey, parsed.publicKey, parsed.fingerprint, updatedAt, machineId);
    const value = { generation, privateKey: parsed.privateKey, publicKey: parsed.publicKey, fingerprint: parsed.fingerprint, updatedAt, updatedBy: machineId };
    this.broadcast({ type: 'settings.changed', userRevision: this.get(machineId).revision, ompGeneration: this.getOmp().generation });
    return { status: 'ok', value };
  }
  fetch(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void { if (message === 'ping') socket.send('pong'); }
  private broadcast(event: SettingsChangedEvent): void {
    const encoded = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) { try { socket.send(encoded); } catch { socket.close(1011, 'Settings event delivery failed'); } }
  }
}

interface HandleRow { [key: string]: SqlStorageValue; user_id: string }
export class HandleRegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); ctx.blockConcurrencyWhile(async () => { this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL)'); }); }
  claim(userId: string): { claimed: boolean; owner: string; created: boolean } {
    const row = this.ctx.storage.sql.exec<HandleRow>('SELECT user_id FROM owner WHERE id = 1').toArray()[0];
    if (row) return { claimed: row.user_id === userId, owner: row.user_id, created: false };
    this.ctx.storage.sql.exec('INSERT INTO owner(id, user_id) VALUES (1, ?)', userId);
    return { claimed: true, owner: userId, created: true };
  }
  release(userId: string): void { this.ctx.storage.sql.exec('DELETE FROM owner WHERE id = 1 AND user_id = ?', userId); }
}
