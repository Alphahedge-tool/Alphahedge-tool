'use client';

/**
 * useMarketData — React hooks for subscribing to live market data.
 *
 * useMarketData(key)     — single instrument, component re-renders only on that key's tick
 * useMarketDataMap(keys) — multiple instruments, batched via queueMicrotask
 * useWsConnected()       — connection state only
 */

import { useEffect, useRef, useState } from 'react';
import { wsManager } from '../lib/WebSocketManager';
import type { InstrumentMarketData } from '../lib/WebSocketManager';

export type { InstrumentMarketData };

export function useMarketData(instrumentKey: string | null | undefined): InstrumentMarketData | undefined {
  const [data, setData] = useState<InstrumentMarketData | undefined>(() =>
    instrumentKey ? wsManager.get(instrumentKey) : undefined
  );

  useEffect(() => {
    if (!instrumentKey) {
      setData(undefined);
      return;
    }
    return wsManager.subscribe(instrumentKey, (d) => setData(d));
  }, [instrumentKey]);

  return data;
}

export function useMarketDataMap(instrumentKeys: string[]): Map<string, InstrumentMarketData> {
  const keysRef = useRef<string[]>(instrumentKeys);

  const [dataMap, setDataMap] = useState<Map<string, InstrumentMarketData>>(() => {
    const m = new Map<string, InstrumentMarketData>();
    for (const k of instrumentKeys) {
      const d = wsManager.get(k);
      if (d) m.set(k, d);
    }
    return m;
  });

  keysRef.current = instrumentKeys;

  const keysStr = instrumentKeys.slice().sort().join(',');

  useEffect(() => {
    if (instrumentKeys.length === 0) return;

    let pending = false;
    const scheduled = new Map<string, InstrumentMarketData>();

    const flush = () => {
      pending = false;
      setDataMap(prev => {
        const next = new Map(prev);
        scheduled.forEach((d, k) => next.set(k, d));
        scheduled.clear();
        return next;
      });
    };

    const unsubs: (() => void)[] = instrumentKeys.map(key =>
      wsManager.subscribe(key, (d) => {
        scheduled.set(key, d);
        if (!pending) {
          pending = true;
          queueMicrotask(flush);
        }
      })
    );

    return () => {
      unsubs.forEach(u => u());
      scheduled.clear();
      pending = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysStr]);

  return dataMap;
}

export function useWsConnected(): boolean {
  const [connected, setConnected] = useState(() => wsManager.isConnected);

  useEffect(() => {
    return wsManager.onConnectionChange(setConnected);
  }, []);

  return connected;
}
