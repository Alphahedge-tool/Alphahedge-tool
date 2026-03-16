'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
} from 'lightweight-charts';
import { useNubraInstruments, type NubraInstrument, type NubraLoadStatus } from './useNubraInstruments';
import { Button, DatePicker, Spin } from 'antd';
import dayjs from 'dayjs';
import s from './Backtest.module.css';

type Tab = 'ALL' | 'STOCK' | 'INDEX' | 'IDX OPT' | 'IDX FUT' | 'EQ OPT' | 'EQ FUT' | 'NSE' | 'BSE';
const TABS: Tab[] = ['ALL', 'STOCK', 'INDEX', 'IDX OPT', 'IDX FUT', 'EQ OPT', 'EQ FUT', 'NSE', 'BSE'];

const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '1d', '1w', '1mt'] as const;
type IntervalType = typeof INTERVALS[number];

// Map interval string → seconds (for bar boundary snapping)
const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '1d': 86400,
};
const IST_OFFSET_SEC = 19800; // UTC+5:30

// Snap a UTC epoch-seconds timestamp to the current bar boundary (IST-aligned)
function snapToBar(nowSec: number, intervalSec: number): number {
  return Math.floor((nowSec + IST_OFFSET_SEC) / intervalSec) * intervalSec - IST_OFFSET_SEC;
}

// Intraday intervals that support live WS streaming
const LIVE_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h']);

// Return the most recent trading day (Mon–Fri) as YYYY-MM-DD, skipping weekends
function lastTradingDay(from: Date = new Date()): string {
  const d = new Date(from);
  const day = d.getDay(); // 0=Sun, 6=Sat
  if (day === 0) d.setDate(d.getDate() - 2); // Sun → Fri
  else if (day === 6) d.setDate(d.getDate() - 1); // Sat → Fri
  return d.toISOString().slice(0, 10);
}


