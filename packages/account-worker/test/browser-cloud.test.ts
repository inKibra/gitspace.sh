import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { AccountBrowserRuntime } from '../src/browser-runtime.js';
import { launchCloudBrowser, type BrowserChannel } from '../src/browser-cdp.js';
import { CloudServiceCookies, browserPages, browserPreview } from '../src/browser-session.js';
import { CdpBrowserShim } from '../src/browser-shim.js';
import { hostedServiceUrlPattern, isHostedServiceHostname, isWorkspaceServiceHostname } from '../src/service-access.js';
import { RuntimeAccountBrowserAuthorizationSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';

const RequestFrame = z.object({ id: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()), sessionId: z.string().optional() });
const SetCookies = z.object({ cookies: z.tuple([z.object({ name: z.string(), value: z.string(), url: z.string(), path: z.string(), secure: z.boolean(), httpOnly: z.boolean(), sameSite: z.string(), expires: z.number() })]) });
const workspace = { projectId: 'project', workspaceId: 'workspace' };
const hostname = `app--workspace--${env.TENANT_ID}-srv.gssh.dev`;
async function leaseService(name: string, workspaceId: string) {
  await env.HOSTED_ROUTES.getByName(name).lease(env.ACCOUNT_ID, 'project', { hostname: name, workspaceId, serviceName: 'app', source: 'declared', machineId: 'darktop', ingress: 'http://127.0.0.1:3000', portName: 'http', port: 3000, generation: 1, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() }, 'darktop');
}

