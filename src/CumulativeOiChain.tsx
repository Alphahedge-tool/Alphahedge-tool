'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as am5 from '@amcharts/amcharts5';
import * as am5percent from '@amcharts/amcharts5/percent';
import { createChart, LineSeries, type IChartApi, type ISeriesApi, type LineData, type Time } from 'lightweight-charts';
import { useInstrumentsCtx } from './AppContext';
import type { NubraInstrument } from './useNubraInstruments';
import s from './CumulativeOiChain.module.css';

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
  oi: number;
  oiChgPct: number;
  iv: number;
  delta: number;
  theta: number;
  vega: number;
  gamma: number;
  volume: number;
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

type ExpiryColumn = {
  expiry: string;
  ceOi: number;
  peOi: number;
};

const EMPTY_SIDE: OptionSide = {
  oi: 0,
  oiChgPct: 0,
  iv: 0,
  delta: 0,
  theta: 0,
  vega: 0,
  gamma: 0,
  volume: 0,
};

const BRIDGE = 'ws://localhost:8765';
const DEFAULT_SCRIP = 'NIFTY';
const STRIKE_WINDOW_OPTIONS = [5, 10, 15, 20];
const METRIC_OPTIONS = ['oi', 'iv', 'delta', 'theta', 'vega', 'gamma'] as const;
type MetricKey = typeof METRIC_OPTIONS[number];
type StrikeViewMode = 'atm' | 'custom';

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

function fmtOi(n: number) {
  if (!n) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtMetricCompact(n: number) {
  if (!n) return '0';
  if (Math.abs(n) >= 1000) return fmtOi(Math.abs(n));
  return Math.abs(n).toFixed(2);
}

function fmtRatio(n: number) {
  if (!isFinite(n)) return '—';
  return n.toFixed(2);
}

function fmtPct(n: number) {
  if (!isFinite(n) || n === 0) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtGreek(n: number, digits = 2) {
  return n !== 0 ? n.toFixed(digits) : '—';
}

function metricLabel(metric: MetricKey) {
  if (metric === 'oi') return 'OI';
  if (metric === 'iv') return 'IV';
  if (metric === 'delta') return 'Delta';
  if (metric === 'theta') return 'Theta';
  if (metric === 'vega') return 'Vega';
  return 'Gamma';
}

function formatMetric(metric: MetricKey, value: number) {
  if (metric === 'oi') {
    return { main: fmtOi(value), sub: null };
  }
  if (metric === 'iv') return { main: value > 0 ? value.toFixed(2) : '—', sub: null };
  if (metric === 'gamma') return { main: fmtGreek(value, 4), sub: null };
  return { main: fmtGreek(value), sub: null };
}

function parseRestOption(opt: Record<string, number>): OptionSide {
  return {
    oi: opt.oi ?? 0,
    oiChgPct: opt.prev_oi != null && (opt.oi ?? 0) > 0 ? (((opt.oi ?? 0) - opt.prev_oi) / (opt.oi ?? 0)) * 100 : 0,
    iv: (opt.iv ?? 0) * 100,
    delta: opt.delta ?? 0,
    theta: opt.theta ?? 0,
    vega: opt.vega ?? 0,
    gamma: opt.gamma ?? 0,
    volume: opt.volume ?? opt.vol ?? opt.total_volume ?? 0,
  };
}

function parseWsOption(opt: Record<string, number>): OptionSide {
  return {
    oi: opt.open_interest ?? 0,
    oiChgPct: (opt.open_interest ?? 0) > 0
      ? (((opt.open_interest ?? 0) - (opt.previous_open_interest ?? 0)) / (opt.open_interest ?? 0)) * 100
      : 0,
    iv: (opt.iv ?? 0) * 100,
    delta: opt.delta ?? 0,
    theta: opt.theta ?? 0,
    vega: opt.vega ?? 0,
    gamma: opt.gamma ?? 0,
    volume: opt.volume ?? opt.traded_volume ?? opt.total_traded_volume ?? 0,
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
    spot: spotRaw / 100,
    atm: atmRaw > 0 ? atmRaw / 100 : spotRaw / 100,
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
    oi: live?.oi ?? base?.oi ?? 0,
    oiChgPct: live?.oiChgPct ?? base?.oiChgPct ?? 0,
    iv: live?.iv ?? base?.iv ?? 0,
    delta: live?.delta ?? base?.delta ?? 0,
    theta: live?.theta ?? base?.theta ?? 0,
    vega: live?.vega ?? base?.vega ?? 0,
    gamma: live?.gamma ?? base?.gamma ?? 0,
    volume: live?.volume ?? base?.volume ?? 0,
  };
}

function mergeChainSnapshot(base: ChainSnapshot | undefined, live: ChainSnapshot): ChainSnapshot {
  if (!base) return live;
  const baseMap = new Map(base.rows.map(row => [row.strike, row]));
  const liveMap = new Map(live.rows.map(row => [row.strike, row]));
  const strikes = [...new Set([...baseMap.keys(), ...liveMap.keys()])].sort((a, b) => a - b);

  return {
    rows: strikes.map(strike => {
      const prev = baseMap.get(strike);
      const next = liveMap.get(strike);
      return {
        strike,
        ce: mergeOptionSide(prev?.ce, next?.ce),
        pe: mergeOptionSide(prev?.pe, next?.pe),
      };
    }),
    spot: live.spot || base.spot,
    atm: live.atm || base.atm,
  };
}

function buildSuggestions(nubraInstruments: NubraInstrument[]): SymbolChoice[] {
  const seen = new Set<string>();
  const out: SymbolChoice[] = [];

  for (const ins of nubraInstruments) {
    const sym = ins.asset ?? ins.nubra_name ?? '';
    if (!sym) continue;
    const assetType = (ins.asset_type ?? '').toUpperCase();
    if (assetType !== 'INDEX_FO' && assetType !== 'STOCK_FO') continue;
    const exchange = ins.exchange ?? 'NSE';
    const key = `${sym}|${exchange}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sym,
      exchange,
      lotSize: ins.lot_size ?? 1,
      stockName: ins.asset ?? ins.stock_name ?? '',
      nubraName: ins.asset ?? ins.nubra_name ?? '',
    });
  }

  return out.sort((a, b) => a.sym.localeCompare(b.sym));
}

function resolveNubra(sym: string, nubraInstruments: NubraInstrument[]) {
  const upper = sym.toUpperCase();
  const found = nubraInstruments.find(i =>
    (i.asset_type === 'INDEX_FO' || i.asset_type === 'STOCK_FO') &&
    (i.asset?.toUpperCase() === upper || i.nubra_name?.toUpperCase() === upper || i.stock_name?.toUpperCase().startsWith(upper))
  );
  if (found?.asset) return { nubraSym: found.asset, exchange: found.exchange ?? 'NSE', lotSize: found.lot_size ?? 1 };
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

function SearchableScripSelect({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: SymbolChoice[];
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setQuery(value); }, [value]);

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
        <span className={s.controlLabel}>Scrip</span>
        <input
          className={s.searchInput}
          value={query}
          disabled={disabled}
          placeholder="Type scrip..."
          onFocus={() => !disabled && setOpen(true)}
          onChange={event => { setQuery(event.target.value); setOpen(true); }}
          onKeyDown={event => {
            if (event.key === 'Escape') setOpen(false);
            if (event.key === 'Enter' && filtered.length > 0) commit(filtered[0]);
          }}
        />
      </label>
      {open && !disabled && (
        <div className={s.searchDropdown}>
          {filtered.length > 0 ? filtered.map(option => (
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
          )) : <div className={s.searchEmpty}>No matching scrip</div>}
        </div>
      )}
    </div>
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
          <option key={String(option)} value={String(option)}>{formatter ? formatter(option) : String(option)}</option>
        ))}
      </select>
    </label>
  );
}

function StrikeMultiSelect({
  options,
  selected,
  onToggle,
  disabled,
}: {
  options: number[];
  selected: number[];
  onToggle: (strike: number) => void;
  disabled?: boolean;
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
        <span className={s.controlLabel}>Custom Strikes</span>
        <button type="button" className={s.multiBtn} disabled={disabled} onClick={() => setOpen(v => !v)}>
          {selected.length > 0 ? `${selected.length} selected` : 'Select strikes'}
        </button>
      </label>
      {open && !disabled && (
        <div className={s.multiDropdown}>
          {options.length === 0 ? (
            <div className={s.searchEmpty}>No strikes available</div>
          ) : (
            options.map(strike => (
              <label key={strike} className={s.multiOption}>
                <input type="checkbox" checked={selected.includes(strike)} onChange={() => onToggle(strike)} />
                <span>{strike.toFixed(0)}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Summary card helpers ──────────────────────────────────────────────────────

interface SummaryCardTrendPoint { ts: number; call: number; put: number }

function normalizeSummaryCardHistory(points: SummaryCardTrendPoint[], maxPoints = 480): SummaryCardTrendPoint[] {
  const byMinute = new Map<number, SummaryCardTrendPoint>();
  for (const p of points) {
    const ts = Math.floor((p.ts ?? 0) / 60000) * 60000;
    byMinute.set(ts, { ts, call: p.call ?? 0, put: p.put ?? 0 });
  }
  const out = [...byMinute.values()].sort((a, b) => a.ts - b.ts);
  return out.length > maxPoints ? out.slice(out.length - maxPoints) : out;
}

function appendSummaryCardPoint(
  prev: SummaryCardTrendPoint[],
  call: number,
  put: number,
  maxPoints = 480,
): SummaryCardTrendPoint[] {
  const ts = Math.floor(Date.now() / 60000) * 60000;
  const next = normalizeSummaryCardHistory(prev, maxPoints);
  const last = next[next.length - 1];
  if (last && last.ts === ts) {
    next[next.length - 1] = { ts, call, put };
  } else {
    next.push({ ts, call, put });
  }
  return normalizeSummaryCardHistory(next, maxPoints);
}

function fmtSummaryCardTime(tsSec: number | null) {
  if (!tsSec) return '--';
  return new Date(tsSec * 1000).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function toSummaryCardTsSec(value: Time | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'year' in value && 'month' in value && 'day' in value) {
    return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000);
  }
  return null;
}

function SummaryCardPie({
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
    const put  = ringMode === 'signed' ? Math.abs(putValue)  : Math.max(putValue, 0);
    const root = am5.Root.new(host);
    const chart = root.container.children.push(
      am5percent.PieChart.new(root, { innerRadius: am5.percent(68), startAngle: -90, endAngle: 270 }),
    );
    const series = chart.series.push(
      am5percent.PieSeries.new(root, { valueField: 'value', categoryField: 'category', alignLabels: false, startAngle: -90, endAngle: 270 }),
    );
    series.slices.template.setAll({ strokeOpacity: 0, cornerRadius: 6 });
    series.slices.template.adapters.add('fill',   (_, t) => (t.dataItem?.dataContext as any)?.color ?? am5.color(0x516079));
    series.slices.template.adapters.add('stroke', (_, t) => (t.dataItem?.dataContext as any)?.color ?? am5.color(0x516079));
    series.labels.template.setAll({ forceHidden: true });
    series.ticks.template.setAll({ forceHidden: true });
    series.data.setAll([
      { category: 'Call', value: call, color: am5.color(0x1fe0af) },
      { category: 'Put',  value: put,  color: am5.color(0xff6f91) },
    ]);
    return () => { root.dispose(); };
  }, [callValue, putValue, ringMode]);

  return <div ref={hostRef} className={s.summaryPieHost} aria-hidden="true" />;
}

function SummaryCardTrend({
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
  formatValue: (v: number) => string;
  initialHistory?: SummaryCardTrendPoint[];
  initialChgHistory?: SummaryCardTrendPoint[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const callSerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const putSerRef  = useRef<ISeriesApi<'Line'> | null>(null);
  const initialFitDoneRef = useRef(false);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [showChg, setShowChg] = useState(false);
  const [history, setHistory] = useState<SummaryCardTrendPoint[]>(
    initialHistory && initialHistory.length > 0
      ? appendSummaryCardPoint(normalizeSummaryCardHistory(initialHistory), callValue, putValue)
      : [{ ts: Math.floor(Date.now() / 60000) * 60000, call: callValue, put: putValue }],
  );
  const [chgHistory, setChgHistory] = useState<SummaryCardTrendPoint[]>(
    initialChgHistory && initialChgHistory.length > 0
      ? appendSummaryCardPoint(normalizeSummaryCardHistory(initialChgHistory), callChgValue, putChgValue)
      : [{ ts: Math.floor(Date.now() / 60000) * 60000, call: callChgValue, put: putChgValue }],
  );

  useEffect(() => {
    if (initialHistory && initialHistory.length > 0) {
      setHistory(appendSummaryCardPoint(normalizeSummaryCardHistory(initialHistory), callValue, putValue));
      initialFitDoneRef.current = false;
      return;
    }
    setHistory([{ ts: Math.floor(Date.now() / 60000) * 60000, call: callValue, put: putValue }]);
  }, [initialHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialChgHistory && initialChgHistory.length > 0) {
      setChgHistory(appendSummaryCardPoint(normalizeSummaryCardHistory(initialChgHistory), callChgValue, putChgValue));
      return;
    }
    setChgHistory([{ ts: Math.floor(Date.now() / 60000) * 60000, call: callChgValue, put: putChgValue }]);
  }, [initialChgHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHistory(prev => appendSummaryCardPoint(prev, callValue, putValue)); }, [callValue, putValue]);
  useEffect(() => { setChgHistory(prev => appendSummaryCardPoint(prev, callChgValue, putChgValue)); }, [callChgValue, putChgValue]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      width: Math.max(host.clientWidth, 120),
      height: 96,
      layout: { background: { color: 'transparent' }, textColor: '#90a7cb', attributionLogo: false },
      grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.10)' } },
      rightPriceScale: { visible: false, borderVisible: false },
      leftPriceScale:  { visible: false, borderVisible: false },
      timeScale: { visible: false, borderVisible: false, secondsVisible: false, timeVisible: true, rightOffset: 1, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
      crosshair: {
        vertLine: { visible: true, labelVisible: false, color: 'rgba(214,226,255,0.42)', width: 1, style: 2 },
        horzLine: { visible: true, labelVisible: false, color: 'rgba(214,226,255,0.22)', width: 1, style: 2 },
      },
      handleScroll: false,
      handleScale: false,
    });
    const callSer = chart.addSeries(LineSeries, { color: '#1fe0af', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderWidth: 2, crosshairMarkerBorderColor: '#10251e', crosshairMarkerBackgroundColor: '#1fe0af' });
    const putSer  = chart.addSeries(LineSeries, { color: '#ff6f91', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderWidth: 2, crosshairMarkerBorderColor: '#2b1420', crosshairMarkerBackgroundColor: '#ff6f91' });
    callSer.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0.12 } });
    putSer.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0.12 } });
    chartRef.current  = chart;
    callSerRef.current = callSer;
    putSerRef.current  = putSer;

    chart.subscribeCrosshairMove(param => {
      const t = toSummaryCardTsSec(param.time);
      if (t != null) { setHoveredTime(t); return; }
      if (param.point) {
        const ct = toSummaryCardTsSec(chart.timeScale().coordinateToTime(param.point.x));
        if (ct != null) { setHoveredTime(ct); return; }
      }
      setHoveredTime(null);
    });

    const ro = new ResizeObserver(entries => {
      const e = entries[0]; if (!e) return;
      chart.applyOptions({ width: Math.max(Math.floor(e.contentRect.width), 120) });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      callSerRef.current = null;
      putSerRef.current  = null;
      initialFitDoneRef.current = false;
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, []);

  const normalizedHistory    = useMemo(() => normalizeSummaryCardHistory(history),    [history]);
  const normalizedChgHistory = useMemo(() => normalizeSummaryCardHistory(chgHistory), [chgHistory]);
  const activeHistory = showChg ? normalizedChgHistory : normalizedHistory;
  const chartData = useMemo(() => ({
    call: activeHistory.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.call })),
    put:  activeHistory.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.put  })),
  }), [activeHistory]);
  const displayPoint = useMemo(() => {
    if (activeHistory.length === 0) return null;
    if (hoveredTime != null) {
      const ms = hoveredTime * 1000;
      for (let i = activeHistory.length - 1; i >= 0; i--) {
        if (activeHistory[i].ts <= ms) return activeHistory[i];
      }
    }
    return activeHistory[activeHistory.length - 1];
  }, [activeHistory, hoveredTime]);
  const displayTime = displayPoint ? Math.floor(displayPoint.ts / 1000) : null;
  const prevShowChgRef = useRef(showChg);

  useEffect(() => {
    callSerRef.current?.setData(chartData.call);
    putSerRef.current?.setData(chartData.put);
    const modeChanged = prevShowChgRef.current !== showChg;
    prevShowChgRef.current = showChg;
    if (!initialFitDoneRef.current || modeChanged) {
      if (chartData.call.length > 0 || chartData.put.length > 0) {
        chartRef.current?.timeScale().fitContent();
        initialFitDoneRef.current = true;
      }
    }
  }, [chartData, showChg]);

  const fmtChg = (v: number) => {
    const abs = Math.abs(v); const sign = v >= 0 ? '+' : '-';
    if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)}L`;
    return `${sign}${abs.toLocaleString('en-IN')}`;
  };

  return (
    <div className={s.summaryTrendInline}>
      <div className={s.summaryTrendChartWrap}>
        <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 2, display: 'flex', gap: 2, background: 'rgba(0,0,0,0.45)', borderRadius: 5, padding: '2px 3px' }}>
          <button type="button" onClick={() => setShowChg(false)} style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background: !showChg ? '#2563eb' : 'transparent', color: !showChg ? '#fff' : '#6b7280', letterSpacing: '0.04em' }}>OI</button>
          <button type="button" onClick={() => setShowChg(true)}  style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background:  showChg ? '#2563eb' : 'transparent', color:  showChg ? '#fff' : '#6b7280', letterSpacing: '0.04em' }}>CHG</button>
        </div>
        <div ref={hostRef} className={s.summaryTrendChart} aria-hidden="true" />
      </div>
      <div className={s.summaryTrendInlineMeta}>
        <span className={s.summaryTrendCaption}>{showChg ? 'OI change' : (history.length > 2 ? 'Session trend' : 'Live trend')}</span>
        <span className={s.summaryTrendTime}>{fmtSummaryCardTime(displayTime)}</span>
        <span className={s.summaryTrendLive}>{hoveredTime != null ? 'INSPECT' : 'LIVE'}</span>
      </div>
      <div className={s.summaryTrendValues}>
        {showChg ? (
          <>
            <span className={`${s.summaryTrendValuePill} ${s.summaryTrendValueCall}`}>CE {fmtChg(displayPoint?.call ?? callChgValue)}</span>
            <span className={`${s.summaryTrendValuePill} ${s.summaryTrendValuePut}`}>PE {fmtChg(displayPoint?.put ?? putChgValue)}</span>
            {(() => { const c = displayPoint?.call ?? callChgValue; const p = displayPoint?.put ?? putChgValue; const pcrV = c !== 0 ? p / c : null; return pcrV != null ? <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>PCR {fmtRatio(pcrV)}</span> : null; })()}
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

function SummaryCard({
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
}: {
  title: string;
  subtitle: string;
  callValue: number;
  putValue: number;
  callChgValue?: number;
  putChgValue?: number;
  pcr: number;
  formatValue: (v: number) => string;
  ringMode?: 'standard' | 'signed';
  trendHistory?: SummaryCardTrendPoint[];
  trendChgHistory?: SummaryCardTrendPoint[];
}) {
  const ringCall  = ringMode === 'signed' ? Math.abs(callValue) : Math.max(callValue, 0);
  const ringPut   = ringMode === 'signed' ? Math.abs(putValue)  : Math.max(putValue, 0);
  const totalLabel = formatValue(callValue + putValue);
  const centerScale = totalLabel.length > 10 ? 0.72 : totalLabel.length > 8 ? 0.82 : totalLabel.length > 6 ? 0.92 : 1;

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
          <SummaryCardPie callValue={ringCall} putValue={ringPut} ringMode={ringMode} />
          <div className={s.summaryDonutCenter}>
            <span className={s.summaryDonutCenterLabel}>Total</span>
            <strong className={s.summaryDonutCenterValue} style={{ transform: `scale(${centerScale})` }}>{totalLabel}</strong>
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
          <SummaryCardTrend
            callValue={callValue} putValue={putValue}
            callChgValue={callChgValue} putChgValue={putChgValue}
            formatValue={formatValue}
            initialHistory={trendHistory}
            initialChgHistory={trendChgHistory}
          />
        )}
      </div>
    </article>
  );
}

