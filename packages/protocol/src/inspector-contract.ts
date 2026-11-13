import { wire } from './json-wire.js'
import { z } from 'zod';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from './project-authority.js';
import { WorkspacePhaseSchema } from '@gitspace/protocol-workspace';
import { RuntimeDispatchSelectionSchema } from '@gitspace/protocol-runtime';
import { AutomationDraftSchema, AutomationSubjectRefSchema } from './automations-contract.js';

export const INSPECTOR_EVIDENCE_HISTORY_LIMIT = 20 as const;

const idSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const textSchema = z.string().trim().min(1).max(16_384);
const shortTextSchema = z.string().trim().min(1).max(512);
const isoDateSchema = z.iso.datetime();
const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const artifactHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const repositoryPathSchema = z.string().min(1).max(4_096).refine(
  (path) => !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git'),
  'Repository path must be a portable path inside the repository',
);
const revisionSchema = z.number().int().positive();
const generationSchema = z.number().int().nonnegative();

export const inspectorIdentitySchema = z.object({
  projectId: idSchema,
  spaceId: idSchema,
}).strict();
export type InspectorIdentity = z.infer<typeof inspectorIdentitySchema>;

const evidenceLabel = shortTextSchema.describe('What the evidence shows, in a few words.');
const evidenceGeneration = generationSchema.describe('The workspace generation the evidence was taken at.');
export const artifactEvidenceReferenceSchema = z.object({
  kind: z.literal('artifact').describe('A drive artifact.'),
  url: z.string().min(1).max(4_096).describe('The artifact\'s drive:// URL.'),
  hash: artifactHashSchema.describe('The artifact\'s sha256:… hash.'),
  generation: evidenceGeneration,
  label: evidenceLabel,
  mediaType: z.string().trim().min(1).max(255).nullable().describe('Its media type, such as image/png; null when unknown.'),
}).strict();
export const gitEvidenceReferenceSchema = z.object({
  kind: z.literal('git').describe('A file in the repository.'),
  generation: evidenceGeneration,
  path: repositoryPathSchema.describe('Repository path of the file.'),
  blobId: gitObjectIdSchema.nullable().describe('The file\'s blob id; null when it was deleted.'),
  commitId: gitObjectIdSchema.describe('Commit holding that version.'),
  label: evidenceLabel,
}).strict();
export const commandEvidenceReferenceSchema = z.object({
  kind: z.literal('command').describe('A command run.'),
  runId: idSchema.describe('The run\'s id.'),
  command: z.string().trim().min(1).max(8_192).describe('The command line.'),
  exitCode: z.number().int().describe('Its exit code.'),
  artifactUrl: z.string().min(1).max(4_096).nullable().describe('drive:// URL of its saved output, with artifactHash; null for none.'),
  artifactHash: artifactHashSchema.nullable().describe('sha256:… hash of the saved output, with artifactUrl; null for none.'),
  generation: evidenceGeneration,
  label: evidenceLabel,
}).strict().superRefine((reference, context) => {
  if ((reference.artifactUrl === null) !== (reference.artifactHash === null)) {
    context.addIssue({ code: 'custom', message: 'Command evidence artifact URL and hash must be supplied together' });
  }
});
export const reviewEvidenceReferenceSchema = z.object({
  kind: z.literal('review-thread').describe('A review thread.'),
  threadId: idSchema.describe('The thread.'),
  messageId: idSchema.nullable().describe('One message of it; null for the whole thread.'),
  label: evidenceLabel,
}).strict();
export const evidenceReferenceSchema = z.discriminatedUnion('kind', [
  artifactEvidenceReferenceSchema,
  gitEvidenceReferenceSchema,
  commandEvidenceReferenceSchema,
  reviewEvidenceReferenceSchema,
]);
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const requirementStatusSchema = z.enum(['missing', 'review', 'accepted']);
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

export const goalRequirementSchema = z.object({
  id: idSchema.describe('The requirement\'s id, unique in the goal.'),
  title: shortTextSchema.describe('The requirement, in one line.'),
  description: z.string().trim().max(8_192).describe('What meeting it means, in detail.'),
  required: z.boolean().describe('Whether the goal needs it; false for a nice-to-have.'),
  status: requirementStatusSchema.describe('missing, review (evidence attached, waiting for a person) or accepted (a person accepted it; agents never set it).'),
  workflowNodeId: idSchema.nullable().describe('The workflow node that delivers it; null for none.'),
  criterionId: idSchema.nullable().describe('The rubric criterion that judges it; null for none.'),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT).describe('Evidence that it is met, newest last.'),
  /** The device of the person who accepted the requirement; null after they reopen it, absent if no person ever did. */
  acceptedBy: idSchema.nullable().optional().describe('Who accepted it; set by a person, never by an agent.'),
  acceptedAt: isoDateSchema.nullable().optional().describe('When it was accepted; set by a person, never by an agent.'),
}).strict();
export type GoalRequirement = z.infer<typeof goalRequirementSchema>;

const orderedUnique = <T extends { id: string }>(items: T[]): boolean => new Set(items.map((item) => item.id)).size === items.length;
/** Who last changed a record: an agent writes its own name or conversation. */
const updatedBySchema = idSchema.describe('Who is making this change.');

export const goalRecordViewSchema = inspectorIdentitySchema.extend({
  id: idSchema.describe('The goal\'s id.'),
  revision: revisionSchema,
  title: shortTextSchema.describe('The goal, in one line.'),
  summary: z.string().trim().max(16_384).describe('What the workspace sets out to do, in Markdown.'),
  phase: z.enum(['plan', 'code', 'review', 'ship']).describe('The workspace phase the goal is in.'),
  requirements: z.array(goalRequirementSchema).max(512).refine(orderedUnique, 'Requirement ids must be unique').describe('What must be true for the goal to be met.'),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  updatedBy: updatedBySchema,
}).strict();
export type GoalRecordView = z.infer<typeof goalRecordViewSchema>;

export const goalDraftSchema = goalRecordViewSchema.omit({
  projectId: true,
  spaceId: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
});
export type GoalDraft = z.infer<typeof goalDraftSchema>;
/** A goal as an agent writes it: the host records who changed it. */
export const goalAgentDraftSchema = goalDraftSchema.omit({ updatedBy: true });

export const workflowGateWaiverSchema = z.object({
  id: idSchema.describe('The waiver\'s id.'),
  reason: textSchema.describe('Why the gate was waived.'),
  actorId: idSchema.describe('Who waived it.'),
  actorKind: z.enum(['human', 'client']).describe('human: a person; client: an authenticated client acting for one.'),
  createdAt: isoDateSchema.describe('When it was waived.'),
}).strict();
export type WorkflowGateWaiver = z.infer<typeof workflowGateWaiverSchema>;

