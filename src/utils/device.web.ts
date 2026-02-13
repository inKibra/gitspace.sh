/**
 * Device detection utilities for mobile-specific behavior.
 * Comprehensive detection for iOS, Safari, PWA, and touch devices.
 */

/**
 * Detect iOS devices (iPhone, iPad, iPod).
 * Includes detection for iPadOS 13+ which reports as MacIntel but has touch.
 */
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);

  // iPadOS 13+ reports as MacIntel but has touch support
  const iPadOS =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  return iOS || iPadOS;
}

/**
 * Detect if running as an installed PWA on iOS (standalone mode).
 */
export function isIOSPWA(): boolean {
  if (!isIOSDevice()) return false;
  return (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * Detect Safari browser (but not Chrome which includes "Safari" in UA).
 */
export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent;
  return (
    /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua)
  );
}

/**
 * Detect Android devices.
 */
export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/.test(navigator.userAgent);
}

/**
 * Detect any mobile device (iOS or Android).
 */
export function isMobileDevice(): boolean {
  return isIOSDevice() || isAndroidDevice();
}

/**
 * Detect touch-capable device.
 * More reliable than checking for mobile OS since laptops can have touch.
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;

  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    // @ts-expect-error - msMaxTouchPoints is IE-specific
    navigator.msMaxTouchPoints > 0
  );
}

/**
 * Detect if device has a coarse pointer (finger/stylus vs mouse).
 * Uses CSS media query for reliable detection.
 */
export function hasCoarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Detect if device cannot hover (touch-only, no mouse).
 */
export function cannotHover(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: none)').matches;
}

/**
 * Detect mobile layout based on viewport width.
 * Uses the same breakpoint as Tailwind's sm: (640px) or custom.
 */
export function isMobileLayout(breakpoint = 768): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
}

/**
 * Get platform-specific modifier key name.
 * Returns 'Cmd' on Mac/iOS, 'Ctrl' on others.
 */
export function getPlatformModifier(): 'Cmd' | 'Ctrl' {
  if (typeof navigator === 'undefined') return 'Ctrl';

  const isMac =
    navigator.platform?.startsWith('Mac') ||
    isIOSDevice();

  return isMac ? 'Cmd' : 'Ctrl';
}

/**
 * Trigger haptic feedback if supported.
 * @param duration - Vibration duration in milliseconds (default: 10)
 */
export function triggerHaptic(duration = 10): void {
  if (typeof navigator === 'undefined') return;

  if ('vibrate' in navigator) {
    try {
      navigator.vibrate(duration);
    } catch (err) {
      // Log in development for debugging
      if (import.meta.env.DEV) {
        console.debug('Haptic feedback not available:', err);
      }
    }
  }
}

/**
 * Apply device-specific CSS classes to document element.
 * Call once on app initialization.
 */
export function applyDeviceClasses(): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  if (isIOSDevice()) {
    root.classList.add('ios-device');
    if (isIOSPWA()) {
      root.classList.add('ios-pwa');
    }
  }

  if (isSafari()) {
    root.classList.add('safari');
  }

  if (isAndroidDevice()) {
    root.classList.add('android-device');
  }

  if (isTouchDevice()) {
    root.classList.add('touch-device');
  }

  if (hasCoarsePointer()) {
    root.classList.add('coarse-pointer');
  }
}
