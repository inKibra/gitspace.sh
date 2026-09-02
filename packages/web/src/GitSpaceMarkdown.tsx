import { GitSpaceMarkdownRenderer } from './GitSpaceMarkdownRenderer.js';

export interface GitSpaceMarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
}

export function GitSpaceMarkdown(props: GitSpaceMarkdownProps) {
  return <GitSpaceMarkdownRenderer {...props} />;
}
