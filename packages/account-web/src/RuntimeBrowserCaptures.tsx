import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import {
  BROWSER_CAPTURE_SHARE_EXPIRIES_MINUTES, RuntimeBrowserCaptureShareExpirySchema, captureMention,
  type RuntimeBrowserCapture, type RuntimeBrowserCaptureShare, type RuntimeBrowserCaptureShareExpiry, type RuntimeBrowserCaptureView, type RuntimeBrowserCommentThread,
} from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { Badge, Button, Dialog, DialogContent, DialogTitle, TabsSubtle, TabsSubtleItem, useShape } from '@gitspace/ui';
import { CAPTURE_THUMBNAIL, CapturePlayer, captureLength, captureMedia, formatClock, type CapturePlayerActions } from './capture/CapturePlayer.js';
import { CopyLink, TimeLeft } from './RuntimeBrowserShares.js';
import { useLiveChanges } from './live-notices.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type Request = (command: RuntimeSessionCommand, signal?: AbortSignal) => Promise<RuntimeSessionResult>;
type CaptureFilter = 'all' | 'steps' | 'comments' | 'video' | 'screenshots';
/** Threads the list counts per capture, from one read of the workspace's threads. */
const THREADS_COUNTED = 500;
/** The URL parameter that opens a capture's player (the extension's "Open in GitSpace"). */
const CAPTURE_PARAM = 'capture';
const CAPTURE_FILTER_ORDER: readonly CaptureFilter[] = ['all', 'steps', 'comments', 'video', 'screenshots'];
const CAPTURE_FILTER_LABEL: Record<CaptureFilter, string> = { all: 'All', steps: 'Steps', comments: 'Comments', video: 'Video', screenshots: 'Screenshots' };
const EXPIRY_LABEL: Record<RuntimeBrowserCaptureShareExpiry, string> = { 60: '1 hour', 1440: '1 day', 10_080: '7 days', 43_200: '30 days' };
const AUDIT_LABEL: Record<RuntimeBrowserCaptureShare['audit'][number]['event'], string> = { created: 'shared the capture', opened: 'opened it', commented: 'commented', replied: 'replied', resolved: 'resolved a thread', reopened: 'reopened a thread', ended: 'ended the share' };

/** `m:ss` since `since`, ticking every second. */
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatClock(now - Date.parse(since))}</>;
}

/** Whether a capture is a screenshot: one image and nothing played. */
function screenshot(capture: RuntimeBrowserCapture): boolean {
  return capture.tracks.image !== undefined && !capture.tracks.video && !capture.tracks.frames;
}

/** A capture's track pills as the list shows them: its steps, comments, video (with sound when it has it), layout, and
 * a screenshot's size. `comments` counts its threads. */
function trackPills(capture: RuntimeBrowserCapture, comments: number): string[] {
  const { image, video, frames, steps, layout } = capture.tracks;
  return [
    ...(steps?.count ? [`${steps.count} ${steps.count === 1 ? 'step' : 'steps'}`] : []),
    ...(comments ? [`${comments} ${comments === 1 ? 'comment' : 'comments'}`] : []),
    ...(video || frames ? [`video ${formatClock(captureLength(capture))}${video?.sound ? ' · sound' : ''}`] : []),
    ...(layout ? ['layout'] : []),
    ...(image && screenshot(capture) ? [`screenshot · ${image.width}×${image.height}`] : []),
  ];
}

/** The Browser tab's Captures (docs/APERTURE-DESIGN.md §11): the workspace's captures, newest first, filtered by track
 * with counts, each with its track pills, whether the agent saved it as a skill, who made it where, Mention (puts it
 * into the chat), Play or View (the player) and Share (its share link). `captures` is null until first read. */