const workflowNodeBaseSchema = z.object({
  id: idSchema.describe('The node\'s id, unique in the workflow.'),
  label: shortTextSchema.describe('The node\'s name, as the workflow map shows it.'),
  position: z.object({ x: z.number().finite().describe('Horizontal position on the map.'), y: z.number().finite().describe('Vertical position on the map.') }).strict().describe('Where the map draws the node.'),
}).strict();
export const workflowPhaseNodeSchema = workflowNodeBaseSchema.extend({
  kind: z.literal('phase').describe('A phase of work.'),
  status: z.enum(['pending', 'running', 'complete', 'reverted']).describe('pending, running, complete or reverted.'),
  role: z.string().trim().max(160).nullable().describe('Who does it, such as an agent definition; null for anyone.'),
  reads: z.array(shortTextSchema).max(128).describe('What it reads: inputs, artifacts or files.'),
  writes: z.array(shortTextSchema).max(128).describe('What it writes.'),
}).strict();
export const workflowArtifactNodeSchema = workflowNodeBaseSchema.extend({
  kind: z.literal('artifact').describe('Something the work produces.'),
  status: z.enum(['missing', 'available']).describe('missing until produced, then available.'),
  evidence: evidenceReferenceSchema.nullable().describe('Where the artifact is; null while missing.'),
}).strict();
export const workflowGateNodeSchema = workflowNodeBaseSchema.extend({
  kind: z.literal('gate').describe('A gate a person passes, when its requirements are met, or waives.'),
  requirementIds: z.array(idSchema).max(512).describe('Goal requirements the gate waits for.'),
  satisfied: z.boolean().describe('Whether its requirements are met.'),
  passable: z.boolean().describe('Whether work may pass it: satisfied or waived.'),
  waivers: z.array(workflowGateWaiverSchema).describe('Waivers people granted.'),
}).strict();
export const workflowNodeSchema = z.discriminatedUnion('kind', [workflowPhaseNodeSchema, workflowArtifactNodeSchema, workflowGateNodeSchema]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z.object({
  id: idSchema.describe('The edge\'s id, unique in the workflow.'),
  from: idSchema.describe('The node it starts at.'),
  to: idSchema.describe('The node it leads to.'),
  kind: z.enum(['control', 'data']).describe('control: order of work; data: what flows from one node to the next.'),
  label: z.string().trim().max(512).nullable().describe('What the edge carries; null for none.'),
}).strict();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

const workflowTitle = shortTextSchema.describe('The workflow, in one line.');
const workflowDescription = z.string().trim().max(16_384).describe('How the work proceeds, in Markdown.');
export const workflowViewSchema = inspectorIdentitySchema.extend({
  id: idSchema.describe('The workflow\'s id.'),
  revision: revisionSchema,
  title: workflowTitle,
  description: workflowDescription,
  nodes: z.array(workflowNodeSchema).max(512),
  edges: z.array(workflowEdgeSchema).max(2_048),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  updatedBy: updatedBySchema,
}).strict().superRefine((workflow, context) => {
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) context.addIssue({ code: 'custom', path: ['nodes'], message: `Duplicate workflow node ${node.id}` });
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) context.addIssue({ code: 'custom', path: ['edges'], message: `Duplicate workflow edge ${edge.id}` });
    edgeIds.add(edge.id);
    if (!ids.has(edge.from) || !ids.has(edge.to)) context.addIssue({ code: 'custom', path: ['edges'], message: `Workflow edge ${edge.id} has a missing endpoint` });
  }
});
export type WorkflowView = z.infer<typeof workflowViewSchema>;

const workflowDraftShape = z.object({
  id: idSchema.describe('The workflow\'s id.'),
  title: workflowTitle,
  description: workflowDescription,
  nodes: z.array(z.discriminatedUnion('kind', [
    workflowPhaseNodeSchema,
    workflowArtifactNodeSchema,
    workflowGateNodeSchema.omit({ satisfied: true, passable: true, waivers: true }),
  ])).max(512).describe('The workflow\'s phases, artifacts and gates.'),
  edges: z.array(workflowEdgeSchema).max(2_048).describe('How the nodes connect.'),
  updatedBy: updatedBySchema,
}).strict();
/** A workflow's node and edge ids are unique, and every edge joins two of its nodes. */
function checkWorkflowDraft(workflow: Pick<z.infer<typeof workflowDraftShape>, 'nodes' | 'edges'>, context: z.RefinementCtx): void {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  if (nodeIds.size !== workflow.nodes.length) context.addIssue({ code: 'custom', path: ['nodes'], message: 'Workflow node ids must be unique' });
  const edgeIds = new Set(workflow.edges.map((edge) => edge.id));
  if (edgeIds.size !== workflow.edges.length) context.addIssue({ code: 'custom', path: ['edges'], message: 'Workflow edge ids must be unique' });
  for (const edge of workflow.edges) if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) context.addIssue({ code: 'custom', path: ['edges'], message: `Workflow edge ${edge.id} has a missing endpoint` });
}
export const workflowDraftSchema = workflowDraftShape.superRefine(checkWorkflowDraft);
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
/** A workflow as an agent writes it: the host records who changed it. */
export const workflowAgentDraftSchema = workflowDraftShape.omit({ updatedBy: true }).superRefine(checkWorkflowDraft);

export const rubricJudgeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human').describe('A person judges it.') }).strict(),
  z.object({ kind: z.literal('llm').describe('A model judges it.'), model: z.string().trim().min(1).max(255).nullable().describe('The model; the default judge model when null.') }).strict(),
  z.object({
    kind: z.literal('command').describe('A command judges it.'),
    command: z.string().trim().min(1).max(8_192).describe('The command line to run.'),
    expectation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('exit-zero').describe('It passes when the command exits 0.') }).strict(),
      z.object({ kind: z.literal('stdout-contains').describe('It passes when standard output contains value.'), value: z.string().min(1).max(4_096).describe('Text standard output must contain.') }).strict(),
      z.object({ kind: z.literal('stderr-empty').describe('It passes when standard error is empty.') }).strict(),
      z.object({ kind: z.literal('output-matches').describe('It passes when the output matches pattern.'), pattern: z.string().min(1).max(4_096).describe('Regex the output must match.') }).strict(),
    ]).describe('What the command\'s run must show to pass.'),
  }).strict(),
]).describe('Who or what judges the criterion.');
export type RubricJudge = z.infer<typeof rubricJudgeSchema>;

const judgmentBaseSchema = z.object({
  id: idSchema.describe('The judgment\'s id.'),
  verdict: z.enum(['pass', 'fail']).describe('pass or fail.'),
  summary: textSchema.describe('Why, in a few sentences.'),
  actorId: idSchema.describe('Who judged.'),
  /** Authenticated submitting principal; absent only on older persisted judgments. */
  actorKind: z.enum(['human', 'client', 'agent']).optional().describe('human, client or agent.'),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT).describe('What the verdict rests on.'),
  createdAt: isoDateSchema.describe('When it was judged.'),
}).strict();
export const humanJudgmentSchema = judgmentBaseSchema.extend({ kind: z.literal('human').describe('A person\'s judgment.') }).strict();
export const llmJudgmentSchema = judgmentBaseSchema.extend({
  kind: z.literal('llm').describe('A model\'s judgment.'),
  model: z.string().trim().min(1).max(255).describe('The model that judged.'),
}).strict();
export const commandJudgmentSchema = judgmentBaseSchema.extend({
  kind: z.literal('command').describe('A command\'s judgment.'),
  command: z.string().trim().min(1).max(8_192).describe('The command that ran.'),
  runId: idSchema.describe('Its run.'),
  exitCode: z.number().int().describe('Its exit code.'),
}).strict();
export const rubricJudgmentSchema = z.discriminatedUnion('kind', [humanJudgmentSchema, llmJudgmentSchema, commandJudgmentSchema]);
export type RubricJudgment = z.infer<typeof rubricJudgmentSchema>;

export const rubricCriterionSchema = z.object({
  id: idSchema.describe('The criterion\'s id, unique in the rubric.'),
  title: shortTextSchema.describe('The criterion, in one line.'),
  description: textSchema.describe('What passing means, in detail.'),
  workflowNodeId: idSchema.nullable().describe('The workflow node it judges; null for none.'),
  requirementIds: z.array(idSchema).max(512).describe('Goal requirements it judges.'),
  judge: rubricJudgeSchema,
  status: z.enum(['pending', 'passed', 'failed']).describe('pending, passed or failed, from its latest judgment.'),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT).describe('Evidence for its judge.'),
  judgments: z.array(rubricJudgmentSchema).describe('Its judgments, oldest first.'),
}).strict();
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>;

const rubricTitle = shortTextSchema.describe('The rubric, in one line.');
const rubricDescription = z.string().trim().max(16_384).describe('What the rubric judges, in Markdown.');
export const rubricViewSchema = inspectorIdentitySchema.extend({
  id: idSchema.describe('The rubric\'s id.'),
  revision: revisionSchema,
  title: rubricTitle,
  description: rubricDescription,
  criteria: z.array(rubricCriterionSchema).max(512).refine(orderedUnique, 'Criterion ids must be unique').describe('The criteria the work is judged by.'),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  updatedBy: updatedBySchema,
}).strict();
export type RubricView = z.infer<typeof rubricViewSchema>;

