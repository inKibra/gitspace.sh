import { z } from 'zod';

/**
 * Elicitations from people's MCP servers (issue #155; docs/GITSPACE-MCP-CAPABILITY-MATRIX.md, Client side). The cloud
 * host's MCP client (`@modelcontextprotocol/ext-tasks`) routes each request a server makes for input to the workspace
 * (`RuntimeMcpElicit`): a 2025 `elicitation/create` or a 2026-07-28 `input_required` retry of the agent's call
 * (request-scoped), or an `input_required` task the server started for the call (task-scoped). The workspace posts one
 * `mcp-elicitation` question per request (`RuntimeMcpElicitationQuestion`) and waits MCP_ELICITATION_WINDOW_MS for an
 * answer checked against the server's form (`mcpElicitationIssues`). Unanswered then, a request-scoped request is
 * answered `cancel` and, once the question is answered, the host calls the tool again and answers the same request from
 * the stored answer; a task-scoped one is handed off (`RuntimeMcpTaskReference`) and the task is resumed and answered
 * once the question is. The continued call's result is the agent's next input.
 */

/** How long an elicitation question stays open after the server asked; then it closes and the server gets `cancel`. */
export const MCP_ELICITATION_TTL_MS = 24 * 60 * 60_000;
/** How long a server's request waits on its question before the call goes on without it (request-scoped: answered
 * `cancel`; task-scoped: handed off). */
export const MCP_ELICITATION_WINDOW_MS = 30_000;
/** How long a continued call's stored answers can be replayed, from the call's start; each is replayed at most once. */
export const MCP_ELICITATION_REPLAY_MS = 10 * 60_000;
/** How long a call waits for a server's task to finish before handing it off, and how often a handed-off task that
 * waits on nobody is resumed. */
export const MCP_TASK_FOLLOW_MS = 30_000;
/** The choices of an elicitation question: `done` (a link's page was completed: the server gets `accept`), `decline`
 * and `cancel` (the server gets that action). A form's `accept` is its fields as a JSON object, written as the answer. */
export const MCP_ELICITATION_CHOICES = { done: 'Done', decline: 'Decline', cancel: 'Cancel' } as const;

const text = z.string().max(2000).optional();
const titled = z.strictObject({ const: z.string().max(1000), title: z.string().max(1000) });
/** A string field: free text (with `minLength`, `maxLength`, `format`), or one of `enum` (titled by `enumNames`) or
 * `oneOf`. Keys outside MCP's restricted schema are dropped. */
const StringFieldSchema = z.object({ type: z.literal('string'), title: text, description: text, minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), format: z.enum(['email', 'uri', 'date', 'date-time']).optional(), default: z.string().optional(), enum: z.array(z.string().max(1000)).max(500).optional(), enumNames: z.array(z.string().max(1000)).max(500).optional(), oneOf: z.array(titled).max(500).optional() });
const NumberFieldSchema = z.object({ type: z.enum(['number', 'integer']), title: text, description: text, minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().optional() });
const BooleanFieldSchema = z.object({ type: z.literal('boolean'), title: text, description: text, default: z.boolean().optional() });
/** A multi-select field: strings from `items.enum`, or from `items.anyOf`'s titled values. */
const ArrayFieldSchema = z.object({ type: z.literal('array'), title: text, description: text, minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  items: z.union([z.object({ type: z.literal('string'), enum: z.array(z.string().max(1000)).max(500) }), z.object({ anyOf: z.array(titled).max(500) })]), default: z.array(z.string()).optional() });
/** One field of a form: MCP's restricted elicitation schema (primitives and enum arrays only). */
export const RuntimeMcpElicitationFieldSchema = z.union([StringFieldSchema, NumberFieldSchema, BooleanFieldSchema, ArrayFieldSchema]);
export type RuntimeMcpElicitationField = z.infer<typeof RuntimeMcpElicitationFieldSchema>;
/** A form's `requestedSchema`: a flat object of fields, as the server sent it (`$schema` and other keys dropped). */
export const RuntimeMcpElicitationFormSchema = z.object({ type: z.literal('object'), properties: z.record(z.string().min(1).max(256), RuntimeMcpElicitationFieldSchema).refine(value => Object.keys(value).length <= 64, 'A form has at most 64 fields'), required: z.array(z.string()).optional() });
export type RuntimeMcpElicitationForm = z.infer<typeof RuntimeMcpElicitationFormSchema>;
/** A link a URL elicitation sends a person to: https only. */
const HttpsUrlSchema = z.string().max(8192).refine(value => URL.parse(value)?.protocol === 'https:', 'A link a server sends a person to is an https URL');
/** One request a server made: a form, or a link to open. */
export const RuntimeMcpElicitationRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('form'), message: z.string().max(8000), requestedSchema: RuntimeMcpElicitationFormSchema }),
  z.strictObject({ mode: z.literal('url'), message: z.string().max(8000), url: HttpsUrlSchema, elicitationId: z.string().max(1024).optional() }),
]);
export type RuntimeMcpElicitationRequest = z.infer<typeof RuntimeMcpElicitationRequestSchema>;
/** A form's answer: each field's value. */
export const RuntimeMcpElicitationContentSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));
export type RuntimeMcpElicitationContent = z.infer<typeof RuntimeMcpElicitationContentSchema>;
/** What the server receives: MCP's `ElicitResult`. */
export const RuntimeMcpElicitResultSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('accept'), content: RuntimeMcpElicitationContentSchema.optional() }),
  z.strictObject({ action: z.literal('decline') }),
  z.strictObject({ action: z.literal('cancel') }),
]);
export type RuntimeMcpElicitResult = z.infer<typeof RuntimeMcpElicitResultSchema>;

