import { defineTask, type DocumentObserver, type Harness, type Task, type Tx } from '@earendil-works/pi-durable';
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import { MCP_ELICITATION_CHOICES, MCP_ELICITATION_REPLAY_MS, MCP_ELICITATION_TTL_MS, MCP_TASK_FOLLOW_MS, RuntimeMcpElicitationAnswerSchema, RuntimeMcpElicitationContentSchema, RuntimeMcpElicitResultSchema, mcpElicitationIssues, mcpElicitationLooksSecret, questionState, sameMcpElicitation, type RuntimeMcpElicit, type RuntimeMcpElicitationAnswer, type RuntimeMcpElicitationQuestion, type RuntimeMcpElicitationSource, type RuntimeMcpElicitResult, type RuntimeMcpHandoff, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { PendingAskAnswer } from '@gitspace/protocol-runtime/session-controls';
import { askAnswererName, type AskAnswerer } from '@gitspace/blocks';
import { McpElicitationsDoc, QuestionsDoc, type McpCall, type McpReplay, type Question } from './documents.js';
import { postQuestion, type QuestionClosure } from './questions.js';
import type { ConversationEvent, ConversationLifecycle } from './conversation-lifecycle.js';
import type { ToolServices } from './tools.js';

/**
 * Requests for input from people's MCP servers (issue #155; `@gitspace/protocol-runtime` mcp-elicitation.ts). A cloud
 * MCP call hands each request to `mcpElicitations(...).elicit`: a stored answer is replayed, or one `mcp-elicitation`
 * question is posted and waited on for MCP_ELICITATION_WINDOW_MS. A call that went on without an answer (its requests
 * answered `cancel`, or its server's task handed off) is recorded (`recordMcpCall`) and the agent's turn ends; once its
 * questions are answered (`answerMcpElicitation`, `continueMcpCall`), or every MCP_TASK_FOLLOW_MS for a task that waits on
 * nobody, the McpCall task calls the tool again (or resumes the task) and replays the answers, and its result is the
 * conversation's next input. Answers stay in McpElicitationsDoc; only `mcp-elicitation.ts` reads them.
 */

/** Delivered calls kept for run tracking; older ones are dropped as the document is written. */
const DELIVERED_CALLS = 32;
/** Characters of a continued call's result the conversation hears. */
const RESULT_SHOWN = 100_000;

/** Who answers: a person in GitSpace, an MCP client the person uses, the project agent or a stack head in the person's
 * place, or nobody in time (`expiry`). */
export type McpElicitationAnswerer = { by: 'person' } | { by: 'mcp-client'; answeredBy: AskAnswerer } | { by: 'agent'; answeredBy: AskAnswerer } | { by: 'expiry' };

/** The string values of an accepted answer: what a secret-looking form's answer is redacted by. */
function answerStrings(result: RuntimeMcpElicitResult): string[] {
  if (result.action !== 'accept') return [];
  return Object.values(result.content ?? {}).flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : []).filter(value => value.length > 0);
}

/**
 * What `answers` (an `answerAsk` command's, or the project agent's) say to `question`'s server: Done (a link's page was
 * completed: `accept`), Decline, Cancel, or a form's fields as one JSON object written as the answer, checked against
 * the server's form. Refused when `answerer` may not answer it: a secret-looking form only a person in GitSpace answers;
 * the project agent and stack heads answer forms only.
 */
