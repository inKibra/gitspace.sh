import { DurableObject } from 'cloudflare:workers';
import {
  INSPECTOR_EVIDENCE_HISTORY_LIMIT,
  appendJournalEntryInputSchema,
  appendReviewMessageInputSchema,
  appendRubricJudgmentInputSchema,
  attachRequirementEvidenceInputSchema,
  changeGuideViewSchema,
  createReviewThreadInputSchema,
  endJournalPhaseInputSchema,
  evidenceReferenceSchema,
  goalRecordViewSchema,
  inspectorIdentitySchema,
  inspectorOverviewSchema,
  journalEntryViewSchema,
  markGuideSectionReadInputSchema,
  putChangeGuideInputSchema,
  putGoalInputSchema,
  putRubricInputSchema,
  putWorkflowInputSchema,
  resolveReviewThreadInputSchema,
  reviewAnchorContextSchema,
  reviewAnchorSchema,
  reviewMessageViewSchema,
  reviewThreadViewSchema,
  rubricJudgmentSchema,
  rubricViewSchema,
  setGuideApprovalInputSchema,
  startJournalPhaseInputSchema,
  waiveWorkflowGateInputSchema,
  workflowGateWaiverSchema,
  workflowNodeSchema,
  workflowViewSchema,
  type AppendJournalEntryInput,
  type AppendReviewMessageInput,
  type AppendRubricJudgmentInput,
  type AttachRequirementEvidenceInput,
  type ChangeGuideView,
  type CreateReviewThreadInput,
  type EndJournalPhaseInput,
  type EvidenceReference,
  type GoalRecordView,
  type InspectorIdentity,
  type InspectorOverview,
  type JournalDelta,
  type JournalEntryView,
  type JournalStateSnapshot,
  type MarkGuideSectionReadInput,
  type PutChangeGuideInput,
  type PutGoalInput,
  type PutRubricInput,
  type PutWorkflowInput,
  type ResolveReviewThreadInput,
  type ReviewAnchorContext,
  type ReviewThreadView,
  type RubricJudgment,
  type RubricView,
  type SetGuideApprovalInput,
  type StartJournalPhaseInput,
  type WaiveWorkflowGateInput,
  type WorkflowGateWaiver,
  type WorkflowNode,
  type WorkflowView,
} from '@gitspace/protocol/inspector-contract';
import type { z } from 'zod';

interface MetaRow extends Record<string, SqlStorageValue> {
  project_id: string;
  space_id: string;
  revision: number;
}
interface GoalRow extends Record<string, SqlStorageValue> {
  goal_id: string;
  revision: number;
  title: string;
  summary: string;
  phase: GoalRecordView['phase'];
  created_at: string;
  updated_at: string;
  updated_by: string;
}
interface RequirementRow extends Record<string, SqlStorageValue> {
  requirement_id: string;
  ordinal: number;
  title: string;
  description: string;
  required: number;
  status: GoalRecordView['requirements'][number]['status'];
  workflow_node_id: string | null;
  criterion_id: string | null;
}
interface EvidenceRow extends Record<string, SqlStorageValue> {
  value_json: string;
}
interface DocumentRow extends Record<string, SqlStorageValue> {
  document_id: string;
  revision: number;
  title: string;
  description: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}
interface JsonOrdinalRow extends Record<string, SqlStorageValue> {
  ordinal: number;
  value_json: string;
}
interface WaiverRow extends Record<string, SqlStorageValue> {
  waiver_id: string;
  reason: string;
  actor_id: string;
  actor_kind: 'human';
  created_at: string;
}
interface JudgmentRow extends Record<string, SqlStorageValue> {
  value_json: string;
}
interface JournalRow extends Record<string, SqlStorageValue> {
  sequence: number;
  entry_id: string;
  kind: JournalEntryView['kind'];
  phase_run_id: string | null;
  phase: string;
  title: string;
  body: string;
  outcome: string | null;
  decisions_json: string;
  surprises_json: string;
  evidence_json: string;
  snapshot_json: string | null;
  delta_json: string | null;
  reverted_json: string | null;
  created_at: string;
  created_by: string;
}
interface GuideRow extends Record<string, SqlStorageValue> {
  revision: number;
  head_commit: string;
  base_ref: string;
  title: string;
  created_at: string;
  created_by: string;
}
interface ReviewerStateRow extends Record<string, SqlStorageValue> {
  reviewer_id: string;
  decision: ChangeGuideView['reviewerStates'][number]['decision'];
  note: string | null;
  updated_at: string;
}
interface ReadSectionRow extends Record<string, SqlStorageValue> {
  section_id: string;
}
interface ThreadRow extends Record<string, SqlStorageValue> {
  thread_id: string;
  revision: number;
  anchor_json: string;
  decision: ReviewThreadView['decision'];
  resolved: number;
  created_at: string;
  updated_at: string;
}
interface MessageRow extends Record<string, SqlStorageValue> {
  value_json: string;
}

export class InspectorConflictError extends Error {
  readonly name = 'InspectorConflictError';

  constructor(readonly resource: string, readonly expected: number, readonly actual: number) {
    super(`${resource} revision conflict: expected ${expected}, actual ${actual}`);
  }
}

export class InspectorStateError extends Error {
  readonly name = 'InspectorStateError';
}

