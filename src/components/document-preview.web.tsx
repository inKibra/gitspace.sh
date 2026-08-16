/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactElement } from 'react';

/**
 * Document renderers shared by the repo view and the artifacts viewer.
 *
 * Both surfaces hold the same kind of bytes and had the same need: an .html file
 * should be readable AS A PAGE and a .pdf should be readable AS A DOCUMENT,
 * rather than as a wall of source or a "binary — no preview" dead end. The
 * artifacts panel already rendered HTML this way; pulling that shape here means
 * the repo view inherits it instead of growing a second copy, and PDFs land in
 * both places at once.
 *
 * Everything here is UNTRUSTED content — repo HTML is whatever happens to be
 * checked in, which includes anything an agent wrote. So it renders inside an
 * iframe with NO same-origin privilege: the document cannot reach this app's
 * DOM, its storage, or its session. That is the whole reason these are
 * components and not a dangerouslySetInnerHTML call.
 */

/** Extensions this module can render as documents rather than as text. */
export function documentKindFor(path: string): 'html' | 'pdf' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

/**
 * An HTML file rendered as a web page.
 *
 * `sandbox="allow-scripts"` WITHOUT allow-same-origin: scripts run, so a page
 * that builds itself at runtime still displays, but the frame is a unique
 * opaque origin and cannot touch the host app. Those two tokens together would
 * defeat the sandbox entirely, which is why only one is set.
 */
export function HtmlDocFrame({ html, title }: { html: string; title: string }): ReactElement {
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      srcDoc={html}
      className="h-full min-h-0 w-full flex-1 border-0"
      // Unstyled documents assume a light page; without this they render as
      // black-on-black over the app's dark shell.
      style={{ background: '#fff' }}
    />
  );
}

/**
 * A PDF opened in the browser's own viewer.
 *
 * DELIBERATELY NOT EMBEDDED INLINE. Both `<iframe src=blob>` and
 * `<object data=blob type=application/pdf>` were tried against the running app
 * and both did the same thing: the moment the PDF mounted, the TOP-LEVEL page
 * navigated to about:blank and the whole workspace was gone. Not a new tab —
 * the app's own tab, unloaded, with the reviewer's dock layout and any open
 * composer with it. `navigator.pdfViewerEnabled` reported true throughout, so
 * there is no capability flag to gate on.
 *
 * Losing the app to a stray click on a .pdf in the file tree is far worse than
 * one extra click to read it, so the document opens in a separate tab where the
 * browser's viewer can have it. Rendering PDFs truly inline needs pdf.js
 * bundled locally (the CSP rules out a CDN) — a dependency decision, not
 * something to smuggle in behind a file preview.
 *
 * The bytes go through a blob: URL rather than data: — a base64 data URL of a
 * multi-megabyte PDF is a multi-megabyte string, which browsers refuse to
 * navigate to. The object URL is revoked on unmount, so paging through a tree
 * does not leak a blob per file.
 */
export function PdfDocFrame({ base64, title }: { base64: string; title: string }): ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    let objectUrl: string | null = null;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      setUrl(objectUrl);
    } catch {
      setFailed(true);
    }
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [base64]);

  if (failed) return <div className="p-3 text-[11px] text-[var(--gs-danger)]">Could not decode {title}.</div>;
  if (!url) return <div className="p-3 text-[11px] text-[var(--gs-text-dim)]">Preparing document…</div>;

  const fileName = title.split('/').pop() ?? 'document.pdf';
  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-[28px] leading-none text-[var(--gs-text-dim)]">▤</div>
      <div className="font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{fileName}</div>
      <div className="max-w-[380px] text-[11px] text-[var(--gs-text-dim)]">
        PDFs open in a separate tab so the browser’s viewer can render them.
      </div>
      <div className="flex gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="border border-[var(--gs-border)] px-2.5 py-1 text-[11px] text-[var(--gs-accent)] hover:border-[var(--gs-accent)]"
        >
          ↗ Open document
        </a>
        <a
          href={url}
          download={fileName}
          className="border border-[var(--gs-border)] px-2.5 py-1 text-[11px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
        >
          ↓ Download
        </a>
      </div>
    </div>
  );
}

/** Decode base64 → text for the source view of a document file. */
export function useDecodedText(base64: string | null): string | null {
  return useMemo(() => {
    if (base64 === null) return null;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return null;
    }
  }, [base64]);
}
