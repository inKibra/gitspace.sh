import { z } from 'zod';
import { RuntimeBrowserNameSchema } from './browser.js';
import { RuntimeBrowserCommentTextSchema, RuntimeBrowserCommentThreadSchema } from './browser-comments.js';

/**
 * Share links (docs/APERTURE-DESIGN.md §8, B1): one live tab on your Chrome, watched by people through
 * `https://<account>/s/<shareId>#<secret>`. Viewers always see the tab and point (their named pointers are drawn on the
 * tab; the sharer's own pointer, which the tab must not draw under their cursor, is drawn by each viewer); with
 * `comment` they also comment on what they point at, and their comments land in the tab's workspace. No
 * viewer ever clicks or types in the tab. A share needs an expiry and ends when revoked, when it expires, or when its
 * tab closes. Pasted by you into one of your workspaces' composer, the same link connects the tab to that workspace's
 * group instead (`browserShareConnect`); the agent sees the tab, never the link.
 *
 * Positions on the tab (pointers, hit tests, boxes, regions) are fractions of the tab's viewport, 0 to 1 from its
 * top-left, so they hold at every frame and screen size.
 */

const id = z.string().min(1).max(256);
const fraction = z.number().min(0).max(1);
/** A point on the tab's viewport. */
export const RuntimeBrowserSharePointSchema = z.strictObject({ x: fraction, y: fraction });
/** A box on the tab's viewport. */
export const RuntimeBrowserShareBoxSchema = z.strictObject({ x: fraction, y: fraction, width: fraction, height: fraction });
export type RuntimeBrowserShareBox = z.infer<typeof RuntimeBrowserShareBoxSchema>;

/** How long a share lasts, chosen when it is made: 15 minutes, 1 hour, 8 hours or 24 hours. */
export const BROWSER_SHARE_EXPIRIES_MINUTES = [15, 60, 480, 1440] as const;
export const RuntimeBrowserShareExpirySchema = z.union(BROWSER_SHARE_EXPIRIES_MINUTES.map(minutes => z.literal(minutes)));
/** People watching one share at once. */
export const BROWSER_SHARE_VIEWERS = 20;
/** Live shares one Chrome may have at once. */
export const BROWSER_SHARE_PER_CHROME = 10;
/** Why a share ended. */
export const RuntimeBrowserShareEndSchema = z.enum(['revoked', 'expired', 'closed']);
/** A viewer's name as they gave it (or their account's name), shown on their pointer and comments. */
export const RuntimeBrowserShareNameSchema = z.string().trim().min(1).max(60);

/** Someone watching: `guest` unless they joined signed in as the account's owner. */
export const RuntimeBrowserShareViewerSchema = z.strictObject({ viewerId: z.string().uuid(), name: RuntimeBrowserShareNameSchema, guest: z.boolean(), joinedAt: z.iso.datetime() });
export type RuntimeBrowserShareViewer = z.infer<typeof RuntimeBrowserShareViewerSchema>;

/** Pointer colors, one per viewer: the same on the shared tab (drawn by the extension) and in every viewer. */
const POINTER_COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04', '#dc2626'] as const;
export function browserSharePointerColor(viewerId: string): string {
  // FNV-1a: ids differing in a few characters still land on different colors.
  let hash = 0x811c9dc5;
  for (const char of viewerId) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return POINTER_COLORS[hash % POINTER_COLORS.length] ?? POINTER_COLORS[0];
}

/** One audited event of a share: made, a viewer joined or left, a comment, the tab connected to a workspace, ended. */
export const RuntimeBrowserShareAuditSchema = z.strictObject({
  at: z.iso.datetime(), event: z.enum(['created', 'joined', 'left', 'commented', 'connected', 'ended']),
  /** Who: the viewer's name, `you` for your own actions, or the Chrome's name for what it reported. */
  by: z.string().max(128), guest: z.boolean(), detail: z.string().max(512).nullable(),
});
export type RuntimeBrowserShareAudit = z.infer<typeof RuntimeBrowserShareAuditSchema>;

