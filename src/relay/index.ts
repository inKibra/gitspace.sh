#!/usr/bin/env bun
/**
 * Relay server entry point
 *
 * Configuration via environment variables:
 * - RELAY_PORT: Port to listen on (default: 4480)
 * - RELAY_BIND: Address to bind to (default: 0.0.0.0)
 * - RELAY_HOST: Optional hostname to only serve this domain
 * - RELAY_PRIVATE_KEY: Optional base64 Ed25519 private key (uses keychain if not set)
 * - RELAY_LABEL: Optional label for the relay identity
 */

import { createRelayServer } from "./server";
import { loadOrCreateRelayIdentity, formatRelayFingerprint } from "./identity";

// Read configuration from environment
const port = parseInt(process.env.RELAY_PORT || "4480", 10);
const bind = process.env.RELAY_BIND || "0.0.0.0";
const hostname = process.env.RELAY_HOST; // Optional: only serve this domain
const label = process.env.RELAY_LABEL;

async function main() {
  // Load or create relay identity
  const identity = await loadOrCreateRelayIdentity(label);
  const fingerprint = formatRelayFingerprint(identity.signingPublicKey);

  console.log(`[relay] Identity: ${fingerprint}${identity.label ? ` (${identity.label})` : ""}`);

  // Start the server
  const server = createRelayServer({
    port,
    bind,
    hostname,
    identity,
  });

  // Handle shutdown gracefully
  process.on("SIGINT", () => {
    console.log("\n[relay] Shutting down...");
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("[relay] Received SIGTERM, shutting down...");
    server.stop();
    process.exit(0);
  });

  console.log("[relay] Server started");
  console.log("[relay] Health check: http://localhost:" + port + "/health");
}

main().catch((err) => {
  console.error("[relay] Fatal error:", err);
  process.exit(1);
});
