// The Chatter button and pane: the project's ambient chat, a button in the workspace header next to Ask a ghost with
// an unread badge, whose pane drops down under it (docs/CHATTER-DESIGN.md §7). Posts group by topic, the most recently
// active topic at the bottom by the composer; a topic header carries its count, participants and issue state, and its
// actions. The composer suggests a topic from the text's first words, autocompletes the active topics and names a
// similar active one before a new topic is posted. Scrolling up pauses auto-scroll.
import { DropdownContent, DropdownLabel, DropdownMenu, DropdownTrigger, MenuItem, Tooltip, badgeColors, type IconComponent } from '@gitspace/ui';
import {
  CHATTER_KINDS, CHATTER_MAX_PICKS, CHATTER_PROJECT_STRIP, normalizeChatterTopic, similarChatterTopic, suggestChatterTopic,
  type ChatterDigest, type ChatterHeard, type ChatterHearings, type ChatterKind, type ChatterLeft, type ChatterPost, type ChatterProjectMuteLine, type ChatterReturnedLine, type ChatterTopic,
  type ChatterTopicAction, type ChatterTopicLine, type ChatterVolumeLine,
} from '@gitspace/protocol/chatter-contract';
import { Activity, ArrowDown, ChevronDown, ChevronUp, CpuChip01, DotsHorizontal, Hash02, Headphones01, InfoCircle, Lightbulb02, MessageChatCircle, PauseCircle, PlayCircle, Route, Send01, Tool02, Users01 } from '@untitledui/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { StatusDot } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import { chatterKindCounts, groupChatter, type ChatterGroup, type ChatterState } from './chatter-state.js';
import { LEVEL_LABEL } from './ChatterVolume.js';
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
/** The pane's size and placement: at most this wide and tall, this far under the button and inside the panel's edges
 * and the composer, and as wide as the panel (less the margins) when the panel is narrower than `NARROW_PANEL`. */
const PANE_WIDTH = 392;
const PANE_HEIGHT = 600;
const PANE_GAP = 6;
const PANE_MARGIN = 12;
const NARROW_PANEL = 640;

export interface ChatterPaneProps {
  projectName: string;
  workspaceCount: number | null;
  /** The open workspace. Posts it is the author of (its agent, the project agent in the base workspace, GitSpace for its
   * failures) don't count as unread. */
  workspaceId: string;
  /** The project's workspaces whose main agents Hear as can pick, after the project agent. */
  workspaces: readonly { id: string; name: string }[];
  state: ChatterState;
  active: readonly ChatterTopic[];
  error: string | null;
  onPost(input: { topic: string; kind: ChatterKind; text: string }): Promise<ChatterPostOutcome>;
  onAct(key: string, action: ChatterTopicAction): Promise<string | null>;
  onLoadOlder(topic?: string): Promise<void>;
  /** One listener's digest for Hear as; a string says why it could not be read. */
  onHearAs(listener: string): Promise<ChatterDigest | string>;
  /** Who hears one post; a string says why it could not be read. */
  onHearings(offset: number): Promise<ChatterHearings | string>;
}

/** What a digest Hear as shows did with each post: heard (with why) or left out (with why not), by offset. */
type HearingView = { heard: ReadonlyMap<number, ChatterHeard>; left: ReadonlyMap<number, ChatterLeft> };
/** Who hears one post, while it is read and once it is. */
type WhoView = { offset: number; hearings: ChatterHearings | null; error: string | null };

