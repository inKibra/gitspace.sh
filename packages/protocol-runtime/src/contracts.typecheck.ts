import type { RuntimeJobAcceptance, RuntimeJobObservation } from './index.js';

type Assert<T extends true> = T;
type NotAssignable<A, B> = [A] extends [B] ? false : true;
export type AcceptanceIsNotCompletion = Assert<NotAssignable<RuntimeJobAcceptance, Extract<RuntimeJobObservation, { status: 'terminal' }>>>;
