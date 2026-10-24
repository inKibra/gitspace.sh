import { useEffect, useRef, useState } from 'react';
import type { RuntimeAccountBrowserPairing, RuntimeAccountBrowserRelayStatus, RuntimeProjectBrowserPreferences, RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import { Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputCopy, InputField, InputGroup, Switch } from '@gitspace/ui';
import { Cloud01, Download01, Monitor01, Plus } from '@untitledui/icons';
import { accountBrowserStatus, confirmAccountBrowser, downloadAccountBrowserExtension, pairAccountBrowser, projectBrowserSettings, renameAccountBrowser, unpairAccountBrowser, updateProjectBrowserSettings } from './browser-relay-client.js';
import { approveChrome, projectApprovals } from './browser-approvals.js';
import { EmptyState } from './GitSpaceShell.js';
import { glyph } from './glyph.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Pairing = RuntimeAccountBrowserRelayStatus['pairings'][number];
type ConfirmedPairing = Extract<Pairing, { state: 'confirmed' }>;
type Project = { id: string; name: string };

/** Your paired Chromes and each project's approvals of them, with the account relay's actions. */
export interface BrowserPluginsState {
  relay: RuntimeAccountBrowserRelayStatus | null;
  /** Each project's Chrome settings, by project id. */
  settings: Readonly<Record<string, RuntimeProjectBrowserSettings>>;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Reads the pairings only, as the pairing dialog does while it waits for the extension. */
  pollStatus(): Promise<RuntimeAccountBrowserRelayStatus>;
  downloadExtension(): Promise<void>;
  pair(): Promise<RuntimeAccountBrowserPairing>;
  confirm(pairingId: string, fingerprint: string): Promise<void>;
  rename(pairingId: string, name: string): Promise<void>;
  forget(pairingId: string): Promise<void>;
  updateProject(projectId: string, expectedRevision: number, preferences: RuntimeProjectBrowserPreferences): Promise<void>;
}

/** What the pairing dialog was opened for: a new Chrome (with a project to approve it in), or resuming one pairing. */
export interface PairChromeRequest { projectId: string | null; pairingId?: string }

const ChromeGlyph = glyph(Monitor01);
const CloudGlyph = glyph(Cloud01);
const PlusGlyph = glyph(Plus);
const DownloadGlyph = glyph(Download01);
const POLL_MS = 2_000;

/** Loads the relay's pairings and every project's Chrome settings for Plugins → Browsers. */
export function useBrowserPlugins(projects: readonly Project[]): BrowserPluginsState {
  const [relay, setRelay] = useState<RuntimeAccountBrowserRelayStatus | null>(null);
  const [settings, setSettings] = useState<Readonly<Record<string, RuntimeProjectBrowserSettings>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const projectIds = projects.map(project => project.id);
  const projectKey = projectIds.join('|');
  const loadSettings = async () => {
    const values = await Promise.all(projectIds.map(projectId => projectBrowserSettings(projectId)));
    const next: Record<string, RuntimeProjectBrowserSettings> = {};
    for (const value of values) next[value.projectId] = value;
    return next;
  };
  const refresh = async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const [status, next] = await Promise.all([accountBrowserStatus(), loadSettings()]);
      if (current !== generation.current) return;
      setRelay(status); setSettings(next); setError(null);
    } catch (cause) { if (current === generation.current) setError(rpcErrorMessage(cause, 'Read your Chromes')); }
    finally { if (current === generation.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [projectKey]);
  const pollStatus = async () => { const value = await accountBrowserStatus(); setRelay(value); return value; };
  return {
    relay, settings, loading, error, refresh, pollStatus,
    downloadExtension: downloadAccountBrowserExtension,
    pair: async () => { const value = await pairAccountBrowser(); await pollStatus(); return value; },
    // A confirmed Chrome joins every project's list, unapproved.
    confirm: async (pairingId, fingerprint) => { setRelay(await confirmAccountBrowser(pairingId, fingerprint)); setSettings(await loadSettings()); },
    rename: async (pairingId, name) => { setRelay(await renameAccountBrowser(pairingId, name)); },
    forget: async (pairingId) => { setRelay(await unpairAccountBrowser(pairingId)); setSettings(await loadSettings()); },
    updateProject: async (projectId, expectedRevision, preferences) => {
      const value = await updateProjectBrowserSettings(projectId, expectedRevision, preferences);
      setSettings(current => ({ ...current, [projectId]: value }));
    },
  };
}

/** One action at a time, with its error; actions are never retried. */
function useSerialAction(label: string) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const run = async (key: string, action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(key); setError(null);
    try { await action(); } catch (cause) { setError(rpcErrorMessage(cause, label)); } finally { busy.current = false; setPending(null); }
  };
  return { pending, error, run };
}

