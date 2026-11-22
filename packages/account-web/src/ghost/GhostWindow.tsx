// The browser's ghosts: read-only, temporary chats with one session each. Floating, the open ghost is a small glass
// window at the bottom right of the app and the others are pills whose ring empties as their time runs out; docked, they
// are a column on the right of the workspace with a tab per ghost, and with none chosen a start page for the session on
// screen. The header says what a ghost reads, that it only reads, and how long it has; under a minute it warns and
// fades, and when it ends it leaves a tombstone that says nothing was kept.
import { Button, Tooltip } from '@gitspace/ui';
import { GHOST_LIFETIME_MS, GHOST_WARN_MS, type GhostCite, type GhostRead } from '@gitspace/protocol-runtime';
import { ArrowUp, BookOpen01, Check, ClockRewind, Copy01, File02, Hourglass03, LayoutRight, Lock01, MessageChatCircle, Minus, Plus, SearchSm, XClose } from '@untitledui/icons';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { openChatter } from '../chatter/chatter-open.js';
import { AMBER, CiteChip, GHOST, GhostGlyph, IdleRing, Inline, readLabel } from './ghost-parts.js';
import {
  askGhost, citeGhost, clearGhostAbout, closeGhost, composeGhostDraft, dismissGhost, focusGhost, ghostBusy, keepGhost, resummonGhost, setGhostInput, setGhostPlacement,
  summonGhost, useGhosts, type Ghost, type GhostAnswer, type GhostSubject,
} from './ghost-store.js';

const ICON = { width: 14, height: 14, strokeWidth: 1.75 };
const READ_ICON: Record<GhostRead['kind'], typeof SearchSm> = { search: SearchSm, read: BookOpen01, drive: File02, chatter: MessageChatCircle };
const SUGGESTIONS = ['What is it doing now?', 'What has been decided so far?', 'Where did it leave off?'];
/** From a point in time (a compaction row, or any entry with `until`). */
const UNTIL_SUGGESTIONS = ['What did this summary leave out?', 'What did the agent know at this point?', 'What was it about to do next?'];

/** Opens a workspace (the project's own when the id is the project's); the layer sets it from the app's navigation. */
let openWorkspace: ((projectId: string, workspaceId: string | null) => void) | null = null;
function show(subject: Pick<GhostSubject, 'projectId' | 'workspaceId'>): void {
  openWorkspace?.(subject.projectId, subject.workspaceId === subject.projectId ? null : subject.workspaceId);
}

/** `m:ss`. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The time a ghost has left at `now`; the whole lifetime while it answers, since its clock holds then. */
function remainingAt(ghost: Ghost, now: number): number {
  if (ghost.expiresAt === null || ghostBusy(ghost)) return GHOST_LIFETIME_MS;
  return ghost.expiresAt - now;
}

/** The clock, ticking each second while a live ghost waits for a question. */
function useNow(ghosts: readonly Ghost[]): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = ghosts.some(ghost => !ghost.ended && ghost.expiresAt !== null && !ghostBusy(ghost));
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The session a ghost reads, as its header and pills name it. */
function sessionName(ghost: Ghost): string {
  return ghost.ready?.title ?? ghost.subject.title ?? 'Main conversation';
}

function HeaderButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return <Tooltip content={label} side="top">
    <button type="button" aria-label={label} onClick={onClick} className="flex size-7 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground">{children}</button>
  </Tooltip>;
}

