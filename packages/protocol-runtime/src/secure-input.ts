import { z } from 'zod';

/**
 * Secure input (docs/APERTURE-DESIGN.md §10.1): the agent asks a person for a secret one tab needs, the person types it
 * on GitSpace's secure-input page, and GitSpace fills it into that tab's field. The value never reaches the agent: it
 * hears only that the input was provided (and filled) or declined.
 */

const id = z.string().min(1).max(256);
/** What a request asks for: a password, a one-time code, or other text the field takes. */
export const RuntimeSecureInputKindSchema = z.enum(['password', 'otp', 'text']);
export type RuntimeSecureInputKind = z.infer<typeof RuntimeSecureInputKindSchema>;
/** How long a request stays answerable after the agent asks. */
export const SECURE_INPUT_TTL_MS = 15 * 60_000;
/** A request's id: 32 random bytes, base64url. The page's link carries only this. */
export const SECURE_INPUT_ID = /^[A-Za-z0-9_-]{43}$/u;
/** The secure-input page: `/secure-input/<id>` on the account's origin. */
export const SECURE_INPUT_PAGE = /^\/secure-input\/([A-Za-z0-9_-]{43})$/u;
/** The page's API: device-signed POSTs from a signed-in GitSpace browser (`RuntimeSecureInputPageRequestSchema`). */
export const SECURE_INPUT_API_PATH = '/api/secure-input';
/** The longest value a request takes. */
export const SECURE_INPUT_VALUE_MAX = 4096;

/** An origin as a URL's `origin` reads it: scheme, host and port of an http(s) page. */
const OriginSchema = z.string().max(2048).refine(value => {
  const parsed = URL.parse(value);
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === value;
}, 'An origin is scheme, host and port only, as https://accounts.example.com');

/** The page field a request fills: a CSS selector of the top page, or a ref from observe or a script's view. */
const SelectorSchema = z.string().trim().min(1).max(1024);
const RefSchema = z.string().regex(/^[0-9a-f]+:\d+$/u, 'A ref as observe or view() gave it, such as 3:42');

/** ask_secure_input: the agent asks a person for a secret one tab of the workspace's group needs, on the user's Chrome
 * (`relay`, chosen by `pairingId` as for the browser tool) or the cloud browser (`headless`). `origin` is where the
 * field must be when it is filled; `selector` or `ref` names the field. The call posts the request and ends the turn. */
export const RuntimeAskSecureInputArgumentsSchema = z.strictObject({
  source: z.enum(['relay', 'headless']).describe('relay: a tab on the user\'s Chrome; headless: a tab of the cloud browser.'),
  pairingId: z.string().uuid().optional().describe('With relay: the Chrome, as for web_browser.'),
  targetId: id.describe('The tab, as web_browser tabs lists it.'),
  origin: OriginSchema.describe('The origin the tab must show when the value is filled, as https://accounts.example.com; a tab elsewhere then is refused.'),
  selector: SelectorSchema.optional().describe('The field, as a CSS selector of the top page. Give selector or ref.'),
  ref: RefSchema.optional().describe('The field, as a ref from observe or a script\'s view. Give selector or ref.'),
  kind: RuntimeSecureInputKindSchema.describe('password, otp (a one-time code) or text.'),
  purpose: z.string().trim().min(1).max(300).describe('What the value is for, in one sentence the person reads, as "Sign in to GitHub as octocat".'),
}).superRefine((value, issues) => {
  if ((value.selector === undefined) === (value.ref === undefined)) issues.addIssue({ code: 'custom', path: ['selector'], message: 'Give exactly one of selector or ref' });
});
export type RuntimeAskSecureInputArguments = z.infer<typeof RuntimeAskSecureInputArgumentsSchema>;

/** The field a request fills, as the fill reads it. */
export type RuntimeSecureInputField = { selector: string } | { ref: string };

/**
 * A `secure-input` question: the request as its card, Needs you and an MCP client show it. `requestId` names the
 * account's record of it (`url` is its page); the tab on one of your Chromes (`pairingId`, its name in `browser`) or
 * the cloud browser (`pairingId` null) in the workspace's group, as the account found it when the agent asked;
 * `workspace` the workspace's name; until `expiresAt`. Its answer is a `RuntimeSecureInputAnswer`.
 */
