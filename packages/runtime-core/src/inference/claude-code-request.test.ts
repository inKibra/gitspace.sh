import { afterEach, expect, it, vi } from 'vitest';
import { claudeCodeFetch, claudeCodeRequest, xxHash64 } from './claude-code-request.js';

const user = 'why do we need per feed locking. alarms are interesting';
const body = JSON.stringify({
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
});
const oauth = { authorization: 'Bearer sk-ant-oat01-x', 'user-agent': 'claude-cli/2.1.280', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,thinking-binding-controls-2026-08-01' };
const identity = { deviceId: 'device', sessionId: 'session' };

afterEach(() => { vi.unstubAllGlobals(); });

it('matches the reference XXH64', () => {
  expect(xxHash64(new Uint8Array(), 0n)).toBe(0xef46db3751d8e999n);
  expect(xxHash64(new TextEncoder().encode('abc'), 0n)).toBe(0x44bc2cf5ad770999n);
});

it('sends a Claude subscription request in Claude Code shape', async () => {
  const request = await claudeCodeRequest('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', body, headers: oauth }, identity);
  const headers = new Headers(request?.headers);
  expect(headers.get('user-agent')).toBe('claude-cli/2.1.280 (external, cli)');
  expect(headers.get('x-claude-code-session-id')).toBe('session');
  expect(headers.get('x-stainless-package-version')).toBe('0.112.1');
  expect(headers.get('anthropic-beta')?.split(',')).toEqual(['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'thinking-token-count-2026-05-13', 'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05', 'mid-conversation-system-2026-04-07', 'fallback-credit-2026-06-01', 'effort-2025-11-24', 'thinking-binding-controls-2026-08-01']);
  const sent = String(request?.body);
  const parsed = JSON.parse(sent);
  // The fingerprint suffix comes from oh-my-pi's createClaudeBillingHeader for this first user message.
  expect(parsed.system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.280\.938; cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
  expect(parsed.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  const cch = /cch=([0-9a-f]{5})/.exec(sent)![1]!;
  expect((xxHash64(new TextEncoder().encode(sent.replace(`cch=${cch}`, 'cch=00000')), 0x4d659218e32a3268n) & 0xfffffn).toString(16).padStart(5, '0')).toBe(cch);
  expect(JSON.parse(parsed.metadata.user_id)).toEqual({ device_id: 'device', session_id: 'session' });
  expect(parsed.tools.map((tool: { name: string }) => tool.name)).toEqual(['_read', 'web_search']);
  expect(parsed.messages[1].content[0].name).toBe('_read');
});

it('leaves API-key and other providers untouched', async () => {
  expect(await claudeCodeRequest('https://api.anthropic.com/v1/messages', { method: 'POST', body, headers: { 'x-api-key': 'sk-ant-api03-x', 'user-agent': 'claude-cli/2.1.280' } }, identity)).toBeUndefined();
  expect(await claudeCodeRequest('https://api.openai.com/v1/responses', { method: 'POST', body, headers: oauth }, identity)).toBeUndefined();
});

it('restores tool names in the streamed response', async () => {
  const stream = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t2","name":"_read","input":{}}}\n\n';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
  const response = await (await claudeCodeFetch('profile'))('https://api.anthropic.com/v1/messages', { method: 'POST', body, headers: oauth });
  expect(await response.text()).toContain('"name":"read"');
});