export function mcpElicitationResult(question: Question, answers: readonly PendingAskAnswer[], answerer: McpElicitationAnswerer): RuntimeMcpElicitResult {
  const card = question.mcpElicitation;
  if (!card) throw new Error(`Question ${question.id} is not a request from an MCP server`);
  if (card.secretLooking && answerer.by !== 'person') throw new Error(`Question ${question.id} looks like it asks ${card.connection} for a secret, so only a person answers it, in GitSpace`);
  if (card.request.mode === 'url' && answerer.by === 'agent') throw new Error(`Question ${question.id} sends a person to ${card.host ?? 'a page'}; only a person, or their MCP client, answers it`);
  const [answer] = answers;
  const choice = answer?.selectedOptions[0];
  if (answers.length !== 1 || !answer || answer.selectedOptions.length > 1 || (choice !== undefined && answer.customInput)) throw new Error(`An answer to question ${question.id} is one of ${question.choices.join(', ')}${card.request.mode === 'form' ? ', or the form\'s fields as a JSON object written as the answer' : ''}`);
  if (choice === MCP_ELICITATION_CHOICES.decline) return { action: 'decline' };
  if (choice === MCP_ELICITATION_CHOICES.cancel) return { action: 'cancel' };
  if (card.request.mode === 'url') {
    if (choice !== MCP_ELICITATION_CHOICES.done) throw new Error(`An answer to question ${question.id} is ${question.choices.join(', ')}`);
    return { action: 'accept' };
  }
  if (choice !== undefined || !answer.customInput) throw new Error(`An answer to question ${question.id} is Decline, Cancel, or the form's fields as a JSON object written as the answer`);
  let written: unknown;
  try { written = JSON.parse(answer.customInput); } catch { written = undefined; }
  const content = RuntimeMcpElicitationContentSchema.safeParse(written);
  const issues = content.success ? mcpElicitationIssues(card.request.requestedSchema, content.data) : ['the answer is not a JSON object of the form\'s fields'];
  if (!content.success || issues.length > 0) throw new Error(`The answer to question ${question.id} does not fit ${card.connection}'s form: ${issues.join('; ')}`);
  return { action: 'accept', content: content.data };
}

/**
 * Records `result`, `answerer`'s answer to the open `mcp-elicitation` question `question`, in `tx` for the call that
 * waits on it, and answers the closure the question closes with: the action, and the form's values unless the form looks
 * secret (`withheld`). A question whose call no longer waits on it is refused.
 */
export async function answerMcpElicitation(tx: Tx, question: Question, result: RuntimeMcpElicitResult, answerer: McpElicitationAnswerer): Promise<Exclude<QuestionClosure, { dismissed: true }>> {
  const asked = (await tx.doc(McpElicitationsDoc)).asked[question.id];
  if (!asked) throw new Error(`Question ${question.id}'s MCP call no longer waits for an answer`);
  asked.result = result;
  const answer: RuntimeMcpElicitationAnswer = { action: result.action, ...result.action === 'accept' && result.content ? question.mcpElicitation?.secretLooking ? { withheld: true } : { content: result.content } : {}, ...answerer.by === 'expiry' ? { expired: true } : {} };
  return { answer, ...answerer.by === 'mcp-client' || answerer.by === 'agent' ? { answeredBy: answerer.answeredBy } : {} };
}

/** A call whose questions were all answered is continued now; one following a task that waits on nobody, after
 * MCP_TASK_FOLLOW_MS. */
export type McpCallTask = Task<{ call: string; after: number | null }, { phase: 'wait'; until: number } | { phase: 'call' } | { phase: 'deliver' }, null, object>;

/** Moves the answers its questions got into call `id`'s replay; when none is left to wait for, starts the call's task
 * (after MCP_TASK_FOLLOW_MS when `follow`). In `tx`. */
async function waitOrContinue(tx: Tx, id: string, task: McpCallTask, follow: boolean): Promise<void> {
  const doc = await tx.doc(McpElicitationsDoc);
  const call = doc.calls[id];
  if (!call) return;
  const questions = (await tx.doc(QuestionsDoc)).items;
  for (const questionId of [...call.waits]) {
    const asked = doc.asked[questionId];
    const question = questions.find(item => item.id === questionId);
    if (!asked?.result || !question?.mcpElicitation) continue;
    call.replay.push({ request: question.mcpElicitation.request, inputId: asked.inputId, result: asked.result });
    if (question.mcpElicitation.secretLooking) call.secrets.push(...answerStrings(asked.result));
    call.waits = call.waits.filter(item => item !== questionId);
    delete doc.asked[questionId];
  }
  if (call.waits.length > 0 || call.state !== 'waiting') return;
  call.state = 'continuing';
  await tx.createTask(task, { call: id, after: follow ? Date.now() + MCP_TASK_FOLLOW_MS : null }, { ownership: { kind: 'conversation' }, background: true });
}

