import type { LoginState, WorkerOAuthProvider } from './schemas';

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
  'google-gemini-cli': {
    client_id: atob('NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t'),
    client_secret: atob('R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw='),
  },
  'google-antigravity': {
    client_id: atob('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='),
    client_secret: atob('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY='),
  },
} as const satisfies {
  [Provider in Exclude<LoginState['provider'], 'cursor'>]: Provider extends 'google-gemini-cli' | 'google-antigravity'
    ? { client_id: string; client_secret: string }
    : { client_id: string };
};

export function oauthClient(provider: Exclude<WorkerOAuthProvider, 'cursor'>): { client_id: string } & Record<string, string> {
  switch (provider) {
    case 'anthropic':
    case 'openai-codex':
    case 'google-gemini-cli':
    case 'google-antigravity':
      return clients[provider];
    default:
      throw new Error(`OAuth client metadata is owned by Pi, not GitSpace, for ${provider}`);
  }
}