/** A share as you see it (the extension popup, the Inspector's Browser tab): with its link, so it can be copied again. */
export const RuntimeBrowserShareSchema = z.strictObject({
  shareId: z.string().uuid(),
  /** `https://<account>/s/<shareId>#<secret>`. */
  link: z.url().max(512),
  pairingId: z.string().uuid(), browser: RuntimeBrowserNameSchema, targetId: id,
  /** The workspace whose group held the tab when it was shared (or that it was connected to): comments land there.
   * Null for a tab in no workspace group, which can be watched but not commented on. */
  workspace: z.strictObject({ projectId: id, workspaceId: id, groupId: z.string().uuid() }).nullable(),
  page: z.strictObject({ url: z.string().max(8192), title: z.string().max(500) }),
  comment: z.boolean(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(), endReason: RuntimeBrowserShareEndSchema.nullable(),
  viewers: z.array(RuntimeBrowserShareViewerSchema).max(BROWSER_SHARE_VIEWERS),
  /** Newest first, at most 50. */
  audit: z.array(RuntimeBrowserShareAuditSchema).max(50),
});
export type RuntimeBrowserShare = z.infer<typeof RuntimeBrowserShareSchema>;

/** A shared page's icon: its favicon as your Chrome has it, a PNG of at most 32×32 pixels as a data URL. */
export const RuntimeBrowserShareIconSchema = z.string().max(12_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u);

/** What the greeting shows before anyone joins (`POST /api/shares/<shareId>/preview` with the secret). */
export const RuntimeBrowserSharePreviewSchema = z.strictObject({
  /** Who is sharing: the account's name. */
  sharer: z.string().max(128),
  /** The shared page; `icon` is null until its Chrome sends one (extension 5.8 and later) or where the page has none. */
  page: z.strictObject({ title: z.string().max(500), site: z.string().max(253), icon: RuntimeBrowserShareIconSchema.nullable() }),
  comment: z.boolean(), expiresAt: z.iso.datetime(),
  /** Set once the share has ended: the greeting says "This share has ended". */
  ended: RuntimeBrowserShareEndSchema.nullable(),
  /** The name of the Chrome holding the tab, for the account's own devices (a pasted link's chip names it); null for
   * everyone else. */
  browser: RuntimeBrowserNameSchema.nullable(),
  /** Whether that Chrome is connected now, so the tab shows as soon as someone joins. */
  online: z.boolean(),
});
export type RuntimeBrowserSharePreview = z.infer<typeof RuntimeBrowserSharePreviewSchema>;

/** `POST /api/shares/<shareId>/join`: the secret and the name to show. Signed by this account's enrolled device
 * (`x-gitspace-device`), the viewer joins as the owner (not a guest) and the name is the account's. */
export const RuntimeBrowserShareJoinSchema = z.strictObject({ secret: z.string().min(16).max(128), name: RuntimeBrowserShareNameSchema });
/** The answer to a join: a token the live socket presents first, valid for 5 minutes. */
export const RuntimeBrowserShareJoinedSchema = z.strictObject({ token: z.string().min(1).max(4096), viewerId: z.string().uuid(), name: RuntimeBrowserShareNameSchema, guest: z.boolean(), expiresAt: z.iso.datetime() });

/** What is under a point of the tab: its box, accessible role and name, a little of its visible text, and selector
 * candidates (most specific first) to find it again. */
export const RuntimeBrowserShareTargetSchema = z.strictObject({
  box: RuntimeBrowserShareBoxSchema, role: z.string().max(64), name: z.string().max(500), text: z.string().max(500),
  selectors: z.array(z.string().max(1024)).max(5),
});
export type RuntimeBrowserShareTarget = z.infer<typeof RuntimeBrowserShareTargetSchema>;

/** Messages a viewer sends on the live socket (`GET /api/shares/<shareId>/live`, upgraded). `hello` comes first. */
export const RuntimeBrowserShareViewerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), token: z.string().min(1).max(4096) }),
  /** The viewer's screen area for the tab, in CSS pixels: frames are scaled to fit the largest viewer. */
  z.strictObject({ type: z.literal('size'), width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) }),
  /** The viewer's pointer on the tab, or null when it left the tab. */
  z.strictObject({ type: z.literal('pointer'), at: RuntimeBrowserSharePointSchema.nullable() }),
  /** Comment mode, `comment` shares only: what is under this point? */
  z.strictObject({ type: z.literal('hit'), at: RuntimeBrowserSharePointSchema }),
  /** A comment on the element at a point, or on a dragged area: a new thread. */
  z.strictObject({ type: z.literal('comment'), at: RuntimeBrowserSharePointSchema.optional(), region: RuntimeBrowserShareBoxSchema.optional(), text: RuntimeBrowserCommentTextSchema }),
  /** A reply in one of this share's threads. */
  z.strictObject({ type: z.literal('commentReply'), threadId: z.string().uuid(), text: RuntimeBrowserCommentTextSchema }),
  /** Resolves (or with `reopen`, reopens) one of this share's threads; the account's owner only, never a guest. */
  z.strictObject({ type: z.literal('commentResolve'), threadId: z.string().uuid(), reopen: z.boolean().optional() }),
]);
export type RuntimeBrowserShareViewerMessage = z.infer<typeof RuntimeBrowserShareViewerMessageSchema>;

