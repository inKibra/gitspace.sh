/** @jsxImportSource react */
import { type ReactElement } from 'react';
import { renderMarkdownHtml } from '../../components/markdown-render.js';
import type { AntiShortcutData, BoundariesData, EvidenceShapeData, IntentData, PlanData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';
import { useBlockHost } from './host.web.js';

// Goal-doc planning blocks: intent / boundaries / anti-shortcut / plan /
// evidence-shape. Visual structure mirrors the agent-surfaces mock; styling is
// Tailwind arbitrary values over the shared `--gs-*` tokens.

/** Inline markdown (bold/code/links) for the small annotation fields. */
function InlineMd({ text, className }: { text: string; className: string }): ReactElement {
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{
        __html: renderMarkdownHtml(text, {
          emptyHtml: '',
          paragraphClassName: 'my-0',
          inlineCodeClassName: 'bg-black border border-[var(--gs-border)] px-1 text-[11px] font-[family-name:var(--gs-font)]',
          linkClassName: 'text-[var(--gs-info)] underline',
        }),
      }}
    />
  );
}

// ── intent — the user's north star ──────────────────────────────────────────
defineRenderer<IntentData>('intent', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-accent)] bg-[var(--gs-accent-subtle)] px-3.5 py-3">
    <div className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--gs-accent)] mb-1.5">user intent · north star</div>
    <blockquote className="m-0 text-[14px] leading-[1.5] text-[var(--gs-text)]">{data.quote}</blockquote>
    {data.source && <div className="mt-1.5 text-[11px] text-[var(--gs-text-dim)]">— {data.source}</div>}
    {data.why && <InlineMd text={data.why} className="mt-2 text-[12px] text-[var(--gs-text-muted)]" />}
  </div>
));

// ── boundaries — locked surfaces ────────────────────────────────────────────
defineRenderer<BoundariesData>('boundaries', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-danger)]">
    <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-[var(--gs-danger)] bg-[rgba(255,81,81,0.05)] border-b border-[var(--gs-border)]">
      protected boundaries — do not change without explicit approval
    </div>
    {data.items.map((it, i) => (
      <div key={i} className="flex items-baseline gap-2 px-3 py-1.5 border-b border-[var(--gs-border-muted)] last:border-b-0 text-[12px]">
        <span className="flex-none text-[10px] uppercase tracking-[0.05em] text-[var(--gs-danger)] border border-[var(--gs-danger)] px-1">locked</span>
        <span className="flex-none font-[family-name:var(--gs-font)] text-[11.5px] text-[var(--gs-text)]">{it.surface}</span>
        <InlineMd text={it.rule} className="text-[var(--gs-text-muted)]" />
      </div>
    ))}
  </div>
));

// ── anti-shortcut — proof that looks complete but isn't ─────────────────────
defineRenderer<AntiShortcutData>('anti-shortcut', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-warning)]">
    <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-[var(--gs-warning)] bg-[rgba(255,204,0,0.04)] border-b border-[var(--gs-border)]">
      preventing shortcuts — proof that looks complete but isn't
    </div>
    {data.items.map((it, i) => (
      <div key={i} className="px-3 py-2 border-b border-[var(--gs-border-muted)] last:border-b-0">
        <div className="flex items-baseline gap-1.5 text-[12px] text-[var(--gs-text)]">
          <span className="flex-none text-[11px] text-[var(--gs-danger)]">✕</span>
          {it.shortcut}
        </div>
        <InlineMd text={it.why} className="mt-0.5 ml-[18px] text-[11.5px] text-[var(--gs-text-muted)]" />
      </div>
    ))}
  </div>
));

// ── plan — numbered steps citing the code they touch ────────────────────────
defineRenderer<PlanData>('plan', ({ data }): ReactElement => {
  const host = useBlockHost();
  return (
    <div className="my-2 border border-[var(--gs-border)]">
      {data.steps.map((s, i) => (
        <div key={i} className="flex gap-3 px-3 py-2.5 border-b border-[var(--gs-border-muted)] last:border-b-0">
          <span className="flex-none inline-flex items-center justify-center w-[22px] h-[22px] rounded-full border border-[var(--gs-accent)] text-[var(--gs-accent)] text-[11px]">{i + 1}</span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-[var(--gs-text)]">{s.title}</div>
            <InlineMd text={s.detail} className="mt-0.5 text-[11.5px] leading-[1.5] text-[var(--gs-text-muted)]" />
            {s.refs && s.refs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {s.refs.map((r, j) => (
                  <button
                    key={j}
                    type="button"
                    onClick={() => host.dispatch({ kind: 'open', target: r })}
                    className="font-[family-name:var(--gs-font)] text-[10px] text-[var(--gs-info)] border border-[var(--gs-border)] hover:border-[var(--gs-info)] bg-[#0a0a0a] px-1.5 py-px cursor-pointer"
                  >
                    ↳ {r}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

// ── evidence-shape — what proof we want at the end ──────────────────────────
const EV_KIND_CHIP: Record<EvidenceShapeData['items'][number]['kind'], string> = {
  command: 'border-[var(--gs-success)] text-[var(--gs-success)]',
  test: 'border-[var(--gs-success)] text-[var(--gs-success)]',
  screenshot: 'border-[var(--gs-info)] text-[var(--gs-info)]',
  video: 'border-[var(--gs-purple)] text-[var(--gs-purple)]',
  note: 'border-[var(--gs-border-active)] text-[var(--gs-text-dim)]',
};
defineRenderer<EvidenceShapeData>('evidence-shape', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)]">
    <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-[var(--gs-text-muted)] bg-[var(--gs-bg-elevated)] border-b border-[var(--gs-border)]">
      shape of the final evidence — what proof we want at the end
    </div>
    <table className="w-full border-collapse text-[11.5px]">
      <tbody>
        {data.items.map((it, i) => (
          <tr key={i} className="border-b border-[var(--gs-border-muted)] last:border-b-0">
            <td className="px-3 py-1.5 align-top w-[42%] text-[var(--gs-text)]">{it.requirement}</td>
            <td className="px-3 py-1.5 align-top">
              <span className={`border px-1.5 py-0.5 text-[10px] ${EV_KIND_CHIP[it.kind]}`}>{it.kind}</span>
            </td>
            <td className="px-3 py-1.5 align-top font-[family-name:var(--gs-font)] text-[10.5px] text-[var(--gs-text-muted)]">{it.captured}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
));
