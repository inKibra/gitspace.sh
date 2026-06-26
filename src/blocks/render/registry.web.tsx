import { type FC, type ReactElement } from 'react';
import { validateBlock, type Block, type BlockValidation } from '../index.js';
import { Markdown } from './markdown.web.js';

type Fail = Extract<BlockValidation, { ok: false }>;
type BlockRenderer<T = unknown> = FC<{ data: T; block: Block }>;

const renderers = new Map<string, BlockRenderer>();

/**
 * Register a web renderer for a block type. The schema registry guarantees a
 * block carrying `type` was validated as `T`, so we narrow at this one boundary.
 */
export function defineRenderer<T>(type: string, render: BlockRenderer<T>): void {
  renderers.set(type, render as BlockRenderer);
}

export function hasRenderer(type: string): boolean {
  return renderers.has(type);
}

/**
 * Render one block: validate against its schema, then hand typed data to the
 * registered renderer. Anything unrenderable degrades to Markdown (loud, never
 * a silent drop); genuinely invalid data surfaces a loud error with the issues.
 */
export function BlockView({ block }: { block: unknown }): ReactElement {
  const result = validateBlock(block);
  if (!result.ok) {
    return <BlockFallback raw={block} fail={result} />;
  }
  const Renderer = renderers.get(result.block.type);
  if (!Renderer) {
    return (
      <BlockFallback
        raw={block}
        fail={{ ok: false, reason: 'unknown-type', type: result.block.type, issues: [`no web renderer for "${result.block.type}"`] }}
      />
    );
  }
  return <Renderer data={result.block.data} block={result.block} />;
}

export function BlockList({ blocks }: { blocks: readonly unknown[] }): ReactElement {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={(b as { id?: string } | null)?.id ?? i} block={b} />
      ))}
    </>
  );
}

function BlockFallback({ raw, fail }: { raw: unknown; fail: Fail }): ReactElement {
  const type = fail.type ?? (raw as { type?: string } | null)?.type ?? 'unknown';
  const data = (raw as { data?: unknown } | null)?.data;

  // Unknown/unsupported type → degrade to Markdown (text if present, else JSON).
  if (fail.reason === 'unknown-type') {
    const text = typeof (data as { text?: unknown })?.text === 'string' ? (data as { text: string }).text : null;
    return (
      <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)] border-b border-[var(--gs-border)]">
          unsupported block · {type}
        </div>
        <div className="p-2">
          {text != null ? <Markdown text={text} /> : <pre className="text-[12px] overflow-x-auto whitespace-pre-wrap text-[var(--gs-text-muted)]">{safeJson(data)}</pre>}
        </div>
      </div>
    );
  }

  // Malformed envelope / invalid data → loud, these are authoring bugs.
  return (
    <div className="my-2 border border-[var(--gs-danger)] bg-[rgba(255,51,51,0.06)]">
      <div className="px-2 py-1 text-[11px] text-[var(--gs-danger)] border-b border-[var(--gs-danger)]">
        invalid block · {type} · {fail.reason}
      </div>
      <ul className="p-2 m-0 list-disc pl-5 text-[12px] text-[var(--gs-text-muted)]">
        {fail.issues.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[unserializable block data]';
  }
}
