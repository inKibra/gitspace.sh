import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { SpritesProvider } from './sprites-provider.js';
import { getSpritesToken } from './provider-config.js';

const RUN_LIVE = process.env.SPRITES_E2E === '1';
const envToken = process.env.SPRITES_TOKEN?.trim() ?? '';
const keychainToken = RUN_LIVE && !envToken ? await getSpritesToken() : null;
const SPRITES_TOKEN = envToken || keychainToken || '';
const liveDescribe = RUN_LIVE && Boolean(SPRITES_TOKEN) ? describe : describe.skip;

const SPRITES_APP_ID = process.env.SPRITES_APP_ID ?? `gssh-live-${Date.now().toString(36)}`;
const SPRITES_BASE_URL = process.env.SPRITES_BASE_URL;

const LIVE_TIMEOUT_MS = 180_000;
setDefaultTimeout(LIVE_TIMEOUT_MS);

let provider: SpritesProvider;
const createdSpriteIds = new Set<string>();

function uniqueSpriteName(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

async function safeDestroy(providerWorkspaceId: string): Promise<void> {
  try {
    await provider.destroyWorkspace(providerWorkspaceId);
  } catch {
    // best effort cleanup for live resources
  }
}

liveDescribe('SpritesProvider live integration', () => {
  beforeAll(() => {
    provider = new SpritesProvider({
      token: SPRITES_TOKEN,
      appId: SPRITES_APP_ID,
      baseUrl: SPRITES_BASE_URL,
    });
  });

  afterEach(async () => {
    for (const spriteId of createdSpriteIds) {
      await safeDestroy(spriteId);
    }
    createdSpriteIds.clear();
  });

  test('runs create/exec/stop/resume/destroy against live API', async () => {
    const spriteName = uniqueSpriteName('ws-live');

    const created = await provider.createWorkspace({
      name: spriteName,
      repo: 'owner/repo',
      branch: 'main',
    });

    expect(created.providerWorkspaceId).toBeTruthy();
    expect(created.status).not.toBe('destroyed');
    createdSpriteIds.add(created.providerWorkspaceId);

    const current = await provider.getWorkspaceStatus(created.providerWorkspaceId);
    expect(current.providerWorkspaceId).toBe(created.providerWorkspaceId);

    const execSuccess = await provider.execWorkspaceCommand(created.providerWorkspaceId, {
      command: ['sh', '-lc', 'printf live-ok'],
    });
    expect(execSuccess.exitCode).toBe(0);
    expect(execSuccess.stdout).toContain('live-ok');

    const execFailure = await provider.execWorkspaceCommand(created.providerWorkspaceId, {
      command: ['sh', '-lc', 'printf live-error 1>&2; exit 7'],
    });
    expect(execFailure.exitCode).toBe(7);
    expect(execFailure.stderr).toContain('live-error');

    const stopped = await provider.stopWorkspace(created.providerWorkspaceId);
    expect(stopped.providerWorkspaceId).toBe(created.providerWorkspaceId);
    expect(stopped.status).not.toBe('destroyed');

    const resumed = await provider.resumeWorkspace(created.providerWorkspaceId);
    expect(resumed.providerWorkspaceId).toBe(created.providerWorkspaceId);
    expect(resumed.status).not.toBe('destroyed');

    await provider.destroyWorkspace(created.providerWorkspaceId);
    createdSpriteIds.delete(created.providerWorkspaceId);
  });
});
