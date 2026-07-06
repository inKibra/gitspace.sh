/** @jsxImportSource react */
import type { ReactElement } from 'react';
import type { Evidence } from '../types/goals.js';
import { Highlighted } from '../blocks/render/highlight.web.js';
import { humanSize, langForPath } from './ArtifactPanel.web.js';

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

export function EvidencePanel({ evidence, requirementTitle }: {
  evidence: Evidence;
  requirementTitle?: string;
}): ReactElement {
  const ev = evidence;
  const kind = displayKindOf(ev);
  const captured = ev.source === 'command';
  const isVideo = ev.mimeType?.startsWith('video/') ?? false;

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
        {ev.previewUrl && (
          <div className="mb-4">
            {isVideo ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={ev.previewUrl} controls className="max-h-[70vh] max-w-full border border-[var(--gs-border)] shadow-[0_4px_24px_rgba(0,0,0,0.6)]" />
            ) : (
              <img src={ev.previewUrl} alt={ev.name} className="max-h-[70vh] max-w-full border border-[var(--gs-border)] shadow-[0_4px_24px_rgba(0,0,0,0.6)]" />
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
                  {ev.sizeBytes !== undefined && !ev.previewUrl && (
                    <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-dim)]">{humanSize(ev.sizeBytes)}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {!ev.previewUrl && ev.command === undefined && !ev.body && !ev.stdout && !ev.stderr && !ev.url && !ev.originalPath && !ev.artifactPath && (
          <div className="text-[var(--gs-text-dim)]">No inline content for this evidence.</div>
        )}
      </div>
    </div>
  );
}
