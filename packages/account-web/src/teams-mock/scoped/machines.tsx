// Machines settings, by placement: any kind (Cell container, cloud VM, physical computer) at either scope. Crumb &
// Co › Machines lists the team's (they run any project's work whoever holds the handle) and the team SSH key; You ›
// Machines lists yours (they join a workspace only while you hold its handle). Someone else's (People › person): theirs,
// revoke only (unpair). Each machine lists its machine profiles' readiness with Approve, Decline and Run setup (the
// owner's on a personal machine, Owners' and Admins' on a team one). What each machine is doing now is on the Machines
// page in the app. Every action opens its dialog from ../flows/you-machines.tsx or ../flows/profiles.tsx.
import { glyph } from '../../glyph.js';
import { Button, Switch, type IconComponent } from '@gitspace/ui';
import { Cloud01, Container, Key01, Laptop01, LayersThree01, Server01, Terminal } from '@untitledui/icons';
import { useState } from 'react';
import { copyText, RevokeFlow } from '../flows/you.js';
import { ProfileReadiness } from '../flows/profiles.js';
import { AddComputerFlow, CellContainerFlow, CloudVmFlow, MachineNotesFlow, MachineRemoveFlow, TeamKeyRotateFlow } from '../flows/you-machines.js';
import { addedMachines, machineEdits, teamKey } from '../flows/you-data.js';
import { MACHINE_KIND_LABEL, MACHINES, projectName, revoked, type Machine, type MachineKind } from '../settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from '../settings/parts.js';
import { revokeIn, revokeOnly, type ScopeInfo } from '../scope.js';
import { useMock, useViewer } from '../viewer.js';

export const KIND_ICON: Readonly<Record<MachineKind, IconComponent>> = { container: glyph(Container), vm: glyph(Cloud01), computer: glyph(Laptop01) };
export const KIND_TONE: Readonly<Record<MachineKind, 'blue' | 'teal' | 'gray'>> = { container: 'blue', vm: 'teal', computer: 'gray' };

type MachineFlow = { kind: 'container' | 'vm' | 'computer' | 'rotate' } | { kind: 'notes' | 'remove' | 'unpair'; machine: Machine };

