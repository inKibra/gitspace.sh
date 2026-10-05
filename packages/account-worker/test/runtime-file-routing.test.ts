import { expect, test } from 'vitest';
import { RuntimeAttachmentSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { routeRepositoryFile, selectConversationAttachment } from '../src/runtime-file-routing.js';

const attachment = (machineId: string, state: RuntimeAttachment['state'] = 'ready', role: RuntimeAttachment['role'] = 'primary') => RuntimeAttachmentSchema.parse({
  projectId: 'project', workspaceId: 'workspace', machineId, attachmentId: machineId, generation: 1,
  state, role, checkout: role === 'runner' ? { kind: 'snapshot', commit: 'a'.repeat(40) } : role === 'delegate' ? { kind: 'branch', branch: 'delegate', commit: 'a'.repeat(40) } : { kind: 'shared', branch: 'main' },
  capabilities: ['read', 'write'], updatedAt: new Date(0).toISOString(),
});
const placement = (value: RuntimeAttachment) => ({ attachmentId: value.attachmentId, generation: value.generation });
const file = { parent: false, repositoryPath: true, cloudAttempt: false, machineAttempt: false };

test('one conversation follows A through cloud admission to B while durable attempts retain their executor class', () => {
  const a = attachment('machine-a');
  const route = { ...file, attachments: [a], placement: placement(a) };
  expect(routeRepositoryFile(route)).toBe('machine');
  expect(selectConversationAttachment(route)?.machineId).toBe(a.machineId);
  const detached = { ...a, state: 'detached' as const };
  route.attachments = [detached];
  expect(routeRepositoryFile(route)).toBe('cloud');
  expect(selectConversationAttachment(route)).toBeUndefined();
  const b = attachment('machine-b');
  route.attachments.push(b);
  expect(routeRepositoryFile(route)).toBe('machine');
  expect(selectConversationAttachment(route)?.machineId).toBe(b.machineId);
  route.placement = placement(b);
  expect(routeRepositoryFile({ ...route, cloudAttempt: true })).toBe('cloud');
  expect(routeRepositoryFile({ ...route, machineAttempt: true })).toBe('machine');
  // Nested dispatch uses the admitted A envelope, never the conversation's new B placement.
  expect(selectConversationAttachment({ ...route, placement: placement(a), parent: true })).toBeUndefined();
  expect(() => routeRepositoryFile({ ...route, cloudAttempt: true, machineAttempt: true })).toThrow('both cloud and machine');
});

test('only detached primary history can release a placement', () => {
  const b = attachment('machine-b');
  for (const state of ['ready', 'lost', 'draining', 'attaching'] as const) {
    const a = attachment('machine-a', state);
    const route = { ...file, attachments: [a, b], placement: placement(a) };
    expect(selectConversationAttachment(route)?.machineId).toBe(state === 'ready' ? a.machineId : undefined);
    expect(routeRepositoryFile({ ...route, attachments: [a] })).toBe('machine');
  }
  const missing = { ...file, attachments: [b], placement: placement(attachment('missing')) };
  expect(selectConversationAttachment(missing)).toBeUndefined();
  expect(routeRepositoryFile({ ...missing, attachments: [] })).toBe('machine');
  expect(selectConversationAttachment({ ...missing, placement: { ...placement(b), generation: 2 } })).toBeUndefined();
});

test('explicit runner and delegate placements never fall through to primary or cloud', () => {
  const primary = attachment('primary');
  for (const role of ['runner', 'delegate'] as const) {
    const assigned = attachment(role, 'ready', role);
    const route = { ...file, attachments: [assigned, primary], placement: placement(assigned) };
    expect(selectConversationAttachment(route)?.machineId).toBe(assigned.machineId);
    route.attachments = [{ ...assigned, state: 'detached' }, primary];
    expect(selectConversationAttachment(route)).toBeUndefined();
    expect(routeRepositoryFile({ ...route, attachments: [route.attachments[0]!] })).toBe('machine');
  }
});

test('fresh cloud admission requires an unpinned repository operation and no primary writer', () => {
  const route = { ...file, attachments: [], placement: null };
  expect(routeRepositoryFile(route)).toBe('cloud');
  expect(routeRepositoryFile({ ...route, repositoryPath: false })).toBe('machine');
  expect(routeRepositoryFile({ ...route, parent: true })).toBe('machine');
  expect(routeRepositoryFile({ ...route, machineAttempt: true })).toBe('machine');
  expect(routeRepositoryFile({ ...route, attachments: [attachment('lost', 'lost')] })).toBe('machine');
});
