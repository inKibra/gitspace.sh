import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { parse as parseYaml } from 'yaml';
import { loadRuntimeRules } from './runtime-instructions.js';
export type RuntimeInstructionLoader = { loadInstructions(): Promise<string>; read(uri: string): Promise<string> };
export function createRuntimeInstructionLoader(options: { code: ArtifactsCodeStore; repository: string; ref(): Promise<string | null> }): RuntimeInstructionLoader {
  async function snapshot() { const ref = await options.ref(); return ref ? options.code.resolveRef(options.repository, ref) : null; }
  async function file(commit: string, path: string) { const blob = await options.code.readFile(options.repository, commit, path); if (!blob) return null; if (blob.size > 262144) throw new Error(`Instruction exceeds 256 KiB: ${path}`); return blob.text(); }
  async function skills(commit: string) {
    const metadata = await options.code.readCommit(options.repository, commit);
    if (!metadata) throw new Error('Instruction source commit unavailable');
    const pending = [{ hash: metadata.treeHash, path: '' }];
    const result: { name: string; path: string; description: string }[] = [];
    while (pending.length) {
      const directory = pending.pop()!;
      const tree = await options.code.readTree(options.repository, directory.hash);
      if (!tree) throw new Error('Instruction tree unavailable');
      for (const entry of tree) {
        const path = directory.path ? `${directory.path}/${entry.name}` : entry.name;
        if (entry.type === 'tree' && (path === '.agents' || path === '.omp' || path === '.agents/skills' || path === '.omp/skills' || path.startsWith('.agents/skills/') || path.startsWith('.omp/skills/'))) pending.push({ hash: entry.hash, path });
        else if (entry.type === 'blob' && /^(?:\.agents|\.omp)\/skills\/[^/]+\/SKILL\.md$/u.test(path)) {
          const content = await file(commit, path);
          if (content === null) throw new Error('Committed skill unavailable');
          const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
          const metadata: unknown = front ? parseYaml(front[1]!) : {};
          const description = metadata && typeof metadata === 'object' && 'description' in metadata && typeof metadata.description === 'string' ? metadata.description : '';
          result.push({ name: path.split('/').at(-2)!, path, description });
        }
      }
    }
    return result.sort((a, b) => a.path.localeCompare(b.path)).filter((item, index, all) => all.findIndex(other => other.name === item.name) === index);
  }
  return {
    async loadInstructions() {
      const commit = await snapshot(); if (!commit) return '';
      const instructions = await Promise.all(['AGENTS.md', '.agents/instructions.md', '.omp/instructions.md'].map(path => file(commit, path)));
      const available = await skills(commit);
      return [...instructions.filter((value): value is string => value !== null), available.length ? `Available project skills (read skill://NAME before using):\n${available.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    },
    async read(uri: string) {
      const match = /^(skill|rule):\/\/([A-Za-z0-9._-]+)(?:\/(.*))?$/u.exec(uri);
      if (!match) throw new Error('Invalid instruction URI');
      const commit = await snapshot(); if (!commit) throw new Error('No committed instruction source');
      if (match[1] === 'skill') {
        const skill = (await skills(commit)).find(item => item.name === match[2]);
        if (!skill) throw new Error('Skill not found');
        const suffix = match[3];
        if (suffix?.split('/').some(part => part === '..' || part === '')) throw new Error('Invalid skill subpath');
        const content = await file(commit, suffix ? `${skill.path.slice(0, -'SKILL.md'.length)}${suffix}` : skill.path);
        if (content === null) throw new Error('Skill file not found'); return content;
      }
      if (match[3]) throw new Error('Rules do not have subpaths');
      const rule = (await loadRuntimeRules({ ...options, ref: async () => commit })).find(item => item.name === match[2]);
      if (rule) { const content = await file(commit, rule.path); if (content !== null) return content; }
      throw new Error('Rule not found');
    },
  };
}