export function BrowserCaptures({ identity, request, captures, error, onMention }: { identity: { projectId: string; workspaceId: string }; request: Request; captures: readonly RuntimeBrowserCaptureView[] | null; error: string | null; onMention?: (reference: string) => void }) {
  const [filter, setFilter] = useState<CaptureFilter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [mentioned, setMentioned] = useState<string | null>(null);
  const [threads, setThreads] = useState<readonly RuntimeBrowserCommentThread[] | null>(null);
  const [shares, setShares] = useState<readonly RuntimeBrowserCaptureShare[] | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const linked = useRef(false);
  const readThreads = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request({ type: 'browserComments', status: 'all', limit: THREADS_COUNTED }, signal);
      if (!signal?.aborted && result.browserComments) setThreads(result.browserComments.map(view => view.thread));
    } catch { /* The counts fall back to what each capture recorded. */ }
  }, [request]);
  const readShares = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request({ type: 'browserCaptureShares' }, signal);
      if (!signal?.aborted && result.browserCaptureShares) { setShares(result.browserCaptureShares); setShareError(null); }
    } catch (cause) { if (!signal?.aborted) setShareError(rpcErrorMessage(cause, 'Read capture shares')); }
  }, [request]);
  useEffect(() => {
    const controller = new AbortController();
    void readThreads(controller.signal); void readShares(controller.signal);
    return () => controller.abort();
  }, [readThreads, readShares]);
  // Each new comment, reply, resolve or reopen in this workspace is announced; the counts are read again.
  const commentNotices = useLiveChanges(workspaceLiveKey(identity.workspaceId, 'page-comments', identity.projectId));
  useEffect(() => { if (commentNotices !== null) void readThreads(); }, [commentNotices, readThreads]);
  // "Open in GitSpace" from the extension names the capture to play; it opens once, and the URL forgets it.
  useEffect(() => {
    if (linked.current || !captures) return;
    linked.current = true;
    const url = new URL(window.location.href), wanted = url.searchParams.get(CAPTURE_PARAM);
    if (!wanted) return;
    url.searchParams.delete(CAPTURE_PARAM);
    window.history.replaceState(window.history.state, '', url);
    if (captures.some(view => view.capture.captureId === wanted)) setOpen(wanted);
  }, [captures]);

  const counted = new Map<string, number>();
  for (const thread of threads ?? []) if (thread.root.source.kind === 'capture') counted.set(thread.root.source.captureId, (counted.get(thread.root.source.captureId) ?? 0) + 1);
  const commentCount = (capture: RuntimeBrowserCapture) => threads ? counted.get(capture.captureId) ?? 0 : capture.tracks.comments?.count ?? 0;
  const keep: Record<CaptureFilter, (capture: RuntimeBrowserCapture) => boolean> = {
    all: () => true,
    steps: capture => (capture.tracks.steps?.count ?? 0) > 0,
    comments: capture => commentCount(capture) > 0,
    // A recording still running or one that failed is a recording too.
    video: capture => !!capture.tracks.video || !!capture.tracks.frames || (capture.state !== 'saved' && !capture.tracks.image),
    screenshots: screenshot,
  };
  const all = captures ?? [];
  const shown = all.filter(view => keep[filter](view.capture)).toSorted((a, b) => Date.parse(b.capture.startedAt) - Date.parse(a.capture.startedAt));
  const today = new Date().toDateString();
  const playing = open ? all.find(view => view.capture.captureId === open) : undefined;
  const share = (captureId: string, options: { comment: boolean; expiresInMinutes: RuntimeBrowserCaptureShareExpiry }) => void (async () => {
    setPending(`share:${captureId}`); setShareError(null);
    try {
      const made = (await request({ type: 'browserCaptureShareCreate', captureId, ...options })).browserCaptureShare;
      if (made) setShares(previous => [made, ...(previous ?? []).filter(other => other.captureShareId !== made.captureShareId)]);
    } catch (cause) { setShareError(rpcErrorMessage(cause, 'Share the capture')); } finally { setPending(null); }
  })();
  const unshare = (captureShareId: string) => void (async () => {
    setPending(`unshare:${captureShareId}`); setShareError(null);
    try {
      const ended = (await request({ type: 'browserCaptureShareRevoke', captureShareId })).browserCaptureShare;
      if (ended) setShares(previous => (previous ?? []).map(other => other.captureShareId === ended.captureShareId ? ended : other));
    } catch (cause) { setShareError(rpcErrorMessage(cause, 'Stop sharing the capture')); } finally { setPending(null); }
  })();
  return <section aria-label="Captures" className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-body font-medium">Captures</h3>
      <TabsSubtle size="compact" selectedIndex={CAPTURE_FILTER_ORDER.indexOf(filter)} onSelect={index => setFilter(CAPTURE_FILTER_ORDER[index] ?? 'all')} idPrefix="browser-captures" aria-label="Capture kind">
        {CAPTURE_FILTER_ORDER.map((key, index) => <TabsSubtleItem key={key} index={index} label={`${CAPTURE_FILTER_LABEL[key]} · ${all.filter(view => keep[key](view.capture)).length}`} />)}
      </TabsSubtle>
    </div>
    {error ? <p role="alert" className="text-caption text-destructive">{error}{captures ? ' Showing the last list read.' : ''}</p> : null}
    {shareError ? <p role="alert" className="text-caption text-destructive">{shareError}</p> : null}
    {captures === null && !error ? <p role="status" className="text-caption text-muted-foreground">Loading captures…</p> : null}
    {captures !== null && !shown.length ? <p className="text-caption text-muted-foreground">{captures.length ? 'No captures of this kind.' : 'No captures yet. Capture a tab here or from Chrome; screenshots agents take in scripts appear here too.'}</p> : null}
    {shown.length ? <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-1 text-caption">{shown.map(view => {
      const { capture } = view;
      const thumbnail = view.files[CAPTURE_THUMBNAIL] ?? (capture.tracks.image ? view.files[capture.tracks.image.path] : undefined);
      const recording = capture.state === 'recording';
      const verb = screenshot(capture) ? 'View' : 'Play';
      const started = new Date(capture.startedAt);
      const when = recording ? 'capturing now' : started.toLocaleString([], started.toDateString() === today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const meta = capture.skill ? `Agent saved it to ${capture.skill.path} in ${capture.skill.commit.slice(0, 7)}`
        : [capture.by === 'you' ? 'You' : 'Agent', ...(capture.by === 'agent' && screenshot(capture) ? ['capture() in a run'] : []), capture.browser, capture.page.url.replace(/^https?:\/\//u, ''), when].join(' · ');
      const live = shares?.find(other => other.captureId === capture.captureId && other.endedAt === null) ?? null;
      return <li key={capture.captureId} aria-label={capture.name} className="flex min-w-0 flex-wrap items-center gap-3 p-2.5">
        <span className="relative flex aspect-[16/10] w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
          {thumbnail ? <img className="h-full w-full object-cover object-top" src={thumbnail} alt="" loading="lazy" /> : <span className="text-muted-foreground">{capture.tracks.image ? 'Image' : 'Video'}</span>}
          {recording ? <span className="absolute left-1 top-1"><Badge size="compact" color="red">● live</Badge></span> : null}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body" title={capture.name}>{capture.name}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {recording ? <span className="rounded-full bg-surface-3 px-1.5 py-px text-[11px] tabular-nums">recording <Elapsed since={capture.startedAt} /></span>
              : trackPills(capture, commentCount(capture)).map(track => <span key={track} className="rounded-full bg-surface-3 px-1.5 py-px text-[11px] tabular-nums">{track}</span>)}
            {capture.skill ? <Badge size="compact" color="green">Saved as skill</Badge> : capture.state === 'saved' && capture.tracks.steps?.count ? <Badge size="compact" color="gray">Not in repo</Badge> : null}
            {capture.state === 'failed' ? <Badge size="compact" color="red">Failed</Badge> : null}
          </div>
          <p className="mt-0.5 truncate text-muted-foreground" title={capture.page.url}>{meta}</p>
          {capture.state === 'failed' ? <p className="mt-0.5 text-destructive">{capture.reason ?? 'The capture was not saved.'}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onMention ? <Button variant="ghost" size="compact" aria-label={`Mention ${capture.name}`} onClick={() => { onMention(`${captureMention(capture.captureId)} `); setMentioned(capture.captureId); }}>{mentioned === capture.captureId ? 'Mentioned' : 'Mention'}</Button> : null}
          <Button variant="ghost" size="compact" aria-label={`${verb} ${capture.name}`} disabled={recording || captureMedia(capture, view.files) === null} onClick={() => setOpen(capture.captureId)}>{verb}</Button>
          <ShareCapture label={capture.name} saved={capture.state === 'saved'} live={live} pending={pending} onShare={options => share(capture.captureId, options)} onStop={unshare} />
        </div>
      </li>;
    })}</ul> : null}
    <p className="text-caption text-muted-foreground">Everything you or an agent captures, one list. A capture is tracks: steps, comments, video, page layout; a screenshot is one frame. Nothing here is in the repository until the agent saves it there; mention one in the chat to use it.</p>
    {playing ? <CaptureDialog key={playing.capture.captureId} view={playing} request={request} identity={identity} onClose={() => setOpen(null)} /> : null}
  </section>;
}

