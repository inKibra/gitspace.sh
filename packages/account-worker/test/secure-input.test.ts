import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest, STEP_UP_HEADER } from '@gitspace/protocol';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { browserBase64, RuntimeAskSecureInputArgumentsSchema, SECURE_INPUT_API_PATH, SECURE_INPUT_ID, signRuntimeAccountBrowserAuthorization, signRuntimeBrowserAuthorityCertificate, type RuntimeBrowserHolder, type RuntimeProjectBrowserSettings, type RuntimeSecureInputQuestion } from '@gitspace/protocol-runtime';
import type { BrowserChannel } from '../src/browser-cdp.js';
import { CdpBrowserShim } from '../src/browser-shim.js';
import { BrowserSessionDO } from '../src/browser-session.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { BROWSER_GROUP_ROWS, createRuntimeBrowserAuthority, type RuntimeBrowserAuthorityOptions } from '../src/runtime-browser.js';
import type { SecureInputRecord } from '../src/secure-input.js';
import { hostedBrowserRelay } from './fixtures/hosted-browser-relay.js';
import { browser, enrollPasskey, passkeyProof, type TestBrowser } from './fixtures/passkeys.js';
import { softwareAuthenticator } from '../../protocol/test/software-authenticator.js';
import type { CredentialVaultDO } from '../src/application.js';
import { tenantRootPrivateKey } from './setup.js';

afterEach(() => { vi.restoreAllMocks(); });

/** The value a person types: no answer, record, log, frame or command but the fill itself may carry it. */
const TYPED = 'hunter2-correct-horse-battery';
const pairingId = '00000000-0000-4000-8000-0000000000c1', groupId = '00000000-0000-4000-8000-0000000000c2', cloudGroupId = '00000000-0000-4000-8000-0000000000c3';
const unused = async (): Promise<never> => { throw new Error('Unexpected call'); };

// ── Asking: the request the account records for the agent's call ──

/** The browser authority ask_secure_input asks: one Chrome ("Studio desktop", `chrome`), the workspace's group there
 * with a GitHub sign-in tab, the cloud browser's tabs, GitHub approved, and the vault's records. */
async function asking(chrome: Partial<RuntimeProjectBrowserSettings['browsers'][number]> = {}) {
  const data = new Map<string, unknown>();
  const storage: RuntimeBrowserAuthorityOptions['storage'] = {
    async get(key) { return data.get(key); }, async put(key, value) { data.set(key, value); }, async delete(key) { return data.delete(key); },
    async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); },
    async transaction(change) { return change(storage); },
  };
  await storage.put(`${BROWSER_GROUP_ROWS}${groupId}`, { pairingId, browser: 'Studio desktop', groupId, groupName: 'Workspace', origins: ['github.com'], expiresAt: '2026-12-25T12:00:00.000Z', reportedAt: '2026-11-19T10:00:00.000Z',
    tabs: [{ targetId: 'sign-in', url: 'https://github.com/login', title: 'Sign in to GitHub', addedBy: 'agent', site: null, usable: true }, { targetId: 'gitlab', url: 'https://gitlab.com/users/sign_in', title: 'GitLab', addedBy: 'you', site: 'gitlab.com', usable: true }], held: [] });
  await storage.put('runtime.browser.account.group:cloud', cloudGroupId);
  const settings: RuntimeProjectBrowserSettings = { projectId: 'project', revision: 1, defaultPairingId: pairingId, browsers: [{ pairingId, generation: 1, name: 'Studio desktop', note: '', connected: true, approved: true, takeover: true, powers: [], powersSupported: true, secureInput: true, ...chrome }] };
  const recorded: Omit<SecureInputRecord, 'state'>[] = [];
  const held: RuntimeBrowserHolder[] = [];
  const authority = createRuntimeBrowserAuthority({ storage, identity: { projectId: 'project', workspaceId: 'workspace' }, selectExecution: unused, approvedSites: async () => ({ sites: [{ pattern: 'github.com', level: 'full' }], revision: null }), groupName: async () => 'Workspace', drive: () => { throw new Error('No drive'); }, fromMachine: unused, services: async () => [], comments: { ownerName: unused, announce: unused }, skillCommit: unused,
    env: {
      ACCOUNT_ID: 'account', ACCOUNT_URL: 'https://account.example', RELAY_NAME: 'relay',
      CREDENTIALS: { getByName: () => ({ secureInputRecord(record: Omit<SecureInputRecord, 'state'>) { recorded.push(record); } }) },
      ACCOUNT_STATE: { getByName: () => ({ certifyBrowserAuthority: unused }) },
      FLEET_CATALOG: { getByName: () => ({ getMachine: async () => null }) },
      RELAY: { getByName: () => ({ browserRelayPlacement: unused, browserRelayExecute: unused, browserRelayProjectSettings: async () => settings, browserCaptureShares: unused, browserCaptureShareCreate: unused, browserCaptureShareRevoke: unused, browserRelayPowers: unused, browserRelayEverything: unused }) },
      BROWSER_SESSION: { getByName: () => ({ execute: unused, preview: unused, closeTab: unused, captureStart: unused, captureStop: unused, holders: async () => held, takeOver: unused, resume: unused,
        async overview() { return { tabs: [{ targetId: 'login', url: 'https://accounts.example.com/login?next=1', title: 'Log in' }], running: 0, held }; } }) },
    },
    runtime: () => ({ harness: { snapshot: unused }, browserConversation: async () => ({ id: 'main', root: true, tools: null }), browserEvent: unused, attachments: { list: () => [], execute: unused } }) });
  const ask = (args: object) => authority.secureInput({ conversationId: 'main', questionId: 'question-1', callId: 'call-1', args: RuntimeAskSecureInputArgumentsSchema.parse({ kind: 'password', purpose: 'Sign in to GitHub as octocat', selector: '#password', ...args }) });
  return { ask, recorded };
}

