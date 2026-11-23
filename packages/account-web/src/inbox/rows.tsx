// The Inbox's rows as the board's Needs you column draws them (docs/INBOX-DESIGN.md §2): inside a workspace's card its
// questions and plans (answered in place), problems and approval waits; heading the column the account's own rows, the
// approvals one per content hash with Approve all declared, and the open issue topics. An acted-on row stays one line
// high with Undo for six seconds; its call goes when that ends (held.ts).
import { useEffect, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { AskUserQuestions, Badge, badgeColors, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, Tooltip, type AskUserAnswer } from '@gitspace/ui';
import { AlertCircle, ArrowUpRight, Check, ClipboardCheck, Clock, Flag01, GitBranch01, Hourglass03, MessageQuestionCircle, PauseCircle, Server01, TerminalSquare } from '@untitledui/icons';
import type { WaitingItem } from '@gitspace/protocol-workspace';
import type { ChatterTopicAction } from '@gitspace/protocol/chatter-contract';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { StorageInspection } from '../StorageIncidents.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { actOnTopic, answerLifecycle, pauseObject, resumeObject, retryProblem, runLog, sendAnswer, setMachineDismissed, startMachine, useInboxSources, type AnswerValue } from './data.js';
import { UNDO_MS, useHeldActions, type HeldActions } from './held.js';
import { accountItems, approvalGroups, entrySince, issueItems, workspaceItems, type AccountItem, type ApprovalEntry, type ApprovalGroup, type InboxSources, type IssueItem, type Scope, type WorkspaceItem } from './model.js';

/** Opens a workspace beside the board. */
export type OpenWorkspace = (projectId: string, workspaceId: string) => void;

type Glyph = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string; style?: CSSProperties }>;

/** Re-renders every second while a row is held, so its Undo counts down. */
function useNow(held: HeldActions, keys: readonly string[]): number {
  const [now, setNow] = useState(() => Date.now());
  const counting = keys.some(key => held.state(key)?.kind === 'held');
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [counting]);
  return now;
}

/** Names the directory knows: projects (with their base branch) and workspaces. */
function names(sources: InboxSources) {
  const projects = new Map((sources.directory?.projects ?? []).map(project => [project.id, project]));
  const workspaces = new Map((sources.directory?.workspaces ?? []).map(workspace => [workspace.id, workspace.name]));
  return { project: (id: string | null) => id === null ? 'Account' : projects.get(id)?.name ?? id, branch: (id: string) => projects.get(id)?.baseBranch ?? 'the base branch', workspace: (id: string) => workspaces.get(id) ?? id };
}

