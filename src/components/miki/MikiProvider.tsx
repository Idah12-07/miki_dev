/**
 * MikiProvider — wires MIKI's global state together:
 *
 *   1. SETTINGS   (speech rate, spending limit, demo switch, voice guide)
 *   2. WALLET     (the WalletProvider instance + live balance)
 *   3. FEEDBACK   (THE shared output channel: speak + status text + vibrate)
 *   4. VOICE GUIDE (touch/focus any control → MIKI says what it is)
 *   5. SPEECH     (text-to-speech with "repeat last message")
 *   6. SIGN-IN    (biometric primary, PIN fallback — see lib/webauthn.ts)
 *
 * TO USE A REAL WALLET: create an NWC implementation of `WalletProvider`
 * (see src/lib/wallet/types.ts for the method-by-method mapping) and
 * replace `new MockWallet()` below. Nothing else in the app changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  DEFAULT_SETTINGS,
  MikiContext,
  SETTINGS_STORAGE_KEY,
  type FeedbackKind,
  type FeedbackOptions,
  type MikiContextValue,
  type MikiSettings,
} from '@/contexts/MikiContext';
import { buzzError, buzzReceived, buzzSuccess } from '@/lib/haptics';
import { hasPin } from '@/lib/pin';
import { speak as speakText, stopSpeaking as stopSpeech } from '@/lib/speech/speak';
import { addTransaction, clearTransactions } from '@/lib/transactions';
import { MockWallet } from '@/lib/wallet/mockWallet';
import type { IncomingPayment, WalletProvider } from '@/lib/wallet/types';
import { isBiometricAvailable, isBiometricEnrolled } from '@/lib/webauthn';

function loadSettings(): MikiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<MikiSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Feedback kind → vibration pattern (deafblind users feel the difference). */
const KIND_BUZZ: Record<FeedbackKind, (() => void) | null> = {
  success: buzzSuccess,   // ONE long buzz
  received: buzzReceived, // TWO short buzzes
  error: buzzError,       // THREE short buzzes
  info: null,             // silent
};

/** Which feedback kinds move keyboard focus to the status region by default. */
const KIND_MOVES_FOCUS: Record<FeedbackKind, boolean> = {
  success: true,
  received: true,
  error: true,
  info: false,
};

/**
 * Spoken once at launch: orients users who can't see the screen.
 * (Requested behaviour — MIKI's whole point is voice output. Browsers that
 * block speech before the first touch get it on the first touch instead.)
 */
const WELCOME_MESSAGE =
  'Welcome to MIKI, your talking wallet. ' +
  'Touch anything on the screen to hear what it is, then double tap to activate it. ' +
  'The large button at the bottom of the screen is the microphone. ' +
  'Tap it, then speak a command, like: check balance.';

