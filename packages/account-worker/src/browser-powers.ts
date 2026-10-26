import { z } from 'zod';
import { browserOriginMatches } from '@gitspace/protocol-environment';
import {
  BROWSER_DEBUG_DURATION_MS, BROWSER_DEBUG_FILES, BROWSER_DEBUG_PREFIX, BROWSER_HEAP_ON_CHROME, BROWSER_LONG_TASK_MS, BROWSER_STORAGE_ENTRIES, BROWSER_STORAGE_VALUE_CHARS, BROWSER_TRACE_READ_BYTES,
  RuntimeBrowserDebugResultSchema, browserCookieRead, browserCookieUrl, browserEverythingActive, browserGrantPower, browserPowerRefusal, browserStorageExpression, browserStorageSiteRefusal, browserTraceStart, browserUnbase64,
  type RuntimeAccountBrowserGrant, type RuntimeBrowserArguments, type RuntimeBrowserDebugSummary, type RuntimeToolResult,
} from '@gitspace/protocol-runtime';
import type { WorkspaceDrive } from './workspace-drive.js';

/**
 * Debug and storage steps (docs/SIMPLIFICATION.md Batch 16 item 5, `browser-powers.ts` in protocol-runtime), one
 * implementation for the cloud browser and your Chrome. On your Chrome each needs its power in the grant (or
 * Everything), as the workspace and the extension check too; the cloud browser is the workspace's own profile.
 *
 * Debug: a CPU profile or a performance trace comes from the Tracing domain (Chrome closes Profiler and HeapProfiler
 * to extensions), read back through `IO.read` and parsed one trace event at a time, never whole; a heap snapshot
 * (cloud only) streams its chunks to the drive and is summarised as it streams. Storage: cookies through the Network
 * domain by the site's URL, page storage through one page script on a tab showing the site.
 */

/** One tab as a power step drives it: its DevTools commands, and its events. */
export type PowerTab = { send(method: string, params?: Record<string, unknown>): Promise<unknown>; subscribe(listener: (event: { method?: string; params?: Record<string, unknown> }) => void): () => void };
type DebugArgs = Extract<RuntimeBrowserArguments, { action: 'debug' }>;
type StorageArgs = Extract<RuntimeBrowserArguments, { action: 'storage' }>;
type Content = RuntimeToolResult['content'];

/** Runs a debug or storage step on `tab`, after the checks your Chrome needs. */
export async function performBrowserPower(input: { grant: RuntimeAccountBrowserGrant; args: DebugArgs | StorageArgs; tab: PowerTab; drive: Pick<WorkspaceDrive, 'write'> | undefined; signal: AbortSignal }): Promise<Content> {
  const { grant, args } = input;
  if (grant.placement.kind === 'account-relay') {
    const power = args.action === 'debug' ? 'debug' : 'storage';
    if (!browserGrantPower(grant, power, Date.now())) throw new Error(browserPowerRefusal(power, 'this Chrome'));
    if (args.action === 'debug' && args.kind === 'heap') throw new Error(BROWSER_HEAP_ON_CHROME);
    if (args.action === 'storage' && !browserEverythingActive(grant, Date.now()) && !grant.origins.some(pattern => browserOriginMatches(pattern, args.site))) throw new Error(browserStorageSiteRefusal(args.site));
  }
  if (args.action === 'storage') return storage(input.tab, args);
  if (!input.drive) throw new Error('Debug files need the workspace drive');
  return debug(input.tab, args, input.drive, input.signal);
}

// ── Storage ──

const Cookie = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.string().optional() });
const Cookies = z.object({ cookies: z.array(Cookie) });
const Evaluated = z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.object({ text: z.string().optional(), exception: z.object({ description: z.string().optional() }).optional() }).optional() });
const cut = (value: string) => value.length > BROWSER_STORAGE_VALUE_CHARS ? `${value.slice(0, BROWSER_STORAGE_VALUE_CHARS)}…` : value;
const answer = (value: unknown): Content => [{ type: 'text', text: JSON.stringify(value) }];

