// The HTML video for the blog post (blog-upstream-merge.html): one GitSpace release travelling into a customized
// account, played as timed scenes. GitSpace screens are the app's own components (sidebar, transcript bubbles, the
// question card, the Releases page); the tweet and GitHub pages are drawn after those sites. Static data only.
import type { AskBlock } from '@gitspace/blocks';
import {
  Badge, Button, Card, CardDescription, CardFooter, CardHeader, CardTitle, IconProvider, MenuItem, ShapeProvider, Sidebar,
  SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
  SidebarProvider, SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider, TooltipProvider, untitledIcons, useShape,
  WorkspaceTile, type IconComponent, type IconComponentProps,
} from '@gitspace/ui';
import { Activity, Columns03, FolderClosed, Key01, PuzzlePiece01, Rocket02, Settings01, Stars01, Zap } from '@untitledui/icons';
import { StrictMode, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { AskBlockView } from './TurnTranscript.js';
import { restoreAppearance } from './appearance.js';

const STAGE = { width: 1280, height: 800 };
const UPSTREAM = 'inKibra/gitspace.sh';
const FORK = 'bradleat/gitspace.sh';
const BRANCH = 'ui-experiments';
const RELEASE = 'v0.2.0-rc.43';

/** A scene: how long it plays, what is said over it, and what it shows at `t` ms into it. */
interface Scene { title: string; ms: number; caption: string; render(t: number): ReactElement }

/** Shown from `at` ms on, fading and rising in. */
function Reveal({ t, at, children, style }: { t: number; at: number; children: ReactNode; style?: CSSProperties }): ReactElement {
  const shown = t >= at;
  return <div style={{ opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(8px)', transition: 'opacity 450ms ease, transform 450ms ease', ...style }}>{children}</div>;
}

/** `text` typed from `start` ms at `perSecond` characters a second. */
function typed(text: string, t: number, start: number, perSecond = 28): string {
  return text.slice(0, Math.max(0, Math.floor(((t - start) / 1000) * perSecond)));
}

const code = (text: string) => <code className="font-mono text-caption">{text}</code>;

type Dot = 'green' | 'blue' | 'orange' | 'dim';
const STATUS_GLYPH: Record<Dot, IconComponent> = {
  green: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="green" pulse /></span>,
  blue: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="blue" /></span>,
  orange: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="orange" /></span>,
  dim: ({ className }: IconComponentProps) => <span className={`${className ?? ''} inline-flex items-center justify-center`}><StatusDot color="dim" /></span>,
};

interface Workspace { name: string; status: Dot; active?: boolean }
/** The app's sidebar as this account shows it: the GitSpace project with its workspaces, and the release it runs. */
function AppSidebar({ workspaces, gitspace, active, running }: { workspaces: readonly Workspace[]; gitspace: Dot; active: 'gitspace' | 'automations' | 'releases' | 'workspace' | 'tonetempo'; running: string }): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon} isActive={item.label === 'Automations' && active === 'automations'}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton icon={STATUS_GLYPH[gitspace]} isActive={active === 'gitspace'}>GitSpace</SidebarMenuButton>
            <SidebarMenuSub open>{workspaces.map(workspace => <SidebarMenuSubItem key={workspace.name}>
              <SidebarMenuSubButton render={<button type="button" />} icon={STATUS_GLYPH[workspace.status]} isActive={workspace.active}>{workspace.name}</SidebarMenuSubButton>
            </SidebarMenuSubItem>)}</SidebarMenuSub>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton icon={STATUS_GLYPH.dim}>tonetempo</SidebarMenuButton>
            <SidebarMenuSub open><SidebarMenuSubItem><SidebarMenuSubButton render={<button type="button" />} icon={STATUS_GLYPH.green} isActive={active === 'tonetempo'}>challenges-and-streaks</SidebarMenuSubButton></SidebarMenuSubItem></SidebarMenuSub>
          </SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton icon={STATUS_GLYPH.dim}>inkibra core</SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton size="sm" icon={glyph(Rocket02)} isActive={active === 'releases'}><span className="truncate">{running}</span></SidebarMenuButton>
      </SidebarMenuItem></SidebarMenu>
      <SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>}
        menu={<MenuItem index={0} icon={glyph(Settings01)} label="Settings" onSelect={() => undefined} />} />
    </SidebarFooter>
  </Sidebar>;
}

/** The app frame around a page: sidebar, the page's topbar, its content. */
function App({ title, sidebar, children, topbar }: { title: string; sidebar: ReactElement; children: ReactNode; topbar?: ReactNode }): ReactElement {
  return <SidebarProvider className="gitspace-shell" persist={false} style={{ height: STAGE.height, minHeight: 0 }}>
    {sidebar}
    <SidebarInset className="min-w-0 overflow-hidden">
      <SidebarInsetTopbar><span className="flex-1 truncate text-body font-medium">{title}</span>{topbar}</SidebarInsetTopbar>
      {children}
    </SidebarInset>
  </SidebarProvider>;
}

