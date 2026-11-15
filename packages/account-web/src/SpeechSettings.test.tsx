// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_INFERENCE_PROFILE_ID, INFERENCE_PROFILE_VERSION, inferenceSettingMetadata, type InferenceProfile, type InferenceState } from '@gitspace/protocol/inference';
import { InferenceContext, type InferenceController } from './InferenceContext.js';
import { RuntimeSettingsEditor, type RuntimeSettingView } from './SettingsPage.js';
import { SPEECH_SAMPLE_TEXT, VoiceSetup } from './SpeechSettings.js';

const clip = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ status: 'ok' as const, value: { url: 'data:audio/mpeg;base64,AAAA', durationMs: 1200, duration: 'measured' as const } })));
vi.mock('./rpc-client.js', () => ({ rpcClient: { speech: { clip } } }));

const stamp = '2026-11-15T00:00:00.000Z';
let root: Root;
let container: HTMLDivElement;
let played: string[];
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  played = [];
  vi.stubGlobal('Audio', class { constructor(readonly src: string) {} addEventListener() {} pause() {} async play() { played.push(this.src); } });
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  clip.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

const speechItem = (value: string): RuntimeSettingView => {
  const item = inferenceSettingMetadata.find((entry) => entry.path === 'speech')!;
  return { path: item.path, label: item.label, tab: item.tab, description: item.description ?? null, kind: 'string', valueJson: JSON.stringify(value), options: [], credential: false };
};
async function choose(trigger: string, option: string): Promise<void> {
  await act(() => document.body.querySelector<HTMLElement>(`[aria-label="${trigger}"]`)!.click());
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].findLast((element) => element.textContent === option);
  if (!item) throw new Error(`No option ${option}`);
  await act(() => item.click());
}
const button = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it('offers Speech on the Services tab: model, voice with its description, a sample, and Off, saving the choice', async () => {
  const saved: Array<[string, unknown]> = [];
  await act(() => root.render(<RuntimeSettingsEditor sections={['Services']} tab="Services" profileId="work" runtimeSettings={[speechItem('cloudflare/aura-2-en:athena')]} runtimeGeneration={1} saving={false}
    onSetRuntimeSetting={async (path, value) => { saved.push([path, value]); }} />));
  expect(container.textContent).toContain('Athena: Feminine, American, mature: calm, smooth, professional');
  await choose('Speech voice', 'Zeus');
  expect(saved.at(-1)).toEqual(['speech', 'cloudflare/aura-2-en:zeus']);
  await act(async () => button('Play the Athena sample')!.click());
  expect(clip).toHaveBeenCalledWith({ workspace: null, profileId: 'work', text: SPEECH_SAMPLE_TEXT, voice: 'cloudflare/aura-2-en:athena' });
  expect(played).toEqual(['data:audio/mpeg;base64,AAAA']);
  await choose('Speech', 'Off · captions only');
  expect(saved.at(-1)).toEqual(['speech', 'off']);
});

it('shows Speech stored as off with no voice to pick, and turning it on chooses the default voice', async () => {
  const saved: unknown[] = [];
  await act(() => root.render(<RuntimeSettingsEditor sections={['Services']} tab="Services" runtimeSettings={[speechItem('off')]} runtimeGeneration={1} saving={false} onSetRuntimeSetting={async (_path, value) => { saved.push(value); }} />));
  expect(button('Speech voice')).toBeNull();
  await choose('Speech', 'Cloudflare · Aura-2 English');
  expect(saved).toEqual(['cloudflare/aura-2-en:athena']);
});

it('the onboarding Voice step lists the voices with samples and Off, and saves the choice to the Default profile', async () => {
  const profile: InferenceProfile = { version: INFERENCE_PROFILE_VERSION, id: DEFAULT_INFERENCE_PROFILE_ID, name: 'Default', revision: 3, settings: {}, createdAt: stamp, updatedAt: stamp };
  const state: InferenceState = { version: INFERENCE_PROFILE_VERSION, revision: 3, profiles: [profile], assignments: [] };
  const update = vi.fn(async (_profile: InferenceProfile, _name: string, _settings: InferenceProfile['settings']) => state);
  const inference: InferenceController = { state, loading: false, pending: false, error: null, refresh: async () => undefined, create: async () => state, update, remove: async () => state, assign: async () => state };
  await act(() => root.render(<InferenceContext.Provider value={inference}><VoiceSetup /></InferenceContext.Provider>));
  expect(container.textContent).toContain('Agents can narrate walkthroughs; pick the voice you’ll hear.');
  expect(button('Narrate with Athena')?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => button('Play the Luna sample')!.click());
  expect(clip).toHaveBeenCalledWith({ workspace: null, profileId: DEFAULT_INFERENCE_PROFILE_ID, text: SPEECH_SAMPLE_TEXT, voice: 'cloudflare/aura-2-en:luna' });
  await act(async () => button('Narrate with Luna')!.click());
  expect(update).toHaveBeenLastCalledWith(profile, 'Default', { speech: 'cloudflare/aura-2-en:luna' });
  await act(async () => button('Captions only, no voice')!.click());
  expect(update).toHaveBeenLastCalledWith(profile, 'Default', { speech: 'off' });
});
