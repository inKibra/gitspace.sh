import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { BROWSER_TRACE_READ_BYTES, browserCookieRead, browserCookieUrl, browserStorageExpression, browserTraceStart } from '@gitspace/protocol-runtime/browser-power-rules';
import { BROWSER_EXTENSION_PROTOCOL } from '@gitspace/protocol-runtime';
import type { RuntimeAccountBrowserAuthorizationBody, RuntimeAccountBrowserSignedGrant, RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import { command, installed, settle } from './installed.js';

afterEach(() => { setSystemTime(); });

/** What these tests drive of the installed extension (`installed`). */
type Chrome = { execute(message: object): Promise<unknown>; authorize(command: RuntimeAccountBrowserAuthorizationBody['command'], tool: 'browser' | 'browser_control'): Promise<string> };
type Grant = RuntimeAccountBrowserSignedGrant;
const OUTSIDE = 'Command outside browser grant';
const debugStep: RuntimeBrowserArguments = { action: 'debug', source: 'relay', targetId: 'target-1', kind: 'profile' };
const cookies = (site: string): RuntimeBrowserArguments => ({ action: 'storage', source: 'relay', targetId: 'target-1', op: 'get', kind: 'cookies', site });

/** A single step under `grant`: the account authorizes it and binds its tab. */
async function step(chrome: Chrome, args: RuntimeBrowserArguments, grant: Grant) {
  await chrome.authorize({ type: 'execute', args, grant }, 'browser');
  await chrome.execute({ operation: 'open', grant });
}
const send = (chrome: Chrome, method: string, params: object) => chrome.execute({ operation: 'command', targetId: 'target-1', method, params });

describe('powers on your Chrome', () => {
  it('a debug step records a trace only with the debug power, exactly as signed, reads back only the stream Chrome reported, and works on a site at read', async () => {
    const chrome = await installed();
    await step(chrome, debugStep, chrome.grant);
    await expect(send(chrome, 'Tracing.start', browserTraceStart('profile'))).rejects.toThrow(OUTSIDE);
    const debug = await chrome.signGrant({ powers: ['debug'] });
    // The tab shows news.example, a site at read: recording a profile only looks.
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://news.example/', index: 1, windowId: 1, title: 'Page' });
    await step(chrome, debugStep, debug);
    await expect(send(chrome, 'Tracing.start', { ...browserTraceStart('profile'), traceConfig: { includedCategories: ['*'] } })).rejects.toThrow('CDP parameters outside signed operation');
    await send(chrome, 'Tracing.start', browserTraceStart('profile'));
    await send(chrome, 'Tracing.end', {});
    await expect(send(chrome, 'IO.read', { handle: 'stream-1', size: BROWSER_TRACE_READ_BYTES })).rejects.toThrow('CDP parameters outside signed operation');
    await chrome.pageEvent('target-1', 'Tracing.tracingComplete', { stream: 'stream-1', dataLossOccurred: false });
    expect(chrome.sent).toContainEqual(expect.objectContaining({ targetId: 'target-1', method: 'Tracing.tracingComplete' }));
    await send(chrome, 'IO.read', { handle: 'stream-1', size: BROWSER_TRACE_READ_BYTES });
    await send(chrome, 'IO.read', { handle: 'stream-1', size: BROWSER_TRACE_READ_BYTES });
    await expect(send(chrome, 'IO.read', { handle: 'other', size: BROWSER_TRACE_READ_BYTES })).rejects.toThrow('CDP parameters outside signed operation');
    await send(chrome, 'IO.close', { handle: 'stream-1' });
    expect(chrome.sentCommands().filter(method => method.startsWith('Tracing.') || method.startsWith('IO.'))).toEqual(['Tracing.start', 'Tracing.end', 'IO.read', 'IO.read', 'IO.close']);
    // A heap snapshot never: Chrome closes the HeapProfiler to extensions, and no step sends it.
    await step(chrome, { ...debugStep, kind: 'heap' }, debug);
    await expect(send(chrome, 'HeapProfiler.takeHeapSnapshot', {})).rejects.toThrow(OUTSIDE);
  });

  it('a storage step reaches the cookies and page storage of the grant’s sites only, with the storage power', async () => {
    const chrome = await installed();
    await step(chrome, cookies('app.example'), chrome.grant);
    await expect(send(chrome, 'Network.getCookies', browserCookieRead('app.example'))).rejects.toThrow(OUTSIDE);
    const storage = await chrome.signGrant({ powers: ['storage'] });
    await step(chrome, cookies('app.example'), storage);
    await expect(send(chrome, 'Network.getCookies', browserCookieRead('bank.test'))).rejects.toThrow('CDP parameters outside signed operation');
    await send(chrome, 'Network.getCookies', browserCookieRead('app.example'));
    // A site that is not one of the grant's: refused, whatever the tab shows.
    await step(chrome, cookies('elsewhere.test'), storage);
    await expect(send(chrome, 'Network.getCookies', browserCookieRead('elsewhere.test'))).rejects.toThrow('CDP parameters outside signed operation');
    const set: RuntimeBrowserArguments = { action: 'storage', source: 'relay', targetId: 'target-1', op: 'set', kind: 'cookies', site: 'app.example', name: 'flag', value: 'on' };
    await step(chrome, set, storage);
    await expect(send(chrome, 'Network.setCookie', { name: 'flag', value: 'on', url: browserCookieUrl('bank.example') })).rejects.toThrow('CDP parameters outside signed operation');
    await send(chrome, 'Network.setCookie', { name: 'flag', value: 'on', url: browserCookieUrl('app.example') });
    // Page storage through the tab showing the site, never another.
    const local: RuntimeBrowserArguments = { action: 'storage', source: 'relay', targetId: 'target-1', op: 'get', kind: 'localStorage', site: 'app.example' };
    const evaluate = { expression: browserStorageExpression({ op: 'get', kind: 'localStorage', site: 'app.example' }), returnByValue: true, awaitPromise: true };
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://a.docs.example/', index: 1, windowId: 1, title: 'Page' });
    await step(chrome, local, storage);
    await expect(send(chrome, 'Runtime.evaluate', evaluate)).rejects.toThrow('CDP parameters outside signed operation');
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://app.example/', index: 1, windowId: 1, title: 'Page' });
    await send(chrome, 'Runtime.evaluate', evaluate);
    expect(chrome.sentCommands().filter(method => method.startsWith('Network.') || method === 'Runtime.evaluate')).toEqual(['Network.getCookies', 'Network.setCookie', 'Runtime.evaluate']);
  });
});

describe('Everything on your Chrome', () => {
  it('lets the main agent’s script reach any http(s) page until its signed expiry, marks the group, keeps the hard limits, and ends at the expiry exactly', async () => {
    const chrome = await installed({ powers: true });
    const start = Date.now();
    const expiresAt = new Date(start + 30_000).toISOString();
    const grant = await chrome.signGrant({ everything: { expiresAt } });
    const attemptId = await chrome.authorize({ type: 'execute', args: { action: 'run', source: 'relay', script: 'await page.goto("https://elsewhere.test/")' }, grant }, 'browser');
    await settle();
    expect(chrome.group.title).toBe('▶ ⚡ Checkout');
    expect(chrome.alarms.get('relay-everything')).toEqual({ when: Date.parse(expiresAt) });
    await chrome.execute({ operation: 'open', attemptId, grant, targetId: 'target-1' });
    await chrome.execute(command(attemptId, 'target-1', 'Page.navigate', { url: 'https://elsewhere.test/' }));
    await chrome.execute(command(attemptId, 'target-1', 'Network.getCookies', { urls: ['https://elsewhere.test/'] }));
    // The hard limits hold all the same.
    await expect(chrome.execute(command(attemptId, 'target-1', 'Page.navigate', { url: 'chrome://settings/' }))).rejects.toThrow('outside the sites of this script');
    await expect(chrome.execute(command(attemptId, 'target-1', 'Page.navigate', { url: 'chrome-extension://extension/popup.html' }))).rejects.toThrow('outside the sites of this script');
    await expect(chrome.execute(command(attemptId, 'target-1', 'Storage.clearDataForOrigin', { origin: 'chrome-extension://extension', storageTypes: 'all' }))).rejects.toThrow('Everything reaches the cookies and storage of http(s) sites only');
    await expect(chrome.execute(command(attemptId, 'target-1', 'Target.getTargetInfo', { targetId: 'target-2' }))).rejects.toThrow('names another tab');
    await expect(chrome.execute(command(attemptId, 'target-1', 'Target.createTarget', { url: 'https://elsewhere.test/' }))).rejects.toThrow('reaches tabs outside the workspace group');
    await expect(chrome.execute(command(attemptId, 'target-1', 'Browser.close', {}))).rejects.toThrow('controls your whole Chrome');
    await expect(chrome.execute({ operation: 'open', attemptId, grant, url: 'file:///etc/passwd' })).rejects.toThrow('outside the sites of this script');
    // A millisecond before its expiry it still holds; at its expiry it is gone, and the group's mark with it.
    setSystemTime(new Date(Date.parse(expiresAt) - 1));
    await chrome.execute(command(attemptId, 'target-1', 'Page.navigate', { url: 'https://elsewhere.test/again' }));
    setSystemTime(new Date(Date.parse(expiresAt)));
    await chrome.advance(30_000);
    expect(chrome.group.title).toBe('▶ Checkout');
    await expect(chrome.execute(command(attemptId, 'target-1', 'Page.navigate', { url: 'https://elsewhere.test/' }))).rejects.toThrow('outside the sites of this script');
    await expect(chrome.execute(command(attemptId, 'target-1', 'Network.getCookies', { urls: ['https://app.example/'] }))).rejects.toThrow('reaches the cookies, storage or credentials of your Chrome');
  });

  it('shows in the popup from the relay’s notice, and End now there ends it at once for every grant still carrying it', async () => {
    const chrome = await installed({ live: true });
    await chrome.relay(BROWSER_EXTENSION_PROTOCOL, { powers: true });
    // The hello says this extension holds agents to a grant's powers and Everything.
    expect(chrome.sent.find(message => message.hello)).toMatchObject({ powers: true });
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const groupId = chrome.grant.body.groupId;
    await chrome.fromRelay({ operation: 'everything', groupId, expiresAt });
    expect(chrome.group.title).toBe('⚡ Checkout');
    const state = await chrome.popup({ popupState: true });
    expect(state).toMatchObject({ groups: [{ groupId, everything: { until: expiresAt, available: true } }] });
    const grant = await chrome.signGrant({ everything: { expiresAt } });
    await step(chrome, { action: 'navigate', source: 'relay', targetId: 'target-1', url: 'https://elsewhere.test/' }, grant);
    await chrome.popup({ everythingEnd: groupId });
    expect(chrome.sent).toContainEqual({ everything: { groupId, action: 'end' } });
    expect(chrome.group.title).toBe('Checkout');
    // The relay still sends a grant carrying the ended expiry: it counts as without Everything.
    await step(chrome, { action: 'navigate', source: 'relay', targetId: 'target-1', url: 'https://elsewhere.test/' }, grant);
    await expect(send(chrome, 'Page.navigate', { url: 'https://elsewhere.test/' })).rejects.toThrow(OUTSIDE);
    // Ended in this Chrome across a restart of its service worker too.
    await chrome.restart();
    await expect(chrome.authorize({ type: 'execute', args: { action: 'open', source: 'relay', url: 'https://elsewhere.test/' }, grant }, 'browser')).rejects.toThrow('Destination outside workspace origins');
  });

  it('is allowed from the popup by asking the relay, and the popup shows the answer', async () => {
    const chrome = await installed({ live: true });
    await chrome.relay(BROWSER_EXTENSION_PROTOCOL, { powers: true });
    const groupId = chrome.grant.body.groupId;
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const asked = chrome.popup({ everythingGrant: groupId });
    await chrome.waitFor(() => chrome.sent.some(message => 'everything' in message));
    expect(chrome.sent).toContainEqual({ everything: { groupId, action: 'grant' } });
    await chrome.fromRelay({ operation: 'everything', groupId, expiresAt });
    expect(await asked).toMatchObject({ groups: [{ groupId, everything: { until: expiresAt } }] });
  });
});
