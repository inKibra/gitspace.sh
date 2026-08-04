import { z } from 'zod';

export const artifactKindSchema = z.enum(['screenshot', 'video', 'audio', 'test-output', 'note', 'file', 'url']);
export const generationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('command'), command: z.string() }),
]);
export const commandExpectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exit-zero') }),
  z.object({ kind: z.literal('stdout-contains'), needle: z.string() }),
  z.object({ kind: z.literal('stderr-empty') }),
  z.object({ kind: z.literal('output-matches'), pattern: z.string() }),
]);
export const judgmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }),
  z.object({ kind: z.literal('llm'), modelHint: z.string().optional() }),
  z.object({ kind: z.literal('command'), command: z.string(), expect: commandExpectationSchema }),
]);
export const evidenceSchema = z.object({
  id: z.string(), name: z.string(), meta: z.string(), source: z.enum(['manual', 'command']), createdAt: z.string(),
  body: z.string().optional(), url: z.string().optional(), originalPath: z.string().optional(), artifactPath: z.string().optional(),
  mimeType: z.string().optional(), sizeBytes: z.number().optional(), displayName: z.string().optional(), previewUrl: z.string().optional(),
  command: z.string().optional(), exitCode: z.number().optional(), stdout: z.string().optional(), stderr: z.string().optional(),
});
export const reviewSchema = z.object({
  id: z.string(), tone: z.enum(['green', 'amber', 'red']), who: z.string(), note: z.string(), createdAt: z.string(),
  createdBy: z.string().optional(), judgeType: z.enum(['human', 'llm', 'command']).optional(), score: z.number().optional(),
  cites: z.array(z.string()).optional(), rubricHash: z.string().optional(),
});
export const requirementSchema = z.object({
  id: z.string(), title: z.string(), kind: artifactKindSchema, required: z.boolean(), rubric: z.string(),
  status: z.enum(['missing', 'review', 'accepted']), generation: generationSchema, judgment: judgmentSchema,
  evidence: z.array(evidenceSchema), reviews: z.array(reviewSchema), wfPhase: z.string().optional(), sliceId: z.string().optional(),
});
export const timelineEventSchema = z.object({
  id: z.string(), requirementId: z.string().nullable(), tone: z.enum(['blue', 'amber', 'green', 'red', 'violet']),
  kind: z.enum(['contract', 'generation', 'review', 'readiness', 'phase', 'gate']), title: z.string(), body: z.string(), payload: z.string(),
  createdAt: z.string(), phase: z.string().optional(),
});
export const readinessSchema = z.object({
  status: z.enum(['ready', 'awaiting-review', 'not-ready']), summary: z.string(), detail: z.string(),
  totals: z.object({ total: z.number(), missing: z.number(), review: z.number(), accepted: z.number() }),
});
export const goalValidationSchema = z.object({
  reqOrder: z.array(z.string()), requirements: z.record(z.string(), requirementSchema), events: z.array(timelineEventSchema), readiness: readinessSchema.optional(),
});
export const goalDocSchema = z.object({
  bodyMarkdown: z.string(), updatedAt: z.string(), updatedBy: z.string().optional(),
  blocks: z.array(z.object({ id: z.string(), type: z.string(), data: z.unknown() })).optional(), exemplarBlockIds: z.array(z.string()).optional(),
});
export const sourceRefSchema = z.object({ type: z.enum(['linear', 'github', 'url', 'manual']), id: z.string().optional(), url: z.string().optional(), title: z.string().optional() });
export const goalRecordSchema = z.object({
  version: z.literal(2), id: z.string(), chainId: z.string(), title: z.string(), projectName: z.string(), phase: z.enum(['plan', 'code', 'review', 'ship']),
  plannedWorkspaceName: z.string().optional(), workspaceName: z.string().optional(), doc: goalDocSchema, validation: goalValidationSchema,
  sourceRefs: z.array(sourceRefSchema).optional(), createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().optional(),
});
import type { WorkspacePhase } from './config.js';

export type GoalPhase = WorkspacePhase;

// ─── Validation contract ────────────────────────────────────────────────────

export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type Generation = z.infer<typeof generationSchema>;
export type CommandExpectation = z.infer<typeof commandExpectationSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
export type RequirementStatus = 'missing' | 'review' | 'accepted';
export type EvidenceSource = 'manual' | 'command';

/** Persisted evidence model; distinct from presentational evidenceData/artifactRef in src/blocks/types/content.ts. */
export type Evidence = z.infer<typeof evidenceSchema>;
export type ReviewTone = 'green' | 'amber' | 'red';
export type ReviewJudgeType = 'human' | 'llm' | 'command';
export type Review = z.infer<typeof reviewSchema>;
export type Requirement = z.infer<typeof requirementSchema>;