/** Question `questionId` was answered (in `tx`): a paused call waiting on it takes the answer, and continues once it
 * waits on nothing more. A live call's waiter takes it itself. */
export async function continueMcpCall(tx: Tx, questionId: string, task: McpCallTask): Promise<void> {
  const asked = (await tx.doc(McpElicitationsDoc)).asked[questionId];
  if (asked?.state === 'paused' && asked.call) await waitOrContinue(tx, asked.call, task, false);
}

/** Writes through a tool call's or a task's commit. */
export type McpElicitationStore = { commit(change: (tx: Tx) => Promise<void>): Promise<void>; observer: DocumentObserver; context: Context };

/**
 * One cloud MCP call's requests for input (`elicit`), for conversation `conversationId`'s call `callId` to `tool` on
 * connection `connectionId`: a request matching a stored answer of `replay` (until MCP_ELICITATION_REPLAY_MS from now) is
 * answered from it, once; otherwise a question is posted and waited on for MCP_ELICITATION_WINDOW_MS. `answered` holds
 * every answer the call gave, `paused` the questions it went on without, `secrets` the values of secret-looking answers.
 * A subagent's call (`child`) asks nobody: it declines, and says so in `declined`.
 */
export function mcpElicitations(input: { store: McpElicitationStore; conversationId: string; callId: string; connectionId: string; tool: string; child: string | null; replay: readonly McpReplay[]; secrets: readonly string[]; windowMs: number; wakeAt(at: number): Promise<void> }) {
  const unused = [...input.replay];
  const replayUntil = Date.now() + MCP_ELICITATION_REPLAY_MS;
  const state: { answered: McpReplay[]; paused: string[]; secrets: string[]; declined: string[]; source: RuntimeMcpElicitationSource | null } = { answered: [], paused: [], secrets: [...input.secrets], declined: [], source: null };
  async function answerOf(id: string): Promise<'answered' | 'closed' | 'waiting'> {
    const watch = await input.store.observer.watchDoc(McpElicitationsDoc, input.store.context);
    if (!watch) throw new Error('MCP elicitations missing');
    const arrived = Promise.withResolvers<'answered' | 'closed' | 'waiting'>();
    const read = (value: typeof watch.value) => { const asked = value?.asked[id]; if (!asked) arrived.resolve('closed'); else if (asked.result) arrived.resolve('answered'); };
    const timer = setTimeout(() => arrived.resolve('waiting'), input.windowMs);
    try {
      read(watch.value);
      watch.start(async call => { if (call.kind === 'value') read(call.value); });
      return await awaitWithContext(arrived.promise, input.store.context);
    } finally { clearTimeout(timer); await watch.stop(); }
  }
  const elicit: RuntimeMcpElicit = async ({ request, source, scope, taskId, inputId }) => {
    state.source = source;
    const index = Date.now() <= replayUntil ? unused.findIndex(entry => (entry.inputId === null || inputId === null || entry.inputId === inputId) && sameMcpElicitation(entry.request, request)) : -1;
    const replayed = index >= 0 ? unused.splice(index, 1)[0] : undefined;
    if (replayed) { state.answered.push({ ...replayed, inputId }); return replayed.result; }
    if (input.child) { state.declined.push(request.message); return { action: 'decline' }; }
    const id = `mcp-elicitation:${crypto.randomUUID()}`;
    const askedAt = new Date();
    const card: RuntimeMcpElicitationQuestion = { connectionId: input.connectionId, ...source, tool: input.tool, request, host: request.mode === 'url' ? new URL(request.url).host : null, secretLooking: mcpElicitationLooksSecret(request), scope, taskId, callId: input.callId, askedAt: askedAt.toISOString(), expiresAt: new Date(askedAt.getTime() + MCP_ELICITATION_TTL_MS).toISOString() };
    const choices = request.mode === 'url' ? [MCP_ELICITATION_CHOICES.done, MCP_ELICITATION_CHOICES.decline, MCP_ELICITATION_CHOICES.cancel] : [MCP_ELICITATION_CHOICES.decline, MCP_ELICITATION_CHOICES.cancel];
    await input.store.commit(async tx => {
      await postQuestion(tx, { id, conversationId: input.conversationId, kind: 'mcp-elicitation', prompt: `${source.connection} asks: ${request.message}`, choices, mcpElicitation: card });
      (await tx.doc(McpElicitationsDoc)).asked[id] = { state: 'live', call: null, inputId };
    });
    // The workspace wakes when the question expires, to close it if nobody answered (`expireMcpElicitations`).
    await input.wakeAt(Date.parse(card.expiresAt));
    if (await answerOf(id) === 'closed') return { action: 'cancel' };
    let result: RuntimeMcpElicitResult | undefined;
    let open = false;
    await input.store.commit(async tx => {
      const doc = await tx.doc(McpElicitationsDoc);
      const asked = doc.asked[id];
      // A copy: the draft is unusable once the commit settles.
      if (asked?.result) { result = RuntimeMcpElicitResultSchema.parse(asked.result); delete doc.asked[id]; }
      else if (asked) { asked.state = 'paused'; open = true; }
    });
    if (result) {
      state.answered.push({ request, inputId, result });
      if (card.secretLooking) state.secrets.push(...answerStrings(result));
      return result;
    }
    if (open) state.paused.push(id);
    return open ? null : { action: 'cancel' };
  };
  return { elicit, state };
}

