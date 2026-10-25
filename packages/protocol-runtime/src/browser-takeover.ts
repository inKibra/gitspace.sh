import { z } from 'zod';

const id = z.string().min(1).max(256);
/** ask_takeover (docs/APERTURE-DESIGN.md §7.2): the agent asks you to take one tab of the workspace's group, on your
 * Chrome (`relay`, chosen by `pairingId` as for the browser tool) or on the cloud browser (`headless`), for `reason`.
 * The call waits up to `timeoutMinutes`. */
export const RuntimeAskTakeoverArgumentsSchema = z.strictObject({
  source: z.enum(['relay', 'headless']), pairingId: z.string().uuid().optional(), targetId: id,
  reason: z.string().trim().min(1).max(1000), timeoutMinutes: z.number().int().min(1).max(120).default(30),
});
export type RuntimeAskTakeoverArguments = z.infer<typeof RuntimeAskTakeoverArgumentsSchema>;
/** The tab an ask_takeover card names, as the account found it when the agent asked: on one of your Chromes
 * (`pairingId`, its name in `browser`) or the cloud browser (`pairingId` null), the workspace's group there, and who held
 * the tab then. */
export const RuntimeTakeoverTabSchema = z.strictObject({
  source: z.enum(['chrome', 'cloud']), pairingId: z.string().uuid().nullable(), browser: z.string().min(1).max(128),
  groupId: z.string().uuid(), targetId: id, url: z.string().max(8192), title: z.string().max(500), holder: z.enum(['agent', 'you']),
});
export type RuntimeTakeoverTab = z.infer<typeof RuntimeTakeoverTabSchema>;
/** A `takeover` question: the ask_takeover card. `callId` is the agent's call it belongs to in the transcript;
 * `askedAt`; `until`, when the call stops waiting; `waiting`, true while the call waits (the card stays open after it).
 * `holder` follows the tab: `you` once you take it, `agent` again once you hand it back. Its answer is one of
 * `TAKEOVER_ANSWERS`. */
export const RuntimeTakeoverQuestionSchema = RuntimeTakeoverTabSchema.extend({ callId: z.string().min(1), askedAt: z.iso.datetime(), until: z.iso.datetime(), waiting: z.boolean() });
export type RuntimeTakeoverQuestion = z.infer<typeof RuntimeTakeoverQuestionSchema>;
/** How a takeover question ends: you chose Not now, or you took the tab and handed it back. */
export const TAKEOVER_ANSWERS = { declined: 'declined', handedBack: 'handed-back' } as const;
/** The card's choices; Not now answers it through `answerAsk`, Take over is `browserTakeOver`. */
export const TAKEOVER_CHOICES = { takeOver: 'Take over', notNow: 'Not now' } as const;
