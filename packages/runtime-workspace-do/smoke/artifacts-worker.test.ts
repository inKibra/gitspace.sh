import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';

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
const prior=${JSON.stringify(checkpoint)}, metadata=${JSON.stringify(metadata)};
export default {async fetch(){let reads=0, revoked=0;
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
    const contents = await Bun.file(join(dir, 'bundle/worker.js')).text();
    let redirect: 'discovery' | 'push' | null = 'discovery';
    worker = new Miniflare({ modules: [{ type: 'ESModule', path: join(dir, 'worker.js'), contents }], modulesRoot: dir, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], outboundService: async (request: WorkerRequest) => {
      const url = new URL(request.url);
      assert.equal(url.host, 'local-git.invalid', 'Never follow redirects or contact a live provider');
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
  } finally {
    await worker?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
