import { useEffect, useState } from 'react';
import { BROWSER_SHARE_EXPIRIES_MINUTES, RuntimeBrowserShareExpirySchema, type RuntimeBrowserShare } from '@gitspace/protocol-runtime';
import { Badge, Button, useShape } from '@gitspace/ui';
import { Link01 } from '@untitledui/icons';

export type BrowserShareExpiry = (typeof BROWSER_SHARE_EXPIRIES_MINUTES)[number];
export type BrowserShareOptions = { comment: boolean; expiresInMinutes: BrowserShareExpiry };

const EXPIRY_LABEL: Record<BrowserShareExpiry, string> = { 15: '15 minutes', 60: '1 hour', 480: '8 hours', 1440: '24 hours' };
const END_LABEL: Record<NonNullable<RuntimeBrowserShare['endReason']>, string> = { revoked: 'Stopped', expired: 'Expired', closed: 'Tab closed' };
const AUDIT_LABEL: Record<RuntimeBrowserShare['audit'][number]['event'], string> = { created: 'shared the tab', joined: 'joined', left: 'left', commented: 'commented', connected: 'connected the tab to a workspace', ended: 'ended the share' };

/** A share's link in a read-only field, with Copy. */
export function CopyLink({ link, label }: { link: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
  };
  return <div className="flex flex-col gap-1">
    <div className="flex min-w-0 items-center gap-2">
      <input readOnly aria-label={`Link for ${label}`} value={link} onFocus={event => event.currentTarget.select()} className="min-h-8 min-w-0 flex-1 rounded-md bg-surface-3 px-2 font-mono text-caption" />
      <Button variant="secondary" size="compact" aria-label={`Copy link for ${label}`} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
    {failed ? <p role="alert" className="text-caption text-destructive">Copying to the clipboard failed. Select the link and copy it.</p> : null}
  </div>;
}