export class SpaceContextDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  bootstrap(input: InspectorIdentity): InspectorIdentity {
    const identity = inspectorIdentitySchema.parse(input);
    const row = this.meta();
    if (row) {
      if (row.project_id !== identity.projectId || row.space_id !== identity.spaceId) throw new InspectorStateError('Inspector authority identity is immutable');
      return identity;
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO inspector_meta (id, project_id, space_id, revision) VALUES (1, ?, ?, 0)',
      identity.projectId,
      identity.spaceId,
    );
    return identity;
  }

  getOverview(input: InspectorIdentity, reviewContext?: ReviewAnchorContext): InspectorOverview {
    const identity = this.requireIdentity(input);
    const context = reviewContext === undefined ? undefined : reviewAnchorContextSchema.parse(reviewContext);
    const journal = this.listJournal(identity);
    const openPhase = this.openJournalPhase();
    const threads = this.readThreads(identity, context);
    return inspectorOverviewSchema.parse({
      ...identity,
      revision: this.meta()!.revision,
      goal: this.readGoal(identity),
      workflow: this.readWorkflow(identity),
      rubric: this.readRubric(identity),
      journal: { entries: journal.length, openPhaseRunId: openPhase?.phase_run_id ?? null, recent: journal.slice(-25).reverse() },
      changeGuide: this.readChangeGuide(identity),
      review: { total: threads.length, unresolved: threads.filter((thread) => !thread.resolved).length },
    });
  }

  getGoal(input: InspectorIdentity): GoalRecordView | null {
    return this.readGoal(this.requireIdentity(input));
  }

  putGoal(input: PutGoalInput): GoalRecordView {
    const parsed = putGoalInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const current = this.goalRow();
      this.assertRevision('goal', parsed.expectedRevision, current?.revision ?? 0);
      const revision = (current?.revision ?? 0) + 1;
      const timestamp = new Date().toISOString();
      if (current) {
        this.ctx.storage.sql.exec(
          'UPDATE inspector_goals SET goal_id = ?, revision = ?, title = ?, summary = ?, phase = ?, updated_at = ?, updated_by = ? WHERE id = 1',
          parsed.goal.id, revision, parsed.goal.title, parsed.goal.summary, parsed.goal.phase, timestamp, parsed.goal.updatedBy,
        );
      } else {
        this.ctx.storage.sql.exec(
          'INSERT INTO inspector_goals (id, goal_id, revision, title, summary, phase, created_at, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
          parsed.goal.id, revision, parsed.goal.title, parsed.goal.summary, parsed.goal.phase, timestamp, timestamp, parsed.goal.updatedBy,
        );
      }
      this.ctx.storage.sql.exec('DELETE FROM inspector_goal_requirements');
      this.ctx.storage.sql.exec('DELETE FROM inspector_requirement_evidence');
      for (const [ordinal, requirement] of parsed.goal.requirements.entries()) {
        this.ctx.storage.sql.exec(
          'INSERT INTO inspector_goal_requirements (requirement_id, ordinal, title, description, required, status, workflow_node_id, criterion_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          requirement.id, ordinal, requirement.title, requirement.description, requirement.required ? 1 : 0, requirement.status, requirement.workflowNodeId, requirement.criterionId,
        );
        for (const [evidenceOrdinal, evidence] of requirement.evidence.entries()) {
          this.ctx.storage.sql.exec(
            'INSERT INTO inspector_requirement_evidence (requirement_id, ordinal, value_json) VALUES (?, ?, ?)',
            requirement.id, evidenceOrdinal, JSON.stringify(evidence),
          );
        }
      }
      this.bump();
      return this.readGoal(identity)!;
    });
  }

  attachRequirementEvidence(input: AttachRequirementEvidenceInput): GoalRecordView {
    const parsed = attachRequirementEvidenceInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const goal = this.goalRow();
      if (!goal) throw new InspectorStateError('Goal does not exist');
      this.assertRevision('goal', parsed.expectedRevision, goal.revision);
      const requirement = this.ctx.storage.sql.exec<RequirementRow>(
        'SELECT requirement_id, ordinal, title, description, required, status, workflow_node_id, criterion_id FROM inspector_goal_requirements WHERE requirement_id = ?',
        parsed.requirementId,
      ).toArray()[0];
      if (!requirement) throw new InspectorStateError(`Requirement ${parsed.requirementId} does not exist`);
      const bounds = this.ctx.storage.sql.exec<{ count: number; first_ordinal: number | null; last_ordinal: number | null }>(
        'SELECT COUNT(*) AS count, MIN(ordinal) AS first_ordinal, MAX(ordinal) AS last_ordinal FROM inspector_requirement_evidence WHERE requirement_id = ?',
        parsed.requirementId,
      ).one();
      if (bounds.count >= INSPECTOR_EVIDENCE_HISTORY_LIMIT && bounds.first_ordinal !== null) {
        this.ctx.storage.sql.exec('DELETE FROM inspector_requirement_evidence WHERE requirement_id = ? AND ordinal = ?', parsed.requirementId, bounds.first_ordinal);
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO inspector_requirement_evidence (requirement_id, ordinal, value_json) VALUES (?, ?, ?)',
        parsed.requirementId, (bounds.last_ordinal ?? -1) + 1, JSON.stringify(parsed.evidence),
      );
      const nextRevision = goal.revision + 1;
      const timestamp = new Date().toISOString();
      this.ctx.storage.sql.exec('UPDATE inspector_goal_requirements SET status = ? WHERE requirement_id = ?', 'review', parsed.requirementId);
      this.ctx.storage.sql.exec('UPDATE inspector_goals SET revision = ?, updated_at = ? WHERE id = 1', nextRevision, timestamp);
      this.bump();
      return this.readGoal(identity)!;
    });
  }

  getWorkflow(input: InspectorIdentity): WorkflowView | null {
    return this.readWorkflow(this.requireIdentity(input));
  }

  putWorkflow(input: PutWorkflowInput): WorkflowView {
    const parsed = putWorkflowInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const current = this.workflowRow();
      this.assertRevision('workflow', parsed.expectedRevision, current?.revision ?? 0);
      const revision = (current?.revision ?? 0) + 1;
      const timestamp = new Date().toISOString();
      if (current) {
        this.ctx.storage.sql.exec(
          'UPDATE inspector_workflows SET document_id = ?, revision = ?, title = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = 1',
          parsed.workflow.id, revision, parsed.workflow.title, parsed.workflow.description, timestamp, parsed.workflow.updatedBy,
        );
      } else {
        this.ctx.storage.sql.exec(
          'INSERT INTO inspector_workflows (id, document_id, revision, title, description, created_at, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
          parsed.workflow.id, revision, parsed.workflow.title, parsed.workflow.description, timestamp, timestamp, parsed.workflow.updatedBy,
        );
      }
      this.ctx.storage.sql.exec('DELETE FROM inspector_workflow_nodes');
      this.ctx.storage.sql.exec('DELETE FROM inspector_workflow_edges');
      for (const [ordinal, node] of parsed.workflow.nodes.entries()) {
        const stored = node.kind === 'gate' ? { ...node, satisfied: false, passable: false, waivers: [] } : node;
        this.ctx.storage.sql.exec('INSERT INTO inspector_workflow_nodes (node_id, ordinal, kind, value_json) VALUES (?, ?, ?, ?)', node.id, ordinal, node.kind, JSON.stringify(stored));
      }
      for (const [ordinal, edge] of parsed.workflow.edges.entries()) {
        this.ctx.storage.sql.exec('INSERT INTO inspector_workflow_edges (edge_id, ordinal, value_json) VALUES (?, ?, ?)', edge.id, ordinal, JSON.stringify(edge));
      }
      this.bump();
      return this.readWorkflow(identity)!;
    });
  }

  waiveWorkflowGate(input: WaiveWorkflowGateInput): WorkflowView {
    const parsed = waiveWorkflowGateInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const workflow = this.workflowRow();
      if (!workflow) throw new InspectorStateError('Workflow does not exist');
      this.assertRevision('workflow', parsed.expectedRevision, workflow.revision);
      const node = this.ctx.storage.sql.exec<{ kind: string }>('SELECT kind FROM inspector_workflow_nodes WHERE node_id = ?', parsed.gateId).toArray()[0];
      if (node?.kind !== 'gate') throw new InspectorStateError(`Workflow gate ${parsed.gateId} does not exist`);
      this.ctx.storage.sql.exec(
        'INSERT INTO inspector_workflow_gate_waivers (waiver_id, gate_id, reason, actor_id, actor_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        parsed.waiverId, parsed.gateId, parsed.reason, parsed.actorId, parsed.actorKind, new Date().toISOString(),
      );
      this.ctx.storage.sql.exec('UPDATE inspector_workflows SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = 1', new Date().toISOString(), parsed.actorId);
      this.bump();
      return this.readWorkflow(identity)!;
    });
  }

  getRubric(input: InspectorIdentity): RubricView | null {
    return this.readRubric(this.requireIdentity(input));
  }

  putRubric(input: PutRubricInput): RubricView {
    const parsed = putRubricInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const current = this.rubricRow();
      this.assertRevision('rubric', parsed.expectedRevision, current?.revision ?? 0);
      const revision = (current?.revision ?? 0) + 1;
      const timestamp = new Date().toISOString();
      if (current) {
        this.ctx.storage.sql.exec(
          'UPDATE inspector_rubrics SET document_id = ?, revision = ?, title = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = 1',
          parsed.rubric.id, revision, parsed.rubric.title, parsed.rubric.description, timestamp, parsed.rubric.updatedBy,
        );
      } else {
        this.ctx.storage.sql.exec(
          'INSERT INTO inspector_rubrics (id, document_id, revision, title, description, created_at, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
          parsed.rubric.id, revision, parsed.rubric.title, parsed.rubric.description, timestamp, timestamp, parsed.rubric.updatedBy,
        );
      }
      this.ctx.storage.sql.exec('DELETE FROM inspector_rubric_criteria');
      for (const [ordinal, criterion] of parsed.rubric.criteria.entries()) {
        this.ctx.storage.sql.exec('INSERT INTO inspector_rubric_criteria (criterion_id, ordinal, value_json) VALUES (?, ?, ?)', criterion.id, ordinal, JSON.stringify(criterion));
      }
      this.bump();
      return this.readRubric(identity)!;
    });
  }

  appendRubricJudgment(input: AppendRubricJudgmentInput): RubricView {
    const parsed = appendRubricJudgmentInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const rubric = this.rubricRow();
      if (!rubric) throw new InspectorStateError('Rubric does not exist');
      this.assertRevision('rubric', parsed.expectedRevision, rubric.revision);
      const criterionRow = this.ctx.storage.sql.exec<JsonOrdinalRow>('SELECT ordinal, value_json FROM inspector_rubric_criteria WHERE criterion_id = ?', parsed.criterionId).toArray()[0];
      if (!criterionRow) throw new InspectorStateError(`Rubric criterion ${parsed.criterionId} does not exist`);
      const criterion = putRubricInputSchema.shape.rubric.shape.criteria.element.parse(JSON.parse(criterionRow.value_json));
      if (criterion.judge.kind !== parsed.judgment.kind) throw new InspectorStateError(`Criterion ${parsed.criterionId} requires a ${criterion.judge.kind} judgment`);
      const sequence = this.ctx.storage.sql.exec<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM inspector_rubric_judgments WHERE criterion_id = ?', parsed.criterionId).one().sequence;
      this.ctx.storage.sql.exec(
        'INSERT INTO inspector_rubric_judgments (judgment_id, criterion_id, sequence, rubric_revision, value_json) VALUES (?, ?, ?, ?, ?)',
        parsed.judgment.id, parsed.criterionId, sequence, rubric.revision + 1, JSON.stringify(parsed.judgment),
      );
      const timestamp = new Date().toISOString();
      this.ctx.storage.sql.exec('UPDATE inspector_rubrics SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = 1', timestamp, parsed.judgment.actorId);
      const status = parsed.judgment.verdict === 'pass' ? 'accepted' : 'review';
      const goalChanges = this.ctx.storage.sql.exec('UPDATE inspector_goal_requirements SET status = ? WHERE criterion_id = ?', status, parsed.criterionId).rowsWritten;
      if (goalChanges > 0) this.ctx.storage.sql.exec('UPDATE inspector_goals SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = 1', timestamp, parsed.judgment.actorId);
      this.bump();
      return this.readRubric(identity)!;
    });
  }

  listJournal(input: InspectorIdentity): JournalEntryView[] {
    const identity = this.requireIdentity(input);
    return this.ctx.storage.sql.exec<JournalRow>(
      'SELECT sequence, entry_id, kind, phase_run_id, phase, title, body, outcome, decisions_json, surprises_json, evidence_json, snapshot_json, delta_json, reverted_json, created_at, created_by FROM inspector_journal_entries ORDER BY sequence',
    ).toArray().map((row) => this.journalRecord(identity, row));
  }

  startJournalPhase(input: StartJournalPhaseInput): JournalEntryView {
    const parsed = startJournalPhaseInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const open = this.openJournalPhase();
      if (open) throw new InspectorStateError(`Journal phase ${open.phase} is still open`);
      const snapshot = this.captureSnapshot(identity, parsed.repository);
      const entry = this.insertJournal(identity, {
        id: parsed.entryId,
        kind: 'phase-start',
        phaseRunId: parsed.phaseRunId,
        phase: parsed.phase,
        title: `${parsed.phase} started`,
        body: parsed.intent,
        outcome: null,
        decisions: [],
        surprises: [],
        evidence: [],
        snapshot,
        delta: null,
        reverted: null,
        createdBy: parsed.createdBy,
      });
      this.bump();
      return entry;
    });
  }

  endJournalPhase(input: EndJournalPhaseInput): JournalEntryView {
    const parsed = endJournalPhaseInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const start = this.ctx.storage.sql.exec<JournalRow>(
        "SELECT sequence, entry_id, kind, phase_run_id, phase, title, body, outcome, decisions_json, surprises_json, evidence_json, snapshot_json, delta_json, reverted_json, created_at, created_by FROM inspector_journal_entries WHERE phase_run_id = ? AND kind = 'phase-start' ORDER BY sequence DESC LIMIT 1",
        parsed.phaseRunId,
      ).toArray()[0];
      if (!start) throw new InspectorStateError(`Journal phase run ${parsed.phaseRunId} does not exist`);
      const ended = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM inspector_journal_entries WHERE phase_run_id = ? AND kind = 'phase-end'", parsed.phaseRunId).one().count;
      if (ended > 0) throw new InspectorStateError(`Journal phase run ${parsed.phaseRunId} is already closed`);
      if (!parsed.revert) this.assertPhaseGatesPassable(identity, start.phase);
      const startSnapshot = journalEntryViewSchema.shape.snapshot.unwrap().parse(JSON.parse(start.snapshot_json!));
      const endSnapshot = this.captureSnapshot(identity, parsed.repository);
      const entry = this.insertJournal(identity, {
        id: parsed.entryId,
        kind: 'phase-end',
        phaseRunId: parsed.phaseRunId,
        phase: start.phase,
        title: `${start.phase} ended`,
        body: parsed.outcome,
        outcome: parsed.outcome,
        decisions: parsed.decisions,
        surprises: parsed.surprises,
        evidence: [],
        snapshot: endSnapshot,
        delta: computeJournalDelta(startSnapshot, endSnapshot),
        reverted: parsed.revert,
        createdBy: parsed.createdBy,
      });
      this.bump();
      return entry;
    });
  }

  appendJournalEntry(input: AppendJournalEntryInput): JournalEntryView {
    const parsed = appendJournalEntryInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const entry = this.insertJournal(identity, {
        id: parsed.id,
        kind: parsed.kind,
        phaseRunId: null,
        phase: parsed.phase,
        title: parsed.title,
        body: parsed.body,
        outcome: parsed.outcome,
        decisions: parsed.decisions,
        surprises: [],
        evidence: parsed.evidence,
        snapshot: null,
        delta: null,
        reverted: null,
        createdBy: parsed.createdBy,
      });
      this.bump();
      return entry;
    });
  }

  getChangeGuide(input: InspectorIdentity): ChangeGuideView | null {
    return this.readChangeGuide(this.requireIdentity(input));
  }

  putChangeGuide(input: PutChangeGuideInput): ChangeGuideView {
    const parsed = putChangeGuideInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const actual = this.latestGuideRow()?.revision ?? 0;
      this.assertRevision('change-guide', parsed.expectedRevision, actual);
      const revision = actual + 1;
      const timestamp = new Date().toISOString();
      this.ctx.storage.sql.exec(
        'INSERT INTO inspector_guide_revisions (revision, head_commit, base_ref, title, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        revision, parsed.guide.headCommit, parsed.guide.baseRef, parsed.guide.title, timestamp, parsed.guide.createdBy,
      );
      for (const [ordinal, section] of parsed.guide.sections.entries()) {
        this.ctx.storage.sql.exec('INSERT INTO inspector_guide_sections (revision, section_id, ordinal, value_json) VALUES (?, ?, ?, ?)', revision, section.id, ordinal, JSON.stringify(section));
      }
      this.bump();
      return this.readChangeGuide(identity)!;
    });
  }

  markGuideSectionRead(input: MarkGuideSectionReadInput): ChangeGuideView {
    const parsed = markGuideSectionReadInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const guide = this.requireGuideVersion(parsed.revision, parsed.headCommit);
      const section = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM inspector_guide_sections WHERE revision = ? AND section_id = ?', guide.revision, parsed.sectionId).one().count;
      if (section === 0) throw new InspectorStateError(`Guide section ${parsed.sectionId} does not exist at revision ${guide.revision}`);
      const timestamp = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "INSERT INTO inspector_guide_reviewer_state (revision, head_commit, reviewer_id, decision, note, updated_at) VALUES (?, ?, ?, 'pending', NULL, ?) ON CONFLICT (revision, reviewer_id) DO UPDATE SET updated_at = excluded.updated_at",
        guide.revision, guide.head_commit, parsed.reviewerId, timestamp,
      );
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO inspector_guide_section_reads (revision, reviewer_id, section_id, read_at) VALUES (?, ?, ?, ?)', guide.revision, parsed.reviewerId, parsed.sectionId, timestamp);
      this.bump();
      return this.readChangeGuide(identity)!;
    });
  }

  setGuideApproval(input: SetGuideApprovalInput): ChangeGuideView {
    const parsed = setGuideApprovalInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const guide = this.requireGuideVersion(parsed.revision, parsed.headCommit);
      if (parsed.decision === 'approved') {
        const totals = this.ctx.storage.sql.exec<{ sections: number; read_sections: number }>(
          'SELECT (SELECT COUNT(*) FROM inspector_guide_sections WHERE revision = ?) AS sections, (SELECT COUNT(*) FROM inspector_guide_section_reads WHERE revision = ? AND reviewer_id = ?) AS read_sections',
          guide.revision, guide.revision, parsed.reviewerId,
        ).one();
        if (totals.read_sections !== totals.sections) throw new InspectorStateError('Every Change Guide section must be read before approval');
      }
      const timestamp = new Date().toISOString();
      this.ctx.storage.sql.exec(
        'INSERT INTO inspector_guide_reviewer_state (revision, head_commit, reviewer_id, decision, note, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (revision, reviewer_id) DO UPDATE SET head_commit = excluded.head_commit, decision = excluded.decision, note = excluded.note, updated_at = excluded.updated_at',
        guide.revision, guide.head_commit, parsed.reviewerId, parsed.decision, parsed.note, timestamp,
      );
      this.bump();
      return this.readChangeGuide(identity)!;
    });
  }

  listReviewThreads(input: InspectorIdentity, context?: ReviewAnchorContext): ReviewThreadView[] {
    const identity = this.requireIdentity(input);
    return this.readThreads(identity, context === undefined ? undefined : reviewAnchorContextSchema.parse(context));
  }

  createReviewThread(input: CreateReviewThreadInput, context?: ReviewAnchorContext): ReviewThreadView {
    const parsed = createReviewThreadInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const timestamp = new Date().toISOString();
      this.ctx.storage.sql.exec(
        'INSERT INTO inspector_review_threads (thread_id, revision, anchor_json, decision, resolved, created_at, updated_at) VALUES (?, 1, ?, ?, 0, ?, ?)',
        parsed.id, JSON.stringify(parsed.anchor), parsed.decision, timestamp, timestamp,
      );
      this.ctx.storage.sql.exec('INSERT INTO inspector_review_messages (message_id, thread_id, sequence, value_json) VALUES (?, ?, 1, ?)', parsed.message.id, parsed.id, JSON.stringify(parsed.message));
      this.bump();
      return this.readThread(identity, parsed.id, context === undefined ? undefined : reviewAnchorContextSchema.parse(context));
    });
  }

  appendReviewMessage(input: AppendReviewMessageInput, context?: ReviewAnchorContext): ReviewThreadView {
    const parsed = appendReviewMessageInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const thread = this.threadRow(parsed.threadId);
      if (!thread) throw new InspectorStateError(`Review thread ${parsed.threadId} does not exist`);
      this.assertRevision(`review-thread:${parsed.threadId}`, parsed.expectedRevision, thread.revision);
      const sequence = this.ctx.storage.sql.exec<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM inspector_review_messages WHERE thread_id = ?', parsed.threadId).one().sequence;
      this.ctx.storage.sql.exec('INSERT INTO inspector_review_messages (message_id, thread_id, sequence, value_json) VALUES (?, ?, ?, ?)', parsed.message.id, parsed.threadId, sequence, JSON.stringify(parsed.message));
      this.ctx.storage.sql.exec('UPDATE inspector_review_threads SET revision = revision + 1, updated_at = ? WHERE thread_id = ?', new Date().toISOString(), parsed.threadId);
      this.bump();
      return this.readThread(identity, parsed.threadId, context === undefined ? undefined : reviewAnchorContextSchema.parse(context));
    });
  }

  resolveReviewThread(input: ResolveReviewThreadInput, context?: ReviewAnchorContext): ReviewThreadView {
    const parsed = resolveReviewThreadInputSchema.parse(input);
    const identity = this.requireIdentity(parsed);
    return this.ctx.storage.transactionSync(() => {
      const thread = this.threadRow(parsed.threadId);
      if (!thread) throw new InspectorStateError(`Review thread ${parsed.threadId} does not exist`);
      this.assertRevision(`review-thread:${parsed.threadId}`, parsed.expectedRevision, thread.revision);
      this.ctx.storage.sql.exec(
        'UPDATE inspector_review_threads SET revision = revision + 1, resolved = ?, decision = ?, updated_at = ? WHERE thread_id = ?',
        parsed.resolved ? 1 : 0, parsed.decision, new Date().toISOString(), parsed.threadId,
      );
      this.bump();
      return this.readThread(identity, parsed.threadId, context === undefined ? undefined : reviewAnchorContextSchema.parse(context));
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _inspector_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const version = this.ctx.storage.sql.exec<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM _inspector_schema_migrations').one().version;
    if (version >= 1) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE inspector_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      CREATE TABLE inspector_goals (
        id INTEGER PRIMARY KEY CHECK (id = 1), goal_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
        title TEXT NOT NULL, summary TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('plan','code','review','ship')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
      );
      CREATE TABLE inspector_goal_requirements (
        requirement_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL,
        required INTEGER NOT NULL CHECK (required IN (0,1)), status TEXT NOT NULL CHECK (status IN ('missing','review','accepted')),
        workflow_node_id TEXT, criterion_id TEXT
      );
      CREATE TABLE inspector_requirement_evidence (
        requirement_id TEXT NOT NULL, ordinal INTEGER NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY (requirement_id, ordinal)
      );
      CREATE TABLE inspector_workflows (
        id INTEGER PRIMARY KEY CHECK (id = 1), document_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
        title TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
      );
      CREATE TABLE inspector_workflow_nodes (
        node_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('phase','artifact','gate')), value_json TEXT NOT NULL
      );
      CREATE TABLE inspector_workflow_edges (
        edge_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, value_json TEXT NOT NULL
      );
      CREATE TABLE inspector_workflow_gate_waivers (
        waiver_id TEXT PRIMARY KEY, gate_id TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind = 'human'), created_at TEXT NOT NULL
      );
      CREATE INDEX inspector_gate_waivers_by_gate ON inspector_workflow_gate_waivers (gate_id, created_at);
      CREATE TABLE inspector_rubrics (
        id INTEGER PRIMARY KEY CHECK (id = 1), document_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
        title TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
      );
      CREATE TABLE inspector_rubric_criteria (
        criterion_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, value_json TEXT NOT NULL
      );
      CREATE TABLE inspector_rubric_judgments (
        judgment_id TEXT PRIMARY KEY, criterion_id TEXT NOT NULL, sequence INTEGER NOT NULL, rubric_revision INTEGER NOT NULL, value_json TEXT NOT NULL,
        UNIQUE (criterion_id, sequence)
      );
      CREATE INDEX inspector_judgments_by_criterion ON inspector_rubric_judgments (criterion_id, sequence);
      CREATE TABLE inspector_journal_entries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('phase-start','phase-end','narrative','decision','artifact')),
        phase_run_id TEXT, phase TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, outcome TEXT,
        decisions_json TEXT NOT NULL, surprises_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
        snapshot_json TEXT, delta_json TEXT, reverted_json TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX inspector_one_phase_start ON inspector_journal_entries (phase_run_id) WHERE kind = 'phase-start';
      CREATE UNIQUE INDEX inspector_one_phase_end ON inspector_journal_entries (phase_run_id) WHERE kind = 'phase-end';
      CREATE TABLE inspector_guide_revisions (
        revision INTEGER PRIMARY KEY, head_commit TEXT NOT NULL, base_ref TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE inspector_guide_sections (
        revision INTEGER NOT NULL, section_id TEXT NOT NULL, ordinal INTEGER NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY (revision, section_id), UNIQUE (revision, ordinal)
      );
      CREATE TABLE inspector_guide_reviewer_state (
        revision INTEGER NOT NULL, head_commit TEXT NOT NULL, reviewer_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending','approved','changes-requested')), note TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (revision, reviewer_id)
      );
      CREATE TABLE inspector_guide_section_reads (
        revision INTEGER NOT NULL, reviewer_id TEXT NOT NULL, section_id TEXT NOT NULL, read_at TEXT NOT NULL,
        PRIMARY KEY (revision, reviewer_id, section_id)
      );
      CREATE TABLE inspector_review_threads (
        thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), anchor_json TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending','approved','changes-requested')),
        resolved INTEGER NOT NULL CHECK (resolved IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE inspector_review_messages (
        message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sequence INTEGER NOT NULL, value_json TEXT NOT NULL,
        UNIQUE (thread_id, sequence)
      );
      CREATE INDEX inspector_messages_by_thread ON inspector_review_messages (thread_id, sequence);
      INSERT INTO _inspector_schema_migrations (version, applied_at) VALUES (1, datetime('now'));
    `);
  }

  private meta(): MetaRow | undefined {
    return this.ctx.storage.sql.exec<MetaRow>('SELECT project_id, space_id, revision FROM inspector_meta WHERE id = 1').toArray()[0];
  }

  private requireIdentity(input: InspectorIdentity): InspectorIdentity {
    const identity = inspectorIdentitySchema.parse({ projectId: input.projectId, spaceId: input.spaceId });
    const row = this.meta();
    if (!row || row.project_id !== identity.projectId || row.space_id !== identity.spaceId) throw new InspectorStateError('Inspector authority identity does not match');
    return identity;
  }

  private bump(): void {
    this.ctx.storage.sql.exec('UPDATE inspector_meta SET revision = revision + 1 WHERE id = 1');
  }

  private assertRevision(resource: string, expected: number, actual: number): void {
    if (expected !== actual) throw new InspectorConflictError(resource, expected, actual);
  }

  private goalRow(): GoalRow | undefined {
    return this.ctx.storage.sql.exec<GoalRow>('SELECT goal_id, revision, title, summary, phase, created_at, updated_at, updated_by FROM inspector_goals WHERE id = 1').toArray()[0];
  }

  private readGoal(identity: InspectorIdentity): GoalRecordView | null {
    const goal = this.goalRow();
    if (!goal) return null;
    const requirements = this.ctx.storage.sql.exec<RequirementRow>(
      'SELECT requirement_id, ordinal, title, description, required, status, workflow_node_id, criterion_id FROM inspector_goal_requirements ORDER BY ordinal',
    ).toArray().map((requirement) => ({
      id: requirement.requirement_id,
      title: requirement.title,
      description: requirement.description,
      required: requirement.required === 1,
      status: requirement.status,
      workflowNodeId: requirement.workflow_node_id,
      criterionId: requirement.criterion_id,
      evidence: this.ctx.storage.sql.exec<EvidenceRow>('SELECT value_json FROM inspector_requirement_evidence WHERE requirement_id = ? ORDER BY ordinal', requirement.requirement_id)
        .toArray().map((row) => parseJson(evidenceReferenceSchema, row.value_json)),
    }));
    return goalRecordViewSchema.parse({
      ...identity,
      id: goal.goal_id,
      revision: goal.revision,
      title: goal.title,
      summary: goal.summary,
      phase: goal.phase,
      requirements,
      createdAt: goal.created_at,
      updatedAt: goal.updated_at,
      updatedBy: goal.updated_by,
    });
  }

  private workflowRow(): DocumentRow | undefined {
    return this.ctx.storage.sql.exec<DocumentRow>('SELECT document_id, revision, title, description, created_at, updated_at, updated_by FROM inspector_workflows WHERE id = 1').toArray()[0];
  }

  private readWorkflow(identity: InspectorIdentity): WorkflowView | null {
    const workflow = this.workflowRow();
    if (!workflow) return null;
    const goal = this.readGoal(identity);
    const requirements = new Map((goal?.requirements ?? []).map((requirement) => [requirement.id, requirement]));
    const nodes = this.ctx.storage.sql.exec<JsonOrdinalRow>('SELECT ordinal, value_json FROM inspector_workflow_nodes ORDER BY ordinal').toArray().map((row) => {
      const node = parseJson(workflowNodeSchema, row.value_json);
      if (node.kind !== 'gate') return node;
      const waivers = this.ctx.storage.sql.exec<WaiverRow>('SELECT waiver_id, reason, actor_id, actor_kind, created_at FROM inspector_workflow_gate_waivers WHERE gate_id = ? ORDER BY created_at, waiver_id', node.id)
        .toArray().map((waiver) => workflowGateWaiverSchema.parse({ id: waiver.waiver_id, reason: waiver.reason, actorId: waiver.actor_id, actorKind: waiver.actor_kind, createdAt: waiver.created_at }));
      const satisfied = node.requirementIds.every((id) => {
        const requirement = requirements.get(id);
        return requirement !== undefined && (!requirement.required || requirement.status === 'accepted');
      });
      return workflowNodeSchema.parse({ ...node, satisfied, passable: satisfied || waivers.length > 0, waivers });
    });
    const edges = this.ctx.storage.sql.exec<JsonOrdinalRow>('SELECT ordinal, value_json FROM inspector_workflow_edges ORDER BY ordinal').toArray().map((row) => JSON.parse(row.value_json));
    return workflowViewSchema.parse({
      ...identity,
      id: workflow.document_id,
      revision: workflow.revision,
      title: workflow.title,
      description: workflow.description,
      nodes,
      edges,
      createdAt: workflow.created_at,
      updatedAt: workflow.updated_at,
      updatedBy: workflow.updated_by,
    });
  }

  private rubricRow(): DocumentRow | undefined {
    return this.ctx.storage.sql.exec<DocumentRow>('SELECT document_id, revision, title, description, created_at, updated_at, updated_by FROM inspector_rubrics WHERE id = 1').toArray()[0];
  }

  private readRubric(identity: InspectorIdentity): RubricView | null {
    const rubric = this.rubricRow();
    if (!rubric) return null;
    const criteria = this.ctx.storage.sql.exec<JsonOrdinalRow>('SELECT ordinal, value_json FROM inspector_rubric_criteria ORDER BY ordinal').toArray().map((row) => {
      const criterion = putRubricInputSchema.shape.rubric.shape.criteria.element.parse(JSON.parse(row.value_json));
      const judgments = this.ctx.storage.sql.exec<JudgmentRow>('SELECT value_json FROM inspector_rubric_judgments WHERE criterion_id = ? ORDER BY sequence', criterion.id)
        .toArray().map((judgment) => parseJson(rubricJudgmentSchema, judgment.value_json));
      const latest = judgments.at(-1);
      return {
        ...criterion,
        status: latest === undefined ? 'pending' as const : latest.verdict === 'pass' ? 'passed' as const : 'failed' as const,
        judgments,
      };
    });
    return rubricViewSchema.parse({
      ...identity,
      id: rubric.document_id,
      revision: rubric.revision,
      title: rubric.title,
      description: rubric.description,
      criteria,
      createdAt: rubric.created_at,
      updatedAt: rubric.updated_at,
      updatedBy: rubric.updated_by,
    });
  }

  private openJournalPhase(): JournalRow | undefined {
    return this.ctx.storage.sql.exec<JournalRow>(`
      SELECT s.sequence, s.entry_id, s.kind, s.phase_run_id, s.phase, s.title, s.body, s.outcome,
        s.decisions_json, s.surprises_json, s.evidence_json, s.snapshot_json, s.delta_json, s.reverted_json, s.created_at, s.created_by
      FROM inspector_journal_entries s
      WHERE s.kind = 'phase-start' AND NOT EXISTS (
        SELECT 1 FROM inspector_journal_entries e WHERE e.kind = 'phase-end' AND e.phase_run_id = s.phase_run_id
      )
      ORDER BY s.sequence DESC LIMIT 1
    `).toArray()[0];
  }

  private insertJournal(identity: InspectorIdentity, input: Omit<JournalEntryView, keyof InspectorIdentity | 'sequence' | 'createdAt'>): JournalEntryView {
    const createdAt = new Date().toISOString();
    const result = this.ctx.storage.sql.exec<{ sequence: number }>(
      `INSERT INTO inspector_journal_entries
        (entry_id, kind, phase_run_id, phase, title, body, outcome, decisions_json, surprises_json, evidence_json, snapshot_json, delta_json, reverted_json, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING sequence`,
      input.id, input.kind, input.phaseRunId, input.phase, input.title, input.body, input.outcome,
      JSON.stringify(input.decisions), JSON.stringify(input.surprises), JSON.stringify(input.evidence),
      input.snapshot === null ? null : JSON.stringify(input.snapshot), input.delta === null ? null : JSON.stringify(input.delta),
      input.reverted === null ? null : JSON.stringify(input.reverted), createdAt, input.createdBy,
    ).one();
    return journalEntryViewSchema.parse({ ...identity, ...input, sequence: result.sequence, createdAt });
  }

  private journalRecord(identity: InspectorIdentity, row: JournalRow): JournalEntryView {
    return journalEntryViewSchema.parse({
      ...identity,
      id: row.entry_id,
      sequence: row.sequence,
      kind: row.kind,
      phaseRunId: row.phase_run_id,
      phase: row.phase,
      title: row.title,
      body: row.body,
      outcome: row.outcome,
      decisions: JSON.parse(row.decisions_json),
      surprises: JSON.parse(row.surprises_json),
      evidence: JSON.parse(row.evidence_json),
      snapshot: row.snapshot_json === null ? null : JSON.parse(row.snapshot_json),
      delta: row.delta_json === null ? null : JSON.parse(row.delta_json),
      reverted: row.reverted_json === null ? null : JSON.parse(row.reverted_json),
      createdAt: row.created_at,
      createdBy: row.created_by,
    });
  }

  private captureSnapshot(identity: InspectorIdentity, repository: { generation: number; headCommit: string }): JournalStateSnapshot {
    const goal = this.readGoal(identity);
    const workflow = this.readWorkflow(identity);
    const rubric = this.readRubric(identity);
    const evidenceIds = new Set<string>();
    for (const requirement of goal?.requirements ?? []) for (const evidence of requirement.evidence) evidenceIds.add(evidenceIdentity(evidence));
    for (const criterion of rubric?.criteria ?? []) {
      for (const evidence of criterion.evidence) evidenceIds.add(evidenceIdentity(evidence));
      for (const judgment of criterion.judgments) for (const evidence of judgment.evidence) evidenceIds.add(evidenceIdentity(evidence));
    }
    const requirementStatuses: Record<string, GoalRecordView['requirements'][number]['status']> = {};
    for (const requirement of goal?.requirements ?? []) requirementStatuses[requirement.id] = requirement.status;
    const workflowNodeStatuses: Record<string, string> = {};
    for (const node of workflow?.nodes ?? []) {
      workflowNodeStatuses[node.id] = node.kind === 'gate' ? (node.passable ? 'passable' : 'blocked') : node.status;
    }
    return {
      generation: repository.generation,
      headCommit: repository.headCommit,
      goalRevision: goal?.revision ?? null,
      requirementStatuses,
      workflowRevision: workflow?.revision ?? null,
      workflowNodeStatuses,
      rubricRevision: rubric?.revision ?? null,
      openReviewThreads: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM inspector_review_threads WHERE resolved = 0').one().count,
      evidenceIds: [...evidenceIds],
      capturedAt: new Date().toISOString(),
    };
  }

  private assertPhaseGatesPassable(identity: InspectorIdentity, phase: string): void {
    const workflow = this.readWorkflow(identity);
    if (!workflow) return;
    const phaseNodes = workflow.nodes.filter((node) => node.kind === 'phase' && (node.id === phase || node.label.toLocaleLowerCase() === phase.toLocaleLowerCase()));
    if (phaseNodes.length === 0) return;
    const phaseIds = new Set(phaseNodes.map((node) => node.id));
    const gateIds = new Set(workflow.edges.filter((edge) => phaseIds.has(edge.from)).map((edge) => edge.to));
    const blocked = workflow.nodes.filter((node) => node.kind === 'gate' && gateIds.has(node.id) && !node.passable);
    if (blocked.length > 0) throw new InspectorStateError(`Phase ${phase} has ${blocked.length} unsatisfied workflow gate(s): ${blocked.map((gate) => gate.label).join(', ')}`);
  }

  private latestGuideRow(): GuideRow | undefined {
    return this.ctx.storage.sql.exec<GuideRow>('SELECT revision, head_commit, base_ref, title, created_at, created_by FROM inspector_guide_revisions ORDER BY revision DESC LIMIT 1').toArray()[0];
  }

  private requireGuideVersion(revision: number, headCommit: string): GuideRow {
    const latest = this.latestGuideRow();
    if (!latest) throw new InspectorStateError('Change Guide does not exist');
    this.assertRevision('change-guide', revision, latest.revision);
    if (latest.head_commit !== headCommit) throw new InspectorStateError('Change Guide approval target does not match the pinned HEAD');
    return latest;
  }

  private readChangeGuide(identity: InspectorIdentity): ChangeGuideView | null {
    const guide = this.latestGuideRow();
    if (!guide) return null;
    const sections = this.ctx.storage.sql.exec<JsonOrdinalRow>('SELECT ordinal, value_json FROM inspector_guide_sections WHERE revision = ? ORDER BY ordinal', guide.revision)
      .toArray().map((row) => JSON.parse(row.value_json));
    const reviewerStates = this.ctx.storage.sql.exec<ReviewerStateRow>('SELECT reviewer_id, decision, note, updated_at FROM inspector_guide_reviewer_state WHERE revision = ? ORDER BY reviewer_id', guide.revision)
      .toArray().map((state) => ({
        reviewerId: state.reviewer_id,
        revision: guide.revision,
        headCommit: guide.head_commit,
        readSectionIds: this.ctx.storage.sql.exec<ReadSectionRow>('SELECT section_id FROM inspector_guide_section_reads WHERE revision = ? AND reviewer_id = ? ORDER BY read_at, section_id', guide.revision, state.reviewer_id)
          .toArray().map((read) => read.section_id),
        decision: state.decision,
        note: state.note,
        updatedAt: state.updated_at,
      }));
    return changeGuideViewSchema.parse({
      ...identity,
      revision: guide.revision,
      headCommit: guide.head_commit,
      baseRef: guide.base_ref,
      title: guide.title,
      sections,
      reviewerStates,
      createdAt: guide.created_at,
      createdBy: guide.created_by,
    });
  }

  private threadRow(threadId: string): ThreadRow | undefined {
    return this.ctx.storage.sql.exec<ThreadRow>('SELECT thread_id, revision, anchor_json, decision, resolved, created_at, updated_at FROM inspector_review_threads WHERE thread_id = ?', threadId).toArray()[0];
  }

  private readThreads(identity: InspectorIdentity, context?: ReviewAnchorContext): ReviewThreadView[] {
    return this.ctx.storage.sql.exec<ThreadRow>('SELECT thread_id, revision, anchor_json, decision, resolved, created_at, updated_at FROM inspector_review_threads ORDER BY created_at, thread_id')
      .toArray().map((thread) => this.threadRecord(identity, thread, context));
  }

  private readThread(identity: InspectorIdentity, threadId: string, context?: ReviewAnchorContext): ReviewThreadView {
    const row = this.threadRow(threadId);
    if (!row) throw new InspectorStateError(`Review thread ${threadId} does not exist`);
    return this.threadRecord(identity, row, context);
  }

  private threadRecord(identity: InspectorIdentity, row: ThreadRow, context?: ReviewAnchorContext): ReviewThreadView {
    const anchor = parseJson(reviewAnchorSchema, row.anchor_json);
    const staleReason = reviewAnchorStaleReason(anchor, context);
    const messages = this.ctx.storage.sql.exec<MessageRow>('SELECT value_json FROM inspector_review_messages WHERE thread_id = ? ORDER BY sequence', row.thread_id)
      .toArray().map((message) => parseJson(reviewMessageViewSchema, message.value_json));
    return reviewThreadViewSchema.parse({
      ...identity,
      id: row.thread_id,
      revision: row.revision,
      anchor,
      anchorState: staleReason === null ? 'current' : 'stale',
      staleReason,
      decision: row.decision,
      resolved: row.resolved === 1,
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

function parseJson<T>(schema: z.ZodType<T>, value: string): T {
  return schema.parse(JSON.parse(value));
}

function evidenceIdentity(evidence: EvidenceReference): string {
  switch (evidence.kind) {
    case 'artifact': return `artifact:${evidence.url}#${evidence.hash}`;
    case 'git': return `git:${evidence.commitId}:${evidence.path}:${evidence.blobId ?? ''}`;
    case 'command': return `command:${evidence.runId}`;
    case 'review-thread': return `review:${evidence.threadId}:${evidence.messageId ?? ''}`;
  }
}

export function computeJournalDelta(start: JournalStateSnapshot, end: JournalStateSnapshot): JournalDelta {
  const requirementsAdvanced: JournalDelta['requirementsAdvanced'] = [];
  for (const [id, to] of Object.entries(end.requirementStatuses)) {
    const from = start.requirementStatuses[id] ?? null;
    if (from !== to) requirementsAdvanced.push({ id, from, to });
  }
  const workflowNodesChanged: JournalDelta['workflowNodesChanged'] = [];
  for (const [id, to] of Object.entries(end.workflowNodeStatuses)) {
    const from = start.workflowNodeStatuses[id] ?? null;
    if (from !== to) workflowNodesChanged.push({ id, from, to });
  }
  const startEvidence = new Set(start.evidenceIds);
  const canonChanged: JournalDelta['canonChanged'] = [];
  if (start.goalRevision !== end.goalRevision) canonChanged.push('goal');
  if (start.workflowRevision !== end.workflowRevision) canonChanged.push('workflow');
  if (start.rubricRevision !== end.rubricRevision) canonChanged.push('rubric');
  return {
    requirementsAdvanced,
    evidenceAdded: end.evidenceIds.filter((id) => !startEvidence.has(id)),
    workflowNodesChanged,
    threadsResolved: Math.max(0, start.openReviewThreads - end.openReviewThreads),
    canonChanged,
    generationChanged: start.generation !== end.generation,
    headChanged: start.headCommit !== end.headCommit,
  };
}

function reviewAnchorStaleReason(anchor: z.infer<typeof reviewAnchorSchema>, context?: ReviewAnchorContext): string | null {
  if (!context || anchor.kind === 'workspace' || anchor.kind === 'artifact') return null;
  const pinnedHead = anchor.kind === 'file' ? anchor.commitId : anchor.headCommit;
  if (pinnedHead !== context.headCommit) return `Anchor HEAD ${pinnedHead} no longer matches ${context.headCommit}`;
  return null;
}
