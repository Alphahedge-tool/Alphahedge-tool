'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as am5 from '@amcharts/amcharts5';
import * as am5xy from '@amcharts/amcharts5/xy';
import type { NubraInstrument } from './useNubraInstruments';

const BRIDGE = 'ws://localhost:8765';
const HIST_BATCH_SIZE = 10;
const HIST_BATCH_PAUSE_MS = 350;
const HIST_SINGLE_PAUSE_MS = 140;

interface Props {
  nubraInstruments: NubraInstrument[];
  initialSymbol?: string;
  sessionToken?: string;
}

interface Suggestion {
  sym: string;
  exchange: string;
}

interface GexRow {
  strike: number;
  ceGamma: number;
  peGamma: number;
  ceOi: number;
  peOi: number;
  lotSize: number;
  callBase: number;  // gamma * oi * lot
  putBase: number;   // -gamma * oi * lot
  netBase: number;
  callGex: number;
  putGex: number;
  netGex: number;
}

interface TrendPoint {
  ts: number;
  callBase: number;
  putBase: number;
  netBase: number;
  callGex: number;
  putGex: number;
  netGex: number;
}

interface SymbolSeries {
  gamma: Map<number, number>;
  oi: Map<number, number>;
}

interface OptionDef {
  symbol: string;
  strike: number;
  side: 'CE' | 'PE';
  lotSize: number;
}

interface NubraAuth {
  sessionToken: string;
  authToken: string;
  deviceId: string;
  rawCookie: string;
}

