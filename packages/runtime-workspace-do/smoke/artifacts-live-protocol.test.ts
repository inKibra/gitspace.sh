import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { authorized, boundedBody, boundedFetch, maxBytes, scrubFailure, sha256, verifyPublishedRef } from '../live-check/protocol.js';
import { probe } from '../live-check/run.js';
import type { ArtifactsFetch, RuntimeGitCheckpoint } from '../src/artifacts-snapshot.js';

const hash = 'a'.repeat(40);
const authorization = {
  authorize: 'create-disposable-fork-and-push-snapshot', namespace: 'fixture', sourceRepository: 'source', forkRepository: 'disposable',
  checkpoint: { checkpointRef: 'refs/gitspace/spaces/source/checkpoints', headCommit: hash, branch: 'main', indexCommit: hash, trackedWorktreeCommit: hash, worktreeCommit: hash, indexTree: hash, worktreeTree: hash },
  probePath: 'README.md', probeSha256: 'b'.repeat(64),
};
const remote = 'https://git.example.invalid/repository.git';
const token = 'SECRET-REPOSITORY-TOKEN';
const encoder = new TextEncoder();
function packet(line: string): string { return (encoder.encode(line).length + 4).toString(16).padStart(4, '0') + line; }
function leaseFixture() {
  const revoked: string[] = [];
  const scopes: [string | undefined, number | undefined][] = [];
  const repo = {
    async info(): Promise<ArtifactsRepoInfo> { return { id: 'fixture', name: 'fixture', description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote }; },
    async createToken(scope?: 'read' | 'write', ttl?: number): Promise<ArtifactsCreateTokenResult> { scopes.push([scope, ttl]); return { id: 'lease', plaintext: token, scope: scope ?? 'write', expiresAt: '' }; },
    async revokeToken(id: string) { revoked.push(id); return true; },
  };
  return { repo, revoked, scopes };
}

describe('offline authorization and Node entrypoint', () => {
  test('no opt-in or invalid inputs cannot acquire bindings', async () => {
    let acquired = false;
    await expect(authorized(false, authorization, async () => { acquired = true; })).rejects.toThrow('Explicit --authorize-live');
    for (const input of [{}, { ...authorization, forkRepository: 'source' }, { ...authorization, probeSha256: '' }, { ...authorization, probePath: '../secret' }]) {
      await expect(authorized(true, input, async () => { acquired = true; })).rejects.toThrow();
    }
    expect(acquired).toBe(false);
  });
  test('Node 24 executes offline help and rejects unapproved live invocation', async () => {
    const entry = new URL('../live-check/entry.mjs', import.meta.url).pathname;
    const help = Bun.spawn(['node', entry, '--help'], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(help.stdout).text();
    const stderr = await new Response(help.stderr).text();
    expect(await help.exited, stderr).toBe(0);
    expect(output).toContain('node live-check/entry.mjs --authorize-live');
    expect(output).toContain('Artifacts namespace read/write permission');
    expect(output).toContain('does not verify the new R2 LFS model');
    const gated = Bun.spawn(['node', entry], { stdout: 'pipe', stderr: 'pipe' });
    expect(JSON.parse(await new Response(gated.stdout).text())).toMatchObject({ event: 'offline', networkAccess: false });
    expect(await gated.exited).toBe(2);
  });
});

describe('Git protocol ref verification and safe errors', () => {
  test('ls-remote verifies the exact checkpoint ref and revokes the short-lived read token', async () => {
    const f = leaseFixture();
    const secrets: string[] = [];
    const ref = authorization.checkpoint.checkpointRef;
    await verifyPublishedRef(f.repo, ref, hash, value => { secrets.push(value); }, async (url, init) => {
      expect(url).toBe(`${remote}/info/refs?service=git-upload-pack`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(init?.redirect).toBe('error');
      return new Response(packet('# service=git-upload-pack\n') + '0000' + packet(`${hash} ${ref}\0multi_ack\n`) + '0000');
    });
    expect(f.scopes).toEqual([['read', 60]]);
    expect(f.revoked).toEqual(['lease']);
    expect(secrets).toContain(token);
  });
  test('wrong ref, malformed packets, redirects and transport failures still revoke credentials', async () => {
    for (const request of [
      async () => new Response(packet('# service=git-upload-pack\n') + '0000' + packet(`${hash} refs/heads/main\n`) + '0000'),
      async () => new Response('ffffshort'),
      async () => new Response(null, { status: 307, headers: { Location: 'https://attacker.invalid/' } }),
      async () => { throw new Error('network unavailable'); },
    ]) {
      const f = leaseFixture();
      await expect(verifyPublishedRef(f.repo, authorization.checkpoint.checkpointRef, hash, () => {}, request)).rejects.toThrow();
      expect(f.revoked).toEqual(['lease']);
    }
  });
  test('failure reason preserves diagnosis but excludes tokens and credential URLs', () => {
    const reason = scrubFailure(new Error(`Git rejected (403): ${token} ${encodeURIComponent('secret/+')} https://user:password@host.invalid/path?token=other Bearer unregistered token=hidden`), [token, 'secret/+']);
    expect(reason).toContain('Git rejected (403)');
    for (const value of [token, 'secret', 'password', 'host.invalid', 'unregistered', 'hidden']) expect(reason).not.toContain(value);
  });
  test('bounds responses and rejects redirects without following them', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(maxBytes)); controller.enqueue(new Uint8Array(1)); controller.close(); } }));
    await expect(boundedBody(response)).rejects.toThrow('byte limit');
    await expect(boundedFetch(async () => new Response(null, { status: 302 }))(remote)).rejects.toThrow('redirect');
  });
});