export function waitedFor(since: string | null, now: number): string | null {
  if (since === null) return null;
  const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** The kind's mark: a tinted circle with its glyph. */
function KindMark({ icon: Icon, tone, size = 'default' }: { icon: Glyph; tone: string; size?: 'default' | 'small' }) {
  return <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-full ${size === 'small' ? 'size-5' : 'size-6'}`} style={{ color: tone, background: `color-mix(in oklab, ${tone} 14%, transparent)` }}>
    <Icon width={size === 'small' ? 12 : 13} height={size === 'small' ? 12 : 13} strokeWidth={1.75} />
  </span>;
}

function Waited({ since, now, agent }: { since: string | null; now: number; agent: boolean }) {
  const waited = waitedFor(since, now);
  return <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
    <Clock width={11} height={11} strokeWidth={1.75} className="shrink-0" style={agent ? { color: badgeColors.orange } : undefined} />
    {agent ? waited === null ? 'agent waiting' : `agent waiting ${waited}` : waited === null ? 'open' : `since ${waited}`}
  </span>;
}

/** A cleared row, one line high for six seconds so its action can be taken back. */
function ResolvedRow({ label, about, secondsLeft, onUndo }: { label: string; about: string; secondsLeft: number; onUndo(): void }) {
  return <div className="flex min-h-9 items-center gap-3 rounded-xl px-1 py-1.5 text-[13px]" data-resolved="">
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full" style={{ color: badgeColors.green, background: `color-mix(in oklab, ${badgeColors.green} 14%, transparent)` }}><Check width={13} height={13} strokeWidth={2} /></span>
    <span className="min-w-0 flex-1 truncate"><span className="font-medium text-foreground">{label}</span><span className="text-muted-foreground"> · {about}</span></span>
    <Button variant="ghost" size="compact" onClick={onUndo}>Undo <span className="tabular-nums text-muted-foreground">{secondsLeft}s</span></Button>
  </div>;
}

/** A row's place in the tab: cleared with Undo while held, gone once sent, the row with why while its call failed. */
function Held({ rowKey, held, now, children }: { rowKey: string; held: HeldActions; now: number; children: ReactNode }) {
  const state = held.state(rowKey);
  if (state?.kind === 'sent') return null;
  if (state?.kind === 'held') return <ResolvedRow label={state.action.label} about={state.action.about} secondsLeft={Math.max(1, Math.ceil((UNDO_MS - (now - state.action.at)) / 1000))} onUndo={() => held.undo(rowKey)} />;
  return <>
    {children}
    {state?.kind === 'failed' ? <p role="alert" className="text-caption text-destructive">{state.error}</p> : null}
  </>;
}

const PLAN_OPTIONS = [{ id: 'approve', title: 'Approve · moves to Code' }, { id: 'reject', title: 'Reject' }];

/** An agent's question or plan, answered in place: the chat's own option rows, an optional note, and Send. The answer
 * and the note go as one message to the asking conversation, after the Undo window (decision 4a). */
function QuestionRow({ entry, said, about, held, now }: { entry: WorkspaceItem & { item: Extract<WaitingItem, { kind: 'ask' | 'plan' }> }; said: string | null; about: string; held: HeldActions; now: number }) {
  const { item } = entry;
  const [answers, setAnswers] = useState<Record<string, AskUserAnswer>>({});
  const [note, setNote] = useState('');
  const plan = item.kind === 'plan';
  const options = plan ? PLAN_OPTIONS : item.choices.map(choice => ({ id: choice, title: choice }));
  const picked = answers[item.key]?.selectedIds ?? [];
  const written = note.trim();
  // An ask without choices is answered by what is written.
  const ready = options.length ? picked.length > 0 : written.length > 0;
  const send = (): void => {
    if (!ready) return;
    const approved = picked[0] === 'approve';
    const answer: AnswerValue = plan ? { approved, note: written || null } : [{ id: item.key, selectedOptions: picked, customInput: options.length ? null : written }];
    const text = plan || !options.length ? '' : written;
    const outcome = plan ? approved ? 'Plan approved · moves to Code' : 'Plan rejected' : options.length ? `Answered · ${picked.join(', ')}` : 'Answered';
    held.hold(entry.key, {
      label: written && options.length ? `${outcome} · “${written}”` : outcome, about,
      run: () => sendAnswer({ projectId: entry.projectId, workspaceId: entry.workspaceId, conversationId: item.conversation.id, questionId: item.key, answer, text }),
    });
  };
  return <div className="flex min-w-0 flex-col gap-2" data-item={entry.key}>
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <KindMark icon={plan ? ClipboardCheck : MessageQuestionCircle} tone={badgeColors.orange} size="small" />
      <span className="text-foreground">{plan ? 'Plan approval' : 'Question'}</span>
      {item.conversation.agent ? <span>· {item.conversation.agent}</span> : null}
      <Waited since={item.since} now={now} agent />
    </p>
    {said ? <p className="border-l-2 border-border pl-3 text-[12.5px] leading-relaxed text-muted-foreground">{said}</p> : null}
    {options.length ? <AskUserQuestions size="compact"
      questions={[{ id: item.key, title: item.title, options, allowOther: false, skippable: false, layout: 'inline' }]}
      answers={answers} onAnswersChange={setAnswers}
      renderTitle={(prompt) => <div className="text-[13.5px] [&_p]:my-0"><GitSpaceMarkdown>{prompt}</GitSpaceMarkdown></div>} />
      : <div className="text-[13.5px] [&_p]:my-0"><GitSpaceMarkdown>{item.title}</GitSpaceMarkdown></div>}
    {item.characters > item.title.length ? <p className="text-caption text-muted-foreground">The first {item.title.length} of {item.characters.toLocaleString('en-US')} characters · open the workspace for the rest</p> : null}
    <div className="flex items-center gap-2">
      <InputGroup size="compact" className="min-w-0 flex-1"><InputField label={options.length ? 'Note' : 'Answer'} labelHidden index={0} placeholder={options.length ? 'Add a note (optional)…' : 'Write your answer…'} value={note} onChange={setNote} onKeyDown={(event) => { if (event.key === 'Enter') send(); }} /></InputGroup>
      <Button variant="primary" size="compact" disabled={!ready} onClick={send}>Send</Button>
    </div>
  </div>;
}

const PROBLEM_TITLE: Record<'failed' | 'setup-failed' | 'conflict', string> = { failed: 'Agent stopped on an error', 'setup-failed': 'Setup script failed', conflict: 'Sync conflict' };

/** Something broken in the workspace: its error (a failed step's last log line), Retry, and its log or the workspace. */
function ProblemRow({ entry, about, held, now, onOpen }: { entry: WorkspaceItem & { item: Extract<WaitingItem, { kind: 'failed' | 'setup-failed' | 'conflict' }> }; about: string; held: HeldActions; now: number; onOpen: OpenWorkspace }) {
  const { item } = entry;
  const [log, setLog] = useState<{ state: 'loading' } | { state: 'ready'; text: string } | { state: 'error'; error: string } | null>(null);
  const openLog = (runId: string): void => {
    if (log) { setLog(null); return; }
    setLog({ state: 'loading' });
    runLog(entry.workspaceId, runId).then(text => setLog({ state: 'ready', text }), (cause: unknown) => setLog({ state: 'error', error: rpcErrorMessage(cause, 'Read the run log') }));
  };
  const detail = item.kind === 'setup-failed' ? `${item.title.split('\n')[0] ?? item.title} · ${item.phase} on ${item.machineId}` : item.kind === 'conflict' ? `${item.paths} conflicted ${item.paths === 1 ? 'path' : 'paths'}: ${item.title}` : item.title;
  return <div className="flex min-w-0 flex-col gap-1.5" data-item={entry.key}>
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <KindMark icon={item.kind === 'failed' ? AlertCircle : TerminalSquare} tone={badgeColors.red} size="small" />
      <span className="text-foreground">{PROBLEM_TITLE[item.kind]}</span>
      <Waited since={item.since} now={now} agent={false} />
    </p>
    <p className="text-[13px] leading-snug text-foreground/90 [overflow-wrap:anywhere]">{detail}</p>
    {item.kind === 'setup-failed' ? <pre className="overflow-x-auto whitespace-pre rounded-[10px] bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-destructive"><span className="select-none text-muted-foreground">last line │ </span>{item.lastLine}</pre> : null}
    {log?.state === 'ready' ? <pre aria-label="Run log" className="max-h-60 overflow-auto whitespace-pre-wrap rounded-[10px] bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">{log.text.split('\n').slice(-80).join('\n')}</pre> : null}
    {log?.state === 'error' ? <p role="alert" className="text-caption text-destructive">{log.error}</p> : null}
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      {item.kind === 'setup-failed' && item.runId !== null ? <Button variant="ghost" size="compact" loading={log?.state === 'loading'} onClick={() => openLog(item.runId ?? '')}>{log ? 'Hide log' : 'Open log'}</Button> : null}
      {item.kind === 'conflict' ? <Button variant="primary" size="compact" onClick={() => onOpen(entry.projectId, entry.workspaceId)}>Open</Button>
        : <Button variant="primary" size="compact" onClick={() => held.hold(entry.key, { label: item.kind === 'failed' ? 'Retrying the turn' : 'Retrying setup', about, run: () => retryProblem(entry.projectId, entry.workspaceId, item) })}>Retry</Button>}
    </div>
  </div>;
}

const CARD_KIND: Record<'approval' | 'takeover' | 'secure-input' | 'mcp-elicitation', string> = { approval: 'Permission', takeover: 'Take over the browser', 'secure-input': 'Secure input', 'mcp-elicitation': 'Plugin request' };

/** The rows inside a workspace's card: everything open in it, answered in place where the Inbox can. */
export function InboxRows({ projectId, workspaceId, onOpen }: { projectId: string; workspaceId: string; onOpen: OpenWorkspace }) {
  const sources = useInboxSources();
  const held = useHeldActions();
  const entries = workspaceItems(sources, new Set([projectId])).filter(entry => entry.workspaceId === workspaceId);
  const now = useNow(held, entries.map(entry => entry.key));
  const row = sources.rows.find(candidate => candidate.workspaceId === workspaceId);
  const more = row?.waiting?.more ?? 0;
  const groups = entries.some(entry => entry.item.kind === 'lifecycle-approval') ? approvalGroups(sources, new Set([projectId])) : [];
  if (!entries.some(entry => held.state(entry.key)?.kind !== 'sent')) return null;
  const about = names(sources).workspace(workspaceId);
  return <div className="flex flex-col gap-3 border-t border-border pt-3" data-inbox-rows={workspaceId}>
    {entries.map(entry => {
      const { item } = entry;
      switch (item.kind) {
        // The main agent's latest message is what it said before asking; a subagent's is not in the row.
        case 'ask': case 'plan': return <Held key={entry.key} rowKey={entry.key} held={held} now={now}><QuestionRow entry={{ ...entry, item }} said={item.conversation.agent === null ? row?.preview ?? null : null} about={about} held={held} now={now} /></Held>;
        case 'failed': case 'setup-failed': case 'conflict': return <Held key={entry.key} rowKey={entry.key} held={held} now={now}><ProblemRow entry={{ ...entry, item }} about={about} held={held} now={now} onOpen={onOpen} /></Held>;
        case 'lifecycle-approval': {
          const approval = groups.flatMap(group => group.entries).find(candidate => candidate.waiting.some(wait => wait.workspaceId === workspaceId && wait.questionId === item.key));
          const what = item.scripts.map(script => script.fileName ?? script.label).join(', ') || item.title;
          return <div key={entry.key} className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
            <KindMark icon={Hourglass03} tone={badgeColors.amber} size="small" />
            <span className="min-w-0 flex-1 truncate"><span className="text-foreground">Waits on {what}</span> · <Waited since={item.since} now={now} agent /></span>
            {approval ? <button type="button" onClick={() => document.querySelector(`[data-approval="${CSS.escape(approval.key)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })} className="shrink-0 font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:text-foreground">Approval ↓</button> : null}
          </div>;
        }
        case 'approval': case 'takeover': case 'secure-input': case 'mcp-elicitation': return <div key={entry.key} className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <KindMark icon={MessageQuestionCircle} tone={badgeColors.orange} size="small" />
          <span className="min-w-0 flex-1 truncate"><span className="text-foreground">{CARD_KIND[item.kind]}</span> · {item.title}</span>
          <Button variant="ghost" size="compact" className="shrink-0" onClick={() => onOpen(projectId, workspaceId)}>Answer in the workspace</Button>
        </div>;
      }
    })}
    {more ? <button type="button" onClick={() => onOpen(projectId, workspaceId)} className="self-start text-caption text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">and {more} more in this workspace · Open</button> : null}
  </div>;
}

