/** @jsxImportSource react */
import { useMemo, type ReactElement } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';

/**
 * ReportPanel — dock-pane content for a report artifact ('⚑ report' tab,
 * mock: ReportViewer.tsx). Reports are agent feedback JSON stored under the
 * workspace artifacts mount (reports/*.json): toned kind chip + surface
 * header, optional quote block, note as markdown, typed attachment rows.
 */

export type ReportKind = 'praise' | 'good-pattern' | 'frustration' | 'workflow-quirk' | 'gitspace-quirk';

export interface ReportAttachment {
  type: string;
  ref: string;
  label?: string;
  /** Frozen copy captured when the report was favorited (beside the report in
   *  `<report>.attachments/`). The live ref may drift; the snapshot cannot. */
  snapshotRef?: string;
}

export interface ReportItem {
  kind: ReportKind;
  surface: string;
  note: string;
  quote?: string;
  attachments?: ReportAttachment[];
}

const REPORT_KINDS: ReadonlySet<string> = new Set<string>([
  'praise', 'good-pattern', 'frustration', 'workflow-quirk', 'gitspace-quirk',
]);

/** mock .rep-kind tones: praise blue, good-pattern green, frustration red, workflow-quirk amber, gitspace-quirk violet. */
const KIND_CHIP: Record<ReportKind, string> = {
  praise: 'text-[var(--gs-info)] border-[rgba(68,136,255,0.4)]',
  'good-pattern': 'text-[var(--gs-success)] border-[rgba(0,255,102,0.4)]',
  frustration: 'text-[var(--gs-danger)] border-[rgba(255,51,51,0.4)]',
  'workflow-quirk': 'text-[var(--gs-warning)] border-[rgba(255,204,0,0.4)]',
  'gitspace-quirk': 'text-[var(--gs-purple)] border-[rgba(188,140,255,0.4)]',
};

/** mock ATT_ICON per attachment type. */
const ATT_ICON: Record<string, string> = {
  conversation: '❝',
  prompt: '⌜',
  skill: '✦',
  tool: '⛭',
  'workflow-snapshot': '⟜',
  'goal-doc-snapshot': '◇',
};

/** Validate the raw artifact JSON into a ReportItem, or return null when malformed. */
export function parseReportItem(raw: unknown): ReportItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !REPORT_KINDS.has(r.kind)) return null;
  if (typeof r.surface !== 'string' || typeof r.note !== 'string') return null;
  if (r.quote !== undefined && typeof r.quote !== 'string') return null;
  let attachments: ReportAttachment[] | undefined;
  if (r.attachments !== undefined) {
    if (!Array.isArray(r.attachments)) return null;
    attachments = [];
    for (const a of r.attachments) {
      if (typeof a !== 'object' || a === null) return null;
      const at = a as Record<string, unknown>;
      if (typeof at.type !== 'string' || typeof at.ref !== 'string') return null;
      if (at.label !== undefined && typeof at.label !== 'string') return null;
      if (at.snapshotRef !== undefined && typeof at.snapshotRef !== 'string') return null;
      attachments.push({ type: at.type, ref: at.ref, label: at.label, snapshotRef: at.snapshotRef });
    }
  }
  return {
    kind: r.kind as ReportKind,
    surface: r.surface,
    note: r.note,
    quote: r.quote,
    attachments,
  };
}

function SectionLabel({ children, className }: { children: string; className?: string }): ReactElement {
  return <div className={`mb-[7px] text-[10.5px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)] ${className ?? ''}`}>{children}</div>;
}