test('a request names the tab and its origin, is recorded for its question with a random id, and links only that id', async () => {
  const f = await asking();
  const request = await f.ask({ source: 'relay', targetId: 'sign-in', origin: 'https://github.com' });
  expect(request).toMatchObject({ source: 'chrome', pairingId, browser: 'Chrome "Studio desktop"', groupId, targetId: 'sign-in', title: 'Sign in to GitHub', workspace: 'Workspace', origin: 'https://github.com', selector: '#password', kind: 'password', purpose: 'Sign in to GitHub as octocat', callId: 'call-1' });
  expect(request.requestId).toMatch(SECURE_INPUT_ID);
  expect(request.url).toBe(`https://account.example/secure-input/${request.requestId}`);
  expect(Date.parse(request.expiresAt) - Date.parse(request.askedAt)).toBe(15 * 60_000);
  expect(f.recorded).toEqual([{ id: request.requestId, projectId: 'project', workspaceId: 'workspace', conversationId: 'main', questionId: 'question-1', request }]);
  // Each request gets its own id.
  expect((await f.ask({ source: 'relay', targetId: 'sign-in', origin: 'https://github.com' })).requestId).not.toBe(request.requestId);
  // The cloud browser's tab, by the origin it shows now.
  expect(await f.ask({ source: 'headless', targetId: 'login', origin: 'https://accounts.example.com' })).toMatchObject({ source: 'cloud', pairingId: null, browser: 'Cloud browser', groupId: cloudGroupId, title: 'Log in' });
});

test('a tab elsewhere than the origin, a site the workspace has not approved, or an extension that cannot fill is refused before anything is recorded', async () => {
  const f = await asking();
  await expect(f.ask({ source: 'relay', targetId: 'sign-in', origin: 'https://github.com:8443' })).rejects.toThrow('Tab sign-in shows https://github.com, not https://github.com:8443');
  await expect(f.ask({ source: 'relay', targetId: 'gitlab', origin: 'https://gitlab.com' })).rejects.toThrow('gitlab.com is not an approved site of this workspace');
  await expect((await asking({ secureInput: false })).ask({ source: 'relay', targetId: 'sign-in', origin: 'https://github.com' })).rejects.toThrow('update the extension (5.14 or later)');
  await expect((await asking({ connected: false })).ask({ source: 'relay', targetId: 'sign-in', origin: 'https://github.com' })).rejects.toThrow('is offline');
  expect(f.recorded).toEqual([]);
});

// ── The page: a signed-in GitSpace browser answers a request once, after a passkey step-up ──

