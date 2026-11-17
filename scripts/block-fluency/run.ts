#!/usr/bin/env bun
/**
 * Block fluency eval: whether real agents draw GitSpace blocks unprompted, whether the blocks fit, and whether they are
 * valid. For each (prompt, model) it creates a workspace in the eval project, picks the model through session
 * controls, submits the prompt, waits for the turn, reads the turn's replies from the transcript, scores them with the
 * repo's block validator, and archives the workspace.
 *
 *   GITSPACE_ACCOUNT_URL=https://<account>.gitspace.sh GITSPACE_MCP_TOKEN=… \
 *     bun scripts/block-fluency/run.ts --project <projectId> [outDir]
 *     [--models anthropic/claude-opus-5-5,openai/gpt-6-astra] [--prompts race-fix,benchmarks] [--concurrency 2]
 *     [--thinking medium] [--timeout-minutes 15]
 *   bun scripts/block-fluency/run.ts --check    # only refuse prompts whose prose suggests a visual form
 *
 * Writes results.json, results.md and runs/<prompt>__<model>.{md,json} (plus .original.md for a corrected reply) to
 * outDir (default ~/work/block-fluency-results/<timestamp>/).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { extractBlocks, fenceSpec, validateMarkdownBlocks, type UiBlock, type UiBlockKind } from '../../packages/protocol/src/gitspace-ui.js';

/** A scenario is a situation where a block helps; `expected` holds the components that fit it. A control is one where
 * no block is the right answer: any block on it is over-drawing. */
const promptSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  title: z.string(),
  kind: z.enum(['scenario', 'control']),
  text: z.string().min(1),
  expected: z.array(z.string()),
  requiresAsk: z.boolean(),
}).refine(prompt => (prompt.kind === 'scenario') === (prompt.expected.length > 0), 'a scenario lists its expected components; a control lists none');
type EvalPrompt = z.infer<typeof promptSchema>;

/** Words that suggest a visual form. The eval measures whether agents draw unprompted, so prompt prose never names a
 * form. Code fences and inline code are data and are not checked; "on the table" and a named SQL table ("the users
 * table") are not a form. */
const FORM_WORDS = /\b(?:charts?|charting|graphs?|graphing|diagrams?|diagramming|visual\w*|draw\w*|drew|walk-?throughs?|walk (?:me |us )?through|timelines?|break-?downs?|side[- ]by[- ]side|illustrat\w*|plot\w*|sketch\w*|flow-?charts?|infographics?|dashboards?|mermaid|svg|lay (?:them |it )?out|layouts?|tabular|tabulate|matrix|narrat\w*|slides?|cards?|blocks?|widgets?)\b|\b(?:a|the|as a|in a|into a|comparison|summary|markdown)\s+tables?\b/giu;

/** The form words in a prompt's prose. */
function formWords(text: string): string[] {
  const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, '').replace(/`[^`\n]*`/gu, '').replace(/\bon the table\b/giu, '');
  return [...prose.matchAll(FORM_WORDS)].map(match => match[0]);
}

const { values, positionals } = parseArgs({
  options: {
    project: { type: 'string' },
    models: { type: 'string', default: 'anthropic/claude-opus-5-5,openai/gpt-6-astra' },
    prompts: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    thinking: { type: 'string', default: 'medium' },
    'timeout-minutes': { type: 'string', default: '15' },
    repeat: { type: 'string', default: '1' },
    rescore: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
  allowPositionals: true,
  strict: true,
});
const allPrompts = z.array(promptSchema).parse(JSON.parse(await readFile(new URL('./prompts.json', import.meta.url), 'utf8')));
const leading = allPrompts.flatMap(prompt => {
  const words = formWords(prompt.text);
  return words.length > 0 ? [`${prompt.id}: ${words.join(', ')}`] : [];
});
if (leading.length > 0) throw new Error(`Prompts must not suggest a visual form:\n${leading.join('\n')}`);
if (values.check) {
  console.log(`${allPrompts.length} prompts, none suggests a visual form`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------- MCP

const rpcSchema = z.object({
  result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })), isError: z.boolean().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});
const wrappedSchema = z.object({ result: z.unknown() });
let rpcId = 0;

/** One MCP tools/call; transport failures, 429 and 5xx are retried with backoff, tool errors are thrown. */
async function call<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(`${accountUrl}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'gitspace-block-fluency/1', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (attempt >= 4) throw error;
    }
    if (response && (response.status === 429 || response.status >= 500) && attempt < 4) response = undefined;
    if (!response) {
      await Bun.sleep(2_000 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
    const body = rpcSchema.parse(await response.json());
    if (body.error) throw new Error(`${name}: ${body.error.message}`);
    const text = body.result?.content.find(part => part.type === 'text')?.text ?? '';
    if (body.result?.isError) throw new Error(`${name}: ${text.slice(0, 1000)}`);
    const parsed: unknown = JSON.parse(text);
    const wrapped = wrappedSchema.safeParse(parsed);
    return schema.parse(wrapped.success && wrapped.data.result !== undefined ? wrapped.data.result : parsed);
  }
}