const connection = { connectionId: z.string().min(1).max(256), connection: z.string().max(256), server: z.string().max(512), workspace: z.string().max(256), tool: z.string().min(1).max(256) };
/** A server's task the host follows across the agent's turns: ext-tasks' `SerializedTaskReference`. */
export const RuntimeMcpTaskReferenceSchema = z.strictObject({ endpointId: z.string().min(1).max(512), generation: z.enum(['v1', 'v2']), taskId: z.string().min(1).max(4096), originalOperation: z.literal('tools/call') });
export type RuntimeMcpTaskReference = z.infer<typeof RuntimeMcpTaskReferenceSchema>;
/** A cloud MCP call that ended while the server's task (`reference`) runs on: the host handed it off, and follows it.
 * `connection`: the connection's label; `status`: the task's last status message. */
export const RuntimeMcpHandoffSchema = z.strictObject({ reference: RuntimeMcpTaskReferenceSchema, connection: z.string().max(256), status: z.string().max(2000).nullable() });
export type RuntimeMcpHandoff = z.infer<typeof RuntimeMcpHandoffSchema>;
/** Where a request came from: the connection's label, the server's identity, and the workspace's name. */
export type RuntimeMcpElicitationSource = { connection: string; server: string; workspace: string };
/**
 * The workspace's side of a server's request for input during a cloud MCP call: `scope` `request` continues the call
 * itself, `task` the server's task `taskId` (input `inputId`). Answers with what the server receives, or null when
 * nobody answered in MCP_ELICITATION_WINDOW_MS (the question stays open).
 */
export type RuntimeMcpElicit = (input: { request: RuntimeMcpElicitationRequest; source: RuntimeMcpElicitationSource; scope: 'request' | 'task'; taskId: string | null; inputId: string | null }) => Promise<RuntimeMcpElicitResult | null>;

/**
 * An `mcp-elicitation` question: the server's request as its card, Needs you and an MCP client show it. The connection
 * (`connectionId`, its label `connection`), the server's identity, the workspace's name, the tool the agent called and
 * the request; for a link, `host` is the link's real host. `secretLooking`: the form looks like it asks for a secret
 * (`mcpElicitationLooksSecret`), so only a person in GitSpace answers it, and its answer is never shown. `scope`: the
 * request continues the call (`request`) or the server's task `taskId` (`task`). `callId` names the agent's call it
 * came from (the script's, for a codemode call).
 */
export const RuntimeMcpElicitationQuestionSchema = z.strictObject({ ...connection, request: RuntimeMcpElicitationRequestSchema, host: z.string().max(512).nullable(), secretLooking: z.boolean(), scope: z.enum(['request', 'task']), taskId: z.string().max(4096).nullable(), callId: z.string().min(1), askedAt: z.iso.datetime(), expiresAt: z.iso.datetime() });
export type RuntimeMcpElicitationQuestion = z.infer<typeof RuntimeMcpElicitationQuestionSchema>;
/** An elicitation question's recorded answer: the action the server gets, the form's values unless the form looked
 * secret (`withheld`), and `expired` when nobody answered in time. */
export const RuntimeMcpElicitationAnswerSchema = z.strictObject({ action: z.enum(['accept', 'decline', 'cancel']), content: RuntimeMcpElicitationContentSchema.optional(), withheld: z.literal(true).optional(), expired: z.literal(true).optional() });
export type RuntimeMcpElicitationAnswer = z.infer<typeof RuntimeMcpElicitationAnswerSchema>;

/** Words that say a form asks for a secret: a password, secret, token, API or private key, one-time or verification
 * code, PIN, or card details. */
const SECRET_WORDS = /pass ?(?:word|code|phrase)|\bpwd\b|secret|token|api ?key|access ?key|private ?key|one ?time|\botp\b|\b[2m]fa\b|verification ?code|security ?code|auth(?:entication)? ?code|\bpin\b|card ?number|credit ?card|\bcvv\b|\bcvc\b|\bssn\b|social security/iu;
/** Whether a form looks like it asks for a secret: a field's name, title, description or format, or the message, says
 * password, secret, token, API key, one-time code, card number or the like. */
