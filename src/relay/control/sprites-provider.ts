/**
 * Sprites.dev cloud provider integration.
 *
 * Sprites is a Firecracker microVM service (by Fly.io) that provides:
 * - Persistent ext4 volumes
 * - Auto-hibernation / wake-on-connect
 * - Services API for auto-restarting processes (e.g. `gssh serve`)
 *
 * This module wraps the Sprites REST API and maps their machine states
 * to the internal CloudWorkspaceStatus type.
 *
 * API base: https://api.sprites.dev/v1
 * Docs: https://sprites.dev/docs/api
 */

import type { CloudWorkspaceStatus } from './types.js';

// ── Error type ────────────────────────────────────────────────────────────────

export class SpritesProviderError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'SpritesProviderError';
    this.statusCode = statusCode;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpritesProviderOptions {
  /** Sprites.dev API token */
  token: string;
  /** Sprites application ID (groups machines under one app) */
  appId: string;
  /** Override the API base URL (useful for testing) */
  baseUrl?: string;
}

export interface CreateWorkspaceOptions {
  repo: string;
  branch: string;
  /** Docker image to boot the VM from */
  image?: string;
  /** Extra environment variables to inject at boot */
  env?: Record<string, string>;
}

export interface WorkspaceStatusResult {
  /** Sprites machine ID */
  providerWorkspaceId: string;
  /** Mapped internal status */
  status: CloudWorkspaceStatus;
  /** Raw Sprites machine state string */
  rawState: string;
}

export interface ExecWorkspaceCommandOptions {
  /** Command + args, e.g. ['bash', '-lc', 'echo hello'] */
  command: string[];
  /** Optional environment variables injected only for this command */
  env?: Record<string, string>;
  /** Optional working directory */
  dir?: string;
}

export interface ExecWorkspaceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ── State mapping ─────────────────────────────────────────────────────────────

/**
 * Map Sprites machine states to internal CloudWorkspaceStatus.
 *
 * Sprites states (from their API docs):
 *   created   – machine was created but hasn't started yet
 *   started   – machine is running
 *   stopping  – machine is being stopped
 *   stopped   – machine is hibernated (stopped but persistent)
 *   replacing – machine image is being replaced
 *   destroying – machine is being destroyed
 *   destroyed – machine has been destroyed
 */
function mapSpritesState(state: string): CloudWorkspaceStatus {
  switch (state) {
    case 'created':
    case 'replacing':
      return 'provisioning';
    case 'started':
      return 'ready';
    case 'stopping':
      return 'offline';
    case 'stopped':
      return 'hibernated';
    case 'destroying':
    case 'destroyed':
      return 'destroyed';
    default:
      return 'error';
  }
}

// ── Default image ─────────────────────────────────────────────────────────────

const DEFAULT_AGENT_IMAGE = 'docker.io/gitspace/agent:latest';
const SPRITES_API_BASE = 'https://api.sprites.dev/v1';

// ── Provider ──────────────────────────────────────────────────────────────────

export class SpritesProvider {
  private readonly token: string;
  private readonly appId: string;
  private readonly baseUrl: string;

  constructor(options: SpritesProviderOptions) {
    if (!options.token || !options.token.trim()) {
      throw new SpritesProviderError('SpritesProvider requires a non-empty token.', 0);
    }
    if (!options.appId || !options.appId.trim()) {
      throw new SpritesProviderError('SpritesProvider requires a non-empty appId.', 0);
    }
    this.token = options.token.trim();
    this.appId = options.appId.trim();
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? SPRITES_API_BASE;
  }

