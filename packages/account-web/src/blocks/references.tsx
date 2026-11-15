// What a block's references ({ pr }, { issue }, { workspace }) resolve against: the open project's workspaces and the pull
// requests linked to them, as the shell holds them. Outside a project (a shared guide page) they draw as plain chips.
import type { UiReference } from '@gitspace/protocol/gitspace-ui';
import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { Tooltip } from '@gitspace/ui';
import { createContext, useContext, type ReactNode } from 'react';
import { StatusDot } from '../GitSpaceShell.js';
import { PrChip } from '../sidebar/parts.js';
import type { LinkedPullRequest } from '../sidebar/project-graph.js';

export interface BlockReferenceTargets {
  /** The project's workspaces by id, with their status. */
  workspaces: Readonly<Record<string, { name: string; color: WorkspaceStatusColor; label: string }>>;
  /** Pull requests linked to the project's workspaces, by number. */
  pullRequests: Readonly<Record<number, LinkedPullRequest>>;
  /** `https://github.com/<owner>/<name>` when the project's origin is on GitHub. */
  repositoryUrl: string | null;
  openWorkspace: ((workspaceId: string) => void) | null;
}

export const BlockReferences = createContext<BlockReferenceTargets | null>(null);

const CHIP = 'inline-flex h-[18px] max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[10.5px] text-foreground/80 shadow-[inset_0_0_0_1px_var(--border)]';

function linked(href: string | null, chip: ReactNode): ReactNode {
  return href ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex shrink-0">{chip}</a> : chip;
}

/** A pull request (its live state and checks when it is linked to a workspace), an issue, or a workspace (its status
 * dot; opens it). */
export function RefChip({ reference }: { reference: UiReference }) {
  const targets = useContext(BlockReferences);
  if ('pr' in reference) {
    const known = targets?.pullRequests[reference.pr];
    if (known) return <PrChip pr={known} />;
    return linked(targets?.repositoryUrl ? `${targets.repositoryUrl}/pull/${reference.pr}` : null, <span className={`${CHIP} font-mono tabular-nums`}>#{reference.pr}</span>);
  }
  if ('issue' in reference) {
    return linked(targets?.repositoryUrl ? `${targets.repositoryUrl}/issues/${reference.issue}` : null, <span className={`${CHIP} font-mono tabular-nums`}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-label="issue"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.25" /><circle cx="5" cy="5" r="1.4" fill="currentColor" /></svg>
      {reference.issue}
    </span>);
  }
  const workspace = targets?.workspaces[reference.workspace];
  if (!workspace) return <Tooltip content={`${reference.workspace} · not in this project`} side="bottom"><span className={`${CHIP} max-w-48 font-mono text-muted-foreground`}><span className="truncate">{reference.workspace}</span></span></Tooltip>;
  const chip = <span className={CHIP}><StatusDot color={workspace.color} pulse={workspace.color === 'green'} /><span className="truncate">{workspace.name}</span></span>;
  const open = targets?.openWorkspace;
  return <Tooltip content={`${workspace.name} · ${workspace.label}`} side="bottom">
    {open ? <button type="button" className="inline-flex max-w-48 shrink-0 cursor-pointer" onClick={() => open(reference.workspace)}>{chip}</button> : <span className="inline-flex max-w-48">{chip}</span>}
  </Tooltip>;
}