/** Plugins → Browsers: your paired Chromes, pairing in progress, and the built-in cloud browser. */
export function BrowserPlugins({ projects, browsers, query, onPair }: { projects: readonly Project[]; browsers: BrowserPluginsState; query: string; onPair(request: PairChromeRequest): void }) {
  const [managing, setManaging] = useState<string | null>(null);
  const action = useSerialAction('Forget Chrome');
  const pairings = browsers.relay?.pairings ?? [];
  const normalized = query.trim().toLowerCase();
  const confirmed = pairings.filter((pairing): pairing is ConfirmedPairing => pairing.state === 'confirmed');
  const visible = confirmed.filter(pairing => `${pairing.name} ${pairing.browser ?? ''}`.toLowerCase().includes(normalized));
  const inProgress = pairings.filter(pairing => pairing.state !== 'confirmed');
  const managed = confirmed.find(pairing => pairing.pairingId === managing) ?? null;
  return <div className="flex flex-col gap-8">
    <section className="flex flex-col gap-3" aria-labelledby="your-chromes">
      <div><h2 id="your-chromes" className="text-subtitle font-medium text-foreground">Your Chromes</h2><p className="text-body text-muted-foreground">Agents use a Chrome only in projects that approve it, in their workspace&apos;s own tab group and on sites you approve.</p></div>
      {browsers.error ? <p role="alert" className="text-caption text-destructive">{browsers.error}<Button variant="ghost" size="compact" onClick={() => void browsers.refresh()}>Retry</Button></p> : null}
      {browsers.relay === null && browsers.loading ? <EmptyState title="Loading your Chromes…" />
        : visible.length ? <CardGroup orientation="inline" border="outlined" separated>{visible.map(pairing => {
          const approved = projects.filter(project => browsers.settings[project.id]?.browsers.some(browser => browser.pairingId === pairing.pairingId && browser.approved));
          const defaults = projects.filter(project => browsers.settings[project.id]?.defaultPairingId === pairing.pairingId);
          return <Card size="compact" key={pairing.pairingId}>
            <CardMedia icon={ChromeGlyph} />
            <CardHeader>
              <CardTitle>{pairing.name}</CardTitle>
              <CardDescription>{pairing.browser ?? 'Chrome'}{pairing.extension ? ` · extension ${pairing.extension.version ?? 'from before versions were reported'}` : ''}</CardDescription>
              <span className="text-caption tabular-nums text-muted-foreground">Approved in {approved.length} {approved.length === 1 ? 'project' : 'projects'}{defaults.length ? ` · default in ${defaults.map(project => project.name).join(', ')}` : ''}</span>
              {approved.length === 0 ? <span className="text-caption text-amber-600">Not approved in any project, so no agent can use it yet.</span> : null}
            </CardHeader>
            <CardFooter className="gap-2">
              {pairing.extension?.updateRequired ? <Badge color="red">Update the extension</Badge> : <Badge color={pairing.connected ? 'green' : 'gray'}>{pairing.connected ? 'Online' : 'Offline'}</Badge>}
              <Button variant="ghost" onClick={() => setManaging(pairing.pairingId)}>Manage Chrome</Button>
            </CardFooter>
          </Card>;
        })}</CardGroup>
        : <EmptyState icon={<Monitor01 width={22} height={22} strokeWidth={1.5} />} title={confirmed.length ? 'No matching Chromes' : 'No Chrome paired yet'} description={confirmed.length ? 'Change the filter to see your Chromes.' : 'Pair your Chrome to let agents use your signed-in sites, in a tab group of their own.'} action={confirmed.length ? undefined : <Button variant="primary" leadingIcon={PlusGlyph} onClick={() => onPair({ projectId: null })}>Pair a Chrome</Button>} />}
      {inProgress.length ? <div className="flex flex-col gap-2" aria-label="Pairing in progress">{inProgress.map(pairing => <div key={pairing.pairingId} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 p-3">
        {/* An unconfirmed pairing shows nothing the extension reported: its label could claim anything. */}
        <div className="min-w-0 flex-1"><p className="text-body font-medium">Unconfirmed Chrome</p><p className="text-caption text-muted-foreground">{pairing.state === 'awaiting-key' ? `Waiting for the extension · code expires ${new Date(pairing.expiresAt).toLocaleTimeString()}` : 'Fingerprint ready to compare'}</p></div>
        <Badge color="amber">Pairing</Badge>
        <Button variant="secondary" size="compact" disabled={action.pending !== null} onClick={() => onPair({ projectId: null, pairingId: pairing.pairingId })}>Resume</Button>
        <Button variant="ghost" size="compact" disabled={action.pending !== null} loading={action.pending === pairing.pairingId} onClick={() => void action.run(pairing.pairingId, () => browsers.forget(pairing.pairingId))}>Forget</Button>
      </div>)}</div> : null}
      {action.error ? <p role="alert" className="text-caption text-destructive">{action.error}</p> : null}
    </section>
    <section className="flex flex-col gap-3" aria-labelledby="cloud-browser">
      <h2 id="cloud-browser" className="text-subtitle font-medium text-foreground">Built in</h2>
      <CardGroup orientation="inline" border="outlined" separated><Card size="compact">
        <CardMedia icon={CloudGlyph} />
        <CardHeader><CardTitle>Cloud browser</CardTitle><CardDescription>Every project · nothing to pair</CardDescription><span className="text-caption text-muted-foreground">A fresh browser in the cloud for each workspace, signed in to nothing. Agents use it on the sites approved in the workspace&apos;s Environment.</span></CardHeader>
      </Card></CardGroup>
    </section>
    {managed ? <ManageChromeDialog key={managed.pairingId} pairing={managed} projects={projects} browsers={browsers} onClose={() => setManaging(null)} /> : null}
  </div>;
}

