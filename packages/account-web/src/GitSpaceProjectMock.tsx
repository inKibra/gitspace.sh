// Throwaway design mock (docs/TENANT-RELEASES-DESIGN.md, docs/AUTOMATIONS-DESIGN.md §4a): the GitSpace project agent asks
// about releases, branch changes and trials. Everything else is the app's existing project UI: the settings dialog
// (with the new Repository and Check the origin settings every project gets), Behind origin · Update, the space menu.
// Static data only; not part of the app.
import type { AskBlock } from '@gitspace/blocks';
import {
  Badge, Button, Card, CardDescription, CardFooter, CardHeader, CardTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, InputField, InputGroup, MenuItem,
  Select, SelectContent, SelectItem, SelectTrigger, ShapeProvider, Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar, SidebarMenu, SidebarMenuAction, SidebarMenuActions,
  SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider,
  SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider, Tooltip, TooltipProvider, untitledIcons, useShape, WorkspaceTile,
  type IconComponent, type IconComponentProps,
} from '@gitspace/ui';
import {
  Activity, Archive, ArrowDown, ChevronRight, Columns03, DotsHorizontal, FolderClosed, Key01, Plus, PuzzlePiece01,
  RefreshCcw01, Rocket02, Settings01, Stars01, XClose, Zap,
} from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { AskBlockView } from './TurnTranscript.js';
import { restoreAppearance } from './appearance.js';

/** Whether the GitSpace project's repository is upstream GitSpace or anything else (a fork, in this mock). */
type Source = 'upstream' | 'fork';
/** The newest event the project agent was told about, or none. */
type Event = 'release' | 'branch' | 'trial' | null;
type Page = 'agent' | 'releases';
const UPSTREAM = 'inKibra/gitspace.sh';
const FORK = 'bradleat/gitspace.sh';
const FORK_BRANCH = 'ui-experiments';
const PAGE_TITLE: Record<Page, string> = { agent: 'GitSpace', releases: 'Settings' };

const code = (text: string) => <code className="font-mono text-caption">{text}</code>;

type Dot = 'green' | 'blue' | 'orange' | 'dim';
/** A sidebar row's status dot as an icon, the way the real sidebar draws each space's status. */
const STATUS_GLYPH: Record<Dot, IconComponent> = {
  green: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="green" pulse /></span>,
  blue: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="blue" /></span>,
  orange: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="orange" /></span>,
  dim: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="dim" /></span>,
};

/** The GitSpace project as the app knows any project: its repository and base branch, and whether its copy is behind. */
interface Project { repository: string; baseBranch: string; behind: boolean }
/** What the account runs: the default release, and a trial in front of it. */
interface Running { defaultRelease: string; trial: string | null }

interface Option { id: string; title: string; description: string }
/** What the project agent asks about the newest event, if it asks at all. */
interface Ask { lead: ReactNode; prompt: string; options: readonly Option[] }

