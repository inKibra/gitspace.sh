import { describe, expect, it, spyOn } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createServer } from 'node:http';
import { signedControlRequestSchema, verifySignedControlRequest, type DeploymentStatus } from '@gitspace/protocol';
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

describe('canonical workspace reconciliation', () => {
  it.each(['active', 'archived'] as const)('preserves the cloud %s workspace and its metadata when the machine reconnects with stale state', async (lifecycle) => {
    const workspace = {
      id: 'space-a', projectId: 'project-a', kind: 'worktree', name: 'Cloud name', branch: 'cloud-branch',
      phase: 'review', sourceKind: 'commit', sourceRef: 'source-ref', sourceCommit: 'a'.repeat(40),
      lifecycle, goalId: 'goal-a', revision: 4, archivedAt: lifecycle === 'archived' ? '2026-09-01T00:00:00.000Z' : null,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const before = structuredClone(workspace);
    const authority = new CloudSpaceCheckpointAuthority({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async (_input, init) => {
        const request = signedControlRequestSchema.parse(JSON.parse(String(init?.body)));
        if (request.operation === 'project.bootstrap') return Response.json({ status: 'ok', value: {
          id: 'project-a', lifecycle: 'active', name: 'Cloud project', repositoryReference: 'github:owner/repo', baseBranch: 'trunk',
        } });
        if (request.operation === 'project.workspaces.list') return Response.json({ status: 'ok', value: [workspace] });
        if (request.operation === 'project.workspaces.put') {
          Object.assign(workspace, request.payload.workspace);
          return Response.json({ status: 'ok', value: workspace });
        }
        throw new Error(`Unexpected operation: ${request.operation}`);
      }) as typeof fetch,
    });
    const reconciled = await authority.putSpaceDefinition({
      projectId: 'project-a', projectName: 'Project', repositoryReference: null, baseBranch: 'main',
      spaceId: 'space-a', kind: 'worktree', name: 'Stale name', branch: 'stale-branch', phase: 'code',
    });
    expect(reconciled).toMatchObject({
      projectName: 'Cloud project', repositoryReference: 'github:owner/repo', baseBranch: 'trunk',
      name: 'Cloud name', branch: 'cloud-branch', phase: 'review',
    });
    expect(workspace).toEqual(before);
  });
});

