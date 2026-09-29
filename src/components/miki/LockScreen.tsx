/**
 * LockScreen — shown at launch whenever an auth method is enrolled.
 *
 * Biometric (fingerprint / Face ID via WebAuthn) is the PRIMARY sign-in;
 * the typed PIN is the fallback for devices without biometric hardware.
 * PIN entry is TYPED ONLY — it is never spoken or entered by voice.
 *
 * Success and failure both go through the shared `feedback()` channel, so
 * every user hears, sees AND feels the result (two short buzzes + "Signed
 * in." on success; three short buzzes on failure).
 */

import { useEffect, useRef, useState } from 'react';

import { FingerprintIcon, LockIcon } from '@/components/miki/icons';
import { PinScreen } from '@/components/miki/PinScreen';
import { useMiki } from '@/hooks/useMiki';
import { hasPin, verifyPin, MAX_PIN_ATTEMPTS } from '@/lib/pin';
import { verifyBiometric } from '@/lib/webauthn';

interface LockScreenProps {
  /** Whether a biometric credential is enrolled on this device. */
  biometricEnrolled: boolean;
}

export function LockScreen({ biometricEnrolled }: LockScreenProps) {
  const { feedback, unlock, biometricAvailable, status } = useMiki();
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const attemptsRef = useRef(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const showBiometric = biometricEnrolled && biometricAvailable !== false;
  const showPin = hasPin();

  // Announce the lock screen (screen change → status text + speech + focus).
  useEffect(() => {
    titleRef.current?.focus();
    void feedback(
      showBiometric
        ? 'MIKI is locked. Sign in with your fingerprint or face, or use your PIN.'
        : 'MIKI is locked. Enter your PIN to sign in.',
      'info',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signInWithBiometric = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await verifyBiometric();
    setBusy(false);
    if (ok) {
      // TWO short buzzes + spoken/visible "Signed in" via shared feedback.
      void feedback('Signed in. Welcome back to MIKI.', 'received');
      unlock(); // the layout swaps in the real app
    } else {
      void feedback('Biometric sign-in failed. Try again, or use your PIN.', 'error');
    }
  };

  const submitPin = async (pin: string): Promise<'ok' | 'retry' | 'cancelled'> => {
    const ok = await verifyPin(pin);
    if (ok) {
      void feedback('Signed in. Welcome back to MIKI.', 'received');
      setPinOpen(false);
      unlock();
      return 'ok';
    }
    attemptsRef.current += 1;
    const left = MAX_PIN_ATTEMPTS - attemptsRef.current;
    if (left <= 0) {
      attemptsRef.current = 0;
      setPinOpen(false);
      void feedback('Too many wrong attempts. Try again later.', 'error');
      return 'cancelled';
    }
    // focus: false — the PIN dialog's own status line takes the focus.
    void feedback(
      `Wrong PIN. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`,
      'error',
      { focus: false },
    );
    return 'retry';
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <LockIcon size={72} className="text-yellow-400" />

      <h1 ref={titleRef} tabIndex={-1} className="text-4xl font-black text-white outline-none">
        MIKI is locked
      </h1>

      <p className="max-w-md text-xl text-neutral-300">
        {showBiometric ? 'Sign in with your fingerprint or face.' : 'Sign in with your PIN.'}
      </p>

      {showBiometric && (
        <button
          type="button"
          onClick={() => void signInWithBiometric()}
          disabled={busy}
          aria-label="Sign in with fingerprint or face"
          className="flex min-h-24 w-full max-w-sm items-center justify-center gap-4 rounded-3xl bg-yellow-400 px-6 text-2xl font-black text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white disabled:opacity-60"
        >
          <FingerprintIcon size={44} />
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      )}

      {showPin && (
        <button
          type="button"
          onClick={() => setPinOpen(true)}
          aria-label={showBiometric ? 'Use your PIN instead' : 'Enter your PIN to sign in'}
          className="flex min-h-16 w-full max-w-sm items-center justify-center rounded-2xl border-2 border-yellow-400 px-6 text-xl font-bold text-yellow-400 hover:bg-yellow-400 hover:text-black focus-visible:outline-4 focus-visible:outline-white"
        >
          {showBiometric ? 'Use PIN instead' : 'Enter PIN'}
        </button>
      )}

      {/* Dead-end guard: enrolled biometric but the sensor vanished AND no
          PIN was ever set. Extremely rare — but never strand the user. */}
      {!showBiometric && !showPin && (
        <p role="alert" className="max-w-md text-lg text-red-300">
          No sign-in method is available on this device. Use the app settings
          from a device where you are signed in to reset, or clear this
          browser's site data to start over.
        </p>
      )}

      {/* Typed-PIN fallback overlay (PIN is never spoken — typed only). */}
      {pinOpen && (
        <PinScreen
          prompt="Enter your PIN to sign in"
          status={status}
          onSubmit={submitPin}
          onCancel={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}
