import { wire } from 'result-rpc';
import { z } from 'zod';

const skillIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/u);
export const skillScopeSchema = z.enum(['project', 'workspaces', 'all']);
export type SkillScope = z.infer<typeof skillScopeSchema>;
export const skillAssignmentSchema = z.object({
  projectId: z.string().min(1).max(128),
  projectSpaceEnabled: z.boolean(),
  workspacesEnabled: z.boolean(),
}).strict();
export type SkillAssignment = z.infer<typeof skillAssignmentSchema>;
export const skillViewSchema = z.object({
  id: skillIdSchema,
  name: skillIdSchema,
  description: z.string().min(1).max(2_048),
  source: z.enum(['gitspace', 'user']),
  scope: skillScopeSchema,
  enabled: z.boolean(),
  exceptions: z.array(z.string().min(1).max(128)).max(1_000),
  assignments: z.array(skillAssignmentSchema).max(1_000).default([]),
  revision: z.number().int().positive(),
}).strict();
export type SkillView = z.infer<typeof skillViewSchema>;
export const skillUpdateSchema = z.object({
  id: skillIdSchema,
  expectedRevision: z.number().int().positive(),
  enabled: z.boolean(),
  scope: skillScopeSchema,
  exceptions: z.array(z.string().min(1).max(128)).max(1_000),
  assignments: z.array(skillAssignmentSchema).max(1_000).default([]),
}).strict();
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;

export const SkillViewCodec = wire.serializable((value): value is SkillView => skillViewSchema.safeParse(value).success, { id: 'gitspace/skill-view/v1' });
export const SkillUpdateCodec = wire.serializable((value): value is SkillUpdate => skillUpdateSchema.safeParse(value).success, { id: 'gitspace/skill-update/v1' });
export const DEFAULT_GITSPACE_SKILLS: readonly Omit<SkillView, 'revision'>[] = [
  { id: 'space-goal', name: 'space-goal', description: 'Goal intent, requirements, evidence, and decisions.', source: 'gitspace', scope: 'project', enabled: true, exceptions: [], assignments: [] },
  { id: 'space-chain', name: 'space-chain', description: 'Related spaces and their position in a goal chain.', source: 'gitspace', scope: 'project', enabled: true, exceptions: [], assignments: [] },
  { id: 'space-review', name: 'space-review', description: 'Files, durable comments, evidence, and review threads.', source: 'gitspace', scope: 'all', enabled: true, exceptions: [], assignments: [] },
  { id: 'space-artifacts', name: 'space-artifacts', description: 'Publish, inspect, and attach durable space artifacts.', source: 'gitspace', scope: 'all', enabled: true, exceptions: [], assignments: [] },
  { id: 'phase-journal', name: 'phase-journal', description: 'Curated phase narrative, snapshots, and state deltas.', source: 'gitspace', scope: 'project', enabled: true, exceptions: [], assignments: [] },
  { id: 'review-guide-narrator', name: 'review-guide-narrator', description: 'Narrate a Change Guide grounded in the Journal and current diff.', source: 'gitspace', scope: 'workspaces', enabled: true, exceptions: [], assignments: [] },
  { id: 'workspace-services', name: 'workspace-services', description: 'Declare and run stable-port workspace services through OMP Hub.', source: 'gitspace', scope: 'workspaces', enabled: true, exceptions: [], assignments: [] },
  { id: 'integration-code-mode', name: 'integration-code-mode', description: 'Discover and compose granted MCP tools through bounded JavaScript.', source: 'gitspace', scope: 'all', enabled: true, exceptions: [], assignments: [] },
];
