import { wire } from 'result-rpc';
import { z } from 'zod';

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

export const artifactEvidenceReferenceSchema = z.object({
  kind: z.literal('artifact'),
  url: z.string().min(1).max(4_096),
  hash: artifactHashSchema,
  generation: generationSchema,
  label: shortTextSchema,
  mediaType: z.string().trim().min(1).max(255).nullable(),
}).strict();
export const gitEvidenceReferenceSchema = z.object({
  kind: z.literal('git'),
  generation: generationSchema,
  path: repositoryPathSchema,
  blobId: gitObjectIdSchema.nullable(),
  commitId: gitObjectIdSchema,
  label: shortTextSchema,
}).strict();
export const commandEvidenceReferenceSchema = z.object({
  kind: z.literal('command'),
  runId: idSchema,
  command: z.string().trim().min(1).max(8_192),
  exitCode: z.number().int(),
  artifactUrl: z.string().min(1).max(4_096).nullable(),
  artifactHash: artifactHashSchema.nullable(),
  generation: generationSchema,
  label: shortTextSchema,
}).strict().superRefine((reference, context) => {
  if ((reference.artifactUrl === null) !== (reference.artifactHash === null)) {
    context.addIssue({ code: 'custom', message: 'Command evidence artifact URL and hash must be supplied together' });
  }
});
export const reviewEvidenceReferenceSchema = z.object({
  kind: z.literal('review-thread'),
  threadId: idSchema,
  messageId: idSchema.nullable(),
  label: shortTextSchema,
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
  id: idSchema,
  title: shortTextSchema,
  description: z.string().trim().max(8_192),
  required: z.boolean(),
  status: requirementStatusSchema,
  workflowNodeId: idSchema.nullable(),
  criterionId: idSchema.nullable(),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT),
}).strict();
export type GoalRequirement = z.infer<typeof goalRequirementSchema>;

const orderedUnique = <T extends { id: string }>(items: T[]): boolean => new Set(items.map((item) => item.id)).size === items.length;