/** A frame for the rows heading the column: rounded, bordered, the card surface. */
function ColumnCard({ children, tone, id }: { children: ReactNode; tone?: string; id?: string }) {
  return <section data-column-card={id} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card px-3 py-2.5" style={tone ? { boxShadow: `inset 3px 0 0 color-mix(in oklab, ${tone} 70%, transparent)` } : undefined}>{children}</section>;
}

/** The account's own rows: a machine offline (Start, Move workspace, Dismiss), an object the storage watchdog paused or
 * flagged (Inspect, Pause, Resume, Dismiss). */
function AccountRow({ item, held, now, onOpen }: { item: AccountItem; held: HeldActions; now: number; onOpen: OpenWorkspace }) {
  const sources = useInboxSources();
  const name = names(sources);
  const [inspecting, setInspecting] = useState(false);
  if (item.kind === 'machine') {
    const first = item.workspaces[0];
    const waiting = item.workspaces.map(workspace => name.workspace(workspace.workspaceId));
    return <ColumnCard tone={badgeColors.red}><Held rowKey={item.key} held={held} now={now}>
      <div className="flex min-w-0 items-start gap-2.5">
        <KindMark icon={Server01} tone={badgeColors.red} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline justify-between gap-2"><span className="truncate text-[13.5px] font-medium text-foreground">Machine {item.label} is {item.state === 'error' ? 'failing' : 'offline'}</span></span>
          <span className="text-[12px] leading-snug text-muted-foreground"><span className="text-foreground/80">Account · machines</span>{item.error ? ` · ${item.error}` : ''}{waiting.length ? ` · ${waiting.join(', ')} ${waiting.length === 1 ? 'runs on it and waits' : 'run on it and wait'}.` : ''}</span>
        </div>
      </div>
      <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
        <Button variant="ghost" size="compact" onClick={() => held.hold(item.key, { label: 'Dismissed · stays in Settings → Machines', about: item.label, run: async () => setMachineDismissed(item.machineId, true) })}>Dismiss</Button>
        {first ? <Button variant="secondary" size="compact" onClick={() => onOpen(first.projectId, first.workspaceId)}>Move workspace</Button> : null}
        <Button variant="primary" size="compact" onClick={() => held.hold(item.key, { label: `Starting ${item.label}`, about: 'Account', run: () => startMachine(item.machineId) })}>Start machine</Button>
      </div>
    </Held></ColumnCard>;
  }
  const { incident, paused, count, workspaceId, projectId } = item;
  // Which workspace or project the object is about; an object of the account itself, or one not found, by its class.
  const label = workspaceId !== null ? name.workspace(workspaceId) : projectId !== null ? name.project(projectId) : incident.className;
  return <ColumnCard tone={badgeColors.red}><Held rowKey={item.key} held={held} now={now}>
    <div className="flex min-w-0 items-start gap-2.5">
      <KindMark icon={PauseCircle} tone={badgeColors.red} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline justify-between gap-2"><span className="truncate text-[13.5px] font-medium text-foreground">{paused ? 'Paused' : 'Storage alert'}: {label}</span><Waited since={incident.at} now={now} agent={false} /></span>
        <span className="text-[12px] leading-snug text-muted-foreground"><span className="text-foreground/80">{projectId !== null ? `${name.project(projectId)} · watchdog` : 'Account · watchdog'}</span>{count > 1 ? ` · ${count} alerts, newest` : ''} · {incident.reason}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{incident.className} · {incident.objectId.slice(0, 12)}…</span>
      </div>
    </div>
    {inspecting ? <StorageInspection objectId={incident.objectId} label={label} /> : null}
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      {workspaceId !== null && projectId !== null ? <Button variant="ghost" size="compact" onClick={() => onOpen(projectId, workspaceId)}>Open</Button> : null}
      <Button variant="ghost" size="compact" aria-expanded={inspecting} onClick={() => setInspecting(open => !open)}>{inspecting ? 'Hide storage' : 'Inspect'}</Button>
      {paused ? null : <>
        <Button variant="ghost" size="compact" onClick={() => held.hold(item.key, { label: 'Dismissed · alerts snoozed 6 h', about: label, run: () => resumeObject(incident.objectId) })}>Dismiss</Button>
        <Button variant="secondary" size="compact" onClick={() => held.hold(item.key, { label: 'Paused', about: label, run: () => pauseObject(incident.objectId, `Paused from the Inbox after an alert: ${incident.reason}`) })}>Pause</Button>
      </>}
      {paused ? <Button variant="primary" size="compact" onClick={() => held.hold(item.key, { label: 'Resumed', about: label, run: () => resumeObject(incident.objectId) })}>Resume</Button> : null}
    </div>
  </Held></ColumnCard>;
}

