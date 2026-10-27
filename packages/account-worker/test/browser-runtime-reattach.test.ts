import { expect, test } from 'vitest';
import { RuntimeAccountBrowserAuthorizationSchema } from '@gitspace/protocol-runtime';
import { AccountBrowserRuntime, type AccountBrowserTransport } from '../src/browser-runtime.js';

test('a tab on your Chrome whose channel the extension ended (a script on it finished) is attached again by its next step', async () => {
  const values = new Map<string, unknown>();
  const storage = { async get(key: string) { return values.get(key); }, async put(key: string, value: unknown) { values.set(key, value); }, async delete(key: string) { return values.delete(key); } };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const placement = { kind: 'account-relay', accountId: 'account', pairingId: crypto.randomUUID(), generation: 1, approvalId: crypto.randomUUID() };
  const authority = { body: { accountId: 'account', projectId: 'project', workspaceId: 'workspace', publicKey: 'AA==', issuedAt: new Date().toISOString(), expiresAt }, signature: 'AA==' };
  const grant = { body: { projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['dash.example'], expiresAt }, signature: 'AA==', authority };
  const step = (attemptId: string) => RuntimeAccountBrowserAuthorizationSchema.parse({ body: { scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'evaluate', source: 'relay', targetId: 'your-tab', expression: 'document.title' }, grant } }, signature: 'AA==', authority });
  // Like the extension: each attach is a new channel with its own session, and only the current one is served.
  let current = '', attaches = 0;
  const ended: (() => void)[] = [];
  const relay: Pick<AccountBrowserTransport, 'open'> = {
    async open() {
      const session = `session-${++attaches}`;
      return { targetId: 'your-tab', channel: {
        async send(method: string, _params?: Record<string, unknown>, sessionId?: string) {
          if (method === 'Target.attachToTarget') { current = session; return { sessionId: session }; }
          if (sessionId !== current) throw new Error('Command outside browser grant');
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: 'https://dash.example/' } } };
          if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'Dashboard' } };
          return {};
        },
        subscribe(listener) { ended.push(() => listener({ method: 'disconnected' })); return () => {}; },
        async close() {},
      } };
    },
  };
  const runtime = new AccountBrowserRuntime({ storage, relay: { ...relay, tabs: async () => [], preview: async () => ({ image: null, reason: null }), capture: async () => { throw new Error('unused'); }, revoke: async () => {}, control: async () => ({}), shares: async () => [], shareCreate: async () => { throw new Error('unused'); }, shareRevoke: async () => { throw new Error('unused'); }, shareConnect: async () => { throw new Error('unused'); } } });
  expect(await runtime.execute(step('first'), AbortSignal.timeout(5000))).toMatchObject({ status: 'completed' });
  // A script on the tab ends; the extension ends the tab's channel and says so.
  for (const end of ended.splice(0)) end();
  expect(await runtime.execute(step('after-script'), AbortSignal.timeout(5000))).toMatchObject({ status: 'completed', content: [{ type: 'text', text: expect.stringContaining('Dashboard') }] });
  expect(current).toBe('session-2');
});