function GhostHeader({ ghost, remaining, docked }: { ghost: Ghost; remaining: number; docked: boolean }) {
  const { subject, ready } = ghost;
  const until = ready?.until ?? subject.until;
  return <header className="relative flex shrink-0 flex-col gap-1 px-3 pb-2 pt-2.5">
    <div className="flex min-w-0 items-center gap-2">
      <span className="ghost-bob flex size-7 shrink-0 items-center justify-center rounded-full" style={{ color: GHOST, background: `color-mix(in oklab, ${GHOST} 16%, transparent)` }}><GhostGlyph size={17} /></span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em]" style={{ color: `color-mix(in oklab, ${GHOST} 75%, var(--foreground))` }}>Ghost of</span>
        <span className="truncate text-body font-semibold text-foreground" title={subject.workspaceName}>{subject.workspaceName}</span>
      </span>
      {docked
        ? <HeaderButton label="Float it over the workspace" onClick={() => setGhostPlacement('float')}><LayoutRight {...ICON} className="rotate-180" /></HeaderButton>
        : <>
          <HeaderButton label="Dock as a side conversation" onClick={() => setGhostPlacement('dock')}><LayoutRight {...ICON} /></HeaderButton>
          <HeaderButton label="Minimize" onClick={() => focusGhost(null)}><Minus {...ICON} /></HeaderButton>
        </>}
      <HeaderButton label="Close · nothing is kept" onClick={() => closeGhost(ghost.key)}><XClose {...ICON} /></HeaderButton>
    </div>
    <div className="flex min-w-0 items-center gap-1.5 pl-9 text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate" title={ready ? `${ready.title} · ${ready.entries} entries · model ${ready.model}` : undefined}>{ready ? `${ready.main ? '' : 'Subagent or earlier · '}${ready.title} · ${ready.entries} entries` : 'Opening…'}</span>
      {until !== null ? <Tooltip side="bottom" content={<span className="block max-w-[240px] whitespace-normal leading-snug">It reads the session only up to entry {until}, and the drive{ready?.chatter ? ' and Chatter' : ''} as they were then.</span>}>
        <span className="inline-flex shrink-0 cursor-help items-center gap-0.5 rounded-full border border-border px-1.5 leading-4"><ClockRewind width={10} height={10} strokeWidth={2} />up to #{until}</span>
      </Tooltip> : null}
      {subject.archived || ready?.archived ? <span className="shrink-0 rounded-full border border-border px-1.5 leading-4">Archived</span> : null}
      <Tooltip side="bottom" content={<span className="block max-w-[260px] whitespace-normal leading-snug"><b>Reads only.</b> It can search and read this conversation’s transcript (history_search, history_read), read the workspace drive{ready?.chatter ? ' and the project’s Chatter (chatter_read)' : ''}. It can’t write, edit, run, post, send to agents, delegate or report issues.</span>}>
        <span className="inline-flex shrink-0 cursor-help items-center gap-0.5 rounded-full px-1.5 leading-4" style={{ background: `color-mix(in oklab, ${GHOST} 14%, transparent)`, color: `color-mix(in oklab, ${GHOST} 70%, var(--foreground))` }}><Lock01 width={10} height={10} strokeWidth={2} />read-only</span>
      </Tooltip>
      {ghost.expiresAt === null ? null : <Tooltip side="bottom" content={<span className="block max-w-[240px] whitespace-normal leading-snug">Fades 10 minutes after your last question, or when closed. Nothing is kept: no transcript, no drive file, no memory.</span>}>
        <span aria-label="Time left" className="ml-auto inline-flex shrink-0 cursor-help items-center gap-1 font-mono tabular-nums" style={{ color: remaining <= GHOST_WARN_MS ? AMBER : undefined }}>
          <Hourglass03 width={11} height={11} strokeWidth={1.75} />{clock(remaining)}
        </span>
      </Tooltip>}
    </div>
  </header>;
}

function Warning({ ghost, remaining }: { ghost: Ghost; remaining: number }) {
  return <AnimatePresence initial={false}>
    {remaining <= GHOST_WARN_MS && !ghostBusy(ghost) ? <motion.div key="warn" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="shrink-0 overflow-hidden">
      <div role="status" className="mx-3 mb-2 flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-[12px]" style={{ background: `color-mix(in oklab, ${AMBER} 13%, transparent)`, color: `color-mix(in oklab, ${AMBER} 55%, var(--foreground))` }}>
        <Hourglass03 width={13} height={13} strokeWidth={1.75} className="shrink-0" />
        <span className="min-w-0 flex-1 leading-snug">Fading in <b className="font-mono tabular-nums">{clock(remaining)}</b>. Nothing it said will be kept.</span>
        <button type="button" onClick={() => keepGhost(ghost.key)} className="shrink-0 rounded-[7px] px-2 py-0.5 font-medium hover:bg-foreground/[0.07]">Keep 10 min</button>
      </div>
    </motion.div> : null}
  </AnimatePresence>;
}

