// Drawn thumbnails of what a browser tab shows now, for the Browsers page: a checkout form, a dashboard, a docs page,
// a bank sign-in asking for a one-time code, a menu, a table. Plain boxes, scaled into a 16:10 frame with a URL bar.
import type { ReactNode } from 'react';
import type { Thumb } from './data.js';

const bar = (width: string, tone = 'bg-[#d0d5dd] dark:bg-[#475467]') => <span className={`block h-1.5 rounded-full ${tone}`} style={{ width }} />;

const DRAW: Readonly<Record<Thumb, () => ReactNode>> = {
  checkout: () => <div className="grid h-full grid-cols-[1.4fr_1fr] gap-2 p-2.5">
    <div className="flex flex-col gap-1.5">{bar('40%', 'bg-[#101828] dark:bg-white')}<span className="h-4 rounded border border-[#d0d5dd]" /><span className="h-4 rounded border border-[#d0d5dd]" /><div className="grid grid-cols-2 gap-1.5"><span className="h-4 rounded border border-[#d0d5dd]" /><span className="h-4 rounded border border-[#d0d5dd]" /></div><span className="mt-auto h-5 rounded bg-[#101828] dark:bg-white" /></div>
    <div className="flex flex-col gap-1.5 rounded bg-[#f2f4f7] p-1.5 dark:bg-[#1d2939]">{bar('70%')}{bar('50%')}{bar('60%')}<span className="mt-1 h-3 rounded bg-[#fdb022]/60" />{bar('35%', 'bg-[#101828] dark:bg-white')}</div>
  </div>,
  dashboard: () => <div className="grid h-full grid-cols-[18%_1fr] gap-2 p-2">
    <div className="flex flex-col gap-1.5 rounded bg-[#f2f4f7] p-1.5 dark:bg-[#1d2939]">{bar('80%')}{bar('60%')}{bar('70%')}{bar('50%')}</div>
    <div className="flex flex-col gap-1.5"><div className="grid grid-cols-3 gap-1.5">{[0, 1, 2].map((key) => <span key={key} className="h-6 rounded bg-[#f2f4f7] dark:bg-[#1d2939]" />)}</div>
      <div className="flex flex-1 items-end gap-1 rounded bg-[#f9fafb] p-1.5 dark:bg-[#101828]">{[40, 65, 30, 80, 55, 90, 70, 45].map((height) => <span key={height} className="flex-1 rounded-sm bg-[#6B97FF]" style={{ height: `${height}%` }} />)}</div></div>
  </div>,
  docs: () => <div className="grid h-full grid-cols-[22%_1fr] gap-2.5 p-2.5">
    <div className="flex flex-col gap-1.5">{['70%', '55%', '80%', '60%', '45%', '65%'].map((width) => <span key={width}>{bar(width)}</span>)}</div>
    <div className="flex flex-col gap-1.5">{bar('45%', 'bg-[#101828] dark:bg-white')}{bar('95%')}{bar('90%')}{bar('70%')}<span className="mt-1 flex flex-col gap-1 rounded bg-[#101828] p-1.5">{bar('60%', 'bg-[#6B97FF]')}{bar('40%', 'bg-[#17b26a]')}{bar('50%', 'bg-[#98a2b3]')}</span>{bar('85%')}</div>
  </div>,
  bank: () => <div className="flex h-full items-center justify-center bg-[#0b3b2e] p-2">
    <div className="flex w-3/4 flex-col items-center gap-1.5 rounded-md bg-white p-2"><span className="size-3 rounded-full bg-[#0b3b2e]" />{bar('50%', 'bg-[#101828]')}<div className="flex gap-1">{[0, 1, 2, 3, 4, 5].map((key) => <span key={key} className="size-3.5 rounded-sm border border-[#98a2b3]" />)}</div><span className="h-3 w-3/4 rounded bg-[#0b3b2e]" /></div>
  </div>,
  menu: () => <div className="flex h-full flex-col gap-1.5 p-2">
    <div className="flex items-center gap-1.5">{bar('25%', 'bg-[#e8590c]')}<span className="flex-1" />{bar('12%')}{bar('12%')}</div>
    <div className="grid flex-1 grid-cols-4 gap-1.5">{[0, 1, 2, 3, 4, 5, 6, 7].map((key) => <span key={key} className="flex flex-col gap-1 rounded bg-[#f2f4f7] p-1 dark:bg-[#1d2939]"><span className="flex-1 rounded-sm bg-[#fdb022]/50" />{bar('70%')}</span>)}</div>
  </div>,
  tables: () => <div className="flex h-full flex-col gap-1 p-2">
    {bar('40%', 'bg-[#101828] dark:bg-white')}
    <div className="grid flex-1 grid-cols-4 gap-px overflow-hidden rounded border border-[#d0d5dd] bg-[#d0d5dd]">{Array.from({ length: 20 }, (_, key) => <span key={key} className={key < 4 ? 'bg-[#f2f4f7] dark:bg-[#1d2939]' : 'bg-white dark:bg-[#101828]'} />)}</div>
  </div>,
};

export function TabThumbnail({ thumb, url, live }: { thumb: Thumb; url: string; live: boolean }) {
  return <div className="flex aspect-[16/10] w-full flex-col overflow-hidden rounded-lg bg-white shadow-[inset_0_0_0_1px_var(--border)] dark:bg-[#0c111d]" aria-label={`What ${url} shows now`}>
    <div className="flex items-center gap-1.5 border-b border-border bg-[#f2f4f7] px-2 py-1 dark:bg-[#1d2939]">
      <span className="flex gap-0.5">{[0, 1, 2].map((key) => <span key={key} className="size-1.5 rounded-full bg-[#d0d5dd]" />)}</span>
      <span title={url} className="min-w-0 flex-1 truncate rounded bg-background px-1.5 font-mono text-[9.5px] text-muted-foreground">{url}</span>
      {live ? <span className="size-1.5 animate-pulse rounded-full bg-[#d92d20]" aria-label="live" /> : null}
    </div>
    <div className="min-h-0 flex-1">{DRAW[thumb]()}</div>
  </div>;
}