/** Each of `secrets` replaced by `[redacted]` in `text`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let shown = text;
  for (const secret of secrets) if (secret) shown = shown.replaceAll(secret, '[redacted]').replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]');
  return shown;
}

/** A tool result's text as the conversation hears it: its content's text (or its failure), redacted, cut short. */
export function mcpResultText(result: RuntimeToolResult, secrets: readonly string[]): string {
  const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
  const body = redactSecrets(result.status === 'failed' ? `${result.error.message}${text ? `\n${text}` : ''}` : result.status === 'interrupted' ? `It was interrupted before it returned; its outcome is unknown.${text ? `\n${text}` : ''}` : text, secrets);
  return body.length <= RESULT_SHOWN ? body : `${body.slice(0, RESULT_SHOWN)}… (${body.length - RESULT_SHOWN} more characters left out)`;
}

/**
 * Records a call (by `args`, from conversation `conversationId`'s call `callId`) that went on without a person: its
 * `paused` questions, or its server's task it handed off (`handoff`). It waits on the questions not yet answered, and
 * continues (`McpCall`) once there are none: at once when its questions were answered meanwhile, after
 * MCP_TASK_FOLLOW_MS when it follows a task that waits on nobody. `id` names a call this continues; a new one gets an id.
 * Answers the call's id, or null when there is nothing to record.
 */
