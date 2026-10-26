/**
 * The values and rules of a capture's steps and layout tracks (docs/APERTURE-DESIGN.md §11), without schemas, so the
 * extension bundles them alone (`@gitspace/protocol-runtime/browser-capture-rules`); the schemas are
 * `browser-capture-tracks.ts`.
 */

/** What a recorded step did: a navigation, one of your actions, or a request the page sent (`request`). */
export const CAPTURE_STEP_KINDS = ['goto', 'click', 'fill', 'press', 'select', 'check', 'upload', 'request'] as const;
/** The value a step keeps for a password field, a field with `autocomplete` `cc-*` or `one-time-code`, and a field
 * whose name or id matches `CAPTURE_SECRET_NAME`; a URL keeps it for each query parameter whose name matches. */
export const CAPTURE_SECRET_VALUE = '«secret»';
export const CAPTURE_SECRET_NAME = /pass|secret|token|otp|cvc|card/iu;
/** Layout samples are taken when the visible page changes, at most one per this interval (two a second). */
export const CAPTURE_LAYOUT_INTERVAL_MS = 500;
/** The visible elements one layout sample keeps at most, and the steps one capture keeps at most. */
export const CAPTURE_LAYOUT_ELEMENTS = 400;
export const CAPTURE_STEPS_MAX = 20_000;
/** The files of the steps and layout tracks in the capture's folder. */
export const CAPTURE_TRACK_FILES = { steps: 'steps.json', layout: 'layout.jsonl' } as const;

/** A URL as a step keeps it: without user and password, and with `CAPTURE_SECRET_VALUE` for each query parameter
 * whose name looks secret (`CAPTURE_SECRET_NAME`). A string that is no URL is kept as it is. */
export function captureMaskedUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  parsed.username = '';
  parsed.password = '';
  for (const name of [...new Set(parsed.searchParams.keys())]) if (CAPTURE_SECRET_NAME.test(name)) parsed.searchParams.set(name, CAPTURE_SECRET_VALUE);
  return parsed.href;
}
