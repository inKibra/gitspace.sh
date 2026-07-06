/** @jsxImportSource react */
import { useMemo, type ReactElement } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';
import { BlockView } from '../blocks/render/registry.web.js';
import type { GoalDoc, GoalValidation, Requirement } from '../types/goals.js';
import type { WorkspacePhase } from '../types/config.js';

/**
 * GoalDocPanel — the '◇ Goal' workspace dock pane (mock: GoalDoc.tsx).
 * Header (title + phase chip + ready count), chain strip of ⛓ nodes with
 * prev/next nav, doc body (markdown or a requirements/rubric summary), and a
 * dim workflow tie-in footer strip.
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

function readyCounts(validation: GoalValidation | undefined): { accepted: number; total: number } | null {
  if (!validation) return null;
  const reqs = validation.reqOrder
    .map((id) => validation.requirements[id])
    .filter((r): r is Requirement => Boolean(r));
  if (reqs.length === 0) return null;
  return {
    accepted: reqs.filter((r) => r.status === 'accepted').length,
    total: reqs.length,
  };
}

function RequirementRow({ requirement }: { requirement: Requirement }): ReactElement {
  return (
    <div className="flex items-center gap-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2.5 py-2">
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${reqStatusDot(requirement.status)}`} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--gs-text)]">{requirement.title}</span>
      <span className="flex-none border border-[var(--gs-border)] px-1.5 py-px text-[10px] text-[var(--gs-text-muted)] font-[family-name:var(--gs-font-mono)]">
        {requirement.kind}
      </span>
      <span className="flex-none text-[10.5px] text-[var(--gs-text-dim)] font-[family-name:var(--gs-font-mono)] [font-variant-numeric:tabular-nums]">
        {requirement.evidence.length} evidence
      </span>
    </div>
  );
}

export function GoalDocPanel({ goals, currentGoalId, onSelectGoal, onToggleExemplar, onOpenWorkflow }: {
  goals: GoalLike[];
  currentGoalId: string;
  onSelectGoal: (goalId: string) => void;
  /** Persist exemplar starring on the goal doc (mock exstar). */
  onToggleExemplar?: (goalId: string, blockId: string) => void;
  /** Open the ⟜ Workflow pane (mock wf-tie). */
  onOpenWorkflow?: () => void;
}): ReactElement {
  const chain = useMemo(
    () => [...goals].sort((a, b) => a.chainPosition - b.chainPosition),
    [goals],
  );
  const curIndex = Math.max(0, chain.findIndex((g) => g.id === currentGoalId));
  const goal = chain[curIndex];

  if (!goal) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center text-[11px] text-[var(--gs-text-dim)]">
        No goal selected.
      </div>
    );
  }

  const ready = readyCounts(goal.validation);
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
      {/* Header */}
      <div className="flex flex-none items-center gap-2.5 border-b border-[var(--gs-border)] px-4 py-2.5">
        <span className="min-w-0 truncate text-[13px] font-medium text-[var(--gs-text)]">
          Goal · {goal.title}
        </span>
        <span className="flex-none border border-[var(--gs-border)] px-1.5 py-px text-[10px] uppercase tracking-wide text-[var(--gs-text-muted)] font-[family-name:var(--gs-font-mono)]">
          {goal.phase}
        </span>
        {ready ? (
          <span className="flex-none text-[11px] text-[var(--gs-text-dim)] font-[family-name:var(--gs-font-mono)] [font-variant-numeric:tabular-nums]">
            {ready.accepted}/{ready.total} ready
          </span>
        ) : null}
        {goal.workspaceName ? (
          <span className="ml-auto flex-none truncate text-[10.5px] text-[var(--gs-text-ghost)] font-[family-name:var(--gs-font-mono)]">
            {goal.workspaceName}
          </span>
        ) : null}
      </div>

      {/* Chain strip */}
      <div className="flex flex-none items-stretch gap-px border-b border-[var(--gs-border)] bg-[#050505] px-3.5 py-2">
        <button
          type="button"
          disabled={curIndex === 0}
          onClick={() => { const prev = chain[curIndex - 1]; if (prev) onSelectGoal(prev.id); }}
          className="flex-none border border-[var(--gs-border)] bg-transparent px-2.5 text-[11px] text-[var(--gs-text-muted)] transition-colors hover:enabled:border-[var(--gs-border-active)] hover:enabled:text-[var(--gs-text)] disabled:cursor-default disabled:opacity-35"
        >
          ‹
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
          ›
        </button>
      </div>

      {/* Doc body */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {docBlocks.length > 0 ? (
          <div className="flex max-w-[880px] flex-col gap-3">
            {docBlocks.map((b) => (
              <div key={b.id} className={`relative ${exemplars.has(b.id) ? 'border-l-2 border-l-[var(--gs-warning)] pl-2' : ''}`}>
                {onToggleExemplar && (
                  <button
                    type="button"
                    title="Mark as exemplar"
                    onClick={() => onToggleExemplar(goal.id, b.id)}
                    className={`absolute right-1 top-1 z-10 px-1 text-[12px] ${exemplars.has(b.id) ? 'text-[var(--gs-warning)]' : 'text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)]'}`}
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
            className="gs-block-md max-w-[880px] text-[12.5px] leading-relaxed text-[var(--gs-text)]"
            dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(bodyMarkdown) }}
          />
        ) : requirements.length > 0 ? (
          <div className="max-w-[880px]">
            <div className="mb-2 text-[10.5px] uppercase tracking-wide text-[var(--gs-text-dim)] font-[family-name:var(--gs-font-mono)]">
              Requirements · rubric
            </div>
            <div className="flex flex-col gap-1.5">
              {requirements.map((r) => (
                <RequirementRow key={r.id} requirement={r} />
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-[880px] text-[11.5px] text-[var(--gs-text-dim)]">
            No goal doc yet — author the spec: intent, objective, rubric.
          </div>
        )}
      </div>

      {/* Workflow tie-in footer (mock wf-tie — opens the ⟜ Workflow pane) */}
      <button
        type="button"
        onClick={onOpenWorkflow}
        disabled={!onOpenWorkflow}
        className="flex w-full flex-none items-center gap-2.5 border-t border-[var(--gs-border)] border-l-2 border-l-[var(--gs-accent)] bg-[var(--gs-bg-elevated)] px-3.5 py-2.5 text-left enabled:cursor-pointer enabled:hover:bg-[var(--gs-bg-hover)]"
      >
        <span className="flex-none text-[18px] text-[var(--gs-accent)]">⟜</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-[var(--gs-text)]">
            This goal drives the review-gated workflow
          </div>
          <div className="mt-px truncate text-[11px] text-[var(--gs-text-muted)]">
            implement → evidence → review-gate → adjudicate{exemplars.size > 0 ? ` · ★ ${exemplars.size} exemplar` : ''}
          </div>
        </div>
        {onOpenWorkflow && <span className="flex-none text-[11px] text-[var(--gs-accent)]">open Workflow ↗</span>}
      </button>
    </div>
  );
}
