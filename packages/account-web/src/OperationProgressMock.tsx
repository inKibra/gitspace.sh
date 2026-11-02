// Throwaway design mock: long project and workspace operations run in the background. A request returns once the
// operation is recorded; the project's own object runs it, and every surface follows the recorded steps: the setting it
// changes (Project settings), the project's row in the sidebar, the project page's top bar, and the workspace cards.
// A failure stays on its step with Retry and Dismiss. "Today" shows the request held open until it times out.
// Static data only.
import {
  Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, MenuItem, ShapeProvider, Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarUserFooter,
  SidebarWorkspaceHeader, SizeProvider, ThinkingIndicator, Tooltip, TooltipProvider, untitledIcons, useShape, WorkspaceTile, type IconComponent,
} from '@gitspace/ui';
import { Activity, Archive, Columns03, FolderClosed, GitBranch01, Key01, PuzzlePiece01, RefreshCcw01, Stars01, Trash01, XClose, Zap } from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { restoreAppearance } from './appearance.js';

type Scenario = 'switch-running' | 'switch-failed' | 'switch-done' | 'update-running' | 'update-failed' | 'workspaces' | 'today';
type View = 'settings' | 'project';
type StepState = 'queued' | 'running' | 'succeeded' | 'failed';

const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: 'switch-running', label: 'Base branch switch: running' },
  { id: 'switch-failed', label: 'Base branch switch: failed' },
  { id: 'switch-done', label: 'Base branch switch: done' },
  { id: 'update-running', label: 'Update base: running' },
  { id: 'update-failed', label: 'Update base: failed' },
  { id: 'workspaces', label: 'Workspace archive, restore, delete' },
  { id: 'today', label: 'Today: the request held open' },
];

interface Operation {
  title: string;
  /** What the operation changes, said where the change shows. */
  summary: string;
  steps: readonly { label: string; state: StepState }[];
  elapsed: string;
  error?: string;
}

const SWITCH_STEPS = ['Copy develop from GitHub', 'Switch the base checkout', 'Record the new base branch'];
const UPDATE_STEPS = ['Fast-forward develop from origin', 'Move the base checkout'];
const steps = (labels: readonly string[], at: number, failed = false): Operation['steps'] => labels.map((label, index) => ({
  label, state: index < at ? 'succeeded' : index > at ? 'queued' : failed ? 'failed' : 'running',
}));

const OPERATIONS: Partial<Record<Scenario, Operation>> = {
  'switch-running': { title: 'Switching the base branch', summary: 'feat/agent-session-environments → develop', steps: steps(SWITCH_STEPS, 0), elapsed: '34 s' },
  'switch-failed': { title: 'Base branch switch failed', summary: 'feat/agent-session-environments → develop', steps: steps(SWITCH_STEPS, 0, true), elapsed: '53 s',
    error: 'Git push rejected: push is 86.5 MiB, limit is 64.0 MiB.' },
  'update-running': { title: 'Updating the base', summary: 'develop → origin/develop (12 commits)', steps: steps(UPDATE_STEPS, 1), elapsed: '8 s' },
  'update-failed': { title: 'Update base failed', summary: 'develop → origin/develop (12 commits)', steps: steps(UPDATE_STEPS, 1, true), elapsed: '11 s',
    error: 'Base workspace has uncommitted changes; commit or discard them before moving it forward.' },
};

const STEP_BADGE: Record<StepState, { label: string; color: 'gray' | 'amber' | 'green' | 'red' }> = {
  queued: { label: 'Waiting', color: 'gray' }, running: { label: 'Running', color: 'amber' }, succeeded: { label: 'Done', color: 'green' }, failed: { label: 'Failed', color: 'red' },
};

/** An operation where the change it makes shows: what it does, its steps, how long, and on failure the reason with
 * Retry and Dismiss. It runs on with the page closed. */