function Bubble({ who, children, at, name }: { who: 'agent' | 'you' | 'notice'; children: ReactNode; at?: string; name?: string }): ReactElement {
  const shape = useShape();
  if (who === 'notice') return <div className="flex items-start gap-2 text-caption text-muted-foreground"><Zap className="mt-0.5 shrink-0" width={14} height={14} strokeWidth={1.5} /><span>{children}</span></div>;
  return <div className={`flex flex-col gap-1 ${who === 'you' ? 'items-end' : 'items-start'}`}>
    <span className="text-caption text-muted-foreground">{who === 'you' ? 'You' : name ?? 'Project agent'}{at ? ` · ${at}` : ''}</span>
    <div className={`${shape.container} max-w-[46rem] px-4 py-3 text-body ${who === 'you' ? 'bg-surface-3' : 'bg-surface-2 shadow-surface-1'}`}>{children}</div>
  </div>;
}

/** A tool call as the transcript shows it while collapsed: its name, its argument, and how it ended. */
function ToolLine({ name, detail, state }: { name: string; detail: string; state: 'done' | 'running' | 'failed' }): ReactElement {
  return <div className="flex items-center gap-2 text-caption text-muted-foreground">
    <StatusDot color={state === 'done' ? 'green' : state === 'failed' ? 'red' : 'blue'} pulse={state === 'running'} />
    <span className="font-medium text-foreground">{name}</span><span className="truncate font-mono">{detail}</span>
  </div>;
}

function Composer({ text }: { text: string }): ReactElement {
  const shape = useShape();
  return <div className={`${shape.container} border border-border bg-background px-4 py-3 text-body ${text ? 'text-foreground' : 'text-muted-foreground'}`}>{text || 'Ask the agent…'}</div>;
}

function Conversation({ children }: { children: ReactNode }): ReactElement {
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6" style={{ height: STAGE.height - 56 }}>{children}</div>;
}

interface Option { id: string; title: string; description: string }
function askBlock(id: string, prompt: string, options: readonly Option[], answer: string | null): AskBlock {
  const chosen = options.find(option => option.id === answer);
  return {
    id, type: 'ask', toolCallId: `${id}-call`, status: chosen ? 'answered' : 'pending',
    questions: [{ id: 'q', prompt, recommended: 0, options: options.map(option => ({ id: option.id, title: option.title, description: option.description })), ...(chosen ? { answer: chosen.title } : {}) }],
  };
}

/** A panel drawn like the app's settings dialog, inline so it scales with the stage. */
function SettingsPanel({ children }: { children: ReactNode }): ReactElement {
  const shape = useShape();
  return <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.35)' }}>
    <div className={`${shape.container} flex flex-col gap-4 border border-border bg-background p-6 shadow-surface-1`} style={{ width: 640 }}>{children}</div>
  </div>;
}

function SettingRow({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }): ReactElement {
  return <div className="flex items-center gap-4 border-b border-border py-3">
    <span className="text-caption font-medium text-muted-foreground" style={{ width: 120 }}>{label}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-body">{value}{note ? <span className="text-caption text-muted-foreground">{note}</span> : null}</div>
  </div>;
}

const GITSPACE_WORKSPACES: readonly Workspace[] = [{ name: 'sidebar-pins', status: 'blue' }];
const MERGE_WORKSPACE: Workspace = { name: 'merge-v0-2-0-rc-43', status: 'green' };

// --- Scenes -----------------------------------------------------------------------------------------------------

/** The post that started it, drawn like X's web page. */
function TweetScene({ t }: { t: number }): ReactElement {
  const icon = (path: string) => <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="#536471" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>;
  return <div className="absolute inset-0 flex items-center justify-center" style={{ background: '#ffffff' }}>
    <Reveal t={t} at={200} style={{ zoom: 1.55 }}>
      <article style={{ width: 600, border: '1px solid #eff3f4', borderRadius: 16, padding: '12px 16px', fontFamily: 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', color: '#0f1419', background: '#fff' }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <img src="https://unavatar.io/x/trq212" alt="" width={40} height={40} style={{ width: 40, height: 40, borderRadius: 999, flexShrink: 0, objectFit: 'cover', background: '#cfd9de' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 15 }}>
              <span style={{ fontWeight: 700 }}>Thariq</span><span style={{ color: '#536471' }}>@trq212 · Oct 27</span>
              <svg viewBox="0 0 24 24" width="22" height="22" style={{ marginLeft: 'auto' }} aria-label="X"><path fill="#0f1419" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            </div>
            <div style={{ fontSize: 15, lineHeight: '20px', marginTop: 2, whiteSpace: 'pre-wrap' }}>
              feels like there needs to be a new way to distribute opensource software such that people can modify via agents but also get upstream automatically merged in{'\n\n'}coding agents can do this but they won’t do it automatically
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, maxWidth: 425 }}>
              {icon('M1.75 10c0-4.4 3.6-8 8-8h4.4c4.4 0 8 3.6 8 8 0 4.5-3.6 8.1-8.1 8.1H10l-5.4 3.5v-4.1C2.9 16.2 1.75 13.3 1.75 10z')}
              {icon('M4.5 3.9l4 3.8H6v8.3c0 1.1.9 2 2 2h5.5v2H8c-2.2 0-4-1.8-4-4V7.7H1.5zM18 6h-5.5V4H18c2.2 0 4 1.8 4 4v8.3h2.5l-4 3.8-4-3.8H19V8c0-1.1-.9-2-2-2z')}
              {icon('M16.7 3.5c-1.9 0-3.6 1-4.7 2.5-1.1-1.5-2.8-2.5-4.7-2.5C4.1 3.5 1.8 6 1.8 9.3c0 5.6 8.6 10.9 10.2 11.9 1.6-1 10.2-6.3 10.2-11.9 0-3.3-2.3-5.8-5.5-5.8z')}
              {icon('M8.75 21V3h2v18zM18 21V8.5h2V21zM4 21l.004-10h2L6 21zm9.248 0v-7h2v7z')}
              {icon('M4 4.5C4 3.1 5.1 2 6.5 2h11C18.9 2 20 3.1 20 4.5v18.4l-8-5.7-8 5.7z')}
            </div>
          </div>
        </div>
      </article>
    </Reveal>
  </div>;
}

