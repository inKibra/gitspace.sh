import { type ReactElement } from 'react';
import type { CodeData, CodeRefData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';
import { Highlighted } from './highlight.web.js';

// ── code ──────────────────────────────────────────────────────────────────
defineRenderer<CodeData>('code', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] overflow-x-auto">
    <Highlighted text={data.text} lang={data.lang} />
  </div>
));

// ── code-ref (language detected from the path) ──────────────────────────────
defineRenderer<CodeRefData>('code-ref', ({ data }): ReactElement => (
  <div className={`my-2 border ${data.exemplar ? 'border-[var(--gs-accent)]' : 'border-[var(--gs-border)]'}`}>
    <div className="flex items-center gap-2 px-2 py-1 bg-[var(--gs-bg-elevated)] border-b border-[var(--gs-border)] text-[11px]">
      <span className="text-[var(--gs-text-dim)]">↳</span>
      <span className="text-[var(--gs-text)] truncate">{data.path}{data.lines ? `:${data.lines}` : ''}</span>
      <span className="ml-auto text-[var(--gs-text-dim)]">{data.exemplar ? 'follow this pattern' : 'existing code'}</span>
    </div>
    <div className="overflow-x-auto">
      <Highlighted text={data.snippet} name={data.path} />
    </div>
    {data.note && <div className="px-2 py-1 text-[11px] text-[var(--gs-text-muted)] border-t border-[var(--gs-border)]">{data.note}</div>}
  </div>
));
