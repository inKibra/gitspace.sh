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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadOrCreateRelayIdentity,
  formatRelayFingerprint,
} from "../relay/identity.js";
import { loadUserRootIdentity } from "../core/user-identity.js";
import { getSpacesDir } from "../core/config.js";
import {
  bindControlOwner,
  ensureControlStore,
  setVaultMeta,
  getVaultMeta,
  isVaultInitialized,
  listVaultMachinesForOwner,
  removeVaultMachineForOwner,
} from "../relay/control/store.js";
import {
  ensureSubdomainTunnelToken,
  readHostConfig,
  resolveRelaySubdomains,
} from "./host.js";
import { selectOne } from "../utils/prompts.js";
import { isCloudflaredInstalled, trackCloudflaredOutput } from "../utils/cloudflared.js";
import { ensureUserRootIdentityWithRecovery } from "./identity-recovery.js";

/** Default port for relay server (4480 = "GIT0" on phone keypad) */
const DEFAULT_PORT = 4480;
const RELAY_RUNTIME_DIR = ".relay/runtime";
const RELAY_STATE_FILE = "relay-state.json";
const CLOUDFLARED_STARTUP_DELAY_MS = 1200;
const CLOUDFLARED_EARLY_EXIT_RACE_MS = 100;

interface RelayRuntimeState {
  pid: number;
  startedAt: number;
  port: number;
  bind: string;
  hostname?: string;
  tunnelPid?: number;
  tunnelSubdomain?: string;
}

interface RelayStatusSnapshot {
  running: boolean;
  staleState: boolean;
  pid: number | null;
  tunnelPid: number | null;
  tunnelRunning: boolean;
  bind: string | null;
  port: number | null;
  hostname: string | null;
  tunnelSubdomain: string | null;
  relayUrl: string | null;
  publicRelayUrl: string | null;
  startedAt: number | null;
}

export type RelayStartMode = "auto" | "hosted" | "local";

function getRelayRuntimeDir(): string {
  return join(getSpacesDir(), RELAY_RUNTIME_DIR);
}

function getRelayStatePath(): string {
  return join(getRelayRuntimeDir(), RELAY_STATE_FILE);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRelayState(): RelayRuntimeState | null {
  const statePath = getRelayStatePath();
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as RelayRuntimeState;
  } catch {
    return null;
  }
}

function writeRelayState(state: RelayRuntimeState): void {
  const runtimeDir = getRelayRuntimeDir();
  if (!existsSync(runtimeDir)) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(getRelayStatePath(), JSON.stringify(state, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function clearRelayState(): void {
  const statePath = getRelayStatePath();
  if (!existsSync(statePath)) {
    return;
  }

  rmSync(statePath, { force: true });
}

type RelayProcessKind = "relay" | "tunnel";
type StaleRelayCleanupResult = "cleaned" | "preserved";
let warnedWindowsOwnershipUnsupported = false;

function getProcessCommand(pid: number): string | null {
  if (process.platform === "win32") {
    if (!warnedWindowsOwnershipUnsupported) {
      logger.warning("relay process ownership checks are not supported on Windows; refusing to signal managed PIDs on this platform");
      warnedWindowsOwnershipUnsupported = true;
    }
    return null;
  }

  try {
    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });

    if (proc.exitCode !== 0 || !proc.stdout) {
      return null;
    }

    const command = Buffer.from(proc.stdout).toString("utf-8").trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

function isOwnedProcessCommand(command: string, kind: RelayProcessKind): boolean {
  const normalizedCommand = command.toLowerCase();

  if (kind === "tunnel") {
    return normalizedCommand.includes("cloudflared")
      && normalizedCommand.includes("tunnel")
      && normalizedCommand.includes("run");
  }

  return normalizedCommand.includes("relay start");
}

function isOwnedProcess(pid: number, kind: RelayProcessKind): boolean {
  const command = getProcessCommand(pid);
  if (!command) {
    if (process.platform !== "win32") {
      logger.warning(`Unable to verify ownership for PID ${pid}; refusing to signal it.`);
    }
    return false;
  }

  return isOwnedProcessCommand(command, kind);
}

async function stopTrackedProcess(pid: number | undefined, kind: RelayProcessKind): Promise<"not-running" | "stopped" | "not-owned"> {
  if (!pid || !isProcessRunning(pid)) {
    return "not-running";
  }

  if (!isOwnedProcess(pid, kind)) {
    return "not-owned";
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return "not-running";
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) {
      return "stopped";
    }
    await Bun.sleep(100);
  }

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return "stopped";
    }
  }

  return "stopped";
}

