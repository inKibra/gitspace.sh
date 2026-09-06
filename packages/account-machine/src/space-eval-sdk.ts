import { z } from 'zod';
import {
  appendJournalEntryInputSchema, appendReviewMessageInputSchema, appendRubricJudgmentInputSchema,
  attachRequirementEvidenceInputSchema, createReviewThreadInputSchema, endJournalPhaseInputSchema,
  markGuideSectionReadInputSchema, putChangeGuideInputSchema, putGoalInputSchema, putRubricInputSchema,
  putWorkflowInputSchema, resolveReviewThreadInputSchema, setGuideApprovalInputSchema,
  startJournalPhaseInputSchema, waiveWorkflowGateInputSchema,
  LifecyclePhaseSchema,
  goalDraftSchema, workflowDraftSchema, rubricDraftSchema,
  type CloudWorkspaceDefinition, type InspectorIdentity,
} from '@gitspace/protocol';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { CreateWorkspaceInput } from './project-lifecycle.js';

export interface OmpEvalNamespace {
  declaration: string;
  call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface SpaceWorkspaceCreation {
  workspace: { id: string; projectId: string };
  operation: unknown;
}

export interface SpaceWorkspaceControls {
  create(input: CreateWorkspaceInput): Promise<SpaceWorkspaceCreation>;
  manage(method: 'setPhase' | 'setRelations' | 'open' | 'close' | 'archive' | 'restore', workspace: CloudWorkspaceDefinition, input: Record<string, unknown>): Promise<unknown>;
  instructionsChanged(projectId: string, spaceId: string): Promise<void>;
  refreshArtifacts(projectId: string, spaceId: string): Promise<void>;
  environment(method: SpaceEnvironmentMethod, projectId: string, spaceId: string, input: Record<string, unknown>): Promise<unknown>;
}

const environmentName = z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u);
const environmentScope = z.enum(['project', 'workspace']);
export const spaceEnvironmentSchemas = {
  get: z.object({}).strict(),
  runLog: z.object({ runId: z.string().min(1), offset: z.number().int().nonnegative().optional() }).strict(),
  setProfile: z.object({ profile: z.string().min(1).max(64) }).strict(),
  putValue: z.object({ scope: environmentScope, name: environmentName, value: z.string().max(16_384) }).strict(),
  deleteValue: z.object({ scope: environmentScope, name: environmentName }).strict(),
  runChecks: z.object({}).strict(),
  runPhase: z.object({ phase: LifecyclePhaseSchema.exclude(['cloud/destroy']), rerun: z.boolean().optional() }).strict(),
};
export type SpaceEnvironmentMethod = keyof typeof spaceEnvironmentSchemas;

const mutationSchemas = {
  'goal.put': putGoalInputSchema,
  'goal.attachEvidence': attachRequirementEvidenceInputSchema,
  'workflow.put': putWorkflowInputSchema,
  'workflow.waiveGate': waiveWorkflowGateInputSchema,
  'rubric.put': putRubricInputSchema,
  'rubric.judge': appendRubricJudgmentInputSchema,
  'journal.startPhase': startJournalPhaseInputSchema,
  'journal.endPhase': endJournalPhaseInputSchema,
  'journal.append': appendJournalEntryInputSchema,
  'guide.put': putChangeGuideInputSchema,
  'guide.markRead': markGuideSectionReadInputSchema,
  'guide.approve': setGuideApprovalInputSchema,
  'review.create': createReviewThreadInputSchema,
  'review.append': appendReviewMessageInputSchema,
  'review.resolve': resolveReviewThreadInputSchema,
};

