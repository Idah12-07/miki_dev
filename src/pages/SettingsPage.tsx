/**
 * Settings page — speech rate, voice guide, biometric sign-in, PIN,
 * spending limit, demo tools.
 *
 * Every change is confirmed through the shared `feedback()` channel, so the
 * confirmation is spoken, shown in THE status region, and felt as a
 * vibration — the same information through every channel at once.
 *
 * PIN setup reuses the same full-screen PinScreen as the payment flow, so
 * there's only one PIN UI to learn — for users AND for developers. PINs are
 * TYPED ONLY, never spoken.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';

import { PinScreen } from '@/components/miki/PinScreen';
import { useMiki } from '@/hooks/useMiki';
import { clearPin, hasPin, isValidPinFormat, setPin, verifyPin, PIN_LENGTH } from '@/lib/pin';
import { enrollBiometric, isBiometricEnrolled, removeBiometric } from '@/lib/webauthn';
import { cn } from '@/lib/utils';

/** Preset spending limits (sats). Presets beat free input for accessibility. */
const SPENDING_LIMIT_OPTIONS = [100, 500, 1_000, 5_000, 10_000];

/** Where the PIN setup sub-flow is at. */
type PinSetupStage = 'hidden' | 'verify-current' | 'enter-new' | 'confirm-new';

