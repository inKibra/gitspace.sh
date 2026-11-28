// Project › Environment's pieces and flows. The environment is saved as numbered revisions, each a whole snapshot of
// the Instructions ("How to work on this project": markdown agents read) and the machine profiles the project's work
// needs. A Lead's edit saves a revision; any other member whose role codes proposes one; agents propose from a
// workspace ("Set up with an agent" writes the Instructions and proposes the profile list) and importing the
// repository's AGENTS.md or .gitspace/instructions.md proposes too. A project's Leads approve or decline proposals here
// and in Needs you. Every revision has its diff and Roll back. The secrets the project uses show their rule (roles,
// while holding, delivery); rules are edited on the project's Secrets page.
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { Fragment, useState, type ReactNode } from 'react';
import { findPrincipal, PROJECTS, projectRoleIdOf, USERS, WORKSPACES } from '../data.js';
import { ENV_REVISIONS, MACHINES, PERSONAL_VALUES, PROFILES, PROJECT_REACH, projectName, projectSettings, recordAudit, REPO_INSTRUCTIONS, type EnvRevision, type SecretEntry } from '../settings/data.js';
import { projectRoleOf, why } from '../settings/roles.js';
import { createStore } from '../store.js';
import { useMock, useViewer } from '../viewer.js';
import { approvedScripts, machineProfiles, machineReadiness, projectProfiles, type MachineProfile, type Readiness } from './env-model.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, StepButtons, Summary, TextArea } from './kit.js';
import { DiffBlock, Labelled, leadsOf, listNames, machineChoices, machineOf, PickRows, reachOf, RefusedDialog } from './project.js';
import type { RuleTarget } from './secret-rules.js';
import { secrets } from './team-data.js';
import { valueStates } from './you-data.js';
import { GITHUB_CLASSIC_TOKEN } from './token-shapes.js';

// ── Revisions ──

/** Each project's revisions, saved and proposed, newest first. */
export const envRevisions = createStore<Readonly<Record<string, readonly EnvRevision[]>>>(ENV_REVISIONS);
/** Workspaces started by "Set up with an agent", per project. */
export interface SetupRun { workspace: string; branch: string; machine: string; by: string; proposed: number }
export const setupRuns = createStore<Readonly<Record<string, readonly SetupRun[]>>>({});

export function savedOf(revisions: readonly EnvRevision[]): readonly EnvRevision[] { return revisions.filter((revision) => !revision.proposal).slice().sort((a, b) => b.n - a.n); }
export function proposalsOf(revisions: readonly EnvRevision[]): readonly EnvRevision[] { return revisions.filter((revision) => revision.proposal).slice().sort((a, b) => a.n - b.n); }
function nextN(revisions: readonly EnvRevision[]): number { return Math.max(0, ...revisions.map((revision) => revision.n)) + 1; }

/** Adds a revision; a saved one also becomes the project's profile list. */
function addRevision(project: string, revision: EnvRevision): void {
  envRevisions.set({ ...envRevisions.get(), [project]: [revision, ...(envRevisions.get()[project] ?? [])] });
  if (!revision.proposal) projectProfiles.set({ ...projectProfiles.get(), [project]: revision.profiles });
}
/** The proposal's content applied to the current revision: the proposal itself when it was made against the current
 * one; otherwise its change (base → proposal) re-applied to the current revision. Null when that can't be done because
 * the current revision changed the lines the proposal edits. */
export function proposalOnCurrent(project: string, n: number): { proposal: EnvRevision; base: EnvRevision | undefined; current: EnvRevision | undefined; result: Pick<EnvRevision, 'instructions' | 'profiles'> | null } | null {
  const revisions = envRevisions.get()[project] ?? [];
  const proposal = revisions.find((entry) => entry.n === n && entry.proposal);
  if (!proposal?.proposal) return null;
  const saved = savedOf(revisions);
  const current = saved[0];
  const base = saved.find((entry) => entry.n === proposal.proposal?.base);
  if (!current || !base || base.n === current.n) return { proposal, base, current, result: proposal };
  return { proposal, base, current, result: rebase(base, proposal, current) };
}
/** True when a newer revision was saved after the proposal was made: approving it needs the re-diff confirm. */
export function proposalStale(project: string, n: number): boolean {
  const found = proposalOnCurrent(project, n);
  return found !== null && found.base?.n !== found.current?.n;
}
/** Approves proposal `n`: its content (re-applied to the current revision when a newer one was saved since) becomes
 * current, renumbered when a newer revision was saved since. Returns its number; a proposal whose change no longer
 * applies stays open. */
export function approveProposal(project: string, n: number, approver: string): number {
  const found = proposalOnCurrent(project, n);
  if (!found?.result) return n;
  const { result } = found;
  const revisions = envRevisions.get()[project] ?? [];
  const newest = savedOf(revisions)[0]?.n ?? 0;
  const number = n > newest ? n : nextN(revisions);
  envRevisions.set({ ...envRevisions.get(), [project]: revisions.map((entry) => entry.n === n ? { ...entry, n: number, instructions: result.instructions, profiles: result.profiles, proposal: null, when: `Approved just now by ${findPrincipal(approver)?.first ?? approver}` } : entry) });
  projectProfiles.set({ ...projectProfiles.get(), [project]: result.profiles });
  return number;
}
export function declineProposal(project: string, n: number): void {
  envRevisions.set({ ...envRevisions.get(), [project]: (envRevisions.get()[project] ?? []).filter((entry) => entry.n !== n || !entry.proposal) });
}

/** The full line diff (longest common subsequence): unchanged lines start with two spaces, removed with "- ", added
 * with "+ ". */
function diffLines(before: readonly string[], after: readonly string[]): readonly string[] {
  const table: number[][] = before.map(() => after.map(() => 0));
  const at = (i: number, j: number): number => (i < before.length && j < after.length ? table[i]?.[j] ?? 0 : 0);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      if (row) row[j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { lines.push(`  ${before[i]}`); i += 1; j += 1; }
    else if (j < after.length && (i >= before.length || at(i, j + 1) >= at(i + 1, j))) { lines.push(`+ ${after[j]}`); j += 1; }
    else { lines.push(`- ${before[i]}`); i += 1; }
  }
  return lines;
}
/** `diffLines`, with runs of unchanged lines further than one line from a change folded into "  …". */
export function lineDiff(before: readonly string[], after: readonly string[]): readonly string[] {
  const lines = diffLines(before, after);
  const changed = (index: number): boolean => !(lines[index] ?? '  ').startsWith('  ');
  const near = (index: number): boolean => changed(index) || changed(index - 1) || changed(index + 1);
  return lines.flatMap((line, index) => near(index) ? [line] : near(index - 1) ? ['  …'] : []);
}
/** Re-applies `proposal`'s change against `base` to `current`. Each run of changed lines is found in `current` by the
 * lines it removes (a pure addition by the unchanged line before it); the profiles it adds and removes apply to
 * `current`'s list. Null when a run's lines are no longer in `current`. */
