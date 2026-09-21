export interface ResourceSelector {
  raw: boolean;
  ranges: readonly { start: number; end: number | null }[];
}
export type ResourceUri = (
  | { kind: 'local'; mount: 'base' | 'workspace' | 'workspaces' | null; path: string; workspaceId: string | null }
  | { kind: 'artifact'; id: string }
) & { url: string; selector: ResourceSelector; suffix: string };

/** Parse OMP resources without URL's dot-segment normalization or hostname lowercasing. */
export function parseResourceUri(input: string): ResourceUri | null {
  if (input.length > 8_192 || /[\u0000-\u0020\u007f\\?#]/u.test(input)) return null;
  const match = /^(local|artifact):\/\/(.*)$/iu.exec(input);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  let target = match[2]!;
  let raw = false;
  let ranges: ResourceSelector['ranges'] = [];
  while (target.includes(':')) {
    const index = target.lastIndexOf(':');
    const suffix = target.slice(index + 1);
    if (suffix === 'raw' && !raw) raw = true;
    else if (!ranges.length && /^(?:[1-9]\d*(?:[-+][1-9]\d*|-)?|-[1-9]\d*)(?:,(?:[1-9]\d*(?:[-+][1-9]\d*|-)?|-[1-9]\d*))*$/u.test(suffix)) {
      const parsed = suffix.split(',').map((part) => {
        if (part.startsWith('-')) return { start: -Number(part.slice(1)), end: null };
        const range = /^([1-9]\d*)(?:([-+])([1-9]\d*)?)?$/u.exec(part)!;
        const start = Number(range[1]);
        const end = range[3] ? (range[2] === '+' ? start + Number(range[3]) - 1 : Number(range[3])) : null;
        return { start, end };
      });
      if (parsed.length > 64 || parsed.some(({ start, end }) => !Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start)))) return null;
      ranges = parsed;
    } else return null;
    target = target.slice(0, index);
  }
  const selector = { raw, ranges };
  const suffix = match[2]!.slice(target.length);
  if (scheme === 'artifact') return /^\d+$/u.test(target) ? { kind: 'artifact', id: target, url: `artifact://${target}`, selector, suffix } : null;
  let parts: string[];
  try { parts = target.split('/').map((part) => decodeURIComponent(part)); } catch { return null; }
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f/\\]/u.test(part))) return null;
  const mount = parts[0] === 'base' || parts[0] === 'workspace' || parts[0] === 'workspaces' ? parts.shift()! as 'base' | 'workspace' | 'workspaces' : null;
  const workspaceId = mount === 'workspaces' ? parts.shift() ?? null : null;
  if (!parts.length || (mount === 'workspaces' && !workspaceId)) return null;
  // Encode path components exactly once. Encoded separators never become another mount.
  const path = parts.join('/');
  const encoded = [...(mount ? [mount] : []), ...(workspaceId ? [workspaceId] : []), ...parts].map(encodeURIComponent).join('/');
  return { kind: 'local', mount, workspaceId, path, url: `local://${encoded}`, selector, suffix };
}

export function canonicalLocalResourceUrl(resource: Extract<ResourceUri, { kind: 'local' }>, scope: 'base' | 'workspace'): string {
  return resource.mount ? resource.url : `local://${scope}/${resource.path.split('/').map(encodeURIComponent).join('/')}`;
}

export function selectResourceText(text: string, selector: ResourceSelector): string {
  if (!selector.ranges.length) return text;
  const lines = text.split('\n');
  return selector.ranges.map(({ start, end }) => lines.slice(start < 0 ? start : start - 1, end ?? undefined).join('\n')).join('\n');
}

const RESOURCE_FRAGMENT = '#gitspace-resource=';
/** A safe same-document URL survives Markdown sanitation without enabling custom browser schemes. */
export function resourceLinkHref(uri: string): string | null {
  return parseResourceUri(uri) ? `${RESOURCE_FRAGMENT}${encodeURIComponent(uri)}` : null;
}

export function resourceUriFromHref(href: string): string | null {
  if (!href.startsWith(RESOURCE_FRAGMENT)) return null;
  try {
    const uri = decodeURIComponent(href.slice(RESOURCE_FRAGMENT.length));
    return parseResourceUri(uri) ? uri : null;
  } catch { return null; }
}

/** Bound text plus base64 to fit result-rpc's 1 MiB query envelope without silent truncation. */
export function createResourcePreview(url: string, bytes: Uint8Array, mediaType: string | null = null): { url: string; mediaType: string | null; base64: string; text: string | null } {
  const resource = parseResourceUri(url);
  if (!resource) throw new Error('Unsupported or unsafe resource URI');
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Resource reads are limited to 16 MiB');
  let text: string | null = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary preview. */ }
  if (resource.selector.ranges.length) {
    if (text === null) throw new Error('Line selectors require a UTF-8 text resource');
    text = selectResourceText(text, resource.selector);
    bytes = new TextEncoder().encode(text);
  }
  if (resource.selector.raw || resource.selector.ranges.length) mediaType = 'text/plain';
  // Six-byte JSON escaping plus base64 leaves space for the RPC envelope and URI.
  if (bytes.byteLength > 128 * 1024) throw new Error('This resource exceeds the 128 KiB preview limit. Use a smaller line range, for example :1-200, for text resources.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  return { url, mediaType, base64: btoa(binary), text };
}
