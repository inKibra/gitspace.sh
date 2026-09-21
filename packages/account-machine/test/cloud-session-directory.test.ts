import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentSession } from '@gitspace/core';
import type { CanonicalSession } from '@gitspace/protocol';
import { CloudCanonicalSessionWriter, type CanonicalSessionAuthority } from '../src/cloud-session-directory.js';
import { EncryptedCheckpointBlobStore } from '../src/portable-space-lifecycle.js';

const checkpointKey = new Uint8Array(32).fill(7);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type CanonicalInput = Parameters<CanonicalSessionAuthority['putCanonicalSession']>[1];
interface Publication {
  input: CanonicalInput;
  succeed: () => void;
  fail: (error: unknown) => void;
}

class DeferredAuthority implements CanonicalSessionAuthority {
  readonly calls: Publication[] = [];
  readonly records = new Map<string, CanonicalSession>();
  private readonly waiters = new Map<number, (call: Publication) => void>();

  async getCanonicalSession(projectId: string, sessionId: string): Promise<CanonicalSession | null> {
    return this.records.get(JSON.stringify([projectId, sessionId])) ?? null;
  }

  putCanonicalSession(projectId: string, input: CanonicalInput): Promise<CanonicalSession> {
    const completion = Promise.withResolvers<CanonicalSession>();
    const call: Publication = {
      input,
      succeed: () => {
        const key = JSON.stringify([projectId, input.id]);
        const current = this.records.get(key);
        expect(input.expectedRevision).toBe(current?.revision ?? 0);
        const now = new Date().toISOString();
        const canonical = { ...input, revision: input.expectedRevision + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
        this.records.set(key, canonical);
        completion.resolve(canonical);
      },
      fail: completion.reject,
    };
    const index = this.calls.push(call) - 1;
    this.waiters.get(index)?.(call);
    this.waiters.delete(index);
    return completion.promise;
  }

  call(index: number): Promise<Publication> {
    const existing = this.calls[index];
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<Publication>();
    this.waiters.set(index, resolve);
    return promise;
  }
}

function sessionFixture(revision = 0): AgentSession {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-cloud-session-'));
  roots.push(root);
  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, `{"type":"session","id":"omp-a","revision":${revision}}\n`);
  return {
    id: 'session-a', spaceId: 'workspace-a', ompSessionId: 'omp-a', sessionFile,
    state: 'active', lastEventOffset: 0, resumePending: false,
    activity: { active: false, reasons: [] }, health: { revision, issues: {} }, errorMessage: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

const unusedBlobs = {
  put: async (): Promise<`sha256:${string}`> => { throw new Error('Unexpected checkpoint upload'); },
};

describe('CloudCanonicalSessionWriter', () => {
  it('moves one canonical OMP session between two machine projections', async () => {
    let canonical: CanonicalSession | null = null;
    const objects = new Map<string, Uint8Array>();
    const authority = {
      getCanonicalSession: async () => canonical,
      putCanonicalSession: async (_projectId: string, input: Omit<CanonicalSession, 'revision' | 'createdAt' | 'updatedAt'> & { expectedRevision: number }) => {
        expect(input.expectedRevision).toBe(canonical?.revision ?? 0);
        const now = new Date().toISOString();
        canonical = { ...input, revision: input.expectedRevision + 1, createdAt: canonical?.createdAt ?? now, updatedAt: now };
        return canonical;
      },
    };
    const blobs = new EncryptedCheckpointBlobStore({
      get: async (key) => objects.get(key) ?? null,
      put: async (key: string, bytes: Uint8Array): Promise<`sha256:${string}`> => {
        objects.set(key, bytes.slice());
        return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
      },
    }, checkpointKey);
    const root = mkdtempSync(join(tmpdir(), 'gitspace-cloud-session-'));
    roots.push(root);
    const sessionFile = join(root, 'session.jsonl');
    writeFileSync(sessionFile, '{"type":"session","id":"omp-a"}\n');
    const base: AgentSession = {
      id: 'session-a',
      spaceId: 'workspace-a',
      ompSessionId: 'omp-a',
      sessionFile,
      state: 'active',
      lastEventOffset: 0,
      resumePending: false,
      activity: { active: false, reasons: [] },
      errorMessage: null,
      health: { revision: 0, issues: {} },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const errors: unknown[] = [];
    const machineA = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error));
    machineA.put('project-a', 'machine-a', base, true);
    await machineA.flush();
    expect(canonical).toMatchObject({ machineId: 'machine-a', revision: 1, sessionObjectHash: expect.stringMatching(/^sha256:/u) });
    expect(await blobs.get(canonical!.sessionObjectKey!, canonical!.sessionObjectHash!)).toEqual(new Uint8Array(Buffer.from('{"type":"session","id":"omp-a"}\n')));

    const machineB = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error));
    machineB.put('project-a', 'machine-b', { ...base, state: 'closed' });
    await machineB.flush();
    expect(canonical).toMatchObject({ machineId: 'machine-b', state: 'closed', revision: 2 });
    expect(errors).toEqual([]);
  });

