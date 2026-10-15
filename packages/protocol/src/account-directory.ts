import { z } from 'zod';
import type { InputOf } from 'result-rpc';
import { streamCursorSchema, streamEventSchema } from '@gitspace/protocol-sync';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from './project-authority.js';
import { WorkspaceStatusSummarySchema } from '@gitspace/protocol-workspace';
import { FleetMachineViewCodec, SpacePlacementViewCodec, type SpacePlacementView } from './rpc-contract.js';

export type FleetMachineDefinition = InputOf<typeof FleetMachineViewCodec>;
export const accountDirectorySnapshotSchema = z.object({
  projects: z.array(cloudProjectSummarySchema),
  /** `cloudRuntime`: the workspace lives in its cloud runtime (machines only cache it), so legacy placements do not describe it. */
  workspaces: z.array(cloudWorkspaceDefinitionSchema.extend({ cloudRuntime: z.boolean().default(false) })),
  placements: z.array(z.custom<SpacePlacementView>((value) => SpacePlacementViewCodec.decode(value).ok)),
  machines: z.array(z.custom<FleetMachineDefinition>((value) => FleetMachineViewCodec.decode(value).ok)),
  projectRevisions: z.record(z.string(), streamCursorSchema),
});
export type AccountDirectorySnapshot = z.infer<typeof accountDirectorySnapshotSchema>;
export const accountDirectoryEventSchema = streamEventSchema(accountDirectorySnapshotSchema)
  .refine((event) => event.resource === 'account-directory', 'Unexpected directory resource');
/** Directory messages on the account socket: the whole directory once when the socket opens, then only the slice
 * that changed (the project list, the machines, or one project's workspaces and placements). */
export const accountDirectoryMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory'), snapshot: accountDirectorySnapshotSchema }),
  z.object({ type: z.literal('directory.projects'), projects: accountDirectorySnapshotSchema.shape.projects }),
  z.object({ type: z.literal('directory.machines'), machines: accountDirectorySnapshotSchema.shape.machines }),
  /** `revision` null: the project left the directory. */
  z.object({ type: z.literal('directory.project'), projectId: z.string().min(1), revision: streamCursorSchema.nullable(), workspaces: accountDirectorySnapshotSchema.shape.workspaces, placements: accountDirectorySnapshotSchema.shape.placements }),
]);
export type AccountDirectoryMessage = z.infer<typeof accountDirectoryMessageSchema>;

/** The slices of a directory, by key; the socket object sends a slice whose content changed. */
export function accountDirectorySlices(snapshot: AccountDirectorySnapshot): Map<string, AccountDirectoryMessage> {
  const slices = new Map<string, AccountDirectoryMessage>([
    ['projects', { type: 'directory.projects', projects: snapshot.projects }],
    ['machines', { type: 'directory.machines', machines: snapshot.machines }],
  ]);
  for (const [projectId, revision] of Object.entries(snapshot.projectRevisions)) {
    slices.set(`project:${projectId}`, { type: 'directory.project', projectId, revision,
      workspaces: snapshot.workspaces.filter(workspace => workspace.projectId === projectId), placements: snapshot.placements.filter(placement => placement.projectId === projectId) });
  }
  return slices;
}

/** The directory after one message; a slice before the first whole directory changes nothing. */
export function applyAccountDirectoryMessage(current: AccountDirectorySnapshot | null, message: AccountDirectoryMessage): AccountDirectorySnapshot | null {
  if (message.type === 'directory') return message.snapshot;
  if (!current) return null;
  if (message.type === 'directory.projects') return { ...current, projects: message.projects };
  if (message.type === 'directory.machines') return { ...current, machines: message.machines };
  const { [message.projectId]: _previous, ...revisions } = current.projectRevisions;
  return {
    ...current,
    workspaces: [...current.workspaces.filter(workspace => workspace.projectId !== message.projectId), ...message.workspaces],
    placements: [...current.placements.filter(placement => placement.projectId !== message.projectId), ...message.placements],
    projectRevisions: message.revision === null ? revisions : { ...revisions, [message.projectId]: message.revision },
  };
}

/** One workspace's status row, sent on the directory socket when it changes. */
export const workspaceStatusRowSchema = z.object({ projectId: z.string().min(1), workspaceId: z.string().min(1), status: WorkspaceStatusSummarySchema });
export type WorkspaceStatusRow = z.infer<typeof workspaceStatusRowSchema>;
/** `statuses`: every row, once per socket open; `status`: one row that changed. */
export const workspaceStatusMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('statuses'), rows: z.array(workspaceStatusRowSchema) }),
  workspaceStatusRowSchema.extend({ type: z.literal('status') }),
]);
