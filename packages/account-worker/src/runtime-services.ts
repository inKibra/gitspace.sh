import { z } from 'zod';
import { canonicalJson, RuntimeDispatchSelectionSchema, RuntimeIdentitySchema, RuntimeJsonSchema, RuntimeSnapshotSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema, type RuntimeAttachment, type RuntimeSnapshot, type RuntimeToolResult, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { LifecycleMutationSchema, approvedBrowserSites, projectEnvironmentState, type LifecycleRun } from '@gitspace/protocol-environment';
import type { WorkspaceEnvironment } from './space-environment.js';
import type { DocumentMarkdown } from './document-markdown.js';
import { GITSPACE_SOURCE_REPOSITORY } from '@gitspace/protocol/project-authority';
import { RuntimeQaItemSchema, type RuntimeQaActionInput, type RuntimeQaItem } from '@gitspace/protocol-runtime/workspace-controls';
import { ArtifactsCodeStore, artifactsWorkspaceRepository, textPage, snapshotEntries, hasSnapshotConflictMarkers, readSnapshotText, resolveSnapshotConflictText, CloudPublicationUncertain, isAttachmentOnline, isAttachmentReady, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { RuntimeAgentLifecycleRunArgumentsSchema, RuntimeLifecycleDispatchArgumentsSchema, RuntimeEnvironmentArgumentsSchema, RuntimeMachinesArgumentsSchema, RuntimeSpaceArtifactsArgumentsSchema, RuntimeDriveTransferStoredSchema, RuntimeSpacePhaseArgumentsSchema, RuntimeReadArgumentsSchema, RuntimeWriteArgumentsSchema, RuntimeEditArgumentsSchema, RuntimeReportIssueArgumentsSchema, RuntimeHistoryReadArgumentsSchema, RuntimeHistorySearchArgumentsSchema, RuntimeWebSearchArgumentsSchema } from '@gitspace/protocol-runtime';
import { isSubagentToolCallAllowed, runtimeOperationIsReadOnly, RuntimeSyncArgumentsSchema, RuntimeSyncMachineArgumentsSchema, RuntimeSyncMachineCaptureSchema, RuntimeSyncMachineDiffSchema, RuntimeSyncMachineDiscardSchema, RuntimeSyncMachineRestoreSchema, RuntimeSyncMachineStatusSchema } from '@gitspace/protocol-runtime';
import { RuntimeWorkspaceArgumentsSchema } from '@gitspace/protocol/inspector-contract';
import { confirmMachinePresence } from './machine-notices.js';
import { readInspectorContext, InspectorCloudArtifacts } from './account-inspector-data.js';
import { workspaceDrive } from './workspace-drive.js';
import { createCloudRuntimeMcp } from './runtime-mcp.js';
import { DEFAULT_SKILLS } from '@gitspace/protocol/default-skills';
import { parseResourceUri, resourceMediaType, selectResourceText } from '@gitspace/protocol/resource-uri';
import { searchHistory, type RuntimeTranscriptRange } from '@gitspace/runtime-core/history';
import { readRuntimeTranscript, readRuntimeHistory } from './runtime-transcript-reader.js';
import type { RetainedRuleServices } from '@gitspace/runtime-core/retained-rules';
import type { RuntimeInstructionLoader } from './runtime-instruction-loader.js';
import { createDispatchSelector } from './runtime-dispatch-selection.js';
import { invokeRuntimeSpaceTool, runtimeSpaceToolNames } from './runtime-space-tools.js';
import { createRuntimeBrowserAuthority, type RuntimeBrowserAuthority } from './runtime-browser.js';
import { announceComment } from './browser-comments.js';
import { browserShareAccount } from './browser-share.js';
import { notifyBrowsers } from './live-notices.js';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { servicesBlock } from './workspace-service-urls.js';
import { createCloudCodemode } from './runtime-codemode.js';
import type { RuntimeModelHelper } from './runtime-inference.js';
import { RuntimeProcArgumentsSchema, RuntimeCodeSearchArgumentsSchema } from '@gitspace/protocol-runtime';
import { fetchInternalService, isHostedServiceHostname } from './service-access.js';
import { changeAgentWorkspace, setCloudWorkspacePhase } from './cloud-workspace-lifecycle.js';
import { executorCapabilities } from './runtime-attachments.js';
import { compareCloudHistory, readCloudBaseTip } from './cloud-stack-status.js';
import type { FleetMachineDefinition } from './fleet-catalog.js';
import { QuestionsDoc } from '@gitspace/runtime-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

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
  /** Requests a workspace attachment of the machine through the human cache-request path; returns before setup. */
  requestAttachment(machineId: string): Promise<{ attachment: RuntimeAttachment }>;
  /** The workspace object's own environment, called in-process. */
  environment: WorkspaceEnvironment;
  documentMarkdown: DocumentMarkdown;
};
/** What `machines attach` did: requested (or found) an attachment, or asked the user to approve one. */
type MachineAttachOutcome =
  | { state: 'attaching' | 'ready'; machineId: string; label: string; attachmentId: string; generation: number }
  | { state: 'awaiting-approval'; machineId: string; label: string; questionId: string };
const object = z.record(z.string(), RuntimeJsonSchema);
const methodSchema = z.object({ method: z.string().min(1) });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const completed = (input: Pick<Invocation, 'requestId' | 'attemptId'>, value: unknown): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: JSON.stringify(value) }] });
const interrupted = (input: Pick<Invocation, 'requestId' | 'attemptId'>, text: string): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'interrupted', content: [{ type: 'text', text }] });
const failed = (input: Pick<Invocation, 'requestId' | 'attemptId'>, error: unknown): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'failed', content: [{ type: 'text', text: message(error) }], error: { code: 'HOST_OPERATION_FAILED', message: message(error) } });
/** A cloud artifact as tool content: raster images as images, documents as pages of Markdown, text as pages of text
 * (after any line selector in the URL), anything else as its metadata. */
async function artifactContent(input: Pick<Invocation, 'requestId' | 'attemptId'>, url: string, artifact: { bytes: Uint8Array<ArrayBuffer>; mediaType: string | null }, documentMarkdown: DocumentMarkdown, range: { offset?: number; limit?: number } = {}): Promise<RuntimeToolResult> {
  const { bytes, mediaType } = artifact;
  const page = (text: string): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: textPage(text, range.offset, range.limit) }] });
  if (mediaType?.startsWith('image/') && mediaType !== 'image/svg+xml') return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'image', mimeType: mediaType, data: Buffer.from(bytes).toString('base64') }] };
  const resource = parseResourceUri(url);
  const document = await documentMarkdown(decodeURIComponent(resource?.kind === 'drive' ? resource.path.split('/').at(-1) ?? url : url), bytes);
  if (document !== null) return page(document);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return completed(input, { url, mediaType, size: bytes.byteLength }); }
  return page(resource ? selectResourceText(text, resource.selector) : text);
}
const machineTools: Record<string, true | undefined> = { bash: true, ast_grep: true, ast_edit: true, ast_resolve: true, proc: true, lifecycle: true, checkpoint_code: true, merge: true, delegate_export: true };
machineTools.browser = true;
/** Exact search is ripgrep on a machine checkout; the cloud answers code_search from its index instead. */
const GREP_REQUIRES_MACHINE = 'grep runs on an attached machine; use code_search, or attach a machine';

