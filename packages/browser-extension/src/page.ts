/**
 * `page.js`: what the extension puts in a tab's page, in its own isolated world (the content-script world of
 * `chrome.scripting.executeScript`, which no page script reaches), and only in tabs that show a workspace group's
 * toolbar, are in comment mode, are watched by a share or are recorded by a capture (docs/APERTURE-DESIGN.md §6.4).
 *
 * Once per document and extension version (`chrome.runtime.getManifest().version`), it keeps the in-page overlay
 * (`overlay.ts`), a capture's step recorder and its bar or saved card (`capture-tracks.ts`) as
 * `globalThis.__gitspacePage`: `{ version, call(name, json), dispose() }`. The service worker runs each of them with
 * `call`, the function's name (`overlay`, `recorder`, `bar`) and its command as JSON text, since Chrome drops every
 * property whose value is null from a script's arguments and the overlay takes things away with null.
 *
 * They tell the service worker through `globalThis.__gitspaceSend(text)`: a runtime message `{ gitspaceOverlay: text }`
 * from this world, which the worker trusts by its sender (this extension, the tab's main frame), answering a promise
 * of its reply. Once this world's extension is gone (updated or turned off), sending throws, and everything here
 * leaves the page; a later version replaces an earlier one's in the same way.
 */
import { browserCaptureBarFunction, browserCaptureRecorderFunction } from './capture-tracks.js';
import { browserOverlayFunction } from './overlay.js';

export const PAGE_SCRIPT = `(() => {
  const version = chrome.runtime.getManifest().version;
  const earlier = globalThis.__gitspacePage;
  if (earlier && earlier.version === version) return;
  if (earlier) earlier.dispose();
  const functions = { overlay: (${browserOverlayFunction}), recorder: (${browserCaptureRecorderFunction}), bar: (${browserCaptureBarFunction}) };
  const page = {
    version,
    call: (name, json) => functions[name](JSON.parse(json)),
    dispose() {
      for (const name of ['recorder', 'bar', 'overlay']) { try { functions[name]({ remove: true }); } catch {} }
      if (globalThis.__gitspacePage === page) delete globalThis.__gitspacePage;
    },
  };
  globalThis.__gitspaceSend = text => {
    let sent;
    try { sent = chrome.runtime.sendMessage({ gitspaceOverlay: text }); }
    catch (error) { page.dispose(); sent = Promise.reject(error); }
    // A caller that does not wait for the reply lets a failed one go quietly.
    sent.catch(() => {});
    return sent;
  };
  globalThis.__gitspacePage = page;
})();
`;
