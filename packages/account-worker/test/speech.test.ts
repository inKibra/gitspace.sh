import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { SPEECH_CLIP_FOLDER, clipSpeaker, mp3Duration, speechClip, type Speaker } from '../src/speech.js';
import { workspaceDrive } from '../src/workspace-drive.js';

/** `frames` MPEG-1 Layer III frames at 128 kbps and 44.1 kHz: 417 bytes and 1152 samples each. */
function mp3(frames: number): Uint8Array {
  const bytes = new Uint8Array(frames * 417);
  for (let frame = 0; frame < frames; frame++) bytes.set([0xff, 0xfb, 0x90, 0x00], frame * 417);
  return bytes;
}

/** A project with one workspace and its drive. */
async function workspace() {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Speech', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return workspaceDrive(env, { projectId, workspaceId });
}

test('a narration clip is synthesized once per voice and text, kept in the drive and played again from it', async () => {
  const drive = await workspace();
  const spoken: string[] = [];
  const synthesize = async (speaker: Speaker, text: string) => { spoken.push(`${speaker.voice}:${text}`); return mp3(100); };
  const athena = clipSpeaker({ settings: { speech: 'cloudflare/aura-2-en:athena' } }, undefined, true);
  const first = await speechClip({ drive, speaker: athena, text: 'The order is written.', synthesize });
  const again = await speechClip({ drive, speaker: athena, text: 'The order is written.', synthesize });
  expect(spoken).toEqual(['athena:The order is written.']);
  expect(first).toEqual({ url: expect.stringContaining('/files/'), durationMs: Math.round(100 * 1152 / 44100 * 1000), duration: 'measured' });
  expect(again.durationMs).toBe(first.durationMs);
  const kept = await drive.list(SPEECH_CLIP_FOLDER);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ mediaType: 'audio/mpeg', size: 100 * 417, path: expect.stringMatching(/^\.speech\/[0-9a-f]{64}\.mp3$/u) });
  // The browser's own voice is another clip.
  const zeus = clipSpeaker({ settings: { speech: 'cloudflare/aura-2-en:athena' } }, 'cloudflare/aura-2-en:zeus', true);
  await speechClip({ drive, speaker: zeus, text: 'The order is written.', synthesize });
  expect(spoken).toEqual(['athena:The order is written.', 'zeus:The order is written.']);
  expect(await drive.list(SPEECH_CLIP_FOLDER)).toHaveLength(2);
});

test('narration is refused when the profile turned Speech off; a voice sample still speaks', async () => {
  const off = { settings: { speech: 'off' } };
  expect(() => clipSpeaker(off, undefined, true)).toThrow(/Speech is off in this inference profile/u);
  expect(() => clipSpeaker(off, 'cloudflare/aura-2-en:luna', true)).toThrow(/Speech is off/u);
  expect(clipSpeaker({ settings: {} }, undefined, true)).toEqual({ provider: 'cloudflare', model: 'aura-2-en', voice: 'athena' });
  const sample = await speechClip({ drive: null, speaker: clipSpeaker(off, 'cloudflare/aura-2-en:luna', false), text: 'A sample.', synthesize: async () => mp3(10) });
  expect(sample.url.startsWith('data:audio/mpeg;base64,')).toBe(true);
  expect(Buffer.from(sample.url.slice('data:audio/mpeg;base64,'.length), 'base64').byteLength).toBe(10 * 417);
});

test('a duration is measured from the frames, or estimated from size and bitrate when they do not reach the end', () => {
  expect(mp3Duration(mp3(441))).toEqual({ durationMs: Math.round(441 * 1152 / 44100 * 1000), duration: 'measured' });
  const truncated = new Uint8Array([...mp3(441), 1, 2, 3]);
  expect(mp3Duration(truncated)).toEqual({ durationMs: Math.round(truncated.byteLength * 8 / 128_000 * 1000), duration: 'estimated' });
  expect(() => mp3Duration(new Uint8Array(64))).toThrow(/not MP3/u);
});
