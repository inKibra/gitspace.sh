import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authorized, boundedFetch, maxBytes, scrubFailure, sha256, verifyPublishedRef, type Authorization } from './protocol.js';
import { writeArtifactsSnapshot } from '../src/artifacts-snapshot.js';
import type { ArtifactsFetch } from '../src/artifacts-snapshot.js';
import { disposeArtifactsRepository } from '../src/artifacts.js';

export const help = `Opt-in Artifacts binding/Git live probe (creates and RETAINS a disposable fork).
Requires Node 24 and installed workspace dependencies.
Offline: node live-check/entry.mjs --help
Live, only after owner approval: node live-check/entry.mjs --authorize-live --input /absolute/path/authorization.json
Input JSON: {"authorize":"create-disposable-fork-and-push-snapshot","namespace":"AUTHORIZED_NAMESPACE","sourceRepository":"SOURCE","forkRepository":"UNIQUE_DISPOSABLE_FORK","checkpoint":CANONICAL_CHECKPOINT_OBJECT,"probePath":"EXISTING_FILE","probeSha256":"EXPECTED_LOWERCASE_SHA256"}
Uses installed Wrangler 4.145.0 credentials (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN or existing Wrangler login).
Requires Artifacts namespace read/write permission: read source, create fork, mint/revoke repository tokens, and push Git snapshot objects/refs to the fork.
No checkpoint/DO updates. No local Git writes. The fork is never auto-deleted.
Stdout is newline-delimited JSON evidence, including retained fork identity and scrubbed failure reason.
HEAD uses binding log without a ref; checkpoint objects use stored commit IDs. Published checkpoint refs are checked through Git ls-remote.
This check does not verify the new R2 LFS model. Artifacts LFS is unsupported and is not probed.
`;
type Evidence = (event: string, data: object) => void;
/** Injectable binding and transport allow the complete probe to run against offline fixtures. */
export async function probe(binding: Pick<Artifacts, 'get'>, authorization: Authorization, evidence: Evidence, setStage: (stage: string) => void, rememberSecret: (secret: string) => void, request: ArtifactsFetch = fetch): Promise<void> {
  setStage('source-binding-reads');
  const source = await binding.get(authorization.sourceRepository);
  try {
    const checkpoint = authorization.checkpoint;
    const headBefore = await source.log({ limit: 1 });
    const commit = await source.readCommit(checkpoint.worktreeCommit);
    if (!commit || commit.treeHash !== checkpoint.worktreeTree) throw new Error('Checkpoint tree differs');
    const tree = await source.readTree(commit.treeHash);
    if (!tree) throw new Error('Missing checkpoint tree');
    const history = await source.log({ ref: checkpoint.worktreeCommit, limit: 2 });
    if (history[0]?.hash !== commit.hash) throw new Error('Binding log differs');
    const file = await source.readFile({ ref: checkpoint.worktreeCommit, path: authorization.probePath });
    if (!file || file.size > maxBytes) throw new Error('Probe missing or exceeds 1MiB');
    const digest = sha256(new Uint8Array(await file.arrayBuffer()));
    if (digest !== authorization.probeSha256) throw new Error('Probe digest differs');
    const index = await source.readCommit(checkpoint.indexCommit);
    const head = checkpoint.headCommit === null ? null : await source.readCommit(checkpoint.headCommit);
    if (!index || (checkpoint.headCommit !== null && !head) || index.treeHash !== checkpoint.indexTree) throw new Error('HEAD/index checkpoint mismatch');
    evidence('binding-reads', { commit, tree, history, file: { path: authorization.probePath, sha256: digest, size: file.size }, head: head?.hash ?? null, index: index.hash });

    setStage('fork-create');
    evidence('fork-attempt', { namespace: authorization.namespace, retainedFork: authorization.forkRepository, deletion: 'owner-directed-only' });
    const fork = await source.fork(authorization.forkRepository, { defaultBranchOnly: false, readOnly: false, description: 'Authorized disposable GitSpace binding/Git verification' });
    rememberSecret(fork.token);
    evidence('fork-created', { id: fork.id, name: fork.name, namespace: authorization.namespace });
    let initialRevoked = false;
    try {
      const repo = await binding.get(fork.name);
      try {
        setStage('fork-initial-token-revoke');
        initialRevoked = await repo.revokeToken(fork.token);
        if (!initialRevoked) throw new Error('Initial token revocation failed');
        const forkHeadBefore = await repo.log({ limit: 1 });
        const forkParent = await repo.readCommit(checkpoint.worktreeCommit);
        if (!forkParent || forkParent.treeHash !== checkpoint.worktreeTree) throw new Error('Fork does not contain checkpoint');
        setStage('snapshot-push');
        const probePath = `gitspace-artifacts-probe-${randomUUID()}.txt`;
        const content = `GitSpace Artifacts Git probe ${randomUUID()}\n`;
        const minted = new Set<string>();
        try {
          const result = await writeArtifactsSnapshot({
            readCommit: oid => repo.readCommit(oid), readTree: oid => repo.readTree(oid), info: () => repo.info(),
            createToken: async (scope, ttl) => { const token = await repo.createToken(scope, ttl); rememberSecret(token.plaintext); rememberSecret(token.id); minted.add(token.id); return token; },
            revokeToken: async id => { const revoked = await repo.revokeToken(id); if (!revoked) throw new Error('Writer token revocation failed'); minted.delete(id); return revoked; },
          }, { repository: fork.name, workspaceId: `probe-${randomUUID()}`, previous: checkpoint, mutations: [{ path: probePath, content: new TextEncoder().encode(content) }], signal: AbortSignal.timeout(120_000) }, boundedFetch(request));
          if (result.isErr()) throw new Error(`Snapshot writer failed: ${result.error.message}`);
          const next = result.value;
          setStage('snapshot-binding-verification');
          const snapshot = await repo.readCommit(next.worktreeCommit);
          if (!snapshot || snapshot.parents[0] !== checkpoint.worktreeCommit || snapshot.treeHash !== next.worktreeTree) throw new Error('Snapshot parent/tree mismatch');
          const snapshotHistory = await repo.log({ ref: next.worktreeCommit, limit: 1 });
          if (snapshotHistory[0]?.hash !== next.worktreeCommit) throw new Error(`Published checkpoint history mismatch: expected ${next.worktreeCommit}; observed ${snapshotHistory.map(commit => commit.hash).join(', ')}`);
          const published = await repo.readFile({ ref: next.worktreeCommit, path: probePath });
          if (!published || published.size > 1024 || await published.text() !== content) throw new Error('Published probe differs');
          setStage('snapshot-git-ref-verification');
          await verifyPublishedRef(repo, next.checkpointRef, next.worktreeCommit, rememberSecret, request);
          const forkHeadAfter = await repo.log({ limit: 1 });
          const sourceHeadAfter = await source.log({ limit: 1 });
          const sourceCommitAfter = await source.readCommit(checkpoint.worktreeCommit);
          if (forkHeadAfter[0]?.hash !== forkHeadBefore[0]?.hash || sourceHeadAfter[0]?.hash !== headBefore[0]?.hash || sourceCommitAfter?.treeHash !== checkpoint.worktreeTree || next.headCommit !== checkpoint.headCommit || next.indexCommit !== checkpoint.indexCommit || next.indexTree !== checkpoint.indexTree) throw new Error('Source/HEAD/index preservation failed');
          evidence('snapshot-verified', { checkpoint: next, commit: snapshot, history: snapshotHistory, file: { path: probePath, size: published.size }, gitRefVerified: true, sourcePreserved: true, headPreserved: true, indexPreserved: true });
        } finally {
          for (const id of minted) {
            if (!await repo.revokeToken(id)) throw new Error('Writer token cleanup failed');
          }
        }
        evidence('passed', { namespace: authorization.namespace, retainedFork: fork.name, forkId: fork.id, r2LfsVerified: false, deletion: 'owner-directed-only' });
      } finally { await disposeArtifactsRepository(repo); }
    } finally {
      if (!initialRevoked) {
        const cleanup = await binding.get(fork.name);
        try { if (!await cleanup.revokeToken(fork.token)) throw new Error('Initial token cleanup failed'); }
        finally { await disposeArtifactsRepository(cleanup); }
      }
    }
  } finally { await disposeArtifactsRepository(source); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const evidence: Evidence = (event, data) => console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
  if (args.includes('--help')) { console.log(help); return; }
  if (args.length !== 3 || args[0] !== '--authorize-live' || args[1] !== '--input' || !args[2]) {
    evidence('offline', { networkAccess: false, reason: 'Use --help; explicit authorization and input are required' });
    process.exitCode = 2;
    return;
  }
  let stage = 'authorization';
  const secrets = new Set<string>();
  if (process.env.CLOUDFLARE_API_TOKEN) secrets.add(process.env.CLOUDFLARE_API_TOKEN);
  if (process.env.CLOUDFLARE_API_KEY) secrets.add(process.env.CLOUDFLARE_API_KEY);
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
        // Static Wrangler loading would initialize provider tooling before the authorization gate.
        const { getPlatformProxy } = await import('wrangler');
        const proxy = await getPlatformProxy<{ ARTIFACTS: Artifacts }>({ configPath, remoteBindings: true, persist: false, envFiles: [] });
        try { await probe(proxy.env.ARTIFACTS, authorization, evidence, value => { stage = value; }, value => { secrets.add(value); }); }
        finally { await proxy.dispose(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  } catch (error) {
    evidence('failed', { stage, reason: scrubFailure(error, secrets) });
    process.exitCode = 1;
  }
}
