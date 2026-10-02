import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { gitspaceContract, rpcErrors } from '@gitspace/protocol/rpc-contract';
import { decodeTranscriptChunks, encodeTranscriptEventChunks, type TranscriptChunk, type TranscriptEvent } from '@gitspace/protocol/transcript';
import { contractDigest, deserialize, serialize } from 'result-rpc';
import { batchFetchTransport, createBrowserClient, isCancelled } from 'result-rpc/client';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

afterEach(() => vi.useRealTimers());

it.each([
  { path: 'project.create', input: { name: 'slow-repository', baseBranch: 'main', repositoryUrl: null } },
  { path: 'machine.createSandbox', input: {} },
  { path: 'machine.resume', input: { machineId: 'sandbox-proof' } },
  { path: 'machine.sleep', input: { machineId: 'sandbox-proof' } },
  { path: 'machine.destroy', input: { machineId: 'sandbox-proof' } },
  { path: 'machine.image.set', input: { machineId: 'sandbox-proof', operationId: '11111111-1111-4111-8111-111111111111', selection: { kind: 'platform-default' } } },
])('lets $path finish after ordinary machine queries time out', async ({ path, input }) => {
  vi.useFakeTimers();
  let finishCreation: ((response: Response) => void) | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const decoded = deserialize(await request.text());
    if (!decoded.ok) throw new Error('Invalid request envelope');
    const envelope = decoded.value as { path?: string };
    return new Promise<Response>((resolve, reject) => {
      if (envelope.path === path) finishCreation = resolve;
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  }) as typeof fetch;
  const transport = createRoutedTransport({ homeUrl: 'https://account.test/rpc', fetch: fetcher });
  let creationSettled = false;
  const creation = transport.request({ v: 1, path, input })
    .then((outcome) => { creationSettled = true; return outcome; });
  const query = transport.request({ v: 1, path: 'placements', input: {} });

  await vi.advanceTimersByTimeAsync(31_000);
  expect(await query).toMatchObject({ ok: false, reason: 'timeout' });
  expect(creationSettled).toBe(false);
  if (!finishCreation) throw new Error('Provisioning did not reach the server');
  finishCreation(new Response('completed'));
  expect((await creation).ok).toBe(true);
});

function encoded(value: unknown): string {
  const result = serialize(value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

const streamContentType = 'application/result-rpc-stream+devalue; sv=1';
const transcriptEvent: TranscriptEvent = {
  sessionId: 'session', ordinal: 1, kind: 'message',
  payload: { text: 'a😀\n'.repeat(300_000) }, createdAt: new Date('2026-01-01T00:00:00Z'),
};

function transcriptFrames(event: TranscriptEvent): string[] {
  const frames = [...encodeTranscriptEventChunks(event)].map((chunk, seq) =>
    encoded({ v: 1, seq, done: false, response: { v: 1, status: 'ok', value: chunk } }) + '\n');
  frames.push(encoded({ v: 1, seq: frames.length, done: true }) + '\n');
  return frames;
}

function transcriptClient(body: ReadableStream<Uint8Array>) {
  return createBrowserClient({
    contract: gitspaceContract,
    transport: createRoutedTransport({
      homeUrl: 'https://account.test/rpc',
      fetch: (async () => new Response(body, { headers: { 'content-type': streamContentType, 'x-result-rpc-contract': contractDigest(gitspaceContract) } })) as typeof fetch,
    }),
  });
}

it('decodes complete transcript events when HTTP coalesces over a MiB of valid frames', async () => {
  const bytes = new TextEncoder().encode(transcriptFrames(transcriptEvent).join(''));
  expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
  const client = transcriptClient(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
  async function* chunks(): AsyncGenerator<TranscriptChunk> {
    for await (const result of client.inspector.transcript({ projectId: 'project', workspaceId: null })) {
      if (result.status === 'error') throw result.error;
      yield result.value;
    }
  }
  const events: TranscriptEvent[] = [];
  for await (const event of decodeTranscriptChunks(chunks())) events.push(event);
  expect(events).toEqual([transcriptEvent]);
});

it('reports a missing terminal frame as an interrupted transport instead of completing history', async () => {
  const frames = transcriptFrames({ ...transcriptEvent, payload: { text: 'incomplete stream' } });
  frames.pop();
  const client = transcriptClient(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames.join(''))); controller.close();
  } }));
  const results = [];
  for await (const result of client.inspector.transcript({ projectId: 'project', workspaceId: null })) results.push(result);
  expect(results.at(-1)).toMatchObject({ status: 'error', error: { _tag: 'client/network-failure' } });
});

