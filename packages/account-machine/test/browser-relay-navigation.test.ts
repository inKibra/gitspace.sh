import { createContext, runInContext } from 'node:vm';
import { setImmediate as flushMicrotasks } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { browserRelayExtension } from '../src/browser-relay-extension.js';


type EventListener = (source: { targetId: string; sessionId?: string }, method: string, params: object) => void;
function harness(timeout = 60_000, sameDocument = false, destination = 'https://approved.example/next') {
  const listeners = new Set<EventListener>();
  let updated = () => {};
  let groupId = 7;
  let url = 'https://approved.example/start';
  let detached = 0;
  let monotonic = 0;
  let wall = Date.now();
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const navigation = Promise.withResolvers<void>();
  const expiresAt = new Date(wall + timeout).toISOString();
  const context = createContext({
    crypto, TextEncoder, URL, atob, btoa, console, WebSocket,
    Date: class extends Date { static override now() { return wall; } },
    performance: { now: () => monotonic },
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { at: monotonic + delay, callback }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    indexedDB: { open: () => ({}) }, expiresAt, destination,
    chrome: {
      runtime: { onMessage: { addListener() {} } }, storage: { local: { remove: async () => {} } },
      debugger: {
        getTargets: async () => [{ id: 'target', tabId: 1, type: 'page', url }],
        attach: async () => {}, detach: async () => { detached++; },
        sendCommand: async (_source: object, method: string) => { if (method === 'Page.navigate') { navigation.resolve(); return { frameId: 'main', ...(sameDocument ? {} : { loaderId: 'new' }) }; } return {}; },
        onEvent: { addListener: (listener: EventListener) => listeners.add(listener), removeListener: (listener: EventListener) => listeners.delete(listener) }, onDetach: { addListener() {} },
      },
      tabs: { get: async () => ({ groupId, url }), onUpdated: { addListener: (listener: () => void) => { updated = listener; } } },
      tabGroups: { onRemoved: { addListener() {} } }, alarms: { create() {}, onAlarm: { addListener() {} } },
    },
  });
  runInContext(browserRelayExtension('http://127.0.0.1:9224'), context);
  runInContext(`groupRecord = async grant => ({record:{chromeGroupId:grant.groupId === 'first' ? 7 : 8}});
    const grant = {groupId:'first',origins:['approved.example'],expiresAt};
    const lease = {grant,targetId:'target',source:{targetId:'target'},sessionId:'old-session',refs:new Set(),document:0};
    channels.set('target',lease);
    authorizations.set('first',{targetId:'target',body:{expiresAt,dispatch:{deadlineAt:expiresAt},command:{type:'execute',args:{action:'navigate',url:destination},grant:{body:grant}}},used:new Set()});`, context);
  return {
    context, navigation: navigation.promise, listeners,
    advance(milliseconds: number) { monotonic += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= monotonic) { timers.delete(id); timer.callback(); } },
    rewindWallClock() { wall = 0; },
    emit(method: string, params: object, source: Parameters<EventListener>[0] = { targetId: 'target' }) { for (const listener of listeners) listener(source, method, params); },
    move(next: number, notify = true) { groupId = next; if (notify) updated(); },
    redirect(next: string) { url = next; },
    get detached() { return detached; },
    get timers() { return timers.size; },
    execute() { return runInContext("execute({operation:'command',targetId:'target',sessionId:'old-session',method:'Page.navigate',params:{url:destination}})", context); },
  };
}

it('releases dragged-out debugger ownership for a different workspace while fencing the old session', async () => {
  const h = harness();
  h.move(8);
  // Drain the asynchronous membership event without making a command that could itself fence it.
  await flushMicrotasks();
  expect(h.detached).toBe(1);
  runInContext(`const second = {groupId:'second',origins:['approved.example'],expiresAt}; authorizations.set('second',{body:{expiresAt,dispatch:{deadlineAt:expiresAt},command:{type:'execute',args:{action:'observe',targetId:'target'},grant:{body:second}}},used:new Set()});`, h.context);
  await expect(runInContext("execute({operation:'open',grant:{body:second}})", h.context)).resolves.toMatchObject({ targetId: 'target' });
  await expect(runInContext("execute({operation:'command',targetId:'target',sessionId:'old-session',method:'Page.enable'})", h.context)).rejects.toThrow();
});

