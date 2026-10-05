import { useRef, useState } from 'react';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeAttachmentRequestInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { Badge, Button, ScrollArea, useShape } from '@gitspace/ui';
import { EmptyState } from './GitSpaceShell.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useAccountMachines } from './SynchronizationProvider.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { RuntimeBrowserGroups } from './RuntimeBrowser.js';

export function RuntimeMachines({ snapshot, conversationId, onSelectConversation }: { snapshot: RuntimeSnapshot; conversationId?: string; onSelectConversation(id: string): void }) {
  const shape = useShape();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const identity = RuntimeIdentitySchema.parse(snapshot);
  const machinesQuery = useAccountMachines();
  const machines = useRetainedQueryValue(machinesQuery, 'machines');
  const [machineId, setMachineId] = useState('');
  const [checkout, setCheckout] = useState<'primary' | 'snapshot' | 'branch'>('snapshot');
  const [branch, setBranch] = useState('');
  const checkpoint = RuntimeGitCheckpointSchema.safeParse(snapshot.documents['gitspace.code']);
  const requestAttachment = async () => {
    if (busy.current || (checkout !== 'primary' && !checkpoint.success)) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const requestId = crypto.randomUUID();
      const result = checkout === 'primary'
        ? await rpcClient.runtime.attachment.primary.request({ ...identity, machineId: RuntimeMachineIdSchema.parse(machineId), requestId })
        : await rpcClient.runtime.attachment.request(RuntimeAttachmentRequestInputSchema.parse({ ...identity, requestId, machineId, sourceRef: checkpoint.success ? checkpoint.data.checkpointRef : '', checkout: checkout === 'snapshot' ? { kind: 'snapshot', commit: checkpoint.success ? checkpoint.data.worktreeCommit : '' } : { kind: 'branch', commit: checkpoint.success ? checkpoint.data.worktreeCommit : '', branch: branch.trim() } }));
      if (result.status === 'error') throw result.error;
    } catch (cause) { setError(rpcErrorMessage(cause, 'Request machine attachment')); }
    finally { busy.current = false; setPending(false); }
  };
  const detach = async (attachment: RuntimeSnapshot['attachments'][number]) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const result = await rpcClient.runtime.attachment.detach({ ...identity, machineId: attachment.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation });
      if (result.status === 'error') throw result.error;
    } catch (cause) { setError(rpcErrorMessage(cause, 'Detach machine')); }
    finally { busy.current = false; setPending(false); }
  };
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="mx-auto flex max-w-3xl flex-col gap-4 p-6"><p className="text-body text-muted-foreground">Attachments authorize effects separately from connectivity. A disconnected machine does not transfer primary ownership. All filesystem and shell tools follow the conversation’s fixed working copy.</p>{error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}{!snapshot.attachments.length ? <EmptyState title="No machines attached" description="Cloud conversations and saved state remain available. Attach the canonical workspace holder as primary, or attach a private runner or delegate." /> : snapshot.attachments.map(attachment => <section key={attachment.attachmentId} className={`${shape.container} bg-surface-2 p-4 shadow-surface-1`}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{machines?.find(machine => machine.id === attachment.machineId)?.label ?? attachment.machineId}</h3><Badge>{attachment.role} · {attachment.state}</Badge></div><p className="mt-2 text-caption text-muted-foreground tabular-nums">Generation {attachment.generation} · {attachment.checkout.kind} · {attachment.checkout.kind === 'snapshot' ? attachment.checkout.commit : attachment.checkout.branch}</p><p className="mt-2 text-caption text-muted-foreground">{attachment.capabilities.join(' · ')}</p><ul className="mt-2 text-caption">{snapshot.conversations.filter(item => item.placement?.attachmentId === attachment.attachmentId).map(item => <li key={item.id}><Button variant="ghost" onClick={() => onSelectConversation(item.id)}>{item.title || item.id} · generation {item.placement?.generation}</Button></li>)}</ul>{attachment.state !== 'detached' ? <Button variant="secondary" disabled={pending || attachment.state === 'draining'} onClick={() => void detach(attachment)}>{attachment.state === 'draining' ? 'Detaching…' : 'Detach'}</Button> : null}{attachment.state === 'draining' ? <p role="status" className="mt-2 text-caption text-muted-foreground">Waiting for execution cleanup. This working copy remains fenced until cleanup completes.</p> : null}</section>)}
    <form className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`} onSubmit={(event) => { event.preventDefault(); void requestAttachment(); }}>
      <h3 className="text-body font-medium">Attach a machine</h3>
      <p className="text-caption text-muted-foreground">Primary uses the workspace’s canonical materialized working copy; this never moves ownership. Runners acquire the published checkpoint privately. Delegates use a separate branch.</p>
      {checkout !== 'primary' ? checkpoint.success ? <p className="break-all font-mono text-caption tabular-nums">Source {checkpoint.data.worktreeCommit}</p> : <p role="status" className="text-caption text-muted-foreground">Publish a workspace checkpoint before attaching a runner or delegate.</p> : null}
      <label className="flex flex-col gap-2 text-caption">Enrolled machine<select className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={machineId} onChange={(event) => setMachineId(event.target.value)} disabled={pending}><option value="">Choose a machine</option>{(machines ?? []).map((machine) => <option key={machine.id} value={machine.id}>{machine.label} · {machine.state}</option>)}</select></label>
      <label className="flex flex-col gap-2 text-caption">Working copy<select className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={checkout} onChange={(event) => { if (event.target.value === 'primary' || event.target.value === 'snapshot' || event.target.value === 'branch') setCheckout(event.target.value); }} disabled={pending}><option value="primary">Primary · canonical working copy</option><option value="snapshot">Runner · fixed snapshot</option><option value="branch">Delegate · separate branch</option></select></label>
      {checkout === 'branch' ? <label className="flex flex-col gap-2 text-caption">Delegate branch<input className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={pending} required /></label> : null}
      {machinesQuery.state === 'failure' ? <p role="alert" className="text-caption text-destructive">{rpcErrorMessage(machinesQuery.error, 'Read enrolled machines')}<Button variant="ghost" onClick={() => void machinesQuery.refetch()}>Retry machines</Button></p> : null}
      <Button type="submit" variant="primary" disabled={pending || (checkout !== 'primary' && !checkpoint.success) || !machineId || (checkout === 'branch' && !branch.trim())} loading={pending}>Request attachment</Button>
    </form>
    <RuntimeBrowserGroups key={`${snapshot.projectId}:${snapshot.workspaceId}`} snapshot={snapshot} conversationId={conversationId} machines={machines ?? []} />
    <section className={`${shape.container} bg-surface-2 p-4 shadow-surface-1`}><h3 className="mb-3 text-body font-medium">Conversation placement</h3><p className="text-caption text-muted-foreground">Assign one working copy before machine tools run. Existing placement stays fixed; use a new conversation for another working copy.</p>{snapshot.conversations.map((conversation) => <label key={conversation.id} className="my-3 flex flex-col gap-2 text-caption">{conversation.title || conversation.id}<select aria-label={`Working copy for ${conversation.title || conversation.id}`} className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={conversation.placement?.attachmentId ?? ''} disabled={pending || conversation.placement !== null || conversation.status === 'running' || conversation.status === 'waiting'} onChange={(event) => {
      const attachment = snapshot.attachments.find((item) => item.attachmentId === event.target.value && item.state === 'ready');
      if (!attachment || busy.current) return;
      busy.current = true; setPending(true); setError(null);
      void (async () => {
        try { const result = await rpcClient.runtime.placement({ ...identity, conversationId: conversation.id, placement: { attachmentId: attachment.attachmentId, generation: attachment.generation } }); if (result.status === 'error') throw result.error; }
        catch (cause) { setError(rpcErrorMessage(cause, 'Change conversation placement')); }
        finally { busy.current = false; setPending(false); }
      })();
    }}><option value="" disabled>No working copy selected</option>{snapshot.attachments.map((attachment) => <option key={attachment.attachmentId} value={attachment.attachmentId} disabled={attachment.state !== 'ready'}>{attachment.machineId} · {attachment.role} · {attachment.checkout.kind} · {attachment.state}</option>)}</select>{conversation.placement !== null ? <span className="text-muted-foreground">Working copy fixed for this conversation.</span> : conversation.status === 'running' || conversation.status === 'waiting' ? <span className="text-muted-foreground">Stop this conversation before assigning its working copy.</span> : null}</label>)}</section>
  </div></ScrollArea>;
}
