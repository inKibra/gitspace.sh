import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { RuntimeContentSchema, RuntimeJsonSchema, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { ApplyPatchArgumentsSchema, prepareV4APatch, RuntimeReadArgumentsSchema, RuntimeWriteArgumentsSchema, RuntimeEditArgumentsSchema, RuntimeBashCommandArgumentsSchema, RuntimeFindArgumentsSchema, RuntimeGrepArgumentsSchema, RuntimeAstGrepArgumentsSchema, RuntimeAstEditArgumentsSchema, RuntimeAstResolveArgumentsSchema, RuntimeCodemodeArgumentsSchema } from '@gitspace/protocol-runtime';
import type { LocalAttachment, ExecutorJournal } from './journal.js';
import { proposalPath, stageProposal, resolveProposal } from './ast-proposals.js';
import { ExecutorEffectUncertain, type RunExecutorCommand } from './commands.js';
import { machineRipgrepPath } from '../../deployment/src/native-runtime.js';

export type ExecutorContent = z.infer<typeof RuntimeContentSchema>[];
export type ExecutorArtifactAccess = { read(uri: string, signal: AbortSignal): Promise<ExecutorContent>; write(uri: string, content: string, signal: AbortSignal): Promise<void> };
export type ExecutorCloudModelProxy = (input: { dispatch: RuntimeToolDispatch; operation: 'completion' | 'judge'; args: z.infer<typeof RuntimeJsonSchema>; signal: AbortSignal }) => Promise<z.infer<typeof RuntimeJsonSchema>>;
export type ExecutorCloudMcpProxy = (input: { dispatch: RuntimeToolDispatch; callId: string; method: 'list' | 'search' | 'describe' | 'call'; args: z.infer<typeof RuntimeJsonSchema>; signal: AbortSignal }) => Promise<z.infer<typeof RuntimeJsonSchema>>;
export type ExecutorOperationHandler = (dispatch: RuntimeToolDispatch, local: LocalAttachment, signal: AbortSignal) => Promise<ExecutorContent>;
export type MachineToolOptions = { journal?: ExecutorJournal; runCommand: RunExecutorCommand; artifacts: (attachment: LocalAttachment) => ExecutorArtifactAccess; cloudModel: ExecutorCloudModelProxy; cloudMcp: ExecutorCloudMcpProxy; operations?: Record<string, ExecutorOperationHandler> };
const ProposalSchema = z.object({ changes: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })) });

