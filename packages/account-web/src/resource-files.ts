import { parseResourceUri } from '@gitspace/protocol/resource-uri';
import { createContext, useContext, useEffect, useState } from 'react';

/** A short-lived URL serving one file's bytes, with what it is. */
/** `version` names a repository file's content (its blob id), so two versions can be compared. */
export interface ResourceFile { url: string; downloadUrl: string; size: number; mediaType: string | null; expiresAt: string; version?: string }
/** Turns a resource address (`drive://…`) into a file URL; null where no workspace can serve files. */
export const ResourceFiles = createContext<((uri: string) => Promise<ResourceFile>) | null>(null);

/** An address pinned to one version (`repo://…@<commit>`) reuses its file URL until shortly before it expires. An
 * address of a file's current version (`drive://…`, `repo://…`) is resolved again for each view that shows it, as the
 * file may have new bytes under the same name; views that ask while a request is out share it, and an unchanged
 * version resolves to the same URL, which the browser serves from its cache. */
const REFRESH_BEFORE_MS = 10 * 60_000;
const cache = new WeakMap<(uri: string) => Promise<ResourceFile>, Map<string, { request: Promise<ResourceFile>; freshUntil: number }>>();

function cachedFile(resolve: (uri: string) => Promise<ResourceFile>, uri: string): Promise<ResourceFile> {
  let files = cache.get(resolve);
  if (!files) { files = new Map(); cache.set(resolve, files); }
  const known = files.get(uri);
  if (known && known.freshUntil > Date.now()) return known.request;
  const resource = parseResourceUri(uri);
  const pinned = resource?.kind === 'repo' && resource.commit !== null;
  const entry = { request: resolve(uri), freshUntil: Number.POSITIVE_INFINITY };
  files.set(uri, entry);
  entry.request.then(
    file => { entry.freshUntil = pinned ? Date.parse(file.expiresAt) - REFRESH_BEFORE_MS : 0; },
    () => { if (files.get(uri) === entry) files.delete(uri); },
  );
  return entry.request;
}

/** The file an address names, resolved while `enabled`. */
export function useResourceFile(uri: string, enabled = true): { file: ResourceFile | null; error: string | null; unavailable: boolean } {
  const resolve = useContext(ResourceFiles);
  const [state, setState] = useState<{ uri: string; file: ResourceFile | null; error: string | null }>({ uri, file: null, error: null });
  useEffect(() => {
    if (!resolve || !enabled) return;
    let current = true;
    cachedFile(resolve, uri).then(
      file => { if (current) setState({ uri, file, error: null }); },
      (error: unknown) => { if (current) setState({ uri, file: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; };
  }, [resolve, uri, enabled]);
  const matching = state.uri === uri;
  return { file: matching ? state.file : null, error: matching ? state.error : null, unavailable: !resolve };
}
