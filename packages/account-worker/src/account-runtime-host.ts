import type { WorkspaceEnvironment } from './space-environment.js';
import { createDocumentMarkdown } from './document-markdown.js';
import { ArtifactsCodeStore, artifactsWorkspaceRepository, createWorkspaceRuntime, ExecutorNotConnected, type AttachmentServices, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import type { RuntimeAttachment, RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { forwardTunnelRequest } from './relay-request.js';
import { createRuntimeServices, createRuntimeQaServices, type RuntimeIdentity } from './runtime-services.js';
import { createCloudRuntimeInference } from './runtime-inference.js';
import { z } from 'zod';
import { parseRuntimeSettings, type CloudProjectSummary } from '@gitspace/protocol';
import { matchAstPatterns } from './ast-match.js';
import { createRuntimeRuleServices } from './runtime-instructions.js';
import { createRuntimeInstructionLoader } from './runtime-instruction-loader.js';
import { createAccountGitLfsStore } from './git-lfs-store.js';
import { setCloudWorkspacePhase } from './cloud-workspace-lifecycle.js';
import { readProjectWatch, readSourceCheckpoint, readWorkspaceMetadata, storeWorkspaceReport, storeWorkspaceStatus, writeProjectWatch, type ProjectWatch } from './workspace-metadata.js';
import type { WorkspaceReport } from '@gitspace/protocol-workspace';
import { notifyMachines } from './machine-notices.js';
import { notifyBrowsers } from './live-notices.js';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { originAccess, originReadCredentials } from './origin-access.js';
import { remoteDefaultBranch } from './cloud-project.js';

/** The project repository every workspace forks: a scratch repository with an initial commit, or the origin's history,
 * imported natively from a public origin or streamed with installation-token reads from a covered one. */
export async function ensureProjectCodeRepository(env: Env, code: ArtifactsCodeStore, project: Pick<CloudProjectSummary, 'id' | 'repositoryReference' | 'baseBranch'>) {
  if (project.repositoryReference === null) return code.ensureEmptyProject(project.id, project.baseBranch);
  const access = await originAccess(env, project.repositoryReference);
  // A covered import is read by branch name: an unresolved base ('HEAD') is the origin's default branch.
  const branch = access.kind === 'github-app' && project.baseBranch === 'HEAD' ? await remoteDefaultBranch(env, project.repositoryReference) : project.baseBranch;
  if (branch === null) throw new Error(`GitSpace can't read the default branch of ${access.remote}`);
  return code.importProject(project.id, { url: access.remote, branch }, originReadCredentials(access));
}

/** Repository identities and origins come only from canonical project metadata. */
export async function ensureRuntimeCodeRepository(env: Env, userId: string, identity: RuntimeIdentity) {
  if (userId !== env.ACCOUNT_ID) throw new Error('Repository lease belongs to a different account');
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${identity.projectId}`);
  const project = await authority.getProject();
  if (!project || project.id !== identity.projectId) throw new Error('Project is unavailable');
  if (identity.workspaceId !== project.id && !await authority.getWorkspace(identity.workspaceId)) throw new Error('Workspace is not owned by this project');
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  await ensureProjectCodeRepository(env, code, project);
  return code.forkWorkspace(project.id, identity.workspaceId);
}

/** Resolves the workspace branch ref once its code repository exists. A failed preparation
 * is not cached: an import waiting on a machine seed succeeds on a later call. */
export function runtimeWorkspaceCodeRef(env: Env, identity: RuntimeIdentity, branch: () => string): () => Promise<string> {
  let codeReady: Promise<unknown> | undefined;
  return async () => {
    codeReady ??= ensureRuntimeCodeRepository(env, env.ACCOUNT_ID, identity).catch((error: unknown) => {
      codeReady = undefined;
      throw error;
    });
    await codeReady;
    return `refs/heads/${branch()}`;
  };
}

/** The SpaceAuthority actor supplies storage, its seeded workspace metadata and its coalesced outbox/runtime alarm. */
export async function createAccountWorkspaceRuntime(
  ctx: DurableObjectState,
  env: Env,
  identity: RuntimeIdentity,
  schedule: (timestamp: number) => Promise<void>,
  requestAttachment: (machineId: string) => Promise<{ attachment: RuntimeAttachment }>,
  environment: WorkspaceEnvironment,
): Promise<WorkspaceRuntime> {
  // The workspace's own metadata, read per use: a base branch change moves the branch this runtime reads code from.
  const metadata = () => {
    const current = readWorkspaceMetadata(ctx.storage);
    if (!current || current.projectId !== identity.projectId || current.workspaceId !== identity.workspaceId) throw new Error('Workspace metadata is unavailable');
    return current;
  };
  const base = metadata().kind === 'base';
  // A project's base space has no phase; it is never plan-locked.
  const workspacePhase = base ? 'code' : metadata().phase ?? 'plan';
  const inference = await createCloudRuntimeInference(ctx, env, identity);
  const configuration = await env.USER_SETTINGS.getByName(env.ACCOUNT_ID).getRuntime();
  const settings = parseRuntimeSettings(JSON.parse(configuration.content || '{}'));
  const judge = async (conversationId: string, state: string, questions: Record<string, string>) => {
    const answers = z.record(z.string(), z.object({ bool: z.number().min(0).max(1) })).parse(await inference.modelHelper({ conversationId, operation: 'judge', args: { state, questions: Object.fromEntries(Object.entries(questions).map(([id, instructions]) => [id, { type: 'bool', instructions }])) } }));
    const scores: Record<string, number> = {};
    for (const id of Object.keys(questions)) {
      const answer = answers[id];
      if (!answer) throw new Error(`Judge omitted question ${id}`);
      scores[id] = answer.bool;
    }
    return scores;
  };
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  const repository = artifactsWorkspaceRepository(identity.workspaceId);
  const ref = runtimeWorkspaceCodeRef(env, identity, () => metadata().branch);
  const instructionLoader = createRuntimeInstructionLoader({ code, repository, ref });
  let runtime: WorkspaceRuntime | undefined;
  const documentMarkdown = createDocumentMarkdown(ctx.storage, env.AI);
  const services = createRuntimeServices({ ctx, env, identity, schedule, requestAttachment, environment, documentMarkdown, generateImage: inference.generateImage, model: inference.modelHelper, judge, instructionLoader, runtime() {
    if (!runtime) throw new Error('Runtime services were invoked before the Harness opened');
    return runtime;
  } });
  const lfs = await createAccountGitLfsStore(env, env.ACCOUNT_ID, identity.projectId, `runtime:${identity.workspaceId}`);
  const qa = createRuntimeQaServices(env, identity);
  runtime = await createWorkspaceRuntime({
    ...inference,
    workspacePhase,
    async setWorkspacePhase(phase) { await setCloudWorkspacePhase(env, env.ACCOUNT_ID, identity, phase); },
    published: (snapshot, report) => {
      const status = report.summary;
      // The sidebar's row: sent to every tab only when the status changed.
      if (storeWorkspaceStatus(ctx.storage, status)) ctx.waitUntil(env.USER_PROJECTS.getByName(env.ACCOUNT_ID).setWorkspaceStatus({ ...identity, status }).catch((error: unknown) => console.error('Workspace status was not sent', { workspaceId: identity.workspaceId, error })));
      storeWorkspaceReport(ctx.storage, report);
      const watch = readProjectWatch(ctx.storage);
      if (watch && status.primaryColor !== watch.color) {
        writeProjectWatch(ctx.storage, watch.name, status.primaryColor);
        const line = projectNotice(watch, report);
        if (line) ctx.waitUntil(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`).runtimeProjectNotice({ projectId: identity.projectId, workspaceId: identity.projectId }, line).catch((error: unknown) => console.error('Project notice was not sent', { workspaceId: identity.workspaceId, error })));
      }
      ctx.waitUntil(notifyBrowsers(env, [{ ...workspaceLiveKey(identity.workspaceId, 'runtime', identity.projectId), version: snapshot.cursor }]));
    },
    snapshotChanged: machineIds => {
      ctx.waitUntil(notifyMachines(env, machineIds, ['workspace.snapshot'], identity.workspaceId));
      // The environment is derived from the workspace's files: derive it when they change, not when it is read.
      ctx.waitUntil(environment.currentLifecycleState(identity).catch((error: unknown) => console.error('Environment was not derived', { workspaceId: identity.workspaceId, error })));
    },
    code,
    lfs,
    async retainLfs(checkpoint, publicationId) {
      // Stubs are made per call here: this runtime outlives any one of them, and one that saw an error (the project
      // object resetting for a release) stays broken, failing every later snapshot commit until the workspace restarts.
      const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
      await project.lfsRetain({ snapshotId: `runtime:${identity.workspaceId}:${checkpoint.worktreeCommit}`, workspaceId: identity.workspaceId, kind: 'runtime', objects: checkpoint.lfs?.objects ?? [] });
      if (publicationId) await project.lfsReleasePublication(publicationId);
      else await lfs.releasePublication();
    },
    documentMarkdown,
    initialCheckpoint: async () => {
      const branchRef = await ref();
      return code.initialCheckpoint(repository, identity.workspaceId, branchRef.slice('refs/heads/'.length), readSourceCheckpoint(ctx.storage));
    },
    settings,
    // Rule AST conditions match in this Worker, so they apply with or without an attached machine.
    retainedRules: createRuntimeRuleServices({ code, repository, ref, judge, matchAst: (_conversationId, content, paths, patterns) => matchAstPatterns(content, paths, patterns) }),
    ...services,
    browser: services.browser,
    storage: ctx.storage,
    identity,
    waitUntil: promise => ctx.waitUntil(promise),
    schedule,
    qa,
    onReport: error => { ctx.waitUntil(qa.report(error instanceof Error ? error.message : String(error))); },
    attachments: {
      seal: (secret, scope) => env.CREDENTIALS.getByName(env.ACCOUNT_ID).sealRuntimeGrant(secret, scope),
      open: (ciphertext, scope) => env.CREDENTIALS.getByName(env.ACCOUNT_ID).openRuntimeGrant(ciphertext, scope),
      dispatch: input => dispatchRuntimeAttachment(env, input),
    },
  });
  ctx.waitUntil(runtime.wake());
  return runtime;
}

