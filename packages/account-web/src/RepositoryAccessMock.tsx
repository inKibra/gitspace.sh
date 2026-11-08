// Throwaway design mock: a project whose private repository the GitHub App does not cover yet and no machine bridges.
// It offers both ways in (the App, or a machine that can read the repository), tracks the install request (who, which
// organization, which repository, since when), and tells an organization owner exactly where to approve it. "Today"
// shows the old dead-end message. Static data only.
import {
  Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, DropdownContent, DropdownMenu, DropdownTrigger, IconProvider,
  MenuItem, ShapeProvider, Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider, TooltipProvider,
  untitledIcons, useShape, WorkspaceTile, type IconComponent, type IconComponentProps,
} from '@gitspace/ui';
import { Activity, Check, Clock, Columns03, Copy01, FolderClosed, GitBranch01, Key01, LinkExternal01, Lock01, PuzzlePiece01, RefreshCcw01, Stars01, Zap } from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { Composer } from './Composer.js';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { verticalSliceFixture } from './App.js';
import { restoreAppearance } from './appearance.js';
import { RepositoryAccessCard, type BlockedProjectAccess, type MachineCopyProps } from './GitHubAccess.js';

type State = 'needs-app' | 'requested' | 'not-selected' | 'importing' | 'today' | 'built';
type View = 'project' | 'settings';

const ORG = 'BrandByX';
const REPO = 'payne-portals';
const APP = 'GitSpace bradleat';
const STATES: readonly { id: State; label: string }[] = [
  { id: 'needs-app', label: 'App not installed on the organization' },
  { id: 'requested', label: 'Install requested, waiting on an owner' },
  { id: 'not-selected', label: 'Installed, repository not selected' },
  { id: 'importing', label: 'Approved: importing' },
  { id: 'today', label: 'Today: dead-end message' },
  { id: 'built', label: 'Built: the real cards, every state' },
];
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
/** The built card for each state it shows, with this project's data. */
const BUILT: readonly BlockedProjectAccess[] = [
  { state: 'needs-app', repository: `${ORG}/${REPO}`, organization: ORG, appName: APP, bridge: null, awaitsCopy: true },
  { state: 'needs-app', repository: `${ORG}/${REPO}`, organization: ORG, appName: APP, bridge: null, awaitsCopy: false },
  { state: 'requested', repository: `${ORG}/${REPO}`, organization: ORG, appName: APP, request: { id: 'request', organization: ORG, project: { id: 'portal', name: 'Harbor Portal' }, repository: `${ORG}/${REPO}`, firstRequestedAt: hoursAgo(17), lastRequestedAt: hoursAgo(8), times: 2 }, bridge: null, awaitsCopy: true },
  { state: 'not-selected', repository: `${ORG}/${REPO}`, organization: ORG, appName: APP, installation: { id: 7, account: { login: ORG, kind: 'organization' }, repositorySelection: 'selected', repositories: [`${ORG}/brandbyx-site`, `${ORG}/field-notes`], permissions: {}, installedAt: hoursAgo(3), projects: [] }, bridge: null, awaitsCopy: false },
  { state: 'needs-app', repository: `${ORG}/${REPO}`, organization: ORG, appName: null, bridge: null, awaitsCopy: true },
  { state: 'awaits-copy', origin: 'https://git.example.org/harbor/portal-assets.git' },
];
/** Two online machines; a copy fails the way a machine without SSH access to the repository fails. */
const MOCK_COPY: MachineCopyProps = {
  machines: [{ id: 'studio', label: 'studio-mac' }, { id: 'build', label: 'build-box' }],
  onCopy: async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 800);
    await promise;
    throw new Error('git ls-remote failed (exit 128): SSH authentication failed. Add the public key from Settings → Git to a GitHub account that can access this repository.');
  },
};

const icon = (Icon: typeof Lock01, size = 16): ReactNode => <Icon width={size} height={size} strokeWidth={1.5} />;

