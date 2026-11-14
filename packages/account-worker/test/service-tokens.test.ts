import { ed25519 } from '@noble/curves/ed25519.js';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from 'jose';
import { RELAY_PROTOCOL_VERSION, createRelayAuthorization, createSignedControlRequest, decodeTunnelChunk, encodeTunnelChunk, tunnelRequestMessageSchema, type ControlOperation } from '@gitspace/protocol';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol/credential-vault';
import { SERVICE_ASSERTION_HEADER, verifyServiceAssertion, type ServiceCaller } from '@gitspace/protocol/service-access';
import { executionHash, serviceIngressContent, ServiceTokenGrantSchema, type LifecycleActor, type LifecycleMutation } from '@gitspace/protocol-environment';
import { tenantRootPrivateKey } from './setup.js';
import { revokeServiceToken, rotateServiceTokenKey, serviceTokensView } from '../src/service-tokens.js';

const PROJECT = 'tokens-project';
const WORKSPACE = 'ws-tokens';
const URL_HOST = `api--${WORKSPACE}--${env.TENANT_ID}-srv.gssh.dev`;
const VAULT_KEY = new Uint8Array(32).fill(49);
const machineKey = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const grant = signCredentialAuthorityGrant({
  version: 1, userId: env.ACCOUNT_ID, machineId: 'lab', generation: 1, capabilities: ['storage.access', 'space.control'],
  signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)), exchangePublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)),
}, tenantRootPrivateKey);
/** `/app/*` admits service tokens; `/hooks/*` only the bearer a script registers. */
const content = serviceIngressContent(JSON.stringify({ services: [{ name: 'api', ports: [{ name: 'http' }], ingress: [{ method: 'POST', path: '/app/*', tokens: true }, { method: 'POST', path: '/hooks/*' }] }] }))!;
const hookHash = async (secret: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

beforeEach(async () => {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(VAULT_KEY) });
  await vault.registerDevice(grant);
});

afterEach(async () => {
  vi.useRealTimers();
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
    for (const socket of state.getWebSockets()) socket.close(1000, 'test complete');
    await state.storage.deleteAlarm();
  });
});

async function control(operation: ControlOperation, payload: Record<string, unknown>): Promise<{ status: string; value?: unknown; error?: { message: string } }> {
  const response = await exports.default.fetch(new Request('https://auth.test/v1/control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createSignedControlRequest({ userId: env.ACCOUNT_ID, machineId: 'lab', operation, payload, signingPrivateKey: machineKey })),
  }));
  return response.json();
}

interface Forwarded { path: string; headers: Headers; caller: ServiceCaller | undefined }

/** The machine serving the workspace URL: records each request it receives, with the caller the worker signed, and answers `served`. */
async function machine(): Promise<Forwarded[]> {
  const target = '/ws?role=machine&id=lab';
  const response = await exports.default.fetch(new Request(`https://relay.test${target}`, { headers: {
    upgrade: 'websocket', authorization: createRelayAuthorization(machineKey, target),
    'x-gitspace-machine-grant': btoa(JSON.stringify(grant)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''),
  } }));
  const socket = response.webSocket;
  if (!socket) throw new Error('Expected machine socket');
  socket.accept();
  const { publicKey } = await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).browserTrust();
  const forwarded: Forwarded[] = [];
  socket.addEventListener('message', event => {
    const message = tunnelRequestMessageSchema.parse(JSON.parse(String(event.data)));
    if (message.type === 'tunnel.request.start') {
      const headers = new Headers(message.headers);
      const caller = verifyServiceAssertion({ header: headers.get(SERVICE_ASSERTION_HEADER), publicKey, accountId: env.ACCOUNT_ID, machineId: 'lab', hostname: URL_HOST, method: message.method, target: message.path })?.caller;
      forwarded.push({ path: message.path, headers, caller });
    } else if (message.type === 'tunnel.request.chunk') decodeTunnelChunk(message.data);
    else if (message.type === 'tunnel.request.end') {
      socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.start', requestId: message.requestId, status: 200, headers: [] }));
      socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.chunk', requestId: message.requestId, data: encodeTunnelChunk(new TextEncoder().encode('served')) }));
      socket.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.end', requestId: message.requestId }));
    }
  });
  return forwarded;
}