export async function recordMcpCall(tx: Tx, task: McpCallTask, input: { id: string | null; conversationId: string; callId: string; connectionId: string; connection: string; tool: string; args: JsonValue; answered: readonly McpReplay[]; paused: readonly string[]; secrets: readonly string[]; handoff: RuntimeMcpHandoff | null }): Promise<string | null> {
  if (input.paused.length === 0 && !input.handoff) return null;
  const doc = await tx.doc(McpElicitationsDoc);
  const id = input.id ?? `mcp-call:${crypto.randomUUID()}`;
  // A question closed meanwhile (the person wrote instead of answering, or stopped the conversation) ends the call.
  if (input.paused.some(questionId => !doc.asked[questionId])) {
    for (const questionId of input.paused) delete doc.asked[questionId];
    delete doc.calls[id];
    return null;
  }
  const previous = doc.calls[id];
  doc.calls[id] = { conversationId: input.conversationId, callId: input.callId, at: previous?.at ?? new Date().toISOString(), event: previous?.event ?? id, connectionId: input.connectionId, connection: input.connection, tool: input.tool, args: input.args, task: input.handoff?.reference ?? null, waits: [...input.paused], replay: [...input.answered], secrets: [...input.secrets], state: 'waiting' };
  for (const questionId of input.paused) {
    const asked = doc.asked[questionId];
    if (asked) asked.call = id;
  }
  await waitOrContinue(tx, id, task, input.paused.length === 0);
  return id;
}

/** The agent's questions answered for call `call`, as the conversation hears them with its result. */
function answersText(questions: readonly Question[], call: McpCall): string {
  return questions.filter(question => question.mcpElicitation?.callId === call.callId && question.answer !== null).map(question => {
    const card = question.mcpElicitation;
    const answer = RuntimeMcpElicitationAnswerSchema.safeParse(question.answer);
    const by = !question.answeredBy ? 'the user' : question.answeredBy.by === 'mcp-client' ? 'the user through an MCP client' : askAnswererName(question.answeredBy);
    const what = !answer.success ? 'answered' : answer.data.expired ? 'nobody answered in time (cancelled)'
      : answer.data.action === 'decline' ? `${by} declined` : answer.data.action === 'cancel' ? `${by} cancelled`
      : card?.request.mode === 'url' ? `${by} completed the page at ${card.host ?? 'its link'}`
      : answer.data.withheld ? `${by} answered (the values are not shown: the form looked like it asked for a secret)` : `${by} answered ${JSON.stringify(answer.data.content ?? {})}`;
    return `- Question ${question.id} ("${card?.request.message.slice(0, 200) ?? question.prompt}"): ${what}`;
  }).join('\n');
}

/**
 * Continues a recorded call (`recordMcpCall`) through `invoke`: the tool called again with its arguments, or its
 * server's task resumed, its stored answers replayed and new requests asked (`mcpElicitations`). A call that goes on
 * without a person again is recorded again; a finished one's result is delivered to its conversation as an
 * `mcp-result` event (the call's `event`), which starts its next turn.
 */
