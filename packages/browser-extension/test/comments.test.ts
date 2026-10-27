import { z } from 'zod';
import { describe, expect, it } from 'bun:test';
import type { RuntimeBrowserCommentChromeRequest, RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { ChromeComments, type CommentCapture, type CommentView } from '../src/comments.js';
import { browserOverlayPickedFunction } from '../src/overlay.js';
import { shareTargetFunction } from '../src/share.js';
import { type DebuggerCommand, installed, overlayCommand, settle } from './installed.js';

/** The tab's layout viewport: 1024×512, scrolled 300 px down. */
const viewport = { cssLayoutViewport: { pageX: 0, pageY: 300, clientWidth: 1024, clientHeight: 512 } };
/** The page's elements the overlay may pick, by backend node id: a button, and the form holding it. */
const elements: Record<number, { role: string; name: string; selector: string; border: number[] }> = {
  42: { role: 'button', name: 'Pay now', selector: '#pay', border: [256, 128, 512, 128, 512, 256, 256, 256] },
  43: { role: 'form', name: 'Order', selector: '#order', border: [0, 0, 1024, 0, 1024, 512, 0, 512] },
};
/** Chrome's answers for the comment tool on a tab: the overlay picked node 42 under number 1 and node 43 under 2. */
function answers({ method, params }: DebuggerCommand): unknown {
  if (method === 'Page.getLayoutMetrics') return viewport;
  const argument = Array.isArray(params.arguments) ? params.arguments[0]?.value : undefined;
  if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === browserOverlayPickedFunction) return { result: argument === 1 || argument === 2 ? { type: 'object', objectId: `picked-${argument}` } : { type: 'object', subtype: 'null' } };
  if (method === 'DOM.describeNode') return { node: { backendNodeId: params.objectId === 'picked-1' ? 42 : 43 } };
  const id = typeof params.backendNodeId === 'number' ? params.backendNodeId : Number(String(params.objectId ?? '').slice(5));
  const element = elements[id];
  if (method === 'DOM.resolveNode' && element) return { object: { objectId: `node-${id}` } };
  if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === shareTargetFunction && element) return { result: { value: { text: element.name, selectors: [element.selector] } } };
  if (method === 'DOM.getBoxModel' && element) return { model: { border: element.border } };
  if (method === 'Accessibility.getPartialAXTree' && element) return { nodes: [{ backendDOMNodeId: id, role: { value: element.role }, name: { value: element.name } }] };
  return method === 'Page.captureScreenshot' ? { data: 'CROP' } : undefined;
}

/** Your Chrome connected to an account that takes comments, its `ready` saying so. */
async function commenting() {
  const chrome = await installed({ live: true, protocol: 6 });
  chrome.answer(answers);
  await chrome.relay(undefined, { comments: true });
  return chrome;
}

