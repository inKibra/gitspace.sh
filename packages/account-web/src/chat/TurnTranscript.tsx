import type { TransportBlock, TurnBlock } from '@gitspace/blocks';
import type { PendingAskAnswer } from '@gitspace/protocol';
import { useContext } from 'react';
import { TakeoverCardsContext } from '../TakeoverCard.js';
import { SideAgents } from './ExecutionCard.js';
import { ToolGroup, toolRuns } from './ToolGroup.js';
import { TranscriptItemView } from './TranscriptItemView.js';

export interface TurnTranscriptProps {
  turns: TurnBlock[];
  transport: TransportBlock[];
  /** Resolves the active ask tool dialog through the machine-owned UI bridge. */
  onAnswer?(answers: PendingAskAnswer[]): Promise<void>;
}

export function TransportNotice({ block }: { block: TransportBlock }) {
  return <p className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-muted-foreground [overflow-wrap:anywhere]">
    <span className="status-dot shrink-0 text-muted-foreground" data-pulse={block.status === 'reconnecting' || undefined} />
    <span className="text-foreground">{block.title}</span>
    {block.durationMs ? <span className="tabular-nums">{(block.durationMs / 1000).toFixed(1)}s</span> : null}
    {block.detail ? <span>{block.detail}</span> : null}
  </p>;
}

/** The transcript reads like the registry's chat demo: one column, messages stacked with gap-2, reasoning and tools
 * inline between them; consecutive tool calls of a turn show as one group. */
export function TurnTranscript({ turns, transport, onAnswer }: TurnTranscriptProps) {
  const cards = useContext(TakeoverCardsContext);
  return <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-6 px-6 pb-[calc(var(--composer-overlay-height,0px)+1.5rem)] pt-6">
    {transport.length ? <div className="flex min-w-0 flex-col gap-1">{transport.map((block) => <TransportNotice block={block} key={block.id} />)}</div> : null}
    {turns.map((turn) => <article className="flex min-w-0 flex-col gap-2" data-status={turn.status} key={turn.id}>
      {turn.user ? <TranscriptItemView item={turn.user} active={false} /> : null}
      {toolRuns(turn.items.flatMap((item) => item.type !== 'message' || item.role !== 'user' ? [{ item, turnId: turn.id }] : []), cards).map((run) => run.tools
        ? <ToolGroup calls={run.entries.flatMap(({ item }) => item.type === 'tool-call' ? [{ block: item, complete: true }] : [])} key={run.entries[0]!.item.id} />
        : <TranscriptItemView item={run.entry.item} active={turn.status === 'running'} onAnswer={onAnswer} key={run.entry.item.id} />)}
      {turn.sideAgents.length ? <SideAgents agents={turn.sideAgents} /> : null}
    </article>)}
  </div>;
}