export const rubricDraftSchema = z.object({
  id: idSchema.describe('The rubric\'s id.'),
  title: rubricTitle,
  description: rubricDescription,
  criteria: z.array(rubricCriterionSchema.omit({ status: true, judgments: true })).max(512).refine(orderedUnique, 'Criterion ids must be unique').describe('The criteria the work is judged by.'),
  updatedBy: updatedBySchema,
}).strict();
export type RubricDraft = z.infer<typeof rubricDraftSchema>;
/** A rubric as an agent writes it: the host records who changed it. */
export const rubricAgentDraftSchema = rubricDraftSchema.omit({ updatedBy: true });

export const journalStateSnapshotSchema = z.object({
  generation: generationSchema,
  headCommit: gitObjectIdSchema,
  goalRevision: revisionSchema.nullable(),
  requirementStatuses: z.record(idSchema, requirementStatusSchema),
  workflowRevision: revisionSchema.nullable(),
  workflowNodeStatuses: z.record(idSchema, z.string().min(1).max(64)),
  rubricRevision: revisionSchema.nullable(),
  openReviewThreads: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string().min(1).max(4_096)),
  capturedAt: isoDateSchema,
}).strict();
export type JournalStateSnapshot = z.infer<typeof journalStateSnapshotSchema>;

export const journalDeltaSchema = z.object({
  requirementsAdvanced: z.array(z.object({ id: idSchema, from: requirementStatusSchema.nullable(), to: requirementStatusSchema }).strict()),
  evidenceAdded: z.array(z.string().min(1).max(4_096)),
  workflowNodesChanged: z.array(z.object({ id: idSchema, from: z.string().max(64).nullable(), to: z.string().min(1).max(64) }).strict()),
  threadsResolved: z.number().int().nonnegative(),
  canonChanged: z.array(z.enum(['goal', 'workflow', 'rubric'])),
  generationChanged: z.boolean(),
  headChanged: z.boolean(),
}).strict();
export type JournalDelta = z.infer<typeof journalDeltaSchema>;

export const journalCitationSchema = z.object({
  conversationId: idSchema.describe('The conversation quoted.'),
  messageId: idSchema.describe('The message quoted.'),
  who: shortTextSchema.describe('Who said it.'),
  at: isoDateSchema.describe('When they said it.'),
  quote: z.string().trim().max(4_096).describe('The words quoted.'),
}).strict();
export type JournalCitation = z.infer<typeof journalCitationSchema>;
/** What a decision rests on: the conversation messages it quotes, the guide section it belongs to, and the earlier
 * decision entry it replaces. */
const journalDecisionFields = {
  citations: z.array(journalCitationSchema).max(32).optional().describe('Messages the decision rests on, quoted.'),
  sectionId: idSchema.optional().describe('The Change Guide section the decision belongs to.'),
  supersedes: idSchema.optional().describe('An earlier decision entry this one replaces.'),
};

export const journalEntryViewSchema = inspectorIdentitySchema.extend({
  id: idSchema,
  sequence: z.number().int().positive(),
  kind: z.enum(['phase-start', 'phase-end', 'narrative', 'decision', 'artifact']),
  phaseRunId: idSchema.nullable(),
  phase: z.string().trim().min(1).max(160),
  title: shortTextSchema,
  body: z.string().trim().max(32_768),
  outcome: z.string().trim().max(32_768).nullable(),
  decisions: z.array(textSchema).max(256),
  surprises: z.array(textSchema).max(256),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT),
  snapshot: journalStateSnapshotSchema.nullable(),
  delta: journalDeltaSchema.nullable(),
  reverted: z.object({ reason: textSchema, to: z.string().trim().min(1).max(160) }).strict().nullable(),
  createdAt: isoDateSchema,
  createdBy: idSchema,
  ...journalDecisionFields,
}).strict();
export type JournalEntryView = z.infer<typeof journalEntryViewSchema>;

export const changeGuideExhibitRangeSchema = z.object({
  start: z.number().int().min(1).describe('First line, one-based.'),
  end: z.number().int().min(1).describe('Last line, at or after start.'),
  note: z.string().trim().max(2_048).optional().describe('What these lines do.'),
}).strict().refine((range) => range.end >= range.start, { message: 'Exhibit range end precedes its start', path: ['end'] });
export const changeGuideExhibitSchema = z.object({
  path: repositoryPathSchema.describe('Repository path of the file.'),
  blobId: gitObjectIdSchema.nullable().describe('The file\'s blob at the guide\'s head commit; null when the change deletes it.'),
  note: z.string().trim().max(4_096).describe('What the reviewer should see in it.'),
  slowRead: z.boolean().describe('Whether the reviewer should read it line by line rather than skim it.'),
  ranges: z.array(changeGuideExhibitRangeSchema).max(64).optional().describe('Line ranges to show; the file\'s whole change when omitted.'),
}).strict();
export const changeGuideSectionSchema = z.object({
  id: idSchema.describe('The section\'s id, unique in the guide.'),
  title: shortTextSchema.describe('The section, in one line.'),
  kind: z.enum(['decision', 'behavior', 'risk', 'mechanical']).describe('What the section explains: a decision, a change of behavior, a risk, or mechanical churn.'),
  explanation: textSchema.describe('What changed and how, in Markdown.'),
  why: z.string().trim().max(16_384).describe('Why it changed.'),
  exhibits: z.array(changeGuideExhibitSchema).max(256).describe('Files to read for this section, in reading order.'),
  requirementIds: z.array(idSchema).max(512).describe('Goal requirements the section delivers.'),
  contentHash: z.string().regex(/^[a-f0-9]{12}$/u).optional().describe('12 hex characters hashing the section\'s content; a revision with the same hash shows the section unchanged.'),
  journalEntryIds: z.array(idSchema).max(256).optional().describe('Journal entries the section draws on.'),
  callouts: z.array(z.object({ tone: z.enum(['risk', 'mechanical', 'decision']).describe('risk, mechanical or decision.'), text: textSchema.describe('The note.') }).strict()).max(64).optional().describe('Short notes the reviewer must not miss.'),
  asks: z.array(shortTextSchema).max(64).optional().describe('Questions for the reviewer.'),
  summary: z.string().trim().max(4_096).optional().describe('The section in a sentence or two.'),
  readersGuide: z.string().trim().max(8_192).optional().describe('How to read the section\'s exhibits.'),
  /** Markdown holding one block fence. */
  diagram: z.string().trim().max(65_536).optional().describe('Markdown holding one diagram block: mermaid, svg or gitspace-ui.'),
  evidence: z.array(evidenceReferenceSchema).max(64).optional().describe('Evidence for the section: runs, captures, files.'),
}).strict();
export type ChangeGuideSection = z.infer<typeof changeGuideSectionSchema>;

/** The change as areas of the codebase and the paths between them, walked in steps that each belong to a guide section.
 * It carries no layout: GitSpace places the areas. */
export const changeMapSchema = z.object({
  areas: z.array(z.object({
    id: idSchema.describe('The area\'s id, unique in the map.'),
    name: shortTextSchema.describe('The area\'s name.'),
    package: shortTextSchema.describe('The package it is in.'),
    role: z.string().trim().max(512).describe('Its role in the change.'),
    whatItDoes: z.string().trim().max(2_048).describe('What it does, in a sentence or two.'),
    files: z.array(repositoryPathSchema).max(256).describe('Its files the change touches.'),
    note: z.string().trim().max(1_024).optional().describe('Anything else a reader should know.'),
  }).strict()).max(64).describe('Areas of the codebase the change touches.'),
  paths: z.array(z.object({
    id: idSchema.describe('The path\'s id, unique in the map.'),
    from: idSchema.describe('The area it starts at.'),
    to: idSchema.describe('The area it leads to.'),
    label: z.string().trim().max(160).describe('What flows along it.'),
    state: z.enum(['added', 'removed', 'same']).describe('Whether the change adds it, removes it, or keeps it.'),
  }).strict()).max(128).describe('Calls or data flows between areas.'),
  steps: z.array(z.object({
    paths: z.array(idSchema).min(1).max(128).describe('The paths the step walks.'),
    from: idSchema.describe('The area it starts at.'),
    to: idSchema.describe('The area it ends at.'),
    caption: z.string().trim().max(1_024).describe('What happens in this step.'),
    sectionId: idSchema.describe('The guide section the step belongs to.'),
  }).strict()).max(32).describe('The walk through the map, step by step.'),
}).strict().superRefine((map, context) => {
  const areaIds = new Set(map.areas.map((area) => area.id));
  if (areaIds.size !== map.areas.length) context.addIssue({ code: 'custom', path: ['areas'], message: 'Change map area ids must be unique' });
  const pathIds = new Set(map.paths.map((path) => path.id));
  if (pathIds.size !== map.paths.length) context.addIssue({ code: 'custom', path: ['paths'], message: 'Change map path ids must be unique' });
  const requireArea = (areaId: string, path: (string | number)[]) => {
    if (!areaIds.has(areaId)) context.addIssue({ code: 'custom', path, message: `Change map names a missing area ${areaId}` });
  };
  for (const [index, path] of map.paths.entries()) {
    requireArea(path.from, ['paths', index, 'from']);
    requireArea(path.to, ['paths', index, 'to']);
  }
  for (const [index, step] of map.steps.entries()) {
    requireArea(step.from, ['steps', index, 'from']);
    requireArea(step.to, ['steps', index, 'to']);
    for (const [pathIndex, pathId] of step.paths.entries()) {
      if (!pathIds.has(pathId)) context.addIssue({ code: 'custom', path: ['steps', index, 'paths', pathIndex], message: `Change map step names a missing path ${pathId}` });
    }
  }
});
export type ChangeMap = z.infer<typeof changeMapSchema>;

