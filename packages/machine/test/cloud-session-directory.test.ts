import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentSession } from '@gitspace/core';
import type { CanonicalSession } from '@gitspace/protocol';
import { CloudCanonicalSessionWriter } from '../src/cloud-session-directory.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    const blobs = {
      put: async (key: string, bytes: Uint8Array): Promise<`sha256:${string}`> => {
        objects.set(key, bytes.slice());
        return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
      },
    };
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const errors: unknown[] = [];
    const machineA = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error));
    machineA.put('project-a', 'machine-a', base, true);
    await machineA.flush();
    expect(canonical).toMatchObject({ machineId: 'machine-a', revision: 1, sessionObjectHash: expect.stringMatching(/^sha256:/u) });
    expect(objects.get(canonical!.sessionObjectKey!)).toEqual(new Uint8Array(Buffer.from('{"type":"session","id":"omp-a"}\n')));

    const machineB = new CloudCanonicalSessionWriter(authority, blobs, (error) => errors.push(error));
    machineB.put('project-a', 'machine-b', { ...base, state: 'closed' });
    await machineB.flush();
    expect(canonical).toMatchObject({ machineId: 'machine-b', state: 'closed', revision: 2 });
    expect(errors).toEqual([]);
  });
});
