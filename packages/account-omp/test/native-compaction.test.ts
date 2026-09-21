import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Model, ProviderSessionState } from '@oh-my-pi/pi-ai';
import type * as NativeV1 from '@oh-my-pi/pi-agent-core/compaction/openai';
import type * as NativeV2 from '@oh-my-pi/pi-agent-core/compaction/compaction-v2-streaming';
import type * as Codex from '@oh-my-pi/pi-ai/providers/openai-codex-responses';
import type * as Errors from '@oh-my-pi/pi-ai/error';
import type * as Catalog from '@oh-my-pi/pi-catalog/models';

// Runtime-selected module roots let this exercise an isolated patched install,
// not whichever SDK the repository or a running runtime cache currently resolves.
const sdkRoot = process.env.GITSPACE_NATIVE_COMPACTION_SDK_ROOT;
const modulePath = (packageName: string, source: string, specifier: string) =>
  sdkRoot ? pathToFileURL(join(sdkRoot, packageName, 'src', source)).href : specifier;
const { requestOpenAiRemoteCompaction }: typeof NativeV1 =
  await import(modulePath('pi-agent-core', 'compaction/openai.ts', '@oh-my-pi/pi-agent-core/compaction/openai'));
const { requestCompactionV2Streaming }: typeof NativeV2 =
  await import(modulePath('pi-agent-core', 'compaction/compaction-v2-streaming.ts', '@oh-my-pi/pi-agent-core/compaction/compaction-v2-streaming'));
const { openCodexCompactionEventStream, CodexWebSocketTransportError }: typeof Codex =
  await import(modulePath('pi-ai', 'providers/openai-codex-responses.ts', '@oh-my-pi/pi-ai/providers/openai-codex-responses'));
const AIError: typeof Errors =
  await import(modulePath('pi-ai', 'error/index.ts', '@oh-my-pi/pi-ai/error'));
const { getBundledModels }: typeof Catalog =
  await import(modulePath('pi-catalog', 'models.ts', '@oh-my-pi/pi-catalog/models'));

const bundled = getBundledModels('openai-codex').find(
  (model): model is Model<'openai-codex-responses'> => model.api === 'openai-codex-responses',
);
if (!bundled) throw new Error('No bundled Codex model for native compaction regression');
const model: Model<'openai-codex-responses'> = {
  ...bundled,
  baseUrl: 'https://compaction.invalid/backend-api/codex',
  remoteCompaction: undefined,
  preferWebsockets: true,
};
const compactionItem = { type: 'compaction', encrypted_content: 'compacted-history' };
const completedEvents = [
  { type: 'response.output_item.done', item: compactionItem },
  { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
];
const request = { body: { model: model.id }, input: [], retainedMessageBudget: 64_000, sessionId: 'native-regression' };

/** Advance actual SDK deadline/watchdog callbacks, not six minutes of wall time. */
class Clock {
  reasons: DOMException[] = [];
  private abortSpy = spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => {
      const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      this.reasons.push(reason);
      controller.abort(reason);
    }, delay);
    return controller.signal;
  });

  constructor() {
    vi.useFakeTimers({ now: 1_000_000 });
  }

  async settle() {
    // Drain the nested async generators without advancing the virtual clock.
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
  }

  async advance(delay: number) {
    await this.settle();
    vi.advanceTimersByTime(delay);
    await this.settle();
  }

  restore() {
    this.abortSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

/** Socket boundary double; request routing, buffering, watchdogs and retries stay real. */
class Socket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: Socket[] = [];
  static autoOpen = true;
  static created = Promise.withResolvers<Socket>();
  static sent = Promise.withResolvers<Socket>();
  static respond: (socket: Socket) => void = () => {};
  readyState = Socket.CONNECTING;
  binaryType = 'nodebuffer';
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(_url: string, _options: unknown) {
    super();
    Socket.instances.push(this);
    Socket.created.resolve(this);
    if (Socket.autoOpen) queueMicrotask(() => this.open());
  }
  open() {
    if (this.readyState !== Socket.CONNECTING) return;
    this.readyState = Socket.OPEN;
    this.onopen?.(new Event('open'));
  }
  send(_payload: string) {
    Socket.sent.resolve(this);
    Socket.respond(this);
  }
  emit(event: Record<string, unknown>) {
    if (this.readyState === Socket.OPEN) this.onmessage?.({ data: JSON.stringify(event) });
  }
  complete() {
    for (const event of completedEvents) this.emit(event);
  }
  ping() { this.dispatchEvent(new Event('pong')); }
  close(code = 1000) {
    if (this.readyState === Socket.CLOSED) return;
    this.readyState = Socket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code }));
  }
}

