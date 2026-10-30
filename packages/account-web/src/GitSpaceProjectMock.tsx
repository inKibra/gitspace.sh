// Throwaway design mock (docs/TENANT-RELEASES-DESIGN.md, docs/AUTOMATIONS-DESIGN.md §4a): how the GitSpace project agent
// asks about releases, and how the sidebar and Settings → Releases show what the account runs. Static data only; not
// part of the app.
import type { AskBlock } from '@gitspace/blocks';
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
  Activity, ChevronRight, Columns03, DotsHorizontal, FolderClosed, Key01, PuzzlePiece01, RefreshCcw01, Rocket02,
  Settings01, Stars01, Zap,
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
type Situation = 'release' | 'ready' | 'trial' | 'current';
type Page = 'project' | 'settings';
const SOURCE_LABEL: Record<Source, string> = { upstream: 'Upstream · inKibra/gitspace.sh · develop', fork: 'Fork · bradleat/gitspace.sh · ui-experiments' };
const SITUATION_LABEL: Record<Situation, string> = { release: 'A new upstream release', ready: 'Changes ready to launch', trial: 'A workspace trial running', current: 'Up to date' };
const PAGE_LABEL: Record<Page, string> = { project: 'GitSpace (project agent)', settings: 'Settings → Releases' };
/** What the GitSpace project launches to make a release the default. */
const BRANCH: Record<Source, string> = { upstream: 'develop', fork: 'ui-experiments' };
const DEFAULT_RELEASE: Record<Source, string> = { upstream: 'v0.2.0-rc.41', fork: 'ui-experiments @ 9b7e0d1' };

const code = (text: string) => <code className="font-mono text-caption">{text}</code>;

type Dot = 'green' | 'blue' | 'orange' | 'dim';
/** A sidebar row's status dot as an icon, the way the real sidebar draws each space's status. */
const STATUS_GLYPH: Record<Dot, IconComponent> = {
  green: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="green" pulse /></span>,
  blue: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="blue" /></span>,
  orange: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="orange" /></span>,
  dim: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="dim" /></span>,
};

interface Workspace { name: string; status: Dot; trial?: true }
/** The workspace the project agent starts to merge an upstream release into a fork. */
const MERGE_WORKSPACE: Workspace = { name: 'merge-v0-2-0-rc-42', status: 'green' };
function workspaces(source: Source, situation: Situation, merging: boolean): readonly Workspace[] {
  return [
    { name: 'automations-watch-ui', status: 'blue', ...(situation === 'trial' ? { trial: true } : {}) },
    { name: 'machine-installs', status: 'dim' },
    { name: 'upgrade-pi-v1-4-0', status: 'dim' },
    ...(source === 'fork' && situation === 'release' && merging ? [MERGE_WORKSPACE] : []),
  ];
}

/** What the sidebar's Source pill says: what the account runs after the agent's question was answered, and a trial in
 * front of the default. */
function sourcePill(source: Source, situation: Situation, answered: string | null): string {
  if (situation === 'release' && answered === 'launch') return 'v0.2.0-rc.42 · default';
  if (situation === 'ready' && answered === 'launch') return `${BRANCH[source]} @ 5f2a9c1 · default`;
  if (situation === 'ready' && answered === 'trial') return `Trial · ${BRANCH[source]} @ 5f2a9c1`;
  if (situation === 'trial' && answered !== 'back') return 'Trial · automations-watch-ui';
  return `${DEFAULT_RELEASE[source]} · default`;
}

