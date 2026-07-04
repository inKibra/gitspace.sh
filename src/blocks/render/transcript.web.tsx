import { useState, type ReactElement } from 'react';
import type { ErrorData, ImageData, MessageData, SubagentData, ThinkingData, ToolCallData } from '../types/transcript.js';
import { defineRenderer, BlockView } from './registry.web.js';
import { Markdown } from './markdown.web.js';
import { segmentMagicKeywords } from '../agent/magic-keywords.js';

/** Render text with magic keywords (workflowz / orchestrate / ultrathink) painted
 *  in the accent color, matching the composer + the SDK's sent-bubble treatment. */
function KeywordText({ text }: { text: string }): ReactElement {
  return (
    <>
      {segmentMagicKeywords(text).map((seg, i) =>
        seg.keyword
          ? <span key={i} className="font-semibold text-[var(--gs-accent)]">{seg.text}</span>
          : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

// ── message ───────────────────────────────────────────────────────────────
defineRenderer<MessageData>('message', ({ data }): ReactElement => {
  if (data.role === 'user') {
    return (
      <div className="my-2 border-l-2 border-[var(--gs-border-active)] pl-3 py-1">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">you</div>
        <div className="text-[13px] leading-[1.6] text-[var(--gs-text)] whitespace-pre-wrap"><KeywordText text={data.text} /></div>
      </div>
    );
  }
  return (
    <div className="my-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--gs-accent)]">agent</div>
      <Markdown text={data.text} />
    </div>
  );
});

// ── thinking ──────────────────────────────────────────────────────────────
defineRenderer<ThinkingData>('thinking', ({ data }): ReactElement => {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11px] text-[var(--gs-text-muted)]"
      >
        <span className={open ? 'rotate-90 transition-transform' : 'transition-transform'}>▶</span> thinking
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l border-[var(--gs-border)] text-[12px] leading-[1.6] text-[var(--gs-text-muted)] whitespace-pre-wrap">
          {data.text}
        </div>
      )}
    </div>
  );
});

// ── tool-call (composes nested blocks in its result) ────────────────────────
const TOOL_STATUS: Record<ToolCallData['status'], string> = {
  running: 'text-[var(--gs-warning)]',
  done: 'text-[var(--gs-success)]',
  error: 'text-[var(--gs-danger)]',
};
defineRenderer<ToolCallData>('tool-call', ({ data }): ReactElement => {
  const result = data.result ?? [];
  const hasResult = result.length > 0;
  const [open, setOpen] = useState(hasResult);
  return (
    <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
      <button
        type="button"
        onClick={() => hasResult && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        {hasResult && <span className={open ? 'rotate-90 transition-transform' : 'transition-transform'}>▶</span>}
        <span className="text-[12px] text-[var(--gs-text)]">{data.tool}</span>
        {data.target && <span className="text-[11px] text-[var(--gs-text-dim)] truncate">{data.target}</span>}
        <span className="ml-auto flex items-center gap-2">
          {data.meta && <span className="text-[11px] text-[var(--gs-text-dim)]">{data.meta}</span>}
          <span className={`text-[11px] ${TOOL_STATUS[data.status]}`}>{data.status}</span>
        </span>
      </button>
      {open && hasResult && (
        <div className="border-t border-[var(--gs-border)] p-2">
          {result.map((b, i) => (
            <BlockView key={(b as { id?: string }).id ?? i} block={b} />
          ))}
        </div>
      )}
    </div>
  );
});

// ── image ─────────────────────────────────────────────────────────────────
defineRenderer<ImageData>('image', ({ data }): ReactElement => (
  <figure className="my-2">
    <img src={data.src} alt={data.alt ?? ''} className="max-w-full border border-[var(--gs-border)]" />
    {data.caption && <figcaption className="mt-1 text-[11px] text-[var(--gs-text-dim)]">{data.caption}</figcaption>}
  </figure>
));

// ── subagent ──────────────────────────────────────────────────────────────
const SUB_STATUS: Record<SubagentData['status'], string> = {
  running: 'text-[var(--gs-warning)]',
  done: 'text-[var(--gs-success)]',
  blocked: 'text-[var(--gs-danger)]',
  queued: 'text-[var(--gs-text-dim)]',
};
defineRenderer<SubagentData>('subagent', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
    <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--gs-border)]">
      <span className="text-[12px] text-[var(--gs-text)]">✦ {data.label}</span>
      {data.model && <span className="text-[11px] text-[var(--gs-text-dim)]">{data.model}</span>}
      <span className={`ml-auto text-[11px] ${SUB_STATUS[data.status]}`}>{data.status}</span>
    </div>
    {data.lines.length > 0 && (
      <div className="px-2 py-1.5">
        {data.lines.map((l, i) => (
          <div key={i} className="text-[11px] text-[var(--gs-text-muted)] leading-[1.55]">→ {l}</div>
        ))}
      </div>
    )}
  </div>
));

// ── error ─────────────────────────────────────────────────────────────────
defineRenderer<ErrorData>('error', ({ data }): ReactElement => (
  <div className={`my-2 flex items-center gap-2 border px-2 py-1.5 text-[12px] ${data.aborted ? 'border-[var(--gs-border-active)] bg-[var(--gs-bg-active)] text-[var(--gs-text-muted)]' : 'border-[var(--gs-danger)] bg-[rgba(255,51,51,0.06)] text-[var(--gs-text-secondary)]'}`}>
    <span className={data.aborted ? 'text-[var(--gs-text-dim)]' : 'text-[var(--gs-danger)]'}>{data.aborted ? '◼' : '⚠'}</span>
    <span className="flex-1">{data.text}</span>
    {!data.aborted && <button type="button" className="text-[11px] border border-[var(--gs-border)] px-2 py-0.5 text-[var(--gs-text)]">Retry</button>}
  </div>
));
