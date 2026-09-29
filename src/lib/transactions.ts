/**
 * Transaction history store for MIKI.
 *
 * Transactions are kept in localStorage (newest first, capped at 100) so the
 * History page survives reloads without any backend. Whenever the list
 * changes we dispatch a `miki:txs-changed` window event — the History page
 * listens for it and re-reads. This keeps the code framework-light and easy
 * for new developers to follow.
 */

export interface MikiTransaction {
  /** Unique id (crypto.randomUUID). */
  id: string;
  /** 'in' = received (invoice paid to us), 'out' = sent (we paid). */
  direction: 'in' | 'out';
  amountSats: number;
  /** Human-readable note, e.g. the spoken command that created it. */
  memo: string;
  /** Unix epoch milliseconds. */
  at: number;
  status: 'success' | 'failed';
  /** The (mock) BOLT11 invoice string, when one was involved. */
  invoice?: string;
}

const STORAGE_KEY = 'miki.transactions';
const MAX_TRANSACTIONS = 100;

/** Event name broadcast on `window` whenever the list changes. */
export const TXS_CHANGED_EVENT = 'miki:txs-changed';

/** Read all transactions, newest first. Never throws. */
export function listTransactions(): MikiTransaction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Basic shape check so corrupt data can't crash the History page.
    return (parsed as MikiTransaction[]).filter(
      (tx) => typeof tx?.id === 'string' && typeof tx?.amountSats === 'number',
    );
  } catch {
    return [];
  }
}

/** Prepend a transaction, persist, and notify listeners. Returns the tx. */
export function addTransaction(
  tx: Omit<MikiTransaction, 'id' | 'at'>,
): MikiTransaction {
  const full: MikiTransaction = {
    ...tx,
    id: typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    at: Date.now(),
  };
  try {
    const next = [full, ...listTransactions()].slice(0, MAX_TRANSACTIONS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage full/unavailable — the tx still exists in memory */
  }
  window.dispatchEvent(new Event(TXS_CHANGED_EVENT));
  return full;
}

/** Wipe the history (used by "Reset demo data" in Settings). */
export function clearTransactions(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(TXS_CHANGED_EVENT));
}

/** One-sentence spoken summary of a transaction, used for "read aloud". */
export function describeTransaction(tx: MikiTransaction): string {
  const verb = tx.direction === 'in' ? 'Received' : 'Sent';
  const when = new Date(tx.at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const status = tx.status === 'failed' ? ', failed' : '';
  return `${verb} ${tx.amountSats} sats on ${when}${status}.`;
}
