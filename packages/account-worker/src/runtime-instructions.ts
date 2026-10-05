import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { parseRetainedRule, type RetainedRuleServices } from '@gitspace/runtime-core/retained-rules';
type RuleSource = { code: ArtifactsCodeStore; repository: string; ref(): Promise<string | null> };
export function createRuntimeRuleServices(options: RuleSource & { judge: RetainedRuleServices['judge']; matchAst: RetainedRuleServices['matchAst'] }): RetainedRuleServices {
  return { judge: options.judge, matchAst: options.matchAst, loadRules: () => loadRuntimeRules(options) };
}
export async function loadRuntimeRules(options: RuleSource) {
    const ref = await options.ref();
    if (!ref) return [];
    const commit = await options.code.resolveRef(options.repository, ref);
    if (!commit) return [];
    const metadata = await options.code.readCommit(options.repository, commit);
    if (!metadata) throw new Error('Committed rule source is unavailable');
    const pending = [{ hash: metadata.treeHash, path: '' }];
    const paths: string[] = [];
    while (pending.length) {
      const directory = pending.pop()!;
      const tree = await options.code.readTree(options.repository, directory.hash);
      if (!tree) throw new Error('Committed rule tree is unavailable');
      for (const entry of tree) {
        const path = directory.path ? `${directory.path}/${entry.name}` : entry.name;
        if (entry.type === 'tree' && (path === '.agents' || path === '.omp' || path === '.agents/rules' || path === '.omp/rules' || path.startsWith('.agents/rules/') || path.startsWith('.omp/rules/'))) pending.push({ hash: entry.hash, path });
        else if (entry.type === 'blob' && /^(?:\.agents|\.omp)\/rules\/.+\.md$/u.test(path)) paths.push(path);
      }
    }
    const seen = new Set<string>();
    const rules = [];
    for (const path of paths.sort()) {
      const blob = await options.code.readFile(options.repository, commit, path);
      if (!blob) throw new Error(`Committed rule disappeared: ${path}`);
      try {
        if (blob.size > 262144) throw new Error(`Rule exceeds 256 KiB: ${path}`);
        const rule = parseRetainedRule(path, await blob.text());
        if (!seen.has(rule.name)) { seen.add(rule.name); rules.push(rule); }
      } catch (error) { console.warn(`Skipping invalid project rule ${path}`, error); }
    }
    return rules;
}
