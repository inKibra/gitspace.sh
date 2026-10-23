import { BACKGROUND_SOURCE, POPUP_SOURCE } from './bundle.generated.js';

export { relayCommandAllowed } from './commands.js';
export { verifyRelayAuthorization } from './authorization.js';

const POPUP_HTML = '<!doctype html><html><body><p>Browser identity — compare this fingerprint in GitSpace Settings</p><p>Extension public key fingerprint (SHA-256)</p><code id="fingerprint"></code><p id="compatibility" role="alert"></p><form id="pair"><label>Account pairing details <input id="code" autocomplete="off" required></label><button>Pair</button></form><button id="reset" type="button">Reset identity</button><p id="status" role="status"></p><script src="popup.js"></script></body></html>';

/** The unpacked extension for one account: the service worker reaches the account it was downloaded from. */
export function extensionFiles(accountUrl: string): Record<string, string> {
  return {
    'background.js': `const GITSPACE_ACCOUNT_URL = ${JSON.stringify(accountUrl)};\n${BACKGROUND_SOURCE}`,
    'popup.js': POPUP_SOURCE,
    'popup.html': POPUP_HTML,
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'GitSpace Browser Relay', version: '5.2.1', minimum_chrome_version: '124', permissions: ['debugger', 'tabs', 'tabGroups', 'alarms', 'storage'], host_permissions: [`${new URL(accountUrl).origin}/*`], background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } }),
  };
}
