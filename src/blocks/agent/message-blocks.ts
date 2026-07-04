/**
 * Maps Pi SDK session messages into transcript blocks — the storage-free heart
 * of the chat cutover. Blocks are a *projection*: the SDK session (its in-memory
 * `messages` for the active session, or `SessionManager.open(file)` for history)
 * is the single source of truth. We never persist or duplicate the transcript;
 * we map a window of messages on demand.
 *
 * Type-only SDK imports (erased at build → no runtime dep / web-bundle impact).
 * Runs on the session-owning (server) side, which ships the resulting blocks.
 */
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from '@oh-my-pi/pi-ai';
import type { Block } from '../index.js';

// Primary input keys across the 16.3.4 builtin tools, in priority order (most
// descriptive first, bare operation enums last). Covers read/edit/write (path),
// bash/ssh (command), grep/ast_grep (pattern/pat), eval (code), task (assignment),
// checkpoint (goal), rewind (report), learn (memory), ssh (host), manage_skill
// (name), edit hashline (input), inspect_image (question), and the op/action
// enums (github/irc/todo/lsp/debug/browser).
const TARGET_KEYS = [
  'file_path', 'path', 'command', 'cmd', 'pattern', 'pat', 'url', 'query', 'prompt',
  'code', 'assignment', 'description', 'context', 'message',
  'host', 'goal', 'report', 'memory', 'name', 'input', 'content', 'question',
  'op', 'action',
];

// Array-shaped inputs → a concise "N things" summary (ask/task.batch/retain/ast_edit).
const ARRAY_TARGET_KEYS: Array<[string, string]> = [
  ['tasks', 'subtask'],
  ['questions', 'question'],
  ['items', 'item'],
  ['paths', 'file'],
];

function clip(value: string, max = 80): string {
  const firstLine = value.trim().split('\n')[0]?.trim() ?? '';
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/** A readable one-line target for a tool call, picked from its arguments. */
function toolTarget(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const [key, noun] of ARRAY_TARGET_KEYS) {
    const value = args[key];
    if (Array.isArray(value) && value.length > 0) {
      return `${value.length} ${noun}${value.length === 1 ? '' : 's'}`;
    }
  }
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return clip(value);
  }
  return undefined;
}

function joinText(content: string | ReadonlyArray<TextContent | ImageContent>): string {
  if (typeof content === 'string') return content.trim();
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function imageBlocks(content: string | ReadonlyArray<TextContent | ImageContent>, idBase: string): Block[] {
  if (typeof content === 'string') return [];
  return content
    .filter((part): part is ImageContent => part.type === 'image')
    .map((part, i) => ({ id: `${idBase}:img${i}`, type: 'image', data: { src: `data:${part.mimeType};base64,${part.data}` } }));
}

// File extension → shiki language id (kept small + dependency-free since this
// runs in the React-free shared layer; @pierre/diffs highlights when `lang` is set).
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', scala: 'scala', lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir',
  json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  md: 'markdown', mdx: 'mdx', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  vue: 'vue', svelte: 'svelte', astro: 'astro', hcl: 'hcl', tf: 'hcl',
};

function langFromPath(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (base === 'dockerfile') return 'docker';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return EXT_LANG[ext];
}

/** A tool result's content → nested blocks (text → code, image → image). */
function toolResultBlocks(result: ToolResultMessage, idBase: string, lang?: string): Block[] {
  const blocks: Block[] = [];
  const text = result.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  if (text.trim()) blocks.push({ id: `${idBase}:out`, type: 'code', data: lang ? { text, lang } : { text } });
  result.content
    .filter((part): part is ImageContent => part.type === 'image')
    .forEach((part, i) => blocks.push({ id: `${idBase}:img${i}`, type: 'image', data: { src: `data:${part.mimeType};base64,${part.data}` } }));
  return blocks;
}

/**
 * Formatted, full input for a tool call — nested blocks shown when the call is
 * expanded (so the whole eval code / task assignment / bash command is visible,
 * not just the one-line target). Only produced for tools whose input is
 * substantial; simple tools rely on the one-line `target`.
 */
