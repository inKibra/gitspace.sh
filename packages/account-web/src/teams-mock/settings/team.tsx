// Crumb & Co › People & roles: people with their account role and their project role in each project (each opens
// their pages for an Owner or Admin), invites limited to the team's allowed email domains, and the role editor (fixed
// account roles; Lead fixed, the other project roles editable). Owners and Admins manage; Members read. Every action
// opens its dialog or wizard from ../flows/team.tsx. The project role editor writes roles.ts and memberships write
// data.ts, so a change here changes what the shell allows at once.
import { glyph } from '../../glyph.js';
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger,
  TabsSubtle, TabsSubtleItem, Tooltip,
} from '@gitspace/ui';
import { Check, Lock01, Mail01, Plus, Trash01, UserPlus01, XClose } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { actorLabel, bots, memberships, setMembership, TEAM, USERS, userOf, visibleProjects, type Bot, type Membership, type Principal, type User } from '../data.js';
import { AllowDomainDialog, DeleteRoleDialog, InviteActionDialog, InviteFlow, NewRoleFlow, RemoveDomainAllowanceDialog, RemovePersonFlow, RoleChangeDialog } from '../flows/team.js';
import { allowedDomains, invites as inviteStore } from '../flows/team-data.js';
import { useMock, useViewer } from '../viewer.js';
import { accountRoleChanges, ACCOUNT_NAME, ACTIVE_PROJECTS, presenceSeenBy, projectName, recordAudit, removedUsers, type Invite } from './data.js';
import { Act, Avatar, Note, Pill, Section, SettingRow, SettingRows, useHeld } from './parts.js';
import {
  ACCOUNT_PERMISSIONS, ACCOUNT_ROLES, PROJECT_PERMISSIONS, accountRoleById, roleName, toggleRoleAction, useRoles, whyAccount, whyMembers,
  type AccountRole, type AccountRoleId, type ProjectAction, type ProjectRole,
} from './roles.js';

const TABS = ['users', 'invites', 'roles'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Readonly<Record<Tab, string>> = { users: 'People', invites: 'Invites', roles: 'Roles' };
const PASSKEYS: Readonly<Record<string, { passkeys: number; devices: number; active: string }>> = {
  maya: { passkeys: 2, devices: 3, active: 'now' }, theo: { passkeys: 1, devices: 2, active: '4m ago' }, rina: { passkeys: 2, devices: 2, active: 'now' },
  sam: { passkeys: 1, devices: 1, active: '1h ago' }, jules: { passkeys: 1, devices: 1, active: 'yesterday' },
};
type AccountRoles = Readonly<Record<string, AccountRoleId>>;

export function TeamPage() {
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return TABS.find((entry) => entry === requested) ?? 'users';
  });
  const viewer = useViewer();
  const invites = inviteStore.use();
  const botList = bots.use();
  const gone = removedUsers.use();
  const roles = accountRoleChanges.use();
  const users = USERS.filter((user) => !gone.has(user.id));
  const manage = whyAccount(viewer.id, 'account.team');
  const count: Partial<Record<Tab, number>> = { users: users.length, invites: invites.length };
  return <>
    <TabsSubtle selectedIndex={TABS.indexOf(tab)} idPrefix="team-tab" onSelect={(next) => setTab(TABS[next] ?? 'users')}>
      {TABS.map((entry, position) => <TabsSubtleItem key={entry} index={position} label={count[entry] === undefined ? TAB_LABEL[entry] : `${TAB_LABEL[entry]} · ${count[entry]}`} />)}
    </TabsSubtle>
    {tab === 'users' ? <UsersTab users={users} manage={manage} onInvite={() => setTab('invites')} /> : null}
    {tab === 'invites' ? <InvitesTab invites={invites} manage={manage} /> : null}
    {tab === 'roles' ? <RolesTab accountRoles={Object.fromEntries(users.map((user) => [user.id, roles[user.id] ?? user.accountRole]))} bots={botList} /> : null}
  </>;
}

