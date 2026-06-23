/** @jsxImportSource react */
import { useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { renderMarkdownHtml } from './markdown-render.js';
import { btnPrimary, btnSecondary, R_CHIP, R_INPUT, R_CARD } from './ui/control.js';

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
  h1ClassName: 'mb-3 text-lg font-semibold text-[var(--gs-text)] text-balance',
  h2ClassName: 'mt-5 text-base font-semibold text-[var(--gs-text)] text-balance',
  h3ClassName: 'mt-4 text-sm font-semibold text-[var(--gs-text)] text-balance',
  preClassName: 'my-3 overflow-auto border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] p-3 text-[11px]',
  inlineCodeClassName: 'bg-[var(--gs-bg-elevated)] px-1',
  listClassName: 'my-2 ml-4 list-disc space-y-1',
  orderedListClassName: 'my-2 ml-4 list-decimal space-y-1',
  paragraphClassName: 'my-2 leading-6 text-pretty',
  blockquoteClassName: 'my-3 border-l-2 border-[var(--gs-border-active)] pl-3 text-[var(--gs-text-muted)]',
  hrClassName: 'my-4 border-0 border-t border-[var(--gs-border)]',
  linkClassName: 'text-[var(--gs-accent)] underline underline-offset-2 hover:text-[var(--gs-accent-hover)]',
} as const;

export function MarkdownEditor(props: MarkdownEditorProps) {
  const html = useMemo(() => renderMarkdownHtml(props.body, {
    ...PREVIEW_OPTIONS,
    emptyHtml: props.emptyPreviewHtml ?? PREVIEW_OPTIONS.emptyHtml,
  }), [props.body, props.emptyPreviewHtml]);

  const minHeight = props.minHeightPx ?? 360;
  const lineCount = props.body === '' ? 0 : props.body.split('\n').length;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      if (!props.onSave) return;
      event.preventDefault();
      if (props.dirty && !props.saving) void props.onSave();
    }
  };

  return (
    <div className="flex h-full flex-col gap-3" onKeyDown={handleKeyDown}>
      <div className="flex flex-wrap items-center gap-2">
        <ModeToggle mode={props.mode} onChange={props.onModeChange} />
        {props.meta && <div className="min-w-0 flex-1 truncate text-xs text-[var(--gs-text-dim)]">{props.meta}</div>}
        <div className="ml-auto flex items-center gap-2">
          {props.rightActions}
          {props.onDiscard && (
            <button type="button" disabled={!props.dirty} onClick={props.onDiscard} className={btnSecondary()}>
              Discard
            </button>
          )}
          {props.onSave && (
            <button type="button" disabled={!props.dirty || props.saving} onClick={() => void props.onSave?.()} className={btnPrimary()}>
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
            className={`w-full resize-none ${R_INPUT} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-3 font-mono text-xs leading-6 text-[var(--gs-text)] outline-none transition-[border-color] duration-150 focus:border-[var(--gs-input-focus-border)]`}
          />
        )}
        {(props.mode === 'preview' || props.mode === 'split') && (
          <div
            style={{ minHeight }}
            className={`prose prose-invert max-w-none overflow-auto ${R_CARD} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-5 text-sm text-[var(--gs-text-muted)]`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>

      {props.onSave && (
        <div className="text-[10px] tabular-nums text-[var(--gs-text-dim)]">
          {props.dirty
            ? <><span className="text-[var(--gs-warning)]">●</span> {lineCount} {lineCount === 1 ? 'line' : 'lines'} · unsaved</>
            : <>Saved · {lineCount} {lineCount === 1 ? 'line' : 'lines'}</>}
        </div>
      )}
    </div>
  );
}

function ModeToggle(props: { mode: MarkdownEditorMode; onChange: (mode: MarkdownEditorMode) => void }) {
  const modes: MarkdownEditorMode[] = ['preview', 'edit', 'split'];
  return (
    <div className={`inline-flex gap-0.5 ${R_CHIP} border border-[var(--gs-border)] bg-[var(--gs-bg)] p-0.5`}>
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => props.onChange(mode)}
          aria-pressed={props.mode === mode}
          className={`${R_CHIP} px-2.5 py-1 text-xs capitalize transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96] ${props.mode === mode ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'}`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}
