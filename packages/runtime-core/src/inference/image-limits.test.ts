import { expect, it } from 'vitest';
import type { Context, ImageContent, Message } from '@earendil-works/pi-ai';
import { fitRequestImages, imageLimits, type ImageLimits } from './image-limits.js';
import { imageReference } from '@gitspace/protocol-runtime/image-reference';

/** A PNG that declares `width`x`height` in its IHDR; nothing after the header is needed to read its size. */
function png(width: number, height: number, padding = 0): ImageContent {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return { type: 'image', mimeType: 'image/png', data: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) };
}
/** A JPEG whose frame header (SOF0) follows an APP0 segment, as camera and browser JPEGs do. */
function jpeg(width: number, height: number): ImageContent {
  const bytes = [0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array<number>(14).fill(0), 0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...new Array<number>(9).fill(0)];
  return { type: 'image', mimeType: 'image/jpeg', data: btoa(String.fromCharCode(...bytes)) };
}
const screenshot = (image: ImageContent, id: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'web_browser', content: [{ type: 'text', text: `capture ${id}` }, image], isError: false, timestamp: 1 });
const sent = (context: Context) => context.messages.flatMap(message => message.role === 'toolResult' ? message.content.map(part => part.type === 'image' ? 'image' : part.text) : []);
const opus: ImageLimits = imageLimits({ inputLimits: { maxRequestBytes: 33_554_432, images: { maxPerRequest: 600, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592 } } } });

it('sends an image over the model\'s size as a note naming its size, and leaves the stored conversation as it was', () => {
  const context: Context = { messages: [screenshot(png(1440, 5400), 'tall'), screenshot(jpeg(3200, 1800), 'wide'), screenshot(png(1280, 800), 'fits')] };
  const fitted = fitRequestImages(context, opus);
  expect(sent(fitted)).toEqual([
    'capture tall', '[Image not shown: it is 1440x5400, larger than the 2000x2000 the model accepts.]',
    'capture wide', '[Image not shown: it is 3200x1800, larger than the 2000x2000 the model accepts.]',
    'capture fits', 'image',
  ]);
  expect(sent(context)).toEqual(['capture tall', 'image', 'capture wide', 'image', 'capture fits', 'image']);
  // A request with nothing to fit is sent as it is.
  const fits: Context = { messages: [screenshot(png(1280, 800), 'fits')] };
  expect(fitRequestImages(fits, opus)).toBe(fits);
});

it('sends at most 16 images, leaving out the oldest in blocks of 8 so one more image does not change what was left out', () => {
  const shown = (count: number) => sent(fitRequestImages({ messages: Array.from({ length: count }, (_, index) => screenshot(png(100, 100), String(index))) }, opus)).filter((_, index) => index % 2 === 1).map(part => part === 'image');
  // Opus accepts 600 a request; GitSpace sends 16.
  expect(shown(16).every(Boolean)).toBe(true);
  expect(shown(17)).toEqual([...new Array<boolean>(8).fill(false), ...new Array<boolean>(9).fill(true)]);
  expect(shown(24)).toEqual([...new Array<boolean>(8).fill(false), ...new Array<boolean>(16).fill(true)]);
  expect(shown(25)).toEqual([...new Array<boolean>(16).fill(false), ...new Array<boolean>(9).fill(true)]);
});

it('leaves out the oldest images until the request fits its byte budget', () => {
  const image = png(100, 100, 3_000);
  const limits: ImageLimits = { ...opus, maxInlinePerRequest: 4, maxRequestBytes: image.data.length * 2 + 200 };
  const fitted = fitRequestImages({ messages: ['a', 'b', 'c', 'd'].map(id => screenshot(image, id)) }, limits);
  expect(sent(fitted).filter(part => part === 'image')).toHaveLength(2);
  expect(sent(fitted).slice(0, 2)).toEqual(['capture a', '[Image not shown: older images were left out to keep this request within its image limits. Capture it again if you need it.]']);
});

it('sends at most 10 MB of images however few there are, and always the newest', () => {
  // Four 3 MB screenshots: past 10 MB the oldest block goes, but the newest is kept.
  const large = png(1000, 1000, 2_400_000);
  const fitted = fitRequestImages({ messages: ['a', 'b', 'c', 'd'].map(id => screenshot(large, id)) }, opus);
  expect(sent(fitted).filter(part => part === 'image')).toHaveLength(1);
  expect(sent(fitted).at(-1)).toBe('image');
  // 26 typical screenshots (about 600 KB each, as in the request that exhausted a workspace object) send the newest 10.
  const typical = png(1280, 800, 450_000);
  const many = sent(fitRequestImages({ messages: Array.from({ length: 26 }, (_, index) => screenshot(typical, String(index))) }, opus)).filter(part => part === 'image');
  expect(many).toHaveLength(10);
});

/** A stored image: its reference in place of its bytes. */
const stored = (id: string, size = 600_000, width = 1280, height = 800): ImageContent => ({ type: 'image', mimeType: 'image/png', data: imageReference({ workspaceId: 'w1', size, width, height, sha256: id.padStart(64, '0') }) });

it('leaves a stored image larger than the model accepts out of every request, saying why, as it does an inline one', () => {
  const fitted = sent(fitRequestImages({ messages: [screenshot(stored('1', 600_000, 3000, 900), '1'), screenshot(stored('2'), '2'), screenshot(stored('3', 600_000, 0, 0), '3')] }, opus));
  expect(fitted).toEqual(['capture 1', '[Image not shown: it is 3000x900, larger than the 2000x2000 the model accepts.]', 'capture 2', 'image', 'capture 3', 'image']);
});

it('sends stored images up to the model\'s own limits, not the cap on images held in the request', () => {
  // 60 stored screenshots of 600 KB (36 MB of base64 once written in) against Opus's 32 MiB: the oldest go in blocks of 8.
  const fitted = sent(fitRequestImages({ messages: Array.from({ length: 60 }, (_, index) => screenshot(stored(String(index)), String(index))) }, opus));
  const kept = fitted.filter(part => part === 'image');
  expect(kept.length).toBeGreaterThan(16);
  expect(kept.length * 800_000).toBeLessThanOrEqual(33_554_432);
  expect(fitted.at(-1)).toBe('image');
  // A model with a count of 20: 24 stored images send the newest 16 after one block of 8 goes.
  expect(sent(fitRequestImages({ messages: Array.from({ length: 24 }, (_, index) => screenshot(stored(String(index), 1_000), String(index))) }, { ...opus, maxPerRequest: 20 })).filter(part => part === 'image')).toHaveLength(16);
});

it('holds at most 16 images in a request beside any number of stored ones', () => {
  const messages = [
    ...Array.from({ length: 20 }, (_, index) => screenshot(png(100, 100), `held ${index}`)),
    ...Array.from({ length: 20 }, (_, index) => screenshot(stored(String(index), 1_000), `stored ${index}`)),
  ];
  const fitted = sent(fitRequestImages({ messages }, opus));
  // The oldest 8 held images go; the 12 newer held and all 20 stored are sent.
  expect(fitted.filter(part => part === 'image')).toHaveLength(32);
  expect(fitted.slice(0, 2)).toEqual(['capture held 0', '[Image not shown: older images were left out to keep this request within its image limits. Capture it again if you need it.]']);
});
