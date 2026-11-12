import { z } from 'zod';
import {
  appendJournalEntryInputSchema, appendReviewMessageInputSchema, attachRequirementEvidenceInputSchema, changeGuideAgentDraftSchema,
  createReviewThreadInputSchema, endJournalPhaseInputSchema, goalAgentDraftSchema, markGuideSectionReadInputSchema,
  putChangeGuideInputSchema, putGoalInputSchema, putRubricInputSchema, putWorkflowInputSchema,
  resolveReviewThreadInputSchema, reviewAnchorContextSchema, reviewMessageViewSchema, rubricAgentDraftSchema, startJournalPhaseInputSchema, workflowAgentDraftSchema,
} from '@gitspace/protocol';
import { RuntimeIdentitySchema, RuntimeJsonSchema } from '@gitspace/protocol-runtime';

export const runtimeSpaceToolNames: readonly string[] = ['space_goal', 'space_workflow', 'space_rubric', 'space_journal', 'space_guide', 'space_review'];

/** The space_* tools' cloud authority operations. Who wrote a record, its ids and its code are the host's to fill in. */
export async function invokeRuntimeSpaceTool(env: Env, identity: z.infer<typeof RuntimeIdentitySchema>, input: { tool: string; args: z.infer<typeof RuntimeJsonSchema>; conversationId: string; attemptId: string }): Promise<unknown> {
  if (!runtimeSpaceToolNames.includes(input.tool)) throw new Error('Unknown workspace authority tool');
  const { method, workspaceId, projectId, spaceId, context: rawContext, ...payload } = z.object({
    method: z.string().min(1), workspaceId: z.string().min(1).optional(), projectId: z.string().optional(),
    spaceId: z.string().optional(), context: z.unknown().optional(),
  }).passthrough().parse(input.args);
  if (projectId !== undefined && projectId !== identity.projectId) throw new Error('Workspace target must belong to the current project');
  if (spaceId !== undefined) throw new Error('Use workspaceId; spaceId is supplied by the host');
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const target = workspaceId ?? identity.workspaceId;
  const definitions = await authority.listWorkspaces();
  if (target !== identity.projectId && !definitions.some(workspace => workspace.id === target && workspace.projectId === identity.projectId)) throw new Error('Workspace does not exist in current project');
  const owned = { projectId: identity.projectId, spaceId: target };
  const context = env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, owned.projectId, owned.spaceId]));
  const key = `${input.tool}.${method}`;
  if (key === 'space_workflow.waiveGate' || key === 'space_guide.approve' || key === 'space_rubric.judge') {
    throw new Error('This decision requires authenticated account administration; agents cannot claim human approval');
  }
  const reviewContext = rawContext === undefined ? undefined : reviewAnchorContextSchema.parse(rawContext);
  const actorId = `conversation:${input.conversationId}`;
  const publish = async <T extends { id?: string; revision?: number; sequence?: number }>(entity: string, value: T, operation: 'updated' | 'append' | 'created' = 'updated') => {
    await authority.appendEvent({ eventId: `runtime:${input.attemptId}:${key}`, scope: 'workspace', entity,
      entityId: value.id ?? target, revision: value.revision ?? value.sequence ?? Date.now(), operation, payload: { spaceId: target } });
    return value;
  };
  /** The workspace's code as a journal phase records it: its placement generation and its published branch HEAD. */
  const repository = async () => {
    const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${target}`);
    const [placement, report] = await Promise.all([space.get(), space.workspaceReport()]);
    const headCommit = report?.code?.headCommit;
    if (!headCommit) throw new Error(`Workspace ${target} has no commit yet, so a journal phase cannot record its code`);
    return { generation: placement?.generation ?? 0, headCommit };
  };
  /** A review message as the agent writes it (its body), with the id, author and time the host knows. Ids come from the
   * call's attempt, so a retried call writes the same ones. */
  const message = () => ({ ...reviewMessageViewSchema.pick({ body: true }).parse(payload.message), id: `message:${input.attemptId}`, authorId: actorId, createdAt: new Date().toISOString() });
  const args = { ...payload, ...owned };
  switch (key) {
    case 'space_goal.get': return context.getGoal(owned);
    case 'space_goal.put': return publish('goal', await context.putGoal(putGoalInputSchema.parse({ ...args, goal: { ...goalAgentDraftSchema.parse(payload.goal), updatedBy: actorId } })));
    case 'space_goal.attachEvidence': return publish('goal', await context.attachRequirementEvidence(attachRequirementEvidenceInputSchema.parse(args)));
    case 'space_workflow.get': return context.getWorkflow(owned);
    case 'space_workflow.put': return publish('workflow', await context.putWorkflow(putWorkflowInputSchema.parse({ ...args, workflow: { ...workflowAgentDraftSchema.parse(payload.workflow), updatedBy: actorId } })));
    case 'space_rubric.get': return context.getRubric(owned);
    case 'space_rubric.put': return publish('rubric', await context.putRubric(putRubricInputSchema.parse({ ...args, rubric: { ...rubricAgentDraftSchema.parse(payload.rubric), updatedBy: actorId } })));
    case 'space_journal.list': return context.listJournal(owned);
    case 'space_journal.startPhase': return publish('journal', await context.startJournalPhase(startJournalPhaseInputSchema.parse({ ...args, phaseRunId: `phase:${input.attemptId}`, entryId: `start:${input.attemptId}`, createdBy: actorId, repository: await repository() })), 'created');
    case 'space_journal.endPhase': return publish('journal', await context.endJournalPhase(endJournalPhaseInputSchema.parse({ ...args, entryId: `end:${input.attemptId}`, createdBy: actorId, repository: await repository() })));
    case 'space_journal.append': return publish('journal', await context.appendJournalEntry(appendJournalEntryInputSchema.parse({ ...args, id: `entry:${input.attemptId}`, createdBy: actorId })), 'append');
    case 'space_guide.get': return context.getChangeGuide(owned);
    case 'space_guide.put': return publish('change-guide', await context.putChangeGuide(putChangeGuideInputSchema.parse({ ...args, guide: { ...changeGuideAgentDraftSchema.parse(payload.guide), createdBy: actorId } })));
    case 'space_guide.markRead': return publish('change-guide', await context.markGuideSectionRead(markGuideSectionReadInputSchema.parse({ ...args, reviewerId: actorId })));
    case 'space_review.list': return context.listReviewThreads(owned, reviewContext);
    case 'space_review.create': return publish('review-thread', await context.createReviewThread(createReviewThreadInputSchema.parse({ ...args, id: `thread:${input.attemptId}`, message: message() }), reviewContext), 'created');
    case 'space_review.append': return publish('review-thread', await context.appendReviewMessage(appendReviewMessageInputSchema.parse({ ...args, message: message() }), reviewContext), 'append');
    case 'space_review.resolve': return publish('review-thread', await context.resolveReviewThread(resolveReviewThreadInputSchema.parse(args), reviewContext));
    default: throw new Error('Unknown workspace authority operation');
  }
}
