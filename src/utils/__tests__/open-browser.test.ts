import { afterEach, describe, expect, it, mock } from 'bun:test';

const launches: Array<{ url: string; app?: unknown }> = [];

mock.module('open', () => ({
  default: mock(async (url: string, options?: { app?: unknown }) => {
    launches.push({ url, app: options?.app });
    return undefined;
  }),
}));

// Dynamic: `open` must be mocked before the module under test binds it, and a
// static import would be hoisted above the mock.module call.
const { openBrowserUrl } = await import('../open-browser.js');

const originalBrowser = process.env.BROWSER;

afterEach(() => {
  launches.length = 0;
  if (originalBrowser === undefined) delete process.env.BROWSER;
  else process.env.BROWSER = originalBrowser;
});

describe('openBrowserUrl', () => {
  it('does not launch anything when BROWSER suppresses it', async () => {
    // Regression: the `open` package ignores $BROWSER, so the `gssh web`
    // integration test — which sets it precisely to stay headless — opened a
    // real 127.0.0.1 enrollment tab in the developer's default browser on every
    // full-suite run. Suppression has to be enforced here, above the package.
    for (const value of ['none', 'NONE', 'false', '0']) {
      process.env.BROWSER = value;
      expect(await openBrowserUrl('http://127.0.0.1:4321/?enroll=t')).toEqual({ ok: true, opened: false });
    }
    expect(launches).toHaveLength(0);
  });

  it('launches the default browser when BROWSER is unset', async () => {
    delete process.env.BROWSER;

    expect(await openBrowserUrl('http://127.0.0.1:4321/')).toEqual({ ok: true, opened: true });
    expect(launches).toEqual([{ url: 'http://127.0.0.1:4321/', app: undefined }]);
  });

  it('routes to the named app when BROWSER names one', async () => {
    process.env.BROWSER = 'Google Chrome';

    expect(await openBrowserUrl('http://127.0.0.1:4321/')).toEqual({ ok: true, opened: true });
    expect(launches).toEqual([{ url: 'http://127.0.0.1:4321/', app: { name: 'Google Chrome' } }]);
  });
});
