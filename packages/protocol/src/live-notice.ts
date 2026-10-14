import { z } from 'zod';
import { streamCursorSchema } from '@gitspace/protocol-sync';

const scope = z.string().min(1).max(256);
/** What a tab watches. Workspace ids are account-unique, so a workspace key matches on workspace and resource alone and its
 * project is informational. */
export const liveKeySchema = z.object({ project: scope.nullable(), workspace: scope.nullable(), resource: z.string().min(1).max(512) });
export type LiveKey = z.infer<typeof liveKeySchema>;
/** The owner of `resource` changed it to `version`. A notice carries no state: the tab refetches with a normal query. */
export const liveNoticeSchema = liveKeySchema.extend({ version: streamCursorSchema });
export type LiveNotice = z.infer<typeof liveNoticeSchema>;

/** Keys one socket may watch at once. */
export const MAX_LIVE_SUBSCRIPTIONS = 128;
/** Tab → live object, on the account directory socket. */
export const liveClientMessageSchema = z.object({ type: z.enum(['subscribe', 'unsubscribe']), keys: z.array(liveKeySchema).min(1).max(MAX_LIVE_SUBSCRIPTIONS) });
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;
/** Live object → tab, on the account directory socket beside directory events. */
export const liveNoticeMessageSchema = liveNoticeSchema.extend({ type: z.literal('notice') });
export type LiveNoticeMessage = z.infer<typeof liveNoticeMessageSchema>;

export function liveKeyId(key: LiveKey): string {
  if (key.workspace !== null) return `workspace:${key.workspace}:${key.resource}`;
  if (key.project !== null) return `project:${key.project}:${key.resource}`;
  return `account:${key.resource}`;
}

/** Account-wide resources: `settings`, `inference`, `cloud-images`, `machines`, `projects`, `provider-login:<flowId>`. */
export function accountLiveKey(resource: string): LiveKey {
  return { project: null, workspace: null, resource };
}
/** `project`: invalidations of one project's records. */
export function projectLiveKey(projectId: string, resource: string): LiveKey {
  return { project: projectId, workspace: null, resource };
}
/** `runtime`, `environment`, `space`, and machine terminal resources of one workspace. */
export function workspaceLiveKey(workspaceId: string, resource: string, projectId: string | null = null): LiveKey {
  return { project: projectId, workspace: workspaceId, resource };
}
