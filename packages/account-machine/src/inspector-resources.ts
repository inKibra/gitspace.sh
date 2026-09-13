import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { ArtifactCapability, LocalArtifactResolver } from '@gitspace/core';
import { canonicalLocalResourceUrl, createResourcePreview, parseResourceUri } from '@gitspace/protocol/resource-uri';

const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

/** Only a router-authorized session belonging to the selected space may be supplied. */
export async function readInspectorResource(input: {
  url: string;
  sessionFile: string | null;
  localArtifactsDir: string | null;
  capability: ArtifactCapability;
  artifacts: Pick<LocalArtifactResolver, 'read'>;
}): Promise<{ url: string; mediaType: string | null; base64: string; text: string | null }> {
  const resource = parseResourceUri(input.url);
  if (!resource) throw new Error('Unsupported or unsafe resource URI');
  const sessionRoot = input.sessionFile?.endsWith('.jsonl') ? input.sessionFile.slice(0, -6) : null;
  let bytes: Uint8Array | null = null;
  const mediaType = resource.kind === 'artifact' ? 'text/plain' : null;
  if (resource.kind === 'artifact') {
    if (!sessionRoot) throw new Error('This tool output requires its originating session on the workspace machine');
    let names: string[];
    try { names = await readdir(sessionRoot); } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      names = [];
    }
    const name = names.find((name) => name.startsWith(`${resource.id}.`) && name.endsWith('.log'));
    if (name) bytes = await readContainedFile(sessionRoot, name);
    if (!bytes) throw new Error(`Tool output ${resource.url} is not available in this session. It may not have been retained on this machine.`);
  } else {
    // Legacy OMP local:// paths address the session's local root, not an arbitrary host path.
    // Read those exact locations before the current implicit writable mount; never scan other sessions.
    if (!resource.mount) {
      for (const root of [input.localArtifactsDir, sessionRoot ? join(sessionRoot, 'local') : null]) {
        if (!root) continue;
        bytes = await readContainedFile(root, resource.path);
        if (bytes) break;
      }
    }
    if (!bytes) {
      const url = canonicalLocalResourceUrl(resource, input.capability.kind === 'project' ? 'base' : 'workspace');
      const result = await input.artifacts.read(input.capability, url);
      if (result.status === 'error') throw result.error;
      bytes = result.value;
    }
  }
  return createResourcePreview(input.url, bytes, mediaType);
}

async function readContainedFile(root: string, path: string): Promise<Uint8Array | null> {
  try {
    const realRoot = await realpath(root);
    const candidate = join(realRoot, path);
    const resolved = await realpath(candidate);
    const contained = relative(realRoot, resolved);
    if (!contained || contained === '..' || contained.startsWith('../') || isAbsolute(contained)) throw new Error('Resource path escapes its session scope');
    let parent = realRoot;
    for (const part of path.split('/')) {
      parent = join(parent, part);
      if ((await lstat(parent)).isSymbolicLink()) throw new Error('Resource symlinks are not readable through the Inspector');
    }
    const expected = await lstat(resolved);
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Resource is not a regular file');
      if (stat.dev !== expected.dev || stat.ino !== expected.ino || await realpath(candidate) !== resolved) throw new Error('Resource changed while opening; retry the preview');
      if (stat.size > MAX_RESOURCE_BYTES) throw new Error('Session resource reads are limited to 16 MiB');
      const bytes = Buffer.allocUnsafe(stat.size + 1);
      let length = 0;
      while (length < bytes.byteLength) {
        const next = await file.read(bytes, length, bytes.byteLength - length);
        if (!next.bytesRead) return bytes.subarray(0, length);
        length += next.bytesRead;
      }
      throw new Error('Resource grew while reading; retry the preview');
    } finally { await file.close(); }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
