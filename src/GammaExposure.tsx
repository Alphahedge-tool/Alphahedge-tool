'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi, type LineData, type Time } from 'lightweight-charts';
import type { NubraInstrument } from './useNubraInstruments';

const BRIDGE = 'ws://localhost:8765';
const HIST_BATCH_SIZE = 10;
const LW_MAX_ABS = 9e13;

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

function buildTimeseriesWindow(startDateStr: string, isLive: boolean): TimeseriesWindow {
  return {
    startDate: `${startDateStr}T03:45:00.000Z`,
    endDate: isLive ? new Date().toISOString() : `${startDateStr}T10:00:00.000Z`,
    intraDay: isLive,
    realTime: false,
  };
}

function nubraHeadersFromAuth(auth: NubraAuth) {
  return {
    'x-session-token': auth.sessionToken,
    'x-device-id': auth.deviceId || 'web',
    'x-raw-cookie': auth.rawCookie || '',
  };
}

interface MarketScheduleResponse {
  is_trading_on_today_nse?: boolean;
  exchange_calendar_info?: Record<string, {
    is_trading_on_now?: boolean;
    previous_trading_day_slot?: Array<{ StartTime?: string; EndTime?: string }>;
  }>;
}

async function fetchTradingWindowFromSchedule(auth: NubraAuth, exchange: string): Promise<TimeseriesWindow> {
  const ex = normalizeExchange(exchange);
  const res = await fetch('/api/nubra-market-schedule', { headers: nubraHeadersFromAuth(auth) });
  if (!res.ok) throw new Error(`market-schedule ${res.status}`);
  const json = await res.json() as MarketScheduleResponse;

  const exInfo = json.exchange_calendar_info?.[ex] ?? json.exchange_calendar_info?.NSE;
  const isTradingToday = ex === 'NSE'
    ? !!json.is_trading_on_today_nse
    : !!(exInfo && (exInfo.is_trading_on_now || (exInfo.previous_trading_day_slot?.length ?? 0) >= 0));
  const isNowLive = !!exInfo?.is_trading_on_now;

  if (isTradingToday) {
    const todayDate = new Date(Date.now() + 5.5 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return buildTimeseriesWindow(todayDate, isNowLive);
  }

  const prevStart = exInfo?.previous_trading_day_slot?.[0]?.StartTime;
  if (prevStart) {
    const prevDate = new Date(prevStart).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return buildTimeseriesWindow(prevDate, false);
  }

  throw new Error('market-schedule has no usable trading date');
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
  const month = String(parseInt(expiryYmd.slice(4, 6), 10)); // Nubra format: no leading zero
  const dd = expiryYmd.slice(6, 8);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const strikeTxt = Number.isInteger(strike) ? String(strike) : String(Math.round(strike * 100) / 100).replace('.', '');
  return `${underlying}${yy}${month}${dd}${strikeTxt}${side}`;
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
        startDate: window.startDate,
        endDate: window.endDate,
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
        parseAndStore(JSON.parse(r.bodyText), values);
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

      const retryable = [403, 429, 500, 502, 503, 504].includes(r.status);
      if (!retryable || i === attempts - 1) break;
      await sleep(180 * (2 ** i) + Math.floor(Math.random() * 90));
    }

    // final fallback: try singles so one blocked key doesn't kill whole batch
    if (values.length > 1) {
      let any = false;
      for (const sym of values) {
        await sleep(70);
        const rs = await fetchRawBatch([sym]);
        if (rs?.ok) {
          parseAndStore(JSON.parse(rs.bodyText), [sym]);
          any = true;
        }
      }
      if (any) return true;
    }

    throw new Error(`options batch failed (${lastStatus ?? 0}): ${lastBody.slice(0, 100)}`);
  };

  const failedBatches: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const values = batches[i];
    try {
      await fetchBatchWithRetry(values);
    } catch {
      failedBatches.push(`${i + 1}/${batches.length}`);
    }
    // pacing between batches like ATM loader
    if (i < batches.length - 1) await sleep(120);
  }

  if (failedBatches.length > 0) {
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
    const optSym = String(i.nubra_name || '').trim() || buildOptionSymbol(symbol, exNorm, strike, i.option_type);
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
    deviceId: typeof window !== 'undefined' ? localStorage.getItem('nubra_device_id') ?? 'web' : 'web',
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
  const [error, setError] = useState('');
  const [trendError, setTrendError] = useState('');
  const [tradingDate, setTradingDate] = useState('');
  const [gexMode, setGexMode] = useState<'with-spot' | 'without-spot'>('with-spot');
  const [trendScaleDiv, setTrendScaleDiv] = useState(1);
  const [barScaleDiv, setBarScaleDiv] = useState(1);

  const wsRef = useRef<WebSocket | null>(null);
  const trendChartHostRef = useRef<HTMLDivElement | null>(null);
  const trendChartRef = useRef<IChartApi | null>(null);
  const callSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const putSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const netSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const strikeBarHostRef = useRef<HTMLDivElement | null>(null);
  const strikeBarInstRef = useRef<any>(null);
  const initialLoadedRef = useRef(false);
  const appendGuardRef = useRef<number>(0);
  const suggestions = useMemo(() => buildSuggestions(query, nubraInstruments), [query, nubraInstruments]);
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
    setRows([]);
    setTrend([]);
    setTradingDate('');
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
    if (!strikes.length) {
      setRows([]);
      return;
    }

    const list: GexRow[] = strikes.map(strike => {
      const ceRow = ceMap.get(strike);
      const peRow = peMap.get(strike);
      const ceGamma = Number(ceRow?.gamma ?? 0);
      const peGamma = Number(peRow?.gamma ?? 0);
      const ceOi = Number(isWs ? (ceRow?.open_interest ?? 0) : (ceRow?.oi ?? 0));
      const peOi = Number(isWs ? (peRow?.open_interest ?? 0) : (peRow?.oi ?? 0));
      const lotSize = Number(ceRow?.lot_size ?? ceRow?.ls ?? peRow?.lot_size ?? peRow?.ls ?? 0) || 1;
      const s2 = spotValue > 0 ? spotValue * spotValue : 0;
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
    });

    setRows(list);
    setSpot(spotValue);
  }, []);

  useEffect(() => {
    if (!symbol || !expiry || !token) return;
    setLoading(true);
    setError('');
    setWsLive(false);

    fetch(`/api/nubra-optionchain?session_token=${encodeURIComponent(token)}&instrument=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`optionchain ${r.status}`);
        return r.json();
      })
      .then(json => {
        const chain = json.chain ?? json;
        const cp = Number(chain.cp ?? chain.current_price ?? 0) / 100;
        mergeChainToRows(chain.ce ?? [], chain.pe ?? [], cp, false);
      })
      .catch((e: any) => setError(e?.message ?? 'Failed to load API snapshot'))
      .finally(() => setLoading(false));

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
    setTrend([]);
    setTradingDate('');
    setTrendLoading(true);
    setTrendError('');

    (async () => {
      try {
        let optionDefs = buildOptionDefs(nubraInstruments, symbol, exchange, expiry);
        // Fallback: derive option names from currently loaded strike table if instrument expiry formats don't match.
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

        const optionSymbols = [...new Set(optionDefs.map(d => d.symbol))];
        const window = await fetchTradingWindowFromSchedule(auth, exchange);
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
      } catch (e: any) {
        if (!cancelled) setTrendError(e?.message ?? 'Failed intraday GEX historical');
      } finally {
        if (!cancelled) setTrendLoading(false);
      }
    })();
    }, 250);

    return () => { cancelled = true; clearTimeout(mountDelay); };
  }, [symbol, expiry, exchange, token, auth, nubraInstruments, rows]);

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
    if (!symbol || !expiry || !rows.length) return;
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
  }, [rows, totalsAll, symbol, expiry]);

  useEffect(() => {
    const host = trendChartHostRef.current;
    if (!host || trendChartRef.current) return;
    const chart = createChart(host, {
      layout: { background: { color: '#141210' }, textColor: 'rgba(255,255,255,0.65)', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.16)' },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.16)',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => {
          const t = Number(time);
          if (!Number.isFinite(t)) return '';
          return new Date(t * 1000).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
        },
      },
      localization: {
        timeFormatter: (time: Time) => {
          const t = Number(time);
          if (!Number.isFinite(t)) return '';
          return new Date(t * 1000).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
        },
      },
      crosshair: { vertLine: { color: 'rgba(255,255,255,0.2)' }, horzLine: { color: 'rgba(255,255,255,0.2)' } },
      autoSize: true,
    });
    const call = chart.addSeries(LineSeries, { color: '#4ade80', lineWidth: 2, title: 'Call GEX' });
    const put = chart.addSeries(LineSeries, { color: '#f87171', lineWidth: 2, title: 'Put GEX' });
    const net = chart.addSeries(LineSeries, { color: '#60a5fa', lineWidth: 2, title: 'Net GEX' });
    trendChartRef.current = chart;
    callSeriesRef.current = call;
    putSeriesRef.current = put;
    netSeriesRef.current = net;

    const ro = new ResizeObserver(() => trendChartRef.current?.applyOptions({ width: host.clientWidth, height: host.clientHeight }));
    ro.observe(host);
    return () => {
      ro.disconnect();
      trendChartRef.current?.remove();
      trendChartRef.current = null;
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
    while (maxAbs / div > LW_MAX_ABS) div *= 10;
    setTrendScaleDiv(div);

    const toData = (pick: (p: TrendPoint) => number): LineData[] =>
      trend
        .filter(p => Number.isFinite(p.ts))
        .map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: pick(p) / div }));
    callSeriesRef.current?.applyOptions({ title: gexMode === 'with-spot' ? 'Call GEX' : 'Call Base' });
    putSeriesRef.current?.applyOptions({ title: gexMode === 'with-spot' ? 'Put GEX' : 'Put Base' });
    netSeriesRef.current?.applyOptions({ title: gexMode === 'with-spot' ? 'Net GEX' : 'Net Base' });
    callSeriesRef.current?.setData(toData(pickCall));
    putSeriesRef.current?.setData(toData(pickPut));
    netSeriesRef.current?.setData(toData(pickNet));
    if (trend.length > 1) trendChartRef.current?.timeScale().fitContent();
  }, [trend, gexMode]);

  useEffect(() => {
    const host = strikeBarHostRef.current;
    if (!host) return;
    let disposed = false;
    (async () => {
      const echarts = await import('echarts');
      if (disposed || !host) return;
      if (!strikeBarInstRef.current) {
        strikeBarInstRef.current = echarts.init(host, null, { renderer: 'canvas' });
      }
      const inst = strikeBarInstRef.current;
      const sorted = [...rows].sort((a, b) => a.strike - b.strike);
      const pickCall = (r: GexRow) => (gexMode === 'with-spot' ? r.callGex : r.callBase);
      const pickPut = (r: GexRow) => (gexMode === 'with-spot' ? r.putGex : r.putBase);
      const pickNet = (r: GexRow) => (gexMode === 'with-spot' ? r.netGex : r.netBase);
      const maxAbs = sorted.reduce((m, r) => Math.max(m, Math.abs(pickCall(r)), Math.abs(pickPut(r)), Math.abs(pickNet(r))), 0);
      let div = 1;
      while (maxAbs / div > 1e12) div *= 10;
      setBarScaleDiv(div);
      const labels = sorted.map(r => String(Math.round(r.strike)));
      const yLabel = gexMode === 'with-spot' ? 'GEX' : 'Base';
      inst.setOption({
        backgroundColor: '#141210',
        animation: false,
        grid: { left: 64, right: 18, top: 24, bottom: 56 },
        legend: {
          top: 0,
          textStyle: { color: 'rgba(255,255,255,0.8)', fontSize: 11 },
          data: [`Call ${yLabel}`, `Put ${yLabel}`, `Net ${yLabel}`],
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: '#1b1816',
          borderColor: 'rgba(255,255,255,0.14)',
          textStyle: { color: '#fff' },
        },
        xAxis: {
          type: 'category',
          data: labels,
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
          axisLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 10, interval: Math.max(0, Math.floor(labels.length / 18)) },
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
          axisLabel: {
            color: 'rgba(255,255,255,0.7)',
            formatter: (v: number) => fmtShort(Number(v) * div),
          },
        },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0 },
          { type: 'slider', xAxisIndex: 0, bottom: 8, height: 20, textStyle: { color: 'rgba(255,255,255,0.65)' } },
        ],
        series: [
          { name: `Call ${yLabel}`, type: 'bar', data: sorted.map(r => pickCall(r) / div), itemStyle: { color: 'rgba(74,222,128,0.75)' }, barGap: '8%' },
          { name: `Put ${yLabel}`, type: 'bar', data: sorted.map(r => pickPut(r) / div), itemStyle: { color: 'rgba(248,113,113,0.75)' }, barGap: '8%' },
          { name: `Net ${yLabel}`, type: 'bar', data: sorted.map(r => pickNet(r) / div), itemStyle: { color: 'rgba(96,165,250,0.8)' }, barGap: '8%' },
        ],
      }, true);
    })();

    const ro = new ResizeObserver(() => strikeBarInstRef.current?.resize());
    ro.observe(host);
    return () => {
      disposed = true;
      ro.disconnect();
    };
  }, [rows, gexMode]);

  useEffect(() => () => {
    strikeBarInstRef.current?.dispose();
    strikeBarInstRef.current = null;
  }, []);

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
            Full Day {gexMode === 'with-spot' ? 'GEX' : 'Base'} - TradingView (IST){trendScaleDiv > 1 ? ` | scaled / ${fmtShort(trendScaleDiv)}` : ''}
          </div>
          <div style={{ flex: 1, minHeight: 260, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)', overflow: 'hidden', position: 'relative' }}>
            <div ref={trendChartHostRef} style={{ width: '100%', height: '100%' }} />
            {trend.length < 2 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, opacity: 0.7, background: 'rgba(0,0,0,0.22)', pointerEvents: 'none' }}>
                {trendError || 'Waiting for intraday historical points...'}
              </div>
            )}
          </div>
        </div>

        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>
            Strike-wise {gexMode === 'with-spot' ? 'GEX' : 'Base'} Bars (Call / Put / Net){barScaleDiv > 1 ? ` | scaled / ${fmtShort(barScaleDiv)}` : ''}
          </div>
          <div style={{ flex: 1, minHeight: 260, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)', overflow: 'hidden' }}>
            {!rows.length && !loading ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                Select symbol and expiry to load gamma exposure.
              </div>
            ) : (
              <div ref={strikeBarHostRef} style={{ width: '100%', height: '100%' }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
