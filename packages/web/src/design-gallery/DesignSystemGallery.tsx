import {
  AccordionContent, AccordionGroup, AccordionItem, AccordionTrigger,
  AskUserQuestions, Badge, Button,
  Card, CardButton, CardContent, CardDescription, CardEyebrow, CardFeature, CardFooter, CardGroup, CardHeader, CardImage, CardMedia, CardTitle,
  ChatMessage, CheckboxGroup, CheckboxItem, ColorPicker,
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
  Dropdown, DropdownContent, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger, Elevated,
  InputCopy, InputField, InputGroup, InputMessage, MenuItem,
  RadioGroup, RadioItem,
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger,
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupActions, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar,
  SidebarMenu, SidebarMenuAction, SidebarMenuActions, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
  SidebarProvider, SidebarSearchField, SidebarUserFooter, SidebarWorkspaceHeader,
  Slider, Switch,
  TabItem, TabPanel, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsList, TabsSubtle, TabsSubtleItem, TabsSubtlePanel,
  ThinkingIndicator, ThinkingStep, ThinkingStepDetails, ThinkingStepSource, ThinkingStepSources, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader,
  Tooltip, WorkspaceTile, useIcons, useShape,
  type AskUserAnswer, type AskUserQuestion, type QueuedMessage, type SliderValue,
} from '@gitspace/ui';
import { Archive, ArrowUpRight, Calendar, Code01, Columns03, Copy01, DotsHorizontal, FilterLines, FolderClosed, GitBranch01, HardDrive, Inbox01, Key01, Paperclip, Plus, PuzzlePiece01, RefreshCcw01, Server01, Stars01, Terminal, Zap } from '@untitledui/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { glyph } from '../glyph.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { EmptyState, PageHeader, StatusDot } from '../GitSpaceShell.js';

// ── Demo data ──

const SECTIONS = [
  { id: 'primitives', index: '01', label: 'Primitives' },
  { id: 'choices', index: '02', label: 'Choice & data' },
  { id: 'cards', index: '03', label: 'Cards' },
  { id: 'agent', index: '04', label: 'Agent' },
  { id: 'surfaces', index: '05', label: 'Surfaces' },
  { id: 'sidebar', index: '06', label: 'Sidebar' },
  { id: 'markdown', index: '07', label: 'Markdown' },
] as const;

const BranchIcon = glyph(GitBranch01);
const ServerIcon = glyph(Server01);
const TerminalIcon = glyph(Terminal);
const HardDriveIcon = glyph(HardDrive);
const ArchiveIcon = glyph(Archive);
const CodeIcon = glyph(Code01);
const ZapIcon = glyph(Zap);

const BRANCHES = [
  { value: 'main', label: 'main' },
  { value: 'develop', label: 'develop' },
  { value: 'release/2.4', label: 'release/2.4' },
] as const;

const MODELS = ['Claude Sonnet', 'Claude Opus', 'GPT-5'] as const;

const FEATURES = [
  { icon: ZapIcon, title: 'Fluid motion', description: 'Spring-tuned transitions calibrated across three tiers' },
  { icon: ServerIcon, title: 'Possessed by a machine', description: 'Every workspace runs where its files live' },
  { icon: BranchIcon, title: 'Branch-native', description: 'Plan, code, review, ship on real git refs' },
  { icon: TerminalIcon, title: 'Terminal dock', description: 'Attach a shell to any running agent' },
] as const;

// Deterministic banner for the image cards — an inline asset, so the gallery
// screenshot never depends on the network.
const BANNER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236B97FF'/%3E%3Cstop offset='1' stop-color='%23A78BFA'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='360' fill='url(%23g)'/%3E%3Ccircle cx='470' cy='130' r='96' fill='%23fff' fill-opacity='.18'/%3E%3Ccircle cx='170' cy='250' r='60' fill='%23fff' fill-opacity='.12'/%3E%3C/svg%3E";

const MEMBERS = [
  { name: 'Alice Park', role: 'Engineer', status: 'green', label: 'Active', workspaces: 4 },
  { name: 'Bob Chen', role: 'Designer', status: 'orange', label: 'Away', workspaces: 2 },
  { name: 'Cleo Ruiz', role: 'Reviewer', status: 'dim', label: 'Offline', workspaces: 11 },
] as const;

