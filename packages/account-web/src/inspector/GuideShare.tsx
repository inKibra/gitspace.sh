import type { GuideShareView } from '@gitspace/protocol/rpc-contract';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputCopy, Select, SelectContent, SelectItem, SelectTrigger, ThinkingIndicator } from '@gitspace/ui';
import { useEffect, useState } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';

export interface GuideShareHandlers {
  list(): Promise<readonly GuideShareView[]>;
  create(expiresAt: string | null): Promise<GuideShareView>;
  revoke(id: string): Promise<void>;
}

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: '86400000', label: 'In 1 day' },
  { value: '604800000', label: 'In 7 days' },
  { value: '2592000000', label: 'In 30 days' },
];

/** Shares the current Change Guide revision read-only: links pin that revision and can expire or be revoked. */
export function GuideShareButton({ revision, shares }: { revision: number; shares: GuideShareHandlers }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<readonly GuideShareView[] | null>(null);
  const [expiry, setExpiry] = useState('never');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLinks(null);
    void shares.list().then((value) => { if (!cancelled) setLinks(value); }).catch((cause: unknown) => { if (!cancelled) setError(rpcErrorMessage(cause, 'List guide shares')); });
    return () => { cancelled = true; };
  }, [open]);
  const run = async (action: () => Promise<void>, operation: string): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(rpcErrorMessage(cause, operation)); }
    finally { setPending(false); }
  };
  const create = () => run(async () => {
    const created = await shares.create(expiry === 'never' ? null : new Date(Date.now() + Number(expiry)).toISOString());
    setLinks((current) => [...current ?? [], created]);
  }, 'Share Change Guide');
  const revoke = (id: string) => run(async () => {
    await shares.revoke(id);
    setLinks((current) => current?.filter((link) => link.id !== id) ?? []);
  }, 'Revoke guide share');
  return <>
    <Button variant="secondary" size="compact" type="button" onClick={() => { setError(null); setExpiry('never'); setOpen(true); }}>Share</Button>
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) setOpen(false); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Share Change Guide</DialogTitle>
          <DialogDescription>The link shows this revision of the guide and its diffs, read-only. Anyone with the link can read a public repository’s guide; for a private repository, readers sign in with GitHub and must be able to read the repository. Later revisions do not change the link.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 text-body"><span>Link expires</span><Select value={expiry} onValueChange={setExpiry} disabled={pending}><SelectTrigger aria-label="Link expiry" /><SelectContent>{EXPIRY_OPTIONS.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
          <Button variant="primary" disabled={pending || links === null} loading={pending} onClick={() => void create()}>Create link to revision {revision}</Button>
          <h3 className="text-body font-medium">Active links</h3>
          {links === null && !error ? <ThinkingIndicator aria-label="Loading share links" /> : links?.length === 0 ? <p className="text-caption text-muted-foreground">No active links for this guide.</p> : null}
          <div className="flex max-h-[35vh] flex-col gap-3 overflow-y-auto">{links?.map((link) => <div className="flex flex-col gap-1" key={link.id}>
            <InputCopy label={link.access === 'public' ? 'Anyone with the link' : `GitHub readers of ${link.repository}`} value={new URL(link.url, window.location.origin).href} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption text-muted-foreground tabular-nums">Revision {link.guideRevision} · {link.headCommit.slice(0, 7)} · {link.expiresAt ? `Expires ${new Date(link.expiresAt).toLocaleString()}` : 'Does not expire'}</span>
              <Button variant="secondary" size="compact" className="min-h-10" disabled={pending} onClick={() => void revoke(link.id)}>Revoke</Button>
            </div>
          </div>)}</div>
          {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
        </div>
        <DialogFooter><Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
