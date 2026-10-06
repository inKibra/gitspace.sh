import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, dispatchIdentity, receiptDigest, sealReceipt, RuntimeReceiptTransportSchema, RuntimeReceiptControlSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema, RuntimeGitCheckpointSchema, type RuntimeReceiptTransport, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { RuntimeBashCommandArgumentsSchema, isSubagentToolCallAllowed, runtimeOperationIsReadOnly } from '@gitspace/protocol-runtime';
import { ExecutorJournal, dispatchFingerprint, type LocalAttachment } from './journal.js';
import { checkoutPath, executeMachineTool, type ExecutorContent, type MachineToolOptions } from './tools.js';
import { z } from 'zod';
import { ExecutorEffectUncertain, reconcileSupervisorCommand } from './commands.js';

export type MachineExecutorOptions = MachineToolOptions & { machineId: string; journal: ExecutorJournal; onBeforeExecute?: (local: LocalAttachment, dispatch: RuntimeToolDispatch) => Promise<void>; onMutationSettled?: (local: LocalAttachment) => Promise<z.infer<typeof RuntimeGitCheckpointSchema> | null> };
export class MachineExecutor {
  private readonly active = new Map<string, Promise<RuntimeToolResult>>();
  private readonly checkoutQueues = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly executing = new Set<string>();
  constructor(private readonly options: MachineExecutorOptions) {}

  async withCheckout<T>(local: LocalAttachment, operation: () => Promise<T>): Promise<T> {
    const prior = this.checkoutQueues.get(local.rootPath) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(operation);
    this.checkoutQueues.set(local.rootPath, pending);
    try { return await pending; }
    finally { if (this.checkoutQueues.get(local.rootPath) === pending) this.checkoutQueues.delete(local.rootPath); }
  }

