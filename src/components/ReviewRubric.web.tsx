/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CommandExpectation, Evidence, GoalValidation, Judgment, Requirement, Review } from '../types/goals.js';
import { renderMarkdownHtml } from './markdown-render.js';
import { useGoalPhaseInfo, type SendReviewRequestFn } from '../app/react/useGoalPhaseInfo.web.js';

/**
 * ReviewRubric — the '☰ Review rubric' dock pane (mock: ReviewRubric.tsx).
 * Two columns: LEFT rail = capped criterion index (scroll-spy synced) + the
 * active criterion's detail (badges, contract, score, judgement form) +
 * footer; RIGHT = lean per-criterion sections (verdict + title header, then
 * evidence cards with artifact previews and judgement rows). Read/judge
 * surface only — authoring stays in GoalDetailPanel.
 */

type Verdict = 'pass' | 'fail' | 'partial' | 'pending';
type Gate = Judgment['kind'];
type Decision = 'pass' | 'partial' | 'fail';

const VERDICT_LABEL: Record<Verdict, string> = { pass: 'pass', fail: 'fail', partial: 'partial', pending: 'pending' };

const VERDICT_CHIP: Record<Verdict, string> = {
  pass: 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]',
  fail: 'bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]',
  partial: 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]',
  pending: 'bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]',
};

const VERDICT_DOT: Record<Verdict, string> = {
  pass: 'bg-[var(--gs-success)]',
  fail: 'bg-[var(--gs-danger)]',
  partial: 'bg-[var(--gs-warning)]',
  pending: 'bg-[var(--gs-text-ghost)]',
};

const GATE_META: Record<Gate, { icon: string; label: string; cls: string }> = {
  human: { icon: '◆', label: 'human', cls: 'border-[rgba(188,140,255,0.3)] text-[var(--gs-purple)]' },
  llm: { icon: '✦', label: 'llm', cls: 'border-[rgba(91,155,255,0.25)] text-[var(--gs-info)]' },
  command: { icon: '❯', label: 'command', cls: 'border-[rgba(0,255,102,0.25)] text-[var(--gs-success)]' },
};

/** Judge type inferred from Review.who (core writes 'human' | 'command' | modelHint/llm). */
function judgeMeta(who: string): { icon: string; label: string; cls: string } {
  if (who === 'human') return { icon: '◆', label: 'human', cls: 'text-[var(--gs-purple)]' };
  if (who === 'command') return { icon: '❯', label: 'command', cls: 'text-[var(--gs-success)]' };
  return { icon: '✦', label: 'agent eval', cls: 'text-[var(--gs-info)]' };
}

function reviewVerdict(tone: Review['tone']): Verdict {
  return tone === 'green' ? 'pass' : tone === 'amber' ? 'partial' : 'fail';
}

/** Rollup: requirement status + review tones → the mock's verdict vocabulary. */
function verdictOf(r: Requirement): Verdict {
  if (r.status === 'accepted') return 'pass';
  if (r.reviews.some((rv) => rv.tone === 'red')) return 'fail';
  if (r.reviews.length > 0 || r.status === 'review') return 'partial';
  return 'pending';
}

/** Client-side 0-100 score from review tones (green 100 / amber 50 / red 0). */
function scoreOf(r: Requirement): number | undefined {
  if (r.reviews.length === 0) return undefined;
  const sum = r.reviews.reduce((a, rv) => a + (rv.tone === 'green' ? 100 : rv.tone === 'amber' ? 50 : 0), 0);
  return Math.round(sum / r.reviews.length);
}

function evidenceKind(ev: Evidence, fallback: Requirement['kind']): { label: string; cls: string } {
  if (ev.command || ev.stdout !== undefined) return { label: 'command', cls: 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]' };
  const mime = ev.mimeType ?? '';
  if (mime.startsWith('image/') || fallback === 'screenshot') return { label: 'screenshot', cls: 'bg-[var(--gs-chip-blue-bg)] text-[var(--gs-chip-blue-text)]' };
  if (mime.startsWith('video/') || fallback === 'video') return { label: 'video', cls: 'bg-[var(--gs-chip-dim-bg)] text-[var(--gs-purple)]' };
  if (ev.url || fallback === 'url') return { label: 'url', cls: 'bg-[var(--gs-chip-blue-bg)] text-[var(--gs-chip-blue-text)]' };
  if (ev.body !== undefined || fallback === 'note') return { label: 'note', cls: 'bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]' };
  return { label: fallback === 'test-output' ? 'test-output' : 'file', cls: 'bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]' };
}

