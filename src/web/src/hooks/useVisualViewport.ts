import { useEffect, useCallback } from 'react';

/**
 * Hook to track the visual viewport and detect keyboard visibility.
 * Sets CSS custom property --keyboard-inset for dynamic layout adjustment.
 *
 * The Visual Viewport API accounts for the on-screen keyboard on mobile devices.
 * When the keyboard appears, visualViewport.height shrinks while window.innerHeight
 * may or may not change depending on the browser. The difference gives us keyboard height.
 */
export function useVisualViewport(): void {
  const updateKeyboardInset = useCallback(() => {
    if (typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    if (!viewport) {
      // Fallback for browsers without Visual Viewport API
      document.documentElement.style.setProperty('--keyboard-inset', '0px');
      return;
    }

    // Calculate keyboard height from the difference between window and viewport
    const keyboardHeight = window.innerHeight - viewport.height;

    // Only set positive values (keyboard visible) or zero
    const inset = Math.max(0, keyboardHeight);
    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    // Initial update
    updateKeyboardInset();

    // Listen for viewport changes (keyboard show/hide, resize, scroll)
    viewport.addEventListener('resize', updateKeyboardInset);
    viewport.addEventListener('scroll', updateKeyboardInset);

    // Also listen to window resize as fallback
    window.addEventListener('resize', updateKeyboardInset);

    return () => {
      viewport.removeEventListener('resize', updateKeyboardInset);
      viewport.removeEventListener('scroll', updateKeyboardInset);
      window.removeEventListener('resize', updateKeyboardInset);
    };
  }, [updateKeyboardInset]);
}

/**
 * Returns current keyboard height in pixels.
 * Useful for imperative checks.
 */
export function getKeyboardHeight(): number {
  if (typeof window === 'undefined') return 0;

  const viewport = window.visualViewport;
  if (!viewport) return 0;

  return Math.max(0, window.innerHeight - viewport.height);
}

/**
 * Returns whether the keyboard is currently visible.
 * Uses a threshold to avoid false positives from small viewport changes.
 */
export function isKeyboardVisible(threshold = 100): boolean {
  return getKeyboardHeight() > threshold;
}