export function MachinesSettings({ info }: { info: ScopeInfo }) {
  const viewer = useViewer();
  const { say, navigate } = useMock();
  const gone = revoked.use();
  const added = addedMachines.use();
  const edits = machineEdits.use();
  const key = teamKey.use();
  const [flow, setFlow] = useState<MachineFlow | null>(null);
  const close = (): void => setFlow(null);
  const team = info.access === 'team-edit' || info.access === 'team-read';
  const scope = team ? 'team' : 'mine';
  const edit = info.access === 'team-read' ? info.teamReason : null;
  const person = info.target;
  const bot = person?.kind === 'bot' ? person : null;
  const managing = info.access === 'own' || bot !== null;
  const owner = person?.first ?? '';
  const list = [...MACHINES, ...added].filter((machine) => !gone.has(machine.id) && (team ? machine.owner.scope === 'account' : machine.owner.scope === 'user' && machine.owner.userId === person?.id));
  const onlyRevoke = revokeOnly(info, viewer);
  const publicKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${key.fingerprint.slice(7, 47)} ${key.name}@crumbco`;
  return <>
    <Section title={team ? 'Team machines' : info.access === 'own' ? 'My machines' : `${person?.first}’s machines`} scope={team ? 'Team' : 'You'} readOnly={edit}
      description={team ? 'Any project’s workspaces may run on them, whoever holds the handle; bots use these unless they own machines.' : bot ? `Machines ${bot.name} owns, if any: a workspace uses them only while ${bot.name} holds its handle; otherwise its turns run on team machines. Its sponsor, Owners and Admins add and unpair them.` : `A workspace uses them only while ${info.access === 'own' ? 'you hold' : `${person?.first} holds`} its handle; letting go detaches them and anything running keeps running.`}
      actions={<>
        <Act reason={team ? edit : onlyRevoke} variant="primary" leadingIcon={glyph(Container)} onClick={() => setFlow({ kind: 'container' })}>Cell container</Act>
        <Act reason={team ? edit : onlyRevoke} variant="secondary" leadingIcon={glyph(Cloud01)} onClick={() => setFlow({ kind: 'vm' })}>Cloud VM</Act>
        <Act reason={team ? edit : bot ? `A physical computer is paired by the person at it, as theirs; ${bot.name} can own a Cell container or a cloud VM` : onlyRevoke} variant="secondary" leadingIcon={glyph(Terminal)} onClick={() => setFlow({ kind: 'computer' })}>Physical computer</Act>
      </>}>
      {list.length ? <SettingRows label="Machines">{list.map((machine) => {
        const change = edits[machine.id];
        const notes = change?.notes ?? machine.notes;
        const attach = change?.attach ?? true;
        const projects = change?.projects;
        return <SettingRow key={machine.id} media={KIND_ICON[machine.kind]}
          title={<span data-machine={machine.id} className="inline-flex flex-wrap items-center gap-2">{machine.label}<Pill tone={KIND_TONE[machine.kind]}>{MACHINE_KIND_LABEL[machine.kind]}</Pill>{attach ? null : <Pill tone="amber">Agents can’t attach</Pill>}</span>}
          description={<span data-route={machine.id}>{team ? `Team machine${projects ? ` · for ${projects.map(projectName).join(', ')}` : ''} · GitHub App for crumb-co and crumb-labs · team SSH key otherwise` : `${owner}’s ${machine.label} · GitHub App for crumb-co and crumb-labs · ${owner}’s key otherwise`}{change?.os ? ` · ${change.os}` : ''}{notes ? ` · ${notes}` : ''}</span>}
          extra={<div className="mt-1.5"><ProfileReadiness machine={machine} /></div>}>
          {team || managing ? <Switch label="Agents may attach" checked={attach} disabled={edit !== null} onToggle={() => {
            machineEdits.set({ ...machineEdits.get(), [machine.id]: { ...machineEdits.get()[machine.id], attach: !attach } });
            say(attach ? `Agents can’t attach to ${machine.label} now; anything running keeps running` : `Agents may attach to ${machine.label} again`);
          }} /> : null}
          {team ? <Act reason={edit} variant="ghost" onClick={() => setFlow({ kind: 'notes', machine })}>Notes</Act> : null}
          {team ? <Act reason={edit} variant="ghost" onClick={() => setFlow({ kind: 'remove', machine })}>Remove</Act>
            : <Act reason={null} variant="ghost" aria-label={`Unpair ${machine.label}`} onClick={() => setFlow({ kind: 'unpair', machine })}>Unpair</Act>}
        </SettingRow>;
      })}</SettingRows> : <Note>{bot ? `${bot.name} owns no machines; its turns run on team machines.` : 'No machines here.'}</Note>}
      <div className="flex flex-wrap gap-1"><Button variant="ghost" size="compact" leadingIcon={glyph(Server01)} onClick={() => navigate('machines')}>What they’re doing now: Machines</Button><Button variant="ghost" size="compact" leadingIcon={glyph(LayersThree01)} onClick={() => navigate('settings', { page: 'machine-profiles' })}>Machine profiles</Button></div>
    </Section>
    {team ? <Section title="Team SSH key" scope="Team" readOnly={edit} description="Used on team machines for origins the GitHub App doesn’t cover. Personal keys never go on team machines.">
      <SettingRows label="Team SSH key">
        <SettingRow media={glyph(Key01)} title={<span data-team-ssh-key="" className="inline-flex items-center gap-2">{key.name}<Pill>ed25519</Pill>{key.previous ? <Pill tone="amber">Old key still works</Pill> : null}</span>} description={<><span className="font-mono">{key.fingerprint}</span> · created {key.created}{key.previous ? <> · old key <span className="font-mono">{key.previous.slice(0, 20)}…</span> not retired yet</> : null}</>}
          extra={<div className="mt-1 flex flex-col gap-0.5 text-caption text-muted-foreground">{key.registered.map((place) => <span key={place}>Registered: {place}</span>)}</div>}>
          <Act reason={edit} variant="ghost" onClick={() => copyText(publicKey, 'Team public key', say)}>Copy public key</Act>
          <Act reason={edit} variant="ghost" onClick={() => setFlow({ kind: 'rotate' })}>Rotate</Act>
        </SettingRow>
      </SettingRows>
    </Section> : null}
    {flow?.kind === 'container' ? <CellContainerFlow scope={scope} principal={bot ?? undefined} onClose={close} /> : null}
    {flow?.kind === 'vm' ? <CloudVmFlow scope={scope} principal={bot ?? undefined} onClose={close} /> : null}
    {flow?.kind === 'computer' ? <AddComputerFlow initialScope={scope} onClose={close} /> : null}
    {flow?.kind === 'rotate' ? <TeamKeyRotateFlow onClose={close} /> : null}
    {flow?.kind === 'notes' ? <MachineNotesFlow machine={flow.machine} onClose={close} /> : null}
    {flow?.kind === 'remove' ? <MachineRemoveFlow machine={flow.machine} onClose={close} /> : null}
    {flow?.kind === 'unpair' ? <RevokeFlow id="machine-unpair" title={`Unpair ${flow.machine.label}`} confirmLabel="Unpair" onClose={close}
      body={`It leaves ${info.access === 'own' ? 'your' : `${person?.first}’s`} machines: no workspace uses it again and its copy of ${info.access === 'own' ? 'your' : bot ? 'its' : 'their'} SSH key and GitHub token is wiped. Processes running on it keep running, detached.${info.access === 'own' ? '' : bot ? ' It’s in the audit log.' : ` ${person?.first} is told, and it’s in the audit log.`}`}
      onConfirm={() => revokeIn(info, viewer, flow.machine.id, flow.machine.label, 'unpaired', say)} success={`${flow.machine.label} unpaired`} /> : null}
  </>;
}
