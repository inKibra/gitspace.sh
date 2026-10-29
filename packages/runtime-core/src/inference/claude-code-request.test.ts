import { afterEach, expect, it, vi } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import { claudeCode, XxHash64 } from './claude-code-request.js';
import { createHash } from 'node:crypto';
import { ENCODE_UNITS, expandedRequest, imageReference, type ImageReader, type ImageRequestTransport } from './image-requests.js';

const MASK = 0xffffffffffffffffn;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;
const CCH_SEED = 0x4d659218e32a3268n;
const BILLING_BLOCK = '"system":[{"type":"text","text":"x-anthropic-billing-header:';
const rotl = (value: bigint, bits: bigint) => ((value << bits) | (value >> (64n - bits))) & MASK;
const round = (accumulator: bigint, lane: bigint) => (rotl((accumulator + lane * PRIME2) & MASK, 31n) * PRIME1) & MASK;

/** XXH64 over the whole input at once: the reference the streaming hash must equal. */
function xxHash64(bytes: Uint8Array, seed: bigint): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  let offset = 0;
  let hash: bigint;
  if (length >= 32) {
    let v1 = (seed + PRIME1 + PRIME2) & MASK, v2 = (seed + PRIME2) & MASK, v3 = seed & MASK, v4 = (seed - PRIME1) & MASK;
    for (; offset + 32 <= length; offset += 32) {
      v1 = round(v1, view.getBigUint64(offset, true));
      v2 = round(v2, view.getBigUint64(offset + 8, true));
      v3 = round(v3, view.getBigUint64(offset + 16, true));
      v4 = round(v4, view.getBigUint64(offset + 24, true));
    }
    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    for (const lane of [v1, v2, v3, v4]) hash = (((hash ^ round(0n, lane)) * PRIME1) + PRIME4) & MASK;
  } else hash = (seed + PRIME5) & MASK;
  hash = (hash + BigInt(length)) & MASK;
  for (; offset + 8 <= length; offset += 8) hash = ((rotl(hash ^ round(0n, view.getBigUint64(offset, true)), 27n) * PRIME1) + PRIME4) & MASK;
  if (offset + 4 <= length) { hash = ((rotl(hash ^ ((BigInt(view.getUint32(offset, true)) * PRIME1) & MASK), 23n) * PRIME2) + PRIME3) & MASK; offset += 4; }
  for (; offset < length; offset++) hash = (rotl(hash ^ ((BigInt(bytes[offset]!) * PRIME5) & MASK), 11n) * PRIME1) & MASK;
  hash ^= hash >> 33n; hash = (hash * PRIME2) & MASK;
  hash ^= hash >> 29n; hash = (hash * PRIME3) & MASK;
  return hash ^ (hash >> 32n);
}

