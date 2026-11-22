// An agent's question to a ghost (`ghost_ask`) as its conversation shows it: the session asked about, the question and
// the ghost's cited answer. A citation opens that workspace at the entry or the drive lines (in the version the ghost
// read), as a person's ghost's do.
import type { ToolCallBlock } from '@gitspace/blocks';
import { GhostAskResultSchema, RuntimeGhostAskArgumentsSchema, ghostParts, type GhostAskResult, type GhostCite, type GhostDriveVersion } from '@gitspace/protocol-runtime';
import { Tooltip, useShape } from '@gitspace/ui';
import { Check, Copy01, Lock01 } from '@untitledui/icons';
import { useMemo, useState } from 'react';
import type { ItemInteractionProps } from '../chat/TranscriptItemView.js';
import { selectInspection } from '../routes.js';
import { AMBER, CiteChip, GHOST, GhostGlyph, Inline, readLabel } from './ghost-parts.js';
import { showGhostCite } from './ghost-store.js';

/** An answer longer than this shows folded until opened. */
const FOLDED = 600;

/** The ghost's result in a finished call's output, or null for any other output. */
function askResult(text: string): GhostAskResult | null {
  try {
    const parsed = GhostAskResultSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function Draft({ draft }: { draft: string }) {
  const [copied, setCopied] = useState(false);
  return <div aria-label="Draft" className="overflow-hidden rounded-[10px] border border-dashed border-border bg-background/70">
    <div className="flex items-center gap-1.5 border-b border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">Draft</span>
      <span className="min-w-0 truncate">· the ghost can’t send it; the agent may</span>
      <button type="button" className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 hover:bg-foreground/[0.07]" onClick={() => { void navigator.clipboard.writeText(draft).then(() => setCopied(true)); }}>
        {copied ? <Check width={12} height={12} strokeWidth={1.75} /> : <Copy01 width={12} height={12} strokeWidth={1.75} />}{copied ? 'Copied' : 'Copy'}
      </button>
    </div>
    <p className="whitespace-pre-wrap px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground">{draft}</p>
  </div>;
}

/** A `ghost_ask` call: compact while it runs or fails, the question and cited answer once answered. */
export function GhostAskCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const shape = useShape();
  const args = RuntimeGhostAskArgumentsSchema.safeParse(block.args);
  const output = (block.result ?? []).flatMap(content => content.type === 'code' || content.type === 'markdown' ? [content.text] : []).join('\n');
  const result = useMemo(() => block.status === 'done' ? askResult(output) : null, [block.status, output]);
  const parts = useMemo(() => result && ghostParts(result.answer, new Map(result.cites.flatMap((cite): [string, GhostDriveVersion][] => cite.kind === 'drive' ? [[cite.url, { generation: cite.generation, hash: cite.hash }]] : []))), [result]);
  const question = args.success ? args.data.question : null;
  const followUp = args.success && args.data.ghostId !== undefined;
  const session = result?.session;
  const subject = session ? session.workspace : followUp ? 'its ghost' : args.success && args.data.workspaceId !== undefined ? args.data.workspaceId : 'this conversation';
  const running = block.status === 'running' || block.status === 'pending';
  const failure = !running && !result ? output || 'The ghost did not answer.' : null;
  // Entries open in the workspace's transcript, which shows its main conversation; drive lines open in its Drive.
  const onCite = (cite: GhostCite): void => {
    const projectId = new URL(window.location.href).searchParams.get('project');
    if (!session || !projectId) return;
    showGhostCite(session.workspaceId, cite);
    selectInspection(projectId, session.workspaceId === projectId ? null : session.workspaceId);
  };
  const folded = (result?.answer.length ?? 0) > FOLDED && !state?.open;
  return <div role="group" aria-label={`Asked a ghost of ${subject}`} data-ghost-ask={block.toolCallId} className={`flex min-w-0 flex-col gap-1.5 border border-border bg-surface-2 px-3 py-2 ${shape.container}`}>
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full" style={{ color: GHOST, background: `color-mix(in oklab, ${GHOST} 16%, transparent)` }}><GhostGlyph size={15} /></span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-caption">
        <span className="shrink-0 font-medium text-foreground">{followUp ? 'Asked its ghost again' : 'Asked a ghost'}</span>
        <span className="min-w-0 truncate text-muted-foreground" title={session ? `${session.workspace} · ${session.title} (${session.conversationId})` : undefined}>
          of {subject}{session ? ` · ${session.title}` : ''}
        </span>
        {session?.archived ? <span className="shrink-0 rounded-full border border-border px-1.5 text-[10.5px] leading-4 text-muted-foreground">Archived</span> : null}
      </span>
      <Tooltip side="top" content={<span className="block max-w-[260px] whitespace-normal leading-snug"><b>Reads only.</b> It read that one conversation and its workspace’s drive as of its start, and kept nothing. It can’t act or post.</span>}>
        <span className="inline-flex shrink-0 cursor-help items-center gap-0.5 rounded-full px-1.5 text-[10.5px] leading-4" style={{ background: `color-mix(in oklab, ${GHOST} 14%, transparent)`, color: `color-mix(in oklab, ${GHOST} 70%, var(--foreground))` }}><Lock01 width={10} height={10} strokeWidth={2} />read-only</span>
      </Tooltip>
    </div>
    {question ? <p className="line-clamp-2 pl-8 text-[12px] italic text-muted-foreground [overflow-wrap:anywhere]">“{question}”</p> : null}
    {running ? <p role="status" className="ghost-shimmer pl-8 text-[12px] text-muted-foreground">The ghost is reading…</p> : null}
    {failure ? <p role="alert" className="pl-8 text-[12px] leading-snug [overflow-wrap:anywhere]" style={{ color: AMBER }}>{failure}</p> : null}
    {result && parts ? <div className="flex min-w-0 flex-col gap-1.5 pl-8">
      <div data-ghost-answer className={`whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground/90 [overflow-wrap:anywhere] ${folded ? 'line-clamp-6' : ''}`}>
        {parts.map((part, index) => typeof part === 'string' ? <Inline key={index} text={part} />
          : <CiteChip key={index} cite={part} {...part.kind !== 'entry' || result.session.main ? { onCite } : {}} />)}
      </div>
      {(result.answer.length > FOLDED) ? <button type="button" className="self-start text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => onStateChange?.({ open: !state?.open })}>{folded ? 'Show the whole answer' : 'Show less'}</button> : null}
      {result.truncated ? <span className="text-[11px] text-muted-foreground">It stopped at its limit and answered from what it read.</span> : null}
      {result.draft ? <Draft draft={result.draft} /> : null}
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-[10.5px] text-muted-foreground">
        {result.reads.length ? <span className="min-w-0 truncate" title={result.reads.map(readLabel).join('\n')}>{result.reads.map(readLabel).join(' · ')}</span> : <span>no new reads</span>}
        <span>· {result.usage.model}</span>
        <span>· ${result.usage.costUsd.toFixed(4)}</span>
        <span title={`Asked again with ghostId ${result.ghostId}`}>· {Date.parse(result.expiresAt) > Date.now() ? `fades ${new Date(result.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'faded'}</span>
      </p>
    </div> : null}
  </div>;
}
