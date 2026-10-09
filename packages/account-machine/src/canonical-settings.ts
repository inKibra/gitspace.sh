import type { UserSettings } from '@gitspace/protocol';

export interface CanonicalSettingsCloud {
  getUserSettings(): Promise<UserSettings>;
  subscribeSettings?(onChange: (event: { userRevision: number; runtimeGeneration: number }) => void, onState: (state: 'connecting' | 'open' | 'offline') => void): () => void;
}
export type CanonicalSettingsSyncState = { status: 'connecting' | 'synced' | 'offline'; message: null } | { status: 'conflict' | 'error'; message: string };
export interface CanonicalSettingsChangedEvent { userRevision: number; runtimeGeneration: number; sync: CanonicalSettingsSyncState }

/** Machines read and apply user Git identity only; the account edits every setting. */
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
}
