import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog } from '@gitspace/ui';
import type { ProviderUsage, ProviderView } from '@gitspace/protocol';
import { ProvidersSection, SignInFlowView, formatUsageAmount, formatUsageReset, type ProviderLoginFlow, type ProvidersSectionProps } from './ProvidersSection.js';

const rejects = async (): Promise<never> => { throw new Error('not called during render'); };
const noop = (): void => undefined;

function provider(overrides: Partial<ProviderView> & Pick<ProviderView, 'id' | 'name'>): ProviderView {
  return { available: true, loginable: true, authKind: 'oauth', hasAuth: false, source: null, accounts: [], hasUsage: false, ...overrides };
}
const anthropic = provider({ id: 'anthropic', name: 'Anthropic', hasAuth: true, source: 'oauth', hasUsage: true, accounts: [{ id: 'cred-1', type: 'oauth', label: 'Claude Max', email: 'dev@example.com', disabled: false }] });
const openai = provider({ id: 'openai', name: 'OpenAI', authKind: 'api_key', loginable: false });
const codex = provider({ id: 'openai-codex', name: 'OpenAI Codex' });
const hidden = provider({ id: 'ollama', name: 'Ollama', available: false, loginable: false, authKind: 'none' });
const usage: ProviderUsage = {
  generatedAt: '2026-09-01T10:00:00.000Z',
  reports: [{
    provider: 'anthropic',
    account: 'dev@example.com',
    fetchedAt: '2026-09-01T10:00:00.000Z',
    limits: [
      { id: '5h', label: 'Session', scope: 'account', window: '5h', unit: 'percent', used: 62, limit: 100, remaining: 38, remainingFraction: 0.38, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), status: 'ok' },
      { id: '7d', label: 'Weekly', scope: 'account', window: '7d', unit: 'tokens', used: 950_000, limit: 1_000_000, remaining: 50_000, remainingFraction: 0.05, resetsAt: null, status: 'warning' },
    ],
    notes: ['Limits reset on a rolling window.'],
  }],
  accountsWithoutUsage: [],
  errors: [{ provider: 'openai-codex', message: 'not signed in' }],
};

function props(overrides: Partial<ProvidersSectionProps> = {}): ProvidersSectionProps {
  return {
    providers: [anthropic, openai, codex, hidden],
    usage: null,
    usageStatus: 'idle',
    onShow: noop,
    onRefreshUsage: rejects,
    onSignIn: rejects,
    onSignOut: rejects,
    onSetApiKey: rejects,
    login: { flow: null, respond: rejects, cancel: rejects },
    ...overrides,
  };
}