/** A capture's Share: its live link to copy (with its activity and Stop sharing), or comments and expiry to make one.
 * The link plays the whole recording, from the drive, with every Chrome offline. */
function ShareCapture({ label, saved, live, pending, onShare, onStop }: { label: string; saved: boolean; live: RuntimeBrowserCaptureShare | null; pending: string | null; onShare(options: { comment: boolean; expiresInMinutes: RuntimeBrowserCaptureShareExpiry }): void; onStop(captureShareId: string): void }) {
  const shape = useShape();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState(true);
  const [expiresInMinutes, setExpiresInMinutes] = useState<RuntimeBrowserCaptureShareExpiry>(10_080);
  return <div className="relative">
    <Button variant="secondary" size="compact" aria-label={`Share ${label}`} aria-expanded={open} disabled={!saved} onClick={() => setOpen(!open)}>Share</Button>
    {open ? <div role="dialog" aria-label={`Share link for ${label}`} className={`${shape.container} absolute right-0 top-full z-20 mt-1 flex w-80 max-w-[85vw] flex-col gap-3 bg-surface-1 p-3 text-caption shadow-surface-3`}>
      {live ? <>
        <p>{live.comment ? 'People with the link watch the whole recording, comment at any moment and reply' : 'People with the link watch the whole recording'}; your Chrome doesn&apos;t need to be on. <TimeLeft expiresAt={live.expiresAt} />.</p>
        <CopyLink link={live.link} label={label} />
        <div><Button variant="secondary" size="compact" aria-label={`Stop sharing ${label}`} disabled={pending !== null} loading={pending === `unshare:${live.captureShareId}`} onClick={() => onStop(live.captureShareId)}>Stop sharing</Button></div>
        {live.audit.length ? <details>
          <summary className="cursor-pointer text-muted-foreground">Activity ({live.audit.length})</summary>
          <ul className="mt-1 flex flex-col gap-1">{live.audit.map((row, index) => <li key={`${row.at}:${index}`} className="break-words">
            <time className="tabular-nums text-muted-foreground" dateTime={row.at}>{new Date(row.at).toLocaleString()}</time> {row.by}{row.guest ? ' (guest)' : ''} {AUDIT_LABEL[row.event]}{row.detail ? `: ${row.detail}` : ''}
          </li>)}</ul>
        </details> : null}
      </> : <>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={comment} disabled={pending !== null} onChange={event => setComment(event.target.checked)} />
          <span>Comments<span className="block text-muted-foreground">People with the link may comment at any moment and reply; comments land in this workspace.</span></span>
        </label>
        <label className="flex flex-col gap-1">Expires after
          <select aria-label="Expires after" className="min-h-8 rounded-md bg-surface-3 px-2 text-caption" value={expiresInMinutes} disabled={pending !== null} onChange={event => setExpiresInMinutes(RuntimeBrowserCaptureShareExpirySchema.parse(Number(event.target.value)))}>
            {BROWSER_CAPTURE_SHARE_EXPIRIES_MINUTES.map(minutes => <option key={minutes} value={minutes}>{EXPIRY_LABEL[minutes]}</option>)}
          </select>
        </label>
        <p className="text-muted-foreground">The link plays the whole recording: everything visible in the tab while it was captured.</p>
        <Button variant="secondary" size="compact" disabled={pending !== null} loading={pending?.startsWith('share:') ?? false} onClick={() => onShare({ comment, expiresInMinutes })}>Create link</Button>
      </>}
    </div> : null}
  </div>;
}

