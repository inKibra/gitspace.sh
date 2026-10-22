import { expect, it } from 'vitest';
import type { Context, ImageContent, Message } from '@earendil-works/pi-ai';
import { fitRequestImages, imageLimits, type ImageLimits } from './image-limits.js';

/** A PNG that declares `width`x`height` in its IHDR; nothing after the header is needed to read its size. */
function png(width: number, height: number, padding = 0): ImageContent {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return { type: 'image', mimeType: 'image/png', data: btoa(String.fromCharCode(...bytes)) };
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

it('leaves out the oldest images past the per-request count in blocks, so one more image does not change what was left out', () => {
  const limits: ImageLimits = { ...opus, maxPerRequest: 8 };
  const conversation = (count: number): Context => ({ messages: Array.from({ length: count }, (_, index) => screenshot(png(100, 100), String(index))) });
  const shown = (count: number) => sent(fitRequestImages(conversation(count), limits)).filter((_, index) => index % 2 === 1).map(part => part === 'image');
  expect(shown(8).every(Boolean)).toBe(true);
  // Past 8 the oldest 2 (a quarter of the limit) go at once, and stay the same 2 at 10.
  expect(shown(9)).toEqual([false, false, ...new Array<boolean>(7).fill(true)]);
  expect(shown(10)).toEqual([false, false, ...new Array<boolean>(8).fill(true)]);
  expect(shown(11)).toEqual([false, false, false, false, ...new Array<boolean>(7).fill(true)]);
});

it('leaves out the oldest images until the request fits the model\'s byte budget', () => {
  const image = png(100, 100, 3_000);
  const limits: ImageLimits = { ...opus, maxPerRequest: 4, maxRequestBytes: image.data.length * 2 + 200 };
  const fitted = fitRequestImages({ messages: ['a', 'b', 'c', 'd'].map(id => screenshot(image, id)) }, limits);
  expect(sent(fitted).filter(part => part === 'image')).toHaveLength(2);
  expect(sent(fitted).slice(0, 2)).toEqual(['capture a', '[Image not shown: older images were left out to keep this request within the model\'s limits.]']);
});
