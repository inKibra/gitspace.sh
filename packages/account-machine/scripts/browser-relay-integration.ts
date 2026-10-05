import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from '@playwright/test';
import { BrowserRelaySupervisor } from '../src/browser-relay.js';
import { signRuntimeBrowserAuthorityCertificate, signRuntimeBrowserAuthorization, signRuntimeBrowserGrant, type RuntimeBrowserArguments, type RuntimeBrowserAuthorizationBody } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { pollUntilReady } from './poll-until-ready.js';

// Explicit opt-in. This always uses an ephemeral profile and never connects to a user's Chrome.
if (process.env.GITSPACE_BROWSER_RELAY_INTEGRATION !== '1') throw new Error('Set GITSPACE_BROWSER_RELAY_INTEGRATION=1 and CHROME_PATH to opt in');
if (!process.env.CHROME_PATH) throw new Error('CHROME_PATH must identify a Chrome for Testing executable supporting unpacked extensions');
const root = await mkdtemp(join(tmpdir(), 'gitspace-extension-proof-'));
const delayedResourceRequested = Promise.withResolvers<void>();
const releaseDelayedResource = Promise.withResolvers<void>();
const slowResourceRequested = Promise.withResolvers<void>();
const releaseSlowResource = Promise.withResolvers<void>();
const slowDocumentRequested = Promise.withResolvers<void>();
const releaseSlowDocument = Promise.withResolvers<void>();
const slowDocumentResourceRequested = Promise.withResolvers<void>();
const releaseSlowDocumentResource = Promise.withResolvers<void>();
const site = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 60, fetch: async request => {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/redirect-foreign') return Response.redirect(`http://localhost:${other.port}/redirected`);
  if (pathname === '/delayed-resource') { delayedResourceRequested.resolve(); await releaseDelayedResource.promise; return new Response('done', { headers: { 'content-type': 'text/plain' } }); }
  if (pathname === '/slow-resource') { slowResourceRequested.resolve(); await releaseSlowResource.promise; return new Response('done'); }
  if (pathname === '/slow-document') { slowDocumentRequested.resolve(); await releaseSlowDocument.promise; }
  if (pathname === '/slow-document-resource') { slowDocumentResourceRequested.resolve(); await releaseSlowDocumentResource.promise; return new Response('done'); }
  return new Response(`<html><title>${pathname}</title><body><h1>Relay fixture</h1><input value="private">${pathname === '/delayed-load' ? '<iframe src="/fast-frame"></iframe><img src="/delayed-resource">' : pathname === '/slow-load' ? '<img src="/slow-resource">' : pathname === '/slow-document' ? '<img src="/slow-document-resource">' : ''}</body></html>`, { headers: { 'content-type': 'text/html' } });
} });
const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><title>Other origin</title></html>', { headers: { 'content-type': 'text/html' } }) });
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = portProbe.port!; await portProbe.stop(true);
const relay = new BrowserRelaySupervisor({ environmentRoot: join(root, 'environment'), privateRoot: join(root, 'private'), machineId: 'machine', enabled: true, port });
const accountKeys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const workspaceKeys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
assert.ok('privateKey' in accountKeys && 'publicKey' in accountKeys);
assert.ok('privateKey' in workspaceKeys && 'publicKey' in workspaceKeys);
const trust = { accountId: 'account', algorithm: 'Ed25519' as const, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', accountKeys.publicKey)).toString('base64') };
const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: trust.accountId, projectId: 'project', workspaceId: 'workspace', publicKey: Buffer.from(await crypto.subtle.exportKey('raw', workspaceKeys.publicKey)).toString('base64'), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() }, accountKeys.privateKey);
async function signed(command: RuntimeBrowserAuthorizationBody['command'], workspaceId = 'workspace', certificate = authority) {
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  return signRuntimeBrowserAuthorization({ scope: { projectId: 'project', workspaceId, conversationId: 'conversation', machineId: 'machine', attachmentId: 'attachment', generation: 1, taskId: 'task', requestId: crypto.randomUUID(), attemptId: crypto.randomUUID() }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: command.type === 'execute' ? 'browser' : 'browser_control', deadlineAt: expiresAt, replay: 'unsafe' }, command }, workspaceKeys.privateKey, certificate);
}
let context: BrowserContext | undefined;
try {
  const status = await relay.setup();
  assert.equal((await fetch(relay.endpoint + '/json/version')).status, 403);
  context = await chromium.launchPersistentContext(join(root, 'private-chrome-profile'), { executablePath: process.env.CHROME_PATH, headless: true, args: [`--disable-extensions-except=${relay.extensionPath}`, `--load-extension=${relay.extensionPath}`] });
  let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#fingerprint').filter({ hasText: 'No identity.' }).waitFor();
  await popup.locator('#code').fill(JSON.stringify({ machineId: 'machine', code: status.pairingCode!, trust })); await popup.locator('#pair button').click();
  await pollUntilReady(async () => (await relay.status()).connected, { timeoutMs: 10_000, message: 'generated extension did not pair' });
  const initialFingerprint = (await relay.status()).pairedKeyFingerprint;
  assert.match(initialFingerprint!, /^[a-f0-9]{64}$/);
  await popup.locator('#fingerprint').filter({ hasText: initialFingerprint! }).waitFor();
  assert.equal(await popup.locator('#fingerprint').textContent(), initialFingerprint);
  if (process.env.GITSPACE_BROWSER_RELAY_SCREENSHOT) {
    await popup.setViewportSize({ width: 360, height: 320 });
    await popup.screenshot({ path: process.env.GITSPACE_BROWSER_RELAY_SCREENSHOT });
  }
  assert.equal(await worker.evaluate(async () => (await globalThis.eval('stored')('identity')).privateKey.extractable), false, 'pairing private key must not be exportable');
  const signal = new AbortController().signal;
  const groupId = crypto.randomUUID();
  const grant = await signRuntimeBrowserGrant({ projectId: 'project', workspaceId: 'workspace', conversationId: 'conversation', machineId: 'machine', attachmentId: 'attachment', generation: 1, groupId, groupName: 'Relay smoke workspace', source: 'relay', origins: ['127.0.0.1'], expiresAt: new Date(Date.now() + 500_000).toISOString() }, workspaceKeys.privateKey, authority);
  const url = `http://127.0.0.1:${site.port}/approved`;
  // Host authority intentionally ignores ports; localhost is a different, denied host.
  const sameHostUrl = `http://127.0.0.1:${other.port}/same-host`;
  const deniedHostUrl = `http://localhost:${other.port}/denied-host`;
  const unapproved = await context.newPage(); await unapproved.goto(`http://127.0.0.1:${site.port}/unapproved`);
  const cdp = await context.newCDPSession(unapproved);
  const { targetInfo } = await cdp.send('Target.getTargetInfo'); await cdp.detach();
  const deniedId = targetInfo.targetId;
  const bind = async (args: RuntimeBrowserArguments) => {
    await relay.authorize(await signed({ type: 'execute', args, grant }), signal);
    return relay.open(grant, args, signal);
  };
  const list = async () => {
    await relay.authorize(await signed({ type: 'execute', args: { action: 'tabs', source: 'relay' }, grant }), signal);
    return relay.tabs(groupId, signal);
  };
  await assert.rejects(relay.tabs(groupId, signal), 'discovery requires a signed group operation');
  assert.deepEqual(await list(), [], 'unbound workspace cannot discover unrelated tabs');
  const openArgs = { action: 'open', source: 'relay', url } satisfies RuntimeBrowserArguments;
  const count = context.pages().length;
  await relay.authorize(await signed({ type: 'prepare', args: openArgs, groupId }), signal);
  await relay.prepare(openArgs, groupId, signal);
  assert.equal(context.pages().length, count, 'preparation must not create tabs');
  const openAuthorization = await signed({ type: 'execute', args: openArgs, grant });
  await assert.rejects(relay.authorize({ ...openAuthorization, signature: 'AA==' }, signal));
  const mismatched = await signRuntimeBrowserAuthorization({ ...openAuthorization.body, scope: { ...openAuthorization.body.scope, workspaceId: 'other-workspace' } }, workspaceKeys.privateKey, authority);
  await assert.rejects(relay.authorize(mismatched, signal));
  await assert.rejects(relay.authorize(await signed({ type: 'execute', args: openArgs, grant: { ...grant, body: { ...grant.body, origins: ['*'] } } }), signal), 'dispatch signature cannot widen the signed reusable grant');
  assert.equal(context.pages().length, count, 'invalid authorizations must not create tabs');
  await relay.authorize(openAuthorization, signal);
  await assert.rejects(relay.authorize(openAuthorization, signal), 'dispatch replay must fail');
  const createdPage = context.waitForEvent('page');
  const openDispatch = new AbortController();
  let channel = await relay.open(grant, openArgs, openDispatch.signal);
  const approved = await createdPage; await approved.waitForURL(url);
  const targetId = channel.targetId;
  openDispatch.abort(new Error('Open dispatch completed'));
  await channel.send('Page.enable');
  await assert.rejects(relay.open(grant, openArgs, signal), 'one open dispatch cannot create two tabs');
  assert.equal(context.pages().length, count + 1);
  // Read Chrome's real group UI metadata, not a test-side group imitation.
  const group = z.object({ id: z.number(), title: z.string(), color: z.string() }).parse(await worker.evaluate(`(async () => { const target = await targetInfo(${JSON.stringify(targetId)}); const tab = await chrome.tabs.get(target.tabId); return chrome.tabGroups.get(tab.groupId); })()`));
  assert.equal(group.title, grant.body.groupName);
  assert.equal(group.color, 'blue');
  assert.deepEqual((await list()).map(tab => ({ targetId: tab.targetId, url: tab.url })), [{ targetId, url }]);
  await assert.rejects(relay.tabs(groupId, signal), 'listing authorization is one-shot');
  await assert.rejects(bind({ action: 'open', source: 'relay', targetId: deniedId }), 'ungrouped tabs cannot be adopted by target ID');
  channel = await bind({ action: 'observe', source: 'relay', targetId, screenshot: false, offset: 0, limit: 100 });
  await assert.rejects(channel.send('Target.attachToTarget', { targetId: deniedId }));
  await assert.rejects(channel.send('Target.getTargets'));
  await assert.rejects(channel.send('Runtime.callFunctionOn', { functionDeclaration: 'function(){return document.cookie}' }));
  await assert.rejects(channel.send('Page.enable', {}, 'foreign-session'));
  // Bypass the supervisor to prove that the installed extension independently fences sessions.
  assert.equal(await worker.evaluate(`(async () => { try { await execute({operation:'command',targetId:${JSON.stringify(targetId)},method:'Page.enable',sessionId:'foreign-session'}); return false; } catch { return true; } })()`), true);
  const tree = z.object({ gitspaceDocument: z.number(), nodes: z.array(z.object({ role: z.object({ value: z.string() }).optional(), backendDOMNodeId: z.number().optional() })) }).parse(await channel.send('Accessibility.getFullAXTree', { depth: 32 }));
  const backendNodeId = tree.nodes.find(node => node.role?.value === 'textbox')?.backendDOMNodeId;
  assert.ok(backendNodeId, 'fixture textbox must have an observed reference');
  channel = await bind({ action: 'act', source: 'relay', targetId, ref: `${tree.gitspaceDocument}:${backendNodeId}`, operation: 'fill', value: 'approved value' });
  await channel.send('DOM.focus', { backendNodeId });
  await channel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, commands: ['selectAll'] });
  await channel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  await assert.rejects(channel.send('Input.insertText', { text: 'substituted value' }));
  await channel.send('Input.insertText', { text: 'approved value' });
  assert.equal(await approved.locator('input').inputValue(), 'approved value');
  const expression = 'document.title';
  channel = await bind({ action: 'evaluate', source: 'relay', targetId, expression });
  await assert.rejects(channel.send('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true, awaitPromise: true }));
  assert.equal(z.object({ result: z.object({ value: z.string() }) }).parse(await channel.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value, '/approved');
  await assert.rejects(channel.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), 'effects are one-shot, unlike the reusable group grant');
  channel = await bind({ action: 'screenshot', source: 'relay', targetId });
  const viewport = z.object({ width: z.number().positive(), height: z.number().positive() }).parse(await channel.send('GitSpace.screenshotPrepare', { refs: [] }));
  try {
    const shot = z.object({ data: z.string() }).parse(await channel.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: Math.min(1, 1280 / viewport.width, 1280 / viewport.height) } }));
    assert.equal(Buffer.from(shot.data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff', 'group authority includes a real JPEG screenshot');
  } finally { await channel.send('GitSpace.screenshotRestore'); }
  const delayedUrl = `http://127.0.0.1:${site.port}/delayed-load`;
  channel = await bind({ action: 'navigate', source: 'relay', targetId, url: delayedUrl });
  let navigationSettled = false;
  const delayedNavigation = channel.send('Page.navigate', { url: delayedUrl }).then(result => { navigationSettled = true; return result; });
  try {
    await delayedResourceRequested.promise;
    await approved.locator('iframe').evaluate(async frame => { if (frame instanceof HTMLIFrameElement && frame.contentDocument?.readyState !== 'complete') await new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true })); });
    await worker.evaluate(() => globalThis.eval('channels.size'));
    assert.equal(navigationSettled, false, 'navigation must not resolve before the main document load, even after an iframe load');
  } finally { releaseDelayedResource.resolve(); }
  assert.equal(z.object({ loaded: z.boolean() }).parse(await delayedNavigation).loaded, true);
  assert.equal(await approved.evaluate(() => document.readyState), 'complete');
  const sameDocumentUrl = `${delayedUrl}#same document`;
  channel = await bind({ action: 'navigate', source: 'relay', targetId, url: sameDocumentUrl });
  assert.equal(z.object({ loaded: z.boolean() }).parse(await channel.send('Page.navigate', { url: sameDocumentUrl })).loaded, true);
  assert.equal(approved.url(), new URL(sameDocumentUrl).href);
  const slowUrl = `http://127.0.0.1:${site.port}/slow-load`;
  channel = await bind({ action: 'navigate', source: 'relay', targetId, url: slowUrl });
  const slowNavigation = channel.send('Page.navigate', { url: slowUrl });
  try {
    await slowResourceRequested.promise;
    assert.equal(z.object({ loaded: z.boolean() }).parse(await slowNavigation).loaded, false);
    assert.notEqual(await approved.evaluate(() => document.readyState), 'complete');
  } finally { releaseSlowResource.resolve(); }
  await approved.waitForLoadState('load');
  const slowDocumentUrl = `http://127.0.0.1:${site.port}/slow-document`;
  channel = await bind({ action: 'navigate', source: 'relay', targetId, url: slowDocumentUrl });
  let slowDocumentSettled = false;
  const slowDocumentNavigation = channel.send('Page.navigate', { url: slowDocumentUrl }).then(result => { slowDocumentSettled = true; return result; });
  void slowDocumentNavigation.catch(() => {});
  try {
    await slowDocumentRequested.promise;
    await Bun.sleep(11_000);
    assert.equal(slowDocumentSettled, false, 'waiting for document headers must not consume the post-commit load budget');
    assert.equal(approved.url(), slowUrl, 'the approved old page is not proof of navigation');
    releaseSlowDocument.resolve();
    await slowDocumentResourceRequested.promise;
    assert.equal(approved.url(), slowDocumentUrl);
    assert.equal(z.object({ frameId: z.string(), loaded: z.boolean() }).parse(await slowDocumentNavigation).loaded, false);
    assert.notEqual(await approved.evaluate(() => document.readyState), 'complete');
  } finally { releaseSlowDocument.resolve(); releaseSlowDocumentResource.resolve(); }
  await approved.waitForURL(slowDocumentUrl);
  await approved.waitForLoadState('load');
  const redirectUrl = `http://127.0.0.1:${site.port}/redirect-foreign`;
  channel = await bind({ action: 'navigate', source: 'relay', targetId, url: redirectUrl });
  await assert.rejects(channel.send('Page.navigate', { url: redirectUrl }), 'foreign redirect cannot resolve as an authorized navigation');
  await approved.goto(url);
  await assert.rejects(bind({ action: 'navigate', source: 'relay', targetId, url: deniedHostUrl }), 'different hostname is denied before navigation');
  channel = await bind({ action: 'navigate', source: 'relay', targetId, url: sameHostUrl });
  await assert.rejects(channel.send('Page.navigate', { url: `http://127.0.0.1:${other.port}/substituted` }));
  await channel.send('Page.navigate', { url: sameHostUrl }); await approved.waitForURL(sameHostUrl);
  await approved.goto(deniedHostUrl);
  assert.deepEqual(await list(), [], 'grouped but disallowed hosts are invisible');
  await assert.rejects(bind({ action: 'evaluate', source: 'relay', targetId, expression }), 'manual navigation cannot bypass host authority');
  await assert.rejects(channel.send('Page.enable'), 'existing channel cannot bypass manual host changes');
  await approved.goto(url);
  // chrome.tabs.group/ungroup are the native equivalent of dragging a tab into/out of the strip.
  await worker.evaluate(`(async () => { const target = await targetInfo(${JSON.stringify(deniedId)}); await chrome.tabs.group({groupId:${group.id},tabIds:[target.tabId]}); })()`);
  assert.deepEqual(new Set((await list()).map(tab => tab.targetId)), new Set([targetId, deniedId]));
  const dragged = await bind({ action: 'evaluate', source: 'relay', targetId: deniedId, expression });
  assert.equal(z.object({ result: z.object({ value: z.string() }) }).parse(await dragged.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value, '/unapproved');
  await worker.evaluate(`(async () => { const target = await targetInfo(${JSON.stringify(deniedId)}); await chrome.tabs.ungroup(target.tabId); })()`);
  assert.deepEqual((await list()).map(tab => tab.targetId), [targetId]);
  await assert.rejects(dragged.send('Page.enable'), 'dragging out immediately removes existing channel authority');
  await assert.rejects(bind({ action: 'open', source: 'relay', targetId: deniedId }));
  const secondAuthority = await signRuntimeBrowserAuthorityCertificate({ ...authority.body, workspaceId: 'second-workspace' }, accountKeys.privateKey);
  const secondGrant = await signRuntimeBrowserGrant({ ...grant.body, workspaceId: 'second-workspace', groupId: crypto.randomUUID(), groupName: 'Second smoke workspace' }, workspaceKeys.privateKey, secondAuthority);
  await relay.authorize(await signed({ type: 'execute', args: openArgs, grant: secondGrant }, 'second-workspace', secondAuthority), signal);
  const secondChannel = await relay.open(secondGrant, openArgs, signal);
  await worker.evaluate(`(async () => { const destination = await targetInfo(${JSON.stringify(secondChannel.targetId)}); const group = (await chrome.tabs.get(destination.tabId)).groupId; const dragged = await targetInfo(${JSON.stringify(deniedId)}); await chrome.tabs.group({groupId:group,tabIds:[dragged.tabId]}); })()`);
  const secondArgs = { action: 'evaluate', source: 'relay', targetId: deniedId, expression } satisfies RuntimeBrowserArguments;
  await relay.authorize(await signed({ type: 'execute', args: secondArgs, grant: secondGrant }, 'second-workspace', secondAuthority), signal);
  const transferred = await relay.open(secondGrant, secondArgs, signal);
  assert.equal(z.object({ result: z.object({ value: z.string() }) }).parse(await transferred.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value, '/unapproved', 'new workspace acquires released debugger ownership');
  await assert.rejects(dragged.send('Page.enable'), 'old workspace channel remains fenced after transfer');
  await relay.revoke(secondGrant.body.groupId);
  await assert.rejects(transferred.send('Page.enable'), 'human revocation fences the former group channel');
  const renewedGrant = await signRuntimeBrowserGrant({ ...secondGrant.body, groupId: crypto.randomUUID() }, workspaceKeys.privateKey, secondAuthority);
  await relay.authorize(await signed({ type: 'execute', args: openArgs, grant: renewedGrant }, 'second-workspace', secondAuthority), signal);
  const renewedChannel = await relay.open(renewedGrant, openArgs, signal);
  assert.notEqual(renewedChannel.targetId, secondChannel.targetId, 'a renewed workspace grant creates a fresh native group');
  await relay.authorize(await signed({ type: 'execute', args: secondArgs, grant: secondGrant }, 'second-workspace', secondAuthority), signal);
  await assert.rejects(relay.open(secondGrant, secondArgs, signal), 'late signed old grants cannot resurrect a retired group');
  // Transport restart detaches channels, but does not rename/recreate a user's existing group.
  const replayAuthorization = await signed({ type: 'execute', args: { action: 'tabs', source: 'relay' }, grant });
  await relay.authorize(replayAuthorization, signal); await relay.tabs(groupId, signal);
  await relay.stop(); await relay.start();
  await pollUntilReady(async () => (await relay.status()).connected, { timeoutMs: 10_000, message: 'group reconnect timed out' });
  assert.equal((await relay.status()).pairedKeyFingerprint, initialFingerprint);
  assert.deepEqual((await list()).map(tab => tab.targetId), [targetId], 'durable group survives reconnect');
  assert.equal(await worker.evaluate(`(async () => (await chrome.tabGroups.get(${group.id})).title)()`), grant.body.groupName);
  channel = await bind({ action: 'evaluate', source: 'relay', targetId, expression });
  assert.equal(z.object({ result: z.object({ value: z.string() }) }).parse(await channel.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value, '/approved');
  // Removing the last member deletes the Chrome group; old target IDs must not retain authority.
  await worker.evaluate(`(async () => { const target = await targetInfo(${JSON.stringify(targetId)}); await chrome.tabs.ungroup(target.tabId); })()`);
  assert.deepEqual(await list(), []);
  await assert.rejects(channel.send('Page.enable'));
  await assert.rejects(bind({ action: 'open', source: 'relay', targetId }));
  const replacementPage = context.waitForEvent('page');
  const replacement = await bind(openArgs);
  await (await replacementPage).waitForURL(url);
  assert.notEqual(replacement.targetId, targetId);
  assert.deepEqual((await list()).map(tab => tab.targetId), [replacement.targetId], 'a fresh open recreates only the workspace group, not authority over former members');
  // Browser restart retains identity/replay fences, not stale Chrome group IDs across browser epochs.
  await relay.stop(); await relay.start();
  await context.close();
  context = await chromium.launchPersistentContext(join(root, 'private-chrome-profile'), { executablePath: process.env.CHROME_PATH, headless: true, args: [`--disable-extensions-except=${relay.extensionPath}`, `--load-extension=${relay.extensionPath}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await pollUntilReady(async () => (await relay.status()).connected, { timeoutMs: 10_000, message: 'paired extension did not reconnect' });
  assert.equal((await relay.status()).pairingCode, null);
  assert.ok(Date.parse(replayAuthorization.body.expiresAt) > Date.now(), 'replay fixture must remain valid across restart');
  await assert.rejects(relay.authorize(replayAuthorization, signal), 'replay remains rejected after worker restart');
  assert.equal((await relay.status()).pairedKeyFingerprint, initialFingerprint, 'browser restart preserves the pinned identity');
  assert.deepEqual(await list(), [], 'new browser epoch must not adopt stale Chrome group IDs');
  const restartedPage = context.waitForEvent('page');
  const resetChannel = await bind(openArgs);
  await (await restartedPage).waitForURL(url);
  assert.deepEqual((await list()).map(tab => tab.targetId), [resetChannel.targetId]);
  await bind({ action: 'observe', source: 'relay', targetId: resetChannel.targetId, screenshot: false, offset: 0, limit: 100 });
  await resetChannel.send('Page.enable');
  const previousFingerprint = (await relay.status()).pairedKeyFingerprint;
  const resetPopup = await context.newPage(); await resetPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await resetPopup.locator('#fingerprint').filter({ hasText: previousFingerprint! }).waitFor();
  assert.equal(await resetPopup.locator('#fingerprint').textContent(), previousFingerprint, 'popup startup reads durable worker identity');
  await resetPopup.getByRole('button', { name: 'Reset identity', exact: true }).click();
  await resetPopup.getByRole('status').filter({ hasText: 'Identity reset.' }).waitFor();
  assert.equal(await worker.evaluate(async () => await globalThis.eval('stored')('identity')), undefined, 'reset deletes durable private/public key and trust');
  assert.equal(await resetPopup.locator('#fingerprint').textContent(), 'No identity. Pair to generate a key.');
  assert.equal(await worker.evaluate(() => globalThis.eval('channels.size')), 0, 'reset detaches active target channels');
  await assert.rejects(resetChannel.send('Page.enable'), 'identity reset removes active channel authority');
  const unpaired = await relay.unpair();
  assert.equal(unpaired.pairedKeyFingerprint, null);
  await resetPopup.locator('#code').fill(JSON.stringify({ machineId: 'machine', code: unpaired.pairingCode, trust }));
  await resetPopup.locator('#pair button').click();
  await pollUntilReady(async () => (await relay.status()).connected, { timeoutMs: 10_000, message: 'reset identity did not pair again' });
  assert.notEqual((await relay.status()).pairedKeyFingerprint, previousFingerprint, 're-pair generates a new identity');
  const regeneratedFingerprint = (await relay.status()).pairedKeyFingerprint;
  await resetPopup.locator('#fingerprint').filter({ hasText: regeneratedFingerprint! }).waitFor();
  assert.equal(await resetPopup.locator('#fingerprint').textContent(), regeneratedFingerprint);
  assert.ok(Date.parse(replayAuthorization.body.expiresAt) > Date.now(), 'reset replay fixture must remain live');
  await assert.rejects(relay.authorize(replayAuthorization, signal), 'reset identity must preserve consumed authorization replay fences');
  // A clean profile models reinstall: no extension identity survives, even while native still pins the old key.
  await context.close();
  context = await chromium.launchPersistentContext(join(root, 'reinstalled-chrome-profile'), { executablePath: process.env.CHROME_PATH, headless: true, args: [`--disable-extensions-except=${relay.extensionPath}`, `--load-extension=${relay.extensionPath}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const reinstalledPopup = await context.newPage(); await reinstalledPopup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await reinstalledPopup.locator('#fingerprint').filter({ hasText: 'No identity.' }).waitFor();
  assert.equal((await relay.status()).pairedKeyFingerprint, regeneratedFingerprint);
  const reinstallPairing = await relay.unpair();
  await reinstalledPopup.locator('#code').fill(JSON.stringify({ machineId: 'machine', code: reinstallPairing.pairingCode, trust }));
  await reinstalledPopup.locator('#pair button').click();
  await pollUntilReady(async () => (await relay.status()).connected, { timeoutMs: 10_000, message: 'reinstalled identity did not pair' });
  const reinstalledFingerprint = (await relay.status()).pairedKeyFingerprint;
  assert.notEqual(reinstalledFingerprint, regeneratedFingerprint);
  await reinstalledPopup.locator('#fingerprint').filter({ hasText: reinstalledFingerprint! }).waitFor();
  assert.equal(await reinstalledPopup.locator('#fingerprint').textContent(), reinstalledFingerprint);
  // A process binding the stopped relay port can acknowledge transport, but cannot mint effects.
  await relay.stop();
  const rejected = Promise.withResolvers<void>();
  const observedFrames: string[] = [];
  const impostor = Bun.serve<{ sent: boolean }>({
    hostname: '127.0.0.1', port,
    fetch: (request, server) => {
      assert.equal(new URL(request.url).search, '', 'pairing secret must never appear in the URL');
      return server.upgrade(request, { data: { sent: false } }) ? undefined : new Response('Upgrade required', { status: 400 });
    },
    websocket: {
      open: socket => { socket.send(JSON.stringify({ pairing: 'challenge', serverNonce: 'e'.repeat(64) })); },
      message: (socket, raw) => {
        observedFrames.push(String(raw));
        const message = JSON.parse(String(raw));
        if (message.id === 999) { assert.ok(message.error, 'unsigned open must fail'); rejected.resolve(); return; }
        if (message.pairing !== 'client') return;
        socket.data.sent = true;
        socket.send(JSON.stringify({ pairing: 'server' }));
        socket.send(JSON.stringify({ id: 999, operation: 'open', grant }));
      },
      close: () => {},
    },
  });
  const deadline = Promise.withResolvers<never>();
  const deadlineTimer = setTimeout(() => deadline.reject(new Error('Impostor effect was not rejected')), 10000);
  try {
    await worker.evaluate(() => globalThis.eval('connect()'));
    await Promise.race([rejected.promise, deadline.promise]);
    assert.ok(observedFrames.every(frame => !frame.includes(status.pairingCode!)), 'ephemeral code must not be reused on reconnect');
    assert.equal(await worker.evaluate(() => globalThis.eval('channels.size')), 0, 'untrusted server must not attach any target');
  } finally { clearTimeout(deadlineTimer); await impostor.stop(true); }
  console.log('PASS: private extension pairing/reset/reinstall; signed reusable named group; drag membership, host authority, JS/screenshots, exact effects/session/replay fencing, reconnect/deletion; impostor effects rejected');
} finally { await context?.close(); await relay.stop(); await site.stop(true); await other.stop(true); await rm(root, { recursive: true, force: true }); }