function scoreTone(value: number): string {
  return value >= 80 ? 'bg-[var(--gs-success)]' : value >= 50 ? 'bg-[var(--gs-warning)]' : 'bg-[var(--gs-danger)]';
}

/** Compact HH:MM locale time; falls back to the raw string when unparseable. */
function compactTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function expectationLabel(expect: CommandExpectation): string {
  switch (expect.kind) {
    case 'exit-zero': return 'expects exit 0';
    case 'stdout-contains': return `stdout contains “${expect.needle}”`;
    case 'stderr-empty': return 'expects empty stderr';
    case 'output-matches': return `output matches /${expect.pattern}/`;
  }
}

/** The commands a criterion carries: how to (re)generate evidence and how the verdict is checked. */
function requirementCommands(r: Requirement): Array<{ role: 'generate' | 'verify'; command: string; expectation?: string }> {
  const out: Array<{ role: 'generate' | 'verify'; command: string; expectation?: string }> = [];
  if (r.generation.kind === 'command') out.push({ role: 'generate', command: r.generation.command });
  if (r.judgment.kind === 'command') out.push({ role: 'verify', command: r.judgment.command, expectation: expectationLabel(r.judgment.expect) });
  return out;
}

/** Latest captured run of a given command from the requirement's evidence trail. */
function lastRunOf(r: Requirement, command: string): Evidence | undefined {
  for (let i = r.evidence.length - 1; i >= 0; i--) {
    const ev = r.evidence[i];
    if (ev && ev.command === command) return ev;
  }
  return undefined;
}

function ExitChip({ exitCode }: { exitCode: number }): ReactElement {
  return (
    <span className={`inline-flex flex-shrink-0 items-center rounded-[var(--gs-chip-radius)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide font-[family-name:var(--gs-font-mono)] ${
      exitCode === 0 ? 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]' : 'bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]'
    }`}>
      exit {exitCode}
    </span>
  );
}

/** Mono, copyable command row with the judgment expectation + the last captured run. */
function CommandRow({ requirement, role, command, expectation }: {
  requirement: Requirement;
  role: 'generate' | 'verify';
  command: string;
  expectation?: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const run = lastRunOf(requirement, command);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  };
  return (
    <div className="border border-[var(--gs-border)] bg-black">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <span className={`mt-px w-[54px] flex-shrink-0 text-[9px] uppercase tracking-[0.08em] ${role === 'verify' ? 'text-[var(--gs-success)]' : 'text-[var(--gs-info)]'}`}>
          ❯ {role}
        </span>
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[11px] leading-[1.5] text-[var(--gs-text)] font-[family-name:var(--gs-font-mono)]">{command}</code>
        <button
          type="button"
          onClick={copy}
          title="Copy command"
          className="flex-shrink-0 border border-[var(--gs-border)] px-1.5 py-px text-[10px] text-[var(--gs-text-dim)] transition-[border-color,color] duration-150 hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
        >
          {copied ? '✓ copied' : '⧉ copy'}
        </button>
      </div>
      {(expectation || run) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--gs-border-muted)] px-2 py-1">
          {expectation && <span className="text-[10px] text-[var(--gs-text-dim)]">{expectation}</span>}
          {run && (
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">
              last run {compactTime(run.createdAt)}
              {typeof run.exitCode === 'number' && <ExitChip exitCode={run.exitCode} />}
            </span>
          )}
          {!run && expectation && <span className="ml-auto text-[10px] italic text-[var(--gs-text-ghost)]">no captured run yet</span>}
        </div>
      )}
    </div>
  );
}

