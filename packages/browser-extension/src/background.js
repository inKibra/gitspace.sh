// The extension's service worker. Bundled by `src/build.ts`; the download prepends the account it belongs to as
// `const GITSPACE_ACCOUNT_URL = "https://<account>"`.
import { browserScreenshotPrepareFunction, browserScreenshotRestoreFunction } from '@gitspace/runtime-machine/browser-screenshot';
import { CAPTURE_MAX_MS, CAPTURE_SCREENCAST, jpegSize, ScreencastRecorder } from '@gitspace/runtime-machine/browser-screencast';
import { remoteInputCommand } from '@gitspace/runtime-machine/browser-remote-input';
import { permitted, readSiteStepRefusal, relayCommandAllowed, relayRunCommand, relayRunEvent, restoredGroup, restoredMembers, runDestinationRefusal, runSites, runTabRefusal, SCRIPT_TAKEN_REFUSAL, siteOf, TAB_HELD_REFUSAL, tabWithinGrant } from './commands.ts';
import { verifyRelayAuthorization } from './authorization.ts';
import { groupTitle, RUN_LOG_LIMIT, runLogEntry } from './runs.ts';
import { clickedName, NAMED_KEYS, scriptActivity, stepActivity } from './activity.ts';
import { drawToolbarIcon, TOOLBAR_TONE } from './icon.ts';
import { browserOverlayFunction } from './overlay.ts';
import { base64Bytes, downloadBlobReadFunction, inputFilesChunkFunction, inputFilesPrepareFunction, inputFilesSetFunction } from './page-files.ts';
import { SHARE_EXPIRIES_MINUTES, shareRequest, shareTargetFunction } from './share.ts';
import { TabScreencast } from './screencast.ts';
import { relaySignature, Upload } from './upload.ts';

const endpoint = new URL('/api/browser-relay/extension', GITSPACE_ACCOUNT_URL).href.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const ACCOUNT_ORIGIN = new URL(GITSPACE_ACCOUNT_URL).origin;
const allowed = relayCommandAllowed;
const prepareScreenshot = browserScreenshotPrepareFunction;
const restoreScreenshot = browserScreenshotRestoreFunction;
const verifyAuthorization = verifyRelayAuthorization;
const database = (() => { const deferred = Promise.withResolvers(); const request = indexedDB.open('gitspace-relay-identity', 1); request.onupgradeneeded = () => request.result.createObjectStore('state'); request.onsuccess = () => deferred.resolve(request.result); request.onerror = () => deferred.reject(request.error); return deferred.promise; })();
async function stored(key) { const db = await database; const deferred = Promise.withResolvers(); const request = db.transaction('state').objectStore('state').get(key); request.onsuccess = () => deferred.resolve(request.result); request.onerror = () => deferred.reject(request.error); return deferred.promise; }
async function persist(key, value) { const db = await database; const deferred = Promise.withResolvers(); const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, key); tx.oncomplete = deferred.resolve; tx.onerror = () => deferred.reject(tx.error); tx.onabort = () => deferred.reject(tx.error); return deferred.promise; }
let pairingCode;
/** This Chrome's OS as its hello says it (`chrome.runtime.getPlatformInfo`); none for a system GitSpace does not name. */
const PLATFORMS = { win: 'Windows', mac: 'macOS', linux: 'Linux', cros: 'ChromeOS' };
const platform = chrome.runtime.getPlatformInfo().then(info => PLATFORMS[info.os], () => undefined);
let identityGeneration = 0;
let managingIdentity = false;
let identityOperations = Promise.resolve();
const authorizations = new Map();
/** What the agent is doing on each workspace group (`activity.ts`), by group id: `{ agent, doing }`, set by each step
 * and script command that changes it. The popup and the in-page toolbar show it while the agent acts there. */
const activity = new Map();
/** Scripts (`browser.run`) by attempt id, apart from each group's single-step authorization: a single step during a
 * script does not end it. `targets` are the tabs the script opened or attached to; `sites` the sites it may use
 * (`named` when it named them); `commands` and `refused` count what it sent and what the extension refused; `doing`
 * is what it is doing now (`activity.ts`). */
const runs = new Map();
/** How recent scripts ended, so a stopped script's later commands say why they are refused. */
const ended = new Map();
/** Why a script that ended is refused its later commands, by how it ended. */
const ENDED_REFUSALS = { stopped: 'You stopped this script', taken: SCRIPT_TAKEN_REFUSAL };
/** The tabs you hold (docs/APERTURE-DESIGN.md §7.2), by target id: `{ targetId, holder: 'you', since, by, device,
 * groupId }` (`RuntimeBrowserHolder` and its workspace group). None of the agent's commands reach them and none of
 * their events reach the agent. Kept in IndexedDB (`holders`), so a service-worker restart keeps them. */
const holders = new Map();
const holdersRestored = stored('holders').then(saved => { for (const held of saved ?? []) holders.set(held.targetId, held); }).catch(() => {});
/** Who holds a tab: its record while you hold it, else none (the agent holds it). */
function heldBy(targetId) { return holders.get(targetId); }
/** The agent's own input (`Input.*`) is trusted in the page as yours is, so the overlay reports it as yours: a tab's
 * count of the agent's inputs in flight or ended less than `AGENT_INPUT_GRACE_MS` ago, during which a `take` from the
 * tab is the agent's. */
const agentInputs = new Map();
const AGENT_INPUT_GRACE_MS = 300;
function agentInput(targetId, sending) {
  agentInputs.set(targetId, (agentInputs.get(targetId) ?? 0) + 1);
  return sending.finally(() => setTimeout(() => { const count = agentInputs.get(targetId) - 1; if (count > 0) agentInputs.set(targetId, count); else agentInputs.delete(targetId); }, AGENT_INPUT_GRACE_MS));
}
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
  for (const [attemptId, run] of runs) if (run.body.scope.projectId === body.scope.projectId && run.body.scope.workspaceId === body.scope.workspaceId && run.body.scope.placement.pairingId === body.scope.placement.pairingId && run.body.scope.placement.generation < body.scope.placement.generation) await endRun(attemptId, 'disconnected');
  const command = body.command;
  const id = command.type === 'execute' ? command.grant.body.groupId : command.type === 'manage' ? 'management' : command.groupId;
  if (command.type === 'execute') {
    if (command.args.source !== 'relay') throw new Error('Relay source required');
    if (command.args.action === 'open' && command.args.url && !permitted(command.grant.body, command.args.url)) throw new Error('Destination outside workspace origins');
    if (command.args.action === 'run') {
      const grant = command.grant.body;
      const sites = runSites(grant, command.args.sites);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(command.args.script));
      const scriptSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      runs.set(body.scope.attemptId, { body, targets: new Set(), sites, named: command.args.sites !== undefined, scriptSha256, startedAt: new Date().toISOString(), commands: 0, refused: 0, doing: 'Running a script' });
      activity.set(grant.groupId, { agent: body.scope.conversationKind, doing: 'Running a script' });
      await markRunning(grant.groupId);
      scheduleReport(grant.groupId);
      updateToolbar();
      return {};
    }
  }
  // A single step's authorization also says when it began, the commands sent under it, and what it is doing.
  const doing = command.type === 'execute' ? stepActivity(command.args, channels.get(command.args.targetId)?.names ?? new Map()) : null;
  authorizations.set(id, { body, used: new Set(), startedAt: new Date().toISOString(), commands: 0, doing });
  if (command.type === 'execute') {
    activity.set(id, { agent: body.scope.conversationKind, doing });
    updateToolbar();
    scheduleReport(id);
    // The toolbar stops counting the step once its authority ends, and the account hears it ended.
    setTimeout(() => { updateToolbar(); scheduleReport(id); }, Math.max(0, Math.min(Date.parse(body.expiresAt), Date.parse(body.dispatch.deadlineAt)) - Date.now()) + 100);
  }
  return {};
}
const EXTENSION_PROTOCOL = BROWSER_EXTENSION_PROTOCOL;
/** The protocol the connected account speaks (0 while not connected). Captures, downloads saved to the drive and
 * uploads into pages need an account at protocol 5; while not connected, downloads stay Chrome's and Capture says
 * why not. Share links need an account at protocol 6. */
let accountProtocol = 0;
/** Whether the connected account takes each group's colour and its agents in group reports (its `ready` says
 * `groupActivity`); an older account refuses a report with fields it does not know. */
let accountActivity = false;
/** Whether the connected account takes take over (its `ready` says `takeover`): `takeOver`/`resume`, the tabs you hold
 * (`held`) and each agent's tab (`targetId`) in group reports, which an older account refuses. */