export function createMcpCallTask(services: { invoke: ToolServices['invoke']; deliver(event: ConversationEvent): Promise<void>; wakeAt(at: number): Promise<void>; windowMs: number }): McpCallTask {
  const task: McpCallTask = defineTask<{ call: string; after: number | null }, { phase: 'wait'; until: number } | { phase: 'call' } | { phase: 'deliver' }, null>({
    name: 'gitspace.McpCall', version: 1, initial: input => input.after === null ? { phase: 'call' } : { phase: 'wait', until: input.after },
    phases: {
      async wait(running, runtime, context) { await runtime.sleepUntil(running.state.checkpoint.until, { phase: 'call' }, context); },
      async call(running, runtime, context) {
        const id = running.input.call;
        const call = (await runtime.snapshot(McpElicitationsDoc, context))?.calls[id];
        if (!call || call.state !== 'continuing') { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context); return; }
        const store: McpElicitationStore = { commit: change => runtime.commit(async tx => { await change(tx); return undefined; }, context), observer: runtime, context };
        const session = mcpElicitations({ store, conversationId: call.conversationId, callId: call.callId, connectionId: call.connectionId, tool: call.tool, child: null, replay: call.replay, secrets: call.secrets, windowMs: services.windowMs, wakeAt: services.wakeAt });
        const attempt = `${id}:${String(runtime.taskId)}:${Date.now()}`;
        const result = await services.invoke({ tool: 'mcp_invoke', args: call.args, conversationId: call.conversationId, taskId: String(runtime.taskId), requestId: attempt, attemptId: attempt, replay: 'unsafe', signal: runtime.signal, mcpElicit: session.elicit, ...call.task ? { mcpTask: call.task } : {} });
        const handoff = result.status === 'completed' ? result.mcpTask ?? null : null;
        if (handoff || session.state.paused.length > 0) {
          await runtime.commit(async tx => {
            await recordMcpCall(tx, task, { id, conversationId: call.conversationId, callId: call.callId, connectionId: call.connectionId, connection: call.connection, tool: call.tool, args: call.args, answered: session.state.answered, paused: session.state.paused, secrets: session.state.secrets, handoff });
            return { status: 'terminal', outcome: { status: 'completed', result: null } };
          }, context);
          return;
        }
        await runtime.commit(async tx => {
          const current = (await tx.doc(McpElicitationsDoc)).calls[id];
          if (!current) return { status: 'terminal', outcome: { status: 'completed', result: null } };
          const answers = answersText((await tx.doc(QuestionsDoc)).items, current);
          current.result = `${current.connection}'s ${current.tool} ${result.status === 'completed' ? 'finished' : 'failed'} after GitSpace continued it${current.task ? ` (following its task ${current.task.taskId})` : ''}${answers ? `, with these answers:\n${answers}` : ''}.\nIts result:\n${mcpResultText(result, session.state.secrets)}`;
          return { status: 'running', checkpoint: { phase: 'deliver' } };
        }, context);
      },
      async deliver(running, runtime, context) {
        const id = running.input.call;
        const call = (await runtime.snapshot(McpElicitationsDoc, context))?.calls[id];
        if (call?.result !== undefined) await services.deliver({ conversationId: call.conversationId, requestId: call.event, kind: 'mcp-result', sender: { id: `mcp:${call.connectionId}`, name: `${call.connection} (MCP server)` }, text: call.result });
        await runtime.commit(async tx => {
          const doc = await tx.doc(McpElicitationsDoc);
          const current = doc.calls[id];
          if (current) doc.calls[id] = { ...current, args: null, task: null, waits: [], replay: [], secrets: [], state: 'delivered', result: undefined };
          const delivered = Object.entries(doc.calls).filter(([, item]) => item.state === 'delivered').sort(([, a], [, b]) => b.at.localeCompare(a.at));
          for (const [key] of delivered.slice(DELIVERED_CALLS)) delete doc.calls[key];
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }, context);
      },
    },
    async abort(running, runtime, context) {
      await runtime.commit(async tx => {
        delete (await tx.doc(McpElicitationsDoc)).calls[running.input.call];
        return { status: 'terminal', outcome: { status: 'aborted', reason: 'The conversation was stopped' } };
      }, context);
    },
  });
  return task;
}

/** Closes each open `mcp-elicitation` question that expired by `now` with `cancel` (`expired`), which its call gives the
 * server; answers when the next open one expires, or null when none is open. */
export async function expireMcpElicitations(harness: Pick<Harness, 'snapshot'>, lifecycle: Pick<ConversationLifecycle, 'closeQuestion'>, now: number): Promise<number | null> {
  let next: number | null = null;
  for (const question of (await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? []) {
    const card = question.mcpElicitation;
    if (question.kind !== 'mcp-elicitation' || !card || questionState(question) !== 'open') continue;
    const expiresAt = Date.parse(card.expiresAt);
    if (expiresAt > now) { next = next === null ? expiresAt : Math.min(next, expiresAt); continue; }
    await lifecycle.closeQuestion(question.id, async (asked, tx) => ({ closure: await answerMcpElicitation(tx, asked, { action: 'cancel' }, { by: 'expiry' }), value: undefined }))
      .catch((error: unknown) => console.warn(JSON.stringify({ event: 'mcp_elicitation_expiry_skipped', questionId: question.id, error: error instanceof Error ? error.message : String(error) })));
  }
  return next;
}
