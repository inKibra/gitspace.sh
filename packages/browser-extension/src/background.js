// The extension's service worker. Bundled by `src/build.ts`; the download prepends the account it belongs to as
// `const GITSPACE_ACCOUNT_URL = "https://<account>"`.
import { browserScreenshotPrepareFunction, browserScreenshotRestoreFunction } from '@gitspace/runtime-machine/browser-screenshot';
import { permitted, relayCommandAllowed, relayRunCommand, relayRunEvent, tabWithinGrant } from './commands.ts';
import { verifyRelayAuthorization } from './authorization.ts';

const endpoint = new URL('/api/browser-relay/extension', GITSPACE_ACCOUNT_URL).href.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const allowed = relayCommandAllowed;
const prepareScreenshot = browserScreenshotPrepareFunction;
const restoreScreenshot = browserScreenshotRestoreFunction;
const verifyAuthorization = verifyRelayAuthorization;
const database = (() => { const deferred = Promise.withResolvers(); const request = indexedDB.open('gitspace-relay-identity', 1); request.onupgradeneeded = () => request.result.createObjectStore('state'); request.onsuccess = () => deferred.resolve(request.result); request.onerror = () => deferred.reject(request.error); return deferred.promise; })();
async function stored(key) { const db = await database; const deferred = Promise.withResolvers(); const request = db.transaction('state').objectStore('state').get(key); request.onsuccess = () => deferred.resolve(request.result); request.onerror = () => deferred.reject(request.error); return deferred.promise; }
async function persist(key, value) { const db = await database; const deferred = Promise.withResolvers(); const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, key); tx.oncomplete = deferred.resolve; tx.onerror = () => deferred.reject(tx.error); tx.onabort = () => deferred.reject(tx.error); return deferred.promise; }
let pairingCode;
let identityGeneration = 0;
let managingIdentity = false;
let identityOperations = Promise.resolve();
const authorizations = new Map();
/** Scripts (`browser.run`) by attempt id, apart from each group's single-step authorization: a single step during a
 * script does not end it. `targets` are the tabs the script opened or attached to. */
const runs = new Map();
const encode64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function authorize(authorization) {
  const identity = await stored('identity'); if (!identity) throw new Error('Human pairing required');
  const body = await verifyAuthorization(authorization, identity.trust);
  if (body.scope.placement?.kind !== 'account-relay' || body.scope.placement.pairingId !== identity.pairingId || body.scope.placement.generation !== identity.generation) throw new Error('Paired account relay scope mismatch');
  const replayKey = JSON.stringify([body.scope.projectId, body.scope.workspaceId, body.scope.attemptId]);
  const db = await database;
  const replay = Promise.withResolvers(); const tx = db.transaction('state', 'readwrite'); const store = tx.objectStore('state');
  const request = store.get('replays');
  request.onsuccess = () => {
    const entries = (request.result || []).filter(entry => entry[1] > Date.now());
    if (entries.some(entry => entry[0] === replayKey) || entries.length >= 10000) { tx.abort(); return; }
    entries.push([replayKey, Date.parse(body.expiresAt)]); store.put(entries, 'replays');
    const generationKey = 'generation:' + JSON.stringify([body.scope.projectId,body.scope.workspaceId,body.scope.placement.pairingId]);
    const generation = store.get(generationKey);
    generation.onsuccess = () => { if (generation.result !== undefined && generation.result > body.scope.placement.generation) { tx.abort(); return; } store.put(body.scope.placement.generation, generationKey); };
  };
  tx.oncomplete = replay.resolve; tx.onerror = () => replay.reject(new Error('Authorization replay persistence failed')); tx.onabort = () => replay.reject(new Error('Replayed or fenced authorization, or replay capacity exhausted')); await replay.promise;
  for (const [id, channel] of channels) if (channel.grant.projectId === body.scope.projectId && channel.grant.workspaceId === body.scope.workspaceId && channel.grant.placement.pairingId === body.scope.placement.pairingId && channel.grant.placement.generation < body.scope.placement.generation) { authorizations.delete(channel.grant.groupId); await fence(id); }
  for (const [attemptId, run] of runs) if (run.body.scope.projectId === body.scope.projectId && run.body.scope.workspaceId === body.scope.workspaceId && run.body.scope.placement.pairingId === body.scope.placement.pairingId && run.body.scope.placement.generation < body.scope.placement.generation) runs.delete(attemptId);
  const command = body.command;
  const id = command.type === 'execute' ? command.grant.body.groupId : command.type === 'manage' ? 'management' : command.groupId;
  if (command.type === 'execute') {
    if (command.args.source !== 'relay') throw new Error('Relay source required');
    if (command.args.action === 'open' && command.args.url && !permitted(command.grant.body, command.args.url)) throw new Error('Destination outside workspace origins');
    if (command.args.action === 'run') { runs.set(body.scope.attemptId, { body, targets: new Set() }); return {}; }
  }
  authorizations.set(id, { body, used: new Set() });
  return {};
}
const EXTENSION_PROTOCOL = BROWSER_EXTENSION_PROTOCOL;
/** Set when the account refuses this extension, or this extension refuses the account, as incompatible. */
let incompatible = false;
let socket;
const channels = new Map();
const queues = new Map();
const releases = new Map();
/** The relay closes a connection whose frame is longer than this; a frame from it can be longer (a script's injected
 * source), up to `RELAY_INBOUND_LIMIT`. */
