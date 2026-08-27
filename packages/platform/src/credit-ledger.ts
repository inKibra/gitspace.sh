import { DurableObject } from 'cloudflare:workers';

export type CreditErrorCode =
  | 'ACCOUNT_UNCONFIGURED'
  | 'ACCOUNT_QUARANTINED'
  | 'INSUFFICIENT_CREDITS'
  | 'RESERVATION_NOT_FOUND'
  | 'INVALID_CREDIT_INPUT';

export type CreditResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: { code: CreditErrorCode; message: string } };

export interface CreditAccount {
  balanceMicros: number;
  reservedMicros: number;
  riskReserveMicros: number;
  availableMicros: number;
  status: 'active' | 'quarantined';
  reason?: string;
}

export interface CreditLedgerRecord {
  id: string;
  resource: string;
  quantity: string;
  rateVersion: string;
  debitMicros: number;
  windowStart: string;
  windowEnd: string;
  createdAt: string;
}


export function isCreditLedgerRecord(value: unknown): value is CreditLedgerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.resource === 'string'
    && typeof record.quantity === 'string'
    && typeof record.rateVersion === 'string'
    && typeof record.debitMicros === 'number'
    && typeof record.windowStart === 'string'
    && typeof record.windowEnd === 'string'
    && typeof record.createdAt === 'string';
}
interface AccountRow extends Record<string, SqlStorageValue> {
  balance_micros: number;
  reserved_micros: number;
  risk_reserve_micros: number;
  status: string;
  reason: string | null;
}

interface ReservationRow extends Record<string, SqlStorageValue> {
  id: string;
  amount_micros: number;
  status: string;
}