function ScoreBar({ value, small }: { value: number; small?: boolean }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block overflow-hidden bg-[var(--gs-bg-active)] ${small ? 'h-[4px] w-[42px]' : 'h-[5px] w-[60px]'}`}>
        <span className={`block h-full ${scoreTone(value)}`} style={{ width: `${value}%` }} />
      </span>
      <span className="text-[10px] tabular-nums text-[var(--gs-text-dim)] font-[family-name:var(--gs-font-mono)]">{value}</span>
    </span>
  );
}

function VerdictChip({ verdict }: { verdict: Verdict }): ReactElement {
  return (
    <span className={`inline-flex items-center rounded-[var(--gs-chip-radius)] border border-[var(--gs-border)] px-[7px] py-[2px] text-[10.5px] font-normal uppercase tracking-wide ${VERDICT_CHIP[verdict]}`}>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function GateChip({ gate }: { gate: Gate }): ReactElement {
  const m = GATE_META[gate];
  return (
    <span className={`inline-flex items-center gap-1 rounded-[var(--gs-chip-radius)] border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${m.cls}`}>
      {m.icon} {m.label} gate
    </span>
  );
}

/** Dim journal-phase stamp (requirements ⇄ phases join). */
function PhaseBadge({ phase }: { phase: string }): ReactElement {
  return (
    <span
      className="inline-flex items-center rounded-[var(--gs-chip-radius)] border border-[var(--gs-border)] px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]"
      title={`declared in phase ${phase}`}
    >
      ⧗ {phase}
    </span>
  );
}

/** 'advanced in <phase>' chips from the journal's delta.requirementsAdvanced. */
function AdvancedInChips({ phases }: { phases: string[] }): ReactElement | null {
  if (phases.length === 0) return null;
  return (
    <>
      {phases.map((p) => (
        <span
          key={p}
          className="inline-flex items-center rounded-[var(--gs-chip-radius)] border border-[rgba(188,140,255,0.3)] px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-[var(--gs-purple)]"
          title={`status advanced during phase ${p}`}
        >
          advanced in {p}
        </span>
      ))}
    </>
  );
}

/** ArtifactPreview-equivalent: render the evidence payload inline (mock ArtifactPreview.tsx). */
function EvidencePreview({ evidence }: { evidence: Evidence }): ReactElement {
  const mime = evidence.mimeType ?? '';
  if (evidence.command || evidence.stdout !== undefined) {
    const text = [
      evidence.command ? `$ ${evidence.command}` : null,
      evidence.stdout?.trimEnd() || null,
      evidence.stderr?.trimEnd() ? `[stderr]\n${evidence.stderr.trimEnd()}` : null,
      typeof evidence.exitCode === 'number' ? `(exit ${evidence.exitCode})` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return (
      <pre className="m-0 max-h-[260px] overflow-auto whitespace-pre-wrap border border-[var(--gs-border)] bg-black px-2.5 py-2 text-[11px] leading-[1.6] text-[var(--gs-text)] font-[family-name:var(--gs-font-mono)]">
        {text || '(no output captured)'}
      </pre>
    );
  }
  if (mime.startsWith('image/') && evidence.previewUrl) {
    return (
      <div>
        <img className="block max-w-full border border-[var(--gs-border)]" src={evidence.previewUrl} alt={evidence.displayName || evidence.name} />
        {typeof evidence.sizeBytes === 'number' && (
          <div className="mt-[5px] text-[10px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">{(evidence.sizeBytes / 1024).toFixed(1)} KB</div>
        )}
      </div>
    );
  }
  if (mime.startsWith('video/')) {
    return (
      <div className="flex items-center gap-2.5 border border-[var(--gs-border)] bg-black px-3 py-3.5">
        <span className="text-[16px] text-[var(--gs-purple)]">▶</span>
        <span className="text-[11px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">{evidence.artifactPath || evidence.originalPath || evidence.name}</span>
      </div>
    );
  }
  if (evidence.url) {
    return (
      <a
        className="text-[11px] text-[var(--gs-info)] font-[family-name:var(--gs-font-mono)] hover:underline"
        href={evidence.url}
        target="_blank"
        rel="noreferrer"
      >
        {evidence.url}
      </a>
    );
  }
  if (evidence.body !== undefined && evidence.body !== '') {
    return (
      <pre className="m-0 max-h-[260px] overflow-auto whitespace-pre-wrap border border-[var(--gs-border)] bg-black px-2.5 py-2 text-[11px] leading-[1.6] text-[var(--gs-text)] font-[family-name:var(--gs-font-mono)]">
        {evidence.body}
      </pre>
    );
  }
  return (
    <div className="text-[11px] text-[var(--gs-info)] font-[family-name:var(--gs-font-mono)]">
      <span className="text-[var(--gs-text-ghost)]">file</span> {evidence.artifactPath || evidence.originalPath || evidence.name}
    </div>
  );
}

/** Evidence card (mock .rc-ev): header row with kind/name/meta/ref/source + inline artifact preview body. */
function EvidenceCard({ requirement, evidence, onOpenEvidence }: {
  requirement: Requirement;
  evidence: Evidence;
  onOpenEvidence?: (requirementId: string, evidenceId: string) => void;
}): ReactElement {
  const kind = evidenceKind(evidence, requirement.kind);
  const captured = evidence.source === 'command';
  const clickable = Boolean(onOpenEvidence);
  const Head = clickable ? 'button' : 'div';
  return (
    <div className="border border-[var(--gs-border)] bg-[var(--gs-bg)]">
      <Head
        {...(clickable ? { type: 'button' as const, onClick: () => onOpenEvidence?.(requirement.id, evidence.id), title: `Open evidence ${evidence.name}` } : {})}
        className={`flex w-full items-center gap-[7px] border-b border-[var(--gs-border-muted)] bg-[#060606] px-[9px] py-1.5 text-left ${clickable ? 'cursor-pointer transition-[background-color] duration-150 hover:bg-[var(--gs-bg-elevated)]' : ''}`}
      >
        <span className={`inline-flex flex-shrink-0 items-center rounded-[var(--gs-chip-radius)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${kind.cls}`}>{kind.label}</span>
        <span className="min-w-0 truncate text-[11px] text-[var(--gs-text)] font-[family-name:var(--gs-font-mono)]">{evidence.displayName || evidence.name}</span>
        {evidence.meta && <span className="min-w-0 truncate text-[10.5px] text-[var(--gs-text-muted)]">— {evidence.meta}</span>}
        <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]" title="artifact ref">{evidence.id}</span>
        {typeof evidence.exitCode === 'number' && <ExitChip exitCode={evidence.exitCode} />}
        <span className={`inline-flex flex-shrink-0 items-center rounded-[var(--gs-chip-radius)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${captured ? 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]' : 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]'}`}>
          {captured ? 'captured' : 'asserted'}
        </span>
      </Head>
      <div className="px-[11px] py-[9px]">
        <EvidencePreview evidence={evidence} />
      </div>
    </div>
  );
}

