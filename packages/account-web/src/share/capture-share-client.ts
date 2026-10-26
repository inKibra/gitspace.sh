import { RuntimeBrowserCaptureShareOpenedSchema, RuntimeBrowserCaptureSharePreviewSchema, RuntimeBrowserCommentThreadSchema } from '@gitspace/protocol-runtime';
import type { RuntimeBrowserCaptureShareComment, RuntimeBrowserCaptureShareOpened, RuntimeBrowserCaptureSharePreview, RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { createDeviceSignedFetch } from '../device.js';
import { currentDevice, deviceRejected } from '../device-session.js';
import { ShareRequestError } from './share-client.js';

const OkSchema = z.object({ status: z.literal('ok'), value: z.unknown() });
const FailureSchema = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) });
const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);

/** One capture share request (`/api/capture-shares/<id>/<action>`); refusals throw `ShareRequestError` with their code
 * (`CAPTURE_SHARE_UNKNOWN`, `CAPTURE_SHARE_ENDED`, `CAPTURE_SHARE_GONE`, …). `signed`: with this browser's enrolled device. */
async function captureShareRequest(captureShareId: string, action: 'preview' | 'open' | 'comments', body: object, signed: boolean): Promise<unknown> {
  const url = new URL(`/api/capture-shares/${encodeURIComponent(captureShareId)}/${action}`, window.location.origin);
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' };
  const response = await (signed ? signedFetch(url, init) : fetch(url, init));
  const answer: unknown = await response.json().catch(() => null);
  const ok = OkSchema.safeParse(answer);
  if (response.ok && ok.success) return ok.data.value;
  const failure = FailureSchema.safeParse(answer);
  throw new ShareRequestError(failure.data?.error.code ?? `HTTP_${response.status}`, response.status, failure.data?.error.message ?? `The share answered ${response.status}`);
}

/** The greeting: who shares which capture, until when. Opens nothing. */
export async function previewCaptureShare(captureShareId: string, secret: string): Promise<RuntimeBrowserCaptureSharePreview> {
  return RuntimeBrowserCaptureSharePreviewSchema.parse(await captureShareRequest(captureShareId, 'preview', { secret }, false));
}

/** Opens the recording: the capture, links to its files, its threads and the token comments present. `signed`: as the
 * account's owner, who may resolve. */
export async function openCaptureShare(captureShareId: string, secret: string, name: string, signed: boolean): Promise<RuntimeBrowserCaptureShareOpened> {
  return RuntimeBrowserCaptureShareOpenedSchema.parse(await captureShareRequest(captureShareId, 'open', { secret, name }, signed));
}

/** A comment at a moment, a reply, or resolving: the thread as it is now. */
export async function writeCaptureShareComment(captureShareId: string, request: Exclude<RuntimeBrowserCaptureShareComment, { op: 'list' }>): Promise<RuntimeBrowserCommentThread> {
  return z.object({ thread: RuntimeBrowserCommentThreadSchema }).parse(await captureShareRequest(captureShareId, 'comments', request, false)).thread;
}

/** The capture's threads as they are now. */
export async function listCaptureShareComments(captureShareId: string, token: string): Promise<RuntimeBrowserCommentThread[]> {
  return z.object({ threads: z.array(RuntimeBrowserCommentThreadSchema) }).parse(await captureShareRequest(captureShareId, 'comments', { op: 'list', token }, false)).threads;
}
