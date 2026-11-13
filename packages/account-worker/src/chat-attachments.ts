import { isChatAttachmentType, type ChatAttachment } from '@gitspace/protocol-runtime/chat-attachments';
import { base64Length, type AttachmentRendition } from '@gitspace/runtime-core/inference';
import type { DocumentMarkdown } from './document-markdown.js';
import type { StoredImages } from './runtime-images.js';

/**
 * Chat attachments' renditions (`@gitspace/protocol-runtime/chat-attachments`): what a model can use of each attached
 * file, made once per content and kept in the workspace object by the original's hash, apart from the drive's
 * `uploads/` where the original stays.
 * - An image becomes one stored image (`runtime-images.ts`) within the strictest limits models state, 2000 px a side
 *   and 4.5 MB of base64: kept as it is when it already fits as PNG, JPEG or WebP, else resized and encoded as WebP
 *   by the Images binding.
 * - A PDF, Office or OpenDocument file, HTML, CSV or XML becomes Markdown (`document-markdown.ts`). No model pi-ai lists
 *   reads a PDF itself (its input kinds are text and image), so a PDF is sent as Markdown only.
 * - A recording becomes its transcript, by Workers AI's Whisper (`dictation.ts`).
 * - Text and JSON are their text.
 * - Any other file (a PowerPoint deck, which the converter does not read) has no rendition: its tag names its link.
 * A rendition that could not be made is a note, kept in memory only, so the object's next start tries again.
 */

/** What renditions are made from. */
export type ChatAttachmentSources = {
  /** The attached file's bytes: the version its hash names. */
  read(attachment: ChatAttachment): Promise<Uint8Array<ArrayBuffer>>;
  images: Pick<ImagesBinding, 'info' | 'input'>;
  stored: Pick<StoredImages, 'put'>;
  documentMarkdown: DocumentMarkdown;
  /** A recording's text. */
  transcribe(audio: Uint8Array<ArrayBuffer>): Promise<string>;
};
export type ChatAttachmentRenditions = (attachments: readonly ChatAttachment[], signal: AbortSignal) => Promise<ReadonlyMap<string, AttachmentRendition>>;

const IMAGE_EDGE = 2000;
const IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;
/** WebP qualities tried in turn until the rendition fits. */
const IMAGE_QUALITIES = [85, 70, 50];
const SENT_AS_IS: Record<string, true> = { 'image/png': true, 'image/jpeg': true, 'image/webp': true };
const RENDITION = 'SELECT kind,image,mime_type,form,characters FROM chat_attachment_renditions WHERE hash=?';
/** Characters of rendition text per row; one SQLite value stays well under its size limit. */
const PART_CHARACTERS = 512 * 1024;

type Row = { kind: string; image: string | null; mime_type: string | null; form: string | null; characters: number | null };
type Made = { kind: 'image'; image: { data: string; mimeType: string } } | { kind: 'text'; form: 'markdown' | 'transcript' | 'text'; text: string } | { kind: 'none' };

/** The image as a model takes it: itself when it fits, else resized and encoded as WebP. */
async function imageRendition(images: ChatAttachmentSources['images'], bytes: Uint8Array<ArrayBuffer>): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const info = await images.info(new Blob([bytes]).stream());
  if ('width' in info && SENT_AS_IS[info.format] && info.width <= IMAGE_EDGE && info.height <= IMAGE_EDGE && base64Length(bytes.byteLength) <= IMAGE_BASE64_BYTES) return { mimeType: info.format, bytes };
  for (const quality of IMAGE_QUALITIES) {
    const output = await images.input(new Blob([bytes]).stream()).transform({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'scale-down' }).output({ format: 'image/webp', quality, anim: false });
    const resized = await new Response(output.image()).bytes();
    if (base64Length(resized.byteLength) <= IMAGE_BASE64_BYTES) return { mimeType: 'image/webp', bytes: resized };
  }
  throw new Error(`it stays over ${IMAGE_BASE64_BYTES / 1024 / 1024} MB at ${IMAGE_EDGE} px`);
}

