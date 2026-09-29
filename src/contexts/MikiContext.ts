/**
 * MIKI app context — the shared "shape" of MIKI's global state.
 *
 * This file only holds the context object, types and defaults — mirroring
 * how the template organises `AppContext`. The wiring lives in:
 *   - `src/components/miki/MikiProvider.tsx` (the provider component)
 *   - `src/hooks/useMiki.ts`                    (the hook to consume it)
 */

import { createContext, type RefObject } from 'react';

import type { WalletProvider } from '@/lib/wallet/types';

// ── Settings ────────────────────────────────────────────────────────────────

export interface MikiSettings {
  /** TTS speed multiplier (0.5 = half speed … 2 = double speed). */
  speechRate: number;
  /** Maximum sats allowed per outgoing payment. */
  spendingLimitSats: number;
  /** Demo tool: force the mock wallet to fail the next payments. */
  mockFailure: boolean;
  /**
   * "Voice guide": when on, touching/focusing any control makes MIKI speak
   * its name and a TalkBack-style hint ("Wallet. Double tap to activate.").
   * This helps users who are NOT running a full screen reader.
   */
  voiceGuidance: boolean;
}

export const DEFAULT_SETTINGS: MikiSettings = {
  speechRate: 1,
  spendingLimitSats: 1_000,
  mockFailure: false,
  voiceGuidance: true,
};

export const SETTINGS_STORAGE_KEY = 'miki.settings';

// ── Feedback ─────────────────────────────────────────────────────────────────

/**
 * Every user-facing result has a "kind", and each kind maps to a distinct
 * vibration pattern (deafblind users feel the difference):
 *   - 'success'  → ONE long buzz   (payment sent, balance read, task done)
 *   - 'received' → TWO short buzzes (payment arrived, signed in)
 *   - 'error'    → THREE short buzzes (wrong PIN, failed payment, timeout…)
 *   - 'info'     → no vibration    (status changes, guidance, help)
 */
export type FeedbackKind = 'success' | 'received' | 'error' | 'info';

export interface FeedbackOptions {
  /**
   * Move keyboard focus to the status region? Needed for important updates
   * (errors, results, new challenge, screen changes) so hardware Braille
   * displays land on the message. aria-live alone is not enough for them.
   * Default: true for success/received/error, false for info.
   */
  focus?: boolean;
}

// ── Context value ────────────────────────────────────────────────────────────

export interface MikiContextValue {
  // Settings
  settings: MikiSettings;
  updateSettings: (patch: Partial<MikiSettings>) => void;

  // Wallet
  wallet: WalletProvider;
  balance: number | null;
  refreshBalance: () => Promise<number | null>;
  resetDemo: () => Promise<void>;

  // THE shared feedback channel — ALL user-facing output goes through here:
  // it speaks the message, shows it in THE one status region, and plays the
  // matching vibration pattern. Deafblind-friendly by construction.
  feedback: (message: string, kind?: FeedbackKind, opts?: FeedbackOptions) => Promise<void>;
  /** The current status message (rendered by the layout's StatusRegion). */
  status: string;
  /**
   * Set the status text WITHOUT speaking it. Rarely needed — prefer
   * `feedback`. Used when the mic is about to open (speaking would be
   * picked up by the microphone itself).
   */
  setStatus: (message: string) => void;
  /** Bind to THE status region element (the layout does this once). */
  statusRef: RefObject<HTMLDivElement | null>;
  /** Move keyboard focus to the status region. */
  focusStatus: () => void;
  /**
   * While true, the "voice guide" stays quiet — set by the voice flow
   * whenever the microphone is open (otherwise MIKI would hear itself).
   */
  guidanceSuppressedRef: RefObject<boolean>;

  // Speech
  /** Speak a message aloud and remember it for "repeat last message". */
  say: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  repeatLast: () => Promise<void>;
  lastMessage: string;

  // Sign-in (biometric primary, PIN fallback)
  unlocked: boolean;
  unlock: () => void;
  /** null = still detecting; true/false = this device can/can't do biometrics. */
  biometricAvailable: boolean | null;
  /** Re-run platform-authenticator detection (after enrolment changes). */
  refreshBiometricAvailability: () => Promise<void>;
}

export const MikiContext = createContext<MikiContextValue | null>(null);