/** A browser device of this account, enrolled as GitSpace's sign-in does, and the account's passkey (enrolled from a
 * full-access browser). `post` signs the page's requests with the device and confirms opening and answering with the
 * passkey; `bare` sends them with only the step-up given. */
async function signedIn() {
  const signingPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)), label: 'Phone', boundAt: Date.now(), signingPrivateKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  const phone: TestBrowser = { deviceId: binding.deviceId, key: signingPrivateKey };
  const passkey = await softwareAuthenticator();
  expect((await enrollPasskey(await browser(), passkey)).status).toBe(200);
  return {
    vault, deviceId: binding.deviceId, phone, passkey,
    post: async (body: PageBody) => page(body, phone, body.op === 'decline' ? null : await passkeyProof(phone, passkey, { purpose: body.op === 'view' ? 'secure-input.open' : 'secure-input.answer', targets: [body.id] })),
    bare: (body: PageBody, stepUp: string | null) => page(body, phone, stepUp),
  };
}
type PageBody = Record<string, unknown> & { op: string; id: string };
/** One request from the secure-input page: its status and JSON answer, and the answer's text. */
async function page(body: object, signer: TestBrowser | null, stepUp: string | null = null) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const headers: Record<string, string> = { origin: new URL(env.ACCOUNT_URL).origin, 'content-type': 'application/json' };
  if (signer) headers['x-gitspace-device'] = signRpcRequest({ deviceId: signer.deviceId, signingPrivateKey: signer.key, method: 'POST', path: SECURE_INPUT_API_PATH, body: bytes });
  if (stepUp) headers[STEP_UP_HEADER] = stepUp;
  const response = await exports.default.fetch(new Request(new URL(SECURE_INPUT_API_PATH, env.ACCOUNT_URL), { method: 'POST', body: bytes, headers }));
  const text = await response.text();
  return { status: response.status, text, json: z.looseObject({}).parse(JSON.parse(text)) };
}
/** A request the agent made of tab `form` of the cloud browser, as the vault keeps it; `expiresIn` from now. */
async function request(vault: DurableObjectStub<CredentialVaultDO>, origin = 'https://accounts.example.com', expiresIn = 15 * 60_000): Promise<SecureInputRecord> {
  const id = browserBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const now = Date.now();
  const asked: RuntimeSecureInputQuestion = { requestId: id, url: `${env.ACCOUNT_URL}/secure-input/${id}`, source: 'cloud', pairingId: null, browser: 'Cloud browser', groupId: cloudGroupId, targetId: 'form', title: 'Log in', workspace: 'Workspace', origin, selector: '#password', kind: 'password', purpose: 'Log in as octocat', expiresAt: new Date(now + expiresIn).toISOString(), callId: 'call', askedAt: new Date(now).toISOString() };
  const record = { id, projectId: 'project', workspaceId: `workspace-${crypto.randomUUID()}`, conversationId: 'main', questionId: `question-${id.slice(0, 6)}`, request: asked };
  await vault.secureInputRecord(record);
  return { ...record, state: 'open' };
}
/** The workspace as the page reaches it: its question open (`open`), and what its fill did. */
function workspace(open = true, fill: { filled: true } | { refused: string } = { filled: true }) {
  return {
    open: vi.spyOn(SpaceAuthorityDO.prototype, 'secureInputOpen').mockResolvedValue(open),
    fill: vi.spyOn(SpaceAuthorityDO.prototype, 'secureInputFill').mockResolvedValue(fill),
    declined: vi.spyOn(SpaceAuthorityDO.prototype, 'secureInputDeclined').mockResolvedValue(undefined),
  };
}

test('the page needs a signed-in GitSpace browser of this account: unsigned or unknown devices read nothing', async () => {
  const person = await signedIn();
  const asked = await request(person.vault);
  const spaces = workspace();
  expect((await page({ op: 'view', id: asked.id }, null)).status).toBe(401);
  // A device another account enrolled is unknown here.
  expect((await page({ op: 'view', id: asked.id }, { deviceId: crypto.randomUUID(), key: crypto.getRandomValues(new Uint8Array(32)) })).status).toBe(401);
  expect((await page({ op: 'submit', id: asked.id, value: TYPED, save: false }, { deviceId: crypto.randomUUID(), key: crypto.getRandomValues(new Uint8Array(32)) })).status).toBe(401);
  expect(spaces.fill).not.toHaveBeenCalled();
  const viewed = await person.post({ op: 'view', id: asked.id });
  expect(viewed.status).toBe(200);
  expect(viewed.json).toEqual({ status: 'ok', value: { id: asked.id, state: 'open', workspace: 'Workspace', purpose: 'Log in as octocat', origin: 'https://accounts.example.com', kind: 'password', source: 'cloud', browser: 'Cloud browser', title: 'Log in', expiresAt: asked.request.expiresAt, saved: [] } });
  expect((await person.post({ op: 'view', id: 'x'.repeat(43) })).status).toBe(404);
});

