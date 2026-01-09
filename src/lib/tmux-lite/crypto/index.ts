/**
 * E2E encryption module exports
 */

export {
  generateSalt,
  deriveKey,
  SALT_LENGTH,
  KEY_LENGTH,
} from "./keys";

export {
  encrypt,
  decrypt,
  seal,
  open,
  generateNonce,
  NONCE_LENGTH,
  AUTH_TAG_LENGTH,
} from "./secretbox";

export {
  encodeFrame,
  decodeFrame,
  peekStreamId,
  createFrame,
  openFrame,
  MASTER_STREAM_ID,
  STREAM_ID_LENGTH,
  MIN_FRAME_LENGTH,
  type EncryptedFrame,
} from "./frames";

export {
  generateSigningKeypair,
  generateKeyExchangeKeypair,
  generateIdentity,
  deriveIdentityId,
  sign,
  verify,
  serializeIdentity,
  deserializeIdentity,
  getPublicIdentity,
} from "./identity";

export {
  createInviteToken,
  parseInviteToken,
  getPublicIdentityFromInvite,
  isInviteExpired,
} from "./invites";
