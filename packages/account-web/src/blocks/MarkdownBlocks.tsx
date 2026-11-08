// How GitSpaceMarkdown draws ```gitspace-ui, ```svg and ```mermaid fences: a quiet placeholder while the fence is still
// streaming, then the block. The block code (json-render, the registry, Mermaid) loads on the first fence, so Markdown
// without blocks does not load it.
import { Suspense, lazy } from 'react';
import type { CustomRenderer, CustomRendererProps } from 'streamdown';
import { BlockPlaceholder } from './BlockFrames.js';

const FencedBlock = lazy(async () => ({ default: (await import('./UiBlock.js')).FencedBlock }));
const MermaidFence = lazy(async () => ({ default: (await import('./MermaidDiagram.js')).MermaidFence }));

function BlockFence({ code, isIncomplete, language }: CustomRendererProps) {
  if (isIncomplete) return <BlockPlaceholder />;
  return <Suspense fallback={<BlockPlaceholder />}><FencedBlock kind={language === 'svg' ? 'svg' : 'gitspace-ui'} body={code} /></Suspense>;
}

function DiagramFence(props: CustomRendererProps) {
  if (props.isIncomplete) return <BlockPlaceholder />;
  return <Suspense fallback={<BlockPlaceholder />}><MermaidFence {...props} /></Suspense>;
}

export const BLOCK_RENDERERS: CustomRenderer[] = [{ language: ['gitspace-ui', 'svg'], component: BlockFence }, { language: 'mermaid', component: DiagramFence }];
