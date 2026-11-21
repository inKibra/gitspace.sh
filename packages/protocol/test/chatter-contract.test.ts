import { describe, expect, it } from 'bun:test';
import { normalizeChatterTopic, similarChatterTopic, suggestChatterTopic } from '../src/chatter-contract.js';
import { scopeAllowsProject } from '../src/device-grant.js';

describe('Chatter topics', () => {
  it('normalizes case, punctuation and whitespace into one key', () => {
    expect(normalizeChatterTopic('  SQLite: 2 MB cap! ')).toBe('sqlite 2 mb cap');
    expect(normalizeChatterTopic('report_issue — `tool`')).toBe('report issue tool');
    expect(normalizeChatterTopic('?!')).toBe('');
  });

  it('suggests the first words of the first sentence', () => {
    expect(suggestChatterTopic('`bun test` hangs on the watcher. Seen in CI.')).toBe('bun test hangs on the');
    expect(suggestChatterTopic('Deploy works!')).toBe('Deploy works');
  });

  it('finds the active topic a new one is close to, and none for an unrelated one', () => {
    const active = [{ key: 'bun test hang', posts: 6 }, { key: 'sqlite 2 mb cap', posts: 2 }, { key: 'deploy dry run size', posts: 1 }];
    expect(similarChatterTopic('bun test hangs', active)?.key).toBe('bun test hang');
    expect(similarChatterTopic('bun test hanging in ci', active)?.key).toBe('bun test hang');
    expect(similarChatterTopic('sqllite 2 mb cap', active)?.key).toBe('sqlite 2 mb cap');
    expect(similarChatterTopic('wrangler login loop', active)).toBeNull();
    // Two shared words that make up all of one topic: similar though most words differ.
    expect(similarChatterTopic('bun test watcher ci rebase flake', [{ key: 'bun test', posts: 1 }])?.key).toBe('bun test');
    expect(similarChatterTopic('bun test hang', active)).toBeNull();
  });
});

describe('scopeAllowsProject', () => {
  it('reaches a project from the account, that project, or several including it; never from a workspace', () => {
    expect(scopeAllowsProject({ kind: 'user' }, 'a')).toBe(true);
    expect(scopeAllowsProject({ kind: 'project', projectId: 'a' }, 'a')).toBe(true);
    expect(scopeAllowsProject({ kind: 'project', projectId: 'a' }, 'b')).toBe(false);
    expect(scopeAllowsProject({ kind: 'projects', projectIds: ['a', 'b'] }, 'b')).toBe(true);
    expect(scopeAllowsProject({ kind: 'projects', projectIds: ['a', 'b'] }, 'c')).toBe(false);
    expect(scopeAllowsProject({ kind: 'workspace', workspaceId: 'a' }, 'a')).toBe(false);
  });
});