/** "Lead in Crumb · Engineer in Ledger"; an Owner is Lead everywhere. Only projects the viewer is in are named. */
export function projectRoles(accountRole: AccountRoleId, own: readonly Membership[]): ReactNode {
  if (accountRole === 'owner') return <span className="text-caption text-muted-foreground">Lead in every project (Owner)</span>;
  if (!own.length) return <span className="text-caption text-muted-foreground">No projects you can see</span>;
  return <span className="text-caption text-foreground">{own.map((entry) => `${roleName(entry.roleId)} in ${projectName(entry.projectId)}`).join(' · ')}</span>;
}

/** The projects whose members the viewer may change: an Owner's are all of them; anyone else's, the ones they're in
 * where they may manage members (Admins, Leads). */
export function managedProjects(viewerId: string): readonly string[] {
  return ACTIVE_PROJECTS.filter((project) => whyMembers(viewerId, project.id) === null).map((project) => project.id);
}

/** An Owner's or Admin's account-role picker for one person. Picking another role opens the change's dialog: a
 * promotion says what they gain and takes the viewer's passkey; a demotion says what they lose and, for an Admin who
 * sponsors bots becoming Member, hands the bots to another Admin or Owner or blocks them. */
export function AccountRoleSelect({ user }: { user: User }) {
  const viewer = useViewer();
  const roles = accountRoleChanges.use();
  const [changing, setChanging] = useState<{ from: AccountRoleId; to: AccountRole } | null>(null);
  const manage = whyAccount(viewer.id, 'account.team');
  const ownerReason = whyAccount(viewer.id, 'account.owners');
  const role = roles[user.id] ?? user.accountRole;
  const owners = USERS.filter((entry) => (roles[entry.id] ?? entry.accountRole) === 'owner');
  const lastOwner = role === 'owner' && owners.length === 1;
  const ownerOnly = role === 'owner' ? ownerReason : null;
  return <>
    <Select value={role} disabled={manage !== null || ownerOnly !== null || lastOwner} onValueChange={(value) => {
      const next = accountRoleById(value);
      if (next && next.id !== role) setChanging({ from: role, to: next });
    }}>
      <Tooltip content={manage ?? ownerOnly ?? (lastOwner ? 'The account keeps at least one Owner' : 'Account role')}><span><SelectTrigger aria-label={`Account role for ${user.name}`} /></span></Tooltip>
      <SelectContent>{ACCOUNT_ROLES.map((entry, position) => <SelectItem key={entry.id} value={entry.id} index={position} disabled={entry.id === 'owner' && ownerReason !== null}>{entry.name}</SelectItem>)}</SelectContent>
    </Select>
    {changing ? <RoleChangeDialog user={user} from={changing.from} to={changing.to} onClose={() => setChanging(null)} /> : null}
  </>;
}

/** Projects and Remove for one person, as Owners and Admins see them on People and in People & roles. */
export function PersonAdminActions({ user }: { user: User }) {
  const viewer = useViewer();
  const roles = accountRoleChanges.use();
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const manage = whyAccount(viewer.id, 'account.team');
  const role = roles[user.id] ?? user.accountRole;
  const ownerOnly = role === 'owner' ? whyAccount(viewer.id, 'account.owners') : null;
  const lastOwner = role === 'owner' && USERS.filter((entry) => (roles[entry.id] ?? entry.accountRole) === 'owner').length === 1;
  return <>
    <Act reason={manage ?? (role === 'owner' ? 'Owners are Lead in every project' : null)} variant="ghost" onClick={() => setEditing(true)}>Projects</Act>
    <Act reason={manage ?? ownerOnly ?? (user.id === viewer.id ? 'Leave the team from You › Profile' : lastOwner ? 'The account keeps at least one Owner' : null)} variant="tertiary" size="icon-compact" aria-label={`Remove ${user.name}`} onClick={() => setRemoving(true)}><Trash01 width={16} height={16} strokeWidth={1.5} /></Act>
    {editing ? <MembershipsDialog principal={user} onClose={() => setEditing(false)} /> : null}
    {removing ? <RemovePersonFlow user={user} onClose={() => setRemoving(false)} /> : null}
  </>;
}

