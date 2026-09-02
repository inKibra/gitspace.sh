import type {
  DiscoveredMcpToolRpcView,
  McpConnectionDraftInput,
  McpConnectionRpcView,
  ProjectMcpGrantRpcView,
} from '@gitspace/protocol/mcp-contract';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardMedia,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  InputField,
  InputGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
  useShape,
} from '@gitspace/ui';
import { AlertCircle, Link03, Plus, PuzzlePiece01, RefreshCcw01, SearchMd, Server01, Trash01 } from '@untitledui/icons';
import { useMemo, useState, type ReactNode } from 'react';
import { glyph } from './glyph.js';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';
import { ProjectAssignmentMatrix } from './ProjectAssignmentMatrix.js';

export interface PluginsPageProps {
  projectId: string;
  projectName: string;
  connections: readonly McpConnectionRpcView[];
  grants: readonly ProjectMcpGrantRpcView[];
  projects: readonly { id: string; name: string }[];
  tools: readonly DiscoveredMcpToolRpcView[];
  machines: readonly { id: string; label: string; state: string }[];
  loading?: boolean;
  error?: string;
  onCreate(connection: McpConnectionDraftInput): Promise<void>;
  onUpdate(connectionId: string, expectedRevision: number, connection: McpConnectionDraftInput): Promise<void>;
  onDelete(connectionId: string, expectedRevision: number): Promise<void>;
  onSetGrant(projectId: string, connectionId: string, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<void>;
  onRefresh(): Promise<void>;
}
type Transport = 'stdio' | 'http' | 'sse';
type Target = 'workspace' | 'machine';

const SearchGlyph = glyph(SearchMd);
const ServerGlyph = glyph(Server01);
const LinkGlyph = glyph(Link03);
const PlusGlyph = glyph(Plus);
const RefreshGlyph = glyph(RefreshCcw01);

function selectOptions(options: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}

function connectionDraft(connection: McpConnectionRpcView, enabled = connection.enabled): McpConnectionDraftInput {
  return {
    id: connection.id,
    label: connection.label,
    enabled,
    target: connection.target,
    transport: connection.transport,
    timeoutMs: connection.timeoutMs,
  };
}

function bindings(source: string, kind: 'environment' | 'headers') {
  return source.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0 || separator === line.length - 1) throw new Error('Secret bindings must use DESTINATION=PROJECT_SECRET, one per line.');
    return { name: line.slice(0, separator).trim(), secret: { source: 'project' as const, name: line.slice(separator + 1).trim() } };
  });
}

function statusColor(status: McpConnectionRpcView['status']): 'gray' | 'green' | 'blue' | 'amber' | 'red' {
  if (status === 'ready') return 'green';
  if (status === 'connecting') return 'blue';
  if (status === 'offline') return 'amber';
  if (status === 'failed') return 'red';
  return 'gray';
}

function toolCount(count: number): string {
  return `${count} ${count === 1 ? 'tool' : 'tools'}`;
}

