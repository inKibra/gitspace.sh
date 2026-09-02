import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FactEventStore,
  GitSpaceDatabase,
  GitSpaceHandlers,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
  normalizeRelations,
  phaseCeilingViolation,
  stackChecks,
  validateStack,
  type StackWorkspace,
  type WorkspaceRelations,
} from '../src/index.js';

function relations(overrides: Partial<WorkspaceRelations> = {}): WorkspaceRelations {
  return { dependsOn: [], relatedTo: [], stackedOn: null, ...overrides };
}

function node(id: string, overrides: Partial<StackWorkspace> = {}): StackWorkspace {
  return { id, name: id.toUpperCase(), phase: 'code', closedAt: null, relations: relations(), ...overrides };
}

describe('validateStack', () => {
  it('declares the checks as code', () => {
    expect(stackChecks.map((check) => check.name)).toEqual(['dependency-open', 'dependency-archived', 'phase-ceiling', 'cycle']);
  });

  it('blocks a chain while dependencies stay open and indexes the inverse', () => {
    const stacks = validateStack([
      node('a'),
      node('b', { relations: relations({ dependsOn: ['a'] }) }),
      node('c', { relations: relations({ dependsOn: ['b'], relatedTo: ['a'] }) }),
    ]);
    expect(stacks.get('a')).toEqual({ blockedBy: [], blocking: ['b'], findings: [] });
    expect(stacks.get('b')).toEqual({
      blockedBy: ['a'],
      blocking: ['c'],
      findings: [{ code: 'dependency-open', message: 'Blocked by A (code)', workspaceId: 'a' }],
    });
    expect(stacks.get('c')?.blockedBy).toEqual(['b']);
    expect(stacks.get('c')?.blocking).toEqual([]);
  });

  it('unblocks once the dependency ships', () => {
    const stacks = validateStack([
      node('a', { phase: 'ship' }),
      node('b', { relations: relations({ dependsOn: ['a'] }) }),
    ]);
    expect(stacks.get('b')).toEqual({ blockedBy: [], blocking: [], findings: [] });
    expect(stacks.get('a')?.blocking).toEqual([]);
  });

  it('reports an archived dependency as information rather than a block', () => {
    const stacks = validateStack([
      node('a', { closedAt: '2026-09-01T00:00:00.000Z' }),
      node('b', { relations: relations({ dependsOn: ['a'] }) }),
    ]);
    expect(stacks.get('b')).toEqual({
      blockedBy: [],
      blocking: [],
      findings: [{ code: 'dependency-archived', message: 'A was archived while this workspace is still open', workspaceId: 'a' }],
    });
  });

  it('does not block an archived workspace on its open dependencies', () => {
    const stacks = validateStack([
      node('a'),
      node('b', { closedAt: '2026-09-01T00:00:00.000Z', relations: relations({ dependsOn: ['a'] }) }),
    ]);
    expect(stacks.get('b')?.findings).toEqual([]);
    expect(stacks.get('a')?.blocking).toEqual([]);
  });

  it('flags a dependency cycle on every member', () => {
    const stacks = validateStack([
      node('a', { relations: relations({ dependsOn: ['c'] }) }),
      node('b', { relations: relations({ dependsOn: ['a'] }) }),
      node('c', { relations: relations({ dependsOn: ['b'] }) }),
      node('d', { relations: relations({ dependsOn: ['a'] }) }),
    ]);
    for (const id of ['a', 'b', 'c']) {
      const cycle = stacks.get(id)?.findings.filter((finding) => finding.code === 'cycle');
      expect(cycle).toHaveLength(1);
      expect(cycle?.[0]?.workspaceId).toBeNull();
      expect(cycle?.[0]?.message.startsWith(`Dependency cycle: ${id.toUpperCase()} → `)).toBe(true);
      expect(cycle?.[0]?.message.endsWith(` → ${id.toUpperCase()}`)).toBe(true);
    }
    expect(stacks.get('d')?.findings.map((finding) => finding.code)).toEqual(['dependency-open']);
  });

  it('flags a workspace whose phase passed a dependency and names the parent', () => {
    const workspaces = [
      node('a', { phase: 'code' }),
      node('b', { phase: 'review', relations: relations({ dependsOn: ['a'], stackedOn: 'a' }) }),
      node('c', { phase: 'code', relations: relations({ dependsOn: ['a'] }) }),
    ];
    const stacks = validateStack(workspaces);
    expect(stacks.get('b')?.findings).toEqual([
      { code: 'dependency-open', message: 'Blocked by A (code)', workspaceId: 'a' },
      { code: 'phase-ceiling', message: 'Ahead of A (code); a workspace cannot pass the phase of what it depends on', workspaceId: 'a' },
    ]);
    expect(stacks.get('b')?.blockedBy).toEqual(['a']);
    expect(stacks.get('c')?.findings.map((finding) => finding.code)).toEqual(['dependency-open']);

    const [a] = workspaces;
    expect(phaseCeilingViolation('review', [a!])?.id).toBe('a');
    expect(phaseCeilingViolation('code', [a!])).toBeNull();
    expect(phaseCeilingViolation('ship', [])).toBeNull();
  });
});

