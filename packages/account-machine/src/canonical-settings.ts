import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { SETTINGS_SCHEMA, isCredential, type SettingPath } from '@oh-my-pi/pi-coding-agent/config/settings-schema';
import {
  ompSettingValueSchema,
  type OmpConfigDocument,
  type OmpSettingSchemaItem,
  type OmpSettingValue,
  type UserSettings,
  type UserSettingsUpdate,
} from '@gitspace/protocol';
import { CloudSpaceAuthorityError } from './cloud-space-authority.js';

export interface CanonicalSettingsCloud {
  getUserSettings(): Promise<UserSettings>;
  updateUserSettings(input: UserSettingsUpdate): Promise<UserSettings>;
  reserveUserHandle(expectedRevision: number, handle: string): Promise<UserSettings>;
  getOmpConfig(): Promise<OmpConfigDocument>;
  updateOmpConfig(input: { expectedGeneration: number; content: string; checksum: `sha256:${string}` }): Promise<OmpConfigDocument>;
  subscribeSettings?(
    onChange: (event: { userRevision: number; ompGeneration: number }) => void,
    onState: (state: 'connecting' | 'open' | 'offline') => void,
  ): () => void;
}

export class CanonicalSettingsConflict extends Error {
  constructor(readonly resource: 'user-settings' | 'omp-config', readonly expected: number, readonly actual: number) {
    super(`${resource} changed from ${expected} to ${actual}`);
    this.name = 'CanonicalSettingsConflict';
  }
}
export type CanonicalSettingsSyncState =
  | { status: 'connecting' | 'synced' | 'offline'; message: null }
  | { status: 'conflict' | 'error'; message: string };
export interface CanonicalSettingsChangedEvent {
  userRevision: number;
  ompGeneration: number;
  sync: CanonicalSettingsSyncState;
}


interface OmpSettingsAccess {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  flush(): Promise<void>;
  reloadFromDisk(): Promise<void>;
}

interface SyncMetadata {
  generation: number;
  checksum: `sha256:${string}`;
  updatedAt: string;
  updatedBy: string;
}

const MAX_CONFIG_BYTES = 262_144;
function checksum(content: string): `sha256:${string}` { return `sha256:${createHash('sha256').update(content).digest('hex')}`; }
function conflictFrom(error: unknown): CanonicalSettingsConflict | null {
  if (!(error instanceof CloudSpaceAuthorityError) || error.code !== 'SETTINGS_CONFLICT') return null;
  const { resource, expected, actual } = error.details;
  return (resource === 'user-settings' || resource === 'omp-config') && typeof expected === 'number' && typeof actual === 'number'
    ? new CanonicalSettingsConflict(resource, expected, actual)
    : null;
}

export class CanonicalSettingsCoordinator {
  private readonly configPath: string;
  private readonly metadataPath: string;
  private settings: OmpSettingsAccess | null = null;
  private document: OmpConfigDocument | null = null;
  private watcher: FSWatcher | null = null;
  private unsubscribe: (() => void) | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private applyingRemote = false;
  private stopped = false;
  private dirty = false;
  private operation: Promise<void> = Promise.resolve();
  private syncState: CanonicalSettingsSyncState = { status: 'connecting', message: null };
  private userRevision = 0;
  private readonly listeners = new Set<(event: CanonicalSettingsChangedEvent) => void>();

  constructor(
    private readonly cloud: CanonicalSettingsCloud,
    private readonly machineId: string,
    private readonly agentDir: string,
    private readonly cwd: string,
    private readonly reloadSessions: () => Promise<void>,
    private readonly applyUserSettings: (settings: UserSettings) => Promise<void> = async () => undefined,
  ) {
    this.configPath = join(agentDir, 'config.yml');
    this.metadataPath = `${this.configPath}.gitspace-sync.json`;
  }

