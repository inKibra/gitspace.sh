import { transitiveDependents } from '@gitspace/protocol-workspace';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardTitle,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TabsSubtle,
  TabsSubtleItem,
  Tooltip,
  useShape,
  type BadgeProps,
} from '@gitspace/ui';
import { AlertTriangle, XClose } from '@untitledui/icons';
import { useContext, useState, type ReactNode } from 'react';
import { EmptyState, PHASE_LABEL, workspaceStatusColor, WorkspaceStatusDot, type AgentScopeView, type WorkspaceView } from '../GitSpaceShell.js';
import { blocks, stackOf } from '../sidebar/graph.js';
import { MiniGraph } from '../sidebar/MiniGraph.js';
import { ProjectGraphsContext } from '../sidebar/project-graph.js';
import { StackChain, stackPosition, type ChainWorkspace } from '../sidebar/StackChain.js';
import { pickRefusal } from '../sidebar/stack-rules.js';
import { useRelationWriter, WorkspaceGraph, type SetWorkspaceRelations } from '../WorkspaceGraph.js';
import { WorkspacePicker } from '../WorkspacePicker.js';

export interface OverviewViewProps {
  scope: AgentScopeView;
  workspaces: readonly WorkspaceView[];
  onSelectWorkspace(workspaceId: string): void;
  onSetRelations?: SetWorkspaceRelations;
}

const FINDING_COLOR: Record<string, NonNullable<BadgeProps['color']>> = { 'dependency-archived': 'gray', 'ahead-of-parent': 'amber', cycle: 'red' };
const LABEL_KINDS = ['dependsOn', 'relatedTo'] as const;
const LABEL_NAME: Record<(typeof LABEL_KINDS)[number], string> = { dependsOn: 'Waits on', relatedTo: 'Related to' };
const NOT_STACKED = 'none';