/**
 * An active workspace whose approved routes are registered on its leased workspace URL by a running provision run.
 * `register` repeats that run's registration; `credentials` undefined is a run that wrote no ingress.json.
 */
async function registered() {
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${PROJECT}`);
  await authority.bootstrap({ id: PROJECT, name: 'Tokens', repositoryReference: null, baseBranch: 'main', createdBy: 'lab' });
  await authority.putWorkspace({ id: WORKSPACE, projectId: PROJECT, kind: 'worktree', name: WORKSPACE, branch: WORKSPACE, phase: null, sourceKind: 'branch', sourceRef: WORKSPACE, sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${WORKSPACE}`);
  const machineActor: LifecycleActor = { machineId: 'lab', actorId: 'lab', kind: 'machine', lifecycleControl: false };
  const mutate = async (input: LifecycleMutation, actor: LifecycleActor) => {
    const result = await space.mutateLifecycleState({ projectId: PROJECT, workspaceId: WORKSPACE }, input, actor);
    if (result.status === 'error') throw new Error(result.failure.message);
  };
  const hash = await executionHash({ kind: 'ingress', command: content });
  await mutate({ op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'ingress', kind: 'ingress', label: 'Signed callers', command: '.gitspace/services.json', hash, phase: null, fileName: null, content }] }, machineActor);
  await mutate({ op: 'approval', scope: 'workspace', executionHash: hash, approved: true }, { machineId: 'browser', actorId: 'browser', kind: 'browser', lifecycleControl: true });
  await mutate({ op: 'claim', runId: 'provision', phase: 'cloud/provision', profile: 'base', executionHashes: [], generation: null, rerun: false }, machineActor);
  await mutate({ op: 'start', runId: 'provision' }, machineActor);
  await env.HOSTED_ROUTES.getByName(URL_HOST).lease(env.ACCOUNT_ID, PROJECT, { hostname: URL_HOST, workspaceId: WORKSPACE, serviceName: 'api', source: 'declared', machineId: 'lab', ingress: 'http://127.0.0.1:3000', portName: 'http', port: 3000, generation: 1, leaseExpiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() }, 'lab');
  const register = async (credentials?: Array<{ kind: 'bearer'; secret: string; sha256: string }>) => {
    const result = await control('project.routes.ingress', { projectId: PROJECT, workspaceId: WORKSPACE, runId: 'provision', ingress: content, registrations: [{ hostname: URL_HOST, service: 'api', port: 'http', ...(credentials ? { credentials } : {}) }] });
    expect(result).toMatchObject({ status: 'ok' });
  };
  await register([{ kind: 'bearer', secret: 'HOOK_TOKEN', sha256: await hookHash('hook-secret') }]);
  return { register };
}

/** `gitspace service token` on the machine. */
async function mint(request: Record<string, unknown> = {}) {
  const result = await control('project.services.token', { projectId: PROJECT, workspaceId: WORKSPACE, request: { service: 'api', subject: 'ios-dev/brad', ...request } });
  if (result.status !== 'ok') throw new Error(result.error?.message ?? 'mint failed');
  return ServiceTokenGrantSchema.parse(result.value);
}

async function call(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await exports.default.fetch(new Request(`https://${URL_HOST}${path}`, { method: 'POST', body: 'x', headers, redirect: 'manual' }));
  return { status: response.status, body: await response.text() };
}