/** A guide's opening, its captured evidence, and its map. */
const changeGuideNarrativeFields = {
  intro: z.string().trim().max(16_384).optional().describe('The guide\'s opening, in Markdown.'),
  captures: z.array(evidenceReferenceSchema).max(64).optional().describe('Screenshots, videos or browser captures shown with the intro.'),
  map: changeMapSchema.optional().describe('The change as areas of the codebase and the paths between them.'),
};

/** What an intro capture shows. */
export type GuideCaptureKind = 'image' | 'video' | 'browser-capture';
const VISUAL_EXTENSIONS: Readonly<Record<string, GuideCaptureKind>> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
};
const BROWSER_CAPTURE_URL = /^(drive:\/\/[^/]+\/browser\/captures\/[^/]+)(?:\/(?:capture\.json)?)?$/u;

/** The drive folder (`drive://<mount>/browser/captures/<id>`) a browser capture reference names, by its folder or its
 * `capture.json`; null for any other address. */
export function browserCaptureFolder(url: string): string | null {
  return BROWSER_CAPTURE_URL.exec(url)?.[1] ?? null;
}

/** What an intro capture shows: an image or a video by its media type (else its extension), or a browser capture; null
 * for anything else, which belongs in a section's evidence instead. */
export function guideCaptureKind(reference: EvidenceReference): GuideCaptureKind | null {
  if (reference.kind !== 'artifact') return null;
  if (browserCaptureFolder(reference.url)) return 'browser-capture';
  if (reference.mediaType?.startsWith('image/')) return 'image';
  if (reference.mediaType?.startsWith('video/')) return 'video';
  if (reference.mediaType) return null;
  return VISUAL_EXTENSIONS[reference.url.split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? ''] ?? null;
}

/** A map step belongs to a section of the same guide. */
function refineGuideMapSections(guide: { sections: ChangeGuideSection[]; map?: ChangeMap }, context: z.RefinementCtx): void {
  if (guide.map === undefined) return;
  const sectionIds = new Set(guide.sections.map((section) => section.id));
  for (const [index, step] of guide.map.steps.entries()) {
    if (!sectionIds.has(step.sectionId)) context.addIssue({ code: 'custom', path: ['map', 'steps', index, 'sectionId'], message: `Change map step names a missing section ${step.sectionId}` });
  }
}

export const changeGuideReviewerStateSchema = z.object({
  reviewerId: idSchema,
  revision: revisionSchema,
  headCommit: gitObjectIdSchema,
  readSectionIds: z.array(idSchema),
  decision: z.enum(['pending', 'approved', 'changes-requested']),
  note: z.string().trim().max(8_192).nullable(),
  updatedAt: isoDateSchema,
}).strict();
export type ChangeGuideReviewerState = z.infer<typeof changeGuideReviewerStateSchema>;

export const changeGuideViewSchema = inspectorIdentitySchema.extend({
  revision: revisionSchema,
  headCommit: gitObjectIdSchema,
  baseRef: z.string().trim().min(1).max(512),
  /** The merge base of `baseRef` and `headCommit`, which the guide's diffs compare against; null on revisions written
   * before guides recorded it (regenerate them to show their diffs). */
  baseCommit: gitObjectIdSchema.nullable(),
  title: shortTextSchema,
  sections: z.array(changeGuideSectionSchema).max(512).refine(orderedUnique, 'Change Guide section ids must be unique'),
  reviewerStates: z.array(changeGuideReviewerStateSchema),
  createdAt: isoDateSchema,
  createdBy: idSchema,
  ...changeGuideNarrativeFields,
}).strict().superRefine(refineGuideMapSections);
export type ChangeGuideView = z.infer<typeof changeGuideViewSchema>;

/** One stored revision of a workspace's Change Guide, as its revision picker lists it. `readerIds`: the reviewers who
 * marked at least one of its sections read. */
export const changeGuideRevisionSummarySchema = z.object({
  revision: revisionSchema,
  headCommit: gitObjectIdSchema,
  baseRef: z.string().trim().min(1).max(512),
  baseCommit: gitObjectIdSchema.nullable(),
  title: shortTextSchema,
  createdAt: isoDateSchema,
  createdBy: idSchema,
  sectionCount: z.number().int().nonnegative(),
  readerIds: z.array(idSchema),
}).strict();
export type ChangeGuideRevisionSummary = z.infer<typeof changeGuideRevisionSummarySchema>;

/** A shared Change Guide as its public viewer reads it: the guide pinned at one revision, its repository, the merge
 * base its diffs compare against, and its introduction and map (absent on links shared before guides had them). Its
 * captures stay in the workspace's drive. */
export const sharedGuideSchema = z.object({
  repository: z.string().trim().min(1).max(512),
  title: shortTextSchema,
  baseRef: z.string().trim().min(1).max(512),
  baseCommit: gitObjectIdSchema,
  headCommit: gitObjectIdSchema,
  sections: z.array(changeGuideSectionSchema).max(512),
  sharedAt: isoDateSchema,
  intro: changeGuideNarrativeFields.intro,
  map: changeGuideNarrativeFields.map,
}).strict();
export type SharedGuide = z.infer<typeof sharedGuideSchema>;
/** Why a shared guide is not shown: sign in with GitHub first, or the signed-in reader cannot read the repository. */
export const sharedGuideDeniedSchema = z.object({
  denied: z.enum(['sign-in', 'no-access']),
  repository: z.string(),
  signIn: z.string().nullable(),
  login: z.string().nullable(),
}).strict();
export type SharedGuideDenied = z.infer<typeof sharedGuideDeniedSchema>;

const changeGuideDraftShape = z.object({
  headCommit: gitObjectIdSchema.describe('The commit the guide explains.'),
  baseRef: z.string().trim().min(1).max(512).describe('The branch the change goes into, such as main.'),
  /** `git merge-base <baseRef> <headCommit>`, computed where the full history is: the guide's diffs compare against it. */
  baseCommit: gitObjectIdSchema.describe('git merge-base of baseRef and headCommit: the guide\'s diffs compare against it.'),
  title: shortTextSchema.describe('The change, in one line.'),
  sections: z.array(changeGuideSectionSchema).max(512).refine(orderedUnique, 'Change Guide section ids must be unique').describe('The guide\'s sections, in reading order.'),
  createdBy: idSchema.describe('Who wrote this revision.'),
  ...changeGuideNarrativeFields,
}).strict();
export const changeGuideDraftSchema = changeGuideDraftShape.superRefine(refineGuideMapSections);
export type ChangeGuideDraft = z.infer<typeof changeGuideDraftSchema>;
/** A guide as an agent writes it: the host records who wrote it. */
export const changeGuideAgentDraftSchema = changeGuideDraftShape.omit({ createdBy: true }).superRefine(refineGuideMapSections);

