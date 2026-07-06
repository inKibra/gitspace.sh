import type { WorkspacePhase } from './config.js';

export type GoalPhase = WorkspacePhase;

// ─── Validation contract ────────────────────────────────────────────────────

export type ArtifactKind = 'screenshot' | 'video' | 'test-output' | 'note' | 'file' | 'url';

export type Generation =
  | { kind: 'manual' }
  | { kind: 'command'; command: string };

export type CommandExpectation =
  | { kind: 'exit-zero' }
  | { kind: 'stdout-contains'; needle: string }
  | { kind: 'stderr-empty' }
  | { kind: 'output-matches'; pattern: string };

export type Judgment =
  | { kind: 'human' }
  | { kind: 'llm'; modelHint?: string }
  | { kind: 'command'; command: string; expect: CommandExpectation };

export type RequirementStatus = 'missing' | 'review' | 'accepted';

export type EvidenceSource = 'manual' | 'command';

export interface Evidence {
  id: string;
  name: string;
  meta: string;
  source: EvidenceSource;
  createdAt: string;
  body?: string;
  url?: string;
  originalPath?: string;
  artifactPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  displayName?: string;
  previewUrl?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export type ReviewTone = 'green' | 'amber' | 'red';

export type ReviewJudgeType = 'human' | 'llm' | 'command';

export interface Review {
  id: string;
  tone: ReviewTone;
  who: string;
  note: string;
  createdAt: string;
  createdBy?: string;
  /** Which judge produced this review. Optional for back-compat. */
  judgeType?: ReviewJudgeType;
  /** 0-100 confidence/quality score, when the judge produces one. */
  score?: number;
  /** Evidence ids this review examined or produced. */
  cites?: string[];
  /** Hash of the requirement's rubric at judgment time (canon pin,
   *  docs/REVIEW-GUIDE.md). Acceptance is stale when it no longer matches. */
  rubricHash?: string;
}

export interface Requirement {
  id: string;
  title: string;
  kind: ArtifactKind;
  required: boolean;
  rubric: string;
  status: RequirementStatus;
  generation: Generation;
  judgment: Judgment;
  evidence: Evidence[];
  reviews: Review[];
}

export type TimelineEventTone = 'blue' | 'amber' | 'green' | 'red' | 'violet';
export type TimelineEventKind = 'contract' | 'generation' | 'review' | 'readiness';

export interface TimelineEvent {
  id: string;
  requirementId: string | null;
  tone: TimelineEventTone;
  kind: TimelineEventKind;
  title: string;
  body: string;
  payload: string;
  createdAt: string;
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

export interface GoalValidation {
  reqOrder: string[];
  requirements: Record<string, Requirement>;
  events: TimelineEvent[];
  readiness?: Readiness;
}

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

export interface GoalRecord {
  version: 2;
  id: string;
  chainId: string;
  title: string;
  projectName: string;
  phase: GoalPhase;
  plannedWorkspaceName?: string;
  workspaceName?: string;
  doc: GoalDoc;
  validation: GoalValidation;
  sourceRefs?: SourceRef[];
  createdAt: string;
  updatedAt: string;
}

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

export interface GoalKanbanItem {
  id: string;
  chainId: string;
  chainTitle: string;
  title: string;
  projectName: string;
  phase: GoalPhase;
  plannedWorkspaceName?: string;
  workspaceName?: string;
  status: 'planned' | 'workspace-backed';
  chainPosition: number;
  chainLength: number;
  previousGoalId?: string;
  previousWorkspaceName?: string;
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
