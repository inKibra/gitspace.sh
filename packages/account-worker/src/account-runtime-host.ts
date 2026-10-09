import { ArtifactsCodeStore, artifactsWorkspaceRepository, createWorkspaceRuntime, ExecutorNotConnected, type AttachmentServices, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import { RuntimeReceiptTransportSchema, type RuntimeReceiptTransport } from '@gitspace/protocol-runtime';
import { forwardTunnelRequest } from './relay-request.js';
import { createRuntimeServices, createRuntimeQaServices, type RuntimeIdentity } from './runtime-services.js';
import { createCloudRuntimeInference } from './runtime-inference.js';
import { z } from 'zod';
import { parseRuntimeSettings } from '@gitspace/protocol';
import { createRuntimeRuleServices } from './runtime-instructions.js';
import { createRuntimeInstructionLoader } from './runtime-instruction-loader.js';
import { createAccountGitLfsStore } from './git-lfs-store.js';

/** Repository identities and origins come only from canonical project metadata.
 * Scratch projects have an initial commit; imported repositories retain their history. */
export async function ensureRuntimeCodeRepository(env: Env, userId: string, identity: RuntimeIdentity) {
  if (userId !== env.ACCOUNT_ID) throw new Error('Repository lease belongs to a different account');
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${identity.projectId}`);
  const project = await authority.getProject();
  if (!project || project.id !== identity.projectId) throw new Error('Project is unavailable');
  if (identity.workspaceId !== project.id && !(await authority.listWorkspaces()).some(workspace => workspace.id === identity.workspaceId)) throw new Error('Workspace is not owned by this project');
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  if (project.repositoryReference === null) {
    await code.ensureEmptyProject(project.id, project.baseBranch);
  } else {
    const url = project.repositoryReference.replace(/^git@github\.com:/u, 'https://github.com/');
    await code.importProject(project.id, { url, branch: project.baseBranch });
  }
  return code.forkWorkspace(project.id, identity.workspaceId);
}

/** Resolves the workspace branch ref once its code repository exists. A failed preparation
 * is not cached: an import waiting on a machine seed succeeds on a later call. */
export function runtimeWorkspaceCodeRef(env: Env, identity: RuntimeIdentity): () => Promise<string> {
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  let codeReady: Promise<unknown> | undefined;
  return async () => {
    codeReady ??= ensureRuntimeCodeRepository(env, env.ACCOUNT_ID, identity).catch((error: unknown) => {
      codeReady = undefined;
      throw error;
    });
    await codeReady;
    const workspace = (await project.listWorkspaces()).find(item => item.id === identity.workspaceId);
    if (!workspace) throw new Error('Canonical workspace code source is unavailable');
    return `refs/heads/${workspace.branch}`;
  };
}

/** The SpaceAuthority actor supplies storage and its coalesced outbox/runtime alarm. */
export async function createAccountWorkspaceRuntime(
  ctx: DurableObjectState,
  env: Env,
  identity: RuntimeIdentity,
  schedule: (timestamp: number) => Promise<void>,
): Promise<WorkspaceRuntime> {
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const workspaces = await project.listWorkspaces();
  const canonicalProject = await project.getProject();
  if (!canonicalProject || canonicalProject.id !== identity.projectId || (identity.workspaceId !== canonicalProject.id && !workspaces.some(workspace => workspace.id === identity.workspaceId && workspace.projectId === identity.projectId))) throw new Error('Workspace is not owned by this project');
  if (identity.workspaceId === canonicalProject.id) await project.ensureBaseWorkspace({ userId: env.ACCOUNT_ID, projectId: identity.projectId });
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
  const ref = runtimeWorkspaceCodeRef(env, identity);
  const instructionLoader = createRuntimeInstructionLoader({ code, repository, ref });
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  let runtime: WorkspaceRuntime | undefined;
  const services = createRuntimeServices({ ctx, env, identity, schedule, generateImage: inference.generateImage, model: inference.modelHelper, judge, instructionLoader, runtime() {
    if (!runtime) throw new Error('Runtime services were invoked before the Harness opened');
    return runtime;
  } });
  const lfs = await createAccountGitLfsStore(env, env.ACCOUNT_ID, identity.projectId, `runtime:${identity.workspaceId}`);
  runtime = await createWorkspaceRuntime({
    ...inference,
    code,
    lfs,
    async retainLfs(checkpoint, publicationId) {
      await project.lfsRetain({ snapshotId: `runtime:${identity.workspaceId}:${checkpoint.worktreeCommit}`, workspaceId: identity.workspaceId, kind: 'runtime', objects: checkpoint.lfs?.objects ?? [] });
      if (publicationId) await project.lfsReleasePublication(publicationId);
      else await lfs.releasePublication();
    },
    initialCheckpoint: async () => {
      const branchRef = await ref();
      return code.initialCheckpoint(repository, identity.workspaceId, branchRef.slice('refs/heads/'.length));
    },
    settings,
    retainedRules: createRuntimeRuleServices({ code, repository, ref, judge, async matchAst(conversationId, content, paths, patterns) {
      const requestId = `rules:${crypto.randomUUID()}`;
      const result = await services.tools.invoke({ tool: 'rule_match_ast', args: { content, paths, patterns }, conversationId, taskId: requestId, requestId, attemptId: requestId, replay: 'safe', signal: AbortSignal.timeout(30_000) });
      if (result.status !== 'completed') return false;
      const text = result.content.find(item => item.type === 'text');
      if (!text || text.type !== 'text') throw new Error('AST rule matching omitted its result');
      return z.object({ matched: z.boolean() }).parse(JSON.parse(text.text)).matched;
    } }),
    ...services,
    browser: services.browser,
    storage: ctx.storage,
    identity,
    waitUntil: promise => ctx.waitUntil(promise),
    schedule,
    qa: createRuntimeQaServices(env, identity),
    attachments: {
      seal: (secret, scope) => vault.sealRuntimeGrant(secret, scope),
      open: (ciphertext, scope) => vault.openRuntimeGrant(ciphertext, scope),
      async admitExecution(machineId) {
        const admission = await env.TENANT_RELEASES.getByName(env.ACCOUNT_ID).machineExecutionAdmission(machineId);
        if (admission.state !== 'ready') throw new Error(admission.error ?? `Updating machine: executor protocol ${admission.required} is required before agent execution.`);
      },
      dispatch: input => dispatchRuntimeAttachment(env, input),
    },
  });
  ctx.waitUntil(runtime.wake());
  return runtime;
}

/** Every machine executes through the tenant relay tunnel; a missing tunnel fails at once. */
export async function dispatchRuntimeAttachment(env: Env, input: Parameters<AttachmentServices['dispatch']>[0]): Promise<RuntimeReceiptTransport> {
  const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(input.machineId);
  if (!machine || machine.state !== 'online' || machine.desiredState !== 'online') throw new Error('Assigned executor is unavailable');
  const request = new Request(new URL(`/tunnel/${encodeURIComponent(input.machineId)}${input.path}`, env.RELAY_URL), {
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
    const response = await Promise.race([forwardTunnelRequest(request, env, { machineId: input.machineId, path: input.path }), aborted.promise]);
    if (response.status === 503) {
      // The relay answers MACHINE_OFFLINE only before dispatch: the request provably never left.
      const body = z.object({ error: z.object({ code: z.string() }) }).safeParse(await Promise.race([response.json().catch(() => null), aborted.promise]));
      if (body.success && body.data.error.code === 'MACHINE_OFFLINE') throw new ExecutorNotConnected(input.machineId);
    }
    if (!response.ok) throw new Error(`Executor transport returned ${response.status}`);
    return RuntimeReceiptTransportSchema.parse(await Promise.race([response.json(), aborted.promise]));
  } finally { input.signal.removeEventListener('abort', onAbort); }
}
