import { useState, type ReactNode } from 'react';
import { parseResourceUri, resourceMediaType, resourceUriFromHref } from '@gitspace/protocol/resource-uri';
import { Dialog, DialogContent, DialogTitle, Tooltip, useShape } from '@gitspace/ui';
import { Download01, File06, PlayCircle } from '@untitledui/icons';
import { formatBytes } from './inspector/artifact-upload.js';
import { useResourceFile } from './resource-files.js';
import { MarkdownResourceLink, ResourceLink } from './ResourceNavigation.js';

/** An image as a thumbnail that opens full size. */
export function TranscriptImage({ alt, label, src }: { alt: string; label: string; src: string }) {
  const [open, setOpen] = useState(false);
  const shape = useShape();
  return <>
    <button
      aria-label={label}
      className={`${shape.container} block w-fit max-w-full cursor-zoom-in overflow-hidden bg-surface-2 shadow-surface-1 outline-none transition-transform duration-80 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]`}
      onClick={() => setOpen(true)}
      type="button"
    >
      <img
        alt={alt}
        className="block max-h-64 max-w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        loading="lazy"
        src={src}
      />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] !max-w-[calc(100vw-2rem)] items-center justify-center overflow-hidden bg-surface-1 p-4" size="lg">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img
          alt={alt}
          className={`${shape.container} block max-h-[calc(100dvh-4rem)] max-w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10`}
          src={src}
        />
      </DialogContent>
    </Dialog>
  </>;
}

/** A video's first frame with a play button; only metadata loads until it is clicked, then it plays in place. */
function VideoPoster({ src, label }: { src: string; label: string }) {
  const [playing, setPlaying] = useState(false);
  const shape = useShape();
  if (playing) return <video autoPlay controls className={`${shape.container} block max-h-96 max-w-full bg-black`} src={src} />;
  return <button
    aria-label={`Play ${label}`}
    className={`${shape.container} relative block w-fit max-w-full overflow-hidden bg-black shadow-surface-1 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]`}
    onClick={() => setPlaying(true)}
    type="button"
  >
    {/* `#t=0.1` asks for the first frame as the poster; `preload="metadata"` keeps the rest unloaded. */}
    <video className="block max-h-64 max-w-full" muted playsInline preload="metadata" src={`${src}#t=0.1`} />
    <span className="absolute inset-0 flex items-center justify-center bg-black/25"><PlayCircle width={48} height={48} strokeWidth={1.25} className="text-white drop-shadow" /></span>
  </button>;
}

/** A file that has no inline view: its name, size, and a download. */
function FileCard({ uri, label, size, downloadUrl }: { uri: string; label: string; size: number | null; downloadUrl: string | null }) {
  const shape = useShape();
  return <span className={`${shape.container} inline-flex min-w-0 max-w-full items-center gap-2 bg-surface-2 px-3 py-2 shadow-surface-1`}>
    <File06 width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
    <ResourceLink className="min-w-0 text-body text-foreground [overflow-wrap:anywhere] hover:underline" href={uri}>{label}</ResourceLink>
    {size !== null ? <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{formatBytes(size)}</span> : null}
    {downloadUrl ? <a aria-label={`Download ${label}`} className="shrink-0 text-muted-foreground hover:text-foreground" download={label} href={downloadUrl}><Download01 width={16} height={16} strokeWidth={1.5} /></a> : null}
  </span>;
}

function fileName(uri: string): string {
  const resource = parseResourceUri(uri);
  const path = resource?.kind === 'drive' || resource?.kind === 'repo' ? resource.path : uri;
  return decodeURIComponent(path.split('/').at(-1) || path);
}

/** A file shown in a message: images and video by their content, audio as a player, anything else as a card. Its
 * type is known from its name first, so the right frame shows while the file URL is fetched. */
