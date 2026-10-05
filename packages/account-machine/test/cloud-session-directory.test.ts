import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentSession } from '@gitspace/core';
import type { CanonicalSession } from '@gitspace/protocol';
import { CanonicalSessionOutbox, CloudCanonicalSessionWriter, type CanonicalSessionAuthority } from '../src/cloud-session-directory.js';
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
    activity: { active: false, reasons: [] }, health: { revision, issues: {} },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

const unusedBlobs = {
  put: async (): Promise<`sha256:${string}`> => { throw new Error('Unexpected checkpoint upload'); },
};

function outbox(): CanonicalSessionOutbox {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-canonical-outbox-'));
  roots.push(root);
  return new CanonicalSessionOutbox(join(root, 'canonical-session-outbox.json'));
}

function memoryAuthority(): CanonicalSessionAuthority & { records: Map<string, CanonicalSession> } {
  const records = new Map<string, CanonicalSession>();
  return {
    records,
    getCanonicalSession: async (projectId, sessionId) => records.get(JSON.stringify([projectId, sessionId])) ?? null,
    putCanonicalSession: async (projectId, input) => {
      const now = new Date().toISOString();
      const record = { ...input, revision: input.expectedRevision + 1, createdAt: now, updatedAt: now };
      records.set(JSON.stringify([projectId, input.id]), record);
      return record;
    },
  };
}

