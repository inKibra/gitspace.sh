import { DurableObject } from 'cloudflare:workers';
import { parseDocument, stringify } from 'yaml';
import {
  extractInferenceSettings,
  inferenceCredentialPaths,
  inferenceSettingsSchema,
  gitIdentityUpdateSchema,
  ompConfigUpdateSchema,
  ompSettingValueSchema,
  stripInferenceSettings,
  userSettingsUpdateSchema,
  type GitIdentityDocument,
  type OmpConfigDocument,
  type OmpSettingValue,
  type UserSettings,
  type UserSettingsUpdate,
} from '@gitspace/protocol';
import { subscriptionIdentity, subscriptionActive } from './account-access.js';
import { DurableChangeLog, type DurableStreamSubscription } from './durable-stream.js';

const EMPTY_SHA256 = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' as const;
export class SettingsRevisionConflict extends Error {
  constructor(readonly resource: 'user-settings' | 'omp-config', readonly expected: number, readonly actual: number) {
    super(`${resource} generation changed from ${expected} to ${actual}`); this.name = 'SettingsRevisionConflict';
  }
}
export class HandleUnavailable extends Error { constructor(readonly handle: string) { super(`Handle ${handle} is already reserved`); this.name = 'HandleUnavailable'; } }
export interface SettingsSnapshot { user: UserSettings; omp: OmpConfigDocument; git: Omit<GitIdentityDocument, 'privateKey'> | null; inferenceRevision: number }
export type SettingsWriteResult<T> = { status: 'ok'; value: T } | { status: 'conflict'; resource: 'user-settings' | 'omp-config'; expected: number; actual: number };
function defaultSettings(machineId: string): UserSettings {
  return { version: 1, revision: 0, onboardingComplete: false, profile: { displayName: '', handle: null }, git: { authorName: '', authorEmail: '' }, defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, updatedAt: new Date(0).toISOString(), updatedBy: machineId };
}
async function sha256(content: string): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
function parseOmp(content: string): { config: Record<string, unknown>; settings: Record<string, OmpSettingValue> } {
  let config: Record<string, unknown>;
  try {
    const document = parseDocument(content, { merge: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    const value: unknown = document.toJS({ maxAliasCount: 100 }) ?? {};
    if (typeof value !== 'object' || Array.isArray(value) || !ompSettingValueSchema.safeParse(value).success) throw new Error();
    config = value as Record<string, unknown>;
  } catch {
    // YAML/schema diagnostics may quote credential-bearing source lines or values.
    throw new Error('OMP configuration must be a valid YAML mapping with JSON-compatible values. Repair the original configuration and retry; it has not been removed.');
  }
  if (inferenceCredentialPaths(config).length) {
    throw new Error('OMP configuration contains raw provider authentication. Remove the raw authentication fields, retry inference migration, then connect those credentials through the Default profile credential vault before running inference. Existing configuration is retained for protected recovery.');
  }
  let settings: Record<string, OmpSettingValue>;
  try {
    settings = extractInferenceSettings(config);
    if (!inferenceSettingsSchema.safeParse(settings).success) throw new Error();
  } catch {
    throw new Error('OMP inference configuration is unsafe. Remove raw authentication fields, retry migration, then connect credentials through the Default profile credential vault before running inference.');
  }
  return { config, settings };
}
interface StoredSettingsRow { [key: string]: SqlStorageValue; revision: number; settings_json: string; updated_at: string; updated_by: string }
interface StoredOmpRow { [key: string]: SqlStorageValue; generation: number; content: string; checksum: string; updated_at: string; updated_by: string }
interface StoredGitIdentityRow { [key: string]: SqlStorageValue; generation: number; private_key: string; public_key: string; fingerprint: string; updated_at: string; updated_by: string }
interface InferenceMigrationRow extends Record<string, SqlStorageValue> {
  state: 'blocked' | 'prepared' | 'complete';
  prepared_generation: number | null;
  settings_json: string | null;
}
interface SettingsChangedEvent { type: 'settings.changed'; userRevision: number; ompGeneration: number; inferenceRevision?: number }

export class UserSettingsDO extends DurableObject<Env> {
  private readonly changes: DurableChangeLog;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.changes = new DurableChangeLog(ctx.storage);
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
        CREATE TABLE IF NOT EXISTS omp_inference_migration (
          id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL,
          original_generation INTEGER NOT NULL, original_content TEXT NOT NULL, original_checksum TEXT NOT NULL,
          original_updated_at TEXT NOT NULL, original_updated_by TEXT NOT NULL,
          prepared_generation INTEGER, settings_json TEXT
        );
        CREATE TABLE IF NOT EXISTS inference_settings_revision (
          id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
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
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO user_settings(id, revision, settings_json, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, settings_json = excluded.settings_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, revision, JSON.stringify(stored), updatedAt, machineId);
      this.changes.append('settings', this.snapshot());
    });
    const value = { ...stored, revision, updatedAt, updatedBy: machineId };
    this.changes.wake();
    this.ctx.waitUntil(this.broadcast({ type: 'settings.changed', userRevision: revision, ompGeneration: this.getOmp().generation }));
    return { status: 'ok', value };
  }
  setHandle(machineId: string, expectedRevision: number, handle: string): SettingsWriteResult<UserSettings> {
    const current = this.get(machineId);
    if (expectedRevision !== current.revision) return { status: 'conflict', resource: 'user-settings', expected: expectedRevision, actual: current.revision };
    return this.update(machineId, { expectedRevision, onboardingComplete: current.onboardingComplete, profile: { ...current.profile, handle }, git: current.git, defaults: current.defaults });
  }
  private readOmp(): OmpConfigDocument {
    const row = this.ctx.storage.sql.exec<StoredOmpRow>('SELECT generation, content, checksum, updated_at, updated_by FROM omp_config WHERE id = 1').toArray()[0];
    return row ? { generation: row.generation, content: row.content, checksum: row.checksum, updatedAt: row.updated_at, updatedBy: row.updated_by }
      : { generation: 0, content: '', checksum: EMPTY_SHA256, updatedAt: new Date(0).toISOString(), updatedBy: 'uninitialized' };
  }
  getOmp(): OmpConfigDocument {
    const document = this.readOmp();
    parseOmp(document.content);
    return document;
  }
  private migration(): InferenceMigrationRow | undefined {
    return this.ctx.storage.sql.exec<InferenceMigrationRow>('SELECT state, prepared_generation, settings_json FROM omp_inference_migration WHERE id = 1').toArray()[0];
  }
  prepareInferenceMigration(): { generation: number; settings: Record<string, OmpSettingValue> } {
    const migration = this.migration();
    if (migration && migration.prepared_generation !== null && migration.settings_json !== null) {
      return { generation: migration.prepared_generation, settings: JSON.parse(migration.settings_json) as Record<string, OmpSettingValue> };
    }
    const current = this.readOmp();
    // Retain the first original even when validation fails. This row has no public reader,
    // and a repair/retry must never overwrite it or publish it in the settings change log.
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO omp_inference_migration
      (id, state, original_generation, original_content, original_checksum, original_updated_at, original_updated_by)
      VALUES (1, 'blocked', ?, ?, ?, ?, ?)`, current.generation, current.content, current.checksum, current.updatedAt, current.updatedBy);
    const { settings } = parseOmp(current.content);
    this.ctx.storage.sql.exec(`UPDATE omp_inference_migration SET state = 'prepared', prepared_generation = ?, settings_json = ? WHERE id = 1`, current.generation, JSON.stringify(settings));
    return { generation: current.generation, settings };
  }
  async finishInferenceMigration(expectedGeneration: number): Promise<OmpConfigDocument> {
    const migration = this.migration();
    if (!migration || migration.state === 'blocked') throw new Error('Prepare inference migration before finishing it');
    if (migration.prepared_generation !== expectedGeneration) throw new SettingsRevisionConflict('omp-config', expectedGeneration, migration.prepared_generation!);
    if (migration.state === 'complete') return this.getOmp();
    const current = this.readOmp();
    if (current.generation !== expectedGeneration) throw new SettingsRevisionConflict('omp-config', expectedGeneration, current.generation);
    const { config, settings } = parseOmp(current.content);
    const content = Object.keys(settings).length ? stringify(stripInferenceSettings(config)) : current.content;
    const checksum = await sha256(content);
    const result = this.ctx.storage.transactionSync(() => {
      // Hashing yields: another retry may have completed the same durable preparation.
      const latestMigration = this.migration()!;
      if (latestMigration.state === 'complete') return { changed: false, value: this.getOmp() };
      const latest = this.readOmp();
      if (latest.generation !== expectedGeneration) throw new SettingsRevisionConflict('omp-config', expectedGeneration, latest.generation);
      const value = content === latest.content ? latest : {
        generation: latest.generation + 1, content, checksum,
        updatedAt: new Date().toISOString(), updatedBy: 'inference-migration',
      };
      if (value !== latest) {
        this.ctx.storage.sql.exec(`INSERT INTO omp_config(id, generation, content, checksum, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, content = excluded.content, checksum = excluded.checksum, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        value.generation, value.content, value.checksum, value.updatedAt, value.updatedBy);
      }
      this.ctx.storage.sql.exec(`UPDATE omp_inference_migration SET state = 'complete' WHERE id = 1`);
      this.changes.append('settings', this.snapshot());
      return { changed: true, value };
    });
    if (result.changed) {
      this.changes.wake();
      this.ctx.waitUntil(this.broadcast({ type: 'settings.changed', userRevision: this.get('inference-migration').revision, ompGeneration: result.value.generation }));
    }
    return result.value;
  }
  inferenceChanged(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Inference revision must be a nonnegative safe integer');
    const changed = this.ctx.storage.transactionSync(() => {
      const current = this.inferenceRevision();
      if (revision <= current) return false;
      this.ctx.storage.sql.exec(`INSERT INTO inference_settings_revision(id, revision) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision`, revision);
      this.changes.append('settings', this.snapshot());
      return true;
    });
    if (changed) {
      this.changes.wake();
      this.ctx.waitUntil(this.broadcast({ type: 'settings.changed', userRevision: this.get('inference').revision, ompGeneration: this.getOmp().generation, inferenceRevision: revision }));
    }
  }
  private inferenceRevision(): number {
    return this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM inference_settings_revision WHERE id = 1').toArray()[0]?.revision ?? 0;
  }
  async updateOmp(machineId: string, input: { expectedGeneration: number; content: string; checksum: string }): Promise<SettingsWriteResult<OmpConfigDocument>> {
    const parsed = ompConfigUpdateSchema.parse(input);
    const { settings } = parseOmp(parsed.content);
    const computed = await sha256(parsed.content);
    if (computed !== parsed.checksum) throw new Error('OMP configuration checksum does not match its content');
    const result = this.ctx.storage.transactionSync((): SettingsWriteResult<OmpConfigDocument> => {
      const current = this.readOmp();
      if (parsed.expectedGeneration !== current.generation) return { status: 'conflict', resource: 'omp-config', expected: parsed.expectedGeneration, actual: current.generation };
      const migration = this.migration();
      if (migration?.state === 'prepared') throw new Error('Inference migration is in progress. Retry shared Advanced changes after migration completes.');
      if (migration?.state === 'complete' && Object.keys(settings).length) throw new Error('Models, Agents, and Providers are managed by inference profiles. Edit the selected inference profile instead of shared Advanced settings.');
      if (computed === current.checksum) return { status: 'ok', value: current };
      const generation = current.generation + 1;
      const updatedAt = new Date().toISOString();
      this.ctx.storage.sql.exec(`INSERT INTO omp_config(id, generation, content, checksum, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, content = excluded.content, checksum = excluded.checksum, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, generation, parsed.content, parsed.checksum, updatedAt, machineId);
      this.changes.append('settings', this.snapshot());
      return { status: 'ok', value: { generation, content: parsed.content, checksum: parsed.checksum, updatedAt, updatedBy: machineId } };
    });
    if (result.status === 'ok') {
      this.changes.wake();
      this.ctx.waitUntil(this.broadcast({ type: 'settings.changed', userRevision: this.get(machineId).revision, ompGeneration: result.value.generation }));
    }
    return result;
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
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO git_identity(id, generation, private_key, public_key, fingerprint, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, private_key = excluded.private_key, public_key = excluded.public_key,
          fingerprint = excluded.fingerprint, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, generation, parsed.privateKey, parsed.publicKey, parsed.fingerprint, updatedAt, machineId);
      this.changes.append('settings', this.snapshot());
    });
    const value = { generation, privateKey: parsed.privateKey, publicKey: parsed.publicKey, fingerprint: parsed.fingerprint, updatedAt, updatedBy: machineId };
    this.changes.wake();
    this.ctx.waitUntil(this.broadcast({ type: 'settings.changed', userRevision: this.get(machineId).revision, ompGeneration: this.getOmp().generation }));
    return { status: 'ok', value };
  }
  snapshot(): SettingsSnapshot {
    const identity = this.getGitIdentity();
    const git = identity ? { generation: identity.generation, publicKey: identity.publicKey, fingerprint: identity.fingerprint, updatedAt: identity.updatedAt, updatedBy: identity.updatedBy } : null;
    return { user: this.get('uninitialized'), omp: this.getOmp(), git, inferenceRevision: this.inferenceRevision() };
  }
  watch(after: number | null): DurableStreamSubscription {
    // Older releases stored entire OMP documents in their outbox. A repaired current
    // document must not make credential-bearing historical snapshots replayable.
    this.snapshot();
    const rows = this.ctx.storage.sql.exec<{ cursor: number; value_json: string }>("SELECT cursor, value_json FROM app_changes WHERE resource = 'settings' ORDER BY cursor").toArray();
    let unsafeCursor: number | undefined;
    for (const row of rows) {
      try {
        const value = JSON.parse(row.value_json) as SettingsSnapshot;
        parseOmp(value.omp.content);
      } catch { unsafeCursor = row.cursor; }
    }
    if (unsafeCursor !== undefined) this.ctx.storage.sql.exec("DELETE FROM app_changes WHERE resource = 'settings' AND cursor <= ?", unsafeCursor);
    return this.changes.watch('settings', after, () => this.snapshot());
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const identity = await subscriptionIdentity(this.env, request, 'storage.access');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(identity);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (await subscriptionActive(this.env, socket, 'storage.access') && message === 'ping') socket.send('pong');
  }
  private async broadcast(event: SettingsChangedEvent): Promise<void> {
    const encoded = JSON.stringify(event);
    await Promise.all(this.ctx.getWebSockets().map(async (socket) => {
      if (!await subscriptionActive(this.env, socket, 'storage.access')) return;
      try { socket.send(encoded); } catch { socket.close(1011, 'Settings event delivery failed'); }
    }));
  }
}

