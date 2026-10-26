// The extension's offscreen document (`chrome.offscreen`, reason USER_MEDIA): records a tab you chose to capture as
// WebM with its sound, from the `chrome.tabCapture` stream the service worker got with your click, and uploads it to
// the account in parts as it records. The service worker signs each request; this page never holds the pairing key.
// Bundled by `src/build.ts` like the service worker.
import { CAPTURE_MAX_BYTES } from '@gitspace/runtime-machine/browser-screencast';
import { Upload } from './upload.ts';

const VIDEO_TYPE = 'video/webm';
/** MediaRecorder hands over what it recorded this often; each piece joins the upload. */
const SLICE_MS = 5000;
/** A recording stops this short of the 1 GiB cap, so its last pieces still fit. */
const MAX_BYTES = CAPTURE_MAX_BYTES - 32 * 1024 * 1024;
/** While recording, the service worker (which holds the relay connection) hears from this page this often, so Chrome
 * keeps it running. */
const ALIVE_MS = 20_000;
/** Recordings by capture id; an ended one keeps its result, so a late stop gets the same answer. */
const recordings = new Map();

async function request(message) { const reply = await chrome.runtime.sendMessage(message); if (reply?.error) throw new Error(reply.error); return reply; }

async function record({ captureId, groupId, streamId, account }) {
  if (recordings.has(captureId)) throw new Error('This capture is already recording');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
  });
  // Capturing a tab silences it for you; its sound plays on from here, so you keep hearing it.
  const audio = new AudioContext();
  audio.createMediaStreamSource(stream).connect(audio.destination);
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', VIDEO_TYPE].find(type => MediaRecorder.isTypeSupported(type));
  // The recording takes its own copy of the sound, which the capturing bar's sound toggle turns off and on while you
  // keep hearing the tab.
  const sounds = stream.getAudioTracks().map(track => track.clone());
  const recorder = new MediaRecorder(new MediaStream([...stream.getVideoTracks(), ...sounds]), { mimeType, videoBitsPerSecond: 2_500_000 });
  const sign = (method, pathname, bodySha256) => request({ uploadSign: { captureId, method, pathname, bodySha256 } }).then(reply => reply.header);
  const upload = file => new Upload(account, sign, { kind: 'capture', groupId, captureId, file, mediaType: file === 'video.webm' ? VIDEO_TYPE : 'image/jpeg' });
  const recording = { stream, sounds, audio, recorder, video: upload('video.webm'), thumbnail: upload('thumbnail.jpg'), still: null, sound: sounds.length > 0, startedAt: Date.now(), bytes: 0, written: Promise.resolve(), alive: 0, ended: null };
  recorder.ondataavailable = event => {
    if (!event.data.size) return;
    recording.bytes += event.data.size;
    recording.written = recording.written.then(async () => recording.video.write(new Uint8Array(await event.data.arrayBuffer())));
    if (recording.bytes >= MAX_BYTES) ended(captureId, 'The capture reached 1 GiB');
  };
  // Closing the tab ends its stream.
  for (const track of stream.getTracks()) track.addEventListener('ended', () => ended(captureId, 'The tab closed'));
  recorder.start(SLICE_MS);
  recording.alive = setInterval(() => { void chrome.runtime.sendMessage({ captureAlive: captureId }).catch(() => {}); }, ALIVE_MS);
  recordings.set(captureId, recording);
  setTimeout(() => { void still(recording); }, 1000);
  return { sound: recording.sound };
}

/** A small JPEG of the tab a second in, for the capture's thumbnail. */
async function still(recording) {
  try {
    const [track] = recording.stream.getVideoTracks();
    if (!track || track.readyState !== 'live') return;
    const bitmap = await new ImageCapture(track).grabFrame();
    const scale = Math.min(1, 640 / bitmap.width);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    recording.still = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer());
  } catch {}
}

/** Stops a recording and finishes its uploads: the video's track, or why it failed. */
function stop(captureId, reason) {
  const recording = recordings.get(captureId);
  if (!recording) return Promise.resolve({ captureId, reason, error: 'This capture is not recording here' });
  recording.ended ??= (async () => {
    clearInterval(recording.alive);
    const stopped = Promise.withResolvers();
    recording.recorder.onstop = stopped.resolve;
    if (recording.recorder.state === 'inactive') stopped.resolve(); else recording.recorder.stop();
    await stopped.promise;
    for (const track of [...recording.stream.getTracks(), ...recording.sounds]) track.stop();
    await recording.audio.close().catch(() => {});
    const durationMs = Date.now() - recording.startedAt;
    try {
      await recording.written;
      await recording.video.complete();
    } catch (error) {
      await recording.video.abort();
      return { captureId, reason, error: String(error?.message || error) };
    }
    if (recording.still) { try { await recording.thumbnail.write(recording.still); await recording.thumbnail.complete(); } catch {} }
    return { captureId, reason, video: { mediaType: VIDEO_TYPE, sound: recording.sound, durationMs } };
  })();
  return recording.ended;
}

/** A recording that ended on its own (its tab closed, or it reached 1 GiB) tells the service worker once it is saved. */
function ended(captureId, reason) {
  if (recordings.get(captureId)?.ended) return;
  void stop(captureId, reason).then(result => chrome.runtime.sendMessage({ captureEnded: result })).catch(() => {});
}

/** The capturing bar's sound toggle: the recording's sound on or off from now. */
function sound({ captureId, on }) {
  const recording = recordings.get(captureId);
  if (!recording || recording.ended) return Promise.reject(new Error('This capture is not recording here'));
  if (!recording.sounds.length) return Promise.reject(new Error('This tab has no sound to record'));
  for (const track of recording.sounds) track.enabled = on === true;
  return Promise.resolve({ on: on === true });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return;
  const work = message.record ? record(message.record) : typeof message.stop === 'string' ? stop(message.stop, message.reason ?? null) : message.sound ? sound(message.sound) : null;
  if (!work) return;
  void work.then(respond, error => respond({ error: String(error?.message || error) }));
  return true;
});
