import { PHASE_LABEL, PHASE_ORDER, transitiveDependents, type WorkspacePhase } from '@gitspace/protocol-workspace';
import { stackBelow } from './graph.js';

/** An open workspace as the phase rule and the list's picker read it. An unknown phase reads as Plan, as the server
 * reads it. */
export interface RuleWorkspace { id: string; name: string; phase: WorkspacePhase | null; dependsOn: readonly string[]; relatedTo: readonly string[]; stackedOn: string | null }

/** What the list chooses for a workspace: what it stacks on, what it waits on, what it is related to. */
export type PickKind = 'stack' | 'waits' | 'related';

function rank(phase: WorkspacePhase | null): number {
  return PHASE_ORDER[phase ?? 'plan'];
}

/** Why `workspace` can't move to `phase`, in the menus' short words: a member is never ahead of the open workspace it
 * is stacked on, nor that one behind a member. Null when the move keeps the phase rule. `items` are the project's open
 * workspaces. */
export function phaseRefusal(items: readonly RuleWorkspace[], workspace: RuleWorkspace, phase: WorkspacePhase): string | null {
  if (phase === workspace.phase) return null;
  const parent = items.find(item => item.id === workspace.stackedOn);
  if (parent && PHASE_ORDER[phase] > rank(parent.phase)) return `Stacked on ${parent.name}, which is in ${PHASE_LABEL[parent.phase ?? 'plan']}; move it forward first, or unstack this`;
  const ahead = items.find(item => item.stackedOn === workspace.id && rank(item.phase) > PHASE_ORDER[phase]);
  return ahead ? `${ahead.name} is in ${PHASE_LABEL[ahead.phase ?? 'plan']} and stacked on this; move it back first, or unstack it` : null;
}

/**
 * Why `row` can't be picked for `source`; null when it can. A stack never goes onto a workspace stacked on the source
 * (it would loop) nor onto one in an earlier phase (a member is never ahead of its parent); waits-on never closes a
 * cycle; the stack parent is never also a waits-on or related, nor a waits-on also related (the server keeps one).
 */
export function pickRefusal(items: readonly RuleWorkspace[], kind: PickKind, source: RuleWorkspace, row: RuleWorkspace): string | null {
  if (kind === 'stack') {
    if (stackBelow(items, source.id).some(below => below.id === row.id)) return `stacked on ${source.name}`;
    if (rank(source.phase) > rank(row.phase)) return `only in ${PHASE_LABEL[row.phase ?? 'plan']}; ${source.name} is in ${PHASE_LABEL[source.phase ?? 'plan']}`;
    return null;
  }
  if (row.id === source.stackedOn) return `${source.name} is stacked on it`;
  if (kind === 'waits') return transitiveDependents(source.id, new Map(items.map(item => [item.id, item.dependsOn]))).has(row.id) ? `waits on ${source.name}` : null;
  return source.dependsOn.includes(row.id) ? `${source.name} waits on it` : null;
}
