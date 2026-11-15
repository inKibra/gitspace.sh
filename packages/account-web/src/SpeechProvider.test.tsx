// @vitest-environment happy-dom
import { act, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_INFERENCE_PROFILE_ID, INFERENCE_PROFILE_VERSION, type InferenceProfile, type InferenceState } from '@gitspace/protocol/inference';
import { setCurrentDevice } from './device-session.js';
import { InferenceContext, type InferenceController } from './InferenceContext.js';
import { SpeechContext, type Speech } from './speech.js';
import { SpeechProvider, browserVoiceKey } from './SpeechProvider.js';

const clip = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ status: 'ok' as const, value: { url: 'https://test.gitspace.sh/files/clip', durationMs: 2100, duration: 'measured' as const } })));
vi.mock('./rpc-client.js', () => ({ rpcClient: { speech: { clip } } }));

const stamp = '2026-11-15T00:00:00.000Z';
let root: Root;
let container: HTMLDivElement;
let speech: Speech | null = null;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.clear();
  clip.mockClear();
  speech = null;
  const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  setCurrentDevice({ deviceId: 'browser-1', label: 'Browser', publicKey: 'key', keyPair, enrolledAt: 0, userId: 'account-1', enrollUrl: 'https://test.gitspace.sh', canDelegate: false });
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Probe() { speech = useContext(SpeechContext); return null; }
function inference(speechSetting: string | undefined): InferenceController {
  const profile: InferenceProfile = { version: INFERENCE_PROFILE_VERSION, id: 'work', name: 'Work', revision: 1, settings: speechSetting === undefined ? {} : { speech: speechSetting }, createdAt: stamp, updatedAt: stamp };
  const fallback: InferenceProfile = { ...profile, id: DEFAULT_INFERENCE_PROFILE_ID, name: 'Default', settings: { speech: 'off' } };
  const state: InferenceState = { version: INFERENCE_PROFILE_VERSION, revision: 1, profiles: [fallback, profile], assignments: [{ projectId: 'project-1', profileId: 'work', revision: 1 }] };
  return { state, loading: false, pending: false, error: null, refresh: async () => undefined, create: async () => state, update: async () => state, remove: async () => state, assign: async () => state };
}
const render = (speechSetting: string | undefined) => act(async () => root.render(<InferenceContext.Provider value={inference(speechSetting)}><SpeechProvider projectId="project-1" workspaceId="workspace-1"><Probe /></SpeechProvider></InferenceContext.Provider>));

it('speaks in the project profile’s voice until this browser picks another, and remembers that choice per account', async () => {
  await render('cloudflare/aura-2-en:athena');
  expect(speech?.voice).toEqual({ id: 'cloudflare/aura-2-en:athena', label: 'Athena' });
  expect(speech?.voices).toHaveLength(40);
  await act(async () => speech!.setBrowserVoice('cloudflare/aura-2-en:zeus'));
  expect(speech?.voice).toEqual({ id: 'cloudflare/aura-2-en:zeus', label: 'Zeus' });
  expect(window.localStorage.getItem(browserVoiceKey('account-1'))).toBe('cloudflare/aura-2-en:zeus');
  // Another page load reads the browser's choice back.
  await act(() => root.unmount());
  root = createRoot(container);
  await render('cloudflare/aura-2-en:athena');
  expect(speech?.voice?.id).toBe('cloudflare/aura-2-en:zeus');
  await act(async () => speech!.setBrowserVoice(null));
  expect(speech?.voice?.id).toBe('cloudflare/aura-2-en:athena');
});

it('asks for a line once per voice and text, in the voice heard, and has no voice when the profile turned Speech off', async () => {
  window.localStorage.setItem(browserVoiceKey('account-1'), 'cloudflare/aura-2-en:luna');
  await render(undefined);
  const signal = new AbortController().signal;
  const [first, second] = await Promise.all([speech!.clip('The slot is held.', signal), speech!.clip('The slot is held.', signal)]);
  expect(first).toEqual({ url: 'https://test.gitspace.sh/files/clip', durationMs: 2100 });
  expect(second).toEqual(first);
  expect(clip).toHaveBeenCalledTimes(1);
  expect(clip).toHaveBeenCalledWith({ workspace: { projectId: 'project-1', workspaceId: 'workspace-1' }, text: 'The slot is held.', voice: 'cloudflare/aura-2-en:luna' });
  await render('off');
  expect(speech?.voice).toBeNull();
  expect(await speech!.clip('The slot is held.', signal)).toBeNull();
  expect(clip).toHaveBeenCalledTimes(1);
});
