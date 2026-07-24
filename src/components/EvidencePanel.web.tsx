/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Evidence } from '../types/goals.js';
import { Highlighted } from '../blocks/render/highlight.web.js';
import { humanSize, langForPath } from './ArtifactPanel.web.js';

/** Raw artifact reader (a bound backend read). Passing a byte range pages
 *  large media; the result's `truncated` means more bytes remain. */
export type ArtifactReader = (
  path: string,
  range?: { offset: number; length: number },
) => Promise<{ base64: string; size: number; truncated: boolean } | null>;

/** Per-chunk request size — comfortably under the daemon's 25 MB read cap and
 *  the client frame-reassembly limit, so each page is one clean frame. */
const PREVIEW_CHUNK_BYTES = 6 * 1024 * 1024;
/** Don't materialise a preview past this — a huge video should be downloaded,
 *  not held in memory as a Blob (and the file-reference row still renders). */
const PREVIEW_MAX_BYTES = 128 * 1024 * 1024;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Fetch a media evidence's bytes ON DEMAND when it has no inline previewUrl
 * (large binary evidence is stored as a file attachment, not a data-URI — see
 * core/goal-validation.ts). Returns the inline previewUrl as-is if present;
 * otherwise pages the artifact over the E2E session channel into a Blob and
 * hands back an object URL. A Blob URL (unlike a `data:` URI) is seekable, so
 * `<video>` can actually play mp4/webm; it also survives files larger than a
 * single frame by fetching in chunks. No fetch for non-media or without a
 * reader; the object URL is revoked on change/unmount.
 */
export function useEvidencePreviewUrl(ev: Evidence, readArtifact?: ArtifactReader): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(ev.previewUrl);
  const isMedia = (ev.mimeType?.startsWith('image/') || ev.mimeType?.startsWith('video/')) ?? false;
  // Hold the reader in a ref so a fresh arrow identity each render (the usual
  // call-site pattern) does NOT re-trigger the paging effect / re-download.
  const readerRef = useRef(readArtifact);
  readerRef.current = readArtifact;
  const hasReader = !!readArtifact;
  useEffect(() => {
    if (ev.previewUrl) { setResolved(ev.previewUrl); return; }
    const readArtifactNow = readerRef.current;
    if (!isMedia || !ev.artifactPath || !readArtifactNow) { setResolved(undefined); return; }
    let cancelled = false;
    let objectUrl: string | undefined;
    setResolved(undefined);
    (async () => {
      const path = ev.artifactPath!;
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let total = Infinity;
      // First page reports the full size; keep paging until nothing remains.
      do {
        const page = await readArtifactNow(path, { offset, length: PREVIEW_CHUNK_BYTES });
        if (!page) return; // reader unavailable — leave the file-reference row
        total = page.size;
        if (total > PREVIEW_MAX_BYTES) return; // too big to preview inline
        const bytes = base64ToBytes(page.base64);
        chunks.push(bytes);
        offset += bytes.length;
        if (bytes.length === 0 || !page.truncated) break; // done (or empty guard)
      } while (offset < total && !cancelled);
      if (cancelled) return;
      const blob = new Blob(chunks as BlobPart[], ev.mimeType ? { type: ev.mimeType } : undefined);
      objectUrl = URL.createObjectURL(blob);
      setResolved(objectUrl);
    })().catch(() => { /* leave unresolved — the file-reference row still renders */ });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ev.previewUrl, ev.artifactPath, ev.mimeType, isMedia, hasReader]);
  return resolved;
}

/**
 * EvidencePanel — dock-pane content for a single Evidence record
 * (mock: EvidenceViewer.tsx, tab `▸ {name}`, pane id `ev:<evidenceId>`).
 * Header: kind chip, name, meta, ref id, captured/asserted source chip.
 * Body: inline preview (image/video via previewUrl, body text/code, command
 * + stdout/stderr sections, url/originalPath link rows).
 */

type EvidenceDisplayKind = 'command' | 'screenshot' | 'video' | 'url' | 'note' | 'file';

function displayKindOf(ev: Evidence): EvidenceDisplayKind {
  if (ev.command !== undefined) return 'command';
  if (ev.mimeType?.startsWith('image/')) return 'screenshot';
  if (ev.mimeType?.startsWith('video/')) return 'video';
  if (ev.url) return 'url';
  if (ev.artifactPath || ev.originalPath) return 'file';
  return 'note';
}