export function ChatterPane({ projectName, workspaceCount, workspaceId, workspaces, state, active, error, onPost, onAct, onLoadOlder, onHearAs, onHearings }: ChatterPaneProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [filter, setFilter] = useState<ChatterKind | 'all'>('all');
  const [following, setFollowing] = useState(true);
  const [seen, setSeen] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Readonly<Record<string, true>>>({});
  const [reply, setReply] = useState<{ topic: string; serial: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Set by a pointerdown on the button or inside the pane (portaled menus included), read by the document's
   * outside-click listener. */
  const inside = useRef(false);
  const refocus = useRef(false);
  const groups = useMemo(() => groupChatter(state, filter), [state, filter]);
  const [hearing, setHearing] = useState<{ listener: string; name: string; digest: ChatterDigest | null; error: string | null } | null>(null);
  const [who, setWho] = useState<WhoView | null>(null);
  const heardBy = useMemo((): HearingView | null => hearing?.digest ? { heard: new Map(hearing.digest.heard.map(entry => [entry.offset, entry])), left: new Map(hearing.digest.left.map(entry => [entry.offset, entry])) } : null, [hearing]);
  const listeners = [{ id: CHATTER_PROJECT_STRIP, name: 'the project agent' }, ...workspaces];
  const hearAs = (listener: string, name: string): void => {
    setHearing({ listener, name, digest: null, error: null });
    void onHearAs(listener).then(digest => setHearing(current => current?.listener !== listener ? current
      : typeof digest === 'string' ? { ...current, error: digest } : { ...current, name: digest.name, digest }));
  };
  const showWho = (offset: number): void => {
    setFollowing(false);
    if (who?.offset === offset) { setWho(null); return; }
    setWho({ offset, hearings: null, error: null });
    void onHearings(offset).then(result => setWho(current => current?.offset !== offset ? current
      : typeof result === 'string' ? { ...current, error: result } : { ...current, hearings: result }));
  };
  const counts = useMemo(() => chatterKindCounts(state.events), [state.events]);
  const posts = useMemo(() => state.events.filter((event): event is ChatterPost => event.type === 'post'), [state.events]);
  const newest = posts.at(-1)?.offset ?? 0;

  // What arrived before the pane first had posts counts as seen; after, posts from other authors arriving while it is
  // closed or scrolled up are unread until it follows again.
  const watching = open && following;
  useEffect(() => { if (watching || (seen === null && newest > 0)) setSeen(newest); }, [watching, newest, seen]);
  const unread = posts.filter(post => post.offset > (seen ?? newest) && (post.author.kind === 'person' || post.author.id !== workspaceId));
  const unreadTooling = unread.some(post => post.kind === 'tooling');

  // The pane hangs under the button, right-aligned to it, inside the workspace panel and above its composer.
  useLayoutEffect(() => {
    const button = trigger.current;
    const panel = button?.closest('[data-workspace-panel]');
    if (!open || !button || !panel) return;
    const composer = panel.querySelector('[data-composer-overlay]');
    const place = (): void => {
      const at = button.getBoundingClientRect();
      const frame = panel.getBoundingClientRect();
      const top = at.bottom + PANE_GAP;
      const floor = Math.min(frame.bottom, composer?.getBoundingClientRect().top ?? frame.bottom) - PANE_MARGIN;
      const height = Math.max(0, Math.min(PANE_HEIGHT, frame.height * 0.6, floor - top));
      const width = frame.width < NARROW_PANEL ? frame.width - 2 * PANE_MARGIN : Math.min(PANE_WIDTH, at.right - frame.left - PANE_MARGIN);
      setPlacement({ top, height, width, left: frame.width < NARROW_PANEL ? frame.left + PANE_MARGIN : at.right - width });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    if (composer) observer.observe(composer);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      if (refocus.current) trigger.current?.focus();
      refocus.current = false;
      return;
    }
    // A pointerdown on the button that opened it ran before this listener existed.
    inside.current = false;
    const pointer = (): void => {
      if (inside.current) inside.current = false;
      else setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      refocus.current = true;
      setOpen(false);
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [groups, following, placement, expanded]);

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
  const collapse = (): void => {
    refocus.current = true;
    setOpen(false);
  };

  const label = `Chatter${unread.length ? `, ${unread.length} unread` : ''}`;
  return <>
    <Tooltip content={`Chatter · what everyone in ${projectName} is saying`} side="bottom">
      <button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-haspopup="dialog"
        onPointerDownCapture={() => { inside.current = true; }}
        onClick={() => { if (open) collapse(); else { setFollowing(true); setOpen(true); } }}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-colors max-sm:px-2 ${open ? 'bg-active' : 'bg-background hover:bg-hover'}`}>
        <MessageChatCircle width={14} height={14} strokeWidth={1.75} />
        <span className="max-sm:sr-only">Chatter</span>
        {unread.length ? <span data-unread={unreadTooling ? 'tooling' : 'other'} aria-hidden className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white" style={{ background: unreadTooling ? badgeColors.rose : badgeColors.blue }}>{unread.length}</span> : null}
      </button>
    </Tooltip>
    {open && placement ? createPortal(<section aria-label="Chatter" role="dialog" onPointerDownCapture={() => { inside.current = true; }} style={placement}
      className="fixed z-40 flex origin-top-right flex-col overflow-hidden rounded-2xl border border-border bg-background/[0.96] shadow-[0_16px_48px_-16px_rgba(0,0,0,0.4)] backdrop-blur-md transition-[opacity,scale] duration-150 ease-out starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-none">
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5">
      <StatusDot color="green" />
      <span className="text-[13px] font-semibold">Chatter</span>
      <span className="truncate text-[11.5px] text-muted-foreground">{projectName}{workspaceCount === null ? '' : ` · ${workspaceCount} ${workspaceCount === 1 ? 'workspace' : 'workspaces'}`}</span>
      <span className="ml-auto flex items-center">
        <DropdownMenu>
          <DropdownTrigger render={<button type="button" aria-label={hearing ? `Hearing as ${hearing.name}` : 'Hear as an agent'} aria-pressed={hearing !== null}
            className={`flex size-7 items-center justify-center rounded-lg ${hearing ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}><Headphones01 {...ICON} /></button>} />
          <DropdownContent className="w-[230px]" align="end" side="bottom" sideOffset={4}>
            <DropdownLabel>Hear as</DropdownLabel>
            {listeners.map((listener, index) => <MenuItem key={listener.id} index={index} label={listener.name} checked={hearing?.listener === listener.id} onSelect={() => hearAs(listener.id, listener.name)} />)}
            {hearing ? <MenuItem index={listeners.length} label="Stop hearing as" onSelect={() => setHearing(null)} /> : null}
          </DropdownContent>
        </DropdownMenu>
        <HeaderButton label={following ? 'Pause auto-scroll' : 'Resume auto-scroll'} pressed={!following} onClick={() => following ? setFollowing(false) : resume()}>{following ? <PauseCircle {...ICON} /> : <PlayCircle {...ICON} />}</HeaderButton>
        <HeaderButton label="Collapse" onClick={collapse}><ChevronUp {...ICON} /></HeaderButton>
      </span>
    </header>
    {hearing ? <div data-hearing={hearing.listener} className="flex shrink-0 items-start gap-1.5 border-b border-border px-3 py-1.5 text-[11px] leading-[15px] text-muted-foreground" style={{ background: `color-mix(in oklab, ${badgeColors.violet} 9%, transparent)` }}>
      <Headphones01 width={12} height={12} strokeWidth={2} className="mt-px shrink-0" style={{ color: badgeColors.violet }} />
      <span className="min-w-0 flex-1">{hearingSummary(hearing, state)}</span>
      <button type="button" onClick={() => setHearing(null)} className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">Stop</button>
    </div> : <div className="flex shrink-0 items-start gap-1.5 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] leading-[15px] text-muted-foreground">
      <InfoCircle width={12} height={12} strokeWidth={2} className="mt-px shrink-0" />
      <span>Ambient: everyone in {projectName} hears it, and the project agent acts on it. Not a direct message; it can’t assign work. Posts with the same topic are one thread. Click a post to see who hears it.</span>
    </div>}
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
          ? groups.map(group => 'type' in group ? group.type === 'returned' ? <ReturnedLine key={group.id} line={group} /> : <VolumeLine key={group.id} line={group} /> : <TopicGroup key={group.key} group={group} active={active} expanded={!!expanded[group.key]}
            onToggle={() => { setFollowing(false); setExpanded(current => { const next = { ...current }; if (next[group.key]) delete next[group.key]; else next[group.key] = true; return next; }); }}
            onReply={topic => setReply({ topic, serial: (reply?.serial ?? 0) + 1 })} onAct={onAct} onLoadOlder={onLoadOlder}
            hearing={heardBy} who={who} onWho={showWho} onHearAs={hearAs} />)
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
  </section>, document.body) : null}
  </>;
}

function HeaderButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick(): void; children: ReactNode }) {
  return <Tooltip content={label} side="bottom">
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

function TopicGroup({ group, active, expanded, onToggle, onReply, onAct, onLoadOlder, hearing, who, onWho, onHearAs }: {
  group: ChatterGroup; active: readonly ChatterTopic[]; expanded: boolean;
  onToggle(): void; onReply(topic: string): void; onAct(key: string, action: ChatterTopicAction): Promise<string | null>; onLoadOlder(topic: string): Promise<void>;
  hearing: HearingView | null; who: WhoView | null; onWho(offset: number): void; onHearAs(listener: string, name: string): void;
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
      {shown.map(item => item.type === 'post'
        ? <PostLine key={item.offset} post={item} hearing={hearing} onWho={() => onWho(item.offset)} who={who?.offset === item.offset ? <WhoHears post={item} who={who} onHearAs={onHearAs} /> : null} />
        : <TopicLine key={item.offset} line={item} />)}
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

/** A post; clicking it shows who hears it. While hearing as an agent, a post its digest left out is dim (why not on
 * hover) and one it heard says why. */
function PostLine({ post, hearing, who, onWho }: { post: ChatterPost; hearing: HearingView | null; who: ReactNode; onWho(): void }) {
  const Icon = KIND[post.kind].icon;
  const heard = hearing?.heard.get(post.offset);
  const left = hearing?.left.get(post.offset);
  return <div data-post={post.id} data-heard={hearing ? heard?.via ?? 'no' : undefined} title={left?.why}
    className={`rounded-lg py-[3px] pl-[18px] pr-1 hover:bg-[color-mix(in_oklab,var(--foreground)_3%,transparent)] ${hearing && !heard ? 'opacity-40' : ''}`}>
    <div role="button" tabIndex={0} aria-expanded={who !== null} aria-label={`Who hears ${post.author.name}'s post`} onClick={onWho}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onWho(); } }} className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-foreground/20">
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
      {heard ? <p data-reason={heard.via} className="mt-0.5 flex items-center gap-1 text-[10.5px]" style={{ color: badgeColors.violet }}>
        <Headphones01 width={10} height={10} strokeWidth={2} className="shrink-0" />
        {heard.via === 'floor' ? `always heard · ${heard.reason}` : heard.via === 'newest' ? 'among the newest topics (no model picked)' : `picked by the model${heard.strong ? ' (strong)' : ''} · ${heard.reason}`}
      </p> : null}
    </div>
    {who}
  </div>;
}