// ── Historical helpers ────────────────────────────────────────────────────────
function todayIst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Returns the IST day's session boundaries in UTC.
// IST day YYYY-MM-DD starts at 09:15 IST = prev UTC day 03:45Z
// and ends at 15:30 IST = same UTC day 10:00Z.
// For the historical API Nubra uses startDate = YYYY-MM-DDT18:30:00.000Z (prev UTC day midnight IST)
// and endDate = YYYY-MM-DDT18:29:59.999Z (next UTC day midnight IST).
function istDayToUtcRange(istDate: string): { startDate: string; endDate: string } {
  const [y, m, d] = istDate.split('-').map(Number);
  // IST midnight = UTC prev day 18:30:00
  const startMs = Date.UTC(y, m - 1, d - 1, 18, 30, 0, 0);
  // IST next midnight - 1ms = UTC that day 18:29:59.999
  const endMs   = Date.UTC(y, m - 1, d, 18, 29, 59, 999);
  return {
    startDate: new Date(startMs).toISOString(),
    endDate:   new Date(endMs).toISOString(),
  };
}


// ── Nubra chain timeseries helpers ───────────────────────────────────────────

function buildNubraChainValue(nubraSym: string, expiry: string): string {
  return `${nubraSym}_${expiry}`;
}

async function fetchChainOiHistory(
  exchange: string, chainValues: string[], startDate: string, endDate: string,
): Promise<SummaryTrendPoint[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken || chainValues.length === 0) return [];

  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: { 'x-session-token': sessionToken, 'x-device-id': deviceId, 'x-raw-cookie': rawCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chart: 'Put_Call_Ratio',
      query: [{ exchange, type: 'CHAIN', values: chainValues, fields: ['cumulative_call_oi', 'cumulative_put_oi'], startDate, endDate, interval: '1m', intraDay: false, realTime: false }],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const totals = new Map<number, SummaryTrendPoint>();
  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      for (const chainValue of chainValues) {
        const d = valObj?.[chainValue];
        if (!d) continue;
        for (const p of (d.cumulative_call_oi ?? []) as Array<{ ts: number; v: number }>) {
          const ts = Math.floor((p.ts ?? 0) / 1e9) * 1000;
          const row = totals.get(ts) ?? { ts, call: 0, put: 0 };
          row.call += p.v ?? 0;
          totals.set(ts, row);
        }
        for (const p of (d.cumulative_put_oi ?? []) as Array<{ ts: number; v: number }>) {
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

async function fetchChainVolHistory(
  exchange: string, chainValues: string[], startDate: string, endDate: string,
): Promise<SummaryTrendPoint[]> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken || chainValues.length === 0) return [];

  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: { 'x-session-token': sessionToken, 'x-device-id': deviceId, 'x-raw-cookie': rawCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chart: 'Put_Call_Ratio',
      query: [{ exchange, type: 'CHAIN', values: chainValues, fields: ['cumulative_call_vol', 'cumulative_put_vol'], startDate, endDate, interval: '1m', intraDay: false, realTime: false }],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const totals = new Map<number, SummaryTrendPoint>();
  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      for (const chainValue of chainValues) {
        const d = valObj?.[chainValue];
        if (!d) continue;
        for (const p of (d.cumulative_call_vol ?? []) as Array<{ ts: number; v: number }>) {
          const ts = Math.floor((p.ts ?? 0) / 1e9) * 1000;
          const row = totals.get(ts) ?? { ts, call: 0, put: 0 };
          row.call += p.v ?? 0;
          totals.set(ts, row);
        }
        for (const p of (d.cumulative_put_vol ?? []) as Array<{ ts: number; v: number }>) {
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

// helper — current IST time as YYYY-MM-DD / HH:MM
function toIstNow(): { date: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function istToUtcIsoLocal(date: string, hhmm: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 5, mi - 30)).toISOString();
}

interface MarketSchedule {
  is_trading_on_today_nse: boolean;
  exchange_calendar_info: {
    NSE: {
      is_trading_on_now: boolean;
      previous_trading_day_slot: Array<{ StartTime: string; EndTime: string }>;
    };
  };
}

// Returns the last completed or currently active trading date (YYYY-MM-DD IST).
// - If today is a trading day and market is open now → today (live mode)
// - If today is a trading day and market has ended    → today (replay mode)
// - Otherwise                                         → previous trading day from API
async function fetchLastTradingDate(): Promise<{ date: string; isLive: boolean; isToday: boolean }> {
  const headers = nubraHeaders();
  try {
    const res = await fetch('/api/nubra-market-schedule', { headers });
    if (!res.ok) throw new Error('non-200');
    const json: MarketSchedule = await res.json();
    const nse = json.exchange_calendar_info?.NSE;
    const isTradingToday = json.is_trading_on_today_nse;
    const isNowLive = nse?.is_trading_on_now ?? false;

    if (isTradingToday) {
      return { date: todayIst(), isLive: isNowLive, isToday: true };
    }

    // Not a trading day — derive date from previous_trading_day_slot
    const prevSlot = nse?.previous_trading_day_slot?.[0];
    if (prevSlot?.StartTime) {
      // StartTime is UTC, convert to IST date
      const prevDate = new Date(prevSlot.StartTime)
        .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return { date: prevDate, isLive: false, isToday: false };
    }
  } catch {
    // fall back silently
  }
  // Fallback: use today IST
  return { date: todayIst(), isLive: false, isToday: true };
}


interface TsPoint { ts: number; v: number }  // ts = milliseconds

interface StrikeHistorySeries {
  oi: TsPoint[];
  delta: TsPoint[];
  deltaOi: TsPoint[];
}

const EMPTY_HISTORY_SERIES: StrikeHistorySeries = {
  oi: [],
  delta: [],
  deltaOi: [],
};

// Look up the exact stock_name Nubra uses for an OPT instrument row
function findOptStockName(
  nubraInstruments: NubraInstrument[],
  assetSym: string,
  expiry: string,
  strike: number,
  side: 'CE' | 'PE',
): string | null {
  const sym = assetSym.toUpperCase();
  const strikePaise = Math.round(strike * 100);
  for (const ins of nubraInstruments) {
    const asset = (ins.asset ?? '').toString().toUpperCase();
    const stockName = (ins.stock_name ?? '').toString().toUpperCase();
    const nubraName = (ins.nubra_name ?? '').toString().toUpperCase();
    if (
      (asset === sym || stockName.startsWith(sym) || nubraName.startsWith(sym)) &&
      ins.option_type === side &&
      String(ins.expiry ?? '').replace(/-/g, '') === expiry &&
      Math.abs((ins.strike_price ?? 0) - strikePaise) < 2
    ) {
      return ins.stock_name || ins.nubra_name || null;
    }
  }
  return null;
}

async function fetchStrikeSeries(
  exchange: string,
  stockName: string,   // exact ins.stock_name e.g. "NIFTY2641724000CE"
  date: string,        // YYYY-MM-DD IST
  isLive = false,      // true when market is currently open
): Promise<{ oi: TsPoint[]; delta: TsPoint[] }> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken = localStorage.getItem('nubra_auth_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? '';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';

  // Full IST-day UTC boundaries (18:30Z prev day → 18:29:59.999Z that day)
  const { startDate, endDate: fullEndDate } = istDayToUtcRange(date);
  // For live market, cap endDate at current moment
  const endDate = isLive
    ? new Date().toISOString()
    : fullEndDate;

  const body = {
    session_token: sessionToken,
    auth_token: authToken,
    device_id: deviceId,
    raw_cookie: rawCookie,
    exchange,
    type: 'OPT',
    values: [stockName],
    fields: ['cumulative_oi', 'delta'],
    startDate,
    endDate,
    interval: '1m',
    intraDay: false,
    realTime: isLive,
  };

  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': sessionToken,
      'x-device-id': deviceId,
      'x-raw-cookie': rawCookie,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { oi: [], delta: [] };

  const json = await res.json();
  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
  let chartData: any = null;
  for (const dict of valuesArr) {
    for (const v of Object.values(dict)) { chartData = v; break; }
    if (chartData) break;
  }
  if (!chartData) return { oi: [], delta: [] };

  const parse = (arr: any[]): TsPoint[] => {
    const raw = (Array.isArray(arr) ? arr : [])
      .map((p: any) => ({
        ts: Math.round(Number(p.ts ?? p.timestamp ?? 0) / 1e6),  // ns → ms
        v: Number(p.v ?? p.value ?? 0),
      }))
      .filter((p: TsPoint) => p.ts > 0 && isFinite(p.v))
      .sort((a, b) => a.ts - b.ts);
    // Deduplicate by minute-level timestamp (floor to 60s) — keep last value per minute
    const byMinute = new Map<number, TsPoint>();
    for (const p of raw) {
      const minKey = Math.floor(p.ts / 60000) * 60000;
      byMinute.set(minKey, { ts: minKey, v: p.v });
    }
    return [...byMinute.values()].sort((a, b) => a.ts - b.ts);
  };

  return {
    oi:    parse(chartData.cumulative_oi ?? []),
    delta: parse(chartData.delta ?? []),
  };
}

function buildStrikeHistorySeries(result: { oi: TsPoint[]; delta: TsPoint[] }): StrikeHistorySeries {
  const deltaMap = new Map(result.delta.map(p => [p.ts, p.v]));
  const deltaOi = result.oi
    .map(p => ({ ts: p.ts, v: Math.abs(deltaMap.get(p.ts) ?? 0) * p.v }))
    .filter(p => p.v > 0);

  return {
    oi: result.oi,
    delta: result.delta,
    deltaOi,
  };
}

// Sum multiple TsPoint series into one, aligning on timestamp (minute-level)
function sumTsPointSeries(seriesList: TsPoint[][]): TsPoint[] {
  const totals = new Map<number, number>();
  for (const series of seriesList) {
    for (const p of series) {
      totals.set(p.ts, (totals.get(p.ts) ?? 0) + p.v);
    }
  }
  return [...totals.entries()].map(([ts, v]) => ({ ts, v })).sort((a, b) => a.ts - b.ts);
}

// Append a live TsPoint using 1-min bucket logic:
// same minute → replace last point (animated); new minute → push new point
function appendTsPoint(series: TsPoint[], value: number, maxPoints = 800): TsPoint[] {
  if (!isFinite(value)) return series;
  const ts = Math.floor(Date.now() / 60000) * 60000;
  const next = [...series];
  const last = next[next.length - 1];
  if (last && last.ts === ts) {
    next[next.length - 1] = { ts, v: value };
  } else {
    next.push({ ts, v: value });
  }
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}

// ── Per-strike historical line chart (canvas) ─────────────────────────────────

function buildSparklinePath(points: TsPoint[], width: number, height: number): string {
  if (points.length === 0) return '';
  const minV = Math.min(...points.map(point => point.v));
  const maxV = Math.max(...points.map(point => point.v));
  const rangeV = maxV - minV || 1;

  return points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - (((point.v - minV) / rangeV) * (height - 2) + 1);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function CellSparkline({
  points,
  color,
  faint = false,
}: {
  points: TsPoint[];
  color: string;
  faint?: boolean;
}) {
  const width = 42;
  const height = 16;
  const path = useMemo(() => buildSparklinePath(points, width, height), [points]);

  return (
    <svg className={s.cellSparkline} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path
        d={`M0 ${height - 1.5} H${width}`}
        fill="none"
        stroke={faint ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.12)'}
        strokeWidth="1"
      />
      {path ? (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d={`M2 ${height - 4} L${width - 2} ${height - 4}`}
          fill="none"
          stroke="rgba(255,255,255,0.16)"
          strokeWidth="1.2"
          strokeDasharray="2 2"
        />
      )}
    </svg>
  );
}


// ── Strike popup — TradingView-style chart ────────────────────────────────────
interface PopupSeries { label: string; color: string; points: TsPoint[] }

// Single multi-pane chart:
//   Pane 0 — Delta×OI  (CE Δ×OI left, PE Δ×OI right)
//   Pane 1 — OI        (CE OI left, PE OI right)
//   Pane 2 — PCR       (single right scale)
function StrikeMultiPaneChart({
  deltaOiSeries,
  oiSeries,
  pcrSeries,
}: {
  deltaOiSeries: PopupSeries[];
  oiSeries: PopupSeries[];
  pcrSeries: PopupSeries[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefsRef = useRef<{
    ceDeltaOi: ISeriesApi<'Line'> | null;
    peDeltaOi: ISeriesApi<'Line'> | null;
    ceOi:      ISeriesApi<'Line'> | null;
    peOi:      ISeriesApi<'Line'> | null;
    pcr:       ISeriesApi<'Line'> | null;
  }>({ ceDeltaOi: null, peDeltaOi: null, ceOi: null, peOi: null, pcr: null });
  const initialFitDoneRef = useRef(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: '#0b1118' },
        textColor: '#93a4bc',
        panes: {
          separatorColor: 'rgba(255,255,255,0.08)',
          separatorHoverColor: 'rgba(255,255,255,0.18)',
          enableResize: true,
        },
      },
      grid: { vertLines: { color: 'rgba(148,163,184,0.07)' }, horzLines: { color: 'rgba(148,163,184,0.07)' } },
      rightPriceScale: { visible: true, borderColor: 'rgba(148,163,184,0.14)' },
      leftPriceScale:  { visible: true, borderColor: 'rgba(148,163,184,0.14)' },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.14)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 0,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
          }),
      },
      localization: {
        timeFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
          }),
      },
      crosshair: { mode: 1 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    // ── Pane 0: Delta×OI ────────────────────────────────────────────────────────
    const ceDeltaOi = chart.addSeries(LineSeries, {
      color: '#38d4c8', lineWidth: 2, title: 'CE Δ×OI',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
      priceScaleId: 'left',
      priceFormat: { type: 'custom', formatter: fmtOi, minMove: 1 } as any,
    }, 0);
    const peDeltaOi = chart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 2, title: 'PE Δ×OI',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
      priceScaleId: 'right',
      priceFormat: { type: 'custom', formatter: fmtOi, minMove: 1 } as any,
    }, 0);

    // ── Pane 1: OI ──────────────────────────────────────────────────────────────
    const ceOi = chart.addSeries(LineSeries, {
      color: '#38d4c8', lineWidth: 2, title: 'CE OI',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
      priceScaleId: 'oi-left',
      priceFormat: { type: 'custom', formatter: fmtOi, minMove: 1 } as any,
    }, 1);
    const peOi = chart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 2, title: 'PE OI',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
      priceScaleId: 'oi-right',
      priceFormat: { type: 'custom', formatter: fmtOi, minMove: 1 } as any,
    }, 1);

    // ── Pane 2: PCR ─────────────────────────────────────────────────────────────
    const pcr = chart.addSeries(LineSeries, {
      color: '#a78bfa', lineWidth: 2, title: 'PCR',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
      priceScaleId: 'pcr',
      priceFormat: { type: 'custom', formatter: (v: number) => v.toFixed(2), minMove: 0.01 } as any,
    }, 2);

    chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    ceOi.priceScale().applyOptions({ visible: true, borderColor: 'rgba(148,163,184,0.14)', scaleMargins: { top: 0.1, bottom: 0.1 } });
    peOi.priceScale().applyOptions({ visible: true, borderColor: 'rgba(148,163,184,0.14)', scaleMargins: { top: 0.1, bottom: 0.1 } });
    pcr.priceScale().applyOptions({ visible: true, borderColor: 'rgba(148,163,184,0.14)', scaleMargins: { top: 0.12, bottom: 0.12 } });
    try { chart.panes()[1]?.setHeight(120); chart.panes()[2]?.setHeight(90); } catch {}

    seriesRefsRef.current = { ceDeltaOi, peDeltaOi, ceOi, peOi, pcr };
    chartRef.current = chart;
    initialFitDoneRef.current = false;

    // ── Crosshair tooltip ───────────────────────────────────────────────────────
    chart.subscribeCrosshairMove(param => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (!param.point || !param.seriesData.size) { tooltip.style.display = 'none'; return; }
      const refs = seriesRefsRef.current;
      const entries: { color: string; label: string; fmt: (v: number) => string; ser: ISeriesApi<'Line'> | null }[] = [
        { color: '#38d4c8', label: 'CE Δ×OI', fmt: fmtOi,              ser: refs.ceDeltaOi },
        { color: '#f59e0b', label: 'PE Δ×OI', fmt: fmtOi,              ser: refs.peDeltaOi },
        { color: '#38d4c8', label: 'CE OI',   fmt: fmtOi,              ser: refs.ceOi },
        { color: '#f59e0b', label: 'PE OI',   fmt: fmtOi,              ser: refs.peOi },
        { color: '#a78bfa', label: 'PCR',     fmt: (v: number) => v.toFixed(2), ser: refs.pcr },
      ];
      const parts = entries
        .map(e => {
          if (!e.ser) return null;
          const d = param.seriesData.get(e.ser) as { value?: number } | undefined;
          if (d?.value == null) return null;
          return `<div style="display:flex;align-items:center;gap:5px;white-space:nowrap">
            <span style="width:7px;height:7px;border-radius:50%;background:${e.color};flex-shrink:0"></span>
            <span style="color:#8896a8;font-size:10px">${e.label}:</span>
            <span style="color:#e2e8f0;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums">${e.fmt(d.value)}</span>
          </div>`;
        })
        .filter(Boolean);
      if (!parts.length) { tooltip.style.display = 'none'; return; }
      tooltip.innerHTML = parts.join('');
      tooltip.style.display = 'flex';
      tooltip.style.right = '68px';
      tooltip.style.top = `${Math.max(4, param.point.y - 10)}px`;
    });

    return () => {
      seriesRefsRef.current = { ceDeltaOi: null, peDeltaOi: null, ceOi: null, peOi: null, pcr: null };
      chartRef.current = null;
      initialFitDoneRef.current = false;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const refs = seriesRefsRef.current;
    const toLineData = (pts: TsPoint[]): LineData[] =>
      pts.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.v }))
         .sort((a, b) => (a.time as number) - (b.time as number));

    refs.ceDeltaOi?.setData(toLineData(deltaOiSeries.find(s => s.label === 'CE Δ×OI')?.points ?? []));
    refs.peDeltaOi?.setData(toLineData(deltaOiSeries.find(s => s.label === 'PE Δ×OI')?.points ?? []));
    refs.ceOi?.setData(toLineData(oiSeries.find(s => s.label === 'CE OI')?.points ?? []));
    refs.peOi?.setData(toLineData(oiSeries.find(s => s.label === 'PE OI')?.points ?? []));
    refs.pcr?.setData(toLineData(pcrSeries.find(s => s.label === 'PCR')?.points ?? []));

    const hasData = [deltaOiSeries, oiSeries, pcrSeries].flat().some(s => s.points.length > 0);
    if (!initialFitDoneRef.current && hasData) {
      chartRef.current?.timeScale().fitContent();
      initialFitDoneRef.current = true;
    }
  }, [deltaOiSeries, oiSeries, pcrSeries]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div
        ref={tooltipRef}
        style={{
          display: 'none',
          position: 'absolute',
          flexDirection: 'column',
          gap: 3,
          background: 'rgba(11,17,24,0.93)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          padding: '6px 9px',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      />
    </div>
  );
}


