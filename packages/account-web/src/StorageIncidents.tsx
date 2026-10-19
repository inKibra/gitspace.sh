import { useState } from 'react';
import { useResultQuery } from 'result-rpc/react';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useLiveChanges } from './live-notices.js';
import { useEventRefresh } from './SynchronizationProvider.js';

/** Durable Objects whose storage writes ran away: quarantined ones refuse all work until resumed here. */
export function StorageIncidents() {
  const incidents = useResultQuery(rpcClient.storageIncidents.list, {});
  useEventRefresh(useLiveChanges(accountLiveKey('storage-incidents')), () => incidents.refetch());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = incidents.value ?? [];
  if (!items.length) return null;
  const resume = async (objectId: string) => {
    setPending(objectId); setError(null);
    try {
      const result = await rpcClient.storageIncidents.resume({ objectId });
      if (result.status === 'error') throw result.error;
      await incidents.refetch();
    } catch (cause) { setError(rpcErrorMessage(cause, 'Resume storage')); }
    finally { setPending(null); }
  };
  return <section className="flex flex-col gap-3 pb-8">
    <h2 className="text-subtitle font-semibold text-foreground">Storage writes</h2>
    <p className="text-body text-muted-foreground">A paused object refuses all work so a runaway loop stops costing money. Resume it once the cause is fixed.</p>
    <CardGroup orientation="inline" border="outlined" separated>{items.map((item, index) => <Card key={item.objectId} index={index}>
      <CardHeader>
        <CardTitle>{item.name ?? item.className}</CardTitle>
        <CardDescription>{item.reason}</CardDescription>
      </CardHeader>
      <CardFooter className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-caption text-muted-foreground"><Badge size="compact" color={item.kind === 'quarantine' ? 'red' : 'amber'}>{item.kind === 'quarantine' ? 'Paused' : 'High writes'}</Badge>{item.className} · {new Date(item.at).toLocaleString()}</span>
        <Button variant={item.kind === 'quarantine' ? 'primary' : 'secondary'} size="compact" loading={pending === item.objectId} disabled={pending !== null} onClick={() => void resume(item.objectId)}>{item.kind === 'quarantine' ? 'Resume' : 'Dismiss'}</Button>
      </CardFooter>
    </Card>)}</CardGroup>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </section>;
}
