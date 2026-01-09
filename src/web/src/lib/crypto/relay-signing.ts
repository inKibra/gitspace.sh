/**
 * Relay message signing utilities (browser)
 */

import type { Identity } from "../../types/identity";
import { sign } from "./identity";

export interface SignatureBlock {
  sig: string;
  pub: string;
  ts: number;
}

function canonicalize(obj: object): string {
  return JSON.stringify(obj, (key, value) => {
    if (key === "signature") return undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

export function signRelayMessage<T extends object>(
  message: T,
  identity: Identity
): T & { signature: SignatureBlock } {
  const ts = Date.now();
  const msgWithTs = { ...message, signature: { ts } };
  const canonical = canonicalize(msgWithTs);
  const messageBytes = new TextEncoder().encode(canonical);
  const signatureBytes = sign(messageBytes, identity.signing.secretKey);

  const signature: SignatureBlock = {
    sig: toBase64(signatureBytes),
    pub: toBase64(identity.signing.publicKey),
    ts,
  };

  return { ...message, signature };
}
