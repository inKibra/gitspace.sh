import { z } from 'zod';

/**
 * Adding a tab to a workspace from your Chrome's popup. The popup lists the workspaces it can add the tab to and adds
 * it to one with requests signed by this Chrome's pairing key (`POST BROWSER_WORKSPACES_PATH`, label `workspace`).
 * Adding asks the workspace to make or renew its tab group grant for this Chrome, then moves the tab into that group
 * as if you dragged it in (`adoptTab`): yours, consenting to the site it shows.
 */

/** Where your Chrome's popup lists workspaces and adds a tab to one. */
export const BROWSER_WORKSPACES_PATH = '/api/browser-relay/workspaces';
/** The most workspaces the popup lists: the most recently used first. */
export const BROWSER_WORKSPACE_CHOICES = 50;
const id = z.string().min(1).max(256);
/** What the popup asks: the workspaces it may list (`list`), or adding the tab `targetId` to one (`add`). */
export const RuntimeBrowserWorkspaceChromeRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list') }),
  z.strictObject({ op: z.literal('add'), projectId: id, workspaceId: id, targetId: id }),
]);
export type RuntimeBrowserWorkspaceChromeRequest = z.infer<typeof RuntimeBrowserWorkspaceChromeRequestSchema>;
/** A workspace the popup lists: `approved` when its project approved this Chrome. */
export const RuntimeBrowserWorkspaceChoiceSchema = z.strictObject({ projectId: id, project: z.string().max(160), workspaceId: id, name: z.string().max(160), approved: z.boolean() });
export type RuntimeBrowserWorkspaceChoice = z.infer<typeof RuntimeBrowserWorkspaceChoiceSchema>;
