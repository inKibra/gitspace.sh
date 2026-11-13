import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { parseImageReference } from '@gitspace/protocol-runtime/image-reference';
import type { ChatAttachment } from '@gitspace/protocol-runtime/chat-attachments';
import type { AttachmentRendition } from '@gitspace/runtime-core/inference';
import { beforeEach, expect, it, vi } from 'vitest';
import { tenantRootPrivateKey } from './setup.js';
import { createChatAttachmentRenditions, type ChatAttachmentSources } from '../src/chat-attachments.js';
import { storedImages } from '../src/runtime-images.js';

beforeEach(async () => {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
});

async function attached(name: string, type: string, bytes: Uint8Array<ArrayBuffer>): Promise<ChatAttachment> {
  return { name, url: `drive://workspace/uploads/2026-11-13/${name}`, type, size: bytes.byteLength, hash: `sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')}` };
}

/** A PNG of `width`x`height` as its header declares, padded to `size` bytes. */
function png(width: number, height: number, size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A WebP (VP8X) of `width`x`height` as its header declares, padded to `size` bytes. */
function webp(width: number, height: number, size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0]);
  bytes.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, (width - 1) >> 16], 24);
  bytes.set([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, (height - 1) >> 16], 27);
  return bytes;
}

/** The Images binding as far as renditions use it: it reads a PNG's size, and scales down within the transform's box,
 * encoding a WebP of about a tenth of the source's bytes. */
function images(): ChatAttachmentSources['images'] & { transforms: ImageTransform[] } {
  const transforms: ImageTransform[] = [];
  const size = async (stream: ReadableStream<Uint8Array>) => {
    const view = new DataView((await new Response(stream).bytes()).buffer);
    return { width: view.getUint32(16), height: view.getUint32(20), fileSize: view.byteLength };
  };
  return {
    transforms,
    async info(stream) { return { format: 'image/png', ...await size(stream) }; },
    input(stream) {
      const transformer: ImageTransformer = {
        transform(transform) { transforms.push(transform); return transformer; },
        draw() { throw new Error('Renditions draw nothing'); },
        async output(options) {
          const source = await size(stream);
          const box = transforms.at(-1) ?? {};
          const scale = Math.min(1, (box.width ?? source.width) / source.width, (box.height ?? source.height) / source.height);
          const encoded = webp(Math.round(source.width * scale), Math.round(source.height * scale), Math.ceil(source.fileSize / 10));
          return { contentType: () => options.format, image: () => new Blob([encoded]).stream(), response: () => new Response(encoded) };
        },
      };
      return transformer;
    },
  };
}

it('makes an oversized PNG one stored WebP within 2000 px and 4.5 MB, and an image that fits is kept as it is', async () => {
  const workspaceId = `attachments-${crypto.randomUUID()}`;
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(workspaceId), async (_instance, state) => {
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    const binding = images();
    const renditions = createChatAttachmentRenditions(state.storage, {
      read: async attachment => files.get(attachment.hash)!, images: binding, stored: storedImages(env, workspaceId),
      documentMarkdown: async () => null, transcribe: async () => { throw new Error('No recording here'); },
    });
    const large = png(6000, 4000, 12 * 1024 * 1024), small = png(800, 600, 40_000);
    const screenshot = await attached('screenshot.png', 'image/png', large), icon = await attached('icon.png', 'image/png', small);
    files.set(screenshot.hash, large); files.set(icon.hash, small);
    const made = await renditions([screenshot, icon], new AbortController().signal);
    const image = (rendition: AttachmentRendition | undefined) => rendition?.kind === 'image' ? rendition.image : null;
    const resized = image(made.get(screenshot.hash));
    expect(resized?.mimeType).toBe('image/webp');
    const reference = parseImageReference(resized?.data ?? '');
    expect(reference).toMatchObject({ workspaceId, width: 2000, height: 1333 });
    expect(Math.ceil(reference!.size / 3) * 4).toBeLessThanOrEqual(4.5 * 1024 * 1024);
    // The stored rendition is the one image the request reads.
    expect((await storedImages(env, workspaceId).load(resized!)).data.length).toBe(Math.ceil(reference!.size / 3) * 4);
    expect(binding.transforms).toEqual([{ width: 2000, height: 2000, fit: 'scale-down' }]);
    expect(parseImageReference(image(made.get(icon.hash))?.data ?? '')).toMatchObject({ width: 800, height: 600, size: small.byteLength });
  });
});

it('makes a PDF its Markdown and a recording its transcript once per content, however often they are attached', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`attachments-${crypto.randomUUID()}`), async (_instance, state) => {
    const pdf = new TextEncoder().encode('%PDF-1.4 report'), audio = new TextEncoder().encode('ID3 recording');
    const report = await attached('report.pdf', 'application/pdf', pdf), memo = await attached('memo.m4a', 'audio/mp4', audio);
    const files = new Map([[report.hash, pdf], [memo.hash, audio]]);
    const read = vi.fn(async (attachment: ChatAttachment) => files.get(attachment.hash)!);
    const documentMarkdown = vi.fn(async (_name: string, _bytes: Uint8Array<ArrayBuffer>, type?: string) => type === 'application/pdf' ? '# report.pdf\nRevenue was 42 million.' : null);
    const transcribe = vi.fn(async () => 'Ship it on Friday.');
    const renditions = createChatAttachmentRenditions(state.storage, { read, images: images(), stored: storedImages(env, 'unused'), documentMarkdown, transcribe });
    const text = (rendition: AttachmentRendition | undefined) => rendition?.kind === 'text' ? { form: rendition.form, text: rendition.read(rendition.characters) } : null;
    const first = await renditions([report, memo], new AbortController().signal);
    expect(text(first.get(report.hash))).toEqual({ form: 'markdown', text: '# report.pdf\nRevenue was 42 million.' });
    expect(text(first.get(memo.hash))).toEqual({ form: 'transcript', text: 'Ship it on Friday.' });
    // The same bytes attached again under another name, in a later request, are not read or converted again.
    const again = await renditions([{ ...report, name: 'copy of report.pdf', url: 'drive://workspace/uploads/2026-11-14/copy of report.pdf' }, memo], new AbortController().signal);
    expect(text(again.get(report.hash))?.text).toContain('Revenue was 42 million.');
    expect(read).toHaveBeenCalledTimes(2);
    expect(documentMarkdown).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();
  });
});
