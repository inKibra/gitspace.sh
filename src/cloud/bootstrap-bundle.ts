export const CLOUD_BOOTSTRAP_BUNDLE_FILENAME = 'gssh-cloud-bootstrap.mjs';

let generatedBundle: typeof import('./bootstrap-bundle.generated') | null = null;

try {
  generatedBundle = await import('./bootstrap-bundle.generated.js');
} catch {
  // Generated bundle is optional during local development.
}

export function getCloudBootstrapBundleSource(): string | null {
  return generatedBundle?.getCloudBootstrapBundleSource() ?? null;
}
