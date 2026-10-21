import { afterEach, expect, it, vi } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import { claudeCode, xxHash64 } from './claude-code-request.js';

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
  return { cch, hashed, valid: (xxHash64(new TextEncoder().encode(hashed), 0x4d659218e32a3268n) & 0xfffffn).toString(16).padStart(5, '0') === cch };
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** What reaches the network: bodies as text, headers as sent. */
function network(reply: () => Response = () => new Response('{}')) {
  const sent: Array<{ body: string; headers: Headers }> = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ body: typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body instanceof Uint8Array ? init.body : new Uint8Array()), headers: new Headers(init?.headers) });
    return reply();
  });
  return sent;
}

/** A request as the Anthropic SDK makes it: the payload pi-ai built, shaped by `onPayload`, serialized once, with its
 * `betas` moved to the anthropic-beta header. */
async function send(body: Record<string, unknown>, headers: Record<string, string> = oauth) {
  const transport = await claudeCode('profile');
  const shaped = await transport.onPayload(body, anthropic) ?? body;
  if (typeof shaped !== 'object' || shaped === null) throw new Error('Unexpected payload');
  const { betas, ...rest } = Object.fromEntries(Object.entries(shaped));
  const header = [headers['anthropic-beta'], ...(Array.isArray(betas) ? betas : [])].filter(Boolean).join(',');
  return transport.fetch('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', body: JSON.stringify(rest), headers: { ...headers, 'anthropic-beta': header } });
}

it('matches the reference XXH64', () => {
  expect(xxHash64(new Uint8Array(), 0n)).toBe(0xef46db3751d8e999n);
  expect(xxHash64(new TextEncoder().encode('abc'), 0n)).toBe(0x44bc2cf5ad770999n);
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
