import type { ReactElement } from 'react';
import { renderMarkdownHtml, type MarkdownRenderOptions } from '../../components/markdown-render.js';

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
};

export function Markdown({ text }: { text: string }): ReactElement {
  return <div className="gs-block-md" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(text, BLOCK_MD_OPTIONS) }} />;
}
