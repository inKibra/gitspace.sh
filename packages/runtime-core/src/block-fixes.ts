// Block corrections: a reply whose ```gitspace-ui, ```svg or ```mermaid blocks do not validate is followed by a hidden
// fix step, a run of its own that asks the agent to call fix_block once per invalid block. A valid correction is
// appended as a correction entry; the stored reply never changes. The entry's context edit replaces the reply in the
// model's context, and the transcript reader shows the reply with its corrections (`correctedReply`).
import { AssistantEntry, GenerationTask, LiveDoc, defineEntry, defineExtension, defineTask, defineTool, hook, runEndTask, type ConversationId, type EntryRecord, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { extractBlocks, mapBlockColours, validateMarkdownBlocks, type UiBlockKind } from '@gitspace/protocol/gitspace-ui';
import { BlockCorrectionsDoc } from './documents.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { BLOCK_FIX_REQUEST } from './transcript-rows.js';

/** fix_block calls one block takes; after the last, its error card stays. */
export const BLOCK_FIX_TRIES = 3;
/** Issues one block lists; the rest are counted. */
const LISTED_ISSUES = 8;
const SCAN_ENTRIES = 32;

/** An invalid block of a run's replies: numbered through them from 1, where it is (the reply entry, its model message,
 * the text part and the block's index among that part's blocks), its root element's id, and its issues. */
export type InvalidBlock = { number: number; entry: number; message: number; part: number; block: number; kind: UiBlockKind; id: string | null; issues: string[] };
/** A block a correction entry corrected: where it is in the reply, when, and the issues the correction fixed. */
export type BlockCorrection = { message: number; part: number; block: number; at: string; issues: string[] };

/** A fix step's input entry; it lists the blocks the step fixes. */
export const BlockFixEntry = defineEntry<{ blocks: InvalidBlock[] }>('gitspace.block-fix');
/** A reply's corrections so far: every corrected block, and a context edit that replaces the reply with them in place. */
export const BlockCorrectionEntry = defineEntry<{ reply: number; corrected: BlockCorrection[] }>('gitspace.block-correction');

/** The root element id of a gitspace-ui block's spec; null for another block or one without. */
function blockId(kind: UiBlockKind, body: string): string | null {
  if (kind !== 'gitspace-ui') return null;
  try {
    const spec: unknown = JSON.parse(body);
    if (typeof spec !== 'object' || spec === null || !('root' in spec) || !('elements' in spec) || typeof spec.root !== 'string' || typeof spec.elements !== 'object' || spec.elements === null) return null;
    const root: unknown = Reflect.get(spec.elements, spec.root);
    return typeof root === 'object' && root !== null && 'id' in root && typeof root.id === 'string' ? root.id : null;
  } catch {
    return null;
  }
}

/** The issues of block `index` (from 0) among `issues` of one Markdown text, each `<path>: <message>`. */
function blockIssues(issues: readonly { path: string; message: string }[], index: number): string[] {
  const prefix = `block ${index + 1}`;
  return issues.flatMap(issue => issue.path === prefix || issue.path.startsWith(`${prefix}/`) ? [issue.path === prefix ? issue.message : `${issue.path.slice(prefix.length)}: ${issue.message}`] : []);
}

/** The invalid blocks of `replies` (assistant entries, oldest first), numbered through their text parts in order from 1;
 * each text part is validated as one document. */
export function invalidBlocks(replies: readonly EntryRecord[]): InvalidBlock[] {
  const found: InvalidBlock[] = [];
  let number = 0;
  for (const entry of replies) (entry.model ?? []).forEach((message, messageIndex) => {
    if (message.role !== 'assistant') return;
    message.content.forEach((part, partIndex) => {
      if (part.type !== 'text') return;
      const blocks = extractBlocks(part.text);
      const issues = blocks.length > 0 ? validateMarkdownBlocks(part.text) : [];
      blocks.forEach((block, blockIndex) => {
        number++;
        const own = blockIssues(issues, blockIndex);
        if (own.length > 0) found.push({ number, entry: Number(entry.id), message: messageIndex, part: partIndex, block: blockIndex, kind: block.kind, id: blockId(block.kind, block.body), issues: own });
      });
    });
  });
  return found;
}

/** What a fix step asks the agent: each invalid block by number, id and kind with its issues (the first 8 listed, the
 * rest counted), and to call fix_block once per block and write nothing else. */
export function blockFixPrompt(blocks: readonly InvalidBlock[]): string {
  const lines = blocks.map(block => {
    const listed = block.issues.slice(0, LISTED_ISSUES);
    const more = block.issues.length - listed.length;
    return `Block ${block.number} (${block.kind}${block.id === null ? '' : `, id "${block.id}"`}): ${listed.join('; ')}${more > 0 ? `; …and ${more} more` : ''}`;
  });
  return [
    `Your reply holds ${blocks.length === 1 ? 'a block that does' : 'blocks that do'} not validate; the chat shows an error card in place of ${blocks.length === 1 ? 'it' : 'each'}. Blocks are numbered through your reply from 1.`,
    ...lines,
    `Correct ${blocks.length === 1 ? 'it' : 'them'} in place: call fix_block once per block, with block (its number or id) and source (the corrected body of its fence, without the fence lines), checked against skill://gitspace-ui. Each block takes ${BLOCK_FIX_TRIES} tries. Write nothing else: the person sees only your reply, with each block replaced by its correction.`,
  ].join('\n');
}

/** The reply `reply` as its newest correction entry `correction` leaves it: the model messages with the corrections in
 * place and what was corrected; undefined when `correction` is not a correction of it. */
export function correctedReply(reply: EntryRecord, correction: EntryRecord | undefined): { model: readonly Message[]; corrected: BlockCorrection[] } | undefined {
  if (!BlockCorrectionEntry.is(correction) || correction.data.reply !== Number(reply.id)) return undefined;
  const edit = correction.edits?.find(item => item.target === reply.id);
  return edit?.action === 'replace' ? { model: edit.messages, corrected: correction.data.corrected } : undefined;
}

/** How long a fix step waits for its inference admission. The person's run is held until the step is queued or given up,
 * so a slow or hung admission must not keep the conversation busy. */
export const BLOCK_FIX_ADMISSION_MS = 30_000;

/**
 * The fix step after a main conversation's run whose replies hold invalid blocks: an `afterRun` hook asks for a task that
 * admits inference for it (`admit`) and queues it as a follow-up input placed as a `BlockFixEntry`, which starts its run
 * when this one ends. A fix step's own run asks for none. An admission that fails or takes longer than `admissionMs` gives
 * the step up: it is reported, nothing is queued, the error cards stay and the run ends. The hook reads no entries of the
 * run, whose tool results can be megabytes: `noteReply` keeps each committed reply that holds blocks, until its run ends,
 * and the hook reads only the answer when it was not noted (its commit was not seen here, as after a restart).
 */
export function createBlockFixes(admit: (conversationId: ConversationId, requestId: string) => Promise<void>, admissionMs = BLOCK_FIX_ADMISSION_MS) {
  const noted = new Map<ConversationId, EntryRecord[]>();
  const BlockFixTask = defineTask<{ requestId: string; text: string; blocks: InvalidBlock[] }, { phase: 'submit' }, null>({
    name: 'gitspace.BlockFix', version: 1, initial: () => ({ phase: 'submit' }),
    phases: {
      async submit(task, runtime, context) {
        const given = Promise.withResolvers<string>();
        const timer = setTimeout(() => given.resolve(`its inference admission took longer than ${admissionMs / 1000} s`), admissionMs);
        const abort = () => given.resolve('it was stopped');
        runtime.signal.addEventListener('abort', abort, { once: true });
        let refusal: string | null;
        try {
          refusal = await Promise.race([admit(runtime.conversationId, task.input.requestId).then(() => null, (error: unknown) => `its inference admission failed: ${error instanceof Error ? error.message : String(error)}`), given.promise]);
        } finally {
          clearTimeout(timer);
          runtime.signal.removeEventListener('abort', abort);
        }
        const handle = refusal === null ? await runtime.conversation(runtime.conversationId, context) : undefined;
        if (!handle) {
          runtime.report(new Error(`The block fix step was given up: ${refusal ?? 'its conversation is gone'}`));
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
          return;
        }
        await runtime.commit(async tx => {
          await handle.submit(tx, { type: 'input', requestId: task.input.requestId, content: task.input.text, whenBusy: 'followUp', entry: { kind: BlockFixEntry.kind, data: { blocks: task.input.blocks } } });
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }, context);
      },
    },
    async abort(_task, runtime, context) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context); },
  });
  const extension = defineExtension({ name: 'gitspace.block-fixes', tasks: [BlockFixTask], hooks: [hook(GenerationTask, { async afterRun(run, api, context) {
    const kept = noted.get(api.conversationId) ?? [];
    const later = kept.filter(entry => Number(entry.id) > Number(run.last));
    if (later.length > 0) noted.set(api.conversationId, later);
    else noted.delete(api.conversationId);
    if ((await api.snapshot(AgentDefinitionContextDoc, api.conversationId, context))?.child) return undefined;
    // One entry read as a one-entry range: `api.entry` resolves visibility through the whole conversation.
    const [first] = (await api.entries({ minEntryId: run.first, maxEntryId: run.first }, 1, undefined, context)).items;
    if (BlockFixEntry.is(first)) return undefined;
    const replies = kept.filter(entry => Number(entry.id) >= Number(run.first) && Number(entry.id) <= Number(run.last));
    const [answer] = replies.some(entry => entry.id === run.answer) ? [] : (await api.entries({ minEntryId: run.answer, maxEntryId: run.answer }, 1, undefined, context)).items;
    if (AssistantEntry.is(answer)) replies.push(answer);
    const blocks = invalidBlocks(replies);
    if (blocks.length === 0) return undefined;
    return { tasks: [runEndTask(BlockFixTask, { requestId: `${BLOCK_FIX_REQUEST}${String(run.answer)}`, text: blockFixPrompt(blocks), blocks })] };
  } })] });
  return {
    extension,
    /** Keeps a committed reply that holds blocks for its run's `afterRun` hook. */
    noteReply(entry: EntryRecord): void {
      if (!AssistantEntry.is(entry) || !(entry.model ?? []).some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && extractBlocks(part.text).length > 0))) return;
      noted.set(entry.conversationId, [...noted.get(entry.conversationId) ?? [], entry]);
    },
  };
}

