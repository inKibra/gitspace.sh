import { z } from 'zod';
import { spaceCheckpointManifestKey } from './checkpoint.js';
import { WorkspaceDomainError, WorkspaceFailureSchema, type WorkspaceFailure } from './errors.js';

export const SpaceAuthorityStateSchema = z.enum(['open', 'closing', 'closed', 'opening']);
export type SpaceAuthorityState = z.infer<typeof SpaceAuthorityStateSchema>;
export const SpaceAuthorityRecordSchema = z.object({
  projectId: z.string(), spaceId: z.string(), state: SpaceAuthorityStateSchema,
  machineId: z.string().nullable(), generation: z.number().int().positive(), revision: z.number().int().positive(),
  checkpointRevision: z.number().int().nonnegative(), publishedRevision: z.number().int().nonnegative(),
  manifestKey: z.string().nullable(), manifestHash: z.string().nullable(),
  failures: z.object({ open: WorkspaceFailureSchema.nullable(), close: WorkspaceFailureSchema.nullable() }),
  resumeMachineId: z.string().nullable(), updatedAt: z.string(),
}).strict();
export type SpaceAuthorityRecord = z.infer<typeof SpaceAuthorityRecordSchema>;
/** machineId is supplied by the authenticated gateway, never copied from the editable request payload. */
export type SpaceAuthorityResult<T> = { status: 'ok'; value: T } | { status: 'error'; failure: WorkspaceFailure };
export interface VerifiedSpaceAuthorityIdentity { projectId: string; spaceId: string; machineId: string }
export interface SpaceAuthorityMutation extends VerifiedSpaceAuthorityIdentity { expectedGeneration: number }

function failure(code: WorkspaceFailure['code'], message: string, context: WorkspaceFailure['context']): WorkspaceDomainError {
  return new WorkspaceDomainError({ domain: 'workspace', code, message, context });
}

export function requireSpaceAuthorityIdentity(state: SpaceAuthorityRecord | null, identity: { projectId: string; spaceId: string }): SpaceAuthorityRecord {
  if (!state || state.projectId !== identity.projectId || state.spaceId !== identity.spaceId) throw failure('WORKSPACE_IDENTITY_MISMATCH', 'Space authority identity does not match', identity);
  return state;
}

function requireOwner(state: SpaceAuthorityRecord | null, input: SpaceAuthorityMutation, expectedState: SpaceAuthorityState, generation = input.expectedGeneration): SpaceAuthorityRecord {
  const current = requireSpaceAuthorityIdentity(state, input);
  if (current.state !== expectedState || current.machineId !== input.machineId || current.generation !== generation) throw failure('WORKSPACE_POSSESSION_DENIED', `Space is not ${expectedState} on the expected machine generation`, { spaceId: input.spaceId, machineId: input.machineId, generation, currentGeneration: current.generation, currentState: current.state });
  return current;
}

export function bootstrapSpaceAuthority(current: SpaceAuthorityRecord | null, input: VerifiedSpaceAuthorityIdentity, now: string): SpaceAuthorityRecord {
  for (const value of [input.projectId, input.spaceId, input.machineId]) if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value) || value === '.' || value === '..') throw failure('WORKSPACE_IDENTITY_MISMATCH', 'Authority identity is invalid', { value });
  if (current) return requireSpaceAuthorityIdentity(current, input);
  return { ...input, state: 'open', generation: 1, revision: 1, checkpointRevision: 0, publishedRevision: 0, manifestKey: null, manifestHash: null, failures: { open: null, close: null }, resumeMachineId: null, updatedAt: now };
}

export function beginSpaceClose(state: SpaceAuthorityRecord | null, input: SpaceAuthorityMutation, now: string): { state: SpaceAuthorityRecord; revision: number; previousRevision: number | null } {
  const current = requireOwner(state, input, 'open');
  const revision = current.checkpointRevision + 1;
  return { state: { ...current, state: 'closing', checkpointRevision: revision, revision: current.revision + 1, updatedAt: now }, revision, previousRevision: current.publishedRevision || null };
}