function ForkScene({ t }: { t: number }): ReactElement {
  const repository = typed(`https://github.com/${FORK}`, t, 2600, 34);
  const branch = typed(BRANCH, t, 5200, 22);
  return <div className="relative" style={{ height: STAGE.height }}>
    <App title="GitSpace" sidebar={<AppSidebar workspaces={GITSPACE_WORKSPACES} gitspace="blue" active="gitspace" running="v0.2.0-rc.42 · default" />}>
      <Conversation>
        <Bubble who="agent" at="last week">Launched. <strong>v0.2.0-rc.42</strong> is the default release.</Bubble>
        <div className="mt-auto"><Composer text="" /></div>
      </Conversation>
    </App>
    <Reveal t={t} at={900} style={{ position: 'absolute', inset: 0 }}>
      <SettingsPanel>
        <div><div className="text-title font-semibold">GitSpace settings</div><div className="text-body text-muted-foreground">Settings shared by every workspace in this project.</div></div>
        <div className="flex flex-col">
          <SettingRow label="Repository" value={<span className="truncate font-mono text-caption">{t < 2600 ? `https://github.com/${UPSTREAM}` : repository || ' '}</span>}
            note={t < 7000 ? 'Published GitSpace releases launch as they are.' : 'GitSpace releases arrive as merges; launching builds on a machine.'} />
          <SettingRow label="Base branch" value={<span className="font-mono text-caption">{t < 5200 ? 'develop' : branch || ' '}</span>} />
          <SettingRow label="Origin" value={<span className="text-caption text-muted-foreground">Up to date · checked just now</span>} />
        </div>
        <div className="flex justify-end"><Button variant="secondary">Done</Button></div>
      </SettingsPanel>
    </Reveal>
  </div>;
}

function CustomizeScene({ t }: { t: number }): ReactElement {
  const ask = 'Pin the projects I open every day to the top of the sidebar.';
  const trial = t >= 7600;
  return <App title="sidebar-pins" sidebar={<AppSidebar workspaces={[{ name: 'sidebar-pins', status: t >= 2200 && t < 7600 ? 'green' : 'blue', active: true }]} gitspace="blue" active="workspace" running={trial ? 'Trial · sidebar-pins @ 4c1e9a2' : 'v0.2.0-rc.42 · default'} />}>
    <Conversation>
      {t >= 1800 ? <Bubble who="you" at="now">{ask}</Bubble> : null}
      <Reveal t={t} at={2600}><div className="flex flex-col gap-1.5">
        <ToolLine name="read" detail="packages/account-web/src/AppSidebar.tsx" state="done" />
        <ToolLine name="edit" detail="AppSidebar.tsx · project-pins.ts" state={t >= 4200 ? 'done' : 'running'} />
        {t >= 4200 ? <ToolLine name="bash" detail="bun run test · 497 passed" state={t >= 5600 ? 'done' : 'running'} /> : null}
        {t >= 5600 ? <ToolLine name="gitspace_deployment_launch" detail="frontend · trial" state={t >= 7400 ? 'done' : 'running'} /> : null}
      </div></Reveal>
      <Reveal t={t} at={7600}><Bubble who="agent" name="Agent · sidebar-pins" at="now">Pinned projects sit at the top of the sidebar now. I launched the frontend as a <strong>trial</strong>; reload to try it, and Back to default undoes it.</Bubble></Reveal>
      <div className="mt-auto"><Composer text={t < 1800 ? typed(ask, t, 200, 40) : ''} /></div>
    </Conversation>
  </App>;
}