function OperationProgress({ operation }: { operation: Operation }): ReactElement {
  const shape = useShape();
  const failed = operation.error !== undefined;
  return <section aria-label={operation.title} className={`flex flex-col gap-2 bg-surface-2 p-3 ${shape.container} [overflow-wrap:anywhere]`}>
    <div className="flex items-center gap-2">
      {failed ? null : <ThinkingIndicator size="compact" className="shrink-0 p-0 [&>span[aria-hidden]]:hidden" />}
      <span className={`text-body font-medium ${failed ? 'text-destructive' : 'text-foreground'}`}>{operation.title}</span>
      <span className="ml-auto text-caption text-muted-foreground">{operation.elapsed}</span>
    </div>
    <span className="font-mono text-caption text-muted-foreground">{operation.summary}</span>
    <ol aria-label="Steps" className="flex flex-col gap-1">
      {operation.steps.map(step => <li key={step.label} className="flex min-w-0 items-center justify-between gap-3 text-caption text-foreground">
        <span className="min-w-0 truncate">{step.label}</span>
        <Badge variant="dot" size="compact" color={STEP_BADGE[step.state].color}>{STEP_BADGE[step.state].label}</Badge>
      </li>)}
    </ol>
    {failed
      ? <>
          <p role="alert" className="text-caption text-destructive">{operation.error}</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="compact" leadingIcon={glyph(RefreshCcw01)}>Retry</Button>
            <Button variant="ghost" size="compact" leadingIcon={glyph(XClose)}>Dismiss</Button>
          </div>
        </>
      : <span className="text-caption text-muted-foreground">Runs in the background: you can close this.</span>}
  </section>;
}

/** Project settings' layout: name, value, actions. */
function SettingRow({ label, value, note, actions }: { label: string; value: ReactNode; note?: ReactNode; actions?: ReactNode }): ReactElement {
  return <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-start gap-x-4 border-b border-border py-3 last:border-b-0">
    <span className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</span>
    <div className="flex min-w-0 flex-col gap-2 text-body">{value}{note ? <span className="text-caption text-muted-foreground">{note}</span> : null}</div>
    <div className="flex items-center gap-1">{actions}</div>
  </div>;
}