/** Answers every question waiting on these approvals, once each. */
async function answerAll(projectId: string, entries: readonly ApprovalEntry[], answer: 'project' | 'not-now'): Promise<void> {
  const questions = new Map(entries.flatMap(entry => entry.waiting.map((wait): [string, ApprovalEntry['waiting'][number]] => [`${wait.workspaceId}:${wait.questionId}`, wait])));
  for (const wait of questions.values()) await answerLifecycle(projectId, wait.workspaceId, wait.questionId, answer);
}

function EntryRow({ entry, held, now }: { entry: ApprovalEntry; held: HeldActions; now: number }) {
  const sources = useInboxSources();
  const name = names(sources);
  const others = entry.declaredIn.filter(workspaceId => workspaceId !== entry.projectId).map(name.workspace);
  const base = entry.declaredIn.includes(entry.projectId);
  const where = [base ? `On ${name.branch(entry.projectId)}` : null, others.length ? `${base ? 'in' : 'In'} ${others.length} ${others.length === 1 ? 'workspace' : 'workspaces'}: ${others.join(', ')}` : null].filter(Boolean).join(' and ');
  const only = entry.waiting[0];
  const file = entry.fileName ?? entry.label;
  return <div className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-2.5 first:border-t-0 first:pt-0" data-approval={entry.key}><Held rowKey={entry.key} held={held} now={now}>
    <div className="flex min-w-0 items-start gap-2.5">
      <KindMark icon={TerminalSquare} tone={badgeColors.amber} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] font-medium" style={{ color: `color-mix(in oklab, ${badgeColors.amber} 70%, var(--foreground))` }}>Lifecycle script{entry.phase ? ` · ${entry.phase}` : ''}</span>
        <span className="flex min-w-0 items-baseline gap-1.5"><span className="truncate font-mono text-[12.5px] text-foreground">{file}</span><span className="shrink-0 font-mono text-[10.5px] text-muted-foreground" title="Content hash: one approval covers every place that declares it">#{entry.hash.replace(/^sha256:/u, '').slice(0, 7)}</span></span>
        {entry.fileName ? <span className="text-[12px] text-muted-foreground">{entry.label}</span> : null}
        <span className="inline-flex min-w-0 items-center gap-1 truncate text-[12px] text-muted-foreground" title={where}><GitBranch01 width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{where}</span></span>
        <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground"><Clock width={11} height={11} strokeWidth={1.75} className="shrink-0" style={{ color: badgeColors.orange }} />
          {entry.waiting.map(wait => `${name.workspace(wait.workspaceId)}’s agent waiting${waitedFor(wait.since, now) === null ? '' : ` ${waitedFor(wait.since, now)}`}`).join(' · ')}</span>
      </div>
    </div>
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      <Button variant="ghost" size="compact" onClick={() => held.hold(entry.key, { label: 'Not now · asks again on the next run', about: file, run: () => answerAll(entry.projectId, [entry], 'not-now') })}>Not now</Button>
      {only ? <Tooltip content={`Only ${name.workspace(only.workspaceId)}; the other workspaces keep asking`} side="top"><Button variant="secondary" size="compact" onClick={() => held.hold(entry.key, { label: `Approved for ${name.workspace(only.workspaceId)} only`, about: file, run: () => answerLifecycle(entry.projectId, only.workspaceId, only.questionId, 'workspace') })}>Only this workspace</Button></Tooltip> : null}
      <Button variant="primary" size="compact" onClick={() => held.hold(entry.key, { label: `Approved for ${name.project(entry.projectId)}`, about: file, run: () => answerAll(entry.projectId, [entry], 'project') })}>Approve for the project</Button>
    </div>
  </Held></div>;
}

