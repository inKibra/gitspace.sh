// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OmpSettingsEditor, type OmpSettingView } from './SettingsPage.js';

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
  let stored = { client: 'private/original-model' };
  const render = async (revision: number) => {
    const item: OmpSettingView = { path: 'modelTags', label: 'Model tags', tab: 'models', description: null, kind: 'record', valueJson: JSON.stringify(stored), options: [], credential: false };
    await act(() => root.render(<OmpSettingsEditor sections={['Models']} ompSettings={[item]} ompGeneration={revision} saving={false} onSetOmpSetting={async (_path, value) => {
      if (revision !== currentRevision) throw new Error('Concurrent edit: refresh before saving');
      stored = value as typeof stored;
    }} />));
  };
  await render(1);
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Model tags"]')!;
  const draft = '{"client":"private/my-draft"}';
  await act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, draft);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  currentRevision = 2;
  stored = { client: 'private/remote-edit' };
  await render(2);
  expect(input.value).toBe(draft);
  await act(async () => input.blur());
  expect(stored).toEqual({ client: 'private/remote-edit' });
  expect(input.value).toBe(draft);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  const discard = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Discard draft')!;
  await act(() => discard.click());
  expect(input.value).toContain('private/remote-edit');
  expect(input.getAttribute('aria-invalid')).toBe('false');
});

it('only marks a configured model unavailable after its catalog has loaded', async () => {
  const item: OmpSettingView = { path: 'modelRoles', label: 'Model roles', tab: 'models', description: null, kind: 'record', valueJson: JSON.stringify({ default: 'private/saved-model' }), options: [], credential: false };
  const render = async (modelsReady: boolean) => {
    await act(() => root.render(<OmpSettingsEditor sections={['Models']} ompSettings={[item]} ompGeneration={1} models={[]} modelsReady={modelsReady} saving={false} onSetOmpSetting={async () => undefined} />));
  };
  await render(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('[aria-label="Model for Default"]')?.value).toBe('private/saved-model');
  expect(container.querySelector<HTMLInputElement>('[aria-label="Model for Default"]')?.disabled).toBe(true);
  await render(true);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('[aria-label="Model for Default"]')?.disabled).toBe(false);
});
