/**
 * Make `omp://` docs readable by the agents we spawn.
 *
 * The SDK ships an `OmpProtocolHandler`, but the 122-file docs corpus is not
 * shipped as files — it is gzip-embedded at build time into
 * `process.env.PI_DOCS_EMBED`, and read once at module scope:
 *
 *   const docsEmbed = process.env.PI_DOCS_EMBED ?? "";
 *
 * `@oh-my-pi/pi-coding-agent` resolves `exports["."].import` to `./src/index.ts`,
 * so every consumer imports the SOURCE, where that variable is unset. The
 * fallback then reads `<pkg>/../../../../docs`, which only exists inside an OMP
 * monorepo checkout — for an npm consumer it is `node_modules/docs`, which
 * never exists, and `omp://` throws ENOENT. Every agent we run is therefore
 * blind to the documentation of the harness it is running inside.
 *
 * The payload is already on disk: `dist/cli.js` in that same package carries
 * the inlined literal (byte-identical to the globally installed `omp` binary's
 * bundle). We extract it and populate the env var the SDK already reads, so
 * nothing is patched and the docs can never skew from the installed version.
 *
 * Ordering matters: this must run BEFORE the SDK's docs-index module is first
 * evaluated. Import it as a side effect ahead of any SDK import — ESM evaluates
 * imports depth-first in source order, and that ordering survives
 * `bun build --compile` (verified).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Anchor: a single-quoted literal whose content OPENS a JSON array of `.md`
 * names — i.e. `'["first-doc.md"` with the inner quotes escaped by the bundler
 * (`'[\"first-doc.md\"`). Keyed on the payload's own shape, never on a
 * bundler-generated identifier, since minified names change every release.
 *
 * Anchoring on a bare `.md",` instead is NOT sufficient: a 13MB bundle has
 * other strings containing one, and the first hit lands in an unrelated
 * literal that then fails to parse.
 */
const EMBED_LITERAL_START = /'\[\\?"[^"\\]+\.md\\?"/;

export interface DocsEmbedExtraction {
  embed: string;
  fileCount: number;
}

/**
 * Pull the embed literal out of a built `cli.js`. Returns null rather than
 * throwing: no docs is a degraded agent, but a corrupt payload is worse than
 * none — `decodeDocsIndex` throws hard on a non-empty payload with no newline,
 * which would take down worker startup instead of merely losing `omp://`.
 */
export function extractDocsEmbed(bundlePath: string): DocsEmbedExtraction | null {
  if (!existsSync(bundlePath)) return null;
  const source = readFileSync(bundlePath, 'utf8');
  const start = EMBED_LITERAL_START.exec(source)?.index;
  if (start === undefined) return null;

  // Forward to the literal's unescaped close. Base64 contains no quotes, so
  // the scan is unambiguous once the opening is right.
  let end = start + 1;
  while (end < source.length && !(source[end] === "'" && source[end - 1] !== '\\')) end += 1;
  if (end >= source.length) return null;

  const embed = source
    .slice(start + 1, end)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');

  // Cheap structural validation only — this runs on every worker spawn, so the
  // gunzip is left to the consumer (and to the sentinel test, which decodes in
  // full). A newline separator plus a parseable filename array is enough to
  // rule out the truncated-embed case the SDK treats as fatal.
  const newline = embed.indexOf('\n');
  if (newline === -1 || newline === embed.length - 1) return null;
  try {
    const files: unknown = JSON.parse(embed.slice(0, newline));
    if (!Array.isArray(files) || files.length === 0) return null;
    if (!files.every((f) => typeof f === 'string' && f.endsWith('.md'))) return null;
    return { embed, fileCount: files.length };
  } catch {
    return null;
  }
}

/** `dist/cli.js` of the installed pi-coding-agent, or null when unresolvable
 *  (notably inside our own compiled binary, which has no node_modules). */
export function resolvePiBundlePath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('@oh-my-pi/pi-coding-agent/package.json');
    const candidate = join(dirname(pkgJson), 'dist', 'cli.js');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

let installed: boolean | null = null;

/**
 * Populate `PI_DOCS_EMBED` for this process. Idempotent, never throws, and
 * never overwrites a value already supplied by the environment or by a
 * build-time embed.
 *
 * Returns false when no payload could be found — the pre-existing behaviour
 * (agents simply have no `omp://`), not a new failure mode.
 */
export function installPiDocsEmbed(): boolean {
  if (installed !== null) return installed;
  if ((process.env.PI_DOCS_EMBED ?? '').length > 0) {
    installed = true;
    return installed;
  }
  const bundlePath = resolvePiBundlePath();
  const extracted = bundlePath === null ? null : extractDocsEmbed(bundlePath);
  if (extracted === null) {
    installed = false;
    return installed;
  }
  process.env.PI_DOCS_EMBED = extracted.embed;
  installed = true;
  return installed;
}
