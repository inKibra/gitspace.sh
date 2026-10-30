// Throwaway design mock (docs/TENANT-RELEASES-DESIGN.md, docs/AUTOMATIONS-DESIGN.md §4a): how the sidebar, the GitSpace
// project's page and agent, and Settings → Releases track the account's default release, upstream releases and
// workspace trials. Static data only; not part of the app.
import {
  Badge, Button, Card, CardDescription, CardFooter, CardHeader, CardTitle,
  DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, MenuItem,
  Select, SelectContent, SelectItem, SelectTrigger, ShapeProvider, Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar, SidebarMenu, SidebarMenuAction, SidebarMenuActions,
  SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider,
  SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider, Tooltip, TooltipProvider, untitledIcons, useShape, WorkspaceTile,
  type IconComponent, type IconComponentProps,
} from '@gitspace/ui';
import {
  Activity, ArrowUp, ChevronRight, Columns03, DotsHorizontal, FolderClosed, Key01, MessageChatCircle, PuzzlePiece01,
  RefreshCcw01, Rocket02, Settings01, Stars01, Zap,
} from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { restoreAppearance } from './appearance.js';

type Source = 'upstream' | 'fork';
type Situation = 'available' | 'trial' | 'current';
type Page = 'project' | 'settings';
const SOURCE_LABEL: Record<Source, string> = { upstream: 'Upstream · inKibra/gitspace.sh · develop', fork: 'Fork · bradleat/gitspace.sh · ui-experiments' };
const SITUATION_LABEL: Record<Situation, string> = { available: 'A new upstream release', trial: 'A workspace trial running', current: 'Up to date' };
const PAGE_LABEL: Record<Page, string> = { project: 'GitSpace project', settings: 'Settings → Releases' };
/** What the GitSpace project launches to make a release the default. */
const BRANCH: Record<Source, string> = { upstream: 'develop', fork: 'ui-experiments' };
const DEFAULT_RELEASE: Record<Source, string> = { upstream: 'v0.2.0-rc.41', fork: 'ui-experiments @ 9b7e0d1' };

const code = (text: string) => <code className="font-mono text-caption">{text}</code>;

/** A sidebar row's status dot as an icon, the way the real sidebar draws each workspace's status. */
const STATUS_GLYPH: Record<'green' | 'blue' | 'dim', IconComponent> = {
  green: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="green" pulse /></span>,
  blue: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="blue" /></span>,
  dim: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="dim" /></span>,
};

interface Workspace { name: string; status: 'green' | 'blue' | 'dim'; trial?: true }
/** The workspace the project agent started to merge an upstream release into a fork. */
const MERGE_WORKSPACE: Workspace = { name: 'merge-v0-2-0-rc-42', status: 'green' };
function workspaces(source: Source, situation: Situation): readonly Workspace[] {
  return [
    { name: 'automations-watch-ui', status: 'blue', ...(situation === 'trial' ? { trial: true } : {}) },
    { name: 'machine-installs', status: 'dim' },
    { name: 'upgrade-pi-v1-4-0', status: 'dim' },
    ...(source === 'fork' && situation === 'available' ? [MERGE_WORKSPACE] : []),
  ];
}

/** What the sidebar's Source pill says: the default release, a newer upstream one, or the trial in front of it. */
function sourcePill(source: Source, situation: Situation): string {
  if (situation === 'trial') return 'Trial · automations-watch-ui';
  if (situation === 'available') return `${DEFAULT_RELEASE[source]} · rc.42 available`;
  return `${DEFAULT_RELEASE[source]} · default`;
}

