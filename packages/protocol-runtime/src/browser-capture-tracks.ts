import { z } from 'zod';
import { CAPTURE_LAYOUT_ELEMENTS, CAPTURE_STEP_KINDS, CAPTURE_STEPS_MAX, CAPTURE_TRACK_FILES } from './browser-capture-rules.js';

/** A capture's tracks on one clock (docs/APERTURE-DESIGN.md §11): every `atMs` counts from the capture's `startedAt`.
 * Their values and rules (secret masking, the layout interval) are `browser-capture-rules.ts`. */

const atMs = z.number().int().nonnegative();
const fraction = z.number().min(0).max(1);

/** One entry of `steps.json` (an array). `locator` is Playwright locator code computed in the page: `getByRole(…)`,
 * `getByLabel(…)`, `getByText(…)`, `getByTestId(…)`, else `locator('<css>')`. `value` is what was typed, chosen or
 * pressed, `CAPTURE_SECRET_VALUE` for secrets. `url` is the page's address, or the request's for `request`, which has
 * its `method` and `mutating: true` when it is not GET or HEAD. */
export const RuntimeBrowserCaptureStepSchema = z.strictObject({
  atMs, kind: z.enum(CAPTURE_STEP_KINDS), locator: z.string().max(2048).optional(), value: z.string().max(4096).optional(),
  url: z.string().max(8192), method: z.string().max(16).optional(), mutating: z.literal(true).optional(),
});
export type RuntimeBrowserCaptureStep = z.infer<typeof RuntimeBrowserCaptureStepSchema>;
export const RuntimeBrowserCaptureStepsSchema = z.array(RuntimeBrowserCaptureStepSchema).max(CAPTURE_STEPS_MAX);

/** A box on the viewport, each side a fraction of it (the visible part of an element). */
export const RuntimeBrowserViewportBoxSchema = z.strictObject({ x: fraction, y: fraction, w: fraction, h: fraction });
/** One line of `layout.jsonl`: the viewport (CSS pixels), its scroll offset and the visible elements one can point at. */
export const RuntimeBrowserLayoutSampleSchema = z.strictObject({
  atMs, viewport: z.strictObject({ w: z.number().int().positive(), h: z.number().int().positive() }), scroll: z.strictObject({ x: z.number(), y: z.number() }),
  elements: z.array(z.strictObject({ role: z.string().max(64), name: z.string().max(256), selector: z.string().max(1024), box: RuntimeBrowserViewportBoxSchema })).max(CAPTURE_LAYOUT_ELEMENTS),
});
export type RuntimeBrowserLayoutSample = z.infer<typeof RuntimeBrowserLayoutSampleSchema>;

/** A capture's tracks. Paths are relative to its folder. `image`: a screenshot (one JPEG). `frames`: screencast JPEGs
 * in one container (`frames.bin` holds the images back to back, `frames.json` is `RuntimeBrowserFramesIndex`).
 * `video`: WebM from `chrome.tabCapture`. `steps`: `steps.json`. `layout`: `layout.jsonl`. `comments`: how many
 * comments were made on the capture (Comment rows whose source is this capture). */
export const RuntimeBrowserCaptureTracksSchema = z.strictObject({
  image: z.strictObject({ path: z.string().max(256), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  frames: z.strictObject({ path: z.string().max(256), index: z.string().max(256), count: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  video: z.strictObject({ path: z.string().max(256), mediaType: z.string().max(128), sound: z.boolean(), durationMs: z.number().int().nonnegative() }).optional(),
  steps: z.strictObject({ path: z.literal(CAPTURE_TRACK_FILES.steps), count: z.number().int().nonnegative().max(CAPTURE_STEPS_MAX) }).optional(),
  layout: z.strictObject({ path: z.literal(CAPTURE_TRACK_FILES.layout), count: z.number().int().nonnegative() }).optional(),
  comments: z.strictObject({ count: z.number().int().nonnegative() }).optional(),
});
export type RuntimeBrowserCaptureTracks = z.infer<typeof RuntimeBrowserCaptureTracksSchema>;

/** A capture's name: the page's title and when it started, or the one you gave it. */
export const RuntimeBrowserCaptureNameSchema = z.string().trim().min(1).max(200);
/** `capture.json`, version 2: a capture (docs/APERTURE-DESIGN.md §11), stored as `browser/captures/<captureId>/`
 * beside its tracks' files. `skill` is the repository skill made from it, once the agent saved one. */
const CaptureRecordSchema = z.strictObject({
  version: z.literal(2), captureId: z.string().uuid(), name: RuntimeBrowserCaptureNameSchema,
  by: z.enum(['agent', 'you']), source: z.enum(['headless', 'relay', 'machine']), browser: z.string().max(128),
  page: z.strictObject({ url: z.string().max(8192), title: z.string().max(500) }),
  /** The tab it records: its workspace group and target; null when not known. */
  target: z.strictObject({ groupId: z.string().uuid(), targetId: z.string().min(1).max(256) }).nullable(),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(),
  state: z.enum(['recording', 'saved', 'failed']), reason: z.string().max(1024).nullable(),
  tracks: RuntimeBrowserCaptureTracksSchema,
  skill: z.strictObject({ path: z.string().min(1).max(1024), commit: z.string().regex(/^[0-9a-f]{7,64}$/u) }).nullable().optional(),
});
export type RuntimeBrowserCapture = z.infer<typeof CaptureRecordSchema>;
/** Reads `capture.json`, version 2. LEGACY: version 1 records (written before 2026-10-25, without steps, layout,
 * comments or skill) read as version 2; remove the version 1 branch once no workspace drive keeps a version 1 capture. */
export const RuntimeBrowserCaptureSchema = z.union([
  CaptureRecordSchema,
  CaptureRecordSchema.extend({ version: z.literal(1) }).transform((legacy): RuntimeBrowserCapture => ({ ...legacy, version: 2 })),
]);
