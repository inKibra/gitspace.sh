/** @jsxImportSource react */
import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';
import { BlockView } from '../blocks/render/registry.web.js';
import { slugifySliceId } from '../core/goal-gates.js';
import type { GoalDoc, GoalValidation, Requirement } from '../types/goals.js';
import type { WorkspacePhase } from '../types/config.js';

/**
 * GoalDocPanel — the '◇ Goal' workspace dock pane (mock: GoalDoc.tsx).
 * Header (title + subtitle + Preview/Edit), chain strip of ⛓ nodes with
 * '‹ up'/'down ›' nav, scrollable doc body (blocks or fallbacks) ending with
 * the wf-tie card that opens the ⟜ Workflow pane.
 */

/** Local slice of the board's KanbanGoalItem — only what this pane reads. */
export interface GoalLike {
  id: string;
  title: string;
  phase: WorkspacePhase;
  status: 'planned' | 'workspace-backed';
  chainPosition: number;
  doc?: GoalDoc;
  validation?: GoalValidation;
  workspaceName?: string;
}

type ChainNodeState = 'shipped' | 'active' | 'planned';

function nodeState(goal: GoalLike): ChainNodeState {
  if (goal.phase === 'ship') return 'shipped';
  if (goal.status === 'workspace-backed') return 'active';
  return 'planned';
}

const NODE_ICON_TONE: Record<ChainNodeState, string> = {
  shipped: 'text-[var(--gs-success)]',
  active: 'text-[var(--gs-accent)]',
  planned: 'text-[var(--gs-text-dim)]',
};

function reqStatusDot(status: Requirement['status']): string {
  if (status === 'accepted') return 'bg-[var(--gs-success)]';
  if (status === 'review') return 'bg-[var(--gs-warning)]';
  return 'bg-[var(--gs-danger)]';
}

/** Requirements fallback row — styled to the evidence-shape block vocabulary
 *  (rows inside one bordered container, sans text, dim meta). */
