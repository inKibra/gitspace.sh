import { describe, expect, it } from 'vitest';
import type { BrowserChannel } from '../src/browser-cdp.js';
import { CdpBrowserShim, type CdpEvent } from '../src/browser-shim.js';

type Params = Record<string, unknown>;
/** A browser-level CDP connection with pages, attaches and events, as the shim sees a real browser. */
function fakeBrowser() {
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
      if (method === 'Target.getTargets') return { targetInfos: targets.map(target => ({ ...target })) };
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
});
