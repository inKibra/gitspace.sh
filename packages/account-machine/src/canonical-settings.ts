import type { UserSettings } from '@gitspace/protocol';
import { coalesced } from './coalesced.js';

export interface CanonicalSettingsCloud {
  getUserSettings(): Promise<UserSettings>;
}

/** Machines read and apply user Git identity only; the account edits every setting. Startup, every relay connection
 * and every `settings` notice refresh it; nothing polls. */
export class CanonicalSettingsCoordinator {
  /** One read-and-apply now, or one more after the one in flight. */
  readonly refresh = coalesced(async () => { await this.applyUserSettings(await this.cloud.getUserSettings()); });
  constructor(private readonly cloud: CanonicalSettingsCloud, private readonly applyUserSettings: (settings: UserSettings) => Promise<void> = async () => undefined) {}
  async start(): Promise<void> {
    try { await this.refresh(); } catch (error) { console.warn('[settings-sync] user settings unavailable:', error instanceof Error ? error.message : error); }
  }
  getUserSettings(): Promise<UserSettings> { return this.cloud.getUserSettings(); }
}
