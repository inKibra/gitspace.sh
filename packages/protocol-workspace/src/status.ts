import { z } from 'zod';
import { WorkspacePhaseSchema } from './relations.js';

export const WorkspaceStatusColorSchema = z.enum(['dim', 'green', 'blue', 'orange', 'red']);
export type WorkspaceStatusColor = z.infer<typeof WorkspaceStatusColorSchema>;

const count = z.number().int().nonnegative();

/** The one status summary of a workspace. Its workspace object computes it from live state, publishes it in the
 * `gitspace.status` document and stores it where listings read it; every surface shows it as is. */
export const WorkspaceStatusSummarySchema = z.object({
  /** Red when an agent failed; orange when an approval or a sync conflict needs a person; green while a task runs;
   * blue when the agents wait for the user; dim when nothing was reported. */
  primaryColor: WorkspaceStatusColorSchema,
  /** Agents by state: green has a live task, blue waits for the user, orange waits for an approval, red failed. */
  agents: z.object({ green: count, blue: count, orange: count, red: count }),
  machines: z.object({ attached: count, online: count, ready: count }),
  /** Conflicted paths in the cloud working copy, and machines whose sync reports a problem. */
  sync: z.object({ conflicts: count, problems: count }),
});
export type WorkspaceStatusSummary = z.infer<typeof WorkspaceStatusSummarySchema>;

/** A workspace that has not reported a status yet. */
export const emptyWorkspaceStatus: WorkspaceStatusSummary = {
  primaryColor: 'dim',
  agents: { green: 0, blue: 0, orange: 0, red: 0 },
  machines: { attached: 0, online: 0, ready: 0 },
  sync: { conflicts: 0, problems: 0 },
};

/** The message a text cut for an agent was taken from: its conversation, its history ordinal (`entryId * 1024 + n`)
 * and the whole text's length. */
export const TextSourceSchema = z.object({ conversationId: z.string().min(1), ordinal: z.number().int().nonnegative(), characters: z.number().int().nonnegative() });
export type TextSource = z.infer<typeof TextSourceSchema>;

/** At most this many open items in a workspace's report; `more` counts the rest. */
export const WAITING_ITEMS_MAX = 20;
/** Characters of an item's title; `characters` is the whole text's length. */
export const WAITING_TITLE_MAX = 200;
const WaitingTitleSchema = z.string().max(WAITING_TITLE_MAX);
const waitingBase = { key: z.string().min(1).max(512), since: z.iso.datetime().nullable(), title: WaitingTitleSchema, characters: count };
/** The conversation that asks: its id, and the subagent's name (null for the workspace's main agent). */
const WaitingConversationSchema = z.object({ id: z.string().min(1).max(128), agent: z.string().max(80).nullable() });
/** A question's choices as its card shows them: up to 9, each cut to 80 characters. */
const WaitingChoicesSchema = z.array(z.string().max(80)).max(9);
/** One execution a lifecycle card waits on: its content hash, its label, and the file and phase that declare it. */
export const WaitingScriptSchema = z.object({ hash: z.string().max(80), label: z.string().max(80), fileName: z.string().max(160).nullable(), phase: z.string().max(40).nullable() });
export type WaitingScript = z.infer<typeof WaitingScriptSchema>;
/**
 * One open item of a workspace, as its report carries it. `key`: the question's id, or the problem's stable key.
 * `ask`: an agent's question; `plan`: a proposed plan; `approval`: a permission prompt (a machine attach, the project
 * agent's batch); `lifecycle-approval`: an `environment` run waiting on scripts (up to 4 named, `more` the rest);
 * `takeover`, `secure-input`, `mcp-elicitation`: cards answered in the workspace; `failed`: the main conversation's
 * last model request failed (`title` is the error); `setup-failed`: a machine's setup step failed, with its run and
 * the error's last line; `conflict`: conflicted paths in the cloud working copy.
 */
export const WaitingItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), ...waitingBase, conversation: WaitingConversationSchema, choices: WaitingChoicesSchema }),
  z.object({ kind: z.literal('plan'), ...waitingBase, conversation: WaitingConversationSchema, choices: WaitingChoicesSchema }),
  z.object({ kind: z.literal('approval'), ...waitingBase, conversation: WaitingConversationSchema, choices: WaitingChoicesSchema }),
  z.object({ kind: z.literal('lifecycle-approval'), ...waitingBase, conversation: WaitingConversationSchema, phase: z.string().max(40), scripts: z.array(WaitingScriptSchema).max(4), more: count }),
  z.object({ kind: z.literal('takeover'), ...waitingBase, conversation: WaitingConversationSchema }),
  z.object({ kind: z.literal('secure-input'), ...waitingBase, conversation: WaitingConversationSchema }),
  z.object({ kind: z.literal('mcp-elicitation'), ...waitingBase, conversation: WaitingConversationSchema }),
  z.object({ kind: z.literal('failed'), ...waitingBase, conversation: WaitingConversationSchema }),
  z.object({ kind: z.literal('setup-failed'), ...waitingBase, machineId: z.string().min(1).max(128), phase: z.enum(['machine/prepare', 'checks', 'workspace/materialize']), runId: z.string().max(128).nullable(), lastLine: z.string().max(WAITING_TITLE_MAX) }),
  z.object({ kind: z.literal('conflict'), ...waitingBase, paths: count }),
]);
export type WaitingItem = z.infer<typeof WaitingItemSchema>;
/** Everything open in a workspace that waits on a person: oldest first, at most `WAITING_ITEMS_MAX`, `more` past them. */
export const WorkspaceWaitingSchema = z.object({ items: z.array(WaitingItemSchema).max(WAITING_ITEMS_MAX), more: count });
export type WorkspaceWaiting = z.infer<typeof WorkspaceWaitingSchema>;
export const emptyWaiting: WorkspaceWaiting = { items: [], more: 0 };

