// Roles at two levels, with no shared names. An account role (fixed: Owner, Admin, Member) decides only the account
// pages. A project role (one per project membership) decides everything inside that project; Lead is fixed with every
// permission, the rest are the team's to edit. People and bots hold both kinds alike (a bot is Member at most). You see
// a project only as a member of it; Owners are the one exception, Lead in every project. The role editor writes this
// module's store, so every disabled action in the mock follows it.
import { useSyncExternalStore } from 'react';
import { PROJECTS, findPrincipal, memberships, projectRoleIdOf, type AccountRoleId } from '../data.js';

export type { AccountRoleId } from '../data.js';

export type ProjectAction =
  | 'members.manage' | 'project.settings'
  | 'workspace.create' | 'workspace.claim' | 'workspace.ask' | 'workspace.takeover' | 'workspace.assign' | 'workspace.archive' | 'workspace.delete'
  | 'phase.plan' | 'phase.code' | 'phase.review' | 'phase.ship'
  | 'environment.approve'
  | 'secrets.view' | 'secrets.edit' | 'connections.edit'
  | 'automations.propose' | 'automations.enable'
  | 'chatter.post' | 'chatter.pin' | 'chatter.close';
export type AccountAction = 'account.view' | 'account.team' | 'account.bots' | 'account.owners' | 'account.roles' | 'account.inference' | 'account.connections' | 'account.credentials' | 'account.resources' | 'account.audit' | 'account.billing';
export type Action = ProjectAction | AccountAction;

export interface PermissionGroup<A extends Action> { title: string; description: string; rows: ReadonlyArray<{ action: A; label: string; phrase: string }> }

/** The project matrix's rows, grouped as the role editor shows them; `phrase` completes "… can't …". */
export const PROJECT_PERMISSIONS: ReadonlyArray<PermissionGroup<ProjectAction>> = [
  { title: 'Members and settings', description: 'Who is in the project and with which project role, and the project’s own settings. Lead has both; Admins manage members in projects they’re in.', rows: [
    { action: 'members.manage', label: 'Manage members: add, remove, set project roles', phrase: 'manage members' },
    { action: 'project.settings', label: 'Edit project settings: inference profile, plugins, automations', phrase: 'edit project settings' },
  ] },
  { title: 'Workspaces', description: 'Who may start work and who may hold the handle.', rows: [
    { action: 'workspace.create', label: 'Create workspaces', phrase: 'create workspaces' },
    { action: 'workspace.claim', label: 'Claim a free workspace', phrase: 'claim workspaces' },
    { action: 'workspace.ask', label: 'Ask a holder for the handle', phrase: 'ask for the handle' },
    { action: 'workspace.takeover', label: 'Take over a held workspace', phrase: 'take over a held workspace' },
    { action: 'workspace.assign', label: 'Assign holders', phrase: 'assign holders' },
    { action: 'workspace.archive', label: 'Archive workspaces', phrase: 'archive workspaces' },
    { action: 'workspace.delete', label: 'Delete workspaces', phrase: 'delete workspaces' },
  ] },
  { title: 'Phase moves', description: 'Per target phase. An agent or a bot whose role can’t move proposes; a person whose role allows it accepts.', rows: [
    { action: 'phase.plan', label: 'Move into Plan', phrase: 'move into Plan' },
    { action: 'phase.code', label: 'Move into Code', phrase: 'move into Code' },
    { action: 'phase.review', label: 'Move into Review', phrase: 'move into Review' },
    { action: 'phase.ship', label: 'Move into Ship', phrase: 'move into Ship' },
  ] },
  { title: 'Environment', description: 'Approval requests go to every person whose project role may approve them. Bots never approve.', rows: [
    { action: 'environment.approve', label: 'Approve environment requests', phrase: 'approve environment requests' },
  ] },
  { title: 'Secrets & connections', description: 'Values are write-only; seeing means names, rules and use. Each secret’s rule (who may use it, how it’s delivered) is the Leads’ to edit.', rows: [
    { action: 'secrets.view', label: 'See project secrets and their rules', phrase: 'see project secrets' },
    { action: 'secrets.edit', label: 'Add, rotate and replace project secrets', phrase: 'edit project secrets' },
    { action: 'connections.edit', label: 'Edit project connections', phrase: 'edit project connections' },
  ] },
  { title: 'Automations', description: 'Agents can propose automations too; enabling one is a person’s call.', rows: [
    { action: 'automations.propose', label: 'Propose automations', phrase: 'propose automations' },
    { action: 'automations.enable', label: 'Enable and pause automations', phrase: 'enable automations' },
  ] },
  { title: 'Chatter', description: 'Topic actions in the project’s Chatter.', rows: [
    { action: 'chatter.post', label: 'Post', phrase: 'post in Chatter' },
    { action: 'chatter.pin', label: 'Pin and rename topics', phrase: 'pin topics' },
    { action: 'chatter.close', label: 'Close topics', phrase: 'close topics' },
  ] },
];
/** The account matrix's rows: account pages only, nothing inside a project. */
export const ACCOUNT_PERMISSIONS: PermissionGroup<AccountAction> = { title: 'Account', description: 'Account pages only. What someone may do inside a project comes from their project role there.', rows: [
  { action: 'account.view', label: 'See account pages (read only) and their own sections', phrase: 'see account pages' },
  { action: 'account.team', label: 'Invite and remove users, set account roles, allowed email domains, memberships in projects they’re in', phrase: 'manage the team' },
  { action: 'account.bots', label: 'Create bots (sponsored by their creator), reassign and suspend bots', phrase: 'manage bots' },
  { action: 'account.roles', label: 'Edit project roles', phrase: 'edit project roles' },
  { action: 'account.inference', label: 'Edit inference profiles', phrase: 'edit inference profiles' },
  { action: 'account.connections', label: 'Manage team plugins, skills and the Slack app', phrase: 'manage team plugins and skills' },
  { action: 'account.credentials', label: 'Manage team secrets and their rules', phrase: 'manage team secrets' },
  { action: 'account.resources', label: 'Manage team machines and browsers', phrase: 'manage team machines and browsers' },
  { action: 'account.audit', label: 'Read the audit log', phrase: 'read the audit log' },
  { action: 'account.owners', label: 'Make, change or remove Owners', phrase: 'change Owners' },
  { action: 'account.billing', label: 'Billing', phrase: 'see billing' },
] };

