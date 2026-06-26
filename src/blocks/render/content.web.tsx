import { type ReactElement } from 'react';
import type { ArtifactRef, CalloutData, DataStructureData, EvidenceData, MarkdownData, TableData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';
import { Markdown } from './markdown.web.js';

// Portable content renderers (no @pierre deps). code/code-ref live in code.web.tsx
// and diff/file-tree in their own files, since those pull web-only libraries.

// ── markdown ──────────────────────────────────────────────────────────────
defineRenderer<MarkdownData>('markdown', ({ data }) => <Markdown text={data.text} />);

// ── callout ───────────────────────────────────────────────────────────────
const CALLOUT_BORDER: Record<CalloutData['tone'], string> = {
  info: 'border-[var(--gs-info)]',
  warning: 'border-[var(--gs-warning)]',
  success: 'border-[var(--gs-success)]',
  danger: 'border-[var(--gs-danger)]',
};
const CALLOUT_TITLE: Record<CalloutData['tone'], string> = {
  info: 'text-[var(--gs-info)]',
  warning: 'text-[var(--gs-warning)]',
  success: 'text-[var(--gs-success)]',
  danger: 'text-[var(--gs-danger)]',
};
defineRenderer<CalloutData>('callout', ({ data }): ReactElement => (
  <div className={`my-2 border-l-2 ${CALLOUT_BORDER[data.tone]} bg-[var(--gs-bg-elevated)] pl-3 pr-2 py-2`}>
    {data.title && <div className={`text-[11px] font-semibold mb-1 ${CALLOUT_TITLE[data.tone]}`}>{data.title}</div>}
    <div className="text-[12.5px] leading-[1.55] text-[var(--gs-text-secondary)] whitespace-pre-wrap">{data.text}</div>
  </div>
));

// ── data-structure ────────────────────────────────────────────────────────
const STRUCT_KW: Record<NonNullable<DataStructureData['lang']>, string> = { ts: 'interface', rust: 'struct', go: 'type' };
defineRenderer<DataStructureData>('data-structure', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] font-[family-name:var(--gs-font)]">
    <div className="px-2 py-1 border-b border-[var(--gs-border)] text-[12px]">
      <span className="text-[var(--gs-info)]">{data.lang ? STRUCT_KW[data.lang] : 'interface'}</span>{' '}
      <span className="text-[var(--gs-text)] font-semibold">{data.name}</span>
    </div>
    <table className="w-full text-[12px] border-collapse">
      <tbody>
        {data.fields.map((f, i) => (
          <tr key={i} className="border-b border-[var(--gs-border-muted)] last:border-0">
            <td className="px-2 py-1 text-[var(--gs-text)] align-top whitespace-nowrap">{f.name}</td>
            <td className="px-2 py-1 text-[var(--gs-accent)] align-top whitespace-nowrap">{f.type}</td>
            <td className="px-2 py-1 text-[var(--gs-text-muted)] align-top">{f.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {data.note && <div className="px-2 py-1 text-[11px] text-[var(--gs-text-muted)] border-t border-[var(--gs-border)]">{data.note}</div>}
  </div>
));

// ── table ─────────────────────────────────────────────────────────────────
defineRenderer<TableData>('table', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] overflow-x-auto">
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="border-b border-[var(--gs-border)]">
          {data.columns.map((c, i) => (
            <th key={i} className="px-2 py-1 text-left font-semibold text-[var(--gs-text)] bg-[var(--gs-bg-elevated)]">{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row, ri) => (
          <tr key={ri} className="border-b border-[var(--gs-border-muted)] last:border-0">
            {row.map((cell, ci) => <td key={ci} className="px-2 py-1 align-top text-[var(--gs-text-secondary)]">{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
    {data.caption && <div className="px-2 py-1 text-[11px] text-[var(--gs-text-dim)] border-t border-[var(--gs-border)]">{data.caption}</div>}
  </div>
));

// ── evidence (ArtifactRef resolver: local-now / remote-later seam) ───────────
function ResolvedArtifact({ artifact }: { artifact: ArtifactRef }): ReactElement {
  switch (artifact.kind) {
    case 'inline':
      return <pre className="m-0 p-2 overflow-x-auto whitespace-pre-wrap text-[12px] font-[family-name:var(--gs-font)] text-[var(--gs-text-secondary)]">{artifact.text}</pre>;
    case 'image':
      return <img src={artifact.dataUrl} alt="" className="block max-w-full" />;
    case 'path':
      return <div className="p-2 text-[11px] font-[family-name:var(--gs-font)] text-[var(--gs-text-muted)]"><span className="text-[var(--gs-text-dim)]">file</span> {artifact.path}</div>;
    case 'url':
      return <a href={artifact.url} className="block p-2 text-[11px] font-[family-name:var(--gs-font)] text-[var(--gs-info)] underline">{artifact.url}</a>;
  }
}
const EVIDENCE_SOURCE: Record<EvidenceData['source'], string> = {
  captured: 'border-[var(--gs-success)] text-[var(--gs-success)]',
  asserted: 'border-[var(--gs-warning)] text-[var(--gs-warning)]',
};
defineRenderer<EvidenceData>('evidence', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--gs-border)]">
      <span className="text-[11px] text-[var(--gs-text)] font-[family-name:var(--gs-font)]">{data.name}</span>
      {data.meta && <span className="text-[11px] text-[var(--gs-text-muted)]">— {data.meta}</span>}
      <span className={`ml-auto border px-1.5 py-0.5 text-[10px] ${EVIDENCE_SOURCE[data.source]}`}>{data.source === 'captured' ? 'captured · run' : 'asserted · manual'}</span>
    </div>
    <div className="bg-black"><ResolvedArtifact artifact={data.ref} /></div>
  </div>
));