function SettingsDialog({ scenario }: { scenario: Scenario }): ReactElement {
  const operation = OPERATIONS[scenario];
  const switching = scenario.startsWith('switch') && scenario !== 'switch-done';
  const updating = scenario.startsWith('update');
  const branch = scenario === 'switch-done' ? 'develop' : 'feat/agent-session-environments';
  return <Dialog open><DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>GitSpace settings</DialogTitle><DialogDescription>Settings shared by every workspace in this project.</DialogDescription></DialogHeader>
    <div className="flex flex-col">
      <SettingRow label="Repository" value={<span className="truncate font-mono text-caption">https://github.com/inKibra/gitspace.sh.git</span>} actions={<Button variant="ghost" size="compact">Change</Button>} />
      {scenario === 'today'
        ? <SettingRow label="Base branch" value={<div className="flex flex-col gap-2">
            <span className="text-caption font-medium text-muted-foreground">New base branch</span>
            <span className="rounded border border-border px-3 py-2 font-mono text-caption">develop</span>
            <p role="alert" className="text-caption text-destructive">Change base branch: The request timed out. Its outcome may be unknown; refresh before trying again.</p>
            <div className="flex gap-2"><Button variant="secondary" size="compact">Save</Button><Button variant="ghost" size="compact">Cancel</Button></div>
          </div>} />
        : <SettingRow label="Base branch"
            value={<>
              <span className="font-mono text-caption">{branch}</span>
              {switching && operation ? <OperationProgress operation={operation} /> : null}
            </>}
            note={scenario === 'switch-done' ? 'Switched from feat/agent-session-environments 2 minutes ago.' : undefined}
            actions={switching ? null : <Button variant="ghost" size="compact">Change</Button>} />}
      <SettingRow label="Origin"
        value={<>
          <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            {updating || scenario === 'switch-done' ? null : <Badge size="compact" color="amber">Behind origin</Badge>}
            <span>origin/{branch} checked 11/2/2026, 9:41 AM</span>
          </div>
          {updating && operation ? <OperationProgress operation={operation} /> : null}
        </>}
        actions={updating || switching ? null : <><Button variant="secondary" size="compact">Update base</Button><Button variant="ghost" size="compact" leadingIcon={glyph(RefreshCcw01)}>Check origin</Button></>} />
    </div>
    <DialogFooter><Button variant="secondary">Done</Button></DialogFooter>
  </DialogContent></Dialog>;
}

/** The project's workspaces while their own operations run or after one failed. */
function WorkspaceCards(): ReactElement {
  return <CardGroup orientation="inline" border="outlined" separated>
    <Card index={0} size="compact" label="Open native-shell-audit">
      <CardHeader><CardTitle>native-shell-audit</CardTitle><CardDescription><span className="inline-flex items-center gap-1.5"><StatusDot color="blue" pulse />Archiving · stopping its runtime</span></CardDescription></CardHeader>
      <CardFooter />
    </Card>
    <Card index={1} size="compact" label="Open sign-in-with-apple">
      <CardHeader><CardTitle><span className="flex items-center gap-2 text-muted-foreground"><Archive width={14} height={14} strokeWidth={1.5} />sign-in-with-apple</span></CardTitle>
        <CardDescription><span className="inline-flex items-center gap-1.5"><StatusDot color="blue" pulse />Restoring</span></CardDescription></CardHeader>
      <CardFooter />
    </Card>
    <Card index={2} size="compact" label="Open tauri-plugin-alarm-kit">
      <CardHeader><CardTitle>tauri-plugin-alarm-kit</CardTitle>
        <CardDescription><span className="inline-flex items-center gap-1.5 text-destructive"><StatusDot color="red" />Delete failed: Delete workspace repository: An internal error occurred.</span></CardDescription></CardHeader>
      <CardFooter>
        <Tooltip content="Retry delete" side="top"><Button variant="ghost" size="icon-compact" aria-label="Retry delete"><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
        <Tooltip content="Dismiss" side="top"><Button variant="ghost" size="icon-compact" aria-label="Dismiss"><XClose width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
      </CardFooter>
    </Card>
    <Card index={3} size="compact" label="Open ux-review-zerbly">
      <CardHeader><CardTitle>ux-review-zerbly</CardTitle><CardDescription><span className="inline-flex items-center gap-1.5"><StatusDot color="green" />Waiting</span></CardDescription></CardHeader>
      <CardFooter>
        <Tooltip content="Archive workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label="Archive ux-review-zerbly"><Archive width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
        <Tooltip content="Delete workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label="Delete ux-review-zerbly"><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
      </CardFooter>
    </Card>
  </CardGroup>;
}

function ProjectsPage({ scenario }: { scenario: Scenario }): ReactElement {
  return <>
    <SidebarInsetTopbar><span className="text-body font-medium">Projects</span></SidebarInsetTopbar>
    <PageCanvas>
      <PageHeader title="Projects" description="Each project's workspaces, and the operations running on them." />
      <section className="flex flex-col gap-3">
        <h2 className="text-subtitle font-semibold text-foreground">{scenario === 'workspaces' ? 'inkibra core' : 'GitSpace'}</h2>
        {scenario === 'workspaces' ? <WorkspaceCards /> : <p className="text-caption text-muted-foreground">Project settings is open over this page.</p>}
      </section>
    </PageCanvas>
    {scenario === 'workspaces' ? null : <SettingsDialog scenario={scenario} />}
  </>;
}

/** The project page's top bar says what runs on the project, and opens its settings to the operation. */
function ProjectPage({ scenario }: { scenario: Scenario }): ReactElement {
  const operation = OPERATIONS[scenario];
  const failed = operation?.error !== undefined;
  return <>
    <SidebarInsetTopbar>
      <span className="inline-flex min-w-0 flex-1 items-center gap-2 truncate text-body">
        <span className="font-medium">GitSpace</span>
        <span className="inline-flex items-center gap-1 font-mono text-caption text-muted-foreground"><GitBranch01 width={12} height={12} strokeWidth={1.5} />{scenario === 'switch-done' ? 'develop' : 'feat/agent-session-environments'}</span>
      </span>
      {operation
        ? <Button variant="ghost" size="compact"><span className={`flex items-center gap-2 text-caption ${failed ? 'text-destructive' : 'text-muted-foreground'}`}><StatusDot color={failed ? 'red' : 'blue'} pulse={!failed} />{operation.title}{failed ? ' · Details' : ` · ${operation.steps.find(step => step.state === 'running')?.label ?? ''}`}</span></Button>
        : <span className="flex items-center gap-2 text-caption text-muted-foreground"><StatusDot color="green" />Ready</span>}
    </SidebarInsetTopbar>
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pt-10">
      <p className="max-w-xl text-caption text-muted-foreground">The project agent's conversation shows here as it does today. The project's agent keeps working while the operation runs; it learns the outcome from the operation's record.</p>
    </div>
  </>;
}

function MockSidebar({ scenario, view }: { scenario: Scenario; view: View }): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets & values', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  const operation = OPERATIONS[scenario];
  const busy = scenario === 'workspaces' ? 'inkibra core' : operation ? 'GitSpace' : null;
  const failed = operation?.error !== undefined;
  const dot = (name: string): IconComponent => function Dot() {
    return <StatusDot color={name !== busy ? 'blue' : failed ? 'red' : 'blue'} pulse={name === busy && !failed} />;
  };
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup collapsible><SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon} isActive={view === 'settings' && item.label === 'Projects'}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup collapsible><SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarMenu>
          {['GitSpace', 'Golconda IDF Data Vault', 'Golconda PPVA Enrollment', 'Landscaping Portal', 'inkibra core'].map(name => <SidebarMenuItem key={name}>
            <Tooltip content={name !== busy ? name : scenario === 'workspaces' ? `${name}: 2 workspace operations running, 1 failed` : `${name}: ${operation?.title ?? ''}`} side="right">
              <SidebarMenuButton icon={dot(name)} isActive={view === 'project' && name === 'GitSpace'}>{name}</SidebarMenuButton>
            </Tooltip>
          </SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>} menu={<MenuItem index={0} label="Settings" onSelect={() => undefined} />} /></SidebarFooter>
  </Sidebar>;
}