describe('interrupted release acknowledgement', () => {
  it.each(['applied', 'wrong-worker', 'partial-selection', 'failed'] as const)('reconciles a lost response only for a confirmed release: %s', async (outcome) => {
    const sha = 'release-after-worker-swap';
    const status: DeploymentStatus = {
      desired: { worker: sha, machine: outcome === 'partial-selection' ? null : sha, omp: null, frontend: null, updatedAt: new Date().toISOString() },
      current: { worker: { sha: outcome === 'wrong-worker' ? 'previous' : sha, version: sha }, machines: {} },
      releases: [{
        sha, label: sha, workspaceId: 'space-a', builtBy: 'machine-a', createdAt: new Date().toISOString(),
        artifacts: { worker: null, machine: null, omp: null, frontend: null }, worker: null, omp: null,
        status: { worker: outcome === 'failed' ? 'failed' : 'applied', frontend: 'skipped', machines: {}, omps: {} },
        error: outcome === 'failed' ? 'Worker health check failed' : null,
      }],
    };
    let mutations = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const signed = signedControlRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      if (signed.operation === 'deploy.launch') {
        mutations++;
        request.socket.destroy();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', value: status }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const authority = new CloudSpaceCheckpointAuthority({
      baseUrl: `http://127.0.0.1:${address.port}`, userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
    });
    try {
      const launched = authority.launchRelease(sha, ['worker', 'machine']);
      if (outcome === 'applied') {
        expect(await launched).toMatchObject({ record: { sha, status: { worker: 'applied' } }, desired: { worker: sha, machine: sha } });
      } else {
        await expect(launched).rejects.toThrow();
      }
      expect(mutations).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('cloud application data store', () => {
  it('reuses persisted bytes across store instances with authenticated metadata and verifies downloads', async () => {
    const privateKey = new Uint8Array(32).fill(5);
    const objects = new Map<string, Uint8Array>();
    const operations: string[] = [];
    const options = {
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
        if (init?.method === 'HEAD') {
          const stored = objects.get(key);
          expect(signed.operation).toBe('data.head');
          expect(signed.payload).toEqual({
            key,
            hash: `sha256:${new Bun.CryptoHasher('sha256').update(new TextEncoder().encode('agent-state')).digest('hex')}`,
          });
          return new Response(null, stored ? { status: 200, headers: {
            'x-gitspace-sha256': `sha256:${new Bun.CryptoHasher('sha256').update(stored).digest('hex')}`,
            'content-length': String(stored.byteLength),
          } } : { status: 404 });
        }
        if (init?.method === 'PUT') {
          objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer()));
          return new Response(null, { status: 201 });
        }
        const bytes = objects.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      }) as typeof fetch,
    };
    const store = new CloudDataCheckpointBlobStore(options);
    const bytes = new TextEncoder().encode('agent-state');
    const hash = await store.put('projects/project-a/state.bin', bytes);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await store.get('projects/project-a/state.bin', hash)).toEqual(bytes);
    expect(await new CloudDataCheckpointBlobStore(options).put('projects/project-a/state.bin', bytes)).toBe(hash);
    expect(operations).toEqual(['data.head', 'data.put', 'data.get', 'data.head']);
  });

  it('retains bounded server download errors and safe request correlation in release-report messages', async () => {
    const key = 'releases/native/machine.manifest.json';
    const cfRay = 'a123456789abcdef-SJC';
    let requestId = '';
    let signedHeader = '';
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async (_input, init) => {
        signedHeader = new Headers(init?.headers).get('x-gitspace-control')!;
        requestId = JSON.parse(Buffer.from(signedHeader, 'base64url').toString()).nonce;
        return Response.json({
          status: 'error',
          error: { code: 'BAD_REQUEST', message: 'Application object request is invalid', authorization: signedHeader, stack: 'private stack' },
        }, { status: 400, headers: { 'cf-ray': cfRay, 'set-cookie': 'secret-cookie' } });
      }) as typeof fetch,
    });
    const failure = await store.get(key).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'DATA_GET_FAILED',
      details: { key, status: 400, code: 'BAD_REQUEST', message: 'Application object request is invalid', machineId: 'machine-a', operation: 'data.get', requestId, cfRay },
    });
    // Release acknowledgement retains Error.message, not the structured details.
    const message = (failure as Error).message;
    for (const context of [key, '400', 'BAD_REQUEST', 'Application object request is invalid', 'machine-a', 'data.get', requestId, cfRay]) {
      expect(message).toContain(context);
    }
    const diagnostic = JSON.stringify(failure);
    for (const secret of [signedHeader, 'private stack', 'secret-cookie']) {
      expect(diagnostic).not.toContain(secret);
      expect(message).not.toContain(secret);
    }
  });

  it('retains HTTP download failures without retaining oversized bodies or untrusted ray headers', async () => {
    let canceled = false;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new TextEncoder().encode('private-response'.repeat(1_000))); },
        cancel() { canceled = true; },
      }), { status: 400, headers: { 'cf-ray': 'secret-token' } })) as typeof fetch,
    });
    const failure = await store.get('releases/native/machine.manifest.json').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'DATA_GET_FAILED', details: { status: 400, operation: 'data.get' } });
    expect(canceled).toBe(true);
    for (const secret of ['private-response', 'secret-token']) {
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect((failure as Error).message).not.toContain(secret);
    }
  });

  it('recovers a stored upload whose response connection was lost, without replaying its signature', async () => {
    const privateKey = new Uint8Array(32).fill(5);
    const nonces = new Set<string>();
    let stored: Buffer | null = null;
    let uploadsReceived = 0;
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
      if (request.method === 'HEAD') {
        if (signed.operation !== 'data.head') { response.writeHead(403).end(); return; }
        response.writeHead(stored ? 200 : 404, stored ? {
          'x-gitspace-sha256': `sha256:${new Bun.CryptoHasher('sha256').update(stored).digest('hex')}`,
          'content-length': String(stored.byteLength),
        } : {}).end();
        return;
      }
      uploadsReceived++;
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
    const records: Record<string, unknown>[] = [];
    const capture = (line: unknown) => { records.push(JSON.parse(String(line))); };
    const info = spyOn(console, 'info').mockImplementation(capture);
    const error = spyOn(console, 'error').mockImplementation(capture);
    try {
      const bytes = new Uint8Array(32_768).fill(7);
      const hash = await store.put('objects/recovered', bytes);
      expect(await store.get('objects/recovered', hash)).toEqual(bytes);
      expect(nonces.size).toBe(3);
      expect(uploadsReceived).toBe(1);
      const uploads = records.filter((record) => record.operation === 'data.put' || record.operation === 'data.head');
      const failed = uploads.find((record) => record.operation === 'data.put' && record.outcome === 'failure')!;
      const completed = uploads.find((record) => record.operation === 'data.head' && record.attempt === 2 && record.outcome === 'success')!;
      expect(failed).toMatchObject({ attempt: 1, stage: 'before-headers' });
      expect(completed).toMatchObject({ attempt: 2, stage: 'complete' });
      expect(new Set(uploads.map((record) => record.uploadId)).size).toBe(1);
      for (const record of uploads) {
        expect(record).toMatchObject({
          objectKey: 'objects/recovered', byteCount: bytes.byteLength, maxAttempts: 10,
          targetOrigin: `http://127.0.0.1:${address.port}`,
        });
      }
      expect(failed.elapsedMs).toBeGreaterThan(0);
      expect(failed.responseHeadersMs).toBeUndefined();
      expect(completed.responseHeadersMs).toBeGreaterThanOrEqual(0);
      expect(completed.responseHeadersMs).toBeLessThanOrEqual(completed.elapsedMs);
      expect(completed.status).toBe(200);
    } finally {
      info.mockRestore();
      error.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['success', 'exhausted'] as const)('retries temporary PUT failures through the tenth cycle: %s', async (outcome) => {
    const nonces = new Set<string>();
    let puts = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async (_input, init) => {
        const signed = JSON.parse(Buffer.from(new Headers(init?.headers).get('x-gitspace-control')!, 'base64url').toString());
        if (nonces.has(signed.nonce)) return new Response(null, { status: 403 });
        nonces.add(signed.nonce);
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
        puts++;
        return new Response(null, { status: puts < 10 ? 503 : outcome === 'success' ? 201 : 429 });
      }) as typeof fetch,
    });
    const bytes = new TextEncoder().encode('retry unchanged content');
    const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    try {
      const pending = store.put('objects/retry', bytes);
      if (outcome === 'success') {
        expect(await pending).toBe(`sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`);
      } else {
        await expect(pending).rejects.toMatchObject({ code: 'DATA_PUT_FAILED', details: { status: 429 } });
      }
      expect(puts).toBe(10);
      expect(nonces.size).toBe(20);
      expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000]);
    } finally { sleep.mockRestore(); }
  });

  it('does not retry an immutable object conflict', async () => {
    const status = 409;
    let requests = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async (_input, init) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
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
      fetcher: (async (_input, init) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
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
      fetcher: (async (_input, init) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
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
      fetcher: (async (_input, init) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
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
      fetcher: (async (_input, init) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
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
      fetcher: (async (_input, init) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
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
      fetcher: (async (_input, init) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 404 });
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

  it.each(['hash', 'length', 'missing hash', 'missing length'] as const)(
    'refuses existing objects with %s metadata without overwriting them',
    async (fault) => {
      const bytes = new Uint8Array([1, 2]);
      const hash = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
      const headers = new Headers({ 'x-gitspace-sha256': hash, 'content-length': '2' });
      if (fault === 'hash') headers.set('x-gitspace-sha256', `sha256:${'0'.repeat(64)}`);
      if (fault === 'length') headers.set('content-length', '3');
      if (fault === 'missing hash') headers.delete('x-gitspace-sha256');
      if (fault === 'missing length') headers.delete('content-length');
      const methods: string[] = [];
      const store = new CloudDataCheckpointBlobStore({
        baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
        signingPrivateKey: new Uint8Array(32).fill(5),
        fetcher: (async (_input, init) => {
          methods.push(init!.method!);
          return new Response(null, { status: 200, headers });
        }) as typeof fetch,
      });
      await expect(store.put('objects/existing', bytes)).rejects.toMatchObject({ code: 'DATA_INTEGRITY_FAILED' });
      expect(methods).toEqual(['HEAD']);
    },
  );

  it.each(['success', 'exhausted'] as const)('bounds transient HEAD failures through the tenth cycle: %s', async (outcome) => {
    const privateKey = new Uint8Array(32).fill(5);
    const nonces = new Set<string>();
    let heads = 0;
    let puts = 0;
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: privateKey,
      fetcher: (async (_input, init) => {
        const signed = signedControlRequestSchema.parse(JSON.parse(Buffer.from(new Headers(init?.headers).get('x-gitspace-control')!, 'base64url').toString()));
        if (!verifySignedControlRequest(signed, ed25519.getPublicKey(privateKey)) || nonces.has(signed.nonce)) {
          return new Response(null, { status: 403 });
        }
        nonces.add(signed.nonce);
        if (init?.method === 'HEAD') {
          expect(signed.operation).toBe('data.head');
          heads++;
          return new Response(null, { status: heads < 10 ? 503 : outcome === 'success' ? 404 : 429 });
        }
        puts++;
        return new Response(null, { status: 201 });
      }) as typeof fetch,
    });
    const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    try {
      const bytes = new Uint8Array([1]);
      const pending = store.put('objects/retry-head', bytes);
      if (outcome === 'success') {
        expect(await pending).toBe(`sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`);
      } else {
        await expect(pending).rejects.toMatchObject({ code: 'DATA_HEAD_FAILED', details: { status: 429 } });
      }
      expect(heads).toBe(10);
      expect(puts).toBe(outcome === 'success' ? 1 : 0);
      expect(nonces.size).toBe(heads + puts);
    } finally { sleep.mockRestore(); }
  });

  it('bounds transport retries and preserves the final failure', async () => {
    let requests = 0;
    const failure = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    const store = new CloudDataCheckpointBlobStore({
      baseUrl: 'https://control.example', userId: 'user-a', machineId: 'machine-a',
      signingPrivateKey: new Uint8Array(32).fill(5),
      fetcher: (async () => { requests += 1; throw failure; }) as typeof fetch,
    });
    const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    try {
      await expect(store.put('objects/unavailable', new Uint8Array([1]))).rejects.toBe(failure);
      expect(requests).toBe(10);
    } finally { sleep.mockRestore(); }
  });

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
