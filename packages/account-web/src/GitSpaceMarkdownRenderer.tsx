import { harden } from 'rehype-harden';
import { Streamdown, defaultRehypePlugins } from 'streamdown';
import type { Components, PluginConfig } from 'streamdown';
import 'streamdown/styles.css';
import { useEffect, useState } from 'react';
import type { GitSpaceMarkdownProps } from './GitSpaceMarkdown.js';
import { BLOCK_RENDERERS } from './blocks/MarkdownBlocks.js';
import { rehypeResourceAnchors, rehypeResourceLinks } from './ResourceNavigation.js';
import { MarkdownResourceAnchor, MarkdownResourceMedia, rehypeResourceAddresses, rehypeResourceMedia, rehypeResourceMediaMarkers } from './resource-media.js';

const RESOURCE_COMPONENTS = { 'gitspace-resource': MarkdownResourceAnchor, 'gitspace-media': MarkdownResourceMedia } satisfies Components;

// Prose typography lives on the wrapper as Tailwind utilities over Fluid
// tokens; streamdown's own stylesheet handles block layout, and the theme
// already styles inline `code`. Streamdown frames its code action bars with a
// `sidebar` colour the theme does not define (the border falls back to the text
// colour); they show as plain icon buttons instead.
const PROSE = 'min-w-0 max-w-full text-body text-foreground [overflow-wrap:anywhere] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:tracking-tight [&_h1]:text-display [&_h2]:text-title [&_h3]:text-subtitle [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_pre]:bg-surface-2 [&_pre]:whitespace-pre [&_pre]:[overflow-wrap:normal] [&_[data-streamdown=code-block]]:min-w-0 [&_[data-streamdown=code-block]]:max-w-full [&_[data-streamdown=code-block-body]]:min-w-0 [&_[data-streamdown=code-block-body]]:max-w-full [&_[data-streamdown=code-block-actions]]:border-transparent [&_[data-streamdown=code-block-actions]]:bg-transparent [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_[data-streamdown=table-wrapper]]:min-w-0 [&_[data-streamdown=table-wrapper]]:max-w-full [&_table]:[overflow-wrap:normal] [&_table]:text-caption [&_th]:font-semibold [&_img]:max-w-full';

export function GitSpaceMarkdownRenderer({ children, streaming = false, className, documentUri }: GitSpaceMarkdownProps) {
  const needsCode = /(?:```|~~~)[^\n]*\n/u.test(children);
  const needsMath = /\$\$|\\\(|\\\[/u.test(children);
  const needsCjk = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(children);
  // ```gitspace-ui, ```svg and ```mermaid fences draw as blocks.
  const [plugins, setPlugins] = useState<PluginConfig>({ renderers: BLOCK_RENDERERS });
  useEffect(() => {
    let cancelled = false;
    // Runtime-selected plugin loading keeps Shiki, KaTeX, and CJK code off Markdown surfaces that do not use them.
    void (async () => {
      const next: PluginConfig = { renderers: BLOCK_RENDERERS };
      if (needsCode) next.code = (await import('@streamdown/code')).code;
      if (needsMath) {
        next.math = (await import('@streamdown/math')).math;
        await import('katex/dist/katex.min.css');
      }
      if (needsCjk) next.cjk = (await import('@streamdown/cjk')).cjk;
      if (!cancelled) setPlugins(next);
    })();
    return () => { cancelled = true; };
  }, [needsCode, needsMath, needsCjk]);
  const origin = typeof window === 'undefined' ? 'https://gitspace.local' : window.location.origin;
  return <Streamdown
    className={className ? `${PROSE} ${className}` : PROSE}
    mode={streaming ? 'streaming' : 'static'}
    isAnimating={streaming}
    animated={streaming ? { animation: 'fadeIn', duration: 180 } : false}
    caret={streaming ? 'circle' : undefined}
    parseIncompleteMarkdown={streaming}
    plugins={plugins}
    codeBlockMaxHeight={520}
    tableMaxHeight={420}
    lineNumbers={false}
    linkSafety={{ enabled: true }}
    components={RESOURCE_COMPONENTS}
    rehypePlugins={[
      defaultRehypePlugins.raw,
      rehypeResourceAddresses,
      [rehypeResourceLinks, { documentUri }],
      // Drive and repository files show in place; in a drive or repository document, so do paths relative to it.
      [rehypeResourceMediaMarkers, { documentUri }],
      defaultRehypePlugins.sanitize,
      [harden, {
        defaultOrigin: origin,
        allowedProtocols: ['http', 'https', 'mailto'],
        allowedLinkPrefixes: ['*'],
        allowedImagePrefixes: [origin],
        allowDataImages: false,
      }],
      rehypeResourceMedia(origin),
      rehypeResourceAnchors,
    ]}
  >{children}</Streamdown>;
}
