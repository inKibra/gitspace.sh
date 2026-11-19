import { z } from 'zod';
import { WorkspaceDomainError } from './errors.js';
import { dependencyCycle } from './dependency-graph.js';

const relationIdSchema = z.string().min(1).max(160);
/**
 * A workspace's relations. `stackedOn` is merge order and branch content: the workspace merges after it and builds on
 * its branch. `dependsOn` (waits on) and `relatedTo` are planning labels: they never block a stack, a phase move or a
 * merge.
 */
export const WorkspaceRelationsSchema = z.object({
  dependsOn: z.array(relationIdSchema),
  relatedTo: z.array(relationIdSchema),
  stackedOn: relationIdSchema.nullable(),
});
export type WorkspaceRelations = z.infer<typeof WorkspaceRelationsSchema>;

export interface WorkspaceRelationsInput {
  dependsOn: readonly string[];
  relatedTo: readonly string[];
  stackedOn: string | null;
}

export const WorkspacePhaseSchema = z.enum(['plan', 'code', 'review', 'ship']);
export type WorkspacePhase = z.infer<typeof WorkspacePhaseSchema>;

/** Phase order for the phase rule: a workspace is never in a later phase than the workspace it is stacked on. */
export const PHASE_ORDER: Record<WorkspacePhase, number> = { plan: 0, code: 1, review: 2, ship: 3 };
export const PHASE_LABEL: Record<WorkspacePhase, string> = { plan: 'Plan', code: 'Code', review: 'Review', ship: 'Ship' };
/** The phase rule's key sentence, as every agent text about stacks states it. */
export const PHASE_RULE = 'A workspace is never in a later phase than the workspace it is stacked on (Plan < Code < Review < Ship)';

export interface StackFinding {
  code: string;
  message: string;
  workspaceId: string | null;
}

/** What the project view says of a workspace's relations: the open workspaces it waits on and the open ones waiting on
 * it (planning labels, which never block anything), and what is wrong with its relations. */
export interface WorkspaceStack {
  waitsOn: string[];
  blocks: string[];
  findings: StackFinding[];
}

export interface StackWorkspace {
  id: string;
  name?: string;
  phase: WorkspacePhase;
  closedAt: string | Date | null;
  relations: WorkspaceRelations;
}

export interface StackGraph {
  byId: Map<string, StackWorkspace>;
  /** Waits-on cycles keyed by member id; each value is the ordered member list closing back on itself. */
  cycles: Map<string, string[]>;
}

export interface StackCheck {
  name: string;
  run(workspace: StackWorkspace, graph: StackGraph): StackFinding[];
}

export function emptyRelations(): WorkspaceRelations {
  return { dependsOn: [], relatedTo: [], stackedOn: null };
}

export function emptyStack(): WorkspaceStack {
  return { waitsOn: [], blocks: [], findings: [] };
}

/**
 * Canonical relation shape: no self references, no duplicates, the stack parent never also a waits-on (stacking is
 * merge order, not a planning label), and `dependsOn` and `stackedOn` win over `relatedTo`. Relations stored when
 * stacking also added a waits-on read back without it.
 */
export function normalizeRelations(selfId: string, input: WorkspaceRelationsInput): WorkspaceRelations {
  const stackedOn = input.stackedOn && input.stackedOn !== selfId ? input.stackedOn : null;
  const dependsOn = unique(input.dependsOn.filter((id) => id !== selfId && id !== stackedOn));
  const taken = new Set([...dependsOn, ...(stackedOn ? [stackedOn] : [])]);
  return { dependsOn, relatedTo: unique(input.relatedTo.filter((id) => id !== selfId && !taken.has(id))), stackedOn };
}

/** A workspace as stack order reads it: the workspace it is stacked on, null for none. */
export interface StackOrderItem { id: string; stackedOn: string | null }

/** Everything stacked on `id`, depth-first: each branch of a fork fully before the next, in list order. */
export function stackBelow<T extends StackOrderItem>(items: readonly T[], id: string, seen: ReadonlySet<string> = new Set([id])): readonly T[] {
  return items.filter(item => item.stackedOn === id && !seen.has(item.id)).flatMap(child => {
    const visited = new Set([...seen, child.id]);
    return [child, ...stackBelow(items, child.id, visited)];
  });
}

/** Every workspace stacked on nothing listed, each followed by its whole stack (depth-first, a fork's branches one after
 * another): the sidebar's order. `stacked` entries belong to the stack of the root before them. */
export function stackTree<T extends StackOrderItem>(items: readonly T[]): readonly { item: T; stacked: boolean }[] {
  const listed = new Set(items.map(item => item.id));
  const roots = items.filter(item => !item.stackedOn || !listed.has(item.stackedOn));
  const placed = roots.flatMap(root => [{ item: root, stacked: false }, ...stackBelow(items, root.id).map(item => ({ item, stacked: true }))]);
  // A stack whose parents form a loop has no root; its rows still show, at the first level.
  const shown = new Set(placed.map(entry => entry.item.id));
  return [...placed, ...items.filter(item => !shown.has(item.id)).map(item => ({ item, stacked: false }))];
}

