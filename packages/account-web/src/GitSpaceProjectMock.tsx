// Throwaway design mock (docs/TENANT-RELEASES-DESIGN.md, docs/AUTOMATIONS-DESIGN.md §4a): the GitSpace project agent asks
// about releases, branch changes and trials; Project settings → Source points the project at upstream or a fork; the
// sidebar shows when the project is behind its origin and what the account runs. Static data only; not part of the app.
import type { AskBlock } from '@gitspace/blocks';
import {
  Badge, Button, Card, CardDescription, CardFooter, CardHeader, CardTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, MenuItem,
  Select, SelectContent, SelectItem, SelectTrigger, ShapeProvider, Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar, SidebarMenu, SidebarMenuAction, SidebarMenuActions,
  SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider,
  SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider, Tooltip, TooltipProvider, untitledIcons, useShape, WorkspaceTile,
  type IconComponent, type IconComponentProps,
} from '@gitspace/ui';
import {
  Activity, ArrowDown, ChevronRight, Columns03, DotsHorizontal, FolderClosed, GitBranch01, Key01, PuzzlePiece01,
  RefreshCcw01, Rocket02, Settings01, Stars01, Zap,
} from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { AskBlockView } from './TurnTranscript.js';
import { restoreAppearance } from './appearance.js';

type Source = 'upstream' | 'fork';
/** The newest event the project agent was told about, or none. */
type Event = 'release' | 'branch' | 'trial' | null;
type Page = 'agent' | 'project-settings' | 'releases';
const UPSTREAM = 'inKibra/gitspace.sh';
const FORK = 'bradleat/gitspace.sh';
const REPOSITORY: Record<Source, string> = { upstream: UPSTREAM, fork: FORK };
const BRANCH: Record<Source, string> = { upstream: 'develop', fork: 'ui-experiments' };
const PAGE_TITLE: Record<Page, string> = { agent: 'GitSpace', 'project-settings': 'GitSpace · Project settings', releases: 'Settings' };

const code = (text: string) => <code className="font-mono text-caption">{text}</code>;

type Dot = 'green' | 'blue' | 'orange' | 'dim';
/** A sidebar row's status dot as an icon, the way the real sidebar draws each space's status. */
const STATUS_GLYPH: Record<Dot, IconComponent> = {
  green: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="green" pulse /></span>,
  blue: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="blue" /></span>,
  orange: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="orange" /></span>,
  dim: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="dim" /></span>,
};

/** What the account runs: the default release, and a trial in front of it. */
interface Running { defaultRelease: string; trial: string | null }

interface Option { id: string; title: string; description: string }
/** What the project agent asks about the newest event, if it asks at all. */
interface Ask { lead: ReactNode; prompt: string; options: readonly Option[] }

function ask(event: Event, source: Source, running: Running): Ask | null {
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
    lead: <>GitSpace <strong>v0.2.0-rc.42</strong> is out upstream. {code(BRANCH.fork)} is 14 commits ahead of upstream, and rc.42 touches 2 files you changed.</>,
    prompt: `Bring v0.2.0-rc.42 into ${BRANCH.fork}?`,
    options: [
      { id: 'merge', title: 'Merge it in a workspace and open a PR', description: `I resolve what I can in merge-v0-2-0-rc-42 and open a pull request on ${FORK}.` },
      { id: 'later', title: 'Not now', description: 'I ask again with the next release.' },
      { id: 'skip', title: 'Skip this release', description: 'I will not ask about rc.42 again.' },
    ],
  };
  // Upstream users are only asked about releases: a moving develop shows as behind origin, with Sync.
  if (event === 'branch' && source === 'fork') return {
    lead: <>PR #20 (watch editor) and PR #21 (release cards) are merged into {code(BRANCH.fork)} since your default, and its checks pass. They are not a release, so launching builds them on Darktop.</>,
    prompt: `Build ${BRANCH.fork} @ 5f2a9c1 and launch it as the default?`,
    options: [
      { id: 'launch-branch', title: 'Build on Darktop and launch', description: 'About 6 minutes to build; then it is the default for the worker, the frontend and the machines.' },
      { id: 'trial-branch', title: 'Launch the frontend as a trial first', description: 'The default stays; Back to default undoes it.' },
      { id: 'later', title: 'Not now', description: 'I ask again when more changes land.' },
    ],
  };
  if (event === 'trial' && source === 'upstream') return {
    lead: <>The frontend from <strong>automations-watch-ui</strong> has been a trial for a day, and you said it looks good. To make it your default its changes have to be on a branch this project builds, and you cannot push to {code(`${UPSTREAM} develop`)}.</>,
    prompt: 'How do you want to keep the automations-watch-ui changes?',
    options: [
      { id: 'pr-upstream', title: 'Open a PR upstream and keep the trial', description: 'It becomes part of a GitSpace release if the maintainers merge it.' },
      { id: 'move-to-fork', title: `Move GitSpace to your fork, ${FORK}`, description: `I point this project at ${FORK} ${BRANCH.fork}, merge the workspace there, build and launch it as the default.` },
      { id: 'keep', title: 'Keep the trial', description: 'I ask again in a week.' },
      { id: 'back', title: 'Back to default', description: `The frontend returns to ${running.defaultRelease}.` },
    ],
  };
  if (event === 'trial') return {
    lead: <>The frontend from <strong>automations-watch-ui</strong> has been a trial for a day, and you said it looks good.</>,
    prompt: 'Promote the automations-watch-ui trial?',
    options: [
      { id: 'merge-trial', title: `Merge into ${BRANCH.fork}, then build and launch`, description: 'It becomes the default release.' },
      { id: 'keep', title: 'Keep the trial', description: 'I ask again in a week.' },
      { id: 'back', title: 'Back to default', description: `The frontend returns to ${running.defaultRelease}.` },
    ],
  };
  return null;
}

