import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { KanbanGoalItem } from '../app/shared/board/types.js';
import type {
  ArtifactKind,
  ChainStackStatus,
  CommandExpectation,
  Evidence,
  Generation,
  GoalValidation,
  Judgment,
  Requirement,
  Review,
  TimelineEvent,
} from '../types/goals.js';
import type { AddRequirementInput, AttachEvidenceInput, HumanReviewDecision, UpdateRequirementInput } from '../core/goal-validation.js';
import { computeReadiness } from '../app/shared/goal-validation/readiness.js';
import { MarkdownEditor } from './MarkdownEditor.web.js';
import { btnDanger, btnGhost, btnPrimary, btnSecondary, chipClass, type ChipTone, R_CARD, R_CHIP, R_INPUT } from './ui/control.js';

type Tab = 'glance' | 'doc' | 'requirements' | 'timeline';

const KIND_OPTIONS: ArtifactKind[] = ['screenshot', 'video', 'test-output', 'note', 'file', 'url'];
const EXPECT_OPTIONS: CommandExpectation['kind'][] = ['exit-zero', 'stdout-contains', 'stderr-empty', 'output-matches'];

function kindLabel(kind: ArtifactKind): string {
  if (kind === 'screenshot') return 'screenshot';
  if (kind === 'video') return 'video';
  if (kind === 'test-output') return 'command output';
  if (kind === 'note') return 'note';
  if (kind === 'file') return 'file';
  if (kind === 'url') return 'link';
  return kind;
}

function statusLabel(status: Requirement['status']): string {
  if (status === 'missing') return 'needs evidence';
  if (status === 'review') return 'needs review';
  return 'review passed';
}

function expectLabel(expect: CommandExpectation): string {
  if (expect.kind === 'exit-zero') return 'exit zero';
  if (expect.kind === 'stdout-contains') return `stdout contains "${expect.needle}"`;
  if (expect.kind === 'stderr-empty') return 'stderr empty';
  return `stdout matches /${expect.pattern}/`;
}

function describeGenerationShort(generation: Generation): string {
  return generation.kind === 'manual' ? 'manual' : 'command';
}

function describeJudgmentShort(judgment: Judgment): string {
  if (judgment.kind === 'human') return 'human';
  if (judgment.kind === 'llm') return judgment.modelHint ? `llm · ${judgment.modelHint}` : 'llm';
  return `command · ${judgment.expect.kind}`;
}

function nextActionLabel(requirement: Requirement): string {
  if (requirement.status === 'missing') {
    return requirement.generation.kind === 'command' ? 'run command' : `attach ${kindLabel(requirement.kind)}`;
  }
  if (requirement.status === 'review') {
    if (requirement.judgment.kind === 'human') return 'review';
    if (requirement.judgment.kind === 'llm') return 'run llm judge';
    return 'run check';
  }
  return '—';
}

function eventToneClass(tone: TimelineEvent['tone']): string {
  if (tone === 'green') return 'border-[var(--gs-success)] bg-[var(--gs-chip-green-bg)] text-[var(--gs-success)]';
  if (tone === 'amber') return 'border-[var(--gs-warning)] bg-[var(--gs-chip-amber-bg)] text-[var(--gs-warning)]';
  if (tone === 'red') return 'border-[var(--gs-danger)] bg-[var(--gs-chip-red-bg)] text-[var(--gs-danger)]';
  if (tone === 'blue') return 'border-[var(--gs-info)] bg-[var(--gs-chip-blue-bg)] text-[var(--gs-info)]';
  return 'border-[var(--gs-purple)] bg-[var(--gs-bg-elevated)] text-[var(--gs-purple)]';
}

function statusToneClass(status: Requirement['status']): string {
  if (status === 'accepted') return 'text-[var(--gs-success)]';
  if (status === 'review') return 'text-[var(--gs-warning)]';
  return 'text-[var(--gs-danger)]';
}

function statusDotClass(status: Requirement['status']): string {
  if (status === 'accepted') return 'bg-[var(--gs-success)]';
  if (status === 'review') return 'bg-[var(--gs-warning)]';
  return 'bg-[var(--gs-danger)]';
}

function reviewToneLabel(tone: Review['tone']): string {
  return tone === 'green' ? 'passed' : tone === 'amber' ? 'needs changes' : 'failed';
}

function reviewToneClass(tone: Review['tone']): string {
  return tone === 'green' ? 'text-[var(--gs-success)]' : tone === 'amber' ? 'text-[var(--gs-warning)]' : 'text-[var(--gs-danger)]';
}

function defaultDocBody(title: string): string {
  return `# ${title}\n\n## Objective\n\n## Non-goals\n\n## Validation\n`;
}

function emptyValidation(): GoalValidation {
  return { reqOrder: [], requirements: {}, events: [] };
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(11, 16);
  } catch {
    return '';
  }
}

interface RequirementFormDraft {
  title: string;
  kind: ArtifactKind;
  rubric: string;
  required: boolean;
  generationKind: 'manual' | 'command';
  generationCommand: string;
  judgmentKind: 'human' | 'llm' | 'command';
  judgmentCommand: string;
  judgmentExpect: CommandExpectation['kind'];
  judgmentExpectNeedle: string;
  judgmentExpectPattern: string;
  judgmentModelHint: string;
}

function emptyDraft(): RequirementFormDraft {
  return {
    title: '',
    kind: 'screenshot',
    rubric: '',
    required: true,
    generationKind: 'manual',
    generationCommand: '',
    judgmentKind: 'human',
    judgmentCommand: '',
    judgmentExpect: 'exit-zero',
    judgmentExpectNeedle: '',
    judgmentExpectPattern: '',
    judgmentModelHint: '',
  };
}

function draftFromRequirement(r: Requirement): RequirementFormDraft {
  return {
    title: r.title,
    kind: r.kind,
    rubric: r.rubric,
    required: r.required,
    generationKind: r.generation.kind,
    generationCommand: r.generation.kind === 'command' ? r.generation.command : '',
    judgmentKind: r.judgment.kind,
    judgmentCommand: r.judgment.kind === 'command' ? r.judgment.command : '',
    judgmentExpect: r.judgment.kind === 'command' ? r.judgment.expect.kind : 'exit-zero',
    judgmentExpectNeedle: r.judgment.kind === 'command' && r.judgment.expect.kind === 'stdout-contains' ? r.judgment.expect.needle : '',
    judgmentExpectPattern: r.judgment.kind === 'command' && r.judgment.expect.kind === 'output-matches' ? r.judgment.expect.pattern : '',
    judgmentModelHint: r.judgment.kind === 'llm' ? r.judgment.modelHint ?? '' : '',
  };
}

