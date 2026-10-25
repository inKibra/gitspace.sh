import { z } from 'zod';
import { RuntimeBrowserHolderSchema } from './browser.js';

/**
 * Watching a workspace's tab from GitSpace (docs/APERTURE-DESIGN.md §7.1–7.2): the Watch dialog's socket
 * (`BROWSER_WATCH_PATH`, upgraded, signed by one of the account's devices in `Sec-WebSocket-Protocol`; never a share
 * link) carries the tab's live frames out and, while you hold the tab from this device, your pointer, wheel, keys,
 * touches and typed text in. Frames come from the tab's screencast: your Chrome's extension sends them as it does for a
 * share link; the cloud browser's session object runs one of its own. The socket stops the screencast when it closes.
 *
 * Positions are fractions of the tab's viewport, 0 to 1 from its top-left, as on share links; the tab's own side (the
 * extension, the cloud browser's session) turns them into CSS pixels of the viewport it has at that moment.
 */

/** The Watch dialog's socket: `?projectId&workspaceId&source&targetId`, and `groupId` for your Chrome's group. */
export const BROWSER_WATCH_PATH = '/api/browser-watch';
export const RuntimeBrowserWatchQuerySchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('chrome'), projectId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256), groupId: z.string().uuid(), targetId: z.string().min(1).max(256) }),
  z.strictObject({ source: z.literal('cloud'), projectId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256), targetId: z.string().min(1).max(256) }),
]);
export type RuntimeBrowserWatchQuery = z.infer<typeof RuntimeBrowserWatchQuerySchema>;

const fraction = z.number().min(0).max(1);
/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiers = z.number().int().min(0).max(15);
const delta = z.number().min(-10_000).max(10_000);

/** One input of yours for the tab you hold. */
export const RuntimeBrowserRemoteInputSchema = z.discriminatedUnion('type', [
  /** The pointer moved, or a button went down or up. */
  z.strictObject({ type: z.literal('mouse'), event: z.enum(['move', 'down', 'up']), x: fraction, y: fraction, button: z.enum(['none', 'left', 'middle', 'right', 'back', 'forward']), buttons: z.number().int().min(0).max(31), clickCount: z.number().int().min(0).max(3), modifiers }),
  /** A scroll of the wheel or trackpad at a point, in CSS pixels. */
  z.strictObject({ type: z.literal('wheel'), x: fraction, y: fraction, deltaX: delta, deltaY: delta, modifiers }),
  /** A key went down or up: `key` and `code` as `KeyboardEvent` names them, `keyCode` its Windows virtual key code, and
   * `text` what it types (absent for a key that types nothing). */
  z.strictObject({ type: z.literal('key'), event: z.enum(['down', 'up']), key: z.string().min(1).max(64), code: z.string().max(64), keyCode: z.number().int().min(0).max(255), text: z.string().min(1).max(8).optional(), location: z.number().int().min(0).max(3), repeat: z.boolean(), modifiers }),
  /** Fingers on a touch screen: the points down after a start or move; none after an end or cancel. */
  z.strictObject({ type: z.literal('touch'), event: z.enum(['start', 'move', 'end', 'cancel']), points: z.array(z.strictObject({ id: z.number().int().min(0).max(15), x: fraction, y: fraction })).max(10), modifiers }),
  /** Text typed into the tab's focused element, from the phone layout's text field. */
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(1000) }),
]);
export type RuntimeBrowserRemoteInput = z.infer<typeof RuntimeBrowserRemoteInputSchema>;

/** What the Watch dialog sends: the screen area it shows the tab in (frames are scaled to fit it) and your input. */
export const RuntimeBrowserWatchClientMessageSchema = z.union([
  z.strictObject({ type: z.literal('size'), width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) }),
  RuntimeBrowserRemoteInputSchema,
]);
export type RuntimeBrowserWatchClientMessage = z.infer<typeof RuntimeBrowserWatchClientMessageSchema>;

/** Why a watch ended: the tab closed; its group or browser ended, or the Chrome holding it was unpaired; or the cloud
 * browser closed after its idle time without use (watching is not use). */
export const RuntimeBrowserWatchEndSchema = z.enum(['closed', 'ended', 'idle']);

/** What the socket sends the Watch dialog. */
export const RuntimeBrowserWatchServerMessageSchema = z.discriminatedUnion('type', [
  /** The tab's page and viewport (CSS pixels), when the watch starts and whenever they change. */
  z.strictObject({ type: z.literal('page'), url: z.string().max(8192), title: z.string().max(500), width: z.number().int().positive(), height: z.number().int().positive() }),
  /** One screencast frame of the tab (base64 JPEG, `width`×`height` image pixels). */
  z.strictObject({ type: z.literal('frame'), data: z.string().max(1_500_000), width: z.number().int().positive(), height: z.number().int().positive() }),
  /** Who holds the tab (null: the agent), and whether this socket's input reaches it: you hold it from this device. */
  z.strictObject({ type: z.literal('control'), holder: RuntimeBrowserHolderSchema.nullable(), input: z.boolean() }),
  /** The Chrome holding the tab went offline, or came back. */
  z.strictObject({ type: z.literal('presence'), online: z.boolean() }),
  z.strictObject({ type: z.literal('ended'), reason: RuntimeBrowserWatchEndSchema }),
  /** Something refused or failed (input while you do not hold the tab, a screencast that would not start); the socket stays open. */
  z.strictObject({ type: z.literal('error'), message: z.string().max(1024) }),
]);
export type RuntimeBrowserWatchServerMessage = z.infer<typeof RuntimeBrowserWatchServerMessageSchema>;
