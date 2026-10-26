import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BrowserChannel } from '../src/browser-cdp.js';
import { CdpBrowserShim, type CdpEvent } from '../src/browser-shim.js';

type Params = Record<string, unknown>;
/** A browser-level CDP connection with pages, attaches and events, as the shim sees a real browser. `newestFirst`: it
 * lists its pages newest first, as Chrome does. */
function fakeBrowser(newestFirst = false) {
  const targets: { targetId: string; type: string; url: string; attached: boolean }[] = [{ targetId: 'existing', type: 'page', url: 'about:blank', attached: false }];
  const listeners = new Set<Parameters<BrowserChannel['subscribe']>[0]>();
  const calls: { method: string; params: Params; sessionId?: string }[] = [];
  let sessions = 0;
  /** Creation events wait for `flush`: the reply to a creation can arrive before its event. */
  const held: { method: string; params?: Params }[] = [];
  const emit = (event: { method: string; params?: Params; sessionId?: string }) => { for (const listener of listeners) listener(event); };
  const channel: BrowserChannel = {
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.getTargets') return { targetInfos: (newestFirst ? targets.toReversed() : targets).map(target => ({ ...target })) };
      if (method === 'Target.attachToTarget') {
        const sessionId = `session-${++sessions}`;
        const target = targets.find(candidate => candidate.targetId === params.targetId)!;
        target.attached = true;
        // A real browser announces every attach on the connection, whoever asked for it.
        emit({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: target, waitingForDebugger: false } });
        return { sessionId };
      }
      if (method === 'Target.createTarget') {
        const target = { targetId: `page-${targets.length + 1}`, type: 'page', url: String(params.url), attached: false };
        targets.push(target);
        held.push({ method: 'Target.targetCreated', params: { targetInfo: target } });
        return { targetId: target.targetId };
      }
      if (method === 'Target.detachFromTarget') { emit({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId } }); return {}; }
      return {};
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {},
  };
  return { channel, calls, emit, flush: () => { for (const event of held.splice(0)) emit(event); } };
}
async function settle() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }

