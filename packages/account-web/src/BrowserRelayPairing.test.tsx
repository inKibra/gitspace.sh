// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRelayWalkthrough } from './SettingsPage.js';
import { pairAccountBrowser } from './browser-relay-client.js';
import type { RuntimeAccountBrowserRelayStatus } from '@gitspace/protocol-runtime';
vi.mock('./browser-relay-client.js', () => ({ pairAccountBrowser: vi.fn(), confirmAccountBrowser: vi.fn() }));
let root: Root; let container: HTMLDivElement;
const relay: RuntimeAccountBrowserRelayStatus = { pairings: [] };
const noop = async () => {};
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container=document.createElement('div');document.body.append(container);root=createRoot(container);vi.clearAllMocks(); });
afterEach(async()=>{await act(()=>root.unmount());container.remove();vi.unstubAllGlobals();});
function button(label:string) { const found=[...document.querySelectorAll('button')].find(item=>item.textContent===label);if(!found)throw new Error(`Missing ${label}`);return found; }
it('retrieves pairing from the authenticated account without needing a machine',async()=>{
 const pairing={code:'fixture-secret-8a6c2f',pairingId:'00000000-0000-4000-8000-000000000001',generation:1,endpoint:'https://account.gitspace.test',expiresAt:new Date(Date.now()+600_000).toISOString(),trust:{algorithm:'Ed25519' as const,accountId:'account',publicKey:'root'}};
 vi.mocked(pairAccountBrowser).mockResolvedValue(pairing);
 await act(()=>root.render(<BrowserRelayWalkthrough open onOpenChange={()=>{}} relay={relay} onSetup={noop} onStart={noop} onTest={noop} onUnpair={noop}/>));
 await act(()=>button('Get pairing JSON').click());
 expect(document.body.textContent).toContain(pairing.code);
 await act(()=>root.render(<BrowserRelayWalkthrough open={false} onOpenChange={()=>{}} relay={relay} onSetup={noop} onStart={noop} onTest={noop} onUnpair={noop}/>));
 expect(document.body.textContent).not.toContain(pairing.code);
});
it('shows pinned fingerprint and serializes forgetting the account browser',async()=>{
 const pending=Promise.withResolvers<void>();const forget=vi.fn(()=>pending.promise);
 await act(()=>root.render(<BrowserRelayWalkthrough open onOpenChange={()=>{}} relay={{...relay,pairings:[{pairingId:'00000000-0000-4000-8000-000000000001',generation:1,connected:true,browser:'Chrome',state:'confirmed',expiresAt:null,pairedKeyFingerprint:'a'.repeat(64)}]}} onSetup={noop} onStart={noop} onTest={noop} onUnpair={forget}/>));
 expect(document.body.textContent).toContain(`SHA-256 ${'a'.repeat(64)}`);
 await act(()=>button('Forget paired browser').click());expect(forget).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');expect(button('Forget paired browser').disabled).toBe(true);
 await act(()=>pending.resolve());expect(button('Forget paired browser').disabled).toBe(false);
});
