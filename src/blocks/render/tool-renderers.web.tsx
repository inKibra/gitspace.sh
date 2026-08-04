import type { ReactElement, ReactNode } from 'react';
import type { Block } from '../index.js';
import type { ToolCallData } from '../types/transcript.js';
import { Highlighted } from './highlight.web.js';

/** Keep each expanded payload at a readable height; scrolling here prevents a busy transcript becoming a wall of output. */
export const TOOL_PAYLOAD_CLASS = 'max-h-72 overflow-y-auto overscroll-contain border-t border-[var(--gs-border)] p-2';

type RenderBlocks = (blocks: readonly Block[]) => ReactNode;
export type ToolRenderer = (props: { data: ToolCallData; renderBlocks: RenderBlocks; showInput?: boolean }) => ReactElement;

function jsonText(value: unknown): string {
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function StructuredPayload({ label, value }: { label: string; value: unknown }): ReactElement {
  return (
    <section className={TOOL_PAYLOAD_CLASS} data-payload={label.toLowerCase()}>
      <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-muted)]">{label} · structured</div>
      <div className="overflow-x-auto border border-[var(--gs-border)]">
        <Highlighted text={jsonText(value)} lang="json" />
      </div>
    </section>
  );
}

function StringPayload({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <section className={TOOL_PAYLOAD_CLASS} data-payload={label.toLowerCase()}>
      <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-muted)]">{label}</div>
      <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-[var(--gs-text-secondary)]">{value || <span className="italic text-[var(--gs-text-muted)]">empty</span>}</div>
    </section>
  );
}

export function Payload({ label, value }: { label: string; value: unknown }): ReactElement {
  if (typeof value === 'string') return <StringPayload label={label} value={value} />;
  return <StructuredPayload label={label} value={value} />;
}

function ToolBlocks({ blocks, renderBlocks }: { blocks: readonly Block[]; renderBlocks: RenderBlocks }): ReactElement | null {
  return blocks.length > 0 ? <div className={TOOL_PAYLOAD_CLASS}>{renderBlocks(blocks)}</div> : null;
}

/** Generic presentation retains both complete wire payloads and curated nested blocks. */
export const genericToolRenderer: ToolRenderer = ({ data, renderBlocks, showInput = false }) => (
  <>
    {showInput && data.args !== undefined && <Payload label="input" value={data.args} />}
    {showInput && data.input && <ToolBlocks blocks={data.input} renderBlocks={renderBlocks} />}
    {!showInput && data.details !== undefined && <Payload label="output" value={data.details} />}
    {!showInput && data.result && <ToolBlocks blocks={data.result} renderBlocks={renderBlocks} />}
    {showInput && data.args === undefined && data.input?.length === 0 && (
      <div className="border-t border-[var(--gs-border)] px-2 py-2 text-[11px] italic text-[var(--gs-text-muted)]">no input</div>
    )}
    {!showInput && data.details === undefined && data.result?.length === 0 && (
      <div className="border-t border-[var(--gs-border)] px-2 py-2 text-[11px] italic text-[var(--gs-text-muted)]">no output</div>
    )}
  </>
);

/** Shell commands benefit from code treatment and a clear command/result split. */
const bashRenderer: ToolRenderer = ({ data, renderBlocks, showInput = false }) => (
  <>
    {showInput && data.args !== undefined && <Payload label="command input" value={data.args} />}
    {showInput && data.input && <ToolBlocks blocks={data.input} renderBlocks={renderBlocks} />}
    {!showInput && data.details !== undefined && <Payload label="command output" value={data.details} />}
    {!showInput && data.result && <ToolBlocks blocks={data.result} renderBlocks={renderBlocks} />}
  </>
);

/** Edit/apply tools get explicit patch labeling while retaining the complete payload. */
const editRenderer: ToolRenderer = ({ data, renderBlocks, showInput = false }) => (
  <>
    {showInput && data.args !== undefined && <Payload label="edit request" value={data.args} />}
    {showInput && data.input && <ToolBlocks blocks={data.input} renderBlocks={renderBlocks} />}
    {!showInput && data.details !== undefined && <Payload label="patch result" value={data.details} />}
    {!showInput && data.result && <ToolBlocks blocks={data.result} renderBlocks={renderBlocks} />}
  </>
);

/** Search/read tools emphasize paths and list-shaped results as structured data. */
const readRenderer: ToolRenderer = ({ data, renderBlocks, showInput = false }) => (
  <>
    {showInput && data.args !== undefined && <Payload label="path / query" value={data.args} />}
    {showInput && data.input && <ToolBlocks blocks={data.input} renderBlocks={renderBlocks} />}
    {!showInput && data.details !== undefined && <Payload label="matches / content" value={data.details} />}
    {!showInput && data.result && <ToolBlocks blocks={data.result} renderBlocks={renderBlocks} />}
  </>
);

export const TOOL_RENDERERS: Readonly<Record<string, ToolRenderer>> = {
  bash: bashRenderer,
  edit: editRenderer,
  read: readRenderer,
};

export function rendererForTool(tool: string): ToolRenderer {
  return TOOL_RENDERERS[tool] ?? genericToolRenderer;
}