  it('coalesces a deferred status burst to the latest state with revision fencing', async () => {
    const authority = new DeferredAuthority();
    const errors: unknown[] = [];
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, (error) => errors.push(error));
    const session = sessionFixture();
    writer.put('project-a', 'machine-a', session);
    const first = await authority.call(0);
    for (let revision = 1; revision <= 100; revision++) {
      writer.put('project-a', 'machine-a', { ...session, health: { revision, issues: {} } });
    }
    const flushed = writer.flush();
    expect(authority.calls).toHaveLength(1);
    first.succeed();
    const latest = await authority.call(1);
    expect(latest.input.health.revision).toBe(100);
    expect(latest.input.expectedRevision).toBe(1);
    latest.succeed();
    await flushed;
    expect(authority.calls).toHaveLength(2);
    expect(await writer.get('project-a', session.id)).toMatchObject({ health: { revision: 100 }, revision: 2 });
    expect(errors).toEqual([]);
  });

  it('preserves checkpoint barriers and blob pointers through intervening status changes', async () => {
    const authority = new DeferredAuthority();
    const errors: unknown[] = [];
    const uploaded = Promise.withResolvers<void>();
    const releaseUpload = Promise.withResolvers<void>();
    const objects = new Map<string, Uint8Array>();
    const blobs = new EncryptedCheckpointBlobStore({
      get: async (key) => objects.get(key) ?? null,
      put: async (key, bytes) => {
        if (objects.size === 0) {
          uploaded.resolve();
          await releaseUpload.promise;
        }
        objects.set(key, bytes);
        return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
      },
    }, checkpointKey);
    const writer = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error));
    const firstCheckpoint = sessionFixture(1);
    const secondCheckpoint = sessionFixture(3);
    writer.put('project-a', 'machine-a', sessionFixture());
    const initial = await authority.call(0);
    writer.put('project-a', 'machine-a', firstCheckpoint, true);
    writer.put('project-a', 'machine-a', { ...firstCheckpoint, health: { revision: 2, issues: {} } });
    writer.put('project-a', 'machine-a', secondCheckpoint, true);
    writer.put('project-a', 'machine-a', { ...secondCheckpoint, health: { revision: 4, issues: {} } });
    let settled = false;
    const flushed = writer.flush().then(() => { settled = true; });
    initial.succeed();
    await uploaded.promise;
    expect(authority.calls).toHaveLength(1);
    expect(settled).toBe(false);
    releaseUpload.resolve();
    const checkpointOne = await authority.call(1);
    expect(checkpointOne.input.health.revision).toBe(1);
    checkpointOne.succeed();
    const checkpointTwo = await authority.call(2);
    expect(checkpointTwo.input.health.revision).toBe(3);
    expect(checkpointTwo.input.sessionObjectKey).not.toBe(checkpointOne.input.sessionObjectKey);
    checkpointTwo.succeed();
    const latest = await authority.call(3);
    expect(latest.input).toMatchObject({
      health: { revision: 4 }, expectedRevision: 3,
      sessionObjectKey: checkpointTwo.input.sessionObjectKey,
      sessionObjectHash: checkpointTwo.input.sessionObjectHash,
    });
    latest.succeed();
    await flushed;
    expect(authority.calls).toHaveLength(4);
    expect(new TextDecoder().decode((await blobs.get(checkpointOne.input.sessionObjectKey!))!)).toContain('"revision":1');
    expect(new TextDecoder().decode((await blobs.get(checkpointTwo.input.sessionObjectKey!))!)).toContain('"revision":3');
    expect(errors).toEqual([]);
  });

  it('seals the status observed by flush without waiting for a later status', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => {});
    const session = sessionFixture();
    writer.put('project-a', 'machine-a', session);
    const initial = await authority.call(0);
    writer.put('project-a', 'machine-a', { ...session, health: { revision: 1, issues: {} } });
    const earlierFlush = writer.flush();
    writer.put('project-a', 'machine-a', { ...session, health: { revision: 2, issues: {} } });
    initial.succeed();
    const sealed = await authority.call(1);
    expect(sealed.input.health.revision).toBe(1);
    sealed.succeed();
    await earlierFlush;
    expect(await writer.get('project-a', session.id)).toMatchObject({ health: { revision: 1 } });
    const later = await authority.call(2);
    const laterFlush = writer.flush();
    expect(later.input.health.revision).toBe(2);
    later.succeed();
    await laterFlush;
  });

  it('rejects overlapping flushes for an earlier failure even when their latest state succeeds', async () => {
    const authority = new DeferredAuthority();
    const errors: unknown[] = [];
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, (error) => errors.push(error));
    const session = sessionFixture();
    writer.put('project-a', 'machine-a', session);
    const initial = await authority.call(0);
    writer.put('project-a', 'machine-a', { ...session, state: 'closed' });
    const firstFlush = writer.flush().catch((error: unknown) => error);
    const secondFlush = writer.flush().catch((error: unknown) => error);
    const failure = new Error('Authority unavailable');
    initial.fail(failure);
    const latest = await authority.call(1);
    expect(latest.input.expectedRevision).toBe(0);
    const thirdFlush = writer.flush().catch((error: unknown) => error);
    const fourthFlush = writer.flush().catch((error: unknown) => error);
    latest.succeed();
    expect(await firstFlush).toBe(failure);
    expect(await secondFlush).toBe(failure);
    expect(await thirdFlush).toBe(failure);
    expect(await fourthFlush).toBe(failure);
    expect(errors).toEqual([failure]);
    await writer.flush();
  });

  it('bounds concurrent authority work without conflating sessions from different projects', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => {});
    const session = sessionFixture();
    for (let index = 0; index < 12; index++) {
      writer.put(`project-${index % 2}`, 'machine-a', { ...session, id: `session-${Math.floor(index / 2)}` });
    }
    const flushed = writer.flush();
    await authority.call(3);
    expect(authority.calls).toHaveLength(4);
    for (let index = 0; index < 12; index++) (await authority.call(index)).succeed();
    await flushed;
    expect(authority.records.size).toBe(12);
  });
  it('round-trips a session larger than the application object limit through bounded checkpoints', async () => {
    const authority = new DeferredAuthority();
    const session = sessionFixture();
    const bytes = new Uint8Array(64 * 1024 * 1024 + 1).fill(97);
    writeFileSync(session.sessionFile, bytes);
    const objects = new Map<string, Uint8Array>();
    const blobs = new EncryptedCheckpointBlobStore({
      put: async (key, value) => {
        if (value.byteLength > 64 * 1024 * 1024) throw new Error('OBJECT_TOO_LARGE');
        objects.set(key, value);
        return `sha256:${new Bun.CryptoHasher('sha256').update(value).digest('hex')}`;
      },
      get: async (key) => objects.get(key) ?? null,
    }, checkpointKey);
    const writer = new CloudCanonicalSessionWriter(authority, blobs, () => {});
    writer.put('project-a', 'machine-a', session, true);
    const flushed = writer.flush();
    const checkpoint = await authority.call(0);
    checkpoint.succeed();
    await flushed;
    const saved = await writer.get('project-a', session.id);
    expect(saved!.sessionFormatVersion).toBe('omp-checkpoint-1');
    const restored = await blobs.get(saved!.sessionObjectKey!, saved!.sessionObjectHash!);
    expect(restored!.byteLength).toBe(bytes.byteLength);
    expect(new Bun.CryptoHasher('sha256').update(restored!).digest('hex'))
      .toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
    const chunk = [...objects.keys()].find((key) => key.includes('.chunks/'))!;
    objects.delete(chunk);
    await expect(blobs.get(saved!.sessionObjectKey!, saved!.sessionObjectHash!)).rejects.toThrow();
  });
});
