// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubProjectBridge } from '@gitspace/protocol/github';
import { verticalSliceFixture } from './App.js';
import { RepositoryAccessCard, useRepositoryBridgeToasts, type GitHubBlockedAccess } from './GitHubAccess.js';
import { GitSpaceShell, type GitSpaceShellProps } from './GitSpaceShell.js';
import { Toasts } from './toasts.js';

const stamp = '2026-11-01T09:00:00.000Z';
const needsApp: GitHubBlockedAccess = { state: 'needs-app', repository: 'octo-labs/portal', organization: 'octo-labs', appName: 'GitSpace BrandByX', bridge: null, awaitsCopy: false };
const noApp: GitHubBlockedAccess = { ...needsApp, appName: null };
const requested: GitHubBlockedAccess = { state: 'requested', repository: 'octo-labs/portal', organization: 'octo-labs', appName: 'GitSpace BrandByX', request: { id: 'request', organization: 'octo-labs', project: { id: 'portal', name: 'Portal' }, repository: 'octo-labs/portal', firstRequestedAt: stamp, lastRequestedAt: stamp, times: 1 }, bridge: null, awaitsCopy: false };
const notSelected: GitHubBlockedAccess = { state: 'not-selected', repository: 'octo-labs/portal', organization: 'octo-labs', appName: 'GitSpace BrandByX', installation: { id: 7, account: { login: 'octo-labs', kind: 'organization' }, repositorySelection: 'selected', repositories: ['octo-labs/site'], permissions: {}, installedAt: stamp, projects: [] }, bridge: null, awaitsCopy: false };
const machines = [{ id: 'machine-1', label: 'studio-mac' }, { id: 'machine-2', label: 'garage-box' }];
const noCopy = { machines, onCopy: async () => { throw new Error('No copy in this test'); } };
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

function Bridge({ access, bridge }: { access: GitHubBlockedAccess; bridge: GitHubProjectBridge | null }) {
  useRepositoryBridgeToasts(bridge ? { access, bridge } : null, async () => '#', () => undefined);
  return null;
}

/** The project page with the bridge toast, as RuntimeWorkspace reports it; returns the toast. */
async function renderBridged(access: GitHubBlockedAccess, bridge: GitHubProjectBridge | null) {
  await act(() => root.render(<Toasts><Bridge access={access} bridge={bridge} /><GitSpaceShell {...verticalSliceFixture} onSend={async () => undefined} /></Toasts>));
  return container.querySelector<HTMLElement>('section[aria-label="Notifications"] [data-tone]');
}

function buttons(within: Element | null): string[] {
  return [...(within?.querySelectorAll('button') ?? [])].map((button) => button.textContent ?? '');
}

it('keeps the transcript and a working composer on a bridged project, with the App as an upgrade in a toast', async () => {
  const toast = await renderBridged(needsApp, online);
  expect(toast?.textContent).toContain('Syncs with GitHub through studio-mac, using your own access. Install GitSpace BrandByX on octo-labs for pull requests, checks, automations and syncing without a machine.');
  expect(buttons(toast)).toContain('Install on octo-labs');
  expect(container.textContent).toContain(transcriptText);
  expect(container.querySelector('[aria-label="Repository access"]')).toBeNull();
  expect(container.querySelector('[inert]')).toBeNull();
  const composer = container.querySelector('textarea');
  expect(composer).not.toBeNull();
  expect(composer?.disabled).toBe(false);
});

it('puts no notice strip in the main frame: the conversation stage starts right under the top bar', async () => {
  await renderBridged(needsApp, online);
  const frame = container.querySelector('.workspace-workbench')?.parentElement;
  expect(frame?.children).toHaveLength(2);
  expect(frame?.children[0]?.querySelector('nav[aria-label="Location"]')).not.toBeNull();
  expect(frame?.children[1]?.classList.contains('workspace-workbench')).toBe(true);
  // The agent canvas holds the transcript's scroll area first and the floating composer; nothing above them.
  const canvas = container.querySelector('.conversation-stage')?.firstElementChild;
  expect(canvas?.children).toHaveLength(2);
  expect(canvas?.firstElementChild?.querySelector('[data-slot="scroll-area-viewport"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="GitHub sync"]')).toBeNull();
  expect(container.querySelector('.conversation-stage')?.textContent).not.toContain('Syncs with GitHub');
});

