import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, GenerationTask, LiveDoc, ToolTask, hook, type Harness, type HookApi, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { canonicalJson, RuntimeRuleInterruptionSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuleGenerationDiscard, RuleInterruptionsDoc } from './rule-generations.js';
import type { Context } from '@earendil-works/chord';
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
const RuleList = z.union([z.string().transform(value => [value]), z.array(z.string())]).default([]);
function scopeTokens(values: string[]): string[] {
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
const RuleSchema = z.object({ name: z.string(), path: z.string(), content: z.string(), enabled: z.boolean().default(true), alwaysApply: z.boolean().default(false), description: z.string().default(''), agents: RuleList, condition: RuleList, astCondition: RuleList, question: z.string().optional(), scope: RuleList, globs: RuleList, interruptMode: z.enum(['never', 'prose-only', 'tool-only', 'always']).default('always'), repeatMode: z.enum(['once', 'after-gap']).default('after-gap'), repeatGap: z.number().int().nonnegative().default(10) });
export type RetainedRule = z.infer<typeof RuleSchema>;
export function parseRetainedRule(path: string, content: string): RetainedRule {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  const rule = RuleSchema.parse({ ...(front ? parseYaml(front[1]!) : {}), name: path.split('/').at(-1)!.replace(/\.md$/u, ''), path, content: content.slice(front?.[0].length ?? 0) });
  rule.scope = scopeTokens(rule.scope);
  rule.agents = scopeTokens(rule.agents).map(token => token.toLowerCase());
  const conditions: string[] = [];
  let inferred = false;
  for (const raw of rule.condition) {
    const token = raw.trim();
    if (!/[\\^$+|()]/u.test(token) && /[?*[\]{}]/u.test(token) && (token.includes('/') || /^\*\.[^\s/]+$/u.test(token))) {
      rule.scope.push(`tool:edit(${token})`, `tool:write(${token})`);
      inferred = true;
    } else conditions.push(token);
  }
  rule.condition = conditions.length ? conditions : inferred ? ['.*'] : [];
  return rule;
}
function compileCondition(pattern: string): RegExp {
  const literal = /^\/(.*)\/([dgimsuvy]*)$/u.exec(pattern);
  if (literal) return new RegExp(literal[1]!, literal[2]);
  const inline = /^\(\?([ims]+)\)/u.exec(pattern);
  return new RegExp(inline ? pattern.slice(inline[0].length) : pattern, [...new Set(inline?.[1] ?? '')].join(''));
}
export type RetainedRuleServices = {
  loadRules(conversationId: string): Promise<RetainedRule[]>;
  judge(conversationId: string, state: string, questions: Record<string, string>): Promise<Record<string, number>>;
  matchAst(conversationId: string, content: string, paths: string[], patterns: string[]): Promise<boolean>;
};
const RuleState = defineDoc<{ turn: number; claims: Record<string, number>; warnings: string[] }>({ kind: 'gitspace.rules', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ turn: 0, claims: {}, warnings: [] }) });
const RuleToolAdmissions = defineDoc<{ generation: string; calls: Record<string, string> }>({ kind: 'gitspace.rule-tool-admissions', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ generation: '', calls: {} }) });
type Output = { source: 'text' | 'thinking' | 'tool'; text: string; tool?: string; paths: string[]; ordinal?: number };
type Binding = { taskId: string; conversationId: string; harness: Harness; interrupting: boolean; check(output: Output, completed: boolean, context: Context): Promise<{ text: string; interrupt: boolean }[]>; context: Context };
const bindings = new WeakMap<AbortSignal, Binding>();
const pendingBindings = new WeakMap<Harness, Map<string, Binding>>();
export function releaseRuntimeRuleBinding(signal: AbortSignal | undefined): void {
  if (!signal) return;
  const binding = bindings.get(signal);
  bindings.delete(signal);
  if (binding) {
    const pending = pendingBindings.get(binding.harness);
    if (pending?.get(binding.conversationId) === binding) pending.delete(binding.conversationId);
  }
}
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
function inScope(rule: RetainedRule, output: Output): boolean {
  if (rule.globs.length && !rule.globs.some(pattern => output.paths.some(path => glob(pattern, path)))) return false;
  const scopes = rule.scope.length ? rule.scope : ['text', 'tool'];
  return scopes.some(scope => {
    if (scope === output.source || (scope === 'toolcall' && output.source === 'tool')) return true;
    if (output.source !== 'tool') return false;
    const match = /^(?:tool:)?([\w-]+)?(?:\(([^)]+)\))?$/u.exec(scope);
    return !!match && (!match[1] || match[1] === 'tool' || match[1] === output.tool) && (!match[2] || output.paths.some(path => glob(match[2]!, path)));
  });
}
function toolOutput(name: string, raw: Record<string, unknown>): Output {
  const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args as Record<string, unknown> : raw;
  const paths = ['path', 'file', 'file_path'].flatMap(key => typeof args[key] === 'string' ? [args[key] as string] : []);
  if (typeof args.patch === 'string') {
    for (const match of args.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gmu)) paths.push(match[1]!.trim());
  }
  const content = ['content', 'newText', 'new_string', 'new_text', 'patch', 'command'].flatMap(key => typeof args[key] === 'string' ? [args[key] as string] : []);
  if (Array.isArray(args.edits)) for (const edit of args.edits) if (edit && typeof edit === 'object') { for (const key of ['newText', 'new_string', 'new_text']) if (typeof edit[key] === 'string') content.push(edit[key]); }
  return { source: 'tool', tool: name, text: content.length ? content.join('\n') : JSON.stringify(args), paths };
}
function outputs(message: AssistantMessage): Output[] {
  return message.content.map((part, ordinal) => part.type === 'text' ? { source: 'text' as const, text: part.text, paths: [], ordinal } : part.type === 'thinking' ? { source: 'thinking' as const, text: part.thinking, paths: [], ordinal } : { ...toolOutput(part.name, part.arguments), ordinal });
}
async function createRuleBinding(services: RetainedRuleServices, getHarness: () => Harness, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, api: Pick<HookApi, 'taskId' | 'conversationId' | 'snapshot'>, context: Context): Promise<Binding> {
      const definition = await api.snapshot(AgentDefinitionContextDoc, api.conversationId, context);
      const rules = (await services.loadRules(String(api.conversationId))).filter(rule => rule.enabled && (!rule.agents.length || rule.agents.some(pattern => glob(pattern.toLowerCase(), (definition?.child?.definition?.name ?? definition?.child?.role ?? 'main').toLowerCase()))));
      const compiled = rules.map(rule => ({ rule, patterns: rule.condition.flatMap(pattern => {
        try { return [compileCondition(pattern)]; }
        catch (error) { console.warn(`Invalid condition in rule ${rule.path}: ${pattern}`, error); return []; }
      }) }));
      const binding: Binding = { taskId: String(api.taskId), conversationId: String(api.conversationId), harness: getHarness(), context, interrupting: rules.some(rule => !rule.question && rule.interruptMode !== 'never'), async check(output, completed, context) {
        const harness = getHarness();
        const state = await harness.snapshot(RuleState, api.conversationId, context);
        const candidates: RetainedRule[] = [];
        const matchers = new Map<RetainedRule, 'text' | 'ast'>();
        for (const { rule, patterns } of compiled) {
          const last = state?.claims[rule.name];
          if (!inScope(rule, output) || (last !== undefined && (last === state?.turn || rule.repeatMode === 'once' || (state?.turn ?? 0) - last < rule.repeatGap)) || (rule.question && !completed)) continue;
          let matches = patterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(output.text); });
          let matcher: 'text' | 'ast' = 'text';
          if (!matches && rule.astCondition.length && output.source === 'tool' && output.paths.length) {
            try { matches = await services.matchAst(String(api.conversationId), output.text, output.paths, rule.astCondition); }
            catch (error) { console.warn(`AST matching unavailable for rule ${rule.path}`, error); }
            if (matches) matcher = 'ast';
          }
          matchers.set(rule, matcher);
          if (matches || (rule.question && !rule.condition.length && !rule.astCondition.length)) candidates.push(rule);
        }
        if (!candidates.length) return [];
        const judged = candidates.filter(rule => rule.question);
        const verdicts = judged.length ? await services.judge(String(api.conversationId), output.text.slice(0, 60000), Object.fromEntries(judged.map(rule => [rule.name, rule.question!]))) : {};
        const selected = candidates.filter(rule => !rule.question || (verdicts[rule.name] ?? 0) >= 0.7);
        if (!selected.length) return [];
        const delivered: { text: string; interrupt: boolean }[] = [];
        const hashes = await Promise.all(selected.map(async rule => ({ revision: await digest(JSON.stringify(rule)), matched: await digest(output.text) })));
        await harness.commit(async tx => {
          const current = await tx.doc(RuleState, api.conversationId);
          for (const rule of selected) {
            const last = current.claims[rule.name];
            if (last !== undefined && (last === current.turn || rule.repeatMode === 'once' || current.turn - last < rule.repeatGap)) continue;
            const interrupt = !rule.question && (rule.interruptMode === 'always' || (rule.interruptMode === 'tool-only' && output.source === 'tool') || (rule.interruptMode === 'prose-only' && output.source !== 'tool'));
            const text = `<system-${interrupt ? 'interrupt' : 'reminder'} reason="rule_violation" rule=${JSON.stringify(rule.name)} path=${JSON.stringify(rule.path)}>\n${rule.question ? 'Rule judge flagged completed output; it was not interrupted. Check and correct any actual violation.\n' : ''}${rule.content}\n</system-${interrupt ? 'interrupt' : 'reminder'}>`;
            if (interrupt) {
              const interruptions = await tx.doc(RuleInterruptionsDoc, api.conversationId);
              if (interruptions.active?.state === 'pending') continue;
              const live = await tx.doc(LiveDoc, api.conversationId);
              const hash = hashes[selected.indexOf(rule)]!;
              interruptions.active = RuntimeRuleInterruptionSchema.parse({
                ...identity, version: 1, kind: 'rule-interruption', state: 'pending',
                conversationId: String(api.conversationId), taskId: String(api.taskId),
                runId: String(live.run?.inputs[0] ?? api.taskId), generationId: String(api.taskId),
                interruptionId: `${api.taskId}:${rule.name}`, ruleId: rule.name, ruleRevision: hash.revision,
                provenance: { source: 'project-rule', path: rule.path, matcher: matchers.get(rule) ?? 'text', output: output.source, outputOrdinal: output.ordinal ?? 0, matchedDigest: hash.matched, observedAt: new Date().toISOString() },
                instruction: text, discard: { state: 'discarded', generationId: String(api.taskId), toolCalls: 'not-dispatched' },
                continuation: { state: 'pending' },
              });
              await tx.appendEntry(api.conversationId, { kind: 'gitspace.rule-interruption', data: interruptions.active });
            } else current.warnings.push(text);
            current.claims[rule.name] = current.turn;
            await tx.appendEntry(api.conversationId, { kind: 'gitspace.rule-activation', data: { name: rule.name, path: rule.path, interrupted: interrupt, text } });
            delivered.push({ text, interrupt });
          }
        }, context);
        return delivered;
      } };
  return binding;
}

