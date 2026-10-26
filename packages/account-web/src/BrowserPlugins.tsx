import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BROWSER_POWER_LABELS, BROWSER_POWERS, type RuntimeAccountBrowserPairingCode, type RuntimeAccountBrowserRelayStatus, type RuntimeProjectBrowserPreferences, type RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import { Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, Switch } from '@gitspace/ui';
import { Cloud01, Monitor01, Plus, Trash01 } from '@untitledui/icons';
import { accountBrowserStatus, confirmAccountBrowser, downloadAccountBrowserExtension, pairAccountBrowser, projectBrowserSettings, unpairAccountBrowser, updateAccountBrowser, updateProjectBrowserSettings } from './browser-relay-client.js';
import { approveChrome, projectApprovals, withPower } from './browser-approvals.js';
import { EmptyState, StatusDot } from './GitSpaceShell.js';
import { glyph } from './glyph.js';
import { formatClock } from './capture/CapturePlayer.js';
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
  pair(): Promise<RuntimeAccountBrowserPairingCode>;
  confirm(pairingId: string, fingerprint: string): Promise<void>;
  /** Names a Chrome or sets its note for agents. */
  updateChrome(pairingId: string, change: { name?: string; note?: string }): Promise<void>;
  forget(pairingId: string): Promise<void>;
  updateProject(projectId: string, expectedRevision: number, preferences: RuntimeProjectBrowserPreferences): Promise<void>;
}

/** What the pairing dialog was opened for: a new Chrome (with a project to approve it in), or resuming one pairing. */
export interface PairChromeRequest { projectId: string | null; pairingId?: string }

const ChromeGlyph = glyph(Monitor01);
const CloudGlyph = glyph(Cloud01);
const PlusGlyph = glyph(Plus);
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
    updateChrome: async (pairingId, change) => { setRelay(await updateAccountBrowser(pairingId, change)); },
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

