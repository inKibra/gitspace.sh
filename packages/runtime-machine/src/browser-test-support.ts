import { RuntimeToolDispatchSchema, RuntimeBrowserArgumentsSchema, RuntimeBrowserGrantSchema, signRuntimeBrowserAuthorization, signRuntimeBrowserGrant, signRuntimeBrowserAuthorityCertificate, browserBase64, verifyRuntimeBrowserAuthorization, type RuntimeBrowserAuthorizationBody, type RuntimeBrowserGrant, type RuntimeBrowserSignedGrant, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import type { MachineBrowser } from './browser.js';
import type { LocalAttachment } from './journal.js';
import type { ExecutorContent } from './tools.js';

export interface BrowserTestAuthority {
  grant(body: RuntimeBrowserGrant): Promise<RuntimeBrowserSignedGrant>;
  verifyAuthorization(authorization: unknown, dispatch: RuntimeToolDispatch): Promise<RuntimeBrowserAuthorizationBody>;
  dispatch(args: unknown, command: RuntimeBrowserAuthorizationBody['command'], workspaceId?: string, conversationId?: string): Promise<RuntimeToolDispatch>;
}
export function browserText(content: ExecutorContent) { return JSON.parse(content[0]?.type === 'text' ? content[0].text : 'null'); }
export async function browserTestAuthority(): Promise<BrowserTestAuthority> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const root = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return {
    async grant(body) {
      const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: 'account', projectId: body.projectId, workspaceId: body.workspaceId, publicKey, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }, root.privateKey);
      return signRuntimeBrowserGrant(body, pair.privateKey, authority);
    },
    verifyAuthorization: (authorization: unknown, dispatch: RuntimeToolDispatch) => verifyRuntimeBrowserAuthorization(authorization, dispatch, root.publicKey),
    async dispatch(args: unknown, command: RuntimeBrowserAuthorizationBody['command'], workspaceId = 'workspace', conversationId = 'conversation') {
      const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, projectId: 'project', workspaceId, conversationId, machineId: 'machine', attachmentId: 'attachment', generation: 1, taskId: crypto.randomUUID(), requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), tool: command.type === 'execute' ? 'browser' : 'browser_control', args, replay: 'unsafe', deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      const { projectId, machineId, attachmentId, generation, taskId, requestId, attemptId, version, tool, deadlineAt, replay } = dispatch;
      const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: 'account', projectId, workspaceId, publicKey, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }, root.privateKey);
      dispatch.browserAuthorization = await signRuntimeBrowserAuthorization({ scope: { projectId, workspaceId, conversationId, machineId, attachmentId, generation, taskId, requestId, attemptId }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 25_000).toISOString(), dispatch: { version, tool: tool === 'browser' ? 'browser' : 'browser_control', deadlineAt, replay }, command }, pair.privateKey, authority);
      return dispatch;
    },
  };
}
export function browserInvoker(browser: MachineBrowser, authority: BrowserTestAuthority, local: LocalAttachment, workspaceId = 'workspace') {
  const grants = new Map<string, RuntimeBrowserSignedGrant>();
  return async (input: unknown, conversationId = 'conversation') => {
    const args = RuntimeBrowserArgumentsSchema.parse(input);
    let grant = grants.get(args.source);
    if (!grant) {
      const groupId = crypto.randomUUID();
      const prepared = browserText(await browser.execute(await authority.dispatch(args, { type: 'prepare', args, groupId }, workspaceId, conversationId), local, AbortSignal.timeout(30_000)));
      const { id: _id, action: _action, requiresApproval: _requiresApproval, ...fields } = prepared;
      const body = RuntimeBrowserGrantSchema.parse({ ...fields, origins: args.source === 'relay' ? ['fixture.test'] : [] });
      grant = await authority.grant(body); grants.set(args.source, grant);
    }
    return browser.execute(await authority.dispatch(args, { type: 'execute', args, grant }, workspaceId, conversationId), local, AbortSignal.timeout(30_000));
  };
}
