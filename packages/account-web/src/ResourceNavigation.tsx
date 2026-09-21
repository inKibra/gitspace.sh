import { createContext, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import { resourceLinkHref, resourceUriFromHref } from '@gitspace/protocol/resource-uri';

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

/** Rewrites only parsed anchors, before sanitization. Code samples and image URLs are untouched. */
export function rehypeResourceLinks() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
        const href = resourceLinkHref(node.properties.href);
        if (href) node.properties.href = href;
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