/** One declaration place's approvals, one per content hash, with Approve all declared (after a confirmation) when it
 * holds more than one. */
function ApprovalGroupCard({ group, held, now }: { group: ApprovalGroup; held: HeldActions; now: number }) {
  const sources = useInboxSources();
  const name = names(sources);
  const [confirming, setConfirming] = useState(false);
  const entries = group.entries.filter(entry => held.state(entry.key)?.kind !== 'sent');
  if (!entries.length) return null;
  const pending = entries.filter(entry => !held.cleared(entry.key));
  const place = group.place.kind === 'base' ? `Declared on ${name.branch(group.projectId)}` : `Declared in ${name.workspace(group.place.workspaceId)}`;
  const approveAll = (): void => {
    setConfirming(false);
    // A card waiting on several of these is answered once, with the first of them.
    const answered = new Set<string>();
    for (const entry of pending) {
      const waiting = entry.waiting.filter(wait => !answered.has(`${wait.workspaceId}:${wait.questionId}`));
      for (const wait of waiting) answered.add(`${wait.workspaceId}:${wait.questionId}`);
      held.hold(entry.key, { label: `Approved for ${name.project(group.projectId)}`, about: entry.fileName ?? entry.label, run: () => answerAll(group.projectId, [{ ...entry, waiting }], 'project') });
    }
  };
  return <ColumnCard tone={badgeColors.amber} id={group.key}>
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{name.project(group.projectId)} · {place}</span>
      <span className="shrink-0 text-[12px] text-muted-foreground">· {pending.length} pending</span>
      <span className="h-px min-w-2 flex-1 bg-border" />
      {pending.length > 1 ? <Button variant="secondary" size="compact" className="shrink-0 whitespace-nowrap" onClick={() => setConfirming(true)}>Approve all declared</Button> : null}
    </div>
    {entries.map(entry => <EntryRow key={entry.key} entry={entry} held={held} now={now} />)}
    <Dialog open={confirming} onOpenChange={setConfirming}><DialogContent>
      <DialogHeader><DialogTitle>Approve {pending.length} for {name.project(group.projectId)}?</DialogTitle><DialogDescription>Each runs, or opens, in every {name.project(group.projectId)} workspace that declares it, now and later, until its content changes. Agents waiting on them continue at once.</DialogDescription></DialogHeader>
      <ul className="flex flex-col divide-y divide-border">{pending.map(entry => <li key={entry.key} className="flex min-w-0 flex-col gap-0.5 py-2">
        <span className="flex min-w-0 items-baseline gap-1.5"><span className="truncate text-[13.5px] font-medium text-foreground">{entry.fileName ?? entry.label}</span><span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{entry.hash.replace(/^sha256:/u, '').slice(0, 7)}</span></span>
        <span className="text-[12px] text-muted-foreground">Lifecycle script{entry.phase ? ` · ${entry.phase}` : ''} · {entry.declaredIn.map(name.workspace).join(', ')}</span>
      </li>)}</ul>
      <DialogFooter><Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button><Button variant="primary" onClick={approveAll}>Approve {pending.length} for {name.project(group.projectId)}</Button></DialogFooter>
    </DialogContent></Dialog>
  </ColumnCard>;
}