test('opening or answering a request takes a passkey step-up naming that request and action, once; declining takes none', async () => {
  const person = await signedIn();
  const asked = await request(person.vault);
  const other = await request(person.vault);
  const spaces = workspace();
  expect(await person.bare({ op: 'view', id: asked.id }, null)).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_REQUIRED' } } });
  expect(await person.bare({ op: 'submit', id: asked.id, value: TYPED, save: false }, null)).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_REQUIRED' } } });
  // A step-up for another request, or for opening when answering, confirms nothing.
  const openOther = await passkeyProof(person.phone, person.passkey, { purpose: 'secure-input.open', targets: [other.id] });
  expect(await person.bare({ op: 'view', id: asked.id }, openOther)).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_INVALID' } } });
  const open = await passkeyProof(person.phone, person.passkey, { purpose: 'secure-input.open', targets: [asked.id] });
  expect(await person.bare({ op: 'submit', id: asked.id, value: TYPED, save: false }, open)).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_INVALID' } } });
  expect(await person.bare({ op: 'view', id: asked.id }, open)).toMatchObject({ status: 200, json: { value: { state: 'open' } } });
  expect(await person.bare({ op: 'view', id: asked.id }, open)).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_USED' } } });
  expect(spaces.fill).not.toHaveBeenCalled();
  expect(await person.bare({ op: 'decline', id: asked.id }, null)).toMatchObject({ status: 200, json: { value: { outcome: 'declined' } } });
});

test('a submit fills once: a second answer, an expired request and a closed question are refused, and nothing the account keeps or answers holds the value', async () => {
  const person = await signedIn();
  const asked = await request(person.vault);
  const spaces = workspace();
  const submitted = await person.post({ op: 'submit', id: asked.id, value: TYPED, save: false });
  expect(submitted.json).toEqual({ status: 'ok', value: { outcome: 'provided', saved: false } });
  expect(spaces.fill).toHaveBeenCalledOnce();
  expect(spaces.fill.mock.calls[0]?.[1]).toMatchObject({ id: asked.id, questionId: asked.questionId });
  expect(spaces.fill.mock.calls[0]?.[2]).toBe(TYPED);
  // Used: the second answer, and a view, say so.
  const again = await person.post({ op: 'submit', id: asked.id, value: TYPED, save: false });
  expect(again).toMatchObject({ status: 410, json: { error: { code: 'SECURE_INPUT_USED' } } });
  expect((await person.post({ op: 'view', id: asked.id })).json).toMatchObject({ value: { state: 'used' } });
  expect(spaces.fill).toHaveBeenCalledOnce();
  // Save was off: nothing is kept for the origin; the audit names the fill, never the value.
  expect(await person.vault.siteCredentials('https://accounts.example.com', 'password')).toEqual([]);
  const audit = await person.vault.siteCredentialAudit();
  expect(audit[0]).toMatchObject({ event: 'filled', origin: 'https://accounts.example.com', requestId: asked.id, deviceId: person.deviceId, credentialId: null });
  expect(JSON.stringify(audit)).not.toContain(TYPED);
  expect(submitted.text + again.text).not.toContain(TYPED);
  // Past its expiry a request takes nothing, and the page says it expired.
  const expired = await request(person.vault, 'https://accounts.example.com', -1);
  expect(await person.post({ op: 'submit', id: expired.id, value: TYPED, save: false })).toMatchObject({ status: 410, json: { error: { code: 'SECURE_INPUT_EXPIRED' } } });
  expect((await person.post({ op: 'view', id: expired.id })).json).toMatchObject({ value: { state: 'expired', saved: [] } });
  // A question that ended another way (declined on its card, the conversation stopped) takes nothing.
  spaces.open.mockResolvedValue(false);
  const closed = await request(person.vault);
  expect(await person.post({ op: 'submit', id: closed.id, value: TYPED, save: false })).toMatchObject({ status: 410, json: { error: { code: 'SECURE_INPUT_CLOSED' } } });
  expect(spaces.fill).toHaveBeenCalledOnce();
});