export interface AccountRole { id: AccountRoleId; name: string; description: string; allowed: ReadonlySet<AccountAction> }
const ACCOUNT_ALL = ACCOUNT_PERMISSIONS.rows.map((row) => row.action);
const ADMIN: readonly AccountAction[] = ['account.view', 'account.team', 'account.bots', 'account.roles', 'account.inference', 'account.connections', 'account.credentials', 'account.resources', 'account.audit'];
/** Fixed; not editable. */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  { id: 'owner', name: 'Owner', description: 'Everything, including billing and other Owners. Lead in every project.', allowed: new Set(ACCOUNT_ALL) },
  { id: 'admin', name: 'Admin', description: 'Runs the account: team, bots, project roles, inference, team connections and credentials, audit log. Sees only projects they’re a member of; joins others with Join project, which is recorded.', allowed: new Set(ADMIN) },
  { id: 'member', name: 'Member', description: 'No account administration: account pages read only, plus their own sections. The most a bot can be.', allowed: new Set<AccountAction>(['account.view']) },
];
export function accountRoleById(id: string): AccountRole | undefined { return ACCOUNT_ROLES.find((role) => role.id === id); }
export function accountRoleOf(principalId: string): AccountRole | null {
  const principal = findPrincipal(principalId);
  return principal ? accountRoleById(principal.accountRole) ?? null : null;
}

export interface ProjectRole {
  id: string;
  name: string;
  description: string;
  /** Lead: fixed, with every permission; Owners hold it in every project. Not editable. */
  fixed: boolean;
  /** A role the team made; the defaults can be edited but not deleted. */
  custom: boolean;
  allowed: ReadonlySet<ProjectAction>;
}
const PROJECT_ALL = PROJECT_PERMISSIONS.flatMap((group) => group.rows.map((row) => row.action));
const BASE: readonly ProjectAction[] = ['workspace.create', 'workspace.claim', 'workspace.ask', 'workspace.archive', 'phase.plan', 'automations.propose', 'chatter.post'];
const DEFAULT_PROJECT_ROLES: readonly ProjectRole[] = [
  { id: 'lead', name: 'Lead', description: 'Fixed, with every permission: manages the project’s members and their roles, takes over and assigns, every phase, approvals, secrets and their rules, connections, automations.', fixed: true, custom: false, allowed: new Set(PROJECT_ALL) },
  { id: 'engineer', name: 'Engineer', description: 'Builds: every phase move, approves environment requests, adds and rotates secrets.', fixed: false, custom: false,
    allowed: new Set<ProjectAction>([...BASE, 'phase.code', 'phase.review', 'phase.ship', 'environment.approve', 'secrets.view', 'secrets.edit', 'chatter.pin', 'chatter.close']) },
  { id: 'designer', name: 'Designer', description: 'Plans and reviews; may not move into Code or Ship.', fixed: false, custom: false,
    allowed: new Set<ProjectAction>([...BASE, 'phase.review', 'secrets.view', 'chatter.pin']) },
  { id: 'contributor', name: 'Contributor', description: 'Claims free workspaces, plans and codes; asks for held ones.', fixed: false, custom: false,
    allowed: new Set<ProjectAction>([...BASE, 'phase.code']) },
  { id: 'viewer', name: 'Viewer', description: 'Reads, comments, leaves notes beside the composer, posts in Chatter, asks for the handle.', fixed: false, custom: false,
    allowed: new Set<ProjectAction>(['workspace.ask', 'chatter.post']) },
];

