import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import { defineErrors, isTaggedError, wire } from 'result-rpc';
import { ClientTimeout, ServerInternal } from 'result-rpc/client';
import { expect, it } from 'vitest';
import { rpcErrorMessage } from './rpc-error-message.js';

it('identifies a failed procedure and incident without exposing its private cause', () => {
  const error = ServerInternal({ incidentId: 'incident-123' }, { cause: new Error('SECRET database credentials') });
  const original = error.toJSON();
  const message = rpcErrorMessage(error, 'inspector.repository.tree');
  expect(message).toContain('inspector.repository.tree');
  expect(message).toContain('server could not complete');
  expect(message).toContain('incident-123');
  expect(message).not.toContain('SECRET');
  expect(ServerInternal.is(error)).toBe(true);
  expect(isTaggedError(error)).toBe(true);
  expect(error.toJSON()).toEqual(original);
  expect(error.message).toBe('server/internal');
});

it('preserves the public domain explanation without serializing other error data', () => {
  const errors = defineErrors('example', {
    failure: { data: wire.object({ message: wire.string, incidentId: wire.string, detail: wire.string }), retry: 'transient' },
  });
  const error = errors.failure({ message: 'Repository access was revoked.', incidentId: 'incident-456', detail: 'PRIVATE diagnostics' });
  const data = error.data;
  const message = rpcErrorMessage(error, 'repository.read');
  expect(message).toContain('Repository access was revoked.');
  expect(message).toContain('incident-456');
  expect(message).not.toContain('PRIVATE');
  expect(error.data).toBe(data);
  expect(errors.failure.is(error)).toBe(true);
  expect(errors.failure.policy.retry).toBe('transient');
});

it('does not recommend repeating an operation whose timeout left its outcome unknown', () => {
  const message = rpcErrorMessage(ClientTimeout({ timeoutMs: 500 }), 'environment.runPhase');
  expect(message).toContain('environment.runPhase');
  expect(message).toContain('outcome may be unknown');
  expect(message).toContain('refresh before trying again');
});

it('does not dump arbitrary thrown objects into the user interface', () => {
  expect(rpcErrorMessage({ cause: 'SECRET', toString: () => 'SECRET' }, 'environment.get')).toBe('environment.get: The request failed.');
});

it('explains canonical workspace ownership conflicts without exposing placement data', () => {
  const error = rpcErrors.workspacePossessed({ workspaceId: 'private-workspace', holderId: 'private-holder', generation: 7 });
  const message = rpcErrorMessage(error, 'Open workspace');
  expect(message).toContain('Another machine holds this workspace');
  expect(message).toContain('Refresh its placement');
  expect(message).not.toContain('private-');
  expect(error.data).toEqual({ workspaceId: 'private-workspace', holderId: 'private-holder', generation: 7 });
});
