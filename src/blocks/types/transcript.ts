import { z } from 'zod';
import { defineBlock } from '../registry.js';
import { blockEnvelope } from '../block.js';

// ── message ───────────────────────────────────────────────────────────────
export const messageData = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  /** Client-side optimistic echo: the message was submitted but the server's
   *  transcript echo has not arrived yet. Rendered dimmed with a pending pulse;
   *  never produced by the server. */
  pending: z.boolean().optional(),
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
  /** Complete structured tool input, retained for inspection and replay. */
  args: z.unknown().optional(),
  /** Complete structured result details, when provided by the tool. */
  details: z.unknown().optional(),
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
  /** Stable task-result id; used to correlate a completed dispatch. */
  id: z.string().optional(),
  /** Human task label, falling back to the dispatch id. */
  label: z.string(),
  /** Task-agent definition, such as reviewer or explore. */
  agent: z.string().optional(),
  /** Origin of the agent definition. */
  source: z.enum(['bundled', 'user', 'project']).optional(),
  /** User-facing model-role name, shared with the Models settings UI. */
  model: z.string().optional(),
  /** Concrete model resolved at spawn time. */
  resolvedModel: z.string().optional(),
  status: z.enum(['running', 'done', 'blocked', 'queued']),
  durationMs: z.number().nonnegative().optional(),
  requests: z.number().nonnegative().optional(),
  lines: z.array(z.string()).default([]),
});
export type SubagentData = z.infer<typeof subagentData>;
defineBlock({
  type: 'subagent',
  tier: 'transcript',
  description: 'A dispatched subagent with its agent identity, Models role label, resolved model, status, and recent activity lines.',
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

// ── rule-activation ───────────────────────────────────────────────────────
// A TTSR rule (omp://ttsr-injection-lifecycle.md) the harness matched against
// the agent's output. Extracted from the `<system-reminder>` prepended to a
// tool result, or the `<system-interrupt>` carried by a hidden ttsr-injection
// message, so the rule is attributable instead of escaped XML in a result body.
export const ruleActivationData = z.object({
  /** Rule id, e.g. `ts-no-tiny-functions`. */
  rule: z.string(),
  /** Why it fired, e.g. `rule_violation`. */
  reason: z.string().optional(),
  /** Where the rule is defined. */
  path: z.string().optional(),
  /** The instruction text shown to the agent. */
  body: z.string(),
  /** The rule aborted generation mid-stream and forced a retry, rather than
   *  riding along with a tool result as advice. Materially worse, so it reads
   *  differently: the output you would otherwise have seen was discarded. */
  interrupted: z.boolean().optional(),
});
export type RuleActivationData = z.infer<typeof ruleActivationData>;
defineBlock({
  type: 'rule-activation',
  tier: 'transcript',
  description: 'A TTSR rule that matched the agent output, with the instruction given and whether it interrupted generation.',
  schema: ruleActivationData,
});