test.each(['Fetch', 'Image', 'Document', 'Redirect', 'Unknown'])('cloud sets its own session cookie for an explicit service navigation and lets it go to the network, but denies ordinary-document %s access', async resource => {
  await leaseService(hostname, 'workspace');
  const store = new Map<string, unknown>();
  const storage = { async get(key: string) { return store.get(key); }, async put(key: string, value: unknown) { store.set(key, value); }, async delete(key: string) { return store.delete(key); } };
  const calls: Array<{ url: string; method: string }> = [];
  const commands: z.infer<typeof RequestFrame>[] = [];
  const continued = Promise.withResolvers<z.infer<typeof RequestFrame>>();
  const denied = Promise.withResolvers<z.infer<typeof RequestFrame>>();
  const pair = new WebSocketPair(); pair[1].accept();
  pair[1].addEventListener('message', event => {
    const command = RequestFrame.parse(JSON.parse(String(event.data)));
    commands.push(command);
    let result: unknown = {};
    if (command.method === 'Target.createTarget') result = { targetId: 'cloud-target' };
    if (command.method === 'Target.attachToTarget') result = { sessionId: 'cloud-session' };
    if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'frame', url: 'about:blank' } } };
    if (command.method === 'Page.navigate') {
      result = { frameId: 'frame' };
      pair[1].send(JSON.stringify({ method: 'Network.requestWillBeSent', sessionId: 'cloud-session', params: { requestId: 'hosted-network', frameId: 'frame', type: 'Document', documentURL: command.params.url, initiator: { type: 'other' }, request: { url: command.params.url } } }));
      pair[1].send(JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'cloud-session', params: { requestId: 'hosted-request', networkId: 'hosted-network', frameId: 'frame', resourceType: 'Document', request: { url: command.params.url, method: 'GET', headers: {} } } }));
    }
    if (command.method === 'Fetch.continueRequest' && command.params.requestId === 'hosted-request') continued.resolve(command);
    if ((command.method === 'Fetch.continueRequest' || command.method === 'Fetch.failRequest') && command.params.requestId === 'attacker-request') denied.resolve(command);
    pair[1].send(JSON.stringify({ id: command.id, result }));
  });
  const binding = { async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init); calls.push({ url: request.url, method: request.method });
    if (request.method === 'POST') return Response.json({ sessionId: 'binding-session' });
    expect(request.headers.get('upgrade')).toBe('websocket');
    return new Response(null, { status: 101, webSocket: pair[0] });
  } };
  const upstream = await launchCloudBrowser(binding, AbortSignal.timeout(5000));
  const cookies = new CloudServiceCookies(env, upstream, workspace);
  const runtime = new AccountBrowserRuntime({ storage, cloud: async () => upstream, services: { urlPattern: hostedServiceUrlPattern(env), hostname: name => isHostedServiceHostname(env, name), workspace: (name, grant) => isWorkspaceServiceHostname(env, workspace, name, grant), admit: name => cookies.admit(name) } });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const placement = { kind: 'cloud', accountId: 'account' };
  const authority = { body: { accountId: 'account', projectId: 'project', workspaceId: 'workspace', publicKey: 'AA==', issuedAt: new Date().toISOString(), expiresAt }, signature: 'AA==' };
  const authorization = RuntimeAccountBrowserAuthorizationSchema.parse({ body: { scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'subagent', taskId: 'task', requestId: 'request', attemptId: 'attempt' }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'open', source: 'headless', url: `https://${hostname}/private` }, grant: { body: { projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'headless', stepsOnly: [], origins: [], expiresAt }, signature: 'AA==', authority } } }, signature: 'AA==', authority });
  try {
    expect((await runtime.execute(authorization, AbortSignal.timeout(5000))).status).toBe('completed');
    await continued.promise;
    expect(commands.find(command => command.method === 'Fetch.enable')?.params.patterns).toEqual([{ urlPattern: `*://*--${env.TENANT_ID}-srv.gssh.dev/*`, requestStage: 'Request' }]);
    const setCookie = commands.findIndex(command => command.method === 'Storage.setCookies');
    expect(setCookie).toBeGreaterThan(-1);
    expect(setCookie).toBeLessThan(commands.findIndex(command => command.method === 'Fetch.continueRequest'));
    const [cookie] = SetCookies.parse(commands[setCookie]?.params).cookies;
    expect(cookie).toMatchObject({ name: '__Host-gitspace-service', url: `https://${hostname}/`, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    expect(await env.RELAY.getByName(env.RELAY_NAME).serviceValidate(cookie.value, hostname)).toMatchObject({ caller: { kind: 'cloud', ...workspace } });
    pair[1].send(JSON.stringify({ method: 'Page.frameNavigated', sessionId: 'cloud-session', params: { frame: { id: 'frame', url: 'https://attacker.example/' } } }));
    const resourceType = resource === 'Redirect' ? 'Document' : resource;
    if (resource !== 'Unknown') pair[1].send(JSON.stringify({ method: 'Network.requestWillBeSent', sessionId: 'cloud-session', params: { requestId: 'attacker-network', frameId: 'frame', type: resourceType, documentURL: 'https://attacker.example/', initiator: { type: 'script' }, request: { url: `https://${hostname}/private` }, ...(resource === 'Redirect' ? { redirectResponse: { status: 302 } } : {}) } }));
    pair[1].send(JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'cloud-session', params: { requestId: 'attacker-request', networkId: 'attacker-network', frameId: 'frame', resourceType, request: { url: `https://${hostname}/private`, method: 'GET', headers: {} } } }));
    expect((await denied.promise).method).toBe('Fetch.failRequest');
    expect(commands.filter(command => command.method === 'Storage.setCookies')).toHaveLength(1);
    expect(commands.some(command => command.method === 'Fetch.fulfillRequest')).toBe(false);
    expect(calls).toEqual([{ url: 'https://browser.internal/v1/devtools/browser?keep_alive=600000', method: 'POST' }, { url: 'https://browser.internal/v1/devtools/browser/binding-session', method: 'GET' }]);
    await expect(runtime.execute(authorization, AbortSignal.timeout(5000))).rejects.toThrow('already consumed');
  } finally { pair[1].close(); }
});

test('a script going to its workspace service gets the session cookie first; one going to another workspace service gets none', async () => {
  const elsewhere = `app--elsewhere--${env.TENANT_ID}-srv.gssh.dev`;
  await leaseService(hostname, 'workspace');
  await leaseService(elsewhere, 'elsewhere');
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const upstream: BrowserChannel = {
    async send(method, params = {}) { sent.push({ method, params }); return method === 'Target.createTarget' ? { targetId: `page-${sent.length}` } : {}; },
    subscribe() { return () => {}; },
    async close() {},
  };
  const cookies = new CloudServiceCookies(env, upstream, workspace);
  const script = (await CdpBrowserShim.open(upstream, { navigating: url => cookies.navigating(url) })).client(() => {});
  await script.send('Target.createTarget', { url: `https://${hostname}/app` });
  await script.send('Target.createTarget', { url: `https://${elsewhere}/app` });
  expect(sent.map(({ method, params }) => method === 'Target.createTarget' ? String(params.url) : method)).toEqual(['Target.setDiscoverTargets', 'Storage.setCookies', `https://${hostname}/app`, `https://${elsewhere}/app`]);
  const [cookie] = SetCookies.parse(sent[1]?.params).cookies;
  expect(cookie.url).toBe(`https://${hostname}/`);
  expect(await env.RELAY.getByName(env.RELAY_NAME).serviceValidate(cookie.value, elsewhere)).toBeNull();
});

