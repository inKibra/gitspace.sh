/**
 * Sprites.dev cloud provider integration (SDK-backed).
 */

import { APIError, ExecError, SpritesClient, type Sprite } from '@fly/sprites';
import type { CloudWorkspaceStatus } from './types.js';

export class SpritesProviderError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'SpritesProviderError';
    this.statusCode = statusCode;
  }
}

export interface SpritesProviderOptions {
  token: string;
  appId: string;
  baseUrl?: string;
}

export interface CreateWorkspaceOptions {
  name: string;
  repo: string;
  branch: string;
  image?: string;
  env?: Record<string, string>;
}

export interface WorkspaceStatusResult {
  providerWorkspaceId: string;
  status: CloudWorkspaceStatus;
  rawState: string;
}

export interface ExecWorkspaceCommandOptions {
  command: string[];
  env?: Record<string, string>;
  dir?: string;
}

export interface ExecWorkspaceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WriteWorkspaceFileOptions {
  path: string;
  contents: string | Uint8Array;
  workingDir?: string;
  mode?: string;
  mkdir?: boolean;
}

export interface WriteWorkspaceFileResult {
  path: string;
  size: number;
  mode?: string;
}

const SPRITES_API_BASE = 'https://api.sprites.dev';

function normalizeSdkBaseUrl(baseUrl?: string): string {
  if (!baseUrl) {
    return SPRITES_API_BASE;
  }

  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}

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

function parseState(sprite: { status?: string } & Record<string, unknown>): string {
  const maybeState = sprite['state'];
  if (typeof sprite.status === 'string' && sprite.status.length > 0) {
    return sprite.status;
  }
  if (typeof maybeState === 'string' && maybeState.length > 0) {
    return maybeState;
  }
  return 'cold';
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || (statusCode >= 500 && statusCode <= 504);
}

function isAlreadyExistsError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('already exists') || normalized.includes('already taken');
}

function toText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

function toProviderError(error: unknown, defaultMessage: string): SpritesProviderError {
  if (error instanceof SpritesProviderError) {
    return error;
  }

  if (error instanceof APIError) {
    return new SpritesProviderError(`Sprites API error: ${error.message}`, error.statusCode ?? 0);
  }

  if (error instanceof Error) {
    return new SpritesProviderError(error.message || defaultMessage, 0);
  }

  return new SpritesProviderError(defaultMessage, 0);
}

export class SpritesProvider {
  private readonly client: SpritesClient;

  constructor(options: SpritesProviderOptions) {
    if (!options.token || !options.token.trim()) {
      throw new SpritesProviderError('SpritesProvider requires a non-empty token.', 0);
    }
    if (!options.appId || !options.appId.trim()) {
      throw new SpritesProviderError('SpritesProvider requires a non-empty appId.', 0);
    }

    this.client = new SpritesClient(options.token.trim(), {
      baseURL: normalizeSdkBaseUrl(options.baseUrl),
      timeout: 60_000,
    });
  }

  private toWorkspaceStatusResult(
    fallbackName: string,
    sprite: { name?: string; status?: string } & Record<string, unknown>,
  ): WorkspaceStatusResult {
    const providerWorkspaceId = sprite.name ?? fallbackName;
    const rawState = parseState(sprite);

    return {
      providerWorkspaceId,
      status: mapSpritesState(rawState),
      rawState,
    };
  }

  private async getSpriteIfExists(name: string): Promise<Sprite | null> {
    try {
      return await this.client.getSprite(name);
    } catch (error) {
      if (error instanceof APIError) {
        if (error.statusCode === 404 || isRetryableStatus(error.statusCode ?? 0)) {
          return null;
        }
      }
      throw toProviderError(error, 'Failed to fetch sprite');
    }
  }

