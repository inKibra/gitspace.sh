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

extend({ 'ghostty-terminal': GhosttyTerminalRenderable });

const COLORS = {
  statusBar: '#333333',
  session: '#00FF88',
  textDim: '#888888',
  detachHint: '#FFAA00',
};

const SCROLLBACK_LIMIT = 2_000;

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
    rows: (rows > 0 ? rows : 24) - 1,
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
  const [terminalMounted, setTerminalMounted] = useState(false);

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

    process.on('SIGWINCH', handleResize);
    return () => {
      process.removeListener('SIGWINCH', handleResize);
    };
  }, [onResize]);

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      if (modalOpen) {
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
  }, [modalOpen, onActivity, onData, renderer]);

  useKeyboard((key) => {
    if (modalOpen) {
      return;
    }

    if (key.name === 'pageup') {
      scrollBoxRef.current?.scrollBy(-1, 'viewport');
      return;
    }

    if (key.name === 'pagedown') {
      scrollBoxRef.current?.scrollBy(1, 'viewport');
      return;
    }

    if (key.name === 'escape' && key.ctrl) {
      onDetach();
      return;
    }

    let data: string | undefined;
    const modifier = 1 + (key.shift ? 1 : 0) + (key.meta ? 2 : 0) + (key.ctrl ? 4 : 0);
    const hasModifier = modifier > 1;

    const specialKeys: Record<string, string> = {
      up: 'A', down: 'B', right: 'C', left: 'D',
      end: 'F', home: 'H',
      insert: '2~', delete: '3~', pageup: '5~', pagedown: '6~',
      f1: 'P', f2: 'Q', f3: 'R', f4: 'S',
      f5: '15~', f6: '17~', f7: '18~', f8: '19~',
      f9: '20~', f10: '21~', f11: '23~', f12: '24~',
    };

    if (key.ctrl && key.name && key.name.length === 1 && /[a-z]/i.test(key.name)) {
      const charCode = key.name.toLowerCase().charCodeAt(0) - 96;
      data = String.fromCharCode(charCode);
    } else if (key.shift && key.name === 'tab') {
      if (interceptShiftTab) {
        return;
      }
      data = '\x1b[Z';
    } else if (hasModifier && key.name && specialKeys[key.name]) {
      const code = specialKeys[key.name];
      if (code.endsWith('~')) {
        data = `\x1b[${code.slice(0, -1)};${modifier}~`;
      } else if (code.length === 1) {
        data = `\x1b[1;${modifier}${code}`;
      }
    } else if (key.sequence) {
      data = key.sequence;
    } else if (key.raw) {
      data = key.raw;
    }

    if (!data) {
      return;
    }

    onActivity?.();
    onData(new TextEncoder().encode(data));
  });

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
        </box>
        <text fg={COLORS.detachHint}>[Ctrl+Esc] Detach</text>
      </box>

      <scrollbox
        ref={(el: ScrollBoxRenderable | null) => {
          scrollBoxRef.current = el;
        }}
        focusable={false}
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
