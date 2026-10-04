/**
 * Turns what speech-to-text "heard" into real recovery words, forgivingly.
 *
 * Every recovery word comes from a fixed list of 2048 words, so a small
 * mishearing can often be corrected safely. When it can't be, this module
 * says so — it never silently guesses, because a wrong guess here could
 * corrupt someone's only path back into their wallet.
 */

import { wordlist } from '@scure/bip39/wordlists/english.js';

const WORDS = new Set(wordlist);

function distance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

export interface WordMatch {
  word: string;
  how: 'exact' | 'prefix' | 'fuzzy';
}

/** Matches one heard word to a real recovery word, or returns null if unsure. */
export function matchWord(heard: string): WordMatch | null {
  const w = heard.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return null;
  if (WORDS.has(w)) return { word: w, how: 'exact' };

  if (w.length >= 4) {
    const byPrefix = wordlist.filter((x) => x.slice(0, 4) === w.slice(0, 4));
    if (byPrefix.length === 1) return { word: byPrefix[0], how: 'prefix' };
  }

  const close = wordlist.filter((x) => Math.abs(x.length - w.length) <= 1 && distance(x, w) === 1);
  if (close.length === 1) return { word: close[0], how: 'fuzzy' };
  return null;
}

export interface ParsedSpeech {
  words: (string | null)[];
  /** 1-based positions of words MIKI could not confidently match. */
  unclear: number[];
}

/** Splits spoken text into words and matches each one, reporting any unclear ones. */
export function parseSpokenWords(text: string): ParsedSpeech {
  const heard = text.split(/[\s,.;]+/).filter(Boolean);
  const words: (string | null)[] = [];
  const unclear: number[] = [];
  heard.forEach((h, i) => {
    const m = matchWord(h);
    if (m) words.push(m.word);
    else {
      words.push(null);
      unclear.push(i + 1);
    }
  });
  return { words, unclear };
}