export function ResourceMedia({ uri, alt }: { uri: string; alt?: string }) {
  const resource = parseResourceUri(uri);
  const label = alt || fileName(uri);
  const named = resource?.kind === 'drive' || resource?.kind === 'repo' ? resourceMediaType(resource.path) : null;
  if (resource?.kind === 'repo' && resource.commit && named?.startsWith('image/') && named !== 'image/svg+xml') return <RepositoryImageComparison uri={uri} path={resource.path} commit={resource.commit} label={label} />;
  return <ResourceFileView uri={uri} label={label} named={named} />;
}

function ResourceFileView({ uri, label, named }: { uri: string; label: string; named: string | null }) {
  const { file, error, unavailable } = useResourceFile(uri);
  const mediaType = file?.mediaType ?? named;
  if (unavailable || error) return <span className="inline-flex flex-col gap-1">
    <FileCard uri={uri} label={label} size={null} downloadUrl={null} />
    {error ? <span role="alert" className="text-caption text-destructive">{error}</span> : null}
  </span>;
  if (!file) return <span aria-busy="true" aria-label={`Loading ${label}`} className="block h-24 w-40 animate-pulse rounded-md bg-surface-2" />;
  if (mediaType?.startsWith('image/') && mediaType !== 'image/svg+xml') return <TranscriptImage alt={label} label={`Open ${label}`} src={file.url} />;
  if (mediaType?.startsWith('video/')) return <VideoPoster label={label} src={file.url} />;
  if (mediaType?.startsWith('audio/')) return <audio aria-label={label} className="block w-full max-w-md" controls preload="metadata" src={file.url} />;
  return <FileCard uri={uri} label={label} size={file.size} downloadUrl={file.downloadUrl} />;
}

/** A repository image pinned to a commit beside its current version, or once when the two are the same content. */
function RepositoryImageComparison({ uri, path, commit, label }: { uri: string; path: string; commit: string; label: string }) {
  const pinned = useResourceFile(uri);
  const current = useResourceFile(`repo://${path.split('/').map(encodeURIComponent).join('/')}`);
  const at = commit.slice(0, 8);
  if (pinned.error || pinned.unavailable) return <ResourceFileView uri={uri} label={label} named={null} />;
  if (!pinned.file || (!current.file && !current.error)) return <span aria-busy="true" aria-label={`Loading ${label}`} className="block h-24 w-40 animate-pulse rounded-md bg-surface-2" />;
  const caption = 'mt-1 block text-caption text-muted-foreground';
  if (current.file?.version !== undefined && current.file.version === pinned.file.version) return <figure className="inline-block">
    <TranscriptImage alt={label} label={`Open ${label}`} src={pinned.file.url} /><figcaption className={caption}>Unchanged since {at}</figcaption>
  </figure>;
  return <div className="flex min-w-0 flex-wrap items-start gap-3" role="group" aria-label={`${label}: at ${at} and now`}>
    <figure><TranscriptImage alt={`${label} at ${at}`} label={`Open ${label} at ${at}`} src={pinned.file.url} /><figcaption className={caption}>At {at}</figcaption></figure>
    <figure>{current.file ? <TranscriptImage alt={`${label} now`} label={`Open ${label} now`} src={current.file.url} /> : null}<figcaption className={caption}>{current.file ? 'Now' : 'Not in the workspace now'}</figcaption></figure>
  </div>;
}

/** A thumbnail shown while hovering a link to an image; it loads only then. */
export function ImageHoverPreview({ uri }: { uri: string }) {
  const { file, error } = useResourceFile(uri);
  if (error) return <span className="text-caption">{error}</span>;
  if (!file) return <span aria-busy="true" className="block h-24 w-32 animate-pulse rounded-md bg-surface-3" />;
  return <img alt={fileName(uri)} className="block max-h-48 max-w-64 rounded-md object-contain" src={file.url} />;
}

interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

/** A `gitspace-media` element from Markdown: its properties come untyped from the Markdown tree. */
export function MarkdownResourceMedia(props: Record<string, unknown>) {
  return typeof props.uri === 'string' ? <ResourceMedia uri={props.uri} alt={typeof props.alt === 'string' ? props.alt : undefined} /> : null;
}

