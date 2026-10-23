import { ed25519 } from '@noble/curves/ed25519.js';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';
import { RELAY_PROTOCOL_VERSION, createRelayAuthorization, createSignedControlRequest, decodeTunnelChunk, encodeTunnelChunk, tunnelRequestMessageSchema, type ControlOperation } from '@gitspace/protocol';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol/credential-vault';
import { SERVICE_ASSERTION_HEADER, verifyServiceAssertion, type ServiceCaller } from '@gitspace/protocol/service-access';
import { executionHash, serviceIngressContent, type HostedIngressCredential, type LifecycleActor, type LifecycleMutation, type ServiceIngressRoute } from '@gitspace/protocol-environment';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';
import type { ProjectAuthorityDO } from '../src/project-authority.js';

const WORKSPACE = 'space-a';
const WORKSPACE_URL = `api--${WORKSPACE}--${env.TENANT_ID}-srv.gssh.dev`;
const HOOKS: ServiceIngressRoute[] = [{ method: '*', path: '/hooks/*' }];
const machineKey = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const grant = signCredentialAuthorityGrant({
  version: 1, userId: env.ACCOUNT_ID, machineId: 'darktop', generation: 1, capabilities: ['storage.access', 'space.control'],
  signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)), exchangePublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)),
}, tenantRootPrivateKey);

beforeEach(async () => {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(49)) });
  await vault.registerDevice(grant);
});

afterEach(async () => {
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
    for (const socket of state.getWebSockets()) socket.close(1000, 'test complete');
    await state.storage.deleteAlarm();
  });
  vi.restoreAllMocks();
});

async function lease(hostname: string): Promise<void> {
  await env.HOSTED_ROUTES.getByName(hostname).lease(env.ACCOUNT_ID, 'project-a', { hostname, workspaceId: WORKSPACE, serviceName: 'api', source: 'declared', machineId: 'darktop', ingress: 'http://127.0.0.1:3000', portName: 'http', port: 3000, generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() }, 'darktop');
}

interface Forwarded { method: string; path: string; headers: Headers; body: string; caller: ServiceCaller | undefined }

/** The machine serving `hostname`: records each request it receives, with the caller the worker signed, and answers `served`. */
async function machine(hostname: string): Promise<Forwarded[]> {
  const target = '/ws?role=machine&id=darktop';
  const response = await exports.default.fetch(new Request(`https://relay.test${target}`, { headers: {
    upgrade: 'websocket', authorization: createRelayAuthorization(machineKey, target),
    'x-gitspace-machine-grant': btoa(JSON.stringify(grant)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''),
  } }));
  const socket = response.webSocket;
  if (!socket) throw new Error('Expected machine socket');
  socket.accept();
  const { publicKey } = await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).browserTrust();
  const forwarded: Forwarded[] = [];
  const open = new Map<string, Forwarded>();
  socket.addEventListener('message', event => {
    const message = tunnelRequestMessageSchema.parse(JSON.parse(String(event.data)));
    if (message.type === 'tunnel.request.start') {
      const headers = new Headers(message.headers);
      const caller = verifyServiceAssertion({ header: headers.get(SERVICE_ASSERTION_HEADER), publicKey, accountId: env.ACCOUNT_ID, machineId: 'darktop', hostname, method: message.method, target: message.path })?.caller;
      const entry = { method: message.method, path: message.path, headers, body: '', caller };
      forwarded.push(entry);
      open.set(message.requestId, entry);
    } else if (message.type === 'tunnel.request.chunk') {
      const entry = open.get(message.requestId);
      if (entry) entry.body += new TextDecoder().decode(decodeTunnelChunk(message.data));
    } else if (message.type === 'tunnel.request.end') {
      socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.start', requestId: message.requestId, status: 200, headers: [] }));
      socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.chunk', requestId: message.requestId, data: encodeTunnelChunk(new TextEncoder().encode('served')) }));
      socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.end', requestId: message.requestId }));
    }
  });
  return forwarded;
}

interface Issuer {
  url: string;
  /** Its public signing key, as its key set serves it. */
  key: JWK;
  credential: HostedIngressCredential;
  /** A token's claims: valid for the workspace URL unless overridden. */
  claims(overrides?: JWTPayload): JWTPayload;
  sign(overrides?: JWTPayload): Promise<string>;
}

