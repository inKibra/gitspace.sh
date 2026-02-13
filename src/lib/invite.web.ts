/**
 * Invite token parsing
 */

export interface ParsedInvite {
  inviteToken: string;  // Full invite token for X3DH authorization
  machineId: string;
  inviteId: string;     // Short hash for relay lookup
  relayUrl?: string;
}

/**
 * Parse invite from URL hash
 * Format: #invite=base64url(JSON)
 */
export async function parseInviteFromHash(hash: string): Promise<ParsedInvite | null> {
  try {
    const prefix = "#invite=";
    if (!hash.startsWith(prefix)) return null;

    const encoded = hash.slice(prefix.length);

    // Decode base64url
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(base64 + padding);

    const invite = JSON.parse(decoded);

    // Generate invite ID from token (first 16 chars of hash)
    const inviteId = await generateInviteId(encoded);

    return {
      inviteToken: encoded,  // Full token for X3DH auth
      machineId: invite.machineId,
      inviteId,              // Short hash for relay lookup
      relayUrl: invite.relayUrl,
    };
  } catch (e) {
    console.error("Failed to parse invite:", e);
    return null;
  }
}

/**
 * Generate invite ID from token (simple hash)
 */
async function generateInviteId(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const hashBase64 = btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return hashBase64.slice(0, 16);
}