let accountTakeover = false;
const MEDIA_PROTOCOL = 5;
const SHARE_PROTOCOL = 6;
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
/** Chrome's tab group colours, as it draws them in the tab strip (for the popup's group dots and names). */
const GROUP_HEX = { blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038', pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e', grey: '#5f6368' };
const GROUP_COLORS = Object.keys(GROUP_HEX);
/** A workspace keeps one colour wherever its group is recreated. */
function groupColor(workspaceId) { let hash = 0; for (const character of workspaceId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return GROUP_COLORS[hash % GROUP_COLORS.length]; }
/** The grant as it applies to one tab: a tab you dragged in is also usable on the site it showed then. */
function scoped(grant, record, tabId) { const entry = record?.members?.[tabId]; return entry?.by === 'you' && entry.site ? { ...grant, origins: [...grant.origins, entry.site] } : grant; }
async function retireGroup(groupId, closeTabs = false) {
  // Keep the fence after identity reset, browser restart, and replacement group creation.
  await persist('retired-group:' + groupId, true);
  authorizations.delete(groupId);
  for (const [id, channel] of channels) if (channel.grant.groupId === groupId) await fence(id);
  for (const [attemptId, run] of runs) if (run.body.command.grant.body.groupId === groupId) await endRun(attemptId, 'released');
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
  if (record && record.browserEpoch !== browserEpoch) return { key, record: await readopt(key, grant, browserEpoch), browserEpoch };
  if (record) { try { await chrome.tabGroups.get(record.chromeGroupId); } catch { await persist(key, null); return { key, browserEpoch }; } }
  return { key, record, browserEpoch };
}
/** After a Chrome restart the record names a group and tabs that no longer exist, and Chrome has restored the group
 * under a new id: the record adopts it (`restoredGroup`) with each of its tabs as one you dragged in, or is dropped. */
function readopt(key, grant, browserEpoch) {
  return serially(async () => {
    const current = await stored(key);
    if (current?.groupId !== grant.groupId) return undefined;
    if (current.browserEpoch === browserEpoch) return current;
    const bound = (await groupRecords()).filter(other => other.key !== key && other.record.browserEpoch === browserEpoch).map(other => other.record.chromeGroupId);
    const chromeGroupId = restoredGroup(await chrome.tabGroups.query({}), grant.groupName, groupColor(grant.workspaceId), bound);
    if (chromeGroupId === null) { await persist(key, null); return undefined; }
    const adopted = { groupId: grant.groupId, chromeGroupId, browserEpoch, members: restoredMembers(await chrome.tabs.query({ groupId: chromeGroupId })) };
    await persist(key, adopted);
    scheduleReport(grant.groupId);
    return adopted;
  });
}
async function member(grant, targetId) {
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Workspace group grant expired');
  const { record } = await groupRecord(grant);
  const target = await targetInfo(targetId);
  const tab = await chrome.tabs.get(target.tabId);
  const scope = scoped(grant, record, tab.id);
  const urls = { tabUrl: tab.url, pendingUrl: tab.pendingUrl, targetUrl: target.url };
  if (!record || tab.groupId !== record.chromeGroupId || !tabWithinGrant(scope, urls)) throw new Error('Target outside workspace group or origins');
  const entry = record.members?.[tab.id];
  return { ...target, scope, urls, dragged: entry?.by === 'you' ? entry.site : null, addedBy: entry?.by ?? 'you' };
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
/** Reports coalesce: a page load fires several tab updates. While agents act on a group, what they do goes out at
 * most every `ACTIVITY_REPORT_MS`. */
const reportTimers = new Map();
const activityReports = new Map();
const ACTIVITY_REPORT_MS = 3000;
function scheduleReport(groupId) { clearTimeout(reportTimers.get(groupId)); reportTimers.set(groupId, setTimeout(() => { reportTimers.delete(groupId); void report(groupId).catch(() => {}); }, 300)); }
function reportActivity(groupId) { if (accountActivity && !activityReports.has(groupId)) activityReports.set(groupId, setTimeout(() => { activityReports.delete(groupId); scheduleReport(groupId); }, ACTIVITY_REPORT_MS)); }
/** Tells the account which tabs are in a workspace group now, and how many scripts run on it; a group that is gone
 * reports none. An account that takes them (`groupActivity`) also hears the group's colour and the agents acting there
 * now (`RuntimeBrowserGroupAgent`): each script inside its deadline, and the single step whose authority lasts, with
 * what each is doing, never what is typed (`activity.ts`). */
async function report(groupId) {
  const found = (await groupRecords()).find(({ record }) => record.groupId === groupId);
  const tabs = found ? await chrome.tabs.query({ groupId: found.record.chromeGroupId }) : [];
  const targetIds = new Map((await targets()).map(target => [target.tabId, target.id]));
  const group = { groupId, tabs: tabs.filter(tab => targetIds.has(tab.id)).slice(0, 200).map(tab => {
    const entry = found.record.members?.[tab.id];
    return { targetId: targetIds.get(tab.id), url: (tab.url || '').slice(0, 8192), title: (tab.title || '').slice(0, 500), addedBy: entry?.by ?? 'you', site: entry?.by === 'you' ? entry.site ?? null : null };
  }), running: [...runs.values()].filter(run => run.body.command.grant.body.groupId === groupId).length };
  if (accountActivity) {
    const color = found ? (await chrome.tabGroups.get(found.record.chromeGroupId).catch(() => null))?.color : undefined;
    const now = Date.now(), step = authorizations.get(groupId);
    const acting = [...[...runs.values()].filter(run => run.body.command.grant.body.groupId === groupId && live(run)).map(run => [run.body, 'run', run]),
      ...(step?.body.command.type === 'execute' && Date.parse(step.body.expiresAt) > now && Date.parse(step.body.dispatch.deadlineAt) > now ? [[step.body, step.body.command.args.action, step]] : [])];
    Object.assign(group, Object.hasOwn(GROUP_HEX, color ?? '') ? { color } : {}, { agents: acting.slice(0, 32).map(([body, tool, entry]) => ({ agent: body.scope.conversationKind, tool, commands: entry.commands, startedAt: entry.startedAt, doing: entry.doing?.slice(0, 120) ?? null, ...(accountTakeover ? { targetId: entry.targetId ?? null } : {}) })) });
  }
  if (accountTakeover) group.held = [...holders.values()].filter(held => held.groupId === groupId).slice(0, 200).map(({ targetId, holder, since, by, device }) => ({ targetId, holder, since, by, device }));
  send({ group });
}
/** When the agent last used each group. A group idle this long collapses once. */
const lastUsed = new Map();
const IDLE_COLLAPSE_MS = 2 * 60_000;
async function collapseIdle() {
  for (const [groupId, at] of lastUsed) {
    if (Date.now() - at < IDLE_COLLAPSE_MS) continue;
    // A group with a tab you hold stays open while you use it.
    if ([...holders.values()].some(held => held.groupId === groupId)) { lastUsed.set(groupId, Date.now()); continue; }
    lastUsed.delete(groupId);
    const found = (await groupRecords()).find(({ record }) => record.groupId === groupId);
    // Collapsing the group holding the tab you are looking at would switch tabs under you.
    if (!found || (await chrome.tabs.query({ groupId: found.record.chromeGroupId, active: true })).length) continue;
    await chrome.tabGroups.update(found.record.chromeGroupId, { collapsed: true });
  }
}
/**
 * Each tab's one debugger session (Chrome attaches an extension once per tab), by target id, with the tab's one
 * screencast and in-page overlay. The agent's channel of a group tab uses it, and so does each share watched on the
 * tab. A shared tab in no workspace group has a session but never a channel, so no agent command, script or event
 * reaches it: every agent path goes through `channels` and `check`.
 */
const debuggees = new Map();
/** The debugger session of a tab (`targetInfo`), attached on first use. */
function debuggeeOf(target) {
  let debuggee = debuggees.get(target.id);
  if (!debuggee) {
    const source = { targetId: target.id };
    const created = { targetId: target.id, tabId: target.tabId, source, screencast: new TabScreencast((method, params) => chrome.debugger.sendCommand(source, method, params)), overlay: undefined, overlayQueue: undefined, pointed: false, reporting: false, world: null, viewport: '' };
    created.attached = (async () => { await releases.get(target.id); await chrome.debugger.attach(source, '1.3'); return created; })();
    void created.attached.catch(() => { if (debuggees.get(target.id) === created) debuggees.delete(target.id); });
    debuggees.set(target.id, created);
    debuggee = created;
  }
  return debuggee.attached;
}
/** Lets the debugger leave a tab: its overlay leaves the page first, since the page keeps it after the debugger. */
async function detachTab(targetId, source) {
  const debuggee = debuggees.get(targetId);
  debuggees.delete(targetId);
  const release = (async () => { if (debuggee?.overlay) await overlayStep(debuggee, () => overlayCall(debuggee, { remove: true })); await chrome.debugger.detach(source); })().catch(() => {});
  releases.set(targetId, release);
  try { await release; } finally { if (releases.get(targetId) === release) releases.delete(targetId); }
}
/** Lets a tab's debugger channel go, and the debugger with it unless a share still watches the tab, which keeps it
 * without the script's painting, or you hold it, whose toolbar keeps Resume agent. A capture recording the tab's
 * screencast ends with what it recorded. */
async function revoke(id) {
  const channel = channels.get(id); channels.delete(id);
  if (!channel) return releases.get(id);
  channel.cancelNavigation?.();
  for (const capture of captures.values()) if (capture.channel === channel) void endCapture(capture, 'Recording stopped: GitSpace no longer uses this tab', true);
  const debuggee = debuggees.get(id);
  if (debuggee && (watchesOn(debuggee).length || heldBy(id))) {
    if (channel.painting) void channel.screencast.remove(channel.painting).catch(() => {});
    void overlay(id);
    return;
  }
  await detachTab(id, channel.source);
}
async function fence(id) { send({ targetId: id, fenced: true }); await revoke(id); }
async function check(id, expected = channels.get(id)) {
  if (!expected || channels.get(id) !== expected) throw new Error('Unknown or revoked target channel');
  try { ({ scope: expected.scope, urls: expected.urls, dragged: expected.dragged, addedBy: expected.addedBy, tabId: expected.tabId } = await member(expected.grant, expected.targetId)); }
  catch (error) { if (channels.get(id) === expected) await fence(id); throw error; }
  if (channels.get(id) !== expected) throw new Error('Unknown or revoked target channel');
  return expected;
}
/** Whether a script is inside its signed deadline. */
function live(run) { const now = Date.now(); return Date.parse(run.body.expiresAt) > now && Date.parse(run.body.dispatch.deadlineAt) > now; }
async function activeRun(attemptId) {
  const run = runs.get(attemptId);
  if (!run) throw new Error(ENDED_REFUSALS[ended.get(attemptId)] ?? 'Signed browser script required');
  if (!live(run)) { await endRun(attemptId, 'deadline'); throw new Error('Browser script deadline passed'); }
  return run;
}
/** Ends a script for `reason` and logs it. Its tabs stay in the group; the debugger leaves those no other script
 * drives, which drops whatever the script set on them (overrides, interception, bindings), and unless the session
 * released the script itself, the session hears that those tabs are gone. A later single step attaches again. */
async function endRun(attemptId, reason) {
  const run = runs.get(attemptId);
  runs.delete(attemptId);
  if (!run) return;
  ended.set(attemptId, reason);
  if (ended.size > 100) ended.delete(ended.keys().next().value);
  for (const targetId of run.targets) {
    const channel = channels.get(targetId);
    if (!channel || [...runs.values()].some(other => other.targets.has(targetId))) continue;
    // A tab being captured keeps its debugger for the capture's screencast, which lets it go when it ends; it stops
    // painting for the script.
    if ([...captures.values()].some(capture => capture.channel === channel)) {
      if (channel.painting) { void channel.screencast.remove(channel.painting).catch(() => {}); channel.painting = null; }
      channel.heldForCapture = true;
      if (reason !== 'released') send({ targetId, fenced: true });
      continue;
    }
    await (reason === 'released' ? revoke(targetId) : fence(targetId));
  }
  // A tab a single step still uses keeps its overlay, without the script's glow.
  for (const targetId of run.targets) if (channels.has(targetId)) void overlay(targetId);
  updateToolbar();
  scheduleReport(run.body.command.grant.body.groupId);
  await logRun(runLogEntry(run, reason, new Date().toISOString())).catch(() => {});
  await markRunning(run.body.command.grant.body.groupId);
}
/** Stops a workspace group in this Chrome now, from the popup, its tabs' Stop or GitSpace's Stop: its scripts end as
 * a release does (their sessions hear that their tabs are gone and see their commands refused), and so does its
 * current single step. The account hears that nobody acts there any more. */
async function stopGroup(groupId) {
  authorizations.delete(groupId);
  activity.delete(groupId);
  updateToolbar();
  await Promise.all([...runs].filter(([, run]) => run.body.command.grant.body.groupId === groupId).map(([attemptId]) => endRun(attemptId, 'stopped')));
  for (const channel of channels.values()) if (channel.grant.groupId === groupId) void overlay(channel.targetId);
  scheduleReport(groupId);
}
/** Adds a script that ended to the local run log (`run-log`), newest first. */
async function logRun(entry) {
  const db = await database; const done = Promise.withResolvers(); const tx = db.transaction('state', 'readwrite'); const store = tx.objectStore('state');
  const request = store.get('run-log');
  request.onsuccess = () => store.put([entry, ...(request.result || [])].slice(0, RUN_LOG_LIMIT), 'run-log');
  tx.oncomplete = done.resolve; tx.onerror = () => done.reject(tx.error); tx.onabort = () => done.reject(tx.error);
  return done.promise;
}
/** Marks a workspace group's title while a script runs on it and unmarks it after the last one. Only a group this
 * extension records in this browser session is touched. */
function markRunning(groupId) {
  return serially(async () => {
    // Only the title: a failure here never fails the script or the membership change after it.
    try {
      const { browserEpoch } = await chrome.storage.session.get('browserEpoch');
      const found = (await groupRecords()).find(({ record }) => record.groupId === groupId && record.browserEpoch === browserEpoch);
      if (!found) return;
      const group = await chrome.tabGroups.get(found.record.chromeGroupId);
      const current = group.title ?? '';
      const title = groupTitle(current, [...runs.values()].some(run => run.body.command.grant.body.groupId === groupId));
      if (title !== current) await chrome.tabGroups.update(group.id, { title });
    } catch {}
  });
}
/** The isolated world of the in-page overlay (`overlay.ts`), and the binding its buttons call there: `stop` (the
 * agent), `capture` and `captureStop`. */
const OVERLAY_WORLD = 'gitspace-overlay';
const OVERLAY_BINDING = '__gitspaceStop';
/** The longest one overlay step may take: a page held by a dialog never answers, and the agent never waits on it. */
const OVERLAY_STEP_MS = 1000;
/** What a tab's overlay shows for the agent's channel: a script running on it, a single step using it now, a capture
 * recording it, or nothing. A tab you hold shows `you` instead (`overlay`). */
function overlayMode(channel) {
  if ([...runs.values()].some(run => run.targets.has(channel.targetId) && live(run))) return 'run';
  const step = authorizations.get(channel.grant.groupId);
  if (step?.body.command.type === 'execute' && step.targetId === channel.targetId && Date.parse(step.body.expiresAt) > Date.now() && Date.parse(step.body.dispatch.deadlineAt) > Date.now()) return 'step';
  return captureOn(channel.tabId) ? 'capture' : null;
}
/** Overlay steps of one tab run in order, each within `OVERLAY_STEP_MS`; a failed one fails nothing else. */
function overlayStep(debuggee, operation) {
  const step = (debuggee.overlayQueue ?? Promise.resolve()).then(() => {
    const timeout = Promise.withResolvers();
    const timer = setTimeout(timeout.resolve, OVERLAY_STEP_MS);
    return Promise.race([operation(), timeout.promise]).finally(() => clearTimeout(timer));
  }).catch(() => {});
  debuggee.overlayQueue = step;
  return step;
}
/** Calls the overlay function in the tab's overlay world, which a navigation replaces; the world's Stop binding is
 * added to that world alone, so no page script can call it. */
async function overlayCall(debuggee, command) {
  const call = async () => {
    if (!debuggee.overlay.contextId) {
      const tree = await chrome.debugger.sendCommand(debuggee.source, 'Page.getFrameTree');
      const world = await chrome.debugger.sendCommand(debuggee.source, 'Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: OVERLAY_WORLD });
      await chrome.debugger.sendCommand(debuggee.source, 'Runtime.addBinding', { name: OVERLAY_BINDING, executionContextId: world.executionContextId });
      debuggee.overlay.contextId = world.executionContextId;
    }
    return chrome.debugger.sendCommand(debuggee.source, 'Runtime.callFunctionOn', { functionDeclaration: browserOverlayFunction, arguments: [{ value: command }], executionContextId: debuggee.overlay.contextId, returnByValue: true });
  };
  // A context that a navigation destroyed: the next call makes the new document's world.
  try { return await call(); } catch { debuggee.overlay.contextId = null; return call(); }
}
/** Brings the overlay of a tab with a debugger session up to date (`extra`: the agent's pointer, or hiding it for a
 * screenshot): the toolbar while the agent uses the tab (who acts and what it is doing), while you hold it (`you`,
 * whatever the agent does) or a capture records it, the pointers of the people watching its shares, and your own
 * pointer reported while a share watched there shows it to its viewers (`report`); removed when none of these. Its
 * Capture button shows only when the account saves captures. */
function overlay(targetId, extra = {}) {
  const debuggee = debuggees.get(targetId);
  if (!debuggee) return Promise.resolve();
  return overlayStep(debuggee, async () => {
    if (debuggees.get(targetId) !== debuggee) return;
    const channel = channels.get(targetId);
    const held = heldBy(targetId);
    const mode = held ? 'you' : channel ? overlayMode(channel) : null;
    const watches = watchesOn(debuggee);
    const pointers = watches.flatMap(watch => watch.pointers);
    const reporting = watches.some(watch => watch.reportPointer);
    if (!mode && !pointers.length && !reporting) { if (debuggee.overlay) { try { await overlayCall(debuggee, { remove: true }); } finally { delete debuggee.overlay; debuggee.pointed = false; debuggee.reporting = false; } } return; }
    debuggee.overlay ??= { contextId: null };
    const recording = mode ? captureOn(debuggee.tabId) : undefined;
    // While you hold the tab, the agent that acted on its group is the one paused (the main agent when none did).
    const acting = mode === 'run' || mode === 'step' ? activity.get(channel.grant.groupId) : held ? activity.get(held.groupId) ?? { agent: 'main', doing: null } : undefined;
    const show = mode ? { mode, workspace: channel?.grant.groupName ?? '', agent: acting?.agent ?? null, doing: held ? null : acting?.doing ?? null, binding: OVERLAY_BINDING,
      capture: recording ? 'recording' : accountProtocol >= MEDIA_PROTOCOL ? 'ready' : 'none', recording: recording ? { startedAt: recording.startedAt, sound: recording.track === 'video' } : null } : null;
    // Pointers go along while any are drawn, and once more, empty, to take the last ones away; reporting likewise.
    const command = { show, ...(pointers.length || debuggee.pointed ? { pointers } : {}), ...(reporting || debuggee.reporting ? { report: reporting ? OVERLAY_BINDING : null } : {}), ...extra };
    debuggee.pointed = pointers.length > 0;
    debuggee.reporting = reporting;
    await overlayCall(debuggee, command);
  });
}
/** A tab as one script sees it: the script's sites, the site you dragged the tab in on when the script named none, and
 * the grant's sites at interact and read, where scripts never run. */
function runTab(run, tab) {
  const grant = run.body.command.grant.body;
  return { grant: { origins: tab.dragged && !run.named ? [...run.sites, tab.dragged] : run.sites }, stepsOnly: grant.stepsOnly, read: grant.read ?? [], urls: tab.urls };
}
/** Events of a script's tab go out in order; one membership check covers the events that arrived before it began.
 * While the tab is off the script's sites, or on one that allows single steps only, its events stay in your Chrome. */
function forward(id, lease, event) {
  if (lease.forwarding) { lease.forwarding.push(event); return; }
  const pending = [event];
  lease.forwarding = pending;
  void (async () => {
    try {
      while (pending.length) {
        const count = pending.length;
        await check(id, lease);
        const shown = ![...runs.values()].some(run => run.targets.has(lease.targetId) && runTabRefusal(runTab(run, lease)));
        for (const item of pending.splice(0, count)) if (shown) send(item);
      }
    }
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
      if (args.operation === 'press' && NAMED_KEYS[args.value]) accepted = exact({ type: params.type, key: args.value, windowsVirtualKeyCode: NAMED_KEYS[args.value] });
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
      lease.refs.clear(); lease.names.clear();
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
/** The tabs of a workspace group; a script (`run`) sees only those on its sites. */
async function groupTabs(grant, run) {
  const { record } = await groupRecord(grant, true); if (!record) return [];
  const result = [];
  for (const target of await targets()) {
    try {
      const tab = await member(grant, target.id);
      if (run && runTabRefusal(runTab(run, tab))) continue;
      result.push({targetId:target.id, title:(target.title || '').slice(0,500), url:target.url, addedBy:tab.addedBy});
    } catch {}
  }
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
    await chrome.tabGroups.update(chromeGroupId, {title:groupTitle(grant.groupName, [...runs.values()].some(run => run.body.command.grant.body.groupId === grant.groupId)), color:groupColor(grant.workspaceId), collapsed:false});
    await updateRecord(key, current => ({ groupId: grant.groupId, chromeGroupId, browserEpoch, members: { ...(current?.chromeGroupId === chromeGroupId ? current.members : {}), [tab.id]: { by: 'agent', site: null } } }));
    scheduleReport(grant.groupId);
    const deadline = performance.now()+10000;
    while (!targetId && performance.now()<deadline) { targetId = (await targets()).find(target => target.tabId === tab.id)?.id; if (!targetId) { const pause = Promise.withResolvers(); setTimeout(pause.resolve,25); await pause.promise; } }
    if (!targetId) throw new Error('New tab target unavailable');
  } catch(error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
  finally { agentTabs.delete(tab.id); }
  return targetId;
}
/** The debugger channel of a tab in the group, on the tab's debugger session (attached on first use) with its one
 * screencast. With an account that saves downloads, Page events are on from the start, so a download the agent
 * starts is seen. */
async function attach(grant, targetId) {
  const target = await member(grant, targetId);
  await releases.get(targetId);
  let channel = channels.get(targetId);
  if (channel && channel.grant.groupId !== grant.groupId) { try { await check(targetId, channel); } catch {} await releases.get(targetId); channel = channels.get(targetId); }
  if (channel && channel.grant.groupId !== grant.groupId) throw new Error('Target already bound to another workspace');
  if (!channel) {
    const { source, screencast } = await debuggeeOf(target);
    channel = {grant,targetId,source,sessionId:crypto.randomUUID(),refs:new Set(),names:new Map(),document:0,screencast,painting:null}; channels.set(targetId,channel);
    if (accountProtocol >= MEDIA_PROTOCOL) await chrome.debugger.sendCommand(source, 'Page.enable');
  } else channel.grant = grant;
  await check(targetId, channel);
  return channel;
}
/** What a script's click is doing: "Clicking “name”", named by the accessible name of what is at the point. */
async function clickedAt(lease, x, y) {
  try {
    const { backendNodeId } = await chrome.debugger.sendCommand(lease.source, 'DOM.getNodeForLocation', { x, y, ignorePointerEventsNone: true });
    if (!Number.isSafeInteger(backendNodeId)) return 'Clicking';
    const { nodes } = await chrome.debugger.sendCommand(lease.source, 'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true });
    return clickedName(Array.isArray(nodes) ? nodes : [], backendNodeId);
  } catch { return 'Clicking'; }
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
    // You took the tab over: the script ends at this command, and its later commands say why.
    if (heldBy(targetId)) { await endRun(attemptId, 'taken'); throw new Error(SCRIPT_TAKEN_REFUSAL); }
    run.commands++;
    run.targetId = targetId;
    reportActivity(run.body.command.grant.body.groupId);
    let verdict;
    try {
      lease = await check(targetId);
      if (lease.grant.groupId !== run.body.command.grant.body.groupId || !run.targets.has(targetId)) throw new Error('Tab not opened by this script');
      verdict = relayRunCommand(method, params, { ...runTab(run, lease), targetId, session: lease.sessionId, sessionId, addedBy: lease.addedBy, account: ACCOUNT_ORIGIN });
      if ('refused' in verdict) throw new Error(verdict.refused);
    } catch (error) { run.refused++; throw error; }
    lastUsed.set(lease.grant.groupId, Date.now());
    if ('noop' in verdict) return {};
    if (method === 'Target.closeTarget' || method === 'Page.close') { await closeTab(lease); return method === 'Page.close' ? {} : { success: true }; }
    // What the script is doing now: the overlay calls of the cursor and of a screenshot carry it, and any other change
    // refreshes the toolbar.
    const doing = method === 'Input.dispatchMouseEvent' && verdict.send.type === 'mousePressed' ? await clickedAt(lease, verdict.send.x, verdict.send.y) : scriptActivity(method, verdict.send);
    if (doing) run.doing = doing;
    if (doing && doing !== activity.get(lease.grant.groupId)?.doing) {
      activity.set(lease.grant.groupId, { agent: run.body.scope.conversationKind, doing });
      if (method !== 'Input.dispatchMouseEvent' && method !== 'Page.captureScreenshot') void overlay(targetId);
    }
    // The cursor reaches each point before the event does; a script's own screenshot never shows the overlay.
    if (method === 'Input.dispatchMouseEvent') await overlay(targetId, { cursor: { x: verdict.send.x, y: verdict.send.y, type: verdict.send.type } });
    if (method === 'Page.captureScreenshot') await overlay(targetId, { conceal: true });
    effect = method === 'Target.attachToTarget' ? { sessionId: lease.sessionId } : method === 'Target.getTargetInfo' ? describeTarget(targetId) : method === 'GitSpace.setInputFilesFromUrls' ? setInputFiles(lease, verdict.send) : method.startsWith('Input.') ? agentInput(targetId, chrome.debugger.sendCommand(lease.source, method, verdict.send)) : chrome.debugger.sendCommand(lease.source, method, verdict.send);
  } finally {
    admitted.resolve();
    if (admissions.get(targetId) === admitted.promise) admissions.delete(targetId);
  }
  let result;
  try { result = await effect; } finally { if (method === 'Page.captureScreenshot') void overlay(targetId, { conceal: false }); }
  await check(targetId, lease);
  return result;
}
/** Why a tab shows no preview: the debugger is never attached for one, so previews never start Chrome's debugging bar. */
const PREVIEW_IDLE = 'Preview appears while the agent uses this tab';
/** Previews are small: at most this wide, in CSS pixels. A tab Chrome does not draw in time (one behind yours) shows
 * none rather than holding up the commands after it. */
const PREVIEW_WIDTH = 480;
const PREVIEW_TIMEOUT_MS = 5000;
/** A small image of a tab for GitSpace's Browser tab (`manage` `preview`), only of a tab of the group the agent is
 * using now, which already has a debugger channel. */
async function preview(scope, groupId, targetId) {
  const channel = channels.get(targetId);
  if (!channel || channel.grant.groupId !== groupId || channel.grant.projectId !== scope.projectId || channel.grant.workspaceId !== scope.workspaceId) return { image: null, reason: PREVIEW_IDLE };
  try { await check(targetId, channel); } catch { return { image: null, reason: PREVIEW_IDLE }; }
  const timeout = Promise.withResolvers();
  const timer = setTimeout(() => timeout.resolve(null), PREVIEW_TIMEOUT_MS);
  try {
    const shot = await Promise.race([(async () => {
      const { cssVisualViewport: viewport } = await chrome.debugger.sendCommand(channel.source, 'Page.getLayoutMetrics');
      return chrome.debugger.sendCommand(channel.source, 'Page.captureScreenshot', { format: 'jpeg', quality: 50, captureBeyondViewport: false, clip: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale: Math.min(1, PREVIEW_WIDTH / viewport.clientWidth) } });
    })(), timeout.promise]);
    return shot ? { image: shot.data, reason: null } : { image: null, reason: 'Chrome did not draw this tab in time' };
  } finally { clearTimeout(timer); }
}
/** The signed management request for `action` the account sent with this operation, naming these `fields` exactly;
 * each is used once. */
function management(action, fields) {
  const authorization = authorizations.get('management');
  const command = authorization?.body.command;
  if (!command || command.type !== 'manage' || command.action !== action || Object.entries(fields).some(([key, value]) => command[key] !== value) || Date.parse(authorization.body.expiresAt) <= Date.now() || Date.parse(authorization.body.dispatch.deadlineAt) <= Date.now() || authorization.used.has(action)) return null;
  authorization.used.add(action);
  return authorization;
}
/** Stop, Close tab, Focus in Chrome, Take over and Resume agent from GitSpace's Browser tab, each signed for its group
 * (and tab) of the request's workspace. Stop ends the group's scripts and step as Stop in Chrome does; Close tab closes
 * a tab of the group as this browser session records it; Focus in Chrome brings one to the front of its window; Take
 * over makes you its holder from the signed-in `device` (attaching the debugger for its toolbar), and Resume agent
 * hands it back. */
async function control(message) {
  if (message.operation === 'stopGroup') {
    const authorization = management('stop', { groupId: message.groupId });
    if (!authorization) throw new Error(CONTROL_OPERATIONS.stopGroup);
    const { scope } = authorization.body, step = authorizations.get(message.groupId);
    const bodies = [...[...runs.values()].filter(run => run.body.command.grant.body.groupId === message.groupId).map(run => run.body), ...(step ? [step.body] : [])];
    if (bodies.some(body => body.scope.projectId !== scope.projectId || body.scope.workspaceId !== scope.workspaceId)) throw new Error('This tab group belongs to another workspace');
    await stopGroup(message.groupId);
    return {};
  }
  const authorization = management(message.operation, { groupId: message.groupId, targetId: message.targetId, ...(message.operation === 'takeOver' ? { device: message.device } : {}) });
  if (!authorization) throw new Error(CONTROL_OPERATIONS[message.operation]);
  const { scope } = authorization.body, identity = await stored('identity');
  const key = 'group:' + JSON.stringify([identity.trust.accountId, identity.pairingId, scope.projectId, scope.workspaceId]);
  const found = (await workspaceGroups()).find(entry => entry.key === key && entry.record.groupId === message.groupId);
  if (!found) throw new Error('This workspace has no tab group in this Chrome');
  const target = await targetInfo(message.targetId);
  const tab = await chrome.tabs.get(target.tabId);
  if (tab.groupId !== found.group.id) throw new Error('This tab is not in the workspace’s group');
  if (message.operation === 'closeTab') { await chrome.tabs.remove(tab.id); return {}; }
  if (message.operation === 'takeOver') { await debuggeeOf(target).catch(() => {}); await take(target.id, message.groupId, 'gitspace', message.device ?? null); return {}; }
  if (message.operation === 'resume') { await handBack(target.id); return {}; }
  if (found.group.collapsed) await chrome.tabGroups.update(found.group.id, { collapsed: false });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return {};
}
/** The relay operations `control` answers, and why each is refused without its signed request. */
const CONTROL_OPERATIONS = { stopGroup: 'Signed stop required', closeTab: 'Signed tab close required', focusTab: 'Signed tab focus required', takeOver: 'Signed take over required', resume: 'Signed resume required' };
/** Signs the begin request of one upload to the account (`upload.ts`) with this Chrome's pairing key. */
async function signUpload(method, pathname, bodySha256) {
  const identity = await stored('identity');
  if (!identity) throw new Error('Human pairing required');
  return relaySignature(identity, 'upload', method, pathname, bodySha256);
}
/** Why the Browser tab cannot capture a tab: it records only one the agent uses now, whose debugger is attached. */
const CAPTURE_IDLE = 'Capture from the Browser tab records a tab while the agent uses it; to record any tab of the workspace group, use Capture in the GitSpace extension popup';
/** How long `captureStart` waits for the first frame, whose size it answers with. */
const CAPTURE_FIRST_FRAME_MS = 2000;
/**
 * Captures recording in this Chrome, by capture id (docs/APERTURE-DESIGN.md §11): `video` (WebM with sound from
 * `chrome.tabCapture`, recorded and uploaded by the offscreen document) when you press Capture, or `frames` (the tab's
 * screencast, recorded here into `frames.bin` and `frames.json`) from the Browser tab, or from your Capture on a tab
 * Chrome gives no video of. Each stops at 30 minutes or 1 GiB, and the account hears how it ended.
 */
const captures = new Map();
/** The capture recording a tab, if any. */
function captureOn(tabId) { for (const capture of captures.values()) if (capture.tabId === tabId) return capture; return undefined; }
/** One file of a capture, uploaded as it is recorded. */
function captureUpload(capture, file, mediaType) { return new Upload(GITSPACE_ACCOUNT_URL, signUpload, { kind: 'capture', groupId: capture.groupId, captureId: capture.captureId, file, mediaType }); }
/** The toolbar and the tab's in-page control show a capture starting or ending. */
function capturesChanged(tabId) {
  updateToolbar();
  for (const channel of channels.values()) if (channel.tabId === tabId) void overlay(channel.targetId);
}
/** Records a tab's screencast frames through its one screencast (`TabScreencast`), and answers once the first frame
 * came (or `CAPTURE_FIRST_FRAME_MS` passed) with their size. `announce`: the extension started it, so it tells the
 * account (`capture` `start`); the Browser tab's `captureStart` named it already. */
async function startFramesCapture(channel, captureId, announce) {
  if (captureOn(channel.tabId)) throw new Error('This tab is already being captured');
  const tab = await chrome.tabs.get(channel.tabId);
  const startedAt = Date.now();
  const capture = { captureId, track: 'frames', groupId: channel.grant.groupId, tabId: channel.tabId, targetId: channel.targetId, url: (tab.url || '').slice(0, 8192), title: (tab.title || '').slice(0, 500), startedAt, channel, ending: null, timer: undefined };
  capture.frames = captureUpload(capture, 'frames.bin', 'application/octet-stream');
  const first = Promise.withResolvers();
  // The screencast acknowledges each frame once for every consumer.
  capture.recorder = new ScreencastRecorder({ startedAt, append: bytes => capture.frames.write(bytes), ack: async () => {}, limit: reason => { void endCapture(capture, reason, true); } });
  capture.consumer = { maxWidth: CAPTURE_SCREENCAST.maxWidth, maxHeight: CAPTURE_SCREENCAST.maxHeight, quality: CAPTURE_SCREENCAST.quality, frame: frame => { capture.recorder.frame(frame); first.resolve(frame); } };
  captures.set(captureId, capture);
  if (announce) send({ capture: { event: 'start', captureId, groupId: capture.groupId, targetId: capture.targetId, track: 'frames', sound: false, page: { url: capture.url, title: capture.title }, startedAt: new Date(startedAt).toISOString() } });
  try { await channel.screencast.add(capture.consumer); }
  catch (error) {
    captures.delete(captureId);
    if (announce) send({ capture: { event: 'end', captureId, state: 'failed', reason: 'Chrome did not start the screencast of this tab', endedAt: new Date().toISOString(), tracks: {} } });
    throw error;
  }
  capture.timer = setTimeout(() => { void endCapture(capture, 'The capture reached 30 minutes', true); }, CAPTURE_MAX_MS);
  capturesChanged(capture.tabId);
  const waited = setTimeout(() => first.resolve(null), CAPTURE_FIRST_FRAME_MS);
  const frame = await first.promise;
  clearTimeout(waited);
  const size = frame ? jpegSize(Uint8Array.from(atob(frame.data), character => character.charCodeAt(0))) : null;
  return { capture, size: size ?? { width: CAPTURE_SCREENCAST.maxWidth, height: CAPTURE_SCREENCAST.maxHeight } };
}
/** The offscreen document that records video, made when a recording starts and closed after the last one. */
let offscreenCreating = null;
async function offscreenDocument() {
  if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) return;
  offscreenCreating ??= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Records the tab you chose to capture, with its sound' }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}
/**
 * Starts your capture of a tab of a workspace group: video with its sound (`chrome.tabCapture`), which Chrome gives
 * only for a tab you invoked the extension on (opening this popup there). From the tab's in-page control
 * (`fallback`: its debugger channel), a tab Chrome gives no video of records its screencast frames instead.
 */
async function startCapture(tabId, fallback) {
  if (accountProtocol < MEDIA_PROTOCOL) throw new Error(connected ? 'Your GitSpace account does not save captures yet; update GitSpace' : 'GitSpace is not connected to your account');
  const tab = await chrome.tabs.get(tabId);
  const found = (await workspaceGroups()).find(({ group }) => group.id === tab.groupId);
  if (!found) throw new Error('Capture records a tab of a workspace group');
  if (captureOn(tabId)) throw new Error('This tab is already being captured');
  const targetId = (await targets()).find(target => target.tabId === tabId)?.id;
  if (!targetId) throw new Error('Chrome cannot capture this tab');
  let streamId;
  try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); }
  catch (error) { if (fallback) return startFramesCapture(fallback, crypto.randomUUID(), true); throw error; }
  const startedAt = Date.now();
  const capture = { captureId: crypto.randomUUID(), track: 'video', groupId: found.record.groupId, tabId, targetId, url: (tab.url || '').slice(0, 8192), title: (tab.title || '').slice(0, 500), startedAt, channel: null, ending: null, timer: undefined };
  captures.set(capture.captureId, capture);
  send({ capture: { event: 'start', captureId: capture.captureId, groupId: capture.groupId, targetId, track: 'video', sound: true, page: { url: capture.url, title: capture.title }, startedAt: new Date(startedAt).toISOString() } });
  try {
    await offscreenDocument();
    const started = await chrome.runtime.sendMessage({ target: 'offscreen', record: { captureId: capture.captureId, groupId: capture.groupId, streamId, account: GITSPACE_ACCOUNT_URL } });
    if (!started || started.error) throw new Error(started?.error ?? 'The recorder did not answer');
  } catch (error) {
    await endCapture(capture, null, true, { error: `Chrome could not record this tab: ${error.message}` });
    throw error;
  }
  capture.timer = setTimeout(() => { void endCapture(capture, 'The capture reached 30 minutes', true); }, CAPTURE_MAX_MS);
  capturesChanged(tabId);
  return { capture };
}
/**
 * Ends a capture once: stops recording, finishes its uploads and, with `announce`, tells the account how it ended
 * (`capture` `end`); the Browser tab's `captureStop` of frames hears it in its answer instead. `recorded`: what the
 * offscreen document reported for a video that ended on its own. Answers what a frames capture kept (`summary`).
 */
function endCapture(capture, reason, announce, recorded) {
  capture.ending ??= (async () => {
    clearTimeout(capture.timer);
    let tracks = {}, summary = null, failure = null;
    if (capture.track === 'frames') {
      await capture.channel.screencast.remove(capture.consumer).catch(() => {});
      try {
        const kept = await capture.recorder.stop();
        if (!kept.count) throw new Error('Chrome sent no frames of this tab');
        await capture.frames.complete();
        const index = captureUpload(capture, 'frames.json', 'application/json');
        await index.write(new TextEncoder().encode(JSON.stringify(kept.index)));
        await index.complete();
        if (kept.thumbnail) { const thumbnail = captureUpload(capture, 'thumbnail.jpg', 'image/jpeg'); await thumbnail.write(kept.thumbnail).then(() => thumbnail.complete()).catch(() => {}); }
        summary = { count: kept.count, width: kept.width, height: kept.height, durationMs: kept.durationMs };
        tracks = { frames: { path: 'frames.bin', index: 'frames.json', count: kept.count, width: kept.width, height: kept.height } };
      } catch (error) { failure = String(error.message || error); await capture.frames.abort(); }
    } else {
      const result = recorded ?? await chrome.runtime.sendMessage({ target: 'offscreen', stop: capture.captureId, reason }).catch(error => ({ error: error.message })) ?? { error: 'The recorder did not answer' };
      if (result.video) tracks = { video: { path: 'video.webm', ...result.video } }; else failure = result.error ?? 'The recording failed';
      reason ??= result.reason ?? null;
    }
    captures.delete(capture.captureId);
    capturesChanged(capture.tabId);
    if (capture.track === 'video' && ![...captures.values()].some(other => other.track === 'video')) await chrome.offscreen.closeDocument().catch(() => {});
    // A tab the debugger stayed on only for this capture is let go now that no script drives it.
    if (capture.channel?.heldForCapture && channels.get(capture.targetId) === capture.channel && ![...runs.values()].some(run => run.targets.has(capture.targetId))) await revoke(capture.targetId);
    if (announce) send({ capture: { event: 'end', captureId: capture.captureId, state: failure ? 'failed' : 'saved', reason: failure ?? reason ?? null, endedAt: new Date().toISOString(), tracks } });
    return { summary };
  })();
  return capture.ending;
}
/** A button of a tab's in-page control, or your own input there: Stop (the agent's work on the group), Capture, Stop
 * capture, Take over and Resume agent; `take` is your first trusted pointer or key press on a tab the agent is using
 * (a script runs on it or a single step uses it), which takes it unless it is the agent's own input. */
function overlayButton(debuggee, payload) {
  const channel = channels.get(debuggee.targetId);
  if (payload === 'resume') return handBack(debuggee.targetId);
  if (payload === 'capture') return startCapture(debuggee.tabId, channel ?? null);
  if (payload === 'captureStop') { const capture = captureOn(debuggee.tabId); return capture ? endCapture(capture, null, true) : Promise.resolve(); }
  if (!channel || heldBy(channel.targetId)) return Promise.resolve();
  if (payload === 'stop') return stopGroup(channel.grant.groupId);
  if (payload === 'takeover' || (payload === 'take' && ['run', 'step'].includes(overlayMode(channel)) && !agentInputs.has(channel.targetId))) return take(channel.targetId, channel.grant.groupId, 'chrome', null);
  return Promise.resolve();
}
/** Makes you the holder of a tab of workspace group `groupId`: taken in Chrome (`chrome`, no device) or from GitSpace
 * (`gitspace`, the signed-in device that took it). Taking a tab you hold already moves it to `by` and `device` and
 * keeps since when you hold it. */
async function take(targetId, groupId, by, device) {
  holders.set(targetId, { targetId, holder: 'you', since: heldBy(targetId)?.since ?? new Date().toISOString(), by, device, groupId });
  await holdersChanged(targetId, groupId);
}
/** Hands a tab you hold back to the agent. What the agent observed there is gone (it reads the page again, with your
 * changes), and a debugger kept only for your toolbar leaves the tab. */
async function handBack(targetId) {
  const held = heldBy(targetId);
  if (!held) return;
  holders.delete(targetId);
  const channel = channels.get(targetId);
  if (channel) { channel.refs.clear(); channel.names.clear(); }
  await holdersChanged(targetId, held.groupId);
  const debuggee = debuggees.get(targetId);
  if (debuggee && !channel && !watchesOn(debuggee).length) await detachTab(targetId, debuggee.source);
}
/** A tab's holder changed: kept for a restart, and the account (at once, not coalesced), the tab's toolbar, the
 * toolbar icon and the popup show it. */
async function holdersChanged(targetId, groupId) {
  await persist('holders', [...holders.values()]);
  updateToolbar();
  void overlay(targetId);
  await report(groupId).catch(() => {});
}
/** Hands back the tabs you hold that closed or left their workspace group. */
async function reconcileHolders() {
  if (!holders.size) return;
  const tabIds = new Map((await targets()).map(target => [target.id, target.tabId]));
  const records = await groupRecords();
  for (const held of [...holders.values()]) {
    const tabId = tabIds.get(held.targetId);
    if (tabId === undefined || !records.some(({ record }) => record.groupId === held.groupId && record.members?.[tabId])) await handBack(held.targetId);
  }
}
/**
 * Downloads an agent tab starts (docs/SIMPLIFICATION.md Batch 16 item 2): the tab's debugger reports each
 * (`Page.downloadWillBegin`) and `chrome.downloads` reports Chrome's download of the same URL, in either order. The
 * extension takes Chrome's copy out of your Downloads folder, reads the file through the tab's debugger session and
 * uploads it to the workspace's drive (`browser/downloads/<date>/<name>`) under the script's or step's attempt; the
 * account lists it in the run's result.
 */
const DOWNLOAD_MATCH_MS = 10_000;
/** How long a script's release waits for its downloads to be saved. */
const DOWNLOAD_RELEASE_MS = 60_000;
const DOWNLOAD_READ_BYTES = 1024 * 1024;
/** Downloads the tab reported that Chrome has not reported yet, and the other way round. */
const begunDownloads = [];
const chromeDownloads = [];
/** Downloads being saved, by attempt. */
const savingDownloads = new Map();
function downloadBegan(lease, params) {
  if (accountProtocol < MEDIA_PROTOCOL || typeof params.url !== 'string') return;
  let attemptId = [...runs].find(([, run]) => run.targets.has(lease.targetId) && live(run))?.[0];
  const step = authorizations.get(lease.grant.groupId);
  if (!attemptId && step?.body.command.type === 'execute' && step.targetId === lease.targetId && Date.parse(step.body.expiresAt) > Date.now() && Date.parse(step.body.dispatch.deadlineAt) > Date.now()) attemptId = step.body.scope.attemptId;
  if (!attemptId) return;
  const now = Date.now();
  const claim = Promise.withResolvers();
  const created = chromeDownloads.findIndex(entry => now - entry.at < DOWNLOAD_MATCH_MS && (entry.item.url === params.url || entry.item.finalUrl === params.url));
  if (created >= 0) claim.resolve(chromeDownloads.splice(created, 1)[0].item);
  else {
    const waiting = { url: params.url, claim };
    begunDownloads.push(waiting);
    setTimeout(() => { const index = begunDownloads.indexOf(waiting); if (index >= 0) begunDownloads.splice(index, 1); claim.resolve(null); }, DOWNLOAD_MATCH_MS);
  }
  const download = { url: params.url, name: typeof params.suggestedFilename === 'string' ? params.suggestedFilename : '', frameId: params.frameId, lease, attemptId, groupId: lease.grant.groupId };
  let jobs = savingDownloads.get(attemptId);
  if (!jobs) { jobs = new Set(); savingDownloads.set(attemptId, jobs); }
  const job = claim.promise.then(item => item ? saveDownload(item, download) : undefined)
    .catch(error => { console.warn(JSON.stringify({ event: 'gitspace_download_failed', url: download.url.slice(0, 200), error: String(error?.message || error) })); })
    .finally(() => { jobs.delete(job); if (!jobs.size && savingDownloads.get(attemptId) === jobs) savingDownloads.delete(attemptId); });
  jobs.add(job);
}
chrome.downloads.onCreated.addListener(item => {
  if (item.byExtensionId === chrome.runtime.id) return;
  const index = begunDownloads.findIndex(entry => entry.url === item.url || entry.url === item.finalUrl);
  if (index >= 0) { begunDownloads.splice(index, 1)[0].claim.resolve(item); return; }
  if (accountProtocol < MEDIA_PROTOCOL) return;
  const now = Date.now();
  for (let at = chromeDownloads.length - 1; at >= 0; at--) if (now - chromeDownloads[at].at >= DOWNLOAD_MATCH_MS) chromeDownloads.splice(at, 1);
  chromeDownloads.push({ item, at: now });
});
/** Waits (up to `DOWNLOAD_RELEASE_MS`) until the downloads of an attempt are saved, so the run's result lists them. */
async function downloadsSaved(attemptId) {
  const jobs = savingDownloads.get(attemptId);
  if (!jobs?.size) return;
  const timeout = Promise.withResolvers();
  const timer = setTimeout(timeout.resolve, DOWNLOAD_RELEASE_MS);
  await Promise.race([Promise.allSettled([...jobs]), timeout.promise]);
  clearTimeout(timer);
}
async function saveDownload(item, download) {
  // Out of your Downloads folder: Chrome's copy stops (or, already finished, is deleted) and leaves the list.
  await chrome.downloads.cancel(item.id).catch(() => {});
  const [current] = await chrome.downloads.search({ id: item.id }).catch(() => []);
  if (current?.state === 'complete') await chrome.downloads.removeFile(item.id).catch(() => {});
  await chrome.downloads.erase({ id: item.id }).catch(() => {});
  const source = await openDownload(download, item.mime || 'application/octet-stream');
  const name = (download.name || (item.filename || '').split(/[\\/]/).pop() || 'download').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 200) || 'download';
  const upload = new Upload(GITSPACE_ACCOUNT_URL, signUpload, { kind: 'download', groupId: download.groupId, attemptId: download.attemptId, name, mediaType: source.mediaType });
  try {
    for (let piece = await source.read(); piece; piece = await source.read()) await upload.write(piece);
    await upload.complete();
  } catch (error) { await upload.abort(); throw error; }
  finally { await source.close(); }
}
/** A download's file, read in pieces: a `data:` URL as it is, a `blob:` URL in an isolated world of the frame that
 * made it, anything else loaded again through the tab's debugger with the page's credentials. */
async function openDownload(download, fallbackType) {
  const { lease, url } = download;
  const decode = data => Uint8Array.from(atob(data), character => character.charCodeAt(0));
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const header = url.slice(5, comma);
    let bytes = header.endsWith(';base64') ? decode(url.slice(comma + 1)) : new TextEncoder().encode(decodeURIComponent(url.slice(comma + 1)));
    return { mediaType: header.split(';')[0] || 'text/plain', read: async () => { const piece = bytes; bytes = null; return piece; }, close: async () => {} };
  }
  if (url.startsWith('blob:')) {
    const world = await chrome.debugger.sendCommand(lease.source, 'Page.createIsolatedWorld', { frameId: download.frameId, worldName: 'gitspace-relay' });
    let offset = 0, total = 0;
    const piece = async () => {
      const result = await chrome.debugger.sendCommand(lease.source, 'Runtime.callFunctionOn', { functionDeclaration: downloadBlobReadFunction, arguments: [{ value: url }, { value: offset }, { value: DOWNLOAD_READ_BYTES }], executionContextId: world.executionContextId, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error('The page no longer holds this download (it revoked its blob URL)');
      const bytes = decode(result.result.value.data);
      total = result.result.value.total; offset += bytes.byteLength;
      return { bytes, type: result.result.value.type };
    };
    const first = await piece();
    let held = first.bytes;
    return { mediaType: (first.type || fallbackType).split(';')[0].trim(), read: async () => { if (held) { const bytes = held; held = null; return bytes; } return offset < total ? (await piece()).bytes : null; }, close: async () => {} };
  }
  const { resource } = await chrome.debugger.sendCommand(lease.source, 'Network.loadNetworkResource', { frameId: download.frameId, url, options: { disableCache: false, includeCredentials: true } });
  if (!resource.success || !resource.stream) throw new Error(`Could not load the download again (${resource.netErrorName || `HTTP ${resource.httpStatusCode}`})`);
  const contentType = Object.entries(resource.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  let eof = false;
  return {
    mediaType: String(contentType || fallbackType).split(';')[0].trim(),
    read: async () => {
      if (eof) return null;
      const chunk = await chrome.debugger.sendCommand(lease.source, 'IO.read', { handle: resource.stream, size: DOWNLOAD_READ_BYTES });
      eof = chunk.eof;
      const bytes = chunk.base64Encoded ? decode(chunk.data) : new TextEncoder().encode(chunk.data);
      return bytes.byteLength || !eof ? bytes : null;
    },
    close: () => chrome.debugger.sendCommand(lease.source, 'IO.close', { handle: resource.stream }).catch(() => {}),
  };
}
/** A drive file goes into a page's file input (`GitSpace.setInputFilesFromUrls`, checked by `relayRunCommand`): the
 * extension fetches each sealed `/files/` link itself, then hands the bytes to an isolated world of the tab in pieces,
 * which sets the input's files and fires input and change. Neither the link nor the account reaches the page. */
const INPUT_FILE_PIECE_BYTES = 3 * 1024 * 1024;
async function setInputFiles(lease, { backendNodeId, files }) {
  const contents = [];
  for (const file of files) {
    const response = await fetch(file.url, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read ${file.name} from the drive (HTTP ${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new Error(`${file.name} is ${bytes.byteLength} bytes in the drive, not ${file.size}`);
    contents.push(bytes);
  }
  const resolved = await chrome.debugger.sendCommand(lease.source, 'DOM.resolveNode', { backendNodeId, executionContextId: await isolatedContext(lease) });
  const objectId = resolved.object.objectId;
  try {
    const refusal = await fixedCall(lease, inputFilesPrepareFunction, [files.length], objectId);
    if (refusal) throw new Error(refusal);
    for (const [index, bytes] of contents.entries()) for (let offset = 0; offset === 0 || offset < bytes.byteLength; offset += INPUT_FILE_PIECE_BYTES) await fixedCall(lease, inputFilesChunkFunction, [index, base64Bytes(bytes.subarray(offset, offset + INPUT_FILE_PIECE_BYTES))], objectId);
    await fixedCall(lease, inputFilesSetFunction, [files.map(file => ({ name: file.name, mediaType: file.mediaType }))], objectId);
  } finally { await chrome.debugger.sendCommand(lease.source, 'Runtime.releaseObject', { objectId }).catch(() => {}); }
  return {};
}
/**
 * Share links (docs/APERTURE-DESIGN.md §8, `share.ts`): `liveShares` are this Chrome's live shares as the account last
 * told them (`shares`) or the popup made them; `watching` the shares people watch now, by share id, each a consumer
 * of its tab's screencast (`watch.consumer`) whose frames go to the relay (`shareFrame`), with its viewers' pointers.
 * Watching attaches the debugger to the tab if need be, also to a tab in no workspace group: the share is your consent
 * to that, for frames, pointers and what is under a point only.
 */
let liveShares = [];
/** The tab of each live share's target, so a share whose tab closed (and whose target is gone with it) ends. */
let sharedTabs = new Map();
/** The page each share was last reported on (`share` `page`), so only changes go out. */
const sharePages = new Map();
const watching = new Map();
/** A watched share's frames go out at most this often (4 a second), the newest when they come faster, and none while
 * the relay connection holds more than `SHARE_BACKLOG_BYTES` unsent. */
const SHARE_FRAME_MS = 250;
const SHARE_BACKLOG_BYTES = 512 * 1024;
const SHARE_FRAME_QUALITY = 60;
/** Share frames and comment crops are at most this large on a side; a frame at most `SHARE_FRAME_CHARACTERS` of
 * base64, a crop (JPEG at `SHARE_CROP_QUALITY`) at most `SHARE_CROP_BYTES`. */
const SHARE_FRAME_SIDE = 1280;
const SHARE_FRAME_CHARACTERS = 1_500_000;
const SHARE_CROP_QUALITY = 70;
const SHARE_CROP_BYTES = 400 * 1024;
/** The isolated world where the extension reads what is under a point of a shared tab. */
const SHARE_WORLD = 'gitspace-share';
/** Viewers of one share whose pointers are drawn, at most. */
const SHARE_POINTERS = 20;
const SHARE_OFFLINE = 'Sharing needs GitSpace connected to your account';
const SHARE_UPDATE = 'Your GitSpace account does not share tabs yet; update GitSpace';
const SHARE_WEB_ONLY = 'Only a web page (http or https) can be shared';
const SHARE_UNWATCHED = 'No one watches this share in this Chrome';
/** Relay messages about shares that carry no id and get no answer. */
const SHARE_NOTICES = { shares: true, sharePointers: true, shareEnded: true };
/** Relay operations on one share, which run one at a time per share. */
const SHARE_OPERATIONS = { shareWatch: true, shareUnwatch: true, shareHit: true, shareAnchor: true };
function watchesOn(debuggee) { return [...watching.values()].filter(watch => watch.debuggee === debuggee); }
/** A point on a tab's viewport, as fractions of it. */
function isPoint(value) { return typeof value === 'object' && value !== null && [value.x, value.y].every(part => typeof part === 'number' && part >= 0 && part <= 1); }
/** A share as the account describes it (`RuntimeBrowserShare`), as far as this Chrome uses it. */
function isShare(value) { return typeof value?.shareId === 'string' && typeof value.targetId === 'string' && typeof value.link === 'string' && typeof value.expiresAt === 'string' && Array.isArray(value.viewers); }
async function layoutViewport(debuggee) { return (await chrome.debugger.sendCommand(debuggee.source, 'Page.getLayoutMetrics')).cssLayoutViewport; }
/** A shared page's icon for its greeting (`shareTab`, `shareWatch`, `share` `page`): Chrome's favicon of the page from
 * its favicon store (`_favicon`), a PNG of at most `SHARE_ICON_BYTES` as a data URL, kept for the newest `SHARE_ICONS`
 * pages. Null where the tab shows no icon, or where Chrome has only its default for the page (one not stored yet, or a
 * private window), so a later report of the tab asks again. */
const SHARE_ICON_SIZE = 32;
const SHARE_ICON_BYTES = 8 * 1024;
const SHARE_ICONS = 32;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const shareIcons = new Map();
/** Chrome's default icon, which `_favicon` answers for a page it has no icon of. */
let defaultShareIcon;
async function shareIcon(tab) {
  if (!tab.favIconUrl || !siteOf(tab.url)) return null;
  const key = tab.url + '\n' + tab.favIconUrl;
  const kept = shareIcons.get(key);
  if (kept) return kept;
  const read = async pageUrl => {
    const url = new URL(chrome.runtime.getURL('_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', String(SHARE_ICON_SIZE));
    const response = await fetch(url.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return response.ok && bytes.byteLength <= SHARE_ICON_BYTES && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ? encode64(bytes) : null;
  };
  try {
    defaultShareIcon ??= read('https://gitspace.invalid/').catch(error => { defaultShareIcon = undefined; throw error; });
    const [icon, fallback] = await Promise.all([read(tab.url), defaultShareIcon]);
    if (!icon || icon === fallback) return null;
    const value = 'data:image/png;base64,' + icon;
    shareIcons.set(key, value);
    if (shareIcons.size > SHARE_ICONS) shareIcons.delete(shareIcons.keys().next().value);
    return value;
  } catch { return null; }
}
/** This Chrome's live shares changed: told by the account, or made or ended here. A share whose tab this Chrome no
 * longer has (it closed while Chrome or GitSpace was off) is reported closed, which ends it. Of calls that overlap, the
 * latest wins. */
let sharesVersion = 0;
async function setShares(shares) {
  const version = ++sharesVersion;
  liveShares = shares;
  const tabIds = new Map((await targets()).map(target => [target.id, target.tabId]));
  if (version !== sharesVersion) return;
  const gone = shares.filter(share => !tabIds.has(share.targetId));
  for (const share of gone) send({ share: { event: 'closed', shareId: share.shareId } });
  liveShares = gone.length ? shares.filter(share => tabIds.has(share.targetId)) : shares;
  for (const shareId of sharePages.keys()) if (!liveShares.some(share => share.shareId === shareId)) sharePages.delete(shareId);
  sharedTabs = new Map(liveShares.map(share => [share.targetId, tabIds.get(share.targetId)]));
}
/** A shared tab's page and viewport in CSS pixels: from its debugger session where it has one, else Chrome's size of
 * the tab; null when Chrome gives none. */
async function sharedPage(targetId) {
  const debuggee = debuggees.get(targetId);
  const tab = await chrome.tabs.get(debuggee?.tabId ?? (await targetInfo(targetId)).tabId);
  const viewport = debuggee ? await layoutViewport(await debuggee.attached) : { clientWidth: tab.width, clientHeight: tab.height };
  const width = Math.round(viewport.clientWidth), height = Math.round(viewport.clientHeight);
  return width > 0 && height > 0 ? { url: (tab.url || '').slice(0, 8192), title: (tab.title || '').slice(0, 500), width, height, icon: await shareIcon(tab) } : null;
}
/** Tells the account that a shared tab's page, title or viewport changed (`share` `page`), once per change and share. */
async function reportPages(targetId) {
  const shares = liveShares.filter(share => share.targetId === targetId);
  if (!shares.length) return;
  const page = await sharedPage(targetId);
  if (!page) return;
  const reported = JSON.stringify(page);
  for (const share of shares) if (sharePages.get(share.shareId) !== reported) { sharePages.set(share.shareId, reported); send({ share: { event: 'page', shareId: share.shareId, ...page } }); }
}
/** A shared tab closed: its shares end (`share` `closed`). */
function sharedTabClosed(tabId) {
  const ended = new Set([...liveShares.filter(share => sharedTabs.get(share.targetId) === tabId).map(share => share.shareId), ...[...watching.values()].filter(watch => watch.debuggee.tabId === tabId).map(watch => watch.shareId)]);
  for (const shareId of ended) { send({ share: { event: 'closed', shareId } }); const watch = watching.get(shareId); if (watch) void endWatch(watch); }
  if (ended.size) void setShares(liveShares.filter(share => !ended.has(share.shareId))).catch(() => {});
}
/** `shareTab`: the page of a tab about to be shared, and the workspace group holding it (null for none). */
async function shareTab(targetId) {
  const tab = await chrome.tabs.get((await targetInfo(targetId)).tabId);
  if (!siteOf(tab.url)) throw new Error(SHARE_WEB_ONLY);
  const found = (await workspaceGroups()).find(({ group }) => group.id === tab.groupId);
  return { url: tab.url.slice(0, 8192), title: (tab.title || '').slice(0, 500), groupId: found?.record.groupId ?? null, icon: await shareIcon(tab) };
}
/** `shareWatch`: someone watches a share: its tab's screencast streams at the size the largest viewer needs, asked
 * again with a new size when that changes. With `reportPointer` (accounts from extension 5.8 on), your own pointer over
 * the tab goes to the account too (`share` `pointer`), for the viewers to draw. Answers the tab's page and viewport. */
async function watchShare({ shareId, targetId, maxWidth, maxHeight, reportPointer }) {
  if (typeof shareId !== 'string' || typeof targetId !== 'string' || !Number.isSafeInteger(maxWidth) || !Number.isSafeInteger(maxHeight) || maxWidth < 1 || maxHeight < 1) throw new Error('Invalid share watch');
  let watch = watching.get(shareId);
  if (watch && watch.debuggee.targetId !== targetId) throw new Error('This share is of another tab');
  if (!watch) {
    watch = { shareId, debuggee: await debuggeeOf(await targetInfo(targetId)), consumer: { quality: SHARE_FRAME_QUALITY, maxWidth: 1, maxHeight: 1, frame: frame => shareFrame(shareId, frame) }, pending: null, timer: undefined, pointers: [], reportPointer: false };
    watching.set(shareId, watch);
  }
  watch.consumer.maxWidth = Math.min(maxWidth, SHARE_FRAME_SIDE);
  watch.consumer.maxHeight = Math.min(maxHeight, SHARE_FRAME_SIDE);
  if (watch.reportPointer !== (reportPointer === true)) { watch.reportPointer = reportPointer === true; void overlay(targetId); }
  try {
    await watch.debuggee.screencast.add(watch.consumer);
    const page = await sharedPage(targetId);
    if (!page) throw new Error('Chrome gives no size for this tab');
    sharePages.set(shareId, JSON.stringify(page));
    return page;
  } catch (error) { await endWatch(watch); throw error; }
}
/** One screencast frame of a watched share's tab: sent now unless one went out within `SHARE_FRAME_MS`, else kept as
 * the newest. A frame of another device size means the viewport changed, which the account hears as a page change. */
function shareFrame(shareId, frame) {
  const watch = watching.get(shareId);
  if (!watch) return;
  watch.pending = frame;
  if (watch.timer === undefined) sendShareFrame(watch);
  const viewport = `${frame.metadata?.deviceWidth}x${frame.metadata?.deviceHeight}`;
  if (watch.debuggee.viewport !== viewport) { watch.debuggee.viewport = viewport; void reportPages(watch.debuggee.targetId).catch(() => {}); }
}
/** Sends a watched share's newest frame with its image size (from its JPEG header, near the start of its data), then
 * waits `SHARE_FRAME_MS` before the next. While the relay connection is backed up, the newest frame waits. */
function sendShareFrame(watch) {
  watch.timer = undefined;
  if (watching.get(watch.shareId) !== watch || !watch.pending) return;
  if (!(socket?.bufferedAmount > SHARE_BACKLOG_BYTES)) {
    const { data } = watch.pending;
    watch.pending = null;
    const size = data.length <= SHARE_FRAME_CHARACTERS ? jpegSize(Uint8Array.from(atob(data.slice(0, 4096)), character => character.charCodeAt(0))) : null;
    if (size) send({ shareFrame: { shareId: watch.shareId, data, width: size.width, height: size.height } });
  }
  watch.timer = setTimeout(() => sendShareFrame(watch), SHARE_FRAME_MS);
}
/** Stops watching a share: its frames and pointers stop, and the debugger leaves its tab unless the agent or another
 * share still uses it. */
async function endWatch(watch) {
  if (watching.get(watch.shareId) !== watch) return;
  watching.delete(watch.shareId);
  clearTimeout(watch.timer);
  const { debuggee } = watch;
  await debuggee.screencast.remove(watch.consumer).catch(() => {});
  if (debuggees.get(debuggee.targetId) !== debuggee) return;
  if (channels.has(debuggee.targetId) || watchesOn(debuggee).length || heldBy(debuggee.targetId)) await overlay(debuggee.targetId);
  else await detachTab(debuggee.targetId, debuggee.source);
}
/** The relay's share notices: this Chrome's live shares, the pointers of a watched share's viewers, a share ended. */
async function shareNotice(message) {
  if (message.operation === 'shares') { if (Array.isArray(message.shares)) await setShares(message.shares.filter(share => isShare(share) && share.endedAt === null)); return; }
  const watch = watching.get(message.shareId);
  if (message.operation === 'sharePointers') {
    if (!watch || !Array.isArray(message.pointers)) return;
    watch.pointers = message.pointers.filter(pointer => typeof pointer?.viewerId === 'string' && typeof pointer.name === 'string' && /^#[0-9a-f]{6}$/i.test(pointer.color) && isPoint(pointer.at)).slice(0, SHARE_POINTERS)
      .map(pointer => ({ id: `${watch.shareId}:${pointer.viewerId}`, name: pointer.name.slice(0, 60), color: pointer.color, x: pointer.at.x, y: pointer.at.y }));
    await overlay(watch.debuggee.targetId);
    return;
  }
  if (watch) await endWatch(watch);
  await setShares(liveShares.filter(share => share.shareId !== message.shareId));
}
/** The inputs GitSpace's Watch dialog sends (`RuntimeBrowserRemoteInput`). */
const REMOTE_INPUTS = { mouse: true, wheel: true, key: true, touch: true, text: true };
/**
 * `remoteInput`: one input of yours from GitSpace's Watch dialog (docs/APERTURE-DESIGN.md §7.1) on a tab of the group
 * you hold, from the device that took it there; the account checked the same before sending it. Its positions,
 * fractions of the viewport, become CSS pixels of the viewport Chrome lays the tab out in, read again whenever the
 * tab's screencast shows another size. Nothing typed is kept or logged.
 */
async function remoteInput({ groupId, targetId, device, input }) {
  const held = typeof targetId === 'string' ? heldBy(targetId) : undefined;
  if (!held || held.groupId !== groupId || typeof device !== 'string' || held.device !== device) throw new Error('You do not hold this tab from this device');
  if (!REMOTE_INPUTS[input?.type]) throw new Error('Invalid input');
  const debuggee = await debuggeeOf(await targetInfo(targetId));
  if (debuggee.inputViewport?.key !== debuggee.viewport) {
    const key = debuggee.viewport, { clientWidth, clientHeight } = await layoutViewport(debuggee);
    debuggee.inputViewport = { key, width: clientWidth, height: clientHeight };
  }
  const { method, params } = remoteInputCommand(input, debuggee.inputViewport);
  await chrome.debugger.sendCommand(debuggee.source, method, params);
  return {};
}
/** How the overlay's binding call starts when it reports your own pointer over the tab (`report`), followed by the
 * point as JSON (fractions of the viewport), or `null` once it left the tab. */
const SHARER_POINTER = 'pointer ';
/** Your own pointer over a watched tab, from its overlay's world: each share watched there whose account draws it for
 * the viewers (`reportPointer`) hears where it is (`share` `pointer`). It is never drawn on the tab, under your cursor. */
function sharerPointer(debuggee, payload) {
  let at;
  try { at = JSON.parse(payload.slice(SHARER_POINTER.length)); } catch { return; }
  if (at !== null && !isPoint(at)) return;
  for (const watch of watchesOn(debuggee)) if (watch.reportPointer) send({ share: { event: 'pointer', shareId: watch.shareId, at: at && { x: at.x, y: at.y } } });
}
/** Runs `operation` with the tab's share world (`SHARE_WORLD`), made again once a navigation replaced it. */
async function inShareWorld(debuggee, operation) {
  const make = async () => {
    const tree = await chrome.debugger.sendCommand(debuggee.source, 'Page.getFrameTree');
    debuggee.world = (await chrome.debugger.sendCommand(debuggee.source, 'Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: SHARE_WORLD })).executionContextId;
  };
  if (!debuggee.world) await make();
  try { return await operation(debuggee.world); } catch { await make(); return operation(debuggee.world); }
}
/** What is under a point of a shared tab (`DOM.getNodeForLocation` at the point's CSS pixels on the layout viewport,
 * passing over what takes no pointer events, as a click would: the in-page overlay and the pointers it draws): the
 * element's box, accessible role and name, a little of its visible text and selectors that find it
 * (`shareTargetFunction`); null where Chrome finds nothing there, or only the overlay. */
async function shareTarget(debuggee, viewport, at) {
  const tab = (method, params) => chrome.debugger.sendCommand(debuggee.source, method, params);
  const width = viewport.clientWidth, height = viewport.clientHeight;
  try {
    const { backendNodeId } = await tab('DOM.getNodeForLocation', { x: Math.min(Math.floor(at.x * width), Math.ceil(width) - 1), y: Math.min(Math.floor(at.y * height), Math.ceil(height) - 1), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
    const read = await inShareWorld(debuggee, async executionContextId => {
      const { object } = await tab('DOM.resolveNode', { backendNodeId, executionContextId });
      try { const result = await tab('Runtime.callFunctionOn', { functionDeclaration: shareTargetFunction, objectId: object.objectId, returnByValue: true }); return result.exceptionDetails ? null : result.result?.value ?? null; }
      finally { await tab('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
    });
    if (!read) return null;
    const quad = (await tab('DOM.getBoxModel', { backendNodeId })).model.border;
    const xs = [quad[0], quad[2], quad[4], quad[6]].map(x => Math.min(1, Math.max(0, x / width))), ys = [quad[1], quad[3], quad[5], quad[7]].map(y => Math.min(1, Math.max(0, y / height)));
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    const node = (await tab('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }).catch(() => null))?.nodes?.find(entry => entry.backendDOMNodeId === backendNodeId);
    return { box, role: String(node?.role?.value ?? '').slice(0, 64), name: String(node?.name?.value ?? '').slice(0, 500), text: read.text, selectors: read.selectors };
  } catch { return null; }
}
/** `shareHit`: what is under a viewer's point of a watched share, for comment mode. */
async function shareHit({ shareId, at }) {
  const watch = watching.get(shareId);
  if (!watch) throw new Error(SHARE_UNWATCHED);
  if (!isPoint(at)) throw new Error('Invalid share point');
  return { target: await shareTarget(watch.debuggee, await layoutViewport(watch.debuggee), at) };
}
/** `shareAnchor`: where a viewer's comment points on a watched share: the page, the element at its point, the area
 * (that element's box, or the dragged one), the viewport and scroll, and a JPEG crop of the area. */
async function shareAnchor({ shareId, at, region }) {
  const watch = watching.get(shareId);
  if (!watch) throw new Error(SHARE_UNWATCHED);
  const box = isPoint(region) && [region.width, region.height].every(part => typeof part === 'number' && part >= 0 && part <= 1);
  if ((at !== undefined && !isPoint(at)) || (region !== undefined && !box) || (at === undefined && region === undefined)) throw new Error('A comment needs a point or an area of the tab');
  const { debuggee } = watch;
  const viewport = await layoutViewport(debuggee);
  const target = at ? await shareTarget(debuggee, viewport, at) : null;
  const area = region ?? target?.box ?? { x: at.x, y: at.y, width: 0, height: 0 };
  const tab = await chrome.tabs.get(debuggee.tabId);
  return {
    page: { url: (tab.url || '').slice(0, 8192), title: (tab.title || '').slice(0, 500) }, target, region: area,
    viewport: { width: Math.max(1, Math.round(viewport.clientWidth)), height: Math.max(1, Math.round(viewport.clientHeight)) },
    scroll: { x: viewport.pageX, y: viewport.pageY }, crop: await shareCrop(debuggee, viewport, area),
  };
}
/** A JPEG of an area of a shared tab without the overlay, made smaller until it fits `SHARE_CROP_BYTES`; null for an
 * empty area or one Chrome does not draw. */
async function shareCrop(debuggee, viewport, area) {
  const width = area.width * viewport.clientWidth, height = area.height * viewport.clientHeight;
  if (width < 1 || height < 1) return null;
  const clip = { x: viewport.pageX + area.x * viewport.clientWidth, y: viewport.pageY + area.y * viewport.clientHeight, width, height };
  const fit = Math.min(1, SHARE_FRAME_SIDE / width, SHARE_FRAME_SIDE / height);
  await overlay(debuggee.targetId, { conceal: true });
  try {
    for (const factor of [1, 0.5, 0.25]) {
      const { data } = await chrome.debugger.sendCommand(debuggee.source, 'Page.captureScreenshot', { format: 'jpeg', quality: SHARE_CROP_QUALITY, captureBeyondViewport: false, clip: { ...clip, scale: fit * factor } });
      if (data.length * 3 / 4 <= SHARE_CROP_BYTES) return data;
    }
    return null;
  } catch { return null; }
  finally { void overlay(debuggee.targetId, { conceal: false }); }
}
/** `adoptTab`: a tab whose share link you pasted into a workspace's composer joins that workspace's group as if you
 * dragged it in: yours, consenting to the site it shows. Where this Chrome has no Chrome group of that workspace group
 * yet, it is made from the group's latest signed grant here. */
async function adoptTab(groupId, targetId) {
  const tab = await chrome.tabs.get((await targetInfo(targetId)).tabId);
  const site = siteOf(tab.url);
  if (!site) throw new Error(SHARE_WEB_ONLY);
  const groups = await workspaceGroups();
  const holding = groups.find(({ group }) => group.id === tab.groupId);
  if (holding && holding.record.groupId !== groupId) throw new Error("This tab is in another workspace's group; drag it out first");
  const found = groups.find(({ record }) => record.groupId === groupId);
  if (found) {
    if (tab.groupId !== found.group.id) await chrome.tabs.group({ tabIds: [tab.id], groupId: found.group.id });
    await updateRecord(found.key, current => current?.chromeGroupId === found.group.id ? { ...current, members: { ...current.members, [tab.id]: { by: 'you', site } } } : current);
  } else {
    const authorization = authorizations.get(groupId);
    const grant = authorization?.body.command.type === 'execute' ? authorization.body.command.grant.body : null;
    if (!grant || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('This workspace has no group in this Chrome yet');
    const { key, record, browserEpoch } = await groupRecord(grant);
    const chromeGroupId = await chrome.tabs.group({ tabIds: [tab.id], ...(record ? { groupId: record.chromeGroupId } : {}) });
    await chrome.tabGroups.update(chromeGroupId, { title: groupTitle(grant.groupName, [...runs.values()].some(run => run.body.command.grant.body.groupId === groupId)), color: groupColor(grant.workspaceId), collapsed: false });
    await updateRecord(key, current => ({ groupId, chromeGroupId, browserEpoch, members: { ...(current?.chromeGroupId === chromeGroupId ? current.members : {}), [tab.id]: { by: 'you', site } } }));
  }
  scheduleReport(groupId);
  return { url: tab.url.slice(0, 8192), title: (tab.title || '').slice(0, 500) };
}
/** One signed share request answered with a share (`create`, `revoke`). */
async function signedShare(request) {
  const identity = await stored('identity');
  if (!identity) throw new Error('Human pairing required');
  const value = await shareRequest(GITSPACE_ACCOUNT_URL, identity, request);
  if (!isShare(value?.share)) throw new Error('The account answered the share with an unexpected reply');
  return value.share;
}
/** Copy link in the popup: a share of a web page in this Chrome, for `expiresInMinutes`, with comments only for a tab
 * in a workspace group (they land in that workspace). */
async function createShare({ tabId, comment, expiresInMinutes }) {
  if (!Number.isInteger(tabId) || typeof comment !== 'boolean' || !SHARE_EXPIRIES_MINUTES.includes(expiresInMinutes)) throw new Error('Invalid share');
  if (!connected) throw new Error(SHARE_OFFLINE);
  if (accountProtocol < SHARE_PROTOCOL) throw new Error(SHARE_UPDATE);
  const tab = await chrome.tabs.get(tabId);
  if (!siteOf(tab.url)) throw new Error(SHARE_WEB_ONLY);
  if (comment && !(await workspaceGroups()).some(({ group }) => group.id === tab.groupId)) throw new Error('Comments need the tab in a workspace group');
  const targetId = (await targets()).find(target => target.tabId === tabId)?.id;
  if (!targetId) throw new Error('Chrome cannot share this tab');
  const share = await signedShare({ op: 'create', targetId, comment, expiresInMinutes });
  await setShares([...liveShares.filter(other => other.shareId !== share.shareId), share]);
}
/** Stop sharing in the popup: the share ends for everyone watching. */
async function revokeShare(shareId) {
  await signedShare({ op: 'revoke', shareId });
  const watch = watching.get(shareId);
  if (watch) await endWatch(watch);
  await setShares(liveShares.filter(share => share.shareId !== shareId));
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
    const run = await activeRun(message.attemptId);
    const grant = run.body.command.grant.body;
    if (grant.groupId !== message.groupId) throw new Error('Script workspace group mismatch');
    return groupTabs(grant, run);
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
    // A tab you took over ends the script that opens it.
    if (message.targetId && heldBy(message.targetId)) { await endRun(message.attemptId, 'taken'); throw new Error(SCRIPT_TAKEN_REFUSAL); }
    const grant = message.grant.body;
    await groupRecord(grant, true);
    run.commands++;
    try {
      const refusal = message.targetId ? runTabRefusal(runTab(run, await member(grant, message.targetId))) : runDestinationRefusal({ grant: { origins: run.sites }, stepsOnly: grant.stepsOnly, read: grant.read ?? [] }, message.url || 'about:blank');
      if (refusal) throw new Error(refusal);
    } catch (error) { run.refused++; throw error; }
    const targetId = message.targetId || await createAgentTab(grant, message.url || 'about:blank');
    const channel = await attach(grant, targetId);
    // Chrome does not draw a tab behind yours, and under the script's focus emulation its animation frames then come
    // about once a second, so each Playwright action waited 1–2 s for its element to hold still. A 1×1 screencast
    // keeps the tab painting in the background without showing it; it takes no frames, and it ends when no script
    // drives the tab or the debugger leaves it.
    if (!channel.painting) { channel.painting = { maxWidth: 1, maxHeight: 1, quality: 1 }; await channel.screencast.add(channel.painting); }
    run.targets.add(targetId);
    run.targetId = targetId;
    lastUsed.set(grant.groupId, Date.now());
    void overlay(targetId);
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
    if (heldBy(targetId)) throw new Error(TAB_HELD_REFUSAL);
    const channel = await attach(grant, targetId);
    authorization.targetId = targetId;
    lastUsed.set(grant.groupId, Date.now());
    // The step's tab shows the overlay; one an earlier step used stops showing it.
    for (const other of channels.values()) if (other.grant.groupId === grant.groupId) void overlay(other.targetId);
    return {targetId,sessionId:channel.sessionId};
  }
  if (CONTROL_OPERATIONS[message.operation]) return control(message);
  if (message.operation === 'preview') {
    const authorization = management('preview', { groupId: message.groupId, targetId: message.targetId });
    if (!authorization) throw new Error('Signed tab preview required');
    return preview(authorization.body.scope, message.groupId, message.targetId);
  }
  if (message.operation === 'captureStart') {
    const authorization = typeof message.captureId === 'string' ? management('captureStart', { groupId: message.groupId, targetId: message.targetId, captureId: message.captureId }) : null;
    if (!authorization) throw new Error('Signed capture start required');
    const channel = channels.get(message.targetId);
    const scope = authorization.body.scope;
    if (!channel || channel.grant.groupId !== message.groupId || channel.grant.projectId !== scope.projectId || channel.grant.workspaceId !== scope.workspaceId) throw new Error(CAPTURE_IDLE);
    await check(message.targetId, channel);
    const { capture, size } = await startFramesCapture(channel, message.captureId, false);
    return { captureId: capture.captureId, ...size, url: capture.url, title: capture.title };
  }
  if (message.operation === 'captureStop') {
    if (!management('captureStop', { captureId: message.captureId })) throw new Error('Signed capture stop required');
    const capture = captures.get(message.captureId);
    if (!capture) throw new Error('This capture is not recording in this Chrome');
    // A video's end comes as its own event once its upload completes; frames answer here.
    if (capture.track === 'video') { void endCapture(capture, null, true); return {}; }
    const { summary } = await endCapture(capture, null, false);
    if (!summary) throw new Error('The capture could not be saved');
    return summary;
  }
  if (message.operation === 'release') { await downloadsSaved(message.attemptId); await endRun(message.attemptId, 'released'); return {}; }
  if (message.operation === 'shareTab') return shareTab(message.targetId);
  if (message.operation === 'shareWatch') return watchShare(message);
  if (message.operation === 'remoteInput') return remoteInput(message);
  if (message.operation === 'shareUnwatch') { const watch = watching.get(message.shareId); if (watch) await endWatch(watch); return {}; }
  if (message.operation === 'shareHit') return shareHit(message);
  if (message.operation === 'shareAnchor') return shareAnchor(message);
  if (message.operation === 'adoptTab') return adoptTab(message.groupId, message.targetId);
  if (message.operation !== 'command') throw new Error('Unsupported relay operation');
  // Before any await: the script's commands reach its tab in the order they arrived.
  if (message.attemptId !== undefined) return runCommand(message);
  // None of a single step's commands reach a tab you hold.
  if (heldBy(message.targetId)) throw new Error(TAB_HELD_REFUSAL);
  const lease = await check(message.targetId);
  const { method, params = {}, sessionId } = message;
  if (!allowed(lease.scope, lease.targetId, lease.sessionId, method, params, sessionId)) throw new Error('Command outside browser grant');
  lastUsed.set(lease.grant.groupId, Date.now());
  // A tab on a site at read takes only the commands that read it, whatever the step's action.
  const readOnly = readSiteStepRefusal(lease.grant.read ?? [], lease.urls, method);
  if (readOnly) throw new Error(readOnly);
  await constrainCommand(lease, message.targetId, method, params);
  // The step's authorization admitted it (`constrainCommand`): it counts as one of the step's commands.
  authorizations.get(lease.grant.groupId).commands++;
  reportActivity(lease.grant.groupId);
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
    if (method === 'Accessibility.getFullAXTree') { const document = lease.document; result = await chrome.debugger.sendCommand(lease.source, method, { depth: 32 }); if (document !== lease.document) throw new Error('Document changed during observation'); result.gitspaceDocument = document; for (const node of result.nodes || []) if (Number.isSafeInteger(node.backendDOMNodeId)) { lease.refs.add(node.backendDOMNodeId); if (typeof node.name?.value === 'string') lease.names.set(node.backendDOMNodeId, node.name.value); } }
    else {
      if (method === 'Input.dispatchMouseEvent') await overlay(lease.targetId, { cursor: { x: params.x, y: params.y, type: params.type } });
      const sending = chrome.debugger.sendCommand(lease.source, method, params);
      result = await (method.startsWith('Input.') ? agentInput(lease.targetId, sending) : sending);
    }
  }
  await check(message.targetId, lease);
  return result;
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId) return;
  const debuggee = debuggees.get(source.targetId);
  if (!debuggee) return;
  // The tab's one screencast feeds its consumers; no frame reaches a script or the relay as an event.
  if (method === 'Page.screencastFrame') { debuggee.screencast.frame(params); return; }
  if (method === 'Page.screencastVisibilityChanged') return;
  // The extension's own worlds never reach a session.
  if (method === 'Runtime.executionContextCreated' && (params.context?.name === OVERLAY_WORLD || params.context?.name === SHARE_WORLD)) return;
  if (method === 'Page.frameNavigated' && !params.frame.parentId) { if (debuggee.overlay) debuggee.overlay.contextId = null; debuggee.world = null; }
  // A new document lacks the overlay until it is drawn again.
  if (method === 'Page.loadEventFired' && debuggee.overlay) void overlay(debuggee.targetId);
  // The overlay's buttons, your own input there and your own pointer over a watched tab, from the overlay's own world
  // only, which no page script reaches. Neither they nor that world reach a session.
  if (method === 'Runtime.bindingCalled' && params.name === OVERLAY_BINDING) {
    if (typeof params.payload === 'string' && debuggee.overlay && params.executionContextId === debuggee.overlay.contextId) {
      if (params.payload.startsWith(SHARER_POINTER)) sharerPointer(debuggee, params.payload);
      else void overlayButton(debuggee, params.payload).catch(() => {});
    }
    return;
  }
  // Everything else is the agent's, on a tab it has a channel to; a tab only shares watch tells no one.
  const lease = channels.get(source.targetId);
  if (!lease) return;
  const id = lease.targetId;
  if (method === 'DOM.documentUpdated' || (method === 'Page.frameNavigated' && !params.frame.parentId)) { lease.document++; lease.refs.clear(); lease.names.clear(); }
  // Nothing of a tab you hold reaches the agent: not what you type, where you go or what you download.
  if (heldBy(id)) return;
  if (method === 'Page.downloadWillBegin') downloadBegan(lease, params);
  // A script's tab reports every event of its own session, without network credentials.
  if ([...runs.values()].some(run => run.targets.has(lease.targetId) && live(run))) { const forwarded = relayRunEvent(method, params); if (forwarded) forward(id, lease, { targetId: id, sessionId: lease.sessionId, method, params: forwarded }); return; }
  if (!['Page.frameNavigated', 'Page.loadEventFired', 'DOM.documentUpdated'].includes(method)) return;
  void check(id, lease).then(() => send({ targetId: id, sessionId: lease.sessionId, method, params })).catch(() => {});
});
chrome.debugger.onDetach.addListener(source => {
  // Shares watched there stop streaming until the account asks to watch them again.
  const debuggee = debuggees.get(source.targetId);
  if (debuggee) {
    debuggees.delete(source.targetId);
    for (const watch of watchesOn(debuggee)) { watching.delete(watch.shareId); clearTimeout(watch.timer); }
  }
  for (const [id, channel] of channels) if (channel.targetId === source.targetId) {
    channel.cancelNavigation?.(); channels.delete(id); send({ targetId: id, fenced: true });
    for (const capture of captures.values()) if (capture.channel === channel) void endCapture(capture, 'Recording stopped: Chrome’s debugger left this tab', true);
  }
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  for (const [id] of channels) void check(id).catch(() => {});
  // The overlay comes back on a page that loaded, whether or not its tab reports Page events.
  if (change.status === 'complete') for (const debuggee of debuggees.values()) if (debuggee.tabId === tabId && debuggee.overlay) void overlay(debuggee.targetId);
  // A page's icon arrives after its URL (`favIconUrl`), and is in Chrome's favicon store once the page loaded.
  if (change.url || change.title || change.favIconUrl || change.status === 'complete') for (const [targetId, sharedTabId] of sharedTabs) if (sharedTabId === tabId) void reportPages(targetId).catch(() => {});
  if ('groupId' in change) void join(tab, true).then(reconcileHolders).catch(() => {});
  else if ((change.url || change.title || change.status === 'complete') && tab.groupId >= 0) void groupRecords().then(records => { const found = records.find(({ record }) => record.chromeGroupId === tab.groupId); if (found) scheduleReport(found.record.groupId); }).catch(() => {});
});
chrome.tabs.onCreated.addListener(tab => { void serially(async () => {
  if (Number.isInteger(tab.openerTabId) && (await groupRecords()).some(({ record }) => record.members?.[tab.openerTabId])) pageTabs.add(tab.id);
}).then(() => { if (tab.groupId >= 0) return join(tab, false); }).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { void leave(tabId).then(reconcileHolders).catch(() => {}); sharedTabClosed(tabId); });
chrome.tabGroups.onRemoved.addListener(group => { void serially(async () => {
  for (const { key, record } of await groupRecords()) if (record.chromeGroupId === group.id) { await persist(key, null); scheduleReport(record.groupId); }
}).then(async () => { for (const [id, channel] of channels) { try { await check(id,channel); } catch {} } await reconcileHolders(); }).catch(() => { socket?.close(); }); });
/** After the connection ends: no step or script holds a tab, no share is watched, and the account tells the shares
 * again once connected. */
async function reset() {
  authorizations.clear();
  await Promise.all([...runs.keys()].map(attemptId => endRun(attemptId, 'disconnected')));
  await Promise.all([...watching.values()].map(endWatch));
  await Promise.all([...channels.keys()].map(revoke));
  liveShares = []; sharedTabs = new Map(); sharePages.clear();
}
/** Whether GitSpace is on in this Chrome (`enabled` in `chrome.storage.local`; on unless you turned it off), and when
 * it turns itself back on after "Off for 1 hour" (`reenableAt`, by the `relay-enable` alarm). Off, this Chrome keeps no
 * connection to the account and no debugger on any tab. */
let enabled = true;
let reenableAt = null;
const ENABLE_ALARM = 'relay-enable';
/** Whether the account accepted this connection, and whether this Chrome has an identity to connect with. */
let connected = false;
let paired = true;
/** What the account says about this Chrome (`chromeInfo`, after `ready` and whenever it changes): its name, the
 * projects that approved it, and each live workspace group's project by group id. Null until it said. */
let chromeInfo = null;
const switched = chrome.storage.local.get(['enabled', 'reenableAt']).then(async saved => {
  if (saved.enabled !== false) return;
  if (Number.isFinite(saved.reenableAt) && saved.reenableAt <= Date.now()) { await chrome.storage.local.remove(['enabled', 'reenableAt']); return; }
  enabled = false;
  reenableAt = Number.isFinite(saved.reenableAt) ? saved.reenableAt : null;
  // Chrome may drop alarms when it restarts.
  if (reenableAt !== null) await chrome.alarms.create(ENABLE_ALARM, { when: reenableAt });
}).catch(() => {});
void switched.then(updateToolbar);
/** Turns GitSpace on or off in this Chrome; off for `minutes` turns it back on after them. Turning it off ends every
 * script as Stop does, stops and saves every capture, lets every tab's debugger go (the tabs you hold stay yours, and
 * show their toolbar again once it is on), and closes the connection to the account until it is on again. */
function setEnabled(on, minutes) {
  identityOperations = identityOperations.catch(() => {}).then(async () => {
    await switched;
    await chrome.alarms.clear(ENABLE_ALARM);
    if (on) {
      enabled = true; reenableAt = null;
      await chrome.storage.local.remove(['enabled', 'reenableAt']);
      updateToolbar();
      void showHeld();
      await connect();
      return;
    }
    enabled = false; reenableAt = minutes ? Date.now() + minutes * 60_000 : null;
    await chrome.storage.local.set({ enabled: false, reenableAt });
    if (reenableAt !== null) await chrome.alarms.create(ENABLE_ALARM, { when: reenableAt });
    updateToolbar();
    await Promise.all([...runs.keys()].map(attemptId => endRun(attemptId, 'stopped')));
    await Promise.all([...captures.values()].map(capture => endCapture(capture, 'You turned GitSpace off in this Chrome', true)));
    managingIdentity = true; identityGeneration++;
    const previous = socket; socket = undefined; connected = false;
    previous?.close();
    for (const channel of channels.values()) channel.cancelNavigation?.();
    try { await Promise.allSettled([...queues.values()]); await reset(); await Promise.all([...debuggees.values()].map(debuggee => detachTab(debuggee.targetId, debuggee.source))); } finally { managingIdentity = false; updateToolbar(); }
  });
  return identityOperations;
}
/** The toolbar icon, badge and tooltip last set, so they are set again only when what they show changes. */
let toolbar = '';
const toolbarIcons = new Map();
/** The workspace groups the agent acts on now: a script runs there, or a single step's authority lasts. */
function actingGroups() {
  const now = Date.now(), acting = new Set();
  for (const run of runs.values()) if (live(run)) acting.add(run.body.command.grant.body.groupId);
  for (const [groupId, step] of authorizations) if (step.body.command.type === 'execute' && Date.parse(step.body.expiresAt) > now && Date.parse(step.body.dispatch.deadlineAt) > now) acting.add(groupId);
  return acting;
}
/** Shows on the toolbar whether GitSpace is off, on and idle, working (agents acting and captures recording: their
 * count on the badge), or needs you (`!`): on but not connected, not paired, or refused as incompatible. */
function updateToolbar() {
  const running = runs.size;
  const recording = captures.size;
  const working = actingGroups().size + recording;
  const host = new URL(GITSPACE_ACCOUNT_URL).host;
  const holding = holders.size;
  const state = !enabled ? 'off' : recording ? 'working' : incompatible || !paired || !connected ? 'attention' : holding ? 'you' : working ? 'working' : 'on';
  const title = !enabled ? 'GitSpace is off in this Chrome' + (reenableAt === null ? '' : ' until ' + new Date(reenableAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
    : recording ? `GitSpace is recording ${recording === 1 ? 'a tab' : `${recording} tabs`} in this Chrome`
    : incompatible ? 'GitSpace needs an update in this Chrome' : !paired ? 'GitSpace: pair this Chrome in GitSpace, Plugins → Browsers' : !connected ? 'GitSpace is connecting to ' + host
    : holding ? `You're in control of ${holding === 1 ? 'a tab' : `${holding} tabs`}`
    : running ? `GitSpace is running ${running} ${running === 1 ? 'script' : 'scripts'} in this Chrome` : working ? 'GitSpace: an agent is using this Chrome' : 'GitSpace is on · ' + host;
  // While you hold a tab, the badge still counts the workspaces agents act on.
  const badge = state === 'working' || (state === 'you' && working) ? String(working) : state === 'attention' ? '!' : '';
  const shown = JSON.stringify([state, title, badge]);
  if (shown === toolbar) return;
  toolbar = shown;
  // Only the toolbar: a failure here never fails the script or connection that changed it.
  try {
    if (!toolbarIcons.has(state)) {
      const imageData = {};
      for (const size of [16, 32]) { const context = new OffscreenCanvas(size, size).getContext('2d'); drawToolbarIcon(context, size, state); imageData[size] = context.getImageData(0, 0, size, size); }
      toolbarIcons.set(state, imageData);
    }
    void Promise.all([chrome.action.setIcon({ imageData: toolbarIcons.get(state) }), chrome.action.setBadgeBackgroundColor({ color: state === 'attention' ? TOOLBAR_TONE.attention : TOOLBAR_TONE.working }), chrome.action.setBadgeTextColor({ color: '#ffffff' }), chrome.action.setBadgeText({ text: badge }), chrome.action.setTitle({ title })]).catch(() => {});
  } catch {}
}
async function connect() {
  await switched;
  // A tab you held before this worker started stays yours from its first command on.
  await holdersRestored;
  if (managingIdentity || !enabled) return;
  const generation = identityGeneration;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  await chrome.storage.local.remove('pairingCode');
  const identity = await stored('identity');
  paired = Boolean(identity); updateToolbar();
  if (!identity || managingIdentity || !enabled || generation !== identityGeneration || (socket && socket.readyState <= WebSocket.OPEN)) return;
  const protocols = [];
  if (!pairingCode) {
    const issuedAt = Date.now(), nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = encode64(await crypto.subtle.sign('Ed25519', identity.privateKey, new TextEncoder().encode('gitspace-browser-relay-v2:admission:' + identity.pairingId + ':' + identity.generation + ':' + issuedAt + ':' + nonce)));
    protocols.push('gitspace-admission.' + btoa(JSON.stringify({ pairingId: identity.pairingId, generation: identity.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''));
  }
  if (managingIdentity || !enabled || generation !== identityGeneration || (socket && socket.readyState <= WebSocket.OPEN)) return;
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
          // `platform`: this Chrome's OS, for Plugins → Browsers. `chromeInfo`: this extension takes the account's notices
          // about this Chrome; `controls`: it takes Stop, Close tab and Focus in Chrome from GitSpace (`stopGroup`,
          // `closeTab`, `focusTab`); `siteLevels`: it enforces a grant's sites at read; `takeover`: it takes `takeOver`
          // and `resume`, and refuses the agent's commands on a tab you hold.
          connection.send(JSON.stringify({ hello: true, Browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || 'Chrome', protocol: EXTENSION_PROTOCOL, extension: chrome.runtime.getManifest().version, platform: await platform, chromeInfo: true, controls: true, siteLevels: true, takeover: true }));
          return;
        } finally { authenticating = false; }
      }
      if (message.pairing) throw new Error('Repeated pairing handshake');
      if (message.updateRequired) {
        incompatible = 'Update required: this extension speaks protocol ' + EXTENSION_PROTOCOL + '; your GitSpace account needs ' + message.updateRequired.minimum + ' or later. Download the extension again from GitSpace (Plugins → Browsers) and reload it.';
        await chrome.storage.local.set({ compatibility: incompatible });
        updateToolbar();
        return;
      }
      if (message.ready === true) {
        // A release accepts its protocol and the one before; so does the extension. Older relays report none (0).
        const account = typeof message.protocol === 'number' ? message.protocol : 0;
        if (account < EXTENSION_PROTOCOL - 1) {
          incompatible = 'This GitSpace account runs an older release (protocol ' + account + ') than this extension supports (' + EXTENSION_PROTOCOL + '). Download the extension that this account offers in Plugins → Browsers.';
          await chrome.storage.local.set({ compatibility: incompatible });
          updateToolbar();
          connection.close();
        } else {
          connected = true; accountProtocol = account; accountActivity = message.groupActivity === true; accountTakeover = message.takeover === true; updateToolbar(); await chrome.storage.local.remove('compatibility');
          void groupRecords().then(records => { for (const { record } of records) scheduleReport(record.groupId); }).catch(() => {});
          // The in-page controls show Capture once the account saves captures.
          for (const targetId of debuggees.keys()) void overlay(targetId);
        }
        return;
      }
    } catch { connection.close(); return; }
    if (message.operation === 'revoke') for (const channel of channels.values()) if (channel.grant.groupId === message.groupId) channel.cancelNavigation?.();
    if (SHARE_NOTICES[message.operation]) { void shareNotice(message).catch(() => {}); return; }
    if (message.operation === 'chromeInfo') {
      if (typeof message.name === 'string' && Array.isArray(message.projects) && Array.isArray(message.groups)) chromeInfo = {
        name: message.name.slice(0, 128),
        // When you paired this Chrome; null for a Chrome paired before GitSpace recorded it.
        pairedAt: typeof message.pairedAt === 'string' && Number.isFinite(Date.parse(message.pairedAt)) ? message.pairedAt : null,
        projects: message.projects.filter(project => typeof project === 'string').slice(0, 32).map(project => project.slice(0, 128)),
        groups: new Map(message.groups.filter(group => typeof group?.groupId === 'string' && typeof group.project === 'string').slice(0, 1000).map(group => [group.groupId, group.project.slice(0, 128)])),
      };
      return;
    }
    const key = SHARE_OPERATIONS[message.operation] ? 'share:' + message.shareId : message.operation === 'remoteInput' ? 'input:' + message.targetId : 'commands';
    const start = () => { if (socket !== connection || connection.readyState !== WebSocket.OPEN) throw new Error('Disconnected command'); return execute(message); };
    // A script's commands do not wait for one another (it may await one while sending the next), nor does `shareTab`
    // (asked while this Chrome's own share request waits on it); the operations on one share run one at a time, and so
    // does your input on one tab (in the order you made it), apart from everything else, which runs one at a time.
    const concurrent = (message.operation === 'command' && message.attemptId !== undefined) || message.operation === 'shareTab';
    const operation = concurrent ? Promise.resolve().then(start) : (queues.get(key) || Promise.resolve()).catch(() => {}).then(start);
    if (!concurrent) queues.set(key, operation);
    void operation.then(result => { if (socket === connection) send({ id: message.id, result }); }, error => { if (socket === connection) send({ id: message.id, error: { message: String(error.message || error).slice(0, 500) } }); }).finally(() => { if (queues.get(key) === operation) queues.delete(key); });
  };
  connection.onclose = () => {
    clearTimeout(handshakeTimeout);
    if (socket !== connection) return;
    for (const channel of channels.values()) channel.cancelNavigation?.();
    socket = undefined; connected = false; accountProtocol = 0; accountActivity = false; accountTakeover = false; identityGeneration++; managingIdentity = true;
    updateToolbar();
    identityOperations = identityOperations.catch(() => {}).then(async () => {
      try { await Promise.allSettled([...queues.values()]); await reset(); }
      // An incompatible extension stays disconnected until it is reloaded or re-paired, instead of retrying every second.
      finally { managingIdentity = false; if (!incompatible) setTimeout(connect, 1000); }
    });
  };
  connection.onerror = () => connection.close();
}
/** The workspace groups this extension records in this browser session, with their Chrome groups. */
async function workspaceGroups() {
  const { browserEpoch } = await chrome.storage.session.get('browserEpoch');
  const found = [];
  for (const { key, record } of await groupRecords()) if (record.browserEpoch === browserEpoch) { try { found.push({ key, record, group: await chrome.tabGroups.get(record.chromeGroupId) }); } catch {} }
  return found;
}
/** What the popup shows: whether GitSpace is on here and connected, this Chrome's name, when you paired it and the
 * projects that approved it (as the account said), each workspace group using this Chrome with its project and what the
 * agent is doing there, the workspace group of the tab you are looking at with Capture (or its recording), sharing that
 * tab (when it shows a web page) with its live shares, the captures recording, this Chrome's identity, and the latest
 * scripts. */
async function popupState() {
  const identity = await stored('identity');
  const digest = identity ? await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(identity.publicKey), c => c.charCodeAt(0))) : undefined;
  const acting = actingGroups();
  const groups = [];
  for (const { record, group } of await workspaceGroups()) groups.push({ groupId: record.groupId, chromeGroupId: group.id, name: groupTitle(group.title ?? '', false), color: GROUP_HEX[group.color] ?? GROUP_HEX.grey,
    project: chromeInfo?.groups.get(record.groupId) ?? null, tabs: (await chrome.tabs.query({ groupId: group.id })).length, acting: acting.has(record.groupId) ? activity.get(record.groupId) ?? null : null,
    held: [...holders.values()].some(held => held.groupId === record.groupId) });
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabGroup = active ? groups.find(group => group.chromeGroupId === active.groupId) : undefined;
  const recording = tabGroup ? captureOn(active.id) : undefined;
  const shared = active && siteOf(active.url) ? (await targets()).find(target => target.tabId === active.id) : undefined;
  return {
    enabled, reenableAt, account: new URL(GITSPACE_ACCOUNT_URL).host, chrome: chromeInfo?.name ?? null, projects: chromeInfo?.projects ?? null,
    connection: !enabled ? 'off' : incompatible ? 'update' : !identity ? 'unpaired' : connected ? 'connected' : 'connecting',
    fingerprint: digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') : null, pairedAt: chromeInfo?.pairedAt ?? null,
    compatibility: (await chrome.storage.local.get('compatibility')).compatibility ?? null,
    groups: groups.map(({ chromeGroupId, ...group }) => group),
    activeTab: tabGroup ? { tabId: active.id, groupId: tabGroup.groupId, name: tabGroup.name, color: tabGroup.color,
      capture: recording ? { recording: recording.captureId, unavailable: null } : { recording: null, unavailable: !connected ? 'Capture needs GitSpace connected to your account' : accountProtocol < MEDIA_PROTOCOL ? 'Your GitSpace account does not save captures yet; update GitSpace' : null } } : null,
    shareTab: shared ? { tabId: active.id, host: new URL(active.url).hostname, grouped: Boolean(tabGroup), unavailable: !connected ? SHARE_OFFLINE : accountProtocol < SHARE_PROTOCOL ? SHARE_UPDATE : null } : null,
    shares: shared ? liveShares.filter(share => share.targetId === shared.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : [],
    recordings: [...captures.values()].map(capture => ({ captureId: capture.captureId, title: capture.title, track: capture.track, startedAt: capture.startedAt, saving: capture.ending !== null })),
    log: ((await stored('run-log')) || []).slice(0, 10),
  };
}
/** Show in the popup: the first tab of a workspace group, in front. */
async function focusGroup(groupId) {
  const found = (await workspaceGroups()).find(({ record }) => record.groupId === groupId);
  const [first] = found ? (await chrome.tabs.query({ groupId: found.group.id })).sort((a, b) => a.index - b.index) : [];
  if (!first) throw new Error('This workspace group has no tabs in this Chrome');
  if (found.group.collapsed) await chrome.tabGroups.update(found.group.id, { collapsed: false });
  await chrome.tabs.update(first.id, { active: true });
  await chrome.windows.update(first.windowId, { focused: true });
}
/** Remove from group in the popup: the tab leaves its workspace group and stays open; the agent no longer sees it. */
async function ungroupTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!(await workspaceGroups()).some(({ group }) => group.id === tab.groupId)) throw new Error('This tab is not in a workspace group');
  await chrome.tabs.ungroup(tabId);
}
/** The popup's requests besides pairing; each answers with what the popup shows next. */
function popupRequest(message) {
  if (message.popupState === true) return popupState();
  if (typeof message.setEnabled?.enabled === 'boolean') {
    const { enabled: on, minutes } = message.setEnabled;
    if (minutes !== undefined && (on || !Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60)) return Promise.reject(new Error('Invalid time off'));
    return setEnabled(on, minutes).then(popupState);
  }
  if (typeof message.stopGroup === 'string') return stopGroup(message.stopGroup).then(popupState);
  if (typeof message.focusGroup === 'string') return focusGroup(message.focusGroup).then(popupState);
  if (Number.isInteger(message.ungroupTab)) return ungroupTab(message.ungroupTab).then(popupState);
  // Your click on Capture in this popup is what lets Chrome record the tab.
  if (Number.isInteger(message.startCapture)) return startCapture(message.startCapture, null).then(popupState);
  if (typeof message.stopCapture === 'string') { const capture = captures.get(message.stopCapture); return (capture ? endCapture(capture, null, true) : Promise.resolve()).then(popupState); }
  if (typeof message.shareCreate === 'object' && message.shareCreate !== null) return createShare(message.shareCreate).then(popupState);
  if (typeof message.shareRevoke?.shareId === 'string') return revokeShare(message.shareRevoke.shareId).then(popupState);
  // Open GitSpace: the account, in a tab of its own.
  if (message.openAccount === true) return chrome.tabs.create({ url: GITSPACE_ACCOUNT_URL }).then(popupState);
}
/** The offscreen document's requests: signing the begin request of its uploads, and a recording that ended on its own. Hearing
 * from it at all keeps this worker running while it records. */
function offscreenRequest(message, respond) {
  if (message.uploadSign) {
    const { captureId, method, pathname, bodySha256 } = message.uploadSign;
    const signing = captures.get(captureId)?.track === 'video' && method === 'POST' && pathname === '/api/browser-relay/uploads' ? signUpload(method, pathname, bodySha256) : Promise.reject(new Error('This capture is not recording'));
    void signing.then(header => respond({ header }), error => respond({ error: error.message }));
    return true;
  }
  if (typeof message.captureEnded?.captureId === 'string') {
    const result = message.captureEnded;
    // A worker that restarted lost the capture, but the account still hears how it ended.
    const capture = captures.get(result.captureId) ?? { captureId: result.captureId, track: 'video', tabId: null, channel: null, ending: null, timer: undefined };
    void endCapture(capture, result.reason ?? null, true, result);
  }
}
/** The pairing details a short code from GitSpace (Plugins → Browsers → Pair a Chrome) stands for. The account answers
 * each code once, so this asks only for a Chrome that has no identity yet. */
async function redeemPairingCode(text) {
  if (await stored('identity')) throw new Error('This Chrome is paired already. Reset identity first, then pair it again.');
  const response = await fetch(new URL('/api/browser-relay/pairing-code', GITSPACE_ACCOUNT_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: text.trim().slice(0, 64) }) });
  const reply = await response.json().catch(() => null);
  if (!response.ok || reply?.status !== 'ok') throw new Error(reply?.error?.message || 'GitSpace did not take this code (' + response.status + ')');
  return reply.value;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('offscreen.html')) return offscreenRequest(message, respond);
if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
const request = popupRequest(message);
if (request) { void request.then(respond, error => respond({ error: error.message })); return true; }
// A short pairing code (`pairCode`), redeemed with GitSpace for the pairing's details.
if (typeof message.pairCode !== 'string' && message.resetIdentity !== true) return;
identityOperations = identityOperations.catch(() => {}).then(async () => {
  // A code that GitSpace refuses changes nothing here.
  const details = message.resetIdentity === true ? null : await redeemPairingCode(message.pairCode);
  // Captures are saved under this identity before it changes.
  await Promise.all([...captures.values()].map(capture => endCapture(capture, 'This Chrome’s GitSpace pairing changed', true)));
  managingIdentity = true;
  identityGeneration++;
  const previous = socket; socket = undefined; connected = false; accountProtocol = 0; accountActivity = false; accountTakeover = false; pairingCode = undefined; chromeInfo = null;
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
      await deleted.promise; paired = false; updateToolbar(); respond({ ok: true }); return;
    }
  const { code, trust, pairingId, generation } = details;
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
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ENABLE_ALARM) { void setEnabled(true).catch(() => {}); return; }
  for (const [id] of channels) void check(id).catch(() => {});
  for (const [attemptId, run] of runs) if (!live(run)) void endRun(attemptId, 'deadline').catch(() => {});
  // Keeps each overlay from expiring, and takes down that of a single step that has ended.
  for (const targetId of debuggees.keys()) void overlay(targetId);
  void collapseIdle().catch(() => {}); void connect();
});
// A group marked while scripts ran before this worker started has none running now.
void groupRecords().then(records => { for (const { record } of records) void markRunning(record.groupId); }).catch(() => {});
/** The tabs you hold show their toolbar (the debugger attached for it), after this worker starts or GitSpace is on
 * again; off, no tab has the debugger. */
async function showHeld() {
  await switched;
  if (!enabled) return;
  for (const targetId of holders.keys()) { try { await debuggeeOf(await targetInfo(targetId)); await overlay(targetId); } catch {} }
}
// Tabs you held before this worker started stay yours while they are in their group.
void holdersRestored.then(reconcileHolders).then(showHeld).catch(() => {});
connect();