export interface PhaseCarrier {
  id: string;
  name?: string;
  phase: WorkspacePhase;
}

function label(workspace: { id: string; name?: string }): string {
  return workspace.name ?? workspace.id;
}

/** Why `workspace` can't move to `phase`: it would be ahead of the workspace it is stacked on (`parent`), or behind one
 * stacked on it (`members`). Null when the move keeps the phase rule. */
export function phaseMoveRefusal(workspace: { id: string; name?: string }, phase: WorkspacePhase, parent: PhaseCarrier | null, members: readonly PhaseCarrier[]): string | null {
  if (parent && PHASE_ORDER[phase] > PHASE_ORDER[parent.phase]) {
    return `${label(workspace)} can't move to ${PHASE_LABEL[phase]}: it is stacked on ${label(parent)}, which is in ${PHASE_LABEL[parent.phase]}. Move ${label(parent)} forward first, or unstack ${label(workspace)}.`;
  }
  const ahead = members.find((member) => PHASE_ORDER[member.phase] > PHASE_ORDER[phase]);
  return ahead ? `${label(workspace)} can't move to ${PHASE_LABEL[phase]}: ${label(ahead)} is in ${PHASE_LABEL[ahead.phase]} and stacked on it. Move ${label(ahead)} back first, or unstack it.` : null;
}

/** Why `workspace` can't stack on `parent`: it is further along. Null when it can. */
export function stackOnRefusal(workspace: PhaseCarrier, parent: PhaseCarrier): string | null {
  if (PHASE_ORDER[workspace.phase] <= PHASE_ORDER[parent.phase]) return null;
  return `${label(workspace)} can't stack on ${label(parent)}: ${label(workspace)} is in ${PHASE_LABEL[workspace.phase]} and ${label(parent)} only in ${PHASE_LABEL[parent.phase]}. Move ${label(parent)} forward first, or move ${label(workspace)} back.`;
}

/** Refuses a phase move that breaks the phase rule, with the reason naming the workspaces. */
export function assertPhaseMove(workspace: { id: string; name?: string }, phase: WorkspacePhase, parent: PhaseCarrier | null, members: readonly PhaseCarrier[]): void {
  const refusal = phaseMoveRefusal(workspace, phase, parent, members);
  if (refusal) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_PHASE_RULE', message: refusal, context: { workspaceId: workspace.id, phase } });
}

/**
 * Validates and normalizes a relation write. A new `stackedOn` must not close a stack loop and must keep the phase rule
 * (the workspace no further along than its new parent); an unchanged one is kept as it is, even one that breaks the
 * rule (only possible from before it). Waits-on must not close a cycle. Planning labels never weigh phases.
 */
