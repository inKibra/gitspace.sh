import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindControlOwner,
  ensureControlStore,
  getControlDbPath,
  getLegacyControlMetaPath,
  listCloudWorkspaces,
  readControlMeta,
} from './store.js';

let originalHome: string | undefined;
let originalControlDirOverride: string | undefined;
let testHomeDir: string;

describe('control store', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-control-store-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');
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

  test('initializes sqlite control store with default metadata', () => {
    const meta = ensureControlStore();

    expect(existsSync(getControlDbPath())).toBe(true);
    expect(meta.schemaVersion).toBe(2);
    expect(meta.createdAt.length).toBeGreaterThan(0);
    expect(meta.updatedAt.length).toBeGreaterThan(0);
    expect(meta.ownerIdentityId).toBeUndefined();
  });

  test('binds owner once and rejects different owner identity', () => {
    const first = bindControlOwner('owner-1');
    expect(first.bound).toBe(true);
    expect(first.ownerIdentityId).toBe('owner-1');

    const second = bindControlOwner('owner-1');
    expect(second.bound).toBe(false);

    expect(() => bindControlOwner('owner-2')).toThrow(/owner mismatch/i);
  });

  test('imports legacy meta owner into sqlite control store', () => {
    const legacyMetaPath = getLegacyControlMetaPath();
    mkdirSync(join(testHomeDir, '.relay', 'control'), { recursive: true });
    writeFileSync(
      legacyMetaPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          ownerIdentityId: 'legacy-owner',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        null,
        2
      ),
      'utf-8'
    );

    ensureControlStore();
    const meta = readControlMeta();

    expect(meta.ownerIdentityId).toBe('legacy-owner');
  });

  test('lists cloud workspaces as empty by default', () => {
    ensureControlStore();
    const workspaces = listCloudWorkspaces();
    expect(workspaces).toEqual([]);
  });
});