/** What the agent says after an answer. */
const REPLY: Record<string, (source: Source) => ReactNode> = {
  'launch-release': () => <>Launched. The worker and the frontend run v0.2.0-rc.42; Darktop has applied it and Lightbook will when it is idle. It is the default release now.</>,
  merge: () => <>Started <strong>merge-v0-2-0-rc-42</strong>. It resolved both conflicts and opened PR #19 into {code(BRANCH.fork)}. Once it is merged I will ask whether to build and launch it.</>,
  'launch-branch': () => <>Built on Darktop in 5 min 40 s and launched. {code(`${BRANCH.fork} @ 5f2a9c1`)} is the default release now.</>,
  'trial-branch': () => <>Launched the frontend from {code(`${BRANCH.fork} @ 5f2a9c1`)} as a trial. Tell me when it looks right and I will make it the default.</>,
  'pr-upstream': () => <>Opened PR #231 on {code(UPSTREAM)} from automations-watch-ui. The trial stays until it ships in a release.</>,
  'move-to-fork': () => <>This project now builds {code(`${FORK} ${BRANCH.fork}`)} (Project settings → Source). I merged automations-watch-ui there, built it on Darktop and launched it: {code(`${BRANCH.fork} @ 7aa31c0`)} is the default release. GitSpace releases will now arrive as merges into your fork.</>,
  'merge-trial': () => <>Merged automations-watch-ui into {code(BRANCH.fork)}, built it on Darktop and launched it: {code(`${BRANCH.fork} @ 7aa31c0`)} is the default release.</>,
  keep: () => <>Keeping the trial.</>,
  back: source => <>Back to default: the frontend runs {code(source === 'upstream' ? 'v0.2.0-rc.41' : `${BRANCH.fork} @ 9b7e0d1`)} again.</>,
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

function ProjectAgent({ source, event, answer, running, onAnswer }: { source: Source; event: Event; answer: string | null; running: Running; onAnswer(option: string): void }): ReactElement {
  const shape = useShape();
  const current = ask(event, source, running);
  const reply = answer ? REPLY[answer] : undefined;
  return <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-6">
    <Bubble who="notice">GitSpace releases · {UPSTREAM} published v0.2.0-rc.41 · last week</Bubble>
    <Bubble who="agent" at="last week">GitSpace <strong>v0.2.0-rc.41</strong> is out, and GitHub already built it.</Bubble>
    <AskBlockView item={askBlock('rc41', 'Update this account to GitSpace v0.2.0-rc.41?', EARLIER_RELEASE, 'launch-release')} />
    <Bubble who="agent" at="last week">Launched. v0.2.0-rc.41 is the default release.</Bubble>
    {event === 'release' ? <Bubble who="notice">GitSpace releases · {UPSTREAM} published v0.2.0-rc.42 · 2 h ago</Bubble> : null}
    {event === 'branch' && source === 'upstream' ? <Bubble who="notice">{UPSTREAM} develop has 3 commits your copy lacks, with no release. GitSpace shows the project behind its origin; Sync brings them into the project's copy. Nothing is launched.</Bubble> : null}
    {event === 'branch' && source === 'fork' ? <Bubble who="notice">{FORK} {BRANCH.fork}: PR #21 merged · 40 min ago</Bubble> : null}
    {event === 'trial' ? <><Bubble who="you" at="1 h ago">the automations-watch-ui trial looks good</Bubble></> : null}
    {current ? <>
      <Bubble who="agent" at="now">{current.lead}</Bubble>
      <AskBlockView item={askBlock(`${event}-${source}`, current.prompt, current.options, answer)} onAnswer={async answers => { const picked = answers[0]?.selectedOptions[0]; if (picked) onAnswer(picked); }} />
      {reply ? <Bubble who="agent" at="now">{reply(source)}</Bubble> : null}
    </> : event === null ? <Bubble who="agent" at="2 d ago">Nothing newer than {code(running.defaultRelease)} is out. I will ask when GitSpace publishes a release{source === 'fork' ? <> or {code(BRANCH.fork)} has changes ready to launch</> : null}.</Bubble> : null}
    <div className={`${shape.container} mt-auto border border-border bg-background px-4 py-3 text-body text-muted-foreground`}>Ask the project agent…</div>
  </div>;
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <>
    <dt className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-body text-foreground">{children}</dd>
  </>;
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  const shape = useShape();
  return <section aria-label={title} className="mb-6 flex flex-col gap-3">
    <h2 className="text-subtitle font-semibold">{title}</h2>
    <div className={`${shape.container} flex flex-col gap-3 bg-surface-2 px-5 py-4 shadow-surface-1`}>{children}</div>
  </section>;
}

function UseForkDialog({ open, onClose, onUse }: { open: boolean; onClose(): void; onUse(): void }): ReactElement {
  const [fork, setFork] = useState(FORK);
  const [branch, setBranch] = useState(BRANCH.fork);
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Use a fork of GitSpace</DialogTitle>
        <DialogDescription>This project will build your fork. GitSpace releases then arrive as merges into it, and launching it builds on one of your machines.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1"><span className="text-caption font-medium text-muted-foreground">Fork</span>
          <Select value={fork} onValueChange={setFork}><SelectTrigger aria-label="Fork" /><SelectContent><SelectItem value={FORK} index={0}>{FORK} · fork of {UPSTREAM}</SelectItem></SelectContent></Select></label>
        <label className="flex flex-col gap-1"><span className="text-caption font-medium text-muted-foreground">Branch</span>
          <Select value={branch} onValueChange={setBranch}><SelectTrigger aria-label="Branch" /><SelectContent><SelectItem value={BRANCH.fork} index={0}>{BRANCH.fork}</SelectItem><SelectItem value="develop" index={1}>develop</SelectItem></SelectContent></Select></label>
        <p className="text-caption text-muted-foreground">Listed: forks of {UPSTREAM} your GitHub App covers. No fork yet? Create one on GitHub, install the App on it, then choose it here. Your default release stays until you launch the fork.</p>
      </div>
      <DialogFooter>
        <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="button" leadingIcon={glyph(GitBranch01)} onClick={onUse}>Use this fork</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ProjectSettings({ source, behind, onSource, onSync }: { source: Source; behind: boolean; onSource(source: Source): void; onSync(): void }): ReactElement {
  const [choosing, setChoosing] = useState(false);
  const [cadence, setCadence] = useState('Once a day');
  return <PageCanvas>
    <PageHeader kicker="GitSpace" title="Project settings" description="The GitSpace project builds this account's GitSpace. Releases its agent launches become the default release." />
    <Section title="Source">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Detail label="Repository">{code(REPOSITORY[source])}{source === 'fork' ? <span className="text-muted-foreground"> · fork of {UPSTREAM}</span> : <span className="text-muted-foreground"> · upstream GitSpace</span>}</Detail>
        <Detail label="Branch">{code(BRANCH[source])}</Detail>
        <Detail label="Releases">{source === 'upstream' ? <>Published GitSpace releases launch as they are, with nothing built here.</> : <>GitSpace releases from {UPSTREAM} arrive as merges into {code(BRANCH.fork)}; launching builds on Darktop.</>}</Detail>
      </dl>
      <div className="flex flex-wrap gap-2">{source === 'upstream'
        ? <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(GitBranch01)} onClick={() => setChoosing(true)}>Use a fork…</Button>
        : <><Button variant="secondary" size="compact" type="button" onClick={() => setChoosing(true)}>Change fork or branch…</Button><Button variant="ghost" size="compact" type="button" onClick={() => onSource('upstream')}>Track upstream</Button></>}</div>
    </Section>
    <Section title="Origin">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Detail label="This copy">{behind
          ? <>{code(BRANCH[source])} is 3 commits behind {REPOSITORY[source]} <Badge size="compact" color="amber">Behind origin</Badge><span className="block text-caption text-muted-foreground">{source === 'upstream' ? 'Unreleased changes: Sync updates the project\'s copy; it launches nothing.' : 'Sync updates the project\'s copy; launching is separate.'}</span></>
          : <>{code(BRANCH[source])} matches {REPOSITORY[source]}</>}</Detail>
        <Detail label="Updates">{source === 'upstream'
          ? <>Your GitHub App is not installed on {UPSTREAM}, so GitSpace checks it. Last checked 4 h ago.</>
          : <>Your GitHub App covers {FORK}: pushes arrive at once.</>}</Detail>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(RefreshCcw01)} disabled={!behind} onClick={onSync}>Sync</Button>
        {source === 'upstream' ? <><Button variant="ghost" size="compact" type="button">Check now</Button>
          <div className="w-48"><Select value={cadence} onValueChange={setCadence}><SelectTrigger aria-label="Check the origin" /><SelectContent>{['Once a day', 'Every 6 hours', 'Every hour', 'Only when I ask'].map((value, index) => <SelectItem key={value} value={value} index={index}>{value}</SelectItem>)}</SelectContent></Select></div></> : null}
      </div>
    </Section>
    <Section title="Release automation">
      <p className="text-body">GitSpace releases · watch {code(UPSTREAM)} releases, checked once a day → message the project agent. <span className="text-muted-foreground">Edit it under Automations.</span></p>
    </Section>
    <UseForkDialog open={choosing} onClose={() => setChoosing(false)} onUse={() => { onSource('fork'); setChoosing(false); }} />
  </PageCanvas>;
}

function ReleasesPage({ running }: { running: Running }): ReactElement {
  const shape = useShape();
  const box = `${shape.container} bg-surface-2 px-5 py-4 shadow-surface-1`;
  return <PageCanvas>
    <PageHeader kicker="Settings" title="Releases" description="What this account runs. The GitSpace project's agent proposes releases and you decide; workspaces can try their own versions without changing the default." />
    <section aria-label="Running" className="mb-6 flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold">Running</h2>
      <div className={box}><dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Detail label="Worker">{code(running.defaultRelease)}</Detail>
        <Detail label="Frontend">{running.trial ? <>{code(running.trial)} <Badge size="compact" color="green">Trial</Badge></> : code(running.defaultRelease)}</Detail>
        <Detail label="Machines">Darktop, Lightbook · {code(running.defaultRelease)}</Detail>
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

function AppSidebarMock({ source, page, asking, behind, running, merging, onPage, onSync }: { source: Source; page: Page; asking: boolean; behind: boolean; running: Running; merging: boolean; onPage(page: Page): void; onSync(): void }): ReactElement {
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
            <SidebarMenuButton icon={STATUS_GLYPH[asking ? 'orange' : 'blue']} isActive={page === 'agent'} onClick={() => onPage('agent')}
              title={[asking ? 'GitSpace · Needs you' : 'GitSpace · Waiting', behind ? `Behind origin/${BRANCH[source]}` : null].filter(Boolean).join(' · ')}>
              GitSpace{behind ? <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" role="img" aria-label="Behind origin"><ArrowDown width={12} height={12} strokeWidth={1.5} /></span> : null}
            </SidebarMenuButton>
            <SidebarMenuActions>
              <SidebarMenuAction aria-label="Collapse GitSpace" aria-expanded><ChevronRight width={16} height={16} strokeWidth={1.5} className="rotate-90" /></SidebarMenuAction>
              <DropdownMenu>
                <DropdownTrigger render={<SidebarMenuAction aria-label="Space actions for GitSpace"><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                <DropdownContent className="min-w-[260px] w-[260px]" align="start" sideOffset={4}>
                  <MenuItem index={index++} icon={glyph(FolderClosed)} label="Open project" onSelect={() => onPage('agent')} />
                  <MenuItem index={index++} icon={glyph(Settings01)} label="Project settings" onSelect={() => onPage('project-settings')} />
                  <MenuItem index={index++} icon={glyph(Zap)} label="Automations" onSelect={() => undefined} />
                  {behind ? <MenuItem index={index++} icon={glyph(RefreshCcw01)} label={`Sync ${BRANCH[source]} from origin`} onSelect={onSync} /> : null}
                  <MenuItem index={index++} icon={glyph(Rocket02)} label={`Build ${BRANCH[source]} and launch as the default`} onSelect={() => undefined} />
                  {running.trial ? <MenuItem index={index++} icon={glyph(RefreshCcw01)} label="Back to default" onSelect={() => undefined} /> : null}
                </DropdownContent>
              </DropdownMenu>
            </SidebarMenuActions>
            <SidebarMenuSub open>{workspaces.map(workspace => <SidebarMenuSubItem key={workspace.name}>
              <SidebarMenuSubButton render={<button type="button" />} icon={STATUS_GLYPH[workspace.status]} title={workspace.trial ? 'Its frontend is a trial on this account' : workspace.name}>
                {workspace.name}{workspace.trial ? <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" role="img" aria-label="Running as a trial"><Rocket02 width={12} height={12} strokeWidth={1.5} /></span> : null}
              </SidebarMenuSubButton>
              <SidebarMenuActions showOnHover>
                <DropdownMenu>
                  <DropdownTrigger render={<SidebarMenuAction aria-label={`Space actions for ${workspace.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                  <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
                    <MenuItem index={0} icon={glyph(Rocket02)} label="Launch from here as a trial" onSelect={() => undefined} />
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
        <MenuItem index={1} label="The project's branch moves (no release)" onSelect={() => onEvent('branch')} />
        <MenuItem index={2} label="You say the automations-watch-ui trial looks good" onSelect={() => onEvent('trial')} />
        <MenuItem index={3} label="Nothing new" onSelect={() => onEvent(null)} />
      </DropdownContent>
    </DropdownMenu>
  </div>;
}

/** What the account runs after an answer, from what it ran before. */
function runningAfter(source: Source, event: Event, answer: string | null): Running {
  const base: Running = { defaultRelease: source === 'upstream' ? 'v0.2.0-rc.41' : `${BRANCH.fork} @ 9b7e0d1`, trial: null };
  if (event === 'trial' && answer !== 'back' && answer !== 'move-to-fork' && answer !== 'merge-trial') return { ...base, trial: 'automations-watch-ui @ a1b2c3d' };
  if (answer === 'launch-release') return { ...base, defaultRelease: 'v0.2.0-rc.42' };
  if (answer === 'launch-branch') return { ...base, defaultRelease: `${BRANCH.fork} @ 5f2a9c1` };
  if (answer === 'trial-branch') return { ...base, trial: `${BRANCH.fork} @ 5f2a9c1` };
  if (answer === 'move-to-fork' || answer === 'merge-trial') return { ...base, defaultRelease: `${BRANCH.fork} @ 7aa31c0` };
  return base;
}

function GitSpaceProjectMock(): ReactElement {
  const [source, setSource] = useState<Source>('upstream');
  const [event, setEvent] = useState<Event>('release');
  const [answer, setAnswer] = useState<string | null>(null);
  const [behind, setBehind] = useState(true);
  const [page, setPage] = useState<Page>('agent');
  // The project's source moves to the fork when you choose that on a trial; the answer is about the source it was asked on.
  const [askedOn, setAskedOn] = useState<Source>('upstream');
  const running = runningAfter(askedOn, event, answer);
  const asking = event !== null && answer === null && ask(event, source, running) !== null;
  const happen = (next: Event) => { setEvent(next); setAnswer(null); setAskedOn(source); if (next === 'branch') setBehind(true); setPage('agent'); };
  // A project pointed at another repository or branch has not yet compared its copy with that origin.
  const answerWith = (option: string) => { setAnswer(option); if (option === 'move-to-fork') { setSource('fork'); setBehind(false); } };
  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <AppSidebarMock source={source} page={page} asking={asking} behind={behind} running={running} merging={answer === 'merge'} onPage={setPage} onSync={() => setBehind(false)} />
      <SidebarInset className="min-w-0 overflow-auto">
        <SidebarInsetTopbar><span className="truncate text-body font-medium">{PAGE_TITLE[page]}</span></SidebarInsetTopbar>
        {page === 'agent' ? <ProjectAgent source={askedOn} event={event} answer={answer} running={running} onAnswer={answerWith} />
          : page === 'project-settings' ? <ProjectSettings source={source} behind={behind} onSource={next => { setSource(next); setAskedOn(next); setEvent(null); setAnswer(null); setBehind(false); }} onSync={() => setBehind(false)} />
            : <ReleasesPage running={running} />}
      </SidebarInset>
    </SidebarProvider>
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
