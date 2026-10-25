import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { RuntimeIdentitySchema, type RuntimeBrowserCaptureView, type RuntimeBrowserOverview, type RuntimeBrowserPageCommentView, type RuntimeBrowserPreview, type RuntimeBrowserShare, type RuntimeBrowserStatus, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useShape } from '@gitspace/ui';
import { Cloud01, Eye, Monitor01, Plus, Server01, StopCircle, VideoRecorder } from '@untitledui/icons';
import { approveChrome } from './browser-approvals.js';
import { projectBrowserSettings, updateProjectBrowserSettings } from './browser-relay-client.js';
import { glyph } from './glyph.js';
import { BrowserCaptures, Elapsed } from './RuntimeBrowserCaptures.js';
import { BrowserPageComments, BrowserShares, ShareTab, type BrowserShareOptions } from './RuntimeBrowserShares.js';
import { useLiveChanges } from './live-notices.js';
import { browserPluginsUrl, navigateProductUrl } from './routes.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Tab = RuntimeBrowserOverview['cloud']['tabs'][number];
type Chrome = RuntimeBrowserOverview['chromes'][number];
type Request = (command: RuntimeSessionCommand, signal?: AbortSignal) => Promise<RuntimeSessionResult>;
type Records = { machineId: string | null; records: RuntimeBrowserStatus['records']; error: string | null };
/** Recording from tab tiles: the captures now recording (matched to tiles by their target) and the commands. */
type CaptureControls = { recordings: readonly RuntimeBrowserCaptureView[]; start(groupId: string, targetId: string): void; stop(captureId: string): void };
/** Sharing a tab of a Chrome group from its tile; `onCreated` receives the share made. */
type ShareCreate = (groupId: string, targetId: string, options: BrowserShareOptions, onCreated: (share: RuntimeBrowserShare) => void) => void;

/** The workspace's browsers (`browserOverview`), read when the Inspector opens and again by the Browser tab while it
 * shows; the Browser tab's label and Environment's Browser line count from it. */
export interface WorkspaceBrowsers {
  /** Runs a command of the workspace's session. */
  request: Request;
  overview: RuntimeBrowserOverview | null;
  error: string | null;
  read(signal?: AbortSignal): Promise<void>;
}
/** Browsers with open tabs in this workspace, and how many of them run scripts now. */
export interface BrowserActivity { open: number; running: number }

/** How often the overview, the captures and each visible tab's preview are read while the tab is shown. */
export const BROWSER_REFRESH_MS = 10_000;
/** How often the Watch dialog reads its tab's preview. */
export const WATCH_REFRESH_MS = 3_000;
/** On your Chrome, Capture here records screencast frames; video with sound needs your click in Chrome itself. */
const CHROME_CAPTURE_HINT = 'Capture here records the tab without sound. For video with sound, click Capture on the tab in Chrome (the GitSpace toolbar on the page or the extension’s popup).';
const TAB_ORIGIN: Record<NonNullable<Tab['addedBy']>, string> = { agent: 'Opened by agent', you: 'You added it', page: 'Opened by a page' };
/** What the composer gets from Ask agent to add a site; the user names the site and sends it. */
const ADD_SITE_REQUEST = 'Please add this site to browser.origins in .gitspace/bundle.json and commit it, so I can approve it in Environment: ';
const PlusGlyph = glyph(Plus);

/** Runs `tick` every `ms` while the page is visible, the way the Browser tab and its previews refresh. */
function useVisibleInterval(tick: () => void, ms: number) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') latest.current(); }, ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** Reads the workspace's browsers once when mounted; the Browser tab reads them again while it shows. */
export function useWorkspaceBrowsers(snapshot: RuntimeSnapshot, conversationId: string | undefined): WorkspaceBrowsers {
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  const [overview, setOverview] = useState<RuntimeBrowserOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback<Request>(async (command, signal) => {
    const response = await rpcClient.runtime.session({ ...identity, ...(conversationId ? { conversationId } : {}), command }, { signal });
    if (response.status === 'error') throw response.error;
    return response.value;
  }, [identity, conversationId]);
  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request({ type: 'browserOverview' }, signal);
      if (!result.browserOverview) throw new Error('The workspace did not return its browsers.');
      if (!signal?.aborted) { setOverview(result.browserOverview); setError(null); }
    } catch (cause) { if (!signal?.aborted) setError(rpcErrorMessage(cause, 'Read workspace browsers')); }
  }, [request]);
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);
  return { request, overview, error, read };
}

