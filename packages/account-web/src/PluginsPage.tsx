import type {
  ComposioPluginCatalogRpcView,
  ComposioPluginToolRpcView,
  DiscoveredMcpToolRpcView,
  McpConnectionDraftInput,
  McpConnectionRpcView,
  ProjectMcpGrantRpcView,
} from '@gitspace/protocol/mcp-contract';
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  TabsSubtle,
  TabsSubtleItem,
  TabsSubtlePanel,
  useShape,
} from '@gitspace/ui';
import { AlertCircle, Cloud01, Link03, Plus, PuzzlePiece01, RefreshCcw01, SearchMd, Server01, Trash01 } from '@untitledui/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  composioCatalog: ComposioPluginCatalogRpcView;
  loading?: boolean;
  error?: string;
  onCreate(connection: McpConnectionDraftInput): Promise<void>;
  onUpdate(connectionId: string, expectedRevision: number, connection: McpConnectionDraftInput): Promise<void>;
  onDelete(connectionId: string, expectedRevision: number): Promise<void>;
  onAuthorizeComposio(toolkit: string, label: string): Promise<string>;
  onRefreshComposio(connectionId: string): Promise<void>;
  onLoadComposioTools(connectionId: string): Promise<readonly ComposioPluginToolRpcView[]>;
  onUpdateComposioTools(connectionId: string, expectedRevision: number, allowedTools: readonly string[]): Promise<void>;
  onDisconnectComposio(connectionId: string, expectedRevision: number): Promise<void>;
  onSetGrant(projectId: string, connectionId: string, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<void>;
  onRefresh(): Promise<void>;
}

type Transport = 'stdio' | 'http' | 'sse';
type Target = 'workspace' | 'machine';

const SearchGlyph = glyph(SearchMd);
const ServerGlyph = glyph(Server01);
const LinkGlyph = glyph(Link03);
const CloudGlyph = glyph(Cloud01);
const PlusGlyph = glyph(Plus);
const RefreshGlyph = glyph(RefreshCcw01);

function selectOptions(options: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}

function customConnectionDraft(connection: McpConnectionRpcView, enabled = connection.enabled): McpConnectionDraftInput {
  if (connection.target.kind === 'cloud' || connection.transport.type === 'composio') throw new Error('Composio plugins cannot be edited as custom plugins');
  return { id: connection.id, label: connection.label, enabled, target: connection.target, transport: connection.transport, timeoutMs: connection.timeoutMs };
}

