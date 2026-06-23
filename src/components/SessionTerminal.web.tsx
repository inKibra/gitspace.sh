import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";
import {
  canConsumePageNavigationInViewport,
  type PageDirection,
} from './session-terminal-page-navigation.js';
import { isIOSDevice } from '../utils/device.web.js';

import {
  terminalMemoryDebugDecrement,
  terminalMemoryDebugGauge,
  terminalMemoryDebugIncrement,
  terminalMemoryDebugMax,
} from '../utils/terminal-memory-debug.js';

const WEB_TERMINAL_SCROLLBACK = 50_000;
interface Props {
  onData: (data: Uint8Array) => void;
  setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
  onResize?: (cols: number, rows: number) => void;
  /** Called when user interacts with terminal (for activity tracking) */
  onActivity?: () => void;
  /** Whether tapping the terminal should focus it (opens keyboard on mobile). Default: true */
  allowTapFocus?: boolean;
  /** Whether touch scrolling is enabled. Default: true. Disable when using floating controls. */
  allowTouchScroll?: boolean;
  /** When true, keyboard input is disabled (view-only mode) */
  readOnly?: boolean;
}

/** Methods exposed via ref for external control */
export interface SessionTerminalHandle {
  focus: () => void;
  blur: () => void;
  sendData: (data: string) => void;
  isFocused: () => boolean;
  getSize: () => { cols: number; rows: number } | null;
  pageUp: () => boolean;
  pageDown: () => boolean;
}

interface TerminalViewportLike {
  viewportY?: number;
  rows?: number;
  scrollLines: (lines: number) => void;
  buffer?: {
    active?: {
      baseY?: number;
    };
  };
}

// Touch scrolling constants (agentboard-inspired accumulated delta pattern)
const SCROLL_THRESHOLD = 10; // pixels before we consider it a scroll vs tap
const SCROLL_ACCUMULATOR_THRESHOLD = 30; // pixels of accumulated delta before sending scroll
const TAP_MOVE_THRESHOLD = 10; // max movement to still count as a tap


const MAX_TERMINAL_WRITE_BYTES = 16_384;
const MAX_TERMINAL_DRAIN_BYTES = 64 * 1024;
const MAX_TERMINAL_DRAIN_MS = 8;
const MIN_TERMINAL_WRITE_BYTES = 512;

function writeTerminalSlice(term: GhosttyTerminal, slice: Uint8Array): boolean {
  try {
    term.write(slice);
    return true;
  } catch (error) {
    terminalMemoryDebugIncrement('terminal.write.failed');
    terminalMemoryDebugMax('terminal.write.failed.maxSliceBytes', slice.byteLength);
    if (slice.byteLength > MIN_TERMINAL_WRITE_BYTES) {
      const midpoint = findUtf8SafeEnd(slice, 0, Math.floor(slice.byteLength / 2));
      if (midpoint > 0 && midpoint < slice.byteLength) {
        terminalMemoryDebugIncrement('terminal.write.retrySplit');
        const firstOk = writeTerminalSlice(term, slice.subarray(0, midpoint));
        const secondOk = writeTerminalSlice(term, slice.subarray(midpoint));
        return firstOk && secondOk;
      }
    }
    console.error('[session-terminal:web] dropping terminal write slice after term.write failed', {
      sliceLength: slice.byteLength,
      viewportY: term.viewportY,
      cols: term.cols,
      rows: term.rows,
      error,
    });
    terminalMemoryDebugIncrement('terminal.write.droppedSlice');
    terminalMemoryDebugIncrement('terminal.write.droppedBytes', slice.byteLength);
    return false;
  }
}

function findUtf8SafeEnd(chunk: Uint8Array, offset: number, maxEnd: number): number {
  let end = maxEnd;
  if (end < chunk.length) {
    let safeEnd = end;
    while (safeEnd > offset && (chunk[safeEnd]! & 0xC0) === 0x80) {
      safeEnd--;
    }
    if (safeEnd > offset) {
      end = safeEnd;
    }
  }
  return end;
}

