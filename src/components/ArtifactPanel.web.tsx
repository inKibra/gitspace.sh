import { decodeBase64Utf8, toGoalRelative } from './artifact-kinds.js';
/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';
import { Highlighted } from '../blocks/render/highlight.web.js';
import { PdfDocFrame } from './document-preview.web.js';
import { extensionToMime } from '../core/media-types.js';

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

// Extension/MIME classification is shared with every other artifact surface —
// see src/core/media-types.ts. Local tables here are what let the rail, the
// rubric and this panel disagree about svg, apng, mov and audio.

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

export interface ArtifactRead {
  base64: string;
  size: number;
  truncated: boolean;
}

/** Render base64 media through a Blob object URL, not a `data:` URI: browsers
 *  can seek a blob: URL, so `<video>` actually plays mp4/webm (a data:video URI
 *  is refused by Safari and unseekable elsewhere). Revokes on change/unmount. */
function Base64Media({ base64, mime, alt }: { base64: string; mime: string; alt: string }): ReactElement | null {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    let objectUrl: string | undefined;
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setUrl(objectUrl);
    } catch { setUrl(undefined); }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [base64, mime]);
  if (!url) return null;
  if (mime.startsWith('video/')) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video src={url} controls className="max-h-full max-w-full border border-[var(--gs-border)]" />;
  }
  if (mime.startsWith('audio/')) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio src={url} controls className="w-full max-w-[520px]" />;
  }
  return <img src={url} alt={alt} className="max-h-full max-w-full border border-[var(--gs-border)]" />;
}