/** A question as the project agent's board and a watched turn's end name it: an ask or an approval, its prompt cut to
 * 200 characters, and the whole prompt's length. */
export type WorkspaceQuestionHead = { kind: 'ask' | 'approval'; prompt: string; characters: number };

/** The main conversation's oldest open question or approval: what a watched or automated turn ended on, and what the
 * project agent's board says the workspace waits on. */
export function mainQuestion(waiting: WorkspaceWaiting): WorkspaceQuestionHead | null {
  for (const item of waiting.items) {
    if (!('conversation' in item) || item.conversation.agent !== null || item.kind === 'failed') continue;
    const approval = item.kind === 'plan' || item.kind === 'approval' || item.kind === 'lifecycle-approval';
    return { kind: approval ? 'approval' : 'ask', prompt: item.title, characters: item.characters };
  }
  return null;
}

/** The step of the main conversation's plan in effect being worked on: 1-based, of `count`, its title cut to 80. */
export const WorkspacePlanStepSchema = z.object({ index: z.number().int().positive(), count: z.number().int().positive(), title: z.string().max(80) });
export type WorkspacePlanStep = z.infer<typeof WorkspacePlanStepSchema>;
/** A workspace's goal as the board's cards show it: its title (a leading emoji taken out as `emoji`), requirements
 * accepted of all, and the plan step being worked on (null without an approved plan with a step left). */
export const WorkspaceGoalSummarySchema = z.object({ title: z.string().max(120), emoji: z.string().max(16).nullable(), met: count, total: count, step: WorkspacePlanStepSchema.nullable() });
export type WorkspaceGoalSummary = z.infer<typeof WorkspaceGoalSummarySchema>;
/** The goal's part of the summary, as the workspace's goal record gives it: the plan step comes from its runtime. */
export const WorkspaceGoalHeadSchema = WorkspaceGoalSummarySchema.omit({ step: true });
export type WorkspaceGoalHead = z.infer<typeof WorkspaceGoalHeadSchema>;

/** What a project agent reads about another workspace without opening it: the summary plus what the workspace waits on,
 * its latest reply, its model and its code, stored by the workspace each time its runtime publishes. */
export const WorkspaceReportSchema = z.object({
  summary: WorkspaceStatusSummarySchema,
  phase: WorkspacePhaseSchema.nullable(),
  /** Every open item of the workspace (empty in reports stored before it). */
  waiting: WorkspaceWaitingSchema.default(emptyWaiting),
  /** The main conversation's plan step being worked on (null in reports stored before it). */
  planStep: WorkspacePlanStepSchema.nullable().default(null),
  /** The main conversation's failure, when its last model request failed. */
  failure: z.string().nullable(),
  /** The main conversation's latest assistant text, cut to 280 characters. */
  lastReply: z.string().nullable(),
  /** Where the whole of `lastReply` is; null without a reply, and in reports stored before it. */
  lastReplySource: TextSourceSchema.nullable().default(null),
  lastActivityAt: z.string().datetime().nullable(),
  /** The admitted model of the main conversation; null before its first message. */
  model: z.object({ role: z.string().nullable(), provider: z.string(), id: z.string() }).nullable(),
  /** Branch head of the cloud working copy, and whether it has uncommitted changes. */
  code: z.object({ branch: z.string().nullable(), headCommit: z.string().nullable(), uncommitted: z.boolean() }).nullable(),
});
export type WorkspaceReport = z.infer<typeof WorkspaceReportSchema>;

/**
 * `text` as an agent reads it, at most `limit` characters on one line. A cut one ends with "…" and says how much of it
 * this is and how to read the whole: the `history_read` call for its source message, or, for a reply stored before
 * sources were, the call that reads the workspace's latest reply.
 */
export function cutForAgent(text: string, limit: number, read: { workspaceId: string; source: TextSource | null }): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const total = read.source?.characters ?? null;
  if (flat.length <= limit && (total === null || total <= flat.length)) return `"${flat}"`;
  const shown = Math.min(limit, flat.length);
  const call = read.source
    ? `tools.history_read({ workspaceId: "${read.workspaceId}", conversationId: "${read.source.conversationId}", offset: ${read.source.ordinal}, limit: 1, textOnly: true })`
    : `tools.history_read({ workspaceId: "${read.workspaceId}", fromEnd: true, role: "assistant", textOnly: true, limit: 1 })`;
  return `"${flat.slice(0, limit)}…" (${total === null ? `the first ${shown} characters` : `${shown} of ${total.toLocaleString('en-US')} characters`}; whole: ${call})`;
}