/** Messages the live socket sends a viewer. */
export const RuntimeBrowserShareServerMessageSchema = z.discriminatedUnion('type', [
  /** `threads`: the share's comment threads, oldest first. A viewer whose own entry in `viewers` is not a guest may
   * resolve them. */
  z.strictObject({ type: z.literal('joined'), viewerId: z.string().uuid(), share: RuntimeBrowserSharePreviewSchema, viewers: z.array(RuntimeBrowserShareViewerSchema), threads: z.array(RuntimeBrowserCommentThreadSchema) }),
  /** The tab's page and viewport (CSS pixels), on joining and whenever they change. */
  z.strictObject({ type: z.literal('page'), url: z.string().max(8192), title: z.string().max(500), width: z.number().int().positive(), height: z.number().int().positive() }),
  /** One screencast frame of the tab (base64 JPEG, `width`×`height` image pixels). */
  z.strictObject({ type: z.literal('frame'), data: z.string().max(1_500_000), width: z.number().int().positive(), height: z.number().int().positive() }),
  /** Everyone watching, with their pointers (null: off the tab). */
  z.strictObject({ type: z.literal('viewers'), viewers: z.array(RuntimeBrowserShareViewerSchema.extend({ at: RuntimeBrowserSharePointSchema.nullable() })) }),
  /** The sharer's own pointer on the tab (null: off it), as their Chrome reports it (extension 5.8 and later). Each
   * viewer draws it over the frames: it is not drawn on the tab, where the sharer's own cursor already is. */
  z.strictObject({ type: z.literal('sharer'), at: RuntimeBrowserSharePointSchema.nullable() }),
  /** The answer to the latest `hit`: what is under that point, or nothing. */
  z.strictObject({ type: z.literal('hit'), at: RuntimeBrowserSharePointSchema, target: RuntimeBrowserShareTargetSchema.nullable() }),
  /** One of the share's threads, whenever it is made or changes (a reply, resolved, reopened): it replaces the thread
   * with its id, or is added last. */
  z.strictObject({ type: z.literal('thread'), thread: RuntimeBrowserCommentThreadSchema }),
  /** The Chrome holding the tab went offline, or came back. */
  z.strictObject({ type: z.literal('presence'), online: z.boolean() }),
  z.strictObject({ type: z.literal('ended'), reason: RuntimeBrowserShareEndSchema }),
  /** A refused message (a comment on a view-only share, a comment that failed); the socket stays open. */
  z.strictObject({ type: z.literal('error'), message: z.string().max(1024) }),
]);
export type RuntimeBrowserShareServerMessage = z.infer<typeof RuntimeBrowserShareServerMessageSchema>;

/** Requests your Chrome's extension signs with its pairing key (`POST /api/browser-relay/shares`): make a share of one
 * of its tabs, end one, or list its live shares. */
export const RuntimeBrowserShareChromeRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), targetId: id, comment: z.boolean(), expiresInMinutes: RuntimeBrowserShareExpirySchema }),
  z.strictObject({ op: z.literal('revoke'), shareId: z.string().uuid() }),
  z.strictObject({ op: z.literal('list') }),
]);
export type RuntimeBrowserShareChromeRequest = z.infer<typeof RuntimeBrowserShareChromeRequestSchema>;

/** The tab a pasted share link connected to a workspace (`browserShareConnect`). */
export const RuntimeBrowserConnectedTabSchema = z.strictObject({ pairingId: z.string().uuid(), browser: RuntimeBrowserNameSchema, groupId: z.string().uuid(), targetId: id, url: z.string().max(8192), title: z.string().max(500) });
export type RuntimeBrowserConnectedTab = z.infer<typeof RuntimeBrowserConnectedTabSchema>;

/** Matches a share link of the account at `origin`: `<origin>/s/<shareId>#<secret>`. */
export function parseBrowserShareLink(text: string, origin: string): { shareId: string; secret: string } | null {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return null; }
  const match = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(url.pathname);
  const secret = url.hash.slice(1);
  if (url.origin !== origin || !match || !/^[A-Za-z0-9_-]{16,128}$/u.test(secret)) return null;
  return { shareId: match[1]!, secret };
}
