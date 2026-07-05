/** @jsxImportSource react */
import { useEffect, useState, type ReactElement } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';
import { Highlighted } from '../blocks/render/highlight.web.js';

/**
 * Artifact viewer content — used as a DOCK PANE in the workspace multi-view
 * (mock Shell: pane kind 'artifact', tab `◇ name`) and inline in ProjectHome.
 * Renders image/video natively, markdown rendered, code/text syntax-highlighted
 * via the shared shiki path. Reads resolve LFS pointers server-side.
 */

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime', apng: 'image/apng',
  md: 'text/markdown', txt: 'text/plain', json: 'application/json',
};

/** Extension → shiki lang for text previews (code formatting in viewers). */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', html: 'html', md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', swift: 'swift', kt: 'kotlin', zig: 'zig',
};

export function extOf(path: string): string {
  return path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
}

export function langForPath(path: string): string | undefined {
  return EXT_LANG[extOf(path)];
}

function mimeFor(path: string): string | undefined {
  return EXT_MIME[extOf(path)];
}

export interface ArtifactRead {
  base64: string;
  size: number;
  truncated: boolean;
}

/** Pure renderer for fetched artifact bytes. */
export function ArtifactPreviewContent({ path, data }: { path: string; data: ArtifactRead }): ReactElement {
  const mime = mimeFor(path);
  if (mime?.startsWith('image/')) {
    return <img src={`data:${mime};base64,${data.base64}`} alt={path} className="max-h-full max-w-full border border-[var(--gs-border)]" />;
  }
  if (mime?.startsWith('video/')) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video src={`data:${mime};base64,${data.base64}`} controls className="max-h-full max-w-full border border-[var(--gs-border)]" />;
  }
  let text: string | null = null;
  try { text = atob(data.base64); } catch { /* binary */ }
  if (text === null) return <div className="text-[var(--gs-text-dim)]">Binary artifact — no inline preview.</div>;
  if (mime === 'text/markdown') {
    return <div className="gs-block-md max-w-[860px]" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(text) }} />;
  }
  if (mime === 'application/json') {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* raw */ }
    return <Highlighted text={pretty} lang="json" name={path} />;
  }
  const lang = langForPath(path);
  if (lang) return <Highlighted text={text.slice(0, 200_000)} lang={lang} name={path} />;
  return <pre className="whitespace-pre-wrap font-[family-name:var(--gs-font-mono)] text-[11px] text-[var(--gs-text)]">{text.slice(0, 200_000)}</pre>;
}

/** Dock-pane artifact viewer: header + fetched preview. */
export function ArtifactPanel({ path, read }: {
  path: string;
  read: (path: string) => Promise<ArtifactRead>;
}): ReactElement {
  const [data, setData] = useState<ArtifactRead | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setData(null);
    read(path)
      .then((r) => { if (alive) { setData(r); setState('ready'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [path, read]);

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5">
        <span className="text-[var(--gs-accent)]">◇</span>
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{path}</span>
        {data && <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-ghost)]">{humanSize(data.size)}{data.truncated ? ' · truncated' : ''}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {state === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading…</div>
        ) : state === 'error' || !data ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Failed to load {path}</div>
        ) : (
          <ArtifactPreviewContent path={path} data={data} />
        )}
      </div>
    </div>
  );
}
