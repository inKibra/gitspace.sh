import { wire } from './json-wire.js'
import { z } from 'zod';
import { runtimeConfigDocumentSchema, runtimeSettingValueSchema, type RuntimeSettingValue, type RuntimeSettingSchemaItem } from './user-settings.js';
import { RuntimeSubagentRecordSchema } from '@gitspace/protocol-runtime/session-controls';

export const DEFAULT_INFERENCE_PROFILE_ID = 'default';
export const INFERENCE_PROFILE_VERSION = 1 as const;
export type InferenceSettingSection = 'Models' | 'Providers' | 'Services';
/** Roles every profile offers; a profile may add its own. An unset role resolves to Default. */
export const BUILT_IN_MODEL_ROLES = ['default', 'deep', 'fast', 'taste'] as const;
export const MODEL_ROLE_LABELS: Readonly<Record<string, string>> = { default: 'Default', deep: 'Deep', fast: 'Fast', taste: 'Taste' };
/** Below this a role's context limit leaves too little room for a working conversation. */
export const MIN_CONTEXT_LIMIT = 32_000;
/** Per-role context limits: the window a role's model is used with; compaction keeps conversations below it. */
export const contextLimitsSchema = z.record(z.string(), z.number().int().min(MIN_CONTEXT_LIMIT));
export const modelRoleThinkingSchema = RuntimeSubagentRecordSchema.shape.thinking;
export type ModelRoleSelector = { selector: string; thinking: z.infer<typeof modelRoleThinkingSchema> };
/** Only a recognized terminal effort is syntax; provider model IDs may contain literal colons. */
export function parseModelRoleSelector(value: string): ModelRoleSelector {
  const separator = value.lastIndexOf(':');
  if (separator > value.indexOf('/')) {
    const thinking = modelRoleThinkingSchema.safeParse(value.slice(separator + 1));
    if (thinking.success) return { selector: value.slice(0, separator), thinking: thinking.data };
  }
  return { selector: value, thinking: null };
}
const unsafeSegments = new Set(['__proto__', 'prototype', 'constructor']);
const credentialFields: Record<string, true> = {
  apikey: true, accesstoken: true, refreshtoken: true, authorization: true, password: true,
  clientsecret: true, secretaccesskey: true, accesskeyid: true, sessiontoken: true,
  credential: true, credentials: true, apikeyhelper: true, authcommand: true, token: true,
  oauth: true, auth: true, cookie: true, authheaders: true,
};
const namedEntryMaps: Record<string, true> = {
  modelRoles: true, contextLimits: true, 'providers.models': true, 'providers.maxInFlightRequests': true,
};

const inferenceRootSections: Record<string, InferenceSettingSection> = {
  modelRoles: 'Models', contextLimits: 'Models', enabledModels: 'Models', visionFallback: 'Models', providers: 'Providers',
  search: 'Services', dictation: 'Services', images: 'Services', speech: 'Services', decisions: 'Services',
};
/** A service selector (`search`, `dictation`, `images`, `speech`, `decisions`): `cloudflare/<option>` runs on the platform's
 * Cloudflare account, `<provider>/<modelId>` on one of the profile's own credentials for that pi-ai provider. `SERVICE_OFF`
 * turns it off. */