function rebase(base: EnvRevision, proposal: EnvRevision, current: EnvRevision): Pick<EnvRevision, 'instructions' | 'profiles'> | null {
  const hunks: Array<{ anchor: string | null; removed: string[]; added: string[] }> = [];
  let anchor: string | null = null;
  let open: { anchor: string | null; removed: string[]; added: string[] } | null = null;
  for (const line of diffLines(base.instructions.split('\n'), proposal.instructions.split('\n'))) {
    const text = line.slice(2);
    if (line.startsWith('  ')) { open = null; anchor = text; continue; }
    if (!open) { open = { anchor, removed: [], added: [] }; hunks.push(open); }
    if (line.startsWith('- ')) open.removed.push(text); else open.added.push(text);
  }
  const lines = current.instructions.split('\n');
  let cursor = 0;
  for (const hunk of hunks) {
    let at = -1;
    if (hunk.removed.length) {
      for (let index = cursor; index + hunk.removed.length <= lines.length && at < 0; index += 1) if (hunk.removed.every((text, offset) => lines[index + offset] === text)) at = index;
    } else if (hunk.anchor === null) at = 0;
    else { const found = lines.indexOf(hunk.anchor, Math.max(0, cursor - 1)); at = found < 0 ? -1 : found + 1; }
    if (at < 0) return null;
    lines.splice(at, hunk.removed.length, ...hunk.added);
    cursor = at + hunk.added.length;
  }
  const added = proposal.profiles.filter((id) => !base.profiles.includes(id));
  const removed = base.profiles.filter((id) => !proposal.profiles.includes(id));
  return { instructions: lines.join('\n'), profiles: [...current.profiles.filter((id) => !removed.includes(id)), ...added.filter((id) => !current.profiles.includes(id))] };
}
export function profileName(id: string): string { return machineProfiles.get().find((profile) => profile.id === id)?.name ?? id; }
/** What `after` changes against `before`: the Instructions' lines, then the machine profiles added and removed. */
export function revisionDiff(before: Pick<EnvRevision, 'instructions' | 'profiles'> | undefined, after: Pick<EnvRevision, 'instructions' | 'profiles'>): readonly string[] {
  const text = before ? lineDiff(before.instructions.split('\n'), after.instructions.split('\n')) : after.instructions.split('\n').map((line) => `+ ${line}`);
  const profiles = [
    ...after.profiles.filter((id) => !before?.profiles.includes(id)).map((id) => `+ Machine profile: ${profileName(id)}`),
    ...(before?.profiles ?? []).filter((id) => !after.profiles.includes(id)).map((id) => `- Machine profile: ${profileName(id)}`),
  ];
  return text.some((line) => !line.startsWith('  ')) ? [...text, ...profiles] : profiles;
}
function changedLines(lines: readonly string[]): number { return lines.filter((line) => !line.startsWith('  ')).length; }

// ── Who may change it ──

/** A Lead edits (a revision); any other member of the project proposes; anyone else is refused, with why. */
export type EnvAccess = { mode: 'edit' } | { mode: 'propose' } | { mode: 'refused'; reason: string };
export function envAccess(userId: string, project: string): EnvAccess {
  const edit = why(userId, project, 'project.settings');
  if (!edit) return { mode: 'edit' };
  if (projectRoleIdOf(userId, project) !== null) return { mode: 'propose' };
  return { mode: 'refused', reason: `${edit}, nor propose changes: proposing needs a role in ${projectName(project)}` };
}
export function refusalOf(access: EnvAccess): string | null { return access.mode === 'refused' ? access.reason : null; }
/** People who may edit or propose, for a refusal's "Who can". */
function whoMayChange(project: string): string {
  const names = USERS.filter((user) => envAccess(user.id, project).mode !== 'refused').map((user) => `${user.first}${envAccess(user.id, project).mode === 'edit' ? ' (Lead)' : ''}`);
  return names.length ? names.join(', ') : 'nobody yet';
}
function leadNames(project: string): string { return listNames(leadsOf(project).map((id) => findPrincipal(id)?.first ?? id)); }

// ── Machine readiness ──

const PROJECT_MACHINE: Readonly<Record<string, string>> = { crumb: 'crumb-cloud-1', ledger: 'ledger-cloud-2', 'field-notes': 'crumb-cloud-1' };
/** The machine a workspace runs on: its own, or (on "cloud") its project's default team machine. */
export function workspaceMachine(workspaceId: string): string {
  const workspace = WORKSPACES.find((entry) => entry.id === workspaceId);
  if (!workspace) return '';
  return MACHINES.some((machine) => machine.id === workspace.machine) ? workspace.machine : PROJECT_MACHINE[workspace.projectId] ?? 'crumb-cloud-1';
}
export function readinessText(readiness: Readiness | undefined): string {
  if (!readiness) return 'not set up';
  switch (readiness.state) {
    case 'ready': return 'ready';
    case 'missing': return `${readiness.missing} missing`;
    case 'needs-approval': return `setup waits for approval (#${readiness.hash})`;
    case 'declined': return `declined by ${findPrincipal(readiness.by)?.first ?? readiness.by}: ${readiness.note}`;
    case 'running': return `setup running since ${readiness.started}`;
  }
}
/** "Web ready · iOS: iOS 18 simulator missing" for one machine and some profiles. */
export function readinessLine(machineId: string, profiles: readonly string[], readiness: Readonly<Record<string, Readonly<Record<string, Readiness>>>>): string {
  if (!profiles.length) return 'No machine profiles';
  return profiles.map((id) => { const state = readiness[machineId]?.[id]; return state?.state === 'ready' ? `${profileName(id)} ready` : `${profileName(id)}: ${readinessText(state)}`; }).join(' · ');
}
function readyCount(profileId: string, scope: 'account' | 'user', readiness: Readonly<Record<string, Readonly<Record<string, Readiness>>>>): { ready: number; total: number } {
  const machines = MACHINES.filter((machine) => machine.owner.scope === scope);
  return { ready: machines.filter((machine) => readiness[machine.id]?.[profileId]?.state === 'ready').length, total: machines.length };
}

