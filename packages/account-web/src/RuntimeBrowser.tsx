import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeIdentitySchema, type RuntimeBrowserApprovalCard, type RuntimeBrowserStatus, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { Badge, Button, useShape } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export function BrowserApprovalCard({ request, requestDetails, machineName, connected, onAnswer }: { request: RuntimeBrowserApprovalCard; requestDetails?: string; machineName?: string; connected: boolean; onAnswer(approved: boolean): Promise<void> }) {
  const shape = useShape();
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => { setError(null); }, [request.id]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expired = Date.parse(request.expiresAt) <= now;
  const answer = async (approved: boolean) => {
    if (busy.current || !connected || (approved && Date.parse(request.expiresAt) <= Date.now())) return;
    busy.current = true; setPending(true); setError(null);
    try { await onAnswer(approved); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Answer browser request')); }
    finally { busy.current = false; setPending(false); }
  };
  return <section aria-label="Browser approval" className={`${shape.container} pointer-events-auto mb-2 flex max-h-[55dvh] flex-col gap-3 overflow-y-auto bg-surface-3 p-4 shadow-surface-3`}>
    <div className="flex items-start justify-between gap-3"><h2 className="text-body font-semibold text-balance">Create workspace browser group?</h2><Badge color={expired ? 'gray' : 'amber'}>{expired ? 'Expired' : 'Approval required'}</Badge></div>
    <p className="break-words text-body font-medium">{request.groupName}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-caption">
      <dt className="text-muted-foreground">Approved origins</dt><dd className="break-all font-mono font-semibold">{request.origins.join(', ') || 'None'}</dd>
      <dt className="text-muted-foreground">Machine</dt><dd className="break-words">{machineName ?? request.machineId}</dd>
      <dt className="text-muted-foreground">Browser</dt><dd>{request.source === 'relay' ? 'Your Chrome profile · Browser Relay' : 'Workspace-owned headless profile'}</dd>
      <dt className="text-muted-foreground">Access</dt><dd>Only tabs in this workspace group. JavaScript and screenshots included.</dd>
      <dt className="text-muted-foreground">Expires</dt><dd className="tabular-nums"><time dateTime={request.expiresAt}>{new Date(request.expiresAt).toLocaleString()}</time>{expired ? '' : ` · ${Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now) / 1000))}s`}</dd>
    </dl>
    {requestDetails ? <details className="text-caption"><summary className="flex min-h-10 cursor-pointer items-center font-medium">Review complete request</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-2 p-3">{requestDetails}</pre></details> : null}
    <p className="text-caption text-muted-foreground text-pretty">This creates a named Chrome group for the workspace. Environment approvals control allowed origins; this decision cannot broaden them. Tabs dragged out become inaccessible. Observations and screenshots may enter agent history. Revoke the group from Workspace machines.</p>
    {!connected ? <p role="status" className="text-caption text-muted-foreground">Reconnect before answering.</p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    <div className="flex justify-end gap-2"><Button variant="secondary" disabled={pending || !connected} onClick={() => void answer(false)}>Reject</Button><Button variant="primary" loading={pending} disabled={pending || expired || !connected} onClick={() => void answer(true)}>Create browser group</Button></div>
  </section>;
}

type MachineStatus = { machineId: string; status: RuntimeBrowserStatus | null; error: string | null };
export function RuntimeBrowserGroups({ snapshot, conversationId, machines }: { snapshot: RuntimeSnapshot; conversationId?: string; machines: readonly { id: string; label: string; kind: string }[] }) {
  const shape = useShape();
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  const machineIds = JSON.stringify([...new Set(snapshot.attachments.filter(attachment => attachment.state === 'ready' && attachment.capabilities.some(capability => capability.startsWith('browser.'))).map(attachment => attachment.machineId))].sort());
  const [rows, setRows] = useState<MachineStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const request = useCallback(async (command: RuntimeSessionCommand, signal?: AbortSignal) => {
    const response = await rpcClient.runtime.session({ ...identity, ...(conversationId ? { conversationId } : {}), command }, { signal });
    if (response.status === 'error') throw response.error;
    return response.value;
  }, [identity, conversationId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const ids: string[] = JSON.parse(machineIds);
    try {
      const values = await Promise.all(ids.map(async machineId => {
        try {
          const result = await request({ type: 'browserStatus', machineId }, signal);
          if (!result.browserStatus) throw new Error('The machine did not return browser status.');
          return { machineId, status: result.browserStatus, error: null };
        } catch (cause) { return { machineId, status: null, error: rpcErrorMessage(cause, 'Read browser groups') }; }
      }));
      if (!signal?.aborted) setRows(previous => values.map(row => ({ ...row, status: row.status ?? previous.find(item => item.machineId === row.machineId)?.status ?? null })));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [machineIds, request]);
  useEffect(() => { setRows([]); const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  const mutate = async (key: string, command: RuntimeSessionCommand) => {
    if (busy.current) return;
    busy.current = true; setPending(key); setError(null);
    try { await request(command); await refresh(); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Manage browser access')); }
    finally { busy.current = false; setPending(null); }
  };
  return <section aria-label="Browser groups" className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-body font-medium">Browser access and recovery</h3><Button variant="ghost" loading={loading} disabled={loading || pending !== null} onClick={() => void refresh()}>Refresh browser status</Button></div>
    <p className="text-caption text-muted-foreground">Headless browsing runs on an attached executor. Logged-in Chrome requires your own physical machine. Group grants expire automatically. Revocation stops new commands but does not erase agent history. Headless workspace profiles persist.</p>
    {machineIds === '[]' ? <p className="text-caption text-muted-foreground">Attach a browser-capable machine to use browser control.</p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {rows.map(row => <div key={row.machineId} className="flex flex-col gap-3"><h4 className="text-caption font-semibold">{machines.find(machine => machine.id === row.machineId)?.label ?? row.machineId}</h4>
      {row.error ? <p role="alert" className="text-caption text-destructive">{row.error}{row.status ? ' Last observed state shown; refresh to confirm.' : ''}</p> : null}
      {row.status && row.status.groups.length === 0 && row.status.records.length === 0 ? <p className="text-caption text-muted-foreground">No browser groups or recovery records.</p> : null}
      {row.status?.groups.map(group => <div key={group.groupId} className="flex flex-wrap items-start gap-3 rounded-lg bg-surface-3 p-3"><div className="min-w-0 flex-1"><p className="break-words text-body">{group.groupName} <Badge color={group.state === 'active' ? 'green' : 'gray'}>{group.state}</Badge></p><p className="break-all font-mono text-caption">{group.source === 'headless' ? 'Unrestricted headless' : group.origins.join(', ')}</p><p className="mt-1 text-caption text-muted-foreground">{group.source === 'relay' ? 'Chrome relay · workspace group tabs only' : 'Headless workspace profile'}</p><p className="text-caption tabular-nums text-muted-foreground">Expires <time dateTime={group.expiresAt}>{new Date(group.expiresAt).toLocaleString()}</time></p>{group.reason ? <p className="text-caption text-muted-foreground">{group.reason}</p> : null}</div>{group.state === 'active' || group.state === 'fenced' ? <Button variant="secondary" disabled={pending !== null} loading={pending === group.groupId} onClick={() => void mutate(group.groupId, { type: 'browserRevoke', machineId: row.machineId, groupId: group.groupId })}>Revoke group access</Button> : null}</div>)}
      {row.status?.records.map(record => <div key={record.id} className="flex flex-col gap-2 rounded-lg bg-surface-3 p-3"><div className="flex items-center gap-2"><Badge color={record.state === 'stopped' ? 'gray' : 'amber'}>{record.state}</Badge><span className="break-all font-mono text-caption">{record.id}</span></div><p className="text-caption">{record.reason}</p>{record.expiresAt ? <p className="text-caption tabular-nums text-muted-foreground">Fence expires <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString()}</time></p> : null}<div className="flex flex-wrap gap-2">{record.actions.includes('reconcile') ? <Button variant="secondary" disabled={pending !== null} loading={pending === record.id} onClick={() => void mutate(record.id, { type: 'browserReconcile', machineId: row.machineId, recordId: record.id })}>Reconcile process</Button> : null}{record.actions.includes('discard') ? <Button variant="ghost" disabled={pending !== null} onClick={() => void mutate(record.id, { type: 'browserDiscard', machineId: row.machineId, recordId: record.id })}>Discard stopped record</Button> : null}</div></div>)}
    </div>)}
  </section>;
}
