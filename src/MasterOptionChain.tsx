'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInstrumentsCtx } from './AppContext';
import type { NubraInstrument } from './useNubraInstruments';
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
  oiChgPct: 0,
  delta: 0,
  theta: 0,
  vega: 0,
  gamma: 0,
};

const BRIDGE = 'ws://localhost:8765';
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
type ViewMode = 'chain' | 'butterfly' | 'ratio';

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

function fmtOi(n: number) {
  if (!n) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtOiChgPct(n: number) {
  if (!isFinite(n) || n === 0) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function parseRestOption(opt: Record<string, number>): OptionSide {
  const ltp = (opt.ltp ?? 0) / 100;
  const ltpchg = opt.ltpchg ?? 0;
  const cp = ltpchg !== -100 ? ltp / (1 + ltpchg / 100) : 0;
  return {
    ltp,
    cp,
    iv: (opt.iv ?? 0) * 100,
    oi: opt.oi ?? 0,
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
  return {
    ltp,
    cp: ltp - chg,
    iv: (opt.iv ?? 0) * 100,
    oi: opt.open_interest ?? 0,
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
  const wsRef = useRef<WebSocket | null>(null);

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
        const data = msg.data;
        const liveSnap = buildChainSnapshotWs(data.ce ?? [], data.pe ?? [], data.at_the_money_strike ?? 0, data.current_price ?? 0);
        setChains(prev => ({
          ...prev,
          [expiry]: mergeChainSnapshot(prev[expiry], liveSnap),
        }));
      } catch {
        // ignore malformed bridge frames
      }
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
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

  const handleExpiryChange = useCallback((index: number, nextExpiry: string) => {
    setSelectedExpiries(prev => prev.map((value, idx) => (idx === index ? nextExpiry : value)));
  }, []);

  const toggleColumn = useCallback((key: ColumnKey) => {
    setSelectedColumns(prev => {
      if (prev.includes(key)) return prev.length === 1 ? prev : prev.filter(item => item !== key);
      return [...prev, key];
    });
  }, []);

  const priceScale = perLot ? lotSize : 1;
  const spotLabel = primaryChain?.spot ? `${primaryChain.spot.toFixed(2)} spot` : 'No live spot';
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

        <div className={s.infoChip}>
          <span className={s.infoDot} />
          <span>{spotLabel}</span>
        </div>
      </div>

      {error && <div className={s.bannerError}>{error}</div>}
      {!error && loading && <div className={s.bannerInfo}>Loading option chain...</div>}
      {!loading && !error && pickedExpiries.length === 0 && <div className={s.bannerInfo}>Select at least one expiry</div>}

      <div className={s.tableWrap}>
        {viewMode === 'chain' ? (
          <table className={s.table}>
            <thead>
              <tr className={s.superHead}>
                <th colSpan={callExpiries.length * callColumns.length} className={`${s.superCell} ${s.callsHead}`}>CALLS</th>
                <th rowSpan={3} className={`${s.superCell} ${s.strikeHead}`}>Strike</th>
                <th colSpan={putExpiries.length * putColumns.length} className={`${s.superCell} ${s.putsHead}`}>PUTS</th>
              </tr>
              <tr className={s.expiryHeadRow}>
                {callExpiries.map((expiry, groupIdx) => (
                  <th key={`ce-exp-${expiry}`} colSpan={callColumns.length} className={`${s.expiryHead} ${s[`callGroupHead${groupIdx % 3}`]}`}>{fmtExpiry(expiry)}</th>
                ))}
                {putExpiries.map((expiry, groupIdx) => (
                  <th key={`pe-exp-${expiry}`} colSpan={putColumns.length} className={`${s.expiryHead} ${s[`putGroupHead${groupIdx % 3}`]}`}>{fmtExpiry(expiry)}</th>
                ))}
              </tr>
              <tr className={s.metricHeadRow}>
                {callExpiries.flatMap((expiry, groupIdx) => callColumns.map(col => (
                  <th key={`ce-${col}-${expiry}`} className={`${s.metricHead} ${s[`callGroupHead${groupIdx % 3}`]}`}>{AVAILABLE_COLUMNS.find(item => item.key === col)?.label ?? col}</th>
                )))}
                {putExpiries.flatMap((expiry, groupIdx) => putColumns.map(col => (
                  <th key={`pe-${col}-${expiry}`} className={`${s.metricHead} ${s[`putGroupHead${groupIdx % 3}`]}`}>{AVAILABLE_COLUMNS.find(item => item.key === col)?.label ?? col}</th>
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
                          return (
                            <td key={`ce-l-${entry.expiry}-${row.strike}`} className={`${s.callCell} ${s[`callGroupCell${groupIdx % 3}`]} ${s.priceCell}`}>
                              <span className={s.priceMain}>{fmtPrice(entry.ce.ltp * priceScale)}</span>
                              {fmtChangePct(ceChange) && <span className={s.priceUp}>({fmtChangePct(ceChange)})</span>}
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
                      return putColumns.map(col => {
                        if (col === 'ltp') {
                          return (
                            <td key={`pe-l-${entry.expiry}-${row.strike}`} className={`${s.putCell} ${s[`putGroupCell${groupIdx % 3}`]} ${s.priceCell}`}>
                              <span className={s.priceMain}>{fmtPrice(entry.pe.ltp * priceScale)}</span>
                              {fmtChangePct(peChange) && <span className={s.priceDown}>({fmtChangePct(peChange)})</span>}
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
              </tr>
            </thead>
            <tbody>
              {butterflyRows.length === 0 ? (
                <tr>
                  <td className={s.emptyCell} colSpan={12}>{loading ? 'Loading butterfly combinations...' : 'No butterfly combinations for selected settings'}</td>
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
                    <td className={row.net >= 0 ? s.bfPos : s.bfNeg}>{fmtSignedPrice(row.net)}</td>
                    <td className={s.bfChipPos}>{fmtSignedPrice(row.maxProfit)}</td>
                    <td className={s.bfChipNeg}>{fmtSignedPrice(row.maxLoss)}</td>
                    <td>{row.riskReward}</td>
                    <td>{row.beLow > 0 ? row.beLow.toFixed(2) : '—'}</td>
                    <td>{row.beHigh > 0 ? row.beHigh.toFixed(2) : '—'}</td>
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
              </tr>
            </thead>
            <tbody>
              {ratioRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className={s.emptyCell}>{loading ? 'Loading ratio rows...' : 'No ratio rows for selected setup'}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