/** The line a watched workspace sends its project conversation when its status color changes, or null for a change
 * nobody needs to hear (work starting). "Finished" counts only after work, so starting a workspace never announces it. */
export function projectNotice(watch: ProjectWatch, report: WorkspaceReport): string | null {
  const name = `Workspace ${watch.name}`;
  switch (report.summary.primaryColor) {
    case 'red': return `${name} failed: ${report.failure ?? 'open it to see why'}`;
    case 'orange': return report.waitingOn?.kind === 'approval' ? `${name} needs approval: ${report.waitingOn.prompt}` : `${name} has a sync conflict.`;
    case 'blue':
      if (watch.color !== 'green') return null;
      return report.waitingOn?.kind === 'ask' ? `${name} asked: ${report.waitingOn.prompt}` : `${name} finished its turn${report.lastReply ? `: ${report.lastReply}` : '.'}`;
    case 'green': case 'dim': return null;
  }
}

/** Every machine executes through the tenant relay tunnel; a missing tunnel fails at once. */
export async function dispatchRuntimeAttachment(env: Env, input: Parameters<AttachmentServices['dispatch']>[0]): Promise<Response> {
  const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(input.machineId);
  if (!machine || machine.state !== 'online' || machine.desiredState !== 'online') throw new ExecutorNotConnected(input.machineId);
  const path = '/runtime/execute';
  const request = new Request(new URL(`/tunnel/${encodeURIComponent(input.machineId)}${path}`, env.RELAY_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gitspace-execution-signature': input.signature },
    // AttachmentStore signs this exact serialized string; never re-encode the body.
    body: input.body,
    signal: input.signal,
  });
  input.signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(input.signal.reason);
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await Promise.race([forwardTunnelRequest(request, env, { machineId: input.machineId, path }), aborted.promise]);
    if (response.status === 503) {
      // The relay answers MACHINE_OFFLINE only before dispatch: the request provably never left.
      const body = z.object({ error: z.object({ code: z.string() }) }).safeParse(await Promise.race([response.clone().json().catch(() => null), aborted.promise]));
      if (body.success && body.data.error.code === 'MACHINE_OFFLINE') throw new ExecutorNotConnected(input.machineId);
    }
    return response;
  } finally { input.signal.removeEventListener('abort', onAbort); }
}
