'use client';

import { useState, useCallback } from 'react';
import { saveNubraInstruments, loadNubraInstruments } from './db';

export type NubraInstrument = {
  ref_id: string;
  stock_name: string;
  nubra_name: string;
  strike_price: number | null;
  option_type: string;       // "CE" | "PE" | "N/A"
  token: string;
  lot_size: number;
  tick_size: number;
  asset: string;
  expiry: string | null;
  exchange: string;
  derivative_type: string;   // "STOCK" | "OPT" | "FUT"
  isin: string;
  asset_type: string;        // "STOCKS" | "STOCK_FO" | "INDEX_FO"
};

export type NubraIndex = Record<string, string>;

export type NubraLoadStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'cache-hit'; total: number }
  | { phase: 'fetching' }
  | { phase: 'parsing' }
  | { phase: 'storing' }
  | { phase: 'ready'; total: number }
  | { phase: 'error'; message: string };

export function useNubraInstruments() {
  const [instruments, setInstruments] = useState<NubraInstrument[]>([]);
  const [indexes, setIndexes] = useState<NubraIndex[]>([]);
  const [status, setStatus] = useState<NubraLoadStatus>({ phase: 'idle' });

  const load = useCallback(async (forceRefresh = false) => {
    const sessionToken = localStorage.getItem('nubra_session_token');
    if (!sessionToken) {
      setStatus({ phase: 'error', message: 'Nubra login required' });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `prod:${today}`;

    try {
      // 1. Check IndexedDB cache
      if (!forceRefresh) {
        setStatus({ phase: 'checking' });
        const cached = await loadNubraInstruments();
        if (cached && cached.date === cacheKey) {
          const parsed = JSON.parse(cached.data);
          setInstruments(parsed.refdata ?? parsed);
          setIndexes(parsed.indexes ?? []);
          setStatus({ phase: 'ready', total: (parsed.refdata ?? parsed).length });
          return;
        }
      }

      // 2. Fetch from server proxy (NSE + BSE + Index Master all in one)
      setStatus({ phase: 'fetching' });
      const authToken = localStorage.getItem('nubra_auth_token') ?? '';
      const deviceId = localStorage.getItem('nubra_device_id') ?? '';
      const params = new URLSearchParams({ session_token: sessionToken });
      if (authToken) params.set('auth_token', authToken);
      if (deviceId) params.set('device_id', deviceId);
      const res = await fetch(`/api/nubra-instruments?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      setStatus({ phase: 'parsing' });
      const json = await res.json();
      const refdata: NubraInstrument[] = json.refdata ?? [];
      const idxData: NubraIndex[] = json.indexes ?? [];

      if (refdata.length === 0) {
        throw new Error('No instruments returned from Nubra API');
      }

      // 3. Store both in IndexedDB
      setStatus({ phase: 'storing' });
      await saveNubraInstruments(JSON.stringify({ refdata, indexes: idxData }), cacheKey);

      setInstruments(refdata);
      setIndexes(idxData);
      setStatus({ phase: 'ready', total: refdata.length });
    } catch (err) {
      setStatus({ phase: 'error', message: String(err) });
    }
  }, []);

  return { instruments, indexes, status, load };
}
