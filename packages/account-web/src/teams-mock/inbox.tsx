// The Inbox's rows as the board's Needs you column draws them (docs/INBOX-DESIGN.md §2, the Inbox mock's items.tsx and
// more-rows.tsx): inside a workspace's card its asks, plans, problems, approval waits and mentions, answered in place;
// heading the column the account's own rows, the approvals one per content hash with Approve all declared, and the
// open issue topics. A cleared row stays one line high with Undo for six seconds.
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { GhostGlyph } from '../ghost/ghost-parts.js';
import { AskUserQuestions, Badge, badgeColors, Button, InputField, InputGroup, Tooltip, type AskUserAnswer } from '@gitspace/ui';
import {
  AlertCircle, ArrowUpRight, AtSign, ClipboardCheck, Clock, CpuChip02, Fingerprint01, Flag01, GitBranch01, Hourglass03, Key01, LayersThree01, MessageQuestionCircle, PauseCircle, Server01, ShieldTick, TerminalSquare, Zap,
} from '@untitledui/icons';
import { useState, type ComponentType, type ReactNode } from 'react';
import { bots, findPrincipal, notices, PROJECTS, userOf, WORKSPACES, waitedFor, type AccountItem, type ApprovalEntry, type ApprovalGroup, type CardItem, type HandleRequest, type IssueTopic, type Notice, type ProblemItem, type QuestionItem } from './data.js';
import { ResolvedRow } from './parts.js';
import { Avatar } from './people.js';
import { sponsorRequests } from './flows/bots-data.js';
import { secrets } from './flows/team-data.js';
import { approveProposal, declineProposal, envRevisions, proposalsOf, proposalStale, ProposalDialog } from './flows/env-page.js';
import { ProfileProposalFlow, profileProposals, type ProfileProposal } from './flows/profiles.js';
import { ScriptNeedsYouRow } from './flows/scripts.js';
import { recordAudit } from './settings/data.js';
import { passkeyLabel, usePasskey } from './settings/passkey.js';
import { projectRoleOf } from './settings/roles.js';
import { useMock, useViewer } from './viewer.js';

export const UNDO_MS = 6_000;

/** What a row can do: hold its outcome for Undo, take it back, open its workspace, say something, ask to approve a
 * whole declaration group. */
export interface InboxActions {
  resolve(id: string, label: string, about: string): void;
  undo(id: string): void;
  open(workspaceId: string): void;
  say(text: string): void;
  approveAll(groupId: string): void;
  askWhy(workspaceId: string): void;
}

/** Rows held for Undo, by id, with what they say and when they were cleared. */
export type Held = ReadonlyMap<string, { label: string; at: number; about: string }>;

type Glyph = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;

