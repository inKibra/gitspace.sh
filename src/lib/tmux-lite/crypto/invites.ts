/**
 * Invite token creation and verification
 *
 * Invite tokens are signed JSON tokens that allow sharing access to a machine.
 * They are base64url encoded for URL-safe transport.
 *
 * Token flow:
 * 1. Create token payload (without signature)
 * 2. Sign JSON-stringified payload with machine's signing key
 * 3. Add signature to token
 * 4. Base64url encode the full token JSON
 */

import type {
  Identity,
  InviteToken,
  CreateInviteOptions,
  AccessType,
  PublicIdentity,
} from "../../../types/identity.js";
import { sign, verify } from "./identity.js";

/** Default invite validity: 24 hours */
const DEFAULT_VALIDITY_MS = 24 * 60 * 60 * 1000;

/** Default access type for invites: session-invite (view-only) */
const DEFAULT_ACCESS_TYPE: AccessType = 'session-invite';

/**
 * Create a signed invite token for sharing machine access
 *
 * The token contains:
 * - Machine's public identity (signing and key exchange keys)
 * - Relay URL to connect
 * - Access type being granted
 * - Expiry timestamp
 * - Signature over the token data
 *
 * @param machineIdentity - The machine's complete identity (needs secret key for signing)
 * @param relayUrl - The relay server URL to connect to
 * @param options - Optional configuration (accessType, sessionId, validity, single-use)
 * @returns Base64url-encoded signed token
 *
 * @example
 * ```typescript
 * const token = createInviteToken(
 *   machineIdentity,
 *   'wss://relay.example.com',
 *   {
 *     accessType: 'session-invite',
 *     sessionId: 'session-123',
 *     validityMs: 3600000, // 1 hour
 *     singleUse: true
 *   }
 * );
 * // Share token via URL: https://app.example.com/join?token=...
 * ```
 */
export function createInviteToken(
  machineIdentity: Identity,
  relayUrl: string,
  options?: CreateInviteOptions
): string {
  const validityMs = options?.validityMs ?? DEFAULT_VALIDITY_MS;
  const accessType = options?.accessType ?? DEFAULT_ACCESS_TYPE;
  const sessionId = options?.sessionId;
  const singleUse = options?.singleUse ?? false;

  // Create unsigned token payload
  const unsignedToken: Omit<InviteToken, "signature"> = {
    version: 1,
    machineId: machineIdentity.id,
    machineSigningKey: Buffer.from(
      machineIdentity.signing.publicKey
    ).toString("base64"),
    machineKeyExchangeKey: Buffer.from(
      machineIdentity.keyExchange.publicKey
    ).toString("base64"),
    relayUrl,
    accessType,
    sessionId,
    expiresAt: Date.now() + validityMs,
    singleUse,
  };

  // Sign the JSON-stringified payload
  const payloadString = JSON.stringify(unsignedToken);
  const payloadBytes = new TextEncoder().encode(payloadString);
  const signatureBytes = sign(payloadBytes, machineIdentity.signing.secretKey);
  const signature = Buffer.from(signatureBytes).toString("base64");

  // Add signature to create complete token
  const signedToken: InviteToken = {
    ...unsignedToken,
    signature,
  };

  // Encode as base64url for URL-safe transport
  const tokenJson = JSON.stringify(signedToken);
  return Buffer.from(tokenJson).toString("base64url");
}

/**
 * Parse and verify a base64url-encoded invite token
 *
 * This function:
 * 1. Decodes the base64url token
 * 2. Parses the JSON
 * 3. Validates the structure
 * 4. Verifies the signature
 *
 * @param encodedToken - Base64url-encoded token string
 * @returns Parsed token if valid, null if invalid or signature verification fails
 *
 * @example
 * ```typescript
 * const token = parseInviteToken(encodedToken);
 * if (!token) {
 *   console.error('Invalid token');
 *   return;
 * }
 * if (isInviteExpired(token)) {
 *   console.error('Token has expired');
 *   return;
 * }
 * // Token is valid, use it to connect
 * ```
 */
export function parseInviteToken(encodedToken: string): InviteToken | null {
  try {
    // Decode base64url
    const tokenJson = Buffer.from(encodedToken, "base64url").toString("utf-8");
    const token = JSON.parse(tokenJson) as InviteToken;

    // Validate structure
    if (
      token.version !== 1 ||
      !token.machineId ||
      !token.machineSigningKey ||
      !token.machineKeyExchangeKey ||
      !token.relayUrl ||
      !token.accessType ||
      !token.expiresAt ||
      typeof token.singleUse !== "boolean" ||
      !token.signature
    ) {
      return null;
    }

    // Extract signature and recreate unsigned payload
    const { signature, ...unsignedToken } = token;
    const payloadString = JSON.stringify(unsignedToken);
    const payloadBytes = new TextEncoder().encode(payloadString);

    // Verify signature with machine's public signing key
    const publicKey = new Uint8Array(
      Buffer.from(token.machineSigningKey, "base64")
    );
    const signatureBytes = new Uint8Array(Buffer.from(signature, "base64"));
    const isValid = verify(payloadBytes, signatureBytes, publicKey);

    if (!isValid) {
      return null;
    }

    return token;
  } catch {
    return null;
  }
}

/**
 * Extract public identity information from an invite token
 *
 * This creates a PublicIdentity object that can be added to an access list.
 *
 * @param token - Parsed invite token
 * @returns Public identity of the machine that created the token
 *
 * @example
 * ```typescript
 * const token = parseInviteToken(encodedToken);
 * if (token) {
 *   const machineIdentity = getPublicIdentityFromInvite(token);
 *   // Add to access list, display in UI, etc.
 * }
 * ```
 */
export function getPublicIdentityFromInvite(token: InviteToken): PublicIdentity {
  return {
    id: token.machineId,
    signingPublicKey: token.machineSigningKey,
    keyExchangePublicKey: token.machineKeyExchangeKey,
    label: undefined, // Invite tokens don't include labels
  };
}

/**
 * Check if an invite token has expired
 *
 * @param token - Parsed invite token
 * @returns True if the current time is past the token's expiry
 *
 * @example
 * ```typescript
 * const token = parseInviteToken(encodedToken);
 * if (token && isInviteExpired(token)) {
 *   console.error('This invite has expired');
 *   return;
 * }
 * ```
 */
export function isInviteExpired(token: InviteToken): boolean {
  return Date.now() > token.expiresAt;
}