async function storage(tab: PowerTab, args: StorageArgs): Promise<Content> {
  if (args.kind !== 'cookies') {
    const evaluated = Evaluated.parse(await tab.send('Runtime.evaluate', { expression: browserStorageExpression(args), returnByValue: true, awaitPromise: true }));
    if (evaluated.exceptionDetails) throw new Error((evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? 'The page refused the storage step').split('\n')[0]?.slice(0, 500));
    return answer({ site: args.site, kind: args.kind, op: args.op, ...z.record(z.string(), z.unknown()).parse(evaluated.result.value) });
  }
  if (args.op === 'set') {
    if (args.name === undefined || args.value === undefined) throw new Error('Setting a cookie takes its name and value');
    const set = z.object({ success: z.boolean().optional() }).parse(await tab.send('Network.setCookie', { name: args.name, value: args.value, url: browserCookieUrl(args.site) }));
    if (set.success === false) throw new Error(`Chrome refused the cookie ${args.name} for ${args.site}`);
    return answer({ site: args.site, kind: 'cookies', op: 'set', set: args.name });
  }
  const { cookies } = Cookies.parse(await tab.send('Network.getCookies', browserCookieRead(args.site)));
  const named = cookies.filter(cookie => args.name === undefined || cookie.name === args.name);
  if (args.op === 'get') return answer({ site: args.site, kind: 'cookies', op: 'get', total: named.length, cookies: named.slice(0, BROWSER_STORAGE_ENTRIES).map(cookie => ({ ...cookie, value: cut(cookie.value) })) });
  const names = [...new Set(named.map(cookie => cookie.name))];
  for (const name of names) await tab.send('Network.deleteCookies', { name, url: browserCookieUrl(args.site) });
  return answer({ site: args.site, kind: 'cookies', op: 'clear', cleared: names });
}

// ── Debug ──

/** Waits `ms` exactly, or rejects when `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  const waited = Promise.withResolvers<void>();
  const abort = () => { clearTimeout(timer); waited.reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); waited.resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  return waited.promise;
}

/** A stream the drive reads a file from while the step writes it. */
function driveFile(drive: Pick<WorkspaceDrive, 'write'>, path: string, mediaType: string) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const written = drive.write(path, mediaType, readable);
  // Its failure is the step's, through `written`.
  written.catch(() => {});
  return { writer: writable.getWriter(), written };
}

async function debug(tab: PowerTab, args: DebugArgs, drive: Pick<WorkspaceDrive, 'write'>, signal: AbortSignal): Promise<Content> {
  const debugId = crypto.randomUUID(), file = BROWSER_DEBUG_FILES[args.kind], path = `${BROWSER_DEBUG_PREFIX}${debugId}.${file.extension}`;
  let bytes: number, summary: RuntimeBrowserDebugSummary;
  if (args.kind === 'heap') ({ bytes, summary } = await heapSnapshot(tab, drive, path, file.mediaType, signal));
  else {
    const durationMs = args.durationMs ?? BROWSER_DEBUG_DURATION_MS.default;
    const reader = args.kind === 'profile' ? new ProfileReader() : new TraceReader();
    // The raw trace goes to the drive as it is read; a profile is built from it and written once read.
    const raw = args.kind === 'trace' ? driveFile(drive, path, file.mediaType) : null;
    const scanner = new TraceEventScanner(event => reader.event(event));
    // Chrome reports the trace's stream once it ended; an abort of the step ends the wait.
    const complete = Promise.withResolvers<string>();
    const abort = () => complete.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const unsubscribe = tab.subscribe(event => { if (event.method === 'Tracing.tracingComplete' && typeof event.params?.stream === 'string') complete.resolve(event.params.stream); });
    try {
      await tab.send('Tracing.start', browserTraceStart(args.kind));
      await wait(durationMs, signal);
      await tab.send('Tracing.end', {});
      const stream = await complete.promise;
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = z.object({ data: z.string(), eof: z.boolean().optional(), base64Encoded: z.boolean().optional() }).parse(await tab.send('IO.read', { handle: stream, size: BROWSER_TRACE_READ_BYTES }));
        const data = chunk.base64Encoded ? browserUnbase64(chunk.data) : new TextEncoder().encode(chunk.data);
        if (raw) await raw.writer.write(data);
        scanner.push(decoder.decode(data, { stream: !chunk.eof }));
        if (chunk.eof) break;
      }
      await tab.send('IO.close', { handle: stream });
    } catch (error) { await raw?.writer.abort(error); throw error; }
    finally { unsubscribe(); signal.removeEventListener('abort', abort); }
    if (raw) { await raw.writer.close(); bytes = (await raw.written).size; summary = reader.summary(durationMs); }
    else {
      const profile = reader instanceof ProfileReader ? reader.profile() : null;
      bytes = (await drive.write(path, file.mediaType, new TextEncoder().encode(JSON.stringify(profile ?? { nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] })))).size;
      summary = reader.summary(durationMs);
    }
  }
  const result = RuntimeBrowserDebugResultSchema.parse({ debugId, file: `drive://workspace/${path}`, bytes, summary });
  return [{ type: 'text', text: JSON.stringify(result) }, { type: 'text', text: debugText(summary) }];
}

