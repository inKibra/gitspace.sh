import { resolve } from 'node:path';
import { spaceCheckpointManifestKey, parseWorkspaceCheckpoint, spaceGitCheckpointRef, WorkspaceDomainError } from '@gitspace/protocol-workspace';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { CheckpointBlobStore, SpaceGitCheckpointRemote } from './portable-space-lifecycle.js';
import type { WalgitProjectBinding } from './walgit-supervisor.js';

export interface PublishedSpaceHeadResolverOptions {
  authority: Pick<CloudSpaceCheckpointAuthority, 'getSpace'>;
  blobs: Pick<CheckpointBlobStore, 'get'>;
  gitRemote: Pick<SpaceGitCheckpointRemote, 'fetchCheckpoint'>;
  binding(projectId: string): WalgitProjectBinding;
}

export type PublishedSpaceHeadResolver = (input: {
  projectId: string;
  spaceId: string;
  /** Inspector comparisons require the configured branch; workspace sources consume saved HEAD. */
  branch?: string;
  repositoryPath: string;
}) => Promise<string>;

async function hasCommit(repositoryPath: string, headCommit: string): Promise<boolean> {
  const child = Bun.spawn(['git', 'cat-file', '--batch-check=%(objecttype)'], {
    cwd: repositoryPath,
    env: { ...Bun.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    stdin: new Blob([`${headCommit}\n`]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Cannot read inspected repository objects: ${stderr.trim() || `git exited with ${exitCode}`}`);
  const type = stdout.trim();
  if (type === 'commit') return true;
  if (type === `${headCommit} missing`) return false;
  throw new Error(`Saved branch head ${headCommit} is not a Git commit (${type})`);
}

/** Fetch only committed HEAD from a published checkpoint, without opening its workspace. */
export function createPublishedSpaceHeadResolver(options: PublishedSpaceHeadResolverOptions): PublishedSpaceHeadResolver {
  const fetching = new Map<string, Promise<void>>();

  return async ({ projectId, spaceId, branch, repositoryPath }): Promise<string> => {
    try {
      const placement = await options.authority.getSpace(projectId, spaceId);
      if (!placement) throw new Error('Workspace placement is missing');
      if (placement.projectId !== projectId || placement.spaceId !== spaceId) {
        throw new Error('Workspace placement does not match the requested identity');
      }
      if (!placement.manifestKey || !placement.manifestHash || placement.checkpointRevision <= 0) {
        throw new Error('Workspace has no published repository checkpoint; save a checkpoint before using it as a source');
      }
      if (!Number.isSafeInteger(placement.checkpointRevision)
        || !/^sha256:[a-f0-9]{64}$/u.test(placement.manifestHash)) {
        throw new Error('Checkpoint metadata does not match the requested space revision');
      }
      // The store verifies the published hash before decrypting the manifest.
      const bytes = await options.blobs.get(placement.manifestKey, placement.manifestHash);
      if (!bytes) throw new Error(`Published checkpoint manifest ${placement.manifestKey} is missing`);
      const manifest = parseWorkspaceCheckpoint(JSON.parse(new TextDecoder().decode(bytes)));
      // The attempt counter can advance while closing, or after a failed close; the key identifies the last publication.
      if (manifest.projectId !== projectId || manifest.spaceId !== spaceId
        || manifest.revision > placement.checkpointRevision
        || placement.manifestKey !== spaceCheckpointManifestKey(projectId, spaceId, manifest.revision)) {
        throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_MISMATCH', message: 'Checkpoint manifest does not match the requested space revision', context: { projectId, spaceId } });
      }
      const { checkpointRef, headCommit } = manifest.repository;
      if (branch !== undefined && manifest.repository.branch !== branch) {
        throw new Error(`Checkpoint branch ${manifest.repository.branch} does not match configured branch ${branch}`);
      }
      if (checkpointRef !== spaceGitCheckpointRef(spaceId, manifest.revision)) {
        throw new Error('Checkpoint Git ref does not match the requested space revision');
      }

      const key = JSON.stringify([resolve(repositoryPath), projectId, checkpointRef, placement.manifestHash]);
      let pending = fetching.get(key);
      if (!pending) {
        pending = (async () => {
          if (await hasCommit(repositoryPath, headCommit)) return;
          await options.gitRemote.fetchCheckpoint({ binding: options.binding(projectId), repositoryPath, checkpointRef });
          if (!await hasCommit(repositoryPath, headCommit)) {
            throw new Error(`Published checkpoint ${checkpointRef} does not contain saved branch head ${headCommit}`);
          }
        })();
        fetching.set(key, pending);
      }
      try {
        await pending;
      } finally {
        if (fetching.get(key) === pending) fetching.delete(key);
      }
      return headCommit;
    } catch (error) {
      throw new Error(`Workspace source ${spaceId} is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
}
