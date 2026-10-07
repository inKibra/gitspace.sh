import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';
import { RuntimeGitCheckpointSchema, RuntimeToolResultSchema } from '@gitspace/protocol-runtime';
import { wranglerWorkerModules } from './search-wasm.js';

// Exercise the production bundler and fetch implementation, not Bun's Node-compatible fetch.
// All outbound requests terminate at a disposable local native Git receive-pack process.
test('workerd publishes a successor snapshot and rejects redirects without forwarding credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitspace-worker-git-'));
  let worker: Miniflare | undefined;
  try {
    await git.init({ fs, dir });
    const identity = { name: 'Local proof', email: 'local@example.invalid', timestamp: 1, timezoneOffset: 0 };
    const blob = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode('before\n') });
    const tree = await git.writeTree({ fs, dir, tree: [{ mode: '100644', path: 'file.txt', oid: blob, type: 'blob' }] });
    const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author: identity, committer: identity, message: 'local base\n' } });
    const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/spaces/worker-proof/checkpoints', branch: 'main', headCommit: commit, indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: tree, worktreeTree: tree });
    await git.writeRef({ fs, dir, ref: 'refs/heads/main', value: commit });
    await git.writeRef({ fs, dir, ref: checkpoint.checkpointRef, value: commit });
    const metadata = { hash: commit, treeHash: tree, parents: [], message: 'local base\n', author: identity, committer: identity, authoredAt: 1, committedAt: 1 };
    const source = `import { writeArtifactsSnapshot } from ${JSON.stringify(new URL('../src/artifacts-snapshot.ts', import.meta.url).pathname)};
import { CloudFileStore } from ${JSON.stringify(new URL('../src/cloud-files.ts', import.meta.url).pathname)};
import { DurableObject } from 'cloudflare:workers';
const prior=${JSON.stringify(checkpoint)}, metadata=${JSON.stringify(metadata)};
export class CloudMutationProof extends DurableObject {
  async fetch(request) {
    const { initial, input } = await request.json();
    const object = async (kind, oid, path) => fetch('https://local-git.invalid/object', { method: 'POST', body: JSON.stringify({ kind, oid, path }) });
    const repo = {
      readCommit: async oid => (await object('commit', oid)).json(),
      readTree: async oid => (await object('tree', oid)).json(),
      info: async () => ({ remote: 'https://local-git.invalid/repo.git' }),
      createToken: async () => ({ id: 'cloud-proof', plaintext: 'LOCAL-ONLY' }),
      revokeToken: async () => true,
    };
    const unsupported = async () => { throw Error('Unexpected machine or LFS operation'); };
    const code = {
      readFile: async (_repository, oid, path) => { const response = await object('file', oid, path); return response.status === 404 ? null : response.blob(); },
      writeSnapshot: input => writeArtifactsSnapshot(repo, input),
      mergeSnapshot: unsupported,
      listSnapshotPaths: async (_repository, oid) => (await (await object('tree', oid)).json()).map(entry => entry.name),
      listSnapshotEntries: async (_repository, oid) => new Map((await (await object('tree', oid)).json()).map(entry => [entry.name, { oid: entry.hash, mode: entry.mode, type: entry.type }])),
      readBlob: async (_repository, oid) => { const response = await object('blob', oid); return response.status === 404 ? null : response.blob(); },
    };
    const store = new CloudFileStore(this.ctx.storage, { list: () => [] }, code, 'worker-proof', () => {}, { has: unsupported, get: unsupported, put: unsupported }, async () => {}, async () => initial);
    const result = await store.execute(input);
    return Response.json({ result, checkpoint: await store.snapshot() });
  }
}
export default {async fetch(request, env){if(new URL(request.url).pathname==='/cloud')return env.CLOUD.getByName('cloud').fetch(request);let reads=0, revoked=0;
const repo={readCommit:async oid=>{if(oid!==prior.worktreeCommit)throw Error('Unexpected commit');return metadata},readTree:async oid=>{reads++;if(oid!==prior.worktreeTree)throw Error('Unexpected hydration');return [{name:'file.txt',hash:${JSON.stringify(blob)},mode:'100644',type:'blob'}]},info:async()=>({remote:'https://local-git.invalid/repo.git'}),createToken:async()=>({id:'proof',plaintext:'LOCAL-ONLY'}),revokeToken:async()=>{revoked++;return true}};
const result=await writeArtifactsSnapshot(repo,{repository:'local',workspaceId:'worker-proof',previous:prior,mutations:[{path:'file.txt',content:new TextEncoder().encode('after from workerd\\n')}]});return Response.json(result.isErr()?{error:result.error.message,certainty:result.error.certainty,revoked}:{checkpoint:result.value,reads,revoked},{status:result.isErr()?500:200});}};`;
    const entry = join(dir, 'worker.ts');
    await writeFile(entry, source);
    const config = join(dir, 'wrangler.json');
    await writeFile(config, JSON.stringify({ name: 'local-snapshot-proof', main: entry, compatibility_date: '2026-03-02', compatibility_flags: ['nodejs_compat'] }));
    const build = Bun.spawn([process.execPath, 'x', 'wrangler', 'deploy', '--dry-run', '--config', config, '--outdir', join(dir, 'bundle')], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    build.stdin.end();
    const [buildOut, buildErr, buildExit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
    assert.equal(buildExit, 0, buildOut + buildErr);
    let redirect: 'discovery' | 'push' | null = 'discovery';
    worker = new Miniflare({ modules: await wranglerWorkerModules(join(dir, 'bundle'), 'worker.js'), modulesRoot: join(dir, 'bundle'), compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { CLOUD: { className: 'CloudMutationProof', useSQLite: true } }, outboundService: async (request: WorkerRequest) => {
      const url = new URL(request.url);
      assert.equal(url.host, 'local-git.invalid', 'Never follow redirects or contact a live provider');
      if (url.pathname === '/object') {
        const input = z.object({ kind: z.enum(['commit', 'tree', 'file', 'blob']), oid: z.string(), path: z.string().optional() }).parse(await request.json());
        if (input.kind === 'commit') {
          const value = (await git.readCommit({ fs, dir, oid: input.oid })).commit;
          return WorkerResponse.json({ hash: input.oid, treeHash: value.tree, parents: value.parent, message: value.message, author: value.author, committer: value.committer, authoredAt: value.author.timestamp, committedAt: value.committer.timestamp });
        }
        if (input.kind === 'tree') return WorkerResponse.json((await git.readTree({ fs, dir, oid: input.oid })).tree.map(entry => ({ name: entry.path, hash: entry.oid, mode: entry.mode, type: entry.type })));
        try { return new WorkerResponse(Uint8Array.from((await git.readBlob({ fs, dir, oid: input.oid, filepath: input.path })).blob)); }
        catch (error) { if (error instanceof git.Errors.NotFoundError) return new WorkerResponse(null, { status: 404 }); throw error; }
      }
      assert.equal(request.headers.get('authorization'), 'Bearer LOCAL-ONLY');
      const advertise = url.pathname.endsWith('/info/refs');
      assert(advertise || url.pathname.endsWith('/git-receive-pack'));
      if ((advertise && redirect === 'discovery') || (!advertise && redirect === 'push')) return new WorkerResponse(null, { status: 302, headers: { Location: 'https://forbidden.invalid/credentials' } });
      const child = Bun.spawn(['git', 'receive-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), dir], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      if (!advertise) child.stdin.write(new Uint8Array(await request.arrayBuffer()));
      child.stdin.end();
      const [bytes, error, exit] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
      assert.equal(exit, 0, error);
      return new WorkerResponse(bytes);
    } });
    const failureSchema = z.object({ error: z.string(), certainty: z.enum(['not-published', 'unknown']), revoked: z.number() });
    const discovery = await worker.dispatchFetch('http://proof/');
    assert.equal(discovery.status, 500);
    const discoveryError = failureSchema.parse(await discovery.json());
    assert.match(discoveryError.error, /Git discovery failed \(302\)/u);
    assert.equal(discoveryError.certainty, 'not-published');
    assert.equal(discoveryError.revoked, 1);
    redirect = 'push';
    const push = await worker.dispatchFetch('http://proof/');
    assert.equal(push.status, 500);
    const pushError = failureSchema.parse(await push.json());
    assert.match(pushError.error, /Git push failed \(302\)/u);
    assert.equal(pushError.certainty, 'unknown');
    assert.equal(pushError.revoked, 1);
    redirect = null;
    const response = await worker.dispatchFetch('http://proof/');
    assert.equal(response.status, 200, await response.clone().text());
    const result = z.object({ checkpoint: RuntimeGitCheckpointSchema, reads: z.number(), revoked: z.number() }).parse(await response.json());
    assert.equal(result.checkpoint.headCommit, commit);
    assert.equal(result.checkpoint.indexCommit, commit);
    assert.equal(result.checkpoint.indexTree, tree);
    assert.equal(result.reads, 1);
    assert.equal(result.revoked, 1);
    assert.equal(await git.resolveRef({ fs, dir, ref: checkpoint.checkpointRef }), result.checkpoint.worktreeCommit);
    assert.equal((await git.readCommit({ fs, dir, oid: result.checkpoint.worktreeCommit })).commit.parent[0], commit);
    assert.equal(new TextDecoder().decode((await git.readBlob({ fs, dir, oid: result.checkpoint.worktreeCommit, filepath: 'file.txt' })).blob), 'after from workerd\n');
    const marked = '<<<<<<< cloud\nours\n=======\ntheirs\n>>>>>>> machine\n';
    const invoke = async (tool: string, args: unknown) => {
      const id = crypto.randomUUID();
      const response = await worker!.dispatchFetch('http://proof/cloud', { method: 'POST', body: JSON.stringify({ initial: result.checkpoint, input: { tool, args, requestId: id, attemptId: id } }) });
      assert.equal(response.status, 200, await response.clone().text());
      const value = z.object({ result: RuntimeToolResultSchema, checkpoint: RuntimeGitCheckpointSchema }).parse(await response.json());
      assert.equal(value.result.status, 'completed', JSON.stringify(value.result));
      return value.checkpoint;
    };
    for (const tool of ['write', 'edit', 'apply_patch'] as const) {
      const path = `${tool}.txt`;
      await invoke('write', { path, content: 'before\n' });
      const args = tool === 'write' ? { path, content: marked }
        : tool === 'edit' ? { path, edits: [{ oldText: 'before\n', newText: marked }] }
        : { patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-before\n${marked.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch` };
      const introduced = await invoke(tool, args);
      assert.deepEqual(introduced.conflicts, [path]);
      assert.equal(new TextDecoder().decode((await git.readBlob({ fs, dir, oid: introduced.worktreeCommit, filepath: path })).blob), marked);
      const partial = await invoke('edit', { path, edits: [{ oldText: '<<<<<<< cloud\n', newText: '' }] });
      assert.deepEqual(partial.conflicts, [path]);
      const resolved = await invoke('write', { path, content: 'resolved\n' });
      assert.deepEqual(resolved.conflicts, []);
    }
  } finally {
    await worker?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