const FIX_BLOCK_PARAMETERS = Type.Object({
  block: Type.Union([Type.Integer({ minimum: 1 }), Type.String()], { description: 'The block\'s number, as GitSpace listed it, or its id.' }),
  source: Type.String({ description: 'The corrected body of the block\'s fence, without the fence lines.' }),
});

/** What one fix_block call answers: its text, whether it failed, and whether the step's run ends with it. */
function fixResult(text: string, isError: boolean, terminate: boolean): ToolExecutionResult {
  return { output: [{ type: 'text', text }], isError, ...(terminate ? { control: { terminate: true } } : {}) };
}

/**
 * fix_block corrects one listed block of a fix step: the corrected text part is checked with the same validator, as one
 * document, and only that block's issues refuse it. A valid one is appended as a correction entry holding every
 * correction of the reply so far, with a context edit that replaces the reply, and becomes the reply's newest in
 * `BlockCorrectionsDoc`. A block takes `BLOCK_FIX_TRIES` calls. The step's run ends with the round in which every
 * listed block is corrected or out of tries.
 */
export const fixBlockTool = defineTool({
  name: 'fix_block', callers: ['model'], replay: 'safe', parameters: FIX_BLOCK_PARAMETERS,
  description: 'Correct one invalid block of your reply in place, when GitSpace lists your reply\'s invalid blocks: block is its number (or id), source the corrected body of its fence. The person sees your reply with the block corrected.',
  async execute(args, api, context) {
    const first = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.first;
    return api.commit(async tx => {
      const step = first === undefined ? undefined : await tx.entry(BlockFixEntry, first);
      if (!step) return fixResult('fix_block corrects blocks only when GitSpace lists your reply\'s invalid blocks; nothing was changed.', true, false);
      const listed = step.data.blocks;
      const named = (block: unknown) => listed.find(item => item.number === block || (typeof block === 'string' && (item.id === block || String(item.number) === block)));
      const target = named(args.block);
      if (!target) return fixResult(`No listed block is ${JSON.stringify(args.block)}; the blocks to correct are ${listed.map(item => item.id === null ? String(item.number) : `${item.number} ("${item.id}")`).join(', ')}.`, true, false);
      // The step's calls per block up to this one, the blocks the rest of this one's round names, and the blocks
      // corrected so far in this step.
      const tries = new Map<number, number>();
      const round = new Set<number>();
      const fixed = new Set<number>();
      let reached = false;
      let cursor;
      do {
        const page = await tx.scanEntries({ conversationId: api.conversationId, minEntryId: first, order: 'ascending' }, SCAN_ENTRIES, cursor);
        for (const entry of page.items) {
          if (BlockCorrectionEntry.is(entry)) for (const block of listed) if (entry.data.corrected.some(item => item.message === block.message && item.part === block.part && item.block === block.block && entry.data.reply === block.entry)) fixed.add(block.number);
          for (const message of entry.model ?? []) {
            if (message.role !== 'assistant') continue;
            const calls = message.content.flatMap(part => part.type === 'toolCall' && part.name === 'fix_block' ? [part] : []);
            const ours = calls.some(call => call.id === api.callId);
            for (const call of calls) {
              const block = named(call.arguments.block);
              if (block && ours && call.id !== api.callId) round.add(block.number);
              if (block && !reached) tries.set(block.number, (tries.get(block.number) ?? 0) + 1);
              reached ||= call.id === api.callId;
            }
          }
        }
        cursor = page.next;
      } while (cursor);
      const used = tries.get(target.number) ?? 1;
      const othersDone = listed.every(block => block.number === target.number || fixed.has(block.number) || (tries.get(block.number) ?? 0) >= BLOCK_FIX_TRIES || round.has(block.number));
      if (fixed.has(target.number)) return fixResult(`Block ${target.number} is already corrected.`, false, othersDone);
      if (used > BLOCK_FIX_TRIES) return fixResult(`Block ${target.number} had its ${BLOCK_FIX_TRIES} tries; its error card stays.`, true, othersDone);
      // The conversation's entry `id`, read as its newest at or below it.
      const entryAt = async (id: number) => {
        const [found] = (await tx.scanEntries({ conversationId: api.conversationId }, 1, { after: id + 1 })).items;
        return found !== undefined && Number(found.id) === id ? found : undefined;
      };
      const reply = await entryAt(target.entry);
      if (!reply) return fixResult(`Block ${target.number} is no longer in your reply; nothing was changed.`, true, othersDone);
      const corrections = await tx.doc(BlockCorrectionsDoc, api.conversationId);
      const previousId = corrections.replies[String(target.entry)];
      const previous = previousId === undefined ? undefined : correctedReply(reply, await entryAt(previousId));
      const messages = [...previous?.model ?? reply.model ?? []];
      const message = messages[target.message];
      const part = message?.role === 'assistant' ? message.content[target.part] : undefined;
      const blocks = part?.type === 'text' ? extractBlocks(part.text) : [];
      const original = blocks[target.block];
      if (message?.role !== 'assistant' || part?.type !== 'text' || !original) return fixResult(`Block ${target.number} is no longer in your reply; nothing was changed.`, true, othersDone);
      // The fence keeps its marker and kind; a source that is itself one whole fence gives its kind and body.
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(part.text.slice(original.start))?.[1] ?? '```';
      const whole = /^\s*(?:`{3,}|~{3,})/.test(args.source) ? extractBlocks(args.source.trim()) : [];
      const [given] = whole.length === 1 && whole[0]?.closed ? whole : [];
      const corrected = mapBlockColours(`${fence}${given?.kind ?? original.kind}\n${given?.body ?? args.source.replace(/\n$/, '')}\n${fence}`);
      const text = part.text.slice(0, original.start) + corrected + part.text.slice(original.end);
      const issues = blockIssues(validateMarkdownBlocks(text), target.block);
      const left = BLOCK_FIX_TRIES - used;
      if (extractBlocks(text).length !== blocks.length) {
        return fixResult(`The source of block ${target.number} holds a fence line; send only the body of its fence. ${left > 0 ? `${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That was its last try; its error card stays.'}`, true, left === 0 && othersDone);
      }
      if (issues.length > 0) {
        return fixResult(`Block ${target.number} is still invalid: ${issues.join('; ')}. ${left > 0 ? `${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That was its last try; its error card stays.'}`, true, left === 0 && othersDone);
      }
      messages[target.message] = { ...message, content: message.content.map((item, index) => index === target.part ? { ...part, text } : item) };
      const at = new Date(api.now()).toISOString();
      const kept = (previous?.corrected ?? []).filter(item => item.message !== target.message || item.part !== target.part || item.block !== target.block);
      const entry = await tx.appendEntry(BlockCorrectionEntry, api.conversationId, {
        data: { reply: target.entry, corrected: [...kept, { message: target.message, part: target.part, block: target.block, at, issues: target.issues }] },
        edits: [{ target: reply.id, action: 'replace', messages }],
      });
      corrections.replies[String(target.entry)] = Number(entry.id);
      return fixResult(`Block ${target.number} corrected.`, false, othersDone);
    }, context);
  },
});
