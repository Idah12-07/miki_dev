/**
 * MicButton — THE main control of MIKI.
 *
 * It intentionally fills the entire bottom half of the screen: the primary
 * interaction for a blind user must be impossible to miss and impossible to
 * mis-tap. What happens on press depends on the voice flow's stage:
 *
 *   idle                  → start listening for a command
 *   listening/challenge/  → cancel the current flow
 *   confirm
 *   auth/busy             → nothing (an overlay owns the screen)
 *
 * The label text AND the aria-label always describe the current behaviour,
 * and the colour changes (yellow = ready, green = listening, grey = busy)
 * with a pulsing ring while listening. Colour is never the only signal —
 * the text label always says the same thing in words.
 *
 * Note: this button is an ADDITION to standard screen-reader navigation,
 * not a replacement — every other control on the page works with normal
 * TalkBack/VoiceOver gestures too.
 */

import type { VoiceStage } from '@/hooks/useVoiceWallet';
import { cn } from '@/lib/utils';
import { MicIcon } from './icons';

interface MicButtonProps {
  stage: VoiceStage;
  speechSupported: boolean;
  onPress: () => void;
}

/** Label + colours per stage. Centralised so they're easy to tweak. */
const STAGE_PRESENTATION: Record<
  VoiceStage,
  { label: string; ariaLabel: string; classes: string; listening: boolean; disabled: boolean }
> = {
  idle: {
    label: 'TAP TO SPEAK',
    ariaLabel: 'Microphone. Tap, then speak a command. For example: check balance.',
    classes: 'bg-yellow-400 text-black hover:bg-yellow-300 active:bg-yellow-500',
    listening: false,
    disabled: false,
  },
  listening: {
    label: 'LISTENING… TAP TO CANCEL',
    ariaLabel: 'Listening now. Speak your command. Tap to cancel.',
    classes: 'bg-green-400 text-black active:bg-green-500',
    listening: true,
    disabled: false,
  },
  busy: {
    label: 'WORKING…',
    ariaLabel: 'Working. Please wait.',
    classes: 'cursor-wait bg-neutral-700 text-neutral-300',
    listening: false,
    disabled: true,
  },
  auth: {
    label: 'AUTHORIZE ON SCREEN',
    ariaLabel: 'Payment authorization is open on screen. Use it to continue.',
    classes: 'cursor-wait bg-neutral-700 text-neutral-300',
    listening: false,
    disabled: true,
  },
  challenge: {
    label: 'ANSWERING… TAP TO CANCEL',
    ariaLabel: 'Listening for your answer to the security question. Tap to cancel the payment.',
    classes: 'bg-green-400 text-black active:bg-green-500',
    listening: true,
    disabled: false,
  },
  confirm: {
    label: 'SAY YES OR NO',
    ariaLabel: 'Listening. Say yes to confirm the payment, or no to cancel. Tap to cancel.',
    classes: 'bg-green-400 text-black active:bg-green-500',
    listening: true,
    disabled: false,
  },
};

export function MicButton({ stage, speechSupported, onPress }: MicButtonProps) {
  const presentation = STAGE_PRESENTATION[stage];

  return (
    <button
      type="button"
      onClick={onPress}
      disabled={presentation.disabled}
      // The mic's whole flow is spoken feedback already — the voice guide
      // would talk over the start of listening, so it opts out.
      data-no-guide
      aria-label={
        speechSupported
          ? presentation.ariaLabel
          : 'Speech recognition is not supported in this browser. Please use Chrome on Android or Safari on iPhone.'
      }
      className={cn(
        // Fill the bottom half of the viewport; giant touch target.
        'relative flex h-[50dvh] min-h-72 w-full flex-col items-center justify-center gap-6',
        'rounded-t-[2.5rem] border-t-4 border-black/20 px-6 transition-colors',
        'focus-visible:outline-8 focus-visible:outline-offset-[-8px] focus-visible:outline-white',
        'select-none',
        presentation.classes,
      )}
    >
      {/* Pulsing ring while listening (decorative — the label says it too). */}
      {presentation.listening && (
        <span
          aria-hidden="true"
          className="absolute inset-x-8 top-8 bottom-8 rounded-[2rem] border-8 border-black/30 motion-safe:animate-ping"
        />
      )}

      <MicIcon size={96} className={cn(presentation.listening && 'motion-safe:animate-pulse')} />

      <span className="text-3xl font-black tracking-wide sm:text-4xl">
        {speechSupported ? presentation.label : 'SPEECH NOT SUPPORTED'}
      </span>

      {!speechSupported && (
        <span className="max-w-md text-lg font-semibold">
          Please use Chrome on Android or Safari on iPhone.
        </span>
      )}
    </button>
  );
}
