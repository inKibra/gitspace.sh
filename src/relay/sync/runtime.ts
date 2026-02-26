import { randomBytes } from "node:crypto";
import {
  getVaultCategory,
  listVaultCategories,
  upsertVaultCategory,
} from "../control/store.js";
import type { VaultSyncCategory } from "../control/types.js";

export type SyncCategory = VaultSyncCategory;

export const SYNC_CATEGORIES: SyncCategory[] = [
  "fundamental",
  "integrations",
  "project/workspace",
  "preferences",
];

const DEFAULT_LOCK_TTL_MS = 15_000;
const MIN_LOCK_TTL_MS = 1_000;
const MAX_LOCK_TTL_MS = 5 * 60 * 1_000;

export interface OwnerSyncRecord {
  ownerUserRootId: string;
  category: SyncCategory;
  revision: number;
  updatedAt: number;
  writerId: string;
  checksum: string;
  ciphertext: string;
}

export interface OwnerSyncPushInput {
  category: SyncCategory;
  expectedRevision: number;
  updatedAt: number;
  writerId: string;
  checksum: string;
  ciphertext: string;
}

export interface OwnerSyncLock {
  ownerUserRootId: string;
  scope: "global";
  lockId: string;
  holderWriterId: string;
  expiresAt: number;
}

export interface OwnerSyncRuntimeState {
  locks: Map<string, OwnerSyncLock>;
}

export interface CompareResult {
  serverRevisions: Record<SyncCategory, number>;
  changedCategories: SyncCategory[];
}

export class OwnerSyncRuntimeError extends Error {
  code: "CONFLICT" | "LOCKED" | "INVALID_REQUEST";

  constructor(code: "CONFLICT" | "LOCKED" | "INVALID_REQUEST", message: string) {
    super(message);
    this.code = code;
  }
}

function parseUpdatedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function toOwnerSyncRecord(ownerUserRootId: string, category: SyncCategory): OwnerSyncRecord | null {
  const record = getVaultCategory(category);
  if (!record) {
    return null;
  }

  return {
    ownerUserRootId,
    category,
    revision: record.revision,
    updatedAt: parseUpdatedAtMs(record.updatedAt),
    writerId: record.writerId,
    checksum: record.checksum,
    ciphertext: record.encryptedEnvelope,
  };
}

function normalizeCategories(categories?: SyncCategory[]): SyncCategory[] {
  if (!categories || categories.length === 0) {
    return [...SYNC_CATEGORIES];
  }

  const normalized: SyncCategory[] = [];
  for (const category of categories) {
    if (!SYNC_CATEGORIES.includes(category)) {
      throw new OwnerSyncRuntimeError("INVALID_REQUEST", `Unsupported sync category: ${category}`);
    }
    if (!normalized.includes(category)) {
      normalized.push(category);
    }
  }
  return normalized;
}

function createLockId(): string {
  return `lock-${randomBytes(8).toString("hex")}`;
}

function clampLockTtlMs(ttlMs?: number): number {
  if (ttlMs === undefined) {
    return DEFAULT_LOCK_TTL_MS;
  }
  if (!Number.isFinite(ttlMs)) {
    throw new OwnerSyncRuntimeError("INVALID_REQUEST", "Lock ttlMs must be a finite number");
  }

  const rounded = Math.floor(ttlMs);
  if (rounded < MIN_LOCK_TTL_MS) {
    return MIN_LOCK_TTL_MS;
  }
  if (rounded > MAX_LOCK_TTL_MS) {
    return MAX_LOCK_TTL_MS;
  }
  return rounded;
}

function getActiveLock(
  state: OwnerSyncRuntimeState,
  ownerUserRootId: string,
  nowMs: number,
): OwnerSyncLock | null {
  const existing = state.locks.get(ownerUserRootId);
  if (!existing) {
    return null;
  }

  if (existing.expiresAt <= nowMs) {
    state.locks.delete(ownerUserRootId);
    return null;
  }

  return existing;
}

export function createOwnerSyncRuntimeState(): OwnerSyncRuntimeState {
  return {
    locks: new Map<string, OwnerSyncLock>(),
  };
}

export function compareOwnerSync(
  ownerUserRootId: string,
  localRevisions?: Partial<Record<SyncCategory, number>>,
): CompareResult {
  const serverRevisions = {
    fundamental: 0,
    integrations: 0,
    "project/workspace": 0,
    preferences: 0,
  } satisfies Record<SyncCategory, number>;

  const records = listVaultCategories();
  for (const record of records) {
    serverRevisions[record.category] = record.revision;
  }

  const changedCategories: SyncCategory[] = [];
  for (const category of SYNC_CATEGORIES) {
    const localRevision = localRevisions?.[category] ?? 0;
    if (localRevision !== serverRevisions[category]) {
      changedCategories.push(category);
    }
  }

  void ownerUserRootId;
  return {
    serverRevisions,
    changedCategories,
  };
}