export function MikiProvider({ children }: { children: ReactNode }) {
  // ── 1. Settings ──
  const [settings, setSettings] = useState<MikiSettings>(loadSettings);

  const updateSettings = useCallback((patch: Partial<MikiSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — settings just won't persist */
      }
      return next;
    });
  }, []);

  // ── 2. Wallet ──
  // The ref pattern guarantees exactly ONE wallet instance per app lifetime.
  const walletRef = useRef<WalletProvider | null>(null);
  if (!walletRef.current) {
    walletRef.current = new MockWallet();
  }
  const wallet = walletRef.current;

  const [balance, setBalance] = useState<number | null>(null);

  const refreshBalance = useCallback(async (): Promise<number | null> => {
    try {
      const sats = await wallet.getBalance();
      setBalance(sats);
      return sats;
    } catch {
      return null;
    }
  }, [wallet]);

  useEffect(() => {
    if (wallet instanceof MockWallet) {
      wallet.setForceFailure(settings.mockFailure);
    }
  }, [wallet, settings.mockFailure]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // ── 3. THE shared feedback channel ──
  const [status, setStatusState] = useState(
    'Welcome to MIKI. Tap the big microphone button and speak. Say "help" for examples.',
  );
  const statusRef = useRef<HTMLDivElement | null>(null);
  const [lastMessage, setLastMessage] = useState('');
  const rateRef = useRef(settings.speechRate);
  rateRef.current = settings.speechRate;

  const setStatus = useCallback((message: string) => setStatusState(message), []);

  /**
   * Move REAL keyboard focus to the status region. aria-live regions alone
   * are not reliably reached by refreshable Braille displays — physically
   * landing focus there is what makes them pick the message up.
   */
  const focusStatus = useCallback(() => {
    statusRef.current?.focus();
  }, []);

  /**
   * THE one function for all user-facing output. It always does three
   * things at once: show the text, speak the text, buzz the pattern for
   * the result kind — so sighted, blind AND deafblind users all get the
   * same information through their own channel.
   */
  const feedback = useCallback(
    async (message: string, kind: FeedbackKind = 'info', opts: FeedbackOptions = {}) => {
      setStatusState(message);          // 1. visible status text
      setLastMessage(message);          //    (and "repeat last message")
      KIND_BUZZ[kind]?.();              // 2. distinct vibration pattern
      const shouldFocus = opts.focus ?? KIND_MOVES_FOCUS[kind];
      if (shouldFocus) focusStatus();   // 3. land Braille/keyboard focus
      await speakText(message, { rate: rateRef.current }); // 4. spoken output
    },
    [focusStatus],
  );

  // ── 4. Speech helpers ──
  const say = useCallback(async (text: string): Promise<void> => {
    setLastMessage(text);
    await speakText(text, { rate: rateRef.current });
  }, []);

  const stopSpeaking = useCallback(() => stopSpeech(), []);

  const repeatLast = useCallback(async (): Promise<void> => {
    if (!lastMessage) return;
    await speakText(lastMessage, { rate: rateRef.current });
  }, [lastMessage]);

  // ── 5. Sign-in state (biometric primary, PIN fallback) ──
  // The app locks at launch whenever ANY auth method is enrolled.
  const [unlocked, setUnlocked] = useState(() => !isBiometricEnrolled() && !hasPin());
  const unlock = useCallback(() => setUnlocked(true), []);

  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  const refreshBiometricAvailability = useCallback(async () => {
    setBiometricAvailable(await isBiometricAvailable());
  }, []);
  useEffect(() => {
    void refreshBiometricAvailability();
  }, [refreshBiometricAvailability]);

  // ── 6. Global incoming-payment announcements ──
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const refreshRef = useRef(refreshBalance);
  refreshRef.current = refreshBalance;

  useEffect(() => {
    const unsubscribe = wallet.subscribe((payment: IncomingPayment) => {
      addTransaction({
        direction: 'in',
        amountSats: payment.amountSats,
        memo: payment.memo || 'Incoming payment',
        status: 'success',
        invoice: payment.invoice,
      });
      void refreshRef.current();
      void feedbackRef.current(
        `Payment received! ${payment.amountSats} sats have arrived in your wallet.`,
        'received', // TWO short buzzes
      );
    });
    return unsubscribe;
  }, [wallet]);

  // ── 7. The "voice guide" — touch or focus anything to hear what it is ──
  //
  // Mimics TalkBack/VoiceOver explore-by-touch for users NOT running a full
  // screen reader. With the guide ON:
  //
  //   EXPLORE   first touch on a control → MIKI speaks its name + a hint
  //             ("Wallet. Double tap to open.") and DOESN'T activate it
  //   ACTIVATE  second touch on the SAME control (within 4s) → activates
  //
  // Keyboard users are never blocked (Enter/Space always activates — they
  // already heard the name via focus). Sliders are never blocked (dragging
  // must keep working). The mic button opts out via data-no-guide because
  // its whole flow is spoken feedback already. Users running a REAL screen
  // reader get the same behaviour from their OS and can switch this layer
  // off (header toggle or Settings) to avoid double speech.
  const guidanceSuppressedRef = useRef(false); // true while the mic is open
  const guidanceOn = settings.voiceGuidance;

  useEffect(() => {
    if (!guidanceOn) return;

    const ACTIVATE_WINDOW_MS = 4_000; // 2nd touch within this = activate
    const SPEAK_DEBOUNCE_MS = 800;    // don't re-speak the same element

    let exploredEl: Element | null = null;  // last explored (spoken) element
    let exploredAt = 0;
    let spokenEl: Element | null = null;    // speak debounce
    let spokenAt = 0;
    let suppressClickFor: Element | null = null;

    const interactiveOf = (target: EventTarget | null): Element | null => {
      if (!(target instanceof Element)) return null;
      return target.closest(
        'button, a[href], input, select, textarea, summary, [role="switch"], [role="radio"], [data-speak]',
      );
    };

    /** Speak the control's accessible name + a TalkBack-style hint. */
    const describe = (el: Element, viaKeyboard: boolean) => {
      const now = Date.now();
      if (el === spokenEl && now - spokenAt < SPEAK_DEBOUNCE_MS) return;

      const name =
        el.getAttribute('data-speak') ??
        el.getAttribute('aria-label') ??
        el.textContent?.replace(/\s+/g, ' ').trim() ??
        '';
      if (!name) return;

      const activateHint = viaKeyboard ? 'Press Enter to activate.' : 'Double tap to activate.';
      let hint = '';
      if (!el.hasAttribute('data-no-hint')) {
        const role = el.getAttribute('role');
        if (role === 'switch') hint = viaKeyboard ? 'Press Enter to toggle.' : 'Double tap to toggle.';
        else if (role === 'radio') hint = viaKeyboard ? 'Press Enter to select.' : 'Double tap to select.';
        else if (el.tagName === 'A') hint = viaKeyboard ? 'Press Enter to open.' : 'Double tap to open.';
        else if (el.tagName === 'INPUT' && el.getAttribute('type') === 'range')
          hint = 'Use the arrow keys, or swipe up and down, to adjust.';
        else if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY') hint = activateHint;
      }

      spokenEl = el;
      spokenAt = now;
      void speakText(`${name}. ${hint}`.trim(), { rate: rateRef.current });
    };

    /** pointerdown = a touch/mouse "explore OR activate" decision point. */
    const onPointerDown = (event: Event) => {
      if (guidanceSuppressedRef.current) return; // mic is open — stay quiet
      if ((event as PointerEvent).button !== 0) return; // main button/finger only

      const el = interactiveOf(event.target);
      if (!el || el.closest('[data-no-guide]')) return;

      // Sliders: speak, but never block — dragging must keep working.
      if (el.tagName === 'INPUT') {
        describe(el, false);
        return;
      }

      const now = Date.now();
      if (el === exploredEl && now - exploredAt <= ACTIVATE_WINDOW_MS) {
        // Second touch on the same control → ACTIVATE: let the click
        // through, say nothing (the app's own feedback takes over).
        exploredEl = null;
        suppressClickFor = null; // belt & braces: never block an activation
        return;
      }

      // First touch → EXPLORE: speak it, and block the click that follows.
      exploredEl = el;
      exploredAt = now;
      describe(el, false);
      suppressClickFor = el;
    };

    /** Block the click of an "explore" tap (but never keyboard clicks). */
    const onClickCapture = (event: Event) => {
      if ((event as MouseEvent).detail === 0) return; // keyboard activation
      if (!suppressClickFor) return;
      const el = interactiveOf(event.target);
      if (el && el === suppressClickFor) {
        event.preventDefault();
        event.stopPropagation();
      }
      suppressClickFor = null;
    };

    /** Keyboard / screen-reader focus movement also speaks (never blocks). */
    const onFocusIn = (event: Event) => {
      if (guidanceSuppressedRef.current) return;
      const el = interactiveOf(event.target);
      if (!el || el.closest('[data-no-guide]')) return;
      describe(el, true);
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('focusin', onFocusIn, true);
    };
  }, [guidanceOn]);

  // ── 8. Welcome instructions at launch ──
  // Played once per app launch. Desktop browsers allow speech right away;
  // iOS/Android browsers block it until the first touch, so we keep a
  // one-time touch listener as the fallback (speech is never "autoplayed"
  // media — it IS the interface — but we still respect the gesture rule).
  useEffect(() => {
    if (!unlocked || !guidanceOn) return;

    let started = false;
    const trySpeak = () => {
      if (!started) void speakText(WELCOME_MESSAGE, { rate: rateRef.current });
    };

    trySpeak(); // works immediately where speech isn't gesture-gated

    // Confirm speech actually started; if not (iOS gesture gate), the
    // one-time touch listener below plays the welcome on the first touch.
    const timer = setTimeout(() => {
      if (
        'speechSynthesis' in window &&
        (window.speechSynthesis.speaking || window.speechSynthesis.pending)
      ) {
        started = true;
      }
    }, 600);
    window.addEventListener('pointerdown', trySpeak, { once: true });

    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', trySpeak);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // once per app launch, deliberately

  // ── 9. Reset demo ──
  const resetDemo = useCallback(async (): Promise<void> => {
    if (wallet instanceof MockWallet) wallet.reset();
    clearTransactions();
    setBalance(null);
    await refreshBalance();
  }, [wallet, refreshBalance]);

  const value = useMemo<MikiContextValue>(
    () => ({
      settings,
      updateSettings,
      wallet,
      balance,
      refreshBalance,
      resetDemo,
      feedback,
      status,
      setStatus,
      statusRef,
      focusStatus,
      guidanceSuppressedRef,
      say,
      stopSpeaking,
      repeatLast,
      lastMessage,
      unlocked,
      unlock,
      biometricAvailable,
      refreshBiometricAvailability,
    }),
    [
      settings,
      updateSettings,
      wallet,
      balance,
      refreshBalance,
      resetDemo,
      feedback,
      status,
      setStatus,
      focusStatus,
      say,
      stopSpeaking,
      repeatLast,
      lastMessage,
      unlocked,
      unlock,
      biometricAvailable,
      refreshBiometricAvailability,
    ],
  );

  return <MikiContext.Provider value={value}>{children}</MikiContext.Provider>;
}
