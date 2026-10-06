import { useRef, useState } from 'react';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeAttachmentRequestInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeExecutionDocumentSchema, RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { Badge, Button, ScrollArea, useShape } from '@gitspace/ui';
import { EmptyState } from './GitSpaceShell.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useAccountMachines } from './SynchronizationProvider.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { RuntimeBrowserGroups } from './RuntimeBrowser.js';
import { runtimeLfsHeldBack, useLfsTransition } from './LfsTransition.js';

export function RuntimeMachines({ snapshot, conversationId, onSelectConversation, onCommitFirst }: { snapshot: RuntimeSnapshot; conversationId?: string; onSelectConversation(id: string): void; onCommitFirst?(): void | Promise<void> }) {
  const shape = useShape();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const identity = RuntimeIdentitySchema.parse(snapshot);
  const machinesQuery = useAccountMachines();
  const machines = useRetainedQueryValue(machinesQuery, 'machines');
  const [machineId, setMachineId] = useState('');
  const [checkout, setCheckout] = useState<'primary' | 'replica' | 'snapshot' | 'branch'>('snapshot');
  const [branch, setBranch] = useState('');
  const checkpoint = RuntimeGitCheckpointSchema.safeParse(snapshot.documents['gitspace.code']);
  const execution = snapshot.documents['gitspace.execution'] === undefined ? { defaultMachineId: null } : RuntimeExecutionDocumentSchema.parse(snapshot.documents['gitspace.execution']);
  const replicas = snapshot.attachments.filter(attachment => (attachment.role === 'primary' || attachment.role === 'replica') && attachment.state !== 'detached');
  const lfsTransition = useLfsTransition();
  const changeExecutionMachine = async (selectedMachineId: string | null) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const result = await rpcClient.runtime.executionMachine({ ...identity, machineId: selectedMachineId === null ? null : RuntimeMachineIdSchema.parse(selectedMachineId) });
      if (result.status === 'error') throw result.error;
    } catch (cause) { setError(rpcErrorMessage(cause, 'Change default execution machine')); }
    finally { busy.current = false; setPending(false); }
  };
  const requestAttachment = async () => {
    if (busy.current || (checkout !== 'primary' && !checkpoint.success)) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const requestId = crypto.randomUUID();
      const result = checkout === 'primary'
        ? await rpcClient.runtime.attachment.primary.request({ ...identity, machineId: RuntimeMachineIdSchema.parse(machineId), requestId })
        : await rpcClient.runtime.attachment.request(RuntimeAttachmentRequestInputSchema.parse({ ...identity, requestId, machineId, ...(checkout === 'replica' ? { role: 'replica' } : {}), sourceRef: checkpoint.success ? checkpoint.data.checkpointRef : '', checkout: checkout === 'snapshot' ? { kind: 'snapshot', commit: checkpoint.success ? checkpoint.data.worktreeCommit : '' } : { kind: 'branch', commit: checkpoint.success ? checkpoint.data.worktreeCommit : '', branch: checkout === 'replica' ? `gitspace/replica/${requestId}` : branch.trim() } }));
      if (result.status === 'error') throw result.error;
    } catch (cause) { setError(rpcErrorMessage(cause, 'Request machine attachment')); }
    finally { busy.current = false; setPending(false); }
  };
  const detach = async (attachment: RuntimeSnapshot['attachments'][number]) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try {
      if (!await lfsTransition.confirm(runtimeLfsHeldBack(snapshot), () => {
        if (onCommitFirst) return onCommitFirst();
        const conversation = snapshot.conversations.find(item => item.id === conversationId) ?? snapshot.conversations.find(item => item.parentId === null);
        if (conversation) onSelectConversation(conversation.id);
      })) return;
    } catch (cause) { setError(rpcErrorMessage(cause, 'Review local LFS changes')); return; }
    finally { busy.current = false; setPending(false); }
    busy.current = true; setPending(true);
    try {
      const result = await rpcClient.runtime.attachment.detach({ ...identity, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation });
      if (result.status === 'error') throw result.error;
    } catch (cause) { setError(rpcErrorMessage(cause, 'Detach machine')); }
    finally { busy.current = false; setPending(false); }
  };
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
    <p className="text-body text-muted-foreground">Workspace files belong to the cloud. Attached machines sync program replicas to run commands; disconnecting a machine does not move or remove the cloud working copy. Attachments authorize effects separately from connectivity.</p>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    <section className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`}>
      <h3 className="text-body font-medium">Default execution machine</h3>
      <p id="execution-machine-help" className="text-caption text-muted-foreground">Choose where workspace commands run. Automatic uses the first ready replica. Private runners stay pinned to their selected snapshot; delegates keep their separate branch.</p>
      <label className="flex flex-col gap-2 text-caption">Execution machine<select aria-describedby="execution-machine-help" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={execution.defaultMachineId ?? ''} disabled={pending} onChange={event => void changeExecutionMachine(event.target.value || null)}>
        <option value="">Automatic · first ready replica</option>
        {execution.defaultMachineId && !replicas.some(attachment => attachment.machineId === execution.defaultMachineId) ? <option value={execution.defaultMachineId} disabled>{execution.defaultMachineId} · unavailable</option> : null}
        {replicas.map(attachment => <option key={attachment.attachmentId} value={attachment.machineId} disabled={attachment.state !== 'ready'}>{machines?.find(machine => machine.id === attachment.machineId)?.label ?? attachment.machineId} · {attachment.state}</option>)}
      </select></label>
    </section>
    {!snapshot.attachments.length ? <EmptyState title="No machines attached" description="Cloud files and conversations remain available. Attach a syncing program replica, a private runner, or a delegate." /> : snapshot.attachments.map(attachment => <section key={attachment.attachmentId} className={`${shape.container} bg-surface-2 p-4 shadow-surface-1`}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{machines?.find(machine => machine.id === attachment.machineId)?.label ?? attachment.machineId}</h3><Badge>{attachment.role === 'primary' ? 'Replica' : attachment.role} · {attachment.state}</Badge></div><p className="mt-2 text-caption text-muted-foreground tabular-nums">Generation {attachment.generation} · {attachment.checkout.kind} · {attachment.checkout.kind === 'snapshot' ? attachment.checkout.commit : attachment.checkout.branch}</p><p className="mt-2 text-caption text-muted-foreground">{attachment.capabilities.join(' · ')}</p>{attachment.state !== 'detached' ? <Button variant="secondary" disabled={pending || attachment.state === 'draining'} onClick={() => void detach(attachment)}>{attachment.state === 'draining' ? 'Detaching…' : 'Detach'}</Button> : null}{attachment.state === 'draining' ? <p role="status" className="mt-2 text-caption text-muted-foreground">Waiting for execution cleanup. This replica remains fenced until cleanup completes.</p> : null}</section>)}
    <form className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`} onSubmit={(event) => { event.preventDefault(); void requestAttachment(); }}>
      <h3 className="text-body font-medium">Attach a machine</h3>
      <p className="text-caption text-muted-foreground">A program replica syncs the cloud working copy. Private runners use a pinned checkpoint. Delegates use a separate branch.</p>
      {checkout !== 'primary' ? checkpoint.success ? <p className="break-all font-mono text-caption tabular-nums">Source {checkpoint.data.worktreeCommit}</p> : <p role="status" className="text-caption text-muted-foreground">Publish a workspace checkpoint before attaching a private replica, runner, or delegate.</p> : null}
      <label className="flex flex-col gap-2 text-caption">Enrolled machine<select aria-label="Enrolled machine" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={machineId} onChange={(event) => setMachineId(event.target.value)} disabled={pending}><option value="">Choose a machine</option>{(machines ?? []).map((machine) => <option key={machine.id} value={machine.id}>{machine.label} · {machine.state}</option>)}</select></label>
      <label className="flex flex-col gap-2 text-caption">Working copy<select aria-label="Working copy" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={checkout} onChange={(event) => { if (event.target.value === 'primary' || event.target.value === 'replica' || event.target.value === 'snapshot' || event.target.value === 'branch') setCheckout(event.target.value); }} disabled={pending}><option value="primary">Program replica · materialized workspace</option><option value="replica">Program replica · private syncing copy</option><option value="snapshot">Runner · pinned snapshot</option><option value="branch">Delegate · separate branch</option></select></label>
      {checkout === 'branch' ? <label className="flex flex-col gap-2 text-caption">Delegate branch<input className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={pending} required /></label> : null}
      {machinesQuery.state === 'failure' ? <p role="alert" className="text-caption text-destructive">{rpcErrorMessage(machinesQuery.error, 'Read enrolled machines')}<Button variant="ghost" onClick={() => void machinesQuery.refetch()}>Retry machines</Button></p> : null}
      <Button type="submit" variant="primary" disabled={pending || (checkout !== 'primary' && !checkpoint.success) || !machineId || (checkout === 'branch' && !branch.trim())} loading={pending}>Request attachment</Button>
    </form>
    <RuntimeBrowserGroups key={`${snapshot.projectId}:${snapshot.workspaceId}`} snapshot={snapshot} conversationId={conversationId} machines={machines ?? []} />
    {lfsTransition.dialog}
  </div></ScrollArea>;
}
