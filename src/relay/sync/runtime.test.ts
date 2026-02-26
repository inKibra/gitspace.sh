import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlStore } from "../control/store.js";
import {
  compareOwnerSync,
  createOwnerSyncRuntimeState,
  lockOwnerSync,
  mergeCategoryPayloadByTimestamp,
  OwnerSyncRuntimeError,
  pullOwnerSync,
  pushOwnerSync,
  unlockOwnerSync,
} from "./runtime.js";

let originalHome: string | undefined;
let originalControlDirOverride: string | undefined;
let testHomeDir: string;

describe("owner sync runtime", () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), "gssh-owner-sync-runtime-"));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, ".relay", "control");
    ensureControlStore();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalControlDirOverride === undefined) {
      delete process.env.GITSPACE_CONTROL_DIR;
    } else {
      process.env.GITSPACE_CONTROL_DIR = originalControlDirOverride;
    }

    if (testHomeDir && existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  test("compare/pull/push lifecycle with lock and revision tracking", () => {
    const state = createOwnerSyncRuntimeState();
    const ownerUserRootId = "owner-root-1";

    const initialCompare = compareOwnerSync(ownerUserRootId, {
      fundamental: 0,
      integrations: 0,
      "project/workspace": 0,
      preferences: 0,
    });
    expect(initialCompare.changedCategories).toHaveLength(0);

    const lock = lockOwnerSync(state, ownerUserRootId, "writer-a", 15_000);
    const pushed = pushOwnerSync(state, ownerUserRootId, lock.lockId, {
      category: "preferences",
      expectedRevision: 0,
      updatedAt: Date.now(),
      writerId: "writer-a",
      checksum: "sha256:first",
      ciphertext: "dGVzdC1jaXBoZXJ0ZXh0LTE=",
    });

    expect(pushed.category).toBe("preferences");
    expect(pushed.revision).toBe(1);
    expect(unlockOwnerSync(state, ownerUserRootId, lock.lockId)).toBe(true);

    const drift = compareOwnerSync(ownerUserRootId, {
      fundamental: 0,
      integrations: 0,
      "project/workspace": 0,
      preferences: 0,
    });
    expect(drift.serverRevisions.preferences).toBe(1);
    expect(drift.changedCategories).toContain("preferences");

    const pulled = pullOwnerSync(ownerUserRootId, ["preferences"]);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]?.ownerUserRootId).toBe(ownerUserRootId);
    expect(pulled[0]?.revision).toBe(1);
    expect(pulled[0]?.writerId).toBe("writer-a");
  });

  test("rejects lock contention by another writer", () => {
    const state = createOwnerSyncRuntimeState();
    const ownerUserRootId = "owner-root-1";

    const lock = lockOwnerSync(state, ownerUserRootId, "writer-a", 15_000);
    expect(lock.holderWriterId).toBe("writer-a");

    expect(() => lockOwnerSync(state, ownerUserRootId, "writer-b", 15_000)).toThrow(
      /held by writer-a/i,
    );
  });

  test("rejects stale expected revision on push", () => {
    const state = createOwnerSyncRuntimeState();
    const ownerUserRootId = "owner-root-1";

    const lock = lockOwnerSync(state, ownerUserRootId, "writer-a", 15_000);
    pushOwnerSync(state, ownerUserRootId, lock.lockId, {
      category: "integrations",
      expectedRevision: 0,
      updatedAt: Date.now(),
      writerId: "writer-a",
      checksum: "sha256:1",
      ciphertext: "dGVzdC1jaXBoZXJ0ZXh0LTE=",
    });

    try {
      pushOwnerSync(state, ownerUserRootId, lock.lockId, {
        category: "integrations",
        expectedRevision: 0,
        updatedAt: Date.now(),
        writerId: "writer-a",
        checksum: "sha256:2",
        ciphertext: "dGVzdC1jaXBoZXJ0ZXh0LTI=",
      });
      throw new Error("Expected stale revision conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerSyncRuntimeError);
      const runtimeError = error as OwnerSyncRuntimeError;
      expect(runtimeError.code).toBe("CONFLICT");
    }
  });

  test("merge policy is deterministic last-write timestamp per key", () => {
    const base = {
      alpha: { updatedAt: 100, value: { text: "old" } },
      beta: { updatedAt: 200, value: { text: "keep" } },
      gamma: { updatedAt: 300, value: "tie-a" },
    };
    const incoming = {
      alpha: { updatedAt: 150, value: { text: "new" } },
      beta: { updatedAt: 100, value: { text: "older" } },
      gamma: { updatedAt: 300, value: "tie-b" },
      delta: { updatedAt: 50, value: { created: true } },
    };

    const merged = mergeCategoryPayloadByTimestamp(base, incoming);
    expect(merged.alpha.value).toEqual({ text: "new" });
    expect(merged.beta.value).toEqual({ text: "keep" });
    expect(merged.gamma.value).toEqual("tie-b");
    expect(merged.delta.value).toEqual({ created: true });
  });
});
