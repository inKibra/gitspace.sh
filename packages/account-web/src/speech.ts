// What a Sequence player speaks with: the person's Speech voice and a clip of a line in it. The surface that has the
// Speech service provides it; without a provider the player shows captions on timing.
import { createContext } from 'react';

export interface SpeechClip { url: string; durationMs: number }

export interface Speech {
  /** The voice the person hears: the profile's Speech voice unless this browser overrides it; null when Speech is off. */
  voice: { id: string; label: string } | null;
  voices: readonly { id: string; label: string; description?: string }[];
  setBrowserVoice(id: string | null): void;
  /** A clip for `text` in the current voice; null when Speech is off or synthesis failed (the player then shows captions on timing). */
  clip(text: string, signal: AbortSignal): Promise<SpeechClip | null>;
}

/** Null: no provider, captions only. */
export const SpeechContext = createContext<Speech | null>(null);
