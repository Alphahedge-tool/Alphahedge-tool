'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as am5 from '@amcharts/amcharts5';
import * as am5percent from '@amcharts/amcharts5/percent';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts';
import { useInstrumentsCtx } from './AppContext';
import type { NubraInstrument } from './useNubraInstruments';
import { nubraBridge } from './lib/NubraBridgeManager';
import s from './MasterOptionChain.module.css';

interface Props {
  visible?: boolean;
}

interface SymbolChoice {
  sym: string;
  exchange: string;
  lotSize: number;
  stockName: string;
  nubraName: string;
}

interface OptionSide {
  ltp: number;
  cp: number;
  iv: number;
  oi: number;
  volume: number;
  oiChgPct: number;
  delta: number;
  theta: number;
  vega: number;
  gamma: number;
}

interface StrikeRow {
  strike: number;
  ce: OptionSide;
  pe: OptionSide;
}

interface ChainSnapshot {
  rows: StrikeRow[];
  spot: number;
  atm: number;
}

const EMPTY_SIDE: OptionSide = {
  ltp: 0,
  cp: 0,
  iv: 0,
  oi: 0,
  volume: 0,
  oiChgPct: 0,
  delta: 0,
  theta: 0,
  vega: 0,
  gamma: 0,
};

const DEFAULT_SCRIP = 'NIFTY';
const STRIKE_WINDOW_OPTIONS = [5, 10, 15, 20];
const AVAILABLE_COLUMNS = [
  { key: 'oi', label: 'OI' },
  { key: 'iv', label: 'IV' },
  { key: 'ltp', label: 'LTP' },
  { key: 'delta', label: 'Delta' },
  { key: 'theta', label: 'Theta' },
  { key: 'vega', label: 'Vega' },
  { key: 'gamma', label: 'Gamma' },
] as const;
type ColumnKey = typeof AVAILABLE_COLUMNS[number]['key'];
const DEFAULT_COLUMNS: ColumnKey[] = ['oi', 'iv', 'ltp'];
const BUTTERFLY_TYPES = ['Long Call', 'Short Call', 'Long Put', 'Short Put'] as const;
type ButterflyType = typeof BUTTERFLY_TYPES[number];
type RatioOptionType = 'Call' | 'Put';
type ViewMode = 'chain' | 'straddle' | 'butterfly' | 'ratio';

interface ButterflyLeg {
  strike: number;
  premium: number;
  side: 'buy' | 'sell';
  qty: number;
}

interface ButterflyRow {
  k1: number;
  k2: number;
  k3: number;
  p1: number;
  p2: number;
  p3: number;
  net: number;
  maxProfit: number;
  maxLoss: number;
  riskReward: string;
  beLow: number;
  beHigh: number;
}

interface RatioRow {
  srNo: number;
  buyStrike: number;
  sellStrike: number;
  buyLtp: number;
  sellLtp: number;
  buyDelta: number;
  buyTheta: number;
  sellDelta: number;
  sellTheta: number;
  pd: number;
}

interface RatioChartTarget {
  buyStrike: number;
  sellStrike: number;
}

interface StraddleRow {
  strike: number;
  callLtp: number;
  putLtp: number;
  straddlePrice: number;
  priceChange: number;
  changePct: number;
  avgIv: number;
  callOi: number;
  putOi: number;
  netDelta: number;
  netTheta: number;
  netGamma: number;
  netVega: number;
  isAtm: boolean;
}

interface StraddleChartTarget {
  strike: number;
}

interface StraddleLivePoint {
  straddle: number;
  call: number;
  put: number;
  spot: number;
  iv: number;
  oi: number;
  pcr: number;
  label: string;
}

interface ButterflyLivePoint {
  net: number;
  spot: number;
  label: string;
}

interface ButterflyChartTarget {
  k1: number;
  k2: number;
  k3: number;
}

function nubraHeaders() {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  return {
    'x-session-token': sessionToken,
    'x-device-id': deviceId,
    'x-raw-cookie': rawCookie,
  };
}

function getSession() {
  return localStorage.getItem('nubra_session_token') ?? '';
}

function isMarketOpen(): boolean {
  const now = new Date();
  const istMin = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + 330) % 1440;
  const istDay = new Date(now.getTime() + 330 * 60000);
  if ([0, 6].includes(istDay.getUTCDay())) return false;
  return istMin >= 9 * 60 + 15 && istMin < 15 * 60 + 30;
}

function fmtExpiry(expiry: string | null | undefined) {
  if (!expiry) return 'Select expiry';
  const str = String(expiry);
  if (!/^\d{8}$/.test(str)) return str;
  return new Date(`${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function fmtPrice(n: number) {
  return n > 0 ? n.toFixed(2) : '—';
}

function fmtSignedPrice(n: number) {
  if (!isFinite(n)) return '—';
  if (n === 0) return '0.00';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

function fmtChangePct(n: number) {
  if (!isFinite(n) || n === 0) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtIv(n: number) {
  return n > 0 ? n.toFixed(2) : '—';
}

function fmtGreek(n: number, digits = 2) {
  return n !== 0 ? n.toFixed(digits) : '—';
}

function fmtMaybeGreek(n: number | null, digits = 2) {
  if (n == null || !isFinite(n)) return 'â€”';
  return n.toFixed(digits);
}

function avgPositive(values: number[]) {
  const valid = values.filter(value => value > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function fmtOi(n: number) {
  if (!n) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtRatio(n: number) {
  if (!isFinite(n)) return 'â€”';
  return n.toFixed(2);
}

function fmtMetricCompact(n: number) {
  if (!n) return '0';
  if (Math.abs(n) >= 1000) return fmtOi(Math.abs(n));
  return Math.abs(n).toFixed(2);
}

function fmtOiChgPct(n: number) {
  if (!isFinite(n) || n === 0) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function parseRestOption(opt: Record<string, number>): OptionSide {
  const ltp = (opt.ltp ?? 0) / 100;
  const ltpchg = opt.ltpchg ?? 0;
  const cp = ltpchg !== -100 ? ltp / (1 + ltpchg / 100) : 0;
  const volume = opt.volume ?? opt.vol ?? opt.total_volume ?? 0;
  return {
    ltp,
    cp,
    iv: (opt.iv ?? 0) * 100,
    oi: opt.oi ?? 0,
    volume,
    oiChgPct: opt.prev_oi != null && (opt.oi ?? 0) > 0 ? (((opt.oi ?? 0) - opt.prev_oi) / (opt.oi ?? 0)) * 100 : 0,
    delta: opt.delta ?? 0,
    theta: opt.theta ?? 0,
    vega: opt.vega ?? 0,
    gamma: opt.gamma ?? 0,
  };
}

function parseWsOption(opt: Record<string, number>): OptionSide {
  const ltp = opt.last_traded_price ?? 0;
  const chg = opt.last_traded_price_change ?? 0;
  const volume = opt.volume ?? opt.traded_volume ?? opt.total_traded_volume ?? 0;
  return {
    ltp,
    cp: ltp - chg,
    iv: (opt.iv ?? 0) * 100,
    oi: opt.open_interest ?? 0,
    volume,
    oiChgPct: (opt.open_interest ?? 0) > 0
      ? (((opt.open_interest ?? 0) - (opt.previous_open_interest ?? 0)) / (opt.open_interest ?? 0)) * 100
      : 0,
    delta: opt.delta ?? 0,
    theta: opt.theta ?? 0,
    vega: opt.vega ?? 0,
    gamma: opt.gamma ?? 0,
  };
}

function buildChainSnapshot(ceList: Record<string, number>[], peList: Record<string, number>[], atmRaw: number, spotRaw: number): ChainSnapshot {
  const scale = 100;
  const map = new Map<number, StrikeRow>();

  for (const opt of ceList) {
    const strike = (opt.sp ?? 0) / scale;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE } });
    map.get(strike)!.ce = parseRestOption(opt);
  }

  for (const opt of peList) {
    const strike = (opt.sp ?? 0) / scale;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE } });
    map.get(strike)!.pe = parseRestOption(opt);
  }

  return {
    rows: [...map.values()].sort((a, b) => a.strike - b.strike),
    spot: spotRaw / scale,
    atm: atmRaw > 0 ? atmRaw / scale : spotRaw / scale,
  };
}

function buildChainSnapshotWs(ceList: Record<string, number>[], peList: Record<string, number>[], atmRaw: number, spotRaw: number): ChainSnapshot {
  const map = new Map<number, StrikeRow>();

  for (const opt of ceList) {
    const strike = opt.strike_price ?? 0;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE } });
    map.get(strike)!.ce = parseWsOption(opt);
  }

  for (const opt of peList) {
    const strike = opt.strike_price ?? 0;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE } });
    map.get(strike)!.pe = parseWsOption(opt);
  }

  return {
    rows: [...map.values()].sort((a, b) => a.strike - b.strike),
    spot: spotRaw,
    atm: atmRaw > 0 ? atmRaw : spotRaw,
  };
}

function mergeOptionSide(base: OptionSide | undefined, live: OptionSide | undefined): OptionSide {
  return {
    ltp: live?.ltp ?? base?.ltp ?? 0,
    // Keep REST close-price baseline so displayed LTP change remains stable,
    // while the incoming WS tick only updates the live LTP/greeks.
    cp: base?.cp ?? live?.cp ?? 0,
    iv: live?.iv ?? base?.iv ?? 0,
    oi: live?.oi ?? base?.oi ?? 0,
    volume: live?.volume ?? base?.volume ?? 0,
    oiChgPct: live?.oiChgPct ?? base?.oiChgPct ?? 0,
    delta: live?.delta ?? base?.delta ?? 0,
    theta: live?.theta ?? base?.theta ?? 0,
    vega: live?.vega ?? base?.vega ?? 0,
    gamma: live?.gamma ?? base?.gamma ?? 0,
  };
}

function mergeChainSnapshot(base: ChainSnapshot | undefined, live: ChainSnapshot): ChainSnapshot {
  if (!base) return live;

  const baseMap = new Map(base.rows.map(row => [row.strike, row]));
  const strikes = new Set<number>([
    ...base.rows.map(row => row.strike),
    ...live.rows.map(row => row.strike),
  ]);

  const rows = [...strikes]
    .sort((a, b) => a - b)
    .map(strike => {
      const prev = baseMap.get(strike);
      const next = live.rows.find(row => row.strike === strike);
      return {
        strike,
        ce: mergeOptionSide(prev?.ce, next?.ce),
        pe: mergeOptionSide(prev?.pe, next?.pe),
      };
    });

  return {
    rows,
    spot: live.spot || base.spot,
    atm: live.atm || base.atm,
  };
}

function buildSuggestions(nubraInstruments: NubraInstrument[]): SymbolChoice[] {
  const seen = new Set<string>();
  const out: SymbolChoice[] = [];
  for (const i of nubraInstruments) {
    const sym = i.asset ?? i.nubra_name ?? '';
    if (!sym) continue;
    const assetType = (i.asset_type ?? '').toUpperCase();
    if (assetType !== 'INDEX_FO' && assetType !== 'STOCK_FO') continue;
    const exchange = i.exchange ?? 'NSE';
    const key = `${sym}|${exchange}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sym,
      exchange,
      lotSize: i.lot_size ?? 1,
      stockName: i.asset ?? i.stock_name ?? '',
      nubraName: i.asset ?? i.nubra_name ?? '',
    });
  }
  return out.sort((a, b) => a.sym.localeCompare(b.sym));
}

function resolveNubra(sym: string, nubraInstruments: NubraInstrument[]) {
  const upper = sym.toUpperCase();
  const found = nubraInstruments.find(i =>
    (i.option_type === 'CE' || i.option_type === 'PE') &&
    (i.asset?.toUpperCase() === upper || i.nubra_name?.toUpperCase() === upper || i.stock_name?.toUpperCase().startsWith(upper))
  );
  if (found?.asset) {
    return {
      nubraSym: found.asset,
      exchange: found.exchange ?? 'NSE',
      lotSize: found.lot_size ?? 1,
    };
  }
  return { nubraSym: sym, exchange: 'NSE', lotSize: 1 };
}

async function fetchExpiries(sym: string, exchange: string): Promise<string[]> {
  const headers = nubraHeaders();
  if (!headers['x-session-token']) return [];
  const res = await fetch(`/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exchange}`, { headers });
  if (!res.ok) return [];
  const json = await res.json();
  const list: string[] = json?.expiries ?? [];
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return list.filter(exp => String(exp) >= today).sort();
}

async function fetchOptionChainSnapshot(session: string, sym: string, exchange: string, expiry: string): Promise<ChainSnapshot> {
  const url = `/api/nubra-optionchain?session_token=${encodeURIComponent(session)}&instrument=${encodeURIComponent(sym)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load option chain (${res.status})`);
  const json = await res.json();
  const chain = json.chain ?? json;
  return buildChainSnapshot(chain.ce ?? [], chain.pe ?? [], chain.atm ?? 0, chain.cp ?? chain.current_price ?? 0);
}

function toIstDateTime(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(now).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function prevTradingDate(yyyyMmDd: string) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

function istToUtcIso(date: string, hhmm: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const msUtc = Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0, 0);
  return new Date(msUtc).toISOString();
}

function buildNubraOptionName(symbol: string, expiry: string, strike: number, side: 'CE' | 'PE') {
  const yy = expiry.slice(2, 4);
  const m = String(parseInt(expiry.slice(4, 6), 10));
  const dd = expiry.slice(6, 8);
  return `${symbol}${yy}${m}${dd}${Number(strike.toFixed(0))}${side}`;
}

function buildNubraChainValue(symbol: string, expiry: string) {
  return `${symbol}_${expiry}`;
}

async function fetchNubraFieldSeries(
  exchange: string,
  type: 'OPT' | 'STOCK' | 'INDEX',
  value: string,
  field: 'close' | 'iv' | 'iv_mid' | 'oi' | 'cumulative_oi',
  startDate: string,
  endDate: string,
  valueTransform?: (raw: number) => number,
): Promise<Array<{ ts: number; v: number }>> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken = localStorage.getItem('nubra_auth_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? '';

  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: sessionToken,
      auth_token: authToken,
      device_id: deviceId,
      exchange,
      type,
      values: [value],
      fields: [field],
      startDate,
      endDate,
      interval: '1m',
      intraDay: false,
    }),
  });
  if (!res.ok) return [];

  const json = await res.json();
  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
  let stockChart: any = null;
  for (const dict of valuesArr) {
    for (const v of Object.values(dict)) {
      stockChart = v;
      break;
    }
    if (stockChart) break;
  }
  const series = stockChart?.[field] ?? [];
  if (!Array.isArray(series)) return [];
  return series
    .map((p: any) => ({
      ts: Number(p?.ts ?? p?.timestamp ?? 0),
      v: valueTransform
        ? valueTransform(Number(p?.v ?? p?.value ?? 0))
        : Number(p?.v ?? p?.value ?? 0),
    }))
    .filter(p => p.ts > 0 && isFinite(p.v));
}

async function fetchNubraMultiSeries(
  exchange: string,
  type: 'OPT' | 'STOCK' | 'INDEX',
  values: string[],
  fields: Array<'close' | 'iv' | 'iv_mid' | 'oi' | 'cumulative_oi'>,
  startDate: string,
  endDate: string,
  transforms?: Partial<Record<'close' | 'iv' | 'iv_mid' | 'oi' | 'cumulative_oi', (raw: number) => number>>,
): Promise<Record<string, Partial<Record<'close' | 'iv' | 'iv_mid' | 'oi' | 'cumulative_oi', Array<{ ts: number; v: number }>>>>> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken = localStorage.getItem('nubra_auth_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? '';

  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: sessionToken,
      auth_token: authToken,
      device_id: deviceId,
      exchange,
      type,
      values,
      fields,
      startDate,
      endDate,
      interval: '1m',
      intraDay: false,
    }),
  });
  if (!res.ok) return {};

  const json = await res.json();
  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
  const out: Record<string, Partial<Record<'close' | 'iv' | 'iv_mid' | 'oi' | 'cumulative_oi', Array<{ ts: number; v: number }>>>> = {};

  for (const dict of valuesArr) {
    for (const [valueKey, chartData] of Object.entries(dict ?? {})) {
      const typedChartData = chartData as Record<string, any>;
      out[valueKey] = {};
      for (const field of fields) {
        const series = typedChartData?.[field] ?? [];
        if (!Array.isArray(series)) continue;
        out[valueKey][field] = series
          .map((p: any) => ({
            ts: Number(p?.ts ?? p?.timestamp ?? 0),
            v: transforms?.[field]
              ? transforms[field]!(Number(p?.v ?? p?.value ?? 0))
              : Number(p?.v ?? p?.value ?? 0),
          }))
          .filter((p: { ts: number; v: number }) => p.ts > 0 && isFinite(p.v));
      }
    }
  }

  return out;
}

