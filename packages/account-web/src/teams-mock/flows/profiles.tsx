// Machine profiles: what a machine must have for a kind of work (checks, a setup and a teardown script, a cloud image
// that already has it), and each machine's readiness for each profile. The dialogs: New profile, Edit a profile (a new
// version with a new hash: team approval needed again and personal machines' owners asked again), both of which a
// project Lead who isn't an Admin sends as a proposal an Owner or Admin approves (Review proposal); Approve on my
// machine (its owner, with a passkey, then setup runs), Decline on a machine (a personal machine's owner, or an Admin
// for a team machine: placement never picks it for that profile), Approve for team machines (an Admin, by hash) and
// Run setup. `ProfileReadiness` draws a machine's line ("Ready: Web · iOS (iOS 18 simulator missing)") with its
// actions, for the live Machines page and Settings › Machines.
import { Button, InputField, InputGroup } from '@gitspace/ui';
import { CheckCircle, Users01, XCircle } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { notify, PROJECTS, projectRoleIdOf, userOf, USERS } from '../data.js';
import { MACHINE_LIVE } from '../live/data.js';
import { MACHINES, projectName, recordAudit, revoked, type Machine } from '../settings/data.js';
import { Act, Note, Pill } from '../settings/parts.js';
import { usePasskey } from '../settings/passkey.js';
import { whyAccount } from '../settings/roles.js';
import { createStore } from '../store.js';
import { useMock, useViewer } from '../viewer.js';
import { machineProfiles, machineReadiness, projectProfiles, type MachineProfile, type ProfileCheck, type ProfileVersion, type Readiness } from './env-model.js';
import { ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary, TextArea } from './kit.js';
import { addedMachines } from './you-data.js';
import { MockOutcome, Waiting } from './you.js';

// ── Model helpers ──

export function currentVersion(profile: MachineProfile): ProfileVersion {
  const version = profile.versions[0];
  if (!version) throw new Error(`Profile ${profile.id} has no version`);
  return version;
}

/** What a version's hash covers: its checks, its setup and its teardown, one line each. */
export function versionLines(version: Pick<ProfileVersion, 'checks' | 'setup' | 'teardown'>): readonly string[] {
  return [
    ...version.checks.map((check) => `check ${check.label}: ${check.command}  # install: ${check.install}`),
    ...version.setup.split('\n').map((line) => `setup     ${line}`),
    ...version.teardown.split('\n').filter((line) => line.trim()).map((line) => `teardown  ${line}`),
  ];
}

/** The mock's content hash: 7 hex digits of FNV-1a over the version's lines. */
export function contentHash(version: Pick<ProfileVersion, 'checks' | 'setup' | 'teardown'>): string {
  let hash = 0x811c9dc5;
  for (const char of versionLines(version).join('\n')) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0').slice(0, 7);
}

export function machineOwner(machine: Machine): string | null {
  return machine.owner.scope === 'user' ? machine.owner.userId : null;
}

/** Every machine still paired: the seed and the ones added in this session. */
export function allMachines(): readonly Machine[] {
  const gone = revoked.get();
  return [...MACHINES, ...addedMachines.get()].filter((machine) => !gone.has(machine.id));
}

export function machineOnline(machine: Machine): boolean {
  return MACHINE_LIVE[machine.id]?.connected ?? machine.state === 'online';
}

/** Why the viewer can't approve, decline or run setup for profiles on `machine`: team machines are Owners' and Admins';
 * a personal machine is its owner's alone. */
export function machineRefusal(viewerId: string, machine: Machine): string | null {
  const owner = machineOwner(machine);
  if (owner) return owner === viewerId ? null : `Only ${userOf(owner).first} approves, declines or runs setup on their machine`;
  const refusal = whyAccount(viewerId, 'account.resources');
  return refusal ? `${refusal}: Owners and Admins approve, decline and run setup for profiles on team machines` : null;
}

/** Why the viewer can't create, edit or approve profiles for team machines. */
export function profileRefusal(viewerId: string): string | null {
  const refusal = whyAccount(viewerId, 'account.resources');
  return refusal ? `${refusal}: Owners and Admins create, edit and approve machine profiles` : null;
}

/** Owners and Admins change profiles directly; a project Lead proposes (new profiles and edits) for them to approve;
 * anyone else reads. */
export type ProfileAccess = { mode: 'edit' } | { mode: 'propose' } | { mode: 'refused'; reason: string };
export function profileAccess(viewerId: string): ProfileAccess {
  const refusal = profileRefusal(viewerId);
  if (!refusal) return { mode: 'edit' };
  if (PROJECTS.some((project) => projectRoleIdOf(viewerId, project.id) === 'lead')) return { mode: 'propose' };
  return { mode: 'refused', reason: `${refusal}; a project’s Lead may propose one` };
}

function setReadiness(machineId: string, profileId: string, readiness: Readiness): void {
  const all = machineReadiness.get();
  machineReadiness.set({ ...all, [machineId]: { ...all[machineId], [profileId]: readiness } });
}

/** True when the profile's current scripts still need approving on this machine before setup may run. */
export function needsApproval(machine: Machine, profile: MachineProfile, readiness: Readiness): boolean {
  const hash = currentVersion(profile).hash;
  if (readiness.state === 'needs-approval') return true;
  if (readiness.state !== 'missing') return false;
  return machineOwner(machine) ? readiness.hash !== hash : profile.teamApproval?.hash !== hash;
}

/** The check a failed setup names: the one the machine is missing, else the last. */
function failingCheck(profile: MachineProfile, readiness: Readiness | undefined): ProfileCheck | undefined {
  const checks = currentVersion(profile).checks;
  const missing = readiness?.state === 'missing' ? readiness.missing.toLowerCase() : '';
  return checks.find((check) => missing && (check.label.toLowerCase().includes(missing) || missing.includes(check.label.toLowerCase()))) ?? checks.at(-1);
}

/** Readiness in words: "iOS 18 simulator missing", "needs Maya’s approval", "declined by Rina". */
export function readinessText(machine: Machine, profile: MachineProfile, readiness: Readiness): string {
  const owner = machineOwner(machine);
  if (readiness.state === 'ready') return 'ready';
  if (readiness.state === 'running') return 'setup running';
  if (readiness.state === 'declined') return `declined by ${userOf(readiness.by).first}`;
  if (needsApproval(machine, profile, readiness)) return owner ? `needs ${userOf(owner).first}’s approval` : 'needs an Admin’s approval';
  return readiness.state === 'missing' ? `${readiness.missing} missing` : 'not ready';
}

/** "Ready: Web · iOS (iOS 18 simulator missing)": the ready ones first, then each other with its state. */
export function readinessLine(machine: Machine, profiles: readonly MachineProfile[], entries: Readonly<Record<string, Readiness>>): string {
  const listed = profiles.filter((profile) => entries[profile.id]);
  if (!listed.length) return 'No machine profiles on it';
  const ready = listed.filter((profile) => entries[profile.id]?.state === 'ready');
  const rest = listed.filter((profile) => entries[profile.id]?.state !== 'ready').map((profile) => {
    const entry = entries[profile.id];
    return entry ? `${profile.name} (${readinessText(machine, profile, entry)})` : profile.name;
  });
  return `${ready.length ? 'Ready' : 'Not ready'}: ${[...ready.map((profile) => profile.name), ...rest].join(' · ')}`;
}

/** Where placement sends a workspace in `projectId` that needs `profileId`: machines ready for it first, then the ones
 * whose approved setup would install what they miss (once someone presses Run setup). Declined machines and ones still
 * waiting for approval never get picked. A personal machine counts only when its owner is in the project (it joins
 * while they hold the handle). */
export function placementFor(projectId: string, profileId: string): { ready: readonly Machine[]; setup: readonly Machine[] } {
  const entries = machineReadiness.get();
  const profile = machineProfiles.get().find((entry) => entry.id === profileId);
  const usable = allMachines().filter((machine) => {
    const owner = machineOwner(machine);
    return !owner || projectRoleIdOf(owner, projectId) !== null;
  });
  const ready = usable.filter((machine) => entries[machine.id]?.[profileId]?.state === 'ready');
  const setup = usable.filter((machine) => {
    const entry = entries[machine.id]?.[profileId];
    return entry?.state === 'missing' && profile !== undefined && !needsApproval(machine, profile, entry);
  });
  return { ready, setup };
}

