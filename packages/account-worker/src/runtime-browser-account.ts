import { z } from 'zod';
import { RuntimeAccountBrowserPreparationSchema, RuntimeAccountBrowserGrantSchema, RuntimeAccountBrowserSignedGrantSchema, RuntimeAccountBrowserAuthorizationSchema, canonicalBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserPlacement, type RuntimeBrowserAuthorityCertificate, type RuntimeBrowserArguments, type RuntimeAccountBrowserAuthorization, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { ToolServices } from '@gitspace/runtime-core';
import type { RuntimeBrowserAuthorityOptions } from './runtime-browser.js';
import { AccountBrowserRuntime } from './browser-runtime.js';

import { RuntimeBrowserStatusSchema, RuntimeBrowserArtifactPageSchema, type RuntimeBrowserManagement } from '@gitspace/protocol-runtime';
type Input = Parameters<ToolServices['invoke']>[0] & { parentAttemptId?: string };
export function createAccountBrowserAuthority(options: RuntimeBrowserAuthorityOptions, signing: () => Promise<{ privateKey: CryptoKey; authority: RuntimeBrowserAuthorityCertificate; issuedAt: string }>) {
  const { storage, env, identity } = options;
  const savedSchema = z.object({ fingerprint: z.string(), card: RuntimeAccountBrowserPreparationSchema });
  const cloud = new AccountBrowserRuntime({ storage, binding: env.BROWSER, serviceFetch: options.serviceFetch, serviceHostname: options.serviceHostname, workspaceServiceHostname: options.workspaceServiceHostname });
  async function placement(args: RuntimeBrowserArguments): Promise<RuntimeAccountBrowserPlacement> {
    if (args.source === 'headless') { if (args.pairingId) throw new Error('Chrome pairing requires relay source'); return { kind: 'cloud', accountId: env.ACCOUNT_ID }; }
    if (!env.RELAY) throw new Error('Account Chrome relay unavailable');
    return env.RELAY.getByName(env.RELAY_NAME).browserRelayPlacement(identity.projectId, args.pairingId);
  }
  async function prepare(input: Input, args: RuntimeBrowserArguments, origins: string[]) {
    const fingerprint = canonicalBrowserAuthorization({ ...input, signal: undefined, args });
    const key = `runtime.browser.prepare:${input.attemptId}`;
    const current = await placement(args);
    const prior = await storage.get(key);
    if (prior) { const saved = savedSchema.parse(prior); if (saved.fingerprint !== fingerprint) throw new Error('Browser attempt identity reused'); if (await storage.get(`runtime.browser.revoked:${saved.card.groupId}`)) throw new Error('Browser group revoked'); if (canonicalBrowserAuthorization(saved.card.placement) !== canonicalBrowserAuthorization(current)) throw new Error('Browser placement changed'); return saved.card; }
    const groupKey = `runtime.browser.account.group:${current.kind === 'account-relay' ? current.pairingId : 'cloud'}`;
    const group = await storage.transaction(async tx => {
      const groupId = z.string().uuid().optional().parse(await tx.get(groupKey));
      const stored = groupId ? await tx.get(`runtime.browser.account.grant:${groupId}`) : undefined;
      const grant = stored ? RuntimeAccountBrowserSignedGrantSchema.parse(stored).body : undefined;
      if (groupId && !await tx.get(`runtime.browser.revoked:${groupId}`) && (!grant || Date.parse(grant.expiresAt) > Date.now() && canonicalBrowserAuthorization(grant.placement) === canonicalBrowserAuthorization(current))) return { groupId, grant };
      if (groupId) await tx.put(`runtime.browser.revoked:${groupId}`, true);
      const created = crypto.randomUUID(); await tx.put(groupKey, created); return { groupId: created, grant: undefined };
    });
    const card = RuntimeAccountBrowserPreparationSchema.parse({ ...identity, placement: current, groupId: group.groupId, groupName: await options.groupName(), source: args.source, origins, expiresAt: group.grant?.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(), id: crypto.randomUUID(), action: args.action, requiresApproval: false });
    return storage.transaction(async tx => { const prior = await tx.get(key); if (prior) { const saved = savedSchema.parse(prior); if (saved.fingerprint !== fingerprint) throw new Error('Browser attempt identity reused'); return saved.card; } await tx.put(key, { fingerprint, card }); return card; });
  }
  async function execute(input: Input, args: RuntimeBrowserArguments, origins: string[]): Promise<RuntimeToolResult> {
    const saved = savedSchema.parse(await storage.get(`runtime.browser.prepare:${input.attemptId}`));
    if (saved.fingerprint !== canonicalBrowserAuthorization({ ...input, signal: undefined, args })) throw new Error('Browser dispatch differs from preparation');
    const { card } = saved;
    if (Date.parse(card.expiresAt) <= Date.now() || await storage.get(`runtime.browser.revoked:${card.groupId}`)) throw new Error('Browser group expired or revoked');
    if (canonicalBrowserAuthorization(origins) !== canonicalBrowserAuthorization(card.origins)) throw new Error('Approved environment browser origins changed');
    if (canonicalBrowserAuthorization(card.placement) !== canonicalBrowserAuthorization(await placement(args))) throw new Error('Browser placement changed');
    const body = RuntimeAccountBrowserGrantSchema.strip().parse(card);
    const signingKey = await signing();
    const grantKey = `runtime.browser.account.grant:${body.groupId}`;
    const prior = await storage.get(grantKey);
    let grant = prior ? RuntimeAccountBrowserSignedGrantSchema.parse(prior) : undefined;
    if (!grant || canonicalBrowserAuthorization(grant.body) !== canonicalBrowserAuthorization(body)) { grant = await signRuntimeAccountBrowserGrant(body, signingKey.privateKey, signingKey.authority); await storage.put(grantKey, grant); }
    const deadlineAt = new Date(Math.min(Date.parse(body.expiresAt), Date.now() + 60_000)).toISOString();
    const conversation = await options.runtime().browserConversation(input.conversationId);
    const dispatchKey = `runtime.browser.account.dispatch:${input.attemptId}`;
    const stored = await storage.get(dispatchKey);
    const authorization = stored ? RuntimeAccountBrowserAuthorizationSchema.parse(stored) : await signRuntimeAccountBrowserAuthorization({ scope: { ...identity, placement: body.placement, conversationId: input.conversationId, conversationKind: conversation.root ? 'main' : 'subagent', taskId: input.taskId, requestId: input.requestId, attemptId: input.attemptId }, issuedAt: signingKey.issuedAt, expiresAt: deadlineAt, dispatch: { version: 1, tool: 'browser', deadlineAt, replay: input.replay, ...(input.parentAttemptId ? { parentAttemptId: input.parentAttemptId } : {}) }, command: { type: 'execute', args, grant } }, signingKey.privateKey, signingKey.authority);
    if (!stored) await storage.put(dispatchKey, authorization);
    return dispatch(authorization, input.signal);
  }
  async function dispatch(authorization: RuntimeAccountBrowserAuthorization, signal?: AbortSignal) {
    if (authorization.body.scope.placement.kind === 'cloud') return cloud.execute(authorization, signal ?? AbortSignal.timeout(Math.max(1, Date.parse(authorization.body.expiresAt) - Date.now())));
    if (!env.RELAY) throw new Error('Account Chrome relay unavailable');
    return env.RELAY.getByName(env.RELAY_NAME).browserRelayExecute(authorization);
  }
  async function manage(conversationId: string, command: RuntimeBrowserManagement) {
    const placements: RuntimeAccountBrowserPlacement[] = [];
    const conversation = await options.runtime().browserConversation(conversationId);
    const relay = conversation.root ? env.RELAY?.getByName(env.RELAY_NAME) : undefined;
    const settings = relay ? await relay.browserRelayProjectSettings(identity.projectId) : undefined;
    if (command.groupId) {
      const stored = await storage.get(`runtime.browser.account.grant:${command.groupId}`);
      if (!stored) throw new Error('Account browser group unavailable');
      const grant = RuntimeAccountBrowserSignedGrantSchema.parse(stored).body;
      placements.push(grant.placement);
      if (command.action === 'revoke') await storage.put(`runtime.browser.revoked:${grant.groupId}`, true);
    } else {
      placements.push({ kind: 'cloud', accountId: env.ACCOUNT_ID });
      if (relay) for (const browser of settings?.browsers ?? []) if (browser.approved && browser.connected) placements.push(await relay.browserRelayPlacement(identity.projectId, browser.pairingId));
    }
    const statuses: z.infer<typeof RuntimeBrowserStatusSchema>[] = [];
    for (const placement of placements) {
      if (placement.kind === 'account-relay' && !conversation.root) throw new Error('Logged-in Chrome relay is main-agent-only');
      const id = crypto.randomUUID(), deadlineAt = new Date(Date.now() + 60_000).toISOString();
      const signer = await signing();
      const authorization = await signRuntimeAccountBrowserAuthorization({ scope: { ...identity, placement, conversationId, conversationKind: conversation.root ? 'main' : 'subagent', taskId: id, requestId: id, attemptId: id }, issuedAt: signer.issuedAt, expiresAt: deadlineAt, dispatch: { version: 1, tool: 'browser_control', deadlineAt, replay: 'unsafe' }, command: { type: 'manage', ...command } }, signer.privateKey, signer.authority);
      const response = await dispatch(authorization);
      const text = response.content.find(part => part.type === 'text');
      if (response.status !== 'completed' || !text || text.type !== 'text') throw new Error('Account browser management failed');
      const value: unknown = JSON.parse(text.text);
      if (command.action === 'artifact') return RuntimeBrowserArtifactPageSchema.parse(value);
      statuses.push(RuntimeBrowserStatusSchema.parse(value));
    }
    return RuntimeBrowserStatusSchema.parse({ groups: statuses.flatMap(status => status.groups), records: statuses.flatMap(status => status.records), browsers: settings?.browsers.filter(browser => browser.approved) ?? [] });
  }
  return { prepare, execute, dispatch, manage };
}
