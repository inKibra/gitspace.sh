// Crumb & Co › Machine profiles: the team's library of what a machine must have for a kind of work (Web, iOS, Data).
// The library lists the proposals waiting for an Owner or Admin, then each profile with its current version and hash,
// whether team machines may run it, the projects that need it and how many machines are ready. A profile's page shows
// its proposals, its checks with their install lines, its setup and teardown scripts, its cloud image, every
// machine's readiness with its actions, where placement sends each project's work, and its version history with
// diffs. Owners and Admins create, edit and approve profiles; a project Lead proposes new profiles and edits; everyone
// else reads.
import { glyph } from '../../glyph.js';
import { Button } from '@gitspace/ui';
import { ArrowLeft, CheckVerified01, LayersThree01, Plus } from '@untitledui/icons';
import { useState } from 'react';
import { machineProfiles, machineReadiness, projectProfiles, type MachineProfile, type Readiness } from '../flows/env-model.js';
import { allMachines, approverNames, CheckList, currentVersion, EditProfileFlow, machineOwner, needsApproval, NewProfileFlow, placementText, profileAccess, ProfileProposalFlow, profileProposals, profileRefusal, ReadinessItem, ScriptBlock, TeamApproveFlow, VersionDiff, type ProfileProposal } from '../flows/profiles.js';
import type { ScopeInfo } from '../scope.js';
import { userOf } from '../data.js';
import { useViewer } from '../viewer.js';
import { projectName } from './data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows, UserName } from './parts.js';

type ProfileFlow = { kind: 'new' } | { kind: 'edit' | 'approve'; profile: MachineProfile } | { kind: 'approve-proposal' | 'decline-proposal'; proposal: ProfileProposal };

/** Lead's proposals waiting for an Owner or Admin, each with Approve and Decline (refused, with why, for others). */
function ProposalRows({ proposals, onDecide }: { proposals: readonly ProfileProposal[]; onDecide(proposal: ProfileProposal, decision: 'approve' | 'decline'): void }) {
  const viewer = useViewer();
  const profiles = machineProfiles.use();
  const refusal = profileRefusal(viewer.id);
  return <SettingRows label="Proposals">{proposals.map((proposal) => {
    const profile = profiles.find((entry) => entry.id === proposal.profileId);
    const current = profile ? currentVersion(profile).n : null;
    const stale = current !== null && proposal.base !== null && proposal.base !== current;
    return <SettingRow key={proposal.id} media={glyph(LayersThree01)}
      title={<span data-profile-proposal={proposal.id} className="inline-flex flex-wrap items-center gap-2">{profile ? `${proposal.name}: ${proposal.note}` : `New profile: ${proposal.name}`}<Pill tone="blue">Waiting for an Owner or Admin</Pill>{stale ? <Pill tone="amber">{`Against v${proposal.base} · v${current} is current`}</Pill> : null}</span>}
      description={<span className="inline-flex flex-wrap items-center gap-1.5">Proposed by <UserName userId={proposal.by} /> · {proposal.when} · {profile ? `a change against v${proposal.base}` : proposal.summary}{proposal.by === viewer.id ? ` · ${approverNames()} decide` : ''}</span>}>
      <Act reason={refusal} variant="ghost" data-act="decline-proposal" onClick={() => onDecide(proposal, 'decline')}>Decline</Act>
      <Act reason={refusal} variant="primary" data-act="approve-proposal" onClick={() => onDecide(proposal, 'approve')}>Review and approve</Act>
    </SettingRow>;
  })}</SettingRows>;
}

/** Counts of the profile's readiness across machines: "Ready on 3 · 1 missing · 2 need approval · 1 declined". */
function countsText(profile: MachineProfile, entries: Readonly<Record<string, Readonly<Record<string, Readiness>>>>): string {
  const counts: Record<Readiness['state'], number> = { ready: 0, missing: 0, 'needs-approval': 0, declined: 0, running: 0 };
  for (const machine of allMachines()) {
    const entry = entries[machine.id]?.[profile.id];
    if (entry) counts[needsApproval(machine, profile, entry) ? 'needs-approval' : entry.state] += 1;
  }
  const approval = counts['needs-approval'];
  const parts = [`Ready on ${counts.ready}`, counts.running ? `${counts.running} running setup` : '', counts.missing ? `${counts.missing} missing something` : '', approval ? `${approval} ${approval === 1 ? 'needs' : 'need'} approval` : '', counts.declined ? `${counts.declined} declined` : ''];
  return parts.filter(Boolean).join(' · ');
}

