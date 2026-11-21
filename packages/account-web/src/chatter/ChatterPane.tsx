// The Chatter cut-out: the project's ambient chat, docked bottom-left of the main panel like a stream chat over a video
// (docs/CHATTER-DESIGN.md §7). Posts group by topic, the most recently active topic at the bottom by the composer; a
// topic header carries its count, participants and issue state, and its actions. The composer suggests a topic from the
// text's first words, autocompletes the active topics and names a similar active one before a new topic is posted.
// Scrolling up pauses auto-scroll; collapsing keeps an unread count.
import { DropdownContent, DropdownMenu, DropdownTrigger, MenuItem, Tooltip, badgeColors, type IconComponent } from '@gitspace/ui';
import {
  CHATTER_KINDS, normalizeChatterTopic, similarChatterTopic, suggestChatterTopic,
  type ChatterKind, type ChatterPost, type ChatterTopic, type ChatterTopicAction, type ChatterTopicLine,
} from '@gitspace/protocol/chatter-contract';
import { Activity, ArrowDown, ChevronDown, ChevronUp, CpuChip01, DotsHorizontal, Hash02, InfoCircle, Lightbulb02, PauseCircle, PlayCircle, Route, Send01, Tool02, Users01 } from '@untitledui/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { StatusDot } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import { chatterKindCounts, groupChatter, type ChatterGroup, type ChatterState } from './chatter-state.js';
import type { ChatterPostOutcome } from './useChatter.js';

type Glyph = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;
const KIND: Readonly<Record<ChatterKind, { icon: Glyph; menuIcon: IconComponent; color: string }>> = {
  status: { icon: Activity, menuIcon: glyph(Activity), color: 'var(--muted-foreground)' },
  discovery: { icon: Lightbulb02, menuIcon: glyph(Lightbulb02), color: badgeColors.cyan },
  tooling: { icon: Tool02, menuIcon: glyph(Tool02), color: badgeColors.rose },
  workaround: { icon: Route, menuIcon: glyph(Route), color: badgeColors.orange },
  resource: { icon: CpuChip01, menuIcon: glyph(CpuChip01), color: badgeColors.indigo },
  coordination: { icon: Users01, menuIcon: glyph(Users01), color: badgeColors.teal },
};
const STATE: Readonly<Record<'open' | 'resolved' | 'dismissed', { label: string; color: string }>> = {
  open: { label: 'open issue', color: badgeColors.rose },
  resolved: { label: 'resolved', color: badgeColors.green },
  dismissed: { label: 'dismissed', color: 'var(--muted-foreground)' },
};
/** Items a collapsed topic shows: its latest. */
const LATEST_ITEMS = 3;
/** Active topics the autocomplete lists at once. */
const SUGGESTIONS = 6;
const ICON = { width: 15, height: 15, strokeWidth: 1.75 };

export interface ChatterPaneProps {
  projectName: string;
  workspaceCount: number | null;
  state: ChatterState;
  active: readonly ChatterTopic[];
  error: string | null;
  collapsed: boolean;
  onCollapsed(collapsed: boolean): void;
  onPost(input: { topic: string; kind: ChatterKind; text: string }): Promise<ChatterPostOutcome>;
  onAct(key: string, action: ChatterTopicAction): Promise<string | null>;
  onLoadOlder(topic?: string): Promise<void>;
}