function ask(event: Event, source: Source, branch: string, running: Running): Ask | null {
  if (event === 'release' && source === 'upstream') return {
    lead: <>GitSpace <strong>v0.2.0-rc.42</strong> is out, and GitHub already built it. Since your default ({code(running.defaultRelease)}): machines download LFS files without CPU limit failures, a stuck supervisor no longer blocks a checkout, and pushes declare Artifacts' shallow boundaries.</>,
    prompt: 'Update this account to GitSpace v0.2.0-rc.42?',
    options: [
      { id: 'launch-release', title: 'Launch it now', description: 'The worker and frontend swap now; Darktop and Lightbook follow as they go idle. Nothing is built here.' },
      { id: 'later', title: 'Not now', description: 'I ask again with the next release.' },
      { id: 'skip', title: 'Skip this release', description: 'I will not ask about rc.42 again.' },
    ],
  };
  if (event === 'release') return {
    lead: <>GitSpace <strong>v0.2.0-rc.42</strong> is out upstream. {code(branch)} is 14 commits ahead of upstream, and rc.42 touches 2 files you changed.</>,
    prompt: `Bring v0.2.0-rc.42 into ${branch}?`,
    options: [
      { id: 'merge', title: 'Merge it in a workspace and open a PR', description: `I resolve what I can in merge-v0-2-0-rc-42 and open a pull request into ${branch}.` },
      { id: 'later', title: 'Not now', description: 'I ask again with the next release.' },
      { id: 'skip', title: 'Skip this release', description: 'I will not ask about rc.42 again.' },
    ],
  };
  // On upstream a moving develop is not a release: the project only shows Behind origin, with Update base.
  if (event === 'branch' && source === 'fork') return {
    lead: <>PR #20 (watch editor) and PR #21 (release cards) are merged into {code(branch)} since your default, and its checks pass. They are not a release, so launching builds them on Darktop.</>,
    prompt: `Build ${branch} @ 5f2a9c1 and launch it as the default?`,
    options: [
      { id: 'launch-branch', title: 'Build on Darktop and launch', description: 'About 6 minutes to build; then it is the default for the worker, the frontend and the machines.' },
      { id: 'trial-branch', title: 'Launch the frontend as a trial first', description: 'The default stays; Back to default undoes it.' },
      { id: 'later', title: 'Not now', description: 'I ask again when more changes land.' },
    ],
  };
  if (event === 'trial' && source === 'upstream') return {
    lead: <>The frontend from <strong>automations-watch-ui</strong> has been a trial for a day, and you said it looks good. To make it your default its changes have to be on a branch this project builds, and you cannot push to {code(`${UPSTREAM} ${branch}`)}.</>,
    prompt: 'How do you want to keep the automations-watch-ui changes?',
    options: [
      { id: 'pr-upstream', title: 'Open a PR upstream and keep the trial', description: 'It becomes part of a GitSpace release if the maintainers merge it.' },
      { id: 'move-to-fork', title: `Move GitSpace to your fork, ${FORK}`, description: `I set this project's repository to ${FORK} and its base branch to ${FORK_BRANCH}, merge the workspace there, build and launch it as the default.` },
      { id: 'keep', title: 'Keep the trial', description: 'I ask again in a week.' },
      { id: 'back', title: 'Back to default', description: `The frontend returns to ${running.defaultRelease}.` },
    ],
  };
  if (event === 'trial') return {
    lead: <>The frontend from <strong>automations-watch-ui</strong> has been a trial for a day, and you said it looks good.</>,
    prompt: 'Promote the automations-watch-ui trial?',
    options: [
      { id: 'merge-trial', title: `Merge into ${branch}, then build and launch`, description: 'It becomes the default release.' },
      { id: 'keep', title: 'Keep the trial', description: 'I ask again in a week.' },
      { id: 'back', title: 'Back to default', description: `The frontend returns to ${running.defaultRelease}.` },
    ],
  };
  return null;
}

/** What the agent says after an answer. */
const REPLY: Record<string, (branch: string, running: Running) => ReactNode> = {
  'launch-release': () => <>Launched. The worker and the frontend run v0.2.0-rc.42; Darktop has applied it and Lightbook will when it is idle. It is the default release now.</>,
  merge: branch => <>Started <strong>merge-v0-2-0-rc-42</strong>. It resolved both conflicts and opened PR #19 into {code(branch)}. Once it is merged I will ask whether to build and launch it.</>,
  'launch-branch': (_branch, running) => <>Built on Darktop in 5 min 40 s and launched. {code(running.defaultRelease)} is the default release now.</>,
  'trial-branch': (_branch, running) => <>Launched the frontend from {code(running.trial ?? '')} as a trial. Tell me when it looks right and I will make it the default.</>,
  'pr-upstream': () => <>Opened PR #231 on {code(UPSTREAM)} from automations-watch-ui. The trial stays until it ships in a release.</>,
  'move-to-fork': (_branch, running) => <>This project's repository is now {code(FORK)} and its base branch {code(FORK_BRANCH)} (Project settings). I merged automations-watch-ui there, built it on Darktop and launched it: {code(running.defaultRelease)} is the default release. GitSpace releases will now arrive as merges into your fork.</>,
  'merge-trial': (branch, running) => <>Merged automations-watch-ui into {code(branch)}, built it on Darktop and launched it: {code(running.defaultRelease)} is the default release.</>,
  keep: () => <>Keeping the trial.</>,
  back: (_branch, running) => <>Back to default: the frontend runs {code(running.defaultRelease)} again.</>,
  later: () => <>Leaving it for now.</>,
  skip: () => <>Skipped v0.2.0-rc.42. I will ask about the next release.</>,
};