// Caption + control pair for dialog rows whose control is not an InputField
// (Select, textarea). Same label inset as InputField's own label.
function Labeled({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="flex flex-col gap-1">
    <span className="pl-2.5 text-body text-muted-foreground">{label}</span>
    {children}
    {description ? <span className="pl-2.5 text-caption text-muted-foreground">{description}</span> : null}
  </div>;
}

// FLUID-GAP: textarea — Fluid has no multi-line text field; plain element on Fluid tokens.
function MultilineField({ value, onChange, placeholder, label }: { value: string; onChange(value: string): void; placeholder?: string; label: string }) {
  const shape = useShape();
  return <textarea
    aria-label={label}
    value={value}
    placeholder={placeholder}
    rows={3}
    spellCheck={false}
    onChange={(event) => onChange(event.currentTarget.value)}
    className={`${shape.input} w-full resize-y border border-border bg-surface-2 p-2 font-mono text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]`}
  />;
}

export function PluginsPage(props: PluginsPageProps) {
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [id, setId] = useState('paper-desktop');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [label, setLabel] = useState('Paper Desktop');
  const [target, setTarget] = useState<Target>('machine');
  const [machineId, setMachineId] = useState(props.machines[0]?.id ?? '');
  const [transport, setTransport] = useState<Transport>('http');
  const [command, setCommand] = useState('bunx');
  const [args, setArgs] = useState('["@vendor/mcp-server@1.0.0"]');
  const [url, setUrl] = useState('http://127.0.0.1:29979/mcp');
  const [secretBindings, setSecretBindings] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('30000');

  const currentProjectGrants = props.grants.filter((grant) => grant.projectId === props.projectId);
  const grantByConnection = useMemo(() => new Map(currentProjectGrants.map((grant) => [grant.connectionId, grant])), [props.grants, props.projectId]);
  const visible = props.connections.filter((connection) => `${connection.label} ${connection.id} ${connection.transport.type}`.toLowerCase().includes(query.trim().toLowerCase()));
  const enabledCount = currentProjectGrants.filter((grant) => grant.enabled && (grant.projectSpaceEnabled || grant.workspacesEnabled)).length;
  const expandedConnection = expanded === null ? null : props.connections.find((connection) => connection.id === expanded) ?? null;
  const expandedTools = expandedConnection ? props.tools.filter((tool) => tool.connectionId === expandedConnection.id) : [];

  const settle = async (key: string, action: () => Promise<void>) => {
    setPending(key);
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      setPending(null);
    }
  };

  const create = async () => {
    const selectedTarget = target === 'workspace'
      ? { kind: 'workspace' as const }
      : { kind: 'machine' as const, machineId };
    if (selectedTarget.kind === 'machine' && !selectedTarget.machineId) throw new Error('Choose the machine that can reach this MCP server.');
    const nextTransport: McpConnectionDraftInput['transport'] = transport === 'stdio'
      ? {
          type: 'stdio',
          command: command.trim(),
          args: JSON.parse(args) as string[],
          cwd: null,
          environment: bindings(secretBindings, 'environment'),
        }
      : {
          type: transport,
          url: url.trim(),
          headers: bindings(secretBindings, 'headers'),
        };
    await settle('create', async () => {
      await props.onCreate({
        id: id.trim(),
        label: label.trim(),
        enabled: true,
        target: selectedTarget,
        transport: nextTransport,
        timeoutMs: Number(timeoutMs),
      });
      setCreating(false);
    });
  };

  const error = props.error ?? actionError;
  return <PageCanvas>
    <PageHeader
      kicker={`GitSpace project · ${props.projectName}`}
      title="Plugins"
      description="Choose which account connections are available to this project’s agents."
    />

    <div className="flex items-center gap-3 pb-4">
      <InputGroup className="w-full max-w-sm"><InputField index={0} label="Filter plugins" labelHidden icon={SearchGlyph} placeholder="Search plugins" value={query} onChange={setQuery} /></InputGroup>
      <span className="ml-auto text-caption tabular-nums text-muted-foreground">{visible.length} of {props.connections.length}</span>
      <Button variant="ghost" leadingIcon={RefreshGlyph} aria-label="Refresh plugins" onClick={() => void settle('refresh', props.onRefresh)} disabled={pending !== null}>Refresh</Button>
      <Button variant="primary" leadingIcon={PlusGlyph} onClick={() => setCreating(true)}>Add connection</Button>
    </div>

    {props.loading
      ? <EmptyState title="Loading plugins…" />
      : visible.length
        ? <CardGroup orientation="inline" border="outlined" separated>
          {visible.map((connection) => {
            const grant = grantByConnection.get(connection.id);
            const connectionTools = props.tools.filter((tool) => tool.connectionId === connection.id);
            const projectEnabled = grant?.enabled === true;
            const targetMachineId = connection.target.kind === 'machine' ? connection.target.machineId : null;
            const targetLabel = targetMachineId
              ? props.machines.find((machine) => machine.id === targetMachineId)?.label ?? targetMachineId
              : 'Workspace sandbox';
            const transportLabel = connection.transport.type === 'http' ? 'Streamable HTTP' : connection.transport.type;
            return <Card size="compact" key={connection.id}>
              <CardMedia icon={connection.transport.type === 'stdio' ? ServerGlyph : LinkGlyph} />
              <CardHeader>
                <CardTitle>{connection.label}</CardTitle>
                <CardDescription>{transportLabel} · {targetLabel} · {connection.serverVersion ?? 'Version not reported'}</CardDescription>
                <span className="text-caption tabular-nums text-muted-foreground"><span className="font-mono">{connection.id}</span> · {toolCount(connectionTools.length)}{projectEnabled ? ` · enabled for ${props.projectName}` : ''}</span>
                {connection.statusMessage ? <span className="flex items-center gap-1 text-caption text-destructive"><AlertCircle width={12} height={12} strokeWidth={1.5} />{connection.statusMessage}</span> : null}
              </CardHeader>
              <CardFooter className="gap-2">
                <Badge color={statusColor(connection.status)}>{connection.status}</Badge>
                <Badge variant="dot" color="gray"><span className="tabular-nums">{connectionTools.length} discovered {connectionTools.length === 1 ? 'tool' : 'tools'}</span></Badge>
                <Button variant="ghost" onClick={() => setExpanded(connection.id)}>Manage access</Button>
                <Switch checked={connection.enabled} label={connection.enabled ? 'Enabled' : 'Disabled'} disabled={pending !== null} onToggle={() => void settle(`connection:${connection.id}`, () => props.onUpdate(connection.id, connection.revision, connectionDraft(connection, !connection.enabled)))} />
                <Button variant="tertiary" size="icon-compact" disabled={pending !== null} aria-label={`Delete ${connection.label}`} onClick={() => void settle(`delete:${connection.id}`, () => props.onDelete(connection.id, connection.revision))}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button>
              </CardFooter>
            </Card>;
          })}
        </CardGroup>
        : <EmptyState
          icon={<PuzzlePiece01 width={22} height={22} strokeWidth={1.5} />}
          title={props.connections.length ? 'No matching plugins' : 'No plugins connected'}
          description={props.connections.length ? 'Change the filter to see the connected catalog.' : `Add a connection, then choose whether ${props.projectName} may use it.`}
          action={props.connections.length ? undefined : <Button variant="primary" leadingIcon={LinkGlyph} onClick={() => setCreating(true)}>Add the first connection</Button>}
        />}

    {error ? <p role="alert" className="mt-4 text-body text-destructive">{error}</p> : null}
    <p className="mt-6 text-caption tabular-nums text-muted-foreground">{enabledCount} {enabledCount === 1 ? 'connection is' : 'connections are'} enabled for {props.projectName}. Connection availability and project assignment are controlled separately.</p>

    <Dialog open={expandedConnection !== null} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
      {expandedConnection ? <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{expandedConnection.label}</DialogTitle>
          <DialogDescription>Choose which agents in each project may discover this connection’s tools.{expandedConnection.enabled ? '' : ' Enable the connection before assigning it.'}</DialogDescription>
        </DialogHeader>
        <ProjectAssignmentMatrix
          projects={props.projects}
          assignments={props.grants.filter((candidate) => candidate.connectionId === expandedConnection.id).map((candidate) => ({ projectId: candidate.projectId, projectSpaceEnabled: candidate.projectSpaceEnabled, workspacesEnabled: candidate.workspacesEnabled }))}
          defaultProjectSpaceEnabled={false}
          defaultWorkspacesEnabled={false}
          disabled={!expandedConnection.enabled || pending !== null}
          onChange={(assignment) => {
            const current = props.grants.find((candidate) => candidate.connectionId === expandedConnection.id && candidate.projectId === assignment.projectId);
            void settle(`grant:${assignment.projectId}:${expandedConnection.id}`, () => props.onSetGrant(assignment.projectId, expandedConnection.id, assignment.projectSpaceEnabled, assignment.workspacesEnabled, current?.revision ?? 0));
          }}
        />
        {expandedTools.length ? <div className="mt-4 flex flex-col gap-2">
          <span className="text-caption text-muted-foreground">{expandedTools.length} discovered {expandedTools.length === 1 ? 'tool' : 'tools'}</span>
          <CardGroup border="outlined">
            {expandedTools.map((tool) => <Card size="compact" key={tool.ompToolName}>
              <CardHeader>
                <CardTitle>{tool.name}</CardTitle>
                <CardDescription>{tool.description ?? 'No description supplied by the MCP server.'}</CardDescription>
                <span className="text-caption text-muted-foreground"><span className="font-mono">{tool.ompToolName}</span> · {tool.destructive ? 'destructive' : tool.readOnly ? 'read only' : 'write capable'}</span>
              </CardHeader>
            </Card>)}
          </CardGroup>
        </div> : null}
        <DialogFooter><Button variant="secondary" onClick={() => setExpanded(null)}>Done</Button></DialogFooter>
      </DialogContent> : null}
    </Dialog>

    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>Connect local MCP server</DialogTitle><DialogDescription>The connection belongs to your GitSpace principal. Enable it for projects separately after it connects.</DialogDescription></DialogHeader>
        <div className="flex flex-col gap-4">
          <InputGroup className="w-full">
            <InputField index={0} label="Connection ID" placeholder="Stable lowercase identifier used by project grants" value={id} onChange={setId} />
            <InputField index={1} label="Display label" value={label} onChange={setLabel} />
          </InputGroup>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Execution target"><Select value={target} onValueChange={(value) => setTarget(value as Target)}><SelectTrigger aria-label="Execution target" />{selectOptions([{ value: 'machine', label: 'Pinned machine' }, { value: 'workspace', label: 'Workspace sandbox' }])}</Select></Labeled>
            {target === 'machine' ? <Labeled label="Machine"><Select value={machineId} onValueChange={setMachineId}><SelectTrigger aria-label="Machine" />{selectOptions(props.machines.map((machine) => ({ value: machine.id, label: `${machine.label} · ${machine.state}` })))}</Select></Labeled> : null}
            <Labeled label="Transport"><Select value={transport} onValueChange={(value) => setTransport(value as Transport)}><SelectTrigger aria-label="Transport" />{selectOptions([{ value: 'http', label: 'Streamable HTTP' }, { value: 'stdio', label: 'stdio command' }, { value: 'sse', label: 'SSE' }])}</Select></Labeled>
          </div>
          <InputGroup className="w-full">
            {transport === 'stdio'
              ? <InputField index={0} label="Command" placeholder="Pinned bunx/npx package or an absolute executable path" value={command} onChange={setCommand} />
              : <InputField index={0} label="MCP URL" placeholder="Paper Desktop uses http://127.0.0.1:29979/mcp on its pinned machine" value={url} onChange={setUrl} type="url" />}
            <InputField index={1} label="Timeout (ms)" type="number" min="0" max="600000" value={timeoutMs} onChange={setTimeoutMs} />
          </InputGroup>
          {transport === 'stdio' ? <Labeled label="Arguments" description="JSON array. Package versions or commits must be exact."><MultilineField label="Arguments" value={args} onChange={setArgs} /></Labeled> : null}
          <Labeled label={transport === 'stdio' ? 'Environment secret references' : 'Header secret references'} description="One DESTINATION=PROJECT_SECRET binding per line. Values remain write-only.">
            <MultilineField label={transport === 'stdio' ? 'Environment secret references' : 'Header secret references'} value={secretBindings} onChange={setSecretBindings} placeholder={transport === 'stdio' ? 'API_KEY=INTEGRATION_API_KEY' : 'Authorization=INTEGRATION_AUTHORIZATION'} />
          </Labeled>
          {actionError ? <p role="alert" className="text-caption text-destructive">{actionError}</p> : null}
        </div>
        <DialogFooter><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={pending !== null} loading={pending === 'create'} onClick={() => void create()}>{pending === 'create' ? 'Connecting…' : 'Connect'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </PageCanvas>;
}
