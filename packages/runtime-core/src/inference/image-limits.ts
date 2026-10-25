import { DEFAULT_IMAGE_LIMITS } from '@earendil-works/pi-durable/tools';
import type { Api, Context, ImageContent, Model, TextContent } from '@earendil-works/pi-ai';

/**
 * What a model accepts of images, from pi-ai's per-model `inputLimits` (Opus 5.5: 2000x2000 px, 4.5 MB of base64, 600
 * per request, 32 MiB per request), else pi's defaults. Nothing resizes images yet: one over these limits is replaced
 * by a note saying why, so a single oversized screenshot cannot fail every later turn of a conversation.
 */
export interface ImageLimits { maxWidth: number; maxHeight: number; maxBytes: number; maxPerRequest: number; maxImageBytes: number; maxRequestBytes: number | null }

/**
 * GitSpace's own ceiling on the images in one request, below what models accept: a workspace object builds each request
 * in its 128 MB isolate (the history, then the serialized body and its bytes), and 26 screenshots (15.9 MB of a 17.6 MB
 * request) exhausted it on every attempt. 16 images, or 10 MB of base64 (above 16 typical screenshots, so the count
 * decides unless images are unusually large), whichever comes first.
 */
const REQUEST_IMAGES = 16;
const REQUEST_IMAGE_BYTES = 10 * 1024 * 1024;
/** A subagent's ceiling: up to 4 of them run at once in the same object, each doing one task, so each sends at most 4
 * images or 4 MB of them (dropped in blocks of 2). */
export const SUBAGENT_REQUEST_IMAGES = 4;
export const SUBAGENT_REQUEST_IMAGE_BYTES = 4 * 1024 * 1024;

export function imageLimits(model: Pick<Model<Api>, 'inputLimits'> | undefined): ImageLimits {
  const images = model?.inputLimits?.images;
  return {
    maxWidth: images?.resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
    maxHeight: images?.resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
    maxBytes: images?.resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
    maxPerRequest: Math.min(images?.maxPerRequest ?? REQUEST_IMAGES, REQUEST_IMAGES),
    maxImageBytes: REQUEST_IMAGE_BYTES,
    maxRequestBytes: model?.inputLimits?.maxRequestBytes ?? null,
  };
}

/** Enough base64 for any header this reads; a JPEG whose frame header lies beyond it is decoded whole. */
const HEADER_BASE64 = 65_536;

/** The width and height an image declares in its header, without decoding it; null when it cannot be read. */
export function imageDimensions(image: Pick<ImageContent, 'data' | 'mimeType'>): { width: number; height: number } | null {
  const read = (length: number) => { try { return Uint8Array.from(atob(image.data.slice(0, length)), character => character.charCodeAt(0)); } catch { return null; } };
  const head = read(HEADER_BASE64);
  if (!head) return null;
  const at16 = (bytes: Uint8Array, offset: number) => (bytes[offset]! << 8) | bytes[offset + 1]!;
  if (image.mimeType === 'image/png' && head.length >= 24) return { width: new DataView(head.buffer).getUint32(16), height: new DataView(head.buffer).getUint32(20) };
  if (image.mimeType === 'image/gif' && head.length >= 10) return { width: head[6]! | (head[7]! << 8), height: head[8]! | (head[9]! << 8) };
  if (image.mimeType === 'image/webp' && head.length >= 30) {
    const chunk = String.fromCharCode(...head.subarray(12, 16));
    if (chunk === 'VP8 ') return { width: (head[26]! | (head[27]! << 8)) & 0x3fff, height: (head[28]! | (head[29]! << 8)) & 0x3fff };
    if (chunk === 'VP8L') return { width: 1 + (((head[22]! & 0x3f) << 8) | head[21]!), height: 1 + (((head[24]! & 0x0f) << 10) | (head[23]! << 2) | ((head[22]! & 0xc0) >> 6)) };
    if (chunk === 'VP8X') return { width: 1 + (head[24]! | (head[25]! << 8) | (head[26]! << 16)), height: 1 + (head[27]! | (head[28]! << 8) | (head[29]! << 16)) };
    return null;
  }
  if (image.mimeType !== 'image/jpeg') return null;
  // The first start-of-frame segment (SOF0–SOF15 except DHT, JPG and DAC) carries the size.
  for (const bytes of [head, image.data.length > HEADER_BASE64 ? read(image.data.length) : null]) {
    if (!bytes) continue;
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: at16(bytes, offset + 7), height: at16(bytes, offset + 5) };
      offset += 2 + at16(bytes, offset + 2);
    }
  }
  return null;
}

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Why an image cannot be sent to a model with `limits`, or null when it can. */
export function imageRefusal(image: Pick<ImageContent, 'data' | 'mimeType'>, limits: ImageLimits): string | null {
  if (image.data.length > limits.maxBytes) return `${megabytes(image.data.length)}, more than the ${megabytes(limits.maxBytes)} the model accepts`;
  const size = imageDimensions(image);
  if (!size) return null;
  if (size.width > limits.maxWidth || size.height > limits.maxHeight) return `${size.width}x${size.height}, larger than the ${limits.maxWidth}x${limits.maxHeight} the model accepts`;
  return null;
}