async function fetchNubraChainOiHistory(
  exchange: string,
  chainValues: string[],
  startDate: string,
  endDate: string,
): Promise<SummaryTrendPoint[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken || chainValues.length === 0) return [];

  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: {
      'x-session-token': sessionToken,
      'x-device-id': deviceId,
      'x-raw-cookie': rawCookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chart: 'Put_Call_Ratio',
      query: [
        {
          exchange,
          type: 'CHAIN',
          values: chainValues,
          fields: ['cumulative_call_oi', 'cumulative_put_oi'],
          startDate,
          endDate,
          interval: '1m',
          intraDay: false,
          realTime: false,
        },
      ],
    }),
  });
  if (!res.ok) {
    const err = new Error(`nubra-timeseries ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const totals = new Map<number, SummaryTrendPoint>();

  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      for (const chainValue of chainValues) {
        const chainData = valObj?.[chainValue];
        if (!chainData) continue;
        const callOi: Array<{ ts: number; v: number }> = chainData.cumulative_call_oi ?? [];
        const putOi: Array<{ ts: number; v: number }> = chainData.cumulative_put_oi ?? [];

        for (const point of callOi) {
          const ts = Math.floor((point.ts ?? 0) / 1e9) * 1000;
          const row = totals.get(ts) ?? { ts, call: 0, put: 0 };
          row.call += point.v ?? 0;
          totals.set(ts, row);
        }

        for (const point of putOi) {
          const ts = Math.floor((point.ts ?? 0) / 1e9) * 1000;
          const row = totals.get(ts) ?? { ts, call: 0, put: 0 };
          row.put += point.v ?? 0;
          totals.set(ts, row);
        }
      }
    }
  }

  return [...totals.values()].sort((a, b) => a.ts - b.ts);
}

function toSpotLine(points: Array<{ ts: number; v: number }>): LineData[] {
  return points
    .map(p => ({ time: Math.floor((p.ts ?? 0) / 1e9) as Time, value: p.v ?? 0 }))
    .sort((a, b) => (a.time as number) - (b.time as number));
}

function toMetricLine(points: Array<{ ts: number; v: number }>): LineData[] {
  return points
    .map(p => ({ time: Math.floor((p.ts ?? 0) / 1e9) as Time, value: p.v ?? 0 }))
    .sort((a, b) => (a.time as number) - (b.time as number));
}

function combinePairSeries(
  a: Array<{ ts: number; v: number }>,
  b: Array<{ ts: number; v: number }>,
  combine: (aValue: number, bValue: number) => number,
): Array<{ ts: number; v: number }> {
  const mapB = new Map<number, number>();
  for (const point of b) mapB.set(Math.floor(point.ts / 1e9), point.v);

  return a
    .map(point => {
      const tsSec = Math.floor(point.ts / 1e9);
      const other = mapB.get(tsSec);
      if (other == null) return null;
      return { ts: tsSec * 1e9, v: combine(point.v, other) };
    })
    .filter((point): point is { ts: number; v: number } => point != null);
}

// ── Realized Volatility (5-min, 12-bar rolling, annualized) ──────────────────
// Formula: RV_i = sqrt( sum(r²) over last 12 bars × 252 × 75 ) × 100
// where r_i = ln(close_i / close_{i-1}), 252 trading days, 75 five-min bars/day
const RV_WINDOW = 12;       // 1-hour rolling (12 × 5min)
const RV_ANNUAL = 252 * 75; // annualisation factor for 5-min bars

function computeRV(spotPoints: Array<{ ts: number; v: number }>): LineData[] {
  if (spotPoints.length < 2) return [];
  const sorted = [...spotPoints].sort((a, b) => a.ts - b.ts);
  const result: LineData[] = [];
  const logReturns: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].v;
    const curr = sorted[i].v;
    if (prev <= 0 || curr <= 0) { logReturns.push(0); continue; }
    logReturns.push(Math.log(curr / prev));
  }

  for (let i = RV_WINDOW - 1; i < logReturns.length; i++) {
    let sumSq = 0;
    for (let j = i - RV_WINDOW + 1; j <= i; j++) sumSq += logReturns[j] * logReturns[j];
    const rv = Math.sqrt(sumSq * RV_ANNUAL) * 100; // express as %
    const tsSec = Math.floor(sorted[i + 1].ts / 1e9); // align with close bar i+1
    if (tsSec > 0 && isFinite(rv)) result.push({ time: tsSec as Time, value: rv });
  }
  return result;
}

function appendLiveMetricPointAny(series: LineData[], value: number, maxPoints = 800): LineData[] {
  if (!isFinite(value)) return series;
  const t = Math.floor(Date.now() / 60000) * 60;
  const out = [...series];
  const nextPoint = { time: t as Time, value };
  const last = out[out.length - 1];
  if (last && (last.time as number) === t) out[out.length - 1] = nextPoint;
  else out.push(nextPoint);
  if (out.length > maxPoints) out.splice(0, out.length - maxPoints);
  return out;
}

function buildButterflyNetLine(
  p1Series: Array<{ ts: number; v: number }>,
  p2Series: Array<{ ts: number; v: number }>,
  p3Series: Array<{ ts: number; v: number }>,
  butterflyType: ButterflyType,
  scale: number,
): LineData[] {
  const m1 = new Map<number, number>();
  const m2 = new Map<number, number>();
  const m3 = new Map<number, number>();
  for (const p of p1Series) m1.set(Math.floor(p.ts / 1e9), p.v);
  for (const p of p2Series) m2.set(Math.floor(p.ts / 1e9), p.v);
  for (const p of p3Series) m3.set(Math.floor(p.ts / 1e9), p.v);

  const out: LineData[] = [];
  for (const [t, p1] of m1.entries()) {
    if (!m2.has(t) || !m3.has(t)) continue;
    const p2 = m2.get(t) ?? 0;
    const p3 = m3.get(t) ?? 0;
    const netRaw = butterflyType.startsWith('Long')
      ? ((2 * p2) - p1 - p3)
      : (p1 + p3 - (2 * p2));
    out.push({ time: t as Time, value: netRaw * scale });
  }
  out.sort((a, b) => (a.time as number) - (b.time as number));
  return out;
}

function nearestStrikeIndex(rows: StrikeRow[], atm: number) {
  let bestIdx = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  rows.forEach((row, idx) => {
    const diff = Math.abs(row.strike - atm);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = idx;
    }
  });
  return bestIdx;
}

function appendLivePointAny(series: LineData[], value: number, maxPoints = 800): LineData[] {
  if (!isFinite(value)) return series;
  // MTM-style live behavior: keep animating the current 1-minute point,
  // append a fresh point only when minute changes.
  const t = Math.floor(Date.now() / 60000) * 60;
  const out = [...series];
  const last = out[out.length - 1];
  if (last && (last.time as number) === t) out[out.length - 1] = { time: t as Time, value };
  else out.push({ time: t as Time, value });
  if (out.length > maxPoints) out.splice(0, out.length - maxPoints);
  return out;
}

function resolveStraddleLivePoint(
  chain: ChainSnapshot | null,
  target: StraddleChartTarget | null,
  lotSize: number,
  perLot: boolean,
): StraddleLivePoint | null {
  if (!chain || !target) return null;
  const row = chain.rows.find(item => item.strike === target.strike);
  if (!row) return null;
  const scale = perLot ? lotSize : 1;
  const avgIv = avgPositive([row.ce.iv, row.pe.iv]);
  return {
    straddle: (row.ce.ltp + row.pe.ltp) * scale,
    call: row.ce.ltp * scale,
    put: row.pe.ltp * scale,
    spot: chain.spot || 0,
    iv: avgIv,
    oi: row.ce.oi + row.pe.oi,
    pcr: row.ce.oi > 0 ? row.pe.oi / row.ce.oi : 0,
    label: target.strike.toFixed(0),
  };
}

function resolveRatioLivePoint(
  chain: ChainSnapshot | null,
  target: RatioChartTarget | null,
  optionType: RatioOptionType,
  lotSize: number,
  perLot: boolean,
  buyQty: number,
  sellQty: number,
) {
  if (!chain || !target) return null;
  const buyRow = chain.rows.find(item => item.strike === target.buyStrike);
  const sellRow = chain.rows.find(item => item.strike === target.sellStrike);
  if (!buyRow || !sellRow) return null;
  const side: 'CE' | 'PE' = optionType === 'Call' ? 'CE' : 'PE';
  const scale = perLot ? lotSize : 1;
  const buy = side === 'CE' ? buyRow.ce : buyRow.pe;
  const sell = side === 'CE' ? sellRow.ce : sellRow.pe;
  return {
    pd: ((sell.ltp * scale) * sellQty) - ((buy.ltp * scale) * buyQty),
    spot: chain.spot || 0,
    label: `${target.buyStrike.toFixed(0)}-${target.sellStrike.toFixed(0)}`,
  };
}

function resolveButterflyLivePoint(
  chain: ChainSnapshot | null,
  target: ButterflyChartTarget | null,
  butterflyType: ButterflyType,
  lotSize: number,
  perLot: boolean,
): ButterflyLivePoint | null {
  if (!chain || !target) return null;
  const side = optionTypeForButterfly(butterflyType);
  const row1 = chain.rows.find(r => r.strike === target.k1);
  const row2 = chain.rows.find(r => r.strike === target.k2);
  const row3 = chain.rows.find(r => r.strike === target.k3);
  if (!row1 || !row2 || !row3) return null;

  const p1 = side === 'CE' ? row1.ce.ltp : row1.pe.ltp;
  const p2 = side === 'CE' ? row2.ce.ltp : row2.pe.ltp;
  const p3 = side === 'CE' ? row3.ce.ltp : row3.pe.ltp;
  const netRaw = butterflyType.startsWith('Long')
    ? ((2 * p2) - p1 - p3)
    : (p1 + p3 - (2 * p2));
  const scaled = perLot ? lotSize : 1;
  return {
    net: netRaw * scaled,
    spot: chain.spot || 0,
    label: `${target.k1.toFixed(0)}-${target.k2.toFixed(0)}-${target.k3.toFixed(0)}`,
  };
}

function sideLabel(side: 'buy' | 'sell') {
  return side === 'buy' ? 'Buy' : 'Sell';
}

function optionTypeForButterfly(type: ButterflyType): 'CE' | 'PE' {
  return type.includes('Call') ? 'CE' : 'PE';
}

function buildButterflyLegs(type: ButterflyType, k1: number, k2: number, k3: number, p1: number, p2: number, p3: number): [ButterflyLeg, ButterflyLeg, ButterflyLeg] {
  const isLong = type.startsWith('Long');
  return [
    { strike: k1, premium: p1, side: isLong ? 'buy' : 'sell', qty: 1 },
    { strike: k2, premium: p2, side: isLong ? 'sell' : 'buy', qty: 2 },
    { strike: k3, premium: p3, side: isLong ? 'buy' : 'sell', qty: 1 },
  ];
}

function legPnlAtExpiry(leg: ButterflyLeg, spot: number, optionType: 'CE' | 'PE'): number {
  const intrinsic = optionType === 'CE' ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
  if (leg.side === 'buy') return (intrinsic - leg.premium) * leg.qty;
  return (leg.premium - intrinsic) * leg.qty;
}

function strategyNetCashflow(legs: ButterflyLeg[]): number {
  return legs.reduce((sum, leg) => sum + (leg.side === 'buy' ? -leg.premium : leg.premium) * leg.qty, 0);
}

function estimateExtremesAndBreakevens(legs: ButterflyLeg[], optionType: 'CE' | 'PE', k1: number, k3: number, gap: number) {
  const minSpot = Math.max(0, k1 - gap * 3);
  const maxSpot = k3 + gap * 3;
  const step = Math.max(1, Math.floor(gap / 10));
  const points: Array<{ s: number; p: number }> = [];

  for (let s = minSpot; s <= maxSpot; s += step) {
    const pnl = legs.reduce((acc, leg) => acc + legPnlAtExpiry(leg, s, optionType), 0);
    points.push({ s, p: pnl });
  }

  let maxProfit = Number.NEGATIVE_INFINITY;
  let maxLoss = Number.POSITIVE_INFINITY;
  for (const pt of points) {
    if (pt.p > maxProfit) maxProfit = pt.p;
    if (pt.p < maxLoss) maxLoss = pt.p;
  }

  const breakevens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.p === 0) breakevens.push(a.s);
    if ((a.p < 0 && b.p > 0) || (a.p > 0 && b.p < 0)) {
      const t = Math.abs(a.p) / (Math.abs(a.p) + Math.abs(b.p));
      breakevens.push(a.s + (b.s - a.s) * t);
    }
  }

  const sorted = breakevens.sort((x, y) => x - y);
  return {
    maxProfit: Number.isFinite(maxProfit) ? maxProfit : 0,
    maxLoss: Number.isFinite(maxLoss) ? maxLoss : 0,
    beLow: sorted[0] ?? 0,
    beHigh: sorted[sorted.length - 1] ?? 0,
  };
}

interface SummaryMetricCardProps {
  title: string;
  subtitle: string;
  callValue: number;
  putValue: number;
  callChgValue?: number;
  putChgValue?: number;
  pcr: number;
  formatValue: (value: number) => string;
  ringMode?: 'standard' | 'signed';
  trendHistory?: SummaryTrendPoint[];
  trendChgHistory?: SummaryTrendPoint[];
  compact?: boolean;
}

interface SummaryTrendPoint {
  ts: number;
  call: number;
  put: number;
}

function normalizeSummaryTrendHistory(points: SummaryTrendPoint[], maxPoints = 480): SummaryTrendPoint[] {
  const byMinute = new Map<number, SummaryTrendPoint>();
  for (const point of points) {
    const ts = Math.floor((point.ts ?? 0) / 60000) * 60000;
    byMinute.set(ts, {
      ts,
      call: point.call ?? 0,
      put: point.put ?? 0,
    });
  }
  const normalized = [...byMinute.values()].sort((a, b) => a.ts - b.ts);
  return normalized.length > maxPoints ? normalized.slice(normalized.length - maxPoints) : normalized;
}

function resolveIntradayTradingDate(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(now).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hh = Number(parts.hour ?? '0');
  const mm = Number(parts.minute ?? '0');
  const isWeekend = parts.weekday === 'Sun' || parts.weekday === 'Sat';
  if (isWeekend || hh < 9 || (hh === 9 && mm < 15)) return prevTradingDate(date);
  return date;
}

function appendSummaryTrendPoint(
  prev: SummaryTrendPoint[],
  callValue: number,
  putValue: number,
  maxPoints = 480,
): SummaryTrendPoint[] {
  const ts = Math.floor(Date.now() / 60000) * 60000;
  const next = normalizeSummaryTrendHistory(prev, maxPoints);
  const last = next[next.length - 1];
  if (last && last.ts === ts) {
    next[next.length - 1] = { ts, call: callValue, put: putValue };
  } else {
    next.push({ ts, call: callValue, put: putValue });
  }
  return normalizeSummaryTrendHistory(next, maxPoints);
}

function formatSummaryTrendTimestamp(tsSec: number | null) {
  if (!tsSec) return '--';
  return new Date(tsSec * 1000).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toSummaryTrendTsSec(value: Time | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'year' in value && 'month' in value && 'day' in value) {
    return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000);
  }
  return null;
}

function SummaryMetricTrend({
  callValue,
  putValue,
  callChgValue = 0,
  putChgValue = 0,
  formatValue,
  initialHistory,
  initialChgHistory,
}: {
  callValue: number;
  putValue: number;
  callChgValue?: number;
  putChgValue?: number;
  formatValue: (value: number) => string;
  initialHistory?: SummaryTrendPoint[];
  initialChgHistory?: SummaryTrendPoint[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const callSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const putSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const initialFitDoneRef = useRef(false);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [showChg, setShowChg] = useState(false);
  const [history, setHistory] = useState<SummaryTrendPoint[]>(
    initialHistory && initialHistory.length > 0
      ? appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialHistory), callValue, putValue)
      : [{ ts: Math.floor(Date.now() / 60000) * 60000, call: callValue, put: putValue }],
  );
  const [chgHistory, setChgHistory] = useState<SummaryTrendPoint[]>(() =>
    initialChgHistory && initialChgHistory.length > 0
      ? appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialChgHistory), callChgValue, putChgValue)
      : [{ ts: Math.floor(Date.now() / 60000) * 60000, call: callChgValue, put: putChgValue }],
  );

  useEffect(() => {
    if (initialHistory && initialHistory.length > 0) {
      setHistory(appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialHistory), callValue, putValue));
      // full day history just arrived — reset fit so chart zooms out to show all of it
      initialFitDoneRef.current = false;
      return;
    }
    setHistory([{ ts: Math.floor(Date.now() / 60000) * 60000, call: callValue, put: putValue }]);
  }, [initialHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialChgHistory && initialChgHistory.length > 0) {
      setChgHistory(appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialChgHistory), callChgValue, putChgValue));
      return;
    }
    setChgHistory([{ ts: Math.floor(Date.now() / 60000) * 60000, call: callChgValue, put: putChgValue }]);
  }, [initialChgHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      width: Math.max(host.clientWidth, 120),
      height: 96,
      layout: {
        background: { color: 'transparent' },
        textColor: '#90a7cb',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.1)' },
      },
      rightPriceScale: {
        visible: false,
        borderVisible: false,
      },
      leftPriceScale: {
        visible: false,
        borderVisible: false,
      },
      timeScale: {
        visible: false,
        borderVisible: false,
        secondsVisible: false,
        timeVisible: true,
        rightOffset: 1,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        vertLine: {
          visible: true,
          labelVisible: false,
          color: 'rgba(214, 226, 255, 0.42)',
          width: 1,
          style: 2,
        },
        horzLine: {
          visible: true,
          labelVisible: false,
          color: 'rgba(214, 226, 255, 0.22)',
          width: 1,
          style: 2,
        },
      },
      handleScroll: false,
      handleScale: false,
    });

    const callSeries = chart.addSeries(LineSeries, {
      color: '#1fe0af',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBorderColor: '#10251e',
      crosshairMarkerBackgroundColor: '#1fe0af',
    });

    const putSeries = chart.addSeries(LineSeries, {
      color: '#ff6f91',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBorderColor: '#2b1420',
      crosshairMarkerBackgroundColor: '#ff6f91',
    });

    callSeries.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0.12 } });
    putSeries.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0.12 } });

    chartRef.current = chart;
    callSeriesRef.current = callSeries;
    putSeriesRef.current = putSeries;

    chart.subscribeCrosshairMove(param => {
      const directTime = toSummaryTrendTsSec(param.time);
      if (directTime != null) {
        setHoveredTime(directTime);
        return;
      }
      if (param.point) {
        const coordinateTime = toSummaryTrendTsSec(chart.timeScale().coordinateToTime(param.point.x));
        if (coordinateTime != null) {
          setHoveredTime(coordinateTime);
          return;
        }
      }
      setHoveredTime(null);
    });

    const resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      chart.applyOptions({ width: Math.max(Math.floor(entry.contentRect.width), 120) });
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      callSeriesRef.current = null;
      putSeriesRef.current = null;
      initialFitDoneRef.current = false;
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, []);

  const normalizedHistory    = useMemo(() => normalizeSummaryTrendHistory(history),    [history]);
  const normalizedChgHistory = useMemo(() => normalizeSummaryTrendHistory(chgHistory), [chgHistory]);

  const activeHistory = showChg ? normalizedChgHistory : normalizedHistory;

  const chartData = useMemo(() => ({
    call: activeHistory.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.call })),
    put:  activeHistory.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.put  })),
  }), [activeHistory]);

  const displayPoint = useMemo(() => {
    if (activeHistory.length === 0) return null;
    if (hoveredTime != null) {
      const hoveredMs = hoveredTime * 1000;
      for (let idx = activeHistory.length - 1; idx >= 0; idx -= 1) {
        if (activeHistory[idx].ts <= hoveredMs) return activeHistory[idx];
      }
    }
    return activeHistory[activeHistory.length - 1];
  }, [activeHistory, hoveredTime]);

  const displayTime = displayPoint ? Math.floor(displayPoint.ts / 1000) : null;

  // track previous showChg to detect mode switch
  const prevShowChgRef = useRef(showChg);

  useEffect(() => {
    callSeriesRef.current?.setData(chartData.call);
    putSeriesRef.current?.setData(chartData.put);
    const modeChanged = prevShowChgRef.current !== showChg;
    prevShowChgRef.current = showChg;
    // fitContent only on first load or when toggling between OI / CHG mode
    if (!initialFitDoneRef.current || modeChanged) {
      if (chartData.call.length > 0 || chartData.put.length > 0) {
        chartRef.current?.timeScale().fitContent();
        initialFitDoneRef.current = true;
      }
    }
  }, [chartData, showChg]);

  const fmtChg = (v: number) => {
    const abs = Math.abs(v);
    const sign = v >= 0 ? '+' : '-';
    if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)}L`;
    return `${sign}${abs.toLocaleString('en-IN')}`;
  };

  return (
    <div className={s.summaryTrendInline}>
      <div className={s.summaryTrendChartWrap}>
        {/* toggle pill */}
        <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 2, display: 'flex', gap: 2, background: 'rgba(0,0,0,0.45)', borderRadius: 5, padding: '2px 3px' }}>
          <button
            type="button"
            onClick={() => setShowChg(false)}
            style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background: !showChg ? '#2563eb' : 'transparent', color: !showChg ? '#fff' : '#6b7280', letterSpacing: '0.04em' }}
          >OI</button>
          <button
            type="button"
            onClick={() => setShowChg(true)}
            style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background: showChg ? '#2563eb' : 'transparent', color: showChg ? '#fff' : '#6b7280', letterSpacing: '0.04em' }}
          >CHG</button>
        </div>
        <div ref={hostRef} className={s.summaryTrendChart} aria-hidden="true" />
      </div>
      <div className={s.summaryTrendInlineMeta}>
        <span className={s.summaryTrendCaption}>{showChg ? 'OI change' : (history.length > 2 ? 'Session trend' : 'Live trend')}</span>
        <span className={s.summaryTrendTime}>{formatSummaryTrendTimestamp(displayTime)}</span>
        <span className={s.summaryTrendLive}>{hoveredTime != null ? 'INSPECT' : 'LIVE'}</span>
      </div>
      <div className={s.summaryTrendValues}>
        {showChg ? (
          <>
            <span className={`${s.summaryTrendValuePill} ${s.summaryTrendValueCall}`}>CE {fmtChg(displayPoint?.call ?? callChgValue)}</span>
            <span className={`${s.summaryTrendValuePill} ${s.summaryTrendValuePut}`}>PE {fmtChg(displayPoint?.put ?? putChgValue)}</span>
            {(() => {
              const c = displayPoint?.call ?? callChgValue;
              const p = displayPoint?.put  ?? putChgValue;
              const chgPcr = c !== 0 ? p / c : null;
              return chgPcr != null ? (
                <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                  PCR {fmtRatio(chgPcr)}
                </span>
              ) : null;
            })()}
          </>
        ) : (
          <>
            <span className={`${s.summaryTrendValuePill} ${s.summaryTrendValueCall}`}>CE {formatValue(displayPoint?.call ?? callValue)}</span>
            <span className={`${s.summaryTrendValuePill} ${s.summaryTrendValuePut}`}>PE {formatValue(displayPoint?.put ?? putValue)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryMetricPie({
  callValue,
  putValue,
  ringMode,
}: {
  callValue: number;
  putValue: number;
  ringMode: 'standard' | 'signed';
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const call = ringMode === 'signed' ? Math.abs(callValue) : Math.max(callValue, 0);
    const put = ringMode === 'signed' ? Math.abs(putValue) : Math.max(putValue, 0);
    const data = [
      { category: 'Call', value: call, color: am5.color(0x1fe0af) },
      { category: 'Put', value: put, color: am5.color(0xff6f91) },
    ];

    const root = am5.Root.new(host);

    const chart = root.container.children.push(
      am5percent.PieChart.new(root, {
        layout: root.verticalLayout,
        innerRadius: am5.percent(68),
        startAngle: -90,
        endAngle: 270,
      }),
    );

    const series = chart.series.push(
      am5percent.PieSeries.new(root, {
        valueField: 'value',
        categoryField: 'category',
        alignLabels: false,
        startAngle: -90,
        endAngle: 270,
      }),
    );

    series.slices.template.setAll({
      strokeOpacity: 0,
      cornerRadius: 6,
      shadowColor: am5.color(0x000000),
      shadowBlur: 10,
      shadowOffsetX: 0,
      shadowOffsetY: 2,
      shadowOpacity: 0.18,
    });
    series.slices.template.adapters.add('fill', (_, target) => (
      (target.dataItem?.dataContext as { color?: am5.Color } | undefined)?.color ?? am5.color(0x516079)
    ));
    series.slices.template.adapters.add('stroke', (_, target) => (
      (target.dataItem?.dataContext as { color?: am5.Color } | undefined)?.color ?? am5.color(0x516079)
    ));
    series.labels.template.setAll({ forceHidden: true });
    series.ticks.template.setAll({ forceHidden: true });

    series.data.setAll(data);

    return () => {
      root.dispose();
    };
  }, [callValue, putValue, ringMode]);

  return <div ref={hostRef} className={s.summaryPieHost} aria-hidden="true" />;
}

function SummaryMetricCard({
  title,
  subtitle,
  callValue,
  putValue,
  callChgValue,
  putChgValue,
  pcr,
  formatValue,
  ringMode = 'standard',
  trendHistory,
  trendChgHistory,
  compact = false,
}: SummaryMetricCardProps) {
  const ringCallValue = ringMode === 'signed' ? Math.abs(callValue) : Math.max(callValue, 0);
  const ringPutValue = ringMode === 'signed' ? Math.abs(putValue) : Math.max(putValue, 0);
  const totalLabel = formatValue(callValue + putValue);
  const centerScale = totalLabel.length > 10 ? 0.72 : totalLabel.length > 8 ? 0.82 : totalLabel.length > 6 ? 0.92 : 1;

  if (compact) {
    return (
      <article className={`${s.summaryCard} ${s.summaryCardCompact}`}>
        <div className={s.summaryCardCompactHeader}>
          <span className={s.summaryCardTitle}>{title}</span>
          <span className={s.summaryPcrChipSm}>PCR {fmtRatio(pcr)}</span>
        </div>
        <div className={s.summaryCardCompactBody}>
          <div className={s.summaryCompactRow}>
            <span className={`${s.summaryLegendDot} ${s.summaryLegendDotCall}`} />
            <span className={s.summaryCompactLabel}>CE</span>
            <span className={s.summaryCompactValue}>{formatValue(callValue)}</span>
          </div>
          <div className={s.summaryCompactRow}>
            <span className={`${s.summaryLegendDot} ${s.summaryLegendDotPut}`} />
            <span className={s.summaryCompactLabel}>PE</span>
            <span className={s.summaryCompactValue}>{formatValue(putValue)}</span>
          </div>
          <div className={s.summaryCompactTotal}>
            <span className={s.summaryCompactTotalLabel}>Total</span>
            <span className={s.summaryCompactTotalValue}>{totalLabel}</span>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={s.summaryCard}>
      <div className={s.summaryCardTop}>
        <div>
          <div className={s.summaryCardTitle}>{title}</div>
          <div className={s.summaryCardSubtitle}>{subtitle}</div>
        </div>
        <div className={s.summaryPcrChip}>PCR {fmtRatio(pcr)}</div>
      </div>

      <div className={`${s.summaryCardBody} ${trendHistory ? s.summaryCardBodyWithTrend : ''}`}>
        <div className={s.summaryDonutWrap}>
          <SummaryMetricPie callValue={ringCallValue} putValue={ringPutValue} ringMode={ringMode} />
          <div className={s.summaryDonutCenter}>
            <span className={s.summaryDonutCenterLabel}>Total</span>
            <strong
              className={s.summaryDonutCenterValue}
              style={{ transform: `scale(${centerScale})` }}
            >
              {totalLabel}
            </strong>
          </div>
        </div>

        <div className={s.summaryLegend}>
          <div className={s.summaryLegendItem}>
            <span className={`${s.summaryLegendDot} ${s.summaryLegendDotCall}`} />
            <div>
              <div className={s.summaryLegendLabel}>Call</div>
              <div className={s.summaryLegendValue}>{formatValue(callValue)}</div>
            </div>
          </div>
          <div className={s.summaryLegendItem}>
            <span className={`${s.summaryLegendDot} ${s.summaryLegendDotPut}`} />
            <div>
              <div className={s.summaryLegendLabel}>Put</div>
              <div className={s.summaryLegendValue}>{formatValue(putValue)}</div>
            </div>
          </div>
        </div>

        {trendHistory && (
          <SummaryMetricTrend callValue={callValue} putValue={putValue} callChgValue={callChgValue} putChgValue={putChgValue} formatValue={formatValue} initialHistory={trendHistory} initialChgHistory={trendChgHistory} />
        )}
      </div>
    </article>
  );
}

function SelectControl({
  label,
  value,
  options,
  onChange,
  formatter,
  disabled,
}: {
  label: string;
  value: string | number;
  options: ReadonlyArray<string | number>;
  onChange: (next: string) => void;
  formatter?: (value: string | number) => string;
  disabled?: boolean;
}) {
  return (
    <label className={s.control}>
      <span className={s.controlLabel}>{label}</span>
      <select className={s.select} value={String(value)} onChange={e => onChange(e.target.value)} disabled={disabled}>
        {options.map(option => (
          <option key={String(option)} value={String(option)}>
            {formatter ? formatter(option) : String(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function SearchableScripSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: SymbolChoice[];
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return options.slice(0, 50);
    return options.filter(item =>
      item.sym.toUpperCase().includes(q) ||
      item.stockName.toUpperCase().includes(q) ||
      item.nubraName.toUpperCase().includes(q),
    ).slice(0, 50);
  }, [options, query]);

  const commit = (next: SymbolChoice) => {
    setQuery(next.sym);
    onChange(next.sym);
    setOpen(false);
  };

  return (
    <div className={s.searchableWrap} ref={wrapRef}>
      <label className={s.control}>
        <span className={s.controlLabel}>{label}</span>
        <input
          className={s.searchInput}
          value={query}
          disabled={disabled}
          placeholder="Type scrip..."
          onFocus={() => !disabled && setOpen(true)}
          onChange={event => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') setOpen(false);
            if (event.key === 'Enter' && filtered.length > 0) commit(filtered[0]);
          }}
        />
      </label>

      {open && !disabled && (
        <div className={s.searchDropdown}>
          {filtered.length > 0 ? (
            filtered.map(option => (
              <button
                key={`${option.sym}-${option.exchange}`}
                type="button"
                className={`${s.searchOption} ${option.sym === value ? s.searchOptionActive : ''}`}
                onMouseDown={event => {
                  event.preventDefault();
                  commit(option);
                }}
              >
                <span className={s.searchOptionMain}>{option.sym}</span>
                <span className={s.searchOptionSub}>{option.stockName || option.nubraName || option.exchange}</span>
              </button>
            ))
          ) : (
            <div className={s.searchEmpty}>No matching scrip</div>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnPicker({
  selected,
  onToggle,
}: {
  selected: ColumnKey[];
  onToggle: (key: ColumnKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <div className={s.searchableWrap} ref={wrapRef}>
      <label className={s.control}>
        <span className={s.controlLabel}>Columns</span>
        <button type="button" className={s.selectButton} onClick={() => setOpen(v => !v)}>
          <span>{selected.length} selected</span>
          <span className={s.selectCaret}>▾</span>
        </button>
      </label>

      {open && (
        <div className={s.columnDropdown}>
          {AVAILABLE_COLUMNS.map(option => {
            const checked = selected.includes(option.key);
            return (
              <label key={option.key} className={s.columnOption}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(option.key)}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function MasterOptionChain({ visible }: Props) {
  const { nubraInstruments } = useInstrumentsCtx();
  const allSymbols = useMemo(() => buildSuggestions(nubraInstruments), [nubraInstruments]);

  const [symbol, setSymbol] = useState(DEFAULT_SCRIP);
  const [exchange, setExchange] = useState('NSE');
  const [lotSize, setLotSize] = useState(1);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiries, setSelectedExpiries] = useState<string[]>(['', '', '']);
  const [strikeCount, setStrikeCount] = useState(5);
  const [perLot, setPerLot] = useState(false);
  const [selectedColumns, setSelectedColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [viewMode, setViewMode] = useState<ViewMode>('chain');
  const [straddleExpiry, setStraddleExpiry] = useState('');
  const [butterflyExpiry, setButterflyExpiry] = useState('');
  const [butterflyType, setButterflyType] = useState<ButterflyType>('Long Call');
  const [butterflyGap, setButterflyGap] = useState(1);
  const [butterflyCombinations, setButterflyCombinations] = useState(10);
  const [butterflyCenterStrike, setButterflyCenterStrike] = useState(0);
  const [ratioExpiry, setRatioExpiry] = useState('');
  const [ratioOptionType, setRatioOptionType] = useState<RatioOptionType>('Call');
  const [ratioBuyStrike, setRatioBuyStrike] = useState(0);
  const [ratioStrikeGap, setRatioStrikeGap] = useState(1);
  const [ratioRowsCount, setRatioRowsCount] = useState(15);
  const [ratioBuyQty, setRatioBuyQty] = useState(1);
  const [ratioSellQty, setRatioSellQty] = useState(3);
  const [chains, setChains] = useState<Record<string, ChainSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [straddleChartOpen, setStraddleChartOpen] = useState(false);
  const [straddleChartTarget, setStraddleChartTarget] = useState<StraddleChartTarget | null>(null);
  const [straddleChartData, setStraddleChartData] = useState<{
    straddle: LineData[];
    call: LineData[];
    put: LineData[];
    spot: LineData[];
    iv: LineData[];
    oi: LineData[];
    pcr: LineData[];
    rv: LineData[];
  }>({ straddle: [], call: [], put: [], spot: [], iv: [], oi: [], pcr: [], rv: [] });
  const [straddleChartLoading, setStraddleChartLoading] = useState(false);
  const [straddleChartError, setStraddleChartError] = useState('');
  const [straddleSeriesVisibility, setStraddleSeriesVisibility] = useState({
    straddle: true,
    spot: true,
    iv: true,
    rv: true,
    pcr: true,
    oi: true,
    call: false,
    put: false,
  });
  const [ratioChartOpen, setRatioChartOpen] = useState(false);
  const [ratioChartTarget, setRatioChartTarget] = useState<RatioChartTarget | null>(null);
  const [ratioChartData, setRatioChartData] = useState<{ pd: LineData[]; spot: LineData[] }>({ pd: [], spot: [] });
  const [ratioChartLoading, setRatioChartLoading] = useState(false);
  const [ratioChartError, setRatioChartError] = useState('');
  const [butterflyChartOpen, setButterflyChartOpen] = useState(false);
  const [butterflyChartTarget, setButterflyChartTarget] = useState<ButterflyChartTarget | null>(null);
  const [butterflyChartData, setButterflyChartData] = useState<{ net: LineData[]; spot: LineData[] }>({ net: [], spot: [] });
  const [butterflyChartLoading, setButterflyChartLoading] = useState(false);
  const [butterflyChartError, setButterflyChartError] = useState('');
  const [summaryOiTrendHistory, setSummaryOiTrendHistory] = useState<SummaryTrendPoint[]>([]);
  // Derived: OI change from start of day — each point = current_oi - first_oi_of_day
  const summaryOiChgHistory = useMemo<SummaryTrendPoint[]>(() => {
    if (summaryOiTrendHistory.length === 0) return [];
    const base = summaryOiTrendHistory[0];
    return summaryOiTrendHistory.map(p => ({
      ts: p.ts,
      call: p.call - base.call,
      put:  p.put  - base.put,
    }));
  }, [summaryOiTrendHistory]);
  const straddleHistoryCacheRef = useRef(new Map<string, { straddle: LineData[]; call: LineData[]; put: LineData[]; spot: LineData[]; iv: LineData[]; oi: LineData[]; pcr: LineData[]; rv: LineData[] }>());
  const butterflyHistoryCacheRef = useRef(new Map<string, { net: LineData[]; spot: LineData[] }>());
  const ratioHistoryCacheRef = useRef(new Map<string, { pd: LineData[]; spot: LineData[] }>());
  const straddleChartHostRef = useRef<HTMLDivElement | null>(null);
  const straddleChartRef = useRef<IChartApi | null>(null);
  const straddlePremiumSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const straddleCallSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const straddlePutSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const straddleSpotSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const straddleIvSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const straddleRvSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const straddleOiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const straddlePcrSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ratioChartHostRef = useRef<HTMLDivElement | null>(null);
  const ratioChartRef = useRef<IChartApi | null>(null);
  const ratioPdSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ratioSpotSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const butterflyChartHostRef = useRef<HTMLDivElement | null>(null);
  const butterflyChartRef = useRef<IChartApi | null>(null);
  const butterflyNetSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const butterflySpotSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const pickedExpiries = useMemo(
    () => selectedExpiries.filter(Boolean).filter((value, idx, arr) => arr.indexOf(value) === idx),
    [selectedExpiries],
  );

  const selectedSymbol = useMemo(
    () => allSymbols.find(item => item.sym.toUpperCase() === symbol.toUpperCase()) ?? null,
    [allSymbols, symbol],
  );

  useEffect(() => {
    if (selectedSymbol) {
      setExchange(selectedSymbol.exchange);
      setLotSize(selectedSymbol.lotSize);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    if (allSymbols.length === 0) return;
    const preferred = allSymbols.find(item => item.sym.toUpperCase() === DEFAULT_SCRIP);
    const initial = preferred ?? allSymbols[0];
    if (!initial) return;
    setSymbol(initial.sym);
    setExchange(initial.exchange);
    setLotSize(initial.lotSize);
  }, [allSymbols]);

  useEffect(() => {
    let cancelled = false;
    const loadExpiries = async () => {
      if (!symbol || !exchange) return;
      setError('');
      const resolved = resolveNubra(symbol, nubraInstruments);
      try {
        const nextExpiries = await fetchExpiries(resolved.nubraSym, resolved.exchange);
        if (cancelled) return;
        setExchange(resolved.exchange);
        setLotSize(resolved.lotSize);
        setExpiries(nextExpiries);
        setSelectedExpiries(prev => {
          const seeded = prev.map((value, idx) => (nextExpiries.includes(value) ? value : nextExpiries[idx] ?? ''));
          return seeded;
        });
      } catch (err: any) {
        if (!cancelled) {
          setExpiries([]);
          setSelectedExpiries(['', '', '']);
          setError(err?.message ?? 'Failed to load expiries');
        }
      }
    };
    loadExpiries();
    return () => { cancelled = true; };
  }, [symbol, exchange, nubraInstruments]);

  useEffect(() => {
    let cancelled = false;
    const session = getSession();
    const resolved = resolveNubra(symbol, nubraInstruments);

    const loadChains = async () => {
      if (!session || !resolved.nubraSym || pickedExpiries.length === 0) {
        setChains({});
        return;
      }
      setLoading(true);
      setError('');
      try {
        const entries = await Promise.all(
          pickedExpiries.map(async expiry => [expiry, await fetchOptionChainSnapshot(session, resolved.nubraSym, resolved.exchange, expiry)] as const),
        );
        if (cancelled) return;
        setChains(Object.fromEntries(entries));
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load option chain');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadChains();
    return () => { cancelled = true; };
  }, [symbol, pickedExpiries, nubraInstruments]);

  useEffect(() => {
    const session = getSession();
    const resolved = resolveNubra(symbol, nubraInstruments);
    if (!session || !resolved.nubraSym || pickedExpiries.length === 0 || !isMarketOpen()) return;

    const unsub = nubraBridge.subscribe({
      session,
      symbols: pickedExpiries.map(expiry => `${resolved.nubraSym}:${expiry}`),
      exchange: resolved.exchange,
      dataType: 'option',
      onMessage: (msg) => {
        if (msg.type !== 'option' || !(msg.data as any)?.expiry) return;
        const data = msg.data as any;
        const expiry = String(data.expiry);
        const liveSnap = buildChainSnapshotWs(data.ce ?? [], data.pe ?? [], data.at_the_money_strike ?? 0, data.current_price ?? 0);
        setChains(prev => ({
          ...prev,
          [expiry]: mergeChainSnapshot(prev[expiry], liveSnap),
        }));
      },
    });
    return unsub;
  }, [symbol, pickedExpiries, nubraInstruments]);

  const baseExpiry = pickedExpiries[0] ?? '';
  const primaryChain = baseExpiry ? chains[baseExpiry] : null;
  const callExpiries = useMemo(() => [...pickedExpiries].reverse(), [pickedExpiries]);
  const putExpiries = pickedExpiries;
  const callColumns = selectedColumns;
  const putColumns = useMemo(() => [...selectedColumns].reverse(), [selectedColumns]);

  const visibleRows = useMemo(() => {
    if (!primaryChain || primaryChain.rows.length === 0) return [];
    const atmIdx = nearestStrikeIndex(primaryChain.rows, primaryChain.atm || primaryChain.spot);
    const start = Math.max(0, atmIdx - strikeCount);
    const end = Math.min(primaryChain.rows.length, atmIdx + strikeCount + 1);
    const primarySlice = primaryChain.rows.slice(start, end);

    return primarySlice.map(row => {
      const byExpiry = pickedExpiries.map(expiry => {
        const chain = chains[expiry];
        const match = chain?.rows.find(item => item.strike === row.strike);
        return {
          expiry,
          strike: row.strike,
          ce: match?.ce ?? EMPTY_SIDE,
          pe: match?.pe ?? EMPTY_SIDE,
        };
      });
      return {
        strike: row.strike,
        isAtm: Math.abs(row.strike - (primaryChain.atm || primaryChain.spot)) < 0.5,
        byExpiry,
      };
    });
  }, [chains, pickedExpiries, primaryChain, strikeCount]);

  const straddleChain = straddleExpiry ? chains[straddleExpiry] : null;
  const straddleRows = useMemo<StraddleRow[]>(() => {
    if (!straddleChain || straddleChain.rows.length === 0) return [];
    const atmBase = straddleChain.atm || straddleChain.spot;
    const atmIdx = nearestStrikeIndex(straddleChain.rows, atmBase);
    const start = Math.max(0, atmIdx - strikeCount);
    const end = Math.min(straddleChain.rows.length, atmIdx + strikeCount + 1);
    const scale = perLot ? lotSize : 1;

    return straddleChain.rows.slice(start, end).map(row => {
      const callLtp = row.ce.ltp * scale;
      const putLtp = row.pe.ltp * scale;
      const straddlePrice = callLtp + putLtp;
      const previousPrice = (row.ce.cp + row.pe.cp) * scale;
      const priceChange = straddlePrice - previousPrice;
      const changePct = previousPrice > 0 ? (priceChange / previousPrice) * 100 : 0;
      const avgIv = avgPositive([row.ce.iv, row.pe.iv]);

      return {
        strike: row.strike,
        callLtp,
        putLtp,
        straddlePrice,
        priceChange,
        changePct,
        avgIv,
        callOi: row.ce.oi,
        putOi: row.pe.oi,
        netDelta: row.ce.delta + row.pe.delta,
        netTheta: row.ce.theta + row.pe.theta,
        netGamma: row.ce.gamma + row.pe.gamma,
        netVega: row.ce.vega + row.pe.vega,
        isAtm: Math.abs(row.strike - atmBase) < 0.5,
      };
    });
  }, [lotSize, perLot, strikeCount, straddleChain]);

  const straddleLivePoint = useMemo<StraddleLivePoint | null>(
    () => resolveStraddleLivePoint(straddleChain, straddleChartTarget, lotSize, perLot),
    [lotSize, perLot, straddleChain, straddleChartTarget],
  );

  useEffect(() => {
    if (!straddleChartOpen || !straddleChartTarget || !straddleExpiry || !symbol) return;
    let cancelled = false;

    const load = async () => {
      setStraddleChartLoading(true);
      setStraddleChartError('');
      try {
        const now = toIstDateTime();
        const startDateBase = isMarketOpen() ? now.date : prevTradingDate(now.date);
        const startDate = istToUtcIso(startDateBase, '09:15');
        const endDate = istToUtcIso(now.date, now.time);
        const ceName = buildNubraOptionName(symbol, straddleExpiry, straddleChartTarget.strike, 'CE');
        const peName = buildNubraOptionName(symbol, straddleExpiry, straddleChartTarget.strike, 'PE');
        const cacheKey = [
          symbol,
          exchange,
          straddleExpiry,
          straddleChartTarget.strike,
          perLot ? lotSize : 1,
          now.date,
        ].join('|');
        const cached = straddleHistoryCacheRef.current.get(cacheKey);
        if (cached) {
          setStraddleChartData(cached);
          setStraddleChartLoading(false);
          return;
        }
        const upper = symbol.toUpperCase();
        const isIndexUnderlying = nubraInstruments.some(i => {
          const assetType = (i.asset_type ?? '').toUpperCase();
          if (assetType !== 'INDEX_FO' && assetType !== 'INDEX') return false;
          return (
            (i.asset ?? '').toUpperCase() === upper ||
            (i.nubra_name ?? '').toUpperCase() === upper ||
            (i.stock_name ?? '').toUpperCase() === upper
          );
        });

        const [optHistory, spotRaw] = await Promise.all([
          fetchNubraMultiSeries(
            exchange,
            'OPT',
            [ceName, peName],
            ['close', 'iv_mid', 'cumulative_oi'],
            startDate,
            endDate,
            {
              close: raw => raw / 100,
              iv_mid: raw => raw * 100,
            },
          ),
          fetchNubraFieldSeries(exchange, isIndexUnderlying ? 'INDEX' : 'STOCK', symbol, 'close', startDate, endDate, raw => raw / 100),
        ]);
        if (cancelled) return;

        const ceClose = optHistory[ceName]?.close ?? [];
        const peClose = optHistory[peName]?.close ?? [];
        const ceIvMid = optHistory[ceName]?.iv_mid ?? [];
        const peIvMid = optHistory[peName]?.iv_mid ?? [];
        const ceCumOi = optHistory[ceName]?.cumulative_oi ?? [];
        const peCumOi = optHistory[peName]?.cumulative_oi ?? [];

        const scale = perLot ? lotSize : 1;
        const call = toSpotLine(ceClose.map(point => ({ ts: point.ts, v: point.v * scale })));
        const put = toSpotLine(peClose.map(point => ({ ts: point.ts, v: point.v * scale })));
        const straddle = toSpotLine(combinePairSeries(ceClose, peClose, (ce, pe) => (ce + pe) * scale));
        const spot = toSpotLine(spotRaw);
        const iv = toSpotLine(combinePairSeries(ceIvMid, peIvMid, (ce, pe) => (ce + pe) / 2));
        const oi = toMetricLine(combinePairSeries(ceCumOi, peCumOi, (ce, pe) => ce + pe));
        const pcr = toSpotLine(combinePairSeries(ceCumOi, peCumOi, (ce, pe) => (ce > 0 ? pe / ce : 0)));
        const rv = computeRV(spotRaw);

        if (straddle.length === 0 && call.length === 0 && put.length === 0 && spot.length === 0 && iv.length === 0 && oi.length === 0 && pcr.length === 0) {
          setStraddleChartError('No historical data returned for selected straddle');
        }
        const nextData = { straddle, call, put, spot, iv, oi, pcr, rv };
        straddleHistoryCacheRef.current.set(cacheKey, nextData);
        setStraddleChartData(nextData);
      } catch (err: any) {
        if (!cancelled) {
          setStraddleChartData({ straddle: [], call: [], put: [], spot: [], iv: [], oi: [], pcr: [], rv: [] });
          setStraddleChartError(err?.message ?? 'Failed to load straddle history');
        }
      } finally {
        if (!cancelled) setStraddleChartLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [
    exchange,
    lotSize,
    nubraInstruments,
    perLot,
    straddleChartOpen,
    straddleChartTarget,
    straddleExpiry,
    symbol,
  ]);

  useEffect(() => {
    if (viewMode !== 'straddle' || !straddleChartOpen || !straddleLivePoint) return;
    setStraddleChartData(prev => ({
      straddle: appendLivePointAny(prev.straddle, straddleLivePoint.straddle),
      call: appendLivePointAny(prev.call, straddleLivePoint.call),
      put: appendLivePointAny(prev.put, straddleLivePoint.put),
      spot: appendLivePointAny(prev.spot, straddleLivePoint.spot),
      iv: appendLivePointAny(prev.iv, straddleLivePoint.iv),
      oi: appendLiveMetricPointAny(prev.oi, straddleLivePoint.oi),
      pcr: appendLivePointAny(prev.pcr, straddleLivePoint.pcr),
      rv: computeRV(prev.spot.map(p => ({ ts: (p.time as number) * 1e9, v: p.value }))),
    }));
  }, [straddleChartOpen, straddleLivePoint, viewMode]);

  useEffect(() => {
    if (!straddleChartOpen || !straddleChartHostRef.current) return;
    const chart = createChart(straddleChartHostRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#0a0d12' },
        textColor: '#b6c2d9',
        panes: {
          separatorColor: 'rgba(255,255,255,0.08)',
          separatorHoverColor: 'rgba(255,255,255,0.22)',
          enableResize: true,
        },
      },
      grid: { vertLines: { color: '#242a34' }, horzLines: { color: '#242a34' } },
      rightPriceScale: { visible: true, borderColor: '#2d3643' },
      leftPriceScale: { visible: true, borderColor: '#2d3643' },
      timeScale: {
        borderColor: '#2d3643',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleTimeString('en-IN', {
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
      crosshair: { mode: 1 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const straddleSeries = chart.addSeries(LineSeries, {
      color: '#f7b84b',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Straddle',
      priceScaleId: 'left',
    }, 0);
    const callSeries = chart.addSeries(LineSeries, {
      color: '#48d6bb',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Call',
      priceScaleId: 'left',
      visible: false,
    }, 0);
    const putSeries = chart.addSeries(LineSeries, {
      color: '#ff6b91',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Put',
      priceScaleId: 'left',
      visible: false,
    }, 0);
    const spotSeries = chart.addSeries(LineSeries, {
      color: '#4ea1ff',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Spot',
      priceScaleId: 'right',
    }, 0);
    const ivSeries = chart.addSeries(LineSeries, {
      color: '#d083ff',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Avg IV',
      priceScaleId: 'iv',
      priceFormat: {
        type: 'custom',
        formatter: (value: number) => value.toFixed(2),
        minMove: 0.01,
      } as any,
    }, 1);
    const rvSeries = chart.addSeries(LineSeries, {
      color: '#f97316',
      lineWidth: 2,
      lineStyle: 1, // dashed
      priceLineVisible: false,
      title: 'RV (1h)',
      priceScaleId: 'left',
      priceFormat: {
        type: 'custom',
        formatter: (value: number) => value.toFixed(2),
        minMove: 0.01,
      } as any,
    }, 1);
    const pcrSeries = chart.addSeries(LineSeries, {
      color: '#ff8a5b',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'PCR',
      priceScaleId: 'pcr',
      priceFormat: {
        type: 'custom',
        formatter: (value: number) => value.toFixed(2),
        minMove: 0.01,
      } as any,
    }, 1);
    const oiSeries = chart.addSeries(LineSeries, {
      color: '#54d18f',
      lineWidth: 2,
      title: 'OI',
      priceScaleId: 'oi',
      priceLineVisible: false,
      priceFormat: {
        type: 'custom',
        formatter: (value: number) => fmtOi(value),
        minMove: 1,
      } as any,
    }, 1);

    chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    ivSeries.priceScale().applyOptions({ visible: true, borderColor: '#2d3643', scaleMargins: { top: 0.16, bottom: 0.18 } });
    pcrSeries.priceScale().applyOptions({ visible: true, borderColor: '#2d3643', scaleMargins: { top: 0.16, bottom: 0.18 } });
    oiSeries.priceScale().applyOptions({ visible: true, borderColor: '#2d3643', scaleMargins: { top: 0.16, bottom: 0.18 } });
    try { chart.panes()[1]?.setHeight(170); } catch {}

    straddleChartRef.current = chart;
    straddlePremiumSeriesRef.current = straddleSeries;
    straddleCallSeriesRef.current = callSeries;
    straddlePutSeriesRef.current = putSeries;
    straddleSpotSeriesRef.current = spotSeries;
    straddleIvSeriesRef.current = ivSeries;
    straddleRvSeriesRef.current = rvSeries;
    straddlePcrSeriesRef.current = pcrSeries;
    straddleOiSeriesRef.current = oiSeries;
    return () => {
      straddlePremiumSeriesRef.current = null;
      straddleCallSeriesRef.current = null;
      straddlePutSeriesRef.current = null;
      straddleSpotSeriesRef.current = null;
      straddleIvSeriesRef.current = null;
      straddleRvSeriesRef.current = null;
      straddlePcrSeriesRef.current = null;
      straddleOiSeriesRef.current = null;
      straddleChartRef.current = null;
      chart.remove();
    };
  }, [straddleChartOpen]);

  useEffect(() => {
    if (!straddleChartOpen) return;
    straddlePremiumSeriesRef.current?.setData(straddleChartData.straddle);
    straddleCallSeriesRef.current?.setData(straddleChartData.call);
    straddlePutSeriesRef.current?.setData(straddleChartData.put);
    straddleSpotSeriesRef.current?.setData(straddleChartData.spot);
    straddleIvSeriesRef.current?.setData(straddleChartData.iv);
    straddleRvSeriesRef.current?.setData(straddleChartData.rv);
    straddlePcrSeriesRef.current?.setData(straddleChartData.pcr);
    straddleOiSeriesRef.current?.setData(straddleChartData.oi);
  }, [straddleChartData, straddleChartOpen]);

  useEffect(() => {
    if (!straddleChartOpen) return;
    straddlePremiumSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.straddle });
    straddleCallSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.call });
    straddlePutSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.put });
    straddleSpotSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.spot });
    straddleIvSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.iv });
    straddleRvSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.rv });
    straddlePcrSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.pcr });
    straddleOiSeriesRef.current?.applyOptions({ visible: straddleSeriesVisibility.oi });
  }, [straddleChartOpen, straddleSeriesVisibility]);

  useEffect(() => {
    if (pickedExpiries.length === 0) {
      setStraddleExpiry('');
      return;
    }
    setStraddleExpiry(prev => (prev && pickedExpiries.includes(prev) ? prev : pickedExpiries[0]));
  }, [pickedExpiries]);

  useEffect(() => {
    if (pickedExpiries.length === 0) {
      setButterflyExpiry('');
      return;
    }
    setButterflyExpiry(prev => (prev && pickedExpiries.includes(prev) ? prev : pickedExpiries[0]));
  }, [pickedExpiries]);

  const butterflyChain = butterflyExpiry ? chains[butterflyExpiry] : null;
  const butterflyStrikes = useMemo(
    () => (butterflyChain?.rows ?? []).map(row => row.strike),
    [butterflyChain],
  );

  useEffect(() => {
    if (!butterflyChain || butterflyChain.rows.length === 0) {
      setButterflyCenterStrike(0);
      return;
    }
    const atmIdx = nearestStrikeIndex(butterflyChain.rows, butterflyChain.atm || butterflyChain.spot);
    const atmStrike = butterflyChain.rows[atmIdx]?.strike ?? 0;
    setButterflyCenterStrike(prev => (prev && butterflyStrikes.includes(prev) ? prev : atmStrike));
  }, [butterflyChain, butterflyStrikes]);

  useEffect(() => {
    if (butterflyGap < 1) setButterflyGap(1);
    if (butterflyCombinations < 1) setButterflyCombinations(1);
  }, [butterflyGap, butterflyCombinations]);

  const butterflyRows = useMemo<ButterflyRow[]>(() => {
    if (!butterflyChain || butterflyStrikes.length < 3 || butterflyCenterStrike <= 0) return [];
    const centerIdx = butterflyStrikes.findIndex(sk => sk === butterflyCenterStrike);
    if (centerIdx < 0) return [];

    const side = optionTypeForButterfly(butterflyType);
    const rows: ButterflyRow[] = [];
    // Build rolling butterflies: selected strike is the first center, then move by strike-gap per combo.
    // Example (gap=1): 23950-24000-24050, then 24000-24050-24100, ...
    for (let combo = 0; combo < butterflyCombinations; combo++) {
      const midIdx = centerIdx + combo * butterflyGap;
      const leftIdx = midIdx - butterflyGap;
      const rightIdx = midIdx + butterflyGap;
      if (leftIdx < 0 || rightIdx >= butterflyStrikes.length) break;

      const k1 = butterflyStrikes[leftIdx];
      const k2 = butterflyStrikes[midIdx];
      const k3 = butterflyStrikes[rightIdx];
      const row1 = butterflyChain.rows.find(r => r.strike === k1);
      const row2 = butterflyChain.rows.find(r => r.strike === k2);
      const row3 = butterflyChain.rows.find(r => r.strike === k3);
      if (!row1 || !row2 || !row3) continue;

      const p1 = side === 'CE' ? row1.ce.ltp : row1.pe.ltp;
      const p2 = side === 'CE' ? row2.ce.ltp : row2.pe.ltp;
      const p3 = side === 'CE' ? row3.ce.ltp : row3.pe.ltp;
      const legs = buildButterflyLegs(butterflyType, k1, k2, k3, p1, p2, p3);
      const netRaw = butterflyType.startsWith('Long')
        ? ((2 * p2) - p1 - p3)
        : (p1 + p3 - (2 * p2));
      const stats = estimateExtremesAndBreakevens(legs, side, k1, k3, butterflyGap);

      const scaled = perLot ? lotSize : 1;
      const maxProfit = stats.maxProfit * scaled;
      const maxLossAbs = Math.abs(stats.maxLoss * scaled);
      const rr = maxLossAbs > 0 ? `1:${(Math.abs(maxProfit) / maxLossAbs).toFixed(2)}` : '—';

      rows.push({
        k1,
        k2,
        k3,
        p1: p1 * scaled,
        p2: p2 * scaled,
        p3: p3 * scaled,
        net: netRaw * scaled,
        maxProfit,
        maxLoss: stats.maxLoss * scaled,
        riskReward: rr,
        beLow: stats.beLow,
        beHigh: stats.beHigh,
      });
    }

    return rows;
  }, [butterflyChain, butterflyCenterStrike, butterflyCombinations, butterflyGap, butterflyStrikes, butterflyType, lotSize, perLot]);

  const butterflyLivePoint = useMemo<ButterflyLivePoint | null>(
    () => resolveButterflyLivePoint(butterflyChain, butterflyChartTarget, butterflyType, lotSize, perLot),
    [butterflyChain, butterflyChartTarget, butterflyType, lotSize, perLot],
  );

  useEffect(() => {
    if (!butterflyChartOpen || !butterflyChartTarget || !butterflyExpiry || !symbol) return;
    let cancelled = false;

    const load = async () => {
      setButterflyChartLoading(true);
      setButterflyChartError('');
      try {
        const now = toIstDateTime();
        const startDateBase = isMarketOpen() ? now.date : prevTradingDate(now.date);
        const startDate = istToUtcIso(startDateBase, '09:15');
        const endDate = istToUtcIso(now.date, now.time);
        const side = optionTypeForButterfly(butterflyType);
        const scale = perLot ? lotSize : 1;
        const n1 = buildNubraOptionName(symbol, butterflyExpiry, butterflyChartTarget.k1, side);
        const n2 = buildNubraOptionName(symbol, butterflyExpiry, butterflyChartTarget.k2, side);
        const n3 = buildNubraOptionName(symbol, butterflyExpiry, butterflyChartTarget.k3, side);
        const cacheKey = [
          symbol,
          exchange,
          butterflyExpiry,
          butterflyType,
          butterflyChartTarget.k1,
          butterflyChartTarget.k2,
          butterflyChartTarget.k3,
          scale,
          now.date,
        ].join('|');
        const cached = butterflyHistoryCacheRef.current.get(cacheKey);
        if (cached) {
          setButterflyChartData(cached);
          setButterflyChartLoading(false);
          return;
        }
        const upper = symbol.toUpperCase();
        const isIndexUnderlying = nubraInstruments.some(i => {
          const assetType = (i.asset_type ?? '').toUpperCase();
          if (assetType !== 'INDEX_FO' && assetType !== 'INDEX') return false;
          return (
            (i.asset ?? '').toUpperCase() === upper ||
            (i.nubra_name ?? '').toUpperCase() === upper ||
            (i.stock_name ?? '').toUpperCase() === upper
          );
        });

        const [optHistory, spotRaw] = await Promise.all([
          fetchNubraMultiSeries(
            exchange,
            'OPT',
            [n1, n2, n3],
            ['close'],
            startDate,
            endDate,
            { close: raw => raw / 100 },
          ),
          fetchNubraFieldSeries(exchange, isIndexUnderlying ? 'INDEX' : 'STOCK', symbol, 'close', startDate, endDate, raw => raw / 100),
        ]);
        if (cancelled) return;

        const p1 = optHistory[n1]?.close ?? [];
        const p2 = optHistory[n2]?.close ?? [];
        const p3 = optHistory[n3]?.close ?? [];

        const net = buildButterflyNetLine(p1, p2, p3, butterflyType, scale);
        const spot = toSpotLine(spotRaw);
        if (net.length === 0 && spot.length === 0) {
          setButterflyChartError('No historical data returned for selected butterfly combo');
        }
        const nextData = { net, spot };
        butterflyHistoryCacheRef.current.set(cacheKey, nextData);
        setButterflyChartData(nextData);
      } catch (err: any) {
        if (!cancelled) {
          setButterflyChartData({ net: [], spot: [] });
          setButterflyChartError(err?.message ?? 'Failed to load butterfly history');
        }
      } finally {
        if (!cancelled) setButterflyChartLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [
    butterflyChartOpen,
    butterflyChartTarget,
    butterflyExpiry,
    butterflyType,
    exchange,
    lotSize,
    nubraInstruments,
    perLot,
    symbol,
  ]);

  useEffect(() => {
    if (viewMode !== 'butterfly' || !butterflyChartOpen || !butterflyLivePoint) return;
    setButterflyChartData(prev => ({
      net: appendLivePointAny(prev.net, butterflyLivePoint.net),
      spot: appendLivePointAny(prev.spot, butterflyLivePoint.spot),
    }));
  }, [butterflyChartOpen, butterflyLivePoint, viewMode]);

  useEffect(() => {
    if (!butterflyChartOpen || !butterflyChartHostRef.current) return;
    const chart = createChart(butterflyChartHostRef.current, {
      autoSize: true,
      layout: { background: { color: '#0a0d12' }, textColor: '#b6c2d9' },
      grid: { vertLines: { color: '#242a34' }, horzLines: { color: '#242a34' } },
      rightPriceScale: { visible: true, borderColor: '#2d3643' },
      leftPriceScale: { visible: true, borderColor: '#2d3643' },
      timeScale: {
        borderColor: '#2d3643',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleTimeString('en-IN', {
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
      crosshair: { mode: 1 },
    });

    const netSeries = chart.addSeries(LineSeries, {
      color: '#f7b84b',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Net Dr/Cr',
      priceScaleId: 'right',
    });
    const spotSeries = chart.addSeries(LineSeries, {
      color: '#4ea1ff',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Spot',
      priceScaleId: 'left',
    });
    netSeries.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
    spotSeries.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });

    butterflyChartRef.current = chart;
    butterflyNetSeriesRef.current = netSeries;
    butterflySpotSeriesRef.current = spotSeries;
    return () => {
      butterflyNetSeriesRef.current = null;
      butterflySpotSeriesRef.current = null;
      butterflyChartRef.current = null;
      chart.remove();
    };
  }, [butterflyChartOpen]);

  useEffect(() => {
    if (!butterflyChartOpen) return;
    butterflyNetSeriesRef.current?.setData(butterflyChartData.net);
    butterflySpotSeriesRef.current?.setData(butterflyChartData.spot);
  }, [butterflyChartData, butterflyChartOpen]);

  useEffect(() => {
    if (viewMode === 'straddle') return;
    setStraddleChartOpen(false);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === 'butterfly') return;
    setButterflyChartOpen(false);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === 'ratio') return;
    setRatioChartOpen(false);
  }, [viewMode]);

  useEffect(() => {
    if (pickedExpiries.length === 0) {
      setRatioExpiry('');
      return;
    }
    setRatioExpiry(prev => (prev && pickedExpiries.includes(prev) ? prev : pickedExpiries[0]));
  }, [pickedExpiries]);

  const ratioChain = ratioExpiry ? chains[ratioExpiry] : null;
  const ratioStrikes = useMemo(
    () => (ratioChain?.rows ?? []).map(row => row.strike),
    [ratioChain],
  );

  useEffect(() => {
    if (!ratioChain || ratioChain.rows.length === 0) {
      setRatioBuyStrike(0);
      return;
    }
    const atmIdx = nearestStrikeIndex(ratioChain.rows, ratioChain.atm || ratioChain.spot);
    const atmStrike = ratioChain.rows[atmIdx]?.strike ?? 0;
    setRatioBuyStrike(prev => (prev && ratioStrikes.includes(prev) ? prev : atmStrike));
  }, [ratioChain, ratioStrikes]);

  const ratioRows = useMemo<RatioRow[]>(() => {
    if (!ratioChain || ratioStrikes.length < 2 || ratioBuyStrike <= 0) return [];
    const side: 'CE' | 'PE' = ratioOptionType === 'Call' ? 'CE' : 'PE';
    const startIdx = ratioStrikes.findIndex(sk => sk === ratioBuyStrike);
    if (startIdx < 0) return [];

    const scaled = perLot ? lotSize : 1;
    const out: RatioRow[] = [];
    for (let i = 0; i < ratioRowsCount; i++) {
      const buyIdx = startIdx + i * ratioStrikeGap;
      const sellIdx = buyIdx + ratioStrikeGap;
      if (buyIdx < 0 || sellIdx >= ratioStrikes.length) break;

      const buyStrike = ratioStrikes[buyIdx];
      const sellStrike = ratioStrikes[sellIdx];
      const buyRow = ratioChain.rows.find(r => r.strike === buyStrike);
      const sellRow = ratioChain.rows.find(r => r.strike === sellStrike);
      if (!buyRow || !sellRow) continue;

      const buy = side === 'CE' ? buyRow.ce : buyRow.pe;
      const sell = side === 'CE' ? sellRow.ce : sellRow.pe;
      const buyLtp = buy.ltp * scaled;
      const sellLtp = sell.ltp * scaled;
      const pd = (sellLtp * ratioSellQty) - (buyLtp * ratioBuyQty);

      out.push({
        srNo: out.length + 1,
        buyStrike,
        sellStrike,
        buyLtp,
        sellLtp,
        buyDelta: buy.delta,
        buyTheta: buy.theta,
        sellDelta: sell.delta,
        sellTheta: sell.theta,
        pd,
      });
    }
    return out;
  }, [lotSize, perLot, ratioBuyQty, ratioBuyStrike, ratioChain, ratioOptionType, ratioRowsCount, ratioSellQty, ratioStrikeGap, ratioStrikes]);

  const ratioLivePoint = useMemo(
    () => resolveRatioLivePoint(ratioChain, ratioChartTarget, ratioOptionType, lotSize, perLot, ratioBuyQty, ratioSellQty),
    [lotSize, perLot, ratioBuyQty, ratioChain, ratioChartTarget, ratioOptionType, ratioSellQty],
  );

  useEffect(() => {
    if (!ratioChartOpen || !ratioChartTarget || !ratioExpiry || !symbol) return;
    let cancelled = false;

    const load = async () => {
      setRatioChartLoading(true);
      setRatioChartError('');
      try {
        const now = toIstDateTime();
        const startDateBase = isMarketOpen() ? now.date : prevTradingDate(now.date);
        const startDate = istToUtcIso(startDateBase, '09:15');
        const endDate = istToUtcIso(now.date, now.time);
        const side: 'CE' | 'PE' = ratioOptionType === 'Call' ? 'CE' : 'PE';
        const buyName = buildNubraOptionName(symbol, ratioExpiry, ratioChartTarget.buyStrike, side);
        const sellName = buildNubraOptionName(symbol, ratioExpiry, ratioChartTarget.sellStrike, side);
        const cacheKey = [
          symbol,
          exchange,
          ratioExpiry,
          ratioOptionType,
          ratioChartTarget.buyStrike,
          ratioChartTarget.sellStrike,
          ratioBuyQty,
          ratioSellQty,
          perLot ? lotSize : 1,
          now.date,
        ].join('|');
        const cached = ratioHistoryCacheRef.current.get(cacheKey);
        if (cached) {
          setRatioChartData(cached);
          setRatioChartLoading(false);
          return;
        }
        const upper = symbol.toUpperCase();
        const isIndexUnderlying = nubraInstruments.some(i => {
          const assetType = (i.asset_type ?? '').toUpperCase();
          if (assetType !== 'INDEX_FO' && assetType !== 'INDEX') return false;
          return (
            (i.asset ?? '').toUpperCase() === upper ||
            (i.nubra_name ?? '').toUpperCase() === upper ||
            (i.stock_name ?? '').toUpperCase() === upper
          );
        });

        const [optHistory, spotRaw] = await Promise.all([
          fetchNubraMultiSeries(
            exchange,
            'OPT',
            [buyName, sellName],
            ['close'],
            startDate,
            endDate,
            { close: raw => raw / 100 },
          ),
          fetchNubraFieldSeries(exchange, isIndexUnderlying ? 'INDEX' : 'STOCK', symbol, 'close', startDate, endDate, raw => raw / 100),
        ]);
        if (cancelled) return;

        const buyClose = optHistory[buyName]?.close ?? [];
        const sellClose = optHistory[sellName]?.close ?? [];

        const scale = perLot ? lotSize : 1;
        const pd = toSpotLine(combinePairSeries(
          buyClose,
          sellClose,
          (buy, sell) => ((sell * scale) * ratioSellQty) - ((buy * scale) * ratioBuyQty),
        ));
        const spot = toSpotLine(spotRaw);

        if (pd.length === 0 && spot.length === 0) {
          setRatioChartError('No historical data returned for selected ratio setup');
        }
        const nextData = { pd, spot };
        ratioHistoryCacheRef.current.set(cacheKey, nextData);
        setRatioChartData(nextData);
      } catch (err: any) {
        if (!cancelled) {
          setRatioChartData({ pd: [], spot: [] });
          setRatioChartError(err?.message ?? 'Failed to load ratio history');
        }
      } finally {
        if (!cancelled) setRatioChartLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [
    exchange,
    lotSize,
    nubraInstruments,
    perLot,
    ratioBuyQty,
    ratioChartOpen,
    ratioChartTarget,
    ratioExpiry,
    ratioOptionType,
    ratioSellQty,
    symbol,
  ]);

  useEffect(() => {
    if (viewMode !== 'ratio' || !ratioChartOpen || !ratioLivePoint) return;
    setRatioChartData(prev => ({
      pd: appendLivePointAny(prev.pd, ratioLivePoint.pd),
      spot: appendLivePointAny(prev.spot, ratioLivePoint.spot),
    }));
  }, [ratioChartOpen, ratioLivePoint, viewMode]);

  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const resolved = resolveNubra(symbol, nubraInstruments);
    const scopeExpiries = viewMode === 'chain'
      ? pickedExpiries
      : [viewMode === 'straddle' ? straddleExpiry : viewMode === 'butterfly' ? butterflyExpiry : ratioExpiry].filter(Boolean);

    const pollOiHistory = async () => {
      if (cancelled) return;
      if (!resolved.nubraSym || !resolved.exchange || scopeExpiries.length === 0) {
        setSummaryOiTrendHistory([]);
        return;
      }

      const chainValues = scopeExpiries.map(expiry => buildNubraChainValue(resolved.nubraSym, expiry));
      const tradingDate = resolveIntradayTradingDate();
      const startDate = istToUtcIso(tradingDate, '09:15');
      const endDate = new Date().toISOString(); // always "now" so each poll fetches up to current minute

      let backoff = 0;
      try {
        const merged = await fetchNubraChainOiHistory(resolved.exchange, chainValues, startDate, endDate);
        if (!cancelled) setSummaryOiTrendHistory(merged);
      } catch (e: any) {
        // on 403/429 back off 30 s so we don't keep hammering and stay blocked
        if (e?.status === 403 || e?.status === 429) backoff = 30_000;
        // keep existing data on error — don't clear the chart
      }

      // schedule next poll
      if (!cancelled) {
        const now = toIstDateTime();
        const [hh, mm] = now.time.split(':').map(Number);
        const istMin = hh * 60 + mm;
        const isMarketHours = istMin >= 9 * 60 + 15 && istMin <= 15 * 60 + 30;
        const base = isMarketHours ? 5_000 : 60_000; // 5 s during market, 1 min outside
        timerId = setTimeout(pollOiHistory, base + backoff);
      }
    };

    pollOiHistory();
    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [butterflyExpiry, nubraInstruments, pickedExpiries, ratioExpiry, straddleExpiry, symbol, viewMode]);

  useEffect(() => {
    if (!ratioChartOpen || !ratioChartHostRef.current) return;
    const chart = createChart(ratioChartHostRef.current, {
      autoSize: true,
      layout: { background: { color: '#0a0d12' }, textColor: '#b6c2d9' },
      grid: { vertLines: { color: '#242a34' }, horzLines: { color: '#242a34' } },
      rightPriceScale: { visible: true, borderColor: '#2d3643' },
      leftPriceScale: { visible: true, borderColor: '#2d3643' },
      timeScale: {
        borderColor: '#2d3643',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleTimeString('en-IN', {
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
      crosshair: { mode: 1 },
    });

    const pdSeries = chart.addSeries(LineSeries, {
      color: '#f7b84b',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'PD',
      priceScaleId: 'right',
    });
    const spotSeries = chart.addSeries(LineSeries, {
      color: '#4ea1ff',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Spot',
      priceScaleId: 'left',
    });
    pdSeries.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
    spotSeries.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });

    ratioChartRef.current = chart;
    ratioPdSeriesRef.current = pdSeries;
    ratioSpotSeriesRef.current = spotSeries;
    return () => {
      ratioPdSeriesRef.current = null;
      ratioSpotSeriesRef.current = null;
      ratioChartRef.current = null;
      chart.remove();
    };
  }, [ratioChartOpen]);

  useEffect(() => {
    if (!ratioChartOpen) return;
    ratioPdSeriesRef.current?.setData(ratioChartData.pd);
    ratioSpotSeriesRef.current?.setData(ratioChartData.spot);
  }, [ratioChartData, ratioChartOpen]);

  const maxCallOi = useMemo(() => {
    let max = 1;
    for (const row of visibleRows) {
      for (const entry of row.byExpiry) max = Math.max(max, entry.ce.oi || 0);
    }
    return max;
  }, [visibleRows]);

  const maxPutOi = useMemo(() => {
    let max = 1;
    for (const row of visibleRows) {
      for (const entry of row.byExpiry) max = Math.max(max, entry.pe.oi || 0);
    }
    return max;
  }, [visibleRows]);

  const summaryCards = useMemo(() => {
    const scopeChains = viewMode === 'chain'
      ? pickedExpiries.map(expiry => chains[expiry]).filter((chain): chain is ChainSnapshot => Boolean(chain))
      : [viewMode === 'straddle' ? straddleChain : viewMode === 'butterfly' ? butterflyChain : ratioChain]
        .filter((chain): chain is ChainSnapshot => Boolean(chain));

    let callOi = 0;
    let putOi = 0;
    let callVolume = 0;
    let putVolume = 0;
    let callDelta = 0;
    let putDelta = 0;

    for (const chain of scopeChains) {
      for (const row of chain.rows) {
        callOi += row.ce.oi || 0;
        putOi += row.pe.oi || 0;
        callVolume += row.ce.volume || 0;
        putVolume += row.pe.volume || 0;
        callDelta += Math.abs((row.ce.delta || 0) * (row.ce.oi || 0));
        putDelta += Math.abs((row.pe.delta || 0) * (row.pe.oi || 0));
      }
    }

    // OI change from start of day = current - first historical point
    const baseCall = summaryOiTrendHistory[0]?.call ?? callOi;
    const basePut  = summaryOiTrendHistory[0]?.put  ?? putOi;
    const callOiChg = callOi - baseCall;
    const putOiChg  = putOi  - basePut;

    return [
      {
        key: 'oi',
        title: 'Open Interest',
        subtitle: viewMode === 'chain' ? 'Total CE OI vs PE OI' : 'Selected expiry total OI',
        callValue: callOi,
        putValue: putOi,
        callChgValue: callOiChg,
        putChgValue: putOiChg,
        pcr: callOi > 0 ? putOi / callOi : 0,
        formatValue: fmtOi,
        ringMode: 'standard' as const,
      },
      {
        key: 'oichg',
        title: 'OI Change',
        subtitle: 'CE vs PE OI change from day open',
        callValue: callOiChg,
        putValue: putOiChg,
        pcr: callOiChg !== 0 ? putOiChg / callOiChg : 0,
        formatValue: fmtOi,
        ringMode: 'signed' as const,
      },
      {
        key: 'volume',
        title: 'Volume',
        subtitle: viewMode === 'chain' ? 'Total CE volume vs PE volume' : 'Selected expiry traded volume',
        callValue: callVolume,
        putValue: putVolume,
        pcr: callVolume > 0 ? putVolume / callVolume : 0,
        formatValue: fmtOi,
        ringMode: 'standard' as const,
      },
      {
        key: 'delta',
        title: 'Delta OI',
        subtitle: 'Absolute delta exposure from OI',
        callValue: callDelta,
        putValue: putDelta,
        pcr: callDelta > 0 ? putDelta / callDelta : 0,
        formatValue: fmtMetricCompact,
        ringMode: 'standard' as const,
      },
    ];
  }, [butterflyChain, chains, pickedExpiries, ratioChain, straddleChain, summaryOiTrendHistory, viewMode]);

  const priceScale = perLot ? lotSize : 1;

  const handleExpiryChange = useCallback((index: number, nextExpiry: string) => {
    setSelectedExpiries(prev => prev.map((value, idx) => (idx === index ? nextExpiry : value)));
  }, []);

  const openStraddleChart = useCallback((target: StraddleChartTarget) => {
    setStraddleChartTarget(target);
    setStraddleChartData({ straddle: [], call: [], put: [], spot: [], iv: [], oi: [], pcr: [], rv: [] });
    setStraddleSeriesVisibility({
      straddle: true,
      spot: true,
      iv: true,
      rv: true,
      pcr: true,
      oi: true,
      call: false,
      put: false,
    });
    setStraddleChartError('');
    setStraddleChartOpen(true);
  }, []);

  const openButterflyChart = useCallback((target: ButterflyChartTarget) => {
    setButterflyChartTarget(target);
    setButterflyChartData({ net: [], spot: [] });
    setButterflyChartError('');
    setButterflyChartOpen(true);
  }, []);

  const openRatioChart = useCallback((target: RatioChartTarget) => {
    setRatioChartTarget(target);
    setRatioChartData({ pd: [], spot: [] });
    setRatioChartError('');
    setRatioChartOpen(true);
  }, []);

  const toggleColumn = useCallback((key: ColumnKey) => {
    setSelectedColumns(prev => {
      if (prev.includes(key)) return prev.length === 1 ? prev : prev.filter(item => item !== key);
      return [...prev, key];
    });
  }, []);

  const activeSpot = (viewMode === 'straddle' ? straddleChain?.spot : primaryChain?.spot) ?? 0;
  const activeAtm = (viewMode === 'straddle' ? straddleChain?.atm : primaryChain?.atm) ?? activeSpot;
  const toolbarSpotLabel = activeSpot ? `${activeSpot.toFixed(2)} spot` : 'No live spot';
  const butterflyLegTemplate = useMemo(
    () => buildButterflyLegs(butterflyType, 0, 0, 0, 0, 0, 0),
    [butterflyType],
  );
  const leg1IsBuy = butterflyLegTemplate[0].side === 'buy';
  const leg2IsBuy = butterflyLegTemplate[1].side === 'buy';
  const leg3IsBuy = butterflyLegTemplate[2].side === 'buy';

  return (
    <div className={s.root} style={{ display: visible === false ? 'none' : 'flex' }}>
      <div className={s.toolbar}>
        <div className={s.viewTabs}>
          <button type="button" className={`${s.viewTab} ${viewMode === 'chain' ? s.viewTabActive : ''}`} onClick={() => setViewMode('chain')}>Option Chain</button>
          <button type="button" className={`${s.viewTab} ${viewMode === 'straddle' ? s.viewTabActive : ''}`} onClick={() => setViewMode('straddle')}>Straddle Chain</button>
          <button type="button" className={`${s.viewTab} ${viewMode === 'butterfly' ? s.viewTabActive : ''}`} onClick={() => setViewMode('butterfly')}>Butterfly</button>
          <button type="button" className={`${s.viewTab} ${viewMode === 'ratio' ? s.viewTabActive : ''}`} onClick={() => setViewMode('ratio')}>Ratio Analysis</button>
        </div>

        <SearchableScripSelect
          label="Scrip"
          value={symbol}
          options={allSymbols}
          onChange={next => setSymbol(next)}
          disabled={allSymbols.length === 0}
        />

        {viewMode === 'chain' ? (
          <>
            {[0, 1, 2].map(index => (
              <SelectControl
                key={index}
                label={`Expiry${index + 1}`}
                value={selectedExpiries[index] || ''}
                options={expiries}
                onChange={next => handleExpiryChange(index, next)}
                formatter={value => fmtExpiry(String(value))}
                disabled={expiries.length === 0}
              />
            ))}

            <SelectControl
              label="Strikes"
              value={strikeCount}
              options={STRIKE_WINDOW_OPTIONS}
              onChange={next => setStrikeCount(Number(next))}
              formatter={value => `${value} strikes`}
            />

            <ColumnPicker selected={selectedColumns} onToggle={toggleColumn} />
          </>
        ) : viewMode === 'straddle' ? (
          <>
            <SelectControl
              label="Expiry"
              value={straddleExpiry || ''}
              options={pickedExpiries}
              onChange={v => setStraddleExpiry(String(v))}
              formatter={value => fmtExpiry(String(value))}
              disabled={pickedExpiries.length === 0}
            />
            <SelectControl
              label="Option"
              value={strikeCount}
              options={STRIKE_WINDOW_OPTIONS}
              onChange={next => setStrikeCount(Number(next))}
            />
          </>
        ) : viewMode === 'butterfly' ? (
          <>
            <SelectControl
              label="Expiry"
              value={butterflyExpiry || ''}
              options={pickedExpiries}
              onChange={v => setButterflyExpiry(String(v))}
              formatter={value => fmtExpiry(String(value))}
              disabled={pickedExpiries.length === 0}
            />
            <SelectControl
              label="Type"
              value={butterflyType}
              options={BUTTERFLY_TYPES}
              onChange={v => setButterflyType(v as ButterflyType)}
            />
            <SelectControl
              label="Strike Gap"
              value={butterflyGap}
              options={[1, 2, 3, 4, 5]}
              onChange={v => setButterflyGap(Number(v))}
            />
            <SelectControl
              label="Combinations"
              value={butterflyCombinations}
              options={[5, 10, 15, 20, 25]}
              onChange={v => setButterflyCombinations(Number(v))}
            />
            <SelectControl
              label="Strike"
              value={butterflyCenterStrike || ''}
              options={butterflyStrikes}
              onChange={v => setButterflyCenterStrike(Number(v))}
              formatter={v => String(Number(v).toFixed(0))}
              disabled={butterflyStrikes.length === 0}
            />
          </>
        ) : (
          <>
            <SelectControl
              label="Expiry"
              value={ratioExpiry || ''}
              options={pickedExpiries}
              onChange={v => setRatioExpiry(String(v))}
              formatter={value => fmtExpiry(String(value))}
              disabled={pickedExpiries.length === 0}
            />
            <SelectControl
              label="Option Type"
              value={ratioOptionType}
              options={['Call', 'Put']}
              onChange={v => setRatioOptionType(v as RatioOptionType)}
            />
            <SelectControl
              label="Buy Strike"
              value={ratioBuyStrike || ''}
              options={ratioStrikes}
              onChange={v => setRatioBuyStrike(Number(v))}
              formatter={v => String(Number(v).toFixed(0))}
              disabled={ratioStrikes.length === 0}
            />
            <SelectControl
              label="Strike Gap"
              value={ratioStrikeGap}
              options={[1, 2, 3, 4, 5]}
              onChange={v => setRatioStrikeGap(Number(v))}
            />
            <SelectControl
              label="Rows"
              value={ratioRowsCount}
              options={[10, 15, 20, 25, 30]}
              onChange={v => setRatioRowsCount(Number(v))}
            />
            <SelectControl
              label="Buy Qty"
              value={ratioBuyQty}
              options={[1, 2, 3, 4, 5]}
              onChange={v => setRatioBuyQty(Number(v))}
            />
            <SelectControl
              label="Sell Qty"
              value={ratioSellQty}
              options={[1, 2, 3, 4, 5]}
              onChange={v => setRatioSellQty(Number(v))}
            />
          </>
        )}

        <label className={s.toggleWrap}>
          <span className={s.controlLabel}>Per Lot</span>
          <button
            type="button"
            className={`${s.toggle} ${perLot ? s.toggleOn : ''}`}
            onClick={() => setPerLot(value => !value)}
            aria-pressed={perLot}
          >
            <span className={s.toggleKnob} />
          </button>
        </label>

        {viewMode === 'straddle' ? (
          <div className={s.straddleMeta}>
            <span className={s.straddleMetaItem}>ATM Strike : <strong className={s.straddleMetaValue}>{activeAtm ? activeAtm.toFixed(0) : '-'}</strong></span>
            <span className={s.straddleMetaItem}>Lot Size : <strong className={s.straddleMetaValue}>{lotSize}</strong></span>
            <button type="button" className={s.straddleInfoBtn} title={`Display basis: ${perLot ? 'per lot' : 'per unit'}`}>
              Info
            </button>
          </div>
        ) : (
          <div className={s.infoChip}>
            <span className={s.infoDot} />
            <span>{toolbarSpotLabel}</span>
          </div>
        )}
      </div>

      {error && <div className={s.bannerError}>{error}</div>}
      {!error && loading && <div className={s.bannerInfo}>Loading option chain...</div>}
      {!loading && !error && pickedExpiries.length === 0 && <div className={s.bannerInfo}>Select at least one expiry</div>}

      {summaryCards.length > 0 && (
        <section className={s.summarySection}>
          {summaryCards.map(card => (
            <SummaryMetricCard
              key={card.key}
              title={card.title}
              subtitle={card.subtitle}
              callValue={card.callValue}
              putValue={card.putValue}
              callChgValue={(card as any).callChgValue}
              putChgValue={(card as any).putChgValue}
              pcr={card.pcr}
              formatValue={card.formatValue}
              ringMode={card.ringMode}
              compact={false}
              trendHistory={card.key === 'oi' ? summaryOiTrendHistory : card.key === 'oichg' ? summaryOiChgHistory : undefined}
              trendChgHistory={card.key === 'oi' ? summaryOiChgHistory : undefined}
            />
          ))}
        </section>
      )}

      <div className={s.tableWrap}>
        {viewMode === 'chain' ? (
          <table className={s.table}>
            <thead>
              <tr className={s.superHead}>
                <th colSpan={callExpiries.length * callColumns.length} className={`${s.superCell} ${s.callsHead}`}>CALLS</th>
                <th rowSpan={3} className={`${s.superCell} ${s.strikeHead}`}>
                  <div className={s.strikeHeadInner}>
                    <img src="/verticle logo.jpg.jpeg" alt="AlphaHedge" className={s.strikeHeadLogo} />
                    <span className={s.strikeHeadText}>Strike</span>
                  </div>
                </th>
                <th colSpan={putExpiries.length * putColumns.length} className={`${s.superCell} ${s.putsHead}`}>PUTS</th>
              </tr>
              <tr className={s.expiryHeadRow}>
                {callExpiries.map((expiry, groupIdx) => (
                  <th
                    key={`ce-exp-${expiry}`}
                    colSpan={callColumns.length}
                    className={`${s.expiryHead} ${s[`callGroupHead${groupIdx % 3}`]} ${groupIdx === 0 ? s.groupStart : ''} ${groupIdx === callExpiries.length - 1 ? s.groupEnd : ''}`}
                  >
                    {fmtExpiry(expiry)}
                  </th>
                ))}
                {putExpiries.map((expiry, groupIdx) => (
                  <th
                    key={`pe-exp-${expiry}`}
                    colSpan={putColumns.length}
                    className={`${s.expiryHead} ${s[`putGroupHead${groupIdx % 3}`]} ${groupIdx === 0 ? s.groupStart : ''} ${groupIdx === putExpiries.length - 1 ? s.groupEnd : ''}`}
                  >
                    {fmtExpiry(expiry)}
                  </th>
                ))}
              </tr>
              <tr className={s.metricHeadRow}>
                {callExpiries.flatMap((expiry, groupIdx) => callColumns.map((col, colIdx) => (
                  <th
                    key={`ce-${col}-${expiry}`}
                    className={`${s.metricHead} ${s[`callGroupHead${groupIdx % 3}`]} ${colIdx === 0 ? s.groupStart : ''} ${colIdx === callColumns.length - 1 ? s.groupEnd : ''}`}
                  >
                    {AVAILABLE_COLUMNS.find(item => item.key === col)?.label ?? col}
                  </th>
                )))}
                {putExpiries.flatMap((expiry, groupIdx) => putColumns.map((col, colIdx) => (
                  <th
                    key={`pe-${col}-${expiry}`}
                    className={`${s.metricHead} ${s[`putGroupHead${groupIdx % 3}`]} ${colIdx === 0 ? s.groupStart : ''} ${colIdx === putColumns.length - 1 ? s.groupEnd : ''}`}
                  >
                    {AVAILABLE_COLUMNS.find(item => item.key === col)?.label ?? col}
                  </th>
                )))}
              </tr>
            </thead>

            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={(pickedExpiries.length * (callColumns.length + putColumns.length)) + 1} className={s.emptyCell}>
                    {loading ? 'Loading rows...' : 'No option chain rows available'}
                  </td>
                </tr>
              ) : (
                visibleRows.map(row => (
                  <tr key={row.strike} className={row.isAtm ? s.atmRow : ''}>
                    {callExpiries.map((expiry, groupIdx) => {
                      const entry = row.byExpiry.find(item => item.expiry === expiry) ?? {
                        expiry,
                        strike: row.strike,
                        ce: EMPTY_SIDE,
                        pe: EMPTY_SIDE,
                      };
                      const ceChange = entry.ce.cp > 0 ? ((entry.ce.ltp - entry.ce.cp) / entry.ce.cp) * 100 : 0;
                      const ceOiPct = Math.max(0, Math.min(100, (entry.ce.oi / maxCallOi) * 100));
                      const ceLtpValue = entry.ce.ltp * priceScale;
                      return callColumns.map(col => {
                        if (col === 'oi') {
                          return (
                            <td key={`ce-o-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]}`}>
                              <div className={`${s.oiBar} ${s.oiBarCall}`} style={{ ['--oi-fill' as string]: `${ceOiPct.toFixed(1)}%` }}>
                                <span className={s.oiBarText}>{fmtOi(entry.ce.oi)}</span>
                                <span className={`${s.oiBarSub} ${entry.ce.oiChgPct >= 0 ? s.upText : s.downText}`}>{fmtOiChgPct(entry.ce.oiChgPct)}</span>
                              </div>
                            </td>
                          );
                        }
                        if (col === 'iv') return <td key={`ce-i-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]}`}>{fmtIv(entry.ce.iv)}</td>;
                        if (col === 'ltp') {
                          const ceChangeLabel = fmtChangePct(ceChange);
                          return (
                            <td key={`ce-l-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]} ${s.priceCell}`}>
                              <span className={`${s.priceMain} ${ceChangeLabel ? (ceChange >= 0 ? s.priceMainUp : s.priceMainDown) : ''}`}>{fmtPrice(ceLtpValue)}</span>
                              {ceChangeLabel && <span className={s.priceChangeText}>({ceChangeLabel})</span>}
                            </td>
                          );
                        }
                        if (col === 'delta') return <td key={`ce-d-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.ce.delta)}</td>;
                        if (col === 'theta') return <td key={`ce-t-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.ce.theta)}</td>;
                        if (col === 'vega') return <td key={`ce-v-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.ce.vega)}</td>;
                        return <td key={`ce-g-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.ce.gamma, 4)}</td>;
                      });
                    })}

                    <td className={`${s.strikeCell} ${row.isAtm ? s.strikeCellAtm : ''}`}>
                      {row.isAtm && <span className={s.atmPill}>ATM</span>}
                      <span className={row.isAtm ? s.strikeValAtm : s.strikeVal}>{row.strike.toFixed(0)}</span>
                    </td>

                    {putExpiries.map((expiry, groupIdx) => {
                      const entry = row.byExpiry.find(item => item.expiry === expiry) ?? {
                        expiry,
                        strike: row.strike,
                        ce: EMPTY_SIDE,
                        pe: EMPTY_SIDE,
                      };
                      const peChange = entry.pe.cp > 0 ? ((entry.pe.ltp - entry.pe.cp) / entry.pe.cp) * 100 : 0;
                      const peOiPct = Math.max(0, Math.min(100, (entry.pe.oi / maxPutOi) * 100));
                      const peLtpValue = entry.pe.ltp * priceScale;
                      return putColumns.map(col => {
                        if (col === 'ltp') {
                          const peChangeLabel = fmtChangePct(peChange);
                          return (
                            <td key={`pe-l-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]} ${s.priceCell}`}>
                              <span className={`${s.priceMain} ${peChangeLabel ? (peChange >= 0 ? s.priceMainUp : s.priceMainDown) : ''}`}>{fmtPrice(peLtpValue)}</span>
                              {peChangeLabel && <span className={s.priceChangeText}>({peChangeLabel})</span>}
                            </td>
                          );
                        }
                        if (col === 'iv') return <td key={`pe-i-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]}`}>{fmtIv(entry.pe.iv)}</td>;
                        if (col === 'oi') {
                          return (
                            <td key={`pe-o-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]}`}>
                              <div className={`${s.oiBar} ${s.oiBarPut}`} style={{ ['--oi-fill' as string]: `${peOiPct.toFixed(1)}%` }}>
                                <span className={s.oiBarText}>{fmtOi(entry.pe.oi)}</span>
                                <span className={`${s.oiBarSub} ${entry.pe.oiChgPct >= 0 ? s.upText : s.downText}`}>{fmtOiChgPct(entry.pe.oiChgPct)}</span>
                              </div>
                            </td>
                          );
                        }
                        if (col === 'delta') return <td key={`pe-d-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.pe.delta)}</td>;
                        if (col === 'theta') return <td key={`pe-t-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.pe.theta)}</td>;
                        if (col === 'vega') return <td key={`pe-v-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.pe.vega)}</td>;
                        return <td key={`pe-g-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]}`}>{fmtGreek(entry.pe.gamma, 4)}</td>;
                      });
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : viewMode === 'straddle' ? (
          <table className={s.straddleTable}>
            <thead>
              <tr>
                <th>Strike</th>
                <th>Call LTP</th>
                <th>Put LTP</th>
                <th>Straddle Price</th>
                <th>Price Change</th>
                <th>Change %</th>
                <th>Avg IV</th>
                <th>Call OI</th>
                <th>Put OI</th>
                <th>Net Delta</th>
                <th>Net Theta</th>
                <th>Net Gamma</th>
                <th>Net Vega</th>
                <th>Chart</th>
              </tr>
            </thead>
            <tbody>
              {straddleRows.length === 0 ? (
                <tr>
                  <td colSpan={13} className={s.emptyCell}>{loading ? 'Loading straddle rows...' : 'No straddle rows for selected expiry'}</td>
                </tr>
              ) : straddleRows.map(row => (
                <tr key={row.strike} className={row.isAtm ? s.straddleAtmRow : ''}>
                  <td className={`${s.straddleStrike} ${row.isAtm ? s.straddleStrikeAtm : ''}`}>{row.strike.toFixed(0)}</td>
                  <td>{fmtPrice(row.callLtp)}</td>
                  <td>{fmtPrice(row.putLtp)}</td>
                  <td>{fmtPrice(row.straddlePrice)}</td>
                  <td className={row.priceChange >= 0 ? s.straddlePricePos : s.straddlePriceNeg}>{fmtSignedPrice(row.priceChange)}</td>
                  <td>
                    {row.changePct === 0 ? '-' : (
                      <span className={`${s.straddlePct} ${row.changePct >= 0 ? s.straddlePctUp : s.straddlePctDown}`}>
                        {fmtChangePct(row.changePct)}
                      </span>
                    )}
                  </td>
                  <td>{fmtIv(row.avgIv)}</td>
                  <td>{fmtOi(row.callOi)}</td>
                  <td>{fmtOi(row.putOi)}</td>
                  <td className={row.netDelta >= 0 ? s.straddleGreekPos : s.straddleGreekNeg}>{fmtMaybeGreek(row.netDelta)}</td>
                  <td className={s.straddleGreekTheta}>{fmtMaybeGreek(row.netTheta)}</td>
                  <td className={s.straddleGreekGamma}>{fmtMaybeGreek(row.netGamma, 4)}</td>
                  <td className={s.straddleGreekVega}>{fmtMaybeGreek(row.netVega, 4)}</td>
                  <td>
                    <button
                      type="button"
                      className={s.straddleChartBtn}
                      onClick={() => openStraddleChart({ strike: row.strike })}
                      aria-label={`Open straddle chart for ${row.strike.toFixed(0)}`}
                    >
                      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M4 18.5h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        <path d="M6.5 15.5l3.8-3.9 2.8 2.4 4.4-5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="10.3" cy="11.6" r="1.2" fill="currentColor" />
                        <circle cx="13.1" cy="14" r="1.2" fill="currentColor" />
                        <circle cx="17.5" cy="8.8" r="1.2" fill="currentColor" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : viewMode === 'butterfly' ? (
          <table className={s.bfTable}>
            <thead>
              <tr>
                <th>{`Leg 1 (${sideLabel(butterflyLegTemplate[0].side)})`}</th>
                <th>Premium 1</th>
                <th>{`Leg 2 (${sideLabel(butterflyLegTemplate[1].side)})`}</th>
                <th>Premium 2</th>
                <th>{`Leg 3 (${sideLabel(butterflyLegTemplate[2].side)})`}</th>
                <th>Premium 3</th>
                <th>Net Dr/Cr</th>
                <th>Max Profit</th>
                <th>Max Loss</th>
                <th>Risk Reward</th>
                <th>Breakeven (-)</th>
                <th>Breakeven (+)</th>
                <th>Chart</th>
              </tr>
            </thead>
            <tbody>
              {butterflyRows.length === 0 ? (
                <tr>
                  <td className={s.emptyCell} colSpan={13}>{loading ? 'Loading butterfly combinations...' : 'No butterfly combinations for selected settings'}</td>
                </tr>
              ) : butterflyRows.map(row => {
                const side = optionTypeForButterfly(butterflyType);
                return (
                  <tr key={`${row.k1}-${row.k2}-${row.k3}`}>
                    <td className={leg1IsBuy ? s.bfLegBuy : s.bfLegSell}>{row.k1.toFixed(0)} <span>{side}</span></td>
                    <td className={leg1IsBuy ? s.bfPos : s.bfNeg}>{fmtPrice(row.p1)}</td>
                    <td className={leg2IsBuy ? s.bfLegBuy : s.bfLegSell}>{row.k2.toFixed(0)} <span>{side}</span></td>
                    <td className={leg2IsBuy ? s.bfPos : s.bfNeg}>{fmtPrice(row.p2)}</td>
                    <td className={leg3IsBuy ? s.bfLegBuy : s.bfLegSell}>{row.k3.toFixed(0)} <span>{side}</span></td>
                    <td className={leg3IsBuy ? s.bfPos : s.bfNeg}>{fmtPrice(row.p3)}</td>
                    <td>
                      <span className={`${s.bfMetricBox} ${row.net >= 0 ? s.bfMetricBoxPos : s.bfMetricBoxNeg}`}>
                        {fmtSignedPrice(row.net)}
                      </span>
                    </td>
                    <td className={s.bfChipPos}>{fmtSignedPrice(row.maxProfit)}</td>
                    <td className={s.bfChipNeg}>{fmtSignedPrice(row.maxLoss)}</td>
                    <td>{row.riskReward}</td>
                    <td>{row.beLow > 0 ? row.beLow.toFixed(2) : '—'}</td>
                    <td>{row.beHigh > 0 ? row.beHigh.toFixed(2) : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className={s.straddleChartBtn}
                        onClick={() => openButterflyChart({ k1: row.k1, k2: row.k2, k3: row.k3 })}
                        aria-label={`Open butterfly chart ${row.k1.toFixed(0)}-${row.k2.toFixed(0)}-${row.k3.toFixed(0)}`}
                      >
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M4 18.5h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          <path d="M6.5 15.5l3.8-3.9 2.8 2.4 4.4-5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          <circle cx="10.3" cy="11.6" r="1.2" fill="currentColor" />
                          <circle cx="13.1" cy="14" r="1.2" fill="currentColor" />
                          <circle cx="17.5" cy="8.8" r="1.2" fill="currentColor" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className={s.ratioTable}>
            <thead>
              <tr>
                <th>Sr. No</th>
                <th>Buy Strike</th>
                <th>Buy LTP</th>
                <th>Delta</th>
                <th>Theta</th>
                <th>Sell Strike</th>
                <th>Sell LTP</th>
                <th>Delta</th>
                <th>Theta</th>
                <th>PD</th>
                <th>Chart</th>
              </tr>
            </thead>
            <tbody>
              {ratioRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className={s.emptyCell}>{loading ? 'Loading ratio rows...' : 'No ratio rows for selected setup'}</td>
                </tr>
              ) : ratioRows.map(row => (
                <tr key={`${row.buyStrike}-${row.sellStrike}-${row.srNo}`}>
                  <td>{row.srNo}</td>
                  <td className={s.ratioBuyStrike}>{row.buyStrike.toFixed(0)}</td>
                  <td className={s.bfPos}>{fmtPrice(row.buyLtp)}</td>
                  <td>{fmtGreek(row.buyDelta)}</td>
                  <td>{fmtGreek(row.buyTheta)}</td>
                  <td className={s.ratioSellStrike}>{row.sellStrike.toFixed(0)}</td>
                  <td className={s.bfNeg}>{fmtPrice(row.sellLtp)}</td>
                  <td>{fmtGreek(row.sellDelta)}</td>
                  <td>{fmtGreek(row.sellTheta)}</td>
                  <td className={row.pd >= 0 ? s.bfPos : s.bfNeg}>{fmtSignedPrice(row.pd)}</td>
                  <td>
                    <button
                      type="button"
                      className={s.straddleChartBtn}
                      onClick={() => openRatioChart({ buyStrike: row.buyStrike, sellStrike: row.sellStrike })}
                      aria-label={`Open ratio PD chart ${row.buyStrike.toFixed(0)}-${row.sellStrike.toFixed(0)}`}
                    >
                      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M4 18.5h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        <path d="M6.5 15.5l3.8-3.9 2.8 2.4 4.4-5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="10.3" cy="11.6" r="1.2" fill="currentColor" />
                        <circle cx="13.1" cy="14" r="1.2" fill="currentColor" />
                        <circle cx="17.5" cy="8.8" r="1.2" fill="currentColor" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {straddleChartOpen && (
        <div className={s.straddleChartOverlay} onClick={() => setStraddleChartOpen(false)}>
          <div className={s.straddleChartModal} onClick={e => e.stopPropagation()}>
            <div className={s.straddleChartHead}>
              <div>
                <div className={s.straddleChartTitle}>Straddle Premium, Spot, IV and OI</div>
                <div className={s.straddleChartSub}>
                  {symbol} - {fmtExpiry(straddleExpiry)} - {straddleLivePoint?.label ?? '-'}
                </div>
              </div>
              <div className={s.straddleChartHeadActions}>
                <img src="/alpha-watermark.png" alt="" className={s.straddleChartHeaderMark} aria-hidden="true" />
                <button type="button" className={s.straddleChartClose} onClick={() => setStraddleChartOpen(false)}>Close</button>
              </div>
            </div>

            <div className={s.straddleChartLegend}>
              <span className={`${s.legendDot} ${s.legendDotStraddle}`} /> Straddle
              <span className={`${s.legendDot} ${s.legendDotCall}`} /> Call
              <span className={`${s.legendDot} ${s.legendDotPut}`} /> Put
              <span className={`${s.legendDot} ${s.legendDotSpot}`} /> Spot
              <span className={`${s.legendDot} ${s.legendDotIv}`} /> Avg IV
              <span className={`${s.legendDot} ${s.legendDotRv}`} /> RV (1h)
              <span className={`${s.legendDot} ${s.legendDotPcr}`} /> PCR
              <span className={`${s.legendDot} ${s.legendDotOi}`} /> OI
            </div>

            <div className={s.straddleSeriesToggles}>
              {[
                ['straddle', 'Straddle'],
                ['call', 'Call'],
                ['put', 'Put'],
                ['spot', 'Spot'],
                ['iv', 'IV'],
                ['rv', 'RV (1h)'],
                ['pcr', 'PCR'],
                ['oi', 'OI'],
              ].map(([key, label]) => (
                <label key={key} className={s.straddleSeriesToggle}>
                  <input
                    type="checkbox"
                    checked={straddleSeriesVisibility[key as keyof typeof straddleSeriesVisibility]}
                    onChange={() => setStraddleSeriesVisibility(prev => ({ ...prev, [key]: !prev[key as keyof typeof prev] }))}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            <div className={s.straddleChartBody}>
              <div className={s.straddleChartPaneMain}>
                <div className={s.straddleChartCanvasWrap}>
                  <div ref={straddleChartHostRef} className={s.straddleChartCanvas} />
                  <div id="straddle-hidden-pane" hidden aria-hidden="true" />
                </div>
              </div>
              <div className={s.straddleChartOverlayState}>
                {straddleChartLoading && <div className={s.straddleChartState}>Loading straddle history + live data...</div>}
                {!straddleChartLoading && straddleChartError && <div className={s.straddleChartStateError}>{straddleChartError}</div>}
                {!straddleChartLoading && !straddleChartError && !straddleLivePoint && <div className={s.straddleChartStateError}>No live data for selected straddle</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {ratioChartOpen && (
        <div className={s.straddleChartOverlay} onClick={() => setRatioChartOpen(false)}>
          <div className={s.straddleChartModal} onClick={e => e.stopPropagation()}>
            <div className={s.straddleChartHead}>
              <div>
                <div className={s.straddleChartTitle}>Ratio PD vs Spot</div>
                <div className={s.straddleChartSub}>
                  {symbol} - {fmtExpiry(ratioExpiry)} - {ratioLivePoint?.label ?? '-'} - PD = (Sell LTP x {ratioSellQty}) - (Buy LTP x {ratioBuyQty})
                </div>
              </div>
              <div className={s.straddleChartHeadActions}>
                <img src="/alpha-watermark.png" alt="" className={s.straddleChartHeaderMark} aria-hidden="true" />
                <button type="button" className={s.straddleChartClose} onClick={() => setRatioChartOpen(false)}>Close</button>
              </div>
            </div>

            <div className={s.straddleChartLegend}>
              <span className={`${s.legendDot} ${s.legendDotStraddle}`} /> PD
              <span className={`${s.legendDot} ${s.legendDotSpot}`} /> Spot
            </div>

            <div className={s.straddleChartBody}>
              <div className={s.straddleChartPaneMain}>
                <div className={s.straddleChartCanvasWrap}>
                  <div ref={ratioChartHostRef} className={s.straddleChartCanvas} />
                </div>
              </div>
              <div className={s.straddleChartOverlayState}>
                {ratioChartLoading && <div className={s.straddleChartState}>Loading morning history + live data...</div>}
                {!ratioChartLoading && ratioChartError && <div className={s.straddleChartStateError}>{ratioChartError}</div>}
                {!ratioChartLoading && !ratioChartError && !ratioLivePoint && <div className={s.straddleChartStateError}>No live data for selected ratio setup</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {butterflyChartOpen && (
        <div className={s.straddleChartOverlay} onClick={() => setButterflyChartOpen(false)}>
          <div className={s.straddleChartModal} onClick={e => e.stopPropagation()}>
            <div className={s.straddleChartHead}>
              <div>
                <div className={s.straddleChartTitle}>Butterfly Net vs Spot</div>
                <div className={s.straddleChartSub}>
                  {symbol} - {fmtExpiry(butterflyExpiry)} - {butterflyLivePoint?.label ?? '-'}
                </div>
              </div>
              <div className={s.straddleChartHeadActions}>
                <img src="/alpha-watermark.png" alt="" className={s.straddleChartHeaderMark} aria-hidden="true" />
                <button type="button" className={s.straddleChartClose} onClick={() => setButterflyChartOpen(false)}>Close</button>
              </div>
            </div>

            <div className={s.straddleChartLegend}>
              <span className={`${s.legendDot} ${s.legendDotStraddle}`} /> Net Dr/Cr
              <span className={`${s.legendDot} ${s.legendDotSpot}`} /> Spot Price
            </div>

            <div className={s.straddleChartBody}>
              <div className={s.straddleChartPaneMain}>
                <div className={s.straddleChartCanvasWrap}>
                  <div ref={butterflyChartHostRef} className={s.straddleChartCanvas} />
                </div>
              </div>
              <div className={s.straddleChartOverlayState}>
                {butterflyChartLoading && <div className={s.straddleChartState}>Loading morning history + live data...</div>}
                {!butterflyChartLoading && butterflyChartError && <div className={s.straddleChartStateError}>{butterflyChartError}</div>}
                {!butterflyChartLoading && !butterflyChartError && !butterflyLivePoint && <div className={s.straddleChartStateError}>No live data for selected butterfly combo</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