// CardGroup injects `index` into its direct children, so the row forwards it to its Card.
function WorkspaceRow({ id, workspace, badge, onOpen, onRemove, index }: { id: string; workspace: WorkspaceView | undefined; badge?: ReactNode; onOpen: (workspaceId: string) => void; onRemove?: () => void; index?: number }) {
  const name = workspace?.name ?? id;
  return <Card size="compact" index={index} onClick={workspace ? () => onOpen(workspace.id) : undefined} label={workspace ? `Open ${workspace.name}` : undefined}>
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2">{workspace ? <WorkspaceStatusDot space={workspace} /> : null}{name}</span></CardTitle>
      <CardDescription>{workspace ? <span className="font-mono">{workspace.branch}</span> : 'Not in this project'}</CardDescription>
    </CardHeader>
    <CardContent><span className="flex flex-wrap items-center gap-1">{workspace ? <Badge variant="dot" size="compact" color="gray">{PHASE_LABEL[workspace.phase]}</Badge> : null}{badge}</span></CardContent>
    {onRemove ? <CardFooter><Tooltip content="Remove relation" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Remove ${name}`} onClick={onRemove}><XClose width={16} height={16} strokeWidth={1.5} /></Button></Tooltip></CardFooter> : null}
  </Card>;
}

function RelationList({ title, count, empty, action, children }: { title: string; count: number; empty: string; action?: ReactNode; children: ReactNode[] }) {
  return <section className="flex flex-col gap-2">
    <header className="flex items-center justify-between gap-2"><h4 className="text-caption font-medium text-muted-foreground tabular-nums">{title}{count ? ` · ${count}` : ''}</h4>{action}</header>
    {children.length ? <CardGroup orientation="inline" border="outlined" separated>{children}</CardGroup> : <p className="text-caption text-muted-foreground">{empty}</p>}
  </section>;
}

/** A group of the Relations card: its title, what its relations mean, and them. */
function RelationGroup({ title, note, action, children }: { title: string; note: string; action?: ReactNode; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-3 rounded-xl p-3 ring-1 ring-border">
    <header className="flex items-center justify-between gap-2"><h3 className="text-caption text-muted-foreground"><span className="font-medium text-foreground/80">{title}</span> · {note}</h3>{action}</header>
    {children}
  </section>;
}

function ProjectOverview({ scope, workspaces, onSelectWorkspace, onSetRelations }: OverviewViewProps) {
  const open = workspaces.filter((workspace) => workspace.projectId === scope.projectId && !workspace.closedAt);
  const waiting = open.filter((workspace) => workspace.stack.waitsOn.length).length;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex flex-col gap-1"><span className="text-caption text-muted-foreground">Project overview</span><h2 className="text-title font-semibold text-foreground">{scope.projectName}</h2><p className="text-body text-muted-foreground tabular-nums">{open.length} open workspaces{waiting ? ` · ${waiting} with waits-on` : ''}</p></header>
    {open.length ? <CardGroup columns={2} separated border="outlined">{open.map((workspace) => {
      const agents = workspace.status.agents.green + workspace.status.agents.blue + workspace.status.agents.orange + workspace.status.agents.red;
      const color = workspaceStatusColor(workspace);
      return <Card key={workspace.id} size="compact" onClick={() => onSelectWorkspace(workspace.id)} label={`Open ${workspace.name}`}>
        <CardHeader>
          <CardTitle><span className="flex items-center gap-2"><WorkspaceStatusDot space={workspace} />{workspace.name}</span></CardTitle>
          <CardDescription><span className="font-mono">{workspace.branch}</span></CardDescription>
        </CardHeader>
        <CardContent><span className="flex flex-wrap items-center gap-1">
          <Badge variant="dot" size="compact" color="gray">{PHASE_LABEL[workspace.phase]}</Badge>
          {workspace.stack.waitsOn.length ? <Badge size="compact" color="gray">waits on · {workspace.stack.waitsOn.length}</Badge> : null}
          {agents ? <Badge variant="dot" size="compact" color={color === 'dim' ? 'gray' : color}>{agents} {agents === 1 ? 'agent' : 'agents'}</Badge> : null}
        </span></CardContent>
      </Card>;
    })}</CardGroup> : <EmptyState title="No open workspaces" description="Create a workspace to start planning work in this project." />}
    <section className="flex flex-col gap-2">
      <h3 className="text-caption font-medium text-muted-foreground">Relation graph</h3>
      <WorkspaceGraph workspaces={open} onSelect={onSelectWorkspace} onSetRelations={onSetRelations} height={360} />
    </section>
  </div></ScrollArea>;
}

/** Composed notice (FLUID-GAP: the registry has no Notice/Alert); mirrors the transcript's notice chrome. A member
 * already in a later phase than its parent is only possible from before the phase rule: it is reported, never forced. */
function AheadNotice({ finding, parent, onOpen }: { finding: WorkspaceView['stack']['findings'][number]; parent: WorkspaceView | undefined; onOpen: (workspaceId: string) => void }) {
  const shape = useShape();
  return <div role="status" className={`${shape.container} flex items-start gap-3 bg-surface-3 px-3 py-2.5 shadow-surface-1`}>
    <span className="mt-0.5 shrink-0 text-warning"><AlertTriangle width={16} height={16} strokeWidth={1.5} /></span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-body font-medium text-foreground">Ahead of its parent</span>
      <span className="text-caption text-muted-foreground">{finding.message}</span>
    </span>
    {parent ? <Button variant="tertiary" size="compact" onClick={() => onOpen(parent.id)}>Open {parent.name}</Button> : null}
  </div>;
}

function WorkspaceOverview({ scope, workspaces, onSelectWorkspace, onSetRelations }: OverviewViewProps & { scope: WorkspaceView }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const graphs = useContext(ProjectGraphsContext);
  const { apply, error } = useRelationWriter(onSetRelations);
  const [addKind, setAddKind] = useState<(typeof LABEL_KINDS)[number]>('dependsOn');
  const byId: Record<string, WorkspaceView> = {};
  for (const workspace of workspaces) byId[workspace.id] = workspace;
  const others = workspaces.filter((workspace) => workspace.projectId === scope.projectId && workspace.id !== scope.id && !workspace.closedAt);
  const incoming = others.filter((workspace) => workspace.relations.relatedTo.includes(scope.id) && !scope.relations.relatedTo.includes(workspace.id)).map((workspace) => workspace.id);
  const related = [...scope.relations.relatedTo, ...incoming];
  // Anything that already waits on this workspace (transitively) would close a loop; the writer rejects it, so the picker never offers it.
  const dependsOnEdges = new Map<string, readonly string[]>();
  for (const workspace of workspaces) if (workspace.projectId === scope.projectId) dependsOnEdges.set(workspace.id, workspace.relations.dependsOn);
  const dependents = transitiveDependents(scope.id, dependsOnEdges);
  const open = workspaces.filter((workspace) => workspace.projectId === scope.projectId && !workspace.closedAt);
  const chainItems: ChainWorkspace[] = open.map((workspace) => ({ id: workspace.id, name: workspace.name, branch: workspace.branch, phase: workspace.phase, dependsOn: workspace.relations.dependsOn, stackedOn: workspace.relations.stackedOn, status: workspace, position: workspace.stack.position }));
  const rules = open.map((workspace) => ({ id: workspace.id, name: workspace.name, phase: workspace.phase, dependsOn: workspace.relations.dependsOn, relatedTo: workspace.relations.relatedTo, stackedOn: workspace.relations.stackedOn }));
  const self = rules.find((rule) => rule.id === scope.id);
  const stackSize = stackOf(chainItems, scope.id).length;
  const baseBranch = scope.stack.position?.baseBranch ?? graphs[scope.projectId]?.baseBranch ?? 'the base branch';
  const parent = scope.relations.stackedOn ? byId[scope.relations.stackedOn] : undefined;
  const position = parent ? stackPosition(scope.stack.position, parent) : null;
  const members = open.filter((workspace) => workspace.relations.stackedOn === scope.id);
  const waitedBy = blocks(chainItems, scope.id);
  const ahead = scope.stack.findings.filter((finding) => finding.code === 'ahead-of-parent');
  const otherFindings = scope.stack.findings.filter((finding) => finding.code !== 'ahead-of-parent');
  const addLabel = (id: string): void => {
    if (addKind === 'dependsOn') apply([[scope.id, { ...scope.relations, dependsOn: [...scope.relations.dependsOn, id] }]]);
    else apply([[scope.id, { ...scope.relations, relatedTo: [...scope.relations.relatedTo, id] }]]);
  };
  const removeWaitsOn = (id: string): void => {
    apply([[scope.id, { ...scope.relations, dependsOn: scope.relations.dependsOn.filter((candidate) => candidate !== id) }]]);
  };
  const removeRelated = (id: string): void => {
    const other = byId[id];
    apply([
      [scope.id, { ...scope.relations, relatedTo: scope.relations.relatedTo.filter((candidate) => candidate !== id) }],
      ...(other?.relations.relatedTo.includes(scope.id) ? [[other.id, { ...other.relations, relatedTo: other.relations.relatedTo.filter((candidate) => candidate !== scope.id) }] as const] : []),
    ]);
  };
  // Every open workspace it may stack on; one stacked on it, or in an earlier phase, is offered disabled with why.
  const stackedOnSelect = onSetRelations && self ? <Select value={scope.relations.stackedOn ?? NOT_STACKED} size="compact" onValueChange={(value) => apply([[scope.id, { ...scope.relations, stackedOn: value === NOT_STACKED ? null : value }]])}>
    <SelectTrigger variant="borderless" aria-label="Stacked on" />
    <SelectContent>
      <SelectItem index={0} value={NOT_STACKED}>Not stacked</SelectItem>
      {rules.filter((rule) => rule.id !== scope.id).map((rule, index) => {
        const why = rule.id === scope.relations.stackedOn ? null : pickRefusal(rules, 'stack', self, rule);
        return <SelectItem index={index + 1} value={rule.id} key={rule.id} disabled={why !== null}>{why ? `${rule.name} · ${why}` : rule.name}</SelectItem>;
      })}
    </SelectContent>
  </Select> : null;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex items-start justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-1"><span className="text-caption text-muted-foreground">Relations</span><h2 className="text-title font-semibold text-foreground">{scope.name}</h2><p className="text-caption text-muted-foreground tabular-nums">{parent ? `Stacked on ${parent.name}` : 'Not stacked'}{scope.stack.waitsOn.length ? ` · waits on ${scope.stack.waitsOn.length}` : ''}{scope.stack.blocks.length ? ` · blocks ${scope.stack.blocks.length}` : ''}</p></span>
    </header>
    {ahead.map((finding) => <AheadNotice key={`${finding.code}:${finding.workspaceId ?? ''}`} finding={finding} parent={finding.workspaceId ? byId[finding.workspaceId] : undefined} onOpen={onSelectWorkspace} />)}
    {scope.relations.dependsOn.length || waitedBy.length || scope.relations.stackedOn || members.length ? <section className="flex flex-col gap-2">
      <h3 className="text-caption font-medium text-muted-foreground">Relation graph</h3>
      <div className="overflow-x-auto rounded-xl bg-surface-1 py-1 ring-1 ring-border"><MiniGraph items={chainItems} open={scope.id} hovered={hovered} onHover={setHovered} onOpen={onSelectWorkspace} /></div>
    </section> : null}
    <RelationGroup title="Stack" note="merge order and branch content" action={stackedOnSelect}>
      <RelationList title="Stacked on" count={parent ? 1 : 0} empty={`Not stacked: it merges into ${baseBranch} on its own.`}>
        {parent ? [<WorkspaceRow key={parent.id} id={parent.id} workspace={parent} badge={<>{parent.closedAt ? <Badge variant="dot" size="compact" color="gray">archived</Badge> : null}{position?.short ? <Badge size="compact" color="gray">{position.short}</Badge> : null}</>} onOpen={onSelectWorkspace} onRemove={onSetRelations ? () => apply([[scope.id, { ...scope.relations, stackedOn: null }]]) : undefined} />] : []}
      </RelationList>
      <RelationList title="Stacked on this" count={members.length} empty="Nothing is stacked on this workspace.">
        {members.map((member) => <WorkspaceRow key={member.id} id={member.id} workspace={member} onOpen={onSelectWorkspace} />)}
      </RelationList>
      {stackSize > 1 ? <div className="flex flex-col gap-1.5"><h4 className="text-caption font-medium text-muted-foreground">{stackSize} workspaces, merged in this order</h4><div className="rounded-xl bg-surface-1 p-1.5 ring-1 ring-border"><StackChain items={chainItems} id={scope.id} baseBranch={baseBranch} compact={false} onOpen={onSelectWorkspace} /></div></div> : null}
    </RelationGroup>
    <RelationGroup title="Planning labels" note="they never block anything">
      {onSetRelations && others.length ? <section className="flex flex-col gap-2">
        <header className="flex items-center justify-between gap-2">
          <h4 className="text-caption font-medium text-muted-foreground">Add a label</h4>
          <TabsSubtle size="compact" idPrefix="add-relation" selectedIndex={LABEL_KINDS.indexOf(addKind)} onSelect={(index) => setAddKind(LABEL_KINDS[index] ?? 'dependsOn')} aria-label="Label kind">{LABEL_KINDS.map((kind, index) => <TabsSubtleItem key={kind} index={index} label={LABEL_NAME[kind]} />)}</TabsSubtle>
        </header>
        <WorkspacePicker workspaces={others} exclude={addKind === 'dependsOn' ? [...scope.relations.dependsOn, ...dependents, ...(scope.relations.stackedOn ? [scope.relations.stackedOn] : [])] : [...related, ...scope.relations.dependsOn, ...(scope.relations.stackedOn ? [scope.relations.stackedOn] : [])]} onPick={addLabel} label="Add a label" placeholder={`Search workspaces this ${addKind === 'dependsOn' ? 'waits on' : 'relates to'}`} limit={5} empty="Every open workspace already has this label." />
      </section> : null}
      <RelationList title="Waits on" count={scope.relations.dependsOn.length} empty="Waits on nothing.">
        {scope.relations.dependsOn.map((id) => <WorkspaceRow key={id} id={id} workspace={byId[id]} badge={byId[id]?.closedAt ? <Badge variant="dot" size="compact" color="gray">archived</Badge> : null} onOpen={onSelectWorkspace} onRemove={onSetRelations ? () => removeWaitsOn(id) : undefined} />)}
      </RelationList>
      <RelationList title="Blocks" count={waitedBy.length} empty="Nothing waits on this workspace.">
        {waitedBy.map((id) => <WorkspaceRow key={id} id={id} workspace={byId[id]} onOpen={onSelectWorkspace} />)}
      </RelationList>
      <RelationList title="Related to" count={related.length} empty="No related workspaces.">
        {related.map((id) => <WorkspaceRow key={id} id={id} workspace={byId[id]} onOpen={onSelectWorkspace} onRemove={onSetRelations ? () => removeRelated(id) : undefined} />)}
      </RelationList>
    </RelationGroup>
    {otherFindings.length ? <section className="flex flex-col gap-2">
      <h3 className="text-caption font-medium text-muted-foreground tabular-nums">Findings · {otherFindings.length}</h3>
      <ul className="flex flex-col gap-1.5">{otherFindings.map((finding, index) => <li key={`${finding.code}:${finding.workspaceId ?? index}`} className="flex items-start gap-2 text-caption text-muted-foreground"><Badge variant="dot" size="compact" color={FINDING_COLOR[finding.code] ?? 'gray'}>{finding.code}</Badge><span className="min-w-0 flex-1 pt-0.5">{finding.message}</span></li>)}</ul>
    </section> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </div></ScrollArea>;
}

export function OverviewView(props: OverviewViewProps) {
  return props.scope.kind === 'workspace' ? <WorkspaceOverview {...props} scope={props.scope} /> : <ProjectOverview {...props} />;
}
