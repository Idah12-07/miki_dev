/**
 * useMiki — access MIKI's global state (settings, wallet, speech).
 * Must be used inside `<MikiProvider>` (provided by `MikiLayout`).
 */

import { useContext } from 'react';

import { MikiContext, type MikiContextValue } from '@/contexts/MikiContext';

export function useMiki(): MikiContextValue {
  const ctx = useContext(MikiContext);
  if (!ctx) throw new Error('useMiki must be used inside <MikiProvider>');
  return ctx;
}
