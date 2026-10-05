import { createHash } from 'node:crypto';
import { parseRuntimeSettings, runtimeSettingsView, setRuntimeSetting, type RuntimeConfigDocument, type RuntimeSettingValue, type UserSettings, type UserSettingsUpdate } from '@gitspace/protocol';
import { CloudSpaceAuthorityError } from './cloud-space-authority.js';

export interface CanonicalSettingsCloud {
  getUserSettings(): Promise<UserSettings>;
  updateUserSettings(input: UserSettingsUpdate): Promise<UserSettings>;
  reserveUserHandle(expectedRevision: number, handle: string): Promise<UserSettings>;
  getRuntimeConfig(): Promise<RuntimeConfigDocument>;
  updateRuntimeConfig(input: { expectedGeneration: number; content: string; checksum: `sha256:${string}` }): Promise<RuntimeConfigDocument>;
  subscribeSettings?(onChange: (event: { userRevision: number; runtimeGeneration: number }) => void, onState: (state: 'connecting' | 'open' | 'offline') => void): () => void;
}
export class CanonicalSettingsConflict extends Error {
  constructor(readonly resource: 'user-settings' | 'runtime-config', readonly expected: number, readonly actual: number) {
    super(`${resource} changed from ${expected} to ${actual}`);
    this.name = 'CanonicalSettingsConflict';
  }
}
export type CanonicalSettingsSyncState = { status: 'connecting' | 'synced' | 'offline'; message: null } | { status: 'conflict' | 'error'; message: string };
export interface CanonicalSettingsChangedEvent { userRevision: number; runtimeGeneration: number; sync: CanonicalSettingsSyncState }
function conflictFrom(error: unknown): unknown {
  if (error instanceof CloudSpaceAuthorityError && error.code === 'SETTINGS_CONFLICT') {
    const { resource, expected, actual } = error.details;
    if ((resource === 'user-settings' || resource === 'runtime-config') && typeof expected === 'number' && typeof actual === 'number') return new CanonicalSettingsConflict(resource, expected, actual);
  }
  return error;
}

/** Machines apply user Git identity only; runtime configuration is cloud-owned. */
export class CanonicalSettingsCoordinator {
  private unsubscribe: (() => void) | null = null;
  private operation: Promise<void> = Promise.resolve();
  private event: CanonicalSettingsChangedEvent = { userRevision: 0, runtimeGeneration: 0, sync: { status: 'connecting', message: null } };
  private readonly listeners = new Set<(event: CanonicalSettingsChangedEvent) => void>();
  constructor(private readonly cloud: CanonicalSettingsCloud, private readonly applyUserSettings: (settings: UserSettings) => Promise<void> = async () => undefined) {}
  async start(): Promise<void> {
    try { await this.applyCurrentUser(); } catch (error) { console.warn('[settings-sync] user settings unavailable:', error instanceof Error ? error.message : error); }
    this.unsubscribe = this.cloud.subscribeSettings?.((event) => {
      this.event = { ...this.event, ...event };
      this.operation = this.operation.then(() => this.applyCurrentUser()).catch((error) => {
        this.event.sync = { status: 'error', message: error instanceof Error ? error.message : String(error) };
        this.emit();
      });
    }, (state) => { this.event.sync = { status: state === 'open' ? 'synced' : state, message: null }; this.emit(); }) ?? null;
  }
  async stop(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = null; await this.operation; }
  subscribe(listener: (event: CanonicalSettingsChangedEvent) => void): () => void { this.listeners.add(listener); listener(this.event); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(this.event); }
  private async applyCurrentUser(): Promise<void> { const value = await this.cloud.getUserSettings(); this.event.userRevision = value.revision; await this.applyUserSettings(value); this.emit(); }
  getUserSettings(): Promise<UserSettings> { return this.cloud.getUserSettings(); }
  async updateUserSettings(input: UserSettingsUpdate): Promise<UserSettings> {
    try { const value = await this.cloud.updateUserSettings(input); await this.applyUserSettings(value); this.event.userRevision = value.revision; this.emit(); return value; } catch (error) { throw conflictFrom(error); }
  }
  async reserveHandle(expectedRevision: number, handle: string): Promise<UserSettings> {
    try { return await this.cloud.reserveUserHandle(expectedRevision, handle); } catch (error) { throw conflictFrom(error); }
  }
  async getRuntimeSettings() {
    const document = await this.cloud.getRuntimeConfig();
    return { document, schema: runtimeSettingsView(parseRuntimeSettings(JSON.parse(document.content || '{}'))), sync: { status: 'synced' as const, message: null } };
  }
  async setRuntimeSetting(path: string, value: RuntimeSettingValue, expectedGeneration: number) {
    const current = await this.cloud.getRuntimeConfig();
    if (current.generation !== expectedGeneration) throw new CanonicalSettingsConflict('runtime-config', expectedGeneration, current.generation);
    const content = JSON.stringify(setRuntimeSetting(parseRuntimeSettings(JSON.parse(current.content || '{}')), path, value));
    try { await this.cloud.updateRuntimeConfig({ expectedGeneration, content, checksum: `sha256:${createHash('sha256').update(content).digest('hex')}` }); } catch (error) { throw conflictFrom(error); }
    return this.getRuntimeSettings();
  }
}
