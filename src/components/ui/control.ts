/**
 * Theme-aware control class strings + tone helpers for the goal / notes / editor
 * surfaces. Radii and colors resolve to per-theme `--gs-*` tokens so these
 * surfaces match every theme (square brutalist family today) instead of hard-
 * coding Tailwind palette colors and arbitrary rounding.
 *
 * Every utility below is written as a complete literal so Tailwind v4's source
 * scanner over the src tree picks it up.
 */
import type { Requirement, Review } from '../../types/goals.js';

// ─── Theme radii ─────────────────────────────────────────────────────────────
export const R_CARD = 'rounded-[var(--gs-card-radius)]';
export const R_CHIP = 'rounded-[var(--gs-chip-radius)]';
export const R_BTN = 'rounded-[var(--gs-btn-radius)]';
export const R_INPUT = 'rounded-[var(--gs-input-radius)]';
export const R_MODAL = 'rounded-[var(--gs-modal-radius)]';

// ─── Buttons ─────────────────────────────────────────────────────────────────
// Interruptible scale-on-press + explicit transition props + focus ring. Never
// `transition-all`. `scale-[0.96]` is the canonical press depth.
const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 text-xs font-medium ' +
  'transition-[background-color,border-color,color,box-shadow,scale] duration-150 ease-out ' +
  'active:scale-[0.96] focus-visible:outline-none focus-visible:shadow-[var(--gs-focus-ring)] ' +
  'disabled:pointer-events-none disabled:opacity-40';

export function btnPrimary(extra = ''): string {
  return `${BTN_BASE} ${R_BTN} bg-[var(--gs-accent)] px-3 py-1.5 text-[var(--gs-text-on-accent)] hover:bg-[var(--gs-accent-hover)] ${extra}`;
}

export function btnSecondary(extra = ''): string {
  return `${BTN_BASE} ${R_BTN} border border-[var(--gs-border)] bg-[var(--gs-btn-secondary-bg)] px-3 py-1.5 text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)] ${extra}`;
}

export function btnGhost(extra = ''): string {
  return `${BTN_BASE} ${R_BTN} px-2 py-1.5 text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)] ${extra}`;
}

export function btnDanger(extra = ''): string {
  return `${BTN_BASE} ${R_BTN} border border-[var(--gs-chip-red-border)] bg-[var(--gs-chip-red-bg)] px-3 py-1.5 text-[var(--gs-chip-red-text)] hover:text-[var(--gs-danger-hover)] ${extra}`;
}

// ─── Tone helpers (map to themed status tokens, never raw Tailwind palette) ───
export function statusText(status: Requirement['status']): string {
  return status === 'accepted'
    ? 'text-[var(--gs-success)]'
    : status === 'review'
      ? 'text-[var(--gs-warning)]'
      : 'text-[var(--gs-danger)]';
}

export function statusDot(status: Requirement['status']): string {
  return status === 'accepted'
    ? 'bg-[var(--gs-success)]'
    : status === 'review'
      ? 'bg-[var(--gs-warning)]'
      : 'bg-[var(--gs-danger)]';
}

export function reviewToneText(tone: Review['tone']): string {
  return tone === 'green'
    ? 'text-[var(--gs-success)]'
    : tone === 'amber'
      ? 'text-[var(--gs-warning)]'
      : 'text-[var(--gs-danger)]';
}

export type ChipTone = 'green' | 'blue' | 'amber' | 'red' | 'dim';

export function chipClass(tone: ChipTone, extra = ''): string {
  const map: Record<ChipTone, string> = {
    green: 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]',
    blue: 'bg-[var(--gs-chip-blue-bg)] text-[var(--gs-chip-blue-text)]',
    amber: 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]',
    red: 'bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]',
    dim: 'bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]',
  };
  return `inline-flex items-center gap-1 ${R_CHIP} px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${map[tone]} ${extra}`;
}
