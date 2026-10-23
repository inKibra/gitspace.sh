import { describe, expect, it } from 'vitest';
import { classifyAuthFailure, orderedAccounts, providerResetAt, type CredentialAccount, type VaultAccess } from './selection';

const now = 10_000_000;
function account(id: string, fields: Partial<CredentialAccount> = {}): CredentialAccount {
  return { id, provider: 'anthropic', type: 'oauth', revision: 1, expiresAt: now + 3_600_000, identity: `account:${id}`, ...fields };
}
function vault(accounts: readonly CredentialAccount[]): VaultAccess {
  return {
    async list() { return accounts; },
    async resolve() { throw new Error('Selection must not resolve or refresh credentials'); },
    async recordFailure() { throw new Error('Selection must not record failures'); },
  };
}
async function order(accounts: readonly CredentialAccount[], workspaceId = 'workspace-a') {
  return orderedAccounts({ profileId: 'profile-a', provider: 'anthropic', workspaceId, now, vault: vault(accounts) });
}
const workspaces = Array.from({ length: 12 }, (_, index) => `workspace-${index}`);

describe('profile account selection', () => {
  it('starts every request of a workspace on one account and spreads workspaces across accounts', async () => {
    const accounts = [account('first'), account('second')];
    const chosen = await Promise.all(workspaces.map(async workspaceId => (await order(accounts, workspaceId))[0]?.id));
    expect(new Set(chosen)).toEqual(new Set(['first', 'second']));
    expect(await Promise.all(workspaces.map(async workspaceId => (await order(accounts, workspaceId))[0]?.id))).toEqual(chosen);
  });
  it('keeps a workspace on its account while a different account cools down', async () => {
    const accounts = [account('first'), account('second'), account('third')];
    for (const workspaceId of workspaces) {
      const [own, ...others] = await order(accounts, workspaceId);
      for (const cooling of others) {
        const selected = await order(accounts.map(value => value.id === cooling.id ? { ...value, cooldownUntil: now + 60_000 } : value), workspaceId);
        expect(selected[0]?.id).toBe(own?.id);
      }
    }
  });
  it('retains every account when all usage collectors are unavailable and keeps cold ordering stable', async () => {
    const accounts = [account('first'), account('second'), account('third')];
    const selected = await order(accounts);
    expect(new Set(selected.map(value => value.id))).toEqual(new Set(['first', 'second', 'third']));
    expect(await order(accounts)).toEqual(selected);
  });
  it('skips cooling accounts and other providers', async () => {
    const selected = await order([account('cooling', { cooldownUntil: now + 1 }), account('other-provider', { provider: 'cursor' }), account('ready', { cooldownUntil: now })]);
    expect(selected.map(value => value.id)).toEqual(['ready']);
  });
  it('says when the first account is back once every account is out', async () => {
    await expect(order([account('later', { cooldownUntil: now + 7_200_000 }), account('sooner', { cooldownUntil: now + 3_600_000 })]))
      .rejects.toThrow(`out until ${new Date(now + 3_600_000).toUTCString()}`);
  });
  it('ignores stale usage observations when comparing accounts', async () => {
    const accounts = [account('first'), account('second')];
    const baseline = await order(accounts);
    const last = baseline[1];
    if (!last) throw new Error('Expected two eligible accounts');
    const stale = accounts.map(value => value.id === last.id ? { ...value, usage: { usedFraction: 0, observedAt: now - 300_000 } } : value);
    expect((await order(stale)).map(value => value.id)).toEqual(baseline.map(value => value.id));
  });
  it('ranks secondary reset urgency before primary headroom without treating weekly utilization as a hot short window', async () => {
    const weekly = account('weekly', { usage: { usedFraction: 0.95, observedAt: now, primary: { usedFraction: 0.4, resetsAt: now + 3_600_000 }, secondary: { usedFraction: 0.95, resetsAt: now + 60_000 } } });
    const cooler = account('cooler', { usage: { usedFraction: 0.1, observedAt: now, primary: { usedFraction: 0.1, resetsAt: now + 60_000 }, secondary: { usedFraction: 0.1, resetsAt: now + 7 * 24 * 3_600_000 } } });
    expect((await order([cooler, weekly, account('unknown')])).map(value => value.id)).toEqual(['weekly', 'cooler', 'unknown']);
  });
  it('demotes a hot primary window behind unknown usage regardless of secondary drain urgency', async () => {
    const hot = account('hot', { usage: { usedFraction: 0.85, observedAt: now, primary: { usedFraction: 0.85 }, secondary: { usedFraction: 0.1, resetsAt: now + 60_000 } } });
    expect((await order([hot, account('unknown')])).map(value => value.id)).toEqual(['unknown', 'hot']);
  });
  it('retains a valid secondary observation after the primary reset passes', async () => {
    const reset = account('reset', { usage: { usedFraction: 1, observedAt: now, resetsAt: now, primary: { usedFraction: 1, resetsAt: now }, secondary: { usedFraction: 0.2, resetsAt: now + 3_600_000 } } });
    expect((await order([account('unknown'), reset])).map(value => value.id)).toEqual(['reset', 'unknown']);
  });
});

describe('provider-aware auth retry classification', () => {
  it('refreshes ordinary authentication failures before selecting siblings', () => {
    expect(classifyAuthFailure('Unauthorized', 401)).toBe('refresh');
    expect(classifyAuthFailure('access token expired')).toBe('refresh');
  });
  it('rotates quota and account-policy failures without repeating refresh', () => {
    expect(classifyAuthFailure('insufficient_quota', 429)).toBe('rotate');
    expect(classifyAuthFailure('account suspended', 401)).toBe('rotate');
    expect(classifyAuthFailure('Forbidden', 403)).toBe('rotate');
  });
  it('does not interpret a concurrency cap as exhausted quota even with throttling status', () => {
    expect(classifyAuthFailure('too many concurrent requests', 429)).toBe('none');
    expect(classifyAuthFailure('concurrency limit reached', 403)).toBe('none');
  });
  it('does not rotate accounts for an unrelated transport or provider outage', () => {
    expect(classifyAuthFailure('Service unavailable', 503)).toBe('none');
    expect(classifyAuthFailure('Connection reset')).toBe('none');
  });
});

describe('provider reset of a rejected account', () => {
  it('uses the Claude subscription reset only when that limit rejected the request', () => {
    const reset = { 'anthropic-ratelimit-unified-reset': String((now + 18_000_000) / 1000), 'retry-after': '30' };
    expect(providerResetAt({ ...reset, 'anthropic-ratelimit-unified-status': 'rejected' }, now)).toBe(now + 18_000_000);
    expect(providerResetAt({ ...reset, 'anthropic-ratelimit-unified-status': 'allowed_warning' }, now)).toBe(now + 30_000);
  });
  it('reads Retry-After as milliseconds, seconds, or a date, and nothing without one', () => {
    expect(providerResetAt({ 'retry-after-ms': '1500' }, now)).toBe(now + 1500);
    expect(providerResetAt({ 'retry-after': '120' }, now)).toBe(now + 120_000);
    expect(providerResetAt({ 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' }, now)).toBe(Date.parse('Wed, 21 Oct 2099 07:28:00 GMT'));
    expect(providerResetAt({ 'retry-after': 'soon' }, now)).toBeUndefined();
    expect(providerResetAt({}, now)).toBeUndefined();
  });
});