test('a fill the browser refuses answers declined with why; Decline on the page declines the question', async () => {
  const person = await signedIn();
  const spaces = workspace(true, { refused: 'The tab shows https://evil.example, not https://accounts.example.com' });
  const refused = await request(person.vault);
  expect((await person.post({ op: 'submit', id: refused.id, value: TYPED, save: true })).json).toEqual({ status: 'ok', value: { outcome: 'declined', reason: 'The tab shows https://evil.example, not https://accounts.example.com' } });
  // A refused fill saves nothing, even when save was ticked.
  expect(await person.vault.siteCredentials('https://accounts.example.com', 'password')).toEqual([]);
  expect((await person.vault.siteCredentialAudit())[0]).toMatchObject({ event: 'refused', requestId: refused.id, detail: 'The tab shows https://evil.example, not https://accounts.example.com' });
  const declined = await request(person.vault);
  expect((await person.post({ op: 'decline', id: declined.id })).json).toEqual({ status: 'ok', value: { outcome: 'declined', reason: 'The person declined it on the secure-input page' } });
  expect(spaces.declined).toHaveBeenCalledWith({ projectId: 'project', workspaceId: declined.workspaceId }, expect.objectContaining({ id: declined.id }), 'The person declined it on the secure-input page');
  expect(await person.post({ op: 'submit', id: declined.id, value: TYPED, save: false })).toMatchObject({ status: 410 });
});

test('save is off unless ticked; a saved value is sealed for its origin and kind only, and a later request fills it without typing', async () => {
  const person = await signedIn();
  const origin = `https://${crypto.randomUUID()}.example`;
  const spaces = workspace();
  const first = await request(person.vault, origin);
  expect((await person.post({ op: 'submit', id: first.id, value: TYPED, save: true })).json).toEqual({ status: 'ok', value: { outcome: 'provided', saved: true } });
  const saved = await person.vault.siteCredentials(origin, 'password');
  expect(saved).toHaveLength(1);
  const credentialId = saved[0]?.credentialId ?? '';
  expect(await person.vault.siteCredentials(origin, 'otp')).toEqual([]);
  expect(await person.vault.siteCredentials('https://other.example', 'password')).toEqual([]);
  expect(await person.vault.openSiteCredential(credentialId, 'https://other.example', 'password')).toBeNull();
  expect((await person.vault.siteCredentialAudit()).map(entry => entry.event).slice(0, 2)).toEqual(['saved', 'filled']);
  // The next request for the origin offers it, and using it fills the saved value.
  const second = await request(person.vault, origin);
  expect((await person.post({ op: 'view', id: second.id })).json).toMatchObject({ value: { saved: [{ credentialId }] } });
  expect((await person.post({ op: 'useSaved', id: second.id, credentialId })).json).toEqual({ status: 'ok', value: { outcome: 'provided', saved: false } });
  expect(spaces.fill.mock.calls.at(-1)?.[2]).toBe(TYPED);
  expect((await person.vault.siteCredentialAudit())[0]).toMatchObject({ event: 'filled', credentialId });
  // A value saved for another origin is not offered, and naming it fills nothing.
  const elsewhere = await request(person.vault);
  expect(await person.post({ op: 'useSaved', id: elsewhere.id, credentialId })).toMatchObject({ status: 404, json: { error: { code: 'SECURE_INPUT_SAVED_UNKNOWN' } } });
  expect((await person.post({ op: 'view', id: elsewhere.id })).json).toMatchObject({ value: { state: 'open' } });
});

// ── The fill: the workspace answers the question with what the browser did ──

/** The workspace object with its runtime replaced: whether the question is open, and the answers it records. */
function runtimeOf(instance: SpaceAuthorityDO, open: boolean) {
  const settled: unknown[] = [];
  const runtime = { secureInputOpen: async () => open, async secureInputSettled(...answer: unknown[]) { settled.push(answer); } };
  Reflect.set(instance, 'getRuntime', async () => runtime);
  return settled;
}

