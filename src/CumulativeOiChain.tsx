'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
        return {
          expiry,
          ceOi: row?.ce.oi ?? 0,
          peOi: row?.pe.oi ?? 0,
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
  }, [chains, customStrikes, pickedExpiries, primaryChain, strikeCount, strikeViewMode]);

  const maxTotalOi = useMemo(() => Math.max(1, ...rows.map(row => row.totalOi)), [rows]);
  const maxTotalCeOi = useMemo(() => Math.max(1, ...rows.map(row => row.totalCeOi)), [rows]);
  const maxTotalPeOi = useMemo(() => Math.max(1, ...rows.map(row => row.totalPeOi)), [rows]);

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
        <div className={s.infoChip}>
          <span className={s.infoDot} />
          <span>{spotLabel}</span>
        </div>
      </div>

      {error && <div className={s.bannerError}>{error}</div>}
      {!error && loading && <div className={s.bannerInfo}>Loading cumulative OI chain...</div>}
      {!loading && !error && pickedExpiries.length === 0 && <div className={s.bannerInfo}>Select at least one expiry</div>}

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr className={s.superHead}>
              <th rowSpan={2} className={s.strikeHead}>Strike</th>
              {pickedExpiries.map(expiry => (
                <th key={expiry} colSpan={perExpiryCols} className={s.expiryHead}>{fmtExpiry(expiry)}</th>
              ))}
              <th rowSpan={2} className={s.totalCeHead}>Total CE OI</th>
              <th rowSpan={2} className={s.totalPeHead}>Total PE OI</th>
              <th rowSpan={2} className={s.totalOiHead}>Total OI</th>
              <th rowSpan={2} className={s.totalOiHead}>PCR</th>
            </tr>
            <tr className={s.metricHeadRow}>
              {pickedExpiries.flatMap(expiry => (
                selectedMetric === 'oi'
                  ? [
                      <th key={`ce-${expiry}`} className={s.metricHead}>CE OI</th>,
                      <th key={`cechg-${expiry}`} className={s.metricHead}>CE OI chg%</th>,
                      <th key={`pe-${expiry}`} className={s.metricHead}>PE OI</th>,
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
                  </td>
                  {row.expiryBreakdown.flatMap(item => {
                    const ceSource = chains[item.expiry]?.rows.find(entry => entry.strike === row.strike)?.ce ?? EMPTY_SIDE;
                    const peSource = chains[item.expiry]?.rows.find(entry => entry.strike === row.strike)?.pe ?? EMPTY_SIDE;
                    if (selectedMetric === 'oi') {
                      return [
                        <td key={`ce-${item.expiry}-${row.strike}`} className={s.ceCell}>
                          <div className={`${s.oiBar} ${s.oiBarCe}`}>
                            <span className={s.oiBarText}>{fmtOi(ceSource.oi)}</span>
                          </div>
                        </td>,
                        <td key={`cechg-${item.expiry}-${row.strike}`} className={`${s.chgCell} ${ceSource.oiChgPct >= 0 ? s.upText : s.downText}`}>{fmtPct(ceSource.oiChgPct)}</td>,
                        <td key={`pe-${item.expiry}-${row.strike}`} className={s.peCell}>
                          <div className={`${s.oiBar} ${s.oiBarPe}`}>
                            <span className={s.oiBarText}>{fmtOi(peSource.oi)}</span>
                          </div>
                        </td>,
                        <td key={`pechg-${item.expiry}-${row.strike}`} className={`${s.chgCell} ${peSource.oiChgPct >= 0 ? s.upText : s.downText}`}>{fmtPct(peSource.oiChgPct)}</td>,
                      ];
                    }
                    const ceVal = formatMetric(selectedMetric, ceSource[selectedMetric], ceSource.oiChgPct);
                    const peVal = formatMetric(selectedMetric, peSource[selectedMetric], peSource.oiChgPct);
                    return [
                      <td key={`ce-${item.expiry}-${row.strike}`} className={s.ceCell}>
                        <span className={s.oiBarText}>{ceVal.main}</span>
                      </td>,
                      <td key={`pe-${item.expiry}-${row.strike}`} className={s.peCell}>
                        <span className={s.oiBarText}>{peVal.main}</span>
                      </td>,
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
    </div>
  );
}

