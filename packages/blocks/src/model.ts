import { z } from 'zod';

const base = z.object({ id: z.string().min(1) });
const messageImageSchema = z.object({
  data: z.string().min(1),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
});

export const messageBlockSchema = base.extend({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  images: z.array(messageImageSchema).optional(),
  pending: z.boolean().optional(),
});

export const thinkingBlockSchema = base.extend({
  type: z.literal('thinking'),
  text: z.string(),
});

export const richContentSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('markdown'), text: z.string() }),
  base.extend({ type: z.literal('code'), text: z.string(), language: z.string().optional() }),
  base.extend({ type: z.literal('diff'), patch: z.string(), path: z.string().optional() }),
  base.extend({ type: z.literal('file-tree'), paths: z.array(z.string()) }),
  base.extend({ type: z.literal('image'), url: z.string(), alt: z.string().optional() }),
  base.extend({ type: z.literal('artifact-ref'), url: z.string(), label: z.string(), mediaType: z.string().optional() }),
  base.extend({ type: z.literal('diagram'), source: z.string(), language: z.literal('mermaid') }),
  base.extend({ type: z.literal('table'), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
]);

export const toolCallBlockSchema = base.extend({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  tool: z.string(),
  target: z.string().optional(),
  status: z.enum(['pending', 'running', 'done', 'error', 'interrupted']),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  input: z.array(richContentSchema).optional(),
  result: z.array(richContentSchema).optional(),
  args: z.unknown().optional(),
  details: z.unknown().optional(),
});

export const askBlockSchema = base.extend({
  type: z.literal('ask'),
  toolCallId: z.string(),
  status: z.enum(['pending', 'answered', 'dismissed']),
  questions: z.array(z.object({
    id: z.string(),
    prompt: z.string(),
    header: z.string().optional(),
    options: z.array(z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      preview: z.string().optional(),
    })).optional(),
    multiple: z.boolean().optional(),
    recommended: z.number().int().nonnegative().optional(),
    answer: z.union([z.string(), z.array(z.string())]).optional(),
  })),
});

export const permissionBlockSchema = base.extend({
  type: z.literal('permission'),
  status: z.enum(['pending', 'allowed-once', 'allowed-always', 'denied']),
  tool: z.string(),
  detail: z.string(),
  risk: z.enum(['ordinary', 'elevated', 'destructive']).default('ordinary'),
});

export const todoBlockSchema = base.extend({
  type: z.literal('todo'),
  title: z.string().optional(),
  items: z.array(z.object({ text: z.string(), state: z.enum(['pending', 'active', 'done', 'blocked']) })),
});

export const interruptionBlockSchema = base.extend({
  type: z.literal('interruption'),
  reason: z.enum(['aborted', 'compacted', 'replaced', 'connection-lost', 'rule']),
  title: z.string(),
  detail: z.string().optional(),
  recovered: z.boolean().optional(),
});

export const previewBlockSchema = base.extend({
  type: z.literal('preview'),
  appId: z.string(),
  label: z.string(),
  artifactUrl: z.string(),
  serviceName: z.string(),
  route: z.string().optional(),
  status: z.enum(['starting', 'ready', 'stopped', 'failed']),
});

export const referenceBlockSchema = base.extend({
  type: z.literal('reference'),
  kind: z.enum(['goal', 'workflow', 'review', 'workspace', 'promotion']),
  label: z.string(),
  ref: z.string(),
});

export const turnItemSchema = z.discriminatedUnion('type', [
  messageBlockSchema,
  thinkingBlockSchema,
  toolCallBlockSchema,
  askBlockSchema,
  permissionBlockSchema,
  todoBlockSchema,
  interruptionBlockSchema,
  previewBlockSchema,
  referenceBlockSchema,
  ...richContentSchema.options,
]);

export const sideAgentBlockSchema = base.extend({
  type: z.literal('side-agent'),
  agentId: z.string(),
  label: z.string(),
  agent: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(['queued', 'running', 'blocked', 'done', 'failed']),
  summary: z.string().optional(),
  reportUrl: z.string().optional(),
});

export const turnBlockSchema = base.extend({
  type: z.literal('turn'),
  status: z.enum(['running', 'done', 'interrupted', 'error']),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  user: messageBlockSchema.optional(),
  items: z.array(turnItemSchema),
  sideAgents: z.array(sideAgentBlockSchema),
});

export const transportBlockSchema = base.extend({
  type: z.literal('transport'),
  status: z.enum(['reconnecting', 'restored', 'replaced', 'failed']),
  title: z.string(),
  detail: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  generation: z.string().optional(),
});

export type MessageBlock = z.infer<typeof messageBlockSchema>;
export type MessageImage = z.infer<typeof messageImageSchema>;
export type RichContentBlock = z.infer<typeof richContentSchema>;
export type AskBlock = z.infer<typeof askBlockSchema>;
export type ToolCallBlock = z.infer<typeof toolCallBlockSchema>;
export type TurnItem = z.infer<typeof turnItemSchema>;
export type SideAgentBlock = z.infer<typeof sideAgentBlockSchema>;
export type TurnBlock = z.infer<typeof turnBlockSchema>;
export type TransportBlock = z.infer<typeof transportBlockSchema>;