  // ── Private HTTP helpers ───────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private machinesBaseUrl(): string {
    return `${this.baseUrl}/apps/${this.appId}/machines`;
  }

  private async request<T>(
    url: string,
    init: RequestInit
  ): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init.headers as Record<string, string> | undefined ?? {}),
      },
    });

    if (!response.ok) {
      let message: string;
      try {
        const body = await response.json() as { error?: string; message?: string };
        message = body.error ?? body.message ?? `HTTP ${response.status}`;
      } catch {
        message = `HTTP ${response.status}`;
      }
      throw new SpritesProviderError(
        `Sprites API error: ${message}`,
        response.status
      );
    }

    return response.json() as Promise<T>;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Create a new Sprites machine for a cloud workspace.
   * Returns a partial WorkspaceStatusResult with status='provisioning'.
   */
  async createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceStatusResult> {
    const image = options.image ?? DEFAULT_AGENT_IMAGE;

    const body = {
      config: {
        image,
        metadata: {
          repo: options.repo,
          branch: options.branch,
          managed_by: 'gitspace',
        },
        env: options.env ?? {},
        // Services: auto-restart gssh serve on VM wake
        services: [
          {
            internal_port: 0,
            protocol: 'tcp',
            autostart: true,
            autostop: true,
          },
        ],
      },
    };

    const machine = await this.request<{ id: string; state: string }>(
      this.machinesBaseUrl(),
      { method: 'POST', body: JSON.stringify(body) }
    );

    return {
      providerWorkspaceId: machine.id,
      status: mapSpritesState(machine.state ?? 'created'),
      rawState: machine.state ?? 'created',
    };
  }

  /**
   * Stop (hibernate) a running Sprites machine.
   */
  async stopWorkspace(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    const machine = await this.request<{ id: string; state: string }>(
      `${this.machinesBaseUrl()}/${providerWorkspaceId}/stop`,
      { method: 'POST' }
    );

    return {
      providerWorkspaceId,
      status: mapSpritesState(machine.state ?? 'stopped'),
      rawState: machine.state ?? 'stopped',
    };
  }

  /**
   * Resume (start) a hibernated Sprites machine.
   */
  async resumeWorkspace(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    const machine = await this.request<{ id: string; state: string }>(
      `${this.machinesBaseUrl()}/${providerWorkspaceId}/start`,
      { method: 'POST' }
    );

    return {
      providerWorkspaceId,
      status: mapSpritesState(machine.state ?? 'created'),
      rawState: machine.state ?? 'created',
    };
  }

  /**
   * Permanently destroy a Sprites machine (irreversible).
   */
  async destroyWorkspace(providerWorkspaceId: string): Promise<void> {
    await this.request<unknown>(
      `${this.machinesBaseUrl()}/${providerWorkspaceId}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Get the current status of a Sprites machine.
   */
  async getWorkspaceStatus(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    const machine = await this.request<{ id: string; state: string }>(
      `${this.machinesBaseUrl()}/${providerWorkspaceId}`,
      { method: 'GET' }
    );

    return {
      providerWorkspaceId,
      status: mapSpritesState(machine.state ?? 'created'),
      rawState: machine.state,
    };
  }

  /**
   * Execute a one-off command in a workspace VM.
   *
   * Uses the Sprites exec endpoint, which also wakes the VM when cold.
   */
  async execWorkspaceCommand(
    providerWorkspaceId: string,
    options: ExecWorkspaceCommandOptions
  ): Promise<ExecWorkspaceCommandResult> {
    if (!Array.isArray(options.command) || options.command.length === 0) {
      throw new SpritesProviderError('execWorkspaceCommand requires a non-empty command array.', 0);
    }

    const query = new URLSearchParams();
    for (const part of options.command) {
      query.append('cmd', part);
    }
    if (options.dir) {
      query.set('dir', options.dir);
    }
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        query.append('env', `${key}=${value}`);
      }
    }

    const url = `${this.baseUrl}/sprites/${encodeURIComponent(providerWorkspaceId)}/exec?${query.toString()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
    });

    const rawText = await response.text();

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      if (rawText) {
        try {
          const parsed = JSON.parse(rawText) as { error?: string; message?: string };
          message = parsed.error ?? parsed.message ?? rawText;
        } catch {
          message = rawText;
        }
      }
      throw new SpritesProviderError(`Sprites exec failed: ${message}`, response.status);
    }

    let parsed: { exit_code?: number; exitCode?: number; stdout?: string; stderr?: string } | null = null;
    try {
      parsed = rawText ? JSON.parse(rawText) as { exit_code?: number; exitCode?: number; stdout?: string; stderr?: string } : null;
    } catch {
      parsed = null;
    }

    const exitCode = parsed?.exit_code ?? parsed?.exitCode ?? 0;
    const stdout = parsed?.stdout ?? rawText;
    const stderr = parsed?.stderr ?? '';

    if (exitCode !== 0) {
      throw new SpritesProviderError(
        `Sprites exec command failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
        200
      );
    }

    return { exitCode, stdout, stderr };
  }
}
