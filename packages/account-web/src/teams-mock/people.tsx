// The people in a workspace: avatars, the holders' stack on a row or card, the Free mark, and the handle's actions
// (claim, ask, take over, assign, release). An action the viewer's role refuses stays visible, its reason in a tooltip
// and, on click, in a toast.
import { Button, DropdownContent, DropdownLabel, DropdownMenu, DropdownTrigger, MenuItem, Tooltip } from '@gitspace/ui';
import { ChevronDown, Hand, UserPlus01 } from '@untitledui/icons';
import type { ReactNode } from 'react';
import { actorLabel, principalOf, USERS, userOf, visibleProjects } from './data.js';
import { decidersOf, names, type Row } from './model.js';
import { projectRoleOf, useRoles, why, type ProjectAction } from './settings/roles.js';
import { useMock } from './viewer.js';

/** A person's round avatar, or a bot's square one. */
export function Avatar({ userId, size = 20, ring = false }: { userId: string; size?: number; ring?: boolean }) {
  const principal = principalOf(userId);
  return <span aria-hidden className={`inline-flex shrink-0 items-center justify-center font-semibold text-white ${principal.kind === 'bot' ? 'rounded-[28%]' : 'rounded-full'}`}
    style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)), background: principal.color, boxShadow: ring ? '0 0 0 2px var(--background)' : undefined }}>{principal.initials}</span>;
}

/** The holders' avatars, overlapping; nothing when free (the caller shows Free). */
export function HolderStack({ holders, size = 16 }: { holders: readonly string[]; size?: number }) {
  if (!holders.length) return null;
  return <Tooltip content={`Holding the handle: ${holders.map((id) => principalOf(id).kind === 'bot' ? actorLabel(id) : principalOf(id).name).join(', ')}`} side="top">
    <span data-holders={holders.join(',')} className="inline-flex shrink-0 items-center" style={{ paddingLeft: size * 0.3 }}>
      {holders.map((id) => <span key={id} style={{ marginLeft: -size * 0.3 }}><Avatar userId={id} size={size} ring /></span>)}
    </span>
  </Tooltip>;
}

/** No one holds the handle: anyone whose role may claim it can. */
export function FreeMark() {
  return <Tooltip content="Free · no one holds the handle; claim it to prompt" side="top">
    <span data-free="" className="inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] [border-style:dashed]">Free</span>
  </Tooltip>;
}

export function HoldersOrFree({ holders, size }: { holders: readonly string[]; size?: number }) {
  return holders.length ? <HolderStack holders={holders} size={size} /> : <FreeMark />;
}

/** The users who may hold a project's workspaces: its members (Owners are members of every project). */
export function membersOf(projectId: string): readonly string[] {
  return USERS.filter((user) => visibleProjects(user.id).has(projectId)).map((user) => user.id);
}

/** A button that stays visible when refused: the reason shows on hover and, clicked, as a toast. */
export function Gated({ reason, onClick, children, variant = 'secondary', label }: { reason: string | null; onClick(): void; children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost'; label?: string }) {
  const { say } = useMock();
  const button = <Button variant={variant} size="compact" aria-label={label} aria-disabled={reason ? true : undefined} data-refused={reason ? '' : undefined}
    className={reason ? 'cursor-not-allowed opacity-45' : undefined}
    onClick={(event) => { event.stopPropagation(); if (reason) say(reason); else onClick(); }}>{children}</Button>;
  return reason ? <Tooltip content={reason} side="top">{button}</Tooltip> : button;
}

/** What the viewer may do with a workspace's handle, as compact buttons. `full` (the workspace header) adds Release
 * and Assign while they hold it. */
export function HandleActions({ row, full = false }: { row: Row; full?: boolean }) {
  useRoles();
  const api = useMock();
  const me = api.viewer.id;
  const projectId = row.workspace.projectId;
  const reason = (action: ProjectAction): string | null => why(me, projectId, action);
  const asked = api.state.requests.some((request) => request.workspaceId === row.id && request.from === me);
  const assign = <AssignMenu row={row} reason={reason('workspace.assign')} />;
  if (row.mine) return full ? <span className="flex items-center gap-1">
    {assign}
    <Button variant="ghost" size="compact" onClick={() => api.release(row.id)}>Let go</Button>
  </span> : null;
  if (!row.holders.length) return <span className="flex items-center gap-1">
    {full ? assign : null}
    <Gated reason={reason('workspace.claim')} variant="primary" onClick={() => api.claim(row.id)}><Hand width={13} height={13} strokeWidth={1.75} />Claim</Gated>
  </span>;
  const deciders = decidersOf(api.state, row.id);
  const botHeld = row.holders.some((id) => principalOf(id).kind === 'bot');
  return <span className="flex flex-wrap items-center gap-1">
    {asked ? <Tooltip content={`Your request is in ${names(deciders)}’s Inbox`} side="top"><span className="px-1 text-[11.5px] text-muted-foreground">Asked · waiting on {names(deciders)}</span></Tooltip>
      : <Gated reason={reason('workspace.ask')} onClick={() => api.ask(row.id)}>{botHeld ? `Ask ${names(deciders)} (its sponsor)` : 'Ask for the handle'}</Gated>}
    <Gated reason={reason('workspace.takeover')} variant="ghost" onClick={() => api.takeOver(row.id)}>Take over</Gated>
    {assign}
  </span>;
}

function AssignMenu({ row, reason }: { row: Row; reason: string | null }) {
  const api = useMock();
  if (reason) return <Gated reason={reason} variant="ghost" onClick={() => undefined}>Assign</Gated>;
  const candidates = membersOf(row.workspace.projectId).filter((id) => !row.holders.includes(id));
  return <span onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
    <DropdownMenu>
      <DropdownTrigger render={<Button variant="ghost" size="compact" aria-label={`Assign ${row.name}`}><UserPlus01 width={13} height={13} strokeWidth={1.75} />Assign<ChevronDown width={12} height={12} /></Button>} />
      <DropdownContent className="w-[260px]" align="end" sideOffset={4}>
        <DropdownLabel>Add a holder · they are told in their Inbox</DropdownLabel>
        {candidates.map((id, index) => <MenuItem key={id} index={index} icon={({ size }) => <Avatar userId={id} size={size} />}
          label={`${userOf(id).name} · ${projectRoleOf(id, row.workspace.projectId)?.name ?? ''}`} onSelect={() => api.assign(row.id, id)} />)}
      </DropdownContent>
    </DropdownMenu>
  </span>;
}
