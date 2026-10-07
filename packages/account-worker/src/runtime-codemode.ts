import { RpcTarget, type WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { canonicalJson, RuntimeCodemodeArgumentsSchema, RuntimeContentSchema, RuntimeJsonSchema, RuntimeToolResultSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { invokeMcpNamespace } from './runtime-mcp.js';
import type { RuntimeModelHelper } from './runtime-inference.js';

type Invocation = Parameters<WorkspaceRuntimeOptions['tools']['invoke']>[0];
type Options = { loader: WorkerLoader; storage: DurableObjectStorage; model: RuntimeModelHelper };
const MAX_BYTES = 65_536;
const MAX_CALLS = 128;
const callSchema = z.object({ tool: z.string().min(1), args: RuntimeJsonSchema });
const methods = z.enum(['list', 'search', 'describe', 'call']);
const models = z.enum(['completion', 'judge']);

/** One invocation owns one fresh isolate and revocable RPC capability. No host globals or network binding cross it. */
export function createCloudCodemode(options: Options) {
  options.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_codemode (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT)');
  const active = new Map<string, AbortController>();
  const saved = (id: string) => options.storage.sql.exec<{ fingerprint: string; result: string | null }>('SELECT fingerprint,result FROM runtime_codemode WHERE id=?', id).toArray()[0];
  return {
    cancel(id: string) { active.get(id)?.abort(new Error('Codemode cancelled')); },
    reconcile(id: string): RuntimeToolResult | null { const prior = saved(id); return prior?.result ? RuntimeToolResultSchema.parse(JSON.parse(prior.result)) : null; },
    async execute(input: Invocation): Promise<RuntimeToolResult> {
      const args = RuntimeCodemodeArgumentsSchema.parse(input.args);
      const fingerprint = canonicalJson({ tool: input.tool, args: input.args, conversationId: input.conversationId, taskId: input.taskId, requestId: input.requestId });
      const prior = saved(input.attemptId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('Codemode attempt identity changed');
        if (prior.result) return RuntimeToolResultSchema.parse(JSON.parse(prior.result));
        return { requestId: input.requestId, attemptId: input.attemptId, status: 'interrupted', content: [{ type: 'text', text: 'Codemode execution has unresolved effects and will not be replayed. Reconcile its durable child attempts.' }] };
      }
      input.signal?.throwIfAborted();
      options.storage.sql.exec('INSERT INTO runtime_codemode(id,fingerprint) VALUES(?,?)', input.attemptId, fingerprint);
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      active.set(input.attemptId, controller);
      const timeout = setTimeout(() => controller.abort(new Error('Codemode time limit exceeded')), args.timeoutMs);
      const cancelled = Promise.withResolvers<never>();
      const stopped = Promise.withResolvers<string>();
      const rejectCancellation = () => { stopped.resolve(controller.signal.reason instanceof Error ? controller.signal.reason.message : 'Codemode cancelled'); cancelled.reject(controller.signal.reason); };
      controller.signal.addEventListener('abort', rejectCancellation, { once: true });
      if (controller.signal.aborted) rejectCancellation();
      void cancelled.promise.catch(() => {});
      const pending = new Set<Promise<unknown>>();
      let capabilityCalls = 0;
      let childSequence = 0;
      let childCalls = 0;
      let revoked = false;
      let uncertain = false;
      const check = () => { controller.signal.throwIfAborted(); if (revoked) throw new Error('Codemode capability revoked'); if (++capabilityCalls > MAX_CALLS) throw new Error('Codemode call limit exceeded'); };
      const track = <T>(operation: () => Promise<T>): Promise<T> => {
        const promise = operation().then(value => {
          if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw new Error('Codemode tool result exceeds 64 KiB; narrow the query');
          return value;
        });
        pending.add(promise);
        void promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
      };
      const invoke = async (tool: string, raw: unknown) => {
        const request = callSchema.parse({ tool, args: raw });
        if (new TextEncoder().encode(JSON.stringify(request)).length > MAX_BYTES) throw new Error('Codemode tool arguments exceed 64 KiB');
        if (tool === 'codemode' || tool === 'agents') throw new Error('Nested codemode and subagents are unavailable in codemode');
        controller.signal.throwIfAborted();
        if (revoked) throw new Error('Codemode capability revoked');
        if (childCalls >= MAX_CALLS) throw new Error('Codemode child limit exceeded');
        if (!input.codemodeTools) throw new Error('Codemode tool calls require the durable tool permission authority');
        childCalls++;
        const id = `${input.attemptId}:child:${childSequence++}`;
        const outcome = await input.codemodeTools({ ...request, callId: id, signal: controller.signal }).catch(error => { uncertain = true; throw error; });
        switch (outcome.status) {
          case 'completed': return outcome.value;
          case 'interrupted': uncertain = true; throw new Error(outcome.error);
          case 'failed': throw new Error(outcome.error);
        }
      };
      const rpc = async (operation: () => Promise<z.infer<typeof RuntimeJsonSchema>>) => {
        try { check(); return { ok: true as const, value: await track(operation) }; }
        catch (error) { return { ok: false as const, error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) }; }
      };
      class Capabilities extends RpcTarget {
        cancelled() { return stopped.promise; }
        tool(tool: string, args: unknown) { return rpc(() => invoke(tool, args)); }
        model(operation: unknown, args: unknown) { return rpc(() => options.model({ conversationId: input.conversationId, operation: models.parse(operation), args: RuntimeJsonSchema.parse(args), signal: controller.signal })); }
        async mcp(method: unknown, args: unknown) {
          return rpc(() => invokeMcpNamespace(methods.parse(method), RuntimeJsonSchema.parse(args), async (tool, args) => {
            const content = z.array(RuntimeContentSchema).parse(await invoke(tool, args));
            const text = content.find(item => item.type === 'text');
            if (!text || text.type !== 'text') throw new Error('MCP tool omitted its result');
            return RuntimeJsonSchema.parse(JSON.parse(text.text));
          }));
        }
      }
      const capabilities = new Capabilities();
      try {
        const worker = options.loader.load({ compatibilityDate: '2026-08-27', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'], mainModule: 'sandbox.js', modules: {
          'user.js': `export default async function(tools, completion, judge, mcp, display) {\n${args.code}\n}`,
          'sandbox.js': `import run from './user.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
export default class Sandbox extends WorkerEntrypoint { async execute(capability) {
  const output = []; let bytes = 0;
  const display = value => { const text = JSON.stringify(value) ?? 'null'; bytes += new TextEncoder().encode(text).length; if (bytes > ${MAX_BYTES}) throw new Error('Codemode output limit exceeded'); output.push(text); };
  const unwrap = async pending => { const result = await pending; if (!result.ok) throw new Error(result.error); return result.value; };
  const tools = new Proxy(Object.create(null), { get: (_, name) => typeof name === 'string' ? args => unwrap(capability.tool(name, args ?? {})) : undefined });
  const mcp = Object.freeze(Object.fromEntries(['list','search','describe','call'].map(method => [method, args => unwrap(capability.mcp(method, args ?? {}))])));
  const cancelled = capability.cancelled().then(reason => { throw new Error(reason); });
  try { const value = await Promise.race([run(tools, args => unwrap(capability.model('completion', args)), args => unwrap(capability.model('judge', args)), mcp, display), cancelled]); const body = JSON.stringify({ ok: true, value: value ?? null, output }); if (new TextEncoder().encode(body).length > ${MAX_BYTES}) throw new Error('Codemode output limit exceeded'); return body; }
  catch (error) { return JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 4096) }); }
} }`,
        }, globalOutbound: null, limits: { cpuMs: 1000, subRequests: MAX_CALLS } });
        type SandboxEntrypoint = WorkerEntrypoint & { execute(capability: Capabilities): Promise<string> };
        const body = await Promise.race([worker.getEntrypoint<SandboxEntrypoint>().execute(capabilities), cancelled.promise]);
        revoked = true;
        await Promise.race([Promise.allSettled([...pending]), cancelled.promise]);
        if (uncertain) throw new Error('Codemode child effect requires reconciliation');
        if (new TextEncoder().encode(body).length > MAX_BYTES) throw new Error('Codemode output limit exceeded');
        const value = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: RuntimeJsonSchema, output: z.array(z.string()) }), z.object({ ok: z.literal(false), error: z.string() })]).parse(JSON.parse(body));
        if (!value.ok) throw new Error(value.error);
        const result: RuntimeToolResult = { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [...value.output.map(text => ({ type: 'text' as const, text })), { type: 'text', text: JSON.stringify(value.value) }] };
        options.storage.sql.exec('UPDATE runtime_codemode SET result=? WHERE id=?', JSON.stringify(result), input.attemptId);
        return result;
      } catch (error) {
        revoked = true;
        const text = error instanceof Error ? error.message : String(error);
        const result: RuntimeToolResult = controller.signal.aborted || uncertain || pending.size > 0
          ? { requestId: input.requestId, attemptId: input.attemptId, status: 'interrupted', content: [{ type: 'text', text }] }
          : { requestId: input.requestId, attemptId: input.attemptId, status: 'failed', content: [{ type: 'text', text }], error: { code: 'CODEMODE_FAILED', message: text } };
        options.storage.sql.exec('UPDATE runtime_codemode SET result=? WHERE id=?', JSON.stringify(result), input.attemptId);
        return result;
      } finally { revoked = true; controller.abort(); clearTimeout(timeout); controller.signal.removeEventListener('abort', rejectCancellation); input.signal?.removeEventListener('abort', abort); active.delete(input.attemptId); }
    },
  };
}
