/**
 * Chat attachments: every file a person attaches is stored in the workspace drive (`uploads/<YYYY-MM-DD>/<name>`) and
 * named in the message's text by one tag:
 * `<attachment name="…" url="drive://workspace/uploads/…" type="<mime>" size="<bytes>" hash="sha256:<hex>" />`.
 * Before the turn's first model request the workspace makes one model-ready rendition of each (an image resized, a
 * document as Markdown, a recording's transcript) and each model request carries what fits beside the tag.
 */

/**
 * Types a person can attach, besides any `text/*`. HEIC is not one: an iPhone converts a photo to JPEG for an input
 * that does not accept HEIC. `audio/x-m4a` and `audio/x-wav` are the names some browsers give M4A and WAV files.
 */
export const CHAT_ATTACHMENT_TYPES: Record<string, true> = {
  'image/png': true, 'image/jpeg': true, 'image/webp': true, 'image/gif': true,
  'application/pdf': true,
  'text/csv': true, 'text/html': true, 'text/xml': true, 'application/xml': true, 'application/json': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': true,
  'application/vnd.oasis.opendocument.text': true,
  'application/vnd.oasis.opendocument.spreadsheet': true,
  'audio/mpeg': true, 'audio/mp4': true, 'audio/x-m4a': true, 'audio/wav': true, 'audio/x-wav': true, 'audio/webm': true,
};

/** The file input's `accept` list. */
export const CHAT_ATTACHMENT_ACCEPT = ['text/*', ...Object.keys(CHAT_ATTACHMENT_TYPES)].join(',');

export function isChatAttachmentType(type: string): boolean {
  return type.startsWith('text/') || Object.hasOwn(CHAT_ATTACHMENT_TYPES, type);
}

/** One attached file: its drive address, media type, size in bytes and `sha256:<hex>` digest. */
export type ChatAttachment = { name: string; url: string; type: string; size: number; hash: string };

const ESCAPES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };
const UNESCAPES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>' };
const TAG = /<attachment\s([^<>]*?)\/>/gu;
const ATTRIBUTE = /([a-z]+)="([^"]*)"/gu;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const SIZE = /^(0|[1-9][0-9]{0,15})$/u;

const escaped = (value: string) => value.replace(/[&"<>]/gu, character => ESCAPES[character] ?? character);

/** The tag naming `attachment` in a message. */
export function chatAttachmentTag(attachment: ChatAttachment): string {
  return `<attachment name="${escaped(attachment.name)}" url="${escaped(attachment.url)}" type="${escaped(attachment.type)}" size="${attachment.size}" hash="${attachment.hash}" />`;
}

/** The attachments a message's text names, in order; a tag missing an attribute or with a malformed one is not one. */
export function chatAttachments(text: string): ChatAttachment[] {
  const found: ChatAttachment[] = [];
  for (const tag of text.matchAll(TAG)) {
    const attributes = new Map<string, string>();
    for (const [, key, value] of tag[1]!.matchAll(ATTRIBUTE)) attributes.set(key!, value!.replace(/&(amp|quot|lt|gt);/gu, entity => UNESCAPES[entity] ?? entity));
    const name = attributes.get('name'), url = attributes.get('url'), type = attributes.get('type'), size = attributes.get('size'), hash = attributes.get('hash');
    if (!name || !url || !type || !size || !SIZE.test(size) || !hash || !HASH.test(hash)) continue;
    found.push({ name, url, type, size: Number(size), hash });
  }
  return found;
}

/** A message's text without its attachment tags and the white space around them. */
export function withoutChatAttachments(text: string): string {
  return text.replace(/\s*<attachment\s[^<>]*?\/>\s*/gu, ' ').trim();
}
