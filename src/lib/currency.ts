const SATS_PER_BTC = 100_000_000;

export function satsToBTC(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(8);
}