it.each([true, false])('rejects a single oversized frame (newline complete: %s)', async (complete) => {
  const frame = encoded({ v: 1, seq: 0, done: false, response: { v: 1, status: 'ok', value: { data: 'x'.repeat(1024 * 1024), complete: true } } });
  const client = transcriptClient(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame + (complete ? '\n' : ''))); controller.close();
  } }));
  const results = [];
  for await (const result of client.inspector.transcript({ projectId: 'project', workspaceId: null })) results.push(result);
  expect(results).toMatchObject([{ status: 'error', error: { _tag: 'client/protocol-violation' } }]);
});

it('retains terminal server errors and cancels a caller-detached stream', async () => {
  const failure = rpcErrors.operationFailed({ operation: 'read saved Inspector transcript', message: 'Checkpoint unavailable' });
  const client = transcriptClient(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(encoded({ v: 1, seq: 0, done: false, response: { v: 1, status: 'error', error: failure.toJSON() } }) + '\n'));
    controller.close();
  } }));
  const results = [];
  for await (const result of client.inspector.transcript({ projectId: 'project', workspaceId: null })) results.push(result);
  expect(results).toMatchObject([{ status: 'error', error: { _tag: failure._tag, data: failure.data } }]);

  const cancelledBody = vi.fn();
  const reading = Promise.withResolvers<void>();
  const waiting = transcriptClient(new ReadableStream({ pull() { reading.resolve(); }, cancel: cancelledBody }, { highWaterMark: 0 }));
  const controller = new AbortController();
  const iterator = waiting.inspector.transcript({ projectId: 'project', workspaceId: null }, { signal: controller.signal })[Symbol.asyncIterator]();
  const next = iterator.next();
  await reading.promise;
  controller.abort();
  await expect(next.catch(isCancelled)).resolves.toBe(true);
  expect(cancelledBody).toHaveBeenCalledOnce();
});

const batchSchema = z.object({ batch: z.array(z.object({ path: z.string() })) });

it('sends machine work for each space or session in its own tagged batch to the account endpoint', async () => {
  const requests: Array<{ url: string; paths: string[] }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const decoded = deserialize(await request.text());
    if (!decoded.ok) throw new Error('Invalid envelope');
    requests.push({ url: request.url, paths: batchSchema.parse(decoded.value).batch.map((item) => item.path) });
    return new Response('reached');
  }) as typeof fetch;
  const transport = createRoutedTransport({ homeUrl: 'https://account.test/rpc', fetch: fetcher });
  await Promise.all([
    transport.request({ v: 1, path: 'space.view', input: { projectId: 'project', workspaceId: 'space-a' } }),
    transport.request({ v: 1, path: 'space.view', input: { projectId: 'project', workspaceId: 'space-b' } }),
    transport.request({ v: 1, path: 'transcriptPage', input: { projectId: 'project', workspaceId: 'space-a' } }),
    transport.request({ v: 1, path: 'session.control', input: { sessionId: 'session-a' } }),
  ]);
  expect(requests).toHaveLength(3);
  expect(requests).toEqual(expect.arrayContaining([
    { url: 'https://account.test/rpc?p=space.view,transcriptPage', paths: ['space.view', 'transcriptPage'] },
    { url: 'https://account.test/rpc?p=space.view', paths: ['space.view'] },
    { url: 'https://account.test/rpc?p=session.control', paths: ['session.control'] },
  ]));
});