const SPACE_DECLARATION = `{
  current(): Promise<unknown>;
  get(input: { workspaceId: string }): Promise<unknown>;
  list(): Promise<unknown[]>; // canonical definitions, placement/status, and goals, including closed workspaces
  describe(input: { method: string }): Promise<object>; // canonical JSON input schema; omit projectId/spaceId, use optional workspaceId
  create(input: { name: string; branch: string; phase: 'plan'|'code'|'review'|'ship'; sourceKind: 'base'|'branch'|'workspace'|'pull-request'; sourceRef: string; dependsOn?: string[]; goal?: object; workflow?: object; rubric?: object }): Promise<unknown>; // describe({method:'create'}) provides exact typed draft schemas; ready:false includes identity and partial initialization error
  setPhase(input: { workspaceId?: string; expectedRevision: number; phase: 'plan'|'code'|'review'|'ship' }): Promise<unknown>;
  setRelations(input: { workspaceId?: string; expectedRevision: number; dependsOn: string[]; relatedTo: string[]; stackedOn: string|null }): Promise<unknown>;
  open(input: { workspaceId?: string; expectedGeneration: number }): Promise<unknown>;
  close(input: { workspaceId?: string; expectedGeneration: number }): Promise<unknown>;
  archive(input: { workspaceId?: string; expectedRevision: number; expectedGeneration: number }): Promise<unknown>;
  restore(input: { workspaceId?: string; expectedRevision: number; expectedGeneration: number }): Promise<unknown>;
  environment: {
    get(input?: { workspaceId?: string }): Promise<unknown>; // same cloud lifecycle ledger and current executions as the UI; closed reads never open a checkout
    runLog(input: { workspaceId?: string; runId: string; offset?: number }): Promise<{ output: string; nextOffset: number|null }>;
    setProfile(input: { workspaceId?: string; profile: string }): Promise<unknown>;
    putValue(input: { workspaceId?: string; scope: 'project'|'workspace'; name: string; value: string }): Promise<unknown>;
    deleteValue(input: { workspaceId?: string; scope: 'project'|'workspace'; name: string }): Promise<unknown>;
    runChecks(input?: { workspaceId?: string }): Promise<unknown>;
    runPhase(input: { workspaceId?: string; phase: 'cloud/provision'|'machine/prepare'|'workspace/materialize'|'workspace/dematerialize'; rerun?: boolean }): Promise<unknown>; // approved content only; explicit provisioning request enables policy. New content approval, recovery, and destructive retirement require the human browser.
  };
  goal: { get(input?: { workspaceId?: string }): Promise<unknown>; put(input: { workspaceId?: string; expectedRevision: number; goal: object }): Promise<unknown>; attachEvidence(input: { workspaceId?: string; expectedRevision: number; requirementId: string; evidence: object }): Promise<unknown> };
  workflow: { get(input?: { workspaceId?: string }): Promise<unknown>; put(input: { workspaceId?: string; expectedRevision: number; workflow: object }): Promise<unknown>; waiveGate(input: object): Promise<unknown> };
  rubric: { get(input?: { workspaceId?: string }): Promise<unknown>; put(input: { workspaceId?: string; expectedRevision: number; rubric: object }): Promise<unknown>; judge(input: object): Promise<unknown> };
  journal: { list(input?: { workspaceId?: string }): Promise<unknown[]>; startPhase(input: object): Promise<unknown>; endPhase(input: object): Promise<unknown>; append(input: object): Promise<unknown> };
  guide: { get(input?: { workspaceId?: string }): Promise<unknown>; put(input: object): Promise<unknown>; markRead(input: object): Promise<unknown>; approve(input: object): Promise<unknown> };
  review: { list(input?: { workspaceId?: string; context?: object }): Promise<unknown[]>; create(input: object): Promise<unknown>; append(input: object): Promise<unknown>; resolve(input: object): Promise<unknown> };
  artifacts: { listScopes(): Promise<unknown[]>; listPromotions(): Promise<unknown[]> };
  chain: { list(): Promise<unknown[]> };
}`;

const createSchema = z.object({
  name: z.string().trim().min(1).max(160), branch: z.string().min(1).max(512),
  phase: z.enum(['plan', 'code', 'review', 'ship']),
  sourceKind: z.enum(['base', 'branch', 'workspace', 'pull-request']), sourceRef: z.string(),
  dependsOn: z.array(z.string().min(1)).optional(),
  goal: goalDraftSchema.optional(), workflow: workflowDraftSchema.optional(), rubric: rubricDraftSchema.optional(),
}).strict();

