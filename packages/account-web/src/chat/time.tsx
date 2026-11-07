// When transcript items happened, in the reader's local time: a short clock on messages and cards ('18:48', or
// 'Nov 4 · 18:48' on another day), the full date and time on hover, and a divider naming the day a conversation starts
// on and each day it changes to between turns.
import type { TranscriptItem } from '@gitspace/blocks';

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const SHORT_DAY_YEAR = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const LONG_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const LONG_DAY_YEAR = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The date an ISO time names; null when absent or unreadable. */
export function parseAt(at: string | undefined): Date | null {
  if (!at) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

/** 'Today', 'Yesterday', or the weekday and date ('Wednesday, November 4'; with the year when it is not this year's). */
export function dayLabel(date: Date, now = new Date()): string {
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return (date.getFullYear() === now.getFullYear() ? LONG_DAY : LONG_DAY_YEAR).format(date);
}

/** '18:48' today, 'Nov 4 · 18:48' on another day. */
export function shortTime(date: Date, now = new Date()): string {
  if (sameDay(date, now)) return CLOCK.format(date);
  return `${(date.getFullYear() === now.getFullYear() ? SHORT_DAY : SHORT_DAY_YEAR).format(date)} · ${CLOCK.format(date)}`;
}

/** 'Wednesday, November 4, 2026 at 18:48', for hover titles; `at` is an ISO time or epoch milliseconds. */
export function fullTime(at: string | number | null | undefined): string | undefined {
  const date = typeof at === 'number' ? new Date(at) : parseAt(at ?? undefined);
  return date ? FULL.format(date) : undefined;
}

/** When an item happened: its own `at`, or when a call or run started (ended, if it never recorded a start). */
export function itemAt(item: TranscriptItem): string | undefined {
  if (item.type === 'message' || item.type === 'interruption' || item.type === 'workspace-report') return item.at;
  if (item.type === 'tool-call' || item.type === 'execution') return item.startedAt ?? item.endedAt;
  return undefined;
}

/** The ids of the turns a day divider goes above: the first turn with a known time, so the conversation shows the day
 * it starts on, and each later turn whose local day differs from the last earlier turn with a time. Turns without a
 * time get none. */
export function dayBreaks(turns: readonly { id: string; at: string | undefined }[]): Map<string, Date> {
  const breaks = new Map<string, Date>();
  let previous: Date | null = null;
  for (const turn of turns) {
    const date = parseAt(turn.at);
    if (!date) continue;
    if (!previous || !sameDay(previous, date)) breaks.set(turn.id, date);
    previous = date;
  }
  return breaks;
}

/** The small time on a message or card; nothing when the item has no time. */
export function ItemTime({ at, className = '' }: { at: string | undefined; className?: string }) {
  const date = parseAt(at);
  if (!date) return null;
  return <time dateTime={at} title={FULL.format(date)} className={`shrink-0 text-[11px] tabular-nums text-muted-foreground ${className}`}>{shortTime(date)}</time>;
}

export function DayDivider({ date }: { date: Date }) {
  const label = dayLabel(date);
  return <div role="separator" aria-label={label} data-day-divider className="flex min-w-0 items-center gap-3 text-caption text-muted-foreground">
    <span aria-hidden className="h-px flex-1 bg-border" />
    <span className="shrink-0 font-medium">{label}</span>
    <span aria-hidden className="h-px flex-1 bg-border" />
  </div>;
}
