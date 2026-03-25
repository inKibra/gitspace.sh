/**
 * SessionTerminal - embedded PTY terminal for session backends.
 *
 * Uses ghostty-opentui in persistent mode for efficient streaming ANSI rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { extend, useKeyboard, useRenderer } from '@opentui/react';
import type { PasteEvent, ScrollBoxRenderable } from '@opentui/core';
import { TailGhosttyTerminalRenderable } from './TailGhosttyTerminal.tui.js';
import { getTailWindowOffset } from './session-terminal-tail-window.js';
import { findUtf8Boundary } from '../utils/utf8.js';
import { BracketedPasteModeTracker, wrapPaste } from './terminal-bracketed-paste.tui.js';
import { toast } from '@opentui-ui/toast';
import { copyToClipboard } from '../utils/clipboard.js';
import {
  shouldBypassScrollboxKeyHandling,
  shouldConsumePageNavigationInScrollbox,
} from './session-terminal-page-navigation.js';
import {
  forceDisableKittyKeyboard,
  restoreKittyKeyboard,
} from '../tui/kitty-keyboard.js';

extend({ 'tail-ghostty-terminal': TailGhosttyTerminalRenderable });

const COLORS = {
  statusBar: '#333333',
  session: '#00FF88',
  textDim: '#888888',
  detachHint: '#FFAA00',
};

const TAIL_WINDOW_LIMIT = 250;
const SHIFT_ESCAPE_SEQUENCES = new Set(['\x1b[27;2u', '\x1b[27;2;27~']);
const SHIFT_TAB_SEQUENCES = new Set(['\x1b[Z', '\x1b[9;2u', '\x1b[27;2;9~']);

const RENDER_BATCH_DELAY_MS = 24;
const RENDER_BURST_GAP_MS = 12;
const RENDER_BURST_CHUNK_BYTES = 512;
const RENDER_BATCH_FORCE_FLUSH_BYTES = 8 * 1024;

function isUiModeToggleSequence(sequence: string): boolean {
  return SHIFT_ESCAPE_SEQUENCES.has(sequence);
}

function isShiftTabSequence(sequence: string): boolean {
  return SHIFT_TAB_SEQUENCES.has(sequence);
}

function getTerminalSize(
  reservedRows: number,
  reservedCols: number = 0,
  reservedRowsExtra: number = 0
) {
  let cols = process.stdout.columns || 0;
  let rows = process.stdout.rows || 0;
  if (cols <= 0 || rows <= 0) {
    const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
    if (Array.isArray(size) && size.length >= 2) {
      cols = size[0];
      rows = size[1];
    }
  }
  const viewportCols = cols > 0 ? cols : 80;
  const viewportRows = rows > 0 ? rows : 24;
  return {
    cols: Math.max(40, viewportCols - reservedCols),
    rows: Math.max(1, viewportRows - reservedRows - reservedRowsExtra),
  };
}

export interface SessionTerminalProps {
  sessionName: string;
  processTitle?: string | null;
  terminalTitle?: string | null;
  lastAlertLabel?: string | null;
  endpointLabel?: string;
  onData: (data: Uint8Array) => void;
  onResize: (cols: number, rows: number) => void;
  onDetach: () => void;
  setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
  interceptShiftTab?: boolean;
  modalOpen?: boolean;
  onActivity?: () => void;
  /** When true, keyboard input and paste are disabled (view-only mode) */
  readOnly?: boolean;
  /** Hide top status/banner row (for inline embedding). */
  showTopBanner?: boolean;
  /** Reserved columns for layout chrome (e.g. sidebar) when embedded. */
  reservedCols?: number;
  /** Additional reserved rows for layout chrome (header, tab bar, status bar) when embedded. */
  reservedRowsExtra?: number;
  /** When provided, Shift+Esc calls this instead of toggling UI mode (e.g. for parent to release focus). */
  onShiftEsc?: () => void;
}