function bindings(source: string) {
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

function Labeled({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="flex flex-col gap-1">
    <span className="pl-2.5 text-body text-muted-foreground">{label}</span>
    {children}
    {description ? <span className="pl-2.5 text-caption text-muted-foreground">{description}</span> : null}
  </div>;
}

function MultilineField({ value, onChange, placeholder, label }: { value: string; onChange(value: string): void; placeholder?: string; label: string }) {
  const shape = useShape();
  return <textarea aria-label={label} value={value} placeholder={placeholder} rows={3} spellCheck={false} onChange={(event) => onChange(event.currentTarget.value)} className={`${shape.input} w-full resize-y border border-border bg-surface-2 p-2 font-mono text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]`} />;
}

export function PluginsPage(props: PluginsPageProps) {
  const [creatingCustom, setCreatingCustom] = useState(false);
  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(null);
  const [accountLabel, setAccountLabel] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [id, setId] = useState('paper-desktop');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [label, setLabel] = useState('Paper Desktop');
  const [target, setTarget] = useState<Target>('machine');
  const [tab, setTab] = useState(() => props.connections.some((connection) => connection.transport.type !== 'composio') ? 1 : 0);
  const [machineId, setMachineId] = useState(props.machines[0]?.id ?? '');
  const [transport, setTransport] = useState<Transport>('http');
  const [command, setCommand] = useState('bunx');
  const [args, setArgs] = useState('["@vendor/mcp-server@1.0.0"]');
  const [url, setUrl] = useState('http://127.0.0.1:29979/mcp');
  const [secretBindings, setSecretBindings] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [composioTools, setComposioTools] = useState<readonly ComposioPluginToolRpcView[]>([]);
  const [selectedTools, setSelectedTools] = useState<readonly string[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const customConnections = props.connections.filter((connection) => connection.transport.type !== 'composio');
  const composioConnections = props.connections.filter((connection) => connection.transport.type === 'composio');
  const visibleCustom = customConnections.filter((connection) => `${connection.label} ${connection.id} ${connection.transport.type}`.toLowerCase().includes(normalizedQuery));
  const visibleComposio = composioConnections.filter((connection) => `${connection.label} ${connection.id} ${connection.transport.type === 'composio' ? connection.transport.toolkit : ''}`.toLowerCase().includes(normalizedQuery));
  const visibleToolkits = props.composioCatalog.toolkits.filter((toolkit) => `${toolkit.name} ${toolkit.slug} ${toolkit.description ?? ''}`.toLowerCase().includes(normalizedQuery));
  const currentProjectGrants = props.grants.filter((grant) => grant.projectId === props.projectId);
  const grantByConnection = useMemo(() => new Map(currentProjectGrants.map((grant) => [grant.connectionId, grant])), [props.grants, props.projectId]);
  const expandedConnection = expanded === null ? null : props.connections.find((connection) => connection.id === expanded) ?? null;
  const expandedDiscoveredTools = expandedConnection ? props.tools.filter((tool) => tool.connectionId === expandedConnection.id) : [];
  const connectedToolkit = connectingToolkit ? props.composioCatalog.toolkits.find((toolkit) => toolkit.slug === connectingToolkit) ?? null : null;

  useEffect(() => {
    if (!expandedConnection || expandedConnection.transport.type !== 'composio' || expandedConnection.status !== 'ready') {
      setComposioTools([]);
      setSelectedTools([]);
      return;
    }
    let cancelled = false;
    setToolsLoading(true);
    setSelectedTools(expandedConnection.transport.allowedTools);
    void props.onLoadComposioTools(expandedConnection.id).then((tools) => {
      if (!cancelled) setComposioTools(tools);
    }).catch((failure: unknown) => {
      if (!cancelled) setActionError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => {
      if (!cancelled) setToolsLoading(false);
    });
    return () => { cancelled = true; };
  }, [expandedConnection?.id, expandedConnection?.revision]);

  const settle = async (key: string, action: () => Promise<void>) => {
    setPending(key);
    setActionError(null);
    try { await action(); }
    catch (failure) { setActionError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(null); }
  };

  const createCustom = async () => {
    const selectedTarget = target === 'workspace' ? { kind: 'workspace' as const } : { kind: 'machine' as const, machineId };
    if (selectedTarget.kind === 'machine' && !selectedTarget.machineId) throw new Error('Choose the machine that can reach this MCP server.');
    const nextTransport: McpConnectionDraftInput['transport'] = transport === 'stdio'
      ? { type: 'stdio', command: command.trim(), args: JSON.parse(args) as string[], cwd: null, environment: bindings(secretBindings) }
      : { type: transport, url: url.trim(), headers: bindings(secretBindings) };
    await settle('create-custom', async () => {
      await props.onCreate({ id: id.trim(), label: label.trim(), enabled: true, target: selectedTarget, transport: nextTransport, timeoutMs: Number(timeoutMs) });
      setCreatingCustom(false);
    });
  };

  const authorizeComposio = async () => {
    if (!connectedToolkit) return;
    const popup = window.open('', 'gitspace-composio', 'popup,width=720,height=760');
    setPending(`authorize:${connectedToolkit.slug}`);
    setActionError(null);
    try {
      const redirectUrl = await props.onAuthorizeComposio(connectedToolkit.slug, accountLabel.trim() || `${connectedToolkit.name} account`);
      if (popup) popup.location.href = redirectUrl;
      else window.location.assign(redirectUrl);
      setConnectingToolkit(null);
      setAccountLabel('');
    } catch (failure) {
      popup?.close();
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  };

  const error = props.error ?? actionError;
  return <PageCanvas>
    <PageHeader kicker={`GitSpace project · ${props.projectName}`} title="Plugins" description="Connect managed and custom plugins, then choose which project agents may use their tools." />

    <div className="flex flex-wrap items-center gap-3 pb-4">
      <TabsSubtle selectedIndex={tab} onSelect={setTab} idPrefix="plugins-source" aria-label="Plugin source">
        <TabsSubtleItem index={0} label={`Composio plugins · ${composioConnections.length}`} />
        <TabsSubtleItem index={1} label={`Custom plugins · ${customConnections.length}`} />
      </TabsSubtle>
      <InputGroup className="w-full sm:ml-auto sm:max-w-xs"><InputField index={0} label="Filter plugins" labelHidden icon={SearchGlyph} placeholder="Search plugins" value={query} onChange={setQuery} /></InputGroup>
      <Button variant="ghost" leadingIcon={RefreshGlyph} aria-label="Refresh plugins" onClick={() => void settle('refresh', props.onRefresh)} disabled={pending !== null}>Refresh</Button>
      {tab === 1 ? <Button variant="primary" leadingIcon={PlusGlyph} onClick={() => setCreatingCustom(true)}>Add custom plugin</Button> : null}
    </div>

    <TabsSubtlePanel index={0} selectedIndex={tab} idPrefix="plugins-source" className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="connected-composio-plugins">
        <div><h2 id="connected-composio-plugins" className="text-subtitle font-medium text-foreground">Connected plugins</h2><p className="text-body text-muted-foreground">Authentication creates a plugin connection. Project access and allowed tools remain separate.</p></div>
        {visibleComposio.length ? <CardGroup orientation="inline" border="outlined" separated>{visibleComposio.map((connection) => {
          if (connection.transport.type !== 'composio') return null;
          const grant = grantByConnection.get(connection.id);
          return <Card size="compact" key={connection.id}>
            <CardMedia icon={CloudGlyph} />
            <CardHeader><CardTitle>{connection.label}</CardTitle><CardDescription>{connection.transport.toolkit} · Composio managed</CardDescription><span className="text-caption tabular-nums text-muted-foreground">{connection.transport.allowedTools.length} allowed tools{grant?.enabled ? ` · enabled for ${props.projectName}` : ''}</span>{connection.statusMessage ? <span className="flex items-center gap-1 text-caption text-destructive"><AlertCircle width={12} height={12} strokeWidth={1.5} />{connection.statusMessage}</span> : null}</CardHeader>
            <CardFooter className="gap-2"><Badge color={statusColor(connection.status)}>{connection.status}</Badge>{connection.status === 'connecting' ? <Button variant="ghost" loading={pending === `refresh:${connection.id}`} onClick={() => void settle(`refresh:${connection.id}`, () => props.onRefreshComposio(connection.id))}>Check connection</Button> : null}<Button variant="ghost" onClick={() => setExpanded(connection.id)}>Manage plugin</Button><Button variant="tertiary" size="icon-compact" aria-label={`Disconnect ${connection.label}`} onClick={() => void settle(`disconnect:${connection.id}`, () => props.onDisconnectComposio(connection.id, connection.revision))}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></CardFooter>
          </Card>;
        })}</CardGroup> : <EmptyState title="No Composio plugins connected" description="Choose a plugin below and connect an account. Connecting alone does not grant an agent access." />}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="available-composio-plugins">
        <div><h2 id="available-composio-plugins" className="text-subtitle font-medium text-foreground">Available plugins</h2><p className="text-body text-muted-foreground">Composio manages authentication and credential refresh. GitSpace controls every project and tool grant.</p></div>
        {!props.composioCatalog.configured
          ? <EmptyState icon={<Cloud01 width={22} height={22} strokeWidth={1.5} />} title="Set up Composio to connect plugins" description="Add your Composio API key once in Settings. GitSpace validates and encrypts it for this account." action={<Button variant="primary" asChild><a href="/settings?section=connections&amp;setup=composio">Set up Composio</a></Button>} />
          : visibleToolkits.length ? <CardGroup orientation="inline" border="outlined" separated>{visibleToolkits.map((toolkit) => <Card size="compact" key={toolkit.slug}>
            <CardMedia icon={CloudGlyph} />
            <CardHeader><CardTitle>{toolkit.name}</CardTitle><CardDescription>{toolkit.description ?? `Connect ${toolkit.name} through Composio.`}</CardDescription><span className="text-caption tabular-nums text-muted-foreground">{toolkit.toolsCount} available tools</span></CardHeader>
            <CardFooter><Button variant="secondary" leadingIcon={LinkGlyph} onClick={() => { setConnectingToolkit(toolkit.slug); setAccountLabel(`${toolkit.name} account`); }}>Connect plugin</Button></CardFooter>
          </Card>)}</CardGroup> : <EmptyState title="No matching Composio plugins" description="Change the filter to search the plugin catalog." />}
      </section>
    </TabsSubtlePanel>

    <TabsSubtlePanel index={1} selectedIndex={tab} idPrefix="plugins-source">
      {props.loading ? <EmptyState title="Loading custom plugins…" /> : visibleCustom.length ? <CardGroup orientation="inline" border="outlined" separated>{visibleCustom.map((connection) => {
        const grant = grantByConnection.get(connection.id);
        const connectionTools = props.tools.filter((tool) => tool.connectionId === connection.id);
        const targetMachineId = connection.target.kind === 'machine' ? connection.target.machineId : null;
        const targetLabel = targetMachineId ? props.machines.find((machine) => machine.id === targetMachineId)?.label ?? targetMachineId : 'Workspace sandbox';
        const transportLabel = connection.transport.type === 'http' ? 'Streamable HTTP' : connection.transport.type;
        return <Card size="compact" key={connection.id}>
          <CardMedia icon={connection.transport.type === 'stdio' ? ServerGlyph : LinkGlyph} />
          <CardHeader><CardTitle>{connection.label}</CardTitle><CardDescription>{transportLabel} · {targetLabel} · {connection.serverVersion ?? 'Version not reported'}</CardDescription><span className="text-caption tabular-nums text-muted-foreground"><span className="font-mono">{connection.id}</span> · {connectionTools.length} discovered tools{grant?.enabled ? ` · enabled for ${props.projectName}` : ''}</span>{connection.statusMessage ? <span className="flex items-center gap-1 text-caption text-destructive"><AlertCircle width={12} height={12} strokeWidth={1.5} />{connection.statusMessage}</span> : null}</CardHeader>
          <CardFooter className="gap-2"><Badge color={statusColor(connection.status)}>{connection.status}</Badge><Button variant="ghost" onClick={() => setExpanded(connection.id)}>Manage plugin</Button><Switch checked={connection.enabled} label={connection.enabled ? 'Enabled' : 'Disabled'} disabled={pending !== null} onToggle={() => void settle(`connection:${connection.id}`, () => props.onUpdate(connection.id, connection.revision, customConnectionDraft(connection, !connection.enabled)))} /><Button variant="tertiary" size="icon-compact" aria-label={`Delete ${connection.label}`} onClick={() => void settle(`delete:${connection.id}`, () => props.onDelete(connection.id, connection.revision))}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></CardFooter>
        </Card>;
      })}</CardGroup> : <EmptyState icon={<PuzzlePiece01 width={22} height={22} strokeWidth={1.5} />} title={customConnections.length ? 'No matching custom plugins' : 'No custom plugins connected'} description={customConnections.length ? 'Change the filter to see your custom plugins.' : 'Connect a local stdio, Streamable HTTP, or SSE MCP server.'} action={customConnections.length ? undefined : <Button variant="primary" leadingIcon={PlusGlyph} onClick={() => setCreatingCustom(true)}>Add custom plugin</Button>} />}
    </TabsSubtlePanel>

    {error ? <p role="alert" className="mt-4 text-body text-destructive">{error}</p> : null}

    <Dialog open={expandedConnection !== null} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
      {expandedConnection ? <DialogContent size="lg"><DialogHeader><DialogTitle>{expandedConnection.label}</DialogTitle><DialogDescription>Choose where agents can discover this plugin and, for Composio plugins, which tools they may call.</DialogDescription></DialogHeader>
        {expandedConnection.transport.type === 'composio' ? <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3"><div><h3 className="text-body font-medium text-foreground">Allowed tools</h3><p className="text-caption text-muted-foreground">New Composio tools remain denied until selected here.</p></div><div className="flex gap-2"><Button size="compact" variant="ghost" onClick={() => setSelectedTools(composioTools.filter((tool) => tool.readOnly).map((tool) => tool.slug))}>Select read-only</Button><Button size="compact" variant="ghost" onClick={() => setSelectedTools([])}>Clear</Button></div></div>
          {toolsLoading ? <EmptyState title="Loading plugin tools…" /> : composioTools.length ? <CardGroup border="outlined" separated>{composioTools.map((tool) => <Card size="compact" key={tool.slug}><CardHeader><CardTitle>{tool.name}</CardTitle><CardDescription>{tool.description ?? tool.slug}</CardDescription><span className="text-caption text-muted-foreground">{tool.destructive ? 'Destructive' : tool.readOnly ? 'Read only' : 'Write capable'} · <span className="font-mono">{tool.slug}</span></span></CardHeader><CardFooter><Switch checked={selectedTools.includes(tool.slug)} label={selectedTools.includes(tool.slug) ? 'Allowed' : 'Denied'} onToggle={() => setSelectedTools((current) => current.includes(tool.slug) ? current.filter((slug) => slug !== tool.slug) : [...current, tool.slug])} /></CardFooter></Card>)}</CardGroup> : <EmptyState title="No tools available" description={expandedConnection.status === 'ready' ? 'Composio did not return tools for this plugin.' : 'Finish connecting this plugin before choosing tools.'} />}
          <Button variant="secondary" disabled={pending !== null || expandedConnection.status !== 'ready'} loading={pending === `tools:${expandedConnection.id}`} onClick={() => void settle(`tools:${expandedConnection.id}`, () => props.onUpdateComposioTools(expandedConnection.id, expandedConnection.revision, selectedTools))}>Save allowed tools</Button>
        </div> : expandedDiscoveredTools.length ? <CardGroup border="outlined" separated>{expandedDiscoveredTools.map((tool) => <Card size="compact" key={tool.ompToolName}><CardHeader><CardTitle>{tool.name}</CardTitle><CardDescription>{tool.description ?? 'No description supplied by the MCP server.'}</CardDescription><span className="text-caption text-muted-foreground"><span className="font-mono">{tool.ompToolName}</span> · {tool.destructive ? 'destructive' : tool.readOnly ? 'read only' : 'write capable'}</span></CardHeader></Card>)}</CardGroup> : null}
        <ProjectAssignmentMatrix projects={props.projects} assignments={props.grants.filter((candidate) => candidate.connectionId === expandedConnection.id).map((candidate) => ({ projectId: candidate.projectId, projectSpaceEnabled: candidate.projectSpaceEnabled, workspacesEnabled: candidate.workspacesEnabled }))} defaultProjectSpaceEnabled={false} defaultWorkspacesEnabled={false} disabled={!expandedConnection.enabled || (expandedConnection.transport.type === 'composio' && expandedConnection.status !== 'ready') || pending !== null} onChange={(assignment) => { const current = props.grants.find((candidate) => candidate.connectionId === expandedConnection.id && candidate.projectId === assignment.projectId); void settle(`grant:${assignment.projectId}:${expandedConnection.id}`, () => props.onSetGrant(assignment.projectId, expandedConnection.id, assignment.projectSpaceEnabled, assignment.workspacesEnabled, current?.revision ?? 0)); }} />
        <DialogFooter><Button variant="secondary" onClick={() => setExpanded(null)}>Done</Button></DialogFooter>
      </DialogContent> : null}
    </Dialog>

    <Dialog open={connectedToolkit !== null} onOpenChange={(open) => { if (!open) setConnectingToolkit(null); }}><DialogContent><DialogHeader><DialogTitle>Connect {connectedToolkit?.name ?? 'plugin'}</DialogTitle><DialogDescription>Composio manages the account credential. No agent receives access until you choose tools and assign this plugin.</DialogDescription></DialogHeader><InputGroup><InputField index={0} label="Account label" value={accountLabel} onChange={setAccountLabel} placeholder="Work account" /></InputGroup><DialogFooter><Button variant="secondary" onClick={() => setConnectingToolkit(null)}>Cancel</Button><Button variant="primary" loading={pending?.startsWith('authorize:') === true} onClick={() => void authorizeComposio()}>Continue to authentication</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={creatingCustom} onOpenChange={setCreatingCustom}><DialogContent size="lg"><DialogHeader><DialogTitle>Connect custom plugin</DialogTitle><DialogDescription>Run a local MCP server on a machine or connect a Streamable HTTP or SSE server. Project access is assigned separately.</DialogDescription></DialogHeader><div className="flex flex-col gap-4">
      <InputGroup className="w-full"><InputField index={0} label="Connection ID" placeholder="Stable lowercase identifier used by project grants" value={id} onChange={setId} /><InputField index={1} label="Display label" value={label} onChange={setLabel} /></InputGroup>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Labeled label="Execution target"><Select value={target} onValueChange={(value) => setTarget(value as Target)}><SelectTrigger aria-label="Execution target" />{selectOptions([{ value: 'machine', label: 'Pinned machine' }, { value: 'workspace', label: 'Workspace sandbox' }])}</Select></Labeled>{target === 'machine' ? <Labeled label="Machine"><Select value={machineId} onValueChange={setMachineId}><SelectTrigger aria-label="Machine" />{selectOptions(props.machines.map((machine) => ({ value: machine.id, label: `${machine.label} · ${machine.state}` })))}</Select></Labeled> : null}<Labeled label="Transport"><Select value={transport} onValueChange={(value) => setTransport(value as Transport)}><SelectTrigger aria-label="Transport" />{selectOptions([{ value: 'http', label: 'Streamable HTTP' }, { value: 'stdio', label: 'stdio command' }, { value: 'sse', label: 'SSE' }])}</Select></Labeled></div>
      <InputGroup className="w-full">{transport === 'stdio' ? <InputField index={0} label="Command" placeholder="Pinned bunx/npx package or an absolute executable path" value={command} onChange={setCommand} /> : <InputField index={0} label="MCP URL" placeholder="http://127.0.0.1:29979/mcp" value={url} onChange={setUrl} type="url" />}<InputField index={1} label="Timeout (ms)" type="number" min="0" max="600000" value={timeoutMs} onChange={setTimeoutMs} /></InputGroup>
      {transport === 'stdio' ? <Labeled label="Arguments" description="JSON array. Package versions or commits must be exact."><MultilineField label="Arguments" value={args} onChange={setArgs} /></Labeled> : null}
      <Labeled label={transport === 'stdio' ? 'Environment secret references' : 'Header secret references'} description="One DESTINATION=PROJECT_SECRET binding per line. Values remain write-only."><MultilineField label={transport === 'stdio' ? 'Environment secret references' : 'Header secret references'} value={secretBindings} onChange={setSecretBindings} placeholder={transport === 'stdio' ? 'API_KEY=PLUGIN_API_KEY' : 'Authorization=PLUGIN_AUTHORIZATION'} /></Labeled>
    </div><DialogFooter><Button variant="secondary" onClick={() => setCreatingCustom(false)}>Cancel</Button><Button variant="primary" disabled={pending !== null} loading={pending === 'create-custom'} onClick={() => void createCustom()}>{pending === 'create-custom' ? 'Connecting…' : 'Connect custom plugin'}</Button></DialogFooter></DialogContent></Dialog>
  </PageCanvas>;
}
