// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubState } from '@gitspace/protocol/github';
import { GitHubSettings } from './SettingsPage.js';

const unused = async (): Promise<never> => { throw new Error('Not used by this scenario'); };
const noApp: GitHubState = { app: null, installations: [], pendingRequests: [], deliveries: [] };
const installed: GitHubState = {
  app: { id: 7, slug: 'gitspace-brad', name: 'GitSpace brad', htmlUrl: 'https://github.com/apps/gitspace-brad', owner: { kind: 'user', login: 'brad' }, createdAt: '2026-10-17T10:00:00.000Z', keyUpdatedAt: '2026-10-17T10:00:00.000Z' },
  installations: [{
    id: 42,
    account: { kind: 'organization', login: 'inKibra' },
    repositorySelection: 'selected',
    repositories: ['inKibra/gitspace.sh', 'inKibra/site'],
    permissions: { metadata: 'read', contents: 'write' },
    installedAt: '2026-10-17T11:00:00.000Z',
    projects: [{ id: 'project-1', name: 'GitSpace', repository: 'inKibra/gitspace.sh' }],
  }],
  pendingRequests: [{ requestedAt: '2026-10-17T12:00:00.000Z' }],
  deliveries: [{ id: 'delivery-1', event: 'installation_repositories', action: 'added', installationId: 42, repository: 'inKibra/site', receivedAt: '2026-10-17T11:05:00.000Z', outcome: 'recorded' }],
};

let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  window.history.replaceState(null, '', '/settings?section=github');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  container?.remove();
  for (const form of document.body.querySelectorAll('form')) form.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function render(overrides: Partial<ComponentProps<typeof GitHubSettings>> = {}) {
  return act(() => root.render(<GitHubSettings github={noApp} onStartGitHubApp={unused} onStartGitHubInstall={unused} onRotateGitHubKey={unused} {...overrides} />));
}
async function click(label: string) {
  const target = [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!target) throw new Error(`Missing button: ${label}`);
  await act(async () => { target.click(); });
}

it('creates the App by POSTing the returned manifest to GitHub in this tab', async () => {
  const submitted: HTMLFormElement[] = [];
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) { submitted.push(this); });
  const start = vi.fn(async () => ({ action: 'https://github.com/settings/apps/new?state=one-time', manifest: '{"name":"GitSpace brad"}' }));
  await render({ onStartGitHubApp: start });
  await click('Create GitHub App');
  expect(start).toHaveBeenCalledWith({ kind: 'user' });
  expect(submitted).toHaveLength(1);
  const form = submitted[0]!;
  expect(form.isConnected).toBe(true);
  expect(form.method).toBe('post');
  expect(form.action).toBe('https://github.com/settings/apps/new?state=one-time');
  expect(form.target).toBe('');
  const fields = [...form.querySelectorAll('input')];
  expect(fields.map((field) => [field.type, field.name, field.value])).toEqual([['hidden', 'manifest', '{"name":"GitSpace brad"}']]);
});

it('does not submit anything when GitHub App creation cannot start', async () => {
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
  await render({ onStartGitHubApp: async () => { throw new Error('This account already has a GitHub App'); } });
  await click('Create GitHub App');
  expect(submit).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('This account already has a GitHub App');
});

it('shows a callback outcome once and removes it from the address', async () => {
  window.history.replaceState(null, '', '/settings?section=github&github=requested');
  await render({ github: installed });
  expect(document.body.querySelector('[role="status"]')?.textContent).toBe('Install requested: an organization owner must approve it on GitHub');
  expect(window.location.pathname).toBe('/settings');
  expect(window.location.search).toBe('?section=github');
  await act(() => root.unmount());
  root = createRoot(container);
  await render({ github: installed });
  expect(document.body.textContent).not.toContain('Install requested: an organization owner');
});

it('shows a callback error with its message and drops both parameters', async () => {
  window.history.replaceState(null, '', `/settings?section=github&github=error&message=${encodeURIComponent('The install state expired')}`);
  await render({ github: installed });
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('The install state expired');
  expect(window.location.search).toBe('?section=github');
});

it('lists each installation with its repositories, linked projects and pending owner approvals', async () => {
  await render({ github: installed });
  const text = document.body.textContent ?? '';
  expect(text).toContain('inKibra');
  expect(text).toContain('Selected repositories: inKibra/gitspace.sh, inKibra/site');
  expect(text).toContain('Linked projects: GitSpace');
  expect(text).toContain('contents:write metadata:read');
  expect(text).toContain('Waiting for an organization owner to approve the install on GitHub');
  expect(text).toContain('installation_repositories.added');
});

it('reports a private key GitHub rejects and confirms one it accepts', async () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n';
  const rotate = vi.fn(async (privateKey: string) => { if (rotate.mock.calls.length === 1) throw new Error(`GitHub rejected ${privateKey.length} bytes`); });
  await render({ github: installed, onRotateGitHubKey: rotate });
  await click('Replace private key');
  const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Private key"]');
  if (!textarea) throw new Error('Missing private key input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, pem);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Replace key');
  expect(rotate).toHaveBeenLastCalledWith(pem);
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(`GitHub rejected ${pem.length} bytes`);
  expect(document.body.textContent).not.toContain('Private key replaced');
  await click('Replace key');
  expect(rotate).toHaveBeenCalledTimes(2);
  expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Private key replaced');
});