// ── Delta×OI bar chart ────────────────────────────────────────────────────────
interface ChartRow {
  strike: number;
  isAtm: boolean;
  ceDeltaOi: number;  // ce.delta * ce.oi
  peDeltaOi: number;  // abs(pe.delta) * pe.oi
}

function StrikeDetailPopup({
  strike,
  expiry,
  isAtm,
  deltaOiSeries,
  oiSeries,
  pcrSeries,
  loading,
  date,
  onDateChange,
  onClose,
}: {
  strike: number;
  expiry: string;
  isAtm: boolean;
  deltaOiSeries: PopupSeries[];
  oiSeries: PopupSeries[];
  pcrSeries: PopupSeries[];
  loading: boolean;
  date: string;
  onDateChange: (d: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className={s.popupOverlay}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={s.popupShell}>
        <div className={s.popupHeader}>
          <div className={s.popupHeaderLeft}>
            <span className={`${s.popupTitle} ${isAtm ? s.popupTitleAtm : ''}`}>
              {strike.toFixed(0)}{isAtm ? ' ⚡ATM' : ''} · {fmtExpiry(expiry)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="date"
              value={date}
              onChange={e => onDateChange(e.target.value)}
              style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, color: '#b6c2d9', fontSize: 11, padding: '3px 7px', cursor: 'pointer' }}
            />
            {loading && <span style={{ fontSize: 10, color: '#8896a8' }}>Loading…</span>}
            <button onClick={onClose} className={s.popupClose}>✕</button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 12px 12px' }}>
          <StrikeMultiPaneChart
            deltaOiSeries={deltaOiSeries}
            oiSeries={oiSeries}
            pcrSeries={pcrSeries}
          />
        </div>
      </div>
    </div>
  );
}

