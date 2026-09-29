/**
 * Wallet provider interface — the seam between MIKI and any Lightning wallet.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ HOW TO SWAP IN A REAL WALLET (Nostr Wallet Connect)                   │
 * ├───────────────────────────────────────────────────────────────────────┤
 * │ The whole app only talks to the `WalletProvider` interface below.     │
 * │ Today it is implemented by `MockWallet` (fake sats, instant testing). │
 * │                                                                       │
 * │ To go real, create `src/lib/wallet/nwcWallet.ts` that implements the  │
 * │ same interface on top of NWC (NIP-47) and construct it in             │
 * │ `src/components/miki/MikiProvider.tsx` — no other file must change:   │
 * │                                                                       │
 * │   WalletProvider method  →  NWC (NIP-47) request                      │
 * │   ────────────────────────────────────────────────                    │
 * │   getBalance()           →  get_balance          (msats → sats)       │
 * │   payInvoice(invoice)    →  pay_invoice          ({ invoice })        │
 * │   createInvoice(amt)     →  make_invoice         ({ amount: msats })  │
 * │   subscribe(listener)    →  NIP-47 notification  ("payment_received") │
 * │                                                                       │
 * │ Notes for the NWC implementation:                                     │
 * │  - NWC amounts are in MILLIsats; this interface always uses sats.     │
 * │  - The NWC connection string (nostr+walletconnect://…) is a secret —  │
 * │    ask for it in Settings and store it like the PIN, never in code.   │
 * │  - Keep the 1s+ network latency in mind: the UI already shows a       │
 * │    "working" state while promises are pending, so nothing to change.  │
 * └───────────────────────────────────────────────────────────────────────┘
 */

/** A Lightning invoice created by the wallet (BOLT11 payment request). */
export interface Invoice {
  /** The BOLT11 string a payer can scan/paste. Mock returns a fake one. */
  bolt11: string;
  amountSats: number;
  memo: string;
  /** Unix epoch ms when the invoice stops being payable. */
  expiresAt: number;
}

/** Result of a successful outgoing payment. */
export interface PaymentResult {
  /** Payment preimage (proof of payment). Mock returns a fake hex string. */
  preimage: string;
  /** Fees paid in sats (0 in the mock). */
  feesSats: number;
}

/** Notification that an invoice WE created got paid by someone else. */
export interface IncomingPayment {
  amountSats: number;
  invoice: string;
  memo: string;
}

/** Error thrown by wallet implementations. `message` is spoken aloud. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/**
 * The wallet contract. All methods are async and throw `WalletError` with a
 * human-speakable message on failure (the voice layer announces it verbatim).
 */
export interface WalletProvider {
  /** Current balance in sats. */
  getBalance(): Promise<number>;

  /**
   * Pay a BOLT11 invoice. `amountSats` is provided for wallets/commands that
   * specify the amount separately (and for the mock). Implementations should
   * prefer the amount encoded inside the invoice when present.
   */
  payInvoice(invoice: string, amountSats?: number): Promise<PaymentResult>;

  /** Create a BOLT11 invoice for receiving `amountSats`. */
  createInvoice(amountSats: number, memo?: string): Promise<Invoice>;

  /**
   * Subscribe to incoming payments (someone paid one of our invoices).
   * Returns an unsubscribe function. Maps to NWC "payment_received"
   * notifications in a real implementation.
   */
  subscribe(listener: (payment: IncomingPayment) => void): () => void;
}
