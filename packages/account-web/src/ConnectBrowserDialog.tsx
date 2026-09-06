import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputCopy } from '@gitspace/ui';
import { QRCodeSVG } from 'qrcode.react';
import type { BrowserInvitation, BrowserInvitationStatus } from './browser-enrollment.js';

export interface BrowserConnectionActions {
  canConnectBrowser: boolean;
  onCreateBrowserInvitation: () => Promise<BrowserInvitation>;
  onBrowserInvitationStatus: (inviteId: string, signal?: AbortSignal) => Promise<BrowserInvitationStatus>;
  onCancelBrowserInvitation: (inviteId: string) => Promise<BrowserInvitationStatus>;
  onBrowserConnected: () => Promise<void>;
}

export function ConnectBrowserDialog({ open, onOpenChange, canConnectBrowser, onCreateBrowserInvitation, onBrowserInvitationStatus, onCancelBrowserInvitation, onBrowserConnected }: BrowserConnectionActions & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [invitation, setInvitation] = useState<BrowserInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [statusError, setStatusError] = useState<string | null>(null);
  const operation = useRef(false);
  const callbacks = useRef({ onBrowserInvitationStatus, onBrowserConnected });
  callbacks.current = { onBrowserInvitationStatus, onBrowserConnected };
  const notified = useRef<string | null>(null);
  const expired = invitation !== null && now >= invitation.expiresAt;
  const pending = invitation?.status === 'pending';

  useEffect(() => {
    if (!open || !pending || expired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open, pending, expired]);

  useEffect(() => {
    if (!open || !invitation || !pending || busy) return;
    const abort = new AbortController();
    let timer: number | undefined;
    const inspect = async () => {
      try {
        const next = await callbacks.current.onBrowserInvitationStatus(invitation.inviteId, abort.signal);
        if (abort.signal.aborted) return;
        setStatusError(null);
        setInvitation(current => current?.inviteId === next.inviteId && current.status === 'pending' ? { ...current, ...next } : current);
        if (next.status !== 'pending') return;
      } catch (cause) {
        if (abort.signal.aborted) return;
        setStatusError(cause instanceof Error ? cause.message : 'Could not check whether the browser connected.');
      }
      if (Date.now() < invitation.expiresAt) timer = window.setTimeout(() => { void inspect(); }, Math.min(2_000, invitation.expiresAt - Date.now()));
    };
    void inspect();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [open, invitation?.inviteId, pending, busy]);

  useEffect(() => {
    if (invitation?.status !== 'redeemed' || notified.current === invitation.inviteId) return;
    notified.current = invitation.inviteId;
    void callbacks.current.onBrowserConnected().catch(cause => setError(cause instanceof Error ? cause.message : 'The browser connected, but the device list could not refresh.'));
  }, [invitation?.status, invitation?.inviteId]);

  const create = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setStatusError(null);
    try {
      setInvitation(await onCreateBrowserInvitation());
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create an enrollment link.');
    } finally { operation.current = false; setBusy(false); }
  };
  const cancel = async (closeAfter: boolean) => {
    if (operation.current) return;
    if (!invitation || invitation.status !== 'pending') { onOpenChange(false); return; }
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await onCancelBrowserInvitation(invitation.inviteId);
      setInvitation(current => current ? { ...current, ...next } : null);
      if (next.status === 'pending') throw new Error('Cancellation was not confirmed. The link may still grant access. Try again.');
      if (closeAfter && next.status !== 'redeemed') onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cancellation was not confirmed. The link may still grant access.');
    } finally { operation.current = false; setBusy(false); }
  };
  const seconds = invitation ? Math.max(0, Math.ceil((invitation.expiresAt - now) / 1_000)) : 0;
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const showLink = invitation && pending && !expired;
  return <Dialog open={open} onOpenChange={next => { if (!next) void cancel(true); }}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{invitation?.status === 'redeemed' ? 'Browser connected' : 'Connect another browser'}</DialogTitle>
        <DialogDescription>{invitation?.status === 'redeemed' ? 'The new browser has its own key. You can revoke it from Browsers at any time.' : 'Anyone with this link can access your whole account, change settings, and connect other devices. Share it only with a browser you trust.'}</DialogDescription>
      </DialogHeader>
      <p className="text-caption text-muted-foreground">The new browser’s access depends on this browser. Signing out or revoking this browser also disconnects browsers and API clients it authorized. Use a recovery key on the new browser for independent access.</p>
      {!invitation ? <p className="text-caption text-muted-foreground">Create a single-use link when the other browser is ready. It expires after five minutes. Your recovery key is not needed.</p> : null}
      {showLink ? <div className="flex flex-col gap-4">
        <InputCopy label="Single-use enrollment link" value={invitation.link} />
        <figure className="flex flex-col items-center gap-3">
          <QRCodeSVG value={invitation.link} size={256} level="M" marginSize={4} title="Scan to connect this account in another browser" className="h-auto max-w-full rounded-lg bg-white" />
          <figcaption className="text-center text-caption text-muted-foreground">Scan with your other device, or open the copied link in another browser.</figcaption>
        </figure>
        <div className="flex items-center justify-between gap-3 text-caption"><Badge color="amber">Waiting for browser</Badge><span className="tabular-nums text-muted-foreground">Expires in {countdown}</span></div>
      </div> : null}
      {invitation?.status === 'redeemed' ? <p role="status" className="text-caption text-foreground">Connected. This link cannot be used again.</p> : null}
      {invitation?.status === 'cancelled' ? <p role="status" className="text-caption text-muted-foreground">Link cancelled. It can no longer connect a browser.</p> : null}
      {invitation?.status === 'expired' || (pending && expired) ? <p role="status" className="text-caption text-muted-foreground">Link expired. Create a new link to connect another browser.</p> : null}
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      {statusError ? <p role="alert" className="text-caption text-destructive">{statusError}</p> : null}
      <DialogFooter>
        {pending && !expired ? <Button variant="secondary" loading={busy} disabled={busy} onClick={() => void cancel(false)}>Cancel link</Button> : <Button variant="secondary" disabled={busy} onClick={() => void cancel(true)}>Done</Button>}
        {!invitation || invitation.status === 'cancelled' || invitation.status === 'expired' || (pending && expired) ? <Button variant="primary" loading={busy} disabled={busy || !canConnectBrowser} onClick={() => void create()}>{invitation ? 'Create new link' : 'Create enrollment link'}</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
