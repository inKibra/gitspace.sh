import type { ArtifactShareView } from '@gitspace/protocol/rpc-contract';
import type { EvidenceReference } from '@gitspace/protocol';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch, ThinkingIndicator } from '@gitspace/ui';
import { useEffect, useId, useState } from 'react';

type ArtifactReference = Extract<EvidenceReference, { kind: 'artifact' }>;
export interface ArtifactActionsHandlers {
  projectFiles: readonly { path: string; hash: string }[];
  copy(files: Array<{ url: string; hash: string; destinationPath: string; expectedDestinationHash: string | null }>): Promise<void>;
  listShares(url: string): Promise<readonly ArtifactShareView[]>;
  createShare(reference: ArtifactReference, expiresAt: string | null): Promise<ArtifactShareView>;
  revokeShare(id: string): Promise<void>;
}

export function ArtifactActions({ selected, actions }: { selected: readonly ArtifactReference[]; actions: ArtifactActionsHandlers }) {
  const formId = useId();
  const [copying, setCopying] = useState<ArtifactReference[] | null>(null);
  const [destinations, setDestinations] = useState<string[]>([]);
  const [replacements, setReplacements] = useState<Record<number, { path: string; hash: string }>>({});
  const [sharing, setSharing] = useState<ArtifactReference | null>(null);
  const [links, setLinks] = useState<readonly ArtifactShareView[] | null>(null);
  const [expiry, setExpiry] = useState('never');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canCopy = selected.length > 0 && selected.every((reference) => reference.url.startsWith('local://workspace/'));
  const existingFile = (path: string) => actions.projectFiles.find((file) => file.path === path);
  const conflict = (path: string, index: number): boolean =>
    actions.projectFiles.some((file) => file.path !== path && (path.startsWith(`${file.path}/`) || file.path.startsWith(`${path}/`)))
    || destinations.some((other, candidate) => candidate !== index && (path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)));
  const confirmed = (path: string, index: number): boolean => {
    const existing = existingFile(path);
    return !existing || (replacements[index]?.path === path && replacements[index]?.hash === existing.hash);
  };
  const invalid = destinations.some((path, index) => !path || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || conflict(path, index) || !confirmed(path, index));
  useEffect(() => {
    if (!sharing) return;
    let cancelled = false;
    setLinks(null);
    void actions.listShares(sharing.url).then((value) => { if (!cancelled) setLinks(value); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [sharing?.url]);
  const copy = async (): Promise<void> => {
    if (!copying || pending || invalid) return;
    setPending(true);
    setError(null);
    try {
      await actions.copy(copying.map((reference, index) => ({ url: reference.url, hash: reference.hash, destinationPath: destinations[index]!, expectedDestinationHash: replacements[index]?.hash ?? null })));
      setNotice(`Copied ${copying.length} ${copying.length === 1 ? 'artifact' : 'artifacts'} to the project.`);
      setCopying(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const create = async (): Promise<void> => {
    if (!sharing || pending) return;
    setPending(true);
    setError(null);
    try {
      const expiresAt = expiry === 'never' ? null : new Date(Date.now() + Number(expiry)).toISOString();
      const created = await actions.createShare(sharing, expiresAt);
      setLinks((current) => [...current ?? [], created]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const revoke = async (id: string): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try { await actions.revokeShare(id); setLinks((current) => current?.filter((link) => link.id !== id) ?? []); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <div className="flex flex-wrap items-center gap-2">
    <Button variant="secondary" size="compact" className="min-h-10" disabled={!canCopy} onClick={() => {
      setError(null); setNotice(null); setReplacements({}); setCopying([...selected]); setDestinations(selected.map((reference) => decodeURIComponent(new URL(reference.url).pathname).replace(/^\/+/, '')));
    }}>Copy to project artifacts</Button>
    <Button variant="secondary" size="compact" className="min-h-10" disabled={selected.length !== 1} onClick={() => { setError(null); setNotice(null); setExpiry('never'); setSharing(selected[0]!); }}>Share</Button>
    {notice ? <span role="status" className="text-caption text-muted-foreground">{notice}</span> : null}
    <Dialog open={copying !== null} onOpenChange={(open) => { if (!open && !pending) setCopying(null); }}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>Copy to project artifacts</DialogTitle><DialogDescription>Copy these published versions into independent project files. Originals and their provenance are preserved. Choose new destination paths or explicitly confirm each replacement.</DialogDescription></DialogHeader>
        <form id={formId} className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto" onSubmit={(event) => { event.preventDefault(); void copy(); }}>
          {copying?.map((reference, index) => <div className="flex flex-col gap-1" key={`${reference.url}@${reference.hash}`}>
            <p className="break-all text-caption text-muted-foreground">{reference.url} · {reference.hash.slice(7, 19)}</p>
            <InputGroup><InputField index={0} label={`Project path for ${reference.label}`} value={destinations[index] ?? ''} onChange={(value) => {
              setDestinations((current) => current.map((path, candidate) => candidate === index ? value : path));
              setReplacements((current) => { const next = { ...current }; delete next[index]; return next; });
            }} autoFocus={index === 0} required disabled={pending} /></InputGroup>
            {conflict(destinations[index] ?? '', index) ? <p role="alert" className="text-caption text-destructive">This destination conflicts with another file. Choose a different path.</p> : null}
            {existingFile(destinations[index] ?? '') && !conflict(destinations[index] ?? '', index) ? <div className="flex min-h-10 flex-col gap-2 py-2">
              <p className="text-caption text-muted-foreground">A project file already exists here. Choose another path or replace the displayed version.</p>
              <Switch label={`Replace project file ${destinations[index]}`} checked={confirmed(destinations[index]!, index)} disabled={pending} onToggle={() => setReplacements((current) => {
                const next = { ...current };
                const existing = existingFile(destinations[index]!);
                if (confirmed(destinations[index]!, index)) delete next[index];
                else if (existing) next[index] = { ...existing };
                return next;
              })} />
              <span className="font-mono text-caption text-muted-foreground">{existingFile(destinations[index]!)!.hash.slice(7, 19)}</span>
            </div> : null}
          </div>)}
          {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
        </form>
        <DialogFooter><Button variant="secondary" disabled={pending} onClick={() => setCopying(null)}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={invalid || pending} loading={pending}>Copy {copying?.length ?? 0} {(copying?.length ?? 0) === 1 ? 'artifact' : 'artifacts'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={sharing !== null} onOpenChange={(open) => { if (!open && !pending) setSharing(null); }}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>Share {sharing?.label}</DialogTitle><DialogDescription>Anyone with the link can download this fixed version, without signing in. Do not share secrets. Later edits do not change the link. Revoking a link prevents new downloads, but cannot remove copies already downloaded.</DialogDescription></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 text-body"><span>Link expires</span><Select value={expiry} onValueChange={setExpiry} disabled={pending}><SelectTrigger aria-label="Link expiry" /><SelectContent>{[{ value: 'never', label: 'Never' }, { value: '3600000', label: 'In 1 hour' }, { value: '86400000', label: 'In 1 day' }, { value: '604800000', label: 'In 7 days' }].map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
          <Button variant="primary" disabled={pending || links === null} loading={pending} onClick={() => void create()}>Create public link</Button>
          <h3 className="text-body font-medium">Active links</h3>
          {links === null && !error ? <ThinkingIndicator aria-label="Loading share links" /> : links?.length === 0 ? <p className="text-caption text-muted-foreground">No active links for this artifact.</p> : null}
          <div className="flex max-h-[35vh] flex-col gap-3 overflow-y-auto">{links?.map((link) => <div className="flex flex-col gap-1" key={link.id}>
            <InputCopy label="Public download link" value={new URL(link.url, window.location.origin).href} />
            <div className="flex items-center justify-between gap-2"><span className="text-caption text-muted-foreground tabular-nums">{link.hash.slice(7, 19)} · {link.expiresAt ? `Expires ${new Date(link.expiresAt).toLocaleString()}` : 'Does not expire'}</span><Button variant="secondary" size="compact" className="min-h-10" disabled={pending} onClick={() => void revoke(link.id)}>Revoke</Button></div>
          </div>)}</div>
          {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
        </div>
        <DialogFooter><Button variant="secondary" disabled={pending} onClick={() => setSharing(null)}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