/** How long ago, coarsely: `just now`, `5 min ago`, `2 h ago` or `3 d ago`. */
function ago(at: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / (24 * 60))} d ago`;
}

/** A day as Plugins shows it: `Oct 23`. */
function day(at: string): string { return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' }); }

/** A Chrome as its card describes it: `Chrome 141 · Windows · extension 5.8.0`, from what it last said. */
function describeChrome(pairing: ConfirmedPairing): string {
  return [pairing.chromeVersion ? `Chrome ${pairing.chromeVersion}` : 'Chrome', pairing.platform, pairing.extension ? `extension ${pairing.extension.version ?? 'from before versions were reported'}` : null].filter(part => part !== null).join(' · ');
}

/** Plugins → Browsers: your paired Chromes, pairing in progress, and the built-in cloud browser. `manage` opens that
 * Chrome's Manage Chrome. */
export function BrowserPlugins({ projects, browsers, query, onPair, manage = null }: { projects: readonly Project[]; browsers: BrowserPluginsState; query: string; onPair(request: PairChromeRequest): void; manage?: string | null }) {
  const [managing, setManaging] = useState<string | null>(manage);
  const action = useSerialAction('Forget Chrome');
  const pairings = browsers.relay?.pairings ?? [];
  const normalized = query.trim().toLowerCase();
  const now = Date.now();
  const confirmed = pairings.filter((pairing): pairing is ConfirmedPairing => pairing.state === 'confirmed');
  const visible = confirmed.filter(pairing => `${pairing.name} ${describeChrome(pairing)}`.toLowerCase().includes(normalized));
  const inProgress = pairings.filter(pairing => pairing.state !== 'confirmed');
  const managed = confirmed.find(pairing => pairing.pairingId === managing) ?? null;
  const forget = (pairing: ConfirmedPairing) => {
    if (window.confirm(`Forget ${pairing.name}? Agents stop using it in every project, and using it again means pairing it again.`)) void action.run(pairing.pairingId, () => browsers.forget(pairing.pairingId));
  };
  return <div className="flex flex-col gap-8">
    <section className="flex flex-col gap-3" aria-labelledby="your-chromes">
      <div><h2 id="your-chromes" className="text-subtitle font-medium text-foreground">Your Chromes</h2><p className="text-body text-muted-foreground">Chromes running the GitSpace extension. Pairing lets your account reach a Chrome; agents in a project use it only once you approve it for that project.</p></div>
      {browsers.error ? <p role="alert" className="text-caption text-destructive">{browsers.error}<Button variant="ghost" size="compact" onClick={() => void browsers.refresh()}>Retry</Button></p> : null}
      {browsers.relay === null && browsers.loading ? <EmptyState title="Loading your Chromes…" />
        : visible.length ? <CardGroup orientation="inline" border="outlined" separated>{visible.map(pairing => {
          const approved = projects.filter(project => browsers.settings[project.id]?.browsers.some(browser => browser.pairingId === pairing.pairingId && browser.approved));
          const defaults = projects.filter(project => browsers.settings[project.id]?.defaultPairingId === pairing.pairingId);
          const usage = [`Approved in ${approved.length} ${approved.length === 1 ? 'project' : 'projects'}`, defaults.length ? `default in ${defaults.map(project => project.name).join(', ')}` : null,
            pairing.agentsUsing ? `${pairing.agentsUsing} ${pairing.agentsUsing === 1 ? 'agent' : 'agents'} using it now` : null].filter(part => part !== null).join(' · ');
          return <Card size="compact" key={pairing.pairingId}>
            <CardMedia icon={ChromeGlyph} />
            <CardHeader>
              <CardTitle>{pairing.name}</CardTitle>
              <CardDescription>{describeChrome(pairing)}</CardDescription>
              {approved.length ? <span className="text-caption tabular-nums text-muted-foreground">{usage}</span>
                : <span className="text-caption text-[#b45309]">Paired, but not approved for any project, so no agent can use it.</span>}
            </CardHeader>
            <CardFooter className="gap-2">
              {pairing.extension?.updateRequired ? <Badge color="red">Update the extension</Badge> : <Badge color={pairing.connected ? 'green' : 'gray'}>{pairing.connected ? 'Online' : pairing.seenAt ? `Offline · seen ${ago(pairing.seenAt, now)}` : 'Offline'}</Badge>}
              {approved.length ? <Button variant="ghost" onClick={() => setManaging(pairing.pairingId)}>Manage Chrome</Button> : <Button variant="secondary" onClick={() => setManaging(pairing.pairingId)}>Approve for projects</Button>}
              <Button variant="tertiary" size="icon-compact" aria-label={`Forget ${pairing.name}`} disabled={action.pending !== null} loading={action.pending === pairing.pairingId} onClick={() => forget(pairing)}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button>
            </CardFooter>
          </Card>;
        })}</CardGroup>
        : <EmptyState icon={<Monitor01 width={22} height={22} strokeWidth={1.5} />} title={confirmed.length ? 'No matching Chromes' : 'No Chrome paired yet'} description={confirmed.length ? 'Change the filter to see your Chromes.' : 'Pair your Chrome to let agents use your signed-in sites, in a tab group of their own.'} action={confirmed.length ? undefined : <Button variant="primary" leadingIcon={PlusGlyph} onClick={() => onPair({ projectId: null })}>Pair a Chrome</Button>} />}
      {inProgress.length ? <CardGroup orientation="inline" border="outlined" separated aria-label="Pairing in progress">{inProgress.map(pairing => <Card size="compact" key={pairing.pairingId}>
        <CardMedia icon={ChromeGlyph} />
        {/* An unconfirmed pairing shows nothing the extension reported: its label could claim anything. */}
        <CardHeader><CardTitle>Unconfirmed Chrome</CardTitle><CardDescription>{pairing.state === 'awaiting-key' ? `Waiting for the extension · code expires ${new Date(pairing.expiresAt).toLocaleTimeString()}` : 'Fingerprint ready to compare'}</CardDescription></CardHeader>
        <CardFooter className="gap-2">
          <Badge color="amber">Pairing</Badge>
          <Button variant="secondary" disabled={action.pending !== null} onClick={() => onPair({ projectId: null, pairingId: pairing.pairingId })}>Resume</Button>
          <Button variant="tertiary" size="icon-compact" aria-label="Forget this unconfirmed Chrome" disabled={action.pending !== null} loading={action.pending === pairing.pairingId} onClick={() => void action.run(pairing.pairingId, () => browsers.forget(pairing.pairingId))}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button>
        </CardFooter>
      </Card>)}</CardGroup> : null}
      {action.error ? <p role="alert" className="text-caption text-destructive">{action.error}</p> : null}
    </section>
    <section className="flex flex-col gap-3" aria-labelledby="cloud-browser">
      <div><h2 id="cloud-browser" className="text-subtitle font-medium text-foreground">Cloud browser</h2><p className="text-body text-muted-foreground">Headless Chromium with one profile per workspace. Always available, and not limited to a project&apos;s approved sites.</p></div>
      <CardGroup orientation="inline" border="outlined" separated><Card size="compact">
        <CardMedia icon={CloudGlyph} />
        <CardHeader><CardTitle>Cloud browser</CardTitle><CardDescription>Built in · every project</CardDescription>{browsers.relay ? <span className="text-caption tabular-nums text-muted-foreground">{browsers.relay.cloudWorkspaces === 0 ? 'No workspace has open tabs' : `${browsers.relay.cloudWorkspaces} ${browsers.relay.cloudWorkspaces === 1 ? 'workspace has' : 'workspaces have'} open tabs`}</span> : null}</CardHeader>
        <CardFooter><Badge color="blue">Built in</Badge></CardFooter>
      </Card></CardGroup>
    </section>
    {managed ? <ManageChromeDialog key={managed.pairingId} pairing={managed} projects={projects} browsers={browsers} onClose={() => setManaging(null)} /> : null}
  </div>;
}

function ManageChromeDialog({ pairing, projects, browsers, onClose }: { pairing: ConfirmedPairing; projects: readonly Project[]; browsers: BrowserPluginsState; onClose(): void }) {
  const [name, setName] = useState(pairing.name);
  const [note, setNote] = useState(pairing.note);
  const { pending, error, run } = useSerialAction('Manage Chrome');
  const id = pairing.pairingId;
  const update = (projectId: string, key: string, preferences: (settings: RuntimeProjectBrowserSettings) => RuntimeProjectBrowserPreferences) => {
    const settings = browsers.settings[projectId];
    if (settings) void run(key, () => browsers.updateProject(projectId, settings.revision, preferences(settings)));
  };
  // The name and note save together when you are done; an emptied name keeps the one it had.
  const save = async () => {
    const nextName = name.trim(), nextNote = note.trim();
    const change = { ...(nextName && nextName !== pairing.name ? { name: nextName } : {}), ...(nextNote !== pairing.note ? { note: nextNote } : {}) };
    if (change.name !== undefined || change.note !== undefined) await browsers.updateChrome(id, change);
  };
  const seen = pairing.connected ? 'online now' : pairing.seenAt ? `seen ${ago(pairing.seenAt, Date.now())}` : 'offline';
  // Every project reports the same extension for this Chrome; powers are stored either way and enforced from 5.11.
  const powersSupported = projects.some(project => browsers.settings[project.id]?.browsers.some(browser => browser.pairingId === id && browser.powersSupported));
  return <Dialog open onOpenChange={open => { if (!open && pending === null) onClose(); }}><DialogContent size="lg">
    <DialogHeader><DialogTitle>{pairing.name}</DialogTitle><DialogDescription>{pairing.pairedAt ? `Paired ${day(pairing.pairedAt)} · fingerprint ` : 'Fingerprint '}<span className="font-mono" title={`SHA-256 ${pairing.pairedKeyFingerprint}`}>{shortFingerprint(pairing.pairedKeyFingerprint)}</span> · {seen}</DialogDescription></DialogHeader>
    <div className="flex max-h-[60dvh] flex-col gap-5 overflow-y-auto">
      <InputGroup><InputField index={0} label="Name" value={name} onChange={setName} disabled={pending !== null} /><InputField index={1} label="Note for agents" value={note} onChange={setNote} placeholder="The account it is signed in to, say" disabled={pending !== null} /></InputGroup>
      {pairing.extension?.updateRequired ? <p className="text-caption text-destructive">This GitSpace release refuses the extension as too old. Download it again and reload it in chrome://extensions.</p>
        : pairing.connected && !powersSupported ? <p className="text-caption text-[#b45309]">Update the extension in this Chrome to 5.11 for powers to work: the ones you turn on are kept, but this version cannot enforce them. Download it again and reload it in chrome://extensions.</p> : null}
      <section className="flex flex-col gap-2" aria-label="Projects">
        <div><h3 className="text-body font-medium text-foreground">Projects</h3><p className="text-caption text-muted-foreground">Approving is your personal permission, not a repository setting. Each workspace gets its own tab group; the project&apos;s approved sites still apply. The default answers requests that don&apos;t name a Chrome. Powers give agents in that project more on this Chrome.</p></div>
        {projects.length === 0 ? <p className="text-caption text-muted-foreground">Create a project first.</p> : <div className="flex flex-col divide-y divide-border rounded-xl border border-border">{projects.map(project => {
          const settings = browsers.settings[project.id];
          const browser = settings?.browsers.find(item => item.pairingId === id);
          const approved = browser?.approved ?? false;
          const powers = browser?.powers ?? [];
          const isDefault = settings?.defaultPairingId === id;
          return <div key={project.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 break-words text-body">{project.name}</span>
            {approved ? isDefault ? <Badge color="gray">Project default</Badge> : <Button variant="ghost" size="compact" disabled={pending !== null} onClick={() => update(project.id, `default:${project.id}`, current => ({ defaultPairingId: id, approvals: projectApprovals(current) }))}>Make default</Button> : null}
            <Switch aria-label={`Approved in ${project.name}`} label={approved ? 'Approved' : 'Not approved'} checked={approved} disabled={pending !== null || !settings} onToggle={() => update(project.id, `approve:${project.id}`, current => approved
              ? { defaultPairingId: current.defaultPairingId === id ? null : current.defaultPairingId, approvals: projectApprovals(current).filter(item => item.pairingId !== id) }
              : approveChrome(current, id))} />
            {approved ? <div role="group" aria-label={`Powers in ${project.name}`} className="flex w-full flex-col border-l-2 border-border pl-2">
              {BROWSER_POWERS.map(power => <Switch key={power} size="compact" aria-label={`${BROWSER_POWER_LABELS[power]} in ${project.name}`} label={BROWSER_POWER_LABELS[power]} checked={powers.includes(power)} disabled={pending !== null}
                onToggle={() => update(project.id, `power:${project.id}`, current => withPower(current, id, power, !powers.includes(power)))} />)}
            </div> : null}
          </div>;
        })}</div>}
      </section>
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    </div>
    <DialogFooter>
      <Button variant="tertiary" disabled={pending !== null} loading={pending === 'forget'} onClick={() => void run('forget', async () => { await browsers.forget(id); onClose(); })}>Forget this Chrome</Button>
      <Button variant="secondary" disabled={pending !== null} loading={pending === 'done'} onClick={() => void run('done', async () => { await save(); onClose(); })}>Done</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}

/** The first 16 hex digits of a key's SHA-256, upper case in groups of four, as the extension's popup shows them. */
function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16).toUpperCase().replace(/(.{4})(?!$)/gu, '$1 ');
}

/** One numbered step of the pairing dialog; its circle turns into a green check once done. */
function PairStep({ number, title, done, children }: { number: number; title: string; done: boolean; children: ReactNode }) {
  return <li className="flex gap-3" aria-label={`Step ${number}: ${title}${done ? ', done' : ''}`}>
    <span aria-hidden className={`flex size-6 shrink-0 items-center justify-center rounded-full text-caption font-semibold ${done ? 'bg-[#22c55e] text-white' : 'bg-surface-3'}`}>{done ? '✓' : number}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-2 pb-2"><h3 className="text-body font-medium">{title}</h3>{children}</div>
  </li>;
}

/** A short pairing code as the dialog shows it: `K7P-2QX`. */
function pairingCode(code: string): string { return `${code.slice(0, 3)}-${code.slice(3)}`; }

/** Pair a Chrome in one dialog, every step in view: download the extension, type the short pairing code into its popup,
 * compare the fingerprint the extension reports, then name the Chrome and approve it for projects. */
export function PairChromeDialog({ request, projects, browsers, onClose }: { request: PairChromeRequest; projects: readonly Project[]; browsers: BrowserPluginsState; onClose(): void }) {
  const [pairing, setPairing] = useState<RuntimeAccountBrowserPairingCode | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(request.pairingId ?? null);
  const [confirmedHere, setConfirmedHere] = useState(false);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<readonly string[]>(request.projectId ? [request.projectId] : []);
  const [pollError, setPollError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const { pending, error, run } = useSerialAction('Pair a Chrome');
  const identity = browsers.relay?.pairings.find(item => item.pairingId === pairingId) ?? null;
  // The extension reports its key on its own; step 3 shows it when it does.
  const answered = identity && identity.state !== 'awaiting-key' ? identity.pairedKeyFingerprint : null;
  const confirmed = confirmedHere || identity?.state === 'confirmed';
  // A code tried wrongly too often is withdrawn with its pairing.
  const withdrawn = pairing !== null && browsers.relay !== null && identity === null;
  const waiting = pairingId !== null && answered === null && !withdrawn;
  const poll = useRef(browsers.pollStatus);
  poll.current = browsers.pollStatus;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void poll.current().then(() => setPollError(null), cause => setPollError(rpcErrorMessage(cause, 'Read pairing status'))); }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  // The pairing code's countdown.
  useEffect(() => {
    if (!pairing || answered !== null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing, answered]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const createCode = () => void run('pair', async () => {
    // A new code replaces an expired one: its pairing is forgotten first.
    if (pairingId) await browsers.forget(pairingId);
    const value = await browsers.pair();
    setNow(Date.now()); setPairing(value); setPairingId(value.pairingId); setCopied(false);
  });
  const copy = (code: string) => void run('copy', async () => { await navigator.clipboard.writeText(code); setCopied(true); });
  const finish = () => void run('finish', async () => {
    if (!pairingId) return;
    const next = name.trim();
    if (next && next !== identity?.name) await browsers.updateChrome(pairingId, { name: next });
    for (const projectId of selected) {
      const settings = browsers.settings[projectId];
      if (settings && !settings.browsers.some(browser => browser.pairingId === pairingId && browser.approved)) await browsers.updateProject(projectId, settings.revision, approveChrome(settings, pairingId));
    }
    onClose();
  });
  const left = pairing ? Date.parse(pairing.expiresAt) - now : 0;
  const live = pairing !== null && answered === null && !withdrawn && left > 0;
  return <Dialog open onOpenChange={open => { if (!open && pending === null) onClose(); }}><DialogContent size="lg">
    <DialogHeader><DialogTitle>Pair a Chrome</DialogTitle><DialogDescription>One pass from install to an agent-ready Chrome. Nothing is usable until you confirm the fingerprint.</DialogDescription></DialogHeader>
    <ol className="flex max-h-[60dvh] flex-col gap-2 overflow-y-auto">
      <PairStep number={1} title="Install the GitSpace extension" done={pairingId !== null}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === 'download'} onClick={() => void run('download', browsers.downloadExtension)}>Download extension</Button>
          <p className="text-caption text-muted-foreground">Unzip it, then chrome://extensions → Developer mode → Load unpacked.</p>
        </div>
      </PairStep>
      <PairStep number={2} title="Type this code into the extension's popup" done={answered !== null}>
        {pairing ? <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <span aria-label="Pairing code" className={`font-mono text-title font-semibold tracking-[0.2em] ${live || answered !== null ? 'text-foreground' : 'text-muted-foreground line-through'}`}>{pairingCode(pairing.code)}</span>
            <span className="text-caption tabular-nums text-muted-foreground">{answered !== null ? 'used' : withdrawn ? 'no longer works: it was tried wrongly too often' : left > 0 ? `expires in ${formatClock(left)}` : 'expired'}</span>
            {live ? <Button variant="secondary" size="compact" disabled={pending !== null} onClick={() => copy(pairingCode(pairing.code))}>{copied ? 'Copied' : 'Copy'}</Button> : null}
          </div>
          <p className="text-caption text-muted-foreground">In Chrome, open the GitSpace extension, then Identity &amp; pairing. The code works once.</p>
          {answered === null && !live ? <div><Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === 'pair'} onClick={createCode}>Get a new code</Button></div> : null}
        </div>
          : identity?.state === 'awaiting-key' ? Date.parse(identity.expiresAt) > now
            ? <p className="text-caption text-muted-foreground">Type the code shown when this pairing started; it works until <time dateTime={identity.expiresAt}>{new Date(identity.expiresAt).toLocaleTimeString()}</time>.</p>
            : <div className="flex flex-wrap items-center gap-2"><p className="text-caption text-muted-foreground">The code of this pairing expired.</p><Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === 'pair'} onClick={createCode}>Get a new code</Button></div>
          : pairingId === null ? <div><Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === 'pair'} onClick={createCode}>Get pairing code</Button></div> : null}
      </PairStep>
      <PairStep number={3} title="Check it's your Chrome" done={confirmed}>
        {answered !== null ? <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-3 px-3 py-2">
          <span className="text-body">A Chrome answered. Its popup should show <span className="font-mono font-semibold" title={`SHA-256 ${answered}`}>{shortFingerprint(answered)}</span></span>
          {confirmed ? <Button variant="secondary" size="compact" disabled>Confirmed</Button> : <>
            <Button variant="primary" size="compact" disabled={pending !== null} loading={pending === 'confirm'} onClick={() => void run('confirm', async () => { if (!pairingId) return; await browsers.confirm(pairingId, answered); setName(identity?.name ?? ''); setConfirmedHere(true); })}>It matches</Button>
            <Button variant="ghost" size="compact" disabled={pending !== null} loading={pending === 'forget'} onClick={() => void run('forget', async () => { if (pairingId) await browsers.forget(pairingId); onClose(); })}>It doesn&apos;t match</Button>
          </>}
        </div>
          : waiting ? <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><StatusDot color="blue" pulse />Waiting for a Chrome to answer…</p>
          : <p className="text-caption text-muted-foreground">The Chrome you type the code into answers here.</p>}
      </PairStep>
      <PairStep number={4} title="Use it in projects" done={false}>
        <InputGroup><InputField index={0} label="Name this Chrome" value={name} onChange={setName} placeholder="For example, Work Chrome" disabled={pending !== null || !confirmed} /></InputGroup>
        {projects.length ? <div className="flex flex-col divide-y divide-border rounded-xl border border-border" aria-label="Approve for projects">{projects.map(project => {
          const settings = browsers.settings[project.id];
          const chosen = selected.includes(project.id);
          return <div key={project.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 break-words text-body">{project.name}</span>
            {chosen && settings?.defaultPairingId === null ? <p className="text-caption text-muted-foreground">No default yet · this becomes it</p> : null}
            <Switch aria-label={`Approve for ${project.name}`} label={chosen ? 'Approved' : 'Not approved'} checked={chosen} disabled={pending !== null || !confirmed || !settings} onToggle={() => setSelected(current => current.includes(project.id) ? current.filter(item => item !== project.id) : [...current, project.id])} />
          </div>;
        })}</div> : <p className="text-caption text-muted-foreground">Create a project first.</p>}
        {request.projectId ? <p className="text-caption text-muted-foreground">Opened from a workspace, its project is ticked already.</p> : null}
      </PairStep>
    </ol>
    {error ?? pollError ? <p role="alert" className="text-caption text-destructive">{error ?? pollError}</p> : null}
    <DialogFooter>
      <Button variant="secondary" disabled={pending !== null} onClick={onClose}>{confirmed ? 'Skip' : 'Cancel'}</Button>
      <Button variant="primary" disabled={pending !== null || !confirmed} loading={pending === 'finish'} onClick={finish}>Finish</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}