/** "Maya’s MacBook Pro or the Back-office Mac mini (once someone runs setup there for its iOS 18 simulator)". */
export function placementText(projectId: string, profileId: string): string {
  const { ready, setup } = placementFor(projectId, profileId);
  const entries = machineReadiness.get();
  const parts = [
    ...ready.map((machine) => machine.label),
    ...setup.map((machine) => {
      const entry = entries[machine.id]?.[profileId];
      return `${machine.label} (once someone runs setup there for its ${entry?.state === 'missing' ? entry.missing : 'missing checks'})`;
    }),
  ];
  return parts.length ? parts.join(' or ') : 'no machine yet: it waits until one is ready';
}

/** Ends a setup run: ready, or missing the check that failed. */
function runSetup(machine: Machine, profile: MachineProfile, ok: boolean, failing: ProfileCheck | undefined): void {
  const version = currentVersion(profile);
  setReadiness(machine.id, profile.id, ok ? { state: 'ready', hash: version.hash } : { state: 'missing', missing: failing?.label ?? 'a check', hash: version.hash });
}

// ── Pieces ──

/** A script as the machine runs it: monospace, with its version and hash. */
export function ScriptBlock({ title, body, version, hash }: { title: string; body: string; version: number; hash: string }) {
  return <div className="flex min-w-0 flex-col gap-1">
    <span className="flex flex-wrap items-center gap-2 text-caption font-medium text-foreground">{title}<span className="font-mono font-normal text-muted-foreground">v{version} · {hash}</span></span>
    <pre data-script={title} className="overflow-x-auto whitespace-pre rounded-xl bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_var(--border)]">{body.trim() ? body : '# (empty)'}</pre>
  </div>;
}

/** Each check: what it is, the command that checks it, and how to install it when it fails. */
export function CheckList({ checks }: { checks: readonly ProfileCheck[] }) {
  return <ul className="flex flex-col gap-1.5">
    {checks.map((check) => <li key={check.label} data-check={check.label} className="flex min-w-0 flex-col rounded-lg px-2.5 py-1.5 text-caption shadow-[inset_0_0_0_1px_var(--border)]">
      <span className="flex flex-wrap items-baseline gap-x-2"><span className="font-medium text-foreground">{check.label}</span><code className="break-all font-mono text-muted-foreground">{check.command}</code></span>
      <span className="text-muted-foreground">Install: <code className="break-all font-mono text-foreground">{check.install}</code></span>
    </li>)}
  </ul>;
}

/** A line diff of two versions (longest common subsequence): removed lines red, added green. */
export function VersionDiff({ from, to }: { from: Pick<ProfileVersion, 'checks' | 'setup' | 'teardown'>; to: Pick<ProfileVersion, 'checks' | 'setup' | 'teardown'> }) {
  const a = versionLines(from);
  const b = versionLines(to);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
  const rows: Array<{ kind: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: ' ', text: a[i] ?? '' }); i += 1; j += 1; }
    else if (j < b.length && (i >= a.length || (table[i]![j + 1] ?? 0) >= (table[i + 1]![j] ?? 0))) { rows.push({ kind: '+', text: b[j] ?? '' }); j += 1; }
    else { rows.push({ kind: '-', text: a[i] ?? '' }); i += 1; }
  }
  return <pre data-diff="" className="overflow-x-auto rounded-xl bg-surface-2 py-1.5 font-mono text-[12px] leading-relaxed shadow-[inset_0_0_0_1px_var(--border)]">
    {rows.map((row, index) => <div key={index} className={`whitespace-pre px-3 ${row.kind === '+' ? 'bg-[color-mix(in_oklab,#17b26a_12%,transparent)] text-[#067647]' : row.kind === '-' ? 'bg-[color-mix(in_oklab,#d92d20_10%,transparent)] text-[#b42318]' : 'text-muted-foreground'}`}>{row.kind} {row.text}</div>)}
  </pre>;
}

const TONE: Readonly<Record<Readiness['state'], 'green' | 'amber' | 'red' | 'blue' | 'gray'>> = { ready: 'green', missing: 'amber', 'needs-approval': 'blue', declined: 'gray', running: 'blue' };

type ReadinessFlow = 'approve-mine' | 'approve-team' | 'decline' | 'setup';

/** One profile on one machine: its state and the viewer's actions (Run setup, Approve, Decline, Why declined, Allow
 * again), each opening its dialog. */
export function ReadinessItem({ machine, profile, readiness, lead }: { machine: Machine; profile: MachineProfile; readiness: Readiness; lead?: ReactNode }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [flow, setFlow] = useState<ReadinessFlow | null>(null);
  const owner = machineOwner(machine);
  const refusal = machineRefusal(viewer.id, machine);
  const approval = needsApproval(machine, profile, readiness);
  const close = (): void => setFlow(null);
  const text = readinessText(machine, profile, readiness);
  return <li data-readiness={`${machine.id}:${profile.id}`} data-state={readiness.state} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
    {lead ?? null}<Pill tone={approval ? 'blue' : TONE[readiness.state]}>{lead ? readiness.state === 'ready' ? 'Ready' : readiness.state === 'declined' ? 'Declined' : readiness.state === 'running' ? 'Running' : approval ? 'Needs approval' : 'Missing' : profile.name}</Pill>
    <span className={readiness.state === 'missing' && !approval ? 'text-[#b54708]' : 'text-muted-foreground'}>{text}{readiness.state === 'declined' ? `: “${readiness.note}”` : ''}</span>
    <span className="ml-auto flex flex-wrap items-center gap-1">
      {readiness.state === 'running' ? <Waiting>Running setup…</Waiting> : null}
      {approval ? <Act reason={owner ? refusal : profileRefusal(viewer.id)} size="compact" variant="secondary" data-act="approve" onClick={() => setFlow(owner ? 'approve-mine' : 'approve-team')}>Approve</Act> : null}
      {readiness.state === 'missing' && !approval ? <Act reason={refusal} size="compact" variant="secondary" data-act="run-setup" onClick={() => setFlow('setup')}>Run setup</Act> : null}
      {readiness.state === 'declined' ? <Button size="compact" variant="ghost" data-act="why-declined" onClick={() => say(`${userOf(readiness.by).first} declined ${profile.name} on ${machine.label} on ${readiness.when}: “${readiness.note}”. Placement never picks it for ${profile.name}.`)}>Why declined</Button> : null}
      {readiness.state === 'declined' ? <Act reason={refusal} size="compact" variant="ghost" data-act="allow" onClick={() => {
        const hash = currentVersion(profile).hash;
        setReadiness(machine.id, profile.id, !owner && profile.teamApproval?.hash === hash ? { state: 'missing', missing: 'setup', hash } : { state: 'needs-approval', hash });
        if (!owner) recordAudit({ actor: viewer.id, kind: 'resource', text: `Allowed machine profile ${profile.name} on ${machine.label} again` });
        say(owner ? `${profile.name} may go on ${machine.label} again; approve its scripts to set it up` : `${profile.name} may go on ${machine.label} again; ${profile.teamApproval?.hash === hash ? 'Run setup there to make it ready' : 'an Admin approves its scripts first'}`);
      }}>Allow again</Act> : null}
      {readiness.state !== 'declined' && readiness.state !== 'running' ? <Act reason={refusal} size="compact" variant="ghost" data-act="decline" onClick={() => setFlow('decline')}>Decline</Act> : null}
    </span>
    {flow === 'approve-mine' ? <ApproveOnMachineFlow machine={machine} profile={profile} onClose={close} /> : null}
    {flow === 'approve-team' ? <TeamApproveFlow profile={profile} onClose={close} /> : null}
    {flow === 'decline' ? <DeclineOnMachineFlow machine={machine} profile={profile} onClose={close} /> : null}
    {flow === 'setup' ? <RunSetupFlow machine={machine} profile={profile} onClose={close} /> : null}
  </li>;
}

