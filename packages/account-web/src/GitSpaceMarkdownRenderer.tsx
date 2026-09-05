import { harden } from 'rehype-harden';
import { Streamdown, defaultRehypePlugins } from 'streamdown';
import type { PluginConfig } from 'streamdown';
import 'streamdown/styles.css';
import { useEffect, useState } from 'react';
import type { GitSpaceMarkdownProps } from './GitSpaceMarkdown.js';

// Prose typography lives on the wrapper as Tailwind utilities over Fluid
// tokens; streamdown's own stylesheet handles block layout, and the theme
// already styles inline `code`.
const PROSE = 'min-w-0 text-body text-foreground [overflow-wrap:anywhere] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:tracking-tight [&_h1]:text-display [&_h2]:text-title [&_h3]:text-subtitle [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_pre]:bg-surface-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_table]:text-caption [&_th]:font-semibold [&_img]:max-w-full';

export function GitSpaceMarkdownRenderer({ children, streaming = false, className }: GitSpaceMarkdownProps) {
  const needsCode = /(?:```|~~~)[^\n]*\n/u.test(children);
  const needsMermaid = /(?:```|~~~)mermaid(?:\s|\n)/u.test(children);
  const needsMath = /\$\$|\\\(|\\\[/u.test(children);
  const needsCjk = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(children);
  const [plugins, setPlugins] = useState<PluginConfig>({});
  useEffect(() => {
    let cancelled = false;
    // Runtime-selected plugin loading keeps Mermaid, Shiki, KaTeX, and CJK code off Markdown surfaces that do not use them.
    void (async () => {
      const next: PluginConfig = {};
      if (needsCode) next.code = (await import('@streamdown/code')).code;
      if (needsMermaid) next.mermaid = (await import('@streamdown/mermaid')).mermaid;
      if (needsMath) {
        next.math = (await import('@streamdown/math')).math;
        await import('katex/dist/katex.min.css');
      }
      if (needsCjk) next.cjk = (await import('@streamdown/cjk')).cjk;
      if (!cancelled) setPlugins(next);
    })();
    return () => { cancelled = true; };
  }, [needsCode, needsMermaid, needsMath, needsCjk]);
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
    rehypePlugins={[
      defaultRehypePlugins.raw,
      defaultRehypePlugins.sanitize,
      [harden, {
        defaultOrigin: origin,
        allowedProtocols: ['http', 'https', 'mailto'],
        allowedLinkPrefixes: ['*'],
        allowedImagePrefixes: [origin],
        allowDataImages: false,
      }],
    ]}
  >{children}</Streamdown>;
}