/** chip tone classes over --gs tokens (mock EV_TONE: command green, screenshot blue, video violet, note/file dim). */
const KIND_CHIP: Record<EvidenceDisplayKind, string> = {
  command: 'text-[var(--gs-chip-green-text)] bg-[var(--gs-chip-green-bg)]',
  screenshot: 'text-[var(--gs-chip-blue-text)] bg-[var(--gs-chip-blue-bg)]',
  video: 'text-[var(--gs-purple)] bg-[rgba(188,140,255,0.08)]',
  url: 'text-[var(--gs-chip-blue-text)] bg-[var(--gs-chip-blue-bg)]',
  note: 'text-[var(--gs-chip-dim-text)] bg-[var(--gs-chip-dim-bg)]',
  file: 'text-[var(--gs-chip-dim-text)] bg-[var(--gs-chip-dim-bg)]',
};

const CHIP_BASE = 'inline-flex flex-shrink-0 items-center gap-1 border border-[var(--gs-border)] px-[7px] py-[2px] text-[10.5px] uppercase tracking-[0.05em] leading-[1.4] whitespace-nowrap';

function SectionLabel({ children }: { children: string }): ReactElement {
  return <div className="mb-[7px] text-[10.5px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">{children}</div>;
}

function MonoPre({ text, tone }: { text: string; tone?: 'danger' }): ReactElement {
  return (
    <pre className={`overflow-auto whitespace-pre-wrap border border-[var(--gs-border)] bg-black p-[10px] font-[family-name:var(--gs-font-mono)] text-[11px] leading-[1.6] ${tone === 'danger' ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-text)]'}`}>
      {text}
    </pre>
  );
}

/** Body text: syntax-highlight when the evidence name looks like code, else mono pre. */
function BodyBlock({ ev }: { ev: Evidence }): ReactElement {
  const body = ev.body ?? '';
  const nameForLang = ev.displayName ?? ev.name;
  const lang = langForPath(nameForLang);
  if (lang) return <Highlighted text={body.slice(0, 200_000)} lang={lang} name={nameForLang} />;
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      return <Highlighted text={pretty} lang="json" name={nameForLang} />;
    } catch { /* not JSON — fall through to pre */ }
  }
  return <MonoPre text={body} />;
}

