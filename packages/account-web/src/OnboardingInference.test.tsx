// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AvailableModel, ProviderView, UserSettings } from '@gitspace/protocol';
import { DEFAULT_INFERENCE_PROFILE_ID, INFERENCE_PROFILE_VERSION, inferenceSettingMetadata, type InferenceProfile, type InferenceState } from '@gitspace/protocol/inference';
import type { InferenceController } from './InferenceContext.js';
import { InferencePage, onboardingInferenceGate } from './InferencePage.js';
import type { ProvidersSectionProps } from './ProvidersSection.js';
import { SettingsPage } from './SettingsPage.js';

vi.mock('./rpc-client.js', () => ({ rpcClient: {} }));

const stamp = '2026-10-09T00:00:00.000Z';
const settings: UserSettings = { version: 1, revision: 1, onboardingComplete: false, profile: { displayName: 'Brad', handle: 'brad' }, git: { authorName: '', authorEmail: '' }, defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, machines: { cacheReclaimSeconds: 86400 }, updatedAt: stamp, updatedBy: 'browser' };
const schema = inferenceSettingMetadata.map(({ value, description, options, ...item }) => ({ ...item, valueJson: JSON.stringify(value), description: description ?? null, options: options ?? [] }));
const claude: AvailableModel = { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 200000 };
const connected: ProviderView = { id: 'anthropic', credentialProvider: 'anthropic', name: 'Anthropic', available: true, loginable: true, supportsOAuth: true, supportsApiKey: true, authKind: 'oauth', hasAuth: true, source: null, accounts: [], hasUsage: false };
const noop = async (): Promise<void> => undefined;
const unused = async (): Promise<never> => { throw new Error('Not used by the onboarding inference step'); };

interface Scenario { providers: readonly ProviderView[]; models: readonly AvailableModel[]; modelsReady: boolean; defaultModel: string | null }

function Onboarding({ providers, models, modelsReady, defaultModel }: Scenario) {
  const current: InferenceProfile = { version: INFERENCE_PROFILE_VERSION, id: DEFAULT_INFERENCE_PROFILE_ID, name: 'Default', revision: 1, settings: defaultModel === null ? {} : { modelRoles: { default: defaultModel } }, createdAt: stamp, updatedAt: stamp };
  const state: InferenceState = { version: INFERENCE_PROFILE_VERSION, revision: 1, profiles: [current], assignments: [] };
  const inference: InferenceController = { state, loading: false, pending: false, activationPending: false, error: null, refresh: noop, create: async () => state, update: async () => state, remove: async () => state, assign: async () => state };
  const section: ProvidersSectionProps = { providers, usage: null, usageStatus: 'idle', onShow: () => undefined, onRefreshUsage: noop, onSignIn: noop, onSignOut: noop, onSetApiKey: noop, login: { flow: null, respond: noop, cancel: noop } };
  const gate = onboardingInferenceGate({ profile: current, models, modelsReady, modelsError: null, providers: section });
  return <SettingsPage
    mode="onboarding" settings={settings} machines={[]} runtimeSettings={[]} runtimeGeneration={1}
    inferenceSetup={<InferencePage onboarding initialTab="Providers" inference={inference} selectedProfileId={DEFAULT_INFERENCE_PROFILE_ID} onSelectProfile={() => undefined} projects={[]} schema={schema} schemaLoading={false} schemaError={null} onRefreshSchema={() => undefined} models={models} modelsReady={modelsReady} modelsLoading={!modelsReady} modelsError={null} providers={section} />}
    inferenceReady={gate === 'ready'}
    gitIdentity={null} onChange={() => undefined} onSave={noop} onSetRuntimeSetting={noop} onUpdateMachine={noop} onCreateSandbox={noop}
    cloudImages={[]} cloudImageDefault={null} cloudImageError={null} onChangeCloudImage={noop} onRecoverCloudImage={noop} onSetCloudImageDefault={noop}
    onControlMachine={noop} onDestroyMachine={noop} devices={[]} onRevokeDevice={noop} onSignOut={noop} onCreateApiClient={async () => 'gsk_test'}
    composioSetup={null} onPutComposioSetup={noop} onDeleteComposioSetup={noop} browserRelay={null} onSetupBrowserRelay={noop} onStartBrowserRelay={noop} onUnpairBrowserRelay={noop} onTestBrowserRelay={noop}
    canManageMcp={false} canEnableMcp={false} onMcpStatus={unused} onMcpEnable={unused} onMcpRotate={unused} onMcpDisable={unused}
    canConnectBrowser={false} onCreateBrowserInvitation={unused} onBrowserInvitationStatus={unused} onCancelBrowserInvitation={unused} onBrowserConnected={noop}
    projects={[]} onBack={() => undefined} onComplete={noop} runtimeSync={{ status: 'synced', message: null }} deployment={null} onRevertDeployment={noop} saving={false} error={null}
  />;
}

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Happy DOM has no Web Animations implementation; these fixtures have no active animations.
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

const button = (label: string): HTMLButtonElement | undefined => [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
const render = (scenario: Scenario) => act(() => root.render(<Onboarding {...scenario} />));
async function openInferenceStep(scenario: Scenario): Promise<void> {
  await render(scenario);
  for (let step = 0; step < 2; step += 1) await act(async () => button('Continue')!.click());
  expect(container.textContent).toContain('Set up Default inference');
}
const selectedTab = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const status = () => container.querySelector('[aria-label="Inference setup status"]')?.textContent ?? '';

it('blocks Continue until a provider is connected', async () => {
  await openInferenceStep({ providers: [], models: [], modelsReady: true, defaultModel: null });
  expect(button('Continue')?.disabled).toBe(true);
  expect(status()).toBe('Connect a provider to continue.');
});

it('waits on the model catalog without flashing an error', async () => {
  await openInferenceStep({ providers: [connected], models: [], modelsReady: false, defaultModel: 'anthropic/claude-sonnet' });
  expect(button('Continue')?.disabled).toBe(true);
  expect(status()).toContain('Loading');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('blocks Continue while Default is unset or names a model this profile cannot run', async () => {
  await openInferenceStep({ providers: [connected], models: [claude], modelsReady: true, defaultModel: null });
  expect(button('Continue')?.disabled).toBe(true);
  expect(status()).toContain('Choose a Default model on the Models tab to continue.');
  await render({ providers: [connected], models: [claude], modelsReady: true, defaultModel: 'openai/gpt-4' });
  expect(button('Continue')?.disabled).toBe(true);
  expect(status()).toContain('Choose a Default model on the Models tab to continue.');
});

it('enables Continue once Default resolves to an available model, with or without a thinking level', async () => {
  await openInferenceStep({ providers: [connected], models: [claude], modelsReady: true, defaultModel: 'anthropic/claude-sonnet:high' });
  expect(button('Continue')?.disabled).toBe(false);
  expect(status()).toBe('');
});

it('switches to the Models tab from the status line', async () => {
  await openInferenceStep({ providers: [connected], models: [claude], modelsReady: true, defaultModel: 'openai/gpt-4' });
  expect(selectedTab()).toContain('Providers');
  await act(async () => button('Open Models tab')!.click());
  expect(selectedTab()).toContain('Models');
});

it('lands on the Models tab when a provider connects while Default is unset', async () => {
  await openInferenceStep({ providers: [], models: [], modelsReady: true, defaultModel: null });
  expect(selectedTab()).toContain('Providers');
  await render({ providers: [connected], models: [claude], modelsReady: true, defaultModel: null });
  expect(selectedTab()).toContain('Models');
});
