import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { spaceGitCheckpointRef } from '@gitspace/protocol-workspace';
import type { LegacySpaceMigrationStatus } from '@gitspace/protocol/legacy-migration';
import { runLegacyMigrationPlan, type LegacyMigrationPlan, type LegacyMigrationProgress } from '../src/legacy-migration-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, env: { ...Bun.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.invalid' } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

type Shape = 'tracked' | 'direct' | 'worktree-root' | 'worktree-merge' | 'tracked-wrong-index' | 'tracked-merge' | 'index-root' | 'index-wrong-head' | 'index-merge' | 'unborn-index-parent';
type MigrationFixture = { root: string; input: LegacyMigrationPlan['spaces'][number]; status: Extract<LegacySpaceMigrationStatus, { state: 'ready' }>; expectRetained(): void };
function fixture(workspaceId: string, options: { unborn?: boolean; shape?: Shape; oversized?: 'blob' | 'commit'; blobSize?: number; blobLayer?: 'history' | 'head' | 'index' | 'tracked' | 'worktree' } = {}): MigrationFixture {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-migration-preflight-')); roots.push(root);
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'file'), 'retained tracked data'); git(root, 'add', 'file');
  const tree = git(root, 'write-tree');
  let serial = 0;
  function commit(parents: string[], snapshot = tree, messageFile?: string): string {
    const oid = git(root, 'commit-tree', snapshot, ...parents.flatMap(parent => ['-p', parent]), ...(messageFile ? ['-F', messageFile] : ['-m', `snapshot ${serial}`]));
    // Retain even deliberately incompatible tuple members, so existence checks pass.
    git(root, 'update-ref', `refs/retained/${serial++}`, oid);
    return oid;
  }
  const blobLayer = options.blobLayer ?? 'head';
  let oversizedTree = tree;
  if (options.oversized === 'blob' || options.blobSize !== undefined) {
    writeFileSync(join(root, 'oversized.bin'), Buffer.alloc(options.blobSize ?? 32_000_001, 1));
    git(root, 'add', 'oversized.bin'); oversizedTree = git(root, 'write-tree');
    git(root, 'rm', '-f', 'oversized.bin');
  }
  let messageFile: string | undefined;
  if (options.oversized === 'commit') {
    messageFile = join(root, 'large-message'); writeFileSync(messageFile, Buffer.alloc(48 * 1024 * 1024 + 1, 120));
  }
  const history = blobLayer === 'history' ? commit([], oversizedTree) : null;
  const headCommit = options.unborn ? null : commit(history ? [history] : [], blobLayer === 'head' ? oversizedTree : tree, messageFile);
  if (messageFile) rmSync(messageFile);
  if (headCommit) git(root, 'update-ref', 'refs/heads/main', headCommit);
  const other = commit([]);
  const shape = options.shape ?? 'tracked';
  const indexParents = shape === 'index-root' ? [] : shape === 'index-wrong-head' || shape === 'unborn-index-parent' ? [other] : shape === 'index-merge' ? [headCommit!, other] : headCommit ? [headCommit] : [];
  const indexCommit = commit(indexParents, blobLayer === 'index' ? oversizedTree : tree);
  const tracked = commit(shape === 'tracked-wrong-index' ? [other] : shape === 'tracked-merge' ? [indexCommit, other] : [indexCommit], blobLayer === 'tracked' ? oversizedTree : tree);
  const worktreeCommit = commit(shape === 'worktree-root' ? [] : shape === 'worktree-merge' ? [tracked, indexCommit] : [shape === 'direct' ? indexCommit : tracked], blobLayer === 'worktree' ? oversizedTree : tree);
  const checkpointRef = spaceGitCheckpointRef(workspaceId, 1);
  git(root, 'update-ref', checkpointRef, worktreeCommit);
  writeFileSync(join(root, 'file'), 'uncommitted source bytes must not change');
  const input: LegacyMigrationPlan['spaces'][number] = { operationId: crypto.randomUUID(), projectId: 'project', workspaceId, expectedGeneration: 1, expectedManifestHash: `sha256:${'a'.repeat(64)}`, repositoryPath: root, lfsRoots: [], submoduleRepositories: [] };
  const status: MigrationFixture['status'] = {
    state: 'ready', source: { accountId: 'account', projectId: input.projectId, workspaceId, generation: 1, revision: 1, manifestKey: `manifest/${workspaceId}`, manifestHash: input.expectedManifestHash, sourceDigest: `sha256:${'b'.repeat(64)}` },
    repository: { checkpointRef, headCommit, indexCommit, worktreeCommit, branch: 'main' },
  };
  const retained = { refs: git(root, 'show-ref'), index: readFileSync(join(root, '.git/index')), file: readFileSync(join(root, 'file')) };
  function expectRetained() {
    expect(git(root, 'show-ref')).toBe(retained.refs);
    expect(readFileSync(join(root, '.git/index'))).toEqual(retained.index);
    expect(readFileSync(join(root, 'file'))).toEqual(retained.file);
  }
  return { root, input, status, expectRetained };
}

