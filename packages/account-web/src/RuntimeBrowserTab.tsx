import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeIdentitySchema, type RuntimeBrowserCaptureView, type RuntimeBrowserOverview, type RuntimeBrowserPreview, type RuntimeBrowserStatus, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { Badge, Button, useShape } from '@gitspace/ui';
import { approveChrome } from './browser-approvals.js';
import { projectBrowserSettings, updateProjectBrowserSettings } from './browser-relay-client.js';
import { BrowserCaptures, RecordingClock } from './RuntimeBrowserCaptures.js';
import { browserPluginsUrl, navigateProductUrl } from './routes.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Tab = RuntimeBrowserOverview['cloud']['tabs'][number];
type Chrome = RuntimeBrowserOverview['chromes'][number];
type Request = (command: RuntimeSessionCommand, signal?: AbortSignal) => Promise<{ browserOverview?: RuntimeBrowserOverview; browserPreview?: RuntimeBrowserPreview; browserStatus?: RuntimeBrowserStatus; browserCaptures?: RuntimeBrowserCaptureView[]; browserCapture?: RuntimeBrowserCaptureView }>;
type Records = { machineId: string | null; records: RuntimeBrowserStatus['records']; error: string | null };
/** Recording from tab tiles: the captures now recording (matched to tiles by their target) and the commands. */
type CaptureControls = { recordings: readonly RuntimeBrowserCaptureView[]; start(groupId: string, targetId: string): void; stop(captureId: string): void };

/** How often the overview, the captures and each visible tab's preview are read while the tab is shown. */
export const BROWSER_REFRESH_MS = 10_000;
/** On your Chrome, Capture here records screencast frames; video with sound needs your click in Chrome itself. */
const CHROME_CAPTURE_HINT = 'Capture here records the tab without sound. For video with sound, click Capture on the tab in Chrome (the GitSpace toolbar on the page or the extension’s popup).';
const TAB_ORIGIN: Record<NonNullable<Tab['addedBy']>, string> = { agent: 'Opened by agent', you: 'You added it', page: 'Opened by a page' };

/** Runs `tick` every `ms` while the page is visible, the way the Browser tab and its previews refresh. */
function useVisibleInterval(tick: () => void, ms: number) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') latest.current(); }, ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** The Inspector's Browser tab: this workspace's browsers (the cloud browser, each attached machine's headless browser and
 * each Chrome this project approved, with its tab group, tabs and previews), the approved sites, and recovery records when there are any. */
