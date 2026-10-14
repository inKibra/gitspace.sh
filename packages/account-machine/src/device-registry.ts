import { deviceGrantRecordSchema, verifyDeviceGrantRecord, type DeviceGrantRecord, type VerifiedDevice } from '@gitspace/protocol';

export interface DeviceGrantAuthority {
  listDeviceGrants(): Promise<DeviceGrantRecord[]>;
}

export interface DeviceRegistryOptions {
  authority: DeviceGrantAuthority;
  rootSigningPublicKey: Uint8Array;
  /** How long a fetched grant listing answers lookups before the next lookup refetches it. */
  maxAgeMs?: number;
  onError?: (error: unknown) => void;
}

const UNKNOWN_DEVICE_REFRESH_MS = 5_000;

/**
 * In-memory view of the user's device grants, fetched when a signed request needs it.
 *
 * Every record is re-verified against the pinned root key on read, so the view
 * is a cache of signed facts, never a source of trust: a worker that hands us a
 * forged row gains nothing, and a withheld revocation is bounded by the grant
 * TTL plus `maxAgeMs`.
 */
export class DeviceRegistry {
  private readonly grants = new Map<string, DeviceGrantRecord>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: DeviceRegistryOptions) {}

  /** Verified, current grant for a device; refetches a stale listing, or an unknown device (fresh enrollment) at most every 5s. */
  async lookup(deviceId: string): Promise<VerifiedDevice | null> {
    const age = Date.now() - this.fetchedAt;
    if (age >= (this.options.maxAgeMs ?? 30_000) || (!this.grants.has(deviceId) && age >= UNKNOWN_DEVICE_REFRESH_MS)) await this.refresh();
    const record = this.grants.get(deviceId);
    return record ? verifyDeviceGrantRecord(record, this.options.rootSigningPublicKey, Date.now(), (issuer) => this.grants.get(issuer) ?? null) : null;
  }

  /** Concurrent first requests share one fetch; a failed fetch keeps the last good listing. */
  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
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
