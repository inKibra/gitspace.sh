// The Inbox's rows from what the browser already holds (docs/INBOX-DESIGN.md §3, §6): each workspace's status row with
// its open items, the directory's machines and placements, the storage incidents and each project's open Chatter issue
// topics. Approvals are one row per content hash across workspaces; the badge counts fresh rows that block work.
import type { AccountDirectorySnapshot, WorkspaceStatusRow } from '@gitspace/protocol/account-directory';
import type { ChatterTopic } from '@gitspace/protocol/chatter-contract';
import type { StorageIncidentView } from '@gitspace/protocol/rpc-contract';
import type { WaitingItem } from '@gitspace/protocol-workspace';

/** A row waiting longer than this leaves the count; it stays listed. */
export const STALE_AFTER_MS = 2 * 24 * 60 * 60_000;

/** One open item of one workspace, keyed for the tab's held actions. */
export interface WorkspaceItem { key: string; projectId: string; workspaceId: string; item: WaitingItem }

/** One execution waiting for approval, by content hash: where it is declared and which agents' questions wait on it. */
export interface ApprovalEntry {
  key: string;
  projectId: string;
  hash: string;
  label: string;
  fileName: string | null;
  phase: string | null;
  declaredIn: readonly string[];
  waiting: readonly { workspaceId: string; questionId: string; since: string | null }[];
}
/** The approvals declared in one place of a project: on its base branch, or in one workspace. */
export interface ApprovalGroup { key: string; projectId: string; place: { kind: 'base' } | { kind: 'workspace'; workspaceId: string }; entries: readonly ApprovalEntry[] }

/** A row no one workspace owns: a machine that should be online and is not, or an object the storage watchdog stopped
 * or flagged. */
export type AccountItem =
  | { key: string; kind: 'machine'; projectId: string | null; machineId: string; label: string; state: string; error: string | null; workspaces: readonly { projectId: string; workspaceId: string }[] }
  | { key: string; kind: 'incident'; projectId: null; incident: StorageIncidentView };

/** An open Chatter issue topic of a project. */
export interface IssueItem { key: string; projectId: string; topic: ChatterTopic }

export interface InboxSources {
  rows: readonly WorkspaceStatusRow[];
  directory: Pick<AccountDirectorySnapshot, 'projects' | 'workspaces' | 'placements' | 'machines'> | null;
  incidents: readonly StorageIncidentView[];
  topics: ReadonlyMap<string, readonly ChatterTopic[]>;
  /** Machines whose offline row the person dismissed, until they are online again. */
  dismissedMachines: ReadonlySet<string>;
}

/** The project ids a view shows; null shows every one. */
export type Scope = ReadonlySet<string> | null;

/** Whether a row is in the scope; an account row about no project is in every scope. */
function inScope(scope: Scope, projectId: string | null): boolean {
  return scope === null || projectId === null || scope.has(projectId);
}

export function fresh(since: string | null, now: number): boolean {
  return since === null || now - Date.parse(since) <= STALE_AFTER_MS;
}

/** Workspaces of live projects: an archived or deleting project's rows are hidden, as the sidebar hides them. */
function liveProjects(sources: InboxSources): ReadonlySet<string> | null {
  if (!sources.directory) return null;
  return new Set(sources.directory.projects.filter(project => project.archivedAt === null && project.lifecycle !== 'deleting').map(project => project.id));
}

/** Every open item of every live workspace in the scope, oldest first per workspace. */
export function workspaceItems(sources: InboxSources, scope: Scope): WorkspaceItem[] {
  const live = liveProjects(sources);
  return sources.rows.flatMap(row => live && !live.has(row.projectId) || !inScope(scope, row.projectId) ? []
    : (row.waiting?.items ?? []).map(item => ({ key: `${row.workspaceId}:${item.key}`, projectId: row.projectId, workspaceId: row.workspaceId, item })));
}

/** The approvals waiting in the scope, one entry per content hash and project, grouped by where they are declared: the
 * base branch (the project's own workspace) when it declares them, otherwise the first workspace that does. */