/** Who hears a post: its author's level, the digests it is in with why, and the ones that left it out with why not.
 * Clicking an agent hears as it. */
function WhoHears({ post, who, onHearAs }: { post: ChatterPost; who: WhoView; onHearAs(listener: string, name: string): void }) {
  if (who.error !== null) return <p role="alert" className="mt-1 text-[11px] text-destructive">{who.error}</p>;
  if (who.hearings === null) return <p className="mt-1 text-[11px] text-muted-foreground">Reading who hears it…</p>;
  const { level, heard, missed } = who.hearings;
  const speaker = post.author.kind === 'project' ? 'The project agent' : post.author.kind === 'gitspace' ? `GitSpace for ${post.author.name}` : post.author.name;
  return <div data-who-hears={post.offset} className="mt-1 flex flex-col gap-0.5 rounded-lg border border-border p-1.5 text-[11px] text-muted-foreground">
    <p>{level === null ? `${post.author.name} is a person: no strip, heard as Normal.` : `${speaker} speaks at ${LEVEL_LABEL[level]}.`}</p>
    {heard.length + missed.length === 0 ? <p>No digest has been built over this post yet. Digests are built about 30 s after posts settle, for agents that ran in the last two hours.</p> : null}
    {heard.length ? <p className="mt-0.5 font-medium text-foreground">In {heard.length} {heard.length === 1 ? 'digest' : 'digests'}, quoted as written</p> : null}
    {heard.map(entry => <button key={entry.listener} type="button" onClick={() => onHearAs(entry.listener, entry.name)} className="flex min-w-0 gap-1 rounded px-1 text-left hover:bg-hover">
      <span className="shrink-0 font-medium text-foreground">{entry.name}</span>
      <span className="min-w-0">{entry.via === 'floor' ? entry.reason : entry.via === 'newest' ? 'among the newest topics (no model picked)' : `the model's pick: ${entry.reason}`}{entry.strong ? ' (strong)' : ''}</span>
    </button>)}
    {missed.length ? <p className="mt-0.5 font-medium text-foreground">Not in {missed.length}</p> : null}
    {missed.map(entry => <button key={entry.listener} type="button" onClick={() => onHearAs(entry.listener, entry.name)} className="flex min-w-0 gap-1 rounded px-1 text-left hover:bg-hover">
      <span className="shrink-0 font-medium text-foreground">{entry.name}</span>
      <span className="min-w-0">{entry.why}</span>
    </button>)}
  </div>;
}

