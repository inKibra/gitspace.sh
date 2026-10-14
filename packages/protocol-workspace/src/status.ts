import { z } from 'zod';

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
