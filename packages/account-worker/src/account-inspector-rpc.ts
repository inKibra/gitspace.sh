import { inspectorReadArtifactPageContract, inspectorReadResourcePageContract, inspectorRepositoryTreePageContract } from '@gitspace/protocol/rpc-contract';
import { snapshotPage } from '@gitspace/protocol/snapshot-page';
import { requireDeviceAdministration, type VerifiedDevice } from '@gitspace/protocol/device-grant';
import {
  inspectorViewContract,
  inspectorTranscriptContract,
  inspectorTranscriptPageContract,
  inspectorTranscriptContentContract,
  inspectorAvailabilityContract,
  inspectorReadArtifactContract,
  inspectorWriteArtifactContract,
  inspectorBeginArtifactUploadContract,
  inspectorUploadArtifactChunkContract,
  inspectorCommitArtifactUploadContract,
  inspectorAbortArtifactUploadContract,
  inspectorListArtifactsContract,
  inspectorCopyArtifactsContract,
  inspectorListArtifactSharesContract,
  inspectorCreateArtifactShareContract,
  inspectorRevokeArtifactShareContract,
  inspectorOverviewContract,
  inspectorJournalContract,
  inspectorReviewThreadsContract,
  inspectorPutGoalContract,
  inspectorAttachRequirementEvidenceContract,
  inspectorPutWorkflowContract,
  inspectorWaiveWorkflowGateContract,
  inspectorPutRubricContract,
  inspectorAppendRubricJudgmentContract,
  inspectorStartJournalPhaseContract,
  inspectorEndJournalPhaseContract,
  inspectorAppendJournalEntryContract,
  inspectorPutChangeGuideContract,
  inspectorMarkGuideSectionReadContract,
  inspectorSetGuideApprovalContract,
  inspectorCreateReviewThreadContract,
  inspectorAppendReviewMessageContract,
  inspectorResolveReviewThreadContract,
  inspectorRepositoryTreeContract,
  inspectorRepositoryStatusContract,
  inspectorRepositoryFileContract,
  inspectorRepositoryDiffContract,
  inspectorAnalyzeChangeGuideContract,
  inspectorSubmitChangeGuideContract,
  inspectorServicesContract,
  startWorkspaceServiceContract,
  stopWorkspaceServiceContract
} from '@gitspace/protocol/rpc-contract';
import type { GitSpaceRpcContext } from '@gitspace/protocol';
import { encodeTranscriptEventChunks } from '@gitspace/protocol/transcript';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import { InspectorConflictError, InspectorStateError } from './space-context.js';
import { InspectorCloudArtifacts, InspectorGenerationConflict, InspectorWorkspaceMissing, readInspectorContext, readSavedInspectorMetadata, readSavedInspectorTranscript } from './account-inspector-data.js';
import { readSavedInspectorTranscriptContent, readSavedInspectorTranscriptPage } from './account-inspector-data.js';
import type { FleetCatalogDO } from './fleet-catalog.js';
import type { SpaceAuthorityDO } from './space-authority.js';