export function ReportPanel({ report, onOpenAttachment, resolveRef }: {
  /** Raw report artifact JSON — parsed + validated internally; malformed input renders an error state. */
  report: unknown;
  /** Receives the RESOLVED mount-relative path when `resolveRef` is provided,
   *  else the raw ref (legacy callers). */
  onOpenAttachment?: (path: string) => void;
  /** Resolve an attachment ref against THE REPORT'S OWN path prefix (see
   *  resolveAttachmentRef in artifact-kinds). null = target missing — the row
   *  renders a clear missing state instead of opening a broken viewer. */
  resolveRef?: (ref: string) => string | null;
}): ReactElement {
  const parsed = useMemo(() => parseReportItem(report), [report]);
  const noteHtml = useMemo(() => (parsed ? renderMarkdownHtml(parsed.note) : ''), [parsed]);

  if (!parsed) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--gs-bg)] text-[12px]">
        <div className="flex flex-shrink-0 items-center gap-[9px] border-b border-[var(--gs-border)] px-4 py-[11px]">
          <span className="text-[var(--gs-danger)]">⚑</span>
          <span className="text-[var(--gs-text)]">report</span>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
          <div>
            <div className="text-[var(--gs-danger)]">Malformed report artifact.</div>
            <div className="mt-1 text-[11px] text-[var(--gs-text-dim)]">
              Expected {'{ kind, surface, note, quote?, attachments? }'} with kind praise · good-pattern · frustration · workflow-quirk · gitspace-quirk.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gs-bg)] text-[12px]">
      {/* header — mock .rpt-head */}
      <div className="flex flex-shrink-0 items-center gap-[9px] border-b border-[var(--gs-border)] px-4 py-[11px]">
        <span className={`flex-shrink-0 whitespace-nowrap border px-[5px] py-px text-[10.5px] uppercase tracking-[0.04em] ${KIND_CHIP[parsed.kind]}`}>
          {parsed.kind}
        </span>
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{parsed.surface}</span>
      </div>

      {/* body — mock .rpt-body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[760px] p-4">
          <SectionLabel>agent feedback</SectionLabel>
          {parsed.quote && (
            <blockquote className="mb-3 border-l-2 border-[var(--gs-accent)] bg-[var(--gs-accent-subtle)] px-[13px] py-[9px] text-[13px] leading-[1.5] text-[var(--gs-text)]">
              {parsed.quote}
            </blockquote>
          )}
          <div
            className="gs-block-md text-[12.5px] leading-[1.55] text-[var(--gs-text)]"
            dangerouslySetInnerHTML={{ __html: noteHtml }}
          />

          <SectionLabel className="mt-4">attachments — what was reported</SectionLabel>
          <div className="flex flex-col gap-[6px]">
            {parsed.attachments && parsed.attachments.length > 0 ? (
              parsed.attachments.map((a, i) => {
                // Resolve BOTH targets against the report's own prefix. The
                // snapshot (frozen at favorite time) is the primary open; the
                // live ref stays reachable via a secondary affordance.
                const resolve = resolveRef ?? ((r: string): string | null => r);
                const live = resolve(a.ref);
                const snapshot = a.snapshotRef !== undefined ? resolve(a.snapshotRef) : null;
                const primary = snapshot ?? live;
                if (primary === null) {
                  // Neither candidate exists — a clear missing state, never a
                  // silently-broken empty viewer.
                  return (
                    <div
                      key={`${a.ref}:${i}`}
                      title={`attachment target missing: ${a.ref}`}
                      className="flex w-full items-center gap-[9px] border border-dashed border-[rgba(255,51,51,0.35)] bg-[var(--gs-bg-elevated)] px-[11px] py-2 text-left"
                    >
                      <span className="w-4 flex-shrink-0 text-center text-[13px] text-[var(--gs-text-ghost)]">{ATT_ICON[a.type] ?? '•'}</span>
                      <span className="w-[124px] flex-shrink-0 truncate text-[10px] uppercase tracking-[0.05em] text-[var(--gs-text-dim)]">{a.type}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--gs-text-muted)]">{a.label ?? a.ref}</span>
                      <span className="flex-shrink-0 text-[10.5px] text-[var(--gs-danger)]">target missing — {a.ref}</span>
                    </div>
                  );
                }
                return (
                  <button
                    key={`${a.ref}:${i}`}
                    type="button"
                    title={snapshot !== null ? `open pinned snapshot (${primary})` : `open ${a.type}`}
                    onClick={() => onOpenAttachment?.(primary)}
                    className="flex w-full items-center gap-[9px] border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-[11px] py-2 text-left transition-colors hover:border-[var(--gs-border-active)] hover:bg-[var(--gs-bg-hover)]"
                  >
                    <span className="w-4 flex-shrink-0 text-center text-[13px] text-[var(--gs-purple)]">{ATT_ICON[a.type] ?? '•'}</span>
                    <span className="w-[124px] flex-shrink-0 truncate text-[10px] uppercase tracking-[0.05em] text-[var(--gs-text-dim)]">{a.type}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--gs-text)]">{a.label ?? a.ref}</span>
                    {snapshot !== null && (
                      <span
                        title="frozen copy captured when this report was favorited"
                        className="flex-shrink-0 border border-[rgba(188,140,255,0.4)] px-[5px] py-px text-[9.5px] uppercase tracking-[0.05em] text-[var(--gs-purple)]"
                      >
                        ⌖ pinned
                      </span>
                    )}
                    {snapshot !== null && (
                      live !== null ? (
                        <span
                          role="button"
                          tabIndex={0}
                          title={`open the LIVE target (${live}) — may have changed since capture`}
                          onClick={(e) => { e.stopPropagation(); onOpenAttachment?.(live); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpenAttachment?.(live); } }}
                          className="flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)] hover:text-[var(--gs-info)]"
                        >
                          live ↗
                        </span>
                      ) : (
                        <span title={`live target missing: ${a.ref}`} className="flex-shrink-0 text-[10.5px] text-[var(--gs-text-ghost)]">live missing</span>
                      )
                    )}
                    <span className="flex-shrink-0 text-[10.5px] text-[var(--gs-info)]">open ↗</span>
                  </button>
                );
              })
            ) : (
              <span className="text-[12px] text-[var(--gs-text-dim)]">no attachments</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
