import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { RuntimeBrowserCaptureShareOpenedSchema, RuntimeBrowserCaptureShareSchema, type RuntimeBrowserCapture } from '@gitspace/protocol-runtime';
import { workspaceCommentThreads } from '../src/browser-comments.js';
import type { UserRelayDO } from '../src/index.js';
import { workspaceDrive, type WorkspaceDrive } from '../src/workspace-drive.js';

const Reply = z.object({ status: z.string(), value: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const origin = 'https://test.gitspace.sh', encoder = new TextEncoder();
const page = { url: 'https://httpbin.org/forms/post', title: 'Pizza form' };
const anchor = { role: 'textbox', name: 'Telephone:', selector: '#tel', box: { x: 0.1, y: 0.3, w: 0.4, h: 0.05 } };
afterEach(() => { vi.useRealTimers(); });

/** A project with one workspace, its drive, and the vault that seals tokens. */
async function workspace() {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Captures', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return { identity: { projectId, workspaceId }, drive: workspaceDrive(env, { projectId, workspaceId }) };
}

/** A saved recording in the drive: `capture.json`, its video, steps and thumbnail. */
async function recording(drive: WorkspaceDrive, video: Uint8Array): Promise<RuntimeBrowserCapture> {
  const captureId = crypto.randomUUID(), folder = `browser/captures/${captureId}/`;
  const capture: RuntimeBrowserCapture = {
    version: 2, captureId, name: 'Order a pizza', by: 'you', source: 'relay', browser: 'Studio desktop', page, target: null,
    startedAt: '2026-10-25T10:00:00.000Z', endedAt: '2026-10-25T10:00:14.000Z', state: 'saved', reason: null,
    tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 14_000 }, steps: { path: 'steps.json', count: 1 } },
  };
  await drive.write(`${folder}capture.json`, 'application/json', encoder.encode(JSON.stringify(capture)));
  await drive.write(`${folder}video.webm`, 'video/webm', video);
  await drive.write(`${folder}steps.json`, 'application/json', encoder.encode(JSON.stringify([{ atMs: 1200, kind: 'goto', url: page.url }])));
  await drive.write(`${folder}thumbnail.jpg`, 'image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  return capture;
}

function parseLink(link: string) {
  const match = /^https:\/\/[^/]+\/c\/([0-9a-f-]{36})#([A-Za-z0-9_-]{16,128})$/u.exec(link);
  if (!match) throw new Error(`Unreadable capture share link ${link}`);
  return { id: match[1]!, secret: match[2]! };
}
async function post(path: string, body: object) {
  const response = await exports.default.fetch(new Request(`${origin}${path}`, { method: 'POST', body: JSON.stringify(body) }));
  return { ...Reply.parse(await response.json()), status: response.status };
}
async function open(id: string, secret: string, name: string) {
  const reply = await post(`/api/capture-shares/${id}/open`, { secret, name });
  if (reply.status !== 200) throw new Error(`Open refused: ${JSON.stringify(reply)}`);
  return RuntimeBrowserCaptureShareOpenedSchema.parse(reply.value);
}
async function file(url: string, headers: Record<string, string> = {}) {
  const response = await exports.default.fetch(new Request(url, { headers }));
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), range: response.headers.get('content-range') };
}

test('a capture share greets only with its secret, serves that capture’s files and no others, with byte ranges, while no Chrome is paired, and refuses its greeting’s recording and files once revoked', async () => {
  const { identity, drive } = await workspace();
  const video = Uint8Array.from({ length: 64 }, (_, index) => index);
  const capture = await recording(drive, video);
  const other = await recording(drive, Uint8Array.from([9, 9, 9]));
  await drive.write('notes/private.txt', 'text/plain', encoder.encode('not shared'));
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const made = RuntimeBrowserCaptureShareSchema.parse(await relay.browserCaptureShareCreate(identity, { captureId: capture.captureId, comment: true, expiresInMinutes: 10_080 }));
    expect(made).toMatchObject({ captureId: capture.captureId, workspace: identity, name: 'Order a pizza', comment: true, endedAt: null });
    // While it lives, sharing the capture again answers the same link.
    expect(await relay.browserCaptureShareCreate(identity, { captureId: capture.captureId, comment: false, expiresInMinutes: 60 })).toEqual(made);
    const { id, secret } = parseLink(made.link);

    // A wrong secret and an unknown share get the same answer.
    for (const [shareId, guess] of [[id, 'w'.repeat(43)], [crypto.randomUUID(), secret]] as const) expect(await post(`/api/capture-shares/${shareId}/preview`, { secret: guess })).toMatchObject({ status: 404, error: { code: 'CAPTURE_SHARE_UNKNOWN' } });
    expect(await post(`/api/capture-shares/${id}/preview`, { secret })).toMatchObject({ status: 200, value: { capture: { name: 'Order a pizza', page, durationMs: 14_000, comments: 0 }, comment: true, ended: null } });

    const opened = await open(id, secret, 'Ana');
    expect(opened).toMatchObject({ name: 'Ana', guest: true, comment: true, capture: { captureId: capture.captureId }, threads: [] });
    // Only that capture's files, never its record's neighbours in the drive.
    expect(Object.keys(opened.files).toSorted()).toEqual(['steps.json', 'thumbnail.jpg', 'video.webm']);
    expect(await file(opened.files['video.webm']!)).toMatchObject({ status: 200, bytes: video });
    expect(await file(opened.files['video.webm']!, { range: 'bytes=10-19' })).toEqual({ status: 206, bytes: video.subarray(10, 20), range: 'bytes 10-19/64' });

    // A file token opens only under its own share: not another share's path, not as a drive file link.
    const second = RuntimeBrowserCaptureShareSchema.parse(await relay.browserCaptureShareCreate(identity, { captureId: other.captureId, comment: false, expiresInMinutes: 60 }));
    const videoUrl = new URL(opened.files['video.webm']!);
    expect((await file(`${origin}${videoUrl.pathname.replace(id, second.captureShareId)}`)).status).toBe(404);
    expect((await file(`${origin}/files/${videoUrl.pathname.split('/').at(-1)}`)).status).toBe(404);

    const revoked = RuntimeBrowserCaptureShareSchema.parse(await relay.browserCaptureShareRevoke(identity, id));
    expect(revoked).toMatchObject({ endReason: 'revoked', endedAt: expect.any(String) });
    expect(revoked.audit.map(({ event, by, guest }) => ({ event, by, guest }))).toEqual([{ event: 'ended', by: 'you', guest: false }, { event: 'opened', by: 'Ana', guest: true }, { event: 'created', by: 'you', guest: false }]);
    expect(await post(`/api/capture-shares/${id}/preview`, { secret })).toMatchObject({ status: 200, value: { ended: 'revoked' } });
    expect(await post(`/api/capture-shares/${id}/open`, { secret, name: 'Late' })).toMatchObject({ status: 410, error: { code: 'CAPTURE_SHARE_ENDED' } });
    expect((await file(opened.files['video.webm']!)).status).toBe(410);
    expect(await post(`/api/capture-shares/${id}/comments`, { op: 'list', token: opened.token })).toMatchObject({ status: 410, error: { code: 'CAPTURE_SHARE_ENDED' } });
    expect(await relay.browserCaptureShares(identity)).toEqual([second, revoked].map(share => expect.objectContaining({ captureShareId: share.captureShareId })));
  });
});

