import { spawn, type Subprocess } from 'bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { openBrowserUrl } from '../utils/open-browser.js';

/**
 * Developer surface for reviewing every block renderer in one place.
 *
 * The gallery pages are Vite multipage entries under `web/`, so they exist only
 * in a source checkout — a compiled binary ships the built app, not the dev
 * entries. This command therefore refuses early and loudly rather than
 * spawning a dev server that cannot resolve them.
 */
const GALLERY_PAGES = {
  blocks: 'blocks-gallery.html',
  transcript: 'transcript-gallery.html',
} as const;

export type GalleryPage = keyof typeof GALLERY_PAGES;

const DEFAULT_GALLERY_PORT = 5173;
const DEV_SERVER_START_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface GalleryOptions {
  page?: GalleryPage;
  port?: number;
  open?: boolean;
}

/** Repo root inferred from this module's location; absent in a compiled binary. */
function resolveWebDir(): string {
  const webDir = join(import.meta.dir, '..', '..', 'web');
  if (!existsSync(join(webDir, 'package.json'))) {
    throw new SpacesError(
      'The block gallery requires a GitSpace source checkout (web/ was not found). Run it from the repository, not an installed binary.',
      'USER_ERROR',
      1,
    );
  }
  return webDir;
}

async function isServerServingPage(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForPage(url: string, child: Subprocess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // A dev server that died will never serve the page; fail with its exit
    // status instead of burning the full timeout.
    if (child.exitCode !== null) {
      throw new SpacesError(
        `Vite dev server exited with code ${child.exitCode} before the gallery was reachable.`,
        'SYSTEM_ERROR',
        2,
      );
    }
    if (await isServerServingPage(url)) {
      return;
    }
    await Bun.sleep(150);
  }

  throw new SpacesError(`Timed out waiting for the gallery dev server at ${url}`, 'SYSTEM_ERROR', 2);
}

async function terminateChild(child: Subprocess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }

  const exited = await Promise.race([
    child.exited.catch(() => 1),
    Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => null),
  ]);
  if (exited !== null) {
    return;
  }

  try {
    child.kill('SIGKILL');
    await child.exited.catch(() => 1);
  } catch {
    // Best effort: the process may have exited between SIGTERM and SIGKILL.
  }
}

/**
 * Serve the block/transcript gallery and open it.
 *
 * Reuses an already-running dev server on the target port when one is serving
 * the page, so repeated invocations during a design pass do not fight over the
 * port. Otherwise it starts one and tears it down on exit.
 */
export async function startGallery(options: GalleryOptions = {}): Promise<void> {
  const page = options.page ?? 'blocks';
  const port = options.port ?? DEFAULT_GALLERY_PORT;
  const webDir = resolveWebDir();
  const url = `http://localhost:${port}/${GALLERY_PAGES[page]}`;

  if (await isServerServingPage(url)) {
    logger.info(`Reusing the dev server already serving ${url}`);
    if (options.open !== false) {
      const result = await openBrowserUrl(url);
      if (!result.ok) {
        logger.warning(`Could not open the browser automatically: ${result.message}`);
      }
    }
    logger.log(url);
    return;
  }

  logger.info(`Starting the gallery dev server on port ${port}...`);
  const child = spawn({
    cmd: ['bun', 'run', 'dev', '--port', String(port), '--strictPort'],
    cwd: webDir,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void terminateChild(child);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await waitForPage(url, child, DEV_SERVER_START_TIMEOUT_MS);

    if (options.open !== false) {
      const result = await openBrowserUrl(url);
      if (!result.ok) {
        logger.warning(`Could not open the browser automatically: ${result.message}`);
      }
    }

    logger.success(`Gallery ready: ${url}`);
    logger.log('Press Ctrl+C to stop.');
    await child.exited;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    shutdown();
  }
}
