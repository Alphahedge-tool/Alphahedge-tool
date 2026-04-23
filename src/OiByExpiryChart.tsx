'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type HistogramData,
  type Time,
} from 'lightweight-charts';
import type { NubraInstrument } from './useNubraInstruments';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  nubraInstruments: NubraInstrument[];
  initialSymbol?: string;
}

interface OiPoint {
  ts: number; // ms
  call: number;
  put: number;
}

interface SpotPoint {
  ts: number;
  value: number;
}

type OiByExpiry = Map<string, OiPoint[]>;

// ── Palette ───────────────────────────────────────────────────────────────────

const EXPIRY_COLORS = [
  '#f59e0b', '#a78bfa', '#34d399', '#f87171', '#38bdf8',
  '#fb923c', '#e879f9', '#4ade80', '#facc15', '#60a5fa',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeToMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  if (ts > 1e17) return Math.floor(ts / 1e9) * 1000;
  if (ts > 1e14) return Math.floor(ts / 1e6);
  if (ts > 1e12) return Math.floor(ts);
  if (ts > 1e9) return Math.floor(ts * 1000);
  return 0;
}

function prevTradingDate(yyyyMmDd: string): string {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() - 1); }
  while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

function nthPrevTradingDate(yyyyMmDd: string, n: number): string {
  let date = yyyyMmDd;
  for (let i = 0; i < n; i++) date = prevTradingDate(date);
  return date;
}

function resolveIntradayTradingDate(): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hh = Number(parts.hour ?? '0');
  const mm = Number(parts.minute ?? '0');
  const isWeekend = parts.weekday === 'Sun' || parts.weekday === 'Sat';
  if (isWeekend || hh < 9 || (hh === 9 && mm < 15)) return prevTradingDate(date);
  return date;
}

function istToUtcIso(date: string, hhmm: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0, 0)).toISOString();
}

function isMarketOpen(): boolean {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]));
  const hh = Number(parts.hour ?? '0');
  const mm = Number(parts.minute ?? '0');
  const istMin = hh * 60 + mm;
  const isWeekend = parts.weekday === 'Sun' || parts.weekday === 'Sat';
  return !isWeekend && istMin >= 9 * 60 + 15 && istMin <= 15 * 60 + 30;
}

function fmtLakhs(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  return `${sign}${abs.toLocaleString('en-IN')}`;
}

function fmtChg(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  return `${sign}${abs.toLocaleString('en-IN')}`;
}