export function inspectorCloudProcedures(env: Env, userId: string, requireSubscription: () => Promise<void>, currentDevice: () => Promise<VerifiedDevice>) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
  const availability = server.implement(inspectorAvailabilityContract).handler(async ({ input, errors }) => {
    try {
      const placement = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${input.workspaceId ?? input.projectId}`).get();
      if (!placement || placement.projectId !== input.projectId || placement.state !== 'open' || !placement.machineId) return ok({ runtimeAvailable: false });
      const machine = await catalog.getMachine(placement.machineId);
      return ok({ runtimeAvailable: Boolean(machine?.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint) });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'read Inspector availability', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const view = server.implement(inspectorViewContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.workspaceId ?? input.projectId, input.projectId);
      const [overview, artifacts, saved, machines, operations] = await Promise.all([
        source.context.getOverview(source.identity),
        new InspectorCloudArtifacts(env, userId, source).list(),
        readSavedInspectorMetadata(env, userId, source),
        catalog.listMachines(),
        source.workspace.kind === 'worktree' ? source.authority.listOperations() : [],
      ]);
      const created = operations.filter((operation) => operation.kind === 'workspace.create' && operation.workspaceId === source.workspace.id)
        .reduce<(typeof operations)[number] | null>((latest, operation) => !latest || operation.createdAt > latest.createdAt ? operation : latest, null);
      return ok({ identity: source.identity, project: source.project, workspace: source.workspace, workspaces: source.workspaces,
        placement: source.placement ? { state: source.placement.state, machineId: source.placement.machineId, generation: source.placement.generation, updatedAt: source.placement.updatedAt } : null,
        overview, artifacts, machines, ...saved,
        creation: created ? {
          operationId: created.id, state: created.state, error: created.error, updatedAt: created.updatedAt,
          steps: created.steps.map((step) => ({ id: step.id, label: step.label, state: step.state, message: step.message })),
        } : null,
      });
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      return err(errors.OperationFailed({ operation: 'read cloud Inspector context', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const transcript = server.implement(inspectorTranscriptContract).stream(async function* ({ input, signal, errors }) {
    try {
      const source = await readInspectorContext(env, userId, input.workspaceId ?? input.projectId, input.projectId);
      await requireSubscription();
      const events = await readSavedInspectorTranscript(env, userId, source);
      await requireSubscription();
      for (const event of events) {
        for (const chunk of encodeTranscriptEventChunks(event)) {
          if (signal.aborted) return;
          yield ok(chunk);
        }
      }
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) yield err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      else yield err(errors.OperationFailed({ operation: 'read saved Inspector transcript', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const transcriptPage = server.implement(inspectorTranscriptPageContract).handler(async ({ input, errors }) => {
    try {
      await requireSubscription();
      const source = await readInspectorContext(env, userId, input.workspaceId ?? input.projectId, input.projectId);
      const page = await readSavedInspectorTranscriptPage(env, userId, source, input);
      await requireSubscription();
      return ok(page);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      return err(errors.OperationFailed({ operation: 'read saved Inspector transcript page', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const transcriptContent = server.implement(inspectorTranscriptContentContract).handler(async ({ input, errors }) => {
    try {
      await requireSubscription();
      const source = await readInspectorContext(env, userId, input.workspaceId ?? input.projectId, input.projectId);
      const content = await readSavedInspectorTranscriptContent(env, userId, source, input);
      await requireSubscription();
      return ok(content);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      return err(errors.OperationFailed({ operation: 'read saved Inspector transcript content', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const overview = server.implement(inspectorOverviewContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await source.context.getOverview(source.identity));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      return err(errors.OperationFailed({ operation: 'read Inspector overview', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const journal = server.implement(inspectorJournalContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await source.context.listJournal(source.identity));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      return err(errors.OperationFailed({ operation: 'read Inspector journal', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const threads = server.implement(inspectorReviewThreadsContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await source.context.listReviewThreads(source.identity));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      return err(errors.OperationFailed({ operation: 'read Inspector threads', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putGoal = server.implement(inspectorPutGoalContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.putGoal({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'goal', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector putGoal', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const attachEvidence = server.implement(inspectorAttachRequirementEvidenceContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.attachRequirementEvidence({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'goal', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector attachEvidence', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putWorkflow = server.implement(inspectorPutWorkflowContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.putWorkflow({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'workflow', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector putWorkflow', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const waiveGate = server.implement(inspectorWaiveWorkflowGateContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const caller = requireDeviceAdministration(await currentDevice());
      const value = await source.context.waiveWorkflowGate({ ...input.input, ...source.identity, actorId: caller.deviceId, actorKind: caller.kind === 'browser' ? 'human' : 'client' });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'workflow', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector waiveGate', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putRubric = server.implement(inspectorPutRubricContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.putRubric({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'rubric', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector putRubric', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const appendJudgment = server.implement(inspectorAppendRubricJudgmentContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const caller = requireDeviceAdministration(await currentDevice());
      const value = await source.context.appendRubricJudgment({ ...input.input, ...source.identity, judgment: { ...input.input.judgment, actorId: caller.deviceId, actorKind: caller.kind === 'browser' ? 'human' : 'client', createdAt: new Date().toISOString() } });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'rubric', entityId: value.id, revision: value.revision, operation: 'append', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector appendJudgment', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const startPhase = server.implement(inspectorStartJournalPhaseContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.startJournalPhase({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'journal', entityId: value.id, revision: value.sequence, operation: 'created', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector startPhase', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const endPhase = server.implement(inspectorEndJournalPhaseContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.endJournalPhase({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'journal', entityId: value.id, revision: value.sequence, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector endPhase', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const appendJournal = server.implement(inspectorAppendJournalEntryContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.appendJournalEntry({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'journal', entityId: value.id, revision: value.sequence, operation: 'append', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector appendJournal', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putGuide = server.implement(inspectorPutChangeGuideContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.putChangeGuide({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'change-guide', entityId: source.identity.spaceId, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector putGuide', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const markSectionRead = server.implement(inspectorMarkGuideSectionReadContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const caller = await currentDevice();
      const value = await source.context.markGuideSectionRead({ ...input.input, ...source.identity, reviewerId: caller.deviceId });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'change-guide', entityId: source.identity.spaceId, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector markSectionRead', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const setApproval = server.implement(inspectorSetGuideApprovalContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const caller = requireDeviceAdministration(await currentDevice());
      const value = await source.context.setGuideApproval({ ...input.input, ...source.identity, reviewerId: caller.deviceId });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'change-guide', entityId: source.identity.spaceId, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector setApproval', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const createThread = server.implement(inspectorCreateReviewThreadContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.createReviewThread({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'review-thread', entityId: value.id, revision: value.revision, operation: 'created', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector createThread', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const replyThread = server.implement(inspectorAppendReviewMessageContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.appendReviewMessage({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'review-thread', entityId: value.id, revision: value.revision, operation: 'append', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector replyThread', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const resolveThread = server.implement(inspectorResolveReviewThreadContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.input.spaceId, input.input.projectId, input.expectedGeneration);
      const value = await source.context.resolveReviewThread({ ...input.input, ...source.identity });
      await source.authority.appendEvent({ scope: 'workspace', entity: 'review-thread', entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: source.identity.spaceId } });
      return ok(value);
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      if (error instanceof InspectorConflictError) return err(errors.InspectorConflict({ resource: error.resource, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'Inspector resolveThread', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const readArtifact = server.implement(inspectorReadArtifactContract).stream(async function* ({ input, errors, signal }) {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      for (const frame of await new InspectorCloudArtifacts(env, userId, source).read(input.url, input.hash)) {
        if (signal.aborted) return;
        yield ok(frame);
      }
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) { yield err(errors.WorkspaceNotFound({ workspaceId: error.spaceId })); return; }
      if (error instanceof InspectorGenerationConflict) { yield err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual })); return; }
      if (error instanceof InspectorStateError) { yield err(errors.InspectorState({ resource: 'inspector', message: error.message })); return; }
      yield err(errors.OperationFailed({ operation: 'Inspector readArtifact', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const readArtifactPage = server.implement(inspectorReadArtifactPageContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      const frames = await new InspectorCloudArtifacts(env, userId, source).read(input.url, input.hash);
      const { cursor, limit, ...identity } = input;
      return ok(await snapshotPage(frames, { identity, cursor, limit }));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      if (error instanceof InspectorStateError) return err(errors.InspectorState({ resource: 'inspector', message: error.message }));
      return err(errors.OperationFailed({ operation: 'Inspector readArtifactPage', message: error instanceof Error ? error.message : 'Unable to read artifact page' }));
    }
  });
  const writeArtifact = server.implement(inspectorWriteArtifactContract).handler(({ errors }) =>
    err(errors.InspectorState({ resource: 'artifacts', message: 'Open this workspace on a machine before editing artifacts.' })));
  // Uploads stage bytes on the holder's disk; without a live holder there is nowhere to stage them.
  const beginUpload = server.implement(inspectorBeginArtifactUploadContract).handler(({ errors }) =>
    err(errors.InspectorState({ resource: 'upload', message: 'Open this workspace on a machine before uploading artifacts.' })));
  const uploadChunk = server.implement(inspectorUploadArtifactChunkContract).handler(({ errors }) =>
    err(errors.InspectorState({ resource: 'upload', message: 'This upload ended because its workspace is no longer open on a machine.' })));
  const commitUpload = server.implement(inspectorCommitArtifactUploadContract).handler(({ errors }) =>
    err(errors.InspectorState({ resource: 'upload', message: 'This upload ended because its workspace is no longer open on a machine.' })));
  const abortUpload = server.implement(inspectorAbortArtifactUploadContract).handler(() => ok({ aborted: false }));
  const listArtifacts = server.implement(inspectorListArtifactsContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await new InspectorCloudArtifacts(env, userId, source).catalog());
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'list artifacts', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const copyArtifacts = server.implement(inspectorCopyArtifactsContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await new InspectorCloudArtifacts(env, userId, source).copyToProject(input.files, input.expectedProjectGeneration));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'copy artifacts to project', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const listShares = server.implement(inspectorListArtifactSharesContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await new InspectorCloudArtifacts(env, userId, source).listShares(input.url));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'list artifact shares', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const createShare = server.implement(inspectorCreateArtifactShareContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await new InspectorCloudArtifacts(env, userId, source).createShare(input.url, input.hash, input.expiresAt));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'share artifact', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const revokeShare = server.implement(inspectorRevokeArtifactShareContract).handler(async ({ input, errors }) => {
    try {
      const source = await readInspectorContext(env, userId, input.spaceId, undefined, input.expectedGeneration);
      return ok(await new InspectorCloudArtifacts(env, userId, source).revokeShare(input.id));
    } catch (error) {
      if (error instanceof InspectorWorkspaceMissing) return err(errors.WorkspaceNotFound({ workspaceId: error.spaceId }));
      if (error instanceof InspectorGenerationConflict) return err(errors.SpaceGenerationConflict({ spaceId: error.spaceId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'revoke artifact share', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const repositoryTree = server.implement(inspectorRepositoryTreeContract).stream(async function* ({ errors }) {
    yield err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' }));
  });
  const repositoryTreePage = server.implement(inspectorRepositoryTreePageContract).handler(({ errors }) =>
    err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const readResourcePage = server.implement(inspectorReadResourcePageContract).handler(({ errors }) =>
    err(errors.InspectorState({ resource: 'runtime', message: 'Session resources require the live workspace and originating session.' })));
  const repositoryStatus = server.implement(inspectorRepositoryStatusContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const repositoryFile = server.implement(inspectorRepositoryFileContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const repositoryDiff = server.implement(inspectorRepositoryDiffContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const analyzeGuide = server.implement(inspectorAnalyzeChangeGuideContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const submitGuide = server.implement(inspectorSubmitChangeGuideContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const listServices = server.implement(inspectorServicesContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const startService = server.implement(startWorkspaceServiceContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  const stopService = server.implement(stopWorkspaceServiceContract).handler(({ errors }) => err(errors.InspectorState({ resource: 'runtime', message: 'Live repository and services are unavailable. Open the workspace explicitly to use this operation.' })));
  return {
    view, transcript, transcriptPage, transcriptContent, availability, overview,
    goal: { put: putGoal, attachEvidence },
    workflow: { put: putWorkflow, waiveGate },
    rubric: { put: putRubric, appendJudgment },
    journal: { list: journal, startPhase, endPhase, append: appendJournal },
    guide: { put: putGuide, analyze: analyzeGuide, submit: submitGuide, markSectionRead, setApproval },
    review: { list: threads, create: createThread, reply: replyThread, resolve: resolveThread },
    artifacts: {
      read: readArtifact, readPage: readArtifactPage, write: writeArtifact, list: listArtifacts, copyToProject: copyArtifacts, shares: { list: listShares, create: createShare, revoke: revokeShare },
      uploadBegin: beginUpload, uploadChunk, uploadCommit: commitUpload, uploadAbort: abortUpload,
    },
    resources: { readPage: readResourcePage },
    repository: { tree: repositoryTree, treePage: repositoryTreePage, status: repositoryStatus, file: repositoryFile, diff: repositoryDiff },
    services: { list: listServices, start: startService, stop: stopService },
  };
}
