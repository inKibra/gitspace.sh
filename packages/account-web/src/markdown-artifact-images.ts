/** Resolves a Markdown image source to an artifact object URL the app created, or null to leave it untouched. */
export type MarkdownImageResolver = (src: string) => string | null;

interface ImageNode {
  type: string;
  tagName?: string;
  properties?: { src?: unknown };
  children?: ImageNode[];
}

// Same-origin placeholder path: the sanitizer and URL hardener keep it, then it becomes the object URL.
const ARTIFACT_IMAGE_PATH = '/__gitspace-artifact-image/';

function visitImages(tree: ImageNode, update: (properties: { src?: unknown }, src: string) => void): void {
  const visit = (node: ImageNode): void => {
    if (node.tagName === 'img' && node.properties && typeof node.properties.src === 'string') update(node.properties, node.properties.src);
    node.children?.forEach(visit);
  };
  visit(tree);
}

/** Before sanitization: marks images that resolve to a loaded artifact. Unresolved sources keep normal hardening. */
export function rehypeArtifactImageMarkers(resolve: MarkdownImageResolver) {
  return () => (tree: ImageNode): void => visitImages(tree, (properties, src) => {
    if (resolve(src)) properties.src = `${ARTIFACT_IMAGE_PATH}${encodeURIComponent(src)}`;
  });
}

/** After URL hardening: swaps each marker for the artifact's object URL. */
export function rehypeArtifactImageSources(resolve: MarkdownImageResolver, origin: string) {
  return () => (tree: ImageNode): void => visitImages(tree, (properties, src) => {
    let path: string;
    try { path = new URL(src, origin).pathname; } catch { return; }
    if (!path.startsWith(ARTIFACT_IMAGE_PATH)) return;
    const url = resolve(decodeURIComponent(path.slice(ARTIFACT_IMAGE_PATH.length)));
    if (url) properties.src = url;
  });
}

/** Image sources written in Markdown or inline HTML; best effort, for loading referenced artifacts ahead of render. */
export function markdownImageSources(source: string): string[] {
  const sources = new Set<string>();
  for (const match of source.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)/gu)) sources.add(match[1]!);
  for (const match of source.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/giu)) sources.add(match[1]!);
  return [...sources];
}

/** The artifact URL an image source names, relative to the Markdown artifact; null for web, data, and anchor sources. */
export function artifactImageUrl(src: string, documentUrl: string): string | null {
  if (src.startsWith('drive://')) return canonicalDriveUrl(src.slice('drive://'.length));
  if (/^[a-z][a-z0-9+.-]*:/iu.test(src) || src.startsWith('//') || src.startsWith('#') || !documentUrl.startsWith('drive://')) return null;
  const directory = documentUrl.slice('drive://'.length, documentUrl.lastIndexOf('/') + 1);
  let resolved: URL;
  try { resolved = new URL(src, `https://artifact.invalid/${directory}`); } catch { return null; }
  return canonicalDriveUrl(resolved.pathname.slice(1));
}

/** Drive URLs as the catalog lists them: each path segment encoded once. */
function canonicalDriveUrl(path: string): string | null {
  try { return `drive://${path.split('/').map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/')}`; } catch { return null; }
}
