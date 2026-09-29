/**
 * useVoiceWallet — the voice-controlled state machine that drives MIKI's
 * main screen.
 *
 * THE PAYMENT PIPELINE (outgoing payments), in order:
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  1. COMMAND    "send 200 sats" → parsed into { send, 200 }          │
 *   │  2. LIMITS     reject early if over the spending limit / no auth    │
 *   │  3. AUTH       biometric (fingerprint/face) if enrolled, else the   │
 *   │              TYPED PIN (PIN is never spoken — credentials are not   │
 *   │              something to say out loud)                             │
 *   │  4. CHALLENGE  random arithmetic question answered by voice,        │
 *   │              within 45s — defeats recorded-voice replay attacks.    │
 *   │              (45s, not 30: Braille/tactile answering is slower.)    │
 *   │  [FUTURE]      voice-print verification plugs in HERE as step 4.5   │
 *   │              (see the marked spot in runChallenge below)            │
 *   │  5. CONFIRM    "Say yes to send 200 sats" — final user consent      │
 *   │  6. PAY        wallet.payInvoice() → feedback(): speak + buzz       │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * STAGES (what the UI shows):
 *   idle → listening → busy → auth → challenge → confirm → busy → idle
 *
 * ALL user-facing output goes through the shared `feedback()` channel from
 * the MIKI context (speak + visible status text + vibration pattern), so
 * sighted, blind and deafblind users get every result. Status-only text
 * (e.g. "Listening…") uses `setStatus` directly because speaking right
 * before opening the mic would make MIKI hear itself.
 *
 * CONCURRENCY MODEL: only one async step runs at a time. A `session`
 * counter is bumped whenever a new step starts or the user cancels; after
 * every `await`, steps check they are still the current session before
 * touching state — so a late speech result from a cancelled flow can't
 * corrupt a new one. Flow functions are intentionally NOT memoized so they
 * always see the latest settings; only refs cross render boundaries.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useMiki } from '@/hooks/useMiki';
import { PIN_LENGTH, MAX_PIN_ATTEMPTS, hasPin, verifyPin } from '@/lib/pin';
import {
  canListen,
  listenOnce,
  listenWithDeadline,
  type ListenHandle,
} from '@/lib/speech/listen';
import { addTransaction } from '@/lib/transactions';
import { checkChallengeAnswer, generateChallenge } from '@/lib/voice/challenge';
import { isNo, isYes, parseSpokenNumber } from '@/lib/voice/numbers';
import { HELP_TEXT, parseCommand } from '@/lib/voice/parser';
import { isBiometricEnrolled, verifyBiometric } from '@/lib/webauthn';
import type { Invoice } from '@/lib/wallet/types';

/** What the UI should display right now. */
export type VoiceStage =
  | 'idle'      // waiting for the user to tap the mic
  | 'listening' // capturing a voice command
  | 'busy'      // talking to the wallet (spinner state)
  | 'auth'      // payment approval: biometric prompt or typed PIN
  | 'challenge' // arithmetic question asked, listening for the answer
  | 'confirm';  // "say yes to confirm", listening

/** How payment is being authorised in the 'auth' stage. */
export type AuthMethod = 'biometric' | 'pin';

/**
 * How long the user has to answer the arithmetic challenge.
 * Generous on purpose: Braille display and switch-device users answer
 * more slowly than typists. (Was 30s; extended after feedback from
 * deafblind testers.)
 */
export const CHALLENGE_TIMEOUT_MS = 45_000;
/** How long we wait for a yes/no confirmation. */
const CONFIRM_TIMEOUT_MS = 20_000;
/** How long we listen for an initial command. */
const COMMAND_TIMEOUT_MS = 12_000;

/** Data remembered between pipeline steps of one payment. */
interface PendingPayment {
  amountSats: number;
  pinAttempts: number;
}

