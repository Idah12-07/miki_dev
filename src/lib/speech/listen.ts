/**
 * Speech recognition wrapper for MIKI.
 *
 * Turns the event-based Web Speech API (`SpeechRecognition`) into a simple
 * promise-based API the voice flow can `await`:
 *
 *   const { transcript, error } = await handle.promise;
 *
 * Two entry points:
 *   - listenOnce          → one recognition session (used for commands)
 *   - listenWithDeadline  → keeps re-opening sessions until the user says
 *                           something or the total deadline passes (used for
 *                           the arithmetic challenge, which must allow up to
 *                           30 seconds — browsers auto-end silent sessions
 *                           after ~5-10s, so a single session is not enough).
 *
 * Both return `transcript: null` on silence/timeout instead of throwing, so
 * the caller's control flow stays flat and readable.
 *
 * NOTE ON TYPES: the recognition interfaces below are deliberately declared
 * as LOCAL structural types (not global `interface SpeechRecognition`) so
 * they can never clash with built-in DOM typings, now or in the future.
 */

// ── Minimal structural types for the Web Speech API ──────────────────────────

interface RecognitionAlternative {
  transcript: string;
}

interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface RecognitionErrorEvent {
  error: string;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognitionConstructor = new () => Recognition;

/** Both the standard and the webkit-prefixed (Safari) constructor. */
type SpeechWindow = {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

// ── Public API ───────────────────────────────────────────────────────────────

export interface ListenResult {
  /** Final recognised text, or null if nothing was recognised. */
  transcript: string | null;
  /**
   * Machine-readable failure reason:
   *  - 'timeout'      nothing heard before the deadline
   *  - 'not-allowed'  microphone permission denied (user must fix in browser)
   *  - 'unsupported'  this browser has no SpeechRecognition (e.g. Firefox)
   *  - 'cancelled'    aborted by the app (user pressed cancel)
   *  - 'error'        any other recognition error
   */
  error?: 'timeout' | 'not-allowed' | 'unsupported' | 'cancelled' | 'error';
}

export interface ListenOptions {
  /** Hard deadline in ms. The session is aborted when it elapses. */
  timeoutMs: number;
  /** Live (interim) text while the user speaks — shown on screen. */
  onInterim?: (text: string) => void;
  /** BCP-47 language. Defaults to the browser's UI language. */
  lang?: string;
}

export interface ListenHandle {
  promise: Promise<ListenResult>;
  /** Abort the session (e.g. the user tapped "Cancel"). */
  cancel: () => void;
}

/** True when any SpeechRecognition implementation exists. */
export function canListen(): boolean {
  return getRecognitionConstructor() !== null;
}

function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Start a single recognition session. Use via `await handle.promise` and keep
 * `handle.cancel` around so UI cancel buttons can abort it.
 */
export function listenOnce(options: ListenOptions): ListenHandle {
  const Ctor = getRecognitionConstructor();

  if (!Ctor) {
    return {
      promise: Promise.resolve({ transcript: null, error: 'unsupported' }),
      cancel: () => {},
    };
  }

  const recognition = new Ctor();
  recognition.lang = options.lang ?? (navigator.language || 'en-US');
  recognition.continuous = false;    // one utterance per session
  recognition.interimResults = true; // show live captions of what's heard
  recognition.maxAlternatives = 1;

  let cancelled = false;
  let settled = false;
  let finalTranscript = '';
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<ListenResult>((resolve) => {
    const settle = (result: ListenResult) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve(result);
    };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      // Show the user (and helpers watching over their shoulder) live text.
      options.onInterim?.((finalTranscript + interim).trim());
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        settle({ transcript: null, error: 'not-allowed' });
      } else if (event.error === 'aborted') {
        settle({ transcript: null, error: cancelled ? 'cancelled' : 'error' });
      } else if (event.error === 'no-speech') {
        settle({ transcript: null, error: 'timeout' });
      } else {
        settle({ transcript: null, error: 'error' });
      }
    };

    recognition.onend = () => {
      // `end` fires after results or after silence; deliver what we have.
      const text = finalTranscript.trim();
      settle(text ? { transcript: text } : { transcript: null, error: 'timeout' });
    };

    // Hard stop: abort the session when the deadline elapses.
    timeoutId = setTimeout(() => {
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
      settle({ transcript: null, error: 'timeout' });
    }, options.timeoutMs);

    try {
      recognition.start();
    } catch {
      // start() throws if called on an already-started instance.
      settle({ transcript: null, error: 'error' });
    }
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * Keep listening until the user says something or `timeoutMs` total elapses.
 *
 * Why the loop: browsers end a silent recognition session after a few
 * seconds, but the security challenge must stay open for up to 30s. Instead
 * of one long session we chain short ones until the deadline.
 *
 * Extra hooks:
 *  - `isCancelled` — bail out between sessions (user cancelled the flow)
 *  - `onSession`   — hands out each live session's handle so the caller can
 *                    cancel the CURRENT session immediately, not just between
 *                    sessions (used by the mic button's cancel behaviour)
 */
export async function listenWithDeadline(
  options: ListenOptions & {
    isCancelled?: () => boolean;
    onSession?: (handle: ListenHandle) => void;
  },
): Promise<ListenResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < options.timeoutMs) {
    if (options.isCancelled?.()) return { transcript: null, error: 'cancelled' };

    const remaining = options.timeoutMs - (Date.now() - startedAt);
    const session = listenOnce({ ...options, timeoutMs: Math.min(remaining, 15000) });
    options.onSession?.(session);
    const result = await session.promise;

    if (result.transcript) return result;
    // These won't fix themselves by retrying — stop looping.
    if (result.error === 'not-allowed' || result.error === 'unsupported') return result;
    if (options.isCancelled?.()) return { transcript: null, error: 'cancelled' };
    // 'timeout' / 'error' → loop until the real deadline.
  }

  return { transcript: null, error: 'timeout' };
}