/** The banner while hearing as an agent: what its digest holds, or why there is none. */
function hearingSummary(hearing: { name: string; digest: ChatterDigest | null; error: string | null }, state: ChatterState): string {
  if (hearing.error !== null) return `Hear as ${hearing.name}: ${hearing.error}`;
  const digest = hearing.digest;
  if (digest === null) return `Hearing as ${hearing.name}…`;
  if (digest.muted) return `Hearing as ${hearing.name}: Chatter is muted for the project, so no agent gets a digest.`;
  const topics = new Map(state.events.map(event => [event.offset, event.topicKey]));
  const floor = digest.heard.filter(entry => entry.via === 'floor').length;
  const chosenTopics = { pick: new Set<string>(), newest: new Set<string>() };
  for (const entry of digest.heard) if (entry.via !== 'floor') chosenTopics[entry.via].add(topics.get(entry.offset) ?? String(entry.offset));
  const picked = chosenTopics.pick.size;
  const newest = chosenTopics.newest.size;
  const built = digest.builtAt ? ` Built ${digest.builtAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${digest.model ? ` by ${digest.model}` : ''}.` : ' Not built yet: the floor and the newest topics.';
  const chosen = newest ? `${newest} of the newest ${newest === 1 ? 'topic' : 'topics'} (no model picked)` : `${picked} ${picked === 1 ? 'topic' : 'topics'} picked by the model (up to ${CHATTER_MAX_PICKS})`;
  return `Hearing as ${hearing.name}: ${floor} always heard, ${chosen}, ${digest.left.length} other ${digest.left.length === 1 ? 'post' : 'posts'} left to chatter_read. Dim posts didn't reach it.${built}`;
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

/** An agent's post the hand-off check returned; it belongs to no topic. */
function ReturnedLine({ line }: { line: ChatterReturnedLine }) {
  return <div data-returned={line.id} className="mt-1.5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1">Returned to <span className="font-medium text-foreground">{line.author.name}</span>: it asked {line.to} to do work. Chatter is ambient and can’t assign work.</span>
      <time className="shrink-0 tabular-nums">{line.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    <p className="line-clamp-2 [overflow-wrap:anywhere]" title={line.text}>{line.topic}: {line.text.replaceAll('`', '')}</p>
  </div>;
}

/** A person's volume change, or the project mute; it belongs to no topic. */
function VolumeLine({ line }: { line: ChatterVolumeLine | ChatterProjectMuteLine }) {
  const name = line.type === 'volume' ? <span className="font-medium text-foreground">{line.name}</span> : null;
  const what = line.type === 'project-mute' ? line.on ? 'muted Chatter for the project: no agent gets a digest' : 'unmuted Chatter for the project'
    : line.muted && !line.wasMuted ? <>muted {name}</>
      : !line.muted && line.wasMuted && line.level === line.from ? <>unmuted {name}</>
        : <>set {name} to {LEVEL_LABEL[line.level]} (was {line.wasMuted ? 'muted' : LEVEL_LABEL[line.from]})</>;
  return <div data-volume-line={line.id} className="mt-1.5 flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
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
          else if (event.key === 'Escape') { event.preventDefault(); setFocused(false); }
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
