/**
 * Adding a tab to a workspace from the popup (`browser-workspaces.ts` in protocol-runtime). The popup lists the
 * workspaces it can add the tab to and adds it to one with requests signed by this Chrome's pairing key
 * (`POST /api/browser-relay/workspaces`, label `workspace`). Adding has the workspace make or renew its group on this
 * Chrome; the account then moves the tab into it as if you dragged it in (`adoptTab`).
 */
import type { BROWSER_WORKSPACES_PATH, RuntimeBrowserWorkspaceChromeRequest } from '@gitspace/protocol-runtime';
import { accountValue, relaySignature, sha256Hex, SIGNATURE_HEADER, type SigningIdentity } from './upload.js';

/** Where this Chrome's signed workspace requests go (`BROWSER_WORKSPACES_PATH`). */
const WORKSPACES_PATH: typeof BROWSER_WORKSPACES_PATH = '/api/browser-relay/workspaces';

/** One signed workspace request; resolves with the value of the account's `ok` reply, or fails with its message. */
export async function workspaceRequest(account: string, identity: SigningIdentity, request: RuntimeBrowserWorkspaceChromeRequest): Promise<unknown> {
  const body = new TextEncoder().encode(JSON.stringify(request));
  const header = await relaySignature(identity, 'workspace', 'POST', WORKSPACES_PATH, await sha256Hex(body));
  return accountValue(await fetch(new URL(WORKSPACES_PATH, account).href, { method: 'POST', body, headers: { [SIGNATURE_HEADER]: header, 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store' }), '');
}