  private async finishMutation(local: LocalAttachment, dispatch: RuntimeToolDispatch, result: RuntimeToolResult): Promise<RuntimeToolResult> {
    this.options.journal.saveProposal(`replica-result:${dispatch.attemptId}`, result);
    let checkpoint: z.infer<typeof RuntimeGitCheckpointSchema> | null;
    try { checkpoint = await this.options.onMutationSettled?.(local) ?? null; }
    catch (error) { throw new ExecutorEffectUncertain(`Command completed; snapshot acceptance requires reconciliation: ${error instanceof Error ? error.message : String(error)}`); }
    if (dispatch.tool === 'checkpoint' && !checkpoint) throw new ExecutorEffectUncertain('Checkpoint publication did not return accepted snapshot evidence');
    if (dispatch.tool === 'checkpoint' && checkpoint) result = { ...result, content: [{ type: 'text', text: JSON.stringify({ checkpoint }) }] };
    if (checkpoint?.conflicts?.length) result = { ...result, content: [...result.content, { type: 'text', text: `Workspace merge conflicts: ${checkpoint.conflicts.join(', ')}` }] };
    this.options.journal.settle(dispatch, result);
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/runtime/execute' && path !== '/runtime/receipt') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const raw = await request.text();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const control = path === '/runtime/receipt' ? RuntimeReceiptControlSchema.safeParse(value) : null;
    const parsed = RuntimeToolDispatchSchema.safeParse(control?.success ? control.data.dispatch : value);
    if (!parsed.success || (control && !control.success)) return new Response('Invalid execution dispatch', { status: 400 });
    const dispatch = parsed.data;
    const local = this.options.journal.attachment(dispatch.attachmentId);
    if (!local) return new Response('Attachment is not enrolled', { status: 403 });
    const supplied = request.headers.get('x-gitspace-execution-signature');
    const expected = createHmac('sha256', Buffer.from(local.executionSecret, 'base64url')).update(raw).digest();
    const signature = supplied && /^[A-Za-z0-9_-]+$/u.test(supplied) ? Buffer.from(supplied, 'base64url') : Buffer.alloc(0);
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) return new Response('Execution authentication failed', { status: 403 });
    try {
      if (control?.success) {
        this.authorize(dispatch, true);
        if (control.data.op === 'cancel') {
          this.options.journal.fence(dispatch);
          this.controllers.get(dispatch.attemptId)?.abort();
        }
        const envelope = await this.observe(dispatch, control.data.op === 'cancel');
        if (control.data.op === 'ack') {
          const ack = control.data.acknowledgement;
          if (!ack || envelope.receipt.state !== 'terminal' || ack.receiptId !== envelope.receipt.receiptId || canonicalJson(ack.dispatch) !== canonicalJson(envelope.receipt.dispatch) || ack.receiptDigest !== await receiptDigest(envelope.receipt)) throw new Error('Acknowledgement does not match receipt');
          this.options.journal.acknowledge(dispatch);
        }
        return Response.json(envelope);
      }
      try { await this.execute(dispatch); } catch (error) { if (!(error instanceof ExecutorEffectUncertain)) throw error; }
      return Response.json(await this.observe(dispatch));
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
  }
  private authorize(dispatch: RuntimeToolDispatch, recovery: boolean): LocalAttachment {
    if (dispatch.conversationKind === 'subagent' && !isSubagentToolCallAllowed(dispatch.tool, dispatch.args)) throw new Error('Subagent execution is read-only');
    const local = this.options.journal.attachment(dispatch.attachmentId);
    if (!local || dispatch.machineId !== this.options.machineId || local.attachment.machineId !== dispatch.machineId || local.attachment.workspaceId !== dispatch.workspaceId || local.attachment.projectId !== dispatch.projectId || local.attachment.generation !== dispatch.generation) throw new Error('Execution attachment is stale or unauthorized');
    if (local.attachment.state !== 'ready' && !(recovery && ['draining', 'lost', 'detached'].includes(local.attachment.state))) throw new Error('Attachment is not accepting execution');
    const previous = this.options.journal.attempt(dispatch.attemptId);
    if (previous && previous.fingerprint !== dispatchFingerprint(dispatch)) throw new Error('Attempt identity conflicts with prior dispatch');
    return local;
  }
  async drain(local: LocalAttachment): Promise<void> {
    if (this.options.journal.attachment(local.attachment.attachmentId)?.attachment.state !== 'draining') throw new Error('Executor drain requires a durable attachment fence');
    const attempts = this.options.journal.unresolved(local.attachment);
    for (const attempt of attempts) {
      this.options.journal.fence(attempt.dispatch);
      this.controllers.get(attempt.dispatch.attemptId)?.abort();
    }
    await Promise.allSettled(attempts.flatMap(attempt => {
      const running = this.active.get(attempt.dispatch.attemptId);
      return running ? [running] : [];
    }));
    for (const attempt of this.options.journal.unresolved(local.attachment)) await this.observe(attempt.dispatch, true);
    if (this.options.journal.unresolved(local.attachment).length) throw new Error('Attachment drain has unresolved executor effects');
  }
  async observe(dispatch: RuntimeToolDispatch, cancel = false): Promise<RuntimeReceiptTransport> {
    const local = this.authorize(dispatch, true);
    const attempt = this.options.journal.attempt(dispatch.attemptId);
    const staged = this.options.journal.proposal(`replica-result:${dispatch.attemptId}`);
    if (staged && !attempt?.result && !this.active.has(dispatch.attemptId)) {
      const result = await this.withCheckout(local, () => this.finishMutation(local, dispatch, RuntimeToolResultSchema.parse(staged)));
      return this.options.journal.saveReceipt(dispatch, await sealReceipt(dispatch, result, local.executionSecret));
    }
    if (attempt?.state === 'running' && !this.active.has(dispatch.attemptId) && dispatch.tool === 'bash') {
      try {
        const parsed = RuntimeBashCommandArgumentsSchema.safeParse(dispatch.args);
        if (parsed.success) {
          const args = parsed.data;
          const cancelRequested = cancel || attempt.cancelRequested === true;
          const recovered = await reconcileSupervisorCommand({ application: '/bin/bash', args: ['-c', args.command], cwd: args.cwd ? await checkoutPath(local.rootPath, args.cwd) : local.rootPath, attemptId: dispatch.attemptId, sequence: 0 }, cancelRequested);
          if (recovered) {
            const outcome: RuntimeToolResult = { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: cancelRequested ? 'interrupted' : 'completed', content: [{ type: 'text', text: `Exit code: ${recovered.exitCode}\n${recovered.output}` }] };
            const result = await this.withCheckout(local, () => this.finishMutation(local, dispatch, outcome));
            return this.options.journal.saveReceipt(dispatch, await sealReceipt(dispatch, result, local.executionSecret));
          }
        }
      } catch { /* Missing or conflicting supervisor evidence cannot authorize replay or settlement. */ }
    }
    if (attempt?.receipt) return attempt.receipt;
    if (attempt?.result) return this.options.journal.saveReceipt(dispatch, await sealReceipt(dispatch, attempt.result, local.executionSecret));
    const base = { version: 1 as const, receiptId: crypto.randomUUID(), dispatch: await dispatchIdentity(dispatch), observedAt: new Date().toISOString() };
    return RuntimeReceiptTransportSchema.parse({ receipt: attempt?.state === 'fenced'
      ? { ...base, state: 'fenced-not-started', evidence: { kind: 'durable-launch-barrier', fenceGeneration: dispatch.generation, recordedAt: base.observedAt, launchPrevented: true } }
      : this.active.has(dispatch.attemptId)
        ? this.executing.has(dispatch.attemptId) ? { ...base, state: 'running', startedAt: base.observedAt } : { ...base, state: 'starting', claimedAt: base.observedAt }
        : { ...base, state: 'unknown', reason: attempt ? 'recovered-without-evidence' : 'receipt-missing' } });
  }

