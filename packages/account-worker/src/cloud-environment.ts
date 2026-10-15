import type { z } from 'zod';
import { artifactsWorkspaceRepository, type ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import type { RuntimeGitCheckpoint, RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { EnvironmentError, deriveLifecycleExecutions, loadEnvironmentBundle, parseEnvironmentBundleJson, type LifecycleState } from '@gitspace/protocol-environment';
import type { SpaceAuthorityDO } from './space-authority.js';

const LIFECYCLE_ROOT = '.gitspace/lifecycle';

/**
 * A cloud workspace's environment is its checkpoint worktree: the files the Files tab shows and every cache
 * materializes, committed or not. Each read re-derives bundle and executions from the current checkpoint, so an
 * approval binds the exact content hash a cache recomputes from its own checkout before it claims a run.
 */
export async function refreshCloudEnvironment(input: {
  code: ArtifactsCodeStore;
  environment: Pick<SpaceAuthorityDO, 'refreshBrowserOrigins' | 'mutateLifecycleState'>;
  identity: z.infer<typeof RuntimeIdentitySchema>;
  checkpoint: RuntimeGitCheckpoint;
}): Promise<LifecycleState> {
  const { code, environment, identity, checkpoint } = input;
  const state = await environment.refreshBrowserOrigins(identity);
  // Only the `.gitspace` paths are read, one tree per path segment; never the whole worktree.
  const reader = code.reader(artifactsWorkspaceRepository(identity.workspaceId));
  const trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  const readTree = (oid: string) => {
    let entries = trees.get(oid);
    if (!entries) { entries = reader.readTree(oid); trees.set(oid, entries); }
    return entries;
  };
  const entryAt = async (path: string) => {
    let tree = checkpoint.worktreeTree;
    const segments = path.split('/');
    for (const [index, segment] of segments.entries()) {
      const entry = (await readTree(tree))?.find(item => item.name === segment);
      if (!entry || index === segments.length - 1) return entry ?? null;
      if (entry.type !== 'tree') return null;
      tree = entry.hash;
    }
    return null;
  };
  const text = async (path: string): Promise<string | null> => {
    const entry = await entryAt(path);
    if (!entry || entry.type === 'tree' || entry.type === 'gitlink') return null;
    const blob = await reader.readBlob(entry.hash);
    if (!blob) throw new Error(`${path} is missing from the cloud repository`);
    return blob.text();
  };
  const derive = async () => {
    const source = await text('.gitspace/bundle.json');
    const bundle = source === null ? loadEnvironmentBundle({ version: 1, defaultProfile: 'base', profiles: { base: {} } }) : parseEnvironmentBundleJson(source);
    const executions = await deriveLifecycleExecutions({
      bundle, selectedProfile: state.selectedProfile ?? bundle.defaultProfile,
      // Like a directory listing: nested directories surface by name and fail script-name validation.
      list: async (phase) => {
        const directory = await entryAt(`${LIFECYCLE_ROOT}/${phase}`);
        return directory?.type === 'tree' ? ((await readTree(directory.hash)) ?? []).map(entry => entry.name) : [];
      },
      read: async (phase, fileName) => {
        const command = `${LIFECYCLE_ROOT}/${phase}/${fileName}`;
        const content = await text(command);
        if (content === null) throw new EnvironmentError('InvalidConfiguration', `Lifecycle script ${command} is not a file`);
        return { command, content };
      },
    });
    return { source, bundle, executions };
  };
  const { source, bundle, executions } = await derive().finally(() => reader.close());
  const bundleJson = JSON.stringify(bundle);
  if (source === null && executions.length === 0 && state.bundleJson === null && state.executions.length === 0) return state;
  if (bundleJson === state.bundleJson && JSON.stringify(executions) === JSON.stringify(state.executions)) return state;
  const result = await environment.mutateLifecycleState(identity, { op: 'configure', bundleJson, executions }, {
    machineId: `cloud:${identity.workspaceId}`, actorId: `checkpoint:${checkpoint.worktreeCommit}`, kind: 'client', lifecycleControl: false,
  });
  if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
  return result.state;
}
