import type { FC, ReactElement } from 'react';
import type { Block } from './types';

type Renderer = (block: Block) => ReactElement;

const registry = new Map<string, Renderer>();

/**
 * Register a renderer for a block `type`. The registry guarantees that a block
 * carrying `type` was authored with `TData`, so we narrow `block.data` to TData
 * at this single boundary (an open registry can't express the type↔data link to
 * the compiler). Every renderer below owns its own TData.
 */
export function defineBlock<TData>(type: string, Read: FC<{ data: TData; block: Block }>): void {
  registry.set(type, (block) => <Read data={block.data as TData} block={block} />);
}

export function hasBlock(type: string): boolean {
  return registry.has(type);
}

export function listBlockTypes(): string[] {
  return [...registry.keys()].sort();
}

/** Render one block, or a loud fallback for an unregistered type (never a silent drop). */
export function BlockView({ block }: { block: Block }): ReactElement {
  const render = registry.get(block.type);
  if (!render) {
    return (
      <div className="block-unknown">
        unknown block <code>{block.type}</code> — no renderer registered
      </div>
    );
  }
  return render(block);
}

export function BlockList({ blocks }: { blocks: Block[] }): ReactElement {
  return (
    <>
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} />
      ))}
    </>
  );
}
