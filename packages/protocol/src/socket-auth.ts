/**
 * WebSocket handshakes carry their signed proof as one `Sec-WebSocket-Protocol`
 * value, never in the URL. Proofs are base64url, so `prefix + proof` stays a valid
 * protocol token; the server echoes the accepted value, as browsers require.
 */
export const DEVICE_SOCKET_PROTOCOL = 'gitspace-device.';
/** A machine's signed control request (`settings.subscribe`), base64url JSON. */
export const CONTROL_SOCKET_PROTOCOL = 'gitspace-control.';

const PROOF = /^[A-Za-z0-9_-]{1,4096}$/u;

/** The one offered protocol carrying `prefix`, or null when it is absent, repeated or malformed. */
export function socketProtocolProof(header: string | null, prefix: string): { protocol: string; proof: string } | null {
  const offered = (header ?? '').split(',').map((value) => value.trim()).filter((value) => value.startsWith(prefix));
  if (offered.length !== 1) return null;
  const protocol = offered[0]!;
  const proof = protocol.slice(prefix.length);
  return PROOF.test(proof) ? { protocol, proof } : null;
}
