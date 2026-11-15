import { createHash } from 'node:crypto';
import { deviceHasCapability, type GitSpaceRpcContext } from '@gitspace/protocol';
import { DEFAULT_INFERENCE_PROFILE_ID, DEFAULT_SPEECH_SELECTOR, SERVICE_OFF, parseSpeechSelector, speechVoices, type InferenceProfile, type SpeechClipResult } from '@gitspace/protocol/inference';
import { speechClipContract } from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import { requireRuntimeAccess } from './account-runtime-rpc.js';
import type { CredentialVaultDO } from './application.js';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE, deviceAuthority } from './device-authority.js';
import { openAiKeyRequest } from './dictation.js';
import { workspaceDrive, type WorkspaceDrive } from './workspace-drive.js';

/**
 * Speech for walkthrough narration (`speech.clip`, docs/BLOCK-DOCUMENTS-DESIGN.md slice C). The inference profile's
 * `speech` selector (`DEFAULT_SPEECH_SELECTOR` when unset) names the model and voice:
 * - `cloudflare/aura-2-en:<voice>`: Deepgram Aura-2 on Workers AI through the worker's `AI` binding, as MP3.
 * - `openai/<model>:<voice>`: OpenAI's `POST /v1/audio/speech` with an API key of the profile, as MP3.
 * A narration clip is kept in the workspace's drive under `SPEECH_CLIP_FOLDER`, named by the SHA-256 of its model,
 * voice and text, so the same line in the same voice is synthesized once however often and by whomever it is played;
 * it is answered as a signed drive link. A settings sample has no workspace: it is answered as a `data:` URL and not
 * kept. `off` refuses narration; the player then shows captions on timing.
 */

/** Where a workspace's drive keeps narration clips; the Drive surface does not list dot folders. */
export const SPEECH_CLIP_FOLDER = '.speech/';
const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const OFF_MESSAGE = 'Speech is off in this inference profile, so walkthroughs show captions only. Turn it on in Inference → Services → Speech.';

export type Speaker = { provider: string; model: string; voice: string };
/** `text` spoken by `speaker`, as MP3. */
export type Synthesize = (speaker: Speaker, text: string) => Promise<Uint8Array>;
/** The binding's model types give Aura-2's `speaker` as a union of names; this view takes the profile's validated name. */
type SpeechModels = { '@cf/deepgram/aura-2-en': { inputs: { text: string; speaker?: string; encoding?: string }; postProcessedOutputs: unknown } };

/** Speech on Workers AI, or on OpenAI with `profileId`'s API keys. */
export function speechSynthesis(ai: Ai, vault: DurableObjectStub<CredentialVaultDO>, profileId: string): Synthesize {
  const speaking: Ai<SpeechModels> = ai;
  return async (speaker, text) => {
    let response: Response;
    if (speaker.provider === 'cloudflare' && speaker.model === 'aura-2-en') response = await speaking.run('@cf/deepgram/aura-2-en', { text, speaker: speaker.voice, encoding: 'mp3' }, { returnRawResponse: true });
    else if (speaker.provider === 'openai') {
      response = await openAiKeyRequest(vault, profileId, 'speech', key => fetch(OPENAI_SPEECH_URL, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: speaker.model, voice: speaker.voice, input: text, response_format: 'mp3' }),
      }));
    } else throw new Error(`Speech does not run on ${speaker.provider}/${speaker.model}`);
    if (!response.ok) throw new Error(`${speaker.provider}/${speaker.model} did not speak (${response.status}): ${(await response.text()).slice(0, 300)}`);
    return response.bytes();
  };
}

/** Kilobits per second by bitrate index, Layer III: MPEG-1, then MPEG-2 and 2.5. */
const MP3_BITRATES = [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
/** Samples per second by sample-rate index, by the header's version bits (0: MPEG-2.5, 2: MPEG-2, 3: MPEG-1). */
const MP3_SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = { 0: [11025, 12000, 8000], 2: [22050, 24000, 16000], 3: [44100, 48000, 32000] };

type Mp3Frame = { length: number; samples: number; rate: number; bitrate: number };
/** The MPEG Layer III frame at `offset`: its length in bytes, samples, sample rate and bitrate; null when none starts there. */
function mp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1]! >> 3) & 3, layer = (bytes[offset + 1]! >> 1) & 3;
  const bitrate = (MP3_BITRATES[version === 3 ? 0 : 1]![bytes[offset + 2]! >> 4] ?? 0) * 1000;
  const rate = MP3_SAMPLE_RATES[version]?.[(bytes[offset + 2]! >> 2) & 3];
  if (layer !== 1 || !bitrate || !rate) return null;
  const samples = version === 3 ? 1152 : 576;
  return { length: Math.floor(samples / 8 * bitrate / rate) + ((bytes[offset + 2]! >> 1) & 1), samples, rate, bitrate };
}

