import { transitiveDependents, type StackStatus } from '@gitspace/protocol';
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
  InputCopy,
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
import { useState, type ReactNode } from 'react';
import { EmptyState, PHASE_LABEL, StatusDot, type AgentScopeView, type WorkspaceView } from '../GitSpaceShell.js';
import { isBlocking, useRelationWriter, WorkspaceGraph, type SetWorkspaceRelations } from '../WorkspaceGraph.js';
import { WorkspacePicker } from '../WorkspacePicker.js';

export interface OverviewViewProps {
  scope: AgentScopeView;
  workspaces: readonly WorkspaceView[];
  onSelectWorkspace(workspaceId: string): void;
  onSetRelations?: SetWorkspaceRelations;
  /** Git position against the `stackedOn` parent; null while loading or when the holder cannot compute it. */
  stackStatus?: StackStatus | null;
}

const FINDING_COLOR: Record<string, NonNullable<BadgeProps['color']>> = { 'dependency-open': 'amber', 'dependency-archived': 'gray', 'phase-ceiling': 'red', cycle: 'red' };
const RELATION_KINDS = ['dependsOn', 'relatedTo'] as const;
const RELATION_LABEL: Record<(typeof RELATION_KINDS)[number], string> = { dependsOn: 'Depends on', relatedTo: 'Related to' };
const NOT_STACKED = 'none';