// ── People ──

function UsersTab({ users, manage, onInvite }: { users: readonly User[]; manage: string | null; onInvite(): void }) {
  const viewer = useViewer();
  const { navigate } = useMock();
  const held = useHeld();
  useRoles();
  const live = memberships.use();
  const botList = bots.use();
  const roles = accountRoleChanges.use();
  const seen = visibleProjects(viewer.id);
  return <Section title="People" scope="Team" readOnly={manage ? `${manage}: only Owners and Admins change roles and memberships` : null}
    description={<>Everyone with a login to {ACCOUNT_NAME}, all at {TEAM.domains.join(', ')}. The account role decides account pages; the project role decides what they may do in each project. Each opens their page on People: what they’ve connected, with Revoke for Owners and Admins.</>}
    actions={<Act reason={manage} variant="primary" leadingIcon={glyph(UserPlus01)} onClick={onInvite}>Invite</Act>}>
    <SettingRows label="People">{users.map((user) => {
      const role = roles[user.id] ?? user.accountRole;
      const holding = held(user.id);
      const sponsors = botList.filter((bot) => bot.sponsor === user.id);
      const presence = presenceSeenBy(viewer.id, user.id);
      const keys = PASSKEYS[user.id] ?? { passkeys: 1, devices: 1, active: '—' };
      return <SettingRow key={user.id}
        title={<span data-person-row={user.id} className="flex flex-wrap items-center gap-2"><Avatar userId={user.id} size={24} />{user.name}{user.id === viewer.id ? <Pill tone="blue">You</Pill> : null}<Pill>{accountRoleById(role)?.name}</Pill>
          <Pill tone={presence.state === 'online' ? 'green' : presence.state === 'away' ? 'amber' : 'gray'}>{presence.state === 'online' ? 'Online' : presence.state === 'away' ? 'Away' : 'Offline'}</Pill></span>}
        description={<>{user.email} · {keys.passkeys} {keys.passkeys === 1 ? 'passkey' : 'passkeys'} · active {keys.active}</>}
        extra={<div className="mt-1 flex flex-col gap-0.5">
          {projectRoles(role, live.filter((entry) => entry.userId === user.id && seen.has(entry.projectId)))}
          <span className="text-caption text-muted-foreground">{holding.length ? `Holds ${holding.join(', ')}` : 'Holds no handle'}{sponsors.length ? ` · sponsors ${sponsors.map((bot) => bot.name).join(', ')}` : ''}</span>
        </div>}>
        <AccountRoleSelect user={user} />
        <Button variant="secondary" aria-label={`Open ${user.name}`} onClick={() => navigate('person', { person: user.id })}>Open</Button>
        <PersonAdminActions user={user} />
      </SettingRow>;
    })}</SettingRows>
  </Section>;
}