/** QA is written to the existing project event authority; nothing is sent externally. */
export async function appendRuntimeQa(env: Env, identity: RuntimeIdentity, id: string, report: z.infer<typeof RuntimeReportIssueArgumentsSchema>) {
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const item = RuntimeQaItemSchema.parse({ id, title: report.message.split('\n')[0]!.slice(0, 160), description: report.message, historyRef: report.reference ?? `history://${identity.workspaceId}`, tool: report.tool ?? null, model: report.model ?? 'unattributed', runtimeVersion: 'pi-1.0', state: 'open', duplicateOf: null, createdAt: new Date().toISOString() });
  const event = projectEventSchema.parse(await (await authority.appendEvent({ eventId: `qa:${id}`, scope: 'workspace', entity: 'qa', entityId: id, revision: 1, operation: 'created', payload: { item, workspaceId: identity.workspaceId } })).json());
  return RuntimeQaItemSchema.parse(event.payload.item);
}
/** QA events read per page; the project authority caps every entity page at this size. */
const QA_EVENT_PAGE = 500;
const QaEventPayloadSchema = z.object({ item: RuntimeQaItemSchema, workspaceId: z.string().optional() });
/** A workspace's QA inbox: the items its own runtime and agents reported. */
export function createRuntimeQaServices(env: Env, identity: RuntimeIdentity) {
  // A stub per call: one that saw an error, such as the project object resetting for a release, stays broken.
  const authority = () => env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  // QA items are loaded from the project once per runtime; snapshot rebuilds reuse them instead of calling the
  // project object each time.
  const items = new Map<string, z.infer<typeof RuntimeQaItemSchema>>();
  /** Automatic reports being written, so two failures at once still file one item. */
  const reporting = new Set<string>();
  let applied = 0;
  let reading: Promise<void> | undefined;
  function list(): Promise<z.infer<typeof RuntimeQaItemSchema>[]> {
    if (reading) return reading.then(() => [...items.values()]);
    reading = (async () => {
      for (;;) {
        const events = z.array(projectEventSchema).parse(await authority().listEntityEvents('qa', applied, QA_EVENT_PAGE));
        for (const event of events) {
          applied = Math.max(applied, event.offset);
          if (event.entity !== 'qa') continue;
          const payload = QaEventPayloadSchema.parse(event.payload);
          if (payload.workspaceId === identity.workspaceId) items.set(payload.item.id, payload.item);
        }
        if (events.length < QA_EVENT_PAGE) break;
      }
      // Automatic reports used to file one item per occurrence (a process watch, every 5 s, while its machine was
      // offline): open copies of an earlier open item are merged into it, once.
      const canonical = new Map<string, string>();
      const merged: z.infer<typeof RuntimeQaItemSchema>[] = [];
      for (const item of items.values()) {
        if (item.state !== 'open') continue;
        const key = `${item.historyRef}\n${item.title}`;
        const first = canonical.get(key);
        if (first === undefined) canonical.set(key, item.id);
        else merged.push({ ...item, state: 'merged', duplicateOf: first });
      }
      if (!merged.length) return;
      await authority().appendEvents(merged.map(item => ({ scope: 'workspace', entity: 'qa', entityId: item.id, revision: 1, operation: 'updated', payload: { item, workspaceId: identity.workspaceId } })));
      for (const item of merged) items.set(item.id, item);
    })().catch(error => { reading = undefined; throw error; });
    return reading.then(() => [...items.values()]);
  }
  return {
    list,
    /** A runtime failure becomes a QA item unless the same failure is already open. */
    async report(message: string): Promise<void> {
      const title = message.split('\n')[0]!.slice(0, 160);
      const historyRef = `history://${identity.workspaceId}`;
      if (reporting.has(title) || (await list()).some(item => item.state === 'open' && item.title === title && item.historyRef === historyRef)) return;
      reporting.add(title);
      try { const item = await appendRuntimeQa(env, identity, crypto.randomUUID(), { message }); items.set(item.id, item); }
      finally { reporting.delete(title); }
    },
    async act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }> {
      const current = await list();
      const item = current.find(candidate => candidate.id === input.itemId);
      if (!item) throw new Error('QA item does not belong to this workspace');
      const { action } = input;
      if (action.kind === 'share') {
        const reference = action.target === 'gitspace' ? GITSPACE_SOURCE_REPOSITORY : (await authority().getProject())?.repositoryReference;
        if (!reference) throw new Error('Project has no canonical repository');
        const repository = new URL(reference.replace(/^git@github\.com:/u, 'https://github.com/').replace(/\.git$/u, ''));
        if (repository.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+\/?$/u.test(repository.pathname)) throw new Error('Issue drafts require a canonical GitHub repository');
        const url = new URL(`${repository.pathname.replace(/\/$/u, '')}/issues/new`, 'https://github.com');
        url.searchParams.set('title', item.title);
        url.searchParams.set('body', action.redactedExcerpt);
        // A draft is not a delivery receipt. Keep the local item open until an
        // authorized integration can prove that an external issue was created.
        return { shareDraft: url.toString() };
      }
      let next: RuntimeQaItem;
      switch (action.kind) {
        case 'dismiss': next = { ...item, state: 'dismissed', duplicateOf: null }; break;
        case 'merge': {
          const target = current.find(candidate => candidate.id === action.targetId);
          if (!target || target.id === item.id || target.state === 'merged') throw new Error('Duplicate target must be a distinct canonical QA item');
          next = { ...item, state: 'merged', duplicateOf: target.id };
          break;
        }
        case 'fixed': next = { ...item, state: 'fixed', duplicateOf: null, fixedIn: action.commit }; break;
        case 'file': {
          if (item.state === 'merged') throw new Error('File the issue this one was merged into instead');
          // The account copy is written first and keyed by the item, so a retry after a failed event rewrites it.
          const filed = await env.ACCOUNT_STATE.getByName('account').fileIssue({ id: item.id, projectId: identity.projectId, workspaceId: identity.workspaceId, title: item.title, excerpt: action.excerpt, tool: item.tool, model: item.model, historyRef: item.historyRef, createdAt: item.createdAt, filedAt: new Date().toISOString(), filedBy: actor.deviceId });
          next = { ...item, filedAt: filed.filedAt };
          break;
        }
      }
      await authority().appendEvent({ scope: 'workspace', entity: 'qa', entityId: item.id, revision: 1, operation: 'updated', payload: { item: next, workspaceId: identity.workspaceId, actorId: actor.deviceId } });
      // Snapshots read the loaded items, not the project, so the change shows without a new runtime.
      items.set(item.id, next);
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
  if (['read', 'write', 'edit', 'grep', 'code_search', 'find', 'ast_grep'].includes(input.tool)) {
    const path = z.string().min(1).parse(args.path ?? (input.tool === 'find' || input.tool === 'grep' || input.tool === 'code_search' ? '.' : undefined));
    if (path.startsWith('drive://')) {
      const uri = new URL(path);
      const segments = decodeURIComponent(uri.pathname).split('/').filter(Boolean);
      if (!['base', 'workspace'].includes(uri.hostname) || segments.some(segment => segment === '..' || segment === '.')) throw new Error('Cron resource escapes its artifact scope');
      resource = `drive://${uri.hostname}/${segments.join('/')}`;
    } else {
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => segment === '..')) throw new Error('Cron repository paths must stay relative to their checkout');
      resource = `repository/${path.split('/').filter(segment => segment && segment !== '.').join('/')}`;
    }
    write = input.tool === 'write' || input.tool === 'edit';
  } else if (input.tool === 'space_artifacts' && args.method === 'read') {
    const uri = new URL(z.string().url().parse(args.url));
    const segments = decodeURIComponent(uri.pathname).split('/').filter(Boolean);
    if (uri.protocol !== 'drive:' || !['base', 'workspace'].includes(uri.hostname) || segments.some(segment => segment === '..' || segment === '.')) throw new Error('Cron resource escapes its artifact scope');
    resource = `drive://${uri.hostname}/${segments.join('/')}`;
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

/** First in every main agent's instructions. Models follow written rules literally, so nothing GitSpace or a repository
 * says may read as a reason to refuse the user; GitSpace's real limits are enforced by its tools, not by prompt text. */
const USER_PRECEDENCE = 'You work for the user. Their explicit instructions in this conversation come first: they override GitSpace guidance, skills, repository rules and tool descriptions. GitSpace enforces its own limits inside its tools, so no written rule is a reason to refuse the user. When a tool declines something, say which tool and why in one line, then do what the user asked with the other tools you have, for example bash on an attached machine.';
/** How a main agent points the user at files: the chat turns drive addresses into links and shows embedded media. */
const SHOWING_FILES = 'Showing files: refer to a file in the drive by its address, drive://workspace/<path> for this workspace or drive://base/<path> for the project. The bare address, the address in backticks, or a [label](drive://…) link opens it in the Inspector, and hovering a link to an image previews it. To show an image, video or audio file in your reply, embed it: ![short description](drive://workspace/<path>); a video shows as a poster the user clicks to play, audio as a player, other files as a card with a download. Only files in the drive open: write the file there (write, or space_artifacts to move it from the attached machine) before linking it. A repository file is repo://<path> as it is now, or repo://<path>@<full commit hash> as it was at that commit; an embedded image pinned to a commit shows beside its current version, which suits before-and-after screenshots.';

export function createRuntimeServices(options: ServicesOptions): Pick<WorkspaceRuntimeOptions, 'tools' | 'operations'> & { browser: RuntimeBrowserAuthority['manage'] } {
  const { ctx, env, identity } = options;
  const baseWorkspaceId: string = identity.projectId;
  const mcp = createCloudRuntimeMcp(env, identity);
  const codemode = createCloudCodemode({ loader: env.CODEMODE_LOADER, storage: ctx.storage, model: options.model });
  // A stub per call: one that saw an error, such as the project object resetting for a release, stays broken.
  const authority = () => env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const source = () => readInspectorContext(env, env.ACCOUNT_ID, identity.workspaceId, identity.projectId);
  const browser = createRuntimeBrowserAuthority({
    storage: ctx.storage, env, identity, runtime: options.runtime,
    selectExecution: (args, candidates) => selections.cache(args, candidates),
    services: () => authority().workspaceServices(identity.workspaceId),
    approvedSites: async () => {
      const { state, commit } = await options.environment.refreshBrowserOrigins(identity);
      return { sites: approvedBrowserSites(state), revision: commit };
    },
    groupName: async () => {
      const project = await authority().getProject();
      if (!project) throw new Error('Browser workspace project is unavailable');
      if (identity.workspaceId === project.id) return project.name;
      const workspace = await authority().getWorkspace(identity.workspaceId);
      if (!workspace) throw new Error('Browser workspace is unavailable');
      return workspace.name;
    },
    drive: () => workspaceDrive(env, identity),
    // The machine stores the file itself (drive_transfer); the drive then names it, as space_artifacts fromMachine does.
    fromMachine: async ({ conversationId, machineId, machinePath, path, mediaType }) => {
      const drive = workspaceDrive(env, identity), target = await drive.machineTarget(path), id = crypto.randomUUID();
      const result = await executeMachine({ tool: 'drive_transfer', args: RuntimeJsonSchema.parse({ direction: 'fromMachine', path: machinePath, scopeId: target.scopeId, on: machineId }), conversationId, taskId: id, requestId: id, attemptId: id, replay: 'unsafe' });
      if (result.status === 'failed') throw new Error(result.error.message);
      const text = result.content.find(item => item.type === 'text');
      if (result.status !== 'completed' || text?.type !== 'text') throw new Error('The machine did not report the file it stored');
      await drive.record(target.path, mediaType, RuntimeDriveTransferStoredSchema.parse(JSON.parse(text.text)));
    },
    // Comments the agent or you make here: tabs showing the Browser tab, the main conversation (a person's comment) and
    // the relay (the thread's share viewers and the workspace's Chromes) hear of each.
    comments: {
      ownerName: () => browserShareAccount(env).name(),
      announce: written => announceComment({
        live: () => { ctx.waitUntil(notifyBrowsers(env, [{ ...workspaceLiveKey(identity.workspaceId, 'page-comments', identity.projectId), version: Date.now() }])); },
        event: event => options.runtime().browserEvent(event),
        relay: thread => env.RELAY.getByName(env.RELAY_NAME).browserRelayCommentChanged(identity, thread),
      }, written),
    },
    // A capture's skill (`captureSaved`) is saved at the cloud working copy's commit, where the agent's file tools wrote it.
    skillCommit: async file => {
      const cloud = await options.runtime().cloudFiles.initializeSnapshot();
      if (!cloud) throw new Error('Cloud working copy is unavailable');
      return await new ArtifactsCodeStore(env.ARTIFACTS).readFile(artifactsWorkspaceRepository(identity.workspaceId), cloud.worktreeCommit, file) ? cloud.worktreeCommit : null;
    },
  });
  const active = new Map<string, AbortController>();
  // Reclaim the retired history search copy; history tools read Pi entries directly.
  ctx.storage.sql.exec('DROP TABLE IF EXISTS gitspace_history_fragments');
  ctx.storage.sql.exec('DROP TABLE IF EXISTS gitspace_history_payload_parts');
  ctx.storage.sql.exec('DROP TABLE IF EXISTS gitspace_history_events');
  ctx.storage.sql.exec('DROP TABLE IF EXISTS gitspace_history_fts');
  ctx.storage.sql.exec('DROP TABLE IF EXISTS gitspace_history_indexed');
  async function enabledSkills() {
    const skills = await env.USER_SKILLS.getByName(env.ACCOUNT_ID).list();
    const base = identity.workspaceId === baseWorkspaceId;
    return skills.filter(skill => {
      if (!skill.enabled || skill.exceptions.includes(identity.projectId)) return false;
      const assignment = skill.assignments.find(item => item.projectId === identity.projectId);
      return assignment ? (base ? assignment.projectSpaceEnabled : assignment.workspacesEnabled) : skill.scope === 'all' || skill.scope === (base ? 'project' : 'workspaces');
    });
  }
  // These are request envelopes, not a second lifecycle/job authority(). The executor and
  // existing project ledgers remain the owners of effect outcomes and claim tokens.
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_host_dispatch (id TEXT PRIMARY KEY, dispatch TEXT NOT NULL)');
  // Process observations are reads and are no longer kept; the ones stored before (one per 5-second poll) go once.
  ctx.storage.sql.exec("DELETE FROM runtime_host_dispatch WHERE id LIKE 'process-observation:%' OR id LIKE 'process-stop-observation:%'");
  const selections = createDispatchSelector({ storage: ctx.storage, env, identity, runtime: options.runtime, environment: options.environment });
  const savedDispatch = (attemptId: string) => {
    const row = ctx.storage.sql.exec<{ dispatch: string }>('SELECT dispatch FROM runtime_host_dispatch WHERE id=?', attemptId).toArray()[0];
    return row ? RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)) : null;
  };
  /** Replays follow the admitted dispatch; a new grep needs a ready machine. */
  function requireGrepMachine(attemptId: string): void {
    if (savedDispatch(attemptId) || selections.load(attemptId)) return;
    if (!options.runtime().attachments.list().some(item => isAttachmentReady(item))) throw new Error(GREP_REQUIRES_MACHINE);
  }
  /** The named machine; else the account default machine when online and permitted; else any online permitted machine
   * offering `needs`. Its attachment is requested without waiting for setup, and the conversation hears when it is
   * ready. A machine agents may not attach becomes a question to the user instead. */
  async function attachMachine(conversationId: string, request: { machine?: string; needs?: readonly string[] }): Promise<MachineAttachOutcome> {
    const runtime = options.runtime();
    const attachments = runtime.attachments.list();
    const fleet = (await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).listMachines()).filter(machine => machine.desiredState !== 'removed');
    // A machine never attached here offers what every executor offers.
    const offers = (machineId: string) => {
      const known = attachments.filter(item => item.machineId === machineId).sort((left, right) => right.generation - left.generation)[0];
      return (request.needs ?? []).every(need => (known?.capabilities ?? executorCapabilities).includes(need));
    };
    let chosen: FleetMachineDefinition | undefined;
    if (request.machine !== undefined) {
      const named = fleet.filter(machine => machine.id === request.machine || machine.label === request.machine);
      if (named.length > 1) throw new Error('Machine label is ambiguous; use its id');
      chosen = named[0];
      if (!chosen) throw new Error(`No machine is named ${request.machine}.`);
      if (chosen.state !== 'online') throw new Error(`${chosen.label} is offline. Start GitSpace on ${chosen.label} or attach another machine.`);
    } else {
      // A machine already setting up for this workspace is the one to wait for.
      const settingUp = attachments.find(item => isAttachmentOnline(item) && item.state === 'attaching' && offers(item.machineId));
      if (settingUp) return { state: 'attaching', machineId: settingUp.machineId, label: fleet.find(machine => machine.id === settingUp.machineId)?.label ?? settingUp.machineId, attachmentId: settingUp.attachmentId, generation: settingUp.generation };
      const defaultId = (await env.USER_SETTINGS.getByName(env.ACCOUNT_ID).get('runtime')).defaults.machineId;
      const online = fleet.filter(machine => machine.state === 'online' && offers(machine.id)).sort((left, right) => Number(right.id === defaultId) - Number(left.id === defaultId));
      chosen = online.find(machine => machine.agentsMayAttach !== false) ?? online[0];
      if (!chosen) {
        if (request.needs?.length && fleet.some(machine => machine.state === 'online')) throw new Error(`No online machine offers ${request.needs.join(', ')}.`);
        const known = fleet.find(machine => machine.id === defaultId) ?? fleet.find(machine => machine.kind === 'physical') ?? fleet[0];
        throw new Error(known ? `No machine is online. Start GitSpace on ${known.label} or attach a machine.` : 'No machine is online. Add a machine in Settings → Machines.');
      }
    }
    const machine = chosen;
    if (machine.agentsMayAttach === false) {
      const questionId = await runtime.harness.commit(async tx => {
        const questions = await tx.doc(QuestionsDoc);
        const pending = questions.items.find(item => item.conversationId === conversationId && item.answer === null && item.id.startsWith(`machine-attach:${machine.id}:`));
        if (pending) return pending.id;
        const id = `machine-attach:${machine.id}:${crypto.randomUUID()}`;
        questions.items.push({ id, conversationId, kind: 'approval', prompt: `Attach ${machine.label} to this workspace? Agents may not attach it on their own.`, choices: ['Approve', 'Reject'], answer: null, tool: { name: 'machines', args: { op: 'attach', machine: machine.id } } });
        return id;
      }, BACKGROUND_CONTEXT);
      return { state: 'awaiting-approval', machineId: machine.id, label: machine.label, questionId };
    }
    const attachment = attachments.find(item => item.machineId === machine.id && item.state !== 'detached') ?? (await options.requestAttachment(machine.id)).attachment;
    const ready = isAttachmentReady(attachment);
    if (!ready) runtime.noticeWhenReady({ attachmentId: attachment.attachmentId, generation: attachment.generation, conversationId, label: machine.label });
    return { state: ready ? 'ready' : 'attaching', machineId: machine.id, label: machine.label, attachmentId: attachment.attachmentId, generation: attachment.generation };
  }
  /** A machine tool called with no ready machine attaches one the way `machines attach` does and fails at once,
   * saying so; the agent retries the call once the machine is ready. */
  async function requireMachine(input: Pick<Invocation, 'conversationId' | 'tool'>, args: unknown): Promise<void> {
    if (await selections.find(args)) return;
    const selector = RuntimeDispatchSelectionSchema.parse(args).on;
    const hint = input.tool === 'grep' ? ' Meanwhile, code_search searches the cloud copy without a machine.' : '';
    let outcome: MachineAttachOutcome;
    try { outcome = await attachMachine(input.conversationId, typeof selector === 'string' ? { machine: selector } : { needs: selector?.needs }); }
    catch (error) { throw new Error(`${message(error)}${hint}`); }
    if (outcome.state === 'awaiting-approval') throw new Error(`No machine is attached. Attaching ${outcome.label} needs the user's approval; they have been asked. Retry this call once it is attached and ready.${hint}`);
    if (outcome.state === 'attaching') throw new Error(`No machine was ready, so ${outcome.label} is being attached to this workspace. Retry this call when its setup finishes; a notice will arrive.${hint}`);
    // Attached and ready, yet not what the call selects (a profile it has not prepared): the selection explains.
    await selections.cache(args);
  }
  const selecting = new Map<string, { fingerprint: string; promise: Promise<RuntimeToolResult> }>();
  async function executeMachine(input: Invocation, deadlineAt?: string): Promise<RuntimeToolResult> {
    const fingerprint = canonicalJson({ requestId: input.requestId, conversationId: input.conversationId, taskId: input.taskId, tool: input.tool, args: input.args, replay: input.replay });
    const prior = selecting.get(input.attemptId);
    if (prior) return prior.fingerprint === fingerprint ? prior.promise : failed(input, new Error('Concurrent attempt identity changed'));
    const promise = executeMachineOnce(input, deadlineAt);
    selecting.set(input.attemptId, { fingerprint, promise });
    try { return await promise; } finally { selecting.delete(input.attemptId); }
  }
  async function executeMachineOnce(input: Invocation, deadlineAt?: string): Promise<RuntimeToolResult> {
    const conversation = await options.runtime().browserConversation(input.conversationId);
    if (!conversation.root && !isSubagentToolCallAllowed(input.tool, input.args, conversation.tools ?? [])) return failed(input, new Error(`This subagent cannot use ${input.tool} this way`));
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
      if (dispatch) return settle(interrupted(input, 'Execution deadline expired; the outcome on the machine is unknown.'));
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
        const selected = await selections.cache(input.args, undefined, input.tool === 'lifecycle');
        const snapshot = await runtime.cloudFiles.initializeSnapshot();
        if (!snapshot) throw new Error('Cloud working copy is unavailable');
        const tool = input.tool === 'checkpoint_code' ? 'checkpoint' : input.tool;
        dispatch = RuntimeToolDispatchSchema.parse({ version: 1, ...identity, conversationId: input.conversationId, conversationKind: conversation.root ? 'main' : 'subagent', taskId: input.taskId, machineId: selected.machineId, attachmentId: selected.attachmentId, generation: selected.generation, requestId: input.requestId, attemptId: input.attemptId, snapshot, tool, args: input.args, deadlineAt: deadline, replay: input.replay });
        ctx.storage.sql.exec('INSERT INTO runtime_host_dispatch(id,dispatch) VALUES(?,?)', input.attemptId, JSON.stringify(dispatch));
      } else if (dispatch.requestId !== input.requestId || dispatch.conversationId !== input.conversationId || dispatch.taskId !== input.taskId || dispatch.replay !== input.replay || dispatch.tool !== (input.tool === 'checkpoint_code' ? 'checkpoint' : input.tool) || canonicalJson(dispatch.args) !== canonicalJson(input.args)) {
        throw new Error('Attempt identity was reused for a different operation');
      }
      return settle(await options.runtime().attachments.execute(dispatch, controller.signal));
    } catch (error) {
      // Aborting the request stops the command on the machine.
      if (controller.signal.aborted) return settle(interrupted(input, savedDispatch(input.attemptId) ? 'Execution cancelled; the machine stopped the command.' : 'Execution cancelled before dispatch.'));
      return settle(failed(input, error));
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
      active.delete(input.attemptId);
    }
  }
  /** A dispatched command that is not running and has no recorded result was cut off by a restart: its outcome is unknown. */
  function attemptOutcome(attemptId: string): RuntimeToolResult | null {
    const original = savedDispatch(attemptId);
    if (!original || active.has(attemptId)) return null;
    const settled = selections.load(attemptId)?.result;
    if (settled) return RuntimeToolResultSchema.parse(settled);
    return interrupted(original, `Machine ${original.machineId} did not return a result before GitSpace restarted; the outcome is unknown.`);
  }
  async function cancelLifecycle(dispatch: RuntimeToolDispatch) {
    const request = RuntimeLifecycleDispatchArgumentsSchema.parse(dispatch.args);
    const result = await options.environment.mutateLifecycleState(identity, { op: 'cancel', runId: request.runId }, { machineId: dispatch.machineId, actorId: `task:${dispatch.attemptId}`, kind: 'client', lifecycleControl: false });
    if (result.status === 'error') throw new Error(result.failure.message);
  }
  async function awaitLifecycle(dispatch: RuntimeToolDispatch, signal?: AbortSignal): Promise<RuntimeToolResult> {
    const request = RuntimeLifecycleDispatchArgumentsSchema.parse(dispatch.args);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    active.set(dispatch.attemptId, controller);
    try {
      const run = (await options.environment.getLifecycleState(identity)).runs.find(item => item.id === request.runId);
      if (!run) return interrupted(dispatch, 'Lifecycle dispatch has no canonical admission receipt; effects will not be replayed.');
      if (run.phase !== request.phase || run.machineId !== dispatch.machineId || (run.attachment && (run.attachment.attachmentId !== dispatch.attachmentId || run.attachment.generation !== dispatch.generation))) throw new Error('Lifecycle receipt does not match its admitted execution identity');
      // The run's machine reports its end to this object, which resolves the wait; no polling.
      const wait = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, Math.min(Date.parse(dispatch.deadlineAt), Date.parse(run.deadlineAt)) - Date.now()))]);
      let ended: LifecycleRun;
      try { ended = await options.environment.lifecycleRunEnded(identity, run.id, wait); }
      catch (error) {
        if (!wait.aborted) throw error;
        await cancelLifecycle(dispatch);
        return interrupted(dispatch, 'Lifecycle cancellation requested; the run ends when its machine stops it.');
      }
      if (ended.status === 'succeeded') return completed(dispatch, ended);
      if (ended.status === 'failed') return failed(dispatch, ended.failure?.message ?? `Lifecycle exited with ${ended.exitCode}`);
      return interrupted(dispatch, ended.failure?.message ?? `Lifecycle ${ended.status}`);
    } finally { signal?.removeEventListener('abort', abort); active.delete(dispatch.attemptId); }
  }
  async function environment(input: Invocation) {
    const args = RuntimeEnvironmentArgumentsSchema.parse(input.args);
    const method = args.method;
    if (method === 'get') {
      const lifecycle = await options.environment.currentLifecycleState(identity);
      lifecycle.values.global = await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).getEnvironmentValues();
      return completed(input, projectEnvironmentState(lifecycle));
    }
    if (method === 'runLog' || method === 'log') {
      const request = args;
      const run = (await options.environment.getLifecycleState(identity)).runs.find(entry => entry.id === request.runId);
      if (!run) throw new Error('Run does not belong to this workspace');
      if (run.interactive) throw new Error('Protected interactive output is not agent-readable');
      return completed(input, await options.environment.getLifecycleRunLog(identity, request.runId, request.offset));
    }
    if (method === 'runPhase' || method === 'runChecks') {
      const { method: ignored, ...candidate } = args;
      const request = RuntimeAgentLifecycleRunArgumentsSchema.parse({ ...candidate, phase: args.method === 'runChecks' ? 'checks' : args.phase });
      return executeMachine({ ...input, tool: 'lifecycle', args: RuntimeJsonSchema.parse(request), replay: 'unsafe' }, request.deadlineAt);
    }
    if (method === 'setProfile' || method === 'putValue' || method === 'deleteValue' || method === 'cancelRun') {
      const mutation = LifecycleMutationSchema.parse(args.method === 'setProfile' ? { op: 'profile', profile: args.profile } : args.method === 'cancelRun' ? { op: 'cancel', runId: args.runId } : { op: 'value', scope: args.scope, name: args.name, value: args.method === 'deleteValue' ? null : args.value });
      // A cloud actor has no machine claim and cannot approve, abandon or recover runs.
      const result = await options.environment.mutateLifecycleState(identity, mutation, { machineId: `cloud:${identity.workspaceId}`, actorId: `conversation:${input.conversationId}`, kind: 'client', lifecycleControl: false });
      if (result.status === 'error') throw new Error(result.failure.message);
      return completed(input, projectEnvironmentState(result.state));
    }
    throw new Error('Environment approval, recovery, secret access and protected I/O require human control');
  }
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_sync_backups (ref TEXT PRIMARY KEY, commit_id TEXT NOT NULL, base_id TEXT NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL, paths TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS runtime_sync_backups_created ON runtime_sync_backups(created_at)');
  /** Records a backup and writes `<ref>-base`, so a machine can fetch the base to restore against. Keeps the newest 20
   * backups or the last 30 days, whichever keeps more; a pruned machine backup releases its LFS pin. Refs stay in the store. */
  async function recordBackup(code: ArtifactsCodeStore, repository: string, backup: { checkpointRef: string; commit: string; base: string }, source: string, reason: string, paths: readonly { status: string; path: string }[]) {
    await code.copyCommit(repository, repository, `${backup.checkpointRef}-base`, backup.base, null);
    const now = Date.now();
    ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_sync_backups(ref,commit_id,base_id,source,reason,paths,created_at) VALUES(?,?,?,?,?,?,?)', backup.checkpointRef, backup.commit, backup.base, source, reason, JSON.stringify(paths), now);
    const pruned = ctx.storage.sql.exec<{ ref: string; source: string }>('SELECT ref,source FROM runtime_sync_backups WHERE created_at < ? AND ref NOT IN (SELECT ref FROM runtime_sync_backups ORDER BY created_at DESC LIMIT 20)', now - 30 * 86_400_000).toArray();
    for (const row of pruned) {
      if (row.source !== 'cloud') await authority().lfsReleasePublication(row.ref);
      ctx.storage.sql.exec('DELETE FROM runtime_sync_backups WHERE ref=?', row.ref);
    }
  }
  async function onMachine<S extends z.ZodType>(input: Invocation, args: z.input<typeof RuntimeSyncMachineArgumentsSchema>, schema: S): Promise<z.output<S>> {
    const defined = RuntimeJsonSchema.parse(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)));
    // The machine attempt needs its own id: history resolves a tool call's attemptId to that attempt's result, and
    // the `sync` result is not the machine's.
    const result = await executeMachine({ ...input, attemptId: `${input.attemptId}:sync`, tool: 'sync_machine', args: defined, replay: runtimeOperationIsReadOnly('sync_machine', defined) ? 'safe' : 'unsafe' });
    const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
    if (result.status !== 'completed') throw new Error(result.status === 'failed' ? result.error.message : text || 'The machine did not finish the sync operation');
    return schema.parse(JSON.parse(text));
  }
  /** Paths that differ between a machine's base commit and the cloud working copy: cloud changes not yet on the machine. */
  async function cloudChangesSince(code: ArtifactsCodeStore, repository: string, base: string, tree: string) {
    const reader = code.reader(repository);
    try {
      const commit = await reader.readCommit(base);
      if (!commit) return { changes: [], truncated: false };
      const [before, after] = await Promise.all([snapshotEntries(reader, commit.treeHash), snapshotEntries(reader, tree)]);
      const changes: { status: string; path: string }[] = [];
      let total = 0;
      for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const a = before.get(path), b = after.get(path);
        if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
        total++;
        if (changes.length < 500) changes.push({ status: !a ? 'A' : !b ? 'D' : 'M', path });
      }
      return { changes, truncated: total > changes.length };
    } finally { await reader.close(); }
  }
  /** Settles one conflict with a cloud write. The conflicted version holds both sides, so it is kept under a backup ref first. */
  async function resolveConflict(input: Invocation, path: string, keep: 'cloud' | 'machine', code: ArtifactsCodeStore, repository: string) {
    const runtime = options.runtime();
    const cloud = await runtime.cloudFiles.initializeSnapshot();
    if (!cloud) throw new Error('Cloud working copy is unavailable');
    if (!(cloud.conflicts ?? []).includes(path)) throw new Error(`${path} is not in conflict. Current conflicts: ${(cloud.conflicts ?? []).join(', ') || 'none'}`);
    const reader = code.reader(repository);
    const entries = await snapshotEntries(reader, cloud.worktreeTree).finally(() => reader.close());
    const sibling = [...entries.keys()].find(other => other.startsWith(`${path}.gitspace-machine-`)) ?? null;
    const textOf = async (target: string) => { const blob = await code.readFile(repository, cloud.worktreeCommit, target); return blob ? readSnapshotText(blob) : null; };
    const current = entries.has(path) ? await textOf(path) : null;
    const machineCopy = sibling ? await textOf(sibling) : null;
    const markers = current !== null && hasSnapshotConflictMarkers(current);
    if (!markers && (!sibling || machineCopy === null || (entries.has(path) && current === null))) {
      throw new Error(sibling
        ? `${path} is a binary conflict. On the machine, move ${sibling} over ${path} to keep the machine's version, or delete ${sibling} to keep the cloud's; the conflict clears on the next sync.`
        : `${path} has no conflict markers or machine copy left; edit it directly to clear the conflict.`);
    }
    const checkpointRef = `refs/gitspace/backups/cloud/${Date.now()}`;
    await code.copyCommit(repository, repository, checkpointRef, cloud.worktreeCommit, null);
    const message = `Resolve conflict in ${path}: keep ${keep}`;
    const mutate = async (step: number, tool: 'write' | 'apply_patch', args: z.infer<typeof RuntimeJsonSchema>) => {
      const result = await runtime.cloudFiles.execute({ ...input, requestId: `${input.requestId}:resolve:${step}`, attemptId: `${input.attemptId}:resolve:${step}`, tool, args }, input.signal);
      if (result.status !== 'completed') throw new Error(result.status === 'failed' ? result.error.message : `Resolving ${path} was interrupted; check sync status before retrying`);
    };
    if (markers) await mutate(1, 'write', { path, content: resolveSnapshotConflictText(current, keep), message });
    else {
      if (keep === 'machine' && machineCopy !== null) await mutate(1, 'write', { path, content: machineCopy, message });
      else if (current !== null) await mutate(1, 'write', { path, content: current, message });
      await mutate(2, 'apply_patch', { patch: `*** Begin Patch\n*** Delete File: ${sibling}\n*** End Patch`, message });
    }
    // Restoring this backup re-applies the conflicted version on top of the resolution.
    const resolved = await runtime.cloudFiles.snapshot();
    await recordBackup(code, repository, { checkpointRef, commit: cloud.worktreeCommit, base: resolved?.worktreeCommit ?? cloud.worktreeCommit }, 'cloud', `resolve ${path}: keep ${keep}`, [{ status: 'C', path }]);
    return { resolved: path, keep, backup: checkpointRef, conflicts: resolved?.conflicts ?? [] };
  }
  async function sync(input: Invocation) {
    const args = RuntimeSyncArgumentsSchema.parse(input.args);
    const code = new ArtifactsCodeStore(env.ARTIFACTS);
    const repository = artifactsWorkspaceRepository(identity.workspaceId);
    if (args.method === 'backups') {
      const rows = ctx.storage.sql.exec<{ ref: string; commit_id: string; source: string; reason: string; paths: string; created_at: number }>('SELECT ref,commit_id,source,reason,paths,created_at FROM runtime_sync_backups ORDER BY created_at DESC').toArray();
      return completed(input, rows.map(row => ({ ref: row.ref, commit: row.commit_id, source: row.source, reason: row.reason, paths: JSON.parse(row.paths), createdAt: new Date(row.created_at).toISOString() })));
    }
    if (args.method === 'resolve') return completed(input, await resolveConflict(input, args.path, args.keep, code, repository));
    if (args.method === 'now') return completed(input, await onMachine(input, { op: 'capture', on: args.on }, RuntimeSyncMachineCaptureSchema));
    if (args.method === 'restore') {
      const row = ctx.storage.sql.exec<{ commit_id: string; base_id: string }>('SELECT commit_id,base_id FROM runtime_sync_backups WHERE ref=?', args.ref).toArray()[0];
      if (!row) throw new Error(`Unknown backup ${args.ref}; list backups with {"method":"backups"}`);
      return completed(input, await onMachine(input, { op: 'restore', on: args.on, checkpointRef: args.ref, commit: row.commit_id, baseRef: `${args.ref}-base`, base: row.base_id }, RuntimeSyncMachineRestoreSchema));
    }
    if (args.method === 'discard') {
      const result = await onMachine(input, { op: 'discard', on: args.on }, RuntimeSyncMachineDiscardSchema);
      if (result.backup) await recordBackup(code, repository, result.backup, result.machineId, args.reason ?? 'discarded unsent machine changes', result.discarded);
      if (result.error) throw new Error(`Backed up to ${result.backup?.checkpointRef ?? 'nowhere'}, but resetting the machine failed: ${result.error}`);
      return completed(input, { discarded: result.discarded, backup: result.backup?.checkpointRef ?? null });
    }
    // status and diff: the machine's unsent changes, plus cloud changes the machine has not applied yet.
    const machine = args.method === 'diff'
      ? await onMachine(input, { op: 'diff', on: args.on, path: args.path }, RuntimeSyncMachineDiffSchema)
      : await onMachine(input, { op: 'status', on: args.on }, RuntimeSyncMachineStatusSchema);
    const cloud = await options.runtime().cloudFiles.snapshot();
    const behind = cloud && machine.base && machine.base !== cloud.worktreeCommit ? await cloudChangesSince(code, repository, machine.base, cloud.worktreeTree) : { changes: [], truncated: false };
    return completed(input, { ...machine, cloudVersion: cloud?.worktreeCommit ?? null, conflicts: cloud?.conflicts ?? [], notOnMachine: behind.changes, notOnMachineTruncated: behind.truncated });
  }
  async function invoke(input: Invocation): Promise<RuntimeToolResult> {
    try {
      const conversation = await options.runtime().browserConversation(input.conversationId);
      if (!conversation.root && !isSubagentToolCallAllowed(input.tool, input.args, conversation.tools ?? [])) throw new Error(`This subagent cannot use ${input.tool} this way`);
      input.signal?.throwIfAborted();
      if (input.tool === 'grep') {
        requireGrepMachine(input.attemptId);
        return executeMachine(input);
      }
      if (input.tool === 'code_search') {
        const runtime = options.runtime();
        if (!(await runtime.cloudFiles.snapshot() ?? await runtime.cloudFiles.initializeSnapshot())) throw new Error('Workspace has no committed source snapshot');
        return completed(input, await runtime.codeSearch.search(RuntimeCodeSearchArgumentsSchema.parse(input.args)));
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
        if (args.op === 'attach') return completed(input, await attachMachine(input.conversationId, args));
        if (args.op === 'detach') {
          const request = args;
          const attachment = options.runtime().attachments.list().find(item => item.attachmentId === request.attachmentId);
          if (!attachment) throw new Error(`Attachment ${request.attachmentId} is not attached to this workspace`);
          const detached = options.runtime().attachments.detach(attachment);
          options.runtime().publish();
          return completed(input, detached);
        }
        // Offline attachments are not machines an agent can use; a machine whose heartbeat lapsed is reported offline first.
        await confirmMachinePresence(env, options.runtime().attachments.list().filter(item => isAttachmentOnline(item)).map(item => item.machineId));
        return completed(input, options.runtime().attachments.list().filter(item => isAttachmentOnline(item)));
      }
      if (input.tool === 'workspace_status') {
        await confirmMachinePresence(env, options.runtime().attachments.list().filter(item => isAttachmentOnline(item)).map(item => item.machineId));
        return completed(input, await options.runtime().status());
      }
      if (input.tool === 'agents' || input.tool === 'checkpoint' || input.tool === 'rewind') return options.runtime().invokeConversationTool(input);
      if (input.tool === 'environment') return environment(input);
      if (input.tool === 'sync') return sync(input);
      if (input.tool === 'generate_image') return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: await options.generateImage(input) };
      if (input.tool === 'report_issue') return completed(input, await appendRuntimeQa(env, identity, input.attemptId, RuntimeReportIssueArgumentsSchema.parse(input.args)));
      if (runtimeSpaceToolNames.includes(input.tool)) return completed(input, await invokeRuntimeSpaceTool(env, identity, input));
      if (input.tool === 'space_workspace') {
        const args = RuntimeWorkspaceArgumentsSchema.parse(input.args);
        switch (args.method) {
          case 'get': case 'current': {
            if (args.workspaceId === undefined || args.workspaceId === identity.workspaceId) return completed(input, identity.workspaceId === baseWorkspaceId ? await authority().getProject() : (await source()).workspace);
            // Another workspace in this project, with the relations an agent needs to change them.
            const workspace = await authority().getWorkspace(args.workspaceId);
            if (!workspace) throw new Error(`Workspace ${args.workspaceId} is not in this project`);
            return completed(input, { ...workspace, relations: (await authority().listWorkspaceRelations())[workspace.id] ?? null });
          }
          case 'list': return completed(input, await authority().listWorkspaces());
          case 'operations': return completed(input, await authority().listOperations());
          case 'status': {
            // Stored reports only: no workspace runtime opens and no agent is woken to answer.
            const listed = (await authority().listWorkspaces()).filter(workspace => workspace.kind === 'worktree' && workspace.lifecycle !== 'deleting' && (args.workspaceId === undefined || workspace.id === args.workspaceId));
            if (args.workspaceId !== undefined && listed.length === 0) throw new Error(`Workspace ${args.workspaceId} is not in this project`);
            const rows = await Promise.all(listed.map(async workspace => ({ id: workspace.id, name: workspace.name, branch: workspace.branch, lifecycle: workspace.lifecycle,
              report: await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspace.id}`).workspaceReport() })));
            const [row] = rows;
            if (args.workspaceId === undefined || !row) return completed(input, rows);
            // One workspace also gets its position against the project base, walked in cloud history.
            const project = await authority().getProject();
            const head = row.report?.code?.headCommit ?? null;
            const tip = project && head ? await readCloudBaseTip(env, env.ACCOUNT_ID, identity.projectId, project.baseBranch) : null;
            if (!project || !head || !tip) return completed(input, { ...row, base: null });
            const child = { head, repositories: [artifactsWorkspaceRepository(row.id)] };
            const code = new ArtifactsCodeStore(env.ARTIFACTS);
            try {
              const [behind, ahead] = await Promise.all([compareCloudHistory(code, tip, child), compareCloudHistory(code, child, tip)]);
              return completed(input, { ...row, base: { branch: project.baseBranch, ahead: ahead.leftAhead, behind: behind.leftAhead } });
            } catch (error) {
              return completed(input, { ...row, base: { branch: project.baseBranch, error: error instanceof Error ? error.message : String(error) } });
            }
          }
          case 'progress': {
            // Stored rows, plus the running turn's newest messages; the workspace's runtime opens only while it runs.
            const target = await authority().getWorkspace(args.workspaceId);
            if (!target || target.kind !== 'worktree') throw new Error(`Workspace ${args.workspaceId} is not a workspace in this project`);
            return completed(input, { workspaceId: target.id, name: target.name, ...await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${target.id}`).projectProgress({ projectId: identity.projectId, workspaceId: target.id }) });
          }
          case 'start': {
            // Only the project agent starts workspaces; workspaces starting each other could loop without a person.
            if (identity.workspaceId !== baseWorkspaceId) throw new Error('Only the project agent (the project\'s base workspace) can start other workspaces');
            const target = await authority().getWorkspace(args.workspaceId);
            if (!target || target.kind !== 'worktree') throw new Error(`Workspace ${args.workspaceId} is not a workspace in this project`);
            if (target.lifecycle !== 'active') throw new Error(`Workspace ${target.name} is ${target.lifecycle}; only an active workspace can be started`);
            // The attempt names the request, so a retried call delivers the instruction once; only the turn it starts reports.
            const accepted = await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${target.id}`).runtimeStartFromProject({ projectId: identity.projectId, workspaceId: target.id }, {
              name: target.name, requestId: `start:${input.attemptId}`, text: `Instruction from the project agent:\n\n${args.instruction}`, onDone: args.onDone,
            });
            return completed(input, { workspaceId: target.id, name: target.name, ...accepted });
          }
          default: return completed(input, await changeAgentWorkspace(env, identity, args));
        }
      }
      if (input.tool === 'space_phase') {
        const { phase } = RuntimeSpacePhaseArgumentsSchema.parse(input.args);
        // The canonical definition enforces the dependency ceiling; the runtime's workspace document drives this agent.
        const workspace = await setCloudWorkspacePhase(env, env.ACCOUNT_ID, identity, phase);
        await options.runtime().session(input.conversationId, { type: 'setWorkspacePhase', phase });
        return completed(input, workspace);
      }
      if (input.tool === 'space_artifacts') {
        const args = RuntimeSpaceArtifactsArgumentsSchema.parse(input.args);
        const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await source());
        switch (args.method) {
          case 'list': return completed(input, await artifacts.list());
          case 'listScopes': return completed(input, await authority().listArtifactScopes());
          case 'listPromotions': return completed(input, await authority().listArtifactPromotions());
          case 'read': return artifactContent(input, args.url, await artifacts.bytes(args.url), options.documentMarkdown);
          case 'readCode': {
            const request = args;
            const blob = await new ArtifactsCodeStore(env.ARTIFACTS).readFile(artifactsWorkspaceRepository(identity.workspaceId), request.commit, request.path);
            if (!blob) throw new Error('File is absent at the requested commit');
            return completed(input, { ...request, content: await blob.text() });
          }
          // The attached machine moves the file itself; the cloud only names it, and records what the machine stored.
          case 'toMachine':
          case 'fromMachine': {
            if (!conversation.root) throw new Error('Only the main workspace conversation moves files between the drive and a machine');
            const on = args.on === undefined ? {} : { on: args.on };
            if (args.method === 'toMachine') {
              const located = await artifacts.locate(args.url);
              return executeMachine({ ...input, tool: 'drive_transfer', args: RuntimeJsonSchema.parse({ direction: 'toMachine', path: args.path, ...located, ...on }) });
            }
            const target = await artifacts.machineTarget(args.url);
            const result = await executeMachine({ ...input, tool: 'drive_transfer', args: RuntimeJsonSchema.parse({ direction: 'fromMachine', path: args.path, scopeId: target.scopeId, ...on }) });
            if (result.status !== 'completed') return result;
            const text = result.content.find(item => item.type === 'text');
            if (text?.type !== 'text') throw new Error('The machine did not report the file it stored');
            const stored = RuntimeDriveTransferStoredSchema.parse(JSON.parse(text.text));
            return completed(input, await artifacts.write(args.url, { stored, mediaType: resourceMediaType(target.path) }));
          }
          default: throw new Error('Artifact sharing requires an explicit human action');
        }
      }
      if ((input.tool === 'read' || input.tool === 'write' || input.tool === 'edit') && typeof input.args === 'object' && input.args !== null && !Array.isArray(input.args) && typeof input.args.path === 'string' && input.args.path.startsWith('drive://')) {
        const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await source());
        if (input.tool === 'read') return artifactContent(input, input.args.path, await artifacts.bytes(input.args.path), options.documentMarkdown, RuntimeReadArgumentsSchema.parse(input.args));
        if (!conversation.root) throw new Error('Only the main workspace conversation can write artifacts');
        const change = input.tool === 'write' ? { bytes: new TextEncoder().encode(RuntimeWriteArgumentsSchema.parse(input.args).content) } : RuntimeEditArgumentsSchema.parse(input.args);
        return completed(input, await artifacts.write(input.args.path, change));
      }
      if (input.tool === 'history_search' || input.tool === 'history_read') {
        const args = object.parse(input.args);
        const transcript = async (workspaceId: string, conversationId: string, range: RuntimeTranscriptRange) => {
          if (workspaceId === identity.workspaceId) return options.runtime().transcript(conversationId, 'ndjson', range);
          const response = await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`).runtimeTranscript({ ...RuntimeIdentitySchema.parse({ projectId: identity.projectId, workspaceId }), conversationId }, 'ndjson', range);
          return response;
        };
        if (input.tool === 'history_read') {
          const request = RuntimeHistoryReadArgumentsSchema.parse(args);
          const workspaceId = request.workspaceId ?? identity.workspaceId;
          if (workspaceId !== identity.workspaceId && workspaceId !== identity.projectId && !await authority().getWorkspace(workspaceId)) throw new Error('History workspace is outside this project');
          // Ordinals are entryId*1024+n: the runtime reads only the requested entries.
          const range = request.mode === 'content' ? { from: request.ordinal, before: request.ordinal + 1 } : { from: request.offset };
          return completed(input, await readRuntimeHistory(await transcript(workspaceId, request.conversationId, range), request, workspaceId));
        }
        const request = RuntimeHistorySearchArgumentsSchema.parse(args);
        const workspaceIds = request.scope === 'workspace' ? [identity.workspaceId]
          : [...new Set([identity.projectId, ...(await authority().listWorkspaces()).map(workspace => workspace.id)])];
        return completed(input, await searchHistory(request.query, {
          workspaceIds,
          async conversations(workspaceId) {
            const snapshot = workspaceId === identity.workspaceId ? await options.runtime().snapshot() : RuntimeSnapshotSchema.parse(await (await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`).runtimeSnapshot(RuntimeIdentitySchema.parse({ projectId: identity.projectId, workspaceId }))).json());
            return snapshot.conversations.map(conversation => conversation.id);
          },
          async *events(workspaceId, conversationId, before) { yield* readRuntimeTranscript(await transcript(workspaceId, conversationId, before === undefined ? { newestFirst: true } : { newestFirst: true, before })); },
        }, (state, questions) => options.judge(input.conversationId, state, questions), request.cursor));
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
      // The attached machine's /tmp is scratch space beside the checkout, never synced: its files live only there.
      if ((input.tool === 'read' || input.tool === 'write' || input.tool === 'edit') && typeof input.args === 'object' && input.args !== null && !Array.isArray(input.args)
        && typeof input.args.path === 'string' && (input.args.path === '/tmp' || input.args.path.startsWith('/tmp/'))) return executeMachine(input);
      if (input.tool === 'read' || input.tool === 'edit' || input.tool === 'write' || input.tool === 'apply_patch' || input.tool === 'find') {
        const runtime = options.runtime();
        const conversation = await runtime.browserConversation(input.conversationId);
        if (!conversation.root && input.tool !== 'read' && input.tool !== 'find') throw new Error('Only the main workspace conversation can mutate the cloud working copy');
        try { return await runtime.cloudFiles.execute({ ...input, tool: input.tool }, input.signal); }
        catch (error) {
          if (!CloudPublicationUncertain.is(error)) throw error;
          await runtime.publicationUncertain(error);
          return interrupted(input, `Snapshot publication is awaiting durable recovery: a later wake finishes it, and a notice in this conversation says how it ended. Do not repeat the mutation as a new attempt. ${error.message}`);
        }
      }
      // A human run the account authorized: the same dispatch an agent's `environment` run makes, to the cache it names.
      if (input.tool === 'lifecycle') return executeMachine({ ...input, replay: 'unsafe' }, RuntimeLifecycleDispatchArgumentsSchema.parse(input.args).deadlineAt);
      if (machineTools[input.tool]) return executeMachine(input);
      throw new Error(`Unknown workspace tool: ${input.tool}`);
    } catch (error) { if (savedDispatch(input.attemptId)) throw error; return failed(input, error); }
  }
  async function execute(input: Operation): Promise<RuntimeToolResult> {
    try {
      const tool = { Checkpoint: 'checkpoint_code', LifecycleRun: 'lifecycle', Job: 'bash', Service: 'service', Merge: 'merge' }[input.kind];
      if (input.kind === 'LifecycleRun') RuntimeAgentLifecycleRunArgumentsSchema.parse(input.args);
      const result = await executeMachine({ ...input, tool }, input.deadlineAt);
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
      .filter(attachment => attachment.machineId === origin.machineId && attachment.projectId === origin.projectId && attachment.workspaceId === origin.workspaceId && isAttachmentReady(attachment))
      .sort((left, right) => right.generation - left.generation)[0];
    if (!selected) throw new Error('Original process machine is unreachable: no READY execution cache');
    if (!admission) {
      admission = RuntimeToolDispatchSchema.parse({ ...origin, attachmentId: selected.attachmentId, generation: selected.generation, parentAttemptId: input.originAttemptId, taskId: input.taskId, requestId: input.requestId, attemptId: input.attemptId, args: input.args, replay, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      // An observation is a read: nothing replays or reconciles it, so its envelope is not kept.
      if (replay === 'unsafe') ctx.storage.sql.exec('INSERT INTO runtime_host_dispatch(id,dispatch) VALUES(?,?)', input.attemptId, JSON.stringify(admission));
    }
    let dispatch = admission;
    if (admission.attachmentId !== selected.attachmentId || admission.generation !== selected.generation) {
      // Executor envelopes are immutable. Reattachment gets a distinct transport
      // attempt while the logical control and exact supervisor instance stay fixed.
      const attemptId = `${input.attemptId}:attachment:${encodeURIComponent(selected.attachmentId)}:${selected.generation}`;
      dispatch = savedDispatch(attemptId) ?? RuntimeToolDispatchSchema.parse({ ...admission, attemptId, attachmentId: selected.attachmentId, generation: selected.generation, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      if (replay === 'unsafe') ctx.storage.sql.exec('INSERT OR IGNORE INTO runtime_host_dispatch(id,dispatch) VALUES(?,?)', attemptId, JSON.stringify(dispatch));
    }
    return options.runtime().attachments.execute(dispatch, AbortSignal.timeout(30_000));
  }
  return {
    browser: browser.manage,
    tools: { invoke, prepareBrowser: browser.prepare, takeoverTab: browser.takeoverTab, authorizeCronTool,
      // A machine tool with no ready machine attaches one and fails here, before the user is asked to approve it.
      async preflight(input) {
        // Replay/reconciliation follows the admitted identity, not today's cache availability.
        if (savedDispatch(input.attemptId) || selections.load(input.attemptId)?.result) return;
        if ((machineTools[input.tool] && input.tool !== 'browser') || input.tool === 'grep') {
          await requireMachine(input, input.args);
        } else if (input.tool === 'environment') {
          const args = RuntimeEnvironmentArgumentsSchema.parse(input.args);
          if (args.method === 'runChecks' || args.method === 'runPhase') await requireMachine(input, args);
        } else if (input.tool === 'space_artifacts') {
          const args = RuntimeSpaceArtifactsArgumentsSchema.parse(input.args);
          if (args.method === 'toMachine' || args.method === 'fromMachine') await requireMachine(input, args);
        } else if (input.tool === 'sync') {
          const args = RuntimeSyncArgumentsSchema.parse(input.args);
          if (args.method !== 'backups' && args.method !== 'resolve') await selections.cache(args);
        } else if (input.tool === 'mcp_invoke' || input.tool === 'mcp_discover') {
          const args = object.parse(input.args);
          if (typeof args.connectionId === 'string' && await mcp.isStdio(args)) await selections.cache(args);
        }
      },
      async instructions(conversationId) {
      // One call reads the project, this workspace and its running services' URLs.
      const { project, workspace, services } = await authority().instructionContext(identity.workspaceId);
      if (!project) throw new Error('Project is not configured');
      if (!workspace && identity.workspaceId !== baseWorkspaceId) throw new Error('Workspace does not belong to this project');
      const serviceSummary = servicesBlock(services);
      const main = (await options.runtime().browserConversation(conversationId)).root;
      if (!main) {
        const [committed, skills] = await Promise.all([options.instructionLoader.loadInstructions(), enabledSkills()]);
        return [committed, serviceSummary, skills.map(skill => `- ${skill.id}: ${skill.description} (read skill://${skill.id})`).join('\n')].filter(Boolean).join('\n\n');
      }
      const owned = { projectId: identity.projectId, spaceId: identity.workspaceId };
      const context = env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, identity.projectId, identity.workspaceId]));
      const [committed, skills, goal, workflow, rubric] = await Promise.all([
        options.instructionLoader.loadInstructions(), enabledSkills(), context.getGoal(owned), context.getWorkflow(owned), context.getRubric(owned),
      ]);
      const skillSummary = skills.map(skill => `- ${skill.id}: ${skill.description} (read skill://${skill.id})`).join('\n');
      const canonical = `Current canonical workspace instructions. These replace prior Goal, Workflow, and Rubric instructions. Follow the latest requirements and gates unless the user tells you otherwise.\n${JSON.stringify({ goal, workflow, rubric })}`;
      return [USER_PRECEDENCE, `Workspace ${workspace?.name ?? project.name}; project ${project.name}; branch ${workspace?.branch ?? project.baseBranch}. Cloud reads remain available without a machine. Only the user approves lifecycle scripts in Environment, enters secrets, answers protected interactive prompts and shares QA outside GitSpace; your tools cannot do these.`, SHOWING_FILES, committed, canonical, serviceSummary, skillSummary ? `Enabled account skills:\n${skillSummary}` : ''].filter(Boolean).join('\n\n');
    } },
    operations: {
      execute,
      async jobScope(args) { await selections.cache(args); return identity; },
      async controlJob(input) {
        const dispatch = savedDispatch(input.attemptId);
        if (!dispatch || dispatch.tool !== 'bash') throw new Error('Background command has no admitted executor');
        const id = `job-${input.op}:${dispatch.attemptId}:${crypto.randomUUID()}`;
        if (input.op === 'cancel') return options.runtime().attachments.execute({ ...dispatch, requestId: id, attemptId: id, args: { op: 'cancel', attemptId: dispatch.attemptId }, deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe' }, AbortSignal.timeout(30_000));
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
        return attemptOutcome(attemptId);
      },
      async cancel(attemptId) {
        codemode.cancel(attemptId);
        active.get(attemptId)?.abort(new Error('Cancelled'));
        const dispatch = savedDispatch(attemptId);
        if (dispatch?.tool === 'lifecycle') await cancelLifecycle(dispatch);
      },
      wakeAt: options.schedule,
    },
  };
}