function buildGenerationFromDraft(draft: RequirementFormDraft): Generation {
  if (draft.generationKind === 'manual') return { kind: 'manual' };
  return { kind: 'command', command: draft.generationCommand.trim() };
}

function buildJudgmentFromDraft(draft: RequirementFormDraft): Judgment {
  if (draft.judgmentKind === 'human') return { kind: 'human' };
  if (draft.judgmentKind === 'llm') {
    const hint = draft.judgmentModelHint.trim();
    return hint ? { kind: 'llm', modelHint: hint } : { kind: 'llm' };
  }
  let expect: CommandExpectation;
  if (draft.judgmentExpect === 'exit-zero') expect = { kind: 'exit-zero' };
  else if (draft.judgmentExpect === 'stderr-empty') expect = { kind: 'stderr-empty' };
  else if (draft.judgmentExpect === 'stdout-contains') expect = { kind: 'stdout-contains', needle: draft.judgmentExpectNeedle };
  else expect = { kind: 'output-matches', pattern: draft.judgmentExpectPattern };
  return { kind: 'command', command: draft.judgmentCommand.trim(), expect };
}

function buildAddInput(draft: RequirementFormDraft): AddRequirementInput {
  return {
    title: draft.title.trim(),
    kind: draft.kind,
    rubric: draft.rubric.trim(),
    required: draft.required,
    generation: buildGenerationFromDraft(draft),
    judgment: buildJudgmentFromDraft(draft),
  };
}

function buildUpdateInput(draft: RequirementFormDraft): UpdateRequirementInput {
  return buildAddInput(draft);
}

export interface GoalDetailPanelProps {
  goal: KanbanGoalItem;
  chainGoals: KanbanGoalItem[];
  stackStatus?: ChainStackStatus | null;
  message?: string | null;
  saving?: boolean;
  onClose: () => void;
  onSaveDoc: (goal: KanbanGoalItem, bodyMarkdown: string) => void | Promise<void>;
  onCreateWorkspace: (goal: KanbanGoalItem) => void | Promise<void>;
  onSaveChainOrder: (goals: KanbanGoalItem[]) => void | Promise<void>;
  onRefreshStackStatus: (goal: KanbanGoalItem) => void | Promise<void>;
  onAddRequirement: (goal: KanbanGoalItem, input: AddRequirementInput) => void | Promise<void>;
  onUpdateRequirement: (goal: KanbanGoalItem, requirementId: string, patch: UpdateRequirementInput) => void | Promise<void>;
  onRemoveRequirement: (goal: KanbanGoalItem, requirementId: string) => void | Promise<void>;
  onReorderRequirement: (goal: KanbanGoalItem, requirementId: string, position: number) => void | Promise<void>;
  onReopenRequirement: (goal: KanbanGoalItem, requirementId: string) => void | Promise<void>;
  onAttachEvidence: (goal: KanbanGoalItem, requirementId: string, input: AttachEvidenceInput) => void | Promise<void>;
  onRunGeneration: (goal: KanbanGoalItem, requirementId: string) => void | Promise<void>;
  onRunJudgment: (goal: KanbanGoalItem, requirementId: string) => void | Promise<void>;
  onRecordHumanReview: (goal: KanbanGoalItem, requirementId: string, decision: HumanReviewDecision, note: string) => void | Promise<void>;
}

