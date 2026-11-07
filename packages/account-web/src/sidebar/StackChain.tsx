import type { StackStatus } from '@gitspace/protocol';
import { StatusDot, WorkspaceStatusDot, type SpaceStatusView } from '../GitSpaceShell.js';
import { stackOf, type GraphWorkspace } from './graph.js';

/** A workspace of a stack as the chain shows it; `status` absent while it is unknown. */
export interface ChainWorkspace extends GraphWorkspace { name: string; branch: string; status?: SpaceStatusView }

/** A stacked workspace's git position against its parent, as information: what the parent has that it lacks, and the
 * optional command that takes it in. Null while the position is unread. */
function stackPosition(status: StackStatus | undefined, parent: ChainWorkspace): { text: string; command: string | null } | null {
  if (!status || status.parentId !== parent.id) return null;
  if (status.parentMerged === 'merged') return { text: `${parent.name} merged into ${status.baseBranch}`, command: `git rebase --onto ${status.baseBranch} ${parent.branch}` };
  if (status.parentAhead > 0) return { text: `${status.parentAhead} ${status.parentAhead === 1 ? 'commit' : 'commits'} behind ${parent.name}`, command: `git rebase ${parent.branch}` };
  return { text: `up to date with ${parent.name}`, command: null };
}

/**
 * A workspace's whole stack as an ordered chain, bottom first and depth-first through forks: each link merges after
 * the one it is stacked on, with its git position against that parent. Renders nothing when the workspace is in no
 * stack.
 */
export function StackChain({ items, id, baseBranch, statuses, compact, onOpen }: { items: readonly ChainWorkspace[]; id: string; baseBranch: string; statuses: ReadonlyMap<string, StackStatus>; compact: boolean; onOpen(id: string): void }) {
  const members = stackOf(items, id);
  if (members.length < 2) return null;
  const size = compact ? 'text-[10.5px]' : 'text-caption';
  return <ol aria-label="Stack" data-stack-chain={id} className="flex min-w-0 flex-col">
    {members.map((member, index) => {
      const parent = members.find(other => other.id === member.stackedOn);
      const position = parent ? stackPosition(statuses.get(member.id), parent) : null;
      const current = member.id === id;
      return <li key={member.id} data-stack-link={member.id} className={`flex min-w-0 gap-2 rounded-md px-1.5 py-1 ${current ? 'bg-active' : ''}`}>
        <span className="w-3 shrink-0 pt-px text-right text-[10.5px] tabular-nums text-muted-foreground">{index + 1}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <button type="button" onClick={() => onOpen(member.id)} className={`flex min-w-0 items-center gap-1.5 text-left hover:underline ${compact ? 'text-[12px]' : 'text-body'} ${current ? 'font-medium text-foreground' : 'text-foreground/90'}`}>
            <span className="inline-flex size-3 shrink-0 items-center justify-center">{member.status ? <WorkspaceStatusDot space={member.status} /> : <StatusDot color="dim" />}</span><span className="truncate">{member.name}</span>
          </button>
          <span className={`min-w-0 text-muted-foreground ${size}`}>
            {parent ? <>merges after {parent.name}{position ? <> · {position.text}</> : null}</> : <>bottom of the stack · merges into {baseBranch}</>}
          </span>
          {position?.command ? <span className={`min-w-0 text-muted-foreground ${size}`}>optional: <code className="font-mono [overflow-wrap:anywhere]">{position.command}</code></span> : null}
        </span>
      </li>;
    })}
  </ol>;
}
