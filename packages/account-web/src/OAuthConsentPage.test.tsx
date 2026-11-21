// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STEP_UP_HEADER, type DeviceCapability, type DeviceScope, type StepUpAction } from '@gitspace/protocol/device-grant';
import { MCP_OAUTH_CONSENT_API, mcpOAuthConsentDecisionSchema, type McpOAuthConsentView } from '@gitspace/protocol/mcp-authorization';
import type { StepUp } from './passkeys.js';
import { OAuthConsentPage, type OAuthConsentProjects } from './OAuthConsentPage.js';

// The page's signed fetch and invitation signing, answered by each test.
const api = vi.hoisted(() => ({
  handle: async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('No API in this test'); },
  drafts: new Array<{ label: string; scope: DeviceScope; capabilities: DeviceCapability[]; ttlMs: number | null }>(),
}));
vi.mock('./device.js', () => ({
  DeviceRejectedError: class extends Error {},
  loadDevice: async () => ({ userId: 'u-account', deviceId: 'browser-1' }),
  createDeviceSignedFetch: () => (input: RequestInfo | URL, init?: RequestInit) => api.handle(input, init),
  prepareApiClientInvite: async (_device: unknown, draft: { label: string; scope: DeviceScope; capabilities: DeviceCapability[]; ttlMs: number | null }) => {
    api.drafts.push(draft);
    return {
      invite: { version: 1, userId: 'u-account', inviteId: '00000000-0000-4000-8000-000000000001', kind: 'client', label: draft.label, scope: draft.scope, capabilities: draft.capabilities, canDelegate: false, issuedAt: 1, expiresAt: 2, grantTtlMs: draft.ttlMs, enrollUrl: 'https://alice.gitspace.sh/v1/devices/enroll' },
      signature: 'A'.repeat(88), issuer: { kind: 'device', deviceId: '00000000-0000-4000-8000-000000000002' },
    };
  },
}));
const stepUps = vi.hoisted(() => ({ passkeyAvailable: true, requested: new Array<StepUpAction>() }));
vi.mock('./passkeys.js', () => ({
  requestStepUp: async (action: StepUpAction): Promise<StepUp> => {
    stepUps.requested.push(action);
    return {
      action, required: true, passkeyAvailable: stepUps.passkeyAvailable, expiresAt: Date.now() + 120_000,
      withPasskey: async () => `${action.purpose}:passkey`, withRecoveryKey: async (key: string) => `${action.purpose}:${key}`,
    };
  },
}));