export function EvidencePanel({ evidence, requirementTitle, readArtifact }: {
  evidence: Evidence;
  requirementTitle?: string;
  /** Raw artifact reader (bound backend read) for on-demand media preview when
   *  the evidence has no inline previewUrl. Wired from the pane backend. */
  readArtifact?: ArtifactReader;
}): ReactElement {
  const ev = evidence;
  const kind = displayKindOf(ev);
  const captured = ev.source === 'command';
  const isVideo = ev.mimeType?.startsWith('video/') ?? false;
  const previewUrl = useEvidencePreviewUrl(ev, readArtifact);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gs-bg)] text-[12px]">
      {/* header — mock .ev-view-h */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-[9px] border-b border-[var(--gs-border)] bg-[#050505] px-4 py-[11px]">
        <span className={`${CHIP_BASE} ${KIND_CHIP[kind]}`}>{kind}</span>
        <span className="font-[family-name:var(--gs-font-mono)] text-[13px] text-[var(--gs-text)]">{ev.displayName ?? ev.name}</span>
        {ev.meta && <span className="text-[var(--gs-text-muted)]">— {ev.meta}</span>}
        {requirementTitle && <span className="text-[11px] text-[var(--gs-text-dim)]">for “{requirementTitle}”</span>}
        <span className="ml-auto font-[family-name:var(--gs-font-mono)] text-[10px] text-[var(--gs-text-dim)]">{ev.id}</span>
        <span className={`${CHIP_BASE} ${captured
          ? 'text-[var(--gs-chip-green-text)] bg-[var(--gs-chip-green-bg)]'
          : 'text-[var(--gs-chip-amber-text)] bg-[var(--gs-chip-amber-bg)]'}`}
        >
          {captured ? 'captured' : 'asserted'}
        </span>
        <span className="w-full font-[family-name:var(--gs-font-mono)] text-[10px] text-[var(--gs-text-dim)]">
          {new Date(ev.createdAt).toLocaleString()}
        </span>
      </div>

      {/* body — mock .ev-view-b */}
      <div className="min-h-0 flex-1 overflow-auto px-[18px] py-4">
        {previewUrl && (
          <div className="mb-4">
            {isVideo ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={previewUrl} controls className="max-h-[70vh] max-w-full border border-[var(--gs-border)] shadow-[0_4px_24px_rgba(0,0,0,0.6)]" />
            ) : (
              <img src={previewUrl} alt={ev.name} className="max-h-[70vh] max-w-full border border-[var(--gs-border)] shadow-[0_4px_24px_rgba(0,0,0,0.6)]" />
            )}
            <div className="mt-[6px] font-[family-name:var(--gs-font-mono)] text-[10px] text-[var(--gs-text-dim)]">
              {ev.mimeType ?? 'preview'}{ev.sizeBytes !== undefined ? ` · ${humanSize(ev.sizeBytes)}` : ''}
            </div>
          </div>
        )}

        {ev.command !== undefined && (
          <div className="mb-4">
            <SectionLabel>command</SectionLabel>
            <div className="flex items-center gap-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-[10px] py-[7px] font-[family-name:var(--gs-font-mono)] text-[11.5px]">
              <span className="text-[var(--gs-success)]">❯</span>
              <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]" title={ev.command}>{ev.command}</span>
              {ev.exitCode !== undefined && (
                <span className={`flex-shrink-0 text-[10px] ${ev.exitCode === 0 ? 'text-[var(--gs-success)]' : 'text-[var(--gs-danger)]'}`}>
                  exit {ev.exitCode}
                </span>
              )}
            </div>
          </div>
        )}

        {ev.body && (
          <div className="mb-4">
            <SectionLabel>body</SectionLabel>
            <BodyBlock ev={ev} />
          </div>
        )}

        {ev.stdout && (
          <div className="mb-4">
            <SectionLabel>stdout</SectionLabel>
            <MonoPre text={ev.stdout} />
          </div>
        )}

        {ev.stderr && (
          <div className="mb-4">
            <SectionLabel>stderr</SectionLabel>
            <MonoPre text={ev.stderr} tone="danger" />
          </div>
        )}

        {(ev.url || ev.originalPath || ev.artifactPath) && (
          <div className="mb-4">
            <SectionLabel>refs</SectionLabel>
            <div className="flex flex-col gap-[6px]">
              {ev.url && (
                <a
                  href={ev.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-[9px] border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-[11px] py-[8px] font-[family-name:var(--gs-font-mono)] text-[11.5px] text-[var(--gs-text)] no-underline transition-colors hover:border-[var(--gs-border-active)] hover:bg-[var(--gs-bg-hover)]"
                >
                  <span className="text-[var(--gs-text-dim)]">url</span>
                  <span className="min-w-0 flex-1 truncate">{ev.url}</span>
                  <span className="flex-shrink-0 text-[10.5px] text-[var(--gs-info)]">open ↗</span>
                </a>
              )}
              {ev.originalPath && (
                <div className="flex items-center gap-[9px] border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-[11px] py-[8px] font-[family-name:var(--gs-font-mono)] text-[11.5px] text-[var(--gs-text)]">
                  <span className="text-[var(--gs-text-dim)]">file</span>
                  <span className="min-w-0 flex-1 truncate" title={ev.originalPath}>{ev.originalPath}</span>
                </div>
              )}
              {ev.artifactPath && (
                <div className="flex items-center gap-[9px] border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-[11px] py-[8px] font-[family-name:var(--gs-font-mono)] text-[11.5px] text-[var(--gs-text)]">
                  <span className="text-[var(--gs-text-dim)]">artifact</span>
                  <span className="min-w-0 flex-1 truncate" title={ev.artifactPath}>{ev.artifactPath}</span>
                  {ev.sizeBytes !== undefined && !previewUrl && (
                    <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-dim)]">{humanSize(ev.sizeBytes)}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {!previewUrl && ev.command === undefined && !ev.body && !ev.stdout && !ev.stderr && !ev.url && !ev.originalPath && !ev.artifactPath && (
          <div className="text-[var(--gs-text-dim)]">No inline content for this evidence.</div>
        )}
      </div>
    </div>
  );
}
