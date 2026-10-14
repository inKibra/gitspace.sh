import { deviceGrantRecordSchema, verifyDeviceGrantRecord, type DeviceGrantRecord, type VerifiedDevice } from '@gitspace/protocol';

export interface DeviceGrantAuthority {
  listDeviceGrants(): Promise<DeviceGrantRecord[]>;
}

export interface DeviceRegistryOptions {
  authority: DeviceGrantAuthority;
  rootSigningPublicKey: Uint8Array;
  onError?: (error: unknown) => void;
}

const UNKNOWN_DEVICE_REFRESH_MS = 5_000;

/**
 * In-memory view of the user's device grants, fetched when a signed request needs it.
 *
 * Every record is re-verified against the pinned root key on read, so the view
 * is a cache of signed facts, never a source of trust: a worker that hands us a
 * forged row gains nothing, and a withheld revocation is bounded by the grant
 * TTL. The listing stays current until a `devices` notice (or a relay
 * reconnection) invalidates it.
 */
export class DeviceRegistry {
  private readonly grants = new Map<string, DeviceGrantRecord>();
  private fetchedAt: number | null = null;
  private invalidations = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: DeviceRegistryOptions) {}

  /** The cloud changed a device grant: the next lookup refetches the listing. */
  invalidate(): void {
    this.fetchedAt = null;
    this.invalidations += 1;
  }

  /** Verified, current grant for a device; refetches an invalidated listing, or an unknown device (fresh enrollment) at most every 5s. */
  async lookup(deviceId: string): Promise<VerifiedDevice | null> {
    if (this.fetchedAt === null || (!this.grants.has(deviceId) && Date.now() - this.fetchedAt >= UNKNOWN_DEVICE_REFRESH_MS)) await this.refresh();
    const record = this.grants.get(deviceId);
    return record ? verifyDeviceGrantRecord(record, this.options.rootSigningPublicKey, Date.now(), (issuer) => this.grants.get(issuer) ?? null) : null;
  }

  /** Concurrent first requests share one fetch; a failed fetch keeps the last good listing. A listing read while an
   * invalidation arrived is read again, since it may predate the change. */
  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        let invalidations: number;
        do {
          invalidations = this.invalidations;
          const records = await this.options.authority.listDeviceGrants();
          const next = new Map<string, DeviceGrantRecord>();
          for (const record of records) {
            const parsed = deviceGrantRecordSchema.safeParse(record);
            if (!parsed.success) continue;
            const deviceId = parsed.data.binding.deviceId;
            // Generations only move forward; a stale listing can't resurrect a revoked grant.
            const existing = this.grants.get(deviceId);
            next.set(deviceId, existing && existing.generation > parsed.data.generation ? existing : parsed.data);
          }
          this.grants.clear();
          for (const [deviceId, record] of next) this.grants.set(deviceId, record);
        } while (invalidations !== this.invalidations);
        this.fetchedAt = Date.now();
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
