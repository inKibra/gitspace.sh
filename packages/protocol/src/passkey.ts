import { ed25519 } from '@noble/curves/ed25519.js';
import { ecdsa, weierstrass, type ECDSA } from '@noble/curves/abstract/weierstrass.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

/**
 * WebAuthn primitives for GitSpace passkeys (docs/PASSKEYS-DESIGN.md): CBOR and COSE decoding, and synchronous
 * verification of registrations and assertions. Synchronous so device-grant verification, which machines run offline
 * over mirrored records, checks a passkey's signature inline. The P-256 curve is built on first use, so importing this
 * module sets up no curve.
 */

/** COSE algorithms GitSpace accepts, in the order a registration offers them: ES256, EdDSA (Ed25519), RS256. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;
export const passkeyAlgorithmSchema = z.union([z.literal(-7), z.literal(-8), z.literal(-257)]);
export type PasskeyAlgorithm = z.infer<typeof passkeyAlgorithmSchema>;

export const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/u);

/** One `navigator.credentials.get()` response, base64url as WebAuthn encodes it. */
export const webAuthnAssertionSchema = z.object({
  authenticatorData: base64UrlSchema.min(49).max(4_096),
  clientDataJSON: base64UrlSchema.min(20).max(4_096),
  signature: base64UrlSchema.min(16).max(1_024),
});
export type WebAuthnAssertion = z.infer<typeof webAuthnAssertionSchema>;

/** One `navigator.credentials.create()` response. */
export const webAuthnAttestationSchema = z.object({
  attestationObject: base64UrlSchema.min(100).max(16_384),
  clientDataJSON: base64UrlSchema.min(20).max(4_096),
});
export type WebAuthnAttestation = z.infer<typeof webAuthnAttestationSchema>;

/** A registered passkey's public half, as verification needs it. */
export interface PasskeyPublicKey {
  /** COSE_Key bytes, base64url. */
  publicKey: string;
  algorithm: PasskeyAlgorithm;
  rpId: string;
  origin: string;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

/** Definite-length CBOR as authenticators write it: integers, byte and text strings, arrays, maps, booleans and null. */
function readCbor(bytes: Uint8Array, start: number, depth: number): { value: CborValue; end: number } {
  if (depth > 16 || start >= bytes.length) throw new Error('Malformed CBOR');
  const initial = bytes[start]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let offset = start + 1;
  let argument = info;
  if (info >= 24) {
    if (info > 27) throw new Error('Unsupported CBOR length');
    const size = 1 << (info - 24);
    if (offset + size > bytes.length) throw new Error('Truncated CBOR');
    argument = 0;
    for (let index = 0; index < size; index++) argument = argument * 256 + bytes[offset + index]!;
    if (!Number.isSafeInteger(argument)) throw new Error('CBOR integer too large');
    offset += size;
  }
  if (major === 0) return { value: argument, end: offset };
  if (major === 1) return { value: -1 - argument, end: offset };
  if (major === 2 || major === 3) {
    if (offset + argument > bytes.length) throw new Error('Truncated CBOR');
    const slice = bytes.slice(offset, offset + argument);
    return { value: major === 2 ? slice : new TextDecoder('utf-8', { fatal: true }).decode(slice), end: offset + argument };
  }
  if (major === 4 || major === 5) {
    if (argument > bytes.length - offset) throw new Error('Truncated CBOR');
    const items: CborValue[] = [];
    const map = new Map<CborValue, CborValue>();
    for (let index = 0; index < argument; index++) {
      const item = readCbor(bytes, offset, depth + 1);
      offset = item.end;
      if (major === 4) {
        items.push(item.value);
        continue;
      }
      const value = readCbor(bytes, offset, depth + 1);
      offset = value.end;
      if (map.has(item.value)) throw new Error('Duplicate CBOR key');
      map.set(item.value, value.value);
    }
    return { value: major === 4 ? items : map, end: offset };
  }
  if (major === 7 && info >= 20 && info <= 22) return { value: info === 20 ? false : info === 21 ? true : null, end: offset };
  throw new Error('Unsupported CBOR item');
}

/** Decodes exactly one CBOR item filling `bytes`. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, end } = readCbor(bytes, 0, 0);
  if (end !== bytes.length) throw new Error('Trailing CBOR bytes');
  return value;
}

let p256: ECDSA | null = null;
/** P-256 ECDSA. Authenticators may sign with a high S, so verification accepts both. */
function p256Curve(): ECDSA {
  p256 ??= ecdsa(weierstrass({
    p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
    n: BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
    h: BigInt(1),
    a: BigInt('0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc'),
    b: BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b'),
    Gx: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
    Gy: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
  }), sha256, { lowS: false });
  return p256;
}

function bigIntFrom(bytes: Uint8Array): bigint {
  let value = BigInt(0);
  for (const byte of bytes) value = (value << BigInt(8)) | BigInt(byte);
  return value;
}

/** DER prefix of an RSASSA-PKCS1-v1_5 SHA-256 DigestInfo (RFC 8017 §9.2). */
const SHA256_DIGEST_INFO = Uint8Array.from([0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20]);

/** RSASSA-PKCS1-v1_5 with SHA-256: recovers the encoded message and compares it with the one expected (RFC 8017 §8.2.2). */
function verifyRs256(modulusBytes: Uint8Array, exponentBytes: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  let start = 0;
  while (start < modulusBytes.length && modulusBytes[start] === 0) start++;
  const length = modulusBytes.length - start;
  const modulus = bigIntFrom(modulusBytes.subarray(start));
  const signed = bigIntFrom(signature);
  if (signature.length !== length || signed >= modulus) return false;
  let result = BigInt(1);
  let base = signed;
  let exponent = bigIntFrom(exponentBytes);
  while (exponent > BigInt(0)) {
    if (exponent & BigInt(1)) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= BigInt(1);
  }
  const expected = new Uint8Array(length);
  const digest = sha256(message);
  expected[1] = 0x01;
  expected.fill(0xff, 2, length - SHA256_DIGEST_INFO.length - digest.length - 1);
  expected.set(SHA256_DIGEST_INFO, length - SHA256_DIGEST_INFO.length - digest.length);
  expected.set(digest, length - digest.length);
  const recovered = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index--) {
    recovered[index] = Number(result & BigInt(0xff));
    result >>= BigInt(8);
  }
  return bytesEqual(recovered, expected);
}

