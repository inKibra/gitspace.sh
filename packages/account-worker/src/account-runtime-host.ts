import type { WorkspaceEnvironment } from './space-environment.js';
import { createDocumentMarkdown } from './document-markdown.js';
import { ArtifactsCodeStore, artifactsWorkspaceRepository, createWorkspaceRuntime, ExecutorNotConnected, type AttachmentServices, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import type { RuntimeAttachment, RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { forwardTunnelRequest } from './relay-request.js';
import { createRuntimeServices, createRuntimeQaServices, type RuntimeIdentity } from './runtime-services.js';
import { workspaceBrowsersDocument } from './runtime-browser.js';
import { createCloudRuntimeInference } from './runtime-inference.js';
import { z } from 'zod';
import { parseRuntimeSettings, type CloudProjectSummary } from '@gitspace/protocol';
import { createRuntimeRuleServices } from './runtime-instructions.js';
import { createRuntimeInstructionLoader } from './runtime-instruction-loader.js';
import { createLatestSender } from './latest-sender.js';
import type { WorkspaceStatusSend } from './project-authority.js';
import { createAccountGitLfsStore } from './git-lfs-store.js';
import { importedProjectRepository, setCloudWorkspacePhase } from './cloud-workspace-lifecycle.js';
import { readSourceCheckpoint, readWorkspaceMetadata, readWorkspaceReport, storeWorkspaceReport, storeWorkspaceStatus } from './workspace-metadata.js';
import { projectWatchHooks, reconcileProjectWatch } from './project-watch.js';
import { automationTurnHooks, reconcileAutomationTurns } from './automation-turns.js';
import { notifyMachines } from './machine-notices.js';
import { notifyBrowsers } from './live-notices.js';
import { noticeStackHead } from './stack-notices.js';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { originAccess, originReadCredentials } from './origin-access.js';
import { remoteDefaultBranch } from './cloud-project.js';
import { createRuntimeImages } from './runtime-images.js';
import { inferenceWorkerRunner } from './inference-runner.js';
import { journalMessageDecisions } from './message-decisions.js';
import { WORKER_VERSION } from './tenant-releases.js';

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

/** Repository identities and origins come only from canonical project metadata. The project repository's first import
 * runs as a project operation this waits on. */
export async function ensureRuntimeCodeRepository(env: Env, userId: string, identity: RuntimeIdentity) {
  if (userId !== env.ACCOUNT_ID) throw new Error('Repository lease belongs to a different account');
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${identity.projectId}`);
  const project = await authority.getProject();
  if (!project || project.id !== identity.projectId) throw new Error('Project is unavailable');
  if (identity.workspaceId !== project.id && !await authority.getWorkspace(identity.workspaceId)) throw new Error('Workspace is not owned by this project');
  await importedProjectRepository(env, project);
  return new ArtifactsCodeStore(env.ARTIFACTS).forkWorkspace(project.id, identity.workspaceId);
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
  // Diagnostic for idle wakes (2026-10-22): remove once diagnosed. Background work this slow keeps the object awake.
  const waitUntil = (label: string, promise: Promise<unknown>) => {
    const startedAt = Date.now();
    ctx.waitUntil(promise.finally(() => {
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 30_000) console.warn(JSON.stringify({ event: 'slow_wait_until', label, durationMs }));
    }));
  };
  const base = metadata().kind === 'base';
  // A project's base space has no phase; it is never plan-locked.
  const workspacePhase = base ? 'code' : metadata().phase ?? 'plan';
  // Conversations with live foreground work as the runtime opens: pi retries an interrupted generation, and a live tool's
  // completion starts the conversation's next one, both before any hook binds its model. pi's `tasks` table exists from
  // the workspace's first open on.
  const tasksTable = ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").toArray().length > 0;
  const retrying = tasksTable ? ctx.storage.sql.exec<{ conversation_id: number }>("SELECT DISTINCT conversation_id FROM tasks WHERE status != 'terminal' AND background = 0").toArray().map(row => String(row.conversation_id)) : [];
  const images = await createRuntimeImages(env, identity.workspaceId);
  const inference = await createCloudRuntimeInference(ctx, env, identity, retrying, inferenceWorkerRunner(ctx, env, identity.workspaceId));
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
  const code = new ArtifactsCodeStore(env.ARTIFACTS, ctx.storage);
  const repository = artifactsWorkspaceRepository(identity.workspaceId);
  const ref = runtimeWorkspaceCodeRef(env, identity, () => metadata().branch);
  // Logged and told once per change of state: repeated failures while degraded only count up.
  const instructionLoader = createRuntimeInstructionLoader({ code, repository, ref, onState(change) {
    console.warn(JSON.stringify({ event: change.state === 'degraded' ? 'instructions_degraded' : 'instructions_recovered', workspaceId: identity.workspaceId, ...change }));
    if (!change.notify || !runtime) return;
    const text = change.state === 'degraded'
      ? `This workspace's instructions could not be refreshed from its repository (${change.failure}). The agent uses the copy loaded at ${new Date(change.loadedAt).toISOString().slice(11, 16)} UTC until they can be read again.`
      : 'This workspace\'s instructions are current again.';
    waitUntil('instructions notice', runtime.notice(text, undefined, 'Repository').catch((error: unknown) => console.error('Instructions notice was not added', { workspaceId: identity.workspaceId, error })));
  } });
  let runtime: WorkspaceRuntime | undefined;
  const documentMarkdown = createDocumentMarkdown(ctx.storage, env.AI);
  const services = createRuntimeServices({ ctx, env, identity, schedule, requestAttachment, environment, documentMarkdown, images: { store: images.store, load: images.load }, generateImage: inference.generateImage, model: inference.modelHelper, webSearch: inference.webSearch, judge, instructionLoader, runtime() {
    if (!runtime) throw new Error('Runtime services were invoked before the Harness opened');
    return runtime;
  } });
  const lfs = await createAccountGitLfsStore(env, env.ACCOUNT_ID, identity.projectId, `runtime:${identity.workspaceId}`);
  const qa = createRuntimeQaServices(env, identity);
  const watch = projectWatchHooks(ctx.storage, identity, (report, onDone) => waitUntil('project report', env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`).runtimeWorkspaceReport({ projectId: identity.projectId, workspaceId: identity.projectId }, report, onDone).catch((error: unknown) => console.error('Workspace report was not sent', { workspaceId: identity.workspaceId, error }))));
  const automationTurns = automationTurnHooks(ctx.storage, identity, report => env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`).runTurnChanged(report), waitUntil);
  // The account's copy of this workspace's status: the sidebar's and the project agent's board. A send that fails stays
  // owed (retried, and sent again by every publication until one arrives); before, a failed send left the account on the
  // previous state, since this object's own copy already held the new one. The first publication of an instance is sent
  // whatever its copy says: a send lost before it (cut off by a reset or a restart) left the account behind.
  const status = createLatestSender<WorkspaceStatusSend>(payload => {
    const sent = env.USER_PROJECTS.getByName(env.ACCOUNT_ID).setWorkspaceStatus(payload);
    waitUntil('workspace status', sent.catch(() => {}));
    return sent;
  }, error => console.error('Workspace status was not sent', { workspaceId: identity.workspaceId, error }));
  runtime = await createWorkspaceRuntime({
    ...inference,
    workspacePhase,
    async setWorkspacePhase(phase) { await setCloudWorkspacePhase(env, env.ACCOUNT_ID, identity, phase); },
    /** A plan's approval or rejection becomes a `decision` entry of the workspace journal, recorded by the person's device. */
    async recordDecision(decision) {
      const owned = { projectId: identity.projectId, spaceId: identity.workspaceId };
      try {
        const entry = await env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, owned.projectId, owned.spaceId])).appendJournalEntry({
          ...owned, id: `plan-decision:${crypto.randomUUID()}`, kind: 'decision', phase: 'plan', title: decision.title, body: decision.body,
          outcome: null, decisions: decision.decisions, evidence: [], createdBy: decision.deviceId,
        });
        await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`).appendEvent({ scope: 'workspace', entity: 'journal', entityId: entry.id, revision: entry.sequence, operation: 'append', payload: { spaceId: owned.spaceId } });
      } catch (error) { console.error('Plan decision was not journaled', { workspaceId: identity.workspaceId, conversationId: decision.conversationId, error }); }
    },
    /** The decisions a person sent with a message are journaled in the workspace's phase (a base space's: `project`); a
     * failure throws, and the runtime retries the message. */
    async recordMessageDecisions(sent) {
      const current = metadata();
      await journalMessageDecisions(env, identity, current.kind === 'base' ? 'project' : current.phase ?? 'plan', sent);
    },
    published: (snapshot, report) => {
      const summary = report.summary;
      // Sent when the status or what the board shows changed, or while an earlier send is still owed. Sends run in the
      // background and can arrive out of order (a turn's last message, then its end, a moment apart), so each carries the
      // snapshot's cursor and the account keeps the newest.
      const previous = readWorkspaceReport(ctx.storage);
      const reportChanged = JSON.stringify(previous?.waitingOn ?? null) !== JSON.stringify(report.waitingOn) || (previous?.lastReply ?? null) !== report.lastReply || JSON.stringify(previous?.lastReplySource ?? null) !== JSON.stringify(report.lastReplySource);
      const statusChanged = storeWorkspaceStatus(ctx.storage, summary);
      if (statusChanged || reportChanged || status.owed()) {
        status.send({ ...identity, status: summary, waitingOn: report.waitingOn, lastReply: report.lastReply, lastReplySource: report.lastReplySource, cursor: snapshot.cursor });
      }
      storeWorkspaceReport(ctx.storage, report);
      watch.published(report);
      automationTurns.published(report);
      waitUntil('browser notice', notifyBrowsers(env, [{ ...workspaceLiveKey(identity.workspaceId, 'runtime', identity.projectId), version: snapshot.cursor }]));
    },
    turnChanged: (requestId, turn) => { watch.turnChanged(requestId, turn); automationTurns.turnChanged(requestId, turn); },
    personPrompted: watch.personPrompted,
    snapshotChanged: machineIds => {
      waitUntil('machine snapshot notice', notifyMachines(env, machineIds, ['workspace.snapshot'], identity.workspaceId));
      // The environment is derived from the workspace's files: derive it when they change, not when it is read.
      waitUntil('environment derivation', environment.currentLifecycleState(identity).catch((error: unknown) => console.error('Environment was not derived', { workspaceId: identity.workspaceId, error })));
      // A new head of this branch can move what is stacked on it; its agents are told without waking.
      waitUntil('stack notices', noticeStackHead(ctx.storage, env, identity).catch((error: unknown) => console.error('Stack notices were not sent', { workspaceId: identity.workspaceId, error })));
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
    imageUrl: images.url,
    initialCheckpoint: async () => {
      const branchRef = await ref();
      return code.initialCheckpoint(repository, identity.workspaceId, branchRef.slice('refs/heads/'.length), readSourceCheckpoint(ctx.storage));
    },
    settings,
    retainedRules: createRuntimeRuleServices({ code, repository, ref }),
    ...services,
    browser: services.browser,
    storage: ctx.storage,
    identity,
    version: WORKER_VERSION,
    waitUntil: promise => waitUntil('runtime', promise),
    schedule,
    qa,
    browsers: () => workspaceBrowsersDocument(ctx.storage),
    onReport: error => { waitUntil('qa report', qa.report(error instanceof Error ? error.message : String(error))); },
    attachments: {
      seal: (secret, scope) => env.CREDENTIALS.getByName(env.ACCOUNT_ID).sealRuntimeGrant(secret, scope),
      open: (ciphertext, scope) => env.CREDENTIALS.getByName(env.ACCOUNT_ID).openRuntimeGrant(ciphertext, scope),
      dispatch: input => dispatchRuntimeAttachment(env, input),
    },
  });
  waitUntil('wake', runtime.wake());
  waitUntil('project watch', reconcileProjectWatch(ctx.storage, runtime, watch).catch((error: unknown) => console.error('Project watch was not reconciled', { workspaceId: identity.workspaceId, error })));
  waitUntil('automation turns', reconcileAutomationTurns(ctx.storage, runtime, automationTurns).catch((error: unknown) => console.error('Automation turns were not reconciled', { workspaceId: identity.workspaceId, error })));
  return runtime;
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