/** Pure renderer for fetched artifact bytes. */
export function ArtifactPreviewContent({ path, data }: { path: string; data: ArtifactRead }): ReactElement {
  const mime = extensionToMime(path);
  // A PDF artifact is a document, not "binary — no inline preview". Same viewer
  // the repo view uses, so both surfaces read PDFs the same way.
  if (path.toLowerCase().endsWith('.pdf')) {
    return <div className="h-full min-h-[420px] w-full"><PdfDocFrame base64={data.base64} title={path} /></div>;
  }
  if (mime?.startsWith('image/') || mime?.startsWith('video/') || mime?.startsWith('audio/')) {
    return <Base64Media base64={data.base64} mime={mime} alt={path} />;
  }
  let text: string | null = null;
  try { text = decodeBase64Utf8(data.base64); } catch { /* binary */ }
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

/** Live run of a *.gssh.html mini-app: sandboxed iframe + optional data feed. */
export function MiniAppRun({ html, read, listArtifacts }: {
  html: string;
  read: (path: string) => Promise<ArtifactRead>;
  listArtifacts?: () => Promise<string[]>;
}): ReactElement {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [dataOptions, setDataOptions] = useState<string[]>([]);
  const [dataPath, setDataPath] = useState<string>('');
  const [payload, setPayload] = useState<unknown>(null);

  useEffect(() => {
    if (!listArtifacts) return;
    let alive = true;
    void listArtifacts().then((paths) => {
      if (!alive) return;
      // `data/` is a goal-relative folder convention; paths arrive mount-relative
      // (`goals/<id>/data/x`), so normalize before the prefix match.
      const opts = paths.filter((x) => x.endsWith('.data.json') || toGoalRelative(x).startsWith('data/'));
      setDataOptions(opts);
      if (opts.length === 1) setDataPath(opts[0]!);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [listArtifacts]);

  useEffect(() => {
    if (!dataPath) { setPayload(null); return; }
    let alive = true;
    void read(dataPath)
      .then((r) => { if (alive) setPayload(JSON.parse(decodeBase64Utf8(r.base64))); })
      .catch(() => { if (alive) setPayload(null); });
    return () => { alive = false; };
  }, [dataPath, read]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const send = () => frame.contentWindow?.postMessage({ type: 'gssh:data', data: payload }, '*');
    frame.addEventListener('load', send);
    send();
    return () => frame.removeEventListener('load', send);
  }, [payload, html]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dataOptions.length > 0 && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-2 py-1 text-[11px] text-[var(--gs-text-dim)]">
          data
          <select
            value={dataPath}
            onChange={(e) => setDataPath(e.target.value)}
            className="border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1 py-0.5 text-[10.5px] text-[var(--gs-text)]"
          >
            <option value="">none</option>
            {dataOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      )}
      <iframe
        title="mini-app"
        sandbox="allow-scripts"
        srcDoc={html}
        className="min-h-0 w-full flex-1 border-0"
        style={{ background: 'var(--gs-bg)' }}
        ref={frameRef}
      />
    </div>
  );
}

/**
 * Per-chunk request size. MUST stay a multiple of 3: base64 encodes 3 bytes as
 * 4 characters, so only 3-byte-aligned chunks concatenate without interior
 * padding corrupting the join. Comfortably under the daemon's 25 MiB read cap
 * (src/lib/tmux-lite/server.ts) so each page is one clean frame.
 */
const READ_CHUNK_BYTES = 6 * 1024 * 1024;
/**
 * Refuse to materialise beyond this rather than hold the whole artifact in
 * memory. Real streaming (HTTP range + a seeking media element) is tracked in
 * issue #120; until then an explicit refusal beats a corrupt player.
 */
const INLINE_MAX_BYTES = 128 * 1024 * 1024;

/** Dock-pane artifact viewer: header + fetched preview. */
export function ArtifactPanel({ path, read, listArtifacts, onShare }: {
  path: string;
  /** Ranged reader. Media is paged; without range support a large artifact
   *  silently truncates at the daemon cap and decodes to a corrupt Blob. */
  read: (path: string, range?: { offset: number; length: number }) => Promise<ArtifactRead>;
  /** Enables the mini-app data picker for *.gssh.html artifacts. */
  listArtifacts?: () => Promise<string[]>;
  /** When set, a Share control appears in the header (copies a public link). */
  onShare?: () => void;
}): ReactElement {
  const [data, setData] = useState<ArtifactRead | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'too-large'>('loading');
  const [oversize, setOversize] = useState(0);
  const isApp = path.endsWith('.gssh.html');   // mini-app: sandboxed + data feed
  const isHtml = path.endsWith('.html');       // any HTML renders inline as a page
  const [appView, setAppView] = useState<'run' | 'source'>('run');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setData(null);
    setOversize(0);

    const mime = extensionToMime(path);
    const paged = !!mime && (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/'));

    (async (): Promise<void> => {
      if (!paged) {
        const single = await read(path);
        if (alive) { setData(single); setState('ready'); }
        return;
      }

      const parts: string[] = [];
      let offset = 0;
      let total = Infinity;
      let truncated = false;

      while (alive && offset < total) {
        const page = await read(path, { offset, length: READ_CHUNK_BYTES });
        total = page.size;
        if (total > INLINE_MAX_BYTES) {
          if (alive) { setOversize(total); setState('too-large'); }
          return;
        }

        const bytes = Math.ceil((page.base64.length * 3) / 4);
        // A reader that ignores the range hands back the head of the file every
        // time; concatenating those pages would produce garbage. Detect it on
        // the first page and degrade to the single truncated read instead.
        if (offset === 0 && bytes > READ_CHUNK_BYTES) {
          if (alive) { setData(page); setState('ready'); }
          return;
        }

        parts.push(page.base64);
        offset += bytes;
        truncated = page.truncated;
        if (bytes === 0 || !page.truncated) break;
      }

      if (alive) {
        setData({ base64: parts.join(''), size: Number.isFinite(total) ? total : offset, truncated });
        setState('ready');
      }
    })().catch(() => { if (alive) setState('error'); });

    return () => { alive = false; };
  }, [path, read]);

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5">
        <span className="text-[var(--gs-accent)]">◇</span>
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{path}</span>
        {data && <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-ghost)]">{humanSize(data.size)}{data.truncated ? ' · truncated' : ''}</span>}
        {onShare && (
          <button
            type="button"
            onClick={onShare}
            title="Share — copy a public link to this artifact (requires serve)"
            className="ml-auto flex-shrink-0 border border-[var(--gs-border)] px-2 py-[2px] text-[10.5px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-accent)]"
          >
            ↗ Share
          </button>
        )}
        {isHtml && (
          <span className={`${onShare ? '' : 'ml-auto'} inline-flex border border-[var(--gs-border)] text-[10.5px]`}>
            {(['run', 'source'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setAppView(m)}
                className={`px-2 py-[2px] ${appView === m ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}>
                {m === 'run' ? '▸ view' : 'source'}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${isHtml && appView === 'run' ? '' : 'p-3'}`}>
        {state === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading…</div>
        ) : state === 'too-large' ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-[var(--gs-danger)]">Too large to preview inline ({humanSize(oversize)}).</div>
            <div className="text-[11px] text-[var(--gs-text-dim)]">
              Inline preview holds the whole artifact in memory and stops at {humanSize(INLINE_MAX_BYTES)}. Streaming playback needs range support on the read path.
            </div>
          </div>
        ) : state === 'error' || !data ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Failed to load {path}</div>
        ) : isApp && appView === 'run' ? (
          <MiniAppRun html={decodeBase64Utf8(data.base64)} read={read} listArtifacts={listArtifacts} />
        ) : isHtml && appView === 'run' ? (
          // Any .html renders inline as a web page — sandboxed (scripts allowed,
          // no same-origin, so it can't touch the app), white backdrop so
          // unstyled documents stay readable over the dark shell.
          <iframe
            title={path}
            sandbox="allow-scripts"
            srcDoc={decodeBase64Utf8(data.base64)}
            className="min-h-0 h-full w-full flex-1 border-0"
            style={{ background: '#fff' }}
          />
        ) : (
          <ArtifactPreviewContent path={path} data={data} />
        )}
      </div>
    </div>
  );
}
