import { z } from 'zod';
import { CLAUDE_CODE_USER_AGENT, CLAUDE_CODE_VERSION } from '@gitspace/provider-auth';
import type { Api, Model } from '@earendil-works/pi-ai';
import { attestationOffset, CCH_PLACEHOLDER, CCH_SEED, ENCODE_UNITS, requestImages, type ImageRequestTransport } from './image-requests.js';

/**
 * Claude subscription (OAuth) requests are billed to the plan only when they look like Claude Code's: pi-ai sends a
 * partial identity, and Anthropic charged every GitSpace request to extra usage. This rewrites pi-ai's request to the
 * shape oh-my-pi's Anthropic provider sends (captured from it): Claude Code headers and betas, a JSON
 * `metadata.user_id`, `_`-prefixed tool names, and the billing system block with its `cch` attestation. Tool names in
 * the streamed response are restored. Every other request passes through unchanged.
 *
 * The shape is applied to pi-ai's payload object (`onPayload`), before the SDK serializes it once; `fetch` then hashes
 * that one string chunk by chunk as UTF-8 and streams it out encoded again, the attestation written into its chunk, with
 * an exact Content-Length. No copy of the whole body is made beside the SDK's string: a large conversation is two bytes
 * per character, and copies of it exhausted a workspace object's memory beside its neighbours'.
 */
