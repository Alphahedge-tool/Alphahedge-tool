'use client';

import { useState, useEffect } from 'react';
import pako from 'pako';
import { saveBlob, loadBlob, clearBlob } from './db';

const URL = '/instruments-gz';

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
        // 1. Try cache first
        setStatus({ phase: 'checking' });
        const cached = await loadBlob();

        if (cached && !cancelled) {
          const today = todayIST();
          const cacheStale = cached.date !== today || isPastInstrumentRefresh();

          if (!cacheStale) {
            // Cache is fresh — use it
            setStatus({ phase: 'cache-hit' });
            const json = JSON.parse(new TextDecoder().decode(cached.data)) as Instrument[];
            if (!cancelled) {
              setInstruments(json);
              setStatus({ phase: 'ready', total: json.length });
            }
            return;
          }

          // Cache is stale (different day or past 15:30) — delete and re-fetch
          await clearBlob();
        }

        // 2. Download fresh instruments
        setStatus({ phase: 'downloading', progress: 0 });
        const response = await fetch(URL);
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

        // 5. Parse
        setStatus({ phase: 'parsing' });
        const json = JSON.parse(new TextDecoder().decode(decompressed)) as Instrument[];

        // 6. Store with today's IST date
        setStatus({ phase: 'storing' });
        await saveBlob(decompressed, todayIST());

        if (!cancelled) {
          setInstruments(json);
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