export function parseServiceSelector(value: string): { provider: string; id: string } | null {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
/** The `search`, `dictation`, `images` or `speech` value that turns the service off: its agent tool (web_search, generate_image) is
 * not offered to the profile's conversations, the composer shows no microphone, and walkthroughs play captions only.
 * `decisions` off answers every decision with structured output on the profile's `fast` chat model. */
export const SERVICE_OFF = 'off';
/** Web search on Cloudflare's Web Search API, by its provider. */
export const CLOUDFLARE_SEARCH_PROVIDERS: Readonly<Record<string, true>> = { ceramic: true, linkup: true, exa: true };
/** Profile providers whose models search the web themselves (Anthropic's and OpenAI's keys and subscriptions, a Gemini key). */
export const SEARCH_MODEL_PROVIDERS: Readonly<Record<string, true>> = { anthropic: true, openai: true, google: true };
export const DEFAULT_SEARCH_SELECTOR = 'cloudflare/ceramic';
export const searchSelectorSchema = z.string().refine(value => {
  const selector = parseServiceSelector(value);
  return value === SERVICE_OFF || (selector !== null && (selector.provider === 'cloudflare' ? Object.hasOwn(CLOUDFLARE_SEARCH_PROVIDERS, selector.id) : Object.hasOwn(SEARCH_MODEL_PROVIDERS, selector.provider)));
}, 'Web search is off, cloudflare/ceramic, cloudflare/linkup, cloudflare/exa, or an anthropic, openai or google model');
/** Dictation on Cloudflare Workers AI: `nova-3` transcribes live, `whisper` after recording stops. */
export const CLOUDFLARE_DICTATION_MODELS: Readonly<Record<string, true>> = { 'nova-3': true, whisper: true };
export const DEFAULT_DICTATION_SELECTOR = 'cloudflare/nova-3';
export const dictationSelectorSchema = z.string().refine(value => {
  const selector = parseServiceSelector(value);
  return value === SERVICE_OFF || (selector !== null && (selector.provider === 'cloudflare' ? Object.hasOwn(CLOUDFLARE_DICTATION_MODELS, selector.id) : selector.provider === 'openai'));
}, 'Dictation is off, cloudflare/nova-3, cloudflare/whisper, or an openai transcription model');
/** Image generation on Cloudflare Workers AI: Black Forest Labs' FLUX models (`@cf/black-forest-labs/<model>`). */
export const CLOUDFLARE_IMAGE_MODELS: Readonly<Record<string, true>> = { 'flux-2-klein-9b': true, 'flux-2-klein-4b': true, 'flux-2-dev': true, 'flux-1-schnell': true };
/** The image service when `images` is unset and the profile has no image model of its own. */
export const DEFAULT_IMAGES_SELECTOR = 'cloudflare/flux-2-klein-9b';
export const imagesSelectorSchema = z.string().refine(value => {
  const selector = parseServiceSelector(value);
  return value === SERVICE_OFF || (selector !== null && (selector.provider !== 'cloudflare' || Object.hasOwn(CLOUDFLARE_IMAGE_MODELS, selector.id)));
}, 'Images is off, cloudflare/flux-2-klein-9b, cloudflare/flux-2-klein-4b, cloudflare/flux-2-dev, cloudflare/flux-1-schnell, or a provider/model image model of the profile');
/** Decisions on Cloudflare Workers AI: Cloudflare's Clef models (`@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef`)
 * and TypeSafe's Jev hosted there (`typesafe/jev`). */
export const CLOUDFLARE_DECISION_MODELS: Readonly<Record<string, true>> = { 'clef-flash': true, clef: true, jev: true };
export const DEFAULT_DECISIONS_SELECTOR = 'cloudflare/clef-flash';
export const decisionsSelectorSchema = z.string().refine(value => {
  const selector = parseServiceSelector(value);
  return value === SERVICE_OFF || (selector !== null && (selector.provider !== 'cloudflare' || Object.hasOwn(CLOUDFLARE_DECISION_MODELS, selector.id)));
}, 'Decisions is off, cloudflare/clef-flash, cloudflare/clef, cloudflare/jev, or a provider/model decision model of the profile');
/** One voice a speech model speaks with: `id` is what the request names, `description` one line for a picker. */
export interface SpeechVoice { id: string; label: string; description?: string }
/** Deepgram Aura-2 English on Cloudflare Workers AI (`@cf/deepgram/aura-2-en`), by speaker: the model's `speaker` enum,
 * described from Deepgram's voice table (expressed gender, accent, characteristics). */
export const AURA_2_EN_VOICES: readonly SpeechVoice[] = [
  { id: 'amalthea', label: 'Amalthea', description: 'Feminine, Filipino: engaging, natural, cheerful' },
  { id: 'andromeda', label: 'Andromeda', description: 'Feminine, American: casual, expressive, comfortable' },
  { id: 'apollo', label: 'Apollo', description: 'Masculine, American: confident, comfortable, casual' },
  { id: 'arcas', label: 'Arcas', description: 'Masculine, American: natural, smooth, clear' },
  { id: 'aries', label: 'Aries', description: 'Masculine, American: warm, energetic, caring' },
  { id: 'asteria', label: 'Asteria', description: 'Feminine, American: clear, confident, knowledgeable' },
  { id: 'athena', label: 'Athena', description: 'Feminine, American, mature: calm, smooth, professional' },
  { id: 'atlas', label: 'Atlas', description: 'Masculine, American, mature: enthusiastic, confident, friendly' },
  { id: 'aurora', label: 'Aurora', description: 'Feminine, American: cheerful, expressive, energetic' },
  { id: 'callista', label: 'Callista', description: 'Feminine, American: clear, energetic, professional' },
  { id: 'cora', label: 'Cora', description: 'Feminine, American: smooth, melodic, caring' },
  { id: 'cordelia', label: 'Cordelia', description: 'Feminine, American, young: approachable, warm, polite' },
  { id: 'delia', label: 'Delia', description: 'Feminine, American, young: casual, friendly, breathy' },
  { id: 'draco', label: 'Draco', description: 'Masculine, British: warm, trustworthy, baritone' },
  { id: 'electra', label: 'Electra', description: 'Feminine, American: professional, engaging, knowledgeable' },
  { id: 'harmonia', label: 'Harmonia', description: 'Feminine, American: empathetic, clear, calm' },
  { id: 'helena', label: 'Helena', description: 'Feminine, American: caring, natural, friendly, raspy' },
  { id: 'hera', label: 'Hera', description: 'Feminine, American: smooth, warm, professional' },
  { id: 'hermes', label: 'Hermes', description: 'Masculine, American: expressive, engaging, professional' },
  { id: 'hyperion', label: 'Hyperion', description: 'Masculine, Australian: caring, warm, empathetic' },
  { id: 'iris', label: 'Iris', description: 'Feminine, American, young: cheerful, positive, approachable' },
  { id: 'janus', label: 'Janus', description: 'Feminine, American Southern: smooth, trustworthy' },
  { id: 'juno', label: 'Juno', description: 'Feminine, American: natural, engaging, melodic, breathy' },
  { id: 'jupiter', label: 'Jupiter', description: 'Masculine, American: expressive, knowledgeable, baritone' },
  { id: 'luna', label: 'Luna', description: 'Feminine, American, young: friendly, natural, engaging' },
  { id: 'mars', label: 'Mars', description: 'Masculine, American: smooth, patient, baritone' },
  { id: 'minerva', label: 'Minerva', description: 'Feminine, American: positive, friendly, natural' },
  { id: 'neptune', label: 'Neptune', description: 'Masculine, American: professional, patient, polite' },
  { id: 'odysseus', label: 'Odysseus', description: 'Masculine, American: calm, smooth, professional' },
  { id: 'ophelia', label: 'Ophelia', description: 'Feminine, American: expressive, enthusiastic, cheerful' },
  { id: 'orion', label: 'Orion', description: 'Masculine, American: approachable, calm, polite' },
  { id: 'orpheus', label: 'Orpheus', description: 'Masculine, American: professional, clear, trustworthy' },
  { id: 'pandora', label: 'Pandora', description: 'Feminine, British: smooth, calm, melodic' },
  { id: 'phoebe', label: 'Phoebe', description: 'Feminine, American: energetic, warm, casual' },
  { id: 'pluto', label: 'Pluto', description: 'Masculine, American: smooth, calm, empathetic, baritone' },
  { id: 'saturn', label: 'Saturn', description: 'Masculine, American: knowledgeable, confident, baritone' },
  { id: 'thalia', label: 'Thalia', description: 'Feminine, American: clear, confident, energetic' },
  { id: 'theia', label: 'Theia', description: 'Feminine, Australian: expressive, polite, sincere' },
  { id: 'vesta', label: 'Vesta', description: 'Feminine, American: natural, patient, empathetic' },
  { id: 'zeus', label: 'Zeus', description: 'Masculine, American: deep, trustworthy, smooth' },
];
/** Speech on Cloudflare Workers AI, by model (`@cf/deepgram/<model>`), with the voices each speaks. */
export const CLOUDFLARE_SPEECH_MODELS: Readonly<Record<string, readonly SpeechVoice[]>> = { 'aura-2-en': AURA_2_EN_VOICES };
/** The voices of OpenAI's `POST /v1/audio/speech`, run with an OpenAI API key of the profile. */
export const OPENAI_SPEECH_VOICES: readonly SpeechVoice[] = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse']
  .map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
/** The speech service when `speech` is unset: Aura-2's Athena, calm and smooth, made for storytelling. */
export const DEFAULT_SPEECH_SELECTOR = 'cloudflare/aura-2-en:athena';
/** A speech selector (`<provider>/<model>:<voice>`) as its parts; null when it is not one. */
export function parseSpeechSelector(value: string): { provider: string; model: string; voice: string } | null {
  const selector = parseServiceSelector(value);
  const colon = selector ? selector.id.lastIndexOf(':') : -1;
  if (!selector || colon <= 0 || colon === selector.id.length - 1) return null;
  return { provider: selector.provider, model: selector.id.slice(0, colon), voice: selector.id.slice(colon + 1) };
}
/** The voices a speech selector's model speaks; empty for a provider speech does not run on. */
export function speechVoices(provider: string, model: string): readonly SpeechVoice[] {
  if (provider === 'cloudflare') return Object.hasOwn(CLOUDFLARE_SPEECH_MODELS, model) ? CLOUDFLARE_SPEECH_MODELS[model]! : [];
  return provider === 'openai' ? OPENAI_SPEECH_VOICES : [];
}
export const speechSelectorSchema = z.string().refine(value => {
  const selector = parseSpeechSelector(value);
  return value === SERVICE_OFF || (selector !== null && speechVoices(selector.provider, selector.model).some(voice => voice.id === selector.voice));
}, 'Speech is off, cloudflare/aura-2-en:<voice> with an Aura-2 voice, or openai/<tts model>:<voice>');
const serviceSelectors: Readonly<Record<string, z.ZodType<string>>> = { search: searchSelectorSchema, dictation: dictationSelectorSchema, images: imagesSelectorSchema, speech: speechSelectorSchema, decisions: decisionsSelectorSchema };
/** One ownership map shared by migration, editors and isolated runtime composition. */
export function inferenceSettingSection(path: string): InferenceSettingSection | null {
  const dot = path.indexOf('.');
  const root = dot < 0 ? path : path.slice(0, dot);
  return Object.hasOwn(inferenceRootSections, root) ? inferenceRootSections[root]! : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safePath(path: string): boolean {
  return path.length > 0 && path.split('.').every(part => part.length > 0 && !unsafeSegments.has(part));
}

export function isInferenceCredentialField(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot >= 0 && Object.hasOwn(namedEntryMaps, path.slice(0, dot))) return false;
  const key = path.slice(path.lastIndexOf('.') + 1).replace(/[-_]/gu, '').toLowerCase();
  return Object.hasOwn(credentialFields, key) || key.endsWith('apikey') || key.endsWith('authorization') || key.endsWith('token');
}

/** Returns paths, never credential values. Migration must vault or reject these fields. */
export function inferenceCredentialPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string' && /(?:^|\.)(?:base_?url|url|endpoint)$/iu.test(prefix)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return [prefix];
      for (const name of url.searchParams.keys()) {
        if (name === 'key' || isInferenceCredentialField(name)) return [prefix];
      }
    } catch { /* Endpoint syntax is validated by the provider, not the credential classifier. */ }
    return [];
  }
  if (!record(value) && !Array.isArray(value)) return [];
  const paths: string[] = [];
  const namedEntries = Object.hasOwn(namedEntryMaps, prefix);
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!namedEntries && isInferenceCredentialField(path) && child !== null && child !== '' && child !== undefined) paths.push(path);
    else paths.push(...inferenceCredentialPaths(child, path));
  }
  return paths;
}