export const goalRecordViewSchema = inspectorIdentitySchema.extend({
  id: idSchema,
  revision: revisionSchema,
  title: shortTextSchema,
  summary: z.string().trim().max(16_384),
  phase: z.enum(['plan', 'code', 'review', 'ship']),
  requirements: z.array(goalRequirementSchema).max(512).refine(orderedUnique, 'Requirement ids must be unique'),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  updatedBy: idSchema,
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

export const workflowGateWaiverSchema = z.object({
  id: idSchema,
  reason: textSchema,
  actorId: idSchema,
  actorKind: z.literal('human'),
  createdAt: isoDateSchema,
}).strict();
export type WorkflowGateWaiver = z.infer<typeof workflowGateWaiverSchema>;

const workflowNodeBaseSchema = z.object({
  id: idSchema,
  label: shortTextSchema,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
}).strict();
export const workflowPhaseNodeSchema = workflowNodeBaseSchema.extend({
  kind: z.literal('phase'),
  status: z.enum(['pending', 'running', 'complete', 'reverted']),
  role: z.string().trim().max(160).nullable(),
  reads: z.array(shortTextSchema).max(128),
  writes: z.array(shortTextSchema).max(128),
}).strict();
export const workflowArtifactNodeSchema = workflowNodeBaseSchema.extend({
  kind: z.literal('artifact'),
  status: z.enum(['missing', 'available']),
  evidence: evidenceReferenceSchema.nullable(),
}).strict();
export const workflowGateNodeSchema = workflowNodeBaseSchema.extend({
  kind: z.literal('gate'),
  requirementIds: z.array(idSchema).max(512),
  satisfied: z.boolean(),
  passable: z.boolean(),
  waivers: z.array(workflowGateWaiverSchema),
}).strict();
export const workflowNodeSchema = z.discriminatedUnion('kind', [workflowPhaseNodeSchema, workflowArtifactNodeSchema, workflowGateNodeSchema]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z.object({
  id: idSchema,
  from: idSchema,
  to: idSchema,
  kind: z.enum(['control', 'data']),
  label: z.string().trim().max(512).nullable(),
}).strict();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowViewSchema = inspectorIdentitySchema.extend({
  id: idSchema,
  revision: revisionSchema,
  title: shortTextSchema,
  description: z.string().trim().max(16_384),
  nodes: z.array(workflowNodeSchema).max(512),
  edges: z.array(workflowEdgeSchema).max(2_048),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  updatedBy: idSchema,
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

export const workflowDraftSchema = z.object({
  id: idSchema,
  title: shortTextSchema,
  description: z.string().trim().max(16_384),
  nodes: z.array(z.discriminatedUnion('kind', [
    workflowPhaseNodeSchema,
    workflowArtifactNodeSchema,
    workflowGateNodeSchema.omit({ satisfied: true, passable: true, waivers: true }),
  ])).max(512),
  edges: z.array(workflowEdgeSchema).max(2_048),
  updatedBy: idSchema,
}).strict().superRefine((workflow, context) => {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  if (nodeIds.size !== workflow.nodes.length) context.addIssue({ code: 'custom', path: ['nodes'], message: 'Workflow node ids must be unique' });
  const edgeIds = new Set(workflow.edges.map((edge) => edge.id));
  if (edgeIds.size !== workflow.edges.length) context.addIssue({ code: 'custom', path: ['edges'], message: 'Workflow edge ids must be unique' });
  for (const edge of workflow.edges) if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) context.addIssue({ code: 'custom', path: ['edges'], message: `Workflow edge ${edge.id} has a missing endpoint` });
});
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;

export const rubricJudgeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }).strict(),
  z.object({ kind: z.literal('llm'), model: z.string().trim().min(1).max(255).nullable() }).strict(),
  z.object({
    kind: z.literal('command'),
    command: z.string().trim().min(1).max(8_192),
    expectation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('exit-zero') }).strict(),
      z.object({ kind: z.literal('stdout-contains'), value: z.string().min(1).max(4_096) }).strict(),
      z.object({ kind: z.literal('stderr-empty') }).strict(),
      z.object({ kind: z.literal('output-matches'), pattern: z.string().min(1).max(4_096) }).strict(),
    ]),
  }).strict(),
]);
export type RubricJudge = z.infer<typeof rubricJudgeSchema>;

const judgmentBaseSchema = z.object({
  id: idSchema,
  verdict: z.enum(['pass', 'fail']),
  summary: textSchema,
  actorId: idSchema,
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT),
  createdAt: isoDateSchema,
}).strict();
export const humanJudgmentSchema = judgmentBaseSchema.extend({ kind: z.literal('human') }).strict();
export const llmJudgmentSchema = judgmentBaseSchema.extend({
  kind: z.literal('llm'),
  model: z.string().trim().min(1).max(255),
}).strict();
export const commandJudgmentSchema = judgmentBaseSchema.extend({
  kind: z.literal('command'),
  command: z.string().trim().min(1).max(8_192),
  runId: idSchema,
  exitCode: z.number().int(),
}).strict();
export const rubricJudgmentSchema = z.discriminatedUnion('kind', [humanJudgmentSchema, llmJudgmentSchema, commandJudgmentSchema]);
export type RubricJudgment = z.infer<typeof rubricJudgmentSchema>;

export const rubricCriterionSchema = z.object({
  id: idSchema,
  title: shortTextSchema,
  description: textSchema,
  workflowNodeId: idSchema.nullable(),
  requirementIds: z.array(idSchema).max(512),
  judge: rubricJudgeSchema,
  status: z.enum(['pending', 'passed', 'failed']),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT),
  judgments: z.array(rubricJudgmentSchema),
}).strict();
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>;

export const rubricViewSchema = inspectorIdentitySchema.extend({
  id: idSchema,
  revision: revisionSchema,
  title: shortTextSchema,
  description: z.string().trim().max(16_384),
  criteria: z.array(rubricCriterionSchema).max(512).refine(orderedUnique, 'Criterion ids must be unique'),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  updatedBy: idSchema,
}).strict();
export type RubricView = z.infer<typeof rubricViewSchema>;

