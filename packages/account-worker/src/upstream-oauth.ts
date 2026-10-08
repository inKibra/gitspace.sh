import type { AuthEvent, AuthPrompt, ModelAuth, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';
import { metaProvider } from '@earendil-works/pi-ai/providers/meta';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { ProviderRefreshError, upstreamOAuthProviderSchema, type StoredOAuthCredential, type UpstreamOAuthProvider } from '@gitspace/provider-auth';
import type { ProviderLoginEvent } from '@gitspace/protocol';

// Pi loads OAuth flows through variable import specifiers that a Worker bundle cannot follow; register the statically bundled flows instead.
registerBunOAuthFlows();

const providers = {
  openai: openaiProvider, 'github-copilot': githubCopilotProvider, openrouter: openrouterProvider,
  xai: xaiProvider, 'kimi-coding': kimiCodingProvider, meta: metaProvider,
} satisfies Record<UpstreamOAuthProvider, () => { auth: { oauth?: OAuthAuth } }>;

export function isUpstreamOAuthProvider(provider: string): provider is UpstreamOAuthProvider {
  return upstreamOAuthProviderSchema.safeParse(provider).success;
}

export function upstreamOAuth(provider: UpstreamOAuthProvider): OAuthAuth {
  const oauth = providers[provider]().auth.oauth;
  if (!oauth) throw new Error(`Pi provider ${provider} has no sign-in flow`);
  return oauth;
}

function upstreamCredential(credential: StoredOAuthCredential): OAuthCredential {
  const { provider: _provider, ...fields } = credential;
  return { ...fields, type: 'oauth' };
}

/** Best-effort account label from a JWT access token; Pi's flows don't return one. */
function tokenEmail(access: string): string | undefined {
  const payload = access.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/gu, '+').replace(/_/gu, '/')), character => character.charCodeAt(0))));
    if (!claims || typeof claims !== 'object') return undefined;
    const profile = 'https://api.openai.com/profile' in claims ? claims['https://api.openai.com/profile'] : undefined;
    const nested = profile && typeof profile === 'object' && 'email' in profile ? profile.email : undefined;
    const email = 'email' in claims ? claims.email : nested;
    return typeof email === 'string' && email.includes('@') ? email : undefined;
  } catch {
    return undefined;
  }
}

export function storedUpstreamCredential(provider: UpstreamOAuthProvider, credential: OAuthCredential): StoredOAuthCredential {
  const { type: _type, ...fields } = credential;
  const email = typeof fields.email === 'string' ? fields.email : tokenEmail(credential.access);
  return { ...fields, provider, access: credential.access, refresh: credential.refresh, expires: credential.expires, ...(email ? { email } : {}) };
}

export async function refreshUpstreamCredential(provider: UpstreamOAuthProvider, credential: StoredOAuthCredential): Promise<StoredOAuthCredential> {
  try {
    const refreshed = await upstreamOAuth(provider).refresh(upstreamCredential(credential), AbortSignal.timeout(30_000));
    return { ...storedUpstreamCredential(provider, refreshed), ...(credential.email && !tokenEmail(refreshed.access) ? { email: credential.email } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A provider that answered and refused the grant needs a new sign-in; anything else may succeed on retry.
    const rejected = /\((?:400|401|403)\)|invalid_grant|invalid_client|unauthorized/iu.test(message);
    throw new ProviderRefreshError(provider, rejected ? 'rejected' : 'network', `${provider} token refresh failed`);
  }
}

export async function upstreamRequestAuth(provider: UpstreamOAuthProvider, credential: StoredOAuthCredential): Promise<ModelAuth> {
  return upstreamOAuth(provider).toAuth(upstreamCredential(credential));
}

/** Pi's interaction events in the shape the sign-in dialog already renders. */
export function upstreamLoginEvent(event: AuthEvent): ProviderLoginEvent {
  switch (event.type) {
    case 'auth_url': {
      // Pi names itself on OpenAI's consent screen; the hint is display-only and outside PKCE and state.
      const url = new URL(event.url);
      if (url.searchParams.has('agent_name_hint')) url.searchParams.set('agent_name_hint', 'GitSpace');
      return { type: 'auth', url: url.toString(), launchUrl: url.toString(), instructions: event.instructions ?? 'Complete sign-in in your browser' };
    }
    case 'device_code': return { type: 'auth', url: event.verificationUri, launchUrl: event.verificationUri, instructions: `Enter code ${event.userCode}` };
    case 'info': return { type: 'progress', message: event.message };
    case 'progress': return { type: 'progress', message: event.message };
  }
}

/** Browsers in HTTPS-First mode show a loopback callback as https://; providers registered the http:// address. */
export function loopbackCallback(value: string): string {
  const url = URL.parse(value.trim());
  if (!url || url.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return value;
  url.protocol = 'http:';
  return url.toString();
}

export function upstreamPromptText(prompt: AuthPrompt): { message: string; placeholder: string } {
  if (prompt.type === 'select') {
    return { message: `${prompt.message} (${prompt.options.map(option => `${option.id}: ${option.label}`).join(', ')})`, placeholder: prompt.options[0]?.id ?? '' };
  }
  return { message: prompt.message, placeholder: prompt.placeholder ?? '' };
}
