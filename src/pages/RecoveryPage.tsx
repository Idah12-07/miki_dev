/**
 * Recovery page — demo of account restoration via 2-of-3 social recovery.
 *
 * No company or server can approve a recovery here — only the person's own
 * trusted contacts can, the same self-sovereignty idea Bitcoin itself is
 * built on. The wallet seed is split into 3 shares; any 2 rebuild it, 1
 * alone reveals nothing.
 *
 * This demo keeps everything in this device's memory for now — a real
 * deployment would send each contact's share to their own phone instead of
 * showing all three here. That handoff is the next milestone, noted below.
 *
 * Every result goes through the shared `feedback()` channel, so it is
 * spoken, shown in THE status region, and felt as a vibration — consistent
 * with every other MIKI screen.
 */

import { useState } from 'react';
import { useSeoMeta } from '@unhead/react';

import { useMiki } from '@/hooks/useMiki';
import { createRecoveryKit, recoverSeed, wordsToShare, type RecoveryKit } from '@/lib/recovery/recovery';
import { parseSpokenWords } from '@/lib/recovery/words';
import { cn } from '@/lib/utils';

const DEMO_CONTACTS = ['Contact 1', 'Contact 2', 'Contact 3'];

export default function RecoveryPage() {
  useSeoMeta({
    title: 'Account restoration — MIKI',
    description: 'Restore your MIKI wallet with help from trusted contacts, with no company in the middle.',
  });

  const { say, feedback } = useMiki();
  const [kit, setKit] = useState<RecoveryKit | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [shareInputs, setShareInputs] = useState(['', '']);
  const [recoveredMnemonic, setRecoveredMnemonic] = useState<string | null>(null);

  async function handleSetup() {
    await say('Setting up recovery with three trusted contacts.');
    const newKit = await createRecoveryKit(DEMO_CONTACTS);
    setKit(newKit);
    setRecoveredMnemonic(null);
    await feedback(
      `Recovery is set up. Each of your three contacts has a 14 word share. Any two of them can help you restore your wallet.`,
      'success',
    );
  }

  async function handleRecover() {
    if (!kit) return;
    try {
      const shares = shareInputs.map((text, i) => {
        const { words, unclear } = parseSpokenWords(text);
        if (unclear.length > 0) {
          throw new Error(`I could not hear word ${unclear.join(' and ')} from contact ${i + 1} clearly.`);
        }
        return wordsToShare(words as string[]);
      });
      const mnemonic = await recoverSeed(shares, kit.fingerprint);
      setRecoveredMnemonic(mnemonic);
      await feedback('Your wallet is back. Please set a new PIN.', 'success');
    } catch (err) {
      await feedback(err instanceof Error ? err.message : 'Recovery failed. Nothing was changed.', 'error');
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-4">
      <h1 className="text-2xl font-semibold">Account restoration</h1>
      <p className="text-sm text-muted-foreground">
        Demo: see how MIKI restores a wallet from three trusted contacts, with no company
        in the middle — only two of your own people are needed, and they decide, not us.
      </p>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">1. Set up recovery</h2>
        <button
          type="button"
          onClick={handleSetup}
          className={cn(
            'rounded-lg bg-primary px-4 py-3 text-primary-foreground',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          )}
        >
          Set up recovery
        </button>

        {kit && (
          <ul className="flex flex-col gap-2" aria-label="Contact shares">
            {kit.contacts.map((c) => (
              <li key={c.name} className="rounded-md border p-3 text-sm">
                <span className="font-medium">{c.name}:</span> {c.words.join(' ')}
              </li>
            ))}
          </ul>
        )}
      </section>

      {kit && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">2. Simulate a lost phone</h2>
          <button
            type="button"
            onClick={() => setRecovering(true)}
            className="rounded-lg border px-4 py-3 focus-visible:outline focus-visible:outline-2"
          >
            Simulate recovery
          </button>

          {recovering && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Type in the 14-word share from any two contacts (copy them from above for this demo).
              </p>
              {[0, 1].map((i) => (
                <label key={i} className="flex flex-col gap-1 text-sm">
                  Share from contact {i + 1}
                  <input
                    type="text"
                    value={shareInputs[i]}
                    onChange={(e) => {
                      const next = [...shareInputs];
                      next[i] = e.target.value;
                      setShareInputs(next);
                    }}
                    className="rounded-md border px-3 py-2"
                    aria-label={`14 word share from contact ${i + 1}`}
                  />
                </label>
              ))}
              <button
                type="button"
                onClick={handleRecover}
                className="rounded-lg bg-primary px-4 py-3 text-primary-foreground"
              >
                Rebuild wallet
              </button>
            </div>
          )}

          {recoveredMnemonic && (
            <p className="rounded-md border p-3 text-sm" role="status">
              Wallet restored successfully.
            </p>
          )}
        </section>
      )}
    </div>
  );
}