function ManageChromeDialog({ pairing, projects, browsers, onClose }: { pairing: ConfirmedPairing; projects: readonly Project[]; browsers: BrowserPluginsState; onClose(): void }) {
  const [name, setName] = useState(pairing.name);
  const { pending, error, run } = useSerialAction('Manage Chrome');
  const id = pairing.pairingId;
  const update = (projectId: string, key: string, preferences: (settings: RuntimeProjectBrowserSettings) => RuntimeProjectBrowserPreferences) => {
    const settings = browsers.settings[projectId];
    if (settings) void run(key, () => browsers.updateProject(projectId, settings.revision, preferences(settings)));
  };
  return <Dialog open onOpenChange={open => { if (!open && pending === null) onClose(); }}><DialogContent size="lg">
    <DialogHeader><DialogTitle>{pairing.name}</DialogTitle><DialogDescription>Its name is the same in every project. Approve it where agents may use it; each project has one default Chrome for agents that do not name one.</DialogDescription></DialogHeader>
    <div className="flex max-h-[60dvh] flex-col gap-5 overflow-y-auto">
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); const next = name.trim(); if (next && next !== pairing.name) void run('rename', () => browsers.rename(id, next)); }}>
        <InputGroup className="min-w-0 flex-1"><InputField index={0} label="Chrome name" value={name} onChange={setName} disabled={pending !== null} /></InputGroup>
        <Button type="submit" variant="secondary" disabled={pending !== null || !name.trim() || name.trim() === pairing.name} loading={pending === 'rename'}>Rename</Button>
      </form>
      <div className="flex flex-col gap-1 text-caption text-muted-foreground">
        <code className="block break-all font-mono">SHA-256 {pairing.pairedKeyFingerprint}</code>
        <span>{pairing.browser ?? 'Chrome'}{pairing.extension ? ` · extension ${pairing.extension.version ?? 'from before versions were reported'} · protocol ${pairing.extension.protocol}` : ''} · {pairing.connected ? 'online' : 'offline'}</span>
        {pairing.extension?.updateRequired ? <span className="text-destructive">This GitSpace release refuses the extension as too old. Download it again and reload it in chrome://extensions.</span> : null}
      </div>
      <section className="flex flex-col gap-2" aria-label="Projects">
        <h3 className="text-body font-medium text-foreground">Projects</h3>
        {projects.length === 0 ? <p className="text-caption text-muted-foreground">Create a project first.</p> : null}
        {projects.map(project => {
          const settings = browsers.settings[project.id];
          const entry = settings?.browsers.find(browser => browser.pairingId === id);
          const approved = entry?.approved ?? false;
          const isDefault = settings?.defaultPairingId === id;
          return <div key={project.id} className="flex flex-col gap-2 rounded-xl border border-border/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-words text-body">{project.name}</span>
              {approved ? isDefault ? <Badge color="gray">Project default</Badge> : <Button variant="ghost" size="compact" disabled={pending !== null} onClick={() => update(project.id, `default:${project.id}`, current => ({ defaultPairingId: id, approvals: projectApprovals(current) }))}>Make default</Button> : null}
              <Switch aria-label={`Approved in ${project.name}`} label={approved ? 'Approved' : 'Not approved'} checked={approved} disabled={pending !== null || !settings} onToggle={() => update(project.id, `approve:${project.id}`, current => approved
                ? { defaultPairingId: current.defaultPairingId === id ? null : current.defaultPairingId, approvals: projectApprovals(current).filter(item => item.pairingId !== id) }
                : approveChrome(current, id))} />
            </div>
            {approved && entry ? <ProjectNote key={entry.note} note={entry.note} projectName={project.name} disabled={pending !== null} onSave={note => update(project.id, `note:${project.id}`, current => ({ defaultPairingId: current.defaultPairingId, approvals: projectApprovals(current).map(item => item.pairingId === id ? { ...item, note } : item) }))} /> : null}
          </div>;
        })}
      </section>
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    </div>
    <DialogFooter>
      <Button variant="ghost" disabled={pending !== null} loading={pending === 'forget'} onClick={() => void run('forget', async () => { await browsers.forget(id); onClose(); })}>Forget this Chrome</Button>
      <Button variant="secondary" disabled={pending !== null} onClick={onClose}>Done</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}

