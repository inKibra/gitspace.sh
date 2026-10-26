import {
  CAPTURE_PARAMETER_KINDS, CAPTURE_TRACK_FILES, RuntimeBrowserCaptureStepsSchema, captureClock, captureMention, captureMentionIds, captureReplayParameters, captureReplayScript, captureSummary, captureSummaryBlock, withoutCaptureSummaries,
  type RuntimeBrowserArguments, type RuntimeBrowserCapture, type RuntimeBrowserCaptureStep, type RuntimeBrowserToolArguments,
} from '@gitspace/protocol-runtime';
import { captureFolder, captureViews, readCapture, writeCapture, type CaptureDrive } from './browser-capture.js';
import { workspaceCommentThreads } from './browser-comments.js';

/**
 * Captures for the agent (docs/APERTURE-DESIGN.md §11, B3): the summary a mention expands to, the captures list,
 * replaying a capture's steps as a `run`, and recording the repository skill made from one. Everything reads the
 * workspace's drive (`browser/captures/<id>/`) and its comment rows; nothing here touches a browser.
 */

/** The workspace storage its comment rows are listed from (`browser-comments.ts`). */
type ThreadRows = { list(options: { prefix: string; reverse?: boolean; limit?: number; end?: string }): Promise<Map<string, unknown>> };
type ReplayArguments = Extract<RuntimeBrowserToolArguments, { action: 'replay' }>;
type RunArguments = Extract<RuntimeBrowserArguments, { action: 'run' }>;
/** The longest script a `run` takes. */
const RUN_SCRIPT_MAX = 65_536;
/** Where a capture's skill lives in the repository: `.gitspace/skills/<slug>`. */
const SKILL_FOLDER = /^\.gitspace\/skills\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** A capture's steps (`steps.json`), or null when it has no steps track. */
export async function readCaptureSteps(drive: CaptureDrive, capture: RuntimeBrowserCapture): Promise<RuntimeBrowserCaptureStep[] | null> {
  if (!capture.tracks.steps) return null;
  const bytes = await drive.read(`${captureFolder(capture.captureId)}${CAPTURE_TRACK_FILES.steps}`);
  return bytes ? RuntimeBrowserCaptureStepsSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) : null;
}

/** One capture as the agent reads it (`captureSummary`): its record, steps and comment threads (all of them, in the
 * order they were made on its clock); null when the workspace's drive has no such capture. */
export async function readCaptureSummary(drive: CaptureDrive, rows: ThreadRows, captureId: string): Promise<{ capture: RuntimeBrowserCapture; text: string } | null> {
  const capture = await readCapture(drive, captureId);
  if (!capture) return null;
  const [steps, threads] = await Promise.all([readCaptureSteps(drive, capture), workspaceCommentThreads(rows, { status: 'all', captureId, limit: 500 })]);
  const ordered = threads.toSorted((left, right) => (left.root.source.kind === 'capture' ? left.root.source.atMs : 0) - (right.root.source.kind === 'capture' ? right.root.source.atMs : 0));
  return { capture, text: captureSummary({ capture, steps, threads: ordered }) };
}

/** A message as the agent reads it: its text (without summaries an earlier send appended), then a summary of each
 * capture it names (`capture://<id>`), or a line saying the workspace has no such capture. */
export async function withCaptureSummaries(text: string, drive: CaptureDrive, rows: ThreadRows): Promise<string> {
  const own = withoutCaptureSummaries(text);
  const ids = captureMentionIds(own);
  if (!ids.length) return own;
  const blocks = await Promise.all(ids.map(async captureId => {
    const found = await readCaptureSummary(drive, rows, captureId);
    return captureSummaryBlock(captureId, found?.capture.name ?? null, found?.text ?? `${captureMention(captureId)} is not a capture of this workspace: web_browser {action:"captures"} lists them.`);
  }));
  return [own, ...blocks].join('\n\n');
}

/** `captures`: the workspace's captures, newest first, one line each. */
export async function capturesText(drive: CaptureDrive, limit: number): Promise<string> {
  const views = (await captureViews(drive)).slice(0, limit);
  if (!views.length) return 'This workspace has no captures. The user records them from the Browser tab or the extension; capture() in a run saves screenshots.';
  return views.map(({ capture }) => {
    const { steps, video, frames, image, comments } = capture.tracks;
    const tracks = [steps ? `${steps.count} steps` : null, video ? `video ${captureClock(video.durationMs)}` : null, frames ? `${frames.count} frames` : null, image ? 'screenshot' : null, comments?.count ? `${comments.count} comments` : null].filter(track => track !== null);
    return `- ${captureMention(capture.captureId)} ${JSON.stringify(capture.name)}, ${capture.startedAt}, ${capture.state}${tracks.length ? `: ${tracks.join(', ')}` : ''}${capture.skill ? `; skill ${capture.skill.path}` : ''}`;
  }).join('\n');
}

/**
 * `replay` as the `run` it becomes (`captureReplayScript`), on the browser the call names, and the script as the agent
 * is shown it (without the values of `args`). Refuses a capture that is missing, still recording or without steps,
 * and a call whose `args` lack a parameter or name one the capture does not have, saying what to pass.
 */