/** The approved Chromes, the cloud browser and the machines' headless browsers that have tabs open, and those running scripts. */
export function browserActivity(overview: RuntimeBrowserOverview): BrowserActivity {
  const browsers = [...overview.chromes.filter(chrome => chrome.approved), overview.cloud, ...overview.machines.map(machine => ({ ...machine, running: 0 }))].filter(browser => browser.tabs.length > 0);
  return { open: browsers.length, running: browsers.filter(browser => browser.running > 0).length };
}

/** `3 s ago`, `4 min ago` or `2 h ago`. */
function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

/** The Inspector's Browser tab: the approved sites; this workspace's browsers (each Chrome this project approved, with its
 * tab group, the cloud browser and each attached machine's headless browser) with their tabs and previews; captures;
 * shares; page comments; and recovery records when there are any. `onCompose` adds text to the chat composer's draft. */
export function RuntimeBrowserTab({ snapshot, projectName, browsers, machines, onOpenEnvironment, onCompose }: { snapshot: RuntimeSnapshot; projectName: string; browsers: WorkspaceBrowsers; machines: readonly { id: string; label: string }[]; onOpenEnvironment(): void; onCompose?: (text: string) => void }) {
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  const { request, overview, read: readOverview } = browsers;
  // Keyed by content so a new snapshot with the same machines does not reread the records.
  const machineKey = [...new Set(snapshot.attachments.filter(attachment => attachment.state === 'ready' && attachment.capabilities.includes('browser.headless')).map(attachment => attachment.machineId))].sort().join('\n');
  const [records, setRecords] = useState<readonly Records[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captures, setCaptures] = useState<readonly RuntimeBrowserCaptureView[] | null>(null);
  const [capturesError, setCapturesError] = useState<string | null>(null);
  const [shares, setShares] = useState<readonly RuntimeBrowserShare[] | null>(null);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [comments, setComments] = useState<readonly RuntimeBrowserPageCommentView[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const busy = useRef(false);
  // Bumped by each start and stop, so a list read that began before one does not overwrite what it returned.
  const captureChanges = useRef(0);
  // The same for each share made or stopped.
  const shareChanges = useRef(0);
  // The overview the Inspector read when it opened may be old by the time this tab shows; a read still running is not repeated.
  const overviewRead = useRef(browsers.overview !== null || browsers.error !== null);
  const readRecords = useCallback(async (signal?: AbortSignal) => {
    const ids: Array<string | null> = [null, ...(machineKey ? machineKey.split('\n') : [])];
    const values = await Promise.all(ids.map(async (machineId): Promise<Records> => {
      try {
        const result = await request({ type: 'browserStatus', ...(machineId === null ? {} : { machineId }) }, signal);
        return { machineId, records: result.browserStatus?.records ?? [], error: null };
      } catch (cause) { return { machineId, records: [], error: rpcErrorMessage(cause, 'Read browser recovery records') }; }
    }));
    if (!signal?.aborted) setRecords(values);
  }, [machineKey, request]);
  const readCaptures = useCallback(async (signal?: AbortSignal) => {
    const changes = captureChanges.current;
    try {
      const result = await request({ type: 'browserCaptures' }, signal);
      if (!result.browserCaptures) throw new Error('The workspace did not return its captures.');
      if (!signal?.aborted && changes === captureChanges.current) { setCaptures(result.browserCaptures); setCapturesError(null); }
    } catch (cause) { if (!signal?.aborted) setCapturesError(rpcErrorMessage(cause, 'Read browser captures')); }
  }, [request]);
  const readShares = useCallback(async (signal?: AbortSignal) => {
    const changes = shareChanges.current;
    try {
      const result = await request({ type: 'browserShares' }, signal);
      if (!result.browserShares) throw new Error('The workspace did not return its shares.');
      if (!signal?.aborted && changes === shareChanges.current) { setShares(result.browserShares); setSharesError(null); }
    } catch (cause) { if (!signal?.aborted) setSharesError(rpcErrorMessage(cause, 'Read browser shares')); }
  }, [request]);
  const readComments = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request({ type: 'browserPageComments' }, signal);
      if (!result.browserPageComments) throw new Error('The workspace did not return its page comments.');
      if (!signal?.aborted) { setComments(result.browserPageComments); setCommentsError(null); }
    } catch (cause) { if (!signal?.aborted) setCommentsError(rpcErrorMessage(cause, 'Read page comments')); }
  }, [request]);
  useEffect(() => {
    setRecords([]); setCaptures(null); setShares(null); setComments(null);
    const controller = new AbortController();
    if (overviewRead.current) void readOverview(controller.signal);
    overviewRead.current = true;
    void readRecords(controller.signal); void readCaptures(controller.signal); void readShares(controller.signal); void readComments(controller.signal);
    return () => controller.abort();
  }, [readOverview, readRecords, readCaptures, readShares, readComments]);
  useVisibleInterval(() => { void readOverview(); void readCaptures(); void readShares(); }, BROWSER_REFRESH_MS);
  // A comment made on a share of this workspace's tabs is announced; the list is read again.
  const commentNotices = useLiveChanges(workspaceLiveKey(identity.workspaceId, 'page-comments', identity.projectId));
  useEffect(() => { if (commentNotices !== null) void readComments(); }, [commentNotices, readComments]);
  const act = async (key: string, operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(key); setError(null);
    try { await operation(); } catch (cause) { setError(rpcErrorMessage(cause, 'Manage workspace browsers')); } finally { busy.current = false; setPending(null); }
  };
  const approve = (chrome: Chrome) => act(`approve:${chrome.pairingId}`, async () => {
    const settings = await projectBrowserSettings(identity.projectId);
    await updateProjectBrowserSettings(identity.projectId, settings.revision, approveChrome(settings, chrome.pairingId));
    await readOverview();
  });
  /** `machineId` names the attached machine whose headless browser holds the group; omitted for the cloud browser and Chromes. */
  const revoke = (groupId: string, machineId?: string) => {
    if (window.confirm('Revoke access? This ends this workspace’s tab group on that browser and stops its agents using it; the next use starts a new group.')) void act(`revoke:${groupId}`, async () => { await request({ type: 'browserRevoke', ...(machineId === undefined ? {} : { machineId }), groupId }); await readOverview(); });
  };
  /** Shows the capture a start or stop returned in place of its listed state. */
  const keepCapture = (view: RuntimeBrowserCaptureView | undefined) => {
    if (!view) throw new Error('The workspace did not return the capture.');
    captureChanges.current += 1;
    setCaptures(previous => [view, ...(previous ?? []).filter(other => other.capture.captureId !== view.capture.captureId)]);
  };
  /** Shows the share a create or stop returned in place of its listed state. */
  const keepShare = (share: RuntimeBrowserShare | undefined): RuntimeBrowserShare => {
    if (!share) throw new Error('The workspace did not return the share.');
    shareChanges.current += 1;
    setShares(previous => previous?.some(other => other.shareId === share.shareId) ? previous.map(other => other.shareId === share.shareId ? share : other) : [share, ...(previous ?? [])]);
    return share;
  };
  const shareTab: ShareCreate = (groupId, targetId, options, onCreated) => void act(`share:${groupId}:${targetId}`, async () => onCreated(keepShare((await request({ type: 'browserShareCreate', groupId, targetId, ...options })).browserShare)));
  const stopShare = (shareId: string) => void act(`unshare:${shareId}`, async () => { keepShare((await request({ type: 'browserShareRevoke', shareId })).browserShare); });
  const captureControls: CaptureControls = {
    recordings: captures?.filter(view => view.capture.state === 'recording' && view.capture.target !== null) ?? [],
    start: (groupId, targetId) => void act(`capture:${groupId}:${targetId}`, async () => keepCapture((await request({ type: 'browserCaptureStart', groupId, targetId })).browserCapture)),
    stop: captureId => void act(`stop:${captureId}`, async () => keepCapture((await request({ type: 'browserCaptureStop', captureId })).browserCapture)),
  };
  const machineLabel = (machineId: string) => machines.find(machine => machine.id === machineId)?.label ?? machineId;
  const recovery = records.filter(row => row.records.length > 0 || row.error !== null);
  const approved = overview?.chromes.filter(chrome => chrome.approved) ?? [];
  const tiles = { request, pending, captures: captureControls };
  return <section aria-label="Workspace browsers" className="flex flex-col gap-4 px-4 pb-8 pt-2">
    {browsers.error ? <p role="alert" className="text-caption text-destructive">{browsers.error}{overview ? ' Showing the last state read.' : ''}</p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {overview === null && !browsers.error ? <p role="status" className="text-caption text-muted-foreground">Loading browsers…</p> : null}
    {overview ? <>
      <section aria-label="Approved sites" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2"><h3 className="text-body font-medium">Approved sites</h3>{onCompose ? <Button variant="ghost" size="compact" onClick={() => onCompose(ADD_SITE_REQUEST)}>Ask agent to add a site</Button> : null}</div>
        {overview.sites.origins.length ? <ul className="flex flex-wrap gap-1.5">{overview.sites.origins.map(origin => <li key={origin} className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 py-0.5 font-mono text-caption">{origin}<span className="font-sans text-muted-foreground">· {overview.sites.stepsOnly.includes(origin) ? 'single steps' : 'scripts'}</span></li>)}</ul> : null}
        <p className="text-caption text-muted-foreground">{overview.sites.origins.length ? 'From .gitspace/bundle.json, approved in ' : 'No sites approved yet. They come from .gitspace/bundle.json once you approve them in '}<button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onOpenEnvironment}>Environment</button>. Your Chrome only opens these; the cloud browser is unrestricted.</p>
      </section>
      {approved.length === 0 ? overview.chromes.length ? <section aria-label="Chrome approval" className="flex flex-col gap-3 rounded-xl border border-[#f59e0b]/50 bg-[#f59e0b]/10 p-3">
        <div>
          <h3 className="text-body font-medium">Agents here can&apos;t use your Chrome yet</h3>
          <p className="text-caption text-muted-foreground">{overview.chromes.length === 1 ? `${overview.chromes[0]!.name} is paired and ${overview.chromes[0]!.connected ? 'online' : 'offline'}, but not approved for ${projectName}. Approving makes it the project default, since ${projectName} has none.` : `${overview.chromes.length} Chromes are paired, but none is approved for ${projectName}. The one you approve becomes the project default, since ${projectName} has none.`}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {overview.chromes.map(chrome => <Button key={chrome.pairingId} variant={overview.chromes.length === 1 ? 'primary' : 'secondary'} size="compact" disabled={pending !== null} loading={pending === `approve:${chrome.pairingId}`} onClick={() => void approve(chrome)}>Approve {chrome.name} for {projectName}</Button>)}
          <Button variant="ghost" size="compact" onClick={() => navigateProductUrl(browserPluginsUrl())}>Manage Chromes</Button>
        </div>
      </section> : <section aria-label="Chrome approval" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-1 p-3">
        <div><h3 className="text-body font-medium">Let agents use your own Chrome</h3><p className="text-caption text-muted-foreground">For sites where you&apos;re signed in. Agents get one tab group per workspace and only the sites above.</p></div>
        <div><Button variant="secondary" size="compact" leadingIcon={PlusGlyph} onClick={() => navigateProductUrl(browserPluginsUrl(identity.projectId))}>Pair a Chrome</Button></div>
      </section> : null}
      {approved.map(chrome => <BrowserCard key={chrome.pairingId} label={chrome.name} icon={<Monitor01 width={18} height={18} />} title={chrome.name} meta={`Your Chrome · ${chrome.connected ? 'online' : 'offline'}`} badges={chrome.isDefault ? <Badge size="compact" color="gray">Project default</Badge> : null}>
        {chrome.note ? <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{chrome.note}</p> : null}
        {chrome.groupId === null ? <p className="text-caption text-muted-foreground">No tab group yet. It appears in this Chrome when an agent first uses it; drag tabs into it to share them.</p> : <>
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-3 px-2.5 py-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-1.5 py-0.5 text-caption font-medium">{chrome.running > 0 ? '▶ ' : ''}{chrome.groupName ?? 'This workspace’s group'}</span>
            {chrome.running > 0 ? <span className="text-caption">{chrome.running} {chrome.running === 1 ? 'script' : 'scripts'} running</span> : null}
            <span className="flex-1" />
            <RevokeButton groupId={chrome.groupId} pending={pending} onRevoke={revoke} />
          </div>
          <TabTiles {...tiles} groupId={chrome.groupId} tabs={chrome.tabs} watchLabel={`${chrome.name} · ${chrome.groupName ?? 'this workspace’s'} group`} onShare={shareTab} />
          {chrome.tabs.length && chrome.connected ? <p className="text-caption text-muted-foreground">{CHROME_CAPTURE_HINT}</p> : null}
        </>}
      </BrowserCard>)}
      <BrowserCard label="Cloud browser" icon={<Cloud01 width={18} height={18} />} title="Cloud browser" meta={`Headless · this workspace’s profile${overview.cloud.running ? ` · ${overview.cloud.running} running` : ''}`} badges={null} action={overview.cloud.groupId ? <RevokeButton groupId={overview.cloud.groupId} pending={pending} onRevoke={revoke} /> : null}>
        {overview.cloud.groupId ? <TabTiles {...tiles} groupId={overview.cloud.groupId} tabs={overview.cloud.tabs} watchLabel="Cloud browser" onShare={null} /> : <p className="text-caption text-muted-foreground">No open tabs.</p>}
      </BrowserCard>
      {overview.machines.map(machine => <BrowserCard key={machine.machineId} label={`Headless browser on ${machineLabel(machine.machineId)}`} icon={<Server01 width={18} height={18} />} title={`Headless browser on ${machineLabel(machine.machineId)}`} meta="Headless · on this machine" badges={null} action={machine.groupId ? <RevokeButton groupId={machine.groupId} pending={pending} onRevoke={groupId => revoke(groupId, machine.machineId)} /> : null}>
        {machine.error ? <p role="alert" className="text-caption text-destructive">{machine.error}</p> : null}
        {machine.groupId ? <TabTiles {...tiles} groupId={machine.groupId} tabs={machine.tabs} watchLabel={`Headless browser on ${machineLabel(machine.machineId)}`} onShare={null} /> : <p className="text-caption text-muted-foreground">No open tabs.</p>}
      </BrowserCard>)}
    </> : null}
    <BrowserCaptures captures={captures} error={capturesError} onMention={onCompose} />
    <BrowserShares shares={shares} error={sharesError} pending={pending} onStop={stopShare} />
    <BrowserPageComments comments={comments} error={commentsError} />
    {recovery.length ? <section aria-label="Browser recovery" className="flex flex-col gap-2">
      <h3 className="text-body font-medium">Recovery</h3>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-1 text-caption">
        {recovery.map(row => <li key={row.machineId ?? 'account'} className="flex flex-col gap-2 p-2.5">
          <p className="font-medium">{row.machineId === null ? 'Your account' : machineLabel(row.machineId)}</p>
          {row.error ? <p role="alert" className="text-destructive">{row.error}</p> : null}
          {row.records.map(record => <div key={record.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2"><Badge size="compact" color={record.state === 'stopped' ? 'gray' : 'amber'}>{record.state}</Badge><span className="break-all font-mono">{record.id}</span></div>
            <p>{record.reason}</p>
            {record.expiresAt ? <p className="tabular-nums text-muted-foreground">Fence expires <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString()}</time></p> : null}
            {row.machineId !== null ? <div className="flex flex-wrap gap-2">
              {record.actions.includes('reconcile') ? <Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === record.id} onClick={() => { const machineId = row.machineId; if (machineId !== null) void act(record.id, async () => { await request({ type: 'browserReconcile', machineId, recordId: record.id }); await readRecords(); }); }}>Reconcile process</Button> : null}
              {record.actions.includes('discard') ? <Button variant="ghost" size="compact" disabled={pending !== null} onClick={() => { const machineId = row.machineId; if (machineId !== null) void act(record.id, async () => { await request({ type: 'browserDiscard', machineId, recordId: record.id }); await readRecords(); }); }}>Discard stopped record</Button> : null}
            </div> : null}
          </div>)}
        </li>)}
      </ul>
      <p className="text-caption text-muted-foreground">Recovery records appear here only when a group needs repair.</p>
    </section> : null}
  </section>;
}

/** One browser of the workspace: its icon, name, badges and what it is, then its group and tabs. `action` sits at the
 * header's end. */
function BrowserCard({ label, icon, title, meta, badges, action, children }: { label: string; icon: ReactNode; title: string; meta: string; badges: ReactNode; action?: ReactNode; children: ReactNode }) {
  const shape = useShape();
  return <section aria-label={label} className={`${shape.container} flex flex-col gap-3 bg-surface-1 p-3 shadow-surface-1`}>
    <header className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <h3 className="min-w-0 break-words text-body font-medium">{title}</h3>
      {badges}
      <span className="flex-1" />
      <span className="text-caption text-muted-foreground">{meta}</span>
      {action}
    </header>
    {children}
  </section>;
}

/** Ends this workspace's group on a browser, after you confirm. */
function RevokeButton({ groupId, pending, onRevoke }: { groupId: string; pending: string | null; onRevoke(groupId: string): void }) {
  return <Button variant="ghost" size="compact" disabled={pending !== null} loading={pending === `revoke:${groupId}`} onClick={() => onRevoke(groupId)}>Revoke access</Button>;
}

/** A group's tabs as tiles. `pending` is the Browser tab's action in progress, if any: one action runs at a time.
 * `watchLabel` names the browser and group in the Watch dialog. `onShare` is set for a Chrome's group: its tiles get Share. */
function TabTiles({ groupId, tabs, watchLabel, request, pending, captures, onShare }: { groupId: string; tabs: readonly Tab[]; watchLabel: string; request: Request; pending: string | null; captures: CaptureControls; onShare: ShareCreate | null }) {
  const [watching, setWatching] = useState<Tab | null>(null);
  if (!tabs.length) return <p className="text-caption text-muted-foreground">No open tabs.</p>;
  return <>
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{tabs.map(tab => {
      const label = tab.title || tab.url;
      const recording = captures.recordings.find(view => view.capture.target?.groupId === groupId && view.capture.target.targetId === tab.targetId);
      return <li key={tab.targetId} aria-label={`Tab ${label}`} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-1">
        <TabPreview groupId={groupId} tab={tab} request={request} recording={recording ? <Badge size="compact" color="red"><span className="tabular-nums">REC <Elapsed since={recording.capture.startedAt} /></span></Badge> : null} onWatch={() => setWatching(tab)} />
        <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
          <span className="truncate text-caption font-medium" title={tab.title}>{label}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={tab.url}>{tab.url.replace(/^https?:\/\//u, '')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
          {tab.addedBy ? <Badge size="compact" color="gray">{TAB_ORIGIN[tab.addedBy]}</Badge> : null}
          {tab.usable ? null : <Badge size="compact" color="amber">Not on an approved site</Badge>}
          <span className="flex-1" />
          {recording ? <Button variant="ghost" size="icon-compact" aria-label={`Stop capturing ${label}`} title="Stop capturing" disabled={pending !== null} loading={pending === `stop:${recording.capture.captureId}`} onClick={() => captures.stop(recording.capture.captureId)}><StopCircle width={14} height={14} /></Button>
            : <Button variant="ghost" size="icon-compact" aria-label={`Capture ${label}`} title="Capture" disabled={pending !== null} loading={pending === `capture:${groupId}:${tab.targetId}`} onClick={() => captures.start(groupId, tab.targetId)}><VideoRecorder width={14} height={14} /></Button>}
          {onShare ? <ShareTab label={label} pending={pending === `share:${groupId}:${tab.targetId}`} busy={pending !== null} onCreate={(options, onCreated) => onShare(groupId, tab.targetId, options, onCreated)} /> : null}
          <Button variant="ghost" size="icon-compact" aria-label={`Watch ${label}`} title="Watch" onClick={() => setWatching(tab)}><Eye width={14} height={14} /></Button>
        </div>
      </li>;
    })}</ul>
    {watching ? <WatchDialog key={watching.targetId} groupId={groupId} tab={watching} watchLabel={watchLabel} request={request} onClose={() => setWatching(null)} /> : null}
  </>;
}

/** A tab's preview, read when it is shown and every `ms` after; `null` until the first read. */
function useTabPreview(groupId: string, targetId: string, request: Request, ms: number) {
  const [preview, setPreview] = useState<RuntimeBrowserPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request({ type: 'browserPreview', groupId, targetId }, signal);
      if (!signal?.aborted && result.browserPreview) { setPreview(result.browserPreview); setError(null); }
    } catch (cause) { if (!signal?.aborted) setError(rpcErrorMessage(cause, 'Read tab preview')); }
  }, [request, groupId, targetId]);
  useEffect(() => { const controller = new AbortController(); void read(controller.signal); return () => controller.abort(); }, [read]);
  useVisibleInterval(() => { void read(); }, ms);
  return { preview, error };
}