/** Preserve complete owned subtrees (including custom roles/provider configuration). */
export function extractInferenceSettings(config: Record<string, unknown>): Record<string, RuntimeSettingValue> {
  const settings: Record<string, RuntimeSettingValue> = {};
  const visit = (value: Record<string, unknown>, prefix: string): void => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!safePath(path)) throw new Error('Unsafe configuration path');
      if (inferenceSettingSection(path)) {
        if (child !== undefined) settings[path] = structuredClone(runtimeSettingValueSchema.parse(child));
      } else if (record(child)) visit(child, path);
    }
  };
  visit(config, '');
  return settings;
}

/** Remove account/repository inference fields before applying a profile, including omitted fields. */
export function stripInferenceSettings(config: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!safePath(path)) throw new Error('Unsafe configuration path');
      if (inferenceSettingSection(path)) continue;
      result[key] = record(child) ? visit(child, path) : structuredClone(child);
    }
    return result;
  };
  return visit(config, '');
}

export function applyInferenceSettings(config: Record<string, unknown>, settings: Record<string, RuntimeSettingValue>): Record<string, unknown> {
  const result = stripInferenceSettings(config);
  // A schema-path edit takes precedence over its stored parent subtree, independent of JSON key order.
  for (const path of Object.keys(settings).sort((left, right) => left.split('.').length - right.split('.').length || left.localeCompare(right))) {
    if (!safePath(path) || !inferenceSettingSection(path)) throw new Error(`Setting does not belong to an inference profile: ${path}`);
    const parts = path.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) {
      if (!record(target[part])) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = structuredClone(settings[path]);
  }
  return result;
}

