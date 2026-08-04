/**
 * Node-API addon assets (`*.node`).
 *
 * `scripts/build.ts` emits a dynamic import of the pi-natives `.node` binary so
 * Bun's bundler embeds it and returns the extracted path at runtime. There is no
 * declaration for a native addon in dev, which used to be papered over with
 * `@ts-ignore` in both the generator template and its generated output.
 *
 * Declaring the shape instead means the import is actually type-checked: the
 * default export is the on-disk path Bun hands back for the embedded asset.
 */
declare module '*.node' {
  const addonPath: string;
  export default addonPath;
}