// ── Pieces ──

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, index) => part.startsWith('`') && part.endsWith('`') && part.length > 1
    ? <code key={index} className="rounded bg-surface-2 px-1 font-mono text-[12px]">{part.slice(1, -1)}</code>
    : part.startsWith('**') && part.endsWith('**') ? <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong> : <Fragment key={index}>{part}</Fragment>);
}
/** The Instructions as agents and people read them: headings, bullets, paragraphs, `code` and **bold**. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = (key: number): void => { if (items.length) blocks.push(<ul key={`ul-${key}`} className="ml-4 list-disc space-y-0.5">{items.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>); items = []; };
  text.split('\n').forEach((line, index) => {
    if (line.startsWith('- ')) { items.push(line.slice(2)); return; }
    flush(index);
    if (line.startsWith('## ')) blocks.push(<h4 key={index} className="mt-2 text-body font-semibold text-foreground">{inline(line.slice(3))}</h4>);
    else if (line.startsWith('# ')) blocks.push(<h3 key={index} className="text-subtitle font-semibold text-foreground">{inline(line.slice(2))}</h3>);
    else if (line.trim()) blocks.push(<p key={index}>{inline(line)}</p>);
  });
  flush(-1);
  return <div data-markdown="" className="flex flex-col gap-1.5 text-body text-foreground [overflow-wrap:anywhere]">{blocks}</div>;
}

/** A profile's checks, readiness across team and personal machines. */
export function ProfileSummary({ profile }: { profile: MachineProfile }) {
  const readiness = machineReadiness.use();
  const team = readyCount(profile.id, 'account', readiness);
  const personal = readyCount(profile.id, 'user', readiness);
  const checks = profile.versions[0]?.checks ?? [];
  return <span className="flex flex-col gap-0.5">
    <span>Checks: {checks.map((check) => check.label).join(', ')}{profile.image ? ` · cloud image ${profile.image}` : ''}</span>
    <span className={team.ready ? 'text-muted-foreground' : 'text-[#B54708]'}>Ready on {team.ready} of {team.total} team machines · {personal.ready} of {personal.total} personal machines{profile.teamApproval ? '' : ' · team machines wait for an Admin to approve its setup'}</span>
  </span>;
}

// ── Flows ──

const SECRET_VALUE = new RegExp(`(sk_(live|test)_[A-Za-z0-9]{8,}|figd_[A-Za-z0-9_-]{8,}|${GITHUB_CLASSIC_TOKEN}[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|[a-z]+://[^\\s:/]+:[^\\s@]+@)`);
function instructionsError(text: string, current: string): string | null {
  if (!text.trim()) return 'Write the instructions: agents read them before every turn.';
  if (!text.trimStart().startsWith('# ')) return 'Start with a heading, like “# How to work on Crumb”.';
  const leaked = SECRET_VALUE.exec(text);
  if (leaked) return `Line ${text.slice(0, leaked.index).split('\n').length} looks like a secret value (${leaked[0].slice(0, 12)}…). Every member reads the instructions: name the secret (like DATABASE_URL) and let its rule deliver it.`;
  if (text.trim() === current.trim()) return 'Nothing changed yet.';
  return null;
}

