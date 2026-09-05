import { deviceGrants, type GitSpaceDatabase } from '@gitspace/core';
import {
  deviceGrantRecordSchema,
  verifyDeviceGrantRecord,
  type DeviceGrantRecord,
  type VerifiedDevice,
} from '@gitspace/protocol';
import { eq } from 'drizzle-orm';

export interface DeviceGrantAuthority {
  listDeviceGrants(): Promise<DeviceGrantRecord[]>;
  revokeDeviceGrant(deviceId: string): Promise<{ deviceId: string; revokedAt: number }>;
}

export interface DeviceRegistryOptions {
  database: GitSpaceDatabase;
  authority: DeviceGrantAuthority;
  rootSigningPublicKey: Uint8Array;
  /** Background poll interval; the vault is authoritative, this is the convergence bound. */
  pollMs?: number;
  onError?: (error: unknown) => void;
}

/** A mirrored grant with its verification outcome, for the Devices registry view. */
export interface MirroredDevice {
  record: DeviceGrantRecord;
  verified: VerifiedDevice | null;
}

const UNKNOWN_DEVICE_REFRESH_MS = 5_000;

/**
 * Machine-local mirror of the user's device grants.
 *
 * Every record is re-verified against the pinned root key on read, so the
 * mirror is a cache of signed facts, never a source of trust: a worker that
 * hands us a forged row gains nothing, and a worker that withholds a
 * revocation is bounded by the grant TTL plus the poll interval.
 */
export class DeviceRegistry {
  private readonly cache = new Map<string, MirroredDevice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private lastUnknownRefresh = 0;

  constructor(private readonly options: DeviceRegistryOptions) {
    this.load();
  }

  /** Pull the vault once, then keep polling. Errors leave the last good mirror in place. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.pollMs ?? 30_000);
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const records = await this.options.authority.listDeviceGrants();
        this.store(records);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Verified, current grant for a device, refreshing once when a signed request names an unknown one (fresh enrollment). */
  async lookup(deviceId: string): Promise<VerifiedDevice | null> {
    const cached = this.cache.get(deviceId);
    if (cached) return this.current(cached);
    const now = Date.now();
    // A fresh browser fires its first requests concurrently: they all miss the
    // cache, one refresh runs, and the rest wait for it rather than failing.
    if (this.inflight) {
      await this.inflight;
    } else if (now - this.lastUnknownRefresh >= UNKNOWN_DEVICE_REFRESH_MS) {
      this.lastUnknownRefresh = now;
      await this.refresh();
    }
    const found = this.cache.get(deviceId);
    return found ? this.current(found) : null;
  }

  list(): MirroredDevice[] {
    return [...this.cache.values()].map((entry) => ({ record: entry.record, verified: this.current(entry) }));
  }

  async revoke(deviceId: string): Promise<{ deviceId: string; revokedAt: number }> {
    const result = await this.options.authority.revokeDeviceGrant(deviceId);
    const cached = this.cache.get(deviceId);
    if (cached) this.store([{ ...cached.record, revokedAt: result.revokedAt, generation: cached.record.generation + 1 }]);
    return result;
  }

  private current(entry: MirroredDevice): VerifiedDevice | null {
    // Re-run the full check so a TTL lapsing between polls, or an issuer
    // revoked since, is honoured without waiting for the next store.
    return this.verify(entry.record);
  }

  private verify(record: DeviceGrantRecord): VerifiedDevice | null {
    return verifyDeviceGrantRecord(record, this.options.rootSigningPublicKey, Date.now(), (deviceId) => this.cache.get(deviceId)?.record ?? null);
  }

  private load(): void {
    for (const row of this.options.database.orm.select().from(deviceGrants).all()) {
      const parsed = deviceGrantRecordSchema.safeParse(JSON.parse(row.recordJson));
      if (!parsed.success) continue;
      this.cache.set(row.deviceId, { record: { ...parsed.data, generation: row.generation, revokedAt: row.revokedAt }, verified: null });
    }
    // Issuers may load after their delegates; verify once everything is present.
    for (const entry of this.cache.values()) entry.verified = this.verify(entry.record);
  }

  private store(records: DeviceGrantRecord[]): void {
    const now = new Date().toISOString();
    for (const record of records) {
      const parsed = deviceGrantRecordSchema.safeParse(record);
      if (!parsed.success) continue;
      const deviceId = parsed.data.binding.deviceId;
      const existing = this.cache.get(deviceId);
      // Generations only move forward; a stale listing can't resurrect a revoked grant.
      if (existing && existing.record.generation > parsed.data.generation) continue;
      this.cache.set(deviceId, { record: parsed.data, verified: null });
      this.options.database.orm.insert(deviceGrants).values({
        deviceId,
        kind: parsed.data.invite.invite.kind,
        recordJson: JSON.stringify(parsed.data),
        generation: parsed.data.generation,
        revokedAt: parsed.data.revokedAt,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: deviceGrants.deviceId,
        set: { recordJson: JSON.stringify(parsed.data), generation: parsed.data.generation, revokedAt: parsed.data.revokedAt, updatedAt: now },
      }).run();
    }
    for (const deviceId of [...this.cache.keys()]) {
      if (records.some((record) => record.binding.deviceId === deviceId)) continue;
      this.cache.delete(deviceId);
      this.options.database.orm.delete(deviceGrants).where(eq(deviceGrants.deviceId, deviceId)).run();
    }
    for (const entry of this.cache.values()) entry.verified = this.verify(entry.record);
  }
}
