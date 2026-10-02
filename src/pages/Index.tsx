/**
 * MIKI home screen — the voice-controlled wallet.
 *
 * Layout (top to bottom, matching screen-reader reading order):
 *   1. (from the layout) THE shared status region
 *   2. balance (polite live region — announces itself when it changes)
 *   3. interim transcript / challenge question / invoice card
 *   4. example commands in a <details> disclosure
 *   5. the giant mic button filling the bottom half of the screen
 *
 * All behaviour lives in `useVoiceWallet` — this file only renders state.
 * All spoken+visible+vibration output flows through the shared feedback()
 * channel in the MIKI context.
 */

import { useSeoMeta } from '@unhead/react';

import { AuthScreen } from '@/components/miki/AuthScreen';
import { InvoiceCard } from '@/components/miki/InvoiceCard';
import { MicButton } from '@/components/miki/MicButton';
import { PinScreen } from '@/components/miki/PinScreen';
import { AlertIcon } from '@/components/miki/icons';
import { useMiki } from '@/hooks/useMiki';
import { useVoiceWallet } from '@/hooks/useVoiceWallet';
import { satsToBTC } from '@/lib/currency'; 

export default function Index() {
  const voice = useVoiceWallet();
  const { balance, status } = useMiki();

  useSeoMeta({
    title: 'MIKI — Voice-Controlled Bitcoin Wallet',
    description:
      'MIKI is an accessible, voice-controlled Bitcoin Lightning wallet for blind and low-vision users.',
  });

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">MIKI, voice-controlled Bitcoin wallet. Wallet screen.</h1>

      {/* ── Top half: balance + live transcript + (challenge | invoice | examples) ── */}
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {/* Balance — announced politely whenever it changes. */}
        <p aria-live="polite" aria-atomic="true" className="text-2xl font-bold text-white">
          Balance:{' '}
          <span className="text-yellow-400">
            {balance === null
              ? '…'
              : `${balance.toLocaleString()} sats (${satsToBTC(balance)} BTC)`}
          </span>
        </p>

        {/* Live "what the mic hears" caption — polite, never interrupting. */}
        <p
          aria-live="polite"
          aria-atomic="true"
          aria-label="What MIKI is hearing"
          className="min-h-8 text-xl italic text-neutral-400"
        >
          {voice.interim ? `“${voice.interim}”` : ''}
        </p>

        {/* The arithmetic challenge, in huge type, while it's active. */}
        {voice.challengeText && (
          <p className="rounded-2xl bg-neutral-900 p-4 text-center text-4xl font-black text-yellow-300">
            {voice.challengeText}
          </p>
        )}

        {/* Warning when the browser can't do speech recognition at all. */}
        {!voice.speechSupported && (
          <p
            role="alert"
            className="flex items-start gap-3 rounded-2xl border-2 border-destructive p-4 text-lg font-semibold text-destructive"
          >
            <AlertIcon size={28} className="mt-0.5 shrink-0" />
            Speech recognition is not supported in this browser. For the full
            voice experience, please use Chrome on Android or Safari on iPhone.
          </p>
        )}

        {/* Freshly created invoice (receive flow). */}
        {voice.invoice && (
          <InvoiceCard invoice={voice.invoice} onDismiss={voice.dismissInvoice} />
        )}

        {/* Example commands — native disclosure, screen-reader friendly. */}
        <details className="rounded-2xl border border-neutral-700 bg-neutral-900 p-4">
          <summary className="min-h-12 cursor-pointer text-xl font-bold text-white focus-visible:outline-4 focus-visible:outline-yellow-300">
            What can I say?
          </summary>
          <ul className="mt-3 list-inside list-disc space-y-2 text-lg text-neutral-300">
            <li>“Check balance”</li>
            <li>“Send 200 sats”</li>
            <li>“Receive 500 sats”</li>
            <li>“History” or “Settings”</li>
            <li>“Repeat” — hear the last message again</li>
          </ul>
        </details>
      </div>

      {/* ── Bottom half: the mic ── */}
      <MicButton
        stage={voice.stage}
        speechSupported={voice.speechSupported}
        onPress={voice.pressMic}
      />

      {/* ── Payment authorization overlay (biometric primary, PIN fallback) ── */}
      {voice.stage === 'auth' &&
        (voice.authMethod === 'biometric' ? (
          <AuthScreen
            prompt={
              voice.pendingAmount !== null
                ? `Send ${voice.pendingAmount.toLocaleString()} sats`
                : 'Confirm your payment'
            }
            status={status}
            busy={voice.authBusy}
            onBiometric={() => void voice.approveWithBiometric()}
            onUsePin={voice.usePinInstead}
            onCancel={voice.cancelFlow}
          />
        ) : (
          <PinScreen
            prompt={
              voice.pendingAmount !== null
                ? `Send ${voice.pendingAmount.toLocaleString()} sats`
                : 'Confirm your payment'
            }
            status={status}
            onSubmit={voice.submitPin}
            onCancel={voice.cancelFlow}
          />
        ))}
    </div>
  );
}