test('a guest comments at a moment of the recording and replies on its threads only; only the owner resolves; once expired the share refuses', async () => {
  const { identity, drive } = await workspace();
  const capture = await recording(drive, Uint8Array.from([1, 2, 3]));
  const elsewhere = await recording(drive, Uint8Array.from([4]));
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (relay: UserRelayDO) => {
    const made = RuntimeBrowserCaptureShareSchema.parse(await relay.browserCaptureShareCreate(identity, { captureId: capture.captureId, comment: true, expiresInMinutes: 60 }));
    const { id, secret } = parseLink(made.link);
    const ana = await open(id, secret, 'Ana');
    const kept = () => runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.workspaceId}`), async (_authority, state) => workspaceCommentThreads(state.storage, { status: 'all' }));

    const commented = await post(`/api/capture-shares/${id}/comments`, { op: 'comment', token: ana.token, atMs: 12_000, page, anchor, text: 'Telephone only matters for delivery.' });
    expect(commented).toMatchObject({ status: 200, value: { thread: { replies: [], root: { source: { kind: 'capture', captureId: capture.captureId, atMs: 12_000 }, page, anchor, by: { kind: 'person', name: 'Ana', guest: true }, resolved: null } } } });
    const threadId = z.object({ thread: z.object({ root: z.object({ id: z.string() }) }) }).parse(commented.value).thread.root.id;
    expect((await kept()).map(thread => thread.root.source)).toEqual([{ kind: 'capture', captureId: capture.captureId, atMs: 12_000 }]);

    expect(await post(`/api/capture-shares/${id}/comments`, { op: 'reply', token: ana.token, threadId, text: 'Or pickup?' })).toMatchObject({ status: 200, value: { thread: { replies: [{ text: 'Or pickup?', by: { name: 'Ana', guest: true } }] } } });
    // A guest's resolve is refused before it reaches the workspace.
    expect(await post(`/api/capture-shares/${id}/comments`, { op: 'resolve', token: ana.token, threadId })).toMatchObject({ status: 403, error: { code: 'CAPTURE_SHARE_RESOLVE' } });
    expect((await kept())[0]?.root.resolved).toBeNull();
    // A thread of another capture is not this share's to reply in.
    const foreign = await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.workspaceId}`).browserCommentWrite(identity, { op: 'comment', source: { kind: 'capture', captureId: elsewhere.captureId, atMs: 0 }, page, anchor, text: 'Elsewhere' }, { kind: 'person', name: 'Brad', guest: false });
    expect(await post(`/api/capture-shares/${id}/comments`, { op: 'reply', token: ana.token, threadId: foreign.root.id, text: 'Me too' })).toMatchObject({ status: 409, error: { code: 'CAPTURE_SHARE_COMMENT_REFUSED' } });
    expect(await post(`/api/capture-shares/${id}/comments`, { op: 'list', token: ana.token })).toMatchObject({ status: 200, value: { threads: [{ root: { id: threadId } }] } });
    // The owner (opened from one of the account's devices) resolves it.
    expect(await relay.browserCaptureShareComment(id, { name: 'Brad', guest: false }, { op: 'resolve', token: ana.token, threadId })).toMatchObject({ ok: true, value: { thread: { root: { resolved: { by: 'Brad' } } } } });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(made.expiresAt) + 1000);
    expect(await post(`/api/capture-shares/${id}/preview`, { secret })).toMatchObject({ status: 200, value: { ended: 'expired' } });
    expect(await post(`/api/capture-shares/${id}/open`, { secret, name: 'Late' })).toMatchObject({ status: 410, error: { code: 'CAPTURE_SHARE_ENDED' } });
    expect(await post(`/api/capture-shares/${id}/comments`, { op: 'reply', token: ana.token, threadId, text: 'Too late' })).toMatchObject({ status: 401 });
    expect((await file(ana.files['video.webm']!)).status).toBe(404);
  });
});
