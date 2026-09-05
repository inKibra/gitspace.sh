import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { calculateCreditExposureBound, calculateUsageCharges, totalChargeMicros } from '../src/credits.js';
import type { CreditLedgerRecord } from '../src/credit-ledger.js';

function ledgerRecord(id: string, debitMicros: number): CreditLedgerRecord {
  return {
    id,
    resource: 'worker-request',
    quantity: '1',
    rateVersion: 'cloudflare-2026-08-27',
    debitMicros,
    windowStart: '2026-08-27T00:00:00.000Z',
    windowEnd: '2026-08-27T00:01:00.000Z',
    createdAt: '2026-08-27T00:01:01.000Z',
  };
}

describe('Cloudflare rate card', () => {
  it('uses published gross rates and leaves R2 egress free', () => {
    const result = calculateUsageCharges([
      { resource: 'worker-request', quantity: 1_000_000n },
      { resource: 'do-request', quantity: 1_000_000n },
      { resource: 'r2-class-a', quantity: 1_000_000n },
      { resource: 'r2-egress-byte', quantity: 10_000_000_000n },
    ]);
    expect(result.status).toBe('ok');
    if (result.status === 'error') throw result.error;
    expect(result.value.map((charge) => charge.debitMicros)).toEqual([300_000n, 150_000n, 4_500_000n, 0n]);
    expect(totalChargeMicros(result.value)).toBe(4_950_000n);
  });

  it('refuses to claim a finite exposure bound without an enforced tenant burn ceiling', () => {
    const unbounded = calculateCreditExposureBound({
      analyticsLagMs: 60_000,
      pollIntervalMs: 10_000,
      enforcementLatencyMs: 5_000,
      prepaidRiskReserveMicros: 1_000n,
      maxBurnMicrosPerSecond: null,
    });
    expect(unbounded).toMatchObject({ status: 'error', error: { _tag: 'UnboundedCreditExposure' } });

    const bounded = calculateCreditExposureBound({
      analyticsLagMs: 60_000,
      pollIntervalMs: 10_000,
      enforcementLatencyMs: 5_000,
      prepaidRiskReserveMicros: 1_000n,
      maxBurnMicrosPerSecond: 10n,
    });
    expect(bounded).toMatchObject({
      status: 'ok',
      value: {
        detectionWindowMs: 75_000,
        unreportedBurnMicros: 750n,
        totalExposureMicros: 1_750n,
      },
    });
  });
});

describe('CreditLedgerDO', () => {
  it('reserves and settles idempotently', async () => {
    const credits = env.CREDITS.getByName('alpha');
    const configured = await credits.configure({ balanceMicros: 1_000, riskReserveMicros: 100 });
    expect(configured).toMatchObject({ status: 'ok', value: { availableMicros: 900 } });

    const reservation = { id: 'request-1', amountMicros: 100, expiresAt: Date.now() + 30_000 };
    const firstReserve = await credits.reserveDispatch(reservation);
    const duplicateReserve = await credits.reserveDispatch(reservation);
    expect(firstReserve).toMatchObject({ status: 'ok', value: { account: { reservedMicros: 100, availableMicros: 800 } } });
    expect(duplicateReserve).toMatchObject({ status: 'ok', value: { account: { reservedMicros: 100, availableMicros: 800 } } });

    const firstSettle = await credits.settleDispatch({ reservationId: reservation.id, ledger: ledgerRecord('dispatch:request-1', 1) });
    const duplicateSettle = await credits.settleDispatch({ reservationId: reservation.id, ledger: ledgerRecord('dispatch:request-1', 1) });
    expect(firstSettle).toMatchObject({ status: 'ok', value: { applied: true, account: { balanceMicros: 999, reservedMicros: 0 } } });
    expect(duplicateSettle).toMatchObject({ status: 'ok', value: { applied: false, account: { balanceMicros: 999, reservedMicros: 0 } } });

    const firstUsage = await credits.applyUsage(ledgerRecord('usage:window-1', 50));
    const duplicateUsage = await credits.applyUsage(ledgerRecord('usage:window-1', 50));
    expect(firstUsage).toMatchObject({ status: 'ok', value: { applied: true, account: { balanceMicros: 949 } } });
    expect(duplicateUsage).toMatchObject({ status: 'ok', value: { applied: false, account: { balanceMicros: 949 } } });
    expect(await credits.listLedger()).toHaveLength(2);
    expect(await credits.usageSummary()).toEqual({ records: 2, debitedMicros: 51 });
  });


  it('keeps the risk reserve unavailable and blocks quarantined tenants', async () => {
    const credits = env.CREDITS.getByName('limited');
    await credits.configure({ balanceMicros: 100, riskReserveMicros: 90 });
    expect(await credits.reserveDispatch({ id: 'too-large', amountMicros: 11, expiresAt: Date.now() + 30_000 }))
      .toMatchObject({ status: 'error', error: { code: 'INSUFFICIENT_CREDITS' } });
    await credits.quarantine('hostile test');
    expect(await credits.reserveDispatch({ id: 'after-quarantine', amountMicros: 1, expiresAt: Date.now() + 30_000 }))
      .toMatchObject({ status: 'error', error: { code: 'ACCOUNT_QUARANTINED' } });
  });

  it('restores a quarantined balance without changing prepaid funds', async () => {
    const credits = env.CREDITS.getByName('restorable');
    await credits.configure({ balanceMicros: 100, riskReserveMicros: 20 });
    await credits.quarantine('operator review');
    expect(await credits.resume()).toMatchObject({ status: 'ok', value: { status: 'active', balanceMicros: 100, riskReserveMicros: 20 } });
  });
});


describe('TenantControlDO', () => {
  it('persists quarantine, suspension, and restoration reasons', async () => {
    const control = env.TENANT_CONTROL.getByName('controlled');
    expect(await control.get()).toEqual({ status: 'active', reason: null, updatedAt: null });
    expect(await control.set({ status: 'quarantined', reason: 'abuse review' })).toMatchObject({ status: 'quarantined', reason: 'abuse review' });
    expect(await control.set({ status: 'suspended', reason: 'manual hold' })).toMatchObject({ status: 'suspended', reason: 'manual hold' });
    expect(await control.set({ status: 'active', reason: null })).toMatchObject({ status: 'active', reason: null });
  });
});
