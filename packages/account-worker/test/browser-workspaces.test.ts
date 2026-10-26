import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { browserBase64, signRuntimeAccountBrowserAuthorization, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate } from '@gitspace/protocol-runtime';
import { browserSignedText } from '../src/browser-upload.js';
import type { UserRelayDO } from '../src/index.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';

type Identity = { key: CryptoKeyPair; publicKey: string };
const MessageSchema = z.object({ id: z.number().optional(), operation: z.string().optional() }).catchall(z.unknown());
type Message = z.infer<typeof MessageSchema>;
/** A paired Chrome's extension: what its hello was answered with, and every message the relay sent it. */
type Chrome = { identity: Identity; pairingId: string; generation: number; ready: unknown; received: Message[] };
const Reply = z.object({ status: z.string(), value: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const Workspaces = z.object({ workspaces: z.array(z.object({ projectId: z.string(), project: z.string(), workspaceId: z.string(), name: z.string(), approved: z.boolean() })) });
const encoder = new TextEncoder();
afterEach(() => { vi.restoreAllMocks(); });

async function keys(): Promise<Identity> { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket) { return new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })); }
function hex(bytes: ArrayBuffer | Uint8Array) { return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

/** Minutes after noon on 1 October 2026 that the next workspace changed. */
let changed = 0;
/** A project of the account with these workspaces, as the account's directory lists them: each changed a minute after
 * the one made before it, `archived` ones archived. */
async function project(name: string, workspaces: string[], archived: string[] = []) {
  const projectId = crypto.randomUUID(), authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`), index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
  const summary = await authority.setProjectLifecycle((await authority.bootstrap({ id: projectId, name, repositoryReference: null, baseBranch: 'main', createdBy: 'user' })).revision, 'active');
  await index.put(summary);
  const definitions = [];
  for (const [n, workspace] of [...workspaces, ...archived].entries()) {
    const definition = await authority.putWorkspace({ id: crypto.randomUUID(), projectId, kind: 'worktree', name: workspace, branch: `branch-${n}`, phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    const lifecycle: 'archived' | 'active' = archived.includes(workspace) ? 'archived' : 'active';
    definitions.push({ ...definition, lifecycle, updatedAt: new Date(Date.UTC(2026, 9, 1, 12, changed++)).toISOString() });
  }
  await index.publishDirectory({ source: 'project', cursor: 1_000_000, project: summary, workspaces: definitions });
  return { projectId, id: (workspace: string) => definitions.find(definition => definition.name === workspace)?.id ?? '' };
}

/** A paired, confirmed Chrome whose extension says `hello` (an extension from 5.12 says `addTab`); it answers the
 * relay's commands with `answer`. */
async function chrome(relay: UserRelayDO, root: Identity, ip: string, hello: object, answer: (message: Message) => unknown): Promise<Chrome> {
  const redeemed = await relay.browserRelayRedeemPairingCode((await relay.browserRelayPair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey })).code, '198.51.100.1', 'wss://account.test/api/browser-relay/extension');
  if (!redeemed.ok) throw new Error(redeemed.message);
  const pairing = redeemed.value;
  const socket = (await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': ip } }))).webSocket;
  if (!socket) throw new Error('Missing extension socket');
  const challenge = frame(socket); socket.accept();
  const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge), identity = await keys(), clientNonce = 'b'.repeat(64);
  const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, encoder.encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
  const paired = frame(socket); socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code })); await paired;
  const readied = frame(socket); socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/141.0.0.0', protocol: 6, ...hello })); const ready = await readied;
  const received: Message[] = [];
  socket.addEventListener('message', event => {
    const message = MessageSchema.parse(JSON.parse(String(event.data)));
    received.push(message);
    if (typeof message.id !== 'number') return;
    const { id } = message;
    void Promise.resolve().then(() => message.operation === 'tabs' ? [] : answer(message)).then(result => socket.send(JSON.stringify({ id, result: result ?? {} })), (error: unknown) => socket.send(JSON.stringify({ id, error: { message: error instanceof Error ? error.message : String(error) } })));
  });
  const status = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === pairing.pairingId);
  if (!status || status.state !== 'pending-confirmation') throw new Error('Missing pending identity');
  await relay.browserRelayConfirm(pairing.pairingId, status.pairedKeyFingerprint);
  return { identity, pairingId: pairing.pairingId, generation: pairing.generation, ready, received };
}
async function approve(relay: UserRelayDO, projectId: string, browser: Chrome) {
  const settings = await relay.browserRelayProjectSettings(projectId);
  await relay.browserRelaySetProjectSettings(projectId, settings.revision, { defaultPairingId: browser.pairingId, approvals: [{ pairingId: browser.pairingId }] });
}
/** A workspace request the Chrome's popup signs with its pairing key (`label` workspace unless said otherwise). */
async function signed(browser: Chrome, body: object, label: 'workspace' | 'share' = 'workspace') {
  const path = '/api/browser-relay/workspaces', bytes = encoder.encode(JSON.stringify(body));
  const issuedAt = Date.now(), nonce = hex(crypto.getRandomValues(new Uint8Array(32))), bodySha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const signature = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', browser.identity.key.privateKey, encoder.encode(browserSignedText(label, { pairingId: browser.pairingId, generation: browser.generation, method: 'POST', pathname: path, bodySha256, issuedAt, nonce })))));
  const header = btoa(JSON.stringify({ pairingId: browser.pairingId, generation: browser.generation, issuedAt, nonce, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const response = await exports.default.fetch(new Request(`https://test.gitspace.sh${path}`, { method: 'POST', headers: { 'x-gitspace-browser-upload': header }, body: bytes }));
  return { ...Reply.parse(await response.json()), status: response.status };
}
/** Each workspace asked for its group on a Chrome makes or renews it as a step of its own on that Chrome (the workspace's
 * `tabs`), signed under `root`: one group per workspace and Chrome. Answers what it was asked, in order. */
function workspacesMakeGroups(root: Identity) {
  const asked: Array<{ projectId: string; workspaceId: string; pairingId: string }> = [], groups = new Map<string, string>();
  vi.spyOn(SpaceAuthorityDO.prototype, 'browserTabGroup').mockImplementation(async (raw, pairingId) => {
    const { projectId, workspaceId } = z.object({ projectId: z.string(), workspaceId: z.string() }).parse(raw);
    asked.push({ projectId, workspaceId, pairingId });
    const relay = env.RELAY.getByName(env.RELAY_NAME), placement = await relay.browserRelayPlacement(projectId, pairingId);
    const groupId = groups.get(`${workspaceId}:${pairingId}`) ?? crypto.randomUUID();
    groups.set(`${workspaceId}:${pairingId}`, groupId);
    const signer = await keys(), expiresAt = new Date(Date.now() + 60_000).toISOString(), issuedAt = new Date().toISOString(), attemptId = crypto.randomUUID();
    const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId, workspaceId, publicKey: signer.publicKey, issuedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, root.key.privateKey);
    const grant = await signRuntimeAccountBrowserGrant({ projectId, workspaceId, placement, groupId, groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, signer.key.privateKey, authority);
    const step = await signRuntimeAccountBrowserAuthorization({ scope: { projectId, workspaceId, placement, conversationId: 'conversation', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'tabs', source: 'relay', pairingId }, grant } }, signer.key.privateKey, authority);
    if ((await relay.browserRelayExecute(step)).status !== 'completed') throw new Error('The workspace’s step failed');
    return groupId;
  });
  return asked;
}

