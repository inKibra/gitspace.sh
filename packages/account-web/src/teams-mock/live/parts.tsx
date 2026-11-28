// What the app's live pages share: the page frame (title, who the viewer sees, the link to where this is configured in
// Settings), a stats strip, sparklines of the last hour, gauges, status dots, panels and an event list. Every piece
// wraps or truncates (with the full text in a tooltip) so a page holds together at half-screen width. Owners and Admins
// see the whole team; a Member sees their own, plus what their projects use.
import { PageCanvas, PageHeader } from '../../GitSpaceShell.js';
import { glyph } from '../../glyph.js';
import { Badge, Button } from '@gitspace/ui';
import { Settings01 } from '@untitledui/icons';
import type { ReactNode } from 'react';
import type { User } from '../data.js';
import { Avatar } from '../settings/parts.js';
import { accountRoleOf } from '../settings/roles.js';

export function seesTeam(viewer: User): boolean {
  return viewer.accountRole === 'owner' || viewer.accountRole === 'admin';
}

export function LivePage({ title, description, viewer, configure, actions, children }: {
  title: string; description: string; viewer: User; configure?: { label: string; onClick(): void }; actions?: ReactNode; children: ReactNode;
}) {
  return <div data-live-page={title} className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
    <PageCanvas className="max-md:px-4">
      <PageHeader kicker={<span className="inline-flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1.5"><span className="size-1.5 animate-pulse rounded-full bg-[#17b26a]" />Live</span><Badge size="compact" color={seesTeam(viewer) ? 'gray' : 'violet'}>{seesTeam(viewer) ? `Whole team · as ${accountRoleOf(viewer.id)?.name}` : `Yours and your projects’ · as ${viewer.first}`}</Badge></span>}
        title={title} description={description}
        actions={<span className="flex flex-wrap items-center gap-2">{actions}{configure ? <Button variant="ghost" leadingIcon={glyph(Settings01)} onClick={configure.onClick}>{configure.label}</Button> : null}</span>} />
      <div className="flex flex-col gap-8">{children}</div>
    </PageCanvas>
  </div>;
}

type Tone = 'good' | 'warn' | 'bad' | 'muted';
const TONE: Readonly<Record<Tone, string>> = { good: '#17b26a', warn: '#dc6803', bad: '#d92d20', muted: '#98a2b3' };

/** A row of stat tiles that wraps to two or three per line when narrow. */
export function StatStrip({ children }: { children: ReactNode }) {
  return <div data-stat-strip="" className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2.5">{children}</div>;
}

export function Stat({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: Tone }) {
  return <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-surface-2 px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--border)]">
    <span className="flex items-center gap-1.5 truncate text-caption text-muted-foreground">{tone ? <Dot tone={tone} /> : null}{label}</span>
    <span className="truncate text-[22px] font-semibold tabular-nums leading-tight" style={{ color: tone === 'bad' || tone === 'warn' ? TONE[tone] : undefined }}>{value}</span>
    {detail ? <span title={detail} className="line-clamp-2 text-caption text-muted-foreground">{detail}</span> : null}
  </div>;
}

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${pulse ? 'animate-pulse' : ''}`} style={{ background: TONE[tone] }} />;
}

/** The last hour as a line, newest on the right; `max` fixes the scale (percentages use 100). */
export function Sparkline({ values, tone = 'good', max, width = 120, height = 28, label }: { values: readonly number[]; tone?: Tone; max?: number; width?: number; height?: number; label: string }) {
  const top = max ?? Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - (Math.min(value, top) / top) * (height - 4)).toFixed(1)}`).join(' ');
  return <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="shrink-0 overflow-visible">
    <polyline points={`0,${height} ${points} ${width},${height}`} fill={TONE[tone]} fillOpacity={0.1} stroke="none" />
    <polyline points={points} fill="none" stroke={TONE[tone]} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

/** A labelled bar: CPU, memory, disk. Past 80% it turns amber, past 92% red. */
export function Gauge({ label, used, detail }: { label: string; used: number; detail?: string }) {
  const tone: Tone = used >= 92 ? 'bad' : used >= 80 ? 'warn' : 'good';
  return <div className="flex min-w-0 flex-col gap-1" title={detail ? `${label}: ${detail}` : undefined}>
    <span className="flex items-baseline justify-between gap-2 text-caption"><span className="text-muted-foreground">{label}</span><span className="tabular-nums text-foreground">{used}%</span></span>
    <span aria-label={`${label} ${used}%`} className="relative block h-1.5 overflow-hidden rounded-full bg-muted"><span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, used)}%`, background: TONE[tone] }} /></span>
    {detail ? <span className="truncate text-[11px] text-muted-foreground">{detail}</span> : null}
  </div>;
}
/** An avatar with its presence dot on the bottom-right edge, outside the initials. */
export function PresenceAvatar({ userId, size, tone, pulse }: { userId: string; size: number; tone: Tone; pulse?: boolean }) {
  return <span className="relative inline-flex shrink-0">
    <Avatar userId={userId} size={size} />
    <span className="absolute bottom-0 right-0 flex translate-x-1/3 translate-y-1/3 rounded-full bg-background p-[2px]"><Dot tone={tone} pulse={pulse} /></span>
  </span>;
}

/** A dashboard panel: a header line (wrapping), then its body. Dimmed when what it shows is offline. */
export function Panel({ head, children, dim, id }: { head: ReactNode; children: ReactNode; dim?: boolean; id?: string }) {
  return <section data-panel={id} className={`flex min-w-0 flex-col gap-3 rounded-2xl bg-background p-3.5 shadow-[inset_0_0_0_1px_var(--border)] ${dim ? 'opacity-60' : ''}`}>
    <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{head}</header>
    {children}
  </section>;
}

/** A grid of panels: two or three across when wide, one when narrow. */
export function PanelGrid({ children, min = '22rem' }: { children: ReactNode; min?: string }) {
  return <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}), 1fr))` }}>{children}</div>;
}

export function Events({ items }: { items: ReadonlyArray<{ time: string; text: string; tone?: Tone }> }) {
  return <ol className="flex flex-col gap-0.5 border-l-2 border-border pl-2 text-caption">
    {items.map((item) => <li key={item.time + item.text} className="flex min-w-0 items-baseline gap-2.5"><span title={item.time} className="w-[4.75rem] shrink-0 truncate tabular-nums text-muted-foreground">{item.time}</span><span className="min-w-0" style={{ color: item.tone && item.tone !== 'muted' ? TONE[item.tone] : undefined }}>{item.text}</span></li>)}
  </ol>;
}

export function Meter({ used, tone }: { used: number; tone?: 'amber' | 'red' }) {
  const color = tone === 'red' ? '#d92d20' : tone === 'amber' ? '#dc6803' : '#6B97FF';
  return <span aria-label={`${used}% used`} className="relative inline-block h-1.5 w-28 overflow-hidden rounded-full bg-muted sm:w-40"><span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, used)}%`, background: color }} /></span>;
}

export const money = (value: number): string => `$${value.toFixed(2)}`;