function fmtTime(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function buildNubraChainValue(symbol: string, expiry: string): string {
  return `${symbol}_${expiry}`;
}

function getSpotType(instruments: NubraInstrument[], symbol: string): 'INDEX' | 'STOCK' {
  const found = instruments.find(i =>
    i.asset === symbol && (i.option_type === 'CE' || i.option_type === 'PE')
  );
  return (found?.asset_type ?? '').toUpperCase() === 'INDEX_FO' ? 'INDEX' : 'STOCK';
}

function getSymbols(instruments: NubraInstrument[]): string[] {
  const seen = new Set<string>();
  for (const i of instruments) {
    if ((i.option_type === 'CE' || i.option_type === 'PE') && i.asset) seen.add(i.asset);
  }
  return [...seen].sort();
}

function getExpiryInfo(instruments: NubraInstrument[], symbol: string): { exchange: string; expiries: string[] } {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seen = new Set<string>();
  let exchange = 'NSE';
  let assetType = '';
  for (const i of instruments) {
    if (i.asset !== symbol) continue;
    if (i.option_type !== 'CE' && i.option_type !== 'PE') continue;
    if (i.expiry && String(i.expiry) >= today) seen.add(String(i.expiry));
    if (i.asset_type) assetType = String(i.asset_type).toUpperCase();
    if (i.exchange) exchange = i.exchange;
  }
  if (assetType !== 'INDEX_FO') exchange = 'NSE';
  return { exchange, expiries: [...seen].sort() };
}

function expiryLabel(exp: string): string {
  if (!exp || exp.length !== 8) return exp;
  const d = new Date(`${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
}

const istDayKey = (ts: number) => new Date(ts + 5.5 * 3600_000).toISOString().slice(0, 10);

function applyMode(pts: OiPoint[], mode: 'oi' | 'chg'): OiPoint[] {
  if (!pts.length || mode === 'oi') return pts;
  const bases = new Map<string, OiPoint>();
  for (const p of pts) {
    const key = istDayKey(p.ts);
    if (!bases.has(key)) bases.set(key, p);
  }
  return pts.map(p => {
    const base = bases.get(istDayKey(p.ts)) ?? pts[0];
    return { ts: p.ts, call: p.call - base.call, put: p.put - base.put };
  });
}

function OiDonut({
  call, put, mode, top = 8, left = 90, scale = 1,
}: {
  call: number;
  put: number;
  mode: 'oi' | 'chg';
  top?: number;
  left?: number;
  scale?: number;
}) {
  const absCall = Math.abs(call);
  const absPut = Math.abs(put);
  const absTotal = absCall + absPut;
  if (absTotal <= 0) return null;

  const size = 100 * scale;
  const r = 36 * scale;
  const cx = size / 2;
  const cy = size / 2;
  const fmt = (v: number) => mode === 'chg' ? fmtChg(v) : fmtLakhs(v);
  const pcr = absCall > 0 ? absPut / absCall : 0;

  return (
    <div style={{
      position: 'absolute',
      top,
      left,
      pointerEvents: 'none',
      zIndex: 5,
      display: 'flex',
      alignItems: 'center',
      gap: 10 * scale,
    }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={16 * scale} />
          <path
            d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r}`}
            fill="none"
            stroke="#22c55e"
            strokeWidth={16 * scale}
            strokeLinecap="butt"
            opacity={absCall / absTotal + 0.15}
          />
          <path
            d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r}`}
            fill="none"
            stroke="#ef4444"
            strokeWidth={16 * scale}
            strokeLinecap="butt"
            opacity={absPut / absTotal + 0.15}
          />
          <text x={cx} y={cy - 7 * scale} textAnchor="middle" fontSize={9.5 * scale} fill="rgba(255,255,255,0.4)" letterSpacing="0.55">PCR</text>
          <text x={cx} y={cy + 12 * scale} textAnchor="middle" fontSize={15 * scale} fontWeight="700" fill="#e2e8f0">{pcr > 0 ? pcr.toFixed(2) : '—'}</text>
        </svg>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 * scale }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 * scale }}>
          <span style={{ width: 8 * scale, height: 8 * scale, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontSize: 9 * scale, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em' }}>CALL</div>
            <div style={{ fontSize: 12 * scale, fontWeight: 700, color: '#22c55e' }}>{fmt(call)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 * scale }}>
          <span style={{ width: 8 * scale, height: 8 * scale, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontSize: 9 * scale, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em' }}>PUT</div>
            <div style={{ fontSize: 12 * scale, fontWeight: 700, color: '#ef4444' }}>{fmt(put)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Chart config factory ───────────────────────────────────────────────────────

function makeChartOptions() {
  return {
    autoSize: true,
    layout: { background: { color: '#131110' }, textColor: '#a09080', fontSize: 11 },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.05)' },
      horzLines: { color: 'rgba(255,255,255,0.05)' },
    },
    rightPriceScale: {
      visible: true,
      borderColor: 'rgba(255,255,255,0.1)',
      scaleMargins: { top: 0.1, bottom: 0.08 },
    },
    leftPriceScale: { visible: false },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.1)',
      timeVisible: true, secondsVisible: false, rightOffset: 3,
      tickMarkFormatter: (t: Time) =>
        new Date(Number(t) * 1000).toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
        }),
    },
    localization: {
      timeFormatter: (t: Time) =>
        new Date(Number(t) * 1000).toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
        }),
      priceFormatter: (p: number) => fmtLakhs(p),
    },
    crosshair: {
      vertLine: { color: 'rgba(255,255,255,0.3)', width: 1, style: 2, labelVisible: true },
      horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: 2, labelVisible: true },
    },
    handleScroll: true, handleScale: true,
  } as const;
}

// ── ExpiryMiniChart ───────────────────────────────────────────────────────────
// Self-contained: owns symbol + expiry selectors, data fetch, and chart

interface MiniProps {
  nubraInstruments: NubraInstrument[];
  allSymbols: string[];
  color: string;
  mode: 'oi' | 'chg';
  daysBack: number;
  defaultSymbol: string;
  defaultExpiry?: string;
}

function ExpiryMiniChart({ nubraInstruments, allSymbols, color, mode, daysBack, defaultSymbol, defaultExpiry }: MiniProps) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(defaultExpiry ?? '');
  const [exchange, setExchange] = useState('NSE');
  const [pts, setPts] = useState<OiPoint[]>([]);

  const hostRef   = useRef<HTMLDivElement | null>(null);
  const chartRef  = useRef<IChartApi | null>(null);
  const callRef   = useRef<ISeriesApi<'Line'> | null>(null);
  const putRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const spreadRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const fittedRef = useRef(false);
  const cancelRef = useRef(false);

  const [tooltip, setTooltip] = useState<{
    visible: boolean; x: number; y: number;
    time: string; call: number; put: number; spread: number; pcr: number;
  }>({ visible: false, x: 0, y: 0, time: '', call: 0, put: 0, spread: 0, pcr: 0 });

  // ── derive expiries when symbol changes ──────────────────────────────────────
  useEffect(() => {
    if (!nubraInstruments.length) return;
    const { exchange: ex, expiries: exps } = getExpiryInfo(nubraInstruments, symbol);
    setExchange(ex);
    setExpiries(exps);
    setExpiry(exps[0] ?? '');
    setPts([]);
    fittedRef.current = false;
  }, [symbol, nubraInstruments]);

  // ── fetch data ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!symbol || !expiry || !exchange) return;
    cancelRef.current = false;
    fittedRef.current = false;
    setPts([]);

    const cv = buildNubraChainValue(symbol, expiry);

    const load = async () => {
      if (cancelRef.current) return;
      const tradingDate = resolveIntradayTradingDate();
      const startTradingDate = daysBack > 0 ? nthPrevTradingDate(tradingDate, daysBack) : tradingDate;
      const startDate = istToUtcIso(startTradingDate, '09:15');
      const endDate = new Date().toISOString();
      try {
        const result = await fetchOiByExpiry(exchange, [cv], startDate, endDate);
        if (!cancelRef.current) setPts(result.get(cv) ?? []);
      } catch { /* keep empty */ }
    };

    load();
    return () => { cancelRef.current = true; };
  }, [symbol, expiry, exchange, daysBack]);

  // ── live poll ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!symbol || !expiry || !exchange || !isMarketOpen()) return;
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const cv = buildNubraChainValue(symbol, expiry);

    const poll = async () => {
      if (cancelled) return;
      const tradingDate = resolveIntradayTradingDate();
      const startTradingDate = daysBack > 0 ? nthPrevTradingDate(tradingDate, daysBack) : tradingDate;
      const startDate = istToUtcIso(startTradingDate, '09:15');
      const endDate = new Date().toISOString();
      try {
        const result = await fetchOiByExpiry(exchange, [cv], startDate, endDate);
        if (!cancelled) setPts(result.get(cv) ?? []);
      } catch { /* keep */ }
      if (!cancelled) timerId = setTimeout(poll, 15_000);
    };

    timerId = setTimeout(poll, 15_000);
    return () => { cancelled = true; if (timerId !== null) clearTimeout(timerId); };
  }, [symbol, expiry, exchange, daysBack]);

  // ── create chart once ────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, makeChartOptions());

    const callSeries = chart.addSeries(LineSeries, {
      color: '#22c55e', lineWidth: 2, title: 'Call OI',
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110', crosshairMarkerBackgroundColor: '#22c55e',
    });
    const putSeries = chart.addSeries(LineSeries, {
      color: '#ef4444', lineWidth: 2, title: 'Put OI',
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110', crosshairMarkerBackgroundColor: '#ef4444',
    });
    chart.addPane();
    const spreadSeries = chart.addSeries(HistogramSeries, {
      priceLineVisible: false, lastValueVisible: true, title: 'Spread', base: 0,
    }, 1);
    spreadSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 }, borderColor: 'rgba(255,255,255,0.08)' });

    chart.subscribeCrosshairMove(param => {
      const h = hostRef.current;
      if (!h || !param.point || !param.time) { setTooltip(t => t.visible ? { ...t, visible: false } : t); return; }
      const { x, y } = param.point;
      if (x < 0 || y < 0 || x > h.clientWidth || y > h.clientHeight) { setTooltip(t => t.visible ? { ...t, visible: false } : t); return; }
      const callVal = (param.seriesData.get(callSeries) as any)?.value ?? 0;
      const putVal  = (param.seriesData.get(putSeries)  as any)?.value ?? 0;
      const spread  = putVal - callVal;
      const pcr = callVal !== 0 ? putVal / callVal : 0;
      const tx = Math.max(8, Math.min(h.clientWidth - 160, x + 12));
      const ty = Math.max(8, Math.min(h.clientHeight - 110, y + 12));
      setTooltip({ visible: true, x: tx, y: ty, time: fmtTime(Number(param.time)), call: callVal, put: putVal, spread, pcr });
    });

    chartRef.current  = chart;
    callRef.current   = callSeries;
    putRef.current    = putSeries;
    spreadRef.current = spreadSeries;

    return () => {
      chartRef.current?.remove();
      chartRef.current = callRef.current = putRef.current = spreadRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  // ── push data to chart ───────────────────────────────────────────────────────
  const activePts = useMemo(() => applyMode(pts, mode), [pts, mode]);

  useEffect(() => {
    const callData: LineData[]        = activePts.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.call }));
    const putData:  LineData[]        = activePts.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.put  }));
    const spreadData: HistogramData[] = activePts.map(p => {
      const s = p.put - p.call;
      return { time: Math.floor(p.ts / 1000) as Time, value: s, color: s >= 0 ? 'rgba(34,197,94,0.65)' : 'rgba(239,68,68,0.65)' };
    });
    callRef.current?.setData(callData);
    putRef.current?.setData(putData);
    spreadRef.current?.setData(spreadData);
    if (!fittedRef.current && callData.length) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [activePts]);

  const lastPt     = activePts[activePts.length - 1];
  const lastCall   = lastPt?.call ?? 0;
  const lastPut    = lastPt?.put  ?? 0;
  const lastSpread = lastPut - lastCall;
  const pcr        = lastCall > 0 ? lastPut / lastCall : 0;

  return (
    <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', borderRight: '1px solid rgba(255,255,255,0.06)' }}>

      {/* ── Toolbar row ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 6px', background: '#0f0e0d', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        {/* color dot */}
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />

        {/* symbol picker */}
        <select value={symbol} onChange={e => setSymbol(e.target.value)} style={miniSelectStyle}>
          {allSymbols.map(s => <option key={s} value={s} style={{ background: '#1a1c20' }}>{s}</option>)}
        </select>

        {/* expiry picker */}
        <select value={expiry} onChange={e => { setExpiry(e.target.value); fittedRef.current = false; }} style={{ ...miniSelectStyle, maxWidth: 90 }} disabled={!expiries.length}>
          {expiries.map(ex => <option key={ex} value={ex} style={{ background: '#1a1c20' }}>{expiryLabel(ex)}</option>)}
        </select>

        {/* live stats */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 10 }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>C {fmtLakhs(lastCall)}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>P {fmtLakhs(lastPut)}</span>
          {mode === 'oi' && pcr > 0 && <span style={{ color: '#f59e0b', fontWeight: 600 }}>PCR {pcr.toFixed(2)}</span>}
          <span style={{ color: lastSpread >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>Spr {fmtLakhs(lastSpread)}</span>
        </div>
      </div>

      {/* ── Chart area ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
        <OiDonut call={lastCall} put={lastPut} mode={mode} top={8} left={84} scale={0.78} />

        {/* legend */}
        <div style={{ position: 'absolute', bottom: 4, left: 6, zIndex: 5, display: 'flex', gap: 8, fontSize: 10, pointerEvents: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#94a3b8' }}><span style={{ width: 12, height: 2, background: '#22c55e', display: 'inline-block', borderRadius: 999 }} /> Call</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#94a3b8' }}><span style={{ width: 12, height: 2, background: '#ef4444', display: 'inline-block', borderRadius: 999 }} /> Put</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#94a3b8' }}><span style={{ width: 9, height: 9, background: 'rgba(34,197,94,0.35)', border: '1px solid #22c55e', display: 'inline-block', borderRadius: 2 }} /> Spread</span>
        </div>

        {/* crosshair tooltip */}
        {tooltip.visible && (
          <div style={{ position: 'absolute', left: tooltip.x, top: tooltip.y, background: 'rgba(13,17,23,0.93)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '7px 10px', pointerEvents: 'none', zIndex: 10, fontSize: 11, minWidth: 145, backdropFilter: 'blur(6px)' }}>
            <div style={{ color: '#94a3b8', marginBottom: 5, fontWeight: 600 }}>{tooltip.time}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 2 }}><span style={{ color: '#22c55e' }}>Call</span><b style={{ color: '#f1f5f9' }}>{fmtLakhs(tooltip.call)}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 2 }}><span style={{ color: '#ef4444' }}>Put</span><b style={{ color: '#f1f5f9' }}>{fmtLakhs(tooltip.put)}</b></div>
            {mode === 'oi' && tooltip.pcr !== 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 2 }}><span style={{ color: '#f59e0b' }}>PCR</span><b style={{ color: '#f59e0b' }}>{tooltip.pcr.toFixed(2)}</b></div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 3, marginTop: 2 }}>
              <span style={{ color: tooltip.spread >= 0 ? '#22c55e' : '#ef4444' }}>Spread</span>
              <b style={{ color: tooltip.spread >= 0 ? '#22c55e' : '#ef4444' }}>{fmtLakhs(tooltip.spread)}</b>
            </div>
          </div>
        )}

        {!activePts.length && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.25)', fontSize: 12, pointerEvents: 'none' }}>
            {expiry ? 'Loading…' : 'No expiry'}
          </div>
        )}
      </div>
    </div>
  );
}

const miniSelectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 4,
  color: '#e2e8f0',
  fontSize: 11,
  padding: '2px 5px',
  cursor: 'pointer',
  outline: 'none',
  colorScheme: 'dark',
};

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchOiByExpiry(
  exchange: string,
  chainValues: string[],
  startDate: string,
  endDate: string,
): Promise<OiByExpiry> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken || !chainValues.length) return new Map();

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
      query: [{
        exchange, type: 'CHAIN', values: chainValues,
        fields: ['cumulative_call_oi', 'cumulative_put_oi'],
        startDate, endDate, interval: '1m', intraDay: false, realTime: false,
      }],
    }),
  });

  if (!res.ok) {
    const err = new Error(`timeseries ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const perExpiry = new Map<string, Map<number, OiPoint>>();
  for (const cv of chainValues) perExpiry.set(cv, new Map());

  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      for (const cv of chainValues) {
        const chainData = valObj?.[cv];
        if (!chainData) continue;
        const map = perExpiry.get(cv)!;
        const callArr: Array<{ ts: number; v: number }> = chainData.cumulative_call_oi ?? [];
        const putArr:  Array<{ ts: number; v: number }> = chainData.cumulative_put_oi  ?? [];
        for (const p of callArr) {
          const ts = Math.floor((p.ts ?? 0) / 1e9) * 1000;
          const row = map.get(ts) ?? { ts, call: 0, put: 0 };
          row.call += p.v ?? 0;
          map.set(ts, row);
        }
        for (const p of putArr) {
          const ts = Math.floor((p.ts ?? 0) / 1e9) * 1000;
          const row = map.get(ts) ?? { ts, call: 0, put: 0 };
          row.put += p.v ?? 0;
          map.set(ts, row);
        }
      }
    }
  }

  const result: OiByExpiry = new Map();
  for (const [cv, map] of perExpiry) {
    result.set(cv, [...map.values()].sort((a, b) => a.ts - b.ts));
  }
  return result;
}