describe('normalizeRelations', () => {
  it('drops self references and duplicates, and lets dependsOn win over relatedTo', () => {
    expect(normalizeRelations('a', { dependsOn: ['b', 'a', 'b'], relatedTo: ['b', 'c', 'c', 'a'], stackedOn: null }))
      .toEqual({ dependsOn: ['b'], relatedTo: ['c'], stackedOn: null });
  });

  it('folds stackedOn into dependsOn and drops a self stack', () => {
    expect(normalizeRelations('a', { dependsOn: ['c'], relatedTo: ['b'], stackedOn: 'b' }))
      .toEqual({ dependsOn: ['c', 'b'], relatedTo: [], stackedOn: 'b' });
    expect(normalizeRelations('a', { dependsOn: ['b'], relatedTo: [], stackedOn: 'b' }))
      .toEqual({ dependsOn: ['b'], relatedTo: [], stackedOn: 'b' });
    expect(normalizeRelations('a', { dependsOn: [], relatedTo: [], stackedOn: 'a' }))
      .toEqual({ dependsOn: [], relatedTo: [], stackedOn: null });
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-relations-'));
  roots.push(root);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  for (const projectId of ['p1', 'p2']) {
    expect(database.createProject({ id: projectId, name: projectId, repositoryPath: `/repo/${projectId}` }).status).toBe('ok');
  }
  for (const id of ['a', 'b', 'c']) {
    expect(database.createWorkspace({ id, projectId: 'p1', name: id, branch: id, rootPath: `/repo/p1/${id}` }).status).toBe('ok');
  }
  expect(database.createWorkspace({ id: 'x', projectId: 'p2', name: 'x', branch: 'x', rootPath: '/repo/p2/x' }).status).toBe('ok');
  const handlers = new GitSpaceHandlers(
    database,
    new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32)),
    new FactEventStore(database),
  );
  return { database, handlers };
}

describe('space relations persistence', () => {
  it('stores, lists, and replaces relations per workspace', () => {
    const { database } = fixture();
    const first = database.setSpaceRelations('b', { dependsOn: ['a'], relatedTo: ['c'], stackedOn: null });
    expect(first.status).toBe('ok');
    expect(database.getSpaceRelations('b')).toEqual(relations({ dependsOn: ['a'], relatedTo: ['c'] }));
    expect(database.getSpaceRelations('a')).toEqual(relations());
    expect(database.setSpaceRelations('c', { dependsOn: [], relatedTo: [], stackedOn: 'b' }).status).toBe('ok');
    expect([...database.listSpaceRelations('p1').entries()]).toEqual([
      ['b', relations({ dependsOn: ['a'], relatedTo: ['c'] })],
      ['c', relations({ dependsOn: ['b'], stackedOn: 'b' })],
    ]);
    expect(database.setSpaceRelations('b', { dependsOn: [], relatedTo: [], stackedOn: null }).status).toBe('ok');
    expect(database.getSpaceRelations('b')).toEqual(relations());
    database.close();
  });

  it('rejects a stack parent that is not a single known workspace', () => {
    const { database } = fixture();
    const many = database.setSpaceRelations('b', { dependsOn: [], relatedTo: [], stackedOn: ['a', 'c'] as unknown as string });
    expect(many.status).toBe('error');
    if (many.status === 'ok') throw new Error('expected error');
    expect(many.error._tag).toBe('CoreInputError');
    const self = database.setSpaceRelations('b', { dependsOn: [], relatedTo: [], stackedOn: 'b' });
    expect(self.status).toBe('error');
    if (self.status === 'ok') throw new Error('expected error');
    expect(self.error._tag).toBe('CoreInputError');
    const unknown = database.setSpaceRelations('b', { dependsOn: [], relatedTo: [], stackedOn: 'nope' });
    expect(unknown.status).toBe('error');
    if (unknown.status === 'ok') throw new Error('expected error');
    expect(unknown.error).toMatchObject({ _tag: 'CoreNotFound', id: 'nope' });
    expect(database.getSpaceRelations('b')).toEqual(relations());
    database.close();
  });

  it('rejects a dependency that closes a loop, naming the loop, and leaves the old relations intact', () => {
    const { database } = fixture();
    expect(database.setSpaceRelations('b', { dependsOn: [], relatedTo: [], stackedOn: 'a' }).status).toBe('ok');
    expect(database.setSpaceRelations('c', { dependsOn: ['b'], relatedTo: [], stackedOn: null }).status).toBe('ok');
    const loop = database.setSpaceRelations('a', { dependsOn: ['c'], relatedTo: [], stackedOn: null });
    expect(loop.status).toBe('error');
    if (loop.status === 'ok') throw new Error('expected error');
    expect(loop.error).toMatchObject({ _tag: 'CoreInputError', message: 'Dependency cycle: a → c → b → a' });
    expect(database.getSpaceRelations('a')).toEqual(relations());
    // Re-saving an existing acyclic edge set is not a cycle with itself.
    expect(database.setSpaceRelations('c', { dependsOn: ['b'], relatedTo: ['a'], stackedOn: null }).status).toBe('ok');
    database.close();
  });

  it('rejects self references, unknown ids, and workspaces from other projects', () => {
    const { database } = fixture();
    const self = database.setSpaceRelations('a', { dependsOn: ['a'], relatedTo: [], stackedOn: null });
    expect(self.status).toBe('error');
    if (self.status === 'ok') throw new Error('expected error');
    expect(self.error._tag).toBe('CoreInputError');
    const foreign = database.setSpaceRelations('a', { dependsOn: ['x'], relatedTo: [], stackedOn: null });
    expect(foreign.status).toBe('error');
    if (foreign.status === 'ok') throw new Error('expected error');
    expect(foreign.error).toMatchObject({ _tag: 'CoreNotFound', id: 'x' });
    const base = database.setSpaceRelations('a', { dependsOn: [], relatedTo: ['p1'], stackedOn: null });
    expect(base.status).toBe('error');
    const missing = database.setSpaceRelations('nope', { dependsOn: [], relatedTo: [], stackedOn: null });
    expect(missing.status).toBe('error');
    expect(database.getSpaceRelations('a')).toEqual(relations());
    database.close();
  });

  it('cascades relations when a related workspace is deleted', () => {
    const { database } = fixture();
    expect(database.setSpaceRelations('b', { dependsOn: [], relatedTo: ['c'], stackedOn: 'a' }).status).toBe('ok');
    expect(database.deleteWorkspace('a')).toBe(true);
    expect(database.getSpaceRelations('b')).toEqual(relations({ relatedTo: ['c'] }));
    expect(database.deleteWorkspace('b')).toBe(true);
    expect(database.listSpaceRelations('p1').size).toBe(0);
    database.close();
  });

  it('projects relations and stack onto workspace views', () => {
    const { database, handlers } = fixture();
    expect(database.setSpaceRelations('b', { dependsOn: [], relatedTo: ['c'], stackedOn: 'a' }).status).toBe('ok');
    expect(database.setSpaceRelations('c', { dependsOn: ['b'], relatedTo: [], stackedOn: null }).status).toBe('ok');

    const bootstrap = handlers.bootstrap({ projectId: 'p1', workspaceId: null });
    expect(bootstrap.status).toBe('ok');
    if (bootstrap.status === 'error') throw new Error('bootstrap failed');
    const views = Object.fromEntries(bootstrap.value.workspaces.map((workspace) => [workspace.id, workspace]));
    expect(views.a?.relations).toEqual(relations());
    expect(views.a?.stack).toEqual({ blockedBy: [], blocking: ['b'], findings: [] });
    expect(views.b?.relations).toEqual(relations({ dependsOn: ['a'], relatedTo: ['c'], stackedOn: 'a' }));
    expect(views.b?.stack.blockedBy).toEqual(['a']);
    expect(views.b?.stack.blocking).toEqual(['c']);
    expect(views.c?.stack.blockedBy).toEqual(['b']);

    expect(database.setWorkspacePhase('a', 'ship')).not.toBeNull();
    expect(handlers.workspaceView(database.getWorkspace('b')!).stack).toEqual({ blockedBy: [], blocking: ['c'], findings: [] });

    expect(database.setSpaceClosed('a', true)).not.toBeNull();
    expect(handlers.workspaceView(database.getWorkspace('b')!).stack.findings.map((finding) => finding.code)).toEqual(['dependency-archived']);
    database.close();
  });
});
