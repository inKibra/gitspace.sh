import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { RuntimeAccountBrowserAuthorizationSchema } from '@gitspace/protocol-runtime';
import type { BrowserChannel } from '../src/browser-cdp.js';
import { CdpBrowserShim } from '../src/browser-shim.js';
import type { BrowserSessionDO } from '../src/browser-session.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { BROWSER_TAB_HELD } from '../src/browser-takeover.js';

afterEach(() => { vi.restoreAllMocks(); });

const Reply = z.object({ id: z.number(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() });
/** The cloud browser as Browser Run answers: two pages, one of which the user takes over, and a page outline. */
function cloudBrowser() {
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const pages = [{ targetId: 'form-tab', type: 'page', url: 'https://example.com/form', title: 'Form' }, { targetId: 'other-tab', type: 'page', url: 'https://example.com/', title: 'Example' }];
  const upstream: BrowserChannel = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.getTargets') return { targetInfos: pages.map(page => ({ ...page, attached: false })) };
      if (method === 'Target.createTarget') return { targetId: 'form-tab' };
      if (method === 'Target.attachToTarget') return { sessionId: `session-${String(params.targetId)}` };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: 'https://example.com/form' } } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['submit'] }, { nodeId: 'submit', parentId: 'root', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 9 }] };
      return {};
    },
    subscribe() { return () => {}; },
    async close() {},
  };
  return { upstream, sent };
}
/** The workspace's single step on the cloud browser, as its object hands it to the browser session. */
function step(workspaceId: string, attemptId: string, args: Record<string, unknown>) {
  const now = Date.now(), expiresAt = new Date(now + 60_000).toISOString(), placement = { kind: 'cloud', accountId: env.ACCOUNT_ID };
  const authority = { body: { accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId, publicKey: 'AA==', issuedAt: new Date(now).toISOString(), expiresAt }, signature: 'AA==' };
  const grant = { body: { projectId: 'project', workspaceId, placement, groupId: '9c1a0d47-55c3-4a5e-8b9a-3f8a1c2d4e5f', groupName: 'Workspace', source: 'headless', stepsOnly: [], origins: [], expiresAt }, signature: 'AA==', authority };
  return RuntimeAccountBrowserAuthorizationSchema.parse({ body: { scope: { projectId: 'project', workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date(now).toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { source: 'headless', ...args }, grant } }, signature: 'AA==', authority });
}
/** A script's CDP connection to the session, as its sandbox opens it: each command and its reply or error. */
async function script(session: BrowserSessionDO, run: string) {
  const response = await session.fetch(new Request(`https://session/script/${run}/Agent`, { headers: { upgrade: 'websocket' } }));
  const socket = response.webSocket;
  if (!socket) throw new Error('The session answered no CDP socket');
  socket.accept();
  const replies = new Map<number, PromiseWithResolvers<z.infer<typeof Reply>>>();
  socket.addEventListener('message', event => { const reply = Reply.safeParse(JSON.parse(String(event.data))); if (reply.success) replies.get(reply.data.id)?.resolve(reply.data); });
  let id = 0;
  return { socket, async send(method: string, params: Record<string, unknown> = {}) {
    const reply = Promise.withResolvers<z.infer<typeof Reply>>();
    replies.set(++id, reply);
    socket.send(JSON.stringify({ id, method, params }));
    return reply.promise;
  } };
}

test('a cloud tab you take over gets none of the agent’s commands: a step is refused, a script stops at its next command there, and Resume agent makes its refs stale', async () => {
  const workspaceId = `takeover-${crypto.randomUUID()}`;
  await runInDurableObject(env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:project:${workspaceId}`), async (session: BrowserSessionDO) => {
    const { upstream, sent } = cloudBrowser();
    session['browser'] = CdpBrowserShim.open(upstream);
    session['upstream'] = upstream;
    expect((await session.execute(step(workspaceId, 'open', { action: 'open' }))).status).toBe('completed');
    const observed = (await session.execute(step(workspaceId, 'observe', { action: 'observe', targetId: 'form-tab' }))).content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    const ref = /\[ref=(\d+:\d+)\]/u.exec(observed)?.[1];
    if (!ref) throw new Error(`No ref in ${observed}`);
    const taken = await session.takeOver({ projectId: 'project', workspaceId, targetId: 'form-tab', device: 'phone' });
    expect(taken).toMatchObject({ before: [], after: [{ targetId: 'form-tab', holder: 'you', by: 'gitspace', device: 'phone' }], page: { url: 'https://example.com/form', title: 'Form' } });
    expect((await session.overview()).held).toEqual(taken.after);
    // A step on the tab is refused before it reaches the browser.
    const before = sent.length;
    expect(await session.execute(step(workspaceId, 'held', { action: 'act', targetId: 'form-tab', ref, operation: 'click' }))).toMatchObject({ status: 'failed', error: { message: BROWSER_TAB_HELD } });
    expect(sent.slice(before)).toEqual([]);
    // A script works on another tab until its first command to yours, which stops it.
    const run = await script(session, 'run-1');
    expect((await run.send('Target.attachToTarget', { targetId: 'other-tab', flatten: true })).error).toBeUndefined();
    expect((await run.send('Target.attachToTarget', { targetId: 'form-tab', flatten: true })).error?.message).toBe('The user took over this tab; the script stopped at its next command');
    expect((await run.send('Target.getTargets')).error?.message).toBe('The user took over this tab; the script stopped at its next command');
    run.socket.close();
    expect(sent.slice(before).filter(command => command.params.targetId === 'form-tab' || command.sessionId === 'session-form-tab')).toEqual([]);
    // Handed back, the tab takes commands again, but refs from before your take over do not apply.
    expect(await session.resume({ projectId: 'project', workspaceId, targetId: 'form-tab' })).toMatchObject({ before: taken.after, after: [] });
    const stale = await session.execute(step(workspaceId, 'stale', { action: 'act', targetId: 'form-tab', ref, operation: 'click' })).catch((error: unknown) => error);
    expect(stale instanceof Error ? stale.message : stale).toContain('Element reference stale; observe again');
  });
});

test('a cloud browser that closes after its idle minutes while you hold a tab gives it back to the agent with a note', async () => {
  const workspaceId = `idle-${crypto.randomUUID()}`;
  const returned = vi.spyOn(SpaceAuthorityDO.prototype, 'browserCloudReturned').mockResolvedValue(undefined);
  await runInDurableObject(env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:project:${workspaceId}`), async (session: BrowserSessionDO, state) => {
    const { upstream } = cloudBrowser();
    session['browser'] = CdpBrowserShim.open(upstream);
    session['upstream'] = upstream;
    const taken = await session.takeOver({ projectId: 'project', workspaceId, targetId: 'form-tab', device: null });
    expect(await state.storage.get('browser.holders')).toMatchObject({ projectId: 'project', workspaceId, holders: taken.after });
    await session.alarm();
    await vi.waitFor(() => expect(returned).toHaveBeenCalledWith({ projectId: 'project', workspaceId }, taken.after, expect.stringContaining('closed after 5 minutes without use while the user held the tab')));
    expect(session.holderOf('form-tab')).toBeUndefined();
    expect(await state.storage.get('browser.holders')).toBeUndefined();
  });
});