export function MachineProfilesPage({ info }: { info: ScopeInfo }) {
  const viewer = useViewer();
  const profiles = machineProfiles.use();
  const entries = machineReadiness.use();
  const needs = projectProfiles.use();
  const [open, setOpen] = useState<string | null>(null);
  const [flow, setFlow] = useState<ProfileFlow | null>(null);
  const refusal = info.access === 'team-read' ? profileRefusal(viewer.id) : null;
  const proposer = refusal !== null && profileAccess(viewer.id).mode === 'propose';
  const change = proposer ? null : refusal;
  const proposals = profileProposals.use();
  const close = (): void => setFlow(null);
  const neededBy = (profileId: string): readonly string[] => Object.entries(needs).filter(([, ids]) => ids.includes(profileId)).map(([projectId]) => projectId);
  const current = profiles.find((profile) => profile.id === open);
  const decide = (proposal: ProfileProposal, decision: 'approve' | 'decline'): void => setFlow({ kind: decision === 'approve' ? 'approve-proposal' : 'decline-proposal', proposal });
  const flows = <>
    {flow?.kind === 'new' ? <NewProfileFlow onClose={close} onCreated={(id) => { close(); setOpen(id); }} /> : null}
    {flow?.kind === 'edit' ? <EditProfileFlow profile={flow.profile} onClose={close} /> : null}
    {flow?.kind === 'approve' ? <TeamApproveFlow profile={flow.profile} onClose={close} /> : null}
    {flow?.kind === 'approve-proposal' || flow?.kind === 'decline-proposal' ? <ProfileProposalFlow proposal={flow.proposal} decision={flow.kind === 'approve-proposal' ? 'approve' : 'decline'} onClose={close} /> : null}
  </>;
  if (current) return <>
    <ProfileDetail profile={current} refusal={refusal} change={change} proposer={proposer} proposals={proposals.filter((proposal) => proposal.profileId === current.id)} onDecide={decide} neededBy={neededBy(current.id)} onBack={() => setOpen(null)} onEdit={() => setFlow({ kind: 'edit', profile: current })} onApprove={() => setFlow({ kind: 'approve', profile: current })} />
    {flows}
  </>;
  return <>
    {proposals.length ? <Section title="Proposals" scope="Team" description={`New profiles and changes proposed by project Leads. Nothing runs on any machine until an Owner or Admin (${approverNames()}) approves; a change made against an older version is shown re-diffed against the current one first.`}>
      <ProposalRows proposals={proposals} onDecide={decide} />
    </Section> : null}
    <Section title="Machine profiles" scope="Team" readOnly={change}
      description="What a machine must have for a kind of work: checks (each with how to install it), a setup and a teardown script, and for cloud machines an image that already has it. Projects list the profiles they need; a workspace or a task can add one. Placement prefers a machine that’s ready."
      actions={<Act reason={change} variant="primary" leadingIcon={glyph(Plus)} data-act="new-profile" onClick={() => setFlow({ kind: 'new' })}>{proposer ? 'Propose a profile' : 'New profile'}</Act>}>
      {proposer ? <Note>You’re a project Lead: new profiles and edits you make are proposals {approverNames()} approve.</Note> : null}
      <SettingRows label="Machine profiles">{profiles.map((profile) => {
        const version = currentVersion(profile);
        const approved = profile.teamApproval?.hash === version.hash;
        const projects = neededBy(profile.id);
        return <SettingRow key={profile.id} media={glyph(LayersThree01)}
          title={<span data-profile={profile.id} className="inline-flex flex-wrap items-center gap-2">{profile.name}<Pill><span className="font-mono">v{version.n} · {version.hash}</span></Pill>{approved ? <Pill tone="green">Team machines approved</Pill> : <Pill tone="blue">Needs an Admin’s approval</Pill>}{profile.image ? <Pill tone="teal">{profile.image}</Pill> : null}</span>}
          description={`${profile.summary} · ${projects.length ? `needed by ${projects.map(projectName).join(', ')}` : 'no project needs it yet'}`}
          extra={<span className="text-caption text-muted-foreground">{countsText(profile, entries)}{proposals.some((proposal) => proposal.profileId === profile.id) ? <span className="text-[#b54708]"> · a change is proposed</span> : null}</span>}>
          <Button variant="secondary" data-act="open" onClick={() => setOpen(profile.id)}>Open</Button>
          <Act reason={change} variant="ghost" data-act="edit" onClick={() => setFlow({ kind: 'edit', profile })}>{proposer ? 'Propose a change' : 'Edit'}</Act>
          {approved ? null : <Act reason={refusal} variant="ghost" data-act="approve-team" onClick={() => setFlow({ kind: 'approve', profile })}>Approve for team machines</Act>}
        </SettingRow>;
      })}</SettingRows>
    </Section>
    <Section title="Who approves the scripts">
      <Note>A team machine runs a profile’s setup and teardown only at a content hash an Admin approved; any edit makes a new version with a new hash, and team machines wait for an Admin again. A project Lead proposes new profiles and edits; an Owner or Admin approves them. An Admin can decline a profile on a team machine, and a personal machine’s owner on their own machine (“not on my Mac”); placement never picks that machine for it until someone allows it again. A personal machine’s owner approves each profile there with a passkey. Setup and teardown get no secrets. Each machine’s readiness shows on Machines and in Settings › Machines.</Note>
    </Section>
    {flows}
  </>;
}