/** The player in a dialog over the Browser tab: the capture's threads read for it alone and again when one changes;
 * you comment, reply and resolve as the account's owner. */
function CaptureDialog({ view, request, identity, onClose }: { view: RuntimeBrowserCaptureView; request: Request; identity: { projectId: string; workspaceId: string }; onClose(): void }) {
  const { capture } = view;
  const [threads, setThreads] = useState<readonly RuntimeBrowserCommentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changes = useRef(0);
  const read = useCallback(async (signal?: AbortSignal) => {
    const before = changes.current;
    try {
      const result = await request({ type: 'browserComments', status: 'all', captureId: capture.captureId, limit: THREADS_COUNTED }, signal);
      if (!signal?.aborted && before === changes.current && result.browserComments) { setThreads(result.browserComments.map(item => item.thread)); setError(null); }
    } catch (cause) { if (!signal?.aborted) setError(rpcErrorMessage(cause, 'Read the capture’s comments')); }
  }, [request, capture.captureId]);
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);
  const notices = useLiveChanges(workspaceLiveKey(identity.workspaceId, 'page-comments', identity.projectId));
  useEffect(() => { if (notices !== null) void read(); }, [notices, read]);
  /** Shows the thread a change returned in place of its listed state. */
  const keep = (thread: RuntimeBrowserCommentThread | undefined) => {
    if (!thread) throw new Error('The workspace did not return the thread.');
    changes.current += 1;
    setThreads(previous => [...(previous ?? []).filter(other => other.root.id !== thread.root.id), thread]);
  };
  const actions: CapturePlayerActions = {
    comment: async input => {
      try { keep((await request({ type: 'browserCommentAdd', source: { kind: 'capture', captureId: capture.captureId, atMs: input.atMs }, page: input.page, anchor: input.anchor, text: input.text })).browserComment); }
      catch (cause) { throw new Error(rpcErrorMessage(cause, 'Comment')); }
    },
    reply: async (threadId, text) => {
      try { keep((await request({ type: 'browserCommentReply', threadId, text })).browserComment); } catch (cause) { throw new Error(rpcErrorMessage(cause, 'Reply')); }
    },
    resolve: async (threadId, reopen) => {
      try { keep((await request({ type: 'browserCommentResolve', threadId, ...(reopen ? { reopen } : {}) })).browserComment); } catch (cause) { throw new Error(rpcErrorMessage(cause, reopen ? 'Reopen' : 'Resolve')); }
    },
  };
  const length = captureLength(capture);
  return <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent size="lg" className="max-w-[min(1040px,calc(100vw-2rem))] p-4">
      <DialogTitle className="sr-only">{capture.name}</DialogTitle>
      <CapturePlayer
        capture={capture} files={view.files} threads={threads} threadsError={error} as="You" canComment canResolve actions={actions}
        header={<p className="min-w-0 flex-1 truncate pr-8 text-caption"><strong>{capture.name}</strong> · {capture.by === 'you' ? 'by you' : 'by an agent'} · {capture.browser}{length ? ` · ${formatClock(length)}` : ''} · <span title={capture.page.url}>{capture.page.url.replace(/^https?:\/\//u, '')}</span></p>}
      />
    </DialogContent>
  </Dialog>;
}
