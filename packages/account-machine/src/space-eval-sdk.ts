import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';

export interface OmpEvalNamespace {
  declaration: string;
  call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

const SPACE_DECLARATION = `{
  current(): Promise<unknown>;
  list(): Promise<unknown[]>;
  goal: { get(): Promise<unknown>; put(input: object): Promise<unknown>; attachEvidence(input: object): Promise<unknown> };
  workflow: { get(): Promise<unknown>; put(input: object): Promise<unknown>; waiveGate(input: object): Promise<unknown> };
  rubric: { get(): Promise<unknown>; put(input: object): Promise<unknown>; judge(input: object): Promise<unknown> };
  journal: { list(): Promise<unknown[]>; startPhase(input: object): Promise<unknown>; endPhase(input: object): Promise<unknown>; append(input: object): Promise<unknown> };
  guide: { get(): Promise<unknown>; put(input: object): Promise<unknown>; markRead(input: object): Promise<unknown>; approve(input: object): Promise<unknown> };
  review: { list(input?: { context?: object }): Promise<unknown[]>; create(input: object): Promise<unknown>; append(input: object): Promise<unknown>; resolve(input: object): Promise<unknown> };
  artifacts: { listScopes(): Promise<unknown[]>; listPromotions(): Promise<unknown[]> };
  chain: { list(): Promise<unknown[]> };
}`;

export function createSpaceEvalNamespace(
  authority: CloudSpaceCheckpointAuthority,
  projectId: string,
  workspaceId: string | null,
): OmpEvalNamespace {
  const spaceId = workspaceId ?? projectId;
  const identity = { projectId, spaceId };
  return {
    declaration: SPACE_DECLARATION,
    async call(method, rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : {};
      const { context, ...payload } = args;
      const input = { ...payload, ...identity };
      switch (method) {
        case 'current': {
          const [project, workspaces, placement, overview] = await Promise.all([
            authority.getProject(projectId),
            authority.listProjectWorkspaces(projectId),
            authority.getSpace(projectId, spaceId),
            authority.getInspectorOverview(identity),
          ]);
          return { identity, scope: workspaceId === null ? 'project' : 'workspace', project, workspaces, placement, overview };
        }
        case 'list':
        case 'chain.list':
          return authority.listProjectWorkspaces(projectId);
        case 'goal.get': return authority.getInspectorGoal(identity);
        case 'goal.put': return authority.putInspectorGoal(input as never);
        case 'goal.attachEvidence': return authority.attachInspectorRequirementEvidence(input as never);
        case 'workflow.get': return authority.getInspectorWorkflow(identity);
        case 'workflow.put': return authority.putInspectorWorkflow(input as never);
        case 'workflow.waiveGate': return authority.waiveInspectorWorkflowGate(input as never);
        case 'rubric.get': return authority.getInspectorRubric(identity);
        case 'rubric.put': return authority.putInspectorRubric(input as never);
        case 'rubric.judge': return authority.appendInspectorRubricJudgment(input as never);
        case 'journal.list': return authority.listInspectorJournal(identity);
        case 'journal.startPhase': return authority.startInspectorJournalPhase(input as never);
        case 'journal.endPhase': return authority.endInspectorJournalPhase(input as never);
        case 'journal.append': return authority.appendInspectorJournalEntry(input as never);
        case 'guide.get': return authority.getInspectorChangeGuide(identity);
        case 'guide.put': return authority.putInspectorChangeGuide(input as never);
        case 'guide.markRead': return authority.markInspectorGuideSectionRead(input as never);
        case 'guide.approve': return authority.setInspectorGuideApproval(input as never);
        case 'artifacts.listScopes': return authority.listArtifactScopes(projectId);
        case 'artifacts.listPromotions': return authority.listArtifactPromotions(projectId);
        case 'review.list': return authority.listInspectorReviewThreads(identity, context as never);
        case 'review.create': return authority.createInspectorReviewThread(input as never, context as never);
        case 'review.append': return authority.appendInspectorReviewMessage(input as never, context as never);
        case 'review.resolve': return authority.resolveInspectorReviewThread(input as never, context as never);
        default: throw new Error(`Unknown space namespace method: ${method}`);
      }
    },
  };
}