function AutomationScene({ t }: { t: number }): ReactElement {
  const row = (label: string, value: ReactNode) => <div className="flex gap-4 text-caption"><span className="text-muted-foreground" style={{ width: 64 }}>{label}</span><span className="text-foreground">{value}</span></div>;
  return <App title="Automations" sidebar={<AppSidebar workspaces={GITSPACE_WORKSPACES} gitspace="blue" active="automations" running="v0.2.0-rc.42 · default" />}>
    <PageCanvas>
      <PageHeader kicker="GitSpace" title="Automations" description="When something happens in this project, start work. Activity on a linked pull request or issue goes to its workspace." />
      <div className="flex flex-col gap-3">
        <Reveal t={t} at={600}><Card size="compact" style={t >= 2400 ? { outline: '2px solid var(--focus-ring, #6B97FF)', outlineOffset: 2 } : undefined}>
          <CardHeader><CardTitle>GitSpace releases</CardTitle><CardDescription>Built in · last run last week</CardDescription></CardHeader>
          <div className="flex flex-col gap-1.5 px-4 pb-3">
            {row('When', <>Watch {code(UPSTREAM)} · Release · <span className="text-muted-foreground">arrives instantly through your GitHub App</span></>)}
            {row('Only if', <>tag is {code('v*')}</>)}
            {row('Then', 'Message the project agent: say what the release changes for this account, then ask')}
          </div>
          <CardFooter><Badge variant="dot" color="green">On</Badge></CardFooter>
        </Card></Reveal>
        <Reveal t={t} at={1200}><Card size="compact">
          <CardHeader><CardTitle>Failed checks to its workspace</CardTitle><CardDescription>Default · GitHub</CardDescription></CardHeader>
          <div className="flex flex-col gap-1.5 px-4 pb-3">{row('When', 'check suite completed')}{row('Only if', 'linked · failure or timed out')}{row('Then', 'Wake the linked workspace’s agent')}</div>
          <CardFooter><Badge variant="dot" color="green">On</Badge></CardFooter>
        </Card></Reveal>
        <Reveal t={t} at={1600}><Card size="compact">
          <CardHeader><CardTitle>Review feedback to its workspace</CardTitle><CardDescription>Default · GitHub</CardDescription></CardHeader>
          <CardFooter><Badge variant="dot" color="green">On</Badge></CardFooter>
        </Card></Reveal>
      </div>
    </PageCanvas>
  </App>;
}

/** GitHub's release page for the tag, then the run it started. */
function ReleaseScene({ t }: { t: number }): ReactElement {
  if (t < 4600) return <div className="absolute inset-0" style={{ background: '#fff', color: '#1f2328', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif' }}>
    <div style={{ height: 64, background: '#f6f8fa', borderBottom: '1px solid #d1d9e0', display: 'flex', alignItems: 'center', gap: 12, padding: '0 32px', fontSize: 16 }}>
      <svg height="32" viewBox="0 0 16 16" width="32" fill="#1f2328"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" /></svg>
      <span>inKibra</span><span style={{ color: '#59636e' }}>/</span><span style={{ fontWeight: 600 }}>gitspace.sh</span>
    </div>
    <div style={{ maxWidth: 1012, margin: '32px auto', padding: '0 24px' }}>
      <div style={{ fontSize: 24, marginBottom: 16 }}>Releases</div>
      <Reveal t={t} at={500}><div style={{ border: '1px solid #d1d9e0', borderRadius: 6, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 32, fontWeight: 600 }}>{RELEASE}</span>
          <span style={{ border: '1px solid #d4a72c', color: '#9a6700', borderRadius: 999, padding: '0 8px', fontSize: 12, fontWeight: 500 }}>Pre-release</span>
        </div>
        <div style={{ color: '#59636e', fontSize: 14, margin: '8px 0 16px' }}>gitspace-release published this just now · {RELEASE} · 9f31c2e</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: '24px' }}>
          <li>The sidebar groups projects by recent activity</li>
          <li>Drive documents show images relative to themselves</li>
          <li>Machines watch only folders Git sees changes in</li>
        </ul>
      </div></Reveal>
    </div>
  </div>;
  const shape = `rounded-lg`;
  return <App title="Automations" sidebar={<AppSidebar workspaces={GITSPACE_WORKSPACES} gitspace="orange" active="automations" running="Trial · sidebar-pins @ 4c1e9a2" />}>
    <PageCanvas>
      <PageHeader kicker="GitSpace" title="Recent runs" description="Every event an automation saw, and what it did." />
      <Reveal t={t} at={4900}><div className={`${shape} flex items-center gap-3 bg-surface-2 px-4 py-3 shadow-surface-1`}>
        <StatusDot color="green" /><span className="text-body font-medium">GitSpace releases</span>
        <span className="text-caption text-muted-foreground">release · {RELEASE} · {UPSTREAM}</span>
        <span className="ml-auto text-caption text-muted-foreground">Messaged the project agent · now</span>
      </div></Reveal>
      <Reveal t={t} at={5400}><div className={`${shape} mt-2 flex items-center gap-3 bg-surface-2 px-4 py-3 opacity-70`}>
        <StatusDot color="green" /><span className="text-body font-medium">GitSpace releases</span>
        <span className="text-caption text-muted-foreground">release · v0.2.0-rc.42 · {UPSTREAM}</span>
        <span className="ml-auto text-caption text-muted-foreground">Messaged the project agent · last week</span>
      </div></Reveal>
    </PageCanvas>
  </App>;
}

