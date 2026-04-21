'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts';
import type { Instrument } from './useInstruments';
import { wsManager } from './lib/WebSocketManager';
import s from './AtmRollingStraddle.module.css';

interface Props {
  instruments: Instrument[];
}

type IntervalOpt = { label: string; min: number; upstox: string };

const INTERVALS: IntervalOpt[] = [
  { label: '1m', min: 1, upstox: 'I1' },
  { label: '5m', min: 5, upstox: 'I5' },
  { label: '15m', min: 15, upstox: 'I15' },
  { label: '30m', min: 30, upstox: 'I30' },
];

const IST_OFFSET_SEC = 19800;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;
const MAX_OPTION_BATCH_CALLS = 3;
const KEYS_PER_BATCH_CALL = 12;
const NUBRA_BRIDGE = 'ws://localhost:8765';

function snapToBarTime(tsMs: number, intervalMinutes: number): number {
  const intervalSec = intervalMinutes * 60;
  const nowSec = Math.floor(tsMs / 1000);
  return Math.floor((nowSec + IST_OFFSET_SEC) / intervalSec) * intervalSec - IST_OFFSET_SEC;
}

function todayEndMs(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function getUnderlyings(instruments: Instrument[]) {
  const set = new Set<string>();
  for (const ins of instruments) {
    if ((ins.instrument_type === 'CE' || ins.instrument_type === 'PE') && ins.underlying_symbol) {
      set.add(ins.underlying_symbol);
    }
  }
  return Array.from(set).sort();
}

function getExpiries(instruments: Instrument[], underlying: string) {
  const set = new Set<number>();
  for (const ins of instruments) {
    if (ins.underlying_symbol === underlying && ins.expiry) set.add(ins.expiry);
  }
  return Array.from(set).sort((a, b) => a - b);
}

function toNubraChainValue(underlying: string, expiryMs: number): string {
  const d = new Date(expiryMs);
  const yyyy = d.toLocaleString('en-IN', { year: 'numeric', timeZone: 'Asia/Kolkata' });
  const mm = d.toLocaleString('en-IN', { month: '2-digit', timeZone: 'Asia/Kolkata' });
  const dd = d.toLocaleString('en-IN', { day: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${underlying}_${yyyy}${mm}${dd}`;
}

function toNubraExchange(instruments: Instrument[], underlying: string, expiry: number): string {
  const hit = instruments.find(i =>
    i.underlying_symbol === underlying &&
    i.expiry === expiry &&
    (i.instrument_type === 'CE' || i.instrument_type === 'PE'),
  );
  const ex = (hit?.exchange ?? '').toUpperCase();
  if (ex.startsWith('BSE')) return 'BSE';
  return 'NSE';
}

function lastTradingDay(): string {
  const istMs = Date.now() + 5.5 * 3600 * 1000;
  const d = new Date(istMs);
  const istMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const OPEN = 9 * 60 + 15;
  if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && istMin < OPEN) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getMarketSchedule() {
  const istMs = Date.now() + 5.5 * 3600 * 1000;
  const istNow = new Date(istMs);
  const istMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const OPEN = 9 * 60 + 15;
  const CLOSE = 15 * 60 + 30;
  const isWeekday = istNow.getUTCDay() >= 1 && istNow.getUTCDay() <= 5;
  return {
    isMarketOpen: isWeekday && istMin >= OPEN && istMin <= CLOSE,
    tradingDate: lastTradingDay(),
    nowUtcIso: new Date().toISOString(),
  };
}

function buildNubraTimeseriesWindow(startDateStr: string) {
  const { isMarketOpen, tradingDate, nowUtcIso } = getMarketSchedule();
  const isIntraday = startDateStr === tradingDate && isMarketOpen;
  return {
    startDate: `${startDateStr}T03:45:00.000Z`,
    endDate: isIntraday ? nowUtcIso : `${startDateStr}T10:00:00.000Z`,
    intraDay: isIntraday,
    realTime: false,
  };
}

function findSpotKey(instruments: Instrument[], underlying: string): string | null {
  const byTrading = instruments.find(i =>
    (i.instrument_type === 'INDEX' || i.instrument_type === 'EQ') && i.trading_symbol === underlying,
  );
  if (byTrading) return byTrading.instrument_key;

  const byName = instruments.find(i =>
    (i.instrument_type === 'INDEX' || i.instrument_type === 'EQ') && i.name === underlying,
  );
  return byName?.instrument_key ?? null;
}

function nearestStrike(strikes: number[], spot: number): number | null {
  if (!strikes.length || !spot) return null;
  return strikes.reduce((best, x) => Math.abs(x - spot) < Math.abs(best - spot) ? x : best, strikes[0]);
}

function resample(candles1m: number[][], intervalMin: number): number[][] {
  if (candles1m.length === 0) return [];
  if (intervalMin === 1) return [...candles1m].sort((a, b) => a[0] - b[0]);

  const barMap = new Map<number, number[]>();
  for (const c of candles1m) {
    const tsSec = Math.floor(c[0] / 1000);
    const d = new Date(tsSec * 1000);
    const istMin = (d.getUTCHours() * 60 + d.getUTCMinutes()) + 330;
    const istMinWrapped = istMin % (24 * 60);
    const minSinceOpen = istMinWrapped - MARKET_OPEN_MIN;
    if (minSinceOpen < 0 || istMinWrapped > MARKET_CLOSE_MIN) continue;

    const bucketMin = Math.floor(minSinceOpen / intervalMin) * intervalMin + MARKET_OPEN_MIN;
    const barDateUtc = new Date(d);
    barDateUtc.setUTCHours(0, 0, 0, 0);
    const barTsSec = Math.floor((barDateUtc.getTime() + (bucketMin - 330) * 60 * 1000) / 1000);

    if (!barMap.has(barTsSec)) {
      barMap.set(barTsSec, [barTsSec * 1000, c[1], c[2], c[3], c[4], c[5] ?? 0, c[6] ?? 0]);
    } else {
      const bar = barMap.get(barTsSec)!;
      bar[2] = Math.max(bar[2], c[2]);
      bar[3] = Math.min(bar[3], c[3]);
      bar[4] = c[4];
      bar[5] = (bar[5] ?? 0) + (c[5] ?? 0);
      bar[6] = c[6] ?? bar[6];
    }
  }
  return Array.from(barMap.values()).sort((a, b) => a[0] - b[0]);
}

async function fetchCandlesRaw(instrumentKey: string, interval: IntervalOpt, from = todayEndMs()) {
  const params = new URLSearchParams({
    instrumentKey,
    interval: interval.upstox,
    from: String(from),
    limit: '375',
  });
  const res = await fetch(`/api/public-candles?${params}`);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${instrumentKey}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return {
    candles: json?.data?.data?.candles ?? json?.data?.candles ?? [],
    prevTimestamp: json?.data?.data?.meta?.prevTimestamp ?? json?.data?.meta?.prevTimestamp ?? null,
  } as { candles: number[][]; prevTimestamp: number | null };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCandlesBatchWithRetry(
  instrumentKeys: string[],
  interval: IntervalOpt,
  from = todayEndMs(),
  attempts = 4,
) {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('/api/public-candles-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrumentKeys,
          interval: interval.upstox,
          from: String(from),
          limit: '375',
        }),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for batch`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const json = await res.json();
      return {
        data: (json?.data ?? {}) as Record<string, { candles: number[][]; meta?: { prevTimestamp?: number | null } }>,
        errors: (json?.errors ?? {}) as Record<string, string>,
      };
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number })?.status;
      const retryable = status != null ? [429, 500, 502, 503, 504].includes(status) : true;
      if (!retryable || i === attempts - 1) throw e;
      await sleep(180 * (2 ** i) + Math.floor(Math.random() * 90));
    }
  }
  throw lastErr ?? new Error('Failed batch fetch');
}

