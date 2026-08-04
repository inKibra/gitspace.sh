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
import { agentResolutionLabel } from '../model-roles.js';

// Primary input keys across the 17.2.4 builtin tools, in priority order (most
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

/** First non-empty string among the candidates, or undefined. */
function firstNonEmptyString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

/** The largest string arg worth showing in full — multi-line, or long enough
 *  that the one-line target doesn't convey it. Skips short one-liners (already
 *  the target). */
function largestContentArg(args: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  for (const value of Object.values(args)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!value.includes('\n') && value.length <= 120) continue;
    if (best === undefined || value.length > best.length) best = value;
  }
  return best;
}

/**
 * Formatted, full input for a tool call — nested blocks shown when the call is
 * expanded (so the whole eval code / task assignment / bash command / written
 * content / edit diff is visible, not just the one-line target). Simple tools
 * rely on the one-line `target`.
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
    const agent = stringValue(args.agent);
    const role = stringValue(args.role);
    const dispatchId = stringValue(args.id);
    if (agent) lines.push(`Agent: ${agent}`);
    if (role) lines.push(`Role: ${role}`);
    if (dispatchId) lines.push(`Dispatch: ${dispatchId}`);
    if (typeof args.context === 'string' && args.context.trim()) lines.push(args.context.trim());
    if (typeof args.assignment === 'string' && args.assignment.trim()) lines.push(args.assignment.trim());
    if (Array.isArray(args.tasks)) {
      args.tasks.forEach((t, i) => {
        if (!isRecord(t)) return;
        const assignment = stringValue(t.assignment) ?? '';
        const description = stringValue(t.description);
        const taskId = stringValue(t.id);
        const taskRole = stringValue(t.role);
        const detail = [
          taskId ? `Dispatch: ${taskId}` : null,
          taskRole ? `Role: ${taskRole}` : null,
          t.isolated === true ? 'Isolated workspace' : null,
        ].filter((value): value is string => value !== null);
        const line = `${i + 1}. ${assignment}${description ? ` — ${description}` : ''}`.trim();
        if (line) lines.push(detail.length > 0 ? `${line}\n   ${detail.join(' · ')}` : line);
      });
    }
    const text = lines.join('\n\n').trim();
    return text ? [{ id, type: 'code', data: { text } }] : [];
  }

  if (name === 'bash' && typeof args.command === 'string' && args.command.trim()) {
    return [{ id, type: 'code', data: { text: args.command, lang: 'bash' } }];
  }

  // write: the file content, highlighted by the target path's language.
  if (name === 'write' && typeof args.content === 'string' && args.content.trim()) {
    const lang = langFromPath(args.path ?? args.file_path ?? args.filePath);
    return [{ id, type: 'code', data: lang ? { text: args.content, lang } : { text: args.content } }];
  }

  // edit: a unified patch / apply-patch input, or a synthesized old→new diff.
  if (name === 'edit') {
    const patch = firstNonEmptyString(args.patch, args.input, args.diff);
    if (patch) return [{ id, type: 'code', data: { text: patch, lang: 'diff' } }];
    const oldStr = firstNonEmptyString(args.old_string, args.oldText, args.search);
    const newStr = firstNonEmptyString(args.new_string, args.newText, args.replace);
    if (oldStr !== undefined || newStr !== undefined) {
      const diff = [
        ...(oldStr ?? '').split('\n').map((l) => `- ${l}`),
        ...(newStr ?? '').split('\n').map((l) => `+ ${l}`),
      ].join('\n');
      return [{ id, type: 'code', data: { text: diff, lang: 'diff' } }];
    }
  }

  // Generic fallback: surface the largest content-bearing string arg (multi-line
  // or long) not already shown as the one-line target — covers write-like tools
  // we don't special-case (ast_edit, memory_edit, learn, apply-patch variants, …).
  const generic = largestContentArg(args);
  if (generic) return [{ id, type: 'code', data: { text: generic } }];

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => stringValue(entry) ?? []) : [];
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function taskResultBlocks(result: ToolResultMessage, idBase: string): Block[] {
  const rawResult: unknown = result;
  if (!isRecord(rawResult) || !isRecord(rawResult.details) || !Array.isArray(rawResult.details.results)) return [];

  return rawResult.details.results.flatMap((entry, index): Block[] => {
    if (!isRecord(entry)) return [];
    const id = stringValue(entry.id);
    const agent = stringValue(entry.agent);
    const source = stringValue(entry.agentSource);
    const description = stringValue(entry.description);
    const overrideModel = stringArrayValue(entry.modelOverride).join(', ') || null;
    const resolvedModel = stringValue(entry.resolvedModel) ?? null;
    return [{
      id: `${idBase}:subagent:${id ?? index}`,
      type: 'subagent',
      data: {
        id,
        label: description ?? id ?? agent ?? 'Subagent',
        agent,
        source: source === 'bundled' || source === 'user' || source === 'project' ? source : undefined,
        model: agentResolutionLabel({ model: null, overrideModel, resolvedModel }),
        resolvedModel: resolvedModel ?? undefined,
        status: result.isError ? 'blocked' : 'done',
        durationMs: nonNegativeNumber(entry.durationMs),
        requests: nonNegativeNumber(entry.requests),
      },
    }];
  });
}

function toolCallBlock(call: ToolCall, result: ToolResultMessage | undefined): Block {
  const id = `tool:${call.id}`;
  const args = call.arguments as Record<string, unknown> | undefined;
  const lang = langFromPath(args?.file_path ?? args?.path ?? args?.filePath ?? args?.notebook_path);
  const input = toolInputBlocks(call, id);
  const resultBlocks = result
    ? [
      ...(call.name === 'task' ? taskResultBlocks(result, id) : []),
      ...toolResultBlocks(result, id, lang),
    ]
    : undefined;
  return {
    id,
    type: 'tool-call',
    data: {
      tool: call.name,
      target: toolTarget(call.arguments),
      status: result ? (result.isError ? 'error' : 'done') : 'running',
      input: input.length > 0 ? input : undefined,
      result: resultBlocks && resultBlocks.length > 0 ? resultBlocks : undefined,
      args: call.arguments,
      details: result?.details,
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
      } else if (part.type === 'image') {
        flush(partIndex);
        blocks.push(...imageBlocks([part as ImageContent], `${key}:a${partIndex}`));
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
