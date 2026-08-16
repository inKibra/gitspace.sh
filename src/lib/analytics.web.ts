/**
 * PostHog analytics + error tracking (docs/REPORT-A-PROBLEM.md).
 *
 * OPT-IN by construction: with no key configured this module is a complete
 * no-op — nothing is loaded, nothing is sent. Enablement:
 *   - key present AND dev  → ON by default (the team's own machines)
 *   - key present AND prod → only when VITE_POSTHOG_ENABLED === 'true'
 * Session REPLAY is a SEPARATE, stricter opt-in (VITE_POSTHOG_REPLAY): this
 * tool shows E2E-encrypted terminals and identity material, so recording the
 * screen is off even in dev unless explicitly turned on, and always masked.
 *
 * Config (Vite env):
 *   VITE_POSTHOG_KEY      project API key (absence = disabled)
 *   VITE_POSTHOG_HOST     ingestion host (default https://us.i.posthog.com)
 *   VITE_POSTHOG_ENABLED  'true' to enable outside dev
 *   VITE_POSTHOG_REPLAY   'true' to enable masked session replay
 */

import { redactText } from '../utils/redact.js';

type PostHog = typeof import('posthog-js').default;

let ph: PostHog | null = null;
let enabled = false;

function shouldEnable(): boolean {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) return false;
  if (import.meta.env.DEV) return true; // default-on in dev
  return import.meta.env.VITE_POSTHOG_ENABLED === 'true';
}

/** Initialize PostHog if configured+enabled. Idempotent; never throws. */
export async function initAnalytics(): Promise<void> {
  if (enabled || typeof window === 'undefined') return;
  if (!shouldEnable()) return;
  try {
    const key = import.meta.env.VITE_POSTHOG_KEY as string;
    const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';
    const replay = import.meta.env.VITE_POSTHOG_REPLAY === 'true';
    const mod = await import('posthog-js');
    ph = mod.default;
    ph.init(key, {
      api_host: host,
      // Screen recording is opt-in AND masked — a crypto tool's screen is
      // sensitive even from ourselves.
      disable_session_recording: !replay,
      session_recording: replay ? { maskAllInputs: true, maskTextSelector: '*' } : undefined,
      // Exceptions are captured explicitly from the diagnostics ring (below),
      // so leave autocapture of DOM events off — we don't need click heatmaps
      // of a terminal, and it keeps the payload small.
      autocapture: false,
      capture_pageview: true,
    });
    enabled = true;
    // Debug/verification handle (parallel to __gsDiag).
    (window as unknown as { __gsAnalytics?: unknown }).__gsAnalytics = {
      enabled: () => isAnalyticsEnabled(),
      ctx: () => getSessionContext(),
    };
  } catch {
    ph = null;
    enabled = false;
  }
}

export function isAnalyticsEnabled(): boolean {
  return enabled && ph !== null;
}

/** Forward a captured error to PostHog error tracking. Redacts the message. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!enabled || !ph) return;
  try {
    const err = error instanceof Error
      ? Object.assign(new Error(redactText(error.message)), { name: error.name, stack: error.stack ? redactText(error.stack) : undefined })
      : new Error(redactText(String(error)));
    ph.captureException(err, context);
  } catch { /* analytics must never break the app */ }
}

/**
 * A link the report bundle can carry so a GitHub issue points at the exact
 * PostHog session/replay ("posthog info here"). Null when disabled.
 */
export function getSessionContext(): { distinctId?: string; replayUrl?: string } | null {
  if (!enabled || !ph) return null;
  try {
    const distinctId = ph.get_distinct_id?.();
    const replayUrl = ph.get_session_replay_url?.({ withTimestamp: true }) ?? undefined;
    return { distinctId, replayUrl };
  } catch {
    return null;
  }
}