  async createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceStatusResult> {
    const createRetryDelaysMs = [1000, 2500];
    const maxAttempts = 1 + createRetryDelaysMs.length;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sprite = await this.client.createSprite(options.name);
        return this.toWorkspaceStatusResult(options.name, sprite as unknown as Record<string, unknown>);
      } catch (error) {
        const providerError = toProviderError(error, 'Failed to create sprite');
        const canRecoverByExisting = isRetryableStatus(providerError.statusCode)
          || isAlreadyExistsError(providerError.message);

        if (canRecoverByExisting) {
          for (const waitMs of [0, 500, 1200, 2500, 5000, 9000]) {
            if (waitMs > 0) {
              await Bun.sleep(waitMs);
            }

            const existing = await this.getSpriteIfExists(options.name);
            if (existing) {
              return this.toWorkspaceStatusResult(options.name, existing as unknown as Record<string, unknown>);
            }
          }
        }

        if (attempt >= maxAttempts) {
          throw providerError;
        }

        await Bun.sleep(createRetryDelaysMs[attempt - 1] ?? 2000);
      }
    }

    throw new SpritesProviderError('Sprites create failed unexpectedly', 500);
  }

  async stopWorkspace(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    let sprite: Sprite;
    try {
      sprite = await this.client.getSprite(providerWorkspaceId);
    } catch (error) {
      throw toProviderError(error, 'Failed to fetch sprite for stop');
    }

    const currentState = parseState(sprite as unknown as Record<string, unknown>);
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

    let postStop: Sprite;
    try {
      postStop = await this.client.getSprite(providerWorkspaceId);
    } catch (error) {
      throw toProviderError(error, 'Failed to fetch sprite after stop');
    }

    const postStopState = parseState(postStop as unknown as Record<string, unknown>);
    const mapped = mapSpritesState(postStopState);
    return {
      providerWorkspaceId,
      status: mapped === 'ready' ? 'offline' : mapped,
      rawState: postStopState,
    };
  }

  async resumeWorkspace(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    try {
      const sprite = await this.client.getSprite(providerWorkspaceId);
      const rawState = parseState(sprite as unknown as Record<string, unknown>);
      return {
        providerWorkspaceId,
        status: mapSpritesState(rawState),
        rawState,
      };
    } catch (error) {
      throw toProviderError(error, 'Failed to resume sprite');
    }
  }

  async destroyWorkspace(providerWorkspaceId: string): Promise<void> {
    try {
      await this.client.deleteSprite(providerWorkspaceId);
    } catch (error) {
      throw toProviderError(error, 'Failed to destroy sprite');
    }
  }

  async getWorkspaceStatus(providerWorkspaceId: string): Promise<WorkspaceStatusResult> {
    try {
      const sprite = await this.client.getSprite(providerWorkspaceId);
      const rawState = parseState(sprite as unknown as Record<string, unknown>);
      return {
        providerWorkspaceId,
        status: mapSpritesState(rawState),
        rawState,
      };
    } catch (error) {
      throw toProviderError(error, 'Failed to fetch sprite status');
    }
  }

  async execWorkspaceCommand(
    providerWorkspaceId: string,
    options: ExecWorkspaceCommandOptions,
  ): Promise<ExecWorkspaceCommandResult> {
    if (!Array.isArray(options.command) || options.command.length === 0) {
      throw new SpritesProviderError('execWorkspaceCommand requires a non-empty command array.', 0);
    }

    const [file, ...args] = options.command;
    const sprite = this.client.sprite(providerWorkspaceId);

    try {
      const result = await sprite.execFile(file!, args, {
        env: options.env,
        cwd: options.dir,
      });

      return {
        exitCode: result.exitCode,
        stdout: toText(result.stdout),
        stderr: toText(result.stderr),
      };
    } catch (error) {
      if (error instanceof ExecError) {
        return {
          exitCode: error.exitCode,
          stdout: toText(error.stdout),
          stderr: toText(error.stderr),
        };
      }

      throw toProviderError(error, 'Sprites exec failed');
    }
  }

  async writeWorkspaceFile(
    providerWorkspaceId: string,
    options: WriteWorkspaceFileOptions,
  ): Promise<WriteWorkspaceFileResult> {
    if (!options.path || !options.path.trim()) {
      throw new SpritesProviderError('writeWorkspaceFile requires a non-empty path.', 0);
    }

    const sprite = this.client.sprite(providerWorkspaceId);
    const fs = sprite.filesystem(options.workingDir ?? '/');
    const data = typeof options.contents === 'string'
      ? Buffer.from(options.contents, 'utf8')
      : Buffer.from(options.contents);

    const parentPath = options.path.includes('/')
      ? options.path.slice(0, options.path.lastIndexOf('/'))
      : '';

    try {
      if (options.mkdir && parentPath) {
        await fs.mkdir(parentPath, { recursive: true });
      }

      let mode: number | undefined;
      if (options.mode) {
        const parsedMode = Number.parseInt(options.mode, 8);
        if (!Number.isNaN(parsedMode)) {
          mode = parsedMode;
        }
      }

      await fs.writeFile(options.path, data, mode !== undefined ? { mode } : undefined);
    } catch (error) {
      throw toProviderError(error, 'Sprites fs write failed');
    }

    return {
      path: options.path,
      size: data.byteLength,
      mode: options.mode,
    };
  }
}
