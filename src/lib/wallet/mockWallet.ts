/**
 * Mock wallet — a fake Lightning wallet for development and demos.
 *
 * Behaviour:
 *   - starts with 10,000 sats (persisted in localStorage across reloads)
 *   - every operation takes ~1 second (simulated network latency) so the
 *     UI's "working…" state can be seen and heard
 *   - `setForceFailure(true)` makes the NEXT payments fail — a Settings
 *     toggle uses this so developers can demo the error path on demand
 *   - created invoices "get paid" automatically ~4 seconds after creation,
 *     which lets the whole receive flow (including the two-buzz haptic and
 *     spoken confirmation) be demoed without a second wallet
 *
 * It implements `WalletProvider`, so a real NWC wallet can replace it without
 * touching the rest of the app — see the big comment in `types.ts`.
 */

import {
  WalletError,
  type IncomingPayment,
  type Invoice,
  type PaymentResult,
  type WalletProvider,
} from './types';

const BALANCE_KEY = 'miki.mock-balance';
export const STARTING_BALANCE_SATS = 10_000;

/** Simulated network latency for every wallet operation. */
const NETWORK_DELAY_MS = 1_000;
/** How long until a mock invoice is auto-paid (demo of incoming payments). */
const AUTO_SETTLE_DELAY_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fake hex string used for preimages/invoice ids in the mock. */
function fakeHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class MockWallet implements WalletProvider {
  /** When true, the next `payInvoice` calls throw. Toggled from Settings. */
  private forceFailure = false;

  /** Active incoming-payment listeners (see `subscribe`). */
  private listeners = new Set<(payment: IncomingPayment) => void>();

  /** Pending auto-settle timers, so `createInvoice` can be cancelled on reset. */
  private settleTimers = new Set<ReturnType<typeof setTimeout>>();

  /** Flip the "force failure" switch (Settings page demo tool). */
  setForceFailure(value: boolean): void {
    this.forceFailure = value;
  }

  getForceFailure(): boolean {
    return this.forceFailure;
  }

  async getBalance(): Promise<number> {
    await sleep(NETWORK_DELAY_MS);
    return this.readBalance();
  }

  async payInvoice(invoice: string, amountSats?: number): Promise<PaymentResult> {
    await sleep(NETWORK_DELAY_MS);

    if (this.forceFailure) {
      throw new WalletError('Payment failed. The demo failure switch is on.');
    }

    // The mock "send 200 sats" command passes the amount directly; a real
    // invoice would carry it. Fall back to 0 sats if neither exists.
    const amount = amountSats ?? 0;
    const balance = this.readBalance();

    if (amount <= 0) {
      throw new WalletError('Payment failed. The amount is missing.');
    }
    if (amount > balance) {
      throw new WalletError(
        `Payment failed. You only have ${balance} sats, but tried to send ${amount}.`,
      );
    }

    this.writeBalance(balance - amount);
    return { preimage: fakeHex(64), feesSats: 0 };
  }

  async createInvoice(amountSats: number, memo = ''): Promise<Invoice> {
    await sleep(NETWORK_DELAY_MS);

    if (amountSats <= 0) {
      throw new WalletError('Could not create the invoice. The amount is missing.');
    }

    // A fake but BOLT11-looking string: real ones start with "lnbc".
    const invoice: Invoice = {
      bolt11: `lnbc${amountSats}n1miki${fakeHex(24)}`,
      amountSats,
      memo,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    };

    // DEMO: pretend a payer scans and pays the invoice a few seconds later,
    // so the "payment received" flow can be experienced end-to-end.
    const timer = setTimeout(() => {
      this.settleTimers.delete(timer);
      this.writeBalance(this.readBalance() + invoice.amountSats);
      const payment: IncomingPayment = {
        amountSats: invoice.amountSats,
        invoice: invoice.bolt11,
        memo: invoice.memo,
      };
      this.listeners.forEach((listener) => listener(payment));
    }, AUTO_SETTLE_DELAY_MS);
    this.settleTimers.add(timer);

    return invoice;
  }

  subscribe(listener: (payment: IncomingPayment) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Restore the starting balance and cancel pending demo payments. */
  reset(): void {
    this.settleTimers.forEach((timer) => clearTimeout(timer));
    this.settleTimers.clear();
    this.writeBalance(STARTING_BALANCE_SATS);
  }

  // ── private helpers ─────────────────────────────────────────────────────

  private readBalance(): number {
    try {
      const raw = localStorage.getItem(BALANCE_KEY);
      const parsed = raw === null ? NaN : parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : STARTING_BALANCE_SATS;
    } catch {
      return STARTING_BALANCE_SATS;
    }
  }

  private writeBalance(sats: number): void {
    try {
      localStorage.setItem(BALANCE_KEY, String(sats));
    } catch {
      /* storage unavailable — balance stays in-memory only for this session */
    }
  }
}
