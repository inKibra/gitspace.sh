// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@gitspace/ui';
import type { ProviderAccount, ProviderUsage, ProviderView } from '@gitspace/protocol';
import { ProvidersSection, SignInFlowView, formatUsageAmount, formatUsageReset, type ProviderLoginFlow, type ProvidersSectionProps } from './ProvidersSection.js';

const rejects = async (): Promise<never> => { throw new Error('not called during render'); };
const noop = (): void => undefined;

function provider(overrides: Partial<ProviderView> & Pick<ProviderView, 'id' | 'name'>): ProviderView {
  return { credentialProvider: overrides.id, available: true, loginable: true, supportsOAuth: true, supportsApiKey: false, authKind: 'none', hasAuth: false, source: null, accounts: [], hasUsage: false, ...overrides };
}
function account(overrides: Partial<ProviderAccount> & Pick<ProviderAccount, 'id' | 'label'>): ProviderAccount {
  return { type: 'oauth', email: null, disabled: false, outUntil: null, outReason: null, ...overrides };
}
const max = account({ id: 'cred-1', label: 'dev@example.com', email: 'dev@example.com' });
const ops = account({ id: 'cred-2', label: 'ops@example.com', email: 'ops@example.com' });
const key = account({ id: 'cred-3', type: 'api_key', label: 'API key ····41aa' });
const anthropic = provider({ id: 'anthropic', name: 'Anthropic', authKind: 'oauth', supportsApiKey: true, hasAuth: true, hasUsage: true, accounts: [max, ops, key] });
const openai = provider({ id: 'openai', name: 'OpenAI', supportsOAuth: false, supportsApiKey: true, loginable: false });
const codex = provider({ id: 'openai-codex', name: 'OpenAI Codex' });
const gemini = provider({ id: 'google-gemini-cli', name: 'Google Gemini CLI', supportsApiKey: true });
const hidden = provider({ id: 'ollama', name: 'Ollama', available: false, loginable: false, supportsOAuth: false });
const report = (credentialId: string, fetchedAt = '2026-09-01T10:00:00.000Z'): ProviderUsage['reports'][number] => ({
  credentialId, provider: 'anthropic', account: 'dev@example.com', fetchedAt, notes: ['Limits reset on a rolling window.'],
  limits: [
    { id: '5h', label: '5 hours', scope: 'account', window: '5 hours', unit: 'percent', used: 62, limit: 100, remaining: 38, remainingFraction: 0.38, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), status: 'ok' },
    { id: '7d', label: 'Weekly', scope: 'account', window: '7d', unit: 'tokens', used: 950_000, limit: 1_000_000, remaining: 50_000, remainingFraction: 0.05, resetsAt: null, status: 'warning' },
    { id: 'credits', label: 'Credits', scope: 'account', window: null, unit: 'credits', used: null, limit: null, remaining: null, remainingFraction: 0.25, resetsAt: null, status: null },
  ],
});
const refused = { credentialId: 'cred-2', provider: 'anthropic', account: 'ops@example.com', message: 'The provider refused the usage read (HTTP 403, permission_error: needs scope user:profile). Sign in again to grant it.' };
const usage: ProviderUsage = { generatedAt: '2026-09-01T10:05:00.000Z', reports: [report('cred-1')], errors: [refused] };