interface HistoryRequest {
  key: string;
  expiry: string;
  strike: number;
  side: 'CE' | 'PE';
}


function DeltaOiChart({ chartRows, spot }: { chartRows: ChartRow[]; spot: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0e1117';
    ctx.fillRect(0, 0, W, H);

    if (chartRows.length === 0) {
      ctx.fillStyle = '#556';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data', W / 2, H / 2);
      return;
    }

    const PAD_L = 68;  // strike labels
    const PAD_R = 14;
    const PAD_T = 32;
    const PAD_B = 24;
    const midX = PAD_L + (W - PAD_L - PAD_R) / 2;
    const barAreaW = (W - PAD_L - PAD_R) / 2;
    const rowH = Math.max(8, (H - PAD_T - PAD_B) / chartRows.length);
    const barH = Math.max(4, rowH * 0.55);

    const maxVal = Math.max(1, ...chartRows.map(r => Math.max(r.ceDeltaOi, r.peDeltaOi)));

    // header
    ctx.fillStyle = '#8896a8';
    ctx.font = `bold 10px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('CE Δ×OI', midX - 4, PAD_T - 10);
    ctx.textAlign = 'left';
    ctx.fillText('PE Δ×OI', midX + 4, PAD_T - 10);

    // center line
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(midX, PAD_T - 4);
    ctx.lineTo(midX, H - PAD_B);
    ctx.stroke();

    chartRows.forEach((row, i) => {
      const y = PAD_T + i * rowH;
      const barTop = y + (rowH - barH) / 2;

      // ATM highlight
      if (row.isAtm) {
        ctx.fillStyle = 'rgba(251,191,36,0.07)';
        ctx.fillRect(PAD_L, y, W - PAD_L - PAD_R, rowH);
      }

      // CE bar (extends left from center)
      const ceW = (row.ceDeltaOi / maxVal) * barAreaW;
      ctx.fillStyle = '#22c55e';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(midX - ceW, barTop, ceW, barH);
      ctx.globalAlpha = 1;

      // PE bar (extends right from center)
      const peW = (row.peDeltaOi / maxVal) * barAreaW;
      ctx.fillStyle = '#f43f5e';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(midX, barTop, peW, barH);
      ctx.globalAlpha = 1;

      // strike label
      ctx.fillStyle = row.isAtm ? '#fbbf24' : '#8896a8';
      ctx.font = row.isAtm ? 'bold 10px sans-serif' : '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(row.strike.toFixed(0), PAD_L - 4, y + rowH / 2 + 4);

      // value labels inside bars if wide enough
      if (ceW > 28) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(fmtOi(row.ceDeltaOi), midX - ceW + ceW - 3, barTop + barH / 2 + 3);
      }
      if (peW > 28) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(fmtOi(row.peDeltaOi), midX + 3, barTop + barH / 2 + 3);
      }
    });

    // spot line
    if (spot > 0 && chartRows.length > 0) {
      const strikes = chartRows.map(r => r.strike);
      const minS = strikes[0], maxS = strikes[strikes.length - 1];
      if (maxS > minS) {
        const spotFrac = (spot - minS) / (maxS - minS);
        const spotY = PAD_T + spotFrac * (H - PAD_T - PAD_B);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(PAD_L, spotY);
        ctx.lineTo(W - PAD_R, spotY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fbbf24';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${spot.toFixed(0)}`, PAD_L - 4, spotY + 3);
      }
    }
  }, [chartRows, spot]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block', borderRadius: 6, background: '#0e1117' }}
    />
  );
}