export interface VoiceWallet {
  stage: VoiceStage;
  /** Live transcript shown while listening. */
  interim: string;
  /** The current challenge question, if any (shown on screen). */
  challengeText: string;
  /** Amount of the payment in flight, if any (shown on screen). */
  pendingAmount: number | null;
  /** The most recently created invoice (shown until dismissed). */
  invoice: Invoice | null;
  /** False when the browser has no SpeechRecognition (e.g. Firefox). */
  speechSupported: boolean;
  /** How the 'auth' stage is being completed right now. */
  authMethod: AuthMethod;
  /** True while the device biometric prompt is open. */
  authBusy: boolean;
  /** The big mic button. Behaviour depends on the current stage. */
  pressMic: () => void;
  /** Abort whatever flow is running and go back to idle. */
  cancelFlow: () => void;
  /** Called by the PIN pad when 4 digits have been entered. */
  submitPin: (pin: string) => Promise<'ok' | 'retry' | 'cancelled'>;
  /** Called by the AuthScreen's big biometric button. */
  approveWithBiometric: () => Promise<void>;
  /** Switch the 'auth' stage to the typed-PIN fallback. */
  usePinInstead: () => void;
  /** Hide the invoice card. */
  dismissInvoice: () => void;
}

export function useVoiceWallet(): VoiceWallet {
  const {
    wallet,
    settings,
    feedback,
    setStatus,
    stopSpeaking,
    repeatLast,
    refreshBalance,
    guidanceSuppressedRef,
  } = useMiki();
  const navigate = useNavigate();

  // ── state ──
  const [stage, setStage] = useState<VoiceStage>('idle');
  const [interim, setInterim] = useState('');
  const [challengeText, setChallengeText] = useState('');
  const [pendingAmount, setPendingAmount] = useState<number | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('pin');
  const [authBusy, setAuthBusy] = useState(false);

  // ── refs (survive re-renders, readable inside async callbacks) ──
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const sessionRef = useRef(0);
  const listenHandleRef = useRef<ListenHandle | null>(null);
  const pendingRef = useRef<PendingPayment | null>(null);
  const speechSupported = useMemo(() => canListen(), []);

  // While the mic is open, silence the "voice guide" — otherwise MIKI
  // would speak control names into its own microphone.
  useEffect(() => {
    guidanceSuppressedRef.current =
      stage === 'listening' || stage === 'challenge' || stage === 'confirm';
  }, [stage, guidanceSuppressedRef]);

  /** Start a new async segment and invalidate any previous one. */
  const beginSegment = () => ++sessionRef.current;
  const isCurrent = (seg: number) => sessionRef.current === seg;

  /** Reset all flow state back to idle. */
  const resetToIdle = () => {
    pendingRef.current = null;
    setPendingAmount(null);
    setChallengeText('');
    setInterim('');
    setAuthBusy(false);
    setStage('idle');
  };

  /** Abort the running flow (user tapped mic/cancel while it was active). */
  const cancelFlow = () => {
    beginSegment(); // invalidate in-flight async steps
    listenHandleRef.current?.cancel();
    stopSpeaking();
    resetToIdle();
    void feedback('Cancelled.');
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 1 — listen for a command
  // ──────────────────────────────────────────────────────────────────────
  const startCommandSession = async () => {
    const seg = beginSegment();
    stopSpeaking();
    setInvoice(null); // clear any old invoice card
    setStage('listening');
    // Status text only — speaking now would feed back into the microphone.
    setStatus('Listening. Speak your command now.');
    setInterim('');

    const handle = listenOnce({
      timeoutMs: COMMAND_TIMEOUT_MS,
      onInterim: (text) => {
        if (isCurrent(seg)) setInterim(text);
      },
    });
    listenHandleRef.current = handle;
    const result = await handle.promise;
    if (!isCurrent(seg)) return; // cancelled meanwhile
    setInterim('');

    if (!result.transcript) {
      setStage('idle');
      if (result.error === 'not-allowed') {
        await feedback(
          'MIKI cannot use the microphone. Please allow microphone access in your browser, then try again.',
          'error',
        );
      } else if (result.error === 'unsupported') {
        await feedback(
          'Speech recognition is not supported in this browser. Please use Chrome on Android or Safari on iPhone.',
          'error',
        );
      } else {
        await feedback("I didn't hear anything. Tap the microphone and try again.", 'error');
      }
      return;
    }

    await runCommand(result.transcript);
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 2 — parse the command and dispatch
  // ──────────────────────────────────────────────────────────────────────
  const runCommand = async (transcript: string): Promise<void> => {
    const command = parseCommand(transcript);

    switch (command.type) {
      case 'balance':
        await runBalanceCheck();
        break;

      case 'send':
        if (command.amountSats <= 0) {
          setStage('idle');
          await feedback(
            'How much would you like to send? For example, say: send two hundred sats.',
            'error',
          );
        } else {
          await startSendFlow(command.amountSats);
        }
        break;

      case 'receive':
        if (command.amountSats <= 0) {
          setStage('idle');
          await feedback(
            'How much would you like to receive? For example, say: receive five hundred sats.',
            'error',
          );
        } else {
          await startReceiveFlow(command.amountSats);
        }
        break;

      case 'history':
        setStage('idle');
        await feedback('Opening your transaction history.', 'info', { focus: false });
        navigate('/history');
        break;

      case 'settings':
        setStage('idle');
        await feedback('Opening settings.', 'info', { focus: false });
        navigate('/settings');
        break;

      case 'repeat':
        setStage('idle');
        await repeatLast();
        break;

      case 'help':
        setStage('idle');
        await feedback(HELP_TEXT, 'info', { focus: true });
        break;

      default:
        setStage('idle');
        await feedback(
          `Sorry, I didn't understand "${transcript}". Say "help" to hear what you can ask.`,
          'error',
        );
    }
  };

  /** "Check balance" — no security needed, just read it out. */
  const runBalanceCheck = async (): Promise<void> => {
    const seg = beginSegment();
    setStage('busy');
    setStatus('Checking your balance…');
    try {
      const sats = await wallet.getBalance();
      if (!isCurrent(seg)) return;
      setStage('idle');
      await feedback(`Your balance is ${sats.toLocaleString()} sats.`, 'success');
    } catch {
      if (!isCurrent(seg)) return;
      setStage('idle');
      await feedback('Sorry, I could not check the balance. Please try again.', 'error');
    }
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 3 — SEND flow entry: cheap checks BEFORE any security prompt
  // ──────────────────────────────────────────────────────────────────────
  const startSendFlow = async (amountSats: number): Promise<void> => {
    // Spending limit check (Settings → "spending limit").
    if (amountSats > settings.spendingLimitSats) {
      setStage('idle');
      await feedback(
        `${amountSats.toLocaleString()} sats is over your spending limit of ` +
          `${settings.spendingLimitSats.toLocaleString()} sats. ` +
          'You can change the limit in settings.',
        'error',
      );
      return;
    }

    // Some auth method must exist before money can move.
    const biometricReady = isBiometricEnrolled();
    if (!biometricReady && !hasPin()) {
      setStage('idle');
      await feedback(
        'You need to set up sign-in security before sending payments. ' +
          'Opening the settings page now, where you can enable biometrics or create a PIN.',
        'info',
        { focus: true },
      );
      navigate('/settings');
      return;
    }

    pendingRef.current = { amountSats, pinAttempts: 0 };
    setPendingAmount(amountSats);
    setAuthMethod(biometricReady ? 'biometric' : 'pin');
    setStage('auth');
    await feedback(
      `Send ${amountSats.toLocaleString()} sats. For security, ` +
        (biometricReady
          ? 'approve with your fingerprint or face.'
          : `enter your ${PIN_LENGTH}-digit PIN.`),
      'info',
      { focus: true },
    );
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 3a — biometric approval (PRIMARY auth)
  // ──────────────────────────────────────────────────────────────────────
  const approveWithBiometric = async (): Promise<void> => {
    const pending = pendingRef.current;
    if (stageRef.current !== 'auth' || !pending) return;

    setAuthBusy(true);
    void feedback('Check your device to approve the payment.'); // not awaited — the OS prompt opens instantly
    const ok = await verifyBiometric();
    setAuthBusy(false);
    if (stageRef.current !== 'auth' || pendingRef.current !== pending) return;

    if (ok) {
      await runChallenge(); // → step 4
    } else {
      // focus: false — the auth dialog's own status line takes the focus.
      await feedback(
        'Biometric check failed. Try again, or use your PIN instead.',
        'error',
        { focus: false },
      );
    }
  };

  /** Switch from biometric approval to the typed-PIN fallback. */
  const usePinInstead = () => {
    if (stageRef.current !== 'auth') return;
    setAuthMethod('pin');
    void feedback(`Enter your ${PIN_LENGTH}-digit PIN.`, 'info', { focus: false });
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 3b — typed PIN approval (FALLBACK auth; typed, never spoken)
  // ──────────────────────────────────────────────────────────────────────
  const submitPin = async (pin: string): Promise<'ok' | 'retry' | 'cancelled'> => {
    const pending = pendingRef.current;
    if (stageRef.current !== 'auth' || !pending) return 'cancelled';

    const ok = await verifyPin(pin);
    if (stageRef.current !== 'auth' || pendingRef.current !== pending) {
      return 'cancelled'; // flow was cancelled while hashing
    }

    if (!ok) {
      pending.pinAttempts += 1;
      const left = MAX_PIN_ATTEMPTS - pending.pinAttempts;
      if (left <= 0) {
        resetToIdle();
        await feedback('Too many wrong attempts. Payment cancelled.', 'error');
        return 'cancelled';
      }
      // focus: false — the PIN dialog's own status line takes the focus.
      await feedback(
        `Wrong PIN. ${left} ${left === 1 ? 'attempt' : 'attempts'} left. Try again.`,
        'error',
        { focus: false },
      );
      return 'retry';
    }

    // PIN correct → move on to the arithmetic challenge.
    await runChallenge();
    return 'ok';
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 4 — arithmetic challenge (anti-replay liveness check)
  // ──────────────────────────────────────────────────────────────────────
  const runChallenge = async (): Promise<void> => {
    const pending = pendingRef.current;
    if (!pending) return;
    const seg = beginSegment();

    const challenge = generateChallenge();
    setChallengeText(challenge.questionText);
    setStage('challenge');
    // New challenge = important update → focus the status region too.
    await feedback(
      `Security check. ${challenge.questionSpeech} You have 45 seconds to answer.`,
      'info',
      { focus: true },
    );
    if (!isCurrent(seg)) return;

    // ── FUTURE: VOICE-PRINT CHECK ──────────────────────────────────────
    // A voice-print (speaker verification) step belongs RIGHT HERE, after
    // the challenge and before confirmation. The pipeline would become:
    //
    //   const voiceprintOk = await voiceprintVerifier.check(sample);
    //   if (!voiceprintOk) { resetToIdle(); await feedback('Voice not
    //   recognised. Payment cancelled.', 'error'); return; }
    //
    // The challenge answer audio can even be reused as the voice sample,
    // so the user experience does not change.
    // ────────────────────────────────────────────────────────────────────

    const result = await listenWithDeadline({
      timeoutMs: CHALLENGE_TIMEOUT_MS,
      onInterim: (text) => {
        if (isCurrent(seg)) setInterim(text);
      },
      isCancelled: () => !isCurrent(seg),
      // Register each live session so cancelFlow() can abort it instantly.
      onSession: (handle) => {
        listenHandleRef.current = handle;
      },
    });
    if (!isCurrent(seg)) return;
    setInterim('');
    setChallengeText('');

    if (!result.transcript) {
      resetToIdle();
      await feedback(
        result.error === 'not-allowed'
          ? 'MIKI cannot use the microphone. Payment cancelled.'
          : 'Time is up. Payment cancelled.',
        'error',
      );
      return;
    }

    const answer = parseSpokenNumber(result.transcript);
    if (!checkChallengeAnswer(challenge, answer)) {
      resetToIdle();
      await feedback('That answer is not correct. Payment cancelled.', 'error');
      return;
    }

    await runConfirmation();
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 5 — final voice confirmation ("yes" / "no")
  // ──────────────────────────────────────────────────────────────────────
  const runConfirmation = async (): Promise<void> => {
    const pending = pendingRef.current;
    if (!pending) return;
    const seg = beginSegment();

    setStage('confirm');
    await feedback(
      `Almost done. Say YES to send ${pending.amountSats.toLocaleString()} sats, or NO to cancel.`,
      'info',
      { focus: true },
    );
    if (!isCurrent(seg)) return;

    const result = await listenWithDeadline({
      timeoutMs: CONFIRM_TIMEOUT_MS,
      onInterim: (text) => {
        if (isCurrent(seg)) setInterim(text);
      },
      isCancelled: () => !isCurrent(seg),
      onSession: (handle) => {
        listenHandleRef.current = handle;
      },
    });
    if (!isCurrent(seg)) return;
    setInterim('');

    const said = result.transcript ?? '';
    if (result.transcript && isYes(said) && !isNo(said)) {
      await executePayment();
      return;
    }

    // "no", silence, or gibberish → cancel. User-initiated, so it's 'info'.
    resetToIdle();
    await feedback('Payment cancelled.');
  };

  // ──────────────────────────────────────────────────────────────────────
  // STEP 6 — execute the payment
  // ──────────────────────────────────────────────────────────────────────
  const executePayment = async (): Promise<void> => {
    const pending = pendingRef.current;
    if (!pending) return;
    const seg = beginSegment();

    setStage('busy');
    setStatus(`Sending ${pending.amountSats.toLocaleString()} sats…`);

    // NOTE: the mock "send" command has no real recipient invoice, so we
    // synthesise a placeholder. With NWC this will be a real BOLT11 invoice
    // (scanned, pasted, or from a contact) — the pipeline is unchanged.
    const placeholderInvoice = `lnbc-miki-voice-${pending.amountSats}`;

    try {
      await wallet.payInvoice(placeholderInvoice, pending.amountSats);
      if (!isCurrent(seg)) return;

      addTransaction({
        direction: 'out',
        amountSats: pending.amountSats,
        memo: 'Voice payment',
        status: 'success',
      });
      const newBalance = await refreshBalance();
      if (!isCurrent(seg)) return;
      resetToIdle();
      // ONE long buzz + speech + status text via the shared channel.
      await feedback(
        `Payment sent. ${pending.amountSats.toLocaleString()} sats. ` +
          (newBalance !== null
            ? `Your new balance is ${newBalance.toLocaleString()} sats.`
            : ''),
        'success',
      );
    } catch (error) {
      if (!isCurrent(seg)) return;
      addTransaction({
        direction: 'out',
        amountSats: pending.amountSats,
        memo: 'Voice payment',
        status: 'failed',
      });
      resetToIdle();
      // THREE short buzzes + speech + status text via the shared channel.
      await feedback(
        error instanceof Error ? error.message : 'Payment failed. Please try again.',
        'error',
      );
    }
  };

  // ──────────────────────────────────────────────────────────────────────
  // RECEIVE flow — create an invoice and show it (auto-settles in the mock)
  // ──────────────────────────────────────────────────────────────────────
  const startReceiveFlow = async (amountSats: number): Promise<void> => {
    const seg = beginSegment();
    setStage('busy');
    setStatus(`Creating an invoice for ${amountSats.toLocaleString()} sats…`);

    try {
      const created = await wallet.createInvoice(
        amountSats,
        `MIKI receive ${amountSats} sats`,
      );
      if (!isCurrent(seg)) return;
      setInvoice(created);
      setStage('idle');
      await feedback(
        `Invoice created for ${amountSats.toLocaleString()} sats. It is shown on the screen. ` +
          'In this demo, the invoice will be paid automatically in a few seconds.',
        'success',
      );
    } catch (error) {
      if (!isCurrent(seg)) return;
      setStage('idle');
      await feedback(
        error instanceof Error
          ? error.message
          : 'Could not create the invoice. Please try again.',
        'error',
      );
    }
  };

  // ──────────────────────────────────────────────────────────────────────
  // The ONE big mic button — behaviour depends on the current stage
  // ──────────────────────────────────────────────────────────────────────
  const pressMic = () => {
    switch (stageRef.current) {
      case 'idle':
        if (!speechSupported) {
          void feedback(
            'Speech recognition is not supported in this browser. Please use Chrome on Android or Safari on iPhone.',
            'error',
          );
          return;
        }
        void startCommandSession();
        break;
      case 'listening':
      case 'challenge':
      case 'confirm':
        cancelFlow(); // tapping while listening cancels the flow
        break;
      case 'auth':
      case 'busy':
        break; // overlays / wallet work own the screen right now
    }
  };

  const dismissInvoice = () => setInvoice(null);

  // If the tab is hidden mid-flow, cancel — a half-open mic while the user
  // can't see the screen is confusing (and browsers may kill the session).
  useEffect(() => {
    const onVisibility = () => {
      const s = stageRef.current;
      if (document.hidden && s !== 'idle' && s !== 'busy') {
        cancelFlow();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  return {
    stage,
    interim,
    challengeText,
    pendingAmount,
    invoice,
    speechSupported,
    authMethod,
    authBusy,
    pressMic,
    cancelFlow,
    submitPin,
    approveWithBiometric,
    usePinInstead,
    dismissInvoice,
  };
}
