// A Mermaid diagram from a ```mermaid fence, drawn by Mermaid (strict security: no scripts, no HTML labels) in the
// page's scheme and drawn again when the scheme changes. It opens in the lightbox at its natural size to pan and zoom;
// beside the expand button, its source copies and its drawing downloads as SVG.
import { Button } from '@gitspace/ui';
import type { MermaidConfig } from '@streamdown/mermaid';
import { Copy01, Download01 } from '@untitledui/icons';
import { useEffect, useId, useState } from 'react';
import type { CustomRendererProps } from 'streamdown';
import { useDarkScheme } from '../appearance.js';
import { Lightbox } from '../Lightbox.js';
import { BlockErrorCard, BlockPlaceholder } from './BlockFrames.js';

const LIGHT: MermaidConfig = { theme: 'neutral' };
const DARK: MermaidConfig = { theme: 'dark' };

let renders = 0;

type Drawn = { svg: string; width: number; height: number } | { error: string };

/** The drawing's size, from the viewBox Mermaid gives every diagram. */
function measured(svg: string): { width: number; height: number } {
  const box = /viewBox="[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)"/u.exec(svg);
  return { width: Number(box?.[1] ?? 0), height: Number(box?.[2] ?? 0) };
}

function MermaidDiagram({ source }: { source: string }) {
  const dark = useDarkScheme();
  const id = useId().replace(/[^A-Za-z0-9_-]/gu, '');
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      // Mermaid is loaded on the first diagram, so pages without one do not load it.
      const { mermaid } = await import('@streamdown/mermaid');
      renders += 1;
      const next: Drawn = await mermaid.getMermaid(dark ? DARK : LIGHT).render(`mermaid-${id}-${renders}`, source)
        .then(({ svg }) => ({ svg, ...measured(svg) }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      if (active) setDrawn(next);
    })();
    return () => { active = false; };
  }, [source, dark, id]);
  if (drawn === null) return <BlockPlaceholder />;
  if ('error' in drawn) return <BlockErrorCard issues={[{ path: '', message: `the Mermaid diagram could not be drawn: ${drawn.error}` }]} source={source} sourceLabel="Mermaid" />;
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([drawn.svg], { type: 'image/svg+xml' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'diagram.svg' });
    link.click();
    URL.revokeObjectURL(url);
  };
  return <Lightbox label="Mermaid diagram" mode="zoom" className="my-2"
    actions={<>
      <Button variant="secondary" size="icon-compact" type="button" aria-label="Copy the Mermaid source" onClick={() => { void navigator.clipboard.writeText(source); }}><Copy01 width={14} height={14} /></Button>
      <Button variant="secondary" size="icon-compact" type="button" aria-label="Download the diagram as SVG" onClick={download}><Download01 width={14} height={14} /></Button>
    </>}
    expanded={<div role="img" aria-label="Mermaid diagram" className="[&>svg]:!h-full [&>svg]:!w-full [&>svg]:!max-w-none" style={{ width: drawn.width, height: drawn.height }} dangerouslySetInnerHTML={{ __html: drawn.svg }} />}>
    <div data-gitspace-block="mermaid" role="img" aria-label="Mermaid diagram" className="flex justify-center [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
  </Lightbox>;
}

/** The body of a ```mermaid fence: a quiet placeholder while it streams, then the diagram. */
export function MermaidFence({ code, isIncomplete }: CustomRendererProps) {
  if (isIncomplete) return <BlockPlaceholder />;
  return <MermaidDiagram source={code} />;
}