/** Profile editor metadata is independent of any machine-installed runtime schema. */
export const inferenceSettingMetadata: readonly RuntimeSettingSchemaItem[] = [
  { path: 'modelRoles', tab: 'Models', label: 'Model roles', kind: 'record', value: {}, defaultJson: '{}', credential: false },
  { path: 'contextLimits', tab: 'Models', label: 'Context limits', kind: 'record', value: {}, defaultJson: '{}', credential: false, description: 'Tokens per role, below its model\'s own window; compaction keeps conversations below it.' },
  { path: 'enabledModels', tab: 'Models', label: 'Enabled models', kind: 'array', value: [], defaultJson: '[]', credential: false },
  { path: 'visionFallback', tab: 'Models', label: 'Vision fallback', kind: 'string', value: '', defaultJson: '""', credential: false, description: 'Describes images for a model that cannot read them. Not offered as a role.' },
  { path: 'providers.models', tab: 'Providers', label: 'Custom provider models', kind: 'record', value: {}, defaultJson: '{}', credential: false, description: 'Non-secret provider endpoints and model definitions. Store credentials through the profile credential vault.' },
  { path: 'search', tab: 'Services', label: 'Web search', kind: 'string', value: DEFAULT_SEARCH_SELECTOR, defaultJson: JSON.stringify(DEFAULT_SEARCH_SELECTOR), credential: false, description: `Runs the agents' web_search tool. ${SERVICE_OFF}: web_search is not offered.` },
  { path: 'dictation', tab: 'Services', label: 'Dictation', kind: 'string', value: DEFAULT_DICTATION_SELECTOR, defaultJson: JSON.stringify(DEFAULT_DICTATION_SELECTOR), credential: false, description: `Transcribes the composer's microphone. ${SERVICE_OFF}: the composer has no microphone.` },
  { path: 'images', tab: 'Services', label: 'Images', kind: 'string', value: '', defaultJson: '""', credential: false, description: `Runs the agents' generate_image tool. Unset: the profile's first image model, else ${DEFAULT_IMAGES_SELECTOR}. ${SERVICE_OFF}: generate_image is not offered.` },
  { path: 'speech', tab: 'Services', label: 'Speech', kind: 'string', value: DEFAULT_SPEECH_SELECTOR, defaultJson: JSON.stringify(DEFAULT_SPEECH_SELECTOR), credential: false, description: `Narrates walkthroughs in the voice it names. ${SERVICE_OFF}: walkthroughs show captions only.` },
  { path: 'decisions', tab: 'Services', label: 'Decisions', kind: 'string', value: DEFAULT_DECISIONS_SELECTOR, defaultJson: JSON.stringify(DEFAULT_DECISIONS_SELECTOR), credential: false, description: `Answers typed questions for judge and the agents' decide tool. ${SERVICE_OFF}, or a failed answer: the profile's fast model answers.` },
];

const profileIdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);
const revisionSchema = z.number().int().nonnegative();
export const inferenceSettingsSchema = z.record(z.string(), runtimeSettingValueSchema).superRefine((settings, context) => {
  for (const [path, value] of Object.entries(settings)) {
    if (!safePath(path) || !inferenceSettingSection(path)) context.addIssue({ code: 'custom', path: [path], message: 'Setting is not owned by an inference profile' });
    if (isInferenceCredentialField(path) || inferenceCredentialPaths(value, path).length > 0) {
      context.addIssue({ code: 'custom', path: [path], message: 'Connect credentials through the profile credential vault, not configuration' });
    }
    const limits = path === 'contextLimits' ? value : path.startsWith('contextLimits.') ? { [path.slice('contextLimits.'.length)]: value } : undefined;
    if (limits !== undefined && !contextLimitsSchema.safeParse(limits).success) context.addIssue({ code: 'custom', path: [path], message: `A context limit is a whole number of tokens, at least ${MIN_CONTEXT_LIMIT.toLocaleString('en-US')}` });
    const root = path.split('.')[0]!;
    if (Object.hasOwn(serviceSelectors, root)) {
      const parsed = path === root ? serviceSelectors[root]!.safeParse(value) : null;
      if (!parsed?.success) context.addIssue({ code: 'custom', path: [path], message: parsed?.error.issues[0]?.message ?? `${root} is one selector` });
    }
  }
});
export const inferenceProfileSchema = z.strictObject({
  version: z.literal(INFERENCE_PROFILE_VERSION),
  id: profileIdSchema,
  name: z.string().trim().min(1).max(160),
  revision: revisionSchema,
  settings: inferenceSettingsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InferenceProfile = z.infer<typeof inferenceProfileSchema>;
export const inferenceAssignmentSchema = z.strictObject({ projectId: z.string().min(1).max(160), profileId: profileIdSchema, revision: revisionSchema });
export type InferenceAssignment = z.infer<typeof inferenceAssignmentSchema>;
export const inferenceStateSchema = z.strictObject({ version: z.literal(INFERENCE_PROFILE_VERSION), revision: revisionSchema, profiles: z.array(inferenceProfileSchema), assignments: z.array(inferenceAssignmentSchema) });
export type InferenceState = z.infer<typeof inferenceStateSchema>;
export const inferenceCreateInputSchema = z.strictObject({ name: z.string().trim().min(1).max(160), sourceProfileId: profileIdSchema.nullable() });
export type InferenceCreateInput = z.infer<typeof inferenceCreateInputSchema>;
export const inferenceUpdateInputSchema = z.strictObject({ profileId: profileIdSchema, expectedRevision: revisionSchema, name: z.string().trim().min(1).max(160), settings: inferenceSettingsSchema });
export type InferenceUpdateInput = z.infer<typeof inferenceUpdateInputSchema>;
export const inferenceDeleteInputSchema = z.strictObject({ profileId: profileIdSchema, expectedRevision: revisionSchema });
export type InferenceDeleteInput = z.infer<typeof inferenceDeleteInputSchema>;
export const inferenceAssignInputSchema = z.strictObject({ projectId: z.string().min(1).max(160), profileId: profileIdSchema, expectedRevision: revisionSchema });
export type InferenceAssignInput = z.infer<typeof inferenceAssignInputSchema>;
/** The most characters one speech clip speaks: a walkthrough frame's line. */
export const SPEECH_TEXT_MAX = 400;
/** `speech.clip`: `text` spoken in `voice` (a speech selector; unset, the profile's `speech`). With `workspace` the clip
 * is narration, kept in that workspace's drive, and refused when the profile's Speech is off; without one it is a
 * settings sample of `voice`, answered inline and not kept. `profileId` names the profile (unset: the workspace
 * project's, else Default). */
export const speechClipInputSchema = z.strictObject({
  workspace: z.strictObject({ projectId: z.string().min(1).max(160), workspaceId: z.string().min(1).max(160) }).nullable(),
  profileId: profileIdSchema.optional(),
  text: z.string().trim().min(1).max(SPEECH_TEXT_MAX),
  voice: speechSelectorSchema.refine(value => value !== SERVICE_OFF, 'A clip is spoken in a voice, not off').optional(),
}).refine(value => value.workspace !== null || value.voice !== undefined, 'A sample names its voice');
export type SpeechClipInput = z.infer<typeof speechClipInputSchema>;
/** A spoken clip: `url` plays it (a signed drive link, or a `data:` URL for a sample); `duration` says whether
 * `durationMs` was read from the audio's frames or estimated from its size and bitrate. */
export const speechClipSchema = z.strictObject({ url: z.string().min(1), durationMs: z.number().int().nonnegative(), duration: z.enum(['measured', 'estimated']) });
export type SpeechClipResult = z.infer<typeof speechClipSchema>;

/** Private machine/OMP IPC only: never send this bearer through browser state or events. */
export const inferenceExecutionContextSchema = z.strictObject({
  version: z.literal(INFERENCE_PROFILE_VERSION),
  projectId: z.string().min(1).max(160).nullable(),
  assignmentRevision: revisionSchema.nullable(),
  profile: inferenceProfileSchema,
  advanced: runtimeConfigDocumentSchema,
  broker: z.strictObject({ url: z.string().url(), token: z.string().min(1) }),
}).refine(value => (value.projectId === null) === (value.assignmentRevision === null), 'Project identity and assignment revision must be bound together');
export type InferenceExecutionContext = z.infer<typeof inferenceExecutionContextSchema>;

/**
 * Same credential scope: project, profile identity and broker binding. Only a scope
 * change needs a fresh agent worker; revisions of the same profile (roles, models,
 * providers), assignment revisions and shared Advanced settings apply in place.
 */
export function sameInferenceScope(left: InferenceExecutionContext, right: InferenceExecutionContext): boolean {
  return left.projectId === right.projectId && left.profile.id === right.profile.id
    && left.broker.url === right.broker.url && left.broker.token === right.broker.token;
}

export const InferenceStateCodec = wire.serializable((value): value is InferenceState => inferenceStateSchema.safeParse(value).success, { id: 'gitspace/inference-state/v1', jsonSchema: inferenceStateSchema });
export const InferenceCreateInputCodec = wire.serializable((value): value is InferenceCreateInput => inferenceCreateInputSchema.safeParse(value).success, { id: 'gitspace/inference-create/v1', jsonSchema: inferenceCreateInputSchema });
export const InferenceUpdateInputCodec = wire.serializable((value): value is InferenceUpdateInput => inferenceUpdateInputSchema.safeParse(value).success, { id: 'gitspace/inference-update/v1', jsonSchema: inferenceUpdateInputSchema });
export const InferenceDeleteInputCodec = wire.serializable((value): value is InferenceDeleteInput => inferenceDeleteInputSchema.safeParse(value).success, { id: 'gitspace/inference-delete/v1', jsonSchema: inferenceDeleteInputSchema });
export const InferenceAssignInputCodec = wire.serializable((value): value is InferenceAssignInput => inferenceAssignInputSchema.safeParse(value).success, { id: 'gitspace/inference-assign/v1', jsonSchema: inferenceAssignInputSchema });
export const SpeechClipInputCodec = wire.serializable((value): value is SpeechClipInput => speechClipInputSchema.safeParse(value).success, { id: 'gitspace/speech-clip-input/v1', jsonSchema: speechClipInputSchema });
export const SpeechClipCodec = wire.serializable((value): value is SpeechClipResult => speechClipSchema.safeParse(value).success, { id: 'gitspace/speech-clip/v1', jsonSchema: speechClipSchema });
