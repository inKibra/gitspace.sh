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
 * or flagged: one row per object, its newest incident with how many are open, about the workspace or project the
 * object belongs to when its name says so. An alert whose newest occurrence is over two days old is `stale`: folded
 * and not counted; a paused object never is, since it blocks work. */
export type AccountItem =
  | { key: string; kind: 'machine'; projectId: string | null; machineId: string; label: string; state: string; error: string | null; workspaces: readonly { projectId: string; workspaceId: string }[]; stale: false }
  | { key: string; kind: 'incident'; projectId: string | null; workspaceId: string | null; incident: StorageIncidentView; count: number; paused: boolean; stale: boolean };

/** One open issue: a Chatter issue topic, or the topics of the same key open in several projects, one row. Each place is
 * a project's topic with the workspace that posted in it last. `workspaces`: every workspace that posted, newest first
 * (a GitSpace runtime-failure post's author id is its workspace). Posts and repeats are summed. */
export interface IssueItem {
  key: string;
  topicKey: string;
  display: string;
  places: readonly { projectId: string; topic: ChatterTopic; workspaceId: string | null }[];
  workspaces: readonly string[];
  posts: number;
  repeats: number;
  gitspace: boolean;
  marked: boolean;
}

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

/** The workspace or project an object belongs to, from the name it was made under: `<account>:<workspace or project>`,
 * or a workspace context's `[account, project, workspace]`. A project's base workspace is the project. */
function incidentPlace(name: string | null, directory: InboxSources['directory']): { projectId: string | null; workspaceId: string | null } {
  const none = { projectId: null, workspaceId: null };
  if (name === null || !directory) return none;
  if (name.startsWith('[')) {
    const parsed: unknown = JSON.parse(name);
    if (!Array.isArray(parsed) || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'string') return none;
    return { projectId: parsed[1], workspaceId: parsed[2] === parsed[1] ? null : parsed[2] };
  }
  const id = name.slice(name.indexOf(':') + 1);
  const workspace = directory.workspaces.find(candidate => candidate.id === id);
  if (workspace) return { projectId: workspace.projectId, workspaceId: id === workspace.projectId ? null : id };
  return directory.projects.some(project => project.id === id) ? { projectId: id, workspaceId: null } : none;
}

/** The account's rows in the scope, in order: paused objects, machines that should be online and are offline or failed
 * (with the workspaces held on them or whose setup failed there), then the alerts, newest first, stale ones last. */
export function accountItems(sources: InboxSources, scope: Scope, now: number): AccountItem[] {
  const machines: AccountItem[] = (sources.directory?.machines ?? []).flatMap(machine => {
    if (machine.desiredState !== 'online' || (machine.state !== 'offline' && machine.state !== 'error') || sources.dismissedMachines.has(machine.id)) return [];
    const held = (sources.directory?.placements ?? []).filter(placement => placement.holderId === machine.id).map(placement => ({ projectId: placement.projectId, workspaceId: placement.spaceId }));
    const failed = sources.rows.filter(row => row.waiting?.items.some(item => item.kind === 'setup-failed' && item.machineId === machine.id)).map(row => ({ projectId: row.projectId, workspaceId: row.workspaceId }));
    const workspaces = [...held, ...failed].filter((workspace, index, all) => all.findIndex(other => other.workspaceId === workspace.workspaceId) === index);
    const projects = new Set(workspaces.map(workspace => workspace.projectId));
    const projectId = projects.size === 1 ? [...projects][0] ?? null : null;
    if (!inScope(scope, projectId)) return [];
    return [{ key: `machine:${machine.id}`, kind: 'machine', projectId, machineId: machine.id, label: machine.label, state: machine.state, error: machine.error, workspaces, stale: false }];
  });
  const byObject = new Map<string, StorageIncidentView[]>();
  for (const incident of sources.incidents) if (incident.resolvedAt === null) byObject.set(incident.objectId, [...byObject.get(incident.objectId) ?? [], incident]);
  const incidents = [...byObject.values()].flatMap((open): Extract<AccountItem, { kind: 'incident' }>[] => {
    const newest = open.toSorted((left, right) => left.at.localeCompare(right.at)).at(-1);
    if (!newest) return [];
    const place = incidentPlace(open.find(incident => incident.name !== null)?.name ?? null, sources.directory);
    if (!inScope(scope, place.projectId)) return [];
    const paused = open.some(incident => incident.kind === 'quarantine');
    return [{ key: `incident:${newest.objectId}`, kind: 'incident', ...place, incident: newest, count: open.length, paused, stale: !paused && !fresh(newest.at, now) }];
  }).sort((left, right) => right.incident.at.localeCompare(left.incident.at));
  return [...incidents.filter(item => item.paused), ...machines, ...incidents.filter(item => !item.paused && !item.stale), ...incidents.filter(item => item.stale)];
}

