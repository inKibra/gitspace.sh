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
  listVaultMachinesForOwner,
  removeVaultMachineForOwner,
} from "../relay/control/store.js";
import {
  ensureSubdomainTunnelToken,
  listAccountSubdomains,
  readHostConfig,
} from "./host.js";
import { selectOne } from "../utils/prompts.js";

/** Default port for relay server (4480 = "GIT0" on phone keypad) */
const DEFAULT_PORT = 4480;
const RELAY_RUNTIME_DIR = ".relay/runtime";
const RELAY_STATE_FILE = "relay-state.json";

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

async function isCloudflaredInstalled(): Promise<boolean> {
  const proc = Bun.spawn(["which", "cloudflared"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null && "getReader" in value;
}

function trackCloudflaredOutput(proc: ReturnType<typeof Bun.spawn>): void {
  const streamReader = async (
    stream: unknown,
    prefix: "warning" | "dim",
  ) => {
    if (!isReadableStream(stream)) {
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        const text = decoder.decode(value, { stream: true }).trim();
        if (!text) {
          continue;
        }

        if (prefix === "warning") {
          logger.warning(`[cloudflared] ${text}`);
        } else {
          logger.dim(`[cloudflared] ${text}`);
        }
      }
    } catch {
      // Ignore reader errors when process exits.
    } finally {
      reader.releaseLock();
    }
  };

  void streamReader(proc.stdout, "dim");
  void streamReader(proc.stderr, "warning");
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
  await Bun.sleep(1200);

  const exitCode = await Promise.race([
    cloudflared.exited,
    Bun.sleep(100).then(() => null),
  ]);

  if (typeof exitCode === "number") {
    throw new SpacesError(`cloudflared exited immediately with code ${exitCode}`, "SYSTEM_ERROR", 2);
  }

  return cloudflared;
}

async function resolveAccountRelayTarget(): Promise<{
  hostname: string;
  subdomain: string;
  tunnelToken: string;
} | null> {
  let subdomains: string[] = [];
  try {
    const accountSubdomains = await listAccountSubdomains();
    subdomains = accountSubdomains.map((entry) => entry.subdomain);
  } catch {
    // Not logged in or API unavailable; account relay auto-bind is optional.
  }

  if (subdomains.length === 0) {
    const localHostConfig = readHostConfig();
    subdomains = localHostConfig?.subdomains?.length
      ? [...localHostConfig.subdomains]
      : localHostConfig?.subdomain
        ? [localHostConfig.subdomain]
        : [];
  }

  if (subdomains.length === 0) {
    return null;
  }

  const hostConfig = readHostConfig();
  subdomains = [...new Set(subdomains)].sort((a, b) => {
    if (hostConfig?.subdomain === a) return -1;
    if (hostConfig?.subdomain === b) return 1;
    return a.localeCompare(b);
  });

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
  }

  const tunnelToken = await ensureSubdomainTunnelToken(selectedSubdomain);
  return {
    hostname: `${selectedSubdomain}.gitspace.sh`,
    subdomain: selectedSubdomain,
    tunnelToken,
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
  label?: string;
}): Promise<void> {
  const existingState = readRelayState();
  if (existingState?.pid && isProcessRunning(existingState.pid)) {
    throw new SpacesError(
      `Relay is already running (pid ${existingState.pid}). Stop it first with \`gssh relay stop\`.`,
      "USER_ERROR",
      1,
    );
  }

  const port = options.port ?? parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const bind = options.bind ?? process.env.RELAY_BIND ?? "0.0.0.0";
  let hostname = options.hostname ?? process.env.RELAY_HOST;
  let tunnelSubdomain: string | undefined;
  let tunnelToken: string | undefined;

  if (!hostname) {
    const accountTarget = await resolveAccountRelayTarget();
    if (accountTarget) {
      hostname = accountTarget.hostname;
      tunnelSubdomain = accountTarget.subdomain;
      tunnelToken = accountTarget.tunnelToken;
      logger.info(`Using account host ${hostname} for relay tunnel`);
    }
  }

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
  if (tunnelSubdomain) {
    logger.log(`  Tunnel:   ${tunnelSubdomain}.gitspace.sh`);
  }
  logger.log("");

  let tunnelProcess: ReturnType<typeof Bun.spawn> | null = null;

  try {
    const server = await createRelayServer({
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

    logger.success(`Relay listening on ws://${hostname || bind}:${port}`);
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
      server.stop();
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

  const stopPid = async (pid: number | undefined): Promise<void> => {
    if (!pid || !isProcessRunning(pid)) {
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isProcessRunning(pid)) {
        return;
      }
      await Bun.sleep(100);
    }

    if (isProcessRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore kill errors.
      }
    }
  };

  await stopPid(state.tunnelPid);
  await stopPid(state.pid);
  clearRelayState();
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

  const relayUrl = `ws://${state.hostname || state.bind}:${state.port}`;
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
