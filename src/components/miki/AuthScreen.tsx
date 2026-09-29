/**
 * AuthScreen — full-screen payment approval using biometrics.
 *
 * This is step 3 of the payment pipeline when a biometric credential is
 * enrolled (otherwise the typed PIN pad is shown instead — see PinScreen).
 * Biometrics are PRIMARY; "Use PIN instead" is the always-present fallback.
 *
 * After a successful biometric check the voice flow continues to the
 * arithmetic challenge (the anti-replay step) automatically.
 */

import { useEffect, useRef } from 'react';

import { FingerprintIcon, XIcon } from './icons';

interface AuthScreenProps {
  /** What the user is authorising, e.g. "Send 200 sats". */
  prompt: string;
  /** Latest status line from the voice flow (errors etc.). */
  status: string;
  /** True while the device biometric prompt is open. */
  busy: boolean;
  /** Called when the user presses the big biometric button. */
  onBiometric: () => void;
  /** Called when the user chooses the typed-PIN fallback instead. */
  onUsePin: () => void;
  /** Called when the user cancels the payment. */
  onCancel: () => void;
}

export function AuthScreen({ prompt, status, busy, onBiometric, onUsePin, onCancel }: AuthScreenProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const statusParaRef = useRef<HTMLParagraphElement>(null);

  // Move focus into the dialog when it opens (screen-reader entry point).
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // While this dialog is open, ITS status line is "the status region" for
  // the user — new messages move focus HERE, keeping keyboard/Braille
  // focus inside the modal instead of behind it.
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-title"
      className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-black px-6 text-center"
    >
      <h2
        id="auth-title"
        ref={titleRef}
        tabIndex={-1}
        className="text-3xl font-bold text-yellow-400 outline-none"
      >
        Approve payment
      </h2>
      <p className="text-2xl font-bold text-white">{prompt}</p>

      {/* Status (biometric failures etc.) — visual mirror of THE shared
          status region; announcements come from there, so this is NOT a
          second live region (that would double-announce). It IS a focus
          target (see the effect above). */}
      <p ref={statusParaRef} tabIndex={-1} className="min-h-8 text-xl font-semibold text-white outline-none">
        {status}
      </p>

      <button
        type="button"
        onClick={onBiometric}
        disabled={busy}
        aria-label="Approve with fingerprint or face"
        className="flex min-h-24 w-full max-w-sm items-center justify-center gap-4 rounded-3xl bg-yellow-400 px-6 text-2xl font-black text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white disabled:opacity-60"
      >
        <FingerprintIcon size={44} />
        {busy ? 'Check your device…' : 'Approve'}
      </button>

      <button
        type="button"
        onClick={onUsePin}
        aria-label="Use your PIN instead"
        className="flex min-h-14 w-full max-w-sm items-center justify-center rounded-2xl border-2 border-yellow-400 px-6 text-xl font-bold text-yellow-400 hover:bg-yellow-400 hover:text-black focus-visible:outline-4 focus-visible:outline-white"
      >
        Use PIN instead
      </button>

      <button
        type="button"
        onClick={onCancel}
        className="flex min-h-14 w-full max-w-sm items-center justify-center gap-2 rounded-2xl border-2 border-red-400 px-6 text-xl font-bold text-red-400 hover:bg-red-400 hover:text-black focus-visible:outline-4 focus-visible:outline-white"
      >
        <XIcon size={26} />
        Cancel payment
      </button>
    </div>
  );
}
