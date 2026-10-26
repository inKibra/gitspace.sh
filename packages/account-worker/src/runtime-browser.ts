import type { BrowserWorkspaceServiceHostname } from '@gitspace/runtime-machine/browser-service-policy';
import type { ToolServices } from '@gitspace/runtime-core';
import { z } from 'zod';
import { READ_SITE_ACTIONS, browserOriginMatches, readSiteRefusal, type BrowserSiteLevel } from '@gitspace/protocol-environment';
import { RuntimeBrowserArgumentsSchema, RuntimeBrowserToolArgumentsSchema, RuntimeBrowserOverviewSchema, RuntimeBrowserPreviewSchema, RuntimeAccountBrowserSignedGrantSchema, RuntimeBrowserApprovalCardSchema, RuntimeBrowserGrantSchema, RuntimeBrowserSignedGrantSchema, RuntimeBrowsersDocumentSchema, RuntimeToolDispatchSchema, RuntimeBrowserStatusSchema, RuntimeBrowserArtifactPageSchema, browserBase64, canonicalBrowserAuthorization, signRuntimeBrowserAuthorization, signRuntimeBrowserGrant, type RuntimeBrowserAuthorizationBody, type RuntimeBrowserHolder, type RuntimeBrowserManagement, type RuntimeBrowsersDocument, type RuntimeBrowsersDocumentGroup, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { RuntimeProjectBrowserSettings, RuntimeBrowserPreview, RuntimeBrowserOverview, RuntimeBrowserGrant, RuntimeBrowserCapture, RuntimeBrowserCaptureView, RuntimeBrowserCommentStatus, RuntimeBrowserCommentThreadView, RuntimeBrowserCommentWrite } from '@gitspace/protocol-runtime';
import { RuntimeBrowserConnectedTabSchema, RuntimeBrowserShareSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachment, RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import type { RuntimeBrowserCaptureShare } from '@gitspace/protocol-runtime';
import { isAttachmentReady, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';
import type { AccountStateDO } from './account-state.js';
import { createAccountBrowserAuthority } from './runtime-browser-account.js';
import { waitForHandback, type BrowserTabTarget } from './browser-takeover.js';
import type { BrowserHoldChange } from './browser-session.js';
import { CAPTURE_FILES, captureFolder, captureName, captureView, captureViews, readCapture, writeCapture, type CaptureDrive, type CaptureFile } from './browser-capture.js';
import { browserRunSummary, logBrowserRun, recentBrowserRuns, viewNames, type BrowserRunEnd, type BrowserRunRow } from './browser-runs.js';
import { COMMENT_CROPS, workspaceCommentThreads, writeWorkspaceComment, type CommentWritten } from './browser-comments.js';
import type { SessionControlServices } from '@gitspace/runtime-core/session-controls';
import type { RuntimeAccountBrowserAuthorization, RuntimeAccountBrowserPlacement } from '@gitspace/protocol-runtime';
import type { RuntimeTakeoverTab } from '@gitspace/protocol-runtime';
import type { RuntimeBrowserToolArguments } from '@gitspace/protocol-runtime';
import { capturesText, readCaptureSummary, replayPreface, replayRun, saveCaptureSkill } from './browser-capture-agent.js';
import { localhostPort, localhostRefusal, machineBrowserNote, type WorkspaceServiceUrl } from './workspace-service-urls.js';
// Browser powers and Everything (`browser-powers.ts`).
import { BROWSER_HEAP_ON_CHROME, BROWSER_POWERS_UPDATE, browserGrantPower, browserPowerRefusal, browserStorageSiteRefusal, type BrowserEverything, type BrowserPower } from '@gitspace/protocol-runtime';
export interface RuntimeBrowserAuthority {
  prepare: ToolServices['prepareBrowser'];
  execute: ToolServices['invoke'];
  manage: NonNullable<SessionControlServices['browser']>;
  takeoverTab: ToolServices['takeoverTab'];
  /** Resolves when you hand a tab of the workspace's groups back (docs/APERTURE-DESIGN.md §7.2), at once when you do
   * not hold it; rejects when `signal` aborts. Event-driven, within this workspace object. */
  waitForHandback(target: BrowserTabTarget, signal: AbortSignal): Promise<void>;
}
type Input = Parameters<ToolServices['invoke']>[0] & { parentAttemptId?: string };
const savedPreparation = z.object({ fingerprint: z.string(), card: RuntimeBrowserApprovalCardSchema });
/** A machine's answer to `overview`: its headless browser's group for the workspace and the pages it opened. */
const machineOverview = z.object({ groupId: z.string().uuid().nullable(), tabs: z.array(z.object({ targetId: z.string(), url: z.string(), title: z.string() })).max(200) });
/** What the Browser tab shows for a machine whose release cannot answer `overview` or `preview`. */
const MACHINE_UPDATE_REQUIRED = 'Update GitSpace on this machine to see its browser';
/** A machine's answers to `captureStart` and `captureStop`: the page, and the recorded files on that machine. */
const machineCaptureStarted = z.object({ page: z.object({ url: z.string(), title: z.string() }), startedAt: z.iso.datetime() });
const machineCaptureStopped = z.object({ endedAt: z.iso.datetime(), count: z.number().int().nonnegative(), width: z.number().int().nonnegative(), height: z.number().int().nonnegative(), reason: z.string().nullable(), files: z.record(z.string(), z.string()) });
const MACHINE_CAPTURE_FILES: CaptureFile[] = ['frames.bin', 'frames.json', 'thumbnail.jpg'];
/** What the relay answers a `shareConnect`: the connected tab, or the Chrome where the workspace needs a live group first. */
const ShareConnection = z.union([z.strictObject({ connected: RuntimeBrowserConnectedTabSchema }), z.strictObject({ needsGroup: z.strictObject({ pairingId: z.string().uuid() }) })]);
/** Comment threads the Browser tab shows when it names no limit, newest first. */
const COMMENT_THREADS_SHOWN = 100;
/** Element names the recent runs remember from observed pages, at most. */
const REF_NAMES_KEPT = 1000;
type BrowserStorageTransaction = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean>; list(options: { prefix: string; reverse?: boolean; limit?: number; end?: string }): Promise<Map<string, unknown>> };
type BrowserStorage = BrowserStorageTransaction & { transaction<T>(callback: (tx: BrowserStorageTransaction) => Promise<T>): Promise<T> };
type BrowserEnvironment = {
  ACCOUNT_ID: Env['ACCOUNT_ID'];
  RELAY_NAME: Env['RELAY_NAME'];
  ACCOUNT_STATE: { getByName(name: string): Pick<AccountStateDO, 'certifyBrowserAuthority'> };
  FLEET_CATALOG: { getByName(name: string): { getMachine(id: string): Promise<Pick<FleetMachineDefinition, 'kind' | 'desiredState'> | null> } };
  /** Each workspace's cloud browser lives in its own object (`BrowserSessionDO`), named `<account>:<project>:<workspace>`. */
  BROWSER_SESSION?: { getByName(name: string): { execute(authorization: RuntimeAccountBrowserAuthorization): Promise<RuntimeToolResult>; overview(): Promise<{ tabs: { targetId: string; url: string; title: string }[]; running: number; held: RuntimeBrowserHolder[] }>; preview(targetId: string): Promise<RuntimeBrowserPreview>; closeTab(targetId: string): Promise<void>; captureStart(input: { projectId: string; workspaceId: string; captureId: string; groupId: string; targetId: string }): Promise<RuntimeBrowserCapture>; captureStop(input: { projectId: string; workspaceId: string; captureId: string }): Promise<RuntimeBrowserCapture>;
    holders(): Promise<RuntimeBrowserHolder[]>; takeOver(input: { projectId: string; workspaceId: string; targetId: string; device: string | null }): Promise<BrowserHoldChange>; resume(input: { projectId: string; workspaceId: string; targetId: string }): Promise<BrowserHoldChange> } };
  RELAY?: { getByName(name: string): { browserRelayPlacement(projectId: string, pairingId?: string): Promise<RuntimeAccountBrowserPlacement>; browserRelayProjectSettings(projectId: string): Promise<RuntimeProjectBrowserSettings>; browserRelayExecute(authorization: RuntimeAccountBrowserAuthorization): Promise<RuntimeToolResult> }
    // Capture share links (`browser-capture-share.ts`), kept by the relay.
    & { browserCaptureShares(workspace: { projectId: string; workspaceId: string }): Promise<RuntimeBrowserCaptureShare[]>; browserCaptureShareCreate(workspace: { projectId: string; workspaceId: string }, input: { captureId: string; comment: boolean; expiresInMinutes: number }): Promise<RuntimeBrowserCaptureShare>; browserCaptureShareRevoke(workspace: { projectId: string; workspaceId: string }, captureShareId: string): Promise<RuntimeBrowserCaptureShare> }
    // Browser powers and Everything (`browser-powers.ts`), kept by the relay per approval and per workspace.
    & { browserRelayPowers(projectId: string, workspaceId: string): Promise<ChromePowers[]>; browserRelayEverything(projectId: string, workspaceId: string, pairingId: string, on: boolean): Promise<BrowserEverything | null> } };
};
type BrowserRuntime = Pick<WorkspaceRuntime, 'harness' | 'browserConversation' | 'browserEvent'> & { attachments: Pick<WorkspaceRuntime['attachments'], 'list' | 'execute'> };
/** What a workspace's agents may do beyond its sites on one Chrome its project approved (`browser-powers.ts`):
 * `supported` while its extension enforces powers. */
type ChromePowers = { pairingId: string; name: string; powers: BrowserPower[]; supported: boolean; everything: BrowserEverything | null };
export async function runtimeBrowserKey(storage: BrowserStorage) {
  const schema = z.object({ privateKey: z.string(), publicKey: z.string() });
  let stored = await storage.get('runtime.browser.signing-key');
  if (!stored) {
    const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const value = { privateKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', generated.privateKey))), publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey))) };
    stored = await storage.transaction(async tx => { const current = await tx.get('runtime.browser.signing-key'); if (current) return current; await tx.put('runtime.browser.signing-key', value); return value; });
  }
  const value = schema.parse(stored);
  const decode = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0));
  return { privateKey: await crypto.subtle.importKey('pkcs8', decode(value.privateKey), 'Ed25519', false, ['sign']), publicKey: await crypto.subtle.importKey('raw', decode(value.publicKey), 'Ed25519', true, ['verify']) };
}
export async function runtimeBrowserPublicKey(storage: DurableObjectStorage) {
  const pair = await runtimeBrowserKey(storage);
  return { algorithm: 'Ed25519' as const, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
}
/** Prefix of this workspace's stored Chrome group rows, written from the relay's reports. */
export const BROWSER_GROUP_ROWS = 'runtime.browser.chrome:';
/** `gitspace.browsers` from stored rows: the groups still in force, newest report first. */
export async function workspaceBrowsersDocument(storage: { list(options: { prefix: string }): Promise<Map<string, unknown>>; get(key: string): Promise<unknown> }): Promise<RuntimeBrowsersDocument> {
  const chrome: RuntimeBrowsersDocumentGroup[] = [];
  for (const row of (await storage.list({ prefix: BROWSER_GROUP_ROWS })).values()) {
    const group = RuntimeBrowsersDocumentSchema.shape.chrome.element.parse(row);
    if (!await storage.get(`runtime.browser.revoked:${group.groupId}`)) chrome.push(group);
  }
  return { chrome: chrome.sort((left, right) => right.reportedAt.localeCompare(left.reportedAt)).slice(0, 32) };
}
/** Ends this workspace's Chrome groups: revoked here, so a later use starts a new group; its rows go; the relay has
 * each Chrome close the agent's tabs and let yours go. */
export async function retireWorkspaceBrowsers(storage: { list(options: { prefix: string }): Promise<Map<string, unknown>>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> }, relay: { browserRelayRetireWorkspace(projectId: string, workspaceId: string): Promise<void> }, identity: { projectId: string; workspaceId: string }) {
  for (const groupId of (await storage.list({ prefix: 'runtime.browser.account.group:' })).values()) await storage.put(`runtime.browser.revoked:${z.string().uuid().parse(groupId)}`, true);
  for (const key of (await storage.list({ prefix: BROWSER_GROUP_ROWS })).keys()) await storage.delete(key);
  await relay.browserRelayRetireWorkspace(identity.projectId, identity.workspaceId);
}
/** `approvedSites`: the approved sites at their levels, and the commit their `.gitspace/bundle.json` was read at (null with none). */
export type RuntimeBrowserAuthorityOptions = {
  storage: BrowserStorage; env: BrowserEnvironment; identity: { projectId: string; workspaceId: string }; runtime(): BrowserRuntime; selectExecution(args: RuntimeBrowserArguments, candidates: RuntimeAttachment[]): Promise<RuntimeAttachment>; approvedSites(): Promise<{ sites: { pattern: string; level: BrowserSiteLevel }[]; revision: string | null }>; groupName(): Promise<string>;
  /** The workspace's running http services at their workspace URLs. */
  services(): Promise<WorkspaceServiceUrl[]>;
  /** The workspace's drive, where captures are kept. */
  drive(): CaptureDrive;
  /** Moves a file on an attached machine (`machinePath`, inside its /tmp) to the workspace's drive at `path`. */
  fromMachine(input: { conversationId: string; machineId: string; machinePath: string; path: string; mediaType: string }): Promise<void>;
  /** Comments (`browser-comments.ts`): the account's name, as its owner's comments show it, and what follows each
   * change made here (`announceComment`). */
  comments: { ownerName(): Promise<string>; announce(written: CommentWritten): Promise<void> };
  /** The working copy's commit holding `file` (a repository path), null when it does not: a capture's skill is saved
   * at it. */
  skillCommit(file: string): Promise<string | null>;
};
export function createRuntimeBrowserAuthority(options: RuntimeBrowserAuthorityOptions): RuntimeBrowserAuthority {
  const { storage, env, identity } = options;
  async function eligible(machineId: string) {
    for (const attachment of options.runtime().attachments.list()) {
      if (attachment.machineId !== machineId || !isAttachmentReady(attachment)) continue;
      const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(attachment.machineId);
      if (!machine || machine.desiredState === 'removed') continue;
      return attachment;
    }
    throw new Error('No eligible browser executor is ready');
  }
  async function execution(args: RuntimeBrowserArguments) {
    const candidates: RuntimeAttachment[] = [];
    for (const attachment of options.runtime().attachments.list()) {
      if (!isAttachmentReady(attachment) || !attachment.capabilities.includes(`browser.${args.source}`)) continue;
      const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(attachment.machineId);
      if (!machine || machine.desiredState === 'removed' || args.source === 'relay' && machine.kind !== 'physical') continue;
      candidates.push(attachment);
    }
    if (!candidates.length) throw new Error(args.source === 'relay' ? 'No eligible user-owned physical browser machine is ready' : 'No eligible browser executor is ready');
    return options.selectExecution(args, candidates);
  }
  /** The machines whose headless browser runs this workspace's headless steps: ready, with one, not removed. One
   * attachment per machine. */
  async function headlessMachines() {
    const found = new Map<string, RuntimeAttachment>();
    for (const attachment of options.runtime().attachments.list()) {
      if (found.has(attachment.machineId) || !isAttachmentReady(attachment) || !attachment.capabilities.includes('browser.headless')) continue;
      const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(attachment.machineId);
      if (machine && machine.desiredState !== 'removed') found.set(attachment.machineId, attachment);
    }
    return [...found.values()];
  }
  async function signing() {
    const { privateKey, publicKey } = await runtimeBrowserKey(storage);
    const issuedAt = new Date().toISOString();
    const authority = await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).certifyBrowserAuthority({ accountId: env.ACCOUNT_ID, ...identity, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))), issuedAt, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    return { privateKey, authority, issuedAt };
  }
  /** Who holds a tab when you do (docs/APERTURE-DESIGN.md §7.2): for the cloud browser's group its session, for one of
   * your Chromes' groups that Chrome's last report; undefined while the agent does. */
  async function holder(target: BrowserTabTarget): Promise<RuntimeBrowserHolder | undefined> {
    if (target.groupId === await liveGroup('cloud')) return env.BROWSER_SESSION ? (await env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${identity.projectId}:${identity.workspaceId}`).holders()).find(item => item.targetId === target.targetId) : undefined;
    return (await workspaceBrowsersDocument(storage)).chrome.find(group => group.groupId === target.groupId)?.held.find(item => item.targetId === target.targetId);
  }
  const account = createAccountBrowserAuthority(options, signing, holder);
  function accountPlacement(args: RuntimeBrowserArguments) {
    // Headless means the cloud browser; a machine's headless browser runs single steps only when the agent names that
    // machine with `on` (localhost on that machine), and never scripts.
    return args.source === 'relay' || args.action === 'run' || !args.on;
  }
  async function signed(input: Input, placement: { machineId: string; attachmentId: string; generation: number }, command: RuntimeBrowserAuthorizationBody['command'], expiresAt: string): Promise<RuntimeToolDispatch> {
    const scope = { ...identity, machineId: placement.machineId, attachmentId: placement.attachmentId, generation: placement.generation, conversationId: input.conversationId, taskId: input.taskId, requestId: input.requestId, attemptId: input.attemptId };
    const conversation = await options.runtime().browserConversation(input.conversationId);
    const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, ...scope, conversationKind: conversation.root ? 'main' : 'subagent', ...(input.parentAttemptId ? { parentAttemptId: input.parentAttemptId } : {}), tool: command.type === 'execute' ? 'browser' : 'browser_control', args: input.args, deadlineAt: expiresAt, replay: input.replay });
    const { privateKey, authority, issuedAt } = await signing();
    dispatch.browserAuthorization = await signRuntimeBrowserAuthorization({ scope, issuedAt, expiresAt, dispatch: { version: 1, tool: command.type === 'execute' ? 'browser' : 'browser_control', deadlineAt: expiresAt, replay: input.replay, ...(input.parentAttemptId ? { parentAttemptId: input.parentAttemptId } : {}) }, command }, privateKey, authority);
    return dispatch;
  }
  /** Signs one management command for a machine's browser, runs it there and returns its JSON answer. */
  async function control(conversationId: string, placement: RuntimeAttachment, command: RuntimeBrowserManagement): Promise<unknown> {
    const id = crypto.randomUUID();
    const dispatch = await signed({ tool: 'browser_control', args: command, conversationId, taskId: id, requestId: id, attemptId: id, replay: 'unsafe' }, placement, { type: 'manage', ...command }, new Date(Date.now() + 60_000).toISOString());
    const result = await options.runtime().attachments.execute(dispatch, AbortSignal.timeout(60_000));
    if (result.status !== 'completed') {
      const message = result.status === 'failed' ? result.error.message : result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
      // LEGACY: releases before machine overviews take `overview`, `preview` (and before captures `captureStart` and
      // `captureStop`) for recovery commands (Batch 18) or refuse the action while checking its authorization
      // (earlier); remove once every machine answers them.
      const unknown = message.includes('Browser recovery record outside workspace') || message.includes('Invalid option');
      if ((command.action === 'overview' || command.action === 'preview') && unknown) throw new Error(MACHINE_UPDATE_REQUIRED);
      if ((command.action === 'captureStart' || command.action === 'captureStop') && unknown) throw new Error('Update GitSpace on this machine to record its browser');
      throw new Error(message);
    }
    const text = result.content.find(part => part.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Browser returned no structured response');
    return JSON.parse(text.text);
  }
  async function context(input: Input) {
    const conversation = await options.runtime().browserConversation(input.conversationId);
    const args = RuntimeBrowserArgumentsSchema.parse(input.args);
    if (args.source === 'relay' && !conversation.root) throw new Error('Logged-in Chrome relay is main-agent-only. Subagents must use source:"headless".');
    const approved = args.source === 'relay' ? (await options.approvedSites()).sites : [];
    // Browser powers: on your Chrome, what the project's approval of it gives agents and Everything while it lasts.
    // An extension that cannot enforce them gets neither in its grant.
    let chrome: ChromePowers | undefined;
    if (args.source === 'relay') {
      if (!env.RELAY) throw new Error('Account Chrome relay unavailable');
      const relay = env.RELAY.getByName(env.RELAY_NAME), placement = await relay.browserRelayPlacement(identity.projectId, args.pairingId);
      chrome = placement.kind === 'account-relay' ? (await relay.browserRelayPowers(identity.projectId, identity.workspaceId)).find(item => item.pairingId === placement.pairingId) : undefined;
    }
    const everything = chrome?.supported && chrome.everything ? chrome.everything : null;
    // As a grant carries them: `stepsOnly` the sites at interact, `read` those at read.
    const sites = { origins: [...new Set(approved.map(site => site.pattern))].sort(), stepsOnly: approved.filter(site => site.level === 'interact').map(site => site.pattern).sort(), read: approved.filter(site => site.level === 'read').map(site => site.pattern).sort() };
    // While Everything lasts the extension holds agents to its denylist, not to the approved sites.
    if (args.source === 'relay' && !everything) {
      const url = args.action === 'navigate' || args.action === 'open' ? args.url : undefined;
      // Before any site is approved the workspace still gets its group: an empty agent tab, and tabs to list it, so the
      // user can drag tabs in.
      if (!sites.origins.length && !(args.action === 'open' && !args.url || args.action === 'tabs')) throw new Error('No site is approved for this workspace yet, so on the user’s Chrome only open without url (an empty tab in the workspace group) and tabs work. Propose the site in browser.origins in .gitspace/bundle.json, commit the environment definition, and ask the user to approve it in Environment. Yolo never approves environment changes.');
      if (url && !sites.origins.some(pattern => browserOriginMatches(pattern, new URL(url).hostname))) throw new Error('Browser origin is not approved. Propose adding the required hostname to browser.origins in .gitspace/bundle.json, commit the environment definition, and ask the user to approve that origin in Environment. Yolo never approves environment changes.');
      // A script's sites are checked before anything is signed; your Chrome checks them again.
      for (const site of args.action === 'run' ? args.sites ?? [] : []) {
        if (!sites.origins.includes(site)) throw new Error(`${site} is not an approved site of this workspace. Name sites exactly as approved: ${sites.origins.join(', ')}.`);
        if (sites.read.includes(site)) throw new Error(readSiteRefusal(site));
        if (sites.stepsOnly.includes(site)) throw new Error(`${site} allows single steps only, not scripts. Use single browser steps on it.`);
      }
      // A step that may change the page (`READ_SITE_ACTIONS`) is refused on a tab its Chrome last reported on a read
      // site; the extension checks the tab again when the step runs. A script's tabs are the extension's to check.
      if (!READ_SITE_ACTIONS[args.action] && 'targetId' in args && sites.read.length) {
        const tab = (await workspaceBrowsersDocument(storage)).chrome.flatMap(group => group.tabs).find(item => item.targetId === args.targetId);
        const host = tab ? URL.parse(tab.url)?.hostname : undefined;
        if (host && sites.read.some(pattern => browserOriginMatches(pattern, host))) throw new Error(readSiteRefusal(host));
      }
    }
    if (args.action === 'debug' || args.action === 'storage') {
      if (args.on) throw new Error('Debug and storage run on the cloud browser or your Chrome, not on a machine’s headless browser; remove "on".');
      if (args.source === 'relay') {
        const name = chrome?.name ?? 'this Chrome';
        if (!chrome?.supported) throw new Error(`Chrome "${name}": ${BROWSER_POWERS_UPDATE}`);
        const power = args.action === 'debug' ? 'debug' : 'storage';
        if (!browserGrantPower({ powers: chrome.powers, ...(everything ? { everything } : {}) }, power, Date.now())) throw new Error(browserPowerRefusal(power, name));
        if (args.action === 'debug' && args.kind === 'heap') throw new Error(BROWSER_HEAP_ON_CHROME);
        if (args.action === 'storage' && !everything && !sites.origins.some(pattern => browserOriginMatches(pattern, args.site))) throw new Error(browserStorageSiteRefusal(args.site));
      }
    }
    // The cloud browser cannot reach a machine's localhost: the agent hears where the service is instead.
    const port = args.source === 'headless' && !args.on && (args.action === 'open' || args.action === 'navigate') && args.url ? localhostPort(args.url) : null;
    if (port !== null) throw new Error(localhostRefusal(port, await options.services()));
    return { conversation, args, sites: { ...sites, powers: chrome?.supported ? chrome.powers : [], everything } };
  }
  async function prepareCall(input: Input) {
    const { args, sites } = await context(input), origins = sites.origins;
    if (accountPlacement(args)) return account.prepare(input, args, sites);
    const fingerprint = canonicalBrowserAuthorization({ ...input, signal: undefined, args });
    const key = `runtime.browser.prepare:${input.attemptId}`;
    const prior = await storage.get(key);
    if (prior) {
      const saved = savedPreparation.parse(prior);
      if (saved.fingerprint !== fingerprint) throw new Error('Browser attempt identity reused');
      if (await storage.get(`runtime.browser.revoked:${saved.card.groupId}`)) throw new Error('Browser group grant expired or revoked');
      if ('placement' in saved.card) throw new Error('Browser placement changed');
      const executor = await execution(args);
      if (saved.card.machineId !== executor.machineId || saved.card.attachmentId !== executor.attachmentId || saved.card.generation !== executor.generation) throw new Error('Browser executing machine or attachment changed');
      return saved.card;
    }
    const groupKey = `runtime.browser.group:${args.source}`;
    const placement = await execution(args);
    const { groupId, grant } = await storage.transaction(async tx => {
      const existing = await tx.get(groupKey);
      const id = existing ? z.string().uuid().parse(existing) : undefined;
      const stored = id ? await tx.get(`runtime.browser.grant:${id}`) : undefined;
      const current = stored ? RuntimeBrowserSignedGrantSchema.parse(stored).body : undefined;
      const revoked = id ? await tx.get(`runtime.browser.revoked:${id}`) : false;
      if (id && !revoked && (!current || Date.parse(current.expiresAt) > Date.now() && current.machineId === placement.machineId && current.attachmentId === placement.attachmentId && current.generation === placement.generation)) return { groupId: id, grant: current };
      if (id) await tx.put(`runtime.browser.revoked:${id}`, true);
      const groupId = crypto.randomUUID();
      await tx.put(groupKey, groupId);
      return { groupId, grant: undefined };
    });
    const card = RuntimeBrowserApprovalCardSchema.parse({ ...identity, machineId: placement.machineId, attachmentId: placement.attachmentId, generation: placement.generation, groupId, groupName: await options.groupName(), source: args.source, origins, expiresAt: grant?.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(), id: crypto.randomUUID(), action: args.action });
    const saved = await storage.transaction(async tx => {
      if (await tx.get(`runtime.browser.revoked:${card.groupId}`) || await tx.get(groupKey) !== card.groupId) throw new Error('Browser group grant expired or revoked');
      const current = await tx.get(key);
      if (current) return savedPreparation.parse(current);
      const value = { fingerprint, card };
      await tx.put(key, value);
      return value;
    });
    if (saved.fingerprint !== fingerprint) throw new Error('Browser attempt identity reused');
    return saved.card;
  }
  /** `chromes`: the project's Chromes as the agent may choose among them. It touches no browser and signs nothing. */
  async function chromes(input: Input): Promise<RuntimeToolResult> {
    const conversation = await options.runtime().browserConversation(input.conversationId);
    const reply = (text: string): RuntimeToolResult => ({ status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text }] });
    if (!conversation.root) return reply('The user’s Chrome (source:"relay") is main-agent-only; subagents use the headless browser.');
    if (!env.RELAY) throw new Error('Account Chrome relay unavailable');
    const settings = await env.RELAY.getByName(env.RELAY_NAME).browserRelayProjectSettings(identity.projectId);
    if (!settings.browsers.length) return reply('No Chrome is paired with this account. Ask the user to pair one in Plugins → Browsers.');
    const approved = settings.browsers.filter(browser => browser.approved);
    const powers = settings.browsers.some(browser => browser.approved) ? await env.RELAY.getByName(env.RELAY_NAME).browserRelayPowers(identity.projectId, identity.workspaceId) : [];
    const rows = settings.browsers.map(browser => {
      const chrome = powers.find(item => item.pairingId === browser.pairingId);
      const granted = chrome ? [...chrome.powers, ...(chrome.everything ? [`Everything until ${chrome.everything.expiresAt}`] : [])] : [];
      return `- "${browser.name}" pairingId=${browser.pairingId}: ${browser.connected ? 'online' : 'offline'}, ${browser.approved ? 'approved' : 'not approved'}${browser.pairingId === settings.defaultPairingId ? ', default' : ''}${granted.length ? `, powers: ${granted.join(', ')}` : ''}${browser.note ? `. Note: ${browser.note}` : ''}`;
    });
    const rule = settings.defaultPairingId ? 'source:"relay" uses the default Chrome unless you pass an approved pairingId.' : approved.length === 1 ? 'source:"relay" uses the one approved Chrome unless you pass another approved pairingId.' : approved.length ? 'No Chrome is the default: pass the pairingId of an approved Chrome with source:"relay".' : 'None is approved for this project: ask the user to approve one in Plugins → Browsers or in this workspace’s Browser tab.';
    return reply(`Chromes paired with this account:\n${rows.join('\n')}\n${rule} Only an approved, online Chrome takes calls; an offline one is never replaced by another.`);
  }
  /** `comments`: the workspace's comment threads as the agent reads them, newest first, crops as drive addresses. It
   * touches no browser and signs nothing, so subagents read them too. */
  async function comments(input: Input, status: RuntimeBrowserCommentStatus, limit: number): Promise<RuntimeToolResult> {
    const list = (await workspaceCommentThreads(storage, { status, limit })).map(({ root, replies }) => ({
      threadId: root.id, page: root.page, source: root.source, resolved: root.resolved,
      on: root.anchor === null ? null : { role: root.anchor.role, name: root.anchor.name, selector: root.anchor.selector, area: root.anchor.area === true, box: root.anchor.box, crop: root.anchor.cropFile === undefined ? null : `drive://workspace/${root.anchor.cropFile}` },
      comments: [root, ...replies].map(comment => ({ by: comment.by.kind === 'agent' ? comment.by.conversation === 'main' ? 'you (the main agent)' : `subagent ${comment.by.conversation}` : `${comment.by.name}${comment.by.guest ? ' (guest)' : ''}`, text: comment.text, at: comment.createdAt })),
    }));
    return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: JSON.stringify(list) }] };
  }
  /** `commentReply` and `commentResolve`: the main agent's reply, shown as the agent on the page and to the thread's
   * viewers, or its resolving (reopening) a thread. Subagents are refused. */
  async function agentComment(input: Input, write: RuntimeBrowserCommentWrite): Promise<RuntimeToolResult> {
    const conversation = await options.runtime().browserConversation(input.conversationId);
    const written = await writeWorkspaceComment(storage, write, { kind: 'agent', conversation: conversation.root ? 'main' : input.conversationId });
    await options.comments.announce(written);
    const thread = written.thread.root.id;
    const text = write.op === 'reply' ? `Your reply is in thread ${thread}; people see it from the agent on the page, in the Browser tab and in share viewers.`
      : !written.changed ? `Thread ${thread} was already ${write.op === 'resolve' && write.reopen ? 'open' : 'resolved'}.` : write.op === 'resolve' && write.reopen ? `Thread ${thread} is open again.` : `Thread ${thread} is resolved.`;
    return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text }] };
  }
  // Captures (`browser-capture-agent.ts`, docs/APERTURE-DESIGN.md §11): reading them and saving one's skill touch no
  // browser and sign nothing; subagents read them, only the main agent saves a skill.
  async function captureCall(input: Input, tool: Extract<RuntimeBrowserToolArguments, { action: 'captures' | 'capture' | 'captureSaved' }>): Promise<RuntimeToolResult> {
    const drive = options.drive();
    let text: string;
    if (tool.action === 'captures') text = await capturesText(drive, tool.limit);
    else if (tool.action === 'capture') text = (await readCaptureSummary(drive, storage, tool.capture))?.text ?? `capture://${tool.capture} is not a capture of this workspace: web_browser {action:"captures"} lists them.`;
    else {
      if (!(await options.runtime().browserConversation(input.conversationId)).root) throw new Error('Only the main agent saves a capture as a skill; tell your parent which capture and skill folder.');
      const saved = await saveCaptureSkill(drive, tool.capture, tool.path, options.skillCommit);
      text = `Capture ${JSON.stringify(saved.name)} is saved as the skill ${saved.skill?.path} at commit ${saved.skill?.commit}; the Captures list shows it.`;
    }
    return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text }] };
  }
  /** `replay` becomes the `run` of its capture's steps (`replayRun`): prepared, run and logged as that run, its result
   * prefaced with the script. Other calls pass through. */
  async function replayed(input: Input): Promise<{ input: Input; preface: string | null }> {
    const tool = RuntimeBrowserToolArgumentsSchema.safeParse(input.args);
    if (!tool.success || tool.data.action !== 'replay') return { input, preface: null };
    const { run, script, capture } = await replayRun(options.drive(), tool.data);
    return { input: { ...input, args: run }, preface: replayPreface(capture, script) };
  }
  async function executeCall(input: Input): Promise<RuntimeToolResult> {
    const tool = RuntimeBrowserToolArgumentsSchema.parse(input.args);
    if (tool.action === 'chromes') return chromes(input);
    if (tool.action === 'comments') return comments(input, tool.status, tool.limit);
    if (tool.action === 'commentReply') return agentComment(input, { op: 'reply', threadId: tool.threadId, text: tool.text });
    if (tool.action === 'commentResolve') return agentComment(input, { op: 'resolve', threadId: tool.threadId, ...(tool.reopen === undefined ? {} : { reopen: tool.reopen }) });
    if (tool.action === 'captures' || tool.action === 'capture' || tool.action === 'captureSaved') return captureCall(input, tool);
    const { args, sites } = await context(input), origins = sites.origins;
    if (accountPlacement(args)) return account.execute(input, args, sites);
    const saved = savedPreparation.parse(await storage.get(`runtime.browser.prepare:${input.attemptId}`));
    if (saved.fingerprint !== canonicalBrowserAuthorization({ ...input, signal: undefined, args })) throw new Error('Browser dispatch differs from preparation');
    const card = saved.card;
    if ('placement' in card) throw new Error('Browser placement changed');
    if (Date.parse(card.expiresAt) <= Date.now() || await storage.get(`runtime.browser.revoked:${card.groupId}`)) throw new Error('Browser group grant expired or revoked');
    if (canonicalBrowserAuthorization(origins) !== canonicalBrowserAuthorization(card.origins)) throw new Error('Approved environment browser origins changed; prepare a new browser request.');
    const body = RuntimeBrowserGrantSchema.strip().parse(card);
    const placement = await execution(args);
    if (placement.machineId !== body.machineId || placement.attachmentId !== body.attachmentId || placement.generation !== body.generation) throw new Error('Browser executing machine or attachment changed');
    const grantKey = `runtime.browser.grant:${body.groupId}`;
    const stored = await storage.get(grantKey);
    let grant = stored ? RuntimeBrowserSignedGrantSchema.parse(stored) : undefined;
    if (!grant || canonicalBrowserAuthorization(grant.body) !== canonicalBrowserAuthorization(body)) {
      const { privateKey, authority } = await signing();
      grant = await signRuntimeBrowserGrant(body, privateKey, authority);
      await storage.put(grantKey, grant);
    }
    const key = `runtime.browser.dispatch:${input.attemptId}`;
    const persistedDispatch = await storage.get(key);
    let dispatch = persistedDispatch ? RuntimeToolDispatchSchema.parse(persistedDispatch) : undefined;
    if (!dispatch) {
      const candidate = await signed({ ...input, args }, placement, { type: 'execute', args, grant }, new Date(Math.min(Date.parse(body.expiresAt), Date.now() + 60_000)).toISOString());
      dispatch = await storage.transaction(async tx => { const current = await tx.get(key); if (current) return RuntimeToolDispatchSchema.parse(current); await tx.put(key, candidate); return candidate; });
    }
    if (await storage.get(`runtime.browser.revoked:${body.groupId}`)) throw new Error('Browser group grant expired or revoked');
    const result = await options.runtime().attachments.execute(dispatch, input.signal ?? AbortSignal.timeout(Math.max(1, Date.parse(dispatch.deadlineAt) - Date.now())));
    // The machine ended this group (it restarted, or the group was revoked there): end it here too, so the next call
    // starts a new group instead of failing the same way.
    if (result.status === 'failed' && /^Browser (group stale|grant expired)/.test(result.error.message)) {
      await storage.put(`runtime.browser.revoked:${body.groupId}`, true);
      return { ...result, error: { ...result.error, message: `${result.error.message}: that browser group ended on the machine. Call again to start a new group.` } };
    }
    if (result.status !== 'completed' || !(args.action === 'open' || args.action === 'navigate') || !args.url) return result;
    const note = machineBrowserNote(args.url, typeof args.on === 'string' ? args.on : placement.machineId, await options.services());
    return note ? { ...result, content: [...result.content, { type: 'text', text: note }] } : result;
  }
  /** Element names of the pages the agent observed, by ref, so the recent runs name what a later `act` acted on; the
   * newest `REF_NAMES_KEPT`, while this object stays awake. */
  const refNames = new Map<string, string>();
  /** Logs one browser call in the workspace's recent runs (`browser-runs.ts`), where it ran by its prepared placement;
   * a call whose arguments are no browser action is not a run, and a log that fails never fails the call. */
  async function record(input: Input, startedAt: number, end: BrowserRunEnd) {
    try {
      const parsed = RuntimeBrowserArgumentsSchema.safeParse(input.args);
      if (!parsed.success) return;
      const args = parsed.data;
      if ('result' in end && args.action === 'observe') {
        const view = end.result.content.flatMap(part => part.type === 'text' ? [part.text] : [])[1];
        for (const [ref, name] of view ? viewNames(view) : []) { refNames.delete(ref); refNames.set(ref, name); }
        for (const ref of refNames.keys()) { if (refNames.size <= REF_NAMES_KEPT) break; refNames.delete(ref); }
      }
      const saved = savedPreparation.safeParse(await storage.get(`runtime.browser.prepare:${input.attemptId}`));
      const card = saved.success ? saved.data.card : undefined;
      const where: BrowserRunRow['where'] = !card ? args.source === 'relay' ? { kind: 'chrome', pairingId: args.pairingId ?? null } : { kind: 'cloud' }
        : !('placement' in card) ? { kind: 'machine', machineId: card.machineId } : card.placement.kind === 'cloud' ? { kind: 'cloud' } : { kind: 'chrome', pairingId: card.placement.pairingId };
      await logBrowserRun(storage, { attemptId: input.attemptId, at: new Date(startedAt).toISOString(), where, tool: args.action, durationMs: Math.max(0, Date.now() - startedAt), ...browserRunSummary(args, end, refNames) });
    } catch (error) { console.warn(JSON.stringify({ event: 'browser_run_log_failed', attemptId: input.attemptId, error: String(error) })); }
  }
  /** Prepares a browser call; a refusal here, before anything reaches a browser, is in the recent runs. */
  async function prepare(call: Input) {
    const { input } = await replayed(call);
    try { return await prepareCall(input); }
    catch (error) { await record(input, Date.now(), { error: error instanceof Error ? error.message : String(error), refused: true }); throw error; }
  }
  /** Runs a browser call; how it ended is in the recent runs. A replay's result starts with the script it ran. */
  async function execute(call: Input): Promise<RuntimeToolResult> {
    const { input, preface } = await replayed(call);
    const startedAt = Date.now();
    let result: RuntimeToolResult;
    try { result = await executeCall(input); }
    catch (error) { await record(input, startedAt, { error: error instanceof Error ? error.message : String(error), refused: false }); throw error; }
    await record(input, startedAt, { result });
    return preface === null ? result : { ...result, content: [{ type: 'text', text: preface }, ...result.content] };
  }
  /** The workspace's live group on a browser (`cloud` or a pairing id): none until first use or after a revocation. */
  async function liveGroup(browser: string) {
    const groupId = z.string().uuid().optional().parse(await storage.get(`runtime.browser.account.group:${browser}`));
    return groupId && !await storage.get(`runtime.browser.revoked:${groupId}`) ? groupId : null;
  }
  /** The Inspector's Browser tab: approved sites (and the commit they were read at), the cloud browser's tabs, each
   * attached machine's headless browser, every Chrome confirmed on the account with this workspace's group there (its
   * colour, and who acts there while it is online), and the workspace's recent runs. Every tab says who holds it, the
   * agent or you (§7.2), and each Chrome whether its extension can be taken over from here. Only the main conversation
   * sees the user's Chromes and their names. Nothing here opens a browser; a machine that cannot answer shows why. */
  async function overview(conversationId: string): Promise<RuntimeBrowserOverview> {
    const conversation = await options.runtime().browserConversation(conversationId);
    const approved = await options.approvedSites();
    const cloudGroup = await liveGroup('cloud');
    const cloud = cloudGroup && env.BROWSER_SESSION ? await env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${identity.projectId}:${identity.workspaceId}`).overview() : { tabs: [], running: 0, held: [] };
    const machines = await Promise.all((await headlessMachines()).slice(0, 16).map(async (placement): Promise<RuntimeBrowserOverview['machines'][number]> => {
      try {
        const answer = machineOverview.parse(await control(conversationId, placement, { action: 'overview' }));
        // No one takes over a machine's headless browser: its tabs are always the agent's.
        return { machineId: placement.machineId, groupId: answer.groupId, tabs: answer.tabs.map((tab): RuntimeBrowserOverview['machines'][number]['tabs'][number] => ({ ...tab, addedBy: null, usable: true, holder: 'agent' })), error: null };
      } catch (error) {
        return { machineId: placement.machineId, groupId: null, tabs: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
      }
    }));
    const chromes: RuntimeBrowserOverview['chromes'] = [];
    const settings = conversation.root && env.RELAY ? await env.RELAY.getByName(env.RELAY_NAME).browserRelayProjectSettings(identity.projectId) : undefined;
    const powers = settings && env.RELAY && settings.browsers.some(browser => browser.approved) ? await env.RELAY.getByName(env.RELAY_NAME).browserRelayPowers(identity.projectId, identity.workspaceId) : [];
    if (settings) {
      const document = await workspaceBrowsersDocument(storage);
      for (const browser of settings.browsers) {
        // The newest report of the workspace's group on this Chrome, or the group before the Chrome has reported it.
        const row = document.chrome.find(group => group.pairingId === browser.pairingId);
        const groupId = row?.groupId ?? await liveGroup(browser.pairingId);
        const grant = !row && groupId ? await storage.get(`runtime.browser.account.grant:${groupId}`) : undefined;
        const held = row?.held ?? [];
        chromes.push({ pairingId: browser.pairingId, name: browser.name, note: browser.note, connected: browser.connected, approved: browser.approved, isDefault: browser.pairingId === settings.defaultPairingId,
          groupId, groupName: row?.groupName ?? (grant ? RuntimeAccountBrowserSignedGrantSchema.parse(grant).body.groupName : null), groupColor: row?.color ?? null, running: row?.running ?? 0,
          // An offline Chrome's last report may still list agents its extension no longer runs.
          agents: browser.connected ? row?.agents ?? [] : [],
          tabs: row?.tabs.map(tab => ({ targetId: tab.targetId, url: tab.url, title: tab.title, addedBy: tab.addedBy, usable: tab.usable, holder: held.some(item => item.targetId === tab.targetId) ? 'you' : 'agent' })) ?? [],
          held, takeover: browser.takeover, powers: browser.powers, powersSupported: browser.powersSupported, everything: powers.find(item => item.pairingId === browser.pairingId)?.everything ?? null });
      }
    }
    const runs = (await recentBrowserRuns(storage)).map(({ where, ...run }) => ({ ...run, where: where.kind === 'chrome' ? { kind: where.kind, name: settings?.browsers.find(browser => browser.pairingId === where.pairingId)?.name ?? null } : where }));
    return RuntimeBrowserOverviewSchema.parse({ sites: { origins: approved.sites.toSorted((a, b) => a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0), revision: approved.revision }, cloud: { groupId: cloudGroup, running: cloud.running, tabs: cloud.tabs.map(tab => ({ ...tab, addedBy: null, usable: true, holder: cloud.held.some(item => item.targetId === tab.targetId) ? 'you' : 'agent' })), held: cloud.held }, machines, chromes, runs });
  }
  /** One tab's preview on a machine's headless browser, captured there. A machine that is gone or cannot answer gets
   * no image and the reason, so the tile says why. */
  async function machinePreview(conversationId: string, grant: RuntimeBrowserGrant, targetId: string): Promise<RuntimeBrowserPreview> {
    const none = (reason: string): RuntimeBrowserPreview => ({ targetId, capturedAt: new Date().toISOString(), image: null, reason: reason.slice(0, 256) });
    const placement = (await headlessMachines()).find(item => item.machineId === grant.machineId);
    if (!placement) return none('This machine is not attached: attach it to see this tab');
    try { return RuntimeBrowserPreviewSchema.parse(await control(conversationId, placement, { action: 'preview', groupId: grant.groupId, targetId })); }
    catch (error) { return none(error instanceof Error ? error.message : String(error)); }
  }
  /** Captures (docs/APERTURE-DESIGN.md §11), by you from the Browser tab. A start goes to the browser its group names (a
   * machine's headless browser, the cloud browser or your Chrome); a stop goes where the capture's record says it is
   * recording. Either returns the capture with links to its files. */
  async function capture(conversationId: string, command: RuntimeBrowserManagement): Promise<RuntimeBrowserCaptureView> {
    const drive = options.drive();
    if (command.action === 'captureStart') {
      if (!command.groupId || !command.targetId) throw new Error('A capture names its group and tab');
      const request = { action: command.action, groupId: command.groupId, targetId: command.targetId, captureId: crypto.randomUUID() };
      const machine = await storage.get(`runtime.browser.grant:${command.groupId}`);
      return captureView(drive, machine ? await machineCapture(conversationId, RuntimeBrowserSignedGrantSchema.parse(machine).body, request) : await account.capture(conversationId, request));
    }
    if (!command.captureId) throw new Error('A capture stop names its capture');
    const current = await readCapture(drive, command.captureId);
    if (!current) throw new Error('Unknown capture');
    if (current.state !== 'recording') return captureView(drive, current);
    const groupId = current.target?.groupId;
    const machine = groupId && current.source === 'machine' ? await storage.get(`runtime.browser.grant:${groupId}`) : undefined;
    const stopped = !groupId || current.source === 'machine' && !machine
      ? await writeCapture(drive, { ...current, endedAt: new Date().toISOString(), state: 'failed', reason: 'The browser recording this capture is gone' })
      : machine ? await machineCapture(conversationId, RuntimeBrowserSignedGrantSchema.parse(machine).body, { action: 'captureStop', groupId, captureId: current.captureId }, current)
        : await account.capture(conversationId, { action: 'captureStop', groupId, captureId: current.captureId });
    return captureView(drive, stopped);
  }
  /** A capture on a machine's headless browser: the machine records the tab into its /tmp; at the stop each file moves
   * to the drive (`drive_transfer`) and the capture is saved. */
  async function machineCapture(conversationId: string, grant: RuntimeBrowserGrant, command: RuntimeBrowserManagement & { groupId: string; captureId: string }, current?: RuntimeBrowserCapture): Promise<RuntimeBrowserCapture> {
    const drive = options.drive(), placement = (await headlessMachines()).find(item => item.machineId === grant.machineId);
    if (!current) {
      if (!placement) throw new Error('This machine is not attached: attach it to record this tab');
      if (!command.targetId) throw new Error('A capture names its tab');
      const started = machineCaptureStarted.parse(await control(conversationId, placement, command));
      return writeCapture(drive, { version: 2, captureId: command.captureId, name: captureName(started.page.title, started.startedAt), by: 'you', source: 'machine', browser: `Headless browser on ${grant.machineId}`.slice(0, 128), target: { groupId: command.groupId, targetId: command.targetId }, page: { url: started.page.url.slice(0, 8192), title: started.page.title.slice(0, 500) }, startedAt: started.startedAt, endedAt: null, state: 'recording', reason: null, tracks: {} });
    }
    const failed = (reason: string) => writeCapture(drive, { ...current, endedAt: new Date().toISOString(), state: 'failed', reason: reason.slice(0, 1024) });
    if (!placement) return failed('The machine recording this capture is not attached');
    let stopped: z.infer<typeof machineCaptureStopped>;
    try { stopped = machineCaptureStopped.parse(await control(conversationId, placement, command)); }
    catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
    if (!stopped.count || !stopped.width || !stopped.height) return failed(stopped.reason ?? 'The tab showed nothing to record');
    try {
      for (const file of MACHINE_CAPTURE_FILES) {
        const machinePath = stopped.files[file];
        if (machinePath) await options.fromMachine({ conversationId, machineId: grant.machineId, machinePath, path: `${captureFolder(current.captureId)}${file}`, mediaType: CAPTURE_FILES[file] });
      }
    } catch (error) { return failed(`The recording did not reach the drive: ${error instanceof Error ? error.message : String(error)}`); }
    return writeCapture(drive, { ...current, endedAt: stopped.endedAt, state: 'saved', reason: stopped.reason, tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: stopped.count, width: stopped.width, height: stopped.height } } });
  }
  /** The Browser tab's comment threads, newest first, each with a sealed `/files/` link to its crop while the crop is in
   * the drive. */
  async function commentViews(command: RuntimeBrowserManagement): Promise<RuntimeBrowserCommentThreadView[]> {
    const drive = options.drive();
    const [threads, crops] = await Promise.all([
      workspaceCommentThreads(storage, { status: command.status ?? 'open', limit: Math.min(command.limit ?? COMMENT_THREADS_SHOWN, 500), ...(command.captureId ? { captureId: command.captureId } : {}) }),
      drive.list(COMMENT_CROPS),
    ]);
    const kept = new Set(crops.map(file => file.path));
    return Promise.all(threads.map(async thread => {
      const crop = thread.root.anchor?.cropFile;
      return { thread, cropUrl: crop !== undefined && kept.has(crop) ? await drive.url(crop) : null };
    }));
  }
  /** The workspace's group on one of your Chromes, made or renewed as the agent's `tabs` there does it; its id. Your
   * connecting a link or adding a tab is not a run of the agent's: it is not in the recent runs. */
  async function chromeGroup(conversationId: string, pairingId: string) {
    const id = crypto.randomUUID();
    const tabs: Input = { tool: 'browser', args: { action: 'tabs', source: 'relay', pairingId }, conversationId, taskId: id, requestId: id, attemptId: id, replay: 'unsafe' };
    const { groupId } = await prepareCall(tabs);
    const listed = await executeCall(tabs);
    if (listed.status !== 'completed') throw new Error(listed.status === 'failed' ? listed.error.message : 'Making this workspace’s group on that Chrome was interrupted');
    return groupId;
  }
  /** Share links on your Chromes (docs/APERTURE-DESIGN.md §8). A pasted share connects to the workspace's group on the
   * share's Chrome: where the workspace has none live, the group is made or renewed first (`chromeGroup`), and the
   * share connects to that group. */
  async function share(conversationId: string, command: RuntimeBrowserManagement) {
    if (command.action === 'shares') return RuntimeBrowserShareSchema.array().parse(await account.share(conversationId, command));
    if (command.action !== 'shareConnect') return RuntimeBrowserShareSchema.parse(await account.share(conversationId, command));
    const asked = ShareConnection.parse(await account.share(conversationId, command));
    if ('connected' in asked) return asked.connected;
    const groupId = await chromeGroup(conversationId, asked.needsGroup.pairingId);
    const connected = ShareConnection.parse(await account.share(conversationId, { ...command, groupId }));
    if ('needsGroup' in connected) throw new Error('That Chrome did not keep this workspace’s group; connect the link again');
    return connected.connected;
  }
  async function manage(conversationId: string, machineId: string | undefined, command: RuntimeBrowserManagement) {
    if (command.action === 'overview') return overview(conversationId);
    if (command.action === 'captures') return captureViews(options.drive());
    if (command.action === 'captureStart' || command.action === 'captureStop') return capture(conversationId, command);
    // Capture share links: kept by the relay, so they work with every Chrome offline.
    if (command.action === 'captureShares' || command.action === 'captureShareCreate' || command.action === 'captureShareRevoke') {
      if (!env.RELAY) throw new Error('Account relay unavailable');
      const relay = env.RELAY.getByName(env.RELAY_NAME);
      if (command.action === 'captureShares') return relay.browserCaptureShares(identity);
      if (command.action === 'captureShareRevoke') {
        if (!command.captureShareId) throw new Error('Ending a capture share names it');
        return relay.browserCaptureShareRevoke(identity, command.captureShareId);
      }
      if (!command.captureId || command.comment === undefined || command.expiresInMinutes === undefined) throw new Error('A capture share names its capture, comments and expiry');
      return relay.browserCaptureShareCreate(identity, { captureId: command.captureId, comment: command.comment, expiresInMinutes: command.expiresInMinutes });
    }
    // Everything (`browser-powers.ts`) for this workspace on one of your Chromes, from its Browser tab, which reads the
    // overview again.
    if (command.action === 'everything') {
      if (!command.pairingId || command.on === undefined) throw new Error('Everything names the Chrome and whether it begins or ends');
      if (!env.RELAY) throw new Error('Account Chrome relay unavailable');
      await env.RELAY.getByName(env.RELAY_NAME).browserRelayEverything(identity.projectId, identity.workspaceId, command.pairingId, command.on);
      return null;
    }
    // A tab you add to this workspace from your Chrome's popup goes into the workspace's group there.
    if (command.action === 'tabGroup') {
      if (!command.pairingId) throw new Error('Adding a tab names its Chrome');
      return chromeGroup(conversationId, command.pairingId);
    }
    if (command.action === 'comments') return commentViews(command);
    if (command.action === 'commentWrite') {
      if (!command.write) throw new Error('A comment change names what changes');
      const written = await writeWorkspaceComment(storage, command.write, { kind: 'person', name: (await options.comments.ownerName()).slice(0, 60).trim() || 'You', guest: false });
      await options.comments.announce(written);
      return written.thread;
    }
    if (command.action === 'stop' || command.action === 'closeTab' || command.action === 'focusTab' || command.action === 'takeOver' || command.action === 'resume') {
      if (!command.groupId) throw new Error('Stop, Close tab, Focus in Chrome, Take over and Resume agent name the group');
      await account.control(conversationId, { ...command, groupId: command.groupId });
      return null;
    }
    // Show on page: your Chrome's extension brings the tab forward with comment mode on and the thread open.
    if (command.action === 'commentShow') {
      if (!command.groupId || !command.targetId || !command.threadId) throw new Error('Show on page names the group, the tab and the thread');
      await account.control(conversationId, { ...command, groupId: command.groupId });
      return null;
    }
    if (command.action === 'shares' || command.action === 'shareCreate' || command.action === 'shareRevoke' || command.action === 'shareConnect') return share(conversationId, command);
    // A group names its browser: a machine's headless group is previewed on that machine, any other by the account.
    if (command.action === 'preview') {
      const stored = command.groupId ? await storage.get(`runtime.browser.grant:${command.groupId}`) : undefined;
      if (!stored) return account.manage(conversationId, command);
      if (!command.targetId) throw new Error('A preview names its group and tab');
      return machinePreview(conversationId, RuntimeBrowserSignedGrantSchema.parse(stored).body, command.targetId);
    }
    if (!machineId) return account.manage(conversationId, command);
    const placements = machineId ? [await eligible(machineId)] : await Promise.all([...new Set(options.runtime().attachments.list().filter(item => item.state === 'ready' && item.capabilities.some(cap => cap.startsWith('browser.'))).map(item => item.machineId))].map(id => eligible(id)));
    if (command.action !== 'status' && placements.length !== 1) throw new Error('Browser management requires an exact machine');
    if (command.action === 'revoke') {
      if (!command.groupId) throw new Error('Browser revoke requires group');
      const grant = RuntimeBrowserSignedGrantSchema.parse(await storage.get(`runtime.browser.grant:${command.groupId}`));
      if (grant.body.machineId !== machineId) throw new Error('Browser revoke machine mismatch');
      await storage.put(`runtime.browser.revoked:${command.groupId}`, true);
    }
    const results: unknown[] = [];
    for (const placement of placements) {
      const response = await control(conversationId, placement, command);
      if (command.action !== 'artifact') {
        const status = RuntimeBrowserStatusSchema.parse(response);
        for (const group of status.groups) {
          if ('placement' in group || group.projectId !== identity.projectId || group.workspaceId !== identity.workspaceId || group.machineId !== placement.machineId || group.attachmentId !== placement.attachmentId || group.generation !== placement.generation) throw new Error('Browser status group placement mismatch');
          if (group.state !== 'revoked' && group.state !== 'expired' && group.state !== 'closed') continue;
          await storage.transaction(async tx => {
            const stored = await tx.get(`runtime.browser.grant:${group.groupId}`);
            if (!stored) return;
            const grant = RuntimeBrowserSignedGrantSchema.parse(stored).body;
            if (canonicalBrowserAuthorization(grant) !== canonicalBrowserAuthorization(RuntimeBrowserGrantSchema.strip().parse(group))) return;
            await tx.put(`runtime.browser.revoked:${group.groupId}`, true);
          });
        }
      }
      results.push(response);
    }
    if (command.action === 'artifact') return RuntimeBrowserArtifactPageSchema.parse(results[0]);
    const statuses = results.map(value => RuntimeBrowserStatusSchema.parse(value));
    return RuntimeBrowserStatusSchema.parse({ groups: statuses.flatMap(item => item.groups).slice(0, 200), records: statuses.flatMap(item => item.records).slice(0, 200) });
  }
  /** ask_takeover's tab (docs/APERTURE-DESIGN.md §7.2): a tab of the workspace's group on your Chrome or on the cloud
   * browser, as its card names it, and who holds it now. A machine's headless browser cannot be taken over: no one
   * steps in there, and agents drive it with Playwright. A Chrome must be online with an extension that can hand a tab
   * over (5.10 and later). */
  async function takeoverTab(input: Parameters<ToolServices['takeoverTab']>[0]): Promise<RuntimeTakeoverTab> {
    const { args } = input;
    if (!(await options.runtime().browserConversation(input.conversationId)).root) throw new Error('Only the main agent asks the user to take over a tab.');
    if (args.source === 'headless') {
      const groupId = await liveGroup('cloud');
      const cloud = groupId && env.BROWSER_SESSION ? await env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${identity.projectId}:${identity.workspaceId}`).overview() : null;
      const tab = cloud?.tabs.find(item => item.targetId === args.targetId);
      if (!groupId || !cloud || !tab) throw new Error((await headlessMachines()).length ? `The cloud browser has no tab ${args.targetId}. Tabs of a machine's headless browser cannot be taken over: open the page on the cloud browser (web_browser without on, or source "relay" on the user's Chrome) and ask for that tab.` : `The cloud browser has no tab ${args.targetId}: web_browser tabs lists its tabs.`);
      return { source: 'cloud', pairingId: null, browser: 'Cloud browser', groupId, targetId: tab.targetId, url: tab.url, title: tab.title, holder: cloud.held.some(item => item.targetId === tab.targetId) ? 'you' : 'agent' };
    }
    if (!env.RELAY) throw new Error('Account Chrome relay unavailable');
    const settings = await env.RELAY.getByName(env.RELAY_NAME).browserRelayProjectSettings(identity.projectId);
    const approved = settings.browsers.filter(browser => browser.approved);
    // The Chrome the browser tool would use: the one named, else the project's default, else its only approved one.
    const browser = args.pairingId ? settings.browsers.find(item => item.pairingId === args.pairingId) : settings.browsers.find(item => item.pairingId === settings.defaultPairingId) ?? (approved.length === 1 ? approved[0] : undefined);
    if (!browser) throw new Error(args.pairingId ? 'No Chrome with that pairingId is paired with this account: web_browser chromes lists them.' : 'This project has no default Chrome: pass the pairingId of the Chrome with the tab (web_browser chromes lists them).');
    if (!browser.approved) throw new Error(`Chrome "${browser.name}" is not approved for this project.`);
    if (!browser.connected) throw new Error(`Chrome "${browser.name}" is offline: the user can take over its tabs only while it is online.`);
    if (!browser.takeover) throw new Error(`The GitSpace extension on Chrome "${browser.name}" cannot hand a tab to the user: ask the user to update the extension (5.10 or later), then ask again.`);
    const row = (await workspaceBrowsersDocument(storage)).chrome.find(group => group.pairingId === browser.pairingId);
    const tab = row?.tabs.find(item => item.targetId === args.targetId);
    if (!row || !tab) throw new Error(`The workspace's group on Chrome "${browser.name}" has no tab ${args.targetId}: web_browser tabs lists its tabs.`);
    return { source: 'chrome', pairingId: browser.pairingId, browser: browser.name, groupId: row.groupId, targetId: tab.targetId, url: tab.url, title: tab.title, holder: row.held.some(item => item.targetId === tab.targetId) ? 'you' : 'agent' };
  }
  return { prepare, execute, manage, takeoverTab, waitForHandback: (target, signal) => waitForHandback(identity.workspaceId, target, async () => await holder(target) !== undefined, signal) };
}
