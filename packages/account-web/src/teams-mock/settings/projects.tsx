// Projects: Settings lists the projects the viewer is in (each opens its own settings) with New project, and for an
// Admin the ones they aren't in, with Join project; joining shows in the project's member list and the audit log. A
// project's members (people and bots) and their roles live in its settings: its Leads manage them (Manage members), as
// do Owners and Admins in projects they're in. Adding, changing a role, removing and joining each open their flow.
import { glyph } from '../../glyph.js';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, Tooltip } from '@gitspace/ui';
import { FolderClosed, FolderPlus, Plus, Trash01 } from '@untitledui/icons';
import { useState } from 'react';
import { actorLabel, findPrincipal, memberships, setMembership, USERS, visibleProjects, WORKSPACES } from '../data.js';
import { ChoiceCards, FlowDialog, FlowSuccess, Summary } from '../flows/kit.js';
import { AddMemberWizard, ChangeRoleDialog, Gate, leadsOf, RefusedDialog, RemoveMemberDialog } from '../flows/project.js';
import { NewProjectWizard } from '../project-setup.js';
import { useMock, useViewer } from '../viewer.js';
import { ACTIVE_PROJECTS, PROFILES, projectName, projectSettings, recordAudit } from './data.js';
import { Act, Avatar, Note, Pill, Section, SettingRow, SettingRows } from './parts.js';
import { projectRoleById, projectRoleOf, roleName, useRoles, whyAccount, whyMembers } from './roles.js';

function RoleSelect({ value, label, disabled, reason, onChange }: { value: string; label: string; disabled: boolean; reason: string | null; onChange(roleId: string): void }) {
  const roles = useRoles();
  return <Select value={value} disabled={disabled} onValueChange={onChange}>
    <Tooltip content={reason ?? label}><span><SelectTrigger aria-label={label} /></span></Tooltip>
    <SelectContent>{roles.map((role, index) => <SelectItem key={role.id} value={role.id} index={index}>{role.name}</SelectItem>)}</SelectContent>
  </Select>;
}

/** Settings → Projects: the projects the viewer is in, each opening its own settings; for an Admin, also the projects
 * they aren't in, with Join project. */
export function ProjectsPage() {
  const viewer = useViewer();
  const { navigate } = useMock();
  useRoles();
  const live = memberships.use();
  const settings = projectSettings.use();
  const [joining, setJoining] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const seen = visibleProjects(viewer.id);
  const owners = USERS.filter((user) => user.accountRole === 'owner');
  const joinable = viewer.accountRole === 'admin' ? ACTIVE_PROJECTS.filter((entry) => !seen.has(entry.id)) : [];
  const count = (projectId: string) => live.filter((membership) => membership.projectId === projectId).length + owners.length;
  return <>
    <Section title="Projects you’re in" scope="Team" description="Each project’s own settings: members and project roles, its inference profile, plugins, secrets with their rules, environment and automations."
      actions={<Button variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setCreating(true)}>New project</Button>}>
      <SettingRows label="Projects you’re in">{ACTIVE_PROJECTS.filter((project) => seen.has(project.id)).map((project) => <SettingRow key={project.id} media={glyph(FolderClosed)}
        title={<span className="inline-flex items-center gap-2">{project.name}<Pill tone="blue">{projectRoleOf(viewer.id, project.id)?.name}</Pill></span>}
        description={`${count(project.id)} members · profile ${PROFILES.find((profile) => profile.id === settings[project.id]?.profile)?.name ?? '—'} · ${WORKSPACES.filter((workspace) => workspace.projectId === project.id && !workspace.archived).length} open workspaces`}>
        <Button variant="secondary" aria-label={`${project.name} project settings`} onClick={() => navigate('project-settings', { project: project.id, page: 'members' })}>Project settings</Button>
      </SettingRow>)}</SettingRows>
    </Section>
    {joinable.length ? <Section title="Projects you’re not in" scope="Team"
      description="As an Admin you see only the projects you’re a member of: not their workspaces, conversations or members. Join project adds you with the role you pick; its members see that you joined, and the audit log records it.">
      <SettingRows label="Projects you’re not in">{joinable.map((entry) => <SettingRow key={entry.id} media={glyph(FolderPlus)} title={<>{entry.name}<Pill>Not a member</Pill></>}
        description={`${WORKSPACES.filter((workspace) => workspace.projectId === entry.id && !workspace.archived).length} open workspaces · ${count(entry.id)} members`}>
        <Button variant="secondary" leadingIcon={glyph(FolderPlus)} onClick={() => setJoining(entry.id)}>Join project</Button>
      </SettingRow>)}</SettingRows>
    </Section> : null}
    {joining ? <JoinProjectDialog projectId={joining} onClose={() => setJoining(null)} onJoined={() => navigate('project-settings', { project: joining, page: 'members' })} /> : null}
    {creating ? <NewProjectWizard onClose={() => setCreating(false)} /> : null}
  </>;
}