export type TimelineEventTone = 'blue' | 'amber' | 'green' | 'red' | 'violet';
export type TimelineEventKind = 'contract' | 'generation' | 'review' | 'readiness' | 'phase' | 'gate';

export interface TimelineEvent {
  id: string;
  requirementId: string | null;
  tone: TimelineEventTone;
  kind: TimelineEventKind;
  title: string;
  body: string;
  payload: string;
  createdAt: string;
  /** Journal phase that was OPEN when this event was appended
   *  (phase-journal join). Absent on legacy events and outside phases. */
  phase?: string;
}

export type ReadinessStatus = 'ready' | 'awaiting-review' | 'not-ready';

export interface ReadinessTotals {
  total: number;
  missing: number;
  review: number;
  accepted: number;
}

export interface Readiness {
  status: ReadinessStatus;
  summary: string;
  detail: string;
  totals: ReadinessTotals;
}

export type GoalValidation = z.infer<typeof goalValidationSchema>;

export interface GoalDoc {
  bodyMarkdown: string;
  updatedAt: string;
  updatedBy?: string;
  /** Block-composed doc (mock GoalDoc vocabulary: intent/boundaries/anti-shortcut/
   *  plan/evidence-shape/mini-app). Rendered through the block pipeline when
   *  present; bodyMarkdown remains the fallback. */
  blocks?: Array<{ id: string; type: string; data: unknown }>;
  /** Block ids the user starred as exemplars. */
  exemplarBlockIds?: string[];
}

export interface SourceRef {
  type: 'linear' | 'github' | 'url' | 'manual';
  id?: string;
  url?: string;
  title?: string;
}

export type GoalRecord = z.infer<typeof goalRecordSchema>;

// ─── Chain / kanban / stack ─────────────────────────────────────────────────

export interface GoalChain {
  id: string;
  title: string;
  projectName: string;
  goalIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GoalChainState {
  version: 1;
  updatedAt: string;
  chains: GoalChain[];
}

/** One goal in a chain summary — enough for the create-goal UI to compute
 *  which insert positions are legal (a new 'plan' goal cannot be placed at or
 *  before a goal whose effective phase is past 'plan'). */
export interface GoalChainSummaryGoal {
  id: string;
  title: string;
  /** Effective phase (planned goals always read as 'plan'). */
  phase: GoalPhase;
  status: 'planned' | 'workspace-backed' | 'archived';
}

/** A project chain projected for the chain-picker: title + ordered goals with
 *  their effective phases. Returned by the `listGoalChains` backend RPC. */
export interface GoalChainSummary {
  id: string;
  title: string;
  goals: GoalChainSummaryGoal[];
}

export interface GoalKanbanItem {
  id: string;
  chainId: string;
  chainTitle: string;
  title: string;
  projectName: string;
  phase: GoalPhase;
  plannedWorkspaceName?: string;
  workspaceName?: string;
  status: 'planned' | 'workspace-backed' | 'archived';
  chainPosition: number;
  chainLength: number;
  previousGoalId?: string;
  previousWorkspaceName?: string;
  /** Effective phase of the previous chain goal (if any). Lets the board tell
   *  when a planned goal is next-up: its predecessor has shipped. */
  previousPhase?: GoalPhase;
  blockedReason?: string;
  doc?: GoalDoc;
  validation?: GoalValidation;
  sourceRefs?: SourceRef[];
  updatedAt?: string;
}

export interface ChainStackEdgeStatus {
  parentGoalId: string;
  childGoalId: string;
  parentWorkspace?: string;
  childWorkspace?: string;
  parentBranch?: string;
  childBranch?: string;
  parentHead?: string;
  childHead?: string;
  status: 'aligned' | 'needs-rebase' | 'missing-workspace' | 'missing-branch' | 'dirty-worktree' | 'unknown';
  message?: string;
}

export interface ChainStackStatus {
  status: string;
  currentGoalId: string;
  youAreNext: boolean;
  edges: ChainStackEdgeStatus[];
}

export interface GoalUpdateInput {
  title?: string;
  phase?: GoalPhase;
  plannedWorkspaceName?: string;
  doc?: GoalDoc;
  validation?: GoalValidation;
  sourceRefs?: SourceRef[];
}

export interface WorkspacePhaseCascadeItem {
  workspaceName: string;
  goalId: string;
  title: string;
  from: WorkspacePhase;
  to: WorkspacePhase;
}

export interface WorkspacePhaseChangePreview {
  allowed: boolean;
  requiresCascade: boolean;
  requestedPhase: WorkspacePhase;
  maxAllowedPhase?: WorkspacePhase;
  affected: WorkspacePhaseCascadeItem[];
  message: string;
}
