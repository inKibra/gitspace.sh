import type { WorkspaceTurnReport } from '@gitspace/blocks';
import type { RuntimeSubmitInput } from '@gitspace/protocol-runtime';
import type { WorkspaceReport } from '@gitspace/protocol-workspace';
import type { RuntimeAccepted, RuntimeTurn, RuntimeTurnItem, WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import type { RuntimeIdentity } from './runtime-services.js';
import { deleteProjectWatch, readProjectWatch, readWorkspaceReport, writeProjectWatch, type ProjectWatch } from './workspace-metadata.js';

/** Messages of a running turn `progress` shows, newest last. */
const PROGRESS_ITEMS = 8;

/** What the project agent sees of the turn it started: its state, the workspace's stored report, and while it runs the
 * turn's newest messages. No watched turn (null): it ended and reported, a person took over, or none was started. */
export type ProjectProgress = {
  turn: { requestId: string; state: 'queued' | 'running' | 'ended'; onDone: ProjectWatch['onDone']; armedAt: string; startedAt: string | null } | null;
  report: WorkspaceReport | null;
  items: RuntimeTurnItem[];
};

/** The runtime hooks that keep and end this workspace's watch. */
export type ProjectWatchHooks = {
  turnChanged(requestId: string, turn: RuntimeTurn): void;
  published(report: WorkspaceReport): void;
  personPrompted(): void;
};

/**
 * The project agent's instruction, watched: the watch is armed before the submission exists, so the turn that submission
 * starts (pi places it only once any turn ahead of it ends) is the one that reports. A retried call names a request
 * already submitted: it delivers nothing new and leaves the watch, or its report, as they are. A newer instruction
 * replaces the watch; the turn of the older one no longer reports.
 */
export async function startFromProject(storage: DurableObjectStorage, runtime: WorkspaceRuntime, input: RuntimeSubmitInput, watch: Pick<ProjectWatch, 'name' | 'onDone'>): Promise<RuntimeAccepted> {
  if (await runtime.turn(input.requestId) !== null) return runtime.submit(input);
  writeProjectWatch(storage, { ...watch, requestId: input.requestId, armedAt: Date.now(), startedAt: null });
  try { return await runtime.submit(input); } catch (error) {
    if (readProjectWatch(storage)?.requestId === input.requestId) deleteProjectWatch(storage);
    throw error;
  }
}

/**
 * The watch ends three ways: the watched turn ends (finished or failed), it stops for a person (a question or an
 * approval), or a person prompts in the workspace. The first two report once through `send`; the third says nothing.
 * Every other turn, a person's or one that started before the instruction, is not watched.
 */
export function projectWatchHooks(storage: DurableObjectStorage, identity: RuntimeIdentity, send: (report: WorkspaceTurnReport, onDone: ProjectWatch['onDone']) => void): ProjectWatchHooks {
  const end = (watch: ProjectWatch, outcome: WorkspaceTurnReport['outcome'], excerpt: string | null) => {
    deleteProjectWatch(storage);
    send({ projectId: identity.projectId, workspaceId: identity.workspaceId, name: watch.name, requestId: watch.requestId, outcome, excerpt }, watch.onDone);
  };
  return {
    turnChanged: (requestId, turn) => {
      const watch = readProjectWatch(storage);
      if (watch?.requestId !== requestId) return;
      if (turn.state === 'running' && watch.startedAt === null) writeProjectWatch(storage, { ...watch, startedAt: Date.now() });
      else if (turn.state === 'ended') end(watch, turn.outcome, turn.text);
    },
    // A question only counts once the watched turn runs: one still pending from an earlier turn is not this turn's.
    published: report => {
      const watch = readProjectWatch(storage);
      if (!watch || watch.startedAt === null || !report.waitingOn) return;
      end(watch, report.waitingOn.kind === 'approval' ? 'approval' : 'asked', report.waitingOn.prompt);
    },
    personPrompted: () => { deleteProjectWatch(storage); },
  };
}

/** A turn that started or ended while no runtime was open to hear it (a reset between its end and its report) is read
 * once as the runtime opens. */
export async function reconcileProjectWatch(storage: DurableObjectStorage, runtime: WorkspaceRuntime, hooks: ProjectWatchHooks): Promise<void> {
  const watch = readProjectWatch(storage);
  const turn = watch ? await runtime.turn(watch.requestId) : null;
  if (watch && turn) hooks.turnChanged(watch.requestId, turn);
}

/** Reads stored rows; the runtime opens only for a watched turn that has started. */
export async function projectProgress(storage: DurableObjectStorage, open: () => Promise<WorkspaceRuntime>): Promise<ProjectProgress> {
  const watch = readProjectWatch(storage);
  const report = readWorkspaceReport(storage);
  if (!watch) return { turn: null, report, items: [] };
  const turn = { requestId: watch.requestId, onDone: watch.onDone, armedAt: new Date(watch.armedAt).toISOString(), startedAt: watch.startedAt === null ? null : new Date(watch.startedAt).toISOString() };
  if (watch.startedAt === null) return { turn: { ...turn, state: 'queued' }, report, items: [] };
  const runtime = await open();
  const [current, items] = await Promise.all([runtime.turn(watch.requestId), runtime.turnItems(watch.requestId, PROGRESS_ITEMS)]);
  return { turn: { ...turn, state: current?.state === 'ended' ? 'ended' : 'running' }, report, items };
}
