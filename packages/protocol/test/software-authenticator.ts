import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBase64Url, encodeBase64Url, type PasskeyAlgorithm, type WebAuthnAssertion, type WebAuthnAttestation } from '../src/passkey.js';

/**
 * A software WebAuthn authenticator for tests: keys from Web Crypto (ES256, RS256) or noble (EdDSA), and the
 * authenticator data, client data and attestation objects a browser hands back, built byte for byte. Every option
 * that a real authenticator or browser fixes can be bent, so tests can present what a forger would.
 */

type CborInput = number | string | Uint8Array | ReadonlyArray<CborInput> | Map<number | string, CborInput>;

function cborHead(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 24, length];
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
  return [(major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
}

export function encodeCbor(value: CborInput): Uint8Array {
  const out: number[] = [];
  const write = (item: CborInput): void => {
    if (typeof item === 'number') out.push(...(item >= 0 ? cborHead(0, item) : cborHead(1, -1 - item)));
    else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item);
      out.push(...cborHead(3, bytes.length), ...bytes);
    } else if (item instanceof Uint8Array) out.push(...cborHead(2, item.length), ...item);
    else if (item instanceof Map) {
      out.push(...cborHead(5, item.size));
      for (const [key, child] of item) { write(key); write(child); }
    } else {
      out.push(...cborHead(4, item.length));
      for (const child of item) write(child);
    }
  };
  write(value);
  return Uint8Array.from(out);
}

/** IEEE P1363 r‖s (what Web Crypto signs) to the DER WebAuthn carries. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = [...bytes.subarray(start)];
    return trimmed[0]! & 0x80 ? [0x02, trimmed.length + 1, 0, ...trimmed] : [0x02, trimmed.length, ...trimmed];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

export interface CeremonyOptions {
  challenge: Uint8Array;
  rpId: string;
  origin: string;
  /** Defaults: user verified, client data type of the ceremony, not cross-origin. */
  userVerified?: boolean;
  type?: string;
  crossOrigin?: boolean;
}

export interface SoftwareAuthenticator {
  algorithm: PasskeyAlgorithm;
  credentialId: string;
  /** The response to `navigator.credentials.create()`. */
  register(options: CeremonyOptions & { backupEligible?: boolean }): Promise<WebAuthnAttestation>;
  /** The response to `navigator.credentials.get()`; the counter advances unless `signCount` is given. */
  assert(options: CeremonyOptions & { signCount?: number }): Promise<WebAuthnAssertion>;
}

export async function softwareAuthenticator(algorithm: PasskeyAlgorithm = -7): Promise<SoftwareAuthenticator> {
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  let counter = 0;
  let cose: Uint8Array;
  let sign: (message: Uint8Array) => Promise<Uint8Array>;
  if (algorithm === -8) {
    const secret = ed25519.utils.randomSecretKey();
    cose = encodeCbor(new Map<number, CborInput>([[1, 1], [3, -8], [-1, 6], [-2, ed25519.getPublicKey(secret)]]));
    sign = async (message) => ed25519.sign(message, secret);
  } else if (algorithm === -7) {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const point = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    cose = encodeCbor(new Map<number, CborInput>([[1, 2], [3, -7], [-1, 1], [-2, point.slice(1, 33)], [-3, point.slice(33)]]));
    sign = async (message) => derSignature(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Uint8Array.from(message))));
  } else {
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    cose = encodeCbor(new Map<number, CborInput>([[1, 3], [3, -257], [-1, decodeBase64Url(jwk.n ?? '')], [-2, decodeBase64Url(jwk.e ?? '')]]));
    sign = async (message) => new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, Uint8Array.from(message)));
  }
  const clientData = (options: CeremonyOptions, type: string): Uint8Array => new TextEncoder().encode(JSON.stringify({
    type: options.type ?? type, challenge: encodeBase64Url(options.challenge), origin: options.origin, crossOrigin: options.crossOrigin ?? false,
  }));
  const header = (options: CeremonyOptions, flags: number, signCount: number): Uint8Array => {
    const bytes = new Uint8Array(37);
    bytes.set(sha256(new TextEncoder().encode(options.rpId)));
    bytes[32] = flags | 0x01 | (options.userVerified === false ? 0 : 0x04);
    new DataView(bytes.buffer).setUint32(33, signCount);
    return bytes;
  };
  return {
    algorithm,
    credentialId: encodeBase64Url(credentialId),
    async register(options) {
      const head = header(options, 0x40 | (options.backupEligible ? 0x08 : 0), counter);
      const authData = new Uint8Array([...head, ...new Uint8Array(16), credentialId.length >> 8, credentialId.length & 0xff, ...credentialId, ...cose]);
      const attestationObject = encodeCbor(new Map<string, CborInput>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { attestationObject: encodeBase64Url(attestationObject), clientDataJSON: encodeBase64Url(clientData(options, 'webauthn.create')) };
    },
    async assert(options) {
      const authenticatorData = header(options, 0, options.signCount ?? ++counter);
      const clientDataJSON = clientData(options, 'webauthn.get');
      const signature = await sign(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
      return { authenticatorData: encodeBase64Url(authenticatorData), clientDataJSON: encodeBase64Url(clientDataJSON), signature: encodeBase64Url(signature) };
    },
  };
}