  async execute(dispatch: RuntimeToolDispatch): Promise<RuntimeToolResult> {
    const local = this.authorize(dispatch, false);
    if (!local.prerequisitesComplete) throw new Error('Executor checkout prerequisites have not completed');
    if (!local.attachment.capabilities.includes(dispatch.tool)) throw new Error('Attachment does not permit this tool');
    if (!runtimeOperationIsReadOnly(dispatch.tool, dispatch.args) && dispatch.tool !== 'rule_match_ast' && dispatch.replay !== 'unsafe') throw new Error('Effectful tools require unsafe replay classification');
    const previous = this.options.journal.attempt(dispatch.attemptId);
    if (previous?.result) return previous.result;
    const running = this.active.get(dispatch.attemptId);
    if (running) return running;
    if (previous) throw new ExecutorEffectUncertain('Prior claim cannot be relaunched; reconcile its receipt');
    if (Date.parse(dispatch.deadlineAt) <= Date.now()) throw new Error('Execution deadline expired');
    let parentController: AbortController | undefined;
    if (dispatch.parentAttemptId !== undefined) {
      const parent = this.options.journal.attempt(dispatch.parentAttemptId);
      parentController = this.controllers.get(dispatch.parentAttemptId);
      if ((dispatch.tool !== 'mcp_discover' && dispatch.tool !== 'mcp_invoke') || !parent || parent.state !== 'running'
        || parent.dispatch.tool !== 'codemode' || parent.dispatch.parentAttemptId !== undefined
        || parent.dispatch.attachmentId !== dispatch.attachmentId || parent.dispatch.generation !== dispatch.generation
        || parent.dispatch.projectId !== dispatch.projectId || parent.dispatch.workspaceId !== dispatch.workspaceId
        || parent.dispatch.conversationId !== dispatch.conversationId || parent.dispatch.taskId !== dispatch.taskId
        || parent.dispatch.machineId !== dispatch.machineId || !this.executing.has(dispatch.parentAttemptId)
        || !parentController || parentController.signal.aborted || Date.parse(dispatch.deadlineAt) > Date.parse(parent.dispatch.deadlineAt)) {
        throw new Error('Nested dispatch is not an active admitted codemode MCP child');
      }
    }
    const jobControl = this.options.journal.jobControl(dispatch);
    this.options.journal.begin(dispatch);
    const controller = new AbortController();
    this.controllers.set(dispatch.attemptId, controller);
    const parentSignal = parentController?.signal;
    const abortChild = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', abortChild, { once: true });
    if (parentSignal?.aborted) abortChild();
    const bypassQueue = parentController !== undefined || jobControl !== null;
    const prior = bypassQueue ? Promise.resolve() : this.checkoutQueues.get(local.rootPath) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(async (): Promise<RuntimeToolResult> => {
      if (this.options.journal.attempt(dispatch.attemptId)?.state === 'fenced') throw new ExecutorEffectUncertain('Durable launch barrier prevented execution');
      // A rejected predecessor releases the promise queue, not its durable execution claim.
      // Starting successors cannot own effects yet and must not block one another.
      if (!bypassQueue && this.options.journal.hasRunningCheckout(local.rootPath)) {
        this.options.journal.fence(dispatch);
        throw new ExecutorEffectUncertain('Unresolved checkout execution prevents another launch');
      }
      const duration = Date.parse(dispatch.deadlineAt) - Date.now();
      if (duration <= 0 || controller.signal.aborted) {
        const result: RuntimeToolResult = { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'failed', content: [], error: { code: 'deadline', message: 'Execution deadline expired while queued' } };
        this.options.journal.settle(dispatch, result); return result;
      }
      const timer = setTimeout(() => controller.abort(), Math.min(duration, 2_147_483_647));
      try {
        const current = this.options.journal.attachment(dispatch.attachmentId);
        if (!current || current.attachment.generation !== dispatch.generation || current.attachment.state !== 'ready') throw new Error('Attachment changed before execution');
        if (!bypassQueue) await this.options.onBeforeExecute?.(current, dispatch);
        if (!this.options.journal.launch(dispatch)) throw new ExecutorEffectUncertain('Durable launch barrier prevented execution');
        this.executing.add(dispatch.attemptId);
        let content: ExecutorContent;
        try {
          if (dispatch.tool === 'checkpoint') {
            if (!this.options.onMutationSettled || !['primary', 'replica'].includes(current.attachment.role)) throw new Error('Checkpoint requires a cloud-following replica publisher');
            content = [];
          } else content = await executeMachineTool(dispatch, current, controller.signal, this.options);
        }
        catch (error) {
          if (error instanceof ExecutorEffectUncertain) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const failure: RuntimeToolResult = controller.signal.aborted
            ? { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'interrupted', content: [{ type: 'text', text: message }] }
            : { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'failed', content: [], error: { code: 'execution', message } };
          if (!jobControl && dispatch.replay === 'unsafe') return await this.finishMutation(current, dispatch, failure);
          throw error;
        }
        const result: RuntimeToolResult = { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'completed', content };
        if (!jobControl && dispatch.replay === 'unsafe') return await this.finishMutation(current, dispatch, result);
        this.options.journal.settle(dispatch, result); return result;
      } catch (error) {
        if (error instanceof ExecutorEffectUncertain) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const result: RuntimeToolResult = controller.signal.aborted
          ? { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'interrupted', content: [{ type: 'text', text: message }] }
          : { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'failed', content: [], error: { code: 'execution', message } };
        // The same attempt always returns this outcome, including partial-effect failures.
        this.options.journal.settle(dispatch, result); return result;
      } finally { this.executing.delete(dispatch.attemptId); clearTimeout(timer); }
    });
    this.active.set(dispatch.attemptId, pending);
    if (!bypassQueue) this.checkoutQueues.set(local.rootPath, pending);
    try { return await pending; }
    finally {
      parentSignal?.removeEventListener('abort', abortChild);
      this.active.delete(dispatch.attemptId); this.controllers.delete(dispatch.attemptId);
      if (this.checkoutQueues.get(local.rootPath) === pending) this.checkoutQueues.delete(local.rootPath);
    }
  }
}