export const changeGuideWorksheetClusterSchema = z.object({
  id: idSchema,
  contentHash: z.string().regex(/^[a-f0-9]{12}$/u),
  kind: z.enum(['core', 'data-model', 'surface', 'tests', 'sweep', 'supporting']),
  files: z.array(repositoryPathSchema).min(1).max(2_048),
  order: z.number().int().positive(),
  readingCost: z.number().nonnegative(),
  stale: z.boolean(),
  beat: z.object({ component: z.number().int().positive(), sequence: z.number().int().positive(), total: z.number().int().positive() }).strict().nullable(),
  journal: z.array(z.object({
    entryId: idSchema,
    phase: z.string().trim().max(128).nullable(),
    title: shortTextSchema,
    body: textSchema,
    outcome: z.string().trim().max(16_384).nullable(),
    decisions: z.array(textSchema).max(256),
    requirementsAdvanced: z.array(idSchema).max(512),
  }).strict()).max(512),
  cachedSection: changeGuideSectionSchema.nullable(),
}).strict();
export type ChangeGuideWorksheetCluster = z.infer<typeof changeGuideWorksheetClusterSchema>;

export const changeGuideWorksheetSchema = inspectorIdentitySchema.extend({
  headCommit: gitObjectIdSchema,
  baseRef: z.string().trim().min(1).max(512),
  guideRevision: z.number().int().nonnegative(),
  clusters: z.array(changeGuideWorksheetClusterSchema).max(2_048),
  covered: z.boolean(),
}).strict();
export type ChangeGuideWorksheet = z.infer<typeof changeGuideWorksheetSchema>;

const anchorPath = repositoryPathSchema.describe('Repository path of the file.');
const anchorGeneration = generationSchema.describe('The workspace generation the anchor was made at.');
const anchorBlob = gitObjectIdSchema.nullable().describe('The file\'s blob; null when it was deleted.');
const anchorBase = gitObjectIdSchema.describe('The diff\'s base commit.');
const anchorHead = gitObjectIdSchema.describe('The diff\'s head commit.');
export const reviewAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace').describe('The whole workspace.') }).strict(),
  z.object({
    kind: z.literal('file').describe('A whole file.'), path: anchorPath, generation: anchorGeneration,
    commitId: gitObjectIdSchema.describe('Commit holding that version of the file.'), blobId: anchorBlob,
  }).strict(),
  z.object({
    kind: z.literal('line').describe('Lines of a diff.'), path: anchorPath, generation: anchorGeneration,
    baseCommit: anchorBase, headCommit: anchorHead, blobId: anchorBlob,
    side: z.enum(['base', 'head']).describe('Which side of the diff the lines are on.'), startLine: z.number().int().positive().describe('First line, one-based.'), endLine: z.number().int().positive().describe('Last line, at or after startLine.'),
  }).strict().refine((anchor) => anchor.endLine >= anchor.startLine, 'Review line range is inverted'),
  z.object({
    kind: z.literal('hunk').describe('One hunk of a diff.'), path: anchorPath, generation: anchorGeneration,
    baseCommit: anchorBase, headCommit: anchorHead, hunkHeader: z.string().trim().startsWith('@@').max(1_024).describe('The hunk\'s @@ header line.'),
  }).strict(),
  z.object({
    kind: z.literal('artifact').describe('A drive artifact.'), url: z.string().min(1).max(4_096).describe('The artifact\'s drive:// URL.'), hash: artifactHashSchema.describe('The artifact\'s sha256:… hash.'), generation: anchorGeneration,
  }).strict(),
  /** A comment on a step of the workspace's plan (the runtime's plan step id). */
  z.object({ kind: z.literal('plan-step').describe('A step of the workspace\'s plan.'), stepId: z.string().trim().min(1).max(64).describe('The plan step\'s id.') }).strict(),
]).describe('What the thread is about.');
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;

export const reviewMessageViewSchema = z.object({
  id: idSchema.describe('The message\'s id.'),
  authorId: idSchema.describe('Who wrote it.'),
  body: textSchema.describe('The message, in Markdown.'),
  createdAt: isoDateSchema,
}).strict();
export type ReviewMessageView = z.infer<typeof reviewMessageViewSchema>;

export const reviewThreadViewSchema = inspectorIdentitySchema.extend({
  id: idSchema,
  revision: revisionSchema,
  anchor: reviewAnchorSchema,
  anchorState: z.enum(['current', 'stale']),
  staleReason: z.string().trim().max(1_024).nullable(),
  decision: z.enum(['pending', 'approved', 'changes-requested']),
  resolved: z.boolean(),
  messages: z.array(reviewMessageViewSchema),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
}).strict();
export type ReviewThreadView = z.infer<typeof reviewThreadViewSchema>;