test('the workspace fills an open question\'s cloud tab and answers it provided, or declined with the browser\'s reason; a closed one fills nothing', async () => {
  const person = await signedIn();
  const asked = await request(person.vault);
  const fill = vi.spyOn(BrowserSessionDO.prototype, 'secureFill').mockResolvedValue({ filled: true });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${asked.workspaceId}`), async (instance: SpaceAuthorityDO) => {
    const identity = { projectId: 'project', workspaceId: asked.workspaceId };
    const settled = runtimeOf(instance, true);
    expect(await instance.secureInputFill(identity, asked, TYPED)).toEqual({ filled: true });
    expect(fill).toHaveBeenCalledWith({ ...identity, targetId: 'form', origin: 'https://accounts.example.com', field: { selector: '#password' }, value: TYPED });
    fill.mockResolvedValue({ refused: 'The tab is closed' });
    expect(await instance.secureInputFill(identity, asked, TYPED)).toEqual({ refused: 'The tab is closed' });
    expect(settled).toEqual([[asked.questionId, asked.id, { outcome: 'provided' }], [asked.questionId, asked.id, { outcome: 'declined', reason: 'GitSpace did not fill it: The tab is closed' }]]);
    expect(JSON.stringify(settled)).not.toContain(TYPED);
    const closed = runtimeOf(instance, false);
    fill.mockClear();
    expect(await instance.secureInputFill(identity, asked, TYPED)).toMatchObject({ refused: expect.stringContaining('no longer open') });
    expect(fill).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    await expect(instance.secureInputFill({ projectId: 'project', workspaceId: 'another' }, asked, TYPED)).rejects.toThrow();
  });
});

/** The cloud browser as Browser Run answers a fill: one sign-in page whose field takes text; `origin` is what its page
 * reports. Every command is recorded. */
function signInPage(origin: string) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const upstream: BrowserChannel = {
    async send(method, params = {}) {
      sent.push({ method, params });
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'form', type: 'page', url: `${origin}/login`, title: 'Log in', attached: false }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-form' };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 7 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'field' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: String(params.functionDeclaration).includes('fillable') ? { connected: true, top: true, fillable: true, password: false, origin } : origin } };
      return {};
    },
    subscribe() { return () => {}; },
    async close() {},
  };
  return { upstream, sent };
}

test('the cloud browser fills the field only while its page shows the origin; the value goes in one insert and nowhere else', async () => {
  const workspaceId = `secure-${crypto.randomUUID()}`;
  await runInDurableObject(env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:project:${workspaceId}`), async (session: BrowserSessionDO) => {
    const right = signInPage('https://accounts.example.com');
    session['browser'] = CdpBrowserShim.open(right.upstream);
    const input = { projectId: 'project', workspaceId, targetId: 'form', origin: 'https://accounts.example.com', field: { selector: '#password' }, value: TYPED };
    expect(await session.secureFill(input)).toEqual({ filled: true });
    const inserts = right.sent.filter(command => JSON.stringify(command).includes(TYPED));
    expect(inserts).toEqual([{ method: 'Input.insertText', params: { text: TYPED } }]);
    // The field is masked as it is filled: it is not a password field.
    expect(right.sent.find(command => String(command.params.functionDeclaration ?? '').includes('-webkit-text-security'))?.params.arguments).toEqual([{ value: true }]);
    const wrong = signInPage('https://evil.example');
    session['browser'] = CdpBrowserShim.open(wrong.upstream);
    expect(await session.secureFill(input)).toEqual({ refused: 'The tab shows https://evil.example, not https://accounts.example.com' });
    expect(wrong.sent.some(command => command.method === 'Input.insertText' || JSON.stringify(command).includes(TYPED))).toBe(false);
    expect(await session.secureFill({ ...input, targetId: 'gone' })).toEqual({ refused: 'The tab is closed' });
  });
});

// ── Your Chrome: a signed command, then the value, to an extension that fills ──

const sockets: WebSocket[] = [];
async function keys() { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }
function frame(socket: WebSocket): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true });
  return promise;
}