/** One step of getting access: done, current, or still to come. */
function Step({ state, title, detail }: { state: 'done' | 'current' | 'next'; title: ReactNode; detail?: ReactNode }): ReactElement {
  const shape = useShape();
  return <li className="flex gap-3">
    <span className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center ${shape.bg} ${state === 'done' ? 'bg-foreground text-background' : state === 'current' ? 'bg-active text-foreground ring-1 ring-inset ring-border' : 'text-muted-foreground ring-1 ring-inset ring-border'}`}>
      {state === 'done' ? icon(Check, 12) : state === 'current' ? icon(Clock, 12) : null}
    </span>
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={`text-body ${state === 'next' ? 'text-muted-foreground' : 'text-foreground'}`}>{title}</span>
      {detail ? <span className="text-caption text-muted-foreground">{detail}</span> : null}
    </span>
  </li>;
}

/** What an organization owner does on GitHub, written so it can be forwarded as is. */
function OwnerSteps(): ReactElement {
  const shape = useShape();
  return <div className={`flex flex-col gap-2 bg-surface-2 p-3 ${shape.container}`}>
    <span className="text-caption font-medium text-foreground">For an owner of {ORG}</span>
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-caption text-muted-foreground">
      <li>Open <span className="font-mono text-foreground">github.com/organizations/{ORG}/settings/installations</span></li>
      <li>Under <span className="text-foreground">Pending GitHub Apps installation requests</span>, find <span className="text-foreground">{APP}</span> and choose <span className="text-foreground">Review</span>.</li>
      <li>Allow <span className="text-foreground">{REPO}</span> (or all repositories), then <span className="text-foreground">Install</span>.</li>
    </ol>
    <span className="text-caption text-muted-foreground">GitHub also emails {ORG}'s owners about the request.</span>
  </div>;
}

/** The project page's access card: why the agent cannot start, and both ways in. */
function AccessCard({ state }: { state: Exclude<State, 'today'> }): ReactElement {
  const shape = useShape();
  const [copied, setCopied] = useState(false);
  const badge = state === 'needs-app' ? <Badge variant="dot" size="compact" color="gray">Not connected</Badge>
    : state === 'requested' ? <Badge variant="dot" size="compact" color="amber">Waiting on {ORG}</Badge>
    : state === 'not-selected' ? <Badge variant="dot" size="compact" color="amber">Repository not allowed</Badge>
    : <Badge variant="dot" size="compact" color="blue">Importing</Badge>;
  return <section aria-label="Repository access" className={`flex w-full max-w-[560px] flex-col gap-4 border border-border bg-card p-5 ${shape.container}`}>
    <div className="flex items-start justify-between gap-3">
      <span className="flex items-center gap-2 text-caption text-muted-foreground">{icon(Lock01, 14)}<span className="font-mono">{ORG}/{REPO}</span> · private</span>
      {badge}
    </div>
    {state === 'needs-app' ? <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Install your GitHub App on {ORG}</h2>
        <p className="text-body text-muted-foreground">This repository is private, and your GitHub App, <span className="text-foreground">{APP}</span>, isn't installed on {ORG}. This project's agent and workspaces start once GitSpace can read it, through the App or through one of your machines.</p>
      </div>
      <p className="text-caption text-muted-foreground">If you're not an owner of {ORG}, GitHub sends your install to its owners as a request, and this page tracks it.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>Install on {ORG}</Button>
      </div>
    </> : state === 'requested' ? <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Waiting for an owner of {ORG} to approve</h2>
        <p className="text-body text-muted-foreground">You asked to install <span className="text-foreground">{APP}</span> on {ORG}. Only an organization owner can approve it. GitSpace imports <span className="font-mono text-foreground">{REPO}</span> as soon as they do; nothing else is needed from you.</p>
      </div>
      <ol className="flex flex-col gap-3">
        <Step state="done" title="Requested by you" detail="Today, 6:16 PM · for BrandByX/payne-portals" />
        <Step state="current" title={`An owner of ${ORG} approves it on GitHub`} detail="Pending for 2 hours · checked 1 minute ago" />
        <Step state="next" title={`GitSpace imports ${REPO}`} detail="Starts on its own when GitHub reports the install." />
      </ol>
      <OwnerSteps />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="compact" type="button" leadingIcon={glyph(copied ? Check : Copy01)} onClick={() => setCopied(true)}>{copied ? 'Copied for the owner' : 'Copy steps for the owner'}</Button>
        <Button variant="secondary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>I'm an owner: open on GitHub</Button>
        <Button variant="ghost" size="compact" type="button" leadingIcon={glyph(RefreshCcw01)}>Check now</Button>
      </div>
    </> : state === 'not-selected' ? <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Allow {REPO} in the App on {ORG}</h2>
        <p className="text-body text-muted-foreground"><span className="text-foreground">{APP}</span> is installed on {ORG}, but only for selected repositories, and <span className="font-mono text-foreground">{REPO}</span> isn't one of them. An owner adds it in the App's repository access.</p>
      </div>
      <ol className="flex flex-col gap-3">
        <Step state="done" title={`Installed on ${ORG}`} detail="Selected repositories: brandbyx-site, field-notes" />
        <Step state="current" title={`${REPO} added to the App's repositories`} detail="GitHub → Settings → GitHub Apps → GitSpace bradleat → Configure → Repository access" />
        <Step state="next" title={`GitSpace imports ${REPO}`} />
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>Add {REPO} on GitHub</Button>
        <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(Copy01)}>Copy steps for an owner</Button>
      </div>
    </> : <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Importing {REPO}</h2>
        <p className="text-body text-muted-foreground">An owner of {ORG} approved the install. GitSpace is copying <span className="font-mono text-foreground">main</span> into the cloud; the agent starts when it finishes.</p>
      </div>
      <ol className="flex flex-col gap-3">
        <Step state="done" title="Requested by you" detail="Today, 6:16 PM" />
        <Step state="done" title={`Approved on ${ORG}`} detail="Today, 8:41 PM" />
        <Step state="current" title={`Importing ${REPO}`} detail="main · 1,240 files so far" />
      </ol>
    </>}
  </section>;
}