const CLAUDE_CODE_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";
const FINGERPRINT_SALT = '59cf53e54c78';
const TOOL_PREFIX = '_';
const BUILTIN_TOOLS: Record<string, true> = { web_search: true, code_execution: true, text_editor: true, computer: true };
const AGENT_BETAS = ['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'thinking-token-count-2026-05-13', 'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05', 'mid-conversation-system-2026-04-07', 'fallback-credit-2026-06-01']; // gitleaks:allow (public Anthropic beta names)
const EFFORT_BETA = 'effort-2025-11-24';
const CLAUDE_CODE_HEADERS: Record<string, string> = {
  'anthropic-version': '2023-06-01',
  'x-app': 'cli',
  'x-stainless-arch': 'x64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-package-version': '0.112.1',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.3.0',
  'x-stainless-timeout': '600',
};
const NamedSchema = z.object({ name: z.string() }).loose();
// Only what the rewrite reads or renames is checked, on the block types it touches; other blocks pass as they are.
const BlockSchema = z.object({ type: z.string() }).loose();
const ToolChangeSchema = z.object({ type: z.enum(['tool_addition', 'tool_removal']), tool: NamedSchema }).loose();
const ToolUseSchema = z.object({ type: z.literal('tool_use'), name: z.string() }).loose();
const TextSchema = z.object({ type: z.literal('text'), text: z.string() }).loose();
const MessageSchema = z.object({ role: z.string(), content: z.union([z.string(), z.array(BlockSchema)]) }).loose();
const BodySchema = z.object({
  messages: z.array(MessageSchema),
  system: z.array(z.object({ type: z.literal('text'), text: z.string() }).loose()),
  tools: z.array(NamedSchema).optional(),
  tool_choice: z.object({ type: z.string(), name: z.string().optional() }).loose().optional(),
  output_config: z.unknown().optional(),
}).loose();
const SystemProbeSchema = z.object({ system: z.array(z.object({ text: z.unknown() }).loose()) }).loose();
const ToolStartSchema = z.object({ type: z.literal('content_block_start'), content_block: z.object({ type: z.literal('tool_use'), name: z.string() }).loose() }).loose();

const MASK = 0xffffffffffffffffn;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;
const rotl = (value: bigint, bits: bigint) => ((value << bits) | (value >> (64n - bits))) & MASK;
const round = (accumulator: bigint, lane: bigint) => (rotl((accumulator + lane * PRIME2) & MASK, 31n) * PRIME1) & MASK;

/** Streaming XXH64; Workers have no native xxHash. */
export class XxHash64 {
  readonly #seed: bigint;
  #v1: bigint;
  #v2: bigint;
  #v3: bigint;
  #v4: bigint;
  readonly #stripe = new Uint8Array(32);
  readonly #stripeView = new DataView(this.#stripe.buffer);
  #buffered = 0;
  #length = 0;

  constructor(seed: bigint) {
    this.#seed = seed;
    this.#v1 = (seed + PRIME1 + PRIME2) & MASK;
    this.#v2 = (seed + PRIME2) & MASK;
    this.#v3 = seed & MASK;
    this.#v4 = (seed - PRIME1) & MASK;
  }

  #consume(view: DataView, offset: number): void {
    this.#v1 = round(this.#v1, view.getBigUint64(offset, true));
    this.#v2 = round(this.#v2, view.getBigUint64(offset + 8, true));
    this.#v3 = round(this.#v3, view.getBigUint64(offset + 16, true));
    this.#v4 = round(this.#v4, view.getBigUint64(offset + 24, true));
  }

  update(bytes: Uint8Array): void {
    this.#length += bytes.byteLength;
    let offset = 0;
    if (this.#buffered) {
      offset = Math.min(32 - this.#buffered, bytes.byteLength);
      this.#stripe.set(bytes.subarray(0, offset), this.#buffered);
      this.#buffered += offset;
      if (this.#buffered < 32) return;
      this.#consume(this.#stripeView, 0);
      this.#buffered = 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (; offset + 32 <= bytes.byteLength; offset += 32) this.#consume(view, offset);
    this.#stripe.set(bytes.subarray(offset), 0);
    this.#buffered = bytes.byteLength - offset;
  }

  digest(): bigint {
    let hash: bigint;
    if (this.#length >= 32) {
      hash = (rotl(this.#v1, 1n) + rotl(this.#v2, 7n) + rotl(this.#v3, 12n) + rotl(this.#v4, 18n)) & MASK;
      for (const lane of [this.#v1, this.#v2, this.#v3, this.#v4]) hash = (((hash ^ round(0n, lane)) * PRIME1) + PRIME4) & MASK;
    } else hash = (this.#seed + PRIME5) & MASK;
    hash = (hash + BigInt(this.#length)) & MASK;
    const view = this.#stripeView;
    let offset = 0;
    for (; offset + 8 <= this.#buffered; offset += 8) hash = ((rotl(hash ^ round(0n, view.getBigUint64(offset, true)), 27n) * PRIME1) + PRIME4) & MASK;
    if (offset + 4 <= this.#buffered) { hash = ((rotl(hash ^ ((BigInt(view.getUint32(offset, true)) * PRIME1) & MASK), 23n) * PRIME2) + PRIME3) & MASK; offset += 4; }
    for (; offset < this.#buffered; offset++) hash = (rotl(hash ^ ((BigInt(this.#stripe[offset]!) * PRIME5) & MASK), 11n) * PRIME1) & MASK;
    hash ^= hash >> 33n; hash = (hash * PRIME2) & MASK;
    hash ^= hash >> 29n; hash = (hash * PRIME3) & MASK;
    return hash ^ (hash >> 32n);
  }
}

async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const prefixed = (name: string) => BUILTIN_TOOLS[name.toLowerCase()] ? name : `${TOOL_PREFIX}${name}`;

/** Restores tool names in a streamed response to the names pi-ai registered. */
function unprefixToolUse(response: Response): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const rewrite = (line: string) => {
    if (!line.startsWith('data: ') || !line.includes('"tool_use"')) return line;
    const event = ToolStartSchema.safeParse(JSON.parse(line.slice(6)));
    if (!event.success || !event.data.content_block.name.startsWith(TOOL_PREFIX)) return line;
    event.data.content_block.name = event.data.content_block.name.slice(TOOL_PREFIX.length);
    return `data: ${JSON.stringify(event.data)}`;
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (lines.length) controller.enqueue(encoder.encode(`${lines.map(rewrite).join('\n')}\n`));
    },
    flush(controller) { pending += decoder.decode(); if (pending) controller.enqueue(encoder.encode(rewrite(pending))); },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Claude Code's shape on a pi-ai Anthropic subscription payload: pi-ai starts only those with Claude Code's system
 * block. Any other payload is left as it is (undefined). Strings are shared with pi-ai's payload; only the objects around
 * them are new. */
async function shapePayload(payload: unknown, model: Model<Api>, identity: { deviceId: string; sessionId: string }): Promise<unknown> {
  if (model.api !== 'anthropic-messages') return undefined;
  const probe = SystemProbeSchema.safeParse(payload);
  if (!probe.success || probe.data.system[0]?.text !== CLAUDE_CODE_INSTRUCTION) return undefined;
  // Sent as it is, a subscription request is billed as a third-party app's (extra usage), so one that can't take Claude
  // Code's shape is not sent.
  const parsed = BodySchema.safeParse(payload);
  if (!parsed.success) throw new Error(`Claude subscription request has an unexpected shape (${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}); not sent as a third-party request`);
  const body = parsed.data;
  for (const tool of body.tools ?? []) tool.name = prefixed(tool.name);
  if (body.tool_choice?.name) body.tool_choice.name = prefixed(body.tool_choice.name);
  // Tool changes reference tools by name (`tool_addition`/`tool_removal`), so they name the prefixed declarations too.
  // Renamed in place: every other byte stays as earlier requests sent it, so the prompt cache still matches.
  for (const message of body.messages) if (Array.isArray(message.content)) for (const block of message.content) {
    const use = ToolUseSchema.safeParse(block);
    if (use.success) Object.assign(block, { name: prefixed(use.data.name) });
    const change = ToolChangeSchema.safeParse(block);
    if (change.success) Object.assign(block, { tool: { ...change.data.tool, name: prefixed(change.data.tool.name) } });
  }
  body.metadata = { user_id: JSON.stringify({ device_id: identity.deviceId, session_id: identity.sessionId }) };
  // The SDK sends `betas` as the anthropic-beta header, where fetch orders it as Claude Code does.
  if (body.output_config !== undefined) body.betas = [...(Array.isArray(body.betas) ? body.betas : []), EFFORT_BETA];
  const firstUser = body.messages.find(message => message.role === 'user')?.content;
  const text = typeof firstUser === 'string' ? firstUser : firstUser?.flatMap(block => { const parsed = TextSchema.safeParse(block); return parsed.success ? [parsed.data.text] : []; })[0] ?? '';
  const fingerprint = (await sha256Hex(`${FINGERPRINT_SALT}${[4, 7, 20].map(index => text[index] ?? '0').join('')}${CLAUDE_CODE_VERSION}`)).slice(0, 3);
  body.system = [{ type: 'text', text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};` }, ...body.system];
  return body;
}

const encoder = new TextEncoder();
const scratch = new Uint8Array(ENCODE_UNITS * 3);
/** Node and Bun send a stream body only half duplex; Workers accept the option. */
const HALF_DUPLEX = { duplex: 'half' };
/** Workers' stream that sends its readable side as a body of exactly `expectedLength` bytes, with that Content-Length;
 * Workers send any other stream body chunked whatever its Content-Length header. Absent in Node and Bun, which send
 * the Content-Length header given. */
declare const FixedLengthStream: (new (expectedLength: number) => TransformStream<Uint8Array, Uint8Array>) | undefined;

/** The ranges of `body`'s code units encoded one at a time: at most ENCODE_UNITS, never splitting a surrogate pair, and
 * one starting at `digits`. */
function* ranges(body: string, digits: number): Generator<{ start: number; end: number }> {
  for (let start = 0; start < body.length;) {
    const stop = start < digits ? digits : body.length;
    let end = Math.min(start + ENCODE_UNITS, stop);
    if (end < stop && (body.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
    yield { start, end };
    start = end;
  }
}

/** Claude Code's headers on a pi-ai subscription request, all but its Content-Length. Throws when pi-ai's request does
 * not present the Claude Code release the shape is made for: it would be billed as a third-party request. */
function claudeCodeHeaders(incoming: Headers, identity: { sessionId: string }): Headers {
  const version = /^claude-cli\/([^\s(]+)/.exec(incoming.get('user-agent') ?? '')?.[1];
  if (!version) throw new Error('Claude subscription request has no claude-cli user agent; not sent as a third-party request');
  if (version !== CLAUDE_CODE_VERSION) throw new Error(`pi-ai presents Claude Code ${version} but requests are shaped as ${CLAUDE_CODE_VERSION}; update CLAUDE_CODE_VERSION. Not sent as a third-party request`);
  const headers = new Headers(incoming);
  const betas = (incoming.get('anthropic-beta') ?? '').split(',').map(beta => beta.trim()).filter(Boolean);
  headers.set('anthropic-beta', [...new Set([...AGENT_BETAS, ...(betas.includes(EFFORT_BETA) ? [EFFORT_BETA] : []), ...betas])].join(','));
  headers.set('user-agent', CLAUDE_CODE_USER_AGENT);
  headers.set('x-claude-code-session-id', identity.sessionId);
  for (const [name, value] of Object.entries(CLAUDE_CODE_HEADERS)) headers.set(name, value);
  headers.delete('content-length');
  return headers;
}

/** The billing block's attestation digits in a serialized subscription body; throws when it has none. */
function attestationDigits(body: string): number {
  const digits = attestationOffset(body);
  if (digits === null) throw new Error("Claude subscription request does not start with Claude Code's system block or has no attestation placeholder; not sent as a third-party request");
  return digits;
}

/** The headers and body a shaped subscription request goes out with: the attestation hashes the body's UTF-8 with the
 * placeholder in place, then is written over that placeholder in the billing block (message text serializes first and
 * may contain the same placeholder). The body is encoded as it is sent, chunk by chunk, never as a whole. */
function attest(body: string, digits: number, headers: Headers): { headers: Headers; body: ReadableStream<Uint8Array> } {
  const hash = new XxHash64(CCH_SEED);
  let length = 0;
  for (const { start, end } of ranges(body, digits)) {
    const { written } = encoder.encodeInto(body.slice(start, end), scratch);
    hash.update(scratch.subarray(0, written));
    length += written;
  }
  const cch = encoder.encode((hash.digest() & 0xfffffn).toString(16).padStart(5, '0'));
  const chunks = ranges(body, digits);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next();
      if (next.done) return controller.close();
      const bytes = encoder.encode(body.slice(next.value.start, next.value.end));
      if (next.value.start === digits) bytes.set(cch);
      controller.enqueue(bytes);
    },
  });
  headers.set('content-length', String(length));
  return { headers, body: typeof FixedLengthStream === 'function' ? stream.pipeThrough(new FixedLengthStream(length)) : stream };
}

const CLAUDE_CODE_BLOCKS: Record<string, true> = { text: true, image: true, document: true, tool_use: true, tool_result: true, thinking: true, redacted_thinking: true, tool_addition: true, tool_removal: true };
/** The shape of a request Anthropic refused as a third-party app's: sizes, block counts and unusual blocks, no content. */
function requestShape(body: string): JsonShape {
  const parsed = BodySchema.safeParse(JSON.parse(body));
  if (!parsed.success) return { bytes: body.length, parsed: false };
  const counts: Record<string, number> = {};
  const unusual: JsonShape[] = [];
  parsed.data.messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      counts[`${message.role}:${block.type}`] = (counts[`${message.role}:${block.type}`] ?? 0) + 1;
      const fields = Object.entries(block);
      if (CLAUDE_CODE_BLOCKS[block.type] && fields.every(([key, value]) => (key !== 'name' && key !== 'text') || typeof value === 'string')) continue;
      if (unusual.length < 12) unusual.push({ index, role: message.role, type: block.type, fields: fields.map(([key, value]) => `${key}:${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`).join(',') });
    }
  });
  return { bytes: body.length, messages: parsed.data.messages.length, tools: parsed.data.tools?.length ?? 0, systemBlocks: parsed.data.system.length, counts, unusual };
}
type JsonShape = { [key: string]: string | number | boolean | Record<string, number> | JsonShape[] };
/** Transport for admitted credentials: `fetch` never follows redirects, and with `onPayload` Claude subscription
 * requests go out as Claude Code's. */
export interface ClaudeCodeTransport { fetch: typeof fetch; onPayload(payload: unknown, model: Model<Api>): Promise<unknown> }
/** `identity` is the Claude Code session requests are shaped as: the device is the profile's, the session the caller's.
 * A request carrying stored image references goes through `images`, which writes the images in and, for a subscription
 * request, attests the result; any other request is sent from here. */
export async function claudeCode(session: { profileId: string; sessionId: string }, images?: ImageRequestTransport): Promise<ClaudeCodeTransport> {
  const identity = { deviceId: await sha256Hex(`gitspace-claude-device-v1:${session.profileId}`), sessionId: session.sessionId };
  return {
    onPayload: (payload, model) => shapePayload(payload, model, identity),
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : null;
      const stored = body !== null && requestImages(body).length > 0;
      const subscription = url.startsWith('https://api.anthropic.com/v1/messages') && headers.get('authorization')?.startsWith('Bearer sk-ant-oat') === true;
      if (!subscription && !stored) return fetch(input, { ...init, redirect: 'manual' });
      let payload: string;
      let sentHeaders: Headers;
      let digits: number | null = null;
      let transport: ImageRequestTransport | null = null;
      // A refused request answers as Anthropic's own 400 would: the SDK reports a throw from fetch as a retried
      // "Connection error." and drops the reason.
      try {
        if (body === null) throw new Error('Claude subscription request body is not serialized JSON; not sent as a third-party request');
        payload = body;
        if (stored) {
          if (!images) throw new Error('This request carries stored images, which only the inference Worker can send');
          transport = images;
        }
        sentHeaders = subscription ? claudeCodeHeaders(headers, identity) : headers;
        if (subscription) digits = attestationDigits(payload);
      } catch (error) { return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: error instanceof Error ? error.message : String(error) } }, { status: 400 }); }
      let response: Response;
      if (transport) {
        sentHeaders.delete('content-length');
        // The inference Worker's call cannot carry an AbortSignal: an aborted request stops waiting for it at once (Stop
        // waits for the request to end), and its response is cancelled whenever it arrives.
        const signal = init?.signal ?? undefined;
        signal?.throwIfAborted();
        const sending = transport({ url, method: init?.method ?? 'POST', headers: [...sentHeaders], payload, attest: digits !== null });
        const aborted = Promise.withResolvers<never>();
        const onAbort = () => aborted.reject(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        try { response = await Promise.race([sending, aborted.promise]); }
        catch (error) { void sending.then(late => late.body?.cancel(), () => undefined); throw error; }
        finally { signal?.removeEventListener('abort', onAbort); }
      } else {
        const sent = attest(payload, digits!, sentHeaders);
        response = await fetch(input, { ...init, ...HALF_DUPLEX, headers: sent.headers, body: sent.body, redirect: 'manual' });
      }
      if (!subscription) return response;
      if (response.status >= 400) {
        const text = await response.clone().text();
        if (text.includes('extra usage')) console.error(JSON.stringify({ event: 'claude_subscription_billed_as_third_party', status: response.status, betas: sentHeaders.get('anthropic-beta'), shape: requestShape(payload) }));
      }
      return unprefixToolUse(response);
    },
  };
}
