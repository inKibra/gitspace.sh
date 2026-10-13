import { useRef, useState, type ReactNode } from 'react';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { type RuntimeCacheActionInput } from '@gitspace/protocol-runtime/attachment-controls';
import { Button, useShape } from '@gitspace/ui';
import { EmptyState, StatusDot } from './GitSpaceShell.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useAccountMachines } from './SynchronizationProvider.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { RuntimeBrowserGroups } from './RuntimeBrowser.js';
import { runtimeLfsHeldBack, useLfsTransition } from './LfsTransition.js';
import { CacheMachineRow, ReleasedMachineList } from './environment/CacheMachineRow.js';
import { environmentCacheSummary, partitionAttachments } from './environment/cache-presentation.js';
import { useCacheFreshnessClock } from './environment/useCacheFreshnessClock.js';

export function RuntimeMachines({ snapshot, onCommitFirst, profile, renderBlockers, renderRuns, onOpenLog }: {
  snapshot: RuntimeSnapshot; onCommitFirst?(): void | Promise<void>; profile?: string;
  renderBlockers?(machineId: string): ReactNode; renderRuns?(machineId: string): ReactNode; onOpenLog?(runId: string): void;
}) {
  const shape = useShape();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const now = useCacheFreshnessClock();
  const identity = RuntimeIdentitySchema.parse(snapshot);
  const machinesQuery = useAccountMachines();
  const machines = useRetainedQueryValue(machinesQuery, 'machines');
  const [machineId, setMachineId] = useState('');
  const { live: attached, lost } = partitionAttachments(snapshot.attachments);
  const machineLabel = (id: string) => machines?.find(machine => machine.id === id)?.label ?? id;
  const attachable = (machines ?? []).filter(machine => !attached.some(attachment => attachment.machineId === machine.id));
  const summary = environmentCacheSummary(snapshot, now);
  const lfsTransition = useLfsTransition();
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await operation(); } catch (cause) { setError(rpcErrorMessage(cause, 'Update workspace machine')); }
    finally { busy.current = false; setPending(false); }
  };
  const attach = () => perform(async () => {
    const result = await rpcClient.runtime.attachment.cache.request({ ...identity, machineId: RuntimeMachineIdSchema.parse(machineId), requestId: crypto.randomUUID() });
    if (result.status === 'error') throw result.error;
    setMachineId('');
  });
  const confirmPublication = async (attachment: RuntimeSnapshot['attachments'][number]) => {
    const heldBack = runtimeLfsHeldBack(snapshot);
    const blockedReason = attachment.cache?.reclaimBlocked;
    const confirmed = await lfsTransition.confirm(heldBack, async () => { await onCommitFirst?.(); }, blockedReason);
    return { confirmed, discardHeldBack: confirmed && (heldBack.length > 0 || Boolean(blockedReason)) };
  };
  const action = (attachment: RuntimeSnapshot['attachments'][number], action: RuntimeCacheActionInput['action']) => perform(async () => {
    if (action.kind === 'reclaim') {
      const decision = await confirmPublication(attachment);
      if (!decision.confirmed) return;
      action = { kind: 'reclaim', ...(decision.discardHeldBack ? { discardHeldBack: true } : {}) };
    }
    const result = await rpcClient.runtime.attachment.action({ ...identity, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, requestId: crypto.randomUUID(), action });
    if (result.status === 'error') throw result.error;
  });
  const detach = (attachment: RuntimeSnapshot['attachments'][number]) => perform(async () => {
    const decision = await confirmPublication(attachment);
    if (!decision.confirmed) return;
    const result = await rpcClient.runtime.attachment.detach({ ...identity, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, ...(decision.discardHeldBack ? { discardHeldBack: true } : {}) });
    if (result.status === 'error') throw result.error;
  });
  return <section aria-label="Workspace machines" className="flex flex-col gap-4">
    <header className="flex flex-col gap-2"><h2 className="text-body font-medium">Machines</h2><p role="status" className="flex flex-wrap items-center gap-2 text-caption tabular-nums"><StatusDot color={summary.color} />{profile ? `${profile} · ` : ''}{summary.ready} ready / {summary.count} machines · {summary.label}</p></header>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {runtimeLfsHeldBack(snapshot).length ? <p role="alert" className="text-caption text-warning">Uncommitted Git LFS changes are held back on their machine. Commit them before detaching.</p> : null}
    {!attached.length ? <EmptyState title="No machine attached" description="Attach a machine to run tools." /> : attached.map(attachment => <CacheMachineRow key={attachment.attachmentId} attachment={attachment} name={machineLabel(attachment.machineId)} pending={pending} now={now} onAction={next => void action(attachment, next)} onDetach={() => void detach(attachment)} onOpenLog={onOpenLog} blockers={renderBlockers?.(attachment.machineId)} runs={renderRuns?.(attachment.machineId)} />)}
    <ReleasedMachineList attachments={lost} label={machineLabel} />
    {attachable.length ? <form className={`${shape.container} flex flex-wrap items-end gap-3 bg-surface-2 p-4 shadow-surface-1`} onSubmit={event => { event.preventDefault(); void attach(); }}>
      <label className="flex flex-1 flex-col gap-2 text-caption">Attach machine<select aria-label="Attach machine" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={machineId} onChange={event => setMachineId(event.target.value)} disabled={pending}><option value="" disabled>Select</option>{attachable.map(machine => <option key={machine.id} value={machine.id}>{machine.label} · {machine.state}</option>)}</select></label>
      <Button type="submit" variant="primary" disabled={pending || !machineId} loading={pending}>Attach</Button>
    </form> : machines && !machines.length ? <p className="text-caption text-muted-foreground">No enrolled machines. Enroll one in Settings → Machines.</p> : null}
    {machinesQuery.state === 'failure' ? <p role="alert" className="text-caption text-destructive">{rpcErrorMessage(machinesQuery.error, 'Read enrolled machines')}</p> : null}
    <RuntimeBrowserGroups key={`${snapshot.projectId}:${snapshot.workspaceId}`} snapshot={snapshot} machines={machines ?? []} />
    {lfsTransition.dialog}
  </section>;
}