export default function SettingsPage() {
  const {
    settings,
    updateSettings,
    say,
    feedback,
    status,
    resetDemo,
    biometricAvailable,
    refreshBiometricAvailability,
  } = useMiki();

  useSeoMeta({
    title: 'Settings — MIKI',
    description: 'MIKI settings: speech rate, voice guide, biometrics, PIN, spending limit and demo tools.',
  });

  // ── PIN setup sub-flow state ──
  const [pinStage, setPinStage] = useState<PinSetupStage>('hidden');
  const firstEntryRef = useRef(''); // the "new PIN" from step 1 of 2
  const attemptsRef = useRef(0);
  // Mirror of hasPin() in state so the section re-renders after changes.
  const [pinIsSet, setPinIsSet] = useState(() => hasPin());

  // ── Biometric enrolment state ──
  const [biometricEnrolled, setBiometricEnrolled] = useState(() => isBiometricEnrolled());
  const [biometricBusy, setBiometricBusy] = useState(false);

  // ── Reset-demo two-step confirm ──
  const [resetArmed, setResetArmed] = useState(false);

  // Announce the page (screen change → status text + speech + focus there).
  useEffect(() => {
    void feedback('Settings screen.', 'info', { focus: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── speech rate ──
  const testVoice = () => {
    void say(
      `This is MIKI speaking at ${settings.speechRate} times normal speed. ` +
        'Tap the big microphone button on the wallet screen and say a command.',
    );
  };

  // ── voice guide ──
  const toggleGuidance = () => {
    const next = !settings.voiceGuidance;
    updateSettings({ voiceGuidance: next });
    void feedback(
      next
        ? 'Voice guide on. Touch anything to hear what it is; double tap to activate.'
        : 'Voice guide off.',
      'success',
    );
  };

  // ── biometric sign-in ──
  const enableBiometric = async () => {
    setBiometricBusy(true);
    try {
      await enrollBiometric();
      setBiometricEnrolled(true);
      await refreshBiometricAvailability();
      void feedback(
        'Biometric sign-in is on. Next time you open MIKI, sign in with your fingerprint or face.',
        'received', // two short buzzes — same as a sign-in
      );
    } catch (error) {
      void feedback(
        error instanceof Error ? error.message : 'Biometric setup failed. You can keep using your PIN.',
        'error',
      );
    } finally {
      setBiometricBusy(false);
    }
  };

  const disableBiometric = () => {
    removeBiometric();
    setBiometricEnrolled(false);
    void feedback('Biometric sign-in is off. Your PIN will be used instead.', 'success');
  };

  // ── spending limit ──
  const changeLimit = (sats: number) => {
    updateSettings({ spendingLimitSats: sats });
    void feedback(`Spending limit set to ${sats.toLocaleString()} sats per payment.`, 'success');
  };

  // ── demo failure switch ──
  const toggleFailure = () => {
    const next = !settings.mockFailure;
    updateSettings({ mockFailure: next });
    void feedback(
      next ? 'Demo failure mode on. The next payments will fail.' : 'Demo failure mode off.',
      'success',
    );
  };

  // ── PIN flow ──
  const openPinSetup = () => {
    attemptsRef.current = 0;
    firstEntryRef.current = '';
    setPinStage(pinIsSet ? 'verify-current' : 'enter-new');
    void feedback(
      pinIsSet ? 'First, enter your current PIN.' : `Create a ${PIN_LENGTH}-digit PIN.`,
      'info',
      { focus: false }, // the PIN dialog's title/status takes the focus
    );
  };

  const closePinSetup = () => setPinStage('hidden');

  /** Handles a completed 4-digit entry, advancing the setup sub-flow. */
  const handlePinEntry = async (pin: string): Promise<'ok' | 'retry' | 'cancelled'> => {
    if (!isValidPinFormat(pin)) return 'retry';

    switch (pinStage) {
      // Changing an existing PIN: prove the current one first.
      case 'verify-current': {
        const ok = await verifyPin(pin);
        if (!ok) {
          attemptsRef.current += 1;
          if (attemptsRef.current >= 3) {
            closePinSetup();
            void feedback('Too many wrong attempts.', 'error');
            return 'cancelled';
          }
          // focus: false — the PIN dialog's own status line takes the focus.
          void feedback(
            `Wrong PIN. ${3 - attemptsRef.current} attempts left. Try again.`,
            'error',
            { focus: false },
          );
          return 'retry';
        }
        setPinStage('enter-new');
        void feedback(`Now choose a new ${PIN_LENGTH}-digit PIN.`, 'info', { focus: false });
        return 'retry'; // 'retry' just clears the dots; we stay open
      }

      // Step 1 of 2: remember the candidate, ask for it again.
      case 'enter-new': {
        firstEntryRef.current = pin;
        setPinStage('confirm-new');
        void feedback('Enter the same PIN again to confirm.', 'info', { focus: false });
        return 'retry';
      }

      // Step 2 of 2: must match step 1.
      case 'confirm-new': {
        if (pin !== firstEntryRef.current) {
          firstEntryRef.current = '';
          setPinStage('enter-new');
          void feedback('The two PINs did not match. Start again.', 'error', { focus: false });
          return 'retry';
        }
        await setPin(pin);
        setPinIsSet(true);
        closePinSetup();
        void feedback(
          'Your PIN is set. You will need it before payments when biometrics are not available.',
          'success',
        );
        return 'ok';
      }

      default:
        return 'cancelled';
    }
  };

  // ── reset demo ──
  const pressReset = () => {
    if (!resetArmed) {
      setResetArmed(true);
      void feedback('Press the reset button again to erase the PIN, history and balance.');
      return;
    }
    setResetArmed(false);
    clearPin();
    setPinIsSet(false);
    removeBiometric();
    setBiometricEnrolled(false);
    void resetDemo().then(() =>
      feedback('Demo data erased. Your balance is back to 10,000 sats.', 'success'),
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-6">
      <h1 className="text-3xl font-black text-yellow-400">Settings</h1>

      {/* ── Speech rate ─────────────────────────────────────────────── */}
      <section aria-labelledby="speech-rate-heading" className="flex flex-col gap-3">
        <h2 id="speech-rate-heading" className="text-2xl font-bold text-white">
          Speech rate
        </h2>
        <label htmlFor="speech-rate" className="text-lg text-neutral-300">
          How fast MIKI speaks:{' '}
          <strong className="text-yellow-400">{settings.speechRate.toFixed(1)}×</strong>
        </label>
        <input
          id="speech-rate"
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={settings.speechRate}
          onChange={(event) => updateSettings({ speechRate: parseFloat(event.target.value) })}
          aria-valuetext={`${settings.speechRate.toFixed(1)} times normal speed`}
          className="h-12 w-full accent-yellow-400"
        />
        <button
          type="button"
          onClick={testVoice}
          className="min-h-14 rounded-2xl bg-yellow-400 px-6 text-xl font-bold text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white"
        >
          Test voice
        </button>
      </section>

      {/* ── Voice guide ─────────────────────────────────────────────── */}
      <section aria-labelledby="guide-heading" className="flex flex-col gap-3">
        <h2 id="guide-heading" className="text-2xl font-bold text-white">
          Voice guide
        </h2>
        <p className="text-lg text-neutral-300">
          When on, touching anything makes MIKI say what it is — “Wallet.
          Double tap to activate.” — like a built-in screen reader.
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={settings.voiceGuidance}
          onClick={toggleGuidance}
          aria-label="Voice guide"
          className={cn(
            'flex min-h-14 items-center justify-between gap-4 rounded-2xl px-5 text-left text-xl font-bold',
            'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-yellow-300',
            settings.voiceGuidance
              ? 'bg-yellow-400 text-black'
              : 'bg-neutral-800 text-white hover:bg-neutral-700',
          )}
        >
          <span>Touch to hear</span>
          <span
            aria-hidden="true"
            className={cn(
              'flex h-8 w-14 items-center rounded-full p-1 transition-colors',
              settings.voiceGuidance ? 'justify-end bg-black' : 'justify-start bg-neutral-600',
            )}
          >
            <span className="h-6 w-6 rounded-full bg-white" />
          </span>
        </button>
      </section>

      {/* ── Biometric sign-in ───────────────────────────────────────── */}
      <section aria-labelledby="biometric-heading" className="flex flex-col gap-3">
        <h2 id="biometric-heading" className="text-2xl font-bold text-white">
          Biometric sign-in
        </h2>
        <p className="text-lg text-neutral-300" role="status">
          {biometricAvailable === false
            ? 'This device has no fingerprint or face sensor — the PIN will be used instead.'
            : biometricEnrolled
              ? 'On. MIKI asks for your fingerprint or face at launch and before payments.'
              : 'Off. Use your fingerprint or face instead of typing a PIN.'}
        </p>
        {biometricAvailable !== false &&
          (biometricEnrolled ? (
            <button
              type="button"
              onClick={disableBiometric}
              className="min-h-14 rounded-2xl border-2 border-yellow-400 px-6 text-xl font-bold text-yellow-400 hover:bg-yellow-400 hover:text-black focus-visible:outline-4 focus-visible:outline-white"
            >
              Turn off biometric sign-in
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void enableBiometric()}
              disabled={biometricBusy}
              className="min-h-14 rounded-2xl bg-yellow-400 px-6 text-xl font-bold text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white disabled:opacity-60"
            >
              {biometricBusy ? 'Follow your device prompt…' : 'Turn on biometric sign-in'}
            </button>
          ))}
      </section>

      {/* ── PIN ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="pin-heading" className="flex flex-col gap-3">
        <h2 id="pin-heading" className="text-2xl font-bold text-white">
          Payment PIN
        </h2>
        <p className="text-lg text-neutral-300" role="status">
          {pinIsSet
            ? 'A PIN is set. It is the fallback when biometrics are unavailable.'
            : 'No PIN set yet. A PIN is the fallback sign-in for devices without biometrics.'}
        </p>
        <button
          type="button"
          onClick={openPinSetup}
          className="min-h-14 rounded-2xl bg-yellow-400 px-6 text-xl font-bold text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white"
        >
          {pinIsSet ? 'Change PIN' : 'Create PIN'}
        </button>
      </section>

      {/* ── Spending limit ──────────────────────────────────────────── */}
      <section aria-labelledby="limit-heading" className="flex flex-col gap-3">
        <h2 id="limit-heading" className="text-2xl font-bold text-white">
          Spending limit
        </h2>
        <p className="text-lg text-neutral-300">
          The most you can send in one payment. Current limit:{' '}
          <strong className="text-yellow-400">
            {settings.spendingLimitSats.toLocaleString()} sats
          </strong>
        </p>
        <div role="radiogroup" aria-label="Spending limit in sats" className="flex flex-wrap gap-2">
          {SPENDING_LIMIT_OPTIONS.map((sats) => {
            const selected = settings.spendingLimitSats === sats;
            return (
              <button
                key={sats}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${sats.toLocaleString()} sats per payment`}
                onClick={() => changeLimit(sats)}
                className={cn(
                  'min-h-14 min-w-24 rounded-2xl px-5 text-xl font-bold',
                  'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-yellow-300',
                  selected
                    ? 'bg-yellow-400 text-black'
                    : 'bg-neutral-800 text-white hover:bg-neutral-700',
                )}
              >
                {sats.toLocaleString()}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Account restoration ─────────────────────────────────────── */}
      <section aria-labelledby="recovery-heading" className="flex flex-col gap-3">
        <h2 id="recovery-heading" className="text-2xl font-bold text-white">
          Account restoration
        </h2>
        <p className="text-lg text-neutral-300">
          Set up or test getting your wallet back with help from trusted
          contacts — no company or server can approve this, only you and them.
        </p>
        <Link
          to="/recovery"
          className="flex min-h-14 items-center justify-center rounded-2xl bg-yellow-400 px-6 text-xl font-bold text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white"
        >
          Account restoration
        </Link>
      </section>

      {/* ── Demo tools ──────────────────────────────────────────────── */}
      <section aria-labelledby="demo-heading" className="flex flex-col gap-3">
        <h2 id="demo-heading" className="text-2xl font-bold text-white">
          Demo tools
        </h2>

        {/* Force-failure switch (role="switch" is the accessible toggle). */}
        <button
          type="button"
          role="switch"
          aria-checked={settings.mockFailure}
          onClick={toggleFailure}
          aria-label="Simulate payment failure"
          className={cn(
            'flex min-h-14 items-center justify-between gap-4 rounded-2xl px-5 text-left text-xl font-bold',
            'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-yellow-300',
            settings.mockFailure ? 'bg-red-500 text-black' : 'bg-neutral-800 text-white hover:bg-neutral-700',
          )}
        >
          <span>Simulate payment failure</span>
          <span
            aria-hidden="true"
            className={cn(
              'flex h-8 w-14 items-center rounded-full p-1 transition-colors',
              settings.mockFailure ? 'justify-end bg-black' : 'justify-start bg-neutral-600',
            )}
          >
            <span className="h-6 w-6 rounded-full bg-white" />
          </span>
        </button>
        <p className="text-base text-neutral-400">
          When on, the mock wallet fails every payment — handy for testing the
          error sounds and messages.
        </p>

        <button
          type="button"
          onClick={pressReset}
          aria-label={resetArmed ? 'Confirm: erase all demo data' : 'Reset demo data'}
          className={cn(
            'min-h-14 rounded-2xl border-2 px-6 text-xl font-bold',
            'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-white',
            resetArmed
              ? 'border-red-400 bg-red-500 text-black'
              : 'border-red-400 text-red-400 hover:bg-red-400 hover:text-black',
          )}
        >
          {resetArmed ? 'Press again to erase everything' : 'Reset demo data'}
        </button>
        <p className="text-base text-neutral-400">
          Restores the 10,000 sat demo balance and erases the PIN, biometric
          sign-in and history.
        </p>
      </section>

      {/* ── PIN setup overlay (reuses the payment PIN pad UI) ────────── */}
      {pinStage !== 'hidden' && (
        <PinScreen
          key={pinStage} // remount per step so entered dots reset
          prompt={
            pinStage === 'verify-current'
              ? 'Enter your current PIN'
              : pinStage === 'enter-new'
                ? `Choose a new ${PIN_LENGTH}-digit PIN`
                : 'Repeat the new PIN'
          }
          status={status}
          onSubmit={handlePinEntry}
          onCancel={() => {
            closePinSetup();
            void feedback('PIN setup cancelled.');
          }}
        />
      )}
    </div>
  );
}