/** An OIDC issuer of its own (the worker caches issuers per isolate) serving discovery and its ES256 key. */
async function issuer(forwardAuthorization = false): Promise<Issuer> {
  const url = `https://${crypto.randomUUID()}.issuer.example`;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const key = { ...await exportJWK(publicKey), kid: 'k1', alg: 'ES256' };
  network.use(
    http.get(`${url}/.well-known/openid-configuration`, () => HttpResponse.json({ issuer: url, jwks_uri: `${url}/keys` })),
    http.get(`${url}/keys`, () => HttpResponse.json({ keys: [key] })),
  );
  const claims = ({ iat = Math.floor(Date.now() / 1000), exp = iat + 60, ...overrides }: JWTPayload = {}): JWTPayload => ({ iss: url, aud: `https://${WORKSPACE_URL}`, sub: 'webhooks/stripe', iat, exp, ...overrides });
  return {
    url, key,
    credential: { kind: 'oidc', issuer: url, subjects: ['webhooks/*'], forwardAuthorization },
    claims,
    sign: overrides => new SignJWT(claims(overrides)).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(privateKey),
  };
}

describe('signed callers on workspace URLs', () => {
  it('forwards a declared route with a valid token, less its token header, while other paths and machine URLs keep the browser sign-in', async () => {
    const oidc = await issuer();
    const machineUrl = `api--darktop-1a2b--${WORKSPACE}--${env.TENANT_ID}-srv.gssh.dev`;
    for (const hostname of [WORKSPACE_URL, machineUrl]) {
      await lease(hostname);
      await env.HOSTED_ROUTES.getByName(hostname).registerIngress(env.ACCOUNT_ID, WORKSPACE, HOOKS, [oidc.credential], new Date().toISOString());
    }
    const forwarded = await machine(WORKSPACE_URL);
    const token = await oidc.sign();
    const admitted = await exports.default.fetch(new Request(`https://${WORKSPACE_URL}/hooks/stripe?delivery=1`, {
      method: 'POST', body: '{"event":"paid"}', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' },
    }));
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toBe('served');
    expect(forwarded).toMatchObject([{ method: 'POST', path: '/hooks/stripe?delivery=1', body: '{"event":"paid"}', caller: { kind: 'ingress', accountId: env.ACCOUNT_ID, workspaceId: WORKSPACE, credential: 'oidc' } }]);
    expect(forwarded[0]!.headers.has('authorization')).toBe(false);
    expect(forwarded[0]!.headers.get('stripe-signature')).toBe('t=1,v1=abc');
    for (const url of [`https://${WORKSPACE_URL}/private`, `https://${machineUrl}/hooks/stripe`]) {
      const response = await exports.default.fetch(new Request(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' }));
      expect(response.status, url).toBe(303);
      expect(new URL(response.headers.get('location')!).pathname).toBe('/service-access');
    }
    expect(forwarded).toHaveLength(1);
  });

  it('takes a forwarding credential\'s token only from GitSpace-Ingress and passes the service its own Authorization', async () => {
    const oidc = await issuer(true);
    await lease(WORKSPACE_URL);
    await env.HOSTED_ROUTES.getByName(WORKSPACE_URL).registerIngress(env.ACCOUNT_ID, WORKSPACE, HOOKS, [oidc.credential], new Date().toISOString());
    const forwarded = await machine(WORKSPACE_URL);
    const token = await oidc.sign();
    const refused = await exports.default.fetch(new Request(`https://${WORKSPACE_URL}/hooks/stripe`, { method: 'POST', body: 'x', headers: { authorization: `Bearer ${token}` } }));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'INGRESS_UNAUTHORIZED', reason: 'ingress_header_required' });
    const admitted = await exports.default.fetch(new Request(`https://${WORKSPACE_URL}/hooks/stripe`, { method: 'POST', body: 'x', headers: { 'gitspace-ingress': token, authorization: 'Bearer app-session' } }));
    expect(await admitted.text()).toBe('served');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers.get('authorization')).toBe('Bearer app-session');
    expect(forwarded[0]!.headers.has('gitspace-ingress')).toBe(false);
  });

  const now = () => Math.floor(Date.now() / 1000);
  it.each<[string, (oidc: Issuer) => Promise<string | null> | string | null]>([
    ['missing_credential', () => null],
    ['audience', oidc => oidc.sign({ aud: `https://web--${WORKSPACE}--${env.TENANT_ID}-srv.gssh.dev` })],
    ['issuer_not_registered', oidc => oidc.sign({ iss: 'https://unregistered.issuer.example' })],
    ['subject', oidc => oidc.sign({ sub: 'admin' })],
    ['expired', oidc => oidc.sign({ iat: now() - 120, exp: now() - 60 })],
    ['too_old', oidc => oidc.sign({ iat: now() - 600, exp: now() + 60 })],
    ['algorithm', oidc => new UnsecuredJWT(oidc.claims()).encode()],
    ['algorithm', oidc => new SignJWT(oidc.claims()).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode('a shared secret of at least 32 bytes'))],
    ['htm', oidc => oidc.sign({ htm: 'POST' })],
    ['htu', oidc => oidc.sign({ htu: `https://${WORKSPACE_URL}/hooks/other` })],
  ])('answers a declared route with a plain 401 (%s), never the sign-in redirect', async (reason, token) => {
    const oidc = await issuer();
    await lease(WORKSPACE_URL);
    await env.HOSTED_ROUTES.getByName(WORKSPACE_URL).registerIngress(env.ACCOUNT_ID, WORKSPACE, HOOKS, [oidc.credential], new Date().toISOString());
    const value = await token(oidc);
    const response = await exports.default.fetch(new Request(`https://${WORKSPACE_URL}/hooks/stripe?delivery=1`, { headers: value === null ? {} : { authorization: `Bearer ${value}` }, redirect: 'manual' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'INGRESS_UNAUTHORIZED', reason });
  });

  it.each<[string, string, (oidc: Issuer) => void]>([
    ['a discovery document naming another issuer', 'discovery_failed', oidc => network.use(http.get(`${oidc.url}/.well-known/openid-configuration`, () => HttpResponse.json({ issuer: `${oidc.url}/other`, jwks_uri: `${oidc.url}/keys` })))],
    ['keys on a GitSpace host', 'discovery_failed', oidc => network.use(
      http.get(`${oidc.url}/.well-known/openid-configuration`, () => HttpResponse.json({ issuer: oidc.url, jwks_uri: 'https://keys.gssh.dev/jwks' })),
      http.get('https://keys.gssh.dev/jwks', () => HttpResponse.json({ keys: [oidc.key] })),
    )],
    ['a redirected discovery document', 'discovery_failed', oidc => network.use(
      http.get(`${oidc.url}/.well-known/openid-configuration`, () => new HttpResponse(null, { status: 302, headers: { location: `${oidc.url}/moved` } })),
      http.get(`${oidc.url}/moved`, () => HttpResponse.json({ issuer: oidc.url, jwks_uri: `${oidc.url}/keys` })),
    )],
    ['a key set over 64 KiB', 'keys_unavailable', oidc => network.use(http.get(`${oidc.url}/keys`, () => HttpResponse.json({ keys: [oidc.key], padding: 'x'.repeat(65_536) })))],
  ])('refuses a valid token when the issuer serves %s', async (_case, reason, serve) => {
    const oidc = await issuer();
    serve(oidc);
    await lease(WORKSPACE_URL);
    await env.HOSTED_ROUTES.getByName(WORKSPACE_URL).registerIngress(env.ACCOUNT_ID, WORKSPACE, HOOKS, [oidc.credential], new Date().toISOString());
    const response = await exports.default.fetch(new Request(`https://${WORKSPACE_URL}/hooks/stripe`, { headers: { authorization: `Bearer ${await oidc.sign()}` } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'INGRESS_UNAUTHORIZED', reason });
  });

  it('admits a bearer token by its current or previous hash and nothing older', async () => {
    await lease(WORKSPACE_URL);
    const registry = env.HOSTED_ROUTES.getByName(WORKSPACE_URL);
    const rotate = async (secret: string) => {
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      await registry.registerIngress(env.ACCOUNT_ID, WORKSPACE, HOOKS, [{ kind: 'bearer', secret: 'HOOK_TOKEN', sha256 }], new Date().toISOString());
    };
    const forwarded = await machine(WORKSPACE_URL);
    const status = async (token: string) => {
      const response = await exports.default.fetch(new Request(`https://${WORKSPACE_URL}/hooks/a`, { method: 'POST', body: 'x', headers: { authorization: `Bearer ${token}` } }));
      await response.arrayBuffer();
      return response.status;
    };
    await rotate('first');
    await rotate('second');
    expect([await status('first'), await status('second'), await status('third')]).toEqual([200, 200, 401]);
    // Registering the current secret again keeps the previous one.
    await rotate('second');
    expect(await status('first')).toBe(200);
    await rotate('third');
    expect([await status('first'), await status('second'), await status('third')]).toEqual([401, 200, 200]);
    expect(forwarded.map(entry => entry.caller)).toEqual(Array(5).fill({ kind: 'ingress', accountId: env.ACCOUNT_ID, workspaceId: WORKSPACE, credential: 'bearer' }));
  });
});

