import { describe, expect, test } from 'bun:test';
import { RuntimeRuleInterruptionSchema } from './index.js';
import { LifecycleRunRequestSchema } from '@gitspace/protocol-environment';
import { RuntimeEnvironmentArgumentsSchema, RuntimeBashArgumentsSchema, RuntimeAgentsArgumentsSchema, runtimeOperationIsReadOnly } from './tool-arguments.js';
import { RuntimeDispatchSelectionSchema } from './scheduling.js';

const timestamp = '2026-10-03T00:00:00.000Z';
const digest = 'a'.repeat(64);
const job = { projectId: 'project', workspaceId: 'workspace', jobId: 'job', taskId: 'task', conversationId: 'conversation', requestId: 'request' };
const interruption = { version: 1, kind: 'rule-interruption', projectId: 'project', workspaceId: 'workspace', conversationId: 'conversation', taskId: 'task', runId: 'run', generationId: 'generation', interruptionId: 'interruption', ruleId: 'rule', ruleRevision: digest, provenance: { source: 'project-rule', path: '.gitspace/rules/no-secrets.md', matcher: 'text', output: 'tool', outputOrdinal: 2, matchedDigest: digest, observedAt: timestamp }, instruction: 'Do not reveal secrets', discard: { state: 'discarded', generationId: 'generation', toolCalls: 'not-dispatched' }, state: 'pending', continuation: { state: 'pending' } };

test('bash preserves background admission and exposes bounded durable controls', () => {
  expect(RuntimeBashArgumentsSchema.parse({ command: 'printf complete', background: true })).toEqual({ command: 'printf complete', background: true });
  expect(RuntimeBashArgumentsSchema.safeParse({ op: 'logs', job, lines: 2, head: true, cursor: 0 }).success).toBe(true);
  expect(RuntimeBashArgumentsSchema.safeParse({ op: 'run', application: '/bin/sh', args: ['-c', 'true'] }).success).toBe(false);
});

test('agent selection is explicit and addressing does not select a model', () => {
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'spawn', task: 'inspect', name: 'scout' }).success).toBe(false);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'spawn', task: 'inspect', role: 'fast', name: 'worker' }).success).toBe(true);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'spawn', task: 'inspect', agent: 'scout', role: 'fast' }).success).toBe(false);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'send', to: 'worker', message: 'continue' }).success).toBe(true);
  expect(RuntimeAgentsArgumentsSchema.safeParse({ op: 'send', id: 'worker', message: 'continue' }).success).toBe(false);
});

test('process and durable command observations are readonly but controls are mutations', () => {
  for (const tool of ['bash', 'proc']) {
    for (const op of ['list', 'status', 'logs', 'wait']) expect(runtimeOperationIsReadOnly(tool, { op })).toBe(true);
    for (const op of ['start', 'stop', 'restart', 'send', 'cancel']) expect(runtimeOperationIsReadOnly(tool, { op })).toBe(false);
  }
  expect(runtimeOperationIsReadOnly('bash', { command: 'true', background: true })).toBe(false);
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

test('agent lifecycle boundary excludes interactive and destruction without narrowing human lifecycle requests', () => {
  for (const interactive of [true, false]) {
    expect(RuntimeEnvironmentArgumentsSchema.safeParse({ method: 'runChecks', runId: 'checks', interactive }).success).toBe(false);
    expect(RuntimeEnvironmentArgumentsSchema.safeParse({ method: 'runPhase', runId: 'prepare', phase: 'machine/prepare', interactive }).success).toBe(false);
  }
  expect(RuntimeEnvironmentArgumentsSchema.safeParse({ method: 'runPhase', runId: 'destroy', phase: 'cloud/destroy' }).success).toBe(false);
  expect(LifecycleRunRequestSchema.safeParse({ runId: 'human-destroy', phase: 'cloud/destroy', interactive: true }).success).toBe(true);
});

test('agent lifecycle advertised fields exhaust the lifecycle and dispatch owner contracts', () => {
  const lifecycleKeys = Object.keys(LifecycleRunRequestSchema.shape).filter(key => key !== 'interactive');
  const dispatchKeys = Object.keys(RuntimeDispatchSelectionSchema.shape);
  for (const schema of RuntimeEnvironmentArgumentsSchema.options) {
    const method = schema.shape.method;
    if (!method.safeParse('runChecks').success && !method.safeParse('runPhase').success) continue;
    const isChecks = method.safeParse('runChecks').success;
    const consumed = [...lifecycleKeys.filter(key => !isChecks || key !== 'phase'), ...dispatchKeys, 'method'];
    expect(Object.keys(schema.shape).sort()).toEqual(consumed.sort());
  }
});
