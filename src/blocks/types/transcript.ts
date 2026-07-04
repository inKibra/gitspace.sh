import { z } from 'zod';
import { defineBlock } from '../registry.js';
import { blockEnvelope } from '../block.js';

// ── message ───────────────────────────────────────────────────────────────
export const messageData = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
});
export type MessageData = z.infer<typeof messageData>;
defineBlock({
  type: 'message',
  tier: 'transcript',
  description: 'A turn from the user or the assistant (assistant text is Markdown).',
  schema: messageData,
});

// ── thinking ──────────────────────────────────────────────────────────────
export const thinkingData = z.object({
  text: z.string(),
});
export type ThinkingData = z.infer<typeof thinkingData>;
defineBlock({
  type: 'thinking',
  tier: 'transcript',
  description: 'Collapsed reasoning shown above an assistant turn.',
  schema: thinkingData,
});

// ── tool-call ─────────────────────────────────────────────────────────────
// The result NESTS other blocks: a bash result is a `code` block, an edit is a
// `diff`, a screenshot is an image, a search is a `file-tree`. Children are
// validated by re-running validateBlock on each (composition, not a special case).
export const toolCallData = z.object({
  tool: z.string(),
  target: z.string().optional(),
  status: z.enum(['running', 'done', 'error']),
  meta: z.string().optional(),
  /** Formatted full input (e.g. the eval code, task assignment, bash command) —
   *  nested blocks shown above the result when the call is expanded. */
  input: z.array(blockEnvelope).optional(),
  result: z.array(blockEnvelope).optional(),
});
export type ToolCallData = z.infer<typeof toolCallData>;
defineBlock({
  type: 'tool-call',
  tier: 'transcript',
  description: 'An invocation of a tool; its result nests other blocks (code/diff/image/file-tree).',
  schema: toolCallData,
});

// ── image ─────────────────────────────────────────────────────────────────
export const imageData = z.object({
  src: z.string(), // URL or data URL
  alt: z.string().optional(),
  caption: z.string().optional(),
});
export type ImageData = z.infer<typeof imageData>;
defineBlock({
  type: 'image',
  tier: 'transcript',
  description: 'An image output (URL or data URL) with an optional caption.',
  schema: imageData,
});

// ── subagent ──────────────────────────────────────────────────────────────
export const subagentData = z.object({
  label: z.string(),
  model: z.string().optional(),
  status: z.enum(['running', 'done', 'blocked', 'queued']),
  lines: z.array(z.string()).default([]),
});
export type SubagentData = z.infer<typeof subagentData>;
defineBlock({
  type: 'subagent',
  tier: 'transcript',
  description: 'A spawned sub-agent with its model, status, and recent activity lines.',
  schema: subagentData,
});

// ── error ─────────────────────────────────────────────────────────────────
export const errorData = z.object({
  text: z.string(),
  aborted: z.boolean().optional(),
});
export type ErrorData = z.infer<typeof errorData>;
defineBlock({
  type: 'error',
  tier: 'transcript',
  description: 'A turn-level error or aborted notice; non-aborted errors offer a retry.',
  schema: errorData,
});
