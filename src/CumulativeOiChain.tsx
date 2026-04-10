'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
};

const BRIDGE = 'ws://localhost:8765';
const DEFAULT_SCRIP = 'NIFTY';
const STRIKE_WINDOW_OPTIONS = [5, 10, 15, 20];
const HISTORY_BATCH_SIZE = 5;
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

function formatMetric(metric: MetricKey, value: number, oiChgPct = 0) {
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

// ── Historical helpers ────────────────────────────────────────────────────────
function todayIst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function istToUtcIso(date: string, hhmm: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const msUtc = Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0, 0);
  return new Date(msUtc).toISOString();
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
  date: string,        // YYYY-MM-DD
): Promise<{ oi: TsPoint[]; delta: TsPoint[] }> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const authToken = localStorage.getItem('nubra_auth_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? '';

  const isToday = date === todayIst();
  const nowIst = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5);
  const startDate = istToUtcIso(date, '09:15');
  const endDate   = istToUtcIso(date, isToday ? nowIst : '15:30');

  const body = {
    session_token: sessionToken,
    auth_token: authToken,
    device_id: deviceId,
    exchange,
    type: 'OPT',
    values: [stockName],
    fields: ['cumulative_oi', 'delta'],
    startDate,
    endDate,
    interval: '1m',
    intraDay: false,
  };

  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  const parse = (arr: any[]): TsPoint[] =>
    (Array.isArray(arr) ? arr : [])
      .map((p: any) => ({
        ts: Math.round(Number(p.ts ?? p.timestamp ?? 0) / 1e6),  // ns → ms
        v: Number(p.v ?? p.value ?? 0),
      }))
      .filter((p: TsPoint) => p.ts > 0 && isFinite(p.v));

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

// ── Per-strike historical line chart (canvas) ─────────────────────────────────
interface StrikeHistData {
  // key = `${expiry}:CE` or `${expiry}:PE`
  [key: string]: TsPoint[];  // deltaOi = delta × oi computed here
}

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

