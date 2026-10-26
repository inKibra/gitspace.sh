import { afterEach, expect, test, vi } from 'vitest';
import { BROWSER_TRACE_READ_BYTES, RuntimeBrowserDebugResultSchema, browserCookieRead, browserCookieUrl, browserTraceStart, type RuntimeAccountBrowserGrant, type RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import { performBrowserPower } from '../src/browser-powers.js';

afterEach(() => { vi.useRealTimers(); });

const relay = { kind: 'account-relay' as const, accountId: 'account', pairingId: crypto.randomUUID(), generation: 1 };
const chromeGrant = (fields: Partial<RuntimeAccountBrowserGrant> = {}): RuntimeAccountBrowserGrant => ({ projectId: 'project', workspaceId: 'workspace', placement: relay, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', origins: ['app.example'], stepsOnly: [], expiresAt: new Date(Date.now() + 60_000).toISOString(), ...fields });
const cloudGrant = (): RuntimeAccountBrowserGrant => ({ ...chromeGrant(), placement: { kind: 'cloud', accountId: 'account' }, source: 'headless', origins: [] });

/** A tab as a power step drives it: each command it was sent, answered by `answer`, and the events it emits. */
function fakeTab(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<(event: { method?: string; params?: Record<string, unknown> }) => void>();
  const emit = (method: string, params: Record<string, unknown>) => { for (const listener of listeners) listener({ method, params }); };
  const tab = {
    send: async (method: string, params: Record<string, unknown> = {}) => { sent.push({ method, params }); return answer(method, params); },
    subscribe: (listener: (event: { method?: string; params?: Record<string, unknown> }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { tab, sent, emit };
}
/** The workspace's drive, reading each file as it is written. */
function fakeDrive() {
  const files = new Map<string, string>();
  return { files, drive: { async write(path: string, _mediaType: string | null, body: Uint8Array | ReadableStream<Uint8Array>) { const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer()); files.set(path, new TextDecoder().decode(bytes)); return { path, size: bytes.byteLength, blobHash: `sha256:${path}` }; } } };
}
/** `text` in pieces of `size` characters, splitting tokens and objects anywhere. */
const pieces = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));

test('on your Chrome debug and storage need their power, refused with how to turn it on before any command; storage reaches the grant’s sites only, any site under Everything, and needs nothing on the cloud browser', async () => {
  const { drive } = fakeDrive();
  const debug: RuntimeBrowserArguments = { action: 'debug', source: 'relay', targetId: 'tab', kind: 'profile' };
  const cookies = (site: string): RuntimeBrowserArguments & { action: 'storage' } => ({ action: 'storage', source: 'relay', targetId: 'tab', op: 'get', kind: 'cookies', site });
  const { tab, sent } = fakeTab(() => ({ cookies: [] }));
  const run = (grant: RuntimeAccountBrowserGrant, args: RuntimeBrowserArguments & { action: 'debug' | 'storage' }) => performBrowserPower({ grant, args, tab, drive, signal: AbortSignal.timeout(60_000) });
  await expect(run(chromeGrant(), debug)).rejects.toThrow('Debugging is not turned on for Chrome "this Chrome" in this project. Ask the user to turn on "Debug (profiles, traces, heap snapshots)"');
  await expect(run(chromeGrant(), cookies('app.example'))).rejects.toThrow('Ask the user to turn on "Cookies and storage for approved sites"');
  await expect(run(chromeGrant({ powers: ['debug'] }), { ...debug, kind: 'heap' })).rejects.toThrow('Chrome does not let extensions take heap snapshots');
  await expect(run(chromeGrant({ powers: ['storage'] }), cookies('bank.test'))).rejects.toThrow('bank.test is not an approved site of this workspace');
  expect(sent).toEqual([]);
  await run(chromeGrant({ powers: ['storage'] }), cookies('app.example'));
  await run(chromeGrant({ everything: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }), cookies('bank.test'));
  await run(cloudGrant(), cookies('bank.test'));
  expect(sent).toEqual(Array(3).fill(null).map((_, index) => ({ method: 'Network.getCookies', params: browserCookieRead(index ? 'bank.test' : 'app.example') })));
});

test('a storage step reads cookies with long values cut, sets one by the site’s URL, and clears only the named one', async () => {
  const long = 'v'.repeat(1500);
  const { tab, sent } = fakeTab(method => method === 'Network.getCookies' ? { cookies: [{ name: 'session', value: long, domain: 'app.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }, { name: 'theme', value: 'dark', domain: 'app.example', path: '/', expires: -1, httpOnly: false, secure: false }] } : { success: true });
  const grant = chromeGrant({ powers: ['storage'] });
  const step = (args: Partial<RuntimeBrowserArguments & { action: 'storage' }>) => performBrowserPower({ grant, args: { action: 'storage', source: 'relay', targetId: 'tab', op: 'get', kind: 'cookies', site: 'app.example', ...args }, tab, drive: undefined, signal: AbortSignal.timeout(60_000) });
  const [answer] = await step({});
  const read = JSON.parse(answer?.type === 'text' ? answer.text : '');
  expect(read).toMatchObject({ total: 2, cookies: [{ name: 'session', value: `${'v'.repeat(1000)}…` }, { name: 'theme', value: 'dark' }] });
  sent.length = 0;
  await step({ op: 'set', name: 'flag', value: 'on' });
  await step({ op: 'clear', name: 'theme' });
  expect(sent).toEqual([{ method: 'Network.setCookie', params: { name: 'flag', value: 'on', url: browserCookieUrl('app.example') } }, { method: 'Network.getCookies', params: browserCookieRead('app.example') }, { method: 'Network.deleteCookies', params: { name: 'theme', url: browserCookieUrl('app.example') } }]);
});

/** A trace as `IO.read` returns it, in pieces: renderer main-thread tasks, CPU samples, and the thread names last. */
function traceText() {
  const main = { pid: 1, tid: 10 }, worker = { pid: 1, tid: 20 };
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '', scriptId: 0, lineNumber: -1, columnNumber: -1 } }, { id: 2, parent: 1, callFrame: { functionName: 'render', url: 'https://app.example/app.js', scriptId: 5, lineNumber: 41, columnNumber: 3 } }, { id: 3, parent: 2, callFrame: { functionName: 'layout', url: 'https://app.example/app.js', scriptId: 5, lineNumber: 90, columnNumber: 1 } }, { id: 4, parent: 1, callFrame: { functionName: '(idle)', url: '', scriptId: 0, lineNumber: -1, columnNumber: -1 } }];
  const events = [
    { ...main, name: 'Profile', ph: 'P', id: '0x1', ts: 1000, args: { data: { startTime: 1000 } } },
    { ...main, name: 'ProfileChunk', ph: 'P', id: '0x1', ts: 1100, args: { data: { cpuProfile: { nodes, samples: [2, 3, 3, 4] }, timeDeltas: [0, 1000, 3000, 2000] } } },
    { ...main, name: 'ProfileChunk', ph: 'P', id: '0x1', ts: 1200, args: { data: { cpuProfile: { samples: [3, 2] }, timeDeltas: [500, 1500] } } },
    { ...main, name: 'RunTask', ph: 'X', ts: 2000, dur: 80_000, args: {} },
    { ...main, name: 'RunTask', ph: 'X', ts: 200_000, dur: 120_000, args: {} },
    { ...main, name: 'RunTask', ph: 'X', ts: 400_000, dur: 10_000, args: {} },
    { ...worker, name: 'RunTask', ph: 'X', ts: 500_000, dur: 900_000, args: {} },
    { ...main, name: 'thread_name', ph: 'M', ts: 0, args: { name: 'CrRendererMain' } },
    { ...worker, name: 'thread_name', ph: 'M', ts: 0, args: { name: 'DedicatedWorker thread' } },
  ];
  return JSON.stringify({ traceEvents: events, metadata: { 'trace-config': '{"a":"}"}' } });
}

test('a debug step records a trace through Tracing exactly as the extension admits it, reads its stream in pieces, and summarises self time and long tasks on the main thread', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  for (const kind of ['profile', 'trace'] as const) {
    const reads = pieces(traceText(), 37);
    const { tab, sent, emit } = fakeTab((method, params) => {
      if (method === 'Tracing.end') queueMicrotask(() => emit('Tracing.tracingComplete', { stream: 'stream-1', dataLossOccurred: false }));
      if (method !== 'IO.read' || params.handle !== 'stream-1') return {};
      const data = reads.shift() ?? '';
      // Chrome may answer a piece base64-encoded.
      return reads.length % 2 ? { data: btoa(data), base64Encoded: true, eof: !reads.length } : { data, eof: !reads.length };
    });
    const { files, drive } = fakeDrive();
    const running = performBrowserPower({ grant: chromeGrant({ powers: ['debug'] }), args: { action: 'debug', source: 'relay', targetId: 'tab', kind, durationMs: 2000 }, tab, drive, signal: AbortSignal.timeout(60_000) });
    await vi.advanceTimersByTimeAsync(1999);
    expect(sent.map(command => command.method)).toEqual(['Tracing.start']);
    await vi.advanceTimersByTimeAsync(1);
    const content = await running;
    expect(sent[0]).toEqual({ method: 'Tracing.start', params: browserTraceStart(kind) });
    expect(sent.slice(1).map(command => command.method)).toEqual(['Tracing.end', ...pieces(traceText(), 37).map(() => 'IO.read'), 'IO.close']);
    expect(sent.filter(command => command.method === 'IO.read').every(command => command.params.size === BROWSER_TRACE_READ_BYTES)).toBe(true);
    const result = RuntimeBrowserDebugResultSchema.parse(JSON.parse(content[0]?.type === 'text' ? content[0].text : ''));
    const path = result.file.slice('drive://workspace/'.length);
    if (kind === 'profile') {
      expect(path).toMatch(/^browser\/debug\/[0-9a-f-]{36}\.cpuprofile$/u);
      // Each sample lasts until the next: layout 3 + 2 + 1.5 ms, render 1 ms (its last sample has no next); idle and
      // the root are left out of the functions, not of the time.
      expect(result.summary).toEqual({ kind: 'profile', durationMs: 2000, samples: 6, functions: [
        { name: 'layout', url: 'https://app.example/app.js', line: 91, selfMs: 6.5, selfPercent: 6.5 / 8 * 100 },
        { name: 'render', url: 'https://app.example/app.js', line: 42, selfMs: 1, selfPercent: 1 / 8 * 100 },
      ] });
      const profile = JSON.parse(files.get(path) ?? '');
      expect(profile).toMatchObject({ startTime: 1000, samples: [2, 3, 3, 4, 3, 2], timeDeltas: [0, 1000, 3000, 2000, 500, 1500] });
      expect(profile.nodes.find((node: { id: number }) => node.id === 1)).toMatchObject({ hitCount: 0, children: [2, 4] });
    } else {
      expect(files.get(path)).toBe(traceText());
      expect(result.bytes).toBe(new TextEncoder().encode(traceText()).byteLength);
      expect(result.summary).toEqual({ kind: 'trace', durationMs: 2000, events: 9, longTasks: { count: 2, totalMs: 200, longest: [{ startMs: 199, durationMs: 120 }, { startMs: 1, durationMs: 80 }] } });
    }
  }
});

test('a heap snapshot on the cloud browser streams its chunks to the drive and sums heap size by constructor as they come', async () => {
  const snapshot = JSON.stringify({
    snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'], node_types: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'], 'string', 'number', 'number', 'number', 'number', 'number'], edge_fields: ['type', 'name_or_index', 'to_node'] }, node_count: 6, edge_count: 1 },
    nodes: [3, 1, 1, 100, 0, 0, 0, 3, 1, 3, 50, 0, 0, 0, 5, 2, 5, 30, 0, 0, 0, 2, 4, 7, 20, 0, 0, 0, 3, 3, 9, 160, 1, 0, 0, 10, 4, 11, 15, 0, 0, 0],
    edges: [1, 2, 7], trace_function_infos: [], locations: [],
    strings: ['', 'Foo', 'run "it"', 'Bar\\Baz', 'text'],
  });
  const { tab, sent, emit } = fakeTab(method => { if (method === 'HeapProfiler.takeHeapSnapshot') for (const chunk of pieces(snapshot, 11)) emit('HeapProfiler.addHeapSnapshotChunk', { chunk }); return {}; });
  const { files, drive } = fakeDrive();
  const content = await performBrowserPower({ grant: cloudGrant(), args: { action: 'debug', source: 'headless', targetId: 'tab', kind: 'heap' }, tab, drive, signal: AbortSignal.timeout(60_000) });
  const result = RuntimeBrowserDebugResultSchema.parse(JSON.parse(content[0]?.type === 'text' ? content[0].text : ''));
  expect(sent.map(command => command.method)).toEqual(['HeapProfiler.enable', 'HeapProfiler.takeHeapSnapshot', 'HeapProfiler.disable']);
  expect(files.get(result.file.slice('drive://workspace/'.length))).toBe(snapshot);
  expect(result.summary).toEqual({ kind: 'heap', totalBytes: 375, nodes: 6, constructors: [
    { name: 'Bar\\Baz', count: 1, selfBytes: 160 }, { name: 'Foo', count: 2, selfBytes: 150 }, { name: '(closure)', count: 1, selfBytes: 30 }, { name: '(string)', count: 2, selfBytes: 35 },
  ].toSorted((a, b) => b.selfBytes - a.selfBytes) });
});
