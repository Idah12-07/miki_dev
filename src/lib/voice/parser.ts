/**
 * Voice command parser for MIKI.
 *
 * Converts a raw speech-to-text transcript into a structured `Command`.
 * Keeping this a pure function (text in → command out, no side effects) makes
 * it trivial to unit-test and easy for new developers to extend: to support a
 * new phrase, add a keyword below; to support a new action, add a Command
 * variant and handle it in `useVoiceWallet.ts`.
 *
 * Supported phrases (English):
 *   "check balance" / "balance" / "how much do I have"
 *   "send 200 sats" / "pay two hundred sats" / "transfer 50 satoshis"
 *   "receive 500 sats" / "request 500" / "create an invoice for 500"
 *   "history" / "transactions"
 *   "settings" / "options"
 *   "repeat" / "say that again"
 *   "help" / "what can I say"
 */

import { parseSpokenNumber } from './numbers';

export type Command =
  | { type: 'balance' }
  | { type: 'send'; amountSats: number }
  | { type: 'receive'; amountSats: number }
  | { type: 'history' }
  | { type: 'settings' }
  | { type: 'repeat' }
  | { type: 'help' }
  | { type: 'unknown'; raw: string };

/** Words that mean "check my balance". */
const BALANCE_WORDS = ['balance', 'how much', 'funds', 'wallet'];
/** Words that mean "send / pay". */
const SEND_WORDS = ['send', 'pay', 'transfer', 'spent', 'spend'];
/** Words that mean "receive / request / invoice". */
const RECEIVE_WORDS = ['receive', 'request', 'invoice', 'deposit', 'top up', 'topup'];
/** Words that mean "show my transaction history". */
const HISTORY_WORDS = ['history', 'transactions', 'payments', 'activity'];
/** Words that mean "open settings". */
const SETTINGS_WORDS = ['settings', 'options', 'preferences'];
/** Words that mean "repeat the last message". */
const REPEAT_WORDS = ['repeat', 'again', 'say that', 'what did you say'];
/** Words that mean "tell me what I can say". */
const HELP_WORDS = ['help', 'what can i say', 'commands'];

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

/**
 * Parse a transcript into a Command. Never throws — anything unrecognised
 * becomes `{ type: 'unknown' }` so the app can speak a helpful reply.
 */
export function parseCommand(transcript: string): Command {
  const text = transcript.toLowerCase().trim();
  if (!text) return { type: 'unknown', raw: transcript };

  // Order matters: more specific intents are checked first.

  if (includesAny(text, REPEAT_WORDS)) return { type: 'repeat' };
  if (includesAny(text, HELP_WORDS)) return { type: 'help' };
  if (includesAny(text, SETTINGS_WORDS)) return { type: 'settings' };
  if (includesAny(text, HISTORY_WORDS)) return { type: 'history' };

  if (includesAny(text, SEND_WORDS)) {
    const amount = parseSpokenNumber(text);
    // amountSats 0 = "send" heard but no amount — the flow asks for one.
    return { type: 'send', amountSats: amount !== null && amount > 0 ? Math.floor(amount) : 0 };
  }

  if (includesAny(text, RECEIVE_WORDS)) {
    const amount = parseSpokenNumber(text);
    return { type: 'receive', amountSats: amount !== null && amount > 0 ? Math.floor(amount) : 0 };
  }

  if (includesAny(text, BALANCE_WORDS)) return { type: 'balance' };

  return { type: 'unknown', raw: transcript };
}

/** Spoken by the "help" command — also shown on screen. */
export const HELP_TEXT =
  'You can say: check balance. Send two hundred sats. Receive five hundred sats. ' +
  'History. Settings. Or repeat.';
