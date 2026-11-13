import type { ImageContent, Message, TextContent } from '@earendil-works/pi-ai';
import { chatAttachments, type ChatAttachment } from '@gitspace/protocol-runtime/chat-attachments';

/**
 * A chat attachment made ready for models (`@gitspace/protocol-runtime/chat-attachments`), kept by the original's hash:
 * - `image`: the stored rendition, at most 2000 px a side and 4.5 MB, a reference like any conversation image;
 * - `text`: a document's Markdown, a recording's transcript or a text file's text, `characters` long; `read` gives its
 *   first characters, so a request reads only what it sends;
 * - `note`: why the file has no rendition (it could not be converted).
 * A file of any other type has no rendition: its tag, which names its drive link, is all a model gets.
 */
export type AttachmentRendition =
  | { kind: 'image'; image: ImageContent }
  | { kind: 'text'; form: 'markdown' | 'transcript' | 'text'; characters: number; read(characters: number): string }
  | { kind: 'note'; note: string };

/** The share of a model's context window that attachment text takes in one request at most. */
const ATTACHMENT_CONTEXT_SHARE = 0.25;
/** Characters a token stands for when the share is counted in characters; low for code and tables. */
const CHARACTERS_PER_TOKEN = 3;
/** Less of a text than this is not sent in part: the attachment is named with its link only. */
const LEAST_PART = 2_000;

function userText(message: Message): string {
  if (message.role !== 'user') return '';
  return typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
}

/** Every attachment the person's messages name, oldest first. */
export function messageAttachments(messages: readonly Message[]): ChatAttachment[] {
  return messages.flatMap(message => chatAttachments(userText(message)));
}

/**
 * The messages of one request with each person's message followed by its attachments' renditions: images as images
 * (sent within the model's image limits like any other, `fitRequestImages`), text inside the message within a quarter
 * of `contextWindow` (tokens) for all attachments together. The newest attachments come first: one that no longer fits
 * is sent in part with where to read the rest, and older ones only name their link. Undefined when nothing is added.
 */
export function withAttachmentRenditions(messages: readonly Message[], renditions: ReadonlyMap<string, AttachmentRendition>, contextWindow: number): Message[] | undefined {
  let budget = Math.floor(contextWindow * ATTACHMENT_CONTEXT_SHARE * CHARACTERS_PER_TOKEN);
  const added = new Map<number, Array<TextContent | ImageContent>>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const named = chatAttachments(userText(messages[index]!));
    if (!named.length) continue;
    const parts: Array<Array<TextContent | ImageContent>> = [];
    for (let at = named.length - 1; at >= 0; at--) {
      const attachment = named[at]!;
      const rendition = renditions.get(attachment.hash);
      const url = attachment.url.replaceAll('"', '%22');
      if (!rendition) parts[at] = [];
      else if (rendition.kind === 'image') parts[at] = [rendition.image];
      else if (rendition.kind === 'note') parts[at] = [{ type: 'text', text: `[${attachment.name} has no model-ready form: ${rendition.note}. Read it from ${attachment.url}.]` }];
      else if (rendition.characters <= budget) {
        budget -= rendition.characters;
        parts[at] = [{ type: 'text', text: `<attachment-content url="${url}" form="${rendition.form}">\n${rendition.read(rendition.characters)}\n</attachment-content>` }];
      } else if (budget >= LEAST_PART) {
        parts[at] = [{ type: 'text', text: `<attachment-content url="${url}" form="${rendition.form}">\n${rendition.read(budget)}\n[… ${(rendition.characters - budget).toLocaleString('en-US')} more characters: read the rest from ${attachment.url}]\n</attachment-content>` }];
        budget = 0;
      } else parts[at] = [{ type: 'text', text: `[${attachment.name} (${rendition.characters.toLocaleString('en-US')} characters of ${rendition.form}) is not in this request: read it from ${attachment.url}.]` }];
    }
    const flat = parts.flat();
    if (flat.length) added.set(index, flat);
  }
  if (!added.size) return undefined;
  return messages.map((message, index) => {
    const parts = added.get(index);
    if (!parts || message.role !== 'user') return message;
    const content: Array<TextContent | ImageContent> = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    return { ...message, content: [...content, ...parts] };
  });
}
