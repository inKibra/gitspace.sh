import { ptyToJson, type TerminalData } from 'ghostty-opentui';
import {
  GhosttyTerminalRenderable,
  terminalDataToStyledText,
  type GhosttyTerminalOptions,
} from 'ghostty-opentui/terminal-buffer';

export interface TailGhosttyTerminalOptions extends GhosttyTerminalOptions {
  offset?: number;
}

interface TailGhosttyTerminalState {
  _ansi: string | Buffer;
  _cols: number;
  _rows: number;
  _limit?: number;
  _trimEnd?: boolean;
  _highlights?: TailGhosttyTerminalOptions['highlights'];
  _ansiDirty: boolean;
  _lineCount: number;
  _showCursor: boolean;
  _cursorStyle: 'block' | 'underline';
  _persistentTerminal: { getJson(options?: { offset?: number; limit?: number }): TerminalData } | null;
  textBuffer: { setStyledText(value: ReturnType<typeof terminalDataToStyledText>): void };
  textBufferView: { logicalLineInfo: { lineStarts: number[] } };
  updateTextInfo(): void;
}

export class TailGhosttyTerminalRenderable extends GhosttyTerminalRenderable {
  private _offset = 0;
  private _totalLines = 0;

  constructor(ctx: ConstructorParameters<typeof GhosttyTerminalRenderable>[0], options: TailGhosttyTerminalOptions) {
    super(ctx, options);
    this._offset = Math.max(0, Math.floor(options.offset ?? 0));
  }

  get offset(): number {
    return this._offset;
  }

  set offset(value: number) {
    const nextOffset = Math.max(0, Math.floor(value));
    if (this._offset === nextOffset) {
      return;
    }

    this._offset = nextOffset;
    const state = this as unknown as TailGhosttyTerminalState;
    state._ansiDirty = true;
    this.requestRender();
  }

  get totalLines(): number {
    return this._totalLines;
  }

  protected override renderSelf(buffer: unknown): void {
    const state = this as unknown as TailGhosttyTerminalState;

    if (state._ansiDirty) {
      const data = state._persistentTerminal
        ? state._persistentTerminal.getJson({
            offset: this._offset,
            limit: state._limit,
          })
        : ptyToJson(state._ansi, {
            cols: state._cols,
            rows: state._rows,
            offset: this._offset,
            limit: state._limit,
          });

      if (state._trimEnd) {
        while (data.lines.length > 0) {
          const lastLine = data.lines[data.lines.length - 1];
          const hasText = lastLine?.spans.some((span) => span.text.trim().length > 0) ?? false;
          if (hasText) {
            break;
          }
          data.lines.pop();
        }
      }

      const cursor = state._showCursor
        ? {
            x: data.cursor[0],
            y: Math.max(0, (data.totalLines - data.rows) + data.cursor[1] - data.offset),
            style: state._cursorStyle,
          }
        : undefined;

      const styledText = terminalDataToStyledText(data, state._highlights, cursor);
      state.textBuffer.setStyledText(styledText);
      state.updateTextInfo();
      state._lineCount = state.textBufferView.logicalLineInfo.lineStarts.length;
      state._ansiDirty = false;
      this._offset = data.offset;
      this._totalLines = data.totalLines;
    }

    super.renderSelf(buffer);
  }
}