export function commitSpaceClosed(state: SpaceAuthorityRecord | null, input: SpaceAuthorityMutation & { revision: number; manifestKey: string; manifestHash: string; resumeOnMachineRestart?: boolean }, now: string): SpaceAuthorityRecord {
  const current = requireOwner(state, input, 'closing');
  if (current.checkpointRevision !== input.revision) throw failure('WORKSPACE_REVISION_INVALID', 'Checkpoint revision changed', { expectedRevision: input.revision, revision: current.checkpointRevision });
  if (input.manifestKey !== spaceCheckpointManifestKey(input.projectId, input.spaceId, input.revision) || !/^sha256:[a-f0-9]{64}$/u.test(input.manifestHash)) throw failure('WORKSPACE_CHECKPOINT_INVALID', 'Manifest identity or hash is invalid', { manifestKey: input.manifestKey });
  return { ...current, state: 'closed', machineId: null, generation: current.generation + 1, revision: current.revision + 1, publishedRevision: input.revision, manifestKey: input.manifestKey, manifestHash: input.manifestHash, resumeMachineId: input.resumeOnMachineRestart ? input.machineId : null, failures: { ...current.failures, close: null }, updatedAt: now };
}

export function abortSpaceClose(state: SpaceAuthorityRecord | null, input: SpaceAuthorityMutation & { revision: number; message: string }, now: string): SpaceAuthorityRecord {
  const current = requireOwner(state, input, 'closing');
  if (current.checkpointRevision !== input.revision) throw failure('WORKSPACE_REVISION_INVALID', 'Checkpoint revision changed', { expectedRevision: input.revision, revision: current.checkpointRevision });
  return { ...current, state: 'open', revision: current.revision + 1, failures: { ...current.failures, close: { domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_FAILED', message: input.message, context: { spaceId: input.spaceId, checkpointRevision: input.revision } } }, updatedAt: now };
}

export function beginSpaceOpen(state: SpaceAuthorityRecord | null, input: SpaceAuthorityMutation & { resumeOnMachineRestart?: boolean }, now: string): { state: SpaceAuthorityRecord; revision: number; manifestKey: string; manifestHash: `sha256:${string}` } {
  const current = requireSpaceAuthorityIdentity(state, input);
  if (current.state !== 'closed' || current.machineId !== null || current.generation !== input.expectedGeneration) throw failure('WORKSPACE_POSSESSION_DENIED', 'Space is not closed at the expected generation', { spaceId: input.spaceId, generation: input.expectedGeneration, currentGeneration: current.generation });
  if (input.resumeOnMachineRestart && current.resumeMachineId !== input.machineId) throw failure('WORKSPACE_POSSESSION_DENIED', 'Space was not released for this machine restart', { spaceId: input.spaceId, machineId: input.machineId });
  if (!current.manifestKey || !current.manifestHash || current.publishedRevision < 1 || !/^sha256:[a-f0-9]{64}$/u.test(current.manifestHash)) throw failure('WORKSPACE_CHECKPOINT_MISSING', 'Closed space has no valid checkpoint manifest', { spaceId: input.spaceId });
  return { state: { ...current, state: 'opening', machineId: input.machineId, generation: current.generation + 1, revision: current.revision + 1, updatedAt: now }, revision: current.publishedRevision, manifestKey: current.manifestKey, manifestHash: current.manifestHash as `sha256:${string}` };
}

export function commitSpaceOpen(state: SpaceAuthorityRecord | null, input: SpaceAuthorityMutation & { revision: number }, now: string): SpaceAuthorityRecord {
  const current = requireOwner(state, input, 'opening', input.expectedGeneration + 1);
  if (current.publishedRevision !== input.revision) throw failure('WORKSPACE_REVISION_INVALID', 'Published checkpoint revision changed', { expectedRevision: input.revision, revision: current.publishedRevision });
  return { ...current, state: 'open', revision: current.revision + 1, resumeMachineId: null, failures: { ...current.failures, open: null }, updatedAt: now };
}

export function failSpaceOpen(state: SpaceAuthorityRecord | null, input: SpaceAuthorityMutation & { revision: number; message: string }, now: string): SpaceAuthorityRecord {
  const current = requireOwner(state, input, 'opening', input.expectedGeneration + 1);
  if (current.publishedRevision !== input.revision) throw failure('WORKSPACE_REVISION_INVALID', 'Published checkpoint revision changed', { expectedRevision: input.revision, revision: current.publishedRevision });
  return { ...current, state: 'closed', machineId: null, revision: current.revision + 1, failures: { ...current.failures, open: { domain: 'workspace', code: 'WORKSPACE_RESTORE_FAILED', message: input.message, context: { spaceId: input.spaceId, checkpointRevision: input.revision } } }, updatedAt: now };
}
