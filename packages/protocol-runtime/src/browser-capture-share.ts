import { z } from 'zod';
import { RuntimeBrowserCaptureSchema } from './browser-capture-tracks.js';
import { RuntimeBrowserCommentAnchorSchema, RuntimeBrowserCommentNameSchema, RuntimeBrowserCommentPageSchema, RuntimeBrowserCommentTextSchema, RuntimeBrowserCommentThreadSchema } from './browser-comments.js';

/**
 * Capture share links (docs/APERTURE-DESIGN.md §8, §11, B3): one saved capture, played by people through
 * `https://<account>/c/<captureShareId>#<secret>`. The account keeps the share; the recording stays in the workspace's
 * drive and is read from there, so the link works while every Chrome is offline. Viewers always watch the whole
 * recording; with `comment` they also comment at any moment of its timeline and reply to its threads. Only the
 * account's owner resolves. A share needs an expiry and ends when revoked or when it expires.
 */

const uuid = z.string().uuid();

/** How long a capture share lasts, chosen when it is made: 1 hour, 1 day, 7 days or 30 days. */
export const BROWSER_CAPTURE_SHARE_EXPIRIES_MINUTES = [60, 1440, 10_080, 43_200] as const;
export const RuntimeBrowserCaptureShareExpirySchema = z.union(BROWSER_CAPTURE_SHARE_EXPIRIES_MINUTES.map(minutes => z.literal(minutes)));
export type RuntimeBrowserCaptureShareExpiry = z.infer<typeof RuntimeBrowserCaptureShareExpirySchema>;
/** Where your Chrome's extension makes and ends capture shares (`POST`, signed with its pairing key like share requests). */
export const BROWSER_CAPTURE_SHARE_PATH = '/api/browser-relay/capture-shares';
/** Why a capture share ended. */
export const RuntimeBrowserCaptureShareEndSchema = z.enum(['revoked', 'expired']);
export type RuntimeBrowserCaptureShareEnd = z.infer<typeof RuntimeBrowserCaptureShareEndSchema>;

/** One audited event of a capture share: made, opened by a viewer, a comment, a reply, a thread resolved or reopened,
 * ended. `by` is the viewer's name, `you` for your own actions, or the Chrome's name for what it made. */
export const RuntimeBrowserCaptureShareAuditSchema = z.strictObject({
  at: z.iso.datetime(), event: z.enum(['created', 'opened', 'commented', 'replied', 'resolved', 'reopened', 'ended']),
  by: z.string().max(128), guest: z.boolean(), detail: z.string().max(512).nullable(),
});
export type RuntimeBrowserCaptureShareAudit = z.infer<typeof RuntimeBrowserCaptureShareAuditSchema>;

/** A capture share as you see it (the Browser tab, the extension's saved card): with its link, so it can be copied again. */
export const RuntimeBrowserCaptureShareSchema = z.strictObject({
  captureShareId: uuid, captureId: uuid,
  /** `https://<account>/c/<captureShareId>#<secret>`. */
  link: z.url().max(512),
  workspace: z.strictObject({ projectId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256) }),
  /** The capture's name when it was shared. */
  name: z.string().max(200),
  comment: z.boolean(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(), endReason: RuntimeBrowserCaptureShareEndSchema.nullable(),
  /** Newest first, at most 50. */
  audit: z.array(RuntimeBrowserCaptureShareAuditSchema).max(50),
});
export type RuntimeBrowserCaptureShare = z.infer<typeof RuntimeBrowserCaptureShareSchema>;

/** What the greeting shows before anyone opens the recording (`POST /api/capture-shares/<id>/preview` with the secret). */
export const RuntimeBrowserCaptureSharePreviewSchema = z.strictObject({
  /** Who shares: the account's name. */
  sharer: z.string().max(128),
  capture: z.strictObject({ name: z.string().max(200), page: RuntimeBrowserCommentPageSchema, durationMs: z.number().int().nonnegative(), comments: z.number().int().nonnegative() }),
  comment: z.boolean(), expiresAt: z.iso.datetime(),
  /** Set once the share has ended: the greeting says "This share has ended". */
  ended: RuntimeBrowserCaptureShareEndSchema.nullable(),
});
export type RuntimeBrowserCaptureSharePreview = z.infer<typeof RuntimeBrowserCaptureSharePreviewSchema>;

/** `POST /api/capture-shares/<id>/open`: the secret and the name to show on comments. Signed by this account's enrolled
 * device (`x-gitspace-device`), the viewer is the owner (not a guest, may resolve) under the account's name. */
export const RuntimeBrowserCaptureShareOpenSchema = z.strictObject({ secret: z.string().min(16).max(128), name: RuntimeBrowserCommentNameSchema });
/** The answer to an open: the capture, links to its files (each serves only while the share lives), its threads, and a
 * token that comment requests present. */
export const RuntimeBrowserCaptureShareOpenedSchema = z.strictObject({
  token: z.string().min(1).max(4096), name: RuntimeBrowserCommentNameSchema, guest: z.boolean(), expiresAt: z.iso.datetime(),
  sharer: z.string().max(128), comment: z.boolean(), shareExpiresAt: z.iso.datetime(),
  capture: RuntimeBrowserCaptureSchema, files: z.record(z.string().max(256), z.string().max(4096)),
  threads: z.array(RuntimeBrowserCommentThreadSchema).max(500),
});
export type RuntimeBrowserCaptureShareOpened = z.infer<typeof RuntimeBrowserCaptureShareOpenedSchema>;

/** `POST /api/capture-shares/<id>/comments` with the open's token: a comment at `atMs` on the recording, a reply to one
 * of its threads, resolving or reopening one (the owner only), or the threads as they are now (`list`). Answers
 * `{ thread }`, or `{ threads }` for `list`. */
export const RuntimeBrowserCaptureShareCommentSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('comment'), token: z.string().min(1).max(4096), atMs: z.number().int().nonnegative(), page: RuntimeBrowserCommentPageSchema, anchor: RuntimeBrowserCommentAnchorSchema.omit({ cropFile: true }), text: RuntimeBrowserCommentTextSchema }),
  z.strictObject({ op: z.literal('reply'), token: z.string().min(1).max(4096), threadId: uuid, text: RuntimeBrowserCommentTextSchema }),
  z.strictObject({ op: z.literal('resolve'), token: z.string().min(1).max(4096), threadId: uuid, reopen: z.boolean().optional() }),
  z.strictObject({ op: z.literal('list'), token: z.string().min(1).max(4096) }),
]);
export type RuntimeBrowserCaptureShareComment = z.infer<typeof RuntimeBrowserCaptureShareCommentSchema>;

/** Requests your Chrome's extension signs (`POST BROWSER_CAPTURE_SHARE_PATH`): share a capture it recorded into a
 * workspace group on that Chrome (`groupId`, the capture's `target.groupId`; while one share of the capture lives, it is
 * the answer), or end one. Answers `{ captureShare }`. */
export const RuntimeBrowserCaptureShareChromeRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), captureId: uuid, groupId: uuid, comment: z.boolean(), expiresInMinutes: RuntimeBrowserCaptureShareExpirySchema }),
  z.strictObject({ op: z.literal('revoke'), captureShareId: uuid }),
]);
export type RuntimeBrowserCaptureShareChromeRequest = z.infer<typeof RuntimeBrowserCaptureShareChromeRequestSchema>;