/** A tool's result content with every image the model cannot take replaced by a note, so the image never enters history. */
export function admitToolImages<T extends TextContent | ImageContent>(content: readonly T[], limits: ImageLimits): Array<T | TextContent> {
  return content.map(item => {
    if (item.type !== 'image') return item;
    const refusal = imageRefusal(item, limits);
    return refusal === null ? item : { type: 'text', text: `[Image not shown: it is ${refusal}. Crop it, capture only the visible viewport, or describe what you need from it.]` };
  });
}

/**
 * The request to send, fitted to its image limits: an image over the size limits becomes a note; past the per-request
 * count or byte budget, the oldest images become notes in blocks of half the count limit, so the omitted set (and the
 * prompt cache before it) changes once per block rather than on every turn. Stored history is unchanged; only what is
 * sent differs.
 */
export function fitRequestImages(context: Context, limits: ImageLimits): Context {
  type Located = { message: number; part: number; bytes: number };
  const images: Located[] = [];
  const refusals = new Map<string, string>();
  let textBytes = 0;
  context.messages.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'toolResult') return;
    if (typeof message.content === 'string') { textBytes += message.content.length; return; }
    message.content.forEach((part, partIndex) => {
      if (part.type === 'text') { textBytes += part.text.length; return; }
      const refusal = imageRefusal(part, limits);
      if (refusal !== null) refusals.set(`${index}:${partIndex}`, `[Image not shown: it is ${refusal}.]`);
      else images.push({ message: index, part: partIndex, bytes: part.data.length });
    });
  });
  const block = Math.max(1, Math.floor(limits.maxPerRequest / 2));
  let omitted = images.length > limits.maxPerRequest ? Math.ceil((images.length - limits.maxPerRequest) / block) * block : 0;
  // Kept images are the newest; the model's request budget counts text too, as the request does.
  const budget = Math.min(limits.maxImageBytes, limits.maxRequestBytes === null ? Infinity : limits.maxRequestBytes - textBytes);
  // The newest image is always sent: it alone is within `maxBytes`, below the budget.
  while (omitted < images.length - 1 && images.slice(omitted).reduce((total, image) => total + image.bytes, 0) > budget) omitted = Math.min(images.length - 1, omitted + block);
  for (const image of images.slice(0, omitted)) refusals.set(`${image.message}:${image.part}`, '[Image not shown: older images were left out to keep this request within its image limits. Capture it again if you need it.]');
  if (refusals.size === 0) return context;
  return {
    ...context,
    messages: context.messages.map((message, index) => {
      if ((message.role !== 'user' && message.role !== 'toolResult') || typeof message.content === 'string') return message;
      if (!message.content.some((_part, partIndex) => refusals.has(`${index}:${partIndex}`))) return message;
      const content = message.content.map((part, partIndex): TextContent | ImageContent => {
        const note = refusals.get(`${index}:${partIndex}`);
        return note === undefined ? part : { type: 'text', text: note };
      });
      return { ...message, content };
    }),
  };
}