/** An open issue: listed, never counted. The chip names its project, or how many projects have it open; the line says
 * how many posts and repeats, from which workspaces. Open shows it in the workspace that posted last (a project picker
 * first when several projects have it); Resolve… takes the fixing commit (optional); Dismiss closes it, in every
 * project it is listed for. */
function IssueRow({ issue, held, now, onOpen }: { issue: IssueItem; held: HeldActions; now: number; onOpen: OpenWorkspace }) {
  const sources = useInboxSources();
  const name = names(sources);
  const [resolving, setResolving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [commit, setCommit] = useState('');
  const first = issue.places[0];
  const several = issue.places.length > 1;
  const act = (label: string, action: ChatterTopicAction): void => {
    held.hold(issue.key, { label, about: issue.display, run: async () => { for (const place of issue.places) await actOnTopic(place.projectId, issue.topicKey, action); } });
  };
  const resolve = (): void => {
    const fixedIn = commit.trim() || null;
    setResolving(false);
    act(fixedIn ? `Resolved in ${fixedIn}` : 'Resolved', { kind: 'state', state: 'resolved', fixedIn });
  };
  const open = (place: IssueItem['places'][number]): void => onOpen(place.projectId, place.workspaceId ?? place.projectId);
  const from = issue.workspaces.length === 0 ? '' : issue.workspaces.length <= 2 ? ` from ${issue.workspaces.map(name.workspace).join(' and ')}` : ` from ${issue.workspaces.length} workspaces`;
  return <ColumnCard><Held rowKey={issue.key} held={held} now={now}>
    <div className="flex min-w-0 items-start gap-2.5">
      <KindMark icon={Flag01} tone={issue.gitspace ? badgeColors.violet : badgeColors.blue} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-[13.5px] font-medium text-foreground" title={issue.display}>{issue.display}</span>
          <Badge size="compact" color={issue.gitspace ? 'violet' : 'blue'}>{several ? `${issue.places.length} projects` : name.project(first?.projectId ?? null)}</Badge></span>
        <span className="text-[12px] text-muted-foreground [overflow-wrap:anywhere]">{issue.posts} {issue.posts === 1 ? 'post' : 'posts'}{issue.repeats ? ` · ${issue.repeats} ${issue.repeats === 1 ? 'repeat' : 'repeats'}` : ''}{from}{several ? ` · in ${issue.places.map(place => name.project(place.projectId)).join(', ')}` : ''} · not counted{issue.marked ? ' · marked for filing' : ''}</span>
        <span className="-mx-1 flex min-w-0 items-center justify-end gap-1">
          <Button variant="ghost" size="compact" className="h-6 shrink-0 px-2" onClick={() => act('Dismissed', { kind: 'state', state: 'dismissed', fixedIn: null })}>Dismiss</Button>
          <Button variant="ghost" size="compact" className="h-6 shrink-0 px-2" aria-expanded={resolving} onClick={() => setResolving(value => !value)}>Resolve…</Button>
        </span>
      </div>
      <button type="button" aria-expanded={several ? picking : undefined} onClick={() => { if (several) setPicking(value => !value); else if (first) open(first); }} className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-[12px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground">Open<ArrowUpRight width={12} height={12} strokeWidth={2} /></button>
    </div>
    {picking ? <div role="group" aria-label="Open in project" className="flex flex-wrap items-center gap-1.5 pl-8">
      {issue.places.map(place => <Button key={place.projectId} variant="secondary" size="compact" onClick={() => { setPicking(false); open(place); }}>{name.project(place.projectId)} · {place.topic.posts + place.topic.repeats}</Button>)}
    </div> : null}
    {resolving ? <div className="flex items-center gap-2">
      <InputGroup size="compact" className="min-w-0 flex-1"><InputField label="Fixed in" labelHidden index={0} placeholder="Fixed in commit (optional)…" value={commit} onChange={setCommit} onKeyDown={(event) => { if (event.key === 'Enter') resolve(); }} /></InputGroup>
      <Button variant="primary" size="compact" onClick={resolve}>Resolve</Button>
    </div> : null}
  </Held></ColumnCard>;
}

/** The rows heading the Needs you column for the projects in `scope`: the account's, the approvals by declaration, the
 * open issue topics. Nothing when there are none. */
export function AccountRows({ scope, onOpen }: { scope: Scope; onOpen: OpenWorkspace }) {
  const sources = useInboxSources();
  const held = useHeldActions();
  const account = accountItems(sources, scope, Date.now());
  const [olderOpen, setOlderOpen] = useState(false);
  const groups = approvalGroups(sources, scope);
  const issues = issueItems(sources, scope);
  const keys = [...account.map(item => item.key), ...groups.flatMap(group => group.entries.map(entry => entry.key)), ...issues.map(issue => issue.key)];
  const now = useNow(held, keys);
  if (keys.every(key => held.state(key)?.kind === 'sent')) return null;
  return <div className="flex flex-col gap-2" data-inbox-account="">
    {account.filter(item => !item.stale).map(item => <AccountRow key={item.key} item={item} held={held} now={now} onOpen={onOpen} />)}
    {account.some(item => item.stale) ? <button type="button" aria-expanded={olderOpen} onClick={() => setOlderOpen(open => !open)} data-older-alerts=""
      className="flex min-h-8 items-center gap-2 rounded-xl border border-dashed border-border px-3 text-left text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground">
      <Clock width={12} height={12} strokeWidth={1.75} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">Older alerts · {account.filter(item => item.stale).length} · over 2 days, not counted</span>
      <span aria-hidden>{olderOpen ? '−' : '+'}</span>
    </button> : null}
    {olderOpen ? account.filter(item => item.stale).map(item => <AccountRow key={item.key} item={item} held={held} now={now} onOpen={onOpen} />) : null}
    {groups.map(group => ({ group, since: group.entries.map(entrySince).filter(since => since !== null).sort()[0] ?? '' })).sort((left, right) => left.since.localeCompare(right.since))
      .map(({ group }) => <ApprovalGroupCard key={group.key} group={group} held={held} now={now} />)}
    {issues.map(issue => <IssueRow key={issue.key} issue={issue} held={held} now={now} onOpen={onOpen} />)}
  </div>;
}