export const rubricDraftSchema = z.object({
  id: idSchema,
  title: shortTextSchema,
  description: z.string().trim().max(16_384),
  criteria: z.array(rubricCriterionSchema.omit({ status: true, judgments: true })).max(512).refine(orderedUnique, 'Criterion ids must be unique'),
  updatedBy: idSchema,
}).strict();
export type RubricDraft = z.infer<typeof rubricDraftSchema>;

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
}).strict();
export type JournalEntryView = z.infer<typeof journalEntryViewSchema>;

export const changeGuideExhibitSchema = z.object({
  path: repositoryPathSchema,
  blobId: gitObjectIdSchema.nullable(),
  note: z.string().trim().max(4_096),
  slowRead: z.boolean(),
}).strict();
export const changeGuideSectionSchema = z.object({
  id: idSchema,
  title: shortTextSchema,
  kind: z.enum(['decision', 'behavior', 'risk', 'mechanical']),
  explanation: textSchema,
  why: z.string().trim().max(16_384),
  exhibits: z.array(changeGuideExhibitSchema).max(256),
  requirementIds: z.array(idSchema).max(512),
  contentHash: z.string().regex(/^[a-f0-9]{12}$/u).optional(),
  journalEntryIds: z.array(idSchema).max(256).optional(),
  callouts: z.array(z.object({ tone: z.enum(['risk', 'mechanical', 'decision']), text: textSchema }).strict()).max(64).optional(),
  asks: z.array(shortTextSchema).max(64).optional(),
}).strict();
export type ChangeGuideSection = z.infer<typeof changeGuideSectionSchema>;

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
  title: shortTextSchema,
  sections: z.array(changeGuideSectionSchema).max(512).refine(orderedUnique, 'Change Guide section ids must be unique'),
  reviewerStates: z.array(changeGuideReviewerStateSchema),
  createdAt: isoDateSchema,
  createdBy: idSchema,
}).strict();
export type ChangeGuideView = z.infer<typeof changeGuideViewSchema>;

export const changeGuideDraftSchema = z.object({
  headCommit: gitObjectIdSchema,
  baseRef: z.string().trim().min(1).max(512),
  title: shortTextSchema,
  sections: z.array(changeGuideSectionSchema).max(512).refine(orderedUnique, 'Change Guide section ids must be unique'),
  createdBy: idSchema,
}).strict();
export type ChangeGuideDraft = z.infer<typeof changeGuideDraftSchema>;

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

export const submitChangeGuideNarrationInputSchema = inspectorIdentitySchema.extend({
  expectedRevision: z.number().int().nonnegative(),
  headCommit: gitObjectIdSchema,
  baseRef: z.string().trim().min(1).max(512),
  title: shortTextSchema,
  sections: z.array(changeGuideSectionSchema).max(512).refine(orderedUnique, 'Change Guide section ids must be unique'),
  createdBy: idSchema,
}).strict();
export type SubmitChangeGuideNarrationInput = z.infer<typeof submitChangeGuideNarrationInputSchema>;

export const reviewAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }).strict(),
  z.object({
    kind: z.literal('file'), path: repositoryPathSchema, generation: generationSchema,
    commitId: gitObjectIdSchema, blobId: gitObjectIdSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('line'), path: repositoryPathSchema, generation: generationSchema,
    baseCommit: gitObjectIdSchema, headCommit: gitObjectIdSchema, blobId: gitObjectIdSchema.nullable(),
    side: z.enum(['base', 'head']), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  }).strict().refine((anchor) => anchor.endLine >= anchor.startLine, 'Review line range is inverted'),
  z.object({
    kind: z.literal('hunk'), path: repositoryPathSchema, generation: generationSchema,
    baseCommit: gitObjectIdSchema, headCommit: gitObjectIdSchema, hunkHeader: z.string().trim().startsWith('@@').max(1_024),
  }).strict(),
  z.object({
    kind: z.literal('artifact'), url: z.string().min(1).max(4_096), hash: artifactHashSchema, generation: generationSchema,
  }).strict(),
]);
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;

