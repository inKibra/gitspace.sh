import { z } from 'zod';
import type { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { EnvironmentError, executionHash, LifecyclePhaseSchema, type LifecycleActor, type LifecycleState } from '@gitspace/protocol-environment';
import { GitHubApiError, githubRequest } from './github-api.js';
import type { WorkspaceEnvironment } from './space-environment.js';

const LIFECYCLE_ROOT = '.gitspace/lifecycle';
/** The largest script content an execution holds (`LifecycleExecutionSchema`). */
const SCRIPT_CONTENT_LIMIT = 131_072;

/**
 * A person's approval of execution content in one workspace, as the Environment tab's approve records it: each hash
 * must be an execution the workspace currently derives, with content that still hashes to it. `project` scope shares
 * the approval with every workspace of the project.
 */
export async function approveExecutionsAsPerson(
  environment: Pick<WorkspaceEnvironment, 'currentLifecycleState' | 'mutateLifecycleState'>,
  identity: z.infer<typeof RuntimeIdentitySchema>,
  input: { executionHashes: readonly string[]; scope: 'project' | 'workspace'; person: { deviceId: string; kind: LifecycleActor['kind']; lifecycleControl: boolean } },
): Promise<LifecycleState> {
  if (!input.person.lifecycleControl) throw new EnvironmentError('PermissionDenied', 'Execution approval requires lifecycle control authorization');
  let state = await environment.currentLifecycleState(identity);
  for (const hash of input.executionHashes) {
    const execution = state.executions.find((entry) => entry.hash === hash);
    if (!execution || await executionHash({ kind: execution.kind, command: execution.content }) !== hash) {
      throw new EnvironmentError('ContentChanged', 'Refresh the environment and review current content before approving', { executionHash: hash });
    }
  }
  const actor: LifecycleActor = { actorId: input.person.deviceId, machineId: input.person.deviceId, kind: input.person.kind, lifecycleControl: true };
  for (const hash of input.executionHashes) {
    const result = await environment.mutateLifecycleState(identity, { op: 'approval', scope: input.scope, executionHash: hash, approved: true }, actor);
    if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
    state = result.state;
  }
  return state;
}

/** A lifecycle script at the base branch tip whose last change reached the branch through merged pull request `pullRequest`. */
export interface MergedLifecycleScript { path: string; executionHash: string; pullRequest: number }

const ContentEntrySchema = z.object({ type: z.string(), path: z.string(), sha: z.string(), size: z.number() });
const BlobSchema = z.object({ content: z.string(), encoding: z.literal('base64') });
const PullSchema = z.object({ number: z.number().int(), merged_at: z.string().nullable(), base: z.object({ ref: z.string() }) });

/** The merged pull request into `branch` that GitHub associates with `commit`, or null when none is. */
export async function mergedPullRequestOf(input: { repository: string; branch: string; commit: string; token: string | undefined }): Promise<number | null> {
  const pulls = await githubRequest(`/repos/${input.repository}/commits/${input.commit}/pulls?per_page=100`, { token: input.token, schema: z.array(PullSchema) });
  return pulls.find((pull) => pull.merged_at !== null && pull.base.ref === input.branch)?.number ?? null;
}

/**
 * The trust rule: the lifecycle scripts in the repository at `tip` of its base branch `branch` whose last change (the
 * newest commit touching the file in the tip's history) came to the branch through a merged pull request. A file last
 * changed by a direct push, or whose last change no merged pull request into `branch` carries, is left out.
 * `mergedPullRequest` answers for one commit; the caller keeps its answers. Any GitHub failure throws.
 */
export async function readMergedLifecycleScripts(input: {
  repository: string; branch: string; tip: string; token: string | undefined;
  mergedPullRequest(commit: string): Promise<number | null>;
}): Promise<MergedLifecycleScript[]> {
  const { repository, tip, token } = input;
  const files = (await Promise.all(LifecyclePhaseSchema.options.map(async (phase) => {
    try {
      const entries = await githubRequest(`/repos/${repository}/contents/${LIFECYCLE_ROOT}/${phase}?ref=${tip}`, { token, schema: z.array(ContentEntrySchema) });
      return entries.filter((entry) => entry.type === 'file' && entry.size <= SCRIPT_CONTENT_LIMIT);
    } catch (error) {
      // A phase without a directory at the tip has no scripts.
      if (error instanceof GitHubApiError && error.status === 404) return [];
      throw error;
    }
  }))).flat();
  const scripts = await Promise.all(files.map(async (file): Promise<MergedLifecycleScript | null> => {
    const [last] = await githubRequest(`/repos/${repository}/commits?sha=${tip}&path=${encodeURIComponent(file.path)}&per_page=1`, { token, schema: z.array(z.object({ sha: z.string() })) });
    if (!last) return null;
    const pullRequest = await input.mergedPullRequest(last.sha);
    if (pullRequest === null) return null;
    const blob = await githubRequest(`/repos/${repository}/git/blobs/${file.sha}`, { token, schema: BlobSchema });
    const bytes = Uint8Array.from(atob(blob.content.replace(/\s/gu, '')), (character) => character.charCodeAt(0));
    return { path: file.path, executionHash: await executionHash({ kind: 'script', command: new TextDecoder().decode(bytes) }), pullRequest };
  }));
  return scripts.filter((script) => script !== null);
}
