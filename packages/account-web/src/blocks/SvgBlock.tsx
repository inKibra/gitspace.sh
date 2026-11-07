// An agent's SVG drawing. It is parsed and checked with the validator GitSpace stores it with (one <svg>, allowlisted
// elements, no comments, scripts, handlers or external references), and only a drawing that passes is drawn: from the
// parsed tree, element by element, so the source string never reaches the HTML parser. Its colours are currentColor and
// theme variables, so it follows the page's light or dark scheme.
import { parseSvg, SVG_ELEMENTS, type SvgElementNode } from '@gitspace/protocol/gitspace-ui';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { BlockErrorCard } from './BlockFrames.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

export function SvgBlock({ svg }: { svg: string }) {
  const parsed = useMemo(() => parseSvg(svg), [svg]);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null || parsed.root === null || parsed.issues.length > 0) return;
    element.replaceChildren(drawSvg(element.ownerDocument, parsed.root));
    return () => element.replaceChildren();
  }, [parsed]);
  if (parsed.root === null || parsed.issues.length > 0) return <BlockErrorCard issues={parsed.issues} source={svg} sourceLabel="SVG" />;
  return <div ref={host} data-gitspace-block="svg" className="my-2 overflow-x-auto text-foreground [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-[640px]" />;
}

/**
 * Creates the checked tree as SVG elements: allowlisted elements only, text as text nodes, and attributes set by name,
 * skipping event handlers, namespace declarations and prefixes other than xlink:href and xml:.
 */
function drawSvg(document: Document, node: SvgElementNode): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, node.name);
  for (const [name, value] of node.attributes) {
    if (/^on/i.test(name) || name.startsWith('xmlns')) continue;
    if (name === 'xlink:href') element.setAttributeNS(XLINK_NAMESPACE, name, value);
    else if (name.startsWith('xml:')) element.setAttributeNS(XML_NAMESPACE, name, value);
    else if (!name.includes(':')) element.setAttribute(name, value);
  }
  for (const child of node.children) {
    if (typeof child === 'string') element.append(document.createTextNode(child));
    else if (SVG_ELEMENTS.has(child.name)) element.append(drawSvg(document, child));
  }
  return element;
}