async function cleanupStaleRelayState(state: RelayRuntimeState): Promise<StaleRelayCleanupResult> {
  let preserveState = false;

  if (state.tunnelPid && isProcessRunning(state.tunnelPid)) {
    const tunnelStopResult = await stopTrackedProcess(state.tunnelPid, "tunnel");
    if (tunnelStopResult === "not-owned") {
      logger.warning(
        `Found stale tunnel PID ${state.tunnelPid} that does not look like a managed cloudflared process; leaving it untouched.`,
      );
      preserveState = true;
    }
  }

  if (preserveState) {
    return "preserved";
  }

  clearRelayState();
  return "cleaned";
}

async function startCloudflaredTunnel(token: string): Promise<ReturnType<typeof Bun.spawn>> {
  if (!(await isCloudflaredInstalled())) {
    throw new SpacesError(
      "cloudflared is not installed. Install it first (brew install cloudflared).",
      "USER_ERROR",
      1,
    );
  }

  const cloudflared = Bun.spawn(["cloudflared", "tunnel", "run"], {
    env: {
      ...process.env,
      TUNNEL_TOKEN: token,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  trackCloudflaredOutput(cloudflared);
  // Give cloudflared a short window to initialize and surface immediate failures.
  await Bun.sleep(CLOUDFLARED_STARTUP_DELAY_MS);

  const exitCode = await Promise.race([
    cloudflared.exited,
    // Keep this race short so successful startup does not block relay start.
    Bun.sleep(CLOUDFLARED_EARLY_EXIT_RACE_MS).then(() => null),
  ]);

  if (typeof exitCode === "number") {
    throw new SpacesError(`cloudflared exited immediately with code ${exitCode}`, "SYSTEM_ERROR", 2);
  }

  return cloudflared;
}

async function resolveAccountRelayTarget(): Promise<{
  hostname: string;
  subdomain: string;
} | null> {
  const hostConfig = readHostConfig();
  const subdomains = await resolveRelaySubdomains(hostConfig);

  if (subdomains.length === 0) {
    return null;
  }

  let selectedSubdomain = subdomains[0];
  if (subdomains.length > 1 && process.stdout.isTTY && process.stdin.isTTY) {
    const picked = await selectOne(
      subdomains.map((subdomain) => ({
        label: `${subdomain}.gitspace.sh`,
        value: subdomain,
        description: hostConfig?.subdomain === subdomain ? "Primary subdomain" : undefined,
      })),
      "Select account host for relay tunnel",
    );

    if (!picked) {
      throw new SpacesError("Cancelled", "USER_ERROR", 1);
    }
    selectedSubdomain = picked;
  } else if (subdomains.length > 1) {
    logger.warning(
      `Multiple account hosts available; auto-selecting ${selectedSubdomain}.gitspace.sh in non-interactive mode. `
      + "Run interactively to choose a different host.",
    );
  }

  return {
    hostname: `${selectedSubdomain}.gitspace.sh`,
    subdomain: selectedSubdomain,
  };
}

/**
 * Start the relay server
 *
 * @param options - Command options
 */
export async function startRelay(options: {
  port?: number;
  hostname?: string;
  bind?: string;
  mode?: RelayStartMode;
  label?: string;
  yes?: boolean;
}): Promise<void> {
  const existingState = readRelayState();
  if (existingState?.pid && isProcessRunning(existingState.pid)) {
    const existingCommand = getProcessCommand(existingState.pid);
    if (!existingCommand) {
      throw new SpacesError(
        `Relay runtime state points to running PID ${existingState.pid}, but ownership could not be verified. Run \`gssh relay stop\` and retry.`,
        "USER_ERROR",
        1,
      );
    }

    if (isOwnedProcessCommand(existingCommand, "relay")) {
      throw new SpacesError(
        `Relay is already running (pid ${existingState.pid}). Stop it first with \`gssh relay stop\`.`,
        "USER_ERROR",
        1,
      );
    }

    logger.warning(
      `Found stale relay runtime state pointing to PID ${existingState.pid}; cleaning stale state and continuing.`,
    );
    const staleCleanup = await cleanupStaleRelayState(existingState);
    if (staleCleanup === "preserved") {
      throw new SpacesError(
        "Found a live unmanaged tunnel process tied to stale relay state. Stop it with `gssh relay stop` before starting a new relay.",
        "USER_ERROR",
        1,
      );
    }
  } else if (existingState) {
    const staleCleanup = await cleanupStaleRelayState(existingState);
    if (staleCleanup === "preserved") {
      throw new SpacesError(
        "Found a live unmanaged tunnel process tied to stale relay state. Stop it with `gssh relay stop` before starting a new relay.",
        "USER_ERROR",
        1,
      );
    }
  }

  const mode: RelayStartMode = options.mode ?? "auto";
  const port = options.port ?? parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const bind = options.bind ?? process.env.RELAY_BIND ?? "0.0.0.0";
  let hostname = options.hostname ?? process.env.RELAY_HOST;
  let tunnelSubdomain: string | undefined;
  let tunnelToken: string | undefined;

  if (mode === "hosted" && hostname) {
    throw new SpacesError(
      "Hosted mode does not support explicit --hostname. Remove --hostname and use your account host.",
      "USER_ERROR",
      1,
    );
  }

  if (mode !== "local" && !hostname) {
    const accountTarget = await resolveAccountRelayTarget();
    if (!accountTarget) {
      if (mode === "hosted") {
        throw new SpacesError(
          "Hosted relay startup requires an active gitspace.sh host.\n\nRun:\n  gssh user host reserve <name>\n  gssh user host status",
          "USER_ERROR",
          1,
        );
      }
    } else {
      try {
        tunnelToken = await ensureSubdomainTunnelToken(accountTarget.subdomain);
        hostname = accountTarget.hostname;
        tunnelSubdomain = accountTarget.subdomain;
        logger.info(`Using account host ${accountTarget.hostname} for relay tunnel`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (mode === "hosted") {
          throw new SpacesError(
            `Hosted relay startup failed while loading tunnel credentials for ${accountTarget.subdomain}.gitspace.sh.\n\n${detail}\n\nRun:\n  gssh user host status`,
            "USER_ERROR",
            1,
          );
        }

        logger.warning(
          `Could not load tunnel token for ${accountTarget.subdomain}.gitspace.sh. `
          + "Falling back to local relay start without tunnel.",
        );
        logger.dim(detail);
      }
    }
  }

  if (mode === "hosted" && !tunnelToken) {
    throw new SpacesError(
      "Hosted relay mode requires an active tunnel but none was configured.\n\nRun:\n  gssh user host status",
      "USER_ERROR",
      1,
    );
  }

  // Load or create relay identity
  const identity = await loadOrCreateRelayIdentity(options.label);
  const fingerprint = formatRelayFingerprint(identity.signingPublicKey);

  // ── Bind owner identity to relay ──────────────────────────────────────
  // Read the user root identity (from mnemonic in keychain) so the relay
  // knows who its owner is. This enables owner-based authorization for
  // machines and clients without requiring enrollment tokens.
  let ownerUserRootId: string | null = null;
  try {
    const userRoot = await loadUserRootIdentity()
      ?? await ensureUserRootIdentityWithRecovery({
        yes: options.yes,
        context: 'relay startup owner binding',
        allowSkip: true,
      });
    if (userRoot) {
      ownerUserRootId = userRoot.id;
      ensureControlStore();
      const existingOwner = getVaultMeta("owner_user_root_id");
      if (existingOwner && existingOwner !== ownerUserRootId) {
        throw new SpacesError(
          `Relay is already owned by a different user root identity.\n` +
          `  Existing owner: ${existingOwner.slice(0, 8)}...\n` +
          `  Current user:   ${ownerUserRootId.slice(0, 8)}...`,
          "USER_ERROR",
          1,
        );
      }
      if (!existingOwner) {
        if (isVaultInitialized()) {
          logger.info('Relay vault is initialized but owner metadata is missing; repairing owner binding from the current user root identity.');
        }

      }

      bindControlOwner(ownerUserRootId);

      if (!existingOwner) {
        setVaultMeta("owner_user_root_id", ownerUserRootId);
      }
      logger.dim(`  Owner identity: ${ownerUserRootId.slice(0, 8)}...`);
    } else {
      // User root identity not initialized - relay starts without an owner.
      // Machines will need enrollment tokens to register.
      logger.dim("  No user root identity found - machines will need enrollment tokens");
    }
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to load relay owner identity: ${detail}`);
    throw new SpacesError(
      'Failed to determine relay owner identity during startup.',
      'SYSTEM_ERROR',
      2,
    );
  }

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
  logger.log(`  Mode:     ${mode}`);
  if (hostname) {
    logger.log(`  Hostname: ${hostname} (only serving this domain)`);
  }
  if (tunnelSubdomain) {
    logger.log(`  Tunnel:   ${tunnelSubdomain}.gitspace.sh`);
  }
  if (ownerUserRootId) {
    logger.log(`  Owner:    ${ownerUserRootId.slice(0, 16)}...`);
  }
  logger.log("");

  let tunnelProcess: ReturnType<typeof Bun.spawn> | null = null;
  let server: ReturnType<typeof createRelayServer> | null = null;

  try {
    server = await createRelayServer({
      port,
      bind,
      hostname,
      identity,
    });

    if (tunnelToken) {
      tunnelProcess = await startCloudflaredTunnel(tunnelToken);
    }

    writeRelayState({
      pid: process.pid,
      startedAt: Date.now(),
      port,
      bind,
      hostname,
      tunnelPid: tunnelProcess?.pid,
      tunnelSubdomain,
    });

    logger.success(`Relay listening on ws://${hostname || bind}:${port}/ws`);
    if (tunnelSubdomain) {
      logger.success(`Public relay URL: wss://${tunnelSubdomain}.gitspace.sh/ws`);
    }
    logger.log("");
    logger.dim("Press Ctrl+C to stop");
    logger.log("");

    // Set up shutdown handlers
    const shutdown = () => {
      logger.log("");
      logger.info("Shutting down relay...");
      if (tunnelProcess) {
        tunnelProcess.kill();
      }
      server?.stop();
      clearRelayState();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep process alive
    await new Promise(() => {
      // Never resolves
    });
  } catch (error) {
    if (tunnelProcess) {
      tunnelProcess.kill();
    }
    server?.stop();
    clearRelayState();
    throw new SpacesError(
      `Failed to start relay: ${error instanceof Error ? error.message : String(error)}`,
      "SYSTEM_ERROR",
      2
    );
  }
}

export async function stopRelay(): Promise<void> {
  const state = readRelayState();
  if (!state) {
    logger.info("relay not running");
    return;
  }

  const tunnelStopResult = await stopTrackedProcess(state.tunnelPid, "tunnel");
  const relayStopResult = await stopTrackedProcess(state.pid, "relay");

  if (tunnelStopResult === "not-owned") {
    logger.warning(
      `Refusing to kill PID ${state.tunnelPid} because it does not look like a managed cloudflared tunnel process.`,
    );
  }

  if (relayStopResult === "not-owned") {
    logger.warning(
      `Refusing to kill PID ${state.pid} because it does not look like a managed relay process.`,
    );
  }

  if (relayStopResult === "not-owned" || tunnelStopResult === "not-owned") {
    logger.warning("relay stop did not clear runtime state because one or more running PIDs could not be verified as owned");
    return;
  }

  clearRelayState();
  if (relayStopResult === "not-running" && tunnelStopResult === "not-running") {
    logger.info("relay not running (stale state cleaned)");
    return;
  }

  logger.success("relay stopped");
}

function getRelayStatusSnapshot(): RelayStatusSnapshot {
  const state = readRelayState();
  if (!state) {
    return {
      running: false,
      staleState: false,
      pid: null,
      tunnelPid: null,
      tunnelRunning: false,
      bind: null,
      port: null,
      hostname: null,
      tunnelSubdomain: null,
      relayUrl: null,
      publicRelayUrl: null,
      startedAt: null,
    };
  }

  const running = isProcessRunning(state.pid);
  const tunnelRunning = typeof state.tunnelPid === "number" && isProcessRunning(state.tunnelPid);

  const relayUrl = `ws://${state.hostname || state.bind}:${state.port}/ws`;
  const publicRelayUrl = state.tunnelSubdomain
    ? `wss://${state.tunnelSubdomain}.gitspace.sh/ws`
    : null;

  return {
    running,
    staleState: !running,
    pid: state.pid,
    tunnelPid: state.tunnelPid ?? null,
    tunnelRunning,
    bind: state.bind,
    port: state.port,
    hostname: state.hostname ?? null,
    tunnelSubdomain: state.tunnelSubdomain ?? null,
    relayUrl,
    publicRelayUrl,
    startedAt: state.startedAt,
  };
}

export async function relayStatus(options: { json?: boolean } = {}): Promise<void> {
  const snapshot = getRelayStatusSnapshot();

  if (options.json) {
    logger.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  if (!snapshot.running) {
    if (snapshot.staleState) {
      if (snapshot.tunnelRunning && snapshot.tunnelPid !== null) {
        logger.warning(
          `relay not running, but tunnel PID ${snapshot.tunnelPid} is still active; keeping runtime state so \`gssh relay stop\` can clean it up`,
        );
        return;
      }
      clearRelayState();
      logger.warning("relay not running (stale runtime state cleaned)");
    } else {
      logger.info("relay not running");
    }
    return;
  }

  logger.bold("Relay Status");
  logger.log("");
  logger.log(`  State:      ${chalk.green("running")}`);
  logger.log(`  PID:        ${snapshot.pid}`);
  logger.log(`  Relay URL:  ${snapshot.relayUrl ?? "-"}`);
  logger.log(`  Bind:       ${snapshot.bind ?? "-"}`);
  logger.log(`  Port:       ${snapshot.port ?? "-"}`);
  if (snapshot.hostname) {
    logger.log(`  Hostname:   ${snapshot.hostname}`);
  }

  if (snapshot.startedAt) {
    logger.log(`  Started:    ${new Date(snapshot.startedAt).toISOString()}`);
  }

  if (snapshot.tunnelSubdomain) {
    const tunnelState = snapshot.tunnelRunning
      ? chalk.green("running")
      : chalk.yellow("not running");
    logger.log(`  Tunnel:     ${snapshot.tunnelSubdomain}.gitspace.sh (${tunnelState})`);
    logger.log(`  Public URL: ${snapshot.publicRelayUrl ?? "-"}`);
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
    logger.log(JSON.stringify(machines, null, 2));
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

  const removed = removeVaultMachineForOwner(ownerUserRootId, machineId);
  if (!removed) {
    throw new SpacesError(`Failed to remove machine '${machineId}'.`, 'SYSTEM_ERROR', 2);
  }

  logger.success(`Removed machine ${machineId}`);
}