function OperationProgressMock(): ReactElement {
  const params = new URLSearchParams(window.location.search);
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS.find(item => item.id === params.get('scenario'))?.id ?? 'switch-running');
  const [view, setView] = useState<View>(params.get('view') === 'project' ? 'project' : 'settings');
  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <MockSidebar scenario={scenario} view={view} />
      <SidebarInset className="min-w-0">{view === 'settings' ? <ProjectsPage scenario={scenario} /> : <ProjectPage scenario={scenario} />}</SidebarInset>
    </SidebarProvider>
    <div className="fixed bottom-4 right-4 z-[60] flex gap-2">
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{view === 'settings' ? 'Projects + settings' : 'Project page'} (mock)</Button>} />
        <DropdownContent align="end" className="w-[220px] min-w-[220px]">
          <MenuItem index={0} label="Projects + settings" onSelect={() => setView('settings')} />
          <MenuItem index={1} label="Project page" onSelect={() => setView('project')} />
        </DropdownContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{SCENARIOS.find(item => item.id === scenario)?.label} (mock)</Button>} />
        <DropdownContent align="end" className="w-[300px] min-w-[300px]">
          {SCENARIOS.map((item, index) => <MenuItem key={item.id} index={index} label={item.label} onSelect={() => setScenario(item.id)} />)}
        </DropdownContent>
      </DropdownMenu>
    </div>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <OperationProgressMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
