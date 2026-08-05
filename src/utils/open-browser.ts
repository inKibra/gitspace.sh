import open from 'open';

export type OpenBrowserResult =
  | { ok: true; opened: boolean }
  | { ok: false; message: string };

/** `BROWSER=none` (also `false`/`0`) suppresses the launch, and any other value
 *  names the app to use. This is the de-facto convention (vite, python's
 *  webbrowser, opn) — but the `open` package does NOT implement it, so callers
 *  that set $BROWSER to stay headless were silently launching the user's real
 *  default browser. That is how the `gssh web` integration test kept popping a
 *  `127.0.0.1/?enroll=…` tab on the developer's desktop during a plain test run. */
const BROWSER_SUPPRESSED: Record<string, true> = { none: true, false: true, '0': true };

export async function openBrowserUrl(url: string): Promise<OpenBrowserResult> {
  const browser = process.env.BROWSER?.trim();
  if (browser && BROWSER_SUPPRESSED[browser.toLowerCase()]) {
    return { ok: true, opened: false };
  }
  try {
    await open(url, browser ? { wait: false, app: { name: browser } } : { wait: false });
    return { ok: true, opened: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
