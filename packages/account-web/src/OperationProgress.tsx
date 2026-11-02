// Long project and workspace changes run in the background: the request records the operation, the project's own object
// runs it, and the account directory carries every project's operations to each page. These show one where the change
// it makes shows, until it ends; a failure stays on its step with Retry and Dismiss.
import type { CloudProjectOperation } from '@gitspace/protocol';
import { Badge, Button, ThinkingIndicator, Tooltip, useShape } from '@gitspace/ui';
import { RefreshCcw01, XClose } from '@untitledui/icons';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { glyph } from './glyph.js';
import { StatusDot } from './GitSpaceShell.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useAccountDirectorySnapshot } from './SynchronizationProvider.js';

/** How long one that succeeded stays shown: as long as its project keeps it in the directory. */
const RECENT_MS = 10 * 60_000;

const TITLES: Record<string, { running: string; failed: string }> = {
  'project.setBaseBranch': { running: 'Switching the base branch', failed: 'Base branch switch failed' },
  'project.updateBase': { running: 'Updating the base', failed: 'Update base failed' },
  'project.archive': { running: 'Archiving the project', failed: 'Archive failed' },
  'project.restore': { running: 'Restoring the project', failed: 'Restore failed' },
  'project.delete': { running: 'Deleting the project', failed: 'Delete failed' },
  'workspace.create': { running: 'Creating', failed: 'Creation failed' },
  'workspace.archive': { running: 'Archiving', failed: 'Archive failed' },
  'workspace.restore': { running: 'Restoring', failed: 'Restore failed' },
  'workspace.delete': { running: 'Deleting', failed: 'Delete failed' },
};

export function operationTitle(operation: CloudProjectOperation): string {
  const titles = TITLES[operation.kind] ?? { running: operation.kind, failed: `${operation.kind} failed` };
  return operation.state === 'failed' ? titles.failed : titles.running;
}

/** Still to finish: waiting its turn or running. */
export function operationActive(operation: CloudProjectOperation): boolean {
  return operation.state === 'queued' || operation.state === 'claimed' || operation.state === 'running' || operation.state === 'blocked';
}

/** Every project's operations the views show, newest first: active, failed until dismissed, succeeded in the last minutes. */
export function useAccountOperations(): readonly CloudProjectOperation[] {
  const snapshot = useAccountDirectorySnapshot();
  const operations = snapshot.value?.operations;
  return useMemo(() => (operations ?? [])
    .filter(operation => operation.state !== 'succeeded' || Date.now() - Date.parse(operation.updatedAt) < RECENT_MS)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)), [operations]);
}

/** The newest of `operations` matching `kinds` on `workspaceId` (null: the project itself). */
export function latestOperation(operations: readonly CloudProjectOperation[], workspaceId: string | null, kinds?: readonly string[]): CloudProjectOperation | null {
  return operations.find(operation => operation.workspaceId === workspaceId && (!kinds || kinds.includes(operation.kind))) ?? null;
}

/** Seconds it ran: until now while it runs, else until it ended. Ticks once a second while it runs. */
function useSeconds(operation: CloudProjectOperation): number {
  const active = operationActive(operation);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.floor(((active ? now : Date.parse(operation.updatedAt)) - Date.parse(operation.createdAt)) / 1000));
}

/** Retry and Dismiss of a failed operation, with the reason either was refused. */
function useOperationActions(operation: CloudProjectOperation) {
  const [pending, setPending] = useState<'retry' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'retry' | 'dismiss') => {
    if (pending) return;
    setPending(action); setError(null);
    const input = { projectId: operation.projectId, operationId: operation.id };
    const result = action === 'retry' ? await rpcClient.project.operations.retry(input) : await rpcClient.project.operations.dismiss(input);
    if (result.status === 'error') setError(rpcErrorMessage(result.error, action === 'retry' ? 'Retry' : 'Dismiss'));
    setPending(null);
  };
  return { pending, error, retry: () => void act('retry'), dismiss: () => void act('dismiss') };
}

