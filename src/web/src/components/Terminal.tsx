import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";

interface Props {
  onData: (data: Uint8Array) => void;
  setWriteCallback: (fn: (data: Uint8Array) => void) => void;
  onResize?: (cols: number, rows: number) => void;
  /** Called when user interacts with terminal (for activity tracking) */
  onActivity?: () => void;
  /** Whether tapping the terminal should focus it (opens keyboard on mobile). Default: true */
  allowTapFocus?: boolean;
  /** Whether touch scrolling is enabled. Default: true. Disable when using floating controls. */
  allowTouchScroll?: boolean;
}

/** Methods exposed via ref for external control */
export interface TerminalHandle {
  focus: () => void;
  blur: () => void;
  sendData: (data: string) => void;
  isFocused: () => boolean;
}

// Touch scrolling constants (agentboard-inspired accumulated delta pattern)
const SCROLL_THRESHOLD = 10; // pixels before we consider it a scroll vs tap
const SCROLL_ACCUMULATOR_THRESHOLD = 30; // pixels of accumulated delta before sending scroll
const TAP_MOVE_THRESHOLD = 10; // max movement to still count as a tap

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal(
  { onData, setWriteCallback, onResize, onActivity, allowTapFocus = true, allowTouchScroll = true },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminal | null>(null);
  const initializedRef = useRef(false);
  const onDataRef = useRef(onData);
  const onActivityRef = useRef(onActivity);
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
    }),
    []
  );

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    init().then(() => {
      if (!containerRef.current) return;

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
          // GitHub Dark colors
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

      term.open(containerRef.current);
      terminalRef.current = term;

      // Create and load FitAddon for automatic sizing
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Wire up input
      term.onData((data: string) => {
        onActivityRef.current?.(); // Track user activity
        onDataRef.current(new TextEncoder().encode(data));
      });

      // Handle Shift+Tab separately via DOM event listener
      // (xterm's attachCustomKeyEventHandler breaks other keys in ghostty-web)
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Tab' && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onDataRef.current(new TextEncoder().encode('\x1b[Z'));
        }
      };
      containerRef.current.addEventListener('keydown', handleKeyDown, true); // capture phase

      // Prevent ghostty-web from auto-focusing on tap when input mode is off (mobile only)
      // ghostty-web's canvas touchend handler calls textarea.focus()
      // We intercept in capture phase, stop propagation, and preventDefault to also block synthetic mouse events
      const handlePreventTouchFocus = (e: Event) => {
        if (!allowTapFocusRef.current) {
          e.stopPropagation();
          e.preventDefault();
          // Clean up touch state since our bubble-phase touchend handler won't fire
          touchStateRef.current = null;
        }
      };
      containerRef.current.addEventListener('touchend', handlePreventTouchFocus, { capture: true });

      // Mobile touch scrolling with accumulated delta pattern (agentboard-inspired)
      // Benefits: reduces terminal I/O, feels more natural, prevents accidental scrolls
      // Single finger vertical swipe = scroll terminal history
      // Tap (no movement) = focus terminal / show keyboard

      const handleTouchStart = (e: TouchEvent) => {
        // Skip if touch scrolling is disabled (using floating controls instead)
        if (!allowTouchScrollRef.current) return;

        // Check if user has text selected (don't scroll during selection)
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

        // Don't scroll while text is selected
        if (touchStateRef.current.hasSelection) return;

        // Don't handle two-finger gestures (could be pinch zoom)
        if (touchStateRef.current.isTwoFinger) return;

        const currentY = e.touches[0].clientY;
        const deltaY = touchStateRef.current.lastY - currentY;

        // Track total movement for tap detection
        touchStateRef.current.totalMovement += Math.abs(deltaY);

        // Once we've moved enough, consider it a scroll gesture
        if (touchStateRef.current.totalMovement > SCROLL_THRESHOLD) {
          touchStateRef.current.isScrolling = true;

          // Prevent page scroll and pull-to-refresh
          e.preventDefault();

          // Accumulate delta for batched scrolling
          touchStateRef.current.accumulatedDelta += deltaY;

          // Only send scroll when accumulated delta crosses threshold
          const scrollEvents = Math.trunc(
            touchStateRef.current.accumulatedDelta / SCROLL_ACCUMULATOR_THRESHOLD
          );

          if (scrollEvents !== 0 && terminalRef.current) {
            // Send scroll events
            terminalRef.current.scrollLines(scrollEvents);

            // Keep remainder for smooth continuation without relying on % sign behavior
            touchStateRef.current.accumulatedDelta -=
              scrollEvents * SCROLL_ACCUMULATOR_THRESHOLD;
          }
        }

        touchStateRef.current.lastY = currentY;
      };

      const handleTouchEnd = () => {
        // Check if it was a tap (minimal movement)
        const wasTap =
          touchStateRef.current &&
          touchStateRef.current.totalMovement < TAP_MOVE_THRESHOLD;

        // If it was a tap, track activity and focus if allowed
        if (wasTap && terminalRef.current) {
          onActivityRef.current?.();
          // When allowTapFocus is false, taps won't open the keyboard on mobile
          if (allowTapFocusRef.current) {
            terminalRef.current.focus();
          }
        }

        touchStateRef.current = null;
      };

      // Prevent default touchmove on the container to stop page scroll
      containerRef.current.addEventListener('touchstart', handleTouchStart, { passive: true });
      containerRef.current.addEventListener('touchmove', handleTouchMove, { passive: false });
      containerRef.current.addEventListener('touchend', handleTouchEnd, { passive: true });

      // Set up the write callback so parent can write to terminal
      // Preserve scroll position if user has scrolled up (not at bottom)
      setWriteCallback((data: Uint8Array) => {
        const wasScrolledUp = term.viewportY > 0;
        const viewportBefore = term.viewportY;

        term.write(new TextDecoder().decode(data));

        // If user was scrolled up, restore their relative position
        // viewportY = 0 is bottom, > 0 is scrolled up
        if (wasScrolledUp && term.viewportY === 0) {
          // Terminal auto-scrolled to bottom, scroll back up
          // Add a small buffer since new content was added
          requestAnimationFrame(() => {
            term.scrollLines(-viewportBefore);
          });
        }
      });

      // Handle resize - use FitAddon to calculate cols/rows from container size
      const handleResize = () => {
        fitAddon.fit();  // Calculate and apply cols/rows based on container dimensions
        if (term.cols && term.rows && onResize) {
          console.log(`[Terminal] Resize: ${term.cols}x${term.rows}`);
          onResize(term.cols, term.rows);
        }
      };

      // Use ResizeObserver for container size changes
      const observer = new ResizeObserver(() => {
        handleResize();
      });
      observer.observe(containerRef.current);

      // Send initial resize after a short delay to ensure terminal is ready
      // Use requestAnimationFrame to ensure layout is complete
      requestAnimationFrame(() => {
        setTimeout(() => {
          handleResize();
        }, 50);
      });

      // Focus terminal only if tap focus is allowed (don't auto-open keyboard on mobile)
      if (allowTapFocusRef.current) {
        term.focus();
      }

      return () => {
        containerRef.current?.removeEventListener('keydown', handleKeyDown, true);
        containerRef.current?.removeEventListener('touchend', handlePreventTouchFocus, { capture: true });
        containerRef.current?.removeEventListener('touchstart', handleTouchStart);
        containerRef.current?.removeEventListener('touchmove', handleTouchMove);
        containerRef.current?.removeEventListener('touchend', handleTouchEnd);
        observer.disconnect();
        term.dispose();
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setWriteCallback, onResize]); // onData is accessed via ref

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[#0d1117]"
    />
  );
});