function ProjectPage({ state }: { state: State }): ReactElement {
  const shape = useShape();
  return <>
    <SidebarInsetTopbar>
      <span className="inline-flex min-w-0 flex-1 items-center gap-2 truncate text-body">
        <span className="font-medium">Harbor Portal</span>
        <span className="inline-flex items-center gap-1 font-mono text-caption text-muted-foreground">{icon(GitBranch01, 12)}main</span>
      </span>
      <span className="flex items-center gap-2 text-caption text-muted-foreground"><StatusDot color={state === 'importing' ? 'blue' : 'orange'} />{state === 'importing' ? 'Importing' : 'Needs access'}</span>
    </SidebarInsetTopbar>
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-6 pb-48 pt-10">
          {state === 'built'
            ? BUILT.map((access, index) => <RepositoryAccessCard key={index} access={access} copy={MOCK_COPY} onInstall={async () => '#'} onOpenSettings={() => undefined} onAttachMachine={() => undefined} />)
            : state === 'today'
              ? <p role="alert" className="w-full whitespace-pre-wrap break-words text-caption text-destructive">Cloud session control: This is a private repository, so GitSpace Cloud can't import it. Create a workspace in this project with a machine connected; the machine does the initial import.</p>
              : <AccessCard state={state} />}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-4">
        <div className="w-full max-w-xl">
          {state === 'today' ? null : <div className={`pointer-events-auto mb-2 bg-surface-3 px-3 py-2 text-caption text-muted-foreground shadow-surface-1 ${shape.container}`}>The project agent starts once GitSpace can read {ORG}/{REPO}.</div>}
          <div className={state === 'today' ? 'pointer-events-auto' : 'pointer-events-none opacity-50'}><Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} /></div>
        </div>
      </div>
    </div>
  </>;
}

function monogram(letter: string): IconComponent {
  return function Monogram({ className }: IconComponentProps) { return <span aria-hidden className={`text-[12px] font-semibold leading-none ${className ?? ''}`}>{letter}</span>; };
}
const INKIBRA = monogram('I');
const BRANDBYX = monogram('B');