test('complete offline probe accepts proxy handles without disposal and never queries unsupported binding refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifacts-live-offline-'));
  try {
    const sourceDir = join(root, 'source');
    await git.init({ fs, dir: sourceDir, defaultBranch: 'main' });
    const bytes = encoder.encode('fixture content\n');
    const blob = await git.writeBlob({ fs, dir: sourceDir, blob: bytes });
    const tree = await git.writeTree({ fs, dir: sourceDir, tree: [{ mode: '100644', path: 'README.md', oid: blob, type: 'blob' }] });
    const author = { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1, timezoneOffset: 0 };
    const commit = await git.writeCommit({ fs, dir: sourceDir, commit: { tree, parent: [], author, committer: author, message: 'initial\n' } });
    await git.writeRef({ fs, dir: sourceDir, ref: 'refs/heads/main', value: commit });
    const checkpoint: RuntimeGitCheckpoint = { ...authorization.checkpoint, headCommit: commit, worktreeCommit: commit, indexCommit: commit, trackedWorktreeCommit: commit, worktreeTree: tree, indexTree: tree };
    const refs: (string | undefined)[] = [];
    const leases = new Set<string>();
    const scopes: string[] = [];
    const events: string[] = [];
    const get = async (name: string): Promise<ArtifactsRepo> => {
      const dir = join(root, name);
      const repo: ArtifactsRepo = {
        [Symbol.dispose]() { throw new Error('Proxy must not expose disposal'); },
        async info() { return { ...(await leaseFixture().repo.info()), name }; },
        async listTokens() { throw new Error('Unexpected listTokens'); },
        async createToken(scope = 'write') { const id = `${scope}-${leases.size}`; leases.add(id); scopes.push(scope); return { id, plaintext: token, scope, expiresAt: '' }; },
        async revokeToken(id) { return leases.delete(id); },
        async readBlob(oid) { return new Blob([new Uint8Array((await git.readBlob({ fs, dir, oid })).blob)]); },
        async readCommit(oid) {
          const value = (await git.readCommit({ fs, dir, oid })).commit;
          return { hash: oid, treeHash: value.tree, parents: value.parent, message: value.message, author: value.author, committer: value.committer, authoredAt: value.author.timestamp, committedAt: value.committer.timestamp };
        },
        async readTree(oid) { return (await git.readTree({ fs, dir, oid })).tree.map(entry => ({ name: entry.path, hash: entry.oid, mode: entry.mode, type: entry.type === 'tree' ? 'tree' : 'blob' })); },
        async readFile({ ref, path }) { expect(ref).toMatch(/^[0-9a-f]{40}$/u); return new Blob([new Uint8Array((await git.readBlob({ fs, dir, oid: ref, filepath: path })).blob)]); },
        async log(options) {
          refs.push(options?.ref);
          if (options?.ref !== undefined && !/^[0-9a-f]{40}$/u.test(options.ref)) throw new Error('Unsupported binding ref');
          const entries = await git.log({ fs, dir, ref: options?.ref ?? 'HEAD', depth: options?.limit });
          return Promise.all(entries.map(entry => repo.readCommit(entry.oid))).then(values => values.filter(value => value !== null));
        },
        async fork(forkName) { await cp(dir, join(root, forkName), { recursive: true }); leases.add('initial'); return { id: 'fork', name: forkName, description: null, defaultBranch: 'main', remote, token: 'initial' }; },
      };
      return new Proxy(repo, { get(target, key, receiver) { return key === Symbol.dispose ? undefined : Reflect.get(target, key, receiver); } });
    };
    const request: ArtifactsFetch = async (url, init) => {
      const read = url.includes('git-upload-pack');
      const advertise = url.includes('/info/refs');
      const service = read ? 'upload-pack' : 'receive-pack';
      const child = Bun.spawn(['git', service, '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), join(root, 'disposable')], { stdin: advertise ? 'ignore' : new Response(init?.body).body, stdout: 'pipe', stderr: 'pipe' });
      const output = new Uint8Array(await new Response(child.stdout).arrayBuffer());
      const error = await new Response(child.stderr).text();
      if (await child.exited !== 0) throw new Error(error);
      return new Response(advertise ? new Blob([packet(`# service=git-${service}\n`), '0000', output]) : output);
    };
    await authorized(true, { ...authorization, checkpoint, probeSha256: sha256(bytes) }, value => probe({ get }, value, event => { events.push(event); }, () => {}, () => {}, request));
    expect(events).toContain('snapshot-verified');
    expect(events).toContain('passed');
    expect(scopes).toEqual(['write', 'read']);
    expect(leases.size).toBe(0);
    expect(refs.filter(ref => ref === undefined)).toHaveLength(4);
    expect(await git.resolveRef({ fs, dir: sourceDir, ref: 'HEAD' })).toBe(commit);
  } finally { await rm(root, { recursive: true, force: true }); }
});
