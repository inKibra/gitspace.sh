// How GitSpaceMarkdown draws ```gitspace-ui and ```svg fences: a quiet placeholder while the fence is still streaming,
// then the block. The block code (json-render, the registry) loads on the first fence, so Markdown without blocks does
// not load it.
import { Suspense, lazy } from 'react';
import type { CustomRenderer, CustomRendererProps } from 'streamdown';
import { BlockPlaceholder } from './BlockFrames.js';

const FencedBlock = lazy(async () => ({ default: (await import('./UiBlock.js')).FencedBlock }));

function BlockFence({ code, isIncomplete, language }: CustomRendererProps) {
  if (isIncomplete) return <BlockPlaceholder />;
  return <Suspense fallback={<BlockPlaceholder />}><FencedBlock kind={language === 'svg' ? 'svg' : 'gitspace-ui'} body={code} /></Suspense>;
}

export const BLOCK_RENDERERS: CustomRenderer[] = [{ language: ['gitspace-ui', 'svg'], component: BlockFence }];
