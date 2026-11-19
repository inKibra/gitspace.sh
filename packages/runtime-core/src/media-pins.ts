// Media pins: a message shows each drive file it embeds as the file was when the message was stored, however often the
// file is written again under its name. Embedded means drawn in the message: a Markdown image, a gitspace-ui Image's or
// Video's `src` and a Video's `poster`, wherever the spec holds them (its elements, a Sequence frame); a plain link
// opens the file as it is now. The versions are read from the drive catalog and kept in `MediaPinsDoc`: a reply's by
// the generation hook before pi stores it, so before any of its tool calls runs; a person's message in the commit that
// takes it. A file that does not exist is not pinned and shows as it is when it does.
import { extractBlocks, fenceSpec } from '@gitspace/protocol/gitspace-ui';
import { parseResourceUri } from '@gitspace/protocol/resource-uri';

/** The address of a Markdown image of a drive file: `![alt](drive://…)`, the address optionally in angle brackets. */
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\(\s*<?(drive:\/\/[^\s<>)]+)/gu;
/** The gitspace-ui components that draw a drive file. */
const MEDIA_COMPONENTS: Record<string, true> = { Image: true, Video: true };

/** The current version (`sha256:…`) of each drive address that names a file, by the address; an address naming no file
 * is left out. */
export type DriveVersions = (urls: readonly string[]) => Promise<Record<string, string>>;

/** The drive files `markdown` embeds, each once, by its address (`parseResourceUri(...).url`). */
export function embeddedDriveMedia(markdown: string): string[] {
  if (!markdown.includes('drive://')) return [];
  const found = new Set<string>();
  const add = (value: unknown): void => {
    const resource = typeof value === 'string' ? parseResourceUri(value) : null;
    if (resource?.kind === 'drive') found.add(resource.url);
  };
  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) add(match[1]);
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if ('type' in value && 'props' in value && typeof value.type === 'string' && Object.hasOwn(MEDIA_COMPONENTS, value.type)) {
      const props = value.props;
      if (typeof props === 'object' && props !== null) {
        if ('src' in props) add(props.src);
        if ('poster' in props) add(props.poster);
      }
    }
    Object.values(value).forEach(visit);
  };
  for (const block of extractBlocks(markdown)) {
    if (block.kind !== 'gitspace-ui') continue;
    const read = fenceSpec(block.body, block.info);
    if ('spec' in read) visit(read.spec);
  }
  return [...found];
}