function control(spaces: MigrationFixture[], apply: boolean, stagedRepository?: Partial<MigrationFixture['status']['repository']>) {
  const requests: string[] = [];
  const progress: LegacyMigrationProgress[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = z.object({ operation: z.string(), payload: z.object({ workspaceId: z.string() }) }).parse(await request.json());
    requests.push(`${body.operation}:${body.payload.workspaceId}`);
    const space = spaces.find(space => space.input.workspaceId === body.payload.workspaceId);
    if (body.operation === 'space.stageLegacyMigration' && space && stagedRepository) return Response.json({ status: 'ok', value: {
      operationId: space.input.operationId, source: space.status.source, repository: { ...space.status.repository, name: `workspace-${space.input.workspaceId}`, ...stagedRepository },
      credentials: { remote: 'https://must-not-publish.invalid/repository.git', plaintext: 'unused', expiresAt: '2099-01-01T00:00:00.000Z' },
    } });
    if (body.operation !== 'space.legacyMigrationStatus' || !space) return new Response('Unexpected write', { status: 500 });
    return Response.json({ status: 'ok', value: space.status });
  } });
  const accountUrl = server.url.origin;
  const result = runLegacyMigrationPlan({
    plan: { version: 1, accountId: 'account', accountUrl, spaces: spaces.map(space => space.input) },
    account: { apiUrl: accountUrl, accountUrl, userId: 'account', machine: { id: 'machine', signingPrivateKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(21)) } },
    baseDirectory: spaces[0]!.root, apply, receiptsDirectory: join(spaces[0]!.root, 'receipts'), progress: event => progress.push(event),
  }).finally(() => server.stop(true));
  return { result, requests, progress };
}

// A rejected space is never staged; every other space is still attempted (here the mock refuses all writes).
const attemptedOnlyFirst = ['space.legacyMigrationStatus:valid-first', 'space.legacyMigrationStatus:{second}', 'space.stageLegacyMigration:valid-first'];

for (const shape of ['worktree-root', 'worktree-merge', 'tracked-wrong-index', 'tracked-merge', 'index-root', 'index-wrong-head', 'index-merge', 'unborn-index-parent'] as const) {
  it(`rejects only the space whose existing tuple objects have incompatible ${shape} ancestry`, async () => {
    const first = fixture('valid-first');
    const second = fixture('invalid-second', { shape, unborn: shape === 'unborn-index-parent' });
    const run = control([first, second], true);
    await expect(run.result).rejects.toThrow(/invalid-second \(preflight\): Legacy Git checkpoint ancestry does not match/u);
    expect(run.requests).toEqual(attemptedOnlyFirst.map(request => request.replace('{second}', 'invalid-second')));
    expect(run.progress).toEqual([{ workspaceId: 'valid-first', state: 'verified', lfsObjects: 0 }]);
    first.expectRetained(); second.expectRetained();
  });
}

for (const blobLayer of ['head', 'index', 'tracked', 'worktree'] as const) {
  it(`rejects only the space with an oversized ${blobLayer} blob`, async () => {
    const first = fixture('valid-first');
    const second = fixture('oversized-second', { oversized: 'blob', blobLayer });
    const run = control([first, second], true);
    await expect(run.result).rejects.toThrow(/oversized-second \(preflight\)/u);
    expect(run.requests).toEqual(attemptedOnlyFirst.map(request => request.replace('{second}', 'oversized-second')));
    expect(run.progress).toEqual([{ workspaceId: 'valid-first', state: 'verified', lfsObjects: 0 }]);
    first.expectRetained(); second.expectRetained();
  }, 120_000);
}

it('accepts historical-only oversized blobs while retaining the full original source and checkpoint IDs', async () => {
  const spaces = [fixture('historical-first', { oversized: 'blob', blobLayer: 'history' }), fixture('valid-second')];
  const run = control(spaces, false);
  expect(await run.result).toEqual({ applied: false, workspaces: 2, receipts: [] });
  expect(run.progress).toEqual(spaces.map(space => ({ workspaceId: space.input.workspaceId, state: 'verified', lfsObjects: 0 })));
  expect(run.requests).toEqual(spaces.map(space => `space.legacyMigrationStatus:${space.input.workspaceId}`));
  for (const space of spaces) space.expectRetained();
}, 120_000);

for (const member of ['headCommit', 'indexCommit', 'branch'] as const) {
  it(`refuses a staged ${member} different from the exact preflight tuple`, async () => {
    const space = fixture('changed-tuple');
    const run = control([space], true, { [member]: member === 'branch' ? 'changed' : space.status.repository.worktreeCommit });
    await expect(run.result).rejects.toThrow('Staged migration differs');
    expect(run.requests).toEqual(['space.legacyMigrationStatus:changed-tuple', 'space.stageLegacyMigration:changed-tuple']);
    expect(run.progress).toEqual([{ workspaceId: 'changed-tuple', state: 'verified', lfsObjects: 0 }]);
    space.expectRetained();
  });
}

it('verifies direct and tracked snapshots with born and unborn HEAD without changing retained sources', async () => {
  const spaces = [fixture('born-direct', { shape: 'direct' }), fixture('born-tracked'), fixture('unborn-direct', { unborn: true, shape: 'direct' }), fixture('unborn-tracked', { unborn: true })];
  const run = control(spaces, false);
  expect(await run.result).toEqual({ applied: false, workspaces: 4, receipts: [] });
  expect(run.progress).toEqual(spaces.map(space => ({ workspaceId: space.input.workspaceId, state: 'verified', lfsObjects: 0 })));
  expect(run.requests).toEqual(spaces.map(space => `space.legacyMigrationStatus:${space.input.workspaceId}`));
  for (const space of spaces) space.expectRetained();
});

it('accepts the exact publisher blob limit in HEAD even when later snapshots omit the path', async () => {
  const space = fixture('boundary', { blobSize: 32_000_000 });
  const run = control([space], false);
  expect(await run.result).toEqual({ applied: false, workspaces: 1, receipts: [] });
  expect(run.progress).toEqual([{ workspaceId: 'boundary', state: 'verified', lfsObjects: 0 }]);
  expect(run.requests).toEqual(['space.legacyMigrationStatus:boundary']);
  space.expectRetained();
}, 120_000);