let clock: Clock;
let fetches: number;
let state: Map<string, ProviderSessionState>;
const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
const options = () => ({
  apiKey: 'fixture-key', sessionId: request.sessionId, providerSessionState: state, preferWebsockets: true,
  fetch: async () => {
    fetches++;
    return new Response(completedEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});
const nativeV2 = (signal?: AbortSignal) => requestCompactionV2Streaming(model, 'fixture-key', request, signal, {
  ...options(), retryWait: async () => {},
});
async function drain(events: AsyncIterable<Record<string, unknown>>) {
  const result: Record<string, unknown>[] = [];
  for await (const event of events) result.push(event);
  return result;
}

beforeEach(() => {
  clock = new Clock();
  fetches = 0;
  state = new Map();
  Socket.instances = [];
  Socket.autoOpen = true;
  Socket.created = Promise.withResolvers<Socket>();
  Socket.sent = Promise.withResolvers<Socket>();
  Socket.respond = () => {};
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
});
afterEach(async () => {
  for (const socket of Socket.instances) socket.close();
  await clock.settle();
  clock.restore();
  if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
});

// Maintained patches are runtime-recipe inputs, not necessarily applied to repo node_modules.
// Only the explicit isolated SDK root is evidence for this integration contract.
describe.skipIf(!sdkRoot)('native compaction deadlines and cancellation', () => {
  it('allows a V1 response after the former 180s deadline', async () => {
    const pending = requestOpenAiRemoteCompaction(model, 'fixture-key', [], '', undefined, {
      fetch: async (_url, init) => {
        const response = Promise.withResolvers<Response>();
        const signal = init?.signal;
        signal?.addEventListener('abort', () => response.reject(signal.reason), { once: true });
        setTimeout(() => response.resolve(Response.json({ output: [compactionItem] })), 240_000);
        return response.promise;
      },
    });
    await clock.advance(240_000);
    expect((await pending).compactionItem).toEqual(compactionItem);
  });

  for (const initialProgress of [false, true]) {
    it(`allows V2 ${initialProgress ? 'idle' : 'first-event'} silence beyond 300s without SSE replay`, async () => {
      Socket.respond = socket => {
        if (initialProgress) socket.emit({ type: 'response.created', response: { id: 'native-response' } });
        setTimeout(() => socket.complete(), 330_000);
      };
      const pending = nativeV2();
      await Socket.sent.promise;
      await clock.advance(330_000);
      expect((await pending).replacementHistory).toEqual([compactionItem]);
      expect(fetches).toBe(0);
      expect(Socket.instances).toHaveLength(1);
    });
  }

  it('allows direct V2 SSE silence beyond the ordinary 300s watchdog', async () => {
    const pending = requestCompactionV2Streaming(model, 'fixture-key', request, undefined, {
      ...options(), preferWebsockets: false,
      fetch: async () => {
        fetches++;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(completedEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
              controller.close();
            }, 330_000);
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    await clock.advance(330_000);
    expect((await pending).replacementHistory).toEqual([compactionItem]);
    expect(fetches).toBe(1);
  });

  it('surfaces the six-minute V2 deadline without starting another native attempt', async () => {
    const pending = nativeV2().catch((error: unknown) => error);
    await Socket.sent.promise;
    await clock.advance(360_000);
    const error = await pending;
    expect(error).toBe(clock.reasons.at(-1));
    expect(AIError.is(AIError.classify(error), AIError.Flag.Timeout)).toBe(true);
    expect(AIError.is(AIError.classify(error), AIError.Flag.Transient)).toBe(true);
    expect(Socket.instances).toHaveLength(1);
    expect(fetches).toBe(0);
  });

  it('retains the unoverridden Codex 300s watchdog and genuine transport fallback', async () => {
    const events = await openCodexCompactionEventStream(model, request.body, options());
    const pending = drain(events);
    await Socket.sent.promise;
    await clock.advance(300_000);
    expect(await pending).toEqual(completedEvents);
    expect(fetches).toBe(1);
    expect(AIError.retriable(AIError.classify(new CodexWebSocketTransportError('websocket closed (1006)')))).toBe(true);
  });

  it('replays a real stream transport failure over SSE', async () => {
    Socket.respond = socket => queueMicrotask(() => socket.close(1006));
    expect((await nativeV2()).compactionItem).toEqual(compactionItem);
    expect(fetches).toBe(1);
  });

  for (const phase of ['entry', 'connecting', 'stream-entry', 'streaming'] as const) {
    it(`preserves caller cancellation at ${phase} without replay`, async () => {
      const controller = new AbortController();
      const cause = new Error('caller interrupted native compaction');
      const reason = new AIError.AbortError('Compaction cancelled', { cause });
      if (phase === 'entry') controller.abort(reason);
      if (phase === 'connecting') Socket.autoOpen = false;
      const opening = openCodexCompactionEventStream(model, request.body, { ...options(), signal: controller.signal });
      const pending = (async () => {
        const events = await opening;
        if (phase === 'stream-entry') controller.abort(reason);
        return drain(events);
      })().catch((error: unknown) => error);
      if (phase === 'connecting') {
        await Socket.created.promise;
        controller.abort(reason);
      } else if (phase === 'streaming') {
        await Socket.sent.promise;
        controller.abort(reason);
      }
      const error = await pending;
      expect(error).toBe(reason);
      expect(reason.cause).toBe(cause);
      expect(AIError.is(AIError.classify(error), AIError.Flag.Abort)).toBe(true);
      expect(AIError.retriable(AIError.classify(error))).toBe(false);
      expect(fetches).toBe(0);
      expect(Socket.instances).toHaveLength(phase === 'entry' ? 0 : 1);
    });
  }

  it('retains cancellation during V2 retry wait instead of the preceding provider failure', async () => {
    const controller = new AbortController();
    const reason = new AIError.AbortError('Compaction cancelled during backoff');
    const pending = requestCompactionV2Streaming(model, 'fixture-key', request, controller.signal, {
      ...options(), preferWebsockets: false,
      fetch: async () => {
        fetches++;
        return new Response(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'server_error', message: 'busy' } } })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
      retryWait: async () => { controller.abort(reason); },
    }).catch((error: unknown) => error);
    expect(await pending).toBe(reason);
    expect(fetches).toBe(1);
  });
});
