import { z } from 'zod';
import {
  appendJournalEntryInputSchema, appendReviewMessageInputSchema, attachRequirementEvidenceInputSchema,
  createReviewThreadInputSchema, endJournalPhaseInputSchema, markGuideSectionReadInputSchema,
  putChangeGuideInputSchema, putGoalInputSchema, putRubricInputSchema, putWorkflowInputSchema,
  resolveReviewThreadInputSchema, reviewAnchorContextSchema, startJournalPhaseInputSchema,
} from '@gitspace/protocol';
import { RuntimeIdentitySchema, RuntimeJsonSchema } from '@gitspace/protocol-runtime';

export const runtimeSpaceToolNames: readonly string[] = ['space_goal', 'space_workflow', 'space_rubric', 'space_journal', 'space_guide', 'space_review'];
const schemas = {
  'space_goal.put': putGoalInputSchema, 'space_goal.attachEvidence': attachRequirementEvidenceInputSchema,
  'space_workflow.put': putWorkflowInputSchema, 'space_rubric.put': putRubricInputSchema,
  'space_journal.startPhase': startJournalPhaseInputSchema, 'space_journal.endPhase': endJournalPhaseInputSchema,
  'space_journal.append': appendJournalEntryInputSchema, 'space_guide.put': putChangeGuideInputSchema,
  'space_guide.markRead': markGuideSectionReadInputSchema, 'space_review.create': createReviewThreadInputSchema,
  'space_review.append': appendReviewMessageInputSchema, 'space_review.resolve': resolveReviewThreadInputSchema,
};

/** Cloud authority operations, never an executable JavaScript namespace. */
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
  if (method === 'describe') {
    const operation = z.string().min(1).parse(payload.operation);
    const schema = schemas[`${input.tool}.${operation}` as keyof typeof schemas];
    if (!schema) throw new Error('No agent mutation schema for this operation');
    const json = z.toJSONSchema(schema);
    const { projectId: ignoredProject, spaceId: ignoredSpace, ...properties } = json.properties ?? {};
    return { ...json, properties: { ...properties, workspaceId: { type: 'string' } }, required: json.required?.filter(field => field !== 'projectId' && field !== 'spaceId') };
  }
  await context.bootstrap(owned);
  const reviewContext = rawContext === undefined ? undefined : reviewAnchorContextSchema.parse(rawContext);
  const actorId = `conversation:${input.conversationId}`;
  const publish = async <T extends { id?: string; revision?: number; sequence?: number }>(entity: string, value: T, operation: 'updated' | 'append' | 'created' = 'updated') => {
    await authority.appendEvent({ eventId: `runtime:${input.attemptId}:${key}`, scope: 'workspace', entity,
      entityId: value.id ?? target, revision: value.revision ?? value.sequence ?? Date.now(), operation, payload: { spaceId: target } });
    return value;
  };
  const args = { ...payload, ...owned };
  switch (key) {
    case 'space_goal.get': return context.getGoal(owned);
    case 'space_goal.put': return publish('goal', await context.putGoal(putGoalInputSchema.parse(args)));
    case 'space_goal.attachEvidence': return publish('goal', await context.attachRequirementEvidence(attachRequirementEvidenceInputSchema.parse(args)));
    case 'space_workflow.get': return context.getWorkflow(owned);
    case 'space_workflow.put': return publish('workflow', await context.putWorkflow(putWorkflowInputSchema.parse(args)));
    case 'space_rubric.get': return context.getRubric(owned);
    case 'space_rubric.put': return publish('rubric', await context.putRubric(putRubricInputSchema.parse(args)));
    case 'space_journal.list': return context.listJournal(owned);
    case 'space_journal.startPhase': return publish('journal', await context.startJournalPhase(startJournalPhaseInputSchema.parse(args)), 'created');
    case 'space_journal.endPhase': return publish('journal', await context.endJournalPhase(endJournalPhaseInputSchema.parse(args)));
    case 'space_journal.append': return publish('journal', await context.appendJournalEntry(appendJournalEntryInputSchema.parse(args)), 'append');
    case 'space_guide.get': return context.getChangeGuide(owned);
    case 'space_guide.put': return publish('change-guide', await context.putChangeGuide(putChangeGuideInputSchema.parse(args)));
    case 'space_guide.markRead': return publish('change-guide', await context.markGuideSectionRead(markGuideSectionReadInputSchema.parse({ ...args, reviewerId: actorId })));
    case 'space_review.list': return context.listReviewThreads(owned, reviewContext);
    case 'space_review.create': return publish('review-thread', await context.createReviewThread(createReviewThreadInputSchema.parse(args), reviewContext), 'created');
    case 'space_review.append': return publish('review-thread', await context.appendReviewMessage(appendReviewMessageInputSchema.parse(args), reviewContext), 'append');
    case 'space_review.resolve': return publish('review-thread', await context.resolveReviewThread(resolveReviewThreadInputSchema.parse(args), reviewContext));
    default: throw new Error('Unknown workspace authority operation');
  }
}
