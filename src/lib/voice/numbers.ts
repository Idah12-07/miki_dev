/**
 * Spoken-number parsing for MIKI.
 *
 * Speech-to-text engines are inconsistent about numbers: one user saying
 * "send 200 sats" may come back as "send 200 sats" (digits) while another
 * gets "send two hundred sats" (words). These helpers normalise both forms
 * into real numbers so the command parser stays simple.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Extract the FIRST number from free-form speech.
 * Handles digits ("200"), words ("two hundred"), and combos
 * ("one thousand five hundred"). Returns null when no number is present.
 */
export function parseSpokenNumber(input: string): number | null {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Plain digits always win: "send 200 sats".
    if (/^\d+$/.test(token)) {
      return parseInt(token, 10);
    }

    // Try to consume a run of number-words starting at this token.
    let j = i;
    let total = 0;
    let current = 0;
    let consumed = false;

    while (j < tokens.length) {
      const word = tokens[j];
      if (word in UNITS) {
        current += UNITS[word];
      } else if (word in TENS) {
        current += TENS[word];
      } else if (word === 'hundred' && consumed) {
        current = (current || 1) * 100;
      } else if (word === 'thousand' && consumed) {
        total += (current || 1) * 1000;
        current = 0;
      } else {
        break; // end of the number-word run
      }
      consumed = true;
      j++;
    }

    if (consumed) return total + current;
  }

  return null;
}

/** Loose "yes" detection for the payment confirmation step. */
export function isYes(transcript: string): boolean {
  return /\b(yes|yeah|yep|yup|confirm|ok|okay|sure|send it|go ahead|do it|affirmative)\b/i
    .test(transcript);
}

/** Loose "no / cancel" detection for the payment confirmation step. */
export function isNo(transcript: string): boolean {
  return /\b(no|nope|nah|cancel|stop|don't|dont|abort|negative|never mind)\b/i
    .test(transcript);
}
