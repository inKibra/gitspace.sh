import { GitSpaceMarkdownRenderer } from './GitSpaceMarkdownRenderer.js';
import { ResourceLinkSurface } from './ResourceNavigation.js';

export interface GitSpaceMarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
}

export function GitSpaceMarkdown(props: GitSpaceMarkdownProps) {
  return <ResourceLinkSurface><GitSpaceMarkdownRenderer {...props} /></ResourceLinkSurface>;
}
