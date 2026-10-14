import type { z } from 'zod';
import type {
  RuntimeJobAcceptance, RuntimeJobObservation,
  RuntimeRuleInterruption, RuntimeToolResult,
  RuntimeRunIdSchema, RuntimeGenerationIdSchema, RuntimeRuleIdSchema,
} from './index.js';

type Assert<T extends true> = T;
type NotAssignable<A, B> = [A] extends [B] ? false : true;
export type AcceptanceIsNotCompletion = Assert<NotAssignable<RuntimeJobAcceptance, Extract<RuntimeJobObservation, { status: 'terminal' }>>>;
export type InterruptedIsNotSuccess = Assert<NotAssignable<RuntimeRuleInterruption, Extract<RuntimeToolResult, { status: 'completed' }>>>;
export type PendingCannotResolve = Assert<NotAssignable<Extract<RuntimeRuleInterruption, { state: 'pending' }>['continuation'], Extract<RuntimeRuleInterruption, { state: 'resolved' }>['continuation']>>;
export type RuleDiscardIsRequired = Assert<NotAssignable<Omit<RuntimeRuleInterruption, 'discard'>, RuntimeRuleInterruption>>;
export type RunNotGeneration = Assert<NotAssignable<z.infer<typeof RuntimeRunIdSchema>, z.infer<typeof RuntimeGenerationIdSchema>>>;
export type RuleNotRun = Assert<NotAssignable<z.infer<typeof RuntimeRuleIdSchema>, z.infer<typeof RuntimeRunIdSchema>>>;
