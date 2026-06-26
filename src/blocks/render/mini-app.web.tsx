import { useEffect, useRef, type ReactElement } from 'react';
import type { MiniAppData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';

const DEFAULT_HEIGHT = 220;

// Renders a gitspace mini-app (.gssh.html) in a sandboxed iframe — `allow-scripts`
// only, so no same-origin access, no cookies, no reach into the host. The app's
// data artifact is handed in via postMessage after load, decoupling the app from
// the host and keeping the security boundary clean.
defineRenderer<MiniAppData>('mini-app', ({ data }): ReactElement => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const send = () => frame.contentWindow?.postMessage({ type: 'gssh:data', data: data.data }, '*');
    frame.addEventListener('load', send);
    send(); // in case load already fired
    return () => frame.removeEventListener('load', send);
  }, [data.data]);
  return (
    <div className="my-2 border border-[var(--gs-border)] overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[11px]">
        <span className="text-[var(--gs-accent)]">▦</span>
        <span className="text-[var(--gs-text)] font-[family-name:var(--gs-font)]">{data.name}</span>
        <span className="ml-auto text-[10px] text-[var(--gs-text-dim)]">sandboxed mini-app</span>
      </div>
      <iframe
        ref={frameRef}
        title={data.name}
        sandbox="allow-scripts"
        srcDoc={data.html}
        style={{ width: '100%', height: data.height ?? DEFAULT_HEIGHT, border: 0, display: 'block', background: 'var(--gs-bg)' }}
      />
    </div>
  );
});
