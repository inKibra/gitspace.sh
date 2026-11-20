import { clearDevice, loadDevice, type BrowserDevice } from './device.js';
import { clearFirstPaintCache } from './first-paint-cache.js';

/**
 * Process-wide handle on the enrolled device so every RPC client shares one
 * identity and one rejection path. The gate in LiveApp owns transitions;
 * this module only holds the current value and broadcasts rejection.
 */
let pending: Promise<BrowserDevice | null> | null = null;

/** The enrolled device; a storage failure is not remembered, so the next call reads IndexedDB again. */
export function currentDevice(): Promise<BrowserDevice | null> {
  if (pending) return pending;
  const load: Promise<BrowserDevice | null> = loadDevice().catch((error: unknown) => {
    if (pending === load) pending = null;
    throw error;
  });
  pending = load;
  return load;
}

export function setCurrentDevice(device: BrowserDevice | null): void {
  pending = Promise.resolve(device);
}

export const DEVICE_REJECTED_EVENT = 'gitspace:device-rejected';

/** The machine no longer accepts this device (signed out or revoked): drop it and everything this browser saved for
 * it, and let the gate re-render. A record that fails to erase is rejected again on the next load. */
export function deviceRejected(code: string): void {
  setCurrentDevice(null);
  void clearDevice().catch(() => undefined);
  void clearFirstPaintCache();
  window.dispatchEvent(new CustomEvent(DEVICE_REJECTED_EVENT, { detail: { code } }));
}
