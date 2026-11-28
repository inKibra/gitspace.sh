// The workspace beside the list or the board, for the user looking: GitSpaceShell's top bar with the holders' chips,
// the handle's actions and the Environment by scope; the conversation with every prompt labelled by its sender, which
// credential paid each turn, the handle changes, a handle request arriving for the holders, the agent proposing a
// phase move a permitted holder accepts, and the pull request's commits with their attribution; the composer for a
// holder, or notes for everyone else, with the notes beside it.
import { PhaseMenuItems } from '../AppSidebar.js';
import { TranscriptItemView } from '../chat/TranscriptItemView.js';
import { PHASE_LABEL, PHASES, workspaceStatusLabel } from '../GitSpaceShell.js';
import { GhostGlyph } from '../ghost/ghost-parts.js';
import { PrChips, StatusBadge } from '../sidebar/parts.js';
import { phaseRefusal } from '../sidebar/stack-rules.js';
import type { TranscriptItem } from '@gitspace/blocks';
import { badgeColors, Button, DropdownContent, DropdownLabel, DropdownMenu, DropdownTrigger, InputMessage, ScrollArea, SidebarInsetTopbar, Tooltip } from '@gitspace/ui';
import { Attachment01, ChevronDown, ClipboardCheck, CpuChip01, DotsHorizontal, Expand06, GitBranch01, GitCommit, LayoutRight, MessageChatCircle, Pencil01, Send01, StickerSquare, Terminal, Trash01, XClose } from '@untitledui/icons';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { actorLabel, CARD_ITEMS, COMMITS, principalOf, PROJECTS, TEAM, userOf, WORKSPACES, type Note, type Phase, type Prompt } from './data.js';
import { EnvironmentPopover, payerLine, payerOf } from './environment.js';
import { HandleRequestRow, UNDO_MS, type Held } from './inbox.js';
import { names, type Row } from './model.js';
import { ResolvedRow } from './parts.js';
import { ScriptTranscript } from './flows/scripts.js';
import { AutofillEvents } from './flows/secret-rules.js';
import { Avatar, HandleActions, membersOf } from './people.js';
import { projectRoleOf, useRoles, why } from './settings/roles.js';
import { useMock } from './viewer.js';

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const clock = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Who started the turn whose answer the agent gave last: the newest prompt's sender (the turn starter pays first). */
function turnStarter(prompts: readonly Prompt[], holders: readonly string[]): string {
  return prompts.at(-1)?.from ?? holders[0] ?? 'maya';
}

/** A prompt as the transcript shows it, under its sender: "Maya · 10:42", "Maya via Claude Code · 10:42" (her MCP
 * client, under her handle), "Deps bot (sponsored by Rina) · over MCP · 10:42". */
function LabelledPrompt({ prompt, viewer }: { prompt: Prompt; viewer: string }) {
  const sender = principalOf(prompt.from);
  const label = sender.kind === 'bot' ? actorLabel(sender.id, prompt.client) : `${sender.first}${prompt.client ? ` via ${prompt.client}` : ''}${sender.id === viewer ? ' (you)' : ''}`;
  const item: TranscriptItem = { id: prompt.id, type: 'message', role: 'user', at: minutesAgo(prompt.minutesAgo), text: prompt.text };
  return <div data-prompt={prompt.id} className="flex flex-col gap-1">
    <span className="flex items-center justify-end gap-1.5 text-[11.5px] text-muted-foreground">
      {prompt.via ? <span className="inline-flex items-center gap-1"><StickerSquare width={11} height={11} strokeWidth={1.75} />note from {actorLabel(prompt.via)}, sent by</span> : null}
      <Avatar userId={sender.id} size={16} /><span className="font-medium text-foreground">{label}</span>
      {prompt.client && sender.kind === 'person' ? <Tooltip content={`${prompt.client} acts as ${sender.first}: ${sender.first}’s project role, narrowed by its MCP grant, under ${sender.first}’s handle`} side="top"><span data-client="" className="rounded-full px-1.5 text-[10.5px] shadow-[inset_0_0_0_1px_var(--border)]">MCP · {sender.first}’s handle</span></Tooltip> : null}
      {sender.kind === 'bot' ? <span className="rounded-full px-1.5 text-[10.5px] shadow-[inset_0_0_0_1px_var(--border)]">bot · over MCP</span> : null}
      <span>· {prompt.minutesAgo ? clock(prompt.minutesAgo) : 'now'}</span>
    </span>
    <TranscriptItemView item={{ ...item, text: `**${sender.kind === 'bot' ? sender.name : label.replace(' (you)', '')}:** ${prompt.text}` }} active={false} onAnswer={async () => undefined} />
  </div>;
}

