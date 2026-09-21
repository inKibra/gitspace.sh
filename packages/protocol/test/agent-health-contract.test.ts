import { expect, it } from 'bun:test';
import { z } from 'zod';
import { AgentFailureSchema, AgentLifecycleStateSchema, AgentSessionRenderStateSchema, type AgentLifecycleState, type AgentSessionRenderState } from '@gitspace/protocol-agent';
import { WorkspaceFailureSchema } from '@gitspace/protocol-workspace';
import { contractDigest, rpc, serialize, wire, type InputOf } from 'result-rpc';
import { createBrowserClient, fetchTransport } from 'result-rpc/client';
import { SessionActivityCodec, SessionViewCodec } from '../src/rpc-contract.js';

// Frozen v1 reader: optional additions to a strict custom schema are breaking
// for deployed readers, even though the new reader accepts old payloads.
const legacyHealthSchema = z.object({
  revision: z.number().int().nonnegative(),
  issues: z.partialRecord(z.enum(['execution', 'connection', 'recovery', 'artifact-sync', 'checkpoint', 'workspace-open', 'workspace-close']), z.object({
    revision: z.number().int().nonnegative(), operationId: z.string(),
    failure: z.union([AgentFailureSchema, WorkspaceFailureSchema]).nullable(), incidentId: z.string().nullable(),
  }).strict()),
}).strict();
const legacySessionCodec = wire.object({
  projectId: wire.string, id: wire.string, workspaceId: wire.nullable(wire.string),
  scope: wire.enum(['project', 'workspace']), ompSessionId: wire.string,
  state: wire.serializable((value): value is AgentLifecycleState => AgentLifecycleStateSchema.safeParse(value).success, { id: 'gitspace/agent-lifecycle/v1' }),
  controlsAvailable: wire.boolean, lastEventOffset: wire.number, resumePending: wire.boolean,
  createdAt: wire.date, activity: SessionActivityCodec,
  renderState: wire.serializable((value): value is AgentSessionRenderState => AgentSessionRenderStateSchema.safeParse(value).success, { id: 'gitspace/agent-render-state/v1' }),
  health: wire.serializable((value): value is z.infer<typeof legacyHealthSchema> => legacyHealthSchema.safeParse(value).success, { id: 'gitspace/agent-health/v1' }),
  updatedAt: wire.date,
});
const contract = rpc.context();
const current = contract.contract({ bootstrap: contract.procedure().input(wire.object({})).output(wire.object({ mainAgent: SessionViewCodec })).query() });
const legacy = contract.contract({ bootstrap: contract.procedure().input(wire.object({})).output(wire.object({ mainAgent: legacySessionCodec })).query() });
const session: InputOf<typeof SessionViewCodec> = {
  projectId: 'project', id: 'session', workspaceId: 'space', scope: 'workspace', ompSessionId: 'omp',
  state: 'active', controlsAvailable: true, lastEventOffset: 0, resumePending: false,
  createdAt: new Date('2026-09-19T00:00:00Z'), updatedAt: new Date('2026-09-19T00:00:00Z'),
  activity: { active: false, reasons: [] }, renderState: 'waiting',
  health: { revision: 1, issues: { recovery: {
    revision: 1, operationId: 'recovery', failure: null, incidentId: null,
    attempt: { runtimeId: 'runtime', machineId: 'machine', generation: 1, startedAt: '2026-09-19T00:00:00Z', deadlineAt: '2026-09-19T00:01:00Z', state: 'succeeded', number: 1 },
  } } },
};
function transport(value: unknown, version: string) {
  const body = serialize({ v: 1, status: 'ok', value: { mainAgent: value } });
  if (!body.ok) throw new Error(body.message);
  return fetchTransport({ url: 'https://machine.test/rpc', fetch: (async () => new Response(body.value, {
    headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-result-rpc-contract': version },
  })) as typeof fetch });
}
function encodedSession() {
  const encoded = SessionViewCodec.encode(session);
  if (!encoded.ok) throw new Error('Invalid session fixture');
  return encoded.value;
}

it('reports contract skew, not an unexplained decode failure, to the strict v1 reader', async () => {
  const events: unknown[] = [];
  const client = createBrowserClient({ contract: legacy, transport: transport(encodedSession(), contractDigest(current)), onEvent: (event) => events.push(event) });
  const result = await client.bootstrap({});
  expect(result).toMatchObject({ status: 'error', error: { _tag: 'client/stale', data: { reclassifiedFrom: 'client/decode-failure' } } });
  expect(events).toContainEqual({ type: 'skew', clientContract: contractDigest(legacy), serverContract: contractDigest(current) });
});

it('preserves recovery evidence for the compatible reader and accepts pre-attempt health', async () => {
  const client = createBrowserClient({ contract: current, transport: transport(encodedSession(), contractDigest(current)) });
  expect(await client.bootstrap({})).toMatchObject({ status: 'ok', value: { mainAgent: session } });
  const older = { ...session, health: { revision: 1, issues: { recovery: { revision: 1, operationId: 'recovery', failure: null, incidentId: null } } } };
  const encoded = legacySessionCodec.encode(older);
  if (!encoded.ok) throw new Error('Invalid legacy session fixture');
  const mixed = createBrowserClient({ contract: current, transport: transport(encoded.value, contractDigest(legacy)) });
  expect(await mixed.bootstrap({})).toMatchObject({ status: 'ok', value: { mainAgent: older } });
});

it('still rejects malformed recovery evidence on a matching contract', async () => {
  const value = { ...encodedSession(), health: { ...session.health, issues: { recovery: { ...session.health.issues.recovery, attempt: { ...session.health.issues.recovery!.attempt, state: 'invented' } } } } };
  const client = createBrowserClient({ contract: current, transport: transport(value, contractDigest(current)) });
  expect(await client.bootstrap({})).toMatchObject({ status: 'error', error: { _tag: 'client/decode-failure' } });
});