async function refresh(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await exports.default.fetch(new Request(`https://${URL_HOST}/__gitspace/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: token }) }));
  return { status: response.status, body: await response.json() };
}

const refused = (reason: string) => ({ status: 401, body: JSON.stringify({ error: 'INGRESS_UNAUTHORIZED', reason }) });

describe('service tokens', () => {
  it('admits a minted token as GitSpace-Ingress on a route that sets tokens, and nowhere else', async () => {
    await registered();
    const forwarded = await machine();
    const grant = await mint({ ttlSeconds: 3600 });
    expect(grant).toMatchObject({ service: 'api', port: 'http', url: `https://${URL_HOST}`, subject: 'ios-dev/brad', header: 'GitSpace-Ingress' });
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThanOrEqual(3600_000);
    expect(decodeJwt(grant.token)).toMatchObject({ aud: `https://${URL_HOST}`, sub: 'ios-dev/brad', iss: `${env.ACCOUNT_URL}/issuers/${WORKSPACE}/api` });

    expect(await call('/app/orders', { 'gitspace-ingress': grant.token, authorization: 'Bearer app-session' })).toEqual({ status: 200, body: 'served' });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.caller).toEqual({ kind: 'ingress', accountId: env.ACCOUNT_ID, workspaceId: WORKSPACE, credential: 'managed' });
    expect(forwarded[0]!.headers.get('authorization')).toBe('Bearer app-session');
    expect(forwarded[0]!.headers.has('gitspace-ingress')).toBe(false);
    // A declared route without tokens, and the token in Authorization, are refused; an undeclared path takes the browser
    // path, whose origin check refuses a cross-site POST.
    expect(await call('/hooks/stripe', { 'gitspace-ingress': grant.token })).toEqual(refused('issuer_not_registered'));
    expect(await call('/app/orders', { authorization: `Bearer ${grant.token}` })).toEqual(refused('ingress_header_required'));
    expect((await call('/private', { 'gitspace-ingress': grant.token })).status).toBe(403);
    expect(forwarded).toHaveLength(1);
  });

  it('refuses a token after it expires, after it is revoked, and after its key is rotated out', async () => {
    await registered();
    await machine();
    const short = await mint({ ttlSeconds: 60 });
    expect((await call('/app/a', { 'gitspace-ingress': short.token })).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(short.expiresAt) + 10_000);
    expect(await call('/app/a', { 'gitspace-ingress': short.token })).toEqual(refused('expired'));
    vi.useRealTimers();

    const revoked = await mint();
    expect((await call('/app/a', { 'gitspace-ingress': revoked.token })).status).toBe(200);
    const view = await revokeServiceToken(env, WORKSPACE, 'api', `https://${URL_HOST}`, String(decodeJwt(revoked.token).jti));
    expect(view.tokens.find(token => token.id === decodeJwt(revoked.token).jti)).toMatchObject({ subject: 'ios-dev/brad', revokedAt: expect.any(String), lastUsedAt: expect.any(String) });
    expect(await call('/app/a', { 'gitspace-ingress': revoked.token })).toEqual(refused('revoked'));

    const rotated = await mint();
    const before = (await serviceTokensView(env, WORKSPACE, 'api')).keys;
    const after = await rotateServiceTokenKey(env, WORKSPACE, 'api');
    expect(after.keys).toHaveLength(1);
    expect(after.keys[0]!.fingerprint).not.toBe(before[0]!.fingerprint);
    expect(await call('/app/a', { 'gitspace-ingress': rotated.token })).toEqual(refused('unknown_key'));
    expect((await call('/app/a', { 'gitspace-ingress': (await mint()).token })).status).toBe(200);
  });

  it('keeps a key verifying its tokens for 8 hours after its 7 days of signing end', async () => {
    await registered();
    await machine();
    const [first] = (await serviceTokensView(env, WORKSPACE, 'api')).keys;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(first!.signsUntil) - 3_600_000);
    const late = await mint();
    vi.setSystemTime(Date.parse(first!.signsUntil) + 3_600_000);
    const next = await mint();
    expect(decodeJwt(next.token).iat).toBeGreaterThan(decodeJwt(late.token).iat!);
    const keys = (await serviceTokensView(env, WORKSPACE, 'api')).keys;
    expect(keys.map(key => key.fingerprint)).toEqual([expect.not.stringMatching(first!.fingerprint), first!.fingerprint]);
    expect((await call('/app/a', { 'gitspace-ingress': late.token })).status).toBe(200);
    expect((await call('/app/a', { 'gitspace-ingress': next.token })).status).toBe(200);
  });

  it('exchanges a refresh token once; presenting a spent one revokes its whole chain', async () => {
    await registered();
    await machine();
    const grant = await mint({ refresh: true });
    expect(grant.refreshUrl).toBe(`https://${URL_HOST}/__gitspace/token`);
    const exchanged = await refresh(grant.refreshToken!);
    expect(exchanged).toMatchObject({ status: 200, body: { token_type: 'Bearer', expires_in: 28_800, access_token: expect.any(String), refresh_token: expect.any(String) } });
    const access = String(exchanged.body.access_token);
    expect(decodeJwt(access).sub).toBe('ios-dev/brad');
    expect((await call('/app/a', { 'gitspace-ingress': access })).status).toBe(200);
    expect((await call('/app/a', { 'gitspace-ingress': grant.token })).status).toBe(200);

    expect(await refresh(grant.refreshToken!)).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    expect(await call('/app/a', { 'gitspace-ingress': access })).toEqual(refused('revoked'));
    expect(await call('/app/a', { 'gitspace-ingress': grant.token })).toEqual(refused('revoked'));
    expect(await refresh(String(exchanged.body.refresh_token))).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    expect(await refresh('never-issued')).toEqual({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('keeps the managed credential and its tokens when a script registers ingress.json again', async () => {
    const { register } = await registered();
    await machine();
    const grant = await mint();
    await register([{ kind: 'bearer', secret: 'HOOK_TOKEN', sha256: await hookHash('rotated-secret') }]);
    expect((await call('/app/a', { 'gitspace-ingress': grant.token })).status).toBe(200);
    expect((await call('/hooks/a', { authorization: 'Bearer rotated-secret' })).status).toBe(200);
    // A run that wrote no ingress.json keeps the script's credentials too.
    await register();
    expect((await call('/app/a', { 'gitspace-ingress': grant.token })).status).toBe(200);
    expect((await call('/hooks/a', { authorization: 'Bearer rotated-secret' })).status).toBe(200);
  });

  it('never puts the private key in a minted grant, a view, a rotation or a refresh answer', async () => {
    await registered();
    const grant = await mint({ refresh: true });
    const outputs = [
      JSON.stringify(grant),
      JSON.stringify(await serviceTokensView(env, WORKSPACE, 'api')),
      JSON.stringify((await refresh(grant.refreshToken!)).body),
      JSON.stringify(await rotateServiceTokenKey(env, WORKSPACE, 'api')),
      JSON.stringify(await env.HOSTED_ROUTES.getByName(URL_HOST).resolve('POST', '/app/a')),
    ];
    const sealed = await runInDurableObject(env.CREDENTIALS.getByName(env.ACCOUNT_ID), (_instance, state) => state.storage.sql.exec<{ kid: string; sealed_private_key: string }>('SELECT kid, sealed_private_key FROM service_token_keys').toArray());
    expect(sealed.length).toBeGreaterThan(0);
    for (const row of sealed) {
      const bytes = Uint8Array.from(credentialProtocolBase64.decode(row.sealed_private_key));
      const key = await crypto.subtle.importKey('raw', VAULT_KEY, 'AES-GCM', false, ['decrypt']);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(JSON.stringify(['service-token-key/v1', env.ACCOUNT_ID, WORKSPACE, 'api', row.kid])) }, key, bytes.subarray(12));
      const { d } = JSON.parse(new TextDecoder().decode(plaintext));
      expect(d).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      for (const output of outputs) expect(output).not.toContain(d);
    }
  });
});