/** The summary as one short readable paragraph. */
function debugText(summary: RuntimeBrowserDebugSummary): string {
  if (summary.kind === 'profile') return summary.functions.length ? `Top functions by self time over ${Math.round(summary.durationMs)} ms (${summary.samples} samples): ${summary.functions.map(item => `${item.name} ${item.selfMs.toFixed(1)} ms (${item.selfPercent.toFixed(1)}%)${item.url ? ` ${item.url}:${item.line}` : ''}`).join('; ')}.` : 'The profile recorded no samples of the page.';
  if (summary.kind === 'trace') return summary.longTasks.count ? `${summary.longTasks.count} long tasks (${Math.round(summary.longTasks.totalMs)} ms) in ${summary.events} trace events; longest: ${summary.longTasks.longest.map(task => `${Math.round(task.durationMs)} ms at ${Math.round(task.startMs)} ms`).join(', ')}.` : `No long tasks (${BROWSER_LONG_TASK_MS} ms or more) in ${summary.events} trace events.`;
  return `Heap ${(summary.totalBytes / 1024 / 1024).toFixed(1)} MiB in ${summary.nodes} objects; by constructor: ${summary.constructors.map(item => `${item.name} ${(item.selfBytes / 1024).toFixed(0)} KiB (${item.count})`).join(', ')}.`;
}

/** A trace event as Chrome writes one (`chrome://tracing` JSON). */
const TraceEvent = z.object({ name: z.string().optional(), ph: z.string().optional(), pid: z.number().optional(), tid: z.number().optional(), ts: z.number().optional(), dur: z.number().optional(), id: z.union([z.string(), z.number()]).optional(), args: z.record(z.string(), z.unknown()).optional() });
type TraceEvent = z.infer<typeof TraceEvent>;

/**
 * Yields each object of a trace's `traceEvents` array (or of a trace that is a bare array) as its text arrives in any
 * pieces, one event held at a time.
 */
export class TraceEventScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** The depth event objects open at: 2 inside `{"traceEvents":[…]}`, 1 in a bare array; known at the first bracket. */
  private eventDepth = 0;
  private current: string[] = [];
  private capturing = false;
  constructor(private readonly onEvent: (event: TraceEvent) => void) {}

  push(text: string): void {
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === '"') this.inString = false;
        continue;
      }
      if (character === '"') { this.inString = true; continue; }
      if (character === '{' || character === '[') {
        if (!this.eventDepth) this.eventDepth = character === '{' ? 2 : 1;
        if (character === '{' && this.depth === this.eventDepth && !this.capturing) { this.capturing = true; start = index; this.current = []; }
        this.depth++;
      } else if (character === '}' || character === ']') {
        this.depth--;
        if (character === '}' && this.capturing && this.depth === this.eventDepth) {
          this.current.push(text.slice(start, index + 1));
          this.capturing = false;
          const parsed = TraceEvent.safeParse(JSON.parse(this.current.join('')));
          this.current = [];
          if (parsed.success) this.onEvent(parsed.data);
        }
      }
    }
    if (this.capturing) { this.current.push(text.slice(start)); }
  }
}

/** The renderer main threads a trace names (`thread_name` metadata), as `pid:tid`. */
function mainThread(event: TraceEvent, threads: Set<string>): void {
  if (event.ph === 'M' && event.name === 'thread_name' && z.object({ name: z.string() }).safeParse(event.args).data?.name === 'CrRendererMain') threads.add(`${event.pid}:${event.tid}`);
}

