import { createContext, useContext, useEffect, useState } from 'react';

/** A short-lived URL serving one file's bytes, with what it is. */
export interface ResourceFile { url: string; downloadUrl: string; size: number; mediaType: string | null; expiresAt: string }
/** Turns a resource address (`drive://…`) into a file URL; null where no workspace can serve files. */
export const ResourceFiles = createContext<((uri: string) => Promise<ResourceFile>) | null>(null);

/** A file URL is reused until shortly before it expires; one request serves every view of the same address. */
const REFRESH_BEFORE_MS = 10 * 60_000;
const cache = new WeakMap<(uri: string) => Promise<ResourceFile>, Map<string, { request: Promise<ResourceFile>; freshUntil: number }>>();

function cachedFile(resolve: (uri: string) => Promise<ResourceFile>, uri: string): Promise<ResourceFile> {
  let files = cache.get(resolve);
  if (!files) { files = new Map(); cache.set(resolve, files); }
  const known = files.get(uri);
  if (known && known.freshUntil > Date.now()) return known.request;
  const entry = { request: resolve(uri), freshUntil: Number.POSITIVE_INFINITY };
  files.set(uri, entry);
  entry.request.then(
    file => { entry.freshUntil = Date.parse(file.expiresAt) - REFRESH_BEFORE_MS; },
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
