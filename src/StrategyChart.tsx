'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  createChart,
  LineSeries,
  BaselineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type BaselineData,
  type Time,
  type LogicalRange,
  type SeriesMarker,
} from 'lightweight-charts';
import type { NubraInstrument } from './useNubraInstruments';
import type { Instrument } from './useInstruments';
import { wsManager } from './lib/WebSocketManager';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StrategyLeg {
  symbol: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  action: 'B' | 'S';
  price: number;      // entry LTP
  lots: number;
  refId?: number;
  instrumentKey?: string;
  lotSize: number;
  exchange?: string;  // exchange of the underlying (NSE/BSE/MCX)
  entryTime?: string; // HH:MM:SS when user entered the leg (IST)
  entryDate?: string; // YYYY-MM-DD date of entry (IST)
  currLtp?: number;   // live LTP from parent (App) — used to keep chart MTM in sync
}

interface StrategyChartProps {
  legs: StrategyLeg[];
  ocSymbol: string;
  ocExchange: string;
  instruments: Instrument[];
  nubraInstruments: NubraInstrument[];
  nubraIndexes: Record<string, string>[];
  isHistoricalMode?: boolean;
  /** Called after historical fetch with latest close price per leg symbol key */
  onLtpSnapshot?: (snapshot: Map<string, number>) => void;
}

type UnderlyingInfo = {
  symbol: string;
  exchange: string;
  nubraType: string;
  source: 'NUBRA' | 'MCX';
  instrumentKey?: string;
};

type OptionInfo = {
  key: string;
  exchange: string;
  source: 'NUBRA' | 'MCX';
  symbol?: string;
  instrumentKey?: string;
};

interface SeriesSet {
  underlyings: Map<string, ISeriesApi<'Line'>>; // keyed by symbol
  mtm: ISeriesApi<'Baseline'> | null;
  mtmPerUnderlying: Map<string, ISeriesApi<'Line'>>; // keyed by symbol — only when >1 underlying
  options: Map<string, ISeriesApi<'Line'>>;
  deltas:  Map<string, ISeriesApi<'Line'>>;
  ivs:     Map<string, ISeriesApi<'Line'>>;
}

interface AccumData {
  underlyings: Map<string, LineData[]>; // keyed by symbol
  mtm: BaselineData[];
  mtmPerUnderlying: Map<string, LineData[]>; // keyed by symbol — only when >1 underlying
  options: Map<string, LineData[]>;
  deltas:  Map<string, LineData[]>;
  ivs:     Map<string, LineData[]>;
}

function isMarketOpen(): boolean {
  const now = new Date();
  const istMin = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + 330) % 1440;
  const istDay = new Date(now.getTime() + 330 * 60000);
  if ([0, 6].includes(istDay.getUTCDay())) return false;
  return istMin >= 9 * 60 + 15 && istMin < 15 * 60 + 30;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function prevTradingDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); }
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return toDateStr(d);
}

function nextTradingDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() + 1); }
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return toDateStr(d);
}

function lastTradingDay(): string {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const day = now.getUTCDay();
  if (day === 0) now.setUTCDate(now.getUTCDate() - 2);
  else if (day === 6) now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

function formatDate(d: string): string {
  // YYYY-MM-DD → DD MMM
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, m, day] = d.split('-');
  return `${parseInt(day)} ${months[parseInt(m) - 1]}`;
}

function istTimeToUtcIso(date: string, time: string): string {
  const [hh, mm] = time.split(':').map(Number);
  const [yr, mo, dy] = date.split('-').map(Number);
  const utcMs = Date.UTC(yr, mo - 1, dy) + (hh * 60 + mm - 330) * 60000;
  return new Date(utcMs).toISOString();
}

function legEntryUnix(leg: { entryDate?: string; entryTime?: string }): number {
  if (!leg.entryDate || !leg.entryTime) return 0;
  const [hh, mm] = leg.entryTime.split(':').map(Number);
  const [yr, mo, dy] = leg.entryDate.split('-').map(Number);
  const midnightUtc = Date.UTC(yr, mo - 1, dy) / 1000;
  return midnightUtc + hh * 3600 + mm * 60 - 5.5 * 3600;
}

// ── Nubra helpers ─────────────────────────────────────────────────────────────

function nsToTime(ns: number): Time {
  return Math.round(ns / 1e9) as unknown as Time;
}
const getTs  = (p: any): number => p?.ts ?? p?.timestamp ?? 0;
const getVal = (p: any): number => p?.v  ?? p?.value     ?? 0;
const HIST_FIELDS = ['close'];

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

function mergeData(older: LineData[], newer: LineData[]): LineData[] {
  return sortDedup([...older, ...newer]);
}

async function nubraPost(body: object): Promise<any> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken    = localStorage.getItem('nubra_auth_token')    ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id')     ?? '';
  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_token: sessionToken, auth_token: authToken, device_id: deviceId, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const resultArr = json.result ?? [];
  if (!resultArr.length) throw new Error(json.message ?? `No result. Keys: ${Object.keys(json).join(',')}`);
  const valuesArr = resultArr[0]?.values ?? [];
  let stockChart: any = null;
  for (const dict of valuesArr) {
    for (const [, v] of Object.entries(dict)) { stockChart = v; break; }
    if (stockChart) break;
  }
  if (!stockChart) throw new Error(`No chart data. valuesArr len=${valuesArr.length}`);
  return stockChart;
}

interface UpstoxCandleResult {
  candles: number[][];
  prevTimestamp: number | null;
}

async function fetchUpstoxCandles(instrumentKey: string, interval: string, from: number): Promise<UpstoxCandleResult> {
  const params = new URLSearchParams({
    instrumentKey,
    interval,
    from: String(from),
    limit: '500',
  });
  const res = await fetch(`/api/public-candles?${params}`);
  if (!res.ok) throw new Error(`public-candles ${res.status}`);
  const json = await res.json();
  return {
    candles: json?.data?.candles ?? [],
    prevTimestamp: json?.data?.meta?.prevTimestamp ?? null,
  };
}

function istStartMs(date: string): number {
  return new Date(`${date}T00:00:00.000+05:30`).getTime();
}

function istEndMs(date: string): number {
  return new Date(`${date}T23:59:59.999+05:30`).getTime();
}

function istTimeMs(date: string, time: string): number {
  const parts = time.split(':').map(Number);
  const hh = parts[0] ?? 0;
  const mm = parts[1] ?? 0;
  const ss = parts[2] ?? 0;
  return new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000+05:30`).getTime();
}

function toLineFromCandles(candles: number[][]): LineData[] {
  const sorted = [...candles].sort((a, b) => a[0] - b[0]);
  return sortDedup(sorted.map(c => ({
    time: Math.floor(c[0] / 1000) as Time,
    value: c[4],
  })));
}

async function fetchMcxCandlesBetween(instrumentKey: string, startMs: number, endMs: number): Promise<LineData[]> {
  let cursor = endMs;
  let pages = 0;
  const all: number[][] = [];
  while (pages < 10) { // safety cap
    pages += 1;
    const { candles, prevTimestamp } = await fetchUpstoxCandles(instrumentKey, 'I1', cursor);
    if (!candles.length) break;
    all.push(...candles);
    const oldest = candles.reduce((min, c) => Math.min(min, c[0]), Number.POSITIVE_INFINITY);
    if (oldest <= startMs) break;
    if (!prevTimestamp) break;
    cursor = prevTimestamp;
  }
  const filtered = all.filter(c => c[0] >= startMs && c[0] <= endMs);
  return toLineFromCandles(filtered);
}

function findMcxSpotKey(underlying: string, instruments: Instrument[]): string | null {
  const now = Date.now();
  const sym = underlying.toUpperCase();
  const futs = instruments.filter(i =>
    i.exchange === 'MCX' &&
    i.instrument_type === 'FUT' &&
    i.underlying_symbol?.toUpperCase() === sym &&
    i.expiry != null &&
    i.expiry >= now
  );
  if (futs.length) {
    futs.sort((a, b) => (a.expiry as number) - (b.expiry as number));
    return futs[0].instrument_key;
  }
  const fallback = instruments.find(i =>
    i.exchange === 'MCX' &&
    i.trading_symbol?.toUpperCase().startsWith(sym)
  );
  return fallback?.instrument_key ?? null;
}

function resolveMcxOptionKey(leg: StrategyLeg, instruments: Instrument[]): string | null {
  if (leg.instrumentKey) return leg.instrumentKey;
  const sym = (leg.symbol ?? '').toUpperCase();
  const expNum = Number(leg.expiry);
  const strike = leg.strike;
  const match = instruments.find(i =>
    i.exchange === 'MCX' &&
    i.instrument_type === leg.type &&
    (i.underlying_symbol?.toUpperCase() === sym || i.trading_symbol?.toUpperCase().startsWith(sym)) &&
    (Number.isFinite(expNum) ? i.expiry === expNum : true) &&
    (i.strike_price != null ? Math.abs(i.strike_price - strike) < 0.01 : true)
  );
  return match?.instrument_key ?? null;
}

async function fetchMcxUnderlyingForDate(instrumentKey: string, date: string, entryTimeIst?: string): Promise<LineData[]> {
  const endMs = istEndMs(date);
  const startMs = entryTimeIst ? istTimeMs(date, entryTimeIst) : istStartMs(date);
  return fetchMcxCandlesBetween(instrumentKey, startMs, endMs);
}

async function fetchMcxUnderlyingRange(instrumentKey: string, startDate: string, today: string, entryTimeIst?: string): Promise<LineData[]> {
  let cur = startDate;
  let out: LineData[] = [];
  while (true) {
    const useEntry = entryTimeIst && cur === startDate ? entryTimeIst : undefined;
    const data = await fetchMcxUnderlyingForDate(instrumentKey, cur, useEntry);
    if (data.length) out = mergeData(out, data);
    if (cur === today) break;
    const next = nextTradingDay(cur);
    if (next > today) break;
    cur = next;
  }
  return out;
}

async function fetchMcxOptionCloseForDate(instrumentKey: string, date: string, entryTimeIst?: string): Promise<{ close: LineData[] }> {
  const endMs = istEndMs(date);
  const startMs = entryTimeIst ? istTimeMs(date, entryTimeIst) : istStartMs(date);
  const close = await fetchMcxCandlesBetween(instrumentKey, startMs, endMs);
  return { close };
}

async function fetchMcxOptionCloseRange(instrumentKey: string, startDate: string, today: string, entryTimeIst?: string): Promise<{ close: LineData[] }> {
  let cur = startDate;
  let out: LineData[] = [];
  while (true) {
    const useEntry = entryTimeIst && cur === startDate ? entryTimeIst : undefined;
    const data = await fetchMcxOptionCloseForDate(instrumentKey, cur, useEntry);
    if (data.close.length) out = mergeData(out, data.close);
    if (cur === today) break;
    const next = nextTradingDay(cur);
    if (next > today) break;
    cur = next;
  }
  return { close: out };
}

// Build Nubra date params: today → intraDay:true, historical → explicit range
// entryTimeIst: "HH:MM" — when provided on the entry date, startDate begins at that time
function buildDateParams(date: string, today: string, entryTimeIst?: string, forceHistorical?: boolean) {
  const isToday = date === today;
  const useIntraDay = isToday;
  let startDate = useIntraDay ? '' : `${date}T03:45:00.000Z`;
  if (entryTimeIst) {
    // Convert IST HH:MM to UTC ISO string
    startDate = istTimeToUtcIso(date, entryTimeIst);
  }
  // For historical (non-today) we keep a fixed end; for today, intraDay ignores endDate
  return {
    startDate: forceHistorical && isToday ? startDate : startDate,
    endDate: useIntraDay ? '' : `${date}T11:30:00.000Z`,
    intraDay: useIntraDay,
  };
}

// Build Nubra range params: entryDate → today (trading day), intraDay only when same-day
function buildRangeParams(entryDate: string, today: string, entryTimeIst?: string) {
  const sameDay = entryDate === today;
  const startDate = entryTimeIst ? istTimeToUtcIso(entryDate, entryTimeIst) : `${entryDate}T03:45:00.000Z`;
  return {
    startDate,
    endDate: sameDay ? '' : `${today}T11:30:00.000Z`,
    intraDay: sameDay,
  };
}

function computeMtmFromOptions(
  legInfos: { key: string }[],
  uniqueLegs: StrategyLeg[],
  optionsMap: Map<string, LineData[]>,
): BaselineData[] {
  const entryCutoff = new Map<string, number>();
  for (const { key } of legInfos) {
    const leg = uniqueLegs.find(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}` === key);
    entryCutoff.set(key, leg ? legEntryUnix(leg) : 0);
  }

  // Build lookup maps for O(1) access: key → Map<timestamp, value>
  const optMaps = new Map<string, Map<number, number>>();
  for (const { key } of legInfos) {
    const m = new Map<number, number>();
    for (const pt of optionsMap.get(key) ?? []) m.set(pt.time as number, pt.value);
    optMaps.set(key, m);
  }

  // Collect all timestamps — filter by each leg's entry time
  const tsSet = new Set<number>();
  for (const { key } of legInfos) {
    for (const [t] of optMaps.get(key) ?? []) {
      const cut = entryCutoff.get(key) ?? 0;
      if (cut === 0 || t >= cut) tsSet.add(t);
    }
  }
  const timestamps = [...tsSet].sort((a, b) => a - b);

  // Recompute MTM fully from scratch
  return timestamps.map(t => {
    let total = 0;
    for (const { key } of legInfos) {
      const leg = uniqueLegs.find(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}` === key);
      if (!leg) continue;
      const cut = entryCutoff.get(key) ?? 0;
      if (cut !== 0 && t < cut) continue;
      const currLtp = optMaps.get(key)?.get(t) ?? 0;
      total += (leg.action === 'B' ? currLtp - leg.price : leg.price - currLtp) * leg.lots * (leg.lotSize || 1);
    }
    return { time: t as Time, value: total };
  });
}

// Compute MTM broken down per underlying symbol (only legs belonging to that symbol)
function computeMtmPerUnderlyingSymbol(
  legInfos: { key: string }[],
  uniqueLegs: StrategyLeg[],
  optionsMap: Map<string, LineData[]>,
): Map<string, LineData[]> {
  const result = new Map<string, LineData[]>();
  const uniqueSymbols = [...new Set(uniqueLegs.map(l => l.symbol))];
  if (uniqueSymbols.length <= 1) return result; // only useful for multi-underlying

  for (const sym of uniqueSymbols) {
    const symLegInfos = legInfos.filter(info => {
      const leg = uniqueLegs.find(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}` === info.key);
      return leg?.symbol === sym;
    });
    if (symLegInfos.length === 0) continue;
    const data = computeMtmFromOptions(symLegInfos, uniqueLegs, optionsMap);
    result.set(sym, data as unknown as LineData[]);
  }
  return result;
}

// Fetch underlying close for a date (Nubra for NSE/BSE, Upstox for MCX)
async function fetchUnderlyingForDate(
  u: UnderlyingInfo,
  date: string,
  today: string,
  entryTimeIst?: string,
  forceHistorical?: boolean,
): Promise<LineData[]> {
  if (u.source === 'MCX' || u.exchange.toUpperCase() === 'MCX' || u.nubraType === 'MCX') {
    if (!u.instrumentKey) return [];
    return fetchMcxUnderlyingForDate(u.instrumentKey, date);
  }
  const { startDate, endDate, intraDay } = buildDateParams(date, today, entryTimeIst, forceHistorical);
  const chart = await nubraPost({
    exchange: u.exchange, type: u.nubraType, values: [u.symbol], fields: ['close'],
    startDate, endDate, interval: '1m', intraDay,
  });
  const toLine = (arr: any[]): LineData[] =>
    sortDedup((arr ?? []).filter((p: any) => getTs(p)).map((p: any) => ({
      time: nsToTime(getTs(p)),
      value: getVal(p) / 100,
    })));
  return toLine(chart.close ?? []);
}