/** Long tasks of a performance trace: renderer main-thread tasks of `BROWSER_LONG_TASK_MS` or longer. */
class TraceReader {
  private events = 0;
  private start = Number.POSITIVE_INFINITY;
  private readonly threads = new Set<string>();
  /** Long tasks of every thread until the main threads are known; at most `LONG_TASKS_KEPT`. */
  private readonly long: { thread: string; ts: number; dur: number }[] = [];
  event(event: TraceEvent): void {
    this.events++;
    if (event.ts !== undefined && event.ts > 0 && event.ph !== 'M') this.start = Math.min(this.start, event.ts);
    mainThread(event, this.threads);
    if (event.ph === 'X' && (event.name === 'RunTask' || event.name === 'ThreadControllerImpl::RunTask') && event.ts !== undefined && (event.dur ?? 0) >= BROWSER_LONG_TASK_MS * 1000 && this.long.length < LONG_TASKS_KEPT) this.long.push({ thread: `${event.pid}:${event.tid}`, ts: event.ts, dur: event.dur ?? 0 });
  }
  summary(durationMs: number): RuntimeBrowserDebugSummary {
    const tasks = this.threads.size ? this.long.filter(task => this.threads.has(task.thread)) : this.long;
    const start = Number.isFinite(this.start) ? this.start : 0;
    return { kind: 'trace', durationMs, events: this.events, longTasks: { count: tasks.length, totalMs: tasks.reduce((sum, task) => sum + task.dur / 1000, 0), longest: tasks.toSorted((a, b) => b.dur - a.dur).slice(0, 10).map(task => ({ startMs: Math.max(0, (task.ts - start) / 1000), durationMs: task.dur / 1000 })) } };
  }
}
const LONG_TASKS_KEPT = 10_000;

const CallFrame = z.object({ functionName: z.string(), url: z.string().default(''), scriptId: z.union([z.string(), z.number()]).default(0), lineNumber: z.number().default(-1), columnNumber: z.number().default(-1) });
const ProfileNode = z.object({ id: z.number(), callFrame: CallFrame, parent: z.number().optional() });
const ProfileChunk = z.object({ cpuProfile: z.object({ nodes: z.array(ProfileNode).optional(), samples: z.array(z.number()).optional() }).optional(), timeDeltas: z.array(z.number()).optional() });
type Profile = { thread: string; startTime: number; nodes: Map<number, z.infer<typeof ProfileNode>>; samples: number[]; timeDeltas: number[] };

