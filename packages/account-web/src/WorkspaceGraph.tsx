import { Badge, badgeColors, useShape } from '@gitspace/ui';
import { Background, BaseEdge, Controls, getBezierPath, Handle, MarkerType, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EmptyState, PHASE_LABEL, StatusDot, type WorkspaceView } from './GitSpaceShell.js';

export type WorkspaceRelations = WorkspaceView['relations'];
export type SetWorkspaceRelations = (workspaceId: string, relations: WorkspaceRelations) => void | Promise<void>;
export interface WorkspaceGraphProps {
  workspaces: readonly WorkspaceView[];
  selectedId?: string | null;
  onSelect(workspaceId: string): void;
  /** Absent → the graph is read-only: no connecting, no edge deletion. */
  onSetRelations?: SetWorkspaceRelations;
  height: number | string;
}

type RelationKind = 'dependsOn' | 'relatedTo';
type WorkspaceNodeType = Node<{ workspace: WorkspaceView }, 'workspace'>;
type RelationEdge = Edge<{ kind: RelationKind; span: number; stacked: boolean }, 'relation'>;

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;
const COLUMN_GAP = 96;
const ROW_GAP = 24;
/** Vertical pull per skipped column so a long edge dips into the row gap instead of crossing the nodes between its ends. */
const EDGE_BOW = 80;
const HANDLE_STYLE: CSSProperties = { width: 8, height: 8, border: 'none', background: 'var(--muted-foreground)' };

/** Writes relation changes one workspace at a time and keeps the last failure for the caller to surface. */
export function useRelationWriter(onSetRelations: SetWorkspaceRelations | undefined): { apply(changes: ReadonlyArray<readonly [workspaceId: string, relations: WorkspaceRelations]>): void; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    apply: (changes) => {
      if (!onSetRelations || !changes.length) return;
      void (async () => {
        for (const [workspaceId, relations] of changes) await onSetRelations(workspaceId, relations);
        setError(null);
      })().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
    },
  };
}

/**
 * Column = dependency depth: a workspace sits one column right of the deepest
 * thing it depends on, so every edge flows left→right from dependency to
 * dependent (roots on the left, like a git graph reads). Within a column, rows
 * follow the rows of their dependencies (barycenter) to keep edges short, then
 * name, so the picture never depends on fetch order. Phase is a badge, not a
 * position. Cycles cannot be written, but a stale one is still laid out.
 */
export function layoutWorkspaces(workspaces: readonly WorkspaceView[]): Map<string, { x: number; y: number }> {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rank = (id: string): number => {
    const known = ranks.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const dependencyId of byId.get(id)!.relations.dependsOn) {
      if (byId.has(dependencyId)) depth = Math.max(depth, rank(dependencyId) + 1);
    }
    visiting.delete(id);
    ranks.set(id, depth);
    return depth;
  };
  const columns = new Map<number, WorkspaceView[]>();
  for (const workspace of [...workspaces].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const depth = rank(workspace.id);
    let column = columns.get(depth);
    if (!column) columns.set(depth, column = []);
    column.push(workspace);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const depth of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(depth)!;
    const barycenter = (workspace: WorkspaceView): number => {
      const rows = workspace.relations.dependsOn.flatMap((id) => positions.get(id)?.y ?? []);
      return rows.length ? rows.reduce((sum, y) => sum + y, 0) / rows.length : Number.POSITIVE_INFINITY;
    };
    const ordered = column.map((workspace) => ({ workspace, center: barycenter(workspace) }))
      .sort((a, b) => a.center - b.center || a.workspace.name.localeCompare(b.workspace.name) || a.workspace.id.localeCompare(b.workspace.id));
    ordered.forEach(({ workspace }, row) => positions.set(workspace.id, { x: depth * (NODE_WIDTH + COLUMN_GAP), y: row * (NODE_HEIGHT + ROW_GAP) }));
  }
  return positions;
}

/** A dependency blocks while it is open and not yet shipped — the same rule the stack validator applies. */
export function isBlocking(dependency: WorkspaceView): boolean { return !dependency.closedAt && dependency.phase !== 'ship'; }

