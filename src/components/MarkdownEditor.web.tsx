/** @jsxImportSource react */
import { useMemo, type ReactNode } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';

export type MarkdownEditorMode = 'preview' | 'edit' | 'split';

export interface MarkdownEditorProps {
  body: string;
  mode: MarkdownEditorMode;
  dirty?: boolean;
  saving?: boolean;
  /** Sub-title rendered next to the mode toggle (e.g. "Note · Updated 4:35 PM"). */
  meta?: ReactNode;
  emptyPreviewHtml?: string;
  onChange: (body: string) => void;
  onModeChange: (mode: MarkdownEditorMode) => void;
  onSave?: () => void | Promise<void>;
  onDiscard?: () => void;
  /** Optional right-aligned actions (Delete, Copy permalink, etc.). */
  rightActions?: ReactNode;
  /** Minimum height in px for the editor + preview pane. */
  minHeightPx?: number;
}

const PREVIEW_OPTIONS = {
  emptyHtml: '<p><em>Empty.</em></p>',
  h1ClassName: 'mb-3 text-lg font-semibold text-[var(--gs-text)]',
  h2ClassName: 'mt-5 text-base font-semibold text-[var(--gs-text)]',
  h3ClassName: 'mt-4 text-sm font-semibold text-[var(--gs-text)]',
  preClassName: 'my-3 overflow-auto rounded border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] p-3 text-[11px]',
  inlineCodeClassName: 'rounded bg-[var(--gs-bg-elevated)] px-1',
  listClassName: 'my-2 ml-4 list-disc space-y-1',
  paragraphClassName: 'my-2 leading-6',
} as const;

export function MarkdownEditor(props: MarkdownEditorProps) {
  const html = useMemo(() => renderMarkdownHtml(props.body, {
    ...PREVIEW_OPTIONS,
    emptyHtml: props.emptyPreviewHtml ?? PREVIEW_OPTIONS.emptyHtml,
  }), [props.body, props.emptyPreviewHtml]);

  const minHeight = props.minHeightPx ?? 360;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ModeToggle mode={props.mode} onChange={props.onModeChange} />
        {props.meta && <div className="min-w-0 flex-1 truncate text-xs text-[var(--gs-text-dim)]">{props.meta}</div>}
        <div className="ml-auto flex items-center gap-2">
          {props.rightActions}
          {props.onDiscard && (
            <button
              type="button"
              disabled={!props.dirty}
              onClick={props.onDiscard}
              className="rounded border border-[var(--gs-border)] px-2 py-1 text-xs text-[var(--gs-text-muted)] disabled:opacity-30"
            >
              Discard
            </button>
          )}
          {props.onSave && (
            <button
              type="button"
              disabled={!props.dirty || props.saving}
              onClick={() => void props.onSave?.()}
              className="rounded bg-[var(--gs-accent)] px-2 py-1 text-xs text-[var(--gs-text-on-accent)] disabled:opacity-40"
            >
              {props.saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      <div className={`grid flex-1 gap-3 ${props.mode === 'split' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {(props.mode === 'edit' || props.mode === 'split') && (
          <textarea
            value={props.body}
            onChange={(event) => props.onChange(event.target.value)}
            spellCheck={false}
            style={{ minHeight }}
            className="w-full resize-none rounded border border-[var(--gs-border)] bg-[var(--gs-bg)] p-3 font-mono text-xs text-[var(--gs-text)] leading-6 outline-none focus:border-[var(--gs-selected-border)]"
          />
        )}
        {(props.mode === 'preview' || props.mode === 'split') && (
          <div
            style={{ minHeight }}
            className="prose prose-invert max-w-none overflow-auto rounded border border-[var(--gs-border)] bg-[var(--gs-bg)] p-5 text-sm text-[var(--gs-text-muted)]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>

      {props.dirty && <div className="text-[10px] text-[var(--gs-text-dim)]">{props.body.split('\n').length} lines · unsaved</div>}
    </div>
  );
}

function ModeToggle(props: { mode: MarkdownEditorMode; onChange: (mode: MarkdownEditorMode) => void }) {
  const modes: MarkdownEditorMode[] = ['preview', 'edit', 'split'];
  return (
    <div className="inline-flex gap-1 rounded border border-[var(--gs-border)] bg-[var(--gs-bg)] p-0.5">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => props.onChange(mode)}
          className={`rounded px-2 py-1 text-xs ${props.mode === mode ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'}`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}