export function ChatterPane({ projectName, workspaceCount, state, active, error, collapsed, onCollapsed, onPost, onAct, onLoadOlder }: ChatterPaneProps) {
  const [filter, setFilter] = useState<ChatterKind | 'all'>('all');
  const [following, setFollowing] = useState(true);
  const [seen, setSeen] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Readonly<Record<string, true>>>({});
  const [reply, setReply] = useState<{ topic: string; serial: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupChatter(state, filter), [state, filter]);
  const counts = useMemo(() => chatterKindCounts(state.events), [state.events]);
  const posts = useMemo(() => state.events.filter((event): event is ChatterPost => event.type === 'post'), [state.events]);
  const newest = posts.at(-1)?.offset ?? 0;

  // What arrived before the pane first had posts counts as seen; after, posts arriving while it is collapsed or scrolled
  // up are unread until it follows again.
  const watching = !collapsed && following;
  useEffect(() => { if (watching || (seen === null && newest > 0)) setSeen(newest); }, [watching, newest, seen]);
  const unread = posts.filter(post => post.offset > (seen ?? newest));
  const unreadTooling = unread.some(post => post.kind === 'tooling');

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [groups, following, collapsed, expanded]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    if (atBottom !== following) setFollowing(atBottom);
  };
  const resume = (): void => {
    setFollowing(true);
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  };
  const latest = posts.at(-1);

  if (collapsed) {
    return <button type="button" onClick={() => { setFollowing(true); onCollapsed(false); }} aria-label={`Open Chatter${unread.length ? `, ${unread.length} unread` : ''}`}
      className="pointer-events-auto absolute bottom-5 left-4 z-30 flex h-11 w-[272px] max-w-[calc(100%-2rem)] items-center gap-2 rounded-2xl border border-border bg-background/90 px-3 text-left shadow-[0_12px_40px_-14px_rgba(0,0,0,0.35)] backdrop-blur-md hover:bg-background">
      <StatusDot color="green" />
      <span className="text-[13px] font-semibold">Chatter</span>
      {unread.length ? <span data-unread className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums text-white" style={{ background: unreadTooling ? badgeColors.rose : badgeColors.blue }}>{unread.length}</span> : null}
      {latest ? <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"><span className="font-medium text-foreground">{latest.author.name}</span>: {latest.text.replaceAll('`', '')}</span> : <span className="flex-1" />}
      <ChevronUp {...ICON} className="shrink-0 text-muted-foreground" />
    </button>;
  }

  return <section aria-label="Chatter" className="pointer-events-auto absolute bottom-4 left-4 z-30 flex h-[min(600px,calc(100%-2rem))] w-[392px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background/[0.94] shadow-[0_16px_48px_-16px_rgba(0,0,0,0.4)] backdrop-blur-md">
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5">
      <StatusDot color="green" />
      <span className="text-[13px] font-semibold">Chatter</span>
      <span className="truncate text-[11.5px] text-muted-foreground">{projectName}{workspaceCount === null ? '' : ` · ${workspaceCount} ${workspaceCount === 1 ? 'workspace' : 'workspaces'}`}</span>
      <span className="ml-auto flex items-center">
        <HeaderButton label={following ? 'Pause auto-scroll' : 'Resume auto-scroll'} pressed={!following} onClick={() => following ? setFollowing(false) : resume()}>{following ? <PauseCircle {...ICON} /> : <PlayCircle {...ICON} />}</HeaderButton>
        <HeaderButton label="Collapse" onClick={() => onCollapsed(true)}><ChevronDown {...ICON} /></HeaderButton>
      </span>
    </header>
    <div className="flex shrink-0 items-start gap-1.5 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] leading-[15px] text-muted-foreground">
      <InfoCircle width={12} height={12} strokeWidth={2} className="mt-px shrink-0" />
      <span>Ambient: everyone in {projectName} hears it, and the project agent acts on it. Not a direct message; it can’t assign work. Posts with the same topic are one thread.</span>
    </div>
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1 [scrollbar-width:none]">
      <Pill pressed={filter === 'all'} onClick={() => setFilter('all')}>All</Pill>
      {CHATTER_KINDS.map(kind => counts.get(kind) ? <Pill key={kind} pressed={filter === kind} onClick={() => setFilter(filter === kind ? 'all' : kind)}>
        <span style={{ color: KIND[kind].color }}>●</span>{kind}<span className="tabular-nums opacity-60">{counts.get(kind)}</span>
      </Pill> : null)}
    </div>
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-2 pb-2 pt-1">
        {state.older ? <button type="button" onClick={() => void onLoadOlder()} className="mx-auto my-1 block text-[11px] font-medium text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground">Load earlier posts</button> : null}
        {groups.length
          ? groups.map(group => <TopicGroup key={group.key} group={group} active={active} expanded={!!expanded[group.key]}
            onToggle={() => { setFollowing(false); setExpanded(current => { const next = { ...current }; if (next[group.key]) delete next[group.key]; else next[group.key] = true; return next; }); }}
            onReply={topic => setReply({ topic, serial: (reply?.serial ?? 0) + 1 })} onAct={onAct} onLoadOlder={onLoadOlder} />)
          : <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">{error ?? `No ${filter === 'all' ? '' : `${filter} `}posts yet. Name a topic and say what you found.`}</p>}
      </div>
      {!following ? <button type="button" onClick={resume}
        className="absolute bottom-2 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-foreground pl-2.5 pr-3 text-[11.5px] font-medium text-background shadow-lg">
        <ArrowDown width={13} height={13} strokeWidth={2} />
        {unread.length ? `Paused · ${unread.length} new` : 'Auto-scroll paused'}
      </button> : null}
    </div>
    {error && groups.length ? <p role="alert" className="shrink-0 border-t border-border px-3 py-1 text-[11px] text-destructive">{error}</p> : null}
    <Composer projectName={projectName} active={active} known={state.topics} reply={reply} onPost={onPost} onAct={onAct} />
  </section>;
}

function HeaderButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick(): void; children: ReactNode }) {
  return <Tooltip content={label} side="top">
    <button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-lg ${pressed ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}>{children}</button>
  </Tooltip>;
}