describe('CdpBrowserShim', () => {
  it('gives each client its own sessions and events, even on a page another client attached first', async () => {
    const browser = fakeBrowser();
    const shim = await CdpBrowserShim.open(browser.channel);
    const first: CdpEvent[] = [], second: CdpEvent[] = [];
    const a = shim.client(event => first.push(event)), b = shim.client(event => second.push(event));
    await a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const attached = (events: CdpEvent[]) => events.filter(event => event.method === 'Target.attachedToTarget').map(event => event.params?.sessionId);
    expect(attached(first)).toEqual(['session-1']);
    expect(attached(second)).toEqual(['session-2']);
    browser.emit({ method: 'Page.loadEventFired', params: {}, sessionId: 'session-1' });
    expect(first.at(-1)).toEqual({ method: 'Page.loadEventFired', params: {}, sessionId: 'session-1' });
    expect(second.some(event => event.sessionId === 'session-1')).toBe(false);
    await expect(b.send('Runtime.evaluate', { expression: '1' }, 'session-1')).rejects.toThrow('does not belong');
  });

  it('while you hold a tab, a client’s commands to it are refused and what happens there, in its frames too, stays out of the client', async () => {
    const browser = fakeBrowser();
    const shim = await CdpBrowserShim.open(browser.channel);
    const events: CdpEvent[] = [], held = new Set<string>();
    const client = shim.client(event => events.push(event), { hold: { holds: targetId => held.has(targetId), refuse: targetId => `You hold ${targetId}` } });
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    browser.emit({ method: 'Target.attachedToTarget', params: { sessionId: 'frame-1', targetInfo: { targetId: 'frame', type: 'iframe' } }, sessionId: 'session-1' });
    held.add('existing');
    const seen = events.length;
    browser.emit({ method: 'Input.dragIntercepted', params: {}, sessionId: 'session-1' });
    browser.emit({ method: 'Runtime.consoleAPICalled', params: { args: [{ value: 'typed' }] }, sessionId: 'frame-1' });
    expect(events.slice(seen)).toEqual([]);
    const before = browser.calls.length;
    await expect(client.send('Runtime.evaluate', { expression: 'document.title' }, 'session-1')).rejects.toThrow('You hold existing');
    await expect(client.send('Runtime.evaluate', { expression: 'document.title' }, 'frame-1')).rejects.toThrow('You hold existing');
    await expect(client.send('Target.closeTarget', { targetId: 'existing' })).rejects.toThrow('You hold existing');
    expect(browser.calls.slice(before)).toEqual([]);
    // Handed back, the tab is the client's again.
    held.delete('existing');
    await client.send('Runtime.evaluate', { expression: 'document.title' }, 'session-1');
    browser.emit({ method: 'Page.loadEventFired', params: {}, sessionId: 'session-1' });
    expect(events.at(-1)).toEqual({ method: 'Page.loadEventFired', params: {}, sessionId: 'session-1' });
  });

  it('a new client sees the browser’s pages in the order they were made, so a script’s newest page is the one opened last', async () => {
    const browser = fakeBrowser(true);
    const shim = await CdpBrowserShim.open(browser.channel);
    const first = shim.client(() => {});
    await first.send('Target.createTarget', { url: 'https://example.com/a' });
    await first.send('Target.createTarget', { url: 'https://example.com/b' });
    browser.flush();
    const events: CdpEvent[] = [];
    const next = shim.client(event => events.push(event));
    await next.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    expect(events.filter(event => event.method === 'Target.attachedToTarget').map(event => z.object({ targetInfo: z.object({ targetId: z.string() }) }).parse(event.params).targetInfo.targetId)).toEqual(['existing', 'page-2', 'page-3']);
  });

  it('a second CDP session on a page a client already drives is its own, through the page session (newCDPSession)', async () => {
    const browser = fakeBrowser();
    const shim = await CdpBrowserShim.open(browser.channel);
    const events: CdpEvent[] = [];
    const a = shim.client(event => events.push(event)), b = shim.client(() => {});
    await a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const root = (await a.send('Target.attachToBrowserTarget') as { sessionId: string }).sessionId;
    const second = (await a.send('Target.attachToTarget', { targetId: 'existing', flatten: true }, root) as { sessionId: string }).sessionId;
    expect(second).not.toBe('session-1');
    await a.send('Accessibility.getFullAXTree', {}, second);
    await a.send('Page.getFrameTree', {}, 'session-1');
    expect(browser.calls.filter(call => call.method === 'Accessibility.getFullAXTree' || call.method === 'Page.getFrameTree')).toEqual([
      { method: 'Accessibility.getFullAXTree', params: {}, sessionId: 'session-1' },
      { method: 'Page.getFrameTree', params: {}, sessionId: 'session-1' },
    ]);
    expect(browser.calls.filter(call => call.method === 'Target.attachToTarget')).toHaveLength(1);
    await expect(b.send('Runtime.evaluate', { expression: '1' }, second)).rejects.toThrow('does not belong');
    await expect(a.send('Runtime.evaluate', { expression: '1' }, root)).rejects.toThrow('not available on a browser session');
    // The page's session going ends the second one, which its browser session hears.
    browser.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-1' } });
    await settle();
    expect(events).toContainEqual({ method: 'Target.detachedFromTarget', params: { sessionId: second }, sessionId: root });
    await expect(a.send('Runtime.evaluate', { expression: '1' }, second)).rejects.toThrow('does not belong');
  });

  it('announces a page it creates before answering, as Chrome does for an auto-attaching client', async () => {
    const browser = fakeBrowser();
    const shim = await CdpBrowserShim.open(browser.channel);
    const events: CdpEvent[] = [];
    const client = shim.client(event => events.push(event));
    await client.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const created = await client.send('Target.createTarget', { url: 'about:blank' });
    const targetId = created && typeof created === 'object' && 'targetId' in created ? created.targetId : null;
    const announced = (event: CdpEvent) => { const info = event.params?.targetInfo; return event.method === 'Target.attachedToTarget' && !!info && typeof info === 'object' && 'targetId' in info && info.targetId === targetId; };
    expect(events.some(announced)).toBe(true);
    browser.flush();
    await settle();
    // The creation event that follows does not attach the page a second time.
    expect(browser.calls.filter(call => call.method === 'Target.attachToTarget' && call.params.targetId === targetId)).toHaveLength(1);
  });

  it('closing one client releases only its sessions and contexts; whole-browser cookie commands are refused', async () => {
    const browser = fakeBrowser();
    const shim = await CdpBrowserShim.open(browser.channel);
    const a = shim.client(() => {}), b = shim.client(() => {});
    await a.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    await b.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    await expect(a.send('Storage.getCookies', {})).rejects.toThrow('whole browser');
    await a.send('Browser.close', {});
    expect(browser.calls.filter(call => call.method === 'Browser.close')).toEqual([]);
    expect(browser.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params.sessionId)).toEqual(['session-1']);
    await expect(b.send('Runtime.evaluate', { expression: '1' }, 'session-2')).resolves.toEqual({});
  });

  it('never shows a client the service session cookie: cookie commands are refused and network events blank it', async () => {
    const browser = fakeBrowser();
    const shim = await CdpBrowserShim.open(browser.channel);
    const events: CdpEvent[] = [];
    const client = shim.client(event => events.push(event));
    await client.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    for (const method of ['Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies']) await expect(client.send(method, { urls: ['https://app--ws--test-srv.gssh.dev/'] }, 'session-1')).rejects.toThrow('cookies');
    browser.emit({ method: 'Network.requestWillBeSentExtraInfo', sessionId: 'session-1', params: {
      requestId: 'request', headers: { Cookie: 'app=1; __Host-gitspace-service=secret-token; __Host-gitspace-service-state=state' },
      associatedCookies: [{ blockedReasons: [], cookie: { name: '__Host-gitspace-service', value: 'secret-token', httpOnly: true } }, { blockedReasons: [], cookie: { name: 'app', value: '1' } }],
    } });
    browser.emit({ method: 'Network.responseReceived', sessionId: 'session-1', params: { requestId: 'request', response: { requestHeadersText: 'GET / HTTP/1.1\r\nCookie: __Host-gitspace-service=secret-token\r\n\r\n' } } });
    expect(JSON.stringify(events)).not.toContain('secret-token');
    expect(events.at(-2)?.params).toMatchObject({
      headers: { Cookie: 'app=1; __Host-gitspace-service=; __Host-gitspace-service-state=state' },
      associatedCookies: [{ cookie: { name: '__Host-gitspace-service', value: '' } }, { cookie: { name: 'app', value: '1' } }],
    });
  });
});
