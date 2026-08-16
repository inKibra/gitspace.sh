import { useEffect, useRef, useState, type ReactElement } from 'react';
import mermaid from 'mermaid';

/**
 * Registry-free Mermaid diagram component. Extracted so both the `mermaid` block
 * renderer AND the markdown fence path (```mermaid) can render diagrams without a
 * markdown ⇄ registry import cycle (registry.web imports Markdown).
 */

let initialized = false;
let seq = 0;

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
    flowchart: { curve: 'basis' },
    themeVariables: {
      darkMode: true,
      background: '#000000',
      mainBkg: '#0a0a0a',
      primaryColor: '#0a0a0a',
      primaryBorderColor: '#444444',
      primaryTextColor: '#d4d4d4',
      lineColor: '#777777',
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: '12px',
    },
  });
}

export function MermaidDiagram({ code, title }: { code: string; title?: string }): ReactElement {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${seq++}`);
  useEffect(() => {
    let alive = true;
    ensureInit();
    mermaid
      .render(idRef.current, code)
      .then((result) => {
        if (alive) {
          setSvg(result.svg);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [code]);
  return (
    <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] p-2">
      {title && <div className="mb-1 text-[11px] text-[var(--gs-text-dim)]">{title}</div>}
      {error
        ? <div className="text-[11px] text-[var(--gs-danger)] font-[family-name:var(--gs-font)]">mermaid error: {error}</div>
        : <div dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  );
}