/** Settings → GitHub's installations, with the pending request named and tracked. */
function SettingsPage({ state }: { state: State }): ReactElement {
  return <>
    <SidebarInsetTopbar><span className="text-body font-medium">Account settings</span></SidebarInsetTopbar>
    <PageCanvas>
      <PageHeader kicker="GitHub" title="Your GitHub App" description={`${APP} reads your private repositories and sends their webhooks here. GitSpace can only reach a private repository the App is allowed on.`} />
      <section className="flex flex-col gap-3" aria-label="Installations">
        <h2 className="text-subtitle font-semibold text-foreground">Installations</h2>
        <CardGroup orientation="inline" border="outlined" separated proximityHover={false}>
          <Card size="compact" index={0}>
            <CardMedia icon={INKIBRA} />
            <CardHeader><span className="text-body font-medium text-foreground">inKibra</span><CardDescription>inKibra/core, inKibra/gitspace.sh · projects GitSpace, inkibra core</CardDescription></CardHeader>
            <CardFooter><Badge variant="dot" size="compact" color="green">Installed</Badge></CardFooter>
          </Card>
          <Card size="compact" index={1} className="flex-wrap">
            <CardMedia icon={BRANDBYX} />
            <CardHeader>
              <span className="text-body font-medium text-foreground">{ORG}</span>
              <CardDescription>{state === 'not-selected' ? 'Installed for brandbyx-site, field-notes · not payne-portals' : state === 'importing' ? 'Installed · payne-portals importing' : `Requested for ${REPO} · project Harbor Portal`}</CardDescription>
            </CardHeader>
            <CardFooter>
              {state === 'not-selected' ? <Badge variant="dot" size="compact" color="amber">Repository not allowed</Badge>
                : state === 'importing' ? <Badge variant="dot" size="compact" color="green">Installed</Badge>
                : <Badge variant="dot" size="compact" color="amber">Waiting on an owner</Badge>}
            </CardFooter>
            {state === 'requested' || state === 'needs-app' || state === 'today'
              ? <div className="flex basis-full flex-col gap-2 pb-3 pl-[42px] pr-3 text-caption text-muted-foreground">
                  <span>You requested it today at 6:16 PM; it has been pending for 2 hours. GitSpace checks every few minutes and imports {REPO} once an owner installs it.</span>
                  <span>Owners approve it at <span className="font-mono text-foreground">github.com/organizations/{ORG}/settings/installations</span> → Pending GitHub Apps installation requests → {APP} → Review → Install.</span>
                  <span className="flex flex-wrap gap-2 pt-1">
                    <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(Copy01)}>Copy steps for the owner</Button>
                    <Button variant="ghost" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>Open on GitHub</Button>
                    <Button variant="ghost" size="compact" type="button">Withdraw request</Button>
                  </span>
                </div>
              : null}
          </Card>
        </CardGroup>
      </section>
    </PageCanvas>
  </>;
}

function MockSidebar({ view }: { view: View }): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets & values', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  const dot = (color: 'blue' | 'orange' | 'green'): IconComponent => function Dot() { return <StatusDot color={color} />; };
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup collapsible><SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup collapsible><SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarMenu>
          {['GitSpace', 'Ledger', 'Crumb', 'Harbor Portal', 'Field notes'].map(name => <SidebarMenuItem key={name}>
            <SidebarMenuButton icon={dot(name === 'Harbor Portal' ? 'orange' : 'blue')} isActive={view === 'project' && name === 'Harbor Portal'}>{name}</SidebarMenuButton>
          </SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>} menu={<MenuItem index={0} label="Settings" onSelect={() => undefined} />} /></SidebarFooter>
  </Sidebar>;
}

function RepositoryAccessMock(): ReactElement {
  const [state, setState] = useState<State>('requested');
  const [view, setView] = useState<View>('project');
  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <MockSidebar view={view} />
      <SidebarInset className="min-w-0">{view === 'project' ? <ProjectPage state={state} /> : <SettingsPage state={state} />}</SidebarInset>
    </SidebarProvider>
    <div className="fixed right-4 top-3 z-50 flex gap-2">
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{view === 'project' ? 'Project page' : 'Settings → GitHub'} (mock)</Button>} />
        <DropdownContent align="end" className="w-[220px] min-w-[220px]">
          <MenuItem index={0} label="Project page" onSelect={() => setView('project')} />
          <MenuItem index={1} label="Settings → GitHub" onSelect={() => setView('settings')} />
        </DropdownContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{STATES.find(item => item.id === state)?.label} (mock)</Button>} />
        <DropdownContent align="end" className="w-[300px] min-w-[300px]">
          {STATES.map((item, index) => <MenuItem key={item.id} index={index} label={item.label} onSelect={() => setState(item.id)} />)}
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
    <RepositoryAccessMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