function JudgementRow({ review }: { review: Review }): ReactElement {
  // Prefer the recorded judgeType (scores/cites model); fall back to who-inference.
  const meta = judgeMeta(review.judgeType ?? review.who);
  const verdict = reviewVerdict(review.tone);
  const score = typeof review.score === 'number' ? Math.max(0, Math.min(100, review.score)) : undefined;
  return (
    <div className="flex items-start gap-2 border-t border-[var(--gs-border-muted)] py-2 first:border-t-0">
      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center border border-[var(--gs-border)] text-[11px] ${meta.cls}`} title={meta.label}>
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] font-medium text-[var(--gs-text)]">{review.createdBy || review.who}</span>
          <span className="text-[9.5px] uppercase tracking-wide text-[var(--gs-text-ghost)]">{meta.label}</span>
          <VerdictChip verdict={verdict} />
          {score !== undefined && (
            <span className="flex items-center gap-1" title={`score ${score}`}>
              <span className="inline-block h-[4px] w-[42px] overflow-hidden bg-[var(--gs-bg-active)]">
                <span className={`block h-full ${scoreTone(score)}`} style={{ width: `${score}%` }} />
              </span>
              <span className="text-[10px] tabular-nums text-[var(--gs-text-dim)]">{score}</span>
            </span>
          )}
          <span className="ml-auto text-[10px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]" title={review.createdAt}>{compactTime(review.createdAt)}</span>
        </div>
        <div className="mt-1 text-[12px] leading-[1.5] text-[var(--gs-text-muted)]">{review.note}</div>
        {(review.cites ?? []).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {review.cites!.map((c) => (
              <span key={c} className="font-[family-name:var(--gs-font-mono)] text-[10px] text-[var(--gs-text-dim)]">↳ {c}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Human judgement form — pass/partial/fail + score slider + required note, submits via onRecordHuman. */
function MakeJudgement({ requirementId, onRecordHuman, onDone }: {
  requirementId: string;
  onRecordHuman: (requirementId: string, decision: Decision, note: string, score?: number) => Promise<void>;
  onDone: () => void;
}): ReactElement {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [score, setScore] = useState(70);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const PICK_ON: Record<Decision, string> = {
    pass: 'border-[var(--gs-success)] bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]',
    partial: 'border-[var(--gs-warning)] bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]',
    fail: 'border-[var(--gs-danger)] bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]',
  };

  const submit = async () => {
    if (!decision || !note.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRecordHuman(requirementId, decision, note.trim(), score);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record judgement');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-t-[rgba(188,140,255,0.18)] bg-[rgba(188,140,255,0.04)] px-[13px] py-[11px]">
      <div className="text-[11px] font-medium text-[var(--gs-purple)]">
        ◆ your judgement <span className="font-normal text-[var(--gs-text-ghost)]">— this criterion is human-gated</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-[7px]">
        {(['pass', 'partial', 'fail'] as Decision[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDecision(d)}
            className={`border px-2.5 py-1 text-[11px] uppercase tracking-wide transition-[border-color,background-color,color,scale] duration-150 active:scale-[0.96] ${
              decision === d ? PICK_ON[d] : 'border-[var(--gs-border)] text-[var(--gs-text-dim)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]'
            }`}
          >
            {d}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-[7px] text-[10.5px] uppercase tracking-wide text-[var(--gs-text-dim)]">
          score
          <input
            type="range"
            min={0}
            max={100}
            value={score}
            onChange={(e) => setScore(Number(e.target.value))}
            className="w-[110px] accent-[var(--gs-purple)]"
          />
          <span className="tabular-nums text-[var(--gs-text-muted)] font-[family-name:var(--gs-font-mono)]">{score}</span>
        </label>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why — cite what the evidence on the right does or doesn't prove…"
        rows={3}
        className="mt-2 min-h-[52px] w-full resize-y border border-[var(--gs-border)] bg-black px-2.5 py-2 text-[12px] leading-[1.5] text-[var(--gs-text)] placeholder:text-[var(--gs-text-ghost)] focus:border-[var(--gs-border-active)] focus:outline-none"
      />
      {error && <div className="mt-1 text-[11px] text-[var(--gs-danger)]">{error}</div>}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={!decision || !note.trim() || busy}
          onClick={() => void submit()}
          className="rounded-[var(--gs-btn-radius)] bg-[var(--gs-accent)] px-3 py-1.5 text-xs font-medium text-[var(--gs-text-on-accent)] transition-[background-color,scale] duration-150 active:scale-[0.96] hover:bg-[var(--gs-accent-hover)] disabled:pointer-events-none disabled:opacity-40"
        >
          {busy ? 'Recording…' : 'Record judgement'}
        </button>
      </div>
    </div>
  );
}

export function ReviewRubric({ goal, onRecordHuman, onRunJudgment, onOpenEvidence, sendReviewRequest, projectName, workspaceName }: {
  goal: { id: string; title: string; phase?: string; validation: GoalValidation } | null;
  onRecordHuman: (requirementId: string, decision: Decision, note: string, score?: number) => Promise<void>;
  onRunJudgment?: (requirementId: string) => Promise<void>;
  onOpenEvidence?: (requirementId: string, evidenceId: string) => void;
  /** Optional journal loader (requirements ⇄ phases join): one
   *  get_review_guide_state per pane load for 'advanced in <phase>' chips. */
  sendReviewRequest?: SendReviewRequestFn;
  projectName?: string;
  workspaceName?: string;
}): ReactElement {
  const phaseInfo = useGoalPhaseInfo(sendReviewRequest, projectName, workspaceName);
  const [active, setActive] = useState(0);
  const [recorded, setRecorded] = useState<Record<string, boolean>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<(HTMLElement | null)[]>([]);
  // While a click-initiated smooth scroll is in flight, the scroll-spy must
  // not fight the explicit selection.
  const suppressSpyUntilRef = useRef(0);

  const crits = useMemo(() => {
    if (!goal) return [];
    return goal.validation.reqOrder
      .map((id) => goal.validation.requirements[id])
      .filter((r): r is Requirement => Boolean(r))
      .map((r) => {
        const gate = r.judgment.kind;
        const humanCast = r.reviews.some((rv) => rv.who === 'human') || Boolean(recorded[r.id]);
        return {
          r,
          gate,
          verdict: verdictOf(r),
          score: scoreOf(r),
          awaiting: gate === 'human' && r.status !== 'accepted' && !humanCast,
        };
      });
  }, [goal, recorded]);

  // Scroll-spy: as the USER scrolls the right column, the visible criterion
  // lights up on the left. Deliberately not run on mount/refresh (the pane
  // must not jump to the last item on load), and inert while the column has
  // nothing to scroll — selection is then purely click-driven.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const recompute = () => {
      if (secRefs.current.length === 0) return;
      if (Date.now() < suppressSpyUntilRef.current) return;
      const scrollable = root.scrollHeight > root.clientHeight + 4;
      if (!scrollable) return;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
        setActive(secRefs.current.length - 1);
        return;
      }
      const line = root.getBoundingClientRect().top + 80;
      let idx = 0;
      secRefs.current.forEach((el, i) => {
        if (el && el.getBoundingClientRect().top <= line) idx = i;
      });
      setActive(idx);
    };
    root.addEventListener('scroll', recompute, { passive: true });
    return () => root.removeEventListener('scroll', recompute);
  }, [crits.length]);

  // Keep the selection in range when criteria are removed on refresh.
  useEffect(() => {
    setActive((a) => Math.max(0, Math.min(a, crits.length - 1)));
  }, [crits.length]);

  const go = useCallback((i: number) => {
    setActive(i);
    suppressSpyUntilRef.current = Date.now() + 800;
    secRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const runJudgment = useCallback(async (requirementId: string) => {
    if (!onRunJudgment || runningId) return;
    setRunningId(requirementId);
    try {
      await onRunJudgment(requirementId);
    } finally {
      setRunningId(null);
    }
  }, [onRunJudgment, runningId]);

  if (!goal || crits.length === 0) {
    return (
      <div className="gs-ui flex h-full min-h-0 flex-col items-center justify-center gap-1 bg-[var(--gs-bg)] p-6 text-center">
        <div className="text-[13px] text-[var(--gs-text-dim)]">☰ No review rubric yet</div>
        <div className="max-w-[360px] text-[11px] leading-[1.5] text-[var(--gs-text-ghost)]">
          The rubric appears once this workspace's goal carries validation requirements. Author criteria from the goal detail panel.
        </div>
      </div>
    );
  }

  const act = crits[Math.min(active, crits.length - 1)];

  return (
    <div className="gs-ui flex h-full min-h-0 flex-col bg-[var(--gs-bg)]">
      <div className="grid min-h-0 flex-1 grid-cols-[380px_1fr]">
        {/* left rail: index (capped) + active-criterion detail + footer */}
        <div className="flex min-h-0 flex-col overflow-hidden border-r border-[var(--gs-border)] bg-[#050505]">
          <div className="flex flex-none items-center gap-2 border-b border-[var(--gs-border)] px-3.5 py-3 text-[12px] font-medium text-[var(--gs-text)]">
            <span>Review rubric <span className="text-[var(--gs-text-ghost)]">· the contract</span></span>
            {goal.phase && (
              <span className="ml-auto border border-[var(--gs-border)] px-1.5 py-px text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]" title="workspace goal phase">
                phase · {goal.phase}
              </span>
            )}
          </div>
          <div className="max-h-[34%] flex-none overflow-y-auto border-b border-[var(--gs-border)] py-1.5">
            {crits.map((c, i) => (
              <button
                key={c.r.id}
                type="button"
                onClick={() => go(i)}
                className={`flex w-full items-start gap-[9px] px-3.5 py-[7px] text-left transition-[background-color,color] duration-150 ${
                  active === i ? 'bg-[var(--gs-bg-active)]' : 'hover:bg-[var(--gs-bg-elevated)]'
                }`}
              >
                <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${VERDICT_DOT[c.verdict]}`} title={VERDICT_LABEL[c.verdict]} />
                <span className={`min-w-0 flex-1 text-[12px] leading-[1.35] ${active === i ? 'font-medium text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)]'}`}>
                  {c.r.title}
                </span>
                {c.r.wfPhase && (
                  <span className="mt-0.5 flex-shrink-0 text-[9px] uppercase tracking-[0.08em] text-[var(--gs-text-ghost)]" title={`declared in phase ${c.r.wfPhase}`}>
                    ⧗ {c.r.wfPhase}
                  </span>
                )}
                <span className={`mt-0.5 flex-shrink-0 text-[10px] ${GATE_META[c.gate].cls}`} title={`${GATE_META[c.gate].label} gate`}>
                  {GATE_META[c.gate].icon}
                </span>
                <span className="mt-0.5 flex-shrink-0 text-[10px] tabular-nums text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]" title={`${c.r.evidence.length} evidence`}>
                  {c.r.evidence.length}ev
                </span>
                {typeof c.score === 'number' && (
                  <span className="mt-0.5 flex-shrink-0 text-[10px] tabular-nums text-[var(--gs-text-dim)] font-[family-name:var(--gs-font-mono)]">{c.score}</span>
                )}
              </button>
            ))}
          </div>

          {/* active criterion detail — stays put while the right column scrolls */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
            {act && (
              <>
                <div className="mb-[9px] flex flex-wrap items-center gap-[7px]">
                  <VerdictChip verdict={act.verdict} />
                  {act.r.required && (
                    <span className="border border-[var(--gs-border)] px-[5px] py-px text-[10.5px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">required</span>
                  )}
                  <GateChip gate={act.gate} />
                </div>
                <div className="mb-2 text-[14px] font-medium leading-[1.4] text-[var(--gs-text)]">{act.r.title}</div>
                <div
                  className="gs-block-md mb-2.5 text-[12px] leading-[1.55] text-[var(--gs-text-muted)]"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(act.r.rubric) }}
                />
                {requirementCommands(act.r).length > 0 && (
                  <div className="mb-2.5 flex flex-col gap-1.5">
                    {requirementCommands(act.r).map((cmd) => (
                      <CommandRow key={`${cmd.role}:${cmd.command}`} requirement={act.r} role={cmd.role} command={cmd.command} expectation={cmd.expectation} />
                    ))}
                  </div>
                )}
                <div className="mb-3 flex items-center gap-2.5 text-[10.5px] text-[var(--gs-text-dim)]">
                  {typeof act.score === 'number' && <ScoreBar value={act.score} />}
                  <span>
                    {act.r.reviews.length} {act.r.reviews.length === 1 ? 'judge' : 'judges'} · {act.r.evidence.length} evidence
                  </span>
                  {onRunJudgment && act.gate !== 'human' && act.r.status !== 'accepted' && (
                    <button
                      type="button"
                      disabled={runningId !== null}
                      onClick={() => void runJudgment(act.r.id)}
                      className={`ml-auto border px-2 py-1 text-[10px] uppercase tracking-wide transition-[border-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 ${GATE_META[act.gate].cls} hover:bg-[var(--gs-bg-active)]`}
                    >
                      {runningId === act.r.id ? 'running…' : `${GATE_META[act.gate].icon} run judgment`}
                    </button>
                  )}
                </div>
                {act.awaiting ? (
                  <MakeJudgement
                    requirementId={act.r.id}
                    onRecordHuman={onRecordHuman}
                    onDone={() => setRecorded((m) => ({ ...m, [act.r.id]: true }))}
                  />
                ) : (
                  <div className="border border-dashed border-[var(--gs-border)] px-2.5 py-2 text-[11px] text-[var(--gs-text-dim)]">
                    {act.gate === 'human'
                      ? <span className="text-[var(--gs-purple)]">◆ your verdict recorded</span>
                      : `${GATE_META[act.gate].icon} ${act.gate}-gated — no human verdict required`}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex-none border-t border-[var(--gs-border)] px-3.5 py-[9px] text-[10px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">
            {crits.length} criteria · gated exit owned by human approval
          </div>
        </div>

        {/* right: lean per-criterion sections — evidence cards + judgement rows */}
        <div ref={scrollRef} className="min-h-0 overflow-y-auto px-[18px] py-4">
          {crits.map((c, i) => (
            <section
              key={c.r.id}
              ref={(el) => { secRefs.current[i] = el; }}
              className={`mb-4 scroll-mt-2 border bg-[var(--gs-bg-elevated)] transition-[border-color] duration-150 ${active === i ? 'border-[var(--gs-border-active)]' : 'border-[var(--gs-border)]'}`}
            >
              <div className="sticky top-0 z-10 flex flex-wrap items-center gap-[9px] border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-2.5">
                <VerdictChip verdict={c.verdict} />
                <span className="text-[13px] font-medium text-[var(--gs-text)]">{c.r.title}</span>
                <GateChip gate={c.gate} />
                {c.r.wfPhase && <PhaseBadge phase={c.r.wfPhase} />}
                <AdvancedInChips phases={phaseInfo?.advancedPhases[c.r.id] ?? []} />
                {typeof c.score === 'number' && <ScoreBar value={c.score} small />}
                {c.awaiting && (
                  <span className="ml-auto border border-[rgba(188,140,255,0.3)] px-1.5 py-px text-[12px] tracking-[0.04em] text-[var(--gs-purple)]">
                    awaiting your verdict
                  </span>
                )}
              </div>

              <div className="p-3">
                {/* criterion — what this item demands, always visible per section */}
                <div
                  className="gs-block-md mb-2 text-[11.5px] leading-[1.55] text-[var(--gs-text-muted)]"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(c.r.rubric) }}
                />

                {/* verification commands — how evidence is (re)generated and checked */}
                {requirementCommands(c.r).length > 0 && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    {requirementCommands(c.r).map((cmd) => (
                      <CommandRow key={`${cmd.role}:${cmd.command}`} requirement={c.r} role={cmd.role} command={cmd.command} expectation={cmd.expectation} />
                    ))}
                  </div>
                )}

                {/* evidence */}
                <div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-ghost)]">
                  evidence <span className="normal-case tracking-normal">· {c.r.evidence.length}</span>
                </div>
                {c.r.evidence.length === 0 ? (
                  <div className="text-[11.5px] italic text-[var(--gs-text-dim)]">no evidence collected yet</div>
                ) : (
                  <div className="flex flex-col gap-[7px]">
                    {c.r.evidence.map((ev) => (
                      <EvidenceCard key={ev.id} requirement={c.r} evidence={ev} onOpenEvidence={onOpenEvidence} />
                    ))}
                  </div>
                )}

                {/* judgements */}
                <div className="mb-0.5 mt-3.5 text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-ghost)]">
                  judgements <span className="normal-case tracking-normal">· {c.r.reviews.length} {c.r.reviews.length === 1 ? 'judge' : 'judges'}</span>
                </div>
                {c.r.reviews.length > 0 && (
                  <div>{c.r.reviews.map((rv) => <JudgementRow key={rv.id} review={rv} />)}</div>
                )}
              </div>
            </section>
          ))}

          {/* right-column footer callout (mock .callout.rc-foot) */}
          <div className="mt-4 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-info)] bg-[var(--gs-bg)] px-[13px] py-2.5 text-[12.5px] leading-[1.55] text-[var(--gs-text-muted)]">
            <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-[var(--gs-text-dim)]">top-level + per-phase</div>
            This is the workspace's top-level review rubric. Each workflow phase can carry its own <b className="text-[var(--gs-text)]">mini rubric</b> (e.g.{' '}
            <code className="bg-[var(--gs-bg-active)] px-[5px] py-px text-[11px] text-[var(--gs-text)] font-[family-name:var(--gs-font-mono)]">type-review rubric</code>) passed to that
            phase's reviewer — see the Workflow phase artifacts.
          </div>
        </div>
      </div>
    </div>
  );
}
