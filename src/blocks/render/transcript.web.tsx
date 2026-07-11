import { useState, type ReactElement } from 'react';
import type { ErrorData, ImageData, MessageData, SubagentData, ThinkingData, ToolCallData } from '../types/transcript.js';
import { defineRenderer, BlockView } from './registry.web.js';
import { useBlockHost } from './host.web.js';
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

/** Bordered uppercase status chip (mock .chip): tone via --gs-chip-* vars. */
const CHIP_BASE = 'border border-[var(--gs-border)] px-1.5 py-px text-[10px] uppercase tracking-[0.05em] leading-[1.4] whitespace-nowrap';

// ── message ───────────────────────────────────────────────────────────────
defineRenderer<MessageData>('message', ({ data }): ReactElement => {
  if (data.role === 'user') {
    // Attachment names are an optional extension on the message payload —
    // render chips only when a producer actually supplies them.
    const rawAtts = (data as { attachments?: unknown }).attachments;
    const atts = Array.isArray(rawAtts) ? rawAtts.filter((a): a is string => typeof a === 'string') : [];
    const pending = data.pending === true;
    return (
      // User turns are indented + accented so they stand apart from agent
      // output (restores the pre-mock transcript styling). Optimistic echoes
      // (submitted, server echo not yet received) render dimmed with a pulse.
      <div className={`my-2 ml-5 flex items-baseline border-l-2 border-[var(--gs-success)]/40 pl-3${pending ? ' opacity-60' : ''}`}>
        <span className="mr-2 flex-none text-[11px] lowercase text-[var(--gs-success)]">you</span>
        <div className="min-w-0 flex-1 text-[13px] leading-[1.6] text-[var(--gs-text)] whitespace-pre-wrap">
          <KeywordText text={data.text} />
          {pending && (
            <span className="ml-2 inline-flex items-center gap-1 align-middle text-[10px] text-[var(--gs-text-dim)]">
              <span className="inline-block h-[6px] w-[6px] rounded-full bg-[var(--gs-text-dim)] animate-pulse" /> sending…
            </span>
          )}
          {atts.length > 0 && (
            <span className="ml-2 inline-flex flex-wrap gap-1.5 align-middle">
              {atts.map((a) => (
                <span key={a} className={`${CHIP_BASE} bg-[var(--gs-chip-dim-bg)] font-mono text-[var(--gs-text-dim)]`}>▯ {a}</span>
              ))}
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="my-2 flex items-baseline">
      <span className="mr-2 flex-none text-[11px] lowercase text-[var(--gs-accent)]">agent</span>
      <div className="min-w-0 flex-1"><Markdown text={data.text} /></div>
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
const TOOL_STATUS_CHIP: Record<ToolCallData['status'], string> = {
  running: 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]',
  done: 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]',
  error: 'bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]',
};
// Input/output sections render their blocks directly (no visible section
// headers) — the border-t alone separates them from the header row.
function ToolSection({ blocks }: { blocks: readonly unknown[] }): ReactElement {
  return (
    <div className="border-t border-[var(--gs-border)] p-2">
      {blocks.map((b, i) => (
        <BlockView key={(b as { id?: string }).id ?? i} block={b as Parameters<typeof BlockView>[0]['block']} />
      ))}
    </div>
  );
}

defineRenderer<ToolCallData>('tool-call', ({ data }): ReactElement => {
  const input = data.input ?? [];
  const result = data.result ?? [];
  const hasOutput = result.length > 0;
  // Input stays visible so the whole eval code / task assignment is readable.
  // Only the OUTPUT collapses by default; the active (running) call keeps its
  // output open so streaming stays visible. The caret toggles output.
  const [outputOpen, setOutputOpen] = useState<boolean | null>(null);
  const showOutput = hasOutput && (outputOpen ?? data.status === 'running');
  return (
    <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
      <button
        type="button"
        onClick={() => hasOutput && setOutputOpen(!showOutput)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        title={hasOutput ? (showOutput ? 'Hide output' : 'Show output') : undefined}
      >
        {hasOutput
          ? <span className={showOutput ? 'rotate-90 transition-transform' : 'transition-transform'}>▶</span>
          : <span className="inline-block w-[1ch]" />}
        <span className="font-mono text-[12px] text-[var(--gs-accent)]">{data.tool}</span>
        {data.target && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--gs-text-dim)]">{data.target}</span>}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2">
          {data.status === 'running' && <span className="h-[7px] w-[7px] flex-none rounded-full bg-[var(--gs-success)] animate-pulse" />}
          {data.meta && <span className="font-mono text-[11px] text-[var(--gs-text-dim)]">{data.meta}</span>}
          <span className={`${CHIP_BASE} ${TOOL_STATUS_CHIP[data.status]}`}>{data.status}</span>
        </span>
      </button>
      {input.length > 0 && <ToolSection blocks={input} />}
      {showOutput && <ToolSection blocks={result} />}
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
const SUB_STATUS_CHIP: Record<SubagentData['status'], string> = {
  running: 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]',
  done: 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]',
  blocked: 'bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]',
  queued: 'bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]',
};
const SUB_STATUS_DOT: Record<SubagentData['status'], string> = {
  running: 'bg-[var(--gs-success)] animate-pulse',
  done: 'bg-[var(--gs-success)]',
  blocked: 'bg-[var(--gs-danger)]',
  queued: 'bg-[var(--gs-text-dim)]',
};
defineRenderer<SubagentData>('subagent', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-purple)] bg-[var(--gs-bg-elevated)]">
    <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--gs-border)]">
      <span className={`h-[7px] w-[7px] flex-none rounded-full ${SUB_STATUS_DOT[data.status]}`} />
      <span className="font-mono text-[12px] text-[var(--gs-text)]">✦ {data.label}</span>
      {data.model && <span className="font-mono text-[11px] text-[var(--gs-text-dim)]">{data.model}</span>}
      <span className={`ml-auto ${CHIP_BASE} ${SUB_STATUS_CHIP[data.status]}`}>{data.status}</span>
    </div>
    {data.lines.length > 0 && (
      <div className="px-2 py-1.5">
        {data.lines.map((l, i) => (
          <div key={i} className="text-[11px] text-[var(--gs-text-dim)] leading-[1.55]">→ {l}</div>
        ))}
      </div>
    )}
  </div>
));

// ── error ─────────────────────────────────────────────────────────────────
defineRenderer<ErrorData>('error', ({ data, block }): ReactElement => {
  const host = useBlockHost();
  return (
    <div className={`my-2 flex items-center gap-2 border px-2 py-1.5 text-[12px] ${data.aborted ? 'border-[var(--gs-border-active)] bg-[var(--gs-bg-active)] text-[var(--gs-text-muted)]' : 'border-[var(--gs-danger)] bg-[rgba(255,51,51,0.06)] text-[var(--gs-text-secondary)]'}`}>
      <span className={data.aborted ? 'text-[var(--gs-text-dim)]' : 'text-[var(--gs-danger)]'}>{data.aborted ? '◼' : '⚠'}</span>
      <span className="flex-1">{data.text}</span>
      {!data.aborted && (
        <button
          type="button"
          disabled={host.readOnly}
          onClick={() => host.dispatch({ kind: 'run', actionId: 'retry-prompt', payload: { blockId: block.id } })}
          className="text-[11px] border border-[var(--gs-border)] px-2 py-0.5 text-[var(--gs-text)] disabled:opacity-50"
        >
          Retry
        </button>
      )}
    </div>
  );
});
