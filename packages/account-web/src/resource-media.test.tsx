// @vitest-environment happy-dom
import type { TurnBlock } from '@gitspace/blocks';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { ResourceFiles, type ResourceFile } from './resource-files.js';
import { ResourceNavigation, type ResourceRequest } from './ResourceNavigation.js';
import { TurnTranscript } from './TurnTranscript.js';

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  // Happy DOM has no Web Animations implementation; these fixtures have no active animations.
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

const opened: string[] = [];
function Message({ markdown, resolve }: { markdown: string; resolve: ((uri: string) => Promise<ResourceFile>) | null }) {
  const [, setRequest] = useState<ResourceRequest>();
  return <ResourceFiles.Provider value={resolve}>
    <ResourceNavigation.Provider value={(request) => { opened.push(request.uri); setRequest(request); }}>
      <GitSpaceMarkdown>{markdown}</GitSpaceMarkdown>
    </ResourceNavigation.Provider>
  </ResourceFiles.Provider>;
}
async function settle() { for (let round = 0; round < 5; round++) await act(async () => {}); }
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
}

describe('files in messages', () => {
  it('links bare addresses and inline code that is exactly one address, never placeholders or code blocks', async () => {
    opened.length = 0;
    const markdown = 'Saved to drive://workspace/report.html. Chart: `drive://workspace/chart.png`. Pattern: `drive://workspace/<path>`.\n\n```\ndrive://workspace/in-a-block.txt\n```';
    await act(async () => root.render(<Message markdown={markdown} resolve={null} />));
    await settle();
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.textContent)).toEqual(['drive://workspace/report.html', 'drive://workspace/chart.png']);
    expect(anchors[1]?.querySelector('code')).toBeTruthy();
    await click(anchors[0]);
    await click(anchors[1]);
    expect(opened).toEqual(['drive://workspace/report.html', 'drive://workspace/chart.png']);
    expect(container.textContent).toContain('report.html. Chart');
  });

  it('shows images, a video poster that plays when clicked, an audio player, and a card for other files', async () => {
    const types: Record<string, string> = { png: 'image/png', mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip' };
    const resolve = vi.fn(async (uri: string): Promise<ResourceFile> => {
      const name = uri.split('/').at(-1)!;
      return { url: `/files/${name}`, downloadUrl: `/files/${name}?download=1`, size: 2048, mediaType: types[name.split('.').at(-1)!]!, expiresAt: new Date(Date.now() + 7_200_000).toISOString() };
    });
    const markdown = '![Chart](drive://workspace/chart.png)\n\n![Demo](drive://workspace/demo.mp4)\n\n![Voice](drive://workspace/voice.mp3)\n\n![Data](drive://workspace/data.zip)';
    await act(async () => root.render(<Message markdown={markdown} resolve={resolve} />));
    await settle();
    expect(container.querySelector('img[alt="Chart"]')?.getAttribute('src')).toBe('/files/chart.png');
    // Until clicked, the video loads only what its first frame needs and shows no player.
    expect(container.querySelector('video')?.getAttribute('preload')).toBe('metadata');
    expect(container.querySelector('video[controls]')).toBeNull();
    await click(container.querySelector('button[aria-label="Play Demo"]'));
    expect(container.querySelector('video[controls]')?.getAttribute('src')).toBe('/files/demo.mp4');
    expect(container.querySelector('audio[controls]')?.getAttribute('src')).toBe('/files/voice.mp3');
    expect(container.querySelector('a[aria-label="Download Data"]')?.getAttribute('href')).toBe('/files/data.zip?download=1');
    expect(resolve.mock.calls.map(([uri]) => uri)).toEqual(['drive://workspace/chart.png', 'drive://workspace/demo.mp4', 'drive://workspace/voice.mp3', 'drive://workspace/data.zip']);
  });

  it('shows a repository image pinned to a commit beside its current version, or once when unchanged', async () => {
    const commit = 'c'.repeat(40);
    const versions: Record<string, string> = { [`repo://shots/home.png@${commit}`]: 'old', 'repo://shots/home.png': 'new', [`repo://shots/logo.png@${commit}`]: 'same', 'repo://shots/logo.png': 'same' };
    const resolve = vi.fn(async (uri: string): Promise<ResourceFile> => ({ url: `blob:${uri}`, downloadUrl: `blob:${uri}`, size: 10, mediaType: 'image/png', version: versions[uri], expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    await act(async () => root.render(<Message markdown={`![Home](repo://shots/home.png@${commit})\n\n![Logo](repo://shots/logo.png@${commit})`} resolve={resolve} />));
    await settle();
    const compared = container.querySelector(`[aria-label="Home: at ${commit.slice(0, 8)} and now"]`);
    expect([...compared?.querySelectorAll('img') ?? []].map((image) => image.getAttribute('src'))).toEqual([`blob:repo://shots/home.png@${commit}`, 'blob:repo://shots/home.png']);
    expect(compared?.textContent).toContain('Now');
    expect(container.querySelectorAll('img[alt^="Logo"]')).toHaveLength(1);
    expect(container.textContent).toContain(`Unchanged since ${commit.slice(0, 8)}`);
  });

  it('shows a tool call’s images while the call itself is collapsed', () => {
    const turns: TurnBlock[] = [{ id: 'turn', type: 'turn', status: 'done', sideAgents: [], items: [{
      id: 'call', type: 'tool-call', toolCallId: 'call', tool: 'read', target: 'screen.png', status: 'done',
      result: [{ id: 'image', type: 'image', url: 'data:image/png;base64,AA==', alt: 'Screen' }, { id: 'text', type: 'markdown', text: 'Read 1 image' }],
    }] }];
    const page = new DOMParser().parseFromString(renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />), 'text/html');
    const image = page.querySelector('img[src="data:image/png;base64,AA=="]');
    expect(image).toBeTruthy();
    expect(image?.closest('[hidden]')).toBeNull();
    expect(page.querySelector('[hidden]')?.textContent).toContain('Read 1 image');
  });
});