describe('the in-page comment tool on your Chrome', () => {
  it('the tab in front of a workspace group gets its toolbar with Comment; a tab in no group gets none, nor does any tab of an account that does not take comments', async () => {
    const chrome = await commenting();
    expect(chrome.sent.find(message => message.hello)).toMatchObject({ comments: true });
    // The tab in front when the account said it takes comments.
    expect(chrome.attached).toEqual(['target-1']);
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'idle', workspace: 'Checkout', comments: true } });
    chrome.tabs.set(9, { id: 9, groupId: -1, url: 'https://elsewhere.example/', index: 9, windowId: 1 });
    chrome.activate(9);
    chrome.activate(2);
    await settle();
    expect(chrome.attached).toEqual(['target-1', 'target-2']);
    expect(chrome.overlays('target-2').at(-1)).toMatchObject({ show: { mode: 'idle', workspace: 'Checkout' } });
    // Dragged out of the group, a tab loses its toolbar and the debugger.
    await chrome.updateTab(2, { groupId: -1 });
    await settle();
    expect(chrome.detached).toEqual(['target-2']);
    expect(chrome.overlays('target-2').at(-1)).toEqual({ remove: true });

    const older = await installed({ live: true, protocol: 6 });
    await older.relay();
    older.activate(2);
    await settle();
    expect(older.attached).toEqual([]);
  });

  it('comment mode lists the page’s threads; a click anchors to the element and a drag to an area, each with a crop the overlay stays out of', async () => {
    const chrome = await commenting();
    const groupId = chrome.grant.body.groupId;
    const binding = (payload: string) => chrome.pageEvent('target-1', 'Runtime.bindingCalled', { name: '__gitspaceStop', payload, executionContextId: 50 });
    await binding('comment on');
    await chrome.waitFor(() => chrome.commentRequests.length === 1);
    expect(chrome.commentRequests).toEqual([{ op: 'list', groupId, url: 'https://app.example/' }]);
    expect(await chrome.authorizedAsRequired(chrome.requests.at(-1) ?? { method: '', pathname: '', header: null, body: new Uint8Array() })).toBe(true);
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'idle' }, comment: { bar: true, name: 'Bradley', workspace: 'Checkout', threads: [], draft: null } });

    await binding('comment pick {"seq":1,"at":{"x":0.3,"y":0.3,"width":0,"height":0}}');
    expect(chrome.overlays('target-1').at(-1)?.comment).toMatchObject({ draft: { seq: 1, label: 'button “Pay now”', area: false } });
    // The crop is taken with the overlay hidden, of the element where the page is scrolled to.
    const shots = chrome.commands.filter(({ targetId, method, params }) => targetId === 'target-1' && (method === 'Page.captureScreenshot' || (method === 'Runtime.callFunctionOn' && overlayCommand(params)?.conceal !== undefined)));
    expect(shots.map(({ method, params }) => method === 'Page.captureScreenshot' ? params.clip : overlayCommand(params)?.conceal)).toEqual([true, { x: 256, y: 428, width: 256, height: 128, scale: 1 }, false]);
    await binding('comment post {"seq":5,"text":"Pay now is hidden on phones"}');
    await chrome.waitFor(() => chrome.commentRequests.length === 2);
    expect(chrome.commentRequests.at(-1)).toEqual({
      op: 'comment', groupId, page: { url: 'https://app.example/', title: 'Page' }, crop: 'CROP', text: 'Pay now is hidden on phones',
      anchor: { role: 'button', name: 'Pay now', selector: '#pay', box: { x: 0.25, y: 0.25, w: 0.25, h: 0.25 }, scroll: { x: 0, y: 300 }, viewport: { w: 1024, h: 512 } },
    });

    await binding('comment pick {"seq":2,"area":{"x":0.5,"y":0.5,"width":0.25,"height":0.125}}');
    await binding('comment post {"seq":6,"text":"Make this whole part shorter"}');
    await chrome.waitFor(() => chrome.commentRequests.length === 3);
    expect(chrome.commentRequests.at(-1)).toMatchObject({ op: 'comment', anchor: { role: 'form', name: 'Order', selector: '#order', box: { x: 0.5, y: 0.5, w: 0.25, h: 0.125 }, area: true } });
    expect(chrome.overlays('target-1').at(-1)?.comment).toMatchObject({
      draft: null, done: { seq: 6, error: null },
      threads: [{ n: 1, label: 'button “Pay now”', area: false, selector: '#pay', scroll: { x: 0, y: 300 }, viewport: { w: 1024, h: 512 } }, { n: 2, label: 'area around form “Order”', area: true }],
    });

    // Esc (or Done) leaves comment mode; the toolbar stays.
    await binding('comment off');
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'idle' }, comment: null });
  });

  it('replies and resolves on a thread, and shows the agent’s reply when the account says the thread changed', async () => {
    const chrome = await commenting();
    const groupId = chrome.grant.body.groupId;
    const binding = (payload: string) => chrome.pageEvent('target-1', 'Runtime.bindingCalled', { name: '__gitspaceStop', payload, executionContextId: 50 });
    await binding('comment on');
    await binding('comment pick {"seq":1,"at":{"x":0.3,"y":0.3,"width":0,"height":0}}');
    await binding('comment post {"seq":2,"text":"This should accept +44 numbers"}');
    await chrome.waitFor(() => chrome.commentThreads.size === 1);
    const [thread] = [...chrome.commentThreads.values()];
    if (!thread) throw new Error('No thread');
    const threadId = thread.root.id;
    const shown = () => z.object({ comment: z.object({ threads: z.array(z.object({ comments: z.array(z.unknown()), resolved: z.unknown() }).loose()) }).nullish() }).loose().parse(chrome.overlays('target-1').at(-1)).comment?.threads[0];

    await binding(`comment reply {"seq":3,"threadId":"${threadId}","text":"  Also on tablets  "}`);
    await chrome.waitFor(() => thread.replies.length === 1);
    await chrome.waitFor(() => shown()?.comments?.length === 2);
    expect(chrome.commentRequests.at(-1)).toEqual({ op: 'reply', groupId, threadId, text: 'Also on tablets' });
    await binding(`comment resolve {"seq":4,"threadId":"${threadId}"}`);
    await chrome.waitFor(() => shown()?.resolved === 'Bradley');
    expect(chrome.commentRequests.at(-1)).toEqual({ op: 'resolve', groupId, threadId });
    await binding(`comment resolve {"seq":5,"threadId":"${threadId}","reopen":true}`);
    await chrome.waitFor(() => shown()?.resolved === null);
    expect(chrome.commentRequests.at(-1)).toEqual({ op: 'resolve', groupId, threadId, reopen: true });

    // The main agent replies in GitSpace; the account says the thread changed, and the pin's thread shows it as the agent.
    thread.replies.push({ ...thread.root, id: crypto.randomUUID(), parentId: threadId, anchor: null, by: { kind: 'agent', conversation: 'main' }, text: 'Fixed in a3f9c21', resolved: null });
    await chrome.fromRelay({ operation: 'comments', groupId, threadId });
    await chrome.waitFor(() => shown()?.comments?.length === 3);
    expect(shown()?.comments?.at(-1)).toMatchObject({ who: 'main', agent: true, text: 'Fixed in a3f9c21' });
  });

  it('Show on page from GitSpace brings the tab to the front in comment mode with that thread open, only signed for it', async () => {
    const chrome = await commenting();
    const groupId = chrome.grant.body.groupId;
    const threadId = crypto.randomUUID();
    await expect(chrome.execute({ operation: 'showComment', groupId, targetId: 'target-3', threadId })).rejects.toThrow('Signed comment show required');
    await chrome.authorize({ type: 'manage', action: 'commentShow', groupId, targetId: 'target-3', threadId: crypto.randomUUID() }, 'browser_control');
    await expect(chrome.execute({ operation: 'showComment', groupId, targetId: 'target-3', threadId })).rejects.toThrow('Signed comment show required');
    await chrome.authorize({ type: 'manage', action: 'commentShow', groupId, targetId: 'target-3', threadId }, 'browser_control');
    expect(await chrome.execute({ operation: 'showComment', groupId, targetId: 'target-3', threadId })).toEqual({});
    expect(chrome.focused).toEqual([{ tabId: 3, windowId: 1 }]);
    await chrome.waitFor(() => chrome.commentRequests.some(request => request.url === 'https://bank.example/'));
    expect(chrome.overlays('target-3').at(-1)).toMatchObject({ show: { mode: 'idle' }, comment: { focus: { thread: threadId } } });
  });
});