/**
 * A ghost's draft. One for the agent goes to its workspace's composer (Put in composer), or, the workspace archived, to
 * the composer of a new workspace of the project (New workspace with it); one for everyone (a finding, a workaround, a
 * heads-up) opens the Chatter composer with it and a suggested kind, when the person can read Chatter. Copy is always
 * there; the person sends it, never the ghost.
 */
function DraftCard({ ghost, answer }: { ghost: Ghost; answer: GhostAnswer }) {
  const [copied, setCopied] = useState(false);
  const draft = answer.draft ?? '';
  const everyone = answer.everyone;
  const archived = ghost.subject.archived || ghost.ready?.archived === true;
  const projectId = ghost.subject.projectId;
  return <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-2 overflow-hidden rounded-[12px] border border-dashed border-border bg-background/70" aria-label="Draft" data-draft-for={everyone ? 'everyone' : 'agent'}>
    <div className="flex items-center gap-1.5 border-b border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">Draft</span>
      <span className="truncate">· {everyone ? `for everyone in the project · ${everyone}` : archived ? `for a new workspace (${ghost.subject.workspaceName} is archived)` : `for the agent in ${ghost.subject.workspaceName}`}</span>
    </div>
    <p className="whitespace-pre-wrap px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground">{draft}</p>
    <div className="flex flex-wrap items-center gap-1 border-t border-dashed border-border px-1.5 py-1">
      {everyone
        ? ghost.ready?.chatter ? <Button size="compact" variant="secondary" onClick={() => { show(ghost.subject); openChatter({ projectId, draft: { text: draft, kind: everyone } }); }}>Post to Chatter</Button> : null
        : <Button size="compact" variant="secondary" onClick={() => { const subject = composeGhostDraft(ghost.key, draft); if (subject) show(subject); }}>{archived ? 'New workspace with it' : 'Put in composer'}</Button>}
      <Button size="compact" variant="ghost" onClick={() => { void navigator.clipboard.writeText(draft).then(() => setCopied(true)); }}>
        {copied ? <Check width={13} height={13} strokeWidth={1.75} className="mr-1" /> : <Copy01 width={13} height={13} strokeWidth={1.75} className="mr-1" />}{copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="ml-auto pr-1.5 text-[10.5px] text-muted-foreground">you send it, not the ghost</span>
    </div>
  </motion.div>;
}

/** What a citation of `ghost` does: entries of its main conversation and drive lines open in its workspace, posts in
 * the Chatter pane; entries of a conversation the workspace view doesn't show are only named. */
function citer(ghost: Ghost): (cite: GhostCite) => void {
  return cite => {
    if (cite.kind === 'chatter') { show(ghost.subject); openChatter({ projectId: ghost.subject.projectId, offset: cite.offset }); return; }
    const subject = citeGhost(ghost.key, cite);
    if (subject) show(subject);
  };
}

function AnswerView({ answer, ghost }: { answer: GhostAnswer; ghost: Ghost }) {
  const done = answer.parts !== null || answer.failed !== null;
  const typing = !done && answer.reads.every(line => line.done);
  const onCite = citer(ghost);
  const main = ghost.ready?.main !== false;
  return <div className="flex min-w-0 flex-col gap-1.5" data-ghost-answer={answer.turn}>
    {answer.reads.length ? <ul aria-label="What it read" className="flex flex-col gap-0.5 border-l pl-2 font-mono text-[10.5px] text-muted-foreground" style={{ borderColor: `color-mix(in oklab, ${GHOST} 35%, transparent)` }}>
      {answer.reads.map(line => {
        const Icon = READ_ICON[line.read.kind];
        return <motion.li key={line.index} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="flex min-w-0 items-center gap-1.5" title={line.failed ?? undefined}>
          <Icon width={11} height={11} strokeWidth={1.75} className="shrink-0" />
          <span className={`min-w-0 truncate ${line.done ? line.failed ? 'line-through opacity-70' : '' : 'ghost-shimmer'}`}>{readLabel(line.read)}</span>
          {line.done && !line.failed ? <Check width={10} height={10} strokeWidth={2.25} className="shrink-0 opacity-50" /> : null}
        </motion.li>;
      })}
    </ul> : null}
    {answer.parts ? <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground/90">
      {answer.parts.map((part, index) => typeof part === 'string' ? <Inline key={index} text={part} /> : <CiteChip key={index} cite={part} {...part.kind !== 'entry' || main ? { onCite } : {}} />)}
    </div> : answer.text ? <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground/90"><Inline text={answer.text} />{typing ? <span className="ghost-caret" aria-hidden /> : null}</div>
      : typing ? <span className="ghost-caret" aria-hidden /> : null}
    {answer.truncated ? <span className="text-[11px] text-muted-foreground">It stopped reading at its limit and answered from what it read.</span> : null}
    {answer.failed ? <p role="alert" className="text-[12px] leading-snug" style={{ color: AMBER }}>{answer.failed}</p> : null}
    {answer.draft ? <DraftCard ghost={ghost} answer={answer} /> : null}
  </div>;
}

/** The entry a question is about, as a chip; clearing it asks about the whole session. */
function About({ ghost, entry, clearable }: { ghost: Ghost; entry: number; clearable: boolean }) {
  const onCite = ghost.ready?.main === false ? undefined : citer(ghost);
  return <span className="flex items-center gap-1 text-[11px] text-muted-foreground" data-ghost-about={entry}>
    about <CiteChip cite={{ kind: 'entry', from: entry }} {...onCite ? { onCite } : {}} />
    {clearable ? <button type="button" aria-label="Ask about the whole session" onClick={() => clearGhostAbout(ghost.key)} className="rounded-full p-0.5 hover:bg-foreground/[0.07]"><XClose width={11} height={11} /></button> : null}
  </span>;
}

function GhostConversation({ ghost }: { ghost: Ghost }) {
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const last = ghost.turns.at(-1);
  const busy = ghostBusy(ghost);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [ghost.turns, last]);
  useEffect(() => { if (ghost.about !== null) input.current?.select(); else input.current?.focus(); }, [ghost.ready, ghost.pulse, ghost.about]);
  const asked = new Set(ghost.turns.flatMap(turn => turn.role === 'person' ? [turn.text] : []));
  const ready = ghost.ready;
  const until = ready?.until ?? ghost.subject.until;
  const send = (): void => { if (ghost.input.trim() && !busy && ready) askGhost(ghost.key, ghost.input.trim()); };
  const what = ready ? ready.main ? `${ghost.subject.workspaceName}’s ${ready.title}` : `“${ready.title}” of ${ghost.subject.workspaceName}` : '';
  return <div className="flex min-h-0 flex-1 flex-col">
    <div ref={scroller} className="ghost-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 pb-3 pt-1">
      <p className="text-[12px] leading-relaxed text-muted-foreground" data-ghost-intro>
        {ready ? <>I read <span className="text-foreground">{what}</span> ({until === null ? `${ready.entries} entries` : `up to entry ${until}`}), its drive{ready.chatter ? ' and the project’s Chatter' : ''} as {until === null ? 'it was' : 'they were'} at {time(ready.driveAsOf)}{ready.archived ? ', archived' : ''}. I can’t change, run, post or send anything, and I fade 10 minutes after your last question.</> : 'Opening the ghost…'}
      </p>
      {ghost.turns.map(turn => turn.role === 'person'
        ? <div key={`person-${turn.turn}`} className="flex flex-col items-end gap-1">
          {turn.about !== null ? <About ghost={ghost} entry={turn.about} clearable={false} /> : null}
          <p className="max-w-[88%] rounded-[14px] rounded-br-[5px] bg-foreground/[0.075] px-3 py-1.5 text-[13px] leading-snug text-foreground">{turn.text}</p>
        </div>
        : <AnswerView key={`ghost-${turn.turn}`} answer={turn} ghost={ghost} />)}
      {ready && !busy && ghost.about === null && !ghost.queued ? <div className="flex flex-wrap gap-1.5">
        {(until === null ? SUGGESTIONS : UNTIL_SUGGESTIONS).filter(text => !asked.has(text)).slice(0, 3).map(text => <button key={text} type="button" onClick={() => askGhost(ghost.key, text)} className="ghost-suggestion rounded-full px-2.5 py-1 text-left text-[12px] leading-snug transition-colors">{text}</button>)}
      </div> : null}
    </div>
    <div className="shrink-0 px-2.5 pb-2.5">
      <div className="ghost-input flex flex-col rounded-[14px] px-2.5 pb-1.5 pt-2">
        {ghost.about !== null ? <span className="mb-1"><About ghost={ghost} entry={ghost.about} clearable /></span> : null}
        <textarea ref={input} rows={2} value={ghost.input} aria-label="Ask the ghost" disabled={!ready} onChange={event => setGhostInput(ghost.key, event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }}
          placeholder={ready?.main === false ? 'Ask about this session…' : 'Ask about this conversation…'}
          className="min-h-[38px] w-full resize-none bg-transparent text-[13px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/70" />
        <div className="flex items-center gap-2">
          <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-muted-foreground"><Lock01 width={10} height={10} strokeWidth={2} className="shrink-0" /><span className="truncate">reads the transcript{ready?.chatter ? ', drive and Chatter' : ' and drive'} · keeps nothing</span></span>
          <button type="button" aria-label="Ask" onClick={send} disabled={!ghost.input.trim() || busy || !ready}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-35" style={{ background: GHOST }}><ArrowUp width={15} height={15} strokeWidth={2} /></button>
        </div>
      </div>
    </div>
  </div>;
}