/** A line in the conversation about the handle itself: who joined, who let go. */
function HandleEvent({ text, userId }: { text: string; userId: string }) {
  return <p data-handle-event="" className="flex items-center justify-center gap-1.5 text-[11.5px] text-muted-foreground"><span className="h-px w-8 bg-border" /><Avatar userId={userId} size={14} />{text}<span className="h-px w-8 bg-border" /></p>;
}

/** The Change Guide's pull request card: each commit with its author (the turn starter), the holders who prompted
 * that turn as co-authors, GitSpace as committer, and the conversation trailer. */
export function CommitsCard({ workspaceId }: { workspaceId: string }) {
  const commits = COMMITS[workspaceId] ?? [];
  const workspace = WORKSPACES.find((candidate) => candidate.id === workspaceId);
  const pull = workspace?.pulls[0];
  const [open, setOpen] = useState<string | null>(commits.at(-1)?.sha ?? null);
  if (!commits.length || !pull || !workspace) return null;
  return <section data-commits="" className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
    <header className="flex items-center gap-2 text-[13px]">
      <GitCommit width={15} height={15} strokeWidth={1.75} className="text-muted-foreground" />
      <span className="font-semibold text-foreground">Change Guide · #{pull.number} {pull.title}</span>
      <span className="text-muted-foreground">· {commits.length} commits</span>
    </header>
    <ol className="flex flex-col divide-y divide-border">
      {commits.map((commit) => {
        const author = userOf(commit.author);
        const expanded = open === commit.sha;
        return <li key={commit.sha} className="flex flex-col gap-1 py-2">
          <button type="button" onClick={() => setOpen(expanded ? null : commit.sha)} className="flex min-w-0 items-center gap-2 text-left">
            <span className="font-mono text-[11px] text-muted-foreground">{commit.sha}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{commit.subject}</span>
            <span className="flex shrink-0 items-center" title={`Author ${author.name}${commit.coAuthors.length ? ` · co-authors ${commit.coAuthors.map((id) => userOf(id).name).join(', ')}` : ''}`}>
              <Avatar userId={author.id} size={18} ring />
              {commit.coAuthors.map((id) => <span key={id} className="-ml-1.5"><Avatar userId={id} size={18} ring /></span>)}
            </span>
          </button>
          <span className="text-[11.5px] text-muted-foreground">
            <span className="text-foreground/85">{author.name}</span> authored{commit.coAuthors.length ? <> with <span className="text-foreground/85">{commit.coAuthors.map((id) => userOf(id).name).join(', ')}</span></> : null} · GitSpace committed · turn {commit.turn} · {clock(commit.minutesAgo)}
          </span>
          {expanded ? <pre className="overflow-x-auto whitespace-pre-wrap rounded-[10px] bg-surface-2 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">{[
            `commit ${commit.sha}`,
            `Author:    ${author.name} <${author.email}>`,
            'Committer: GitSpace <agent@gitspace.sh>',
            '',
            `    ${commit.subject}`,
            '',
            ...commit.coAuthors.map((id) => `    Co-authored-by: ${userOf(id).name} <${userOf(id).email}>`),
            `    GitSpace-Conversation: https://${TEAM.host}/c/${workspace.name}#turn-${commit.turn}`,
          ].join('\n')}</pre> : null}
        </li>;
      })}
    </ol>
    <p className="text-[11px] text-muted-foreground">Author is who started the turn; Co-authored-by lists the other holders who prompted it. Notes sent on by a holder count as that holder’s.</p>
  </section>;
}

/** The gate into Review: the pull request's CI checks, read from GitHub through the GitHub App. Failing or running
 * checks hold Review; with no CI on the repository (or checks GitSpace can't read) Review relies on the agent's
 * report. Returns the line to show and why Review is held, if it is. */
function reviewGate(row: Row): { line: ReactNode; held: string | null } {
  const pull = row.workspace.pulls[0];
  const checks = pull?.checks ?? null;
  const tone = checks === 'passing' ? badgeColors.green : checks === 'failing' ? badgeColors.red : checks === 'pending' ? badgeColors.amber : badgeColors.gray;
  const text = !pull ? 'No CI checks: Review relies on the agent’s report · no pull request yet'
    : checks === 'passing' ? `CI checks on #${pull.number} pass · read from GitHub through the GitHub App; they gate Review`
    : checks === 'failing' ? `CI checks on #${pull.number} fail · Review waits until the pull request’s checks pass`
    : checks === 'pending' ? `CI checks on #${pull.number} are running · Review waits for them`
    : checks === 'none' ? `No CI checks: Review relies on the agent’s report · #${pull.number}’s repository runs no CI`
    : `No CI checks: Review relies on the agent’s report · GitSpace can’t read #${pull.number}’s checks`;
  const held = pull && checks === 'failing' ? `CI checks on #${pull.number} fail: Review waits until they pass` : pull && checks === 'pending' ? `CI checks on #${pull.number} are still running: Review waits for them` : null;
  return { held, line: <p data-review-gate={checks ?? 'unreadable'} className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} /><span className={checks === 'failing' ? 'text-foreground' : undefined}>{text}</span></p> };
}