function validMicros(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class CreditLedgerDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS credit_account (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          balance_micros INTEGER NOT NULL,
          reserved_micros INTEGER NOT NULL,
          risk_reserve_micros INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'quarantined')),
          reason TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credit_reservations (
          id TEXT PRIMARY KEY,
          amount_micros INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'expired')),
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credit_ledger (
          id TEXT PRIMARY KEY,
          resource TEXT NOT NULL,
          quantity TEXT NOT NULL,
          rate_version TEXT NOT NULL,
          debit_micros INTEGER NOT NULL,
          window_start TEXT NOT NULL,
          window_end TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_nonces (
          nonce TEXT PRIMARY KEY,
          used_at INTEGER NOT NULL
        );
      `);
    });
  }

  configure(input: { balanceMicros: number; riskReserveMicros: number }): CreditResult<CreditAccount> {
    if (!validMicros(input.balanceMicros) || !validMicros(input.riskReserveMicros)) {
      return { status: 'error', error: { code: 'INVALID_CREDIT_INPUT', message: 'Credit values must be non-negative safe integers' } };
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(`
      INSERT INTO credit_account(id, balance_micros, reserved_micros, risk_reserve_micros, status, reason, updated_at)
      VALUES (1, ?, 0, ?, 'active', NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        balance_micros = excluded.balance_micros,
        reserved_micros = 0,
        risk_reserve_micros = excluded.risk_reserve_micros,
        status = 'active',
        reason = NULL,
        updated_at = excluded.updated_at
    `, input.balanceMicros, input.riskReserveMicros, now);
    this.ctx.storage.sql.exec("UPDATE credit_reservations SET status = 'expired' WHERE status = 'pending'");
    return { status: 'ok', value: this.requireAccount() };
  }

  getAccount(): CreditResult<CreditAccount> {
    const account = this.accountRow();
    return account
      ? { status: 'ok', value: this.toAccount(account) }
      : { status: 'error', error: { code: 'ACCOUNT_UNCONFIGURED', message: 'Tenant credit account is not configured' } };
  }

  reserveDispatch(input: { id: string; amountMicros: number; expiresAt: number }): CreditResult<{ reservationId: string; account: CreditAccount }> {
    if (!input.id || !validMicros(input.amountMicros) || !Number.isSafeInteger(input.expiresAt)) {
      return { status: 'error', error: { code: 'INVALID_CREDIT_INPUT', message: 'Reservation input is invalid' } };
    }
    return this.ctx.storage.transactionSync(() => {
      this.expireReservations(Date.now());
      const existing = this.ctx.storage.sql.exec<ReservationRow>(
        'SELECT id, amount_micros, status FROM credit_reservations WHERE id = ?',
        input.id,
      ).toArray()[0];
      if (existing) return { status: 'ok', value: { reservationId: existing.id, account: this.requireAccount() } };

      const account = this.accountRow();
      if (!account) return { status: 'error', error: { code: 'ACCOUNT_UNCONFIGURED', message: 'Tenant credit account is not configured' } };
      if (account.status !== 'active') return { status: 'error', error: { code: 'ACCOUNT_QUARANTINED', message: account.reason ?? 'Tenant is quarantined' } };
      const available = account.balance_micros - account.reserved_micros - account.risk_reserve_micros;
      if (available < input.amountMicros) {
        return { status: 'error', error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits after risk reserve' } };
      }
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "INSERT INTO credit_reservations(id, amount_micros, status, expires_at, created_at) VALUES (?, ?, 'pending', ?, ?)",
        input.id,
        input.amountMicros,
        input.expiresAt,
        now,
      );
      this.ctx.storage.sql.exec(
        'UPDATE credit_account SET reserved_micros = reserved_micros + ?, updated_at = ? WHERE id = 1',
        input.amountMicros,
        now,
      );
      return { status: 'ok', value: { reservationId: input.id, account: this.requireAccount() } };
    });
  }

  settleDispatch(input: {
    reservationId: string;
    ledger: CreditLedgerRecord;
  }): CreditResult<{ applied: boolean; account: CreditAccount }> {
    if (!validMicros(input.ledger.debitMicros)) {
      return { status: 'error', error: { code: 'INVALID_CREDIT_INPUT', message: 'Ledger debit must be a non-negative safe integer' } };
    }
    return this.ctx.storage.transactionSync(() => {
      if (this.ledgerExists(input.ledger.id)) return { status: 'ok', value: { applied: false, account: this.requireAccount() } };
      const reservation = this.ctx.storage.sql.exec<ReservationRow>(
        'SELECT id, amount_micros, status FROM credit_reservations WHERE id = ?',
        input.reservationId,
      ).toArray()[0];
      if (!reservation || reservation.status !== 'pending') {
        return { status: 'error', error: { code: 'RESERVATION_NOT_FOUND', message: 'Pending reservation not found' } };
      }
      this.insertLedger(input.ledger);
      this.ctx.storage.sql.exec(
        "UPDATE credit_reservations SET status = 'settled' WHERE id = ?",
        input.reservationId,
      );
      this.ctx.storage.sql.exec(
        'UPDATE credit_account SET balance_micros = balance_micros - ?, reserved_micros = MAX(0, reserved_micros - ?), updated_at = ? WHERE id = 1',
        input.ledger.debitMicros,
        reservation.amount_micros,
        new Date().toISOString(),
      );
      return { status: 'ok', value: { applied: true, account: this.requireAccount() } };
    });
  }

  applyUsage(record: CreditLedgerRecord): CreditResult<{ applied: boolean; account: CreditAccount }> {
    if (!validMicros(record.debitMicros)) {
      return { status: 'error', error: { code: 'INVALID_CREDIT_INPUT', message: 'Ledger debit must be a non-negative safe integer' } };
    }
    return this.ctx.storage.transactionSync(() => {
      if (this.ledgerExists(record.id)) return { status: 'ok', value: { applied: false, account: this.requireAccount() } };
      this.insertLedger(record);
      this.ctx.storage.sql.exec(
        'UPDATE credit_account SET balance_micros = balance_micros - ?, updated_at = ? WHERE id = 1',
        record.debitMicros,
        new Date().toISOString(),
      );
      return { status: 'ok', value: { applied: true, account: this.requireAccount() } };
    });
  }

  listLedger(): CreditLedgerRecord[] {
    return this.ctx.storage.sql.exec<{
      id: string;
      resource: string;
      quantity: string;
      rate_version: string;
      debit_micros: number;
      window_start: string;
      window_end: string;
      created_at: string;
    }>('SELECT * FROM credit_ledger ORDER BY created_at, id').toArray().map((row) => ({
      id: row.id,
      resource: row.resource,
      quantity: row.quantity,
      rateVersion: row.rate_version,
      debitMicros: row.debit_micros,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      createdAt: row.created_at,
    }));
  }

  quarantine(reason: string): CreditResult<CreditAccount> {
    const account = this.accountRow();
    if (!account) return { status: 'error', error: { code: 'ACCOUNT_UNCONFIGURED', message: 'Tenant credit account is not configured' } };
    this.ctx.storage.sql.exec(
      "UPDATE credit_account SET status = 'quarantined', reason = ?, updated_at = ? WHERE id = 1",
      reason.slice(0, 500),
      new Date().toISOString(),
    );
    return { status: 'ok', value: this.requireAccount() };
  }

  consumeAdminNonce(nonce: string, timestamp: number, maxSkewMs: number): boolean {
    if (!nonce || !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > maxSkewMs) return false;
    this.ctx.storage.sql.exec('DELETE FROM admin_nonces WHERE used_at < ?', timestamp - maxSkewMs * 2);
    try {
      this.ctx.storage.sql.exec('INSERT INTO admin_nonces(nonce, used_at) VALUES (?, ?)', nonce, timestamp);
      return true;
    } catch {
      return false;
    }
  }

  private expireReservations(now: number): void {
    const expired = this.ctx.storage.sql.exec<{ amount_micros: number }>(
      "SELECT amount_micros FROM credit_reservations WHERE status = 'pending' AND expires_at <= ?",
      now,
    ).toArray();
    const released = expired.reduce((total, row) => total + row.amount_micros, 0);
    if (released === 0) return;
    this.ctx.storage.sql.exec("UPDATE credit_reservations SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", now);
    this.ctx.storage.sql.exec('UPDATE credit_account SET reserved_micros = MAX(0, reserved_micros - ?) WHERE id = 1', released);
  }

  private accountRow(): AccountRow | undefined {
    return this.ctx.storage.sql.exec<AccountRow>(
      'SELECT balance_micros, reserved_micros, risk_reserve_micros, status, reason FROM credit_account WHERE id = 1',
    ).toArray()[0];
  }

  private requireAccount(): CreditAccount {
    const row = this.accountRow();
    if (!row) throw new Error('Credit account invariant violated');
    return this.toAccount(row);
  }

  private toAccount(row: AccountRow): CreditAccount {
    return {
      balanceMicros: row.balance_micros,
      reservedMicros: row.reserved_micros,
      riskReserveMicros: row.risk_reserve_micros,
      availableMicros: row.balance_micros - row.reserved_micros - row.risk_reserve_micros,
      status: row.status === 'quarantined' ? 'quarantined' : 'active',
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }

  private ledgerExists(id: string): boolean {
    return this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM credit_ledger WHERE id = ?', id).toArray().length > 0;
  }

  private insertLedger(record: CreditLedgerRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO credit_ledger(id, resource, quantity, rate_version, debit_micros, window_start, window_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.resource,
      record.quantity,
      record.rateVersion,
      record.debitMicros,
      record.windowStart,
      record.windowEnd,
      record.createdAt,
    );
  }
}
