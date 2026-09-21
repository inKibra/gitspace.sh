import { z } from 'zod';

export const WorkspaceFailureSchema = z.object({
  domain: z.literal('workspace'),
  code: z.enum(['WORKSPACE_NOT_FOUND', 'WORKSPACE_RELATIONS_INVALID', 'WORKSPACE_DEPENDENCY_CYCLE', 'WORKSPACE_CHECKPOINT_INVALID', 'WORKSPACE_CHECKPOINT_MISMATCH', 'WORKSPACE_CHECKPOINT_MISSING', 'WORKSPACE_REVISION_INVALID', 'WORKSPACE_IDENTITY_MISMATCH', 'WORKSPACE_POSSESSION_DENIED', 'WORKSPACE_CHECKPOINT_FAILED', 'WORKSPACE_RESTORE_FAILED', 'WORKSPACE_PHASE_CEILING']),
  message: z.string(),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict();
export type WorkspaceFailure = z.infer<typeof WorkspaceFailureSchema>;
export class WorkspaceDomainError extends Error {
  readonly domain = 'workspace';
  constructor(readonly failure: WorkspaceFailure) { super(failure.message); this.name = 'WorkspaceDomainError'; }
  get code(): WorkspaceFailure['code'] { return this.failure.code; }
  get context(): WorkspaceFailure['context'] { return this.failure.context; }
  toJSON(): WorkspaceFailure { return this.failure; }
}

export function workspaceFailure(error: unknown, code: WorkspaceFailure['code'], context: WorkspaceFailure['context'] = {}): WorkspaceFailure {
  if (error instanceof WorkspaceDomainError) return error.toJSON();
  const parsed = WorkspaceFailureSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
  return { domain: 'workspace', code, message, context };
}
