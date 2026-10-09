import { z } from 'zod';
import { canonicalJson, RuntimeIdentitySchema, RuntimeJsonSchema, RuntimeSnapshotSchema, RuntimeTranscriptSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema, type RuntimeSnapshot, type RuntimeToolResult, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { LifecycleMutationSchema, approvedBrowserOrigins, projectEnvironmentState } from '@gitspace/protocol-environment';
import { GITSPACE_SOURCE_REPOSITORY } from '@gitspace/protocol/project-authority';
import { RuntimeQaItemSchema, type RuntimeQaActionInput } from '@gitspace/protocol-runtime/workspace-controls';
import { ArtifactsCodeStore, artifactsWorkspaceRepository, CloudPublicationUncertain, ExecutorNotConnected, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { RuntimeAgentLifecycleRunArgumentsSchema, RuntimeEnvironmentArgumentsSchema, RuntimeMachinesArgumentsSchema, RuntimeSpaceArtifactsArgumentsSchema, RuntimeReadArgumentsSchema, RuntimeReportIssueArgumentsSchema, RuntimeHistoryReadArgumentsSchema, RuntimeHistorySearchArgumentsSchema, RuntimeWebSearchArgumentsSchema } from '@gitspace/protocol-runtime';
import { isSubagentToolCallAllowed } from '@gitspace/protocol-runtime';
import { RuntimeWorkspaceArgumentsSchema } from '@gitspace/protocol/inspector-contract';
import { readInspectorContext, InspectorCloudArtifacts } from './account-inspector-data.js';
import { createCloudRuntimeMcp } from './runtime-mcp.js';
import { DEFAULT_SKILLS } from '@gitspace/protocol/default-skills';
import { RuntimeHistoryIndex, type HistoryDocument } from '@gitspace/runtime-core/history';
import type { RetainedRuleServices } from '@gitspace/runtime-core/retained-rules';
import type { RuntimeInstructionLoader } from './runtime-instruction-loader.js';
import { createDispatchSelector } from './runtime-dispatch-selection.js';
import { invokeRuntimeSpaceTool, runtimeSpaceToolNames } from './runtime-space-tools.js';
import { createRuntimeBrowserAuthority, type RuntimeBrowserAuthority } from './runtime-browser.js';
import { createCloudCodemode } from './runtime-codemode.js';
import type { RuntimeModelHelper } from './runtime-inference.js';
import { RuntimeProcArgumentsSchema, RuntimeGrepArgumentsSchema } from '@gitspace/protocol-runtime';
import { caughtUpSearchCache, type RuntimeAttachment, type RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { fetchInternalService, isHostedServiceHostname } from './service-access.js';
import { refreshCloudEnvironment } from './cloud-environment.js';

import { projectEventSchema } from '@gitspace/protocol/project-authority';
export type RuntimeIdentity = Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>;
type Invocation = Parameters<WorkspaceRuntimeOptions['tools']['invoke']>[0];
type Operation = Parameters<WorkspaceRuntimeOptions['operations']['execute']>[0];
type ServicesOptions = {
  ctx: DurableObjectState;
  env: Env;
  identity: RuntimeIdentity;
  runtime(): WorkspaceRuntime;
  schedule(timestamp: number): Promise<void>;
  generateImage(input: { args: Invocation['args']; conversationId: string; signal?: AbortSignal }): Promise<RuntimeToolResult['content']>;
  judge: RetainedRuleServices['judge'];
  model: RuntimeModelHelper;
  instructionLoader: RuntimeInstructionLoader;
};
const object = z.record(z.string(), RuntimeJsonSchema);
const methodSchema = z.object({ method: z.string().min(1) });
const idSchema = z.string().min(1);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const completed = (input: Pick<Invocation, 'requestId' | 'attemptId'>, value: unknown): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: JSON.stringify(value) }] });
const interrupted = (input: Pick<Invocation, 'requestId' | 'attemptId'>, text: string): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'interrupted', content: [{ type: 'text', text }] });
const failed = (input: Pick<Invocation, 'requestId' | 'attemptId'>, error: unknown): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'failed', content: [{ type: 'text', text: message(error) }], error: { code: 'HOST_OPERATION_FAILED', message: message(error) } });
const machineTools: Record<string, true | undefined> = { bash: true, ast_grep: true, ast_edit: true, ast_resolve: true, proc: true, lifecycle: true, create: true, checkpoint_code: true, merge: true, delegate_export: true, rule_match_ast: true };
machineTools.browser = true;

/** QA is written to the existing project event authority; nothing is sent externally. */
export async function appendRuntimeQa(env: Env, identity: RuntimeIdentity, id: string, report: z.infer<typeof RuntimeReportIssueArgumentsSchema>) {
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const item = RuntimeQaItemSchema.parse({ id, title: report.message.split('\n')[0]!.slice(0, 160), description: report.message, historyRef: report.reference ?? `history://${identity.workspaceId}`, tool: report.tool ?? null, model: report.model ?? 'unattributed', runtimeVersion: 'pi-1.0', state: 'open', duplicateOf: null, createdAt: new Date().toISOString() });
  const event = projectEventSchema.parse(await (await authority.appendEvent({ eventId: `qa:${id}`, scope: 'workspace', entity: 'qa', entityId: id, revision: 1, operation: 'created', payload: { item, workspaceId: identity.workspaceId } })).json());
  return RuntimeQaItemSchema.parse(event.payload.item);
}
export async function listRuntimeQa(env: Env, projectId: string) {
  const events = z.array(projectEventSchema).parse(await (await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).listEvents(0)).json());
  const items = new Map<string, z.infer<typeof RuntimeQaItemSchema>>();
  for (const event of events) {
    if (event.entity !== 'qa') continue;
    const item = RuntimeQaItemSchema.parse(event.payload.item);
    items.set(item.id, item);
  }
  return [...items.values()];
}

