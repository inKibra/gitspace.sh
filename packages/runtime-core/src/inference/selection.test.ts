import { describe, expect, it } from 'vitest';
import { classifyAuthFailure, orderedAccounts, type CredentialAccount, type CredentialPin, type VaultAccess } from './selection';

const now = 10_000_000;
function account(id: string, fields: Partial<CredentialAccount> = {}): CredentialAccount {
  return { id, provider: 'anthropic', type: 'oauth', revision: 1, expiresAt: now + 3_600_000, identity: `account:${id}`, ...fields };
}
function vault(accounts: readonly CredentialAccount[]): VaultAccess {
  return {
    async list() { return accounts; },
    async resolve() { throw new Error('Selection must not resolve or refresh credentials'); },
  };
}
async function order(accounts: readonly CredentialAccount[], pin: CredentialPin | null = null, conversationId = 'conversation-a') {
  return orderedAccounts({ profileId: 'profile-a', provider: 'anthropic', conversationId, now, vault: vault(accounts), pins: { async read() { return pin; }, async write() { throw new Error('Reading candidates must not change the durable pin'); } } });
}

describe('profile account selection', () => {
  it('keeps a warm conversation on its admitted account even when another has lower measured usage', async () => {
    const pinned = account('pinned', { usage: { usedFraction: 0.9, observedAt: now } });
    const free = account('free', { usage: { usedFraction: 0.1, observedAt: now } });
    expect((await order([free, pinned], { credentialId: 'pinned', lastUsedAt: now - 1000 }))[0]?.id).toBe('pinned');
  });
  it('allows separate durable conversation pins to select different same-provider accounts', async () => {
    const accounts = [account('first'), account('second')];
    const [first, second] = await Promise.all([
      order(accounts, { credentialId: 'first', lastUsedAt: now }, 'conversation-a'),
      order(accounts, { credentialId: 'second', lastUsedAt: now }, 'conversation-b'),
    ]);
    expect(first[0]?.id).toBe('first');
    expect(second[0]?.id).toBe('second');
  });
  it('retains every account when all usage collectors are unavailable and keeps cold ordering stable', async () => {
    const accounts = [account('first'), account('second'), account('third')];
    const selected = await order(accounts);
    expect(new Set(selected.map(value => value.id))).toEqual(new Set(['first', 'second', 'third']));
    expect(await order(accounts)).toEqual(selected);
  });
  it('retires Anthropic idle pins exactly at the one-hour boundary', async () => {
    const accounts = [account('pinned', { usage: { usedFraction: 0.9, observedAt: now } }), account('available', { usage: { usedFraction: 0.1, observedAt: now } })];
    expect((await order(accounts, { credentialId: 'pinned', lastUsedAt: now - 3_600_000 }))[0]?.id).toBe('available');
  });
  it('does not let a warm pin bypass cooldown or admit a different provider', async () => {
    const selected = await order([account('cooling', { cooldownUntil: now + 1 }), account('other-provider', { provider: 'cursor' }), account('ready', { cooldownUntil: now })], { credentialId: 'cooling', lastUsedAt: now });
    expect(selected.map(value => value.id)).toEqual(['ready']);
  });
  it('ignores stale usage observations when comparing unpinned accounts', async () => {
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
