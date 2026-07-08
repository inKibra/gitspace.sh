/** @jsxImportSource react */
/**
 * GuideShareView — read-only review-guide renderer for share links.
 *
 * The in-app ChangeGuidePane is backend-coupled (live diffs, read-state,
 * approve/request-changes). A share renders the guide DOCUMENT itself:
 * narration, callouts, asks, exhibit lists — the reviewer's story, minus the
 * live diff bodies (the capability covers artifacts, not the code repo; the
 * exhibit list names the files so the recipient knows where to look).
 */
import { useMemo, type ReactElement } from 'react';
import type { ArtifactRead } from './ArtifactPanel.web.js';
import { renderMarkdownHtml } from './markdown-render.js';
import { decodeBase64Utf8 } from './artifact-kinds.js';

interface GuideDoc {
  version: number;
  headSha?: string;
  baseRef?: string;
  generatedAt?: string;
  specEvolution?: string;
  sections?: Array<{
    title?: string;
    kind?: string;
    explanation?: string;
    exhibits?: Array<{ file: string; note?: string; slow?: boolean }>;
    callouts?: Array<{ tone: 'risk' | 'mechanical' | 'decision'; text: string }>;
    asks?: string[];
    files?: string[];
  }>;
}

const TONE_STYLE: Record<string, string> = {
  risk: 'border-[var(--gs-chip-amber-border)] bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]',
  decision: 'border-[var(--gs-border-active)] bg-[var(--gs-bg-active)] text-[var(--gs-text)]',
  mechanical: 'border-[var(--gs-border)] bg-transparent text-[var(--gs-text-muted)]',
};

export function GuideShareView({ data }: {
  data: ArtifactRead;
  /** Reserved: evidence sub-reads (validation/, shots/) — v2 inline exhibits. */
  read?: (path: string) => Promise<ArtifactRead>;
}): ReactElement {
  const guide = useMemo<GuideDoc | null>(() => {
    try { return JSON.parse(decodeBase64Utf8(data.base64)) as GuideDoc; } catch { return null; }
  }, [data.base64]);

  if (!guide?.sections) {
    return <div className="p-8 text-[12px] text-[var(--gs-text-dim)]">Not a readable review guide.</div>;
  }

  const md = (text: string): ReactElement => (
    <div className="gs-block-md gs-md-preview !text-[12.5px] leading-[1.55]" style={{ display: 'block' }} dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(text) }} />
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-6 py-6">
        <div className="mb-5 border-b border-[var(--gs-border)] pb-3">
          <div className="text-[15px] font-semibold">Review guide</div>
          <div className="mt-1 flex gap-3 font-[family-name:var(--gs-font-mono)] text-[10.5px] text-[var(--gs-text-dim)]">
            {guide.headSha && <span>head {guide.headSha.slice(0, 8)}</span>}
            {guide.baseRef && <span>vs {guide.baseRef}</span>}
            {guide.generatedAt && <span>{new Date(guide.generatedAt).toLocaleString()}</span>}
          </div>
        </div>

        {guide.specEvolution && (
          <section className="mb-6">
            <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-[var(--gs-text-muted)]">How the spec evolved</div>
            {md(guide.specEvolution)}
          </section>
        )}

        {guide.sections.map((s, i) => (
          <section key={i} className="mb-6 border border-[var(--gs-border)] bg-[#070707] p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-semibold">{s.title ?? `Section ${i + 1}`}</span>
              {s.kind && <span className="border border-[var(--gs-border)] px-[5px] py-px text-[9.5px] uppercase tracking-[0.05em] text-[var(--gs-text-dim)]">{s.kind}</span>}
            </div>
            {s.explanation && md(s.explanation)}
            {(s.callouts ?? []).map((c, j) => (
              <div key={j} className={`mt-2 border px-2.5 py-1.5 text-[11.5px] ${TONE_STYLE[c.tone] ?? TONE_STYLE.mechanical}`}>
                <span className="mr-1.5 text-[9.5px] uppercase tracking-[0.05em] opacity-80">{c.tone}</span>
                {c.text}
              </div>
            ))}
            {(s.exhibits?.length ?? 0) > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-[var(--gs-text-muted)]">Exhibits</div>
                {s.exhibits!.map((e, j) => (
                  <div key={j} className="flex items-baseline gap-2 py-[2px]">
                    <span className="font-[family-name:var(--gs-font-mono)] text-[11px] text-[var(--gs-text)]">{e.file}</span>
                    {e.slow && <span className="text-[9.5px] uppercase text-[var(--gs-chip-amber-text)]">slow read</span>}
                    {e.note && <span className="text-[11px] text-[var(--gs-text-dim)]">— {e.note}</span>}
                  </div>
                ))}
                <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">Diff bodies aren't included in shares — the exhibit list names the files to read in the repo.</div>
              </div>
            )}
            {(s.asks?.length ?? 0) > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-[var(--gs-text-muted)]">Asks</div>
                {s.asks!.map((a, j) => <div key={j} className="py-[2px] text-[12px] text-[var(--gs-text)]">? {a}</div>)}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