function relationEdges(workspaces: readonly WorkspaceView[], positions: ReadonlyMap<string, { x: number; y: number }>, deletable: boolean): RelationEdge[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const column = (id: string): number => Math.round((positions.get(id)?.x ?? 0) / (NODE_WIDTH + COLUMN_GAP));
  const edges: RelationEdge[] = [];
  const related = new Set<string>();
  for (const workspace of workspaces) {
    // Edges flow from the dependency into the dependent, the same direction as onConnect (drag from a workspace to the one that builds on it).
    for (const dependencyId of workspace.relations.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      const blocking = isBlocking(dependency);
      const stacked = workspace.relations.stackedOn === dependencyId;
      const color = blocking ? badgeColors.amber : stacked ? badgeColors.blue : 'var(--muted-foreground)';
      const span = Math.abs(column(workspace.id) - column(dependencyId));
      // The stack parent is drawn heavier than an ordinary dependency; ordinary dependencies stay hairline.
      edges.push({ id: `dep:${workspace.id}:${dependencyId}`, source: dependencyId, target: workspace.id, type: 'relation', animated: blocking, deletable, data: { kind: 'dependsOn', span, stacked }, style: { stroke: color, strokeWidth: stacked ? 3 : 1.5 }, markerEnd: { type: MarkerType.ArrowClosed, color } });
    }
    for (const otherId of workspace.relations.relatedTo) {
      const other = byId.get(otherId);
      if (!other || otherId === workspace.id) continue;
      const key = [workspace.id, otherId].sort().join(':');
      if (related.has(key)) continue;
      related.add(key);
      const span = Math.abs(column(workspace.id) - column(otherId));
      edges.push({ id: `rel:${workspace.id}:${otherId}`, source: workspace.id, target: otherId, type: 'relation', deletable, data: { kind: 'relatedTo', span, stacked: false }, style: { stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '4 4' } });
    }
  }
  return edges;
}

function RelationEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data }: EdgeProps<RelationEdge>) {
  const skipped = (data?.span ?? 1) - 1;
  const path = skipped > 0
    ? `M ${sourceX},${sourceY} C ${sourceX + COLUMN_GAP},${sourceY + skipped * EDGE_BOW} ${targetX - COLUMN_GAP},${targetY + skipped * EDGE_BOW} ${targetX},${targetY}`
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })[0];
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}
const edgeTypes = { relation: RelationEdgeView };

const WorkspaceNode = memo(function WorkspaceNode({ data, selected, isConnectable }: NodeProps<WorkspaceNodeType>) {
  const shape = useShape();
  const { workspace } = data;
  const blocked = workspace.stack.blockedBy.length;
  return <div className={`${shape.container} flex flex-col gap-1.5 bg-surface-3 p-3 text-left shadow-surface-2 ${selected ? 'ring-1 ring-[color:var(--focus-ring,#6B97FF)]' : ''}`} style={{ width: NODE_WIDTH }}>
    <Handle type="target" position={Position.Left} isConnectable={isConnectable} style={HANDLE_STYLE} />
    <span className="flex min-w-0 items-center gap-2"><StatusDot color={workspace.status.primaryColor} pulse={workspace.status.primaryColor === 'green'} /><strong className="truncate text-body font-medium text-foreground">{workspace.name}</strong></span>
    <code className="truncate font-mono text-caption text-muted-foreground">{workspace.branch}</code>
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant="dot" size="compact" color="gray">{PHASE_LABEL[workspace.phase]}</Badge>
      {workspace.relations.stackedOn ? <Badge variant="dot" size="compact" color="blue">stacked</Badge> : null}
      {blocked ? <Badge size="compact" color="amber">blocked · {blocked}</Badge> : null}
    </span>
    <Handle type="source" position={Position.Right} isConnectable={isConnectable} style={HANDLE_STYLE} />
  </div>;
});
const nodeTypes = { workspace: WorkspaceNode };

