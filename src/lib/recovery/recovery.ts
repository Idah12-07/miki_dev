/**
 * Account restoration — splitting a wallet seed into 3 "shares" so that any
 * 2 trusted contacts can help rebuild it after a lost phone, and 1 alone can
 * never do anything with it.
 *
 * No company, bank or server can approve or deny a recovery — only the
 * person's own trusted contacts can, which is the same self-sovereignty
 * principle Bitcoin itself is built on, applied to "what if I lose my
 * phone?" instead of "what if a bank freezes my account?".
 *
 * The maths: `shamir-secret-sharing` (independently audited) splits 16
 * random bytes (the entropy behind a 12-word seed) into 3 shares, any 2 of
 * which reconstruct the original bytes. 1 share alone reveals nothing.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { combine, split } from 'shamir-secret-sharing';

const ENTROPY_BYTES = 16; // 16 bytes of entropy -> a 12-word seed phrase
const SHARE_BYTES = ENTROPY_BYTES + 1; // the library adds 1 overhead byte per share

export interface RecoveryContact {
  name: string;
  /** This contact's piece of the key, as 14 ordinary words they can read aloud. */
  words: string[];
}

export interface RecoveryKit {
  /** The 12-word wallet seed. Hand it to the wallet, then forget it. */
  mnemonic: string;
  /** Safe to store anywhere (even on a server) — can't be turned back into the seed. */
  fingerprint: string;
  contacts: RecoveryContact[];
}

/** A one-way check that a rebuilt seed is the right one, not a corrupted guess. */
export function fingerprint(entropy: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes('miki-recovery-v1'), entropy)));
}

/** Turns one share's bytes into 14 everyday words, with a checksum word. */
export function shareToWords(share: Uint8Array): string[] {
  if (share.length !== SHARE_BYTES) throw new Error('Unexpected share size');
  const payload = concatBytes(share, sha256(share).subarray(0, 1));
  let bits = [...payload].map((b) => b.toString(2).padStart(8, '0')).join('');
  while (bits.length % 11 !== 0) bits += '0';
  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    words.push(wordlist[parseInt(bits.slice(i, i + 11), 2)]);
  }
  return words;
}

/** The reverse of {@link shareToWords}. Throws if a word was misheard or mistyped. */
export function wordsToShare(words: string[]): Uint8Array {
  const idx = words.map((w) => wordlist.indexOf(w.toLowerCase().trim()));
  if (idx.includes(-1)) throw new Error('One of those words is not a recovery word — please check it');
  const bits = idx.map((i) => i.toString(2).padStart(11, '0')).join('');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length && bytes.length < SHARE_BYTES + 1; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  const share = Uint8Array.from(bytes.slice(0, SHARE_BYTES));
  if (sha256(share)[0] !== bytes[SHARE_BYTES]) {
    throw new Error('That share does not check out — one word may be wrong');
  }
  return share;
}

/** Setup: makes a new wallet seed and splits it 3 ways, 2 of which rebuild it. */
export async function createRecoveryKit(contactNames: string[]): Promise<RecoveryKit> {
  if (contactNames.length !== 3) throw new Error('Pick exactly 3 trusted contacts');
  const entropy = globalThis.crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES));
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const shares = await split(entropy, 3, 2);
  return {
    mnemonic,
    fingerprint: fingerprint(entropy),
    contacts: contactNames.map((name, i) => ({ name, words: shareToWords(shares[i]) })),
  };
}

/** Recovery: rebuilds the seed from any 2 shares and checks it against the fingerprint. */
export async function recoverSeed(shares: Uint8Array[], expectedFingerprint: string): Promise<string> {
  if (shares.length < 2) throw new Error('Need at least 2 shares to recover the wallet');
  const entropy = await combine(shares);
  if (fingerprint(entropy) !== expectedFingerprint) {
    throw new Error('Those shares do not match this wallet — check with your contacts and try again');
  }
  return entropyToMnemonic(entropy, wordlist);
}

/** True if a string is a valid 12-word seed (used only for local sanity checks/tests). */
export function isValidMnemonic(mnemonic: string): boolean {
  try {
    mnemonicToEntropy(mnemonic, wordlist);
    return true;
  } catch {
    return false;
  }
}