afterEach(() => { vi.restoreAllMocks(); });

test('an expired cloud tab and its browser close before the next operation', async () => {
  const store = new Map<string, unknown>();
  const storage = { async get(key: string) { return store.get(key); }, async put(key: string, value: unknown) { store.set(key, value); }, async delete(key: string) { return store.delete(key); } };
  const methods: string[] = [];
  const released = Promise.withResolvers<number>();
  const pair = new WebSocketPair(); pair[1].accept();
  pair[1].addEventListener('close', event => released.resolve(event.code));
  pair[1].addEventListener('message', event => {
    const command = RequestFrame.parse(JSON.parse(String(event.data)));
    methods.push(command.method);
    const result = command.method === 'Target.createTarget' ? { targetId: 'cloud-target' } : command.method === 'Target.attachToTarget' ? { sessionId: 'cloud-session' } : {};
    pair[1].send(JSON.stringify({ id: command.id, result }));
  });
  const binding = { async fetch(input: RequestInfo | URL, init?: RequestInit) {
    return new Request(input, init).method === 'POST' ? Response.json({ sessionId: 'binding-session' }) : new Response(null, { status: 101, webSocket: pair[0] });
  } };
  const runtime = new AccountBrowserRuntime({ storage, cloud: signal => launchCloudBrowser(binding, signal) });
  const now = Date.now(), groupExpiresAt = new Date(now + 60_000).toISOString(), laterExpiresAt = new Date(now + 600_000).toISOString();
  const placement = { kind: 'cloud', accountId: 'account' };
  const authority = { body: { accountId: 'account', projectId: 'project', workspaceId: 'workspace', publicKey: 'AA==', issuedAt: new Date(now).toISOString(), expiresAt: laterExpiresAt }, signature: 'AA==' };
  const authorization = (attemptId: string, expiresAt: string, command: unknown) => RuntimeAccountBrowserAuthorizationSchema.parse({ body: { scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'subagent', taskId: attemptId, requestId: attemptId, attemptId }, issuedAt: new Date(now).toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command }, signature: 'AA==', authority });
  const grant = { body: { projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'headless', stepsOnly: [], origins: [], expiresAt: groupExpiresAt }, signature: 'AA==', authority };
  try {
    await runtime.execute(authorization('open', groupExpiresAt, { type: 'execute', args: { action: 'open', source: 'headless' }, grant }), AbortSignal.timeout(5000));
    expect(methods).not.toContain('Target.closeTarget');
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    await runtime.execute(authorization('status', laterExpiresAt, { type: 'manage', action: 'status' }), AbortSignal.timeout(5000));
    expect(methods.slice(-2)).toEqual(['Target.closeTarget', 'Browser.close']);
    expect(await released.promise).toBe(1000);
  } finally { pair[1].close(); }
});

test('a cloud tab preview is a small JPEG of the visible page, taken on a session of its own that it lets go', async () => {
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const upstream: BrowserChannel = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'page', type: 'page', url: 'https://example.com/', title: 'Example', attached: true }, { targetId: 'worker', type: 'service_worker', url: 'https://example.com/sw.js', title: '', attached: false }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'preview-session' };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 300, clientWidth: 1280, clientHeight: 720 } };
      if (method === 'Page.captureScreenshot') return { data: 'jpeg-bytes' };
      return {};
    },
    subscribe() { return () => {}; },
    async close() {},
  };
  const shim = await CdpBrowserShim.open(upstream);
  expect(await browserPages(shim)).toEqual([{ targetId: 'page', url: 'https://example.com/', title: 'Example' }]);
  expect(await browserPreview(shim, 'page')).toMatchObject({ targetId: 'page', image: { mediaType: 'image/jpeg', data: 'jpeg-bytes' }, reason: null });
  expect(sent.find(command => command.method === 'Page.captureScreenshot')).toEqual({ method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 50, clip: { x: 0, y: 300, width: 1280, height: 720, scale: 0.375 } }, sessionId: 'preview-session' });
  expect(sent.at(-1)).toEqual({ method: 'Target.detachFromTarget', params: { sessionId: 'preview-session' } });
});
