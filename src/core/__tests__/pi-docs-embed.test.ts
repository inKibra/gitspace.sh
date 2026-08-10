/**
 * Sentinel for the `omp://` docs embed.
 *
 * We read the docs corpus out of the INSTALLED pi-coding-agent bundle, because
 * the package resolves `exports["."].import` to `src/index.ts` (where
 * PI_DOCS_EMBED is unset) and its disk fallback points at `node_modules/docs`,
 * which never exists for an npm consumer. That extraction keys on the payload's
 * shape, so an OMP upgrade that changes how the literal is emitted must fail
 * HERE — loudly, at test time — rather than silently leaving every agent we
 * spawn unable to read `omp://`.
 */
import { describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { extractDocsEmbed, resolvePiBundlePath } from '../pi-docs-embed.js';

describe('pi docs embed extraction', () => {
  it('extracts a decodable docs corpus from the installed bundle', () => {
    const bundlePath = resolvePiBundlePath();
    expect(bundlePath).not.toBeNull();

    const extracted = extractDocsEmbed(bundlePath!);
    expect(extracted).not.toBeNull();

    // Assert the DECODE, not the presence of a string: a truncated or
    // re-encoded payload still contains plausible-looking text, and the SDK
    // throws hard on a non-empty embed it cannot split.
    const { embed, fileCount } = extracted!;
    const newline = embed.indexOf('\n');
    const files = JSON.parse(embed.slice(0, newline)) as string[];
    const bodies = JSON.parse(
      gunzipSync(Buffer.from(embed.slice(newline + 1), 'base64')).toString('utf8'),
    ) as string[];

    expect(files.length).toBe(fileCount);
    expect(bodies.length).toBe(files.length);
    // A floor, not the exact count — upstream adding docs is not a failure.
    expect(files.length).toBeGreaterThanOrEqual(100);

    // A known doc round-trips to real content, proving the gzip pairing is
    // aligned rather than merely well-formed.
    const index = files.indexOf('ttsr-injection-lifecycle.md');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(bodies[index]).toContain('# TTSR Injection Lifecycle');
  });

  it('returns null instead of a partial payload when the bundle has no embed', () => {
    // Fail CLOSED. `decodeDocsIndex` throws on a non-empty payload with no
    // newline, so handing the SDK a half-extracted string would break worker
    // startup — strictly worse than having no docs.
    expect(extractDocsEmbed('/nonexistent/cli.js')).toBeNull();
  });
});
