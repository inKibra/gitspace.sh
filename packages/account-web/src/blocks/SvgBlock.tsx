// An agent's SVG drawing. It is checked again here with the validator GitSpace stores it with (one <svg>, allowlisted
// elements, no scripts, handlers or external references), so only a drawing that passes is put in the page. Its
// colours are currentColor and theme variables, so it follows the page's light or dark scheme.
import { validateSvg } from '@gitspace/protocol/gitspace-ui';
import { useMemo } from 'react';
import { BlockErrorCard } from './BlockFrames.js';

export function SvgBlock({ svg }: { svg: string }) {
  const issues = useMemo(() => validateSvg(svg), [svg]);
  if (issues.length > 0) return <BlockErrorCard issues={issues} source={svg} sourceLabel="SVG" />;
  return <div data-gitspace-block="svg" className="my-2 overflow-x-auto text-foreground [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-[640px]" dangerouslySetInnerHTML={{ __html: svg }} />;
}