const QUESTIONS: AskUserQuestion[] = [
  { id: 'role', title: 'How do you plan to use GitSpace?', options: [{ id: 'designer', title: 'Designer', description: 'Prototyping flows' }, { id: 'engineer', title: 'Engineer', description: 'Shipping production UI' }, { id: 'lead', title: 'Tech lead', description: 'Reviewing and shipping' }] },
  { id: 'phases', title: 'Which phases should the agent own?', multiSelect: true, allowOther: true, otherPlaceholder: 'Something else…', options: [{ id: 'plan', title: 'Plan' }, { id: 'code', title: 'Code' }, { id: 'review', title: 'Review' }, { id: 'ship', title: 'Ship' }] },
  { id: 'goal', title: 'What should the first workspace accomplish?', freeText: true, freeTextPlaceholder: 'Describe the outcome in a sentence or two', skippable: true },
];

const INITIAL_QUEUE: QueuedMessage[] = [
  { id: 'q-1', text: 'Then run the full test suite.', files: [] },
  { id: 'q-2', text: 'Open a pull request once it is green.', files: [] },
];

const NAV = [
  { label: 'Kanban', icon: glyph(Columns03) },
  { label: 'Projects', icon: glyph(FolderClosed) },
  { label: 'Plugins', icon: glyph(PuzzlePiece01) },
  { label: 'Skills', icon: glyph(Stars01) },
  { label: 'Crons', icon: glyph(Calendar) },
  { label: 'Secrets', icon: glyph(Key01) },
  { label: 'Inbox', icon: glyph(Inbox01), badge: 3 },
] as const;

const THREADS = [
  { label: 'Repository review', status: 'active' },
  { label: 'Runtime audit', status: 'unread', badge: 2 },
  { label: 'Release notes', status: 'idle' },
  { label: 'Flaky test triage', status: 'unread', badge: 5 },
] as const;

const WORKSPACES = [
  { name: 'agent-blame', phase: 'code', active: true },
  { name: 'fluid-cutover', phase: 'review', active: false },
  { name: 'terminal-dock', phase: 'plan', active: false },
] as const;

const SURFACE_TILES = [
  'bg-surface-1 shadow-surface-1', 'bg-surface-2 shadow-surface-2', 'bg-surface-3 shadow-surface-3', 'bg-surface-4 shadow-surface-4',
  'bg-surface-5 shadow-surface-5', 'bg-surface-6 shadow-surface-6', 'bg-surface-7 shadow-surface-7', 'bg-surface-8 shadow-surface-8',
] as const;

const MARKDOWN = `## Transcript result

Streamdown renders **readable prose**, [safe links](https://github.com), tables, code, diagrams, and math.

| Surface | State |
| --- | --- |
| Transcript | Ready |
| Inspector | Ready |

~~~typescript
const renderer = "streamdown";
~~~

~~~mermaid
flowchart LR
  OMP --> Blocks
  Blocks --> Streamdown
~~~

$$E = mc^2$$`;

// ── Scaffolding ──

function GallerySection({ id, index, title, description, children }: { id: string; index: string; title: string; description?: string; children: ReactNode }) {
  // `design-gallery-section` is an unstyled marker the Playwright overlap check queries.
  return <section id={id} className="design-gallery-section flex scroll-mt-24 flex-col gap-6 pt-14">
    <header className="flex flex-col gap-1">
      <div className="flex items-baseline gap-3">
        <span className="text-caption font-mono tabular-nums text-muted-foreground">{index}</span>
        <h2 className="text-title font-semibold text-foreground">{title}</h2>
      </div>
      {description ? <p className="max-w-2xl text-body text-muted-foreground">{description}</p> : null}
    </header>
    {children}
  </section>;
}

