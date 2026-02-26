import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ExecResult = { exitCode: number; stdout: string | Buffer; stderr: string | Buffer };

const mockCreateSprite = mock(async (_name: string) => ({ name: 'default', status: 'cold' }));
const mockGetSprite = mock(async (name: string) => ({ name, status: 'running' }));
const mockDeleteSprite = mock(async (_name: string) => {});
const mockSpriteExecFile = mock(async (_name: string, _file: string, _args: string[], _options?: unknown): Promise<ExecResult> => ({
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
}));
const mockSpriteFsWriteFile = mock(async (
  _name: string,
  _workingDir: string,
  _path: string,
  _data: Buffer,
  _options?: { mode?: number },
) => {});
const mockSpriteFsMkdir = mock(async (
  _name: string,
  _workingDir: string,
  _path: string,
  _options?: { recursive?: boolean; mode?: number },
) => {});

class MockAPIError extends Error {
  readonly statusCode?: number;

  constructor(message: string, options?: { statusCode?: number }) {
    super(message);
    this.name = 'APIError';
    this.statusCode = options?.statusCode;
  }
}

class MockExecError extends Error {
  readonly result: ExecResult;

  constructor(message: string, result: ExecResult) {
    super(message);
    this.name = 'ExecError';
    this.result = result;
  }

  get exitCode(): number {
    return this.result.exitCode;
  }

  get stdout(): string | Buffer {
    return this.result.stdout;
  }

  get stderr(): string | Buffer {
    return this.result.stderr;
  }
}

class MockSpritesClient {
  readonly token: string;
  readonly baseURL: string;

  constructor(token: string, options: { baseURL?: string } = {}) {
    this.token = token;
    this.baseURL = options.baseURL ?? 'https://api.sprites.dev/v1';
  }

  sprite(name: string) {
    return {
      name,
      execFile: async (file: string, args: string[] = [], options?: unknown) =>
        await mockSpriteExecFile(name, file, args, options),
      filesystem: (workingDir = '/') => ({
        writeFile: async (path: string, data: Buffer, options?: { mode?: number }) =>
          await mockSpriteFsWriteFile(name, workingDir, path, data, options),
        mkdir: async (path: string, options?: { recursive?: boolean; mode?: number }) =>
          await mockSpriteFsMkdir(name, workingDir, path, options),
      }),
    };
  }

  async createSprite(name: string) {
    return await mockCreateSprite(name);
  }

  async getSprite(name: string) {
    return await mockGetSprite(name);
  }

  async deleteSprite(name: string) {
    await mockDeleteSprite(name);
  }
}

mock.module('@fly/sprites', () => ({
  SpritesClient: MockSpritesClient,
  APIError: MockAPIError,
  ExecError: MockExecError,
}));

const { SpritesProvider, SpritesProviderError } = await import('./sprites-provider.js');

const TEST_TOKEN = 'sprites-tok-test-1234';
const TEST_APP_ID = 'gssh-cloud-test';

function makeProvider() {
  return new SpritesProvider({ token: TEST_TOKEN, appId: TEST_APP_ID });
}