test('your Chrome’s popup lists the account’s active workspaces: those of projects that approved this Chrome first, the one whose group here was used last first, then the most recently changed; the others after, saying so', async () => {
  const shop = await project('Shop', ['Checkout', 'Returns'], ['Old sale']);
  const tone = await project('ToneTempo', ['Coach subscriptions', 'Challenges and streaks']);
  const core = await project('inkibra core', ['Workflow schedules']);
  const ours = new Set([shop.projectId, tone.projectId, core.projectId]);
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, '192.0.2.71', { addTab: true }, () => ({ url: 'https://news.example/', title: 'News' }));
    expect(browser.ready).toMatchObject({ ready: true, addTab: true });
    await approve(relay, shop.projectId, browser);
    await approve(relay, tone.projectId, browser);
    workspacesMakeGroups(root);
    const list = async () => Workspaces.parse((await signed(browser, { op: 'list' })).value).workspaces.filter(item => ours.has(item.projectId)).map(item => `${item.project} / ${item.name}${item.approved ? '' : ' (not approved)'}`);
    expect(await list()).toEqual(['ToneTempo / Challenges and streaks', 'ToneTempo / Coach subscriptions', 'Shop / Returns', 'Shop / Checkout', 'inkibra core / Workflow schedules (not approved)']);
    // Checkout's group here is used: it comes first.
    expect(await signed(browser, { op: 'add', projectId: shop.projectId, workspaceId: shop.id('Checkout'), targetId: 'your-tab' })).toMatchObject({ status: 200 });
    expect((await list())[0]).toBe('Shop / Checkout');
    expect(await signed(browser, { op: 'list' }, 'share')).toMatchObject({ status: 401, error: { code: 'WORKSPACE_SIGNATURE_INVALID' } });
  });
});