/** What is left of a ghost that ended: when, what it read, and that nothing stayed. */
function Tombstone({ ghost, docked }: { ghost: Ghost; docked: boolean }) {
  const ended = ghost.ended;
  if (!ended) return null;
  const questions = ended.questions;
  const how = ended.reason === 'faded' ? `Faded at ${time(ended.at)}` : ended.reason === 'closed' ? `Closed at ${time(ended.at)}` : `Ended at ${time(ended.at)}`;
  return <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} aria-label="Ghost ended"
    className={`ghost-tombstone pointer-events-auto flex flex-col items-center gap-2 px-5 py-5 text-center ${docked ? 'm-3 rounded-[16px]' : 'w-[340px] rounded-[18px]'}`}>
    <span className="flex size-10 items-center justify-center rounded-full opacity-50" style={{ color: GHOST, background: `color-mix(in oklab, ${GHOST} 12%, transparent)` }}><GhostGlyph size={22} /></span>
    <p className="text-body font-medium text-foreground">Ghost ended. Nothing was kept.</p>
    <p className="text-[12px] leading-relaxed text-muted-foreground">{how}. It read <span className="text-foreground/80">{ghost.subject.workspaceName}</span> · {sessionName(ghost)} from {time(ghost.openedAt)} and {questions ? `answered ${questions} ${questions === 1 ? 'question' : 'questions'}` : 'was never asked anything'}. No transcript, no drive file, no memory remains.</p>
    {ended.message ? <p className="text-[11.5px] leading-snug text-muted-foreground">{ended.message}</p> : null}
    <div className="mt-1 flex items-center gap-1.5">
      <Button size="compact" variant="secondary" onClick={() => resummonGhost(ghost.key)}>Summon a new one</Button>
      <Button size="compact" variant="ghost" onClick={() => dismissGhost(ghost.key)}>Dismiss</Button>
    </div>
  </motion.section>;
}

