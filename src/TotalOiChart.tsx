'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function normalizeToMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  if (ts > 1e17) return Math.floor(ts / 1e9) * 1000;
  if (ts > 1e14) return Math.floor(ts / 1e6);
  if (ts > 1e12) return Math.floor(ts);
  if (ts > 1e9) return Math.floor(ts * 1000);
  return 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prevTradingDate(yyyyMmDd: string): string {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() - 1); }
  while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
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

function fmtChg(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  return `${sign}${abs.toLocaleString('en-IN')}`;
}

function fmtLakhs(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  return `${sign}${abs.toLocaleString('en-IN')}`;
}

function fmtTime(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function buildNubraChainValue(symbol: string, expiry: string): string {
  // expiry is YYYYMMDD → symbol_YYYYMMDD
  return `${symbol}_${expiry}`;
}

function getSpotType(instruments: NubraInstrument[], symbol: string): 'INDEX' | 'STOCK' {
  const found = instruments.find(i =>
    i.asset === symbol &&
    (i.option_type === 'CE' || i.option_type === 'PE')
  );
  return (found?.asset_type ?? '').toUpperCase() === 'INDEX_FO' ? 'INDEX' : 'STOCK';
}

// ── API fetch ─────────────────────────────────────────────────────────────────

async function fetchOiHistory(
  exchange: string,
  chainValues: string[],
  startDate: string,
  endDate: string,
): Promise<OiPoint[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken || !chainValues.length) return [];

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
    const err = new Error(`timeseries ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const totals = new Map<number, OiPoint>();

  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      for (const cv of chainValues) {
        const chainData = valObj?.[cv];
        if (!chainData) continue;
        const callArr: Array<{ ts: number; v: number }> = chainData.cumulative_call_oi ?? [];
        const putArr: Array<{ ts: number; v: number }> = chainData.cumulative_put_oi ?? [];
        for (const p of callArr) {
          const ts = Math.floor((p.ts ?? 0) / 1e9) * 1000;
          const row = totals.get(ts) ?? { ts, call: 0, put: 0 };
          row.call += p.v ?? 0;
          totals.set(ts, row);
        }
        for (const p of putArr) {
          const ts = Math.floor((p.ts ?? 0) / 1e9) * 1000;
          const row = totals.get(ts) ?? { ts, call: 0, put: 0 };
          row.put += p.v ?? 0;
          totals.set(ts, row);
        }
      }
    }
  }

  return [...totals.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchSpotHistory(
  exchange: string,
  symbol: string,
  spotType: 'INDEX' | 'STOCK',
  startDate: string,
  endDate: string,
): Promise<SpotPoint[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken = localStorage.getItem('nubra_auth_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? '';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken || !symbol) return [];

  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: sessionToken,
      auth_token: authToken,
      device_id: deviceId,
      raw_cookie: rawCookie,
      exchange,
      type: spotType,
      values: [symbol],
      fields: ['close'],
      startDate,
      endDate,
      interval: '1m',
      intraDay: false,
      realTime: false,
    }),
  });
  if (!res.ok) return [];

  const json = await res.json();
  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
  let chartObj: any = null;
  for (const dict of valuesArr) {
    for (const value of Object.values(dict ?? {})) {
      chartObj = value;
      break;
    }
    if (chartObj) break;
  }

  const series = chartObj?.close ?? [];
  if (!Array.isArray(series)) return [];

  const points = series
    .map((p: any) => ({
      ts: normalizeToMs(Number(p?.ts ?? p?.timestamp ?? 0)),
      value: Number(p?.v ?? p?.value ?? 0),
    }))
    .filter((p: SpotPoint) => p.ts > 0 && Number.isFinite(p.value) && p.value > 0);

  if (points.length === 0) return [];

  const sorted = [...points].map(p => p.value).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return mid > 200000
    ? points.map(p => ({ ts: p.ts, value: p.value / 100 }))
    : points;
}

// ── Instrument helpers ────────────────────────────────────────────────────────

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

// ── OI Donut ──────────────────────────────────────────────────────────────────

function OiDonut({ call, put, mode }: { call: number; put: number; mode: 'oi' | 'chg' }) {
  const absCall = Math.abs(call);
  const absPut  = Math.abs(put);
  const absTotal = absCall + absPut;
  if (absTotal <= 0) return null;

  const size = 100;
  const r = 36;
  const cx = size / 2;
  const cy = size / 2;

  const fmt = (v: number) => mode === 'chg' ? fmtChg(v) : fmtLakhs(v);
  const pcr = absCall > 0 ? absPut / absCall : 0;
  const centerLabel = pcr > 0 ? pcr.toFixed(2) : '—';
  const centerTop   = 'PCR';

  return (
    <div style={{
      position: 'absolute', top: 8, left: 8,
      pointerEvents: 'none', zIndex: 5,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      {/* Donut — left half = call (green), right half = put (red) */}
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size}>
          {/* track */}
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={16} />
          {/* left semicircle — call green (top → bottom going left, i.e. 270°→90° CCW = use clip) */}
          {/* We draw two fixed half-circles: left=green, right=red, scaled by fraction */}
          {/* Left arc: from top(-90°) counterclockwise to bottom(90°) — exactly left half */}
          <path
            d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r}`}
            fill="none" stroke="#22c55e" strokeWidth={16} strokeLinecap="butt"
            opacity={absCall / absTotal + 0.15}
          />
          {/* Right arc: from top(-90°) clockwise to bottom(90°) — exactly right half */}
          <path
            d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r}`}
            fill="none" stroke="#ef4444" strokeWidth={16} strokeLinecap="butt"
            opacity={absPut / absTotal + 0.15}
          />
          <text x={cx} y={cy - 7} textAnchor="middle" fontSize="9.5" fill="rgba(255,255,255,0.4)" letterSpacing="0.55">{centerTop}</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize="15" fontWeight="700" fill="#e2e8f0">{centerLabel}</text>
        </svg>
      </div>

      {/* Labels — side by side next to donut */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em' }}>CALL</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#22c55e' }}>{fmt(call)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em' }}>PUT</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444' }}>{fmt(put)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TotalOiChart({ nubraInstruments, initialSymbol = 'NIFTY' }: Props) {
  const symbols = useMemo(() => getSymbols(nubraInstruments), [nubraInstruments]);

  const [symbol, setSymbol] = useState(initialSymbol);
  const [selectedExpiries, setSelectedExpiries] = useState<Set<string>>(new Set());
  const [exchange, setExchange] = useState('NSE');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiryDropOpen, setExpiryDropOpen] = useState(false);
  const [data, setData] = useState<OiPoint[]>([]);
  const [spotData, setSpotData] = useState<SpotPoint[]>([]);
  const [mode, setMode] = useState<'oi' | 'chg'>('oi');
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [spotHistoryReady, setSpotHistoryReady] = useState(false);

  // crosshair tooltip state
  const [tooltip, setTooltip] = useState<{
    visible: boolean; x: number; y: number;
    time: string; call: number; put: number; spot: number; spread: number;
  }>({ visible: false, x: 0, y: 0, time: '', call: 0, put: 0, spot: 0, spread: 0 });

  const hostRef = useRef<HTMLDivElement | null>(null);
  const expiryDropRef = useRef<HTMLDivElement | null>(null);

  // close expiry dropdown on outside click
  useEffect(() => {
    if (!expiryDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (expiryDropRef.current && !expiryDropRef.current.contains(e.target as Node)) {
        setExpiryDropOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expiryDropOpen]);
  const chartRef = useRef<IChartApi | null>(null);
  const callSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const putSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const spotSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const spreadSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const fittedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spotWsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  const dataRef = useRef<OiPoint[]>([]);
  const spotDataRef = useRef<SpotPoint[]>([]);
  const backoffRef = useRef(0);
  const spotSubKeyRef = useRef('');

  // keep dataRef in sync for use inside poll closure
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { spotDataRef.current = spotData; }, [spotData]);

  // ── Derive expiries when symbol changes ───────────────────────────────────
  useEffect(() => {
    if (!nubraInstruments.length) return;
    const { exchange: ex, expiries: exps } = getExpiryInfo(nubraInstruments, symbol);
    setExchange(ex);
    setExpiries(exps);
    // auto-select first expiry
    setSelectedExpiries(new Set(exps.slice(0, 1)));
    setData([]);
    setSpotData([]);
    setSpotHistoryReady(false);
    setError('');
  }, [symbol, nubraInstruments]);

  // ── Poll loop ─────────────────────────────────────────────────────────────
  const stopPoll = useCallback(() => {
    cancelledRef.current = true;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  useEffect(() => {
    if (!symbol || !selectedExpiries.size || !exchange) return;
    cancelledRef.current = false;
    backoffRef.current = 0;
    fittedRef.current = false;
    setData([]);
    setSpotData([]);
    setSpotHistoryReady(false);
    setError('');

    const chainValues = [...selectedExpiries].map(exp => buildNubraChainValue(symbol, exp));

    const poll = async () => {
      if (cancelledRef.current) return;
      const tradingDate = resolveIntradayTradingDate();
      const startDate = istToUtcIso(tradingDate, '09:15');
      const endDate = new Date().toISOString();

      try {
        const spotType = getSpotType(nubraInstruments, symbol);
        const [pts, spotPts] = await Promise.all([
          fetchOiHistory(exchange, chainValues, startDate, endDate),
          fetchSpotHistory(exchange, symbol, spotType, startDate, endDate),
        ]);
        if (cancelledRef.current) return;
        backoffRef.current = 0; // reset on success
        if (pts.length > 0) {
          setData(pts);
        }
        setSpotData(spotPts);
        setSpotHistoryReady(spotPts.length > 0);
        setLastUpdated(Date.now());
        setError('');
      } catch (e: any) {
        if (cancelledRef.current) return;
        if (e?.status === 403 || e?.status === 429) {
          // exponential backoff: 30s → 60s → 120s, cap at 120s
          backoffRef.current = Math.min((backoffRef.current || 30_000) * 2, 120_000);
        } else {
          setError(`Error ${e?.status ?? ''}: ${e?.message ?? 'fetch failed'}`);
        }
      }

      if (!cancelledRef.current) {
        const base = isMarketOpen() ? 15_000 : 60_000;
        timerRef.current = setTimeout(poll, base + backoffRef.current);
      }
    };

    poll();
    return stopPoll;
  }, [symbol, selectedExpiries, exchange, stopPoll, nubraInstruments]);

  useEffect(() => {
    const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
    const spotType = getSpotType(nubraInstruments, symbol);
    const subKey = `${exchange}:${symbol}:${spotType}`;
    if (!sessionToken || !symbol || !exchange || !spotHistoryReady || spotType !== 'INDEX') return;

    let destroyed = false;

    const sendSubs = () => {
      if (destroyed || !spotWsRef.current || spotWsRef.current.readyState !== WebSocket.OPEN) return;
      spotSubKeyRef.current = subKey;
      spotWsRef.current.send(JSON.stringify({
        action: 'subscribe',
        session_token: sessionToken,
        data_type: 'index',
        symbols: [symbol],
        exchange,
      }));
    };

    if (!spotWsRef.current || spotWsRef.current.readyState !== WebSocket.OPEN) {
      if (spotWsRef.current) spotWsRef.current.close();
      const ws = new WebSocket('ws://localhost:8765');
      spotWsRef.current = ws;

      ws.onopen = () => { sendSubs(); };
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'connected') {
            sendSubs();
            return;
          }
          if (msg.type !== 'index' || !msg.data) return;
          const incoming = String(msg.data.indexname ?? '').toUpperCase();
          if (incoming !== symbol.toUpperCase()) return;
          const raw = Number(msg.data.index_value ?? 0);
          const value = raw / 100;
          if (!Number.isFinite(value) || value <= 0) return;
          const rawTs = Number(msg.data.timestamp ?? 0);
          const tsMs = normalizeToMs(rawTs) || Date.now();
          const minuteTs = Math.floor(tsMs / 60000) * 60000;
          setSpotData(prev => {
            if (prev.length > 0 && prev[prev.length - 1].ts === minuteTs) {
              return [...prev.slice(0, -1), { ts: minuteTs, value }];
            }
            return [...prev, { ts: minuteTs, value }];
          });
        } catch {
          // ignore malformed frames
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (!destroyed) spotWsRef.current = null;
      };
    } else if (spotSubKeyRef.current !== subKey) {
      sendSubs();
    }

    return () => {
      destroyed = true;
    };
  }, [symbol, exchange, nubraInstruments, spotHistoryReady]);

  useEffect(() => () => {
    if (spotWsRef.current) {
      spotWsRef.current.close();
      spotWsRef.current = null;
      spotSubKeyRef.current = '';
    }
  }, []);

  // ── Chart setup (once) ────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { color: '#131110' },
        textColor: '#a09080',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: {
        visible: true,
        borderColor: 'rgba(255,255,255,0.1)',
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      leftPriceScale: { visible: false },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.1)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (t: Time) =>
          new Date(Number(t) * 1000).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit', minute: '2-digit', hour12: true,
          }),
      },
      localization: {
        timeFormatter: (t: Time) =>
          new Date(Number(t) * 1000).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit', minute: '2-digit', hour12: true,
          }),
        priceFormatter: (p: number) => fmtLakhs(p),
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.3)', width: 1, style: 2, labelVisible: true },
        horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: 2, labelVisible: true },
      },
      handleScroll: true,
      handleScale: true,
    });

    const callSeries = chart.addSeries(LineSeries, {
      color: '#22c55e',
      lineWidth: 2,
      title: 'Call OI',
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110',
      crosshairMarkerBackgroundColor: '#22c55e',
    });

    const putSeries = chart.addSeries(LineSeries, {
      color: '#ef4444',
      lineWidth: 2,
      title: 'Put OI',
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110',
      crosshairMarkerBackgroundColor: '#ef4444',
    });

    const spotSeries = chart.addSeries(LineSeries, {
      color: '#93c5fd',
      lineWidth: 2,
      lineStyle: LineStyle.Dotted,
      title: 'Spot',
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      crosshairMarkerBorderColor: '#131110',
      crosshairMarkerBackgroundColor: '#93c5fd',
      priceScaleId: 'left',
    });
    spotSeries.priceScale().applyOptions({
      visible: true,
      borderColor: 'rgba(147,197,253,0.2)',
      scaleMargins: { top: 0.12, bottom: 0.08 },
    });

    chart.subscribeCrosshairMove(param => {
      const host = hostRef.current;
      if (!host || !param.point || !param.time) {
        setTooltip(t => t.visible ? { ...t, visible: false } : t);
        return;
      }
      const { x, y } = param.point;
      if (x < 0 || y < 0 || x > host.clientWidth || y > host.clientHeight) {
        setTooltip(t => t.visible ? { ...t, visible: false } : t);
        return;
      }
      const callVal   = callSeries   ? (param.seriesData.get(callSeries)   as any)?.value ?? 0 : 0;
      const putVal    = putSeries    ? (param.seriesData.get(putSeries)    as any)?.value ?? 0 : 0;
      const spotVal   = spotSeries   ? (param.seriesData.get(spotSeries)   as any)?.value ?? 0 : 0;
      const spreadVal = (Number.isFinite(putVal) && Number.isFinite(callVal)) ? putVal - callVal : 0;
      const tx = Math.max(8, Math.min(host.clientWidth - 200, x + 14));
      const ty = Math.max(8, Math.min(host.clientHeight - 100, y + 14));
      setTooltip({
        visible: true,
        x: tx, y: ty,
        time: fmtTime(Number(param.time)),
        call: callVal,
        put: putVal,
        spot: spotVal,
        spread: spreadVal,
      });
    });

    // ── Pane 1: OI Spread (Put − Call) histogram ─────────────────────────────
    chart.addPane(); // pane index 1
    const spreadSeries = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'Spread',
      base: 0,
    }, 1);
    spreadSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.1 },
      borderColor: 'rgba(255,255,255,0.08)',
    });

    chartRef.current = chart;
    callSeriesRef.current = callSeries;
    putSeriesRef.current = putSeries;
    spotSeriesRef.current = spotSeries;
    spreadSeriesRef.current = spreadSeries;

    return () => {
      chartRef.current?.remove();
      chartRef.current = null;
      callSeriesRef.current = null;
      putSeriesRef.current = null;
      spotSeriesRef.current = null;
      spreadSeriesRef.current = null;
    };
  }, []);

  // ── Derive OI change series — subtract first (9:15) point as base ────────
  const activeData = useMemo<OiPoint[]>(() => {
    if (!data.length) return [];
    if (mode === 'oi') return data;
    const base = data[0];
    return data.map(p => ({
      ts:   p.ts,
      call: p.call - base.call,
      put:  p.put  - base.put,
    }));
  }, [data, mode]);

  // ── Push data to chart whenever activeData / mode changes ─────────────────
  useEffect(() => {
    const callData: LineData[] = activeData.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.call }));
    const putData: LineData[]  = activeData.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.put  }));
    const spotLineData: LineData[] = spotData.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.value }));
    const spreadData: HistogramData[] = activeData.map(p => {
      const spread = p.put - p.call;
      return {
        time: Math.floor(p.ts / 1000) as Time,
        value: spread,
        color: spread >= 0 ? 'rgba(34,197,94,0.65)' : 'rgba(239,68,68,0.65)',
      };
    });
    callSeriesRef.current?.setData(callData);
    putSeriesRef.current?.setData(putData);
    spotSeriesRef.current?.setData(spotLineData);
    spreadSeriesRef.current?.setData(spreadData);
    if (!fittedRef.current && (callData.length || putData.length || spotLineData.length)) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [activeData, spotData]);

  // ── Derived display values (last point) ──────────────────────────────────
  const lastPt   = activeData[activeData.length - 1];
  const lastCall = lastPt?.call ?? 0;
  const lastPut  = lastPt?.put  ?? 0;
  const lastSpot = spotData[spotData.length - 1]?.value ?? 0;
  const pcr = mode === 'oi' && lastCall > 0 ? lastPut / lastCall : 0;

  // Expiry display label
  const expiryLabel = (exp: string) => {
    if (!exp || exp.length !== 8) return exp;
    const d = new Date(`${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}T00:00:00Z`);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#131110', color: '#e2e8f0', fontFamily: 'var(--font-family-sans, system-ui, sans-serif)' }}>

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginRight: 4 }}>
          {mode === 'oi' ? 'Total OI' : 'OI Change'}
        </span>

        {/* OI / OI Chg toggle */}
        <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 6, padding: '2px 3px' }}>
          <button type="button" onClick={() => setMode('oi')}
            style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: mode === 'oi' ? '#2563eb' : 'transparent', color: mode === 'oi' ? '#fff' : '#94a3b8' }}>
            OI
          </button>
          <button type="button" onClick={() => setMode('chg')}
            style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: mode === 'chg' ? '#2563eb' : 'transparent', color: mode === 'chg' ? '#fff' : '#94a3b8' }}>
            OI Chg
          </button>
        </div>

        {/* Symbol picker */}
        <select
          value={symbol}
          onChange={e => setSymbol(e.target.value)}
          style={selectStyle}
        >
          {symbols.map(s => <option key={s} value={s} style={{ background: '#1a1c20', color: '#e2e8f0' }}>{s}</option>)}
        </select>

        {/* Expiry multi-select dropdown */}
        <div ref={expiryDropRef} style={{ position: 'relative' }}>
          <button
            type="button"
            disabled={!expiries.length}
            onClick={() => setExpiryDropOpen(v => !v)}
            style={{
              ...selectStyle,
              display: 'flex', alignItems: 'center', gap: 4,
              minWidth: 120,
            }}
          >
            <span style={{ flex: 1, textAlign: 'left' }}>
              {selectedExpiries.size === 0
                ? 'Expiry'
                : selectedExpiries.size === 1
                  ? expiryLabel([...selectedExpiries][0])
                  : `${selectedExpiries.size} expiries`}
            </span>
            <span style={{ fontSize: 9, color: '#64748b' }}>▼</span>
          </button>
          {expiryDropOpen && expiries.length > 0 && (
            <div style={{
              position: 'absolute', top: '110%', left: 0, zIndex: 50,
              background: '#1c1a17', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8, padding: '4px 0', minWidth: 150,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}>
              {expiries.map(ex => {
                const checked = selectedExpiries.has(ex);
                return (
                  <label key={ex} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 12px', cursor: 'pointer', fontSize: 12,
                    color: checked ? '#e2e8f0' : '#94a3b8',
                    background: checked ? 'rgba(37,99,235,0.15)' : 'transparent',
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelectedExpiries(prev => {
                          const next = new Set(prev);
                          if (next.has(ex)) next.delete(ex);
                          else next.add(ex);
                          return next;
                        });
                      }}
                      style={{ accentColor: '#2563eb', width: 13, height: 13, cursor: 'pointer' }}
                    />
                    {expiryLabel(ex)}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 12, marginLeft: 8, fontSize: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 20, height: 2, background: '#22c55e', display: 'inline-block', borderRadius: 1 }} />
            Call
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 20, height: 2, background: '#ef4444', display: 'inline-block', borderRadius: 1 }} />
            Put
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 20, borderTop: '2px dotted #93c5fd', display: 'inline-block' }} />
            Spot
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, background: 'rgba(34,197,94,0.35)', border: '1px solid #22c55e', display: 'inline-block', borderRadius: 2 }} />
            <span style={{ width: 10, height: 10, background: 'rgba(239,68,68,0.35)', border: '1px solid #ef4444', display: 'inline-block', borderRadius: 2 }} />
            Spread
          </span>
        </div>

        {/* PCR + last values */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 12, alignItems: 'center' }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>
            CE {mode === 'chg' ? fmtChg(lastCall) : fmtLakhs(lastCall)}
          </span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>
            PE {mode === 'chg' ? fmtChg(lastPut) : fmtLakhs(lastPut)}
          </span>
          {mode === 'oi' && pcr > 0 && (
            <span style={{ color: '#94a3b8', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              PCR {pcr.toFixed(2)}
            </span>
          )}
          {lastSpot > 0 && (
            <span style={{ color: '#93c5fd', fontWeight: 600 }}>
              Spot {lastSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
          {lastUpdated && (
            <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>
              {new Date(lastUpdated).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </span>
          )}
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div style={{ padding: '4px 12px', background: 'rgba(239,68,68,0.12)', color: '#22c55e', fontSize: 11, borderBottom: '1px solid rgba(239,68,68,0.2)', flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* ── Chart area ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />

        {/* ── OI Donut card (top-left overlay) ── */}
        {activeData.length > 0 && (Math.abs(lastCall) + Math.abs(lastPut) > 0) && (
          <OiDonut call={lastCall} put={lastPut} mode={mode} />
        )}

        {/* Crosshair tooltip */}
        {tooltip.visible && (
          <div style={{
            position: 'absolute', left: tooltip.x, top: tooltip.y,
            background: 'rgba(13,17,23,0.92)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8, padding: '8px 12px', pointerEvents: 'none', zIndex: 10,
            fontSize: 12, minWidth: 160,
            backdropFilter: 'blur(6px)',
          }}>
            <div style={{ color: '#94a3b8', marginBottom: 6, fontWeight: 600 }}>{tooltip.time}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 3 }}>
              <span style={{ color: '#22c55e' }}>Call</span>
              <b style={{ color: '#f1f5f9' }}>{mode === 'chg' ? fmtChg(tooltip.call) : fmtLakhs(tooltip.call)}</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <span style={{ color: '#ef4444' }}>Put</span>
              <b style={{ color: '#f1f5f9' }}>{mode === 'chg' ? fmtChg(tooltip.put) : fmtLakhs(tooltip.put)}</b>
            </div>
            {tooltip.spot > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 3 }}>
                <span style={{ color: '#93c5fd' }}>Spot</span>
                <b style={{ color: '#f1f5f9' }}>{tooltip.spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 3, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 4 }}>
              <span style={{ color: tooltip.spread >= 0 ? '#22c55e' : '#ef4444' }}>Spread</span>
              <b style={{ color: tooltip.spread >= 0 ? '#22c55e' : '#ef4444' }}>{mode === 'chg' ? fmtChg(tooltip.spread) : fmtLakhs(tooltip.spread)}</b>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!data.length && !error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 13, pointerEvents: 'none' }}>
            Loading OI data…
          </div>
        )}
      </div>

      {/* ── Y-axis label ── */}
      <div style={{ padding: '4px 12px', fontSize: 10, color: 'rgba(255,255,255,0.3)', textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        Open Interest (in Lakhs)
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