beforeEach(() => {
  mockCreateSprite.mockReset();
  mockGetSprite.mockReset();
  mockDeleteSprite.mockReset();
  mockSpriteExecFile.mockReset();
  mockSpriteFsWriteFile.mockReset();
  mockSpriteFsMkdir.mockReset();

  mockCreateSprite.mockImplementation(async (name: string) => ({ name, status: 'cold' }));
  mockGetSprite.mockImplementation(async (name: string) => ({ name, status: 'running' }));
  mockDeleteSprite.mockImplementation(async () => {});
  mockSpriteExecFile.mockImplementation(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
  mockSpriteFsWriteFile.mockImplementation(async () => {});
  mockSpriteFsMkdir.mockImplementation(async () => {});
});

describe('SpritesProvider – construction', () => {
  test('constructs with token and appId', () => {
    const provider = makeProvider();
    expect(provider).toBeDefined();
  });

  test('throws when token is missing', () => {
    expect(() => new SpritesProvider({ token: '', appId: TEST_APP_ID })).toThrow(/token/i);
  });

  test('throws when appId is missing', () => {
    expect(() => new SpritesProvider({ token: TEST_TOKEN, appId: '' })).toThrow(/appId/i);
  });
});

describe('SpritesProvider – createWorkspace', () => {
  test('creates sprite and maps status', async () => {
    mockCreateSprite.mockImplementation(async (name: string) => ({ name, status: 'cold' }));

    const provider = makeProvider();
    const result = await provider.createWorkspace({ name: 'ws-abc123', repo: 'owner/repo', branch: 'main' });

    expect(result.providerWorkspaceId).toBe('ws-abc123');
    expect(result.status).toBe('hibernated');
    expect(mockCreateSprite).toHaveBeenCalledWith('ws-abc123');
  });

  test('recovers when create returns retryable API error but sprite exists', async () => {
    mockCreateSprite.mockImplementation(async () => {
      throw new MockAPIError('Internal Server Error', { statusCode: 500 });
    });
    mockGetSprite.mockImplementation(async (name: string) => ({ name, status: 'warm' }));

    const provider = makeProvider();
    const result = await provider.createWorkspace({ name: 'ws-recovered', repo: 'owner/repo', branch: 'main' });

    expect(result.providerWorkspaceId).toBe('ws-recovered');
    expect(result.status).toBe('provisioning');
  });

  test('throws provider error on non-retryable create failure', async () => {
    mockCreateSprite.mockImplementation(async () => {
      throw new MockAPIError('invalid config', { statusCode: 422 });
    });

    const provider = makeProvider();
    await expect(provider.createWorkspace({ name: 'ws-error', repo: 'owner/repo', branch: 'main' })).rejects.toThrow(
      SpritesProviderError,
    );
  });
});

describe('SpritesProvider – stop/resume/status/destroy', () => {
  test('stop runs shutdown command and maps running to offline', async () => {
    mockGetSprite
      .mockImplementationOnce(async (name: string) => ({ name, status: 'running' }))
      .mockImplementationOnce(async (name: string) => ({ name, status: 'running' }));

    const provider = makeProvider();
    const result = await provider.stopWorkspace('sprite-abc123');

    expect(result.status).toBe('offline');
    expect(mockSpriteExecFile).toHaveBeenCalledTimes(1);
    expect(mockSpriteExecFile.mock.calls[0]?.[1]).toBe('bash');
  });

  test('resume maps cold to hibernated', async () => {
    mockGetSprite.mockImplementation(async (name: string) => ({ name, status: 'cold' }));

    const provider = makeProvider();
    const result = await provider.resumeWorkspace('sprite-abc123');
    expect(result.status).toBe('hibernated');
  });

  test('status maps running to ready', async () => {
    mockGetSprite.mockImplementation(async (name: string) => ({ name, status: 'running' }));

    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc123');
    expect(result.status).toBe('ready');
  });

  test('destroy delegates to sdk delete', async () => {
    const provider = makeProvider();
    await provider.destroyWorkspace('sprite-abc123');
    expect(mockDeleteSprite).toHaveBeenCalledWith('sprite-abc123');
  });
});

describe('SpritesProvider – execWorkspaceCommand', () => {
  test('returns stdout/stderr for successful command', async () => {
    mockSpriteExecFile.mockImplementation(async () => ({ exitCode: 0, stdout: 'hello', stderr: '' }));

    const provider = makeProvider();
    const result = await provider.execWorkspaceCommand('sprite-abc123', {
      command: ['bash', '-lc', 'echo hello'],
      env: { FOO: 'bar' },
      dir: '/tmp',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  test('returns non-zero result when sdk throws ExecError', async () => {
    mockSpriteExecFile.mockImplementation(async () => {
      throw new MockExecError('failed', { exitCode: 7, stdout: '', stderr: 'boom' });
    });

    const provider = makeProvider();
    const result = await provider.execWorkspaceCommand('sprite-abc123', {
      command: ['bash', '-lc', 'exit 7'],
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('boom');
  });

  test('throws SpritesProviderError on non-exec failure', async () => {
    mockSpriteExecFile.mockImplementation(async () => {
      throw new MockAPIError('bad gateway', { statusCode: 502 });
    });

    const provider = makeProvider();
    await expect(provider.execWorkspaceCommand('sprite-abc123', { command: ['echo', 'x'] })).rejects.toThrow(
      SpritesProviderError,
    );
  });
});

describe('SpritesProvider – writeWorkspaceFile', () => {
  test('writes file through sdk filesystem API', async () => {
    const provider = makeProvider();
    const result = await provider.writeWorkspaceFile('sprite-abc123', {
      path: '/tmp/bootstrap.mjs',
      contents: 'console.log("hi")',
      workingDir: '/',
      mode: '0644',
      mkdir: true,
    });

    expect(result.path).toBe('/tmp/bootstrap.mjs');
    expect(result.size).toBeGreaterThan(0);
    expect(mockSpriteFsMkdir).toHaveBeenCalledTimes(1);
    expect(mockSpriteFsWriteFile).toHaveBeenCalledTimes(1);
    expect(mockSpriteFsWriteFile.mock.calls[0]?.[2]).toBe('/tmp/bootstrap.mjs');
    expect(mockSpriteFsWriteFile.mock.calls[0]?.[4]).toEqual({ mode: 0o644 });
  });

  test('throws on empty path', async () => {
    const provider = makeProvider();
    await expect(provider.writeWorkspaceFile('sprite-abc123', {
      path: '',
      contents: 'x',
    })).rejects.toThrow(SpritesProviderError);
  });
});
