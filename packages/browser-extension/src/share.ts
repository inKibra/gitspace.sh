/**
 * Share links of your Chrome's tabs (docs/APERTURE-DESIGN.md §8, B1; `browser-share.ts` in protocol-runtime). The
 * popup makes and ends a share with a request signed by this Chrome's pairing key (`POST /api/browser-relay/shares`,
 * label `share`); the account answers with the share and its link. People on the link watch the tab's screencast and
 * point; on a share with comments, they comment on what they point at. They never click or type in the tab.
 */
import type { RuntimeBrowserShareChromeRequest } from '@gitspace/protocol-runtime';
import { accountValue, relaySignature, sha256Hex, SIGNATURE_HEADER, type SigningIdentity } from './upload.js';

/** Where this Chrome's signed share requests go. */
const SHARES_PATH = '/api/browser-relay/shares';
/** How long a share may last, in minutes (`BROWSER_SHARE_EXPIRIES_MINUTES`). */
export const SHARE_EXPIRIES_MINUTES = [15, 60, 480, 1440] as const satisfies ReadonlyArray<Extract<RuntimeBrowserShareChromeRequest, { op: 'create' }>['expiresInMinutes']>;

/** One signed share request; resolves with the value of the account's `ok` reply, or fails with its message. */
export async function shareRequest(account: string, identity: SigningIdentity, request: RuntimeBrowserShareChromeRequest): Promise<unknown> {
  const body = new TextEncoder().encode(JSON.stringify(request));
  const header = await relaySignature(identity, 'share', 'POST', SHARES_PATH, await sha256Hex(body));
  return accountValue(await fetch(new URL(SHARES_PATH, account).href, { method: 'POST', body, headers: { [SIGNATURE_HEADER]: header, 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store' }), '');
}

/**
 * On the node at a point of a shared tab (`this`, the element `DOM.getNodeForLocation` found, or a text node in one),
 * in an isolated world: a little of the element's visible text and up to five selectors that each find it alone in
 * the document, most specific first (its id, a test id or naming attribute, its classes, then its path from the
 * nearest ancestor with an id). Null for a point on the in-page overlay.
 */
export const shareTargetFunction = `function() {
  const element = this.nodeType === 1 ? this : this.parentElement;
  if (!element) return null;
  // The overlay draws in a closed shadow root, which closest() does not leave: its host is the root's host.
  const host = element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : element;
  if (host.closest('[data-gitspace-overlay]')) return null;
  const text = String(element.innerText ?? element.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 500);
  const selectors = [];
  const add = selector => {
    if (selectors.length >= 5 || selector.length > 1024 || selectors.includes(selector)) return;
    try { const found = document.querySelectorAll(selector); if (found.length === 1 && found[0] === element) selectors.push(selector); } catch {}
  };
  const tag = element.localName;
  if (element.id) add('#' + CSS.escape(element.id));
  for (const name of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'href', 'alt', 'title', 'placeholder']) {
    const value = element.getAttribute(name);
    if (value && value.length <= 200) add(tag + '[' + name + '="' + CSS.escape(value) + '"]');
  }
  const classes = [...element.classList].slice(0, 3).map(name => '.' + CSS.escape(name)).join('');
  if (classes) add(tag + classes);
  const path = [];
  for (let node = element; node; node = node.parentElement) {
    if (node !== element && node.id) { path.unshift('#' + CSS.escape(node.id)); break; }
    const same = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [node];
    path.unshift(same.length > 1 ? node.localName + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : node.localName);
  }
  add(path.join(' > '));
  return { text, selectors };
}`;