/** How long MP3 audio plays: measured by walking its frames, or, when they do not run to its end, estimated from its
 * size and its first frame's bitrate. */
export function mp3Duration(bytes: Uint8Array): Pick<SpeechClipResult, 'durationMs' | 'duration'> {
  let offset = 0;
  // An ID3v2 tag: a 10-byte header and its size, 7 bits per byte, plus a 10-byte footer when its flag says so.
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) offset = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!) + (bytes[5]! & 0x10 ? 10 : 0);
  const first = mp3Frame(bytes, offset);
  if (!first) throw new Error('The speech provider answered audio that is not MP3');
  let seconds = 0;
  let frame: Mp3Frame | null = first;
  while (frame) {
    seconds += frame.samples / frame.rate;
    offset += frame.length;
    frame = mp3Frame(bytes, offset);
  }
  // What may follow the last frame: nothing, or an ID3v1 tag.
  const end = bytes.length - offset;
  if (end === 0 || (end === 128 && bytes[offset] === 0x54 && bytes[offset + 1] === 0x41 && bytes[offset + 2] === 0x47)) return { durationMs: Math.round(seconds * 1000), duration: 'measured' };
  return { durationMs: Math.round(bytes.length * 8 / first.bitrate * 1000), duration: 'estimated' };
}

/** The voice a clip is spoken in: `voice` when given, else the profile's `speech`. Narration is refused when the
 * profile's Speech is off; a sample (`narration` false) names its voice and speaks it either way. */
export function clipSpeaker(profile: Pick<InferenceProfile, 'settings'>, voice: string | undefined, narration: boolean): Speaker {
  const configured = profile.settings.speech ?? DEFAULT_SPEECH_SELECTOR;
  if (narration && configured === SERVICE_OFF) throw new Error(OFF_MESSAGE);
  const value = voice ?? configured;
  const speaker = typeof value === 'string' ? parseSpeechSelector(value) : null;
  if (!speaker || !speechVoices(speaker.provider, speaker.model).some(entry => entry.id === speaker.voice)) throw new Error(`This inference profile's speech voice (${JSON.stringify(value)}) is not supported`);
  return speaker;
}

/** `text` spoken by `speaker`: kept in `drive` once per model, voice and text and answered as a signed link, or, with no
 * drive, answered as a `data:` URL. */
export async function speechClip(input: { drive: Pick<WorkspaceDrive, 'read' | 'write' | 'url'> | null; speaker: Speaker; text: string; synthesize: Synthesize }): Promise<SpeechClipResult> {
  const { drive, speaker, text } = input;
  if (!drive) {
    const bytes = await input.synthesize(speaker, text);
    return { url: `data:audio/mpeg;base64,${Buffer.from(bytes).toString('base64')}`, ...mp3Duration(bytes) };
  }
  const key = createHash('sha256').update(JSON.stringify([`${speaker.provider}/${speaker.model}`, speaker.voice, text])).digest('hex');
  const path = `${SPEECH_CLIP_FOLDER}${key}.mp3`;
  let bytes = await drive.read(path);
  if (!bytes) {
    bytes = await input.synthesize(speaker, text);
    await drive.write(path, 'audio/mpeg', bytes);
  }
  return { url: await drive.url(path), ...mp3Duration(bytes) };
}

/** `speech.clip`: narration needs write access to the workspace; a sample needs an account-wide device that may write. */
export function speechCloudProcedures(env: Env, userId: string, deviceId: string) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const clip = server.implement(speechClipContract).handler(async ({ input, errors }) => {
    try {
      const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
      const workspace = input.workspace ? RuntimeIdentitySchema.parse(input.workspace) : null;
      let profile: InferenceProfile | undefined;
      if (workspace) {
        await requireRuntimeAccess(env, userId, deviceId, workspace, 'rpc.write');
        profile = (await vault.resolveCloudInference(workspace.projectId, input.profileId)).profile;
      } else {
        const view = await deviceAuthority(env).current();
        if (!view) throw new Error(DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE);
        const device = view.device(deviceId, Date.now());
        if (!device || device.scope.kind !== 'user' || !deviceHasCapability(device, 'rpc.write')) throw new Error('A voice sample needs a device of this account that may make changes');
        const profileId = input.profileId ?? DEFAULT_INFERENCE_PROFILE_ID;
        profile = (await vault.ensureInference()).profiles.find(entry => entry.id === profileId);
        if (!profile) throw new Error(`Inference profile ${profileId} does not exist`);
      }
      return ok(await speechClip({
        drive: workspace ? workspaceDrive(env, workspace) : null,
        speaker: clipSpeaker(profile, input.voice, workspace !== null),
        text: input.text,
        synthesize: speechSynthesis(env.AI, vault, profile.id),
      }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'speak a clip', message: error instanceof Error ? error.message : String(error) })); }
  });
  return { clip };
}
