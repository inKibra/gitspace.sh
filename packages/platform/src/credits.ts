import { Result, TaggedError, type Result as ResultType } from 'better-result';

export type MeteredResource =
  | 'worker-request'
  | 'worker-cpu-ms'
  | 'do-request'
  | 'do-gb-ms'
  | 'do-row-read'
  | 'do-row-write'
  | 'do-gb-month'
  | 'r2-class-a'
  | 'r2-class-b'
  | 'r2-gb-month'
  | 'r2-egress-byte';

export interface ResourceRate {
  microsNumerator: bigint;
  unitsDenominator: bigint;
}

export interface RateCard {
  version: string;
  effectiveAt: string;
  currency: 'USD';
  basis: 'gross-list-price';
  rates: Record<MeteredResource, ResourceRate>;
}

/** Cloudflare public list prices effective 2026-08-27. Included account-level
 * allowances are platform margin/risk, not nondeterministically assigned to the
 * tenant that happened to consume them first. */
export const RATE_CARD_2026_08_27: RateCard = {
  version: 'cloudflare-2026-08-27',
  effectiveAt: '2026-08-27T00:00:00.000Z',
  currency: 'USD',
  basis: 'gross-list-price',
  rates: {
    'worker-request': { microsNumerator: 300_000n, unitsDenominator: 1_000_000n },
    'worker-cpu-ms': { microsNumerator: 20_000n, unitsDenominator: 1_000_000n },
    'do-request': { microsNumerator: 150_000n, unitsDenominator: 1_000_000n },
    'do-gb-ms': { microsNumerator: 12_500_000n, unitsDenominator: 1_000_000_000n },
    'do-row-read': { microsNumerator: 1_000n, unitsDenominator: 1_000_000n },
    'do-row-write': { microsNumerator: 1_000_000n, unitsDenominator: 1_000_000n },
    'do-gb-month': { microsNumerator: 200_000n, unitsDenominator: 1n },
    'r2-class-a': { microsNumerator: 4_500_000n, unitsDenominator: 1_000_000n },
    'r2-class-b': { microsNumerator: 360_000n, unitsDenominator: 1_000_000n },
    'r2-gb-month': { microsNumerator: 15_000n, unitsDenominator: 1n },
    'r2-egress-byte': { microsNumerator: 0n, unitsDenominator: 1n },
  },
};

export interface UsageQuantity {
  resource: MeteredResource;
  quantity: bigint;
}

export interface UsageCharge extends UsageQuantity {
  rateVersion: string;
  debitMicros: bigint;
}

export class InvalidUsageQuantity extends TaggedError('InvalidUsageQuantity')<{
  resource: MeteredResource;
  quantity: bigint;
  message: string;
}> {}

export class UnboundedCreditExposure extends TaggedError('UnboundedCreditExposure')<{
  message: string;
}> {}

export interface ExposureWindow {
  analyticsLagMs: number;
  pollIntervalMs: number;
  enforcementLatencyMs: number;
  prepaidRiskReserveMicros: bigint;
  maxBurnMicrosPerSecond: bigint | null;
}

export interface CreditExposureBound {
  detectionWindowMs: number;
  unreportedBurnMicros: bigint;
  totalExposureMicros: bigint;
}

export function calculateCreditExposureBound(
  input: ExposureWindow,
): ResultType<CreditExposureBound, InvalidUsageQuantity | UnboundedCreditExposure> {
  const durations = [input.analyticsLagMs, input.pollIntervalMs, input.enforcementLatencyMs];
  if (durations.some((value) => !Number.isSafeInteger(value) || value < 0) || input.prepaidRiskReserveMicros < 0n) {
    return Result.err(new InvalidUsageQuantity({
      resource: 'worker-request',
      quantity: input.prepaidRiskReserveMicros,
      message: 'Exposure window values must be non-negative integers',
    }));
  }
  if (input.maxBurnMicrosPerSecond === null) {
    return Result.err(new UnboundedCreditExposure({
      message: 'No externally enforced tenant burn-rate or Durable Object instance ceiling exists',
    }));
  }
  if (input.maxBurnMicrosPerSecond < 0n) {
    return Result.err(new InvalidUsageQuantity({
      resource: 'worker-request',
      quantity: input.maxBurnMicrosPerSecond,
      message: 'Maximum burn rate cannot be negative',
    }));
  }
  const detectionWindowMs = durations.reduce((total, value) => total + value, 0);
  const unreportedBurnMicros = ceilDiv(
    input.maxBurnMicrosPerSecond * BigInt(detectionWindowMs),
    1_000n,
  );
  return Result.ok({
    detectionWindowMs,
    unreportedBurnMicros,
    totalExposureMicros: input.prepaidRiskReserveMicros + unreportedBurnMicros,
  });
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

export function calculateUsageCharges(
  usage: readonly UsageQuantity[],
  rateCard: RateCard = RATE_CARD_2026_08_27,
): ResultType<UsageCharge[], InvalidUsageQuantity> {
  const charges: UsageCharge[] = [];
  for (const item of usage) {
    if (item.quantity < 0n) {
      return Result.err(new InvalidUsageQuantity({
        resource: item.resource,
        quantity: item.quantity,
        message: `Usage quantity for ${item.resource} cannot be negative`,
      }));
    }
    const rate = rateCard.rates[item.resource];
    charges.push({
      ...item,
      rateVersion: rateCard.version,
      debitMicros: ceilDiv(item.quantity * rate.microsNumerator, rate.unitsDenominator),
    });
  }
  return Result.ok(charges);
}

export function totalChargeMicros(charges: readonly UsageCharge[]): bigint {
  return charges.reduce((total, charge) => total + charge.debitMicros, 0n);
}