function filterByTab(instruments: NubraInstrument[], tab: Tab): NubraInstrument[] {
  if (tab === 'ALL') return instruments;
  if (tab === 'STOCK') return instruments.filter(i => i.derivative_type === 'STOCK' && i.asset_type === 'STOCKS');
  if (tab === 'INDEX') return instruments.filter(i => i.derivative_type === 'INDEX' && i.asset_type === 'INDEX');
  if (tab === 'IDX OPT') return instruments.filter(i => i.asset_type === 'INDEX_FO' && i.derivative_type === 'OPT');
  if (tab === 'IDX FUT') return instruments.filter(i => i.asset_type === 'INDEX_FO' && i.derivative_type === 'FUT');
  if (tab === 'EQ OPT') return instruments.filter(i => i.asset_type === 'STOCK_FO' && i.derivative_type === 'OPT');
  if (tab === 'EQ FUT') return instruments.filter(i => i.asset_type === 'STOCK_FO' && i.derivative_type === 'FUT');
  if (tab === 'NSE') return instruments.filter(i => i.exchange === 'NSE');
  if (tab === 'BSE') return instruments.filter(i => i.exchange === 'BSE');
  return instruments;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className={s.highlight}>{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

function formatExpiry(expiry: string | null): string {
  if (!expiry) return '—';
  if (expiry.length === 8) {
    const y = expiry.slice(2, 4);
    const m = parseInt(expiry.slice(4, 6)) - 1;
    const d = expiry.slice(6, 8);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d} ${months[m]} ${y}`;
  }
  return expiry;
}

function StatusBadge({ status }: { status: NubraLoadStatus }) {
  if (status.phase === 'idle') return <span className={s.statusIdle}>Not loaded</span>;
  if (status.phase === 'checking') return <span className={s.statusChecking}>Checking cache...</span>;
  if (status.phase === 'fetching') return <span className={s.statusFetching}>Fetching from Nubra...</span>;
  if (status.phase === 'parsing') return <span className={s.statusParsing}>Parsing...</span>;
  if (status.phase === 'storing') return <span className={s.statusStoring}>Caching...</span>;
  if (status.phase === 'cache-hit') return <span className={s.statusCacheHit}>{status.total.toLocaleString()} instruments (cached)</span>;
  if (status.phase === 'ready') return <span className={s.statusReady}>{status.total.toLocaleString()} instruments</span>;
  if (status.phase === 'error') return <span className={s.statusError}>{status.message}</span>;
  return null;
}

// Determine which Nubra API type to use from the selected instrument
function getNubraType(ins: NubraInstrument): string {
  const dt = ins.derivative_type?.toUpperCase() ?? '';
  if (dt === 'OPT') return 'OPT';
  if (dt === 'FUT') return 'FUT';
  if (dt === 'INDEX') return 'INDEX';
  return 'STOCK';
}

// Determine which fields to request based on instrument type
function getFieldsForType(type: string): string[] {
  const base = ['open', 'high', 'low', 'close', 'cumulative_volume'];
  if (type === 'OPT') {
    return [...base, 'theta', 'delta', 'gamma', 'vega', 'iv_mid', 'cumulative_oi'];
  }
  if (type === 'FUT' || type === 'STOCK') {
    return [...base, 'cumulative_oi'];
  }
  // INDEX — only OHLCV, no greeks, no OI, no l1bid/l1ask
  return base;
}

// Get symbol name for the API values param
function getSymbolName(ins: NubraInstrument): string {
  return ins.stock_name || ins.nubra_name || ins.asset;
}

// Convert nubra timestamp (nanoseconds) to lightweight-charts Time (UTC seconds)
// Note: ns values exceed Number.MAX_SAFE_INTEGER, so we divide first to stay in safe range
function nsToTime(ns: number): Time {
  // The raw ns may have lost precision as a JS number.
  // Nubra timestamps are always whole seconds * 1e9, so dividing gives a clean integer.
  // We round to ensure we get an exact second value despite float imprecision.
  return Math.round(ns / 1e9) as unknown as Time;
}

// Nubra returns prices in paise (x100), divide by 100 for all types
function maybeConvertPrice(val: number, _type: string): number {
  return val / 100;
}

const CHART_BG = 'transparent';
const CHART_OPTIONS = {
  autoSize: true,
  layout: {
    background: { color: CHART_BG },
    textColor: '#B2B5BE',
    panes: {
      separatorColor: 'rgba(255,255,255,0.08)',
      separatorHoverColor: 'rgba(255,255,255,0.18)',
      enableResize: true,
    },
  },
  grid: {
    vertLines: { color: '#2A2E39' },
    horzLines: { color: '#2A2E39' },
  },
  crosshair: { mode: 0 as const },
  rightPriceScale: { borderColor: '#2A2E39' },
  localization: {
    timeFormatter: (ts: number) =>
      new Date(ts * 1000).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }),
  },
  timeScale: {
    borderColor: '#2A2E39',
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 5,
    tickMarkFormatter: (ts: number) => {
      const d = new Date(ts * 1000);
      return d.toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
      });
    },
  },
};

type HistoricalData = {
  candles: CandlestickData[];
  volume: HistogramData[];
  greeks?: {
    theta?: LineData[];
    delta?: LineData[];
    gamma?: LineData[];
    vega?: LineData[];
    iv_mid?: LineData[];
  };
  oi?: LineData[];
};

async function fetchHistoricalData(
  ins: NubraInstrument,
  startDate: string,
  endDate: string,
  interval: IntervalType,
  intraDay: boolean,
): Promise<HistoricalData> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken = localStorage.getItem('nubra_auth_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? '';
  const type = getNubraType(ins);
  const fields = getFieldsForType(type);
  const symbol = getSymbolName(ins);

  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: sessionToken,
      auth_token: authToken,
      device_id: deviceId,
      exchange: (ins.asset_type === 'INDEX' || ins.asset_type === 'INDEX_FO') ? (ins.exchange || 'NSE') : 'NSE',
      type,
      values: [symbol],
      fields,
      startDate: intraDay ? '' : startDate,
      endDate: intraDay ? '' : endDate,
      interval,
      intraDay,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try { const err = JSON.parse(text); errMsg = err.error ?? err.message ?? errMsg; } catch {}
    throw new Error(errMsg);
  }

  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`); }
  const resultArr = json.result ?? [];
  if (resultArr.length === 0) throw new Error(json.message ?? 'No data returned');

  // Parse response: result[0].values[0][symbol] → StockChart
  const valuesArr = resultArr[0]?.values ?? [];
  let stockChart: any = null;
  for (const dict of valuesArr) {
    for (const [, v] of Object.entries(dict)) {
      stockChart = v;
      break;
    }
    if (stockChart) break;
  }
  if (!stockChart) throw new Error('No chart data found in response');

  // Build candles from separate OHLC arrays
  const openArr: any[] = stockChart.open ?? [];
  const highArr: any[] = stockChart.high ?? [];
  const lowArr: any[] = stockChart.low ?? [];
  const closeArr: any[] = stockChart.close ?? [];
  const volArr: any[] = stockChart.cumulative_volume ?? [];

  const candles: CandlestickData[] = [];
  const volume: HistogramData[] = [];

  // REST API uses { ts, v } — SDK uses { timestamp, value }. Handle both.
  const getTs = (p: any): number => p?.ts ?? p?.timestamp ?? 0;
  const getVal = (p: any): number => p?.v ?? p?.value ?? 0;

  // Use the longest OHLC array as reference (API may not return all fields)
  const refArr = [openArr, highArr, lowArr, closeArr].reduce((a, b) => a.length >= b.length ? a : b);
  const len = refArr.length;

  for (let i = 0; i < len; i++) {
    const ts = getTs(openArr[i]) || getTs(highArr[i]) || getTs(lowArr[i]) || getTs(closeArr[i]);
    if (!ts) continue;
    const time = nsToTime(ts);
    const c = maybeConvertPrice(getVal(closeArr[i]) || getVal(openArr[i]) || 0, type);
    const o = maybeConvertPrice(getVal(openArr[i]) || c, type);
    const h = maybeConvertPrice(getVal(highArr[i]) || Math.max(o, c), type);
    const l = maybeConvertPrice(getVal(lowArr[i]) || Math.min(o, c), type);
    candles.push({ time, open: o, high: h, low: l, close: c });
    if (volArr[i]) {
      volume.push({
        time,
        value: getVal(volArr[i]),
        color: c >= o ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)',
      });
    }
  }

  // TradingView requires data sorted by time ascending with no duplicates
  candles.sort((a, b) => (a.time as number) - (b.time as number));
  volume.sort((a, b) => (a.time as number) - (b.time as number));

  // Deduplicate by time (keep last)
  const dedup = <T extends { time: Time }>(arr: T[]): T[] => {
    const map = new Map<number, T>();
    for (const item of arr) map.set(item.time as number, item);
    return [...map.values()].sort((a, b) => (a.time as number) - (b.time as number));
  };
  const dedupCandles = dedup(candles);
  const dedupVolume = dedup(volume);

  const result: HistoricalData = { candles: dedupCandles, volume: dedupVolume };

  // Greeks (only for OPT)
  if (type === 'OPT') {
    const toLine = (arr: any[]): LineData[] =>
      dedup(arr.map(p => ({ time: nsToTime(getTs(p)), value: getVal(p) })));
    const toLineIv = (arr: any[]): LineData[] =>
      dedup(arr.map(p => ({ time: nsToTime(getTs(p)), value: getVal(p) * 100 })));
    result.greeks = {};
    if (stockChart.theta?.length) result.greeks.theta = toLine(stockChart.theta);
    if (stockChart.delta?.length) result.greeks.delta = toLine(stockChart.delta);
    if (stockChart.gamma?.length) result.greeks.gamma = toLine(stockChart.gamma);
    if (stockChart.vega?.length) result.greeks.vega = toLine(stockChart.vega);
    if (stockChart.iv_mid?.length) result.greeks.iv_mid = toLineIv(stockChart.iv_mid);
  }

  // OI (for OPT, FUT, STOCK — not INDEX)
  if (type !== 'INDEX' && stockChart.cumulative_oi?.length) {
    result.oi = dedup(stockChart.cumulative_oi.map((p: any) => ({
      time: nsToTime(getTs(p)),
      value: getVal(p),
    })));
  }

  return result;
}

