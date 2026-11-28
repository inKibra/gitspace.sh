// The full-page frame Settings and a project's settings share: it replaces the app sidebar (there are never two
// sidebars). Its nav column starts with a clear "← Back to …" button, then the page groups; the page sits beside it.
// At half width the nav narrows and long labels truncate (their full text in the tooltip).
import { glyph } from '../../glyph.js';
import { Button, type IconComponent } from '@gitspace/ui';
import { ArrowLeft } from '@untitledui/icons';
import type { ReactNode } from 'react';

export function FullPage({ back, onBack, nav, children }: { back: string; onBack(): void; nav: ReactNode; children: ReactNode }) {
  return <div data-full-page="" className="flex min-h-0 flex-1 bg-background text-foreground">
    <aside aria-label="Settings navigation" className="flex w-52 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-surface-1 px-2.5 pb-6 pt-3 lg:w-64 lg:px-3">
      <Button variant="secondary" data-back="" leadingIcon={glyph(ArrowLeft)} onClick={onBack} className="w-full justify-start shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="truncate">{back}</span>
      </Button>
      {nav}
    </aside>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
  </div>;
}

/** A nav group; with no title (the personal pages under the "Settings for" picker) it starts with its first item. */
export function NavGroup({ id, title, children }: { id: string; title: ReactNode | null; children: ReactNode }) {
  return <div className="flex flex-col gap-0.5" data-settings-group={id}>
    {title ? <span className="flex items-center gap-2 truncate px-2 pb-1 text-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</span> : null}
    {children}
  </div>;
}

export function NavItem({ id, label, icon: Icon, active, onClick }: { id: string; label: string; icon: IconComponent; active: boolean; onClick(): void }) {
  return <button type="button" data-settings-nav={id} title={label} aria-current={active ? 'page' : undefined} onClick={onClick}
    className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] ${active ? 'bg-active font-medium text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}>
    <span className="shrink-0"><Icon size={15} strokeWidth={1.5} /></span><span className="truncate">{label}</span>
  </button>;
}
