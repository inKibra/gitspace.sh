import { expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { stringify } from 'devalue';
import { createSignedRpcFetch, RPC_DEVICE_HEADER, signRpcRequest, type DeviceCapability, type DeviceScope, type VerifiedDevice } from '@gitspace/protocol';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createSignedRpcHandler } from '../src/signed-rpc.js';

it('authorizes environment mutations against the scope being changed, not just the selected workspace', async () => {
  const key = ed25519.utils.randomSecretKey();
  const id = crypto.randomUUID();
  let scope: DeviceScope = { kind: 'workspace', workspaceId: 'own' };
  const handler = createSignedRpcHandler({
    handler: async () => new Response(null, { status: 204 }),
    lookupDevice: async () => ({ deviceId: id, kind: 'client', label: 'scoped', scope, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, signingPublicKey: ed25519.getPublicKey(key), generation: 1, boundAt: Date.now(), expiresAt: null } satisfies VerifiedDevice),
    procedureKind: path => path === 'events' ? 'subscription' : path === 'space.view' ? 'query' : 'mutation',
    workspaceProject: workspace => workspace === 'own' ? 'project-a' : 'project-b',
    sessionTarget: session => session === 'session-own' ? { projectId: 'project-a', workspaceId: 'own' } : session === 'session-foreign' ? { projectId: 'project-b', workspaceId: 'foreign' } : null,
  });
  const invoke = async (path: string, input: Record<string, unknown>) => {
    const body = new TextEncoder().encode(stringify({ v: 1, path, input }));
    return handler(new Request('https://machine.test/rpc', { method: 'POST', body, headers: { [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: id, method: 'POST', path: '/rpc', body, signingPrivateKey: key }) } }));
  };
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'workspace', name: 'X', value: 'one' })).status).toBe(204);
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'global', name: 'X', value: 'one' })).status).toBe(403);
  expect((await invoke('environment.approve', { spaceId: 'own', scope: 'project', executionHash: 'hash' })).status).toBe(403);
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  expect((await invoke('environment.runChecks', { spaceId: 'own', runId: 'checks-a', deadlineAt })).status).toBe(204);
  expect((await invoke('environment.runChecks', { spaceId: 'foreign', runId: 'checks-b', deadlineAt })).status).toBe(403);
  expect((await invoke('environment.runPhase', { spaceId: 'own', runId: 'prepare-a', phase: 'machine/prepare', rerun: false, deadlineAt })).status).toBe(204);
  expect((await invoke('environment.runPhase', { spaceId: 'foreign', runId: 'prepare-b', phase: 'machine/prepare', rerun: false, deadlineAt })).status).toBe(403);
  expect((await invoke('environment.cancelRun', { spaceId: 'own', runId: 'checks-a' })).status).toBe(403);
  expect((await invoke('environment.cancelRun', { spaceId: 'foreign', runId: 'checks-b' })).status).toBe(403);
  expect((await invoke('events', { projectId: 'project-a', after: null })).status).toBe(403);
  scope = { kind: 'project', projectId: 'project-a' };
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'project', name: 'X', value: 'one' })).status).toBe(204);
  expect((await invoke('session.control', { sessionId: 'session-own' })).status).toBe(204);
  expect((await invoke('session.control', { sessionId: 'session-foreign' })).status).toBe(403);
  expect((await invoke('session.control', { sessionId: 'missing' })).status).toBe(403);
  expect((await invoke('session.control', { sessionId: 'session-foreign', projectId: 'project-a' })).status).toBe(403);
  expect((await invoke('space.view', { projectId: 'project-a', workspaceId: 'foreign' })).status).toBe(403);
  expect((await invoke('events', { projectId: 'project-a', after: null })).status).toBe(204);
  expect((await invoke('events', { projectId: 'project-b', after: 12 })).status).toBe(403);
  scope = { kind: 'user' };
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'global', name: 'X', value: 'one' })).status).toBe(204);
});