/** The agent (or the bot holding the handle) asks to move the workspace on: it can't move itself; a holder whose role
 * allows the target accepts. A bot's own project role is named when it refuses; with only a bot holding, any person
 * in the project whose role allows the move accepts. Into Review, the pull request's CI checks gate it too. */
function PhaseProposal({ row, to, onAccept }: { row: Row; to: Phase; onAccept(): void }) {
  useRoles();
  const api = useMock();
  const me = api.viewer.id;
  const projectId = row.workspace.projectId;
  const bot = row.holders.map(principalOf).find((principal) => principal.kind === 'bot');
  const people = bot ? membersOf(projectId) : row.holders;
  const permitted = people.filter((id) => why(id, projectId, `phase.${to}`) === null);
  const gate = to === 'review' ? reviewGate(row) : null;
  const refusal = (!bot && !row.mine ? `Only a holder accepts · ${permitted.length ? names(permitted) : 'no holder'} can` : why(me, projectId, `phase.${to}`)) ?? gate?.held ?? null;
  const proposer = bot ? actorLabel(bot.id) : 'The agent';
  if (row.phase === to) return <div data-proposal="accepted" className="flex flex-col gap-1"><p className="flex items-center gap-1.5 text-caption text-muted-foreground"><ClipboardCheck width={13} height={13} strokeWidth={1.75} />Moved to {PHASE_LABEL[to]} · accepted on {bot ? `${bot.name}’s` : 'the agent’s'} proposal by {api.viewer.first}</p>{gate?.line}</div>;
  return <section data-proposal="" className="flex flex-col gap-2 rounded-2xl border border-border px-3.5 py-3" style={{ boxShadow: `inset 3px 0 0 color-mix(in oklab, ${badgeColors.violet} 70%, transparent)` }}>
    <p className="flex items-center gap-2 text-[13px] text-foreground">{bot ? <Avatar userId={bot.id} size={16} /> : <ClipboardCheck width={15} height={15} strokeWidth={1.75} style={{ color: badgeColors.violet }} />}<span className="font-medium">{proposer} proposes moving to {PHASE_LABEL[to]}</span></p>
    {bot ? <p data-bot-refusal="" className="text-[12.5px] leading-relaxed text-muted-foreground"><span className="text-foreground">{why(bot.id, projectId, `phase.${to}`) ?? `${bot.name} may move it itself`}.</span> The lockfile diff is in the pull request. A person whose project role may move into {PHASE_LABEL[to]} accepts{permitted.length ? ` (${names(permitted)})` : ''}; it’s recorded as theirs, on {bot.name}’s proposal.</p>
      : <p className="text-[12.5px] leading-relaxed text-muted-foreground">Every requirement is met and the Change Guide is written. Agents act for the account and can’t change phase themselves; a holder whose role may move into {PHASE_LABEL[to]} accepts{permitted.length ? ` (${names(permitted)})` : ''}.</p>}
    {gate?.line}
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      <Button variant="ghost" size="compact" onClick={() => api.say(`Not yet · ${bot ? bot.name : 'the agent'} keeps working in Code`)}>Not yet</Button>
      <Tooltip content={refusal ?? `Moves ${row.name} to ${PHASE_LABEL[to]} · recorded as accepted by ${api.viewer.name}`} side="top">
        <Button variant="primary" size="compact" aria-disabled={refusal ? true : undefined} className={refusal ? 'cursor-not-allowed opacity-45' : undefined}
          onClick={() => { if (refusal) api.say(refusal); else onAccept(); }}>Accept · move to {PHASE_LABEL[to]}</Button>
      </Tooltip>
    </div>
  </section>;
}

/** What the notes panel can do to a note: send it (it becomes the holder's prompt), dismiss it (the writer is told),
 * edit it, or delete it (the writer's own leave no trace; a Lead's deleting someone else's is audited). */
export interface NoteActions { onSend(note: Note): void; onDismiss(note: Note): void; onEdit(note: Note, text: string): void; onDelete(note: Note): void }

function IconAct({ label, tip, onClick, children }: { label: string; tip: string; onClick(): void; children: ReactNode }) {
  return <Tooltip content={tip} side="top"><Button variant="ghost" size="icon-compact" aria-label={label} onClick={onClick}>{children}</Button></Tooltip>;
}