export function createChatAttachmentRenditions(storage: DurableObjectStorage, sources: ChatAttachmentSources): ChatAttachmentRenditions {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS chat_attachment_renditions(hash TEXT PRIMARY KEY, kind TEXT NOT NULL, image TEXT, mime_type TEXT, form TEXT, characters INTEGER)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS chat_attachment_text(hash TEXT NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(hash, part))');
  const notes = new Map<string, string>();
  const making = new Map<string, Promise<void>>();

  async function make(attachment: ChatAttachment): Promise<Made> {
    const type = (attachment.type.split(';')[0] ?? '').trim().toLowerCase();
    if (!isChatAttachmentType(type)) return { kind: 'none' };
    const bytes = await sources.read(attachment);
    if (type.startsWith('image/')) {
      const image = await imageRendition(sources.images, bytes);
      return { kind: 'image', image: await sources.stored.put(image.mimeType, image.bytes) };
    }
    if (type.startsWith('audio/')) return { kind: 'text', form: 'transcript', text: await sources.transcribe(bytes) };
    const document = await sources.documentMarkdown(attachment.name, bytes, type);
    if (document !== null) return { kind: 'text', form: 'markdown', text: document };
    if (!type.startsWith('text/') && type !== 'application/json') return { kind: 'none' };
    try { return { kind: 'text', form: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
    catch (error) { if (error instanceof TypeError) throw new Error('it is not UTF-8 text'); throw error; }
  }

  function keep(hash: string, made: Made): void {
    storage.transactionSync(() => {
      if (made.kind === 'image') storage.sql.exec('INSERT OR REPLACE INTO chat_attachment_renditions(hash,kind,image,mime_type) VALUES(?,?,?,?)', hash, 'image', made.image.data, made.image.mimeType);
      else if (made.kind === 'none') storage.sql.exec('INSERT OR REPLACE INTO chat_attachment_renditions(hash,kind) VALUES(?,?)', hash, 'none');
      else {
        storage.sql.exec('DELETE FROM chat_attachment_text WHERE hash=?', hash);
        for (let part = 0; part * PART_CHARACTERS < made.text.length; part++) storage.sql.exec('INSERT INTO chat_attachment_text(hash,part,text) VALUES(?,?,?)', hash, part, made.text.slice(part * PART_CHARACTERS, (part + 1) * PART_CHARACTERS));
        storage.sql.exec('INSERT OR REPLACE INTO chat_attachment_renditions(hash,kind,form,characters) VALUES(?,?,?,?)', hash, 'text', made.form, made.text.length);
      }
    });
  }

  function rendition(hash: string, row: Row): AttachmentRendition | null {
    if (row.kind === 'image' && row.image !== null && row.mime_type !== null) return { kind: 'image', image: { type: 'image', data: row.image, mimeType: row.mime_type } };
    if (row.kind !== 'text' || row.characters === null || (row.form !== 'markdown' && row.form !== 'transcript' && row.form !== 'text')) return null;
    return {
      kind: 'text', form: row.form, characters: row.characters,
      read(characters) {
        const rows = storage.sql.exec<{ text: string }>('SELECT text FROM chat_attachment_text WHERE hash=? AND part<? ORDER BY part', hash, Math.ceil(characters / PART_CHARACTERS)).toArray();
        return rows.map(item => item.text).join('').slice(0, characters);
      },
    };
  }

  return async (attachments, signal) => {
    const renditions = new Map<string, AttachmentRendition>();
    const unique = new Map(attachments.map(attachment => [attachment.hash, attachment]));
    // One at a time: each holds its file whole, up to 16 MiB, in this object's memory.
    for (const [hash, attachment] of unique) {
      let row = storage.sql.exec<Row>(RENDITION, hash).toArray()[0];
      if (!row && !notes.has(hash)) {
        let pending = making.get(hash);
        if (!pending) {
          pending = make(attachment).then(made => keep(hash, made), (error: unknown) => {
            if (signal.aborted) throw error;
            notes.set(hash, error instanceof Error ? error.message : String(error));
          }).finally(() => making.delete(hash));
          making.set(hash, pending);
        }
        await pending;
        signal.throwIfAborted();
        row = storage.sql.exec<Row>(RENDITION, hash).toArray()[0];
      }
      const made = row ? rendition(hash, row) : null;
      const note = notes.get(hash);
      if (made) renditions.set(hash, made);
      else if (note !== undefined) renditions.set(hash, { kind: 'note', note });
    }
    return renditions;
  };
}