export function RuntimeBrowserTab({ snapshot, conversationId, machines, onOpenEnvironment }: { snapshot: RuntimeSnapshot; conversationId?: string; machines: readonly { id: string; label: string }[]; onOpenEnvironment(): void }) {
  const shape = useShape();
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  // Keyed by content so a new snapshot with the same machines does not reread the records.
  const machineKey = [...new Set(snapshot.attachments.filter(attachment => attachment.state === 'ready' && attachment.capabilities.includes('browser.headless')).map(attachment => attachment.machineId))].sort().join('\n');
  const [overview, setOverview] = useState<RuntimeBrowserOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<readonly Records[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captures, setCaptures] = useState<readonly RuntimeBrowserCaptureView[] | null>(null);
  const [capturesError, setCapturesError] = useState<string | null>(null);
  const busy = useRef(false);
  // Bumped by each start and stop, so a list read that began before one does not overwrite what it returned.
  const captureChanges = useRef(0);
  const request = useCallback<Request>(async (command, signal) => {
    const response = await rpcClient.runtime.session({ ...identity, ...(conversationId ? { conversationId } : {}), command }, { signal });
    if (response.status === 'error') throw response.error;
    return response.value;
  }, [identity, conversationId]);
  const readOverview = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await request({ type: 'browserOverview' }, signal);
      if (!result.browserOverview) throw new Error('The workspace did not return its browsers.');
      if (!signal?.aborted) { setOverview(result.browserOverview); setOverviewError(null); }
    } catch (cause) { if (!signal?.aborted) setOverviewError(rpcErrorMessage(cause, 'Read workspace browsers')); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [request]);
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
  useEffect(() => {
    setOverview(null); setRecords([]); setCaptures(null);
    const controller = new AbortController();
    void readOverview(controller.signal); void readRecords(controller.signal); void readCaptures(controller.signal);
    return () => controller.abort();
  }, [readOverview, readRecords, readCaptures]);
  useVisibleInterval(() => { void readOverview(); void readCaptures(); }, BROWSER_REFRESH_MS);
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
  const captureControls: CaptureControls = {
    recordings: captures?.filter(view => view.capture.state === 'recording' && view.capture.target !== null) ?? [],
    start: (groupId, targetId) => void act(`capture:${groupId}:${targetId}`, async () => keepCapture((await request({ type: 'browserCaptureStart', groupId, targetId })).browserCapture)),
    stop: captureId => void act(`stop:${captureId}`, async () => keepCapture((await request({ type: 'browserCaptureStop', captureId })).browserCapture)),
  };
  const machineLabel = (machineId: string) => machines.find(machine => machine.id === machineId)?.label ?? machineId;
  const recovery = records.filter(row => row.records.length > 0 || row.error !== null);
  const approved = overview?.chromes.filter(chrome => chrome.approved) ?? [];
  const card = `${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`;
  return <section aria-label="Workspace browsers" className="flex flex-col gap-4 p-3">
    <div className="flex items-center justify-between gap-3"><h3 className="text-body font-medium">Browsers</h3><Button variant="ghost" size="compact" loading={loading} disabled={loading || pending !== null} onClick={() => void Promise.all([readOverview(), readRecords(), readCaptures()])}>Refresh</Button></div>
    {overviewError ? <p role="alert" className="text-caption text-destructive">{overviewError}{overview ? ' Showing the last state read.' : ''}</p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {overview === null && !overviewError ? <p role="status" className="text-caption text-muted-foreground">Loading browsers…</p> : null}
    {overview ? <>
      <section aria-label="Approved sites" className={card}>
        <div className="flex items-center justify-between gap-3"><h4 className="text-caption font-semibold">Approved sites</h4><Button variant="ghost" size="compact" onClick={onOpenEnvironment}>Change in Environment</Button></div>
        {overview.sites.origins.length ? <ul className="flex flex-col gap-1">{overview.sites.origins.map(origin => <li key={origin} className="flex flex-wrap items-center gap-2"><span className="break-all font-mono text-caption">{origin}</span><Badge size="compact" color="gray">{overview.sites.stepsOnly.includes(origin) ? 'single steps' : 'scripts'}</Badge></li>)}</ul>
          : <p className="text-caption text-muted-foreground">No sites approved yet. Agents can use your Chrome only on sites approved in Environment.</p>}
      </section>
      {approved.length === 0 ? <section aria-label="Chrome approval" className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
        <p className="text-body font-medium">Agents here can&apos;t use your Chrome yet</p>
        {overview.chromes.length ? <>
          <p className="text-caption text-muted-foreground">Approve a Chrome for this project; its agents then use it in this workspace&apos;s own tab group.</p>
          <div className="flex flex-wrap gap-2">{overview.chromes.map(chrome => <Button key={chrome.pairingId} variant="secondary" size="compact" disabled={pending !== null} loading={pending === `approve:${chrome.pairingId}`} onClick={() => void approve(chrome)}>Approve {chrome.name} for this project</Button>)}</div>
        </> : <>
          <p className="text-caption text-muted-foreground">Pair your Chrome with GitSpace first, then approve it for this project.</p>
          <div><Button variant="secondary" size="compact" onClick={() => navigateProductUrl(browserPluginsUrl(identity.projectId))}>Pair a Chrome</Button></div>
        </>}
      </section> : null}
      {approved.map(chrome => <section key={chrome.pairingId} aria-label={chrome.name} className={card}>
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="min-w-0 flex-1 break-words text-body font-medium">{chrome.name}</h4>
          {chrome.isDefault ? <Badge size="compact" color="gray">Project default</Badge> : null}
          <Badge size="compact" color={chrome.connected ? 'green' : 'gray'}>{chrome.connected ? 'Online' : 'Offline'}</Badge>
        </div>
        {chrome.note ? <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{chrome.note}</p> : null}
        <GroupTabs groupId={chrome.groupId} groupName={chrome.groupName} running={chrome.running} tabs={chrome.tabs} empty="No tab group yet. It appears in this Chrome when an agent first uses it; drag tabs into it to share them." request={request} pending={pending} onRevoke={revoke} captures={captureControls} captureHint={chrome.connected ? CHROME_CAPTURE_HINT : null} />
      </section>)}
      <section aria-label="Cloud browser" className={card}>
        <h4 className="text-body font-medium">Cloud browser</h4>
        <GroupTabs groupId={overview.cloud.groupId} groupName={null} running={overview.cloud.running} tabs={overview.cloud.tabs} empty="Not started. It starts when an agent first browses." request={request} pending={pending} onRevoke={revoke} captures={captureControls} captureHint={null} />
      </section>
      {overview.machines.map(machine => <section key={machine.machineId} aria-label={`Headless browser on ${machineLabel(machine.machineId)}`} className={card}>
        <h4 className="min-w-0 break-words text-body font-medium">Headless browser on {machineLabel(machine.machineId)}</h4>
        {machine.error ? <p role="alert" className="text-caption text-destructive">{machine.error}</p> : null}
        <GroupTabs groupId={machine.groupId} groupName={null} running={0} tabs={machine.tabs} empty="No tabs open." request={request} pending={pending} onRevoke={groupId => revoke(groupId, machine.machineId)} captures={captureControls} captureHint={null} />
      </section>)}
      {recovery.length ? <section aria-label="Browser recovery" className={card}>
        <h4 className="text-caption font-semibold">Recovery</h4>
        {recovery.map(row => <div key={row.machineId ?? 'account'} className="flex flex-col gap-2">
          <p className="text-caption font-medium">{row.machineId === null ? 'Your account' : machineLabel(row.machineId)}</p>
          {row.error ? <p role="alert" className="text-caption text-destructive">{row.error}</p> : null}
          {row.records.map(record => <div key={record.id} className="flex flex-col gap-2 rounded-lg bg-surface-3 p-3">
            <div className="flex items-center gap-2"><Badge color={record.state === 'stopped' ? 'gray' : 'amber'}>{record.state}</Badge><span className="break-all font-mono text-caption">{record.id}</span></div>
            <p className="text-caption">{record.reason}</p>
            {record.expiresAt ? <p className="text-caption tabular-nums text-muted-foreground">Fence expires <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString()}</time></p> : null}
            {row.machineId !== null ? <div className="flex flex-wrap gap-2">
              {record.actions.includes('reconcile') ? <Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === record.id} onClick={() => { const machineId = row.machineId; if (machineId !== null) void act(record.id, async () => { await request({ type: 'browserReconcile', machineId, recordId: record.id }); await readRecords(); }); }}>Reconcile process</Button> : null}
              {record.actions.includes('discard') ? <Button variant="ghost" size="compact" disabled={pending !== null} onClick={() => { const machineId = row.machineId; if (machineId !== null) void act(record.id, async () => { await request({ type: 'browserDiscard', machineId, recordId: record.id }); await readRecords(); }); }}>Discard stopped record</Button> : null}
            </div> : null}
          </div>)}
        </div>)}
      </section> : null}
    </> : null}
    <BrowserCaptures captures={captures} error={capturesError} />
  </section>;
}