export const RuntimeSecureInputQuestionSchema = z.strictObject({
  requestId: z.string().regex(SECURE_INPUT_ID), url: z.url(),
  source: z.enum(['chrome', 'cloud']), pairingId: z.string().uuid().nullable(), browser: z.string().min(1).max(128),
  groupId: z.string().uuid(), targetId: id, title: z.string().max(500), workspace: z.string().max(256),
  origin: OriginSchema, selector: SelectorSchema.optional(), ref: RefSchema.optional(), kind: RuntimeSecureInputKindSchema, purpose: z.string().max(300),
  expiresAt: z.iso.datetime(), callId: z.string().min(1), askedAt: z.iso.datetime(),
});
export type RuntimeSecureInputQuestion = z.infer<typeof RuntimeSecureInputQuestionSchema>;

/** How a secure-input question ends: the value was filled into the field (`provided`), the person or the fill refused
 * it (`declined`, with why), or nobody answered in time (`expired`). Never the value. */
export const RuntimeSecureInputAnswerSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('provided') }),
  z.strictObject({ outcome: z.literal('declined'), reason: z.string().min(1).max(500) }),
  z.strictObject({ outcome: z.literal('expired') }),
]);
export type RuntimeSecureInputAnswer = z.infer<typeof RuntimeSecureInputAnswerSchema>;
/** The only answer a card, Needs you or an MCP client gives (`answerAsk`): the value itself is typed on the page. */
export const SECURE_INPUT_CHOICES = { decline: 'Decline' } as const;

/** What the page sends: read the request (`view`), fill a typed value (`submit`, `save` seals it in the vault for the
 * origin too), fill a value saved for the origin (`useSaved`), or decline. */
export const RuntimeSecureInputPageRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('view'), id: z.string().regex(SECURE_INPUT_ID) }),
  z.strictObject({ op: z.literal('submit'), id: z.string().regex(SECURE_INPUT_ID), value: z.string().min(1).max(SECURE_INPUT_VALUE_MAX), save: z.boolean() }),
  z.strictObject({ op: z.literal('useSaved'), id: z.string().regex(SECURE_INPUT_ID), credentialId: z.string().uuid() }),
  z.strictObject({ op: z.literal('decline'), id: z.string().regex(SECURE_INPUT_ID) }),
]);
export type RuntimeSecureInputPageRequest = z.infer<typeof RuntimeSecureInputPageRequestSchema>;

/** A request as its page shows it. `state`: `open` takes an answer; `used` was answered on a page already; `expired`
 * passed `expiresAt`; `closed` its question ended another way (declined on its card, the conversation stopped, the
 * person wrote instead). `saved`: values saved in the vault for this origin and kind. */
export const RuntimeSecureInputViewSchema = z.strictObject({
  id: z.string().regex(SECURE_INPUT_ID), state: z.enum(['open', 'used', 'expired', 'closed']),
  workspace: z.string().max(256), purpose: z.string().max(300), origin: OriginSchema, kind: RuntimeSecureInputKindSchema,
  source: z.enum(['chrome', 'cloud']), browser: z.string().max(128), title: z.string().max(500), expiresAt: z.iso.datetime(),
  saved: z.array(z.strictObject({ credentialId: z.string().uuid(), savedAt: z.iso.datetime() })).max(20),
});
export type RuntimeSecureInputView = z.infer<typeof RuntimeSecureInputViewSchema>;
/** What a submit, useSaved or decline did: filled (and `saved` in the vault), or declined with why. */
export const RuntimeSecureInputOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('provided'), saved: z.boolean() }),
  z.strictObject({ outcome: z.literal('declined'), reason: z.string().min(1).max(500) }),
]);
export type RuntimeSecureInputOutcome = z.infer<typeof RuntimeSecureInputOutcomeSchema>;

/** What a browser answers a fill: done, or refused with why (the tab is gone, shows another origin, has no such field). */
export const RuntimeSecureFillResultSchema = z.union([z.strictObject({ filled: z.literal(true) }), z.strictObject({ refused: z.string().min(1).max(500) })]);
export type RuntimeSecureFillResult = z.infer<typeof RuntimeSecureFillResultSchema>;