/** A resource link in Markdown; a link to an image previews it on hover. */
export function MarkdownResourceAnchor(props: Record<string, unknown> & { href?: string; children?: ReactNode }) {
  const uri = props.href ? resourceUriFromHref(props.href) : null;
  const resource = uri ? parseResourceUri(uri) : null;
  const mediaType = resource?.kind === 'drive' || resource?.kind === 'repo' ? resourceMediaType(resource.path) : null;
  const link = <MarkdownResourceLink {...props} />;
  return uri && mediaType?.startsWith('image/') && mediaType !== 'image/svg+xml' ? <Tooltip content={<ImageHoverPreview uri={uri} />} delayDuration={300}><span className="inline">{link}</span></Tooltip> : link;
}

// Same-origin placeholder: the sanitizer and URL hardener keep it, then it becomes a media element.
const MEDIA_PATH = '/__gitspace-resource-media/';

/** Before sanitization: marks images whose source is a resource address. */
export function rehypeResourceMediaMarkers() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      const src = node.properties?.src;
      if (node.tagName === 'img' && typeof src === 'string' && (parseResourceUri(src)?.kind === 'drive' || parseResourceUri(src)?.kind === 'repo')) node.properties = { ...node.properties, src: `${MEDIA_PATH}${encodeURIComponent(src)}` };
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** After URL hardening: each marked image becomes a `gitspace-media` element that renders the file by its type. */
export function rehypeResourceMedia(origin: string) {
  return () => (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      const src = node.properties?.src;
      if (node.tagName === 'img' && typeof src === 'string') {
        let path = '';
        try { path = new URL(src, origin).pathname; } catch { /* Not a marker. */ }
        if (path.startsWith(MEDIA_PATH)) {
          node.tagName = 'gitspace-media';
          node.properties = { uri: decodeURIComponent(path.slice(MEDIA_PATH.length)), alt: typeof node.properties?.alt === 'string' ? node.properties.alt : '' };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** A resource address as written in prose; trailing sentence punctuation is not part of it. */
const ADDRESS = /(?:drive|repo):\/\/[^\s<>()[\]{}`'"]+/gu;

function addressOf(text: string): string | null {
  const trimmed = text.replace(/[.,;:!?]+$/u, '');
  return parseResourceUri(trimmed) && !trimmed.endsWith('/') ? trimmed : null;
}

/** Before link rewriting: a bare address in prose becomes a link, and so does inline code that is exactly one complete
 * address. Code blocks, partial or placeholder addresses (`drive://workspace/<path>`) and existing links stay as they are. */
export function rehypeResourceAddresses() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      if (!node.children) return;
      const children: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && (child.value?.includes('drive://') || child.value?.includes('repo://'))) {
          let last = 0;
          for (const match of child.value.matchAll(ADDRESS)) {
            const address = addressOf(match[0]);
            if (!address) continue;
            if (match.index > last) children.push({ type: 'text', value: child.value.slice(last, match.index) });
            children.push({ type: 'element', tagName: 'a', properties: { href: address }, children: [{ type: 'text', value: address }] });
            last = match.index + address.length;
          }
          if (last < child.value.length) children.push({ type: 'text', value: child.value.slice(last) });
          continue;
        }
        const code = child.tagName === 'code' && node.tagName !== 'pre' && child.children?.length === 1 && child.children[0]?.type === 'text' ? child.children[0].value?.trim() : undefined;
        if (code && new RegExp(`^${ADDRESS.source}$`, 'u').test(code) && addressOf(code) === code) {
          children.push({ type: 'element', tagName: 'a', properties: { href: code }, children: [child] });
          continue;
        }
        if (child.tagName !== 'a' && child.tagName !== 'pre' && child.tagName !== 'code') visit(child);
        children.push(child);
      }
      node.children = children;
    };
    visit(tree);
  };
}
