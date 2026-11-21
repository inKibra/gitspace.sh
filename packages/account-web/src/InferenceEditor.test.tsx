// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSettingsEditor, type RuntimeSettingView } from './SettingsPage.js';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('preserves an unsaved configuration draft and rejects its stale revision instead of overwriting a remote edit', async () => {
  let currentRevision = 1;
  let stored = ['private/original-model'];
  const render = async (revision: number) => {
    const item: RuntimeSettingView = { path: 'enabledModels', label: 'Enabled models', tab: 'models', description: null, kind: 'array', valueJson: JSON.stringify(stored), options: [], credential: false };
    await act(() => root.render(<RuntimeSettingsEditor sections={['Models']} tab="Models" runtimeSettings={[item]} runtimeGeneration={revision} saving={false} onSetRuntimeSetting={async (_path, value) => {
      if (revision !== currentRevision) throw new Error('Concurrent edit: refresh before saving');
      stored = value as typeof stored;
    }} />));
  };
  await render(1);
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Enabled models"]')!;
  const draft = '["private/my-draft"]';
  await act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, draft);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  currentRevision = 2;
  stored = ['private/remote-edit'];
  await render(2);
  expect(input.value).toBe(draft);
  await act(async () => input.blur());
  expect(stored).toEqual(['private/remote-edit']);
  expect(input.value).toBe(draft);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  const discard = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Discard draft')!;
  await act(() => discard.click());
  expect(input.value).toContain('private/remote-edit');
  expect(input.getAttribute('aria-invalid')).toBe('false');
});

it('only marks a configured model unavailable after its catalog has loaded', async () => {
  const item: RuntimeSettingView = { path: 'modelRoles', label: 'Model roles', tab: 'models', description: null, kind: 'record', valueJson: JSON.stringify({ default: 'private/saved-model' }), options: [], credential: false };
  const render = async (modelsReady: boolean) => {
    await act(() => root.render(<RuntimeSettingsEditor sections={['Models']} tab="Models" runtimeSettings={[item]} runtimeGeneration={1} models={[]} modelsReady={modelsReady} saving={false} onSetRuntimeSetting={async () => undefined} />));
  };
  await render(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('[aria-label="Model for Default"]')?.value).toBe('private/saved-model');
  expect(container.querySelector<HTMLInputElement>('[aria-label="Model for Default"]')?.disabled).toBe(true);
  await render(true);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('[aria-label="Model for Default"]')?.disabled).toBe(false);
});

it('shows a service stored as off as Off, a choice of every Services row', async () => {
  const item = (path: string, value: string): RuntimeSettingView => ({ path, label: path, tab: 'services', description: null, kind: 'string', valueJson: JSON.stringify(value), options: [], credential: false });
  await act(() => root.render(<RuntimeSettingsEditor sections={['Services']} tab="Services" runtimeSettings={[item('search', 'off'), item('dictation', 'off'), item('images', 'off')]} runtimeGeneration={1} models={[]} modelsReady saving={false} onSetRuntimeSetting={async () => undefined} />));
  for (const label of ['Web search', 'Dictation', 'Images']) expect(container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)?.value).toBe('Off');
  // Off is a choice, not a model this profile cannot run.
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('offers Decisions on Cloudflare and on the profile\'s own decision models', async () => {
  const render = async (value: string, decisionModels: { provider: string; id: string; name: string; contextWindow: null; images: boolean }[]) => {
    const item: RuntimeSettingView = { path: 'decisions', label: 'Decisions', tab: 'services', description: null, kind: 'string', valueJson: JSON.stringify(value), options: [], credential: false };
    await act(() => root.render(<RuntimeSettingsEditor sections={['Services']} tab="Services" runtimeSettings={[item]} runtimeGeneration={1} models={[]} decisionModels={decisionModels} modelsReady saving={false} onSetRuntimeSetting={async () => undefined} />));
  };
  const jev = { provider: 'typesafe', id: 'jev-latest', name: 'Jev', contextWindow: null, images: true };
  const picker = () => container.querySelector<HTMLInputElement>('[aria-label="Decisions"]');
  await render('cloudflare/clef-flash', []);
  expect(picker()?.value).toBe('Cloudflare · Clef-flash · fastest');
  expect(container.textContent).toContain('GitSpace\'s Cloudflare account');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await render('typesafe/jev-latest', [jev]);
  expect(picker()?.value).toBe('Jev');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  // A decision model the profile's credentials no longer reach is shown as such.
  await render('typesafe/jev-latest', []);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
