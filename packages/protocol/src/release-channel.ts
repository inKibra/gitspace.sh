/** The release channel's keys (docs/TENANT-RELEASES-DESIGN.md §3): its catalog, and every published release's files
 * under the prefix. Free of schemas, so the read-only channel Worker bundles nothing else. */
export const CHANNEL_CATALOG = 'catalog.json';
export const CHANNEL_RELEASES_PREFIX = 'defaults/releases/';