interface TimeseriesWindow {
  startDate: string;
  endDate: string;
  intraDay: boolean;
  realTime: boolean;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function todayYmdIst() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ── Local market schedule (mirrors IvChart — no API call needed) ──────────────
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

function getLocalMarketSchedule() {
  const istMs = Date.now() + 5.5 * 3600 * 1000;
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

function buildTimeseriesWindow(startDateStr: string, isLive: boolean): TimeseriesWindow {
  return {
    startDate: `${startDateStr}T03:45:00.000Z`,
    endDate: isLive ? new Date().toISOString() : `${startDateStr}T10:00:00.000Z`,
    intraDay: isLive,
    realTime: false,
  };
}

function getTradingWindow(): TimeseriesWindow {
  const { isMarketOpen, tradingDate } = getLocalMarketSchedule();
  return buildTimeseriesWindow(tradingDate, isMarketOpen);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toMinuteTsMs(rawTs: number): number {
  if (!Number.isFinite(rawTs) || rawTs <= 0) return 0;
  const ms = rawTs > 1e15 ? rawTs / 1e6 : rawTs > 1e12 ? rawTs : rawTs * 1000;
  return Math.floor(ms / 60000) * 60000;
}

function fmtNum(n: number, d = 2) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function fmtShort(n: number) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function normalizeSpotValue(raw: number, strikes: number[] = []) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const positiveStrikes = strikes.filter(s => Number.isFinite(s) && s > 0);
  if (!positiveStrikes.length) return raw > 100000 ? raw / 100 : raw;
  const midStrike = positiveStrikes[Math.floor(positiveStrikes.length / 2)];
  const directDiff = Math.abs(raw - midStrike);
  const paiseDiff = Math.abs((raw / 100) - midStrike);
  return paiseDiff < directDiff ? raw / 100 : raw;
}

function normalizeSym(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeExchange(raw: string): string {
  const ex = String(raw || '').toUpperCase();
  if (ex.startsWith('BSE')) return 'BSE';
  if (ex.startsWith('MCX')) return 'MCX';
  return 'NSE';
}

function normalizeExpiryYmd(raw: string | number | null | undefined): string {
  const s = String(raw ?? '').replace(/\D/g, '');
  if (!s) return '';
  if (s.length === 8) return s; // YYYYMMDD
  if (s.length === 6) return `20${s}`; // YYMMDD -> 20YYMMDD
  return '';
}

function buildOptionSymbol(underlying: string, expiryYmd: string, strike: number, side: 'CE' | 'PE'): string | null {
  if (!expiryYmd || expiryYmd.length !== 8) return null;
  const yy = expiryYmd.slice(2, 4);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[parseInt(expiryYmd.slice(4, 6), 10) - 1];
  if (!month) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const strikeTxt = Number.isInteger(strike) ? String(strike) : String(Math.round(strike * 100) / 100).replace('.', '');
  return `${underlying}${yy}${month}${strikeTxt}${side}`;
}

function buildSuggestions(query: string, instruments: NubraInstrument[]): Suggestion[] {
  if (!query) return [];
  const q = query.toUpperCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const i of instruments) {
    if (i.option_type !== 'CE' && i.option_type !== 'PE') continue;
    const sym = i.asset || i.nubra_name || i.stock_name || '';
    if (!sym) continue;
    if (!sym.toUpperCase().includes(q) && !String(i.stock_name ?? '').toUpperCase().includes(q)) continue;
    const key = `${sym}|${i.exchange || 'NSE'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sym, exchange: i.exchange || 'NSE' });
    if (out.length >= 25) break;
  }
  return out;
}

function parseHistoricalValueBlocks(json: any): Map<string, any> {
  const out = new Map<string, any>();
  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
  for (const block of valuesArr) {
    if (!block || typeof block !== 'object') continue;
    for (const [k, v] of Object.entries(block)) out.set(k, v);
  }
  return out;
}

function parseFieldSeries(chartObj: any, field: string): Map<number, number> {
  const map = new Map<number, number>();
  const arr: any[] = chartObj?.[field] ?? [];
  for (const p of arr) {
    const ts = toMinuteTsMs(Number(p?.ts ?? p?.timestamp ?? 0));
    const v = Number(p?.v ?? p?.value ?? 0);
    if (ts > 0 && Number.isFinite(v)) map.set(ts, v);
  }
  return map;
}

async function fetchHistoricalSpotSeries(
  auth: NubraAuth,
  exchange: string,
  symbol: string,
  spotType: 'INDEX' | 'STOCK',
  window: TimeseriesWindow,
): Promise<Map<number, number>> {
  const ex = normalizeExchange(exchange);
  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_token: auth.sessionToken,
        auth_token: auth.authToken,
        device_id: auth.deviceId,
        raw_cookie: auth.rawCookie,
        exchange: ex,
        type: spotType,
        values: [symbol],
        fields: ['close'],
        startDate: window.startDate,
        endDate: window.endDate,
        interval: '1m',
        intraDay: window.intraDay,
        realTime: window.realTime,
      }),
    });
  if (!res.ok) throw new Error(`spot-historical ${res.status}`);
  const json = await res.json();
  const blocks = parseHistoricalValueBlocks(json);
  const chartObj = blocks.get(symbol) ?? [...blocks.values()][0];
  if (!chartObj) return new Map();
  const raw = parseFieldSeries(chartObj, 'close');
  if (!raw.size) return raw;
  const vals = [...raw.values()];
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (mid > 200000) {
    const scaled = new Map<number, number>();
    raw.forEach((v, ts) => scaled.set(ts, v / 100));
    return scaled;
  }
  return raw;
}

async function fetchHistoricalOptionSeriesBatched(
  auth: NubraAuth,
  exchange: string,
  optionSymbols: string[],
  window: TimeseriesWindow,
): Promise<Map<string, SymbolSeries>> {
  const out = new Map<string, SymbolSeries>();
  const batches = chunk(optionSymbols, HIST_BATCH_SIZE);
  const ex = normalizeExchange(exchange);

  const parseAndStore = (json: any, values: string[]) => {
    const blocks = parseHistoricalValueBlocks(json);
    for (const sym of values) {
      const chartObj = blocks.get(sym);
      if (!chartObj) continue;
      out.set(sym, {
        gamma: parseFieldSeries(chartObj, 'gamma'),
        oi: parseFieldSeries(chartObj, 'cumulative_oi'),
      });
    }
  };

  const fetchRawBatch = async (values: string[]) => {
    if (!values.length) return;
    const res = await fetch('/api/nubra-historical', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_token: auth.sessionToken,
        auth_token: auth.authToken,
        device_id: auth.deviceId,
        raw_cookie: auth.rawCookie,
        exchange: ex,
        type: 'OPT',
        values,
        fields: ['gamma', 'cumulative_oi'],
        startDate: window.intraDay ? '' : window.startDate,
        endDate: window.intraDay ? '' : window.endDate,
        interval: '1m',
        intraDay: window.intraDay,
        realTime: window.realTime,
      }),
    });
    const bodyText = await res.text();
    return { status: res.status, ok: res.ok, bodyText };
  };

  const fetchBatchWithRetry = async (values: string[], attempts = 4): Promise<boolean> => {
    let lastStatus: number | null = null;
    let lastBody = '';
    for (let i = 0; i < attempts; i++) {
      const r = await fetchRawBatch(values);
      if (!r) return false;
      if (r.ok) {
        parseAndStore(JSON.parse(r.bodyText || '{}'), values);
        return true;
      }
      lastStatus = r.status;
      lastBody = r.bodyText;

      const lower = r.bodyText.toLowerCase();
      const limitErr = lower.includes('maximum 10 values') || lower.includes('10 values');
      if (limitErr && values.length > 1) {
        const mid = Math.ceil(values.length / 2);
        const a = await fetchBatchWithRetry(values.slice(0, mid), Math.max(2, attempts - 1));
        const b = await fetchBatchWithRetry(values.slice(mid), Math.max(2, attempts - 1));
        return a || b;
      }

      const retryable = [429, 500, 502, 503, 504].includes(r.status);
      if (!retryable || i === attempts - 1) break;
      const retryAfterMatch = r.bodyText.match(/retry[- ]?after["'\s:]+(\d+)/i);
      const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) * 1000 : 0;
      await sleep(Math.max(retryAfterMs, 450 * (2 ** i)) + Math.floor(Math.random() * 160));
    }

    // final fallback: try singles so one blocked key doesn't kill whole batch
    if (lastStatus !== 403 && values.length > 1) {
      let any = false;
      for (const sym of values) {
        await sleep(HIST_SINGLE_PAUSE_MS);
        const rs = await fetchRawBatch([sym]);
        if (rs?.ok) {
          parseAndStore(JSON.parse(rs.bodyText || '{}'), [sym]);
          any = true;
        }
      }
      if (any) return true;
    }

    const err = new Error(lastStatus === 403
      ? 'Historical GEX blocked by Nubra 403'
      : `options batch failed (${lastStatus ?? 0}): ${lastBody.slice(0, 100)}`);
    (err as any).status = lastStatus;
    throw err;
  };

  const failedBatches: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const values = batches[i];
    try {
      await fetchBatchWithRetry(values);
    } catch (e: any) {
      if (e?.status === 403) {
        failedBatches.push(`${i + 1}/${batches.length} (403)`);
        break;
      }
      failedBatches.push(`${i + 1}/${batches.length}`);
    }
    // pacing between batches like ATM loader
    if (i < batches.length - 1) await sleep(HIST_BATCH_PAUSE_MS + Math.floor(Math.random() * 120));
  }

  if (failedBatches.length > 0 && out.size > 0) {
    console.warn('[GammaExposure] historical option batch failures:', failedBatches);
  }

  // Don't hard-fail if at least some symbols were loaded.
  if (out.size === 0 && optionSymbols.length > 0) {
    throw new Error('No historical option series could be loaded');
  }
  return out;
}

function buildOptionDefs(
  nubraInstruments: NubraInstrument[],
  symbol: string,
  exchange: string,
  expiry: string,
): OptionDef[] {
  const sNorm = normalizeSym(symbol);
  const eNorm = exchange.toUpperCase().replace(/_FO|_INDEX/g, '');
  const exNorm = normalizeExpiryYmd(expiry);
  const out: OptionDef[] = [];
  for (const i of nubraInstruments) {
    if (normalizeExpiryYmd(i.expiry) !== exNorm) continue;
    if (i.option_type !== 'CE' && i.option_type !== 'PE') continue;
    const iSym = normalizeSym(i.asset || i.stock_name || i.nubra_name || '');
    const iEx = String(i.exchange || '').toUpperCase().replace(/_FO|_INDEX/g, '');
    if (iSym !== sNorm || (eNorm && iEx && iEx !== eNorm)) continue;
    const strike = Number(i.strike_price ?? 0) / 100;
    const optSym = String(i.stock_name || i.nubra_name || '').trim() || buildOptionSymbol(symbol, exNorm, strike, i.option_type);
    if (!strike || !optSym) continue;
    out.push({
      symbol: optSym,
      strike,
      side: i.option_type,
      lotSize: Number(i.lot_size ?? 1) || 1,
    });
  }
  return out;
}

function resolveSpotType(
  nubraInstruments: NubraInstrument[],
  symbol: string,
  exchange: string,
  expiry: string,
): 'INDEX' | 'STOCK' {
  const sNorm = normalizeSym(symbol);
  const eNorm = exchange.toUpperCase().replace(/_FO|_INDEX/g, '');
  const exNorm = normalizeExpiryYmd(expiry);

  const scoped = nubraInstruments.filter(i => {
    if (i.option_type !== 'CE' && i.option_type !== 'PE') return false;
    if (normalizeExpiryYmd(i.expiry) !== exNorm) return false;
    const iSym = normalizeSym(i.asset || i.stock_name || i.nubra_name || '');
    const iEx = String(i.exchange || '').toUpperCase().replace(/_FO|_INDEX/g, '');
    return iSym === sNorm && (!eNorm || !iEx || iEx === eNorm);
  });

  if (scoped.length > 0) {
    const hasIndexTag = scoped.some(i => String(i.asset_type || '').toUpperCase().includes('INDEX'));
    if (hasIndexTag) return 'INDEX';
    return 'STOCK';
  }

  // Fallback by known major index underlyings.
  const knownIndex = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']);
  return knownIndex.has(symbol.toUpperCase()) ? 'INDEX' : 'STOCK';
}

function buildHistoricalTrend(
  optionDefs: OptionDef[],
  optionSeries: Map<string, SymbolSeries>,
  spotSeries: Map<number, number>,
): TrendPoint[] {
  if (!optionDefs.length) return [];

  const strikes = new Map<number, { ce?: OptionDef; pe?: OptionDef; lotSize: number }>();
  for (const def of optionDefs) {
    const row = strikes.get(def.strike) ?? { lotSize: def.lotSize };
    if (def.side === 'CE') row.ce = def;
    else row.pe = def;
    row.lotSize = def.lotSize || row.lotSize || 1;
    strikes.set(def.strike, row);
  }

  const minuteSet = new Set<number>();
  optionSeries.forEach(ser => {
    ser.gamma.forEach((_, ts) => minuteSet.add(ts));
    ser.oi.forEach((_, ts) => minuteSet.add(ts));
  });
  spotSeries.forEach((_, ts) => minuteSet.add(ts));
  const minutes = [...minuteSet].sort((a, b) => a - b);
  if (!minutes.length) return [];

  const state = new Map<string, { gamma: number; oi: number }>();
  const spotByMinute = new Map<number, number>();
  let lastSpot = 0;
  for (const ts of minutes) {
    const s = spotSeries.get(ts);
    if (s != null && Number.isFinite(s) && s > 0) lastSpot = s;
    if (lastSpot > 0) spotByMinute.set(ts, lastSpot);
  }

  const trend: TrendPoint[] = [];
  for (const ts of minutes) {
    let callBase = 0;
    let putBase = 0;
    let callGex = 0;
    let putGex = 0;
    const spot = spotByMinute.get(ts) ?? 0;
    const s2 = spot > 0 ? spot * spot : 0;

    for (const row of strikes.values()) {
      if (row.ce) {
        const ce = optionSeries.get(row.ce.symbol);
        if (ce) {
          const prev = state.get(row.ce.symbol) ?? { gamma: 0, oi: 0 };
          const g = ce.gamma.get(ts);
          const oi = ce.oi.get(ts);
          if (g != null) prev.gamma = g;
          if (oi != null) prev.oi = oi;
          state.set(row.ce.symbol, prev);
          const base = prev.gamma * prev.oi * row.lotSize;
          callBase += base;
          callGex += base * s2;
        }
      }
      if (row.pe) {
        const pe = optionSeries.get(row.pe.symbol);
        if (pe) {
          const prev = state.get(row.pe.symbol) ?? { gamma: 0, oi: 0 };
          const g = pe.gamma.get(ts);
          const oi = pe.oi.get(ts);
          if (g != null) prev.gamma = g;
          if (oi != null) prev.oi = oi;
          state.set(row.pe.symbol, prev);
          const base = -(prev.gamma * prev.oi * row.lotSize);
          putBase += base;
          putGex += base * s2;
        }
      }
    }

    trend.push({
      ts,
      callBase,
      putBase,
      netBase: callBase + putBase,
      callGex,
      putGex,
      netGex: callGex + putGex,
    });
  }
  return trend;
}

export default function GammaExposure({ nubraInstruments, initialSymbol = 'NIFTY', sessionToken }: Props) {
  const token = sessionToken || (typeof window !== 'undefined' ? localStorage.getItem('nubra_session_token') ?? '' : '');
  const auth = useMemo<NubraAuth>(() => ({
    sessionToken: token,
    authToken: typeof window !== 'undefined' ? localStorage.getItem('nubra_auth_token') ?? '' : '',
    deviceId: typeof window !== 'undefined' ? localStorage.getItem('nubra_device_id') ?? '' : '',
    rawCookie: typeof window !== 'undefined' ? localStorage.getItem('nubra_raw_cookie') ?? '' : '',
  }), [token]);

  const [query, setQuery] = useState(initialSymbol);
  const [showDrop, setShowDrop] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [symbol, setSymbol] = useState(initialSymbol);
  const [exchange, setExchange] = useState('NSE');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [spot, setSpot] = useState(0);
  const [rows, setRows] = useState<GexRow[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [trendLoading, setTrendLoading] = useState(false);
  const [wsLive, setWsLive] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [error, setError] = useState('');
  const [trendError, setTrendError] = useState('');
  const [tradingDate, setTradingDate] = useState('');
  const [gexMode, setGexMode] = useState<'with-spot' | 'without-spot'>('with-spot');
  const [trendScaleDiv, setTrendScaleDiv] = useState(1);
  const [barScaleDiv, setBarScaleDiv] = useState(1);

  const wsRef = useRef<WebSocket | null>(null);
  const trendChartHostRef = useRef<HTMLDivElement | null>(null);
  const trendRootRef = useRef<am5.Root | null>(null);
  const trendXAxisRef = useRef<any>(null);
  const callSeriesRef = useRef<am5xy.LineSeries | null>(null);
  const putSeriesRef = useRef<am5xy.LineSeries | null>(null);
  const netSeriesRef = useRef<am5xy.LineSeries | null>(null);
  const strikeBarHostRef = useRef<HTMLDivElement | null>(null);
  const strikeBarRootRef = useRef<am5.Root | null>(null);
  const strikeXAxisRef = useRef<any>(null);
  const strikeCallSeriesRef = useRef<am5xy.ColumnSeries | null>(null);
  const strikePutSeriesRef = useRef<am5xy.ColumnSeries | null>(null);
  const strikeNetSeriesRef = useRef<am5xy.LineSeries | null>(null);
  const strikeFlipRangeRef = useRef<any>(null);
  const strikeFlipZoneRefs = useRef<any[]>([]);
  const strikeFlipKeyRef = useRef('');
  const strikeDomainKeyRef = useRef('');
  const initialLoadedRef = useRef(false);
  const appendGuardRef = useRef<number>(0);
  const historicalLoadKeyRef = useRef('');
  const rowsRef = useRef<GexRow[]>([]);
  const spotRef = useRef(0);
  const suggestions = useMemo(() => buildSuggestions(query, nubraInstruments), [query, nubraInstruments]);
  const rowInstrumentSig = useMemo(
    () => rows.map(r => `${r.strike}:${r.lotSize || 1}`).join('|'),
    [rows],
  );
  const modeLabel = gexMode === 'with-spot' ? 'With Spot (gamma * OI * lot * spot^2)' : 'Without Spot (gamma * OI * lot)';

  const deriveExpiries = useCallback((sym: string, exch: string) => {
    const today = todayYmdIst();
    const sNorm = normalizeSym(sym);
    const eNorm = exch.toUpperCase().replace(/_FO|_INDEX/g, '');
    const set = new Set<string>();
    for (const i of nubraInstruments) {
      if (i.option_type !== 'CE' && i.option_type !== 'PE') continue;
      const iSym = normalizeSym(i.asset || i.nubra_name || i.stock_name || '');
      const iEx = String(i.exchange || '').toUpperCase().replace(/_FO|_INDEX/g, '');
      if (iSym !== sNorm || (eNorm && iEx && iEx !== eNorm)) continue;
      if (i.expiry && String(i.expiry) >= today) set.add(String(i.expiry));
    }
    return [...set].sort();
  }, [nubraInstruments]);

  const selectSymbol = useCallback((sym: string, exch: string) => {
    const nextExp = deriveExpiries(sym, exch);
    setSymbol(sym);
    setExchange(exch);
    setQuery(sym);
    setExpiries(nextExp);
    setExpiry(nextExp[0] ?? '');
    setShowDrop(false);
    rowsRef.current = [];
    spotRef.current = 0;
    setRows([]);
    setTrend([]);
    setTradingDate('');
    setHistoryReady(false);
    historicalLoadKeyRef.current = '';
    setError('');
  }, [deriveExpiries]);

  useEffect(() => {
    if (initialLoadedRef.current) return;
    if (!nubraInstruments.length) return;
    initialLoadedRef.current = true;
    const found = nubraInstruments.find(i => {
      const s = (i.asset || i.nubra_name || i.stock_name || '').toUpperCase();
      return (i.option_type === 'CE' || i.option_type === 'PE') && s === initialSymbol.toUpperCase();
    });
    selectSymbol(found?.asset || initialSymbol, found?.exchange || 'NSE');
  }, [nubraInstruments, initialSymbol, selectSymbol]);

  const mergeChainToRows = useCallback((ce: any[], pe: any[], spotValue: number, isWs: boolean) => {
    const ceMap = new Map<number, any>();
    const peMap = new Map<number, any>();

    for (const x of ce || []) {
      const strike = isWs ? Number(x.strike_price ?? 0) : Number(x.sp ?? 0) / 100;
      if (strike > 0) ceMap.set(strike, x);
    }
    for (const x of pe || []) {
      const strike = isWs ? Number(x.strike_price ?? 0) : Number(x.sp ?? 0) / 100;
      if (strike > 0) peMap.set(strike, x);
    }

    const strikes = [...new Set([...ceMap.keys(), ...peMap.keys()])].sort((a, b) => a - b);
    const allStrikes = [...new Set([...rowsRef.current.map(r => r.strike), ...strikes])].sort((a, b) => a - b);
    const nextSpot = spotValue > 0 ? normalizeSpotValue(spotValue, allStrikes) : spotRef.current;
    if (!strikes.length) {
      if (isWs) {
        if (nextSpot > 0) {
          spotRef.current = nextSpot;
          setSpot(nextSpot);
        }
        return;
      }
      rowsRef.current = [];
      setRows([]);
      return;
    }

    const buildRow = (
      strike: number,
      prev?: GexRow,
    ): GexRow => {
      const ceRow = ceMap.get(strike);
      const peRow = peMap.get(strike);
      const ceGamma = ceRow ? Number(ceRow.gamma ?? 0) : (prev?.ceGamma ?? 0);
      const peGamma = peRow ? Number(peRow.gamma ?? 0) : (prev?.peGamma ?? 0);
      const ceOi = ceRow ? Number(isWs ? (ceRow.open_interest ?? ceRow.oi ?? 0) : (ceRow.oi ?? 0)) : (prev?.ceOi ?? 0);
      const peOi = peRow ? Number(isWs ? (peRow.open_interest ?? peRow.oi ?? 0) : (peRow.oi ?? 0)) : (prev?.peOi ?? 0);
      const lotSize = Number(ceRow?.lot_size ?? ceRow?.ls ?? peRow?.lot_size ?? peRow?.ls ?? prev?.lotSize ?? 0) || 1;
      const s2 = nextSpot > 0 ? nextSpot * nextSpot : 0;
      const callBase = ceGamma * ceOi * lotSize;
      const putBase = -peGamma * peOi * lotSize;
      const callGex = callBase * s2;
      const putGex = putBase * s2;
      return {
        strike,
        ceGamma,
        peGamma,
        ceOi,
        peOi,
        lotSize,
        callBase,
        putBase,
        netBase: callBase + putBase,
        callGex,
        putGex,
        netGex: callGex + putGex,
      };
    };

    const list = isWs && rowsRef.current.length
      ? allStrikes.map(strike => buildRow(strike, rowsRef.current.find(r => r.strike === strike)))
      : strikes.map(strike => buildRow(strike));

    rowsRef.current = list;
    spotRef.current = nextSpot;
    setRows(list);
    setSpot(nextSpot);
  }, []);

  useEffect(() => {
    if (!symbol || !expiry || !token) return;
    setLoading(true);
    setError('');
    setWsLive(false);
    setHistoryReady(false);

    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/nubra-optionchain?session_token=${encodeURIComponent(token)}&instrument=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}`);
        if (!r.ok) throw new Error(`optionchain ${r.status}`);
        const json = await r.json();
        const chain = json.chain ?? json;
        let cp = normalizeSpotValue(Number(chain.cp ?? chain.current_price ?? 0));
        // Fallback: fetch spot separately if chain didn't include current price
        if (cp <= 0) {
          try {
            const priceRes = await fetch(`/api/nubra-price?session_token=${encodeURIComponent(token)}&symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}`);
            if (priceRes.ok) {
              const priceJson = await priceRes.json();
              cp = normalizeSpotValue(Number(priceJson.price ?? priceJson.current_price ?? priceJson.cp ?? 0));
            }
          } catch {
            // ignore fallback failure — bar chart will show base GEX (no spot scaling)
          }
        }
        if (!cancelled) mergeChainToRows(chain.ce ?? [], chain.pe ?? [], cp, false);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load API snapshot');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [symbol, expiry, exchange, token, mergeChainToRows]);

  useEffect(() => {
    if (!symbol || !expiry || !token) return;
    const ws = new WebSocket(BRIDGE);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        action: 'subscribe',
        session_token: token,
        data_type: 'option',
        symbols: [`${symbol}:${expiry}`],
        exchange,
      }));
    };
    ws.onmessage = evt => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type !== 'option' || !msg.data) return;
        const d = msg.data;
        setWsLive(true);
        mergeChainToRows(d.ce ?? [], d.pe ?? [], Number(d.current_price ?? 0), true);
      } catch {
        // ignore malformed message
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => setWsLive(false);

    return () => {
      try {
        ws.send(JSON.stringify({
          action: 'unsubscribe',
          session_token: token,
          data_type: 'option',
          symbols: [`${symbol}:${expiry}`],
          exchange,
        }));
      } catch {
        // ignore
      }
      ws.close();
      wsRef.current = null;
    };
  }, [symbol, expiry, exchange, token, mergeChainToRows]);

  useEffect(() => {
    if (!symbol || !expiry || !token) return;
    let cancelled = false;
    const mountDelay = setTimeout(() => {
      if (cancelled) return;

    (async () => {
      let liveAfterThisLoad = false;
      let loadedKey = '';
      try {
        let optionDefs = buildOptionDefs(nubraInstruments, symbol, exchange, expiry);
        const baseLoadKey = `${symbol}|${exchange}|${expiry}`;
        loadedKey = optionDefs.length ? baseLoadKey : `${baseLoadKey}|${rowInstrumentSig}`;
        if (historicalLoadKeyRef.current === loadedKey) {
          liveAfterThisLoad = true;
          return;
        }
        // Fallback: derive option names from currently loaded strike table if instrument expiry formats don't match.
        if (!optionDefs.length && rows.length === 0) {
          if (!cancelled) setTrendError('Waiting for option-chain snapshot before historical load...');
          return;
        }
        if (!optionDefs.length && rows.length > 0) {
          const exNorm = normalizeExpiryYmd(expiry);
          const fallback: OptionDef[] = [];
          for (const r of rows) {
            const ce = buildOptionSymbol(symbol, exNorm, r.strike, 'CE');
            const pe = buildOptionSymbol(symbol, exNorm, r.strike, 'PE');
            if (ce) fallback.push({ symbol: ce, strike: r.strike, side: 'CE', lotSize: r.lotSize || 1 });
            if (pe) fallback.push({ symbol: pe, strike: r.strike, side: 'PE', lotSize: r.lotSize || 1 });
          }
          optionDefs = fallback;
        }
        if (!optionDefs.length) throw new Error('Intraday trend unavailable: could not resolve CE/PE instruments for this expiry');

        setTrend([]);
        setTradingDate('');
        setHistoryReady(false);
        setTrendLoading(true);
        setTrendError('');

        const optionSymbols = [...new Set(optionDefs.map(d => d.symbol))];
        const window = getTradingWindow();
        if (!cancelled) setTradingDate(window.startDate.slice(0, 10));

        const optionSeries = await fetchHistoricalOptionSeriesBatched(auth, exchange, optionSymbols, window);
        if (cancelled) return;

        const spotType = resolveSpotType(nubraInstruments, symbol, exchange, expiry);
        const spotSeries = await fetchHistoricalSpotSeries(auth, exchange, symbol, spotType, window);
        if (cancelled) return;

        const histTrend = buildHistoricalTrend(optionDefs, optionSeries, spotSeries);
        if (!cancelled) {
          const minuteTs = Math.floor(Date.now() / 60000) * 60000;
          let callBase = 0;
          let putBase = 0;
          let callGex = 0;
          let putGex = 0;
          for (const r of rows) {
            callBase += r.callBase;
            putBase += r.putBase;
            callGex += r.callGex;
            putGex += r.putGex;
          }
          const livePoint: TrendPoint = {
            ts: minuteTs,
            callBase,
            putBase,
            netBase: callBase + putBase,
            callGex,
            putGex,
            netGex: callGex + putGex,
          };

          const merged = [...histTrend];
          const ix = merged.findIndex(p => p.ts === minuteTs);
          if (ix >= 0) merged[ix] = livePoint;
          else if (rows.length > 0) merged.push(livePoint);
          merged.sort((a, b) => a.ts - b.ts);
          setTrend(merged);
          if (!histTrend.length) setTrendError('No intraday points returned for selected symbol/expiry');
        }
        historicalLoadKeyRef.current = loadedKey;
        liveAfterThisLoad = true;
      } catch (e: any) {
        liveAfterThisLoad = true;
        if (!cancelled) setTrendError(e?.message ?? 'Failed intraday GEX historical');
      } finally {
        if (!cancelled) {
          setTrendLoading(false);
          if (liveAfterThisLoad) setHistoryReady(true);
        }
      }
    })();
    }, 250);

    return () => { cancelled = true; clearTimeout(mountDelay); };
  }, [symbol, expiry, exchange, token, auth, nubraInstruments, rowInstrumentSig]);

  const totalsAll = useMemo(() => {
    let callBase = 0;
    let putBase = 0;
    let callGex = 0;
    let putGex = 0;
    for (const r of rows) {
      callBase += r.callBase;
      putBase += r.putBase;
      callGex += r.callGex;
      putGex += r.putGex;
    }
    return {
      callBase,
      putBase,
      netBase: callBase + putBase,
      callGex,
      putGex,
      netGex: callGex + putGex,
    };
  }, [rows]);

  const totals = useMemo(() => {
    if (gexMode === 'with-spot') return { call: totalsAll.callGex, put: totalsAll.putGex, net: totalsAll.netGex };
    return { call: totalsAll.callBase, put: totalsAll.putBase, net: totalsAll.netBase };
  }, [totalsAll, gexMode]);

  useEffect(() => {
    if (!symbol || !expiry || !rows.length || !historyReady) return;
    const minuteTs = Math.floor(Date.now() / 60000) * 60000;
    setTrend(prev => {
      const next = [...prev];
      const p: TrendPoint = {
        ts: minuteTs,
        callBase: totalsAll.callBase,
        putBase: totalsAll.putBase,
        netBase: totalsAll.netBase,
        callGex: totalsAll.callGex,
        putGex: totalsAll.putGex,
        netGex: totalsAll.netGex,
      };
      const last = next[next.length - 1];
      if (last && last.ts === minuteTs) {
        // Keep current minute synced to latest live snapshot.
        next[next.length - 1] = p;
      } else {
        appendGuardRef.current = minuteTs;
        next.push(p);
      }
      return next.length > 1000 ? next.slice(next.length - 1000) : next;
    });
  }, [rows, totalsAll, symbol, expiry, historyReady]);

  useEffect(() => {
    const host = trendChartHostRef.current;
    if (!host || trendRootRef.current) return;

    const root = am5.Root.new(host);
    root.setThemes([]);
    root.interfaceColors.set('text', am5.color(0xd1d5db));
    root.numberFormatter.set('numberFormat', '#.##a');

    const chart = root.container.children.push(am5xy.XYChart.new(root, {
      panX: true,
      panY: false,
      wheelX: 'panX',
      wheelY: 'zoomX',
      pinchZoomX: true,
      paddingTop: 8,
      paddingRight: 8,
      paddingBottom: 0,
      paddingLeft: 0,
    }));

    chart.set('cursor', am5xy.XYCursor.new(root, { behavior: 'zoomX' }));

    const xRenderer = am5xy.AxisRendererX.new(root, {
      minGridDistance: 58,
      stroke: am5.color(0x3f3b37),
      strokeOpacity: 1,
    });
    xRenderer.labels.template.setAll({ fill: am5.color(0xb7b3ae), fontSize: 11 });
    xRenderer.grid.template.setAll({ stroke: am5.color(0xffffff), strokeOpacity: 0.06 });

    const yRenderer = am5xy.AxisRendererY.new(root, {
      stroke: am5.color(0x3f3b37),
      strokeOpacity: 1,
    });
    yRenderer.labels.template.setAll({ fill: am5.color(0xb7b3ae), fontSize: 11 });
    yRenderer.grid.template.setAll({ stroke: am5.color(0xffffff), strokeOpacity: 0.06 });

    const xAxis = chart.xAxes.push(am5xy.DateAxis.new(root, {
      baseInterval: { timeUnit: 'minute', count: 1 },
      groupData: false,
      renderer: xRenderer,
      tooltip: am5.Tooltip.new(root, {}),
      dateFormats: { minute: 'HH:mm', hour: 'HH:mm' },
      periodChangeDateFormats: { minute: 'HH:mm', hour: 'HH:mm' },
    }));
    const yAxis = chart.yAxes.push(am5xy.ValueAxis.new(root, {
      extraTooltipPrecision: 2,
      renderer: yRenderer,
    }));
    const zeroRange = yAxis.createAxisRange(yAxis.makeDataItem({ value: 0 }));
    zeroRange.get('grid')?.setAll({
      stroke: am5.color(0xffffff),
      strokeOpacity: 0.78,
      strokeWidth: 1,
      strokeDasharray: [4, 4],
    });

    const makeSeries = (name: string, color: number) => {
      const series = chart.series.push(am5xy.LineSeries.new(root, {
        name,
        xAxis,
        yAxis,
        valueXField: 'ts',
        valueYField: 'value',
        stroke: am5.color(color),
        fill: am5.color(color),
        tooltip: am5.Tooltip.new(root, {
          labelText: '{name}: {valueY.formatNumber("#.##a")}',
        }),
      }));
      series.strokes.template.setAll({ strokeWidth: 2 });
      return series;
    };

    callSeriesRef.current = makeSeries('Call GEX', 0x4ade80);
    putSeriesRef.current = makeSeries('Put GEX', 0xf87171);
    netSeriesRef.current = makeSeries('Net GEX', 0x60a5fa);
    trendRootRef.current = root;
    trendXAxisRef.current = xAxis;

    return () => {
      root.dispose();
      trendRootRef.current = null;
      trendXAxisRef.current = null;
      callSeriesRef.current = null;
      putSeriesRef.current = null;
      netSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const pickCall = (p: TrendPoint) => (gexMode === 'with-spot' ? p.callGex : p.callBase);
    const pickPut = (p: TrendPoint) => (gexMode === 'with-spot' ? p.putGex : p.putBase);
    const pickNet = (p: TrendPoint) => (gexMode === 'with-spot' ? p.netGex : p.netBase);
    const maxAbs = trend.reduce((m, p) => Math.max(m, Math.abs(pickCall(p)), Math.abs(pickPut(p)), Math.abs(pickNet(p))), 0);
    let div = 1;
    while (maxAbs / div > 1e12) div *= 10;
    setTrendScaleDiv(div);

    const toData = (pick: (p: TrendPoint) => number) =>
      trend
        .filter(p => Number.isFinite(p.ts))
        .map(p => ({ ts: p.ts, value: pick(p) / div }));
    callSeriesRef.current?.set('name', gexMode === 'with-spot' ? 'Call GEX' : 'Call Base');
    putSeriesRef.current?.set('name', gexMode === 'with-spot' ? 'Put GEX' : 'Put Base');
    netSeriesRef.current?.set('name', gexMode === 'with-spot' ? 'Net GEX' : 'Net Base');
    callSeriesRef.current?.data.setAll(toData(pickCall));
    putSeriesRef.current?.data.setAll(toData(pickPut));
    netSeriesRef.current?.data.setAll(toData(pickNet));
    if (trend.length > 1) trendXAxisRef.current?.zoom(0, 1);
  }, [trend, gexMode]);

  useEffect(() => {
    const host = strikeBarHostRef.current;
    if (!host || strikeBarRootRef.current) return;

    const root = am5.Root.new(host);
    root.setThemes([]);
    root.interfaceColors.set('text', am5.color(0xd1d5db));
    root.numberFormatter.set('numberFormat', '#.##a');

    const chart = root.container.children.push(am5xy.XYChart.new(root, {
      panX: true,
      panY: false,
      wheelX: 'panX',
      wheelY: 'zoomX',
      pinchZoomX: true,
      paddingTop: 8,
      paddingRight: 10,
      paddingBottom: 0,
      paddingLeft: 0,
    }));

    chart.set('cursor', am5xy.XYCursor.new(root, { behavior: 'zoomX' }));

    const xRenderer = am5xy.AxisRendererX.new(root, {
      minGridDistance: 54,
      stroke: am5.color(0x3f3b37),
      strokeOpacity: 1,
    });
    xRenderer.labels.template.setAll({ fill: am5.color(0xb7b3ae), fontSize: 10 });
    xRenderer.grid.template.setAll({ stroke: am5.color(0xffffff), strokeOpacity: 0.05 });

    const yRenderer = am5xy.AxisRendererY.new(root, {
      stroke: am5.color(0x3f3b37),
      strokeOpacity: 1,
    });
    yRenderer.labels.template.setAll({ fill: am5.color(0xb7b3ae), fontSize: 10 });
    yRenderer.grid.template.setAll({ stroke: am5.color(0xffffff), strokeOpacity: 0.06 });

    const netYRenderer = am5xy.AxisRendererY.new(root, {
      opposite: true,
      stroke: am5.color(0x3f3b37),
      strokeOpacity: 1,
    });
    netYRenderer.labels.template.setAll({ fill: am5.color(0xfbbf24), fontSize: 10 });
    netYRenderer.grid.template.setAll({ forceHidden: true });

    const xAxis = chart.xAxes.push(am5xy.CategoryAxis.new(root, {
      categoryField: 'strikeLabel',
      renderer: xRenderer,
      tooltip: am5.Tooltip.new(root, { labelText: '{category}' }),
    }));
    const yAxis = chart.yAxes.push(am5xy.ValueAxis.new(root, {
      extraTooltipPrecision: 2,
      renderer: yRenderer,
    }));
    const netYAxis = chart.yAxes.push(am5xy.ValueAxis.new(root, {
      extraTooltipPrecision: 2,
      renderer: netYRenderer,
    }));

    const zeroRange = yAxis.createAxisRange(yAxis.makeDataItem({ value: 0 }));
    zeroRange.get('grid')?.setAll({
      stroke: am5.color(0xffffff),
      strokeOpacity: 0.78,
      strokeWidth: 1,
      strokeDasharray: [4, 4],
    });
    const netZeroRange = netYAxis.createAxisRange(netYAxis.makeDataItem({ value: 0 }));
    netZeroRange.get('grid')?.setAll({
      stroke: am5.color(0xf59e0b),
      strokeOpacity: 0.28,
      strokeWidth: 1,
      strokeDasharray: [2, 4],
    });

    const legend = chart.children.push(am5.Legend.new(root, {
      centerX: am5.p50,
      x: am5.p50,
      paddingTop: 0,
      paddingBottom: 0,
    }));
    legend.labels.template.setAll({ fill: am5.color(0xd1d5db), fontSize: 11 });
    legend.valueLabels.template.setAll({ forceHidden: true });

    const makeColumns = (name: string, color: number) => {
      const series = chart.series.push(am5xy.ColumnSeries.new(root, {
        name,
        xAxis,
        yAxis,
        categoryXField: 'strikeLabel',
        valueYField: 'value',
        clustered: true,
        fill: am5.color(color),
        stroke: am5.color(color),
        tooltip: am5.Tooltip.new(root, {
          labelText: '{name}\nStrike: {categoryX}\nValue: {valueY.formatNumber("#.##a")}',
        }),
      }));
      series.columns.template.setAll({
        width: am5.percent(82),
        fillOpacity: 0.86,
        strokeOpacity: 0,
      });
      return series;
    };

    const callSeries = makeColumns('Call GEX', 0x4ade80);
    const putSeries = makeColumns('Put GEX', 0xf87171);
    const netSeries = chart.series.push(am5xy.LineSeries.new(root, {
      name: 'GEX Profile',
      xAxis,
      yAxis: netYAxis,
      categoryXField: 'strikeLabel',
      valueYField: 'value',
      stroke: am5.color(0xf59e0b),
      fill: am5.color(0xf59e0b),
      tooltip: am5.Tooltip.new(root, {
        labelText: '{name}\nStrike: {categoryX}\nValue: {valueY.formatNumber("#.##a")}',
      }),
    }));
    netSeries.strokes.template.setAll({ strokeWidth: 2.2 });
    netSeries.bullets.push(() => am5.Bullet.new(root, {
      sprite: am5.Circle.new(root, {
        radius: 2.4,
        fill: am5.color(0xfbbf24),
        stroke: am5.color(0x141210),
        strokeWidth: 1,
      }),
    }));

    legend.data.setAll([callSeries, putSeries, netSeries]);
    strikeBarRootRef.current = root;
    strikeXAxisRef.current = xAxis;
    strikeCallSeriesRef.current = callSeries;
    strikePutSeriesRef.current = putSeries;
    strikeNetSeriesRef.current = netSeries;

    return () => {
      root.dispose();
      strikeBarRootRef.current = null;
      strikeXAxisRef.current = null;
      strikeCallSeriesRef.current = null;
      strikePutSeriesRef.current = null;
      strikeNetSeriesRef.current = null;
      strikeFlipRangeRef.current = null;
      strikeFlipZoneRefs.current = [];
      strikeFlipKeyRef.current = '';
      strikeDomainKeyRef.current = '';
    };
  }, []);

  useEffect(() => {
    const root = strikeBarRootRef.current;
    const xAxis = strikeXAxisRef.current;
    const callSeries = strikeCallSeriesRef.current;
    const putSeries = strikePutSeriesRef.current;
    const netSeries = strikeNetSeriesRef.current;
    if (!root || !xAxis || !callSeries || !putSeries || !netSeries) return;

    const sorted = [...rows].sort((a, b) => a.strike - b.strike);
    const pickCall = (r: GexRow) => (gexMode === 'with-spot' ? r.callGex : r.callBase);
    const pickPut = (r: GexRow) => (gexMode === 'with-spot' ? r.putGex : r.putBase);
    const pickNet = (r: GexRow) => (gexMode === 'with-spot' ? r.netGex : r.netBase);
    const maxAbs = sorted.reduce((m, r) => Math.max(m, Math.abs(pickCall(r)), Math.abs(pickPut(r)), Math.abs(pickNet(r))), 0);
    let div = 1;
    while (maxAbs / div > 1e12) div *= 10;
    setBarScaleDiv(div);

    const yLabel = gexMode === 'with-spot' ? 'GEX' : 'Base';
    const axisData = sorted.map(r => ({ strike: r.strike, strikeLabel: String(r.strike) }));
    const callData = sorted.map(r => ({ strike: r.strike, strikeLabel: String(r.strike), value: pickCall(r) / div }));
    const putData = sorted.map(r => ({ strike: r.strike, strikeLabel: String(r.strike), value: pickPut(r) / div }));
    const netData = sorted.map(r => ({ strike: r.strike, strikeLabel: String(r.strike), value: pickNet(r) / div }));
    callSeries.set('name', `Call ${yLabel}`);
    putSeries.set('name', `Put ${yLabel}`);
    netSeries.set('name', `${yLabel} Profile`);
    xAxis.data.setAll(axisData);
    callSeries.data.setAll(callData);
    putSeries.data.setAll(putData);
    netSeries.data.setAll(netData);

    const flipCandidates: number[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = pickNet(sorted[i]);
      if (cur === 0) {
        flipCandidates.push(sorted[i].strike);
        continue;
      }
      if (i === 0) continue;
      const prev = pickNet(sorted[i - 1]);
      if ((prev < 0 && cur > 0) || (prev > 0 && cur < 0)) {
        flipCandidates.push(prev < 0 && cur > 0 ? sorted[i - 1].strike : sorted[i].strike);
      }
    }
    const flip = flipCandidates.length
      ? flipCandidates.reduce((best, candidate) => (
        Math.abs(candidate - spot) < Math.abs(best - spot) ? candidate : best
      ))
      : null;

    const minStrike = sorted[0]?.strike;
    const maxStrike = sorted[sorted.length - 1]?.strike;
    const flipKey = flip != null && Number.isFinite(flip)
      ? `${minStrike}:${flip}:${maxStrike}:${gexMode}`
      : '';

    if (flipKey !== strikeFlipKeyRef.current) {
      strikeFlipRangeRef.current?.dispose?.();
      strikeFlipRangeRef.current = null;
      strikeFlipZoneRefs.current.forEach(range => range?.dispose?.());
      strikeFlipZoneRefs.current = [];
      strikeFlipKeyRef.current = flipKey;
    }

    if (flipKey && !strikeFlipRangeRef.current) {
      const flipValue = flip as number;
      const makeZone = (start: number, end: number, text: string, color: number) => {
        if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return;
        const zone = xAxis.createAxisRange(xAxis.makeDataItem({
          category: String(Math.min(start, end)),
          endCategory: String(Math.max(start, end)),
        }));
        zone.get('axisFill')?.setAll({
          fill: am5.color(color),
          fillOpacity: 0.08,
          visible: true,
        });
        zone.get('label')?.setAll({
          text,
          fill: am5.color(0xe5e7eb),
          fontSize: 10,
          centerX: am5.p50,
          dy: 18,
        });
        strikeFlipZoneRefs.current.push(zone);
      };

      makeZone(minStrike, flipValue, 'Below flip: negative dealer gamma amplifies moves', 0xf87171);
      makeZone(flipValue, maxStrike, 'Above flip: positive dealer gamma dampens moves', 0x4ade80);

      const range = xAxis.createAxisRange(xAxis.makeDataItem({ category: String(flipValue) }));
      range.get('grid')?.setAll({
        stroke: am5.color(0x60a5fa),
        strokeOpacity: 0.9,
        strokeWidth: 1,
        strokeDasharray: [3, 3],
      });
      range.get('label')?.setAll({
        text: `Gamma Flip: ${fmtNum(flipValue)}`,
        fill: am5.color(0xe5e7eb),
        background: am5.RoundedRectangle.new(root, {
          fill: am5.color(0x1f2937),
          fillOpacity: 0.92,
        }),
        fontSize: 10,
        rotation: -90,
        centerX: am5.p50,
        centerY: am5.p50,
        dy: -34,
      });
      strikeFlipRangeRef.current = range;
    }

    const domainKey = sorted.length ? `${minStrike}:${maxStrike}:${sorted.length}` : '';
    if (domainKey && domainKey !== strikeDomainKeyRef.current) {
      strikeDomainKeyRef.current = domainKey;
      if (sorted.length > 1) xAxis.zoom(0, 1);
    }
  }, [rows, gexMode, spot]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDrop || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = suggestions[Math.max(0, activeIdx)];
      if (pick) selectSymbol(pick.sym, pick.exchange);
    } else if (e.key === 'Escape') {
      setShowDrop(false);
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#12100f', color: '#e5e7eb', fontFamily: 'var(--font-family-sans)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', position: 'relative' }}>
        <div style={{ position: 'relative', width: 240 }}>
          <input
            value={query}
            placeholder="Search symbol..."
            onChange={e => { setQuery(e.target.value); setShowDrop(true); setActiveIdx(-1); }}
            onFocus={() => query && setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 140)}
            onKeyDown={onKeyDown}
            style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)', color: '#fff', fontSize: 12 }}
          />
          {showDrop && suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, width: '100%', maxHeight: 230, overflowY: 'auto', background: '#1a1715', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, zIndex: 30 }}>
              {suggestions.map((s, i) => (
                <button
                  key={`${s.sym}|${s.exchange}`}
                  onMouseDown={() => selectSymbol(s.sym, s.exchange)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    width: '100%',
                    textAlign: 'left',
                    padding: '7px 10px',
                    border: 'none',
                    background: i === activeIdx ? 'rgba(79,142,247,0.25)' : 'transparent',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <span>{s.sym}</span>
                  <span style={{ opacity: 0.7 }}>{s.exchange}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <select
          value={expiry}
          onChange={e => setExpiry(e.target.value)}
          style={{ minWidth: 120, padding: '6px 9px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)', color: '#fff', fontSize: 12 }}
        >
          {expiries.map(e => <option key={e} value={e} style={{ color: '#111' }}>{e}</option>)}
        </select>

        <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, overflow: 'hidden' }}>
          <button
            type="button"
            onClick={() => setGexMode('with-spot')}
            style={{
              border: 'none',
              padding: '6px 10px',
              fontSize: 11,
              color: '#fff',
              background: gexMode === 'with-spot' ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.04)',
              cursor: 'pointer',
            }}
          >
            With Spot
          </button>
          <button
            type="button"
            onClick={() => setGexMode('without-spot')}
            style={{
              border: 'none',
              borderLeft: '1px solid rgba(255,255,255,0.14)',
              padding: '6px 10px',
              fontSize: 11,
              color: '#fff',
              background: gexMode === 'without-spot' ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.04)',
              cursor: 'pointer',
            }}
          >
            Without Spot
          </button>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11 }}>
          <span style={{ color: wsLive ? '#34d399' : '#f59e0b' }}>{wsLive ? 'LIVE WS' : 'API SNAPSHOT'}</span>
          {tradingDate && <span style={{ color: '#fbbf24' }}>Trading Date: {tradingDate}</span>}
          <span style={{ color: '#93c5fd' }}>Spot: {spot > 0 ? fmtNum(spot) : '-'}</span>
          <span style={{ color: 'rgba(255,255,255,0.72)' }}>{modeLabel}</span>
          {(loading || trendLoading) && <span style={{ color: '#fbbf24' }}>Loading...</span>}
          {error && <span style={{ color: '#f87171', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10, opacity: 0.75 }}>{gexMode === 'with-spot' ? 'Total Call GEX' : 'Total Call Base'}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#4ade80' }}>{fmtShort(totals.call)}</div>
        </div>
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10, opacity: 0.75 }}>{gexMode === 'with-spot' ? 'Total Put GEX' : 'Total Put Base'}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#f87171' }}>{fmtShort(totals.put)}</div>
        </div>
        <div style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10, opacity: 0.75 }}>{gexMode === 'with-spot' ? 'Net Gamma Exposure (All Strikes)' : 'Net Base Exposure (All Strikes)'}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: totals.net >= 0 ? '#60a5fa' : '#f472b6' }}>{fmtShort(totals.net)}</div>
        </div>
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '8px 10px 10px', minHeight: 0 }}>
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>
            Full Day Total {gexMode === 'with-spot' ? 'GEX' : 'Base'} - amCharts 5 (IST){trendScaleDiv > 1 ? ` | scaled / ${fmtShort(trendScaleDiv)}` : ''}
          </div>
          <div style={{ flex: 1, minHeight: 260, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)', overflow: 'hidden', position: 'relative' }}>
            <div ref={trendChartHostRef} style={{ width: '100%', height: '100%' }} />
            {trendLoading && trend.length < 2 && (
              <div style={{ position: 'absolute', inset: 0, padding: 18, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14, background: 'rgba(10,9,8,0.78)', pointerEvents: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ width: 142, height: 10, borderRadius: 999, background: 'rgba(255,255,255,0.18)', marginBottom: 8 }} />
                    <div style={{ width: 238, height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.1)' }} />
                  </div>
                  <div style={{ fontSize: 11, color: '#fbbf24', whiteSpace: 'nowrap' }}>Please wait up to 60 sec</div>
                </div>
                <div style={{ height: 1, background: 'rgba(255,255,255,0.15)' }} />
                <div style={{ display: 'grid', gridTemplateRows: 'repeat(5, 1fr)', gap: 12 }}>
                  {[72, 46, 83, 58, 68].map((w, i) => (
                    <div key={w} style={{ display: 'grid', gridTemplateColumns: '56px 1fr 42px', gap: 10, alignItems: 'center' }}>
                      <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.1)' }} />
                      <div style={{ height: 9, borderRadius: 999, background: i % 2 === 0 ? 'rgba(96,165,250,0.26)' : 'rgba(255,255,255,0.13)', width: `${w}%` }} />
                      <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.09)' }} />
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.68)', textAlign: 'center' }}>
                  Loading full-day GEX history in batches before connecting live websocket.
                </div>
              </div>
            )}
            {!trendLoading && trend.length < 2 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, opacity: 0.7, background: 'rgba(0,0,0,0.22)', pointerEvents: 'none' }}>
                {trendError || 'Waiting for intraday historical points...'}
              </div>
            )}
          </div>
        </div>

        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>
            Gamma Exposure by Strike - amCharts 5 (Call / Put / Profile){barScaleDiv > 1 ? ` | scaled / ${fmtShort(barScaleDiv)}` : ''}
          </div>
          <div style={{ flex: 1, minHeight: 260, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)', overflow: 'hidden', position: 'relative' }}>
            <div ref={strikeBarHostRef} style={{ width: '100%', height: '100%' }} />
            {!rows.length && !loading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'rgba(255,255,255,0.6)', background: 'rgba(0,0,0,0.22)', pointerEvents: 'none' }}>
                Select symbol and expiry to load gamma exposure.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
