import type { Api, ImageContent, Message, Model, Models, TextContent } from '@earendil-works/pi-ai';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { resolveVisionFallback, type ResolvedProfileModel } from './admission.js';

/** Descriptions are kept by image content hash, so an image in history is described once, not every turn. */
export interface ImageDescriptionCache {
  read(hash: string): Promise<string | undefined>;
  write(hash: string, description: string): Promise<void>;
}
export interface DescribeImagesInput {
  model: Model<Api>;
  settings: InferenceProfile['settings'];
  models: Models;
  messages: readonly Message[];
  cache: ImageDescriptionCache;
  signal?: AbortSignal;
}

const PROMPT = 'Describe this image for an assistant that cannot see it. Transcribe all visible text exactly, then describe layout, UI state, charts or diagrams, and anything someone would need to act on. Reply with the description only.';

/**
 * For a model that cannot read images, replaces each image with the Vision fallback's description. Returns undefined
 * when nothing changes: the model reads images, no message has one, or the profile sets no fallback (Pi then tells the
 * model the image was omitted).
 */
export async function describeImagesForModel(input: DescribeImagesInput): Promise<Message[] | undefined> {
  if (input.model.input.includes('image')) return undefined;
  let fallback: ResolvedProfileModel | null | undefined;
  let changed = false;
  const described: Message[] = [];
  for (const message of input.messages) {
    if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content) || !message.content.some(block => block.type === 'image')) { described.push(message); continue; }
    if (fallback === undefined) fallback = await resolveVisionFallback(input.settings, input.models);
    if (!fallback) return undefined;
    const vision = fallback;
    const label = `${vision.model.provider}/${vision.model.id}`;
    const content: Array<TextContent | ImageContent> = [];
    for (const block of message.content) {
      if (block.type !== 'image') { content.push(block); continue; }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${block.mimeType}\n${block.data}`));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      let description = await input.cache.read(hash);
      if (description === undefined) {
        const reply = await input.models.completeSimple(vision.model, { messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, block], timestamp: Date.now() }] }, { ...(input.signal ? { signal: input.signal } : {}), ...(vision.thinking === null || vision.thinking === 'off' ? {} : { reasoning: vision.thinking }) });
        if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(`Vision fallback ${label} could not describe an image: ${reply.errorMessage ?? reply.stopReason}`);
        description = reply.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim();
        if (!description) throw new Error(`Vision fallback ${label} returned no description`);
        await input.cache.write(hash, description);
      }
      content.push({ type: 'text', text: `[Image described by ${label}]\n${description}` });
    }
    changed = true;
    described.push({ ...message, content });
  }
  return changed ? described : undefined;
}
