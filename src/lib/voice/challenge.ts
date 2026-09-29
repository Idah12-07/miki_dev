/**
 * Arithmetic challenge — MIKI's anti-replay security step.
 *
 * Before any payment, the app speaks a random math question ("What is 4 plus
 * 3?") which the user must answer by voice within 30 seconds. Because the
 * question is freshly random every time, an attacker replaying a recording of
 * the owner's voice cannot know the right answer — this is a simple liveness
 * check that works entirely on-device.
 *
 * A stronger voice-print check can later be added alongside this step in the
 * payment pipeline (see `useVoiceWallet.ts`); the challenge remains useful as
 * an "are you awake and present" gate.
 *
 * Numbers are kept small (2-9) so questions are easy to understand and answer
 * for everyone, including users with cognitive load from using a screen reader.
 */

export interface Challenge {
  /** Screen text, e.g. "What is 4 + 3?" */
  questionText: string;
  /** Spoken text, e.g. "What is 4 plus 3?" (words are easier for TTS). */
  questionSpeech: string;
  /** The correct numeric answer. */
  answer: number;
}

/** Random int in [min, max] using crypto (not Math.random) for unpredictability. */
function randomInt(min: number, max: number): number {
  const range = max - min + 1;
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return min + (values[0] % range);
}

/** Generate a fresh challenge. Addition or subtraction (never negative). */
export function generateChallenge(): Challenge {
  const a = randomInt(2, 9);
  const b = randomInt(2, 9);
  const isPlus = randomInt(0, 1) === 1;

  if (isPlus) {
    return {
      questionText: `What is ${a} + ${b}?`,
      questionSpeech: `What is ${a} plus ${b}?`,
      answer: a + b,
    };
  }

  // Swap so the subtraction answer is never negative.
  const [big, small] = a >= b ? [a, b] : [b, a];
  return {
    questionText: `What is ${big} − ${small}?`,
    questionSpeech: `What is ${big} minus ${small}?`,
    answer: big - small,
  };
}

/** Check a spoken answer against the challenge. */
export function checkChallengeAnswer(challenge: Challenge, spokenAnswer: number | null): boolean {
  return spokenAnswer !== null && spokenAnswer === challenge.answer;
}
