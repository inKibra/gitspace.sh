// The ghost's window: a read-only, temporary chat with one session, a small glass window at the bottom right of the app.
// The header says what it reads, that it only reads, and how long it has; under a minute it warns and fades, and when it
// ends it leaves a tombstone that says nothing was kept.
import { Button, Tooltip } from '@gitspace/ui';
import { GHOST_LIFETIME_MS, GHOST_WARN_MS, type GhostCite, type GhostRead } from '@gitspace/protocol-runtime';
import { ArrowUp, BookOpen01, Check, Copy01, File02, Hourglass03, Lock01, SearchSm, XClose } from '@untitledui/icons';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AMBER, CiteChip, GHOST, GhostGlyph, Inline } from './ghost-parts.js';
import {
  askGhost, citeGhost, closeGhost, composeGhostDraft, dismissGhost, ghostBusy, keepGhost, setGhostInput, summonGhost, useGhost,
  type Ghost, type GhostAnswer, type GhostReadLine,
} from './ghost-store.js';

const ICON = { width: 14, height: 14, strokeWidth: 1.75 };
const READ_ICON: Record<GhostRead['kind'], typeof SearchSm> = { search: SearchSm, read: BookOpen01, drive: File02 };
const SUGGESTIONS = ['What is it doing now?', 'What has been decided so far?', 'Where did it leave off?'];