function RequirementRow({ requirement }: { requirement: Requirement }): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-2 last:border-b-0">
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${reqStatusDot(requirement.status)}`} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--gs-text)]">{requirement.title}</span>
      <span className="flex-none border border-[var(--gs-border)] px-1.5 py-0.5 text-[10px] text-[var(--gs-text-muted)]">
        {requirement.kind}
      </span>
      <span className="flex-none text-[10.5px] text-[var(--gs-text-dim)] [font-variant-numeric:tabular-nums]">
        {requirement.evidence.length} evidence
      </span>
    </div>
  );
}

export function GoalDocPanel({ goals, currentGoalId, onSelectGoal, onToggleExemplar, onOpenWorkflow, scrollToSlice }: {
  goals: GoalLike[];
  currentGoalId: string;
  onSelectGoal: (goalId: string) => void;
  /** Persist exemplar starring on the goal doc (mock exstar). */
  onToggleExemplar?: (goalId: string, blockId: string) => void;
  /** Open the ⟜ Workflow pane (mock wf-tie). */
  onOpenWorkflow?: () => void;
  /** Scroll the doc to a heading slice (workflow slice chips — the id is a
   *  slugified heading, core/goal-gates.ts parseDocSlices). Nonce re-fires
   *  the scroll when the pane is already open. */
  scrollToSlice?: { sliceId: string; nonce: number } | null;
}): ReactElement {
  const chain = useMemo(
    () => [...goals].sort((a, b) => a.chainPosition - b.chainPosition),
    [goals],
  );
  const curIndex = Math.max(0, chain.findIndex((g) => g.id === currentGoalId));
  const goal = chain[curIndex];
  const bodyRef = useRef<HTMLDivElement>(null);

  // Slice navigation: find the rendered heading whose slug (same dedupe walk
  // as parseDocSlices) matches, scroll to it, and flash it briefly. Scrolls
  // instantly and VERIFIES over a short window — a freshly opened dock panel
  // is hidden until dockview activates the tab, and the activation focus can
  // reset a scroll that landed too early.
  useEffect(() => {
    if (!scrollToSlice) return;
    let cancelled = false;
    let attempts = 0;
    let flashed = false;
    const tryScroll = (): void => {
      if (cancelled) return;
      attempts += 1;
      const root = bodyRef.current;
      const target = (() => {
        if (!root) return null;
        const seen = new Map<string, number>();
        for (const el of Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
          const base = slugifySliceId(el.textContent ?? '');
          const count = (seen.get(base) ?? 0) + 1;
          seen.set(base, count);
          const id = count === 1 ? base : `${base}-${count}`;
          if (id === scrollToSlice.sliceId) return el;
        }
        return null;
      })();
      // Visible = it has a laid-out box (hidden dockview panels have none).
      if (target && root && target.getBoundingClientRect().height > 0) {
        const inPlace = Math.abs(target.getBoundingClientRect().top - root.getBoundingClientRect().top) < 60;
        if (inPlace) {
          if (!flashed) {
            flashed = true;
            target.animate(
              [{ backgroundColor: 'rgba(255,204,0,0.22)' }, { backgroundColor: 'transparent' }],
              { duration: 1600, easing: 'ease-out' },
            );
          }
          return;
        }
        target.scrollIntoView({ block: 'start' });
      }
      if (attempts < 20) setTimeout(tryScroll, 200);
    };
    const frame = requestAnimationFrame(tryScroll);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [scrollToSlice?.nonce, scrollToSlice?.sliceId, scrollToSlice, currentGoalId]);

  if (!goal) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center text-[11px] text-[var(--gs-text-dim)]">
        No goal selected.
      </div>
    );
  }

  const bodyMarkdown = goal.doc?.bodyMarkdown?.trim() ?? '';
  const docBlocks = goal.doc?.blocks ?? [];
  const exemplars = new Set(goal.doc?.exemplarBlockIds ?? []);
  const requirements = goal.validation
    ? goal.validation.reqOrder
        .map((id) => goal.validation!.requirements[id])
        .filter((r): r is Requirement => Boolean(r))
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gs-bg)]">
      {/* Header (mock gdoc-head: title · subtitle · Preview/Edit) */}
      <div className="flex flex-none items-center gap-2.5 border-b border-[var(--gs-border)] px-4 py-2.5">
        <span className="min-w-0 truncate text-[13px] font-medium text-[var(--gs-text)]">
          Goal · {goal.title}
        </span>
        <span className="min-w-0 flex-none truncate text-[11px] text-[var(--gs-text-muted)]">
          composed from a small block vocabulary{exemplars.size > 0 ? ` · ★ ${exemplars.size} exemplar` : ''}
        </span>
        <span className="ml-auto flex flex-none items-center gap-1.5">
          <button
            type="button"
            className="border border-[var(--gs-border)] bg-transparent px-2 py-0.5 text-[11px] text-[var(--gs-text-muted)] transition-colors hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]"
          >
            Preview
          </button>
          <button
            type="button"
            className="border border-[var(--gs-border)] bg-transparent px-2 py-0.5 text-[11px] text-[var(--gs-text-muted)] transition-colors hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]"
          >
            Edit
          </button>
        </span>
      </div>

      {/* Chain strip */}
      <div className="flex flex-none items-stretch gap-px border-b border-[var(--gs-border)] bg-[#050505] px-3.5 py-2">
        <button
          type="button"
          disabled={curIndex === 0}
          onClick={() => { const prev = chain[curIndex - 1]; if (prev) onSelectGoal(prev.id); }}
          className="flex-none border border-[var(--gs-border)] bg-transparent px-2.5 text-[11px] text-[var(--gs-text-muted)] transition-colors hover:enabled:border-[var(--gs-border-active)] hover:enabled:text-[var(--gs-text)] disabled:cursor-default disabled:opacity-35"
        >
          ‹ up
        </button>
        <div className="mx-1.5 flex min-w-0 flex-1 gap-px overflow-x-auto">
          {chain.map((g, i) => {
            const state = nodeState(g);
            const on = i === curIndex;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelectGoal(g.id)}
                className={`flex flex-none items-center gap-1.5 whitespace-nowrap border bg-[var(--gs-bg-elevated)] px-2.5 py-1 text-[11.5px] transition-colors ${
                  on
                    ? 'border-[var(--gs-accent)] text-[var(--gs-text)] shadow-[inset_0_-2px_0_var(--gs-accent)]'
                    : 'border-[var(--gs-border)] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'
                }`}
              >
                <span className={NODE_ICON_TONE[state]}>⛓</span>
                <span className="text-[10.5px] text-[var(--gs-text-dim)] font-[family-name:var(--gs-font-mono)] [font-variant-numeric:tabular-nums]">
                  {i + 1}
                </span>
                {g.title}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={curIndex === chain.length - 1}
          onClick={() => { const next = chain[curIndex + 1]; if (next) onSelectGoal(next.id); }}
          className="flex-none border border-[var(--gs-border)] bg-transparent px-2.5 text-[11px] text-[var(--gs-text-muted)] transition-colors hover:enabled:border-[var(--gs-border-active)] hover:enabled:text-[var(--gs-text)] disabled:cursor-default disabled:opacity-35"
        >
          down ›
        </button>
      </div>

      {/* Doc body (mock gdoc-body: 18px/20px padding, wf-tie card in-flow at end) */}
      <div ref={bodyRef} className="gs-goal-doc min-h-0 flex-1 overflow-auto px-5 pt-[18px] pb-[18px]">
        {docBlocks.length > 0 ? (
          <div className="flex max-w-[880px] flex-col gap-4">
            {docBlocks.map((b) => (
              <div key={b.id} className={`relative ${exemplars.has(b.id) ? 'shadow-[inset_2px_0_0_var(--gs-warning)] pl-[11px]' : ''}`}>
                {onToggleExemplar && (
                  <button
                    type="button"
                    title="Mark as exemplar"
                    onClick={() => onToggleExemplar(goal.id, b.id)}
                    className={`absolute right-0 top-0 z-10 px-[5px] py-[2px] text-[13px] ${exemplars.has(b.id) ? 'text-[var(--gs-warning)]' : 'text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)]'}`}
                  >
                    ★
                  </button>
                )}
                <BlockView block={b} />
              </div>
            ))}
          </div>
        ) : bodyMarkdown ? (
          <div
            className="gs-block-md max-w-[880px] text-[13px] text-[var(--gs-text-muted)]"
            dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(bodyMarkdown) }}
          />
        ) : requirements.length > 0 ? (
          <div className="max-w-[880px] border border-[var(--gs-border)]">
            <div className="border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-[var(--gs-text-muted)]">
              requirements · rubric
            </div>
            {requirements.map((r) => (
              <RequirementRow key={r.id} requirement={r} />
            ))}
          </div>
        ) : (
          <div className="max-w-[880px] text-[12.5px] leading-[1.6] text-[var(--gs-text-dim)]">
            No goal doc yet — author the spec: intent, objective, rubric.
          </div>
        )}

        {/* Workflow tie-in card (mock wf-tie — opens the ⟜ Workflow pane) */}
        <button
          type="button"
          onClick={onOpenWorkflow}
          disabled={!onOpenWorkflow}
          className="mt-1.5 flex w-full max-w-[880px] items-center gap-[11px] border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-accent)] bg-[var(--gs-bg-elevated)] px-3.5 py-3 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-[var(--gs-bg-hover)]"
        >
          <span className="flex-none text-[18px] text-[var(--gs-accent)]">⟜</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-[var(--gs-text)]">
              This goal drives the review-gated workflow
            </div>
            <div className="mt-0.5 truncate text-[11px] text-[var(--gs-text-muted)]">
              4 phases · implement → evidence → review-gate → adjudicate
            </div>
          </div>
          {onOpenWorkflow && <span className="ml-auto flex-none text-[11px] text-[var(--gs-accent)]">open Workflow ↗</span>}
        </button>
      </div>
    </div>
  );
}