it('bounds the procedure tag and counts the procedures it omits', async () => {
  const urls: string[] = [];
  const transport = createRoutedTransport({ homeUrl: '/rpc', fetch: (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response('reached'); }) as typeof fetch });
  const paths = Array.from({ length: 32 }, (_, index) => `procedure.with.a.deliberately.long.name.${index}`);
  await Promise.all(paths.map((path) => transport.request({ v: 1, path, input: {} })));
  expect(urls).toHaveLength(1);
  const tag = new URL(urls[0]!, 'https://account.test').searchParams.get('p') ?? '';
  expect(tag.length).toBeLessThanOrEqual(512);
  const named = tag.split(',');
  const omitted = Number(/^(\d+)-more$/u.exec(named.pop() ?? '')?.[1]);
  expect(named).toEqual(paths.slice(0, paths.length - omitted));
});

it.each([
  { status: 502, body: { error: { code: 'TUNNEL_TRANSPORT_FAILED', message: 'Machine disconnected (1006: WebSocket disconnected without sending Close frame.). The remote outcome may be unknown; refresh workspace state before retrying.' } } },
  { status: 503, body: { status: 'error', error: { code: 'FLEET_OFFLINE', message: 'Every account machine is offline' } } },
])('preserves a gateway $status without a contract header for batched controls and transcript streams', async ({ status, body }) => {
  const received: Array<{ batch?: Array<{ path: string }>; path?: string }> = [];
  const client = createBrowserClient({
    contract: gitspaceContract,
    transport: batchFetchTransport({
      url: 'https://account.test/rpc',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const decoded = deserialize(await request.text());
        if (!decoded.ok) throw new Error('Invalid request envelope');
        received.push(decoded.value as typeof received[number]);
        return Response.json(body, { status });
      }) as typeof fetch,
    }),
  });
  const results: unknown[] = await Promise.all([
    client.session.control({ sessionId: 'running' }),
    client.space.view({ projectId: 'project', workspaceId: null }),
  ]);
  for await (const result of client.transcript({ projectId: 'project', workspaceId: null })) results.push(result);
  expect(received[0]?.batch?.map((item) => item.path)).toEqual(['session.control', 'space.view']);
  expect(results).toMatchObject(Array.from({ length: 3 }, () => ({ status: 'error', error: { _tag: 'client/http-failure', data: { status } } })));
});

it('still rejects a successful RPC response that omits the contract header', async () => {
  const client = createBrowserClient({
    contract: gitspaceContract,
    transport: batchFetchTransport({
      url: 'https://account.test/rpc',
      fetch: (async () => new Response(encoded({ v: 1, status: 'ok', value: { machineId: '', spaces: [] } }), {
        headers: { 'content-type': 'application/result-rpc+devalue; sv=1' },
      })) as typeof fetch,
    }),
  });
  expect(await client.placements({})).toMatchObject({ status: 'error', error: { _tag: 'client/protocol-violation', data: { reason: 'version' } } });
});

it('still rejects a successful transcript stream that omits the contract header', async () => {
  const client = createBrowserClient({
    contract: gitspaceContract,
    transport: batchFetchTransport({
      url: 'https://account.test/rpc',
      fetch: (async () => new Response(encoded({ v: 1, seq: 0, done: true }) + '\n', {
        headers: { 'content-type': streamContentType },
      })) as typeof fetch,
    }),
  });
  const results = [];
  for await (const result of client.transcript({ projectId: 'project', workspaceId: null })) results.push(result);
  expect(results).toMatchObject([{ status: 'error', error: { _tag: 'client/protocol-violation', data: { reason: 'version' } } }]);
});