/** `2 h 15 min left` until `expiresAt`, rounded up to the minute and ticking. */
export function TimeLeft({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.ceil((Date.parse(expiresAt) - now) / 60_000);
  if (minutes <= 0) return <>Ending now</>;
  const hours = Math.floor(minutes / 60);
  return <>{[hours ? `${hours} h` : '', minutes % 60 ? `${minutes % 60} min` : ''].filter(Boolean).join(' ')} left</>;
}

/** A Chrome tab tile's Share: choose comments and expiry, create the link, then copy it. `pending` while this tab's
 * share is being made; `busy` while any Browser tab action runs. */
export function ShareTab({ label, pending, busy, onCreate }: { label: string; pending: boolean; busy: boolean; onCreate(options: BrowserShareOptions, onCreated: (share: RuntimeBrowserShare) => void): void }) {
  const shape = useShape();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState(false);
  const [expiresInMinutes, setExpiresInMinutes] = useState<BrowserShareExpiry>(60);
  const [created, setCreated] = useState<RuntimeBrowserShare | null>(null);
  return <div className="relative">
    <Button variant="ghost" size="icon-compact" aria-label={`Share ${label}`} title="Share" aria-expanded={open} onClick={() => { setOpen(!open); setCreated(null); }}><Link01 width={14} height={14} /></Button>
    {open ? <div role="dialog" aria-label={`Share link for ${label}`} className={`${shape.container} absolute right-0 top-full z-20 mt-1 flex w-72 max-w-[80vw] flex-col gap-3 bg-surface-1 p-3 shadow-surface-3`}>
      {created ? <>
        <p className="text-caption">{created.comment ? 'View, point and comment' : 'View and point'} until <time dateTime={created.expiresAt}>{new Date(created.expiresAt).toLocaleTimeString()}</time>. People with the link never click or type.</p>
        <CopyLink link={created.link} label={label} />
      </> : <>
        <label className="flex items-start gap-2 text-caption">
          <input type="checkbox" checked={comment} disabled={pending} onChange={event => setComment(event.target.checked)} />
          <span>Comments<span className="block text-muted-foreground">People with the link may comment on the page; comments land in this workspace.</span></span>
        </label>
        <label className="flex flex-col gap-1 text-caption">Expires after
          <select aria-label="Expires after" className="min-h-8 rounded-md bg-surface-3 px-2 text-caption" value={expiresInMinutes} disabled={pending} onChange={event => setExpiresInMinutes(RuntimeBrowserShareExpirySchema.parse(Number(event.target.value)))}>
            {BROWSER_SHARE_EXPIRIES_MINUTES.map(minutes => <option key={minutes} value={minutes}>{EXPIRY_LABEL[minutes]}</option>)}
          </select>
        </label>
        <Button variant="secondary" size="compact" disabled={busy} loading={pending} onClick={() => onCreate({ comment, expiresInMinutes }, setCreated)}>Create link</Button>
      </>}
    </div> : null}
  </div>;
}

/** This workspace's live and recently ended shares, newest first: link, who is watching, time left, Stop sharing, and
 * each share's activity folded. `shares` is null until first read. */
export function BrowserShares({ shares, error, pending, onStop }: { shares: readonly RuntimeBrowserShare[] | null; error: string | null; pending: string | null; onStop(shareId: string): void }) {
  return <section aria-label="Shares" className="flex flex-col gap-2">
    <h3 className="text-body font-medium">Shares</h3>
    {error ? <p role="alert" className="text-caption text-destructive">{error}{shares ? ' Showing the last shares read.' : ''}</p> : null}
    {shares === null ? (error ? null : <p role="status" className="text-caption text-muted-foreground">Loading shares…</p>)
      : shares.length === 0 ? <p className="text-caption text-muted-foreground">No shares. Share a tab of your Chrome from its tile; people with the link can watch it and point.</p>
        : <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-1 text-caption">{shares.map(share => {
          const title = share.page.title || share.page.url;
          const live = share.endedAt === null;
          return <li key={share.shareId} aria-label={`Share of ${title}`} className="flex min-w-0 flex-col gap-2 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-body" title={share.page.url}>{title}</p>
              <Badge size="compact" color={live ? 'green' : 'gray'}>{live ? 'Live' : END_LABEL[share.endReason ?? 'revoked']}</Badge>
            </div>
            <p className="text-muted-foreground">{share.comment ? 'View, point and comment' : 'View and point'} · {share.browser}{live ? <> · <TimeLeft expiresAt={share.expiresAt} /></> : share.endedAt ? <> · ended <time dateTime={share.endedAt}>{new Date(share.endedAt).toLocaleString()}</time></> : null}</p>
            {live ? <CopyLink link={share.link} label={title} /> : null}
            {live ? <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1">{share.viewers.length ? <>Watching: {share.viewers.map(viewer => `${viewer.name}${viewer.guest ? ' (guest)' : ''}`).join(', ')}</> : 'Nobody is watching.'}</p>
              <Button variant="secondary" size="compact" aria-label={`Stop sharing ${title}`} disabled={pending !== null} loading={pending === `unshare:${share.shareId}`} onClick={() => onStop(share.shareId)}>Stop sharing</Button>
            </div> : null}
            {share.audit.length ? <details>
              <summary className="cursor-pointer text-muted-foreground">Activity ({share.audit.length})</summary>
              <ul className="mt-1 flex flex-col gap-1">{share.audit.map((row, index) => <li key={`${row.at}:${index}`} className="break-words">
                <time className="tabular-nums text-muted-foreground" dateTime={row.at}>{new Date(row.at).toLocaleTimeString()}</time> {row.by}{row.guest ? ' (guest)' : ''} {AUDIT_LABEL[row.event]}{row.detail ? `: ${row.detail}` : ''}
              </li>)}</ul>
            </details> : null}
          </li>;
        })}</ul>}
  </section>;
}
