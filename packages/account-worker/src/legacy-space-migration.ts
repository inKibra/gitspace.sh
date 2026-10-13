import { createHash } from 'node:crypto';
import { z } from 'zod';
import { artifactManifestSchema, credentialProtocolBase64, deriveArtifactScopeKey, type CanonicalArtifactScope } from '@gitspace/protocol';
import { canonicalJson, RuntimeGitCheckpointSchema, type RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { parseGitLfsPointer, parseWorkspaceCheckpoint, spaceArtifactManifestKey, spaceCheckpointManifestKey, spaceOmpCheckpointKey, type GitLfsObject, type SpaceAuthorityRecord, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import { ArtifactsCodeStore, artifactsWorkspaceRepository, isSupportedBranchName } from '@gitspace/runtime-workspace-do';
import { openLegacyCheckpointTranscript, readLegacyCheckpointObject } from './account-inspector-data.js';
import { readArtifactManifestObject, readArtifactObject } from './artifact-object-reader.js';
import { createAccountGitLfsStore } from './git-lfs-store.js';
import type { LegacySpaceMigrationInput, LegacyMigrationSource, LegacySpaceMigrationReceipt } from '@gitspace/protocol/legacy-migration';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export interface LegacyMigrationIntent {
  input: LegacySpaceMigrationInput; source: LegacyMigrationSource; receipt: LegacySpaceMigrationReceipt | null;
  metadata: { projectRevision: number; workspaceRevision: number; projectBranch: string; workspaceBranch: string; base: boolean };
}
const artifactCheckpoint = z.object({ version: z.literal(2), scope: z.object({ id: z.string().min(1), spaceId: z.string(), generation: z.number().int().nonnegative(), manifestHash: hash.nullable(), dirty: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional() }) });
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export const migrationDigest = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

export function requireLegacyMigrationSource(state: SpaceAuthorityRecord | null, input: LegacySpaceMigrationInput, accountId: string): LegacyMigrationSource {
  if (!state || state.projectId !== input.projectId || state.spaceId !== input.workspaceId) throw new Error('Legacy migration workspace identity mismatch');
  if (state.state !== 'closed' || state.machineId !== null) throw new Error('Legacy migration requires a committed closed checkpoint; close on its holder only after separate approval');
  if (state.generation !== input.expectedGeneration || state.manifestHash !== input.expectedManifestHash) throw new Error('Legacy migration source generation or manifest changed');
  if (state.publishedRevision < 1 || state.manifestKey !== spaceCheckpointManifestKey(input.projectId, input.workspaceId, state.publishedRevision)) throw new Error('Legacy migration requires a committed canonical checkpoint');
  const source = { accountId, projectId: input.projectId, workspaceId: input.workspaceId, generation: state.generation, revision: state.publishedRevision, manifestKey: state.manifestKey, manifestHash: input.expectedManifestHash };
  return { ...source, sourceDigest: migrationDigest(source) };
}

/** Validates the original immutable portable metadata; no machine or provider is contacted. */
export async function readLegacyMigrationBundle(env: Env, source: LegacyMigrationSource) {
  if (source.accountId !== env.ACCOUNT_ID) throw new Error('Legacy migration account mismatch');
  const manifest = parseWorkspaceCheckpoint(json(await readLegacyCheckpointObject(env, source.accountId, source.manifestKey, source.manifestHash)), { projectId: source.projectId, spaceId: source.workspaceId, revision: source.revision });
  if (manifest.agent.kind !== 'legacy') throw new Error('Checkpoint already belongs to a cloud agent, not OMP');
  if (!isSupportedBranchName(manifest.repository.branch)) throw new Error('Legacy checkpoint branch is unsupported');
  const saved = artifactCheckpoint.parse(json(await readLegacyCheckpointObject(env, source.accountId, spaceArtifactManifestKey(source.projectId, source.workspaceId, source.revision, manifest.artifacts.generation), manifest.artifacts.manifestHash)));
  if (saved.scope.spaceId !== source.workspaceId || saved.scope.generation !== manifest.artifacts.generation || saved.scope.dirty) throw new Error('Legacy artifact checkpoint scope mismatch');
  const scope: Omit<CanonicalArtifactScope, 'updatedAt'> = { id: saved.scope.id, workspaceId: source.workspaceId, generation: saved.scope.generation, manifestHash: saved.scope.manifestHash as CanonicalArtifactScope['manifestHash'] };
  const objectKey = spaceOmpCheckpointKey(source.projectId, source.workspaceId, source.revision);
  return { manifest, scope, transcript: { sessionId: manifest.agent.sessionId, ompSessionId: manifest.agent.ompSessionId, objectKey, objectHash: manifest.agent.ompCheckpointHash } };
}

/** Read-only full-tree, selected-lineage and artifact authentication before any migration fence. */
export async function preflightLegacyMigrationBundle(env: Env, source: LegacyMigrationSource) {
  const bundle = await readLegacyMigrationBundle(env, source);
  const opened = await openLegacyCheckpointTranscript(env, source.accountId, bundle.transcript);
  for await (const _event of opened.events) { /* Exhaust the selected lineage without retaining message bodies. */ }
  await verifyLegacyMigrationArtifacts(env, bundle.scope);
  return bundle;
}

/** Authenticate every retained artifact object with its scope key, one object at a time. */
export async function verifyLegacyMigrationArtifacts(env: Env, scope: Omit<CanonicalArtifactScope, 'updatedAt'>): Promise<void> {
  if (scope.manifestHash === null) {
    if (scope.generation !== 0) throw new Error('Committed legacy artifact manifest is missing');
    return;
  }
  const accountKey = credentialProtocolBase64.decode(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).artifactKey(env.ACCOUNT_ID));
  const key = await deriveArtifactScopeKey(accountKey, scope.id);
  const manifest = artifactManifestSchema.parse(json(await readArtifactManifestObject(env, env.ACCOUNT_ID, scope.manifestHash, key)));
  if (manifest.scopeId !== scope.id || manifest.generation !== scope.generation || new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length) throw new Error('Legacy artifact manifest scope or paths mismatch');
  for (const entry of manifest.entries) {
    for await (const _bytes of await readArtifactObject(env, env.ACCOUNT_ID, entry.blobHash, key, entry.size)) { /* Authenticate every part without assembling the object. */ }
  }
}

/** Source Git may still be in WalGit. This creates only the operation's destination, never an origin import. */
export async function prepareLegacyMigrationRepository(env: Env, source: LegacyMigrationSource, manifest: SpaceCheckpointManifest) {
  const name = artifactsWorkspaceRepository(source.workspaceId);
  let found = false;
  let cursor: string | undefined;
  do {
    const page = await env.ARTIFACTS.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    found = page.repos.some(repo => repo.name === name);
    cursor = page.cursor ?? undefined;
  } while (!found && cursor);
  if (!found) {
    const created = await env.ARTIFACTS.create(name, { setDefaultBranch: manifest.repository.branch, readOnly: false, description: `Legacy migration ${source.sourceDigest}` });
    const repo = await env.ARTIFACTS.get(name);
    try { await repo.revokeToken(created.token); } finally { await repo[Symbol.dispose]?.(); }
  }
  const branch = await new ArtifactsCodeStore(env.ARTIFACTS).resolveRef(name, `refs/heads/${manifest.repository.branch}`);
  if (branch !== null && branch !== manifest.repository.headCommit) throw new Error('Destination branch differs from the closed legacy HEAD; refusing an unrelated repository write lease');
  return { name, ...manifest.repository };
}

/** Verify every current snapshot object before publishing the cloud writer's CAS ref; HEAD may be a shallow boundary. */
export async function stageLegacyMigrationCode(env: Env, source: LegacyMigrationSource, manifest: SpaceCheckpointManifest, historicalLfs: readonly GitLfsObject[], transportVerifiedBlobs: readonly { oid: string; size: number }[] = []): Promise<RuntimeGitCheckpoint> {
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  const repository = artifactsWorkspaceRepository(source.workspaceId);
  const saved = manifest.repository;
  const [index, worktree, head] = await Promise.all([code.readCommit(repository, saved.indexCommit), code.readCommit(repository, saved.worktreeCommit), saved.headCommit ? code.readCommit(repository, saved.headCommit) : null])
    .catch(error => { throw new Error(`Reading legacy Git checkpoint commits: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
  if (!index || !worktree || (saved.headCommit && !head)) throw new Error('Legacy Git checkpoint is missing; stage its exact graph from the preserved source repository first');
  const trackedId = worktree.parents[0];
  // Match the portable restore owner's completion: the direct parent is the tracked snapshot.
  const tracked = trackedId === saved.indexCommit ? index : trackedId ? await code.readCommit(repository, trackedId) : null;
  if (!tracked || worktree.parents.length !== 1 || (tracked !== index && (tracked.parents.length !== 1 || tracked.parents[0] !== saved.indexCommit)) || index.parents.length !== (saved.headCommit === null ? 0 : 1) || (saved.headCommit && index.parents[0] !== saved.headCommit)) throw new Error('Legacy Git checkpoint ancestry does not match HEAD/index/worktree');
  // These synthetic links and HEAD are required, including all their trees and blobs.
  // HEAD's own parents are historical: a shallow upload keeps their IDs but may omit the objects.
  const trees = [...new Set([index.treeHash, tracked.treeHash, worktree.treeHash, ...(head ? [head.treeHash] : [])])];
  const inventories = await code.listSnapshotInventories(repository, trees)
    .catch(error => { throw new Error(`Reading legacy Git checkpoint trees: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
  const seen = new Set<string>();
  // Blobs above the LFS pointer limit were fetched back through Git transport by the client; reading them all through
  // the binding here exceeds the isolate memory limit. Each declared blob must still be a current snapshot object.
  const transportVerified = new Set(transportVerifiedBlobs.map(blob => blob.oid));
  const pointers = new Map<string, GitLfsObject>();
  for (const object of saved.lfs?.objects ?? []) {
    const prior = pointers.get(object.oid);
    if (prior && prior.size !== object.size) throw new Error('Legacy LFS inventory contains conflicting sizes');
    pointers.set(object.oid, { oid: object.oid, size: object.size });
  }
  for (const inventory of inventories) for (const entry of inventory.values()) {
    if (entry.type === 'commit' || seen.has(entry.oid)) continue;
    seen.add(entry.oid);
    if (transportVerified.has(entry.oid)) continue;
    const blob = await code.readBlob(repository, entry.oid)
      .catch((error: unknown) => {
        const details: Record<string, string | number | boolean> = { name: error instanceof Error ? error.name : typeof error };
        if (error !== null && typeof error === 'object') for (const key of ['code', 'numericCode', 'remote']) {
          const value: unknown = Reflect.get(error, key);
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') details[key] = value;
        }
        throw new Error(`Reading legacy Git blob ${entry.oid}: ${error instanceof Error ? error.message : String(error)} (${JSON.stringify(details)})`, { cause: error });
      });
    if (!blob) throw new Error('Legacy Git checkpoint blob is missing');
    if (blob.size > 32_000_000) throw new Error('Legacy Git checkpoint contains an oversized current Git blob (limit: 32000000 bytes); no runtime checkpoint was published');
    const digest = createHash('sha1').update(`blob ${blob.size}\0`);
    for await (const bytes of blob.stream()) digest.update(bytes);
    if (digest.digest('hex') !== entry.oid) throw new Error('Legacy Git checkpoint blob failed content verification');
    if (blob.size <= 1024) {
      const pointer = parseGitLfsPointer(new Uint8Array(await blob.arrayBuffer()));
      if (pointer) {
        const prior = pointers.get(pointer.oid);
        if (prior && prior.size !== pointer.size) throw new Error('Legacy LFS inventory disagrees with a checkpoint pointer');
        pointers.set(pointer.oid, pointer);
      }
    }
  }
  for (const oid of transportVerified) if (!seen.has(oid)) throw new Error(`Transport-verified blob ${oid} is not part of the legacy checkpoint`);
  const lfs = await createAccountGitLfsStore(env, env.ACCOUNT_ID, source.projectId, `migration:${source.workspaceId}`);
  // Pre-inventory legacy checkpoints still contain pointers. Require verified staged payloads;
  // migration never calls an external origin or converts an unverified pointer into a usable file.
  const historical = new Map(historicalLfs.map(object => [object.oid, object]));
  for (const object of pointers.values()) {
    if (historical.get(object.oid)?.size !== object.size) throw new Error('Historical LFS inventory omits or disagrees with a checkpoint pointer');
  }
  for (const object of historical.values()) if (!await lfs.has(object)) throw new Error('Legacy Git LFS payload is missing; stage the verified source payload before activation');
  const inventory = { objects: [...pointers.values()].map(object => ({ ...object, source: 'r2' as const })), heldBack: saved.lfs?.heldBack ?? [] };
  if (source.workspaceId === source.projectId) await code.seedLegacyProjectSource({
    projectId: source.projectId, sourceRepository: repository, branch: saved.branch, headCommit: saved.headCommit, sourceDigest: source.sourceDigest,
  });
  await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${source.projectId}`).lfsRetain({ snapshotId: `migration:${source.workspaceId}:${source.sourceDigest}`, workspaceId: source.workspaceId, kind: 'migration', objects: [...historical.values()].map(object => ({ ...object, source: 'r2' as const })) });
  const checkpointRef = `refs/gitspace/spaces/${source.workspaceId}/runtime/checkpoints`;
  await code.copyCommit(repository, repository, checkpointRef, saved.worktreeCommit, null);
  const branch = await code.resolveRef(repository, `refs/heads/${saved.branch}`);
  if (branch !== null && branch !== saved.headCommit) throw new Error('Destination branch differs from the closed legacy HEAD');
  if (saved.headCommit && branch === null) await code.copyCommit(repository, repository, `refs/heads/${saved.branch}`, saved.headCommit, null);
  return RuntimeGitCheckpointSchema.parse({ ...saved, lfs: inventory, checkpointRef, trackedWorktreeCommit: tracked.hash, indexTree: index.treeHash, worktreeTree: worktree.treeHash });
}
