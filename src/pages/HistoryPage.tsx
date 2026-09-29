/**
 * History page — the transaction list, built for screen readers first.
 *
 *   - the whole list is announced as a count on page open ("History. 5
 *     transactions")
 *   - every transaction is a list item with a complete aria-label, so
 *     TalkBack users hear "Sent 200 sats, September 29 2026, 2:30 PM"
 *     without having to decipher the layout
 *   - each item has a "Read aloud" button and there's a "Read all" button
 *   - the list refreshes live when a payment arrives while the page is open
 */

import { useCallback, useEffect, useState } from 'react';
import { useSeoMeta } from '@unhead/react';

import { ReceivedIcon, SentIcon, SpeakerIcon } from '@/components/miki/icons';
import { useMiki } from '@/hooks/useMiki';
import {
  TXS_CHANGED_EVENT,
  describeTransaction,
  listTransactions,
  type MikiTransaction,
} from '@/lib/transactions';
import { cn } from '@/lib/utils';

/** Format a timestamp for screen display (aria-labels use describeTransaction). */
function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function HistoryPage() {
  const { say, feedback } = useMiki();
  const [transactions, setTransactions] = useState<MikiTransaction[]>(() => listTransactions());

  useSeoMeta({
    title: 'History — MIKI',
    description: 'Your MIKI transaction history.',
  });

  // Re-read the list whenever any payment is recorded anywhere in the app.
  useEffect(() => {
    const reload = () => setTransactions(listTransactions());
    window.addEventListener(TXS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(TXS_CHANGED_EVENT, reload);
  }, []);

  // Announce the page + count on open (screen change → status + speech +
  // focus on the status region for Braille displays).
  useEffect(() => {
    const count = listTransactions().length;
    void feedback(
      count === 0
        ? 'History screen. You have no transactions yet.'
        : `History screen. You have ${count} ${count === 1 ? 'transaction' : 'transactions'}.`,
      'info',
      { focus: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readAll = useCallback(() => {
    if (transactions.length === 0) {
      void say('There are no transactions yet.');
      return;
    }
    const summary = transactions
      .slice(0, 10) // cap so the announcement stays reasonable
      .map(describeTransaction)
      .join(' ');
    void say(`Your last ${Math.min(10, transactions.length)} transactions. ${summary}`);
  }, [transactions, say]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-black text-yellow-400">History</h1>
        <button
          type="button"
          onClick={readAll}
          aria-label="Read all recent transactions aloud"
          className="flex min-h-12 items-center gap-2 rounded-xl border-2 border-yellow-400 px-4 text-lg font-bold text-yellow-400 hover:bg-yellow-400 hover:text-black focus-visible:outline-4 focus-visible:outline-white"
        >
          <SpeakerIcon size={22} />
          Read all
        </button>
      </div>

      {transactions.length === 0 ? (
        /* Empty state — dashed border per the design language. */
        <div className="rounded-2xl border-2 border-dashed border-neutral-600 px-8 py-12 text-center">
          <p className="text-xl text-neutral-400">
            No transactions yet. Go to the Wallet screen and say “send 200
            sats” or “receive 500 sats”.
          </p>
        </div>
      ) : (
        <ul aria-label="Transactions, newest first" className="flex flex-col gap-3">
          {transactions.map((tx) => {
            const received = tx.direction === 'in';
            return (
              <li
                key={tx.id}
                aria-label={describeTransaction(tx)}
                className={cn(
                  'flex items-center gap-4 rounded-2xl border-2 p-4',
                  tx.status === 'failed'
                    ? 'border-red-800 bg-neutral-900'
                    : received
                      ? 'border-green-700 bg-neutral-900'
                      : 'border-neutral-700 bg-neutral-900',
                )}
              >
                {/* Direction icon */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-14 w-14 shrink-0 items-center justify-center rounded-full',
                    tx.status === 'failed'
                      ? 'bg-red-950 text-red-400'
                      : received
                        ? 'bg-green-950 text-green-400'
                        : 'bg-yellow-950 text-yellow-400',
                  )}
                >
                  {received ? <ReceivedIcon size={28} /> : <SentIcon size={28} />}
                </span>

                {/* Text details */}
                <div className="min-w-0 flex-1">
                  <p className="text-xl font-bold text-white">
                    {received ? 'Received' : 'Sent'} {tx.amountSats.toLocaleString()} sats
                    {tx.status === 'failed' && (
                      <span className="ml-2 text-red-400">(failed)</span>
                    )}
                  </p>
                  <p className="text-base text-neutral-400">{formatWhen(tx.at)}</p>
                </div>

                {/* Per-item read aloud */}
                <button
                  type="button"
                  onClick={() => void say(describeTransaction(tx))}
                  aria-label={`Read aloud: ${describeTransaction(tx)}`}
                  className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-xl bg-neutral-800 text-yellow-400 hover:bg-neutral-700 focus-visible:outline-4 focus-visible:outline-yellow-300"
                >
                  <SpeakerIcon size={22} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
