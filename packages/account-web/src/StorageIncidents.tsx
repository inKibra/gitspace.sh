import { useState, type ReactElement } from 'react';
import { useResultQuery } from 'result-rpc/react';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import type { StorageIncidentView } from '@gitspace/protocol/rpc-contract';
import { Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle } from '@gitspace/ui';
import { EmptyState } from './GitSpaceShell.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useLiveChanges } from './live-notices.js';
import { useEventRefresh } from './SynchronizationProvider.js';
import { useRetainedRead } from './useRetainedRead.js';
import { formatRelativeTime } from './relative-time.js';

const KIND_LABEL: Record<StorageIncidentView['kind'], string> = { quarantine: 'Paused', alert: 'Alert' };

/**
 * The account's Durable Objects whose storage ran away or that the watchdog found past an alert threshold. A paused
 * (quarantined) object refuses all work until it is resumed here; an alert resolves when the watchdog finds the object
 * back under every threshold, or when it is dismissed. Resolved incidents of the last seven days are listed below.
 */
export function StorageIncidents(): ReactElement {
  const incidents = useResultQuery(rpcClient.storageIncidents.list, {});
  useEventRefresh(useLiveChanges(accountLiveKey('storage-incidents')), () => incidents.refetch());
  const read = useRetainedRead(incidents, 'storage-incidents');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = read.value ?? [];
  const active = items.filter(item => item.resolvedAt === null);
  const resolved = items.flatMap(item => item.resolvedAt === null ? [] : [{ ...item, resolvedAt: item.resolvedAt }]).toSorted((a, b) => b.resolvedAt.localeCompare(a.resolvedAt));
  const resume = async (objectId: string) => {
    setPending(objectId); setError(null);
    try {
      const result = await rpcClient.storageIncidents.resume({ objectId });
      if (result.status === 'error') throw result.error;
      await incidents.refetch();
    } catch (cause) { setError(rpcErrorMessage(cause, 'Resume storage')); }
    finally { setPending(null); }
  };
  return <section aria-label="Storage incidents" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <h2 className="text-subtitle font-semibold text-foreground">Storage incidents</h2>
      <span className="text-caption tabular-nums text-muted-foreground">{active.length} active · {resolved.length} resolved in the last 7 days</span>
    </div>
    <p className="text-body text-muted-foreground">A paused object refuses all work so a runaway loop stops costing money: resume it once the cause is fixed. An alert closes by itself when the watchdog next finds the object back under its thresholds.</p>
    {read.error && !read.value ? <p role="alert" className="flex flex-wrap items-center gap-2 text-caption text-destructive">{rpcErrorMessage(read.error, 'Read storage incidents')}<Button variant="ghost" size="compact" onClick={() => void incidents.refetch()}>Retry</Button></p> : null}
    {active.length ? <CardGroup border="outlined" separated proximityHover={false} className="gap-4">{active.map((item, index) => <Card key={`${item.objectId}:${item.at}`} index={index}>
      <CardHeader>
        <CardTitle><span className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 [overflow-wrap:anywhere]">{item.name ?? item.className}</span><Badge size="compact" color={item.kind === 'quarantine' ? 'red' : 'amber'}>{KIND_LABEL[item.kind]}</Badge></span></CardTitle>
        <CardDescription>{item.reason}</CardDescription>
      </CardHeader>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-caption text-muted-foreground [overflow-wrap:anywhere]">{item.className} · <span className="font-mono">{item.objectId.slice(0, 12)}…</span> · began <span title={new Date(item.at).toLocaleString()}>{formatRelativeTime(new Date(item.at))}</span></span>
        <Button variant={item.kind === 'quarantine' ? 'primary' : 'secondary'} size="compact" loading={pending === item.objectId} disabled={pending !== null} onClick={() => void resume(item.objectId)}>{item.kind === 'quarantine' ? 'Resume' : 'Dismiss'}</Button>
      </CardFooter>
    </Card>)}</CardGroup>
      : <EmptyState title={read.initialLoading ? 'Loading storage incidents…' : 'Nothing needs attention'} description={read.initialLoading ? undefined : 'No object is paused, and none is past the watchdog\'s alert thresholds.'} />}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {resolved.length ? <div className="flex flex-col gap-2 pt-4">
      <h3 className="text-body font-semibold text-foreground">Resolved</h3>
      <ul aria-label="Resolved storage incidents" className="flex flex-col divide-y divide-border border-y border-border">{resolved.map(item => <li key={`${item.objectId}:${item.at}`} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-body text-foreground"><Badge variant="dot" size="compact" color="gray">{KIND_LABEL[item.kind]}</Badge><span className="min-w-0 [overflow-wrap:anywhere]">{item.name ?? item.className}</span></span>
          <span className="text-caption text-muted-foreground">{item.reason}</span>
          <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{item.className} · <span className="font-mono">{item.objectId.slice(0, 12)}…</span> · began <span title={new Date(item.at).toLocaleString()}>{formatRelativeTime(new Date(item.at))}</span></span>
        </div>
        <span className="shrink-0 text-caption tabular-nums text-muted-foreground" title={new Date(item.resolvedAt).toLocaleString()}>Resolved {formatRelativeTime(new Date(item.resolvedAt))}</span>
      </li>)}</ul>
    </div> : null}
  </section>;
}
