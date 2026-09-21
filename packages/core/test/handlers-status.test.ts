import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { beginAgentOperation, settleAgentOperation } from '@gitspace/protocol-agent';
import {
  FactEventStore,
  GitSpaceDatabase,
  GitSpaceHandlers,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
  agentSessions,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitSpaceHandlers workspace activity color', () => {
  it('uses canonical activity rather than open lifecycle state', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-handler-status-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const project = database.createProject({ id: 'project-a', name: 'A', repositoryPath: '/repo/a' });
    expect(project.status).toBe('ok');
    const workspace = database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'A', branch: 'a', rootPath: '/repo/a/ws' });
    expect(workspace.status).toBe('ok');
    const now = new Date().toISOString();
    database.orm.insert(agentSessions).values({
      id: 'agent-a', spaceId: 'workspace-a', ompSessionId: 'omp-a', sessionFile: '/omp-a.jsonl', state: 'active',
      activity: { active: false, reasons: [] }, lastEventOffset: 0, createdAt: now, updatedAt: now,
    }).run();
    const handlers = new GitSpaceHandlers(
      database,
      new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32)),
      new FactEventStore(database),
    );
    expect(handlers.workspaceView(database.getWorkspace('workspace-a')!).status.primaryColor).toBe('blue');

    database.orm.update(agentSessions).set({ activity: { active: true, reasons: [{ kind: 'turn' }] } })
      .where(eq(agentSessions.id, 'agent-a')).run();
    expect(handlers.workspaceView(database.getWorkspace('workspace-a')!).status.primaryColor).toBe('green');

    database.orm.update(agentSessions).set({ activity: { active: true, reasons: [{ kind: 'compacting' }] } })
      .where(eq(agentSessions.id, 'agent-a')).run();
    expect(handlers.workspaceView(database.getWorkspace('workspace-a')!).status.primaryColor).toBe('green');

    database.orm.update(agentSessions).set({ activity: { active: true, reasons: [{ kind: 'subagents', count: 2 }] } })
      .where(eq(agentSessions.id, 'agent-a')).run();
    expect(handlers.workspaceView(database.getWorkspace('workspace-a')!).status.primaryColor).toBe('green');

    database.orm.update(agentSessions).set({ activity: { active: true, reasons: [{ kind: 'queued', steering: 0, followUp: 1 }] } })
      .where(eq(agentSessions.id, 'agent-a')).run();
    expect(handlers.workspaceView(database.getWorkspace('workspace-a')!).status.primaryColor).toBe('green');

    const checkpoint = beginAgentOperation({ revision: 0, issues: {} }, 'checkpoint', 'checkpoint');
    const failedCheckpoint = settleAgentOperation(checkpoint.state, checkpoint.token, {
      sessionId: 'agent-a', spaceId: 'workspace-a', now,
      failure: { domain: 'agent', code: 'AGENT_RUNTIME_FAILED', message: 'Checkpoint unavailable', context: {} },
    });
    database.orm.update(agentSessions).set({ health: failedCheckpoint.state }).where(eq(agentSessions.id, 'agent-a')).run();
    expect(handlers.workspaceView(database.getWorkspace('workspace-a')!).status.agents).toEqual({ green: 1, blue: 0, orange: 0, red: 0 });

    database.orm.update(agentSessions).set({ activity: { active: true, reasons: [{ kind: 'human', questions: 1, permissions: 0 }] } })
      .where(eq(agentSessions.id, 'agent-a')).run();
    expect(handlers.workspaceView(database.getWorkspace('workspace-a')!).status.primaryColor).toBe('orange');
    database.close();
  });
});