it('hides a dismissed bridge toast while its condition holds, and shows it again when the condition changes or recurs', async () => {
  const toast = await renderBridged(needsApp, online);
  await act(() => toast?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')?.click());
  expect(await renderBridged(needsApp, online)).toBeNull();
  const offline = await renderBridged(needsApp, { ...online, online: false });
  expect(offline?.textContent).toContain('GitHub sync paused: studio-mac is offline.');
  expect(offline?.getAttribute('data-tone')).toBe('warning');
  await act(() => offline?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')?.click());
  expect(await renderBridged(needsApp, { ...online, online: false })).toBeNull();
  expect(await renderBridged(needsApp, null)).toBeNull();
  expect((await renderBridged(needsApp, { ...online, online: false }))?.textContent).toContain('GitHub sync paused');
});

it('says GitHub sync is paused while the bridging machine is offline', async () => {
  const toast = await renderBridged(needsApp, { ...online, online: false });
  expect(toast?.textContent).toContain('GitHub sync paused: studio-mac is offline. Install GitSpace BrandByX on octo-labs for pull requests, checks, automations and syncing without a machine.');
  expect(buttons(toast)).toContain('Install on octo-labs');
  expect(container.textContent).toContain(transcriptText);
});

it('names what is pending instead of offering Install while an install is requested or the repository not selected', async () => {
  const waiting = await renderBridged(requested, online);
  expect(waiting?.textContent).toContain('Waiting for an owner of octo-labs to approve GitSpace BrandByX');
  expect(buttons(waiting).some((label) => label.startsWith('Install'))).toBe(false);
  expect(buttons(waiting)).toContain('Copy steps for the owner');
  const notAllowed = await renderBridged(notSelected, online);
  expect(notAllowed?.textContent).toContain("GitSpace BrandByX is installed on octo-labs, but portal isn't one of its selected repositories.");
  expect(buttons(notAllowed).some((label) => label.startsWith('Install'))).toBe(false);
  const appless = await renderBridged(noApp, online);
  expect(appless?.textContent).toContain('Create your GitHub App in Settings → GitHub');
  expect(buttons(appless)).toContain('Open Settings → GitHub');
});

it('offers both the App and a machine on an unbridged project, the machine button opening the Environment', async () => {
  const renderInspector = vi.fn((_onClose: () => void, initialView: 'environment' | 'browser' | undefined) => <div data-inspector-view={initialView} />);
  const onInstall = vi.fn(async () => '#');
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} onSend={async () => undefined} renderInspector={renderInspector} access={{ card: (onAttachMachine) => <RepositoryAccessCard access={needsApp} copy={noCopy} onInstall={onInstall} onOpenSettings={() => undefined} onAttachMachine={onAttachMachine} />, notice: 'The project agent starts once GitSpace can read octo-labs/portal.' }} />));
  const card = container.querySelector('[aria-label="Repository access"]');
  expect(buttons(card)).toEqual(expect.arrayContaining(['Install on octo-labs', 'Attach a machine']));
  expect(container.textContent).not.toContain(transcriptText);
  expect(container.querySelector('[inert]')).not.toBeNull();
  expect(container.querySelector('[data-inspector-view]')).toBeNull();
  await act(() => [...card!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Attach a machine')!.click());
  expect(container.querySelector('[data-inspector-view]')?.getAttribute('data-inspector-view')).toBe('environment');
});

it('keeps the create-your-App path on an unbridged project with no App, and still offers a machine', async () => {
  await act(() => root.render(<RepositoryAccessCard access={noApp} copy={noCopy} onInstall={async () => '#'} onOpenSettings={() => undefined} onAttachMachine={() => undefined} />));
  expect(container.textContent).toContain('Create your GitHub App first, or use one of your machines');
  expect(buttons(container)).toEqual(expect.arrayContaining(['Open Settings → GitHub', 'Attach a machine']));
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button ${label}: ${buttons(container).join(', ')}`);
  return found;
}

it('offers to copy a repository whose import was refused through the chosen online machine, beside the App', async () => {
  const onCopy = vi.fn(async (_machineId: string) => undefined);
  await act(() => root.render(<RepositoryAccessCard access={{ ...needsApp, awaitsCopy: true }} copy={{ machines, onCopy }} onInstall={async () => '#'} onOpenSettings={() => undefined} onAttachMachine={() => undefined} />));
  expect(buttons(container)).toEqual(expect.arrayContaining(['Install on octo-labs', 'Copy through studio-mac']));
  // A machine copies the first cloud copy in; attaching one is for a project that already has it.
  expect(buttons(container)).not.toContain('Attach a machine');
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Machine to copy through"]')!.click());
  const garage = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'garage-box');
  await act(() => garage!.click());
  await act(() => button('Copy through garage-box').click());
  expect(onCopy).toHaveBeenCalledWith('machine-2');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('shows why a copy failed, with another machine and the App still offered', async () => {
  const reason = 'git ls-remote failed (exit 128): SSH authentication failed. Add the public key from Settings → Git to a GitHub account that can access this repository.';
  const onCopy = vi.fn(async (_machineId: string) => { throw new Error(reason); });
  await act(() => root.render(<RepositoryAccessCard access={{ ...needsApp, awaitsCopy: true }} copy={{ machines, onCopy }} onInstall={async () => '#'} onOpenSettings={() => undefined} onAttachMachine={() => undefined} />));
  await act(() => button('Copy through studio-mac').click());
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(`Copying through studio-mac failed: ${reason}`);
  expect(alert?.textContent).toContain('Choose another machine that can read it, or install GitSpace BrandByX on octo-labs instead.');
  expect(buttons(container)).toEqual(expect.arrayContaining(['Install on octo-labs', 'Copy through studio-mac']));
  expect(container.querySelector('[aria-label="Machine to copy through"]')).not.toBeNull();
});

it('says no machine is online to copy through, and offers the copy alone for a repository outside GitHub', async () => {
  await act(() => root.render(<RepositoryAccessCard access={{ state: 'awaits-copy', origin: 'https://git.example.org/acme/assets.git' }} copy={{ machines: [], onCopy: async () => undefined }} onInstall={async () => '#'} onOpenSettings={() => undefined} onAttachMachine={() => undefined} />));
  expect(container.textContent).toContain('Copy this repository in through one of your machines');
  expect(container.querySelector('[role="status"]')?.textContent).toBe('None of your machines is online. Start one that can read it, or add a computer in Settings → Machines.');
  expect(buttons(container).filter((label) => label.startsWith('Copy through') || label.startsWith('Install'))).toEqual([]);
});

function toasts(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('section[aria-label="Notifications"] [data-tone]')];
}

function toastButton(toast: HTMLElement | undefined, label: string): HTMLButtonElement {
  const found = [...(toast?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((candidate) => candidate.textContent === label || candidate.getAttribute('aria-label') === label);
  if (!found) throw new Error(`No toast button ${label}`);
  return found;
}

it('reports a disconnected provider as a toast whose Connect opens Inference → Providers', async () => {
  const rejects = async (): Promise<never> => { throw new Error('not called'); };
  const sessionControls: NonNullable<GitSpaceShellProps['sessionControls']> = {
    value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: 'anthropic', models: [{ provider: 'anthropic', id: 'claude', name: 'Claude', contextWindow: null, unavailable: null }], model: 'claude', thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null },
    onCycleRole: rejects, onSetModel: rejects, onSetThinking: rejects, onSetFast: rejects, onSetGoal: rejects, onCompact: rejects, onClearQueue: rejects, onRemoveQueuedMessage: rejects, onPromoteQueuedMessage: rejects, onDismissAutomationRun: rejects, onStop: rejects, onNavigateTree: rejects,
  };
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: false }]} />));
  const toast = toasts().find((item) => item.textContent?.includes('Anthropic isn’t connected in this inference profile'));
  expect(toast?.getAttribute('data-tone')).toBe('warning');
  await act(() => toastButton(toast, 'Connect').click());
  expect(new URL(window.location.href).searchParams.get('section')).toBe('providers');
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: true }]} />));
  expect(toasts().some((item) => item.textContent?.includes('isn’t connected'))).toBe(false);
});

it('reports a failed agent and a failed transcript read as error toasts that keep Continue and Retry transcript', async () => {
  const onContinueAgent = vi.fn(async () => undefined);
  const onRetry = vi.fn();
  const mainAgent: GitSpaceShellProps['mainAgent'] = { id: 'session-a', title: 'Workspace agent', model: 'GPT-5.6', state: 'waiting', failed: true, errorMessage: 'Model overloaded' };
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} mainAgent={mainAgent} onContinueAgent={onContinueAgent} history={{ loading: false, error: 'Network down', onRetry }} />));
  const failure = toasts().find((item) => item.textContent?.includes('Agent failure: Model overloaded'));
  const history = toasts().find((item) => item.textContent?.includes('Transcript history could not be loaded: Network down'));
  expect([failure?.getAttribute('data-tone'), history?.getAttribute('data-tone')]).toEqual(['error', 'error']);
  await act(() => toastButton(failure, 'Continue').click());
  expect(onContinueAgent).toHaveBeenCalledTimes(1);
  await act(() => toastButton(history, 'Retry transcript').click());
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.conversation-stage')?.textContent).not.toContain('Agent failure');
});

it('marks a transcript shown from this browser’s saved copy in the top bar, not in a row above the transcript', async () => {
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} history={{ loading: true, saved: true, error: null, onRetry: () => undefined }} />));
  const mark = container.querySelector('nav[aria-label="Location"] [role="status"]');
  expect(mark?.getAttribute('aria-label')).toBe('Showing the copy saved in this browser, loading the latest');
  expect(container.querySelector('.workspace-workbench')?.parentElement?.children).toHaveLength(2);
  expect(container.querySelector('.conversation-stage')?.textContent).not.toContain('saved in this browser');
  expect(toasts()).toHaveLength(0);
});