/** The kind's mark: a tinted circle with its glyph (the Inbox mock's `KindIcon`). */
function KindMark({ icon: Icon, tone, size = 'default' }: { icon: Glyph; tone: string; size?: 'default' | 'small' }) {
  return <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-full ${size === 'small' ? 'size-5' : 'size-6'}`} style={{ color: tone, background: `color-mix(in oklab, ${tone} 14%, transparent)` }}>
    <Icon width={size === 'small' ? 12 : 13} height={size === 'small' ? 12 : 13} strokeWidth={1.75} />
  </span>;
}

function Waited({ minutes, agent }: { minutes: number; agent: boolean }) {
  return <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
    <Clock width={11} height={11} strokeWidth={1.75} className="shrink-0" style={agent ? { color: badgeColors.orange } : undefined} />
    {agent ? `agent waiting ${waitedFor(minutes)}` : `since ${waitedFor(minutes)}`}
  </span>;
}

function HeldRow({ id, held, now, actions }: { id: string; held: Held; now: number; actions: InboxActions }) {
  const entry = held.get(id);
  if (!entry) return null;
  return <ResolvedRow label={entry.label} about={entry.about} secondsLeft={Math.max(1, Math.ceil((UNDO_MS - (now - entry.at)) / 1000))} onUndo={() => actions.undo(id)} />;
}

/** An agent's question or plan, answered in place: the agent's last words, the chat's own option rows, an optional
 * note, and Send (decision 4a: one message with the answer and the note). */
function QuestionRow({ item, actions }: { item: QuestionItem; actions: InboxActions }) {
  const [answers, setAnswers] = useState<Record<string, AskUserAnswer>>({});
  const [note, setNote] = useState('');
  const picked = answers[item.id]?.selectedIds[0];
  const option = item.options.find((candidate) => candidate.id === picked);
  const plan = item.kind === 'plan';
  const send = (): void => {
    if (!option) return;
    const label = plan ? (option.id === 'approve' ? 'Plan approved · moves to Code' : 'Plan rejected') : `Answered · ${option.title.replace(/ · recommended$/u, '')}`;
    actions.resolve(item.id, note.trim() ? `${label} · “${note.trim()}”` : label, item.workspaceId);
  };
  return <div className="flex min-w-0 flex-col gap-2" data-item={item.id}>
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <KindMark icon={plan ? ClipboardCheck : MessageQuestionCircle} tone={badgeColors.orange} size="small" />
      <span className="text-foreground">{plan ? 'Plan approval' : 'Question'}</span>
      <Waited minutes={item.since} agent />
      <Tooltip content="Ask a ghost why it asked · reads the conversation up to the question" side="top">
        <button type="button" onClick={() => actions.askWhy(item.workspaceId)} className="ghost-ask ml-auto inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium"><GhostGlyph size={12} />Why?</button>
      </Tooltip>
    </p>
    <p className="border-l-2 border-border pl-3 text-[12.5px] leading-relaxed text-muted-foreground">{item.said}</p>
    <AskUserQuestions size="compact"
      questions={[{ id: item.id, title: item.prompt, options: item.options.map((candidate) => ({ id: candidate.id, title: candidate.title })), allowOther: false, skippable: false, layout: 'inline' }]}
      answers={answers} onAnswersChange={setAnswers}
      renderTitle={(prompt) => <div className="text-[13.5px] [&_p]:my-0"><GitSpaceMarkdown>{prompt}</GitSpaceMarkdown></div>} />
    <div className="flex items-center gap-2">
      <InputGroup size="compact" className="min-w-0 flex-1"><InputField label="Note" labelHidden index={0} placeholder="Add a note (optional)…" value={note} onChange={setNote} onKeyDown={(event) => { if (event.key === 'Enter') send(); }} /></InputGroup>
      <Button variant="primary" size="compact" disabled={!option} onClick={send}>Send</Button>
    </div>
  </div>;
}

function ProblemRow({ item, actions }: { item: ProblemItem; actions: InboxActions }) {
  return <div className="flex min-w-0 flex-col gap-1.5" data-item={item.id}>
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <KindMark icon={TerminalSquare} tone={badgeColors.red} size="small" />
      <span className="text-foreground">{item.title}</span>
      <Waited minutes={item.since} agent={false} />
    </p>
    <p className="text-[13px] leading-snug text-foreground/90">{item.detail}</p>
    {item.log ? <pre className="overflow-x-auto whitespace-pre rounded-[10px] bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-destructive"><span className="select-none text-muted-foreground">last line │ </span>{item.log}</pre> : null}
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      <Button variant="ghost" size="compact" onClick={() => actions.say(`${item.secondary} · ${item.workspaceId}`)}>{item.secondary}</Button>
      <Button variant="primary" size="compact" onClick={() => actions.resolve(item.id, item.action.done, item.workspaceId)}>{item.action.label}</Button>
    </div>
  </div>;
}

/** Someone asks the viewer (a holder) for the handle: add them beside the holders, hand it over, or decline. Nothing
 * changes until a holder answers. */
export function HandleRequestRow({ request, held, now, actions }: { request: HandleRequest; held: Held; now: number; actions: InboxActions }) {
  const api = useMock();
  if (held.has(request.id)) return <HeldRow id={request.id} held={held} now={now} actions={actions} />;
  const from = userOf(request.from);
  const projectId = WORKSPACES.find((workspace) => workspace.id === request.workspaceId)?.projectId ?? '';
  return <div data-request={request.id} className="flex min-w-0 flex-col gap-1.5">
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <Avatar userId={from.id} size={20} />
      <span className="text-foreground"><span className="font-medium">{from.first}</span> asks for the handle</span>
      <span>· {projectRoleOf(from.id, projectId)?.name ?? from.accountRole}</span>
      <span className="inline-flex items-center gap-1"><Clock width={11} height={11} strokeWidth={1.75} />{request.since ? `since ${waitedFor(request.since)}` : 'just now'}</span>
    </p>
    {request.note ? <p className="border-l-2 border-border pl-3 text-[12.5px] leading-relaxed text-muted-foreground">“{request.note}”</p> : null}
    <p className="text-[11.5px] text-muted-foreground">While {from.first} holds it, their machines, browser, connections and model credentials join the workspace.</p>
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      <Button variant="ghost" size="compact" onClick={() => api.declineRequest(request.id)}>Decline</Button>
      <Tooltip content={`You let go; ${from.first} holds it with anyone else holding it`} side="top"><Button variant="secondary" size="compact" onClick={() => api.acceptRequest(request.id, 'hand-over')}>Hand over</Button></Tooltip>
      <Button variant="primary" size="compact" onClick={() => api.acceptRequest(request.id, 'add')}>Add {from.first}</Button>
    </div>
  </div>;
}

/** The rows inside a workspace's card in the Needs you column. */
export function CardItems({ items, held, now, actions, onShowApproval }: { items: readonly CardItem[]; held: Held; now: number; actions: InboxActions; onShowApproval(id: string): void }) {
  if (!items.length) return null;
  return <div className="flex flex-col gap-3 border-t border-border pt-3">
    {items.map((item) => {
      if (held.has(item.id)) return <HeldRow key={item.id} id={item.id} held={held} now={now} actions={actions} />;
      switch (item.kind) {
        case 'question':
        case 'plan': return <QuestionRow key={item.id} item={item} actions={actions} />;
        case 'problem': return <ProblemRow key={item.id} item={item} actions={actions} />;
        case 'approval-wait': return <div key={item.id} className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <KindMark icon={Hourglass03} tone={badgeColors.amber} size="small" />
          <span className="min-w-0 flex-1 truncate"><span className="text-foreground">{item.title}</span> · agent waiting {waitedFor(item.since)}</span>
          <button type="button" onClick={() => onShowApproval(item.approval)} className="shrink-0 font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:text-foreground">Approval ↓</button>
        </div>;
        case 'mention': return <div key={item.id} className="flex min-w-0 flex-col gap-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
            <KindMark icon={AtSign} tone={badgeColors.blue} size="small" />
            <span className="text-foreground">{item.title}</span><span>· {item.posts} posts · not counted</span>
          </p>
          <p className="pl-7 text-[12.5px] text-muted-foreground">{item.excerpt}</p>
          <div className="-mx-1 flex justify-end gap-1.5">
            <Button variant="ghost" size="compact" onClick={() => actions.say(`Opens Chatter at “${item.topic}”`)}>Open in Chatter</Button>
            <Button variant="secondary" size="compact" onClick={() => actions.resolve(item.id, 'Replied in Chatter', item.workspaceId)}>Reply</Button>
          </div>
        </div>;
      }
    })}
  </div>;
}

/** A frame for the rows heading the column: rounded, bordered, the card surface. */
export function ColumnCard({ children, tone, id }: { children: ReactNode; tone?: string; id?: string }) {
  return <section data-column-card={id} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card px-3 py-2.5" style={tone ? { boxShadow: `inset 3px 0 0 color-mix(in oklab, ${tone} 70%, transparent)` } : undefined}>{children}</section>;
}

/** Something that happened to one of the viewer's things: a note dismissed, a connection revoked by an Owner or Admin.
 * Listed, never counted; Got it clears it. */
export function NoticeRow({ notice }: { notice: Notice }) {
  return <ColumnCard tone={badgeColors.gray} id={notice.id}>
    <div className="flex min-w-0 items-start gap-2.5" data-notice-row={notice.id}>
      <Avatar userId={notice.from} size={22} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline justify-between gap-2"><span className="text-[13.5px] font-medium text-foreground">{notice.text}</span><span className="shrink-0 text-[12px] text-muted-foreground">{notice.at}</span></span>
        <span className="text-[12px] leading-snug text-muted-foreground">{notice.detail} · not counted</span>
      </div>
      <Button variant="ghost" size="compact" onClick={() => notices.set(notices.get().filter((entry) => entry.id !== notice.id))}>Got it</Button>
    </div>
  </ColumnCard>;
}

/** The account's own rows: a machine offline, a failed automation run (to Owners, Admins, the project's Leads and
 * whoever enabled it), an environment proposal (to the project's Leads), a blocked bot (to Owners and Admins, when
 * it's blocked and a week before its sign-ins expire), a bot's request to use one of its own secrets whose rule waits
 * for its sponsor (to the sponsor: Deny, or Approve with their passkey for that turn only; once the rule stops waiting
 * for them, Dismiss), a paused object (the watchdog's
 * Inspect, Pause, Resume, Dismiss), a script waiting for the viewer's approval (Review opens its approval card). */
export function AccountRow({ item, held, now, actions }: { item: AccountItem; held: Held; now: number; actions: InboxActions }) {
  const { navigate } = useMock();
  const viewer = useViewer();
  const passkey = usePasskey();
  const revisions = envRevisions.use();
  const [confirming, setConfirming] = useState(false);
  const proposals = profileProposals.use();
  const [profileDecision, setProfileDecision] = useState<{ decision: 'approve' | 'decline'; proposal: ProfileProposal } | null>(null);
  if (held.has(item.id)) return <ColumnCard><HeldRow id={item.id} held={held} now={now} actions={actions} /></ColumnCard>;
  if (item.kind === 'script') return <ScriptNeedsYouRow item={item} resolve={(label) => actions.resolve(item.id, label, item.script ?? '')} open={actions.open} />;
  const machine = item.kind === 'machine';
  const automation = item.kind === 'automation';
  const environment = item.kind === 'environment';
  const profileProposal = item.kind === 'profile-proposal' ? proposals.find((entry) => entry.id === item.proposal) : undefined;
  const bot = item.kind === 'bot';
  const botSecret = item.kind === 'bot-secret';
  const project = PROJECTS.find((candidate) => candidate.id === item.projectId)?.name;
  const tone = environment || item.kind === 'profile-proposal' ? badgeColors.blue : bot || botSecret ? badgeColors.amber : badgeColors.red;
  const name = item.secret?.split(':')[1] ?? '';
  const request = botSecret && item.secret ? sponsorRequests.get()[item.secret] : undefined;
  const botName = botSecret && item.bot ? bots.get().find((entry) => entry.id === item.bot)?.name ?? item.bot : '';
  const decide = (approved: boolean): void => {
    if (!item.secret || !request) return;
    const key = item.secret;
    sponsorRequests.set(Object.fromEntries(Object.entries(sponsorRequests.get()).filter(([candidate]) => candidate !== key)));
    if (approved) secrets.set(secrets.get().map((entry) => `${entry.scope}:${entry.name}` === key ? { ...entry, lastUsed: `just now · ${request.workspace} · approved by ${viewer.first}` } : entry));
    recordAudit({ actor: viewer.id, kind: 'approval', project: item.projectId ?? undefined, text: approved ? `Approved ${botName}’s use of its secret ${name} in ${request.workspace} (${request.why}) · that turn only · confirmed with ${passkeyLabel(viewer.id)}` : `Denied ${botName}’s use of its secret ${name} in ${request.workspace}` });
    actions.resolve(item.id, approved ? `Approved with your passkey · ${name} goes to ${request.workspace}’s approved script for this turn only` : `Denied · ${botName}’s turn is told; the step that needed it fails`, botName);
  };
  const proposal = environment && item.projectId ? proposalsOf(revisions[item.projectId] ?? [])[0] : undefined;
  const proposer = proposal ? findPrincipal(proposal.by)?.first ?? proposal.by : '';
  const decideProposal = (approved: boolean): void => {
    if (proposal && item.projectId && approved && proposalStale(item.projectId, proposal.n)) { setConfirming(true); return; }
    if (!proposal || !item.projectId) return;
    const n = approved ? approveProposal(item.projectId, proposal.n, viewer.id) : proposal.n;
    if (!approved) declineProposal(item.projectId, proposal.n);
    recordAudit({ actor: viewer.id, kind: 'approval', project: item.projectId, text: approved ? `Approved revision ${n} of ${project}’s environment (${proposal.summary})` : `Declined proposed revision ${n} of ${project}’s environment from Needs you` });
    actions.resolve(item.id, approved ? `Approved · revision ${n} is current; agents read it from their next turn` : `Declined · ${proposer} is told`, `${project} instructions`);
  };
  return <ColumnCard tone={tone}>
    <div className="flex min-w-0 items-start gap-2.5" data-account-item={item.id}>
      <KindMark icon={machine ? Server01 : automation ? Zap : environment ? TerminalSquare : item.kind === 'profile-proposal' ? LayersThree01 : bot ? CpuChip02 : botSecret ? Key01 : PauseCircle} tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline justify-between gap-2"><span className="truncate text-[13.5px] font-medium text-foreground">{item.title}</span><Waited minutes={item.since} agent={false} /></span>
        <span className="text-[12px] leading-snug text-muted-foreground"><span className="text-foreground/80">{machine ? 'Account · machines' : automation ? `${project} · automation` : environment ? `${project} · environment` : item.kind === 'profile-proposal' ? 'Account · machine profiles' : bot ? 'Account · bots' : botSecret ? `${project} · ${botName}’s secret · you sponsor it` : `${project} · watchdog`}</span> · {botSecret && !request ? `Its rule no longer waits for you: ${name} was released under the new rule.` : item.detail}</span>
        {item.signals.length ? <span className="truncate font-mono text-[11px] text-muted-foreground">{item.signals.join(' · ')}</span> : null}
      </div>
    </div>
    {botSecret && passkey.waiting ? <span role="status" data-passkey-waiting="" className="inline-flex items-center gap-1.5 text-[12px] text-foreground"><Fingerprint01 width={14} height={14} strokeWidth={1.75} />Confirm with {passkeyLabel(viewer.id)}…</span> : null}
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      {machine ? <>
        <Button variant="ghost" size="compact" onClick={() => actions.resolve(item.id, 'Dismissed · stays on Machines', 'ledger-cloud-2')}>Dismiss</Button>
        <Button variant="secondary" size="compact" onClick={() => actions.say('Move bank-feed-sync to a cloud machine')}>Move workspace</Button>
        <Button variant="primary" size="compact" onClick={() => actions.resolve(item.id, 'Starting ledger-cloud-2', 'Account')}>Start machine</Button>
      </> : automation ? <>
        <Button variant="ghost" size="compact" onClick={() => actions.say('Opens run #214’s log')}>Open log</Button>
        <Button variant="secondary" size="compact" onClick={() => navigate('project-settings', { project: item.projectId ?? 'ledger', page: 'automations' })}>Automation settings</Button>
        <Button variant="primary" size="compact" onClick={() => actions.resolve(item.id, 'Run again on a team cloud machine', 'Morning bank-feed import')}>Run again</Button>
      </> : environment ? <>
        <Button variant="ghost" size="compact" onClick={() => navigate('project-settings', { project: item.projectId ?? 'crumb', page: 'environment' })}>Review</Button>
        <Button variant="secondary" size="compact" disabled={!proposal} onClick={() => decideProposal(false)}>Decline</Button>
        <Button variant="primary" size="compact" disabled={!proposal} onClick={() => decideProposal(true)}>Approve</Button>
        {confirming && proposal && item.projectId ? <ProposalDialog project={item.projectId} n={proposal.n} decision="approve" onClose={() => {
          setConfirming(false);
          if (!proposalsOf(envRevisions.get()[item.projectId ?? ''] ?? []).some((entry) => entry.n === proposal.n)) actions.resolve(item.id, `Approved · re-applied to the current revision; agents read it from their next turn`, `${project} instructions`);
        }} /> : null}
      </> : item.kind === 'profile-proposal' ? <>
        <Button variant="ghost" size="compact" onClick={() => navigate('settings', { page: 'machine-profiles' })}>Review</Button>
        <Button variant="secondary" size="compact" disabled={!profileProposal} onClick={() => { if (profileProposal) setProfileDecision({ decision: 'decline', proposal: profileProposal }); }}>Decline</Button>
        <Button variant="primary" size="compact" disabled={!profileProposal} onClick={() => { if (profileProposal) setProfileDecision({ decision: 'approve', proposal: profileProposal }); }}>Approve with passkey</Button>
        {profileDecision ? <ProfileProposalFlow proposal={profileDecision.proposal} decision={profileDecision.decision} onClose={() => {
          const { decision, proposal: decided } = profileDecision;
          setProfileDecision(null);
          if (!profileProposals.get().some((entry) => entry.id === decided.id)) actions.resolve(item.id, decision === 'approve' ? `Approved with your passkey · ${decided.name} has a new version, approved for team machines` : `Declined · ${userOf(decided.by).first} is told`, `${decided.name} profile`);
        }} /> : null}
      </> : bot ? <>
        <Button variant="ghost" size="compact" onClick={() => navigate('settings', { page: 'bots', person: 'triage-bot' })}>Open bot</Button>
        <Button variant="primary" size="compact" onClick={() => {
          bots.set(bots.get().map((entry) => entry.id === 'triage-bot' ? { ...entry, sponsor: viewer.id, formerSponsor: null, lapse: null, expires: null } : entry));
          actions.resolve(item.id, `Taken over · sponsored by ${viewer.first}; its sign-in works again`, 'Support triage bot');
        }}>Take it over</Button>
      </> : botSecret ? <>
        <Button variant="ghost" size="compact" disabled={passkey.waiting} onClick={() => navigate('settings', { page: 'my-secrets', person: item.bot ?? 'release-bot' })}>Open its secrets</Button>
        {request ? <>
          <Button variant="secondary" size="compact" disabled={passkey.waiting} onClick={() => decide(false)}>Deny</Button>
          <Button variant="primary" size="compact" loading={passkey.waiting} disabled={passkey.waiting} onClick={() => passkey.confirm(() => decide(true))}>Approve with passkey</Button>
        </> : <Button variant="secondary" size="compact" onClick={() => actions.resolve(item.id, 'Dismissed', botName)}>Dismiss</Button>}
      </> : <>
        <Button variant="ghost" size="compact" onClick={() => actions.say('Opens the object’s storage report')}>Inspect</Button>
        <Button variant="ghost" size="compact" onClick={() => actions.resolve(item.id, 'Dismissed · alerts snoozed 6 h', 'Crumb Chatter')}>Dismiss</Button>
        <Button variant="secondary" size="compact" onClick={() => actions.say('Already paused')}>Pause</Button>
        <Button variant="primary" size="compact" onClick={() => actions.resolve(item.id, 'Resumed', 'Crumb Chatter')}>Resume</Button>
      </>}
    </div>
  </ColumnCard>;
}

function EntryRow({ entry, held, now, actions }: { entry: ApprovalEntry; held: Held; now: number; actions: InboxActions }) {
  if (held.has(entry.id)) return <HeldRow id={entry.id} held={held} now={now} actions={actions} />;
  const project = PROJECTS.find((candidate) => candidate.id === entry.projectId)?.name ?? '';
  const where = [entry.declared.base ? `On ${entry.declared.base}` : null, entry.declared.workspaces.length ? `${entry.declared.base ? 'in' : 'In'} ${entry.declared.workspaces.length} ${entry.declared.workspaces.length === 1 ? 'workspace' : 'workspaces'}: ${entry.declared.workspaces.join(', ')}` : null].filter(Boolean).join(' and ');
  const browser = entry.kindLabel.startsWith('Browser');
  const only = entry.waitingIn[0]?.workspaceId;
  return <div className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-2.5 first:border-t-0 first:pt-0" data-approval={entry.id}>
    <div className="flex min-w-0 items-start gap-2.5">
      <KindMark icon={browser ? GitBranch01 : entry.kindLabel.startsWith('Signed') ? ShieldTick : TerminalSquare} tone={badgeColors.amber} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] font-medium" style={{ color: `color-mix(in oklab, ${badgeColors.amber} 70%, var(--foreground))` }}>{entry.kindLabel}</span>
        <span className="flex min-w-0 items-baseline gap-1.5"><span className="truncate font-mono text-[12.5px] text-foreground">{entry.file}</span><span className="shrink-0 font-mono text-[10.5px] text-muted-foreground" title="Content hash: one approval covers every place that declares it">#{entry.hash}</span></span>
        <span className="text-[12px] text-muted-foreground">{entry.detail}</span>
        <span className="inline-flex min-w-0 items-center gap-1 truncate text-[12px] text-muted-foreground" title={where}><GitBranch01 width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{where}</span></span>
        <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground"><Clock width={11} height={11} strokeWidth={1.75} className="shrink-0" style={entry.waitingIn.length ? { color: badgeColors.orange } : undefined} />
          {entry.waitingIn.length ? entry.waitingIn.map((waiting) => `${waiting.workspaceId}’s agent waiting ${waitedFor(waiting.since)}`).join(' · ') : 'No agent waiting'}</span>
      </div>
    </div>
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      <Button variant="ghost" size="compact" onClick={() => actions.resolve(entry.id, 'Not now · asks again on the next run', entry.file)}>Not now</Button>
      {only ? <Tooltip content={`Only ${only}; the other workspaces keep asking`} side="top"><Button variant="secondary" size="compact" onClick={() => actions.resolve(entry.id, `Approved for ${only} only`, entry.file)}>Only this workspace</Button></Tooltip> : null}
      <Button variant="primary" size="compact" onClick={() => actions.resolve(entry.id, `Approved for ${project}`, entry.file)}>Approve for the project</Button>
    </div>
  </div>;
}

/** One declaration group: its approvals, one per content hash, with Approve all declared when it holds more than one. */
export function ApprovalGroupCard({ group, held, now, done, actions }: { group: ApprovalGroup; held: Held; now: number; done: ReadonlySet<string>; actions: InboxActions }) {
  const entries = group.entries.filter((entry) => !done.has(entry.id));
  if (!entries.length) return null;
  const pending = entries.filter((entry) => !held.has(entry.id));
  const project = PROJECTS.find((candidate) => candidate.id === group.projectId)?.name;
  return <ColumnCard tone={badgeColors.amber} id={group.id}>
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{project} · {group.label}</span>
      <span className="shrink-0 text-[12px] text-muted-foreground">· {pending.length} pending</span>
      <span className="h-px min-w-2 flex-1 bg-border" />
      {pending.length > 1 ? <Button variant="secondary" size="compact" className="shrink-0 whitespace-nowrap" onClick={() => actions.approveAll(group.id)}>Approve all declared</Button> : null}
    </div>
    {entries.map((entry) => <EntryRow key={entry.id} entry={entry} held={held} now={now} actions={actions} />)}
  </ColumnCard>;
}

/** An open Chatter issue topic: listed, never counted. */
export function IssueRow({ topic, held, now, actions }: { topic: IssueTopic; held: Held; now: number; actions: InboxActions }) {
  if (held.has(topic.id)) return <ColumnCard><HeldRow id={topic.id} held={held} now={now} actions={actions} /></ColumnCard>;
  const project = PROJECTS.find((candidate) => candidate.id === topic.projectId)?.name;
  const tone = topic.scope === 'gitspace' ? badgeColors.violet : badgeColors.blue;
  return <ColumnCard>
    <div className="flex min-w-0 items-start gap-2.5">
      <KindMark icon={Flag01} tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-[13.5px] font-medium text-foreground">{topic.title}</span>
          <Badge size="compact" color={topic.scope === 'gitspace' ? 'violet' : 'blue'}>{topic.scope === 'gitspace' ? 'GitSpace' : `${project} code`}</Badge></span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" title={topic.agent ? `project agent ${topic.agent}` : undefined}>{topic.posts} posts from {topic.workspaces} workspaces · not counted{topic.agent ? ` · ${topic.agent}` : ''}</span>
          <Button variant="ghost" size="compact" className="h-6 shrink-0 px-2" onClick={() => actions.resolve(topic.id, 'Dismissed', topic.title)}>Dismiss</Button>
          <Button variant="ghost" size="compact" className="h-6 shrink-0 px-2" onClick={() => actions.resolve(topic.id, topic.scope === 'gitspace' ? 'Filed with GitSpace' : 'Marked fixed', topic.title)}>{topic.scope === 'gitspace' ? 'File' : 'Mark fixed'}</Button>
        </span>
      </div>
      <button type="button" onClick={() => actions.say(`Opens Chatter at “${topic.title}”`)} className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-[12px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground">Open<ArrowUpRight width={12} height={12} strokeWidth={2} /></button>
    </div>
  </ColumnCard>;
}

/** The kind glyphs a compact card line uses outside the Inbox column. */
export function itemSummary(items: readonly CardItem[]): { text: string; icon: Glyph; tone: string } | null {
  const counted = items.filter((item) => item.kind !== 'mention');
  const first = counted[0];
  if (!first) return null;
  const tone = first.kind === 'problem' ? badgeColors.red : first.kind === 'approval-wait' ? badgeColors.amber : badgeColors.orange;
  const icon = first.kind === 'problem' ? AlertCircle : first.kind === 'approval-wait' ? Hourglass03 : first.kind === 'plan' ? ClipboardCheck : MessageQuestionCircle;
  return { text: counted.length > 1 ? `${first.title} · +${counted.length - 1}` : first.title, icon, tone };
}

export function workspaceName(id: string): string {
  return WORKSPACES.find((workspace) => workspace.id === id)?.name ?? id;
}