describe('comments made while a capture records', () => {
  it('land on the capture’s clock, and the capture hears of each and of the tool turned off from the page', async () => {
    const requests: RuntimeBrowserCommentChromeRequest[] = [];
    const views: Array<CommentView | null> = [];
    const thread = (text: string): RuntimeBrowserCommentThread => {
      const id = crypto.randomUUID();
      return { root: { id, threadId: id, parentId: null, source: { kind: 'chrome', pairingId: id }, page: { url: 'https://app.example/', title: 'Page' }, anchor: { role: 'button', name: 'Pay now', selector: '#pay', box: { x: 0, y: 0, w: 0, h: 0 } }, by: { kind: 'person', name: 'Bradley', guest: false }, text, createdAt: new Date().toISOString(), resolved: null }, replies: [] };
    };
    const comments: ChromeComments = new ChromeComments({
      request: async request => { requests.push(request); return request.op === 'list' ? { threads: [], name: 'Bradley' } : { thread: thread(request.op === 'comment' ? request.text : '') }; },
      draw: targetId => { views.push(comments.view(targetId)); },
      group: async () => ({ groupId: crypto.randomUUID(), workspace: 'Checkout' }),
      picked: async () => ({ box: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, role: 'button', name: 'Pay now', text: 'Pay now', selectors: ['#pay'] }),
      crop: async () => null,
      page: async () => ({ url: 'https://app.example/', title: 'Page', viewport: { w: 1024, h: 512 }, scroll: { x: 0, y: 0 } }),
    });
    const heard: string[] = [];
    const capture: CommentCapture = { captureId: crypto.randomUUID(), startedAt: Date.now() - 65_000, saved: () => { heard.push('saved'); }, ended: () => { heard.push('ended'); } };
    await comments.start('target-1', { groupId: crypto.randomUUID(), workspace: 'Checkout' }, capture);
    // The capture's bar shows; the tool draws none of its own.
    expect(views.at(-1)?.bar).toBe(false);
    await comments.binding('target-1', 'comment pick {"seq":1,"at":{"x":0.3,"y":0.3,"width":0,"height":0}}');
    await comments.binding('target-1', 'comment post {"seq":2,"text":"Telephone only matters for delivery"}');
    const posted = requests.at(-1);
    if (posted?.op !== 'comment') throw new Error('No comment posted');
    expect(posted.capture?.captureId).toBe(capture.captureId);
    expect(posted.capture?.atMs).toBeGreaterThanOrEqual(65_000);
    expect(posted.capture?.atMs).toBeLessThan(70_000);
    expect(heard).toEqual(['saved']);
    // The capture turning the tool off is not news to it; Esc on the page is.
    comments.stop('target-1', false);
    expect(heard).toEqual(['saved']);
    await comments.start('target-1', { groupId: crypto.randomUUID(), workspace: 'Checkout' }, capture);
    await comments.binding('target-1', 'comment off');
    expect(heard).toEqual(['saved', 'ended']);
    expect(views.at(-1)).toBeNull();
  });
});