/** A project-role picker per project in `projects`. */
export function ProjectRolePicker({ projects, value, onChange }: { projects: readonly string[]; value: Readonly<Record<string, string>>; onChange(next: Readonly<Record<string, string>>): void }) {
  const roles = useRoles();
  return <div className="flex flex-col gap-3">
    {projects.map((projectId) => <div key={projectId} className="flex items-center justify-between gap-3">
      <span className="text-body text-foreground">{projectName(projectId)}</span>
      <Select value={value[projectId] ?? 'none'} onValueChange={(next) => { const map = { ...value }; if (next === 'none') delete map[projectId]; else map[projectId] = next; onChange(map); }}>
        <SelectTrigger aria-label={`Project role in ${projectName(projectId)}`} />
        <SelectContent>
          <SelectItem value="none" index={0}>Not a member</SelectItem>
          {roles.map((role, position) => <SelectItem key={role.id} value={role.id} index={position + 1}>{role.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>)}
  </div>;
}

/** A person's or a bot's projects, in the projects the viewer may manage members of; the rest stay as they are. */
export function MembershipsDialog({ principal, onClose }: { principal: Principal; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const projects = managedProjects(viewer.id);
  const hidden = ACTIVE_PROJECTS.filter((project) => !visibleProjects(viewer.id).has(project.id));
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(memberships.get().filter((entry) => entry.userId === principal.id && projects.includes(entry.projectId)).map((entry) => [entry.projectId, entry.roleId])));
  const save = (): void => {
    for (const projectId of projects) setMembership(principal.id, projectId, draft[projectId] ?? null);
    recordAudit({ actor: viewer.id, kind: 'team', text: `Set ${actorLabel(principal.id)}’s projects: ${Object.entries(draft).map(([projectId, roleId]) => `${roleName(roleId)} in ${projectName(projectId)}`).join(', ') || 'none'}` });
    say(`Saved ${principal.first}’s projects`);
    onClose();
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{principal.kind === 'bot' ? principal.name : `${principal.name}’s`} projects</DialogTitle><DialogDescription>{principal.first} sees only the projects below, with that project role in each. Removing one releases their handles there; their personal resources detach from its workspaces.</DialogDescription></DialogHeader>
    <ProjectRolePicker projects={projects} value={draft} onChange={setDraft} />
    {hidden.length ? <Note>You’re not in {hidden.map((project) => project.name).join(', ')}, so you don’t see {hidden.length === 1 ? 'it' : 'them'} or {principal.first}’s membership there. Join it from Projects to manage its members.</Note> : null}
    <DialogFooter><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save projects</Button></DialogFooter>
  </DialogContent></Dialog>;
}
// ── Invites ──

function InvitesTab({ invites, manage }: { invites: readonly Invite[]; manage: string | null }) {
  const viewer = useViewer();
  const { say } = useMock();
  const domains = allowedDomains.use();
  const [inviting, setInviting] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const [disallowing, setDisallowing] = useState<string | null>(null);
  const [acting, setActing] = useState<{ invite: Invite; action: 'resend' | 'revoke' | 'link' } | null>(null);
  return <>
    <Section title="Allowed email domains" scope="Team" readOnly={manage}
      description={`Invites go only to addresses at these domains, and invite links accept only them. ${ACCOUNT_NAME} has no SSO: everyone signs in with their own passkeys. Owners and Admins change the list.`}>
      <SettingRows label="Allowed email domains">
        <SettingRow media={glyph(Mail01)} title="Domains" description={<span className="flex flex-wrap items-center gap-1.5 pt-1">{domains.map((domain) => <span key={domain} data-domain={domain} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 pl-2.5 pr-1 font-mono text-[12px] text-foreground shadow-[inset_0_0_0_1px_var(--border)]">@{domain}
          <Tooltip content={manage ?? `Stop allowing ${domain}`}><button type="button" aria-label={`Remove ${domain}`} className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-hover"
            onClick={() => { if (manage) say(manage); else setDisallowing(domain); }}><XClose width={12} height={12} /></button></Tooltip>
        </span>)}</span>}>
          <Act reason={manage} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setAllowing(true)}>Add domain</Act>
        </SettingRow>
      </SettingRows>
    </Section>
    <Section title="Pending invites" scope="Team" readOnly={manage} description="An invite names the account role and a project role in each project. Accepting creates a new user with their own passkey; nothing is shared with any other team they’re in."
      actions={<Act reason={manage} variant="primary" leadingIcon={glyph(UserPlus01)} onClick={() => setInviting(true)}>Invite</Act>}>
      {invites.length ? <SettingRows label="Pending invites">{invites.map((invite) => <SettingRow key={invite.id} media={glyph(invite.how === 'email' ? Mail01 : Lock01)}
        title={<span data-invite={invite.to} className="inline-flex flex-wrap items-center gap-2">{invite.to}<Pill>{roleName(invite.accountRole)}</Pill></span>}
        description={<>{invite.projects.map((entry) => `${roleName(entry.roleId)} in ${projectName(entry.projectId)}`).join(' · ') || 'Lead in every project'} · invited by {userOf(invite.by).first} · expires {invite.expires}{invite.uses ? ` · ${invite.uses}` : ''}</>}>
        {invite.how === 'link' ? <Act reason={manage} variant="ghost" onClick={() => setActing({ invite, action: 'link' })}>Copy link</Act> : <Act reason={manage} variant="ghost" onClick={() => setActing({ invite, action: 'resend' })}>Resend</Act>}
        <Act reason={manage} variant="ghost" onClick={() => setActing({ invite, action: 'revoke' })}>Revoke</Act>
      </SettingRow>)}</SettingRows> : <Note>No pending invites.</Note>}
    </Section>
    {inviting ? <InviteFlow projects={managedProjects(viewer.id)} onClose={() => setInviting(false)} /> : null}
    {allowing ? <AllowDomainDialog onClose={() => setAllowing(false)} /> : null}
    {disallowing ? <RemoveDomainAllowanceDialog domain={disallowing} onClose={() => setDisallowing(null)} /> : null}
    {acting ? <InviteActionDialog invite={acting.invite} action={acting.action} onClose={() => setActing(null)} /> : null}
  </>;
}

/** Invite, as People shows it: the same wizard, limited to the allowed domains. */
export function InviteButton() {
  const viewer = useViewer();
  const [open, setOpen] = useState(false);
  return <>
    <Act reason={whyAccount(viewer.id, 'account.team')} variant="primary" leadingIcon={glyph(UserPlus01)} onClick={() => setOpen(true)}>Invite</Act>
    {open ? <InviteFlow projects={managedProjects(viewer.id)} onClose={() => setOpen(false)} /> : null}
  </>;
}

// ── Roles ──

function Mark({ on }: { on: boolean }) {
  return on ? <Check width={15} height={15} strokeWidth={2} /> : <span className="text-muted-foreground">—</span>;
}
function MatrixFrame({ head, children }: { head: ReactNode; children: ReactNode }) {
  return <div className="overflow-x-auto rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
    <table className="w-full min-w-[46rem] border-collapse text-body">
      <thead className="bg-surface-2"><tr className="border-b border-border">{head}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}
function GroupRow({ title, description, span }: { title: string; description: string; span: number }) {
  return <tr className="bg-surface-1"><td colSpan={span} className="px-3 pb-1 pt-3"><span className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</span><span className="ml-2 text-caption text-muted-foreground">{description}</span></td></tr>;
}

function RolesTab({ accountRoles, bots }: { accountRoles: AccountRoles; bots: readonly Bot[] }) {
  const viewer = useViewer();
  const { say } = useMock();
  const roles = useRoles();
  const live = memberships.use();
  const edit = whyAccount(viewer.id, 'account.roles');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProjectRole | null>(null);
  const accountCount = (id: AccountRoleId) => Object.values(accountRoles).filter((role) => role === id).length;
  const projectCount = (role: ProjectRole) => new Set(live.filter((entry) => entry.roleId === role.id).map((entry) => entry.userId)).size + (role.fixed ? accountCount('owner') : 0);
  const cell = (role: ProjectRole, action: ProjectAction) => {
    const on = role.allowed.has(action);
    const reason = role.fixed ? 'Lead is fixed: it has every permission' : edit;
    return <td key={role.id} className="px-2 py-1.5 text-center">
      <Tooltip content={reason ?? `${on ? 'Remove from' : 'Allow for'} ${role.name}`}><button type="button" aria-pressed={on} aria-label={`${role.name}: ${action}`}
        className={`inline-flex size-7 items-center justify-center rounded-md ${on ? 'bg-active text-foreground' : ''} ${reason ? 'cursor-default' : 'hover:bg-hover'}`}
        onClick={() => { if (reason) say(reason); else toggleRoleAction(role.id, action); }}><Mark on={on} /></button></Tooltip>
    </td>;
  };
  return <>
    <Section title="Account roles" scope="Team" readOnly="Account roles are fixed"
      description="Decide only the account pages. Nothing inside a project: there, everyone acts with their project role. Owners are the one exception, Lead in every project. Bots are Member at most.">
      <MatrixFrame head={<>
        <th className="px-3 py-2 text-left text-caption font-medium text-muted-foreground">Account permission</th>
        {ACCOUNT_ROLES.map((role) => <th key={role.id} className="px-2 py-2 text-center align-bottom"><Tooltip content={role.description}><span className="flex flex-col items-center gap-1">
          <span className="text-body font-semibold text-foreground">{role.name}</span>
          <Badge size="compact" color="gray">Fixed</Badge>
          <span className="text-caption tabular-nums text-muted-foreground">{accountCount(role.id)} {accountCount(role.id) === 1 ? 'user' : 'users'}{role.id === 'member' ? ` · ${bots.length} bots` : ''}</span>
        </span></Tooltip></th>)}
      </>}>
        {ACCOUNT_PERMISSIONS.rows.map((row) => <tr key={row.action} className="border-t border-border/60"><td className="px-3 py-1.5 text-body text-foreground">{row.label}</td>
          {ACCOUNT_ROLES.map((role) => <td key={role.id} className="px-2 py-1.5 text-center"><span className={`inline-flex size-7 items-center justify-center rounded-md ${role.allowed.has(row.action) ? 'bg-active text-foreground' : ''}`}><Mark on={role.allowed.has(row.action)} /></span></td>)}
        </tr>)}
      </MatrixFrame>
    </Section>

    <Section title="Project roles" scope="Team" readOnly={edit}
      description="Given per project membership, to people and bots alike; they decide everything inside the project. Lead is fixed with every permission, including Manage members, so a project’s Leads run its membership. The rest are yours to edit, and changes apply at once to everyone holding the role in any project."
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setCreating(true)}>New role</Act>}>
      <MatrixFrame head={<>
        <th className="px-3 py-2 text-left text-caption font-medium text-muted-foreground">Project permission</th>
        {roles.map((role) => <th key={role.id} className="px-2 py-2 text-center align-bottom"><Tooltip content={role.description}><span className="flex flex-col items-center gap-1">
          <span className="text-body font-semibold text-foreground">{role.name}</span>
          {role.fixed ? <Badge size="compact" color="gray">Fixed · all</Badge> : role.custom ? <Badge size="compact" color="violet">Custom</Badge> : <Badge size="compact" color="blue">Default</Badge>}
          <span className="text-caption tabular-nums text-muted-foreground">{projectCount(role)} {projectCount(role) === 1 ? 'member' : 'members'}</span>
          {role.custom ? <button type="button" className="text-caption text-muted-foreground underline-offset-2 hover:underline" onClick={() => { if (edit) say(edit); else setDeleting(role); }}>Delete</button> : null}
        </span></Tooltip></th>)}
      </>}>
        {PROJECT_PERMISSIONS.flatMap((group) => [
          <GroupRow key={group.title} title={group.title} description={group.description} span={roles.length + 1} />,
          ...group.rows.map((row) => <tr key={row.action} data-permission={row.action} className="border-t border-border/60"><td className="px-3 py-1.5 text-body text-foreground">{row.label}</td>{roles.map((role) => cell(role, row.action))}</tr>),
        ])}
      </MatrixFrame>
      <Note>Agents act for the account. A phase move or an approval is checked against the project role of whoever approves it or started the turn; otherwise the agent proposes and a person whose project role allows it accepts. A bot is checked against its own project role, and never approves environment requests or steps up credentials.</Note>
    </Section>
    {creating ? <NewRoleFlow onClose={() => setCreating(false)} /> : null}
    {deleting ? <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} /> : null}
  </>;
}