export async function checkoutPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, path);
  const rel = relative(canonicalRoot, candidate);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path leaves authorized checkout');
  let parent = candidate;
  for (;;) {
    try {
      const resolved = await realpath(parent);
      const fromRoot = relative(canonicalRoot, resolved);
      if (fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) throw new Error('Symlink leaves authorized checkout');
      return candidate;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

export async function executeMachineTool(dispatch: RuntimeToolDispatch, local: LocalAttachment, signal: AbortSignal, options: MachineToolOptions): Promise<ExecutorContent> {
  const env = new NodeExecutionEnv({ cwd: local.rootPath });
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  let sequence = 0;
  const command = (application: string, args: string[], cwd = local.rootPath) => options.runCommand({ application, args, cwd, attemptId: dispatch.attemptId, sequence: sequence++, deadlineAt: dispatch.deadlineAt, signal });
  const text = (value: string): ExecutorContent => [{ type: 'text', text: value }];
  const read = async (path: string) => {
    const result = await env.readTextFile(await checkoutPath(local.rootPath, path), context);
    if (!result.ok) throw result.error;
    return result.value;
  };
  const write = async (path: string, content: string) => {
    if (signal.aborted) throw new Error('Execution aborted');
    const target = await checkoutPath(local.rootPath, path);
    await mkdir(dirname(target), { recursive: true });
    const result = await env.writeFile(target, content, context);
    if (!result.ok) throw result.error;
  };
  switch (dispatch.tool) {
    case 'read': {
      const args = RuntimeReadArgumentsSchema.parse(dispatch.args);
      if (args.path.startsWith('local://') || args.path.startsWith('artifact://')) return options.artifacts(local).read(args.path, signal);
      const path = await checkoutPath(local.rootPath, args.path);
      const binary = await env.readBinaryFile(path, context);
      if (!binary.ok) throw binary.error;
      const data = binary.value;
      const mimeType = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 ? 'image/png' : data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : Buffer.from(data.subarray(0, 6)).toString().startsWith('GIF8') ? 'image/gif' : Buffer.from(data.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(data.subarray(8, 12)).toString() === 'WEBP' ? 'image/webp' : null;
      if (mimeType) return [{ type: 'image', data: Buffer.from(data).toString('base64'), mimeType }];
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (args.offset === undefined && args.limit === undefined) return text(content);
      const start = (args.offset ?? 1) - 1;
      return text(content.split('\n').slice(start, args.limit === undefined ? undefined : start + args.limit).join('\n'));
    }
    case 'write': {
      const args = RuntimeWriteArgumentsSchema.parse(dispatch.args);
      if (args.path.startsWith('local://') || args.path.startsWith('artifact://')) await options.artifacts(local).write(args.path, args.content, signal);
      else await write(args.path, args.content);
      return text(`Wrote ${args.path}`);
    }
    case 'edit': {
      const args = RuntimeEditArgumentsSchema.parse(dispatch.args);
      const original = await read(args.path);
      const replacements = args.edits.map(edit => {
        const index = original.indexOf(edit.oldText);
        if (index < 0 || original.indexOf(edit.oldText, index + 1) >= 0) throw new Error('Edit text must match exactly once');
        return { ...edit, index };
      }).sort((a, b) => a.index - b.index);
      let end = 0, output = '';
      for (const edit of replacements) {
        if (edit.index < end) throw new Error('Edit ranges overlap');
        output += original.slice(end, edit.index) + edit.newText; end = edit.index + edit.oldText.length;
      }
      await write(args.path, output + original.slice(end));
      return text(`Edited ${args.path}`);
    }
    case 'apply_patch': {
      const { patch } = ApplyPatchArgumentsSchema.parse(dispatch.args);
      const changes = await prepareV4APatch(patch, { read, exists: async path => { const result = await env.exists(await checkoutPath(local.rootPath, path), context); if (!result.ok) throw result.error; return result.value; } });
      for (const change of changes) {
        await checkoutPath(local.rootPath, change.path);
        if (change.destination) await checkoutPath(local.rootPath, change.destination);
      }
      for (const change of changes) {
        if (signal.aborted) throw new Error('Patch interrupted; effects may be partial');
        if (change.after !== null) await write(change.destination ?? change.path, change.after);
        if (change.after === null || change.destination) await rm(await checkoutPath(local.rootPath, change.path));
      }
      return text(changes.map(change => `${change.after === null ? 'Deleted' : change.before === null ? 'Added' : 'Updated'} ${change.destination ?? change.path}`).join('\n'));
    }
    case 'bash': {
      if (dispatch.args && typeof dispatch.args === 'object' && !Array.isArray(dispatch.args) && 'op' in dispatch.args) {
        const operation = options.operations?.bash;
        if (!operation) throw new Error('Background command controls are unavailable');
        return operation(dispatch, local, signal);
      }
      const args = RuntimeBashCommandArgumentsSchema.parse(dispatch.args);
      const result = await command('/bin/bash', ['-c', args.command], args.cwd ? await checkoutPath(local.rootPath, args.cwd) : local.rootPath);
      return text(`Exit code: ${result.exitCode}\n${result.output}`);
    }
    case 'grep': {
      const args = RuntimeGrepArgumentsSchema.parse(dispatch.args);
      const path = await checkoutPath(local.rootPath, args.path);
      const result = await command(machineRipgrepPath(), ['--line-number', '--no-heading', ...(args.glob ? ['--glob', args.glob] : []), '--', args.pattern, path]);
      if (result.exitCode > 1) throw new Error(result.output);
      return text(result.output);
    }
    case 'find': {
      const args = RuntimeFindArgumentsSchema.parse(dispatch.args);
      const path = await checkoutPath(local.rootPath, args.path);
      const argv = ['--files', '--hidden', '--glob', args.pattern, '--', path];
      const result = await command(machineRipgrepPath(), argv);
      if (result.exitCode > 1) throw new Error(result.output);
      return text(result.output);
    }
    case 'ast_grep': {
      const args = RuntimeAstGrepArgumentsSchema.parse(dispatch.args);
      const result = await command('ast-grep', ['run', '--json', '--pattern', args.pattern, ...(args.language ? ['--lang', args.language] : []), await checkoutPath(local.rootPath, args.path)]);
      if (result.exitCode > 1) throw new Error(result.output);
      return text(result.output);
    }
    case 'rule_match_ast': {
      const args = z.object({ content: z.string().optional(), paths: z.array(z.string()).min(1), patterns: z.array(z.string()).min(1) }).parse(dispatch.args);
      const languages: Record<string, string> = { '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.sh': 'bash', '.json': 'json', '.html': 'html', '.css': 'css', '.yml': 'yaml', '.yaml': 'yaml' };
      const directory = args.content === undefined ? null : await mkdtemp(join(tmpdir(), 'gitspace-rule-'));
      try {
        for (const path of args.paths) {
          const language = languages[extname(path).toLowerCase()];
          if (!language) continue;
          let input = await checkoutPath(local.rootPath, path);
          if (directory !== null) {
            input = join(directory, `source${extname(path)}`);
            await writeFile(input, args.content!, { mode: 0o600 });
          }
          for (const pattern of args.patterns) {
            const result = await command('ast-grep', ['run', '--json', '--lang', language, '--pattern', pattern, input]);
            if (result.exitCode > 1) { console.warn(`Unsupported AST rule pattern for ${language}`, result.output); continue; }
            if (result.exitCode === 0 && z.array(z.unknown()).parse(JSON.parse(result.output)).length > 0) return text('{"matched":true}');
          }
        }
        return text('{"matched":false}');
      } finally { if (directory !== null) await rm(directory, { recursive: true, force: true }); }
    }
    case 'ast_edit': {
      if (!options.journal) throw new Error('AST proposals require durable executor storage');
      const args = RuntimeAstEditArgumentsSchema.parse(dispatch.args);
      const changes: z.infer<typeof ProposalSchema>['changes'] = [];
      const directory = await mkdtemp(join(tmpdir(), 'gitspace-ast-'));
      try {
        for (const path of args.paths) {
          const absolute = await proposalPath(local.rootPath, path), before = await read(path);
          let after = before;
          for (const op of args.ops) {
            const scratch = join(directory, `source${extname(path)}`);
            await writeFile(scratch, after, { mode: 0o600 });
            const result = await command('ast-grep', ['run', '--lang', args.language, '--pattern', op.pat, '--rewrite', op.out, '--update-all', scratch]);
            if (result.exitCode > 1) throw new Error(result.output);
            after = await readFile(scratch, 'utf8');
          }
          if (before !== after) changes.push({ path: absolute, before, after });
        }
        const proposalId = stageProposal(options.journal, local, dispatch.attemptId, changes);
        return text(JSON.stringify({ proposalId, changes }));
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    case 'ast_resolve': {
      if (!options.journal) throw new Error('AST proposals require durable executor storage');
      const args = RuntimeAstResolveArgumentsSchema.parse(dispatch.args);
      return text(`Proposal ${await resolveProposal(options.journal, local, args.proposalId, args.action, signal)}`);
    }
    case 'codemode': {
      const args = RuntimeCodemodeArgumentsSchema.parse(dispatch.args);
      const pending = new Set<Promise<unknown>>();
      let uncertain: ExecutorEffectUncertain | undefined;
      const track = <T>(operation: () => Promise<T>, mutationProxy = false): Promise<T> => {
        const running = Promise.resolve().then(operation).catch((error: unknown) => {
          if (error instanceof ExecutorEffectUncertain || mutationProxy) uncertain ??= new ExecutorEffectUncertain('Codemode child effect requires reconciliation', { cause: error });
          throw error;
        });
        pending.add(running);
        void running.then(() => pending.delete(running), () => pending.delete(running));
        return running;
      };
      const sandbox = new CodemodeSandbox({
        timeoutMs: Math.max(1, Date.parse(dispatch.deadlineAt) - Date.now()),
        tools: ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find'].map(tool => ({ name: tool, execute: (input, call) => track(() => executeMachineTool({ ...dispatch, tool, args: RuntimeJsonSchema.parse(input), attemptId: `${dispatch.attemptId}:eval:${sequence++}` }, local, call.signal, options)) })),
        globals: [
          ...(['completion', 'judge'] as const).map(operation => ({ name: operation, execute: (input: unknown, call: { signal: AbortSignal }) => track(() => options.cloudModel({ dispatch, operation, args: RuntimeJsonSchema.parse(input), signal: call.signal })) })),
          ...(['list', 'search', 'describe', 'call'] as const).map(method => ({ name: `mcp.${method}`, execute: (input: unknown, call: { signal: AbortSignal }) => track(() => options.cloudMcp({ dispatch, callId: String(sequence++), method, args: RuntimeJsonSchema.parse(input ?? {}), signal: call.signal }), method === 'call') })),
        ],
      });
      try {
        const result = await sandbox.execute(args.code, { signal });
        if (!result.ok) throw new Error(result.error.message);
        return [...result.output, ...text(JSON.stringify(result.value) ?? '')];
      } finally {
        try { await sandbox.close(); }
        finally {
          // Pi serializes callback errors and does not await aborted callbacks. Keep
          // host evidence outside that boundary, including script-caught errors.
          await Promise.allSettled([...pending]);
          if (uncertain) throw uncertain;
        }
      }
    }
    default: {
      const operation = options.operations?.[dispatch.tool];
      if (!operation) throw new Error(`Unsupported machine tool: ${dispatch.tool}`);
      return operation(dispatch, local, signal);
    }
  }
}