function Pill({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: ReactNode }) {
  return <button type="button" aria-pressed={pressed} onClick={onClick}
    className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 text-[11.5px] ${pressed ? 'bg-active font-medium text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}>{children}</button>;
}

/** Post text with `code` spans. */
function Rich({ text }: { text: string }): ReactNode {
  return text.split('`').map((part, index) => index % 2
    ? <code key={index} className="rounded-[4px] bg-muted px-1 py-px font-mono text-[0.92em]">{part}</code>
    : <span key={index}>{part}</span>);
}

function TopicGroup({ group, active, expanded, onToggle, onReply, onAct, onLoadOlder }: {
  group: ChatterGroup; active: readonly ChatterTopic[]; expanded: boolean;
  onToggle(): void; onReply(topic: string): void; onAct(key: string, action: ChatterTopicAction): Promise<string | null>; onLoadOlder(topic: string): Promise<void>;
}) {
  const [panel, setPanel] = useState<'fixed' | 'merge' | null>(null);
  const [fixedIn, setFixedIn] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const topic = group.topic;
  const display = topic?.display ?? group.key;
  const shown = expanded ? group.items : group.items.slice(-LATEST_ITEMS);
  const hidden = group.items.length - shown.length;
  const total = topic?.posts ?? group.posts;
  const act = async (action: ChatterTopicAction): Promise<void> => {
    const refused = await onAct(group.key, action);
    setFailure(refused);
    if (refused === null) setPanel(null);
  };
  const actions: { label: string; run(): void }[] = [{ label: 'Reply under this topic', run: () => onReply(display) }];
  if (topic?.state === null || topic === null) actions.push({ label: 'Open as an issue', run: () => void act({ kind: 'state', state: 'open', fixedIn: null }) });
  if (topic?.state === 'open') actions.push({ label: 'Resolve', run: () => void act({ kind: 'state', state: 'resolved', fixedIn: null }) }, { label: 'Resolve with the fixing commit…', run: () => setPanel('fixed') }, { label: 'Dismiss', run: () => void act({ kind: 'state', state: 'dismissed', fixedIn: null }) });
  if (topic?.state === 'resolved' || topic?.state === 'dismissed') actions.push({ label: 'Reopen', run: () => void act({ kind: 'state', state: 'open', fixedIn: null }) });
  const targets = active.filter(other => other.key !== group.key).slice(0, 8);
  if (targets.length) actions.push({ label: 'Merge into…', run: () => setPanel('merge') });
  const state = topic?.state ? STATE[topic.state] : null;
  const participants = topic?.participants ?? [];
  return <div data-topic={group.key} className="mt-1.5 rounded-xl px-1.5 pb-1 pt-1">
    <div className="flex min-w-0 items-center gap-1.5">
      <Hash02 width={12} height={12} strokeWidth={2} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-[12.5px] font-semibold" title={display}>{display}</span>
      {state ? <span data-state={topic?.state} className="shrink-0 rounded px-1 text-[9.5px] font-semibold uppercase tracking-[0.04em]" style={{ color: state.color, background: `color-mix(in oklab, ${state.color} 14%, transparent)` }}>{state.label}{topic?.state === 'resolved' && topic.fixedIn ? ` · ${topic.fixedIn.slice(0, 10)}` : ''}</span> : null}
      <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground" title={participants.map(person => person.name).join(', ')}>{total} {total === 1 ? 'post' : 'posts'}{participants.length > 1 ? ` · ${participants.length} people` : ''}</span>
      <DropdownMenu>
        <DropdownTrigger render={<button type="button" aria-label={`Topic actions: ${display}`} className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"><DotsHorizontal width={13} height={13} strokeWidth={2} /></button>} />
        <DropdownContent className="w-[220px]" align="end" side="bottom" sideOffset={4}>
          {actions.map((action, index) => <MenuItem key={action.label} index={index} label={action.label} onSelect={action.run} />)}
        </DropdownContent>
      </DropdownMenu>
    </div>
    {hidden > 0 || expanded ? <button type="button" onClick={onToggle} className="ml-[18px] mt-0.5 text-[10.5px] font-medium text-muted-foreground hover:text-foreground">{expanded ? 'Show the latest only' : `Show ${hidden} earlier`}</button> : null}
    {expanded && total > group.posts ? <button type="button" onClick={() => void onLoadOlder(group.key)} className="ml-[18px] mt-0.5 block text-[10.5px] font-medium text-muted-foreground hover:text-foreground">Load {total - group.posts} more from before</button> : null}
    <div className="mt-0.5 flex flex-col">
      {shown.map(item => item.type === 'post' ? <PostLine key={item.offset} post={item} /> : <TopicLine key={item.offset} line={item} />)}
    </div>
    {panel === 'fixed' ? <form className="ml-[18px] mt-1 flex items-center gap-1" onSubmit={event => { event.preventDefault(); void act({ kind: 'state', state: 'resolved', fixedIn: fixedIn.trim() || null }); }}>
      <input autoFocus value={fixedIn} onChange={event => setFixedIn(event.currentTarget.value)} placeholder="Fixed in (commit)" aria-label="Fixed in commit" className="h-7 min-w-0 flex-1 rounded-md bg-muted/60 px-2 font-mono text-[11.5px] outline-none focus:bg-muted" />
      <button type="submit" className="h-7 rounded-md px-2 text-[11.5px] font-medium hover:bg-hover">Resolve</button>
      <button type="button" onClick={() => setPanel(null)} className="h-7 rounded-md px-2 text-[11.5px] text-muted-foreground hover:bg-hover">Cancel</button>
    </form> : null}
    {panel === 'merge' ? <div className="ml-[18px] mt-1 flex flex-col gap-0.5 rounded-lg border border-border p-1">
      <span className="px-1 text-[10.5px] text-muted-foreground">Merge <span className="font-medium text-foreground">{display}</span> into:</span>
      {targets.map(target => <button key={target.key} type="button" onClick={() => void act({ kind: 'merge', into: target.key })} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11.5px] hover:bg-hover">
        <Hash02 width={11} height={11} strokeWidth={2} className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{target.display}</span><span className="shrink-0 tabular-nums text-muted-foreground">{target.posts}</span>
      </button>)}
      <button type="button" onClick={() => setPanel(null)} className="self-start rounded-md px-1.5 text-[10.5px] text-muted-foreground hover:bg-hover">Cancel</button>
    </div> : null}
    {failure ? <p role="alert" className="ml-[18px] mt-0.5 text-[11px] text-destructive">{failure}</p> : null}
  </div>;
}

function PostLine({ post }: { post: ChatterPost }) {
  const Icon = KIND[post.kind].icon;
  return <div data-post={post.id} className="rounded-lg py-[3px] pl-[18px] pr-1 hover:bg-[color-mix(in_oklab,var(--foreground)_3%,transparent)]">
    <div className="flex items-center gap-1.5">
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-[9px] font-semibold text-background">{post.author.name.slice(0, 1).toUpperCase()}</span>
      <span className="min-w-0 truncate text-[12px] font-semibold">{post.author.name}</span>
      {normalizeChatterTopic(post.topic) !== post.topicKey ? <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">as {post.topic}</span> : null}
      <time className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground">{post.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    <p className="text-[12.5px] leading-[18px] text-foreground [overflow-wrap:anywhere]">
      <span className="mr-1 inline-flex translate-y-[-1px] items-center gap-0.5 align-middle text-[10.5px] font-medium" style={{ color: KIND[post.kind].color }}><Icon width={11} height={11} strokeWidth={2} />{post.kind}</span>
      <Rich text={post.text} />
    </p>
  </div>;
}

function TopicLine({ line }: { line: ChatterTopicLine }) {
  const change = line.change;
  const what = change.kind === 'merge'
    ? <>merged <span className="font-medium text-foreground">{change.fromDisplay}</span> into this topic</>
    : change.state === 'open' ? (change.from === null ? 'opened it as an issue' : `reopened it (was ${change.from})`)
      : change.state === 'resolved' ? <>resolved it{change.fixedIn ? <> · fixed in <code className="font-mono">{change.fixedIn}</code></> : null}</>
        : 'dismissed it';
  return <div className="flex items-center gap-1.5 py-0.5 pl-[18px] pr-1 text-[11px] text-muted-foreground">
    <span className="min-w-0 flex-1"><span className="font-medium text-foreground">{line.author.name}</span> {what}</span>
    <time className="shrink-0 tabular-nums">{line.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
  </div>;
}

function Composer({ projectName, active, known, reply, onPost, onAct }: {
  projectName: string; active: readonly ChatterTopic[]; known: ReadonlyMap<string, ChatterTopic>; reply: { topic: string; serial: number } | null;
  onPost(input: { topic: string; kind: ChatterKind; text: string }): Promise<ChatterPostOutcome>; onAct(key: string, action: ChatterTopicAction): Promise<string | null>;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ChatterKind>('status');
  const [written, setWritten] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; merge?: { from: string; into: ChatterTopic } } | null>(null);
  const textInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!reply) return;
    setWritten(reply.topic);
    textInput.current?.focus();
  }, [reply]);
  const topic = written ?? suggestChatterTopic(text);
  const key = normalizeChatterTopic(topic);
  const exists = key !== '' && (known.has(key) || active.some(entry => entry.key === key));
  const similar = key === '' || exists ? null : similarChatterTopic(key, active);
  const suggestions = focused ? active.filter(entry => key === '' || entry.key.includes(key) || key.includes(entry.key)).filter(entry => entry.key !== key).slice(0, SUGGESTIONS) : [];
  const KindIcon = KIND[kind].icon;
  const pick = (entry: ChatterTopic): void => {
    setWritten(entry.display);
    setFocused(false);
    textInput.current?.focus();
  };
  const send = async (): Promise<void> => {
    if (!text.trim() || key === '' || sending) return;
    setSending(true);
    const outcome = await onPost({ topic, kind, text: text.trim() });
    setSending(false);
    if (outcome.status === 'error') {
      setNotice({ message: outcome.message });
      return;
    }
    setText('');
    setWritten(null);
    setNotice(outcome.similar ? { message: `Posted under a new topic. Similar active topic: ${outcome.similar.display} (${outcome.similar.posts} ${outcome.similar.posts === 1 ? 'post' : 'posts'}).`, merge: { from: outcome.topic.key, into: outcome.similar } } : null);
  };
  return <form onSubmit={event => { event.preventDefault(); void send(); }} className="relative shrink-0 border-t border-border p-1.5">
    {suggestions.length ? <ul role="listbox" aria-label="Active topics" className="absolute inset-x-1.5 bottom-full mb-1 overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg">
      {suggestions.map((entry, index) => <li key={entry.key} role="option" aria-selected={index === highlight}>
        <button type="button" onMouseDown={event => { event.preventDefault(); pick(entry); }} className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] ${index === highlight ? 'bg-active' : 'hover:bg-hover'}`}>
          <Hash02 width={11} height={11} strokeWidth={2} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{entry.display}</span>
          {entry.state === 'open' ? <span className="shrink-0 text-[10px] font-semibold uppercase" style={{ color: badgeColors.rose }}>issue</span> : null}
          <span className="shrink-0 tabular-nums text-[10.5px] text-muted-foreground">{entry.posts} {entry.posts === 1 ? 'post' : 'posts'}</span>
        </button>
      </li>)}
    </ul> : null}
    <div className="flex items-center gap-1">
      <Hash02 width={13} height={13} strokeWidth={2} className="ml-1.5 shrink-0 text-muted-foreground" />
      <input value={topic} aria-label="Topic" placeholder="Topic: one specific thing" maxLength={80}
        onChange={event => { setWritten(event.currentTarget.value); setHighlight(0); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onKeyDown={event => {
          if (!suggestions.length) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((highlight + 1) % suggestions.length); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((highlight - 1 + suggestions.length) % suggestions.length); }
          else if (event.key === 'Enter' || event.key === 'Tab') { const entry = suggestions[highlight]; if (entry) { event.preventDefault(); pick(entry); } }
          else if (event.key === 'Escape') setFocused(false);
        }}
        className={`h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[12px] font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground ${written === null ? 'text-muted-foreground' : 'text-foreground'}`} />
      {written === null && topic ? <span className="shrink-0 pr-1 text-[10px] text-muted-foreground">suggested</span> : null}
    </div>
    {similar ? <p className="mx-1 mb-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground" style={{ background: `color-mix(in oklab, ${badgeColors.amber} 10%, transparent)` }}>
      <span className="min-w-0 flex-1">Similar active topic: <span className="font-medium text-foreground">{similar.display}</span> ({similar.posts} {similar.posts === 1 ? 'post' : 'posts'})</span>
      <button type="button" onClick={() => setWritten(similar.display)} className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">Post there</button>
    </p> : null}
    {notice ? <p role="status" className="mx-1 mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1">{notice.message}</span>
      {notice.merge ? <button type="button" onClick={() => { const merge = notice.merge; if (merge) void onAct(merge.from, { kind: 'merge', into: merge.into.key }).then(refused => setNotice(refused ? { message: refused } : null)); }}
        className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2">Merge into it</button> : null}
    </p> : null}
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownTrigger render={<button type="button" aria-label={`Kind: ${kind}`} className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[11.5px] font-medium hover:bg-hover" style={{ color: KIND[kind].color }}>
          <KindIcon width={13} height={13} strokeWidth={2} />{kind}<ChevronDown width={12} height={12} strokeWidth={2} className="text-muted-foreground" />
        </button>} />
        <DropdownContent className="w-[180px]" align="start" side="top" sideOffset={6}>
          {CHATTER_KINDS.map((option, index) => <MenuItem key={option} index={index} icon={KIND[option].menuIcon} label={option} onSelect={() => setKind(option)} />)}
        </DropdownContent>
      </DropdownMenu>
      <input ref={textInput} value={text} onChange={event => setText(event.currentTarget.value)} placeholder={`Post to everyone in ${projectName}…`} aria-label="Post" maxLength={2000}
        className="h-8 min-w-0 flex-1 rounded-lg bg-muted/60 px-2.5 text-[12.5px] outline-none placeholder:text-muted-foreground focus:bg-muted" />
      <button type="submit" aria-label="Post to Chatter" disabled={!text.trim() || key === '' || sending} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-40"><Send01 width={15} height={15} strokeWidth={1.75} /></button>
    </div>
  </form>;
}
