import { createReadStream } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createSignedControlRequest, credentialProtocolBase64, type ControlOperation } from '@gitspace/protocol';
import { LEGACY_MIGRATION_TRANSPORT_VERIFIED_MIN_BYTES, LegacySpaceMigrationInputSchema, LegacySpaceMigrationReceiptSchema, LegacySpaceMigrationStageSchema, LegacySpaceMigrationStatusSchema, type LegacySpaceMigrationReceipt, type LegacySpaceMigrationStatus } from '@gitspace/protocol/legacy-migration';
import { spaceGitCheckpointRef, type GitLfsObject } from '@gitspace/protocol-workspace';
import { ArtifactsGitRemote, verifyArtifactsGitUpload } from './artifacts-git-remote.js';
import { CloudDataCheckpointBlobStore } from './cloud-space-authority.js';
import { createCloudGitLfsPublisher, createCloudGitLfsStore, type CloudGitLfsReader } from './cloud-lfs-store.js';
import { cachedLfsObject } from './git-lfs-cache.js';
import { readGitLfsPointers } from './git-lfs.js';
import { LegacySubmoduleVerifier, type LegacySubmoduleRecovery } from './legacy-submodule-recovery.js';

/** Input repositories are retained exports, never a request to close a live workspace. */
export const LegacyMigrationPlanSchema = z.object({
  version: z.literal(1), accountId: z.string().min(1), accountUrl: z.string().url(),
  spaces: z.array(LegacySpaceMigrationInputSchema.extend({
    repositoryPath: z.string().min(1), lfsRoots: z.array(z.string().min(1)).default([]),
    submoduleRepositories: z.array(z.string().min(1)).default([]),
  }).strict()).min(1),
}).strict().superRefine((plan, context) => {
  const spaces = new Set<string>();
  for (const [index, space] of plan.spaces.entries()) {
    if (spaces.has(space.workspaceId)) context.addIssue({ code: 'custom', path: ['spaces', index, 'workspaceId'], message: 'Workspace occurs more than once' });
    spaces.add(space.workspaceId);
  }
});
export type LegacyMigrationPlan = z.infer<typeof LegacyMigrationPlanSchema>;
export type LegacyMigrationAccount = { apiUrl: string; accountUrl: string; userId: string; machine: { id: string; signingPrivateKey: string } };
export type LegacyMigrationProgress = { workspaceId: string; state: 'verified' | 'staged' | 'uploaded' | 'activated'; lfsObjects: number };

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Migration Git ${args[0]} failed; retained source repositories were not modified`);
  return output.trim();
}

type TransportVerifiedBlob = { oid: string; size: number };

/** Current-snapshot blobs too large to be LFS pointers: verified by Git transport, not through the Artifacts binding. */
async function largeCurrentBlobs(repository: string, commits: readonly string[]): Promise<TransportVerifiedBlob[]> {
  const blobs = new Map<string, number>();
  for (const commit of commits) {
    for (const record of (await git(repository, ['ls-tree', '-r', '-l', '-z', commit])).split('\0')) {
      const [mode, type, oid, size] = record.slice(0, record.indexOf('\t')).split(/ +/u);
      if (type !== 'blob' || !mode || !oid || !size) continue;
      if (Number(size) > LEGACY_MIGRATION_TRANSPORT_VERIFIED_MIN_BYTES) blobs.set(oid, Number(size));
    }
  }
  return [...blobs].map(([oid, size]) => ({ oid, size })).sort((left, right) => left.oid.localeCompare(right.oid));
}

/** Fetch the published checkpoint back through Git transport into a fresh repository; index-pack verifies every object
 * ID, and each declared blob must arrive with its exact size. */
async function verifyTransportBlobs(temporary: string, credentials: { remote: string; plaintext: string }, commit: string, blobs: readonly TransportVerifiedBlob[]): Promise<void> {
  const remote = new URL(credentials.remote);
  if (remote.protocol !== 'https:' || remote.username || remote.password || /[\r\n]/u.test(credentials.plaintext)) throw new Error('Invalid migration repository credentials');
  const fresh = await mkdtemp(join(temporary, 'transport-readback-'));
  try {
    await git(fresh, ['init', '--bare', '--quiet']);
    const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-C', fresh, 'fetch', '--quiet', '--depth=4', '--no-write-fetch-head', remote.href, `${commit}:refs/gitspace/readback`], {
      env: {
        ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: `http.${remote.href}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credentials.plaintext}`,
        GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '',
      }, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    });
    const [code] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error('Git-transport readback of the published checkpoint failed');
    const check = Bun.spawn(['git', '-C', fresh, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { stdin: new Blob([blobs.map(blob => `${blob.oid}\n`).join('')]), stdout: 'pipe', stderr: 'ignore' });
    const [checked, listing] = await Promise.all([check.exited, new Response(check.stdout).text()]);
    const expected = blobs.map(blob => `${blob.oid} blob ${blob.size}`).join('\n');
    if (checked !== 0 || listing.trim() !== expected) throw new Error('Git-transport readback of the published checkpoint differs from its retained blobs');
  } finally { await rm(fresh, { recursive: true, force: true }); }
}

/** Immutable, private evidence: a retry cannot replace another operation's result. */
async function saveEvidence(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const previous: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('Migration evidence conflicts with a previously retained result');
    }
  } finally { await rm(temporary, { force: true }); }
}

/** Preflight every source before the first remote write. Upload only private Git copies and verified LFS bytes. */
export async function runLegacyMigrationPlan(options: {
  plan: LegacyMigrationPlan; account: LegacyMigrationAccount; baseDirectory: string; apply: boolean; receiptsDirectory: string;
  progress?(event: LegacyMigrationProgress): void;
}): Promise<{ applied: boolean; workspaces: number; receipts: LegacySpaceMigrationReceipt[] }> {
  const plan = LegacyMigrationPlanSchema.parse(options.plan);
  if (plan.accountId !== options.account.userId || new URL(plan.accountUrl).origin !== new URL(options.account.accountUrl).origin) throw new Error('Migration plan belongs to a different account');
  const controlOptions = { baseUrl: options.account.apiUrl, userId: options.account.userId, machineId: options.account.machine.id, signingPrivateKey: credentialProtocolBase64.decode(options.account.machine.signingPrivateKey) };
  async function control<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S): Promise<z.output<S>> {
    const signed = createSignedControlRequest({ ...controlOptions, operation, payload });
    // Activation imports a whole legacy transcript in one request; Bun's default fetch timeout cuts it off first.
    const init: RequestInit & { timeout: false } = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed), signal: AbortSignal.timeout(60 * 60_000), timeout: false };
    const response = await fetch(new URL('/v1/control', controlOptions.baseUrl), init);
    if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 1000)}`);
    const result = z.object({ status: z.literal('ok'), value: z.unknown() }).parse(await response.json());
    return schema.parse(result.value);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'gitspace-legacy-migration-'));
  const repositories = new Map<string, string>();
  const submodules = new LegacySubmoduleVerifier(git);
  async function retainedRepository(source: string): Promise<string> {
    const existing = repositories.get(source);
    if (existing) return existing;
    const copy = join(temporary, `repository-${repositories.size}.git`);
    await git(temporary, ['clone', '--mirror', '--no-local', '--', source, copy]);
    await git(copy, ['fsck', '--full', '--strict']);
    repositories.set(source, copy);
    return copy;
  }
  const readers = new Map<string, CloudGitLfsReader>();
  const payloads = new Map<string, string | null>();
  const blobs = new CloudDataCheckpointBlobStore(controlOptions);
  let artifactKey: Uint8Array | undefined;
  const ready: Array<{ input: LegacyMigrationPlan['spaces'][number]; repository: string | null; checkpointRef: string | null; commit: string | null; verified: Exclude<LegacySpaceMigrationStatus, { state: 'activated' }> | null; objects: GitLfsObject[]; largeBlobs: TransportVerifiedBlob[]; submodules: LegacySubmoduleRecovery[]; receipt?: LegacySpaceMigrationReceipt }> = [];
  // One workspace's failure never stops the others; every failure is reported after all workspaces were attempted.
  const failures: Array<{ workspaceId: string; stage: 'preflight' | 'apply'; error: string }> = [];
  try {
    for (const input of plan.spaces) try {
      const { repositoryPath, lfsRoots, submoduleRepositories, ...request } = input;
      const status = await control('space.legacyMigrationStatus', request, LegacySpaceMigrationStatusSchema);
      if (status.source.accountId !== plan.accountId || status.source.manifestHash !== request.expectedManifestHash || status.source.generation !== request.expectedGeneration || status.source.projectId !== request.projectId || status.source.workspaceId !== request.workspaceId) throw new Error('Migration status changed the requested source identity');
      if (status.state === 'activated') {
        ready.push({ input, repository: null, checkpointRef: null, commit: null, verified: null, objects: status.receipt.historicalLfs, largeBlobs: [], submodules: [], receipt: status.receipt });
        options.progress?.({ workspaceId: input.workspaceId, state: 'verified', lfsObjects: status.receipt.historicalLfs.length });
        continue;
      }
      const source = resolve(options.baseDirectory, repositoryPath);
      const repository = await retainedRepository(source);
      const checkpointRef = spaceGitCheckpointRef(input.workspaceId, status.source.revision);
      const commit = await git(repository, ['rev-parse', '--verify', `${checkpointRef}^{commit}`]);
      if (status.repository.checkpointRef !== checkpointRef || status.repository.worktreeCommit !== commit) throw new Error(`Retained checkpoint does not match the verified manifest for ${input.workspaceId}; no migration was staged`);
      // Match stageLegacyMigrationCode, including the old two-snapshot shape and
      // unborn HEAD. Object existence alone does not establish this exact tuple.
      async function parents(commit: string): Promise<string[]> {
        const [actual, ...parents] = (await git(repository, ['--shallow-file', '/dev/null', 'rev-list', '--parents', '--no-walk', commit])).split(' ');
        if (actual !== commit) throw new Error(`Legacy Git checkpoint is not an exact commit for ${input.workspaceId}; no migration was staged`);
        return parents;
      }
      const indexParents = await parents(status.repository.indexCommit);
      const worktreeParents = await parents(commit);
      const trackedId = worktreeParents[0];
      const trackedParents = trackedId && trackedId !== status.repository.indexCommit ? await parents(trackedId) : null;
      const head = status.repository.headCommit;
      if (head) await parents(head);
      if (worktreeParents.length !== 1 || !trackedId || (trackedParents && (trackedParents.length !== 1 || trackedParents[0] !== status.repository.indexCommit)) || indexParents.length !== (head === null ? 0 : 1) || (head && indexParents[0] !== head)) throw new Error(`Legacy Git checkpoint ancestry does not match HEAD/index/worktree for ${input.workspaceId}; no migration was staged`);
      await verifyArtifactsGitUpload(repository, commit, head);
      const childRepositories = new Map<string, string>();
      for (const path of submoduleRepositories) {
        const source = resolve(options.baseDirectory, path);
        childRepositories.set(source, await retainedRepository(source));
      }
      const recoveredSubmodules = await submodules.verify(repository, commit, childRepositories);
      const objects = [...(await readGitLfsPointers(repository, [commit])).values()];
      for (const object of objects) {
        const identity = `${input.projectId}:${object.oid}:${object.size}`;
        if (payloads.has(identity)) continue;
        const cache = resolve(source, await git(source, ['rev-parse', '--git-path', 'lfs/objects']));
        let path: string | null = null;
        for (const root of [...lfsRoots.map(root => resolve(options.baseDirectory, root)), cache]) {
          for (const candidate of [join(root, object.oid), join(root, object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid)]) {
            if (await cachedLfsObject(candidate, object)) { path = candidate; break; }
          }
          if (path) break;
        }
        if (!path) {
          if (!artifactKey) artifactKey = credentialProtocolBase64.decode((await control('artifacts.key.get', {}, z.object({ key: z.string() }))).key);
          let reader = readers.get(input.projectId);
          if (!reader) { reader = await createCloudGitLfsStore({ projectId: input.projectId, blobs, encryptionKey: artifactKey, controlOptions }); readers.set(input.projectId, reader); }
          if (!await reader.has(object)) throw new Error(`Missing verified LFS payload ${object.oid} for ${input.workspaceId}; no migration was staged`);
        }
        payloads.set(identity, path);
      }
      const largeBlobs = await largeCurrentBlobs(repository, [...new Set([commit, trackedId, status.repository.indexCommit, ...(head ? [head] : [])])]);
      ready.push({ input, repository, checkpointRef, commit, verified: status, objects, largeBlobs, submodules: recoveredSubmodules });
      options.progress?.({ workspaceId: input.workspaceId, state: 'verified', lfsObjects: objects.length });
    } catch (error) {
      failures.push({ workspaceId: input.workspaceId, stage: 'preflight', error: error instanceof Error ? error.message : String(error) });
    }
    const reportFailures = async () => {
      if (!failures.length) return;
      await saveEvidence(options.receiptsDirectory, `failures-${crypto.randomUUID()}.json`, failures);
      throw new Error(`Legacy migration failed for ${failures.length} workspace(s); all others were attempted:\n${failures.map(failure => `${failure.workspaceId} (${failure.stage}): ${failure.error}`).join('\n')}`);
    };
    if (!options.apply) {
      await reportFailures();
      return { applied: false, workspaces: ready.length, receipts: ready.flatMap(item => item.receipt ? [item.receipt] : []) };
    }
    const receipts: LegacySpaceMigrationReceipt[] = [];
    for (const item of ready) try {
      const { repositoryPath: _repositoryPath, lfsRoots: _lfsRoots, submoduleRepositories: _submoduleRepositories, ...request } = item.input;
      const publicationId = `legacy-migration:${request.operationId}`;
      let receipt = item.receipt;
      if (!receipt) {
        if (!item.repository || !item.checkpointRef || !item.commit || !item.verified) throw new Error('Migration preflight repository is unavailable');
        const stage = await control('space.stageLegacyMigration', request, LegacySpaceMigrationStageSchema);
        const saved = item.verified.repository;
        if (stage.operationId !== request.operationId || stage.source.accountId !== plan.accountId || stage.source.projectId !== request.projectId || stage.source.workspaceId !== request.workspaceId || stage.source.generation !== request.expectedGeneration || stage.source.manifestHash !== request.expectedManifestHash || stage.source.sourceDigest !== item.verified.source.sourceDigest
          || stage.repository.checkpointRef !== saved.checkpointRef || stage.repository.worktreeCommit !== saved.worktreeCommit || stage.repository.indexCommit !== saved.indexCommit || stage.repository.headCommit !== saved.headCommit || stage.repository.branch !== saved.branch) throw new Error('Staged migration differs from the verified source');
        options.progress?.({ workspaceId: request.workspaceId, state: 'staged', lfsObjects: item.objects.length });
        if (item.objects.length) {
          if (!artifactKey) artifactKey = credentialProtocolBase64.decode((await control('artifacts.key.get', {}, z.object({ key: z.string() }))).key);
          const publisher = await createCloudGitLfsPublisher({ projectId: request.projectId, publicationId, blobs, encryptionKey: artifactKey, controlOptions });
          await publisher.protect(item.objects);
          for (const object of item.objects) {
            const path = payloads.get(`${request.projectId}:${object.oid}:${object.size}`);
            if (path) await publisher.put(object, createReadStream(path));
            else if (!await publisher.has(object)) throw new Error(`Previously verified LFS payload ${object.oid} is unavailable; migration remains staged`);
          }
        }
        const remote = new ArtifactsGitRemote({ credentials: async () => stage.credentials });
        await remote.publishCheckpoint({ binding: { projectId: request.projectId, repository: stage.repository.name }, repositoryPath: item.repository, checkpointRef: item.checkpointRef, headCommit: saved.headCommit, remoteHead: null });
        if (item.largeBlobs.length) await verifyTransportBlobs(temporary, stage.credentials, item.commit, item.largeBlobs);
        options.progress?.({ workspaceId: request.workspaceId, state: 'uploaded', lfsObjects: item.objects.length });
        receipt = await control('space.migrateLegacy', { ...request, historicalLfs: item.objects, ...(item.largeBlobs.length ? { transportVerifiedBlobs: item.largeBlobs } : {}) }, LegacySpaceMigrationReceiptSchema);
      }
      if (receipt.operationId !== request.operationId || receipt.source.accountId !== plan.accountId || receipt.source.manifestHash !== request.expectedManifestHash || receipt.source.projectId !== request.projectId || receipt.source.workspaceId !== request.workspaceId) throw new Error('Migration receipt does not match the requested source');
      if (!item.receipt) {
        const expected = item.objects.map(object => `${object.oid}:${object.size}`).sort().join('\n');
        const retained = receipt.historicalLfs.map(object => `${object.oid}:${object.size}`).sort().join('\n');
        if (retained !== expected) throw new Error('Migration has not retained the complete historical LFS inventory; publication remains pinned');
      }
      const evidenceName = `${encodeURIComponent(receipt.source.workspaceId)}-${receipt.operationId}`;
      if (!item.receipt) await saveEvidence(options.receiptsDirectory, `${evidenceName}.recovery.json`, {
        source: receipt.source, checkpointRef: item.checkpointRef, commit: item.commit,
        historicalLfs: item.objects, submodules: item.submodules,
      });
      await saveEvidence(options.receiptsDirectory, `${evidenceName}.json`, receipt);
      // Activation retains canonical LFS roots before temporary publication pins are released.
      await control('lfs.release', { projectId: request.projectId, publicationId }, z.null());
      receipts.push(receipt);
      options.progress?.({ workspaceId: request.workspaceId, state: 'activated', lfsObjects: receipt.historicalLfs.length });
    } catch (error) {
      failures.push({ workspaceId: item.input.workspaceId, stage: 'apply', error: error instanceof Error ? error.message : String(error) });
    }
    await reportFailures();
    return { applied: true, workspaces: receipts.length, receipts };
  } finally {
    artifactKey?.fill(0);
    controlOptions.signingPrivateKey.fill(0);
    await rm(temporary, { recursive: true, force: true });
  }
}
