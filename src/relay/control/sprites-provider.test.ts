/**
 * Sprites provider contract tests.
 *
 * Uses a mocked HTTP fetch so no real Sprites.dev API calls are made.
 * Tests cover the full lifecycle: create → stop → resume → destroy,
 * plus error handling and status mapping.
 *
 * The module under test is src/relay/control/sprites-provider.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ── mock global fetch ─────────────────────────────────────────────────────────

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

const mockFetch = mock(async (_url: string | URL, _init?: RequestInit): Promise<MockResponse> => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
  arrayBuffer: async () => new Uint8Array(0).buffer,
}));

// Replace global fetch before importing provider
(globalThis as Record<string, unknown>).fetch = mockFetch as unknown as typeof fetch;

const {
  SpritesProvider,
  SpritesProviderError,
} = await import('./sprites-provider.js');

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_TOKEN = 'sprites-tok-test-1234';
const TEST_APP_ID = 'gssh-cloud-test';

function makeProvider() {
  return new SpritesProvider({ token: TEST_TOKEN, appId: TEST_APP_ID });
}

function mockOkResponse(body: unknown) {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, 'utf8');
  mockFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }));
}

function mockErrorResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, 'utf8');
  mockFetch.mockImplementation(async () => ({
    ok: false,
    status,
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }));
}

// ── tests ─────────────────────────────────────────────────────────────────────

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
  beforeEach(() => { mockFetch.mockClear(); });

  test('sends POST to /sprites and returns a workspace record', async () => {
    mockOkResponse({
      id: 'sprite-abc123-id',
      name: 'ws-abc123',
      status: 'cold',
    });

    const provider = makeProvider();
    const result = await provider.createWorkspace({ name: 'ws-abc123', repo: 'owner/repo', branch: 'main' });

    expect(result.providerWorkspaceId).toBe('ws-abc123');
    expect(result.status).toBe('hibernated');

    // Verify the fetch was called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/sprites');
    expect((init.headers as Record<string, string>)['Authorization']).toContain(TEST_TOKEN);
    expect(init.method).toBe('POST');
  });

  test('throws SpritesProviderError on API error', async () => {
    mockErrorResponse(422, { error: 'invalid config' });

    const provider = makeProvider();
    await expect(provider.createWorkspace({ name: 'ws-error', repo: 'owner/repo', branch: 'main' })).rejects.toThrow(
      SpritesProviderError
    );
  });

  test('includes sprite name in create request body', async () => {
    mockOkResponse({ id: 'sprite-xyz-id', name: 'ws-xyz', status: 'cold' });

    const provider = makeProvider();
    await provider.createWorkspace({ name: 'ws-xyz', repo: 'myorg/myrepo', branch: 'feature-x' });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { name?: string };
    expect(body.name).toBe('ws-xyz');
  });
});

describe('SpritesProvider – stopWorkspace', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  test('checks status, executes stop command, and returns offline status', async () => {
    const statusRunningText = JSON.stringify({ name: 'sprite-abc123', status: 'running' });
    const statusRunningBytes = Buffer.from(statusRunningText, 'utf8');
    const execOkText = JSON.stringify({ exit_code: 0, stdout: '', stderr: '' });
    const execOkBytes = Buffer.from(execOkText, 'utf8');

    mockFetch
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ name: 'sprite-abc123', status: 'running' }),
        text: async () => statusRunningText,
        arrayBuffer: async () => statusRunningBytes.buffer.slice(
          statusRunningBytes.byteOffset,
          statusRunningBytes.byteOffset + statusRunningBytes.byteLength
        ),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ exit_code: 0, stdout: '', stderr: '' }),
        text: async () => execOkText,
        arrayBuffer: async () => execOkBytes.buffer.slice(
          execOkBytes.byteOffset,
          execOkBytes.byteOffset + execOkBytes.byteLength
        ),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ name: 'sprite-abc123', status: 'running' }),
        text: async () => statusRunningText,
        arrayBuffer: async () => statusRunningBytes.buffer.slice(
          statusRunningBytes.byteOffset,
          statusRunningBytes.byteOffset + statusRunningBytes.byteLength
        ),
      }));

    const provider = makeProvider();
    const result = await provider.stopWorkspace('sprite-abc123');

    expect(result.status).toBe('offline');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [statusUrl, statusInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const [execUrl, execInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(statusUrl).toContain('/v1/sprites/sprite-abc123');
    expect(statusInit.method).toBe('GET');
    expect(execUrl).toContain('/v1/sprites/sprite-abc123/exec');
    expect(execInit.method).toBe('POST');
  });

  test('throws SpritesProviderError on API error', async () => {
    mockErrorResponse(404, { error: 'machine not found' });

    const provider = makeProvider();
    await expect(provider.stopWorkspace('nonexistent')).rejects.toThrow(SpritesProviderError);
  });
});

describe('SpritesProvider – resumeWorkspace', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  test('reads sprite status and returns ready when running', async () => {
    mockOkResponse({ name: 'sprite-abc123', status: 'running' });

    const provider = makeProvider();
    const result = await provider.resumeWorkspace('sprite-abc123');

    expect(result.status).toBe('ready');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/sprites/sprite-abc123');
    expect(init.method).toBe('GET');
  });

  test('returns hibernated status when sprite is cold', async () => {
    mockOkResponse({ name: 'sprite-abc123', status: 'cold' });

    const provider = makeProvider();
    const result = await provider.resumeWorkspace('sprite-abc123');

    expect(result.status).toBe('hibernated');
  });

  test('throws SpritesProviderError on API error', async () => {
    mockErrorResponse(500, { error: 'internal server error' });

    const provider = makeProvider();
    await expect(provider.resumeWorkspace('sprite-abc123')).rejects.toThrow(SpritesProviderError);
  });
});

describe('SpritesProvider – destroyWorkspace', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  test('sends DELETE to machine endpoint', async () => {
    mockOkResponse({});

    const provider = makeProvider();
    await provider.destroyWorkspace('sprite-abc123');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('sprite-abc123');
    expect(init.method).toBe('DELETE');
  });

  test('throws SpritesProviderError on API error', async () => {
    mockErrorResponse(404, { error: 'not found' });

    const provider = makeProvider();
    await expect(provider.destroyWorkspace('sprite-abc123')).rejects.toThrow(SpritesProviderError);
  });
});

describe('SpritesProvider – getWorkspaceStatus', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  test('maps "running" state to "ready"', async () => {
    mockOkResponse({ id: 'sprite-abc', status: 'running' });
    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc');
    expect(result.status).toBe('ready');
  });

  test('maps "cold" state to "hibernated"', async () => {
    mockOkResponse({ id: 'sprite-abc', status: 'cold' });
    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc');
    expect(result.status).toBe('hibernated');
  });

  test('maps "warm" state to "provisioning"', async () => {
    mockOkResponse({ id: 'sprite-abc', status: 'warm' });
    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc');
    expect(result.status).toBe('provisioning');
  });

  test('maps "destroying" or "destroyed" state to "destroyed"', async () => {
    mockOkResponse({ id: 'sprite-abc', state: 'destroyed' });
    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc');
    expect(result.status).toBe('destroyed');
  });

  test('maps unknown state to "error"', async () => {
    mockOkResponse({ id: 'sprite-abc', state: 'some_unknown_state' });
    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc');
    expect(result.status).toBe('error');
  });

  test('throws SpritesProviderError on HTTP error', async () => {
    mockErrorResponse(404, { error: 'not found' });
    const provider = makeProvider();
    await expect(provider.getWorkspaceStatus('nonexistent')).rejects.toThrow(SpritesProviderError);
  });
});

describe('SpritesProvider – execWorkspaceCommand', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  test('parses binary stream-framed exec output and exit code', async () => {
    const bytes = Uint8Array.from([
      0x01, ...Buffer.from('hello from stdout\n', 'utf8'),
      0x02, ...Buffer.from('warning on stderr\n', 'utf8'),
      0x03, 0x00,
    ]);

    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as MockResponse));

    const provider = makeProvider();
    const result = await provider.execWorkspaceCommand('sprite-abc123', {
      command: ['echo', 'hello'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from stdout');
    expect(result.stderr).toContain('warning on stderr');
  });

  test('throws on binary stream non-zero exit code', async () => {
    const bytes = Uint8Array.from([
      0x02, ...Buffer.from('gssh not found\n', 'utf8'),
      0x03, 0x7f,
    ]);

    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as MockResponse));

    const provider = makeProvider();
    await expect(provider.execWorkspaceCommand('sprite-abc123', {
      command: ['bash', '-lc', 'exit 127'],
    })).rejects.toThrow(SpritesProviderError);
  });

  test('sends POST to /sprites/:id/exec with command and env params', async () => {
    const okText = JSON.stringify({ exit_code: 0, stdout: 'ok', stderr: '' });
    const okBytes = Buffer.from(okText, 'utf8');
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ exit_code: 0, stdout: 'ok', stderr: '' }),
      text: async () => okText,
      arrayBuffer: async () => okBytes.buffer.slice(okBytes.byteOffset, okBytes.byteOffset + okBytes.byteLength),
    }));

    const provider = makeProvider();
    const result = await provider.execWorkspaceCommand('sprite-abc123', {
      command: ['bash', '-lc', 'echo hello'],
      env: { FOO: 'bar', BAZ: 'qux' },
      dir: '/home/sprite',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sprites/sprite-abc123/exec');
    expect(url).toContain('cmd=bash');
    expect(url).toContain('cmd=-lc');
    expect(url).toContain('cmd=echo+hello');
    expect(url).toContain('env=FOO%3Dbar');
    expect(url).toContain('env=BAZ%3Dqux');
    expect(url).toContain('dir=%2Fhome%2Fsprite');
    expect(init.method).toBe('POST');
  });

  test('throws SpritesProviderError for non-zero exit code', async () => {
    const errText = JSON.stringify({ exit_code: 1, stdout: '', stderr: 'boom' });
    const errBytes = Buffer.from(errText, 'utf8');
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ exit_code: 1, stdout: '', stderr: 'boom' }),
      text: async () => errText,
      arrayBuffer: async () => errBytes.buffer.slice(errBytes.byteOffset, errBytes.byteOffset + errBytes.byteLength),
    }));

    const provider = makeProvider();
    await expect(provider.execWorkspaceCommand('sprite-abc123', {
      command: ['bash', '-lc', 'false'],
    })).rejects.toThrow(SpritesProviderError);
  });

  test('falls back to raw text output when response is not JSON', async () => {
    const plain = Buffer.from('plain text output', 'utf8');
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'plain text output',
      arrayBuffer: async () => plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength),
    }));

    const provider = makeProvider();
    const result = await provider.execWorkspaceCommand('sprite-abc123', {
      command: ['echo', 'hello'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('plain text output');
  });

  test('throws SpritesProviderError on HTTP failure', async () => {
    mockErrorResponse(500, { error: 'exec failed' });
    const provider = makeProvider();
    await expect(provider.execWorkspaceCommand('sprite-abc123', {
      command: ['echo', 'hello'],
    })).rejects.toThrow(SpritesProviderError);
  });
});