export function mcpElicitationLooksSecret(request: RuntimeMcpElicitationRequest): boolean {
  if (request.mode !== 'form') return false;
  const said = [request.message, ...Object.entries(request.requestedSchema.properties).flatMap(([name, field]) => [name, field.title ?? '', field.description ?? '', 'format' in field && typeof field.format === 'string' ? field.format : ''])];
  // `apiKey`, `api_key` and `api-key` each read as `api key`.
  return said.some(value => SECRET_WORDS.test(value.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[\s_-]+/gu, ' ')));
}

/** The values a field takes from a fixed list, or null for free text. */
export function mcpElicitationOptions(field: RuntimeMcpElicitationField): { value: string; title: string }[] | null {
  if (field.type === 'string') {
    if (field.oneOf) return field.oneOf.map(option => ({ value: option.const, title: option.title }));
    if (field.enum) return field.enum.map((value, index) => ({ value, title: field.enumNames?.[index] ?? value }));
    return null;
  }
  if (field.type === 'array') return 'enum' in field.items ? field.items.enum.map(value => ({ value, title: value })) : field.items.anyOf.map(option => ({ value: option.const, title: option.title }));
  return null;
}

/** Why `content` is not an answer `form` takes, one line per problem; empty when it is. */
export function mcpElicitationIssues(form: RuntimeMcpElicitationForm, content: RuntimeMcpElicitationContent): string[] {
  const issues: string[] = [];
  for (const name of Object.keys(content)) if (!Object.hasOwn(form.properties, name)) issues.push(`${name} is not a field of this form`);
  for (const name of form.required ?? []) if (content[name] === undefined) issues.push(`${name} is required`);
  for (const [name, field] of Object.entries(form.properties)) {
    const value = content[name];
    if (value === undefined) continue;
    const options = mcpElicitationOptions(field)?.map(option => option.value);
    if (field.type === 'string') {
      if (typeof value !== 'string') { issues.push(`${name} is text`); continue; }
      if (field.minLength !== undefined && value.length < field.minLength) issues.push(`${name} has at least ${field.minLength} characters`);
      if (field.maxLength !== undefined && value.length > field.maxLength) issues.push(`${name} has at most ${field.maxLength} characters`);
      if (options && !options.includes(value)) issues.push(`${name} is one of ${options.join(', ')}`);
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) issues.push(`${name} is an email address`);
      if (field.format === 'uri' && !URL.canParse(value)) issues.push(`${name} is a URI`);
      if (field.format === 'date' && !(/^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value)))) issues.push(`${name} is a date, as 2026-11-20`);
      if (field.format === 'date-time' && !z.iso.datetime({ offset: true }).safeParse(value).success) issues.push(`${name} is a date and time, as 2026-11-20T09:30:00Z`);
    } else if (field.type !== 'array' && field.type !== 'boolean') {
      if (typeof value !== 'number' || !Number.isFinite(value)) { issues.push(`${name} is a number`); continue; }
      if (field.type === 'integer' && !Number.isInteger(value)) issues.push(`${name} is a whole number`);
      if (field.minimum !== undefined && value < field.minimum) issues.push(`${name} is at least ${field.minimum}`);
      if (field.maximum !== undefined && value > field.maximum) issues.push(`${name} is at most ${field.maximum}`);
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') issues.push(`${name} is true or false`);
    } else if (field.type === 'array') {
      if (!Array.isArray(value)) { issues.push(`${name} is a list of choices`); continue; }
      const stray = value.filter(item => !options?.includes(item));
      if (stray.length) issues.push(`${name} takes only ${options?.join(', ')}`);
      if (field.minItems !== undefined && value.length < field.minItems) issues.push(`${name} has at least ${field.minItems} choices`);
      if (field.maxItems !== undefined && value.length > field.maxItems) issues.push(`${name} has at most ${field.maxItems} choices`);
    }
  }
  return issues;
}

/** Whether two requests are the same request: mode, message, and form or link. A 2025 retry replays a stored answer
 * only to the same request. */
export function sameMcpElicitation(left: RuntimeMcpElicitationRequest, right: RuntimeMcpElicitationRequest): boolean {
  if (left.mode !== right.mode || left.message !== right.message) return false;
  if (left.mode === 'url' && right.mode === 'url') return left.url === right.url;
  if (left.mode !== 'form' || right.mode !== 'form') return false;
  // Object keys sorted, so the same form compares equal however its keys were ordered.
  const sorted = (_key: string, child: unknown) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child;
  return JSON.stringify(left.requestedSchema, sorted) === JSON.stringify(right.requestedSchema, sorted);
}