const requestId = '6b0f3a4e-0000-4000-8000-00000000c0de';
let view: McpOAuthConsentView;
let decisions: { body: unknown; stepUp: string | null }[];
let created: string[];
let assigned: string[];
let container: HTMLDivElement;
let root: Root;
const projects: OAuthConsentProjects = {
  list: async () => [{ id: 'orchard-1', name: 'Orchard' }, { id: 'pantry-2', name: 'Pantry' }],
  create: async (name) => { created.push(name); return { id: 'fresh-3', name }; },
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  view = {
    requestId, client: { clientId: 'https://agents.example/oauth/client.json', name: 'Agents', logoUri: 'https://agents.example/logo.png', clientUri: 'https://agents.example', host: 'agents.example', registration: 'metadata-document' },
    redirectUri: 'https://agents.example/callback', redirectHost: 'agents.example', loopback: false, requestedCapabilities: ['rpc.read', 'rpc.write', 'session.prompt'], expiresAt: Date.now() + 600_000,
  };
  decisions = []; created = []; assigned = []; api.drafts = [];
  stepUps.passkeyAvailable = true; stepUps.requested = [];
  vi.spyOn(window.location, 'assign').mockImplementation((url: string | URL) => { assigned.push(String(url)); });
  api.handle = async (input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    if (String(input) === `${MCP_OAUTH_CONSENT_API}/view`) {
      expect(body).toEqual({ userId: 'u-account', requestId });
      return Response.json({ status: 'ok', value: view });
    }
    expect(String(input)).toBe(`${MCP_OAUTH_CONSENT_API}/decide`);
    decisions.push({ body: mcpOAuthConsentDecisionSchema.parse(body), stepUp: new Headers(init?.headers).get(STEP_UP_HEADER) });
    return Response.json({ status: 'ok', value: { redirectUrl: 'https://agents.example/callback?code=gsoc_x&state=s&iss=https%3A%2F%2Falice.gitspace.sh' } });
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
async function render() {
  await act(async () => root.render(<OAuthConsentPage requestId={requestId} projects={projects} />));
  await settle();
  await settle();
}
function control(role: 'checkbox' | 'radio', label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(candidate => candidate.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing ${role} ${label}`);
  return found;
}
async function press(element: HTMLElement) {
  await act(async () => { element.click(); });
  await settle();
}
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function type(input: HTMLInputElement, value: string) {
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('shows who asks and where the answer goes, ticks what the app asked for, and allows exactly what the person leaves ticked', async () => {
  await render();
  expect(container.querySelector('[data-oauth-client-name]')?.textContent).toBe('Agents');
  expect(container.querySelector('[data-oauth-client-host]')?.textContent).toBe('agents.example');
  expect(container.querySelector('[data-oauth-redirect-host]')?.textContent).toBe('agents.example');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://agents.example/logo.png');
  expect(['Read', 'Write', 'Talk to agents', 'Fleet', 'Decide as you'].map(label => control('checkbox', label).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'false', 'false']);
  expect(control('radio', 'Whole account').getAttribute('aria-checked')).toBe('true');
  await press(control('checkbox', 'Write'));
  await press(control('radio', '90 days'));
  await press(button('Allow'));
  expect(api.drafts).toEqual([{ label: 'Agents', scope: { kind: 'user' }, capabilities: ['rpc.read', 'session.prompt'], ttlMs: 90 * 86_400_000 }]);
  expect(decisions).toMatchObject([{ body: { userId: 'u-account', requestId, decision: 'allow', invite: { invite: { capabilities: ['rpc.read', 'session.prompt'] } } }, stepUp: null }]);
  expect(stepUps.requested).toEqual([]);
  expect(assigned).toEqual(['https://agents.example/callback?code=gsoc_x&state=s&iss=https%3A%2F%2Falice.gitspace.sh']);
});

it('marks an app that registered itself as unverified and warns when its answer goes to this computer; Deny sends no invitation', async () => {
  view = { ...view, client: { ...view.client, clientId: 'gsdc_1', logoUri: null, host: null, registration: 'dynamic' }, redirectUri: 'http://127.0.0.1:43123/callback', redirectHost: '127.0.0.1:43123', loopback: true };
  await render();
  expect(container.querySelector('[data-oauth-unverified]')?.textContent).toContain('Unverified');
  expect(container.querySelector('[data-oauth-redirect-host]')?.textContent).toBe('127.0.0.1:43123');
  expect(container.textContent).toContain('That address is this computer.');
  await press(button('Deny'));
  expect(api.drafts).toEqual([]);
  expect(decisions).toEqual([{ body: { userId: 'u-account', requestId, decision: 'deny' }, stepUp: null }]);
});

it('limits the grant to the chosen projects, making a new one for the app, and to one project as a project scope', async () => {
  await render();
  await press(control('radio', 'Only the projects I choose'));
  expect(button('Allow').disabled).toBe(true);
  await press(control('checkbox', 'Orchard'));
  await press(control('checkbox', 'Pantry'));
  await type(container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!, 'Agent sandbox');
  await press(button('Allow'));
  expect(created).toEqual(['Agent sandbox']);
  expect(api.drafts.at(-1)?.scope).toEqual({ kind: 'projects', projectIds: ['orchard-1', 'pantry-2', 'fresh-3'] });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await press(control('radio', 'Only the projects I choose'));
  await press(control('checkbox', 'Pantry'));
  await press(button('Allow'));
  expect(api.drafts.at(-1)?.scope).toEqual({ kind: 'project', projectId: 'pantry-2' });
});

it('asks for the passkey on Allow when a powerful permission is ticked, and takes the recovery key when no passkey is enrolled', async () => {
  await render();
  await press(control('checkbox', 'Decide as you'));
  expect(stepUps.requested).toEqual([{ purpose: 'mcp-oauth.grant', targets: [requestId] }]);
  expect(container.textContent).toContain('These permissions need your passkey');
  await press(button('Allow'));
  expect(decisions.at(-1)?.stepUp).toBe('mcp-oauth.grant:passkey');
  await act(async () => root.unmount());
  root = createRoot(container);
  stepUps.passkeyAvailable = false;
  await render();
  await press(control('checkbox', 'Account administration'));
  expect(container.textContent).toContain('This account has no passkey yet, so confirm with your recovery key.');
  expect(button('Allow').disabled).toBe(true);
  await type(container.querySelector<HTMLInputElement>('input[placeholder="gsr_…"]')!, 'gsr_answer');
  await press(button('Confirm with recovery key'));
  expect(container.textContent).toContain('Recovery key accepted.');
  await press(button('Allow'));
  expect(decisions.at(-1)?.stepUp).toBe('mcp-oauth.grant:gsr_answer');
});