/** `pending` is the Browser tab's action in progress, if any: one action runs at a time. `captureHint` explains
 * recording on this browser beyond the tiles' Capture, if anything. */
function GroupTabs({ groupId, groupName, running, tabs, empty, request, pending, onRevoke, captures, captureHint }: { groupId: string | null; groupName: string | null; running: number; tabs: readonly Tab[]; empty: string; request: Request; pending: string | null; onRevoke(groupId: string): void; captures: CaptureControls; captureHint: string | null }) {
  if (groupId === null) return <p className="text-caption text-muted-foreground">{empty}</p>;
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      {groupName ? <span className="text-caption text-muted-foreground">Tab group <span className="font-medium text-foreground">{groupName}</span></span> : null}
      {running > 0 ? <Badge size="compact" color="blue">▶ running {running}</Badge> : null}
      <Button className="ml-auto" variant="ghost" size="compact" disabled={pending !== null} loading={pending === `revoke:${groupId}`} onClick={() => onRevoke(groupId)}>Revoke access</Button>
    </div>
    {tabs.length && captureHint ? <p className="text-caption text-muted-foreground">{captureHint}</p> : null}
    {tabs.length ? <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{tabs.map(tab => {
      const label = tab.title || tab.url;
      const recording = captures.recordings.find(view => view.capture.target?.groupId === groupId && view.capture.target.targetId === tab.targetId);
      return <li key={tab.targetId} aria-label={`Tab ${label}`} className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-3 p-2">
        <TabPreview groupId={groupId} tab={tab} request={request} />
        <div className="min-w-0">
          <p className="truncate text-caption font-medium" title={tab.title}>{label}</p>
          <p className="truncate font-mono text-caption text-muted-foreground" title={tab.url}>{tab.url}</p>
          {tab.addedBy ? <p className="text-caption text-muted-foreground">{TAB_ORIGIN[tab.addedBy]}{tab.usable ? '' : ' · not on an approved site'}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {recording ? <>
            <Badge size="compact" color="red"><span className="tabular-nums"><RecordingClock startedAt={recording.capture.startedAt} /></span></Badge>
            <Button variant="secondary" size="compact" aria-label={`Stop capturing ${label}`} disabled={pending !== null} loading={pending === `stop:${recording.capture.captureId}`} onClick={() => captures.stop(recording.capture.captureId)}>Stop</Button>
          </> : <Button variant="ghost" size="compact" aria-label={`Capture ${label}`} disabled={pending !== null} loading={pending === `capture:${groupId}:${tab.targetId}`} onClick={() => captures.start(groupId, tab.targetId)}>Capture</Button>}
        </div>
      </li>;
    })}</ul> : <p className="text-caption text-muted-foreground">No tabs in the group.</p>}
  </div>;
}

/** A tab's preview, read when it is shown and every refresh after; the reason replaces it when there is no image. */
function TabPreview({ groupId, tab, request }: { groupId: string; tab: Tab; request: Request }) {
  const [preview, setPreview] = useState<RuntimeBrowserPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request({ type: 'browserPreview', groupId, targetId: tab.targetId }, signal);
      if (!signal?.aborted && result.browserPreview) { setPreview(result.browserPreview); setError(null); }
    } catch (cause) { if (!signal?.aborted) setError(rpcErrorMessage(cause, 'Read tab preview')); }
  }, [request, groupId, tab.targetId]);
  useEffect(() => { const controller = new AbortController(); void read(controller.signal); return () => controller.abort(); }, [read]);
  useVisibleInterval(() => { void read(); }, BROWSER_REFRESH_MS);
  const image = preview?.image;
  return <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-surface-2">
    {image ? <img className="h-full w-full object-cover object-top" src={`data:${image.mediaType};base64,${image.data}`} alt={`Preview of ${tab.title || tab.url}`} />
      : <p className="p-2 text-center text-caption text-muted-foreground">{error ?? preview?.reason ?? 'Loading preview…'}</p>}
  </div>;
}