const operationSchema = z.object({ id: z.string(), state: z.string(), steps: z.array(z.object({ id: z.string(), state: z.string(), message: z.string().nullable() })) });
const projectsSchema = z.array(z.object({ id: z.string(), baseBranch: z.string().nullable(), lifecycle: z.string() }));
const createdSchema = z.object({ workspace: z.object({ id: z.string() }), operation: operationSchema });
const controlSchema = z.object({ control: z.object({ provider: z.string().nullable(), model: z.string().nullable(), thinking: z.string().nullable(), cost: z.number() }) });
const totalsSchema = z.object({ requests: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(), costUsd: z.number() });
const usageSchema = z.object({ usage: z.object({ totals: totalsSchema }).optional() });
const submitSchema = z.object({ accepted: z.boolean(), conversationId: z.string().optional() });
const snapshotSchema = z.object({
  conversations: z.array(z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    status: z.string(),
    error: z.string().optional(),
    retry: z.object({ at: z.string(), error: z.string() }).optional(),
    messages: z.array(z.object({ id: z.string(), role: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })),
  })),
  questions: z.array(z.unknown()),
  documents: z.object({ 'gitspace.workspace': z.object({ phase: z.string() }).nullable().optional() }).optional(),
});
const rowSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  turnId: z.string(),
  turnStatus: z.string(),
  truncated: z.boolean(),
  item: z.object({
    type: z.string(),
    role: z.string().optional(),
    text: z.string().optional(),
    tool: z.string().optional(),
    target: z.string().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    corrected: z.array(z.object({ block: z.number(), issues: z.array(z.string()) })).optional(),
  }),
});
type TranscriptRow = z.infer<typeof rowSchema>;
const pageSchema = z.object({ generation: z.string(), rows: z.array(rowSchema), hasBefore: z.boolean() });
const contentSchema = z.object({ text: z.string(), nextOffset: z.number().nullable() });

async function followOperation(operationId: string, timeoutMs: number): Promise<z.infer<typeof operationSchema>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const operation = await call('gitspace_project_operation', { projectId, operationId }, operationSchema);
    if (operation.state !== 'queued' && operation.state !== 'running') return operation;
    if (Date.now() > end) throw new Error(`operation ${operationId} still ${operation.state} after ${timeoutMs / 1000} s`);
    await Bun.sleep(2_000);
  }
}

