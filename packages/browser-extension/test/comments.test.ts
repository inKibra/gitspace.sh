import { z } from 'zod';
import { describe, expect, it } from 'bun:test';
import type { RuntimeBrowserCommentChromeRequest, RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { ChromeComments, type CommentCapture, type CommentView } from '../src/comments.js';
import { browserPickedElementFunction } from '../src/overlay.js';
import { shareTargetFunction } from '../src/share.js';
import { type DebuggerCommand, installed, settle } from './installed.js';

/** The tab's layout viewport: 1024×512, scrolled 300 px down. */
const viewport = { cssLayoutViewport: { pageX: 0, pageY: 300, clientWidth: 1024, clientHeight: 512 } };
/** The page's elements the overlay may pick, by backend node id: a button, and the form holding it. */
const elements: Record<number, { role: string; name: string; selector: string; border: number[] }> = {
  42: { role: 'button', name: 'Pay now', selector: '#pay', border: [256, 128, 512, 128, 512, 256, 256, 256] },
  43: { role: 'form', name: 'Order', selector: '#order', border: [0, 0, 1024, 0, 1024, 512, 0, 512] },
};
/** Chrome's answers for the comment tool on a tab: the overlay marked node 42 with number 1 and node 43 with 2. */
function answers({ method, params }: DebuggerCommand): unknown {
  if (method === 'Page.getLayoutMetrics') return viewport;
  const argument = Array.isArray(params.arguments) ? params.arguments[0]?.value : undefined;
  if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === browserPickedElementFunction) return { result: argument === 1 || argument === 2 ? { type: 'object', objectId: `picked-${argument}` } : { type: 'object', subtype: 'null' } };
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
    // The tab in front when the account said it takes comments; the toolbar needs no debugger.
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'idle', workspace: 'Checkout', comments: true } });
    chrome.tabs.set(9, { id: 9, groupId: -1, url: 'https://elsewhere.example/', index: 9, windowId: 1 });
    chrome.activate(9);
    chrome.activate(2);
    await settle();
    expect(chrome.overlays('target-2').at(-1)).toMatchObject({ show: { mode: 'idle', workspace: 'Checkout' } });
    expect(chrome.pageScripts.filter(script => script.tabId === 9)).toEqual([]);
    expect(chrome.attached).toEqual([]);
    // Dragged out of the group, a tab loses its toolbar.
    await chrome.updateTab(2, { groupId: -1 });
    await settle();
    expect(chrome.overlays('target-2').at(-1)).toEqual({ remove: true });
    expect(chrome.page(2).window.document.querySelector('[data-gitspace-overlay]')).toBeNull();

    const older = await installed({ live: true, protocol: 6 });
    await older.relay();
    older.activate(2);
    await settle();
    expect(older.pageScripts).toEqual([]);
  });

  it('comment mode lists the page’s threads; a click anchors to the element and a drag to an area, each with a crop the overlay stays out of', async () => {
    const chrome = await commenting();
    const groupId = chrome.grant.body.groupId;
    const host = () => chrome.page(1).window.document.querySelector('[data-gitspace-overlay]');
    const shots: unknown[] = [];
    chrome.answer(command => { if (command.method === 'Page.captureScreenshot') shots.push({ clip: command.params.clip, overlay: host()?.getAttribute('style')?.includes('visibility: hidden') ? 'hidden' : 'shown' }); return answers(command); });
    const binding = (payload: string) => chrome.fromPage(1, payload);
    await binding('comment on');
    await chrome.waitFor(() => chrome.commentRequests.length === 1);
    expect(chrome.commentRequests).toEqual([{ op: 'list', groupId, url: 'https://app.example/' }]);
    expect(await chrome.authorizedAsRequired(chrome.requests.at(-1) ?? { method: '', pathname: '', header: null, body: new Uint8Array() })).toBe(true);
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'idle' }, comment: { bar: true, name: 'Bradley', workspace: 'Checkout', threads: [], draft: null } });
    // Turning comment mode on needs no debugger; reading what you pick does.
    expect(chrome.attached).toEqual([]);

    await binding('comment pick {"seq":1,"at":{"x":0.3,"y":0.3,"width":0,"height":0}}');
    expect(chrome.overlays('target-1').at(-1)?.comment).toMatchObject({ draft: { seq: 1, label: 'button “Pay now”', area: false } });
    expect(chrome.attached).toEqual(['target-1']);
    // The crop is taken with the overlay hidden, of the element where the page is scrolled to.
    expect(shots).toEqual([{ clip: { x: 256, y: 428, width: 256, height: 128, scale: 1 }, overlay: 'hidden' }]);
    expect(host()?.getAttribute('style')).toContain('visibility: visible');
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

    // Esc (or Done) leaves comment mode; the toolbar stays, and the debugger leaves the tab.
    await binding('comment off');
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'idle' }, comment: null });
    expect(chrome.detached).toEqual(['target-1']);
  });

  it('after the service worker started again, the page’s comment tool still comments: what it sends turns comment mode on again for the tab’s group', async () => {
    const chrome = await commenting();
    const groupId = chrome.grant.body.groupId;
    await chrome.fromPage(1, 'comment on');
    await chrome.waitFor(() => chrome.commentRequests.length === 1);
    // Chrome stops the idle worker; the page keeps its comment mode.
    await chrome.restart();
    await chrome.fromPage(1, 'comment pick {"seq":1,"at":{"x":0.3,"y":0.3,"width":0,"height":0}}');
    await chrome.waitFor(() => chrome.commentRequests.length === 2);
    expect(chrome.commentRequests.at(-1)).toEqual({ op: 'list', groupId, url: 'https://app.example/' });
    await settle();
    expect(chrome.overlays('target-1').at(-1)?.comment).toMatchObject({ draft: { seq: 1, label: 'button “Pay now”' } });
    await chrome.fromPage(1, 'comment post {"seq":8,"text":"Still works after a restart"}');
    await chrome.waitFor(() => chrome.commentRequests.length === 3);
    expect(chrome.commentRequests.at(-1)).toMatchObject({ op: 'comment', groupId, text: 'Still works after a restart', anchor: { role: 'button', name: 'Pay now' } });
    await settle();
    expect(chrome.overlays('target-1').at(-1)?.comment).toMatchObject({ done: { seq: 8, error: null }, threads: [{ n: 1, label: 'button “Pay now”' }] });
    // Leaving comment mode from the page is heard as well, and starts nothing; the toolbar stays once the worker is
    // connected again.
    await chrome.relay(undefined, { comments: true });
    await chrome.fromPage(1, 'comment off');
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ comment: null });
    await chrome.fromPage(1, 'comment off');
    expect(chrome.commentRequests).toHaveLength(3);
  });

  it('replies and resolves on a thread, and shows the agent’s reply when the account says the thread changed', async () => {
    const chrome = await commenting();
    const groupId = chrome.grant.body.groupId;
    const binding = (payload: string) => chrome.fromPage(1, payload);
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

  it('an overlay an earlier service worker drew asks this one after 75 s: a tab of the workspace group gets its toolbar again, a tab with nothing to show loses it', async () => {
    const chrome = await commenting();
    chrome.tabs.set(9, { id: 9, groupId: -1, url: 'https://elsewhere.example/', index: 9, windowId: 1, width: 1200, height: 700 });
    chrome.activate(2);
    await settle();
    await chrome.ask({ operation: 'shareWatch', shareId: crypto.randomUUID(), targetId: 'target-9', maxWidth: 800, maxHeight: 600, reportPointer: true });
    const shown = (tabId: number) => chrome.page(tabId).window.document.querySelector('[data-gitspace-overlay]') !== null;
    expect([shown(2), shown(9)]).toEqual([true, true]);
    // Chrome stops the worker; the new one connects and shows the tab in front its toolbar, knowing nothing of the others.
    chrome.activate(1);
    await chrome.restart();
    await chrome.relay(undefined, { comments: true });
    const before = chrome.overlays('target-2').length;
    await chrome.advance(75_000);
    expect(chrome.overlays('target-2').length).toBe(before + 1);
    expect(chrome.overlays('target-2').at(-1)).toMatchObject({ show: { mode: 'idle', workspace: 'Checkout' } });
    expect([shown(2), shown(9)]).toEqual([true, false]);
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
      close: targetId => { views.push(comments.view(targetId)); },
      group: async () => ({ groupId: crypto.randomUUID(), workspace: 'Checkout' }),
      picked: async () => ({ box: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, role: 'button', name: 'Pay now', text: 'Pay now', selectors: ['#pay'] }),
      crop: async () => null,
      page: async () => ({ url: 'https://app.example/', title: 'Page', viewport: { w: 1024, h: 512 }, scroll: { x: 0, y: 0 } }),
      url: async () => 'https://app.example/',
    });
    const heard: string[] = [];
    const capture: CommentCapture = { captureId: crypto.randomUUID(), startedAt: Date.now() - 65_000, saved: () => { heard.push('saved'); }, ended: () => { heard.push('ended'); } };
    await comments.start('target-1', { groupId: crypto.randomUUID(), workspace: 'Checkout' }, capture);
    // The capture's bar shows; the tool draws none of its own.
    expect(views.at(-1)?.bar).toBe(false);
    await comments.message('target-1', 'comment pick {"seq":1,"at":{"x":0.3,"y":0.3,"width":0,"height":0}}');
    await comments.message('target-1', 'comment post {"seq":2,"text":"Telephone only matters for delivery"}');
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
    await comments.message('target-1', 'comment off');
    expect(heard).toEqual(['saved', 'ended']);
    expect(views.at(-1)).toBeNull();
  });
});