/** A project's members (people and bots) with their project roles. Its Leads manage them, as do Owners and Admins in
 * projects they're in. */
export function MembersSection({ project }: { project: string }) {
  const viewer = useViewer();
  useRoles();
  const live = memberships.use();
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<{ userId: string; roleId: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const manage = whyMembers(viewer.id, project);
  const owners = USERS.filter((user) => user.accountRole === 'owner');
  const rows = live.filter((entry) => entry.projectId === project);
  const leads = rows.filter((entry) => entry.roleId === 'lead' && findPrincipal(entry.userId)?.kind === 'person').map((entry) => findPrincipal(entry.userId)?.name ?? entry.userId);
  return <Section title={`Members of ${projectName(project)}`} scope="Project" readOnly={manage}
    description={<>Who sees {projectName(project)} and with which project role: people and bots alike. Lead is fixed with every permission, including Manage members, so a project’s Leads add and remove its members and set their roles. Owners and Admins can too in projects they’re in.{leads.length ? ` Leads here: ${leads.join(', ')}.` : ''}</>}
    actions={<Gate reason={manage} variant="primary" leadingIcon={glyph(Plus)} onOpen={() => setAdding(true)}>Add member</Gate>}>
    <SettingRows label={`Members of ${projectName(project)}`}>
      {owners.map((owner) => {
        const lock = viewer.accountRole !== 'owner' && viewer.accountRole !== 'admin' && manage === null
          ? `${owner.first} is an Owner: Owners are Lead in every project, and a Lead can’t change or remove them.` : 'Owners are Lead in every project; only an Owner changes another Owner';
        return <SettingRow key={owner.id} title={<span className="flex flex-wrap items-center gap-2"><Avatar userId={owner.id} size={24} />{owner.name}{owner.id === viewer.id ? <Pill tone="blue">You</Pill> : null}<Pill>Owner</Pill></span>}
          description={`${owner.email} · Lead in every project as an Owner`}>
          {viewer.accountRole !== 'owner' && viewer.accountRole !== 'admin' && manage === null ? <Pill tone="amber">Lead can’t change</Pill> : null}
          <Tooltip content={lock}><span><Pill tone="gray">Lead</Pill></span></Tooltip>
          <Act reason={lock} variant="tertiary" size="icon-compact" aria-label={`Remove ${owner.name} from ${projectName(project)}`} onClick={() => undefined}><Trash01 width={16} height={16} strokeWidth={1.5} /></Act>
        </SettingRow>;
      })}
      {rows.map((entry) => {
        const principal = findPrincipal(entry.userId);
        if (!principal) return null;
        const role = projectRoleById(entry.roleId);
        // A Lead can't change an Admin's project role or remove them; Owners and Admins can.
        const adminLock = principal.kind === 'person' && principal.accountRole === 'admin' && viewer.accountRole !== 'owner' && viewer.accountRole !== 'admin'
          ? `${principal.first} is an Admin: a Lead can’t change an Admin’s project role or remove them. Owners and Admins can.` : null;
        const reason = manage ?? adminLock;
        return <SettingRow key={entry.userId} title={<span className="flex flex-wrap items-center gap-2"><Avatar userId={entry.userId} size={24} />{principal.kind === 'bot' ? actorLabel(entry.userId) : principal.name}
          {entry.userId === viewer.id ? <Pill tone="blue">You</Pill> : null}{principal.kind === 'bot' ? <Pill tone="violet">Bot</Pill> : principal.accountRole === 'admin' ? <Pill>Admin</Pill> : null}
          {entry.joined ? <Pill tone="amber">{entry.joined}</Pill> : null}</span>}
          description={principal.kind === 'bot' ? principal.description : `${principal.email} · ${role?.description ?? ''}`}>
          {adminLock && !manage ? <Pill tone="amber">Lead can’t change</Pill> : null}
          <RoleSelect value={entry.roleId} label={`Project role for ${principal.name}`} disabled={reason !== null} reason={reason} onChange={(roleId) => setChanging({ userId: entry.userId, roleId })} />
          <Act reason={reason ?? (entry.userId === viewer.id ? 'Leave a project from its settings' : null)} variant="tertiary" size="icon-compact" aria-label={`Remove ${principal.name} from ${projectName(project)}`} onClick={() => setRemoving(entry.userId)}><Trash01 width={16} height={16} strokeWidth={1.5} /></Act>
        </SettingRow>;
      })}
    </SettingRows>
    <Note>Removing someone releases the handles they hold here; their personal resources detach from its workspaces. Every change is in the audit log, under who made it.</Note>
    {adding ? <AddMemberWizard project={project} onClose={() => setAdding(false)} /> : null}
    {changing ? <ChangeRoleDialog project={project} userId={changing.userId} to={changing.roleId} onClose={() => setChanging(null)} /> : null}
    {removing ? <RemoveMemberDialog project={project} userId={removing} onClose={() => setRemoving(null)} /> : null}
  </Section>;
}

/** An Admin joins a project they aren't in: they pick their project role, see the audit line it writes, and the join
 * shows in the project's member list. */
export function JoinProjectDialog({ projectId, onClose, onJoined }: { projectId: string; onClose(): void; onJoined?(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const roles = useRoles();
  const [roleId, setRoleId] = useState('lead');
  const [done, setDone] = useState(false);
  const name = projectName(projectId);
  const reason = whyAccount(viewer.id, 'account.team');
  if (reason) return <RefusedDialog id="join-project" title={`Join ${name}`} reason={reason} who="Owners and Admins" onClose={onClose} />;
  const audit = `Joined ${name} as ${roleName(roleId)} with Join project (Admin, wasn’t a member)`;
  const join = (): void => {
    setMembership(viewer.id, projectId, roleId, 'Joined just now · Admin');
    recordAudit({ actor: viewer.id, kind: 'team', project: projectId, text: audit });
    say(`You joined ${name} as ${roleName(roleId)} · its members see you joined; it’s in the audit log`);
    setDone(true);
  };
  return <FlowDialog id="join-project" title={`Join ${name}?`} description={`You’re an Admin but not a member, so you don’t see ${name}. Joining adds you to its members with the project role you pick.`} done={done} onClose={onClose}
    footer={done ? <><Button variant="secondary" onClick={onClose}>Done</Button>{onJoined ? <Button variant="primary" onClick={() => { onJoined(); onClose(); }}>Open {name}</Button> : null}</>
      : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" leadingIcon={glyph(FolderPlus)} onClick={join}>Join as {roleName(roleId)}</Button></>}>
    {done ? <FlowSuccess title={`You’re ${roleName(roleId)} in ${name}`}>Its workspaces, conversations and members show for you now. Its member list marks “Joined just now · Admin”, and the audit log has: {viewer.first} · {audit}.</FlowSuccess> : <>
      <ChoiceCards label="Your project role" value={roleId} onChange={setRoleId} choices={roles.map((role) => ({ id: role.id, title: role.name, detail: role.description }))} />
      <Summary rows={[['Member list', `${viewer.name} · ${roleName(roleId)} · “Joined just now · Admin”`], ['Audit log', `Just now · ${viewer.first} · ${audit}`], ['Who’s told', `${name}’s Leads: ${leadsOf(projectId).map((id) => findPrincipal(id)?.first ?? id).join(', ')}`]]} />
    </>}
  </FlowDialog>;
}
