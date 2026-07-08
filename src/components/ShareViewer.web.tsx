/** @jsxImportSource react */
/**
 * ShareViewer — the recipient side of a signed share link, rendered with the
 * PRODUCT'S OWN renderers (docs/ARTIFACT-PROTOCOL.md Q3).
 *
 * The relay serves this SPA for browser navigations to /artifact-share/<t>;
 * bytes come back through the same URL with ?raw=1 (and ?path= for renderer
 * dependencies — dashboard apps/data, guide evidence — which the daemon
 * validates against the capability's scope). No identity, no handshake: the
 * token in the URL IS the authorization, so this surface renders only what
 * the link's capability can read.
 *
 * User content NEVER becomes document HTML here: markdown goes through
 * renderMarkdownHtml (escaping renderer), mini-apps run in sandboxed iframes
 * (allow-scripts only), everything else renders as data (img/video/pre).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { ArtifactPreviewContent, MiniAppRun, type ArtifactRead } from './ArtifactPanel.web.js';
import { parseArtifactCapUnverified } from '../core/artifact-cap.js';
import { DashboardPanel } from './DashboardPanel.web.js';
import { GuideShareView } from './GuideShareView.web.js';

interface ShareMeta {
  relPath: string;
  fileName: string;
  pinnedCommit?: string;
  expiresAt?: number;
}

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function ShareViewer({ token, rawBase }: {
  /** The share token from the URL path (still URL-encoded). */
  token: string;
  /** Origin serving the raw bytes — same origin in hosted; the relay origin in dev. */
  rawBase: string;
}): ReactElement {
  const [state, setState] = useState<'loading' | 'gone' | 'ready'>('loading');
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [data, setData] = useState<ArtifactRead | null>(null);

  const rawUrl = (subPath?: string): string =>
    `${rawBase}/artifact-share/${token}?raw=1${subPath ? `&path=${encodeURIComponent(subPath)}` : ''}`;

  const subRead = async (path: string): Promise<ArtifactRead> => {
    const res = await fetch(rawUrl(path));
    if (!res.ok) throw new Error(`sub-read ${path}: ${res.status}`);
    const buf = await res.arrayBuffer();
    return { base64: bytesToBase64(buf), size: buf.byteLength, truncated: false };
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(rawUrl());
        if (!res.ok) { if (alive) setState('gone'); return; }
        const buf = await res.arrayBuffer();
        if (!alive) return;
        const relPath = res.headers.get('X-Gssh-Rel-Path') ?? 'artifact';
        const expires = res.headers.get('X-Gssh-Expires-At');
        setMeta({
          relPath,
          fileName: relPath.split('/').pop() ?? 'artifact',
          pinnedCommit: res.headers.get('X-Gssh-Pinned-Commit') ?? undefined,
          expiresAt: expires ? Number(expires) : undefined,
        });
        setData({ base64: bytesToBase64(buf), size: buf.byteLength, truncated: false });
        setState('ready');
      } catch {
        if (alive) setState('gone');
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, rawBase]);

  const body = (): ReactElement => {
    if (state === 'loading') return <div className="p-8 text-[12px] text-[var(--gs-text-dim)]">loading…</div>;
    if (state === 'gone' || !meta || !data) {
      // The server is deliberately oracle-free (404 for expired = revoked =
      // never existed). But the token itself is client-decodable — when THIS
      // link's own stamp says it expired, we can say so without asking the
      // server anything. A valid-looking unexpired token that still 404s is
      // revoked-or-fake; keep that ambiguous.
      const cap = parseArtifactCapUnverified(decodeURIComponent(token));
      const expired = cap && Date.now() > cap.expiresAt;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <span className="text-[14px] text-[var(--gs-text)]">{expired ? 'This share link has expired.' : 'This share link is gone.'}</span>
          <span className="max-w-[420px] text-[12px] text-[var(--gs-text-dim)]">
            {expired
              ? `It expired ${new Date(cap.expiresAt).toLocaleString()} — ask the sender for a fresh link.`
              : 'Revoked or never existed — ask the sender for a fresh link.'}
          </span>
        </div>
      );
    }
    const rel = meta.relPath;
    if (rel.endsWith('.dashboard.json')) {
      return (
        <div className="h-full overflow-y-auto p-4">
          <DashboardPanel dashboardPath={rel} scopeLabel="shared" read={subRead} />
        </div>
      );
    }
    if (rel.endsWith('.gssh.html')) {
      let html = '';
      try { html = new TextDecoder().decode(Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))); } catch { /* binary */ }
      return <div className="h-full p-4"><MiniAppRun html={html} read={subRead} /></div>;
    }
    if (rel === 'review/guide.json' || rel.endsWith('.guide.json')) {
      return <GuideShareView data={data} read={subRead} />;
    }
    return (
      <div className="flex h-full items-start justify-center overflow-auto p-6">
        <ArtifactPreviewContent path={rel} data={data} />
      </div>
    );
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-[var(--gs-bg)] text-[13px] text-[var(--gs-text)]">
      <header className="flex h-9 flex-none items-center gap-2 border-b border-[var(--gs-border)] bg-[#070707] px-3">
        <span className="text-[12px] font-semibold tracking-tight">GitSpace</span>
        <span className="text-[var(--gs-text-ghost)]">·</span>
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[11px] text-[var(--gs-text-muted)]">{meta?.relPath ?? 'shared artifact'}</span>
        <span className="ml-auto" />
        {meta?.pinnedCommit && (
          <span title="Point-in-time capture: this link shows the artifact as it was when shared, not its latest state." className="flex-none border border-[var(--gs-border)] px-[5px] py-px text-[10px] text-[var(--gs-text-dim)]">
            pinned @{meta.pinnedCommit.slice(0, 8)}
          </span>
        )}
        {meta?.expiresAt && (
          <span className="flex-none text-[10px] text-[var(--gs-text-ghost)]">expires {new Date(meta.expiresAt).toLocaleDateString()}</span>
        )}
      </header>
      <main className="min-h-0 flex-1">{body()}</main>
    </div>
  );
}