function Bubble({ who, children, at }: { who: 'agent' | 'you' | 'notice'; children: ReactNode; at?: string }): ReactElement {
  const shape = useShape();
  if (who === 'notice') return <div className="flex items-start gap-2 text-caption text-muted-foreground"><Zap className="mt-0.5 shrink-0" width={14} height={14} strokeWidth={1.5} /><span>{children}</span></div>;
  return <div className={`flex flex-col gap-1 ${who === 'you' ? 'items-end' : 'items-start'}`}>
    <span className="text-caption text-muted-foreground">{who === 'you' ? 'You' : 'Project agent'}{at ? ` · ${at}` : ''}</span>
    <div className={`${shape.container} max-w-[46rem] px-4 py-3 text-body ${who === 'you' ? 'bg-surface-3' : 'bg-surface-2 shadow-surface-1'}`}>{children}</div>
  </div>;
}

function askBlock(id: string, prompt: string, options: readonly Option[], answer: string | null): AskBlock {
  const chosen = options.find(option => option.id === answer);
  return {
    id, type: 'ask', toolCallId: `${id}-call`, status: chosen ? 'answered' : 'pending',
    questions: [{ id: 'q', prompt, recommended: 0, options: options.map(option => ({ id: option.id, title: option.title, description: option.description })), ...(chosen ? { answer: chosen.title } : {}) }],
  };
}

const EARLIER_RELEASE: readonly Option[] = [
  { id: 'launch-release', title: 'Launch it now', description: '' }, { id: 'later', title: 'Not now', description: '' }, { id: 'skip', title: 'Skip this release', description: '' },
];

function ProjectAgent({ source, branch, event, answer, running, onAnswer }: { source: Source; branch: string; event: Event; answer: string | null; running: Running; onAnswer(option: string): void }): ReactElement {
  const shape = useShape();
  const current = ask(event, source, branch, running);
  const reply = answer ? REPLY[answer] : undefined;
  return <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-6">
    <Bubble who="notice">GitSpace releases · {UPSTREAM} published v0.2.0-rc.41 · last week</Bubble>
    <Bubble who="agent" at="last week">GitSpace <strong>v0.2.0-rc.41</strong> is out, and GitHub already built it.</Bubble>
    <AskBlockView item={askBlock('rc41', 'Update this account to GitSpace v0.2.0-rc.41?', EARLIER_RELEASE, 'launch-release')} />
    <Bubble who="agent" at="last week">Launched. v0.2.0-rc.41 is the default release.</Bubble>
    {event === 'release' ? <Bubble who="notice">GitSpace releases · {UPSTREAM} published v0.2.0-rc.42 · 2 h ago</Bubble> : null}
    {event === 'trial' ? <Bubble who="you" at="1 h ago">the automations-watch-ui trial looks good</Bubble> : null}
    {current ? <>
      <Bubble who="agent" at="now">{current.lead}</Bubble>
      <AskBlockView item={askBlock(`${event}-${source}`, current.prompt, current.options, answer)} onAnswer={async answers => { const picked = answers[0]?.selectedOptions[0]; if (picked) onAnswer(picked); }} />
      {reply ? <Bubble who="agent" at="now">{reply(branch, running)}</Bubble> : null}
    </> : <Bubble who="agent" at="2 d ago">Nothing newer than {code(running.defaultRelease)} is out. I will ask when GitSpace publishes a release{source === 'fork' ? <> or {code(branch)} has changes ready to launch</> : null}.</Bubble>}
    <div className={`${shape.container} mt-auto border border-border bg-background px-4 py-3 text-body text-muted-foreground`}>Ask the project agent…</div>
  </div>;
}