const STEP_BADGE: Record<CloudProjectOperation['state'], { label: string; color: 'gray' | 'amber' | 'green' | 'red' }> = {
  queued: { label: 'Waiting', color: 'gray' }, claimed: { label: 'Waiting', color: 'gray' }, blocked: { label: 'Waiting', color: 'gray' },
  running: { label: 'Running', color: 'amber' }, succeeded: { label: 'Done', color: 'green' }, failed: { label: 'Failed', color: 'red' }, canceled: { label: 'Canceled', color: 'gray' },
};

/** An operation where the change it makes shows: what it does, its steps, how long, and on failure the reason with
 * Retry and Dismiss. It runs on with the page closed. */
export function OperationProgress({ operation }: { operation: CloudProjectOperation }): ReactElement {
  const shape = useShape();
  const seconds = useSeconds(operation);
  const actions = useOperationActions(operation);
  const failed = operation.state === 'failed';
  const title = operationTitle(operation);
  return <section aria-label={title} className={`flex flex-col gap-2 bg-surface-2 p-3 ${shape.container} [overflow-wrap:anywhere]`}>
    <div className="flex items-center gap-2">
      {failed ? null : <ThinkingIndicator size="compact" className="shrink-0 p-0 [&>span[aria-hidden]]:hidden" />}
      <span className={`text-body font-medium ${failed ? 'text-destructive' : 'text-foreground'}`}>{title}</span>
      <span className="ml-auto text-caption text-muted-foreground tabular-nums">{seconds} s</span>
    </div>
    {operation.summary ? <span className="font-mono text-caption text-muted-foreground">{operation.summary}</span> : null}
    <ol aria-label="Steps" className="flex flex-col gap-1">
      {operation.steps.map(step => <li key={step.id} className="flex min-w-0 items-center justify-between gap-3 text-caption text-foreground">
        <span className="min-w-0 truncate">{step.label}</span>
        <Badge variant="dot" size="compact" color={STEP_BADGE[step.state].color}>{STEP_BADGE[step.state].label}</Badge>
      </li>)}
    </ol>
    {failed
      ? <>
          <p role="alert" className="text-caption text-destructive">{operation.error}</p>
          {actions.error ? <p role="alert" className="text-caption text-destructive">{actions.error}</p> : null}
          <div className="flex gap-2">
            <Button variant="secondary" size="compact" leadingIcon={glyph(RefreshCcw01)} loading={actions.pending === 'retry'} disabled={actions.pending !== null} onClick={actions.retry}>Retry</Button>
            <Button variant="ghost" size="compact" leadingIcon={glyph(XClose)} loading={actions.pending === 'dismiss'} disabled={actions.pending !== null} onClick={actions.dismiss}>Dismiss</Button>
          </div>
        </>
      : <span className="text-caption text-muted-foreground">Runs in the background: you can close this.</span>}
  </section>;
}

/** One line for where there is no room for the steps: what runs and its current step, or that it failed. */
export function OperationStatusLine({ operation }: { operation: CloudProjectOperation }): ReactElement {
  const failed = operation.state === 'failed';
  const current = operation.steps.find(step => step.state === 'running') ?? operation.steps.find(step => step.state === 'queued');
  return <span className={`inline-flex min-w-0 items-center gap-1.5 ${failed ? 'text-destructive' : ''}`}>
    <StatusDot color={failed ? 'red' : 'blue'} pulse={!failed} />
    <span className="truncate">{failed ? `${operationTitle(operation)}: ${operation.error ?? ''}` : `${operationTitle(operation)}${current ? ` · ${current.label.toLowerCase()}` : ''}`}</span>
  </span>;
}

/** Retry and Dismiss as icon buttons, for a card's footer. */
export function OperationCardActions({ operation }: { operation: CloudProjectOperation }): ReactElement {
  const actions = useOperationActions(operation);
  return <>
    <Tooltip content={actions.error ?? `Retry: ${operationTitle(operation).toLowerCase()}`} side="top"><Button variant="ghost" size="icon-compact" aria-label="Retry" disabled={actions.pending !== null} onClick={(event) => { event.stopPropagation(); actions.retry(); }}><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
    <Tooltip content="Dismiss" side="top"><Button variant="ghost" size="icon-compact" aria-label="Dismiss" disabled={actions.pending !== null} onClick={(event) => { event.stopPropagation(); actions.dismiss(); }}><XClose width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
  </>;
}