function props(overrides: Partial<ProvidersSectionProps> = {}): ProvidersSectionProps {
  return {
    providers: [anthropic, openai, codex, gemini, hidden],
    usage: null,
    usageStatus: 'idle',
    onShow: noop,
    onRefreshUsage: rejects,
    onSignIn: rejects,
    onDisableAccount: rejects,
    onEnableAccount: rejects,
    onRemoveAccount: rejects,
    onSetApiKey: rejects,
    login: { flow: null, respond: rejects, cancel: rejects },
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (overrides: Partial<ProvidersSectionProps> = {}) => act(() => root.render(<ProvidersSection {...props(overrides)} />));
const row = (id: string): Element => {
  const found = container.querySelector(`[data-account="${id}"]`);
  if (!found) throw new Error(`No account row ${id}`);
  return found;
};
const card = (id: string): Element => {
  const found = container.querySelector(`[data-provider="${id}"]`);
  if (!found) throw new Error(`No provider card ${id}`);
  return found;
};

describe('ProvidersSection', () => {
  it('puts connected providers first with their accounts, and offers the rest under Add a provider with how each connects', async () => {
    await render();
    const headings = [...container.querySelectorAll('h2')].map((heading) => heading.textContent);
    expect(headings).toEqual(['Connected', 'Add a provider']);
    expect(card('anthropic').textContent).toContain('3 of 3 accounts in use');
    expect(card('anthropic').textContent).toContain('Add account');
    expect(card('openai').textContent).toContain('Add API key');
    expect(card('openai-codex').textContent).toContain('Sign in');
    expect(card('google-gemini-cli').textContent).toContain('Connect');
    expect(container.textContent).not.toContain('Ollama');
    // Sign-in providers before key-only ones.
    const order = [...container.querySelectorAll('[data-provider]')].map((element) => element.getAttribute('data-provider'));
    expect(order).toEqual(['anthropic', 'openai-codex', 'google-gemini-cli', 'openai']);
  });

  it("shows each account's own usage, and a failed read only on the account it failed for", async () => {
    await render({ usage, usageStatus: 'ready' });
    expect(row('cred-1').querySelector('[role="meter"][aria-label="5 hours used"]')?.getAttribute('aria-valuenow')).toBe('62');
    expect(row('cred-1').querySelector('[role="meter"][aria-label="Weekly · 7d used"]')?.getAttribute('aria-valuenow')).toBe('95');
    expect(row('cred-1').querySelector('[role="meter"][aria-label="Credits used"]')?.getAttribute('aria-valuenow')).toBe('75');
    expect(row('cred-1').textContent).toContain('62% used');
    expect(row('cred-1').textContent).toContain('resets in 2h');
    expect(row('cred-1').textContent).toContain('Limits reset on a rolling window.');
    expect(row('cred-1').textContent).not.toContain('refused');
    expect(row('cred-2').textContent).toContain('needs scope user:profile');
    expect(row('cred-2').textContent).toContain('Inference still uses this account.');
    expect(row('cred-2').querySelector('[role="meter"]')).toBeNull();
    expect(row('cred-3').textContent).toContain('Anthropic doesn’t report usage for API keys.');
    expect(container.textContent).toContain('Partial usage as of');
  });

  it('shows shared credentials and their usage once across sign-in aliases', async () => {
    const connected = provider({ ...codex, hasAuth: true, hasUsage: true, accounts: [account({ id: 'personal', label: 'same@example.com · Personal' }), account({ id: 'team', label: 'same@example.com · Team' })] });
    const device = provider({ ...connected, id: 'openai-codex-device', name: 'Codex device code', credentialProvider: connected.id });
    await render({ providers: [device, connected], usage: { ...usage, reports: [{ ...report('personal'), provider: device.id }], errors: [] }, usageStatus: 'ready' });
    expect(container.querySelectorAll('[data-account]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="meter"][aria-label="5 hours used"]')).toHaveLength(1);
    expect(row('team').textContent).toContain('No usage reported.');
  });

  it('says on each account whether usage is unchecked, being checked, or from the last read, and dates usage by the oldest report', async () => {
    await render({ providers: [anthropic] });
    expect(row('cred-1').textContent).toContain('Usage has not been checked yet.');
    await render({ providers: [anthropic], usageStatus: 'loading' });
    expect(row('cred-1').textContent).toContain('Checking usage…');
    await render({ providers: [anthropic], usage, usageStatus: 'loading' });
    expect(row('cred-1').querySelector('[role="meter"]')).not.toBeNull();
    const oldest = '2026-09-01T08:00:00.000Z';
    await render({ providers: [anthropic], usage: { ...usage, reports: [report('cred-1'), report('cred-2', oldest)], errors: [] }, usageStatus: 'ready' });
    expect(container.textContent).toContain(`Usage as of ${new Date(oldest).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    await render({ providers: [anthropic], usage, usageStatus: 'error', usageError: 'Connection lost' });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Usage unavailable: Connection lost');
    expect(row('cred-1').querySelector('[role="meter"]')).not.toBeNull();
  });

  it('marks an account off, paused only while its outUntil is in the future, or in use', async () => {
    const paused = account({ id: 'paused', label: 'out@example.com', outUntil: new Date(Date.now() + 3_600_000).toISOString(), outReason: 'Weekly usage limit reached' });
    const recovered = account({ id: 'recovered', label: 'back@example.com', outUntil: new Date(Date.now() - 60_000).toISOString(), outReason: 'Rate limited' });
    const off = account({ id: 'off', label: 'old@example.com', disabled: true });
    await render({ providers: [provider({ ...codex, hasAuth: true, accounts: [paused, recovered, off] })] });
    expect(row('paused').textContent).toContain('Paused · back');
    expect(row('paused').textContent).toContain('Weekly usage limit reached. Inference skips this account until then.');
    expect(row('recovered').textContent).toContain('In use');
    expect(row('recovered').textContent).not.toContain('Rate limited');
    expect(row('off').textContent).toContain('Off');
    expect(card('openai-codex').textContent).toContain('1 of 3 accounts in use');
  });

  it("acts on the account whose menu was used: turning it off or on, and removing it only after confirming", async () => {
    const onDisableAccount = vi.fn(async (): Promise<void> => undefined);
    const onEnableAccount = vi.fn(async (): Promise<void> => undefined);
    const onRemoveAccount = vi.fn(async (): Promise<void> => undefined);
    const confirm = vi.fn((_message: string): boolean => false);
    vi.stubGlobal('confirm', confirm);
    const off = account({ id: 'off', label: 'old@example.com', disabled: true });
    await render({ providers: [provider({ ...codex, hasAuth: true, accounts: [max, off] })], onDisableAccount, onEnableAccount, onRemoveAccount });
    const choose = async (accountLabel: string, action: string) => {
      await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${accountLabel}"]`)!.click(); });
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent?.includes(action));
      if (!(item instanceof HTMLElement)) throw new Error(`No menu item ${action}`);
      await act(async () => { item.click(); });
    };
    await choose('dev@example.com', 'Turn off');
    expect(onDisableAccount).toHaveBeenCalledExactlyOnceWith('openai-codex', 'cred-1');
    await choose('old@example.com', 'Turn on');
    expect(onEnableAccount).toHaveBeenCalledExactlyOnceWith('openai-codex', 'off');
    await choose('dev@example.com', 'Remove…');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('dev@example.com'));
    expect(onRemoveAccount).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await choose('dev@example.com', 'Remove…');
    expect(onRemoveAccount).toHaveBeenCalledExactlyOnceWith('openai-codex', 'cred-1');
  });

  it('shows the list failure instead of cards and the usage error in the header', () => {
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
  const flow = (events: ProviderLoginFlow['events']): ProviderLoginFlow => ({ flowId: 'flow-1', profileId: 'default', providerId: 'anthropic', events });
  // Title/Description need Base UI's dialog root context; the popup itself is portaled and never server-renders.
  const renderFlow = (current: ProviderLoginFlow): string => renderToStaticMarkup(<Dialog open><SignInFlowView flow={current} providerName="Anthropic" login={{ flow: current, ...login }} onRetry={noop} /></Dialog>);

  it('renders the pending state before the provider answers', () => {
    const html = renderFlow(flow([]));
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
    const html = renderFlow(flow(events));
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
    const html = renderFlow({
      flowId: 'device-flow',
      profileId: 'client-a',
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
    const okHtml = renderFlow(ok);
    expect(okHtml).toContain('Signed in to Anthropic as dev@example.com');
    expect(okHtml).toContain('Close');
    expect(okHtml).not.toContain('Retry');
    const failed = flow([{ type: 'auth', url: 'https://example.com', launchUrl: null, instructions: null }, { type: 'done', ok: false, error: 'state mismatch' }]);
    const failedHtml = renderFlow(failed);
    expect(failedHtml).toContain('state mismatch');
    expect(failedHtml).toContain('Retry');
    expect(failedHtml).not.toContain('Open sign-in page');
  });
});
