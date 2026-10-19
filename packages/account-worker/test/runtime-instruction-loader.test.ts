import { describe, expect, it, vi } from 'vitest';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { createRuntimeInstructionLoader } from '../src/runtime-instruction-loader.js';
import { loadRuntimeRules } from '../src/runtime-instructions.js';

function fixture() {
  const code = Object.create(ArtifactsCodeStore.prototype) as ArtifactsCodeStore;
  const files: Record<string, string> = {
    '.agents/rules/broken.md': '---\ncondition: [\n---\nBroken',
    '.agents/rules/nested/valid.md': '---\ncondition: FORBIDDEN\n---\nNested instruction',
    '.omp/rules/valid.md': 'Legacy duplicate',
  };
  vi.spyOn(code, 'resolveRef').mockResolvedValue('commit');
  vi.spyOn(code, 'readCommit').mockResolvedValue({ treeHash: 'root' } as NonNullable<Awaited<ReturnType<ArtifactsCodeStore['readCommit']>>>);
  const trees: Record<string, Array<{ name: string; type: 'tree' | 'blob'; hash: string }>> = {
    root: [{ name: '.agents', type: 'tree', hash: 'agents' }, { name: '.omp', type: 'tree', hash: 'omp' }],
    agents: [{ name: 'rules', type: 'tree', hash: 'rules' }],
    rules: [{ name: 'broken.md', type: 'blob', hash: 'broken' }, { name: 'nested', type: 'tree', hash: 'nested' }],
    nested: [{ name: 'valid.md', type: 'blob', hash: 'valid' }],
    omp: [{ name: 'rules', type: 'tree', hash: 'legacy' }],
    legacy: [{ name: 'valid.md', type: 'blob', hash: 'legacy-valid' }],
  };
  vi.spyOn(code, 'readTree').mockImplementation(async (_repository, tree) => trees[tree] as NonNullable<Awaited<ReturnType<ArtifactsCodeStore['readTree']>>>);
  vi.spyOn(code, 'readFile').mockImplementation(async (_repository, _commit, path) => files[path] === undefined ? null : new Blob([files[path]]));
  return { code, repository: 'project', ref: async () => 'refs/heads/main' };
}

describe('committed project rules', () => {
  it('reports a malformed rule and retains valid nested rules', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rules = await loadRuntimeRules(fixture());
      expect(rules.map(rule => [rule.name, rule.content])).toEqual([['valid', 'Nested instruction']]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('.agents/rules/broken.md'), expect.anything());
    } finally { warning.mockRestore(); }
  });

  it('resolves rule URIs by the same loaded name and precedence as rule generation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loader = createRuntimeInstructionLoader(fixture());
      expect(await loader.read('rule://valid')).toBe('---\ncondition: FORBIDDEN\n---\nNested instruction');
      await expect(loader.read('rule://missing')).rejects.toThrow('Rule not found');
      await expect(loader.read('rule://valid/../broken')).rejects.toThrow('Rules do not have subpaths');
    } finally { warning.mockRestore(); }
  });
});

describe('committed project skills', () => {
  /** inkibra core's layout: skills live in `skills/`, and `.agents/skills` links to them. */
  function symlinkedSkills() {
    const code: ArtifactsCodeStore = Object.create(ArtifactsCodeStore.prototype);
    const identity = { name: 'Fixture', email: 'fixture@example.invalid' };
    const files: Record<string, string> = {
      'skills/frontend/SKILL.md': '---\nname: frontend\ndescription: Frontend conventions\n---\nUse the design system.',
      'skills/frontend/references/tokens.md': 'Spacing tokens',
      '.agents/skills/remotion/SKILL.md': '---\ndescription: Remotion rules\n---\nRender carefully.',
    };
    const links: Record<string, string> = { 'link-frontend': '../../skills/frontend\n', 'link-docs': '../../docs', 'link-escape': '../../../outside' };
    const trees: Record<string, ArtifactsTreeEntry[]> = {
      root: [{ name: '.agents', type: 'tree', hash: 'agents', mode: '40000' }, { name: 'skills', type: 'tree', hash: 'skills', mode: '40000' }],
      agents: [{ name: 'skills', type: 'tree', hash: 'agent-skills', mode: '40000' }],
      'agent-skills': [
        { name: 'frontend', type: 'blob', hash: 'link-frontend', mode: '120000' },
        { name: 'docs', type: 'blob', hash: 'link-docs', mode: '120000' },
        { name: 'escape', type: 'blob', hash: 'link-escape', mode: '120000' },
        { name: 'remotion', type: 'tree', hash: 'remotion', mode: '40000' },
      ],
      remotion: [{ name: 'SKILL.md', type: 'blob', hash: 'remotion-skill', mode: '100644' }],
    };
    vi.spyOn(code, 'resolveRef').mockResolvedValue('commit');
    vi.spyOn(code, 'readCommit').mockResolvedValue({ hash: 'commit', treeHash: 'root', message: '', author: identity, committer: identity, parents: [], authoredAt: 0, committedAt: 0 });
    vi.spyOn(code, 'readTree').mockImplementation(async (_repository, tree) => trees[tree] ?? null);
    vi.spyOn(code, 'readBlob').mockImplementation(async (_repository, oid) => links[oid] === undefined ? null : new Blob([links[oid]]));
    vi.spyOn(code, 'readFile').mockImplementation(async (_repository, _commit, path) => files[path] === undefined ? null : new Blob([files[path]]));
    return createRuntimeInstructionLoader({ code, repository: 'project', ref: async () => 'refs/heads/main' });
  }

  it('lists and reads a skill whose directory is committed as a symlink, but none that leaves the repository', async () => {
    const loader = symlinkedSkills();
    const instructions = await loader.loadInstructions();
    expect(instructions).toContain('- frontend: Frontend conventions');
    expect(instructions).toContain('- remotion: Remotion rules');
    expect(instructions).not.toMatch(/- (docs|escape):/u);
    expect(await loader.read('skill://frontend')).toContain('Use the design system.');
    expect(await loader.read('skill://frontend/references/tokens.md')).toBe('Spacing tokens');
    await expect(loader.read('skill://escape')).rejects.toThrow('Skill not found');
  });
});
