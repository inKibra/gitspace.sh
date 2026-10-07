import { browserScreenshotPrepareFunction, browserScreenshotRestoreFunction } from '@gitspace/runtime-machine/browser-screenshot';
import { browserOriginMatches } from '@gitspace/protocol-environment';
import { verifyRelayAuthorization } from './browser-relay-authorization.js';


/** Serialized into the installed extension as well as enforced by the supervisor. */
export function relayCommandAllowed(grant: { origins: string[] }, targetId: string, session: string, method: string, params: Record<string, unknown>, sessionId?: string): boolean {
  if (sessionId && sessionId !== session) return false;
  if (['Target.attachToTarget', 'Target.getTargetInfo', 'Target.closeTarget'].includes(method)) return params.targetId === targetId;
  if (method === 'Page.navigate') { try { const url = new URL(String(params.url)); return typeof params.url === 'string' && ['http:', 'https:'].includes(url.protocol) && grant.origins.some(pattern => browserOriginMatches(pattern, url.hostname)) && !params.frameId; } catch { return false; } }
  if (method === 'Runtime.evaluate') return typeof params.expression === 'string' && !params.contextId && !params.uniqueContextId;
  return ['Page.enable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot', 'DOM.enable', 'DOM.describeNode', 'DOM.getBoxModel', 'DOM.focus', 'DOM.scrollIntoViewIfNeeded', 'Accessibility.enable', 'Accessibility.getFullAXTree', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'GitSpace.screenshotPrepare', 'GitSpace.screenshotRestore', 'GitSpace.validateRef'].includes(method);
}

export function browserRelayPopup(): string {
  return `async function refreshIdentity() { const result = await chrome.runtime.sendMessage({ identityStatus: true }); if (result?.error) throw new Error(result.error); document.getElementById('fingerprint').textContent = result.fingerprint || 'No identity. Pair to generate a key.'; }
async function action(message, success) { const buttons = document.querySelectorAll('button'); buttons.forEach(button => button.disabled = true); try { const result = await chrome.runtime.sendMessage(message()); if (result?.error) throw new Error(result.error); await refreshIdentity(); document.getElementById('code').value = ''; document.getElementById('status').textContent = success; } catch(error) { document.getElementById('status').textContent = error.message; } finally { buttons.forEach(button => button.disabled = false); } }
void refreshIdentity().catch(error => { document.getElementById('status').textContent = error.message; });
document.getElementById('pair').addEventListener('submit', event => { event.preventDefault(); void action(() => { const pairing = JSON.parse(document.getElementById('code').value); if (!pairing.code || !pairing.pairingId || !Number.isSafeInteger(pairing.generation) || pairing.trust?.algorithm !== 'Ed25519' || !pairing.trust.accountId || !pairing.trust.publicKey || Date.parse(pairing.expiresAt) <= Date.now()) throw new Error('Copy fresh pairing data from authenticated GitSpace Settings'); return { pair: pairing }; }, 'Compare the fingerprint above with GitSpace Settings, then confirm there before agents can use this Chrome.'); });
document.getElementById('reset').addEventListener('click', () => { void action(() => ({ resetIdentity: true }), 'Identity reset. Use Forget paired browser in GitSpace Settings, then get new pairing JSON.'); });`;
}