function ProfileDetail({ profile, refusal, change, proposer, proposals, onDecide, neededBy, onBack, onEdit, onApprove }: { profile: MachineProfile; refusal: string | null; change: string | null; proposer: boolean; proposals: readonly ProfileProposal[]; onDecide(proposal: ProfileProposal, decision: 'approve' | 'decline'): void; neededBy: readonly string[]; onBack(): void; onEdit(): void; onApprove(): void }) {
  const entries = machineReadiness.use();
  const [diff, setDiff] = useState<number | null>(null);
  const version = currentVersion(profile);
  const approved = profile.teamApproval?.hash === version.hash;
  const machines = allMachines().filter((machine) => entries[machine.id]?.[profile.id]);
  return <>
    <div><Button variant="ghost" size="compact" leadingIcon={glyph(ArrowLeft)} onClick={onBack}>All machine profiles</Button></div>
    <Section title={<span data-profile-page={profile.id} className="inline-flex flex-wrap items-center gap-2">{profile.name}<Pill><span className="font-mono">v{version.n} · {version.hash}</span></Pill></span>} scope="Team" readOnly={change}
      description={profile.summary}
      actions={<>
        <Act reason={change} variant="secondary" data-act="edit" onClick={onEdit}>{proposer ? 'Propose a change' : 'Edit'}</Act>
        {approved ? null : <Act reason={refusal} variant="primary" leadingIcon={glyph(CheckVerified01)} data-act="approve-team" onClick={onApprove}>Approve for team machines</Act>}
      </>}>
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 rounded-xl px-3 py-2.5 text-body shadow-[inset_0_0_0_1px_var(--border)]">
        <dt className="text-caption text-muted-foreground">Team machines</dt>
        <dd className="min-w-0">{approved && profile.teamApproval ? <span className="inline-flex flex-wrap items-center gap-1.5">Approved <span className="font-mono">{profile.teamApproval.hash}</span> · <UserName userId={profile.teamApproval.by} /> · {profile.teamApproval.when}</span>
          : <span className="text-[#b54708]">Waiting for an Admin to approve <span className="font-mono">{version.hash}</span>{profile.teamApproval ? <> (approved now: <span className="font-mono">{profile.teamApproval.hash}</span>)</> : null}</span>}</dd>
        <dt className="text-caption text-muted-foreground">Cloud image</dt>
        <dd className="min-w-0">{profile.image ? <><span className="font-mono">{profile.image}</span><span className="text-caption text-muted-foreground"> · cloud machines started from it skip setup; only the checks run</span></> : <span className="text-muted-foreground">None: setup runs on each machine</span>}</dd>
        <dt className="text-caption text-muted-foreground">Needed by</dt>
        <dd className="min-w-0">{neededBy.length ? neededBy.map(projectName).join(', ') : <span className="text-muted-foreground">No project yet (Project › Environment lists them)</span>}</dd>
      </dl>
    </Section>
    {proposals.length ? <Section title="Proposals" description={`Changes proposed by project Leads, waiting for an Owner or Admin (${approverNames()}).`}>
      <ProposalRows proposals={proposals} onDecide={onDecide} />
    </Section> : null}
    <Section title="Checks" description="How a machine shows it’s ready. When one fails, setup’s result shows its install line.">
      <CheckList checks={version.checks} />
    </Section>
    <Section title="Scripts" description="They run as the machine’s user, with no secrets: setup when a profile is approved on a machine or Run setup is pressed, teardown when it’s declined on a machine (by its owner, or by an Admin on a team machine).">
      <div className="grid gap-3 lg:grid-cols-2">
        <ScriptBlock title="Setup" body={version.setup} version={version.n} hash={version.hash} />
        <ScriptBlock title="Teardown" body={version.teardown} version={version.n} hash={version.hash} />
      </div>
    </Section>
    <Section title="Machines" description="Each machine that has this profile, and what it’s waiting for.">
      {machines.length ? <SettingRows label="Machines with this profile">{machines.map((machine) => {
        const entry = entries[machine.id]?.[profile.id];
        const owner = machineOwner(machine);
        return entry ? <SettingRow key={machine.id} title={<span data-profile-machine={machine.id} className="inline-flex flex-wrap items-center gap-2">{machine.label}{owner ? <Pill tone="violet">{`${userOf(owner).first}’s`}</Pill> : <Pill>Team</Pill>}</span>}
          extra={<ul className="mt-1"><ReadinessItem machine={machine} profile={profile} readiness={entry} lead={<span />} /></ul>} /> : null;
      })}</SettingRows> : <Note>No machine has it yet. When a project lists it, its machines are asked: team machines wait for an Admin, personal ones for their owner.</Note>}
    </Section>
    {neededBy.length ? <Section title="Where placement sends work" description="A ready machine first; then one whose approved setup would install what it misses, once someone presses Run setup there. Declined machines and ones waiting for approval are never picked. Personal machines join only while their owner holds the handle. A new workspace waits for its first message; nothing runs setup on its own.">
      <ul className="flex flex-col gap-1 text-body">{neededBy.map((projectId) => <li key={projectId} data-placement={projectId}><span className="font-medium">{projectName(projectId)}</span><span className="text-muted-foreground">: a workspace needing {profile.name} goes to </span>{placementText(projectId, profile.id)}</li>)}</ul>
    </Section> : null}
    <Section title="Version history" description="Each change to the checks or scripts is a new version with its own hash.">
      <SettingRows label="Versions">{profile.versions.map((entry, index) => {
        const previous = profile.versions[index + 1];
        return <SettingRow key={entry.n} title={<span data-version={entry.n} className="inline-flex flex-wrap items-center gap-2">v{entry.n}<span className="font-mono text-caption text-muted-foreground">{entry.hash}</span>{index === 0 ? <Pill tone="green">Current</Pill> : null}{profile.teamApproval?.hash === entry.hash ? <Pill tone="teal">Team-approved</Pill> : null}</span>}
          description={<span className="inline-flex flex-wrap items-center gap-1.5"><UserName userId={entry.by} /> · {entry.when} · {entry.note}</span>}
          extra={diff === entry.n && previous ? <div className="mt-2"><VersionDiff from={previous} to={entry} /></div> : null}>
          {previous ? <Button variant="ghost" data-act="diff" onClick={() => setDiff(diff === entry.n ? null : entry.n)}>{diff === entry.n ? 'Hide diff' : `Diff with v${previous.n}`}</Button> : null}
        </SettingRow>;
      })}</SettingRows>
    </Section>
  </>;
}
