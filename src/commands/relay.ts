/**
 * Relay command implementation
 *
 * Handles:
 * - `gssh relay start` - Start the relay server
 * - `gssh relay authorize` - Authorize a machine
 * - `gssh relay revoke` - Revoke a machine's authorization
 * - `gssh relay machines` - List authorized machines
 * - `gssh relay trusted` - List trusted relays (machine-side)
 * - `gssh relay untrust` - Remove relay trust (machine-side)
 */

import { logger } from "../utils/logger.js";
import { createRelayServer } from "../relay/server.js";
import { SpacesError } from "../types/errors.js";
import chalk from "chalk";
import {
  loadOrCreateRelayIdentity,
  formatRelayFingerprint,
  type RelayIdentity,
} from "../relay/identity.js";
import {
  getAuthorizedMachines,
  addAuthorizedMachine,
  removeAuthorizedMachine,
  computeMachineFingerprint,
  type AuthorizedMachine,
} from "../relay/authorization.js";
import {
  getTrustedRelays,
  removeTrustedRelay,
  type TrustedRelay,
} from "../core/trusted-relays.js";

/** Default port for relay server (4480 = "GIT0" on phone keypad) */
const DEFAULT_PORT = 4480;

/**
 * Start the relay server
 *
 * @param options - Command options
 */