const storedHash = async (_key: string, bytes: Uint8Array): Promise<`sha256:${string}`> =>
  `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;

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
      health: { revision: 0, issues: {} },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const errors: unknown[] = [];
    const machineA = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error), outbox());
    machineA.put('project-a', 'machine-a', base, true);
    await machineA.flush();
    expect(canonical).toMatchObject({ machineId: 'machine-a', revision: 1, sessionObjectHash: expect.stringMatching(/^sha256:/u) });
    expect(await blobs.get(canonical!.sessionObjectKey!, canonical!.sessionObjectHash!)).toEqual(new Uint8Array(Buffer.from('{"type":"session","id":"omp-a"}\n')));

    const machineB = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error), outbox());
    machineB.put('project-a', 'machine-b', { ...base, state: 'closed' });
    await machineB.flush();
    expect(canonical).toMatchObject({ machineId: 'machine-b', state: 'closed', revision: 2 });
    expect(errors).toEqual([]);
  });

  it('coalesces a deferred status burst to the latest state with revision fencing', async () => {
    const authority = new DeferredAuthority();
    const errors: unknown[] = [];
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, (error) => errors.push(error), outbox());
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
    const writer = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error), outbox());
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
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => {}, outbox());
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
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, (error) => errors.push(error), outbox());
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

  it('isolates historical failures by publication project and workspace without acknowledging other scopes', async () => {
    const authority = new DeferredAuthority();
    const failed = Promise.withResolvers<void>();
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => failed.resolve(), outbox());
    const session = sessionFixture();
    const failure = new Error('Historical authority failure');
    writer.put('project-old', 'machine-a', session);
    (await authority.call(0)).fail(failure);
    await failed.promise;

    // The same workspace ID under another actual publication project is unrelated.
    writer.put('project-a', 'machine-a', session);
    const healthy = writer.flush({ projectId: 'project-a', spaceId: session.spaceId });
    (await authority.call(1)).succeed();
    await healthy;
    await writer.flush({ projectId: 'project-old', spaceId: 'workspace-other' });
    await expect(writer.flush()).rejects.toBe(failure);
    await writer.flush();
  });

  it('finishes a scoped barrier while unrelated publications remain in flight and ignores their failures', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => {}, outbox());
    const session = sessionFixture();
    writer.put('project-a', 'machine-a', { ...session, id: 'unrelated-failing', spaceId: 'workspace-other' });
    writer.put('project-a', 'machine-a', { ...session, id: 'unrelated-stalled', spaceId: 'workspace-other' });
    writer.put('project-a', 'machine-a', session);
    const scoped = writer.flush({ projectId: 'project-a', spaceId: session.spaceId });
    const failure = new Error('Unrelated in-flight failure');
    (await authority.call(0)).fail(failure);
    (await authority.call(2)).succeed();
    await scoped;
    const full = writer.flush().catch((error: unknown) => error);
    (await authority.call(1)).succeed();
    expect(await full).toBe(failure);
    await writer.flush();
  });

  it('retains each workspace failure when another scoped barrier acknowledges its own failure', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => {}, outbox());
    const session = sessionFixture();
    writer.put('project-a', 'machine-a', session);
    writer.put('project-a', 'machine-a', { ...session, id: 'session-b', spaceId: 'workspace-b' });
    const ownFailure = new Error('Own failure');
    const otherFailure = new Error('Other failure');
    const scoped = writer.flush({ projectId: 'project-a', spaceId: session.spaceId }).catch((error: unknown) => error);
    (await authority.call(1)).fail(otherFailure);
    (await authority.call(0)).fail(ownFailure);
    expect(await scoped).toBe(ownFailure);
    await expect(writer.flush()).rejects.toBe(otherFailure);
    await writer.flush();
  });

  it('rejects a workspace barrier for an earlier unacknowledged checkpoint upload failure', async () => {
    const authority = new DeferredAuthority();
    const failed = Promise.withResolvers<void>();
    const failure = new Error('Checkpoint upload failed');
    const writer = new CloudCanonicalSessionWriter(authority, {
      put: async () => { throw failure; },
    }, () => failed.resolve(), outbox());
    const session = sessionFixture();
    writer.put('project-a', 'machine-a', session, true);
    await failed.promise;
    writer.put('project-a', 'machine-a', { ...session, state: 'closed' });
    const scoped = writer.flush({ projectId: 'project-a', spaceId: session.spaceId }).catch((error: unknown) => error);
    (await authority.call(0)).succeed();
    expect(await scoped).toBe(failure);
    await writer.flush();
  });

  it('bounds concurrent authority work without conflating sessions from different projects', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => {}, outbox());
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
    const writer = new CloudCanonicalSessionWriter(authority, blobs, () => {}, outbox());
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

describe('canonical session outbox', () => {
  it('hands a same-machine successor every queued checkpoint without waiting for a stalled upload', async () => {
    const handoff = outbox();
    const uploading = Promise.withResolvers<void>();
    const writer = new CloudCanonicalSessionWriter(new DeferredAuthority(), {
      put: () => {
        uploading.resolve();
        return new Promise<never>(() => {});
      },
    }, () => {}, handoff);
    const queued = { ...sessionFixture(), id: 'session-b', ompSessionId: 'omp-b' };
    writer.put('project-a', 'machine-a', sessionFixture(), true);
    writer.put('project-b', 'machine-a', queued);
    writer.put('project-b', 'machine-a', queued, true);
    await uploading.promise;
    await writer.settle('replace');
    expect(await handoff.entries()).toEqual([
      { projectId: 'project-a', sessionId: 'session-a', checkpoint: true, token: expect.any(String) },
      { projectId: 'project-b', sessionId: 'session-b', checkpoint: true, token: expect.any(String) },
    ]);
  });

  it('still waits for the cloud and surfaces its failure when the machine releases its spaces', async () => {
    const handoff = outbox();
    const uploading = Promise.withResolvers<void>();
    const upload = Promise.withResolvers<`sha256:${string}`>();
    const writer = new CloudCanonicalSessionWriter(new DeferredAuthority(), {
      put: () => {
        uploading.resolve();
        return upload.promise;
      },
    }, () => {}, handoff);
    writer.put('project-a', 'machine-a', sessionFixture(), true);
    const stopping = writer.settle('release');
    await uploading.promise;
    const failure = new Error('upload failed');
    upload.reject(failure);
    await expect(stopping).rejects.toBe(failure);
    expect(await handoff.entries()).toEqual([]);
  });

  it('replays a predecessor outbox, retaining only entries whose publication failed', async () => {
    const handoff = outbox();
    await handoff.record([
      { projectId: 'project-a', sessionId: 'session-a', checkpoint: true },
      { projectId: 'project-a', sessionId: 'session-b', checkpoint: true },
      { projectId: 'project-a', sessionId: 'session-gone', checkpoint: true },
    ]);
    const local: Record<string, AgentSession> = {
      'session-a': sessionFixture(1),
      'session-b': { ...sessionFixture(2), id: 'session-b', ompSessionId: 'omp-b' },
    };
    const authority = memoryAuthority();
    const failure = new Error('upload failed');
    const errors: unknown[] = [];
    const successor = new CloudCanonicalSessionWriter(authority, {
      put: async (key, bytes) => {
        if (key.includes('/session-b/')) throw failure;
        return storedHash(key, bytes);
      },
    }, (error) => errors.push(error), handoff);
    await expect(successor.replay('machine-a', (sessionId) => local[sessionId] ?? null)).rejects.toBe(failure);
    expect(authority.records.get(JSON.stringify(['project-a', 'session-a']))).toMatchObject({
      machineId: 'machine-a', sessionFormatVersion: 'omp-checkpoint-1', health: { revision: 1 },
    });
    expect(authority.records.has(JSON.stringify(['project-a', 'session-b']))).toBe(false);
    expect((await handoff.entries()).map((entry) => entry.sessionId)).toEqual(['session-b']);
    expect(errors).toEqual([failure]);

    const nextStartup = new CloudCanonicalSessionWriter(authority, { put: storedHash }, () => {}, handoff);
    await nextStartup.replay('machine-a', (sessionId) => local[sessionId] ?? null);
    expect(authority.records.get(JSON.stringify(['project-a', 'session-b']))).toMatchObject({ sessionFormatVersion: 'omp-checkpoint-1' });
    expect(await handoff.entries()).toEqual([]);
  });

  it('drains only the requested sessions and keeps a handoff recorded while its older entry was replaying', async () => {
    const handoff = outbox();
    await handoff.record([
      { projectId: 'project-a', sessionId: 'session-a', checkpoint: false },
      { projectId: 'project-a', sessionId: 'session-b', checkpoint: true },
    ]);
    const local: Record<string, AgentSession> = {
      'session-a': sessionFixture(),
      'session-b': { ...sessionFixture(), id: 'session-b', ompSessionId: 'omp-b' },
    };
    const authority = new DeferredAuthority();
    const writer = new CloudCanonicalSessionWriter(authority, unusedBlobs, () => {}, handoff);
    const draining = writer.replay('machine-a', (sessionId) => local[sessionId] ?? null, ['session-a']);
    const publication = await authority.call(0);
    expect(publication.input.id).toBe('session-a');
    await handoff.record([{ projectId: 'project-a', sessionId: 'session-a', checkpoint: true }]);
    publication.succeed();
    await draining;
    expect(authority.calls).toHaveLength(1);
    expect(await handoff.entries()).toEqual([
      { projectId: 'project-a', sessionId: 'session-a', checkpoint: true, token: expect.any(String) },
      { projectId: 'project-a', sessionId: 'session-b', checkpoint: true, token: expect.any(String) },
    ]);
  });
});
