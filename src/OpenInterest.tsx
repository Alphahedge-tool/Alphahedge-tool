'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { NubraInstrument } from './useNubraInstruments';
import s from './OpenInterest.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  nubraInstruments: NubraInstrument[];
  initialSymbol?: string;
}

type OptionType = 'CE' | 'PE' | 'BOTH';
type TimeRange  = '10m' | '15m' | '30m' | '1h' | '2h' | '4h' | 'sod' | 'custom';

// Market session: 9:15 → 15:30 IST = 375 minutes total
const MARKET_START_MIN = 9 * 60 + 15;   // 555
const MARKET_END_MIN   = 15 * 60 + 30;  // 930
const MARKET_DURATION  = MARKET_END_MIN - MARKET_START_MIN; // 375

function minToLabel(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hh}:${String(mm).padStart(2, '0')} ${ampm}`;
}

// Returns [fromMin, toMin] for a preset (minutes since midnight IST)
// Uses MARKET_END_MIN if market is not currently open (before open or weekend)
function presetToRange(preset: TimeRange): [number, number] {
  const istMs  = Date.now() + 5.5 * 3600 * 1000;
  const istNow = new Date(istMs);
  const istMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const dow    = istNow.getUTCDay();
  const marketOpen = dow >= 1 && dow <= 5 && istMin >= MARKET_START_MIN && istMin <= MARKET_END_MIN;
  // If market is open, use current time; otherwise use last close (15:30)
  const nowMin = marketOpen ? istMin : MARKET_END_MIN;
  if (preset === 'sod') return [MARKET_START_MIN, nowMin];
  const mins = preset === '10m' ? 10 : preset === '15m' ? 15 : preset === '30m' ? 30
             : preset === '1h' ? 60 : preset === '2h' ? 120 : preset === '4h' ? 240 : 0;
  const to   = nowMin;
  const from = Math.max(to - mins, MARKET_START_MIN);
  return [from, to];
}

const RANGE_OPTIONS: { label: string; value: TimeRange }[] = [
  { label: 'Last 10 min',  value: '10m' },
  { label: 'Last 15 min',  value: '15m' },
  { label: 'Last 30 min',  value: '30m' },
  { label: 'Last 1 hr',    value: '1h'  },
  { label: 'Last 2 hr',    value: '2h'  },
  { label: 'Last 4 hr',    value: '4h'  },
  { label: 'Start of day', value: 'sod' },
];

interface RefDataItem {
  StrikePrice: number;     // in paise (divide by 100)
  OptionType: 'CE' | 'PE';
  StockName: string;
  Expiry: number;
  LotSize: number;
}

interface OIBar {
  strike: number;          // actual price (StrikePrice / 100)
  ce: number;
  pe: number;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function nubraHeaders() {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie    = localStorage.getItem('nubra_raw_cookie') ?? '';
  return {
    'x-session-token': sessionToken,
    'x-device-id':     deviceId,
    'x-raw-cookie':    rawCookie,
  };
}

// ── Nubra search helpers (mirrors IvChart resolveNubra) ───────────────────────

function resolveNubra(
  sym: string,
  nubraInstruments: NubraInstrument[],
): { nubraSym: string; exchange: string; nubraType: 'INDEX' | 'STOCK' } {
  const upper = sym.toUpperCase();
  // Exact match first (asset/nubra_name/stock_name), options only
  const found = nubraInstruments.find(i =>
    (i.option_type === 'CE' || i.option_type === 'PE') &&
    (i.asset?.toUpperCase() === upper ||
     i.nubra_name?.toUpperCase() === upper ||
     i.stock_name?.toUpperCase() === upper)
  );
  if (found?.asset) {
    const isIndex = (found.asset_type ?? '').includes('INDEX');
    return { nubraSym: found.asset, exchange: found.exchange ?? 'NSE', nubraType: isIndex ? 'INDEX' : 'STOCK' };
  }
  // Fallback: exact match across all rows
  const fallback = nubraInstruments.find(i =>
    i.asset?.toUpperCase() === upper ||
    i.nubra_name?.toUpperCase() === upper ||
    i.stock_name?.toUpperCase().startsWith(upper)
  );
  const isIndex = (fallback?.asset_type ?? '').includes('INDEX');
  return {
    nubraSym: fallback?.asset ?? sym,
    exchange:  fallback?.exchange ?? 'NSE',
    nubraType: isIndex ? 'INDEX' : 'STOCK',
  };
}

// ── Search suggestions ────────────────────────────────────────────────────────

interface Suggestion {
  sym: string;
  exchange: string;
  asset_type: string;
}

function buildSuggestions(query: string, nubraInstruments: NubraInstrument[]): Suggestion[] {
  if (!query) return [];
  const q = query.toUpperCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const i of nubraInstruments) {
    if (i.option_type !== 'CE' && i.option_type !== 'PE') continue;
    const sym = i.asset ?? i.nubra_name ?? '';
    if (!sym) continue;
    const key = `${sym}|${i.exchange}`;
    if (seen.has(key)) continue;
    if (sym.toUpperCase().includes(q) || i.stock_name?.toUpperCase().includes(q)) {
      seen.add(key);
      out.push({ sym, exchange: i.exchange ?? 'NSE', asset_type: i.asset_type ?? '' });
      if (out.length >= 20) break;
    }
  }
  return out;
}

// ── ECharts loader (dynamic import so it doesn't bloat unless used) ───────────

async function getECharts() {
  const echarts = await import('echarts');
  return echarts;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function OpenInterest({ nubraInstruments, initialSymbol }: Props) {
  // Close range dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rangeDDRef.current && !rangeDDRef.current.contains(e.target as Node)) {
        setShowRangeDrop(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Search state
  const [query,        setQuery]        = useState('');
  const [showDrop,     setShowDrop]     = useState(false);
  const [activeIdx,    setActiveIdx]    = useState(-1);
  const suggestions = useMemo(() => buildSuggestions(query, nubraInstruments), [query, nubraInstruments]);

  // Selected symbol state
  const [symbol,    setSymbol]    = useState('');
  const [exchange,  setExchange]  = useState('NSE');
  const [nubraType, setNubraType] = useState<'INDEX' | 'STOCK'>('INDEX');

  // Expiry state
  const [expiries,    setExpiries]    = useState<string[]>([]);
  const [expiry,      setExpiry]      = useState('');

  // View
  const [optType,       setOptType]      = useState<OptionType>('BOTH');
  const [showOIChange,  setShowOIChange] = useState(false);  // false = plain OI, true = OI change
  const [timeRange,     setTimeRange]    = useState<TimeRange>('sod');
  const [showRangeDrop, setShowRangeDrop] = useState(false);
  const rangeDDRef = useRef<HTMLDivElement>(null);
  // Slider state: minutes since midnight IST (9:15=555 … 15:30=930)
  const [sliderFrom, setSliderFrom] = useState(MARKET_START_MIN);
  const [sliderTo,   setSliderTo]   = useState(MARKET_END_MIN);
  const sliderTrackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'from' | 'to' | null>(null);

  // Chart data
  const [bars,      setBars]      = useState<OIBar[]>([]);
  const [totalCe,   setTotalCe]   = useState(0);
  const [totalPe,   setTotalPe]   = useState(0);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  const chartRef  = useRef<HTMLDivElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  const chartInst = useRef<any>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  // ── Slider drag handlers ────────────────────────────────────────────────────
  // sliderFrom/sliderTo = visual position (updates every mousemove)
  // committedFrom/committedTo = triggers API (updates only on mouseup)
  const [committedFrom, setCommittedFrom] = useState(MARKET_START_MIN);
  const [committedTo,   setCommittedTo]   = useState(MARKET_END_MIN);

  const sliderMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current || !sliderTrackRef.current) return;
    const rect = sliderTrackRef.current.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const min  = Math.round(MARKET_START_MIN + pct * MARKET_DURATION);
    setTimeRange('custom');
    if (dragging.current === 'from') {
      setSliderFrom(Math.min(min, sliderTo - 5));
    } else {
      setSliderTo(Math.max(min, sliderFrom + 5));
    }
  }, [sliderFrom, sliderTo]);

  const sliderMouseUp = useCallback(() => {
    if (dragging.current) {
      // Commit the final position → triggers API call
      setCommittedFrom(sliderFrom);
      setCommittedTo(sliderTo);
    }
    dragging.current = null;
  }, [sliderFrom, sliderTo]);

  useEffect(() => {
    window.addEventListener('mousemove', sliderMouseMove);
    window.addEventListener('mouseup',  sliderMouseUp);
    return () => {
      window.removeEventListener('mousemove', sliderMouseMove);
      window.removeEventListener('mouseup',  sliderMouseUp);
    };
  }, [sliderMouseMove, sliderMouseUp]);

  // ── Preset select ───────────────────────────────────────────────────────────
  const applyPreset = useCallback((preset: TimeRange) => {
    setTimeRange(preset);
    setShowRangeDrop(false);
    if (preset !== 'custom') {
      const [f, t] = presetToRange(preset);
      setSliderFrom(f);
      setSliderTo(t);
      setCommittedFrom(f);
      setCommittedTo(t);
    }
  }, []);

  // showDrop tracks whether dropdown should be visible
  useEffect(() => {
    setActiveIdx(-1);
    setShowDrop(query.length > 0);
  }, [query]);

  // ── Fetch expiries from /api/nubra-refdata ──────────────────────────────────

  const fetchExpiries = useCallback(async (sym: string, exch: string) => {
    const headers = nubraHeaders();
    if (!headers['x-session-token']) return;
    try {
      const res = await fetch(
        `/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exch}`,
        { headers }
      );
      if (!res.ok) return;
      const json = await res.json();
      const list: string[] = json?.expiries ?? [];
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const future = list.filter(e => String(e) >= today).sort();
      setExpiries(future);
      setExpiry(future[0] ?? '');
    } catch { /* ignore */ }
  }, []);

  // ── OI Change fetch ─────────────────────────────────────────────────────────

  // Returns the last trading day date string YYYY-MM-DD (IST perspective)
  // If market is open today, returns today. If before 9:15 or weekend, returns prev trading day.
  function lastTradingDate(): string {
    const istMs  = Date.now() + 5.5 * 3600 * 1000;
    const d      = new Date(istMs);
    const istMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    // If today is weekday but before market open, treat as previous day
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && istMin < MARKET_START_MIN) {
      d.setUTCDate(d.getUTCDate() - 1);
    }
    // Walk back over weekends
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // Convert IST minutes-since-midnight to UTC ISO string on the last trading date
  function istMinToUtcIso(istMin: number): string {
    const date   = lastTradingDate();
    const utcMin = istMin - 330; // IST = UTC+5:30
    const h = Math.floor(((utcMin % 1440) + 1440) % 1440 / 60);
    const m = ((utcMin % 1440) + 1440) % 1440 % 60;
    return `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  }

  const fetchOIChange = useCallback(async (
    sym: string,
    exch: string,
    exp: string,
    _nType: 'INDEX' | 'STOCK',
    fromMin: number,
    toMin: number,
  ) => {
    if (!sym || !exp) return;
    setLoading(true);
    setError('');

    const headers = nubraHeaders();
    if (!headers['x-session-token']) {
      setError('NOT LOGGED IN');
      setLoading(false);
      return;
    }

    try {
      const refRes = await fetch(
        `/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exch}&expiry=${exp}`,
        { headers }
      );
      if (!refRes.ok) throw new Error(`refdata ${refRes.status}`);
      const refJson = await refRes.json();
      const refdata: RefDataItem[] = refJson?.refdata ?? [];
      if (!refdata.length) { setBars([]); setLoading(false); return; }

      const allStrikes = [...new Set(refdata.map(r => r.StrikePrice))].sort((a, b) => a - b);
      const minStrike  = allStrikes[0];
      const maxStrike  = allStrikes[allStrikes.length - 1];

      const fromTime = istMinToUtcIso(fromMin);
      const toTime   = istMinToUtcIso(toMin);

      const oiRes = await fetch('/api/nubra-oi-change', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queryTemplate: {
            exchange: exch,
            asset:    sym,
            expiries: [exp],
            strikes:  allStrikes,
            minStrike,
            maxStrike,
            fields:   ['cumulative_oi'],
          },
          fromTime,
          toTime,
        }),
      });
      if (!oiRes.ok) throw new Error(`oi-change ${oiRes.status}`);
      const oiJson = await oiRes.json();

      const assetData = oiJson?.result?.[exch]?.[sym];
      const timeKey   = assetData ? Object.keys(assetData)[0] : null;
      const expiryMap = timeKey ? assetData[timeKey]?.[exp] : null;

      const barMap = new Map<number, OIBar>();
      for (const sp of allStrikes) barMap.set(sp, { strike: sp / 100, ce: 0, pe: 0 });

      if (expiryMap) {
        for (const [spStr, val] of Object.entries(expiryMap as Record<string, any>)) {
          const sp  = parseInt(spStr, 10);
          const bar = barMap.get(sp);
          if (!bar) continue;
          const oiObj = val?.cumulative_oi ?? {};
          if (oiObj.CE != null) bar.ce = oiObj.CE;
          if (oiObj.PE != null) bar.pe = oiObj.PE;
        }
      }

      const sorted = [...barMap.values()].sort((a, b) => a.strike - b.strike);
      setBars(sorted);
      setTotalCe(sorted.reduce((s, b) => s + b.ce, 0));
      setTotalPe(sorted.reduce((s, b) => s + b.pe, 0));
    } catch (e: any) {
      setError(e.message ?? 'ERROR');
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Plain OI fetch (snapshot at current time) ────────────────────────────────
  const fetchOI = useCallback(async (sym: string, exch: string, exp: string) => {
    if (!sym || !exp) return;
    setLoading(true); setError('');
    const headers = nubraHeaders();
    if (!headers['x-session-token']) { setError('NOT LOGGED IN'); setLoading(false); return; }
    try {
      const refRes = await fetch(`/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exch}&expiry=${exp}`, { headers });
      if (!refRes.ok) throw new Error(`refdata ${refRes.status}`);
      const refdata: RefDataItem[] = (await refRes.json())?.refdata ?? [];
      if (!refdata.length) { setBars([]); setLoading(false); return; }
      const allStrikes = [...new Set(refdata.map(r => r.StrikePrice))].sort((a, b) => a - b);
      const minStrike = allStrikes[0], maxStrike = allStrikes[allStrikes.length - 1];
      // Compute best available market time:
      // - If IST now is within market hours → use current IST time
      // - If before 9:15 today or weekend → use last trading day 15:30
      const istMs  = Date.now() + 5.5 * 3600 * 1000;
      const istNow = new Date(istMs);
      const istMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
      const dayOfWeek = istNow.getUTCDay(); // 0=Sun,6=Sat

      let time: string;
      if (istMin >= MARKET_START_MIN && istMin <= MARKET_END_MIN && dayOfWeek >= 1 && dayOfWeek <= 5) {
        // Market is open right now — use current IST time
        time = istMinToUtcIso(istMin);
      } else {
        // Before market open, after close, or weekend — walk back to last trading day 15:30
        const d = new Date(istMs);
        // If before 9:15 today (weekday), go to previous day
        if (dayOfWeek >= 1 && dayOfWeek <= 5 && istMin < MARKET_START_MIN) {
          d.setUTCDate(d.getUTCDate() - 1);
        }
        // Skip weekends
        let dow = d.getUTCDay();
        while (dow === 0 || dow === 6) {
          d.setUTCDate(d.getUTCDate() - 1);
          dow = d.getUTCDay();
        }
        const yyyy = d.getUTCFullYear();
        const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd   = String(d.getUTCDate()).padStart(2, '0');
        // 15:30 IST = 10:00 UTC
        time = `${yyyy}-${mm}-${dd}T10:00:00.000Z`;
      }
      const oiRes = await fetch('/api/nubra-open-interest', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [{ exchange: exch, asset: sym, expiries: [exp], strikes: allStrikes, minStrike, maxStrike, fields: ['cumulative_oi'], time }] }),
      });
      if (!oiRes.ok) throw new Error(`oi ${oiRes.status}`);
      const oiJson = await oiRes.json();
      const assetData = oiJson?.result?.[exch]?.[sym];
      const timeKey   = assetData ? Object.keys(assetData)[0] : null;
      const expiryMap = timeKey ? assetData[timeKey]?.[exp] : null;
      const barMap = new Map<number, OIBar>();
      for (const sp of allStrikes) barMap.set(sp, { strike: sp / 100, ce: 0, pe: 0 });
      if (expiryMap) {
        for (const [spStr, val] of Object.entries(expiryMap as Record<string, any>)) {
          const sp = parseInt(spStr, 10); const bar = barMap.get(sp); if (!bar) continue;
          const o = val?.cumulative_oi ?? {};
          if (o.CE != null) bar.ce = o.CE;
          if (o.PE != null) bar.pe = o.PE;
        }
      }
      const sorted = [...barMap.values()].sort((a, b) => a.strike - b.strike);
      setBars(sorted);
      setTotalCe(sorted.reduce((s, b) => s + b.ce, 0));
      setTotalPe(sorted.reduce((s, b) => s + b.pe, 0));
    } catch (e: any) { setError(e.message ?? 'ERROR'); }
    finally { setLoading(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Symbol select ───────────────────────────────────────────────────────────

  const handleSymbolSelect = useCallback((sym: string, _exch: string) => {
    const resolved = resolveNubra(sym, nubraInstruments);
    setSymbol(resolved.nubraSym);
    setExchange(resolved.exchange);
    setNubraType(resolved.nubraType);
    setQuery(resolved.nubraSym);
    setShowDrop(false);
    setExpiries([]);
    setExpiry('');
    setBars([]);
    fetchExpiries(resolved.nubraSym, resolved.exchange);
  }, [nubraInstruments, fetchExpiries]);

  // ── Auto-load initialSymbol on mount ────────────────────────────────────────
  const initialSymbolLoadedRef = useRef(false);
  useEffect(() => {
    if (!initialSymbol || initialSymbolLoadedRef.current || nubraInstruments.length === 0) return;
    initialSymbolLoadedRef.current = true;
    handleSymbolSelect(initialSymbol, 'NSE');
  }, [initialSymbol, nubraInstruments, handleSymbolSelect]);

  // ── Auto-load when expiry/range/customTime changes ─────────────────────────

  useEffect(() => {
    if (!symbol || !expiry) return;
    if (showOIChange) {
      fetchOIChange(symbol, exchange, expiry, nubraType, committedFrom, committedTo);
    } else {
      fetchOI(symbol, exchange, expiry);
    }
  }, [symbol, expiry, exchange, nubraType, showOIChange, committedFrom, committedTo, fetchOI, fetchOIChange]);

  // ── 1-minute auto-refresh (market hours only) ───────────────────────────────

  useEffect(() => {
    if (!symbol || !expiry) return;
    const id = setInterval(() => {
      const istMs  = Date.now() + 5.5 * 3600 * 1000;
      const istNow = new Date(istMs);
      const istMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
      const dow    = istNow.getUTCDay();
      const isMarket = dow >= 1 && dow <= 5 && istMin >= MARKET_START_MIN && istMin <= MARKET_END_MIN;
      if (!isMarket) return;
      if (showOIChange) {
        fetchOIChange(symbol, exchange, expiry, nubraType, committedFrom, committedTo);
      } else {
        fetchOI(symbol, exchange, expiry);
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [symbol, expiry, exchange, nubraType, showOIChange, committedFrom, committedTo, fetchOI, fetchOIChange]);

  // ── ECharts rendering ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return;
    let inst = chartInst.current;

    getECharts().then(echarts => {
      if (!chartRef.current) return;
      if (!inst) {
        inst = echarts.init(chartRef.current, null, { renderer: 'canvas' });
        chartInst.current = inst;
      }

      if (!bars.length) {
        inst.clear();
        return;
      }

      const isChange = showOIChange;
      const filtered = bars.filter(b => {
        if (optType === 'CE') return isChange ? b.ce !== 0 : b.ce > 0;
        if (optType === 'PE') return isChange ? b.pe !== 0 : b.pe > 0;
        return isChange ? (b.ce !== 0 || b.pe !== 0) : (b.ce > 0 || b.pe > 0);
      });

      const strikes   = filtered.map(b => b.strike.toLocaleString('en-IN'));
      const ceValues  = filtered.map(b => b.ce);
      const peValues  = filtered.map(b => b.pe);

      const CE_COLOR = '#0ECB81';   // green — Call
      const PE_COLOR = '#F6465D';   // red  — Put

      const barW = optType === 'BOTH' ? 14 : 18;

      const callLabel = showOIChange ? 'Call OI Chg' : 'Call OI';
      const putLabel  = showOIChange ? 'Put OI Chg'  : 'Put OI';

      const series: any[] = [];
      if (optType === 'CE' || optType === 'BOTH') {
        series.push({
          name: callLabel,
          type: 'bar',
          data: ceValues,
          barMaxWidth: barW,
          barGap: '4%',
          itemStyle: {
            color: (params: any) => {
              const v = typeof params === 'object' ? params.value : params;
              return isChange && v < 0 ? 'rgba(14,203,129,0.35)' : CE_COLOR;
            },
            borderRadius: [3, 3, 0, 0],
          },
          emphasis: { focus: 'series', itemStyle: { shadowBlur: 8, shadowColor: 'rgba(33,150,243,0.5)' } },
        });
      }
      if (optType === 'PE' || optType === 'BOTH') {
        series.push({
          name: putLabel,
          type: 'bar',
          data: peValues,
          barMaxWidth: barW,
          barGap: '4%',
          itemStyle: {
            color: (params: any) => {
              const v = typeof params === 'object' ? params.value : params;
              return isChange && v < 0 ? 'rgba(246,70,93,0.45)' : PE_COLOR;
            },
            borderRadius: [3, 3, 0, 0],
          },
          emphasis: { focus: 'series', itemStyle: { shadowBlur: 8, shadowColor: 'rgba(255,87,34,0.5)' } },
        });
      }

      const fmtOI = (v: number) => {
        const sign = v < 0 ? '-' : '';
        const a = Math.abs(v);
        if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)} Cr`;
        if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)} L`;
        if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(0)}K`;
        return String(v);
      };

      inst.setOption({
        backgroundColor: '#131110',
        animation: true,
        animationDuration: 350,
        animationEasing: 'cubicOut',
        grid: { left: 72, right: 12, top: optType === 'BOTH' ? 44 : 20, bottom: 62 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.025)' } },
          backgroundColor: '#1c1a17',
          borderColor: 'rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: [10, 14],
          extraCssText: 'box-shadow:0 12px 32px rgba(0,0,0,0.8);',
          formatter(params: any[]) {
            const strike = params[0]?.axisValue ?? '';
            let html = `<div style="font-size:14px;font-weight:700;margin-bottom:8px;color:#ffffff;letter-spacing:0.02em">${strike}</div>`;
            for (const p of params) {
              if (p.value == null || (!isChange && !p.value)) continue;
              const color = p.seriesName.includes('Call') ? '#0ECB81' : '#F6465D';
              const val   = fmtOI(Number(p.value));
              html += `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                <span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block;flex-shrink:0"></span>
                <span style="color:#ffffff;font-weight:600;font-size:12px">${p.seriesName}</span>
                <span style="color:${color};margin-left:12px;font-weight:700;font-size:13px">${val}</span>
              </div>`;
            }
            return html;
          },
        },
        legend: {
          show: optType === 'BOTH',
          top: 10,
          left: 'center',
          textStyle: { color: '#ffffff', fontSize: 12, fontWeight: 600 },
          itemWidth: 14,
          itemHeight: 10,
          itemStyle: { borderRadius: 2 },
          data: [
            { name: callLabel, itemStyle: { color: CE_COLOR } },
            { name: putLabel,  itemStyle: { color: PE_COLOR } },
          ],
        },
        xAxis: {
          type: 'category',
          data: strikes,
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 600,
            rotate: strikes.length > 24 ? 45 : 0,
            interval: Math.max(0, Math.floor(strikes.length / 18)),
            margin: 10,
          },
          splitLine: { show: false },
          name: 'Strike Price',
          nameLocation: 'middle',
          nameGap: strikes.length > 24 ? 46 : 28,
          nameTextStyle: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: 500 },
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)', type: 'dashed' } },
          axisLabel: {
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 600,
            margin: 10,
            formatter: fmtOI,
          },
        },
        dataZoom: [
          { type: 'inside', start: 0, end: 100, zoomOnMouseWheel: true },
          {
            type: 'slider',
            bottom: 8,
            height: 22,
            borderColor: 'rgba(255,255,255,0.08)',
            backgroundColor: 'rgba(255,255,255,0.03)',
            fillerColor: 'rgba(79,142,247,0.15)',
            handleStyle: { color: '#4f8ef7', borderColor: '#4f8ef7' },
            handleSize: '80%',
            moveHandleStyle: { color: '#4f8ef7' },
            dataBackground: {
              lineStyle: { color: 'rgba(255,255,255,0.1)' },
              areaStyle: { color: 'rgba(255,255,255,0.04)' },
            },
            selectedDataBackground: {
              lineStyle: { color: 'rgba(79,142,247,0.5)' },
              areaStyle: { color: 'rgba(79,142,247,0.1)' },
            },
            textStyle: { color: '#ffffff', fontSize: 10 },
            labelFormatter: (_: any, val: string) => val,
          },
        ],
        series,
      }, true);
    });
  }, [bars, optType, showOIChange]);

  // Resize observer — watch the wrap so resize fires even when bars mount/unmount
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => chartInst.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Cleanup
  useEffect(() => () => { chartInst.current?.dispose(); chartInst.current = null; }, []);

  // ── Keyboard nav ────────────────────────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showDrop || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      const sg = suggestions[activeIdx];
      handleSymbolSelect(sg.sym, sg.exchange);
    }
    else if (e.key === 'Escape') { setShowDrop(false); }
  }, [showDrop, suggestions, activeIdx, handleSymbolSelect]);

  // ── Formatters ───────────────────────────────────────────────────────────────

  function fmtLakh(v: number): string {
    if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
    if (v >= 1e5) return `${(v / 1e5).toFixed(2)} Lakh`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return String(v);
  }

  function fmtExpiry(e: string) {
    if (e.length !== 8) return e;
    return `${e.slice(6, 8)}/${e.slice(4, 6)}/${e.slice(0, 4)}`;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className={s.root}>
      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          {/* Symbol search */}
          <div className={s.searchWrap}>
            <div className={s.searchBox}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                ref={inputRef}
                className={s.searchInput}
                placeholder="Search symbol…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onFocus={() => query && setShowDrop(true)}
                onBlur={() => setTimeout(() => setShowDrop(false), 150)}
                onKeyDown={onKeyDown}
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button className={s.clearBtn} onMouseDown={e => { e.preventDefault(); setQuery(''); setShowDrop(false); }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>

            {showDrop && suggestions.length > 0 && (
              <div className={s.dropdown}>
                <div className={s.dropdownList}>
                  {suggestions.map((sg, i) => (
                    <div
                      key={`${sg.sym}|${sg.exchange}`}
                      className={`${s.dropdownItem} ${i === activeIdx ? s.dropdownItemActive : ''}`}
                      onMouseDown={() => handleSymbolSelect(sg.sym, sg.exchange)}
                    >
                      <span className={s.dropdownExch}>{sg.exchange}</span>
                      <span className={s.dropdownSym}>{sg.sym}</span>
                      <span className={s.dropdownType}>
                        {sg.asset_type.includes('INDEX') ? 'INDEX' : 'STOCK'}
                      </span>
                    </div>
                  ))}
                </div>
                <div className={s.dropdownFooter}>
                  <span><kbd>↑↓</kbd> navigate</span>
                  <span><kbd>↵</kbd> select</span>
                  <span><kbd>Esc</kbd> close</span>
                </div>
              </div>
            )}
          </div>

          {/* Expiry */}
          {expiries.length > 0 && (
            <select
              className={s.expirySelect}
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
            >
              {expiries.map(e => (
                <option key={e} value={e}>{fmtExpiry(e)}</option>
              ))}
            </select>
          )}
        </div>

        <div className={s.toolbarRight}>
          {/* CE / PE / BOTH toggle */}
          <div className={s.typeToggle}>
            <button className={`${s.typeBtn} ${optType === 'CE'   ? s.typeBtnBothActive : ''}`} onClick={() => setOptType('CE')}>CE</button>
            <button className={`${s.typeBtn} ${optType === 'BOTH' ? s.typeBtnBothActive : ''}`} onClick={() => setOptType('BOTH')}>BOTH</button>
            <button className={`${s.typeBtn} ${optType === 'PE'   ? s.typeBtnBothActive : ''}`} onClick={() => setOptType('PE')}>PE</button>
          </div>

          {/* OI Change toggle */}
          <button
            className={`${s.oiChgToggle} ${showOIChange ? s.oiChgToggleActive : ''}`}
            onClick={() => setShowOIChange(p => !p)}
            title="Show OI Change"
          >OI Chg</button>

          {/* Range preset dropdown — only when OI Change is on */}
          {showOIChange && (
            <div className={s.rangeDDWrap} ref={rangeDDRef}>
              <button className={s.rangeDDBtn} onClick={() => setShowRangeDrop(p => !p)}>
                <span>{RANGE_OPTIONS.find(o => o.value === timeRange)?.label ?? 'Custom'}</span>
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              {showRangeDrop && (
                <div className={s.rangeDDList}>
                  {RANGE_OPTIONS.map(o => (
                    <button
                      key={o.value}
                      className={`${s.rangeDDItem} ${timeRange === o.value ? s.rangeDDItemActive : ''}`}
                      onClick={() => applyPreset(o.value)}
                    >{o.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {loading && <div className={s.loadingDot} />}
          {error   && <span className={s.errorLabel}>{error}</span>}
        </div>
      </div>

      {/* ── Time slider — only when OI Change is on ── */}
      {showOIChange && <div className={s.sliderPanel}>
        <span className={s.sliderTime}>{minToLabel(sliderFrom)}</span>
        <div className={s.sliderTrack} ref={sliderTrackRef}>
          {/* filled range */}
          <div
            className={s.sliderFill}
            style={{
              left:  `${((sliderFrom - MARKET_START_MIN) / MARKET_DURATION) * 100}%`,
              width: `${((sliderTo - sliderFrom) / MARKET_DURATION) * 100}%`,
            }}
          />
          {/* from handle */}
          <div
            className={s.sliderHandle}
            style={{ left: `${((sliderFrom - MARKET_START_MIN) / MARKET_DURATION) * 100}%` }}
            onMouseDown={() => { dragging.current = 'from'; }}
          />
          {/* to handle */}
          <div
            className={s.sliderHandle}
            style={{ left: `${((sliderTo - MARKET_START_MIN) / MARKET_DURATION) * 100}%` }}
            onMouseDown={() => { dragging.current = 'to'; }}
          />
        </div>
        <span className={s.sliderTime}>{minToLabel(sliderTo)}</span>
      </div>}

      {/* ── Chart ── */}
      <div ref={wrapRef} className={s.chartWrap}>
        {!symbol ? (
          <div className={s.placeholder}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="4" height="18"/><rect x="10" y="8" width="4" height="13"/><rect x="18" y="5" width="4" height="16"/>
            </svg>
            <span>Search a symbol to view open interest</span>
          </div>
        ) : !bars.length && !loading ? (
          <div className={s.placeholder}>
            <span>No OI data for selected expiry</span>
          </div>
        ) : (
          <div ref={chartRef} style={{ width: '100%', height: '100%' }} />
        )}

        {/* ── Info box ── */}
        {bars.length > 0 && (
          <div className={s.infoBox}>
            <div className={s.infoItem}>
              <span className={s.infoLabel}>Total Call OI</span>
              <span className={s.infoValueRed}>{fmtLakh(totalCe)}</span>
            </div>
            <div className={s.infoDivider} />
            <div className={s.infoItem}>
              <span className={s.infoLabel}>Total Put OI</span>
              <span className={s.infoValueGreen}>{fmtLakh(totalPe)}</span>
            </div>
            <div className={s.infoDivider} />
            <div className={s.infoItem}>
              <span className={s.infoLabel}>PCR</span>
              <span className={s.infoValueWhite}>
                {totalCe > 0 ? (totalPe / totalCe).toFixed(2) : '—'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