function AppSidebarMock({ source, situation, page, onPage }: { source: Source; situation: Situation; page: Page; onPage(page: Page): void }): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  const trialMenu = situation === 'trial';
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup collapsible>
        <SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup collapsible>
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton icon={STATUS_GLYPH.blue} isActive={page === 'project'} onClick={() => onPage('project')}
              title={situation === 'available' ? 'GitSpace v0.2.0-rc.42 is available: the project agent is offering it' : 'GitSpace'}>
              GitSpace{situation === 'available' ? <span className="ml-1 inline-flex shrink-0 items-center text-primary" role="img" aria-label="A new GitSpace release is available"><ArrowUp width={12} height={12} strokeWidth={1.75} /></span> : null}
            </SidebarMenuButton>
            <SidebarMenuActions>
              <SidebarMenuAction aria-label="Collapse GitSpace" aria-expanded><ChevronRight width={16} height={16} strokeWidth={1.5} className="rotate-90" /></SidebarMenuAction>
              <DropdownMenu>
                <DropdownTrigger render={<SidebarMenuAction aria-label="Space actions for GitSpace"><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                <DropdownContent className="min-w-[260px] w-[260px]" align="start" sideOffset={4}>
                  <MenuItem index={0} icon={glyph(FolderClosed)} label="Open project" onSelect={() => onPage('project')} />
                  <MenuItem index={1} icon={glyph(Settings01)} label="Project settings" onSelect={() => undefined} />
                  <MenuItem index={2} icon={glyph(Zap)} label="Automations" onSelect={() => undefined} />
                  <MenuItem index={3} icon={glyph(Rocket02)} label={`Launch ${BRANCH[source]} as the default`} onSelect={() => undefined} />
                  {situation === 'available' && source === 'upstream' ? <MenuItem index={4} icon={glyph(ArrowUp)} label="Launch v0.2.0-rc.42 (GitHub's build)" onSelect={() => undefined} /> : null}
                  <MenuItem index={5} icon={glyph(RefreshCcw01)} label="Back to default" onSelect={() => undefined} />
                </DropdownContent>
              </DropdownMenu>
            </SidebarMenuActions>
            <SidebarMenuSub open>{workspaces(source, situation).map(workspace => <SidebarMenuSubItem key={workspace.name}>
              <SidebarMenuSubButton render={<button type="button" />} icon={STATUS_GLYPH[workspace.status]}
                title={workspace.trial ? 'Its frontend is a trial on this account; Back to default returns it' : workspace.name}>
                {workspace.name}{workspace.trial ? <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" role="img" aria-label="Running as a trial"><Rocket02 width={12} height={12} strokeWidth={1.5} /></span> : null}
              </SidebarMenuSubButton>
              <SidebarMenuActions showOnHover>
                <DropdownMenu>
                  <DropdownTrigger render={<SidebarMenuAction aria-label={`Space actions for ${workspace.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                  <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
                    <MenuItem index={0} icon={glyph(Rocket02)} label="Launch from here as a trial" onSelect={() => undefined} />
                    {workspace.trial && trialMenu ? <MenuItem index={1} icon={glyph(RefreshCcw01)} label="Back to default" onSelect={() => undefined} /> : null}
                  </DropdownContent>
                </DropdownMenu>
              </SidebarMenuActions>
            </SidebarMenuSubItem>)}</SidebarMenuSub>
          </SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton icon={STATUS_GLYPH.dim}>inkibra core</SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu><SidebarMenuItem>
        <Tooltip content="What this account runs; opens Settings → Releases" side="top">
          <SidebarMenuButton size="sm" icon={glyph(situation === 'available' ? ArrowUp : Rocket02)} isActive={page === 'settings'} onClick={() => onPage('settings')}
            className={situation === 'available' ? '[&_span]:text-primary' : undefined}>
            <span className="truncate">{sourcePill(source, situation)}</span>
          </SidebarMenuButton>
        </Tooltip>
      </SidebarMenuItem></SidebarMenu>
      <SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>}
        menu={<MenuItem index={0} icon={glyph(Settings01)} label="Settings" onSelect={() => onPage('settings')} />} />
    </SidebarFooter>
  </Sidebar>;
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <>
    <dt className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-body text-foreground">{children}</dd>
  </>;
}

/** The GitSpace project page's aside: what the project builds and the releases it tracks for the account. */
function ReleasesAside({ source, situation, onSettings }: { source: Source; situation: Situation; onSettings(): void }): ReactElement {
  const shape = useShape();
  return <aside aria-label="Releases" className={`${shape.container} flex flex-col gap-4 bg-surface-2 p-4 shadow-surface-1`}>
    <strong className="text-body font-semibold">Releases</strong>
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
      <Detail label="Builds">{source === 'upstream' ? <>{code('inKibra/gitspace.sh')} · {code('develop')}</> : <>{code('bradleat/gitspace.sh')} · {code('ui-experiments')}<span className="block text-caption text-muted-foreground">a fork of inKibra/gitspace.sh</span></>}</Detail>
      <Detail label="Default">{code(DEFAULT_RELEASE[source])}<span className="block text-caption text-muted-foreground">{source === 'upstream' ? 'GitHub\'s build · launched 2 d ago' : 'built on Darktop · launched 4 d ago'}</span></Detail>
      <Detail label="Upstream">{situation === 'available'
        ? <>{code('v0.2.0-rc.42')} <Badge size="compact" color="blue">New</Badge><span className="block text-caption text-muted-foreground">{source === 'upstream' ? 'released 2 h ago · offered below' : 'released 2 h ago · merging in merge-v0-2-0-rc-42'}</span></>
        : <>{code('v0.2.0-rc.41')}<span className="block text-caption text-muted-foreground">{source === 'upstream' ? 'this account runs it' : 'merged into ui-experiments'}</span></>}</Detail>
      <Detail label="Trials">{situation === 'trial'
        ? <>{code('automations-watch-ui')}<span className="block text-caption text-muted-foreground">frontend · a1b2c3d + 4 uncommitted · 3 h ago</span></>
        : <span className="text-muted-foreground">None running</span>}</Detail>
    </dl>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(RefreshCcw01)} disabled={situation !== 'trial'}>Back to default</Button>
      <Button variant="ghost" size="compact" type="button" onClick={onSettings}>All releases</Button>
    </div>
    <p className="text-caption text-muted-foreground">The project agent reads this with its release tools; the GitSpace releases automation tells it when upstream publishes a release.</p>
  </aside>;
}

function Bubble({ who, children, aside }: { who: 'agent' | 'you' | 'notice'; children: ReactNode; aside?: string }): ReactElement {
  const shape = useShape();
  if (who === 'notice') return <div className="flex items-start gap-2 text-caption text-muted-foreground"><Zap className="mt-0.5 shrink-0" width={14} height={14} strokeWidth={1.5} /><span>{children}</span></div>;
  return <div className={`flex flex-col gap-1 ${who === 'you' ? 'items-end' : 'items-start'}`}>
    <span className="text-caption text-muted-foreground">{who === 'you' ? 'You' : 'Project agent'}{aside ? ` · ${aside}` : ''}</span>
    <div className={`${shape.container} max-w-[46rem] px-4 py-3 text-body ${who === 'you' ? 'bg-surface-3' : 'bg-surface-2 shadow-surface-1'}`}>{children}</div>
  </div>;
}

function ToolLine({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex flex-wrap items-baseline gap-x-2 pl-1 text-caption text-muted-foreground"><span className="font-mono">deployment.status</span><span className="min-w-0">· {children}</span></div>;
}

/** The project agent's conversation: what the release automation and a trial look like to it and to you. */
function Conversation({ source, situation }: { source: Source; situation: Situation }): ReactElement {
  if (situation === 'trial') return <div className="flex flex-col gap-4">
    <Bubble who="notice">automations-watch-ui launched its frontend as a trial · 3 h ago</Bubble>
    <Bubble who="you">is the trial still up? I want to show Dana the new watch editor</Bubble>
    <ToolLine>default {DEFAULT_RELEASE[source]} · trial: frontend from automations-watch-ui (a1b2c3d + 4 uncommitted)</ToolLine>
    <Bubble who="agent">Yes. The frontend is the trial from <strong>automations-watch-ui</strong>, launched 3 h ago; the worker and both machines are still on the default, {code(DEFAULT_RELEASE[source])}. Say when you are done and I will go back to the default, or use Back to default yourself.</Bubble>
  </div>;
  if (situation === 'current') return <div className="flex flex-col gap-4">
    <Bubble who="notice">GitSpace releases · inKibra/gitspace.sh v0.2.0-rc.41 · 2 d ago</Bubble>
    <Bubble who="agent" aside="2 d ago">{source === 'upstream'
      ? <>v0.2.0-rc.41 is the default now: the worker, the frontend and both machines run it.</>
      : <>v0.2.0-rc.41 is merged into {code('ui-experiments')} (PR #18), and {code('ui-experiments @ 9b7e0d1')} is the default: built on Darktop and running everywhere.</>}</Bubble>
    <Bubble who="notice">Nothing new upstream since. The next check is in 38 min.</Bubble>
  </div>;
  return <div className="flex flex-col gap-4">
    <Bubble who="notice">GitSpace releases · inKibra/gitspace.sh published v0.2.0-rc.42 · 2 h ago · checked every hour</Bubble>
    <ToolLine>default {DEFAULT_RELEASE[source]} · upstream v0.2.0-rc.42, build 7c0d1e4…:51aa09… · no trials</ToolLine>
    {source === 'upstream'
      ? <Bubble who="agent" aside="2 h ago">
        <p>GitSpace <strong>v0.2.0-rc.42</strong> is out, and GitHub already built it, so nothing is built here. Since your default, v0.2.0-rc.41:</p>
        <ul className="my-2 list-disc pl-5"><li>machines download LFS files without the CPU limit failures</li><li>a stuck supervisor no longer blocks a checkout</li><li>pushes declare Artifacts' shallow boundaries</li></ul>
        <p>Launching swaps the worker and the frontend now; Darktop and Lightbook follow as they go idle. Workspaces are unaffected.</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button variant="primary" size="compact" type="button" leadingIcon={glyph(Rocket02)}>Launch v0.2.0-rc.42</Button><Button variant="secondary" size="compact" type="button">Not now</Button></div>
      </Bubble>
      : <>
        <Bubble who="agent" aside="2 h ago">
          <p>GitSpace <strong>v0.2.0-rc.42</strong> is out. Your fork's {code('ui-experiments')} is 14 commits ahead of upstream, and rc.42 touches 2 files you changed. I can merge it in a new workspace and open a pull request on bradleat/gitspace.sh.</p>
          <div className="mt-3 flex flex-wrap gap-2"><Button variant="primary" size="compact" type="button">Merge in a workspace</Button><Button variant="secondary" size="compact" type="button">Not now</Button></div>
        </Bubble>
        <Bubble who="you">merge it</Bubble>
        <Bubble who="agent" aside="1 h ago">Started <strong>merge-v0-2-0-rc-42</strong> in Code. It resolved both conflicts and opened PR #19 into {code('ui-experiments')}. When it is merged I will offer to build and launch it as the default.</Bubble>
      </>}
  </div>;
}

function ProjectPage({ source, situation, onSettings }: { source: Source; situation: Situation; onSettings(): void }): ReactElement {
  const shape = useShape();
  return <div className="flex min-h-0 flex-1 flex-col gap-6 px-6 py-6 lg:flex-row">
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-2"><MessageChatCircle width={16} height={16} strokeWidth={1.5} className="text-muted-foreground" /><strong className="text-body font-semibold">GitSpace · project agent</strong><Badge size="compact" color="gray">Built in</Badge></div>
      <Conversation source={source} situation={situation} />
      <div className={`${shape.container} mt-auto border border-border bg-background px-4 py-3 text-body text-muted-foreground`}>Ask the project agent…</div>
    </div>
    <div className="order-first w-full shrink-0 lg:order-none lg:w-72"><ReleasesAside source={source} situation={situation} onSettings={onSettings} /></div>
  </div>;
}

interface ReleaseView { label: string; detail: string; badges: readonly { text: string; color: 'blue' | 'gray' | 'green' | 'amber' }[] }
const AVAILABLE_RELEASE: ReleaseView = { label: 'v0.2.0-rc.42', detail: 'GitHub\'s build of inKibra/gitspace.sh · released 2 h ago · not launched', badges: [{ text: 'Available', color: 'amber' }] };
const TRIAL_RELEASE: ReleaseView = { label: 'automations-watch-ui @ a1b2c3d + 4 uncommitted', detail: 'built on Darktop from a workspace · 3 h ago', badges: [{ text: 'Trial · frontend', color: 'green' }] };
function releases(source: Source, situation: Situation): readonly ReleaseView[] {
  const def: ReleaseView = source === 'upstream'
    ? { label: 'v0.2.0-rc.41', detail: 'GitHub\'s build of inKibra/gitspace.sh develop @ 3e1f2c9 · launched by the project agent 2 d ago', badges: [{ text: 'Default', color: 'blue' }] }
    : { label: 'ui-experiments @ 9b7e0d1', detail: 'built on Darktop from bradleat/gitspace.sh · launched 4 d ago', badges: [{ text: 'Default', color: 'blue' }] };
  return [
    ...(situation === 'available' && source === 'upstream' ? [AVAILABLE_RELEASE] : []),
    ...(situation === 'trial' ? [TRIAL_RELEASE] : []),
    def,
    { label: 'v0.2.0-rc.40', detail: 'GitHub\'s build · default until 2 d ago', badges: [{ text: 'Earlier', color: 'gray' }] },
  ];
}

function SettingsPage({ source, situation }: { source: Source; situation: Situation }): ReactElement {
  const shape = useShape();
  const box = `${shape.container} bg-surface-2 px-5 py-4 shadow-surface-1`;
  return <PageCanvas>
    <PageHeader kicker="Settings" title="Releases" description="What this account runs. The GitSpace project decides the default release; workspaces can try their own versions without changing it." />
    <section aria-label="Running" className="mb-6 flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold">Running</h2>
      <div className={box}><dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Detail label="Worker">{code(DEFAULT_RELEASE[source])}</Detail>
        <Detail label="Frontend">{situation === 'trial' ? <>{code('automations-watch-ui @ a1b2c3d')} <Badge size="compact" color="green">Trial</Badge></> : code(DEFAULT_RELEASE[source])}</Detail>
        <Detail label="Machines">Darktop, Lightbook · {code(DEFAULT_RELEASE[source])}</Detail>
      </dl></div>
    </section>
    <section aria-label="Default release" className="mb-6 flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold">Default release</h2>
      <div className={`${box} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex flex-col gap-0.5"><span className="text-body">{code(DEFAULT_RELEASE[source])}</span>
          <span className="text-caption text-muted-foreground">Set when the GitSpace project launches {code(BRANCH[source])} from {source === 'upstream' ? 'inKibra/gitspace.sh' : 'bradleat/gitspace.sh'}. Machines with no selection and new computers follow it.</span></div>
        <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(RefreshCcw01)} disabled={situation !== 'trial'}>Back to default</Button>
      </div>
      {situation === 'available' ? <p className="text-caption text-muted-foreground">{source === 'upstream' ? 'v0.2.0-rc.42 is available. The project agent offered it in its conversation.' : 'v0.2.0-rc.42 is available upstream. The project agent is merging it into ui-experiments (PR #19).'}</p> : null}
    </section>
    <section aria-label="All releases" className="flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold">All releases</h2>
      <div className="flex flex-col gap-3">{releases(source, situation).map((release, index) => <Card key={release.label} size="compact" index={index}>
        <CardHeader><CardTitle>{release.label}</CardTitle><CardDescription>{release.detail}</CardDescription></CardHeader>
        <CardFooter>{release.badges.map(badge => <Badge key={badge.text} variant="dot" color={badge.color}>{badge.text}</Badge>)}</CardFooter>
      </Card>)}</div>
    </section>
  </PageCanvas>;
}

function MockControls({ source, situation, page, onSource, onSituation, onPage }: { source: Source; situation: Situation; page: Page; onSource(source: Source): void; onSituation(situation: Situation): void; onPage(page: Page): void }): ReactElement {
  const control = <T extends string>(label: string, value: T, labels: Record<T, string>, set: (value: T) => void) => {
    const entries = Object.entries(labels).filter((entry): entry is [T, string] => typeof entry[1] === 'string');
    return <label className="flex w-64 max-w-full min-w-0 flex-col gap-1"><span className="text-caption font-medium text-muted-foreground">{label}</span>
      <Select value={labels[value]} onValueChange={picked => { const found = entries.find(([, text]) => text === picked); if (found) set(found[0]); }}>
        <SelectTrigger aria-label={label} />
        <SelectContent>{entries.map(([key, text], index) => <SelectItem key={key} value={text} index={index}>{text}</SelectItem>)}</SelectContent>
      </Select></label>;
  };
  return <div className="flex flex-wrap items-end gap-3 border-b border-border bg-surface-2 px-4 py-2">
    {control('The project builds', source, SOURCE_LABEL, onSource)}
    {control('Situation', situation, SITUATION_LABEL, onSituation)}
    {control('Page', page, PAGE_LABEL, onPage)}
  </div>;
}

function GitSpaceProjectMock(): ReactElement {
  const [source, setSource] = useState<Source>('upstream');
  const [situation, setSituation] = useState<Situation>('available');
  const [page, setPage] = useState<Page>('project');
  return <div className="flex h-dvh flex-col bg-background">
    <MockControls source={source} situation={situation} page={page} onSource={setSource} onSituation={setSituation} onPage={setPage} />
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <AppSidebarMock source={source} situation={situation} page={page} onPage={setPage} />
      <SidebarInset className="min-w-0 overflow-auto">
        <SidebarInsetTopbar><span className="truncate text-body font-medium">{page === 'project' ? 'GitSpace' : 'Settings'}</span></SidebarInsetTopbar>
        {page === 'project' ? <ProjectPage source={source} situation={situation} onSettings={() => setPage('settings')} /> : <SettingsPage source={source} situation={situation} />}
      </SidebarInset>
    </SidebarProvider>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <GitSpaceProjectMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