export const reviewMessageViewSchema = z.object({
  id: idSchema,
  authorId: idSchema,
  body: textSchema,
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

export const putGoalInputSchema = inspectorIdentitySchema.extend({ expectedRevision: z.number().int().nonnegative(), goal: goalDraftSchema }).strict();
export const attachRequirementEvidenceInputSchema = inspectorIdentitySchema.extend({
  expectedRevision: revisionSchema, requirementId: idSchema, evidence: evidenceReferenceSchema,
}).strict();
export const putWorkflowInputSchema = inspectorIdentitySchema.extend({ expectedRevision: z.number().int().nonnegative(), workflow: workflowDraftSchema }).strict();
export const waiveWorkflowGateInputSchema = inspectorIdentitySchema.extend({
  expectedRevision: revisionSchema, gateId: idSchema, waiverId: idSchema, reason: textSchema, actorId: idSchema, actorKind: z.literal('human'),
}).strict();
export const putRubricInputSchema = inspectorIdentitySchema.extend({ expectedRevision: z.number().int().nonnegative(), rubric: rubricDraftSchema }).strict();
export const appendRubricJudgmentInputSchema = inspectorIdentitySchema.extend({ expectedRevision: revisionSchema, criterionId: idSchema, judgment: rubricJudgmentSchema }).strict();
export const startJournalPhaseInputSchema = inspectorIdentitySchema.extend({
  phaseRunId: idSchema, entryId: idSchema, phase: z.string().trim().min(1).max(160), intent: textSchema, createdBy: idSchema,
  repository: z.object({ generation: generationSchema, headCommit: gitObjectIdSchema }).strict(),
}).strict();
export const endJournalPhaseInputSchema = inspectorIdentitySchema.extend({
  phaseRunId: idSchema, entryId: idSchema, outcome: textSchema, decisions: z.array(textSchema).max(256), surprises: z.array(textSchema).max(256), createdBy: idSchema,
  repository: z.object({ generation: generationSchema, headCommit: gitObjectIdSchema }).strict(),
  revert: z.object({ reason: textSchema, to: z.string().trim().min(1).max(160) }).strict().nullable(),
}).strict();
export const appendJournalEntryInputSchema = inspectorIdentitySchema.extend({
  id: idSchema, kind: z.enum(['narrative', 'decision', 'artifact']), phase: z.string().trim().min(1).max(160), title: shortTextSchema,
  body: z.string().trim().max(32_768), outcome: z.string().trim().max(32_768).nullable(), decisions: z.array(textSchema).max(256),
  evidence: z.array(evidenceReferenceSchema).max(INSPECTOR_EVIDENCE_HISTORY_LIMIT), createdBy: idSchema,
}).strict();
export const putChangeGuideInputSchema = inspectorIdentitySchema.extend({ expectedRevision: z.number().int().nonnegative(), guide: changeGuideDraftSchema }).strict();
export const analyzeChangeGuideInputSchema = inspectorIdentitySchema.extend({
  expectedGeneration: generationSchema,
  baseRef: z.string().trim().min(1).max(512),
}).strict();
export const submitChangeGuideInputSchema = submitChangeGuideNarrationInputSchema.extend({
  expectedGeneration: generationSchema,
}).strict();
export const markGuideSectionReadInputSchema = inspectorIdentitySchema.extend({ revision: revisionSchema, headCommit: gitObjectIdSchema, sectionId: idSchema, reviewerId: idSchema }).strict();
export const setGuideApprovalInputSchema = inspectorIdentitySchema.extend({
  revision: revisionSchema, headCommit: gitObjectIdSchema, reviewerId: idSchema,
  decision: z.enum(['pending', 'approved', 'changes-requested']), note: z.string().trim().max(8_192).nullable(),
}).strict();
export const reviewAnchorContextSchema = z.object({ generation: generationSchema, headCommit: gitObjectIdSchema }).strict();
export const createReviewThreadInputSchema = inspectorIdentitySchema.extend({
  id: idSchema, anchor: reviewAnchorSchema, decision: z.enum(['pending', 'approved', 'changes-requested']),
  message: reviewMessageViewSchema,
}).strict();
export const appendReviewMessageInputSchema = inspectorIdentitySchema.extend({ threadId: idSchema, expectedRevision: revisionSchema, message: reviewMessageViewSchema }).strict();
export const resolveReviewThreadInputSchema = inspectorIdentitySchema.extend({
  threadId: idSchema, expectedRevision: revisionSchema, resolved: z.boolean(), decision: z.enum(['pending', 'approved', 'changes-requested']),
}).strict();
export const repositoryReadRequestSchema = inspectorIdentitySchema.extend({
  expectedGeneration: generationSchema,
  mode: repositoryModeSchema,
  path: repositoryPathSchema.nullable(),
  baseRef: z.string().trim().min(1).max(512),
}).strict();

export type PutGoalInput = z.infer<typeof putGoalInputSchema>;
export type AttachRequirementEvidenceInput = z.infer<typeof attachRequirementEvidenceInputSchema>;
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

const asWireCodec = <T>(schema: z.ZodType<T>, id: string) => wire.serializable(
  (value): value is T => schema.safeParse(value).success,
  { id },
);

export const InspectorOverviewCodec = asWireCodec(inspectorOverviewSchema, 'gitspace/inspector-overview/v1');
export const InspectorIdentityCodec = asWireCodec(inspectorIdentitySchema, 'gitspace/inspector-identity/v1');
export const GoalRecordViewCodec = asWireCodec(goalRecordViewSchema, 'gitspace/goal-record-view/v1');
export const WorkflowViewCodec = asWireCodec(workflowViewSchema, 'gitspace/workflow-view/v1');
export const RubricViewCodec = asWireCodec(rubricViewSchema, 'gitspace/rubric-view/v1');
export const JournalEntryViewCodec = asWireCodec(journalEntryViewSchema, 'gitspace/journal-entry-view/v1');
export const ChangeGuideViewCodec = asWireCodec(changeGuideViewSchema, 'gitspace/change-guide-view/v1');
export const RepositoryTreeEntryCodec = asWireCodec(repositoryTreeEntrySchema, 'gitspace/repository-tree-entry/v1');
export const RepositoryStatusEntryCodec = asWireCodec(repositoryStatusEntrySchema, 'gitspace/repository-status-entry/v1');
export const RepositoryFileViewCodec = asWireCodec(repositoryFileViewSchema, 'gitspace/repository-file-view/v1');
export const RepositoryDiffViewCodec = asWireCodec(repositoryDiffViewSchema, 'gitspace/repository-diff-view/v1');
export const ReviewThreadViewCodec = asWireCodec(reviewThreadViewSchema, 'gitspace/review-thread-view/v1');
export const ServiceViewCodec = asWireCodec(serviceViewSchema, 'gitspace/service-view/v1');
export const ChangeGuideWorksheetCodec = asWireCodec(changeGuideWorksheetSchema, 'gitspace/change-guide-worksheet/v1');
export const PutGoalInputCodec = asWireCodec(putGoalInputSchema, 'gitspace/put-goal-input/v1');
export const AttachRequirementEvidenceInputCodec = asWireCodec(attachRequirementEvidenceInputSchema, 'gitspace/attach-requirement-evidence-input/v1');
export const PutWorkflowInputCodec = asWireCodec(putWorkflowInputSchema, 'gitspace/put-workflow-input/v1');
export const WaiveWorkflowGateInputCodec = asWireCodec(waiveWorkflowGateInputSchema, 'gitspace/waive-workflow-gate-input/v1');
export const PutRubricInputCodec = asWireCodec(putRubricInputSchema, 'gitspace/put-rubric-input/v1');
export const AppendRubricJudgmentInputCodec = asWireCodec(appendRubricJudgmentInputSchema, 'gitspace/append-rubric-judgment-input/v1');
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
