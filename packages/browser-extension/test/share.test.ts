import { afterEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { browserBase64, type RuntimeBrowserShare } from '@gitspace/protocol-runtime';
import { shareTargetFunction } from '../src/share.js';
import { command, FRAME, installed, screencasts } from './installed.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); });

/** A frame of the share's tab: the 32×16 JPEG with a byte of its own, so frames tell apart. */
const frame = (n: number) => browserBase64(Uint8Array.from([...Buffer.from(FRAME, 'base64'), n]));
const viewport = { cssLayoutViewport: { pageX: 0, pageY: 300, clientWidth: 1024, clientHeight: 512 } };
/** Your Chrome, connected to an account that shares tabs, with a tab of yours in no workspace group (tab 9). */
async function sharing() {
  const chrome = await installed({ live: true });
  await chrome.relay();
  chrome.tabs.set(9, { id: 9, groupId: -1, url: 'https://elsewhere.example/', index: 9, windowId: 1, title: 'Elsewhere', width: 1200, height: 700 });
  chrome.answer(({ method }) => method === 'Page.getLayoutMetrics' ? viewport : undefined);
  return chrome;
}
/** A live share of tab 9 as the account tells it. */
function shareOf(shareId: string, viewers: RuntimeBrowserShare['viewers'] = []): RuntimeBrowserShare {
  const now = new Date().toISOString();
  return { shareId, link: `https://account.gitspace.test/s/${shareId}#${'k'.repeat(43)}`, pairingId: crypto.randomUUID(), browser: 'Chrome', targetId: 'target-9', workspace: null, page: { url: 'https://elsewhere.example/', title: 'Elsewhere' }, comment: false, createdAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), endedAt: null, endReason: null, viewers, audit: [] };
}

