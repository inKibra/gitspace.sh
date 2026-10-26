import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { RuntimeBrowserCaptureShareEnd, RuntimeBrowserCaptureShareOpened, RuntimeBrowserCaptureSharePreview, RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { Button, InputField, InputGroup, ThinkingIndicator } from '@gitspace/ui';
import { MessagePlusSquare } from '@untitledui/icons';
import { CapturePlayer, captureLength, formatClock, type CapturePlayerActions } from '../capture/CapturePlayer.js';
import { COMMENT_PURPLE } from '../comment-threads.js';
import { currentDevice } from '../device-session.js';
import { listCaptureShareComments, openCaptureShare, previewCaptureShare, writeCaptureShareComment } from './capture-share-client.js';
import { ShareNotice } from './ShareGreeting.js';
import { ShareRequestError } from './share-client.js';
import { shareTimeLeft } from './share-format.js';

/** `/c/<captureShareId>`: a capture share link's page. The secret is the URL's fragment, so it never reaches a server log. */
export const CAPTURE_SHARE_PAGE = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/u;
/** The name a guest last joined a share under, offered again next time (the same as live shares'). */
const NAME_KEY = 'gitspace.share.name';
const UNKNOWN = { title: 'This link doesn’t open a share', description: 'It may be mistyped or incomplete. Ask whoever sent it for the link again.' };
/** Why a capture share no longer plays, as the visitor reads it. */
const END_TEXT: Record<RuntimeBrowserCaptureShareEnd | 'gone', (sharer: string) => string> = {
  revoked: sharer => `${sharer || 'The person sharing'} stopped sharing.`,
  expired: () => 'Its time ran out.',
  gone: () => 'The capture is no longer in its workspace.',
};

type Stage =
  | { kind: 'loading' }
  | { kind: 'unavailable'; title: string; description: string }
  | { kind: 'greeting'; preview: RuntimeBrowserCaptureSharePreview; asAccount: boolean; notice: string | null }
  | { kind: 'ended'; reason: RuntimeBrowserCaptureShareEnd | 'gone' | null; sharer: string }
  | { kind: 'playing'; opened: RuntimeBrowserCaptureShareOpened };

/** A capture share link's public page (docs/APERTURE-DESIGN.md §8, §11): the greeting, then the recording's player,
 * which works with every Chrome offline. Guests watch, comment at any moment and reply; the account's owner, opening it
 * from one of the account's devices, also resolves. */
export function CaptureSharePage() {
  const captureShareId = CAPTURE_SHARE_PAGE.exec(window.location.pathname)?.[1] ?? '';
  const secret = window.location.hash.slice(1);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  useEffect(() => {
    if (!SECRET.test(secret)) { setStage({ kind: 'unavailable', ...UNKNOWN }); return; }
    let active = true;
    void Promise.all([previewCaptureShare(captureShareId, secret), currentDevice()]).then(([preview, device]) => {
      if (!active) return;
      document.title = preview.ended ? 'Share ended · GitSpace' : `${preview.capture.name} · capture from ${preview.sharer}`;
      setStage(preview.ended ? { kind: 'ended', reason: preview.ended, sharer: preview.sharer } : { kind: 'greeting', preview, asAccount: device !== null, notice: null });
    }, (cause: unknown) => {
      if (!active) return;
      setStage(cause instanceof ShareRequestError && cause.code === 'CAPTURE_SHARE_UNKNOWN'
        ? { kind: 'unavailable', ...UNKNOWN }
        : { kind: 'unavailable', title: 'The share didn’t load', description: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { active = false; };
  }, [captureShareId, secret]);

  if (stage.kind === 'loading') return <div className="flex h-dvh items-center justify-center bg-surface-2"><ThinkingIndicator aria-label="Opening the share" /></div>;
  if (stage.kind === 'unavailable') return <ShareNotice title={stage.title}>{stage.description}</ShareNotice>;
  if (stage.kind === 'ended') {
    return <ShareNotice title="This share has ended">
      {stage.reason ? END_TEXT[stage.reason](stage.sharer) : `${stage.sharer || 'The person sharing'} stopped sharing or the time ran out.`} Ask {stage.sharer || 'whoever sent it'} for a new link.
    </ShareNotice>;
  }
  if (stage.kind === 'playing') return <CaptureShareViewer captureShareId={captureShareId} opened={stage.opened} onEnded={reason => setStage({ kind: 'ended', reason, sharer: stage.opened.sharer })} />;
  const { preview, asAccount, notice } = stage;
  let remembered = '';
  try { remembered = window.localStorage.getItem(NAME_KEY) ?? ''; } catch { /* private mode */ }
  const openShare = async (typed: string): Promise<string | null> => {
    // Opened device-signed, the server names the viewer after the account; the name sent is only its fallback.
    const name = asAccount ? (remembered || preview.sharer || 'Owner').slice(0, 60) : typed;
    try {
      const opened = await openCaptureShare(captureShareId, secret, name, asAccount);
      if (!asAccount) { try { window.localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ } }
      setStage({ kind: 'playing', opened });
      return null;
    } catch (cause) {
      if (!(cause instanceof ShareRequestError)) return cause instanceof Error ? cause.message : String(cause);
      if (cause.code === 'CAPTURE_SHARE_ENDED') { setStage({ kind: 'ended', reason: null, sharer: preview.sharer }); return null; }
      if (cause.code === 'CAPTURE_SHARE_GONE') { setStage({ kind: 'ended', reason: 'gone', sharer: preview.sharer }); return null; }
      if (cause.code === 'CAPTURE_SHARE_UNKNOWN') return 'This link no longer opens the share.';
      if (asAccount && cause.status === 401) {
        setStage({ kind: 'greeting', preview, asAccount: false, notice: `This browser couldn’t open it as ${preview.sharer}. Open it with a name instead.` });
        return null;
      }
      return cause.message;
    }
  };
  return <CaptureShareGreeting key={asAccount ? 'account' : 'guest'} preview={preview} asAccount={asAccount} initialName={remembered} notice={notice} onOpen={openShare} />;
}

/** What a visitor sees before opening a shared capture: who shares which recording, what they may do, when it ends. */
function CaptureShareGreeting({ preview, asAccount, initialName, notice, onOpen }: { preview: RuntimeBrowserCaptureSharePreview; asAccount: boolean; initialName: string; notice: string | null; onOpen(name: string): Promise<string | null> }) {
  const [name, setName] = useState(initialName);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const sharer = preview.sharer || 'Someone';
  const ready = asAccount || name.trim().length > 0;
  const { capture } = preview;
  const where = capture.page.url.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || opening) return;
    setOpening(true);
    setError(null);
    const failure = await onOpen(name.trim());
    if (failure !== null) { setError(failure); setOpening(false); }
  };
  return <main className="flex h-dvh overflow-y-auto bg-surface-2 px-4 py-8 sm:items-center sm:justify-center">
    <form onSubmit={event => { void submit(event); }} className="mx-auto flex h-fit w-full max-w-[420px] flex-col gap-5 rounded-2xl border border-border bg-surface-1 p-7 shadow-xl">
      <div className="flex items-center gap-2.5"><img src="/favicon.png" alt="" width={28} height={28} className="rounded-lg" /><span className="text-body font-semibold text-foreground">GitSpace</span></div>
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold tracking-tight text-foreground">{sharer} shared a capture with you</h1>
        <p className="text-body text-muted-foreground">A recording of a browsing session{capture.comments || preview.comment ? ', with comments' : ''}. {sharer}&apos;s browser doesn&apos;t need to be on.</p>
      </header>
      <section aria-label="Shared capture" className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface-2 p-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: COMMENT_PURPLE }}><MessagePlusSquare width={16} height={16} /></span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body font-medium text-foreground">{capture.name}</span>
          <span className="truncate text-caption text-muted-foreground">{[where, ...(capture.durationMs ? [formatClock(capture.durationMs)] : []), `${capture.comments} ${capture.comments === 1 ? 'comment' : 'comments'}`].join(' · ')}</span>
        </div>
      </section>
      <ul aria-label="What you can do" className="flex flex-col gap-1.5 text-body text-foreground">
        <li>✓ Watch the whole session and scrub through it</li>
        {preview.comment ? <li>✓ Reply, and comment at any moment on anything</li> : <li className="text-muted-foreground">✕ Comment: this capture is shared view only</li>}
        <li className="text-muted-foreground">✕ The live page: this is a recording</li>
      </ul>
      {asAccount
        ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-caption text-foreground">Opening as <strong>{sharer}</strong> (signed in to GitSpace)</p>
        : <InputGroup className="w-full"><InputField index={0} label="Your name" value={name} onChange={setName} placeholder="Shown on your comments" maxLength={60} autoComplete="name" disabled={opening} /></InputGroup>}
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={!ready || opening}>{opening ? 'Opening…' : 'Open'}</Button>
      <p className="text-caption text-muted-foreground">Contains a recording of everything visible in the tab during the session. Ends in {shareTimeLeft(preview.expiresAt, Date.now())} or when {sharer} stops sharing.</p>
    </form>
  </main>;
}

/** The recording's player for someone with the link: threads from the open, each change saved through the share, and
 * read again when the page shows again. */
function CaptureShareViewer({ captureShareId, opened, onEnded }: { captureShareId: string; opened: RuntimeBrowserCaptureShareOpened; onEnded(reason: RuntimeBrowserCaptureShareEnd | null): void }) {
  const [threads, setThreads] = useState<readonly RuntimeBrowserCommentThread[]>(opened.threads);
  const [notice, setNotice] = useState<string | null>(null);
  const { capture, token } = opened;
  /** A refusal that ends the share ends the page; the rest are said where they happened. */
  const refused = (cause: unknown): Error => {
    if (cause instanceof ShareRequestError && cause.code === 'CAPTURE_SHARE_ENDED') onEnded(null);
    if (cause instanceof ShareRequestError && cause.code === 'CAPTURE_SHARE_TOKEN') return new Error('This page was open too long: reload it to comment again.');
    return cause instanceof Error ? cause : new Error(String(cause));
  };
  const keep = (thread: RuntimeBrowserCommentThread) => setThreads(previous => [...previous.filter(other => other.root.id !== thread.root.id), thread]);
  useEffect(() => {
    // Others comment too; their threads arrive when the page shows again.
    const shown = () => {
      if (document.visibilityState !== 'visible') return;
      void listCaptureShareComments(captureShareId, token).then(setThreads, (cause: unknown) => setNotice(refused(cause).message));
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  });
  const actions: CapturePlayerActions = {
    comment: async input => {
      try { keep(await writeCaptureShareComment(captureShareId, { op: 'comment', token, atMs: input.atMs, page: input.page, anchor: input.anchor, text: input.text })); } catch (cause) { throw refused(cause); }
    },
    reply: async (threadId, text) => {
      try { keep(await writeCaptureShareComment(captureShareId, { op: 'reply', token, threadId, text })); } catch (cause) { throw refused(cause); }
    },
    resolve: async (threadId, reopen) => {
      try { keep(await writeCaptureShareComment(captureShareId, { op: 'resolve', token, threadId, ...(reopen ? { reopen } : {}) })); } catch (cause) { throw refused(cause); }
    },
  };
  const length = captureLength(capture);
  return <main className="flex min-h-dvh flex-col items-center gap-3 overflow-y-auto bg-surface-2 px-3 py-4 sm:px-6 sm:py-8">
    {notice ? <p role="alert" className="w-full max-w-[1040px] text-caption text-destructive">{notice}</p> : null}
    <div className="w-full max-w-[1040px] shadow-xl">
      <CapturePlayer
        capture={capture} files={opened.files} threads={threads} as={opened.guest ? `${opened.name} (guest)` : opened.name} canComment={opened.comment} canResolve={!opened.guest} actions={actions}
        header={<>
          <img src="/favicon.png" alt="" width={20} height={20} className="shrink-0 rounded-md" />
          <h1 className="min-w-0 flex-1 truncate text-caption font-normal"><strong>{capture.name}</strong> · capture from {opened.sharer}{length ? ` · ${formatClock(length)}` : ''} · whole recording</h1>
          <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted-foreground max-sm:hidden">{opened.sharer}&apos;s Chrome can be off · recording</span>
        </>}
      />
    </div>
    <p className="w-full max-w-[1040px] text-caption text-muted-foreground">A recording of everything visible in the tab during the session. {opened.comment ? 'Pause anywhere and use Comment to point at something as it was then; ' : ''}{opened.comment ? `${opened.sharer} sees your comments in their workspace.` : ''} Ends in {shareTimeLeft(opened.shareExpiresAt, Date.now())}.</p>
  </main>;
}
