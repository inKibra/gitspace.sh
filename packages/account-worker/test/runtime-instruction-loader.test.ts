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