/** The open issues of the projects in the scope, newest first: one per topic key, across projects. */
export function issueItems(sources: InboxSources, scope: Scope): IssueItem[] {
  const live = liveProjects(sources);
  const byKey = new Map<string, { projectId: string; topic: ChatterTopic }[]>();
  for (const [projectId, topics] of sources.topics) {
    if (live && !live.has(projectId) || !inScope(scope, projectId)) continue;
    for (const topic of topics) if (topic.state === 'open') byKey.set(topic.key, [...byKey.get(topic.key) ?? [], { projectId, topic }]);
  }
  const lastAt = (topic: ChatterTopic) => new Date(topic.lastAt).getTime();
  return [...byKey].map(([topicKey, found]): IssueItem & { at: number } => {
    const places = found.toSorted((left, right) => lastAt(right.topic) - lastAt(left.topic))
      .map(({ projectId, topic }) => ({ projectId, topic, workspaceId: topic.participants.find(author => author.kind === 'workspace' || author.kind === 'gitspace')?.id ?? null }));
    const workspaces = [...new Set(places.flatMap(place => place.topic.participants.flatMap(author => author.kind === 'workspace' || author.kind === 'gitspace' ? [author.id] : [])))];
    const sum = (count: (topic: ChatterTopic) => number) => places.reduce((total, place) => total + count(place.topic), 0);
    return {
      key: `issue:${topicKey}`, topicKey, display: places[0]?.topic.display ?? topicKey, places, workspaces, posts: sum(topic => topic.posts), repeats: sum(topic => topic.repeats),
      gitspace: places.some(place => place.topic.participants.some(author => author.kind === 'gitspace')), marked: places.some(place => place.topic.marked !== null),
      at: places[0] ? lastAt(places[0].topic) : 0,
    };
  }).sort((left, right) => right.at - left.at);
}

/**
 * What the Inbox badge and Needs you count in the scope (decision 2a): every fresh row of a workspace, each approval by
 * content hash (not once per asking workspace), and the account's rows. Issue topics are listed, never counted; a row
 * waiting longer than two days, or cleared in this tab (held for Undo or sent), leaves the count.
 */
export function inboxCount(sources: InboxSources, scope: Scope, cleared: (key: string) => boolean, now: number): number {
  const items = workspaceItems(sources, scope).filter(entry => entry.item.kind !== 'lifecycle-approval' && fresh(entry.item.since, now) && !cleared(entry.key)).length;
  const approvals = approvalGroups(sources, scope).flatMap(group => group.entries).filter(entry => fresh(entrySince(entry), now) && !cleared(entry.key)).length;
  const account = accountItems(sources, scope, now).filter(item => !item.stale && !cleared(item.key)).length;
  return items + approvals + account;
}

/** The workspaces with a counted row: Needs you lists these. */
export function needsYou(sources: InboxSources, cleared: (key: string) => boolean, now: number): Set<string> {
  return new Set(workspaceItems(sources, null).filter(entry => fresh(entry.item.since, now) && !cleared(entry.key)).map(entry => entry.workspaceId));
}
