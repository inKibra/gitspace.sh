// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubProjectBridge } from '@gitspace/protocol/github';
import { verticalSliceFixture } from './App.js';
import { RepositoryAccessCard, RepositoryBridgeBanner, type BlockedProjectAccess } from './GitHubAccess.js';
import { GitSpaceShell } from './GitSpaceShell.js';

const stamp = '2026-11-01T09:00:00.000Z';
const needsApp: BlockedProjectAccess = { state: 'needs-app', repository: 'octo-labs/portal', organization: 'octo-labs', appName: 'GitSpace BrandByX', bridge: null };
const noApp: BlockedProjectAccess = { ...needsApp, appName: null };
const requested: BlockedProjectAccess = { state: 'requested', repository: 'octo-labs/portal', organization: 'octo-labs', appName: 'GitSpace BrandByX', request: { id: 'request', organization: 'octo-labs', project: { id: 'portal', name: 'Portal' }, repository: 'octo-labs/portal', firstRequestedAt: stamp, lastRequestedAt: stamp, times: 1 }, bridge: null };
const notSelected: BlockedProjectAccess = { state: 'not-selected', repository: 'octo-labs/portal', organization: 'octo-labs', appName: 'GitSpace BrandByX', installation: { id: 7, account: { login: 'octo-labs', kind: 'organization' }, repositorySelection: 'selected', repositories: ['octo-labs/site'], permissions: {}, installedAt: stamp, projects: [] }, bridge: null };
const online: GitHubProjectBridge = { machineId: 'machine-1', label: 'studio-mac', online: true };
const transcriptText = 'The workspace now has one main agent, nested side agents, and contextual project surfaces.';

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

async function renderBanner(access: BlockedProjectAccess, bridge: GitHubProjectBridge) {
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} onSend={async () => undefined} accessBanner={<RepositoryBridgeBanner access={access} bridge={bridge} onInstall={async () => '#'} onOpenSettings={() => undefined} />} />));
  return container.querySelector<HTMLElement>('[aria-label="GitHub sync"]');
}

function buttons(within: Element | null): string[] {
  return [...(within?.querySelectorAll('button') ?? [])].map((button) => button.textContent ?? '');
}

it('keeps the transcript and a working composer on a bridged project, with the App as an upgrade above them', async () => {
  const banner = await renderBanner(needsApp, online);
  expect(banner?.querySelector('p')?.textContent).toBe('Syncs with GitHub through studio-mac, using your own access. Install GitSpace BrandByX on octo-labs for pull requests, checks, automations and syncing without a machine.');
  expect(buttons(banner)).toContain('Install on octo-labs');
  expect(container.textContent).toContain(transcriptText);
  expect(container.querySelector('[aria-label="Repository access"]')).toBeNull();
  expect(container.querySelector('[inert]')).toBeNull();
  const composer = container.querySelector('textarea');
  expect(composer).not.toBeNull();
  expect(composer?.disabled).toBe(false);
});

it('says GitHub sync is paused while the bridging machine is offline', async () => {
  const banner = await renderBanner(needsApp, { ...online, online: false });
  expect(banner?.querySelector('p')?.textContent).toBe('GitHub sync paused: studio-mac is offline. Install GitSpace BrandByX on octo-labs for pull requests, checks, automations and syncing without a machine.');
  expect(buttons(banner)).toContain('Install on octo-labs');
  expect(container.textContent).toContain(transcriptText);
});

it('names what is pending instead of offering Install while an install is requested or the repository not selected', async () => {
  const waiting = await renderBanner(requested, online);
  expect(waiting?.textContent).toContain('Waiting for an owner of octo-labs to approve GitSpace BrandByX');
  expect(buttons(waiting).some((label) => label.startsWith('Install'))).toBe(false);
  const notAllowed = await renderBanner(notSelected, online);
  expect(notAllowed?.textContent).toContain("GitSpace BrandByX is installed on octo-labs, but portal isn't one of its selected repositories.");
  expect(buttons(notAllowed).some((label) => label.startsWith('Install'))).toBe(false);
  const appless = await renderBanner(noApp, online);
  expect(appless?.textContent).toContain('Create your GitHub App in Settings → GitHub');
  expect(buttons(appless)).toContain('Open Settings → GitHub');
});

it('offers both the App and a machine on an unbridged project, the machine button opening the Environment', async () => {
  const renderInspector = vi.fn((_onClose: () => void, initialView: 'environment' | 'browser' | undefined) => <div data-inspector-view={initialView} />);
  const onInstall = vi.fn(async () => '#');
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} onSend={async () => undefined} renderInspector={renderInspector} access={{ card: (onAttachMachine) => <RepositoryAccessCard access={needsApp} onInstall={onInstall} onOpenSettings={() => undefined} onAttachMachine={onAttachMachine} />, notice: 'The project agent starts once GitSpace can read octo-labs/portal.' }} />));
  const card = container.querySelector('[aria-label="Repository access"]');
  expect(buttons(card)).toEqual(expect.arrayContaining(['Install on octo-labs', 'Attach a machine']));
  expect(container.textContent).not.toContain(transcriptText);
  expect(container.querySelector('[inert]')).not.toBeNull();
  expect(container.querySelector('[data-inspector-view]')).toBeNull();
  await act(() => [...card!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Attach a machine')!.click());
  expect(container.querySelector('[data-inspector-view]')?.getAttribute('data-inspector-view')).toBe('environment');
});

it('keeps the create-your-App path on an unbridged project with no App, and still offers a machine', async () => {
  await act(() => root.render(<RepositoryAccessCard access={noApp} onInstall={async () => '#'} onOpenSettings={() => undefined} onAttachMachine={() => undefined} />));
  expect(container.textContent).toContain('Create your GitHub App first, or attach a machine');
  expect(buttons(container)).toEqual(expect.arrayContaining(['Open Settings → GitHub', 'Attach a machine']));
});