/** A verifier for a COSE_Key of `algorithm`, or null when the key is not one GitSpace accepts. */
function coseVerifier(cose: Uint8Array, algorithm: PasskeyAlgorithm): ((signature: Uint8Array, message: Uint8Array) => boolean) | null {
  const key = decodeCbor(cose);
  if (!(key instanceof Map) || key.get(3) !== algorithm) return null;
  const field = (label: number): Uint8Array | null => {
    const value = key.get(label);
    return value instanceof Uint8Array ? value : null;
  };
  if (algorithm === -7) {
    const x = field(-2);
    const y = field(-3);
    if (key.get(1) !== 2 || key.get(-1) !== 1 || x?.length !== 32 || y?.length !== 32) return null;
    const point = new Uint8Array(65);
    point[0] = 0x04;
    point.set(x, 1);
    point.set(y, 33);
    if (!p256Curve().utils.isValidPublicKey(point, false)) return null;
    return (signature, message) => p256Curve().verify(signature, message, point, { format: 'der' });
  }
  if (algorithm === -8) {
    const x = field(-2);
    if (key.get(1) !== 1 || key.get(-1) !== 6 || x?.length !== 32) return null;
    return (signature, message) => ed25519.verify(signature, message, x);
  }
  const modulus = field(-1);
  const exponent = field(-2);
  if (key.get(1) !== 3 || !modulus || !exponent || modulus.length < 256 || modulus.length > 1_024 || exponent.length > 8) return null;
  return (signature, message) => verifyRs256(modulus, exponent, signature, message);
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  /** The credential may be synced to other devices (iCloud Keychain, Google Password Manager). */
  backupEligible: boolean;
  signCount: number;
  /** Present on registration: the new credential's id and COSE_Key bytes. */
  credential: { id: Uint8Array; publicKey: Uint8Array } | null;
}

