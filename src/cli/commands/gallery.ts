import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { SpacesError } from '../../types/errors.js';

const GALLERY_PAGES = ['blocks', 'transcript'] as const;
type GalleryPageName = (typeof GALLERY_PAGES)[number];

function parseGalleryPort(rawPort: string): number {
  if (!/^\d+$/.test(rawPort)) {
    throw new SpacesError('Port must be an integer between 1 and 65535.', 'USER_ERROR', 1);
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SpacesError('Port must be an integer between 1 and 65535.', 'USER_ERROR', 1);
  }

  return port;
}

function parseGalleryPage(rawPage: string | undefined): GalleryPageName {
  if (rawPage === undefined) {
    return 'blocks';
  }
  if (!GALLERY_PAGES.includes(rawPage as GalleryPageName)) {
    throw new SpacesError(`Unknown gallery page "${rawPage}". Expected one of: ${GALLERY_PAGES.join(', ')}.`, 'USER_ERROR', 1);
  }
  return rawPage as GalleryPageName;
}

export function registerGalleryCommand(parent: Command): void {
  parent
    .command('gallery')
    .description('Open the block render gallery (design surface for transcript blocks and tool calls)')
    .argument('[page]', `Gallery page: ${GALLERY_PAGES.join(' | ')}`, 'blocks')
    .option('--port <port>', 'Dev server port', '5173')
    .option('--no-open', 'Start the dev server without opening a browser')
    .action(withErrorHandler(async (page: string | undefined, options) => {
      // Deferred load: every sibling command module lazy-loads its
      // implementation so `gssh --help` does not pull the full dependency
      // graph. A static import here would undo that for all commands.
      const { startGallery } = await import('../../commands/gallery.js');
      await startGallery({
        page: parseGalleryPage(page),
        port: parseGalleryPort(options.port),
        open: options.open,
      });
    }, { skipSetupCheck: true }));
}