function AppSidebarMock({ source, situation, page, answered, onPage }: { source: Source; situation: Situation; page: Page; answered: string | null; onPage(page: Page): void }): ReactElement {
  const asking = situation !== 'current' && answered === null;
  const merging = answered === 'merge';
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
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
            <SidebarMenuButton icon={STATUS_GLYPH[asking ? 'orange' : 'blue']} isActive={page === 'project'} onClick={() => onPage('project')} title={asking ? 'GitSpace · Needs you: the project agent is asking about a release' : 'GitSpace · Waiting'}>GitSpace</SidebarMenuButton>
            <SidebarMenuActions>
              <SidebarMenuAction aria-label="Collapse GitSpace" aria-expanded><ChevronRight width={16} height={16} strokeWidth={1.5} className="rotate-90" /></SidebarMenuAction>
              <DropdownMenu>
                <DropdownTrigger render={<SidebarMenuAction aria-label="Space actions for GitSpace"><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                <DropdownContent className="min-w-[260px] w-[260px]" align="start" sideOffset={4}>
                  <MenuItem index={0} icon={glyph(FolderClosed)} label="Open project" onSelect={() => onPage('project')} />
                  <MenuItem index={1} icon={glyph(Settings01)} label="Project settings" onSelect={() => undefined} />
                  <MenuItem index={2} icon={glyph(Zap)} label="Automations" onSelect={() => undefined} />
                  <MenuItem index={3} icon={glyph(Rocket02)} label={`Launch ${BRANCH[source]} as the default`} onSelect={() => undefined} />
                  <MenuItem index={4} icon={glyph(RefreshCcw01)} label="Back to default" onSelect={() => undefined} />
                </DropdownContent>
              </DropdownMenu>
            </SidebarMenuActions>
            <SidebarMenuSub open>{workspaces(source, situation, merging).map(workspace => <SidebarMenuSubItem key={workspace.name}>
              <SidebarMenuSubButton render={<button type="button" />} icon={STATUS_GLYPH[workspace.status]}
                title={workspace.trial ? 'Its frontend is a trial on this account; Back to default returns it' : workspace.name}>
                {workspace.name}{workspace.trial ? <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" role="img" aria-label="Running as a trial"><Rocket02 width={12} height={12} strokeWidth={1.5} /></span> : null}
              </SidebarMenuSubButton>
              <SidebarMenuActions showOnHover>
                <DropdownMenu>
                  <DropdownTrigger render={<SidebarMenuAction aria-label={`Space actions for ${workspace.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                  <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
                    <MenuItem index={0} icon={glyph(Rocket02)} label="Launch from here as a trial" onSelect={() => undefined} />
                    {workspace.trial ? <MenuItem index={1} icon={glyph(RefreshCcw01)} label="Back to default" onSelect={() => undefined} /> : null}
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
          <SidebarMenuButton size="sm" icon={glyph(Rocket02)} isActive={page === 'settings'} onClick={() => onPage('settings')}><span className="truncate">{sourcePill(source, situation, answered)}</span></SidebarMenuButton>
        </Tooltip>
      </SidebarMenuItem></SidebarMenu>
      <SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>}
        menu={<MenuItem index={0} icon={glyph(Settings01)} label="Settings" onSelect={() => onPage('settings')} />} />
    </SidebarFooter>
  </Sidebar>;
}

function Bubble({ who, children, at }: { who: 'agent' | 'you' | 'notice'; children: ReactNode; at?: string }): ReactElement {
  const shape = useShape();
  if (who === 'notice') return <div className="flex items-start gap-2 text-caption text-muted-foreground"><Zap className="mt-0.5 shrink-0" width={14} height={14} strokeWidth={1.5} /><span>{children}</span></div>;
  return <div className={`flex flex-col gap-1 ${who === 'you' ? 'items-end' : 'items-start'}`}>
    <span className="text-caption text-muted-foreground">{who === 'you' ? 'You' : 'Project agent'}{at ? ` · ${at}` : ''}</span>
    <div className={`${shape.container} max-w-[46rem] px-4 py-3 text-body ${who === 'you' ? 'bg-surface-3' : 'bg-surface-2 shadow-surface-1'}`}>{children}</div>
  </div>;
}

/** What the project agent asks, its lead-in, and what it does with each answer. */
interface ReleaseQuestion {
  intro: ReactNode;
  prompt: string;
  options: readonly { id: string; title: string; description: string; reply: ReactNode }[];
}

function releaseQuestion(source: Source, situation: Situation): ReleaseQuestion | null {
  if (situation === 'release' && source === 'upstream') return {
    intro: <>GitSpace <strong>v0.2.0-rc.42</strong> is out, and GitHub already built it. Since your default, v0.2.0-rc.41: machines download LFS files without CPU limit failures, a stuck supervisor no longer blocks a checkout, and pushes declare Artifacts' shallow boundaries.</>,
    prompt: 'Update this account to GitSpace v0.2.0-rc.42?',
    options: [
      { id: 'launch', title: 'Launch it now', description: 'The worker and frontend swap now; Darktop and Lightbook follow as they go idle. Nothing is built here.', reply: <>Launched. The worker and the frontend run v0.2.0-rc.42; Darktop has applied it and Lightbook will when it is idle. It is the default release now.</> },
      { id: 'later', title: 'Not now', description: 'I ask again with the next release, or when you mention it.', reply: <>Leaving it. You can launch v0.2.0-rc.42 any time from Settings → Releases or by asking me.</> },
      { id: 'skip', title: 'Skip this release', description: 'I will not ask about rc.42 again.', reply: <>Skipped v0.2.0-rc.42. I will ask about the next release.</> },
    ],
  };
  if (situation === 'release') return {
    intro: <>GitSpace <strong>v0.2.0-rc.42</strong> is out upstream. Your fork's {code('ui-experiments')} is 14 commits ahead of upstream, and rc.42 touches 2 files you changed.</>,
    prompt: 'Bring v0.2.0-rc.42 into ui-experiments?',
    options: [
      { id: 'merge', title: 'Merge it in a workspace and open a PR', description: 'I resolve what I can in merge-v0-2-0-rc-42 and open a pull request on bradleat/gitspace.sh.', reply: <>Started <strong>merge-v0-2-0-rc-42</strong>. It resolved both conflicts and opened PR #19 into {code('ui-experiments')}. Once it is merged I will ask whether to build and launch it.</> },
      { id: 'later', title: 'Not now', description: 'I ask again with the next release.', reply: <>Leaving it. Ask me when you want rc.42 merged.</> },
      { id: 'skip', title: 'Skip this release', description: 'I will not ask about rc.42 again.', reply: <>Skipped v0.2.0-rc.42.</> },
    ],
  };
  if (situation === 'ready') return {
    intro: source === 'upstream'
      ? <>{code('develop')} has 3 merged pull requests since your default, v0.2.0-rc.41 (#226 automations watch trigger, #228 LFS reads, #229 supervisor shutdown), and its checks pass. There is no GitHub build of it yet, so launching builds it on Darktop.</>
      : <>PR #19 (v0.2.0-rc.42) and PR #20 (watch editor) are merged into {code('ui-experiments')} since your default, and its checks pass.</>,
    prompt: `Build ${BRANCH[source]} @ 5f2a9c1 and launch it as the default?`,
    options: [
      { id: 'launch', title: 'Build on Darktop and launch', description: 'About 6 minutes to build; then it becomes the default for the worker, the frontend and the machines.', reply: <>Built on Darktop in 5 min 40 s and launched. {code(`${BRANCH[source]} @ 5f2a9c1`)} is the default release now.</> },
      { id: 'trial', title: 'Launch the frontend as a trial first', description: 'The default stays; Back to default undoes it.', reply: <>Launched the frontend from {code(`${BRANCH[source]} @ 5f2a9c1`)} as a trial. Tell me when it looks right and I will make it the default.</> },
      { id: 'later', title: 'Not now', description: 'I ask again when more changes land.', reply: <>Leaving the default where it is.</> },
    ],
  };
  if (situation === 'trial') return {
    intro: <>The frontend has been a trial from <strong>automations-watch-ui</strong> (a1b2c3d + 4 uncommitted) for 3 hours. The worker and both machines are on the default, {code(DEFAULT_RELEASE[source])}.</>,
    prompt: 'Keep the trial running?',
    options: [
      { id: 'keep', title: 'Keep it', description: 'I ask again tomorrow.', reply: <>Keeping the trial.</> },
      { id: 'back', title: 'Back to default', description: `The frontend returns to ${DEFAULT_RELEASE[source]}.`, reply: <>Back to default: the frontend runs {code(DEFAULT_RELEASE[source])} again.</> },
    ],
  };
  return null;
}

/** The GitSpace project agent's conversation: what the release automation brings it, and what it asks you. */
function ProjectAgent({ source, situation, answered, onAnswered }: { source: Source; situation: Situation; answered: string | null; onAnswered(option: string): void }): ReactElement {
  const shape = useShape();
  const question = releaseQuestion(source, situation);
  const chosen = question?.options.find(option => option.id === answered);
  const block: AskBlock | null = question ? {
    id: `release-${source}-${situation}`, type: 'ask', toolCallId: `ask-${source}-${situation}`,
    status: chosen ? 'answered' : 'pending',
    questions: [{ id: 'release', prompt: question.prompt, recommended: 0, options: question.options.map(option => ({ id: option.id, title: option.title, description: option.description })), ...(chosen ? { answer: chosen.title } : {}) }],
  } : null;
  return <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-6">
    <Bubble who="you" at="yesterday">what's left on the automations watch editor?</Bubble>
    <Bubble who="agent" at="yesterday">Only the delivery line for deployments; automations-watch-ui has it in progress.</Bubble>
    {situation === 'release' ? <Bubble who="notice">GitSpace releases · inKibra/gitspace.sh published v0.2.0-rc.42 · 2 h ago</Bubble> : null}
    {situation === 'ready' ? <Bubble who="notice">{source === 'upstream' ? 'develop moved: #229 merged · 40 min ago' : 'ui-experiments moved: PR #20 merged · 40 min ago'}</Bubble> : null}
    {question && block ? <>
      <Bubble who="agent" at={situation === 'trial' ? 'now' : '2 h ago'}>{question.intro}</Bubble>
      <AskBlockView item={block} onAnswer={async answers => { const picked = answers[0]?.selectedOptions[0]; if (picked) onAnswered(picked); }} />
      {chosen ? <Bubble who="agent" at="now">{chosen.reply}</Bubble> : null}
    </> : <Bubble who="agent" at="2 d ago">v0.2.0-rc.41 is the default and nothing newer is out. I will ask when a release is published or {code(BRANCH[source])} has changes ready to launch.</Bubble>}
    <div className={`${shape.container} mt-auto border border-border bg-background px-4 py-3 text-body text-muted-foreground`}>Ask the project agent…</div>
  </div>;
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <>
    <dt className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-body text-foreground">{children}</dd>
  </>;
}

interface ReleaseView { label: string; detail: string; badges: readonly { text: string; color: 'blue' | 'gray' | 'green' | 'amber' }[] }
const AVAILABLE_RELEASE: ReleaseView = { label: 'v0.2.0-rc.42', detail: 'GitHub\'s build of inKibra/gitspace.sh · released 2 h ago · not launched', badges: [{ text: 'Available', color: 'amber' }] };
const TRIAL_RELEASE: ReleaseView = { label: 'automations-watch-ui @ a1b2c3d + 4 uncommitted', detail: 'built on Darktop from a workspace · 3 h ago', badges: [{ text: 'Trial · frontend', color: 'green' }] };
function releases(source: Source, situation: Situation): readonly ReleaseView[] {
  const def: ReleaseView = source === 'upstream'
    ? { label: 'v0.2.0-rc.41', detail: 'GitHub\'s build of inKibra/gitspace.sh develop @ 3e1f2c9 · launched by the project agent 2 d ago', badges: [{ text: 'Default', color: 'blue' }] }
    : { label: 'ui-experiments @ 9b7e0d1', detail: 'built on Darktop from bradleat/gitspace.sh · launched 4 d ago', badges: [{ text: 'Default', color: 'blue' }] };
  return [
    ...(situation === 'release' && source === 'upstream' ? [AVAILABLE_RELEASE] : []),
    ...(situation === 'trial' ? [TRIAL_RELEASE] : []),
    def,
    { label: 'v0.2.0-rc.40', detail: 'GitHub\'s build · default until 2 d ago', badges: [{ text: 'Earlier', color: 'gray' }] },
  ];
}

function SettingsPage({ source, situation }: { source: Source; situation: Situation }): ReactElement {
  const shape = useShape();
  const box = `${shape.container} bg-surface-2 px-5 py-4 shadow-surface-1`;
  return <PageCanvas>
    <PageHeader kicker="Settings" title="Releases" description="What this account runs. The GitSpace project's agent proposes releases and you decide; workspaces can try their own versions without changing the default." />
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
          <span className="text-caption text-muted-foreground">Set when the GitSpace project launches {code(BRANCH[source])} from {source === 'upstream' ? 'inKibra/gitspace.sh' : 'bradleat/gitspace.sh'}, or a release of it. Machines with no selection and new computers follow it.</span></div>
        <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(RefreshCcw01)} disabled={situation !== 'trial'}>Back to default</Button>
      </div>
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
    {control('Mock · the project builds', source, SOURCE_LABEL, onSource)}
    {control('Mock · situation', situation, SITUATION_LABEL, onSituation)}
    {control('Mock · page', page, PAGE_LABEL, onPage)}
  </div>;
}

function GitSpaceProjectMock(): ReactElement {
  const [source, setSource] = useState<Source>('upstream');
  const [situation, setSituation] = useState<Situation>('release');
  const [page, setPage] = useState<Page>('project');
  const [answered, setAnswered] = useState<string | null>(null);
  const reset = <T,>(set: (value: T) => void) => (value: T) => { set(value); setAnswered(null); };
  return <div className="flex h-dvh flex-col bg-background">
    <MockControls source={source} situation={situation} page={page} onSource={reset(setSource)} onSituation={reset(setSituation)} onPage={setPage} />
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <AppSidebarMock source={source} situation={situation} page={page} answered={answered} onPage={setPage} />
      <SidebarInset className="min-w-0 overflow-auto">
        <SidebarInsetTopbar><span className="truncate text-body font-medium">{page === 'project' ? 'GitSpace' : 'Settings'}</span></SidebarInsetTopbar>
        {page === 'project' ? <ProjectAgent source={source} situation={situation} answered={answered} onAnswered={setAnswered} /> : <SettingsPage source={source} situation={situation} />}
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
