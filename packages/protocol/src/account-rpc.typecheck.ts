import type { ProcedureInput } from 'result-rpc';
import { ACCOUNT_RPC_AUTHORITY, type GitSpaceProcedurePath } from './account-rpc.js';
import type { gitspaceContract } from './rpc-contract.js';

type ProcedureAtPath<T, P extends string> = P extends `${infer Head}.${infer Tail}`
  ? Head extends keyof T ? ProcedureAtPath<T[Head], Tail> : never
  : P extends keyof T ? T[P] : never;
type MachinePath = {
  [P in GitSpaceProcedurePath]: typeof ACCOUNT_RPC_AUTHORITY[P] extends 'machine' ? P : never;
}[GitSpaceProcedurePath];
type MissingMachineInput = {
  [P in MachinePath]: ProcedureInput<ProcedureAtPath<typeof gitspaceContract.record, P>> extends { machineId: string } ? never : P;
}[MachinePath];

// New machine routes cannot silently acquire an optional or absent target.
export const missingMachineInputs: Record<MissingMachineInput, never> = {};
export const terminalAuthority: 'machine' = ACCOUNT_RPC_AUTHORITY['terminals.create'];
export const repositoryAuthority: 'cloud' = ACCOUNT_RPC_AUTHORITY['inspector.repository.file'];
// @ts-expect-error Removed legacy endpoints cannot be classified as public work.
export const removedSession: GitSpaceProcedurePath = 'session.prompt';
// @ts-expect-error An unknown path must not silently acquire a machine authority.
export const unknownAuthority = ACCOUNT_RPC_AUTHORITY['runtime.unknown'];
// @ts-expect-error A terminal request cannot rely on a holder or default machine.
export const unnamedTerminal: ProcedureInput<typeof gitspaceContract.terminals.create> = { spaceId: 'workspace' };