const RELAY_FRAME_LIMIT = 2_000_000;
const RELAY_INBOUND_LIMIT = 4_000_000;
/** A reply too long for the relay becomes that command's error, and such an event is dropped, so the connection lives. */
function send(value) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const frame = JSON.stringify(value);
  if (frame.length <= RELAY_FRAME_LIMIT) socket.send(frame);
  else if (value.id !== undefined) socket.send(JSON.stringify({ id: value.id, error: { message: `Result too large for the relay (${frame.length} characters)` } }));
}
async function targets() { return (await chrome.debugger.getTargets()).filter(target => target.type === 'page'); }
async function targetInfo(id) { const target = (await targets()).find(target => target.id === id); if (!target || !Number.isInteger(target.tabId)) throw new Error('Unknown exact tab target'); return target; }
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];
/** A workspace keeps one colour wherever its group is recreated. */
function groupColor(workspaceId) { let hash = 0; for (const character of workspaceId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return GROUP_COLORS[hash % GROUP_COLORS.length]; }
function siteOf(url) { try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname : null; } catch { return null; } }
/** The grant as it applies to one tab: a tab you dragged in is also usable on the site it showed then. */
function scoped(grant, record, tabId) { const entry = record?.members?.[tabId]; return entry?.by === 'you' && entry.site ? { ...grant, origins: [...grant.origins, entry.site] } : grant; }
async function retireGroup(groupId, closeTabs = false) {
  // Keep the fence after identity reset, browser restart, and replacement group creation.
  await persist('retired-group:' + groupId, true);
  authorizations.delete(groupId);
  for (const [attemptId, run] of runs) if (run.body.command.grant.body.groupId === groupId) runs.delete(attemptId);
  for (const [id, channel] of channels) if (channel.grant.groupId === groupId) await fence(id);
  const db = await database; const keys = Promise.withResolvers();
  const request = db.transaction('state').objectStore('state').getAllKeys();
  request.onsuccess = () => keys.resolve(request.result); request.onerror = () => keys.reject(request.error);
  const { browserEpoch } = closeTabs ? await chrome.storage.session.get('browserEpoch') : {};
  for (const key of await keys.promise) if (typeof key === 'string' && (key.startsWith('group:') || (closeTabs && key.startsWith('closing-group:')))) {
    const record = await stored(key);
    if (record?.groupId !== groupId) continue;
    if (closeTabs) {
      const closingKey = 'closing-group:' + groupId + ':' + record.chromeGroupId;
      if (browserEpoch && record.browserEpoch === browserEpoch) {
        // Keep ownership through a failed close, group replacement, and service-worker restart.
        await persist(closingKey, record);
        // Tabs the agent or its pages opened close; tabs you added leave the group and stay open.
        const tabs = (await chrome.tabs.query({ groupId: record.chromeGroupId })).filter(tab => tab.groupId === record.chromeGroupId && Number.isInteger(tab.id));
        const closing = tabs.filter(tab => ['agent', 'page'].includes(record.members?.[tab.id]?.by)).map(tab => tab.id);
        const yours = tabs.filter(tab => !closing.includes(tab.id)).map(tab => tab.id);
        if (closing.length) await chrome.tabs.remove(closing);
        if (yours.length) await chrome.tabs.ungroup(yours);
      }
      await persist(closingKey, null);
    }
    await persist(key, null);
  }
}
async function groupRecord(grant, establish = false) {
  if (await stored('retired-group:' + grant.groupId)) throw new Error('Workspace group retired');
  const identity = await stored('identity');
  const scope = JSON.stringify([identity.trust.accountId, identity.pairingId, grant.projectId, grant.workspaceId]);
  const key = 'group:' + scope;
  const bindingKey = 'group-binding:' + scope;
  const record = await stored(key);
  const binding = await stored(bindingKey);
  const previous = binding || record?.groupId;
  if (previous && previous !== grant.groupId) {
    if (!establish) throw new Error('Workspace group binding mismatch');
    await retireGroup(previous);
  }
  if (establish && binding !== grant.groupId) await persist(bindingKey, grant.groupId);
  let { browserEpoch } = await chrome.storage.session.get('browserEpoch');
  if (!browserEpoch) { browserEpoch = crypto.randomUUID(); await chrome.storage.session.set({browserEpoch}); }
  if (record && record.groupId !== grant.groupId) return {key,browserEpoch};
  if (record && record.browserEpoch !== browserEpoch) { await persist(key,null); return {key,browserEpoch}; }
  if (record) { try { await chrome.tabGroups.get(record.chromeGroupId); } catch { await persist(key, null); return { key, browserEpoch }; } }
  return { key, record, browserEpoch };
}
async function member(grant, targetId) {
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Workspace group grant expired');
  const { record } = await groupRecord(grant);
  const target = await targetInfo(targetId);
  const tab = await chrome.tabs.get(target.tabId);
  const scope = scoped(grant, record, tab.id);
  if (!record || tab.groupId !== record.chromeGroupId || !tabWithinGrant(scope, { tabUrl: tab.url, pendingUrl: tab.pendingUrl, targetUrl: target.url })) throw new Error('Target outside workspace group or origins');
  return { ...target, scope, addedBy: record.members?.[tab.id]?.by ?? 'you' };
}
async function groupRecords() {
  const db = await database; const keys = Promise.withResolvers();
  const request = db.transaction('state').objectStore('state').getAllKeys();
  request.onsuccess = () => keys.resolve(request.result); request.onerror = () => keys.reject(request.error);
  const found = [];
  for (const key of await keys.promise) if (typeof key === 'string' && key.startsWith('group:')) { const record = await stored(key); if (record) found.push({ key, record }); }
  return found;
}
/** Group record changes run one at a time, so one membership change never overwrites another. */
let membership = Promise.resolve();
function serially(operation) { const step = membership.catch(() => {}).then(operation); membership = step; return step; }
function updateRecord(key, change) { return serially(async () => { const record = change(await stored(key)); await persist(key, record); return record; }); }
function without(members, tabId) { const next = { ...members }; delete next[tabId]; return next; }
/** Tabs being grouped for an agent, and tabs a group member opened: neither consents to a site. */
const agentTabs = new Set();
const pageTabs = new Set();
/** Puts a tab in the record of the group it is now in, and out of any other. Only a tab you dragged in (`dragged`)
 * consents to the site it shows; one you created in the group starts with the grant's origins alone. */
