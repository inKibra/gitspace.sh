/**
 * Sprites.dev cloud provider integration.
 *
 * Sprites is a Firecracker microVM service (by Fly.io) that provides:
 * - Persistent ext4 volumes
 * - Auto-hibernation / wake-on-connect
 * - Services API for auto-restarting processes (e.g. `gssh machine serve start`)
 *
 * This module wraps the Sprites REST API and maps their sprite states
 * to the internal CloudWorkspaceStatus type.
 *
 * API base: https://api.sprites.dev/v1
 * Docs: https://sprites.dev/api
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
  /**
   * Legacy option retained for compatibility.
   * Sprites v1 API is org-scoped by token and does not use app IDs.
   */
  appId: string;
  /** Override the API base URL (useful for testing) */
  baseUrl?: string;
}

export interface CreateWorkspaceOptions {
  /** Stable sprite name; we use workspaceId */
  name: string;
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

const SPRITE_STREAM_STDOUT = 0x01;
const SPRITE_STREAM_STDERR = 0x02;
const SPRITE_STREAM_EXIT = 0x03;

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parseSpriteExecBinaryResponse(bytes: Uint8Array): ExecWorkspaceCommandResult {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  const isMarker = (value: number): boolean =>
    value === SPRITE_STREAM_STDOUT ||
    value === SPRITE_STREAM_STDERR ||
    value === SPRITE_STREAM_EXIT;

  let i = 0;
  while (i < bytes.length) {
    const marker = bytes[i];

    if (!isMarker(marker)) {
      stdout += decodeUtf8(bytes.subarray(i));
      break;
    }

    if (marker === SPRITE_STREAM_EXIT) {
      if (i + 1 < bytes.length) {
        exitCode = bytes[i + 1] ?? 0;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    const streamStart = i + 1;
    let streamEnd = streamStart;
    while (streamEnd < bytes.length && !isMarker(bytes[streamEnd] ?? 0)) {
      streamEnd += 1;
    }

    const chunk = decodeUtf8(bytes.subarray(streamStart, streamEnd));
    if (marker === SPRITE_STREAM_STDOUT) {
      stdout += chunk;
    } else if (marker === SPRITE_STREAM_STDERR) {
      stderr += chunk;
    }

    i = streamEnd;
  }

  return { stdout, stderr, exitCode };
}

// ── State mapping ─────────────────────────────────────────────────────────────

/**
 * Map Sprites machine states to internal CloudWorkspaceStatus.
 *
 * Sprites states (from their API docs):
 *   cold     – stopped, persistent disk retained
 *   warm     – waking / provisioning
 *   running  – active runtime
 *
 * Legacy states are still mapped for compatibility with older responses.
 */
function mapSpritesState(state: string): CloudWorkspaceStatus {
  switch (state) {
    case 'running':
      return 'ready';
    case 'warm':
      return 'provisioning';
    case 'cold':
      return 'hibernated';
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

// ── API constants ─────────────────────────────────────────────────────────────

const SPRITES_API_BASE = 'https://api.sprites.dev/v1';

// ── Provider ──────────────────────────────────────────────────────────────────

export class SpritesProvider {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(options: SpritesProviderOptions) {
    if (!options.token || !options.token.trim()) {
      throw new SpritesProviderError('SpritesProvider requires a non-empty token.', 0);
    }
    if (!options.appId || !options.appId.trim()) {
      throw new SpritesProviderError('SpritesProvider requires a non-empty appId.', 0);
    }
    this.token = options.token.trim();
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

  private spritesBaseUrl(): string {
    return `${this.baseUrl}/sprites`;
  }

  private spriteUrl(spriteName: string): string {
    return `${this.spritesBaseUrl()}/${encodeURIComponent(spriteName)}`;
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

    const rawText = await response.text();

    if (!response.ok) {
      let message: string;
      try {
        const body = rawText ? JSON.parse(rawText) as { error?: string; message?: string } : null;
        message = body?.error ?? body?.message ?? (rawText || `HTTP ${response.status}`);
      } catch {
        message = rawText || `HTTP ${response.status}`;
      }
      throw new SpritesProviderError(
        `Sprites API error: ${message}`,
        response.status
      );
    }

    if (!rawText) {
      return {} as T;
    }

    try {
      return JSON.parse(rawText) as T;
    } catch {
      return rawText as T;
    }
  }

  private async requestRaw(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; bytes: Uint8Array }> {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init.headers as Record<string, string> | undefined ?? {}),
      },
    });

    return {
      ok: response.ok,
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Create a new Sprites machine for a cloud workspace.
   * Returns a partial WorkspaceStatusResult with status='provisioning'.
   */
  async createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceStatusResult> {
    const body = {
      name: options.name,
    };

    const sprite = await this.request<{ id?: string; name?: string; status?: string; state?: string }>(
      this.spritesBaseUrl(),
      { method: 'POST', body: JSON.stringify(body) }
    );

    const spriteName = sprite.name ?? options.name;
    const rawState = sprite.status ?? sprite.state ?? 'cold';

    return {
      providerWorkspaceId: spriteName,
      status: mapSpritesState(rawState),
      rawState,
    };
  }

  /**
   * Stop (hibernate) a running Sprites machine.
   */
  async stopWorkspace(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    const sprite = await this.request<{ status?: string; state?: string }>(
      this.spriteUrl(providerWorkspaceId),
      { method: 'GET' }
    );

    const currentState = sprite.status ?? sprite.state ?? 'cold';
    const currentMapped = mapSpritesState(currentState);
    if (currentMapped === 'hibernated') {
      return {
        providerWorkspaceId,
        status: currentMapped,
        rawState: currentState,
      };
    }

    await this.execWorkspaceCommand(providerWorkspaceId, {
      command: ['bash', '-lc', 'if command -v gssh >/dev/null 2>&1; then gssh machine serve stop || true; fi'],
    });

    const postStop = await this.request<{ status?: string; state?: string }>(
      this.spriteUrl(providerWorkspaceId),
      { method: 'GET' }
    );
    const postStopState = postStop.status ?? postStop.state ?? 'warm';
    const mapped = mapSpritesState(postStopState);

    return {
      providerWorkspaceId,
      status: mapped === 'ready' ? 'offline' : mapped,
      rawState: postStopState,
    };
  }

  /**
   * Resume (start) a hibernated Sprites machine.
   */
  async resumeWorkspace(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    const sprite = await this.request<{ status?: string; state?: string }>(
      this.spriteUrl(providerWorkspaceId),
      { method: 'GET' }
    );
    const rawState = sprite.status ?? sprite.state ?? 'cold';

    return {
      providerWorkspaceId,
      status: mapSpritesState(rawState),
      rawState,
    };
  }

  /**
   * Permanently destroy a Sprites machine (irreversible).
   */
  async destroyWorkspace(providerWorkspaceId: string): Promise<void> {
    await this.request<unknown>(
      this.spriteUrl(providerWorkspaceId),
      { method: 'DELETE' }
    );
  }

  /**
   * Get the current status of a Sprites machine.
   */
  async getWorkspaceStatus(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    const sprite = await this.request<{ status?: string; state?: string }>(
      this.spriteUrl(providerWorkspaceId),
      { method: 'GET' }
    );
    const rawState = sprite.status ?? sprite.state ?? 'cold';

    return {
      providerWorkspaceId,
      status: mapSpritesState(rawState),
      rawState,
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
    const response = await this.requestRaw(url, {
      method: 'POST',
    });

    if (!response.ok) {
      const rawText = decodeUtf8(response.bytes);
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

    const bytes = response.bytes;
    let parsedResult: ExecWorkspaceCommandResult;

    if (bytes.length > 0 && (bytes[0] === SPRITE_STREAM_STDOUT || bytes[0] === SPRITE_STREAM_STDERR || bytes[0] === SPRITE_STREAM_EXIT)) {
      parsedResult = parseSpriteExecBinaryResponse(bytes);
    } else {
      const rawText = decodeUtf8(bytes);
      let parsed: { exit_code?: number; exitCode?: number; stdout?: string; stderr?: string } | null = null;
      try {
        parsed = rawText ? JSON.parse(rawText) as { exit_code?: number; exitCode?: number; stdout?: string; stderr?: string } : null;
      } catch {
        parsed = null;
      }

      parsedResult = {
        exitCode: parsed?.exit_code ?? parsed?.exitCode ?? 0,
        stdout: parsed?.stdout ?? rawText,
        stderr: parsed?.stderr ?? '',
      };
    }

    const { exitCode, stdout, stderr } = parsedResult;

    if (exitCode !== 0) {
      throw new SpritesProviderError(
        `Sprites exec command failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
        200
      );
    }

    return { exitCode, stdout, stderr };
  }
}