/** Every row of the workspace's main transcript, oldest first, with truncated message rows read whole. */
async function transcript(workspaceId: string): Promise<TranscriptRow[]> {
  let page = await call('gitspace_inspector_transcript_page', { projectId, workspaceId, generation: null, before: null, after: null, around: null }, pageSchema);
  const rows = [...page.rows];
  while (page.hasBefore && rows.length > 0) {
    page = await call('gitspace_inspector_transcript_page', { projectId, workspaceId, generation: page.generation, before: rows[0].ordinal, after: null, around: null }, pageSchema);
    rows.unshift(...page.rows);
  }
  for (const row of rows) {
    if (!row.truncated || row.item.type !== 'message') continue;
    let text = '';
    for (let offset: number | null = 0; offset !== null;) {
      const content: z.infer<typeof contentSchema> = await call('gitspace_inspector_transcript_content', { projectId, workspaceId, generation: page.generation, rowId: row.id, offset }, contentSchema);
      text += content.text;
      offset = content.nextOffset;
    }
    row.item.text = text;
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------------------ Scoring

const blockScoreSchema = z.object({
  kind: z.enum(['gitspace-ui', 'svg', 'mermaid']),
  /** gitspace-ui only: a component named in the fence's info string (short) or a whole spec (full). */
  form: z.enum(['short', 'full']).nullable(),
  components: z.array(z.string()),
  requiredAsk: z.boolean(),
  /** The validator's issues with the block as first written. */
  issuesAsWritten: z.array(z.string()),
  /** A fix step corrected it (the transcript row lists it under `corrected`). */
  fixed: z.boolean(),
  /** The block as first written; null for a corrected block whose original was not seen before its correction. */
  written: z.string().nullable(),
  /** The block as the transcript shows it, with any correction applied. */
  shown: z.string(),
});
type BlockScore = z.infer<typeof blockScoreSchema>;

/** A turn's replies as scored. Fit and over-asking are judged at report time against the current prompts.json, so a
 * changed expectation re-scores stored results (`--rescore`). */
const replyScoreSchema = z.object({
  messages: z.number(),
  replyChars: z.number(),
  blocks: z.array(blockScoreSchema),
  components: z.array(z.string()),
  shortForm: z.number(),
  fullForm: z.number(),
  invalidAsWritten: z.number(),
  fixed: z.number(),
  stillInvalid: z.number(),
  requiredAsk: z.boolean(),
  /** Characters of prose before the first block; null when the reply has no block. */
  proseBeforeFirstBlock: z.number().nullable(),
});
type ReplyScore = z.infer<typeof replyScoreSchema>;

const elementsSchema = z.object({ elements: z.record(z.string(), z.object({ type: z.string().optional(), ask: z.object({ required: z.boolean().optional() }).nullable().optional() }).loose()) });
const KIND_COMPONENT: Record<UiBlockKind, string> = { 'gitspace-ui': '', mermaid: 'Mermaid', svg: 'Svg' };

/** What a block draws: its form, the component types of its spec, and whether an element asks for a required answer. */
function blockShape(block: UiBlock): Pick<BlockScore, 'kind' | 'form' | 'components' | 'requiredAsk'> {
  if (block.kind !== 'gitspace-ui') return { kind: block.kind, form: null, components: [KIND_COMPONENT[block.kind]], requiredAsk: false };
  const named = block.info.trim().split(/\s+/u)[0];
  const form = named ? 'short' : 'full';
  const read = fenceSpec(block.body, block.info);
  const spec = 'spec' in read ? elementsSchema.safeParse(read.spec) : undefined;
  if (!spec?.success) return { kind: block.kind, form, components: named ? [named] : [], requiredAsk: false };
  const elements = Object.values(spec.data.elements);
  return {
    kind: block.kind,
    form,
    components: [...new Set(elements.flatMap(element => element.type ? [element.type] : []))],
    requiredAsk: elements.some(element => element.ask?.required === true),
  };
}

/** Each block of one Markdown document with the validator's issues of that block, paths relative to it. */
function validatedBlocks(text: string): { block: UiBlock; issues: string[] }[] {
  const issues = validateMarkdownBlocks(text);
  return extractBlocks(text).map((block, index) => {
    const prefix = `block ${index + 1}`;
    return { block, issues: issues.filter(issue => issue.path === prefix || issue.path.startsWith(`${prefix}/`)).map(issue => `${issue.path.slice(prefix.length) || '/'}: ${issue.message}`) };
  });
}

/** Scores the turn's assistant replies. Each message row is one Markdown document, as the runtime validates it. A row
 * with corrections is scored against its original text (`originals`, by row id) when the run saw it before the fix. */
function scoreReplies(replies: readonly TranscriptRow[], originals: ReadonlyMap<string, string>): ReplyScore {
  const blocks: BlockScore[] = [];
  let prose: number | null = null;
  let proseSoFar = 0;
  for (const row of replies) {
    const text = row.item.text ?? '';
    const shown = validatedBlocks(text);
    const original = originals.get(row.id);
    const written = original === undefined ? undefined : validatedBlocks(original);
    shown.forEach(({ block, issues }, index) => {
      const correction = row.item.corrected?.find(item => item.block === index);
      const first = correction ? written?.[index] : { block, issues };
      blocks.push({
        ...blockShape(block),
        issuesAsWritten: correction && !first?.issues.length ? correction.issues : first?.issues ?? issues,
        fixed: correction !== undefined,
        written: first ? (correction ? original ?? '' : text).slice(first.block.start, first.block.end) : null,
        shown: text.slice(block.start, block.end),
      });
    });
    if (prose === null) prose = shown.length > 0 ? proseSoFar + text.slice(0, shown[0].block.start).trim().length : null;
    proseSoFar += text.trim().length;
  }
  const components = [...new Set(blocks.flatMap(block => block.components))];
  const invalid = blocks.filter(block => block.issuesAsWritten.length > 0);
  return {
    messages: replies.length,
    replyChars: replies.reduce((sum, row) => sum + (row.item.text ?? '').length, 0),
    blocks,
    components,
    shortForm: blocks.filter(block => block.form === 'short').length,
    fullForm: blocks.filter(block => block.form === 'full').length,
    invalidAsWritten: invalid.length,
    fixed: blocks.filter(block => block.fixed).length,
    stillInvalid: invalid.filter(block => !block.fixed).length,
    requiredAsk: blocks.some(block => block.requiredAsk),
    proseBeforeFirstBlock: prose,
  };
}

// ---------------------------------------------------------------------------------------------------------------- Run

const runResultSchema = z.object({
  prompt: z.string(),
  /** Which repetition of the (prompt, model) pair, from 1 (`--repeat`). */
  attempt: z.number().int().positive().default(1),
  kind: z.enum(['scenario', 'control']),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['done', 'failed', 'timeout', 'error']),
  error: z.string().nullable(),
  workspaceId: z.string().nullable(),
  phase: z.string().nullable(),
  control: z.object({ provider: z.string().nullable(), model: z.string().nullable(), thinking: z.string().nullable() }).nullable(),
  conversationStatus: z.string().nullable(),
  durationMs: z.number().nullable(),
  usage: totalsSchema.nullable(),
  tools: z.array(z.string()),
  askTool: z.boolean(),
  interruptions: z.array(z.string()),
  openQuestions: z.number(),
  score: replyScoreSchema.nullable(),
  archived: z.string().nullable(),
});
type RunResult = z.infer<typeof runResultSchema>;

async function run(prompt: EvalPrompt, target: { provider: string; model: string }, attempt: number, baseBranch: string): Promise<RunResult> {
  const label = `${target.provider}-${target.model}`.replace(/[^A-Za-z0-9-]/gu, '-');
  const name = repeat > 1 ? `${prompt.id}__${label}__${attempt}` : `${prompt.id}__${label}`;
  const result: RunResult = { prompt: prompt.id, attempt, kind: prompt.kind, provider: target.provider, model: target.model, status: 'error', error: null, workspaceId: null, phase: null, control: null, conversationStatus: null, durationMs: null, usage: null, tools: [], askTool: false, interruptions: [], openQuestions: 0, score: null, archived: null };
  const log = (message: string): void => console.log(`[${name}] ${message}`);
  try {
    const created = await call('gitspace_workspace_create', { projectId, name: `bf ${prompt.id} ${label} ${attempt}`.slice(0, 80), branch: `bf/${stamp}/${prompt.id}/${label}/${attempt}`, sourceKind: 'base', sourceRef: baseBranch }, createdSchema);
    const workspaceId = created.workspace.id;
    result.workspaceId = workspaceId;
    const operation = await followOperation(created.operation.id, 180_000);
    if (operation.state !== 'succeeded') throw new Error(`workspace creation ${operation.state}: ${operation.steps.map(step => `${step.id} ${step.state}${step.message ? ` (${step.message})` : ''}`).join('; ')}`);
    log(`workspace ${workspaceId}`);
    await call('gitspace_runtime_session', { projectId, workspaceId, command: { type: 'setModel', provider: target.provider, model: target.model } }, controlSchema);
    const { control } = await call('gitspace_runtime_session', { projectId, workspaceId, command: { type: 'setThinking', thinking: values.thinking } }, controlSchema);
    result.control = { provider: control.provider, model: control.model, thinking: control.thinking };
    if (control.provider !== target.provider || control.model !== target.model) throw new Error(`session model is ${control.provider}/${control.model}, not ${target.provider}/${target.model}`);

    const started = Date.now();
    const submitted = await call('gitspace_runtime_submit', { projectId, workspaceId, requestId: `bf-${stamp}-${prompt.id}-${label}-${attempt}`, text: prompt.text }, submitSchema);
    if (!submitted.accepted) throw new Error('submission not accepted');
    // The turn is over once the conversation leaves running (a block fix step runs inside the same busy period) and
    // stays out of it for a second read. Every version of each assistant text part is kept: a fix step's correction
    // replaces a reply in the snapshot, so the reply as first written is the version before the corrected one.
    let sawRunning = false;
    let settled = 0;
    let snapshot: z.infer<typeof snapshotSchema> | undefined;
    let ended = started;
    const versions = new Map<string, string[]>();
    for (;;) {
      await Bun.sleep(2_000);
      snapshot = await call('gitspace_runtime_snapshot', { projectId, workspaceId }, snapshotSchema);
      for (const message of snapshot.conversations.flatMap(each => each.messages)) {
        if (message.role !== 'assistant') continue;
        message.content.forEach((part, index) => {
          if (part.type !== 'text' || !part.text) return;
          const seen = versions.get(`${message.id}/${index}`) ?? [];
          if (seen.at(-1) !== part.text) versions.set(`${message.id}/${index}`, [...seen, part.text]);
        });
      }
      const conversation = snapshot.conversations.find(each => each.id === submitted.conversationId) ?? snapshot.conversations.find(each => each.parentId === null);
      const status = conversation?.status ?? 'missing';
      result.conversationStatus = status;
      if (conversation?.error) result.error = conversation.error;
      if (status === 'running' || conversation?.retry) {
        sawRunning = true;
        settled = 0;
      } else if (sawRunning || Date.now() - started > 30_000) {
        if (settled === 0) ended = Date.now();
        if (++settled >= 2) break;
      }
      if (Date.now() - started > turnTimeoutMs) {
        result.status = 'timeout';
        ended = Date.now();
        break;
      }
    }
    result.durationMs = ended - started;
    result.phase = snapshot?.documents?.['gitspace.workspace']?.phase ?? null;
    result.openQuestions = snapshot?.questions.length ?? 0;
    log(`turn ${result.conversationStatus} after ${Math.round(result.durationMs / 1000)} s`);

    const rows = await transcript(workspaceId);
    const lastUser = rows.findLast(row => row.item.type === 'message' && row.item.role === 'user');
    const turn = rows.filter(row => row.turnId === lastUser?.turnId);
    const replies = turn.filter(row => row.item.type === 'message' && row.item.role === 'assistant' && (row.item.text ?? '').trim() !== '');
    result.tools = turn.flatMap(row => row.item.type === 'tool-call' && row.item.tool ? [`${row.item.tool}${row.item.target ? ` ${row.item.target}` : ''}`] : []);
    result.askTool = turn.some(row => row.item.type === 'ask');
    result.interruptions = turn.flatMap(row => row.item.type === 'interruption' ? [`${row.item.title ?? ''}: ${row.item.detail ?? ''}`] : []);
    result.usage = (await call('gitspace_runtime_session', { projectId, workspaceId, command: { type: 'usage' } }, usageSchema)).usage?.totals ?? null;
    // A corrected row's original: the version before the last one of the text part that ends as the row's text.
    const originals = new Map<string, string>();
    for (const row of replies) {
      if (!row.item.corrected?.length) continue;
      const history = [...versions.values()].find(seen => seen.at(-1)?.trim() === (row.item.text ?? '').trim());
      const original = history?.at(-2);
      if (original !== undefined && extractBlocks(original).filter(block => block.closed).length === extractBlocks(row.item.text ?? '').length) originals.set(row.id, original);
    }
    result.score = scoreReplies(replies, originals);
    if (result.status !== 'timeout') result.status = replies.length > 0 ? 'done' : 'failed';
    if (result.status === 'failed' && !result.error) result.error = result.interruptions.join('; ') || `no reply (conversation ${result.conversationStatus})`;
    await mkdir(join(outDir, 'runs'), { recursive: true });
    await writeFile(join(outDir, 'runs', `${name}.md`), replies.map(row => row.item.text ?? '').join('\n\n<!-- next message -->\n\n'));
    if (originals.size > 0) await writeFile(join(outDir, 'runs', `${name}.original.md`), replies.map(row => originals.get(row.id) ?? row.item.text ?? '').join('\n\n<!-- next message -->\n\n'));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`error: ${result.error}`);
  } finally {
    if (result.workspaceId) {
      const archived = await call('gitspace_workspace_archive', { projectId, spaceId: result.workspaceId, expectedGeneration: null }, operationSchema).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
      result.archived = archived instanceof Error ? `failed: ${archived.message}` : archived.id;
    }
    await mkdir(join(outDir, 'runs'), { recursive: true });
    await writeFile(join(outDir, 'runs', `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

// ------------------------------------------------------------------------------------------------------------ Report

function percent(part: number, whole: number): string {
  return whole === 0 ? '–' : `${Math.round((part / whole) * 100)}%`;
}

/** What one run scored against the current prompts.json: whether a scenario's reply has a component its `expected`
 * set names, whether a scenario that wants a required ask got one, and whether one that doesn't want it got one. */
function judged(result: RunResult) {
  const prompt = allPrompts.find(each => each.id === result.prompt);
  const scenario = result.kind === 'scenario' && result.score !== null;
  return {
    fit: scenario && (result.score?.components.some(component => prompt?.expected.includes(component)) ?? false),
    wantsAsk: scenario && prompt?.requiresAsk === true,
    asked: result.score?.requiredAsk ?? false,
    overAsked: scenario && prompt?.requiresAsk === false && (result.score?.requiredAsk ?? false),
  };
}

/** Per model: drew unprompted (scenario replies with a block), fit (scenario replies with an expected component),
 * over-drew (control replies with a block), required asks where a scenario wants one and over-asks (a required ask on
 * a scenario that doesn't), and how many blocks were invalid as written and fixed. */
function totals(results: readonly RunResult[]) {
  const scored = results.filter(result => result.score !== null && result.status === 'done');
  const scenarios = scored.filter(result => result.kind === 'scenario');
  const controls = scored.filter(result => result.kind === 'control');
  const blocks = scored.reduce((sum, result) => sum + (result.score?.blocks.length ?? 0), 0);
  const scenarioBlocks = scenarios.reduce((sum, result) => sum + (result.score?.blocks.length ?? 0), 0);
  const invalid = scored.reduce((sum, result) => sum + (result.score?.invalidAsWritten ?? 0), 0);
  const fixed = scored.reduce((sum, result) => sum + (result.score?.fixed ?? 0), 0);
  const drew = scenarios.filter(result => (result.score?.blocks.length ?? 0) > 0).length;
  const fit = scenarios.filter(result => judged(result).fit).length;
  const overDrew = controls.filter(result => (result.score?.blocks.length ?? 0) > 0).length;
  const wantAsk = scenarios.filter(result => judged(result).wantsAsk);
  const askFree = scenarios.filter(result => !judged(result).wantsAsk);
  const asked = wantAsk.filter(result => judged(result).asked).length;
  const overAsked = askFree.filter(result => judged(result).overAsked).length;
  const durations = scored.flatMap(result => result.durationMs === null ? [] : [result.durationMs]);
  return {
    runs: results.length,
    replied: scored.length,
    scenarios: scenarios.length,
    controls: controls.length,
    drew,
    fit,
    overDrew,
    wantAsk: wantAsk.length,
    asked,
    askFree: askFree.length,
    overAsked,
    drewRate: scenarios.length ? drew / scenarios.length : null,
    fitRate: scenarios.length ? fit / scenarios.length : null,
    overDrewRate: controls.length ? overDrew / controls.length : null,
    askedRate: wantAsk.length ? asked / wantAsk.length : null,
    overAskedRate: askFree.length ? overAsked / askFree.length : null,
    blocksPerScenarioReply: scenarios.length ? scenarioBlocks / scenarios.length : null,
    invalidBeforeFixRate: blocks ? invalid / blocks : null,
    fixedRate: invalid ? fixed / invalid : null,
    blocks,
    invalid,
    fixed,
    meanDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    totalTokens: scored.reduce((sum, result) => sum + (result.usage?.totalTokens ?? 0), 0),
    costUsd: scored.reduce((sum, result) => sum + (result.usage?.costUsd ?? 0), 0),
  };
}

/** The results grouped by `provider/model`, in the order the models first appear. */
function byModel(results: readonly RunResult[]): [string, RunResult[]][] {
  const groups = new Map<string, RunResult[]>();
  for (const result of results) {
    const key = `${result.provider}/${result.model}`;
    groups.set(key, [...groups.get(key) ?? [], result]);
  }
  return [...groups];
}

interface ReportMeta { stamp: string; accountUrl: string; projectId: string; thinking: string }

function markdown(results: readonly RunResult[], meta: ReportMeta, rescoredAt?: string): string {
  const lines = [
    `# Block fluency results, ${meta.stamp}`,
    '',
    `Account ${meta.accountUrl}, project ${meta.projectId}, thinking ${meta.thinking}.${rescoredAt ? ` Re-scored ${rescoredAt} against the current prompts.json.` : ''}`,
    '',
    '| Prompt | # | Kind | Model | Status | Blocks | Components | Drew | Fit | Required ask | Over-ask | Invalid as written | Fixed | Short/full | Prose before 1st block | Reply chars | Duration | Requests | Tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const result of results) {
    const score = result.score;
    const verdict = judged(result);
    const drew = score ? (score.blocks.length > 0 ? (result.kind === 'control' ? 'over-drew' : 'yes') : 'no') : '–';
    const fit = score && result.kind === 'scenario' ? (verdict.fit ? 'yes' : 'no') : '–';
    const required = verdict.wantsAsk ? (verdict.asked ? 'yes' : 'no') : '–';
    const overAsk = score && result.kind === 'scenario' && !verdict.wantsAsk ? (verdict.overAsked ? 'yes' : 'no') : '–';
    lines.push(`| ${result.prompt} | ${result.attempt} | ${result.kind} | ${result.model} | ${result.status}${result.error ? `: ${result.error.slice(0, 80).replaceAll('|', '\\|').replaceAll('\n', ' ')}` : ''} | ${score?.blocks.length ?? '–'} | ${score?.components.join(', ') || '–'} | ${drew} | ${fit} | ${required} | ${overAsk} | ${score?.invalidAsWritten ?? '–'} | ${score?.fixed ?? '–'} | ${score ? `${score.shortForm}/${score.fullForm}` : '–'} | ${score?.proseBeforeFirstBlock ?? '–'} | ${score?.replyChars ?? '–'} | ${result.durationMs === null ? '–' : `${Math.round(result.durationMs / 1000)} s`} | ${result.usage?.requests ?? '–'} | ${result.usage?.totalTokens ?? '–'} |`);
  }
  lines.push('', '| Model | Runs | Replied | Drew unprompted | Fit | Over-drew | Required ask when wanted | Over-ask | Blocks per scenario reply | Invalid before fix | Fixed | Mean duration | Tokens | Cost (USD) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [model, group] of byModel(results)) {
    const sum = totals(group);
    lines.push(`| ${model} | ${sum.runs} | ${sum.replied} | ${percent(sum.drew, sum.scenarios)} (${sum.drew}/${sum.scenarios}) | ${percent(sum.fit, sum.scenarios)} (${sum.fit}/${sum.scenarios}) | ${percent(sum.overDrew, sum.controls)} (${sum.overDrew}/${sum.controls}) | ${percent(sum.asked, sum.wantAsk)} (${sum.asked}/${sum.wantAsk}) | ${percent(sum.overAsked, sum.askFree)} (${sum.overAsked}/${sum.askFree}) | ${sum.blocksPerScenarioReply === null ? '–' : sum.blocksPerScenarioReply.toFixed(2)} | ${percent(sum.invalid, sum.blocks)} (${sum.invalid}/${sum.blocks}) | ${percent(sum.fixed, sum.invalid)} (${sum.fixed}/${sum.invalid}) | ${sum.meanDurationMs === null ? '–' : `${Math.round(sum.meanDurationMs / 1000)} s`} | ${sum.totalTokens} | ${sum.costUsd.toFixed(2)} |`);
  }
  const broken = results.flatMap(result => (result.score?.blocks ?? []).filter(block => block.issuesAsWritten.length > 0).map(block => ({ result, block })));
  if (broken.length > 0) {
    lines.push('', '## Invalid blocks as written', '');
    for (const { result, block } of broken) {
      const quoted = block.written === null ? ['As written: not seen before its correction. Corrected:', '', '````', block.shown, '````'] : ['As written:', '', '````', block.written, '````', ...(block.fixed ? ['', 'Corrected:', '', '````', block.shown, '````'] : [])];
      lines.push(`### ${result.prompt} #${result.attempt} × ${result.model} (${block.fixed ? 'fixed by its fix step' : 'not fixed'})`, '', ...block.issuesAsWritten.map(issue => `- ${issue}`), '', ...quoted, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------------------------------------------------- Main

// --rescore <dir>: score a finished run's stored results against the current prompts.json (expected sets and asks),
// without the account; writes results.rescored.{json,md} beside its results.json.
if (values.rescore) {
  const dir = resolve(values.rescore);
  const stored = z.object({ stamp: z.string(), accountUrl: z.string(), projectId: z.string(), thinking: z.string(), results: z.array(runResultSchema) })
    .parse(JSON.parse(await readFile(join(dir, 'results.json'), 'utf8')));
  const rescoredAt = new Date().toISOString();
  const summary = Object.fromEntries(byModel(stored.results).map(([model, group]) => [model, totals(group)]));
  await writeFile(join(dir, 'results.rescored.json'), `${JSON.stringify({ ...stored, rescoredAt, prompts: allPrompts, totals: summary }, null, 2)}\n`);
  const report = markdown(stored.results, stored, rescoredAt);
  await writeFile(join(dir, 'results.rescored.md'), report);
  console.log(report);
  process.exit(0);
}

const chosen = values.prompts?.split(',').map(id => id.trim());
const prompts = chosen ? allPrompts.filter(prompt => chosen.includes(prompt.id)) : allPrompts;
if (prompts.length === 0) throw new Error('No prompts selected');
const accountUrl = process.env.GITSPACE_ACCOUNT_URL?.replace(/\/+$/u, '');
const token = process.env.GITSPACE_MCP_TOKEN?.trim();
if (!accountUrl || !token) throw new Error('Set GITSPACE_ACCOUNT_URL and GITSPACE_MCP_TOKEN');
if (!values.project) throw new Error('Pass --project <projectId>: the eval project its workspaces are created in');
const projectId = values.project;
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const outDir = resolve(positionals[0] ?? join(homedir(), 'work', 'block-fluency-results', stamp));
const turnTimeoutMs = Number(values['timeout-minutes']) * 60_000;
const concurrency = Math.max(1, Number(values.concurrency));
const repeat = Math.max(1, Number(values.repeat));
const models = values.models.split(',').map((spec) => {
  const [provider, ...rest] = spec.trim().split('/');
  if (!provider || rest.length === 0) throw new Error(`A model is <provider>/<id>, not "${spec}"`);
  return { provider, model: rest.join('/') };
});
const meta: ReportMeta = { stamp, accountUrl, projectId, thinking: values.thinking };

const project = (await call('gitspace_project_list', { lifecycle: 'active' }, projectsSchema)).find(each => each.id === projectId);
if (!project) throw new Error(`No active project ${projectId}`);
const baseBranch = project.baseBranch ?? 'main';
await mkdir(outDir, { recursive: true });
console.log(`Writing to ${outDir}`);
// Attempts outermost, so every (prompt, model) pair runs once before any runs twice.
const jobs = Array.from({ length: repeat }, (_, index) => index + 1).flatMap(attempt => prompts.flatMap(prompt => models.map(target => ({ prompt, target, attempt }))));
const results: RunResult[] = new Array(jobs.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (next < jobs.length) {
    const index = next++;
    results[index] = await run(jobs[index].prompt, jobs[index].target, jobs[index].attempt, baseBranch);
    await writeFile(join(outDir, 'results.json'), `${JSON.stringify({ ...meta, prompts, results: results.filter(Boolean) }, null, 2)}\n`);
  }
}));
const summary = Object.fromEntries(byModel(results).map(([model, group]) => [model, totals(group)]));
await writeFile(join(outDir, 'results.json'), `${JSON.stringify({ ...meta, prompts, results, totals: summary }, null, 2)}\n`);
await writeFile(join(outDir, 'results.md'), markdown(results, meta));
console.log(markdown(results, meta));