function join(tab, dragged) {
  return serially(async () => {
    const records = await groupRecords();
    for (const { key, record } of records) if (record.members?.[tab.id] && record.chromeGroupId !== tab.groupId) { await persist(key, { ...record, members: without(record.members, tab.id) }); scheduleReport(record.groupId); }
    const found = records.find(({ record }) => record.chromeGroupId === tab.groupId);
    if (!found || found.record.members?.[tab.id]) return;
    const by = agentTabs.has(tab.id) ? 'agent' : pageTabs.has(tab.id) ? 'page' : 'you';
    pageTabs.delete(tab.id);
    await persist(found.key, { ...found.record, members: { ...found.record.members, [tab.id]: { by, site: by === 'you' && dragged ? siteOf(tab.url) : null } } });
    scheduleReport(found.record.groupId);
  });
}
function leave(tabId) {
  pageTabs.delete(tabId);
  return serially(async () => { for (const { key, record } of await groupRecords()) if (record.members?.[tabId]) { await persist(key, { ...record, members: without(record.members, tabId) }); scheduleReport(record.groupId); } });
}
/** Reports coalesce: a page load fires several tab updates. */
const reportTimers = new Map();
function scheduleReport(groupId) { clearTimeout(reportTimers.get(groupId)); reportTimers.set(groupId, setTimeout(() => { reportTimers.delete(groupId); void report(groupId).catch(() => {}); }, 300)); }
/** Tells the account which tabs are in a workspace group now; a group that is gone reports none. */
async function report(groupId) {
  const found = (await groupRecords()).find(({ record }) => record.groupId === groupId);
  const tabs = found ? await chrome.tabs.query({ groupId: found.record.chromeGroupId }) : [];
  const targetIds = new Map((await targets()).map(target => [target.tabId, target.id]));
  send({ group: { groupId, tabs: tabs.filter(tab => targetIds.has(tab.id)).slice(0, 200).map(tab => {
    const entry = found.record.members?.[tab.id];
    return { targetId: targetIds.get(tab.id), url: (tab.url || '').slice(0, 8192), title: (tab.title || '').slice(0, 500), addedBy: entry?.by ?? 'you', site: entry?.by === 'you' ? entry.site ?? null : null };
  }) } });
}
/** When the agent last used each group. A group idle this long collapses once. */
const lastUsed = new Map();
const IDLE_COLLAPSE_MS = 2 * 60_000;
async function collapseIdle() {
  for (const [groupId, at] of lastUsed) {
    if (Date.now() - at < IDLE_COLLAPSE_MS) continue;
    lastUsed.delete(groupId);
    const found = (await groupRecords()).find(({ record }) => record.groupId === groupId);
    // Collapsing the group holding the tab you are looking at would switch tabs under you.
    if (!found || (await chrome.tabs.query({ groupId: found.record.chromeGroupId, active: true })).length) continue;
    await chrome.tabGroups.update(found.record.chromeGroupId, { collapsed: true });
  }
}
async function revoke(id) {
  const channel = channels.get(id); channels.delete(id);
  if (!channel) return releases.get(id);
  channel.cancelNavigation?.();
  const release = chrome.debugger.detach(channel.source).catch(() => {});
  releases.set(id, release);
  try { await release; } finally { if (releases.get(id) === release) releases.delete(id); }
}
async function fence(id) { send({ targetId: id, fenced: true }); await revoke(id); }
async function check(id, expected = channels.get(id)) {
  if (!expected || channels.get(id) !== expected) throw new Error('Unknown or revoked target channel');
  try { ({ scope: expected.scope, addedBy: expected.addedBy } = await member(expected.grant, expected.targetId)); }
  catch (error) { if (channels.get(id) === expected) await fence(id); throw error; }
  if (channels.get(id) !== expected) throw new Error('Unknown or revoked target channel');
  return expected;
}
/** Whether a script is inside its signed deadline. */
function live(run) { const now = Date.now(); return Date.parse(run.body.expiresAt) > now && Date.parse(run.body.dispatch.deadlineAt) > now; }
async function activeRun(attemptId) {
  const run = runs.get(attemptId);
  if (!run) throw new Error('Signed browser script required');
  if (!live(run)) { await endRun(attemptId); throw new Error('Browser script deadline passed'); }
  return run;
}
/** Ends a script. Its tabs stay in the group; the debugger leaves those no other script drives, which drops whatever
 * the script set on them (overrides, interception, bindings). A later single step attaches again. */