test('adding a tab: the workspace makes or renews its group on this Chrome and the tab joins it as if you dragged it in; refused for a project that has not approved this Chrome or a workspace that is not active', async () => {
  const shop = await project('Shop', ['Checkout'], ['Old sale']);
  const core = await project('inkibra core', ['Workflow schedules']);
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, '192.0.2.72', { addTab: true }, message => {
      if (message.operation !== 'adoptTab') return {};
      if (message.targetId === 'tab-in-another-group') throw new Error("This tab is in another workspace's group; drag it out first");
      return { url: 'https://news.example/', title: 'News' };
    });
    await approve(relay, shop.projectId, browser);
    const asked = workspacesMakeGroups(root);
    const adopted = () => browser.received.filter(message => message.operation === 'adoptTab').map(({ groupId, targetId }) => ({ groupId, targetId }));

    expect(await signed(browser, { op: 'add', projectId: core.projectId, workspaceId: core.id('Workflow schedules'), targetId: 'your-tab' })).toMatchObject({ status: 403, error: { code: 'WORKSPACE_CHROME_UNAPPROVED', message: 'This Chrome isn\'t approved in inkibra core: approve it in GitSpace, Plugins → Browsers → Manage Chrome' } });
    expect(await signed(browser, { op: 'add', projectId: shop.projectId, workspaceId: shop.id('Old sale'), targetId: 'your-tab' })).toMatchObject({ status: 404, error: { code: 'WORKSPACE_UNKNOWN' } });
    expect(await signed(browser, { op: 'add', projectId: core.projectId, workspaceId: shop.id('Checkout'), targetId: 'your-tab' })).toMatchObject({ status: 404, error: { code: 'WORKSPACE_UNKNOWN' } });
    expect(asked).toEqual([]);
    expect(adopted()).toEqual([]);

    // The first tab makes Checkout's group on this Chrome, its step signed by the workspace; the next renews it.
    const first = await signed(browser, { op: 'add', projectId: shop.projectId, workspaceId: shop.id('Checkout'), targetId: 'your-tab' });
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(first.value);
    expect(browser.received.filter(message => message.operation === 'authorize' || message.operation === 'tabs' || message.operation === 'adoptTab').map(message => message.operation)).toEqual(['authorize', 'tabs', 'adoptTab']);
    expect(await signed(browser, { op: 'add', projectId: shop.projectId, workspaceId: shop.id('Checkout'), targetId: 'next-tab' })).toEqual({ status: 200, value: { groupId } });
    expect(asked).toEqual([{ projectId: shop.projectId, workspaceId: shop.id('Checkout'), pairingId: browser.pairingId }, { projectId: shop.projectId, workspaceId: shop.id('Checkout'), pairingId: browser.pairingId }]);
    expect(adopted()).toEqual([{ groupId, targetId: 'your-tab' }, { groupId, targetId: 'next-tab' }]);
    // The Chrome's refusal comes back as it said it.
    expect(await signed(browser, { op: 'add', projectId: shop.projectId, workspaceId: shop.id('Checkout'), targetId: 'tab-in-another-group' })).toMatchObject({ status: 409, error: { code: 'WORKSPACE_ADD_REFUSED', message: "This tab is in another workspace's group; drag it out first" } });
  });
});

test('an extension before 5.12 adds no tab to a workspace and lists none: it is asked to update, and nothing reaches the workspace', async () => {
  const shop = await project('Shop', ['Checkout']);
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const root = await keys();
    const browser = await chrome(relay, root, '192.0.2.73', {}, () => ({ url: 'https://news.example/', title: 'News' }));
    await approve(relay, shop.projectId, browser);
    const asked = workspacesMakeGroups(root);
    const update = { status: 409, error: { code: 'WORKSPACE_UPDATE_REQUIRED', message: 'Update the GitSpace extension in this Chrome to 5.12 or later to add tabs to workspaces' } };
    expect(await signed(browser, { op: 'list' })).toMatchObject(update);
    expect(await signed(browser, { op: 'add', projectId: shop.projectId, workspaceId: shop.id('Checkout'), targetId: 'your-tab' })).toMatchObject(update);
    expect(asked).toEqual([]);
    expect(browser.received.filter(message => message.operation === 'authorize' || message.operation === 'adoptTab')).toEqual([]);
  });
});
