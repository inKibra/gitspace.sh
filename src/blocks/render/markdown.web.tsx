import type { ReactElement } from 'react';
import { renderMarkdownHtml, type MarkdownRenderOptions } from '../../components/markdown-render.js';
import { Highlighted } from './highlight.web.js';
import { MermaidDiagram } from './mermaid-diagram.web.js';

// Fence languages that carry a Mermaid diagram (rendered as a chart, not code).
const MERMAID_LANGS = new Set(['mermaid', 'mermaidjs']);

/**
 * Markdown styling for blocks — Tailwind utilities over the shared `--gs-*`
 * design tokens (the web app's convention). Reuses the repo's `renderMarkdownHtml`
 * so block prose matches the rest of the app (notes, goal docs).
 */
export const BLOCK_MD_OPTIONS: MarkdownRenderOptions = {
  emptyHtml: '',
  h1ClassName: 'text-[15px] font-semibold text-[var(--gs-text)] mt-3 mb-1.5',
  h2ClassName: 'text-[13px] font-semibold text-[var(--gs-text)] mt-3 mb-1',
  h3ClassName: 'text-[12px] font-semibold text-[var(--gs-text-secondary)] mt-2 mb-1',
  paragraphClassName: 'text-[13px] leading-[1.6] text-[var(--gs-text-secondary)] my-1.5',
  preClassName: 'bg-black border border-[var(--gs-border)] p-2 overflow-x-auto text-[12px] leading-[1.5] my-2 font-[family-name:var(--gs-font)]',
  inlineCodeClassName: 'bg-black border border-[var(--gs-border)] px-1 text-[12px] font-[family-name:var(--gs-font)]',
  listClassName: 'list-disc pl-5 text-[13px] leading-[1.6] text-[var(--gs-text-secondary)] my-1.5',
  orderedListClassName: 'list-decimal pl-5 text-[13px] leading-[1.6] text-[var(--gs-text-secondary)] my-1.5',
  blockquoteClassName: 'border-l-2 border-[var(--gs-border-active)] pl-3 text-[var(--gs-text-muted)] my-2',
  hrClassName: 'border-[var(--gs-border)] my-3',
  linkClassName: 'text-[var(--gs-info)] underline',
  tableClassName: 'my-2 w-full border-collapse text-[12px] leading-[1.5] text-[var(--gs-text-secondary)] block overflow-x-auto',
  tableHeadCellClassName: 'border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 text-left font-semibold text-[var(--gs-text)]',
  tableCellClassName: 'border border-[var(--gs-border)] px-2 py-1 align-top',
};

const FENCE = /```([\w+#-]*)\n?([\s\S]*?)```/g;

type MdPart = { kind: 'prose'; text: string } | { kind: 'code'; lang: string; code: string };

/** Split markdown into prose runs + fenced code blocks so the latter can be
 *  syntax-highlighted (shiki via @pierre) instead of rendered as plain <pre>. */
function splitFences(text: string): MdPart[] {
  const parts: MdPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: 'prose', text: text.slice(last, m.index) });
    parts.push({ kind: 'code', lang: m[1] ?? '', code: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'prose', text: text.slice(last) });
  return parts;
}

export function Markdown({ text }: { text: string }): ReactElement {
  const parts = splitFences(text);
  if (parts.length === 0) return <div className="gs-block-md" />;
  return (
    <div className="gs-block-md">
      {parts.map((p, i) =>
        p.kind === 'code' ? (
          MERMAID_LANGS.has(p.lang.toLowerCase()) ? (
            <MermaidDiagram key={i} code={p.code} />
          ) : (
            <div key={i} className="my-2 border border-[var(--gs-border)] overflow-x-auto">
              <Highlighted text={p.code} lang={p.lang || undefined} />
            </div>
          )
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(p.text, BLOCK_MD_OPTIONS) }} />
        ),
      )}
    </div>
  );
}
