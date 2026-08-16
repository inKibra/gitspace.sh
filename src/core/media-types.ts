/**
 * Single source of truth for artifact media classification.
 *
 * Before this module the repo carried seven independent extension/MIME tables
 * (artifact panel, right rail, document preview, evidence capture, evidence
 * panel, rubric preview, share allowlist). They disagreed on svg, apng, pdf,
 * html and mov, and none of them knew about audio at all — a music artifact
 * fell through to the binary fallback in every surface.
 *
 * Deliberately NOT encoded here: the share route serves `svg` as `text/plain`
 * as an XSS defense (see `src/lib/tmux-lite/artifact-share.ts`). That is a
 * transport policy for untrusted signed links, not a property of the file type,
 * and must not leak into general classification.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'text' | 'binary';

/** Extension (no dot, lowercase) to canonical MIME type. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  apng: 'image/apng',

  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',

  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',

  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
};

/** MIME types outside their top-level family's default classification. */
const KIND_BY_EXACT_MIME: Record<string, MediaKind> = {
  'application/pdf': 'document',
  'application/json': 'text',
};

const MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/', 'application/'];

/**
 * Canonical MIME for a filename, path, or bare extension. Accepts `photo.png`,
 * `a/b/photo.png`, `png`, `.png`, and any casing.
 */
export function extensionToMime(pathOrExtension: string): string | undefined {
  const trimmed = pathOrExtension.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }
  const afterLastSeparator = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  const dot = afterLastSeparator.lastIndexOf('.');
  // No dot at all means the caller passed a bare extension ("png"); a trailing
  // dot or a dotfile with no suffix has no extension to resolve.
  const extension = dot === -1 ? afterLastSeparator : afterLastSeparator.slice(dot + 1);
  return MIME_BY_EXTENSION[extension];
}

/** Classify one value that may be either a MIME type or a path; undefined when unrecognized. */
function classifyOne(value: string | undefined): MediaKind | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }

  // A MIME type is recognized by its top-level family; anything else is a path.
  const isMimeType = MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  const mime = isMimeType ? normalized : extensionToMime(normalized);
  if (!mime) {
    return undefined;
  }

  const exact = KIND_BY_EXACT_MIME[mime.split(';')[0]!.trim()];
  if (exact) {
    return exact;
  }
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  return 'binary';
}

/**
 * Media kind for an artifact. Both arguments accept either a MIME type or a
 * path, and `primary` wins when the two disagree — callers that know the real
 * Content-Type should pass it first and the filename second as a hint.
 * Unrecognized input classifies as `binary` so callers get a total function.
 */
export function mediaKindFor(primary?: string, fallback?: string): MediaKind {
  return classifyOne(primary) ?? classifyOne(fallback) ?? 'binary';
}

/**
 * True for the kinds that get an inline player or viewer: image, video, audio.
 * Documents and text render through their own surfaces, not the media path.
 */
export function isMedia(primary?: string, fallback?: string): boolean {
  const kind = mediaKindFor(primary, fallback);
  return kind === 'image' || kind === 'video' || kind === 'audio';
}