export function createRuntimeQaServices(env: Env, identity: RuntimeIdentity) {
  return {
    list: () => listRuntimeQa(env, identity.projectId),
    async act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }> {
      if (!actor.canApprove) throw new Error('QA management requires explicit human control');
      if (input.projectId !== identity.projectId || input.workspaceId !== identity.workspaceId) throw new Error('QA action scope changed');
      const items = await listRuntimeQa(env, identity.projectId);
      const item = items.find(candidate => candidate.id === input.itemId);
      if (!item) throw new Error('QA item does not belong to this project');
      const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
      if (input.action.kind === 'share') {
        const reference = input.action.target === 'gitspace' ? GITSPACE_SOURCE_REPOSITORY : (await authority.getProject())?.repositoryReference;
        if (!reference) throw new Error('Project has no canonical repository');
        const repository = new URL(reference.replace(/^git@github\.com:/u, 'https://github.com/').replace(/\.git$/u, ''));
        if (repository.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+\/?$/u.test(repository.pathname)) throw new Error('Issue drafts require a canonical GitHub repository');
        const url = new URL(`${repository.pathname.replace(/\/$/u, '')}/issues/new`, 'https://github.com');
        url.searchParams.set('title', item.title);
        url.searchParams.set('body', input.action.redactedExcerpt);
        // A draft is not a delivery receipt. Keep the local item open until an
        // authorized integration can prove that an external issue was created.
        return { shareDraft: url.toString() };
      }
      if (input.action.kind === 'merge') {
        const targetId = input.action.targetId;
        const target = items.find(candidate => candidate.id === targetId);
        if (!target || target.id === item.id || target.state === 'merged') throw new Error('Duplicate target must be a distinct canonical QA item');
      }
      const next = { ...item, state: input.action.kind === 'dismiss' ? 'dismissed' as const : 'merged' as const, duplicateOf: input.action.kind === 'merge' ? input.action.targetId : null };
      await authority.appendEvent({ scope: 'workspace', entity: 'qa', entityId: item.id, revision: 1, operation: 'updated', payload: { item: next, workspaceId: identity.workspaceId, actorId: actor.deviceId } });
      return {};
    },
  };
}

/** Cron grants name resources, not shell privileges. Opaque effects cannot be
 * proven to remain inside a resource grant and therefore are not admitted. */
