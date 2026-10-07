import { expect, test } from 'vitest';
import { RuntimeAccountBrowserAuthorizationSchema } from '@gitspace/protocol-runtime';
import { AccountBrowserRuntime } from '../src/browser-runtime.js';

test('group can be revoked after runtime restart and its grant cannot be reused', async () => {
  const values = new Map<string, unknown>();
  const storage = { async get(key: string) { return values.get(key); }, async put(key: string, value: unknown) { values.set(key, value); }, async delete(key: string) { return values.delete(key); } };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const placement = { kind: 'cloud', accountId: 'account' };
  const authority = { body: { accountId: 'account', projectId: 'project', workspaceId: 'workspace', publicKey: 'AA==', issuedAt: new Date().toISOString(), expiresAt }, signature: 'AA==' };
  const groupId = crypto.randomUUID();
  const body = { scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: 'first' }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' } };
  const grant = { body: { projectId: 'project', workspaceId: 'workspace', placement, groupId, groupName: 'Workspace', source: 'headless', origins: ['example.com'], expiresAt }, signature: 'AA==', authority };
  const execute = RuntimeAccountBrowserAuthorizationSchema.parse({ body: { ...body, command: { type: 'execute', args: { action: 'tabs', source: 'headless' }, grant } }, signature: 'AA==', authority });
  await new AccountBrowserRuntime({ storage }).execute(execute, AbortSignal.timeout(5000));
  const restarted = new AccountBrowserRuntime({ storage });
  const status = RuntimeAccountBrowserAuthorizationSchema.parse({ body: { ...body, scope: { ...body.scope, attemptId: 'status' }, command: { type: 'manage', action: 'status' } }, signature: 'AA==', authority });
  expect(JSON.stringify(await restarted.execute(status, AbortSignal.timeout(5000)))).toContain(groupId);
  const revoke = RuntimeAccountBrowserAuthorizationSchema.parse({ body: { ...body, scope: { ...body.scope, attemptId: 'revoke' }, command: { type: 'manage', action: 'revoke', groupId } }, signature: 'AA==', authority });
  expect((await restarted.execute(revoke, AbortSignal.timeout(5000))).status).toBe('completed');
  const reused = RuntimeAccountBrowserAuthorizationSchema.parse({ ...execute, body: { ...execute.body, scope: { ...execute.body.scope, attemptId: 'reuse' } } });
  await expect(new AccountBrowserRuntime({ storage }).execute(reused, AbortSignal.timeout(5000))).rejects.toThrow('revoked');
});
