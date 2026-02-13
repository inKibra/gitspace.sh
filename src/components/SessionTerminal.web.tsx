import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";

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
}

/** Methods exposed via ref for external control */
export interface SessionTerminalHandle {
  focus: () => void;
  blur: () => void;
  sendData: (data: string) => void;
  isFocused: () => boolean;
  getSize: () => { cols: number; rows: number } | null;
}

// Touch scrolling constants (agentboard-inspired accumulated delta pattern)
const SCROLL_THRESHOLD = 10; // pixels before we consider it a scroll vs tap
const SCROLL_ACCUMULATOR_THRESHOLD = 30; // pixels of accumulated delta before sending scroll
const TAP_MOVE_THRESHOLD = 10; // max movement to still count as a tap

export const SessionTerminal = forwardRef<SessionTerminalHandle, Props>(function SessionTerminal(
  { onData, setWriteCallback, onResize, onActivity, allowTapFocus = true, allowTouchScroll = true },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminal | null>(null);
  const initializedRef = useRef(false);
  const onDataRef = useRef(onData);
  const onActivityRef = useRef(onActivity);
  const onResizeRef = useRef(onResize);
  const allowTapFocusRef = useRef(allowTapFocus);

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
    }),
    []
  );

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;
    let disposed = false;
    let teardown: (() => void) | null = null;

    void init()
      .then(() => {
        if (disposed || !containerRef.current) {
          return;
        }

        const container = containerRef.current;
        const term = new GhosttyTerminal({
          fontSize: 14,
          fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, monospace",
          theme: {
            background: "#0d1117",
            foreground: "#e6edf3",
            cursor: "#22c55e",
            cursorAccent: "#0d1117",
            selectionBackground: "#22c55e33",
            selectionForeground: "#e6edf3",
            black: "#484f58",
            red: "#ff7b72",
            green: "#3fb950",
            yellow: "#d29922",
            blue: "#58a6ff",
            magenta: "#bc8cff",
            cyan: "#39c5cf",
            white: "#b1bac4",
            brightBlack: "#6e7681",
            brightRed: "#ffa198",
            brightGreen: "#56d364",
            brightYellow: "#e3b341",
            brightBlue: "#79c0ff",
            brightMagenta: "#d2a8ff",
            brightCyan: "#56d4dd",
            brightWhite: "#f0f6fc",
          },
        });

        term.open(container);
        terminalRef.current = term;

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        term.onData((data: string) => {
          onActivityRef.current?.();
          onDataRef.current(new TextEncoder().encode(data));
        });

        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Tab' && event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            onDataRef.current(new TextEncoder().encode('\x1b[Z'));
          }
        };
        container.addEventListener('keydown', handleKeyDown, true);

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
        };

        container.addEventListener('touchstart', handleTouchStart, { passive: true });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd, { passive: true });

        setWriteCallback((data: Uint8Array) => {
          const wasScrolledUp = term.viewportY > 0;
          const viewportBefore = term.viewportY;

          term.write(new TextDecoder().decode(data));

          if (wasScrolledUp && term.viewportY === 0) {
            requestAnimationFrame(() => {
              term.scrollLines(-viewportBefore);
            });
          }
        });

        const handleResize = () => {
          fitAddon.fit();
          if (term.cols && term.rows && onResizeRef.current) {
            onResizeRef.current(term.cols, term.rows);
          }
        };

        const observer = new ResizeObserver(() => {
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
          container.removeEventListener('keydown', handleKeyDown, true);
          container.removeEventListener('touchend', handlePreventTouchFocus, true);
          container.removeEventListener('touchstart', handleTouchStart);
          container.removeEventListener('touchmove', handleTouchMove);
          container.removeEventListener('touchend', handleTouchEnd);
          observer.disconnect();
          term.dispose();
          terminalRef.current = null;
          setWriteCallback(null);
        };
      })
      .catch(() => {
        setWriteCallback(null);
      });

    return () => {
      disposed = true;
      touchStateRef.current = null;
      if (teardown) {
        teardown();
      } else {
        setWriteCallback(null);
      }
    };
  }, [setWriteCallback]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[#0d1117]"
    />
  );
});
