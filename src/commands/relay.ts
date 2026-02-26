/**
 * Relay command implementation
 *
 * Handles:
 * - `gssh relay start` - Start the relay server
 * - `gssh relay machines ...` - Manage registered machines
 */

import { logger } from "../utils/logger.js";
import { createRelayServer } from "../relay/server.js";
import { SpacesError } from "../types/errors.js";
import chalk from "chalk";
import {
  loadOrCreateRelayIdentity,
  formatRelayFingerprint,
} from "../relay/identity.js";
import { loadUserRootIdentity } from "../core/user-identity.js";
import {
  listVaultMachinesForOwner,
  removeVaultMachine,
} from "../relay/control/store.js";

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

async function requireOwnerUserRootId(): Promise<string> {
  const userRoot = await loadUserRootIdentity();
  if (!userRoot) {
    throw new SpacesError(
      'User root identity is required. Run `gssh user identity init` first.',
      'USER_ERROR',
      1,
    );
  }
  return userRoot.id;
}

export async function listRelayMachines(options: { json?: boolean } = {}): Promise<void> {
  const ownerUserRootId = await requireOwnerUserRootId();
  const machines = listVaultMachinesForOwner(ownerUserRootId);

  if (options.json) {
    console.log(JSON.stringify(machines, null, 2));
    return;
  }

  if (machines.length === 0) {
    logger.info('No machines registered for this owner.');
    return;
  }

  logger.bold('Relay Machines:');
  logger.log('');
  const machineWidth = 20;
  const labelWidth = 24;
  logger.dim('MACHINE ID'.padEnd(machineWidth) + 'LABEL'.padEnd(labelWidth) + 'LAST CONNECTED');
  logger.dim('─'.repeat(machineWidth + labelWidth + 16));
  for (const machine of machines) {
    const machineCol = machine.machineId.slice(0, machineWidth - 1).padEnd(machineWidth);
    const labelCol = (machine.label || '-').slice(0, labelWidth - 1).padEnd(labelWidth);
    const lastConnected = machine.lastConnectedAt
      ? machine.lastConnectedAt.split('T')[0] ?? machine.lastConnectedAt
      : '-';
    logger.log(chalk.cyan(machineCol) + labelCol + chalk.dim(lastConnected));
  }
}

export async function revokeRelayMachine(machineId: string): Promise<void> {
  const ownerUserRootId = await requireOwnerUserRootId();
  const machine = listVaultMachinesForOwner(ownerUserRootId).find((entry) => entry.machineId === machineId);
  if (!machine) {
    throw new SpacesError(`Machine '${machineId}' not found for this owner.`, 'USER_ERROR', 1);
  }

  const removed = removeVaultMachine(machineId);
  if (!removed) {
    throw new SpacesError(`Failed to remove machine '${machineId}'.`, 'SYSTEM_ERROR', 2);
  }

  logger.success(`Removed machine ${machineId}`);
}
