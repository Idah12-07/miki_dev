/**
 * MikiLayout — the shared shell for every MIKI screen.
 *
 * Provides the MikiProvider (settings + wallet + feedback + speech) and
 * renders, in a predictable top-to-bottom reading order:
 *
 *   1. skip link (keyboard/screen-reader users can jump past the header)
 *   2. header landmark: wordmark, voice-guide toggle, repeat button
 *   3. nav landmark: Wallet / History / Settings
 *   4. main landmark: THE status region (shared live region + focus target)
 *      and then the current page — or the LockScreen when signed out
 *   5. footer
 *
 * Screen-reader users jump between these landmarks exactly like in native
 * apps, and dynamic updates are announced automatically via the status
 * region (no manual re-navigation needed).
 */

import { useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { MikiProvider } from '@/components/miki/MikiProvider';
import { LockScreen } from '@/components/miki/LockScreen';
import { useMiki } from '@/hooks/useMiki';
import { isBiometricEnrolled } from '@/lib/webauthn';
import { cn } from '@/lib/utils';
import { EarIcon, HistoryIcon, RepeatIcon, SettingsIcon, WalletIcon, ZapIcon } from './icons';

/** One big navigation tab (Wallet / History / Settings). */
function NavTab({
  to,
  label,
  icon,
  end = false,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      // NavLink sets aria-current="page" automatically on the active route.
      className={({ isActive }) =>
        cn(
          'flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3',
          'text-lg font-bold transition-colors',
          'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-yellow-300',
          isActive
            ? 'bg-yellow-400 text-black'
            : 'bg-neutral-900 text-white hover:bg-neutral-800',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}

/**
 * THE status region — every feedback() message appears here.
 *
 * It is BOTH an assertive live region (TalkBack/VoiceOver announce changes
 * automatically) AND a programmatic focus target (`tabIndex={-1}` +
 * `focusStatus()`), which is what refreshable Braille displays need —
 * aria-live alone doesn't reliably reach them.
 *
 * There is exactly ONE of these in the app, on purpose: a single
 * predictable place where "what just happened" always lives.
 */
function StatusRegion() {
  const { status, statusRef } = useMiki();
  return (
    <div
      ref={statusRef}
      tabIndex={-1}
      role="status"
      aria-live="assertive"
      aria-atomic="true"
      aria-label="Status message"
      className="mx-auto w-full max-w-2xl px-4 pt-4 outline-none"
    >
      <p className="rounded-2xl bg-neutral-900 p-4 text-2xl font-bold leading-snug text-white sm:text-3xl">
        {status}
      </p>
    </div>
  );
}

/** The header + content + footer, rendered inside MikiProvider. */
function Shell() {
  const { repeatLast, lastMessage, settings, updateSettings, unlocked } = useMiki();
  // Read enrolment once at app load (the lock screen only matters at launch).
  const [biometricEnrolled] = useState(() => isBiometricEnrolled());

  return (
    <div className="flex min-h-dvh flex-col bg-black text-white">
      {/* Skip link: invisible until focused, then jumps to #main-content. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-yellow-400 focus:px-4 focus:py-3 focus:text-lg focus:font-bold focus:text-black"
      >
        Skip to main content
      </a>

      <header className="border-b-2 border-neutral-800 px-4 pb-3 pt-4">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3">
          {/* Wordmark (purely decorative — not a focus stop). */}
          <div className="flex items-center gap-2" aria-label="MIKI voice wallet">
            <ZapIcon size={32} className="text-yellow-400" />
            <span className="text-3xl font-black tracking-widest text-yellow-400">MIKI</span>
          </div>

          <div className="flex items-center gap-2">
            {/* Voice-guide toggle: touch-to-hear exploration on/off. */}
            <button
              type="button"
              role="switch"
              aria-checked={settings.voiceGuidance}
              aria-label="Voice guide, touch to hear"
              data-speak={`Voice guide, touch to hear. Currently ${settings.voiceGuidance ? 'on' : 'off'}.`}
              onClick={() => {
                const next = !settings.voiceGuidance;
                updateSettings({ voiceGuidance: next });
              }}
              className={cn(
                'flex min-h-12 min-w-12 items-center justify-center rounded-xl border-2 px-3',
                'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-white',
                settings.voiceGuidance
                  ? 'border-yellow-400 bg-yellow-400 text-black'
                  : 'border-neutral-600 text-neutral-400 hover:border-yellow-400 hover:text-yellow-400',
              )}
            >
              <EarIcon size={24} />
            </button>

            {/* Repeat last message — a core accessibility feature. */}
            <button
              type="button"
              onClick={() => void repeatLast()}
              disabled={!lastMessage}
              aria-label="Repeat the last spoken message"
              className={cn(
                'flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-xl px-4',
                'border-2 border-yellow-400 text-lg font-bold text-yellow-400',
                'hover:bg-yellow-400 hover:text-black',
                'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-white',
                'disabled:cursor-not-allowed disabled:border-neutral-700 disabled:text-neutral-600 disabled:hover:bg-transparent',
              )}
            >
              <RepeatIcon size={22} />
              <span className="hidden sm:inline">Repeat</span>
            </button>
          </div>
        </div>

        {/* Main navigation — hidden while locked (nothing to navigate to). */}
        {unlocked && (
          <nav aria-label="Main" className="mx-auto mt-3 flex w-full max-w-2xl gap-2">
            <NavTab to="/" end label="Wallet" icon={<WalletIcon size={22} />} />
            <NavTab to="/history" label="History" icon={<HistoryIcon size={22} />} />
            <NavTab to="/settings" label="Settings" icon={<SettingsIcon size={22} />} />
          </nav>
        )}
      </header>

      <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {/* THE status region comes first in the main landmark, always. */}
        <StatusRegion />
        {unlocked ? <Outlet /> : <LockScreen biometricEnrolled={biometricEnrolled} />}
      </main>

    
    </div>
  );
}

export function MikiLayout() {
  return (
    <MikiProvider>
      <Shell />
    </MikiProvider>
  );
}
