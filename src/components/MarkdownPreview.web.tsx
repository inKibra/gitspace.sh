/** @jsxImportSource react */
/**
 * MarkdownPreview — clamped, compact markdown rendering for list rows,
 * feeds, and cards. Same renderer as the full document panes
 * (renderMarkdownHtml + the .gs-block-md theme), scaled down by
 * .gs-md-preview so a '# Heading' reads as a heading instead of raw '#'
 * noise, without a preview row exploding to document scale.
 */
import { useMemo, type ReactElement } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';

export function MarkdownPreview({ markdown, maxLines = 3, className }: {
  markdown: string;
  /** Line clamp for the preview block. */
  maxLines?: number;
  className?: string;
}): ReactElement | null {
  const html = useMemo(() => {
    let md = markdown ?? '';
    // Some early note writers stored literal backslash-n sequences instead of
    // newlines. If a body has escapes but NO real newlines, unescape for
    // display — previews should never show '\\n' soup.
    if (md.includes('\\n') && !md.includes('\n')) md = md.replaceAll('\\n', '\n');
    return renderMarkdownHtml(md);
  }, [markdown]);
  if (!markdown?.trim()) return null;
  return (
    <div
      className={`gs-block-md gs-md-preview ${className ?? ''}`}
      style={{ display: '-webkit-box', WebkitLineClamp: maxLines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