export const repositoryModeSchema = z.enum(['current', 'working', 'staged', 'base']);
export type RepositoryMode = z.infer<typeof repositoryModeSchema>;
export const repositoryStatusSchema = z.enum(['clean', 'added', 'modified', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted']);
export type RepositoryStatus = z.infer<typeof repositoryStatusSchema>;

export const repositoryTreeEntrySchema = z.object({
  spaceId: idSchema,
  generation: generationSchema,
  mode: repositoryModeSchema,
  path: repositoryPathSchema,
  name: z.string().min(1).max(1_024),
  kind: z.enum(['file', 'directory', 'symlink']),
  status: repositoryStatusSchema,
  oldPath: repositoryPathSchema.nullable(),
  blobId: gitObjectIdSchema.nullable(),
  size: z.number().int().nonnegative().nullable(),
}).strict();
export type RepositoryTreeEntry = z.infer<typeof repositoryTreeEntrySchema>;

export const repositoryStatusEntrySchema = repositoryTreeEntrySchema.pick({
  spaceId: true, generation: true, mode: true, path: true, status: true, oldPath: true,
}).extend({ staged: z.boolean(), working: z.boolean() }).strict();
export type RepositoryStatusEntry = z.infer<typeof repositoryStatusEntrySchema>;

export const repositoryFileViewSchema = z.object({
  spaceId: idSchema,
  generation: generationSchema,
  mode: repositoryModeSchema,
  path: repositoryPathSchema,
  kind: z.enum(['file', 'symlink']),
  content: z.string(),
  encoding: z.enum(['utf-8', 'base64']),
  binary: z.boolean(),
  blobId: gitObjectIdSchema,
  commitId: gitObjectIdSchema,
  headCommit: gitObjectIdSchema,
  status: repositoryStatusSchema,
}).strict();
export type RepositoryFileView = z.infer<typeof repositoryFileViewSchema>;

export const repositoryDiffFileSchema = z.object({
  path: repositoryPathSchema,
  oldPath: repositoryPathSchema.nullable(),
  oldBlobId: gitObjectIdSchema.nullable(),
  newBlobId: gitObjectIdSchema.nullable(),
  status: repositoryStatusSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
}).strict();
export const repositoryDiffViewSchema = z.object({
  spaceId: idSchema,
  generation: generationSchema,
  mode: repositoryModeSchema,
  path: repositoryPathSchema.nullable(),
  patch: z.string(),
  baseCommit: gitObjectIdSchema,
  headCommit: gitObjectIdSchema,
  files: z.array(repositoryDiffFileSchema),
}).strict();
export type RepositoryDiffView = z.infer<typeof repositoryDiffViewSchema>;

export const serviceViewSchema = z.object({
  spaceId: idSchema,
  generation: generationSchema,
  id: idSchema,
  name: shortTextSchema,
  command: z.string().min(1).max(8_192),
  state: z.enum(['stopped', 'starting', 'running', 'ready', 'restarting', 'stopping', 'exited', 'failed']),
  port: z.number().int().min(1).max(65_535).nullable(),
  url: z.string().max(4_096).nullable(),
  terminalName: idSchema,
  startedAt: isoDateSchema.nullable(),
  exitedAt: isoDateSchema.nullable(),
  exitCode: z.number().int().nullable(),
}).strict();
export type ServiceView = z.infer<typeof serviceViewSchema>;

export const inspectorOverviewSchema = inspectorIdentitySchema.extend({
  revision: z.number().int().nonnegative(),
  goal: goalRecordViewSchema.nullable(),
  workflow: workflowViewSchema.nullable(),
  rubric: rubricViewSchema.nullable(),
  journal: z.object({
    entries: z.number().int().nonnegative(),
    openPhaseRunId: idSchema.nullable(),
    recent: z.array(journalEntryViewSchema).max(25),
  }).strict(),
  changeGuide: changeGuideViewSchema.nullable(),
  review: z.object({ total: z.number().int().nonnegative(), unresolved: z.number().int().nonnegative() }).strict(),
}).strict();
export type InspectorOverview = z.infer<typeof inspectorOverviewSchema>;

/** A put's revision check: the record's current revision, or 0 when there is none yet. */
const putRevisionSchema = z.number().int().nonnegative().describe('The record\'s current revision, from get; 0 to create it. A stale revision is refused.');
const expectedRevisionSchema = revisionSchema.describe('The record\'s current revision, from get or list. A stale revision is refused.');
const requirementIdSchema = idSchema.describe('The goal requirement.');
const reviewDecisionSchema = z.enum(['pending', 'approved', 'changes-requested']).describe('pending, approved or changes-requested.');
const journalPhase = z.string().trim().min(1).max(160);
const journalRepositorySchema = z.object({ generation: generationSchema.describe('The workspace generation.'), headCommit: gitObjectIdSchema.describe('The branch HEAD.') }).strict().describe('The workspace\'s code when the entry was written.');
export const putGoalInputSchema = inspectorIdentitySchema.extend({ expectedRevision: putRevisionSchema, goal: goalDraftSchema.describe('The whole new goal; it replaces the old one.') }).strict();
export const attachRequirementEvidenceInputSchema = inspectorIdentitySchema.extend({
  expectedRevision: expectedRevisionSchema, requirementId: requirementIdSchema, evidence: evidenceReferenceSchema.describe('The evidence that the requirement is met.'),
}).strict();
/** A person accepts a requirement, or reopens one they accepted. */
export const setRequirementAcceptanceInputSchema = inspectorIdentitySchema.extend({
  expectedRevision: expectedRevisionSchema, requirementId: requirementIdSchema, accepted: z.boolean().describe('true accepts it; false reopens it.'),
}).strict();
export const putWorkflowInputSchema = inspectorIdentitySchema.extend({ expectedRevision: putRevisionSchema, workflow: workflowDraftSchema.describe('The whole new workflow; it replaces the old one.') }).strict();
export const waiveWorkflowGateInputSchema = inspectorIdentitySchema.extend({
  expectedRevision: expectedRevisionSchema, gateId: idSchema.describe('The gate to waive.'), waiverId: idSchema.describe('The waiver\'s id.'), reason: textSchema.describe('Why it is waived.'), actorId: idSchema.describe('Who waives it.'), actorKind: z.enum(['human', 'client']).describe('human or client.'),
}).strict();
export const putRubricInputSchema = inspectorIdentitySchema.extend({ expectedRevision: putRevisionSchema, rubric: rubricDraftSchema.describe('The whole new rubric; it replaces the old one.') }).strict();
export const appendRubricJudgmentInputSchema = inspectorIdentitySchema.extend({ expectedRevision: expectedRevisionSchema, criterionId: idSchema.describe('The criterion judged.'), judgment: rubricJudgmentSchema.describe('The judgment.') }).strict();
export const startJournalPhaseInputSchema = inspectorIdentitySchema.extend({
  phaseRunId: idSchema.describe('The phase run\'s id; endPhase names it.'), entryId: idSchema.describe('The entry\'s id.'), phase: journalPhase.describe('The phase, such as plan, build or verify.'), intent: textSchema.describe('What the phase sets out to do, in Markdown.'), createdBy: idSchema.describe('Who started it.'),
  repository: journalRepositorySchema,
}).strict();
export const endJournalPhaseInputSchema = inspectorIdentitySchema.extend({
  phaseRunId: idSchema.describe('The phase run to end: startPhase\'s phaseRunId.'), entryId: idSchema.describe('The entry\'s id.'), outcome: textSchema.describe('What the phase achieved, in Markdown.'), decisions: z.array(textSchema).max(256).describe('Decisions made during the phase.'), surprises: z.array(textSchema).max(256).describe('What turned out differently than expected.'), createdBy: idSchema.describe('Who ended it.'),
  repository: journalRepositorySchema,
  revert: z.object({ reason: textSchema.describe('Why the work goes back.'), to: z.string().trim().min(1).max(160).describe('The phase it goes back to.') }).strict().nullable().describe('The phase\'s work goes back to an earlier phase; null when it moves on.'),
}).strict();
export const appendJournalEntryInputSchema = inspectorIdentitySchema.extend({
  id: idSchema.describe('The entry\'s id.'), kind: z.enum(['narrative', 'decision', 'artifact']).describe('narrative: what happened; decision: a choice and why; artifact: something produced.'), phase: journalPhase.describe('The phase it belongs to.'), title: shortTextSchema.describe('The entry, in one line.'),
  body: z.string().trim().max(32_768).describe('The entry, in Markdown.'), outcome: z.string().trim().max(32_768).nullable().describe('What it led to; null for nothing yet.'), decisions: z.array(textSchema).max(256).describe('Decisions it records.'),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT).describe('What it rests on.'), createdBy: idSchema.describe('Who wrote it.'),
  ...journalDecisionFields,
}).strict();
export const putChangeGuideInputSchema = inspectorIdentitySchema.extend({ expectedRevision: putRevisionSchema, guide: changeGuideDraftSchema.describe('The whole new guide revision.') }).strict();
export const analyzeChangeGuideInputSchema = inspectorIdentitySchema.extend({
  expectedGeneration: generationSchema,
  baseRef: z.string().trim().min(1).max(512),
}).strict();
export const submitChangeGuideInputSchema = inspectorIdentitySchema.extend({
  expectedRevision: z.number().int().nonnegative(),
  expectedGeneration: generationSchema,
  headCommit: gitObjectIdSchema,
  baseRef: z.string().trim().min(1).max(512),
  baseCommit: gitObjectIdSchema,
  title: shortTextSchema,
  sections: z.array(changeGuideSectionSchema).max(512).refine(orderedUnique, 'Change Guide section ids must be unique'),
  createdBy: idSchema,
  ...changeGuideNarrativeFields,
}).strict().superRefine(refineGuideMapSections);
export const markGuideSectionReadInputSchema = inspectorIdentitySchema.extend({ revision: revisionSchema.describe('The guide revision read.'), headCommit: gitObjectIdSchema.describe('That revision\'s head commit.'), sectionId: idSchema.describe('The section read.'), reviewerId: idSchema.describe('Who read it.') }).strict();
export const setGuideApprovalInputSchema = inspectorIdentitySchema.extend({
  revision: revisionSchema, headCommit: gitObjectIdSchema, reviewerId: idSchema,
  decision: z.enum(['pending', 'approved', 'changes-requested']), note: z.string().trim().max(8_192).nullable(),
}).strict();
export const reviewAnchorContextSchema = z.object({ generation: generationSchema.describe('The workspace generation.'), headCommit: gitObjectIdSchema.describe('The branch HEAD.') }).strict();
export const createReviewThreadInputSchema = inspectorIdentitySchema.extend({
  id: idSchema.describe('The thread\'s id.'), anchor: reviewAnchorSchema, decision: reviewDecisionSchema,
  message: reviewMessageViewSchema.describe('The thread\'s first message.'),
}).strict();
export const appendReviewMessageInputSchema = inspectorIdentitySchema.extend({ threadId: idSchema.describe('The thread.'), expectedRevision: expectedRevisionSchema, message: reviewMessageViewSchema.describe('The reply.') }).strict();
export const resolveReviewThreadInputSchema = inspectorIdentitySchema.extend({
  threadId: idSchema.describe('The thread.'), expectedRevision: expectedRevisionSchema, resolved: z.boolean().describe('true resolves it; false reopens it.'), decision: reviewDecisionSchema,
}).strict();
export const repositoryReadRequestSchema = inspectorIdentitySchema.extend({
  expectedGeneration: generationSchema,
  mode: repositoryModeSchema,
  path: repositoryPathSchema.nullable(),
  baseRef: z.string().trim().min(1).max(512),
}).strict();

export type PutGoalInput = z.infer<typeof putGoalInputSchema>;
export type AttachRequirementEvidenceInput = z.infer<typeof attachRequirementEvidenceInputSchema>;
export type SetRequirementAcceptanceInput = z.infer<typeof setRequirementAcceptanceInputSchema>;
export type PutWorkflowInput = z.infer<typeof putWorkflowInputSchema>;
export type WaiveWorkflowGateInput = z.infer<typeof waiveWorkflowGateInputSchema>;
export type PutRubricInput = z.infer<typeof putRubricInputSchema>;
export type AppendRubricJudgmentInput = z.infer<typeof appendRubricJudgmentInputSchema>;
export type StartJournalPhaseInput = z.infer<typeof startJournalPhaseInputSchema>;
export type EndJournalPhaseInput = z.infer<typeof endJournalPhaseInputSchema>;
export type AppendJournalEntryInput = z.infer<typeof appendJournalEntryInputSchema>;
export type PutChangeGuideInput = z.infer<typeof putChangeGuideInputSchema>;
export type AnalyzeChangeGuideInput = z.infer<typeof analyzeChangeGuideInputSchema>;
export type SubmitChangeGuideInput = z.infer<typeof submitChangeGuideInputSchema>;
export type MarkGuideSectionReadInput = z.infer<typeof markGuideSectionReadInputSchema>;
export type SetGuideApprovalInput = z.infer<typeof setGuideApprovalInputSchema>;
export type ReviewAnchorContext = z.infer<typeof reviewAnchorContextSchema>;
export type CreateReviewThreadInput = z.infer<typeof createReviewThreadInputSchema>;
export type AppendReviewMessageInput = z.infer<typeof appendReviewMessageInputSchema>;
export type ResolveReviewThreadInput = z.infer<typeof resolveReviewThreadInputSchema>;
export type RepositoryReadRequest = z.infer<typeof repositoryReadRequestSchema>;

const asWireCodec = <T>(schema: z.ZodType<T>, id: string) => wire.serializable((value): value is T => schema.safeParse(value).success, { id, jsonSchema: schema });

export const InspectorOverviewCodec = asWireCodec(inspectorOverviewSchema, 'gitspace/inspector-overview/v2');
export const InspectorProjectCodec = asWireCodec(cloudProjectSummarySchema, 'gitspace/inspector-project/v1');
export const InspectorWorkspaceCodec = asWireCodec(cloudWorkspaceDefinitionSchema, 'gitspace/inspector-workspace/v1');
export const InspectorIdentityCodec = asWireCodec(inspectorIdentitySchema, 'gitspace/inspector-identity/v1');
export const GoalRecordViewCodec = asWireCodec(goalRecordViewSchema, 'gitspace/goal-record-view/v1');
export const WorkflowViewCodec = asWireCodec(workflowViewSchema, 'gitspace/workflow-view/v2');
export const RubricViewCodec = asWireCodec(rubricViewSchema, 'gitspace/rubric-view/v2');
export const JournalEntryViewCodec = asWireCodec(journalEntryViewSchema, 'gitspace/journal-entry-view/v1');
export const ChangeGuideViewCodec = asWireCodec(changeGuideViewSchema, 'gitspace/change-guide-view/v1');
export const ChangeGuideRevisionSummaryCodec = asWireCodec(changeGuideRevisionSummarySchema, 'gitspace/change-guide-revision-summary/v1');
export const RepositoryTreeEntryCodec = asWireCodec(repositoryTreeEntrySchema, 'gitspace/repository-tree-entry/v1');
export const RepositoryStatusEntryCodec = asWireCodec(repositoryStatusEntrySchema, 'gitspace/repository-status-entry/v1');
export const RepositoryFileViewCodec = asWireCodec(repositoryFileViewSchema, 'gitspace/repository-file-view/v1');
export const RepositoryDiffViewCodec = asWireCodec(repositoryDiffViewSchema, 'gitspace/repository-diff-view/v2');
export const ReviewThreadViewCodec = asWireCodec(reviewThreadViewSchema, 'gitspace/review-thread-view/v1');
export const ServiceViewCodec = asWireCodec(serviceViewSchema, 'gitspace/service-view/v1');
export const ChangeGuideWorksheetCodec = asWireCodec(changeGuideWorksheetSchema, 'gitspace/change-guide-worksheet/v1');
export const PutGoalInputCodec = asWireCodec(putGoalInputSchema, 'gitspace/put-goal-input/v1');
export const AttachRequirementEvidenceInputCodec = asWireCodec(attachRequirementEvidenceInputSchema, 'gitspace/attach-requirement-evidence-input/v1');
export const SetRequirementAcceptanceInputCodec = asWireCodec(setRequirementAcceptanceInputSchema, 'gitspace/set-requirement-acceptance-input/v1');
export const PutWorkflowInputCodec = asWireCodec(putWorkflowInputSchema, 'gitspace/put-workflow-input/v1');
export const WaiveWorkflowGateInputCodec = asWireCodec(waiveWorkflowGateInputSchema, 'gitspace/waive-workflow-gate-input/v2');
export const PutRubricInputCodec = asWireCodec(putRubricInputSchema, 'gitspace/put-rubric-input/v1');
export const AppendRubricJudgmentInputCodec = asWireCodec(appendRubricJudgmentInputSchema, 'gitspace/append-rubric-judgment-input/v2');
export const StartJournalPhaseInputCodec = asWireCodec(startJournalPhaseInputSchema, 'gitspace/start-journal-phase-input/v1');
export const EndJournalPhaseInputCodec = asWireCodec(endJournalPhaseInputSchema, 'gitspace/end-journal-phase-input/v1');
export const AppendJournalEntryInputCodec = asWireCodec(appendJournalEntryInputSchema, 'gitspace/append-journal-entry-input/v1');
export const PutChangeGuideInputCodec = asWireCodec(putChangeGuideInputSchema, 'gitspace/put-change-guide-input/v1');
export const AnalyzeChangeGuideInputCodec = asWireCodec(analyzeChangeGuideInputSchema, 'gitspace/analyze-change-guide-input/v1');
export const SubmitChangeGuideInputCodec = asWireCodec(submitChangeGuideInputSchema, 'gitspace/submit-change-guide-input/v1');
export const MarkGuideSectionReadInputCodec = asWireCodec(markGuideSectionReadInputSchema, 'gitspace/mark-guide-section-read-input/v1');
export const SetGuideApprovalInputCodec = asWireCodec(setGuideApprovalInputSchema, 'gitspace/set-guide-approval-input/v1');
export const CreateReviewThreadInputCodec = asWireCodec(createReviewThreadInputSchema, 'gitspace/create-review-thread-input/v1');
export const AppendReviewMessageInputCodec = asWireCodec(appendReviewMessageInputSchema, 'gitspace/append-review-message-input/v1');
export const ResolveReviewThreadInputCodec = asWireCodec(resolveReviewThreadInputSchema, 'gitspace/resolve-review-thread-input/v1');
export const RepositoryReadRequestCodec = asWireCodec(repositoryReadRequestSchema, 'gitspace/repository-read-request/v1');

const targetWorkspace = z.string().min(1).describe('The workspace.');
const otherWorkspace = z.string().min(1).optional().describe('The workspace; this one when omitted.');
/** Agent workspace tools share these envelopes with their machine implementation. Goal, workflow and rubric are the
 * agent's drafts: the host records who wrote them. */
export const RuntimeWorkspaceCreateArgumentsSchema = RuntimeDispatchSelectionSchema.extend({
  method: z.literal('create').describe('Create a workspace from an explicit source.'), workspaceId: z.string().min(1).optional().describe('An id for the new workspace; one is made from its name when omitted.'),
  name: z.string().trim().min(1).max(160).describe('The workspace\'s name.'), branch: z.string().min(1).max(512).describe('Its branch, new or existing.'),
  phase: WorkspacePhaseSchema.default('plan').describe('Its first phase: plan (the default), code, review or ship.'),
  sourceKind: z.enum(['base', 'branch', 'workspace', 'pull-request']).describe('What it starts from: the project base, a branch, another workspace or a pull request.'), sourceRef: z.string().describe('Which one: the branch name, workspace id or pull request number; the base branch for base.'),
  dependsOn: z.array(z.string().min(1)).optional().describe('Workspaces it depends on.'),
  goal: goalAgentDraftSchema.optional().describe('Its first goal.'), workflow: workflowAgentDraftSchema.optional().describe('Its first workflow.'), rubric: rubricAgentDraftSchema.optional().describe('Its first rubric.'),
}).strict();
export const RuntimeWorkspaceMutationArgumentsSchema = z.discriminatedUnion('method', [
  RuntimeWorkspaceCreateArgumentsSchema,
  RuntimeDispatchSelectionSchema.extend({ method: z.enum(['open', 'restore']).describe('open: the workspace\'s definition, refused while it is archived; restore: bring back an archived workspace.'), workspaceId: otherWorkspace, expectedGeneration: z.number().int().nonnegative().describe('The workspace\'s current generation, from get; a stale one is refused.') }).strict(),
  RuntimeDispatchSelectionSchema.extend({ method: z.literal('setRelations').describe('Replace the workspace\'s relations.'), workspaceId: otherWorkspace, expectedRevision: z.number().int().nonnegative().describe('The workspace\'s current revision, from get; a stale one is refused.'), dependsOn: z.array(z.string()).describe('Workspaces it depends on.'), relatedTo: z.array(z.string()).describe('Workspaces related to it.'), stackedOn: z.string().nullable().describe('The workspace it is stacked on; null for none.') }).strict(),
]);
/** The project agent sends another workspace's main agent an instruction, as its first message or a later one: `queue`
 * (the default) runs it after a running turn ends, `steer` brings it into that turn at its next tool boundary. The turn
 * it starts or steers reports once to the project conversation; `wake` makes that report start the project agent's next
 * turn. */
export const RuntimeWorkspaceStartArgumentsSchema = z.object({ method: z.literal('start').describe('Project agent only: send a workspace\'s agent an instruction.'), workspaceId: targetWorkspace, instruction: z.string().trim().min(1).max(32_768).describe('The instruction, complete in itself.'), when: z.enum(['queue', 'steer']).default('queue').describe('queue (the default): after a running turn ends; steer: into that turn at its next tool boundary.'), onDone: z.enum(['quiet', 'wake']).default('quiet').describe('quiet (the default): its report waits for your next turn; wake: its report starts your next turn.') }).strict();
/** The turn the project agent started in a workspace, while it is watched: its state and its newest items. */
export const RuntimeWorkspaceProgressArgumentsSchema = z.object({ method: z.literal('progress').describe('The turn you started in a workspace: its state and newest items.'), workspaceId: targetWorkspace }).strict();
/** What `space_workspace answer` takes, said whole when an answer or the list is not that shape. */
const PROJECT_ANSWERS_SHAPE = 'answers is a list of { workspaceId, questionId, answer }, one per question: workspaceId and questionId as questions lists them, answer the chosen choice or your own words as a string (a list of strings picks several choices). Example: { method: "answer", answers: [{ workspaceId: "ws-1", questionId: "question:42", answer: "uploads" }] }';
/** One answer the project agent proposes for a workspace's open plain question. */
export const RuntimeProjectAnswerSchema = z.object({
  workspaceId: z.string({ error: 'the workspace id, as a string, as questions lists it' }).min(1).describe('The workspace, as questions names it.'),
  questionId: z.string({ error: 'the question id, as a string, as questions lists it' }).min(1).describe('The question, from questions.'),
  answer: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)], { error: 'the chosen choice or your own words, as a string (a list of strings picks several choices)' }).describe('The chosen choice or your own words, as a string; a list of strings picks several choices.'),
}, { error: PROJECT_ANSWERS_SHAPE }).strict();
export type RuntimeProjectAnswer = z.infer<typeof RuntimeProjectAnswerSchema>;
/** The project agent reads the questions open in a workspace, and proposes answers to plain asks (`ask`) in the person's
 * place: one approval card in its own conversation lists the batch, nothing is sent before the person approves it, and
 * each answer's outcome is the project agent's next input. Approvals and take-over requests stay a person's. */