function Demo({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const shape = useShape();
  return <div className={`${shape.container} flex min-w-0 flex-col gap-4 border border-border p-4 sm:p-5 ${className}`}>
    <span className="text-caption font-medium text-muted-foreground">{title}</span>
    {children}
  </div>;
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

// ── 01 Primitives ──

function PrimitivesSection() {
  const icons = useIcons();
  const [search, setSearch] = useState('agent-blame');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('studio');
  const [notifications, setNotifications] = useState(true);
  const [branch, setBranch] = useState('main');
  const [model, setModel] = useState(0);
  const [connection, setConnection] = useState('Local filesystem');
  const [transport, setTransport] = useState('stdio');
  return <GallerySection id="primitives" index="01" title="Primitives" description="Buttons, badges, fields, menus, and the dialog — every control rides the same 36px ladder, press geometry, and weight transitions.">
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Demo title="Button — variants, sizes, states">
        <Row><Button variant="primary">Primary</Button><Button variant="secondary">Secondary</Button><Button variant="tertiary">Tertiary</Button><Button variant="ghost">Ghost</Button></Row>
        <Row><Button variant="primary" size="compact">Compact</Button><Button variant="secondary" size="compact" leadingIcon={icons.plus}>New workspace</Button><Button variant="secondary" trailingIcon={icons['chevron-down']}>Model</Button></Row>
        <Row>
          <Button variant="primary" loading>Saving</Button>
          <Button variant="secondary" disabled>Disabled</Button>
          <Button variant="secondary" active>Active</Button>
          <Tooltip content="Create workspace"><Button variant="ghost" size="icon" aria-label="Create workspace"><Plus width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
          <Tooltip content="Open in terminal" side="bottom"><Button variant="secondary" size="icon" aria-label="Open in terminal"><Terminal width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
        </Row>
      </Demo>
      <Demo title="Badge — colors and variants">
        <Row><Badge color="green">Running</Badge><Badge color="amber">Waiting</Badge><Badge color="red">Failed</Badge><Badge color="blue">Review</Badge><Badge color="violet">Plan</Badge><Badge color="gray">Archived</Badge></Row>
        <Row><Badge variant="dot" color="green">Online</Badge><Badge variant="dot" color="orange">Away</Badge><Badge variant="dot" color="gray">Offline</Badge><Badge size="compact" color="teal">compact</Badge><Badge size="compact" variant="dot" color="pink">compact dot</Badge></Row>
        <Row><Switch label="Notifications" checked={notifications} onToggle={() => setNotifications((current) => !current)} /><Switch label="Locked" checked disabled onToggle={() => undefined} /></Row>
      </Demo>
      <Demo title="InputGroup / InputField">
        <InputGroup>
          <InputField index={0} label="Search" labelHidden placeholder="Search workspaces…" icon={icons.search} value={search} onChange={setSearch} />
          <InputField index={1} label="Workspace name" placeholder="agent-blame" value={name} onChange={setName} />
          <InputField index={2} label="Handle" value={handle} onChange={setHandle} error="That handle is reserved" />
          <InputField index={3} label="Owner" value="bradleat" onChange={() => undefined} disabled />
        </InputGroup>
      </Demo>
      <Demo title="InputCopy">
        <InputCopy label="Install" value="npx shadcn@latest add @fluid/sidebar" />
        <InputCopy label="API key" variant="button" align="left" value="gs_live_4f2a9c1e7b3d" />
      </Demo>
      <Demo title="Select">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select value={branch} onValueChange={setBranch}>
            <SelectTrigger aria-label="Base branch" icon={BranchIcon} placeholder="Choose a branch" />
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Branches</SelectLabel>
                {BRANCHES.map((item, index) => <SelectItem key={item.value} index={index} value={item.value} icon={BranchIcon}>{item.label}</SelectItem>)}
              </SelectGroup>
              <SelectSeparator />
              <SelectItem index={BRANCHES.length} value="pr" disabled>Pull request (coming soon)</SelectItem>
            </SelectContent>
          </Select>
          <Select defaultValue="">
            <SelectTrigger aria-label="Machine" placeholder="Pick a machine" error="Choose where the workspace runs" />
            <SelectContent>
              <SelectItem index={0} value="local" icon={HardDriveIcon}>This machine</SelectItem>
              <SelectItem index={1} value="build" icon={ServerIcon}>build-box</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Demo>
      <Demo title="Dropdown — inline panel and popup menu">
        <div className="flex flex-wrap items-start gap-4">
          <Dropdown aria-label="Model" checkedIndex={model} className="w-64">
            <DropdownLabel>Model</DropdownLabel>
            {MODELS.map((label, index) => <MenuItem key={label} index={index} label={label} checked={model === index} onSelect={() => setModel(index)} />)}
            <DropdownSeparator />
            <MenuItem index={MODELS.length} icon={icons.settings} label="Model settings" onSelect={() => undefined} />
          </Dropdown>
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="secondary" trailingIcon={icons['chevron-down']}>Workspace actions</Button>} />
            <DropdownContent align="start">
              <MenuItem index={0} icon={icons.pencil} label="Rename" onSelect={() => undefined} />
              <MenuItem index={1} icon={icons.copy} label="Duplicate" onSelect={() => undefined} />
              <DropdownSeparator />
              <MenuItem index={2} icon={ArchiveIcon} label="Archive" onSelect={() => undefined} />
            </DropdownContent>
          </DropdownMenu>
        </div>
      </Demo>
    </div>
    <Demo title="Dialog">
      <Row>
        <Dialog>
          <DialogTrigger render={<Button variant="secondary">Open dialog</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect local MCP server</DialogTitle>
              <DialogDescription>Connection details belong to your principal and never leave this machine.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              <InputGroup className="w-full">
                <InputField index={0} label="Connection name" value={connection} onChange={setConnection} autoFocus />
              </InputGroup>
              <Select value={transport} onValueChange={setTransport}>
                <SelectTrigger aria-label="Transport" />
                <SelectContent>
                  <SelectItem index={0} value="stdio">stdio</SelectItem>
                  <SelectItem index={1} value="http">Streamable HTTP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="secondary">Cancel</Button>} />
              <Button variant="primary">Connect</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <span className="text-caption text-muted-foreground">Traps focus, closes on Escape, restores focus to the trigger.</span>
      </Row>
    </Demo>
  </GallerySection>;
}

// ── 02 Choice & data ──

function ChoicesSection() {
  const icons = useIcons();
  const [checked, setChecked] = useState(() => new Set([0]));
  const [role, setRole] = useState('engineer');
  const [opacity, setOpacity] = useState<SliderValue>(72);
  const [range, setRange] = useState<SliderValue>([2, 6]);
  const [subtleTab, setSubtleTab] = useState(0);
  const [color, setColor] = useState('#6B97FF');
  const toggle = (index: number) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  return <GallerySection id="choices" index="02" title="Choice & data" description="Selection groups share one proximity-hover system; tables, tabs, and accordions carry the same traveling highlight.">
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Demo title="CheckboxGroup">
        <CheckboxGroup checkedIndices={checked}>
          <CheckboxItem index={0} label="Spring motion" checked={checked.has(0)} onToggle={() => toggle(0)} />
          <CheckboxItem index={1} label="Proximity hover" checked={checked.has(1)} onToggle={() => toggle(1)} />
          <CheckboxItem index={2} label="Relative surfaces" checked={checked.has(2)} onToggle={() => toggle(2)} />
        </CheckboxGroup>
      </Demo>
      <Demo title="RadioGroup">
        <RadioGroup value={role} onValueChange={setRole}>
          <RadioItem index={0} value="designer" label="Designer" />
          <RadioItem index={1} value="engineer" label="Engineer" />
          <RadioItem index={2} value="lead" label="Tech lead" />
        </RadioGroup>
      </Demo>
      <Demo title="Slider — pips and range">
        <Slider label="Opacity" value={opacity} min={0} max={100} step={1} onChange={setOpacity} formatValue={(value) => `${value}%`} />
        <Slider label="Surface range" value={range} min={1} max={8} step={1} showSteps showValue onChange={setRange} />
      </Demo>
      <Demo title="Tabs / TabsSubtle">
        <Tabs defaultValue="active">
          <TabsList>
            <TabItem value="active" label="Active" />
            <TabItem value="archived" label="Archived" />
            <TabItem value="all" label="All" />
          </TabsList>
          <TabPanel value="active"><p className="pt-3 text-body text-muted-foreground">Three workspaces are running.</p></TabPanel>
          <TabPanel value="archived"><p className="pt-3 text-body text-muted-foreground">Twelve workspaces were archived this month.</p></TabPanel>
          <TabPanel value="all"><p className="pt-3 text-body text-muted-foreground">Fifteen workspaces across two machines.</p></TabPanel>
        </Tabs>
        <TabsSubtle selectedIndex={subtleTab} onSelect={setSubtleTab} idPrefix="gallery-subtle">
          <TabsSubtleItem index={0} icon={icons.clock} label="Recent" />
          <TabsSubtleItem index={1} icon={icons.star} label="Starred" />
          <TabsSubtleItem index={2} icon={icons.folder} label="Projects" />
        </TabsSubtle>
        <TabsSubtlePanel index={0} selectedIndex={subtleTab} idPrefix="gallery-subtle"><p className="text-body text-muted-foreground">Recently opened workspaces.</p></TabsSubtlePanel>
        <TabsSubtlePanel index={1} selectedIndex={subtleTab} idPrefix="gallery-subtle"><p className="text-body text-muted-foreground">Workspaces you starred.</p></TabsSubtlePanel>
        <TabsSubtlePanel index={2} selectedIndex={subtleTab} idPrefix="gallery-subtle"><p className="text-body text-muted-foreground">Every project on this machine.</p></TabsSubtlePanel>
      </Demo>
      <Demo title="Table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Workspaces</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MEMBERS.map((member, index) => <TableRow key={member.name} index={index}>
              <TableCell className="text-foreground">{member.name}</TableCell>
              <TableCell>{member.role}</TableCell>
              <TableCell><span className="inline-flex items-center gap-2"><StatusDot color={member.status} pulse={member.status === 'green'} />{member.label}</span></TableCell>
              <TableCell className="text-right tabular-nums">{member.workspaces}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </Demo>
      <Demo title="AccordionGroup">
        <AccordionGroup type="single" defaultValue="motion">
          <AccordionItem value="motion" index={0}><AccordionTrigger>Motion that communicates</AccordionTrigger><AccordionContent><p className="text-body text-muted-foreground">Animations preview state and remain interruptible.</p></AccordionContent></AccordionItem>
          <AccordionItem value="surfaces" index={1}><AccordionTrigger>Relative surfaces</AccordionTrigger><AccordionContent><p className="text-body text-muted-foreground">Eight nested elevation levels, each relative to its substrate.</p></AccordionContent></AccordionItem>
          <AccordionItem value="sizes" index={2}><AccordionTrigger>One size ladder</AccordionTrigger><AccordionContent><p className="text-body text-muted-foreground">Default 36px and compact 28px, shared by every control.</p></AccordionContent></AccordionItem>
        </AccordionGroup>
      </Demo>
    </div>
    <Demo title="ColorPicker">
      <div className="flex flex-wrap items-start gap-6">
        <ColorPicker value={color} onValueChange={(value) => setColor(value)} swatches={['#6B97FF', '#A78BFA', '#22C55E', '#F59E0B', '#EF4444']} />
        <span className="text-caption font-mono tabular-nums text-muted-foreground">{color}</span>
      </div>
    </Demo>
  </GallerySection>;
}

// ── 03 Cards ──

function CardsSection() {
  const [selected, setSelected] = useState(1);
  const [promoVisible, setPromoVisible] = useState(true);
  return <GallerySection id="cards" index="03" title="Cards" description="One compositional API — stacked, inline, or grid — with a magnetic proximity highlight that previews where a click will land.">
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Demo title="CardGroup — grid, outlined, separated (2-D proximity)">
        <CardGroup columns={2} border="outlined" separated>
          {FEATURES.map((feature) => <Card key={feature.title}>
            <CardImage src={BANNER} />
            <CardHeader><CardTitle>{feature.title}</CardTitle><CardDescription>{feature.description}</CardDescription></CardHeader>
            <CardFooter><CardButton variant="primary">Get started</CardButton><CardButton variant="secondary">Learn more</CardButton></CardFooter>
          </Card>)}
        </CardGroup>
      </Demo>
      <div className="flex flex-col gap-4">
        <Demo title="CardGroup — inline list with CardMedia">
          <CardGroup orientation="inline">
            {FEATURES.map((feature) => <Card key={feature.title}>
              <CardMedia icon={feature.icon} />
              <CardHeader><CardTitle>{feature.title}</CardTitle><CardDescription>{feature.description}</CardDescription></CardHeader>
              <CardFooter><CardButton>Connect</CardButton></CardFooter>
            </Card>)}
          </CardGroup>
        </Demo>
        <Demo title="CardGroup — outlined, selectable rows">
          <CardGroup orientation="inline" border="outlined">
            {FEATURES.map((feature, index) => <Card key={feature.title} label={feature.title} selected={selected === index} onClick={() => setSelected(index)}>
              <CardMedia icon={feature.icon} />
              <CardHeader><CardTitle>{feature.title}</CardTitle><CardDescription>{feature.description}</CardDescription></CardHeader>
            </Card>)}
          </CardGroup>
        </Demo>
      </div>
    </div>
    <Demo title="Card — standalone promo with CardEyebrow, CardFeature, dismiss">
      <div className="flex flex-wrap items-start gap-4">
        {promoVisible ? <PromoCard onDismiss={() => setPromoVisible(false)} /> : <Button variant="secondary" onClick={() => setPromoVisible(true)}>Show the card again</Button>}
      </div>
    </Demo>
  </GallerySection>;
}

function PromoCard({ onDismiss }: { onDismiss: () => void }) {
  const shape = useShape();
  return <div className="w-full max-w-[300px]">
    <Card dismissible onDismiss={onDismiss} className={`${shape.container} overflow-hidden border border-border`}>
      <CardImage src={BANNER} />
      <CardHeader><CardEyebrow>New in GitSpace</CardEyebrow><CardTitle>Meet the terminal dock</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <CardFeature icon={TerminalIcon} title="Attach anywhere" description="Open a shell inside any running workspace" />
        <CardFeature icon={CodeIcon} title="Streamed output" description="Scrollback stays in sync with the agent transcript" />
      </CardContent>
      <CardFooter><CardButton variant="primary">Try it</CardButton><CardButton variant="ghost">Learn more</CardButton></CardFooter>
    </Card>
  </div>;
}

// ── 04 Agent ──

function AgentSection() {
  const icons = useIcons();
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [queue, setQueue] = useState<QueuedMessage[]>(INITIAL_QUEUE);
  const [status, setStatus] = useState<'idle' | 'streaming'>('streaming');
  const [sent, setSent] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, AskUserAnswer> | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const messageActions = <>
    <Tooltip content="Copy"><Button variant="ghost" size="icon-compact" aria-label="Copy message"><Copy01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
    <Tooltip content="Regenerate"><Button variant="ghost" size="icon-compact" aria-label="Regenerate reply"><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
  </>;
  return <GallerySection id="agent" index="04" title="Agent" description="The conversational surface: transcript bubbles, the thinking indicator and step tree, structured questions, and the composer with its message queue.">
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Demo title="ChatMessage / ThinkingIndicator / ThinkingSteps">
        <div className="flex flex-col gap-2">
          <ChatMessage from="user" time="Today 6:08 PM" actions={messageActions}>Why is every other input box so stiff?</ChatMessage>
          <ChatMessage from="assistant" actions={messageActions}>Because nothing about them moves with you. Fluid controls preview state on approach and settle with a spring.</ChatMessage>
          <ThinkingIndicator />
          <ThinkingSteps open={thinkingOpen} onOpenChange={setThinkingOpen}>
            <ThinkingStepsHeader>Research agent</ThinkingStepsHeader>
            <ThinkingStepsContent>
              <ThinkingStep icon="search" label="Searching the repository">
                <ThinkingStepSources>
                  <ThinkingStepSource color="blue">GitSpaceShell.tsx</ThinkingStepSource>
                  <ThinkingStepSource color="violet" delay={0.05}>AppSidebar.tsx</ThinkingStepSource>
                  <ThinkingStepSource delay={0.1}>fluid-theme.css</ThinkingStepSource>
                </ThinkingStepSources>
              </ThinkingStep>
              <ThinkingStep icon="globe" label="Reading the registry">
                <ThinkingStepDetails summary="Explored 4 files" details={['Read sidebar.tsx', 'Read card.tsx', 'Read input-message.tsx', 'Read surface-context.tsx']} />
              </ThinkingStep>
              <ThinkingStep icon="brain" label="Planning the cutover" description="Mapping every product surface to a registry composition." status="active" />
              <ThinkingStep icon="check" label="Ready to write" status="pending" isLast />
            </ThinkingStepsContent>
          </ThinkingSteps>
        </div>
      </Demo>
      <Demo title="AskUserQuestions — single, multi + other, free text">
        <AskUserQuestions questions={QUESTIONS} defaultAnswers={{ role: { questionId: 'role', selectedIds: ['engineer'] } }} onComplete={setAnswers} />
        {answers ? <Row><Badge color="green">Completed</Badge><span className="text-caption text-muted-foreground">{Object.keys(answers).length} answers captured</span></Row> : null}
      </Demo>
    </div>
    <Demo title="InputMessage — controlled queue while the assistant streams">
      <div className="flex flex-col gap-4">
        <Row>
          <Switch label="Assistant streaming" checked={status === 'streaming'} onToggle={() => setStatus((current) => current === 'streaming' ? 'idle' : 'streaming')} />
          <span className="text-caption text-muted-foreground">Sending while streaming queues the message; flipping to idle dispatches the next one.</span>
        </Row>
        {sent.length ? <div className="flex flex-col gap-2">{sent.map((text, index) => <ChatMessage key={`${index}-${text}`} from="user">{text}</ChatMessage>)}</div> : null}
        <InputMessage data-slot="input-message"
          value={draft}
          onValueChange={setDraft}
          placeholder="Ask the workspace agent…"
          files={files}
          onFilesChange={setFiles}
          status={status}
          onStop={() => setStatus('idle')}
          queue={queue}
          onQueueChange={setQueue}
          onSend={(text) => { if (text) setSent((current) => [...current, text]); setDraft(''); setFiles([]); }}
          leftSlot={({ openFilePicker }) => <Tooltip content="Attach files"><Button variant="ghost" size="icon-compact" aria-label="Attach files" onClick={() => openFilePicker()}><Paperclip width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>}
          rightSlot={<Button variant="ghost" size="compact" trailingIcon={icons['chevron-down']}>Claude Sonnet</Button>}
        />
      </div>
    </Demo>
  </GallerySection>;
}

// ── 05 Surfaces ──

function SurfaceStack({ level }: { level: number }) {
  const shape = useShape();
  return <Elevated offset={1} className={`${shape.container} flex flex-col gap-3 p-3 sm:p-4`}>
    <span className="text-caption font-mono tabular-nums text-muted-foreground">surface-{level}</span>
    {level < 8 ? <SurfaceStack level={level + 1} /> : null}
  </Elevated>;
}

function SurfacesSection() {
  const shape = useShape();
  return <GallerySection id="surfaces" index="05" title="Surfaces" description="Eight relative elevation levels. Every elevated component lifts off whatever substrate it sits on instead of hard-coding a background.">
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Demo title="Ladder — bg-surface-N shadow-surface-N">
        <div className="grid grid-cols-4 gap-3">
          {SURFACE_TILES.map((tile, index) => <div key={tile} className={`${shape.container} ${tile} flex h-16 items-center justify-center`}>
            <span className="text-caption font-mono tabular-nums text-muted-foreground">{index + 1}</span>
          </div>)}
        </div>
      </Demo>
      <Demo title="Elevated — nested offsets walk up the ladder">
        <div className={`${shape.container} flex flex-col gap-3 bg-surface-1 p-3 shadow-surface-1 sm:p-4`}>
          <span className="text-caption font-mono tabular-nums text-muted-foreground">surface-1</span>
          <SurfaceStack level={2} />
        </div>
      </Demo>
    </div>
  </GallerySection>;
}

// ── 06 Sidebar ──

function SidebarFixture() {
  const icons = useIcons();
  const [view, setView] = useState<string>('Projects');
  const [thread, setThread] = useState<string>(THREADS[0].label);
  return <div className="relative flex h-[560px] w-full overflow-hidden bg-background">
    <SidebarProvider className="h-full min-h-0" persist={false} mobileBreakpoint={0}>
      <Sidebar variant="inset" className="h-full">
        <SidebarHeader>
          <SidebarWorkspaceHeader
            name="GitSpace"
            tile={<WorkspaceTile>G</WorkspaceTile>}
            checkedIndex={0}
            menu={<>
              <MenuItem index={0} icon={HardDriveIcon} label="This machine" checked onSelect={() => undefined} />
              <MenuItem index={1} icon={ServerIcon} label="build-box" onSelect={() => undefined} />
              <MenuItem index={2} icon={icons.plus} label="Add machine" onSelect={() => undefined} />
            </>}
          />
          <SidebarSearchField />
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup collapsible defaultOpen={false}>
            <SidebarGroupLabel>Navigate</SidebarGroupLabel>
            <SidebarMenu>
              {NAV.map((item) => <SidebarMenuItem key={item.label}>
                <SidebarMenuButton icon={item.icon} isActive={view === item.label} onClick={() => setView(item.label)}>{item.label}</SidebarMenuButton>
                {'badge' in item ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
              </SidebarMenuItem>)}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup collapsible>
            <SidebarGroupLabel>Threads</SidebarGroupLabel>
            <SidebarGroupActions>
              <Tooltip content="New thread" side="top"><SidebarGroupAction aria-label="New thread"><Plus width={16} height={16} strokeWidth={1.5} /></SidebarGroupAction></Tooltip>
              <Tooltip content="Filter threads" side="top"><SidebarGroupAction aria-label="Filter threads"><FilterLines width={16} height={16} strokeWidth={1.5} /></SidebarGroupAction></Tooltip>
            </SidebarGroupActions>
            <SidebarMenu>
              {THREADS.map((item) => <SidebarMenuItem key={item.label}>
                <SidebarMenuButton status={thread === item.label ? 'active' : item.status === 'active' ? 'idle' : item.status} onClick={() => setThread(item.label)}>{item.label}</SidebarMenuButton>
                {'badge' in item ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                <SidebarMenuActions showOnHover>
                  <Tooltip content="Branch thread" side="top"><SidebarMenuAction aria-label={`Branch ${item.label}`}><GitBranch01 width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip>
                  <DropdownMenu>
                    <DropdownTrigger render={<SidebarMenuAction aria-label={`More options for ${item.label}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
                    <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
                      <MenuItem index={0} icon={icons.pencil} label="Rename" onSelect={() => undefined} />
                      <MenuItem index={1} icon={ArchiveIcon} label="Archive" onSelect={() => undefined} />
                    </DropdownContent>
                  </DropdownMenu>
                </SidebarMenuActions>
              </SidebarMenuItem>)}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup collapsible>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupActions>
              <Tooltip content="New workspace" side="top"><SidebarGroupAction aria-label="New workspace"><Plus width={16} height={16} strokeWidth={1.5} /></SidebarGroupAction></Tooltip>
            </SidebarGroupActions>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton icon={icons.folder}>gitspace.sh</SidebarMenuButton>
                <SidebarMenuBadge>{WORKSPACES.length}</SidebarMenuBadge>
                <SidebarMenuSub>
                  {WORKSPACES.map((workspace) => <SidebarMenuSubItem key={workspace.name}>
                    <SidebarMenuSubButton href="#" isActive={workspace.active} onClick={(event) => event.preventDefault()}>{workspace.name}</SidebarMenuSubButton>
                    <SidebarMenuBadge>{workspace.phase}</SidebarMenuBadge>
                  </SidebarMenuSubItem>)}
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarUserFooter
            name="bradleat"
            avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] text-background">B</span>}
            menu={<>
              <MenuItem index={0} icon={icons.user} label="Profile" onSelect={() => undefined} />
              <MenuItem index={1} icon={icons.settings} label="Settings" onSelect={() => undefined} />
              <MenuItem index={2} icon={icons['arrow-left']} label="Log out" onSelect={() => undefined} />
            </>}
          />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-h-0 min-w-[220px]">
        <SidebarInsetTopbar>
          <span className="text-body text-muted-foreground">{thread}</span>
          <span className="ml-auto flex items-center gap-2 pr-1.5"><Badge variant="dot" color="green">Running</Badge></span>
        </SidebarInsetTopbar>
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <EmptyState icon={<Inbox01 width={20} height={20} strokeWidth={1.5} />} title="Nothing in this thread yet" description="Pick a workspace on the left, or start a new one to see the transcript here." action={<Button variant="primary" size="compact" leadingIcon={icons.plus}>New workspace</Button>} />
        </div>
      </SidebarInset>
    </SidebarProvider>
  </div>;
}

function SidebarSection() {
  const shape = useShape();
  return <GallerySection id="sidebar" index="06" title="Sidebar" description="The inset app shell: workspace header, search on the rows' rhythm, collapsible groups with label actions, status rows, hover-revealed actions, a nested sub-menu, and the identity footer.">
    <div className={`${shape.container} overflow-hidden border border-border`}><SidebarFixture /></div>
  </GallerySection>;
}

// ── Gallery ──

export function DesignSystemGallery() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState(0);

  // Scroll-spy for the jump nav: the last section whose top has passed the
  // sticky nav is selected; at the very bottom the final section wins even
  // when it is too short to reach the top.
  useEffect(() => {
    const root = canvasRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 1) { setSection(SECTIONS.length - 1); return; }
      const threshold = root.getBoundingClientRect().top + 120;
      let active = 0;
      SECTIONS.forEach((item, index) => {
        const element = root.querySelector(`#${item.id}`);
        if (element && element.getBoundingClientRect().top <= threshold) active = index;
      });
      setSection(active);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => { root.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, []);

  const jump = (index: number) => {
    setSection(index);
    canvasRef.current?.querySelector(`#${SECTIONS[index]?.id}`)?.scrollIntoView({ block: 'start' });
  };

  return <div ref={canvasRef} className="h-dvh overflow-auto bg-background text-foreground" data-testid="design-gallery">
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-10 sm:px-8">
      <PageHeader
        kicker="GitSpace interface"
        title="Fluid Functionalism"
        description="The registry components GitSpace ships, themed with the Base flavor, rounded shape, and default size — composed exactly as the registry documents them."
      />
      <Row>
        <Badge color="green">Exact registry source</Badge>
        {/* FLUID-GAP: inline text link — kept a plain <a> so the theme's base :focus-visible outline applies (the keyboard spec asserts an outline on the first tab stop). */}
        <a href="https://www.fluidfunctionalism.com" target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1 text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          fluidfunctionalism.com<ArrowUpRight width={14} height={14} strokeWidth={1.5} />
        </a>
      </Row>

      <div className="sticky top-0 z-30 -mx-2 mt-6 bg-background/90 px-2 py-2 backdrop-blur">
        <TabsSubtle aria-label="Gallery sections" selectedIndex={section} onSelect={jump}>
          {SECTIONS.map((item, index) => <TabsSubtleItem key={item.id} index={index} label={`${item.index} ${item.label}`} />)}
        </TabsSubtle>
      </div>

      <PrimitivesSection />
      <ChoicesSection />
      <CardsSection />
      <AgentSection />
      <SurfacesSection />
      <SidebarSection />

      <GallerySection id="markdown" index="07" title="Markdown" description="Streamdown inside the transcript: code, Mermaid, and KaTeX plugins load on demand; external links confirm before opening.">
        <Demo title="GitSpaceMarkdown">
          <GitSpaceMarkdown>{MARKDOWN}</GitSpaceMarkdown>
        </Demo>
      </GallerySection>
    </div>
  </div>;
}
