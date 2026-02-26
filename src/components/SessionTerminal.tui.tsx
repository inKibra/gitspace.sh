/**
 * SessionTerminal - embedded PTY terminal for session backends.
 *
 * Uses ghostty-opentui in persistent mode for efficient streaming ANSI rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { extend, useKeyboard, useRenderer } from '@opentui/react';
import type { PasteEvent, ScrollBoxRenderable } from '@opentui/core';
import { GhosttyTerminalRenderable } from 'ghostty-opentui/terminal-buffer';
import { findUtf8Boundary } from '../utils/utf8.js';
import { BracketedPasteModeTracker, wrapPaste } from './terminal-bracketed-paste.tui.js';
import { toast } from '@opentui-ui/toast';
import { copyToClipboard } from '../utils/clipboard.js';
import {
  shouldBypassScrollboxKeyHandling,
  shouldConsumePageNavigationInScrollbox,
} from './session-terminal-page-navigation.js';

extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

const COLORS = {
  statusBar: '#333333',
  session: '#00FF88',
  textDim: '#888888',
  detachHint: '#FFAA00',
};

const SCROLLBACK_LIMIT = 2_000;
const SHIFT_ESCAPE_SEQUENCES = new Set(['\x1b[27;2u', '\x1b[27;2;27~']);
const SHIFT_TAB_SEQUENCES = new Set(['\x1b[Z', '\x1b[9;2u', '\x1b[27;2;9~']);

function isShiftEscapeSequence(sequence: string): boolean {
  return SHIFT_ESCAPE_SEQUENCES.has(sequence);
}

function isShiftTabSequence(sequence: string): boolean {
  return SHIFT_TAB_SEQUENCES.has(sequence);
}

function getTerminalSize() {
  let cols = process.stdout.columns || 0;
  let rows = process.stdout.rows || 0;
  if (cols <= 0 || rows <= 0) {
    const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
    if (Array.isArray(size) && size.length >= 2) {
      cols = size[0];
      rows = size[1];
    }
  }
  return {
    cols: cols > 0 ? cols : 80,
    rows: Math.max(1, (rows > 0 ? rows : 24) - 1),
  };
}

export interface SessionTerminalProps {
  sessionName: string;
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
}

export function SessionTerminal({
  sessionName,
  endpointLabel = 'remote',
  onData,
  onResize,
  onDetach,
  setWriteCallback,
  interceptShiftTab,
  modalOpen,
  onActivity,
  readOnly = false,
}: SessionTerminalProps) {
  const renderer = useRenderer();
  const [termSize, setTermSize] = useState(getTerminalSize);
  const [initialData] = useState<Buffer>(() => Buffer.alloc(0));

  const terminalRef = useRef<GhosttyTerminalRenderable | null>(null);
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const pendingPtyDataRef = useRef<Buffer[]>([]);
  const ptyUtf8BufferRef = useRef<Buffer>(Buffer.alloc(0));
  const followScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bracketedPasteRef = useRef(new BracketedPasteModeTracker());
  const textEncoderRef = useRef(new TextEncoder());
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [uiModeEnabled, setUiModeEnabled] = useState(false);

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

    if (lineCount > SCROLLBACK_LIMIT) {
      terminal.feed(Buffer.from('\x1b[3J'));
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
      pendingPtyDataRef.current.push(combined);
      return;
    }

    terminalRef.current.feed(combined);
    scheduleScrollFollow();
  }, [scheduleScrollFollow]);

  useEffect(() => {
    setWriteCallback(feedChunk);
    return () => {
      setWriteCallback(null);
      pendingPtyDataRef.current = [];
      ptyUtf8BufferRef.current = Buffer.alloc(0);
      setTerminalMounted(false);
    };
  }, [feedChunk, setWriteCallback]);

  useEffect(() => {
    if (!terminalMounted || !terminalRef.current || pendingPtyDataRef.current.length === 0) {
      return;
    }

    const pending = Buffer.concat(pendingPtyDataRef.current);
    pendingPtyDataRef.current = [];
    terminalRef.current.feed(pending);
    scheduleScrollFollow();
  }, [scheduleScrollFollow, terminalMounted]);

  useEffect(() => {
    if (!terminalMounted) {
      return;
    }
    scheduleScrollFollow();
  }, [initialData, scheduleScrollFollow, terminalMounted]);

  useEffect(() => {
    const { cols, rows } = getTerminalSize();
    setTermSize({ cols, rows });
    onResize(cols, rows);

    const handleResize = () => {
      const next = getTerminalSize();
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
  }, [onResize]);

  useEffect(() => {
    const rawInputHandler = (sequence: string): boolean => {
      if (modalOpen) {
        return false;
      }

      if (isShiftEscapeSequence(sequence)) {
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
  }, [interceptShiftTab, modalOpen, onActivity, onData, readOnly, renderer, uiModeEnabled]);

  useEffect(() => {
    if (!modalOpen) {
      return;
    }

    setUiModeEnabled(false);
  }, [modalOpen]);

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
      setUiModeEnabled(false);
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

  return (
    <box flexDirection="column" flexGrow={1}>
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
          {readOnly && <text fg={COLORS.textDim}> [view only]</text>}
        </box>
        <text fg={COLORS.detachHint}>{modeHint}</text>
      </box>

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
        <ghostty-terminal
          ref={(el: GhosttyTerminalRenderable | null) => {
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
          ansi={initialData}
        />
      </scrollbox>
    </box>
  );
}
