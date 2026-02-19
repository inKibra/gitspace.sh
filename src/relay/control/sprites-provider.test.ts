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
};

const mockFetch = mock(async (_url: string | URL, _init?: RequestInit): Promise<MockResponse> => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
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
  mockFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

function mockErrorResponse(status: number, body: unknown) {
  mockFetch.mockImplementation(async () => ({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
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

  test('sends POST to /apps/:appId/machines and returns a workspace record', async () => {
    mockOkResponse({
      id: 'sprite-abc123',
      state: 'created',
      config: { image: 'docker.io/gitspace/agent:latest' },
    });

    const provider = makeProvider();
    const result = await provider.createWorkspace({ repo: 'owner/repo', branch: 'main' });

    expect(result.providerWorkspaceId).toBe('sprite-abc123');
    expect(result.status).toBe('provisioning');

    // Verify the fetch was called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(TEST_APP_ID);
    expect((init.headers as Record<string, string>)['Authorization']).toContain(TEST_TOKEN);
    expect(init.method).toBe('POST');
  });

  test('throws SpritesProviderError on API error', async () => {
    mockErrorResponse(422, { error: 'invalid config' });

    const provider = makeProvider();
    await expect(provider.createWorkspace({ repo: 'owner/repo', branch: 'main' })).rejects.toThrow(
      SpritesProviderError
    );
  });

  test('includes repo and branch in machine metadata', async () => {
    mockOkResponse({ id: 'sprite-xyz', state: 'created', config: {} });

    const provider = makeProvider();
    await provider.createWorkspace({ repo: 'myorg/myrepo', branch: 'feature-x' });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { config?: { metadata?: Record<string, string> } };
    expect(body.config?.metadata?.repo).toBe('myorg/myrepo');
    expect(body.config?.metadata?.branch).toBe('feature-x');
  });
});

describe('SpritesProvider – stopWorkspace', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  test('sends POST to stop endpoint and returns hibernated status', async () => {
    mockOkResponse({ id: 'sprite-abc123', state: 'stopped' });

    const provider = makeProvider();
    const result = await provider.stopWorkspace('sprite-abc123');

    expect(result.status).toBe('hibernated');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('sprite-abc123');
    expect(init.method).toBe('POST');
  });

  test('throws SpritesProviderError on API error', async () => {
    mockErrorResponse(404, { error: 'machine not found' });

    const provider = makeProvider();
    await expect(provider.stopWorkspace('nonexistent')).rejects.toThrow(SpritesProviderError);
  });
});

describe('SpritesProvider – resumeWorkspace', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  test('sends POST to start endpoint and returns ready status when machine is running', async () => {
    // Sprites API returns 'started' when the machine is already running
    mockOkResponse({ id: 'sprite-abc123', state: 'started' });

    const provider = makeProvider();
    const result = await provider.resumeWorkspace('sprite-abc123');

    // 'started' maps to 'ready'
    expect(result.status).toBe('ready');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('sprite-abc123');
    expect(init.method).toBe('POST');
  });

  test('returns provisioning status when machine is still starting up', async () => {
    // Sprites API may return 'created' for a machine that is being started
    mockOkResponse({ id: 'sprite-abc123', state: 'created' });

    const provider = makeProvider();
    const result = await provider.resumeWorkspace('sprite-abc123');

    expect(result.status).toBe('provisioning');
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

  test('maps "started" state to "ready"', async () => {
    mockOkResponse({ id: 'sprite-abc', state: 'started' });
    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc');
    expect(result.status).toBe('ready');
  });

  test('maps "stopped" state to "hibernated"', async () => {
    mockOkResponse({ id: 'sprite-abc', state: 'stopped' });
    const provider = makeProvider();
    const result = await provider.getWorkspaceStatus('sprite-abc');
    expect(result.status).toBe('hibernated');
  });

  test('maps "created" state to "provisioning"', async () => {
    mockOkResponse({ id: 'sprite-abc', state: 'created' });
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

  test('sends POST to /sprites/:id/exec with command and env params', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ exit_code: 0, stdout: 'ok', stderr: '' }),
      text: async () => JSON.stringify({ exit_code: 0, stdout: 'ok', stderr: '' }),
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
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ exit_code: 1, stdout: '', stderr: 'boom' }),
      text: async () => JSON.stringify({ exit_code: 1, stdout: '', stderr: 'boom' }),
    }));

    const provider = makeProvider();
    await expect(provider.execWorkspaceCommand('sprite-abc123', {
      command: ['bash', '-lc', 'false'],
    })).rejects.toThrow(SpritesProviderError);
  });

  test('falls back to raw text output when response is not JSON', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'plain text output',
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
