import { useEffect, useRef, useState } from 'react';
import type { RuntimeProjectBrowserPreferences, RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import { Badge, Button, InputField, InputGroup } from '@gitspace/ui';
import { projectBrowserSettings, updateProjectBrowserSettings } from './browser-relay-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Browser = RuntimeProjectBrowserSettings['browsers'][number];
export function ProjectBrowserSettings({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<RuntimeProjectBrowserSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    let active = true;
    setSettings(null); setError(null);
    void projectBrowserSettings(projectId).then(value => { if (active) setSettings(value); }, cause => { if (active) setError(rpcErrorMessage(cause, 'Read project Chrome permissions')); });
    return () => { active = false; };
  }, [projectId]);
  const refresh = async () => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { setSettings(await projectBrowserSettings(projectId)); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Read project Chrome permissions')); }
    finally { busy.current = false; setPending(false); }
  };
  const update = async (preferences: RuntimeProjectBrowserPreferences) => {
    if (!settings || busy.current) return false;
    busy.current = true; setPending(true); setError(null);
    try { setSettings(await updateProjectBrowserSettings(projectId, settings.revision, preferences)); return true; }
    catch (cause) { setError(rpcErrorMessage(cause, 'Update project Chrome permissions')); return false; }
    finally { busy.current = false; setPending(false); }
  };
  const approvals = settings?.browsers.filter(browser => browser.approved).map(({ pairingId, name, note }) => ({ pairingId, name, note })) ?? [];
  return <section aria-label="Project Chrome permissions" className="flex flex-col gap-3">
    <div className="flex items-center justify-between gap-3"><h3 className="text-body font-medium">Your Chromes for this project</h3><Button variant="ghost" disabled={pending} onClick={() => void refresh()}>Refresh Chromes</Button></div>
    <p className="text-caption text-muted-foreground">These are your personal permissions, not shared repository settings. Approved Chromes can be used by agents in every workspace in this project. Each workspace gets its own tab group; site approvals still apply.</p>
    {!settings && !error ? <p role="status" className="text-caption text-muted-foreground">Loading your paired Chromes…</p> : null}
    {settings?.browsers.length === 0 ? <p className="text-caption text-muted-foreground">Pair and confirm a Chrome in Settings → Connections → Browser Relay first.</p> : null}
    {settings?.browsers.map(browser => <ProjectChromeRow key={browser.pairingId} browser={browser} isDefault={settings.defaultPairingId === browser.pairingId} pending={pending}
      onToggle={() => update({
        defaultPairingId: browser.approved ? settings.defaultPairingId === browser.pairingId ? null : settings.defaultPairingId : settings.defaultPairingId ?? browser.pairingId,
        approvals: browser.approved ? approvals.filter(item => item.pairingId !== browser.pairingId) : [...approvals, { pairingId: browser.pairingId, name: browser.name, note: browser.note }],
      })}
      onDefault={() => update({ defaultPairingId: browser.pairingId, approvals })}
      onSave={(name, note) => update({ defaultPairingId: settings.defaultPairingId, approvals: approvals.map(item => item.pairingId === browser.pairingId ? { ...item, name, note } : item) })}
    />)}
    {settings && approvals.length > 0 && settings.defaultPairingId === null ? <p role="status" className="text-caption text-muted-foreground">Choose a project default for requests that do not name a Chrome.</p> : null}
    <p className="text-caption text-muted-foreground">Offline Chromes remain listed but cannot receive actions. Revoking a Chrome here stops its use throughout this project without changing other projects or approved Chromes.</p>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </section>;
}
function ProjectChromeRow({ browser, isDefault, pending, onToggle, onDefault, onSave }: {
  browser: Browser; isDefault: boolean; pending: boolean;
  onToggle(): Promise<boolean>; onDefault(): Promise<boolean>; onSave(name: string, note: string): Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(browser.name);
  const [note, setNote] = useState(browser.note);
  return <div className="flex flex-col gap-3 rounded-xl border border-border/60 p-3">
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1"><p className="break-words text-body font-medium">{browser.name}</p>{browser.note ? <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{browser.note}</p> : null}<p className="break-all font-mono text-caption text-muted-foreground">{browser.pairingId}</p></div>
      <Badge color={browser.connected ? 'green' : 'gray'}>{browser.connected ? 'Online' : 'Offline'}</Badge>
      {isDefault ? <Badge color="gray">Project default</Badge> : null}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button variant={browser.approved ? 'secondary' : 'primary'} aria-label={`${browser.approved ? 'Revoke' : 'Approve'} ${browser.name}`} disabled={pending} onClick={() => void onToggle()}>{browser.approved ? 'Revoke for project' : 'Approve for project'}</Button>
      {browser.approved && !isDefault ? <Button variant="secondary" disabled={pending} onClick={() => void onDefault()}>Make project default</Button> : null}
      {browser.approved ? <Button variant="ghost" disabled={pending} onClick={() => { setName(browser.name); setNote(browser.note); setEditing(value => !value); }}>Edit name and note</Button> : null}
    </div>
    {editing && browser.approved ? <form className="flex flex-col gap-3" onSubmit={async event => { event.preventDefault(); if (await onSave(name.trim(), note)) setEditing(false); }}>
      <InputGroup><InputField index={0} label="Chrome name" value={name} onChange={setName} disabled={pending} /><InputField index={1} label="Note for agents" value={note} onChange={setNote} disabled={pending} placeholder="For example, staging admin account" /></InputGroup>
      <div className="flex gap-2"><Button type="submit" variant="secondary" disabled={pending || !name.trim()}>Save name and note</Button><Button type="button" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>Cancel</Button></div>
    </form> : null}
  </div>;
}
