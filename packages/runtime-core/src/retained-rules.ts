import { defineExtension } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { AgentDefinitionContextDoc } from './subagent-state.js';
const RuleList = z.union([z.string().transform(value => [value]), z.array(z.string())]).default([]);
function listTokens(values: string[]): string[] {
  return [...new Set(values.flatMap(value => {
    const tokens: string[] = [];
    let start = 0, depth = 0, quote = '';
    for (let i = 0; i < value.length; i++) {
      const char = value[i]!;
      if (quote) { if (char === quote && value[i - 1] !== '\\') quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) depth--;
      else if (char === ',' && depth === 0) { tokens.push(value.slice(start, i)); start = i + 1; }
    }
    tokens.push(value.slice(start));
    return tokens.map(token => token.trim().replace(/^(["'])(.*)\1$/u, '$2').trim()).filter(Boolean);
  }))];
}
/** A project rule, committed as `.agents/rules/<name>.md` or `.omp/rules/<name>.md`: front matter, then the instruction.
 * The system prompt inlines an `alwaysApply` rule and names each other one with its description, to read as
 * `rule://<name>`; `agents` limits a rule to the agents it names. Other front matter is ignored. */
const RuleSchema = z.object({ name: z.string(), path: z.string(), content: z.string(), enabled: z.boolean().default(true), alwaysApply: z.boolean().default(false), description: z.string().default(''), agents: RuleList });
export type RetainedRule = z.infer<typeof RuleSchema>;
export function parseRetainedRule(path: string, content: string): RetainedRule {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  const rule = RuleSchema.parse({ ...(front ? parseYaml(front[1]!) : {}), name: path.split('/').at(-1)!.replace(/\.md$/u, ''), path, content: content.slice(front?.[0].length ?? 0) });
  rule.agents = listTokens(rule.agents).map(token => token.toLowerCase());
  return rule;
}
export type RetainedRuleServices = { loadRules(): Promise<RetainedRule[]> };
// Bun.Glob's rule syntax, without Bun or filesystem dependencies in the Worker.
// Keep braces as regex alternatives rather than expanding a Cartesian product.
function glob(pattern: string, path: string): boolean {
  let cursor = 0;
  let negate = false;
  while (pattern[cursor] === '!') { negate = !negate; cursor++; }
  const startOfPattern = cursor;
  const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const parse = (depth: number): string => {
    let source = '';
    while (cursor < pattern.length) {
      const char = pattern[cursor++]!;
      if (depth && (char === ',' || char === '}')) { cursor--; break; }
      if (char === '\\') {
        if (cursor === pattern.length) throw new Error('Trailing glob escape');
        source += escape(pattern[cursor++]!);
      } else if (char === '{') {
        if (depth === 10) throw new Error('Glob braces exceed nesting limit');
        const alternatives: string[] = [];
        do {
          alternatives.push(parse(depth + 1));
          if (cursor === pattern.length) throw new Error('Unclosed glob brace');
        } while (pattern[cursor++] === ',');
        source += `(?:${alternatives.join('|')})`;
      } else if (char === '[') {
        let content = '';
        if (pattern[cursor] === '!' || pattern[cursor] === '^') { content = '^'; cursor++; }
        let first = true;
        while (cursor < pattern.length && (first || pattern[cursor] !== ']')) {
          let member = String.fromCodePoint(pattern.codePointAt(cursor)!);
          cursor += member.length;
          if (member === '\\') {
            if (cursor === pattern.length) throw new Error('Trailing class escape');
            member = String.fromCodePoint(pattern.codePointAt(cursor)!);
            cursor += member.length;
            content += `\\u{${member.codePointAt(0)!.toString(16)}}`;
          } else content += /[\[\]^]/u.test(member) ? `\\${member}` : member;
          first = false;
        }
        if (pattern[cursor++] !== ']') throw new Error('Unclosed glob class');
        source += `[${content}]`;
      } else if (char === '*') {
        const start = cursor - 1;
        while (pattern[cursor] === '*') cursor++;
        const globstar = cursor - start > 1 && (start === startOfPattern || '/{,'.includes(pattern[start - 1]!)) && (cursor === pattern.length || '/},'.includes(pattern[cursor]!));
        if (globstar && pattern[cursor] === '/') { cursor++; source += '(?:[^/]+/)*'; }
        else source += globstar ? '[\\s\\S]*' : '[^/]*';
      } else source += char === '?' ? '[^/]' : escape(char);
    }
    return source;
  };
  try {
    const expression = new RegExp(`^(?:${parse(0)})(?![\\s\\S])`, 'u');
    const normalized = path.replaceAll('\\', '/');
    const positive = expression.test(normalized) || expression.test(normalized.slice(normalized.lastIndexOf('/') + 1));
    return negate ? !positive : positive;
  } catch {
    return false;
  }
}
export function createRetainedRulesExtension(services: RetainedRuleServices) {
  return defineExtension({ name: 'gitspace.retained-rules', sections: [{ key: 'project-rules', async render(input, context) {
    const definition = await input.read.snapshot(AgentDefinitionContextDoc, input.conversationId, context);
    const rules = (await services.loadRules()).filter(rule => rule.enabled && (!rule.agents.length || rule.agents.some(pattern => glob(pattern.toLowerCase(), (definition?.child?.definition?.name ?? definition?.child?.role ?? 'main').toLowerCase()))));
    return rules.map(rule => rule.alwaysApply ? rule.content : `Rule ${rule.name}: ${rule.description || 'Project instruction'} (read rule://${rule.name})`).join('\n\n');
  } }] });
}