export function resolveWorkspaceRelations(
  workspaceId: string,
  input: WorkspaceRelationsInput,
  workspaces: readonly PhaseCarrier[],
  existing: ReadonlyMap<string, WorkspaceRelations>,
): WorkspaceRelations {
  const known = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const self = known.get(workspaceId);
  if (!self) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_NOT_FOUND', message: `Workspace ${workspaceId} does not exist`, context: { workspaceId } });
  const parsed = WorkspaceRelationsSchema.safeParse(input);
  if (!parsed.success) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_RELATIONS_INVALID', message: parsed.error.message, context: { workspaceId } });
  if (parsed.data.dependsOn.includes(workspaceId) || parsed.data.relatedTo.includes(workspaceId) || parsed.data.stackedOn === workspaceId) {
    throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_RELATIONS_INVALID', message: `Workspace ${workspaceId} cannot relate to itself`, context: { workspaceId } });
  }
  const relations = normalizeRelations(workspaceId, parsed.data);
  for (const relatedId of [...relations.dependsOn, ...relations.relatedTo, ...(relations.stackedOn ? [relations.stackedOn] : [])]) {
    if (!known.has(relatedId)) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_NOT_FOUND', message: `Workspace ${relatedId} does not exist in this project`, context: { workspaceId, relatedId } });
  }
  const parent = relations.stackedOn ? known.get(relations.stackedOn) : undefined;
  if (parent && relations.stackedOn !== (existing.get(workspaceId)?.stackedOn ?? null)) {
    const seen = new Set<string>();
    for (let id: string | null = parent.id; id !== null && !seen.has(id); id = existing.get(id)?.stackedOn ?? null) {
      if (id === workspaceId) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_STACK_CYCLE', message: `${label(self)} can't stack on ${label(parent)}: ${label(parent)} is stacked on ${label(self)}`, context: { workspaceId, stackedOn: parent.id } });
      seen.add(id);
    }
    const refusal = stackOnRefusal(self, parent);
    if (refusal) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_PHASE_RULE', message: refusal, context: { workspaceId, stackedOn: parent.id } });
  }
  if (relations.dependsOn.length > 0) {
    const edges = new Map<string, readonly string[]>();
    for (const [id, relation] of existing) edges.set(id, relation.dependsOn);
    const cycle = dependencyCycle(workspaceId, relations.dependsOn, edges);
    if (cycle) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_DEPENDENCY_CYCLE', message: `Waits-on cycle: ${cycle.map((id) => label(known.get(id) ?? { id })).join(' → ')}`, context: { workspaceId, cycle: cycle.join(',') } });
  }
  return relations;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function isOpen(workspace: StackWorkspace): boolean {
  return workspace.closedAt === null;
}

/** Relation checks as code. Each inspects one workspace against the whole graph and returns findings; none blocks. */
export const stackChecks: readonly StackCheck[] = [
  {
    name: 'dependency-archived',
    run(workspace, graph) {
      if (!isOpen(workspace)) return [];
      const findings: StackFinding[] = [];
      for (const id of workspace.relations.dependsOn) {
        const dependency = graph.byId.get(id);
        if (!dependency || isOpen(dependency)) continue;
        findings.push({
          code: 'dependency-archived',
          message: `Waits on ${label(dependency)}, which was archived`,
          workspaceId: dependency.id,
        });
      }
      return findings;
    },
  },
  {
    /** Only possible from before the phase rule: it stays, reported, and nothing is forced. */
    name: 'ahead-of-parent',
    run(workspace, graph) {
      const parent = workspace.relations.stackedOn ? graph.byId.get(workspace.relations.stackedOn) : undefined;
      if (!isOpen(workspace) || !parent || !isOpen(parent) || PHASE_ORDER[workspace.phase] <= PHASE_ORDER[parent.phase]) return [];
      return [{
        code: 'ahead-of-parent',
        message: `Ahead of its parent: in ${PHASE_LABEL[workspace.phase]} while ${label(parent)}, which it is stacked on, is in ${PHASE_LABEL[parent.phase]}`,
        workspaceId: parent.id,
      }];
    },
  },
  {
    name: 'cycle',
    run(workspace, graph) {
      const members = graph.cycles.get(workspace.id);
      if (!members) return [];
      const start = members.indexOf(workspace.id);
      const ordered = [...members.slice(start), ...members.slice(0, start), workspace.id];
      return [{
        code: 'cycle',
        message: `Waits-on cycle: ${ordered.map((id) => label(graph.byId.get(id) ?? { id })).join(' → ')}`,
        workspaceId: null,
      }];
    },
  },
];

export function buildStackGraph(workspaces: readonly StackWorkspace[]): StackGraph {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  return { byId, cycles: findDependencyCycles(byId) };
}

/** Each workspace's open waits-on, the open workspaces waiting on it, and its findings. */
export function validateStack(workspaces: readonly StackWorkspace[], checks: readonly StackCheck[] = stackChecks): Map<string, WorkspaceStack> {
  const graph = buildStackGraph(workspaces);
  const stacks = new Map<string, WorkspaceStack>();
  for (const workspace of workspaces) {
    const findings = checks.flatMap((check) => check.run(workspace, graph));
    const waitsOn = isOpen(workspace) ? workspace.relations.dependsOn.filter((id) => {
      const dependency = graph.byId.get(id);
      return dependency !== undefined && isOpen(dependency);
    }) : [];
    stacks.set(workspace.id, { waitsOn, blocks: [], findings });
  }
  for (const [id, stack] of stacks) {
    for (const awaited of stack.waitsOn) stacks.get(awaited)?.blocks.push(id);
  }
  return stacks;
}

/** Tarjan's strongly connected components over `dependsOn`; components of size > 1 (or self loops) are cycles. */
function findDependencyCycles(byId: Map<string, StackWorkspace>): Map<string, string[]> {
  const cycles = new Map<string, string[]>();
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;

  const connect = (id: string): void => {
    index.set(id, counter);
    lowLink.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    const workspace = byId.get(id)!;
    for (const next of workspace.relations.dependsOn) {
      if (!byId.has(next)) continue;
      if (!index.has(next)) {
        connect(next);
        lowLink.set(id, Math.min(lowLink.get(id)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(id, Math.min(lowLink.get(id)!, index.get(next)!));
      }
    }
    if (lowLink.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    const selfLoop = component.length === 1 && workspace.relations.dependsOn.includes(id);
    if (component.length === 1 && !selfLoop) return;
    component.reverse();
    for (const memberId of component) cycles.set(memberId, component);
  };

  for (const id of byId.keys()) {
    if (!index.has(id)) connect(id);
  }
  return cycles;
}