/** A CPU profile from a trace's `Profile` and `ProfileChunk` events: the renderer main thread's, else the busiest. */
class ProfileReader {
  private readonly threads = new Set<string>();
  private readonly profiles = new Map<string, Profile>();
  event(event: TraceEvent): void {
    mainThread(event, this.threads);
    if (event.name !== 'Profile' && event.name !== 'ProfileChunk') return;
    const key = `${event.pid}:${String(event.id)}`;
    const data = z.object({ data: z.unknown() }).safeParse(event.args).data?.data;
    let profile = this.profiles.get(key);
    if (!profile) { profile = { thread: `${event.pid}:${event.tid}`, startTime: 0, nodes: new Map(), samples: [], timeDeltas: [] }; this.profiles.set(key, profile); }
    if (event.name === 'Profile') { profile.thread = `${event.pid}:${event.tid}`; profile.startTime = z.object({ startTime: z.number() }).safeParse(data).data?.startTime ?? event.ts ?? 0; return; }
    const chunk = ProfileChunk.safeParse(data);
    if (!chunk.success) return;
    for (const node of chunk.data.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
    profile.samples.push(...chunk.data.cpuProfile?.samples ?? []);
    profile.timeDeltas.push(...chunk.data.timeDeltas ?? []);
  }
  private chosen(): Profile | null {
    const all = [...this.profiles.values()].filter(profile => profile.samples.length);
    return all.find(profile => this.threads.has(profile.thread)) ?? all.toSorted((a, b) => b.samples.length - a.samples.length)[0] ?? null;
  }
  /** As DevTools saves one (`.cpuprofile`). */
  profile() {
    const profile = this.chosen();
    if (!profile) return null;
    const hits = new Map<number, number>();
    for (const sample of profile.samples) hits.set(sample, (hits.get(sample) ?? 0) + 1);
    const children = new Map<number, number[]>();
    for (const node of profile.nodes.values()) if (node.parent !== undefined) children.set(node.parent, [...children.get(node.parent) ?? [], node.id]);
    const endTime = profile.startTime + profile.timeDeltas.reduce((sum, delta) => sum + delta, 0);
    return { nodes: [...profile.nodes.values()].map(node => ({ id: node.id, callFrame: node.callFrame, hitCount: hits.get(node.id) ?? 0, children: children.get(node.id) ?? [] })), startTime: profile.startTime, endTime, samples: profile.samples, timeDeltas: profile.timeDeltas };
  }
  /** The top ten functions by self time: each sample lasts until the next one. */
  summary(durationMs: number): RuntimeBrowserDebugSummary {
    const profile = this.chosen();
    if (!profile) return { kind: 'profile', durationMs, samples: 0, functions: [] };
    const self = new Map<string, { name: string; url: string; line: number; micros: number }>();
    let total = 0;
    profile.samples.forEach((sample, index) => {
      const micros = Math.max(0, profile.timeDeltas[index + 1] ?? 0);
      total += micros;
      const frame = profile.nodes.get(sample)?.callFrame;
      if (!frame || frame.functionName === '(root)' || frame.functionName === '(idle)') return;
      const key = `${frame.functionName}\n${frame.url}\n${frame.lineNumber}`;
      const entry = self.get(key) ?? { name: frame.functionName || '(anonymous)', url: frame.url, line: frame.lineNumber + 1, micros: 0 };
      entry.micros += micros;
      self.set(key, entry);
    });
    const functions = [...self.values()].toSorted((a, b) => b.micros - a.micros).slice(0, 10).map(entry => ({ name: entry.name.slice(0, 512), url: entry.url.slice(0, 2048), line: entry.line, selfMs: entry.micros / 1000, selfPercent: total ? entry.micros / total * 100 : 0 }));
    return { kind: 'profile', durationMs, samples: profile.samples.length, functions };
  }
}

/** Node types DevTools groups under one name in its constructor summary; objects are grouped by their own name. */
const HEAP_GROUPS: Record<string, string> = {
  closure: '(closure)', string: '(string)', 'concatenated string': '(string)', 'sliced string': '(string)', array: '(array)', code: '(compiled code)', regexp: '(regexp)',
  number: '(number)', 'heap number': '(number)', hidden: '(system)', synthetic: '(system)', 'object shape': '(system)', bigint: '(bigint)', symbol: '(symbol)',
};
const HeapMeta = z.object({ snapshot: z.object({ meta: z.object({ node_fields: z.array(z.string()), node_types: z.array(z.unknown()) }) }) });

/**
 * A heap snapshot's constructor summary as its text arrives: the meta, then the `nodes` integers aggregated by type and
 * name as they come (nothing else of them kept), then only the names of the largest groups from `strings`.
 */
export class HeapSnapshotSummary {
  private phase: 'meta' | 'nodes' | 'skip' | 'strings' | 'done' = 'meta';
  private head = '';
  private fields = 0;
  private typeField = 0;
  private nameField = 0;
  private sizeField = 0;
  private types: string[] = [];
  private number = '';
  private field = 0;
  private node: number[] = [];
  private nodes = 0;
  private total = 0;
  /** By group: a type's label, or `#<name index>` for objects grouped by name. */
  private readonly groups = new Map<string, { count: number; selfBytes: number }>();
  private wanted = new Map<number, string>();
  /** The ten largest groups by self size, once every node was read. */
  private largest: [string, { count: number; selfBytes: number }][] = [];
  private names = new Map<number, string>();
  private stringIndex = 0;
  private token: string[] | null = null;
  private inString = false;
  private escaped = false;
  private carry = '';

