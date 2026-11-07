import type { StackStatus } from '@gitspace/protocol';
import { readCurrentCheckpoint } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';
import { readCloudStackStatus } from './cloud-stack-status.js';
import type { RuntimeIdentity } from './runtime-services.js';

/** Where a workspace sits in its stack as its agent was last told: its parent, and whether that parent has commits the
 * branch lacks (`ahead`) or merged into the base branch. */
export const StackPositionSchema = z.object({ parentId: z.string().nullable(), state: z.enum(['none', 'current', 'ahead', 'merged']) });
export type StackPosition = z.infer<typeof StackPositionSchema>;

/** One reading of a workspace's stack position, with the names its notice uses. */
export const StackObservationSchema = z.object({
  position: StackPositionSchema,
  parentName: z.string().nullable(),
  baseBranch: z.string(),
  /** The stack status's information line; null while the branch holds everything its parent has. */
  note: z.string().nullable(),
});
export type StackObservation = z.infer<typeof StackObservationSchema>;

export function stackObservation(status: StackStatus, parentName: string | null): StackObservation {
  const state = status.parentId === null ? 'none' : status.parentMerged === 'merged' ? 'merged' : status.parentAhead > 0 ? 'ahead' : 'current';
  return { position: { parentId: status.parentId, state }, parentName, baseBranch: status.baseBranch, note: status.instruction };
}

/** The agent's notice for a new stack position, or null when it has nothing new to learn: the same position again, a
 * branch that caught up with its parent, or the first reading of one that holds everything its parent has. */
export function stackNoticeText(previous: StackPosition | null, next: StackObservation): string | null {
  const { position, note } = next;
  if (previous !== null && previous.parentId !== position.parentId) {
    if (position.parentId === null) return `Stack · Restacked: you no longer merge after another workspace; you merge into ${next.baseBranch} on your own.`;
    return note === null ? `Stack · Restacked: you now merge after ${next.parentName ?? position.parentId}, and your branch has everything its branch has.` : `Stack · Restacked. ${note}`;
  }
  if (previous?.state === position.state || note === null) return null;
  return `Stack · ${note}`;
}

/**
 * Tells every workspace whose stack position a change may have moved: the changed workspace and what is stacked on it,
 * or every stacked workspace when the change is the base workspace's. Only workspaces with a cloud runtime whose parent
 * has one are read, so a reading never opens a runtime. Each workspace keeps what its agent was told and gets a notice
 * only when that changes; a failure for one is logged and the rest are still told.
 */
export async function noticeStackChanges(env: Env, userId: string, projectId: string, changedId: string): Promise<void> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const [workspaces, relations] = await Promise.all([authority.listWorkspaces(), authority.listWorkspaceRelations()]);
  const changed = workspaces.find(workspace => workspace.id === changedId);
  if (!changed) return;
  const open = workspaces.filter(workspace => workspace.kind === 'worktree' && workspace.lifecycle === 'active' && workspace.archivedAt === null);
  const affected = changed.kind === 'base'
    ? open.filter(workspace => relations[workspace.id]?.stackedOn)
    : open.filter(workspace => workspace.id === changedId || relations[workspace.id]?.stackedOn === changedId);
  const space = (id: string) => env.SPACE_AUTHORITY.getByName(`${userId}:${id}`);
  for (const workspace of affected) {
    try {
      const parentId = relations[workspace.id]?.stackedOn ?? null;
      if (!await space(workspace.id).hasCloudRuntime() || (parentId !== null && !await space(parentId).hasCloudRuntime())) continue;
      const status = await readCloudStackStatus(env, userId, projectId, workspace.id);
      if (!status) continue;
      const parentName = workspaces.find(candidate => candidate.id === status.parentId)?.name ?? null;
      await space(workspace.id).runtimeStackNotice({ projectId, workspaceId: workspace.id }, stackObservation(status, parentName));
    } catch (error) {
      console.error('Stack notice was not sent', { projectId, workspaceId: workspace.id, error });
    }
  }
}

/** A new head of a workspace's branch can move the stack position of what is stacked on it; the head last acted on is
 * kept in the workspace's storage, so a snapshot that changed files but not the head reads nothing. */
export async function noticeStackHead(storage: DurableObjectStorage, env: Env, identity: RuntimeIdentity): Promise<void> {
  const head = (await readCurrentCheckpoint(storage))?.headCommit ?? null;
  if (head === null || await storage.get('stack.head') === head) return;
  await storage.put('stack.head', head);
  await noticeStackChanges(env, env.ACCOUNT_ID, identity.projectId, identity.workspaceId);
}
