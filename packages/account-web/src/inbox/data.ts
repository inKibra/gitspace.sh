// Where the Inbox's rows come from in the tab, and what its actions call. One `InboxProvider` reads the sources once for
// every row, count and badge under it: the status rows the directory socket keeps, the directory, the storage
// incidents and each live project's Chatter topics, each read again on its own live notice.
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { accountLiveKey, projectLiveKey } from '@gitspace/protocol/live-notice';
import type { ChatterTopic, ChatterTopicAction } from '@gitspace/protocol/chatter-contract';
import { RuntimeIdentitySchema, type RuntimeLifecycleApprovalAnswer } from '@gitspace/protocol-runtime';
import type { WaitingItem } from '@gitspace/protocol-workspace';
import { rpcClient } from '../rpc-client.js';
import { liveState } from '../live-notices.js';
import { useAccountDirectorySnapshot, useSynchronizedResource } from '../SynchronizationProvider.js';
import { workspaceStatuses } from '../workspace-statuses.js';
import type { InboxSources } from './model.js';

export const InboxSourcesContext = createContext<InboxSources | null>(null);

const incidentsSource = liveState('inbox:storage-incidents', [accountLiveKey('storage-incidents')], signal => rpcClient.storageIncidents.list({}, { signal }));

/** Machines whose offline row the person dismissed, kept in this browser until the machine is online again. */
const DISMISSED_KEY = 'gitspace.inbox.dismissed-machines';
const dismissedListeners = new Set<() => void>();
let dismissedRead: { raw: string | null; set: ReadonlySet<string> } = { raw: null, set: new Set() };
function readDismissed(): ReadonlySet<string> {
  const raw = window.localStorage.getItem(DISMISSED_KEY);
  if (raw !== dismissedRead.raw) {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    dismissedRead = { raw, set: new Set(Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []) };
  }
  return dismissedRead.set;
}
/** Dismisses a machine's offline row, or forgets the dismissal once the machine is back. */
export function setMachineDismissed(machineId: string, dismissed: boolean): void {
  const next = new Set(readDismissed());
  if (dismissed) next.add(machineId); else next.delete(machineId);
  window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
  for (const listener of [...dismissedListeners]) listener();
}
function subscribeDismissed(listener: () => void): () => void {
  dismissedListeners.add(listener);
  return () => { dismissedListeners.delete(listener); };
}

/** Reads every source of the Inbox once for the rows, counts and badges under it. */
export function InboxProvider({ children }: { children: ReactNode }) {
  const revision = useSyncExternalStore(workspaceStatuses.subscribe, workspaceStatuses.revision, workspaceStatuses.revision);
  const rows = useMemo(() => workspaceStatuses.all(), [revision]);
  const directory = useAccountDirectorySnapshot().value ?? null;
  const incidents = useSynchronizedResource('inbox:storage-incidents', incidentsSource).value;
  const projectIds = (directory?.projects ?? []).filter(project => project.archivedAt === null && project.lifecycle === 'active').map(project => project.id).sort();
  const resource = `inbox:issues:${projectIds.join(',')}`;
  const topicsSource = useMemo(() => liveState(resource, projectIds.map(projectId => projectLiveKey(projectId, 'chatter')), async signal => {
    const read = await Promise.all(projectIds.map(async projectId => {
      const result = await rpcClient.chatter.topics({ projectId, limit: 100 }, { signal });
      // A project whose Chatter cannot be read lists no issues; the others still do.
      return [projectId, result.status === 'ok' ? result.value.topics : []] satisfies [string, readonly ChatterTopic[]];
    }));
    return { status: 'ok', value: read };
  }), [resource]);
  const topics = useSynchronizedResource(resource, topicsSource).value;
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, readDismissed);
  const value = useMemo((): InboxSources => ({
    rows, directory, incidents: incidents ?? [], topics: new Map(topics ?? []), dismissedMachines: dismissed,
  }), [rows, directory, incidents, topics, dismissed]);
  return createElement(InboxSourcesContext.Provider, { value }, children);
}

export function useInboxSources(): InboxSources {
  const sources = useContext(InboxSourcesContext);
  if (!sources) throw new Error('InboxProvider is required');
  return sources;
}

async function done<T>(call: Promise<{ status: 'ok'; value: T } | { status: 'error'; error: unknown }>): Promise<T> {
  const result = await call;
  if (result.status === 'error') throw result.error instanceof Error ? result.error : new Error(String(result.error));
  return result.value;
}

/** Answers an agent's question or plan in place, through the path the workspace's own cards use: the answer is staged,
 * then one message to its conversation carries it with the note (a plan's note goes in its decision). */
export async function sendAnswer(input: { projectId: string; workspaceId: string; conversationId: string; questionId: string; answer: AnswerValue; text: string }): Promise<void> {
  const identity = { ...RuntimeIdentitySchema.parse({ projectId: input.projectId, workspaceId: input.workspaceId }), conversationId: input.conversationId };
  await done(rpcClient.runtime.session({ ...identity, command: { type: 'stageAnswer', questionId: input.questionId, answer: input.answer } }));
  await done(rpcClient.runtime.session({ ...identity, command: { type: 'prompt', requestId: crypto.randomUUID(), text: input.text, answers: [{ questionId: input.questionId, answer: input.answer }] } }));
}
/** An ask's parts, or a plan's decision. */
export type AnswerValue = { id: string; selectedOptions: string[]; customInput: string | null }[] | { approved: boolean; note: string | null };

/** Answers a lifecycle card as its own buttons do. */
export async function answerLifecycle(projectId: string, workspaceId: string, questionId: string, answer: RuntimeLifecycleApprovalAnswer): Promise<void> {
  await done(rpcClient.runtime.answer({ ...RuntimeIdentitySchema.parse({ projectId, workspaceId }), questionId, answer }));
}

/** A problem row's retry: the failed turn again, or the failed setup step run again on its machine. */
export async function retryProblem(projectId: string, workspaceId: string, item: Extract<WaitingItem, { kind: 'failed' | 'setup-failed' }>): Promise<void> {
  if (item.kind === 'failed') {
    await done(rpcClient.runtime.session({ ...RuntimeIdentitySchema.parse({ projectId, workspaceId }), conversationId: item.conversation.id, command: { type: 'resume' } }));
    return;
  }
  const runId = crypto.randomUUID();
  if (item.phase === 'checks') await done(rpcClient.environment.runChecks({ spaceId: workspaceId, machineId: item.machineId, runId }));
  else await done(rpcClient.environment.runPhase({ spaceId: workspaceId, machineId: item.machineId, runId, phase: item.phase, rerun: true }));
}

/** A failed run's log, from its start. */
export async function runLog(workspaceId: string, runId: string): Promise<string> {
  return (await done(rpcClient.environment.runLog({ spaceId: workspaceId, runId, offset: null }))).output;
}

export async function startMachine(machineId: string): Promise<void> {
  await done(rpcClient.machine.resume({ machineId }));
}

export async function resumeObject(objectId: string): Promise<void> {
  await done(rpcClient.storageIncidents.resume({ objectId }));
}

export async function pauseObject(objectId: string, reason: string): Promise<void> {
  await done(rpcClient.storageIncidents.pause({ objectId, reason: reason.slice(0, 500) }));
}

export async function actOnTopic(projectId: string, key: string, action: ChatterTopicAction): Promise<void> {
  await done(rpcClient.chatter.topicAct({ projectId, key, action }));
}
