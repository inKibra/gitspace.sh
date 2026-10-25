import { BROWSER_SHARE_VIEWERS } from '@gitspace/protocol-runtime';
import type { RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';
import { ThinkingIndicator } from '@gitspace/ui';
import { useEffect, useState } from 'react';
import { currentDevice } from '../device-session.js';
import { ShareGreeting, ShareNotice } from './ShareGreeting.js';
import { ShareViewer } from './ShareViewer.js';
import { joinShare, previewShare, ShareRequestError } from './share-client.js';
import type { ShareJoined } from './share-client.js';
import { SHARE_END_TEXT } from './share-format.js';
import type { ShareEnd } from './share-format.js';

/** `/s/<shareId>`: a share link's page. The secret is the URL's fragment, so it never reaches a server log. */
export const SHARE_PAGE = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/u;
/** The name a guest last joined a share under, offered again next time. */
const NAME_KEY = 'gitspace.share.name';

type Stage =
  | { kind: 'loading' }
  | { kind: 'unavailable'; title: string; description: string }
  | { kind: 'greeting'; preview: RuntimeBrowserSharePreview; asAccount: boolean; notice: string | null }
  | { kind: 'ended'; reason: ShareEnd | null; sharer: string }
  | { kind: 'viewing'; preview: RuntimeBrowserSharePreview; joined: ShareJoined; name: string; signed: boolean };

const UNKNOWN = { title: 'This link doesn’t open a share', description: 'It may be mistyped or incomplete. Ask whoever sent it for the link again.' };

/** A share link's public page: the greeting, then the live tab once the visitor joins. */
export function SharePage() {
  const shareId = SHARE_PAGE.exec(window.location.pathname)?.[1] ?? '';
  const secret = window.location.hash.slice(1);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  useEffect(() => {
    if (!SECRET.test(secret)) { setStage({ kind: 'unavailable', ...UNKNOWN }); return; }
    let active = true;
    void Promise.all([previewShare(shareId, secret, false), currentDevice()]).then(([preview, device]) => {
      if (!active) return;
      document.title = preview.ended ? 'Share ended · GitSpace' : `${preview.page.title || preview.page.site} · shared by ${preview.sharer}`;
      setStage(preview.ended ? { kind: 'ended', reason: preview.ended, sharer: preview.sharer } : { kind: 'greeting', preview, asAccount: device !== null, notice: null });
    }, (cause: unknown) => {
      if (!active) return;
      setStage(cause instanceof ShareRequestError && cause.code === 'SHARE_UNKNOWN'
        ? { kind: 'unavailable', ...UNKNOWN }
        : { kind: 'unavailable', title: 'The share didn’t load', description: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { active = false; };
  }, [shareId, secret]);

  if (stage.kind === 'loading') return <div className="flex h-dvh items-center justify-center bg-surface-2"><ThinkingIndicator aria-label="Opening the share" /></div>;
  if (stage.kind === 'unavailable') return <ShareNotice title={stage.title}>{stage.description}</ShareNotice>;
  if (stage.kind === 'ended') {
    return <ShareNotice title="This share has ended">
      {stage.reason ? SHARE_END_TEXT[stage.reason](stage.sharer) : `${stage.sharer || 'The person sharing'} stopped sharing, the time ran out, or the tab was closed.`} Ask {stage.sharer || 'whoever sent it'} for a new link.
    </ShareNotice>;
  }
  if (stage.kind === 'viewing') {
    const { preview } = stage;
    return <ShareViewer
      shareId={shareId} secret={secret} preview={preview} joined={stage.joined} name={stage.name} signed={stage.signed}
      onEnded={reason => setStage({ kind: 'ended', reason, sharer: preview.sharer })}
    />;
  }
  const { preview, asAccount, notice } = stage;
  let remembered = '';
  try { remembered = window.localStorage.getItem(NAME_KEY) ?? ''; } catch { /* private mode */ }
  const join = async (typed: string): Promise<string | null> => {
    // Joined device-signed, the server names the viewer after the account; the name sent is only its fallback.
    const name = asAccount ? (remembered || preview.sharer || 'Owner').slice(0, 60) : typed;
    try {
      const joined = await joinShare(shareId, secret, name, asAccount);
      if (!asAccount) { try { window.localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ } }
      setStage({ kind: 'viewing', preview, joined, name, signed: asAccount });
      return null;
    } catch (cause) {
      if (!(cause instanceof ShareRequestError)) return cause instanceof Error ? cause.message : String(cause);
      if (cause.code === 'SHARE_ENDED') { setStage({ kind: 'ended', reason: null, sharer: preview.sharer }); return null; }
      if (cause.code === 'SHARE_FULL') return `${BROWSER_SHARE_VIEWERS} people are already watching. Try again when someone leaves.`;
      if (cause.code === 'SHARE_UNKNOWN') return 'This link no longer opens the share.';
      if (asAccount && cause.status === 401) {
        setStage({ kind: 'greeting', preview, asAccount: false, notice: `This browser couldn’t join as ${preview.sharer}. Join with a name instead.` });
        return null;
      }
      return cause.message;
    }
  };
  return <ShareGreeting key={asAccount ? 'account' : 'guest'} preview={preview} asAccount={asAccount} initialName={remembered} notice={notice} onJoin={join} />;
}