export function WorkspaceGraph({ workspaces, selectedId = null, onSelect, onSetRelations, height }: WorkspaceGraphProps) {
  const editable = !!onSetRelations;
  const open = useMemo(() => workspaces.filter((workspace) => !workspace.closedAt), [workspaces]);
  const byId = useMemo(() => new Map(open.map((workspace) => [workspace.id, workspace])), [open]);
  const positions = useMemo(() => layoutWorkspaces(open), [open]);
  const computedNodes = useMemo<WorkspaceNodeType[]>(() => open.map((workspace) => ({ id: workspace.id, type: 'workspace', position: positions.get(workspace.id)!, data: { workspace }, selected: workspace.id === selectedId, deletable: false, draggable: false, sourcePosition: Position.Right, targetPosition: Position.Left })), [open, positions, selectedId]);
  const computedEdges = useMemo(() => relationEdges(open, positions, editable), [editable, open, positions]);
  const [nodes, setNodes, onNodesChange] = useNodesState(computedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(computedEdges);
  useEffect(() => setNodes(computedNodes), [computedNodes, setNodes]);
  useEffect(() => setEdges(computedEdges), [computedEdges, setEdges]);
  const { apply, error } = useRelationWriter(onSetRelations);
  const connecting = useRef(false);
  const connectionDroppedAt = useRef(0);

  // Drag source = the dependency, drop target = the workspace that builds on it.
  const connect = (connection: Connection): void => {
    const dependent = byId.get(connection.target);
    if (!dependent || connection.source === connection.target || dependent.relations.dependsOn.includes(connection.source)) return;
    apply([[dependent.id, { ...dependent.relations, dependsOn: [...dependent.relations.dependsOn, connection.source] }]]);
  };
  const removeEdges = (removed: RelationEdge[]): void => {
    // One workspace may lose several edges in a single delete; fold them before writing.
    const changes = new Map<string, WorkspaceRelations>();
    for (const edge of removed) {
      // A dependsOn edge is owned by its target (the dependent); relatedTo is symmetric.
      const pairs = edge.data?.kind === 'dependsOn' ? [[edge.target, edge.source]] as const : edge.data?.kind === 'relatedTo' ? [[edge.source, edge.target], [edge.target, edge.source]] as const : [];
      for (const [owner, other] of pairs) {
        const relations = changes.get(owner) ?? byId.get(owner)?.relations;
        if (!relations) continue;
        // Dropping the parent dependency also unstacks; `stackedOn` must stay inside `dependsOn`.
        if (edge.data?.kind === 'dependsOn') changes.set(owner, { ...relations, dependsOn: relations.dependsOn.filter((id) => id !== other), stackedOn: relations.stackedOn === other ? null : relations.stackedOn });
        else if (relations.relatedTo.includes(other)) changes.set(owner, { ...relations, relatedTo: relations.relatedTo.filter((id) => id !== other) });
      }
    }
    apply([...changes]);
  };

  if (!open.length) return <div style={{ height }}><EmptyState title="No open workspaces" description="Create a workspace to start mapping dependencies." /></div>;
  return <div className="flex flex-col gap-2" style={{ height }}>
    {/* FLUID-GAP: node graph canvas — @xyflow/react draws the canvas, edges, and controls; node chrome is composed from Fluid parts above. */}
    <div className="min-h-0 flex-1 bg-surface-1">
      <ReactFlow<WorkspaceNodeType, RelationEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        // Dropping a connection onto a node also delivers a click to that node; neither that nor a click on a handle opens the workspace.
        onConnectStart={() => { connecting.current = true; }}
        onConnectEnd={() => { connecting.current = false; connectionDroppedAt.current = Date.now(); }}
        onNodeClick={(event, node) => {
          if (connecting.current || Date.now() - connectionDroppedAt.current < 300) return;
          if (event.target instanceof Element && event.target.closest('.react-flow__handle')) return;
          onSelect(node.id);
        }}
        onConnect={editable ? connect : undefined}
        onEdgesDelete={editable ? removeEdges : undefined}
        nodesDraggable={false}
        nodesConnectable={editable}
        edgesFocusable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background gap={20} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
    {editable ? <p className="text-caption text-muted-foreground">Drag from a workspace to the one that builds on it. Select an edge and press Delete to remove it. Heavy edges are stack parents.</p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </div>;
}