function ProjectNote({ note, projectName, disabled, onSave }: { note: string; projectName: string; disabled: boolean; onSave(note: string): void }) {
  const [draft, setDraft] = useState(note);
  return <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); onSave(draft); }}>
    <InputGroup className="min-w-0 flex-1"><InputField index={0} label={`Note for agents in ${projectName}`} value={draft} onChange={setDraft} disabled={disabled} placeholder="For example, signed in as the staging admin" /></InputGroup>
    {draft !== note ? <Button type="submit" variant="secondary" size="compact" disabled={disabled}>Save note</Button> : null}
  </form>;
}

type PairStep = 'download' | 'pair' | 'confirm' | 'name';
const PAIR_STEP: Record<PairStep, { number: number; title: string }> = {
  download: { number: 1, title: 'Add the extension to Chrome' },
  pair: { number: 2, title: 'Paste the pairing code in the extension' },
  confirm: { number: 3, title: 'Compare fingerprints' },
  name: { number: 4, title: 'Name this Chrome and choose projects' },
};

/** Pair a Chrome in one dialog: download the extension, paste the pairing JSON in its popup, compare the fingerprint
 * the extension reports, then name the Chrome and approve it for projects. */
export function PairChromeDialog({ request, projects, browsers, onClose }: { request: PairChromeRequest; projects: readonly Project[]; browsers: BrowserPluginsState; onClose(): void }) {
  const [step, setStep] = useState<PairStep>(request.pairingId ? 'confirm' : 'download');
  const [pairing, setPairing] = useState<RuntimeAccountBrowserPairing | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(request.pairingId ?? null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<readonly string[]>(request.projectId ? [request.projectId] : []);
  const [pollError, setPollError] = useState<string | null>(null);
  const { pending, error, run } = useSerialAction('Pair a Chrome');
  const identity = browsers.relay?.pairings.find(item => item.pairingId === pairingId) ?? null;
  const fingerprint = identity?.state === 'pending-confirmation' ? identity.pairedKeyFingerprint : null;
  // The extension reports its key on its own; the dialog moves on when it does.
  const shown: PairStep = step === 'pair' && fingerprint ? 'confirm' : step;
  const waiting = pairingId !== null && (shown === 'pair' || shown === 'confirm') && fingerprint === null;
  const poll = useRef(browsers.pollStatus);
  poll.current = browsers.pollStatus;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void poll.current().then(() => setPollError(null), cause => setPollError(rpcErrorMessage(cause, 'Read pairing status'))); }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  const finish = () => void run('finish', async () => {
    if (!pairingId) return;
    const next = name.trim();
    if (next && next !== identity?.name) await browsers.rename(pairingId, next);
    for (const projectId of selected) {
      const settings = browsers.settings[projectId];
      if (settings && !settings.browsers.some(browser => browser.pairingId === pairingId && browser.approved)) await browsers.updateProject(projectId, settings.revision, approveChrome(settings, pairingId));
    }
    onClose();
  });
  const { number, title } = PAIR_STEP[shown];
  return <Dialog open onOpenChange={open => { if (!open && pending === null) onClose(); }}><DialogContent size="lg">
    <DialogHeader><DialogTitle>Pair a Chrome</DialogTitle><DialogDescription>Step {number} of 4 · {title}</DialogDescription></DialogHeader>
    <div className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto">
      {shown === 'download' ? <>
        <p className="text-body text-muted-foreground">Download the GitSpace extension and unzip it into a folder you keep. In Chrome, open the extensions page, turn on Developer mode, choose Load unpacked and select that folder.</p>
        <div><Button variant="secondary" leadingIcon={DownloadGlyph} disabled={pending !== null} loading={pending === 'download'} onClick={() => void run('download', browsers.downloadExtension)}>Download extension</Button></div>
        <InputCopy label="Extensions page" value="chrome://extensions" />
      </> : null}
      {shown === 'pair' && pairing ? <>
        <p className="text-body text-muted-foreground">Open the GitSpace extension from Chrome&apos;s toolbar and paste this. Chrome keeps a private key that never leaves it; your account stores only its public key.</p>
        <InputCopy label="Pairing JSON" value={JSON.stringify(pairing)} />
        <p className="text-caption tabular-nums text-muted-foreground">Works once, until <time dateTime={pairing.expiresAt}>{new Date(pairing.expiresAt).toLocaleTimeString()}</time>.</p>
        <p role="status" className="text-caption text-muted-foreground">Waiting for the extension…</p>
      </> : null}
      {shown === 'confirm' ? fingerprint ? <>
        <p className="text-body text-muted-foreground">The extension popup shows a fingerprint. Confirm only if every character matches this one; otherwise another browser took the code.</p>
        <code className="block break-all rounded-lg bg-surface-3 p-3 font-mono text-caption">SHA-256 {fingerprint}</code>
      </> : <p role="status" className="text-body text-muted-foreground">{identity?.state === 'confirmed' ? 'This Chrome is already confirmed.' : 'Waiting for the extension to report its key…'}</p> : null}
      {shown === 'name' ? <>
        <InputGroup className="w-full"><InputField index={0} label="Chrome name" value={name} onChange={setName} placeholder="For example, Work Chrome" disabled={pending !== null} /></InputGroup>
        <section className="flex flex-col gap-1" aria-label="Approve for projects">
          <p className="text-body text-muted-foreground">Approve it where agents may use it. A project with no default Chrome makes this one its default.</p>
          {projects.map(project => <Switch key={project.id} label={project.name} checked={selected.includes(project.id)} disabled={pending !== null || !browsers.settings[project.id]} onToggle={() => setSelected(current => current.includes(project.id) ? current.filter(item => item !== project.id) : [...current, project.id])} />)}
        </section>
      </> : null}
      {error ?? pollError ? <p role="alert" className="text-caption text-destructive">{error ?? pollError}</p> : null}
    </div>
    <DialogFooter>
      {shown === 'confirm' && fingerprint ? <Button variant="ghost" disabled={pending !== null} onClick={() => void run('forget', async () => { if (pairingId) await browsers.forget(pairingId); onClose(); })}>It doesn&apos;t match</Button> : <Button variant="secondary" disabled={pending !== null} onClick={onClose}>{shown === 'name' ? 'Skip' : 'Cancel'}</Button>}
      {shown === 'download' ? <Button variant="primary" disabled={pending !== null} loading={pending === 'pair'} onClick={() => void run('pair', async () => { const value = await browsers.pair(); setPairing(value); setPairingId(value.pairingId); setStep('pair'); })}>Next</Button> : null}
      {shown === 'confirm' && fingerprint ? <Button variant="primary" disabled={pending !== null} loading={pending === 'confirm'} onClick={() => void run('confirm', async () => { if (!pairingId) return; await browsers.confirm(pairingId, fingerprint); setName(identity?.name ?? ''); setStep('name'); })}>It matches</Button> : null}
      {shown === 'name' ? <Button variant="primary" disabled={pending !== null} loading={pending === 'finish'} onClick={finish}>Finish</Button> : null}
    </DialogFooter>
  </DialogContent></Dialog>;
}