test('your Chrome gets the signed fill and the value in one frame, only when its extension says it fills; the agent never signs a value', async () => {
  await runInDurableObject(env.RELAY.getByName(crypto.randomUUID()), async instance => { try {
    const relay = hostedBrowserRelay(instance);
    const root = await keys(), workspace = await keys();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt: new Date().toISOString(), expiresAt }, root.key.privateKey);
    const chrome = async (ip: string, hello: object) => {
      const pairing = await relay.pair({ algorithm: 'Ed25519', accountId: env.ACCOUNT_ID, publicKey: root.publicKey }, 'wss://account.test/api/browser-relay/extension');
      const response = await relay.fetch(new Request('https://account.test/api/browser-relay/extension', { headers: { upgrade: 'websocket', origin: `chrome-extension://${'a'.repeat(32)}`, 'cf-connecting-ip': ip } }));
      const socket = response.webSocket;
      if (!socket) throw new Error('Missing Worker WebSocket');
      const challenge = frame(socket); socket.accept(); sockets.push(socket);
      const { serverNonce } = z.object({ serverNonce: z.string() }).parse(await challenge);
      const identity = await keys(), clientNonce = 'b'.repeat(64);
      const proof = browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${serverNonce}:${clientNonce}`))));
      const acknowledged = frame(socket);
      socket.send(JSON.stringify({ pairing: 'client', pairingId: pairing.pairingId, clientNonce, publicKey: identity.publicKey, proof, code: pairing.code }));
      await acknowledged;
      const ready = frame(socket);
      socket.send(JSON.stringify({ hello: true, Browser: 'Chrome/141.0.7390.54', platform: 'Linux', protocol: 6, extension: '5.14.0', chromeInfo: true, controls: true, siteLevels: true, takeover: true, ...hello }));
      await ready;
      const status = (await relay.status()).pairings.find(item => item.pairingId === pairing.pairingId);
      if (!status || status.state !== 'pending-confirmation') throw new Error('Expected unconfirmed identity');
      await relay.confirm(pairing.pairingId, status.pairedKeyFingerprint);
      const settings = await relay.projectSettings('project');
      await relay.setProjectSettings('project', settings.revision, { defaultPairingId: pairing.pairingId, approvals: [...settings.browsers.filter(browser => browser.approved).map(browser => ({ pairingId: browser.pairingId, powers: [] })), { pairingId: pairing.pairingId, powers: [] }] });
      const placement = await relay.placement('project', pairing.pairingId);
      const frames: string[] = [];
      socket.addEventListener('message', event => {
        const text = String(event.data);
        frames.push(text);
        const message = z.object({ id: z.number().optional(), operation: z.string().optional() }).loose().parse(JSON.parse(text));
        if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: message.operation === 'secureFill' ? { filled: true } : {} }));
      });
      const fill = async () => {
        const attemptId = crypto.randomUUID();
        const authorization = await signRuntimeAccountBrowserAuthorization({ scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'main', conversationKind: 'main', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser_control', deadlineAt: expiresAt, replay: 'unsafe' },
          command: { type: 'manage', action: 'secureFill', groupId, targetId: 'sign-in', origin: 'https://github.com', selector: '#password', fillKind: 'password', secureInputId: 'r'.repeat(43) } }, workspace.key.privateKey, authority);
        return relay.secureFill(authorization, TYPED);
      };
      return { frames, fill };
    };
    const current = await chrome('192.0.2.70', { secureInput: true });
    expect(await current.fill()).toEqual({ filled: true });
    const carrying = current.frames.filter(text => text.includes(TYPED));
    expect(carrying.map(text => z.looseObject({ operation: z.string() }).parse(JSON.parse(text)))).toEqual([{ id: expect.any(Number), operation: 'secureFill', groupId, targetId: 'sign-in', origin: 'https://github.com', selector: '#password', kind: 'password', secureInputId: 'r'.repeat(43), value: TYPED }]);
    // The signed command the extension checks came first and names the field, never the value.
    expect(current.frames.some(text => text.includes('"operation":"authorize"') && text.includes('"action":"secureFill"'))).toBe(true);
    const old = await chrome('192.0.2.71', {});
    expect(await old.fill()).toEqual({ refused: expect.stringContaining('update it to 5.14 or later') });
    expect(old.frames.some(text => text.includes(TYPED) || text.includes('secureFill'))).toBe(false);
  } finally { for (const socket of sockets.splice(0)) socket.close(); } });
});
