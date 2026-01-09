/** Ed25519 signing keypair */
export interface SigningKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** X25519 key exchange keypair */
export interface KeyExchangeKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Complete identity */
export interface Identity {
  id: string;
  signing: SigningKeypair;
  keyExchange: KeyExchangeKeypair;
  label?: string;
  createdAt: number;
}

/** Serializable identity for IndexedDB storage */
export interface StoredIdentity {
  id: string;
  signingPublicKey: string;
  signingSecretKey: string;
  keyExchangePublicKey: string;
  keyExchangePrivateKey: string;
  label?: string;
  createdAt: number;
}

/** Session keys derived from handshake */
export interface SessionKeys {
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
  sessionId: string;
}

/** Permissions */
export interface AccessPermissions {
  read: boolean;
  write: boolean;
  manage: boolean;
}
