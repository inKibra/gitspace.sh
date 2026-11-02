import { GitSpaceMarkdownRenderer } from './GitSpaceMarkdownRenderer.js';
import { ResourceLinkSurface } from './ResourceNavigation.js';

export interface GitSpaceMarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
  /** The address of the drive or repository file this Markdown is: its relative links and images name files beside it. */
  documentUri?: string;
}

export function GitSpaceMarkdown(props: GitSpaceMarkdownProps) {
  return <ResourceLinkSurface><GitSpaceMarkdownRenderer {...props} /></ResourceLinkSurface>;
}