// Fetch underlying close for a date range (Nubra for NSE/BSE, Upstox for MCX)
async function fetchUnderlyingRange(
  u: UnderlyingInfo,
  entryDate: string,
  today: string,
  entryTimeIst?: string,
): Promise<LineData[]> {
  if (u.source === 'MCX' || u.exchange.toUpperCase() === 'MCX' || u.nubraType === 'MCX') {
    if (!u.instrumentKey) return [];
    return fetchMcxUnderlyingRange(u.instrumentKey, entryDate, today, entryTimeIst);
  }
  const { startDate, endDate, intraDay } = buildRangeParams(entryDate, today, entryTimeIst);
  const chart = await nubraPost({
    exchange: u.exchange, type: u.nubraType, values: [u.symbol], fields: HIST_FIELDS,
    startDate, endDate, interval: '1m', intraDay,
  });
  const toLine = (arr: any[]): LineData[] =>
    sortDedup((arr ?? []).filter((p: any) => getTs(p)).map((p: any) => ({
      time: nsToTime(getTs(p)),
      value: getVal(p) / 100,
    })));
  return toLine(chart.close ?? []);
}

// Fetch option close only
async function fetchOptionCloseForDate(
  symbol: string,
  exchange: string,
  date: string,
  today: string,
  entryTimeIst?: string,
  forceHistorical?: boolean,
): Promise<{ close: LineData[] }> {
  const { startDate, endDate, intraDay } = buildDateParams(date, today, entryTimeIst, forceHistorical);
  const chart = await nubraPost({
    exchange, type: 'OPT', values: [symbol], fields: ['close'],
    startDate, endDate, interval: '1m', intraDay,
  });
  const toLine = (arr: any[], scale = 1): LineData[] =>
    sortDedup((arr ?? []).filter((p: any) => getTs(p)).map((p: any) => ({
      time: nsToTime(getTs(p)),
      value: getVal(p) * scale,
    })));
  return { close: toLine(chart.close ?? [], 1 / 100) };
}

// Fetch option close for a date range
async function fetchOptionCloseRange(
  symbol: string,
  exchange: string,
  entryDate: string,
  today: string,
  entryTimeIst?: string,
): Promise<{ close: LineData[] }> {
  const { startDate, endDate, intraDay } = buildRangeParams(entryDate, today, entryTimeIst);
  const chart = await nubraPost({
    exchange, type: 'OPT', values: [symbol], fields: HIST_FIELDS,
    startDate, endDate, interval: '1m', intraDay,
  });
  const toLine = (arr: any[], scale = 1): LineData[] =>
    sortDedup((arr ?? []).filter((p: any) => getTs(p)).map((p: any) => ({
      time: nsToTime(getTs(p)),
      value: getVal(p) * scale,
    })));
  return { close: toLine(chart.close ?? [], 1 / 100) };
}

async function fetchOptionCloseForDateAny(
  info: OptionInfo,
  date: string,
  today: string,
  entryTimeIst?: string,
  forceHistorical?: boolean,
): Promise<{ close: LineData[] }> {
  if (info.source === 'MCX') {
    if (!info.instrumentKey) return { close: [] };
    return fetchMcxOptionCloseForDate(info.instrumentKey, date, entryTimeIst);
  }
  return fetchOptionCloseForDate(info.symbol!, info.exchange, date, today, entryTimeIst, forceHistorical);
}

async function fetchOptionCloseRangeAny(
  info: OptionInfo,
  entryDate: string,
  today: string,
  entryTimeIst?: string,
): Promise<{ close: LineData[] }> {
  if (info.source === 'MCX') {
    if (!info.instrumentKey) return { close: [] };
    return fetchMcxOptionCloseRange(info.instrumentKey, entryDate, today, entryTimeIst);
  }
  return fetchOptionCloseRange(info.symbol!, info.exchange, entryDate, today, entryTimeIst);
}
// Fetch option delta + iv_mid only (lazy — called when user toggles Greeks on)
async function fetchOptionGreeksForDate(
  symbol: string,
  exchange: string,
  date: string,
  today: string,
  entryTimeIst?: string,
  forceHistorical?: boolean,
): Promise<{ delta: LineData[]; iv: LineData[] }> {
  const { startDate, endDate, intraDay } = buildDateParams(date, today, entryTimeIst, forceHistorical);
  const chart = await nubraPost({
    exchange, type: 'OPT', values: [symbol], fields: ['delta', 'iv_mid'],
    startDate, endDate, interval: '1m', intraDay,
  });
  const toLine = (arr: any[], scale = 1): LineData[] =>
    sortDedup((arr ?? []).filter((p: any) => getTs(p)).map((p: any) => ({
      time: nsToTime(getTs(p)),
      value: getVal(p) * scale,
    })));
  return {
    delta: toLine(chart.delta ?? []),
    iv:    toLine(chart.iv_mid ?? [], 100),
  };
}

async function fetchOptionGreeksRange(
  symbol: string,
  exchange: string,
  entryDate: string,
  today: string,
  entryTimeIst?: string,
): Promise<{ delta: LineData[]; iv: LineData[] }> {
  const { startDate, endDate, intraDay } = buildRangeParams(entryDate, today, entryTimeIst);
  const chart = await nubraPost({
    exchange, type: 'OPT', values: [symbol], fields: ['delta', 'iv_mid'],
    startDate, endDate, interval: '1m', intraDay,
  });
  const toLine = (arr: any[], scale = 1): LineData[] =>
    sortDedup((arr ?? []).filter((p: any) => getTs(p)).map((p: any) => ({
      time: nsToTime(getTs(p)),
      value: getVal(p) * scale,
    })));
  return {
    delta: toLine(chart.delta ?? []),
    iv:    toLine(chart.iv_mid ?? [], 100),
  };
}

const INITIAL_VISIBLE = 120;

// ── Colors ────────────────────────────────────────────────────────────────────

const UNDERLYING_COLOR  = '#60a5fa';
const UNDERLYING_COLORS = ['#60a5fa', '#fb923c', '#34d399', '#a78bfa', '#f472b6'];

const CE_COLORS    = ['#2ebd85', '#4ade80', '#86efac', '#a3e635'];
const PE_COLORS    = ['#f23645', '#fb923c', '#f472b6', '#e879f9'];
const DELTA_COLORS = ['#f59e0b', '#fbbf24', '#fcd34d'];
const IV_COLORS    = ['#a78bfa', '#c4b5fd', '#ddd6fe'];
const ATM_IV_COLOR = '#f97316';

// ── ATM IV helpers (mirrors OIProfileView) ────────────────────────────────────
function expiryToMs(exp: string | number | null | undefined): number {
  if (exp == null) return 0;
  const s = String(exp);
  // YYYYMMDD → ms
  if (/^\d{8}$/.test(s)) {
    return Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8));
  }
  // "DD Mon YY" e.g. "17 Mar 26"
  const MMAP: Record<string,number> = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
  if (m) {
    const yy = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return Date.UTC(yy, MMAP[m[2]] ?? 0, +m[1]);
  }
  // "YYYY-MM-DD"
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return Date.UTC(+m2[1], +m2[2]-1, +m2[3]);
  return 0;
}

