/**
 * Fixed functions the extension calls in an isolated world of a tab (`Runtime.callFunctionOn`), never in the page's
 * own world, to move files between the page and the workspace's drive (docs/SIMPLIFICATION.md Batch 16 item 2). The
 * service worker fetches and uploads the bytes itself; a page never sees a sealed link or the account.
 */

/** On a file input (`this`): why it cannot take `count` files, or '' after it made room for them. */
export const inputFilesPrepareFunction = `function(count) {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file') return 'The target is not a file input';
  if (this.disabled) return 'This file input is disabled';
  if (count > 1 && !this.multiple) return 'This input takes one file';
  (globalThis.__gitspaceInputFiles ??= new WeakMap()).set(this, []);
  return '';
}`;

/** On the same input: the next piece (base64) of file `index`. */
export const inputFilesChunkFunction = `function(index, data) {
  const files = globalThis.__gitspaceInputFiles.get(this);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  (files[index] ??= []).push(bytes);
  return true;
}`;

/** On the same input: sets its files (`specs`: name and media type of each) and fires input and change as a person
 * choosing them would. */
export const inputFilesSetFunction = `function(specs) {
  const parts = globalThis.__gitspaceInputFiles.get(this) || [];
  globalThis.__gitspaceInputFiles.delete(this);
  const transfer = new DataTransfer();
  specs.forEach((spec, index) => transfer.items.add(new File(parts[index] || [], spec.name, { type: spec.mediaType })));
  this.files = transfer.files;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/** In the world of the frame that started a download of a \`blob:\` URL: \`size\` bytes from \`offset\` (base64), with the
 * blob's size and type. The blob is fetched once and dropped after its last piece. */
export const downloadBlobReadFunction = `async function(url, offset, size) {
  const store = globalThis.__gitspaceDownloads ??= new Map();
  let blob = store.get(url);
  if (!blob) { blob = await (await fetch(url)).blob(); store.set(url, blob); }
  const bytes = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
  if (offset + bytes.length >= blob.size) store.delete(url);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { total: blob.size, type: blob.type, data: btoa(binary) };
}`;

/** Base64 of any number of bytes (`btoa` takes a string of at most one call's arguments at a time). */
export function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
