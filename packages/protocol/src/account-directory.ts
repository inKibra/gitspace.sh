import { z } from 'zod';
import type { InputOf } from 'result-rpc';
import { streamCursorSchema, streamEventSchema } from '@gitspace/protocol-sync';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from './project-authority.js';
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
