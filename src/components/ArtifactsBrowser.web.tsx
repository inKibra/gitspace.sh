/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import { renderMarkdownHtml } from './markdown-render.js';

/**
 * Artifacts browser — v1 of the ProjectHome right-rail Artifacts surface
 * (docs/ARTIFACTS-FS.md). Browses the workspace's artifacts mount
 * (.gitspace/artifacts — the workspace's branch of the project artifacts repo):
 * file list (pointer-aware sizes) + inline preview (image / video / markdown /
 * text / json). Reads resolve LFS pointers server-side.
 */

interface Entry {
  path: string;
  size: number;
  pointer: boolean;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime', apng: 'image/apng',
  md: 'text/markdown', txt: 'text/plain', json: 'application/json',
  html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript',
};

function mimeFor(path: string): string | undefined {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXT_MIME[ext];
}

export function ArtifactsBrowser({
  backend,
  workspaceId,
  workspaceLabel,
  initialSelected = null,
  onClose,
}: {
  backend: SessionBackend | null;
  workspaceId: string;
  workspaceLabel?: string;
  /** Preselect + preview this artifact path on open. */
  initialSelected?: string | null;
  onClose: () => void;
}): ReactElement {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [preview, setPreview] = useState<{ path: string; base64: string; size: number; truncated: boolean } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    const fn = backend?.listWorkspaceArtifacts;
    if (!fn) {
      setLoading(false);
      setError('Artifacts not available on this backend.');
      return;
    }
    fn.call(backend, workspaceId)
      .then((list) => { if (alive) setEntries(list); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to list artifacts'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [backend, workspaceId]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const fn = backend?.readWorkspaceArtifact;
    if (!fn) return;
    setPreviewLoading(true);
    setPreview(null);
    fn.call(backend, workspaceId, selected)
      .then((r) => { if (alive) setPreview({ path: selected, ...r }); })
      .catch(() => { if (alive) setPreview(null); })
      .finally(() => { if (alive) setPreviewLoading(false); });
    return () => { alive = false; };
  }, [backend, workspaceId, selected]);

  // Group by top-level directory for a light tree feel.
  const groups = useMemo(() => {
    const byDir = new Map<string, Entry[]>();
    for (const e of entries) {
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.indexOf('/')) : '·';
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(e);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative z-10 flex h-[76vh] w-[min(1000px,95vw)] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[12px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--gs-border)] px-4 py-2.5 text-[13px]">
          <span className="text-[var(--gs-accent)]">▤ Artifacts</span>
          <span className="text-[var(--gs-text-dim)]">{workspaceLabel ?? workspaceId}</span>
          <span className="text-[10px] text-[var(--gs-text-ghost)]">.gitspace/artifacts · workspace branch of the project artifacts repo</span>
          <button type="button" onClick={onClose} className="ml-auto text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* file list */}
          <div className="w-[340px] shrink-0 overflow-y-auto border-r border-[var(--gs-border)] py-1.5 font-[family-name:var(--gs-font-mono)]">
            {loading ? (
              <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">Loading…</div>
            ) : error ? (
              <div className="px-4 py-4 text-center text-[var(--gs-danger)]">{error}</div>
            ) : entries.length === 0 ? (
              <div className="px-4 py-6 text-center text-[var(--gs-text-dim)]">
                No artifacts yet.
                <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">Goal evidence, demos and reports will land here.</div>
              </div>
            ) : (
              groups.map(([dir, files]) => (
                <div key={dir}>
                  <div className="px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-[var(--gs-text-ghost)]">{dir}/</div>
                  {files.map((e) => (
                    <button
                      key={e.path}
                      type="button"
                      onClick={() => setSelected(e.path)}
                      className={`flex w-full items-center gap-2 px-3 py-1 text-left ${selected === e.path ? 'bg-[color-mix(in_srgb,var(--gs-accent)_12%,transparent)]' : 'hover:bg-[var(--gs-border)]'}`}
                      title={e.path}
                    >
                      <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{e.path.includes('/') ? e.path.slice(e.path.indexOf('/') + 1) : e.path}</span>
                      {e.pointer && <span className="shrink-0 rounded-full border border-[#2a2413] px-1.5 text-[9px] text-[#f0b429]" title="Stored in the blob store (LFS pointer)">lfs</span>}
                      <span className="shrink-0 text-[10px] text-[var(--gs-text-ghost)]">{humanSize(e.size)}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
          {/* preview */}
          <div className="min-w-0 flex-1 overflow-auto p-3">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Select an artifact to preview</div>
            ) : previewLoading ? (
              <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading preview…</div>
            ) : !preview ? (
              <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Failed to load {selected}</div>
            ) : (
              <ArtifactPreview preview={preview} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtifactPreview({ preview }: { preview: { path: string; base64: string; size: number; truncated: boolean } }): ReactElement {
  const mime = mimeFor(preview.path);
  const header = (
    <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--gs-text-dim)]">
      <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{preview.path}</span>
      <span>· {humanSize(preview.size)}</span>
      {preview.truncated && <span className="text-[var(--gs-warning)]">· truncated preview</span>}
    </div>
  );
  if (mime?.startsWith('image/')) {
    return (
      <div>
        {header}
        <img src={`data:${mime};base64,${preview.base64}`} alt={preview.path} className="max-h-[62vh] max-w-full border border-[var(--gs-border)]" />
      </div>
    );
  }
  if (mime?.startsWith('video/')) {
    return (
      <div>
        {header}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={`data:${mime};base64,${preview.base64}`} controls className="max-h-[62vh] max-w-full border border-[var(--gs-border)]" />
      </div>
    );
  }
  const text = (() => {
    try {
      return atob(preview.base64);
    } catch {
      return null;
    }
  })();
  if (text === null) {
    return <div>{header}<div className="text-[var(--gs-text-dim)]">Binary artifact — no inline preview.</div></div>;
  }
  if (mime === 'text/markdown') {
    return (
      <div>
        {header}
        <div className="gs-block-md" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(text) }} />
      </div>
    );
  }
  if (mime === 'application/json') {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
    return <div>{header}<pre className="overflow-auto border border-[var(--gs-border)] bg-black p-2 text-[11px]">{pretty}</pre></div>;
  }
  return <div>{header}<pre className="overflow-auto whitespace-pre-wrap border border-[var(--gs-border)] bg-black p-2 text-[11px]">{text.slice(0, 100_000)}</pre></div>;
}