const MERGE_OPTIONS: readonly Option[] = [
  { id: 'merge', title: 'Merge it in a workspace and open a PR', description: `I resolve what I can in merge-v0-2-0-rc-43 and open a pull request into ${BRANCH}.` },
  { id: 'later', title: 'Not now', description: 'I ask again with the next release.' },
  { id: 'skip', title: 'Skip this release', description: 'I will not ask about rc.43 again.' },
];

function AskScene({ t }: { t: number }): ReactElement {
  const answered = t >= 8200 ? 'merge' : null;
  return <App title="GitSpace" sidebar={<AppSidebar workspaces={t >= 9200 ? [...GITSPACE_WORKSPACES, MERGE_WORKSPACE] : GITSPACE_WORKSPACES} gitspace={answered ? 'blue' : 'orange'} active="gitspace" running="Trial · sidebar-pins @ 4c1e9a2" />}>
    <Conversation>
      <Bubble who="notice">GitSpace releases · {UPSTREAM} published {RELEASE} · now</Bubble>
      <Reveal t={t} at={1200}><Bubble who="agent" at="now">GitSpace <strong>{RELEASE}</strong> is out upstream. {code(BRANCH)} is 14 commits ahead of upstream, and rc.43 touches 2 files you changed: <code className="font-mono text-caption">AppSidebar.tsx</code> and <code className="font-mono text-caption">project-pins.ts</code>. It groups projects by recent activity, which is where your pins live.</Bubble></Reveal>
      <Reveal t={t} at={3000}><AskBlockView item={askBlock('merge-rc43', `Bring ${RELEASE} into ${BRANCH}?`, MERGE_OPTIONS, answered)} /></Reveal>
      <Reveal t={t} at={9200}><Bubble who="agent" at="now">Started <strong>merge-v0-2-0-rc-43</strong>. I will open a pull request into {code(BRANCH)} and tell you when it is ready.</Bubble></Reveal>
      <div className="mt-auto"><Composer text="" /></div>
    </Conversation>
  </App>;
}

function MergeScene({ t }: { t: number }): ReactElement {
  return <App title="merge-v0-2-0-rc-43" sidebar={<AppSidebar workspaces={[...GITSPACE_WORKSPACES, { name: 'merge-v0-2-0-rc-43', status: t < 11500 ? 'green' : 'blue', active: true }]} gitspace="blue" active="workspace" running="Trial · sidebar-pins @ 4c1e9a2" />}>
    <Conversation>
      <Bubble who="you" name="Project agent" at="now">Instruction from the project agent: merge {RELEASE} into {BRANCH} and open a pull request.</Bubble>
      <Reveal t={t} at={900}><div className="flex flex-col gap-1.5">
        <ToolLine name="bash" detail={`git merge ${RELEASE}`} state={t >= 2200 ? 'failed' : 'running'} />
        {t >= 2200 ? <div className="text-caption text-muted-foreground" style={{ paddingLeft: 18 }}>CONFLICT (content): AppSidebar.tsx · project-pins.ts</div> : null}
        {t >= 3200 ? <ToolLine name="read" detail="journal · sidebar-pins: why pinned projects sit above groups" state="done" /> : null}
        {t >= 4400 ? <ToolLine name="edit" detail="AppSidebar.tsx · keep the pinned section above rc.43’s activity groups" state={t >= 6000 ? 'done' : 'running'} /> : null}
        {t >= 6000 ? <ToolLine name="edit" detail="project-pins.ts · rc.43 renamed recentProjects → projectActivity" state={t >= 7200 ? 'done' : 'running'} /> : null}
        {t >= 7200 ? <ToolLine name="bash" detail="bun run test · 503 passed" state={t >= 8800 ? 'done' : 'running'} /> : null}
        {t >= 8800 ? <ToolLine name="gh pr create" detail={`Merge ${RELEASE} into ${BRANCH} · #19`} state={t >= 10200 ? 'done' : 'running'} /> : null}
      </div></Reveal>
      <Reveal t={t} at={10400}><Bubble who="agent" name="Agent · merge-v0-2-0-rc-43" at="now">Merged {RELEASE}. Two conflicts, both from rc.43’s new activity groups: your pinned section stays above them, and the pins follow the renamed <code className="font-mono text-caption">projectActivity</code>. Tests pass. Opened <strong>PR #19</strong> into {code(BRANCH)}.</Bubble></Reveal>
      <div className="mt-auto"><Composer text="" /></div>
    </Conversation>
  </App>;
}

