'use client';

/**
 * GexService — computes Gamma Exposure (GEX) per strike using live WS data.
 *
 * Formula (dealer GEX convention):
 *   Call GEX = +gamma * OI * lot_size * spot²
 *   Put  GEX = -gamma * OI * lot_size * spot²
 *   Net  GEX =  Call GEX + Put GEX
 *
 * Spot price is read live from wsManager for the underlying's index key.
 */

import { wsManager } from './WebSocketManager';

export interface GexRow {
  strike: number;
  callGex: number;   // positive
  putGex: number;    // negative
  netGex: number;    // call + put
}

export interface StrikeSpec {
  strike: number;
  callKey: string;
  putKey: string;
  lotSize: number;
}

/**
 * Compute a snapshot of GEX rows given a spot price.
 * Pure function — no side effects.
 */
export function computeGexSnapshot(specs: StrikeSpec[], spot: number): GexRow[] {
  if (spot <= 0) return [];
  const s2 = spot * spot;
  return specs.map(({ strike, callKey, putKey, lotSize }) => {
    const callData = wsManager.get(callKey);
    const putData  = wsManager.get(putKey);

    const callGex =  (callData?.gamma ?? 0) * (callData?.oi ?? 0) * lotSize * s2;
    const putGex  = -(putData?.gamma  ?? 0) * (putData?.oi  ?? 0) * lotSize * s2;

    return { strike, callGex, putGex, netGex: callGex + putGex };
  });
}

/**
 * Format a GEX value for display.
 */
export function fmtGex(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs === 0) return '—';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(1) + 'K';
  return sign + abs.toFixed(0);
}
