import { BACKGROUND_SOURCE, OFFSCREEN_SOURCE, POPUP_FONT_ORIGIN, POPUP_SOURCE, POPUP_STYLES } from './bundle.generated.js';

export { relayCommandAllowed } from './commands.js';
export { verifyRelayAuthorization } from './authorization.js';
export { NAMED_KEYS } from './activity.js';

/** The popup's page: `popup.js` (React, `popup.tsx`) renders into it with `popup.css`, GitSpace's theme, light or
 * dark with Chrome. */
const POPUP_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>GitSpace</title><link rel="stylesheet" href="popup.css"></head><body><div id="root"></div><script src="popup.js"></script></body></html>';

/** The unpacked extension for one account: the service worker reaches the account it was downloaded from; the
 * offscreen document records the tabs you capture; the popup's font comes from the account. */
export function extensionFiles(accountUrl: string): Record<string, string> {
  const origin = new URL(accountUrl).origin;
  return {
    'background.js': `const GITSPACE_ACCOUNT_URL = ${JSON.stringify(accountUrl)};\n${BACKGROUND_SOURCE}`,
    'popup.js': POPUP_SOURCE,
    'popup.css': POPUP_STYLES.replaceAll(POPUP_FONT_ORIGIN, origin),
    'popup.html': POPUP_HTML,
    'offscreen.js': OFFSCREEN_SOURCE,
    'offscreen.html': '<!doctype html><html><head><meta charset="utf-8"><title>GitSpace recorder</title></head><body><script src="offscreen.js"></script></body></html>',
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'GitSpace Browser Relay', version: '5.8.0', minimum_chrome_version: '124', permissions: ['debugger', 'tabs', 'tabGroups', 'alarms', 'storage', 'downloads', 'tabCapture', 'offscreen', 'favicon'], host_permissions: [`${origin}/*`], background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html', default_title: 'GitSpace' } }),
  };
}