let projectRoles: readonly ProjectRole[] = DEFAULT_PROJECT_ROLES;
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function publish(next: readonly ProjectRole[]): void { projectRoles = next; for (const listener of listeners) listener(); }

/** The project roles, re-rendering when the role editor changes one (and when a membership changes). */
export function useRoles(): readonly ProjectRole[] { memberships.use(); return useSyncExternalStore(subscribe, () => projectRoles); }
export function projectRoleById(id: string): ProjectRole | undefined { return projectRoles.find((role) => role.id === id); }
export function roleName(id: string): string { return projectRoleById(id)?.name ?? accountRoleById(id)?.name ?? id; }

export function toggleRoleAction(id: string, action: ProjectAction): void {
  publish(projectRoles.map((role) => {
    if (role.id !== id || role.fixed) return role;
    const allowed = new Set(role.allowed);
    if (allowed.has(action)) allowed.delete(action); else allowed.add(action);
    return { ...role, allowed };
  }));
}
export function addCustomRole(name: string, from: string): string {
  const base = projectRoleById(from) ?? projectRoleById('contributor')!;
  const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${projectRoles.length}`;
  publish([...projectRoles, { id, name, description: `Starts from ${base.name}.`, fixed: false, custom: true, allowed: new Set(base.allowed) }]);
  return id;
}
export function deleteRole(id: string): void { publish(projectRoles.filter((role) => role.id !== id || !role.custom)); }

function phraseOf(action: Action): string {
  const groups: ReadonlyArray<PermissionGroup<Action>> = [...PROJECT_PERMISSIONS, ACCOUNT_PERMISSIONS];
  for (const group of groups) {
    const row = group.rows.find((entry) => entry.action === action);
    if (row) return row.phrase;
  }
  return action;
}

/** The project role a person or bot acts with in a project: their membership's; an Owner's is Lead everywhere; null
 * when they are not a member. */
export function projectRoleOf(principalId: string, projectId: string): ProjectRole | null {
  const id = projectRoleIdOf(principalId, projectId);
  return id ? projectRoleById(id) ?? null : null;
}

function isAccountAction(action: Action): action is AccountAction { return action.startsWith('account.'); }

/** Null when `principalId` may do `action` (in `projectId` for a project action), else the reason naming the role that
 * refuses it: "Your project role in Crumb (Designer) can't move into Code", or for a bot "Deps bot’s project role in
 * Crumb (Contributor) can't move into Review". */
export function why(principalId: string, projectId: string, action: Action): string | null {
  if (isAccountAction(action)) return whyAccount(principalId, action);
  const principal = findPrincipal(principalId);
  const whose = principal?.kind === 'bot' ? `${principal.name}’s` : 'Your';
  const project = PROJECTS.find((entry) => entry.id === projectId)?.name ?? 'this project';
  const role = projectRoleOf(principalId, projectId);
  if (!role) return principal?.kind === 'bot' ? `${principal.name} isn’t a member of ${project}` : `You’re not a member of ${project}`;
  return role.allowed.has(action) ? null : `${whose} project role in ${project} (${role.name}) can’t ${phraseOf(action)}`;
}
/** "Your account role (Member) can't edit inference profiles". */
export function whyAccount(principalId: string, action: AccountAction): string | null {
  const role = accountRoleOf(principalId);
  if (!role) return 'Not a user of this account';
  return role.allowed.has(action) ? null : `Your account role (${role.name}) can’t ${phraseOf(action)}`;
}
/** Who may change a project's members: its Leads (Manage members), and Owners and Admins in projects they're in. An
 * Admin outside a project has to join it first. */
export function whyMembers(principalId: string, projectId: string): string | null {
  const member = projectRoleOf(principalId, projectId) !== null;
  if (member && whyAccount(principalId, 'account.team') === null) return null;
  if (!member && whyAccount(principalId, 'account.team') === null) return `You’re not a member of ${PROJECTS.find((entry) => entry.id === projectId)?.name ?? 'this project'}: join it first`;
  return why(principalId, projectId, 'members.manage');
}
/** Hook form: re-renders when the role editor changes a role. */
export function useWhy(principalId: string, projectId: string, action: Action): string | null { useRoles(); return why(principalId, projectId, action); }
