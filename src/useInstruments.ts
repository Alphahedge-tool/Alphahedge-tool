'use client';

import { useState, useEffect, startTransition } from 'react';
import pako from 'pako';
import { saveBlob, loadBlob, clearBlob } from './db';

// Module-level cache — survives React remounts (hot reload, StrictMode double-invoke, etc.)
// Once parsed for the day, never hits IndexedDB or Worker again until page is fully closed.
let _cachedInstruments: Instrument[] | null = null;
let _cachedDate: string = '';

// Parse JSON bytes off the main thread — prevents multi-hundred ms freeze on 100k+ instruments
function parseInstrumentsOffThread(bytes: Uint8Array): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./instruments.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.json);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (err) => { worker.terminate(); reject(err); };
    worker.postMessage(bytes);
  });
}

const INSTRUMENTS_URL = '/instruments-gz';

export type Instrument = {
  instrument_key: string;
  name: string;
  trading_symbol: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  expiry: number | null;
  strike_price: number | null;
  lot_size: number;
  tick_size: number;
  asset_type: string;
  underlying_symbol: string;
  weekly: boolean;
};

export type LoadStatus =
  | { phase: 'checking' }
  | { phase: 'cache-hit' }
  | { phase: 'downloading'; progress: number }
  | { phase: 'decompressing' }
  | { phase: 'parsing' }
  | { phase: 'storing' }
  | { phase: 'ready'; total: number }
  | { phase: 'error'; message: string };

// Returns today's date string in IST as "YYYY-MM-DD"
function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Returns true if current IST time is at or past 03:30 AM
// Upstox publishes fresh instruments after ~3:30 AM IST each day
function isPastInstrumentRefresh(): boolean {
  const now = new Date();
  const istStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = istStr.split(':').map(Number);
  return h > 3 || (h === 3 && m >= 30);
}

export function useInstruments() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [status, setStatus] = useState<LoadStatus>({ phase: 'checking' });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const today = todayIST();

        // 0. Module-level memory cache — already parsed this session, instant return
        if (_cachedInstruments && _cachedDate === today) {
          if (!cancelled) {
            startTransition(() => setInstruments(_cachedInstruments!));
            setStatus({ phase: 'ready', total: _cachedInstruments!.length });
          }
          return;
        }

        // 1. Try IndexedDB cache
        setStatus({ phase: 'checking' });
        const cached = await loadBlob();

        if (cached && !cancelled) {
          // Stale only when: cache is from a previous day AND it's past 3:30 AM IST
          const cacheStale = cached.date !== today && isPastInstrumentRefresh();

          if (!cacheStale) {
            // Cache is fresh — parse off main thread so UI never freezes
            setStatus({ phase: 'cache-hit' });
            const json = await parseInstrumentsOffThread(cached.data) as Instrument[];
            if (!cancelled) {
              _cachedInstruments = json;
              _cachedDate = today;
              startTransition(() => setInstruments(json));
              setStatus({ phase: 'ready', total: json.length });
            }
            return;
          }

          // Cache is stale — delete and re-fetch
          await clearBlob();
        }

        // 2. Download fresh instruments
        setStatus({ phase: 'downloading', progress: 0 });
        const response = await fetch(INSTRUMENTS_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength) : 0;
        const reader = response.body!.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (!cancelled) {
            setStatus({
              phase: 'downloading',
              progress: total ? Math.round((received / total) * 100) : 0,
            });
          }
        }

        if (cancelled) return;

        // 3. Merge chunks into single Uint8Array
        const gz = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          gz.set(chunk, offset);
          offset += chunk.length;
        }

        // 4. Decompress
        setStatus({ phase: 'decompressing' });
        const decompressed = pako.inflate(gz);

        // 5. Parse off main thread — JSON.parse of 100k+ instruments blocks for ~300ms
        setStatus({ phase: 'parsing' });
        const json = await parseInstrumentsOffThread(decompressed) as Instrument[];

        // 6. Store with today's IST date
        setStatus({ phase: 'storing' });
        await saveBlob(decompressed, today);

        if (!cancelled) {
          _cachedInstruments = json;
          _cachedDate = today;
          startTransition(() => setInstruments(json));
          setStatus({ phase: 'ready', total: json.length });
        }
      } catch (err) {
        if (!cancelled) {
          setStatus({ phase: 'error', message: String(err) });
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return { instruments, status };
}
