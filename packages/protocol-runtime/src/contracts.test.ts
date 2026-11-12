import { describe, expect, test } from 'bun:test';
import { LifecycleRunRequestSchema } from '@gitspace/protocol-environment';
import { RuntimeEnvironmentArgumentsSchema, RuntimeBashArgumentsSchema, RuntimeAgentsArgumentsSchema, runtimeOperationIsReadOnly } from './tool-arguments.js';
import { RuntimeDispatchSelectionSchema } from './scheduling.js';

const job = { projectId: 'project', workspaceId: 'workspace', jobId: 'job', taskId: 'task', conversationId: 'conversation', requestId: 'request' };

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

test('agent lifecycle boundary excludes interactive runs without narrowing human lifecycle requests', () => {
  for (const interactive of [true, false]) {
    expect(RuntimeEnvironmentArgumentsSchema.safeParse({ method: 'runChecks', runId: 'checks', interactive }).success).toBe(false);
    expect(RuntimeEnvironmentArgumentsSchema.safeParse({ method: 'runPhase', runId: 'prepare', phase: 'machine/prepare', interactive }).success).toBe(false);
  }
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