/** A section of the project settings dialog, styled as the app's (`AccountWorkPages.tsx`). */
function SettingsSection({ title, lead, isNew, children }: { title: string; lead: ReactNode; isNew?: boolean; children?: ReactNode }): ReactElement {
  return <section className="flex flex-col gap-3">
    <div className="flex flex-col gap-1">
      <h3 className="flex items-center gap-2 text-body font-medium text-foreground">{title}{isNew ? <Badge size="compact" color="blue">New · every project</Badge> : null}</h3>
      <p className="text-caption text-muted-foreground">{lead}</p>
    </div>
    {children}
  </section>;
}

/** The app's project settings dialog with this design's additions; `source` only decides the one GitSpace line. */
function ProjectSettingsDialog({ open, project, source, onClose, onRepository, onBaseBranch, onUpdateBase }: { open: boolean; project: Project; source: Source; onClose(): void; onRepository(repository: string): void; onBaseBranch(branch: string): void; onUpdateBase(): void }): ReactElement {
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');
  const [cadence, setCadence] = useState('Once a day');
  const [profile, setProfile] = useState('Account default');
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}><DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>GitSpace settings</DialogTitle><DialogDescription>Settings shared by every workspace in this project.</DialogDescription></DialogHeader>
    <SettingsSection title="Repository" isNew lead={<>Current repository: <span className="font-mono text-foreground">{project.repository}</span></>}>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (repository.trim()) { onRepository(repository.trim()); setRepository(''); } }}>
        <InputGroup><InputField index={0} label="New repository address" placeholder="https://github.com/owner/repository" value={repository} onChange={setRepository} /></InputGroup>
        <p className="text-caption text-muted-foreground">Use it for a fork or a moved repository. Workspaces keep their branches; the base space fetches from the new origin. Use the repository’s root URL, an SSH address, or owner/repository for GitHub.</p>
        <p className="text-caption text-muted-foreground">GitSpace: {source === 'upstream'
          ? <>on {UPSTREAM}, published GitSpace releases launch as they are, with nothing built here.</>
          : <>on a repository other than {UPSTREAM}, GitSpace releases arrive as merges and launching builds on one of your machines.</>}</p>
        <div><Button type="submit" variant="secondary" size="compact" disabled={!repository.trim()}>Change repository</Button></div>
      </form>
    </SettingsSection>
    <SettingsSection title="Base branch" lead={<>Current base branch: <span className="font-mono text-foreground">{project.baseBranch}</span></>}>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (branch.trim() && branch.trim() !== project.baseBranch) { onBaseBranch(branch.trim()); setBranch(''); } }}>
        <InputGroup><InputField index={0} label="New base branch" placeholder={project.baseBranch} value={branch} onChange={setBranch} /></InputGroup>
        <p className="text-caption text-muted-foreground">Existing workspaces keep their branches; stack status will compare against the new base. The project’s base space must be open and have no uncommitted changes.</p>
        <div><Button type="submit" variant="secondary" size="compact" disabled={!branch.trim() || branch.trim() === project.baseBranch}>Change base branch</Button></div>
      </form>
    </SettingsSection>
    <SettingsSection title="Origin" lead={<>Whether this project’s copy of {project.baseBranch} is behind its origin.</>}>
      <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        {project.behind ? <Badge size="compact" color="amber">Behind origin</Badge> : null}
        <span>origin/{project.baseBranch} checked {project.behind ? 'today, 07:02' : 'just now'}</span>
        {project.behind ? <Button variant="secondary" size="compact" onClick={onUpdateBase}>Update base</Button> : null}
        <Button variant="ghost" size="compact" leadingIcon={glyph(RefreshCcw01)}>Check origin</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-caption font-medium text-foreground">Check the origin <Badge size="compact" color="blue">New · every project</Badge></span>
        <div className="w-48"><Select size="compact" value={cadence} onValueChange={setCadence}><SelectTrigger aria-label="Check the origin" /><SelectContent>{['Once a day', 'Every 6 hours', 'Every hour', 'Only when I ask'].map((value, index) => <SelectItem key={value} value={value} index={index}>{value}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <p className="text-caption text-muted-foreground">Repositories your GitHub App is installed on report pushes at once; this check covers the rest.</p>
    </SettingsSection>
    <SettingsSection title="Inference" lead="Choose the canonical inference profile for every workspace in this project. Running work keeps its admitted profile; new work uses the new assignment.">
      <div className="w-64"><Select value={profile} onValueChange={setProfile}><SelectTrigger aria-label="Inference profile for GitSpace" /><SelectContent>{['Account default', 'Opus', 'Codex'].map((value, index) => <SelectItem key={value} value={value} index={index}>{value}</SelectItem>)}</SelectContent></Select></div>
      <p className="text-caption text-muted-foreground">Manage models, agents, and credentials under Navigate → Inference.</p>
    </SettingsSection>
    <p className="text-caption text-muted-foreground">Choose which of your Chromes agents here may use in <span className="text-foreground underline">Plugins → Browsers</span>.</p>
    <DialogFooter><Button variant="secondary" onClick={onClose}>Done</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function ReleasesPage({ running }: { running: Running }): ReactElement {
  const shape = useShape();
  const box = `${shape.container} bg-surface-2 px-5 py-4 shadow-surface-1`;
  const detail = (label: string, value: ReactNode) => <><dt className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</dt><dd className="min-w-0 text-body text-foreground">{value}</dd></>;
  return <PageCanvas>
    <PageHeader kicker="Settings" title="Releases" description="What this account runs. The GitSpace project's agent proposes releases and you decide; workspaces can try their own versions without changing the default." />
    <section aria-label="Running" className="mb-6 flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold">Running</h2>
      <div className={box}><dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        {detail('Worker', code(running.defaultRelease))}
        {detail('Frontend', running.trial ? <>{code(running.trial)} <Badge size="compact" color="green">Trial</Badge></> : code(running.defaultRelease))}
        {detail('Machines', <>Darktop, Lightbook · {code(running.defaultRelease)}</>)}
      </dl></div>
    </section>
    <section aria-label="Default release" className="mb-6 flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold">Default release</h2>
      <div className={`${box} flex flex-wrap items-center justify-between gap-3`}>
        <span className="text-body">{code(running.defaultRelease)}</span>
        <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(RefreshCcw01)} disabled={!running.trial}>Back to default</Button>
      </div>
    </section>
    <section aria-label="All releases" className="flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold">All releases</h2>
      {[running.defaultRelease, ...(running.trial ? [running.trial] : []), 'v0.2.0-rc.40'].map((label, index) => <Card key={label} size="compact" index={index}>
        <CardHeader><CardTitle>{label}</CardTitle><CardDescription>{label.startsWith('v') ? 'A published GitSpace release · built by GitHub' : 'Built on Darktop'}</CardDescription></CardHeader>
        <CardFooter><Badge variant="dot" color={label === running.defaultRelease ? 'blue' : label === running.trial ? 'green' : 'gray'}>{label === running.defaultRelease ? 'Default' : label === running.trial ? 'Trial · frontend' : 'Earlier'}</Badge></CardFooter>
      </Card>)}
    </section>
  </PageCanvas>;
}

/** A workspace row under the GitSpace project; `trial` when its version runs as a trial on this account. */
interface SidebarWorkspace { name: string; status: Dot; trial: boolean }

function AppSidebarMock({ project, page, asking, running, merging, onPage, onSettings }: { project: Project; page: Page; asking: boolean; running: Running; merging: boolean; onPage(page: Page): void; onSettings(): void }): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  const merge: SidebarWorkspace = { name: 'merge-v0-2-0-rc-42', status: 'green', trial: false };
  const workspaces: readonly SidebarWorkspace[] = [
    { name: 'automations-watch-ui', status: 'blue', trial: running.trial?.startsWith('automations-watch-ui') === true },
    { name: 'machine-installs', status: 'dim', trial: false },
    ...(merging ? [merge] : []),
  ];
  let index = 0;
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
            <SidebarMenuButton icon={STATUS_GLYPH[asking ? 'orange' : 'blue']} isActive={page === 'agent'} onClick={() => onPage('agent')} title={asking ? 'GitSpace · Needs you' : 'GitSpace · Waiting'}>
              GitSpace{project.behind ? <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" role="img" title={`Behind origin/${project.baseBranch}`} aria-label="Behind origin"><ArrowDown width={12} height={12} strokeWidth={1.5} /></span> : null}
            </SidebarMenuButton>
            <SidebarMenuActions>
              <SidebarMenuAction aria-label="Collapse GitSpace" aria-expanded><ChevronRight width={16} height={16} strokeWidth={1.5} className="rotate-90" /></SidebarMenuAction>
              <DropdownMenu>
                <DropdownTrigger render={<SidebarMenuAction aria-label="Space actions for GitSpace"><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
                  <MenuItem index={index++} icon={glyph(FolderClosed)} label="Open project" onSelect={() => onPage('agent')} />
                  <MenuItem index={index++} icon={glyph(Plus)} label="New workspace" onSelect={() => undefined} />
                  <MenuItem index={index++} icon={glyph(Settings01)} label="Project settings" onSelect={onSettings} />
                  <MenuItem index={index++} icon={glyph(Zap)} label="Automations" onSelect={() => undefined} />
                  <MenuItem index={index++} icon={glyph(XClose)} label="Release machine caches" onSelect={() => undefined} />
                  <MenuItem index={index++} icon={glyph(Rocket02)} label={`Launch ${project.baseBranch}`} onSelect={() => undefined} />
                </DropdownContent>
              </DropdownMenu>
            </SidebarMenuActions>
            <SidebarMenuSub open>{workspaces.map(workspace => <SidebarMenuSubItem key={workspace.name}>
              <SidebarMenuSubButton render={<button type="button" />} icon={STATUS_GLYPH[workspace.status]} title={workspace.trial ? 'GitSpace has a selected release from this workspace' : workspace.name}>
                {workspace.name}{workspace.trial ? <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" role="img" aria-label="GitSpace has a selected release from this workspace"><Rocket02 width={12} height={12} strokeWidth={1.5} /></span> : null}
              </SidebarMenuSubButton>
              <SidebarMenuActions showOnHover>
                <DropdownMenu>
                  <DropdownTrigger render={<SidebarMenuAction aria-label={`Space actions for ${workspace.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                  <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
                    <MenuItem index={0} icon={glyph(XClose)} label="Release machine caches" onSelect={() => undefined} />
                    <MenuItem index={1} icon={glyph(Archive)} label="Archive workspace" onSelect={() => undefined} />
                    <MenuItem index={2} icon={glyph(Rocket02)} label="Launch GitSpace from here" onSelect={() => undefined} />
                    {workspace.trial ? <MenuItem index={3} icon={glyph(RefreshCcw01)} label="Back to default" onSelect={() => undefined} /> : null}
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
          <SidebarMenuButton size="sm" icon={glyph(Rocket02)} isActive={page === 'releases'} onClick={() => onPage('releases')}>
            <span className="truncate">{running.trial ? `Trial · ${running.trial}` : `${running.defaultRelease} · default`}</span>
          </SidebarMenuButton>
        </Tooltip>
      </SidebarMenuItem></SidebarMenu>
      <SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>}
        menu={<MenuItem index={0} icon={glyph(Settings01)} label="Settings" onSelect={() => onPage('releases')} />} />
    </SidebarFooter>
  </Sidebar>;
}

/** Mock-only: makes the things the agent reacts to happen. Not part of the app. */
function Simulate({ onEvent }: { onEvent(event: Event): void }): ReactElement {
  return <div className="fixed bottom-4 right-4 z-50">
    <DropdownMenu>
      <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">Simulate (mock)</Button>} />
      <DropdownContent align="end" className="min-w-[300px] w-[300px]">
        <MenuItem index={0} label="GitSpace publishes v0.2.0-rc.42" onSelect={() => onEvent('release')} />
        <MenuItem index={1} label="The base branch moves on its origin (no release)" onSelect={() => onEvent('branch')} />
        <MenuItem index={2} label="You say the automations-watch-ui trial looks good" onSelect={() => onEvent('trial')} />
        <MenuItem index={3} label="Nothing new" onSelect={() => onEvent(null)} />
      </DropdownContent>
    </DropdownMenu>
  </div>;
}

/** What the account runs after an answer to a card asked on `branch`. */
function runningAfter(source: Source, branch: string, event: Event, answer: string | null): Running {
  const base: Running = { defaultRelease: source === 'upstream' ? 'v0.2.0-rc.41' : `${branch} @ 9b7e0d1`, trial: null };
  if (event === 'trial' && answer !== 'back' && answer !== 'move-to-fork' && answer !== 'merge-trial') return { ...base, trial: 'automations-watch-ui @ a1b2c3d' };
  if (answer === 'launch-release') return { ...base, defaultRelease: 'v0.2.0-rc.42' };
  if (answer === 'launch-branch') return { ...base, defaultRelease: `${branch} @ 5f2a9c1` };
  if (answer === 'trial-branch') return { ...base, trial: `${branch} @ 5f2a9c1` };
  if (answer === 'move-to-fork') return { ...base, defaultRelease: `${FORK_BRANCH} @ 7aa31c0` };
  if (answer === 'merge-trial') return { ...base, defaultRelease: `${branch} @ 7aa31c0` };
  return base;
}

function GitSpaceProjectMock(): ReactElement {
  const [project, setProject] = useState<Project>({ repository: `https://github.com/${UPSTREAM}`, baseBranch: 'develop', behind: true });
  const [event, setEvent] = useState<Event>('release');
  const [answer, setAnswer] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('agent');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const source: Source = project.repository.replace(/\.git$/u, '').endsWith(UPSTREAM) ? 'upstream' : 'fork';
  // A card is about the project as it was when asked: moving to a fork from a trial card changes the project after.
  const [askedOn, setAskedOn] = useState<{ source: Source; branch: string }>({ source: 'upstream', branch: 'develop' });
  const running = runningAfter(askedOn.source, askedOn.branch, event, answer);
  const asking = event !== null && answer === null && ask(event, askedOn.source, askedOn.branch, running) !== null;
  const happen = (next: Event) => {
    setEvent(next); setAnswer(null); setAskedOn({ source, branch: project.baseBranch }); setPage('agent');
    if (next === 'branch') setProject(current => ({ ...current, behind: true }));
  };
  // Pointing a project at another repository or branch starts it from that origin's head, so it is not behind yet.
  const retarget = (change: Partial<Project>) => { setProject(current => ({ ...current, ...change, behind: false })); setEvent(null); setAnswer(null); };
  const answerWith = (option: string) => {
    setAnswer(option);
    if (option === 'move-to-fork') setProject({ repository: `https://github.com/${FORK}`, baseBranch: FORK_BRANCH, behind: false });
  };
  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <AppSidebarMock project={project} page={page} asking={asking} running={running} merging={answer === 'merge'} onPage={setPage} onSettings={() => setSettingsOpen(true)} />
      <SidebarInset className="min-w-0 overflow-auto">
        <SidebarInsetTopbar>
          <span className="flex-1 truncate text-body font-medium">{PAGE_TITLE[page]}</span>
          {page === 'agent' && project.behind ? <Tooltip content={`origin/${project.baseBranch} has commits this project's copy lacks · Update base fast-forwards it`} side="bottom">
            <Button variant="secondary" size="compact" onClick={() => setProject(current => ({ ...current, behind: false }))}>Behind origin/{project.baseBranch} · Update</Button>
          </Tooltip> : null}
        </SidebarInsetTopbar>
        {page === 'agent' ? <ProjectAgent source={askedOn.source} branch={askedOn.branch} event={event} answer={answer} running={running} onAnswer={answerWith} /> : <ReleasesPage running={running} />}
      </SidebarInset>
    </SidebarProvider>
    <ProjectSettingsDialog open={settingsOpen} project={project} source={source} onClose={() => setSettingsOpen(false)}
      onRepository={repository => { retarget({ repository }); setAskedOn(current => ({ ...current, source: repository.replace(/\.git$/u, '').endsWith(UPSTREAM) ? 'upstream' : 'fork' })); }}
      onBaseBranch={baseBranch => { retarget({ baseBranch }); setAskedOn(current => ({ ...current, branch: baseBranch })); }}
      onUpdateBase={() => setProject(current => ({ ...current, behind: false }))} />
    <Simulate onEvent={happen} />
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
