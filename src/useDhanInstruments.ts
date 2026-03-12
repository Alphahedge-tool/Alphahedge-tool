'use client';

/**
 * useDhanInstruments
 *
 * Fetches and caches the Dhan api-scrip-master-detailed.csv.
 * Cache lives in IndexedDB (dhan_cache store), invalidated daily.
 * Mirrors the pattern used by useNubraInstruments.
 *
 * Exchange Segment enum (u_seg_id for opt_chart):
 *   IDX_I        = 0  — Index Value
 *   NSE_EQ       = 1  — NSE Equity Cash
 *   NSE_FNO      = 2  — NSE Futures & Options  ← most common for opt_chart
 *   NSE_CURRENCY = 3  — NSE Currency
 *   BSE_EQ       = 4  — BSE Equity Cash
 *   MCX_COMM     = 5  — MCX Commodity
 *   BSE_CURRENCY = 7  — BSE Currency
 *   BSE_FNO      = 8  — BSE Futures & Options
 *
 * Expiry Code (exp_code for opt_chart):
 *   0 — Current / Near Expiry
 *   1 — Next Expiry
 *   2 — Far Expiry
 *
 * CSV columns used:
 *   EXCH_ID, SEGMENT, SECURITY_ID, ISIN, INSTRUMENT,
 *   UNDERLYING_SECURITY_ID, UNDERLYING_SYMBOL, SYMBOL_NAME, DISPLAY_NAME,
 *   INSTRUMENT_TYPE, SERIES, LOT_SIZE, SM_EXPIRY_DATE, STRIKE_PRICE,
 *   OPTION_TYPE, TICK_SIZE, EXPIRY_FLAG
 */

import { useState, useEffect } from 'react';
import { saveDhanInstruments, loadDhanInstruments } from './db';

// ─── Exchange Segment enum ─────────────────────────────────────────────────────
// Maps CSV EXCH_ID + SEGMENT → u_seg_id used in opt_chart payload

export const DHAN_SEGMENT_ENUM: Record<string, number> = {
  IDX_I:        0,  // Index Value
  NSE_EQ:       1,  // NSE Equity Cash
  NSE_FNO:      2,  // NSE Futures & Options
  NSE_CURRENCY: 3,  // NSE Currency
  BSE_EQ:       4,  // BSE Equity Cash
  MCX_COMM:     5,  // MCX Commodity
  BSE_CURRENCY: 7,  // BSE Currency
  BSE_FNO:      8,  // BSE Futures & Options
};

// Maps CSV SEGMENT column value → canonical segment key
// CSV SEGMENT: I=Index, E=Equity, D=F&O Derivatives, C=Currency, M=Commodity
const SEGMENT_MAP: Record<string, Record<string, string>> = {
  NSE: { I: 'IDX_I', E: 'NSE_EQ', D: 'NSE_FNO', C: 'NSE_CURRENCY' },
  BSE: { I: 'IDX_I', E: 'BSE_EQ', D: 'BSE_FNO', C: 'BSE_CURRENCY' },
  MCX: { M: 'MCX_COMM', C: 'MCX_COMM' },
};

/** Derive u_seg_id from EXCH_ID + SEGMENT CSV columns */
export function dhanSegmentEnum(exch_id: string, segment: string): number {
  const key = SEGMENT_MAP[exch_id]?.[segment];
  return key !== undefined ? DHAN_SEGMENT_ENUM[key] : 0;
}

// ─── Expiry Code ──────────────────────────────────────────────────────────────
// exp_code for opt_chart payload
export const DHAN_EXPIRY_CODE = {
  NEAR:  0,  // Current / Near Expiry
  NEXT:  1,  // Next Expiry
  FAR:   2,  // Far Expiry
} as const;

// ─── Type ─────────────────────────────────────────────────────────────────────

export interface DhanInstrument {
  exch_id: string;            // NSE | BSE | MCX …
  segment: string;            // I | E | D | C | M (raw CSV)
  segment_key: string;        // NSE_FNO | NSE_EQ | IDX_I … (derived)
  u_seg_id: number;           // enum value for opt_chart payload
  security_id: number;        // SECURITY_ID — the u_id for opt_chart
  isin: string;
  instrument: string;         // FUTIDX | OPTIDX | FUTSTK | OPTSTK | INDEX | EQUITY …
  underlying_security_id: number;
  underlying_symbol: string;  // NIFTY | BANKNIFTY | RELIANCE …
  symbol_name: string;        // trading symbol
  display_name: string;       // human-readable name
  instrument_type: string;    // FUTIDX | OPTIDX | INDEX | EQUITY …
  series: string;
  lot_size: number;
  expiry_date: string | null; // YYYY-MM-DD or null
  strike_price: number | null;
  option_type: string;        // CE | PE | XX
  tick_size: number;
  expiry_flag: string;        // W | M | NA
}

