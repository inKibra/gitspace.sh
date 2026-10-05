import { describe, expect, test } from 'bun:test';
import { RuntimeExecutorReceiptSchema, RuntimeJobObservationSchema, RuntimeReceiptAcknowledgementSchema, RuntimeRuleInterruptionSchema, RuntimeScopedDispatchSchema } from './index.js';

const timestamp = '2026-10-03T00:00:00.000Z';
const digest = 'a'.repeat(64);
const dispatch = { projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: 3, conversationId: 'conversation', taskId: 'task', requestId: 'request', attemptId: 'attempt', fingerprint: { algorithm: 'sha256', encoding: 'rfc8785', digest } };
const receipt = { version: 1, receiptId: 'receipt', dispatch, observedAt: timestamp };
const output = { objectId: 'encrypted-object', encryption: { algorithm: 'AES-256-GCM', keyId: 'key', nonce: 'b'.repeat(24), tag: 'c'.repeat(32) }, ciphertext: { sha256: digest, bytes: 300 }, plaintext: { sha256: digest, bytes: 300, encoding: 'runtime-tool-result-json-v1' } };
const terminal = { ...receipt, state: 'terminal', completedAt: timestamp, result: { status: 'completed', requestId: 'request', attemptId: 'attempt', content: [{ type: 'text', text: 'complete output' }] }, output };
const job = { projectId: 'project', workspaceId: 'workspace', jobId: 'job', taskId: 'task', conversationId: 'conversation', requestId: 'request' };
const interruption = { version: 1, kind: 'rule-interruption', projectId: 'project', workspaceId: 'workspace', conversationId: 'conversation', taskId: 'task', runId: 'run', generationId: 'generation', interruptionId: 'interruption', ruleId: 'rule', ruleRevision: digest, provenance: { source: 'project-rule', path: '.gitspace/rules/no-secrets.md', matcher: 'text', output: 'tool', outputOrdinal: 2, matchedDigest: digest, observedAt: timestamp }, instruction: 'Do not reveal secrets', discard: { state: 'discarded', generationId: 'generation', toolCalls: 'not-dispatched' }, state: 'pending', continuation: { state: 'pending' } };

describe('scoped executor contracts', () => {
  test('requires the full scoped dispatch while retaining current tool wire fields', () => {
    const { fingerprint: _, ...scope } = dispatch;
    const input = { ...scope, version: 1, tool: 'bash', args: { command: 'true' }, replay: 'unsafe', deadlineAt: timestamp };
    expect(RuntimeScopedDispatchSchema.safeParse(input).success).toBe(true);
    expect(RuntimeScopedDispatchSchema.safeParse({ ...input, conversationId: undefined }).success).toBe(false);
    expect(RuntimeScopedDispatchSchema.safeParse({ ...input, deadlineAt: 'tomorrow' }).success).toBe(false);
  });

  test('absence and starting evidence never claim fenced nonexecution', () => {
    const unknown = { ...receipt, state: 'unknown', reason: 'receipt-missing' };
    expect(RuntimeExecutorReceiptSchema.parse(unknown).state).toBe('unknown');
    expect(RuntimeExecutorReceiptSchema.parse({ ...receipt, state: 'starting', claimedAt: timestamp }).state).toBe('starting');
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...unknown, state: 'fenced-not-started' }).success).toBe(false);
    const fenced = { ...receipt, state: 'fenced-not-started', evidence: { kind: 'durable-launch-barrier', fenceGeneration: 3, recordedAt: timestamp, launchPrevented: true } };
    expect(RuntimeExecutorReceiptSchema.parse(fenced).state).toBe('fenced-not-started');
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...fenced, evidence: { ...fenced.evidence, fenceGeneration: 2 } }).success).toBe(false);
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...fenced, evidence: { ...fenced.evidence, launchPrevented: false } }).success).toBe(false);
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...unknown, evidence: fenced.evidence }).success).toBe(false);
  });

  test('terminal evidence binds result identity and requires encrypted integrity metadata', () => {
    expect(RuntimeExecutorReceiptSchema.parse(terminal).state).toBe('terminal');
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...terminal, result: { ...terminal.result, attemptId: 'another-attempt' } }).success).toBe(false);
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...terminal, result: { ...terminal.result, status: 'failed' } }).success).toBe(false);
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...terminal, output: undefined }).success).toBe(false);
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...terminal, output: { ...output, ciphertext: { sha256: 'not-a-digest', bytes: 300 } } }).success).toBe(false);
    expect(RuntimeExecutorReceiptSchema.safeParse({ ...terminal, output: { ...output, encryption: { ...output.encryption, tag: '' } } }).success).toBe(false);
  });

  test('acknowledgement identifies the exact receipt and dispatch', () => {
    const ack = { version: 1, receiptId: 'receipt', dispatch, receiptDigest: digest, acknowledgedAt: timestamp };
    expect(RuntimeReceiptAcknowledgementSchema.safeParse(ack).success).toBe(true);
    expect(RuntimeReceiptAcknowledgementSchema.safeParse({ ...ack, dispatch: { ...dispatch, generation: undefined } }).success).toBe(false);
    expect(RuntimeReceiptAcknowledgementSchema.safeParse({ ...ack, receiptDigest: undefined }).success).toBe(false);
  });

  test('job acceptance is not completion and terminal evidence cannot cross job scope', () => {
    const accepted = { status: 'accepted', job, acceptedAt: timestamp };
    expect(RuntimeJobObservationSchema.parse(accepted).status).toBe('accepted');
    expect(RuntimeJobObservationSchema.safeParse({ ...accepted, receipt: terminal }).success).toBe(false);
    const completed = { status: 'terminal', job, receipt: terminal, completedAt: timestamp };
    expect(RuntimeJobObservationSchema.parse(completed).status).toBe('terminal');
    expect(RuntimeJobObservationSchema.safeParse({ ...completed, receipt: { ...receipt, state: 'unknown', reason: 'unreachable' } }).success).toBe(false);
    expect(RuntimeJobObservationSchema.safeParse({ ...completed, job: { ...job, taskId: 'other-task' } }).success).toBe(false);
  });
});

describe('durable rule interruption contract', () => {
  test('requires discarded generation and provenance rather than a successful response', () => {
    expect(RuntimeRuleInterruptionSchema.parse(interruption).state).toBe('pending');
    expect(RuntimeRuleInterruptionSchema.safeParse({ ...interruption, discard: undefined }).success).toBe(false);
    expect(RuntimeRuleInterruptionSchema.safeParse({ ...interruption, provenance: undefined }).success).toBe(false);
    expect(RuntimeRuleInterruptionSchema.safeParse({ ...interruption, status: 'completed' }).success).toBe(false);
    expect(RuntimeRuleInterruptionSchema.safeParse({ ...interruption, discard: { ...interruption.discard, generationId: 'other' } }).success).toBe(false);
  });

  test('continuation must use a fresh generation and match interruption state', () => {
    const continuation = { state: 'scheduled', generationId: 'next-generation', taskId: 'continuation-task', scheduledAt: timestamp };
    expect(RuntimeRuleInterruptionSchema.parse({ ...interruption, state: 'continuing', continuation }).state).toBe('continuing');
    expect(RuntimeRuleInterruptionSchema.safeParse({ ...interruption, continuation }).success).toBe(false);
    expect(RuntimeRuleInterruptionSchema.safeParse({ ...interruption, state: 'continuing', continuation: { ...continuation, generationId: interruption.generationId } }).success).toBe(false);
  });
});