/** A machine's readiness: the summary line, then each profile with its actions. */
export function ProfileReadiness({ machine }: { machine: Machine }) {
  const profiles = machineProfiles.use();
  const entries = machineReadiness.use()[machine.id] ?? {};
  const listed = profiles.filter((profile) => entries[profile.id]);
  return <div data-profile-readiness={machine.id} className="flex min-w-0 flex-col gap-1">
    <span className="text-caption font-medium text-foreground">{readinessLine(machine, profiles, entries)}</span>
    {listed.length ? <ul className="flex flex-col gap-1">{listed.map((profile) => {
      const entry = entries[profile.id];
      return entry ? <ReadinessItem key={profile.id} machine={machine} profile={profile} readiness={entry} /> : null;
    })}</ul> : null}
  </div>;
}

// ── Setup run ──

type SetupPhase = 'running' | 'ready' | 'failed';

/** Setup on the machine: running (the mock picks the outcome), then ready or the failed check with its install line. */
function SetupProgress({ machine, profile, phase, check, onPick }: { machine: Machine; profile: MachineProfile; phase: SetupPhase; check: ProfileCheck | undefined; onPick(ok: boolean): void }) {
  if (phase === 'running') return <>
    <Waiting>Running {profile.name} setup (v{currentVersion(profile).n} · {currentVersion(profile).hash}) on {machine.label}, then its {currentVersion(profile).checks.length} checks…</Waiting>
    <MockOutcome what="Setup:" outcomes={[{ id: 'pass', label: 'Every check passes' }, { id: 'fail', label: `“${check?.label ?? 'a check'}” fails` }]} onPick={(id) => onPick(id === 'pass')} />
  </>;
  if (phase === 'failed') return <FlowError>Setup ran, but the check “{check?.label}” failed: <code className="font-mono">{check?.command}</code> found nothing on {machine.label}. Install it with <code className="font-mono">{check?.install}</code>, then press Run setup again. Placement skips {machine.label} for {profile.name} until it passes.</FlowError>;
  return null;
}

