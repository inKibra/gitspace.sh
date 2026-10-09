import type { BrowserWorkspaceServiceHostname } from '@gitspace/runtime-machine/browser-service-policy';
import type { ToolServices } from '@gitspace/runtime-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { browserOriginMatches } from '@gitspace/protocol-environment';
import { RuntimeBrowserArgumentsSchema, RuntimeBrowserApprovalCardSchema, RuntimeBrowserGrantSchema, RuntimeBrowserSignedGrantSchema, RuntimeToolDispatchSchema, RuntimeBrowserStatusSchema, RuntimeBrowserArtifactPageSchema, browserBase64, canonicalBrowserAuthorization, signRuntimeBrowserAuthorization, signRuntimeBrowserGrant, type RuntimeBrowserAuthorizationBody, type RuntimeBrowserManagement, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import type { RuntimeAttachment, RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import type { WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import { committedSessionApproval, sessionApprovalMode, type SessionControlServices } from '@gitspace/runtime-core/session-controls';
import type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';
import type { AccountStateDO } from './account-state.js';
import type { CredentialVaultDO } from './application.js';
import { createAccountBrowserAuthority } from './runtime-browser-account.js';
import type { BrowserRenderingBinding } from './browser-cdp.js';
import type { RuntimeAccountBrowserAuthorization, RuntimeAccountBrowserPlacement } from '@gitspace/protocol-runtime';
export interface RuntimeBrowserAuthority {
  prepare: ToolServices['prepareBrowser'];
  execute: ToolServices['invoke'];
  manage: NonNullable<SessionControlServices['browser']>;
}
type Input = Parameters<ToolServices['invoke']>[0] & { parentAttemptId?: string };
const savedPreparation = z.object({ fingerprint: z.string(), card: RuntimeBrowserApprovalCardSchema });
type BrowserStorageTransaction = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
type BrowserStorage = BrowserStorageTransaction & { delete(key: string): Promise<boolean>; transaction<T>(callback: (tx: BrowserStorageTransaction) => Promise<T>): Promise<T> };
type BrowserEnvironment = {
  ACCOUNT_ID: Env['ACCOUNT_ID'];
  RELAY_NAME: Env['RELAY_NAME'];
  ACCOUNT_STATE: { getByName(name: string): Pick<AccountStateDO, 'certifyBrowserAuthority'> };
  FLEET_CATALOG: { getByName(name: string): { getMachine(id: string): Promise<Pick<FleetMachineDefinition, 'kind' | 'desiredState'> | null> } };
  CREDENTIALS: { getByName(name: string): Pick<DurableObjectStub<CredentialVaultDO>, 'hasRuntimeMachine'> };
  BROWSER?: BrowserRenderingBinding;
  RELAY?: { getByName(name: string): { browserRelayPlacement(projectId: string, pairingId?: string): Promise<RuntimeAccountBrowserPlacement>; browserRelayProjectSettings(projectId: string): Promise<RuntimeProjectBrowserSettings>; browserRelayExecute(authorization: RuntimeAccountBrowserAuthorization): Promise<RuntimeToolResult> } };
};
type BrowserRuntime = Pick<WorkspaceRuntime, 'harness' | 'browserConversation'> & { attachments: Pick<WorkspaceRuntime['attachments'], 'list' | 'execute'> };
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
export type RuntimeBrowserAuthorityOptions = { storage: BrowserStorage; env: BrowserEnvironment; identity: { projectId: string; workspaceId: string }; runtime(): BrowserRuntime; selectExecution(args: RuntimeBrowserArguments, candidates: RuntimeAttachment[]): Promise<RuntimeAttachment>; approvedOrigins(): Promise<string[]>; approvalDefault: ToolServices['approvalDefault']; groupName(): Promise<string>; serviceFetch?: (request: Request) => Promise<Response>; serviceHostname?: (hostname: string) => boolean; workspaceServiceHostname?: BrowserWorkspaceServiceHostname };
export function createRuntimeBrowserAuthority(options: RuntimeBrowserAuthorityOptions): RuntimeBrowserAuthority {
  const { storage, env, identity } = options;
  async function eligible(machineId: string) {
    for (const attachment of options.runtime().attachments.list()) {
      if (attachment.machineId !== machineId || attachment.state !== 'ready' || !attachment.heartbeatAt || Date.now() - Date.parse(attachment.heartbeatAt) > 30_000) continue;
      const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(attachment.machineId);
      if (!machine || machine.desiredState === 'removed' || !await env.CREDENTIALS.getByName(env.ACCOUNT_ID).hasRuntimeMachine(attachment.machineId)) continue;
      return attachment;
    }
    throw new Error('No eligible browser executor is ready');
  }
  async function execution(args: RuntimeBrowserArguments) {
    const candidates: RuntimeAttachment[] = [];
    for (const attachment of options.runtime().attachments.list()) {
      if (attachment.state !== 'ready' || attachment.role !== 'cache' || !attachment.heartbeatAt || Date.now() - Date.parse(attachment.heartbeatAt) > 30_000 || !attachment.capabilities.includes(`browser.${args.source}`)) continue;
      const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(attachment.machineId);
      if (!machine || machine.desiredState === 'removed' || args.source === 'relay' && machine.kind !== 'physical' || !await env.CREDENTIALS.getByName(env.ACCOUNT_ID).hasRuntimeMachine(attachment.machineId)) continue;
      candidates.push(attachment);
    }
    if (!candidates.length) throw new Error(args.source === 'relay' ? 'No eligible user-owned physical browser machine is ready' : 'No eligible browser executor is ready');
    return options.selectExecution(args, candidates);
  }
  async function signing() {
    const { privateKey, publicKey } = await runtimeBrowserKey(storage);
    const issuedAt = new Date().toISOString();
    const authority = await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).certifyBrowserAuthority({ accountId: env.ACCOUNT_ID, ...identity, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))), issuedAt, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    return { privateKey, authority, issuedAt };
  }
  const account = createAccountBrowserAuthority(options, signing);
  function accountPlacement(args: RuntimeBrowserArguments) {
    return args.source === 'relay' || !args.on && !options.runtime().attachments.list().some(item => item.state === 'ready' && item.capabilities.includes('browser.headless'));
  }
  async function signed(input: Input, placement: { machineId: string; attachmentId: string; generation: number }, command: RuntimeBrowserAuthorizationBody['command'], expiresAt: string): Promise<RuntimeToolDispatch> {
    const scope = { ...identity, machineId: placement.machineId, attachmentId: placement.attachmentId, generation: placement.generation, conversationId: input.conversationId, taskId: input.taskId, requestId: input.requestId, attemptId: input.attemptId };
    const conversation = await options.runtime().browserConversation(input.conversationId);
    const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, ...scope, conversationKind: conversation.root ? 'main' : 'subagent', ...(input.parentAttemptId ? { parentAttemptId: input.parentAttemptId } : {}), tool: command.type === 'execute' ? 'browser' : 'browser_control', args: input.args, deadlineAt: expiresAt, replay: input.replay });
    const { privateKey, authority, issuedAt } = await signing();
    dispatch.browserAuthorization = await signRuntimeBrowserAuthorization({ scope, issuedAt, expiresAt, dispatch: { version: 1, tool: command.type === 'execute' ? 'browser' : 'browser_control', deadlineAt: expiresAt, replay: input.replay, ...(input.parentAttemptId ? { parentAttemptId: input.parentAttemptId } : {}) }, command }, privateKey, authority);
    return dispatch;
  }
  async function context(input: Input) {
    const conversation = await options.runtime().browserConversation(input.conversationId);
    const args = RuntimeBrowserArgumentsSchema.parse(input.args);
    if (args.source === 'relay' && !conversation.root) throw new Error('Logged-in Chrome relay is main-agent-only. Subagents must use source:"headless".');
    const origins = args.source === 'relay' ? [...new Set(await options.approvedOrigins())].sort() : [];
    if (args.source === 'relay') {
      const url = args.action === 'navigate' || args.action === 'open' ? args.url : undefined;
      if (!origins.length || url && !origins.some(pattern => browserOriginMatches(pattern, new URL(url).hostname))) throw new Error('Browser origin is not approved. Propose adding the required hostname to browser.origins in .gitspace/bundle.json, commit the environment definition, and ask the user to approve that origin in Environment. Yolo never approves environment changes.');
    }
    return { conversation, args, origins };
  }
  async function prepare(input: Input) {
    const { conversation, args, origins } = await context(input);
    if (accountPlacement(args)) return account.prepare(input, args, origins);
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
    const approvalMode = await sessionApprovalMode(options.runtime().harness, conversation.id, BACKGROUND_CONTEXT, options.approvalDefault);
    const card = RuntimeBrowserApprovalCardSchema.parse({ ...identity, machineId: placement.machineId, attachmentId: placement.attachmentId, generation: placement.generation, groupId, groupName: await options.groupName(), source: args.source, origins, expiresAt: grant?.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(), id: crypto.randomUUID(), action: args.action, requiresApproval: args.source === 'relay' && !grant && approvalMode !== 'yolo' });
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
  async function execute(input: Input): Promise<RuntimeToolResult> {
    const { args, origins } = await context(input);
    if (accountPlacement(args)) return account.execute(input, args, origins);
    const saved = savedPreparation.parse(await storage.get(`runtime.browser.prepare:${input.attemptId}`));
    if (saved.fingerprint !== canonicalBrowserAuthorization({ ...input, signal: undefined, args })) throw new Error('Browser dispatch differs from preparation');
    const card = saved.card;
    if ('placement' in card) throw new Error('Browser placement changed');
    if (Date.parse(card.expiresAt) <= Date.now() || await storage.get(`runtime.browser.revoked:${card.groupId}`)) throw new Error('Browser group grant expired or revoked');
    if (canonicalBrowserAuthorization(origins) !== canonicalBrowserAuthorization(card.origins)) throw new Error('Approved environment browser origins changed; prepare a new browser request.');
    if (card.requiresApproval) {
      const question = await committedSessionApproval(options.runtime().harness, input.conversationId, input.taskId);
      if (question?.answer !== true || canonicalBrowserAuthorization(question.browser) !== canonicalBrowserAuthorization(card)) throw new Error('Committed human browser group approval required');
    }
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
    return options.runtime().attachments.execute(dispatch, input.signal ?? AbortSignal.timeout(Math.max(1, Date.parse(dispatch.deadlineAt) - Date.now())));
  }
  async function manage(conversationId: string, machineId: string | undefined, command: RuntimeBrowserManagement) {
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
      const id = crypto.randomUUID();
      const dispatch = await signed({ tool: 'browser_control', args: command, conversationId, taskId: id, requestId: id, attemptId: id, replay: 'unsafe' }, placement, { type: 'manage', ...command }, new Date(Date.now() + 60_000).toISOString());
      const result = await options.runtime().attachments.execute(dispatch, AbortSignal.timeout(60_000));
      if (result.status !== 'completed') throw new Error(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
      const text = result.content.find(part => part.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Browser returned no structured response');
      const response: unknown = JSON.parse(text.text);
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
  return { prepare, execute, manage };
}
