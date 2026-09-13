import { describe, expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createServer } from 'node:http';
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

  it('recovers a stored upload whose response connection was lost, without replaying its signature', async () => {
    const privateKey = new Uint8Array(32).fill(5);
    const nonces = new Set<string>();
    let stored: Buffer | null = null;
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.end(stored);
        return;
      }
      const signed = signedControlRequestSchema.parse(JSON.parse(Buffer.from(String(request.headers['x-gitspace-control']), 'base64url').toString()));
      if (!verifySignedControlRequest(signed, ed25519.getPublicKey(privateKey)) || nonces.has(signed.nonce)) {
        response.writeHead(403).end();
        return;
      }
      nonces.add(signed.nonce);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (stored === null) {
        stored = bytes;
        request.socket.destroy();
        return;
      }
      response.writeHead(stored.equals(bytes) ? 204 : 409).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: `http://127.0.0.1:${address.port}`,
      userId: 'user-a',
      machineId: 'machine-a',
      signingPrivateKey: privateKey,
    });
    try {
      const bytes = new Uint8Array(32_768).fill(7);
      const hash = await store.put('objects/recovered', bytes);
      expect(await store.get('objects/recovered', hash)).toEqual(bytes);
      expect(nonces.size).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('recovers temporary HTTP failures with a fresh signature for each attempt', async () => {
    const nonces = new Set<string>();
    const statuses = [503, 429, 201];
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async (_input, init) => {
        const signed = JSON.parse(Buffer.from(new Headers(init?.headers).get('x-gitspace-control')!, 'base64url').toString());
        if (nonces.has(signed.nonce)) return new Response(null, { status: 403 });
        nonces.add(signed.nonce);
        return new Response('temporary response', { status: statuses.shift()! });
      }) as typeof fetch,
    });
    const bytes = new TextEncoder().encode('retry unchanged content');
    expect(await store.put('objects/retry', bytes)).toBe(`sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`);
    expect(nonces.size).toBe(3);
  });

  it('does not retry an immutable object conflict', async () => {
    const status = 409;
    let requests = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => {
        requests += 1;
        return new Response(null, { status });
      }) as typeof fetch,
    });
    await expect(store.put('objects/rejected', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'DATA_PUT_FAILED', details: { status },
    });
    expect(requests).toBe(1);
  });

  it('surfaces bounded structured size errors without retrying permanent rejections', async () => {
    let requests = 0;
    const size = 64 * 1024 * 1024 + 1;
    const maxBytes = 64 * 1024 * 1024;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => {
        requests += 1;
        return Response.json({
          status: 'error',
          error: {
            code: 'OBJECT_TOO_LARGE', message: `Application object size ${size} bytes exceeds the maximum ${maxBytes} bytes`,
            size, maxBytes, stack: 'internal stack must not be retained', status: 503, key: 'untrusted',
          },
        }, { status: 413 });
      }) as typeof fetch,
    });
    const failure = await store.put('objects/too-large', new Uint8Array([1])).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'DATA_PUT_FAILED',
      message: expect.stringContaining(`OBJECT_TOO_LARGE: Application object size ${size} bytes exceeds the maximum ${maxBytes} bytes`),
    });
    expect(failure).toHaveProperty('details', {
      key: 'objects/too-large', status: 413, code: 'OBJECT_TOO_LARGE',
      message: `Application object size ${size} bytes exceeds the maximum ${maxBytes} bytes`, size, maxBytes,
    });
    expect(requests).toBe(1);
  });

  it('preserves body-length rejection details without retrying', async () => {
    const status = 400;
    const error = { code: 'OBJECT_BODY_LENGTH_MISMATCH', message: 'Body length does not match', size: 2, declaredSize: 1 };
    let requests = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => {
        requests += 1;
        return Response.json({ status: 'error', error }, { status });
      }) as typeof fetch,
    });
    await expect(store.put('objects/rejected', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'DATA_PUT_FAILED', message: expect.stringContaining(error.message),
      details: { ...error, key: 'objects/rejected', status },
    });
    expect(requests).toBe(1);
  });

  it.each([
    ['malformed JSON', '{'],
    ['invalid error fields', JSON.stringify({ status: 'error', error: { code: 'OBJECT_TOO_LARGE', message: 42 } })],
    ['oversized message', JSON.stringify({ status: 'error', error: { code: 'OBJECT_TOO_LARGE', message: 'x'.repeat(1_025) } })],
  ])('retains HTTP failure semantics for %s', async (_name, body) => {
    let requests = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => {
        requests += 1;
        return new Response(body, { status: 413 });
      }) as typeof fetch,
    });
    await expect(store.put('objects/rejected', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'DATA_PUT_FAILED',
      details: { key: 'objects/rejected', status: 413 },
    });
    expect(requests).toBe(1);
  });

  it.each(['1', '8193'])('bounds and cancels an oversized error stream with declared length %s', async (contentLength) => {
    let requests = 0;
    let canceled = false;
    let pulls = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => {
        requests += 1;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1_024).fill(32));
          },
          cancel() { canceled = true; },
        }), { status: 413, headers: { 'content-length': contentLength } });
      }) as typeof fetch,
    });
    await expect(store.put('objects/rejected', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'DATA_PUT_FAILED', details: { key: 'objects/rejected', status: 413 },
    });
    expect(requests).toBe(1);
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(10);
  });

  it('retains a permanent HTTP failure when reading its error body fails with a retryable transport error', async () => {
    let requests = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => {
        requests += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); },
        }), { status: 413 });
      }) as typeof fetch,
    });
    await expect(store.put('objects/rejected', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'DATA_PUT_FAILED', details: { key: 'objects/rejected', status: 413 },
    });
    expect(requests).toBe(1);
  });

  it('does not wait indefinitely for a stalled error body or its cancellation', async () => {
    let requests = 0;
    let canceled = false;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => {
        requests += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
          cancel() {
            canceled = true;
            return new Promise<void>(() => {});
          },
        }), { status: 413 });
      }) as typeof fetch,
    });
    await expect(store.put('objects/rejected', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'DATA_PUT_FAILED', details: { key: 'objects/rejected', status: 413 },
    });
    expect(requests).toBe(1);
    expect(canceled).toBe(true);
  }, 5_000);

  it('bounds transport retries and preserves the final failure', async () => {
    let requests = 0;
    const failure = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => { requests += 1; throw failure; }) as typeof fetch,
    });
    await expect(store.put('objects/unavailable', new Uint8Array([1]))).rejects.toBe(failure);
    expect(requests).toBe(5);
  }, 10_000);

  it('does not retry an explicitly aborted upload', async () => {
    let requests = 0;
    const failure = new DOMException('Canceled', 'AbortError');
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => { requests += 1; throw failure; }) as typeof fetch,
    });
    await expect(store.put('objects/canceled', new Uint8Array([1]))).rejects.toBe(failure);
    expect(requests).toBe(1);
  });
});
