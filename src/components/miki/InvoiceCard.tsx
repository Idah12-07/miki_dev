/**
 * InvoiceCard — shows a freshly created Lightning invoice.
 *
 * Blind users get the spoken confirmation ("Invoice created for 500 sats")
 * and can copy the invoice to share it; sighted helpers get the full BOLT11
 * string on screen. In the mock wallet the invoice is auto-paid after a few
 * seconds, which triggers the global "payment received" announcement and
 * the two-buzz haptic.
 */

import { useState } from 'react';

import type { Invoice } from '@/lib/wallet/types';
import { CheckIcon, CopyIcon, XIcon } from './icons';

interface InvoiceCardProps {
  invoice: Invoice;
  onDismiss: () => void;
}

export function InvoiceCard({ invoice, onDismiss }: InvoiceCardProps) {
  const [copied, setCopied] = useState(false);

  const copyInvoice = async () => {
    try {
      await navigator.clipboard.writeText(invoice.bolt11);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard blocked (permissions / older Safari) — the text below is
      // selectable, so the user can still copy manually.
    }
  };

  return (
    <section
      aria-label={`Invoice for ${invoice.amountSats} sats, waiting for payment`}
      className="rounded-2xl border-2 border-yellow-400 bg-neutral-900 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-2xl font-black text-yellow-400">
            {invoice.amountSats.toLocaleString()} sats
          </p>
          <p className="text-lg text-neutral-300">Waiting for payment…</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hide this invoice"
          className="flex min-h-12 min-w-12 items-center justify-center rounded-xl bg-neutral-800 text-white hover:bg-neutral-700 focus-visible:outline-4 focus-visible:outline-yellow-300"
        >
          <XIcon size={24} />
        </button>
      </div>

      {/* The invoice string itself (selectable for manual copy). */}
      <p
        className="mt-3 break-all rounded-lg bg-black p-3 font-mono text-base text-neutral-300"
        aria-label={`Invoice code: ${invoice.bolt11}`}
      >
        {invoice.bolt11}
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void copyInvoice()}
          className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 text-xl font-bold text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white"
        >
          {copied ? <CheckIcon size={24} /> : <CopyIcon size={24} />}
          {copied ? 'Copied!' : 'Copy invoice'}
        </button>
      </div>

      {/* Polite confirmation for screen readers when copying succeeds. */}
      <p aria-live="polite" className="sr-only">
        {copied ? 'Invoice copied to clipboard.' : ''}
      </p>
    </section>
  );
}