it('waits for the matching main-frame loader rather than prior-document or iframe load', async () => {
  const h = harness();
  let settled = false;
  const operation = h.execute().then((value: unknown) => { settled = true; return value; });
  await h.navigation;
  h.emit('Page.lifecycleEvent', { frameId: 'main', loaderId: 'old', name: 'load' });
  h.emit('Page.lifecycleEvent', { frameId: 'iframe', loaderId: 'new', name: 'load' });
  await flushMicrotasks();
  expect(settled).toBe(false);
  h.emit('Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'load' });
  await expect(operation).resolves.toMatchObject({ loaderId: 'new', loaded: true });
  expect(h.timers).toBe(0);
  expect(h.listeners.size).toBe(1);
});

it('rejects a completed navigation redirected outside approved origins', async () => {
  const h = harness();
  const operation = h.execute();
  await h.navigation;
  await flushMicrotasks();
  h.redirect('https://foreign.example/');
  h.emit('Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'load' });
  await expect(operation).rejects.toThrow();
  expect(h.detached).toBe(1);
  expect(h.listeners.size).toBe(1);
});

it('cancels pending navigation on membership loss and removes its event listener', async () => {
  const h = harness();
  const operation = h.execute();
  void operation.catch(() => {});
  await h.navigation;
  h.move(8);
  await expect(operation).rejects.toThrow();
  expect(h.listeners.size).toBe(1);
});

it('bounds missing-load navigation by the dispatch deadline and removes its event listener', async () => {
  const h = harness(100);
  const operation = h.execute();
  void operation.catch(() => {});
  await h.navigation;
  h.advance(100);
  await expect(operation).rejects.toThrow('deadline');
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

function settledNavigation(operation: Promise<unknown>): Promise<unknown> {
  // Every mocked CDP operation resolves in microtasks; a missing completion must fail,
  // not leave the regression itself waiting on a fake timer after its test timeout.
  return Promise.race([operation, flushMicrotasks().then(() => { throw new Error('Navigation did not settle at its completion boundary'); })]);
}

it.each([
  ['https://APPROVED.EXAMPLE', 'https://approved.example/'],
  ['https://approved.example/a b#é', 'https://approved.example/a%20b#%C3%A9'],
])('completes canonicalized same-document navigation for %s while isolating other frames', async (requested, canonical) => {
  const h = harness(60_000, true, requested);
  let settled = false;
  const operation = h.execute().then((value: unknown) => { settled = true; return value; });
  await h.navigation;
  h.emit('Page.navigatedWithinDocument', { frameId: 'iframe', url: canonical });
  h.emit('Page.navigatedWithinDocument', { frameId: 'main', url: canonical }, { targetId: 'other-target' });
  h.emit('Page.navigatedWithinDocument', { frameId: 'main', url: canonical }, { targetId: 'target', sessionId: 'child-session' });
  await flushMicrotasks();
  expect(settled).toBe(false);
  h.emit('Page.navigatedWithinDocument', { frameId: 'main', url: canonical });
  await expect(settledNavigation(operation)).resolves.toMatchObject({ frameId: 'main', loaded: true });
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it('returns not fully loaded within the navigation budget and removes listeners and timers', async () => {
  const h = harness();
  const operation = h.execute();
  await h.navigation;
  await flushMicrotasks();
  h.advance(10_000);
  await expect(settledNavigation(operation)).resolves.toMatchObject({ frameId: 'main', loaded: false });
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

function delayedNavigation(h: ReturnType<typeof harness>) {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<object>();
  Object.assign(h.context, { commandStarted: started.resolve, commandResult: release.promise });
  runInContext("chrome.debugger.sendCommand = async (_source, method) => { if (method === 'Page.navigate') { commandStarted(); return commandResult; } return {}; };", h.context);
  const operation = h.execute();
  void operation.catch(() => {});
  return { started: started.promise, reply: release.resolve, operation };
}

it.each([false, true])('waits for a delayed approved reply before starting its load budget (loaded: %s)', async loaded => {
  const h = harness();
  const navigation = delayedNavigation(h);
  await navigation.started;
  h.advance(12_000);
  await flushMicrotasks();
  const settledBeforeReply = await Promise.race([navigation.operation.then(() => true, () => true), flushMicrotasks().then(() => false)]);
  h.redirect('https://approved.example/next');
  if (loaded) h.emit('Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'load' });
  navigation.reply({ frameId: 'main', loaderId: 'new' });
  await flushMicrotasks();
  expect(settledBeforeReply).toBe(false);
  if (!loaded) {
    h.advance(9_999);
    expect(await Promise.race([navigation.operation.then(() => true, () => true), flushMicrotasks().then(() => false)])).toBe(false);
    h.advance(1);
  }
  await expect(settledNavigation(navigation.operation)).resolves.toMatchObject({ frameId: 'main', loaderId: 'new', loaded });
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it.each(['origin', 'group'])('rejects a delayed reply outside its live %s rather than accepting the old page', async scope => {
  const h = harness();
  const navigation = delayedNavigation(h);
  await navigation.started;
  h.advance(12_000);
  await flushMicrotasks();
  if (scope === 'origin') h.redirect('https://foreign.example/');
  else h.move(8, false);
  navigation.reply({ frameId: 'main', loaderId: 'new' });
  await flushMicrotasks();
  h.advance(10_000);
  await expect(settledNavigation(navigation.operation)).rejects.toThrow();
  expect(h.detached).toBe(1);
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it.each([{ errorText: 'net::ERR_ABORTED' }, { isDownload: true }])('rejects a delayed failed navigation reply %j', async failure => {
  const h = harness();
  const navigation = delayedNavigation(h);
  await navigation.started;
  h.advance(12_000);
  await flushMicrotasks();
  navigation.reply({ frameId: 'main', ...failure });
  await expect(settledNavigation(navigation.operation)).rejects.toThrow('navigation failed');
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it('fails at the signed deadline when navigation never replies, even after the load budget', async () => {
  const h = harness(30_000);
  const navigation = delayedNavigation(h);
  await navigation.started;
  h.advance(12_000);
  await flushMicrotasks();
  h.advance(18_000);
  await expect(settledNavigation(navigation.operation)).rejects.toThrow('deadline');
  navigation.reply({ frameId: 'main', loaderId: 'late' });
  await flushMicrotasks();
  h.emit('Page.lifecycleEvent', { frameId: 'main', loaderId: 'late', name: 'load' });
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it('reserves time for authorization checks when the dispatch budget is shorter than the load budget', async () => {
  const h = harness(5_000);
  const operation = h.execute();
  await h.navigation;
  await flushMicrotasks();
  h.advance(4_000);
  await expect(settledNavigation(operation)).resolves.toMatchObject({ frameId: 'main', loaded: false });
  expect(h.timers).toBe(0);
});

it.each(['origin', 'group'])('rejects a slow navigation outside its live %s at budget completion', async scope => {
  const h = harness();
  const operation = h.execute();
  void operation.catch(() => {});
  await h.navigation;
  await flushMicrotasks();
  if (scope === 'origin') h.redirect('https://foreign.example/');
  else h.move(8, false);
  h.advance(10_000);
  await expect(operation).rejects.toThrow();
  expect(h.detached).toBe(1);
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it('bounds stalled navigation setup and prevents commands after the signed deadline', async () => {
  const h = harness(100);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<object>();
  const commands: string[] = [];
  Object.assign(h.context, { commandStarted: started.resolve, commandResult: release.promise, commands });
  runInContext("chrome.debugger.sendCommand = async (_source, method) => { commands.push(method); commandStarted(); return commandResult; };", h.context);
  const operation = h.execute();
  void operation.catch(() => {});
  await started.promise;
  h.advance(100);
  await expect(operation).rejects.toThrow('deadline');
  release.resolve({});
  await flushMicrotasks();
  expect(commands).toEqual(['Page.enable']);
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it('ignores a late navigation command result after the signed deadline without leaking timers', async () => {
  const h = harness(100);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<object>();
  Object.assign(h.context, { commandStarted: started.resolve, commandResult: release.promise });
  runInContext("chrome.debugger.sendCommand = async (_source, method) => { if (method === 'Page.navigate') { commandStarted(); return commandResult; } return {}; };", h.context);
  const operation = h.execute();
  void operation.catch(() => {});
  await started.promise;
  h.advance(100);
  await expect(operation).rejects.toThrow('deadline');
  release.resolve({ frameId: 'main', loaderId: 'late' });
  await flushMicrotasks();
  h.emit('Page.lifecycleEvent', { frameId: 'main', loaderId: 'late', name: 'load' });
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it('keeps the signed deadline active during the final membership recheck', async () => {
  const h = harness(10_100);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<object>();
  Object.assign(h.context, { checkStarted: started.resolve, checkResult: release.promise });
  const operation = h.execute();
  void operation.catch(() => {});
  await h.navigation;
  await flushMicrotasks();
  runInContext("chrome.tabs.get = async () => { checkStarted(); return checkResult; };", h.context);
  h.advance(10_000);
  await started.promise;
  h.advance(100);
  await expect(operation).rejects.toThrow('deadline');
  release.resolve({ groupId: 7, url: 'https://approved.example/next' });
  await flushMicrotasks();
  expect(h.listeners.size).toBe(1);
  expect(h.timers).toBe(0);
});

it('keeps an already-started navigation deadline monotonic across a backwards wall-clock jump', async () => {
  const h = harness(100);
  const operation = h.execute();
  void operation.catch(() => {});
  await h.navigation;
  h.rewindWallClock();
  h.advance(100);
  await expect(operation).rejects.toThrow('deadline');
  expect(h.listeners.size).toBe(1);
});

it('reports CDP navigation failure without retaining a load listener', async () => {
  const h = harness();
  runInContext("chrome.debugger.sendCommand = async (_source, method) => method === 'Page.navigate' ? {errorText:'net::ERR_ABORTED'} : {}", h.context);
  await expect(h.execute()).rejects.toThrow('navigation failed');
  expect(h.listeners.size).toBe(1);
});

it('does not let an old active operation inherit the replacement workspace channel', async () => {
  const h = harness();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<object>();
  Object.assign(h.context, { effectStarted: started.resolve, effectResult: release.promise });
  runInContext("authorizations.get('first').body.command.args = {action:'evaluate',expression:'document.title'}; chrome.debugger.sendCommand = async () => { effectStarted(); return effectResult; };", h.context);
  const operation = runInContext("execute({operation:'command',targetId:'target',sessionId:'old-session',method:'Runtime.evaluate',params:{expression:'document.title',returnByValue:true,awaitPromise:true}})", h.context);
  void operation.catch(() => {});
  await started.promise;
  h.move(8);
  await flushMicrotasks();
  runInContext(`const second = {groupId:'second',origins:['approved.example'],expiresAt}; authorizations.set('second',{body:{expiresAt,dispatch:{deadlineAt:expiresAt},command:{type:'execute',args:{action:'observe',targetId:'target'},grant:{body:second}}},used:new Set()});`, h.context);
  await runInContext("execute({operation:'open',grant:{body:second}})", h.context);
  release.resolve({ result: { value: 'old page' } });
  await expect(operation).rejects.toThrow();
  expect(runInContext("channels.get('target').grant.groupId", h.context)).toBe('second');
});

