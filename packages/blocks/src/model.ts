import { z } from 'zod';

const base = z.object({ id: z.string().min(1) });
/** When the event that created the item happened (ISO); the first event of a streamed message. Absent in transcripts
 * recorded before items kept it. */
const at = z.string().optional();
/** An image a message carries: its bytes, or (a stored image) a URL. A transcript row names a stored image as
 * `gs-image:…;<mimeType>` until the workspace that serves the row resolves it to an absolute URL anyone holding it can
 * load. The published JSON Schema marks the bytes `contentEncoding: "base64"` with their `contentMediaType` (one member
 * per type) and the URL `format: "uri"`, so an MCP client stores the bytes as a file and fetches the URL. */
const MESSAGE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const messageImageSchema = z.union([
  ...MESSAGE_IMAGE_TYPES.map(type => z.object({ data: z.string().min(1).meta({ contentEncoding: 'base64', contentMediaType: type }), mimeType: z.literal(type) })),
  z.object({ url: z.string().min(1).meta({ format: 'uri' }), mimeType: z.enum(MESSAGE_IMAGE_TYPES) }),
]);

/** A block of a message the agent corrected in place after it was stored: the block's index among the message's blocks
 * (from 0), when it was corrected, and the issues the correction fixed. */
export const blockCorrectionSchema = z.object({ block: z.number().int().nonnegative(), at: z.string(), issues: z.array(z.string()) });
export type BlockCorrection = z.infer<typeof blockCorrectionSchema>;
/** What a transcript event of a stored assistant message carries as `payload.corrected`: its block corrections, each
 * naming the content part (the message row) its block is in. */
export const messageCorrectionsSchema = z.array(blockCorrectionSchema.extend({ part: z.number().int().nonnegative() }));
/** The version (`sha256:…`) each drive file a stored message embeds had when the message was stored, by its address
 * (`parseResourceUri(...).url`); a transcript event of a stored message carries them as `payload.pins`. */
export const mediaPinsSchema = z.record(z.string(), z.string());

