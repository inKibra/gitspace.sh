import type { z } from 'zod';
import { artifactsWorkspaceRepository, type ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import type { RuntimeGitCheckpoint, RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { EnvironmentError, deriveLifecycleExecutions, loadEnvironmentBundle, parseEnvironmentBundleJson, type LifecycleState } from '@gitspace/protocol-environment';
import type { ProjectAuthorityDO } from './project-authority.js';

const LIFECYCLE_ROOT = '.gitspace/lifecycle';

/**
 * A cloud workspace's environment is its checkpoint worktree: the files the Files tab shows and every cache
 * materializes, committed or not. Each read re-derives bundle and executions from the current checkpoint, so an
 * approval binds the exact content hash a cache recomputes from its own checkout before it claims a run.
 */
export async function refreshCloudEnvironment(input: {
  code: ArtifactsCodeStore;
  authority: DurableObjectStub<ProjectAuthorityDO>;
  identity: z.infer<typeof RuntimeIdentitySchema>;
  checkpoint: RuntimeGitCheckpoint;
}): Promise<LifecycleState> {
  const { code, authority, identity, checkpoint } = input;
  const state = await authority.refreshBrowserOrigins(identity.workspaceId);
  const repository = artifactsWorkspaceRepository(identity.workspaceId);
  const [worktree] = await code.listSnapshotInventories(repository, [checkpoint.worktreeTree]);
  if (!worktree) throw new Error('Cloud workspace worktree is unavailable');
  const text = async (path: string): Promise<string | null> => {
    const entry = worktree.get(path);
    if (!entry || entry.type !== 'blob') return null;
    const blob = await code.readBlob(repository, entry.oid);
    if (!blob) throw new Error(`${path} is missing from the cloud repository`);
    return blob.text();
  };
  const source = await text('.gitspace/bundle.json');
  const bundle = source === null ? loadEnvironmentBundle({ version: 1, defaultProfile: 'base', profiles: { base: {} } }) : parseEnvironmentBundleJson(source);
  const executions = await deriveLifecycleExecutions({
    bundle, selectedProfile: state.selectedProfile ?? bundle.defaultProfile,
    // Like a directory listing: nested entries surface as their first segment and fail script-name validation.
    list: async (phase) => {
      const directory = `${LIFECYCLE_ROOT}/${phase}/`;
      return [...new Set([...worktree.keys()].filter(path => path.startsWith(directory)).map(path => path.slice(directory.length).split('/')[0]!))];
    },
    read: async (phase, fileName) => {
      const command = `${LIFECYCLE_ROOT}/${phase}/${fileName}`;
      const content = await text(command);
      if (content === null) throw new EnvironmentError('InvalidConfiguration', `Lifecycle script ${command} is not a file`);
      return { command, content };
    },
  });
  const bundleJson = JSON.stringify(bundle);
  if (source === null && executions.length === 0 && state.bundleJson === null && state.executions.length === 0) return state;
  if (bundleJson === state.bundleJson && JSON.stringify(executions) === JSON.stringify(state.executions)) return state;
  const result = await authority.mutateLifecycleState(identity.workspaceId, { op: 'configure', bundleJson, executions }, {
    machineId: `cloud:${identity.workspaceId}`, actorId: `checkpoint:${checkpoint.worktreeCommit}`, kind: 'client', lifecycleControl: false,
  });
  if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
  return result.state;
}
