// Batch 18 mockups (kept in the repo: the agreed design; do not delete): Plugins → Browsers, the Inspector's Browser tab,
// and the extension. Static data only.
import {
  Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, CardTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  IconProvider, InputCopy, InputField, InputGroup,
  ShapeProvider, SizeProvider, Switch, TabsSubtle, TabsSubtleItem, TooltipProvider, untitledIcons, useShape,
} from '@gitspace/ui';
import { Cloud01, Eye, MessagePlusSquare, Monitor01, Plus, PuzzlePiece01, RefreshCcw01, SearchMd, StopCircle, Trash01, XClose } from '@untitledui/icons';
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExtensionMock } from './BrowsersMockExtension.js';
import { ShareGuestMock } from './BrowsersMockShare.js';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { restoreAppearance } from './appearance.js';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';

const MonitorGlyph = glyph(Monitor01);
const CloudGlyph = glyph(Cloud01);
const PlusGlyph = glyph(Plus);
const RefreshGlyph = glyph(RefreshCcw01);
const SearchGlyph = glyph(SearchMd);

// Chrome's own tab-group colours, so a workspace looks the same here and in Chrome.
const GROUP = { blue: '#1a73e8', purple: '#a142f4', cyan: '#007b83' };

function Caption({ children }: { children: ReactNode }) { return <p className="text-caption text-muted-foreground">{children}</p>; }
function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-2 text-caption text-muted-foreground"><strong className="text-foreground">Design note · </strong>{children}</p>;
}
function Chip({ color, children }: { color: string; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-caption font-medium text-white" style={{ background: color }}>{children}</span>;
}
function Site({ host, level }: { host: string; level: 'read' | 'interact' | 'full' }) {
  return <span className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 py-0.5 font-mono text-caption">{host}<span className="font-sans text-muted-foreground">· {level}</span></span>;
}

// ── 1 · Plugins → Browsers ──────────────────────────────────────────────────────────────────────────────────────

const projects = [
  { id: 'gitspace', name: 'GitSpace' },
  { id: 'tonetempo', name: 'ToneTempo' },
  { id: 'recordless', name: 'recordless' },
];

function PluginsBrowsers() {
  const [manage, setManage] = useState(false);
  const [pair, setPair] = useState(false);
  return <PageCanvas>
    <PageHeader kicker="Account configuration" title="Plugins" description="Manage account connections, then explicitly grant each project access. Runtime diagnostics are separate and never required for management." />
    <div className="flex flex-wrap items-center gap-3 pb-4">
      <TabsSubtle selectedIndex={2} onSelect={() => {}} idPrefix="mock-plugins" aria-label="Plugin source">
        <TabsSubtleItem index={0} label="Composio plugins · 3" />
        <TabsSubtleItem index={1} label="Custom plugins · 1" />
        <TabsSubtleItem index={2} label="Browsers · 2" />
      </TabsSubtle>
      <InputGroup className="w-full sm:ml-auto sm:max-w-xs"><InputField index={0} label="Filter plugins" labelHidden icon={SearchGlyph} placeholder="Search plugins" value="" onChange={() => {}} /></InputGroup>
      <Button variant="ghost" leadingIcon={RefreshGlyph}>Refresh</Button>
      <Button variant="primary" leadingIcon={PlusGlyph} onClick={() => setPair(true)}>Pair a Chrome</Button>
    </div>
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div><h2 className="text-subtitle font-medium">Your Chromes</h2><p className="text-body text-muted-foreground">Chromes running the GitSpace extension. Pairing lets your account reach a Chrome; agents in a project use it only once you approve it for that project.</p></div>
        <CardGroup orientation="inline" border="outlined" separated>
          <Card size="compact">
            <CardMedia icon={MonitorGlyph} />
            <CardHeader><CardTitle>Studio desktop</CardTitle><CardDescription>Chrome 141 · Windows · extension 5.2.2</CardDescription><span className="text-caption tabular-nums text-muted-foreground">Approved in 2 projects · default in GitSpace · 1 agent using it now</span></CardHeader>
            <CardFooter className="gap-2"><Badge color="green">Online</Badge><Button variant="ghost" onClick={() => setManage(true)}>Manage Chrome</Button><Button variant="tertiary" size="icon-compact" aria-label="Forget Studio desktop"><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></CardFooter>
          </Card>
          <Card size="compact">
            <CardMedia icon={MonitorGlyph} />
            <CardHeader><CardTitle>Darktop</CardTitle><CardDescription>Chrome 141 · Linux · extension 5.2.2</CardDescription><span className="text-caption text-[#b45309]">Paired, but not approved for any project, so no agent can use it.</span></CardHeader>
            <CardFooter className="gap-2"><Badge color="gray">Offline · seen 2 h ago</Badge><Button variant="secondary" onClick={() => setManage(true)}>Approve for projects</Button><Button variant="tertiary" size="icon-compact" aria-label="Forget Darktop"><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></CardFooter>
          </Card>
        </CardGroup>
      </section>
      <section className="flex flex-col gap-3">
        <div><h2 className="text-subtitle font-medium">Cloud browser</h2><p className="text-body text-muted-foreground">Headless Chromium with one profile per workspace. Always available; which sites it may open comes from each project&apos;s bundle.</p></div>
        <CardGroup orientation="inline" border="outlined" separated>
          <Card size="compact"><CardMedia icon={CloudGlyph} /><CardHeader><CardTitle>Cloud browser</CardTitle><CardDescription>Built in · every project</CardDescription><span className="text-caption tabular-nums text-muted-foreground">3 workspaces have open tabs</span></CardHeader><CardFooter><Badge color="blue">Built in</Badge></CardFooter></Card>
        </CardGroup>
      </section>
      <Note>Browsers sit beside Composio and custom plugins because they work the same way: connect once to the account, then grant per project. &ldquo;Manage Chrome&rdquo; replaces Settings → Connections → Browser Relay and the Chrome section of project settings; both go away.</Note>
    </div>
    <ManageChromeDialog open={manage} onOpenChange={setManage} />
    <PairChromeDialog open={pair} onOpenChange={setPair} />
  </PageCanvas>;
}

function ManageChromeDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [approved, setApproved] = useState<Record<string, boolean>>({ gitspace: true, tonetempo: true, recordless: false });
  const [defaults, setDefaults] = useState<Record<string, boolean>>({ gitspace: true, tonetempo: false, recordless: false });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent size="lg">
    <DialogHeader><DialogTitle>Studio desktop</DialogTitle><DialogDescription>Paired Oct 23 · fingerprint <span className="font-mono">9F2A 61C0 3B7E D104</span> · online now</DialogDescription></DialogHeader>
    <InputGroup><InputField index={0} label="Name" value="Studio desktop" onChange={() => {}} /><InputField index={1} label="Note for agents" value="Signed in to the staging admin account" onChange={() => {}} /></InputGroup>
    <section className="flex flex-col gap-2">
      <div><h3 className="text-body font-medium">Projects</h3><Caption>Approving is your personal permission, not a repository setting. Each workspace gets its own tab group; the project&apos;s approved sites still apply. The default answers requests that don&apos;t name a Chrome.</Caption></div>
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {projects.map(project => <div key={project.id} className="flex items-center gap-3 px-3 py-2">
          <span className="min-w-0 flex-1 text-body">{project.name}</span>
          {approved[project.id] ? defaults[project.id]
            ? <Badge color="gray">Project default</Badge>
            : <Button variant="ghost" size="compact" onClick={() => setDefaults(current => ({ ...current, [project.id]: true }))}>Make default</Button> : null}
          <Switch checked={approved[project.id] ?? false} label={approved[project.id] ? 'Approved' : 'Not approved'} onToggle={() => setApproved(current => ({ ...current, [project.id]: !current[project.id] }))} />
        </div>)}
      </div>
    </section>
    <DialogFooter><Button variant="tertiary">Forget this Chrome</Button><Button variant="secondary" onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return <li className="flex gap-3">
    <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-caption font-semibold ${done ? 'bg-[#22c55e] text-white' : 'bg-surface-3'}`}>{done ? '✓' : n}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-2 pb-2"><h3 className="text-body font-medium">{title}</h3>{children}</div>
  </li>;
}

function PairChromeDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [answered, setAnswered] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [chosen, setChosen] = useState<Record<string, boolean>>({ gitspace: true, tonetempo: false, recordless: false });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent size="lg">
    <DialogHeader><DialogTitle>Pair a Chrome</DialogTitle><DialogDescription>One pass from install to an agent-ready Chrome. Nothing is usable until you confirm the fingerprint.</DialogDescription></DialogHeader>
    <ol className="flex flex-col gap-2">
      <Step n={1} title="Install the GitSpace extension" done>
        <div className="flex flex-wrap items-center gap-2"><Button variant="secondary" size="compact">Download extension</Button><Caption>Then chrome://extensions → Developer mode → Load unpacked.</Caption></div>
      </Step>
      <Step n={2} title="Paste this into the extension's popup" done={answered}>
        <InputCopy value={'{"code":"K7Q-2MX-91F","pairingId":"bp-4d1e…","expiresAt":"…"}'} displayValue="K7Q-2MX-91F · expires in 9:41" />
      </Step>
      <Step n={3} title="Check it's your Chrome" done={confirmed}>
        {!answered ? <div className="flex items-center gap-2"><StatusDot color="blue" pulse /><Caption>Waiting for a Chrome to answer…</Caption><Button variant="ghost" size="compact" onClick={() => setAnswered(true)}>(simulate answer)</Button></div>
          : <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-3 px-3 py-2"><span className="text-body">A Chrome answered. Its popup should show <span className="font-mono font-semibold">9F2A 61C0 3B7E D104</span></span><Button variant={confirmed ? 'secondary' : 'primary'} size="compact" disabled={confirmed} onClick={() => setConfirmed(true)}>{confirmed ? 'Confirmed' : 'It matches'}</Button></div>}
      </Step>
      <Step n={4} title="Use it in projects">
        <InputGroup><InputField index={0} label="Name this Chrome" value="Studio desktop" onChange={() => {}} /></InputGroup>
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {projects.map(project => <div key={project.id} className="flex items-center gap-3 px-3 py-2"><span className="min-w-0 flex-1 text-body">{project.name}</span>{project.id === 'gitspace' ? <Caption>No default yet · this becomes it</Caption> : null}<Switch checked={chosen[project.id] ?? false} label={chosen[project.id] ? 'Approved' : 'Not approved'} onToggle={() => setChosen(current => ({ ...current, [project.id]: !current[project.id] }))} /></div>)}
        </div>
        <Caption>Opened from a workspace, its project is ticked already.</Caption>
      </Step>
    </ol>
    <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!confirmed} onClick={() => onOpenChange(false)}>Finish</Button></DialogFooter>
  </DialogContent></Dialog>;
}

// ── 2 · Inspector → Browser ─────────────────────────────────────────────────────────────────────────────────────

/** A miniature of httpbin's pizza form, standing in for a tab screenshot. */
function FormPreview({ highlight }: { highlight?: boolean }) {
  const row = (label: string, value = '', hot = false) => <div className="flex flex-col gap-0.5"><span className="text-[7px] text-neutral-600">{label}</span><span className={`h-3 rounded-[2px] border bg-white px-1 text-[7px] leading-[10px] text-neutral-900 ${hot ? 'border-[#1a73e8] outline outline-2 outline-[#1a73e8]/40' : 'border-neutral-300'}`}>{value}</span></div>;
  return <div className="flex h-full flex-col gap-1.5 bg-white p-2 text-left">
    {row('Customer name:', highlight ? 'Ada' : '', highlight)}{row('Telephone:')}{row('E-mail address:')}
    <span className="text-[7px] text-neutral-600">Pizza Size ○ Small ○ Medium ○ Large</span>
    <span className="text-[7px] text-neutral-600">Toppings ☐ Bacon ☐ Extra Cheese ☐ Onion</span>
    <span className="mt-auto w-fit rounded-[2px] border border-neutral-400 bg-neutral-100 px-1 text-[7px] text-neutral-800">Submit order</span>
  </div>;
}
function DocsPreview() {
  return <div className="flex h-full flex-col gap-1 bg-[#0d1117] p-2">
    <span className="h-2 w-20 rounded-sm bg-neutral-600" /><span className="h-1.5 w-full rounded-sm bg-neutral-700" /><span className="h-1.5 w-5/6 rounded-sm bg-neutral-700" /><span className="h-1.5 w-4/6 rounded-sm bg-neutral-700" />
    <span className="mt-2 h-10 w-full rounded-sm bg-neutral-800" />
  </div>;
}

function TabTile({ title, url, by, preview, acting, onWatch }: { title: string; url: string; by: 'agent' | 'you'; preview: ReactNode; acting?: boolean; onWatch(): void }) {
  return <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface-1">
    <button type="button" onClick={onWatch} className="relative aspect-[16/10] overflow-hidden border-b border-border" aria-label={`Watch ${title}`}>
      {preview}
      {acting ? <span className="absolute bottom-1 left-1.5"><Badge size="compact" color="blue">Agent acting</Badge></span> : null}
      <span className="absolute bottom-1 right-1.5 rounded bg-black/60 px-1 text-[10px] text-white">3 s ago</span>
    </button>
    <div className="flex flex-col gap-0.5 px-2.5 py-2"><span className="truncate text-caption font-medium">{title}</span><span className="truncate font-mono text-[11px] text-muted-foreground">{url}</span></div>
    <div className="flex items-center gap-1 px-1.5 pb-1.5"><Badge size="compact" color="gray">{by === 'agent' ? 'Opened by agent' : 'You added it'}</Badge><span className="flex-1" /><Button variant="ghost" size="icon-compact" aria-label="Watch" onClick={onWatch}><Eye width={14} height={14} /></Button><Button variant="ghost" size="icon-compact" aria-label="Close tab"><XClose width={14} height={14} /></Button></div>
  </div>;
}

function BrowserCard({ icon, title, meta, badges, group, children }: { icon: ReactNode; title: string; meta: string; badges: ReactNode; group?: ReactNode; children: ReactNode }) {
  const shape = useShape();
  return <section className={`${shape.container} flex flex-col gap-3 bg-surface-1 p-3 shadow-surface-1`}>
    <header className="flex flex-wrap items-center gap-2"><span className="text-muted-foreground">{icon}</span><h3 className="text-body font-medium">{title}</h3>{badges}<span className="flex-1" /><span className="text-caption text-muted-foreground">{meta}</span></header>
    {group}
    {children}
  </section>;
}

/** Pasting a tab link from the extension's Share: GitSpace turns it into a tab chip; sending connects the tab. */
function PastedTabLink() {
  const [sent, setSent] = useState(false);
  const chip = <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1 text-caption"><Monitor01 width={13} height={13} /><strong className="font-medium">news.ycombinator.com</strong><span className="text-muted-foreground">· Studio desktop</span></span>;
  return <div className="mt-auto flex max-w-xl flex-col gap-2">
    {sent ? <>
      <div className="flex flex-col items-end gap-1.5 self-end"><div className="flex flex-col gap-1.5 rounded-xl bg-surface-3 p-3 text-body">{chip}Can you summarise the top comments on this thread?</div></div>
      <p className="flex items-center gap-2 text-caption text-muted-foreground"><span className="size-2 rounded-full" style={{ background: GROUP.blue }} />Tab connected: news.ycombinator.com joined this workspace&apos;s group in Studio desktop. The agent may use it while it stays there.</p>
    </> : null}
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-1 p-3 shadow-surface-1">
      {sent ? null : <div className="flex flex-wrap items-center gap-2">{chip}<span className="text-caption text-muted-foreground">Pasted tab link · joins this workspace when you send</span><Button variant="ghost" size="icon-compact" aria-label="Remove tab"><XClose width={14} height={14} /></Button></div>}
      <p className={`text-body ${sent ? 'text-muted-foreground' : ''}`}>{sent ? 'Message' : 'Can you summarise the top comments on this thread?'}</p>
      <div className="flex justify-end"><Button variant="primary" size="compact" disabled={sent} onClick={() => setSent(true)}>Send</Button></div>
    </div>
    <Caption>The link never reaches the agent: the composer swaps it for the chip. An expired or stopped link, or another account&apos;s: the chip says so and nothing connects. The same link opened in a browser is a person&apos;s viewer instead.</Caption>
    {sent ? <Button variant="ghost" size="compact" onClick={() => setSent(false)}>(reset)</Button> : null}
  </div>;
}

type Capture = { name: string; kinds: string[]; tracks: string[]; meta: string; preview: ReactNode; live?: boolean; status?: { label: string; color: 'gray' | 'green' } };
const captures: Capture[] = [
  { name: 'Pizza form review', kinds: ['comments', 'video'], tracks: ['2 comments', 'video 4:12', 'layout'], meta: 'Bradley · Studio desktop · httpbin.org/forms/post · capturing now', preview: <FormPreview />, live: true },
  { name: 'Order a pizza', kinds: ['steps', 'comments', 'video'], tracks: ['5 steps', '1 comment', 'video 0:14 · sound', 'layout'], meta: 'Bradley · Studio desktop · 19:31', preview: <FormPreview highlight />, status: { label: 'Not in repo', color: 'gray' } },
  { name: 'Sign in to staging', kinds: ['steps', 'video'], tracks: ['9 steps', 'video 0:41'], meta: 'main saved it to .gitspace/skills/staging-sign-in in a3f9c21 after you asked', preview: <DocsPreview />, status: { label: 'Saved as skill', color: 'green' } },
  { name: 'Settings page after the fix', kinds: ['screenshot'], tracks: ['screenshot · 1440×900'], meta: 'main · capture() in a run · cloud browser · 19:12', preview: <DocsPreview /> },
];

type InspectorState = 'working' | 'approval' | 'none';
function InspectorBrowser() {
  const [state, setState] = useState<InspectorState>('working');
  const [watching, setWatching] = useState(false);
  const [captureFilter, setCaptureFilter] = useState(0);
  const states: InspectorState[] = ['working', 'approval', 'none'];
  return <div className="flex h-[calc(100dvh-57px)] min-h-0">
    <div className="hidden min-w-0 flex-1 flex-col gap-3 border-r border-border p-6 lg:flex">
      <span className="text-caption text-muted-foreground">Cross-machine browser relay · conversation</span>
      <div className="max-w-xl rounded-xl bg-surface-2 p-3 text-body">Run 2: <code>act(&quot;4ed25e98:3&quot;, &quot;fill&quot;, &quot;Ada&quot;)</code> on your Chrome…</div>
      <div className="mt-2 flex items-center gap-2"><TabsSubtle size="compact" selectedIndex={states.indexOf(state)} onSelect={index => setState(states[index] ?? 'working')} idPrefix="mock-state" aria-label="Mock state">
        <TabsSubtleItem index={0} label="State: working" /><TabsSubtleItem index={1} label="Chrome needs approval" /><TabsSubtleItem index={2} label="No Chrome paired" />
      </TabsSubtle></div>
      <Note>The Browser tab sits next to Environment. Environment keeps one line (&ldquo;Browser · 2 browsers, 1 running&rdquo;) linking here, and drops the &ldquo;Browser access and recovery&rdquo; block.</Note>
      <PastedTabLink />
    </div>
    <div className="flex w-full min-w-0 flex-col bg-surface-2 lg:w-[640px]">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
        <TabsSubtle size="compact" className="min-w-0 flex-1" selectedIndex={2} onSelect={() => {}} idPrefix="mock-inspector" aria-label="Inspector views">
          {['Overview', 'Environment', state === 'working' ? 'Browser · 2' : 'Browser', 'Goal', 'Agent setup', 'Files', 'Drive', 'Services'].map((label, index) => <TabsSubtleItem index={index} label={label} key={label} />)}
        </TabsSubtle>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-8 pt-2">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2"><h3 className="text-body font-medium">Approved sites</h3><Button variant="ghost" size="compact">Ask agent to add a site</Button></div>
          <div className="flex flex-wrap gap-1.5"><Site host="httpbin.org" level="interact" /><Site host="github.com" level="read" /><Site host="localhost:5173" level="full" /></div>
          <Caption>From .gitspace/bundle.json at dd0a157. Your Chrome only opens these; the cloud browser is unrestricted.</Caption>
        </section>

        {state === 'approval' ? <section className="flex flex-col gap-3 rounded-xl border border-[#f59e0b]/50 bg-[#f59e0b]/10 p-3">
          <div><h3 className="text-body font-medium">Agents here can&apos;t use your Chrome yet</h3><p className="text-caption text-muted-foreground">Studio desktop is paired and online, but not approved for GitSpace. Approving makes it the project default, since GitSpace has none.</p></div>
          <div className="flex flex-wrap gap-2"><Button variant="primary" size="compact">Approve Studio desktop for GitSpace</Button><Button variant="ghost" size="compact">Manage Chromes</Button></div>
        </section> : null}
        {state === 'none' ? <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-1 p-3">
          <div><h3 className="text-body font-medium">Let agents use your own Chrome</h3><p className="text-caption text-muted-foreground">For sites where you&apos;re signed in. Agents get one tab group per workspace and only the sites above.</p></div>
          <div><Button variant="secondary" size="compact" leadingIcon={PlusGlyph}>Pair a Chrome</Button></div>
        </section> : null}

        {state === 'working' ? <BrowserCard icon={<Monitor01 width={18} height={18} />} title="Studio desktop" meta="Your Chrome · online" badges={<Badge size="compact" color="gray">Project default</Badge>}
          group={<div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-3 px-2.5 py-2">
            <Chip color={GROUP.blue}>▶ Cross-machine browser relay</Chip>
            <span className="text-caption">main · <code>browser.run</code> · 4 commands · 0:12</span><span className="flex-1" />
            <Button variant="secondary" size="compact" leadingIcon={glyph(StopCircle)}>Stop</Button>
          </div>}>
          <div className="grid grid-cols-2 gap-2">
            <TabTile title="httpbin.org — Forms" url="httpbin.org/forms/post" by="agent" acting preview={<FormPreview highlight />} onWatch={() => setWatching(true)} />
            <TabTile title="Pull request #153" url="github.com/inkibra/gitspace/pull/153" by="you" preview={<DocsPreview />} onWatch={() => setWatching(true)} />
          </div>
        </BrowserCard> : null}

        <BrowserCard icon={<Cloud01 width={18} height={18} />} title="Cloud browser" meta="Headless · this workspace's profile" badges={null}>
          {state === 'working' ? <div className="grid grid-cols-2 gap-2"><TabTile title="Vite app" url="localhost:5173/settings" by="agent" preview={<DocsPreview />} onWatch={() => setWatching(true)} /></div>
            : <Caption>No open tabs.</Caption>}
        </BrowserCard>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body font-medium">Captures</h3>
            <TabsSubtle size="compact" selectedIndex={captureFilter} onSelect={setCaptureFilter} idPrefix="mock-captures" aria-label="Capture kind">{['All · 4', 'Steps · 2', 'Comments · 2', 'Video · 3', 'Screenshots · 1'].map((label, index) => <TabsSubtleItem key={label} index={index} label={label} />)}</TabsSubtle>
          </div>
          <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-1 text-caption">
            {captures.filter(capture => captureFilter === 0 || capture.kinds.includes(['', 'steps', 'comments', 'video', 'screenshot'][captureFilter] ?? '')).map(capture => <div key={capture.name} className="flex items-center gap-3 p-2.5">
              <span className="relative aspect-[16/10] w-24 shrink-0 overflow-hidden rounded-md border border-border">{capture.preview}{capture.live ? <span className="absolute left-1 top-1"><Badge size="compact" color="red">● live</Badge></span> : null}</span>
              <div className="min-w-0 flex-1">
                <p className="text-body">{capture.name}</p>
                <div className="mt-0.5 flex flex-wrap gap-1">{capture.tracks.map(track => <span key={track} className="rounded-full bg-surface-3 px-1.5 py-px text-[11px]">{track}</span>)}{capture.status ? <Badge size="compact" color={capture.status.color}>{capture.status.label}</Badge> : null}</div>
                <p className="mt-0.5 truncate text-muted-foreground">{capture.meta}</p>
              </div>
              <Button variant="ghost" size="compact">Mention</Button><Button variant="ghost" size="compact">{capture.kinds.includes('screenshot') ? 'View' : 'Play'}</Button><Button variant="secondary" size="compact">Share</Button>
            </div>)}
          </div>
          <Caption>Everything you or an agent captures, one list. A capture is tracks: steps, comments, video, page layout; a screenshot is one frame. Nothing here is in the repository until the agent saves it there; mention one in the chat to use it.</Caption>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-body font-medium">Recent runs</h3>
          <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-1 text-caption">
            {(state === 'working' ? [
              { at: '19:21', where: 'Studio desktop', what: 'act fill “Customer name” → {"name":"Ada"}', ok: true },
              { at: '19:20', where: 'Studio desktop', what: 'goto httpbin.org/forms/post → view, 25 refs', ok: true },
              { at: '19:12', where: 'Your Chrome', what: 'Refused: no Chrome approved for GitSpace', ok: false },
            ] : [{ at: '19:12', where: 'Your Chrome', what: 'Refused: no Chrome approved for GitSpace', ok: false }]).map(run => <div key={run.at} className="flex items-center gap-2 px-3 py-2"><span className="tabular-nums text-muted-foreground">{run.at}</span><span className="w-28 shrink-0 truncate">{run.where}</span><span className={`min-w-0 flex-1 truncate font-mono ${run.ok ? '' : 'text-destructive'}`}>{run.what}</span><Button variant="ghost" size="compact">Details</Button></div>)}
          </div>
          <Caption>Recovery records appear here only when a group needs repair.</Caption>
        </section>
      </div>
    </div>
    <Dialog open={watching} onOpenChange={setWatching}><DialogContent size="lg">
      <DialogHeader><DialogTitle>httpbin.org — Forms</DialogTitle><DialogDescription>Studio desktop · Cross-machine browser relay group · screenshot every few seconds (live video comes with Batch 16)</DialogDescription></DialogHeader>
      <div className="aspect-[16/10] overflow-hidden rounded-lg border border-border [&_*]:!text-[13px] [&_span]:!h-auto"><FormPreview highlight /></div>
      <DialogFooter><Button variant="ghost">Focus in Chrome</Button><Button variant="secondary">Take over</Button><Button variant="primary" onClick={() => setWatching(false)}>Done</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────────────────────────

function BrowsersMock() {
  const [view, setView] = useState(() => Number(new URLSearchParams(location.search).get('view') ?? 0));
  return <div className="flex h-dvh flex-col bg-background">
    <header className="flex shrink-0 items-center gap-4 border-b border-border bg-surface-1 px-6 py-3">
      <PuzzlePiece01 width={18} height={18} /><span className="text-body font-semibold">Batch 18 mockups</span>
      <TabsSubtle selectedIndex={view} onSelect={setView} idPrefix="mock-view" aria-label="Mockup">
        <TabsSubtleItem index={0} label="1 · Plugins → Browsers" />
        <TabsSubtleItem index={1} label="2 · Inspector → Browser" />
        <TabsSubtleItem index={2} label="3 · Extension" />
        <TabsSubtleItem index={3} label="4 · Joining a share" />
      </TabsSubtle>
    </header>
    {view === 0 ? <PluginsBrowsers /> : view === 1 ? <InspectorBrowser /> : view === 2 ? <ExtensionMock /> : <ShareGuestMock />}
  </div>;
}

restoreAppearance();
const container = document.getElementById('root');
if (!container) throw new Error('root missing');
// Hot updates re-run this module; keep the one React root.
const root: Root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<StrictMode><ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider><BrowsersMock /></TooltipProvider></IconProvider></SizeProvider></ShapeProvider></StrictMode>);
