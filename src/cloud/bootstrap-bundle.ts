import { logger } from '../utils/logger.js';

export const CLOUD_BOOTSTRAP_BUNDLE_FILENAME = 'gssh-cloud-bootstrap.mjs';

let generatedBundle: typeof import('./bootstrap-bundle.generated') | null = null;

try {
  generatedBundle = await import('./bootstrap-bundle.generated.js');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const isMissingGeneratedModule =
    message.includes('bootstrap-bundle.generated')
    && /cannot find|not found/i.test(message);

  if (!isMissingGeneratedModule) {
    logger.error(`Failed to load generated cloud bootstrap bundle: ${message}`);
  }
}

export function getCloudBootstrapBundleSource(): string | null {
  return generatedBundle?.getCloudBootstrapBundleSource() ?? null;
}
