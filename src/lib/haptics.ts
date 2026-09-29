/**
 * Haptic feedback patterns for MIKI.
 *
 * Blind and low-vision users rely on vibration as a primary confirmation
 * channel, so every wallet outcome has a distinct, easy-to-tell-apart buzz:
 *
 *   - success  → ONE long buzz   (payment sent, command succeeded)
 *   - received → TWO short buzzes (incoming payment arrived)
 *   - error    → THREE short buzzes (wrong PIN, failed payment, timeout…)
 *
 * `navigator.vibrate` is not available everywhere (notably iOS Safari), so
 * every call is guarded and silently no-ops when unsupported.
 */

/** Returns true when the Vibration API is available on this device/browser. */
export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** ONE long buzz — used for successful operations (e.g. payment sent). */
export function buzzSuccess(): void {
  if (canVibrate()) navigator.vibrate(500);
}

/** TWO short buzzes — used when a payment is RECEIVED. */
export function buzzReceived(): void {
  if (canVibrate()) navigator.vibrate([150, 120, 150]);
}

/** THREE short buzzes — used for errors (wrong PIN, failed payment, timeout). */
export function buzzError(): void {
  if (canVibrate()) navigator.vibrate([100, 80, 100, 80, 100]);
}

/** A tiny tick — used for UI feedback such as pressing a PIN digit. */
export function buzzTick(): void {
  if (canVibrate()) navigator.vibrate(30);
}