async function fetchSpotHistory(
  exchange: string, symbol: string, spotType: 'INDEX' | 'STOCK',
  startDate: string, endDate: string,
): Promise<SpotPoint[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken    = localStorage.getItem('nubra_auth_token')    ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id')     ?? '';
  const rawCookie    = localStorage.getItem('nubra_raw_cookie')    ?? '';
  if (!sessionToken || !symbol) return [];

  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: sessionToken, auth_token: authToken,
      device_id: deviceId, raw_cookie: rawCookie,
      exchange, type: spotType, values: [symbol],
      fields: ['close'], startDate, endDate, interval: '1m', intraDay: false, realTime: false,
    }),
  });
  if (!res.ok) return [];

  const json = await res.json();
  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
  let chartObj: any = null;
  for (const dict of valuesArr) {
    for (const value of Object.values(dict ?? {})) { chartObj = value; break; }
    if (chartObj) break;
  }

  const series = chartObj?.close ?? [];
  if (!Array.isArray(series)) return [];
  const points = series
    .map((p: any) => ({ ts: normalizeToMs(Number(p?.ts ?? p?.timestamp ?? 0)), value: Number(p?.v ?? p?.value ?? 0) }))
    .filter((p: SpotPoint) => p.ts > 0 && Number.isFinite(p.value) && p.value > 0);
  if (!points.length) return [];
  const sorted = [...points].map(p => p.value).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return mid > 200000 ? points.map(p => ({ ts: p.ts, value: p.value / 100 })) : points;
}

