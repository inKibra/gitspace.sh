import { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@gitspace/ui';
import { z } from 'zod';
import { createDeviceSignedFetch, loadDevice, DeviceRejectedError } from './device.js';
const signedFetch = createDeviceSignedFetch(loadDevice, code => { throw new DeviceRejectedError(code); });
export function ServiceAccessApproval() {
  const query = new URLSearchParams(window.location.search);
  const hostname = query.get('hostname') ?? '';
  const state = query.get('state') ?? '';
  const returnTo = query.get('returnTo') ?? '/';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function approve() {
    setBusy(true); setError(null);
    try {
      const response = await signedFetch('/api/services/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostname, state, returnTo }) });
      if (!response.ok) throw new Error('Service approval was rejected. Open the service again to retry.');
      const result = z.object({ status: z.literal('ok'), value: z.object({ callback: z.string().url() }) }).parse(await response.json());
      const callback = new URL(result.value.callback);
      if (callback.protocol !== 'https:' || callback.hostname !== hostname || callback.pathname !== '/__gitspace/auth' || callback.username || callback.password || callback.port) throw new Error('Invalid service callback');
      window.location.assign(callback.href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not approve service access'); setBusy(false); }
  }
  return <main className="flex min-h-dvh items-center justify-center bg-background p-6"><Card className="w-full max-w-lg"><CardHeader><CardTitle>Open this private service?</CardTitle><CardDescription>Approve access for this browser to this exact service address for 15 minutes.</CardDescription></CardHeader><CardContent><p className="break-all font-mono text-sm">{hostname}</p><p className="mt-4 text-sm text-muted-foreground">Other service addresses stay private. This does not publish the service or grant access to another account.</p>{error ? <p role="alert" className="mt-4 text-sm text-destructive">{error}</p> : null}</CardContent><CardFooter className="gap-3"><Button disabled={busy || !hostname || !state} loading={busy} onClick={() => void approve()}>Approve this service</Button><Button variant="secondary" disabled={busy} onClick={() => window.location.assign('/')}>Cancel</Button></CardFooter></Card></main>;
}