/** `m:ss`. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function readLabel(line: GhostReadLine): string {
  const { read } = line;
  if (read.kind === 'search') return `searched “${read.query}”${read.hits === null ? '' : ` · ${read.hits} ${read.hits === 1 ? 'hit' : 'hits'}`}`;
  if (read.kind === 'read') return read.from === null ? 'reading the transcript' : read.from === read.to ? `read entry ${read.from}` : `read transcript ${read.from}–${read.to}`;
  return `read ${read.url}`;
}

function HeaderButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return <Tooltip content={label} side="top">
    <button type="button" aria-label={label} onClick={onClick} className="flex size-7 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground">{children}</button>
  </Tooltip>;
}

function GhostHeader({ ghost, remaining }: { ghost: Ghost; remaining: number }) {
  const { subject, ready } = ghost;
  return <header className="relative flex shrink-0 flex-col gap-1 px-3 pb-2 pt-2.5">
    <div className="flex min-w-0 items-center gap-2">
      <span className="ghost-bob flex size-7 shrink-0 items-center justify-center rounded-full" style={{ color: GHOST, background: `color-mix(in oklab, ${GHOST} 16%, transparent)` }}><GhostGlyph size={17} /></span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em]" style={{ color: `color-mix(in oklab, ${GHOST} 75%, var(--foreground))` }}>Ghost of</span>
        <span className="truncate text-body font-semibold text-foreground" title={subject.workspaceName}>{subject.workspaceName}</span>
      </span>
      <HeaderButton label="Close · nothing is kept" onClick={closeGhost}><XClose {...ICON} /></HeaderButton>
    </div>
    <div className="flex min-w-0 items-center gap-1.5 pl-9 text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate" title={ready ? `${ready.title} · ${ready.entries} entries · model ${ready.model}` : undefined}>{ready ? `${ready.title} · ${ready.entries} entries` : 'Opening…'}</span>
      {subject.archived ? <span className="shrink-0 rounded-full border border-border px-1.5 leading-4">Archived</span> : null}
      <Tooltip side="bottom" content={<span className="block max-w-[260px] whitespace-normal leading-snug"><b>Reads only.</b> It can search and read this conversation’s transcript (history_search, history_read) and read the workspace drive. It can’t write, edit, run, send to agents, delegate or report issues.</span>}>
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

function Warning({ remaining, busy }: { remaining: number; busy: boolean }) {
  return <AnimatePresence initial={false}>
    {remaining <= GHOST_WARN_MS && !busy ? <motion.div key="warn" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="shrink-0 overflow-hidden">
      <div role="status" className="mx-3 mb-2 flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-[12px]" style={{ background: `color-mix(in oklab, ${AMBER} 13%, transparent)`, color: `color-mix(in oklab, ${AMBER} 55%, var(--foreground))` }}>
        <Hourglass03 width={13} height={13} strokeWidth={1.75} className="shrink-0" />
        <span className="min-w-0 flex-1 leading-snug">Fading in <b className="font-mono tabular-nums">{clock(remaining)}</b>. Nothing it said will be kept.</span>
        <button type="button" onClick={keepGhost} className="shrink-0 rounded-[7px] px-2 py-0.5 font-medium hover:bg-foreground/[0.07]">Keep 10 min</button>
      </div>
    </motion.div> : null}
  </AnimatePresence>;
}

function DraftCard({ draft, ghost, onOpenWorkspace }: { draft: string; ghost: Ghost; onOpenWorkspace(projectId: string, workspaceId: string): void }) {
  const [copied, setCopied] = useState(false);
  const live = !ghost.subject.archived;
  return <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-2 overflow-hidden rounded-[12px] border border-dashed border-border bg-background/70" aria-label="Draft">
    <div className="flex items-center gap-1.5 border-b border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">Draft</span>
      <span className="truncate">· {live ? `for the agent in ${ghost.subject.workspaceName}` : 'for you to send'}</span>
    </div>
    <p className="whitespace-pre-wrap px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground">{draft}</p>
    <div className="flex items-center gap-1 border-t border-dashed border-border px-1.5 py-1">
      {live ? <Button size="compact" variant="secondary" onClick={() => { const subject = composeGhostDraft(draft); if (subject) onOpenWorkspace(subject.projectId, subject.workspaceId); }}>Put in composer</Button> : null}
      <Button size="compact" variant="ghost" onClick={() => { void navigator.clipboard.writeText(draft).then(() => setCopied(true)); }}>
        {copied ? <Check width={13} height={13} strokeWidth={1.75} className="mr-1" /> : <Copy01 width={13} height={13} strokeWidth={1.75} className="mr-1" />}{copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="ml-auto pr-1.5 text-[10.5px] text-muted-foreground">you send it, not the ghost</span>
    </div>
  </motion.div>;
}

function AnswerView({ answer, ghost, onCite, onOpenWorkspace }: { answer: GhostAnswer; ghost: Ghost; onCite(cite: GhostCite): void; onOpenWorkspace(projectId: string, workspaceId: string): void }) {
  const done = answer.parts !== null || answer.failed !== null;
  const typing = !done && answer.reads.every(line => line.done);
  return <div className="flex min-w-0 flex-col gap-1.5" data-ghost-answer={answer.turn}>
    {answer.reads.length ? <ul aria-label="What it read" className="flex flex-col gap-0.5 border-l pl-2 font-mono text-[10.5px] text-muted-foreground" style={{ borderColor: `color-mix(in oklab, ${GHOST} 35%, transparent)` }}>
      {answer.reads.map(line => {
        const Icon = READ_ICON[line.read.kind];
        return <motion.li key={line.index} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="flex min-w-0 items-center gap-1.5" title={line.failed ?? undefined}>
          <Icon width={11} height={11} strokeWidth={1.75} className="shrink-0" />
          <span className={`min-w-0 truncate ${line.done ? line.failed ? 'line-through opacity-70' : '' : 'ghost-shimmer'}`}>{readLabel(line)}</span>
          {line.done && !line.failed ? <Check width={10} height={10} strokeWidth={2.25} className="shrink-0 opacity-50" /> : null}
        </motion.li>;
      })}
    </ul> : null}
    {answer.parts ? <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground/90">
      {answer.parts.map((part, index) => typeof part === 'string' ? <Inline key={index} text={part} /> : <CiteChip key={index} cite={part} onCite={onCite} />)}
    </div> : answer.text ? <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground/90"><Inline text={answer.text} />{typing ? <span className="ghost-caret" aria-hidden /> : null}</div>
      : typing ? <span className="ghost-caret" aria-hidden /> : null}
    {answer.truncated ? <span className="text-[11px] text-muted-foreground">It stopped reading at its limit and answered from what it read.</span> : null}
    {answer.failed ? <p role="alert" className="text-[12px] leading-snug" style={{ color: AMBER }}>{answer.failed}</p> : null}
    {answer.draft ? <DraftCard draft={answer.draft} ghost={ghost} onOpenWorkspace={onOpenWorkspace} /> : null}
  </div>;
}

function GhostConversation({ ghost, onCite, onOpenWorkspace }: { ghost: Ghost; onCite(cite: GhostCite): void; onOpenWorkspace(projectId: string, workspaceId: string): void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const last = ghost.turns.at(-1);
  const busy = ghostBusy(ghost);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [ghost.turns, last]);
  useEffect(() => { input.current?.focus(); }, [ghost.ready, ghost.pulse]);
  const asked = new Set(ghost.turns.flatMap(turn => turn.role === 'person' ? [turn.text] : []));
  const ready = ghost.ready;
  const send = (): void => { if (ghost.input.trim() && !busy && ready) askGhost(ghost.input.trim()); };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div ref={scroller} className="ghost-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 pb-3 pt-1">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {ready ? <>I read <span className="text-foreground">{ghost.subject.workspaceName}’s {ready.title}</span> ({ready.entries} entries) and its drive as it was at {time(ready.driveAsOf)}{ghost.subject.archived ? ', archived' : ''}. I can’t change, run or send anything, and I fade 10 minutes after your last question.</> : 'Opening the ghost…'}
      </p>
      {ghost.turns.map(turn => turn.role === 'person'
        ? <div key={`person-${turn.turn}`} className="flex flex-col items-end gap-1"><p className="max-w-[88%] rounded-[14px] rounded-br-[5px] bg-foreground/[0.075] px-3 py-1.5 text-[13px] leading-snug text-foreground">{turn.text}</p></div>
        : <AnswerView key={`ghost-${turn.turn}`} answer={turn} ghost={ghost} onCite={onCite} onOpenWorkspace={onOpenWorkspace} />)}
      {ready && !busy ? <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.filter(text => !asked.has(text)).slice(0, 3).map(text => <button key={text} type="button" onClick={() => askGhost(text)} className="ghost-suggestion rounded-full px-2.5 py-1 text-left text-[12px] leading-snug transition-colors">{text}</button>)}
      </div> : null}
    </div>
    <div className="shrink-0 px-2.5 pb-2.5">
      <div className="ghost-input flex flex-col rounded-[14px] px-2.5 pb-1.5 pt-2">
        <textarea ref={input} rows={2} value={ghost.input} aria-label="Ask the ghost" disabled={!ready} onChange={event => setGhostInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }}
          placeholder="Ask about this conversation…"
          className="min-h-[38px] w-full resize-none bg-transparent text-[13px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/70" />
        <div className="flex items-center gap-2">
          <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-muted-foreground"><Lock01 width={10} height={10} strokeWidth={2} className="shrink-0" /><span className="truncate">reads the transcript and drive · keeps nothing</span></span>
          <button type="button" aria-label="Ask" onClick={send} disabled={!ghost.input.trim() || busy || !ready}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-35" style={{ background: GHOST }}><ArrowUp width={15} height={15} strokeWidth={2} /></button>
        </div>
      </div>
    </div>
  </div>;
}

/** What is left of a ghost that ended: when, what it read, and that nothing stayed. */
function Tombstone({ ghost }: { ghost: Ghost }) {
  const ended = ghost.ended;
  if (!ended) return null;
  const questions = ended.questions;
  const how = ended.reason === 'faded' ? `Faded at ${time(ended.at)}` : ended.reason === 'closed' ? `Closed at ${time(ended.at)}` : `Ended at ${time(ended.at)}`;
  return <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} aria-label="Ghost ended"
    className="ghost-tombstone pointer-events-auto flex w-[340px] flex-col items-center gap-2 rounded-[18px] px-5 py-5 text-center">
    <span className="flex size-10 items-center justify-center rounded-full opacity-50" style={{ color: GHOST, background: `color-mix(in oklab, ${GHOST} 12%, transparent)` }}><GhostGlyph size={22} /></span>
    <p className="text-body font-medium text-foreground">Ghost ended. Nothing was kept.</p>
    <p className="text-[12px] leading-relaxed text-muted-foreground">{how}. It read <span className="text-foreground/80">{ghost.subject.workspaceName}</span>{ghost.ready ? ` · ${ghost.ready.title}` : ''} from {time(ghost.openedAt)} and {questions ? `answered ${questions} ${questions === 1 ? 'question' : 'questions'}` : 'was never asked anything'}. No transcript, no drive file, no memory remains.</p>
    {ended.message ? <p className="text-[11.5px] leading-snug text-muted-foreground">{ended.message}</p> : null}
    <div className="mt-1 flex items-center gap-1.5">
      <Button size="compact" variant="secondary" onClick={() => summonGhost(ghost.subject)}>Summon a new one</Button>
      <Button size="compact" variant="ghost" onClick={dismissGhost}>Dismiss</Button>
    </div>
  </motion.section>;
}