describe('signed caller registration', () => {
  const projectId = 'ingress-project';
  const content = serviceIngressContent(JSON.stringify({ services: [{ name: 'api', ports: [{ name: 'http' }], ingress: [{ method: 'POST', path: '/hooks/*' }] }] }))!;
  const unapproved = serviceIngressContent(JSON.stringify({ services: [{ name: 'api', ports: [{ name: 'http' }], ingress: [{ method: '*', path: '/*' }] }] }))!;
  const machineActor = (machineId: string): LifecycleActor => ({ machineId, actorId: machineId, kind: 'machine', lifecycleControl: false });
  const human: LifecycleActor = { machineId: 'browser', actorId: 'browser', kind: 'browser', lifecycleControl: true };

  async function control(operation: ControlOperation, payload: Record<string, unknown>): Promise<{ status: string; value?: unknown }> {
    const response = await exports.default.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({ userId: env.ACCOUNT_ID, machineId: 'darktop', operation, payload, signingPrivateKey: machineKey })),
    }));
    return response.json();
  }
  const register = (workspaceId: string, runId: string, hostname: string, ingress = content) => control('project.routes.ingress', {
    projectId, workspaceId, runId, ingress,
    registrations: [{ hostname, service: 'api', port: 'http', credentials: [{ kind: 'bearer', secret: 'HOOK_TOKEN', sha256: 'a'.repeat(64) }] }],
  });
  const ingress = async (hostname: string) => (await env.HOSTED_ROUTES.getByName(hostname).resolve('POST', '/hooks/a')).ingress;

  /** A workspace whose environment declares the routes, approved; `run` starts a provision run on a machine. */
  async function provisioning(authority: DurableObjectStub<ProjectAuthorityDO>, workspaceId: string) {
    await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: workspaceId, branch: workspaceId, phase: null, sourceKind: 'branch', sourceRef: workspaceId, sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
    const mutate = async (input: LifecycleMutation, actor: LifecycleActor) => {
      const result = await space.mutateLifecycleState({ projectId, workspaceId }, input, actor);
      if (result.status === 'error') throw new Error(result.failure.message);
    };
    const hash = await executionHash({ kind: 'ingress', command: content });
    await mutate({ op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'ingress', kind: 'ingress', label: 'Signed callers', command: '.gitspace/services.json', hash, phase: null, fileName: null, content }] }, machineActor('darktop'));
    const run = async (runId: string, machineId: string) => {
      await mutate({ op: 'claim', runId, phase: 'cloud/provision', profile: 'base', executionHashes: [], generation: null, rerun: false }, machineActor(machineId));
      await mutate({ op: 'start', runId }, machineActor(machineId));
    };
    await mutate({ op: 'approval', scope: 'workspace', executionHash: hash, approved: true }, human);
    return run;
  }

  it('accepts only this machine\'s running provision run for approved routes, replaces earlier URLs, and ends them at archive and delete', async () => {
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await authority.bootstrap({ id: projectId, name: 'Ingress', repositoryReference: null, baseBranch: 'main', createdBy: 'darktop' });
    const first = `api--ws-a--${env.TENANT_ID}-srv.gssh.dev`;
    const renamed = `api--ws-renamed--${env.TENANT_ID}-srv.gssh.dev`;
    const runA = await provisioning(authority, 'ws-a');
    expect(await register('ws-a', 'provision', first)).toMatchObject({ status: 'error' });
    await runA('elsewhere', 'other-machine');
    expect(await register('ws-a', 'elsewhere', first)).toMatchObject({ status: 'error' });
    await runA('provision', 'darktop');
    expect(await register('ws-a', 'provision', first, unapproved)).toMatchObject({ status: 'error' });
    expect(await ingress(first)).toBeNull();
    expect(await register('ws-a', 'provision', first)).toEqual({ status: 'ok', value: { hostnames: [first] } });
    expect(await ingress(first)).toEqual({ tenant: env.ACCOUNT_ID, workspaceId: 'ws-a', credentials: [{ kind: 'bearer', secret: 'HOOK_TOKEN', hashes: ['a'.repeat(64)] }] });
    // A registration replaces the workspace's earlier ones.
    expect(await register('ws-a', 'provision', renamed)).toMatchObject({ status: 'ok' });
    expect(await ingress(first)).toBeNull();
    expect(await ingress(renamed)).toMatchObject({ workspaceId: 'ws-a' });
    await authority.commitWorkspaceLifecycle('ws-a', 'archived');
    expect(await ingress(renamed)).toBeNull();
    // A run still running after archive cannot bring them back.
    expect(await register('ws-a', 'provision', renamed)).toMatchObject({ status: 'error' });
    expect(await ingress(renamed)).toBeNull();

    const other = `api--ws-b--${env.TENANT_ID}-srv.gssh.dev`;
    await (await provisioning(authority, 'ws-b'))('provision-b', 'darktop');
    expect(await register('ws-b', 'provision-b', other)).toMatchObject({ status: 'ok' });
    expect(await ingress(other)).toMatchObject({ workspaceId: 'ws-b' });
    await authority.deleteProject((await authority.getProject())!.revision);
    expect(await ingress(other)).toBeNull();
  });
});