/** GitHub's pull request: a check fails, the automation sends it back, the agent's commit passes. */
function ReviewScene({ t }: { t: number }): ReactElement {
  const fixed = t >= 6400;
  const github = { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif', color: '#1f2328' };
  const check = (ok: boolean, name: string, detail: string) => <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderTop: '1px solid #d1d9e0', fontSize: 14 }}>
    <span style={{ color: ok ? '#1a7f37' : '#d1242f', fontWeight: 700 }}>{ok ? '✓' : '✕'}</span><span style={{ fontWeight: 600 }}>{name}</span><span style={{ color: '#59636e' }}>{detail}</span>
  </div>;
  return <div className="absolute inset-0" style={{ background: '#fff', ...github }}>
    <div style={{ maxWidth: 1012, margin: '40px auto', padding: '0 24px' }}>
      <div style={{ fontSize: 32 }}>Merge {RELEASE} into {BRANCH} <span style={{ color: '#59636e', fontWeight: 300 }}>#19</span></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 24px', fontSize: 14 }}>
        <span style={{ background: '#1f883d', color: '#fff', borderRadius: 999, padding: '5px 12px', fontWeight: 500 }}>Open</span>
        <span style={{ color: '#59636e' }}><b style={{ color: '#1f2328' }}>gitspace-bradleat</b> wants to merge 3 commits into <code>{BRANCH}</code> from <code>merge-v0-2-0-rc-43</code></span>
      </div>
      <div style={{ border: '1px solid #d1d9e0', borderRadius: 6 }}>
        <div style={{ padding: '12px 16px', fontWeight: 600, fontSize: 16, color: fixed ? '#1a7f37' : '#d1242f' }}>{fixed ? 'All checks have passed' : 'Some checks were not successful'}</div>
        {check(true, 'test', '503 passed')}
        {check(fixed, 'typecheck', fixed ? 'passed' : 'AppSidebar.tsx(214): Property groupId does not exist on type PinnedProject')}
        {check(true, 'build', 'frontend and worker built')}
      </div>
      <Reveal t={t} at={2200}><div style={{ marginTop: 16, border: '1px solid #d1d9e0', borderRadius: 6, padding: '12px 16px', fontSize: 14, background: '#f6f8fa' }}>
        <b>GitSpace automation</b> <span style={{ color: '#59636e' }}>· Failed checks to its workspace → merge-v0-2-0-rc-43:</span> “Checks failed on this workspace’s branch. Find out why and fix it.”
      </div></Reveal>
      <Reveal t={t} at={4600}><div style={{ marginTop: 12, border: '1px solid #d1d9e0', borderRadius: 6, padding: '12px 16px', fontSize: 14 }}>
        <b>gitspace-bradleat</b> pushed 1 commit <span style={{ color: '#59636e' }}>· Pinned projects carry the group rc.43 gives them</span>
      </div></Reveal>
      <Reveal t={t} at={7600}><div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <span style={{ background: '#1f883d', color: '#fff', borderRadius: 6, padding: '6px 16px', fontWeight: 600, fontSize: 14 }}>{t >= 9000 ? 'Merged' : 'Merge pull request'}</span>
        <span style={{ color: '#59636e', fontSize: 14, alignSelf: 'center' }}>You approved these changes</span>
      </div></Reveal>
    </div>
  </div>;
}

const LAUNCH_OPTIONS: readonly Option[] = [
  { id: 'trial', title: 'Launch the frontend as a trial first', description: 'The default stays; Back to default undoes it.' },
  { id: 'launch', title: 'Build on Darktop and launch', description: 'It becomes the default for the worker, the frontend and the machines.' },
  { id: 'later', title: 'Not now', description: 'I ask again when more changes land.' },
];

function LaunchScene({ t }: { t: number }): ReactElement {
  const answered = t >= 4200 ? 'trial' : null;
  if (t < 6400) return <App title="GitSpace" sidebar={<AppSidebar workspaces={GITSPACE_WORKSPACES} gitspace={answered ? 'blue' : 'orange'} active="gitspace" running="Trial · sidebar-pins @ 4c1e9a2" />}>
    <Conversation>
      <Bubble who="agent" at="now">PR #19 is merged into {code(BRANCH)} and its checks pass. It is not a published release, so launching builds it on Darktop.</Bubble>
      <Reveal t={t} at={900}><AskBlockView item={askBlock('launch-rc43', `Build ${BRANCH} @ 7aa31c0 and launch it?`, LAUNCH_OPTIONS, answered)} /></Reveal>
      <Reveal t={t} at={5000}><Bubble who="agent" at="now">Built on Darktop and launched the frontend from {code(`${BRANCH} @ 7aa31c0`)} as a trial.</Bubble></Reveal>
      <div className="mt-auto"><Composer text="" /></div>
    </Conversation>
  </App>;
  const running = `${BRANCH} @ 7aa31c0`;
  const shape = 'rounded-lg';
  return <App title="Settings" sidebar={<AppSidebar workspaces={GITSPACE_WORKSPACES} gitspace="blue" active="releases" running={`Trial · ${running}`} />}>
    <PageCanvas>
      <PageHeader kicker="Settings" title="Releases" description="What this account runs. The GitSpace project's agent proposes releases and you decide; workspaces can try their own versions without changing the default." />
      <section className="mb-6 flex flex-col gap-3">
        <h2 className="text-subtitle font-semibold">Running</h2>
        <div className={`${shape} bg-surface-2 px-5 py-4 shadow-surface-1 flex flex-col gap-2`}>
          <div className="flex gap-4 text-body"><span className="text-caption font-medium text-muted-foreground" style={{ width: 96 }}>Worker</span>{code('ui-experiments @ 9b7e0d1')}</div>
          <div className="flex items-center gap-4 text-body"><span className="text-caption font-medium text-muted-foreground" style={{ width: 96 }}>Frontend</span>{code(running)} <Badge size="compact" color="green">Trial</Badge></div>
          <div className="flex gap-4 text-body"><span className="text-caption font-medium text-muted-foreground" style={{ width: 96 }}>Machines</span><span>Darktop, Lightbook · {code('ui-experiments @ 9b7e0d1')}</span></div>
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-subtitle font-semibold">Default release</h2>
        <div className={`${shape} flex items-center justify-between bg-surface-2 px-5 py-4 shadow-surface-1`}>
          <span className="text-body">{code('ui-experiments @ 9b7e0d1')}</span>
          <div className="flex gap-2"><Button variant="secondary" size="compact">Make the trial default</Button><Button variant="ghost" size="compact">Back to default</Button></div>
        </div>
      </section>
    </PageCanvas>
  </App>;
}

