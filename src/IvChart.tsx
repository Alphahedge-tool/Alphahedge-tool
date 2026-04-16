'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type CandlestickData,
  type Time,
  type LogicalRange,
} from 'lightweight-charts';
import type { Instrument } from './useInstruments';
import type { NubraInstrument } from './useNubraInstruments';
import { wsManager, type InstrumentMarketData } from './lib/WebSocketManager';
import s from './IvChart.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  instruments: Instrument[];
  nubraInstruments: NubraInstrument[];
  workerRef?: React.RefObject<Worker | null>;
  initialSymbol?: string;
}

// ── Helpers (mirrors StrategyChart) ──────────────────────────────────────────

const IST_OFFSET_SEC = 19800;

function snapToMinBar(tsMs: number): number {
  const sec = Math.floor(tsMs / 1000);
  return Math.floor((sec + IST_OFFSET_SEC) / 60) * 60 - IST_OFFSET_SEC;
}

function lastTradingDay(): string {
  const istMs  = Date.now() + 5.5 * 3600 * 1000;
  const d      = new Date(istMs);
  const istMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const OPEN   = 9 * 60 + 15;
  // If today is a weekday but before market open, treat as previous day
  if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && istMin < OPEN) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  // Walk back over weekends
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function getMarketSchedule() {
  const istMs  = Date.now() + 5.5 * 3600 * 1000;
  const istNow = new Date(istMs);
  const istMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const OPEN = 9 * 60 + 15, CLOSE = 15 * 60 + 30;
  const isWeekday = istNow.getUTCDay() >= 1 && istNow.getUTCDay() <= 5;
  return {
    isMarketOpen: isWeekday && istMin >= OPEN && istMin <= CLOSE,
    tradingDate: lastTradingDay(),
    nowUtcIso: new Date().toISOString(),
  };
}

function buildTimeseriesWindow(startDateStr: string) {
  const { isMarketOpen, tradingDate, nowUtcIso } = getMarketSchedule();
  const isIntraday = startDateStr === tradingDate && isMarketOpen;
  return {
    startDate: `${startDateStr}T03:45:00.000Z`,
    endDate: isIntraday ? nowUtcIso : `${startDateStr}T10:00:00.000Z`,
    intraDay: isIntraday,
    realTime: false,
  };
}

function expiryToMs(exp: string | number | null | undefined): number {
  if (exp == null) return 0;
  const s = String(exp);
  // YYYYMMDD number
  if (/^\d{8}$/.test(s)) {
    return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  }
  // Unix ms
  if (/^\d{13}$/.test(s)) return +s;
  // Unix sec
  if (/^\d{10}$/.test(s)) return +s * 1000;
  // YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return 0;
}