export function approvalGroups(sources: InboxSources, scope: Scope): ApprovalGroup[] {
  const entries = new Map<string, { projectId: string; hash: string; label: string; fileName: string | null; phase: string | null; declaredIn: string[]; waiting: { workspaceId: string; questionId: string; since: string | null }[] }>();
  for (const { projectId, workspaceId, item } of workspaceItems(sources, scope)) {
    if (item.kind !== 'lifecycle-approval') continue;
    for (const script of item.scripts) {
      const key = `approval:${projectId}:${script.hash}`;
      const entry = entries.get(key) ?? { projectId, hash: script.hash, label: script.label, fileName: script.fileName, phase: script.phase, declaredIn: [], waiting: [] };
      if (!entry.declaredIn.includes(workspaceId)) entry.declaredIn.push(workspaceId);
      entry.waiting.push({ workspaceId, questionId: item.key, since: item.since });
      entries.set(key, entry);
    }
  }
  const groups = new Map<string, ApprovalGroup & { entries: ApprovalEntry[] }>();
  for (const [key, entry] of entries) {
    const base = entry.declaredIn.includes(entry.projectId);
    const place: ApprovalGroup['place'] = base ? { kind: 'base' } : { kind: 'workspace', workspaceId: entry.declaredIn[0] ?? entry.projectId };
    const groupKey = `${entry.projectId}:${place.kind === 'base' ? 'base' : place.workspaceId}`;
    const group = groups.get(groupKey) ?? { key: groupKey, projectId: entry.projectId, place, entries: [] };
    group.entries.push({ key, ...entry });
    groups.set(groupKey, group);
  }
  return [...groups.values()];
}

/** The oldest wait on an approval: when it entered the Inbox. */
export function entrySince(entry: ApprovalEntry): string | null {
  return entry.waiting.map(wait => wait.since).filter(since => since !== null).sort()[0] ?? null;
}

/** The account's rows in the scope: machines that should be online and are offline or failed (with the workspaces held
 * on them or whose setup failed there), then the storage incidents still open. */
export function accountItems(sources: InboxSources, scope: Scope): AccountItem[] {
  const machines: AccountItem[] = (sources.directory?.machines ?? []).flatMap(machine => {
    if (machine.desiredState !== 'online' || (machine.state !== 'offline' && machine.state !== 'error') || sources.dismissedMachines.has(machine.id)) return [];
    const held = (sources.directory?.placements ?? []).filter(placement => placement.holderId === machine.id).map(placement => ({ projectId: placement.projectId, workspaceId: placement.spaceId }));
    const failed = sources.rows.filter(row => row.waiting?.items.some(item => item.kind === 'setup-failed' && item.machineId === machine.id)).map(row => ({ projectId: row.projectId, workspaceId: row.workspaceId }));
    const workspaces = [...held, ...failed].filter((workspace, index, all) => all.findIndex(other => other.workspaceId === workspace.workspaceId) === index);
    const projects = new Set(workspaces.map(workspace => workspace.projectId));
    const projectId = projects.size === 1 ? [...projects][0] ?? null : null;
    if (!inScope(scope, projectId)) return [];
    return [{ key: `machine:${machine.id}`, kind: 'machine', projectId, machineId: machine.id, label: machine.label, state: machine.state, error: machine.error, workspaces }];
  });
  const incidents: AccountItem[] = sources.incidents.filter(incident => incident.resolvedAt === null).map(incident => ({ key: `incident:${incident.objectId}`, kind: 'incident', projectId: null, incident }));
  return [...machines, ...incidents];
}

/** The open issue topics of the projects in the scope, newest first. */
export function issueItems(sources: InboxSources, scope: Scope): IssueItem[] {
  const live = liveProjects(sources);
  return [...sources.topics].flatMap(([projectId, topics]) => live && !live.has(projectId) || !inScope(scope, projectId) ? []
    : topics.filter(topic => topic.state === 'open').map(topic => ({ key: `issue:${projectId}:${topic.key}`, projectId, topic })))
    .sort((left, right) => new Date(right.topic.lastAt).getTime() - new Date(left.topic.lastAt).getTime());
}

/**
 * What the Inbox badge and Needs you count in the scope (decision 2a): every fresh row of a workspace, each approval by
 * content hash (not once per asking workspace), and the account's rows. Issue topics are listed, never counted; a row
 * waiting longer than two days, or cleared in this tab (held for Undo or sent), leaves the count.
 */
export function inboxCount(sources: InboxSources, scope: Scope, cleared: (key: string) => boolean, now: number): number {
  const items = workspaceItems(sources, scope).filter(entry => entry.item.kind !== 'lifecycle-approval' && fresh(entry.item.since, now) && !cleared(entry.key)).length;
  const approvals = approvalGroups(sources, scope).flatMap(group => group.entries).filter(entry => fresh(entrySince(entry), now) && !cleared(entry.key)).length;
  const account = accountItems(sources, scope).filter(item => !cleared(item.key)).length;
  return items + approvals + account;
}

/** The workspaces with a counted row: Needs you lists these. */
export function needsYou(sources: InboxSources, cleared: (key: string) => boolean, now: number): Set<string> {
  return new Set(workspaceItems(sources, null).filter(entry => fresh(entry.item.since, now) && !cleared(entry.key)).map(entry => entry.workspaceId));
}