function toNubraChainValue(underlying: string, expiryMs: number): string {
  const d = new Date(expiryMs);
  const yyyy = d.toLocaleString('en-IN', { year: 'numeric', timeZone: 'Asia/Kolkata' });
  const mm   = d.toLocaleString('en-IN', { month: '2-digit', timeZone: 'Asia/Kolkata' });
  const dd   = d.toLocaleString('en-IN', { day: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${underlying}_${yyyy}${mm}${dd}`;
}

/** Snap ms timestamp to 1-minute bar boundary in IST */
const IST_OFFSET_SEC = 19800;
function snapToMinBar(tsMs: number): number {
  const s = Math.floor(tsMs / 1000);
  return Math.floor((s + IST_OFFSET_SEC) / 60) * 60 - IST_OFFSET_SEC;
}

/**
 * Find the nearest actual strike available in nubraInstruments for a given
 * underlying + expiry. Compares expiry by ms so format differences don't matter.
 */
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
  if (opts.length === 0) return 0;
  // strike_price is in paise → convert to rupees
  let best = opts[0];
  let bestDiff = Math.abs((best.strike_price! / 100) - spot);
  for (const o of opts) {
    const diff = Math.abs((o.strike_price! / 100) - spot);
    if (diff < bestDiff) { best = o; bestDiff = diff; }
  }
  return best.strike_price! / 100;
}

async function fetchAtmIvChart(
  underlying: string,
  exchange: string,
  expiryMs: number,
  startDateStr: string,
): Promise<LineData[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie    = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken) return [];

  const chainValue = toNubraChainValue(underlying, expiryMs);
  // 09:15 IST = 03:45 UTC
  const startDate = `${startDateStr}T03:45:00.000Z`;
  // end = now in IST, capped at 15:30 IST (10:00 UTC) for the current day
  const nowUtc = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(nowUtc.getTime() + istOffsetMs);
  const istHHMM = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
  const marketCloseIst = 15 * 60 + 30; // 15:30
  const endDate = istHHMM > marketCloseIst
    ? `${nowIst.toISOString().slice(0, 10)}T10:00:00.000Z` // 15:30 IST = 10:00 UTC
    : nowUtc.toISOString();

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
      query: [{
        exchange,
        type: 'CHAIN',
        values: [chainValue],
        fields: ['atm_iv'],
        interval: '1m',
        intraDay: false,
        realTime: false,
        startDate,
        endDate,
      }],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const pts: { ts: number; v: number }[] =
    json?.result?.[0]?.values?.[0]?.[chainValue]?.atm_iv ?? [];
  // ts is in nanoseconds → divide by 1e9 for Unix seconds (lightweight-charts Time)
  return pts.map(p => ({ time: Math.round(p.ts / 1e9) as unknown as Time, value: p.v * 100 }));
}

function optionColor(type: 'CE' | 'PE', idx: number) {
  return type === 'CE' ? CE_COLORS[idx % CE_COLORS.length] : PE_COLORS[idx % PE_COLORS.length];
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function StrategyChart({ legs, ocSymbol, ocExchange, instruments, nubraInstruments, nubraIndexes, isHistoricalMode, onLtpSnapshot }: StrategyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const seriesRef    = useRef<SeriesSet>({
    underlyings: new Map(), mtm: null, mtmPerUnderlying: new Map(), options: new Map(), deltas: new Map(), ivs: new Map(),
  });
  const fetchAllRef    = useRef<() => void>(() => {});
  const wsRef          = useRef<WebSocket | null>(null);
  const wsTickRef      = useRef<any[]>([]);
  const wsFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsFlushPendingRef = useRef(false);
  const isInteractingRef = useRef(false);
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markersPluginRef = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const mcxAutoScrollRef = useRef(false);
  const mcxHasRef = useRef(false);
  const legsRef          = useRef<StrategyLeg[]>(legs);
  const deltaLoadedRef   = useRef<Set<string>>(new Set()); // dates that have Delta loaded
  const ivLoadedRef      = useRef<Set<string>>(new Set()); // dates that have IV loaded
  const deltaRangeSigRef = useRef<string>(''); // signature for historical range delta load
  const ivRangeSigRef    = useRef<string>(''); // signature for historical range IV load

  const accumRef = useRef<AccumData>({
    underlyings: new Map(), mtm: [], mtmPerUnderlying: new Map(), options: new Map(), deltas: new Map(), ivs: new Map(),
  });

  const scrollToLatest = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const fn = (ts as any).scrollToRealTime;
    if (typeof fn === 'function') fn.call(ts);
    else ts.fitContent();
  }, []);

  // Oldest date loaded so far — scroll-back steps this back one day at a time
  const oldestDateRef    = useRef<string | null>(null);
  const isLoadingMoreRef = useRef(false);
  const loadLockRef      = useRef(false);
  const loadedDatesRef   = useRef<Set<string>>(new Set());

  const [loading,     setLoading]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,       setError]       = useState('');
  // DOM popup in positions overlay
  const [domLegIdx,   setDomLegIdx]   = useState<number | null>(null);
  const [domBook,     setDomBook]     = useState<{ bids: {price:number;qty:number}[]; asks: {price:number;qty:number}[]; ltp: number } | null>(null);
  const domWsRef = useRef<WebSocket | null>(null);
  const [showPositions, setShowPositions] = useState(false);
  const [, setLegendItems] = useState<{ label: string; color: string }[]>([]);
  const [chartReady,  setChartReady]  = useState(false);
  // Date range shown in header — updates as user scrolls back
  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate,   setToDate]   = useState<string | null>(null);
  // Toolbar visibility toggles
  const [showSpot,    setShowSpot]    = useState(true);
  const [showOptions, setShowOptions] = useState(false);
  const [showMtm,     setShowMtm]     = useState(true);
  const [mtmMode,     setMtmMode]     = useState<'total' | 'series'>('total');
  const [showDelta,   setShowDelta]   = useState(false);
  const [showIv,      setShowIv]      = useState(false);
  const [showAtmIv,   setShowAtmIv]   = useState(false);
  // 'all' = show total + all per-underlying, 'total' = only total baseline, or a symbol string = only that underlying's MTM
  const [mtmView, setMtmView] = useState<'all' | 'total' | string>('all');
  const mtmViewRef  = useRef(mtmView);
  const showMtmRef  = useRef(showMtm);
  mtmViewRef.current  = mtmView;
  showMtmRef.current  = showMtm;
  const showDeltaRef    = useRef(showDelta);
  const showIvRef       = useRef(showIv);
  const showAtmIvRef    = useRef(showAtmIv);
  const showOptionsRef  = useRef(showOptions);
  showDeltaRef.current    = showDelta;
  showIvRef.current       = showIv;
  showAtmIvRef.current    = showAtmIv;
  showOptionsRef.current  = showOptions;
  const optionsFetchedRef = useRef(false); // true once options data has been loaded
  const atmIvSeriesRef        = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const atmIvLiveBarRef       = useRef<Map<string, LineData>>(new Map());   // sym → live bar
  const atmIvCurrentStrikeRef = useRef<Map<string, number>>(new Map());     // sym → current ATM strike (rupees)
  const atmIvSubRefIds        = useRef<Map<string, Set<number>>>(new Map()); // sym → subscribed ATM ref_ids
  const atmIvLatestIv         = useRef<Map<string, Map<number, number>>>(new Map()); // sym → (refId → IV)
  const atmIvSubscribeFnRef   = useRef<((sym: string, expiry: string, strike: number) => void) | null>(null);

  // ── Vertical split: chart (top) vs MTM panel (bottom) ────────────────────────
  const [chartHeightPct, setChartHeightPct] = useState(70);
  const splitDragging = useRef(false);
  const splitWrapRef  = useRef<HTMLDivElement>(null);

  const onSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDragging.current = true;
    document.body.style.cursor    = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!splitDragging.current || !splitWrapRef.current) return;
      const rect = splitWrapRef.current.getBoundingClientRect();
      const pct  = ((ev.clientY - rect.top) / rect.height) * 100;
      setChartHeightPct(Math.min(90, Math.max(20, pct)));
    };
    const onUp = () => {
      splitDragging.current          = false;
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  }, []);

  const uniqueLegs = legs.filter((leg, i, arr) =>
    arr.findIndex(l => l.symbol === leg.symbol && l.strike === leg.strike && l.type === leg.type && l.expiry === leg.expiry) === i
  );
  // Keep legsRef always fresh so callbacks with [] deps can read latest legs
  legsRef.current = legs;

  // ── Resolve underlying Nubra symbol + type ───────────────────────────────────
  // Returns { symbol, exchange, nubraType } where nubraType is 'INDEX' or 'STOCK'
  // Resolve one underlying entry per unique leg symbol
  const resolveUnderlyings = useCallback((): UnderlyingInfo[] => {
    const uniqueSymbols = [...new Set(uniqueLegs.map(l => l.symbol).filter(Boolean))];
    if (uniqueSymbols.length === 0 && ocSymbol) uniqueSymbols.push(ocSymbol);

    const resolveOne = (rawSym: string, rawExch: string): UnderlyingInfo | null => {
      const sym = rawSym.toUpperCase();
      const exch = (rawExch || 'NSE').toUpperCase();

      // MCX uses Upstox candles + wsManager
      if (exch === 'MCX') {
        const key = findMcxSpotKey(sym, instruments);
        if (key) {
          return { symbol: rawSym, exchange: 'MCX', nubraType: 'MCX', source: 'MCX', instrumentKey: key };
        }
        return { symbol: rawSym, exchange: 'MCX', nubraType: 'MCX', source: 'MCX' };
      }

      // 0. Derive from option legs' own nubraInstrument entry
      if (nubraInstruments.length) {
        const optIns = nubraInstruments.find(i =>
          (i.option_type === 'CE' || i.option_type === 'PE') &&
          ((i.asset ?? '').toUpperCase() === sym ||
           (i.nubra_name ?? '').toUpperCase() === sym ||
           (i.stock_name ?? '').toUpperCase().startsWith(sym))
        );
        if (optIns?.asset) {
          const nubraType = (optIns.asset_type ?? '').includes('INDEX') ? 'INDEX' : 'STOCK';
          return { symbol: optIns.asset, exchange: optIns.exchange || exch, nubraType, source: 'NUBRA' };
        }
      }

      // 1. Try nubraIndexes (INDEX type)
      if (nubraIndexes.length) {
        const score = (i: Record<string, string>): number => {
          const nm  = (i.INDEX_NAME ?? i.index_name ?? '').toUpperCase().trim();
          const exf = (i.EXCHANGE   ?? i.exchange   ?? '').toUpperCase();
          const exchBonus = exf === exch ? 10 : 0;
          if (nm === sym) return 1000 + exchBonus;
          if (nm === sym + ' 50') return 900 + exchBonus;
          if (nm.startsWith(sym + ' ') && nm.split(' ').length === 2) return 800 + exchBonus;
          if (nm.startsWith(sym + ' ')) return 500 - nm.length + exchBonus;
          const words = nm.split(/[\s&]+/);
          if (words.includes(sym)) return 400 + exchBonus;
          return -1;
        };
        let best: Record<string, string> | null = null;
        let bestScore = -1;
        for (const i of nubraIndexes) {
          const s = score(i);
          if (s > bestScore) { bestScore = s; best = i; }
        }
        if (best && bestScore >= 0) {
          const symbol   = best.ZANSKAR_INDEX_SYMBOL ?? best.zanskar_index_symbol ?? best.INDEX_SYMBOL ?? best.index_symbol ?? '';
          const exchange = best.EXCHANGE ?? best.exchange ?? exch;
          if (symbol) return { symbol, exchange, nubraType: 'INDEX', source: 'NUBRA' };
        }
      }

      // 2. Fall back to nubraInstruments STOCK
      if (nubraInstruments.length) {
        const matches = nubraInstruments.filter(i =>
          i.derivative_type === 'STOCK' &&
          ((i.asset ?? '').toUpperCase() === sym ||
           (i.stock_name ?? '').toUpperCase() === sym ||
           (i.nubra_name ?? '').toUpperCase() === sym)
        );
        const ins = matches.find(i => (i.exchange ?? '').toUpperCase() === exch) ?? matches[0];
        if (ins) {
          return { symbol: ins.stock_name || ins.nubra_name || ins.asset, exchange: ins.exchange || exch, nubraType: 'STOCK', source: 'NUBRA' };
        }
      }

      return null;
    };

    const results: UnderlyingInfo[] = [];
    for (const sym of uniqueSymbols) {
      // Use leg.exchange directly — set at entry time from option chain
      const legExch = uniqueLegs.find(l => l.symbol === sym)?.exchange;
      const resolved = resolveOne(sym, legExch || ocExchange);
      if (resolved) results.push(resolved);
    }
    return results;
  }, [ocSymbol, ocExchange, uniqueLegs, nubraIndexes, nubraInstruments, instruments]);

  // ── Resolve option symbol / instrumentKey ───────────────────────────────────
  const resolveOption = useCallback((leg: StrategyLeg): OptionInfo | null => {
    const legExch = (leg.exchange || ocExchange || '').toUpperCase();
    const key = `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`;

    if (legExch === 'MCX') {
      const instrumentKey = resolveMcxOptionKey(leg, instruments);
      if (!instrumentKey) return null;
      return { key, exchange: 'MCX', source: 'MCX', instrumentKey, symbol: leg.symbol };
    }

    // Nubra options
    const sym = (leg.symbol || ocSymbol).toUpperCase();
    if (leg.refId) {
      const ins = nubraInstruments.find(i => String(i.ref_id) === String(leg.refId));
      if (ins) return { key, symbol: ins.stock_name || ins.nubra_name, exchange: ins.exchange || 'NSE', source: 'NUBRA' };
    }
    const strikePaise = Math.round(leg.strike * 100);
    const ins = nubraInstruments.find(i =>
      i.option_type === leg.type &&
      String(i.expiry) === String(leg.expiry) &&
      Math.abs((i.strike_price ?? 0) - strikePaise) < 2 &&
      ((i.asset      ?? '').toUpperCase() === sym ||
       (i.nubra_name ?? '').toUpperCase() === sym ||
       (i.stock_name ?? '').toUpperCase().startsWith(sym))
    );
    if (ins) return { key, symbol: ins.stock_name || ins.nubra_name, exchange: ins.exchange || 'NSE', source: 'NUBRA' };
    return null;
  }, [ocSymbol, ocExchange, nubraInstruments, instruments]);

  // ── Init chart ONCE on mount ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#171717' },
        textColor: '#C3CAD6',
        fontSize: 13,
        fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
        panes: {
          separatorColor:      'rgba(255,255,255,0.08)',
          separatorHoverColor: 'rgba(255,255,255,0.20)',
          enableResize: true,
        },
      },
      grid:      { vertLines: { color: '#2c2c2c' }, horzLines: { color: '#2c2c2c' } },
      crosshair: { mode: 0 },
      leftPriceScale:  { visible: true, borderColor: '#3a3a3a', scaleMargins: { top: 0.06, bottom: 0.06 } },
      rightPriceScale: { visible: true, borderColor: '#3a3a3a', scaleMargins: { top: 0.58, bottom: 0.04 } },
      localization: {
        timeFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
          }),
      },
      timeScale: {
        borderColor: '#3a3a3a', timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (ts: number) => {
          const d = new Date(ts * 1000);
          const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
          const hh = String(ist.getUTCHours()).padStart(2, '0');
          const mm = String(ist.getUTCMinutes()).padStart(2, '0');
          const dd = ist.getUTCDate();
          const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][ist.getUTCMonth()];
          // Show date label when minute is 00 (day boundary), else HH:MM
          return mm === '00' && hh === '09' ? `${dd} ${mon}` : `${hh}:${mm}`;
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    // Keep pane 0 (spot price) at 45% of container height at all times
    const applyPaneHeights = () => {
      const totalH = containerRef.current?.clientHeight ?? 0;
      if (!totalH) return;
      const p0h = Math.round(totalH * 0.45);
      try { chart.panes()[0]?.setHeight(p0h); } catch { /**/ }
    };
    let roRaf = 0;
    const ro = new ResizeObserver(() => {
      if (roRaf) cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => {
        roRaf = 0;
        applyPaneHeights();
      });
    });
    if (containerRef.current) ro.observe(containerRef.current);
    setTimeout(applyPaneHeights, 100);

    setChartReady(true);
    return () => {
      if (roRaf) cancelAnimationFrame(roRaf);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      setChartReady(false);
      seriesRef.current = { underlyings: new Map(), mtm: null, mtmPerUnderlying: new Map(), options: new Map(), deltas: new Map(), ivs: new Map() };
    };
  }, []);

  // ── Sync series whenever legs / symbol change ─────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ss = seriesRef.current;
    const newLegKeys = new Set(uniqueLegs.map(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}`));

    for (const [key, s] of ss.options) {
      if (!newLegKeys.has(key)) { try { chart.removeSeries(s); } catch { /**/ } ss.options.delete(key); }
    }
    for (const [key, s] of ss.deltas) {
      if (!newLegKeys.has(key)) { try { chart.removeSeries(s); } catch { /**/ } ss.deltas.delete(key); }
    }
    for (const [key, s] of ss.ivs) {
      if (!newLegKeys.has(key)) { try { chart.removeSeries(s); } catch { /**/ } ss.ivs.delete(key); }
    }

    // Underlying series — one per unique symbol in legs, each on its own RIGHT axis scale
    const uniqueSymbols = [...new Set(uniqueLegs.map(l => l.symbol))];
    // Remove series for symbols no longer in legs
    for (const [sym, s] of ss.underlyings) {
      if (!uniqueSymbols.includes(sym)) { try { chart.removeSeries(s); } catch { /**/ } ss.underlyings.delete(sym); }
    }
    // Add series for new symbols
    uniqueSymbols.forEach((sym, idx) => {
      if (!ss.underlyings.has(sym)) {
        const color = UNDERLYING_COLORS[idx % UNDERLYING_COLORS.length];
        const scaleId = `u:${sym}`;
        ss.underlyings.set(sym, chart.addSeries(LineSeries, {
          color, lineWidth: 2, title: sym,
          priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
          priceScaleId: scaleId,
        }, 0));
        chart.priceScale(scaleId).applyOptions({
          scaleMargins: { top: 0.04, bottom: 0.52 },
          visible: true,
          borderColor: '#2a2a2a',
        });
      }
    });

    // Short expiry label e.g. "17Mar" from "17 Mar 26" or "2026-03-17"
    const shortExpiry = (expiry: string): string => {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      // Try "DD Mon YY" format e.g. "17 Mar 26"
      const m1 = expiry.match(/^(\d{1,2})\s+([A-Za-z]{3})/);
      if (m1) return `${m1[1]}${m1[2].charAt(0).toUpperCase() + m1[2].slice(1,3).toLowerCase()}`;
      // Try "YYYY-MM-DD" format
      const m2 = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m2) return `${parseInt(m2[3])}${months[parseInt(m2[2]) - 1]}`;
      return expiry;
    };

    let ceCount = 0, peCount = 0;
    for (const leg of uniqueLegs) {
      const key = `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`;
      const colorIdx = leg.type === 'CE' ? ceCount++ : peCount++;
      const color = optionColor(leg.type, colorIdx);
      const label = `${leg.strike}${leg.type} ${shortExpiry(leg.expiry)}`;

      if (!ss.options.has(key)) {
        ss.options.set(key, chart.addSeries(LineSeries, {
          color, lineWidth: 2 as 2, title: label,
          priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
          priceScaleId: 'left',
          visible: showOptionsRef.current,
        }, 0));
        chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.04, bottom: 0.52 }, borderColor: '#2a2a2a' });
      }
      if (!ss.deltas.has(key)) {
        ss.deltas.set(key, chart.addSeries(LineSeries, {
          color: leg.type === 'CE' ? DELTA_COLORS[colorIdx % DELTA_COLORS.length] : PE_COLORS[colorIdx % PE_COLORS.length],
          lineWidth: 2 as 2, title: `Δ ${label}`,
          priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
        }, 1));
        try { chart.panes()[1]?.setHeight(110); } catch { /**/ }
      }
      if (!ss.ivs.has(key)) {
        ss.ivs.set(key, chart.addSeries(LineSeries, {
          color: IV_COLORS[colorIdx % IV_COLORS.length],
          lineWidth: 2 as 2, title: `IV ${label}`,
          priceFormat: { type: 'percent', precision: 2, minMove: 0.01 },
        }, 2));
        try { chart.panes()[2]?.setHeight(90); } catch { /**/ }
      }
    }

    // MTM baseline series — pane 0, right axis (separate scale id so it doesn't mix with option prices)
    if (!ss.mtm) {
      const mtmVisible = showMtmRef.current && (mtmViewRef.current === 'all' || mtmViewRef.current === 'total');
      ss.mtm = chart.addSeries(BaselineSeries, {
        visible: mtmVisible,
        title: 'MTM',
        baseValue: { type: 'price', price: 0 },
        topLineColor:    'rgba(38,166,154,0.9)',
        topFillColor1:   'rgba(38,166,154,0.25)',
        topFillColor2:   'rgba(38,166,154,0.05)',
        bottomLineColor: 'rgba(242,54,69,0.9)',
        bottomFillColor1:'rgba(242,54,69,0.05)',
        bottomFillColor2:'rgba(242,54,69,0.25)',
        lineWidth: 2 as 2,
        priceScaleId: 'right',
        priceFormat: {
          type: 'custom',
          minMove: 0.01,
          formatter: (v: number) => {
            const abs = Math.abs(v);
            if (abs >= 100000) return `₹${(v / 100000).toFixed(2)}L`;
            if (abs >= 1000)   return `₹${(v / 1000).toFixed(2)}K`;
            return `₹${v.toFixed(2)}`;
          },
        },
      }, 0);
    }

    // Per-underlying MTM lines — only when >1 underlying
    const uniqueSyms = [...new Set(uniqueLegs.map(l => l.symbol))];
    // Remove stale per-underlying MTM series
    for (const [sym, s] of ss.mtmPerUnderlying) {
      if (!uniqueSyms.includes(sym)) { try { chart.removeSeries(s); } catch { /**/ } ss.mtmPerUnderlying.delete(sym); }
    }
    if (uniqueSyms.length > 1) {
      const MTM_PER_COLORS = ['#60a5fa', '#fb923c', '#34d399', '#a78bfa', '#f472b6'];
      uniqueSyms.forEach((sym, idx) => {
        if (!ss.mtmPerUnderlying.has(sym)) {
          const color = MTM_PER_COLORS[idx % MTM_PER_COLORS.length];
          const perVisible = showMtmRef.current && (mtmViewRef.current === 'all' || mtmViewRef.current === sym);
          const s = chart.addSeries(LineSeries, {
            color, lineWidth: 2 as 2,
            title: `MTM ${sym}`,
            priceScaleId: 'right',
            lineStyle: 0, // solid
            visible: perVisible,
            priceFormat: {
              type: 'custom',
              minMove: 0.01,
              formatter: (v: number) => {
                const abs = Math.abs(v);
                if (abs >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
                if (abs >= 1000)   return `₹${(v / 1000).toFixed(1)}K`;
                return `₹${v.toFixed(0)}`;
              },
            },
          }, 0);
          ss.mtmPerUnderlying.set(sym, s);
        }
      });
    } else {
      // Only 1 underlying — remove all per-underlying series
      for (const [, s] of ss.mtmPerUnderlying) { try { chart.removeSeries(s); } catch { /**/ } }
      ss.mtmPerUnderlying.clear();
    }

    const items: { label: string; color: string }[] = uniqueSyms.map((sym, idx) => ({ label: sym, color: UNDERLYING_COLORS[idx % UNDERLYING_COLORS.length] }));
    let ci = 0, pi = 0;
    for (const leg of uniqueLegs) {
      if (leg.type === 'CE') items.push({ label: `${leg.strike} CE`, color: CE_COLORS[ci++ % CE_COLORS.length] });
      else                   items.push({ label: `${leg.strike} PE`, color: PE_COLORS[pi++ % PE_COLORS.length] });
    }
    items.push({ label: 'MTM', color: '#26a69a' });
    setLegendItems(items);
  }, [ocSymbol, uniqueLegs.map(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Push accum into chart series ──────────────────────────────────────────────
  const flushAccum = useCallback((prepend = false) => {
    const chart = chartRef.current;
    const ss    = seriesRef.current;
    const acc   = accumRef.current;
    const ts    = chart?.timeScale();

    const savedRange           = prepend ? ts?.getVisibleLogicalRange() : null;
    const snapUnderlyings      = new Map(acc.underlyings);
    const snapMtmPerUnderlying = new Map(acc.mtmPerUnderlying);
    const snapMtm          = acc.mtm.slice();
    const snapOptions = new Map(acc.options);
    const snapDeltas  = new Map(acc.deltas);
    const snapIvs     = new Map(acc.ivs);

    // Compute entry marker timestamps — use entryDate+entryTime, floored to minute
    // Use legsRef.current (always fresh) because flushAccum has [] deps
    // One arrowUp marker per unique timestamp — legs at same time are grouped, count shown as text
    const entryMarkers: SeriesMarker<Time>[] = [];
    const timeLegs = new Map<number, typeof legsRef.current>();
    for (const leg of legsRef.current) {
      if (!leg.entryTime || !leg.entryDate) continue;
      const [hh, mm] = leg.entryTime.split(':').map(Number);
      const [yr, mo, dy] = leg.entryDate.split('-').map(Number);
      const midUtc = Date.UTC(yr, mo - 1, dy) / 1000;
      const t = Math.round(midUtc + hh * 3600 + mm * 60 - 5.5 * 3600);
      const arr = timeLegs.get(t) ?? [];
      arr.push(leg);
      timeLegs.set(t, arr);
    }
    for (const [t, tLegs] of timeLegs) {
      const count = tLegs.length;
      // Label: single leg → "B 24500CE", multiple legs → "↑ 3 legs"
      const label = count === 1
        ? `${tLegs[0].action} ${tLegs[0].strike}${tLegs[0].type}`
        : `${count} legs`;
      entryMarkers.push({
        time: t as unknown as Time,
        position: 'belowBar',
        color: '#e0a800',
        shape: 'arrowUp',
        text: label,
        size: count > 2 ? 2 : 1,
      });
    }

    requestAnimationFrame(() => {
      for (const [sym, data] of snapUnderlyings) ss.underlyings.get(sym)?.setData(data);
      if (ss.mtm && snapMtm.length) ss.mtm.setData(snapMtm);
      for (const [sym, data] of snapMtmPerUnderlying) ss.mtmPerUnderlying.get(sym)?.setData(data);
      for (const [key, data] of snapOptions) ss.options.get(key)?.setData(data);
      for (const [key, data] of snapDeltas)  ss.deltas.get(key)?.setData(data);
      for (const [key, data] of snapIvs)     ss.ivs.get(key)?.setData(data);

      // Place entry markers on the MTM series — yellow arrowUp per entry time
      if (entryMarkers.length && ss.mtm) {
        try {
          markersPluginRef.current?.detach();
          markersPluginRef.current = createSeriesMarkers(ss.mtm, entryMarkers);
        } catch { /**/ }
      }

      if (prepend && savedRange && ts) {
        ts.setVisibleLogicalRange(savedRange);
      } else if (!prepend && ts) {
        // Scroll to right edge showing last INITIAL_VISIBLE bars
        const firstUnderly = snapUnderlyings.values().next().value ?? [];
        const refData = firstUnderly.length ? firstUnderly
          : (snapOptions.values().next().value ?? []);
        if (refData.length > 0) {
          const visible = Math.min(INITIAL_VISIBLE, refData.length);
          const from = refData[refData.length - visible].time;
          const to   = refData[refData.length - 1].time;
          setTimeout(() => ts.setVisibleRange({ from, to }), 50);
        } else {
          chart?.timeScale().fitContent();
        }
        if (mcxHasRef.current && !mcxAutoScrollRef.current) {
          mcxAutoScrollRef.current = true;
          setTimeout(() => scrollToLatest(), 80);
        }
      }
    });
  }, []);

  // ── Fetch one trading day into accumulator ────────────────────────────────────
  // Returns true if any data came back
  const fetchDay = useCallback(async (
    date: string,
    today: string,
    underlyings: UnderlyingInfo[],
    legInfos: OptionInfo[],
    prepend: boolean,
  ): Promise<boolean> => {
    if (loadedDatesRef.current.has(date)) return true;
    loadedDatesRef.current.add(date);

    let gotAny = false;
    const acc = accumRef.current;

    // In historical mode, pass entry time so fetch starts from that time (not 9:15)
    const entryDate = isHistoricalMode
      ? (uniqueLegs.map(l => l.entryDate).filter(Boolean).sort().at(0) ?? today)
      : today;
    const entryTimeIst = (isHistoricalMode && date === entryDate)
      ? uniqueLegs.map(l => l.entryTime).filter(Boolean).sort().at(0)
      : undefined;
    let entryUnix = 0;
    if (isHistoricalMode && entryTimeIst && date === entryDate) {
      const [hh, mm] = entryTimeIst.split(':').map(Number);
      const [yr, mo, dy] = date.split('-').map(Number);
      const midnightUtc = Date.UTC(yr, mo - 1, dy) / 1000;
      entryUnix = midnightUtc + hh * 3600 + mm * 60 - 5.5 * 3600;
    }

    await Promise.all([
      // All underlyings (Nubra for NSE/BSE, Upstox for MCX)
      ...underlyings.map(u =>
        fetchUnderlyingForDate(u, date, today, entryTimeIst, isHistoricalMode)
          .then(data => {
            if (data.length) {
              gotAny = true;
              const filtered = entryUnix ? data.filter(pt => (pt.time as number) >= entryUnix) : data;
              const prev = acc.underlyings.get(u.symbol) ?? [];
              acc.underlyings.set(u.symbol, prepend ? mergeData(filtered, prev) : mergeData(prev, filtered));
            }
          })
          .catch((e: any) => console.warn('[StrategyChart] underlying failed:', u.symbol, date, e.message))
      ),

      // Each option: always fetch close for MTM computation — visibility toggled separately
      ...legInfos.map((info) =>
        fetchOptionCloseForDateAny(info, date, today, entryTimeIst, isHistoricalMode)
          .then(({ close }) => {
            const filtered = entryUnix ? close.filter(pt => (pt.time as number) >= entryUnix) : close;
            if (filtered.length) {
              gotAny = true;
              const prev = acc.options.get(info.key) ?? [];
              acc.options.set(info.key, prepend ? mergeData(filtered, prev) : mergeData(prev, filtered));
            }
          })
          .catch((e: any) => console.warn('[StrategyChart] option failed', info.symbol ?? info.instrumentKey ?? 'MCX', date, e.message))
      ),
    ]);

    // Recompute MTM fresh from ALL accumulated option data
    if (gotAny && legInfos.length > 0) {
      acc.mtm = computeMtmFromOptions(legInfos, uniqueLegs, acc.options);
      acc.mtmPerUnderlying = computeMtmPerUnderlyingSymbol(legInfos, uniqueLegs, acc.options);
    }

    return gotAny;
  }, [uniqueLegs, isHistoricalMode]);

  // ── Initial load: today only via Nubra ───────────────────────────────────────
  const fetchAll = useCallback(async () => {
    const effectiveSymbol = ocSymbol || uniqueLegs[0]?.symbol || '';
    if (!effectiveSymbol || uniqueLegs.length === 0 || !chartRef.current) return;
    setLoading(true);
    setError('');
    setFromDate(null);
    setToDate(null);

    accumRef.current = { underlyings: new Map(), mtm: [], mtmPerUnderlying: new Map(), options: new Map(), deltas: new Map(), ivs: new Map() };
    loadedDatesRef.current   = new Set();
    deltaLoadedRef.current   = new Set();
    ivLoadedRef.current      = new Set();
    deltaRangeSigRef.current = '';
    ivRangeSigRef.current    = '';
    oldestDateRef.current    = null;
    isLoadingMoreRef.current = false;
    loadLockRef.current      = false;
    mcxAutoScrollRef.current = false;
    optionsFetchedRef.current = false;

    const underlyings = resolveUnderlyings();
    const hasMcx = underlyings.some(u => u.source === 'MCX');
    mcxHasRef.current = hasMcx;
    const legInfos: OptionInfo[] = [];
    const errors: string[] = [];

    for (const leg of uniqueLegs) {
      const info = resolveOption(leg);
      if (!info) { errors.push(`no symbol for ${leg.strike}${leg.type} ${leg.expiry}`); continue; }
      legInfos.push(info);
    }

    try {
      const today = lastTradingDay();
      const startDate = isHistoricalMode
        ? (uniqueLegs.map(l => l.entryDate).filter(Boolean).sort().at(0) ?? today)
        : today;
      const startTimeIst = isHistoricalMode
        ? uniqueLegs.filter(l => l.entryDate === startDate).map(l => l.entryTime).filter(Boolean).sort().at(0)
        : undefined;

      if (isHistoricalMode) {
        let gotAny = false;
        let entryUnix = 0;
        if (startTimeIst) {
          const [hh, mm] = startTimeIst.split(':').map(Number);
          const [yr, mo, dy] = startDate.split('-').map(Number);
          const midnightUtc = Date.UTC(yr, mo - 1, dy) / 1000;
          entryUnix = midnightUtc + hh * 3600 + mm * 60 - 5.5 * 3600;
        }

        await Promise.all([
          ...underlyings.map(u =>
            fetchUnderlyingRange(u, startDate, today, startTimeIst)
              .then(data => {
                const filtered = entryUnix ? data.filter(pt => (pt.time as number) >= entryUnix) : data;
                if (filtered.length) {
                  gotAny = true;
                  accumRef.current.underlyings.set(u.symbol, filtered);
                }
              })
              .catch((e: any) => console.warn('[StrategyChart] underlying range failed:', u.symbol, e.message))
          ),
          // Always fetch option close for MTM — visibility toggled separately
          ...legInfos.map((info) =>
            fetchOptionCloseRangeAny(info, startDate, today, startTimeIst)
              .then(({ close }) => {
                const filtered = entryUnix ? close.filter(pt => (pt.time as number) >= entryUnix) : close;
                if (filtered.length) {
                  gotAny = true;
                  accumRef.current.options.set(info.key, filtered);
                }
              })
              .catch((e: any) => console.warn('[StrategyChart] option range failed', info.symbol ?? info.instrumentKey ?? 'MCX', e.message))
          ),
        ]);

        if (gotAny) {
          accumRef.current.mtm = computeMtmFromOptions(legInfos, uniqueLegs, accumRef.current.options);
          accumRef.current.mtmPerUnderlying = computeMtmPerUnderlyingSymbol(legInfos, uniqueLegs, accumRef.current.options);
          oldestDateRef.current = startDate;
          setFromDate(startDate);
          setToDate(today);
          flushAccum(false);
          // Fire LTP snapshot from last historical close per leg
          if (onLtpSnapshot) {
            const snap = new Map<string, number>();
            for (const [key, pts] of accumRef.current.options) {
              const last = pts[pts.length - 1];
              if (last) snap.set(key, last.value as number);
            }
            if (snap.size) onLtpSnapshot(snap);
          }
        } else {
          errors.push(`No data for ${startDate} → ${today}`);
        }
      } else {
        const got = await fetchDay(startDate, today, underlyings, legInfos, false);
        if (got) {
          oldestDateRef.current = startDate;
          setFromDate(startDate);
          setToDate(startDate);
          flushAccum(false);
          // Fire LTP snapshot from last historical close per leg
          if (onLtpSnapshot) {
            const snap = new Map<string, number>();
            for (const [key, pts] of accumRef.current.options) {
              const last = pts[pts.length - 1];
              if (last) snap.set(key, last.value as number);
            }
            if (snap.size) onLtpSnapshot(snap);
          }
        } else {
          // No candle data yet — market may not have opened. But if currLtp is
          // already live (pushed by the currLtp sync effect), don't show an error.
          const hasLiveLtp = legsRef.current.some(l => (l.currLtp ?? 0) > 0);
          if (!hasLiveLtp) {
            errors.push('No data for today — market may not have opened yet');
          }
        }
      }
    } catch (e: any) {
      errors.push(e.message ?? String(e));
    } finally {
      // Only surface errors when there is truly no data on the chart.
      // If underlyings or options loaded successfully, suppress soft errors
      // (e.g. a single unresolved leg) so the chart isn't misleading.
      if (errors.length) {
        const acc = accumRef.current;
        const hasData = acc.underlyings.size > 0 || acc.options.size > 0;
        if (!hasData) setError(errors[0]);
      }
      optionsFetchedRef.current = true;
      setLoading(false);
    }
  }, [ocSymbol, uniqueLegs, resolveUnderlyings, resolveOption, fetchDay, flushAccum, isHistoricalMode, scrollToLatest]); // eslint-disable-line react-hooks/exhaustive-deps

  fetchAllRef.current = fetchAll;

  // ── loadMore: step back one trading day on scroll-left ────────────────────────
  const loadMore = useCallback(async () => {
    if (isHistoricalMode) return; // historical mode: entry date is the oldest, never load before it
    if (loadLockRef.current || isLoadingMoreRef.current || !oldestDateRef.current) return;

    isLoadingMoreRef.current = true;
    loadLockRef.current = true;
    setLoadingMore(true);

    const today    = lastTradingDay();
    const prevDate = prevTradingDay(oldestDateRef.current);
    const underlyings = resolveUnderlyings();
    const legInfos: OptionInfo[] = [];
    for (const leg of uniqueLegs) {
      const info = resolveOption(leg);
      if (info) legInfos.push(info);
    }

    // Snapshot visible range BEFORE async work so we can restore it after setData
    const ts       = chartRef.current?.timeScale();
    const visRange = ts?.getVisibleRange();

    try {
      if (!loadedDatesRef.current.has(prevDate)) {
        await fetchDay(prevDate, today, underlyings, legInfos, true);
        oldestDateRef.current = prevDate;
        setFromDate(prevDate);
      }

      // Apply data then restore view
      const ss  = seriesRef.current;
      const acc = accumRef.current;
      requestAnimationFrame(() => {
        for (const [sym, data] of acc.underlyings) ss.underlyings.get(sym)?.setData(data);
        if (ss.mtm && acc.mtm.length) ss.mtm.setData(acc.mtm);
        for (const [sym, data] of acc.mtmPerUnderlying) ss.mtmPerUnderlying.get(sym)?.setData(data);
        for (const [key, data] of acc.options) ss.options.get(key)?.setData(data);
        for (const [key, data] of acc.deltas)  ss.deltas.get(key)?.setData(data);
        for (const [key, data] of acc.ivs)     ss.ivs.get(key)?.setData(data);
        if (visRange && ts) setTimeout(() => ts.setVisibleRange(visRange), 50);
      });

    } catch (e) {
      console.warn('[StrategyChart] loadMore error', e);
    } finally {
      isLoadingMoreRef.current = false;
      setLoadingMore(false);
      setTimeout(() => { loadLockRef.current = false; }, 800);
    }
  }, [resolveUnderlyings, resolveOption, uniqueLegs, fetchDay, isHistoricalMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Subscribe to scroll: trigger loadMore at left edge ───────────────────────
  useEffect(() => {
    if (!chartReady) return;
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();

    const handler = (range: LogicalRange | null) => {
      if (!range || loadLockRef.current || !oldestDateRef.current) return;
      const ss = seriesRef.current;
      const refSeries = ss.underlyings.values().next().value ?? ss.options.values().next().value ?? null;
      const barsInfo = refSeries?.barsInLogicalRange(range);
      if (barsInfo && barsInfo.barsBefore < 20) loadMore();
    };

    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
  }, [loadMore, chartReady]);

  // Mark user interaction (scroll/drag) to throttle WS updates
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const mark = () => {
      isInteractingRef.current = true;
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      interactionTimerRef.current = setTimeout(() => { isInteractingRef.current = false; }, 150);
    };
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('pointerdown', mark);
    el.addEventListener('touchstart', mark, { passive: true });
    return () => {
      el.removeEventListener('wheel', mark as any);
      el.removeEventListener('pointerdown', mark as any);
      el.removeEventListener('touchstart', mark as any);
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      isInteractingRef.current = false;
    };
  }, []);

  const legsKey = useMemo(() => (
    legs.map(l => `${l.symbol}:${l.strike}${l.type}${l.expiry}${l.refId ?? ''}:${l.entryDate ?? ''}:${l.entryTime ?? ''}`).join(',')
  ), [legs]);

  const mtmKey = useMemo(() => (
    legs.map(l => `${l.symbol}:${l.strike}${l.type}${l.expiry}:${l.action}:${l.price}:${l.lots}:${l.lotSize}:${l.entryDate ?? ''}:${l.entryTime ?? ''}`).join(',')
  ), [legs]);


  // Recompute MTM immediately when lots/lotSize/price/action change (no refetch)
  useEffect(() => {
    if (uniqueLegs.length === 0) return;
    const acc = accumRef.current;
    if (acc.options.size === 0) return;
    const legInfos = uniqueLegs.map(l => ({ key: `${l.symbol}:${l.strike}${l.type}:${l.expiry}` }));
    acc.mtm = computeMtmFromOptions(legInfos, uniqueLegs, acc.options);
    acc.mtmPerUnderlying = computeMtmPerUnderlyingSymbol(legInfos, uniqueLegs, acc.options);
    const ss = seriesRef.current;
    if (ss.mtm) ss.mtm.setData(acc.mtm);
    for (const [sym, data] of acc.mtmPerUnderlying) ss.mtmPerUnderlying.get(sym)?.setData(data);
  }, [mtmKey, uniqueLegs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync live MTM bar from currLtp prop (keeps chart in sync with the tab) ───
  // Runs whenever any leg's currLtp changes — no refetch needed
  useEffect(() => {
    if (uniqueLegs.length === 0) return;
    // Only sync if at least one leg has a live currLtp
    const hasLive = uniqueLegs.some(l => (l.currLtp ?? 0) > 0);
    if (!hasLive) return;

    const nowUnix = Math.floor(Date.now() / 60000) * 60;
    const t = nowUnix as unknown as Time;

    let total = 0;
    for (const leg of uniqueLegs) {
      const ltp = (leg.currLtp ?? 0) > 0 ? leg.currLtp! : leg.price;
      total += (leg.action === 'B' ? ltp - leg.price : leg.price - ltp) * leg.lots * (leg.lotSize || 1);
    }

    // Update accum + series for total MTM
    const acc = accumRef.current;
    const ss  = seriesRef.current;
    const mtmPt: BaselineData = { time: t, value: total };
    const last = acc.mtm[acc.mtm.length - 1];
    if (last && (last.time as number) === nowUnix) acc.mtm[acc.mtm.length - 1] = mtmPt;
    else acc.mtm.push(mtmPt);
    ss.mtm?.update(mtmPt);

    // Also update acc.options so per-underlying MTM is consistent
    for (const leg of uniqueLegs) {
      const ltp = (leg.currLtp ?? 0) > 0 ? leg.currLtp! : leg.price;
      const key = `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`;
      const optPts = acc.options.get(key) ?? [];
      const lastOpt = optPts[optPts.length - 1];
      const pt: LineData = { time: t, value: ltp };
      if (lastOpt && (lastOpt.time as number) === nowUnix) optPts[optPts.length - 1] = pt;
      else optPts.push(pt);
      acc.options.set(key, optPts);
      ss.options.get(key)?.update(pt);
    }

    // Per-underlying MTM lines
    if (ss.mtmPerUnderlying.size > 0) {
      const uniqueSymbols = [...new Set(uniqueLegs.map(l => l.symbol))];
      for (const sym of uniqueSymbols) {
        const symLegs = uniqueLegs.filter(l => l.symbol === sym);
        let symTotal = 0;
        for (const leg of symLegs) {
          const ltp = (leg.currLtp ?? 0) > 0 ? leg.currLtp! : leg.price;
          symTotal += (leg.action === 'B' ? ltp - leg.price : leg.price - ltp) * leg.lots * (leg.lotSize || 1);
        }
        const symPt: LineData = { time: t, value: symTotal };
        const symPts = acc.mtmPerUnderlying.get(sym) ?? [];
        const lastSym = symPts[symPts.length - 1];
        if (lastSym && (lastSym.time as number) === nowUnix) symPts[symPts.length - 1] = symPt;
        else symPts.push(symPt);
        acc.mtmPerUnderlying.set(sym, symPts);
        ss.mtmPerUnderlying.get(sym)?.update(symPt);
      }
    }
  }, [legs.map(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}:${(l.currLtp ?? 0).toFixed(2)}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-fetch when legs / symbol / mode change ──────────────────────────────
  useEffect(() => {
    if (uniqueLegs.length === 0) return;
    const t = setTimeout(() => fetchAllRef.current(), 50);
    return () => clearTimeout(t);
  }, [legsKey, ocSymbol, isHistoricalMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when nubraInstruments loads after legs were already added
  useEffect(() => {
    if (nubraInstruments.length === 0 || uniqueLegs.length === 0) return;
    const t = setTimeout(() => fetchAllRef.current(), 50);
    return () => clearTimeout(t);
  }, [nubraInstruments.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live WS feed — greeks per refId + option per symbol for spot ─────────────
  useEffect(() => {
    const effectiveSymbol = ocSymbol || uniqueLegs[0]?.symbol || '';
    if (!isMarketOpen() || uniqueLegs.length === 0 || !effectiveSymbol) return;

    wsRef.current?.close();
    wsRef.current = null;
    wsTickRef.current = [];

    const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
    if (!sessionToken) return;

    // refIds for per-leg LTP/greeks — direct, no symbol dependency
    const refIds = uniqueLegs.map(l => l.refId).filter((id): id is number => id !== undefined);

    // Use resolveUnderlyings() — same logic that fetches historical data, gives correct Nubra symbol + exchange
    const underlyingInfos = resolveUnderlyings().filter(u => u.source !== 'MCX');
    // Group by exchange for one sub per exchange group
    const byExchange = new Map<string, string[]>();
    for (const u of underlyingInfos) {
      const exch = u.exchange.toUpperCase();
      if (!byExchange.has(exch)) byExchange.set(exch, []);
      byExchange.get(exch)!.push(u.symbol);
    }
    // Map: Nubra symbol (uppercase) → leg symbol (for acc/series key lookup in applyIndexTick)
    const nubraSymToLegSym = new Map<string, string>();
    for (const u of underlyingInfos) {
      nubraSymToLegSym.set(u.symbol.toUpperCase(), u.symbol);
    }

    // Reset ATM IV live state whenever this effect re-runs
    atmIvLiveBarRef.current.clear();
    atmIvCurrentStrikeRef.current.clear();
    atmIvSubRefIds.current.clear();
    atmIvLatestIv.current.clear();

    const ws = new WebSocket('ws://localhost:8765');
    wsRef.current = ws;

    // Uses wsRef.current so it always sends on the live socket — safe to call from any effect
    const subscribeAtmGreeks = atmIvSubscribeFnRef.current = (sym: string, expiry: string, atmStrike: number) => {
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      const strikePaise = Math.round(atmStrike * 100);
      const expiryMs = expiryToMs(expiry);
      const matchSym = (i: NubraInstrument) =>
        i.asset?.toUpperCase() === sym.toUpperCase() ||
        i.nubra_name?.toUpperCase() === sym.toUpperCase() ||
        i.stock_name?.toUpperCase().startsWith(sym.toUpperCase());
      const matchExpiry = (i: NubraInstrument) =>
        expiryMs > 0 && i.expiry ? expiryToMs(String(i.expiry)) === expiryMs : String(i.expiry) === expiry;
      const ce = nubraInstruments.find(i => i.option_type === 'CE' && matchExpiry(i) && Math.abs((i.strike_price ?? 0) - strikePaise) < 2 && matchSym(i));
      const pe = nubraInstruments.find(i => i.option_type === 'PE' && matchExpiry(i) && Math.abs((i.strike_price ?? 0) - strikePaise) < 2 && matchSym(i));
      if (!ce || !pe) {
        return;
      }
      const ceId = Number(ce.ref_id);
      const peId = Number(pe.ref_id);
      const prevIds = atmIvSubRefIds.current.get(sym);
      if (prevIds?.has(ceId) && prevIds?.has(peId)) return;
      if (prevIds && prevIds.size > 0) {
        sock.send(JSON.stringify({ action: 'unsubscribe', session_token: sessionToken, data_type: 'greeks', ref_ids: [...prevIds] }));
      }
      atmIvSubRefIds.current.set(sym, new Set([ceId, peId]));
      atmIvLatestIv.current.set(sym, new Map());
      const atmMsg = { action: 'subscribe', session_token: sessionToken, data_type: 'greeks', symbols: [], ref_ids: [ceId, peId], exchange: ce.exchange || 'NSE' };
      sock.send(JSON.stringify(atmMsg));
    };

    ws.onopen = () => {
      // greeks per refId — direct per-leg LTP, no symbol ambiguity
      if (refIds.length > 0) {
        ws.send(JSON.stringify({
          action: 'subscribe', session_token: sessionToken,
          data_type: 'greeks', symbols: [], ref_ids: refIds,
          exchange: ocExchange || 'NSE',
        }));
      }
      // index subscription per exchange group — NIFTY=NSE, SENSEX=BSE separately
      for (const [exch, syms] of byExchange) {
        ws.send(JSON.stringify({
          action: 'subscribe', session_token: sessionToken,
          data_type: 'index', symbols: syms, exchange: exch,
        }));
      }

      // Seed ATM IV greeks immediately from last known spot (no need to wait for next index tick)
      if (showAtmIvRef.current && isMarketOpen()) {
        const now = Date.now();
        for (const u of underlyingInfos) {
          const spotPts = accumRef.current.underlyings.get(u.symbol);
          const lastSpot = spotPts?.length ? spotPts[spotPts.length - 1].value : 0;
          if (lastSpot <= 0) continue;
          const legsForU = legsRef.current.filter(l => l.symbol === u.symbol || legsRef.current.every(x => x.symbol === l.symbol));
          const expiry = [...new Set(legsForU.map(l => l.expiry))]
            .map(exp => ({ exp, ms: expiryToMs(exp) }))
            .filter(x => x.ms > 0)
            .sort((a, b) => Math.abs(a.ms - now) - Math.abs(b.ms - now))[0]?.exp;
          if (!expiry) continue;
          const atmStrike = calcATMStrike(lastSpot, nubraInstruments, u.symbol, expiry);
          if (atmStrike <= 0) continue;
          atmIvCurrentStrikeRef.current.set(u.symbol, atmStrike);
          subscribeAtmGreeks(u.symbol, expiry, atmStrike);
        }
      }
    };

    // Helper: upsert into accum array and call series.update()
    const upsert = (arr: LineData[], series: ISeriesApi<'Line'> | null, pt: LineData) => {
      const last = arr[arr.length - 1];
      if (last && (last.time as number) === (pt.time as number)) arr[arr.length - 1] = pt;
      else arr.push(pt);
      series?.update(pt);
    };

    // greeks tick → update LTP/delta/IV by refId match (no symbol guessing)
    const applyGreeksTick = (d: any) => {
      const ss  = seriesRef.current;
      const acc = accumRef.current;
      const nowUnix = Math.floor(Date.now() / 60000) * 60;
      const t = nowUnix as unknown as Time;
      const ltp   = d.ltp != null && d.ltp > 0 ? d.ltp / 100 : 0;
      const delta = d.delta ?? 0;
      const iv    = d.iv != null && d.iv > 0 ? d.iv * 100 : 0;

      const freshLegs = legsRef.current.filter((leg, i, arr) =>
        arr.findIndex(l => l.symbol === leg.symbol && l.strike === leg.strike && l.type === leg.type && l.expiry === leg.expiry) === i
      );

      for (const leg of freshLegs) {
        if (leg.refId !== d.ref_id) continue;
        const key = `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`;
        if (ltp > 0) {
          const optPts = acc.options.get(key) ?? [];
          upsert(optPts, ss.options.get(key) ?? null, { time: t, value: ltp });
          acc.options.set(key, optPts);
        }
        if (showDeltaRef.current && delta !== 0) {
          const dPts = acc.deltas.get(key) ?? [];
          upsert(dPts, ss.deltas.get(key) ?? null, { time: t, value: delta });
          acc.deltas.set(key, dPts);
        }
        if (showIvRef.current && iv > 0) {
          const ivPts = acc.ivs.get(key) ?? [];
          upsert(ivPts, ss.ivs.get(key) ?? null, { time: t, value: iv });
          acc.ivs.set(key, ivPts);
        }
      }

      // ATM IV: if this ref_id belongs to a subscribed ATM CE/PE, update that sym's series only
      if (showAtmIvRef.current) {
        const refId = Number(d.ref_id);
        for (const [sym, refIds] of atmIvSubRefIds.current) {
          if (!refIds.has(refId)) continue;
          const iv = d.iv != null && d.iv > 0 ? d.iv * 100 : 0;
          if (iv <= 0) break;
          const symIvMap = atmIvLatestIv.current.get(sym) ?? new Map<number, number>();
          symIvMap.set(refId, iv);
          atmIvLatestIv.current.set(sym, symIvMap);
          if (symIvMap.size >= 2) {
            const atmIv = [...symIvMap.values()].reduce((a, b) => a + b, 0) / symIvMap.size;
            const nowBarSec = snapToMinBar(Date.now()) as unknown as Time;
            const series = atmIvSeriesRef.current.get(sym);
            if (series) {
              const pt: LineData = { time: nowBarSec, value: atmIv };
              atmIvLiveBarRef.current.set(sym, pt);
              try { series.update(pt); } catch { /* lwc guard */ }
            }
          }
          break;
        }
      }

      // Recompute MTM from latest accumulated option prices
      if (ss.mtm) {
        let mtmTotal = 0; let hasAll = true;
        for (const leg of freshLegs) {
          const pts = acc.options.get(`${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`);
          const latest = pts?.length ? pts[pts.length - 1].value : 0;
          if (!latest) { hasAll = false; break; }
          mtmTotal += (leg.action === 'B' ? latest - leg.price : leg.price - latest) * leg.lots * (leg.lotSize || 1);
        }
        if (hasAll) {
          const mtmPt: BaselineData = { time: nowUnix as unknown as Time, value: mtmTotal };
          const last = acc.mtm[acc.mtm.length - 1];
          if (last && (last.time as number) === nowUnix) acc.mtm[acc.mtm.length - 1] = mtmPt;
          else acc.mtm.push(mtmPt);
          ss.mtm.update(mtmPt);
        }
        // Per-underlying live MTM update
        if (ss.mtmPerUnderlying.size > 0) {
          const uniqueSymbols = [...new Set(freshLegs.map(l => l.symbol))];
          for (const sym of uniqueSymbols) {
            const symLegs = freshLegs.filter(l => l.symbol === sym);
            let symTotal = 0; let symHasAll = true;
            for (const leg of symLegs) {
              const pts = acc.options.get(`${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`);
              const latest = pts?.length ? pts[pts.length - 1].value : 0;
              if (!latest) { symHasAll = false; break; }
              symTotal += (leg.action === 'B' ? latest - leg.price : leg.price - latest) * leg.lots * (leg.lotSize || 1);
            }
            if (symHasAll) {
              const pt: LineData = { time: nowUnix as unknown as Time, value: symTotal };
              const symPts = acc.mtmPerUnderlying.get(sym) ?? [];
              const last = symPts[symPts.length - 1];
              if (last && (last.time as number) === nowUnix) symPts[symPts.length - 1] = pt;
              else symPts.push(pt);
              acc.mtmPerUnderlying.set(sym, symPts);
              ss.mtmPerUnderlying.get(sym)?.update(pt);
            }
          }
        }
      }
    };

    // index tick → underlying spot from index_value, keyed by indexname
    const applyIndexTick = (d: any) => {
      const ss  = seriesRef.current;
      const acc = accumRef.current;
      const nowUnix = Math.floor(Date.now() / 60000) * 60;
      // index_value is raw (paise) — divide by 100
      const spot: number = d.index_value ? d.index_value / 100 : 0;
      const indexname: string = (d.indexname ?? '').toUpperCase();
      if (spot <= 0 || !indexname) return;

      // Match incoming indexname → subscribed Nubra symbol (exact or prefix)
      // e.g. Nubra sends "NIFTY 50" but we subscribed "NIFTY"
      const subscribedSyms = [...nubraSymToLegSym.keys()];
      const matched = subscribedSyms.find(s => s === indexname)
        ?? subscribedSyms.find(s => indexname.startsWith(s) || s.startsWith(indexname));
      if (!matched) return;
      const legSym = nubraSymToLegSym.get(matched)!;

      const uPts = acc.underlyings.get(legSym) ?? [];
      upsert(uPts, ss.underlyings.get(legSym) ?? null, { time: nowUnix as unknown as Time, value: spot });
      acc.underlyings.set(legSym, uPts);

      // ATM IV: track spot → subscribe CE+PE greeks for nearest ATM strike
      if (showAtmIvRef.current) {
        const now = Date.now();
        const legsForSym = legsRef.current.filter(l => l.symbol === legSym || legsRef.current.every(x => x.symbol === l.symbol));
        const expiry = [...new Set(legsForSym.map(l => l.expiry))]
          .map(exp => ({ exp, ms: expiryToMs(exp) }))
          .filter(x => x.ms > 0)
          .sort((a, b) => Math.abs(a.ms - now) - Math.abs(b.ms - now))[0]?.exp;
        if (!expiry) return;
        const newStrike = calcATMStrike(spot, nubraInstruments, legSym, expiry);
        if (newStrike <= 0) return;
        if (newStrike !== atmIvCurrentStrikeRef.current.get(legSym)) {
          atmIvCurrentStrikeRef.current.set(legSym, newStrike);
          subscribeAtmGreeks(legSym, expiry, newStrike);
        }
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (!msg.data) return;
        // Keep only the latest 50 ticks — prevents unbounded growth during scroll
        if (wsTickRef.current.length >= 50) wsTickRef.current = wsTickRef.current.slice(-25);
        wsTickRef.current.push(msg);
        if (wsFlushPendingRef.current) return;
        wsFlushPendingRef.current = true;
        wsFlushTimerRef.current = setTimeout(() => {
          wsFlushPendingRef.current = false;
          if (isInteractingRef.current) return;
          for (const m of wsTickRef.current.splice(0)) {
            if (m.type === 'greeks') applyGreeksTick(m.data);
            else if (m.type === 'index') applyIndexTick(m.data);
          }
        }, 120);
      } catch { /**/ }
    };

    ws.onerror = () => {};
    ws.onclose = () => {};

    return () => {
      ws.close();
      wsRef.current = null;
      wsTickRef.current = [];
      if (wsFlushTimerRef.current) clearTimeout(wsFlushTimerRef.current);
      wsFlushPendingRef.current = false;
      atmIvSubscribeFnRef.current = null;
    };
  }, [ocSymbol, ocExchange, uniqueLegs.map(l => `${l.symbol}:${l.strike}${l.type}${l.expiry}:${l.refId ?? ''}`).join(','), chartReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // MCX live underlying feed via Upstox wsManager
  useEffect(() => {
    if (!chartReady) return;
    const mcxUnderlyings = resolveUnderlyings().filter(u => u.source === 'MCX' && u.instrumentKey);
    if (mcxUnderlyings.length === 0) return;
    const acc = accumRef.current;
    const ss = seriesRef.current;
    const unsubs: Array<() => void> = [];
    const maybeAutoScroll = () => {
      if (mcxAutoScrollRef.current) return;
      mcxAutoScrollRef.current = true;
      scrollToLatest();
    };
    const upsert = (sym: string, pt: LineData) => {
      const arr = acc.underlyings.get(sym) ?? [];
      const last = arr[arr.length - 1];
      if (last && (last.time as number) === (pt.time as number)) arr[arr.length - 1] = pt;
      else arr.push(pt);
      acc.underlyings.set(sym, arr);
      ss.underlyings.get(sym)?.update(pt);
    };
    for (const u of mcxUnderlyings) {
      const key = u.instrumentKey!;
      wsManager.requestKeys([key]);
      const snap = wsManager.get(key);
      if (snap?.ltp) {
        const t = Math.floor(Date.now() / 60000) * 60 as unknown as Time;
        upsert(u.symbol, { time: t, value: snap.ltp });
        maybeAutoScroll();
      }
      unsubs.push(wsManager.subscribe(key, md => {
        if (!md.ltp) return;
        const t = Math.floor(Date.now() / 60000) * 60 as unknown as Time;
        upsert(u.symbol, { time: t, value: md.ltp });
        maybeAutoScroll();
      }));
    }
    return () => { unsubs.forEach(u => u()); };
  }, [resolveUnderlyings, chartReady, scrollToLatest]);

  // MCX live options feed via Upstox wsManager
  useEffect(() => {
    if (!chartReady) return;
    const mcxLegs = uniqueLegs.filter(l => (l.exchange || ocExchange || '').toUpperCase() === 'MCX');
    if (mcxLegs.length === 0) return;

    const acc = accumRef.current;
    const ss = seriesRef.current;
    const keyToLeg = new Map<string, { leg: StrategyLeg; legKey: string }>();
    for (const leg of mcxLegs) {
      const ik = resolveMcxOptionKey(leg, instruments);
      if (!ik) continue;
      keyToLeg.set(ik, { leg, legKey: `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}` });
    }
    const keys = [...keyToLeg.keys()];
    if (keys.length === 0) return;

    const upsert = (arr: LineData[], series: ISeriesApi<'Line'> | null, pt: LineData) => {
      const last = arr[arr.length - 1];
      if (last && (last.time as number) === (pt.time as number)) arr[arr.length - 1] = pt;
      else arr.push(pt);
      series?.update(pt);
    };
    const maybeAutoScroll = () => {
      if (mcxAutoScrollRef.current) return;
      mcxAutoScrollRef.current = true;
      scrollToLatest();
    };

    const updateMtm = () => {
      if (!ss.mtm) return;
      const freshLegs = legsRef.current.filter((leg, i, arr) =>
        arr.findIndex(l => l.symbol === leg.symbol && l.strike === leg.strike && l.type === leg.type && l.expiry === leg.expiry) === i
      );
      let mtmTotal = 0;
      let hasAll = true;
      for (const leg of freshLegs) {
        const pts = acc.options.get(`${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`);
        const latest = pts?.length ? pts[pts.length - 1].value : 0;
        if (!latest) { hasAll = false; break; }
        mtmTotal += (leg.action === 'B' ? latest - leg.price : leg.price - latest) * leg.lots * (leg.lotSize || 1);
      }
      if (hasAll) {
        const nowUnix = Math.floor(Date.now() / 60000) * 60;
        const mtmPt: BaselineData = { time: nowUnix as unknown as Time, value: mtmTotal };
        const last = acc.mtm[acc.mtm.length - 1];
        if (last && (last.time as number) === nowUnix) acc.mtm[acc.mtm.length - 1] = mtmPt;
        else acc.mtm.push(mtmPt);
        ss.mtm.update(mtmPt);
        // Per-underlying live MTM for MCX
        if (ss.mtmPerUnderlying.size > 0) {
          const uniqueSymbols = [...new Set(freshLegs.map(l => l.symbol))];
          for (const sym of uniqueSymbols) {
            const symLegs = freshLegs.filter(l => l.symbol === sym);
            let symTotal = 0; let symHasAll = true;
            for (const leg of symLegs) {
              const pts = acc.options.get(`${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`);
              const latest = pts?.length ? pts[pts.length - 1].value : 0;
              if (!latest) { symHasAll = false; break; }
              symTotal += (leg.action === 'B' ? latest - leg.price : leg.price - latest) * leg.lots * (leg.lotSize || 1);
            }
            if (symHasAll) {
              const nowUnix2 = Math.floor(Date.now() / 60000) * 60;
              const pt: LineData = { time: nowUnix2 as unknown as Time, value: symTotal };
              const symPts = acc.mtmPerUnderlying.get(sym) ?? [];
              const lastPt = symPts[symPts.length - 1];
              if (lastPt && (lastPt.time as number) === nowUnix2) symPts[symPts.length - 1] = pt;
              else symPts.push(pt);
              acc.mtmPerUnderlying.set(sym, symPts);
              ss.mtmPerUnderlying.get(sym)?.update(pt);
            }
          }
        }
      }
    };

    wsManager.requestKeys(keys);

    // Seed from cache
    for (const [k, info] of keyToLeg) {
      const snap = wsManager.get(k);
      if (!snap?.ltp) continue;
      const t = Math.floor(Date.now() / 60000) * 60 as unknown as Time;
      const optPts = acc.options.get(info.legKey) ?? [];
      upsert(optPts, ss.options.get(info.legKey) ?? null, { time: t, value: snap.ltp });
      acc.options.set(info.legKey, optPts);
      if (showDeltaRef.current && snap.delta != null) {
        const dPts = acc.deltas.get(info.legKey) ?? [];
        upsert(dPts, ss.deltas.get(info.legKey) ?? null, { time: t, value: snap.delta });
        acc.deltas.set(info.legKey, dPts);
      }
      if (showIvRef.current && snap.iv != null) {
        const ivPts = acc.ivs.get(info.legKey) ?? [];
        upsert(ivPts, ss.ivs.get(info.legKey) ?? null, { time: t, value: snap.iv * 100 });
        acc.ivs.set(info.legKey, ivPts);
      }
      maybeAutoScroll();
    }
    updateMtm();

    const unsubs = keys.map(k =>
      wsManager.subscribe(k, md => {
        if (!md.ltp) return;
        const info = keyToLeg.get(k);
        if (!info) return;
        const t = Math.floor(Date.now() / 60000) * 60 as unknown as Time;
        const optPts = acc.options.get(info.legKey) ?? [];
        upsert(optPts, ss.options.get(info.legKey) ?? null, { time: t, value: md.ltp });
        acc.options.set(info.legKey, optPts);
        if (showDeltaRef.current && md.delta != null) {
          const dPts = acc.deltas.get(info.legKey) ?? [];
          upsert(dPts, ss.deltas.get(info.legKey) ?? null, { time: t, value: md.delta });
          acc.deltas.set(info.legKey, dPts);
        }
        if (showIvRef.current && md.iv != null) {
          const ivPts = acc.ivs.get(info.legKey) ?? [];
          upsert(ivPts, ss.ivs.get(info.legKey) ?? null, { time: t, value: md.iv * 100 });
          acc.ivs.set(info.legKey, ivPts);
        }
        maybeAutoScroll();
        updateMtm();
      })
    );

    return () => { unsubs.forEach(u => u()); };
  }, [uniqueLegs, ocExchange, instruments, chartReady, scrollToLatest]);

  // Wire visibility toggles to series
  useEffect(() => {
    const ss = seriesRef.current;
    for (const s of ss.underlyings.values()) s.applyOptions({ visible: showSpot });
  }, [showSpot]);

  useEffect(() => {
    const ss = seriesRef.current;
    for (const s of ss.options.values()) s.applyOptions({ visible: showOptions });
  }, [showOptions]);

  useEffect(() => {
    const ss = seriesRef.current;
    if (!showMtm) {
      ss.mtm?.applyOptions({ visible: false });
      for (const s of ss.mtmPerUnderlying.values()) s.applyOptions({ visible: false });
      return;
    }
    // mtmView: 'all' = total + all per-underlying, 'total' = only total, sym = only that underlying
    ss.mtm?.applyOptions({ visible: mtmView === 'all' || mtmView === 'total' });
    for (const [sym, s] of ss.mtmPerUnderlying) {
      s.applyOptions({ visible: mtmView === 'all' || mtmView === sym });
    }
  }, [showMtm, mtmView]);

  useEffect(() => {
    const ss = seriesRef.current;
    for (const s of ss.deltas.values()) s.applyOptions({ visible: showDelta });
    if (!showDelta) return;

    if (isHistoricalMode) {
      const today = lastTradingDay();
      const startDate = (uniqueLegs.map(l => l.entryDate).filter(Boolean).sort().at(0) ?? today) as string;
      const startTimeIst = uniqueLegs.filter(l => l.entryDate === startDate).map(l => l.entryTime).filter(Boolean).sort().at(0);
      const sig = `range:${startDate}:${today}:${uniqueLegs.map(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}`).join(',')}:${ocSymbol}:${ocExchange}`;
      if (deltaRangeSigRef.current === sig) return;
      deltaRangeSigRef.current = sig;

      const acc = accumRef.current;
      const legs = legsRef.current.filter((leg, i, arr) =>
        arr.findIndex(l => l.symbol === leg.symbol && l.strike === leg.strike && l.type === leg.type && l.expiry === leg.expiry) === i
      );

      Promise.all(legs.map(async (leg) => {
        const info = resolveOption(leg);
        if (!info || info.source === 'MCX') return;
        const key = `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`;
        const { delta, iv } = await fetchOptionGreeksRange(info.symbol!, info.exchange, startDate, today, startTimeIst);
        const cut = legEntryUnix(leg);
        const dFiltered = cut ? delta.filter(pt => (pt.time as number) >= cut) : delta;
        const ivFiltered = cut ? iv.filter(pt => (pt.time as number) >= cut) : iv;
        if (dFiltered.length) acc.deltas.set(key, dFiltered);
        if (ivFiltered.length) acc.ivs.set(key, ivFiltered);
      }))
        .then(() => {
          const ss2 = seriesRef.current;
          for (const [key, data] of acc.deltas) ss2.deltas.get(key)?.setData(data);
          if (showIvRef.current) {
            for (const [key, data] of acc.ivs) ss2.ivs.get(key)?.setData(data);
          }
        })
        .catch((e: any) => console.warn('[StrategyChart] greeks range load failed', e.message));

      return;
    }

    // Lazy-load Delta for all loaded dates not yet fetched
    const acc = accumRef.current;
    const today = lastTradingDay();
    const legs = legsRef.current.filter((leg, i, arr) =>
      arr.findIndex(l => l.symbol === leg.symbol && l.strike === leg.strike && l.type === leg.type && l.expiry === leg.expiry) === i
    );
    for (const date of loadedDatesRef.current) {
      if (deltaLoadedRef.current.has(date)) continue;
      deltaLoadedRef.current.add(date);
      for (const leg of legs) {
        const info = resolveOption(leg);
        if (!info || info.source === 'MCX') continue;
        fetchOptionGreeksForDate(info.symbol!, info.exchange, date, today, undefined, isHistoricalMode)
          .then(({ delta, iv }) => {
            if (delta.length) {
              const prev = acc.deltas.get(info.key) ?? [];
              acc.deltas.set(info.key, mergeData(prev, delta));
              ss.deltas.get(info.key)?.setData(acc.deltas.get(info.key)!);
            }
            // Also seed IV accumulator so toggling IV later has data immediately
            if (iv.length) {
              const prev = acc.ivs.get(info.key) ?? [];
              acc.ivs.set(info.key, mergeData(prev, iv));
              if (showIvRef.current) ss.ivs.get(info.key)?.setData(acc.ivs.get(info.key)!);
            }
          })
          .catch((e: any) => console.warn('[StrategyChart] delta lazy load failed', e.message));
      }
    }
  }, [showDelta, legsKey, ocSymbol, ocExchange, isHistoricalMode, 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ss = seriesRef.current;
    for (const s of ss.ivs.values()) s.applyOptions({ visible: showIv });
    if (!showIv) return;

    if (isHistoricalMode) {
      const today = lastTradingDay();
      const startDate = (uniqueLegs.map(l => l.entryDate).filter(Boolean).sort().at(0) ?? today) as string;
      const startTimeIst = uniqueLegs.filter(l => l.entryDate === startDate).map(l => l.entryTime).filter(Boolean).sort().at(0);

      // If Delta already fetched this range, IV data is already in acc.ivs — just apply it
      const sig = `range:${startDate}:${today}:${uniqueLegs.map(l => `${l.symbol}:${l.strike}${l.type}:${l.expiry}`).join(',')}:${ocSymbol}:${ocExchange}`;
      if (deltaRangeSigRef.current === sig) {
        const acc2 = accumRef.current;
        const ss2 = seriesRef.current;
        for (const [key, data] of acc2.ivs) ss2.ivs.get(key)?.setData(data);
        return;
      }

      if (ivRangeSigRef.current === sig) return;
      ivRangeSigRef.current = sig;

      const acc = accumRef.current;
      const legs = legsRef.current.filter((leg, i, arr) =>
        arr.findIndex(l => l.symbol === leg.symbol && l.strike === leg.strike && l.type === leg.type && l.expiry === leg.expiry) === i
      );

      Promise.all(legs.map(async (leg) => {
        const info = resolveOption(leg);
        if (!info || info.source === 'MCX') return;
        const key = `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`;
        const { delta, iv } = await fetchOptionGreeksRange(info.symbol!, info.exchange, startDate, today, startTimeIst);
        const cut = legEntryUnix(leg);
        const dFiltered = cut ? delta.filter(pt => (pt.time as number) >= cut) : delta;
        const ivFiltered = cut ? iv.filter(pt => (pt.time as number) >= cut) : iv;
        if (dFiltered.length) acc.deltas.set(key, dFiltered);
        if (ivFiltered.length) acc.ivs.set(key, ivFiltered);
      }))
        .then(() => {
          const ss2 = seriesRef.current;
          if (showDeltaRef.current) {
            for (const [key, data] of acc.deltas) ss2.deltas.get(key)?.setData(data);
          }
          for (const [key, data] of acc.ivs) ss2.ivs.get(key)?.setData(data);
        })
        .catch((e: any) => console.warn('[StrategyChart] greeks range load failed', e.message));

      return;
    }

    // Lazy-load IV for all loaded dates not yet fetched
    const acc = accumRef.current;
    const today = lastTradingDay();
    const legs = legsRef.current.filter((leg, i, arr) =>
      arr.findIndex(l => l.symbol === leg.symbol && l.strike === leg.strike && l.type === leg.type && l.expiry === leg.expiry) === i
    );
    for (const date of loadedDatesRef.current) {
      // If Delta already loaded this date, IV data is already in acc.ivs — just apply it
      if (deltaLoadedRef.current.has(date)) {
        for (const leg of legs) {
          const key = `${leg.symbol}:${leg.strike}${leg.type}:${leg.expiry}`;
          const data = acc.ivs.get(key);
          if (data?.length) ss.ivs.get(key)?.setData(data);
        }
        continue;
      }
      if (ivLoadedRef.current.has(date)) continue;
      ivLoadedRef.current.add(date);
      for (const leg of legs) {
        const info = resolveOption(leg);
        if (!info || info.source === 'MCX') continue;
        fetchOptionGreeksForDate(info.symbol!, info.exchange, date, today, undefined, isHistoricalMode)
          .then(({ delta, iv }) => {
            // Seed delta accumulator too in case Delta gets toggled later
            if (delta.length) {
              const prev = acc.deltas.get(info.key) ?? [];
              acc.deltas.set(info.key, mergeData(prev, delta));
              if (showDeltaRef.current) ss.deltas.get(info.key)?.setData(acc.deltas.get(info.key)!);
            }
            if (iv.length) {
              const prev = acc.ivs.get(info.key) ?? [];
              acc.ivs.set(info.key, mergeData(prev, iv));
              ss.ivs.get(info.key)?.setData(acc.ivs.get(info.key)!);
            }
          })
          .catch((e: any) => console.warn('[StrategyChart] iv lazy load failed', e.message));
      }
    }
  }, [showIv, legsKey, ocSymbol, ocExchange, isHistoricalMode, 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ATM IV chart (timeseries) — one series per underlying ────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartReady) return;

    const seriesMap = atmIvSeriesRef.current;

    if (!showAtmIv) {
      for (const s of seriesMap.values()) { try { chart.removeSeries(s); } catch { /**/ } }
      seriesMap.clear();
      return;
    }

    const underlyingInfos = resolveUnderlyings().filter(u => u.source !== 'MCX');
    if (underlyingInfos.length === 0) return;

    const today = lastTradingDay();
    const startDate = (uniqueLegs.map(l => l.entryDate).filter(Boolean).sort().at(0) ?? today) as string;
    const now = Date.now();
    const ATM_IV_COLORS = [ATM_IV_COLOR, '#06b6d4', '#84cc16'];

    // Remove series for underlyings no longer present
    for (const sym of seriesMap.keys()) {
      if (!underlyingInfos.find(u => u.symbol === sym)) {
        try { chart.removeSeries(seriesMap.get(sym)!); } catch { /**/ }
        seriesMap.delete(sym);
      }
    }

    for (const [idx, u] of underlyingInfos.entries()) {
      // Nearest expiry for legs of this underlying
      const legsForUnderlying = uniqueLegs.filter(l => l.symbol === u.symbol || uniqueLegs.every(x => x.symbol === l.symbol));
      const sortedExpiries = [...new Set(legsForUnderlying.map(l => l.expiry))]
        .map(e => ({ expiry: e, ms: expiryToMs(e) }))
        .filter(x => x.ms > 0)
        .sort((a, b) => Math.abs(a.ms - now) - Math.abs(b.ms - now));
      if (sortedExpiries.length === 0) continue;
      const { expiry: nearestExpiry, ms: expiryMs } = sortedExpiries[0];

      // Create series if not yet exists for this underlying
      if (!seriesMap.has(u.symbol)) {
        const color = ATM_IV_COLORS[idx % ATM_IV_COLORS.length];
        const s = chart.addSeries(LineSeries, {
          color,
          lineWidth: 2,
          priceScaleId: `atm-iv-${u.symbol}`,
          title: `ATM IV ${u.symbol}`,
        }, 2);
        s.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
        seriesMap.set(u.symbol, s);
      }

      fetchAtmIvChart(u.symbol, u.exchange, expiryMs, startDate)
        .then(pts => {
          const s = seriesMap.get(u.symbol);
          if (pts.length && s) s.setData(sortDedup(pts));
        })
        .catch(e => console.warn(`[StrategyChart] ATM IV fetch failed (${u.symbol})`, e.message));

      // If WS already open (e.g. ATM IV toggled on after connect), seed immediately
      if (isMarketOpen() && wsRef.current?.readyState === WebSocket.OPEN) {
        const spotPts = accumRef.current.underlyings.get(u.symbol);
        const lastSpot = spotPts?.length ? spotPts[spotPts.length - 1].value : 0;
        if (lastSpot > 0) {
          const atmStrike = calcATMStrike(lastSpot, nubraInstruments, u.symbol, nearestExpiry);
          if (atmStrike > 0) {
            atmIvCurrentStrikeRef.current.set(u.symbol, atmStrike);
            atmIvSubscribeFnRef.current?.(u.symbol, nearestExpiry, atmStrike);
          }
        }
      }
    }

    return () => {
      for (const s of seriesMap.values()) { try { chart.removeSeries(s); } catch { /**/ } }
      seriesMap.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAtmIv, chartReady, uniqueLegs.map(l => `${l.symbol}:${l.expiry}`).join(','), ocSymbol, ocExchange]);

  // ── DOM orderbook WS for positions overlay ───────────────────────────────────
  useEffect(() => {
    if (domLegIdx === null) {
      domWsRef.current?.close();
      domWsRef.current = null;
      setDomBook(null);
      return;
    }
    const leg = legs[domLegIdx];
    if (!leg?.refId) { setDomBook(null); return; }
    const sessionToken = localStorage.getItem('nubra_session_token');
    if (!sessionToken) return;

    domWsRef.current?.close();
    setDomBook(null);
    const ws = new WebSocket('ws://localhost:8765');
    domWsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'subscribe', session_token: sessionToken, data_type: 'orderbook', ref_ids: [leg.refId] }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'orderbook' && msg.data?.ref_id === leg.refId) {
          const d = msg.data;
          setDomBook({
            ltp:  (d.last_traded_price ?? 0) / 100,
            bids: (d.bids ?? []).slice(0, 5).map((b: any) => ({ price: b.price / 100, qty: b.quantity })),
            asks: (d.asks ?? []).slice(0, 5).map((a: any) => ({ price: a.price / 100, qty: a.quantity })),
          });
        }
      } catch { /**/ }
    };
    ws.onerror = () => {};
    ws.onclose = () => {};
    return () => { ws.close(); domWsRef.current = null; };
  }, [domLegIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasContent = (!!ocSymbol || uniqueLegs.length > 0) && uniqueLegs.length > 0;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#171717', overflow: 'hidden', position: 'relative' }}>

      {!hasContent && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#3D4150', pointerEvents: 'none' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span style={{ fontSize: 12 }}>Add legs to see strategy chart</span>
        </div>
      )}

      {hasContent && (
        <div style={{ flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          {/* ── Row 1: title + meta + status + refresh ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'var(--font-family-sans)' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 8,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
              fontSize: 13, fontWeight: 600, color: '#CBD5E1', letterSpacing: '0.01em',
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 17l5-6 4 4 6-8 3 3" />
                <path d="M3 21h18" />
              </svg>
              Mtm Analyzer
            </span>
            <span style={{ fontSize: 10, color: '#3D4150' }}>·</span>
            {[...new Set(uniqueLegs.map(l => l.symbol))].map((sym, idx) => (
              <span key={sym} style={{ fontSize: 11, color: UNDERLYING_COLORS[idx % UNDERLYING_COLORS.length], fontWeight: 600 }}>{sym}</span>
            ))}
            <span style={{ fontSize: 10, color: '#565A6B' }}>{[...new Set(uniqueLegs.map(l => l.symbol))].length} underlying{[...new Set(uniqueLegs.map(l => l.symbol))].length !== 1 ? 's' : ''}</span>
            <span style={{ fontSize: 10, color: '#565A6B' }}>·</span>
            <span style={{ fontSize: 10, color: '#565A6B' }}>{uniqueLegs.length} leg{uniqueLegs.length !== 1 ? 's' : ''}</span>
            {fromDate && toDate && (
              <span style={{ fontSize: 10, color: '#565A6B', fontFamily: 'monospace' }}>
                {fromDate === toDate ? formatDate(fromDate) : `${formatDate(fromDate)} – ${formatDate(toDate)}`}
              </span>
            )}
            <div style={{ flex: 1 }} />
            {loadingMore && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 6, height: 6, border: '1.5px solid rgba(255,255,255,0.15)', borderTopColor: '#60a5fa', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                <span style={{ fontSize: 10, color: '#565A6B' }}>Loading older data</span>
              </span>
            )}
            {loading && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, border: '1.5px solid rgba(255,255,255,0.15)', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                <span style={{ fontSize: 10, color: '#565A6B' }}>Loading</span>
              </span>
            )}
            {error && <span style={{ fontSize: 10, color: '#f23645' }} title={error}>{error.slice(0, 60)}</span>}
            <button
              onClick={fetchAll} disabled={loading}
              style={{ fontSize: 10, fontWeight: 800, color: '#60a5fa', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 999, padding: '4px 12px', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1 }}
            >Refresh</button>
          </div>

          {/* ── Row 2: toggle toolbar ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: 'rgba(255,255,255,0.015)', fontFamily: 'var(--font-family-sans)' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#525866', letterSpacing: '0.08em', marginRight: 2 }}>SHOW</span>
            {([
              { key: 'spot',    label: 'Spot',    color: UNDERLYING_COLOR,  on: showSpot,    set: setShowSpot },
              { key: 'options', label: 'Options', color: '#2ebd85',         on: showOptions, set: setShowOptions },
              { key: 'delta',   label: 'Delta',   color: DELTA_COLORS[0],  on: showDelta,   set: setShowDelta },
              { key: 'iv',      label: 'IV',      color: IV_COLORS[0],     on: showIv,      set: setShowIv },
              { key: 'atm-iv',  label: 'ATM IV',  color: ATM_IV_COLOR,     on: showAtmIv,   set: setShowAtmIv },
            ] as const).map(({ key, label, on, set }) => (
              <button
                key={key}
                onClick={() => set((v: boolean) => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
                  fontSize: 12, lineHeight: 1.1, fontWeight: 600, letterSpacing: '0.03em',
                  border: `1px solid ${on ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.08)'}`,
                  background: on ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: on ? '#E2E8F0' : '#9CA3AF',
                  transition: 'all 0.15s',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, background: on ? '#E2E8F0' : 'rgba(255,255,255,0.15)', display: 'inline-block', flexShrink: 0 }} />
                {label}
              </button>
            ))}
            {/* MTM dropdown */}
            {(() => {
              const uniqueSyms = [...new Set(uniqueLegs.map(l => l.symbol))];
              const mtmOptions: { value: string; label: string }[] = [
                { value: 'off',   label: 'Off' },
                { value: 'all',   label: 'All' },
                { value: 'total', label: 'Total' },
                ...uniqueSyms.map(sym => ({ value: sym, label: sym })),
              ];
              const currentLabel = !showMtm ? 'Off' : (mtmOptions.find(o => o.value === mtmView)?.label ?? mtmView);
              return (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <select
                    value={!showMtm ? 'off' : mtmView}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === 'off') { setShowMtm(false); }
                      else { setShowMtm(true); setMtmView(v); }
                    }}
                    style={{
                      appearance: 'none',
                      display: 'flex', alignItems: 'center',
                      padding: '7px 28px 7px 10px', borderRadius: 999, cursor: 'pointer',
                      fontSize: 12, lineHeight: 1.1, fontWeight: 600, letterSpacing: '0.03em',
                      border: `1px solid ${showMtm ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'}`,
                      background: showMtm
                        ? 'linear-gradient(135deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%)'
                        : 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)',
                      backdropFilter: 'blur(12px)',
                      WebkitBackdropFilter: 'blur(12px)',
                      boxShadow: showMtm
                        ? 'inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.25)'
                        : 'inset 0 1px 0 rgba(255,255,255,0.05)',
                      color: 'transparent',
                      outline: 'none',
                      minWidth: showMtm ? 90 : 70,
                    }}
                  >
                    {mtmOptions.map(opt => (
                      <option key={opt.value} value={opt.value} style={{ background: '#1a1a2e', color: '#E2E8F0' }}>{opt.label}</option>
                    ))}
                  </select>
                  {/* visible label overlay */}
                  <span style={{
                    position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                    fontSize: 12, fontWeight: 600, color: showMtm ? '#E2E8F0' : '#9CA3AF',
                    pointerEvents: 'none', letterSpacing: '0.03em', whiteSpace: 'nowrap',
                  }}>
                    <span style={{ color: showMtm ? '#26a69a' : '#525866', fontWeight: 700 }}>MTM</span>
                    {showMtm ? <span style={{ color: '#525866' }}> · </span> : null}
                    {showMtm ? currentLabel : null}
                  </span>
                  {/* chevron */}
                  <svg style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 3.5L5 6.5L8 3.5" stroke={showMtm ? '#E2E8F0' : '#525866'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              );
            })()}
            <div style={{ flex: 1 }} />
            {/* Positions button — always visible when legs exist */}
            <button
              onClick={() => setShowPositions(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
                fontSize: 12, lineHeight: 1.1, fontWeight: 600, letterSpacing: '0.03em',
                border: `1px solid ${showPositions ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.08)'}`,
                background: showPositions ? 'rgba(255,255,255,0.08)' : 'transparent',
                color: showPositions ? '#E2E8F0' : '#9CA3AF',
                transition: 'all 0.15s',
              }}
            >
              {/* Arrow-up from line — matches the chart entry marker */}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5"/><path d="M5 12l7-7 7 7"/><line x1="4" y1="20" x2="20" y2="20"/>
              </svg>
              Positions
              <span style={{
                fontSize: 10, fontWeight: 800,
                background: showPositions ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)',
                color: showPositions ? '#E2E8F0' : '#9CA3AF',
                borderRadius: 4, padding: '0 5px', marginLeft: 2,
              }}>{legs.length}</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Resizable split: chart top / MTM panel bottom ── */}
      <div ref={splitWrapRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Chart area */}
        <div ref={containerRef} style={{ height: `${chartHeightPct}%`, minHeight: 0, flexShrink: 0 }} />

        {/* Drag handle — matches App.tsx divider pattern */}
        <div
          onMouseDown={onSplitMouseDown}
          onDoubleClick={() => setChartHeightPct(70)}
          style={{
            flexShrink: 0, height: 4, cursor: 'row-resize',
            background: 'transparent',
            borderTop: '1px solid rgba(255,255,255,0.07)',
            transition: 'background 0.15s',
            zIndex: 10,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
        />

        {/* MTM panel */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#111110', overflow: 'hidden' }}>

          {/* ── Header bar: total P&L ── */}
          {(() => {
            const total = uniqueLegs.reduce((sum, leg) => {
              const ltp = (leg.currLtp ?? 0) > 0 ? leg.currLtp! : leg.price;
              return sum + (leg.action === 'B' ? ltp - leg.price : leg.price - ltp) * leg.lots * (leg.lotSize || 1);
            }, 0);
            const isPos = total >= 0;
            return (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '7px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.07)',
                flexShrink: 0, background: '#151413',
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', letterSpacing: '0.1em', textTransform: 'uppercase' }}>MTM P&amp;L</span>
                <span style={{ fontSize: 22, fontWeight: 700, color: isPos ? '#26a69a' : '#f23645', fontFamily: 'monospace', letterSpacing: '-0.01em' }}>
                  {isPos ? '+' : '−'}₹{Math.abs(total).toFixed(2)}
                </span>
                <span style={{ fontSize: 12, color: '#4B5563', marginLeft: -4 }}>{uniqueLegs.length} leg{uniqueLegs.length !== 1 ? 's' : ''}</span>
              </div>
            );
          })()}

          {/* ── Column headers ── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '46px minmax(0,1fr) 88px 88px 100px',
            padding: '5px 16px',
            background: '#181715',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}>
            {['', 'Instrument', 'Entry', 'LTP', 'P&L'].map((h, i) => (
              <span key={i} style={{
                fontSize: 11, fontWeight: 700, color: '#6B7280',
                letterSpacing: '0.07em', textTransform: 'uppercase',
                textAlign: i >= 2 ? 'right' : 'left',
              }}>{h}</span>
            ))}
          </div>

          {/* ── Rows ── */}
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {uniqueLegs.map((leg, i) => {
              const ltp   = (leg.currLtp ?? 0) > 0 ? leg.currLtp! : leg.price;
              const pnl   = (leg.action === 'B' ? ltp - leg.price : leg.price - ltp) * leg.lots * (leg.lotSize || 1);
              const isPos = pnl >= 0;
              const isBuy = leg.action === 'B';
              return (
                <div key={i} style={{
                  display: 'grid',
                  gridTemplateColumns: '46px minmax(0,1fr) 88px 88px 100px',
                  alignItems: 'center',
                  padding: '8px 16px',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                }}>

                  {/* B/S badge */}
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 38, height: 20, borderRadius: 4, flexShrink: 0,
                    fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
                    color: isBuy ? '#26a69a' : '#f23645',
                    background: isBuy ? 'rgba(38,166,154,0.15)' : 'rgba(242,54,69,0.15)',
                    border: `1px solid ${isBuy ? 'rgba(38,166,154,0.35)' : 'rgba(242,54,69,0.35)'}`,
                  }}>{isBuy ? 'BUY' : 'SELL'}</span>

                  {/* Instrument */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {leg.symbol} {leg.strike}
                    </span>
                    <span style={{
                      fontSize: 12, fontWeight: 700,
                      color: leg.type === 'CE' ? '#34d399' : '#f87171',
                      flexShrink: 0,
                    }}>{leg.type}</span>
                    <span style={{ fontSize: 12, color: '#6B7280', flexShrink: 0 }}>×{leg.lots}</span>
                  </div>

                  {/* Entry */}
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#9CA3AF', textAlign: 'right', fontFamily: 'monospace' }}>
                    ₹{leg.price.toFixed(2)}
                  </span>

                  {/* LTP */}
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#F3F4F6', textAlign: 'right', fontFamily: 'monospace' }}>
                    ₹{ltp.toFixed(2)}
                  </span>

                  {/* P&L */}
                  <span style={{
                    fontSize: 14, fontWeight: 700, textAlign: 'right', fontFamily: 'monospace',
                    color: isPos ? '#26a69a' : '#f23645',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {isPos ? '+' : '−'}₹{Math.abs(pnl).toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Positions overlay ─────────────────────────────────────────── */}
      {showPositions && legs.length > 0 && (
        <div style={{
          position: 'absolute', top: 80, right: 12, zIndex: 20,
          background: '#1a1714',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          minWidth: 360,
          maxWidth: 480,
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px 8px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Positions tab icon — arrow up from line (entry marker icon) */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e0a800" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5"/>
                <path d="M5 12l7-7 7 7"/>
                <line x1="4" y1="20" x2="20" y2="20"/>
              </svg>
              <span style={{ fontSize: 13, fontWeight: 400, color: '#D1D4DC', letterSpacing: '0.06em', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>POSITIONS</span>
              <span style={{ fontSize: 13, fontWeight: 400, color: '#565A6B', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>{legs.length} leg{legs.length !== 1 ? 's' : ''}</span>
            </div>
            <button
              onClick={() => { setShowPositions(false); setDomLegIdx(null); }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#374151', padding: 2, display: 'flex', alignItems: 'center' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#f23645'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#374151'; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {/* Column headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: '44px 1fr 52px 64px 64px 24px',
            padding: '5px 14px 4px',
            background: '#333333',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            {['B/S', 'Instrument', 'Lots', 'Entry', 'Time', ''].map((h, i) => (
              <span key={i} style={{ fontSize: 13, fontWeight: 400, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: i >= 2 ? 'right' : 'left', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>{h}</span>
            ))}
          </div>

          {/* Rows */}
          <div style={{ maxHeight: 280, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
            {legs.map((leg, i) => {
              const isBuy = leg.action === 'B';
              const legColor = leg.type === 'CE'
                ? CE_COLORS[legs.filter((l, j) => j < i && l.type === 'CE').length % CE_COLORS.length]
                : PE_COLORS[legs.filter((l, j) => j < i && l.type === 'PE').length % PE_COLORS.length];
              const domOpen = domLegIdx === i;
              return (
                <div key={i} style={{ borderBottom: i < legs.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  {/* Main row */}
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: '44px 1fr 52px 64px 64px 24px',
                      alignItems: 'center', padding: '7px 14px',
                      transition: 'background 0.1s',
                      background: domOpen ? 'rgba(255,255,255,0.04)' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!domOpen) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'; }}
                    onMouseLeave={e => { if (!domOpen) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                  >
                    {/* B/S badge */}
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 18, borderRadius: 4,
                      background: isBuy ? 'rgba(38,166,154,0.18)' : 'rgba(242,54,69,0.18)',
                      border: `1px solid ${isBuy ? 'rgba(38,166,154,0.45)' : 'rgba(242,54,69,0.45)'}`,
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 400, color: isBuy ? '#26a69a' : '#f23645', letterSpacing: '0.05em', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>
                        {isBuy ? 'BUY' : 'SELL'}
                      </span>
                    </div>

                    {/* Instrument */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: legColor, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 400, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>
                        {leg.strike} <span style={{ color: leg.type === 'CE' ? '#26a69a' : '#f23645' }}>{leg.type}</span>
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 400, color: '#4B5563', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>
                        {leg.expiry ? `${leg.expiry.slice(6, 8)}/${leg.expiry.slice(4, 6)}` : ''}
                      </span>
                    </div>

                    {/* Lots */}
                    <span style={{ fontSize: 13, fontWeight: 400, color: '#9CA3AF', textAlign: 'right', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>
                      ×{leg.lots}
                    </span>

                    {/* Entry price */}
                    <span style={{ fontSize: 13, fontWeight: 400, color: '#E2E8F0', textAlign: 'right', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>
                      ₹{leg.price.toFixed(2)}
                    </span>

                    {/* Entry time */}
                    <span style={{ fontSize: 13, fontWeight: 400, color: leg.entryTime ? '#e0a800' : '#374151', textAlign: 'right', fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }}>
                      {leg.entryTime ? leg.entryTime.slice(0, 5) : '—'}
                    </span>

                    {/* ⋮ DOM toggle */}
                    <button
                      onClick={() => { setDomLegIdx(domOpen ? null : i); setDomBook(null); }}
                      title="Order book"
                      style={{
                        background: 'transparent', border: 'none', cursor: leg.refId ? 'pointer' : 'default',
                        color: domOpen ? '#60a5fa' : '#4B5563',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 20, height: 20, borderRadius: 3, padding: 0,
                        opacity: leg.refId ? 1 : 0.3,
                      }}
                      onMouseEnter={e => { if (leg.refId) (e.currentTarget as HTMLButtonElement).style.color = '#60a5fa'; }}
                      onMouseLeave={e => { if (!domOpen) (e.currentTarget as HTMLButtonElement).style.color = '#4B5563'; }}
                    >
                      <svg width="12" height="12" viewBox="0 0 4 16" fill="currentColor">
                        <circle cx="2" cy="2"  r="1.5"/>
                        <circle cx="2" cy="8"  r="1.5"/>
                        <circle cx="2" cy="14" r="1.5"/>
                      </svg>
                    </button>
                  </div>

                  {/* Inline bid/ask DOM */}
                  {domOpen && (
                    <div style={{
                      margin: '0 14px 8px',
                      background: 'rgba(0,0,0,0.35)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 6,
                      overflow: 'hidden',
                      fontSize: 11,
                    }}>
                      {/* DOM header */}
                      <div style={{
                        display: 'grid', gridTemplateColumns: '1fr 60px 1px 60px 1fr',
                        padding: '4px 10px',
                        background: '#2a2a2a',
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                      }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#f23645', letterSpacing: '0.07em' }}>QTY</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#f23645', letterSpacing: '0.07em', textAlign: 'right' }}>ASK</span>
                        <span />
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#26a69a', letterSpacing: '0.07em' }}>BID</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#26a69a', letterSpacing: '0.07em', textAlign: 'right' }}>QTY</span>
                      </div>
                      {/* LTP row */}
                      {domBook && (
                        <div style={{ textAlign: 'center', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: 11, fontWeight: 700, color: '#E2E8F0', fontFamily: 'monospace' }}>
                          LTP ₹{domBook.ltp.toFixed(2)}
                        </div>
                      )}
                      {/* Rows */}
                      {!domBook ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 0', color: '#565A6B', fontSize: 10 }}>
                          <span style={{ width: 6, height: 6, border: '1.5px solid rgba(255,255,255,0.15)', borderTopColor: '#60a5fa', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                          Connecting…
                        </div>
                      ) : (
                        <div style={{ padding: '3px 10px 6px' }}>
                          {Array(5).fill(null).map((_, ri) => {
                            const ask = domBook.asks[ri] ?? null;
                            const bid = domBook.bids[ri] ?? null;
                            const maxQty = Math.max(...domBook.bids.map(b => b.qty), ...domBook.asks.map(a => a.qty), 1);
                            const askBar = ask ? (ask.qty / maxQty) * 100 : 0;
                            const bidBar = bid ? (bid.qty / maxQty) * 100 : 0;
                            return (
                              <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1px 60px 1fr', alignItems: 'center', padding: '2px 0', borderBottom: ri < 4 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
                                {/* Ask qty bar */}
                                <div style={{ position: 'relative', height: 16, display: 'flex', alignItems: 'center' }}>
                                  <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${askBar}%`, background: 'rgba(242,54,69,0.12)', borderRadius: '2px 0 0 2px' }} />
                                  <span style={{ fontSize: 10, color: '#9CA3AF', position: 'relative', zIndex: 1 }}>{ask ? ask.qty.toLocaleString('en-IN') : '—'}</span>
                                </div>
                                <span style={{ fontSize: 11, fontWeight: 700, color: '#f23645', textAlign: 'right', fontFamily: 'monospace' }}>{ask ? ask.price.toFixed(2) : '—'}</span>
                                <div style={{ width: 1, background: 'rgba(255,255,255,0.08)', alignSelf: 'stretch', margin: '0 3px' }} />
                                <span style={{ fontSize: 11, fontWeight: 700, color: '#26a69a', fontFamily: 'monospace' }}>{bid ? bid.price.toFixed(2) : '—'}</span>
                                {/* Bid qty bar */}
                                <div style={{ position: 'relative', height: 16, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${bidBar}%`, background: 'rgba(38,166,154,0.12)', borderRadius: '0 2px 2px 0' }} />
                                  <span style={{ fontSize: 10, color: '#9CA3AF', position: 'relative', zIndex: 1 }}>{bid ? bid.qty.toLocaleString('en-IN') : '—'}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}