/** Notes beside the composer: left by anyone in the project, bots too. The writer edits or deletes their own while it's
 * open; a holder sends it to the agent or dismisses it; a Lead (an Owner is Lead everywhere) deletes any. They don't
 * expire; archiving the workspace closes them. Past notes lists the sent and dismissed ones with who did it. */
function NotesPanel({ notes, row, actions }: { notes: readonly Note[]; row: Row; actions: NoteActions }) {
  const api = useMock();
  const me = api.viewer.id;
  const [past, setPast] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const archived = row.workspace.archived;
  const lead = projectRoleOf(me, row.workspace.projectId)?.fixed === true;
  const open = notes.filter((note) => note.state === 'open');
  const done = notes.filter((note) => note.state !== 'open');
  return <aside data-notes="" className="flex max-h-[60vh] w-full flex-col gap-1.5 overflow-y-auto rounded-2xl border border-border bg-background/95 p-2.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.3)] backdrop-blur">
    <span className="flex flex-wrap items-center gap-x-1.5 px-0.5 text-[11.5px] font-medium text-foreground">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><StickerSquare width={13} height={13} strokeWidth={1.75} />Notes · {open.length}</span>
      <span className="font-normal text-muted-foreground">{archived ? 'closed with the workspace' : row.mine ? 'send or dismiss' : 'a holder sends or dismisses them'}</span>
      <button type="button" data-past-toggle="" aria-pressed={past} onClick={() => setPast((value) => !value)} className={`ml-auto rounded-md px-1.5 text-[11px] font-medium ${past ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover'}`}>Past · {done.length}</button>
    </span>
    {open.length ? open.map((note) => {
      const writer = note.from === me;
      return <div key={note.id} data-note={note.id} className={`flex min-w-0 items-start gap-2 rounded-xl bg-surface-2 px-2 py-1.5 ${archived ? 'opacity-60' : ''}`}>
        <Avatar userId={note.from} size={16} />
        {editing?.id === note.id ? <span className="flex min-w-0 flex-1 flex-col gap-1">
          <textarea aria-label="Edit note" value={editing.text} onChange={(event) => setEditing({ id: note.id, text: event.target.value })} className="min-h-14 w-full resize-none rounded-lg bg-background px-2 py-1 text-[12px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none" />
          <span className="flex justify-end gap-1"><Button variant="ghost" size="compact" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" size="compact" onClick={() => { actions.onEdit(note, editing.text.trim() || note.text); setEditing(null); }}>Save</Button></span>
        </span> : <span className="min-w-0 flex-1 text-[12px] leading-snug text-foreground/90"><span className="font-medium">{actorLabel(note.from)}</span> · {note.text}{note.edited ? <span className="text-muted-foreground"> (edited)</span> : null}</span>}
        {archived || editing?.id === note.id ? null : <span className="flex shrink-0 items-center">
          {writer ? <IconAct label="Edit your note" tip="Edit · until a holder sends it" onClick={() => setEditing({ id: note.id, text: note.text })}><Pencil01 width={13} height={13} strokeWidth={1.75} /></IconAct> : null}
          {writer ? <IconAct label="Delete your note" tip="Delete · leaves no trace" onClick={() => actions.onDelete(note)}><Trash01 width={13} height={13} strokeWidth={1.75} /></IconAct> : null}
          {row.mine && !writer ? <IconAct label={`Send ${principalOf(note.from).first}’s note to the agent`} tip="Send to the agent as your prompt, marked as their note" onClick={() => actions.onSend(note)}><Send01 width={13} height={13} strokeWidth={1.75} /></IconAct> : null}
          {row.mine && !writer ? <IconAct label={`Dismiss ${principalOf(note.from).first}’s note`} tip={`Dismiss · ${principalOf(note.from).first} sees “Dismissed by ${api.viewer.first}”`} onClick={() => actions.onDismiss(note)}><XClose width={13} height={13} strokeWidth={1.75} /></IconAct> : null}
          {lead && !writer ? <IconAct label={`Delete ${principalOf(note.from).first}’s note`} tip="Delete as Lead · recorded in the audit log" onClick={() => actions.onDelete(note)}><Trash01 width={13} height={13} strokeWidth={1.75} /></IconAct> : null}
        </span>}
      </div>;
    }) : <p className="px-0.5 text-[11.5px] text-muted-foreground">No open notes</p>}
    {past ? <div data-past-notes="" className="flex flex-col gap-1 border-t border-border pt-1.5">
      {done.length ? done.map((note) => <div key={note.id} data-past-note={note.id} className="flex min-w-0 items-start gap-2 px-1 py-0.5 text-[11.5px] text-muted-foreground">
        <Avatar userId={note.from} size={14} />
        <span className="min-w-0 flex-1"><span className="text-foreground/80">{actorLabel(note.from)}</span> · {note.text}<span className="block font-medium" style={{ color: note.state === 'sent' ? badgeColors.green : badgeColors.gray }}>{note.state === 'sent' ? 'Sent' : 'Dismissed'} by {note.by ? principalOf(note.by).first : '—'}</span></span>
      </div>) : <p className="px-0.5 text-[11.5px] text-muted-foreground">Nothing sent or dismissed yet</p>}
    </div> : null}
    <p className="px-0.5 text-[10.5px] text-muted-foreground">{archived ? 'Archiving closed these notes.' : 'Notes don’t expire: they stay through phase moves and handle changes, and a new holder inherits them.'}</p>
  </aside>;
}

