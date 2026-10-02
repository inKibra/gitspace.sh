import { GitSpaceMarkdownRenderer } from './GitSpaceMarkdownRenderer.js';
import { ResourceLinkSurface } from './ResourceNavigation.js';
import type { MarkdownImageResolver } from './markdown-artifact-images.js';

export interface GitSpaceMarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
  /** Artifact previews resolve images that name other artifacts to object URLs. */
  resolveImage?: MarkdownImageResolver;
}

export function GitSpaceMarkdown(props: GitSpaceMarkdownProps) {
  return <ResourceLinkSurface><GitSpaceMarkdownRenderer {...props} /></ResourceLinkSurface>;
}