export default function Backtest() {
  const { instruments, indexes, status, load } = useNubraInstruments();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NubraInstrument[]>([]);
  const [tab, setTab] = useState<Tab>('ALL');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selected, setSelected] = useState<NubraInstrument | null>(null);

  // Chart controls — default to last trading day, 1m intraday
  const lastTrading = lastTradingDay();
  const [entryDate, setEntryDate] = useState(lastTrading);
  const [exitDate, setExitDate] = useState(lastTrading);
  const [interval, setInterval] = useState<IntervalType>('1m');
  const [intraDay, setIntraDay] = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState('');

  const workerRef = useRef<Worker | null>(null);
  const workerReady = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Chart refs — single chart with multiple panes
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const oiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Per-greek panes inside the single chart
  const GREEK_KEYS = ['delta', 'theta', 'gamma', 'vega', 'iv_mid'] as const;
  type GreekKey = typeof GREEK_KEYS[number];
  const GREEK_COLORS: Record<GreekKey, string> = {
    delta: '#60a5fa', theta: '#f59e0b', gamma: '#a78bfa', vega: '#34d399', iv_mid: '#f472b6',
  };
  const [activeGreeks, setActiveGreeks] = useState<Set<GreekKey>>(new Set(['delta', 'iv_mid']));
  const greekSeriesRefs = useRef<Partial<Record<GreekKey, ISeriesApi<'Line'>>>>({});

  // Live WS bridge (nubra_ws_bridge.py on port 8765)
  const liveWsRef = useRef<WebSocket | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);

  const selectedType = selected ? getNubraType(selected) : null;
  const showGreeks = selectedType === 'OPT';
  const showOI = selectedType === 'OPT' || selectedType === 'FUT' || selectedType === 'STOCK';

  // Load instruments on mount
  useEffect(() => {
    const session = localStorage.getItem('nubra_session_token');
    if (session) load();
  }, [load]);

  // Boot search worker
  useEffect(() => {
    const worker = new Worker(new URL('./nubraSearch.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'READY') workerReady.current = true;
      if (e.data.type === 'RESULTS') {
        setResults(e.data.results);
        setShowDropdown(true);
      }
    };
    return () => worker.terminate();
  }, []);

  // Memoize index→instrument conversion
  const indexAsInstruments = useMemo<NubraInstrument[]>(() => {
    if (indexes.length === 0) return [];
    return indexes.map(idx => ({
      ref_id: '',
      stock_name: idx.INDEX_SYMBOL || idx.index_symbol || '',
      nubra_name: idx.ZANSKAR_INDEX_SYMBOL || idx.zanskar_index_symbol || '',
      strike_price: null,
      option_type: 'N/A',
      token: '',
      lot_size: 0,
      tick_size: 0,
      asset: idx.INDEX_NAME || idx.index_name || '',
      expiry: null,
      exchange: idx.EXCHANGE || idx.exchange || '',
      derivative_type: 'INDEX',
      isin: '',
      asset_type: 'INDEX',
    }));
  }, [indexes]);

  // Feed instruments + indexes to worker
  useEffect(() => {
    if ((status.phase === 'ready' || status.phase === 'cache-hit') && instruments.length > 0 && workerRef.current) {
      workerRef.current.postMessage({ type: 'LOAD', payload: [...instruments, ...indexAsInstruments] });
    }
  }, [status.phase, instruments, indexAsInstruments]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        !inputRef.current?.contains(e.target as Node) &&
        !dropdownRef.current?.contains(e.target as Node)
      ) setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Init main chart — depends on `selected` because the container is conditionally rendered
  useEffect(() => {
    if (!selected || !chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      ...CHART_OPTIONS,
      leftPriceScale: {
        visible: showOI,
        borderColor: '#2A2E39',
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#f87171',
      borderUpColor: '#34d399',
      borderDownColor: '#f87171',
      wickUpColor: '#34d39980',
      wickDownColor: '#f8717180',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    candleSeriesRef.current = candleSeries;

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    // OI on left axis (for STOCK/FUT/OPT, not INDEX)
    if (showOI) {
      const oiSeries = chart.addSeries(LineSeries, {
        color: '#fbbf24',
        lineWidth: 1,
        title: 'OI',
        priceScaleId: 'left',
        priceFormat: { type: 'volume' },
      });
      chart.priceScale('left').applyOptions({
        scaleMargins: { top: 0.1, bottom: 0.2 },
      });
      oiSeriesRef.current = oiSeries;
    }

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      oiSeriesRef.current = null;
      // Clear greek series refs so the pane effect re-adds them on the new chart
      greekSeriesRefs.current = {};
    };
  }, [selected, showOI]);

  // Add/remove greek panes inside the single chart whenever active set changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !showGreeks) return;
    const activeKeys = GREEK_KEYS.filter(k => activeGreeks.has(k));
    // pane 0 = candles/volume/OI (always), panes 1..N = greeks in order
    activeKeys.forEach((key, i) => {
      const paneIndex = i + 1;
      const isIv = key === 'iv_mid';
      if (!greekSeriesRefs.current[key]) {
        const series = chart.addSeries(LineSeries, {
          color: GREEK_COLORS[key],
          lineWidth: 1,
          title: key === 'iv_mid' ? 'IV' : key.toUpperCase(),
          priceScaleId: 'right',
          priceFormat: isIv
            ? { type: 'percent' as const, precision: 2, minMove: 0.01 }
            : { type: 'price' as const, precision: 4, minMove: 0.0001 },
        }, paneIndex);
        try { chart.panes()[paneIndex]?.setHeight(120); } catch {}
        greekSeriesRefs.current[key] = series as any;
      }
    });
    // Remove series for deactivated keys
    for (const key of GREEK_KEYS) {
      if (!activeGreeks.has(key) && greekSeriesRefs.current[key]) {
        try { chart.removeSeries(greekSeriesRefs.current[key]!); } catch {}
        delete greekSeriesRefs.current[key];
      }
    }
  }, [selected, showGreeks, activeGreeks]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!val.trim()) { setResults([]); setShowDropdown(false); return; }
    debounceRef.current = setTimeout(() => {
      if (workerRef.current && workerReady.current) {
        workerRef.current.postMessage({ type: 'SEARCH', payload: val });
      }
    }, 80);
  }, []);

  const handleSelect = useCallback((ins: NubraInstrument) => {
    setSelected(ins);
    setShowDropdown(false);
    setQuery(ins.stock_name);
    setResults([]);
    setChartError('');
  }, []);

  // When intraDay toggled on, snap dates to last trading day
  useEffect(() => {
    if (intraDay) {
      const ltd = lastTradingDay();
      setEntryDate(ltd);
      setExitDate(ltd);
    }
  }, [intraDay]);

  // Fetch & render chart data
  const loadChart = useCallback(async () => {
    if (!selected) return;
    setChartLoading(true);
    setChartError('');

    try {
      const startISO = `${entryDate}T03:45:00.000Z`;
      const endISO = `${exitDate}T11:30:00.000Z`;
      const data = await fetchHistoricalData(selected, startISO, endISO, interval, intraDay);

      // Main chart — candles + volume + OI
      if (candleSeriesRef.current) candleSeriesRef.current.setData(data.candles);
      if (volumeSeriesRef.current) volumeSeriesRef.current.setData(data.volume);

      // OI on left axis of main chart
      if (oiSeriesRef.current && data.oi && data.oi.length > 0) {
        oiSeriesRef.current.setData(data.oi);
      }

      if (chartRef.current) chartRef.current.timeScale().fitContent();

      // Feed historical data into each active greek pane
      if (data.greeks) {
        for (const key of GREEK_KEYS) {
          const series = greekSeriesRefs.current[key];
          const lineData = data.greeks[key as keyof typeof data.greeks];
          if (series && lineData && lineData.length > 0) {
            series.setData(lineData);
          }
        }
      }
    } catch (e: any) {
      setChartError(e.message ?? String(e));
    } finally {
      setChartLoading(false);
    }
  }, [selected, entryDate, exitDate, interval, intraDay]);

  // Auto-load chart when instrument selected — use a small delay to ensure chart refs are set
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => loadChart(), 50);
    return () => clearTimeout(t);
  }, [selected, loadChart]);

  // Live WS bridge connection — active when intraDay=true and interval is intraday
  useEffect(() => {
    const shouldLive = LIVE_INTERVALS.has(interval) && !!selected;

    // Tear down existing connection
    if (liveWsRef.current) {
      liveWsRef.current.close();
      liveWsRef.current = null;
      setLiveConnected(false);
    }

    if (!shouldLive) return;

    const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
    const type = getNubraType(selected!);
    const exchange = selected!.exchange || 'NSE';
    const symbol = selected!.nubra_name || selected!.stock_name || '';
    const refId = selected!.ref_id;
    const intervalSec = INTERVAL_SECONDS[interval] ?? 60;

    const ws = new WebSocket('ws://localhost:8765');
    liveWsRef.current = ws;

    ws.onopen = () => {
      setLiveConnected(true);
      ws.send(JSON.stringify({
        action: 'subscribe',
        session_token: sessionToken,
        data_type: 'ohlcv',
        symbols: [symbol],
        ref_ids: [],
        interval,   // e.g. "1m", "3m", "5m" — sent as-is to bridge
        exchange,
      }));
      if (type === 'OPT' && refId) {
        ws.send(JSON.stringify({
          action: 'subscribe',
          session_token: sessionToken,
          data_type: 'greeks',
          symbols: [],
          ref_ids: [refId],
          exchange,
        }));
      }
    };

    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'ohlcv' && msg.data) {
        const d = msg.data;
        const o = d.open / 100;
        const h = d.high / 100;
        const l = d.low / 100;
        const c = d.close / 100;
        // Use bucket_timestamp (bar start) snapped to interval boundary
        const rawSec = Math.round((d.bucket_timestamp || d.timestamp) / 1e9);
        const ts = snapToBar(rawSec, intervalSec) as unknown as Time;
        if (!ts || !c) return;
        candleSeriesRef.current?.update({ time: ts, open: o, high: h, low: l, close: c });
        volumeSeriesRef.current?.update({
          time: ts,
          value: d.bucket_volume || 0,
          color: c >= o ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)',
        });
      }

      if (msg.type === 'greeks' && msg.data) {
        const d = msg.data;
        // Snap greek tick to current bar boundary using same interval
        const rawSec = Math.round((d.timestamp || 0) / 1e9) || Math.floor(Date.now() / 1000);
        const ts = snapToBar(rawSec, intervalSec) as unknown as Time;
        const greekValues: Record<string, number> = {
          delta: d.delta, theta: d.theta, gamma: d.gamma, vega: d.vega, iv_mid: (d.iv ?? 0) * 100,
        };
        for (const key of (['delta', 'theta', 'gamma', 'vega', 'iv_mid'] as const)) {
          const series = greekSeriesRefs.current[key];
          if (series && greekValues[key] != null) {
            series.update({ time: ts, value: greekValues[key] });
          }
        }
      }
    };

    ws.onclose = () => setLiveConnected(false);
    ws.onerror = () => setLiveConnected(false);

    return () => {
      ws.close();
      liveWsRef.current = null;
      setLiveConnected(false);
    };
  }, [selected, intraDay, interval]);

  const tabResults = useMemo(() => filterByTab(results, tab), [results, tab]);
  const isLoading = status.phase === 'checking' || status.phase === 'fetching' || status.phase === 'parsing' || status.phase === 'storing';
  const isReady = status.phase === 'ready' || status.phase === 'cache-hit';
  const noSession = useMemo(() => !localStorage.getItem('nubra_session_token'), []);

  return (
    <div className={s.root}>
      {/* Top bar */}
      <div className={`${s.topBar} glass-bar`}>

        <span className={s.topBarLabel}>Backtest</span>
        <span className={s.divider} />
        <StatusBadge status={status} />

        {noSession && (
          <span className={s.noSessionWarning}>Login to Nubra first (navbar)</span>
        )}

        {isReady && (
          <Button
            size="small"
            type="text"
            onClick={() => load(true)}
            style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', padding: '0 4px' }}
          >
            refresh
          </Button>
        )}

        {/* Search bar */}
        <div className={s.searchWrapper}>
          <div className={s.searchInputRow}>
            <svg className={s.searchIcon} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={handleChange}
              onFocus={() => results.length > 0 && setShowDropdown(true)}
              placeholder={isReady ? 'Search Nubra instrument...' : isLoading ? 'Loading instruments...' : 'Login to Nubra first'}
              disabled={!isReady}
              autoFocus
              className={`${s.searchInput} glass-input`}
              onFocusCapture={e => (e.target as HTMLInputElement).style.borderColor = 'rgba(245,158,11,0.4)'}
              onBlurCapture={e => (e.target as HTMLInputElement).style.borderColor = '#2a2a2a'}
            />
            {query && (
              <Button
                size="small"
                type="text"
                onClick={() => { setQuery(''); setResults([]); setShowDropdown(false); inputRef.current?.focus(); }}
                style={{ position: 'absolute', right: 6, color: 'rgba(255,255,255,0.3)', padding: '0 4px', minWidth: 'unset', fontSize: 12 }}
              >
                ✕
              </Button>
            )}
          </div>

          {/* Dropdown */}
          {showDropdown && query.trim() && (
            <div ref={dropdownRef} className={`${s.dropdown} glass-dropdown`}>

              {/* Header */}
              <div className={s.dropdownHeader}>
                <span className={s.dropdownTitle}>Nubra Instruments</span>
                <Button
                  size="small"
                  type="text"
                  onClick={() => setShowDropdown(false)}
                  style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, padding: '0 4px', minWidth: 'unset' }}
                >
                  ✕
                </Button>
              </div>

              {/* Tabs */}
              <div className={s.dropdownTabs}>
                {TABS.map(t => (
                  tab === t ? (
                    <Button
                      key={t}
                      size="small"
                      type="primary"
                      onClick={() => setTab(t)}
                      style={{ fontSize: 11, borderRadius: 20, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.35)', boxShadow: 'none' }}
                    >
                      {t}
                    </Button>
                  ) : (
                    <Button
                      key={t}
                      size="small"
                      type="text"
                      onClick={() => setTab(t)}
                      style={{ fontSize: 11, borderRadius: 20, background: 'rgba(255,255,255,0.04)', color: '#555', border: '1px solid rgba(255,255,255,0.07)' }}
                    >
                      {t}
                    </Button>
                  )
                ))}
              </div>

              {/* Table header */}
              <div className={s.tableHeader}>
                <span className={s.tableHeaderCell}>Symbol</span>
                <span className={s.tableHeaderCell}>Asset</span>
                <span className={s.tableHeaderCell}>Expiry</span>
                <span className={s.tableHeaderCell}>Strike</span>
                <span className={s.tableHeaderCellRight}>Type</span>
              </div>

              {/* Results */}
              <div className={s.resultsList}>
                {tabResults.length === 0 ? (
                  <div className={s.noResults}>No results</div>
                ) : (
                  tabResults.map((ins, idx) => (
                    <div key={ins.ref_id || `${ins.stock_name}-${idx}`}
                      onClick={() => handleSelect(ins)}
                      className={s.resultRow}>
                      <div className={s.resultSymbol}>
                        <Highlight text={ins.stock_name} query={query} />
                      </div>
                      <div className={s.resultAsset}>
                        <Highlight text={ins.asset} query={query} />
                      </div>
                      <div className={s.resultExpiry}>
                        {formatExpiry(ins.expiry)}
                      </div>
                      <div className={s.resultStrike}>
                        {ins.strike_price != null ? (ins.strike_price / 100).toFixed(2) : '—'}
                      </div>
                      <div className={s.resultTypeBadges}>
                        {ins.option_type && ins.option_type !== 'N/A' && (
                          <span className={ins.option_type === 'CE' ? s.optionTypeBadgeCe : s.optionTypeBadgePe}>
                            {ins.option_type}
                          </span>
                        )}
                        <span className={s.derivTypeBadge}>
                          {ins.derivative_type}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Controls bar — only when instrument selected */}
      {selected && (
        <div className={`${s.controlsBar} glass-bar`}>

          {/* Selected instrument badge */}
          <div className={s.instrumentBadge}>
            <span className={s.instrumentName}>{selected.stock_name}</span>
            {selected.option_type && selected.option_type !== 'N/A' && (
              <span className={selected.option_type === 'CE' ? s.selectedCeBadge : s.selectedPeBadge}>
                {selected.option_type}
              </span>
            )}
            <span className={s.selectedDerivTypeBadge}>
              {selected.derivative_type}
            </span>
            {selected.expiry && (
              <span className={s.selectedExpiry}>{formatExpiry(selected.expiry)}</span>
            )}
            <span className={s.selectedExchange}>{selected.exchange}</span>
          </div>

          <span className={s.divider} />

          {/* Intraday toggle */}
          <label className={s.intradayLabel}>
            <input type="checkbox" checked={intraDay}
              onChange={e => setIntraDay(e.target.checked)}
              className={s.intradayCheckbox} />
            <span className={s.intradayText}>Intraday</span>
          </label>

          <span className={s.divider} />

          {/* Entry date */}
          <div className={s.dateGroup}>
            <span className={s.dateLabel}>Entry</span>
            <DatePicker
              size="small"
              value={entryDate ? dayjs(entryDate) : null}
              onChange={d => setEntryDate(d ? d.format('YYYY-MM-DD') : '')}
              disabled={intraDay}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: 120 }}
            />
          </div>

          {/* Exit date */}
          <div className={s.dateGroup}>
            <span className={s.dateLabel}>Exit</span>
            <DatePicker
              size="small"
              value={exitDate ? dayjs(exitDate) : null}
              onChange={d => setExitDate(d ? d.format('YYYY-MM-DD') : '')}
              disabled={intraDay}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: 120 }}
            />
          </div>

          <span className={s.divider} />

          {/* Interval */}
          <div className={s.intervalGroup}>
            {INTERVALS.map(iv => (
              interval === iv ? (
                <Button
                  key={iv}
                  size="small"
                  type="primary"
                  onClick={() => setInterval(iv)}
                  style={{ fontSize: 10, fontFamily: 'monospace', background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.35)', boxShadow: 'none' }}
                >
                  {iv}
                </Button>
              ) : (
                <Button
                  key={iv}
                  size="small"
                  type="text"
                  onClick={() => setInterval(iv)}
                  style={{ fontSize: 10, fontFamily: 'monospace', background: 'rgba(255,255,255,0.04)', color: '#555', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  {iv}
                </Button>
              )
            ))}
          </div>

          <span className={s.divider} />

          {/* Greek toggles — only for OPT */}
          {showGreeks && (
            <>
              <span className={s.divider} />
              <div className={s.greekGroup}>
                {GREEK_KEYS.map(key => {
                  const active = activeGreeks.has(key);
                  return (
                    <Button
                      key={key}
                      size="small"
                      type={active ? 'primary' : 'text'}
                      onClick={() => setActiveGreeks(prev => {
                        const next = new Set(prev);
                        active ? next.delete(key) : next.add(key);
                        return next;
                      })}
                      style={active
                        ? { fontSize: 10, fontFamily: 'monospace', background: `${GREEK_COLORS[key]}22`, color: GREEK_COLORS[key], border: `1px solid ${GREEK_COLORS[key]}55`, boxShadow: 'none' }
                        : { fontSize: 10, fontFamily: 'monospace', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.25)', border: '1px solid rgba(255,255,255,0.06)' }}
                    >
                      {key === 'iv_mid' ? 'IV' : key.toUpperCase()}
                    </Button>
                  );
                })}
              </div>
            </>
          )}

          <span className={s.divider} />

          {/* Reload */}
          <Button
            size="small"
            type="primary"
            onClick={loadChart}
            disabled={chartLoading}
            style={{ fontSize: 10, fontFamily: 'monospace', background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.30)', boxShadow: 'none', textTransform: 'uppercase', letterSpacing: '0.05em' }}
            icon={chartLoading ? <Spin size="small" /> : null}
          >
            {chartLoading ? 'Loading...' : 'Fetch'}
          </Button>

          {liveConnected && (
            <span className={s.liveIndicator}>
              <span className={s.liveDot} />
              Live
            </span>
          )}

          {chartError && (
            <span className={s.chartError} title={chartError}>{chartError}</span>
          )}
        </div>
      )}

      {/* Chart area */}
      <div className={s.chartArea}>
        {selected ? (
          <div className={`${s.chartPanel} glass-panel`}>
            <div ref={chartContainerRef} className={s.chartContainer} />
          </div>
        ) : (
          <div className={s.emptyState}>
            <div className={s.emptyStateInner}>
              {noSession ? (
                <>
                  <p className={s.emptyStateText}>Login to Nubra from the navbar</p>
                  <p className={s.emptyStateSubtext}>Instruments will load automatically after login</p>
                </>
              ) : isReady ? (
                <>
                  <p className={s.emptyStateText}>Search for a Nubra instrument above</p>
                  <p className={s.emptyStateSubtext}>{(status as any).total?.toLocaleString()} instruments loaded</p>
                </>
              ) : isLoading ? (
                <p className={s.emptyStateLoading}>Loading Nubra instruments...</p>
              ) : status.phase === 'error' ? (
                <>
                  <p className={s.emptyStateError}>{status.message}</p>
                  <Button
                    size="small"
                    type="text"
                    onClick={() => load(true)}
                    style={{ fontSize: 12, marginTop: 8, color: 'rgba(245,158,11,0.6)' }}
                  >
                    Retry
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
