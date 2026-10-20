import { z } from 'zod';

/**
 * Claude subscription (OAuth) requests are billed to the plan only when they look like Claude Code's: pi-ai sends a
 * partial identity, and Anthropic charged every GitSpace request to extra usage. This rewrites pi-ai's request to the
 * shape oh-my-pi's Anthropic provider sends (captured from it): Claude Code headers and betas, a JSON
 * `metadata.user_id`, `_`-prefixed tool names, and the billing system block with its `cch` attestation. Tool names in
 * the streamed response are restored. Every other request passes through unchanged.
 */
const CLAUDE_CODE_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";
const FINGERPRINT_SALT = '59cf53e54c78';
const CCH_PLACEHOLDER = 'cch=00000';
const CCH_SEED = 0x4d659218e32a3268n;
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
const BlockSchema = z.object({ type: z.string(), name: z.string().optional(), text: z.string().optional(), tool: NamedSchema.optional() }).loose();
const MessageSchema = z.object({ role: z.string(), content: z.union([z.string(), z.array(BlockSchema)]) }).loose();
const BodySchema = z.object({
  messages: z.array(MessageSchema),
  system: z.array(z.object({ type: z.literal('text'), text: z.string() }).loose()),
  tools: z.array(NamedSchema).optional(),
  tool_choice: z.object({ type: z.string(), name: z.string().optional() }).loose().optional(),
  output_config: z.unknown().optional(),
}).loose();
const ToolStartSchema = z.object({ type: z.literal('content_block_start'), content_block: z.object({ type: z.literal('tool_use'), name: z.string() }).loose() }).loose();

const MASK = 0xffffffffffffffffn;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;
const rotl = (value: bigint, bits: bigint) => ((value << bits) | (value >> (64n - bits))) & MASK;
const round = (accumulator: bigint, lane: bigint) => (rotl((accumulator + lane * PRIME2) & MASK, 31n) * PRIME1) & MASK;

/** XXH64; Workers have no native xxHash. */
export function xxHash64(bytes: Uint8Array, seed: bigint): bigint {
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

/** Rewrites a pi-ai Claude subscription request to Claude Code's shape; returns undefined for any other request. */
export async function claudeCodeRequest(input: RequestInfo | URL, init: RequestInit | undefined, identity: { deviceId: string; sessionId: string }): Promise<RequestInit | undefined> {
  const raw = init?.body;
  if (typeof raw !== 'string') return undefined;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.anthropic.com/v1/messages')) return undefined;
  const headers = new Headers(init?.headers);
  if (!headers.get('authorization')?.startsWith('Bearer sk-ant-oat')) return undefined;
  const version = /^claude-cli\/([^\s(]+)/.exec(headers.get('user-agent') ?? '')?.[1];
  const parsed = BodySchema.safeParse(JSON.parse(raw));
  if (!version || !parsed.success || parsed.data.system[0]?.text !== CLAUDE_CODE_INSTRUCTION) return undefined;
  const body = parsed.data;

  for (const tool of body.tools ?? []) tool.name = prefixed(tool.name);
  if (body.tool_choice?.name) body.tool_choice.name = prefixed(body.tool_choice.name);
  // Tool changes reference tools by name (`tool_addition`/`tool_removal`), so they name the prefixed declarations too.
  for (const message of body.messages) if (Array.isArray(message.content)) for (const block of message.content) {
    if (block.type === 'tool_use' && block.name) block.name = prefixed(block.name);
    if ((block.type === 'tool_addition' || block.type === 'tool_removal') && block.tool) block.tool.name = prefixed(block.tool.name);
  }
  body.metadata = { user_id: JSON.stringify({ device_id: identity.deviceId, session_id: identity.sessionId }) };
  const firstUser = body.messages.find(message => message.role === 'user')?.content;
  const text = typeof firstUser === 'string' ? firstUser : firstUser?.find(block => block.type === 'text')?.text ?? '';
  const fingerprint = (await sha256Hex(`${FINGERPRINT_SALT}${[4, 7, 20].map(index => text[index] ?? '0').join('')}${version}`)).slice(0, 3);
  body.system = [{ type: 'text', text: `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};` }, ...body.system];
  // The attestation hashes the final body with the placeholder in place, then replaces it.
  const placeholderBody = JSON.stringify(body);
  const cch = (xxHash64(new TextEncoder().encode(placeholderBody), CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0');
  const at = placeholderBody.indexOf(CCH_PLACEHOLDER);

  const betas = (headers.get('anthropic-beta') ?? '').split(',').map(beta => beta.trim()).filter(Boolean);
  headers.set('anthropic-beta', [...new Set([...AGENT_BETAS, ...(body.output_config === undefined ? [] : [EFFORT_BETA]), ...betas])].join(','));
  headers.set('user-agent', `claude-cli/${version} (external, cli)`);
  headers.set('x-claude-code-session-id', identity.sessionId);
  for (const [name, value] of Object.entries(CLAUDE_CODE_HEADERS)) headers.set(name, value);
  return { ...init, headers, body: `${placeholderBody.slice(0, at)}cch=${cch}${placeholderBody.slice(at + CCH_PLACEHOLDER.length)}` };
}

/** Fetch for admitted credentials: never follows redirects; Claude subscription requests go out as Claude Code. */
export async function claudeCodeFetch(profileId: string): Promise<typeof fetch> {
  const identity = { deviceId: await sha256Hex(`gitspace-claude-device-v1:${profileId}`), sessionId: crypto.randomUUID() };
  return async (input, init) => {
    const rewritten = await claudeCodeRequest(input, init, identity);
    const response = await fetch(input, { ...(rewritten ?? init), redirect: 'manual' });
    return rewritten ? unprefixToolUse(response) : response;
  };
}