/** A serialized subscription body attested as one encoded array: the reference the streamed body must equal. */
function attestedWhole(json: string): Uint8Array {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(json);
  const digits = encoder.encode(json.slice(0, json.indexOf('cch=00000', json.indexOf(BILLING_BLOCK)))).byteLength + 'cch='.length;
  bytes.set(encoder.encode((xxHash64(bytes, CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0')), digits);
  return bytes;
}

/** Deterministic bytes for hash comparisons. */
function noise(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function streamed(seed: bigint, bytes: Uint8Array, splits: number[]): bigint {
  const hash = new XxHash64(seed);
  let from = 0;
  for (const split of [...splits, bytes.byteLength]) { hash.update(bytes.subarray(from, split)); from = split; }
  return hash.digest();
}

const user = 'why do we need per feed locking. alarms are interesting';
type Payload = { messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; [key: string]: unknown };
const payload = (): Payload => ({
  model: 'claude-opus-5-5',
  messages: [
    { role: 'user', content: [{ type: 'text', text: user }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
  ],
  max_tokens: 64000,
  stream: true,
  system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: 'Project instructions' }],
  tools: [{ name: 'read', input_schema: { type: 'object' } }, { name: 'web_search', input_schema: { type: 'object' } }],
  output_config: { effort: 'medium' },
  betas: ['thinking-binding-controls-2026-08-01'],
});
const oauth = { authorization: 'Bearer sk-ant-oat01-x', 'user-agent': 'claude-cli/2.1.280', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' };
const anthropic: Model<Api> = { id: 'claude-opus-5-5', name: 'Opus', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 64000 };
const attested = (sent: string) => {
  const cch = /cc_entrypoint=cli; cch=([0-9a-f]{5});/.exec(sent)![1]!;
  const hashed = sent.replace(`cc_entrypoint=cli; cch=${cch};`, 'cc_entrypoint=cli; cch=00000;');
  return { cch, hashed, valid: (xxHash64(new TextEncoder().encode(hashed), CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0') === cch };
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; Reflect.deleteProperty(globalThis, 'FixedLengthStream'); });

/** What reaches the network: bodies as bytes, the chunks they came in, and text; headers as sent. */
function network(reply: () => Response = () => new Response('{}')) {
  const sent: Array<{ body: string; bytes: Uint8Array; chunks: Uint8Array[]; streamed: boolean; headers: Headers }> = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const chunks: Uint8Array[] = [];
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      for (let read = await reader.read(); !read.done; read = await reader.read()) chunks.push(read.value);
    } else if (typeof body === 'string') chunks.push(new TextEncoder().encode(body));
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    sent.push({ body: new TextDecoder().decode(bytes), bytes, chunks, streamed: body instanceof ReadableStream, headers: new Headers(init?.headers) });
    return reply();
  });
  return sent;
}

const MESSAGES = 'https://api.anthropic.com/v1/messages?beta=true';
/** A request as the Anthropic SDK makes it: the payload pi-ai built, shaped by `onPayload`, serialized once, with its
 * `betas` moved to the anthropic-beta header. */
async function serialize(transport: { onPayload(payload: unknown, model: Model<Api>): Promise<unknown> }, body: Record<string, unknown>, headers: Record<string, string> = oauth) {
  const shaped = await transport.onPayload(body, anthropic) ?? body;
  if (typeof shaped !== 'object' || shaped === null) throw new Error('Unexpected payload');
  const { betas, ...rest } = Object.fromEntries(Object.entries(shaped));
  const header = [headers['anthropic-beta'], ...(Array.isArray(betas) ? betas : [])].filter(Boolean).join(',');
  return { method: 'POST', body: JSON.stringify(rest), headers: { ...headers, 'anthropic-beta': header } };
}

async function send(body: Record<string, unknown>, headers: Record<string, string> = oauth) {
  const transport = await claudeCode('profile');
  return transport.fetch(MESSAGES, await serialize(transport, body, headers));
}

it('hashes input fed in pieces as XXH64 of the whole, wherever it is split', () => {
  expect(streamed(0n, new Uint8Array(), [])).toBe(0xef46db3751d8e999n);
  expect(streamed(0n, new TextEncoder().encode('abc'), [1])).toBe(0x44bc2cf5ad770999n);
  for (let length = 0; length <= 100; length++) {
    const bytes = noise(length, length + 1);
    const whole = xxHash64(bytes, CCH_SEED);
    for (let split = 0; split <= length; split++) expect(streamed(CCH_SEED, bytes, [split])).toBe(whole);
    for (let split = 0; split + 31 <= length; split++) expect(streamed(CCH_SEED, bytes, [split, split + 1, split + 31])).toBe(whole);
  }
  for (let trial = 0; trial < 40; trial++) {
    const bytes = noise(1 + trial * 97, trial);
    const splits = [...noise(8, trial + 1000)].map(byte => Math.floor(byte / 256 * bytes.byteLength)).sort((left, right) => left - right);
    expect(streamed(CCH_SEED, bytes, splits)).toBe(xxHash64(bytes, CCH_SEED));
  }
});

it('streams a subscription body in bounded chunks with its Content-Length, byte for byte as attesting it whole, on every attempt', async () => {
  const transport = await claudeCode('profile');
  const sent = network();
  // Emoji and multi-byte characters lie across the chunk edges, each shift putting a different one on them.
  for (let shift = 0; shift < 5; shift++) {
    const body = payload();
    body.messages[0]!.content[0]!.text = `${'a'.repeat(shift)}${'😀'.repeat(ENCODE_UNITS / 2 + 8)}${'é中😀a'.repeat(ENCODE_UNITS / 4)}`;
    const init = await serialize(transport, body);
    const whole = attestedWhole(init.body);
    await transport.fetch(MESSAGES, init);
    await transport.fetch(MESSAGES, init);
    expect(sent).toHaveLength(2);
    for (const request of sent.splice(0)) {
      expect(request.streamed).toBe(true);
      expect(request.bytes).toEqual(whole);
      expect(request.headers.get('content-length')).toBe(String(whole.byteLength));
      expect(request.chunks.length).toBeGreaterThan(2);
      expect(Math.max(...request.chunks.map(chunk => chunk.byteLength))).toBeLessThanOrEqual(ENCODE_UNITS * 3);
    }
  }
});

it('attests in the billing block when a chunk edge cuts through it or through a quoted placeholder', async () => {
  const transport = await claudeCode('profile');
  const sent = network();
  const marked = payload();
  marked.messages[0]!.content[0]!.text = 'MARK';
  const probe = (await serialize(transport, marked)).body;
  const textAt = probe.indexOf('MARK');
  const billingAt = probe.indexOf('cch=00000', probe.indexOf(BILLING_BLOCK)) - 'MARK'.length;
  for (let cut = 0; cut <= 'cch=00000'.length; cut++) {
    const quoted = `${'x'.repeat(ENCODE_UNITS - cut - textAt)}cch=00000`;
    const body = payload();
    body.messages[0]!.content[0]!.text = `${quoted}${'y'.repeat(2 * ENCODE_UNITS - cut - billingAt - quoted.length)}`;
    const init = await serialize(transport, body);
    expect(init.body.indexOf('cch=00000')).toBe(ENCODE_UNITS - cut);
    expect(init.body.indexOf('cch=00000', init.body.indexOf(BILLING_BLOCK))).toBe(2 * ENCODE_UNITS - cut);
    await transport.fetch(MESSAGES, init);
    expect(sent.at(-1)!.bytes).toEqual(attestedWhole(init.body));
  }
});

it('sends the body through a FixedLengthStream of its byte length where Workers provide one, since Workers send other streams chunked', async () => {
  const lengths: number[] = [];
  Reflect.set(globalThis, 'FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expected: number) {
      let seen = 0;
      super({ transform(chunk, controller) { seen += chunk.byteLength; controller.enqueue(chunk); }, flush() { if (seen !== expected) throw new Error(`${seen} bytes sent, ${expected} declared`); } });
      lengths.push(expected);
    }
  });
  const transport = await claudeCode('profile');
  const sent = network();
  const body = payload();
  body.messages[0]!.content[0]!.text = '😀é中'.repeat(ENCODE_UNITS);
  const init = await serialize(transport, body);
  await transport.fetch(MESSAGES, init);
  const whole = attestedWhole(init.body);
  expect(lengths).toEqual([whole.byteLength]);
  expect(sent[0]!.bytes).toEqual(whole);
});

it('sends a pi-ai Claude subscription request as the SDK serialized the shaped payload, with only the attestation written in', async () => {
  const provider = builtinProviders().find(candidate => candidate.id === 'anthropic');
  if (!provider) throw new Error('Anthropic provider missing');
  const models = createModels();
  models.setProvider({ ...provider, auth: { apiKey: { name: 'Subscription token', resolve: async () => ({ auth: { apiKey: 'sk-ant-oat01-x' } }) } } });
  const model = models.getModel('anthropic', 'claude-opus-5-5');
  if (!model) throw new Error('Anthropic catalog model missing');
  const transport = await claudeCode('profile');
  const shaped: unknown[] = [];
  const sent = network(() => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await models.streamSimple(model, { systemPrompt: 'Project instructions', messages: [{ role: 'user', content: user, timestamp: 1 }] }, {
    fetch: transport.fetch, onPayload: async (body, selected) => { const result = await transport.onPayload(body, selected); shaped.push(result); return result; },
  }).result();
  expect(sent).toHaveLength(1);
  const { cch, hashed, valid } = attested(sent[0]!.body);
  expect(valid).toBe(true);
  expect(cch).not.toBe('00000');
  const [body] = shaped;
  if (typeof body !== 'object' || body === null) throw new Error('Payload was not shaped');
  // pi-ai sends the shaped payload with `stream`; the SDK takes `betas` out for the header.
  const serialized: Record<string, unknown> = { ...Object.fromEntries(Object.entries(body)), stream: true };
  delete serialized.betas;
  expect(hashed).toBe(JSON.stringify(serialized));
  expect(JSON.parse(hashed).system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.280\.938; cc_entrypoint=cli; cch=00000;$/);
});

it('sends a Claude subscription request in Claude Code shape', async () => {
  const sent = network();
  await send(payload());
  const { headers, body } = sent[0]!;
  expect(headers.get('user-agent')).toBe('claude-cli/2.1.280 (external, cli)');
  expect(headers.get('x-claude-code-session-id')).toMatch(/^[0-9a-f-]{36}$/);
  expect(headers.get('x-stainless-package-version')).toBe('0.112.1');
  expect(headers.get('anthropic-beta')?.split(',')).toEqual(['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'thinking-token-count-2026-05-13', 'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05', 'mid-conversation-system-2026-04-07', 'fallback-credit-2026-06-01', 'effort-2025-11-24', 'thinking-binding-controls-2026-08-01']); // gitleaks:allow (public Anthropic beta names)
  const parsed = JSON.parse(body);
  // The fingerprint suffix comes from oh-my-pi's createClaudeBillingHeader for this first user message.
  expect(parsed.system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.280\.938; cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
  expect(parsed.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  expect(attested(body).valid).toBe(true);
  expect(JSON.parse(parsed.metadata.user_id)).toMatchObject({ device_id: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(parsed.tools.map((tool: { name: string }) => tool.name)).toEqual(['_read', 'web_search']);
  expect(parsed.messages[1].content[0].name).toBe('_read');
  expect(parsed.betas).toBeUndefined();
});

it('names the prefixed tools in mid-conversation tool changes, so every reference matches a declared tool', async () => {
  const sent = network();
  const changed = { ...payload(), tools: [{ name: 'read', input_schema: { type: 'object' } }, { name: 'apply_patch', input_schema: { type: 'object' }, defer_loading: true }] };
  changed.messages.push({ role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'apply_patch' } }, { type: 'tool_addition', tool: { type: 'tool_reference', name: 'read' } }] });
  await send(changed);
  const parsed = JSON.parse(sent[0]!.body);
  const declared = parsed.tools.map((tool: { name: string }) => tool.name);
  expect(parsed.messages.at(-1).content.map((block: { type: string; tool: { name: string } }) => [block.type, block.tool.name])).toEqual([['tool_removal', '_apply_patch'], ['tool_addition', '_read']]);
  expect(parsed.messages.at(-1).content.every((block: { tool: { name: string } }) => declared.includes(block.tool.name))).toBe(true);
});

it('attests in the billing header even when the conversation quotes the placeholder', async () => {
  const sent = network();
  const quoting = payload();
  quoting.messages.push({ role: 'user', content: [{ type: 'text', text: 'the header ends in cch=00000;' }] });
  await send(quoting);
  const parsed = JSON.parse(sent[0]!.body);
  expect(parsed.messages.at(-1).content[0].text).toBe('the header ends in cch=00000;');
  const { cch, valid } = attested(sent[0]!.body);
  expect(cch).not.toBe('00000');
  expect(valid).toBe(true);
});

it('refuses to send a subscription request it cannot shape like Claude Code, since Anthropic would bill it as a third-party app', async () => {
  const sent = network();
  const odd = { ...payload(), messages: [{ role: 'user', content: [{ text: 'a block without a type' }] }] };
  await expect(send(odd)).rejects.toThrow(/unexpected shape \(messages\.0\.content/);
  // Not started with Claude Code's block, so left unshaped: fetch answers as Anthropic's own 400 rather than a retried
  // connection error.
  const plain = await send({ ...payload(), system: [{ type: 'text', text: 'Some other agent' }] });
  expect(plain.status).toBe(400);
  expect((await plain.json()).error.message).toMatch(/Claude Code's system block/);
  const drifted = await send(payload(), { ...oauth, 'user-agent': 'claude-cli/2.2.0' });
  expect(drifted.status).toBe(400);
  expect((await drifted.json()).error.message).toMatch(/update CLAUDE_CODE_VERSION/);
  expect(sent).toHaveLength(0);
});

it('shapes requests holding blocks it does not touch, whatever their fields, and renames in place', async () => {
  const sent = network();
  const other = { type: 'server_block', name: 3, text: { nested: true }, tool: 'not a reference' };
  const mixed = payload();
  mixed.messages.push({ role: 'assistant', content: [other] });
  await send(mixed);
  expect(JSON.parse(sent[0]!.body).messages.at(-1).content).toEqual([other]);
  // Key order kept, so the cached prompt prefix still matches earlier requests.
  expect(sent[0]!.body).toContain('{"type":"tool_use","id":"t1","name":"_read","input":{"path":"a"}}');
});

it('leaves API-key and other providers untouched', async () => {
  const transport = await claudeCode('profile');
  expect(await transport.onPayload(payload(), { ...anthropic, api: 'openai-responses' })).toBeUndefined();
  const sent = network();
  const body = JSON.stringify(payload());
  await transport.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body, headers: { 'x-api-key': 'sk-ant-api03-x', 'user-agent': 'claude-cli/2.1.280' } });
  await transport.fetch('https://api.openai.com/v1/responses', { method: 'POST', body, headers: oauth });
  expect(sent.map(request => request.body)).toEqual([body, body]);
});

it('restores tool names in the streamed response', async () => {
  network(() => new Response('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t2","name":"_read","input":{}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const response = await send(payload());
  expect(await response.text()).toContain('"name":"read"');
});

/** Images as the workspace object serves them: streamed in uneven pieces, by reference. */
function stored(images: Uint8Array[]) {
  const references = images.map(bytes => imageReference({ workspaceId: 'ws-1', size: bytes.byteLength, width: 1, height: 1, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const read: ImageReader = async reference => {
    const bytes = images[references.indexOf(reference)];
    if (!bytes) throw new Error(`No image ${reference}`);
    let offset = 0;
    return new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.byteLength) return controller.close(); controller.enqueue(bytes.slice(offset, offset += 7001)); } });
  };
  return { references, read };
}

/** The inference Worker's send, with this file's XXH64 for the WASM one. */
function worker(read: ImageReader, seen: boolean[] = []): ImageRequestTransport {
  return async request => {
    seen.push(request.attest);
    const { length, body } = await expandedRequest(request, read, seed => new XxHash64(seed));
    return fetch(request.url, { method: request.method, headers: [...request.headers, ['content-length', String(length)]], body });
  };
}

const imageBlock = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

it('sends a subscription request with stored images byte for byte as the same request inline, attested over the images', async () => {
  // Images across encode chunks, one of two bytes; text with multi-byte characters across text chunks between them.
  const images = [noise(100_001, 1), noise(2, 2), noise(48 * 1024 * 3 + 1, 3)];
  const { references, read } = stored(images);
  const body = (data: (index: number) => string) => {
    const value = payload();
    value.messages[0]!.content[0]!.text = `${user} 😀é中 ${'x'.repeat(ENCODE_UNITS)}`;
    value.messages[0]!.content.push(imageBlock(data(0)), { type: 'text', text: `the image ${references[0]}` });
    value.messages[2]!.content[0]!.content = [imageBlock(data(1)), { type: 'text', text: 'é' }, imageBlock(data(2))];
    return value;
  };
  const sent = network();
  const attests: boolean[] = [];
  const transport = await claudeCode('profile', worker(read, attests));
  await transport.fetch(MESSAGES, await serialize(transport, body(index => references[index]!)));
  const inline = await serialize(transport, body(index => Buffer.from(images[index]!).toString('base64')));
  expect(attests).toEqual([true]);
  expect(sent[0]!.bytes).toEqual(attestedWhole(inline.body));
  expect(sent[0]!.headers.get('content-length')).toBe(String(sent[0]!.bytes.byteLength));
});

it('sends any other request with stored images, OpenAI data URLs included, as the same request inline and unattested', async () => {
  const images = [noise(5, 4)];
  const { references, read } = stored(images);
  const body = (data: string) => JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }, { type: 'input_text', text: `see ${references[0]}` }] }] });
  const sent = network();
  const attests: boolean[] = [];
  const transport = await claudeCode('profile', worker(read, attests));
  await transport.fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: 'Bearer sk-proj' }, body: body(references[0]!) });
  expect(attests).toEqual([false]);
  expect(sent[0]!.body).toBe(body(Buffer.from(images[0]!).toString('base64')));
});

