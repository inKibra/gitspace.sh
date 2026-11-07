import type { ExecutionBlock, SideAgentBlock } from '@gitspace/blocks';
import { Badge, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, useShape } from '@gitspace/ui';
import { ChevronDown, ChevronRight, Terminal, Users01 } from '@untitledui/icons';
import { useState } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import type { ExecutionHistoryRenderer, ItemInteractionProps } from './TranscriptItemView.js';

export function SideAgents({ agents, state, onStateChange }: { agents: SideAgentBlock[] } & ItemInteractionProps) {
  const running = agents.filter((agent) => agent.status === 'running' || agent.status === 'blocked').length;
  return <ThinkingSteps defaultOpen={running > 0} open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
    <ThinkingStepsHeader>Subagents · {agents.length}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      {agents.map((agent, index) => <ThinkingStep
        key={agent.id}
        icon="users"
        label={agent.label}
        description={[agent.agent, agent.status].filter(Boolean).join(' · ')}
        status={agent.status === 'running' ? 'active' : 'complete'}
        isLast={index === agents.length - 1}
      >{agent.summary ? <p className="text-body text-muted-foreground">{agent.summary}</p> : null}</ThinkingStep>)}
    </ThinkingStepsContent>
  </ThinkingSteps>;
}

export function Execution({ block, state, onStateChange, renderHistory }: { block: ExecutionBlock; renderHistory?: ExecutionHistoryRenderer } & ItemInteractionProps) {
  const shape = useShape();
  const [localOpen, setLocalOpen] = useState(block.hasFailures || block.status === 'blocked');
  const open = state?.executionOpen ?? localOpen;
  const kind = block.kind === 'agent' ? 'Agent' : block.kind === 'process' ? 'Process' : 'Background job';
  const color = block.status === 'failed' ? 'red' : block.status === 'blocked' || block.status === 'queued' ? 'amber' : block.status === 'cancelled' ? 'gray' : 'green';
  const Icon = block.kind === 'agent' ? Users01 : Terminal;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <section className={`${shape.container} min-w-0 bg-surface-2 shadow-surface-1`} data-execution-id={block.executionId} data-execution-kind={block.kind}>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      {renderHistory ? <button
        type="button"
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${kind.toLowerCase()} history: ${block.label}`}
        onClick={() => { setLocalOpen(!open); onStateChange?.({ executionOpen: !open }); }}
      ><Chevron width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><Icon width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><span className="min-w-0 text-body [overflow-wrap:anywhere]"><span className="mr-2 text-muted-foreground">{kind}</span>{block.label}</span></button>
        : <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2"><Icon width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><span className="min-w-0 text-body [overflow-wrap:anywhere]"><span className="mr-2 text-muted-foreground">{kind}</span>{block.label}</span></div>}
      <Badge variant="dot" color={color}>{block.status}</Badge>
      {block.hasFailures && block.status !== 'failed' ? <Badge variant="dot" color="red">Failure in history</Badge> : null}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-3 text-caption text-muted-foreground">
      <span className="tabular-nums">{block.historyCount} {block.historyCount === 1 ? 'call' : 'calls'}</span>
      {block.agent ? <span>{block.agent}</span> : null}
      {block.model ? <span>{block.model}</span> : null}
      {block.durationMs !== undefined ? <span className="tabular-nums">{(block.durationMs / 1000).toFixed(1)}s</span> : null}
      {block.status === 'blocked' ? <span className="text-foreground">Waiting for input or a dependency</span> : null}
    </div>
    {block.summary ? <div className="min-w-0 px-3 pb-3 text-body text-muted-foreground [overflow-wrap:anywhere]"><GitSpaceMarkdown>{block.summary}</GitSpaceMarkdown></div> : null}
    {open && renderHistory ? renderHistory(block, state ?? {}, onStateChange) : null}
  </section>;
}