/** How long ago a preview was taken, ticking every second. */
function PreviewAge({ capturedAt }: { capturedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="absolute bottom-1 right-1.5 rounded bg-black/60 px-1 text-[10px] tabular-nums text-white">{age(now - Date.parse(capturedAt))}</span>;
}

/** A tile's preview, flush at its top; the reason replaces it when there is no image. Opens the Watch dialog. */
function TabPreview({ groupId, tab, request, recording, onWatch }: { groupId: string; tab: Tab; request: Request; recording: ReactNode; onWatch(): void }) {
  const { preview, error } = useTabPreview(groupId, tab.targetId, request, BROWSER_REFRESH_MS);
  const image = preview?.image;
  return <button type="button" aria-label={`Preview of ${tab.title || tab.url}`} onClick={onWatch} className="relative flex aspect-[16/10] items-center justify-center overflow-hidden border-b border-border bg-surface-2">
    {image ? <img className="h-full w-full object-cover object-top" src={`data:${image.mediaType};base64,${image.data}`} alt={`Preview of ${tab.title || tab.url}`} />
      : <p className="p-2 text-center text-caption text-muted-foreground">{error ?? preview?.reason ?? 'Loading preview…'}</p>}
    {recording ? <span className="absolute bottom-1 left-1.5">{recording}</span> : null}
    {image && preview ? <PreviewAge capturedAt={preview.capturedAt} /> : null}
  </button>;
}

/** Watching one tab: its preview large, read every few seconds while the dialog is open. */
function WatchDialog({ groupId, tab, watchLabel, request, onClose }: { groupId: string; tab: Tab; watchLabel: string; request: Request; onClose(): void }) {
  const { preview, error } = useTabPreview(groupId, tab.targetId, request, WATCH_REFRESH_MS);
  const image = preview?.image;
  const title = tab.title || tab.url;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent size="lg">
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{watchLabel} · a new screenshot every few seconds</DialogDescription></DialogHeader>
    <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-2">
      {image ? <img className="h-full w-full object-contain object-top" src={`data:${image.mediaType};base64,${image.data}`} alt={`Live view of ${title}`} />
        : <p className="p-4 text-center text-caption text-muted-foreground">{error ?? preview?.reason ?? 'Loading preview…'}</p>}
      {image && preview ? <PreviewAge capturedAt={preview.capturedAt} /> : null}
    </div>
    <DialogFooter><Button variant="primary" onClick={onClose}>Done</Button></DialogFooter>
  </DialogContent></Dialog>;
}