async function loadFullDayCandles(instrumentKey: string) {
  // Always load the base 1m stream and resample locally.
  // Upstox higher intervals can drift into the previous session for intraday loads.
  const latestBatch = await fetchCandlesBatchWithRetry([instrumentKey], INTERVALS[0]);
  const latest = latestBatch.data[instrumentKey];
  const latestCandles = latest?.candles ?? [];
  const prevTimestamp = latest?.meta?.prevTimestamp ?? null;
  if (!prevTimestamp) return latestCandles;

  const previousBatch = await fetchCandlesBatchWithRetry([instrumentKey], INTERVALS[0], prevTimestamp);
  const previousCandles = previousBatch.data[instrumentKey]?.candles ?? [];
  if (!previousCandles.length) return latestCandles;

  return mergeCandlesByTimestamp(previousCandles, latestCandles);
}

async function fetchNubraAtmIvSeries(
  underlying: string,
  exchange: string,
  expiryMs: number,
  nubraType: 'INDEX' | 'STOCK',
): Promise<LineData[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken) return [];

  const chainValue = toNubraChainValue(underlying, expiryMs);
  const commonDates = { interval: '1m', ...buildNubraTimeseriesWindow(lastTradingDay()) };
  const spotType = nubraType === 'STOCK' ? 'STOCK' : 'INDEX';
  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: {
      'x-session-token': sessionToken,
      'x-device-id': deviceId,
      'x-raw-cookie': rawCookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chart: 'ATM_Volatility_vs_Spot',
      query: [
        { exchange, type: 'CHAIN', values: [chainValue], fields: ['atm_iv'], ...commonDates },
        { exchange, type: spotType, values: [underlying], fields: ['value'], ...commonDates },
      ],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();

  let pts: { ts: number; v: number }[] = [];
  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      if (valObj?.[chainValue]?.atm_iv?.length) {
        pts = valObj[chainValue].atm_iv;
        break;
      }
    }
    if (pts.length) break;
  }

  // Fallback: if current trading-day window still empty, try previous trading day once.
  if (!pts.length) {
    const d = new Date(lastTradingDay());
    d.setUTCDate(d.getUTCDate() - 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
    const prevDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const prevDates = { interval: '1m', ...buildNubraTimeseriesWindow(prevDate) };
    const res2 = await fetch('/api/nubra-timeseries', {
      method: 'POST',
      headers: {
        'x-session-token': sessionToken,
        'x-device-id': deviceId,
        'x-raw-cookie': rawCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chart: 'ATM_Volatility_vs_Spot',
        query: [
          { exchange, type: 'CHAIN', values: [chainValue], fields: ['atm_iv'], ...prevDates },
          { exchange, type: spotType, values: [underlying], fields: ['value'], ...prevDates },
        ],
      }),
    });
    if (res2.ok) {
      const json2 = await res2.json();
      for (const entry of json2?.result ?? []) {
        for (const valObj of entry?.values ?? []) {
          if (valObj?.[chainValue]?.atm_iv?.length) {
            pts = valObj[chainValue].atm_iv;
            break;
          }
        }
        if (pts.length) break;
      }
    }
  }

  const mapped = pts.map(p => {
    const sec = Math.round(p.ts / 1e9);
    const snapped = Math.floor((sec + IST_OFFSET_SEC) / 60) * 60 - IST_OFFSET_SEC;
    return { time: snapped as unknown as Time, value: p.v * 100 };
  });
  mapped.sort((a, b) => Number(a.time) - Number(b.time));
  const out: LineData[] = [];
  let last = -1;
  for (const x of mapped) {
    const t = Number(x.time);
    if (t === last) continue;
    last = t;
    out.push(x);
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mergeCandlesByTimestamp(...groups: number[][][]): number[][] {
  const merged = new Map<number, number[]>();
  for (const candles of groups) {
    for (const candle of candles) {
      const ts = Number(candle[0]);
      if (!Number.isFinite(ts)) continue;
      merged.set(ts, candle);
    }
  }
  return Array.from(merged.values()).sort((a, b) => a[0] - b[0]);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function valueFromSeriesData(d: unknown): number | null {
  if (!d || typeof d !== 'object') return null;
  const value = (d as { value?: number }).value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const close = (d as { close?: number }).close;
  return typeof close === 'number' && Number.isFinite(close) ? close : null;
}

function formatTooltipTime(t: Time): string {
  if (typeof t === 'number') {
    return new Date(t * 1000).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
  if (typeof t === 'object' && t && 'year' in t && 'month' in t && 'day' in t) {
    const bd = t as { year: number; month: number; day: number };
    return `${String(bd.day).padStart(2, '0')}-${String(bd.month).padStart(2, '0')}-${bd.year}`;
  }
  return '';
}

export default function AtmRollingStraddle({ instruments }: Props) {
  const [underlying, setUnderlying] = useState('');
  const [expiry, setExpiry] = useState<number | null>(null);
  const [interval, setInterval] = useState<IntervalOpt>(INTERVALS[1]);
  const [loading, setLoading] = useState(false);
  const [loadingNote, setLoadingNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [liveAtmStrike, setLiveAtmStrike] = useState<number | null>(null);
  const [livePremium, setLivePremium] = useState<number>(0);

  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const premiumSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const spotSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ceSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const peSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const strikeSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ivSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const unsubsRef = useRef<(() => void)[]>([]);
  const nubraWsRef = useRef<WebSocket | null>(null);
  const activeKeysRef = useRef<string[]>([]);
  const activeStrikesRef = useRef<number[]>([]);
  const liveSpotRef = useRef(0);
  const liveLtpByStrikeRef = useRef<Map<number, { ce: number; pe: number }>>(new Map());
  const keyMetaRef = useRef<Map<string, { strike: number; type: 'CE' | 'PE' }>>(new Map());
  const intervalRef = useRef(interval);
  const [splitRatio, setSplitRatio] = useState(0.62);
  const [splitterTop, setSplitterTop] = useState<number>(0);
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    time: string;
    premium: number | null;
    spot: number | null;
    iv: number | null;
    atmStrike: number | null;
    ce: number | null;
    pe: number | null;
  }>({
    visible: false,
    x: 0,
    y: 0,
    time: '',
    premium: null,
    spot: null,
    iv: null,
    atmStrike: null,
    ce: null,
    pe: null,
  });

  const underlyings = useMemo(() => getUnderlyings(instruments), [instruments]);
  const expiries = useMemo(() => underlying ? getExpiries(instruments, underlying) : [], [instruments, underlying]);

  // Auto-select NIFTY (or first available) on first load
  useEffect(() => {
    if (underlying || underlyings.length === 0) return;
    const def = underlyings.includes('NIFTY') ? 'NIFTY' : underlyings[0];
    setUnderlying(def);
  }, [underlyings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select nearest expiry when underlying loads or changes
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!underlying || expiries.length === 0) return;
    setExpiry(prev => {
      if (prev && expiries.includes(prev)) return prev; // keep if still valid
      const now = Date.now();
      const nearest = expiries.filter(e => e >= now).sort((a, b) => a - b)[0] ?? expiries[0];
      return nearest ?? null;
    });
  }, [underlying, expiries]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { intervalRef.current = interval; }, [interval]);

  const applyPaneHeights = useCallback((ratio: number) => {
    const chart = chartRef.current;
    const host = chartHostRef.current;
    if (!chart || !host || !splitEnabled) return;
    const h = host.clientHeight;
    if (h <= 0) return;
    const minTop = 150;
    const minBottom = 120;
    const topPx = Math.max(minTop, Math.min(h - minBottom, Math.floor(h * ratio)));
    const bottomPx = Math.max(minBottom, h - topPx);
    try {
      chart.panes()[0]?.setHeight(topPx);
      chart.panes()[1]?.setHeight(bottomPx);
    } catch {
      return;
    }
    setSplitterTop(topPx);
  }, [splitEnabled]);

  useEffect(() => {
    if (!chartHostRef.current) return;
    const chart = createChart(chartHostRef.current, {
      autoSize: true,
      layout: { background: { color: '#141210' }, textColor: '#B2B5BE' },
      grid: { vertLines: { color: '#24201c' }, horzLines: { color: '#24201c' } },
      rightPriceScale: { borderColor: '#3a332a', visible: true },
      leftPriceScale: { borderColor: '#3a332a', visible: true },
      timeScale: {
        borderColor: '#3a332a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        tickMarkFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
      },
      localization: {
        timeFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
      },
    });
    const onCrosshairMove = (param: any) => {
      const host = chartHostRef.current;
      if (!host || !param.point || !param.time) {
        setTooltip(prev => prev.visible ? { ...prev, visible: false } : prev);
        return;
      }
      const x = param.point.x;
      const y = param.point.y;
      if (x < 0 || y < 0 || x > host.clientWidth || y > host.clientHeight) {
        setTooltip(prev => prev.visible ? { ...prev, visible: false } : prev);
        return;
      }

      const premium = premiumSeriesRef.current ? valueFromSeriesData(param.seriesData.get(premiumSeriesRef.current)) : null;
      const spot = spotSeriesRef.current ? valueFromSeriesData(param.seriesData.get(spotSeriesRef.current)) : null;
      const iv = ivSeriesRef.current ? valueFromSeriesData(param.seriesData.get(ivSeriesRef.current)) : null;
      const atmStrike = strikeSeriesRef.current ? valueFromSeriesData(param.seriesData.get(strikeSeriesRef.current)) : null;
      const ce = ceSeriesRef.current ? valueFromSeriesData(param.seriesData.get(ceSeriesRef.current)) : null;
      const pe = peSeriesRef.current ? valueFromSeriesData(param.seriesData.get(peSeriesRef.current)) : null;

      const pad = 14;
      const tx = Math.max(8, Math.min(host.clientWidth - 220, x + pad));
      const ty = Math.max(8, Math.min(host.clientHeight - 150, y + pad));
      setTooltip({
        visible: true,
        x: tx,
        y: ty,
        time: formatTooltipTime(param.time),
        premium: numOrNull(premium),
        spot: numOrNull(spot),
        iv: numOrNull(iv),
        atmStrike: numOrNull(atmStrike),
        ce: numOrNull(ce),
        pe: numOrNull(pe),
      });
    };
    chart.subscribeCrosshairMove(onCrosshairMove);
    chartRef.current = chart;
    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  const cleanupLive = useCallback(() => {
    unsubsRef.current.forEach(u => u());
    unsubsRef.current = [];
    if (activeKeysRef.current.length > 0) wsManager.releaseKeys(activeKeysRef.current);
    activeKeysRef.current = [];
    keyMetaRef.current = new Map();
    liveLtpByStrikeRef.current = new Map();
    activeStrikesRef.current = [];
    liveSpotRef.current = 0;
    // Close Nubra WS
    if (nubraWsRef.current) {
      try { nubraWsRef.current.close(); } catch { /* ignore */ }
      nubraWsRef.current = null;
    }
  }, []);

  const clearSeries = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const ref of [premiumSeriesRef, spotSeriesRef, ceSeriesRef, peSeriesRef, strikeSeriesRef, ivSeriesRef]) {
      if (ref.current) {
        try { chart.removeSeries(ref.current); } catch { /* ignore */ }
        ref.current = null;
      }
    }
    setSplitEnabled(false);
  }, []);

  const applyLive = useCallback(() => {
    const spot = liveSpotRef.current;
    if (!spot || !premiumSeriesRef.current || !ceSeriesRef.current || !peSeriesRef.current || !strikeSeriesRef.current) return;
    const atm = nearestStrike(activeStrikesRef.current, spot);
    if (atm == null) return;
    const ltp = liveLtpByStrikeRef.current.get(atm);
    if (!ltp || !ltp.ce || !ltp.pe) return;
    const t = snapToBarTime(Date.now(), intervalRef.current.min) as Time;
    const prem = ltp.ce + ltp.pe;
    try {
      premiumSeriesRef.current.update({ time: t, value: prem });
      spotSeriesRef.current?.update({ time: t, value: spot });
      ceSeriesRef.current.update({ time: t, value: ltp.ce });
      peSeriesRef.current.update({ time: t, value: ltp.pe });
      strikeSeriesRef.current.update({ time: t, value: atm });
    } catch {
      return;
    }
    setLiveAtmStrike(prev => prev === atm ? prev : atm);
    setLivePremium(prem);
  }, []);

  const handleLoad = useCallback(async () => {
    if (!underlying || !expiry) return;
    const chart = chartRef.current;
    if (!chart) return;

    cleanupLive();
    clearSeries();
    setError(null);
    setLoadingNote('Preparing instruments...');
    setLiveAtmStrike(null);
    setLivePremium(0);
    setLoading(true);

    try {
      const spotKey = findSpotKey(instruments, underlying);
      if (!spotKey) throw new Error(`Spot key not found for ${underlying}`);
      const nubraExchange = toNubraExchange(instruments, underlying, expiry);
      const spotIns = instruments.find(i => i.instrument_key === spotKey);
      const nubraType: 'INDEX' | 'STOCK' = spotIns?.instrument_type === 'EQ' ? 'STOCK' : 'INDEX';
      const ivPromise = fetchNubraAtmIvSeries(underlying, nubraExchange, expiry, nubraType).catch(() => [] as LineData[]);

      const pairMap = new Map<number, { ceKey: string | null; peKey: string | null }>();
      for (const ins of instruments) {
        if (ins.underlying_symbol !== underlying || ins.expiry !== expiry || ins.strike_price == null) continue;
        const row = pairMap.get(ins.strike_price) ?? { ceKey: null, peKey: null };
        if (ins.instrument_type === 'CE') row.ceKey = ins.instrument_key;
        if (ins.instrument_type === 'PE') row.peKey = ins.instrument_key;
        pairMap.set(ins.strike_price, row);
      }

      const allStrikes = [...pairMap.entries()]
        .filter(([, v]) => !!v.ceKey && !!v.peKey)
        .map(([k]) => k)
        .sort((a, b) => a - b);
      if (!allStrikes.length) throw new Error('No CE/PE strike pairs found for selected expiry');

      setLoadingNote('Loading spot candles...');
      const spotCandles = await loadFullDayCandles(spotKey);
      if (!spotCandles.length) throw new Error('No spot candles found');

      const spotResampled = resample(spotCandles, interval.min);
      const spotClose = spotResampled.map(c => c[4]).filter(v => typeof v === 'number' && Number.isFinite(v));
      if (!spotClose.length) throw new Error('Spot series is empty');

      const minSpot = Math.min(...spotClose);
      const maxSpot = Math.max(...spotClose);
      let step = 50;
      for (let i = 1; i < allStrikes.length; i++) {
        const d = allStrikes[i] - allStrikes[i - 1];
        if (d > 0) { step = Math.min(step, d); }
      }
      const band = Math.max(step * 8, step * 2);
      let candidateStrikes = allStrikes.filter(x => x >= (minSpot - band) && x <= (maxSpot + band));
      if (!candidateStrikes.length) {
        const mid = (minSpot + maxSpot) / 2;
        candidateStrikes = [...allStrikes].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid)).slice(0, 16).sort((a, b) => a - b);
      }

      const strikeCandles = new Map<number, { ce: number[][]; pe: number[][]; ceKey: string; peKey: string }>();
      let strikeDefs = candidateStrikes.map((strike) => {
        const row = pairMap.get(strike)!;
        const ceKey = row.ceKey!;
        const peKey = row.peKey!;
        return { strike, ceKey, peKey };
      });

      // Keep option fetches within max 3 batch calls.
      const maxPairs = Math.floor((MAX_OPTION_BATCH_CALLS * KEYS_PER_BATCH_CALL) / 2);
      if (strikeDefs.length > maxPairs) {
        const mid = (minSpot + maxSpot) / 2;
        strikeDefs = [...strikeDefs]
          .sort((a, b) => Math.abs(a.strike - mid) - Math.abs(b.strike - mid))
          .slice(0, maxPairs)
          .sort((a, b) => a.strike - b.strike);
      }

      const allOptionKeys = strikeDefs.flatMap(d => [d.ceKey, d.peKey]);
      const keyBatches = chunk(allOptionKeys, KEYS_PER_BATCH_CALL).slice(0, MAX_OPTION_BATCH_CALLS);
      const totalBatches = keyBatches.length;
      const failedKeys: string[] = [];
      const candlesByKey = new Map<string, number[][]>();

      for (let bi = 0; bi < keyBatches.length; bi++) {
        const batchKeys = keyBatches[bi];
        setLoadingNote(`Loading options batch ${bi + 1}/${totalBatches}...`);
        const { data, errors } = await fetchCandlesBatchWithRetry(batchKeys, INTERVALS[0]);
        const mergedData = { ...data };
        const keysNeedingPrevPage = batchKeys.filter(key => {
          const row = data[key];
          return Boolean(row?.meta?.prevTimestamp);
        });

        if (keysNeedingPrevPage.length) {
          const keysByPrevFrom = new Map<number, string[]>();
          for (const key of keysNeedingPrevPage) {
            const prevFrom = data[key]?.meta?.prevTimestamp;
            if (typeof prevFrom !== 'number' || !Number.isFinite(prevFrom)) continue;
            const group = keysByPrevFrom.get(prevFrom) ?? [];
            group.push(key);
            keysByPrevFrom.set(prevFrom, group);
          }

          for (const [prevFrom, groupedKeys] of keysByPrevFrom.entries()) {
            const prevBatch = await fetchCandlesBatchWithRetry(groupedKeys, INTERVALS[0], prevFrom);
            for (const key of groupedKeys) {
              const currentCandles = mergedData[key]?.candles ?? [];
              const previousCandles = prevBatch.data[key]?.candles ?? [];
              if (!previousCandles.length) continue;
              mergedData[key] = {
                candles: mergeCandlesByTimestamp(previousCandles, currentCandles),
              };
            }
          }
        }
        for (const key of batchKeys) {
          const row = mergedData[key];
          if (row?.candles?.length) candlesByKey.set(key, row.candles);
          else failedKeys.push(key);
          if (errors[key]) failedKeys.push(`${key}:${errors[key]}`);
        }
        await sleep(20);
      }

      for (const def of strikeDefs) {
        const ce = candlesByKey.get(def.ceKey) ?? [];
        const pe = candlesByKey.get(def.peKey) ?? [];
        if (!ce.length || !pe.length) continue;
        strikeCandles.set(def.strike, { ce, pe, ceKey: def.ceKey, peKey: def.peKey });
      }
      if (failedKeys.length > 0) console.warn('[ATM Rolling] batch failures/skips:', failedKeys.slice(0, 12));

      setLoadingNote('Building rolling series...');
      const strikeTsMap = new Map<number, { ce: Map<number, number>; pe: Map<number, number> }>();
      for (const [strike, row] of strikeCandles.entries()) {
        const ceMap = new Map<number, number>();
        const peMap = new Map<number, number>();
        for (const c of resample(row.ce, interval.min)) ceMap.set(Math.floor(c[0] / 1000), c[4]);
        for (const p of resample(row.pe, interval.min)) peMap.set(Math.floor(p[0] / 1000), p[4]);
        if (ceMap.size && peMap.size) strikeTsMap.set(strike, { ce: ceMap, pe: peMap });
      }

      const usableStrikes = [...strikeTsMap.keys()].sort((a, b) => a - b);
      if (!usableStrikes.length) throw new Error('No usable option candle pairs for rolling series');

      const premiumSeries: LineData[] = [];
      const ceSeries: LineData[] = [];
      const peSeries: LineData[] = [];
      const atmStrikeSeries: LineData[] = [];

      for (const c of spotResampled) {
        const ts = Math.floor(c[0] / 1000);
        const spot = c[4];
        const atm = nearestStrike(usableStrikes, spot);
        if (atm == null) continue;
        const pair = strikeTsMap.get(atm);
        if (!pair) continue;
        const ce = pair.ce.get(ts);
        const pe = pair.pe.get(ts);
        if (!ce || !pe) continue;
        premiumSeries.push({ time: ts as Time, value: ce + pe });
        ceSeries.push({ time: ts as Time, value: ce });
        peSeries.push({ time: ts as Time, value: pe });
        atmStrikeSeries.push({ time: ts as Time, value: atm });
      }

      if (!premiumSeries.length) throw new Error('No merged bars for ATM rolling premium');

      // Pane 0 (top): Straddle Premium + Spot + IV
      const premiumSer = chart.addSeries(LineSeries, {
        color: '#facc15',
        lineWidth: 2,
        title: 'ATM Rolling Premium',
        priceScaleId: 'right',
      }, 0);
      premiumSer.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.08, bottom: 0.08 } });
      premiumSer.setData(premiumSeries);
      premiumSeriesRef.current = premiumSer;

      const spotLine: LineData[] = spotResampled.map(c => ({ time: Math.floor(c[0] / 1000) as Time, value: c[4] }));
      const spotSer = chart.addSeries(LineSeries, {
        color: '#d1d5db',
        lineWidth: 1,
        lineStyle: 1,
        title: 'Spot',
        priceScaleId: 'left',
      }, 0);
      spotSer.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.08, bottom: 0.08 } });
      spotSer.setData(spotLine);
      spotSeriesRef.current = spotSer;

      // Pane 1 (bottom): ATM Strike + CE + PE
      const ceSer = chart.addSeries(LineSeries, {
        color: '#34d399',
        lineWidth: 1,
        lineStyle: 2,
        title: 'ATM CE',
        priceScaleId: 'opt-bottom',
      }, 1);
      ceSer.setData(ceSeries);
      ceSeriesRef.current = ceSer;

      const peSer = chart.addSeries(LineSeries, {
        color: '#f87171',
        lineWidth: 1,
        lineStyle: 2,
        title: 'ATM PE',
        priceScaleId: 'opt-bottom',
      }, 1);
      peSer.setData(peSeries);
      peSeriesRef.current = peSer;

      const strikeSer = chart.addSeries(LineSeries, {
        priceScaleId: 'strike-bottom',
        color: '#60a5fa',
        lineWidth: 1,
        title: 'ATM Strike',
        lastValueVisible: true,
      }, 1);
      strikeSer.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.10, bottom: 0.08 } });
      strikeSer.setData(atmStrikeSeries);
      strikeSeriesRef.current = strikeSer;

      setLoadingNote('Loading Nubra rolling IV...');
      const ivData = await ivPromise;
      if (ivData.length > 0) {
        const ivSer = chart.addSeries(LineSeries, {
          priceScaleId: 'iv-top-hidden',
          color: '#22d3ee',
          lineWidth: 2,
          lineStyle: 1,
          title: 'Rolling IV % (Nubra)',
          lastValueVisible: true,
          priceLineVisible: false,
        }, 0);
        ivSer.priceScale().applyOptions({ visible: false, scaleMargins: { top: 0.08, bottom: 0.08 } });
        ivSer.setData(ivData);
        ivSeriesRef.current = ivSer;
      }

      // Show dedicated pane split and apply initial heights.
      setSplitEnabled(true);
      setTimeout(() => applyPaneHeights(splitRatio), 0);

      chart.timeScale().fitContent();

      setLiveAtmStrike(atmStrikeSeries.at(-1)?.value ?? null);
      setLivePremium(premiumSeries.at(-1)?.value ?? 0);

      // Seed and subscribe live data for spot + selected strike universe.
      const reqKeys: string[] = [spotKey];
      const keyMeta = new Map<string, { strike: number; type: 'CE' | 'PE' }>();
      const liveLtp = new Map<number, { ce: number; pe: number }>();
      for (const strike of usableStrikes) {
        const row = strikeCandles.get(strike)!;
        reqKeys.push(row.ceKey, row.peKey);
        keyMeta.set(row.ceKey, { strike, type: 'CE' });
        keyMeta.set(row.peKey, { strike, type: 'PE' });
        liveLtp.set(strike, { ce: wsManager.get(row.ceKey)?.ltp ?? 0, pe: wsManager.get(row.peKey)?.ltp ?? 0 });
      }
      keyMetaRef.current = keyMeta;
      liveLtpByStrikeRef.current = liveLtp;
      activeStrikesRef.current = usableStrikes;
      activeKeysRef.current = reqKeys;
      wsManager.requestKeys(reqKeys);

      const unsubs: (() => void)[] = [];
      unsubs.push(
        wsManager.subscribe(spotKey, md => {
          if (!md.ltp) return;
          liveSpotRef.current = md.ltp;
          applyLive();
        }),
      );
      for (const [key, meta] of keyMeta.entries()) {
        unsubs.push(
          wsManager.subscribe(key, md => {
            if (!md.ltp) return;
            const row = liveLtpByStrikeRef.current.get(meta.strike) ?? { ce: 0, pe: 0 };
            if (meta.type === 'CE') row.ce = md.ltp;
            else row.pe = md.ltp;
            liveLtpByStrikeRef.current.set(meta.strike, row);
            applyLive();
          }),
        );
      }
      unsubsRef.current = unsubs;
      liveSpotRef.current = wsManager.get(spotKey)?.ltp ?? spotResampled.at(-1)?.[4] ?? 0;
      applyLive();

      // ── Nubra WS: live ATM IV updates ───────────────────────────────────────
      const nubraToken = localStorage.getItem('nubra_session_token') ?? '';
      const nubraExpiryStr = new Date(expiry)
        .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
        .replace(/-/g, '');
      if (nubraToken) {
        if (nubraWsRef.current) {
          try { nubraWsRef.current.close(); } catch { /* ignore */ }
          nubraWsRef.current = null;
        }
        const ws = new WebSocket(NUBRA_BRIDGE);
        nubraWsRef.current = ws;
        ws.onopen = () => {
          ws.send(JSON.stringify({
            action: 'subscribe',
            session_token: nubraToken,
            data_type: 'option',
            symbols: [`${underlying}:${nubraExpiryStr}`],
            exchange: nubraExchange,
          }));
        };
        ws.onmessage = evt => {
          try {
            const msg = JSON.parse(evt.data as string);
            if (msg.type !== 'option' || !msg.data) return;
            const d = msg.data;
            // at_the_money_strike comes directly from WS
            const atmStrike = Number(d.at_the_money_strike ?? 0);
            const currentPrice = Number(d.current_price ?? 0);
            const spot = currentPrice > 0 ? currentPrice : atmStrike;

            // Find IV for the ATM strike from CE array (avg CE+PE if both present)
            let atmIv = 0;
            const ceArr: any[] = d.ce ?? [];
            const peArr: any[] = d.pe ?? [];
            if (atmStrike > 0) {
              const ceItem = ceArr.find((x: any) => Math.abs(Number(x.strike_price ?? 0) - atmStrike) < 0.01);
              const peItem = peArr.find((x: any) => Math.abs(Number(x.strike_price ?? 0) - atmStrike) < 0.01);
              const ceIv = ceItem ? Number(ceItem.iv ?? 0) : 0;
              const peIv = peItem ? Number(peItem.iv ?? 0) : 0;
              if (ceIv > 0 && peIv > 0) atmIv = (ceIv + peIv) / 2;
              else atmIv = ceIv || peIv;
            } else if (spot > 0) {
              // Fallback: find nearest strike in ce array
              let bestDist = Infinity;
              for (const x of ceArr) {
                const sp = Number(x.strike_price ?? 0);
                const dist = Math.abs(sp - spot);
                if (dist < bestDist && Number(x.iv ?? 0) > 0) {
                  bestDist = dist;
                  atmIv = Number(x.iv);
                }
              }
            }

            if (atmIv > 0) {
              // Lazily create IV series if historical load returned nothing
              if (!ivSeriesRef.current && chartRef.current) {
                try {
                  const ivSer = chartRef.current.addSeries(LineSeries, {
                    priceScaleId: 'iv-top-hidden',
                    color: '#22d3ee',
                    lineWidth: 2,
                    lineStyle: 1,
                    title: 'Rolling IV % (Nubra)',
                    lastValueVisible: true,
                    priceLineVisible: false,
                  }, 0);
                  ivSer.priceScale().applyOptions({ visible: false, scaleMargins: { top: 0.08, bottom: 0.08 } });
                  ivSeriesRef.current = ivSer;
                } catch { /* chart may be disposed */ }
              }
              if (ivSeriesRef.current) {
                // WS iv is decimal (0.15 = 15%) — multiply by 100 to match historical series
                const t = snapToBarTime(Date.now(), intervalRef.current.min) as Time;
                try { ivSeriesRef.current.update({ time: t, value: atmIv * 100 }); } catch { /* ignore */ }
              }
            }
          } catch {
            // ignore malformed
          }
        };
        ws.onerror = () => {};
        ws.onclose = () => {
          if (nubraWsRef.current === ws) nubraWsRef.current = null;
        };
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingNote('');
      setLoading(false);
    }
  }, [applyLive, cleanupLive, clearSeries, expiry, instruments, interval, underlying]);

  // Auto-trigger load once underlying + expiry are both set for the first time
  // Must be placed AFTER handleLoad to avoid temporal dead-zone error
  useEffect(() => {
    if (autoLoadedRef.current || !underlying || !expiry) return;
    autoLoadedRef.current = true;
    const t = setTimeout(() => { handleLoad(); }, 120);
    return () => clearTimeout(t);
  }, [underlying, expiry, handleLoad]);

  useEffect(() => () => cleanupLive(), [cleanupLive]);

  useEffect(() => {
    if (!splitEnabled) return;
    applyPaneHeights(splitRatio);
  }, [splitRatio, splitEnabled, applyPaneHeights]);

  useEffect(() => {
    const host = chartHostRef.current;
    if (!host || !splitEnabled) return;
    const ro = new ResizeObserver(() => applyPaneHeights(splitRatio));
    ro.observe(host);
    return () => ro.disconnect();
  }, [splitEnabled, splitRatio, applyPaneHeights]);

  const onSplitterMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!splitEnabled) return;
    e.preventDefault();
    const host = chartHostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const minTop = 150;
    const minBottom = 120;

    const onMove = (me: MouseEvent) => {
      const y = me.clientY - rect.top;
      const top = Math.max(minTop, Math.min(rect.height - minBottom, y));
      const ratio = rect.height > 0 ? top / rect.height : 0.62;
      setSplitRatio(ratio);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [splitEnabled]);

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <div className={s.field}>
          <span className={s.label}>Underlying</span>
          <select className={s.select} value={underlying} onChange={e => { setUnderlying(e.target.value); setExpiry(null); }}>
            <option value="">Select</option>
            {underlyings.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>

        <div className={s.field}>
          <span className={s.label}>Expiry</span>
          <select className={s.select} value={expiry ?? ''} onChange={e => setExpiry(e.target.value ? Number(e.target.value) : null)} disabled={!underlying}>
            <option value="">Select</option>
            {expiries.map(ex => (
              <option key={ex} value={ex}>
                {new Date(ex).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' })}
              </option>
            ))}
          </select>
        </div>

        <div className={s.field}>
          <span className={s.label}>Interval</span>
          <select className={s.select} value={interval.label} onChange={e => setInterval(INTERVALS.find(x => x.label === e.target.value) ?? INTERVALS[1])}>
            {INTERVALS.map(iv => <option key={iv.label} value={iv.label}>{iv.label}</option>)}
          </select>
        </div>

        <button className={s.loadBtn} onClick={handleLoad} disabled={loading || !underlying || !expiry}>
          {loading ? 'Loading...' : 'Load ATM Rolling'}
        </button>

        <div className={s.liveBlock}>
          <span>ATM: {liveAtmStrike ? liveAtmStrike.toFixed(0) : '--'}</span>
          <span>Premium: {livePremium > 0 ? livePremium.toFixed(2) : '--'}</span>
        </div>
      </div>

      {error && <div className={s.error}>{error}</div>}
      <div className={s.chart} ref={chartHostRef}>
        {tooltip.visible && (
          <div className={s.tooltip} style={{ left: tooltip.x, top: tooltip.y }}>
            <div className={s.tooltipTime}>{tooltip.time}</div>
            <div className={s.tooltipRow}><span>Straddle</span><b>{tooltip.premium != null ? tooltip.premium.toFixed(2) : '--'}</b></div>
            <div className={s.tooltipRow}><span>Spot</span><b>{tooltip.spot != null ? tooltip.spot.toFixed(2) : '--'}</b></div>
            <div className={s.tooltipRow}><span>IV %</span><b>{tooltip.iv != null ? tooltip.iv.toFixed(2) : '--'}</b></div>
            <div className={s.tooltipDivider} />
            <div className={s.tooltipRow}><span>ATM Strike</span><b>{tooltip.atmStrike != null ? tooltip.atmStrike.toFixed(0) : '--'}</b></div>
            <div className={s.tooltipRow}><span>ATM CE</span><b>{tooltip.ce != null ? tooltip.ce.toFixed(2) : '--'}</b></div>
            <div className={s.tooltipRow}><span>ATM PE</span><b>{tooltip.pe != null ? tooltip.pe.toFixed(2) : '--'}</b></div>
          </div>
        )}
        {splitEnabled && (
          <>
            <div className={s.paneLabel} style={{ top: 8 }}>
              Top: Straddle + Spot + IV
            </div>
            <div className={s.paneLabel} style={{ top: Math.max(10, splitterTop + 8) }}>
              Bottom: ATM Strike + CE + PE
            </div>
          </>
        )}
        {splitEnabled && (
          <div
            className={s.paneSplitter}
            style={{ top: Math.max(0, splitterTop - 2) }}
            onMouseDown={onSplitterMouseDown}
            title="Drag to resize panes"
          >
            <span className={s.paneSplitterGrip} />
          </div>
        )}
        {loading && (
          <div className={s.loadingOverlay}>
            <div className={s.loadingCard}>
              <div className={s.loadingSpinner} />
              <span>{loadingNote || 'Loading ATM rolling data...'}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
