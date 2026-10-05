import type { ProviderLoginFlow } from './ProvidersSection.js';

export type RecoverableProviderLogin = Pick<ProviderLoginFlow, 'profileId' | 'providerId' | 'flowId'>;
const PREFIX = 'gitspace:provider-login:';

/** Only opaque flow identity is retained. OAuth URLs, codes, tokens and PKCE never enter browser storage. */
export function saveProviderLogin(flow: RecoverableProviderLogin): void {
  localStorage.setItem(`${PREFIX}${flow.profileId}`, JSON.stringify(flow));
}

export function readProviderLogin(profileId: string): RecoverableProviderLogin | null {
  const raw = localStorage.getItem(`${PREFIX}${profileId}`);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || !('profileId' in value) || value.profileId !== profileId || !('providerId' in value) || typeof value.providerId !== 'string' || !value.providerId || !('flowId' in value) || typeof value.flowId !== 'string' || !value.flowId) throw new Error('Saved sign-in identity is invalid. Cancel it before starting another sign-in.');
  return { profileId, providerId: value.providerId, flowId: value.flowId };
}

export function forgetProviderLogin(profileId: string): void {
  localStorage.removeItem(`${PREFIX}${profileId}`);
}