export async function authorizeCronTool(input: { tool: string; args: Invocation['args']; readScopes: readonly string[]; writeScopes: readonly string[] }): Promise<void> {
  const args = object.parse(input.args);
  let resource: string;
  let write = false;
  if (['read', 'write', 'edit', 'grep', 'find', 'ast_grep'].includes(input.tool)) {
    const path = z.string().min(1).parse(args.path ?? (input.tool === 'find' || input.tool === 'grep' ? '.' : undefined));
    if (path.startsWith('local://')) {
      const uri = new URL(path);
      const segments = decodeURIComponent(uri.pathname).split('/').filter(Boolean);
      if (!['base', 'workspace'].includes(uri.hostname) || segments.some(segment => segment === '..' || segment === '.')) throw new Error('Cron resource escapes its artifact scope');
      resource = `local://${uri.hostname}/${segments.join('/')}`;
    } else {
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => segment === '..')) throw new Error('Cron repository paths must stay relative to their checkout');
      resource = `repository/${path.split('/').filter(segment => segment && segment !== '.').join('/')}`;
    }
    write = input.tool === 'write' || input.tool === 'edit';
  } else if (input.tool === 'space_artifacts' && args.method === 'read') {
    const uri = new URL(z.string().url().parse(args.url));
    const segments = decodeURIComponent(uri.pathname).split('/').filter(Boolean);
    if (uri.protocol !== 'local:' || !['base', 'workspace'].includes(uri.hostname) || segments.some(segment => segment === '..' || segment === '.')) throw new Error('Cron resource escapes its artifact scope');
    resource = `local://${uri.hostname}/${segments.join('/')}`;
  } else if (input.tool === 'space_artifacts' && args.method === 'readCode') {
    const path = z.string().min(1).parse(args.path);
    if (path.startsWith('/') || path.split('/').some(segment => segment === '..')) throw new Error('Cron code path escapes the repository');
    resource = `repository/${path}`;
  } else {
    throw new Error(`Cron resource grants do not authorize ${input.tool}; shell, lifecycle and management authority cannot be inferred from file scopes`);
  }
  const scopes = write ? input.writeScopes : input.readScopes;
  const allowed = scopes.some(scope => {
    const escaped = scope.split('**').map(part => part.split('*').map(literal => literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^(?:${escaped})$`, 'u').test(resource);
  });
  if (!allowed) throw new Error(`Cron ${write ? 'write' : 'read'} scope does not authorize ${resource}`);
}

export function createRuntimeServices(options: ServicesOptions): Pick<WorkspaceRuntimeOptions, 'tools' | 'operations' | 'onReport'> & { browser: RuntimeBrowserAuthority['manage'] } {
  const { ctx, env, identity } = options;
  const baseWorkspaceId: string = identity.projectId;
  const mcp = createCloudRuntimeMcp(env, identity);
  const codemode = createCloudCodemode({ loader: env.CODEMODE_LOADER, storage: ctx.storage, model: options.model });
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const source = () => readInspectorContext(env, env.ACCOUNT_ID, identity.workspaceId, identity.projectId);
  const browser = createRuntimeBrowserAuthority({
    storage: ctx.storage, env, identity, runtime: options.runtime,
    serviceFetch: request => fetchInternalService(env, { kind: 'cloud', accountId: env.ACCOUNT_ID, ...identity }, request),
    serviceHostname: hostname => isHostedServiceHostname(env, hostname),
    workspaceServiceHostname: async (hostname, scope) => {
      if (!isHostedServiceHostname(env, hostname) || scope.projectId !== identity.projectId || scope.workspaceId !== identity.workspaceId) return false;
      const route = await env.HOSTED_ROUTES.getByName(hostname).get();
      return !!route && route.tenant === env.ACCOUNT_ID && route.workspaceId === scope.workspaceId && Date.parse(route.leaseExpiresAt) > Date.now();
    },
    selectExecution: (args, candidates) => selections.cache(args, candidates),
    approvedOrigins: async () => approvedBrowserOrigins(await authority.refreshBrowserOrigins(identity.workspaceId)),
    groupName: async () => {
      const project = await authority.getProject();
      if (!project) throw new Error('Browser workspace project is unavailable');
      if (identity.workspaceId === project.id) return project.name;
      const workspace = (await authority.listWorkspaces()).find(item => item.id === identity.workspaceId);
      if (!workspace) throw new Error('Browser workspace is unavailable');
      return workspace.name;
    },
  });
  const active = new Map<string, AbortController>();
  const history = new RuntimeHistoryIndex(ctx.storage.sql);
  async function enabledSkills() {
    const skills = await env.USER_SKILLS.getByName(env.ACCOUNT_ID).list();
    const base = identity.workspaceId === baseWorkspaceId;
    return skills.filter(skill => {
      if (!skill.enabled || skill.exceptions.includes(identity.projectId)) return false;
      const assignment = skill.assignments.find(item => item.projectId === identity.projectId);
      return assignment ? (base ? assignment.projectSpaceEnabled : assignment.workspacesEnabled) : skill.scope === 'all' || skill.scope === (base ? 'project' : 'workspaces');
    });
  }
  // These are request envelopes, not a second lifecycle/job authority. The executor and
  // existing project ledgers remain the owners of effect outcomes and claim tokens.
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_host_dispatch (id TEXT PRIMARY KEY, dispatch TEXT NOT NULL)');
  const selections = createDispatchSelector({ storage: ctx.storage, env, identity, runtime: options.runtime });
  const savedDispatch = (attemptId: string) => {
    const row = ctx.storage.sql.exec<{ dispatch: string }>('SELECT dispatch FROM runtime_host_dispatch WHERE id=?', attemptId).toArray()[0];
    return row ? RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)) : null;
  };
  const selecting = new Map<string, { fingerprint: string; promise: Promise<RuntimeToolResult> }>();
  async function executeMachine(input: Invocation, deadlineAt?: string, selectedSnapshot?: { attachment: RuntimeAttachment; checkpoint: RuntimeGitCheckpoint }): Promise<RuntimeToolResult> {
    const fingerprint = canonicalJson({ requestId: input.requestId, conversationId: input.conversationId, taskId: input.taskId, tool: input.tool, args: input.args, replay: input.replay });
    const prior = selecting.get(input.attemptId);
    if (prior) return prior.fingerprint === fingerprint ? prior.promise : failed(input, new Error('Concurrent attempt identity changed'));
    const promise = executeMachineOnce(input, deadlineAt, selectedSnapshot);
    selecting.set(input.attemptId, { fingerprint, promise });
    try { return await promise; } finally { selecting.delete(input.attemptId); }
  }
  async function executeMachineOnce(input: Invocation, deadlineAt?: string, selectedSnapshot?: { attachment: RuntimeAttachment; checkpoint: RuntimeGitCheckpoint }): Promise<RuntimeToolResult> {
    const conversation = await options.runtime().browserConversation(input.conversationId);
    if (!conversation.root && !isSubagentToolCallAllowed(input.tool, input.args)) return failed(input, new Error('Subagent machine dispatch is read-only'));
    let dispatch = savedDispatch(input.attemptId);
    const fingerprint = canonicalJson({ requestId: input.requestId, conversationId: input.conversationId, taskId: input.taskId, tool: input.tool, args: input.args, replay: input.replay });
    let selection = selections.load(input.attemptId);
    if (selection && selection.fingerprint !== fingerprint) return failed(input, new Error('Attempt identity was reused for a different operation'));
    if (selection?.result) return RuntimeToolResultSchema.parse(selection.result);
    const controller = new AbortController();
    const deadline = selection?.deadline ?? dispatch?.deadlineAt ?? deadlineAt ?? new Date(Date.now() + 30 * 60_000).toISOString();
    selection ??= { fingerprint, deadline };
    selections.save(input.attemptId, selection);
    const settle = (result: RuntimeToolResult) => { selection!.result = result; selections.save(input.attemptId, selection!); return result; };
    const remaining = Date.parse(deadline) - Date.now();
    if (remaining <= 0) {
      if (dispatch) throw new Error('Admitted executor effect remains pending after deadline');
      return settle(interrupted(input, 'Execution deadline expired before dispatch.'));
    }
    const timeout = setTimeout(() => controller.abort(new Error('Execution deadline expired')), remaining);
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    active.set(input.attemptId, controller);
    try {
      if (!dispatch) {
        const runtime = options.runtime();
        if (!(await runtime.snapshot()).conversations.some(item => item.id === input.conversationId)) throw new Error('Conversation is not owned by this workspace');
        const selected = selectedSnapshot?.attachment ?? await selections.select(input, selection, controller.signal);
        if (!selected) throw new Error('No machine attached: the admitted execution cache is unavailable.');
        const snapshot = selectedSnapshot?.checkpoint ?? (selected.role === 'cache' ? await runtime.cloudFiles.initializeSnapshot() : undefined);
        if ((selected.role === 'cache') && !snapshot) throw new Error('Cloud working copy is unavailable');
        const tool = input.tool === 'checkpoint_code' ? 'checkpoint' : input.tool;
        dispatch = RuntimeToolDispatchSchema.parse({ version: 1, ...identity, conversationId: input.conversationId, conversationKind: conversation.root ? 'main' : 'subagent', taskId: input.taskId, machineId: selected.machineId, attachmentId: selected.attachmentId, generation: selected.generation, requestId: input.requestId, attemptId: input.attemptId, ...(snapshot ? { snapshot } : {}), tool, args: input.args, deadlineAt: deadline, replay: input.replay });
        ctx.storage.sql.exec('INSERT INTO runtime_host_dispatch(id,dispatch) VALUES(?,?)', input.attemptId, JSON.stringify(dispatch));
      } else if (dispatch.requestId !== input.requestId || dispatch.conversationId !== input.conversationId || dispatch.taskId !== input.taskId || dispatch.replay !== input.replay || dispatch.tool !== (input.tool === 'checkpoint_code' ? 'checkpoint' : input.tool) || canonicalJson(dispatch.args) !== canonicalJson(input.args)) {
        throw new Error('Attempt identity was reused for a different operation');
      }
      return settle(await options.runtime().attachments.execute(dispatch, controller.signal));
    } catch (error) {
      if (controller.signal.aborted) {
        const saved = savedDispatch(input.attemptId);
        if (saved) await controlAttempt(saved.attemptId, 'runtime_cancel').catch(() => null);
        if (saved) throw error;
        return settle(interrupted(input, 'Execution cancelled before dispatch.'));
      }
      if (error instanceof ExecutorNotConnected) {
        // The relay proved non-delivery and the store released the attempt: no effect remains to reconcile.
        ctx.storage.sql.exec('DELETE FROM runtime_host_dispatch WHERE id=?', input.attemptId);
        return settle(failed(input, error));
      }
      if (savedDispatch(input.attemptId)) throw error;
      return settle(failed(input, error));
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
      active.delete(input.attemptId);
    }
  }
  async function controlAttempt(attemptId: string, tool: 'runtime_cancel' | 'runtime_reconcile') {
    const original = savedDispatch(attemptId);
    if (!original) return null;
    return tool === 'runtime_cancel' ? options.runtime().attachments.cancel(original) : options.runtime().attachments.reconcile(original);
  }
  async function cancelLifecycle(dispatch: RuntimeToolDispatch) {
    const request = RuntimeAgentLifecycleRunArgumentsSchema.parse(dispatch.args);
    const result = await authority.mutateLifecycleState(identity.workspaceId, { op: 'cancel', runId: request.runId }, { machineId: dispatch.machineId, actorId: `task:${dispatch.attemptId}`, kind: 'client', lifecycleControl: false });
    if (result.status === 'error') throw new Error(result.failure.message);
  }
  async function awaitLifecycle(dispatch: RuntimeToolDispatch, signal?: AbortSignal): Promise<RuntimeToolResult> {
    const request = RuntimeAgentLifecycleRunArgumentsSchema.parse(dispatch.args);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    active.set(dispatch.attemptId, controller);
    try {
      for (;;) {
        const state = await authority.getLifecycleState(identity.workspaceId);
        const run = state.runs.find(item => item.id === request.runId);
        if (!run) return interrupted(dispatch, 'Lifecycle dispatch has no canonical admission receipt; effects will not be replayed.');
        if (run.phase !== request.phase || run.machineId !== dispatch.machineId || (run.attachment && (run.attachment.attachmentId !== dispatch.attachmentId || run.attachment.generation !== dispatch.generation))) throw new Error('Lifecycle receipt does not match its admitted execution identity');
        if (run.status === 'succeeded') return completed(dispatch, run);
        if (run.status === 'failed') return failed(dispatch, run.failure?.message ?? `Lifecycle exited with ${run.exitCode}`);
        if (run.status === 'cancelled' || run.status === 'timed-out' || run.status === 'interrupted') return interrupted(dispatch, run.failure?.message ?? `Lifecycle ${run.status}`);
        if (controller.signal.aborted || Date.now() >= Math.min(Date.parse(dispatch.deadlineAt), Date.parse(run.deadlineAt))) {
          await cancelLifecycle(dispatch);
          return interrupted(dispatch, 'Lifecycle cancellation requested; the canonical claim remains fenced until terminal execution evidence arrives.');
        }
        await new Promise<void>(resolve => {
          const stop = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, 1000);
          controller.signal.addEventListener('abort', stop, { once: true });
        });
      }
    } finally { signal?.removeEventListener('abort', abort); active.delete(dispatch.attemptId); }
  }
  async function environment(input: Invocation) {
    const args = RuntimeEnvironmentArgumentsSchema.parse(input.args);
    const method = args.method;
    if (method === 'get') {
      const checkpoint = await options.runtime().cloudFiles.initializeSnapshot();
      if (!checkpoint) throw new Error('Cloud working copy is unavailable');
      const lifecycle = await refreshCloudEnvironment({ code: new ArtifactsCodeStore(env.ARTIFACTS), authority, identity, checkpoint });
      lifecycle.values.global = await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).getEnvironmentValues();
      return completed(input, projectEnvironmentState(lifecycle));
    }
    if (method === 'runLog' || method === 'log') {
      const request = args;
      const state = await authority.getLifecycleState(identity.workspaceId);
      const run = state.runs.find(entry => entry.id === request.runId);
      if (!run) throw new Error('Run does not belong to this workspace');
      if (run.interactive) throw new Error('Protected interactive output is not agent-readable');
      return completed(input, await authority.getLifecycleRunLog(identity.workspaceId, request.runId, request.offset));
    }
    if (method === 'runPhase' || method === 'runChecks') {
      const { method: ignored, ...candidate } = args;
      const request = RuntimeAgentLifecycleRunArgumentsSchema.parse({ ...candidate, phase: args.method === 'runChecks' ? 'checks' : args.phase });
      return executeMachine({ ...input, tool: 'lifecycle', args: RuntimeJsonSchema.parse(request), replay: 'unsafe' }, request.deadlineAt);
    }
    if (method === 'setProfile' || method === 'putValue' || method === 'deleteValue' || method === 'cancelRun') {
      const mutation = LifecycleMutationSchema.parse(args.method === 'setProfile' ? { op: 'profile', profile: args.profile } : args.method === 'cancelRun' ? { op: 'cancel', runId: args.runId } : { op: 'value', scope: args.scope, name: args.name, value: args.method === 'deleteValue' ? null : args.value });
      if (mutation.op === 'value' && mutation.scope === 'global') throw new Error('Agent values are restricted to project/workspace scope');
      // A cloud actor has no machine claim and cannot approve, abandon or recover runs.
      const result = await authority.mutateLifecycleState(identity.workspaceId, mutation, { machineId: `cloud:${identity.workspaceId}`, actorId: `conversation:${input.conversationId}`, kind: 'client', lifecycleControl: false });
      if (result.status === 'error') throw new Error(result.failure.message);
      return completed(input, projectEnvironmentState(result.state));
    }
    throw new Error('Environment approval, recovery, secret access and protected I/O require human control');
  }
  async function invoke(input: Invocation): Promise<RuntimeToolResult> {
    try {
      const conversation = await options.runtime().browserConversation(input.conversationId);
      if (!conversation.root && !isSubagentToolCallAllowed(input.tool, input.args)) throw new Error('Subagent tools are read-only');
      input.signal?.throwIfAborted();
      if (input.tool === 'grep') {
        const args = RuntimeGrepArgumentsSchema.parse(input.args);
        if (args.on !== undefined || args.at !== undefined) return executeMachine(input);
        const runtime = options.runtime();
        if (!runtime.cloudFiles.hasAttempt(input.attemptId)) {
          const cacheResult = await runtime.cloudFiles.withCurrentSnapshot(async checkpoint => {
            const attachment = caughtUpSearchCache(runtime.attachments.list(), checkpoint);
            if (!attachment) return null;
            try {
              const result = await executeMachine({ ...input, replay: 'safe' }, undefined, { attachment, checkpoint });
              return result.status === 'completed' ? result : null;
            } catch {
              // Search has no effects. A disconnected or newly dirty cache
              // cannot prevent a search of the authoritative cloud snapshot.
              return null;
            }
          });
          if (cacheResult) return cacheResult;
        }
        return runtime.cloudFiles.execute({ ...input, tool: 'grep' }, input.signal);
      }
      if (input.tool === 'codemode') return codemode.execute(input);
      if (input.tool === 'browser') return browser.execute(input);
      if (input.tool === 'browser_control') throw new Error('Browser management requires human control');
      if (input.tool === 'mcp_discover' || input.tool === 'mcp_invoke') {
        const args = object.parse(input.args);
        if (typeof args.connectionId === 'string' && await mcp.isStdio(input.args)) return executeMachine(input);
        return completed(input, input.tool === 'mcp_discover' ? await mcp.discover(input.args, input.signal) : await mcp.invoke(input.args, input.signal));
      }
      if (input.tool === 'read') {
        const args = RuntimeReadArgumentsSchema.parse(input.args);
        if (typeof args.path === 'string' && /^(?:skill|rule):\/\//u.test(args.path)) {
          const uri = new URL(args.path);
          if (uri.protocol === 'skill:' && DEFAULT_SKILLS[uri.hostname] !== undefined) {
            if (!(await enabledSkills()).some(skill => skill.id === uri.hostname)) throw new Error('Skill is not enabled for this workspace');
            if (uri.pathname && uri.pathname !== '/') throw new Error('Bundled skill has no resource at that path');
            return completed(input, DEFAULT_SKILLS[uri.hostname]);
          }
          return completed(input, await options.instructionLoader.read(args.path));
        }
      }
      if (input.tool === 'machines') {
        const args = RuntimeMachinesArgumentsSchema.parse(input.args);
        if (args.op === 'detach') {
          const request = args;
          const attachment = options.runtime().attachments.list().find(item => item.attachmentId === request.attachmentId && item.generation === request.generation);
          if (!attachment) throw new Error('Attachment authority does not match cleanup request');
          return completed(input, options.runtime().attachments.detach({ ...attachment, state: 'draining' }));
        }
        if (args.op === 'setDefault') {
          await options.runtime().setExecutionMachine(args.machineId);
          return completed(input, { defaultMachineId: options.runtime().defaultExecutionMachine() });
        }
        return completed(input, options.runtime().attachments.list());
      }
      if (input.tool === 'agents' || input.tool === 'checkpoint' || input.tool === 'rewind') return options.runtime().invokeConversationTool(input);
      if (input.tool === 'environment') return environment(input);
      if (input.tool === 'generate_image') return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: await options.generateImage(input) };
      if (input.tool === 'report_issue') return completed(input, await appendRuntimeQa(env, identity, input.attemptId, RuntimeReportIssueArgumentsSchema.parse(input.args)));
      if (runtimeSpaceToolNames.includes(input.tool)) return completed(input, await invokeRuntimeSpaceTool(env, identity, input));
      if (input.tool === 'space_workspace') {
        const args = RuntimeWorkspaceArgumentsSchema.parse(input.args);
        switch (args.method) {
          case 'get': case 'current': return completed(input, identity.workspaceId === baseWorkspaceId ? await authority.getProject() : (await source()).workspace);
          case 'list': return completed(input, await authority.listWorkspaces());
          case 'operations': return completed(input, await authority.listOperations());
          default: return executeMachine({ ...input, tool: 'create', replay: 'unsafe' });
        }
      }
      if (input.tool === 'space_phase') return executeMachine({ ...input, tool: 'workspace_phase', replay: 'unsafe' });
      if (input.tool === 'space_artifacts') {
        const args = RuntimeSpaceArtifactsArgumentsSchema.parse(input.args);
        const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await source());
        switch (args.method) {
          case 'list': return completed(input, await artifacts.list());
          case 'listScopes': return completed(input, await authority.listArtifactScopes());
          case 'listPromotions': return completed(input, await authority.listArtifactPromotions());
          case 'read': return completed(input, await artifacts.read(args.url));
          case 'readCode': {
            const request = args;
            const blob = await new ArtifactsCodeStore(env.ARTIFACTS).readFile(artifactsWorkspaceRepository(identity.workspaceId), request.commit, request.path);
            if (!blob) throw new Error('File is absent at the requested commit');
            return completed(input, { ...request, content: await blob.text() });
          }
          default: throw new Error('Artifact sharing requires an explicit human action');
        }
      }
      if (input.tool === 'read' && typeof input.args === 'object' && input.args !== null && !Array.isArray(input.args) && typeof input.args.path === 'string' && input.args.path.startsWith('local://')) {
        return completed(input, await new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await source()).read(input.args.path));
      }
      if (input.tool === 'history_search' || input.tool === 'history_read') {
        const args = object.parse(input.args);
        if (input.tool === 'history_read') {
          const request = RuntimeHistoryReadArgumentsSchema.parse(args);
          const events = await options.runtime().transcript(request.conversationId);
          return completed(input, events.slice(request.offset, request.offset + request.limit));
        }
        const request = RuntimeHistorySearchArgumentsSchema.parse(args);
        const workspaceIds = request.scope === 'workspace' ? [identity.workspaceId]
          : [...new Set([identity.projectId, ...(await authority.listWorkspaces()).map(workspace => workspace.id)])];
        for (const workspaceId of workspaceIds) {
          const owned = RuntimeIdentitySchema.parse({ projectId: identity.projectId, workspaceId });
          const remote = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
          const snapshot = workspaceId === identity.workspaceId ? await options.runtime().snapshot() : RuntimeSnapshotSchema.parse(await (await remote.runtimeSnapshot(owned)).json());
          for (const conversation of snapshot.conversations) {
            const events = workspaceId === identity.workspaceId ? await options.runtime().transcript(conversation.id) : RuntimeTranscriptSchema.parse(await (await remote.runtimeTranscript({ ...owned, conversationId: conversation.id })).json());
            const documents: HistoryDocument[] = events.map(event => ({ workspaceId, conversationId: conversation.id, ordinal: event.ordinal, payload: event.payload, createdAt: event.createdAt }));
            history.index(documents);
          }
        }
        return completed(input, await history.search(request.query, workspaceIds, (state, questions) => options.judge(input.conversationId, state, questions)));
      }
      if (input.tool === 'web_search') {
        const query = RuntimeWebSearchArgumentsSchema.parse(input.args).query;
        const url = new URL('https://www.bing.com/search');
        url.searchParams.set('q', query); url.searchParams.set('format', 'rss');
        const response = await fetch(url, { signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Search service returned ${response.status}`);
        const xml = await response.text();
        const decode = (value: string) => value.replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");
        const results = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)].map(match => { const field = (name: string) => decode(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'u').exec(match[1]!)?.[1] ?? ''); return { title: field('title'), url: field('link'), snippet: field('description') }; });
        if (!xml.includes('<rss')) throw new Error('Search service did not return a result feed');
        return completed(input, { query, results });
      }
      if (input.tool === 'read' || input.tool === 'edit' || input.tool === 'write' || input.tool === 'apply_patch' || input.tool === 'find') {
        const runtime = options.runtime();
        const conversation = await runtime.browserConversation(input.conversationId);
        if (!conversation.root && input.tool !== 'read' && input.tool !== 'find') throw new Error('Only the main workspace conversation can mutate the cloud working copy');
        try { return await runtime.cloudFiles.execute({ ...input, tool: input.tool }, input.signal); }
        catch (error) {
          if (!CloudPublicationUncertain.is(error)) throw error;
          await options.schedule(Date.now() + 1_000);
          return interrupted(input, `Snapshot publication is awaiting durable recovery. Do not repeat the mutation as a new attempt. ${error.message}`);
        }
      }
      if (machineTools[input.tool]) return executeMachine(input);
      throw new Error(`Unknown workspace tool: ${input.tool}`);
    } catch (error) { if (savedDispatch(input.attemptId)) throw error; return failed(input, error); }
  }
  async function execute(input: Operation): Promise<RuntimeToolResult> {
    try {
      if (input.kind === 'CronSchedule') {
        const args = z.object({ cronId: idSchema }).parse(input.args);
        const crons = env.PROJECT_CRONS.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
        const receipt = await crons.runNow({ projectId: identity.projectId, cronId: args.cronId, requestId: input.attemptId });
        return completed(input, receipt);
      }
      const tool = { CreateWorkspace: 'create', Checkpoint: 'checkpoint_code', LifecycleRun: 'lifecycle', Job: 'bash', Service: 'service', Merge: 'merge' }[input.kind];
      if (input.kind === 'LifecycleRun') RuntimeAgentLifecycleRunArgumentsSchema.parse(input.args);
      const args = input.kind === 'CreateWorkspace' ? { ...object.parse(input.args), method: 'create' } : input.args;
      const result = await executeMachine({ ...input, args, tool }, input.deadlineAt);
      if (input.kind !== 'LifecycleRun' || result.status !== 'completed') return result;
      const dispatch = savedDispatch(input.attemptId);
      if (!dispatch) throw new Error('Lifecycle dispatch record is missing');
      return awaitLifecycle(dispatch, input.signal);
    } catch (error) { if (savedDispatch(input.attemptId)) throw error; return failed(input, error); }
  }
  async function controlProcess(input: Parameters<WorkspaceRuntimeOptions['operations']['observeProcess']>[0], replay: 'safe' | 'unsafe'): Promise<RuntimeToolResult> {
    const origin = savedDispatch(input.originAttemptId);
    if (!origin || origin.tool !== 'proc' || origin.conversationId !== input.conversationId || origin.projectId !== identity.projectId || origin.workspaceId !== identity.workspaceId) throw new Error('Process control has no admitted origin');
    const originArgs = RuntimeProcArgumentsSchema.parse(origin.args);
    const name = originArgs.op === 'start' ? originArgs.spec.name : originArgs.op === 'restart' ? originArgs.name : null;
    if (name === null || name !== object.parse(input.args).name) throw new Error('Process control identity changed');
    let admission = savedDispatch(input.attemptId);
    if (admission && (admission.tool !== 'proc' || admission.machineId !== origin.machineId || admission.projectId !== origin.projectId || admission.workspaceId !== origin.workspaceId || admission.parentAttemptId !== input.originAttemptId || admission.conversationId !== input.conversationId || admission.taskId !== input.taskId || admission.requestId !== input.requestId || admission.replay !== replay || canonicalJson(admission.args) !== canonicalJson(input.args))) throw new Error('Process control identity changed');
    const selected = options.runtime().attachments.list()
      .filter(attachment => attachment.machineId === origin.machineId && attachment.projectId === origin.projectId && attachment.workspaceId === origin.workspaceId && attachment.state === 'ready' && attachment.role === 'cache' && attachment.heartbeatAt !== null && Date.now() - Date.parse(attachment.heartbeatAt) <= 30_000)
      .sort((left, right) => right.generation - left.generation)[0];
    if (!selected) throw new Error('Original process machine is unreachable: no READY execution cache');
    if (!admission) {
      admission = RuntimeToolDispatchSchema.parse({ ...origin, attachmentId: selected.attachmentId, generation: selected.generation, parentAttemptId: input.originAttemptId, taskId: input.taskId, requestId: input.requestId, attemptId: input.attemptId, args: input.args, replay, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      ctx.storage.sql.exec('INSERT INTO runtime_host_dispatch(id,dispatch) VALUES(?,?)', input.attemptId, JSON.stringify(admission));
    }
    let dispatch = admission;
    if (admission.attachmentId !== selected.attachmentId || admission.generation !== selected.generation) {
      // Executor envelopes are immutable. Reattachment gets a distinct transport
      // attempt while the logical control and exact supervisor instance stay fixed.
      const attemptId = `${input.attemptId}:attachment:${encodeURIComponent(selected.attachmentId)}:${selected.generation}`;
      dispatch = savedDispatch(attemptId) ?? RuntimeToolDispatchSchema.parse({ ...admission, attemptId, attachmentId: selected.attachmentId, generation: selected.generation, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      ctx.storage.sql.exec('INSERT OR IGNORE INTO runtime_host_dispatch(id,dispatch) VALUES(?,?)', attemptId, JSON.stringify(dispatch));
    }
    return options.runtime().attachments.execute(dispatch, AbortSignal.timeout(30_000));
  }
  return {
    browser: browser.manage,
    tools: { invoke, prepareBrowser: browser.prepare, authorizeCronTool, async instructions(conversationId) {
      const project = await authority.getProject();
      if (!project) throw new Error('Project is not configured');
      const workspace = (await authority.listWorkspaces()).find(item => item.id === identity.workspaceId);
      if (!workspace && identity.workspaceId !== baseWorkspaceId) throw new Error('Workspace does not belong to this project');
      const main = (await options.runtime().browserConversation(conversationId)).root;
      if (!main) {
        const [committed, skills] = await Promise.all([options.instructionLoader.loadInstructions(), enabledSkills()]);
        return [committed, skills.map(skill => `- ${skill.id}: ${skill.description} (read skill://${skill.id})`).join('\n')].filter(Boolean).join('\n\n');
      }
      const owned = { projectId: identity.projectId, spaceId: identity.workspaceId };
      const context = env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, identity.projectId, identity.workspaceId]));
      await context.bootstrap(owned);
      const [committed, skills, goal, workflow, rubric] = await Promise.all([
        options.instructionLoader.loadInstructions(), enabledSkills(), context.getGoal(owned), context.getWorkflow(owned), context.getRubric(owned),
      ]);
      const skillSummary = skills.map(skill => `- ${skill.id}: ${skill.description} (read skill://${skill.id})`).join('\n');
      const canonical = `Current canonical workspace instructions. These replace prior Goal, Workflow, and Rubric instructions. Follow the latest requirements and gates; do not infer acceptance or waive human gates.\n${JSON.stringify({ goal, workflow, rubric })}`;
      return [`Workspace ${workspace?.name ?? project.name}; project ${project.name}; branch ${workspace?.branch ?? project.baseBranch}. Cloud reads remain available without a machine. Lifecycle approvals, secrets, protected interactive I/O and external QA sharing are human-only.`, committed, canonical, skillSummary ? `Enabled account skills:\n${skillSummary}` : ''].filter(Boolean).join('\n\n');
    } },
    operations: {
      execute,
      async jobScope(args) { await selections.cache(args); return identity; },
      async controlJob(input) {
        const dispatch = savedDispatch(input.attemptId);
        if (!dispatch || dispatch.tool !== 'bash') throw new Error('Background command has no admitted executor');
        if (input.op === 'cancel') return completed(dispatch, await options.runtime().attachments.cancel(dispatch));
        const id = `job-log:${dispatch.attemptId}:${crypto.randomUUID()}`;
        return options.runtime().attachments.execute({ ...dispatch, requestId: id, attemptId: id, args: { op: 'logs', attemptId: dispatch.attemptId, ...(input.lines !== undefined ? { lines: input.lines } : {}), ...(input.head !== undefined ? { head: input.head } : {}), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) }, deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'safe' }, AbortSignal.timeout(30_000));
      },
      observeProcess: input => controlProcess(input, 'safe'),
      stopProcess: input => controlProcess(input, 'unsafe'),
      async reconcile(attemptId) {
        const cloud = codemode.reconcile(attemptId);
        if (cloud) return cloud;
        const dispatch = savedDispatch(attemptId);
        if (!dispatch) return null;
        if (dispatch.tool === 'lifecycle') return awaitLifecycle(dispatch);
        return controlAttempt(attemptId, 'runtime_reconcile');
      },
      async cancel(attemptId) {
        codemode.cancel(attemptId);
        active.get(attemptId)?.abort(new Error('Cancelled'));
        const dispatch = savedDispatch(attemptId);
        if (dispatch?.tool === 'lifecycle') await cancelLifecycle(dispatch);
        await controlAttempt(attemptId, 'runtime_cancel');
      },
      wakeAt: options.schedule,
    },
    onReport(error) { options.ctx.waitUntil(appendRuntimeQa(env, identity, crypto.randomUUID(), { message: message(error) })); },
  };
}