export function pullOwnerSync(
  ownerUserRootId: string,
  categories?: SyncCategory[],
): OwnerSyncRecord[] {
  const targetCategories = normalizeCategories(categories);
  const records: OwnerSyncRecord[] = [];
  for (const category of targetCategories) {
    const mapped = toOwnerSyncRecord(ownerUserRootId, category);
    if (mapped) {
      records.push(mapped);
    }
  }
  return records;
}

export function lockOwnerSync(
  state: OwnerSyncRuntimeState,
  ownerUserRootId: string,
  writerId: string,
  ttlMs?: number,
  nowMs = Date.now(),
): OwnerSyncLock {
  const ttl = clampLockTtlMs(ttlMs);
  const existing = getActiveLock(state, ownerUserRootId, nowMs);

  if (existing && existing.holderWriterId !== writerId) {
    throw new OwnerSyncRuntimeError(
      "LOCKED",
      `Owner sync lock is held by ${existing.holderWriterId}`,
    );
  }

  const lock: OwnerSyncLock = existing
    ? {
      ...existing,
      expiresAt: nowMs + ttl,
    }
    : {
      ownerUserRootId,
      scope: "global",
      lockId: createLockId(),
      holderWriterId: writerId,
      expiresAt: nowMs + ttl,
    };

  state.locks.set(ownerUserRootId, lock);
  return lock;
}

export function pushOwnerSync(
  state: OwnerSyncRuntimeState,
  ownerUserRootId: string,
  lockId: string,
  record: OwnerSyncPushInput,
  nowMs = Date.now(),
): { category: SyncCategory; revision: number; updatedAt: number } {
  const activeLock = getActiveLock(state, ownerUserRootId, nowMs);
  if (!activeLock) {
    throw new OwnerSyncRuntimeError("LOCKED", "Owner sync lock is required before push");
  }

  if (activeLock.lockId !== lockId) {
    throw new OwnerSyncRuntimeError("LOCKED", "Owner sync lock ID does not match active lock");
  }

  if (activeLock.holderWriterId !== record.writerId) {
    throw new OwnerSyncRuntimeError(
      "LOCKED",
      "Owner sync lock holder does not match push writer",
    );
  }

  if (!Number.isInteger(record.expectedRevision) || record.expectedRevision < 0) {
    throw new OwnerSyncRuntimeError("INVALID_REQUEST", "expectedRevision must be >= 0");
  }

  const existing = getVaultCategory(record.category);
  const currentRevision = existing?.revision ?? 0;
  if (currentRevision !== record.expectedRevision) {
    throw new OwnerSyncRuntimeError(
      "CONFLICT",
      `Expected revision ${record.expectedRevision} but current revision is ${currentRevision}`,
    );
  }

  const updated = upsertVaultCategory({
    category: record.category,
    encryptedEnvelope: record.ciphertext,
    writerId: record.writerId,
    checksum: record.checksum,
    expectedRevision: record.expectedRevision,
  });

  return {
    category: updated.category,
    revision: updated.revision,
    updatedAt: parseUpdatedAtMs(updated.updatedAt),
  };
}

export function unlockOwnerSync(
  state: OwnerSyncRuntimeState,
  ownerUserRootId: string,
  lockId: string,
  nowMs = Date.now(),
): boolean {
  const activeLock = getActiveLock(state, ownerUserRootId, nowMs);
  if (!activeLock) {
    return false;
  }

  if (activeLock.lockId !== lockId) {
    return false;
  }

  return state.locks.delete(ownerUserRootId);
}

export interface TimestampedCategoryEntry {
  updatedAt: number;
  value: unknown;
}

export type TimestampedCategoryPayload = Record<string, TimestampedCategoryEntry>;

function compareStringsDeterministic(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort(compareStringsDeterministic);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`).join(",")}}`;
}

/**
 * Deterministic last-write merge per key for decrypted category payloads.
 *
 * For each key:
 * - higher `updatedAt` wins
 * - ties use stable value serialization as deterministic tiebreaker
 */
export function mergeCategoryPayloadByTimestamp(
  base: TimestampedCategoryPayload,
  incoming: TimestampedCategoryPayload,
): TimestampedCategoryPayload {
  const merged: TimestampedCategoryPayload = { ...base };
  const keys = Object.keys(incoming).sort(compareStringsDeterministic);

  for (const key of keys) {
    const candidate = incoming[key];
    const current = merged[key];
    if (!candidate) {
      continue;
    }

    if (!current) {
      merged[key] = candidate;
      continue;
    }

    if (candidate.updatedAt > current.updatedAt) {
      merged[key] = candidate;
      continue;
    }

    if (candidate.updatedAt < current.updatedAt) {
      continue;
    }

    const candidateSerialized = stableSerialize(candidate.value);
    const currentSerialized = stableSerialize(current.value);
    if (compareStringsDeterministic(candidateSerialized, currentSerialized) > 0) {
      merged[key] = candidate;
    }
  }

  return merged;
}
