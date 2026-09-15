import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog } from '@gitspace/ui';
import type { ProviderUsage, ProviderView } from '@gitspace/protocol';
import { ProvidersSection, SignInFlowView, formatUsageAmount, formatUsageReset, type ProviderLoginFlow, type ProvidersSectionProps } from './ProvidersSection.js';

const rejects = async (): Promise<never> => { throw new Error('not called during render'); };
const noop = (): void => undefined;

function provider(overrides: Partial<ProviderView> & Pick<ProviderView, 'id' | 'name'>): ProviderView {
  return { credentialProvider: overrides.id, available: true, loginable: true, authKind: 'oauth', hasAuth: false, source: null, accounts: [], hasUsage: false, ...overrides };
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

  it('shows shared credentials and usage once while keeping distinct accounts and providers', () => {
    const accounts: ProviderView['accounts'] = [
      { id: 'personal', type: 'oauth', label: 'same@example.com · Personal', email: 'same@example.com', disabled: false },
      { id: 'team', type: 'oauth', label: 'same@example.com · Team', email: 'same@example.com', disabled: false },
    ];
    const connected = provider({ ...codex, hasAuth: true, hasUsage: true, accounts });
    const device = provider({ ...connected, id: 'openai-codex-device', name: 'Codex device code', credentialProvider: connected.id });
    const separate = provider({ ...anthropic, accounts: [{ id: 'claude', type: 'oauth', label: 'same@example.com · Claude', email: 'same@example.com', disabled: false }] });
    const html = renderToStaticMarkup(<ProvidersSection {...props({
      providers: [device, separate, connected],
      usage: { ...usage, reports: [{ ...usage.reports[0]!, provider: connected.id }], errors: [] },
    })} />);
    expect(html).toContain('Anthropic');
    expect(html.match(/aria-label="Remove /g)).toHaveLength(3);
    expect(html).toContain('aria-label="Remove same@example.com · Personal"');
    expect(html).toContain('aria-label="Remove same@example.com · Team"');
    expect(html.match(/62% used/g)).toHaveLength(1);
  });

  it('renders usage limits with meters and resets without errors for disconnected providers', () => {
    const html = renderToStaticMarkup(<ProvidersSection {...props({ usage, usageStatus: 'ready' })} />);
    expect(html).toContain('62% used');
    expect(html).toContain('resets in 2h');
    expect(html).toContain('950K / 1M tokens');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="38"');
    expect(html).toContain('Limits reset on a rolling window.');
    // Codex has no auth, so its usage error is not shown under the row.
    expect(html).not.toContain('not signed in');
  });

  it('identifies the connected Codex account without usage instead of showing a successful fetch time', () => {
    const connected = provider({ ...codex, hasAuth: true, hasUsage: true, accounts: [{ id: 'codex', type: 'oauth', label: 'bradleat@inkibra.com', email: 'bradleat@inkibra.com', disabled: false }] });
    const html = renderToStaticMarkup(<ProvidersSection {...props({
      providers: [connected],
      usageStatus: 'ready',
      usage: { generatedAt: usage.generatedAt, reports: [], accountsWithoutUsage: ['openai-codex: bradleat@inkibra.com'], errors: [] },
    })} />);
    expect(html).toContain('Usage unavailable for bradleat@inkibra.com.');
    expect(html).not.toContain('Usage as of');
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain('0% used');
  });

  it('keeps partial reports visible and identifies missing accounts and provider and aggregate errors once across aliases', () => {
    const connected = provider({ ...codex, hasAuth: true, hasUsage: true, accounts: [
      { id: 'personal', type: 'oauth', label: 'personal@example.com', email: 'personal@example.com', disabled: false },
      { id: 'team', type: 'oauth', label: 'team@example.com', email: 'team@example.com', disabled: false },
    ] });
    const device = provider({ ...connected, id: 'openai-codex-device', name: 'Codex device code', credentialProvider: connected.id });
    const html = renderToStaticMarkup(<ProvidersSection {...props({
      providers: [device, connected],
      usageStatus: 'ready',
      usage: {
        generatedAt: '2026-09-01T15:00:00.000Z',
        reports: [{ ...usage.reports[0]!, provider: device.id, account: 'personal@example.com' }],
        accountsWithoutUsage: ['openai-codex-device: team@example.com'],
        errors: [{ provider: device.id, message: 'Team quota request failed' }, { provider: '*', message: 'Some usage requests timed out' }],
      },
    })} />);
    expect(html.match(/62% used/g)).toHaveLength(1);
    expect(html).toContain('Usage unavailable for team@example.com.');
    expect(html.match(/Team quota request failed/g)).toHaveLength(1);
    expect(html.match(/Some usage requests timed out/g)).toHaveLength(1);
    const reportTime = new Date(usage.reports[0]!.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(html).toContain(`Partial usage as of ${reportTime}`);
    expect(html).not.toContain(`as of ${new Date('2026-09-01T15:00:00.000Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  });

  it('shows aggregate failures on supported connected cards without treating unsupported providers as failed', () => {
    const html = renderToStaticMarkup(<ProvidersSection {...props({
      providers: [anthropic, provider({ ...openai, hasAuth: true })],
      usageStatus: 'ready',
      usage: { generatedAt: usage.generatedAt, reports: [], accountsWithoutUsage: [], errors: [{ provider: '*', message: 'Usage service offline' }] },
    })} />);
    expect(html.match(/Usage unavailable: Usage service offline/g)).toHaveLength(1);
    expect(html).toContain('Usage reporting is not supported for this provider.');
    expect(html).not.toContain('Usage as of');
  });

  it('distinguishes supported idle and loading cards from a completed empty response', () => {
    const idle = renderToStaticMarkup(<ProvidersSection {...props({ providers: [anthropic] })} />);
    expect(idle).toContain('Usage has not been checked yet.');
    const loading = renderToStaticMarkup(<ProvidersSection {...props({ providers: [anthropic], usageStatus: 'loading' })} />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain('Checking usage…');
    expect(loading).not.toContain('Usage has not been checked yet.');
    const empty = renderToStaticMarkup(<ProvidersSection {...props({
      providers: [anthropic],
      usageStatus: 'ready',
      usage: { generatedAt: usage.generatedAt, reports: [], accountsWithoutUsage: [], errors: [] },
    })} />);
    expect(empty).toContain('Usage unavailable.');
    expect(empty).not.toContain('Usage as of');
  });

  it('preserves known usage during refresh and exposes transport errors on the connected card', () => {
    const refreshing = renderToStaticMarkup(<ProvidersSection {...props({ providers: [anthropic], usage, usageStatus: 'loading' })} />);
    expect(refreshing).toContain('62% used');
    expect(refreshing).toContain('Refreshing usage…');
    const failed = renderToStaticMarkup(<ProvidersSection {...props({ providers: [anthropic], usage, usageStatus: 'error', usageError: 'Connection lost' })} />);
    expect(failed).toContain('62% used');
    expect(failed).toContain('Usage unavailable: Connection lost');
    expect(failed).not.toContain('Usage as of');
  });

  it('timestamps available data using the oldest report rather than the request completion', () => {
    const fetchedAt = '2026-09-01T08:00:00.000Z';
    const html = renderToStaticMarkup(<ProvidersSection {...props({
      providers: [anthropic],
      usageStatus: 'ready',
      usage: { ...usage, reports: [usage.reports[0]!, { ...usage.reports[0]!, account: 'other@example.com', fetchedAt }], errors: [] },
    })} />);
    expect(html).toContain(`Usage as of ${new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
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

  it('shows device authorization without asking the user to paste a callback', () => {
    const html = render({
      flowId: 'device-flow',
      providerId: 'openai-codex-device',
      events: [{ type: 'auth', url: 'https://auth.openai.com/codex/device', launchUrl: null, instructions: 'Enter code: ABCD-EFGH' }],
    });
    expect(html).toContain('ABCD-EFGH');
    expect(html).toContain('href="https://auth.openai.com/codex/device"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('id="provider-login-prompt"');
    expect(html).not.toContain('type="submit"');
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
    expect(failedHtml).toContain('Retry');
    expect(failedHtml).not.toContain('Open sign-in page');
  });
});
