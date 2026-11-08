// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { ArtifactReference, InspectorArtifactContent, LoadStatus } from '../inspector/inspector-shared.js';
import { GuideCapture, type GuideCaptures } from './GuideCapture.js';

const hash = `sha256:${'1'.repeat(64)}`;
const ref = (path: string, mediaType: string | null, label: string): ArtifactReference => ({ kind: 'artifact', url: `drive://workspace/${path}`, hash, generation: 1, label, mediaType });
const image = ref('shots/after.png', 'image/png', 'After');
const video = ref('shots/walkthrough.webm', 'video/webm', 'Walkthrough');
const json = ref('evidence/run.json', 'application/json', 'Run evidence');
const capture = ref('browser/captures/c1/capture.json', 'application/json', 'Checkout capture');
const poster = ref('browser/captures/c1/thumbnail.jpg', 'image/jpeg', 'thumbnail');
const recording = ref('browser/captures/c1/video.webm', 'video/webm', 'video');
const archive = ref('evidence/bench.zip', 'application/zip', 'Bench archive');
const content = (url: string, mediaType: string, source: string | null): InspectorArtifactContent => ({ url, source, mediaType, previewUrl: `blob:${url}` });

let root: Root;
let container: HTMLDivElement;
let status: Record<string, LoadStatus>;
let loaded: Record<string, InspectorArtifactContent>;
let errors: Record<string, string>;
let load: Mock<(reference: ArtifactReference) => void>;
const captures = (): GuideCaptures => ({
  content: (reference) => loaded[reference.url] ?? null,
  status: (reference) => status[reference.url],
  error: (reference) => errors[reference.url],
  load,
  size: (reference) => reference.url === json.url ? 2048 : null,
  browserCapture: () => ({ poster, recording }),
});
const opened: ArtifactReference[] = [];
async function show(reference: ArtifactReference) {
  await act(async () => root.render(<GuideCapture reference={reference} captures={captures()} onOpen={(target) => { if (target.kind === 'artifact') opened.push(target); }} />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  status = {}; loaded = {}; errors = {}; opened.length = 0;
  load = vi.fn((reference: ArtifactReference) => { status[reference.url] = 'loading'; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('shows each kind of capture as what it is once read, and loading only while the read is pending', async () => {
  await show(image);
  expect(load).toHaveBeenCalledWith(image);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading the capture…');
  loaded[image.url] = content(image.url, 'image/png', null); status[image.url] = 'loaded';
  await show(image);
  expect(container.querySelector('img')?.getAttribute('src')).toBe(`blob:${image.url}`);
  expect(container.querySelector('[role="status"]')).toBeNull();

  loaded[video.url] = content(video.url, 'video/webm', null); status[video.url] = 'loaded';
  await show(video);
  expect(container.querySelector('video')?.getAttribute('src')).toBe(`blob:${video.url}`);

  loaded[json.url] = content(json.url, 'application/json', JSON.stringify({ run: 7, passed: true }));
  status[json.url] = 'loaded';
  await show(json);
  expect(container.textContent).toContain('run.json');
  expect(container.textContent).toContain('2 KiB · application/json');
  expect(container.querySelector('pre')?.textContent).toBe('{\n  "run": 7,\n  "passed": true\n}');
  await act(async () => container.querySelector<HTMLElement>('[aria-label="Open run.json"]')!.click());
  expect(opened).toEqual([json]);

  loaded[poster.url] = content(poster.url, 'image/jpeg', null); status[poster.url] = 'loaded';
  await show(capture);
  expect(container.querySelector('img')?.getAttribute('src')).toBe(`blob:${poster.url}`);
  await act(async () => container.querySelector<HTMLElement>('[aria-label="Play Checkout capture"]')!.click());
  expect(opened).toEqual([json, recording]);

  load.mockClear();
  await show(archive);
  expect(load).not.toHaveBeenCalled();
  expect(container.textContent).toContain('bench.zip');
  expect(container.textContent).not.toContain('Loading');
});

it('shows why a read failed, and Retry reads it again', async () => {
  status[image.url] = 'error'; errors[image.url] = 'shots/after.png is not in this drive';
  await show(image);
  expect(load).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('shots/after.png is not in this drive');
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click());
  expect(load).toHaveBeenCalledWith(image);
});