export type DhanLoadStatus =
  | 'idle'
  | 'checking'
  | 'cache-hit'
  | 'downloading'
  | 'parsing'
  | 'storing'
  | 'ready'
  | 'error';

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsv(csv: string): DhanInstrument[] {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const idx = (name: string) => headers.indexOf(name);

  const iEXCH        = idx('EXCH_ID');
  const iSEGMENT     = idx('SEGMENT');
  const iSECURITY_ID = idx('SECURITY_ID');
  const iISIN        = idx('ISIN');
  const iINSTRUMENT  = idx('INSTRUMENT');
  const iUNDER_ID    = idx('UNDERLYING_SECURITY_ID');
  const iUNDER_SYM   = idx('UNDERLYING_SYMBOL');
  const iSYMBOL      = idx('SYMBOL_NAME');
  const iDISPLAY     = idx('DISPLAY_NAME');
  const iINST_TYPE   = idx('INSTRUMENT_TYPE');
  const iSERIES      = idx('SERIES');
  const iLOT         = idx('LOT_SIZE');
  const iEXPIRY      = idx('SM_EXPIRY_DATE');
  const iSTRIKE      = idx('STRIKE_PRICE');
  const iOPT_TYPE    = idx('OPTION_TYPE');
  const iTICK        = idx('TICK_SIZE');
  const iEXP_FLAG    = idx('EXPIRY_FLAG');

  const result: DhanInstrument[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');

    const exch    = cols[iEXCH]?.trim()    ?? '';
    const seg     = cols[iSEGMENT]?.trim() ?? '';
    const segKey  = SEGMENT_MAP[exch]?.[seg] ?? '';
    const uSegId  = segKey ? (DHAN_SEGMENT_ENUM[segKey] ?? 0) : 0;

    const expiryRaw = cols[iEXPIRY]?.trim() ?? '';
    const strikeRaw = parseFloat(cols[iSTRIKE] ?? '');
    const secId     = parseInt(cols[iSECURITY_ID] ?? '0', 10);
    const underId   = parseInt(cols[iUNDER_ID]    ?? '0', 10);

    result.push({
      exch_id:                exch,
      segment:                seg,
      segment_key:            segKey,
      u_seg_id:               uSegId,
      security_id:            isNaN(secId)    ? 0    : secId,
      isin:                   cols[iISIN]?.trim()       ?? '',
      instrument:             cols[iINSTRUMENT]?.trim() ?? '',
      underlying_security_id: isNaN(underId)  ? 0    : underId,
      underlying_symbol:      cols[iUNDER_SYM]?.trim() ?? '',
      symbol_name:            cols[iSYMBOL]?.trim()    ?? '',
      display_name:           cols[iDISPLAY]?.trim()   ?? '',
      instrument_type:        cols[iINST_TYPE]?.trim() ?? '',
      series:                 cols[iSERIES]?.trim()     ?? '',
      lot_size:               parseFloat(cols[iLOT] ?? '0') || 0,
      expiry_date:            expiryRaw || null,
      strike_price:           isNaN(strikeRaw) ? null  : strikeRaw,
      option_type:            cols[iOPT_TYPE]?.trim()  ?? '',
      tick_size:              parseFloat(cols[iTICK] ?? '0') || 0,
      expiry_flag:            cols[iEXP_FLAG]?.trim()  ?? '',
    });
  }

  return result;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDhanInstruments() {
  const [instruments, setInstruments] = useState<DhanInstrument[]>([]);
  const [status,      setStatus]      = useState<DhanLoadStatus>('idle');
  const [error,       setError]       = useState('');
  const [total,       setTotal]       = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus('checking');

      const today = new Date().toISOString().slice(0, 10);

      // ── Try cache first ──
      try {
        const cached = await loadDhanInstruments();
        if (cached && cached.date === today) {
          if (cancelled) return;
          setStatus('parsing');
          const parsed = parseCsv(cached.data);
          if (cancelled) return;
          setInstruments(parsed);
          setTotal(parsed.length);
          setStatus('cache-hit');
          setTimeout(() => setStatus('ready'), 600);
          return;
        }
      } catch {
        // cache miss — fall through to fetch
      }

      // ── Fetch fresh ──
      setStatus('downloading');
      try {
        const res = await fetch('/api/dhan-instruments');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        setStatus('parsing');
        const csv = await res.text();
        if (cancelled) return;

        const parsed = parseCsv(csv);
        if (cancelled) return;

        setStatus('storing');
        await saveDhanInstruments(csv, today);

        if (cancelled) return;
        setInstruments(parsed);
        setTotal(parsed.length);
        setStatus('ready');
      } catch (e: any) {
        if (cancelled) return;
        setError(e.message);
        setStatus('error');
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return { instruments, status, error, total };
}
