import { useRef, useState, type ReactNode } from 'react';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeAttachmentRequestInputSchema, type RuntimeCacheActionInput } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeExecutionDocumentSchema, RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
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
  const [checkout, setCheckout] = useState<'cache' | 'snapshot' | 'branch'>('cache');
  const [branch, setBranch] = useState('');
  const checkpoint = RuntimeGitCheckpointSchema.safeParse(snapshot.documents['gitspace.code']);
  const execution = RuntimeExecutionDocumentSchema.parse(snapshot.documents['gitspace.execution'] ?? { defaultMachineId: null });
  const { live: attached, lost } = partitionAttachments(snapshot.attachments);
  const caches = attached.filter(attachment => attachment.role === 'cache');
  const machineLabel = (id: string) => machines?.find(machine => machine.id === id)?.label ?? id;
  const summary = environmentCacheSummary(snapshot, now);
  const lfsTransition = useLfsTransition();
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await operation(); } catch (cause) { setError(rpcErrorMessage(cause, 'Update workspace machine')); }
    finally { busy.current = false; setPending(false); }
  };
  const changeExecutionMachine = (selectedMachineId: string | null) => perform(async () => {
    const result = await rpcClient.runtime.executionMachine({ ...identity, machineId: selectedMachineId === null ? null : RuntimeMachineIdSchema.parse(selectedMachineId) });
    if (result.status === 'error') throw result.error;
  });
  const requestAttachment = () => perform(async () => {
    const requestId = crypto.randomUUID();
    if (checkout !== 'cache' && !checkpoint.success) return;
    const result = checkout === 'cache'
      ? await rpcClient.runtime.attachment.cache.request({ ...identity, machineId: RuntimeMachineIdSchema.parse(machineId), requestId })
      : await rpcClient.runtime.attachment.request(RuntimeAttachmentRequestInputSchema.parse({ ...identity, requestId, machineId, sourceRef: checkpoint.success ? checkpoint.data.checkpointRef : '', checkout: checkout === 'snapshot' ? { kind: 'snapshot', commit: checkpoint.success ? checkpoint.data.worktreeCommit : '' } : { kind: 'branch', commit: checkpoint.success ? checkpoint.data.worktreeCommit : '', branch: branch.trim() } }));
    if (result.status === 'error') throw result.error;
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
    <header className="flex flex-col gap-2"><h2 className="text-body font-medium">Machines</h2><p role="status" className="flex flex-wrap items-center gap-2 text-caption tabular-nums"><StatusDot color={summary.color} />{profile ? `${profile} · ` : ''}{summary.ready} ready / {summary.count} machines · {summary.label}</p><p className="text-caption text-muted-foreground">Workspace files belong to the cloud. Every normal attachment is an equal local cache. Commands require an online, prepared cache.</p></header>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {runtimeLfsHeldBack(snapshot).length ? <p role="alert" className="text-caption text-warning">Uncommitted Git LFS changes are held back on their machine. Commit them before reclamation or detaching.</p> : null}
    <label className="flex flex-col gap-2 text-caption">Default machine<select aria-describedby="execution-machine-help" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={execution.defaultMachineId ?? ''} disabled={pending} onChange={event => void changeExecutionMachine(event.target.value || null)}><option value="">Automatic · first ready cache</option>{execution.defaultMachineId && !caches.some(item => item.machineId === execution.defaultMachineId) ? <option value={execution.defaultMachineId} disabled>{execution.defaultMachineId} · unavailable</option> : null}{caches.map(item => <option key={item.attachmentId} value={item.machineId}>{machineLabel(item.machineId)}</option>)}</select></label>
    <p id="execution-machine-help" className="text-caption text-muted-foreground">Default selects where commands run; conversation and terminal selection stay independent.</p>
    {!attached.length ? <EmptyState title="No machine" description="Cloud files and conversations remain available. Add a machine to run commands." /> : attached.map(attachment => <CacheMachineRow key={attachment.attachmentId} attachment={attachment} name={machineLabel(attachment.machineId)} isDefault={execution.defaultMachineId === attachment.machineId} pending={pending} now={now} onAction={next => void action(attachment, next)} onDefault={() => void changeExecutionMachine(attachment.machineId)} onDetach={() => void detach(attachment)} onOpenLog={onOpenLog} blockers={renderBlockers?.(attachment.machineId)} runs={renderRuns?.(attachment.machineId)} />)}
    <ReleasedMachineList attachments={lost} label={machineLabel} />
    <form className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`} onSubmit={event => { event.preventDefault(); void requestAttachment(); }}>
      <h3 className="text-body font-medium">Add machine</h3>
      <label className="flex flex-col gap-2 text-caption">Enrolled machine<select aria-label="Enrolled machine" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={machineId} onChange={event => setMachineId(event.target.value)} disabled={pending}><option value="">Choose a machine</option>{(machines ?? []).map(machine => <option key={machine.id} value={machine.id}>{machine.label} · {machine.state}</option>)}</select></label>
      <label className="flex flex-col gap-2 text-caption">Working copy<select aria-label="Working copy" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={checkout} onChange={event => { if (event.target.value === 'cache' || event.target.value === 'snapshot' || event.target.value === 'branch') setCheckout(event.target.value); }} disabled={pending}><option value="cache">Workspace cache</option><option value="snapshot">Runner · pinned snapshot</option><option value="branch">Delegate · separate branch</option></select></label>
      {checkout !== 'cache' && !checkpoint.success ? <p role="status" className="text-caption">Publish a workspace checkpoint before attaching a runner or delegate.</p> : null}
      {checkout === 'branch' ? <label className="flex flex-col gap-2 text-caption">Delegate branch<input className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={branch} onChange={event => setBranch(event.target.value)} disabled={pending} required /></label> : null}
      {machinesQuery.state === 'failure' ? <p role="alert" className="text-caption text-destructive">{rpcErrorMessage(machinesQuery.error, 'Read enrolled machines')}<Button variant="ghost" onClick={() => void machinesQuery.refetch()}>Retry machines</Button></p> : null}
      <Button type="submit" variant="primary" disabled={pending || (checkout !== 'cache' && !checkpoint.success) || !machineId || (checkout === 'branch' && !branch.trim())} loading={pending}>Add machine</Button>
    </form>
    <RuntimeBrowserGroups key={`${snapshot.projectId}:${snapshot.workspaceId}`} snapshot={snapshot} machines={machines ?? []} />
    {lfsTransition.dialog}
  </section>;
}
