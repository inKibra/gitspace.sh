// The Speech a workspace's content plays narration with (`speech.ts`): the voice of the project's inference profile,
// unless this browser picked another voice of the same model, and clips of lines in it from `speech.clip`, kept in the
// workspace's drive by the worker and here in memory per voice and text.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_INFERENCE_PROFILE_ID, DEFAULT_SPEECH_SELECTOR, SERVICE_OFF, parseSpeechSelector, speechVoices } from '@gitspace/protocol/inference';
import { currentDevice } from './device-session.js';
import { useInference } from './InferenceContext.js';
import { rpcClient } from './rpc-client.js';
import { SpeechContext, type Speech, type SpeechClip } from './speech.js';

/** This browser's voice for an account's narration: a speech selector of the profile's model. */
export function browserVoiceKey(accountId: string): string { return `gitspace.speech.voice:${accountId}`; }

function storedVoice(accountId: string): string | null {
  try { return window.localStorage.getItem(browserVoiceKey(accountId)); } catch { return null; /* private mode */ }
}

export function SpeechProvider({ projectId, workspaceId, children }: { projectId: string; workspaceId: string; children: ReactNode }) {
  const state = useInference()?.state;
  const profileId = state?.assignments.find((assignment) => assignment.projectId === projectId)?.profileId ?? DEFAULT_INFERENCE_PROFILE_ID;
  const stored = state?.profiles.find((profile) => profile.id === profileId)?.settings.speech;
  // Unknown until the profiles load: captions until then.
  const configured = state ? typeof stored === 'string' ? stored : DEFAULT_SPEECH_SELECTOR : SERVICE_OFF;
  const [accountId, setAccountId] = useState<string | null>(null);
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void currentDevice().then((device) => {
      if (!live || !device) return;
      setAccountId(device.userId);
      setOverride(storedVoice(device.userId));
    });
    return () => { live = false; };
  }, []);
  const clips = useRef(new Map<string, Promise<SpeechClip | null>>());
  const speech = useMemo<Speech>(() => {
    const selector = configured === SERVICE_OFF ? null : parseSpeechSelector(configured);
    const model = selector ? `${selector.provider}/${selector.model}` : '';
    const voices = selector ? speechVoices(selector.provider, selector.model).map((voice) => ({ id: `${model}:${voice.id}`, label: voice.label, ...(voice.description ? { description: voice.description } : {}) })) : [];
    const chosen = voices.find((voice) => voice.id === override) ?? voices.find((voice) => voice.id === configured);
    const voice = chosen ? { id: chosen.id, label: chosen.label } : null;
    return {
      voice, voices,
      setBrowserVoice(id) {
        setOverride(id);
        if (!accountId) return;
        try {
          if (id === null) window.localStorage.removeItem(browserVoiceKey(accountId));
          else window.localStorage.setItem(browserVoiceKey(accountId), id);
        } catch { /* private mode: the choice lasts until the page reloads */ }
      },
      async clip(text, signal) {
        if (!voice) return null;
        const key = `${voice.id}\n${text}`;
        let pending = clips.current.get(key);
        if (!pending) {
          // Shared by every player of this line: one caller's abort does not cancel it.
          pending = rpcClient.speech.clip({ workspace: { projectId, workspaceId }, text, voice: voice.id }).then((result) => result.status === 'ok' ? { url: result.value.url, durationMs: result.value.durationMs } : null, () => null);
          clips.current.set(key, pending);
          void pending.then((clip) => { if (!clip) clips.current.delete(key); });
        }
        const clip = await pending;
        return signal.aborted ? null : clip;
      },
    };
  }, [configured, override, accountId, projectId, workspaceId]);
  return <SpeechContext.Provider value={speech}>{children}</SpeechContext.Provider>;
}
