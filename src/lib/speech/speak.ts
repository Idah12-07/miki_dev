/**
 * Text-to-speech wrapper for MIKI.
 *
 * MIKI speaks *every* result — it is the primary output channel for blind
 * users. This module turns `speechSynthesis` into a promise-based API so the
 * voice flow can `await speak(...)` and only start listening for an answer
 * once the app has finished talking. (Running speech recognition while the
 * app is still speaking would make the mic hear the app itself.)
 *
 * The promise NEVER rejects — a missing/blocked speech engine must not crash
 * the flow, because the same text is always shown on screen too.
 *
 * A watchdog timer guards against browsers (some Android builds) that forget
 * to fire the utterance `end` event.
 */

export interface SpeakOptions {
  /** Playback rate multiplier (0.5 = slow … 2 = fast). From Settings. */
  rate?: number;
  /** BCP-47 language. Defaults to the browser's UI language. */
  lang?: string;
}

/** True when the Speech Synthesis API exists in this browser. */
export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Immediately stop any in-progress speech. Safe to call anytime. */
export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

/**
 * Speak `text` aloud. Resolves when speaking finished (or was cancelled,
 * errored, or the watchdog fired). Always resolves — never rejects.
 */
export function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    if (!canSpeak() || !text.trim()) {
      resolve();
      return;
    }

    // Cancel whatever was playing so messages don't queue up and overlap.
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = options.rate ?? 1;
    utterance.lang = options.lang ?? (navigator.language || 'en-US');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      resolve();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    // Watchdog: generous estimate of speech duration + slack. Prevents the
    // voice flow from hanging forever if `onend` never fires.
    const estimatedMs = 1500 + text.length * 120;
    const watchdog = setTimeout(finish, Math.min(estimatedMs, 20000));

    window.speechSynthesis.speak(utterance);
  });
}