export function GoalDetailPanel(props: GoalDetailPanelProps) {
  const validation = props.goal.validation ?? emptyValidation();
  const requirements = useMemo(() => validation.reqOrder.map((id) => validation.requirements[id]).filter((r): r is Requirement => Boolean(r)), [validation]);
  const readiness = useMemo(() => computeReadiness(validation), [validation]);

  const [tab, setTab] = useState<Tab>('glance');
  const [docDraft, setDocDraft] = useState(props.goal.doc?.bodyMarkdown ?? defaultDocBody(props.goal.title));
  const [docMode, setDocMode] = useState<'preview' | 'edit' | 'split'>('preview');
  const [selectedReq, setSelectedReq] = useState<string | null>(null);
  const [editingReq, setEditingReq] = useState<'new' | string | null>(null);
  const [reqFilter, setReqFilter] = useState<'all' | Requirement['status']>('all');
  const [reqSearch, setReqSearch] = useState('');
  const [glanceFilter, setGlanceFilter] = useState<'all' | Requirement['status']>('all');
  const [timelineFilter, setTimelineFilter] = useState<'all' | TimelineEvent['kind']>('all');
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setEntered(true), 0);
    return () => clearTimeout(id);
  }, []);

  // Reset draft when goal switches.
  useEffect(() => {
    setDocDraft(props.goal.doc?.bodyMarkdown ?? defaultDocBody(props.goal.title));
    setDocMode('preview');
    setSelectedReq(null);
    setEditingReq(null);
  }, [props.goal.id, props.goal.doc?.bodyMarkdown, props.goal.title]);

  const docDirty = docDraft !== (props.goal.doc?.bodyMarkdown ?? defaultDocBody(props.goal.title));

  const counts = readiness.totals;

  return (
    <aside className={`fixed right-0 top-0 bottom-0 z-40 flex w-full max-w-[1180px] flex-col border-l border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] shadow-2xl will-change-transform transition-[transform,opacity] duration-200 ease-out ${entered ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'}`}>
      <header className="flex items-start gap-3 border-b border-[var(--gs-border)] p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.18em] tabular-nums text-[var(--gs-text-dim)]">
            Status · {props.goal.chainPosition}/{props.goal.chainLength} · {props.goal.phase} · {props.goal.status}
          </div>
          <h2 className="mt-1 truncate text-lg font-semibold text-[var(--gs-text)]">{props.goal.title}</h2>
          <div className="mt-1 truncate text-xs text-[var(--gs-text-muted)]">
            {props.goal.workspaceName ?? props.goal.plannedWorkspaceName ?? 'No workspace yet'}
          </div>
        </div>
        <button type="button" onClick={props.onClose} className={btnGhost()}>
          Close
        </button>
      </header>

      {props.message && (
        <div className="border-b border-[var(--gs-chip-amber-text)] bg-[var(--gs-chip-amber-bg)] px-4 py-2 text-xs text-[var(--gs-chip-amber-text)]">
          {props.message}
        </div>
      )}

      <div className="grid flex-1 grid-cols-[232px_1fr] overflow-hidden">
        <Sidebar
          activeTab={tab}
          counts={counts}
          openCount={counts.missing + counts.review}
          totalRequirements={counts.total}
          eventCount={validation.events.length}
          readinessSummary={readiness.summary}
          readinessDetail={readiness.detail}
          readinessTone={readiness.status}
          onTabChange={setTab}
          canCreateWorkspace={!props.goal.workspaceName}
          onCreateWorkspace={() => void props.onCreateWorkspace(props.goal)}
          onRefreshStack={() => void props.onRefreshStackStatus(props.goal)}
          stackStatus={props.stackStatus}
        />
        <section className="overflow-auto p-6">
          {tab === 'glance' && (
            <GlanceTab
              requirements={requirements}
              counts={counts}
              filter={glanceFilter}
              onFilterChange={setGlanceFilter}
              onJump={(reqId) => { setSelectedReq(reqId); setEditingReq(null); setTab('requirements'); }}
              onContinueAtBlocker={() => {
                const blocker = requirements.find((r) => r.status === 'missing') ?? requirements.find((r) => r.status === 'review');
                if (blocker) { setSelectedReq(blocker.id); setEditingReq(null); setTab('requirements'); }
                else setTab('timeline');
              }}
            />
          )}
          {tab === 'doc' && (
            <DocTab
              body={docDraft}
              mode={docMode}
              dirty={docDirty}
              onModeChange={setDocMode}
              onChange={setDocDraft}
              onSave={() => void props.onSaveDoc(props.goal, docDraft)}
              onDiscard={() => setDocDraft(props.goal.doc?.bodyMarkdown ?? defaultDocBody(props.goal.title))}
              onJumpToRequirement={(reqId) => {
                if (validation.requirements[reqId]) { setSelectedReq(reqId); setEditingReq(null); setTab('requirements'); }
              }}
              saving={props.saving}
            />
          )}
          {tab === 'requirements' && (
            <RequirementsTab
              goalTitle={props.goal.title}
              requirements={requirements}
              selectedReq={selectedReq}
              editingReq={editingReq}
              filter={reqFilter}
              search={reqSearch}
              onFilterChange={setReqFilter}
              onSearchChange={setReqSearch}
              onSelect={(id) => { setSelectedReq(id); setEditingReq(null); }}
              onStartAdd={() => setEditingReq('new')}
              onStartEdit={(id) => { setSelectedReq(id); setEditingReq(id); }}
              onCancelEdit={() => setEditingReq(null)}
              onSubmitAdd={async (input) => { await props.onAddRequirement(props.goal, input); setEditingReq(null); }}
              onSubmitUpdate={async (id, patch) => { await props.onUpdateRequirement(props.goal, id, patch); setEditingReq(null); }}
              onRemove={(id) => void props.onRemoveRequirement(props.goal, id)}
              onMoveUp={(id) => {
                const idx = validation.reqOrder.indexOf(id);
                if (idx > 0) void props.onReorderRequirement(props.goal, id, idx - 1);
              }}
              onMoveDown={(id) => {
                const idx = validation.reqOrder.indexOf(id);
                if (idx >= 0 && idx < validation.reqOrder.length - 1) void props.onReorderRequirement(props.goal, id, idx + 1);
              }}
              onReopen={(id) => void props.onReopenRequirement(props.goal, id)}
              onAttach={(id, input) => void props.onAttachEvidence(props.goal, id, input)}
              onRunGeneration={(id) => void props.onRunGeneration(props.goal, id)}
              onRunJudgment={(id) => void props.onRunJudgment(props.goal, id)}
              onRecordHuman={(id, decision, note) => void props.onRecordHumanReview(props.goal, id, decision, note)}
              saving={props.saving}
            />
          )}
          {tab === 'timeline' && (
            <TimelineTab
              events={validation.events}
              filter={timelineFilter}
              onFilterChange={setTimelineFilter}
              selectedEvent={selectedEvent}
              onSelectEvent={setSelectedEvent}
              onJumpToRequirement={(reqId) => { setSelectedReq(reqId); setEditingReq(null); setTab('requirements'); }}
            />
          )}
        </section>
      </div>
    </aside>
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function Sidebar(props: {
  activeTab: Tab;
  counts: { total: number; missing: number; review: number; accepted: number };
  openCount: number;
  totalRequirements: number;
  eventCount: number;
  readinessSummary: string;
  readinessDetail: string;
  readinessTone: 'ready' | 'awaiting-review' | 'not-ready';
  onTabChange: (tab: Tab) => void;
  canCreateWorkspace: boolean;
  onCreateWorkspace: () => void;
  onRefreshStack: () => void;
  stackStatus?: ChainStackStatus | null;
}) {
  const summaryColor =
    props.readinessTone === 'ready' ? 'text-[var(--gs-success)]'
    : props.readinessTone === 'awaiting-review' ? 'text-[var(--gs-warning)]'
    : 'text-[var(--gs-danger)]';

  const tabs: Array<{ key: Tab; label: string; count?: string }> = [
    { key: 'glance', label: 'At a glance', count: `${props.openCount} open` },
    { key: 'doc', label: 'Goal doc', count: 'spec' },
    { key: 'requirements', label: 'Requirements', count: String(props.totalRequirements) },
    { key: 'timeline', label: 'Timeline', count: String(props.eventCount) },
  ];

  return (
    <aside className="flex flex-col gap-4 border-r border-[var(--gs-border)] bg-[var(--gs-bg)] p-4">
      <div className="border-b border-[var(--gs-border)] pb-3">
        <div className={`text-xs font-semibold ${summaryColor}`}>{props.readinessSummary}</div>
        <div className="mt-1 text-[11px] leading-snug text-[var(--gs-text-muted)]">{props.readinessDetail}</div>
      </div>

      <nav className="flex flex-col gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => props.onTabChange(tab.key)}
            className={`flex items-center justify-between ${R_CHIP} px-2 py-1.5 text-xs transition-[background-color,color] duration-150 ${props.activeTab === tab.key ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]'}`}
          >
            <span>{tab.label}</span>
            {tab.count && <span className="text-[10px] tabular-nums text-[var(--gs-text-dim)]">{tab.count}</span>}
          </button>
        ))}
      </nav>

      <div className="mt-auto border-t border-[var(--gs-border)] pt-3">
        <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Workspace</div>
        {props.canCreateWorkspace && (
          <button type="button" onClick={props.onCreateWorkspace} className={btnPrimary('mb-2 w-full')}>
            Create workspace
          </button>
        )}
        <button type="button" onClick={props.onRefreshStack} className={btnSecondary('w-full')}>
          Run stack status
        </button>
        {props.stackStatus && (
          <div className="mt-2 text-[10px] text-[var(--gs-text-muted)]">
            Stack: {props.stackStatus.status}{props.stackStatus.youAreNext ? ' · you are next' : ''}
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── Glance tab ─────────────────────────────────────────────────────────────

function GlanceTab(props: {
  requirements: Requirement[];
  counts: { total: number; missing: number; review: number; accepted: number };
  filter: 'all' | Requirement['status'];
  onFilterChange: (filter: 'all' | Requirement['status']) => void;
  onJump: (reqId: string) => void;
  onContinueAtBlocker: () => void;
}) {
  const visible = props.requirements.filter((r) => props.filter === 'all' || r.status === props.filter);
  const stats: Array<{ key: 'all' | Requirement['status']; label: string; v: number; cls: string }> = [
    { key: 'all', label: 'total', v: props.counts.total, cls: '' },
    { key: 'missing', label: 'missing', v: props.counts.missing, cls: 'text-[var(--gs-danger)]' },
    { key: 'review', label: 'needs review', v: props.counts.review, cls: 'text-[var(--gs-warning)]' },
    { key: 'accepted', label: 'accepted', v: props.counts.accepted, cls: 'text-[var(--gs-success)]' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-balance text-[var(--gs-text)]">At a glance</h2>
          <p className="mt-1 text-xs text-pretty text-[var(--gs-text-muted)]">Every requirement in one scan: what it is, how it&apos;s produced, how it&apos;s judged, where it stands.</p>
        </div>
        <button type="button" onClick={props.onContinueAtBlocker} className={btnPrimary('flex-shrink-0')}>
          View Blocker
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {stats.map((stat) => (
          <button
            key={stat.key}
            type="button"
            onClick={() => props.onFilterChange(stat.key)}
            className={`${R_CARD} border px-3 py-2 text-left transition-[background-color,border-color,scale] duration-150 active:scale-[0.98] ${props.filter === stat.key ? 'border-[var(--gs-selected-border)] bg-[var(--gs-bg-active)]' : 'border-[var(--gs-border)] bg-[var(--gs-bg)] hover:bg-[var(--gs-bg-active)]'}`}
          >
            <div className={`text-xl font-semibold tabular-nums ${stat.cls || 'text-[var(--gs-text)]'}`}>{stat.v}</div>
            <div className="text-[10px] text-[var(--gs-text-muted)]">{stat.label}</div>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className={`${R_CARD} border border-dashed border-[var(--gs-border)] p-6 text-center text-xs text-[var(--gs-text-muted)]`}>
          No requirements match this filter.
        </div>
      ) : (
        <div className={`overflow-hidden ${R_CARD} border border-[var(--gs-border)]`}>
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] border-b border-[var(--gs-border)] bg-[var(--gs-bg)] text-[10px] uppercase tracking-wide text-[var(--gs-text-muted)]">
            <div className="border-r border-[var(--gs-border)] p-2">Requirement</div>
            <div className="border-r border-[var(--gs-border)] p-2">Produced by</div>
            <div className="border-r border-[var(--gs-border)] p-2">Judged by</div>
            <div className="border-r border-[var(--gs-border)] p-2">Status</div>
            <div className="p-2">Next</div>
          </div>
          {visible.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => props.onJump(r.id)}
              className="grid w-full grid-cols-[2fr_1fr_1fr_1fr_1fr] border-b border-[var(--gs-border)] text-left text-xs last:border-b-0 hover:bg-[var(--gs-bg-active)]"
            >
              <div className="border-r border-[var(--gs-border)] p-2 font-medium text-[var(--gs-text)]">{r.title}</div>
              <div className="border-r border-[var(--gs-border)] p-2 text-[var(--gs-text-muted)]">{describeGenerationShort(r.generation)}</div>
              <div className="border-r border-[var(--gs-border)] p-2 text-[var(--gs-text-muted)]">{describeJudgmentShort(r.judgment)}</div>
              <div className={`border-r border-[var(--gs-border)] p-2 ${statusToneClass(r.status)}`}>{statusLabel(r.status)}</div>
              <div className="p-2 text-[var(--gs-text-muted)]">{nextActionLabel(r)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Doc tab ────────────────────────────────────────────────────────────────

function DocTab(props: {
  body: string;
  mode: 'preview' | 'edit' | 'split';
  dirty: boolean;
  onModeChange: (mode: 'preview' | 'edit' | 'split') => void;
  onChange: (body: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onJumpToRequirement: (reqId: string) => void;
  saving?: boolean;
}) {
  void props.onJumpToRequirement;
  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-balance text-[var(--gs-text)]">Goal doc</h2>
        <p className="mt-1 text-xs text-pretty text-[var(--gs-text-muted)]">The implementer&apos;s brief. Describe intent; link the specific requirements that prove it.</p>
      </div>
      <MarkdownEditor
        body={props.body}
        mode={props.mode}
        dirty={props.dirty}
        saving={props.saving}
        emptyPreviewHtml="<p><em>No goal document yet.</em></p>"
        onChange={props.onChange}
        onModeChange={props.onModeChange}
        onSave={props.onSave}
        onDiscard={props.onDiscard}
        minHeightPx={480}
      />
    </div>
  );
}

// ─── Requirements tab ──────────────────────────────────────────────────────

function RequirementsTab(props: {
  goalTitle: string;
  requirements: Requirement[];
  selectedReq: string | null;
  editingReq: 'new' | string | null;
  filter: 'all' | Requirement['status'];
  search: string;
  onFilterChange: (filter: 'all' | Requirement['status']) => void;
  onSearchChange: (search: string) => void;
  onSelect: (id: string) => void;
  onStartAdd: () => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitAdd: (input: AddRequirementInput) => void | Promise<void>;
  onSubmitUpdate: (id: string, patch: UpdateRequirementInput) => void | Promise<void>;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onReopen: (id: string) => void;
  onAttach: (id: string, input: AttachEvidenceInput) => void;
  onRunGeneration: (id: string) => void;
  onRunJudgment: (id: string) => void;
  onRecordHuman: (id: string, decision: HumanReviewDecision, note: string) => void;
  saving?: boolean;
}) {
  const filters: Array<{ k: 'all' | Requirement['status']; label: string }> = [
    { k: 'all', label: 'All' },
    { k: 'missing', label: 'Missing' },
    { k: 'review', label: 'Needs review' },
    { k: 'accepted', label: 'Accepted' },
  ];

  const filtered = props.requirements.filter((r) => {
    if (props.filter !== 'all' && r.status !== props.filter) return false;
    if (props.search && !(`${r.title} ${r.rubric}`.toLowerCase().includes(props.search.toLowerCase()))) return false;
    return true;
  });

  const isEmpty = props.requirements.length === 0;
  const filteredOut = !isEmpty && filtered.length === 0;
  const focusedId = props.selectedReq && filtered.some((r) => r.id === props.selectedReq) ? props.selectedReq : filtered[0]?.id ?? null;
  const focused = focusedId ? props.requirements.find((r) => r.id === focusedId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-balance text-[var(--gs-text)]">Requirements</h2>
          <p className="mt-1 text-xs text-pretty text-[var(--gs-text-muted)]">The contract. Each row owns its rubric, its generation strategy, and its judgment strategy.</p>
        </div>
        <button type="button" onClick={props.onStartAdd} className={btnPrimary('flex-shrink-0')}>
          Add requirement
        </button>
      </div>

      {!isEmpty && (
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {filters.map((f) => (
              <button key={f.k} type="button" onClick={() => props.onFilterChange(f.k)} className={`${R_CHIP} border px-3 py-1 text-[11px] transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96] ${props.filter === f.k ? 'border-[var(--gs-selected-border)] bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'border-[var(--gs-border)] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'}`}>
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder="Search requirements"
            value={props.search}
            onChange={(e) => props.onSearchChange(e.target.value)}
            className={`flex-1 ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg)] px-3 py-1.5 text-xs text-[var(--gs-text)] outline-none transition-[border-color] duration-150 focus:border-[var(--gs-input-focus-border)]`}
          />
        </div>
      )}

      {isEmpty && (
        <div className={`${R_CARD} border border-dashed border-[var(--gs-border)] p-8 text-center`}>
          <h3 className="text-sm font-semibold text-balance text-[var(--gs-text)]">No requirements yet</h3>
          <p className="mt-1 text-xs text-[var(--gs-text-muted)]">Define what makes this goal done. Use Add to create the first one.</p>
          <button type="button" onClick={props.onStartAdd} className={btnPrimary('mt-3')}>
            Add the first requirement
          </button>
        </div>
      )}

      {filteredOut && (
        <div className={`${R_CARD} border border-dashed border-[var(--gs-border)] p-6 text-center text-xs text-[var(--gs-text-muted)]`}>
          No requirements match the current filter.
        </div>
      )}

      {!isEmpty && !filteredOut && (
        <div className={`overflow-hidden ${R_CARD} border border-[var(--gs-border)]`}>
          {filtered.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => props.onSelect(r.id)}
              className={`flex w-full items-start gap-3 border-b border-[var(--gs-border)] p-3 text-left transition-[background-color] duration-150 last:border-b-0 ${focusedId === r.id ? 'bg-[var(--gs-bg-active)]' : 'hover:bg-[var(--gs-bg-active)]'}`}
            >
              <div className={`mt-1 h-3.5 w-1 ${statusDotClass(r.status)}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--gs-text)]">{r.title}</div>
                <div className="mt-1 text-xs text-[var(--gs-text-muted)] line-clamp-2">{r.rubric}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--gs-text-muted)]">
                  <span className={`flex items-center gap-1 ${statusToneClass(r.status)}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(r.status)}`} /> {statusLabel(r.status)}
                  </span>
                  <span>{kindLabel(r.kind)} · {r.required ? 'required' : 'optional'}</span>
                  <MechChip label={describeGenerationShort(r.generation)} tone={r.generation.kind === 'command' ? 'blue' : 'dim'} />
                  <MechChip label={describeJudgmentShort(r.judgment)} tone={r.judgment.kind === 'human' ? 'blue' : r.judgment.kind === 'llm' ? 'amber' : 'green'} />
                  {r.evidence.length > 0 && <span>{r.evidence.length} evidence</span>}
                  {r.reviews.length > 0 && <span>{r.reviews.length} review{r.reviews.length === 1 ? '' : 's'}</span>}
                </div>
              </div>
              <span className="text-[var(--gs-text-dim)]">›</span>
            </button>
          ))}
        </div>
      )}

      {props.editingReq === 'new' && (
        <RequirementForm mode="add" onCancel={props.onCancelEdit} onSubmit={(draft) => void props.onSubmitAdd(buildAddInput(draft))} initial={emptyDraft()} saving={props.saving} />
      )}
      {props.editingReq && props.editingReq !== 'new' && focused && props.editingReq === focused.id && (
        <RequirementForm mode="edit" onCancel={props.onCancelEdit} onSubmit={(draft) => void props.onSubmitUpdate(focused.id, buildUpdateInput(draft))} initial={draftFromRequirement(focused)} saving={props.saving} />
      )}

      {!props.editingReq && focused && (
        <RequirementDetail
          requirement={focused}
          orderIndex={props.requirements.findIndex((r) => r.id === focused.id)}
          totalRequirements={props.requirements.length}
          onEdit={() => props.onStartEdit(focused.id)}
          onRemove={() => props.onRemove(focused.id)}
          onMoveUp={() => props.onMoveUp(focused.id)}
          onMoveDown={() => props.onMoveDown(focused.id)}
          onReopen={() => props.onReopen(focused.id)}
          onAttach={(input) => props.onAttach(focused.id, input)}
          onRunGeneration={() => props.onRunGeneration(focused.id)}
          onRunJudgment={() => props.onRunJudgment(focused.id)}
          onRecordHuman={(decision, note) => props.onRecordHuman(focused.id, decision, note)}
          saving={props.saving}
        />
      )}
    </div>
  );
}

function MechChip(props: { label: string; tone: ChipTone }) {
  return <span className={chipClass(props.tone)}>{props.label}</span>;
}

// ─── Requirement detail ───────────────────────────────────────────────────

function RequirementDetail(props: {
  requirement: Requirement;
  orderIndex: number;
  totalRequirements: number;
  onEdit: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onReopen: () => void;
  onAttach: (input: AttachEvidenceInput) => void;
  onRunGeneration: () => void;
  onRunJudgment: () => void;
  onRecordHuman: (decision: HumanReviewDecision, note: string) => void;
  saving?: boolean;
}) {
  const r = props.requirement;
  const canUp = props.orderIndex > 0;
  const canDown = props.orderIndex >= 0 && props.orderIndex < props.totalRequirements - 1;
  const isMissing = r.status === 'missing';
  const isReview = r.status === 'review';
  const isAccepted = r.status === 'accepted';
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setConfirmRemove(false), [r.id]);

  return (
    <div className={`${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-4`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`flex items-center gap-1 ${statusToneClass(r.status)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(r.status)}`} /> {statusLabel(r.status)}
            </span>
            <span className="text-[var(--gs-text-muted)]">{kindLabel(r.kind)} · {r.required ? 'required' : 'optional'}</span>
          </div>
          <h3 className="mt-1.5 text-base font-semibold text-[var(--gs-text)]">{r.title}</h3>
          <p className="mt-1 text-xs text-[var(--gs-text-muted)]">{r.rubric}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Produced</span>
            <MechChip label={describeGenerationShort(r.generation)} tone={r.generation.kind === 'command' ? 'blue' : 'dim'} />
            {r.generation.kind === 'command' && <code className={`${R_CHIP} bg-[var(--gs-bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--gs-text)]`}>{r.generation.command}</code>}
            <span className="ml-2 text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Judged</span>
            <MechChip label={describeJudgmentShort(r.judgment)} tone={r.judgment.kind === 'human' ? 'blue' : r.judgment.kind === 'llm' ? 'amber' : 'green'} />
            {r.judgment.kind === 'command' && (
              <span className="text-[10px] text-[var(--gs-text-muted)]">expect: <code className="text-[var(--gs-text)]">{expectLabel(r.judgment.expect)}</code></span>
            )}
            {r.judgment.kind === 'llm' && r.judgment.modelHint && (
              <span className="text-[10px] text-[var(--gs-text-muted)]">model: <code className="text-[var(--gs-text)]">{r.judgment.modelHint}</code></span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={props.onMoveUp} disabled={!canUp} aria-label="Move requirement up" className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--gs-btn-radius)] border border-[var(--gs-border)] text-xs text-[var(--gs-text-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:text-[var(--gs-text)] active:scale-[0.96] disabled:opacity-30">↑</button>
          <button type="button" onClick={props.onMoveDown} disabled={!canDown} aria-label="Move requirement down" className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--gs-btn-radius)] border border-[var(--gs-border)] text-xs text-[var(--gs-text-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:text-[var(--gs-text)] active:scale-[0.96] disabled:opacity-30">↓</button>
          <button type="button" onClick={props.onEdit} className={btnSecondary()}>Edit</button>
          {confirmRemove ? (
            <>
              <button type="button" onClick={() => setConfirmRemove(false)} className={btnGhost()}>Cancel</button>
              <button type="button" onClick={props.onRemove} className={btnDanger()}>Confirm remove</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmRemove(true)} className={btnDanger()}>Remove</button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <EvidenceSection requirement={r} onAttach={props.onAttach} onRunGeneration={props.onRunGeneration} saving={props.saving} showAttachAction={isMissing} />
        <ReviewsSection requirement={r} onRunJudgment={props.onRunJudgment} onRecordHuman={props.onRecordHuman} onReopen={props.onReopen} showJudgmentAction={isReview} showReopenAction={isAccepted} showLockedNote={isMissing} saving={props.saving} />
      </div>
    </div>
  );
}

function EvidenceSection(props: {
  requirement: Requirement;
  onAttach: (input: AttachEvidenceInput) => void;
  onRunGeneration: () => void;
  saving?: boolean;
  showAttachAction: boolean;
}) {
  const r = props.requirement;
  const [name, setName] = useState(r.title);
  const [body, setBody] = useState('');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  useEffect(() => {
    setName(r.title); setBody(''); setPath(''); setUrl('');
  }, [r.id, r.title]);

  return (
    <div className={`${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] p-3`}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Evidence</div>
      {r.evidence.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {r.evidence.map((ev) => <EvidenceChip key={ev.id} evidence={ev} />)}
        </div>
      ) : (
        <div className="mt-2 text-xs text-[var(--gs-text-muted)]">No evidence attached yet.</div>
      )}

      {props.showAttachAction && r.generation.kind === 'command' && (
        <div className="mt-3 space-y-2">
          <div className={`${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-2`}>
            <div className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Generation command</div>
            <div className="mt-1 font-mono text-[11px] text-[var(--gs-text)]">{r.generation.command}</div>
          </div>
          <div className="flex justify-end">
            <button type="button" disabled={props.saving} onClick={props.onRunGeneration} className={btnPrimary()}>
              Run command to produce evidence
            </button>
          </div>
        </div>
      )}

      {props.showAttachAction && r.generation.kind === 'manual' && (
        <form
          className="mt-3 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const input: AttachEvidenceInput = { name: name.trim() || r.title };
            if (r.kind === 'note' || r.kind === 'test-output') input.body = body.trim();
            if (r.kind === 'url') input.url = url.trim();
            if (r.kind === 'screenshot' || r.kind === 'video' || r.kind === 'file') input.path = path.trim();
            props.onAttach(input);
          }}
        >
          <label className="text-[11px] text-[var(--gs-text-muted)]">
            Evidence label
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
          </label>
          {r.kind === 'url' && (
            <label className="text-[11px] text-[var(--gs-text-muted)]">URL
              <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/evidence" className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
            </label>
          )}
          {(r.kind === 'screenshot' || r.kind === 'video' || r.kind === 'file') && (
            <label className="text-[11px] text-[var(--gs-text-muted)]">Local path
              <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/abs/path/to/file" className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
            </label>
          )}
          {(r.kind === 'note' || r.kind === 'test-output') && (
            <label className="text-[11px] text-[var(--gs-text-muted)]">Note body
              <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste or describe the evidence" className={`mt-1 min-h-[80px] w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 font-mono text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
            </label>
          )}
          <div className="flex justify-end">
            <button type="submit" disabled={props.saving} className={btnPrimary()}>
              Attach evidence
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EvidenceChip(props: { evidence: Evidence }) {
  const e = props.evidence;
  return (
    <div className={`flex items-center gap-2 ${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1.5 text-xs`}>
      <strong className="text-[var(--gs-text)]">{e.name}</strong>
      <span className="text-[var(--gs-text-muted)]">— {e.meta}</span>
      <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">via {e.source}</span>
    </div>
  );
}

function ReviewsSection(props: {
  requirement: Requirement;
  onRunJudgment: () => void;
  onRecordHuman: (decision: HumanReviewDecision, note: string) => void;
  onReopen: () => void;
  showJudgmentAction: boolean;
  showReopenAction: boolean;
  showLockedNote: boolean;
  saving?: boolean;
}) {
  const r = props.requirement;
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setNote(''); setError(null); }, [r.id]);

  return (
    <div className={`${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] p-3`}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Reviews</div>
      {r.reviews.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {r.reviews.map((rv) => (
            <div key={rv.id} className="text-xs">
              <span className={`inline-flex items-center gap-1 ${reviewToneClass(rv.tone)}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(rv.tone === 'green' ? 'accepted' : rv.tone === 'amber' ? 'review' : 'missing')}`} />
                {rv.who} · {reviewToneLabel(rv.tone)}
              </span>{' '}
              <span className="text-[var(--gs-text-muted)]">— {rv.note}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-xs text-[var(--gs-text-muted)]">No reviews yet.</div>
      )}

      {props.showLockedNote && <div className="mt-3 text-xs text-[var(--gs-text-muted)]">Judgment unlocks after evidence is produced.</div>}

      {props.showJudgmentAction && r.judgment.kind === 'human' && (
        <div className="mt-3 space-y-2">
          <label className="text-[11px] text-[var(--gs-text-muted)]">Review note <span className="text-[var(--gs-text-dim)]">(required for fail / needs changes)</span>
            <textarea value={note} onChange={(e) => { setNote(e.target.value); setError(null); }} className={`mt-1 min-h-[72px] w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
          </label>
          {error && <div className="text-[11px] text-[var(--gs-danger)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={props.saving} onClick={() => { if (!note.trim()) { setError('A note is required to fail this requirement.'); return; } props.onRecordHuman('fail', note); }} className={btnDanger()}>
              Fail
            </button>
            <button type="button" disabled={props.saving} onClick={() => { if (!note.trim()) { setError('A note is required to request changes.'); return; } props.onRecordHuman('changes', note); }} className="inline-flex items-center justify-center gap-1.5 rounded-[var(--gs-btn-radius)] border border-[var(--gs-warning)] bg-[var(--gs-chip-amber-bg)] px-3 py-1.5 text-xs font-medium text-[var(--gs-warning)] transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96] disabled:opacity-40">
              Needs changes
            </button>
            <button type="button" disabled={props.saving} onClick={() => props.onRecordHuman('pass', note)} className={btnPrimary()}>
              Pass
            </button>
          </div>
        </div>
      )}

      {props.showJudgmentAction && r.judgment.kind === 'llm' && (
        <div className="mt-3 space-y-2">
          <div className={`${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-2`}>
            <div className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">LLM judge</div>
            <div className="mt-1 text-xs text-[var(--gs-text-muted)]">{r.judgment.modelHint || 'runner default'}</div>
          </div>
          <div className="flex justify-end">
            <button type="button" disabled={props.saving} onClick={props.onRunJudgment} className={btnPrimary()}>
              Run LLM judgment
            </button>
          </div>
        </div>
      )}

      {props.showJudgmentAction && r.judgment.kind === 'command' && (
        <div className="mt-3 space-y-2">
          <div className={`${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-2`}>
            <div className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Check command</div>
            <div className="mt-1 font-mono text-[11px] text-[var(--gs-text)]">{r.judgment.command}</div>
            <div className="mt-1 text-[10px] text-[var(--gs-text-muted)]">Expect: <code className="text-[var(--gs-text)]">{expectLabel(r.judgment.expect)}</code></div>
          </div>
          <div className="flex justify-end">
            <button type="button" disabled={props.saving} onClick={props.onRunJudgment} className={btnPrimary()}>
              Run check
            </button>
          </div>
        </div>
      )}

      {props.showReopenAction && (
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={props.onReopen} className={btnSecondary()}>
            Reopen for review
          </button>
        </div>
      )}
    </div>
  );
}

function RequirementForm(props: {
  mode: 'add' | 'edit';
  initial: RequirementFormDraft;
  onCancel: () => void;
  onSubmit: (draft: RequirementFormDraft) => void;
  saving?: boolean;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) { setError('Title is required.'); return; }
    if (!draft.rubric.trim()) { setError('Rubric is required — what makes this evidence acceptable?'); return; }
    if (draft.generationKind === 'command' && !draft.generationCommand.trim()) { setError('Generation command is required.'); return; }
    if (draft.judgmentKind === 'command' && !draft.judgmentCommand.trim()) { setError('Judgment command is required.'); return; }
    if (draft.judgmentKind === 'command' && draft.judgmentExpect === 'stdout-contains' && !draft.judgmentExpectNeedle.trim()) { setError('stdout-contains needs a needle.'); return; }
    if (draft.judgmentKind === 'command' && draft.judgmentExpect === 'output-matches' && !draft.judgmentExpectPattern.trim()) { setError('output-matches needs a regex.'); return; }
    setError(null);
    props.onSubmit(draft);
  };

  return (
    <form className={`${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-4`} onSubmit={handleSubmit}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--gs-text)]">{props.mode === 'add' ? 'Add requirement' : 'Edit requirement'}</h3>
          <p className="mt-1 text-xs text-[var(--gs-text-muted)]">Three questions: what is it, how is it produced, how is it judged.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={props.onCancel} className={btnSecondary()}>Cancel</button>
          <button type="submit" disabled={props.saving} className={btnPrimary()}>
            {props.mode === 'add' ? 'Add' : 'Save'}
          </button>
        </div>
      </div>

      <FormSection number={1} title="What is it?">
        <label className="block text-[11px] text-[var(--gs-text-muted)]">
          Title
          <input type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Screenshot showing simplified hierarchy" className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
        </label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block text-[11px] text-[var(--gs-text-muted)]">
            Evidence kind
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ArtifactKind })} className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`}>
              {KIND_OPTIONS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
            </select>
          </label>
          <label className="block text-[11px] text-[var(--gs-text-muted)]">
            Required?
            <select value={draft.required ? 'true' : 'false'} onChange={(e) => setDraft({ ...draft, required: e.target.value === 'true' })} className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`}>
              <option value="true">required</option>
              <option value="false">optional</option>
            </select>
          </label>
        </div>
        <label className="mt-2 block text-[11px] text-[var(--gs-text-muted)]">
          Rubric
          <textarea value={draft.rubric} onChange={(e) => setDraft({ ...draft, rubric: e.target.value })} placeholder="What makes this evidence acceptable? Implementer reads it to know what to produce; judge applies it." className={`mt-1 min-h-[80px] w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
        </label>
      </FormSection>

      <FormSection number={2} title="How is it produced?">
        <RadioRow value={draft.generationKind} options={[{ k: 'manual', label: 'Manual' }, { k: 'command', label: 'Command' }]} onChange={(v) => setDraft({ ...draft, generationKind: v as 'manual' | 'command' })} />
        {draft.generationKind === 'command' && (
          <label className="mt-2 block text-[11px] text-[var(--gs-text-muted)]">
            Command
            <input type="text" value={draft.generationCommand} onChange={(e) => setDraft({ ...draft, generationCommand: e.target.value })} placeholder="scripts/capture.sh hover-state" className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 font-mono text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
          </label>
        )}
        {draft.generationKind === 'manual' && <div className="mt-2 text-[11px] text-[var(--gs-text-muted)]">A human or agent attaches the artifact directly. The UI shows an attach form on the requirement.</div>}
      </FormSection>

      <FormSection number={3} title="How is it judged?">
        <RadioRow value={draft.judgmentKind} options={[{ k: 'human', label: 'Human' }, { k: 'llm', label: 'LLM' }, { k: 'command', label: 'Command' }]} onChange={(v) => setDraft({ ...draft, judgmentKind: v as 'human' | 'llm' | 'command' })} />
        {draft.judgmentKind === 'human' && <div className="mt-2 text-[11px] text-[var(--gs-text-muted)]">A human reviewer reads the rubric and the evidence, then records pass / needs-changes / fail.</div>}
        {draft.judgmentKind === 'llm' && (
          <label className="mt-2 block text-[11px] text-[var(--gs-text-muted)]">
            Model hint <span className="text-[var(--gs-text-dim)]">(optional — runner picks a default otherwise)</span>
            <input type="text" value={draft.judgmentModelHint} onChange={(e) => setDraft({ ...draft, judgmentModelHint: e.target.value })} placeholder="claude-3.5-sonnet" className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
          </label>
        )}
        {draft.judgmentKind === 'command' && (
          <div className="mt-2 grid gap-2">
            <label className="block text-[11px] text-[var(--gs-text-muted)]">
              Command
              <input type="text" value={draft.judgmentCommand} onChange={(e) => setDraft({ ...draft, judgmentCommand: e.target.value })} placeholder="bun test src/components/__tests__/GoalDetailPanel.web.test.tsx" className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 font-mono text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
            </label>
            <label className="block text-[11px] text-[var(--gs-text-muted)]">
              Expect
              <select value={draft.judgmentExpect} onChange={(e) => setDraft({ ...draft, judgmentExpect: e.target.value as CommandExpectation['kind'] })} className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`}>
                {EXPECT_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </label>
            {draft.judgmentExpect === 'stdout-contains' && (
              <label className="block text-[11px] text-[var(--gs-text-muted)]">
                Required substring
                <input type="text" value={draft.judgmentExpectNeedle} onChange={(e) => setDraft({ ...draft, judgmentExpectNeedle: e.target.value })} className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
              </label>
            )}
            {draft.judgmentExpect === 'output-matches' && (
              <label className="block text-[11px] text-[var(--gs-text-muted)]">
                Required regex
                <input type="text" value={draft.judgmentExpectPattern} onChange={(e) => setDraft({ ...draft, judgmentExpectPattern: e.target.value })} className={`mt-1 w-full ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 font-mono text-xs text-[var(--gs-text)] outline-none focus:border-[var(--gs-input-focus-border)]`} />
              </label>
            )}
          </div>
        )}
      </FormSection>

      {error && <div className="mt-3 text-xs text-[var(--gs-danger)]">{error}</div>}
    </form>
  );
}

function FormSection(props: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className={`mt-3 ${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] p-3`}>
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--gs-text)]">
        <span className={`${R_CHIP} bg-[var(--gs-bg-active)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--gs-text-dim)]`}>{props.number}</span>
        {props.title}
      </h4>
      {props.children}
    </div>
  );
}

function RadioRow(props: { value: string; options: Array<{ k: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {props.options.map((o) => (
        <button
          key={o.k}
          type="button"
          onClick={() => props.onChange(o.k)}
          className={`${R_CHIP} border px-2 py-1 text-xs transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96] ${props.value === o.k ? 'border-[var(--gs-selected-border)] bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'border-[var(--gs-border)] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Timeline tab ──────────────────────────────────────────────────────────

function TimelineTab(props: {
  events: TimelineEvent[];
  filter: 'all' | TimelineEvent['kind'];
  onFilterChange: (filter: 'all' | TimelineEvent['kind']) => void;
  selectedEvent: string | null;
  onSelectEvent: (id: string | null) => void;
  onJumpToRequirement: (reqId: string) => void;
}) {
  const filters: Array<{ k: 'all' | TimelineEvent['kind']; label: string }> = [
    { k: 'all', label: 'All' },
    { k: 'contract', label: 'Contract' },
    { k: 'generation', label: 'Generation' },
    { k: 'review', label: 'Reviews' },
    { k: 'readiness', label: 'Readiness' },
  ];
  const visible = [...props.events].reverse().filter((e) => props.filter === 'all' || e.kind === props.filter);
  const selected = visible.find((e) => e.id === props.selectedEvent) ?? visible[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-balance text-[var(--gs-text)]">Timeline</h2>
          <p className="mt-1 text-xs text-pretty text-[var(--gs-text-muted)]">How this goal got to its current state.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {filters.map((f) => (
          <button key={f.k} type="button" onClick={() => props.onFilterChange(f.k)} className={`${R_CHIP} border px-3 py-1 text-[11px] transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96] ${props.filter === f.k ? 'border-[var(--gs-selected-border)] bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'border-[var(--gs-border)] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'}`}>
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] tabular-nums text-[var(--gs-text-muted)]">{visible.length} of {props.events.length} events</span>
      </div>

      {visible.length === 0 ? (
        <div className={`${R_CARD} border border-dashed border-[var(--gs-border)] p-6 text-center text-xs text-[var(--gs-text-muted)]`}>
          No events recorded yet.
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_360px] gap-4">
          <div className="space-y-1">
            {visible.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => props.onSelectEvent(e.id)}
                className={`grid w-full gap-1 border-l-2 p-3 text-left text-xs transition-[background-color] duration-150 ${eventToneClass(e.tone)} ${selected?.id === e.id ? 'bg-[var(--gs-bg-active)]' : ''}`}
              >
                <span className="font-mono text-[10px] uppercase tracking-wide tabular-nums text-[var(--gs-text-dim)]">{formatRelativeTime(e.createdAt)}</span>
                <span className="font-medium text-[var(--gs-text)]">{e.title}</span>
                <span className="text-[var(--gs-text-muted)]">{e.body}</span>
              </button>
            ))}
          </div>
          {selected && (
            <div className={`sticky top-0 self-start ${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] p-4`}>
              <div className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">{selected.kind} event</div>
              <h3 className="mt-1 text-sm font-semibold text-[var(--gs-text)]">{selected.title}</h3>
              <p className="mt-1 text-xs text-[var(--gs-text-muted)]">{selected.body}</p>
              <pre className={`mt-3 overflow-auto ${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-2 font-mono text-[10px] text-[var(--gs-text-muted)]`}>{selected.payload}</pre>
              {selected.requirementId && (
                <button type="button" onClick={() => props.onJumpToRequirement(selected.requirementId!)} className={btnSecondary('mt-3')}>
                  Open requirement
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