describe('ProvidersSection', () => {
  it('renders connected and unconnected provider rows with the right actions', () => {
    const html = renderToStaticMarkup(<ProvidersSection {...props()} />);
    expect(html).toContain('Anthropic');
    expect(html).toContain('dev@example.com');
    expect(html).toContain('Connected');
    expect(html).toContain('aria-label="Remove Claude Max"');
    expect(html).toContain('Add account');
    expect(html).toContain('OpenAI Codex');
    expect(html).toContain('Not signed in');
    expect(html).toContain('Sign in');
    expect(html).toContain('Add API key');
    expect(html).toContain('aria-label="Refresh usage"');
    expect(html).not.toContain('Ollama');
    expect(html).not.toContain('role="meter"');
  });

  it('renders usage limits with meters, resets, and per-provider usage errors under connected rows', () => {
    const html = renderToStaticMarkup(<ProvidersSection {...props({ usage, usageStatus: 'ready' })} />);
    expect(html).toContain('62% used');
    expect(html).toContain('resets in 2h');
    expect(html).toContain('950K / 1M tokens');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="38"');
    expect(html).toContain('bg-destructive" style="width:5%"');
    expect(html).toContain('bg-foreground" style="width:38%"');
    expect(html).toContain('Limits reset on a rolling window.');
    // Codex has no auth, so its usage error is not shown under the row.
    expect(html).not.toContain('not signed in');
  });

  it('shows the list failure instead of rows and the usage error in the header', () => {
    const html = renderToStaticMarkup(<ProvidersSection {...props({ error: 'machine offline', usageStatus: 'error', usageError: 'usage timed out' })} />);
    expect(html).toContain('Providers are unavailable');
    expect(html).toContain('machine offline');
    expect(html).toContain('usage timed out');
    expect(html).not.toContain('Anthropic');
  });

  it('formats usage amounts and reset times', () => {
    expect(formatUsageAmount({ id: 'a', label: 'A', scope: 's', window: null, unit: 'usd', used: 1.5, limit: 10, remaining: 8.5, remainingFraction: 0.85, resetsAt: null, status: null })).toBe('$1.50 / $10.00');
    expect(formatUsageAmount({ id: 'a', label: 'A', scope: 's', window: null, unit: 'requests', used: null, limit: 500, remaining: 120, remainingFraction: null, resetsAt: null, status: null })).toBe('120 of 500 requests left');
    expect(formatUsageAmount({ id: 'a', label: 'A', scope: 's', window: null, unit: 'unknown', used: null, limit: null, remaining: null, remainingFraction: 0.25, resetsAt: null, status: null })).toBe('25% left');
    const now = Date.parse('2026-09-01T10:00:00.000Z');
    expect(formatUsageReset('2026-09-01T10:00:30.000Z', now)).toBe('resets now');
    expect(formatUsageReset('2026-09-01T13:15:00.000Z', now)).toBe('resets in 3h 15m');
    expect(formatUsageReset('not a date', now)).toBeNull();
    expect(formatUsageReset(null, now)).toBeNull();
  });
});

describe('SignInFlowView', () => {
  const login = { respond: rejects, cancel: rejects };
  const flow = (events: ProviderLoginFlow['events']): ProviderLoginFlow => ({ flowId: 'flow-1', providerId: 'anthropic', events });
  // Title/Description need Base UI's dialog root context; the popup itself is portaled and never server-renders.
  const render = (current: ProviderLoginFlow): string => renderToStaticMarkup(<Dialog open><SignInFlowView flow={current} providerName="Anthropic" login={{ flow: current, ...login }} onRetry={noop} /></Dialog>);

  it('renders the pending state before the provider answers', () => {
    const html = render(flow([]));
    expect(html).toContain('Sign in to Anthropic');
    expect(html).toContain('Starting sign-in…');
    expect(html).toContain('Cancel');
  });

  it('renders the auth URL, progress, and prompt', () => {
    const events: ProviderLoginFlow['events'] = [
      { type: 'auth', url: 'https://claude.ai/oauth/authorize?state=abc', launchUrl: null, instructions: 'Approve GitSpace in the browser.' },
      { type: 'progress', message: 'Waiting for the callback…' },
      { type: 'prompt', promptId: 'code', message: 'Paste the authorization code', placeholder: 'code#state' },
    ];
    const html = render(flow(events));
    expect(html).toContain('https://claude.ai/oauth/authorize?state=abc');
    expect(html).toContain('href="https://claude.ai/oauth/authorize?state=abc"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Open sign-in page');
    expect(html).toContain('Approve GitSpace in the browser.');
    expect(html).toContain('Waiting for the callback…');
    expect(html).toContain('Paste the authorization code');
    expect(html).toContain('placeholder="code#state"');
    expect(html).toContain('Continue');
    expect(html).not.toContain('Starting sign-in…');
  });

  it('renders success and failure terminal states', () => {
    const ok = flow([{ type: 'done', ok: true, provider: anthropic }]);
    const okHtml = render(ok);
    expect(okHtml).toContain('Signed in to Anthropic as dev@example.com.');
    expect(okHtml).toContain('Close');
    expect(okHtml).not.toContain('Retry');
    const failed = flow([{ type: 'auth', url: 'https://example.com', launchUrl: null, instructions: null }, { type: 'done', ok: false, error: 'state mismatch' }]);
    const failedHtml = render(failed);
    expect(failedHtml).toContain('state mismatch');
    expect(failedHtml).toContain('text-destructive');
    expect(failedHtml).toContain('Retry');
    expect(failedHtml).not.toContain('Open sign-in page');
  });
});