export function WorkspacePane({ row, rows, board, done, held, now, notes, prompts, onNote, onSendNote, onDismissNote, onEditNote, onDeleteNote, onPrompt, onAnswer, onUndo, onMovePhase, onExpand, onClose, onAskGhost }: {
  row: Row; rows: readonly Row[]; board: boolean; done: ReadonlySet<string>; held: Held; now: number; notes: readonly Note[]; prompts: readonly Prompt[];
  onNote(text: string): void; onSendNote(note: Note): void; onDismissNote(note: Note): void; onEditNote(note: Note, text: string): void; onDeleteNote(note: Note): void; onPrompt(text: string): void;
  onAnswer(id: string, label: string): void; onUndo(id: string): void; onMovePhase(phase: Phase): void; onExpand(): void; onClose(): void; onAskGhost(): void;
}) {
  const noteActions: NoteActions = { onSend: onSendNote, onDismiss: onDismissNote, onEdit: onEditNote, onDelete: onDeleteNote };
  useRoles();
  const api = useMock();
  const me = api.viewer.id;
  const [draft, setDraft] = useState('');
  const [initialHolders] = useState(() => row.workspace.holders);
  const project = PROJECTS.find((candidate) => candidate.id === row.workspace.projectId);
  const rule = (item: Row) => ({ id: item.id, name: item.name, phase: item.phase, dependsOn: item.dependsOn, relatedTo: item.relatedTo, stackedOn: item.stackedOn });
  const ask = CARD_ITEMS.find((item) => item.workspaceId === row.id && (item.kind === 'question' || item.kind === 'plan'));
  const heldAsk = CARD_ITEMS.find((item) => item.workspaceId === row.id && held.has(item.id));
  const heldEntry = heldAsk ? held.get(heldAsk.id) : undefined;
  const joined = row.holders.filter((id) => !initialHolders.includes(id));
  const left = initialHolders.filter((id) => !row.holders.includes(id));
  const starter = turnStarter(prompts.filter((prompt) => prompt.minutesAgo > 0), row.holders);
  // A bot holding the handle: it prompts over MCP, proposes phase moves and environment approvals a person accepts.
  const botHolder = row.holders.find((id) => principalOf(id).kind === 'bot');
  // Rina's prompt started the turn on her credential; it ran out mid-turn, so the rotation stuck with Maya's.
  const payer = payerOf(row.holders, row.id === 'slot-holds' ? 'maya' : starter);
  const requests = row.requests.filter((request) => !done.has(request.id));
  const workspacePrompts = prompts.length ? prompts : [{ id: `${row.id}-p`, workspaceId: row.id, from: row.holders[0] ?? 'maya', minutesAgo: 130, text: `${row.workspace.goal.title}. Work in \`${row.branch}\`; keep the tests green.` }];
  const [first, ...later] = workspacePrompts;
  const earlier = later.filter((prompt) => prompt.minutesAgo > 0);
  const fresh = later.filter((prompt) => prompt.minutesAgo === 0);
  const tool = (id: string, command: string, at: number, ok: boolean): TranscriptItem => ({ id: `${row.id}-${id}`, type: 'tool-call', toolCallId: `${row.id}-call-${id}`, tool: 'bash', status: ok ? 'done' : 'error', target: command, args: { command }, startedAt: minutesAgo(at), endedAt: minutesAgo(at - 1),
    result: [{ id: `${row.id}-${id}-r`, type: 'code', language: 'text', text: ok ? ' Tests  22 passed (22)' : 'Machine profile iOS v2 #7c2e1b4 · setup on ec2-fleet failed\nxcodebuild -downloadPlatform iOS: the iOS 18 simulator runtime didn’t install\nexit 1' }] });
  const said: TranscriptItem = { id: `${row.id}-said`, type: 'message', role: 'assistant', at: minutesAgo(15), text: ask && (ask.kind === 'question' || ask.kind === 'plan') ? ask.said : row.workspace.preview };
  const askItem: TranscriptItem | null = ask && (ask.kind === 'question' || ask.kind === 'plan') && !done.has(ask.id) && !held.has(ask.id)
    ? { id: `${ask.id}-ask`, type: 'ask', toolCallId: `${ask.id}-call`, status: 'pending', kind: ask.kind === 'plan' ? 'plan' : undefined, questions: [{ id: ask.id, prompt: ask.prompt, options: ask.options.map((option) => ({ id: option.id, title: option.title })) }] } : null;
  const answer = async (answers: readonly { selectedOptions: readonly string[] }[]): Promise<void> => {
    if (!ask || (ask.kind !== 'question' && ask.kind !== 'plan')) return;
    if (!row.mine) { api.say(`The agent asked ${names(row.holders)} · only a holder answers; leave a note instead`); return; }
    const picked = answers[0]?.selectedOptions[0];
    const option = ask.options.find((candidate) => candidate.id === picked);
    onAnswer(ask.id, ask.kind === 'plan' ? (picked === 'approve' ? `Plan approved by ${api.viewer.first} · moves to Code` : 'Plan rejected') : `${api.viewer.first} answered · ${option?.title ?? picked ?? ''}`);
  };
  const holderNames = row.holders.length ? names(row.holders.filter((id) => id !== me)) : '';
  const placeholder = row.mine ? `Prompt as ${api.viewer.first}${holderNames ? ` · ${holderNames} also ${row.holders.length > 2 ? 'hold' : 'holds'} it` : ''}…` : `Leave a note for ${row.holders.length ? names(row.holders) : 'whoever claims it'}…`;
  // The composer floats over the transcript, as in the app: the transcript ends, and scrolls a card into view, that
  // far above the bottom (`--composer-overlay-height`, measured whenever the composer or its notes change size).
  const pane = useRef<HTMLDivElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = overlay.current;
    const host = pane.current;
    if (!element || !host) return;
    const measure = (): void => host.style.setProperty('--composer-overlay-height', `${element.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div data-workspace-panel className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <SidebarInsetTopbar className="pr-3">
      <nav aria-label="Location" className={`flex items-center gap-2 overflow-hidden text-body ${board ? 'min-w-[140px] flex-1' : 'flex-[1_0_auto]'}`}>
        <span className="flex items-center gap-1.5 text-muted-foreground"><GitBranch01 width={14} height={14} strokeWidth={1.5} /><span className="max-w-48 truncate">{project?.name}</span><span>/</span><span className="max-w-64 truncate font-semibold text-foreground">{row.name}</span></span>
        <StatusBadge color={row.color} label={row.color === 'orange' && row.state !== 'needs-you' ? `Waiting on ${row.holders.length ? names(row.holders) : 'a Lead'}` : workspaceStatusLabel(row.summary)} />
        {row.workspace.pulls.length ? <PrChips pulls={row.workspace.pulls} full /> : null}
      </nav>
      <div data-holder-chips="" className="flex shrink-0 items-center gap-1">
        {row.holders.length ? row.holders.map((id) => <Tooltip key={id} content={principalOf(id).kind === 'bot' ? `${actorLabel(id)} holds the handle · acts over MCP with its own project role (${projectRoleOf(id, row.workspace.projectId)?.name ?? '—'} in ${project?.name ?? ''}) · team resources only` : `${principalOf(id).name} holds the handle · their resources are attached`} side="bottom">
          <span data-holder={id} className={`inline-flex h-7 items-center gap-1.5 rounded-full pl-0.5 text-[11.5px] font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)] ${board ? 'pr-0.5' : 'pr-2.5'}`}><Avatar userId={id} size={22} />{board ? null : id === me ? 'You' : principalOf(id).kind === 'bot' ? actorLabel(id) : principalOf(id).first}</span>
        </Tooltip>) : <span className="inline-flex h-7 items-center rounded-full px-2.5 text-[11.5px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] [border-style:dashed]">Free · no holder</span>}
        {row.mine && requests.length ? <Tooltip content={`${names(requests.map((request) => request.from))} asked for the handle`} side="bottom">
          <a href="#handle-requests" className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium text-white" style={{ background: badgeColors.orange }}>{requests.length} {requests.length === 1 ? 'request' : 'requests'}</a>
        </Tooltip> : null}
        <HandleActions row={row} full />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <DropdownTrigger render={<button type="button" aria-label="Workspace phase" className="inline-flex h-7 items-center gap-1 rounded-[8px] px-2 text-caption text-foreground hover:bg-hover">{PHASE_LABEL[row.phase]}<ChevronDown width={14} height={14} className="text-muted-foreground" /></button>} />
          <DropdownContent className="w-[260px]" align="center" sideOffset={4} checkedIndex={PHASES.indexOf(row.phase)}>
            <DropdownLabel>Phase · your role and the stack decide</DropdownLabel>
            <PhaseMenuItems phase={{ current: row.phase, refusal: (next) => why(me, row.workspace.projectId, `phase.${next}`) ?? phaseRefusal(rows.map(rule), rule(row), next), onSet: onMovePhase }} from={0} />
          </DropdownContent>
        </DropdownMenu>
        <EnvironmentPopover workspaceId={row.id} holders={row.holders} viewer={me} sticky={payer.userId ?? ''} left={left} defaultOpen={new URLSearchParams(window.location.search).get('env') === 'open'} />
      </div>
      <div className="sticky right-0 z-10 flex shrink-0 items-center gap-1 bg-background">
        <Tooltip content={`Ask a ghost about ${row.name} · reads, changes nothing`} side="bottom">
          <button type="button" aria-label="Ask a ghost" onClick={onAskGhost} className="ghost-ask inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium transition-colors"><GhostGlyph size={14} /><span>Ghost</span></button>
        </Tooltip>
        <Tooltip content={`Chatter · what everyone in ${project?.name ?? ''} is saying`} side="bottom">
          <button type="button" aria-label="Chatter, 3 unread" onClick={() => api.say('Chatter opens over the workspace')}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-background px-2.5 text-[11.5px] font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-hover">
            <MessageChatCircle width={14} height={14} strokeWidth={1.75} />
            <span aria-hidden className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white" style={{ background: badgeColors.blue }}>3</span>
          </button>
        </Tooltip>
        {board ? null : <>
          <Tooltip content="Terminals" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Open terminals" onClick={() => api.say('Terminals are not part of the mock')}><Terminal width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
          <Tooltip content="Inspector" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Open Inspector" onClick={() => api.say('The Inspector is not part of the mock')}><LayoutRight width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
        </>}
        {board ? <>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <Tooltip content="Expand · the board folds back to the list (B)" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Expand" onClick={onExpand}><Expand06 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
          <Tooltip content="Close · back to the whole board (Esc)" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Close workspace" onClick={onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
        </> : null}
      </div>
    </SidebarInsetTopbar>
    <div ref={pane} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full scroll-pb-[calc(var(--composer-overlay-height,0px)+1rem)]">
        <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-5 px-6 pb-[calc(var(--composer-overlay-height,0px)+1.5rem)] pt-6">
          {first ? <LabelledPrompt prompt={first} viewer={me} /> : null}
          <TranscriptItemView item={{ id: `${row.id}-read`, type: 'tool-call', toolCallId: `${row.id}-call-read`, tool: 'read', status: 'done', target: 'src/', args: { path: 'src/' }, startedAt: minutesAgo(120), endedAt: minutesAgo(119) }} active={false} onAnswer={answer} />
          {botHolder ? <HandleEvent userId={botHolder} text={`${actorLabel(botHolder)} claimed the handle over MCP and moved ${row.name} into Code · 11:00`} /> : null}
          {earlier.map((prompt) => <LabelledPrompt key={prompt.id} prompt={prompt} viewer={me} />)}
          <TranscriptItemView item={tool('test', 'pnpm test', 20, row.color !== 'red')} active={false} onAnswer={answer} />
          <CommitsCard workspaceId={row.id} />
          <div className="flex flex-col gap-1">
            <TranscriptItemView item={said} active={false} onAnswer={answer} />
            <span data-paid-by="" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Turn started by {actorLabel(row.id === 'slot-holds' ? 'rina' : starter)} · {payerLine(row.id === 'slot-holds' ? payerOf(initialHolders, 'maya') : payer)}{row.id === 'slot-holds' ? ' mid-turn' : ''}{principalOf(starter).kind === 'bot' && payer.userId === null ? ` · ${principalOf(starter).first} has no Anthropic key of its own, so the team’s pays` : ''}
            </span>
          </div>
          {askItem ? <div className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted-foreground">Asked {row.holders.length ? names(row.holders) : 'the project’s Leads'} · in {row.holders.length > 1 ? 'their' : 'the'} Inbox{row.mine ? '' : ' · only a holder answers'}</span>
            <TranscriptItemView item={askItem} active={false} onAnswer={answer} />
          </div> : null}
          {heldAsk && heldEntry ? <ResolvedRow label={heldEntry.label} about="sends when the Undo runs out" secondsLeft={Math.max(1, Math.ceil((UNDO_MS - (now - heldEntry.at)) / 1000))} onUndo={() => onUndo(heldAsk.id)} /> : null}
          {row.answered ? <p className="flex items-center gap-2 text-caption text-muted-foreground"><span className="status-dot" data-pulse="" style={{ color: '#22c55e' }} />Working on the answer…</p> : null}
          {row.id === 'slot-holds' || row.id === 'offline-drafts' ? <PhaseProposal row={row} to="review" onAccept={() => onMovePhase('review')} /> : row.phase === 'review' && !botHolder ? <div data-review-state="" className="flex flex-col gap-1"><p className="flex items-center gap-1.5 text-caption text-muted-foreground"><ClipboardCheck width={13} height={13} strokeWidth={1.75} />In Review</p>{reviewGate(row).line}</div> : null}
          <ScriptTranscript workspaceId={row.id} />
          <AutofillEvents workspaceId={row.id} />
          {botHolder ? <PhaseProposal row={row} to="review" onAccept={() => onMovePhase('review')} /> : null}
          {joined.map((id) => <HandleEvent key={`j-${id}`} userId={id} text={`${actorLabel(id)} now holds the handle · their resources joined`} />)}
          {left.map((id) => <HandleEvent key={`l-${id}`} userId={id} text={principalOf(id).kind === 'bot' ? `${actorLabel(id)} no longer holds it` : `${principalOf(id).first} let go · their machine detached, processes keep running; their cleared shells closed and secrets held only while holding dropped`} />)}
          {fresh.map((prompt) => <LabelledPrompt key={prompt.id} prompt={prompt} viewer={me} />)}
          {requests.length ? <section id="handle-requests" data-handle-requests="" className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-3.5 py-3" style={{ boxShadow: `inset 3px 0 0 color-mix(in oklab, ${badgeColors.orange} 70%, transparent)` }}>
            {row.mine ? requests.map((request) => <HandleRequestRow key={request.id} request={request} held={held} now={now} actions={{ resolve: () => undefined, undo: onUndo, open: () => undefined, say: api.say, approveAll: () => undefined, askWhy: () => undefined }} />)
              : requests.map((request) => <p key={request.id} className="flex items-center gap-1.5 text-caption text-muted-foreground"><Avatar userId={request.from} size={16} />{request.from === me ? 'You asked' : `${userOf(request.from).first} asked`} {names(row.holders)} for the handle · waiting on them</p>)}
          </section> : null}
        </div>
      </ScrollArea>
      <div ref={overlay} data-composer-overlay className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-6 pb-4">
        <div className="pointer-events-none flex w-full max-w-5xl items-end justify-center gap-3 [&>*]:pointer-events-auto">
          <div className="flex w-full max-w-xl flex-col gap-1.5">
            {row.mine ? null : <p data-no-handle="" className="mx-auto flex items-center gap-1.5 rounded-full bg-background/95 px-3 py-1 text-[11.5px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
              {row.holders.length ? `${row.holders.map((id) => principalOf(id).kind === 'bot' ? actorLabel(id) : principalOf(id).first).join(' and ')} ${row.holders.length > 1 ? 'hold' : 'holds'} the handle · you can comment, leave notes, post in Chatter or ask a ghost` : 'Free · claim it to prompt; notes wait for whoever claims it'}
            </p>}
            <InputMessage data-slot="input-message" value={draft} onValueChange={setDraft} placeholder={placeholder}
              onSend={() => { if (!draft.trim()) return; if (row.mine) onPrompt(draft.trim()); else onNote(draft.trim()); setDraft(''); }}
              leftSlot={() => row.mine ? <>
                <Button variant="ghost" size="icon-compact" type="button" aria-label="Attach files"><Attachment01 width={16} height={16} strokeWidth={1.5} /></Button>
                <Tooltip content={payerLine(payer)} side="top"><Button variant="ghost" size="compact" type="button" aria-label="Model"><CpuChip01 width={14} height={14} strokeWidth={1.5} />sonnet-4.5 · {payer.userId ? `${userOf(payer.userId).first}’s` : 'team'}</Button></Tooltip>
              </> : <span className="inline-flex items-center gap-1 px-1.5 text-[11.5px] text-muted-foreground"><StickerSquare width={13} height={13} strokeWidth={1.75} />Note</span>}
              rightSlot={<Button variant="ghost" size="icon-compact" type="button" aria-label="More agent controls"><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
          </div>
          {notes.length || !row.mine ? <div className="hidden w-72 shrink-0 xl:block"><NotesPanel notes={notes} row={row} actions={noteActions} /></div> : null}
        </div>
      </div>
      {notes.length || !row.mine ? <div className="pointer-events-auto absolute right-4 top-3 z-20 w-72 xl:hidden"><NotesPanel notes={notes} row={row} actions={noteActions} /></div> : null}
    </div>
  </div>;
}