export async function admitRuntimeCodemodeTool(services: RetainedRuleServices, harness: Harness, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, call: { id: string; name: string; arguments: Record<string, unknown> }, api: ToolExecutionApi, context: Context): Promise<void> {
  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  if (!live?.run) throw new Error('Codemode requires an active generation');
  const admission = await api.snapshot(RuleToolAdmissions, api.conversationId, context);
  if (admission?.generation !== String(live.run.taskId)) throw new Error('Codemode generation admission is unavailable');
  const binding = await createRuleBinding(services, () => harness, identity, { taskId: live.run.taskId, conversationId: api.conversationId, snapshot: api.snapshot.bind(api) }, context);
  if ((await binding.check(toolOutput(call.name, call.arguments), true, context)).some(match => match.interrupt)) throw new Error('Codemode child interrupted by project rule');
  const hash = await digest(canonicalJson([call.name, call.arguments]));
  await api.commit(async tx => {
    const current = await tx.doc(RuleToolAdmissions, api.conversationId);
    const interruption = await tx.doc(RuleInterruptionsDoc, api.conversationId);
    if (current.generation !== admission.generation || interruption.active?.state === 'pending') throw new Error('Codemode generation is fenced');
    current.calls[call.id] = hash;
  }, context);
}

export function createRetainedRulesExtension(services: RetainedRuleServices, getHarness: () => Harness, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, prepareArguments: (name: string, args: Record<string, unknown>) => unknown) {
  return defineExtension({ name: 'gitspace.retained-rules', sections: [{ key: 'project-rules', async render(input, context) {
    const definition = await input.read.snapshot(AgentDefinitionContextDoc, input.conversationId, context);
    const rules = (await services.loadRules(String(input.conversationId))).filter(rule => rule.enabled && (!rule.agents.length || rule.agents.some(pattern => glob(pattern.toLowerCase(), (definition?.child?.definition?.name ?? definition?.child?.role ?? 'main').toLowerCase()))));
    return rules.map(rule => rule.alwaysApply ? rule.content : `Rule ${rule.name}: ${rule.description || 'Project instruction'} (read rule://${rule.name})`).join('\n\n');
  } }], hooks: [hook(GenerationTask, {
    async beforeRequest(_request, api, context) {
      const binding = await createRuleBinding(services, getHarness, identity, api, context);
      let scope = pendingBindings.get(getHarness());
      if (!scope) { scope = new Map(); pendingBindings.set(getHarness(), scope); }
      scope.set(String(api.conversationId), binding);
      if (!context.abortSignal) throw new Error('Rule generation requires an invocation signal');
      bindings.set(context.abortSignal, binding);
    },
    async afterResponse(message, api, context) {
      const pending = await api.snapshot(RuleInterruptionsDoc, api.conversationId, context);
      if (pending?.active?.state === 'pending' && pending.active.taskId === String(api.taskId)) return;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
      const binding = pendingBindings.get(getHarness())?.get(String(api.conversationId));
      if (!binding || binding.taskId !== String(api.taskId)) throw new Error('Rule generation binding missing');
      for (const output of outputs(message)) {
        if ((await binding.check(output, true, context)).some(match => match.interrupt)) return;
      }
      const interruption = await api.snapshot(RuleInterruptionsDoc, api.conversationId, context);
      if (interruption?.active?.state === 'pending' && interruption.active.taskId === String(api.taskId)) return;
      const approved: [string, string][] = [];
      for (const part of message.content) {
        if (part.type !== 'toolCall') continue;
        let args: unknown;
        try { args = prepareArguments(part.name, part.arguments); }
        catch { continue; } // Invalid arguments remain unadmitted; the tool parser reports the error.
        approved.push([part.id, await digest(canonicalJson([part.name, args]))]);
      }
      await getHarness().commit(async tx => {
        const state = await tx.doc(RuleState, api.conversationId); state.turn++;
        const admission = await tx.doc(RuleToolAdmissions, api.conversationId);
        admission.generation = String(api.taskId);
        admission.calls = Object.fromEntries(approved);
        const doc = await tx.doc(RuleInterruptionsDoc, api.conversationId);
        if (doc.active?.state === 'continuing' && doc.active.continuation.taskId === String(api.taskId)) {
          doc.active = RuntimeRuleInterruptionSchema.parse({ ...doc.active, state: 'resolved', continuation: { state: 'completed', generationId: String(api.taskId), taskId: String(api.taskId), completedAt: new Date().toISOString() } });
          await tx.appendEntry(api.conversationId, { kind: 'gitspace.rule-interruption', data: doc.active });
        }
      }, context);
    },
    async onYield(_answer, api, context) {
      const previous = await api.memo<string>('gitspace.rule-yield', context);
      if (previous) return { continue: previous };
      const state = await getHarness().snapshot(RuleState, api.conversationId, context);
      const warning = state?.warnings.join('\n\n');
      if (!warning) return;
      const durable = await api.memo('gitspace.rule-yield', warning, context);
      await getHarness().commit(async tx => { const current = await tx.doc(RuleState, api.conversationId); current.warnings = []; }, context);
      return { continue: durable };
    },
    async afterTools(_assistant, _results, api, context) {
      await getHarness().commit(async tx => { const state = await tx.doc(RuleState, api.conversationId); if (!state.warnings.length) return; await tx.appendEntry(api.conversationId, { kind: 'gitspace.rule-warning', model: [{ role: 'user', content: state.warnings.join('\n\n'), timestamp: Date.now() }] }); state.warnings = []; }, context);
    },
  }), hook(ToolTask, { async beforeTool(call, api, context) {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const admission = await api.snapshot(RuleToolAdmissions, api.conversationId, context);
    const interruption = await api.snapshot(RuleInterruptionsDoc, api.conversationId, context);
    if (interruption?.active?.state === 'pending') return { block: 'Generation discarded by project rule' };
    if (!admission || admission.generation !== String(live?.run?.taskId) || admission.calls[call.id] !== await digest(canonicalJson([call.name, call.arguments]))) return { block: 'Tool call lacks durable rule admission for this generation' };
  } })] });
}
export function interceptRuntimeModelStream(stream: AssistantMessageEventStream, signal: AbortSignal | undefined, controller: AbortController): AssistantMessageEventStream {
  const binding = signal ? bindings.get(signal) : undefined;
  if (!binding || !binding.interrupting) return stream;
  const result = createAssistantMessageEventStream();
  void (async () => {
    let latest: AssistantMessage | undefined;
    try {
      for await (const event of stream) {
        if ('partial' in event) latest = event.partial;
        if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
          const output = outputs(event.partial)[event.contentIndex];
          if (output && (await binding.check(output, false, binding.context)).some(match => match.interrupt)) {
            controller.abort(new RuleGenerationDiscard());
            const message: AssistantMessage = { ...event.partial, content: [], stopReason: 'aborted' };
            result.push({ type: 'error', reason: 'aborted', error: message }); result.end(message); return;
          }
        }
        if (event.type === 'done') {
          for (const output of outputs(event.message)) {
            if ((await binding.check(output, false, binding.context)).some(match => match.interrupt)) {
              controller.abort(new RuleGenerationDiscard());
              const message: AssistantMessage = { ...event.message, content: [], stopReason: 'aborted' };
              result.push({ type: 'error', reason: 'aborted', error: message }); result.end(message); return;
            }
          }
        }
        // No partial reaches Pi's durable partial writer before the entire response
        // has passed interrupting rules (including full-message-only providers).
        if (event.type === 'done' || event.type === 'error') result.push(event);
      }
      result.end(await stream.result());
    } catch (error) {
      controller.abort(error);
      if (latest) { const message: AssistantMessage = { ...latest, stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error) }; result.push({ type: 'error', reason: 'error', error: message }); result.end(message); }
      else { const message = await stream.result(); result.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: String(error) } }); result.end(message); }
    }
  })();
  return result;
}