it('requires fleet and deployment control before dispatching sandbox creation with an explicit image', async () => {
  const key = ed25519.utils.randomSecretKey();
  const id = crypto.randomUUID();
  let capabilities: DeviceCapability[] = ['fleet.control'];
  let scope: DeviceScope = { kind: 'user' };
  const handler = createSignedRpcHandler({
    handler: async () => new Response(null, { status: 204 }),
    lookupDevice: async () => ({ deviceId: id, kind: 'client', label: 'fleet operator', scope, capabilities, canDelegate: false, signingPublicKey: ed25519.getPublicKey(key), generation: 1, boundAt: Date.now(), expiresAt: null } satisfies VerifiedDevice),
    procedureKind: path => path === 'machine.createSandbox' ? 'mutation' : null,
    workspaceProject: () => null,
  });
  const invoke = async (inputs: Record<string, unknown>[]) => {
    const batch = inputs.map(input => ({ path: 'machine.createSandbox', input }));
    const body = new TextEncoder().encode(stringify(inputs.length === 1 ? { v: 1, ...batch[0] } : { v: 1, batch }));
    return handler(new Request('https://machine.test/rpc', { method: 'POST', body, headers: { [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: id, method: 'POST', path: '/rpc', body, signingPrivateKey: key }) } }));
  };
  const custom = { image: { kind: 'custom', image: `ghcr.io/tenant/custom@sha256:${'a'.repeat(64)}` } };
  const platform = { image: { kind: 'platform-default' } };
  expect((await invoke([custom])).status).toBe(403);
  expect((await invoke([platform])).status).toBe(403);
  expect((await invoke([{}, custom])).status).toBe(403);
  expect((await invoke([{}])).status).toBe(204);
  capabilities = ['deployment.control'];
  expect((await invoke([custom])).status).toBe(403);
  capabilities = ['fleet.control', 'deployment.control'];
  expect((await invoke([custom])).status).toBe(204);
  expect((await invoke([platform])).status).toBe(204);
  scope = { kind: 'project', projectId: 'project-a' };
  expect((await invoke([custom])).status).toBe(403);
  expect((await invoke([{}])).status).toBe(403);
});

it('requires explicit client lifecycle authority and preserves browser retirement access', async () => {
  const key = ed25519.utils.randomSecretKey();
  const id = crypto.randomUUID();
  let capabilities: DeviceCapability[] = ['rpc.write'];
  let kind: 'browser' | 'client' = 'client';
  let scope: DeviceScope = { kind: 'user' };
  const handler = createSignedRpcHandler({
    handler: async () => new Response(null, { status: 204 }),
    lookupDevice: async () => ({ deviceId: id, kind, label: 'controller', scope, capabilities, canDelegate: false, signingPublicKey: ed25519.getPublicKey(key), generation: 1, boundAt: Date.now(), expiresAt: null }),
    procedureKind: () => 'mutation',
    workspaceProject: () => 'project',
  });
  const invoke = async () => {
    const body = new TextEncoder().encode(stringify({ v: 1, path: 'environment.runPhase', input: { spaceId: 'workspace', runId: 'retire', phase: 'cloud/destroy', rerun: false } }));
    return handler(new Request('https://machine.test/rpc', { method: 'POST', body, headers: { [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: id, method: 'POST', path: '/rpc', body, signingPrivateKey: key }) } }));
  };
  expect((await invoke()).status).toBe(403);
  capabilities = ['rpc.write', 'lifecycle.control'];
  expect((await invoke()).status).toBe(204);
  scope = { kind: 'project', projectId: 'project' };
  expect((await invoke()).status).toBe(403);
  scope = { kind: 'user' };
  kind = 'browser';
  capabilities = ['rpc.write'];
  expect((await invoke()).status).toBe(204);
});

it('verifies a procedure-tagged batch the account forwards to the holder without its query', async () => {
  const key = ed25519.utils.randomSecretKey();
  const id = crypto.randomUUID();
  const handler = createSignedRpcHandler({
    handler: async () => new Response(null, { status: 204 }),
    lookupDevice: async () => ({ deviceId: id, kind: 'client', label: 'reader', scope: { kind: 'user' }, capabilities: ['rpc.read'], canDelegate: false, signingPublicKey: ed25519.getPublicKey(key), generation: 1, boundAt: Date.now(), expiresAt: null } satisfies VerifiedDevice),
    procedureKind: () => 'query',
    workspaceProject: () => 'project-a',
  });
  const signedTargets: string[] = [];
  // Like the account Worker: the untouched signed body goes to the holder's own
  // endpoint, and the target the client signed travels in a header.
  const forward = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('x-gitspace-signed-target', `${target.pathname}${target.search}`);
    signedTargets.push(`${target.pathname}${target.search}`);
    return handler(new Request('http://127.0.0.1:8081/rpc', { method: request.method, headers, body: await request.arrayBuffer() }));
  };
  const transport = createRoutedTransport({ homeUrl: 'https://tenant.gitspace.sh/rpc', fetch: createSignedRpcFetch({ deviceId: id, signingPrivateKey: key, fetch: forward as typeof fetch }) });
  const outcome = await transport.request({ v: 1, path: 'space.view', input: { projectId: 'project-a', workspaceId: 'workspace-a' } });
  expect(signedTargets).toEqual(['/rpc?p=space.view']);
  expect(outcome).toMatchObject({ ok: true, response: { status: 204 } });
});