export function EditInstructionsDialog({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const revisions = envRevisions.use()[project] ?? [];
  const current = savedOf(revisions)[0];
  const [step, setStep] = useState(0);
  const [text, setText] = useState(current?.instructions ?? '');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<number | null>(null);
  const access = envAccess(viewer.id, project);
  const name = projectName(project);
  if (access.mode === 'refused') return <RefusedDialog id="edit-instructions" title={`Edit ${name}’s instructions`} reason={access.reason} who={whoMayChange(project)} onClose={onClose} />;
  if (!current) return null;
  const propose = access.mode === 'propose';
  const n = nextN(revisions);
  const diff = revisionDiff(current, { instructions: text, profiles: current.profiles });
  const advance = (): void => {
    setError(null);
    if (step === 0) { const problem = instructionsError(text, current.instructions); if (problem) { setError(problem); return; } setStep(1); return; }
    if (step === 1) { if (!summary.trim()) { setError('Say what changed, in a line: it heads the revision history.'); return; } setStep(2); return; }
    addRevision(project, { n, by: viewer.id, when: propose ? 'Proposed just now' : 'Just now', summary: summary.trim(), instructions: text, profiles: current.profiles, proposal: propose ? { from: `${viewer.first}, ${projectRoleOf(viewer.id, project)?.name ?? 'member'} in ${name}`, base: current.n } : null });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: propose ? `Proposed revision ${n} of ${name}’s environment: ${summary.trim()}` : `Saved revision ${n} of ${name}’s environment: ${summary.trim()}` });
    say(propose ? `Proposed as revision ${n}; ${name}’s Leads see it in Needs you` : `Saved as revision ${n}`);
    setMade(n);
  };
  return <FlowDialog id="edit-instructions" title={`Edit ${name}’s instructions`} description={made !== null ? undefined : propose ? `You’re not a Lead here, so your change is a proposal: one of ${name}’s Leads (${leadNames(project)}) approves it before agents read it.` : `Agents in ${name} read these before every turn. Saving makes revision ${n}; revision ${current.n} stays in the history.`}
    steps={['Write', 'Preview', propose ? 'Propose' : 'Save']} step={step} done={made !== null} onClose={onClose}
    footer={made !== null ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={advance} nextLabel={step === 2 ? propose ? `Propose as revision ${n}` : `Save as revision ${n}` : 'Next'} />}>
    {made !== null ? <FlowSuccess title={propose ? `Proposed as revision ${made}` : `Revision ${made} is current`}>{propose ? `It’s above the history in Environment and in ${leadNames(project)}’s Needs you. Agents keep reading revision ${current.n} until a Lead approves.` : `Agents read it from their next turn. Recorded in the audit log under ${viewer.first}.`}</FlowSuccess>
      : step === 0 ? <>
        <TextArea label="How to work on this project (markdown)" value={text} onChange={(value) => { setText(value); setError(null); }} rows={16} mono error={error ?? undefined} />
        <Hint>How to run the app and the tests, where fixtures come from, which approved scripts to use, which machine profile. Name secrets; never paste their values.</Hint>
      </> : step === 1 ? <>
        <Labelled label="Preview"><div className="max-h-72 overflow-y-auto rounded-xl px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)]"><Markdown text={text} /></div></Labelled>
        <Labelled label={`Against revision ${current.n}`}><DiffBlock lines={diff} label="Instructions diff" /></Labelled>
        <InputGroup className="w-full"><InputField index={0} label="What changed" placeholder="e.g. Tests run with --pool=forks" value={summary} error={error ?? undefined} onChange={(value) => { setSummary(value); setError(null); }} /></InputGroup>
      </> : <Summary rows={[[propose ? 'Proposes' : 'Saves', `Revision ${n}: ${summary.trim()}`], ['Changes', `${changedLines(diff)} ${changedLines(diff) === 1 ? 'line' : 'lines'} of the Instructions; machine profiles unchanged`], ['Current', propose ? `Revision ${current.n} until a Lead approves` : `Revision ${current.n} → ${n}; Roll back can return to it`], ...(propose ? [['Who decides', `${name}’s Leads: ${leadNames(project)}`] as const] : [])]} />}
    {error && step === 2 ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

export function EditProfilesDialog({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const revisions = envRevisions.use()[project] ?? [];
  const profiles = machineProfiles.use();
  const readiness = machineReadiness.use();
  const current = savedOf(revisions)[0];
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(current?.profiles ?? []));
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<number | null>(null);
  const access = envAccess(viewer.id, project);
  const name = projectName(project);
  if (access.mode === 'refused') return <RefusedDialog id="edit-profiles" title={`Machine profiles ${name} needs`} reason={access.reason} who={whoMayChange(project)} onClose={onClose} />;
  if (!current) return null;
  const propose = access.mode === 'propose';
  const n = nextN(revisions);
  const list = profiles.filter((profile) => picked.has(profile.id)).map((profile) => profile.id);
  const added = list.filter((id) => !current.profiles.includes(id));
  const removed = current.profiles.filter((id) => !picked.has(id));
  const unready = added.filter((id) => readyCount(id, 'account', readiness).ready === 0);
  const summary = [...added.map((id) => `added ${profileName(id)}`), ...removed.map((id) => `removed ${profileName(id)}`)].join(', ');
  const advance = (): void => {
    setError(null);
    if (step === 0) {
      if (!picked.size) { setError(`${name}’s work needs at least one profile; Web is the usual base.`); return; }
      if (!added.length && !removed.length) { setError('Nothing changed yet: tick a profile to add, or untick one to remove.'); return; }
      setStep(1); return;
    }
    if (step === 1) { setStep(2); return; }
    addRevision(project, { n, by: viewer.id, when: propose ? 'Proposed just now' : 'Just now', summary: `Machine profiles: ${summary}`, instructions: current.instructions, profiles: list, proposal: propose ? { from: `${viewer.first}, ${projectRoleOf(viewer.id, project)?.name ?? 'member'} in ${name}`, base: current.n } : null });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `${propose ? 'Proposed' : 'Saved'} revision ${n} of ${name}’s environment: machine profiles ${summary}` });
    say(propose ? `Proposed as revision ${n}` : `Saved as revision ${n} · ${name} needs ${list.map(profileName).join(', ')}`);
    setMade(n);
  };
  return <FlowDialog id="edit-profiles" title={`Machine profiles ${name} needs`} description={made !== null ? undefined : `Placement prefers a machine that is ready for every profile here. A workspace or a task can add one for itself. ${propose ? `Your change is a proposal for ${name}’s Leads.` : `Saving makes revision ${n}.`}`}
    steps={['Profiles', 'Readiness', propose ? 'Propose' : 'Save']} step={step} done={made !== null} onClose={onClose}
    footer={made !== null ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={advance} nextLabel={step === 2 ? propose ? `Propose as revision ${n}` : `Save as revision ${n}` : 'Next'} />}>
    {made !== null ? <FlowSuccess title={propose ? `Proposed as revision ${made}` : `${name} needs ${list.map(profileName).join(', ')}`}>{propose ? `${leadNames(project)} see it in Needs you and above the history.` : `New workspaces are placed on machines ready for ${list.map(profileName).join(' and ')}; open ones keep their machine. Recorded in the audit log.`}</FlowSuccess>
      : step === 0 ? <>
        <PickRows label="Machine profiles" picked={picked} onChange={(next) => { setPicked(next); setError(null); }}
          rows={profiles.map((profile) => ({ id: profile.id, title: <span className="inline-flex flex-wrap items-center gap-2">{profile.name}{current.profiles.includes(profile.id) ? <span className="text-caption text-muted-foreground">needed now</span> : null}</span>, detail: <ProfileSummary profile={profile} />, disabled: null }))} />
        <Hint>The team’s library: Settings › Crumb & Co › Machine profiles. A new profile starts there.</Hint>
      </> : step === 1 ? <>
        <ul data-profile-readiness="" className="flex flex-col gap-1.5 text-caption">{MACHINES.filter((machine) => machine.owner.scope === 'account').map((machine) => <li key={machine.id} className="flex flex-col"><span className="font-medium text-foreground">{machine.label}</span><span className="text-muted-foreground">{readinessLine(machine.id, list, readiness)}</span></li>)}</ul>
        {unready.length ? <FlowError>No team machine is ready for {listNames(unready.map(profileName))}: {unready.map((id) => profiles.find((profile) => profile.id === id)?.teamApproval ? 'run its setup from Live › Machines' : 'an Admin approves its setup scripts in Machine profiles first').join('; ')}. Until then new workspaces wait for a ready personal machine.</FlowError> : <Hint>Every added profile is ready on at least one team machine.</Hint>}
      </> : <Summary rows={[[propose ? 'Proposes' : 'Saves', `Revision ${n}: ${summary}`], ['Profiles', list.map(profileName).join(', ')], ['Instructions', `Unchanged (revision ${current.n}’s)`], ...(propose ? [['Who decides', `${name}’s Leads: ${leadNames(project)}`] as const] : [])]} />}
    {error ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

export function RevisionDiffDialog({ project, n, onClose, onRollBack }: { project: string; n: number; onClose(): void; onRollBack?(): void }) {
  const revisions = envRevisions.use()[project] ?? [];
  const revision = revisions.find((entry) => entry.n === n);
  const saved = savedOf(revisions);
  const previous = saved.find((entry) => entry.n < n);
  const current = saved[0]?.n === n;
  if (!revision) return null;
  return <FlowDialog id="revision-diff" title={`Revision ${n}${current ? ' · current' : ''}`} description={`${revision.summary} · ${revision.when} by ${findPrincipal(revision.by)?.first ?? revision.by}`} onClose={onClose}
    footer={<>{onRollBack && !current ? <Button variant="secondary" onClick={onRollBack}>Roll back to revision {n}</Button> : null}<Button variant="primary" onClick={onClose}>Close</Button></>}>
    <Hint>{previous ? `Compared with revision ${previous.n} (${previous.summary}).` : 'The first revision: everything it wrote.'}</Hint>
    <DiffBlock lines={revisionDiff(previous, revision)} label={`Revision ${n} diff`} />
    <Labelled label="Machine profiles"><span className="text-body text-foreground">{revision.profiles.map(profileName).join(', ')}</span></Labelled>
  </FlowDialog>;
}

export function RollBackDialog({ project, n, onClose }: { project: string; n: number; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const revisions = envRevisions.use()[project] ?? [];
  const [made, setMade] = useState<number | null>(null);
  const saved = savedOf(revisions);
  const target = saved.find((entry) => entry.n === n);
  const current = saved[0];
  const name = projectName(project);
  const refused = why(viewer.id, project, 'project.settings');
  if (refused) return <RefusedDialog id="roll-back" title={`Roll ${name} back to revision ${n}?`} reason={refused} who={leadNames(project)} onClose={onClose} />;
  if (!target || !current) return null;
  const next = nextN(revisions);
  const pending = proposalsOf(revisions);
  const confirm = (): void => {
    addRevision(project, { n: next, by: viewer.id, when: 'Just now', summary: `Rolled back to revision ${n}`, instructions: target.instructions, profiles: target.profiles, proposal: null });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Rolled ${name}’s environment back to revision ${n} (as revision ${next})` });
    say(`Rolled back to revision ${n}: saved as revision ${next}`);
    setMade(next);
  };
  return <FlowDialog id="roll-back" title={`Roll ${name} back to revision ${n}?`} description={`${target.summary} · ${target.when} by ${findPrincipal(target.by)?.first ?? target.by}`} done={made !== null} onClose={onClose}
    footer={made !== null ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>Roll back as revision {next}</Button></>}>
    {made !== null ? <FlowSuccess title={`Revision ${made} is current: revision ${n}’s contents`}>Agents read these instructions from their next turn; new workspaces are placed for {target.profiles.map(profileName).join(' and ')}. Revisions after {n} stay in the history.</FlowSuccess> : <>
      <Labelled label={`What changes against revision ${current.n} (current)`}><DiffBlock lines={revisionDiff(current, target)} label="Roll back diff" /></Labelled>
      <Summary rows={[['Makes', `Revision ${next}, with revision ${n}’s contents; nothing is deleted`], ['Machine profiles', target.profiles.map(profileName).join(', ')], ...(pending.length ? [['Proposals', `${pending.map((entry) => `Revision ${entry.n}`).join(', ')} stay open; made against revision ${current.n}`] as const] : [])]} />
    </>}
  </FlowDialog>;
}

export function ProposalDialog({ project, n, decision, onClose }: { project: string; n: number; decision: 'approve' | 'decline'; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const revisions = envRevisions.use()[project] ?? [];
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [proposal] = useState(() => revisions.find((entry) => entry.n === n && entry.proposal));
  const name = projectName(project);
  const refused = why(viewer.id, project, 'project.settings');
  if (refused) return <RefusedDialog id={decision === 'approve' ? 'approve-proposal' : 'decline-proposal'} title={`${decision === 'approve' ? 'Approve' : 'Decline'} proposed revision ${n}?`} reason={refused} who={leadNames(project)} onClose={onClose} />;
  if (!proposal) return null;
  const current = savedOf(revisions)[0];
  const found = done === null ? proposalOnCurrent(project, n) : null;
  const base = found?.base;
  const stale = found !== null && base !== undefined && current !== undefined && base.n !== current.n;
  const result = found?.result ?? null;
  const proposer = findPrincipal(proposal.by)?.first ?? proposal.by;
  const confirm = (): void => {
    if (decision === 'decline' && !reason.trim()) { setError(`Say why, so ${proposer} knows what to change.`); return; }
    const number = decision === 'approve' ? approveProposal(project, n, viewer.id) : n;
    if (decision === 'decline') declineProposal(project, n);
    recordAudit({ actor: viewer.id, kind: 'approval', project, text: decision === 'approve' ? `Approved revision ${number} of ${name}’s environment (${proposal.summary})${stale ? `, made against revision ${base?.n} and re-applied to revision ${current?.n}` : ''}` : `Declined proposed revision ${n} of ${name}’s environment: ${reason.trim()}` });
    say(decision === 'approve' ? `Approved: revision ${number} is current` : `Declined revision ${n}`);
    setDone(number);
  };
  const blocked = decision === 'approve' && stale && result === null;
  return <FlowDialog id={decision === 'approve' ? 'approve-proposal' : 'decline-proposal'} title={`${decision === 'approve' ? 'Approve' : 'Decline'} proposed revision ${n}?`} description={`${proposal.summary} · from ${proposal.proposal?.from ?? proposer} · ${proposal.when}`} done={done !== null} onClose={onClose}
    footer={done !== null ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button>{blocked ? null : <Button variant="primary" onClick={confirm}>{decision === 'approve' ? stale ? `Approve against revision ${current?.n}` : 'Approve' : 'Decline'}</Button>}</>}>
    {done !== null ? <FlowSuccess title={decision === 'approve' ? `Revision ${done} is current in ${name}` : `Declined revision ${n}`}>{decision === 'approve' ? `Agents read the new instructions from their next turn. ${proposer} and the other Leads are told.` : `${proposer} gets your reason. Nothing changed in ${name}.`}</FlowSuccess> : stale && current && base ? <>
      <div data-stale-proposal="" className="rounded-xl bg-[color-mix(in_oklab,#f79009_10%,transparent)] px-3 py-2 text-caption text-foreground">Made against revision {base.n}. Revision {current.n} was saved since ({current.summary} · {current.when} by {findPrincipal(current.by)?.first ?? current.by}), so {decision === 'approve' ? 'approving re-applies its change to revision ' + current.n + ' instead of replacing it.' : 'its change is shown re-applied to revision ' + current.n + '.'}</div>
      <Labelled label={`Its change, against revision ${base.n}`}><DiffBlock lines={revisionDiff(base, proposal)} label={`Proposed revision ${n} against ${base.n}`} /></Labelled>
      {result ? <Labelled label={`Re-diffed against revision ${current.n} (current)`}><DiffBlock lines={revisionDiff(current, result)} label={`Proposed revision ${n} re-diffed`} /></Labelled>
        : <FlowError>Revision {current.n} changed the lines this proposal edits, so it no longer applies. Decline it and ask {proposer} to propose again against revision {current.n}.</FlowError>}
      {decision === 'approve' ? result ? <Hint>Approving makes it current with only these lines changed from revision {current.n}; nothing else in revision {current.n} is replaced. Revision {current.n} stays in the history.</Hint> : null
        : <TextArea label="Why (sent to the proposer)" value={reason} onChange={(value) => { setReason(value); setError(null); }} rows={3} error={error ?? undefined} placeholder="e.g. Please redo it against the current revision" />}
    </> : <>
      <Labelled label={`Against revision ${current?.n ?? '—'} (current)`}><DiffBlock lines={revisionDiff(current, proposal)} label={`Proposed revision ${n} diff`} /></Labelled>
      {decision === 'approve' ? <Hint>It replaces revision {current?.n} as current; revision {current?.n} stays in the history and Roll back can return to it.</Hint>
        : <TextArea label="Why (sent to the proposer)" value={reason} onChange={(value) => { setReason(value); setError(null); }} rows={3} error={error ?? undefined} placeholder="e.g. --pool=forks doubles CI time; try --pool=threads with isolate off" />}
    </>}
  </FlowDialog>;
}

const INSTRUCTION_FILES = ['AGENTS.md', '.gitspace/instructions.md', 'CLAUDE.md'] as const;

export function ImportInstructionsDialog({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const settings = projectSettings.use()[project];
  const revisions = envRevisions.use()[project] ?? [];
  const base = PROJECTS.find((entry) => entry.id === project)?.branch ?? 'main';
  const repositories = settings?.repositories ?? [];
  const files = REPO_INSTRUCTIONS[project] ?? {};
  const [step, setStep] = useState(0);
  const [repository, setRepository] = useState(repositories[0] ?? '');
  const [file, setFile] = useState<string>(Object.keys(files)[0] ?? INSTRUCTION_FILES[0]);
  const [branch, setBranch] = useState(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<number | null>(null);
  const access = envAccess(viewer.id, project);
  const name = projectName(project);
  if (access.mode === 'refused') return <RefusedDialog id="import-instructions" title="Import instructions from the repository" reason={access.reason} who={whoMayChange(project)} onClose={onClose} />;
  const current = savedOf(revisions)[0];
  if (!current) return null;
  const next = nextN(revisions);
  const text = files[file] ?? '';
  const diff = revisionDiff(current, { instructions: text, profiles: current.profiles });
  const already = proposalsOf(revisions).some((entry) => entry.instructions === text);
  const readError = (): string | null => {
    if (!/^[A-Za-z0-9._/-]+$/.test(branch.trim())) return 'Enter a branch name, like main.';
    if (reachOf(repository).state !== 'app') return `GitSpace reads files through the GitHub App, and ${repository} is reached only through team machines. Import from the project repository, or run Set up with an agent on a team machine to read it there.`;
    if (repository !== repositories[0]) return `${repository} has no ${file} on ${branch.trim()}. Instructions live in the project repository, ${repositories[0]}.`;
    if (![base, 'main'].includes(branch.trim())) return `${repository} has no branch “${branch.trim()}”. Its branches include ${[base, 'main'].filter((entry, index, all) => all.indexOf(entry) === index).join(' and ')}.`;
    if (!files[file]) return `${repository} has no ${file} on ${branch.trim()}. It has ${Object.keys(files).join(' and ') || 'no instruction file'}.`;
    return null;
  };
  const advance = (): void => {
    setError(null);
    if (step === 0) {
      setBusy(true);
      window.setTimeout(() => { setBusy(false); const problem = readError(); if (problem) setError(problem); else setStep(1); }, 900);
      return;
    }
    if (step === 1) { setStep(2); return; }
    addRevision(project, { n: next, by: viewer.id, when: 'Proposed just now', summary: `Imported from ${file}`, instructions: text, profiles: current.profiles, proposal: { from: `${repository.split('/').pop() ?? repository}/${file} on ${branch.trim()}, imported by ${viewer.first}`, base: current.n } });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Proposed revision ${next} of ${name}’s environment from ${repository}’s ${file}` });
    say(`Proposed as revision ${next}; the Leads see it in Needs you`);
    setMade(next);
  };
  const nothing = changedLines(diff) === 0 || already;
  return <FlowDialog id="import-instructions" title="Import instructions from the repository" description={`Reads an instruction file (AGENTS.md, .gitspace/instructions.md, CLAUDE.md), compares it with revision ${current.n}’s Instructions and proposes the difference. One of ${name}’s Leads approves it first.`}
    steps={['File', 'Diff', 'Propose']} step={step} done={made !== null} onClose={onClose}
    footer={made !== null ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} busy={busy} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={advance}
      disabled={step === 1 && nothing} nextLabel={step === 0 ? `Read ${file}` : step === 1 ? 'Next' : `Propose as revision ${next}`} />}>
    {made !== null ? <FlowSuccess title={`Proposed as revision ${made}`}>It’s in {leadNames(project)}’s Needs you and above the revision history. Revision {current.n} stays current until a Lead approves; the repository’s file isn’t read again unless someone imports it.</FlowSuccess>
      : step === 0 ? <>
        <Labelled label="Repository"><Select value={repository} onValueChange={(value) => { setRepository(value); setError(null); }}><SelectTrigger aria-label="Repository" /><SelectContent>{repositories.map((entry, index) => <SelectItem key={entry} value={entry} index={index}>{entry}{index === 0 ? ' · project repository' : ''}</SelectItem>)}</SelectContent></Select></Labelled>
        <ChoiceCards label="File" value={file} onChange={(value) => { setFile(value); setError(null); }} columns={2}
          choices={INSTRUCTION_FILES.map((entry) => ({ id: entry, title: entry, detail: entry === 'AGENTS.md' ? 'Read by most coding agents' : entry === 'CLAUDE.md' ? 'Claude Code’s project file' : 'GitSpace’s own location' }))} />
        <InputGroup className="w-full"><InputField index={0} label="Branch" value={branch} onChange={(value) => { setBranch(value); setError(null); }} /></InputGroup>
        <Hint>Reading changes nothing until you propose. Machine profiles stay as they are.</Hint>
      </> : step === 1 ? <>
        <Labelled label={`${file} on ${branch} against revision ${current.n}`}><DiffBlock lines={nothing ? [] : diff} label="Import diff" /></Labelled>
        {nothing ? <Hint>{already ? 'This file’s text is already proposed; approve or decline that proposal first.' : `${file} matches revision ${current.n}: nothing to propose.`}</Hint> : null}
      </> : <Summary rows={[['Proposes', `Revision ${next}: ${changedLines(diff)} changed ${changedLines(diff) === 1 ? 'line' : 'lines'} from ${file}`], ['Current', `Revision ${current.n} stays until a Lead approves`], ['Who decides', `${name}’s Leads: ${leadNames(project)}`], ['Audit log', `${viewer.first} proposed revision ${next} from ${file}`]]} />}
    {error ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

export function SetUpWithAgentWizard({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say, open } = useMock();
  const settings = projectSettings.use()[project];
  const revisions = envRevisions.use()[project] ?? [];
  const readiness = machineReadiness.use();
  const scripts = approvedScripts.use();
  const base = PROJECTS.find((entry) => entry.id === project)?.branch ?? 'main';
  const current = savedOf(revisions)[0];
  const choices = machineChoices(project, viewer.id, true).map((choice) => ({ ...choice, detail: <>{choice.detail}<br />{readinessLine(choice.id, current?.profiles ?? [], readiness)}</> }));
  const [step, setStep] = useState(0);
  const [workspace, setWorkspace] = useState('setup-environment');
  const [branch, setBranch] = useState('gitspace/setup-environment');
  const [machine, setMachine] = useState(choices.find((choice) => !choice.disabled && machineOf(choice.id)?.owner.scope === 'account')?.id ?? '');
  const [notify, setNotify] = useState<ReadonlySet<string>>(new Set([viewer.id]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<EnvRevision | null>(null);
  const access = envAccess(viewer.id, project);
  const name = projectName(project);
  if (access.mode === 'refused') return <RefusedDialog id="set-up-agent" title={`Set up ${name} with an agent`} reason={access.reason} who={whoMayChange(project)} onClose={onClose} />;
  if (!settings || !current) return null;
  const next = nextN(revisions);
  const host = machineOf(machine);
  const personal = host?.owner.scope === 'user';
  const people = USERS.filter((user) => projectRoleOf(user.id, project) !== null);
  const leads = leadsOf(project);
  const usable = scripts.filter((script) => script.versions[0]?.state === 'approved' && (script.scope.kind === 'team' || (script.scope.kind === 'project' && script.scope.projectId === project)));
  const workspaceError = !/^[a-z0-9][a-z0-9-]{1,39}$/.test(workspace) ? 'Use lowercase letters, digits and dashes (2–40), like setup-environment.'
    : WORKSPACES.some((entry) => entry.projectId === project && entry.name === workspace) ? `${name} already has a workspace named ${workspace}.` : undefined;
  const branchError = !/^[A-Za-z0-9._/-]+$/.test(branch) ? 'Enter a branch name without spaces.' : branch === base ? `The agent works on its own branch, not ${base}.` : undefined;
  const unreadable = personal ? settings.repositories.filter((repository) => reachOf(repository).state === 'machine') : [];
  const link = `https://crumbco.gitspace.sh/?project=${project}&workspace=${workspace}`;
  const advance = (): void => {
    setError(null);
    if (step === 0) { if (workspaceError || branchError) { setError('Fix the workspace name and branch first.'); return; } setStep(1); return; }
    if (step === 1) { if (!host) { setError('Pick a machine.'); return; } if (unreadable.length) { setError(`${host.label} can’t read ${unreadable.join(', ')}: the team SSH key is only on team machines, and ${viewer.first}’s own key isn’t registered there. Pick a team machine, or register your key on ${unreadable.map((repository) => repository.split('/')[0]).join(', ')}.`); return; } setStep(2); return; }
    if (step === 2) { setStep(3); return; }
    if (step === 3) { setStep(4); return; }
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      const listed = usable.filter((script) => !current.instructions.includes(`\`${script.name}\``));
      const instructions = listed.length ? `${current.instructions}\n\n## Approved scripts\n${listed.map((script) => `- \`${script.name}\`: ${script.description}.`).join('\n')}` : `${current.instructions}\n\n## Before pushing\n- Run the tests CI runs on a machine ready for ${current.profiles.map(profileName).join(' and ')}: the pull request’s CI checks gate Review.`;
      const revision: EnvRevision = { n: next, by: viewer.id, when: 'Proposed just now', summary: listed.length ? `Agent: lists the approved scripts ${listed.map((script) => script.name).join(', ')}` : 'Agent: what to run before pushing', instructions, profiles: current.profiles, proposal: { from: `Agent in ${workspace} (started by ${viewer.first})`, base: current.n } };
      addRevision(project, revision);
      setupRuns.set({ ...setupRuns.get(), [project]: [{ workspace, branch, machine: host?.label ?? machine, by: viewer.id, proposed: next }, ...(setupRuns.get()[project] ?? [])] });
      recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Started ${workspace} on ${host?.label} to write ${name}’s instructions with an agent` });
      say(`${workspace} is running on ${host?.label}`);
      setMade(revision);
    }, 1200);
  };
  return <FlowDialog id="set-up-agent" title={`Set up ${name} with an agent`} description={made ? undefined : `A workspace in ${name} where an agent reads the repositories, tries the app and its tests, writes “How to work on this project” and proposes the machine profiles its work needs, as revision ${next}. Revision ${current.n} stays current until a Lead approves.`}
    steps={['Workspace', 'Where it runs', 'What it reads', 'Notify', 'Start']} step={step} done={made !== null} onClose={onClose}
    footer={made ? <><Button variant="secondary" onClick={onClose}>Done</Button><Button variant="primary" onClick={() => open(workspace)}>Open {workspace}</Button></> : <StepButtons step={step} busy={busy} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={advance} nextLabel={step === 4 ? 'Start' : 'Next'} />}>
    {made ? <>
      <FlowSuccess title={`${workspace} proposed revision ${made.n}`}>You hold its handle on {host?.label}. Its proposal is above the history in Environment and in {leadNames(project)}’s Needs you{notify.size ? `; ${listNames([...notify].map((id) => findPrincipal(id)?.first ?? id))} get${notify.size === 1 ? 's' : ''} a ping` : ''}. The agent keeps refining it while the workspace runs.</FlowSuccess>
      <Labelled label={`Proposed revision ${made.n}: ${made.summary}`}><DiffBlock lines={revisionDiff(current, made)} label="Agent proposal diff" /></Labelled>
      <Summary rows={[['Machine profiles', `${made.profiles.map(profileName).join(', ')} (unchanged: the repository needs nothing else)`]]} />
      <InputCopy label="Workspace link" value={link} />
    </> : step === 0 ? <>
      <InputGroup className="w-full">
        <InputField index={0} label="Workspace name" value={workspace} error={workspaceError} onChange={(value) => { if (branch === `gitspace/${workspace}`) setBranch(`gitspace/${value}`); setWorkspace(value); setError(null); }} />
        <InputField index={1} label="Branch" value={branch} error={branchError} onChange={(value) => { setBranch(value); setError(null); }} />
      </InputGroup>
      <Summary rows={[['Project', name], ['From', `${settings.repositories[0]} · ${base}`], ['Phase', 'Code'], ['Holder', `${viewer.first} (you)`], ['Model profile', PROFILES.find((profile) => profile.id === settings.profile)?.name ?? settings.profile]]} />
    </> : step === 1 ? <>
      <ChoiceCards label="Machine" value={machine} onChange={(value) => { setMachine(value); setError(null); }} choices={choices} />
      <Hint>Each card says how ready it is for {current.profiles.map(profileName).join(' and ')}. Team machines clone with the GitHub App and the team SSH key; your own use the App and your own key.</Hint>
    </> : step === 2 ? <>
      <Labelled label="Reads">
        <ul className="flex flex-col gap-1 text-caption text-muted-foreground">
          {settings.repositories.map((repository) => <li key={repository} className="flex flex-wrap items-center gap-1.5"><span className="font-mono text-foreground">{repository}</span>· {reachOf(repository).state === 'app' ? 'GitHub App' : `team SSH key on ${host?.label}`}</li>)}
          <li>README, package manifests, CI config and any AGENTS.md, CLAUDE.md or .gitspace/instructions.md</li>
          <li>{name}’s approved scripts: {usable.map((script) => script.name).join(', ') || 'none yet'}</li>
          <li>The team’s machine profiles: {machineProfiles.get().map((profile) => profile.name).join(', ')}</li>
        </ul>
      </Labelled>
      <Summary rows={[['Writes', 'How to run the app and the tests, where fixtures come from, which approved scripts to use, which machine profile'], ['Proposes', `Revision ${next}: the Instructions and the profile list, against revision ${current.n}`], ['Never', 'Writes setup scripts, sets secret values or replaces the current revision: a Lead approves; scripts it needs are submitted for approval separately']]} />
    </> : step === 3 ? <>
      <Labelled label="Also ping when it proposes or gets stuck"><ChipPicker label="Notify" options={people.map((user) => ({ id: user.id, label: `${user.first}${leads.includes(user.id) ? ' · Lead' : ''}` }))} picked={notify} onChange={setNotify} /></Labelled>
      <Hint>{name}’s Leads ({leadNames(project)}) see the proposal in Needs you either way.</Hint>
    </> : <Summary rows={[['Workspace', `${workspace} on ${branch}`], ['Machine', `${host?.label ?? '—'} · ${readinessLine(machine, current.profiles, readiness)}`], ['Proposes', `Revision ${next}`], ['Pings', notify.size ? listNames([...notify].map((id) => findPrincipal(id)?.first ?? id)) : 'Nobody beyond the Leads’ Needs you']]} />}
    {error ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

// ── Secrets the project uses ──

/** A secret a project's work uses: its own, a team secret it uses, or a value it asks each holder for (with who has
 * set it). `target` is what its rule is read and edited by. */
export interface SecretUse { name: string; from: 'project' | 'team' | 'personal'; detail: string; target: RuleTarget; value: boolean; holders: ReadonlyArray<{ userId: string; set: boolean }> }
export function useSecretUses(project: string): readonly SecretUse[] {
  const entries = secrets.use();
  const values = valueStates.use();
  const members = USERS.filter((user) => projectRoleIdOf(user.id, project) !== null);
  const use = (entry: SecretEntry, from: 'project' | 'team'): SecretUse => ({ name: entry.name, from, detail: entry.detail, target: { kind: 'secret', secret: entry }, value: entry.kind === 'value', holders: [] });
  const own = entries.filter((entry) => entry.scope === project).map((entry) => use(entry, 'project'));
  const team = (PROJECT_REACH[project]?.teamSecrets ?? []).flatMap((name) => entries.filter((entry) => entry.scope === 'team' && entry.name === name)).map((entry) => use(entry, 'team'));
  const asked = Object.values(PERSONAL_VALUES).flat().filter((value) => value.projectId === project);
  const personal = asked.filter((value, index) => asked.findIndex((entry) => entry.name === value.name) === index).map((value): SecretUse => ({
    name: value.name, from: 'personal', detail: value.detail.replace(/^Your /, 'Each holder’s own '), target: { kind: 'ask', projectId: project, name: value.name }, value: false,
    holders: members.filter((user) => (PERSONAL_VALUES[user.id] ?? []).some((entry) => entry.projectId === project && entry.name === value.name)).map((user) => ({ userId: user.id, set: values[`${user.id}:${project}:${value.name}`]?.set ?? false })),
  }));
  return [...own, ...team, ...personal];
}
