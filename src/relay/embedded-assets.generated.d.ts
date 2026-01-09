/**
 * Type declarations for embedded-assets.generated.js
 *
 * The .js file is auto-generated during build by scripts/build.ts
 * This .d.ts provides TypeScript types without needing to parse the generated code.
 */

/** URL path -> embedded file reference */
export declare const EMBEDDED_ASSETS: Record<string, unknown>;

/** True only in compiled binary with embedded files */
export declare function hasEmbeddedAssets(): boolean;

/** Get embedded file blob by URL path */
export declare function getEmbeddedFile(urlPath: string): Blob | null;