// ── OI trend (cumulative CE vs PE over time) ─────────────────────────────────
interface SummaryTrendPoint { ts: number; call: number; put: number }

function appendSummaryTrendPoint(
  prev: SummaryTrendPoint[],
  callValue: number,
  putValue: number,
  maxPoints = 480,
): SummaryTrendPoint[] {
  const ts = Math.floor(Date.now() / 60000) * 60000;
  const next = [...prev];
  const last = next[next.length - 1];
  if (last && last.ts === ts) {
    next[next.length - 1] = { ts, call: callValue, put: putValue };
  } else {
    next.push({ ts, call: callValue, put: putValue });
  }
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}

function OiTrendChart({ history }: { history: SummaryTrendPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const callSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const putSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const initialFitDoneRef = useRef(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: '#0b1118' }, textColor: '#93a4bc' },
      grid: { vertLines: { color: 'rgba(148,163,184,0.07)' }, horzLines: { color: 'rgba(148,163,184,0.07)' } },
      rightPriceScale: { visible: true, borderColor: 'rgba(148,163,184,0.14)' },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.14)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 0,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (ts: number) =>
          new Date(ts * 1000).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
          }),
      },
      crosshair: { mode: 1 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    const callSeries = chart.addSeries(LineSeries, {
      color: '#38d4c8', lineWidth: 2, title: 'CE OI',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
      priceFormat: { type: 'custom', formatter: fmtOi, minMove: 1 } as any,
    });
    const putSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 2, title: 'PE OI',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
      priceFormat: { type: 'custom', formatter: fmtOi, minMove: 1 } as any,
    });
    callSeriesRef.current = callSeries;
    putSeriesRef.current = putSeries;
    chartRef.current = chart;
    initialFitDoneRef.current = false;

    // Crosshair tooltip on right Y axis
    chart.subscribeCrosshairMove(param => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (!param.point || !param.seriesData.size) { tooltip.style.display = 'none'; return; }
      const callD = param.seriesData.get(callSeries) as { value?: number } | undefined;
      const putD  = param.seriesData.get(putSeries)  as { value?: number } | undefined;
      if (callD?.value == null && putD?.value == null) { tooltip.style.display = 'none'; return; }
      tooltip.innerHTML = [
        callD?.value != null ? `<div style="display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:#38d4c8;flex-shrink:0"></span><span style="color:#93a4bc;font-size:10px">CE OI:</span><span style="color:#e2e8f0;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums">${fmtOi(callD.value)}</span></div>` : '',
        putD?.value  != null ? `<div style="display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;flex-shrink:0"></span><span style="color:#93a4bc;font-size:10px">PE OI:</span><span style="color:#e2e8f0;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums">${fmtOi(putD.value)}</span></div>` : '',
      ].join('');
      tooltip.style.display = 'flex';
      tooltip.style.right = '64px';
      tooltip.style.top = `${Math.max(4, param.point.y - 20)}px`;
    });

    return () => {
      callSeriesRef.current = null;
      putSeriesRef.current = null;
      chartRef.current = null;
      initialFitDoneRef.current = false;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const callData: LineData[] = history.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.call }));
    const putData: LineData[]  = history.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.put }));
    callSeriesRef.current?.setData(callData);
    putSeriesRef.current?.setData(putData);
    // fitContent only on first data load
    if (!initialFitDoneRef.current && history.length > 0) {
      chartRef.current?.timeScale().fitContent();
      initialFitDoneRef.current = true;
    }
  }, [history]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 12px', background: '#0e1117', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Cumulative OI Trend</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#38d4c8' }}>
          <span style={{ width: 10, height: 2, background: '#38d4c8', display: 'inline-block', borderRadius: 1 }} />CE OI
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#f59e0b' }}>
          <span style={{ width: 10, height: 2, background: '#f59e0b', display: 'inline-block', borderRadius: 1 }} />PE OI
        </span>
      </div>
      <div style={{ position: 'relative' }}>
        <div ref={containerRef} style={{ height: 180 }} />
        <div
          ref={tooltipRef}
          style={{
            display: 'none',
            position: 'absolute',
            flexDirection: 'column',
            gap: 3,
            background: 'rgba(11,17,24,0.92)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            padding: '5px 8px',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        />
      </div>
    </div>
  );
}