export const RuntimeWorkspaceQuestionsArgumentsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('questions').describe('The questions open in a workspace.'), workspaceId: targetWorkspace }).strict(),
  z.object({ method: z.literal('answer').describe('Propose answers to plain questions open in this project\'s workspaces, in the person\'s place; approvals and take-overs stay theirs. It posts one approval card listing every answer and your turn ends: nothing is sent until the person approves. Your next message says, per answer, whether it was delivered, its question had already closed, or it failed; if they reject the card, nothing was sent.'), answers: z.array(RuntimeProjectAnswerSchema, { error: PROJECT_ANSWERS_SHAPE }).min(1, PROJECT_ANSWERS_SHAPE).max(20, 'answers: at most 20 per card').describe('One per question.') }).strict(),
]);
/** Subject links (docs/AUTOMATIONS-DESIGN.md §4): a pull request, issue or branch linked to this workspace, or to a named
 * one, gets the project's events about it through its automations; one subject has one workspace. */
export const RuntimeWorkspaceLinkArgumentsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('links').describe('The project\'s subject links: which workspace each pull request, issue or branch belongs to.') }).strict(),
  z.object({ method: z.literal('link').describe('Link a subject to a workspace, so its events reach it.'), subject: AutomationSubjectRefSchema, workspaceId: otherWorkspace }).strict(),
  z.object({ method: z.literal('unlink').describe('Remove a subject\'s link.'), subject: AutomationSubjectRefSchema }).strict(),
]);
export const RuntimeWorkspaceArgumentsSchema = z.union([
  z.object({ method: z.enum(['get', 'current', 'list', 'operations', 'board']).describe('get/current: one workspace\'s definition; list: every workspace with its status; board: the same, a line each; operations: the project\'s operations, such as creations and deletions.'), workspaceId: otherWorkspace }).strict(),
  /** One workspace's stored report; `list` and `board` carry every workspace's status in one read. */
  z.object({ method: z.literal('status').describe('One workspace\'s stored report: last reply, model, code, ahead/behind the base.'), workspaceId: targetWorkspace }).strict(),
  RuntimeWorkspaceProgressArgumentsSchema,
  RuntimeWorkspaceQuestionsArgumentsSchema,
  RuntimeWorkspaceStartArgumentsSchema,
  RuntimeWorkspaceMutationArgumentsSchema,
  RuntimeWorkspaceLinkArgumentsSchema,
]);
/** An automation as the project agent drafts it (`AutomationDraft` without `enabled`: a person's approval turns it on). */
export const RuntimeAutomationDraftSchema = AutomationDraftSchema.omit({ enabled: true }).extend({ conditions: AutomationDraftSchema.shape.conditions.default([]) });
/** The project agent's automations (docs/AUTOMATIONS-DESIGN.md §5a). What it proposes, new or a change, waits for a person
 * to approve it before it runs; switching one off or deleting it takes effect at once. */
export const RuntimeAutomationsArgumentsSchema = z.union([
  z.object({ method: z.literal('list').describe('The project\'s automations with their recent state, the subject links and the model roles the profile offers.') }).strict(),
  z.object({ method: z.literal('propose').describe('Propose a new automation, or a change to one; it runs once a person approves it.'), automationId: z.string().min(1).optional().describe('The automation to change; a new one when omitted.'), draft: RuntimeAutomationDraftSchema.describe('The automation; a person\'s approval turns it on.'), asked: z.string().trim().min(1).max(4_000).describe('What the user asked for, in their words.'), reason: z.string().trim().min(1).max(4_000).describe('Why this automation does that.') }).strict(),
  z.object({ method: z.literal('test').describe('What a draft would do: its next run times, or what it would do with recent GitHub events.'), draft: RuntimeAutomationDraftSchema.describe('The automation to test.') }).strict(),
  z.object({ method: z.enum(['delete', 'disable']).describe('Delete or switch off an automation, at once.'), automationId: z.string().min(1).describe('The automation.') }).strict(),
]);
