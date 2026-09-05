import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, InputCopy } from '@gitspace/ui';
import { credentialAuthorityGrantPayload, encodeMachinePairingToken, type DeviceGrantRecord } from '@gitspace/protocol';
import { credentialProtocolBase64, type CredentialAuthorityGrant, type SignedCredentialAuthorityGrant } from '@gitspace/protocol/credential-vault';
import { createDeviceSignedFetch, DeviceRejectedError, loadDevice } from './device.js';
import type { SettingsMachineView } from './SettingsPage.js';

interface Pairing {
  pairingId: string;
  token: string;
  expiresAt: number;
  userId: string;
  operatorUrl: string;
}
interface PairingStatus {
  pairingId: string;
  state: 'created' | 'claimed' | 'approved' | 'enrolled' | 'cancelled';
  expiresAt: number;
  machine: { machineId: string; label: string; signingPublicKey: string; exchangePublicKey: string } | null;
  grant: CredentialAuthorityGrant | null;
  issuerChain: DeviceGrantRecord[];
}
const signedFetch = createDeviceSignedFetch(loadDevice, code => { throw new DeviceRejectedError(code); });
async function requestPairing<T>(action: string, payload: object, signal?: AbortSignal): Promise<T> {
  const device = await loadDevice();
  if (!device) throw new Error('Reconnect this browser to your account before adding a machine.');
  const response = await signedFetch(new URL(`/v1/machine-pairings/${action}`, device.enrollUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, userId: device.userId }), signal });
  const result = await response.json() as { status: string; value: T; error?: { message?: string } };
  if (!response.ok || result.status !== 'ok') throw new Error(result.error?.message ?? `Pairing request failed (HTTP ${response.status})`);
  return result.value;
}

