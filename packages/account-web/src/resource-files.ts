import { parseResourceUri } from '@gitspace/protocol/resource-uri';
import { createContext, useContext, useEffect, useState } from 'react';

/** A short-lived URL serving one file's bytes, with what it is. */
/** `version` names the file's content (a repository file's blob id, a drive file's `sha256:…`), so two versions can be
 * compared. */
export interface ResourceFile { url: string; downloadUrl: string; size: number; mediaType: string | null; expiresAt: string; version?: string }
/** Turns a resource address (`drive://…`) into a file URL: the file's current version, or with `hash` that version of
 * a drive file; null where no workspace can serve files. */
export const ResourceFiles = createContext<((uri: string, hash: string | null) => Promise<ResourceFile>) | null>(null);
/** The versions the message being drawn pinned the drive media it embeds at (`MessageBlock.pins`), by address; null
 * outside a message, or for one stored before messages pinned their media. */
export const MediaPins = createContext<Readonly<Record<string, string>> | null>(null);

/** The version the message being drawn pinned the drive file `uri` at; null when it pinned none, so the file shows as it
 * is now. */
export function useMediaPin(uri: string): string | null {
  const pins = useContext(MediaPins);
  const resource = parseResourceUri(uri);
  return (resource?.kind === 'drive' ? pins?.[resource.url] : undefined) ?? null;
}

/** An address pinned to one version (`repo://…@<commit>`, or a drive file with a `hash`) reuses its file URL until
 * shortly before it expires. An address of a file's current version (`drive://…`, `repo://…`) is resolved again for each
 * view that shows it, as the file may have new bytes under the same name; views that ask while a request is out share
 * it, and an unchanged version resolves to the same URL, which the browser serves from its cache. */
const REFRESH_BEFORE_MS = 10 * 60_000;
const cache = new WeakMap<(uri: string, hash: string | null) => Promise<ResourceFile>, Map<string, { request: Promise<ResourceFile>; freshUntil: number }>>();

function cachedFile(resolve: (uri: string, hash: string | null) => Promise<ResourceFile>, uri: string, hash: string | null): Promise<ResourceFile> {
  let files = cache.get(resolve);
  if (!files) { files = new Map(); cache.set(resolve, files); }
  const key = `${hash ?? ''}\n${uri}`;
  const known = files.get(key);
  if (known && known.freshUntil > Date.now()) return known.request;
  const resource = parseResourceUri(uri);
  const pinned = hash !== null || (resource?.kind === 'repo' && resource.commit !== null);
  const entry = { request: resolve(uri, hash), freshUntil: Number.POSITIVE_INFINITY };
  files.set(key, entry);
  entry.request.then(
    file => { entry.freshUntil = pinned ? Date.parse(file.expiresAt) - REFRESH_BEFORE_MS : 0; },
    () => { if (files.get(key) === entry) files.delete(key); },
  );
  return entry.request;
}

/** The file an address names, resolved while `enabled`: its current version, or the drive file's version `hash`. */
export function useResourceFile(uri: string, enabled = true, hash: string | null = null): { file: ResourceFile | null; error: string | null; unavailable: boolean } {
  const resolve = useContext(ResourceFiles);
  const key = `${hash ?? ''}\n${uri}`;
  const [state, setState] = useState<{ key: string; file: ResourceFile | null; error: string | null }>({ key, file: null, error: null });
  useEffect(() => {
    if (!resolve || !enabled) return;
    let current = true;
    cachedFile(resolve, uri, hash).then(
      file => { if (current) setState({ key, file, error: null }); },
      (error: unknown) => { if (current) setState({ key, file: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; };
  }, [resolve, uri, hash, key, enabled]);
  const matching = state.key === key;
  return { file: matching ? state.file : null, error: matching ? state.error : null, unavailable: !resolve };
}
