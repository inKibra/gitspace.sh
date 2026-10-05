import type { z } from 'zod';
import type {
  RuntimeScopedDispatch, RuntimeExecutorReceipt, RuntimeJobAcceptance, RuntimeJobObservation,
  RuntimeRuleInterruption, RuntimeToolResult, RuntimeDispatchIdentity,
  RuntimeRunIdSchema, RuntimeGenerationIdSchema, RuntimeRuleIdSchema,
} from './index.js';

type Assert<T extends true> = T;
type NotAssignable<A, B> = [A] extends [B] ? false : true;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Ids = Pick<RuntimeScopedDispatch, 'requestId' | 'attemptId' | 'attachmentId' | 'conversationId' | 'taskId' | 'projectId' | 'workspaceId' | 'machineId'>;
type DistinctIds = { [K in keyof Ids]: { [P in Exclude<keyof Ids, K>]: NotAssignable<Ids[K], Ids[P]> }[Exclude<keyof Ids, K>] }[keyof Ids];
export type IdentitySeparation = Assert<Equal<DistinctIds, true>>;
export type StringsRequireAdmission = Assert<NotAssignable<string, Ids[keyof Ids]>>;
export type ScopedDispatchFitsWire = Assert<RuntimeScopedDispatch extends Omit<RuntimeDispatchIdentity, 'fingerprint'> ? true : false>;
type Unknown = Extract<RuntimeExecutorReceipt, { state: 'unknown' }>;
type Starting = Extract<RuntimeExecutorReceipt, { state: 'starting' }>;
type Fenced = Extract<RuntimeExecutorReceipt, { state: 'fenced-not-started' }>;
type Terminal = Extract<RuntimeExecutorReceipt, { state: 'terminal' }>;
export type UnknownIsNotFenced = Assert<NotAssignable<Unknown, Fenced>>;
export type StartingIsNotFenced = Assert<NotAssignable<Starting, Fenced>>;
export type FenceRequiresPositiveEvidence = Assert<Equal<Fenced['evidence']['launchPrevented'], true>>;
export type UncertainCannotCompleteJob = Assert<NotAssignable<Unknown | Starting | Fenced, Extract<RuntimeJobObservation, { status: 'terminal' }>['receipt']>>;
export type AcceptanceIsNotCompletion = Assert<NotAssignable<RuntimeJobAcceptance, Extract<RuntimeJobObservation, { status: 'terminal' }>>>;
export type TerminalHasOutput = Assert<NotAssignable<Omit<Terminal, 'output'>, Terminal>>;
export type FailedRequiresError = Assert<NotAssignable<Omit<Extract<Terminal['result'], { status: 'failed' }>, 'error'>, Terminal['result']>>;
export type InterruptedIsNotSuccess = Assert<NotAssignable<RuntimeRuleInterruption, Extract<RuntimeToolResult, { status: 'completed' }>>>;
export type PendingCannotResolve = Assert<NotAssignable<Extract<RuntimeRuleInterruption, { state: 'pending' }>['continuation'], Extract<RuntimeRuleInterruption, { state: 'resolved' }>['continuation']>>;
export type RuleDiscardIsRequired = Assert<NotAssignable<Omit<RuntimeRuleInterruption, 'discard'>, RuntimeRuleInterruption>>;
export type RunNotGeneration = Assert<NotAssignable<z.infer<typeof RuntimeRunIdSchema>, z.infer<typeof RuntimeGenerationIdSchema>>>;
export type RuleNotRun = Assert<NotAssignable<z.infer<typeof RuntimeRuleIdSchema>, z.infer<typeof RuntimeRunIdSchema>>>;