it('refuses a request carrying stored images where no inference Worker can send it, as Anthropic would', async () => {
  const { references } = stored([noise(3, 5)]);
  const sent = network();
  const transport = await claudeCode('profile');
  const body = payload();
  body.messages[0]!.content.push(imageBlock(references[0]!));
  const response = await transport.fetch(MESSAGES, await serialize(transport, body));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('only the inference Worker can send') } });
  expect(sent).toHaveLength(0);
});

it('refuses a subscription request before sending it when a stored image is not the size its reference states', async () => {
  const bytes = noise(10, 6);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const read: ImageReader = async () => new Response(new Uint8Array(bytes)).body!;
  const request = (size: number) => ({ url: MESSAGES, method: 'POST', headers: [], attest: true, payload: JSON.stringify({ system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cc_entrypoint=cli; cch=00000;' }], messages: [imageBlock(imageReference({ workspaceId: 'ws-1', size, width: 1, height: 1, sha256 }))] }) });
  await expect(expandedRequest(request(11), read, seed => new XxHash64(seed))).rejects.toThrow('smaller than its reference states');
  await expect(expandedRequest(request(9), read, seed => new XxHash64(seed))).rejects.toThrow('larger than its reference states');
});

it('stops waiting for the inference Worker the moment its request is aborted, and cancels the response that arrives later', async () => {
  const { references } = stored([noise(3, 7)]);
  const late = Promise.withResolvers<Response>();
  let cancelled = false;
  const transport = await claudeCode('profile', async () => late.promise);
  const body = payload();
  body.messages[0]!.content.push(imageBlock(references[0]!));
  const controller = new AbortController();
  const sending = transport.fetch(MESSAGES, { ...await serialize(transport, body), signal: controller.signal });
  controller.abort(new Error('Stopped'));
  await expect(sending).rejects.toThrow('Stopped');
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await late.promise;
  await Promise.resolve(); await Promise.resolve();
  expect(cancelled).toBe(true);
});
