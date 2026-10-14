/** RFC 8785 canonical JSON and its SHA-256 digest, used to reference exact tool results. */
/** RFC 8785 uses ECMAScript number serialization and UTF-16 code unit key order. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') { for (let i = 0; i < value.length; i++) { const n = value.charCodeAt(i); if (n >= 0xd800 && n <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode'); } else if (n >= 0xdc00 && n <= 0xdfff) throw new Error('Invalid Unicode'); } return JSON.stringify(value); }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++) entries.push(canonicalJson(value[index]));
    return `[${entries.join(',')}]`;
  }
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return `{${Object.keys(value).sort().map(key => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new Error('Not canonical JSON');
}
const utf8 = new TextEncoder();
const hex = (bytes: Uint8Array): string => {
  const encoded = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < bytes.length; index++) {
    const high = bytes[index]! >>> 4, low = bytes[index]! & 15;
    encoded[index * 2] = high < 10 ? high + 48 : high + 87;
    encoded[index * 2 + 1] = low < 10 ? low + 48 : low + 87;
  }
  return new TextDecoder().decode(encoded);
};
export async function receiptDigest(value: unknown): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(canonicalJson(value))))); }
