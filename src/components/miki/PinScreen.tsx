/**
 * PinScreen — full-screen PIN entry overlay.
 *
 * Shown whenever a PIN is required: payment approval (fallback when no
 * biometrics), sign-in fallback, and PIN setup in Settings.
 *
 * PIN entry is TYPED ONLY — never spoken. (Speaking your PIN out loud
 * would broadcast a secret; voice is for commands, not credentials.)
 *
 * Designed for blind and low-vision users:
 *   - enormous digit buttons (whole-screen grid)
 *   - the entered PIN is shown as DOTS ONLY, and the live region announces
 *     "2 of 4 digits entered" — never the digits themselves
 *   - every digit press gives a short vibration tick
 *   - Escape key or the Cancel button aborts
 *   - focus is moved to the dialog title when it opens so TalkBack lands
 *     in the right place
 *
 * The component is "dumb": when 4 digits are entered it calls `onSubmit`
 * and the parent decides whether the PIN was correct.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { PIN_LENGTH } from '@/lib/pin';
import { buzzTick } from '@/lib/haptics';
import { BackspaceIcon, XIcon } from './icons';

interface PinScreenProps {
  /** What the user is authorising, e.g. "Send 200 sats" — spoken + shown. */
  prompt: string;
  /** Current status line from the parent flow (e.g. "Wrong PIN. 2 left."). */
  status: string;
  /** Called with the 4-digit string when the PIN is complete. */
  onSubmit: (pin: string) => Promise<'ok' | 'retry' | 'cancelled'>;
  /** Called when the user cancels (button or Escape). */
  onCancel: () => void;
}

export function PinScreen({ prompt, status, onSubmit, onCancel }: PinScreenProps) {
  const [digits, setDigits] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const statusParaRef = useRef<HTMLParagraphElement>(null);

  // Move focus into the dialog when it opens (screen-reader entry point).
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // While this dialog is open, ITS status line is "the status region" for
  // the user — so new messages (wrong PIN etc.) move focus HERE, keeping
  // keyboard/Braille focus inside the modal instead of behind it.
  useEffect(() => {
    if (status) statusParaRef.current?.focus();
  }, [status]);

  // Escape cancels — same as the Cancel button.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const submit = useCallback(
    async (pin: string) => {
      const result = await onSubmit(pin);
      if (result === 'retry') setDigits(''); // wrong PIN → start over
    },
    [onSubmit],
  );

  const pressDigit = useCallback(
    (digit: string) => {
      buzzTick(); // tiny confirmation vibration per key press
      setDigits((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = prev + digit;
        if (next.length === PIN_LENGTH) void submit(next);
        return next;
      });
    },
    [submit],
  );

  const backspace = useCallback(() => {
    buzzTick();
    setDigits((prev) => prev.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    buzzTick();
    setDigits('');
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-title"
      className="fixed inset-0 z-40 flex flex-col bg-black px-4 pb-4 pt-6"
    >
      {/* Title — receives focus on open so TalkBack reads the context. */}
      <h2
        id="pin-title"
        ref={titleRef}
        tabIndex={-1}
        className="text-center text-3xl font-bold text-yellow-400 outline-none"
      >
        Enter PIN
      </h2>
      <p className="mt-1 text-center text-xl text-neutral-300">{prompt}</p>

      {/* Status (wrong PIN etc.) — visual mirror of THE shared status
          region; announcements come from there, so this is NOT a second
          live region (that would double-announce for screen readers).
          It IS a focus target (see the effect above). */}
      <p ref={statusParaRef} tabIndex={-1} className="mt-2 min-h-8 text-center text-xl font-semibold text-white outline-none">
        {status}
      </p>

      {/* PIN dots — the COUNT is announced, never the digits. */}
      <div
        className="my-4 flex items-center justify-center gap-4"
        role="status"
        aria-live="polite"
        aria-label={`${digits.length} of ${PIN_LENGTH} digits entered`}
      >
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={
              i < digits.length
                ? 'h-7 w-7 rounded-full bg-yellow-400'
                : 'h-7 w-7 rounded-full border-4 border-neutral-600'
            }
          />
        ))}
      </div>

      {/* Number pad: 1-9, then Clear / 0 / Backspace. Huge targets. */}
      <div className="mx-auto grid w-full max-w-sm flex-1 grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            type="button"
            onClick={() => pressDigit(digit)}
            aria-label={`Digit ${digit}`}
            data-no-hint
            className="min-h-16 rounded-2xl bg-neutral-800 text-4xl font-black text-white hover:bg-neutral-700 focus-visible:outline-4 focus-visible:outline-yellow-300 active:bg-neutral-600"
          >
            {digit}
          </button>
        ))}

        <button
          type="button"
          onClick={clear}
          aria-label="Clear all digits"
          className="min-h-16 rounded-2xl bg-neutral-800 text-2xl font-bold text-white hover:bg-neutral-700 focus-visible:outline-4 focus-visible:outline-yellow-300 active:bg-neutral-600"
        >
          Clear
        </button>

        <button
          type="button"
          onClick={() => pressDigit('0')}
          aria-label="Digit 0"
          data-no-hint
          className="min-h-16 rounded-2xl bg-neutral-800 text-4xl font-black text-white hover:bg-neutral-700 focus-visible:outline-4 focus-visible:outline-yellow-300 active:bg-neutral-600"
        >
          0
        </button>

        <button
          type="button"
          onClick={backspace}
          aria-label="Delete last digit"
          className="flex min-h-16 items-center justify-center rounded-2xl bg-neutral-800 text-white hover:bg-neutral-700 focus-visible:outline-4 focus-visible:outline-yellow-300 active:bg-neutral-600"
        >
          <BackspaceIcon size={32} />
        </button>
      </div>

      {/* Cancel */}
      <button
        type="button"
        onClick={onCancel}
        className="mx-auto mt-4 flex min-h-14 w-full max-w-sm items-center justify-center gap-2 rounded-2xl border-2 border-red-400 text-2xl font-bold text-red-400 hover:bg-red-400 hover:text-black focus-visible:outline-4 focus-visible:outline-white"
      >
        <XIcon size={26} />
        Cancel
      </button>
    </div>
  );
}
