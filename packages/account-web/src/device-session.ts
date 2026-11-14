import { clearDevice, loadDevice, type BrowserDevice } from './device.js';
import { clearFirstPaintCache } from './first-paint-cache.js';

/**
 * Process-wide handle on the enrolled device so every RPC client shares one
 * identity and one rejection path. The gate in LiveApp owns transitions;
 * this module only holds the current value and broadcasts rejection.
 */
let pending: Promise<BrowserDevice | null> | null = null;

export function currentDevice(): Promise<BrowserDevice | null> {
  pending ??= loadDevice();
  return pending;
}

export function setCurrentDevice(device: BrowserDevice | null): void {
  pending = Promise.resolve(device);
}

export const DEVICE_REJECTED_EVENT = 'gitspace:device-rejected';

/** The machine no longer accepts this device (signed out or revoked): drop it and everything this browser saved for
 * it, and let the gate re-render. */
export function deviceRejected(code: string): void {
  setCurrentDevice(null);
  void clearDevice();
  void clearFirstPaintCache();
  window.dispatchEvent(new CustomEvent(DEVICE_REJECTED_EVENT, { detail: { code } }));
}
