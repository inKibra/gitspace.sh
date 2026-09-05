import { expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { stringify } from 'devalue';
import { RPC_DEVICE_HEADER, signRpcRequest, type DeviceScope, type VerifiedDevice } from '@gitspace/protocol';
import { createSignedRpcHandler } from '../src/signed-rpc.js';

it('authorizes environment mutations against the scope being changed, not just the selected workspace', async () => {
  const key = ed25519.utils.randomSecretKey();
  const id = crypto.randomUUID();
  let scope: DeviceScope = { kind: 'workspace', workspaceId: 'own' };
  const handler = createSignedRpcHandler({
    handler: async () => new Response(null, { status: 204 }),
    lookupDevice: async () => ({ deviceId: id, kind: 'client', label: 'scoped', scope, capabilities: ['rpc.write'], canDelegate: false, signingPublicKey: ed25519.getPublicKey(key), generation: 1, boundAt: Date.now(), expiresAt: null } satisfies VerifiedDevice),
    procedureKind: () => 'mutation',
    workspaceProject: workspace => workspace === 'own' ? 'project-a' : 'project-b',
  });
  const invoke = async (path: string, input: Record<string, unknown>) => {
    const body = new TextEncoder().encode(stringify({ v: 1, path, input }));
    return handler(new Request('https://machine.test/rpc', { method: 'POST', body, headers: { [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: id, method: 'POST', path: '/rpc', body, signingPrivateKey: key }) } }));
  };
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'workspace', name: 'X', value: 'one' })).status).toBe(204);
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'global', name: 'X', value: 'one' })).status).toBe(403);
  expect((await invoke('environment.approve', { spaceId: 'own', scope: 'project', executionHash: 'hash' })).status).toBe(403);
  scope = { kind: 'project', projectId: 'project-a' };
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'project', name: 'X', value: 'one' })).status).toBe(204);
  expect((await invoke('workspace.bootstrap', { projectId: 'project-a', workspaceId: 'foreign' })).status).toBe(403);
  scope = { kind: 'user' };
  expect((await invoke('environment.putValue', { spaceId: 'own', scope: 'global', name: 'X', value: 'one' })).status).toBe(204);
});