/** The time a live ghost has left, ticking each second while it waits for a question. */
function useRemaining(ghost: Ghost | null): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!ghost && !ghost.ended && ghost.expiresAt !== null && !ghostBusy(ghost);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  if (!ghost || ghost.expiresAt === null) return GHOST_LIFETIME_MS;
  return ghostBusy(ghost) ? GHOST_LIFETIME_MS : ghost.expiresAt - now;
}

/**
 * The browser's ghost, floating at the bottom right: its window while it lives, its tombstone once it ends. A citation
 * opens the ghost's workspace and shows the entry or drive lines there; a draft goes into that workspace's composer.
 */
export function GhostLayer({ onOpenWorkspace }: { onOpenWorkspace(projectId: string, workspaceId: string): void }) {
  const ghost = useGhost();
  const remaining = useRemaining(ghost);
  const busy = ghost ? ghostBusy(ghost) : false;
  const fade = remaining <= GHOST_WARN_MS && !busy ? 0.42 + 0.58 * Math.max(0, remaining / GHOST_WARN_MS) : 1;
  const onCite = (cite: GhostCite): void => { const subject = citeGhost(cite); if (subject) onOpenWorkspace(subject.projectId, subject.workspaceId); };
  return <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end">
    <AnimatePresence>
      {ghost && ghost.ended ? <Tombstone key={`tomb-${ghost.key}`} ghost={ghost} />
        : ghost ? <motion.section key={`ghost-${ghost.key}`} initial={{ opacity: 0, y: 24, scale: 0.94, filter: 'blur(8px)' }} animate={{ opacity: fade, y: 0, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -36, scale: 0.94, filter: 'blur(14px)', transition: { duration: 1.1, ease: 'easeOut' } }}
          transition={{ type: 'spring', stiffness: 380, damping: 32, opacity: { duration: 0.6 } }}
          aria-label={`Ghost of ${ghost.subject.workspaceName}`}
          className="ghost-glass pointer-events-auto relative flex h-[min(580px,calc(100vh-6rem))] w-[380px] flex-col overflow-hidden rounded-[20px]">
          <span key={ghost.pulse} aria-hidden className="ghost-pulse pointer-events-none absolute inset-0 rounded-[20px]" />
          <GhostHeader ghost={ghost} remaining={remaining} />
          <Warning remaining={remaining} busy={busy} />
          <GhostConversation ghost={ghost} onCite={onCite} onOpenWorkspace={onOpenWorkspace} />
        </motion.section> : null}
    </AnimatePresence>
  </div>;
}
