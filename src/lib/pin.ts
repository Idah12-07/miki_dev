/**
 * PIN management for MIKI.
 *
 * A 4-digit PIN gates every outgoing payment. We never store the PIN itself —
 * only its SHA-256 hash (with a fixed app-specific salt) in localStorage.
 *
 * ⚠️ DEMO-GRADE SECURITY: a hash in localStorage protects against casual
 * snooping, but a determined attacker with device access could brute-force a
 * 4-digit PIN. A production wallet should use the platform keystore (e.g. via
 * a native wrapper) or a remote signer instead. The interface below is what
 * the rest of the app depends on, so hardening can happen behind it.
 *
 * FUTURE HOOK: a voice-print check can be added as an extra factor in the
 * payment pipeline (see `useVoiceWallet.ts`), not here — PIN stays factor #1.
 */

const STORAGE_KEY = 'miki.pin.sha256';
const SALT = 'miki-voice-wallet-v1';

export const PIN_LENGTH = 4;
export const MAX_PIN_ATTEMPTS = 3;

/** Hash a PIN string with SHA-256 (WebCrypto, async). */
async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`${SALT}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** True when a PIN has been configured on this device. */
export function hasPin(): boolean {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

/** Validate the format of a PIN candidate (exactly 4 digits). */
export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/** Store a new PIN. Throws if the format is invalid. */
export async function setPin(pin: string): Promise<void> {
  if (!isValidPinFormat(pin)) {
    throw new Error(`PIN must be exactly ${PIN_LENGTH} digits.`);
  }
  localStorage.setItem(STORAGE_KEY, await hashPin(pin));
}

/** Verify a PIN attempt against the stored hash. */
export async function verifyPin(pin: string): Promise<boolean> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    return (await hashPin(pin)) === stored;
  } catch {
    return false;
  }
}

/** Remove the PIN (used by "Reset demo data" in Settings). */
export function clearPin(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}
