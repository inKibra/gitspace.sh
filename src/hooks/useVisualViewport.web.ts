import { useEffect, useCallback, useState } from 'react';

/** Threshold in pixels to consider the keyboard visible */
const KEYBOARD_THRESHOLD = 100;

/**
 * Hook to track the visual viewport and detect keyboard visibility.
 * Sets CSS custom properties for dynamic layout adjustment:
 * - --visual-viewport-height: actual visible height (shrinks when keyboard shows)
 * - --keyboard-inset: keyboard height for positioning elements above it
 *
 * On iOS Safari, visualViewport.height shrinks when the keyboard appears,
 * but window.innerHeight may stay the same. We use visualViewport directly
 * for accurate sizing.
 *
 * @returns Whether the keyboard is currently visible
 */
export function useVisualViewport(): boolean {
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const updateViewport = useCallback(() => {
    if (typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    if (!viewport) {
      // Fallback for browsers without Visual Viewport API
      document.documentElement.style.setProperty('--visual-viewport-height', '100dvh');
      document.documentElement.style.setProperty('--keyboard-inset', '0px');
      setKeyboardVisible(false);
      return;
    }

    // Use visualViewport.height directly - this is the actual visible area
    // On iOS Safari this shrinks when the keyboard appears
    const viewportHeight = viewport.height;

    // Account for any offset (e.g., when page is scrolled with keyboard)
    const offsetTop = viewport.offsetTop || 0;

    // Calculate keyboard height from the difference between window and viewport
    // On iOS Safari, window.innerHeight may not change, but visualViewport.height does
    const keyboardHeight = Math.max(0, window.innerHeight - viewportHeight - offsetTop);

    // Set CSS custom properties
    document.documentElement.style.setProperty('--visual-viewport-height', `${viewportHeight}px`);
    document.documentElement.style.setProperty('--keyboard-inset', `${keyboardHeight}px`);

    // Update keyboard visibility state
    setKeyboardVisible(keyboardHeight > KEYBOARD_THRESHOLD);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Initial update (works even without visualViewport)
    updateViewport();

    const viewport = window.visualViewport;
    if (!viewport) {
      // No Visual Viewport API - just listen to window resize
      window.addEventListener('resize', updateViewport);
      return () => {
        window.removeEventListener('resize', updateViewport);
      };
    }

    // Listen for viewport changes (keyboard show/hide, resize, scroll)
    viewport.addEventListener('resize', updateViewport);
    viewport.addEventListener('scroll', updateViewport);

    // Also listen to window resize as fallback
    window.addEventListener('resize', updateViewport);

    return () => {
      viewport.removeEventListener('resize', updateViewport);
      viewport.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [updateViewport]);

  return keyboardVisible;
}

/**
 * Returns current keyboard height in pixels.
 * Useful for imperative checks.
 */
export function getKeyboardHeight(): number {
  if (typeof window === 'undefined') return 0;

  const viewport = window.visualViewport;
  if (!viewport) return 0;

  const offsetTop = viewport.offsetTop || 0;
  return Math.max(0, window.innerHeight - viewport.height - offsetTop);
}

/**
 * Returns whether the keyboard is currently visible.
 * Uses a threshold to avoid false positives from small viewport changes.
 */
export function isKeyboardVisible(threshold = 100): boolean {
  return getKeyboardHeight() > threshold;
}
