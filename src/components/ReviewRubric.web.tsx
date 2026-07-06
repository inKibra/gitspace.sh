/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Evidence, GoalValidation, Judgment, Requirement, Review } from '../types/goals.js';
import { renderMarkdownHtml } from './markdown-render.js';

/**
 * ReviewRubric — the '☰ Review rubric' dock pane (mock: ReviewRubric.tsx).
 * Two columns: LEFT index of criteria (verdict dot, gate chip, score/evidence
 * count, scroll-spy synced), RIGHT scrolling detail per criterion (rubric
 * contract, evidence rows, judgements, and a 'your judgement' form for
 * human-gated criteria still awaiting a verdict). Read/judge surface only —
 * authoring stays in GoalDetailPanel.
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
  human: { icon: '◆', label: 'human', cls: 'border-[var(--gs-purple)] text-[var(--gs-purple)]' },
  llm: { icon: '✦', label: 'llm', cls: 'border-[var(--gs-info)] text-[var(--gs-info)]' },
  command: { icon: '❯', label: 'command', cls: 'border-[var(--gs-success)] text-[var(--gs-success)]' },
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

function ScoreBar({ value, small }: { value: number; small?: boolean }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block overflow-hidden rounded-[2px] bg-[var(--gs-bg-active)] ${small ? 'h-[4px] w-[42px]' : 'h-[5px] w-[60px]'}`}>
        <span className={`block h-full ${scoreTone(value)}`} style={{ width: `${value}%` }} />
      </span>
      <span className="text-[10px] tabular-nums text-[var(--gs-text-dim)] font-[family-name:var(--gs-font-mono)]">{value}</span>
    </span>
  );
}

function VerdictChip({ verdict }: { verdict: Verdict }): ReactElement {
  return (
    <span className={`inline-flex items-center rounded-[var(--gs-chip-radius)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${VERDICT_CHIP[verdict]}`}>
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

function EvidenceRow({ requirement, evidence, onOpenEvidence }: {
  requirement: Requirement;
  evidence: Evidence;
  onOpenEvidence?: (requirementId: string, evidenceId: string) => void;
}): ReactElement {
  const kind = evidenceKind(evidence, requirement.kind);
  const captured = evidence.source === 'command';
  const clickable = Boolean(onOpenEvidence);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => onOpenEvidence?.(requirement.id, evidence.id)}
      title={clickable ? `Open evidence ${evidence.name}` : evidence.name}
      className={`flex w-full items-center gap-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1.5 text-left transition-[border-color,background-color] duration-150 ${clickable ? 'hover:border-[var(--gs-border-active)] hover:bg-[var(--gs-bg-active)]' : 'cursor-default'}`}
    >
      <span className={`inline-flex flex-shrink-0 items-center rounded-[var(--gs-chip-radius)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${kind.cls}`}>{kind.label}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--gs-text)] font-[family-name:var(--gs-font-mono)]">
        {evidence.displayName || evidence.name}
        {evidence.meta && <span className="text-[var(--gs-text-muted)]"> — {evidence.meta}</span>}
      </span>
      <span className={`inline-flex flex-shrink-0 items-center rounded-[var(--gs-chip-radius)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${captured ? 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]' : 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]'}`}>
        {captured ? 'captured' : 'asserted'}
      </span>
      {clickable && <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-ghost)]">↗</span>}
    </button>
  );
}

function JudgementRow({ review }: { review: Review }): ReactElement {
  // Prefer the recorded judgeType (scores/cites model); fall back to who-inference.
  const meta = judgeMeta(review.judgeType ?? review.who);
  const verdict = reviewVerdict(review.tone);
  const score = typeof review.score === 'number' ? Math.max(0, Math.min(100, review.score)) : undefined;
  return (
    <div className="flex items-start gap-2 border-t border-[var(--gs-border-muted)] py-2 first:border-t-0">
      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[11px] ${meta.cls}`} title={meta.label}>
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] font-medium text-[var(--gs-text)]">{review.createdBy || review.who}</span>
          <span className="text-[9.5px] uppercase tracking-wide text-[var(--gs-text-ghost)]">{meta.label}</span>
          <VerdictChip verdict={verdict} />
          {score !== undefined && (
            <span className="flex items-center gap-1" title={`score ${score}`}>
              <span className="inline-block h-[4px] w-[42px] overflow-hidden rounded-full bg-[var(--gs-bg-active)]">
                <span className={`block h-full ${scoreTone(score)}`} style={{ width: `${score}%` }} />
              </span>
              <span className="text-[10px] tabular-nums text-[var(--gs-text-dim)]">{score}</span>
            </span>
          )}
          <span className="ml-auto text-[10px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">{review.createdAt}</span>
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

/** Human judgement form — pass/partial/fail + required note, submits via onRecordHuman. */
function MakeJudgement({ requirementId, onRecordHuman, onDone }: {
  requirementId: string;
  onRecordHuman: (requirementId: string, decision: Decision, note: string) => Promise<void>;
  onDone: () => void;
}): ReactElement {
  const [decision, setDecision] = useState<Decision | null>(null);
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
      await onRecordHuman(requirementId, decision, note.trim());
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record judgement');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-[var(--gs-border)] border-t-2 border-t-[var(--gs-purple)] bg-[var(--gs-bg-elevated)] p-3">
      <div className="text-[11px] font-medium text-[var(--gs-purple)]">
        ◆ your judgement <span className="font-normal text-[var(--gs-text-ghost)]">— this criterion is human-gated</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
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
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why — cite what the evidence does or doesn't prove…"
        rows={3}
        className="mt-2 w-full resize-y rounded-[var(--gs-input-radius)] border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1.5 text-[12px] leading-[1.5] text-[var(--gs-text)] placeholder:text-[var(--gs-text-ghost)] focus:border-[var(--gs-border-active)] focus:outline-none"
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

export function ReviewRubric({ goal, onRecordHuman, onRunJudgment, onOpenEvidence }: {
  goal: { id: string; title: string; validation: GoalValidation } | null;
  onRecordHuman: (requirementId: string, decision: Decision, note: string) => Promise<void>;
  onRunJudgment?: (requirementId: string) => Promise<void>;
  onOpenEvidence?: (requirementId: string, evidenceId: string) => void;
}): ReactElement {
  const [active, setActive] = useState(0);
  const [recorded, setRecorded] = useState<Record<string, boolean>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<(HTMLElement | null)[]>([]);

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

  const passCount = crits.filter((c) => c.verdict === 'pass').length;

  // Scroll-spy: the criterion the right column is showing lights up on the left.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const recompute = () => {
      if (secRefs.current.length === 0) return;
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
    recompute();
    root.addEventListener('scroll', recompute, { passive: true });
    return () => root.removeEventListener('scroll', recompute);
  }, [crits.length]);

  const go = useCallback((i: number) => {
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
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1 bg-[var(--gs-bg)] p-6 text-center">
        <div className="text-[13px] text-[var(--gs-text-dim)]">☰ No review rubric yet</div>
        <div className="max-w-[360px] text-[11px] leading-[1.5] text-[var(--gs-text-ghost)]">
          The rubric appears once this workspace's goal carries validation requirements. Author criteria from the goal detail panel.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gs-bg)]">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,340px)_1fr]">
        {/* left: criterion index (scroll-spy synced) */}
        <div className="flex min-h-0 flex-col border-r border-[var(--gs-border-muted)] bg-[var(--gs-bg-canvas,var(--gs-bg))]">
          <div className="border-b border-[var(--gs-border-muted)] px-3.5 py-3 text-[12px] font-medium text-[var(--gs-text)]">
            Review rubric <span className="text-[var(--gs-text-ghost)]">· the contract</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {crits.map((c, i) => (
              <button
                key={c.r.id}
                type="button"
                onClick={() => go(i)}
                className={`flex w-full items-center gap-2 px-3.5 py-2 text-left transition-[background-color,color] duration-150 ${
                  active === i ? 'bg-[var(--gs-bg-active)]' : 'hover:bg-[var(--gs-bg-elevated)]'
                }`}
              >
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${VERDICT_DOT[c.verdict]}`} />
                <span className={`min-w-0 flex-1 truncate text-[12px] ${active === i ? 'text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}>{c.r.title}</span>
                <span className={`flex-shrink-0 text-[11px] ${GATE_META[c.gate].cls.split(' ')[1]}`} title={`${GATE_META[c.gate].label} gate`}>
                  {GATE_META[c.gate].icon}
                </span>
                <span className="flex-shrink-0 text-[10px] tabular-nums text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">
                  {typeof c.score === 'number' ? c.score : `${c.r.evidence.length} ev`}
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--gs-border-muted)] px-3.5 py-2.5 text-[10px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">
            {crits.length} criteria · {passCount}/{crits.length} pass · gated exit owned by human approval
          </div>
        </div>

        {/* right: per-criterion detail sections */}
        <div ref={scrollRef} className="min-h-0 overflow-y-auto px-[18px] py-4">
          {crits.map((c, i) => (
            <section
              key={c.r.id}
              ref={(el) => { secRefs.current[i] = el; }}
              className={`mb-[18px] scroll-mt-1.5 border bg-[var(--gs-bg-elevated)] ${active === i ? 'border-[var(--gs-border-active)]' : 'border-[var(--gs-border)]'}`}
            >
              <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-2">
                <VerdictChip verdict={c.verdict} />
                <span className="text-[13px] font-medium text-[var(--gs-text)]">{c.r.title}</span>
                {c.r.required && (
                  <span className="rounded-[var(--gs-chip-radius)] border border-[var(--gs-border)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--gs-text-ghost)]">required</span>
                )}
                <GateChip gate={c.gate} />
                {c.awaiting && (
                  <span className="ml-auto rounded-[var(--gs-chip-radius)] border border-[var(--gs-purple)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--gs-purple)]">
                    awaiting your verdict
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-3 p-3">
                {/* rubric contract */}
                <div
                  className="gs-block-md text-[12px] leading-[1.55] text-[var(--gs-text-muted)]"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(c.r.rubric) }}
                />
                <div className="flex items-center gap-3">
                  {typeof c.score === 'number' && <ScoreBar value={c.score} />}
                  <span className="text-[10.5px] text-[var(--gs-text-ghost)]">
                    {c.r.reviews.length} {c.r.reviews.length === 1 ? 'judge' : 'judges'} · {c.r.evidence.length} evidence
                  </span>
                  {onRunJudgment && c.gate !== 'human' && c.r.status !== 'accepted' && (
                    <button
                      type="button"
                      disabled={runningId !== null}
                      onClick={() => void runJudgment(c.r.id)}
                      className={`ml-auto border px-2 py-1 text-[10.5px] uppercase tracking-wide transition-[border-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 ${GATE_META[c.gate].cls} hover:bg-[var(--gs-bg-active)]`}
                    >
                      {runningId === c.r.id ? 'running…' : `${GATE_META[c.gate].icon} run judgment`}
                    </button>
                  )}
                </div>

                {/* evidence */}
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-ghost)]">
                    evidence <span className="normal-case tracking-normal">· {c.r.evidence.length}</span>
                  </div>
                  {c.r.evidence.length === 0 ? (
                    <div className="border border-dashed border-[var(--gs-border)] px-2 py-2 text-[11px] text-[var(--gs-text-ghost)]">no evidence collected yet</div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {c.r.evidence.map((ev) => (
                        <EvidenceRow key={ev.id} requirement={c.r} evidence={ev} onOpenEvidence={onOpenEvidence} />
                      ))}
                    </div>
                  )}
                </div>

                {/* judgements */}
                <div>
                  <div className="mb-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-ghost)]">
                    judgements <span className="normal-case tracking-normal">· {c.r.reviews.length} {c.r.reviews.length === 1 ? 'judge' : 'judges'}</span>
                  </div>
                  {c.r.reviews.length === 0 ? (
                    <div className="border border-dashed border-[var(--gs-border)] px-2 py-2 text-[11px] text-[var(--gs-text-ghost)]">no judgements recorded yet</div>
                  ) : (
                    <div>{c.r.reviews.map((rv) => <JudgementRow key={rv.id} review={rv} />)}</div>
                  )}
                </div>

                {/* human gate */}
                {c.awaiting ? (
                  <MakeJudgement
                    requirementId={c.r.id}
                    onRecordHuman={onRecordHuman}
                    onDone={() => setRecorded((m) => ({ ...m, [c.r.id]: true }))}
                  />
                ) : c.gate === 'human' ? (
                  <div className="border border-dashed border-[var(--gs-border)] px-2.5 py-2 text-[11px] text-[var(--gs-purple)]">◆ your verdict recorded</div>
                ) : (
                  <div className="border border-dashed border-[var(--gs-border)] px-2.5 py-2 text-[11px] text-[var(--gs-text-ghost)]">
                    {GATE_META[c.gate].icon} {c.gate}-gated — no human verdict required
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