function createTerminalWritePump(term: GhosttyTerminal, onFatalWriteError: () => void): {
  enqueue(data: Uint8Array): void;
  dispose(): void;
} {
  const queue: Uint8Array[] = [];
  let scheduled = false;
  let disposed = false;
  let frameId: number | null = null;

  let queuedBytes = 0;
  let fatal = false;

  const markFatal = () => {
    if (fatal) return;
    fatal = true;
    disposed = true;
    queue.length = 0;
    queuedBytes = 0;
    terminalMemoryDebugIncrement('terminal.writePump.fatal');
    terminalMemoryDebugGauge('terminal.writePump.queueChunks', 0);
    terminalMemoryDebugGauge('terminal.writePump.queuedBytes', 0);
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    onFatalWriteError();
  };
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    frameId = requestAnimationFrame(drain);
  };

  const drain = () => {
    frameId = null;
    scheduled = false;
    if (disposed || fatal) return;
    const startedAt = performance.now();
    terminalMemoryDebugIncrement('terminal.writePump.drain');
    terminalMemoryDebugGauge('terminal.writePump.queueChunks', queue.length);
    terminalMemoryDebugGauge('terminal.writePump.queuedBytes', queuedBytes);
    let bytesWritten = 0;

    while (queue.length > 0) {
      const chunk = queue[0]!;
      let offset = 0;

      while (offset < chunk.length) {
        const budgetRemaining = Math.max(1, MAX_TERMINAL_DRAIN_BYTES - bytesWritten);
        const maxEnd = Math.min(offset + MAX_TERMINAL_WRITE_BYTES, offset + budgetRemaining, chunk.length);
        let end = findUtf8SafeEnd(chunk, offset, maxEnd);
        if (end <= offset) {
          terminalMemoryDebugIncrement('terminal.writePump.invalidUtf8Boundary');
          end = Math.min(offset + 1, chunk.length);
        }

        const slice = chunk.subarray(offset, end);
        if (!writeTerminalSlice(term, slice)) {
          markFatal();
          return;
        }
        bytesWritten += end - offset;
        offset = end;

        if (bytesWritten >= MAX_TERMINAL_DRAIN_BYTES || performance.now() - startedAt >= MAX_TERMINAL_DRAIN_MS) {
          if (offset < chunk.length) {
            queuedBytes -= offset;
            queue[0] = chunk.subarray(offset);
          } else {
            queue.shift();
          }
          schedule();
          return;
        }
      }

      queue.shift();
      queuedBytes -= chunk.length;
    }
  };

  return {
    enqueue(data: Uint8Array) {
      if (disposed || fatal || data.byteLength === 0) return;
      queue.push(new Uint8Array(data));
      queuedBytes += data.byteLength;
      terminalMemoryDebugIncrement('terminal.writePump.enqueue');
      terminalMemoryDebugMax('terminal.writePump.maxQueuedBytes', queuedBytes);
      terminalMemoryDebugMax('terminal.writePump.maxQueueChunks', queue.length);
      schedule();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      queuedBytes = 0;
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    },
  };
}

function configureMobileHelperTextarea(textarea: HTMLTextAreaElement): void {
  textarea.setAttribute('autocorrect', 'on');
  textarea.setAttribute('autocomplete', 'on');
  textarea.setAttribute('autocapitalize', 'none');
  textarea.setAttribute('inputmode', 'text');
  textarea.setAttribute('enterkeyhint', 'enter');
  textarea.spellcheck = true;
}

function shouldHandleIosWordInput(event: InputEvent): boolean {
  const inputType = event.inputType;
  return (
    inputType === 'insertText' ||
    inputType === 'insertReplacementText' ||
    inputType === 'insertFromComposition'
  );
}

