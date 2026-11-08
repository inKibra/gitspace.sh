// An agent's SVG drawing. It is parsed and checked with the validator GitSpace stores it with (one <svg>, allowlisted
// elements, no comments, scripts, handlers or external references), and only a drawing that passes is drawn: from the
// parsed tree, element by element, so the source string never reaches the HTML parser. Its colours are currentColor and
// theme variables, so it follows the page's light or dark scheme. It opens in the lightbox at its natural size.
import { parseSvg, SVG_ELEMENTS, type SvgElementNode } from '@gitspace/protocol/gitspace-ui';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Lightbox } from '../Lightbox.js';
import { BlockErrorCard } from './BlockFrames.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
/** The size a drawing with neither a viewBox nor a width and height is shown at full-screen. */
const UNSIZED = { width: 640, height: 360 };

/** The drawing's own size: its viewBox, else its width and height. */
function naturalSize(root: SvgElementNode): { width: number; height: number } {
  const attributes = new Map(root.attributes);
  const [, , boxWidth = 0, boxHeight = 0] = attributes.get('viewBox')?.trim().split(/[\s,]+/u).map(Number) ?? [];
  if (boxWidth > 0 && boxHeight > 0) return { width: boxWidth, height: boxHeight };
  const width = Number.parseFloat(attributes.get('width') ?? '');
  const height = Number.parseFloat(attributes.get('height') ?? '');
  return width > 0 && height > 0 ? { width, height } : UNSIZED;
}

/** The checked tree drawn into a host element; `size` sets the drawing's size, else it fits the width. */
function SvgDrawing({ root, size }: { root: SvgElementNode; size?: { width: number; height: number } }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    element.replaceChildren(drawSvg(element.ownerDocument, root));
    return () => element.replaceChildren();
  }, [root]);
  if (size) return <div ref={host} className="text-foreground [&>svg]:block [&>svg]:!h-full [&>svg]:!w-full" style={size} />;
  return <div ref={host} data-gitspace-block="svg" className="overflow-x-auto text-foreground [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-[640px]" />;
}

export function SvgBlock({ svg }: { svg: string }) {
  const parsed = useMemo(() => parseSvg(svg), [svg]);
  if (parsed.root === null || parsed.issues.length > 0) return <BlockErrorCard issues={parsed.issues} source={svg} sourceLabel="SVG" />;
  const title = parsed.root.children.find((child) => typeof child !== 'string' && child.name === 'title');
  const label = title && typeof title !== 'string' ? title.children.filter((child) => typeof child === 'string').join('').trim() : '';
  return <Lightbox label={label || 'Drawing'} mode="zoom" className="my-2" expanded={<SvgDrawing root={parsed.root} size={naturalSize(parsed.root)} />}>
    <SvgDrawing root={parsed.root} />
  </Lightbox>;
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
