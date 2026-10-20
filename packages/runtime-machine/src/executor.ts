import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { RuntimeToolDispatchSchema, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { ExecutorJournal, LocalAttachment } from './journal.js';
import { executeMachineTool, type MachineToolOptions } from './tools.js';

/** `activeChanged` fires when a command starts or ends on an attachment, so its observation can be reported. */
export type MachineExecutorOptions = MachineToolOptions & { machineId: string; journal: ExecutorJournal; activeChanged?: (attachmentId: string) => void };
type Run = { attachmentId: string; tool: string; controller: AbortController; done: Promise<RuntimeToolResult> };

/** Runs a signed dispatch on its attachment's checkout and returns the result. The same dispatch sent again (its reply
 * was lost with the relay connection) waits for the running command or answers with the result it finished with. A
 * machine restart ends running commands, and the cloud reports them as interrupted. */
export class MachineExecutor {
  private readonly running = new Map<symbol, Run>();
  private readonly attempts = new Map<string, { fingerprint: string; done: Promise<RuntimeToolResult> }>();
  constructor(private readonly options: MachineExecutorOptions) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/runtime/execute') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const raw = await request.text();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const parsed = RuntimeToolDispatchSchema.safeParse(value);
    if (!parsed.success) return new Response('Invalid execution dispatch', { status: 400 });
    const dispatch = parsed.data;
    const local = this.options.journal.attachment(dispatch.attachmentId);
    if (!local) return new Response('Attachment is not enrolled', { status: 403 });
    const supplied = request.headers.get('x-gitspace-execution-signature');
    const expected = createHmac('sha256', Buffer.from(local.executionSecret, 'base64url')).update(raw).digest();
    const signature = supplied && /^[A-Za-z0-9_-]+$/u.test(supplied) ? Buffer.from(supplied, 'base64url') : Buffer.alloc(0);
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) return new Response('Execution authentication failed', { status: 403 });
    const fingerprint = createHash('sha256').update(raw).digest('base64url');
    const finished = this.options.journal.executionResult(dispatch.attemptId);
    if (finished) return finished.fingerprint === fingerprint ? Response.json(finished.result) : Response.json({ error: 'Another command already ran with this attempt id' }, { status: 409 });
    let attempt = this.attempts.get(dispatch.attemptId);
    if (attempt && attempt.fingerprint !== fingerprint) return Response.json({ error: 'Another command is running with this attempt id' }, { status: 409 });
    if (!attempt) {
      try { this.authorize(dispatch); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
      const done = this.execute(dispatch, request.signal).then(result => {
        // A replay-safe read is simply run again; only results a replay must not repeat are kept.
        if (dispatch.replay === 'unsafe') this.options.journal.saveExecutionResult(dispatch.attemptId, fingerprint, result);
        return result;
      }).finally(() => this.attempts.delete(dispatch.attemptId));
      attempt = { fingerprint, done };
      this.attempts.set(dispatch.attemptId, attempt);
    }
    return Response.json(await attempt.done);
  }

  private authorize(dispatch: RuntimeToolDispatch): LocalAttachment {
    const local = this.options.journal.attachment(dispatch.attachmentId);
    if (!local || dispatch.machineId !== this.options.machineId || local.attachment.machineId !== dispatch.machineId || local.attachment.workspaceId !== dispatch.workspaceId || local.attachment.projectId !== dispatch.projectId || local.attachment.generation !== dispatch.generation) throw new Error('Execution attachment is stale or unauthorized');
    // Setup runs are what make a checkout ready, so they run while it is attaching too.
    const setup = dispatch.tool === 'lifecycle' && local.attachment.state === 'attaching';
    if (!setup && (local.attachment.state !== 'ready' || !local.prerequisitesComplete)) throw new Error('Attachment is not ready');
    return local;
  }

  /** Tools of the commands running on an attachment. */
  active(attachmentId: string): string[] {
    return [...this.running.values()].filter(run => run.attachmentId === attachmentId).map(run => run.tool);
  }

  /** Cancels every command running on an attachment and waits for them to stop. */
  async drain(local: LocalAttachment): Promise<void> {
    const runs = [...this.running.values()].filter(run => run.attachmentId === local.attachment.attachmentId);
    for (const run of runs) run.controller.abort();
    await Promise.allSettled(runs.map(run => run.done));
  }

  /** Runs the dispatch; `signal` (the caller's request) cancels it. Failures are results, never thrown. */
  async execute(dispatch: RuntimeToolDispatch, signal?: AbortSignal): Promise<RuntimeToolResult> {
    const identity = { requestId: dispatch.requestId, attemptId: dispatch.attemptId };
    let local: LocalAttachment;
    try { local = this.authorize(dispatch); }
    catch (error) { return { ...identity, status: 'failed', content: [], error: { code: 'rejected', message: error instanceof Error ? error.message : String(error) } }; }
    const remaining = Date.parse(dispatch.deadlineAt) - Date.now();
    if (remaining <= 0) return { ...identity, status: 'failed', content: [], error: { code: 'deadline', message: 'Execution deadline expired' } };
    const controller = new AbortController();
    const aborted = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(remaining, 2_147_483_647)), ...(signal ? [signal] : [])]);
    const done = executeMachineTool(dispatch, local, aborted, this.options).then(
      (content): RuntimeToolResult => ({ ...identity, status: 'completed', content }),
      (error: unknown): RuntimeToolResult => {
        const message = error instanceof Error ? error.message : String(error);
        return aborted.aborted ? { ...identity, status: 'interrupted', content: [{ type: 'text', text: message }] } : { ...identity, status: 'failed', content: [], error: { code: 'execution', message } };
      });
    const key = Symbol(dispatch.attemptId);
    this.running.set(key, { attachmentId: local.attachment.attachmentId, tool: dispatch.tool, controller, done });
    this.options.activeChanged?.(local.attachment.attachmentId);
    try { return await done; } finally {
      this.running.delete(key);
      this.options.activeChanged?.(local.attachment.attachmentId);
    }
  }
}
