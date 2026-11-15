// The Speech service's voice: the Services row's picker (provider and model, voice, sample, Off) and the onboarding Voice
// step (every Aura voice with a sample, and Off). Samples speak a fixed sentence through `speech.clip`.
import { Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle, Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { PlayCircle, StopCircle } from '@untitledui/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AURA_2_EN_VOICES, DEFAULT_INFERENCE_PROFILE_ID, DEFAULT_SPEECH_SELECTOR, SERVICE_OFF, parseServiceSelector, parseSpeechSelector, speechVoices } from '@gitspace/protocol/inference';
import { glyph } from './glyph.js';
import { useInference } from './InferenceContext.js';
import { updatedProfileSettings } from './inference-settings.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** What a sample says. */
export const SPEECH_SAMPLE_TEXT = 'Here is what changed, one step at a time: the order is saved before the slot is held.';
const PlayGlyph = glyph(PlayCircle);
const StopGlyph = glyph(StopCircle);
/** Speech models a profile can choose, by `provider/model`; OpenAI's needs an OpenAI API key of the profile. */
const CLOUDFLARE_SPEECH_MODEL = { value: 'cloudflare/aura-2-en', label: 'Cloudflare · Aura-2 English' };
const OPENAI_SPEECH_MODEL = { value: 'openai/gpt-4o-mini-tts', label: 'OpenAI · gpt-4o-mini-tts' };
/** Samples already spoken in this page, by profile and voice: playing one again costs nothing. */
const samples = new Map<string, Promise<string>>();

interface VoiceSample {
  /** The voice (a speech selector) whose sample is loading or playing, or null. */
  playing: string | null;
  error: string | null;
  toggle(voice: string): void;
}

/** One sample at a time, spoken by `speech.clip` in `profileId`'s account; starting another or leaving stops it. */
function useVoiceSample(profileId: string): VoiceSample {
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const turn = useRef(0);
  useEffect(() => () => { turn.current += 1; audio.current?.pause(); }, []);
  const toggle = (voice: string): void => {
    const current = ++turn.current;
    audio.current?.pause();
    audio.current = null;
    setError(null);
    if (playing === voice) { setPlaying(null); return; }
    setPlaying(voice);
    const key = `${profileId}\n${voice}`;
    let url = samples.get(key);
    if (!url) {
      url = rpcClient.speech.clip({ workspace: null, profileId, text: SPEECH_SAMPLE_TEXT, voice }).then((result) => {
        if (result.status === 'error') throw result.error;
        return result.value.url;
      });
      samples.set(key, url);
      url.catch(() => samples.delete(key));
    }
    void url.then(async (source) => {
      if (current !== turn.current) return;
      const element = new Audio(source);
      audio.current = element;
      element.addEventListener('ended', () => { if (current === turn.current) setPlaying(null); });
      await element.play();
    }).catch((cause: unknown) => {
      if (current !== turn.current) return;
      setPlaying(null);
      setError(rpcErrorMessage(cause, 'Play a voice sample'));
    });
  };
  return { playing, error, toggle };
}

function SampleButton({ voice, label, sample }: { voice: string; label: string; sample: VoiceSample }) {
  const playing = sample.playing === voice;
  return <Button variant="ghost" size="compact" type="button" aria-pressed={playing} aria-label={`${playing ? 'Stop' : 'Play'} the ${label} sample`} leadingIcon={playing ? StopGlyph : PlayGlyph} onClick={() => sample.toggle(voice)}>{playing ? 'Stop' : 'Sample'}</Button>;
}

/** The Services row's control: provider and model (or Off), the voice with its description, and a sample of it. */
export function SpeechServicePicker({ value, profileId, openAiKey, disabled, onChange }: { value: string; profileId: string; openAiKey: boolean; disabled: boolean; onChange(value: string): void }) {
  const sample = useVoiceSample(profileId);
  const selector = value === SERVICE_OFF ? null : parseSpeechSelector(value || DEFAULT_SPEECH_SELECTOR);
  const model = selector ? `${selector.provider}/${selector.model}` : SERVICE_OFF;
  const voices = selector ? speechVoices(selector.provider, selector.model) : [];
  const voice = voices.find((entry) => entry.id === selector?.voice);
  const models = [CLOUDFLARE_SPEECH_MODEL, ...(openAiKey || selector?.provider === 'openai' ? [OPENAI_SPEECH_MODEL] : [])];
  if (selector && !models.some((option) => option.value === model)) models.push({ value: model, label: model });
  // Another model keeps the voice when it has one of that name, else takes its first (Aura-2: the default voice).
  const chooseModel = (next: string): void => {
    if (next === model) return;
    const parsed = next === SERVICE_OFF ? null : parseServiceSelector(next);
    if (!parsed) { onChange(SERVICE_OFF); return; }
    const available = speechVoices(parsed.provider, parsed.id);
    const kept = available.find((entry) => entry.id === selector?.voice);
    onChange(kept ? `${next}:${kept.id}` : next === CLOUDFLARE_SPEECH_MODEL.value ? DEFAULT_SPEECH_SELECTOR : `${next}:${available[0]?.id ?? ''}`);
  };
  return <span className="flex flex-col items-end gap-1">
    <span className="flex flex-wrap items-center justify-end gap-2">
      {selector && voice ? <SampleButton voice={value || DEFAULT_SPEECH_SELECTOR} label={voice.label} sample={sample} /> : null}
      {selector ? <Select value={selector.voice} disabled={disabled} onValueChange={(next) => { if (next && next !== selector.voice) onChange(`${model}:${next}`); }}>
        <SelectTrigger aria-label="Speech voice" className="w-40" />
        <SelectContent>{voices.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{entry.label}</SelectItem>)}</SelectContent>
      </Select> : null}
      <Select value={model} disabled={disabled} onValueChange={(next) => { if (next) chooseModel(next); }}>
        <SelectTrigger aria-label="Speech" className="w-60" />
        <SelectContent>{[{ value: SERVICE_OFF, label: 'Off · captions only' }, ...models].map((option, index) => <SelectItem key={option.value} value={option.value} index={index}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </span>
    {voice?.description ? <span className="max-w-80 text-right text-caption text-muted-foreground">{voice.label}: {voice.description}</span> : null}
    {sample.error ? <span role="alert" className="max-w-80 text-right text-caption text-destructive">{sample.error}</span> : null}
  </span>;
}

/** The onboarding Voice step: what narration is, every Aura voice with a sample, and Off, saved to the Default profile.
 * Nothing here blocks Continue. */
export function VoiceSetup(): ReactNode {
  const inference = useInference();
  const profile = inference?.state?.profiles.find((entry) => entry.id === DEFAULT_INFERENCE_PROFILE_ID);
  const sample = useVoiceSample(DEFAULT_INFERENCE_PROFILE_ID);
  const [error, setError] = useState<string | null>(null);
  const stored = profile?.settings.speech;
  const selected = typeof stored === 'string' ? stored : DEFAULT_SPEECH_SELECTOR;
  const choose = (value: string): void => {
    if (!inference || !profile || value === selected || inference.pending) return;
    setError(null);
    void inference.update(profile, profile.name, updatedProfileSettings(profile, 'speech', value)).catch((cause: unknown) => setError(rpcErrorMessage(cause, 'Save the narration voice')));
  };
  return <>
    <p className="text-body text-muted-foreground">Agents can narrate walkthroughs; pick the voice you&rsquo;ll hear. Off shows each line as a caption only. You can change it later in Inference → Services → Speech.</p>
    <section aria-label="Narration voice" className="flex flex-col gap-3">
      <h2 className="text-subtitle font-semibold text-foreground">Narration voice</h2>
      {!profile ? <p role="status" className="text-caption text-muted-foreground">Loading the Default inference profile…</p> : <CardGroup orientation="inline" border="outlined" separated>
        {AURA_2_EN_VOICES.map((voice, index) => {
          const value = `${CLOUDFLARE_SPEECH_MODEL.value}:${voice.id}`;
          return <Card key={voice.id} index={index} size="compact" selected={selected === value} onClick={() => choose(value)} label={`Narrate with ${voice.label}`}>
            <CardHeader><CardTitle>{voice.label}{value === DEFAULT_SPEECH_SELECTOR ? <Badge size="compact" color="gray">Default</Badge> : null}{selected === value ? <Badge size="compact" color="blue">Selected</Badge> : null}</CardTitle><CardDescription>{voice.description}</CardDescription></CardHeader>
            <CardFooter><SampleButton voice={value} label={voice.label} sample={sample} /></CardFooter>
          </Card>;
        })}
        <Card index={AURA_2_EN_VOICES.length} size="compact" selected={selected === SERVICE_OFF} onClick={() => choose(SERVICE_OFF)} label="Captions only, no voice">
          <CardHeader><CardTitle>Off (captions only){selected === SERVICE_OFF ? <Badge size="compact" color="blue">Selected</Badge> : null}</CardTitle><CardDescription>Walkthroughs play silently; each frame&rsquo;s line shows as its caption.</CardDescription></CardHeader>
        </Card>
      </CardGroup>}
      {error ?? sample.error ? <p role="alert" className="text-caption text-destructive">{error ?? sample.error}</p> : null}
    </section>
  </>;
}
