import type { WorkerOAuthProvider } from './schemas';

// Client-registration metadata vendored from @oh-my-pi/pi-catalog 18.2.11,
// src/compat/rules.json (MIT; see ../LICENSE). Preserve upstream encodings;
// these are application registration values, not users' access/refresh tokens.
//
// Explore Pi OAuth for the remaining local login/refresh flows once its Worker
// packaging, durable login state, and provider coverage fit our cloud contract.
// Keep OpenAI routes distinct: legacy Codex device-code credentials use the
// ChatGPT web backend, which has rejected Cloudflare egress; Pi's working
// "Sign in with ChatGPT" route uses api.openai.com/v1. Vendoring changes neither.
const clients = {
  anthropic: {
    client_id: atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl'),
  },
  'openai-codex': {
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  },
} as const;

export function oauthClient(provider: WorkerOAuthProvider): { client_id: string } {
  switch (provider) {
    case 'anthropic':
    case 'openai-codex':
      return clients[provider];
    default:
      throw new Error(`OAuth client metadata is owned by Pi, not GitSpace, for ${provider}`);
  }
}