export async function replayRun(drive: CaptureDrive, call: ReplayArguments): Promise<{ run: RunArguments; script: string; capture: RuntimeBrowserCapture }> {
  const capture = await readCapture(drive, call.capture);
  if (!capture) throw new Error(`${captureMention(call.capture)} is not a capture of this workspace: web_browser {action:"captures"} lists them.`);
  if (capture.state === 'recording') throw new Error(`Capture ${JSON.stringify(capture.name)} is still recording: replay it once the user pressed Done.`);
  const steps = await readCaptureSteps(drive, capture);
  if (!steps?.some(step => step.kind !== 'request')) throw new Error(`Capture ${JSON.stringify(capture.name)} has no steps to replay: it holds only ${Object.keys(capture.tracks).join(', ') || 'nothing'}.`);
  const parameters = captureReplayParameters(steps), args = call.args ?? {};
  const unknown = Object.keys(args).filter(name => !parameters.some(parameter => parameter.name === name));
  if (unknown.length) throw new Error(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not a parameter' : 'are not parameters'} of capture ${JSON.stringify(capture.name)}; its parameters: ${parameters.map(parameter => parameter.name).join(', ') || 'none'}.`);
  const missing = parameters.filter(parameter => args[parameter.name] === undefined);
  if (missing.length) {
    throw new Error(`Capture ${JSON.stringify(capture.name)} needs args before it can be replayed: ${missing.map(parameter => `${parameter.name} (step ${parameter.step}, ${parameter.what}: ${CAPTURE_PARAMETER_KINDS[parameter.kind]})`).join('; ')}. Ask the user for them, never guess, then call replay again with args {${missing.map(parameter => `${parameter.name}: …`).join(', ')}}.`);
  }
  const script = captureReplayScript(capture, steps, args);
  const runnable = `const args = ${JSON.stringify(args)};\n${script}`;
  if (runnable.length > RUN_SCRIPT_MAX) throw new Error(`Capture ${JSON.stringify(capture.name)} has too many steps for one run (its script would be ${runnable.length} characters, at most ${RUN_SCRIPT_MAX}): replay part of it with run, from its steps in ${captureMention(capture.captureId)}.`);
  const run: RunArguments = { action: 'run', source: call.source, script: runnable, ...(call.on === undefined ? {} : { on: call.on }), ...(call.pairingId === undefined ? {} : { pairingId: call.pairingId }), ...(call.sites === undefined ? {} : { sites: call.sites }) };
  return { run, script, capture };
}

/** What a replay's result starts with: which capture ran and the script it ran, for the agent to fix and run itself
 * when a step fails because the page differs. */
export function replayPreface(capture: RuntimeBrowserCapture, script: string): string {
  return `Replayed capture ${JSON.stringify(capture.name)} (${captureMention(capture.captureId)}) as this run script; \`args\` held the values you passed. A failed step says "Replay step N (…) failed": observe the page, then fix this script and run it.\n\`\`\`js\n${script}\n\`\`\``;
}

/**
 * `captureSaved`: the skill made from a capture is `path` (`.gitspace/skills/<slug>`, or its `SKILL.md`) at `commit`,
 * the working copy's commit holding that `SKILL.md` (`skillCommit` finds it, null when the file is not there). Writes it
 * into `capture.json`, so the Captures list shows Saved as skill.
 */
export async function saveCaptureSkill(drive: CaptureDrive, captureId: string, path: string, skillCommit: (file: string) => Promise<string | null>): Promise<RuntimeBrowserCapture> {
  const folder = path.trim().replace(/\/SKILL\.md$/u, '').replace(/\/+$/u, '');
  if (!SKILL_FOLDER.test(folder)) throw new Error(`A capture's skill is a folder .gitspace/skills/<slug> (letters, digits, dot, dash, underscore), not ${JSON.stringify(path)}.`);
  const capture = await readCapture(drive, captureId);
  if (!capture) throw new Error(`${captureMention(captureId)} is not a capture of this workspace: web_browser {action:"captures"} lists them.`);
  const commit = await skillCommit(`${folder}/SKILL.md`);
  if (!commit) throw new Error(`${folder}/SKILL.md is not in this workspace's files: write it (and ${folder}/replay.ts) first, then call captureSaved again.`);
  return writeCapture(drive, { ...capture, skill: { path: folder, commit } });
}

/** What the main conversation hears when you ask from your Chrome's saved-capture card to replay a capture. */
export function captureReplayAskedText(capture: RuntimeBrowserCapture): string {
  return `The user asked to replay capture ${JSON.stringify(capture.name)} (${captureMention(capture.captureId)}) from their Chrome. Read it with web_browser {action:"capture", capture:"${capture.captureId}"}, then replay it with {action:"replay", capture:"${capture.captureId}"} where it was recorded${capture.source === 'relay' ? ' (source:"relay" for their Chrome)' : ''}; ask them for any args it needs. Tell them how it went.`;
}
