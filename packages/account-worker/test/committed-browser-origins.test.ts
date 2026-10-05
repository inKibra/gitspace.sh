import { describe, expect, it } from 'vitest';
import { approvedBrowserOrigins, browserOriginHash, emptyLifecycleState, transitionLifecycle } from '@gitspace/protocol-environment';
import type { RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import { committedBrowserOrigins } from '../src/committed-browser-origins.js';

type Source = Parameters<typeof committedBrowserOrigins>[0];
const head = 'a'.repeat(40);
const dirty = 'b'.repeat(40);
const next = 'c'.repeat(40);
const bundle = (...origins: string[]) => new Blob([JSON.stringify({ version: 1, profiles: { base: {} }, browser: { origins } })]);
function checkpoint(headCommit = head): RuntimeSnapshotCommitInput['checkpoint'] {
  return { checkpointRef: 'refs/gitspace/checkpoints/current', branch: 'feature', headCommit, indexCommit: dirty, trackedWorktreeCommit: dirty, worktreeCommit: dirty, indexTree: dirty, worktreeTree: dirty };
}
function fixture() {
  const files = new Map<string, Blob>([[head, bundle('example.com')], [dirty, bundle('*')], [next, bundle('changed.example.com')]]);
  const refs = new Map<string, string>([['refs/heads/main', head], ['refs/heads/feature', next]]);
  let recorded: RuntimeSnapshotCommitInput['checkpoint'] | null = checkpoint();
  const source: Source = {
    repository: 'workspace-project', branch: 'feature',
    checkpoint: async () => recorded,
    code: {
      resolveRef: async (_repository, ref) => refs.get(ref) ?? null,
      readFile: async (_repository, commit, path) => path === '.gitspace/bundle.json' ? files.get(commit) ?? null : null,
    },
  };
  return { source, files, refs, record(value: typeof recorded) { recorded = value; } };
}

describe('canonical committed browser origins', () => {
  it('uses recorded HEAD, never index, dirty worktree, or newer branch tip', async () => {
    const { source } = fixture();
    expect(await committedBrowserOrigins(source)).toEqual({ commit: head, origins: [{ pattern: 'example.com', hash: await browserOriginHash('example.com') }] });
  });

  it('resolves the canonical workspace branch, including base, only before a checkpoint exists', async () => {
    const { source, record } = fixture();
    record(null);
    expect((await committedBrowserOrigins(source)).origins.map(entry => entry.pattern)).toEqual(['changed.example.com']);
    expect((await committedBrowserOrigins({ ...source, branch: 'main' })).origins.map(entry => entry.pattern)).toEqual(['example.com']);
    expect(await committedBrowserOrigins({ ...source, branch: 'unborn' })).toEqual({ commit: null, origins: [] });
  });

  it('denies branch policy when a recorded checkpoint has an unborn HEAD', async () => {
    const { source, record } = fixture();
    record({ ...checkpoint(), headCommit: null });
    expect(await committedBrowserOrigins(source)).toEqual({ commit: null, origins: [] });
    record(checkpoint(next));
    expect((await committedBrowserOrigins(source)).origins.map(entry => entry.pattern)).toEqual(['changed.example.com']);
  });

  it('retries a changed HEAD rather than returning content read from the old commit', async () => {
    const { source, record } = fixture();
    const readFile = source.code.readFile;
    source.code.readFile = async (...args) => {
      const file = await readFile(...args);
      record(checkpoint(next));
      return file;
    };
    expect(await committedBrowserOrigins(source)).toEqual({ commit: next, origins: [{ pattern: 'changed.example.com', hash: await browserOriginHash('changed.example.com') }] });
  });

  it('retries a moving canonical branch before any checkpoint exists', async () => {
    const { source, record, refs } = fixture();
    record(null);
    const readFile = source.code.readFile;
    source.code.readFile = async (...args) => {
      const file = await readFile(...args);
      refs.set('refs/heads/feature', head);
      return file;
    };
    expect((await committedBrowserOrigins(source)).commit).toBe(head);
  });

  it('switches from a branch ref to a newly recorded checkpoint during the read', async () => {
    const { source, record } = fixture();
    record(null);
    const readFile = source.code.readFile;
    source.code.readFile = async (...args) => {
      const file = await readFile(...args);
      record(checkpoint());
      return file;
    };
    expect((await committedBrowserOrigins(source)).commit).toBe(head);
  });

  it('rejects continuously changing checkpoint heads', async () => {
    const { source, record } = fixture();
    const readFile = source.code.readFile;
    source.code.readFile = async (...args) => {
      record(checkpoint(args[1] === head ? next : head));
      return readFile(...args);
    };
    await expect(committedBrowserOrigins(source)).rejects.toMatchObject({ code: 'ContentChanged' });
  });

  it('does not recover missing, malformed, invalid, or failed reads from dirty policy', async () => {
    const { source, files } = fixture();
    files.delete(head);
    expect(await committedBrowserOrigins(source)).toEqual({ commit: head, origins: [] });
    files.set(head, new Blob(['{']));
    await expect(committedBrowserOrigins(source)).rejects.toMatchObject({ code: 'InvalidBundle' });
    files.set(head, bundle('https://example.com'));
    await expect(committedBrowserOrigins(source)).rejects.toMatchObject({ code: 'InvalidBundle' });
    source.code.readFile = async () => { throw new Error('remote unavailable'); };
    await expect(committedBrowserOrigins(source)).rejects.toThrow('remote unavailable');
  });

  it('keeps approvals independent and denies removed or changed patterns even in automatic mode', async () => {
    const { source, files } = fixture();
    files.set(head, bundle('example.com', 'other.example.com'));
    const loaded = await committedBrowserOrigins(source);
    const state = { ...emptyLifecycleState('project', 'workspace'), browserOrigins: loaded.origins, policy: { automatic: true } };
    const approvedHash = await browserOriginHash('example.com');
    const facts = { state, runs: [], actor: { actorId: 'human', machineId: 'browser', kind: 'browser' as const, lifecycleControl: true }, now: '2026-10-04T00:00:00.000Z', token: 'token' };
    expect(approvedBrowserOrigins(state)).toEqual([]);
    const approved = transitionLifecycle(facts, { op: 'approval', scope: 'workspace', executionHash: approvedHash, approved: true }).state;
    expect(approvedBrowserOrigins(approved)).toEqual(['example.com']);
    files.set(head, bundle('*.example.com', 'other.example.com'));
    const refreshed = { ...approved, browserOrigins: (await committedBrowserOrigins(source)).origins };
    expect(approvedBrowserOrigins(refreshed)).toEqual([]);
    expect(() => transitionLifecycle({ ...facts, state: refreshed }, { op: 'approval', scope: 'workspace', executionHash: approvedHash, approved: true })).toThrow();
    expect(() => transitionLifecycle({ ...facts, actor: { ...facts.actor, lifecycleControl: false } }, { op: 'approval', scope: 'workspace', executionHash: approvedHash, approved: true })).toThrow();
    files.delete(head);
    expect(approvedBrowserOrigins({ ...approved, browserOrigins: (await committedBrowserOrigins(source)).origins })).toEqual([]);
  });
});