// Only the extension has a transport credential, entered interactively. It grants no client CDP endpoint.
export function browserRelayExtension(endpoint: string): string {
  return `
const endpoint = ${JSON.stringify(new URL('/api/browser-relay/extension', endpoint).href.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:'))};
const browserOriginMatches = ${browserOriginMatches.toString()};
const allowed = ${relayCommandAllowed.toString()};
const prepareScreenshot = ${JSON.stringify(browserScreenshotPrepareFunction)};
const restoreScreenshot = ${JSON.stringify(browserScreenshotRestoreFunction)};
const verifyAuthorization = ${verifyRelayAuthorization.toString()};
const database = (() => { const deferred = Promise.withResolvers(); const request = indexedDB.open('gitspace-relay-identity', 1); request.onupgradeneeded = () => request.result.createObjectStore('state'); request.onsuccess = () => deferred.resolve(request.result); request.onerror = () => deferred.reject(request.error); return deferred.promise; })();
async function stored(key) { const db = await database; const deferred = Promise.withResolvers(); const request = db.transaction('state').objectStore('state').get(key); request.onsuccess = () => deferred.resolve(request.result); request.onerror = () => deferred.reject(request.error); return deferred.promise; }
async function persist(key, value) { const db = await database; const deferred = Promise.withResolvers(); const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, key); tx.oncomplete = deferred.resolve; tx.onerror = () => deferred.reject(tx.error); tx.onabort = () => deferred.reject(tx.error); return deferred.promise; }
let pairingCode;
let identityGeneration = 0;
let managingIdentity = false;
let identityOperations = Promise.resolve();
const authorizations = new Map();
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
  const command = body.command;
  const id = command.type === 'execute' ? command.grant.body.groupId : command.type === 'manage' ? 'management' : command.groupId;
  if (command.type === 'execute') {
    if (command.args.source !== 'relay') throw new Error('Relay source required');
    if ((command.args.action === 'navigate' || command.args.action === 'open') && command.args.url && !permitted(command.grant.body, command.args.url)) throw new Error('Destination outside workspace origins');
  }
  authorizations.set(id, { body, used: new Set() });
  return {};
}
let socket;
const channels = new Map();
const queues = new Map();
const releases = new Map();
function send(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
async function targets() { return (await chrome.debugger.getTargets()).filter(target => target.type === 'page'); }
async function targetInfo(id) { const target = (await targets()).find(target => target.id === id); if (!target || !Number.isInteger(target.tabId)) throw new Error('Unknown exact tab target'); return target; }
function permitted(grant, url) { try { const parsed = new URL(url); return url === 'about:blank' || (['http:', 'https:'].includes(parsed.protocol) && grant.origins.some(pattern => browserOriginMatches(pattern, parsed.hostname))); } catch { return false; } }
async function retireGroup(groupId, closeTabs = false) {
  // Keep the fence after identity reset, browser restart, and replacement group creation.
  await persist('retired-group:' + groupId, true);
  authorizations.delete(groupId);
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
        const tabs = await chrome.tabs.query({ groupId: record.chromeGroupId });
        const ids = tabs.filter(tab => tab.groupId === record.chromeGroupId && Number.isInteger(tab.id)).map(tab => tab.id);
        if (ids.length) await chrome.tabs.remove(ids);
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
  if (!record || tab.groupId !== record.chromeGroupId || !permitted(grant, tab.url) || !permitted(grant, target.url)) throw new Error('Target outside workspace group or origins');
  return target;
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
  try { await member(expected.grant, expected.targetId); }
  catch (error) { if (channels.get(id) === expected) await fence(id); throw error; }
  if (channels.get(id) !== expected) throw new Error('Unknown or revoked target channel');
  return expected;
}
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
async function execute(message) {
  if (message.operation === 'authorize') return authorize(message.authorization);
  if (message.operation === 'prepare') {
    const authorization = authorizations.get(message.groupId);
    if (!authorization || authorization.body.command.type !== 'prepare' || Date.parse(authorization.body.expiresAt) <= Date.now() || Date.parse(authorization.body.dispatch.deadlineAt) <= Date.now() || authorization.used.has('prepare')) throw new Error('Signed workspace preparation required');
    authorization.used.add('prepare'); return {};
  }
  if (message.operation === 'revoke') { await retireGroup(message.groupId, true); return {}; }
  if (message.operation === 'tabs') {
    const authorization = authorizations.get(message.groupId);
    if (!authorization || authorization.body.command.type !== 'execute' || authorization.body.command.args.action !== 'tabs' || Date.parse(authorization.body.expiresAt) <= Date.now() || Date.parse(authorization.body.dispatch.deadlineAt) <= Date.now() || authorization.used.has('tabs')) throw new Error('Signed group discovery required');
    authorization.used.add('tabs');
    const grant = authorization.body.command.grant.body;
    const { record } = await groupRecord(grant, true); if (!record) return [];
    const result = [];
    for (const target of await targets()) { try { await member(grant, target.id); result.push({targetId:target.id, title:(target.title || '').slice(0,500), url:target.url}); } catch {} }
    return result;
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
    if (args.action === 'open' && !targetId) {
      const url = args.url || 'about:blank';
      if (!permitted(grant, url)) throw new Error('An allowed destination is required');
      const {key, record, browserEpoch} = await groupRecord(grant);
      const tab = await chrome.tabs.create({ url, active: false });
      try {
        const chromeGroupId = await chrome.tabs.group({tabIds:[tab.id], ...(record ? {groupId:record.chromeGroupId} : {})});
        await chrome.tabGroups.update(chromeGroupId, {title:grant.groupName, color:'blue'});
        await persist(key, {groupId:grant.groupId, chromeGroupId, browserEpoch});
        const deadline = performance.now()+10000;
        while (!targetId && performance.now()<deadline) { targetId = (await targets()).find(target => target.tabId === tab.id)?.id; if (!targetId) { const pause = Promise.withResolvers(); setTimeout(pause.resolve,25); await pause.promise; } }
        if (!targetId) throw new Error('New tab target unavailable');
      } catch(error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
    }
    if (!targetId) throw new Error('An exact workspace target is required');
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
    authorization.targetId = targetId;
    return {targetId,sessionId:channel.sessionId};
  }
  if (message.operation !== 'command') throw new Error('Unsupported relay operation');
  const lease = await check(message.targetId);
  const { method, params = {}, sessionId } = message;
  if (!allowed(lease.grant, lease.targetId, lease.sessionId, method, params, sessionId)) throw new Error('Command outside browser grant');
  await constrainCommand(lease, message.targetId, method, params);
  await check(message.targetId, lease);
  let result;
  if (method === 'Target.attachToTarget') result = { sessionId: lease.sessionId };
  else if (method === 'Target.getTargetInfo') { const target = await targetInfo(lease.targetId); result = { targetInfo: { targetId: target.id, type: 'page', title: target.title, url: target.url, attached: true } }; }
  else if (method === 'Target.closeTarget') { const target = await member(lease.grant,lease.targetId); await chrome.tabs.remove(target.tabId); channels.delete(message.targetId); return { success: true }; }
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
    if (!['Page.frameNavigated', 'Page.loadEventFired', 'DOM.documentUpdated'].includes(method)) return;
    if (method === 'DOM.documentUpdated' || (method === 'Page.frameNavigated' && !params.frame.parentId)) { lease.document++; lease.refs.clear(); }
    void check(id, lease).then(() => send({ targetId: id, sessionId: lease.sessionId, method, params })).catch(() => {});
  }
});
chrome.debugger.onDetach.addListener(source => { for (const [id, channel] of channels) if (channel.targetId === source.targetId) { channel.cancelNavigation?.(); channels.delete(id); send({ targetId: id, fenced: true }); } });
chrome.tabs.onUpdated.addListener(() => { for (const [id] of channels) void check(id).catch(() => {}); });
chrome.tabGroups.onRemoved.addListener(group => { void (async () => {
  const db = await database; const deferred = Promise.withResolvers();
  const request = db.transaction('state').objectStore('state').getAllKeys();
  request.onsuccess = () => deferred.resolve(request.result); request.onerror = () => deferred.reject(request.error);
  for (const key of await deferred.promise) if (typeof key === 'string' && key.startsWith('group:')) { const record = await stored(key); if (record?.chromeGroupId === group.id) await persist(key,null); }
  for (const [id, channel] of channels) { try { await check(id,channel); } catch {} }
})().catch(() => { socket?.close(); }); });
async function reset() { authorizations.clear(); await Promise.all([...channels.keys()].map(revoke)); }
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
      if (event.data.length > 200000 || socket !== connection) throw new Error('Invalid connection');
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
          connection.send(JSON.stringify({ hello: true, Browser: navigator.userAgent.match(/Chrome\\/[\\d.]+/)?.[0] || 'Chrome' }));
          return;
        } finally { authenticating = false; }
      }
      if (message.pairing) throw new Error('Repeated pairing handshake');
      if (message.ready === true) return;
    } catch { connection.close(); return; }
    if (message.operation === 'revoke') for (const channel of channels.values()) if (channel.grant.groupId === message.groupId) channel.cancelNavigation?.();
    const key = 'commands';
    const operation = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => { if (socket !== connection || connection.readyState !== WebSocket.OPEN) throw new Error('Disconnected command'); return execute(message); });
    queues.set(key, operation);
    void operation.then(result => { if (socket === connection) send({ id: message.id, result }); }, error => { if (socket === connection) send({ id: message.id, error: { message: String(error.message || error).slice(0, 500) } }); }).finally(() => { if (queues.get(key) === operation) queues.delete(key); });
  };
  connection.onclose = () => {
    clearTimeout(handshakeTimeout);
    if (socket !== connection) return;
    for (const channel of channels.values()) channel.cancelNavigation?.();
    socket = undefined; identityGeneration++; managingIdentity = true;
    identityOperations = identityOperations.catch(() => {}).then(async () => {
      try { await Promise.allSettled([...queues.values()]); await reset(); }
      finally { managingIdentity = false; setTimeout(connect, 1000); }
    });
  };
  connection.onerror = () => connection.close();
}
chrome.runtime.onMessage.addListener((message, sender, respond) => { if ((!message.pair && message.resetIdentity !== true && message.identityStatus !== true) || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return; identityOperations = identityOperations.catch(() => {}).then(async () => {
  if (message.identityStatus === true) {
    const identity = await stored('identity');
    const digest = identity ? await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(identity.publicKey), c => c.charCodeAt(0))) : undefined;
    respond({ fingerprint: digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') : null }); return;
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
chrome.alarms.onAlarm.addListener(() => { for (const [id] of channels) void check(id).catch(() => {}); void connect(); });
connect();
`;
}

export function browserRelayFiles(endpoint: string): Record<string, string> {
  return {
    'background.js': browserRelayExtension(endpoint),
    'popup.js': browserRelayPopup(),
    'popup.html': '<!doctype html><html><body><p>Browser identity — compare this fingerprint in GitSpace Settings</p><p>Extension public key fingerprint (SHA-256)</p><code id="fingerprint"></code><form id="pair"><label>Account pairing details <input id="code" autocomplete="off" required></label><button>Pair</button></form><button id="reset" type="button">Reset identity</button><p id="status" role="status"></p><script src="popup.js"></script></body></html>',
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'GitSpace Browser Relay', version: '5.0.0', minimum_chrome_version: '124', permissions: ['debugger', 'tabs', 'tabGroups', 'alarms', 'storage'], host_permissions: [`${new URL(endpoint).origin}/*`], background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } }),
  };
}