export async function startRelay(options: {
  port?: number;
  hostname?: string;
  bind?: string;
  label?: string;
}): Promise<void> {
  const port = options.port ?? parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const bind = options.bind ?? process.env.RELAY_BIND ?? "0.0.0.0";
  const hostname = options.hostname ?? process.env.RELAY_HOST;

  // Load or create relay identity
  const identity = await loadOrCreateRelayIdentity(options.label);
  const fingerprint = formatRelayFingerprint(identity.signingPublicKey);

  // Display relay identity prominently
  logger.log("");
  logger.log(chalk.cyan("┌────────────────────────────────────────────────┐"));
  logger.log(chalk.cyan("│") + chalk.bold(" Relay Identity                                 ") + chalk.cyan("│"));
  logger.log(chalk.cyan("│") + ` Fingerprint: ${chalk.yellow(fingerprint)}              ` + chalk.cyan("│"));
  if (identity.label) {
    const labelPadded = identity.label.substring(0, 30).padEnd(30);
    logger.log(chalk.cyan("│") + ` Label: ${chalk.dim(labelPadded)}         ` + chalk.cyan("│"));
  }
  logger.log(chalk.cyan("│") + ` Public Key:                                     ` + chalk.cyan("│"));
  logger.log(chalk.cyan("│") + ` ${chalk.dim(identity.signingPublicKey.substring(0, 44))} ` + chalk.cyan("│"));
  logger.log(chalk.cyan("└────────────────────────────────────────────────┘"));
  logger.log("");

  logger.log(`  Port:     ${port}`);
  logger.log(`  Bind:     ${bind}`);
  if (hostname) {
    logger.log(`  Hostname: ${hostname} (only serving this domain)`);
  }
  logger.log("");

  try {
    const server = await createRelayServer({
      port,
      bind,
      hostname,
      identity,
    });

    logger.success(`Relay listening on ws://${hostname || bind}:${port}`);
    logger.log("");
    logger.dim("Press Ctrl+C to stop");
    logger.log("");

    // Set up shutdown handlers
    const shutdown = () => {
      logger.log("");
      logger.info("Shutting down relay...");
      server.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep process alive
    await new Promise(() => {
      // Never resolves
    });
  } catch (error) {
    throw new SpacesError(
      `Failed to start relay: ${error instanceof Error ? error.message : String(error)}`,
      "SYSTEM_ERROR",
      2
    );
  }
}

// ============================================================================
// Authorization Commands
// ============================================================================

/**
 * Authorize a machine to connect to this relay
 *
 * @param spacesPubKey - Machine public key in gssh-pub:SIGNING:KEYEXCHANGE format
 * @param options - Command options
 */
export async function authorizeMachine(
  spacesPubKey: string,
  options: { label?: string }
): Promise<void> {
  const entry = addAuthorizedMachine(spacesPubKey, options.label);

  if (!entry) {
    throw new SpacesError(
      `Invalid public key format. Expected: gssh-pub:SIGNING_KEY:KEYEXCHANGE_KEY\n` +
        `Get this from \`gssh identity show\` on the machine you want to authorize.`,
      "USER_ERROR",
      1
    );
  }

  logger.log("");
  logger.success("Machine authorized!");
  logger.log("");
  logger.log(`  Fingerprint: ${chalk.cyan(entry.fingerprint)}`);
  if (entry.label) {
    logger.log(`  Label:       ${chalk.yellow(entry.label)}`);
  }
  logger.log("");
}

/**
 * Revoke a machine's authorization
 *
 * @param fingerprintOrLabel - Fingerprint or label of machine to revoke
 */
export async function revokeMachine(fingerprintOrLabel: string): Promise<void> {
  const removed = removeAuthorizedMachine(fingerprintOrLabel);

  if (!removed) {
    const machines = getAuthorizedMachines();

    if (machines.length === 0) {
      throw new SpacesError("No machines are authorized.", "USER_ERROR", 1);
    }

    logger.error(`No machine found matching: ${fingerprintOrLabel}`);
    logger.log("");
    logger.log("Authorized machines:");
    for (const m of machines) {
      logger.log(`  ${m.fingerprint} ${m.label ? `(${m.label})` : ""}`);
    }
    throw new SpacesError("Machine not found.", "USER_ERROR", 1);
  }

  logger.log("");
  logger.success("Machine authorization revoked.");
  logger.log("");
  logger.log(`  Fingerprint: ${chalk.cyan(removed.fingerprint)}`);
  if (removed.label) {
    logger.log(`  Label:       ${chalk.yellow(removed.label)}`);
  }
  logger.log("");
}

/**
 * List all authorized machines
 */
export async function listMachines(): Promise<void> {
  const machines = getAuthorizedMachines();

  if (machines.length === 0) {
    logger.log("");
    logger.info("No machines authorized.");
    logger.log("");
    logger.log("Authorize a machine:");
    logger.log("  gssh relay authorize gssh-pub:... --label 'My Machine'");
    logger.log("");
    return;
  }

  logger.log("");
  logger.bold("Authorized Machines:");
  logger.log("");

  // Header
  const fpWidth = 20;
  const labelWidth = 24;
  const dateWidth = 12;

  logger.dim(
    "FINGERPRINT".padEnd(fpWidth) +
      "LABEL".padEnd(labelWidth) +
      "AUTHORIZED"
  );
  logger.dim("─".repeat(fpWidth + labelWidth + dateWidth));

  // Entries
  for (const m of machines) {
    const fp = m.fingerprint.padEnd(fpWidth);
    const label = (m.label || "-").substring(0, labelWidth - 1).padEnd(labelWidth);
    const date = new Date(m.authorizedAt).toISOString().split("T")[0];

    logger.log(chalk.cyan(fp) + label + chalk.dim(date));
  }

  logger.log("");
  logger.dim(`Total: ${machines.length} machine(s)`);
  logger.log("");
}

// ============================================================================
// Trusted Relay Commands (Machine-side)
// ============================================================================

/**
 * List all trusted relays
 */
export async function listTrustedRelays(): Promise<void> {
  const relays = getTrustedRelays();

  if (relays.length === 0) {
    logger.log("");
    logger.info("No trusted relays.");
    logger.log("");
    logger.log("Connect to a relay to establish trust:");
    logger.log("  gssh serve --relay wss://relay.example.com");
    logger.log("");
    return;
  }

  logger.log("");
  logger.bold("Trusted Relays:");
  logger.log("");

  // Header
  const urlWidth = 32;
  const fpWidth = 20;
  const labelWidth = 16;

  logger.dim(
    "URL".padEnd(urlWidth) +
      "FINGERPRINT".padEnd(fpWidth) +
      "LABEL"
  );
  logger.dim("─".repeat(urlWidth + fpWidth + labelWidth));

  // Entries
  for (const r of relays) {
    const url = r.url.substring(0, urlWidth - 1).padEnd(urlWidth);
    const fp = r.fingerprint.padEnd(fpWidth);
    const label = (r.label || "-").substring(0, labelWidth - 1);

    logger.log(chalk.cyan(url) + fp + chalk.dim(label));
  }

  logger.log("");
  logger.dim(`Total: ${relays.length} relay(s)`);
  logger.log("");
}

/**
 * Remove trust for a relay
 *
 * @param urlOrFingerprint - URL, fingerprint, or label of relay to untrust
 */
export async function untrustRelay(urlOrFingerprint: string): Promise<void> {
  const removed = removeTrustedRelay(urlOrFingerprint);

  if (!removed) {
    const relays = getTrustedRelays();

    if (relays.length === 0) {
      throw new SpacesError("No relays are trusted.", "USER_ERROR", 1);
    }

    logger.error(`No relay found matching: ${urlOrFingerprint}`);
    logger.log("");
    logger.log("Trusted relays:");
    for (const r of relays) {
      logger.log(`  ${r.url} (${r.fingerprint}${r.label ? `, ${r.label}` : ""})`);
    }
    throw new SpacesError("Relay not found.", "USER_ERROR", 1);
  }

  logger.log("");
  logger.success("Relay trust removed.");
  logger.log("");
  logger.log(`  URL:         ${chalk.cyan(removed.url)}`);
  logger.log(`  Fingerprint: ${removed.fingerprint}`);
  if (removed.label) {
    logger.log(`  Label:       ${chalk.yellow(removed.label)}`);
  }
  logger.log("");
  logger.dim("You will be prompted to trust this relay again on next connection.");
  logger.log("");
}