function KeepWorkingScene({ t }: { t: number }): ReactElement {
  const shape = useShape();
  const lines = ['$ bun run dev', '  VITE v7.1.3  ready in 412 ms', '  ➜  Local:   http://localhost:5173/', '  12:01:44 [vite] hmr update /src/StreakCard.tsx', '  12:04:10 [vite] hmr update /src/streaks.ts', '  12:06:52 [vite] hmr update /src/StreakCard.tsx'];
  return <App title="challenges-and-streaks" sidebar={<AppSidebar workspaces={GITSPACE_WORKSPACES} gitspace="blue" active="tonetempo" running={`Trial · ${BRANCH} @ 7aa31c0`} />}
    topbar={<Badge variant="dot" color="green">Agent working · 14 min</Badge>}>
    <div className="flex gap-4 px-6 py-6" style={{ height: STAGE.height - 56 }}>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <Bubble who="you" at="14 min ago">Add weekly streaks to the challenges page, with the tests.</Bubble>
        <div className="flex flex-col gap-1.5">
          <ToolLine name="edit" detail="src/streaks.ts · weekly windows" state="done" />
          <ToolLine name="edit" detail="src/StreakCard.tsx" state="done" />
          {t >= 1800 ? <ToolLine name="bash" detail="bun test streaks · 24 passed" state={t >= 5200 ? 'done' : 'running'} /> : null}
          {t >= 5200 ? <ToolLine name="bash" detail="git push · challenges-and-streaks" state={t >= 7000 ? 'done' : 'running'} /> : null}
        </div>
        <Reveal t={t} at={7400}><Bubble who="agent" name="Agent · challenges-and-streaks" at="now">Weekly streaks are in, with 24 passing tests, and pushed. The streak card on the challenges page shows the current week.</Bubble></Reveal>
      </div>
      <div className={`${shape.container} flex flex-col gap-1 bg-surface-2 p-4 font-mono text-caption shadow-surface-1`} style={{ width: 420 }}>
        <span className="text-muted-foreground">Terminal · Darktop · still running</span>
        {lines.slice(0, t >= 4000 ? 6 : 5).map(line => <span key={line} className="text-foreground" style={{ whiteSpace: 'pre' }}>{line}</span>)}
      </div>
    </div>
    <div className="absolute" style={{ top: 12, left: '50%', transform: 'translateX(-50%)', opacity: t >= 800 && t < 4200 ? 1 : 0, transition: 'opacity 400ms' }}>
      <div className={`${shape.container} flex items-center gap-2 bg-surface-3 px-4 py-2 text-caption shadow-surface-1`}><Rocket02 width={14} height={14} strokeWidth={1.5} />Launched {code(`${BRANCH} @ 7aa31c0`)} · the agent’s turn carries on</div>
    </div>
  </App>;
}

function EndScene({ t }: { t: number }): ReactElement {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background">
    <Reveal t={t} at={200}><div className="text-display font-semibold">Agents change it. Automations keep it current. You say yes.</div></Reveal>
    <Reveal t={t} at={1200}><div className="text-title text-muted-foreground">gitspace.sh</div></Reveal>
  </div>;
}

