export interface WorkspaceRelations {
  dependsOn: string[];
  relatedTo: string[];
  /** The single parent this workspace's branch is stacked on; always also present in `dependsOn`. */
  stackedOn: string | null;
}

export interface WorkspaceRelationsInput {
  dependsOn: readonly string[];
  relatedTo: readonly string[];
  stackedOn: string | null;
}

export type WorkspacePhase = 'plan' | 'code' | 'review' | 'ship';

/** Phase ordering used by the phase ceiling: a workspace may not be further along than any dependency. */
export const PHASE_ORDER: Record<WorkspacePhase, number> = { plan: 0, code: 1, review: 2, ship: 3 };

export interface StackFinding {
  code: string;
  message: string;
  workspaceId: string | null;
}

export interface WorkspaceStack {
  blockedBy: string[];
  blocking: string[];
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
  /** Dependency cycles keyed by member id; each value is the ordered member list closing back on itself. */
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
  return { blockedBy: [], blocking: [], findings: [] };
}

/**
 * Canonical relation shape: no self references, no duplicates, `dependsOn` wins over `relatedTo`,
 * and `stackedOn` is folded into `dependsOn` so the stack parent is always a dependency.
 */
export function normalizeRelations(selfId: string, input: WorkspaceRelationsInput): WorkspaceRelations {
  const stackedOn = input.stackedOn && input.stackedOn !== selfId ? input.stackedOn : null;
  const dependsOn = unique([...input.dependsOn, ...(stackedOn ? [stackedOn] : [])].filter((id) => id !== selfId));
  const depends = new Set(dependsOn);
  return { dependsOn, relatedTo: unique(input.relatedTo.filter((id) => id !== selfId && !depends.has(id))), stackedOn };
}

export interface PhaseCarrier {
  id: string;
  name?: string;
  phase: WorkspacePhase;
}

/** The first dependency whose phase is behind `phase`, or null when `phase` respects the ceiling. */
export function phaseCeilingViolation<T extends PhaseCarrier>(phase: WorkspacePhase, dependencies: readonly T[]): T | null {
  return dependencies.find((dependency) => PHASE_ORDER[dependency.phase] < PHASE_ORDER[phase]) ?? null;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function label(workspace: StackWorkspace): string {
  return workspace.name ?? workspace.id;
}

function isOpen(workspace: StackWorkspace): boolean {
  return workspace.closedAt === null;
}

/**
 * Stack validations as code. Each check inspects one workspace against the whole graph and
 * returns findings; `dependency-open` findings are the ones that block.
 */
export const stackChecks: readonly StackCheck[] = [
  {
    name: 'dependency-open',
    run(workspace, graph) {
      if (!isOpen(workspace)) return [];
      const findings: StackFinding[] = [];
      for (const id of workspace.relations.dependsOn) {
        const dependency = graph.byId.get(id);
        if (!dependency || !isOpen(dependency) || dependency.phase === 'ship') continue;
        findings.push({
          code: 'dependency-open',
          message: `Blocked by ${label(dependency)} (${dependency.phase})`,
          workspaceId: dependency.id,
        });
      }
      return findings;
    },
  },
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
          message: `${label(dependency)} was archived while this workspace is still open`,
          workspaceId: dependency.id,
        });
      }
      return findings;
    },
  },
  {
    name: 'phase-ceiling',
    run(workspace, graph) {
      if (!isOpen(workspace)) return [];
      const findings: StackFinding[] = [];
      for (const id of workspace.relations.dependsOn) {
        const dependency = graph.byId.get(id);
        if (!dependency || PHASE_ORDER[dependency.phase] >= PHASE_ORDER[workspace.phase]) continue;
        findings.push({
          code: 'phase-ceiling',
          message: `Ahead of ${label(dependency)} (${dependency.phase}); a workspace cannot pass the phase of what it depends on`,
          workspaceId: dependency.id,
        });
      }
      return findings;
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
        message: `Dependency cycle: ${ordered.map((id) => label(graph.byId.get(id)!)).join(' → ')}`,
        workspaceId: null,
      }];
    },
  },
];

export function buildStackGraph(workspaces: readonly StackWorkspace[]): StackGraph {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  return { byId, cycles: findDependencyCycles(byId) };
}

export function validateStack(workspaces: readonly StackWorkspace[], checks: readonly StackCheck[] = stackChecks): Map<string, WorkspaceStack> {
  const graph = buildStackGraph(workspaces);
  const stacks = new Map<string, WorkspaceStack>();
  for (const workspace of workspaces) {
    const findings = checks.flatMap((check) => check.run(workspace, graph));
    const blockedBy = unique(findings.flatMap((finding) => finding.code === 'dependency-open' && finding.workspaceId ? [finding.workspaceId] : []));
    stacks.set(workspace.id, { blockedBy, blocking: [], findings });
  }
  for (const [id, stack] of stacks) {
    for (const blocker of stack.blockedBy) stacks.get(blocker)?.blocking.push(id);
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