  push(text: string): void {
    let index = 0;
    while (index < text.length) {
      if (this.phase === 'meta') {
        this.head += text.slice(index);
        index = text.length;
        const at = this.head.indexOf('"nodes"');
        if (at < 0) { if (this.head.length > 1_000_000) throw new Error('The heap snapshot has no nodes'); continue; }
        const open = this.head.indexOf('[', at);
        if (open < 0) continue;
        const meta = HeapMeta.parse(JSON.parse(`${this.head.slice(0, this.head.lastIndexOf(',', at))}}`)).snapshot.meta;
        this.fields = meta.node_fields.length;
        this.typeField = meta.node_fields.indexOf('type');
        this.nameField = meta.node_fields.indexOf('name');
        this.sizeField = meta.node_fields.indexOf('self_size');
        this.types = z.array(z.string()).parse(meta.node_types[this.typeField]);
        const rest = this.head.slice(open + 1);
        this.head = '';
        this.phase = 'nodes';
        this.push(rest);
        return;
      }
      if (this.phase === 'nodes') {
        for (; index < text.length; index++) {
          const character = text[index] ?? '';
          if (character >= '0' && character <= '9' || character === '-') { this.number += character; continue; }
          if (this.number) { this.node[this.field] = Number(this.number); this.number = ''; if (++this.field === this.fields) { this.add(); this.field = 0; } }
          if (character === ']') { this.phase = 'skip'; this.chooseNames(); index++; break; }
        }
        continue;
      }
      if (this.phase === 'skip') {
        const window = this.carry + text.slice(index);
        const at = window.indexOf('"strings"');
        const open = at < 0 ? -1 : window.indexOf('[', at);
        if (open < 0) { this.carry = window.slice(-16); index = text.length; continue; }
        const rest = window.slice(open + 1);
        this.carry = '';
        this.phase = 'strings';
        this.push(rest);
        return;
      }
      if (this.phase === 'strings') {
        for (; index < text.length; index++) {
          const character = text[index] ?? '';
          if (this.inString) {
            this.token?.push(character);
            if (this.escaped) this.escaped = false;
            else if (character === '\\') this.escaped = true;
            else if (character === '"') {
              this.inString = false;
              if (this.token) this.names.set(this.stringIndex, z.string().parse(JSON.parse(this.token.join(''))));
              this.token = null;
              this.stringIndex++;
            }
            continue;
          }
          if (character === '"') { this.inString = true; this.token = this.wanted.has(this.stringIndex) ? ['"'] : null; continue; }
          if (character === ']') { this.phase = 'done'; break; }
        }
        index = text.length;
        continue;
      }
      index = text.length;
    }
  }

  private add(): void {
    const type = this.types[this.node[this.typeField] ?? -1] ?? 'unknown', size = this.node[this.sizeField] ?? 0;
    const key = type === 'object' || type === 'native' ? `#${this.node[this.nameField] ?? 0}` : HEAP_GROUPS[type] ?? `(${type})`;
    const group = this.groups.get(key) ?? { count: 0, selfBytes: 0 };
    group.count++; group.selfBytes += size;
    this.groups.set(key, group);
    this.nodes++; this.total += size;
  }

  private chooseNames(): void {
    this.largest = [...this.groups].toSorted((a, b) => b[1].selfBytes - a[1].selfBytes).slice(0, 10);
    for (const [key] of this.largest) if (key.startsWith('#')) this.wanted.set(Number(key.slice(1)), key);
  }

  summary(): RuntimeBrowserDebugSummary {
    return { kind: 'heap', totalBytes: this.total, nodes: this.nodes, constructors: this.largest.map(([key, group]) => ({ name: (key.startsWith('#') ? this.names.get(Number(key.slice(1))) ?? '(unknown)' : key).slice(0, 512), count: group.count, selfBytes: group.selfBytes })) };
  }
}

/** A heap snapshot of a cloud tab, its chunks streamed to the drive and summarised as they come. */
async function heapSnapshot(tab: PowerTab, drive: Pick<WorkspaceDrive, 'write'>, path: string, mediaType: string, signal: AbortSignal): Promise<{ bytes: number; summary: RuntimeBrowserDebugSummary }> {
  const file = driveFile(drive, path, mediaType), summary = new HeapSnapshotSummary(), encoder = new TextEncoder();
  let writing = Promise.resolve();
  let failed: unknown = null;
  const unsubscribe = tab.subscribe(event => {
    if (event.method !== 'HeapProfiler.addHeapSnapshotChunk' || typeof event.params?.chunk !== 'string') return;
    const chunk = event.params.chunk;
    try { summary.push(chunk); } catch (error) { failed ??= error; }
    writing = writing.then(() => file.writer.write(encoder.encode(chunk)));
  });
  try {
    signal.throwIfAborted();
    await tab.send('HeapProfiler.enable', {});
    await tab.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    await tab.send('HeapProfiler.disable', {});
    await writing;
    if (failed) throw failed;
  } catch (error) { await file.writer.abort(error).catch(() => {}); throw error; }
  finally { unsubscribe(); }
  await file.writer.close();
  return { bytes: (await file.written).size, summary: summary.summary() };
}