export const messageBlockSchema = base.extend({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  images: z.array(messageImageSchema).optional(),
  pending: z.boolean().optional(),
  /** The message's blocks the agent corrected; `text` holds the corrections. */
  corrected: z.array(blockCorrectionSchema).optional(),
  /** Its embedded drive media's versions when it was stored; a file it embeds that is not here shows as it is now. */
  pins: mediaPinsSchema.optional(),
  at,
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

/** Who answers a workspace's question in a person's place: the project agent, or the head of the workspace's stack (its
 * id and name as they were when it answered). */
const projectAgentSource = z.object({ by: z.literal('project-agent') });
const stackHeadSource = z.object({ by: z.literal('stack-head'), workspaceId: z.string(), name: z.string() });
export const askAnswerSourceSchema = z.discriminatedUnion('by', [projectAgentSource, stackHeadSource]);
export type AskAnswerSource = z.infer<typeof askAnswerSourceSchema>;

/** Who answered a question in a person's place (`AskAnswerSource`), or the MCP client the person's MCP access answered it
 * through (an MCP Tasks `tasks/update`, packages/mcp-server); when (ISO), and for whom: the person who approved its answer
 * (absent on answers from before a person approved them, and on MCP client answers). A question without one was
 * answered by a person in GitSpace. */
const answeredWhen = { at: z.string(), for: z.string().optional() };
const mcpClientAnswerer = z.object({ by: z.literal('mcp-client'), ...answeredWhen });
export const askAnswererSchema = z.discriminatedUnion('by', [projectAgentSource.extend(answeredWhen), stackHeadSource.extend(answeredWhen), mcpClientAnswerer]);
export type AskAnswerer = z.infer<typeof askAnswererSchema>;

/** How a card or a message names who answered: "the project agent", "Billing export (stack head)", or "an MCP client". */
export function askAnswererName(source: AskAnswerSource | AskAnswerer): string {
  return source.by === 'project-agent' ? 'the project agent' : source.by === 'mcp-client' ? 'an MCP client' : `${source.name} (stack head)`;
}

/** `kind: 'plan'` is a `propose_plan` call (`planQuestions`), with the `steps` it proposes. A question with
 * `written: false` is answered only by its options; an `optional` one may be skipped. `answeredBy`: the project agent or
 * a stack's head answered it, not the person. `questionId`: the workspace question the call posted, which says whether it is open,
 * answered or closed; a `pending` card with one stays pending here, since its answer arrives as a later message. Calls
 * that held their answer (before questions outlived their call) have none, and their result settles the card. */
export const askBlockSchema = base.extend({
  type: z.literal('ask'),
  kind: z.literal('plan').optional(),
  toolCallId: z.string(),
  questionId: z.string().optional(),
  steps: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string().optional(), where: z.array(z.string()).optional() })).optional(),
  status: z.enum(['pending', 'answered', 'dismissed']),
  answeredBy: askAnswererSchema.optional(),
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
    written: z.boolean().optional(),
    optional: z.boolean().optional(),
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

/** The agent's todo list as a `todo` call set it. `source`: `plan` when it follows the approved plan (loaded from it, or
 * its items name plan steps), `own` when it is the agent's own list (a detour from the plan, or no plan). `error`: the
 * call failed and the list did not change. */
export const todoBlockSchema = base.extend({
  type: z.literal('todo'),
  title: z.string().optional(),
  source: z.enum(['plan', 'own']).optional(),
  error: z.string().optional(),
  items: z.array(z.object({ text: z.string(), state: z.enum(['pending', 'active', 'done', 'blocked']), planStep: z.string().optional() })),
});

export const interruptionBlockSchema = base.extend({
  type: z.literal('interruption'),
  /** `event`: a subagent's reply, a finished background command, an exited process or a ready machine, delivered to the
   * agent on someone else's behalf; `machine` also carries GitSpace's own notices to the agent. */
  reason: z.enum(['aborted', 'compacted', 'replaced', 'connection-lost', 'rule', 'machine', 'event']),
  /** An `event`'s kind (`agent-message`, `command-completed`, `process-exited`, `machine-ready`, …). */
  kind: z.string().optional(),
  title: z.string(),
  detail: z.string().optional(),
  /** The whole message when `detail` shows only its start; a compaction's summary. */
  body: z.string().optional(),
  recovered: z.boolean().optional(),
  /** A compaction's Pi entry. */
  entryId: z.string().optional(),
  /** A compaction's count of the conversation's turns before the first entry it kept: the turns its summary stands for. */
  summarizedTurns: z.number().int().nonnegative().optional(),
  at,
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

/** A runtime entity/run, with the original observations retained as paged history. */
export const executionBlockSchema = base.extend({
  type: z.literal('execution'),
  executionId: z.string().min(1),
  kind: z.enum(['job', 'process', 'agent']),
  label: z.string(),
  status: z.enum(['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  summary: z.string().optional(),
  historyCount: z.number().int().nonnegative(),
  hasFailures: z.boolean(),
});

/** How a turn a workspace ran for its project agent came out: it answered, failed, or stopped for a person. */
export const workspaceTurnReportSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string(),
  /** The project agent's submission that started the turn. */
  requestId: z.string().min(1),
  outcome: z.enum(['finished', 'failed', 'asked', 'approval']),
  /** The reply, the failure or the question, at most 280 characters. */
  excerpt: z.string().nullable(),
  /** Where the whole reply is (its conversation, history ordinal and length): `@gitspace/protocol-workspace`'s
   * `TextSource`. Null for a failure or a question, and in reports stored before it. */
  source: z.object({ conversationId: z.string().min(1), ordinal: z.number().int().nonnegative(), characters: z.number().int().nonnegative() }).nullable().default(null),
});
/** One compact row in the project conversation: the report of a turn the project agent started. */
export const workspaceReportBlockSchema = base.extend({ type: z.literal('workspace-report'), ...workspaceTurnReportSchema.shape, at });
/** The entry kind, and custom transcript message type, of a workspace turn report; a delivered conversation event of
 * kind `workspace` appends the same entry. */
export const WORKSPACE_REPORT_ENTRY = 'gitspace.workspace';
/** The entry kind, and custom transcript message type, of a turn's Chatter digest; its data counts what it holds: posts
 * always heard, posts the model picked, posts of the newest topics when no model picked (absent on entries written
 * before that count existed), other posts, and its tokens against the tokens of every new post quoted whole; `during`
 * marks a long run's digest at a tool boundary rather than a turn start's. */
export const CHATTER_DIGEST_ENTRY = 'gitspace.chatter-digest';
export const chatterDigestDetailsSchema = z.object({ floor: z.number().int().nonnegative(), picked: z.number().int().nonnegative(), newest: z.number().int().nonnegative().default(0), others: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), fullTokens: z.number().int().nonnegative(), during: z.boolean().default(false) });

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
  executionBlockSchema,
  workspaceReportBlockSchema,
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
export type ExecutionBlock = z.infer<typeof executionBlockSchema>;
export type TurnItem = z.infer<typeof turnItemSchema>;
export type SideAgentBlock = z.infer<typeof sideAgentBlockSchema>;
export type TurnBlock = z.infer<typeof turnBlockSchema>;
export type TransportBlock = z.infer<typeof transportBlockSchema>;
export type WorkspaceTurnReport = z.infer<typeof workspaceTurnReportSchema>;
export type WorkspaceReportBlock = z.infer<typeof workspaceReportBlockSchema>;