function toolInputBlocks(call: ToolCall, idBase: string): Block[] {
  const args = call.arguments as Record<string, unknown> | undefined;
  if (!args) return [];
  const id = `${idBase}:in`;
  const name = call.name;

  if (name === 'eval' && typeof args.code === 'string' && args.code.trim()) {
    const lang = typeof args.language === 'string' ? args.language : undefined;
    return [{ id, type: 'code', data: lang ? { text: args.code, lang } : { text: args.code } }];
  }

  if (name === 'task') {
    const lines: string[] = [];
    if (typeof args.context === 'string' && args.context.trim()) lines.push(args.context.trim());
    if (typeof args.assignment === 'string' && args.assignment.trim()) lines.push(args.assignment.trim());
    if (Array.isArray(args.tasks)) {
      args.tasks.forEach((t, i) => {
        const rec = (t ?? {}) as Record<string, unknown>;
        const a = typeof rec.assignment === 'string' ? rec.assignment : '';
        const d = typeof rec.description === 'string' && rec.description ? ` — ${rec.description}` : '';
        const line = `${i + 1}. ${a}${d}`.trim();
        if (line) lines.push(line);
      });
    }
    const text = lines.join('\n\n').trim();
    return text ? [{ id, type: 'code', data: { text } }] : [];
  }

  if (name === 'bash' && typeof args.command === 'string' && args.command.trim()) {
    return [{ id, type: 'code', data: { text: args.command, lang: 'bash' } }];
  }

  return [];
}

function toolCallBlock(call: ToolCall, result: ToolResultMessage | undefined): Block {
  const id = `tool:${call.id}`;
  const args = call.arguments as Record<string, unknown> | undefined;
  const lang = langFromPath(args?.file_path ?? args?.path ?? args?.filePath ?? args?.notebook_path);
  const input = toolInputBlocks(call, id);
  return {
    id,
    type: 'tool-call',
    data: {
      tool: call.name,
      target: toolTarget(call.arguments),
      status: result ? (result.isError ? 'error' : 'done') : 'running',
      input: input.length > 0 ? input : undefined,
      result: result ? toolResultBlocks(result, id, lang) : undefined,
    },
  };
}

/** Index tool results by their call id, for correlating into tool-call blocks. */
export function collectToolResults(messages: ReadonlyArray<Message>): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === 'toolResult') results.set(message.toolCallId, message);
  }
  return results;
}

/** Map one message to blocks. `key` makes block ids stable within a window. */
export function messageToBlocks(message: Message, key: string, results: Map<string, ToolResultMessage>): Block[] {
  if (message.role === 'user') {
    const blocks: Block[] = [];
    const text = joinText(message.content);
    if (text) blocks.push({ id: `${key}:user`, type: 'message', data: { role: 'user', text } });
    blocks.push(...imageBlocks(message.content, key));
    return blocks;
  }

  if (message.role === 'assistant') {
    const assistant: AssistantMessage = message;
    const blocks: Block[] = [];
    let buffer: string[] = [];
    const flush = (partIndex: number) => {
      const text = buffer.join('').trim();
      if (text) blocks.push({ id: `${key}:t${partIndex}`, type: 'message', data: { role: 'assistant', text } });
      buffer = [];
    };
    assistant.content.forEach((part, partIndex) => {
      if (part.type === 'text') {
        buffer.push((part as TextContent).text);
      } else if (part.type === 'thinking') {
        flush(partIndex);
        const thinking = (part as ThinkingContent).thinking;
        if (thinking && thinking.trim()) blocks.push({ id: `${key}:think${partIndex}`, type: 'thinking', data: { text: thinking } });
      } else if (part.type === 'toolCall') {
        flush(partIndex);
        const call = part as ToolCall;
        blocks.push(toolCallBlock(call, results.get(call.id)));
      }
      // redactedThinking / other parts: nothing to render
    });
    flush(assistant.content.length);
    if (assistant.errorMessage) blocks.push({ id: `${key}:err`, type: 'error', data: { text: assistant.errorMessage } });
    return blocks;
  }

  // toolResult is consumed by its tool-call; developer messages are system
  // context and aren't shown in the transcript.
  return [];
}

/**
 * Map a window of session messages to transcript blocks (for range reads).
 * Tool results are correlated to their calls and nested inside the tool-call
 * block, so passing a window that splits a call from its result simply leaves
 * the call "running" until the result is in range.
 */
export function messagesToBlocks(messages: ReadonlyArray<Message>): Block[] {
  const results = collectToolResults(messages);
  return messages.flatMap((message, i) => messageToBlocks(message, `m${i}`, results));
}

/**
 * Map a single (possibly in-progress) assistant message for the live tail. The
 * client renders a committed prefix (from range reads) + a live suffix it
 * re-renders from this on each `message_update`, committing on `message_end`.
 * This avoids per-block delta-id reconciliation.
 */
export function liveMessageToBlocks(message: Message, toolResults: ReadonlyArray<ToolResultMessage> = []): Block[] {
  const results = new Map<string, ToolResultMessage>();
  for (const result of toolResults) results.set(result.toolCallId, result);
  const key = message.role === 'assistant' && message.responseId ? message.responseId : 'live';
  return messageToBlocks(message, key, results);
}
