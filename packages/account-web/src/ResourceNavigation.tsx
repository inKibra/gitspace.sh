import { createContext, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import { resolveResourceReference, resourceLinkHref, resourceUriFromHref } from '@gitspace/protocol/resource-uri';

export interface ResourceRequest { uri: string }
export const ResourceNavigation = createContext<((request: ResourceRequest) => void) | null>(null);

/** Capture before Streamdown's external-link confirmation; internal links never leave this workspace. */
export function ResourceLinkSurface({ children }: { children: ReactNode }) {
  const open = useContext(ResourceNavigation);
  const [error, setError] = useState<string | null>(null);
  const navigate = (event: MouseEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a');
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute('href');
    const uri = href ? resourceUriFromHref(href) : null;
    if (!uri) return;
    event.preventDefault();
    event.stopPropagation();
    if (!open) { setError('Open this resource from its workspace transcript or Inspector.'); return; }
    setError(null);
    open({ uri });
  };
  return <div className="contents" onClickCapture={navigate} onAuxClickCapture={navigate}>
    {children}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </div>;
}

export function ResourceLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const internal = resourceLinkHref(href);
  const safeExternal = /^(?:https?:\/\/|mailto:)/iu.test(href) && !/[\u0000-\u0020\u007f]/u.test(href);
  if (!internal && !safeExternal) return <span className={className}>{children}</span>;
  return <ResourceLinkSurface><a className={className} href={internal ?? href} {...(safeExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a></ResourceLinkSurface>;
}

/** Internal resources bypass only Streamdown's external-link confirmation renderer. */
export function MarkdownResourceLink({ href, children }: Record<string, unknown> & { href?: string; children?: ReactNode }) {
  return href && resourceUriFromHref(href) ? <a href={href}>{children}</a> : <span>{children}</span>;
}

interface MarkdownNode {
  type: string;
  tagName?: string;
  properties?: { href?: unknown };
  children?: MarkdownNode[];
}

/** Rewrites only parsed anchors, before sanitization: a resource address, or a path relative to the document at
 * `documentUri`, becomes an internal link. One that names no resource (a relative path in a message, which has no
 * folder; a folder's address, which has no view) stays as its text rather than a blocked link. Code samples and image
 * URLs are untouched. Give it as `[rehypeResourceLinks, { documentUri }]`: Streamdown caches a processor by each
 * plugin's name and options. */
export function rehypeResourceLinks({ documentUri }: { documentUri?: string } = {}) {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      if (node.tagName === 'a' && node.properties && typeof node.properties.href === 'string') {
        const href = node.properties.href;
        const uri = resolveResourceReference(href, documentUri);
        if (uri) node.properties.href = resourceLinkHref(uri) ?? href;
        else if (/^(?:drive|repo|artifact|browser-artifact):/iu.test(href) || (!/^[a-z][a-z0-9+.-]*:/iu.test(href) && !href.startsWith('/') && !href.startsWith('#'))) { node.tagName = 'span'; node.properties = {}; }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** Select the internal renderer only after the ordinary sanitizer and URL hardener run. */
export function rehypeResourceAnchors() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      if (node.tagName === 'a' && typeof node.properties?.href === 'string' && resourceUriFromHref(node.properties.href)) {
        node.tagName = 'gitspace-resource';
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
