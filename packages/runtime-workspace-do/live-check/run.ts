import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { authorized, boundedFetch, lfsPointer, lfsRoundTrip, maxBytes, sha256 } from './protocol.js';
import { writeArtifactsSnapshot } from '../src/artifacts-snapshot.js';

const help = `Opt-in Artifacts binding/Git/LFS live probe (creates and RETAINS a disposable fork).
Offline: bun live-check/run.ts --help
Live, only after owner approval: bun live-check/run.ts --authorize-live --input /absolute/path/authorization.json
Input JSON: {"authorize":"create-disposable-fork-and-upload-lfs","namespace":"AUTHORIZED_NAMESPACE","sourceRepository":"SOURCE","forkRepository":"UNIQUE_DISPOSABLE_FORK","checkpoint":CANONICAL_CHECKPOINT_OBJECT,"probePath":"EXISTING_FILE","probeSha256":"EXPECTED_LOWERCASE_SHA256"}
Uses installed Wrangler 4.145.0 credentials (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN or existing Wrangler login).
No checkpoint/DO updates. No local Git writes. The fork is never auto-deleted.
Stdout is newline-delimited JSON evidence, including retained fork identity and safe failure stage.
Binding reads and real LFS support are unverified until an authorized run succeeds.
`;
function evidence(event: string, data: object): void { console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data })); }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(help); return; }
  // Gate before even reading inputs or importing Wrangler. Invalid argument combinations stay offline.
  if (args.length !== 3 || args[0] !== '--authorize-live' || args[1] !== '--input' || !args[2]) {
    evidence('offline', { networkAccess: false, reason: 'Use --help; explicit authorization and input are required' });
    process.exitCode = 2;
    return;
  }
  let stage = 'authorization';
  try {
    const inputFile = await readFile(args[2], 'utf8');
    await authorized(true, JSON.parse(inputFile), async authorization => {
      evidence('authorized', { namespace: authorization.namespace, sourceRepository: authorization.sourceRepository, retainedFork: authorization.forkRepository });
      const directory = await mkdtemp(join(tmpdir(), 'gitspace-artifacts-check-'));
      try {
        const configPath = join(directory, 'wrangler.json');
        await writeFile(configPath, JSON.stringify({ name: 'gitspace-artifacts-live-check', compatibility_date: '2026-10-01', artifacts: [{ binding: 'ARTIFACTS', namespace: authorization.namespace, remote: true }] }));
        stage = 'platform-proxy';
        process.env.WRANGLER_LOG = 'error';
        // Loading Wrangler itself can initialize provider tooling; keep the module-loading
        // boundary behind authorization so offline invocations cannot initialize bindings.
        const { getPlatformProxy } = await import('wrangler');
        const proxy = await getPlatformProxy<{ ARTIFACTS: Artifacts }>({ configPath, remoteBindings: true, persist: false, envFiles: [] });
        try {
          stage = 'source-binding-reads';
          using source = await proxy.env.ARTIFACTS.get(authorization.sourceRepository);
          const checkpoint = authorization.checkpoint;
          const headBefore = await source.log({ ref: 'HEAD', limit: 1 });
          const refBefore = await source.log({ ref: checkpoint.checkpointRef, limit: 1 });
          if (refBefore[0]?.hash !== checkpoint.worktreeCommit) throw new Error('Canonical checkpoint ref differs');
          const commit = await source.readCommit(checkpoint.worktreeCommit);
          if (!commit || commit.treeHash !== checkpoint.worktreeTree) throw new Error('Checkpoint tree differs');
          const tree = await source.readTree(commit.treeHash);
          if (!tree) throw new Error('Missing checkpoint tree');
          const history = await source.log({ ref: checkpoint.worktreeCommit, limit: 2 });
          if (history[0]?.hash !== commit.hash) throw new Error('Binding log differs');
          const probe = await source.readFile({ ref: checkpoint.worktreeCommit, path: authorization.probePath });
          if (!probe || probe.size > maxBytes) throw new Error('Probe missing or exceeds 1MiB');
          const digest = sha256(new Uint8Array(await probe.arrayBuffer()));
          if (digest !== authorization.probeSha256) throw new Error('Probe digest differs');
          const index = await source.readCommit(checkpoint.indexCommit);
          const head = checkpoint.headCommit === null ? null : await source.readCommit(checkpoint.headCommit);
          if (!index || (checkpoint.headCommit !== null && !head) || index.treeHash !== checkpoint.indexTree) throw new Error('HEAD/index checkpoint mismatch');
          evidence('binding-reads', { commit, tree, history, file: { path: authorization.probePath, sha256: digest, size: probe.size, type: probe.type }, head: head?.hash ?? null, index: index.hash, indexTree: index.treeHash });

          stage = 'fork-create';
          // fork() fails if the name exists. Never reuse or delete a repository by supplied name.
          evidence('fork-attempt', { namespace: authorization.namespace, retainedFork: authorization.forkRepository, deletion: 'owner-directed-only' });
          const fork = await source.fork(authorization.forkRepository, { defaultBranchOnly: false, readOnly: false, description: 'Authorized disposable GitSpace binding/Git/LFS verification' });
          evidence('fork-created', { id: fork.id, name: fork.name, namespace: authorization.namespace });
          let initialRevoked = false;
          try {
            using repo = await proxy.env.ARTIFACTS.get(fork.name);
            stage = 'fork-initial-token-revoke';
            initialRevoked = await repo.revokeToken(fork.token);
            if (!initialRevoked) throw new Error('Initial token revocation failed');
            const forkHeadBefore = await repo.log({ ref: 'HEAD', limit: 1 });
            const forkParent = await repo.readCommit(checkpoint.worktreeCommit);
            if (!forkParent || forkParent.treeHash !== checkpoint.worktreeTree) throw new Error('Fork does not contain checkpoint');
            const info = await repo.info();
            const payload = randomBytes(4096);
            stage = 'lfs-token-mint';
            const token = await repo.createToken('write', 60);
            let lfs;
            try {
              stage = 'lfs-upload-download';
              lfs = await lfsRoundTrip(info.remote, token.plaintext, payload);
              evidence('lfs-round-trip', lfs);
            } finally {
              if (!await repo.revokeToken(token.id)) throw new Error('LFS token revocation failed');
              evidence('token-revoked', { purpose: 'lfs' });
            }
            stage = 'snapshot-push';
            const probeDirectory = `gitspace-artifacts-probe-${randomUUID()}`;
            const pointer = lfsPointer(payload);
            const attrs = 'payload.bin filter=lfs diff=lfs merge=lfs -text\n';
            const minted = new Set<string>();
            try {
              const result = await writeArtifactsSnapshot({
                readCommit: oid => repo.readCommit(oid), readTree: oid => repo.readTree(oid), info: () => repo.info(),
                createToken: async (scope, ttl) => { const mintedToken = await repo.createToken(scope, ttl); minted.add(mintedToken.id); return mintedToken; },
                revokeToken: async id => { const revoked = await repo.revokeToken(id); if (!revoked) throw new Error('Writer token revocation failed'); minted.delete(id); return revoked; },
              }, { repository: fork.name, workspaceId: `probe-${randomUUID()}`, previous: checkpoint, mutations: [
                { path: `${probeDirectory}/payload.bin`, content: new TextEncoder().encode(pointer) },
                { path: `${probeDirectory}/.gitattributes`, content: new TextEncoder().encode(attrs) },
              ], signal: AbortSignal.timeout(120_000) }, boundedFetch(fetch));
              if (result.isErr()) throw new Error('Snapshot writer failed');
              const next = result.value;
              stage = 'snapshot-binding-verification';
              const snapshot = await repo.readCommit(next.worktreeCommit);
              if (!snapshot || snapshot.parents[0] !== checkpoint.worktreeCommit || snapshot.treeHash !== next.worktreeTree) throw new Error('Snapshot parent/tree mismatch');
              const ref = await repo.log({ ref: next.checkpointRef, limit: 2 });
              if (ref[0]?.hash !== next.worktreeCommit || ref[1]?.hash !== checkpoint.worktreeCommit) throw new Error('Published checkpoint history mismatch');
              const nextTree = await repo.readTree(next.worktreeTree);
              const subtreeEntry = nextTree?.find(entry => entry.name === probeDirectory);
              if (!subtreeEntry || subtreeEntry.type !== 'tree') throw new Error('Probe tree missing');
              const subtree = await repo.readTree(subtreeEntry.hash);
              const pointerEntry = subtree?.find(entry => entry.name === 'payload.bin');
              if (!pointerEntry) throw new Error('Pointer blob missing');
              const rawPointer = await repo.readBlob(pointerEntry.hash);
              const attributes = await repo.readFile({ ref: next.worktreeCommit, path: `${probeDirectory}/.gitattributes` });
              if (!rawPointer || rawPointer.size > 1024 || await rawPointer.text() !== pointer || !attributes || attributes.size > 1024 || await attributes.text() !== attrs) throw new Error('Published pointer/attributes mismatch');
              const forkHeadAfter = await repo.log({ ref: 'HEAD', limit: 1 });
              const sourceHeadAfter = await source.log({ ref: 'HEAD', limit: 1 });
              const sourceRefAfter = await source.log({ ref: checkpoint.checkpointRef, limit: 1 });
              if (forkHeadAfter[0]?.hash !== forkHeadBefore[0]?.hash || sourceHeadAfter[0]?.hash !== headBefore[0]?.hash || sourceRefAfter[0]?.hash !== refBefore[0]?.hash || next.headCommit !== checkpoint.headCommit || next.indexCommit !== checkpoint.indexCommit || next.indexTree !== checkpoint.indexTree) throw new Error('Source/HEAD/index preservation failed');
              evidence('snapshot-verified', { checkpoint: next, commit: snapshot, tree: nextTree, probeTree: subtree, history: ref, pointer: { blob: pointerEntry.hash, sha256: sha256(new TextEncoder().encode(pointer)), size: rawPointer.size, content: pointer }, attributes: { content: attrs, size: attributes.size }, sourcePreserved: true, headPreserved: true, indexPreserved: true });
            } finally {
              for (const id of minted) {
                if (!await repo.revokeToken(id)) throw new Error('Writer token cleanup failed');
              }
            }
            evidence('passed', { namespace: authorization.namespace, retainedFork: fork.name, forkId: fork.id, lfs, deletion: 'owner-directed-only' });
          } finally {
            if (!initialRevoked) {
              using cleanup = await proxy.env.ARTIFACTS.get(fork.name);
              if (!await cleanup.revokeToken(fork.token)) throw new Error('Initial token cleanup failed');
            }
          }
        } finally { await proxy.dispose(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  } catch {
    // Provider messages/URLs can contain credentials. Emit stage only, never raw exceptions.
    evidence('failed', { stage, reason: 'Check failed; no live success claimed. See prior evidence for retained fork identity. Missing LFS actions/support is a failure, not a skip.' });
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
