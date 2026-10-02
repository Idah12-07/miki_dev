/**
 * Biometric sign-in for MIKI — WebAuthn (fingerprint / Face ID).
 *
 * HOW IT WORKS (for developers new to WebAuthn):
 *   - "Enrollment" (`enrollBiometric`) asks the device to create a passkey-
 *     style credential using its PLATFORM authenticator (the fingerprint
 *     reader or face scanner built into the phone/laptop). The private key
 *     never leaves the device's secure enclave.
 *   - We store only the PUBLIC credential ID in localStorage. There is no
 *     server in this demo, so `verifyBiometric` simply checks that the
 *     authenticator can produce a fresh signature with that credential —
 *     which only succeeds after the user passes the biometric (or device
 *     PIN) prompt. That is enough to use it as a local sign-in gate.
 *   - On a production deployment you would also verify the signature
 *     server-side. The local-only check here is demo-grade, like the PIN.
 *
 * FALLBACK: if the device/browser has no platform authenticator (or the
 * page is served over plain HTTP, or the user cancels enrolment), callers
 * fall back to the typed PIN — see LockScreen / AuthScreen.
 *
 * PRIVACY: WebAuthn never exposes biometric data to the page; we only get
 * back a signature. Nothing biometric is (or can be) stored by MIKI.
 */

const CREDENTIAL_KEY = 'miki.webauthn.credentialId';

// ── base64url helpers (credential IDs are binary; localStorage is text) ─────

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// ── capability checks ────────────────────────────────────────────────────────

/** True when the WebAuthn API exists at all in this browser. */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.credentials)
  );
}

/**
 * True when THIS DEVICE has a biometric (or PIN-backed) platform
 * authenticator: fingerprint reader, Face ID, Windows Hello, etc.
 * Resolves false on old browsers, plain HTTP, or devices without hardware.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** True when the user has already enrolled a biometric credential here. */
export function isBiometricEnrolled(): boolean {
  try {
    return Boolean(localStorage.getItem(CREDENTIAL_KEY));
  } catch {
    return false;
  }
}

// ── enrolment ────────────────────────────────────────────────────────────────

/**
 * Create a new platform credential (triggers the device's biometric/face
 * enrolment prompt). Throws with a human-readable message on failure —
 * callers announce it through the shared feedback function.
 */
export async function enrollBiometric(): Promise<void> {
  if (!isWebAuthnSupported()) {
    throw new Error('Biometric sign-in is not supported in this browser.');
  }

  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        // A random challenge; not verified server-side in this demo.
        challenge: randomBytes(32),
        rp: { name: 'MIKI Voice Wallet' },
        user: {
          id: randomBytes(16),
          name: 'miki-local-user',
          displayName: 'MIKI User',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform', // built-in sensor only
          userVerification: 'required',        // must verify the user's biometrics
        },
        timeout: 60_000,
        attestation: 'none',
      },
    });

    if (!credential || !(credential instanceof PublicKeyCredential)) {
      throw new Error('No credential was created.');
    }
    localStorage.setItem(CREDENTIAL_KEY, bufferToBase64url(credential.rawId));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error('Biometric setup was cancelled.');
    }
    throw new Error('Biometric setup failed on this device. You can keep using your PIN.');
  }
}

/** Forget the enrolled credential (Settings → disable biometric sign-in). */
export function removeBiometric(): void {
  try {
    localStorage.removeItem(CREDENTIAL_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

// ── verification ─────────────────────────────────────────────────────────────

/**
 * Ask the device to prove the user's presence with the enrolled credential
 * (shows the fingerprint / Face ID prompt). Returns true on success.
 * Never throws — failures simply return false so callers can offer the PIN.
 */
export async function verifyBiometric(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;

  let rawId: ArrayBuffer;
  try {
    const stored = localStorage.getItem(CREDENTIAL_KEY);
    if (!stored) return false;
    rawId = base64urlToBuffer(stored);
  } catch {
    return false;
  }

  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [
          { type: 'public-key', id: rawId, transports: ['internal'] },
        ],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return assertion !== null;
  } catch {
    // NotAllowedError (cancelled / timed out) or anything else → false.
    return false;
  }
}