const SCENES: readonly Scene[] = [
  { title: 'The question', ms: 7000, caption: 'Agents can change the software you run. Keeping your changed copy up to date is the part nobody does.', render: t => <TweetScene t={t} /> },
  { title: 'Your GitSpace is a project', ms: 10000, caption: 'Every GitSpace account runs its own copy of GitSpace, built from a project in the account. Mine builds my fork.', render: t => <ForkScene t={t} /> },
  { title: 'Customize it with an agent', ms: 10000, caption: 'When I want GitSpace to work differently, I ask an agent in that project and try the result as a trial.', render: t => <CustomizeScene t={t} /> },
  { title: 'The automation that asks', ms: 9000, caption: 'The GitSpace project comes with one automation: when upstream publishes a release, tell the project agent.', render: t => <AutomationScene t={t} /> },
  { title: 'Upstream ships', ms: 8000, caption: 'Upstream publishes a release. Nobody has to remember anything.', render: t => <ReleaseScene t={t} /> },
  { title: 'The agent asks', ms: 12000, caption: 'The project agent reads the release against my fork, says what it changes for me, and asks.', render: t => <AskScene t={t} /> },
  { title: 'A workspace does the merge', ms: 13000, caption: 'It merges in a workspace of its own, resolves the conflicts with my changes in mind, runs the tests and opens a pull request.', render: t => <MergeScene t={t} /> },
  { title: 'Review like any change', ms: 10500, caption: 'A failing check goes back to that workspace, and the agent fixes it. I review a merge like any other pull request.', render: t => <ReviewScene t={t} /> },
  { title: 'Launch when you say so', ms: 10500, caption: 'Once it’s merged, it asks to build and launch. I try it as a trial; Back to default is one click.', render: t => <LaunchScene t={t} /> },
  { title: 'Your other agents keep working', ms: 11000, caption: 'And the rest of my agents kept working through all of it. pi-durable keeps their work, so a release just carries on.', render: t => <KeepWorkingScene t={t} /> },
  { title: 'End', ms: 5000, caption: 'Your fork, upstream’s releases, and an agent in between.', render: t => <EndScene t={t} /> },
];
const TOTAL = SCENES.reduce((sum, scene) => sum + scene.ms, 0);
const STARTS = SCENES.map((_, index) => SCENES.slice(0, index).reduce((sum, scene) => sum + scene.ms, 0));

function UpstreamVideo(): ReactElement {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [viewport, setViewport] = useState({ width: document.body.clientWidth, height: window.innerHeight });
  useEffect(() => {
    const resize = () => setViewport({ width: document.body.clientWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      setTime(current => {
        const next = current + (now - last);
        if (next >= TOTAL) { setPlaying(false); return TOTAL - 1; }
        return next;
      });
      last = now;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const index = Math.max(0, STARTS.findLastIndex(start => start <= time));
  const scene = SCENES[index]!;
  const seek = (next: number) => setTime(Math.min(TOTAL - 1, Math.max(0, next)));
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === ' ') { event.preventDefault(); if (time >= TOTAL - 1) { seek(0); setPlaying(true); } else setPlaying(current => !current); }
      if (event.key === 'ArrowRight') seek(STARTS[Math.min(SCENES.length - 1, index + 1)]!);
      if (event.key === 'ArrowLeft') seek(STARTS[Math.max(0, index - 1)]!);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const controls = 150;
  const scale = Math.min(viewport.width / STAGE.width, (viewport.height - controls) / STAGE.height);
  const seconds = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  return <div className="flex flex-col items-center" style={{ height: '100dvh', overflow: 'hidden', background: '#0b0b0d' }}>
    <div style={{ width: STAGE.width * scale, height: STAGE.height * scale, overflow: 'hidden', flexShrink: 0 }}>
      <div className="relative bg-background" style={{ width: STAGE.width, height: STAGE.height, transform: `scale(${scale})`, transformOrigin: '0 0', overflow: 'hidden' }}>
        {scene.render(time - STARTS[index]!)}
      </div>
    </div>
    <div style={{ width: STAGE.width * scale, color: '#d4d4d8', fontSize: 13, padding: '12px 4px 0' }}>
      <p style={{ minHeight: 56, margin: '0 0 10px', color: '#fafafa', fontSize: 19, lineHeight: '28px', textAlign: 'center' }}>{scene.caption}</p>
      <div style={{ display: 'flex', gap: 3, cursor: 'pointer' }} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); seek(((event.clientX - box.left) / box.width) * TOTAL); }}>
        {SCENES.map((item, position) => {
          const done = Math.min(1, Math.max(0, (time - STARTS[position]!) / item.ms));
          return <div key={item.title} title={item.title} style={{ flex: item.ms, height: 6, borderRadius: 3, background: '#3f3f46', overflow: 'hidden' }}><div style={{ width: `${done * 100}%`, height: '100%', background: '#fafafa' }} /></div>;
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <button type="button" style={{ background: '#fafafa', color: '#0b0b0d', border: 0, borderRadius: 6, padding: '4px 12px', fontWeight: 600, cursor: 'pointer' }}
          onClick={() => { if (time >= TOTAL - 1) { seek(0); setPlaying(true); } else setPlaying(current => !current); }}>{time >= TOTAL - 1 ? 'Replay' : playing ? 'Pause' : 'Play'}</button>
        <button type="button" style={{ background: 'transparent', color: '#d4d4d8', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }} onClick={() => seek(STARTS[Math.max(0, index - 1)]!)}>‹ Scene</button>
        <button type="button" style={{ background: 'transparent', color: '#d4d4d8', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }} onClick={() => seek(STARTS[Math.min(SCENES.length - 1, index + 1)]!)}>Scene ›</button>
        <span>{index + 1} / {SCENES.length} · {scene.title}</span>
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{seconds(time)} / {seconds(TOTAL)}</span>
      </div>
    </div>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <UpstreamVideo />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