function toNubraChainValue(underlying: string, expiryMs: number): string {
  const d = new Date(expiryMs);
  const yyyy = d.toLocaleString('en-IN', { year: 'numeric', timeZone: 'Asia/Kolkata' });
  const mm   = d.toLocaleString('en-IN', { month: '2-digit', timeZone: 'Asia/Kolkata' });
  const dd   = d.toLocaleString('en-IN', { day: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${underlying}_${yyyy}${mm}${dd}`;
}

function sortDedup(pts: LineData[]): LineData[] {
  pts.sort((a, b) => (a.time as number) - (b.time as number));
  const out: LineData[] = [];
  const seen = new Set<number>();
  for (const pt of pts) {
    const t = pt.time as number;
    if (!seen.has(t)) { seen.add(t); out.push(pt); }
  }
  return out;
}

function calcATMStrike(
  spot: number,
  nubraInstruments: NubraInstrument[],
  assetSym: string,
  expiry: string,
): number {
  if (spot <= 0) return 0;
  const sym = assetSym.toUpperCase();
  const expiryMs = expiryToMs(expiry);
  const opts = nubraInstruments.filter(i => {
    if (i.strike_price == null) return false;
    if (expiryMs > 0 && i.expiry) {
      if (expiryToMs(String(i.expiry)) !== expiryMs) return false;
    }
    return (
      i.asset?.toUpperCase() === sym ||
      i.nubra_name?.toUpperCase() === sym ||
      i.stock_name?.toUpperCase().startsWith(sym)
    );
  });
  if (!opts.length) return 0;
  let best = opts[0];
  let bestDiff = Math.abs((best.strike_price! / 100) - spot);
  for (const o of opts) {
    const diff = Math.abs((o.strike_price! / 100) - spot);
    if (diff < bestDiff) { best = o; bestDiff = diff; }
  }
  return best.strike_price! / 100;
}

// Raw candle fetch — mirrors CandleChart's fetchCandles exactly
async function fetchRawCandles(
  instrumentKey: string,
  from: number,
): Promise<{ candles: number[][]; prevTimestamp: number | null }> {
  const params = new URLSearchParams({ instrumentKey, interval: 'I1', from: String(from), limit: '500' });
  const res = await fetch(`/api/public-candles?${params}`);
  if (!res.ok) return { candles: [], prevTimestamp: null };
  const json = await res.json();
  const candles: number[][] = (json?.data?.candles ?? []).reverse(); // oldest-first
  const prevTimestamp: number | null = json?.data?.meta?.prevTimestamp ?? null;
  return { candles, prevTimestamp };
}

function candlesToCandleData(candles: number[][]): CandlestickData[] {
  const sorted = [...candles].sort((a, b) => a[0] - b[0]);
  const unique = sorted.filter((c, i) => i === 0 || c[0] !== sorted[i - 1][0]);
  return unique.map(c => ({
    time:  Math.floor(c[0] / 1000) as unknown as Time,
    open:  c[1], high: c[2], low: c[3], close: c[4],
  }));
}

async function fetchAtmIvChart(
  underlying: string,
  exchange: string,
  expiryMs: number,
  startDateStr: string,
  nubraType: 'INDEX' | 'STOCK',
): Promise<LineData[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie    = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken) return [];

  const chainValue = toNubraChainValue(underlying, expiryMs);
  const spotType   = nubraType === 'STOCK' ? 'STOCK' : 'INDEX';
  const commonDates = { interval: '1m', ...buildTimeseriesWindow(startDateStr) };

  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: {
      'x-session-token': sessionToken,
      'x-device-id':     deviceId,
      'x-raw-cookie':    rawCookie,
      'Content-Type':    'application/json',
    },
    body: JSON.stringify({
      chart: 'ATM_Volatility_vs_Spot',
      query: [
        { exchange, type: 'CHAIN',   values: [chainValue],  fields: ['atm_iv'], ...commonDates },
        { exchange, type: spotType,  values: [underlying],  fields: ['value'],  ...commonDates },
      ],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  // Search all result entries for the chainValue key (order not guaranteed)
  let pts: { ts: number; v: number }[] = [];
  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      if (valObj?.[chainValue]?.atm_iv?.length) { pts = valObj[chainValue].atm_iv; break; }
    }
    if (pts.length) break;
  }
  // ts is in nanoseconds — convert to seconds, then snap to 1-min bar in IST
  // to match exactly how spot candles are timestamped
  return pts.map(p => {
    const sec = Math.round(p.ts / 1e9);
    const snapped = Math.floor((sec + IST_OFFSET_SEC) / 60) * 60 - IST_OFFSET_SEC;
    return { time: snapped as unknown as Time, value: p.v * 100 };
  });
}

async function fetchPcrChart(
  underlying: string,
  exchange: string,
  expiryMs: number,
  startDateStr: string,
  nubraType: 'INDEX' | 'STOCK',
): Promise<LineData[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie    = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken) return [];

  const chainValue = toNubraChainValue(underlying, expiryMs);
  const spotType   = nubraType === 'STOCK' ? 'STOCK' : 'INDEX';
  const commonDates = { interval: '1m', ...buildTimeseriesWindow(startDateStr) };

  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: {
      'x-session-token': sessionToken,
      'x-device-id':     deviceId,
      'x-raw-cookie':    rawCookie,
      'Content-Type':    'application/json',
    },
    body: JSON.stringify({
      chart: 'Put_Call_Ratio',
      query: [
        { exchange, type: 'CHAIN',   values: [chainValue],  fields: ['cumulative_call_oi', 'cumulative_put_oi'], ...commonDates },
        { exchange, type: spotType,  values: [underlying],  fields: ['value'], ...commonDates },
      ],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  let chainData: any = null;
  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      if (valObj?.[chainValue]) { chainData = valObj[chainValue]; break; }
    }
    if (chainData) break;
  }
  const callOi: { ts: number; v: number }[] = chainData?.cumulative_call_oi ?? [];
  const putOi:  { ts: number; v: number }[] = chainData?.cumulative_put_oi  ?? [];

  // Build PCR = put_oi / call_oi, keyed by raw ts (nanoseconds) for matching
  const callMap = new Map<number, number>();
  for (const p of callOi) callMap.set(p.ts, p.v);

  const pts: LineData[] = [];
  for (const p of putOi) {
    const call = callMap.get(p.ts);
    if (!call || call === 0) continue;
    // Snap to 1-min IST bar — same as IV timestamps
    const sec = Math.round(p.ts / 1e9);
    const snapped = Math.floor((sec + IST_OFFSET_SEC) / 60) * 60 - IST_OFFSET_SEC;
    pts.push({ time: snapped as unknown as Time, value: p.v / call });
  }
  return sortDedup(pts);
}

// Resolve available expiries for a symbol from nubraInstruments
// nubraType filters to the correct asset_type: INDEX → INDEX_FO, STOCK → STOCK_FO
// Falls back to Upstox FUT instrument expiries for MCX/commodity symbols
function getExpiries(
  sym: string,
  nubraInstruments: NubraInstrument[],
  nubraType: 'INDEX' | 'STOCK',
  exchange: string,
  upstoxInstruments: Instrument[] = [],
): string[] {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const upper = sym.toUpperCase();
  const expectedAssetType = nubraType === 'INDEX' ? 'INDEX_FO' : 'STOCK_FO';
  const exch = exchange.toUpperCase();

  const set = new Set<string>();
  for (const i of nubraInstruments) {
    if (!i.expiry) continue;
    if (i.option_type !== 'CE' && i.option_type !== 'PE') continue;
    if (i.asset_type !== expectedAssetType) continue;
    if (i.exchange?.toUpperCase() !== exch) continue;
    const matchSym =
      i.asset?.toUpperCase() === upper ||
      i.nubra_name?.toUpperCase() === upper ||
      i.stock_name?.toUpperCase().startsWith(upper);
    if (!matchSym) continue;
    const expStr = String(i.expiry);
    if (expStr >= today) set.add(expStr);
  }

  // Fallback: pull FUT expiries from Upstox instruments (for MCX/commodity)
  if (set.size === 0 && upstoxInstruments.length > 0) {
    const nowMs = Date.now();
    const todayStr = today;
    for (const i of upstoxInstruments) {
      if (i.instrument_type !== 'FUT') continue;
      if (!i.expiry || (i.expiry as number) < nowMs - 86400000) continue;
      const matchSym =
        i.underlying_symbol?.toUpperCase() === upper ||
        i.trading_symbol?.toUpperCase().startsWith(upper);
      if (!matchSym) continue;
      // Convert ms timestamp to YYYYMMDD string
      const d = new Date(i.expiry as number);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const expStr = `${yyyy}${mm}${dd}`;
      if (expStr >= todayStr) set.add(expStr);
    }
  }

  return [...set].sort();
}

// Resolve nubra symbol + exchange + type — mirrors StrategyChart's resolveOne path 0
function resolveNubra(
  sym: string,
  nubraInstruments: NubraInstrument[],
): { nubraSym: string; exchange: string; nubraType: 'INDEX' | 'STOCK' } {
  const upper = sym.toUpperCase();
  // Exact match first (asset/nubra_name/stock_name), options only
  const exact = nubraInstruments.find(i =>
    (i.option_type === 'CE' || i.option_type === 'PE') &&
    (i.asset?.toUpperCase() === upper ||
     i.nubra_name?.toUpperCase() === upper ||
     i.stock_name?.toUpperCase() === upper)
  );
  if (exact?.asset) {
    const isIndex = (exact.asset_type ?? '').includes('INDEX');
    return { nubraSym: exact.asset, exchange: exact.exchange ?? 'NSE', nubraType: isIndex ? 'INDEX' : 'STOCK' };
  }
  // Fallback: exact match across all rows (not just options)
  const fallback = nubraInstruments.find(i =>
    i.asset?.toUpperCase() === upper ||
    i.nubra_name?.toUpperCase() === upper ||
    i.stock_name?.toUpperCase() === upper
  );
  const isIndex = (fallback?.asset_type ?? '').includes('INDEX');
  return {
    nubraSym: fallback?.asset ?? sym,
    exchange: fallback?.exchange ?? 'NSE',
    nubraType: isIndex ? 'INDEX' : 'STOCK',
  };
}

// Resolve Upstox instrument key for spot price subscription
// Mirrors CandleChart's spotInstrumentKey logic exactly
function getSpotInstrumentKey(sym: string, instruments: Instrument[]): string | null {
  const upper = sym.toUpperCase();
  // Exact match on trading_symbol for INDEX
  const idx = instruments.find(i =>
    i.instrument_type === 'INDEX' && i.trading_symbol?.toUpperCase() === upper
  );
  if (idx) return idx.instrument_key;
  // underlying_symbol match for INDEX
  const byUnderlying = instruments.find(i =>
    i.instrument_type === 'INDEX' && i.underlying_symbol?.toUpperCase() === upper
  );
  if (byUnderlying) return byUnderlying.instrument_key;
  // EQ exact match
  const eq = instruments.find(i =>
    i.instrument_type === 'EQ' && i.trading_symbol?.toUpperCase() === upper
  );
  if (eq) return eq.instrument_key;
  // MCX / commodity futures — nearest expiry (smallest expiry timestamp)
  const futs = instruments.filter(i =>
    i.instrument_type === 'FUT' &&
    (i.underlying_symbol?.toUpperCase() === upper || i.trading_symbol?.toUpperCase().startsWith(upper))
  );
  if (futs.length > 0) {
    futs.sort((a, b) => (a.expiry as number) - (b.expiry as number));
    return futs[0].instrument_key;
  }
  return null;
}

// ── Shared Nubra WS singleton ─────────────────────────────────────────────────
// One WS connection shared across all IvChart instances.
// Each instance subscribes with its own ref_ids and callback.

type NubraGreeksMsg = { ref_id: number; iv: number };
type NubraCallback  = (refId: number, iv: number) => void;

const nubraWsSingleton = (() => {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  // refId → Set of callbacks
  const subscribers = new Map<number, Set<NubraCallback>>();
  // refId → count of active subscriptions (for server subscribe/unsubscribe)
  const refCounts = new Map<number, number>();
  // exchange per refId — needed for reconnect re-subscribe
  const refExchange = new Map<number, string>();

  function send(msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function startPing() {
    stopPing();
    // Send a ping every 20s to keep the connection alive
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ action: 'ping' })); } catch { /**/ }
      }
    }, 20_000);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket('ws://localhost:8765');

    ws.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      startPing();
      // Re-subscribe all currently tracked ref_ids, grouped by exchange
      const byExchange = new Map<string, number[]>();
      for (const [id, exch] of refExchange) {
        if (!refCounts.has(id)) continue;
        if (!byExchange.has(exch)) byExchange.set(exch, []);
        byExchange.get(exch)!.push(id);
      }
      const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
      for (const [exch, ids] of byExchange) {
        send({
          action: 'subscribe',
          session_token: sessionToken,
          data_type: 'greeks',
          symbols: [],
          ref_ids: ids,
          exchange: exch,
        });
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'greeks' || !msg.data?.ref_id) return;
        const refId = Number(msg.data.ref_id);
        const iv    = msg.data.iv != null && msg.data.iv > 0 ? msg.data.iv * 100 : 0;
        if (iv <= 0) return;
        subscribers.get(refId)?.forEach(cb => cb(refId, iv));
      } catch { /**/ }
    };

    ws.onclose = () => {
      ws = null;
      stopPing();
      // Reconnect if there are still active subscribers
      if (refCounts.size > 0) {
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => { ws?.close(); };
  }

  return {
    subscribe(refIds: number[], cb: NubraCallback, exch: string) {
      const newIds: number[] = [];
      for (const id of refIds) {
        if (!subscribers.has(id)) subscribers.set(id, new Set());
        subscribers.get(id)!.add(cb);
        refExchange.set(id, exch); // remember exchange for reconnect
        const prev = refCounts.get(id) ?? 0;
        refCounts.set(id, prev + 1);
        if (prev === 0) newIds.push(id);
      }
      connect();
      if (newIds.length > 0) {
        send({
          action: 'subscribe',
          session_token: localStorage.getItem('nubra_session_token') ?? '',
          data_type: 'greeks',
          symbols: [],
          ref_ids: newIds,
          exchange: exch,
        });
      }
    },

    unsubscribe(refIds: number[], cb: NubraCallback) {
      const toUnsub: number[] = [];
      for (const id of refIds) {
        subscribers.get(id)?.delete(cb);
        if (subscribers.get(id)?.size === 0) subscribers.delete(id);
        const prev = refCounts.get(id) ?? 0;
        const next = Math.max(0, prev - 1);
        if (next === 0) { refCounts.delete(id); refExchange.delete(id); toUnsub.push(id); }
        else refCounts.set(id, next);
      }
      if (toUnsub.length > 0) {
        send({
          action: 'unsubscribe',
          session_token: localStorage.getItem('nubra_session_token') ?? '',
          data_type: 'greeks',
          ref_ids: toUnsub,
        });
      }
      // Close WS if no more subscribers
      if (refCounts.size === 0) {
        stopPing();
        ws?.close();
        ws = null;
      }
    },
  };
})();

// ── IvChart ───────────────────────────────────────────────────────────────────

export default function IvChart({ instruments, nubraInstruments, workerRef, initialSymbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const ivSeriesRef   = useRef<ISeriesApi<'Line'> | null>(null);
  const pcrSeriesRef  = useRef<ISeriesApi<'Line'> | null>(null);
  const spotSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // Selected symbol state
  const [symbol,   setSymbol]   = useState('');
  const [exchange, setExchange] = useState('NSE');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry,     setExpiry]     = useState('');

  // UI state
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [spot,    setSpot]    = useState(0);
  const [atmStrike, setAtmStrike] = useState(0);
  const [atmIv,   setAtmIv]   = useState(0);
  const [showPcr, setShowPcr] = useState(false);
  const [pcr,     setPcr]     = useState(0);

  // Nubra WS for live IV — now via shared singleton
  const subRefIdsRef  = useRef<number[]>([]);
  const nubraCbRef    = useRef<NubraCallback | null>(null);
  const latestIvRef   = useRef<Map<number, number>>(new Map()); // refId → iv
  const liveBarRef    = useRef<LineData | null>(null);           // live IV bar
  // track current load params so spot WS can reconnect on ATM strike change
  const liveSymRef    = useRef('');
  const liveExchRef   = useRef('');
  const liveExpRef    = useRef('');
  const liveAtmRef    = useRef(0); // last connected ATM strike
  const connectNubraWsRef = useRef<typeof connectNubraWs | null>(null);

  // Live spot candlestick bar (mirrors CandleChart's liveBarRef)
  const spotLiveBarRef   = useRef<CandlestickData | null>(null);
  const restLoadingRef   = useRef(false);
  const sessionRef       = useRef(0);

  // Upstox WS unsubscribe fn
  const spotUnsubRef  = useRef<(() => void) | null>(null);
  const spotKeyRef    = useRef<string | null>(null);
  // Original Upstox symbol (for spot key lookup) — separate from nubra symbol
  const upstoxSymRef  = useRef<string>('');
  const nubraTypeRef  = useRef<'INDEX' | 'STOCK'>('INDEX');

  // Spot historical data refs (mirrors CandleChart pattern)
  const allSpotRef          = useRef<CandlestickData[]>([]);
  const spotPrevTsRef       = useRef<number | null>(null);
  const isLoadingMoreRef    = useRef(false);
  const loadLockRef         = useRef(false);
  const spotInstrKeyRef     = useRef<string>('');
  const pcrPollRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialZoomDoneRef  = useRef(false); // reset on each symbol load

  // ── Init chart ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#131110' },
        textColor: '#C3CAD6',
        fontSize: 12,
        fontFamily: "'Work Sans', 'Segoe UI', Arial, sans-serif",
      },
      grid: { vertLines: { color: '#1e1c1a' }, horzLines: { color: '#1e1c1a' } },
      crosshair: { mode: 0 },
      leftPriceScale:  { visible: true, borderColor: '#2a2a2a', scaleMargins: { top: 0.06, bottom: 0.06 } },
      rightPriceScale: { visible: true, borderColor: '#2a2a2a', scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: {
        borderColor: '#2a2a2a', timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (ts: number) => {
          const d = new Date(ts * 1000 + 5.5 * 3600 * 1000);
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mm = String(d.getUTCMinutes()).padStart(2, '0');
          const dd = d.getUTCDate();
          const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
          return mm === '00' && hh === '09' ? `${dd} ${mon}` : `${hh}:${mm}`;
        },
      },
      localization: {
        timeFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
          }),
      },
    });
    chartRef.current = chart;

    // IV series — LEFT axis, orange
    const ivSeries = chart.addSeries(LineSeries, {
      color: '#f97316',
      lineWidth: 2,
      title: 'ATM IV %',
      priceScaleId: 'left',
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (v: number) => `${v.toFixed(2)}%` },
    });
    ivSeriesRef.current = ivSeries;

    // PCR series — dedicated left scale (separate from IV%)
    const pcrSeries = chart.addSeries(LineSeries, {
      color: '#a78bfa',
      lineWidth: 1,
      title: 'PCR',
      priceScaleId: 'pcr',
      priceFormat: { type: 'custom', minMove: 0.001, formatter: (v: number) => v.toFixed(3) },
      visible: false,
    });
    chart.priceScale('pcr').applyOptions({
      visible: false,
      borderColor: '#2a2a2a',
      scaleMargins: { top: 0.06, bottom: 0.06 },
    });
    pcrSeriesRef.current = pcrSeries;

    // Spot series — RIGHT axis, candlestick
    const spotSeries = chart.addSeries(CandlestickSeries, {
      upColor:   '#26a69a',
      downColor: '#ef5350',
      borderUpColor:   '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor:   '#26a69a',
      wickDownColor: '#ef5350',
      title: 'Spot',
      priceScaleId: 'right',
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });
    spotSeriesRef.current = spotSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      ivSeriesRef.current = null;
      pcrSeriesRef.current = null;
      spotSeriesRef.current = null;
    };
  }, []);

  // ── Zoom to last N candles right-anchored (mirrors CandleChart exactly) ─────
  const zoomToEnd = useCallback((data: CandlestickData[]) => {
    if (initialZoomDoneRef.current) return;
    if (data.length === 0) return;
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    initialZoomDoneRef.current = true;
    const visible = Math.min(120, data.length);
    const containerWidth = containerRef.current?.clientWidth ?? 800;
    const spacing = Math.max(4, Math.floor(containerWidth / visible));
    ts.applyOptions({ barSpacing: spacing, rightOffset: 8 });
    ts.scrollToRealTime();
    // After paint settles — fit Y axis (same as double-click)
    setTimeout(() => {
      try {
        const ps = chartRef.current?.priceScale('right');
        ps?.applyOptions({ autoScale: false });
        ps?.applyOptions({ autoScale: true });
        const psL = chartRef.current?.priceScale('left');
        psL?.applyOptions({ autoScale: false });
        psL?.applyOptions({ autoScale: true });
      } catch { /**/ }
    }, 50);
  }, []);

  // ── Disconnect Nubra WS ───────────────────────────────────────────────────
  const disconnectNubraWs = useCallback(() => {
    if (nubraCbRef.current && subRefIdsRef.current.length > 0) {
      nubraWsSingleton.unsubscribe(subRefIdsRef.current, nubraCbRef.current);
    }
    nubraCbRef.current = null;
    subRefIdsRef.current = [];
    latestIvRef.current.clear();
    liveBarRef.current = null;
  }, []);

  // ── Disconnect Upstox spot WS ─────────────────────────────────────────────
  const disconnectSpot = useCallback(() => {
    spotUnsubRef.current?.();
    spotUnsubRef.current = null;
    if (spotKeyRef.current) {
      wsManager.releaseKeys([spotKeyRef.current]);
      spotKeyRef.current = null;
    }
  }, []);

  // ── Connect Nubra WS for live ATM IV — uses shared singleton ────────────
  const connectNubraWs = useCallback((sym: string, exch: string, exp: string, atmStr: number) => {
    disconnectNubraWs();
    const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
    if (!sessionToken || !sym || !exp || atmStr <= 0) return;

    const strikePaise = Math.round(atmStr * 100);
    const upper = sym.toUpperCase();
    const expiryMs = expiryToMs(exp);

    const matchSym = (i: NubraInstrument) =>
      i.asset?.toUpperCase() === upper ||
      i.nubra_name?.toUpperCase() === upper ||
      i.stock_name?.toUpperCase().startsWith(upper);

    const matchExpiry = (i: NubraInstrument) =>
      expiryMs > 0 && i.expiry ? expiryToMs(String(i.expiry)) === expiryMs : String(i.expiry) === exp;

    const ce = nubraInstruments.find(i =>
      i.option_type === 'CE' && matchExpiry(i) &&
      Math.abs((i.strike_price ?? 0) - strikePaise) < 2 && matchSym(i)
    );
    const pe = nubraInstruments.find(i =>
      i.option_type === 'PE' && matchExpiry(i) &&
      Math.abs((i.strike_price ?? 0) - strikePaise) < 2 && matchSym(i)
    );

    if (!ce || !pe) return;

    const ceId = Number(ce.ref_id);
    const peId = Number(pe.ref_id);
    subRefIdsRef.current = [ceId, peId];
    latestIvRef.current.clear();

    const cb: NubraCallback = (refId, iv) => {
      latestIvRef.current.set(refId, iv);
      if (latestIvRef.current.size >= 2) {
        const vals = [...latestIvRef.current.values()];
        const avgIv = vals.reduce((a, b) => a + b, 0) / vals.length;
        setAtmIv(avgIv);
        const nowBarSec = snapToMinBar(Date.now()) as unknown as Time;
        const pt: LineData = { time: nowBarSec, value: avgIv };
        liveBarRef.current = pt;
        try { ivSeriesRef.current?.update(pt); } catch { /**/ }
      }
    };

    nubraCbRef.current = cb;
    nubraWsSingleton.subscribe([ceId, peId], cb, exch);
  }, [nubraInstruments, disconnectNubraWs]);

  // ── Connect Upstox WS for live spot candlestick (mirrors CandleChart exactly)
  // keep ref updated so the spot WS closure always calls the latest version
  useEffect(() => { connectNubraWsRef.current = connectNubraWs; }, [connectNubraWs]);

  const connectSpot = useCallback((
    sym: string,
    _exch: string,
    onFirstSpot?: (ltp: number) => void,
  ) => {
    disconnectSpot();
    const key = getSpotInstrumentKey(sym, instruments);
    if (!key) return;
    spotKeyRef.current = key;
    wsManager.requestKeys([key]);

    let firstFired = false;
    const mySession = sessionRef.current;

    const unsub = wsManager.subscribe(key, (md: InstrumentMarketData) => {
      if (restLoadingRef.current) return; // still loading REST data — discard
      const candleSeries = spotSeriesRef.current;
      if (!candleSeries) return;

      const ltp = md.ltp ?? 0;
      if (!ltp) return;
      setSpot(ltp);

      if (!firstFired && onFirstSpot) { firstFired = true; onFirstSpot(ltp); }

      // Reconnect Nubra WS if ATM strike has changed
      if (liveSymRef.current && liveExpRef.current) {
        const newAtm = calcATMStrike(ltp, nubraInstruments, liveSymRef.current, liveExpRef.current);
        if (newAtm > 0 && newAtm !== liveAtmRef.current) {
          liveAtmRef.current = newAtm;
          setAtmStrike(newAtm);
          connectNubraWsRef.current?.(liveSymRef.current, liveExchRef.current, liveExpRef.current, newAtm);
        }
      }

      const wallBarSec = snapToMinBar(Date.now()) as Time;

      // Try OHLC from WS for I1 interval
      const ohlcEntry = md.ohlc?.find((o: { interval: string }) => o.interval === 'I1');
      const ohlcBarSec = ohlcEntry && Number(ohlcEntry.ts) > 0
        ? Math.floor(Number(ohlcEntry.ts) / 1000) : null;
      const useOhlc = ohlcEntry != null && ohlcBarSec === Number(wallBarSec);

      // Don't push a live bar that's older than the last confirmed REST bar
      const lastRestTime = allSpotRef.current.length > 0
        ? Number((allSpotRef.current[allSpotRef.current.length - 1] as CandlestickData).time) : 0;
      // Allow current bar (wallBarSec >= lastRestTime) — equality means we're updating the same bar
      if (Number(wallBarSec) < lastRestTime) return;

      const prev = spotLiveBarRef.current;
      if (prev && Number(prev.time) === Number(wallBarSec)) {
        // Same bar — update
        const updated: CandlestickData = useOhlc
          ? { time: wallBarSec, open: ohlcEntry!.open || prev.open, high: ohlcEntry!.high || Math.max(prev.high, ltp), low: ohlcEntry!.low || Math.min(prev.low, ltp), close: ltp }
          : { time: wallBarSec, open: prev.open, high: Math.max(prev.high, ltp), low: Math.min(prev.low, ltp), close: ltp };
        spotLiveBarRef.current = updated;
        try { candleSeries.update(updated); } catch { /**/ }
      } else {
        // New bar — commit old live bar to allSpotRef history
        if (prev) {
          const existingIdx = allSpotRef.current.findIndex(c => Number((c as CandlestickData).time) === Number(prev.time));
          if (existingIdx >= 0) allSpotRef.current[existingIdx] = prev;
          else allSpotRef.current = [...allSpotRef.current, prev];
        }
        const newOpen = useOhlc ? ohlcEntry!.open : (prev ? prev.close : ltp);
        const newBar: CandlestickData = useOhlc
          ? { time: wallBarSec, open: ohlcEntry!.open || newOpen, high: ohlcEntry!.high || Math.max(newOpen, ltp), low: ohlcEntry!.low || Math.min(newOpen, ltp), close: ltp }
          : { time: wallBarSec, open: newOpen, high: Math.max(newOpen, ltp), low: Math.min(newOpen, ltp), close: ltp };
        spotLiveBarRef.current = newBar;
        try { candleSeries.update(newBar); } catch { /**/ }
      }
    });
    void mySession;
    spotUnsubRef.current = unsub;
  }, [instruments, disconnectSpot]);

  // ── PCR 1-min poller — stops after 15:30 IST ─────────────────────────────
  const pcrSymRef   = useRef('');
  const pcrExchRef  = useRef('');
  const pcrExpRef   = useRef(0);
  const pcrTypeRef  = useRef<'INDEX' | 'STOCK'>('INDEX');

  const stopPcrPoller = useCallback(() => {
    if (pcrPollRef.current) { clearInterval(pcrPollRef.current); pcrPollRef.current = null; }
  }, []);

  const startPcrPoller = useCallback((sym: string, exch: string, expiryMs: number, instrType: 'INDEX' | 'STOCK') => {
    stopPcrPoller();
    pcrSymRef.current  = sym;
    pcrExchRef.current = exch;
    pcrExpRef.current  = expiryMs;
    pcrTypeRef.current = instrType;

    const poll = async () => {
      const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
      const istMins = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
      if (istMins >= 15 * 60 + 30) { stopPcrPoller(); return; }
      const today = lastTradingDay();
      const data = await fetchPcrChart(pcrSymRef.current, pcrExchRef.current, pcrExpRef.current, today, pcrTypeRef.current).catch(() => []);
      if (data.length) {
        pcrSeriesRef.current?.setData(data);
        const last = data[data.length - 1];
        if (last) setPcr(last.value);
      }
    };

    pcrPollRef.current = setInterval(poll, 60_000);
  }, [stopPcrPoller]);

  // ── Load historical data and connect WS ───────────────────────────────────
  // upstoxSym = original Upstox trading_symbol for spot key; sym = nubra symbol for IV fetch
  const load = useCallback(async (sym: string, exch: string, exp: string, upstoxSym?: string, instrType: 'INDEX' | 'STOCK' = 'INDEX') => {
    if (!sym) return;
    const spotOnly = !exp || exp === '__spot_only__';
    setLoading(true);
    setError('');

    const expiryMs = expiryToMs(exp);
    const today = lastTradingDay();
    const spotSym = upstoxSym || upstoxSymRef.current || sym;

    // Reset spot data refs — keep spotInstrKeyRef as-is (set by handleSymbolSelect just before load)
    allSpotRef.current = [];
    spotPrevTsRef.current = null;
    initialZoomDoneRef.current = false;

    // Store load params so spot WS can reconnect Nubra when ATM strike shifts
    liveSymRef.current  = sym;
    liveExchRef.current = exch;
    liveExpRef.current  = exp;
    liveAtmRef.current  = 0; // force reconnect on first tick

    // New session — stale WS ticks for old symbol are discarded
    const mySession = ++sessionRef.current;
    restLoadingRef.current = true;
    spotLiveBarRef.current = null;

    // Clear chart series
    ivSeriesRef.current?.setData([]);
    pcrSeriesRef.current?.setData([]);
    spotSeriesRef.current?.setData([]);
    liveBarRef.current = null;
    latestIvRef.current.clear();
    setPcr(0);

    try {
      // Use pre-stored key (set by handleSymbolSelect for INDEX rows) or resolve from sym
      const spotKey = spotInstrKeyRef.current || getSpotInstrumentKey(spotSym, instruments) || '';
      spotInstrKeyRef.current = spotKey;

      // ── Fetch spot historical candles ────────────────────────────────────
      if (spotKey) {
        // Start from today EOD — keep fetching pages until we have today's candles
        const d = new Date(); d.setHours(23, 59, 59, 999);
        let res = await fetchRawCandles(spotKey, d.getTime());

        // If first page is empty or has no today candles, keep fetching back
        let allCandles = [...res.candles];
        let prevTs = res.prevTimestamp;

        // Fetch up to 3 pages to ensure we cover today's full session
        for (let i = 0; i < 2 && prevTs && allCandles.length < 375; i++) {
          const more = await fetchRawCandles(spotKey, prevTs);
          allCandles = [...more.candles, ...allCandles];
          prevTs = more.prevTimestamp;
        }

        if (mySession !== sessionRef.current) return;
        spotPrevTsRef.current = prevTs;

        // Dedup + sort oldest-first
        const seen = new Set<number>();
        const deduped = allCandles
          .filter(c => { if (seen.has(c[0])) return false; seen.add(c[0]); return true; })
          .sort((a, b) => a[0] - b[0]);

        const spotData = candlesToCandleData(deduped);

        // Pop the currently-forming bar — WS will keep it live.
        // Use >= not === : if the REST fetch straddles a minute boundary,
        // wallBarSec may have advanced past the last bar's timestamp, causing
        // the completed bar to stay in the series while WS writes the next one —
        // that's what produces the 1-bar gap (e.g. 13:45 present, 13:46 missing).
        // Popping any bar whose time >= wallBarSec lets WS own the live bar
        // regardless of the small timing drift.
        const wallBarSec = snapToMinBar(Date.now());
        if (spotData.length > 0 && Number(spotData[spotData.length - 1].time) >= wallBarSec) {
          const forming = spotData.pop()!;
          spotLiveBarRef.current = forming;
        }

        allSpotRef.current = spotData;
        spotSeriesRef.current?.setData(spotData);
        if (spotLiveBarRef.current) {
          try { spotSeriesRef.current?.update(spotLiveBarRef.current); } catch { /**/ }
        }
        const lastClose = spotLiveBarRef.current?.close ?? spotData[spotData.length - 1]?.close ?? 0;
        if (lastClose > 0) setSpot(lastClose);

        // Zoom + fit Y axis exactly like CandleChart
        const zoomData = spotLiveBarRef.current ? [...spotData, spotLiveBarRef.current] : spotData;
        requestAnimationFrame(() => zoomToEnd(zoomData));
      }

      restLoadingRef.current = false;

      // ── Fetch ATM IV + PCR historical from Nubra (skip for MCX/spot-only) ──
      if (!spotOnly) {
        const [ivData, pcrData] = await Promise.all([
          fetchAtmIvChart(sym, exch, expiryMs, today, instrType),
          fetchPcrChart(sym, exch, expiryMs, today, instrType),
        ]);
        if (mySession !== sessionRef.current) return;
        if (ivData.length) {
          // Merge IV data with live bar — drop any REST point that overlaps live bar time
          const liveTime = liveBarRef.current ? Number((liveBarRef.current as LineData).time) : 0;
          const filtered = liveTime > 0 ? sortDedup(ivData).filter(p => Number(p.time) < liveTime) : sortDedup(ivData);
          ivSeriesRef.current?.setData(filtered);
          // Re-apply live IV bar on top so there's no gap
          if (liveBarRef.current) {
            try { ivSeriesRef.current?.update(liveBarRef.current); } catch { /**/ }
          }
          const last = filtered[filtered.length - 1] ?? ivData[ivData.length - 1];
          if (last) setAtmIv(last.value);
        }
        if (pcrData.length) {
          pcrSeriesRef.current?.setData(pcrData);
          const last = pcrData[pcrData.length - 1];
          if (last) setPcr(last.value);
        }
        // Start 1-min poller only during market hours
        const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
        const istMins = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
        if (istMins >= 9 * 60 + 15 && istMins < 15 * 60 + 30) {
          startPcrPoller(sym, exch, expiryMs, instrType);
        }
      }

      // ── Connect live spot WS ──────────────────────────────────────────────
      connectSpot(spotSym, exch, spotOnly ? undefined : (ltp: number) => {
        const atmStr = calcATMStrike(ltp, nubraInstruments, sym, exp);
        setAtmStrike(atmStr);
        if (atmStr > 0) connectNubraWs(sym, exch, exp, atmStr);
      });

      // ── Also connect Nubra WS immediately using already-known spot price ──
      // Don't wait for first WS tick — use last close from REST data
      if (!spotOnly) {
        const knownSpot = spotLiveBarRef.current?.close
          ?? allSpotRef.current[allSpotRef.current.length - 1]?.close
          ?? 0;
        if (knownSpot > 0) {
          const atmStr = calcATMStrike(knownSpot, nubraInstruments, sym, exp);
          setAtmStrike(atmStr);
          if (atmStr > 0) connectNubraWs(sym, exch, exp, atmStr);
        }
      }
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
      restLoadingRef.current = false;
    } finally {
      setLoading(false);
    }
  }, [instruments, nubraInstruments, connectSpot, connectNubraWs, startPcrPoller, zoomToEnd]);

  // ── Load more spot candles when user scrolls left ─────────────────────────
  const loadMoreSpot = useCallback(async () => {
    if (isLoadingMoreRef.current || loadLockRef.current) return;
    if (!spotPrevTsRef.current || !spotInstrKeyRef.current) return;
    if (!spotSeriesRef.current) return;

    isLoadingMoreRef.current = true;
    loadLockRef.current = true;

    const ts = chartRef.current?.timeScale();

    try {
      const { candles, prevTimestamp } = await fetchRawCandles(
        spotInstrKeyRef.current,
        spotPrevTsRef.current,
      );
      spotPrevTsRef.current = prevTimestamp;

      if (candles.length > 0) {
        const existingTimes = new Set(allSpotRef.current.map(p => Number(p.time) * 1000));
        const sorted = [...candles].sort((a, b) => a[0] - b[0]);
        const unique = sorted.filter((c, i) =>
          (i === 0 || c[0] !== sorted[i - 1][0]) && !existingTimes.has(c[0])
        );
        if (unique.length > 0) {
          const older = candlesToCandleData(unique);
          allSpotRef.current = [...older, ...allSpotRef.current];

          // Snapshot range BEFORE setData to restore exactly — no flicker
          const rangeBefore = ts?.getVisibleLogicalRange();
          const ps = chartRef.current?.priceScale('right');
          ps?.applyOptions({ autoScale: false });

          spotSeriesRef.current.setData(allSpotRef.current);

          // Re-apply live bar on top
          if (liveBarRef.current) {
            try { spotSeriesRef.current.update(liveBarRef.current); } catch { /**/ }
          }

          // Restore viewport shifted by prepended bars — zero drift, no flicker
          if (ts && rangeBefore) {
            ts.setVisibleLogicalRange({
              from: rangeBefore.from + unique.length,
              to:   rangeBefore.to   + unique.length,
            });
          }
          requestAnimationFrame(() => { ps?.applyOptions({ autoScale: true }); });
        }
      }
    } catch { /**/ } finally {
      isLoadingMoreRef.current = false;
      setTimeout(() => { loadLockRef.current = false; }, 400);
    }
  }, []);

  // ── Subscribe to scroll-left to trigger loadMoreSpot ─────────────────────
  useEffect(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const handler = (range: LogicalRange | null) => {
      if (!range) return;
      if (loadLockRef.current || !spotPrevTsRef.current) return;
      const barsInfo = spotSeriesRef.current?.barsInLogicalRange(range);
      if (barsInfo && barsInfo.barsBefore < 20) loadMoreSpot();
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
  }, [loadMoreSpot]);

  // Re-compute ATM strike + reconnect Nubra WS when spot updates
  const prevAtmStrikeRef = useRef(0);
  useEffect(() => {
    if (!symbol || !expiry || spot <= 0) return;
    const atmStr = calcATMStrike(spot, nubraInstruments, symbol, expiry);
    if (atmStr === prevAtmStrikeRef.current) return;
    prevAtmStrikeRef.current = atmStr;
    setAtmStrike(atmStr);
    connectNubraWs(symbol, exchange, expiry, atmStr);
  }, [spot, symbol, exchange, expiry, nubraInstruments, connectNubraWs]);

  // Feed search worker with instruments
  const workerFedRef = useRef(false);
  useEffect(() => {
    if (workerFedRef.current || instruments.length === 0) return;
    // Workers are per-SymbolSearchBar instance — fed internally
    workerFedRef.current = true;
  }, [instruments]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      disconnectNubraWs();
      disconnectSpot();
      stopPcrPoller();
    };
  }, [disconnectNubraWs, disconnectSpot, stopPcrPoller]);

  // ── Symbol selected ───────────────────────────────────────────────────────
  const handleSymbolSelect = useCallback((ins: Instrument) => {
    // upstoxSym: for spot candle/WS key lookup (use trading_symbol of the INDEX row directly)
    const upstoxSym = ins.instrument_type === 'INDEX' || ins.segment?.includes('INDEX')
      ? ins.trading_symbol
      : (ins.underlying_symbol || ins.trading_symbol);
    upstoxSymRef.current = upstoxSym;

    // Always reset the key first, then set it for INDEX/FUT rows
    spotInstrKeyRef.current = '';
    if (ins.instrument_type === 'INDEX' || ins.segment?.includes('INDEX') || ins.instrument_type === 'FUT') {
      spotInstrKeyRef.current = ins.instrument_key;
    }

    // nubraSym: search nubraInstruments by underlying_symbol or trading_symbol
    const searchSym = ins.underlying_symbol || ins.trading_symbol;
    const { nubraSym, exchange: nubraExch, nubraType: resolvedType } = resolveNubra(searchSym, nubraInstruments);
    nubraTypeRef.current = resolvedType;
    const exps = getExpiries(nubraSym, nubraInstruments, resolvedType, nubraExch, instruments);
    setSymbol(nubraSym);
    setExchange(nubraExch);
    setExpiries(exps);
    const firstExp = exps[0] ?? '';
    setExpiry(firstExp);
    setSpot(0);
    setAtmStrike(0);
    setAtmIv(0);
    disconnectNubraWs();
    disconnectSpot();
    stopPcrPoller();
    // For MCX/commodity with no nubra expiries, still load spot chart with empty exp
    load(nubraSym, nubraExch, firstExp || '__spot_only__', upstoxSym, resolvedType);
  }, [nubraInstruments, load, disconnectNubraWs, disconnectSpot]);

  // ── Auto-load initialSymbol on mount ─────────────────────────────────────
  const initialSymbolLoadedRef = useRef(false);
  useEffect(() => {
    if (!initialSymbol || initialSymbolLoadedRef.current || instruments.length === 0 || nubraInstruments.length === 0) return;
    // Resolve via nubraInstruments first to get the exact asset name (avoids matching NIFTY 100 for "NIFTY")
    const { nubraSym } = resolveNubra(initialSymbol, nubraInstruments);
    const norm = nubraSym.toUpperCase();
    // Find the exact upstox INDEX instrument matching the resolved nubra symbol
    const ins = instruments.find(i =>
      (i.instrument_type === 'INDEX' || i.segment?.includes('INDEX')) &&
      (i.trading_symbol?.toUpperCase() === norm ||
       i.underlying_symbol?.toUpperCase() === norm ||
       i.name?.toUpperCase() === norm)
    ) ?? instruments.find(i =>
      i.trading_symbol?.toUpperCase() === norm || i.underlying_symbol?.toUpperCase() === norm
    );
    if (!ins) return;
    initialSymbolLoadedRef.current = true;
    handleSymbolSelect(ins);
  }, [initialSymbol, instruments, nubraInstruments, handleSymbolSelect]);

  const handleExpiryChange = useCallback((exp: string) => {
    setExpiry(exp);
    if (!symbol) return;
    // For MCX FUT: resolve the correct instrument key for this expiry
    const upper = upstoxSymRef.current.toUpperCase();
    const futKey = instruments.find(i => {
      if (i.instrument_type !== 'FUT') return false;
      const matchSym = i.underlying_symbol?.toUpperCase() === upper || i.trading_symbol?.toUpperCase().startsWith(upper);
      if (!matchSym) return false;
      const d = new Date(i.expiry as number);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${yyyy}${mm}${dd}` === exp;
    })?.instrument_key;
    if (futKey) spotInstrKeyRef.current = futKey;
    load(symbol, exchange, exp, upstoxSymRef.current, nubraTypeRef.current);
  }, [symbol, exchange, instruments, load]);

  // Feed instruments into search worker (via SymbolSearchBar, which builds its own worker)
  // We pass instruments as a prop to SymbolSearchBar via context-free approach:
  // The worker is initialized inside SymbolSearchBar, fed via useEffect below
  const searchBarInstrumentsRef = useRef(instruments);
  searchBarInstrumentsRef.current = instruments;

  return (
    <div className={s.root}>
      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          <SymbolSearchBarWithFeed instruments={instruments} onSelect={handleSymbolSelect} externalWorkerRef={workerRef} />

          {expiries.length > 0 && (
            <select
              className={s.expirySelect}
              value={expiry}
              onChange={e => handleExpiryChange(e.target.value)}
            >
              {expiries.map(exp => (
                <option key={exp} value={exp}>{formatExpiry(exp)}</option>
              ))}
            </select>
          )}
          {symbol && !showPcr && (
            <button
              className={s.pcrBtn}
              onClick={() => { setShowPcr(true); pcrSeriesRef.current?.applyOptions({ visible: true }); chartRef.current?.priceScale('pcr').applyOptions({ visible: true }); }}
            >PCR</button>
          )}
          {symbol && showPcr && (
            <button
              className={`${s.pcrBtn} ${s.pcrBtnActive}`}
              onClick={() => { setShowPcr(false); pcrSeriesRef.current?.applyOptions({ visible: false }); chartRef.current?.priceScale('pcr').applyOptions({ visible: false }); }}
            >PCR</button>
          )}
        </div>

        <div className={s.toolbarRight}>
          {symbol && (
            <>
              {spot > 0 && (
                <span className={s.statChip}>
                  <span className={s.statLabel}>Spot</span>
                  <span className={s.statValue}>{spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </span>
              )}
              {atmStrike > 0 && (
                <span className={s.statChip}>
                  <span className={s.statLabel}>ATM</span>
                  <span className={s.statValue}>{atmStrike}</span>
                </span>
              )}
              {atmIv > 0 && (
                <span className={`${s.statChip} ${s.ivChip}`}>
                  <span className={s.statLabel}>ATM IV</span>
                  <span className={s.statValue}>{atmIv.toFixed(2)}%</span>
                </span>
              )}
              {showPcr && pcr > 0 && (
                <span className={`${s.statChip} ${s.pcrChip}`}>
                  <span className={s.statLabel}>PCR</span>
                  <span className={s.statValue}>{pcr.toFixed(3)}</span>
                </span>
              )}
            </>
          )}
          {loading && <span className={s.loadingDot} />}
          {error && <span className={s.errorLabel} title={error}>ERR</span>}
        </div>
      </div>

      {/* ── Chart container ── */}
      <div className={s.chartWrap}>
        {!symbol && (
          <div className={s.placeholder}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 12 C6 6 10 18 14 10 18 4 21 8"/>
              <path d="M3 20h18" />
            </svg>
            <span>Search a symbol to load ATM IV chart</span>
          </div>
        )}
        <div ref={containerRef} className={s.chart} />
      </div>
    </div>
  );
}