export const SessionTerminal = forwardRef<SessionTerminalHandle, Props>(function SessionTerminal(
  { onData, setWriteCallback, onResize, onActivity, allowTapFocus = true, allowTouchScroll = true, readOnly = false },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminal | null>(null);
  const initializedRef = useRef(false);
  const onDataRef = useRef(onData);
  const onActivityRef = useRef(onActivity);
  const onResizeRef = useRef(onResize);
  const allowTapFocusRef = useRef(allowTapFocus);
  const setWriteCallbackRef = useRef(setWriteCallback);
  const readOnlyRef = useRef(readOnly);
  const followOutputRef = useRef(true);

  // Touch state with accumulated delta pattern
  const touchStateRef = useRef<{
    startY: number;
    lastY: number;
    isTwoFinger: boolean;
    totalMovement: number; // total absolute movement (for tap detection)
    accumulatedDelta: number; // accumulated scroll delta (for batched scrolling)
    isScrolling: boolean;
    hasSelection: boolean; // whether user is selecting text
  } | null>(null);

  // Keep refs up to date
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    allowTapFocusRef.current = allowTapFocus;
  }, [allowTapFocus]);

  // Ref for touch scroll prop (accessed in event handlers)
  const allowTouchScrollRef = useRef(allowTouchScroll);
  useEffect(() => {
    allowTouchScrollRef.current = allowTouchScroll;
  }, [allowTouchScroll]);

  useEffect(() => {
    setWriteCallbackRef.current = setWriteCallback;
  }, [setWriteCallback]);

  // Keep readOnly ref in sync
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  const tryConsumePageNavigation = useCallback((direction: PageDirection): boolean => {
    const terminal = terminalRef.current as unknown as TerminalViewportLike | null;
    if (!terminal) {
      return false;
    }

    const viewportY = terminal.viewportY ?? 0;
    const baseY = terminal.buffer?.active?.baseY ?? 0;
    const canConsume = canConsumePageNavigationInViewport({
      direction,
      viewportY,
      baseY,
    });

    if (!canConsume) {
      return false;
    }

    const linesPerPage = Math.max(1, (terminal.rows ?? 1) - 1);
    terminal.scrollLines(direction === 'up' ? -linesPerPage : linesPerPage);
    syncFollowOutputState();
    onActivityRef.current?.();
    return true;
  }, []);

  const syncFollowOutputState = useCallback(() => {
    const terminal = terminalRef.current as unknown as TerminalViewportLike | null;
    if (!terminal) {
      return;
    }
    // viewportY is the live scroll position. With our wheel intercept in place,
    // every scroll path (scrollLines / scrollToLine / scrollToBottom / scrollbar
    // drag) keeps viewportY integer, so a strict === 0 check is reliable.
    // targetViewportY is only updated by smoothScrollTo — which we bypass, so
    // it stays stale at 0 forever and would falsely report "at bottom".
    followOutputRef.current = (terminal.viewportY ?? 0) === 0;
  }, []);

  // Expose methods via ref for external control (e.g., from TerminalControls)
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        terminalRef.current?.focus();
      },
      blur: () => {
        // Blur the hidden textarea to dismiss keyboard on mobile
        if (containerRef.current) {
          const textarea = containerRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
          textarea?.blur();
        }
      },
      sendData: (data: string) => {
        onDataRef.current(new TextEncoder().encode(data));
      },
      isFocused: () => {
        if (!containerRef.current) return false;
        const textarea = containerRef.current.querySelector('.xterm-helper-textarea');
        return textarea ? document.activeElement === textarea : false;
      },
      getSize: () => {
        const term = terminalRef.current;
        if (!term || term.cols <= 0 || term.rows <= 0) {
          return null;
        }
        return { cols: term.cols, rows: term.rows };
      },
      pageUp: () => tryConsumePageNavigation('up'),
      pageDown: () => tryConsumePageNavigation('down'),
    }),
    [tryConsumePageNavigation]
  );

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;
    terminalMemoryDebugIncrement('terminal.mountEffect');
    let disposed = false;
    let teardown: (() => void) | null = null;

    void init()
      .then(() => {
        if (disposed || !containerRef.current) {
          return;
        }

        const container = containerRef.current;

        // Resolve CSS custom properties — xterm needs actual color values,
        // not var() references.
        const cs = getComputedStyle(document.documentElement);
        const v = (name: string) => cs.getPropertyValue(name).trim();

        terminalMemoryDebugIncrement('terminal.created');
        terminalMemoryDebugIncrement('terminal.activeInstances');
        const term = new GhosttyTerminal({
          scrollback: WEB_TERMINAL_SCROLLBACK,
          fontSize: 14,
          fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, monospace",
          theme: {
            background: v('--gs-terminal-bg'),
            foreground: v('--gs-terminal-fg'),
            cursor: v('--gs-terminal-cursor'),
            cursorAccent: v('--gs-terminal-cursor-accent'),
            selectionBackground: v('--gs-terminal-selection'),
            selectionForeground: v('--gs-terminal-fg'),
            black: '#484f58',
            red: '#ff7b72',
            green: '#3fb950',
            yellow: '#d29922',
            blue: '#58a6ff',
            magenta: '#bc8cff',
            cyan: '#39c5cf',
            white: '#b1bac4',
            brightBlack: '#6e7681',
            brightRed: '#ffa198',
            brightGreen: '#56d364',
            brightYellow: '#e3b341',
            brightBlue: '#79c0ff',
            brightMagenta: '#d2a8ff',
            brightCyan: '#56d4dd',
            brightWhite: '#f0f6fc',
          },
        });

        term.open(container);
        terminalMemoryDebugIncrement('terminal.opened');
        terminalRef.current = term;

        const fitAddon = new FitAddon();

        // The FitAddon reserves 15px for a native scrollbar that ghostty
        // does not use (it renders its own overlay scrollbar on the canvas).
        // Override proposeDimensions to reclaim that space.
        const originalPropose = fitAddon.proposeDimensions.bind(fitAddon);
        fitAddon.proposeDimensions = () => {
          const dims = originalPropose();
          if (!dims) return dims;
          // The original subtracted a 15px scrollbar constant from width.
          // Ghostty's canvas-based scrollbar doesn't need it, so we add
          // one extra column back when the cell width allows it.
          const renderer = (term as any).renderer;
          if (renderer && typeof renderer.getMetrics === 'function') {
            const metrics = renderer.getMetrics();
            if (metrics && metrics.width > 0) {
              const element = (term as any).element;
              if (element) {
                const style = window.getComputedStyle(element);
                const padL = parseInt(style.paddingLeft) || 0;
                const padR = parseInt(style.paddingRight) || 0;
                const available = element.clientWidth - padL - padR;
                const cols = Math.max(2, Math.floor(available / metrics.width));
                return { cols, rows: dims.rows };
              }
            }
          }
          return dims;
        };

        term.loadAddon(fitAddon);

        term.onData((data: string) => {
          if (readOnlyRef.current) {
            return;
          }
          onActivityRef.current?.();
          onDataRef.current(new TextEncoder().encode(data));
        });

        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Tab' && event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            if (readOnlyRef.current) {
              return;
            }
            onDataRef.current(new TextEncoder().encode('\x1b[Z'));
            return;
          }

          if (event.key === 'PageUp') {
            if (tryConsumePageNavigation('up')) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }

          if (event.key === 'PageDown') {
            if (tryConsumePageNavigation('down')) {
              event.preventDefault();
              event.stopPropagation();
            }
          }
        };
        container.addEventListener('keydown', handleKeyDown, true);

        const isIOS = isIOSDevice();
        const helperTextarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        let isComposing = false;

        const handleHelperFocus = () => {
          if (!isIOS || !helperTextarea) {
            return;
          }
          configureMobileHelperTextarea(helperTextarea);
        };

        const handleCompositionStart = () => {
          if (!isIOS) {
            return;
          }
          isComposing = true;
        };

        const handleCompositionEnd = () => {
          if (!isIOS) {
            return;
          }
          isComposing = false;
        };

        const handleInputFallback = (event: Event) => {
          if (!isIOS || !helperTextarea || isComposing || readOnlyRef.current) {
            return;
          }

          const inputEvent = event as InputEvent;
          if (!shouldHandleIosWordInput(inputEvent)) {
            return;
          }

          // xterm usually consumes normal key input and clears helper value.
          // Keep this as an iOS fallback for word-level commits (swipe/predictive text).
          const value = helperTextarea.value;
          if (value.length <= 1) {
            return;
          }

          onActivityRef.current?.();
          onDataRef.current(new TextEncoder().encode(value));
          helperTextarea.value = '';
        };

        if (helperTextarea) {
          if (isIOS) {
            configureMobileHelperTextarea(helperTextarea);
          }
          helperTextarea.addEventListener('focus', handleHelperFocus);
          helperTextarea.addEventListener('compositionstart', handleCompositionStart);
          helperTextarea.addEventListener('compositionend', handleCompositionEnd);
          helperTextarea.addEventListener('input', handleInputFallback);
        }

        const handlePreventTouchFocus = (e: Event) => {
          if (!allowTapFocusRef.current) {
            e.stopPropagation();
            e.preventDefault();
            touchStateRef.current = null;
          }
        };
        container.addEventListener('touchend', handlePreventTouchFocus, { capture: true });

        const handleTouchStart = (e: TouchEvent) => {
          if (!allowTouchScrollRef.current) return;

          const selection = window.getSelection();
          const hasSelection = selection ? selection.toString().length > 0 : false;

          touchStateRef.current = {
            startY: e.touches[0].clientY,
            lastY: e.touches[0].clientY,
            isTwoFinger: e.touches.length >= 2,
            totalMovement: 0,
            accumulatedDelta: 0,
            isScrolling: false,
            hasSelection,
          };
        };

        const handleTouchMove = (e: TouchEvent) => {
          if (!allowTouchScrollRef.current || !touchStateRef.current) return;
          if (touchStateRef.current.hasSelection) return;
          if (touchStateRef.current.isTwoFinger) return;

          const currentY = e.touches[0].clientY;
          const deltaY = touchStateRef.current.lastY - currentY;
          touchStateRef.current.totalMovement += Math.abs(deltaY);

          if (touchStateRef.current.totalMovement > SCROLL_THRESHOLD) {
            touchStateRef.current.isScrolling = true;
            e.preventDefault();
            touchStateRef.current.accumulatedDelta += deltaY;

            const scrollEvents = Math.trunc(
              touchStateRef.current.accumulatedDelta / SCROLL_ACCUMULATOR_THRESHOLD
            );

            if (scrollEvents !== 0 && terminalRef.current) {
              terminalRef.current.scrollLines(scrollEvents);
              touchStateRef.current.accumulatedDelta -=
                scrollEvents * SCROLL_ACCUMULATOR_THRESHOLD;
              requestAnimationFrame(() => {
                syncFollowOutputState();
              });
            }
          }

          touchStateRef.current.lastY = currentY;
        };

        const handleTouchEnd = () => {
          const wasTap =
            touchStateRef.current &&
            touchStateRef.current.totalMovement < TAP_MOVE_THRESHOLD;

          if (wasTap && terminalRef.current) {
            onActivityRef.current?.();
            if (allowTapFocusRef.current) {
              terminalRef.current.focus();
            }
          }

          touchStateRef.current = null;
          syncFollowOutputState();
        };

        // Pixel-mode wheel events (trackpad, Magic Mouse, etc.) produce
        // fractional deltaY/rowHeight line deltas. ghostty-web's internal
        // handler passes that fractional value straight to smoothScrollTo,
        // which leaves viewportY fractional at rest. The renderer's row-index
        // arithmetic uses Math.floor(viewportY) while its scrollback/viewport
        // branch uses raw viewportY, so one screen row per frame resolves to
        // a null scrollback line and is skipped entirely — pixels from the
        // previous paint persist (the 'ghost row' we see on empty lines).
        //
        // We intercept pixel-mode wheel events on document in capture phase
        // (earlier than ghostty-web's own capture listener on the element),
        // accumulate fractional pixel deltas into whole rows, and call
        // scrollLines() which always keeps viewportY integer.
        let wheelAccumPx = 0;
        const handleWheelCapture = (event: WheelEvent) => {
          if (!container.contains(event.target as Node)) return;
          if (event.deltaMode !== 0) return;    // line/page mode is already integer
          if (event.deltaY === 0) return;
          // In alt-screen mode ghostty-web translates wheel to arrow keys for
          // apps like vim/less. Leave that path alone.
          if ((term as { wasmTerm?: { isAlternateScreen?: () => boolean } }).wasmTerm?.isAlternateScreen?.()) return;

          event.preventDefault();
          event.stopPropagation();

          const metrics = (term as { renderer?: { getMetrics?: () => { height: number } } }).renderer?.getMetrics?.();
          const rowHeight = metrics?.height ?? 20;
          wheelAccumPx += event.deltaY;
          const lines = Math.trunc(wheelAccumPx / rowHeight);
          wheelAccumPx -= lines * rowHeight;
          if (lines !== 0) {
            // scrollLines: positive = scroll content up (reveal newer output).
            // event.deltaY > 0 means wheel scrolled down = scroll content up.
            term.scrollLines(lines);
          }
          syncFollowOutputState();
        };

        // Keep the existing element-scoped handler purely for follow-state
        // tracking. Its pixel-mode path is a no-op because our capture
        // interceptor has already preventDefault'd and stopPropagation'd.
        const handleWheel = () => {
          syncFollowOutputState();
        };

        container.addEventListener('touchstart', handleTouchStart, { passive: true });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd, { passive: true });
        container.addEventListener('wheel', handleWheel, { passive: true });
        document.addEventListener('wheel', handleWheelCapture, { passive: false, capture: true });

        // Ghostty-web's writeInternal() unconditionally calls scrollToBottom()
        // on every write when viewportY !== 0. This makes it impossible to
        // scroll up while output is streaming. Patch the instance to suppress
        // scroll-to-bottom when the user has intentionally scrolled away.
        // followOutputRef tracks whether the user is pinned to bottom.
        const originalScrollToBottom = term.scrollToBottom.bind(term);
        term.scrollToBottom = () => {
          if (followOutputRef.current) {
            originalScrollToBottom();
          }
        };

        // Also track scroll state via ghostty-web's own onScroll event.
        // This catches programmatic scrollLines() calls (e.g. page up/down)
        // and any internal scroll state changes we might miss from DOM events.
        const scrollDisposable = term.onScroll(() => {
          syncFollowOutputState();
        });

        const writePump = createTerminalWritePump(term, () => {
          setWriteCallbackRef.current(null);
          terminalMemoryDebugIncrement('terminal.writeCallback.clear.fatal');
        });
        terminalMemoryDebugIncrement('terminal.writeCallback.register');
        setWriteCallbackRef.current((data: Uint8Array) => {
          writePump.enqueue(data);
        });

        const handleResize = () => {
        terminalMemoryDebugIncrement('terminal.resize');
          fitAddon.fit();
          terminalMemoryDebugIncrement('terminal.fit');
          if (term.cols && term.rows && onResizeRef.current) {
            onResizeRef.current(term.cols, term.rows);
          }
        };

        const observer = new ResizeObserver(() => {
          terminalMemoryDebugIncrement('terminal.resizeObserver');
          handleResize();
        });
        observer.observe(container);

        requestAnimationFrame(() => {
          setTimeout(() => {
            handleResize();
          }, 50);
        });

        if (allowTapFocusRef.current) {
          term.focus();
        }

        teardown = () => {
          terminalMemoryDebugIncrement('terminal.disposed');
          terminalMemoryDebugDecrement('terminal.activeInstances');
          container.removeEventListener('keydown', handleKeyDown, true);
          if (helperTextarea) {
            helperTextarea.removeEventListener('focus', handleHelperFocus);
            helperTextarea.removeEventListener('compositionstart', handleCompositionStart);
            helperTextarea.removeEventListener('compositionend', handleCompositionEnd);
            helperTextarea.removeEventListener('input', handleInputFallback);
          }
          container.removeEventListener('touchend', handlePreventTouchFocus, true);
          container.removeEventListener('touchstart', handleTouchStart);
          container.removeEventListener('touchmove', handleTouchMove);
          container.removeEventListener('touchend', handleTouchEnd);
          container.removeEventListener('wheel', handleWheel);
          document.removeEventListener('wheel', handleWheelCapture, { capture: true });
          writePump.dispose();
          scrollDisposable.dispose();
          observer.disconnect();
          term.dispose();
          terminalRef.current = null;
          setWriteCallbackRef.current(null);
          terminalMemoryDebugIncrement('terminal.writeCallback.clear');
        };
      })
      .catch(() => {
        setWriteCallbackRef.current(null);
      });

    return () => {
      disposed = true;
      initializedRef.current = false;
      touchStateRef.current = null;
      if (teardown) {
        teardown();
      } else {
        setWriteCallbackRef.current(null);
        terminalMemoryDebugIncrement('terminal.writeCallback.clear.beforeReady');
      }
    };
  }, [syncFollowOutputState, tryConsumePageNavigation]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[var(--gs-bg)]"
    />
  );
});