export default function CumulativeOiChain({ visible }: Props) {
  const { nubraInstruments } = useInstrumentsCtx();
  const allSymbols = useMemo(() => buildSuggestions(nubraInstruments), [nubraInstruments]);

  const [symbol, setSymbol] = useState(DEFAULT_SCRIP);
  const [exchange, setExchange] = useState('NSE');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiries, setSelectedExpiries] = useState<string[]>(['', '', '']);
  const [strikeCount, setStrikeCount] = useState(5);
  const [strikeViewMode, setStrikeViewMode] = useState<StrikeViewMode>('atm');
  const [customStrikes, setCustomStrikes] = useState<number[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('oi');
  const [chains, setChains] = useState<Record<string, ChainSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deltaOi, setDeltaOi] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [summaryOiTrendHistory, setSummaryOiTrendHistory] = useState<SummaryTrendPoint[]>([]);
  const [summaryVolTrendHistory, setSummaryVolTrendHistory] = useState<SummaryTrendPoint[]>([]);
  const [summaryDeltaTrendHistory, setSummaryDeltaTrendHistory] = useState<SummaryTrendPoint[]>([]);
  const summaryOiHistoryCacheRef = useRef(new Map<string, SummaryTrendPoint[]>());
  const summaryVolHistoryCacheRef = useRef(new Map<string, SummaryTrendPoint[]>());
  const summaryOiChgHistory = useMemo<SummaryCardTrendPoint[]>(() => {
    if (summaryOiTrendHistory.length === 0) return [];
    const base = summaryOiTrendHistory[0];
    return summaryOiTrendHistory.map(p => ({ ts: p.ts, call: p.call - base.call, put: p.put - base.put }));
  }, [summaryOiTrendHistory]);
  const [histDate, setHistDate] = useState(() => todayIst());
  const [histIsLive, setHistIsLive] = useState(false);
  // key = `${strike}:${expiry}:${side}` → TsPoint[]
  const [histData, setHistData] = useState<Record<string, StrikeHistorySeries>>({});
  const [popupCell, setPopupCell] = useState<{ strike: number; expiry: string } | null>(null);
  const [allExpiryOi, setAllExpiryOi] = useState<Record<number, { totalCeOi: number; totalPeOi: number; pcr: number } | 'loading'>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const histDataRef = useRef<Record<string, StrikeHistorySeries>>({});
  const histPendingRef = useRef<Set<string>>(new Set());
  const histDateRef = useRef<string>(histDate);

  const pickedExpiries = useMemo(
    () => selectedExpiries.filter(Boolean).filter((value, idx, arr) => arr.indexOf(value) === idx),
    [selectedExpiries],
  );

  // On mount: resolve last trading date from market schedule API
  useEffect(() => {
    fetchLastTradingDate().then(({ date, isLive }) => {
      setHistDate(date);
      setHistIsLive(isLive);
    });
  }, []);

  // When user manually picks a date, recalculate isLive
  const handleHistDateChange = useCallback((newDate: string) => {
    const todayDate = todayIst();
    if (newDate === todayDate && isMarketOpen()) {
      setHistIsLive(true);
    } else {
      setHistIsLive(false);
    }
    setHistDate(newDate);
  }, []);

  useEffect(() => {
    histDataRef.current = histData;
  }, [histData]);

  const selectedSymbol = useMemo(
    () => allSymbols.find(item => item.sym.toUpperCase() === symbol.toUpperCase()) ?? null,
    [allSymbols, symbol],
  );

  useEffect(() => {
    if (selectedSymbol) {
      setExchange(selectedSymbol.exchange);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    if (allSymbols.length === 0) return;
    const preferred = allSymbols.find(item => item.sym.toUpperCase() === DEFAULT_SCRIP) ?? allSymbols[0];
    if (!preferred) return;
    setSymbol(preferred.sym);
    setExchange(preferred.exchange);
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
        setExpiries(nextExpiries);
        setSelectedExpiries(prev => prev.map((value, idx) => (nextExpiries.includes(value) ? value : nextExpiries[idx] ?? '')));
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
        const chainMap = Object.fromEntries(entries);
        setChains(chainMap);
        // Seed OI / vol / delta trend from REST snapshot
        const totalCe  = entries.reduce((sum, [, snap]) => sum + snap.rows.reduce((s, r) => s + r.ce.oi, 0), 0);
        const totalPe  = entries.reduce((sum, [, snap]) => sum + snap.rows.reduce((s, r) => s + r.pe.oi, 0), 0);
        const totalCeV = entries.reduce((sum, [, snap]) => sum + snap.rows.reduce((s, r) => s + r.ce.volume, 0), 0);
        const totalPeV = entries.reduce((sum, [, snap]) => sum + snap.rows.reduce((s, r) => s + r.pe.volume, 0), 0);
        const totalCeD = entries.reduce((sum, [, snap]) => sum + snap.rows.reduce((s, r) => s + Math.abs((r.ce.delta || 0) * (r.ce.oi || 0)), 0), 0);
        const totalPeD = entries.reduce((sum, [, snap]) => sum + snap.rows.reduce((s, r) => s + Math.abs((r.pe.delta || 0) * (r.pe.oi || 0)), 0), 0);
        if (totalCe > 0 || totalPe > 0)   setSummaryOiTrendHistory(prev => appendSummaryTrendPoint(prev, totalCe, totalPe));
        if (totalCeV > 0 || totalPeV > 0) setSummaryVolTrendHistory(prev => appendSummaryTrendPoint(prev, totalCeV, totalPeV));
        if (totalCeD > 0 || totalPeD > 0) setSummaryDeltaTrendHistory(prev => appendSummaryTrendPoint(prev, totalCeD, totalPeD));
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load cumulative chain');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadChains();
    return () => { cancelled = true; };
  }, [symbol, pickedExpiries, nubraInstruments]);

  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const session = getSession();
    const resolved = resolveNubra(symbol, nubraInstruments);
    if (!session || !resolved.nubraSym || pickedExpiries.length === 0 || !isMarketOpen()) return;

    const ws = new WebSocket(BRIDGE);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        action: 'subscribe',
        session_token: session,
        data_type: 'option',
        symbols: pickedExpiries.map(expiry => `${resolved.nubraSym}:${expiry}`),
        exchange: resolved.exchange,
      }));
    };
    ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== 'option' || !msg.data?.expiry) return;
        const expiry = String(msg.data.expiry);
        const live = buildChainSnapshotWs(msg.data.ce ?? [], msg.data.pe ?? [], msg.data.at_the_money_strike ?? 0, msg.data.current_price ?? 0);
        setChains(prev => {
          const next = { ...prev, [expiry]: mergeChainSnapshot(prev[expiry], live) };
          // Append OI / vol / delta trend from merged chains
          const totalCe  = Object.values(next).reduce((sum, snap) => sum + snap.rows.reduce((s, r) => s + r.ce.oi, 0), 0);
          const totalPe  = Object.values(next).reduce((sum, snap) => sum + snap.rows.reduce((s, r) => s + r.pe.oi, 0), 0);
          const totalCeV = Object.values(next).reduce((sum, snap) => sum + snap.rows.reduce((s, r) => s + r.ce.volume, 0), 0);
          const totalPeV = Object.values(next).reduce((sum, snap) => sum + snap.rows.reduce((s, r) => s + r.pe.volume, 0), 0);
          const totalCeD = Object.values(next).reduce((sum, snap) => sum + snap.rows.reduce((s, r) => s + Math.abs((r.ce.delta || 0) * (r.ce.oi || 0)), 0), 0);
          const totalPeD = Object.values(next).reduce((sum, snap) => sum + snap.rows.reduce((s, r) => s + Math.abs((r.pe.delta || 0) * (r.pe.oi || 0)), 0), 0);
          if (totalCe > 0 || totalPe > 0)   setSummaryOiTrendHistory(prev => appendSummaryTrendPoint(prev, totalCe, totalPe));
          if (totalCeV > 0 || totalPeV > 0) setSummaryVolTrendHistory(prev => appendSummaryTrendPoint(prev, totalCeV, totalPeV));
          if (totalCeD > 0 || totalPeD > 0) setSummaryDeltaTrendHistory(prev => appendSummaryTrendPoint(prev, totalCeD, totalPeD));
          return next;
        });
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [symbol, pickedExpiries, nubraInstruments]);

  // ── Historical delta×OI fetch ───────────────────────────────────────────────
  // Fires when showHistory toggled on, date changes, or rows/expiries change
  const resolved = useMemo(() => resolveNubra(symbol, nubraInstruments), [symbol, nubraInstruments]);

  const loadHistoryRequests = useCallback(async (requests: HistoryRequest[], forDate: string, forIsLive: boolean) => {
    if (requests.length === 0) return;

    const concurrency = 6;
    let cursor = 0;

    const worker = async () => {
      while (cursor < requests.length) {
        const current = requests[cursor++];
        // Abort if date changed while we were running
        if (histDateRef.current !== forDate) return;
        if (histPendingRef.current.has(current.key)) continue;

        const stockName = findOptStockName(nubraInstruments, resolved.nubraSym, current.expiry, current.strike, current.side);
        if (!stockName) continue;

        histPendingRef.current.add(current.key);
        try {
          const result = await fetchStrikeSeries(resolved.exchange, stockName, forDate, forIsLive);
          if (histDateRef.current === forDate) {
            const series = buildStrikeHistorySeries(result);
            // Cache result even if empty — prevents infinite retry on 403/empty
            histDataRef.current[current.key] = series;
            setHistData(prev => ({ ...prev, [current.key]: series }));
          }
        } catch {
          // Mark as attempted so we don't retry endlessly
          if (histDateRef.current === forDate) {
            histDataRef.current[current.key] = EMPTY_HISTORY_SERIES;
          }
        } finally {
          histPendingRef.current.delete(current.key);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()));
  }, [nubraInstruments, resolved.nubraSym, resolved.exchange]);


  // Reset hist data when symbol/expiry/date changes — clear synchronously before next fetch runs
  useEffect(() => {
    histDateRef.current = histDate;
    histPendingRef.current.clear();
    histDataRef.current = {};
    setHistData({});
  }, [symbol, pickedExpiries.join(','), histDate]);

  // Reset OI / vol / delta trend when symbol or expiry changes
  useEffect(() => {
    setSummaryOiTrendHistory([]);
    setSummaryVolTrendHistory([]);
    setSummaryDeltaTrendHistory([]);
  }, [symbol, pickedExpiries.join(',')]);

  // Fetch OI + vol history from Nubra timeseries on mount / symbol / expiry change
  useEffect(() => {
    let cancelled = false;
    const resolved2 = resolveNubra(symbol, nubraInstruments);
    if (!resolved2.nubraSym || !resolved2.exchange || pickedExpiries.length === 0) return;

    const chainValues = pickedExpiries.map(exp => buildNubraChainValue(resolved2.nubraSym, exp));
    const now = toIstNow();
    // Match MasterOptionChain: startDate = 09:15 IST, endDate = current minute IST
    const startDate = istToUtcIsoLocal(histDate, '09:15');
    const endDate   = istToUtcIsoLocal(now.date, now.time);
    const cacheKey  = [resolved2.nubraSym, resolved2.exchange, pickedExpiries.join(','), histDate, now.time.slice(0, 5)].join('|');

    const load = async () => {
      // OI history
      const oiCached = summaryOiHistoryCacheRef.current.get(cacheKey);
      if (oiCached) {
        if (!cancelled) setSummaryOiTrendHistory(oiCached);
      } else {
        try {
          const oiHist = await fetchChainOiHistory(resolved2.exchange, chainValues, startDate, endDate);
          if (!cancelled) {
            summaryOiHistoryCacheRef.current.set(cacheKey, oiHist);
            setSummaryOiTrendHistory(oiHist);
          }
        } catch { /* ignore */ }
      }

      // Vol history
      const volCached = summaryVolHistoryCacheRef.current.get(cacheKey);
      if (volCached) {
        if (!cancelled) setSummaryVolTrendHistory(volCached);
      } else {
        try {
          const volHist = await fetchChainVolHistory(resolved2.exchange, chainValues, startDate, endDate);
          if (!cancelled) {
            summaryVolHistoryCacheRef.current.set(cacheKey, volHist);
            setSummaryVolTrendHistory(volHist);
          }
        } catch { /* ignore */ }
      }
    };

    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, pickedExpiries.join(','), histDate, histIsLive, nubraInstruments]);

  // ── Live WS append into popup histData ───────────────────────────────────────
  // When the strike popup is open and market is live, append CE/PE OI + delta×OI
  // from the latest WS chains tick into histData using 1-min bucket logic.
  useEffect(() => {
    if (!popupCell || !histIsLive) return;
    const { strike } = popupCell;

    setHistData(prev => {
      let changed = false;
      const next = { ...prev };

      for (const expiry of pickedExpiries) {
        const row = chains[expiry]?.rows.find(r => r.strike === strike);
        if (!row) continue;

        const ceKey = `${strike}:${expiry}:CE`;
        const peKey = `${strike}:${expiry}:PE`;

        const ceOi      = row.ce.oi;
        const peOi      = row.pe.oi;
        const ceDelta   = row.ce.delta;
        const peDelta   = row.pe.delta;
        const ceDeltaOi = Math.abs(ceDelta) * ceOi;
        const peDeltaOi = Math.abs(peDelta) * peOi;

        if (ceOi > 0 || ceDeltaOi > 0) {
          const prev = next[ceKey] ?? EMPTY_HISTORY_SERIES;
          const oi      = appendTsPoint(prev.oi,      ceOi);
          const delta   = appendTsPoint(prev.delta,   ceDelta);
          const deltaOi = appendTsPoint(prev.deltaOi, ceDeltaOi);
          next[ceKey] = { oi, delta, deltaOi };
          changed = true;
        }

        if (peOi > 0 || peDeltaOi > 0) {
          const prev = next[peKey] ?? EMPTY_HISTORY_SERIES;
          const oi      = appendTsPoint(prev.oi,      peOi);
          const delta   = appendTsPoint(prev.delta,   peDelta);
          const deltaOi = appendTsPoint(prev.deltaOi, peDeltaOi);
          next[peKey] = { oi, delta, deltaOi };
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains]);  // fires every WS tick — popupCell/pickedExpiries/histIsLive read from closure


  const baseExpiry = pickedExpiries[0] ?? '';
  const primaryChain = baseExpiry ? chains[baseExpiry] : null;
  const availableStrikes = useMemo(
    () => (primaryChain?.rows ?? []).map(row => row.strike),
    [primaryChain],
  );

  useEffect(() => {
    if (availableStrikes.length === 0) {
      setCustomStrikes([]);
      return;
    }
    setCustomStrikes(prev => prev.filter(strike => availableStrikes.includes(strike)));
  }, [availableStrikes]);

  const rows = useMemo(() => {
    if (!primaryChain || primaryChain.rows.length === 0) return [];
    const allRows = primaryChain.rows;
    const atmIdx = nearestStrikeIndex(allRows, primaryChain.atm || primaryChain.spot);
    const start = Math.max(0, atmIdx - strikeCount);
    const end = Math.min(allRows.length, atmIdx + strikeCount + 1);
    const windowStrikes = allRows.slice(start, end).map(row => row.strike);
    const strikesToRender = strikeViewMode === 'custom'
      ? [...customStrikes].sort((a, b) => a - b)
      : windowStrikes;

    return strikesToRender.map(strike => {
      const expiryBreakdown: ExpiryColumn[] = pickedExpiries.map(expiry => {
        const row = chains[expiry]?.rows.find(item => item.strike === strike);
        const rawCeOi = row?.ce.oi ?? 0;
        const rawPeOi = row?.pe.oi ?? 0;
        const ceDelta = row?.ce.delta ?? 0;
        const peDelta = row?.pe.delta ?? 0;
        return {
          expiry,
          ceOi: deltaOi ? ceDelta * rawCeOi : rawCeOi,
          peOi: deltaOi ? Math.abs(peDelta) * rawPeOi : rawPeOi,
        };
      });

      const totalCeOi = expiryBreakdown.reduce((sum, item) => sum + item.ceOi, 0);
      const totalPeOi = expiryBreakdown.reduce((sum, item) => sum + item.peOi, 0);
      const totalOi = totalCeOi + totalPeOi;
      const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : 0;

      return {
        strike,
        isAtm: Math.abs(strike - (primaryChain.atm || primaryChain.spot)) < 0.5,
        expiryBreakdown,
        totalCeOi,
        totalPeOi,
        totalOi,
        pcr,
      };
    });
  }, [chains, customStrikes, deltaOi, pickedExpiries, primaryChain, strikeCount, strikeViewMode]);

  // Chart data — CE delta×OI and PE delta×OI per strike, from the primary expiry
  const chartRows = useMemo<ChartRow[]>(() => {
    if (!primaryChain || primaryChain.rows.length === 0) return [];
    const allRows = primaryChain.rows;
    const atmIdx = nearestStrikeIndex(allRows, primaryChain.atm || primaryChain.spot);
    const start = Math.max(0, atmIdx - strikeCount);
    const end = Math.min(allRows.length, atmIdx + strikeCount + 1);
    return allRows.slice(start, end).map(row => ({
      strike: row.strike,
      isAtm: Math.abs(row.strike - (primaryChain.atm || primaryChain.spot)) < 0.5,
      ceDeltaOi: Math.abs(row.ce.delta) * row.ce.oi,
      peDeltaOi: Math.abs(row.pe.delta) * row.pe.oi,
    }));
  }, [primaryChain, strikeCount]);

  const summaryTotals = useMemo(() => {
    let callOi = 0; let putOi = 0;
    let callVolume = 0; let putVolume = 0;
    let callDelta = 0; let putDelta = 0;
    for (const snap of Object.values(chains)) {
      for (const row of snap.rows) {
        callOi     += row.ce.oi;
        putOi      += row.pe.oi;
        callVolume += row.ce.volume;
        putVolume  += row.pe.volume;
        callDelta  += Math.abs((row.ce.delta || 0) * (row.ce.oi || 0));
        putDelta   += Math.abs((row.pe.delta || 0) * (row.pe.oi || 0));
      }
    }
    const baseCall = summaryOiTrendHistory[0]?.call ?? callOi;
    const basePut  = summaryOiTrendHistory[0]?.put  ?? putOi;
    const callOiChg = callOi - baseCall;
    const putOiChg  = putOi  - basePut;
    return { callOi, putOi, callOiChg, putOiChg, callVolume, putVolume, callDelta, putDelta };
  }, [chains, summaryOiTrendHistory]);

  // Fetch all picked expiries for a strike on demand
  const fetchStrikeOnDemand = useCallback(async (strike: number) => {
    const currentDate = histDateRef.current;
    const requests: HistoryRequest[] = [];
    for (const expiry of pickedExpiries) {
      for (const side of ['CE', 'PE'] as const) {
        const key = `${strike}:${expiry}:${side}`;
        if (histDataRef.current[key] || histPendingRef.current.has(key)) continue;
        requests.push({ key, expiry, strike, side });
      }
    }
    if (requests.length > 0) {
      await loadHistoryRequests(requests, currentDate, histIsLive);
    }
  }, [pickedExpiries, loadHistoryRequests, histIsLive]);

  // Reset allExpiryOi when symbol changes
  useEffect(() => { setAllExpiryOi({}); }, [symbol]);

  const fetchAllExpiryOiForStrike = useCallback(async (strike: number) => {
    if (expiries.length === 0) return;
    setAllExpiryOi(prev => ({ ...prev, [strike]: 'loading' }));
    const session = getSession();
    const res = resolveNubra(symbol, nubraInstruments);
    try {
      const snapshots = await Promise.all(
        expiries.map(exp => fetchOptionChainSnapshot(session, res.nubraSym, res.exchange, exp).catch(() => null)),
      );
      let totalCeOi = 0;
      let totalPeOi = 0;
      for (const snap of snapshots) {
        if (!snap) continue;
        const r = snap.rows.find(row => Math.abs(row.strike - strike) < 0.5);
        if (r) { totalCeOi += r.ce.oi; totalPeOi += r.pe.oi; }
      }
      const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : 0;
      setAllExpiryOi(prev => ({ ...prev, [strike]: { totalCeOi, totalPeOi, pcr } }));
    } catch {
      setAllExpiryOi(prev => { const next = { ...prev }; delete next[strike]; return next; });
    }
  }, [expiries, symbol, nubraInstruments]);

  // Per-expiry max CE/PE OI across all strikes — for progress bar scaling within each expiry column
  const maxPerExpiry = useMemo(() => {
    const result: Record<string, { ce: number; pe: number }> = {};
    for (const exp of pickedExpiries) {
      let maxCe = 1, maxPe = 1;
      for (const row of rows) {
        const item = row.expiryBreakdown.find(b => b.expiry === exp);
        if (item) { maxCe = Math.max(maxCe, item.ceOi); maxPe = Math.max(maxPe, item.peOi); }
      }
      result[exp] = { ce: maxCe, pe: maxPe };
    }
    return result;
  }, [rows, pickedExpiries]);

  const handleExpiryChange = useCallback((index: number, nextExpiry: string) => {
    setSelectedExpiries(prev => prev.map((value, idx) => (idx === index ? nextExpiry : value)));
  }, []);

  const toggleCustomStrike = useCallback((strike: number) => {
    setCustomStrikes(prev => (
      prev.includes(strike) ? prev.filter(item => item !== strike) : [...prev, strike]
    ));
  }, []);

  const spotLabel = primaryChain?.spot ? `${primaryChain.spot.toFixed(2)} spot` : 'No live spot';
  const perExpiryCols = selectedMetric === 'oi' ? 4 : 2;
  const openPopupForCell = useCallback((strike: number, expiry: string) => {
    setPopupCell({ strike, expiry });
    void fetchStrikeOnDemand(strike); // fetch all picked expiries
  }, [fetchStrikeOnDemand]);

  const renderCellValue = useCallback((
    side: 'CE' | 'PE',
    expiry: string,
    strike: number,
    value: string,
    className: string,
  ) => {
    const key = `${strike}:${expiry}:${side}`;
    const history = histData[key] ?? EMPTY_HISTORY_SERIES;
    const color = side === 'CE' ? '#38d4c8' : '#f59e0b';

    return (
      <td key={`${side.toLowerCase()}-${expiry}-${strike}`} className={className}>
        <button
          type="button"
          className={s.metricCellButton}
          title={`Open ${side} history chart`}
          onClick={() => openPopupForCell(strike, expiry)}
        >
          <span className={s.metricCellValue}>{value}</span>
          <CellSparkline points={history.deltaOi} color={color} faint={history.deltaOi.length === 0} />
        </button>
      </td>
    );
  }, [histData, openPopupForCell]);

  return (
    <div className={s.root} style={{ display: visible === false ? 'none' : 'flex' }}>
      <div className={s.toolbar}>
        <SearchableScripSelect value={symbol} options={allSymbols} onChange={setSymbol} disabled={allSymbols.length === 0} />
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
          formatter={value => `ATM ± ${value}`}
          disabled={strikeViewMode === 'custom'}
        />
        <SelectControl
          label="Strike View"
          value={strikeViewMode}
          options={['atm', 'custom']}
          onChange={next => setStrikeViewMode(next as StrikeViewMode)}
          formatter={value => (value === 'custom' ? 'Custom' : 'ATM Window')}
        />
        <StrikeMultiSelect
          options={availableStrikes}
          selected={customStrikes}
          onToggle={toggleCustomStrike}
          disabled={strikeViewMode !== 'custom'}
        />
        <SelectControl
          label="Column"
          value={selectedMetric}
          options={METRIC_OPTIONS}
          onChange={next => setSelectedMetric(next as MetricKey)}
          formatter={value => metricLabel(value as MetricKey)}
        />
        <label className={s.toggleChip}>
          <input
            type="checkbox"
            checked={deltaOi}
            onChange={e => setDeltaOi(e.target.checked)}
            className={s.toggleInput}
          />
          <span className={`${s.toggleTrack} ${deltaOi ? s.toggleTrackOn : ''}`}>
            <span className={s.toggleThumb} />
          </span>
          <span className={s.toggleLabel}>Delta OI</span>
        </label>
        <div className={s.infoChip}>
          <span className={s.infoDot} />
          <span>{spotLabel}</span>
        </div>
        <button
          type="button"
          style={{ cursor: 'pointer', border: 'none', background: showChart ? 'rgba(56,212,200,0.15)' : 'rgba(255,255,255,0.06)', borderRadius: 6, padding: '4px 10px', color: showChart ? '#38d4c8' : '#8896a8', fontSize: 11, fontWeight: 600 }}
          onClick={() => setShowChart(v => !v)}
        >
          {showChart ? '▲ Hide Chart' : '▼ Delta OI Chart'}
        </button>
      </div>

      {error && <div className={s.bannerError}>{error}</div>}
      {!error && loading && <div className={s.bannerInfo}>Loading cumulative OI chain...</div>}
      {!loading && !error && pickedExpiries.length === 0 && <div className={s.bannerInfo}>Select at least one expiry</div>}

      {pickedExpiries.length > 0 && (
        <section className={s.summarySection}>
          <SummaryCard
            title="Open Interest"
            subtitle="Total CE OI vs PE OI"
            callValue={summaryTotals.callOi}
            putValue={summaryTotals.putOi}
            callChgValue={summaryTotals.callOiChg}
            putChgValue={summaryTotals.putOiChg}
            pcr={summaryTotals.callOi > 0 ? summaryTotals.putOi / summaryTotals.callOi : 0}
            formatValue={fmtOi}
            ringMode="standard"
            trendHistory={summaryOiTrendHistory}
            trendChgHistory={summaryOiChgHistory}
          />
          <SummaryCard
            title="OI Change"
            subtitle="CE vs PE OI change from day open"
            callValue={summaryTotals.callOiChg}
            putValue={summaryTotals.putOiChg}
            pcr={summaryTotals.callOiChg !== 0 ? summaryTotals.putOiChg / summaryTotals.callOiChg : 0}
            formatValue={fmtOi}
            ringMode="signed"
            trendHistory={summaryOiChgHistory}
          />
          <SummaryCard
            title="Volume"
            subtitle="Total CE volume vs PE volume"
            callValue={summaryTotals.callVolume}
            putValue={summaryTotals.putVolume}
            pcr={summaryTotals.callVolume > 0 ? summaryTotals.putVolume / summaryTotals.callVolume : 0}
            formatValue={fmtOi}
            ringMode="standard"
            trendHistory={summaryVolTrendHistory}
          />
          <SummaryCard
            title="Delta OI"
            subtitle="Absolute delta exposure from OI"
            callValue={summaryTotals.callDelta}
            putValue={summaryTotals.putDelta}
            pcr={summaryTotals.callDelta > 0 ? summaryTotals.putDelta / summaryTotals.callDelta : 0}
            formatValue={fmtMetricCompact}
            ringMode="standard"
            trendHistory={summaryDeltaTrendHistory}
          />
        </section>
      )}

      {showChart && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          <div style={{ height: 340, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)' }}>
            <DeltaOiChart chartRows={chartRows} spot={primaryChain?.spot ?? 0} />
          </div>
          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)' }}>
            <OiTrendChart history={summaryOiTrendHistory} />
          </div>
        </div>
      )}

      {false && (
        <div>
        </div>
      )}

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr className={s.superHead}>
              <th rowSpan={2} className={s.strikeHead}>Strike</th>
              {pickedExpiries.map(expiry => (
                <th key={expiry} colSpan={perExpiryCols} className={s.expiryHead}>{fmtExpiry(expiry)}</th>
              ))}
              <th rowSpan={2} className={s.totalCeHead} title="Click a row cell to load across all expiries">{deltaOi ? 'Total CE Delta OI' : 'Total CE OI'} (All Exp)</th>
              <th rowSpan={2} className={s.totalPeHead} title="Click a row cell to load across all expiries">{deltaOi ? 'Total PE Delta OI' : 'Total PE OI'} (All Exp)</th>
              <th rowSpan={2} className={s.totalOiHead}>{deltaOi ? 'Total Delta OI' : 'Total OI'} (All Exp)</th>
              <th rowSpan={2} className={s.totalOiHead}>PCR (All Exp)</th>
            </tr>
            <tr className={s.metricHeadRow}>
              {pickedExpiries.flatMap(expiry => (
                selectedMetric === 'oi'
                  ? [
                      <th key={`ce-${expiry}`} className={s.metricHead}>{deltaOi ? 'CE Delta OI' : 'CE OI'}</th>,
                      <th key={`cechg-${expiry}`} className={s.metricHead}>CE OI chg%</th>,
                      <th key={`pe-${expiry}`} className={s.metricHead}>{deltaOi ? 'PE Delta OI' : 'PE OI'}</th>,
                      <th key={`pechg-${expiry}`} className={s.metricHead}>PE OI chg%</th>,
                    ]
                  : [
                      <th key={`ce-${expiry}`} className={s.metricHead}>CE {metricLabel(selectedMetric)}</th>,
                      <th key={`pe-${expiry}`} className={s.metricHead}>PE {metricLabel(selectedMetric)}</th>,
                    ]
              ))}
              </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={(pickedExpiries.length * perExpiryCols) + 5} className={s.emptyCell}>
                  {loading ? 'Loading rows...' : (strikeViewMode === 'custom' && customStrikes.length === 0 ? 'Select custom strikes to view data' : 'No cumulative OI data available')}
                </td>
              </tr>
            ) : rows.map(row => {
              return (
                <tr key={row.strike} className={row.isAtm ? s.atmRow : ''}>
                  <td
                    className={`${s.strikeCell} ${row.isAtm ? s.strikeCellAtm : ''}`}
                    style={{ cursor: 'pointer' }}
                    title="Click to view CE Delta×OI history"
                    onClick={() => openPopupForCell(row.strike, row.expiryBreakdown[0]?.expiry ?? pickedExpiries[0])}
                  >
                    {row.isAtm && <span className={s.atmPill}>ATM</span>}
                    <span className={row.isAtm ? s.strikeValAtm : s.strikeVal}>{row.strike.toFixed(0)}</span>
                  </td>
                  {row.expiryBreakdown.flatMap(item => {
                    const ceSource = chains[item.expiry]?.rows.find(entry => entry.strike === row.strike)?.ce ?? EMPTY_SIDE;
                    const peSource = chains[item.expiry]?.rows.find(entry => entry.strike === row.strike)?.pe ?? EMPTY_SIDE;
                    if (selectedMetric === 'oi') {
                      const expMax = maxPerExpiry[item.expiry] ?? { ce: 1, pe: 1 };
                      const ceFill = Math.min(100, (item.ceOi / expMax.ce) * 100).toFixed(1);
                      const peFill = Math.min(100, (item.peOi / expMax.pe) * 100).toFixed(1);
                      return [
                        <td key={`ce-${item.expiry}-${row.strike}`} className={s.ceCell}>
                          <button
                            type="button"
                            className={s.metricCellButton}
                            title="Open CE history chart"
                            onClick={() => openPopupForCell(row.strike, item.expiry)}
                          >
                            <div className={s.barCell}>
                              <div className={s.barTrackCe} style={{ width: `${ceFill}%` }} />
                              <span className={s.barLabel}>{fmtOi(item.ceOi)}</span>
                            </div>
                            <CellSparkline points={histData[`${row.strike}:${item.expiry}:CE`]?.deltaOi ?? []} color="#38d4c8" faint={!histData[`${row.strike}:${item.expiry}:CE`]?.deltaOi.length} />
                          </button>
                        </td>,
                        <td key={`cechg-${item.expiry}-${row.strike}`} className={`${s.chgCell} ${ceSource.oiChgPct >= 0 ? s.upText : s.downText}`}>{fmtPct(ceSource.oiChgPct)}</td>,
                        <td key={`pe-${item.expiry}-${row.strike}`} className={s.peCell}>
                          <button
                            type="button"
                            className={s.metricCellButton}
                            title="Open PE history chart"
                            onClick={() => openPopupForCell(row.strike, item.expiry)}
                          >
                            <div className={s.barCell}>
                              <div className={s.barTrackPe} style={{ width: `${peFill}%` }} />
                              <span className={s.barLabel}>{fmtOi(item.peOi)}</span>
                            </div>
                            <CellSparkline points={histData[`${row.strike}:${item.expiry}:PE`]?.deltaOi ?? []} color="#f59e0b" faint={!histData[`${row.strike}:${item.expiry}:PE`]?.deltaOi.length} />
                          </button>
                        </td>,
                        <td key={`pechg-${item.expiry}-${row.strike}`} className={`${s.chgCell} ${peSource.oiChgPct >= 0 ? s.upText : s.downText}`}>{fmtPct(peSource.oiChgPct)}</td>,
                      ];
                    }
                    const ceVal = formatMetric(selectedMetric, ceSource[selectedMetric]);
                    const peVal = formatMetric(selectedMetric, peSource[selectedMetric]);
                    return [
                      renderCellValue('CE', item.expiry, row.strike, ceVal.main, s.ceCell),
                      renderCellValue('PE', item.expiry, row.strike, peVal.main, s.peCell),
                    ];
                  })}
                  {(() => {
                    const allExp = allExpiryOi[row.strike];
                    const isLoading = allExp === 'loading';
                    const allData = typeof allExp === 'object' ? allExp : null;
                    const dispCeOi = allData ? allData.totalCeOi : row.totalCeOi;
                    const dispPeOi = allData ? allData.totalPeOi : row.totalPeOi;
                    const dispTotalOi = dispCeOi + dispPeOi;
                    const dispPcr = allData ? allData.pcr : row.pcr;
                    const allMaxCe = Math.max(1, ...rows.map(r => {
                      const a = allExpiryOi[r.strike];
                      return typeof a === 'object' ? a.totalCeOi : r.totalCeOi;
                    }));
                    const allMaxPe = Math.max(1, ...rows.map(r => {
                      const a = allExpiryOi[r.strike];
                      return typeof a === 'object' ? a.totalPeOi : r.totalPeOi;
                    }));
                    const allMaxTotal = Math.max(1, ...rows.map(r => {
                      const a = allExpiryOi[r.strike];
                      return typeof a === 'object' ? a.totalCeOi + a.totalPeOi : r.totalOi;
                    }));
                    const cePctAll = Math.max(0, Math.min(100, (dispCeOi / allMaxCe) * 100));
                    const pePctAll = Math.max(0, Math.min(100, (dispPeOi / allMaxPe) * 100));
                    const totalPctAll = Math.max(0, Math.min(100, (dispTotalOi / allMaxTotal) * 100));
                    const needsFetch = !allExp;
                    const openTotalChart = () => openPopupForCell(row.strike, row.expiryBreakdown[0]?.expiry ?? pickedExpiries[0]);
                    return (<>
                      <td
                        className={s.totalCeCell}
                        style={{ cursor: 'pointer' }}
                        title={needsFetch ? 'Click to view OI history (all expiries)' : 'Click to view OI history (all expiries)'}
                        onClick={() => { if (needsFetch) void fetchAllExpiryOiForStrike(row.strike); openTotalChart(); }}
                      >
                        <div className={`${s.oiBar} ${s.oiBarCe}`} style={{ ['--oi-fill' as string]: `${cePctAll.toFixed(1)}%` }}>
                          <span className={s.oiBarText}>{isLoading ? '…' : fmtOi(dispCeOi)}</span>
                        </div>
                      </td>
                      <td
                        className={s.totalPeCell}
                        style={{ cursor: 'pointer' }}
                        title="Click to view OI history (all expiries)"
                        onClick={() => { if (needsFetch) void fetchAllExpiryOiForStrike(row.strike); openTotalChart(); }}
                      >
                        <div className={`${s.oiBar} ${s.oiBarPe}`} style={{ ['--oi-fill' as string]: `${pePctAll.toFixed(1)}%` }}>
                          <span className={s.oiBarText}>{isLoading ? '…' : fmtOi(dispPeOi)}</span>
                        </div>
                      </td>
                      <td className={s.totalOiCell} style={{ cursor: 'pointer' }} title="Click to view OI history (all expiries)" onClick={openTotalChart}>
                        <div className={`${s.oiBar} ${s.oiBarTotal}`} style={{ ['--oi-fill' as string]: `${totalPctAll.toFixed(1)}%` }}>
                          <span className={s.oiBarText}>{isLoading ? '…' : fmtOi(dispTotalOi)}</span>
                        </div>
                      </td>
                      <td className={s.totalOiCell} style={{ cursor: 'pointer' }} title="Click to view OI history (all expiries)" onClick={openTotalChart}>{isLoading ? '…' : (dispPcr > 0 ? dispPcr.toFixed(2) : '—')}</td>
                    </>);
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Strike popup */}
      {popupCell !== null && (() => {
        const strike = popupCell.strike;
        const isPending = pickedExpiries.some(exp =>
          histPendingRef.current.has(`${strike}:${exp}:CE`) ||
          histPendingRef.current.has(`${strike}:${exp}:PE`)
        );
        const popupRow = rows.find(r => r.strike === strike);
        // Merge all expiries into single CE and PE lines
        const mergedCeDeltaOi = sumTsPointSeries(pickedExpiries.map(exp => histData[`${strike}:${exp}:CE`]?.deltaOi ?? []));
        const mergedPeDeltaOi = sumTsPointSeries(pickedExpiries.map(exp => histData[`${strike}:${exp}:PE`]?.deltaOi ?? []));
        const mergedCeOi = sumTsPointSeries(pickedExpiries.map(exp => histData[`${strike}:${exp}:CE`]?.oi ?? []));
        const mergedPeOi = sumTsPointSeries(pickedExpiries.map(exp => histData[`${strike}:${exp}:PE`]?.oi ?? []));
        // PCR = Total PE OI / Total CE OI at each timestamp
        const ceOiMap = new Map(mergedCeOi.map(p => [p.ts, p.v]));
        const pcrPoints: TsPoint[] = mergedPeOi
          .map(p => ({ ts: p.ts, v: (ceOiMap.get(p.ts) ?? 0) > 0 ? p.v / (ceOiMap.get(p.ts) ?? 1) : 0 }))
          .filter(p => p.v > 0);
        const deltaOiSeries: PopupSeries[] = [
          { label: 'CE Δ×OI', color: '#38d4c8', points: mergedCeDeltaOi },
          { label: 'PE Δ×OI', color: '#f59e0b', points: mergedPeDeltaOi },
        ];
        const oiSeries: PopupSeries[] = [
          { label: 'CE OI', color: '#38d4c8', points: mergedCeOi },
          { label: 'PE OI', color: '#f59e0b', points: mergedPeOi },
        ];
        return (
          <StrikeDetailPopup
            strike={strike}
            expiry={popupCell.expiry}
            isAtm={popupRow?.isAtm ?? false}
            deltaOiSeries={deltaOiSeries}
            oiSeries={oiSeries}
            pcrSeries={[{ label: 'PCR', color: '#a78bfa', points: pcrPoints }]}
            loading={isPending}
            date={histDate}
            onDateChange={d => {
              handleHistDateChange(d);
              histDateRef.current = d;
              histDataRef.current = {};
              histPendingRef.current.clear();
              setHistData({});
              const isLive = d === todayIst() && isMarketOpen();
              void loadHistoryRequests(
                pickedExpiries.flatMap(exp => ([
                  { key: `${strike}:${exp}:CE`, expiry: exp, strike, side: 'CE' as const },
                  { key: `${strike}:${exp}:PE`, expiry: exp, strike, side: 'PE' as const },
                ])),
                d, isLive,
              );
            }}
            onClose={() => setPopupCell(null)}
          />
        );
      })()}
    </div>
  );
}