function aggregateOi(oiByExpiry: OiByExpiry): OiPoint[] {
  const totals = new Map<number, OiPoint>();
  for (const pts of oiByExpiry.values()) {
    for (const p of pts) {
      const row = totals.get(p.ts) ?? { ts: p.ts, call: 0, put: 0 };
      row.call += p.call; row.put += p.put;
      totals.set(p.ts, row);
    }
  }
  return [...totals.values()].sort((a, b) => a.ts - b.ts);
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function OiByExpiryChart({ nubraInstruments, initialSymbol = 'NIFTY' }: Props) {
  const symbols = useMemo(() => getSymbols(nubraInstruments), [nubraInstruments]);

  const [symbol, setSymbol] = useState(initialSymbol);
  const [selectedExpiries, setSelectedExpiries] = useState<Set<string>>(new Set());
  const [exchange, setExchange] = useState('NSE');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiryDropOpen, setExpiryDropOpen] = useState(false);
  const [mode, setMode] = useState<'oi' | 'chg'>('oi');
  const [daysBack, setDaysBack] = useState(0);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [oiByExpiry, setOiByExpiry] = useState<OiByExpiry>(new Map());
  const [spotData, setSpotData] = useState<SpotPoint[]>([]);
  const [spotHistoryReady, setSpotHistoryReady] = useState(false);

  const hostTopRef    = useRef<HTMLDivElement | null>(null);
  const expiryDropRef = useRef<HTMLDivElement | null>(null);
  const chartTopRef   = useRef<IChartApi | null>(null);
  const callSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const putSeriesRef  = useRef<ISeriesApi<'Line'> | null>(null);
  const spreadTopRef  = useRef<ISeriesApi<'Histogram'> | null>(null);
  const spotTopRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const fittedTopRef  = useRef(false);
  const cancelledRef  = useRef(false);
  const spotWsRef     = useRef<WebSocket | null>(null);
  const spotSubKeyRef = useRef('');

  const [topTooltip, setTopTooltip] = useState<{
    visible: boolean; x: number; y: number;
    time: string; call: number; put: number; spot: number; pcr: number;
  }>({ visible: false, x: 0, y: 0, time: '', call: 0, put: 0, spot: 0, pcr: 0 });

  // ── dropdown close ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!expiryDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (expiryDropRef.current && !expiryDropRef.current.contains(e.target as Node))
        setExpiryDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expiryDropOpen]);

  // ── derive expiries ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!nubraInstruments.length) return;
    const { exchange: ex, expiries: exps } = getExpiryInfo(nubraInstruments, symbol);
    setExchange(ex);
    setExpiries(exps);
    setSelectedExpiries(new Set(exps.slice(0, 3)));
    setOiByExpiry(new Map());
    setSpotData([]);
    setSpotHistoryReady(false);
    setError('');
  }, [symbol, nubraInstruments]);

  // ── initial load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!symbol || !selectedExpiries.size || !exchange) return;
    cancelledRef.current = false;
    fittedTopRef.current = false;
    setOiByExpiry(new Map());
    setSpotData([]);
    setSpotHistoryReady(false);
    setError('');

    const chainValues = [...selectedExpiries].map(exp => buildNubraChainValue(symbol, exp));

    const loadOnce = async () => {
      if (cancelledRef.current) return;
      const tradingDate = resolveIntradayTradingDate();
      const startTradingDate = daysBack > 0 ? nthPrevTradingDate(tradingDate, daysBack) : tradingDate;
      const startDate = istToUtcIso(startTradingDate, '09:15');
      const endDate = new Date().toISOString();
      const spotType = getSpotType(nubraInstruments, symbol);

      const [oiRes, spotRes] = await Promise.allSettled([
        fetchOiByExpiry(exchange, chainValues, startDate, endDate),
        fetchSpotHistory(exchange, symbol, spotType, startDate, endDate),
      ]);
      if (cancelledRef.current) return;

      if (oiRes.status === 'fulfilled') {
        setOiByExpiry(oiRes.value);
        setLastUpdated(Date.now());
        setError('');
      } else {
        const e: any = oiRes.reason;
        if (!(e?.status === 400 || e?.status === 403 || e?.status === 429))
          setError(`Error ${e?.status ?? ''}: ${e?.message ?? 'fetch failed'}`);
      }
      if (spotRes.status === 'fulfilled') {
        setSpotData(spotRes.value);
        setSpotHistoryReady(spotRes.value.length > 0);
      }
    };

    loadOnce();
    return () => { cancelledRef.current = true; };
  }, [symbol, selectedExpiries, exchange, nubraInstruments, daysBack]);

  // ── live polling ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!symbol || !selectedExpiries.size || !exchange || !isMarketOpen()) return;
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const chainValues = [...selectedExpiries].map(exp => buildNubraChainValue(symbol, exp));

    const pollOi = async () => {
      if (cancelled) return;
      const tradingDate = resolveIntradayTradingDate();
      const startTradingDate = daysBack > 0 ? nthPrevTradingDate(tradingDate, daysBack) : tradingDate;
      const startDate = istToUtcIso(startTradingDate, '09:15');
      const endDate = new Date().toISOString();
      try {
        const result = await fetchOiByExpiry(exchange, chainValues, startDate, endDate);
        if (!cancelled) { setOiByExpiry(result); setLastUpdated(Date.now()); setError(''); }
      } catch { /* keep existing data */ }
      if (!cancelled) timerId = setTimeout(pollOi, 15_000);
    };

    timerId = setTimeout(pollOi, 15_000);
    return () => { cancelled = true; if (timerId !== null) clearTimeout(timerId); };
  }, [symbol, selectedExpiries, exchange, daysBack]);

  // ── spot WebSocket ───────────────────────────────────────────────────────────
  useEffect(() => {
    const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
    const spotType = getSpotType(nubraInstruments, symbol);
    const subKey = `${exchange}:${symbol}:${spotType}`;
    if (!sessionToken || !symbol || !exchange || !spotHistoryReady || spotType !== 'INDEX') return;
    let destroyed = false;

    const sendSubs = () => {
      if (destroyed || !spotWsRef.current || spotWsRef.current.readyState !== WebSocket.OPEN) return;
      spotSubKeyRef.current = subKey;
      spotWsRef.current.send(JSON.stringify({ action: 'subscribe', session_token: sessionToken, data_type: 'index', symbols: [symbol], exchange }));
    };

    if (!spotWsRef.current || spotWsRef.current.readyState !== WebSocket.OPEN) {
      if (spotWsRef.current) spotWsRef.current.close();
      const ws = new WebSocket('ws://localhost:8765');
      spotWsRef.current = ws;
      ws.onopen = () => sendSubs();
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'connected') { sendSubs(); return; }
          if (msg.type !== 'index' || !msg.data) return;
          if (String(msg.data.indexname ?? '').toUpperCase() !== symbol.toUpperCase()) return;
          const value = Number(msg.data.index_value ?? 0) / 100;
          if (!Number.isFinite(value) || value <= 0) return;
          const tsMs = normalizeToMs(Number(msg.data.timestamp ?? 0)) || Date.now();
          const minuteTs = Math.floor(tsMs / 60000) * 60000;
          setSpotData(prev =>
            prev.length > 0 && prev[prev.length - 1].ts === minuteTs
              ? [...prev.slice(0, -1), { ts: minuteTs, value }]
              : [...prev, { ts: minuteTs, value }]
          );
        } catch { /* ignore */ }
      };
      ws.onerror = () => {};
      ws.onclose = () => { if (!destroyed) spotWsRef.current = null; };
    } else if (spotSubKeyRef.current !== subKey) {
      sendSubs();
    }
    return () => { destroyed = true; };
  }, [symbol, exchange, nubraInstruments, spotHistoryReady]);

  useEffect(() => () => {
    if (spotWsRef.current) { spotWsRef.current.close(); spotWsRef.current = null; spotSubKeyRef.current = ''; }
  }, []);

  // ── TOP chart setup (once) ───────────────────────────────────────────────────
  useEffect(() => {
    const host = hostTopRef.current;
    if (!host) return;

    const chart = createChart(host, makeChartOptions());

    const callSeries = chart.addSeries(LineSeries, {
      color: '#22c55e', lineWidth: 2, title: 'Total Call OI',
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110', crosshairMarkerBackgroundColor: '#22c55e',
    });
    const putSeries = chart.addSeries(LineSeries, {
      color: '#ef4444', lineWidth: 2, title: 'Total Put OI',
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110', crosshairMarkerBackgroundColor: '#ef4444',
    });
    const spotSeries = chart.addSeries(LineSeries, {
      color: '#93c5fd', lineWidth: 2, lineStyle: LineStyle.Dotted,
      title: 'Spot', priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: true, crosshairMarkerRadius: 3,
      crosshairMarkerBorderColor: '#131110', crosshairMarkerBackgroundColor: '#93c5fd',
      priceScaleId: 'left',
    });
    spotSeries.priceScale().applyOptions({ visible: true, borderColor: 'rgba(147,197,253,0.2)', scaleMargins: { top: 0.12, bottom: 0.08 } });

    chart.addPane();
    const spreadSeries = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: true, title: 'Spread', base: 0 }, 1);
    spreadSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 }, borderColor: 'rgba(255,255,255,0.08)' });

    chart.subscribeCrosshairMove(param => {
      const h = hostTopRef.current;
      if (!h || !param.point || !param.time) { setTopTooltip(t => t.visible ? { ...t, visible: false } : t); return; }
      const { x, y } = param.point;
      if (x < 0 || y < 0 || x > h.clientWidth || y > h.clientHeight) { setTopTooltip(t => t.visible ? { ...t, visible: false } : t); return; }
      const callVal = (param.seriesData.get(callSeries) as any)?.value ?? 0;
      const putVal  = (param.seriesData.get(putSeries)  as any)?.value ?? 0;
      const spotVal = (param.seriesData.get(spotSeries) as any)?.value ?? 0;
      const pcr = callVal > 0 ? putVal / callVal : 0;
      const tx = Math.max(8, Math.min(h.clientWidth - 180, x + 14));
      const ty = Math.max(8, Math.min(h.clientHeight - 90, y + 14));
      setTopTooltip({ visible: true, x: tx, y: ty, time: fmtTime(Number(param.time)), call: callVal, put: putVal, spot: spotVal, pcr });
    });

    chartTopRef.current   = chart;
    callSeriesRef.current = callSeries;
    putSeriesRef.current  = putSeries;
    spotTopRef.current    = spotSeries;
    spreadTopRef.current  = spreadSeries;

    return () => {
      chartTopRef.current?.remove();
      chartTopRef.current = callSeriesRef.current = putSeriesRef.current = spotTopRef.current = spreadTopRef.current = null;
    };
  }, []);

  // ── Derive data ───────────────────────────────────────────────────────────────
  const totalData = useMemo(() => aggregateOi(oiByExpiry), [oiByExpiry]);

  const activeTotalData = useMemo<OiPoint[]>(() => applyMode(totalData, mode), [totalData, mode]);

  const orderedChainValues = useMemo(
    () => [...selectedExpiries].sort().map(exp => buildNubraChainValue(symbol, exp)),
    [selectedExpiries, symbol]
  );

  // Per-expiry mode-adjusted data (for mini charts)
  // ── Push data to TOP chart ────────────────────────────────────────────────────
  useEffect(() => {
    const callData: LineData[]     = activeTotalData.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.call }));
    const putData:  LineData[]     = activeTotalData.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.put  }));
    const spotLine: LineData[]     = spotData.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.value }));
    const spreadData: HistogramData[] = activeTotalData.map(p => {
      const s = p.put - p.call;
      return { time: Math.floor(p.ts / 1000) as Time, value: s, color: s >= 0 ? 'rgba(34,197,94,0.65)' : 'rgba(239,68,68,0.65)' };
    });
    callSeriesRef.current?.setData(callData);
    putSeriesRef.current?.setData(putData);
    spotTopRef.current?.setData(spotLine);
    spreadTopRef.current?.setData(spreadData);
    if (!fittedTopRef.current && (callData.length || putData.length)) {
      chartTopRef.current?.timeScale().fitContent();
      fittedTopRef.current = true;
    }
  }, [activeTotalData, spotData]);

  // ── Derived display values ────────────────────────────────────────────────────
  const lastPt   = activeTotalData[activeTotalData.length - 1];
  const lastCall = lastPt?.call ?? 0;
  const lastPut  = lastPt?.put  ?? 0;
  const lastSpot = spotData[spotData.length - 1]?.value ?? 0;
  const pcr = mode === 'oi' && lastCall > 0 ? lastPut / lastCall : 0;
  const hasData = totalData.length > 0;

  // up to 3 mini charts
  const miniSlots = orderedChainValues.slice(0, 3);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#131110', color: '#e2e8f0', fontFamily: 'var(--font-family-sans, system-ui, sans-serif)' }}>

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginRight: 4 }}>OI by Expiry</span>

        <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 6, padding: '2px 3px' }}>
          {(['oi', 'chg'] as const).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)}
              style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: mode === m ? '#2563eb' : 'transparent', color: mode === m ? '#fff' : '#94a3b8' }}>
              {m === 'oi' ? 'OI' : 'OI Chg'}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 6, padding: '2px 3px' }}>
          {[0, 1, 2, 3, 5].map(n => (
            <button key={n} type="button" onClick={() => setDaysBack(n)}
              title={n === 0 ? 'Today only' : `Include previous ${n} trading day${n > 1 ? 's' : ''}`}
              style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: daysBack === n ? '#f59e0b' : 'transparent', color: daysBack === n ? '#0b1218' : '#94a3b8' }}>
              {n === 0 ? 'Today' : `${n}d`}
            </button>
          ))}
        </div>

        <select value={symbol} onChange={e => setSymbol(e.target.value)} style={selectStyle}>
          {symbols.map(s => <option key={s} value={s} style={{ background: '#1a1c20', color: '#e2e8f0' }}>{s}</option>)}
        </select>

        <div ref={expiryDropRef} style={{ position: 'relative' }}>
          <button type="button" disabled={!expiries.length} onClick={() => setExpiryDropOpen(v => !v)}
            style={{ ...selectStyle, display: 'flex', alignItems: 'center', gap: 4, minWidth: 120 }}>
            <span style={{ flex: 1, textAlign: 'left' }}>
              {selectedExpiries.size === 0 ? 'Expiry' : selectedExpiries.size === 1 ? expiryLabel([...selectedExpiries][0]) : `${selectedExpiries.size} expiries`}
            </span>
            <span style={{ fontSize: 9, color: '#64748b' }}>▼</span>
          </button>
          {expiryDropOpen && expiries.length > 0 && (
            <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 50, background: '#1c1a17', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '4px 0', minWidth: 150, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
              {expiries.map((ex, idx) => {
                const checked = selectedExpiries.has(ex);
                const color = EXPIRY_COLORS[idx % EXPIRY_COLORS.length];
                return (
                  <label key={ex} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 12, color: checked ? '#e2e8f0' : '#94a3b8', background: checked ? 'rgba(37,99,235,0.12)' : 'transparent' }}>
                    <input type="checkbox" checked={checked}
                      onChange={() => setSelectedExpiries(prev => {
                        const next = new Set(prev);
                        if (next.has(ex)) next.delete(ex); else next.add(ex);
                        return next;
                      })}
                      style={{ accentColor: color, width: 13, height: 13, cursor: 'pointer' }} />
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                    {expiryLabel(ex)}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 12, alignItems: 'center' }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>CE {fmtLakhs(lastCall)}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>PE {fmtLakhs(lastPut)}</span>
          {mode === 'oi' && pcr > 0 && <span style={{ color: '#94a3b8', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>PCR {pcr.toFixed(2)}</span>}
          {lastSpot > 0 && <span style={{ color: '#93c5fd', fontWeight: 600 }}>Spot {lastSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
          {lastUpdated && <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>{new Date(lastUpdated).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</span>}
        </div>
      </div>

      {error && (
        <div style={{ padding: '4px 12px', background: 'rgba(239,68,68,0.12)', color: '#fca5a5', fontSize: 11, borderBottom: '1px solid rgba(239,68,68,0.2)', flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* ── TOP: Total OI ── */}
      <div style={{ flex: '0 0 48%', minHeight: 0, position: 'relative', borderBottom: '2px solid rgba(255,255,255,0.08)' }}>
        <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 5, fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em', pointerEvents: 'none' }}>
          TOTAL OI — ALL SELECTED EXPIRIES
        </div>

        <div ref={hostTopRef} style={{ width: '100%', height: '100%' }} />
        <OiDonut call={lastCall} put={lastPut} mode={mode} top={22} left={18} scale={0.9} />

        <div style={{ position: 'absolute', bottom: 6, left: 8, zIndex: 5, display: 'flex', gap: 12, fontSize: 11, pointerEvents: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#cbd5e1' }}><span style={{ width: 16, height: 2, background: '#22c55e', display: 'inline-block', borderRadius: 999 }} /> Call OI</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#cbd5e1' }}><span style={{ width: 16, height: 2, background: '#ef4444', display: 'inline-block', borderRadius: 999 }} /> Put OI</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#cbd5e1' }}><span style={{ width: 16, borderTop: '2px dotted #93c5fd', display: 'inline-block' }} /> Spot</span>
        </div>

        {topTooltip.visible && (
          <div style={{ position: 'absolute', left: topTooltip.x, top: topTooltip.y, background: 'rgba(13,17,23,0.92)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', pointerEvents: 'none', zIndex: 10, fontSize: 12, minWidth: 160, backdropFilter: 'blur(6px)' }}>
            <div style={{ color: '#94a3b8', marginBottom: 6, fontWeight: 600 }}>{topTooltip.time}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 3 }}><span style={{ color: '#22c55e' }}>Call</span><b style={{ color: '#f1f5f9' }}>{fmtLakhs(topTooltip.call)}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 3 }}><span style={{ color: '#ef4444' }}>Put</span><b style={{ color: '#f1f5f9' }}>{fmtLakhs(topTooltip.put)}</b></div>
            {topTooltip.spot > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 3 }}><span style={{ color: '#93c5fd' }}>Spot</span><b style={{ color: '#f1f5f9' }}>{topTooltip.spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>}
            {topTooltip.pcr > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: '#f59e0b' }}>PCR</span><b style={{ color: '#f59e0b' }}>{topTooltip.pcr.toFixed(2)}</b></div>}
          </div>
        )}

        {!hasData && !error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 13, pointerEvents: 'none' }}>
            Loading OI data…
          </div>
        )}
      </div>

      {/* ── BOTTOM: 3 side-by-side mini charts ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
        {miniSlots.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.25)', fontSize: 13 }}>
            Select expiries to view individual breakdown
          </div>
        ) : (
          miniSlots.map((cv, idx) => {
            const expiryPart = cv.split('_').slice(1).join('_');
            const color = EXPIRY_COLORS[idx % EXPIRY_COLORS.length];
            return (
              <ExpiryMiniChart
                key={cv}
                nubraInstruments={nubraInstruments}
                allSymbols={symbols}
                color={color}
                mode={mode}
                daysBack={daysBack}
                defaultSymbol={symbol}
                defaultExpiry={expiryPart}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: '#1a1c20',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: 12,
  padding: '4px 8px',
  cursor: 'pointer',
  outline: 'none',
  colorScheme: 'dark',
};
