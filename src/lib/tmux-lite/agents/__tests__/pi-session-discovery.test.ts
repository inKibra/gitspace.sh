import { describe, it, expect } from 'bun:test';
import { PiCoordinator } from '../pi-coordinator.js';
import { listPiSessions, findPiSessionFile } from '../pi-session-files.js';
import { getPiAgentDir } from '../pi-runtime.js';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const WORKSPACE_CWD = '/Users/bradleat/gitspace/gitspace.sh/workspaces/figma-based-redesign';
const WORKSPACE_ID = 'gitspace.sh:figma-based-redesign';

describe('pi-session-files', () => {
  it('getPiAgentDir points to managed dir', () => {
    const dir = getPiAgentDir();
    console.log('Agent dir:', dir);
    expect(dir).toContain('gitspace');
    expect(existsSync(dir)).toBe(true);
  });

  it('listPiSessions finds sessions for this workspace', () => {
    const sessions = listPiSessions(WORKSPACE_CWD);
    console.log(`Found ${sessions.length} sessions:`);
    for (const s of sessions) {
      console.log(`  id=${s.id} | title=${s.title ?? '(none)'} | first=${s.firstMessage?.slice(0, 50)} | msgs=${s.messageCount} | path=${s.path}`);
    }
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('findPiSessionFile finds a specific session', () => {
    const sessions = listPiSessions(WORKSPACE_CWD);
    if (sessions.length === 0) {
      console.log('No sessions to test with');
      return;
    }

    const first = sessions[0];
    const found = findPiSessionFile(WORKSPACE_CWD, first.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(first.id);
    expect(found!.path).toBe(first.path);
    console.log(`Found session ${first.id} at ${found!.path}`);
  });

  it('findPiSessionFile returns null for unknown ID', () => {
    const found = findPiSessionFile(WORKSPACE_CWD, 'nonexistent-id');
    expect(found).toBeNull();
  });

  it('listPiSessions returns empty for unknown workspace', () => {
    const sessions = listPiSessions('/tmp/nonexistent-workspace');
    expect(sessions).toEqual([]);
  });
});

describe('PiCoordinator session discovery', () => {
  it('refreshAgentSessions finds sessions', async () => {
    const coordinator = new PiCoordinator();
    const target = {
      workspaceId: WORKSPACE_ID,
      workspaceName: 'figma-based-redesign',
      workspacePath: WORKSPACE_CWD,
      projectName: 'gitspace.sh',
    };

    const sessions = await coordinator.refreshAgentSessions(target);
    console.log(`Coordinator found ${sessions.length} sessions:`);
    for (const s of sessions) {
      console.log(`  id=${s.id} | title=${s.title} | updated=${s.updatedAt}`);
    }
    expect(sessions.length).toBeGreaterThan(0);
  });
});
