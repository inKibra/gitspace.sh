import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeIdentitySchema, type RuntimeBrowserStatus, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { Badge, Button, useShape } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type MachineStatus = { machineId: string | null; status: RuntimeBrowserStatus | null; error: string | null };
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
    const ids: Array<string | null> = [null, ...snapshot.attachments.filter(attachment => attachment.state === 'ready' && attachment.capabilities.includes('browser.headless')).map(attachment => attachment.machineId)];
    try {
      const values = await Promise.all(ids.map(async machineId => {
        try {
          const result = await request({ type: 'browserStatus', ...(machineId === null ? {} : { machineId }) }, signal);
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
    <p className="text-caption text-muted-foreground">Headless browsing runs in the cloud or on an attached executor. Your Chrome extension connects directly to your account. Group grants expire automatically. Revocation stops new commands but does not erase agent history.</p>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {rows.map(row => <div key={row.machineId ?? 'account'} className="flex flex-col gap-3"><h4 className="text-caption font-semibold">{row.machineId === null ? 'Account browsers' : machines.find(machine => machine.id === row.machineId)?.label ?? row.machineId}</h4>
      {row.error ? <p role="alert" className="text-caption text-destructive">{row.error}{row.status ? ' Last observed state shown; refresh to confirm.' : ''}</p> : null}
      {row.status && row.status.groups.length === 0 && row.status.records.length === 0 ? <p className="text-caption text-muted-foreground">No browser groups or recovery records.</p> : null}
      {row.status?.groups.map(group => <div key={group.groupId} className="flex flex-wrap items-start gap-3 rounded-lg bg-surface-3 p-3"><div className="min-w-0 flex-1"><p className="break-words text-body">{group.groupName} <Badge color={group.state === 'active' ? 'green' : 'gray'}>{group.state}</Badge></p><p className="break-all font-mono text-caption">{group.source === 'headless' ? 'Unrestricted headless' : group.origins.join(', ')}</p><p className="mt-1 text-caption text-muted-foreground">{group.source === 'relay' ? 'Chrome relay · workspace group tabs only' : 'Headless workspace profile'}</p><p className="text-caption tabular-nums text-muted-foreground">Expires <time dateTime={group.expiresAt}>{new Date(group.expiresAt).toLocaleString()}</time></p>{group.reason ? <p className="text-caption text-muted-foreground">{group.reason}</p> : null}</div>{group.state === 'active' || group.state === 'fenced' ? <Button variant="secondary" disabled={pending !== null} loading={pending === group.groupId} onClick={() => void mutate(group.groupId, { type: 'browserRevoke', ...(row.machineId === null ? {} : {machineId:row.machineId}), groupId: group.groupId })}>Revoke group access</Button> : null}</div>)}
      {row.status?.records.map(record => <div key={record.id} className="flex flex-col gap-2 rounded-lg bg-surface-3 p-3"><div className="flex items-center gap-2"><Badge color={record.state === 'stopped' ? 'gray' : 'amber'}>{record.state}</Badge><span className="break-all font-mono text-caption">{record.id}</span></div><p className="text-caption">{record.reason}</p>{record.expiresAt ? <p className="text-caption tabular-nums text-muted-foreground">Fence expires <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString()}</time></p> : null}<div className="flex flex-wrap gap-2">{row.machineId !== null && record.actions.includes('reconcile') ? <Button variant="secondary" disabled={pending !== null} loading={pending === record.id} onClick={() => { const machineId = row.machineId; if (machineId !== null) void mutate(record.id, { type: 'browserReconcile', machineId, recordId: record.id }); }}>Reconcile process</Button> : null}{row.machineId !== null && record.actions.includes('discard') ? <Button variant="ghost" disabled={pending !== null} onClick={() => { const machineId = row.machineId; if (machineId !== null) void mutate(record.id, { type: 'browserDiscard', machineId, recordId: record.id }); }}>Discard stopped record</Button> : null}</div></div>)}
    </div>)}
  </section>;
}