function drawLineChart(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  series: Array<{ label: string; color: string; points: TsPoint[] }>,
  strike: number,
  isAtm: boolean,
) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const PAD = { t: 18, b: 22, l: 52, r: 8 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  // strike label
  ctx.fillStyle = isAtm ? '#fbbf24' : '#8896a8';
  ctx.font = isAtm ? 'bold 10px sans-serif' : '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${strike.toFixed(0)}${isAtm ? ' ⚡ATM' : ''}`, 4, 13);

  const allPts = series.flatMap(s => s.points);
  if (allPts.length === 0) {
    ctx.fillStyle = '#445';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', W / 2, H / 2);
    return;
  }

  const minTs = Math.min(...allPts.map(p => p.ts));
  const maxTs = Math.max(...allPts.map(p => p.ts));
  const minV  = Math.min(...allPts.map(p => p.v));
  const maxV  = Math.max(...allPts.map(p => p.v));
  const rangeTs = maxTs - minTs || 1;
  const rangeV  = maxV - minV || 1;

  const tx = (ts: number) => PAD.l + ((ts - minTs) / rangeTs) * plotW;
  const ty = (v: number) => PAD.t + plotH - ((v - minV) / rangeV) * plotH;

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    const val = maxV - (i / 4) * rangeV;
    ctx.fillStyle = '#556'; ctx.font = '8px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(fmtOi(val), PAD.l - 2, y + 3);
  }

  // time labels
  ctx.fillStyle = '#556'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
  const tFmt = (ms: number) => {
    const d = new Date(ms);
    const h = d.getUTCHours() + 5;
    const m = d.getUTCMinutes() + 30;
    return `${String(h + Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
  };
  [minTs, (minTs + maxTs) / 2, maxTs].forEach(t => {
    ctx.fillText(tFmt(t), tx(t), H - 4);
  });

  // lines
  for (const s of series) {
    if (s.points.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = tx(p.ts), y = ty(p.v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // legend
  let lx = PAD.l;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, PAD.t - 13, 8, 5);
    ctx.fillStyle = '#8896a8';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 10, PAD.t - 9);
    lx += ctx.measureText(s.label).width + 20;
  }
}

function StrikeHistChart({
  strike, isAtm, data, expiryColors,
}: {
  strike: number;
  isAtm: boolean;
  data: StrikeHistData;
  expiryColors: Record<string, string>;
}) {
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

    const series = Object.entries(data).map(([key, pts]) => {
      const [expiry, side] = key.split(':');
      const color = side === 'CE'
        ? (expiryColors[expiry] ?? '#22c55e')
        : shadeColor(expiryColors[expiry] ?? '#f43f5e', -30);
      return { label: `${expiry.slice(4)}-${side}`, color, points: pts };
    });

    drawLineChart(ctx, W, H, series, strike, isAtm);
  }, [data, strike, isAtm, expiryColors]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}

function shadeColor(hex: string, pct: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, ((n >> 16) & 0xff) + pct));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + pct));
  const b = Math.min(255, Math.max(0, (n & 0xff) + pct));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// ── Strike popup — TradingView-style chart ────────────────────────────────────
interface PopupSeries { label: string; color: string; points: TsPoint[] }

function PopupMetricChart({
  title,
  series,
  formatter,
}: {
  title: string;
  series: PopupSeries[];
  formatter: (value: number) => string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineMapRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: '#0b1118' },
        textColor: '#93a4bc',
      },
      grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
      rightPriceScale: { visible: true, borderColor: 'rgba(148,163,184,0.16)' },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.16)',
        timeVisible: true,
        secondsVisible: false,
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
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.12, bottom: 0.12 } });
    chartRef.current = chart;
    lineMapRef.current = new Map();

    return () => {
      lineMapRef.current.clear();
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const lineMap = lineMapRef.current;
    const currentLabels = new Set(series.map(item => item.label));

    for (const [label, line] of lineMap.entries()) {
      if (!currentLabels.has(label)) {
        try { chart.removeSeries(line); } catch {}
        lineMap.delete(label);
      }
    }

    series.forEach(item => {
      let line = lineMap.get(item.label);
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color: item.color,
          lineWidth: 2.25,
          title: item.label,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerRadius: 3,
          priceFormat: { type: 'custom', formatter, minMove: 0.0001 } as any,
        });
        lineMap.set(item.label, line);
      }
      const data: LineData[] = item.points
        .map(point => ({ time: Math.floor(point.ts / 1000) as Time, value: point.v }))
        .sort((a, b) => (a.time as number) - (b.time as number));
      line.setData(data);
    });

    if (series.some(item => item.points.length > 0)) {
      chart.timeScale().fitContent();
    }
  }, [formatter, series]);

  return (
    <div className={s.popupPane}>
      <div className={s.popupPaneLabel}>
        {title}
      </div>
      <div ref={containerRef} className={s.popupChartFrame} />
    </div>
  );
}

function StrikePopup({
  strike, isAtm, series, expiryColors, onClose,
}: {
  strike: number;
  isAtm: boolean;
  series: PopupSeries[];
  expiryColors: Record<string, string>;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Map label → series ref so we can update data without recreating the chart
  const lineMapRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  // Create chart once on mount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
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
      timeScale: {
        borderColor: '#2d3643',
        timeVisible: true,
        secondsVisible: false,
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
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    chartRef.current = chart;
    lineMapRef.current = new Map();

    return () => {
      lineMapRef.current.clear();
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  // Sync series lines whenever series prop changes (data arrives or labels change)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const lineMap = lineMapRef.current;
    const currentLabels = new Set(series.map(s => s.label));

    // Remove lines that are no longer in series
    for (const [label, line] of lineMap.entries()) {
      if (!currentLabels.has(label)) {
        try { chart.removeSeries(line); } catch {}
        lineMap.delete(label);
      }
    }

    // Add or update lines
    series.forEach(s => {
      let line = lineMap.get(s.label);
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color: s.color,
          lineWidth: 2,
          title: s.label,
          priceLineVisible: false,
          priceFormat: { type: 'custom', formatter: (v: number) => fmtOi(v), minMove: 1 } as any,
        });
        lineMap.set(s.label, line);
      }
      if (s.points.length > 0) {
        const data: LineData[] = s.points
          .map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.v }))
          .sort((a, b) => (a.time as number) - (b.time as number));
        line.setData(data);
      }
    });

    if (series.some(s => s.points.length > 0)) {
      chart.timeScale().fitContent();
    }
  }, [series]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.72)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: '80vw', height: '70vh', background: '#0d1117', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: isAtm ? '#fbbf24' : '#e7edf6' }}>
              {strike.toFixed(0)}{isAtm ? ' ⚡ ATM' : ''} — Delta × OI
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {series.map(s => (
                <span key={s.label} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: `${s.color}22`, border: `1px solid ${s.color}55`, color: s.color, fontWeight: 600 }}>
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#8896a8', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}
          >✕</button>
        </div>
        {/* Chart */}
        <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
      </div>
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
  oiSeries,
  deltaSeries,
  deltaOiSeries,
  onClose,
}: {
  strike: number;
  expiry: string;
  isAtm: boolean;
  oiSeries: PopupSeries[];
  deltaSeries: PopupSeries[];
  deltaOiSeries: PopupSeries[];
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
              {strike.toFixed(0)}{isAtm ? ' ATM' : ''} - {fmtExpiry(expiry)}
            </span>
            <div className={s.popupBadges}>
              {[{ label: 'CE', color: '#38d4c8' }, { label: 'PE', color: '#f59e0b' }].map(item => (
                <span
                  key={item.label}
                  className={s.popupBadge}
                  style={{ background: `${item.color}22`, borderColor: `${item.color}55`, color: item.color }}
                >
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className={s.popupClose}
          >x</button>
        </div>
        <div className={s.popupBody}>
          <PopupMetricChart title="Open Interest" series={oiSeries} formatter={value => fmtOi(value)} />
          <PopupMetricChart title="Delta" series={deltaSeries} formatter={value => value.toFixed(3)} />
          <PopupMetricChart title="Delta x OI" series={deltaOiSeries} formatter={value => fmtOi(value)} />
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

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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

export default function CumulativeOiChain({ visible }: Props) {
  const { nubraInstruments } = useInstrumentsCtx();
  const allSymbols = useMemo(() => buildSuggestions(nubraInstruments), [nubraInstruments]);

  const [symbol, setSymbol] = useState(DEFAULT_SCRIP);
  const [exchange, setExchange] = useState('NSE');
  const [lotSize, setLotSize] = useState(1);
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
  const [showHistory, setShowHistory] = useState(false);
  const [histDate, setHistDate] = useState(() => todayIst());
  // key = `${strike}:${expiry}:${side}` → TsPoint[]
  const [histData, setHistData] = useState<Record<string, StrikeHistorySeries>>({});
  const [histLoading, setHistLoading] = useState(false);
  const [popupCell, setPopupCell] = useState<{ strike: number; expiry: string } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const histDataRef = useRef<Record<string, StrikeHistorySeries>>({});
  const histPendingRef = useRef<Set<string>>(new Set());

  const pickedExpiries = useMemo(
    () => selectedExpiries.filter(Boolean).filter((value, idx, arr) => arr.indexOf(value) === idx),
    [selectedExpiries],
  );

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
      setLotSize(selectedSymbol.lotSize);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    if (allSymbols.length === 0) return;
    const preferred = allSymbols.find(item => item.sym.toUpperCase() === DEFAULT_SCRIP) ?? allSymbols[0];
    if (!preferred) return;
    setSymbol(preferred.sym);
    setExchange(preferred.exchange);
    setLotSize(preferred.lotSize);
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
        setChains(Object.fromEntries(entries));
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
        setChains(prev => ({ ...prev, [expiry]: mergeChainSnapshot(prev[expiry], live) }));
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

  const loadHistoryRequests = useCallback(async (requests: HistoryRequest[]) => {
    if (requests.length === 0) return;

    const concurrency = 6;
    let cursor = 0;

    const worker = async () => {
      while (cursor < requests.length) {
        const current = requests[cursor++];
        if (histDataRef.current[current.key] || histPendingRef.current.has(current.key)) continue;

        const stockName = findOptStockName(nubraInstruments, resolved.nubraSym, current.expiry, current.strike, current.side);
        if (!stockName) continue;

        histPendingRef.current.add(current.key);
        try {
          const result = await fetchStrikeSeries(resolved.exchange, stockName, histDate);
          setHistData(prev => ({ ...prev, [current.key]: buildStrikeHistorySeries(result) }));
        } catch {
          // silent
        } finally {
          histPendingRef.current.delete(current.key);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()));
  }, [nubraInstruments, resolved.nubraSym, resolved.exchange, histDate]);

  useEffect(() => {
    if (pickedExpiries.length === 0) return;

    // strikesToFetch: use chartRows window (ATM ± strikeCount) once available,
    // or fall back to primaryChain rows — we re-run when rows change anyway
    const chainForStrikes = chains[pickedExpiries[0]];
    if (!chainForStrikes || chainForStrikes.rows.length === 0) return;

    const atmIdx = nearestStrikeIndex(chainForStrikes.rows, chainForStrikes.atm || chainForStrikes.spot);
    const start = Math.max(0, atmIdx - strikeCount);
    const end = Math.min(chainForStrikes.rows.length, atmIdx + strikeCount + 1);
    const strikesToFetch = strikeViewMode === 'custom'
      ? [...customStrikes].sort((a, b) => a - b)
      : chainForStrikes.rows.slice(start, end).map(r => r.strike);
    if (strikesToFetch.length === 0) return;

    let cancelled = false;
    setHistLoading(true);

    const strikeBatches = chunkArray(strikesToFetch, HISTORY_BATCH_SIZE);

    if (strikeBatches.length === 0) {
      setHistLoading(false);
      return;
    }

    (async () => {
      for (const strikeBatch of strikeBatches) {
        if (cancelled) return;
        const requests: HistoryRequest[] = [];
        for (const expiry of pickedExpiries) {
          for (const strike of strikeBatch) {
            for (const side of ['CE', 'PE'] as const) {
              const key = `${strike}:${expiry}:${side}`;
              if (histDataRef.current[key] || histPendingRef.current.has(key)) continue;
              requests.push({ key, expiry, strike, side });
            }
          }
        }
        if (requests.length === 0) continue;
        await loadHistoryRequests(requests);
      }
      if (!cancelled) setHistLoading(false);
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histDate, symbol, pickedExpiries.join(','), strikeCount, strikeViewMode, customStrikes.join(','), chains[pickedExpiries[0] ?? '']?.rows.length, loadHistoryRequests]);

  // Reset hist data when symbol/expiry changes
  useEffect(() => {
    histPendingRef.current.clear();
    histDataRef.current = {};
    setHistData({});
  }, [symbol, pickedExpiries.join(','), histDate]);

  // Expiry → color mapping (stable per pickedExpiries)
  const EXPIRY_COLORS = ['#38d4c8', '#f59e0b', '#a78bfa'];
  const expiryColors = useMemo(() => {
    const m: Record<string, string> = {};
    pickedExpiries.forEach((exp, i) => { m[exp] = EXPIRY_COLORS[i % EXPIRY_COLORS.length]; });
    return m;
  }, [pickedExpiries.join(',')]);

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

  // Fetch a single strike on demand (e.g. when clicking the chart icon in the table)
  const fetchStrikeOnDemand = useCallback(async (strike: number, expiryFilter?: string) => {
    const targetExpiries = expiryFilter ? [expiryFilter] : pickedExpiries;
    for (const expiry of targetExpiries) {
      for (const side of ['CE', 'PE'] as const) {
        const key = `${strike}:${expiry}:${side}`;
        if (histDataRef.current[key] || histPendingRef.current.has(key)) continue;
        await loadHistoryRequests([{ key, expiry, strike, side }]);
      }
    }
  }, [pickedExpiries, loadHistoryRequests]);

  const maxTotalOi = useMemo(() => Math.max(1, ...rows.map(row => row.totalOi)), [rows]);
  const maxTotalCeOi = useMemo(() => Math.max(1, ...rows.map(row => row.totalCeOi)), [rows]);
  const maxTotalPeOi = useMemo(() => Math.max(1, ...rows.map(row => row.totalPeOi)), [rows]);

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
    setShowHistory(true);
    setPopupCell({ strike, expiry });
    void fetchStrikeOnDemand(strike, expiry);
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
        <button
          type="button"
          style={{ cursor: 'pointer', border: 'none', background: showHistory ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.06)', borderRadius: 6, padding: '4px 10px', color: showHistory ? '#f59e0b' : '#8896a8', fontSize: 11, fontWeight: 600 }}
          onClick={() => setShowHistory(v => !v)}
        >
          {showHistory ? '▲ Hide History' : '📈 History'}
        </button>
      </div>

      {error && <div className={s.bannerError}>{error}</div>}
      {!error && loading && <div className={s.bannerInfo}>Loading cumulative OI chain...</div>}
      {!loading && !error && pickedExpiries.length === 0 && <div className={s.bannerInfo}>Select at least one expiry</div>}

      {showChart && (
        <div style={{ height: 340, flexShrink: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)' }}>
          <DeltaOiChart chartRows={chartRows} spot={primaryChain?.spot ?? 0} />
        </div>
      )}

      {showHistory && (
        <div className={s.historyPanel}>
          {/* History toolbar */}
          <div className={s.historyToolbar}>
            <div className={s.historyToolbarLeft}>
              <label className={s.historyDateLabel}>
                <span className={s.historyDateText}>Date</span>
                <input
                  type="date"
                  value={histDate}
                  onChange={e => setHistDate(e.target.value)}
                  className={s.historyDateInput}
                />
              </label>
            </div>
            <div className={s.historyToolbarRight}>
              {pickedExpiries.map((exp, i) => (
                <span
                  key={exp}
                  className={s.historyLegendChip}
                  style={{ background: `${EXPIRY_COLORS[i % EXPIRY_COLORS.length]}22`, border: `1px solid ${EXPIRY_COLORS[i % EXPIRY_COLORS.length]}55`, color: EXPIRY_COLORS[i % EXPIRY_COLORS.length] }}
                >
                  {fmtExpiry(exp)}
                </span>
              ))}
              {histLoading && <span className={s.historyLoading}>Loading...</span>}
            </div>
          </div>
          {/* Per-strike charts grid */}
          <div className={s.historyGrid}>
            {chartRows.map(row => {
              const data: StrikeHistData = {};
              pickedExpiries.forEach(exp => {
                const ceKey = `${row.strike}:${exp}:CE`;
                const peKey = `${row.strike}:${exp}:PE`;
                if (histData[ceKey]?.deltaOi.length) data[`${exp}:CE`] = histData[ceKey].deltaOi;
                if (histData[peKey]?.deltaOi.length) data[`${exp}:PE`] = histData[peKey].deltaOi;
              });
              return (
                <div key={row.strike} className={`${s.historyCard} ${row.isAtm ? s.historyCardAtm : ''}`}>
                  <div className={s.historyCardHeader}>
                    <div className={s.historyCardTitle}>
                      <span className={`${s.historyStrikeText} ${row.isAtm ? s.historyStrikeTextAtm : ''}`}>{row.strike.toFixed(0)}</span>
                      {row.isAtm && <span className={s.historyAtmBadge}>ATM</span>}
                    </div>
                    <div className={s.historyCardLegend}>
                      {pickedExpiries.map((exp, i) => (
                        <span key={`${row.strike}-${exp}`} className={s.historyMiniLegend} style={{ background: EXPIRY_COLORS[i % EXPIRY_COLORS.length] }} />
                      ))}
                      <button
                        title="Open chart"
                        onClick={() => {
                          const firstExpiry = pickedExpiries[0];
                          if (!firstExpiry) return;
                          openPopupForCell(row.strike, firstExpiry);
                        }}
                        className={s.historyCardAction}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <polyline points="1,11 5,6 8,9 11,4 15,7" />
                          <rect x="1" y="1" width="14" height="14" rx="1" strokeWidth="1.2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className={s.historyChartFrame}>
                    <StrikeHistChart strike={row.strike} isAtm={row.isAtm} data={data} expiryColors={expiryColors} />
                  </div>
                </div>
              );
            })}
            {chartRows.length === 0 && !histLoading && (
              <div style={{ gridColumn: '1/-1', color: '#556', fontSize: 12, textAlign: 'center', padding: 24 }}>Load option chain first to see per-strike history</div>
            )}
          </div>
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
              <th rowSpan={2} className={s.totalCeHead}>{deltaOi ? 'Total CE Delta OI' : 'Total CE OI'}</th>
              <th rowSpan={2} className={s.totalPeHead}>{deltaOi ? 'Total PE Delta OI' : 'Total PE OI'}</th>
              <th rowSpan={2} className={s.totalOiHead}>{deltaOi ? 'Total Delta OI' : 'Total OI'}</th>
              <th rowSpan={2} className={s.totalOiHead}>PCR</th>
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
              const totalPct = Math.max(0, Math.min(100, (row.totalOi / maxTotalOi) * 100));
              const cePct = Math.max(0, Math.min(100, (row.totalCeOi / maxTotalCeOi) * 100));
              const pePct = Math.max(0, Math.min(100, (row.totalPeOi / maxTotalPeOi) * 100));
              return (
                <tr key={row.strike} className={row.isAtm ? s.atmRow : ''}>
                  <td className={`${s.strikeCell} ${row.isAtm ? s.strikeCellAtm : ''}`}>
                    {row.isAtm && <span className={s.atmPill}>ATM</span>}
                    <span className={row.isAtm ? s.strikeValAtm : s.strikeVal}>{row.strike.toFixed(0)}</span>
                    <button
                      title="Delta×OI chart"
                      onClick={() => {
                        const firstExpiry = row.expiryBreakdown[0]?.expiry;
                        if (!firstExpiry) return;
                        openPopupForCell(row.strike, firstExpiry);
                      }}
                      style={{ marginTop: 3, background: 'none', border: 'none', cursor: 'pointer', color: '#38d4c8', padding: 0, display: 'flex', alignItems: 'center', opacity: 0.7 }}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <polyline points="1,11 5,6 8,9 11,4 15,7" />
                        <rect x="1" y="1" width="14" height="14" rx="1" strokeWidth="1.2" />
                      </svg>
                    </button>
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
                    const ceVal = formatMetric(selectedMetric, ceSource[selectedMetric], ceSource.oiChgPct);
                    const peVal = formatMetric(selectedMetric, peSource[selectedMetric], peSource.oiChgPct);
                    return [
                      renderCellValue('CE', item.expiry, row.strike, ceVal.main, s.ceCell),
                      renderCellValue('PE', item.expiry, row.strike, peVal.main, s.peCell),
                    ];
                  })}
                  <td className={s.totalCeCell}>
                    <div className={`${s.oiBar} ${s.oiBarCe}`} style={{ ['--oi-fill' as string]: `${cePct.toFixed(1)}%` }}>
                      <span className={s.oiBarText}>{fmtOi(row.totalCeOi)}</span>
                    </div>
                  </td>
                  <td className={s.totalPeCell}>
                    <div className={`${s.oiBar} ${s.oiBarPe}`} style={{ ['--oi-fill' as string]: `${pePct.toFixed(1)}%` }}>
                      <span className={s.oiBarText}>{fmtOi(row.totalPeOi)}</span>
                    </div>
                  </td>
                  <td className={s.totalOiCell}>
                    <div className={`${s.oiBar} ${s.oiBarTotal}`} style={{ ['--oi-fill' as string]: `${totalPct.toFixed(1)}%` }}>
                      <span className={s.oiBarText}>{fmtOi(row.totalOi)}</span>
                    </div>
                  </td>
                  <td className={s.totalOiCell}>{row.pcr > 0 ? row.pcr.toFixed(2) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Strike popup */}
      {popupCell !== null && (() => {
        const ceSeries = histData[`${popupCell.strike}:${popupCell.expiry}:CE`] ?? EMPTY_HISTORY_SERIES;
        const peSeries = histData[`${popupCell.strike}:${popupCell.expiry}:PE`] ?? EMPTY_HISTORY_SERIES;
        const popupRow = rows.find(r => r.strike === popupCell.strike);
        return (
          <StrikeDetailPopup
            strike={popupCell.strike}
            expiry={popupCell.expiry}
            isAtm={popupRow?.isAtm ?? false}
            oiSeries={[
              { label: 'CE', color: '#38d4c8', points: ceSeries.oi },
              { label: 'PE', color: '#f59e0b', points: peSeries.oi },
            ]}
            deltaSeries={[
              { label: 'CE', color: '#38d4c8', points: ceSeries.delta },
              { label: 'PE', color: '#f59e0b', points: peSeries.delta },
            ]}
            deltaOiSeries={[
              { label: 'CE', color: '#38d4c8', points: ceSeries.deltaOi },
              { label: 'PE', color: '#f59e0b', points: peSeries.deltaOi },
            ]}
            onClose={() => setPopupCell(null)}
          />
        );
      })()}
    </div>
  );
}