/** Run setup: the approved script runs on the machine; an offline machine can't run it. */
export function RunSetupFlow({ machine, profile, onClose }: { machine: Machine; profile: MachineProfile; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [phase, setPhase] = useState<SetupPhase | null>(null);
  const [failing] = useState(() => failingCheck(profile, machineReadiness.get()[machine.id]?.[profile.id]));
  const [offline, setOffline] = useState(false);
  const version = currentVersion(profile);
  const refusal = machineRefusal(viewer.id, machine);
  const start = (): void => {
    if (!machineOnline(machine)) { setOffline(true); return; }
    setReadiness(machine.id, profile.id, { state: 'running', started: 'just now' });
    setPhase('running');
  };
  const pick = (ok: boolean): void => {
    runSetup(machine, profile, ok, failing);
    setPhase(ok ? 'ready' : 'failed');
    if (!machineOwner(machine)) recordAudit({ actor: viewer.id, kind: 'resource', text: `Ran ${profile.name} setup (v${version.n} · ${version.hash}) on team machine ${machine.label}: ${ok ? 'ready' : 'a check failed'}` });
    if (ok) say(`${machine.label} is ready for ${profile.name}`);
  };
  return <FlowDialog id="mprofile-run-setup" title={`Run ${profile.name} setup on ${machine.label}`} done={phase === 'ready'} onClose={onClose}
    description={phase === 'ready' ? undefined : 'The approved setup script runs on the machine, then every check. Nothing else runs.'}
    footer={phase === 'ready' ? <Button variant="primary" onClick={onClose}>Done</Button>
      : phase === 'running' ? <Button variant="secondary" onClick={onClose}>Close</Button>
      : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Act reason={refusal} variant="primary" onClick={start}>{phase === 'failed' ? 'Run setup again' : 'Run setup'}</Act></>}>
    {phase === 'ready' ? <FlowSuccess title={`${machine.label} is ready for ${profile.name}`}>Every check passed (v{version.n} · {version.hash}). Placement now prefers it for work that needs {profile.name}.</FlowSuccess> : <>
      <Summary rows={[['Machine', machine.label], ['Profile', `${profile.name} · ${profile.summary}`], ['Version', <span key="v" className="font-mono">v{version.n} · {version.hash}</span>], ['Approved', machineOwner(machine) ? `by ${userOf(machineOwner(machine) ?? '').first} for this machine` : profile.teamApproval ? `for team machines by ${userOf(profile.teamApproval.by).first} on ${profile.teamApproval.when}` : 'not yet']]} />
      <ScriptBlock title="Setup" body={version.setup} version={version.n} hash={version.hash} />
      {offline ? <FlowError>{machine.label} is offline (last heartbeat {MACHINE_LIVE[machine.id]?.heartbeat ?? 'unknown'}), so setup can’t run. Start it or wait for it to connect, then run setup again.</FlowError> : null}
      {phase ? <SetupProgress machine={machine} profile={profile} phase={phase} check={failing} onPick={pick} /> : null}
    </>}
  </FlowDialog>;
}

// ── Approve and decline on my machine ──

/** As the machine's owner: read the scripts and the hash, approve with a passkey, setup runs, then ready or a failed
 * check with its install line. An offline machine runs it when it connects. */
export function ApproveOnMachineFlow({ machine, profile, onClose }: { machine: Machine; profile: MachineProfile; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const check = usePasskey();
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<SetupPhase | 'queued' | null>(null);
  const [failing] = useState(() => failingCheck(profile, machineReadiness.get()[machine.id]?.[profile.id]));
  const version = currentVersion(profile);
  const refusal = machineRefusal(viewer.id, machine);
  const approve = (): void => check.confirm(() => {
    if (machineOnline(machine)) { setReadiness(machine.id, profile.id, { state: 'running', started: 'just now' }); setPhase('running'); }
    else { setReadiness(machine.id, profile.id, { state: 'missing', missing: 'setup (runs when it connects)', hash: version.hash }); setPhase('queued'); }
    setStep(2);
    say(`Approved ${profile.name} v${version.n} (${version.hash}) on ${machine.label}`);
  });
  const pick = (ok: boolean): void => { runSetup(machine, profile, ok, failing); setPhase(ok ? 'ready' : 'failed'); };
  const retry = (): void => { setReadiness(machine.id, profile.id, { state: 'running', started: 'just now' }); setPhase('running'); };
  return <FlowDialog id="mprofile-approve-mine" title={`Approve ${profile.name} on ${machine.label}`} steps={['Review', 'Approve', 'Setup']} step={step} done={phase === 'ready'} onClose={onClose}
    description={phase === 'ready' ? undefined : `You approve this exact version for ${machine.label} only. An edit to ${profile.name} makes a new hash and asks you again.`}
    footer={phase === 'ready' ? <Button variant="primary" onClick={onClose}>Done</Button>
      : step === 2 ? <><Button variant="secondary" onClick={onClose}>Close</Button>{phase === 'failed' ? <Button variant="primary" onClick={retry}>Run setup again</Button> : null}</>
      : refusal ? <><Button variant="secondary" onClick={onClose}>Close</Button></>
      : <StepButtons step={step} onBack={() => setStep(0)} onCancel={onClose} busy={check.waiting} next={() => { if (step === 0) setStep(1); else approve(); }} nextLabel={step === 0 ? 'Continue' : 'Approve with passkey'} />}>
    {phase === 'ready' ? <FlowSuccess title={`${machine.label} is ready for ${profile.name}`}>Setup ran and every check passed (v{version.n} · {version.hash}). Your agents’ work that needs {profile.name} may run here while you hold the handle.</FlowSuccess>
      : refusal ? <FlowError>{refusal}.</FlowError>
      : step === 0 ? <>
        <Summary rows={[['Machine', `${machine.label} (yours)`], ['Profile', `${profile.name} · ${profile.summary}`], ['Version', <span key="v" className="font-mono">v{version.n} · {version.hash} · by {userOf(version.by).first}, {version.when}</span>]]} />
        <CheckList checks={version.checks} />
        <ScriptBlock title="Setup" body={version.setup} version={version.n} hash={version.hash} />
        <ScriptBlock title="Teardown" body={version.teardown} version={version.n} hash={version.hash} />
      </>
      : step === 1 ? <>
        <Hint>Setup runs as you on {machine.label}, with no secrets. Teardown runs if you later decline {profile.name} here.</Hint>
        <PasskeyStep userId={viewer.id} what={`approving ${version.hash} on ${machine.label}`} waiting={check.waiting} />
      </>
      : phase === 'queued' ? <>
        <Waiting>{machine.label} is offline (last heartbeat {MACHINE_LIVE[machine.id]?.heartbeat}). Setup runs when it connects.</Waiting>
        <MockOutcome what={`${machine.label}:`} outcomes={[{ id: 'connect', label: 'It connects' }]} onPick={retry} />
      </>
      : phase ? <SetupProgress machine={machine} profile={profile} phase={phase} check={failing} onPick={pick} /> : null}
  </FlowDialog>;
}

/** A personal machine's owner ("not on my Mac"), or an Admin for a team machine: decline a profile there. Its
 * teardown runs if it was set up, and placement never picks the machine for it until someone allows it again. */
export function DeclineOnMachineFlow({ machine, profile, onClose }: { machine: Machine; profile: MachineProfile; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const refusal = machineRefusal(viewer.id, machine);
  const trimmed = note.trim();
  const error = !trimmed ? 'Say why, so the project’s Leads know (e.g. “not on my Mac”)' : trimmed.length > 80 ? 'At most 80 characters' : null;
  const was = machineReadiness.get()[machine.id]?.[profile.id];
  const owner = machineOwner(machine);
  const needing = Object.entries(projectProfiles.get()).filter(([projectId, ids]) => ids.includes(profile.id) && (!owner || projectRoleIdOf(viewer.id, projectId) !== null)).map(([projectId]) => projectId);
  const decline = (): void => {
    setTried(true);
    if (error) return;
    setReadiness(machine.id, profile.id, { state: 'declined', by: viewer.id, when: 'today', note: trimmed });
    if (!owner) recordAudit({ actor: viewer.id, kind: 'resource', text: `Declined machine profile ${profile.name} on ${machine.label}: “${trimmed}”` });
    setDone(true);
    say(`${profile.name} declined on ${machine.label}`);
  };
  return <FlowDialog id="mprofile-decline" title={`Decline ${profile.name} on ${machine.label}`} done={done} wide={false} onClose={onClose}
    description={done ? undefined : `${profile.name}’s scripts never run on ${machine.label}, and placement never picks it for work that needs ${profile.name}.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Act reason={refusal} variant="primary" onClick={decline}>Decline</Act></>}>
    {done ? <FlowSuccess title={`${profile.name} declined on ${machine.label}`}>“{trimmed}”. {was?.state === 'ready' ? 'Its teardown ran. ' : ''}Placement sends work that needs {profile.name}{needing.length ? ` in ${needing.map(projectName).join(', ')}` : ''} elsewhere{needing[0] ? `: ${placementText(needing[0], profile.id)}` : ''}. Allow it again here any time.</FlowSuccess> : <>
      <TextArea label="Why" value={note} onChange={setNote} rows={2} placeholder={owner ? 'not on my Mac' : 'no Xcode on this Linux runner'} error={tried && error ? error : undefined} />
      <Hint>{needing.length ? `${needing.map(projectName).join(' and ')} ${needing.length === 1 ? 'needs' : 'need'} ${profile.name}; their Leads see your reason on the machine’s readiness line.` : `No project you’re in needs ${profile.name} now.`}{was?.state === 'ready' ? ` ${profile.name} is set up here: its teardown runs.` : ''}</Hint>
      {refusal ? <FlowError>{refusal}.</FlowError> : null}
    </>}
  </FlowDialog>;
}

// ── Approve for team machines ──

/** Team machines whose readiness for `profile` waits for an Admin. */
function teamMachinesFor(profile: MachineProfile): readonly Machine[] {
  const entries = machineReadiness.get();
  return allMachines().filter((machine) => !machineOwner(machine) && entries[machine.id]?.[profile.id] !== undefined);
}

/** An Admin approves the current version's hash for every team machine: online ones run setup (or use the image),
 * offline ones run it when they connect. */
function approveForTeam(viewerId: string, profile: MachineProfile): void {
  const version = currentVersion(profile);
  machineProfiles.set(machineProfiles.get().map((entry) => entry.id === profile.id ? { ...entry, teamApproval: { hash: version.hash, by: viewerId, when: 'today' } } : entry));
  for (const machine of teamMachinesFor(profile)) {
    const entry = machineReadiness.get()[machine.id]?.[profile.id];
    if (!entry || entry.state === 'declined' || (entry.state === 'ready' && entry.hash === version.hash)) continue;
    if (!machineOnline(machine)) setReadiness(machine.id, profile.id, { state: 'missing', missing: 'setup (runs when it connects)', hash: version.hash });
    else setReadiness(machine.id, profile.id, { state: 'ready', hash: version.hash });
  }
  recordAudit({ actor: viewerId, kind: 'approval', text: `Approved machine profile ${profile.name} v${version.n} (${version.hash}) for team machines` });
}

/** The passkey, with the mock's choice of confirming or cancelling it. */
function PasskeyAsk({ userId, what, onPick }: { userId: string; what: string; onPick(ok: boolean): void }) {
  return <>
    <PasskeyStep userId={userId} what={what} waiting />
    <MockOutcome what="The passkey prompt:" outcomes={[{ id: 'ok', label: 'Confirm' }, { id: 'cancel', label: 'Cancel it' }]} onPick={(id) => onPick(id === 'ok')} />
  </>;
}

/** An Admin approves a profile's scripts for team machines, by hash: the diff from the approved version, the machines
 * that will run it, a passkey. */
export function TeamApproveFlow({ profile, onClose }: { profile: MachineProfile; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [step, setStep] = useState(0);
  const [asking, setAsking] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [done, setDone] = useState(false);
  const version = currentVersion(profile);
  const approved = profile.versions.find((entry) => entry.hash === profile.teamApproval?.hash);
  const machines = teamMachinesFor(profile);
  const refusal = profileRefusal(viewer.id);
  const pick = (ok: boolean): void => {
    setAsking(false);
    if (!ok) { setCancelled(true); return; }
    approveForTeam(viewer.id, profile);
    setDone(true);
    say(`${profile.name} ${version.hash} approved for team machines`);
  };
  return <FlowDialog id="mprofile-approve-team" title={`Approve ${profile.name} for team machines`} steps={['Review', 'Sign in']} step={step} done={done} onClose={onClose}
    description={done ? undefined : `Team machines run a profile’s scripts only at a hash an Admin approved. You approve v${version.n} · ${version.hash}.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button>
      : refusal ? <Button variant="secondary" onClick={onClose}>Close</Button>
      : <StepButtons step={step} onBack={() => { setStep(0); setAsking(false); }} onCancel={onClose} disabled={asking} next={() => { if (step === 0) setStep(1); else { setCancelled(false); setAsking(true); } }} nextLabel={step === 0 ? 'Continue' : 'Approve with passkey'} />}>
    {done ? <FlowSuccess title={`${profile.name} v${version.n} (${version.hash}) approved for team machines`}>
      {machines.length ? machines.map((machine) => `${machine.label}: ${machineOnline(machine) ? (machine.kind !== 'computer' && profile.image ? `ready from ${profile.image}` : 'setup ran, ready') : 'setup runs when it connects'}`).join(' · ') : 'No team machine has it yet; it’s set up when a project needs it there.'}. It’s in the audit log.
    </FlowSuccess>
      : refusal ? <FlowError>{refusal}.</FlowError>
      : step === 0 ? <>
        <Summary rows={[['Version', <span key="v" className="font-mono">v{version.n} · {version.hash} · by {userOf(version.by).first}, {version.when}: {version.note}</span>], ['Approved now', profile.teamApproval ? <span key="a" className="font-mono">{profile.teamApproval.hash} by {userOf(profile.teamApproval.by).first}, {profile.teamApproval.when}</span> : 'Nothing yet'], ['Cloud image', profile.image ?? 'None: setup runs on each machine']]} />
        {approved && approved.hash !== version.hash ? <><span className="text-caption font-medium text-foreground">Changes since the approved v{approved.n}</span><VersionDiff from={approved} to={version} /></> : <>
          <CheckList checks={version.checks} />
          <ScriptBlock title="Setup" body={version.setup} version={version.n} hash={version.hash} />
          <ScriptBlock title="Teardown" body={version.teardown} version={version.n} hash={version.hash} />
        </>}
      </>
      : <>
        <span className="text-caption font-medium text-foreground">Team machines that run it</span>
        {machines.length ? <ul className="flex flex-col gap-1 text-caption">{machines.map((machine) => <li key={machine.id} className="flex flex-wrap gap-2"><span className="text-foreground">{machine.label}</span><span className="text-muted-foreground">{machineOnline(machine) ? (machine.kind !== 'computer' && profile.image ? `uses ${profile.image}; checks only` : 'runs setup now') : 'offline: runs setup when it connects'}</span></li>)}</ul> : <Note>None yet.</Note>}
        {cancelled ? <FlowError>The passkey wasn’t confirmed, so nothing was approved. Press Approve with passkey to try again.</FlowError> : null}
        {asking ? <PasskeyAsk userId={viewer.id} what={`approving ${version.hash} for team machines`} onPick={pick} /> : null}
      </>}
  </FlowDialog>;
}

// ── New and edit ──

interface Draft { name: string; summary: string; image: string; checks: readonly ProfileCheck[]; setup: string; teardown: string }
const IMAGE = /^[a-z0-9][a-z0-9./-]*:[A-Za-z0-9._-]+$/;

function draftErrors(draft: Draft, selfId: string | null): { name?: string; image?: string; checks?: string; setup?: string; rows: ReadonlyArray<{ label?: string; command?: string; install?: string }> } {
  const name = draft.name.trim();
  const taken = machineProfiles.get().some((profile) => profile.id !== selfId && profile.name.toLowerCase() === name.toLowerCase());
  return {
    name: !name ? 'Name the profile' : name.length > 24 ? 'At most 24 characters' : taken ? `There’s already a profile named ${name}` : undefined,
    image: draft.image.trim() && !IMAGE.test(draft.image.trim()) ? 'An image looks like gitspace/web:2026.11 (name:tag)' : undefined,
    checks: draft.checks.length === 0 ? 'Add at least one check: it’s how a machine shows it’s ready' : undefined,
    setup: !draft.setup.trim() ? 'The setup script installs what the checks look for' : undefined,
    rows: draft.checks.map((check) => ({
      label: check.label.trim() ? undefined : 'What it checks',
      command: check.command.trim() ? undefined : 'The command that checks it',
      install: check.install.trim() ? undefined : 'How to install it when the check fails',
    })),
  };
}

/** The checks editor: label, command and install line per check. */
function ChecksEditor({ checks, onChange, rows, tried }: { checks: readonly ProfileCheck[]; onChange(next: readonly ProfileCheck[]): void; rows: ReadonlyArray<{ label?: string; command?: string; install?: string }>; tried: boolean }) {
  const set = (index: number, field: keyof ProfileCheck, value: string): void => onChange(checks.map((check, at) => at === index ? { ...check, [field]: value } : check));
  return <div className="flex flex-col gap-2">
    {checks.map((check, index) => <div key={index} data-check-row={index} className="flex flex-col gap-1 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex items-center justify-between gap-2"><span className="text-caption font-medium text-foreground">Check {index + 1}</span><Button size="compact" variant="ghost" onClick={() => onChange(checks.filter((_, at) => at !== index))}>Remove</Button></div>
      <InputGroup className="w-full">
        <InputField index={0} label="Label" placeholder="node 22" value={check.label} onChange={(value) => set(index, 'label', value)} error={tried ? rows[index]?.label : undefined} />
        <InputField index={1} label="Command" placeholder="node --version" value={check.command} onChange={(value) => set(index, 'command', value)} error={tried ? rows[index]?.command : undefined} />
        <InputField index={2} label="How to install" placeholder="mise use -g node@22" value={check.install} onChange={(value) => set(index, 'install', value)} error={tried ? rows[index]?.install : undefined} />
      </InputGroup>
    </div>)}
    <div><Button size="compact" variant="secondary" onClick={() => onChange([...checks, { label: '', command: '', install: '' }])}>Add a check</Button></div>
  </div>;
}

/** Whether to approve the new hash for team machines now (an Admin, with a passkey) or leave it for another Admin. */
function ApproveNowChoice({ value, onChange }: { value: string; onChange(next: string): void }) {
  return <ChoiceCards label="Team machines" value={value} onChange={onChange} choices={[
    { id: 'now', title: 'Approve for team machines now', detail: 'With your passkey; team machines that need it run setup', icon: CheckCircle },
    { id: 'later', title: 'Leave it for another Admin', detail: 'Team machines don’t run it until an Admin approves this hash; Needs you shows it to them', icon: Users01 },
  ]} />;
}

/** New profile: details → checks → scripts → review (the hash) → saved; an Admin may approve it for team machines in
 * the same flow with a passkey. */
export function NewProfileFlow({ onClose, onCreated }: { onClose(): void; onCreated(profileId: string): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const check = usePasskey();
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [draft, setDraft] = useState<Draft>({ name: '', summary: '', image: '', checks: [{ label: '', command: '', install: '' }], setup: '', teardown: '' });
  const [approveNow, setApproveNow] = useState('now');
  const [done, setDone] = useState<MachineProfile | null>(null);
  const errors = draftErrors(draft, null);
  const rowsBad = errors.rows.some((row) => row.label || row.command || row.install);
  const version = { checks: draft.checks, setup: draft.setup, teardown: draft.teardown };
  const hash = contentHash(version);
  const access = profileAccess(viewer.id);
  const refusal = access.mode === 'refused' ? access.reason : null;
  const propose = access.mode === 'propose';
  const [proposed, setProposed] = useState(false);
  const save = (): void => {
    if (propose) {
      addProfileProposal({ profileId: null, base: null, ...draftOf(draft), note: 'First version', by: viewer.id });
      setProposed(true);
      say(`${draft.name.trim()} proposed; an Owner or Admin approves it`);
      return;
    }
    const profile = createProfile(draft, viewer.id, approveNow === 'now' ? viewer.id : null);
    setDone(profile);
    say(`${profile.name} profile saved`);
  };
  const next = (): void => {
    setTried(true);
    if (step === 0) { if (errors.name || errors.image) return; }
    else if (step === 1) { if (errors.checks || rowsBad) return; }
    else if (step === 2) { if (errors.setup) return; }
    else { if (approveNow === 'now' && !propose) check.confirm(save); else save(); return; }
    setTried(false);
    setStep(step + 1);
  };
  return <FlowDialog id="mprofile-new" title={propose ? 'Propose a machine profile' : 'New machine profile'} steps={['Details', 'Checks', 'Scripts', propose ? 'Propose' : 'Review']} step={step} done={done !== null || proposed} onClose={onClose}
    description={done || proposed ? undefined : propose ? 'You’re a project Lead, not an Admin: the profile is a proposal until an Owner or Admin approves it, and no machine runs it before then.' : 'What a machine must have for a kind of work. Projects list the profiles they need; placement prefers machines that are ready.'}
    footer={done ? <><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="primary" onClick={() => onCreated(done.id)}>Open {done.name}</Button></>
      : proposed || refusal ? <Button variant={proposed ? 'primary' : 'secondary'} onClick={onClose}>{proposed ? 'Done' : 'Close'}</Button>
      : <StepButtons step={step} onBack={() => { setTried(false); setStep(step - 1); }} onCancel={onClose} next={next} busy={check.waiting} nextLabel={step < 3 ? 'Continue' : propose ? `Propose ${draft.name.trim()}` : approveNow === 'now' ? 'Save and approve with passkey' : 'Save'} />}>
    {done ? <FlowSuccess title={`${done.name} v1 saved · ${hash}`}>
      {done.teamApproval ? 'Approved for team machines with your passkey; ' : 'Team machines wait for an Admin to approve this hash; '}personal machines’ owners approve it on their own machines. No machine has it yet: a project lists it in Project › Environment, then its machines are asked. It’s in the audit log.
    </FlowSuccess>
      : proposed ? <FlowSuccess title={`${draft.name.trim()} proposed · ${hash}`}>It’s under Proposals in Machine profiles, waiting for an Owner or Admin ({approverNames()}). When one approves, it becomes v1 and is approved for team machines; you’re told either way.</FlowSuccess>
      : refusal ? <FlowError>{refusal}.</FlowError>
      : step === 0 ? <>
        <InputGroup className="w-full">
          <InputField index={0} label="Name" placeholder="Android" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} error={tried ? errors.name : undefined} />
          <InputField index={1} label="Summary" placeholder="Android SDK 35, emulator, Gradle" value={draft.summary} onChange={(summary) => setDraft({ ...draft, summary })} />
          <InputField index={2} label="Cloud image (optional)" placeholder="gitspace/android:2026.11" value={draft.image} onChange={(image) => setDraft({ ...draft, image })} error={tried ? errors.image : undefined} />
        </InputGroup>
        <Hint>A cloud machine started from the image already has everything, so setup is skipped there and only the checks run.</Hint>
      </>
      : step === 1 ? <>
        <ChecksEditor checks={draft.checks} onChange={(checks) => setDraft({ ...draft, checks })} rows={errors.rows} tried={tried} />
        {tried && errors.checks ? <FlowError>{errors.checks}</FlowError> : null}
        {tried && rowsBad ? <FlowError>Every check needs a label, a command and how to install it: the install line is what a failed setup shows.</FlowError> : null}
      </>
      : step === 2 ? <>
        <TextArea label="Setup script" mono rows={5} value={draft.setup} onChange={(setup) => setDraft({ ...draft, setup })} placeholder={'sdkmanager "platforms;android-35" "emulator"'} error={tried ? errors.setup : undefined} />
        <TextArea label="Teardown script" mono rows={3} value={draft.teardown} onChange={(teardown) => setDraft({ ...draft, teardown })} placeholder="rm -rf ~/.gradle/caches" />
        <Hint>Setup runs on a machine only when someone approves this content’s hash there or presses Run setup; teardown runs when the profile is declined on a machine. Neither gets secrets, and a new workspace never runs it on its own.</Hint>
      </>
      : <>
        <Summary rows={[['Name', draft.name.trim()], ['Summary', draft.summary.trim() || '—'], ['Cloud image', draft.image.trim() || 'None'], ['Checks', draft.checks.map((entry) => entry.label).join(', ')], ['Version', <span key="h" className="font-mono">v1 · {hash}</span>]]} />
        <ScriptBlock title="Setup" body={draft.setup} version={1} hash={hash} />
        <ScriptBlock title="Teardown" body={draft.teardown} version={1} hash={hash} />
        {propose ? <Note>An Owner or Admin reviews these scripts and approves the hash for team machines.</Note> : <>
          <ApproveNowChoice value={approveNow} onChange={setApproveNow} />
          {approveNow === 'now' ? <PasskeyStep userId={viewer.id} what={`approving ${hash} for team machines`} waiting={check.waiting} /> : null}
        </>}
      </>}
  </FlowDialog>;
}

/** What saving a new version does to each machine that has the profile: team machines and personal ones not declined
 * need approval again (personal owners are told); declined ones stay declined. */
function reaskMachines(viewerId: string, profile: MachineProfile, hash: string): { team: readonly Machine[]; personal: readonly Machine[] } {
  const team: Machine[] = [];
  const personal: Machine[] = [];
  for (const machine of allMachines()) {
    const entry = machineReadiness.get()[machine.id]?.[profile.id];
    if (!entry || entry.state === 'declined') continue;
    setReadiness(machine.id, profile.id, { state: 'needs-approval', hash });
    const owner = machineOwner(machine);
    if (owner) {
      personal.push(machine);
      if (owner !== viewerId) notify({ to: owner, from: viewerId, text: `${profile.name} changed: approve it again on ${machine.label}`, detail: `v${currentVersion(profile).n + 1} · ${hash}` });
    } else team.push(machine);
  }
  return { team, personal };
}

/** Edit a profile: change → diff (version n+1, new hash) → save; team approval is reset (an Admin may approve the new
 * hash in the same flow) and personal machines' owners are asked again. */
export function EditProfileFlow({ profile, onClose }: { profile: MachineProfile; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const check = usePasskey();
  const old = currentVersion(profile);
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [draft, setDraft] = useState<Draft>({ name: profile.name, summary: profile.summary, image: profile.image ?? '', checks: old.checks, setup: old.setup, teardown: old.teardown });
  const [note, setNote] = useState('');
  const [approveNow, setApproveNow] = useState('now');
  const [done, setDone] = useState<SavedVersion | null>(null);
  const errors = draftErrors(draft, profile.id);
  const rowsBad = errors.rows.some((row) => row.label || row.command || row.install);
  const version = { checks: draft.checks, setup: draft.setup, teardown: draft.teardown };
  const hash = contentHash(version);
  const unchanged = hash === contentHash(old) && draft.summary === profile.summary && draft.image === (profile.image ?? '') && draft.name === profile.name;
  const scriptsSame = hash === contentHash(old);
  const access = profileAccess(viewer.id);
  const refusal = access.mode === 'refused' ? access.reason : null;
  const propose = access.mode === 'propose';
  const [proposed, setProposed] = useState(false);
  const entries = machineReadiness.get();
  const affected = allMachines().filter((machine) => { const entry = entries[machine.id]?.[profile.id]; return entry !== undefined && entry.state !== 'declined'; });
  const save = (): void => {
    if (propose) {
      addProfileProposal({ profileId: profile.id, base: old.n, ...draftOf(draft), note: note.trim(), by: viewer.id });
      setProposed(true);
      say(`Change to ${profile.name} proposed; an Owner or Admin approves it`);
      return;
    }
    setDone(saveVersion(profile, draft, note.trim(), viewer.id, approveNow === 'now' ? viewer.id : null));
    say(scriptsSame ? `${profile.name} saved` : `${profile.name} v${old.n + 1} saved`);
  };
  const next = (): void => {
    setTried(true);
    if (step === 0) {
      if (errors.name || errors.image || errors.checks || errors.setup || rowsBad || unchanged || !note.trim()) return;
      setTried(false);
      setStep(1);
      return;
    }
    if (step === 1) { setStep(2); return; }
    if (!scriptsSame && approveNow === 'now' && !propose) check.confirm(save); else save();
  };
  return <FlowDialog id="mprofile-edit" title={propose ? `Propose a change to ${profile.name}` : `Edit ${profile.name}`} steps={['Change', 'Diff', propose ? 'Propose' : 'Save']} step={step} done={done !== null || proposed} onClose={onClose}
    description={done || proposed ? undefined : propose ? `You’re a project Lead, not an Admin: your change is a proposal against v${old.n}. An Owner or Admin approves it; until then every machine keeps v${old.n}.` : `A change to the checks or scripts makes v${old.n + 1} with a new hash: team machines need an Admin’s approval again and personal machines’ owners are asked again.`}
    footer={done || proposed ? <Button variant="primary" onClick={onClose}>Done</Button>
      : refusal ? <Button variant="secondary" onClick={onClose}>Close</Button>
      : <StepButtons step={step} onBack={() => setStep(step - 1)} onCancel={onClose} next={next} busy={check.waiting} nextLabel={step < 2 ? 'Continue' : propose ? `Propose against v${old.n}` : !scriptsSame && approveNow === 'now' ? `Save v${old.n + 1} and approve with passkey` : scriptsSame ? 'Save' : `Save v${old.n + 1}`} />}>
    {proposed ? <FlowSuccess title={`Change to ${profile.name} proposed against v${old.n}`}>It’s under Proposals on {profile.name}’s page, waiting for an Owner or Admin ({approverNames()}). If {profile.name} changes before then, they see your change re-diffed against the newer version before approving. You’re told either way.</FlowSuccess>
    : done ? <FlowSuccess title={done.scriptsSame ? `${profile.name} saved` : `${profile.name} v${old.n + 1} saved · ${hash}`}>
      {done.scriptsSame ? 'The scripts didn’t change, so the hash and every approval stand.' : <>
        {approveNow === 'now' ? `Approved for team machines with your passkey${done.team.length ? `: ${done.team.map((machine) => machine.label).join(', ')} ${done.team.length === 1 ? 'is' : 'are'} set up again` : ''}. ` : `Team machines (${done.team.map((machine) => machine.label).join(', ') || 'none'}) wait for an Admin’s approval of ${hash}. `}
        {done.personal.length ? `Asked again: ${done.personal.map((machine) => `${machine.label} (${userOf(machineOwner(machine) ?? '').first})`).join(', ')}. ` : ''}Declined machines stay declined. It’s in the audit log.
      </>}
    </FlowSuccess>
      : refusal ? <FlowError>{refusal}.</FlowError>
      : step === 0 ? <>
        <InputGroup className="w-full">
          <InputField index={0} label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} error={tried ? errors.name : undefined} />
          <InputField index={1} label="Summary" value={draft.summary} onChange={(summary) => setDraft({ ...draft, summary })} />
          <InputField index={2} label="Cloud image (optional)" value={draft.image} onChange={(image) => setDraft({ ...draft, image })} error={tried ? errors.image : undefined} />
        </InputGroup>
        <ChecksEditor checks={draft.checks} onChange={(checks) => setDraft({ ...draft, checks })} rows={errors.rows} tried={tried} />
        {tried && errors.checks ? <FlowError>{errors.checks}</FlowError> : null}
        <TextArea label="Setup script" mono rows={4} value={draft.setup} onChange={(setup) => setDraft({ ...draft, setup })} error={tried ? errors.setup : undefined} />
        <TextArea label="Teardown script" mono rows={2} value={draft.teardown} onChange={(teardown) => setDraft({ ...draft, teardown })} />
        <TextArea label="What changed" rows={2} value={note} onChange={setNote} placeholder="iOS 18.2 simulator runtime" error={tried && !note.trim() && !unchanged ? 'Say what changed; it’s the version’s note in the history' : undefined} />
        {tried && unchanged ? <FlowError>Nothing changed: edit a check, a script, the summary or the image first.</FlowError> : null}
        {tried && rowsBad ? <FlowError>Every check needs a label, a command and how to install it.</FlowError> : null}
      </>
      : step === 1 ? <>
        <Summary rows={[['Version', <span key="v" className="font-mono">{scriptsSame ? `v${old.n} · ${old.hash} (unchanged)` : `v${old.n} · ${old.hash} → v${old.n + 1} · ${hash}`}</span>], ['Note', note.trim()]]} />
        <VersionDiff from={old} to={version} />
      </>
      : <>
        {scriptsSame ? <Note>Only the name, summary or image changed: the hash stays {old.hash} and no machine is asked again.</Note> : <>
          <span className="text-caption font-medium text-foreground">What happens to machines with {profile.name}</span>
          <ul className="flex flex-col gap-1 text-caption">
            {affected.map((machine) => <li key={machine.id} className="flex flex-wrap gap-2"><span className="text-foreground">{machine.label}</span><span className="text-muted-foreground">{machineOwner(machine) ? `${userOf(machineOwner(machine) ?? '').first} is asked to approve ${hash} again` : 'needs an Admin’s approval of the new hash'}</span></li>)}
            {allMachines().filter((machine) => entries[machine.id]?.[profile.id]?.state === 'declined').map((machine) => <li key={machine.id} className="flex flex-wrap gap-2"><XCircle width={14} height={14} className="text-muted-foreground" /><span className="text-foreground">{machine.label}</span><span className="text-muted-foreground">stays declined</span></li>)}
          </ul>
          {propose ? <Note>When an Owner or Admin approves your proposal, it becomes v{old.n + 1} and is approved for team machines.</Note> : <>
            <ApproveNowChoice value={approveNow} onChange={setApproveNow} />
            {approveNow === 'now' ? <PasskeyStep userId={viewer.id} what={`approving ${hash} for team machines`} waiting={check.waiting} /> : null}
          </>}
        </>}
      </>}
  </FlowDialog>;
}

// ── Saving, and Leads' proposals ──

/** The draft as a profile's fields: trimmed, with an empty image as none. */
function draftOf(draft: Draft): Pick<ProfileProposal, 'name' | 'summary' | 'image' | 'checks' | 'setup' | 'teardown'> {
  return { name: draft.name.trim(), summary: draft.summary.trim() || draft.checks.map((entry) => entry.label).join(', '), image: draft.image.trim() || null, checks: draft.checks, setup: draft.setup, teardown: draft.teardown };
}

/** Creates a profile at v1 from `draft`, written by `by`; with `approver` its hash is approved for team machines. */
function createProfile(draft: Draft | ProfileProposal, by: string, approver: string | null): MachineProfile {
  const fields = { checks: draft.checks, setup: draft.setup, teardown: draft.teardown };
  const hash = contentHash(fields);
  const name = draft.name.trim();
  const profile: MachineProfile = { id: `p-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, summary: draft.summary.trim() || draft.checks.map((entry) => entry.label).join(', '), image: draft.image?.trim() || null,
    versions: [{ n: 1, hash, ...fields, by, when: 'today', note: 'First version' }],
    teamApproval: approver ? { hash, by: approver, when: 'today' } : null };
  machineProfiles.set([...machineProfiles.get(), profile]);
  recordAudit({ actor: approver ?? by, kind: 'resource', text: `Created machine profile ${name} v1 (${hash})${by !== (approver ?? by) ? ` proposed by ${userOf(by).first}` : ''}${approver ? ', approved for team machines' : ''}` });
  return profile;
}

interface SavedVersion { scriptsSame: boolean; team: readonly Machine[]; personal: readonly Machine[] }
/** Saves `draft` as the profile's next version, written by `by` (only its name, summary and image when the scripts
 * didn't change): machines that have it are asked again, and with `approver` the new hash is approved for team
 * machines at once. */
function saveVersion(profile: MachineProfile, draft: Draft | ProfileProposal, note: string, by: string, approver: string | null): SavedVersion {
  const old = currentVersion(profile);
  const fields = { checks: draft.checks, setup: draft.setup, teardown: draft.teardown };
  const hash = contentHash(fields);
  const scriptsSame = hash === contentHash(old);
  const result = scriptsSame ? { team: [], personal: [] } : reaskMachines(approver ?? by, profile, hash);
  machineProfiles.set(machineProfiles.get().map((entry) => entry.id === profile.id ? { ...entry, name: draft.name.trim(), summary: draft.summary.trim(), image: draft.image?.trim() || null,
    versions: scriptsSame ? entry.versions : [{ n: old.n + 1, hash, ...fields, by, when: 'today', note }, ...entry.versions],
    teamApproval: scriptsSame ? entry.teamApproval : approver ? { hash, by: approver, when: 'today' } : null } : entry));
  if (!scriptsSame && approver) {
    for (const machine of result.team) setReadiness(machine.id, profile.id, machineOnline(machine) ? { state: 'ready', hash } : { state: 'missing', missing: 'setup (runs when it connects)', hash });
  }
  const proposedBy = by !== (approver ?? by) ? ` proposed by ${userOf(by).first}` : '';
  recordAudit({ actor: approver ?? by, kind: 'resource', text: scriptsSame ? `Edited machine profile ${profile.name} (name, summary or image)${proposedBy}` : `Edited machine profile ${profile.name}: v${old.n + 1} (${hash}), “${note}”${proposedBy}${approver ? ', approved for team machines' : ''}` });
  return { scriptsSame, ...result };
}

/** A project Lead's proposed profile, waiting for an Owner or Admin: a new profile (`profileId` null) or a change to
 * one, made against its version `base`. */
export interface ProfileProposal {
  id: string; profileId: string | null; base: number | null;
  name: string; summary: string; image: string | null; checks: readonly ProfileCheck[]; setup: string; teardown: string;
  note: string; by: string; when: string;
}
const WEB_V2 = { checks: [{ label: 'bun ≥ 1.2', command: 'bun --version', install: 'curl -fsSL https://bun.sh/install | bash' }, { label: 'node 22', command: 'node --version', install: 'mise use -g node@22' }, { label: 'gh', command: 'gh --version', install: 'brew install gh · apt install gh' }],
  setup: 'mise use -g node@22\ncurl -fsSL https://bun.sh/install | bash -s bun-v1.2.23\ngh auth status || true' };
export const profileProposals = createStore<readonly ProfileProposal[]>([
  { id: 'pp-data-marimo', profileId: 'data', base: 1, name: 'Data', summary: 'python 3.12, uv, duckdb, marimo', image: 'gitspace/data:2026.10', note: 'marimo for the reconciliation notebooks', by: 'rina', when: 'today 09:05',
    checks: [{ label: 'python 3.12', command: 'python3 --version', install: 'uv python install 3.12' }, { label: 'uv', command: 'uv --version', install: 'curl -LsSf https://astral.sh/uv/install.sh | sh' }, { label: 'duckdb', command: 'duckdb --version', install: 'uv tool install duckdb' }, { label: 'marimo', command: 'marimo --version', install: 'uv tool install marimo' }],
    setup: 'curl -LsSf https://astral.sh/uv/install.sh | sh\nuv python install 3.12\nuv tool install duckdb\nuv tool install marimo', teardown: 'uv cache clean' },
  { id: 'pp-web-pnpm', profileId: 'web', base: 2, name: 'Web', summary: 'bun, node 22, gh, pnpm', image: 'gitspace/web:2026.11', note: 'pnpm through corepack, for Ledger', by: 'rina', when: 'Nov 10',
    checks: [...WEB_V2.checks, { label: 'pnpm', command: 'pnpm --version', install: 'corepack enable pnpm' }], setup: `${WEB_V2.setup}\ncorepack enable pnpm`, teardown: 'rm -rf ~/.bun/install/cache' },
]);
function addProfileProposal(proposal: Omit<ProfileProposal, 'id' | 'when'>): void {
  profileProposals.set([...profileProposals.get(), { ...proposal, id: `pp-${Date.now()}`, when: 'just now' }]);
  recordAudit({ actor: proposal.by, kind: 'resource', text: proposal.profileId ? `Proposed a change to machine profile ${proposal.name} against v${proposal.base}: “${proposal.note}”` : `Proposed machine profile ${proposal.name}` });
}
/** The Owners and Admins, who approve profiles: "Maya and Theo". */
export function approverNames(): string {
  return USERS.filter((user) => !profileRefusal(user.id)).map((user) => user.first).join(' and ');
}

/** An Owner or Admin approves (with a passkey) or declines (with a reason) a Lead's proposal. A change made against an
 * older version than the current one is re-diffed against the current version first, and approving it says so: it
 * never silently replaces what was saved since. */
export function ProfileProposalFlow({ proposal, decision, onClose }: { proposal: ProfileProposal; decision: 'approve' | 'decline'; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const check = usePasskey();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const [profile] = useState(() => machineProfiles.get().find((entry) => entry.id === proposal.profileId));
  const refusal = profileRefusal(viewer.id);
  const current = profile ? currentVersion(profile) : null;
  const base = profile?.versions.find((entry) => entry.n === proposal.base);
  const stale = current !== null && proposal.base !== null && proposal.base !== current.n;
  const hash = contentHash(proposal);
  const proposer = userOf(proposal.by).first;
  const title = `${decision === 'approve' ? 'Approve' : 'Decline'} ${proposal.profileId ? `${proposer}’s change to ${proposal.name}` : `${proposer}’s ${proposal.name} profile`}`;
  const remove = (): void => profileProposals.set(profileProposals.get().filter((entry) => entry.id !== proposal.id));
  const approve = (): void => check.confirm(() => {
    if (profile) saveVersion(profile, proposal, proposal.note, proposal.by, viewer.id);
    else createProfile(proposal, proposal.by, viewer.id);
    remove();
    notify({ to: proposal.by, from: viewer.id, text: `${viewer.first} approved your proposed ${proposal.name} profile${profile ? ' change' : ''}`, detail: stale ? `Re-diffed against v${current?.n}: now v${(current?.n ?? 0) + 1} · ${hash}` : hash });
    setDone(true);
    say(`${proposal.name} ${hash} approved for team machines`);
  });
  const decline = (): void => {
    setTried(true);
    if (!reason.trim()) return;
    remove();
    notify({ to: proposal.by, from: viewer.id, text: `${viewer.first} declined your proposed ${proposal.name} profile`, detail: `“${reason.trim()}”` });
    recordAudit({ actor: viewer.id, kind: 'resource', text: `Declined ${proposer}’s proposed machine profile ${proposal.name}: “${reason.trim()}”` });
    setDone(true);
    say(`Declined ${proposer}’s ${proposal.name} proposal`);
  };
  return <FlowDialog id={decision === 'approve' ? 'mprofile-proposal-approve' : 'mprofile-proposal-decline'} title={title} done={done} onClose={onClose}
    description={done ? undefined : `${proposal.note} · proposed by ${proposer}, ${proposal.when}${proposal.base !== null ? ` · against v${proposal.base}` : ' · a new profile'}`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button>
      : refusal ? <Button variant="secondary" onClick={onClose}>Close</Button>
      : <><Button variant="secondary" onClick={onClose}>Cancel</Button>{decision === 'approve'
        ? <Button variant="primary" loading={check.waiting} onClick={approve}>{stale ? `Approve against v${current?.n} with passkey` : 'Approve with passkey'}</Button>
        : <Button variant="primary" onClick={decline}>Decline</Button>}</>}>
    {done ? <FlowSuccess title={decision === 'approve' ? `${proposal.name} ${profile ? `v${(current?.n ?? 0) + 1}` : 'v1'} · ${hash} approved for team machines` : `Declined ${proposer}’s proposal`}>
      {decision === 'approve' ? `${profile ? 'Machines that have it are asked again; team machines are set up with the new hash. ' : 'A project lists it in Project › Environment, then its machines are asked. '}${proposer} is told. It’s in the audit log.` : `${proposer} gets your reason. Nothing changed.`}
    </FlowSuccess>
      : refusal ? <FlowError>{refusal}.</FlowError>
      : <>
        {stale && current && base ? <>
          <div data-stale-proposal="" className="rounded-xl bg-[color-mix(in_oklab,#f79009_10%,transparent)] px-3 py-2 text-caption text-foreground">Proposed against v{base.n}. v{current.n} was saved since ({current.note} · {userOf(current.by).first}, {current.when}), so here it is re-diffed against v{current.n}: anything v{current.n} added that the proposal lacks shows as removed. {decision === 'approve' ? `Approving makes exactly this v${current.n + 1}.` : ''}</div>
          <span className="text-caption font-medium text-foreground">Re-diffed against v{current.n} (current)</span>
          <VersionDiff from={current} to={proposal} />
          <span className="text-caption font-medium text-foreground">{proposer}’s change, against v{base.n}</span>
          <VersionDiff from={base} to={proposal} />
        </> : current ? <>
          <span className="text-caption font-medium text-foreground">Against v{current.n} (current)</span>
          <VersionDiff from={current} to={proposal} />
        </> : <>
          <Summary rows={[['Name', proposal.name], ['Summary', proposal.summary], ['Cloud image', proposal.image ?? 'None'], ['Version', <span key="h" className="font-mono">v1 · {hash}</span>]]} />
          <CheckList checks={proposal.checks} />
          <ScriptBlock title="Setup" body={proposal.setup} version={1} hash={hash} />
          <ScriptBlock title="Teardown" body={proposal.teardown} version={1} hash={hash} />
        </>}
        {decision === 'approve' ? <PasskeyStep userId={viewer.id} what={`approving ${hash} for team machines`} waiting={check.waiting} />
          : <TextArea label={`Why (sent to ${proposer})`} value={reason} onChange={setReason} rows={2} placeholder="Put marimo in the project’s own uv.lock instead" error={tried && !reason.trim() ? `Say why, so ${proposer} knows what to change` : undefined} />}
      </>}
  </FlowDialog>;
}