/** A ghost's window or column body: header, warning and conversation; it fades in its last minute. */
function GhostBody({ ghost, remaining, docked }: { ghost: Ghost; remaining: number; docked: boolean }) {
  return <>
    <span key={ghost.pulse} aria-hidden className={`ghost-pulse pointer-events-none absolute inset-0 ${docked ? '' : 'rounded-[20px]'}`} />
    <GhostHeader ghost={ghost} remaining={remaining} docked={docked} />
    <Warning ghost={ghost} remaining={remaining} />
    <GhostConversation ghost={ghost} />
  </>;
}
const fading = (ghost: Ghost, remaining: number) => remaining <= GHOST_WARN_MS && !ghostBusy(ghost) ? 0.42 + 0.58 * Math.max(0, remaining / GHOST_WARN_MS) : 1;

/** A ghost that is not open: a pill with its session and the ring of its time left (faded ones struck through). */
function GhostPill({ ghost, remaining }: { ghost: Ghost; remaining: number }) {
  const ended = ghost.ended !== null;
  return <Tooltip side="top" content={ended ? `Ended · nothing was kept` : `Ghost of ${ghost.subject.workspaceName} · ${sessionName(ghost)} · fades in ${clock(remaining)}`}>
    <motion.button layout type="button" onClick={() => focusGhost(ghost.key)} initial={{ opacity: 0, y: 10, scale: 0.9 }} animate={{ opacity: ended ? 0.55 : 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.8, filter: 'blur(6px)' }}
      aria-label={`Ghost of ${ghost.subject.workspaceName}`} data-ghost-pill={ghost.key}
      className={`pointer-events-auto flex h-8 max-w-[230px] items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[12px] ${ended ? 'ghost-tombstone' : 'ghost-glass'}`}>
      <span className={ended ? 'opacity-50' : 'ghost-bob'} style={{ color: GHOST }}><GhostGlyph size={15} /></span>
      <span className={`min-w-0 truncate ${ended ? 'text-muted-foreground line-through decoration-muted-foreground/50' : 'text-foreground'}`}>{ghost.ready?.main === false ? sessionName(ghost) : ghost.subject.workspaceName}</span>
      {ghost.subject.until !== null ? <span className="shrink-0 text-[10px] text-muted-foreground">#{ghost.subject.until}</span> : null}
      {ghost.subject.archived ? <span className="shrink-0 text-[10px] text-muted-foreground">archived</span> : null}
      {ended ? <span className="shrink-0 text-[10.5px] text-muted-foreground">faded</span> : <IdleRing remaining={remaining} />}
    </motion.button>
  </Tooltip>;
}

/**
 * The browser's ghosts while they float: the open one's window (or tombstone) at the bottom right, the others as pills
 * under it. Docked, the workspace view draws them (`GhostDock`). A citation opens the ghost's workspace through
 * `onOpenWorkspace` and shows the entry or drive lines there; a draft goes into that workspace's composer.
 */
export function GhostLayer({ onOpenWorkspace }: { onOpenWorkspace(projectId: string, workspaceId: string | null): void }) {
  useEffect(() => {
    openWorkspace = onOpenWorkspace;
    return () => { if (openWorkspace === onOpenWorkspace) openWorkspace = null; };
  }, [onOpenWorkspace]);
  const { ghosts, active, placement } = useGhosts();
  const now = useNow(ghosts);
  if (placement === 'dock') return null;
  const open = ghosts.find(ghost => ghost.key === active) ?? null;
  const remaining = open ? remainingAt(open, now) : GHOST_LIFETIME_MS;
  return <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2" data-ghosts="float">
    <AnimatePresence>
      {open && open.ended ? <Tombstone key={`tomb-${open.key}`} ghost={open} docked={false} />
        : open ? <motion.section key={`ghost-${open.key}`} initial={{ opacity: 0, y: 24, scale: 0.94, filter: 'blur(8px)' }} animate={{ opacity: fading(open, remaining), y: 0, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -36, scale: 0.94, filter: 'blur(14px)', transition: { duration: 0.6, ease: 'easeOut' } }}
          transition={{ type: 'spring', stiffness: 380, damping: 32, opacity: { duration: 0.6 } }}
          aria-label={`Ghost of ${open.subject.workspaceName}`}
          className="ghost-glass pointer-events-auto relative flex h-[min(580px,calc(100vh-7rem))] w-[380px] flex-col overflow-hidden rounded-[20px]">
          <GhostBody ghost={open} remaining={remaining} docked={false} />
        </motion.section> : null}
    </AnimatePresence>
    <div className="flex max-w-[760px] flex-wrap-reverse justify-end gap-1.5" aria-label="Ghosts">
      <AnimatePresence>
        {ghosts.filter(ghost => ghost.key !== active).map(ghost => <GhostPill key={ghost.key} ghost={ghost} remaining={remainingAt(ghost, now)} />)}
      </AnimatePresence>
    </div>
  </div>;
}

/**
 * The ghosts docked: a column on the right of the workspace (`here`, the session on screen), a tab per ghost with the
 * ring of its time left, and with no ghost chosen a start page offering a ghost of `here` with suggested questions.
 */
export function GhostDock({ here }: { here: GhostSubject }) {
  const { ghosts, active } = useGhosts();
  const now = useNow(ghosts);
  const open = ghosts.find(ghost => ghost.key === active) ?? null;
  const remaining = open ? remainingAt(open, now) : GHOST_LIFETIME_MS;
  return <aside aria-label="Ghosts" data-ghosts="dock" className="ghost-dock flex min-h-0 w-[384px] max-w-[100vw] shrink-0 flex-col border-l border-border max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30">
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 px-2">
      <div role="tablist" aria-label="Open ghosts" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {ghosts.map(ghost => {
          const selected = ghost.key === active;
          const ended = ghost.ended !== null;
          return <Tooltip key={ghost.key} side="bottom" content={`${ghost.subject.workspaceName} · ${sessionName(ghost)}${ended ? ' · ended' : ` · fades in ${clock(remainingAt(ghost, now))}`}`}>
            <button type="button" role="tab" aria-selected={selected} aria-label={`Ghost of ${ghost.subject.workspaceName}`} onClick={() => focusGhost(ghost.key)}
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-[12px] transition-colors ${selected ? 'max-w-[180px] bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-foreground/[0.05]'} ${ended ? 'opacity-50' : ''}`}>
              <span style={{ color: GHOST }}><GhostGlyph size={13} /></span>
              {selected ? <span className={`min-w-0 truncate ${ended ? 'line-through' : ''}`}>{ghost.ready?.main === false ? sessionName(ghost) : ghost.subject.workspaceName}</span> : null}
              {ended ? null : <IdleRing remaining={remainingAt(ghost, now)} size={13} />}
            </button>
          </Tooltip>;
        })}
        <Tooltip side="bottom" content={`New ghost of ${here.workspaceName}`}>
          <button type="button" role="tab" aria-selected={open === null} aria-label="New ghost" onClick={() => focusGhost(null)} className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-foreground/[0.05] ${open ? '' : 'bg-background text-foreground shadow-sm'}`}><Plus width={14} height={14} strokeWidth={1.75} /></button>
        </Tooltip>
      </div>
      <HeaderButton label="Float ghosts over the workspace" onClick={() => setGhostPlacement('float')}><LayoutRight {...ICON} className="rotate-180" /></HeaderButton>
    </div>
    <AnimatePresence mode="wait" initial={false}>
      {open ? open.ended ? <Tombstone key={`tomb-${open.key}`} ghost={open} docked />
        : <motion.div key={open.key} initial={{ opacity: 0, x: 12 }} animate={{ opacity: fading(open, remaining), x: 0 }} exit={{ opacity: 0, filter: 'blur(10px)', transition: { duration: 0.4 } }} className="relative flex min-h-0 flex-1 flex-col">
          <GhostBody ghost={open} remaining={remaining} docked />
        </motion.div>
        : <motion.div key={`start-${here.workspaceId}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center" data-ghost-start>
          <span className="ghost-bob flex size-12 items-center justify-center rounded-full" style={{ color: GHOST, background: `color-mix(in oklab, ${GHOST} 14%, transparent)` }}><GhostGlyph size={26} /></span>
          <p className="text-body font-medium text-foreground">Ask a ghost about {here.workspaceName}</p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">It reads the main conversation and the drive, answers with what it read, and changes nothing. It fades 10 minutes after your last question.</p>
          <div className="flex flex-col items-stretch gap-1.5 pt-1">
            {SUGGESTIONS.map(text => <button key={text} type="button" onClick={() => summonGhost(here, { question: text })} className="ghost-suggestion rounded-full px-3 py-1.5 text-[12px]">{text}</button>)}
            <button type="button" onClick={() => summonGhost(here)} className="mt-1 text-[12px] text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">Open an empty ghost</button>
          </div>
        </motion.div>}
    </AnimatePresence>
  </aside>;
}