  async start(): Promise<void> {
    await mkdir(this.agentDir, { recursive: true });
    this.settings = await Settings.init({ cwd: this.cwd, agentDir: this.agentDir }) as OmpSettingsAccess;
    const local = await this.readLocal();
    try {
      let remote = await this.cloud.getOmpConfig();
      if (remote.generation === 0 && local.length > 0) {
        remote = await this.cloud.updateOmpConfig({ expectedGeneration: 0, content: local, checksum: checksum(local) });
      } else if (remote.generation > 0 && checksum(local) !== remote.checksum) {
        await this.applyRemote(remote);
      }
      this.document = remote;
      await this.writeMetadata(remote);
      this.syncState = { status: 'synced', message: null };
    } catch (error) {
      const cached = await this.readMetadata(local);
      this.document = cached ?? { generation: 0, content: local, checksum: checksum(local), updatedAt: new Date(0).toISOString(), updatedBy: this.machineId };
      this.dirty = cached ? checksum(local) !== cached.checksum : local.length > 0;
      console.warn('[settings-sync] starting from the local OMP settings cache:', error instanceof Error ? error.message : error);
      this.syncState = { status: 'offline', message: null };
    }
    try {
      const userSettings = await this.cloud.getUserSettings();
      this.userRevision = userSettings.revision;
      await this.applyUserSettings(userSettings);
    } catch (error) {
      console.warn('[settings-sync] user settings could not be applied locally:', error instanceof Error ? error.message : error);
    }
    this.watcher = watch(dirname(this.configPath), (_event, filename) => {
      if (this.stopped || this.applyingRemote || (filename && filename !== basename(this.configPath))) return;
      if (this.publishTimer) clearTimeout(this.publishTimer);
      this.publishTimer = setTimeout(() => this.enqueue(() => this.publishLocal(true)), 200);
    });
    this.unsubscribe = this.cloud.subscribeSettings?.(
      (event) => {
        this.userRevision = event.userRevision;
        this.emit();
        this.enqueue(async () => {
          if (event.ompGeneration > (this.document?.generation ?? -1)) await this.pullLatest();
          const userSettings = await this.cloud.getUserSettings();
          this.userRevision = userSettings.revision;
          await this.applyUserSettings(userSettings);
          this.emit();
        });
      },
      (state) => {
        this.syncState = state === 'open' ? { status: 'synced', message: null } : state === 'offline' ? { status: 'offline', message: null } : { status: 'connecting', message: null };
        this.emit();
      },
    ) ?? null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.watcher = null;
    this.publishTimer = null;
    await this.operation;
  }
  subscribe(listener: (event: CanonicalSettingsChangedEvent) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentEvent());
    return () => this.listeners.delete(listener);
  }

  getUserSettings(): Promise<UserSettings> { return this.cloud.getUserSettings(); }
  async updateUserSettings(input: UserSettingsUpdate): Promise<UserSettings> {
    try {
      const settings = await this.cloud.updateUserSettings(input);
      this.userRevision = settings.revision;
      await this.applyUserSettings(settings);
      this.emit();
      return settings;
    } catch (error) { throw conflictFrom(error) ?? error; }
  }
  async reserveHandle(expectedRevision: number, handle: string): Promise<UserSettings> {
    try {
      const settings = await this.cloud.reserveUserHandle(expectedRevision, handle);
      this.userRevision = settings.revision;
      this.emit();
      return settings;
    } catch (error) { throw conflictFrom(error) ?? error; }
  }

  async getOmpSettings(): Promise<{ document: OmpConfigDocument; schema: OmpSettingSchemaItem[]; sync: CanonicalSettingsSyncState }> {
    if (!this.settings || !this.document) throw new Error('Canonical OMP settings are not initialized');
    return { document: this.document, schema: this.schemaView(), sync: this.syncState };
  }

  async setOmpSetting(path: string, value: OmpSettingValue): Promise<{ document: OmpConfigDocument; schema: OmpSettingSchemaItem[]; sync: CanonicalSettingsSyncState }> {
    if (!this.settings || !this.document) throw new Error('Canonical OMP settings are not initialized');
    if (!Object.hasOwn(SETTINGS_SCHEMA, path)) throw new Error(`Unknown OMP setting ${path}`);
    this.settings.set(path, ompSettingValueSchema.parse(value));
    await this.settings.flush();
    await this.publishLocal(false);
    await this.reloadSessions();
    return { document: this.document, schema: this.schemaView(), sync: this.syncState };
  }

  private schemaView(): OmpSettingSchemaItem[] {
    if (!this.settings) return [];
    return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map((path) => {
      const definition = SETTINGS_SCHEMA[path] as { type?: string; values?: readonly string[]; ui?: { tab?: string; label?: string; description?: string; options?: unknown } };
      const kind = definition.type === 'boolean' || definition.type === 'enum' || definition.type === 'number' || definition.type === 'string' || definition.type === 'array' || definition.type === 'record' ? definition.type : 'other';
      const rawOptions = definition.ui?.options;
      const options = definition.values ? [...definition.values] : Array.isArray(rawOptions)
        ? rawOptions.map((option: unknown) => typeof option === 'string' ? option : option && typeof option === 'object' && typeof (option as { value?: unknown }).value === 'string' ? (option as { value: string }).value : null).filter((option): option is string => option !== null)
        : [];
      const credential = isCredential(path);
      return {
        path,
        tab: definition.ui?.tab ?? 'other',
        label: definition.ui?.label ?? path,
        ...(definition.ui?.description ? { description: definition.ui.description } : {}),
        kind,
        value: credential ? null : ompSettingValueSchema.parse(this.settings!.get(path) ?? null),
        options,
        credential,
      };
    });
  }
  private enqueue(task: () => Promise<void>): void {
    this.operation = this.operation.then(task).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.syncState = { status: 'error', message };
      console.error('[settings-sync] background synchronization failed', error);
    });
  }

  private async readLocal(): Promise<string> {
    try {
      const content = await readFile(this.configPath, 'utf8');
      if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new Error('OMP configuration exceeds 256 KiB');
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private async publishLocal(resolveConflict: boolean): Promise<void> {
    if (this.applyingRemote || !this.document) return;
    const content = await this.readLocal();
    const nextChecksum = checksum(content);
    if (nextChecksum === this.document.checksum) { this.dirty = false; return; }
    this.syncState = { status: 'connecting', message: null };
    try {
      this.document = await this.cloud.updateOmpConfig({ expectedGeneration: this.document.generation, content, checksum: nextChecksum });
      this.dirty = false;
      await this.writeMetadata(this.document);
      this.syncState = { status: 'synced', message: null };
    } catch (error) {
      const conflict = conflictFrom(error);
      if (!conflict) {
        this.dirty = true;
        this.syncState = { status: 'error', message: error instanceof Error ? error.message : String(error) };
        throw error;
      }
      this.syncState = { status: 'conflict', message: conflict.message };
      const remote = await this.cloud.getOmpConfig();
      await this.applyRemote(remote);
      this.dirty = false;
      if (!resolveConflict) throw conflict;
    }
  }

  private async pullLatest(): Promise<void> {
    if (!this.document) return;
    if (this.dirty) {
      await this.publishLocal(true);
      if (this.dirty) return;
    }
    const remote = await this.cloud.getOmpConfig();
    if (remote.generation > this.document.generation) await this.applyRemote(remote);
  }

  private async applyRemote(remote: OmpConfigDocument): Promise<void> {
    if (!this.settings) throw new Error('OMP settings are not initialized');
    this.applyingRemote = true;
    try {
      const tempPath = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(tempPath, remote.content, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.configPath);
      this.document = remote;
      await this.writeMetadata(remote);
      await this.settings.reloadFromDisk();
      await this.reloadSessions();
    } finally {
      this.applyingRemote = false;
    }
  }

  private currentEvent(): CanonicalSettingsChangedEvent {
    return { userRevision: this.userRevision, ompGeneration: this.document?.generation ?? 0, sync: this.syncState };
  }

  private emit(): void {
    const event = this.currentEvent();
    for (const listener of this.listeners) listener(event);
  }

  private async readMetadata(content: string): Promise<OmpConfigDocument | null> {
    try {
      const raw = JSON.parse(await readFile(this.metadataPath, 'utf8')) as Partial<SyncMetadata>;
      if (!Number.isInteger(raw.generation) || typeof raw.checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(raw.checksum) || typeof raw.updatedAt !== 'string' || typeof raw.updatedBy !== 'string') return null;
      return { generation: raw.generation!, content, checksum: raw.checksum as `sha256:${string}`, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy };
    } catch { return null; }
  }

  private async writeMetadata(document: OmpConfigDocument): Promise<void> {
    const tempPath = `${this.metadataPath}.${process.pid}.tmp`;
    const metadata: SyncMetadata = { generation: document.generation, checksum: document.checksum as `sha256:${string}`, updatedAt: document.updatedAt, updatedBy: document.updatedBy };
    await writeFile(tempPath, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.metadataPath);
  }
}
