/**
 * `generate_image` on Cloudflare Workers AI, for a profile whose Images service is `cloudflare/<model>`: Black Forest
 * Labs' FLUX models on the worker's AI binding, billed to the platform's Cloudflare account. As Cloudflare's model pages
 * and launch notes give them:
 * - FLUX.2 [dev], [klein] 4B and [klein] 9B (`@cf/black-forest-labs/flux-2-*`) take multipart form data only, passed to
 *   the binding as `{ multipart: { body, contentType } }`: `prompt` and up to 4 input images, binary, as
 *   `input_image_0` … `input_image_3` (each smaller than 512×512, the notes say). They answer `{ image }`, base64.
 * - FLUX.1 [schnell] (`@cf/black-forest-labs/flux-1-schnell`) takes JSON `{ prompt }` (at most 2,048 characters) and no
 *   input images, and answers `{ image }`, a base64 JPEG.
 * Width and height are left to the model's defaults (FLUX.2: 1024×768): the tool's arguments carry no size. The image's
 * type is read from its bytes.
 */
import type { ImageContent } from '@earendil-works/pi-ai';

type Flux2 = '@cf/black-forest-labs/flux-2-klein-9b' | '@cf/black-forest-labs/flux-2-klein-4b' | '@cf/black-forest-labs/flux-2-dev';
const FLUX_2: Readonly<Record<string, Flux2>> = {
  'flux-2-klein-9b': '@cf/black-forest-labs/flux-2-klein-9b',
  'flux-2-klein-4b': '@cf/black-forest-labs/flux-2-klein-4b',
  'flux-2-dev': '@cf/black-forest-labs/flux-2-dev',
};
/** FLUX.2's form fields name four input images. */
const FLUX_2_INPUT_IMAGES = 4;

/** Runs Workers AI's `model` (a `cloudflare/<model>` selector's model) and returns its image. */
export async function workersAiImage(ai: Ai, model: string, input: { prompt: string; images?: readonly ImageContent[] }, signal?: AbortSignal): Promise<ImageContent> {
  const images = input.images ?? [];
  let produced: string | undefined;
  if (model === 'flux-1-schnell') {
    if (images.length) throw new Error('FLUX.1 [schnell] takes no input images; FLUX.2 models do');
    produced = (await ai.run('@cf/black-forest-labs/flux-1-schnell', { prompt: input.prompt }, { signal })).image;
  } else {
    const name = Object.hasOwn(FLUX_2, model) ? FLUX_2[model] : undefined;
    if (!name) throw new Error('Workers AI has no such image model here');
    if (images.length > FLUX_2_INPUT_IMAGES) throw new Error(`FLUX.2 takes at most ${FLUX_2_INPUT_IMAGES} input images, not ${images.length}`);
    const form = new FormData();
    form.append('prompt', input.prompt);
    images.forEach((image, index) => form.append(`input_image_${index}`, new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType })));
    // A Response serializes the form and names its boundary in its content type, which the binding needs.
    const encoded = new Response(form);
    const contentType = encoded.headers.get('content-type');
    produced = (await ai.run(name, { multipart: { body: encoded.body ?? undefined, ...(contentType ? { contentType } : {}) } }, { signal })).image;
  }
  if (!produced) throw new Error('Workers AI returned no image');
  return { type: 'image', mimeType: imageType(produced), data: produced };
}

/** The type of a base64 image, from its first bytes. */
function imageType(base64: string): string {
  const head = atob(base64.slice(0, 16));
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Workers AI returned an image of an unknown type');
}
