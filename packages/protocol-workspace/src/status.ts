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

/** What a project agent reads about another workspace without opening it: the summary plus what the workspace waits on,
 * its latest reply, its model and its code, stored by the workspace each time its runtime publishes. */
export const WorkspaceReportSchema = z.object({
  summary: WorkspaceStatusSummarySchema,
  phase: WorkspacePhaseSchema.nullable(),
  /** The main conversation's oldest unanswered question or approval, its prompt cut to 200 characters; `characters` is
   * the whole prompt's length (absent from reports stored before it). */
  waitingOn: z.object({ kind: z.enum(['ask', 'approval']), prompt: z.string(), characters: z.number().int().nonnegative().optional() }).nullable(),
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