// CardGroup injects `index` into its direct children, so the row forwards it to its Card.
function WorkspaceRow({ id, workspace, badge, onOpen, onRemove, index }: { id: string; workspace: WorkspaceView | undefined; badge?: ReactNode; onOpen: (workspaceId: string) => void; onRemove?: () => void; index?: number }) {
  const name = workspace?.name ?? id;
  return <Card size="compact" index={index} onClick={workspace ? () => onOpen(workspace.id) : undefined} label={workspace ? `Open ${workspace.name}` : undefined}>
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2">{workspace ? <StatusDot color={workspace.status.primaryColor} pulse={workspace.status.primaryColor === 'green'} /> : null}{name}</span></CardTitle>
      <CardDescription>{workspace ? <span className="font-mono">{workspace.branch}</span> : 'Not in this project'}</CardDescription>
    </CardHeader>
    <CardContent><span className="flex flex-wrap items-center gap-1">{workspace ? <Badge variant="dot" size="compact" color="gray">{PHASE_LABEL[workspace.phase]}</Badge> : null}{badge}</span></CardContent>
    {onRemove ? <CardFooter><Tooltip content="Remove relation" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Remove ${name}`} onClick={onRemove}><XClose width={16} height={16} strokeWidth={1.5} /></Button></Tooltip></CardFooter> : null}
  </Card>;
}

function RelationList({ title, count, empty, action, children }: { title: string; count: number; empty: string; action?: ReactNode; children: ReactNode[] }) {
  return <section className="flex flex-col gap-2">
    <header className="flex items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground tabular-nums">{title}{count ? ` · ${count}` : ''}</h3>{action}</header>
    {children.length ? <CardGroup orientation="inline" border="outlined" separated>{children}</CardGroup> : <p className="text-caption text-muted-foreground">{empty}</p>}
  </section>;
}

function ProjectOverview({ scope, workspaces, onSelectWorkspace, onSetRelations }: OverviewViewProps) {
  const open = workspaces.filter((workspace) => workspace.projectId === scope.projectId && !workspace.closedAt);
  const blocked = open.filter((workspace) => workspace.stack.blockedBy.length).length;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex flex-col gap-1"><span className="text-caption text-muted-foreground">Project overview</span><h2 className="text-title font-semibold text-foreground">{scope.projectName}</h2><p className="text-body text-muted-foreground tabular-nums">{open.length} open workspaces{blocked ? ` · ${blocked} blocked` : ''}</p></header>
    {open.length ? <CardGroup columns={2} separated border="outlined">{open.map((workspace) => {
      const agents = workspace.status.agents.green + workspace.status.agents.blue + workspace.status.agents.orange + workspace.status.agents.red;
      return <Card key={workspace.id} size="compact" onClick={() => onSelectWorkspace(workspace.id)} label={`Open ${workspace.name}`}>
        <CardHeader>
          <CardTitle><span className="flex items-center gap-2"><StatusDot color={workspace.status.primaryColor} pulse={workspace.status.primaryColor === 'green'} />{workspace.name}</span></CardTitle>
          <CardDescription><span className="font-mono">{workspace.branch}</span></CardDescription>
        </CardHeader>
        <CardContent><span className="flex flex-wrap items-center gap-1">
          <Badge variant="dot" size="compact" color="gray">{PHASE_LABEL[workspace.phase]}</Badge>
          {workspace.stack.blockedBy.length ? <Badge size="compact" color="amber">blocked · {workspace.stack.blockedBy.length}</Badge> : null}
          {agents ? <Badge variant="dot" size="compact" color={workspace.status.primaryColor === 'dim' ? 'gray' : workspace.status.primaryColor}>{agents} {agents === 1 ? 'agent' : 'agents'}</Badge> : null}
        </span></CardContent>
      </Card>;
    })}</CardGroup> : <EmptyState title="No open workspaces" description="Create a workspace to start planning work in this project." />}
    <section className="flex flex-col gap-2">
      <h3 className="text-caption font-medium text-muted-foreground">Dependency graph</h3>
      <WorkspaceGraph workspaces={open} onSelect={onSelectWorkspace} onSetRelations={onSetRelations} height={360} />
    </section>
  </div></ScrollArea>;
}

/** Composed notice (FLUID-GAP: the registry has no Notice/Alert); mirrors the transcript's notice chrome. */
function CeilingNotice({ finding, parent, onOpen }: { finding: WorkspaceView['stack']['findings'][number]; parent: WorkspaceView | undefined; onOpen: (workspaceId: string) => void }) {
  const shape = useShape();
  return <div role="status" className={`${shape.container} flex items-start gap-3 bg-surface-3 px-3 py-2.5 shadow-surface-1`}>
    <span className="mt-0.5 shrink-0 text-destructive"><AlertTriangle width={16} height={16} strokeWidth={1.5} /></span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-body font-medium text-foreground">Phase ceiling</span>
      <span className="text-caption text-muted-foreground">{finding.message}</span>
    </span>
    {parent ? <Button variant="tertiary" size="compact" onClick={() => onOpen(parent.id)}>Open {parent.name}</Button> : null}
  </div>;
}

function StackStatusLine({ status }: { status: StackStatus }) {
  const summary = status.parentMerged === 'merged'
    ? { color: 'green' as const, text: `Parent merged into ${status.baseBranch}` }
    : status.parentMerged === 'unknown'
      ? { color: 'gray' as const, text: 'Parent position unknown' }
      : status.parentAhead > 0
        ? { color: 'amber' as const, text: `Parent is ${status.parentAhead} ${status.parentAhead === 1 ? 'commit' : 'commits'} ahead` }
        : { color: 'green' as const, text: 'Up to date with the parent' };
  return <div className="flex flex-col gap-2">
    <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
      <Badge variant="dot" size="compact" color={summary.color}>{summary.text}</Badge>
      {status.parentBranch ? <span className="font-mono">{status.parentBranch}</span> : null}
      {status.mergeBase ? <span className="font-mono">base {status.mergeBase.slice(0, 10)}</span> : null}
    </span>
    {status.instruction ? <InputCopy label="Agent instruction" value={status.instruction} size="compact" /> : null}
  </div>;
}

function WorkspaceOverview({ scope, workspaces, onSelectWorkspace, onSetRelations, stackStatus = null }: OverviewViewProps & { scope: WorkspaceView }) {
  const { apply, error } = useRelationWriter(onSetRelations);
  const [addKind, setAddKind] = useState<(typeof RELATION_KINDS)[number]>('dependsOn');
  const byId: Record<string, WorkspaceView> = {};
  for (const workspace of workspaces) byId[workspace.id] = workspace;
  const others = workspaces.filter((workspace) => workspace.projectId === scope.projectId && workspace.id !== scope.id && !workspace.closedAt);
  const incoming = others.filter((workspace) => workspace.relations.relatedTo.includes(scope.id) && !scope.relations.relatedTo.includes(workspace.id)).map((workspace) => workspace.id);
  const related = [...scope.relations.relatedTo, ...incoming];
  // Anything that already depends on this workspace (transitively) would close a loop; the writer rejects it, so the picker never offers it.
  const dependsOnEdges = new Map<string, readonly string[]>();
  for (const workspace of workspaces) if (workspace.projectId === scope.projectId) dependsOnEdges.set(workspace.id, workspace.relations.dependsOn);
  const dependents = transitiveDependents(scope.id, dependsOnEdges);
  const parent = scope.relations.stackedOn ? byId[scope.relations.stackedOn] : undefined;
  const ceilings = scope.stack.findings.filter((finding) => finding.code === 'phase-ceiling');
  const otherFindings = scope.stack.findings.filter((finding) => finding.code !== 'phase-ceiling');
  const addRelation = (id: string): void => {
    if (addKind === 'dependsOn') apply([[scope.id, { ...scope.relations, dependsOn: [...scope.relations.dependsOn, id] }]]);
    else apply([[scope.id, { ...scope.relations, relatedTo: [...scope.relations.relatedTo, id] }]]);
  };
  const removeDependency = (id: string): void => {
    apply([[scope.id, { ...scope.relations, dependsOn: scope.relations.dependsOn.filter((candidate) => candidate !== id), stackedOn: scope.relations.stackedOn === id ? null : scope.relations.stackedOn }]]);
  };
  const removeRelated = (id: string): void => {
    const other = byId[id];
    apply([
      [scope.id, { ...scope.relations, relatedTo: scope.relations.relatedTo.filter((candidate) => candidate !== id) }],
      ...(other?.relations.relatedTo.includes(scope.id) ? [[other.id, { ...other.relations, relatedTo: other.relations.relatedTo.filter((candidate) => candidate !== scope.id) }] as const] : []),
    ]);
  };
  const stackedOnSelect = onSetRelations && scope.relations.dependsOn.length ? <Select value={scope.relations.stackedOn ?? NOT_STACKED} size="compact" onValueChange={(value) => apply([[scope.id, { ...scope.relations, stackedOn: value === NOT_STACKED ? null : value }]])}>
    <SelectTrigger variant="borderless" aria-label="Stacked on" />
    <SelectContent>
      <SelectItem index={0} value={NOT_STACKED}>Not stacked</SelectItem>
      {scope.relations.dependsOn.map((id, index) => <SelectItem index={index + 1} value={id} key={id}>{byId[id]?.name ?? id}</SelectItem>)}
    </SelectContent>
  </Select> : null;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex items-start justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-1"><span className="text-caption text-muted-foreground">Workspace stack</span><h2 className="text-title font-semibold text-foreground">{scope.name}</h2><p className="text-caption text-muted-foreground tabular-nums">{scope.stack.blockedBy.length ? `Blocked by ${scope.stack.blockedBy.length}` : 'Not blocked'}{scope.stack.blocking.length ? ` · blocking ${scope.stack.blocking.length}` : ''}</p></span>
    </header>
    {ceilings.map((finding) => <CeilingNotice key={`${finding.code}:${finding.workspaceId ?? ''}`} finding={finding} parent={finding.workspaceId ? byId[finding.workspaceId] : undefined} onOpen={onSelectWorkspace} />)}
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground">Stack</h3>{stackedOnSelect}</header>
      <CardGroup border="outlined" proximityHover={false}>
        {scope.relations.stackedOn ? <WorkspaceRow id={scope.relations.stackedOn} workspace={parent} badge={<Badge variant="dot" size="compact" color="blue">parent</Badge>} onOpen={onSelectWorkspace} /> : null}
        <Card size="compact" selected>
          <CardHeader>
            <CardTitle><span className="flex items-center gap-2"><StatusDot color={scope.status.primaryColor} pulse={scope.status.primaryColor === 'green'} />{scope.name}</span></CardTitle>
            <CardDescription><span className="font-mono">{scope.branch}</span></CardDescription>
          </CardHeader>
          <CardContent><span className="flex flex-wrap items-center gap-1"><Badge variant="dot" size="compact" color="gray">{PHASE_LABEL[scope.phase]}</Badge><Badge size="compact" color="gray">{scope.relations.stackedOn ? 'this workspace' : 'not stacked'}</Badge></span></CardContent>
        </Card>
        {scope.stack.blocking.map((id) => <WorkspaceRow key={id} id={id} workspace={byId[id]} badge={<Badge variant="dot" size="compact" color={byId[id]?.relations.stackedOn === scope.id ? 'blue' : 'amber'}>{byId[id]?.relations.stackedOn === scope.id ? 'stacked child' : 'waiting'}</Badge>} onOpen={onSelectWorkspace} />)}
      </CardGroup>
      {scope.relations.stackedOn && stackStatus?.parentId === scope.relations.stackedOn ? <StackStatusLine status={stackStatus} /> : null}
    </section>
    {onSetRelations && others.length ? <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-caption font-medium text-muted-foreground">Add relation</h3>
        <TabsSubtle size="compact" idPrefix="add-relation" selectedIndex={RELATION_KINDS.indexOf(addKind)} onSelect={(index) => setAddKind(RELATION_KINDS[index] ?? 'dependsOn')} aria-label="Relation kind">{RELATION_KINDS.map((kind, index) => <TabsSubtleItem key={kind} index={index} label={RELATION_LABEL[kind]} />)}</TabsSubtle>
      </header>
      <WorkspacePicker workspaces={others} exclude={addKind === 'dependsOn' ? [...scope.relations.dependsOn, ...dependents] : [...related, ...scope.relations.dependsOn]} onPick={addRelation} label="Add relation" placeholder={`Search workspaces this ${addKind === 'dependsOn' ? 'depends on' : 'relates to'}`} limit={5} empty="Every open workspace is already related." />
    </section> : null}
    <RelationList title="Blocked by" count={scope.stack.blockedBy.length} empty="No dependencies. Add one to sequence this workspace after another.">
      {scope.relations.dependsOn.map((id) => {
        const dependency = byId[id];
        const badge = scope.stack.blockedBy.includes(id) ? <Badge size="compact" color="amber">blocking</Badge> : dependency?.closedAt ? <Badge variant="dot" size="compact" color="gray">archived</Badge> : dependency && !isBlocking(dependency) ? <Badge variant="dot" size="compact" color="green">shipped</Badge> : null;
        return <WorkspaceRow key={id} id={id} workspace={dependency} badge={badge} onOpen={onSelectWorkspace} onRemove={onSetRelations ? () => removeDependency(id) : undefined} />;
      })}
    </RelationList>
    <RelationList title="Blocking" count={scope.stack.blocking.length} empty="Nothing waits on this workspace.">
      {scope.stack.blocking.map((id) => <WorkspaceRow key={id} id={id} workspace={byId[id]} badge={<Badge size="compact" color="amber">waiting</Badge>} onOpen={onSelectWorkspace} />)}
    </RelationList>
    <RelationList title="Related to" count={related.length} empty="No related workspaces.">
      {related.map((id) => <WorkspaceRow key={id} id={id} workspace={byId[id]} onOpen={onSelectWorkspace} onRemove={onSetRelations ? () => removeRelated(id) : undefined} />)}
    </RelationList>
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