describe('a share of a tab on your Chrome', () => {
  it('streams the tab while someone watches: at most four frames a second, the newest when they come faster, none while the connection is backed up', async () => {
    const chrome = await sharing();
    const shareId = crypto.randomUUID();
    expect(await chrome.ask({ operation: 'shareWatch', shareId, targetId: 'target-9', maxWidth: 1600, maxHeight: 900 })).toEqual({ url: 'https://elsewhere.example/', title: 'Elsewhere', width: 1024, height: 512 });
    expect(chrome.attached).toEqual(['target-9']);
    expect(screencasts(chrome.commands, 'target-9')).toEqual([{ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 900 }]);
    const frames = () => chrome.sent.flatMap(message => message.shareFrame ?? []);
    for (const n of [1, 2, 3]) await chrome.pageEvent('target-9', 'Page.screencastFrame', { data: frame(n), sessionId: n, metadata: { deviceWidth: 1024, deviceHeight: 512 } });
    expect(frames()).toEqual([{ shareId, data: frame(1), width: 32, height: 16 }]);
    expect(chrome.commands.filter(({ method }) => method === 'Page.screencastFrameAck').map(({ params }) => params.sessionId)).toEqual([1, 2, 3]);
    await chrome.advance(250);
    expect(frames()).toEqual([{ shareId, data: frame(1), width: 32, height: 16 }, { shareId, data: frame(3), width: 32, height: 16 }]);

    const connection = chrome.sockets.at(-1);
    if (!connection) throw new Error('No relay connection');
    connection.bufferedAmount = 600 * 1024;
    await chrome.advance(250);
    await chrome.pageEvent('target-9', 'Page.screencastFrame', { data: frame(4), sessionId: 4, metadata: { deviceWidth: 1024, deviceHeight: 512 } });
    await chrome.advance(500);
    expect(frames()).toHaveLength(2);
    connection.bufferedAmount = 0;
    await chrome.advance(250);
    expect(frames().at(-1)).toEqual({ shareId, data: frame(4), width: 32, height: 16 });

    // The last viewer left: the screencast stops and the debugger leaves the tab.
    expect(await chrome.ask({ operation: 'shareUnwatch', shareId })).toEqual({});
    expect(screencasts(chrome.commands, 'target-9').at(-1)).toBe('stop');
    expect(chrome.detached).toEqual(['target-9']);
    await chrome.pageEvent('target-9', 'Page.screencastFrame', { data: frame(5), sessionId: 5, metadata: {} });
    await chrome.advance(1000);
    expect(frames()).toHaveLength(3);
  });

  it('of a tab in no workspace group never lets an agent command, script or event through', async () => {
    const chrome = await sharing();
    await chrome.ask({ operation: 'shareWatch', shareId: crypto.randomUUID(), targetId: 'target-9', maxWidth: 800, maxHeight: 600 });
    const attemptId = await chrome.begin();
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-9' })).rejects.toThrow('Target outside workspace group or origins');
    await expect(chrome.execute(command(attemptId, 'target-9', 'Runtime.evaluate', { expression: 'document.cookie' }))).rejects.toThrow('Unknown or revoked target channel');
    await expect(chrome.execute({ operation: 'command', targetId: 'target-9', method: 'Runtime.evaluate', params: { expression: 'document.cookie', returnByValue: true, awaitPromise: true } })).rejects.toThrow('Unknown or revoked target channel');
    await chrome.pageEvent('target-9', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'secret' }] });
    await chrome.pageEvent('target-9', 'Page.frameNavigated', { frame: { id: 'main', url: 'https://elsewhere.example/account' } });
    expect(chrome.commands.filter(({ targetId, method }) => targetId === 'target-9' && method === 'Runtime.evaluate')).toEqual([]);
    expect(chrome.sent.filter(message => message.targetId === 'target-9')).toEqual([]);
  });

  it('says what is under a viewer’s point, and anchors a comment with a crop of its area', async () => {
    const chrome = await sharing();
    const page = new Window();
    closing.push(() => page.happyDOM.close());
    page.document.body.innerHTML = '<main><form id="checkout"><button name="pay" class="primary big">Pay now</button><button>Cancel</button></form></main>';
    const [pay, cancel] = page.document.querySelectorAll('button');
    // The in-page overlay: a closed shadow root drawing viewers' pointers (no pointer events) and its own controls.
    const host = page.document.createElement('div');
    host.setAttribute('data-gitspace-overlay', '');
    page.document.documentElement.appendChild(host);
    const control = host.attachShadow({ mode: 'closed' }).appendChild(page.document.createElement('button'));
    const nodes: Record<number, unknown> = { 42: pay, 43: cancel, 77: control };
    chrome.answer(({ method, params }) => {
      if (method === 'Page.getLayoutMetrics') return viewport;
      if (method === 'DOM.getNodeForLocation') {
        if (params.x === 307 && params.y === 153) return { backendNodeId: 42, frameId: 'main' };
        // A viewer's named pointer covers Cancel; it takes no pointer events, so a click there reaches Cancel.
        if (params.x === 614 && params.y === 307) return { backendNodeId: params.ignorePointerEventsNone ? 77 : 43, frameId: 'main' };
        // The overlay's own control takes pointer events.
        if (params.x === 716 && params.y === 358) return { backendNodeId: 77, frameId: 'main' };
        return undefined;
      }
      const id = typeof params.backendNodeId === 'number' ? params.backendNodeId : Number(String(params.objectId ?? '').slice(5));
      if (method === 'DOM.resolveNode' && nodes[id]) return { object: { objectId: `node-${id}` } };
      if (method === 'Runtime.callFunctionOn' && nodes[id]) return { result: { value: page.eval(`(${shareTargetFunction})`).call(nodes[id]) } };
      if (method === 'DOM.getBoxModel' && id === 42) return { model: { border: [256, 128, 512, 128, 512, 256, 256, 256] } };
      if (method === 'DOM.getBoxModel' && id === 43) return { model: { border: [512, 256, 768, 256, 768, 384, 512, 384] } };
      if (method === 'DOM.getBoxModel' && id === 77) return { model: { border: [700, 340, 740, 340, 740, 380, 700, 380] } };
      if (method === 'Accessibility.getPartialAXTree' && nodes[id]) return { nodes: [{ backendDOMNodeId: id, role: { value: 'button' }, name: { value: id === 42 ? 'Pay now' : id === 43 ? 'Cancel' : 'Stop' } }] };
      return method === 'Page.captureScreenshot' ? { data: 'CROP' } : undefined;
    });
    const shareId = crypto.randomUUID();
    await chrome.ask({ operation: 'shareWatch', shareId, targetId: 'target-9', maxWidth: 800, maxHeight: 600 });
    const target = { box: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, role: 'button', name: 'Pay now', text: 'Pay now', selectors: ['button[name="pay"]', 'button.primary.big', '#checkout > button:nth-of-type(1)'] };
    expect(await chrome.ask({ operation: 'shareHit', shareId, at: { x: 0.3, y: 0.3 } })).toEqual({ target });
    expect(await chrome.ask({ operation: 'shareHit', shareId, at: { x: 0.9, y: 0.9 } })).toEqual({ target: null });
    expect(await chrome.ask({ operation: 'shareHit', shareId, at: { x: 0.6, y: 0.6 } })).toMatchObject({ target: { role: 'button', name: 'Cancel', text: 'Cancel' } });
    expect(await chrome.ask({ operation: 'shareHit', shareId, at: { x: 0.7, y: 0.7 } })).toEqual({ target: null });

    expect(await chrome.ask({ operation: 'shareAnchor', shareId, at: { x: 0.3, y: 0.3 } })).toEqual({ page: { url: 'https://elsewhere.example/', title: 'Elsewhere' }, target, region: target.box, viewport: { width: 1024, height: 512 }, scroll: { x: 0, y: 300 }, crop: 'CROP' });
    expect(await chrome.ask({ operation: 'shareAnchor', shareId, region: { x: 0.5, y: 0.5, width: 0.25, height: 0.5 } })).toMatchObject({ target: null, region: { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, crop: 'CROP' });
    // Crops are of the page where it is scrolled to, at quality 70.
    expect(chrome.commands.filter(({ method }) => method === 'Page.captureScreenshot').map(({ params }) => params)).toEqual([
      { format: 'jpeg', quality: 70, captureBeyondViewport: false, clip: { x: 256, y: 428, width: 256, height: 128, scale: 1 } },
      { format: 'jpeg', quality: 70, captureBeyondViewport: false, clip: { x: 512, y: 556, width: 256, height: 256, scale: 1 } },
    ]);
    await expect(chrome.ask({ operation: 'shareHit', shareId: crypto.randomUUID(), at: { x: 0.3, y: 0.3 } })).rejects.toThrow('No one watches this share in this Chrome');
  });

  it('draws its viewers’ pointers on the tab, and takes them away when they leave', async () => {
    const chrome = await sharing();
    const shareId = crypto.randomUUID();
    await chrome.ask({ operation: 'shareWatch', shareId, targetId: 'target-9', maxWidth: 800, maxHeight: 600 });
    await chrome.fromRelay({ operation: 'sharePointers', shareId, pointers: [{ viewerId: 'ann', name: 'Ann', color: '#e5484d', at: { x: 0.5, y: 0.25 } }, { viewerId: 'bob', name: 'Bob', color: '#0090ff', at: { x: 0.1, y: 0.9 } }] });
    expect(chrome.overlays('target-9').at(-1)).toEqual({ show: null, pointers: [{ id: `${shareId}:ann`, name: 'Ann', color: '#e5484d', x: 0.5, y: 0.25 }, { id: `${shareId}:bob`, name: 'Bob', color: '#0090ff', x: 0.1, y: 0.9 }] });
    await chrome.fromRelay({ operation: 'sharePointers', shareId, pointers: [{ viewerId: 'bob', name: 'Bob', color: '#0090ff', at: { x: 0.2, y: 0.8 } }] });
    expect(chrome.overlays('target-9').at(-1)).toEqual({ show: null, pointers: [{ id: `${shareId}:bob`, name: 'Bob', color: '#0090ff', x: 0.2, y: 0.8 }] });
    await chrome.fromRelay({ operation: 'sharePointers', shareId, pointers: [] });
    expect(chrome.overlays('target-9').at(-1)).toEqual({ remove: true });
    // Notices get no answer.
    expect(chrome.sent.filter(message => 'error' in message || 'result' in message).map(message => message.id)).toEqual(['relay-1']);
  });

  it('ends when its tab closes, and tells the account when its tab navigates', async () => {
    const chrome = await sharing();
    const shareId = crypto.randomUUID();
    await chrome.fromRelay({ operation: 'shares', shares: [shareOf(shareId)] });
    await chrome.updateTab(9, { url: 'https://elsewhere.example/next', title: 'Next' });
    expect(chrome.sent.filter(message => message.share)).toEqual([{ share: { event: 'page', shareId, url: 'https://elsewhere.example/next', title: 'Next', width: 1200, height: 700 } }]);
    await chrome.closeTab(9);
    expect(chrome.sent.filter(message => message.share).at(-1)).toEqual({ share: { event: 'closed', shareId } });
  });

  it('ends, when the account lists it, if its tab closed while Chrome was off', async () => {
    const chrome = await sharing();
    const live = crypto.randomUUID(), lost = crypto.randomUUID();
    await chrome.fromRelay({ operation: 'shares', shares: [shareOf(live), { ...shareOf(lost), targetId: 'target-from-before-restart' }] });
    expect(chrome.sent.filter(message => message.share)).toEqual([{ share: { event: 'closed', shareId: lost } }]);
  });
});