export function AddMachinePanel({ machines, onClose }: { machines: readonly SettingsMachineView[]; onClose: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const machine = machines.find(item => item.id === status?.machine?.machineId);
  useEffect(() => {
    if (!pairing || status?.state === 'enrolled' || status?.state === 'cancelled') return;
    const abort = new AbortController();
    let timer: number | undefined;
    const inspect = async () => {
      if (Date.now() >= pairing.expiresAt) { setExpired(true); return; }
      try {
        const next = await requestPairing<PairingStatus>('inspect', { pairingId: pairing.pairingId }, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next);
        setError(null);
        if (next.state === 'enrolled' || next.state === 'cancelled') return;
      } catch (cause) {
        if (abort.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Could not check machine pairing');
      }
      timer = window.setTimeout(() => { void inspect(); }, 2_000);
    };
    void inspect();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [pairing, status?.state]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const device = await loadDevice();
      if (!device?.canDelegate) throw new Error('This browser cannot authorize machines. Recover your account in the browser to obtain an account-wide device grant.');
      const created = await requestPairing<Omit<Pairing, 'userId' | 'operatorUrl'>>('create', {});
      setPairing({ ...created, userId: device.userId, operatorUrl: new URL(device.enrollUrl).origin + '/' });
      setStatus(null);
      setExpired(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create pairing command'); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!pairing || !status?.grant) return;
    setBusy(true);
    setError(null);
    try {
      const device = await loadDevice();
      if (!device || status.grant.issuerDeviceId !== device.deviceId) throw new Error('The approving browser changed. Create a new pairing command.');
      const payload = Uint8Array.from(credentialAuthorityGrantPayload(status.grant));
      const signature = credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, payload)));
      const grant: SignedCredentialAuthorityGrant = { grant: status.grant, signature, issuerChain: status.issuerChain };
      await requestPairing('approve', { pairingId: pairing.pairingId, grant });
      setStatus({ ...status, state: 'approved' });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not approve machine'); }
    finally { setBusy(false); }
  };
  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      if (pairing && status?.state !== 'enrolled' && !expired) await requestPairing('cancel', { pairingId: pairing.pairingId });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel pairing'); }
    finally { setBusy(false); }
  };
  const now = Date.now();
  const command = pairing && !expired && pairing.expiresAt > now && (!status || status.state === 'created')
    ? `"$HOME/.local/bin/gitspace" machine setup --pair ${encodeMachinePairingToken({ version: 1, ...pairing }, now)}` : null;
  return <Card>
    <CardHeader>
      <CardTitle>Add your computer</CardTitle>
      <CardDescription>Link a Mac or Linux computer to this account. GitSpace includes its runtime; you do not need a source checkout, Bun, or your account recovery key.</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-body font-semibold">1. Install on the computer you want to connect</h3>
        <p className="text-body text-muted-foreground">Install Git and the OpenSSH client first. On Windows, use a supported Linux distribution in WSL. The installer detects the platform and checks the download.</p>
        <InputCopy value="curl -fsSL https://gitspace.sh/install | sh" />
        <p className="text-caption text-muted-foreground">The pairing command uses the default install location, so you do not need to change your PATH.</p>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-body font-semibold">2. Pair this computer</h3>
        {!pairing || expired || status?.state === 'cancelled' ? <>
          <p className="text-body text-muted-foreground">Generate a command for this account, run it on that computer, then approve the matching signing key below. The command expires after ten minutes.</p>
          {expired ? <p role="status" className="text-caption text-muted-foreground">The pairing command expired. Cancel any old attempt in the terminal before starting a new one.</p> : null}
          <div><Button variant="primary" disabled={busy} onClick={() => { void create(); }}>{busy ? 'Creating command...' : 'Generate pairing command'}</Button></div>
        </> : null}
        {command ? <><InputCopy value={command} /><p role="status" className="text-caption text-muted-foreground">Waiting for the computer. Expires at <span className="tabular-nums">{new Date(pairing!.expiresAt).toLocaleTimeString()}</span>.</p></> : null}
        {status?.machine ? <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-4">
          <strong className="text-body">{status.machine.label}</strong>
          <span className="text-caption text-muted-foreground">Signing key, which must match the key printed in that computer’s terminal:</span>
          <code className="break-all text-caption">{status.machine.signingPublicKey}</code>
          {status.state === 'claimed' && !expired ? <>
            <p className="text-body text-muted-foreground">Only approve a computer you control. It can run agents, access this account’s workspace data and configured credentials, and apply account-authorized releases. Your recovery key is not shared.</p>
            <div><Button variant="primary" disabled={busy} onClick={() => { void approve(); }}>{busy ? 'Approving...' : 'Approve this computer'}</Button></div>
          </> : null}
        </div> : null}
      </section>
      {status?.state === 'approved' || status?.state === 'enrolled' ? <section className="flex flex-col gap-2" aria-live="polite">
        <h3 className="text-body font-semibold">3. Wait for the runtime to connect</h3>
        <div><Badge color={machine?.state === 'online' ? 'green' : 'blue'}>{machine?.state === 'online' ? 'Connected' : 'Installing or connecting'}</Badge></div>
        <p className="text-body text-muted-foreground">{machine?.state === 'online' ? 'This computer is ready for workspace placement. Its software releases are managed from your account.' : 'The terminal downloads the verified runtime and starts it. This can take a few minutes. Keep the terminal open until it reports readiness.'}</p>
        {machine?.error ? <p role="alert" className="text-body text-destructive">{machine.error}</p> : null}
        <p className="text-caption text-muted-foreground">If setup was interrupted after linking, run <code>gitspace machine start</code>. Use <code>gitspace doctor</code> or <code>gitspace machine status</code> to diagnose a connection problem.</p>
      </section> : null}
      {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
    </CardContent>
    <CardFooter><Button variant="secondary" disabled={busy} onClick={() => { void close(); }}>{status?.state === 'enrolled' ? 'Done' : 'Cancel pairing'}</Button></CardFooter>
  </Card>;
}
