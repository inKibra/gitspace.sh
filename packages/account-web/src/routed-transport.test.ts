import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { gitspaceContract, rpcErrors, type SpacePlacementView } from '@gitspace/protocol/rpc-contract';
import { decodeTranscriptChunks, encodeTranscriptEventChunks, type TranscriptChunk, type TranscriptEvent } from '@gitspace/protocol/transcript';
import { contractDigest, deserialize, serialize } from 'result-rpc';
import { batchFetchTransport, createBrowserClient, isCancelled } from 'result-rpc/client';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

it('lets project creation finish after ordinary machine queries time out', async () => {
  vi.useFakeTimers();
  let finishCreation: ((response: Response) => void) | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const decoded = deserialize(await request.text());
    if (!decoded.ok) throw new Error('Invalid request envelope');
    const envelope = decoded.value as { path?: string };
    return new Promise<Response>((resolve, reject) => {
      if (envelope.path === 'project.create') finishCreation = resolve;
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  }) as typeof fetch;
  const transport = createRoutedTransport({ homeUrl: 'https://account.test/rpc', fetch: fetcher });
  let creationSettled = false;
  const creation = transport.request({ v: 1, path: 'project.create', input: { name: 'slow-repository', baseBranch: 'main', repositoryUrl: null } })
    .then((outcome) => { creationSettled = true; return outcome; });
  const query = transport.request({ v: 1, path: 'placements', input: {} });

  await vi.advanceTimersByTimeAsync(31_000);
  expect(await query).toMatchObject({ ok: false, reason: 'timeout' });
  expect(creationSettled).toBe(false);
  if (!finishCreation) throw new Error('Project creation did not reach the server');
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

it('routes concurrent callers with the refreshed table when an invalidated read finishes last', async () => {
  const pending: Array<{ resolve: (response: Response) => void; id: string }> = [];
  const reached: string[] = [];
  const placement = (endpoint: string): SpacePlacementView => ({
    spaceId: 'space', projectId: 'project', kind: 'worktree', holderId: 'remote', state: 'open', generation: 1, endpoint,
  });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const decoded = deserialize(await request.text());
    if (!decoded.ok) throw new Error('Invalid envelope');
    const envelope = decoded.value as { batch: Array<{ id: string; path: string }> };
    if (envelope.batch[0]?.path === 'placements') return new Promise<Response>((resolve) => {
      pending.push({ resolve, id: envelope.batch[0]!.id });
    });
    reached.push(request.url);
    return new Response('reached');
  }) as typeof fetch;
  const transport = createRoutedTransport({ homeUrl: 'https://account.test/rpc', fetch: fetcher });
  const first = transport.request({ v: 1, path: 'bootstrap', input: { projectId: 'project', workspaceId: 'space' } });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  transport.invalidate();
  const second = transport.request({ v: 1, path: 'bootstrap', input: { projectId: 'project', workspaceId: 'space' } });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  const respond = (index: number, endpoint: string) => pending[index]!.resolve(new Response(encoded({
    v: 1, batch: [{ id: pending[index]!.id, status: 200, response: { v: 1, status: 'ok', value: { machineId: 'home', spaces: [placement(endpoint)] } } }],
  }), { headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-result-rpc-contract': contractDigest(gitspaceContract) } }));
  respond(1, 'https://new.test/rpc');
  await second;
  respond(0, 'https://old.test/rpc');
  await first;
  expect(reached).toEqual(['https://new.test/rpc', 'https://new.test/rpc']);
  expect((await transport.placements()).space?.endpoint).toBe('https://new.test/rpc');
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
    client.bootstrap({ projectId: 'project', workspaceId: null }),
  ]);
  for await (const result of client.transcript({ projectId: 'project', workspaceId: null })) results.push(result);
  expect(received[0]?.batch?.map((item) => item.path)).toEqual(['session.control', 'bootstrap']);
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