describe('a share link pasted into a workspace', () => {
  it('moves its tab into that workspace’s group as if you dragged it in, consenting to its site', async () => {
    const chrome = await sharing();
    const groupId = chrome.grant.body.groupId;
    const attemptId = await chrome.begin();
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-9' })).rejects.toThrow('Target outside workspace group or origins');
    expect(await chrome.ask({ operation: 'adoptTab', groupId, targetId: 'target-9' })).toEqual({ url: 'https://elsewhere.example/', title: 'Elsewhere' });
    expect(chrome.tabs.get(9)?.groupId).toBe(7);
    await chrome.advance(300);
    expect(chrome.sent.filter(message => message.group).at(-1)).toMatchObject({ group: { groupId, tabs: expect.arrayContaining([{ targetId: 'target-9', url: 'https://elsewhere.example/', title: 'Elsewhere', addedBy: 'you', site: 'elsewhere.example' }]) } });
    expect(await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-9' })).toEqual({ targetId: 'target-9', sessionId: expect.any(String) });
  });

  it('leaves a tab in another workspace’s group where it is', async () => {
    const chrome = await sharing();
    chrome.groups.set(8, { id: 8, title: 'Other', color: 'red', collapsed: false });
    chrome.stored.set('group:other', { groupId: crypto.randomUUID(), chromeGroupId: 8, browserEpoch: 'epoch', members: { 10: { by: 'agent', site: null } } });
    chrome.tabs.set(10, { id: 10, groupId: 8, url: 'https://other.example/', index: 10, windowId: 1, title: 'Other' });
    await expect(chrome.ask({ operation: 'adoptTab', groupId: chrome.grant.body.groupId, targetId: 'target-10' })).rejects.toThrow("This tab is in another workspace's group; drag it out first");
    expect(chrome.tabs.get(10)?.groupId).toBe(8);
  });
});

describe('Share this tab in the popup', () => {
  it('Copy link makes the share with a signed request and copies its link; it shows who is watching, and Stop sharing ends it', async () => {
    const chrome = await sharing();
    /** The popup's element with this id. */
    const element = ({ window }: { window: Window }, id: string) => {
      const found = window.document.getElementById(id);
      if (!(found instanceof window.HTMLElement)) throw new Error(`No #${id}`);
      return found;
    };
    // Comments land in a workspace, so only a tab in a workspace group offers them.
    const grouped = await chrome.openPopup();
    closing.push(grouped.close);
    expect(element(grouped, 'share-comment')).toMatchObject({ disabled: false });
    expect(element(grouped, 'share-comment-hint').hidden).toBe(true);

    chrome.activate(9);
    const popup = await chrome.openPopup();
    closing.push(popup.close);
    const $ = (id: string) => element(popup, id);
    expect($('share').hidden).toBe(false);
    expect($('share-comment')).toMatchObject({ disabled: true });
    expect($('share-comment-hint').textContent).toBe('Comments need the tab in a workspace group');
    Object.assign($('share-expiry'), { value: '480' });
    $('share-copy').click();
    await chrome.waitFor(() => chrome.requests.length === 1);
    const [made] = chrome.requests;
    if (!made) throw new Error('No share request');
    expect(JSON.parse(new TextDecoder().decode(made.body))).toEqual({ op: 'create', targetId: 'target-9', comment: false, expiresInMinutes: 480 });
    expect(await chrome.authorizedAsRequired(made)).toBe(true);
    const [share] = chrome.shares.values();
    if (!share) throw new Error('No share made');
    expect(popup.copied).toEqual([share.link]);
    expect($('share-new').hidden).toBe(true);
    expect($('shares').querySelector('input')).toMatchObject({ value: share.link, readOnly: true });
    expect($('shares').textContent).toContain('View and point; never click or type · 8 h');
    expect($('shares').textContent).toContain('No one is watching yet');

    // Someone joins: the account tells this Chrome, and the popup shows them.
    await chrome.fromRelay({ operation: 'shares', shares: [{ ...share, viewers: [{ viewerId: crypto.randomUUID(), name: 'Ann', guest: true, joinedAt: new Date().toISOString() }, { viewerId: crypto.randomUUID(), name: 'Bradley', guest: false, joinedAt: new Date().toISOString() }] }] });
    const reopened = await chrome.openPopup();
    closing.push(reopened.close);
    const viewers = reopened.document.querySelector('#shares .viewers');
    expect(viewers?.textContent).toBe('Watching: Annguest, Bradley');
    expect([...viewers?.querySelectorAll('.guest') ?? []].map(mark => mark.previousSibling?.textContent)).toEqual(['Ann']);

    const stop = [...reopened.document.querySelectorAll('#shares button')].find(button => button.textContent === 'Stop sharing');
    if (!(stop instanceof reopened.window.HTMLElement)) throw new Error('No Stop sharing');
    stop.click();
    await chrome.waitFor(() => chrome.requests.length === 2);
    const stopped = chrome.requests[1];
    if (!stopped) throw new Error('No revoke request');
    expect(JSON.parse(new TextDecoder().decode(stopped.body))).toEqual({ op: 'revoke', shareId: share.shareId });
    expect(await chrome.authorizedAsRequired(stopped)).toBe(true);
    expect(share.endReason).toBe('revoked');
    expect(reopened.document.getElementById('shares')?.children.length).toBe(0);
    expect(element(reopened, 'share-new').hidden).toBe(false);
  });
});
