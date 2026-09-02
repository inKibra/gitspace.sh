import { describe, expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { signedControlRequestSchema, verifySignedControlRequest } from '@gitspace/protocol';
import { CloudDataCheckpointBlobStore, CloudSpaceCheckpointAuthority } from '../src/cloud-space-authority.js';

it('signs each space authority operation with the enrolled machine key', async () => {
  const privateKey = new Uint8Array(32).fill(5);
  const requests: unknown[] = [];
  const authority = new CloudSpaceCheckpointAuthority({
    baseUrl: 'https://control.example',
    userId: 'user-a',
    machineId: 'machine-a',
    signingPrivateKey: privateKey,
    fetcher: (async (input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'ok', value: { revision: 2, previousRevision: 1 } });
    }) as typeof fetch,
  });
  expect(await authority.beginClose({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 3 })).toEqual({ revision: 2, previousRevision: 1 });
  const request = signedControlRequestSchema.parse(requests[0]);
  expect(request.operation).toBe('space.beginClose');
  expect(request.payload).toMatchObject({ projectId: 'project-a', spaceId: 'space-a', expectedGeneration: 3 });
  expect(verifySignedControlRequest(request, ed25519.getPublicKey(privateKey))).toBe(true);
});

describe('cloud application data store', () => {
  it('signs raw object uploads and verifies downloaded content', async () => {
    const privateKey = new Uint8Array(32).fill(5);
    const objects = new Map<string, Uint8Array>();
    const operations: string[] = [];
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example',
      userId: 'user-a',
      machineId: 'machine-a',
      signingPrivateKey: privateKey,
      fetcher: (async (input, init) => {
        const encoded = new Headers(init?.headers).get('x-gitspace-control')!;
        const signed = signedControlRequestSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString()));
        expect(verifySignedControlRequest(signed, ed25519.getPublicKey(privateKey))).toBe(true);
        operations.push(signed.operation);
        const key = new URL(String(input)).pathname.replace('/v1/data/', '');
        if (init?.method === 'PUT') {
          objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer()));
          return new Response(null, { status: 201 });
        }
        const bytes = objects.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      }) as typeof fetch,
    });
    const bytes = new TextEncoder().encode('agent-state');
    const hash = await store.put('projects/project-a/state.bin', bytes);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await store.get('projects/project-a/state.bin', hash)).toEqual(bytes);
    expect(operations).toEqual(['data.put', 'data.get']);
  });
});