export function SessionTerminal({
  sessionName,
  processTitle,
  terminalTitle,
  lastAlertLabel,
  endpointLabel = 'remote',
  onData,
  onResize,
  onDetach,
  setWriteCallback,
  interceptShiftTab,
  modalOpen,
  onActivity,
  readOnly = false,
  showTopBanner = true,
  reservedCols = 0,
  reservedRowsExtra = 0,
  onShiftEsc,
}: SessionTerminalProps) {
  const renderer = useRenderer();
  const reservedRows = showTopBanner ? 1 : 0;
  const [termSize, setTermSize] = useState(() =>
    getTerminalSize(reservedRows, reservedCols, reservedRowsExtra)
  );
  const [initialData, setInitialData] = useState<Buffer>(() => Buffer.alloc(0));

  const terminalRef = useRef<TailGhosttyTerminalRenderable | null>(null);
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const ptyUtf8BufferRef = useRef<Buffer>(Buffer.alloc(0));
  const renderBatchBufferRef = useRef<Buffer>(Buffer.alloc(0));
  const renderBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRenderFlushAtRef = useRef(0);
  const followScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bracketedPasteRef = useRef(new BracketedPasteModeTracker());
  const textEncoderRef = useRef(new TextEncoder());
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [uiModeEnabled, setUiModeEnabled] = useState(false);
  const uiModeEnabledRef = useRef(false);

  const forceDisableKeyboard = useCallback(() => {
    forceDisableKittyKeyboard(renderer);
  }, [renderer]);

  useEffect(() => {
    uiModeEnabledRef.current = uiModeEnabled;
  }, [uiModeEnabled]);

  useEffect(() => {
    const previousKittyMode = renderer.useKittyKeyboard;
    forceDisableKeyboard();

    const handleFocus = () => {
      if (!uiModeEnabledRef.current) {
        forceDisableKeyboard();
      }
    };

    renderer.on('focus', handleFocus);

    return () => {
      renderer.off('focus', handleFocus);
      restoreKittyKeyboard(renderer, previousKittyMode);
    };
  }, [forceDisableKeyboard, renderer]);

  const scrollToCursorIfFollowing = useCallback(() => {
    const scrollBox = scrollBoxRef.current;
    const terminal = terminalRef.current;
    if (!scrollBox || !terminal) {
      return;
    }

    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    const isAtBottom = scrollBox.scrollTop >= maxScrollTop - 1;
    if (!isAtBottom) {
      return;
    }

    const desiredOffset = getTailWindowOffset(terminal.totalLines, TAIL_WINDOW_LIMIT);
    if (terminal.offset !== desiredOffset) {
      terminal.offset = desiredOffset;
      if (!followScrollTimeoutRef.current) {
        followScrollTimeoutRef.current = setTimeout(() => {
          followScrollTimeoutRef.current = null;
          scrollToCursorIfFollowing();
        }, 0);
      }
      return;
    }

    let cursor: [number, number];
    try {
      cursor = terminal.getCursor();
    } catch {
      return;
    }

    const lineCount = terminal.lineCount ?? 0;
    if (lineCount <= 0) {
      return;
    }

    const cursorLine = Math.max(0, lineCount - terminal.rows + cursor[1]);
    const scrollPos = terminal.getScrollPositionForLine(cursorLine);
    scrollBox.scrollTo(scrollPos);
  }, []);

  const scheduleScrollFollow = useCallback(() => {
    if (followScrollTimeoutRef.current) {
      return;
    }

    followScrollTimeoutRef.current = setTimeout(() => {
      followScrollTimeoutRef.current = null;
      scrollToCursorIfFollowing();
    }, 0);
  }, [scrollToCursorIfFollowing]);

  useEffect(() => {
    return () => {
      if (followScrollTimeoutRef.current) {
        clearTimeout(followScrollTimeoutRef.current);
        followScrollTimeoutRef.current = null;
      }
    };
  }, []);

  const handleMouseUp = useCallback(async () => {
    const text = renderer.getSelection()?.getSelectedText();
    if (!text || text.length === 0) {
      return;
    }

    try {
      await copyToClipboard(text);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }
    renderer.clearSelection();
  }, [renderer]);

  const flushRenderBatch = useCallback(() => {
    const terminal = terminalRef.current;
    const buffered = renderBatchBufferRef.current;
    renderBatchBufferRef.current = Buffer.alloc(0);
    if (renderBatchTimerRef.current) {
      clearTimeout(renderBatchTimerRef.current);
      renderBatchTimerRef.current = null;
    }
    if (!terminal || buffered.length === 0) {
      return;
    }
    terminal.feed(buffered);
    lastRenderFlushAtRef.current = Date.now();
    scheduleScrollFollow();
  }, [scheduleScrollFollow]);

  const enqueueRenderChunk = useCallback((chunk: Buffer) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setInitialData((previous) => (previous.length > 0 ? Buffer.concat([previous, chunk]) : chunk));
      return;
    }

    const now = Date.now();
    const shouldBatch = chunk.length >= RENDER_BURST_CHUNK_BYTES
      || (now - lastRenderFlushAtRef.current) <= RENDER_BURST_GAP_MS
      || renderBatchBufferRef.current.length > 0;

    if (!shouldBatch) {
      terminal.feed(chunk);
      lastRenderFlushAtRef.current = now;
      scheduleScrollFollow();
      return;
    }

    renderBatchBufferRef.current = renderBatchBufferRef.current.length > 0
      ? Buffer.concat([renderBatchBufferRef.current, chunk])
      : chunk;

    if (renderBatchBufferRef.current.length >= RENDER_BATCH_FORCE_FLUSH_BYTES) {
      flushRenderBatch();
      return;
    }

    if (!renderBatchTimerRef.current) {
      renderBatchTimerRef.current = setTimeout(() => {
        flushRenderBatch();
      }, RENDER_BATCH_DELAY_MS);
    }
  }, [flushRenderBatch, scheduleScrollFollow]);

  const feedChunk = useCallback((chunk: Uint8Array) => {
    const incoming = Buffer.from(chunk);

    let combined: Buffer;
    if (ptyUtf8BufferRef.current.length > 0) {
      combined = Buffer.concat([ptyUtf8BufferRef.current, incoming]);
      ptyUtf8BufferRef.current = Buffer.alloc(0);
    } else {
      combined = incoming;
    }

    const boundary = findUtf8Boundary(combined);
    if (boundary < combined.length) {
      ptyUtf8BufferRef.current = Buffer.from(combined.subarray(boundary));
      combined = combined.subarray(0, boundary) as Buffer;
    }

    if (combined.length === 0) {
      return;
    }

    bracketedPasteRef.current.update(combined);

    if (!terminalRef.current) {
      setInitialData((previous) => (previous.length > 0 ? Buffer.concat([previous, combined]) : combined));
      return;
    }

    enqueueRenderChunk(combined);
  }, [enqueueRenderChunk]);

  useEffect(() => {
    setWriteCallback(feedChunk);
    return () => {
      setWriteCallback(null);
      ptyUtf8BufferRef.current = Buffer.alloc(0);
      renderBatchBufferRef.current = Buffer.alloc(0);
      if (renderBatchTimerRef.current) {
        clearTimeout(renderBatchTimerRef.current);
        renderBatchTimerRef.current = null;
      }
      setTerminalMounted(false);
      setInitialData(Buffer.alloc(0));
    };
  }, [feedChunk, setWriteCallback]);


  useEffect(() => {
    if (!terminalMounted) {
      return;
    }
    scheduleScrollFollow();
  }, [initialData, scheduleScrollFollow, terminalMounted]);

  useEffect(() => {
    if (!terminalMounted) {
      return;
    }
    flushRenderBatch();
  }, [flushRenderBatch, terminalMounted]);

  useEffect(() => {
    const { cols, rows } = getTerminalSize(reservedRows, reservedCols, reservedRowsExtra);
    setTermSize({ cols, rows });
    onResize(cols, rows);

    const handleResize = () => {
      const next = getTerminalSize(reservedRows, reservedCols, reservedRowsExtra);
      setTermSize(next);
      onResize(next.cols, next.rows);
    };

    const stdout = process.stdout;
    if (stdout?.isTTY) {
      stdout.on('resize', handleResize);
    }
    process.on('SIGWINCH', handleResize);
    return () => {
      if (stdout?.isTTY) {
        stdout.removeListener('resize', handleResize);
      }
      process.removeListener('SIGWINCH', handleResize);
    };
  }, [onResize, reservedRows, reservedCols, reservedRowsExtra]);

  useEffect(() => {
    const rawInputHandler = (sequence: string): boolean => {
      if (modalOpen) {
        return false;
      }

      if (isUiModeToggleSequence(sequence)) {
        if (uiModeEnabledRef.current) {
          if (onShiftEsc) {
            onShiftEsc();
            return true;
          }
          forceDisableKeyboard();
        }
        setUiModeEnabled((prev) => !prev);
        return true;
      }

      if (uiModeEnabled || readOnly) {
        return false;
      }

      if (interceptShiftTab && isShiftTabSequence(sequence)) {
        return false;
      }

      onActivity?.();
      onData(textEncoderRef.current.encode(sequence));
      return true;
    };

    renderer.prependInputHandler(rawInputHandler);
    return () => {
      renderer.removeInputHandler(rawInputHandler);
    };
  }, [forceDisableKeyboard, interceptShiftTab, modalOpen, onActivity, onData, onShiftEsc, readOnly, renderer, uiModeEnabled]);

  useEffect(() => {
    if (!modalOpen) {
      return;
    }

    forceDisableKeyboard();
    setUiModeEnabled(false);
  }, [forceDisableKeyboard, modalOpen]);

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      if (modalOpen || readOnly || uiModeEnabled) {
        return;
      }
      const text = event.text ?? '';
      if (!text) {
        return;
      }

      onActivity?.();
      const payload = wrapPaste(text, bracketedPasteRef.current.isEnabled);
      onData(new TextEncoder().encode(payload));
      event.preventDefault();
    };

    renderer.keyInput.on('paste', handlePaste);
    return () => {
      renderer.keyInput.off('paste', handlePaste);
    };
  }, [modalOpen, onActivity, onData, readOnly, renderer, uiModeEnabled]);

  useKeyboard((key) => {
    if (modalOpen || !uiModeEnabled) {
      return;
    }

    if (shouldBypassScrollboxKeyHandling(key.name)) {
      key.preventDefault();
    }

    if (key.shift && key.name === 'escape') {
      if (onShiftEsc) {
        onShiftEsc();
      } else {
        forceDisableKeyboard();
        setUiModeEnabled(false);
      }
      return;
    }

    if (key.raw === 'q' || key.name === 'q') {
      onDetach();
      return;
    }

    if (key.name === 'pageup') {
      const scrollBox = scrollBoxRef.current;
      if (
        scrollBox &&
        shouldConsumePageNavigationInScrollbox({
          direction: 'up',
          scrollTop: scrollBox.scrollTop,
          scrollHeight: scrollBox.scrollHeight,
          viewportHeight: scrollBox.viewport.height,
        })
      ) {
        scrollBox.scrollBy(-1, 'viewport');
        return;
      }

      return;
    }

    if (key.name === 'pagedown') {
      const scrollBox = scrollBoxRef.current;
      if (
        scrollBox &&
        shouldConsumePageNavigationInScrollbox({
          direction: 'down',
          scrollTop: scrollBox.scrollTop,
          scrollHeight: scrollBox.scrollHeight,
          viewportHeight: scrollBox.viewport.height,
        })
      ) {
        scrollBox.scrollBy(1, 'viewport');
        return;
      }

      return;
    }
  });

  const modeHint = uiModeEnabled
    ? `[UI mode] [q] ${readOnly ? 'Back' : 'Detach'}  [Shift+Esc] Shell`
    : '[Shift+Esc] UI';
  const subtitle = processTitle || terminalTitle || null;

  return (
    <box flexDirection="column" flexGrow={1}>
      {showTopBanner && (
        <box
          height={1}
          width="100%"
          backgroundColor={COLORS.statusBar}
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
        >
          <box flexGrow={1} flexDirection="row">
            <text fg={COLORS.session}>{sessionName}</text>
            <text fg={COLORS.textDim}> ({endpointLabel})</text>
            {subtitle && <text fg={COLORS.textDim}>  {subtitle}</text>}
            {lastAlertLabel && <text fg={COLORS.detachHint}>  {lastAlertLabel}</text>}
            {readOnly && <text fg={COLORS.textDim}> [view only]</text>}
          </box>
          <text fg={COLORS.detachHint}>{modeHint}</text>
        </box>
      )}

      <scrollbox
        ref={(el: ScrollBoxRenderable | null) => {
          scrollBoxRef.current = el;
        }}
        flexGrow={1}
        viewportCulling={true}
        stickyScroll={true}
        stickyStart="bottom"
        onMouseUp={handleMouseUp}
      >
        <tail-ghostty-terminal
          ref={(el: TailGhosttyTerminalRenderable | null) => {
            const wasNull = terminalRef.current === null;
            terminalRef.current = el;
            if (el && wasNull) {
              queueMicrotask(() => setTerminalMounted(true));
            }
          }}
          persistent={true}
          showCursor={true}
          cursorStyle="block"
          cols={termSize.cols}
          rows={termSize.rows}
          limit={TAIL_WINDOW_LIMIT}
          offset={0}
          ansi={initialData}
        />
      </scrollbox>
    </box>
  );
}
