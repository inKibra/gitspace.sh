import { useState } from 'react';
import { useResultQuery } from 'result-rpc/react';
import { QRCodeSVG } from 'qrcode.react';
import { Key01 } from '@untitledui/icons';
import { SERVICE_TOKEN_HEADER, SERVICE_TOKEN_MAX_TTL_S, ServiceTokenSubjectSchema, type ServiceTokenGrant, type ServiceTokensView } from '@gitspace/protocol-environment';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputCopy, InputField, InputGroup } from '@gitspace/ui';
import { StatusDot } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';

const KeyIcon = glyph(Key01);
/** Lifetimes an app token can be copied with; the last is the maximum and the default. */
const LIFETIMES = [{ seconds: 60 * 60, label: '1 hour' }, { seconds: 4 * 60 * 60, label: '4 hours' }, { seconds: SERVICE_TOKEN_MAX_TTL_S, label: '8 hours' }] as const;

/** Signs one app token for the service and shows it once; unmounting the dialog discards it. */
function CopyAppTokenDialog({ spaceId, service, urls, onClose, onMinted }: { spaceId: string; service: string; urls: ServiceTokensView['urls']; onClose(): void; onMinted(): void }) {
  const [subject, setSubject] = useState('');
  const [ttlSeconds, setTtlSeconds] = useState<number>(SERVICE_TOKEN_MAX_TTL_S);
  const [refresh, setRefresh] = useState(false);
  const [port, setPort] = useState(urls[0]?.port ?? '');
  const [grant, setGrant] = useState<ServiceTokenGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = ServiceTokenSubjectSchema.safeParse(subject);
  const mint = (): void => {
    if (busy || !parsed.success) return;
    setBusy(true); setError(null);
    void (async () => {
      const result = await rpcClient.environment.mintServiceToken({ spaceId, service, ...(port ? { port } : {}), subject: parsed.data, ttlSeconds, refresh });
      if (result.status === 'error') throw result.error;
      setGrant(result.value);
      onMinted();
    })().catch((cause: unknown) => setError(rpcErrorMessage(cause, 'Copy app token'))).finally(() => setBusy(false));
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{grant ? `App token for ${grant.subject}` : `Copy app token for ${service}`}</DialogTitle>
        <DialogDescription>{grant ? 'Shown once. Copy it now; closing this dialog discards it. Revoke it from the issued tokens list.' : `Signs a token an app, script or agent sends as ${SERVICE_TOKEN_HEADER} to the workspace URL. Only routes that set tokens: true admit it.`}</DialogDescription>
      </DialogHeader>
      {grant ? <section aria-label="App token" className="flex flex-col gap-3 text-caption">
        <InputCopy label="Token" value={grant.token} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Header</dt><dd><code className="font-mono">{grant.header}</code></dd>
          <dt className="text-muted-foreground">URL</dt><dd className="break-all"><code className="font-mono">{grant.url}</code></dd>
          <dt className="text-muted-foreground">Expires</dt><dd className="tabular-nums">{new Date(grant.expiresAt).toLocaleString()}</dd>
          {grant.refreshExpiresAt ? <><dt className="text-muted-foreground">Refresh expires</dt><dd className="tabular-nums">{new Date(grant.refreshExpiresAt).toLocaleString()}</dd></> : null}
        </dl>
        {grant.refreshToken ? <InputCopy label="Refresh token" value={grant.refreshToken} /> : null}
        {grant.refreshUrl ? <InputCopy label="Refresh URL" value={grant.refreshUrl} /> : null}
        {grant.refreshToken ? <p className="text-muted-foreground text-pretty">POST {'{"refresh_token": …}'} as JSON to the refresh URL for a new token and refresh token. Each refresh token works once; using a spent one revokes the chain.</p> : null}
        <figure className="flex flex-col items-center gap-3">
          <QRCodeSVG value={JSON.stringify({ url: grant.url, header: grant.header, token: grant.token, expiresAt: grant.expiresAt, ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}), ...(grant.refreshUrl ? { refreshUrl: grant.refreshUrl } : {}) })} size={256} level="L" marginSize={4} title="Scan to load this app token on a phone" className="h-auto max-w-full rounded-lg bg-white" />
          <figcaption className="text-center text-muted-foreground">Scan with a phone build: the URL, header, token{grant.refreshToken ? ' and refresh token' : ''} as JSON.</figcaption>
        </figure>
      </section> : <div className="flex flex-col gap-3 text-caption">
        <InputGroup><InputField index={0} label="Subject" placeholder="ios-dev/brad" value={subject} onChange={setSubject} error={subject && !parsed.success ? parsed.error.issues[0]?.message : undefined} /></InputGroup>
        {urls.length > 1 ? <select aria-label="Workspace URL" className="min-h-10 rounded-md bg-surface-3 px-3 text-caption" value={port} disabled={busy} onChange={event => setPort(event.target.value)}>
          {urls.map(entry => <option key={entry.port} value={entry.port}>{entry.url}</option>)}
        </select> : null}
        <select aria-label="Lifetime" className="min-h-10 rounded-md bg-surface-3 px-3 text-caption" value={ttlSeconds} disabled={busy} onChange={event => setTtlSeconds(Number(event.target.value))}>
          {LIFETIMES.map(entry => <option key={entry.seconds} value={entry.seconds}>{entry.label}</option>)}
        </select>
        <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={refresh} disabled={busy} onChange={event => setRefresh(event.target.checked)} />Include refresh token<span className="text-muted-foreground">· good for 7 days, replaced on every use</span></label>
      </div>}
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={onClose}>{grant ? 'Done' : 'Cancel'}</Button>
        {grant ? null : <Button variant="primary" loading={busy} disabled={busy || !parsed.success} onClick={mint}>Copy app token</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** One service's GitSpace-signed tokens: its workspace URLs, managed keys, and the tokens issued for it. */
export function ServiceTokens({ spaceId, service }: { spaceId: string; service: string }) {
  const query = useResultQuery(rpcClient.environment.serviceTokens, { spaceId, service });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [minting, setMinting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const view = query.state === 'success' ? query.value : query.state === 'failure' ? query.previous : undefined;
  const mutate = (operation: () => Promise<unknown>, label: string): void => {
    if (busy) return;
    setActionError(null); setBusy(true);
    void operation().then(() => query.refetch()).catch((error: unknown) => setActionError(rpcErrorMessage(error, label))).finally(() => setBusy(false));
  };
  const keys = view ? view.keys.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)) : [];
  return <div aria-label={`Setup step Service tokens ${service}`} className="flex flex-col">
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
      <span className="flex flex-col"><span className="text-caption font-medium">Service tokens · <code className="font-mono">{service}</code></span><span className="text-caption text-muted-foreground">Apps, scripts and agents send them as <code className="font-mono">{SERVICE_TOKEN_HEADER}</code> on routes that set tokens: true.</span></span>
      <Button variant="secondary" size="compact" leadingIcon={KeyIcon} disabled={!view || !view.urls.length} onClick={() => setMinting(true)}>Copy app token</Button>
    </div>
    {query.state === 'failure' ? <p role="alert" className="text-caption text-destructive">{rpcErrorMessage(query.error, 'Load service tokens')}<Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry</Button></p> : null}
    {actionError ? <p role="alert" tabIndex={0} className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-caption text-destructive">{actionError}</p> : null}
    {!view ? query.state === 'pending' ? <p role="status" className="text-caption text-muted-foreground">Loading service tokens…</p> : null : <>
      <ul aria-label="Workspace URLs" className="flex flex-col">{view.urls.length ? view.urls.map(entry => <li key={entry.port} className="flex min-h-10 flex-wrap items-center gap-2 text-caption">
        <span className="shrink-0 text-muted-foreground">{entry.port}</span><code className="min-w-0 flex-1 break-all font-mono">{entry.url}</code>
      </li>) : <li className="text-caption text-muted-foreground">No workspace URL for this service yet.</li>}</ul>
      <div className="flex min-h-10 items-center justify-between gap-2"><span className="text-caption text-muted-foreground">Managed keys · rotate every 7 days</span><Button variant="ghost" size="compact" disabled={busy} onClick={() => setRotating(true)}>Rotate now</Button></div>
      <ul aria-label="Managed keys" className="flex flex-col">{keys.length ? keys.map((key, index) => <li key={key.fingerprint} aria-label={`Key ${key.fingerprint}`} className="flex min-h-10 flex-wrap items-center gap-2 text-caption">
        <StatusDot color={index === 0 ? 'green' : 'dim'} />
        <code className="font-mono" title={key.fingerprint}>{key.fingerprint.slice(0, 12)}…</code>
        <span className="min-w-0 flex-1 tabular-nums text-muted-foreground">Created {new Date(key.createdAt).toLocaleString()} · {index === 0 ? `signs until ${new Date(key.signsUntil).toLocaleString()}` : `earlier key, verifies its tokens until ${new Date(key.verifiesUntil).toLocaleString()}`}</span>
      </li>) : <li className="text-caption text-muted-foreground">No key yet. The first app token creates one.</li>}</ul>
      <span className="flex min-h-10 items-center text-caption text-muted-foreground">Issued tokens · {view.tokens.length}</span>
      <ul aria-label="Issued tokens" className="flex flex-col">{view.tokens.length ? view.tokens.map(token => <li key={token.id} aria-label={`Token ${token.subject}`} className="flex min-h-10 flex-wrap items-center gap-2 text-caption">
        <StatusDot color={token.revokedAt ? 'dim' : 'green'} />
        <code className="min-w-0 break-all font-mono">{token.subject}</code>
        {token.refreshable ? <Badge size="compact" color="blue">Refreshable</Badge> : null}
        <span className="min-w-0 flex-1 tabular-nums text-muted-foreground">Expires {new Date(token.expiresAt).toLocaleString()} · {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'Never used'}</span>
        {token.revokedAt ? <Badge size="compact" color="gray">Revoked</Badge> : <Button variant="ghost" size="compact" disabled={busy} onClick={() => mutate(async () => { const result = await rpcClient.environment.revokeServiceToken({ spaceId, service, url: token.url, tokenId: token.id }); if (result.status === 'error') throw result.error; }, 'Revoke service token')}>Revoke</Button>}
      </li>) : <li className="text-caption text-muted-foreground">No unexpired tokens.</li>}</ul>
    </>}
    {minting && view ? <CopyAppTokenDialog spaceId={spaceId} service={service} urls={view.urls} onClose={() => setMinting(false)} onMinted={() => void query.refetch()} /> : null}
    <Dialog open={rotating} onOpenChange={setRotating}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Rotate the signing key for {service}?</DialogTitle><DialogDescription>A new key signs from now. This ends every token signed by earlier keys immediately. Apps with a refresh token get a new token on their next refresh.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="secondary" onClick={() => setRotating(false)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => { setRotating(false); mutate(async () => { const result = await rpcClient.environment.rotateServiceTokenKey({ spaceId, service }); if (result.status === 'error') throw result.error; }, 'Rotate service token key'); }}>Rotate key</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