/** Authenticator data (WebAuthn §6.1); null when malformed. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
  try {
    if (bytes.length < 37) return null;
    const flags = bytes[32]!;
    const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0);
    let credential: AuthenticatorData['credential'] = null;
    let end = 37;
    if (flags & 0x40) {
      if (bytes.length < 55) return null;
      const idLength = (bytes[53]! << 8) | bytes[54]!;
      const idEnd = 55 + idLength;
      if (idLength === 0 || idLength > 1_023 || idEnd > bytes.length) return null;
      const key = readCbor(bytes, idEnd, 0);
      credential = { id: bytes.slice(55, idEnd), publicKey: bytes.slice(idEnd, key.end) };
      end = key.end;
    }
    if (flags & 0x80) end = readCbor(bytes, end, 0).end;
    if (end !== bytes.length) return null;
    return { rpIdHash: bytes.slice(0, 32), userPresent: (flags & 0x01) !== 0, userVerified: (flags & 0x04) !== 0, backupEligible: (flags & 0x08) !== 0, signCount, credential };
  } catch {
    return null;
  }
}

const clientDataSchema = z.object({ type: z.string(), challenge: base64UrlSchema, origin: z.string(), crossOrigin: z.boolean().optional(), topOrigin: z.string().optional() });

/** The ceremony was for this relying party with the person present and verified (PIN or biometric), and its client
 * data names the ceremony, this exact challenge and origin, and no embedding page. */
function ceremonyMatches(data: AuthenticatorData, clientDataJSON: Uint8Array, expected: { type: 'webauthn.create' | 'webauthn.get'; challenge: Uint8Array; origin: string; rpId: string }): boolean {
  if (!data.userPresent || !data.userVerified || !bytesEqual(data.rpIdHash, sha256(new TextEncoder().encode(expected.rpId)))) return false;
  const parsed = clientDataSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataJSON)));
  return parsed.success && parsed.data.type === expected.type && parsed.data.origin === expected.origin
    && parsed.data.crossOrigin !== true && parsed.data.topOrigin === undefined
    && bytesEqual(decodeBase64Url(parsed.data.challenge), expected.challenge);
}

/** What a verified registration created. */
export interface RegisteredPasskey {
  credentialId: string;
  publicKey: string;
  algorithm: PasskeyAlgorithm;
  backupEligible: boolean;
  signCount: number;
}

/**
 * Checks a `navigator.credentials.create()` response against the challenge, relying party and origin it was made for:
 * user verified, an accepted algorithm and a well-formed key. GitSpace asks for no attestation, so the authenticator's
 * make is not proven; trust in the new passkey comes from the signed-in browser that enrolls it.
 */
export function verifyWebAuthnRegistration(response: WebAuthnAttestation, expected: { challenge: Uint8Array; rpId: string; origin: string }): RegisteredPasskey | null {
  try {
    const attestation = decodeCbor(decodeBase64Url(response.attestationObject));
    const authData = attestation instanceof Map ? attestation.get('authData') : null;
    const data = authData instanceof Uint8Array ? parseAuthenticatorData(authData) : null;
    if (!data?.credential || !ceremonyMatches(data, decodeBase64Url(response.clientDataJSON), { type: 'webauthn.create', ...expected })) return null;
    const key = decodeCbor(data.credential.publicKey);
    const algorithm = passkeyAlgorithmSchema.safeParse(key instanceof Map ? key.get(3) : null);
    if (!algorithm.success || !coseVerifier(data.credential.publicKey, algorithm.data)) return null;
    return { credentialId: encodeBase64Url(data.credential.id), publicKey: encodeBase64Url(data.credential.publicKey), algorithm: algorithm.data, backupEligible: data.backupEligible, signCount: data.signCount };
  } catch {
    return null;
  }
}

/**
 * Checks a `navigator.credentials.get()` response: signed by `key` over this challenge, for its relying party and
 * origin, with the person verified. Answers the authenticator's signature counter (0 when it keeps none).
 */
export function verifyWebAuthnAssertion(key: PasskeyPublicKey, assertion: WebAuthnAssertion, challenge: Uint8Array): { signCount: number } | null {
  try {
    const authenticatorData = decodeBase64Url(assertion.authenticatorData);
    const clientDataJSON = decodeBase64Url(assertion.clientDataJSON);
    const data = parseAuthenticatorData(authenticatorData);
    if (!data || !ceremonyMatches(data, clientDataJSON, { type: 'webauthn.get', challenge, origin: key.origin, rpId: key.rpId })) return null;
    const verify = coseVerifier(decodeBase64Url(key.publicKey), key.algorithm);
    const signed = new Uint8Array(authenticatorData.length + 32);
    signed.set(authenticatorData);
    signed.set(sha256(clientDataJSON), authenticatorData.length);
    return verify?.(decodeBase64Url(assertion.signature), signed) ? { signCount: data.signCount } : null;
  } catch {
    return null;
  }
}