// ── SymbolSearchBar with instrument feed ──────────────────────────────────────
// When externalWorkerRef is provided (shared from HomeWorkspace), reuses it — no extra worker spawn.
function SymbolSearchBarWithFeed({
  instruments,
  onSelect,
  externalWorkerRef,
}: {
  instruments: Instrument[];
  onSelect: (ins: Instrument) => void;
  externalWorkerRef?: React.RefObject<Worker | null>;
}) {
  const ownWorkerRef = useRef<Worker | null>(null);
  const workerRef = externalWorkerRef ?? ownWorkerRef;
  // Unique ID for this instance — ensures shared-worker responses only apply to the sender
  const instanceId = useRef(`ivc-${Math.random().toString(36).slice(2)}`);
  const lastReqId  = useRef<string>('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Instrument[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only create an own worker when no external one is provided
  useEffect(() => {
    if (externalWorkerRef) return;
    const w = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    ownWorkerRef.current = w;
    if (instruments.length > 0) {
      w.postMessage({ type: 'BUILD', instruments });
    }
    return () => { w.terminate(); ownWorkerRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed own worker when instruments load (external worker is already fed by HomeWorkspace)
  useEffect(() => {
    if (externalWorkerRef) return;
    if (ownWorkerRef.current && instruments.length > 0) {
      ownWorkerRef.current.postMessage({ type: 'BUILD', instruments });
    }
  }, [instruments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for RESULTS — only apply if reqId matches this instance's last request
  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    const handler = (e: MessageEvent) => {
      if (e.data.type === 'RESULTS' && e.data.reqId === lastReqId.current) {
        const res = e.data.results ?? [];
        setResults(res);
        setCursor(0);
        setOpen(res.length > 0);
      }
    };
    w.addEventListener('message', handler);
    return () => w.removeEventListener('message', handler);
  }, [workerRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInput = (v: string) => {
    setQuery(v);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      const reqId = `${instanceId.current}-${Date.now()}`;
      lastReqId.current = reqId;
      workerRef.current?.postMessage({ type: 'SEARCH', query: v, reqId });
    }, 100);
  };

  const select = (ins: Instrument) => {
    const sym = ins.underlying_symbol || ins.trading_symbol || ins.name || '';
    setQuery(sym);
    setOpen(false);
    onSelect(ins);
  };

  return (
    <div ref={wrapRef} className={s.searchWrap}>
      <div className={s.searchBox}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          className={s.searchInput}
          value={query}
          placeholder="Search symbol… (NIFTY, BANKNIFTY, RELIANCE)"
          onChange={e => handleInput(e.target.value)}
          onFocus={() => { if (query.trim()) { const reqId = `${instanceId.current}-${Date.now()}`; lastReqId.current = reqId; workerRef.current?.postMessage({ type: 'SEARCH', query, reqId }); } }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
            else if (e.key === 'Enter' && results.length > 0) select(results[cursor]);
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {query && (
          <button className={s.clearBtn} onMouseDown={() => { setQuery(''); setOpen(false); setResults([]); }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div
          className={s.dropdown}
          onMouseDown={e => e.preventDefault()}
        >
          <div className={s.dropdownList}>
            {results.slice(0, 50).map((ins, i) => (
              <div
                key={ins.instrument_key}
                className={`${s.dropdownItem} ${i === cursor ? s.dropdownItemActive : ''}`}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={() => select(ins)}
              >
                <span className={s.dropdownExch}>{(ins.exchange ?? '').replace('_INDEX','').replace('_FO','')}</span>
                <span className={s.dropdownSym}>{ins.trading_symbol}</span>
                <span className={s.dropdownType}>{ins.instrument_type}</span>
              </div>
            ))}
          </div>
          <div className={s.dropdownFooter}>
            <span><kbd>↵</kbd> select</span><span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatExpiry(exp: string): string {
  if (/^\d{8}$/.test(exp)) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${parseInt(exp.slice(6))} ${months[parseInt(exp.slice(4, 6)) - 1]}`;
  }
  return exp;
}