export function createSpaceEvalNamespace(
  authority: CloudSpaceCheckpointAuthority,
  projectId: string,
  workspaceId: string | null,
  controls?: SpaceWorkspaceControls,
): OmpEvalNamespace {
  const currentSpaceId = workspaceId ?? projectId;
  const requireControls = (): SpaceWorkspaceControls => {
    if (!controls) throw new Error('Workspace lifecycle controls are unavailable');
    return controls;
  };
  const readWorkspace = async (spaceId: string, workspaces?: CloudWorkspaceDefinition[]) => {
    const identity = { projectId, spaceId };
    const [project, definitions, placement, overview] = await Promise.all([
      authority.getProject(projectId), workspaces ?? authority.listProjectWorkspaces(projectId),
      authority.getSpace(projectId, spaceId), authority.getInspectorOverview(identity),
    ]);
    return { identity, scope: spaceId === projectId ? 'project' : 'workspace', project, workspaces: definitions,
      workspace: definitions.find((workspace) => workspace.id === spaceId) ?? null, placement, overview };
  };
  const publish = async <T extends { id?: string; revision?: number; sequence?: number }>(
    identity: InspectorIdentity, entity: string, value: T, operation: 'updated' | 'append' | 'created' = 'updated',
  ): Promise<T> => {
    await authority.appendProjectEvent({ projectId, scope: 'workspace', entity,
      entityId: value.id ?? identity.spaceId, revision: value.revision ?? value.sequence ?? Date.now(), operation,
      payload: { spaceId: identity.spaceId } });
    if (entity === 'goal' || entity === 'workflow' || entity === 'rubric') {
      await controls?.instructionsChanged(projectId, identity.spaceId);
    }
    return value;
  };
  return {
    declaration: SPACE_DECLARATION,
    async call(method, rawArgs) {
      const args = rawArgs === undefined || rawArgs === null ? {} : z.record(z.string(), z.unknown()).parse(rawArgs);
      const { workspaceId: target, projectId: suppliedProject, spaceId: suppliedSpace, context, ...payload } = args;
      if (suppliedProject !== undefined && suppliedProject !== projectId) throw new Error('Workspace target must belong to the current project');
      if (suppliedSpace !== undefined) throw new Error('Use workspaceId to target a workspace; spaceId is supplied by the host');
      if (method === 'describe') {
        const name = z.string().parse(payload.method);
        if (name === 'create') return z.toJSONSchema(createSchema);
        if (name.startsWith('environment.')) {
          const method = name.slice('environment.'.length) as SpaceEnvironmentMethod;
          if (!Object.hasOwn(spaceEnvironmentSchemas, method)) throw new Error(`No agent input schema for space.${name}; approvals, recovery, and retirement require the human browser`);
          const schema = spaceEnvironmentSchemas[method];
          const json = z.toJSONSchema(schema);
          return { ...json, properties: { ...json.properties, workspaceId: { type: 'string' } } };
        }
        const schema = mutationSchemas[name as keyof typeof mutationSchemas];
        if (!schema) throw new Error(`No input schema for space.${name}`);
        const json = z.toJSONSchema(schema);
        const { projectId: _project, spaceId: _space, ...properties } = json.properties ?? {};
        return { ...json, properties: { ...properties, workspaceId: { type: 'string' } }, required: json.required?.filter((key) => key !== 'projectId' && key !== 'spaceId') };
      }
      if (method === 'create') {
        if (target !== undefined) throw new Error('Create does not accept a workspace target');
        // Parse all drafts before lifecycle side effects. Cloud writes are separately revision-fenced, not atomic with creation.
        const { goal, workflow, rubric, ...workspace } = createSchema.parse(payload);
        const created = await requireControls().create({ ...workspace, projectId });
        const identity = { projectId, spaceId: created.workspace.id };
        const initialized: string[] = [];
        let initializing = 'goal';
        try {
          if (goal) {
            await publish(identity, 'goal', await authority.putInspectorGoal({ ...identity, expectedRevision: 0, goal }));
            initialized.push('goal');
          }
          initializing = 'workflow';
          if (workflow) {
            await publish(identity, 'workflow', await authority.putInspectorWorkflow({ ...identity, expectedRevision: 0, workflow }));
            initialized.push('workflow');
          }
          initializing = 'rubric';
          if (rubric) {
            await publish(identity, 'rubric', await authority.putInspectorRubric({ ...identity, expectedRevision: 0, rubric }));
            initialized.push('rubric');
          }
          return { ...created, identity, ready: true, initialized };
        } catch (error) {
          return { ...created, identity, ready: false, initialized, error: {
            operation: `${initializing}.put`, message: error instanceof Error ? error.message : String(error),
            recovery: 'The workspace exists. Read its latest records and reconcile the incomplete instruction writes; do not recreate it.',
          } };
        }
      }
      if (method === 'artifacts.listScopes') return authority.listArtifactScopes(projectId);
      if (method === 'artifacts.listPromotions') return authority.listArtifactPromotions(projectId);
      if (method === 'list' || method === 'chain.list') {
        return Promise.all((await authority.listProjectWorkspaces(projectId)).map(async (workspace) => ({
          ...workspace, placement: await authority.getSpace(projectId, workspace.id),
          goal: await authority.getInspectorGoal({ projectId, spaceId: workspace.id }),
        })));
      }
      if (method === 'current') {
        if (target !== undefined) throw new Error('Use space.get({ workspaceId }) to inspect another workspace');
        return readWorkspace(currentSpaceId);
      }
      const spaceId = target === undefined ? currentSpaceId : z.string().min(1).parse(target);
      if (method === 'get' && target === undefined) throw new Error('space.get requires workspaceId');
      const workspaces = await authority.listProjectWorkspaces(projectId);
      const definition = workspaces.find((workspace) => workspace.id === spaceId && workspace.projectId === projectId);
      if (!definition) throw new Error(`Workspace ${spaceId} does not exist in current project ${projectId}`);
      if (method === 'get') return readWorkspace(spaceId, workspaces);
      if (method.startsWith('environment.')) {
        const name = method.slice('environment.'.length) as SpaceEnvironmentMethod;
        if (!Object.hasOwn(spaceEnvironmentSchemas, name)) throw new Error('Environment approvals, recovery, and retirement require the human browser');
        if (name === 'runPhase' && payload.phase === 'cloud/destroy') throw new Error('Cloud retirement requires explicit approval in the human browser; agents cannot authorize it');
        const input = spaceEnvironmentSchemas[name].parse(payload);
        return requireControls().environment(name, projectId, spaceId, input);
      }
      if (method === 'setPhase' || method === 'setRelations' || method === 'open' || method === 'close' || method === 'archive' || method === 'restore') {
        if ((method === 'close' || method === 'archive') && spaceId === currentSpaceId) {
          throw new Error('An agent cannot close or archive its own workspace while executing a tool; use another workspace or the UI');
        }
        return requireControls().manage(method, definition, payload);
      }
      const identity = { projectId, spaceId };
      const input = { ...payload, ...identity };
      switch (method) {
        case 'goal.get': return authority.getInspectorGoal(identity);
        case 'goal.put': return publish(identity, 'goal', await authority.putInspectorGoal(putGoalInputSchema.parse(input)));
        case 'instructions.get': {
          if (target !== undefined) throw new Error('Instruction refresh is scoped to the current workspace');
          await controls?.refreshArtifacts(projectId, spaceId);
          const [goal, workflow, rubric] = await Promise.all([
            authority.getInspectorGoal(identity), authority.getInspectorWorkflow(identity), authority.getInspectorRubric(identity),
          ]);
          return { goal, workflow, rubric };
        }
        case 'goal.attachEvidence': return publish(identity, 'goal', await authority.attachInspectorRequirementEvidence(attachRequirementEvidenceInputSchema.parse(input)));
        case 'workflow.get': return authority.getInspectorWorkflow(identity);
        case 'workflow.put': return publish(identity, 'workflow', await authority.putInspectorWorkflow(putWorkflowInputSchema.parse(input)));
        case 'workflow.waiveGate': return publish(identity, 'workflow', await authority.waiveInspectorWorkflowGate(waiveWorkflowGateInputSchema.parse(input)));
        case 'rubric.get': return authority.getInspectorRubric(identity);
        case 'rubric.put': return publish(identity, 'rubric', await authority.putInspectorRubric(putRubricInputSchema.parse(input)));
        case 'rubric.judge': return publish(identity, 'rubric', await authority.appendInspectorRubricJudgment(appendRubricJudgmentInputSchema.parse(input)), 'append');
        case 'journal.list': return authority.listInspectorJournal(identity);
        case 'journal.startPhase': return publish(identity, 'journal', await authority.startInspectorJournalPhase(startJournalPhaseInputSchema.parse(input)), 'created');
        case 'journal.endPhase': return publish(identity, 'journal', await authority.endInspectorJournalPhase(endJournalPhaseInputSchema.parse(input)));
        case 'journal.append': return publish(identity, 'journal', await authority.appendInspectorJournalEntry(appendJournalEntryInputSchema.parse(input)), 'append');
        case 'guide.get': return authority.getInspectorChangeGuide(identity);
        case 'guide.put': return publish(identity, 'change-guide', await authority.putInspectorChangeGuide(putChangeGuideInputSchema.parse(input)));
        case 'guide.markRead': return publish(identity, 'change-guide', await authority.markInspectorGuideSectionRead(markGuideSectionReadInputSchema.parse(input)));
        case 'guide.approve': return publish(identity, 'change-guide', await authority.setInspectorGuideApproval(setGuideApprovalInputSchema.parse(input)));
        case 'review.list': return authority.listInspectorReviewThreads(identity, context as never);
        case 'review.create': return publish(identity, 'review-thread', await authority.createInspectorReviewThread(createReviewThreadInputSchema.parse(input), context as never), 'created');
        case 'review.append': return publish(identity, 'review-thread', await authority.appendInspectorReviewMessage(appendReviewMessageInputSchema.parse(input), context as never), 'append');
        case 'review.resolve': return publish(identity, 'review-thread', await authority.resolveInspectorReviewThread(resolveReviewThreadInputSchema.parse(input), context as never));
        default: throw new Error(`Unknown space namespace method: ${method}`);
      }
    },
  };
}