async function endRun(attemptId) {
  const run = runs.get(attemptId);
  runs.delete(attemptId);
  if (!run) return;
  for (const targetId of run.targets) if (![...runs.values()].some(other => other.targets.has(targetId))) await revoke(targetId);
}
/** Events of a script's tab go out in order; one membership check covers the events that arrived before it began. */
function forward(id, lease, event) {
  if (lease.forwarding) { lease.forwarding.push(event); return; }
  const pending = [event];
  lease.forwarding = pending;
  void (async () => {
    try { while (pending.length) { const count = pending.length; await check(id, lease); for (const item of pending.splice(0, count)) send(item); } }
    catch {}
    finally { if (lease.forwarding === pending) delete lease.forwarding; }
  })();
}
async function describeTarget(targetId) { const target = await targetInfo(targetId); return { targetInfo: { targetId: target.id, type: 'page', title: target.title, url: target.url, attached: true } }; }
async function closeTab(lease) { const target = await member(lease.grant, lease.targetId); await chrome.tabs.remove(target.tabId); channels.delete(lease.targetId); }
async function fixedCall(lease, declaration, args = [], objectId) {
  const params = { functionDeclaration: declaration, arguments: args.map(value => ({ value })), returnByValue: true, ...(objectId ? { objectId } : { executionContextId: await isolatedContext(lease) }) };
  const result = await chrome.debugger.sendCommand(lease.source, 'Runtime.callFunctionOn', params);
  if (result.exceptionDetails) throw new Error('Internal browser operation failed');
  return result.result?.value;
}
async function isolatedContext(lease) {
  const tree = await chrome.debugger.sendCommand(lease.source, 'Page.getFrameTree');
  const world = await chrome.debugger.sendCommand(lease.source, 'Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'gitspace-relay' });
  return world.executionContextId;
}
async function constrainCommand(lease, id, method, params) {
  const authorization = authorizations.get(lease.grant.groupId);
  if (!authorization || authorization.body.command.type !== 'execute' || Date.parse(authorization.body.expiresAt) <= Date.now() || Date.parse(authorization.body.dispatch.deadlineAt) <= Date.now()) throw new Error('Current signed operation required');
  const { args, grant: signed } = authorization.body.command;
  const grant = signed.body;
  if (grant.groupId !== lease.grant.groupId || authorization.targetId !== lease.targetId) throw new Error('Operation target scope mismatch');
  const exact = expected => JSON.stringify(Object.entries(params).sort()) === JSON.stringify(Object.entries(expected).sort());
  let accepted = false;
  let once = false;
  if (method === 'Page.getFrameTree') accepted = exact({});
  if (method === 'Target.attachToTarget') accepted = params.flatten === true && Object.keys(params).length === 2 && lease.targetId === params.targetId;
  if (method === 'Target.getTargetInfo') accepted = Object.keys(params).length === 1 && lease.targetId === params.targetId;
  if (method === 'Page.enable' || method === 'DOM.enable') accepted = exact({});
  if (method === 'Page.navigate') { accepted = ['open', 'navigate'].includes(args.action) && exact({ url: args.url }); once = true; }
  if (method === 'Runtime.evaluate') { accepted = args.action === 'evaluate' && exact({ expression: args.expression, returnByValue: true, awaitPromise: true }); once = true; }
  if (method === 'Target.closeTarget') { accepted = args.action === 'close' && exact({ targetId: lease.targetId }); once = true; }
  if (method === 'Accessibility.getFullAXTree') accepted = args.action === 'observe' && exact({ depth: 32 });
  if (args.action === 'act') {
    const parts = args.ref.split(':'); const backendNodeId = Number(parts[1]);
    if (parts.length !== 2 || Number(parts[0]) !== lease.document || !Number.isSafeInteger(backendNodeId) || !lease.refs.has(backendNodeId)) throw new Error('Unobserved or stale reference');
    if (['DOM.describeNode', 'GitSpace.validateRef', 'DOM.getBoxModel', 'DOM.scrollIntoViewIfNeeded', 'DOM.focus'].includes(method)) accepted = exact({ backendNodeId }) && (method !== 'DOM.focus' || args.operation !== 'click');
    if (method === 'Input.insertText') { accepted = args.operation === 'fill' && exact({ text: args.value }) && authorization.used.has('focus') && authorization.used.has('Input.dispatchKeyEvent:keyUp'); once = true; }
    if (method === 'Input.dispatchMouseEvent' && args.operation === 'click') {
      const box = await chrome.debugger.sendCommand(lease.source, 'DOM.getBoxModel', { backendNodeId }); const q = box.model.content;
      accepted = ['mousePressed', 'mouseReleased'].includes(params.type) && exact({ type: params.type, x: (q[0]+q[2]+q[4]+q[6])/4, y: (q[1]+q[3]+q[5]+q[7])/4, button: 'left', clickCount: 1 }) && (params.type !== 'mouseReleased' || authorization.used.has('Input.dispatchMouseEvent:mousePressed')); once = true;
    }
    if (method === 'Input.dispatchKeyEvent' && authorization.used.has('focus')) {
      const keys = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32 };
      if (args.operation === 'press' && keys[args.value]) accepted = exact({ type: params.type, key: args.value, windowsVirtualKeyCode: keys[args.value] });
      if (args.operation === 'fill') accepted = params.type === 'keyDown' ? [2,4].includes(params.modifiers) && exact({ type:'keyDown',key:'a',code:'KeyA',modifiers:params.modifiers,commands:['selectAll'] }) : exact({type:'keyUp',key:'a',code:'KeyA'});
      accepted = accepted && ['keyDown','keyUp'].includes(params.type) && (params.type !== 'keyUp' || authorization.used.has('Input.dispatchKeyEvent:keyDown')); once = true;
    }
  }
  if (args.action === 'screenshot' || (args.action === 'observe' && args.screenshot)) {
    if (method === 'GitSpace.screenshotPrepare') accepted = Object.keys(params).length === 1 && Array.isArray(params.refs) && params.refs.length <= 100 && params.refs.every(ref => lease.refs.has(ref.backendNodeId) && typeof ref.ref === 'string' && ref.ref.split(':').length === 2 && Number.isSafeInteger(Number(ref.ref.split(':')[0])) && Number(ref.ref.split(':')[1]) === ref.backendNodeId);
    if (method === 'GitSpace.screenshotRestore') accepted = exact({});
    if (method === 'Page.captureScreenshot') { const v = lease.viewport; const c = params.clip; accepted = !!v && params.format === 'jpeg' && params.quality === 60 && params.captureBeyondViewport === false && Object.keys(params).length === 4 && c && Object.keys(c).length === 5 && c.x === 0 && c.y === 0 && c.width === v.width && c.height === v.height && [1,0.5,0.25].some(factor => c.scale === Math.min(1,1280/v.width,1280/v.height)*factor); }
  }
  if (!accepted) throw new Error('CDP parameters outside signed operation');
  const effectKey = method + (params.type ? ':' + params.type : '');
  if (once && authorization.used.has(effectKey)) throw new Error('Operation effect already consumed');
  if (once) authorization.used.add(effectKey);
  if (method === 'DOM.focus') authorization.used.add('focus');
}
async function navigate(lease, params) {
  const authorization = authorizations.get(lease.grant.groupId);
  const expiresAt = Math.min(Date.parse(authorization.body.expiresAt), Date.parse(authorization.body.dispatch.deadlineAt));
  const deadline = performance.now() + Math.max(0, expiresAt - Date.now());
  const completion = Promise.withResolvers();
  const interrupted = Promise.withResolvers();
  void interrupted.promise.catch(() => {});
  let timer;
  let loadTimer;
  let result;
  let stopped = false;
  const active = () => {
    if (performance.now() >= deadline || Date.now() >= expiresAt) throw new Error('Navigation deadline exceeded');
    if (stopped || authorizations.get(lease.grant.groupId) !== authorization || channels.get(lease.targetId) !== lease) throw new Error('Navigation channel revoked');
  };
  const events = [];
  const accept = (method, event) => {
    if (stopped) return;
    if (!result) { events.push([method, event]); return; }
    // Chrome canonicalizes same-document URLs; the returned main frame is authoritative.
    if (result.loaderId ? method === 'Page.lifecycleEvent' && event.name === 'load' && event.frameId === result.frameId && event.loaderId === result.loaderId : method === 'Page.navigatedWithinDocument' && event.frameId === result.frameId) completion.resolve(true);
  };
  const listener = (source, method, event) => { if (!source.sessionId && source.targetId === lease.targetId && ['Page.lifecycleEvent', 'Page.navigatedWithinDocument'].includes(method)) accept(method, event); };
  const cancel = () => { stopped = true; interrupted.reject(new Error('Navigation channel revoked')); };
  const expire = () => { const remaining = deadline - performance.now(); if (remaining <= 0) { stopped = true; interrupted.reject(new Error('Navigation deadline exceeded')); } else timer = setTimeout(expire, remaining); };
  lease.cancelNavigation = cancel;
  expire();
  try {
    const command = (async () => {
      active();
      await chrome.debugger.sendCommand(lease.source, 'Page.enable');
      active();
      await chrome.debugger.sendCommand(lease.source, 'Page.setLifecycleEventsEnabled', { enabled: true });
      active();
      await check(lease.targetId, lease);
      active();
      chrome.debugger.onEvent.addListener(listener);
      result = await chrome.debugger.sendCommand(lease.source, 'Page.navigate', params);
      active();
      if (result.errorText || result.isDownload) throw new Error('Approved navigation failed');
      const loadDeadline = Math.min(performance.now() + 10000, deadline - 1000);
      loadTimer = setTimeout(() => completion.resolve(false), Math.max(0, loadDeadline - performance.now()));
      for (const [method, event] of events) accept(method, event);
      events.length = 0;
      const loaded = await Promise.race([completion.promise, interrupted.promise]);
      active();
      await check(lease.targetId, lease);
      active();
      lease.refs.clear();
      return { ...result, loaded };
    })();
    return await Promise.race([command, interrupted.promise]);
  } finally {
    stopped = true;
    events.length = 0;
    clearTimeout(timer);
    clearTimeout(loadTimer);
    chrome.debugger.onEvent.removeListener(listener);
    if (lease.cancelNavigation === cancel) delete lease.cancelNavigation;
  }
}
async function groupTabs(grant) {
  const { record } = await groupRecord(grant, true); if (!record) return [];
  const result = [];
  for (const target of await targets()) { try { await member(grant, target.id); result.push({targetId:target.id, title:(target.title || '').slice(0,500), url:target.url, addedBy:record.members?.[target.tabId]?.by ?? 'you'}); } catch {} }
  return result;
}
/** Opens a background tab in the workspace group, recorded as the agent's. */
async function createAgentTab(grant, url) {
  if (!permitted(grant, url)) throw new Error('An allowed destination is required');
  const {key, record, browserEpoch} = await groupRecord(grant);
  const tab = await chrome.tabs.create({ url, active: false });
  agentTabs.add(tab.id);
  let targetId;
  try {
    const chromeGroupId = await chrome.tabs.group({tabIds:[tab.id], ...(record ? {groupId:record.chromeGroupId} : {})});
    await chrome.tabGroups.update(chromeGroupId, {title:grant.groupName, color:groupColor(grant.workspaceId), collapsed:false});
    await updateRecord(key, current => ({ groupId: grant.groupId, chromeGroupId, browserEpoch, members: { ...(current?.chromeGroupId === chromeGroupId ? current.members : {}), [tab.id]: { by: 'agent', site: null } } }));
    scheduleReport(grant.groupId);
    const deadline = performance.now()+10000;
    while (!targetId && performance.now()<deadline) { targetId = (await targets()).find(target => target.tabId === tab.id)?.id; if (!targetId) { const pause = Promise.withResolvers(); setTimeout(pause.resolve,25); await pause.promise; } }
    if (!targetId) throw new Error('New tab target unavailable');
  } catch(error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
  finally { agentTabs.delete(tab.id); }
  return targetId;
}
/** The debugger channel of a tab in the group, attached on first use. */
async function attach(grant, targetId) {
  await member(grant, targetId);
  await releases.get(targetId);
  let channel = channels.get(targetId);
  if (channel && channel.grant.groupId !== grant.groupId) { try { await check(targetId, channel); } catch {} await releases.get(targetId); channel = channels.get(targetId); }
  if (channel && channel.grant.groupId !== grant.groupId) throw new Error('Target already bound to another workspace');
  if (!channel) {
    const source = {targetId}; await chrome.debugger.attach(source,'1.3');
    channel = {grant,targetId,source,sessionId:crypto.randomUUID(),refs:new Set(),document:0}; channels.set(targetId,channel);
  } else channel.grant = grant;
  await check(targetId, channel);
  return channel;
}
/** Script commands per tab: each waits only until the one before it reached Chrome. */
const admissions = new Map();
/** One command of a script on a tab it opened, checked with the run allowlist (`relayRunCommand`) between membership checks. */
async function runCommand(message) {
  const { targetId, attemptId, method, params = {}, sessionId } = message;
  const previous = admissions.get(targetId);
  const admitted = Promise.withResolvers();
  admissions.set(targetId, admitted.promise);
  let lease;
  let effect;
  try {
    await previous;
    const run = await activeRun(attemptId);
    lease = await check(targetId);
    if (lease.grant.groupId !== run.body.command.grant.body.groupId || !run.targets.has(targetId)) throw new Error('Tab not opened by this script');
    const verdict = relayRunCommand(method, params, { grant: lease.scope, targetId, session: lease.sessionId, sessionId, addedBy: lease.addedBy });
    if ('refused' in verdict) throw new Error(verdict.refused);
    lastUsed.set(lease.grant.groupId, Date.now());
    if ('noop' in verdict) return {};
    if (method === 'Target.closeTarget' || method === 'Page.close') { await closeTab(lease); return method === 'Page.close' ? {} : { success: true }; }
    effect = method === 'Target.attachToTarget' ? { sessionId: lease.sessionId } : method === 'Target.getTargetInfo' ? describeTarget(targetId) : chrome.debugger.sendCommand(lease.source, method, verdict.send);
  } finally {
    admitted.resolve();
    if (admissions.get(targetId) === admitted.promise) admissions.delete(targetId);
  }
  const result = await effect;
  await check(targetId, lease);
  return result;
}
async function execute(message) {
  if (message.operation === 'authorize') return authorize(message.authorization);
  if (message.operation === 'prepare') {
    const authorization = authorizations.get(message.groupId);
    if (!authorization || authorization.body.command.type !== 'prepare' || Date.parse(authorization.body.expiresAt) <= Date.now() || Date.parse(authorization.body.dispatch.deadlineAt) <= Date.now() || authorization.used.has('prepare')) throw new Error('Signed workspace preparation required');
    authorization.used.add('prepare'); return {};
  }
  if (message.operation === 'revoke') { await retireGroup(message.groupId, true); return {}; }
  if (message.operation === 'tabs' && message.attemptId !== undefined) {
    const grant = (await activeRun(message.attemptId)).body.command.grant.body;
    if (grant.groupId !== message.groupId) throw new Error('Script workspace group mismatch');
    return groupTabs(grant);
  }
  if (message.operation === 'tabs') {
    const authorization = authorizations.get(message.groupId);
    if (!authorization || authorization.body.command.type !== 'execute' || authorization.body.command.args.action !== 'tabs' || Date.parse(authorization.body.expiresAt) <= Date.now() || Date.parse(authorization.body.dispatch.deadlineAt) <= Date.now() || authorization.used.has('tabs')) throw new Error('Signed group discovery required');
    authorization.used.add('tabs');
    return groupTabs(authorization.body.command.grant.body);
  }
  if (message.operation === 'open' && message.attemptId !== undefined) {
    const run = await activeRun(message.attemptId);
    if (JSON.stringify(run.body.command.grant) !== JSON.stringify(message.grant)) throw new Error('Signed target binding required');
    if (message.targetId && message.url) throw new Error('Open an existing tab or a destination, not both');
    const grant = message.grant.body;
    await groupRecord(grant, true);
    const targetId = message.targetId || await createAgentTab(grant, message.url || 'about:blank');
    const channel = await attach(grant, targetId);
    run.targets.add(targetId);
    lastUsed.set(grant.groupId, Date.now());
    return { targetId, sessionId: channel.sessionId };
  }
  if (message.operation === 'open') {
    const signed = message.grant;
    const grant = signed.body;
    const authorization = authorizations.get(grant.groupId);
    if (!authorization || authorization.body.command.type !== 'execute' || JSON.stringify(authorization.body.command.grant) !== JSON.stringify(signed) || Date.parse(authorization.body.expiresAt) <= Date.now() || Date.parse(authorization.body.dispatch.deadlineAt) <= Date.now() || authorization.used.has('open')) throw new Error('Signed target binding required');
    authorization.used.add('open');
    const args = authorization.body.command.args;
    await groupRecord(grant, true);
    let targetId = args.targetId;
    if (args.action === 'open' && !targetId) targetId = await createAgentTab(grant, args.url || 'about:blank');
    if (!targetId) throw new Error('An exact workspace target is required');
    const channel = await attach(grant, targetId);
    authorization.targetId = targetId;
    lastUsed.set(grant.groupId, Date.now());
    return {targetId,sessionId:channel.sessionId};
  }
  if (message.operation === 'release') { await endRun(message.attemptId); return {}; }
  if (message.operation !== 'command') throw new Error('Unsupported relay operation');
  // Before any await: the script's commands reach its tab in the order they arrived.
  if (message.attemptId !== undefined) return runCommand(message);
  const lease = await check(message.targetId);
  const { method, params = {}, sessionId } = message;
  if (!allowed(lease.scope, lease.targetId, lease.sessionId, method, params, sessionId)) throw new Error('Command outside browser grant');
  lastUsed.set(lease.grant.groupId, Date.now());
  await constrainCommand(lease, message.targetId, method, params);
  await check(message.targetId, lease);
  let result;
  if (method === 'Target.attachToTarget') result = { sessionId: lease.sessionId };
  else if (method === 'Target.getTargetInfo') result = await describeTarget(lease.targetId);
  else if (method === 'Target.closeTarget') { await closeTab(lease); return { success: true }; }
  else if (method === 'GitSpace.validateRef') {
    if (!Number.isSafeInteger(params.backendNodeId)) throw new Error('Invalid node');
    const resolved = await chrome.debugger.sendCommand(lease.source, 'DOM.resolveNode', { backendNodeId: params.backendNodeId, executionContextId: await isolatedContext(lease) });
    try { result = await fixedCall(lease, 'function(){return {connected:this.isConnected && this.ownerDocument===document}}', [], resolved.object.objectId); }
    finally { await chrome.debugger.sendCommand(lease.source, 'Runtime.releaseObject', { objectId: resolved.object.objectId }); }
  } else if (method === 'GitSpace.screenshotPrepare') {
    if (!Array.isArray(params.refs) || params.refs.length > 200) throw new Error('Invalid screenshot references');
    const boxes = [];
    for (const ref of params.refs) {
      if (!Number.isSafeInteger(ref.backendNodeId) || typeof ref.ref !== 'string' || ref.ref.length > 80) throw new Error('Invalid screenshot reference');
      try { const box = await chrome.debugger.sendCommand(lease.source, 'DOM.getBoxModel', { backendNodeId: ref.backendNodeId }); boxes.push({ ref: ref.ref, x: box.model.border[0], y: box.model.border[1] }); } catch {}
    }
    result = await fixedCall(lease, prepareScreenshot, [boxes]);
    lease.viewport = result;
  } else if (method === 'GitSpace.screenshotRestore') { result = await fixedCall(lease, restoreScreenshot); lease.viewport = undefined; }
  else if (method === 'Page.navigate') return navigate(lease, params);
  else {
    if (method === 'Accessibility.getFullAXTree') { const document = lease.document; result = await chrome.debugger.sendCommand(lease.source, method, { depth: 32 }); if (document !== lease.document) throw new Error('Document changed during observation'); result.gitspaceDocument = document; for (const node of result.nodes || []) if (Number.isSafeInteger(node.backendDOMNodeId)) lease.refs.add(node.backendDOMNodeId); }
    else result = await chrome.debugger.sendCommand(lease.source, method, params);
  }
  await check(message.targetId, lease);
  return result;
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId) return;
  for (const [id, lease] of channels) if (lease.targetId === source.targetId) {
    if (method === 'DOM.documentUpdated' || (method === 'Page.frameNavigated' && !params.frame.parentId)) { lease.document++; lease.refs.clear(); }
    // A script's tab reports every event of its own session, without network credentials.
    if ([...runs.values()].some(run => run.targets.has(lease.targetId) && live(run))) { const forwarded = relayRunEvent(method, params); if (forwarded) forward(id, lease, { targetId: id, sessionId: lease.sessionId, method, params: forwarded }); return; }
    if (!['Page.frameNavigated', 'Page.loadEventFired', 'DOM.documentUpdated'].includes(method)) return;
    void check(id, lease).then(() => send({ targetId: id, sessionId: lease.sessionId, method, params })).catch(() => {});
  }
});
chrome.debugger.onDetach.addListener(source => { for (const [id, channel] of channels) if (channel.targetId === source.targetId) { channel.cancelNavigation?.(); channels.delete(id); send({ targetId: id, fenced: true }); } });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  for (const [id] of channels) void check(id).catch(() => {});
  if ('groupId' in change) void join(tab, true).catch(() => {});
  else if ((change.url || change.title || change.status === 'complete') && tab.groupId >= 0) void groupRecords().then(records => { const found = records.find(({ record }) => record.chromeGroupId === tab.groupId); if (found) scheduleReport(found.record.groupId); }).catch(() => {});
});
chrome.tabs.onCreated.addListener(tab => { void serially(async () => {
  if (Number.isInteger(tab.openerTabId) && (await groupRecords()).some(({ record }) => record.members?.[tab.openerTabId])) pageTabs.add(tab.id);
}).then(() => { if (tab.groupId >= 0) return join(tab, false); }).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { void leave(tabId).catch(() => {}); });
chrome.tabGroups.onRemoved.addListener(group => { void serially(async () => {
  for (const { key, record } of await groupRecords()) if (record.chromeGroupId === group.id) { await persist(key, null); scheduleReport(record.groupId); }
}).then(async () => { for (const [id, channel] of channels) { try { await check(id,channel); } catch {} } }).catch(() => { socket?.close(); }); });
async function reset() { authorizations.clear(); runs.clear(); await Promise.all([...channels.keys()].map(revoke)); }
async function connect() {
  if (managingIdentity) return;
  const generation = identityGeneration;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  await chrome.storage.local.remove('pairingCode');
  const identity = await stored('identity'); if (!identity || managingIdentity || generation !== identityGeneration || (socket && socket.readyState <= WebSocket.OPEN)) return;
  const protocols = [];
  if (!pairingCode) {
    const issuedAt = Date.now(), nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = encode64(await crypto.subtle.sign('Ed25519', identity.privateKey, new TextEncoder().encode('gitspace-browser-relay-v2:admission:' + identity.pairingId + ':' + identity.generation + ':' + issuedAt + ':' + nonce)));
    protocols.push('gitspace-admission.' + btoa(JSON.stringify({ pairingId: identity.pairingId, generation: identity.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''));
  }
  if (managingIdentity || generation !== identityGeneration || (socket && socket.readyState <= WebSocket.OPEN)) return;
  const connection = new WebSocket(endpoint, protocols);
  socket = connection;
  const clientNonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  let serverNonce;
  let authenticating = false;
  let authenticated = false;
  const handshakeTimeout = setTimeout(() => { if (!authenticated) connection.close(); }, 5000);
  connection.onmessage = async event => {
    let message;
    try {
      if (event.data.length > RELAY_INBOUND_LIMIT || socket !== connection) throw new Error('Invalid connection');
      message = JSON.parse(event.data);
      if (!authenticated) {
        if (authenticating) throw new Error('Concurrent pairing message');
        authenticating = true;
        try {
          if (message.pairing === 'challenge' && !serverNonce && typeof message.serverNonce === 'string') {
            serverNonce = message.serverNonce;
            if (!/^[a-f0-9]{64}$/.test(serverNonce)) throw new Error('Invalid challenge');
            const proof = encode64(await crypto.subtle.sign('Ed25519', identity.privateKey, new TextEncoder().encode('gitspace-browser-relay-v2:client:' + serverNonce + ':' + clientNonce)));
            if (socket !== connection || generation !== identityGeneration) throw new Error('Identity changed');
            connection.send(JSON.stringify({ pairing: 'client', pairingId: identity.pairingId, clientNonce, publicKey: identity.publicKey, proof, ...(pairingCode ? { code: pairingCode } : {}) }));
            return;
          }
          if (message.pairing !== 'server' || !serverNonce) throw new Error('Invalid relay acknowledgement');
          pairingCode = undefined; authenticated = true; clearTimeout(handshakeTimeout);
          connection.send(JSON.stringify({ hello: true, Browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || 'Chrome', protocol: EXTENSION_PROTOCOL, extension: chrome.runtime.getManifest().version }));
          return;
        } finally { authenticating = false; }
      }
      if (message.pairing) throw new Error('Repeated pairing handshake');
      if (message.updateRequired) {
        incompatible = 'Update required: this extension speaks protocol ' + EXTENSION_PROTOCOL + '; your GitSpace account needs ' + message.updateRequired.minimum + ' or later. Download the extension again from GitSpace Settings and reload it.';
        await chrome.storage.local.set({ compatibility: incompatible });
        return;
      }
      if (message.ready === true) {
        // A release accepts its protocol and the one before; so does the extension. Older relays report none (0).
        const account = typeof message.protocol === 'number' ? message.protocol : 0;
        if (account < EXTENSION_PROTOCOL - 1) {
          incompatible = 'This GitSpace account runs an older release (protocol ' + account + ') than this extension supports (' + EXTENSION_PROTOCOL + '). Download the extension that this account offers in Settings.';
          await chrome.storage.local.set({ compatibility: incompatible });
          connection.close();
        } else { await chrome.storage.local.remove('compatibility'); void groupRecords().then(records => { for (const { record } of records) scheduleReport(record.groupId); }).catch(() => {}); }
        return;
      }
    } catch { connection.close(); return; }
    if (message.operation === 'revoke') for (const channel of channels.values()) if (channel.grant.groupId === message.groupId) channel.cancelNavigation?.();
    const key = 'commands';
    const start = () => { if (socket !== connection || connection.readyState !== WebSocket.OPEN) throw new Error('Disconnected command'); return execute(message); };
    // A script's commands do not wait for one another (it may await one while sending the next); everything else runs one at a time.
    const scripted = message.operation === 'command' && message.attemptId !== undefined;
    const operation = scripted ? Promise.resolve().then(start) : (queues.get(key) || Promise.resolve()).catch(() => {}).then(start);
    if (!scripted) queues.set(key, operation);
    void operation.then(result => { if (socket === connection) send({ id: message.id, result }); }, error => { if (socket === connection) send({ id: message.id, error: { message: String(error.message || error).slice(0, 500) } }); }).finally(() => { if (queues.get(key) === operation) queues.delete(key); });
  };
  connection.onclose = () => {
    clearTimeout(handshakeTimeout);
    if (socket !== connection) return;
    for (const channel of channels.values()) channel.cancelNavigation?.();
    socket = undefined; identityGeneration++; managingIdentity = true;
    identityOperations = identityOperations.catch(() => {}).then(async () => {
      try { await Promise.allSettled([...queues.values()]); await reset(); }
      // An incompatible extension stays disconnected until it is reloaded or re-paired, instead of retrying every second.
      finally { managingIdentity = false; if (!incompatible) setTimeout(connect, 1000); }
    });
  };
  connection.onerror = () => connection.close();
}
chrome.runtime.onMessage.addListener((message, sender, respond) => { if ((!message.pair && message.resetIdentity !== true && message.identityStatus !== true) || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return; identityOperations = identityOperations.catch(() => {}).then(async () => {
  if (message.identityStatus === true) {
    const identity = await stored('identity');
    const digest = identity ? await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(identity.publicKey), c => c.charCodeAt(0))) : undefined;
    respond({ fingerprint: digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') : null, compatibility: (await chrome.storage.local.get('compatibility')).compatibility ?? null }); return;
  }
  managingIdentity = true;
  identityGeneration++;
  const previous = socket; socket = undefined; pairingCode = undefined;
  previous?.close();
  for (const channel of channels.values()) channel.cancelNavigation?.();
  try {
    await Promise.allSettled([...queues.values()]);
    await reset();
    await chrome.storage.local.remove('pairingCode');
    if (message.resetIdentity === true) {
      const db = await database; const deleted = Promise.withResolvers(); const tx = db.transaction('state', 'readwrite');
      // Keep replay and attachment-generation records: resetting transport identity does not renew old grants.
      tx.objectStore('state').delete('identity'); tx.oncomplete = deleted.resolve; tx.onerror = () => deleted.reject(tx.error); tx.onabort = () => deleted.reject(tx.error);
      await deleted.promise; respond({ ok: true }); return;
    }
  const { code, trust, pairingId, generation } = message.pair;
  if (typeof code !== 'string' || typeof pairingId !== 'string' || !pairingId || !Number.isSafeInteger(generation) || !trust || trust.algorithm !== 'Ed25519' || !trust.accountId || typeof trust.publicKey !== 'string') throw new Error('Invalid human pairing');
  await crypto.subtle.importKey('raw', Uint8Array.from(atob(trust.publicKey), c => c.charCodeAt(0)), 'Ed25519', false, ['verify']);
  let identity = await stored('identity');
  if (identity && (identity.pairingId !== pairingId || identity.generation !== generation || identity.trust.accountId !== trust.accountId || identity.trust.publicKey !== trust.publicKey)) throw new Error('Clear extension identity before changing account relay authority');
  if (!identity) { const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']); identity = { privateKey: keys.privateKey, publicKey: encode64(await crypto.subtle.exportKey('raw', keys.publicKey)), trust, pairingId, generation }; await persist('identity', identity); }
  await chrome.storage.local.remove('pairingCode'); pairingCode = code;
    respond({ ok: true });
  } finally { managingIdentity = false; await connect(); }
}).catch(error => respond({ error: error.message })); return true; });
chrome.alarms.create('relay-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { for (const [id] of channels) void check(id).catch(() => {}); for (const [attemptId, run] of runs) if (!live(run)) void endRun(attemptId).catch(() => {}); void collapseIdle().catch(() => {}); void connect(); });
connect();
