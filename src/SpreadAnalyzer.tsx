'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { NubraInstrument } from './useNubraInstruments';
import { useInstrumentsCtx } from './AppContext';
import s from './SpreadAnalyzer.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props { visible?: boolean; }

interface OptionSide {
  ltp: number; cp: number; oi: number; oiChgPct: number;
  delta: number; theta: number; gamma: number; vega: number; iv: number; volume: number;
}
interface StrikeRow {
  strike: number; ce: OptionSide; pe: OptionSide; isAtm: boolean;
}
interface ChainSnapshot {
  rows: StrikeRow[];
  spot: number;
  atm: number;
}

const EMPTY_SIDE: OptionSide = { ltp: 0, cp: 0, oi: 0, oiChgPct: 0, delta: 0, theta: 0, gamma: 0, vega: 0, iv: 0, volume: 0 };

interface Instrument {
  id: string;
  sym: string;
  exchange: string;
  expiries: string[];
  selectedExpiry: string;
  lotSize: number;
}

interface Suggestion { sym: string; exchange: string; asset_type: string; }

// ── Auth ──────────────────────────────────────────────────────────────────────

function nubraHeaders() {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie    = localStorage.getItem('nubra_raw_cookie') ?? '';
  return { 'x-session-token': sessionToken, 'x-device-id': deviceId, 'x-raw-cookie': rawCookie };
}

function getSession() { return localStorage.getItem('nubra_session_token') ?? ''; }

function isMarketOpen(): boolean {
  const now = new Date();
  const istMin = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + 330) % 1440;
  const istDay = new Date(now.getTime() + 330 * 60000);
  if ([0, 6].includes(istDay.getUTCDay())) return false;
  return istMin >= 9 * 60 + 15 && istMin < 15 * 60 + 30;
}

// ── Search helpers ────────────────────────────────────────────────────────────

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

function resolveNubra(sym: string, nubraInstruments: NubraInstrument[]) {
  const upper = sym.toUpperCase();
  const found = nubraInstruments.find(i =>
    (i.option_type === 'CE' || i.option_type === 'PE') &&
    (i.asset?.toUpperCase() === upper || i.nubra_name?.toUpperCase() === upper || i.stock_name?.toUpperCase().startsWith(upper))
  );
  if (found?.asset) return { nubraSym: found.asset, exchange: found.exchange ?? 'NSE', lotSize: found.lot_size ?? 1 };
  const fallback = nubraInstruments.find(i =>
    i.asset?.toUpperCase() === upper || i.nubra_name?.toUpperCase() === upper || i.stock_name?.toUpperCase().startsWith(upper)
  );
  return { nubraSym: fallback?.asset ?? sym, exchange: fallback?.exchange ?? 'NSE', lotSize: fallback?.lot_size ?? 1 };
}

async function fetchExpiries(sym: string, exchange: string): Promise<string[]> {
  const headers = nubraHeaders();
  if (!headers['x-session-token']) return [];
  try {
    const res = await fetch(`/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exchange}`, { headers });
    if (!res.ok) return [];
    const json = await res.json();
    const list: string[] = json?.expiries ?? [];
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return list.filter(e => String(e) >= today).sort();
  } catch { return []; }
}

function parseRestOption(opt: Record<string, number>): OptionSide {
  const ltp = (opt.ltp ?? 0) / 100;
  const ltpchg = opt.ltpchg ?? 0;
  const cp = ltpchg !== -100 ? ltp / (1 + ltpchg / 100) : 0;
  const volume = opt.volume ?? opt.vol ?? opt.total_volume ?? 0;
  return {
    ltp,
    cp,
    oi: opt.oi ?? 0,
    oiChgPct: opt.prev_oi != null && opt.oi > 0 ? ((opt.oi - opt.prev_oi) / opt.oi) * 100 : 0,
    delta: opt.delta ?? 0,
    theta: opt.theta ?? 0,
    gamma: opt.gamma ?? 0,
    vega: opt.vega ?? 0,
    iv: (opt.iv ?? 0) * 100,
    volume,
  };
}

function buildChainSnapshotWs(ceList: Record<string, number>[], peList: Record<string, number>[], atmRaw: number, spotRaw: number): ChainSnapshot {
  const map = new Map<number, StrikeRow>();
  const parseWsSide = (opt: Record<string, number>): OptionSide => {
    const ltp = opt.last_traded_price ?? 0;
    const chg = opt.last_traded_price_change ?? 0;
    const curOi = opt.open_interest ?? 0; const prevOi = opt.previous_open_interest ?? 0;
    const volume = opt.volume ?? opt.traded_volume ?? opt.total_traded_volume ?? 0;
    return { ltp, cp: ltp - chg, oi: curOi, oiChgPct: curOi > 0 ? ((curOi - prevOi) / curOi) * 100 : 0, delta: opt.delta ?? 0, theta: opt.theta ?? 0, gamma: opt.gamma ?? 0, vega: opt.vega ?? 0, iv: (opt.iv ?? 0) * 100, volume };
  };
  for (const opt of ceList) {
    const strike = opt.strike_price ?? 0;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE }, isAtm: false });
    map.get(strike)!.ce = parseWsSide(opt);
  }
  for (const opt of peList) {
    const strike = opt.strike_price ?? 0;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE }, isAtm: false });
    map.get(strike)!.pe = parseWsSide(opt);
  }
  const rows = [...map.values()].sort((a, b) => a.strike - b.strike);
  const spot = spotRaw;
  const atm = atmRaw > 0 ? atmRaw : spot;
  let atmIdx = 0; let minDiff = Infinity;
  rows.forEach((r, i) => { const d = Math.abs(r.strike - atm); if (d < minDiff) { minDiff = d; atmIdx = i; } });
  rows.forEach((r, i) => { r.isAtm = i === atmIdx; });
  return { rows, spot, atm };
}

function buildChainSnapshot(ceList: Record<string, number>[], peList: Record<string, number>[], atmRaw: number, spotRaw: number): ChainSnapshot {
  const scale = 100;
  const map = new Map<number, StrikeRow>();
  for (const opt of ceList) {
    const strike = (opt.sp ?? 0) / scale;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE }, isAtm: false });
    map.get(strike)!.ce = parseRestOption(opt);
  }
  for (const opt of peList) {
    const strike = (opt.sp ?? 0) / scale;
    if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE }, isAtm: false });
    map.get(strike)!.pe = parseRestOption(opt);
  }
  const rows = [...map.values()].sort((a, b) => a.strike - b.strike);
  const spot = spotRaw / scale;
  const atm = atmRaw > 0 ? atmRaw / scale : spot;

  let atmIdx = 0;
  let minDiff = Number.POSITIVE_INFINITY;
  rows.forEach((r, i) => {
    const diff = Math.abs(r.strike - atm);
    if (diff < minDiff) {
      minDiff = diff;
      atmIdx = i;
    }
  });
  rows.forEach((r, i) => { r.isAtm = i === atmIdx; });
  return { rows, spot, atm };
}

async function fetchOptionChainSnapshot(session: string, sym: string, exchange: string, expiry: string): Promise<ChainSnapshot> {
  const restUrl = `/api/nubra-optionchain?session_token=${encodeURIComponent(session)}&instrument=${encodeURIComponent(sym)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}`;
  const res = await fetch(restUrl);
  if (!res.ok) throw new Error(`Failed to load option chain (${res.status})`);
  const json = await res.json();
  const c = json.chain ?? json;
  return buildChainSnapshot(c.ce ?? [], c.pe ?? [], c.atm ?? 0, c.cp ?? c.current_price ?? 0);
}

// ── Format ────────────────────────────────────────────────────────────────────

function fmtExpiry(e: string | number): string {
  const str = String(e);
  if (str.length !== 8) return str;
  const y = str.slice(0, 4), m = str.slice(4, 6), d = str.slice(6, 8);
  return new Date(`${y}-${m}-${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
}
function fmtPrice(n: number) { return n === 0 ? '—' : n.toFixed(2); }
function fmtOi(n: number) { return n === 0 ? '—' : n >= 1e7 ? (n / 1e7).toFixed(2) + 'Cr' : n >= 1e5 ? (n / 1e5).toFixed(1) + 'L' : n.toLocaleString('en-IN'); }
function fmtGreek(n: number, d = 2) { return n === 0 ? '—' : n.toFixed(d); }

let _id = 0;
function uid() { return `ins_${++_id}`; }

// ── Dropdown portal ───────────────────────────────────────────────────────────

function DropPortal({ anchorEl, open, children, minWidth = 160 }: {
  anchorEl: HTMLElement | null; open: boolean; children: React.ReactNode; minWidth?: number;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useEffect(() => {
    if (!open || !anchorEl) { setPos(null); return; }
    const r = anchorEl.getBoundingClientRect();
    setPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, minWidth) });
  }, [open, anchorEl, minWidth]);
  if (!open || !pos) return null;
  return createPortal(
    <div className={s.dropList} style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width, zIndex: 9999 }}>
      {children}
    </div>,
    document.body
  );
}

// ── InlineSelect ──────────────────────────────────────────────────────────────

function InlineSelect({ value, options, onChange, placeholder, format: fmt, disabled }: {
  value: string | number | null; options: (string | number)[];
  onChange: (v: string | number) => void; placeholder?: string;
  format?: (v: string | number) => string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!btnRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const label = value != null ? (fmt ? fmt(value) : String(value)) : (placeholder ?? 'Select…');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${s.inlineBtn} ${value != null ? s.inlineBtnFilled : ''} ${(disabled || options.length === 0) ? s.inlineBtnDisabled : ''}`}
        onClick={() => !disabled && options.length > 0 && setOpen(o => !o)}
      >
        <span className={s.inlineBtnText}>{label}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" d="m19 9-7 7-7-7"/></svg>
      </button>
      <DropPortal anchorEl={btnRef.current} open={open} minWidth={140}>
        {options.map(o => (
          <div key={String(o)} className={`${s.dropItem} ${o === value ? s.dropItemActive : ''}`}
            onMouseDown={() => { onChange(o); setOpen(false); }}>
            {fmt ? fmt(o) : String(o)}
          </div>
        ))}
      </DropPortal>
    </>
  );
}

function ExpiryMultiSelect({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (expiry: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const label = selected.length > 0 ? `${selected.length} expiries` : 'Select expiries';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${s.inlineBtn} ${selected.length > 0 ? s.inlineBtnFilled : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        <span className={s.inlineBtnText}>{label}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" d="m19 9-7 7-7-7"/></svg>
      </button>
      <DropPortal anchorEl={btnRef.current} open={open} minWidth={220}>
        <div ref={listRef} className={s.expiryCheckWrap}>
          {options.map(exp => {
            const checked = selected.includes(exp);
            return (
              <label key={exp} className={s.expiryCheckItem}>
                <input type="checkbox" checked={checked} onChange={() => onToggle(exp)} />
                <span>{fmtExpiry(exp)}</span>
              </label>
            );
          })}
        </div>
      </DropPortal>
    </>
  );
}

interface ComboColDef { key: string; label: string; }
const STATIC_COMBO_COLS: ComboColDef[] = [
  { key: 'baseCeLtp', label: 'Base CE LTP' },
  { key: 'basePeLtp', label: 'Base PE LTP' },
  { key: 'buyCeLtp', label: 'Buy CE LTP' },
  { key: 'buyPeLtp', label: 'Buy PE LTP' },
  { key: 'sellCeLtp', label: 'Sell CE LTP' },
  { key: 'sellPeLtp', label: 'Sell PE LTP' },
  { key: 'avgIv', label: 'Avg IV' },
  { key: 'delta', label: 'Delta' },
  { key: 'theta', label: 'Theta' },
  { key: 'vega', label: 'Vega' },
  { key: 'gamma', label: 'Gamma' },
  { key: 'totalIv', label: 'Total IV' },
  { key: 'totalVol', label: 'Total Vol' },
  { key: 'totalOi', label: 'Total OI' },
];

function ColumnMultiSelect({
  columns,
  selected,
  onToggle,
  labelFor,
}: {
  columns: ComboColDef[];
  selected: string[];
  onToggle: (key: string) => void;
  labelFor: (key: string, fallback: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <>
      <button ref={btnRef} type="button" className={`${s.inlineBtn} ${selected.length ? s.inlineBtnFilled : ''}`} onClick={() => setOpen(v => !v)}>
        <span className={s.inlineBtnText}>Columns ({selected.length})</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" d="m19 9-7 7-7-7"/></svg>
      </button>
      <DropPortal anchorEl={btnRef.current} open={open} minWidth={240}>
        <div ref={listRef} className={s.expiryCheckWrap}>
          {columns.map(col => (
            <label key={col.key} className={s.expiryCheckItem}>
              <input type="checkbox" checked={selected.includes(col.key)} onChange={() => onToggle(col.key)} />
              <span>{labelFor(col.key, col.label)}</span>
            </label>
          ))}
        </div>
      </DropPortal>
    </>
  );
}

// ── SymbolSearch ──────────────────────────────────────────────────────────────

function SymbolSearch({ nubraInstruments, onSelect }: {
  nubraInstruments: NubraInstrument[];
  onSelect: (sym: string, exchange: string, lotSize: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const [idx, setIdx]     = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => buildSuggestions(query, nubraInstruments), [query, nubraInstruments]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const select = (sug: Suggestion) => {
    const { nubraSym, exchange, lotSize } = resolveNubra(sug.sym, nubraInstruments);
    setQuery(''); setOpen(false);
    onSelect(nubraSym, exchange, lotSize);
  };

  const AT_COLOR: Record<string, string> = { INDEX_FO: '#818cf8', STOCK_FO: '#60a5fa', STOCKS: '#34d399', ETF: '#f59e0b', INDEX: '#818cf8', MCX: '#f97316' };

  return (
    <div ref={wrapRef} className={s.symWrap}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" style={{ flexShrink: 0 }}>
        <circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>
      </svg>
      <input
        ref={inputRef}
        className={s.symInput}
        value={query}
        placeholder="Add symbol…"
        onChange={e => { setQuery(e.target.value); setOpen(true); setIdx(-1); }}
        onFocus={() => { if (query) setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, suggestions.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); select(suggestions[idx]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      <DropPortal anchorEl={inputRef.current} open={open && suggestions.length > 0} minWidth={200}>
        {suggestions.map((sug, i) => (
          <div key={`${sug.sym}|${sug.exchange}`}
            className={`${s.dropItem} ${i === idx ? s.dropItemActive : ''}`}
            onMouseEnter={() => setIdx(i)}
            onMouseDown={() => select(sug)}
          >
            <span className={s.dropItemSym}>{sug.sym}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: AT_COLOR[sug.asset_type] ?? '#565A6B' }}>{sug.asset_type || sug.exchange}</span>
          </div>
        ))}
      </DropPortal>
    </div>
  );
}

// ── Straddle Table ────────────────────────────────────────────────────────────

const BRIDGE = 'ws://localhost:8765';

// ── Direct DOM patcher — bypasses React entirely for live ticks ───────────────
// Each cell gets a data-sk="<strike>-<field>" attribute.
// On WS tick we mutate textContent + style directly → zero React re-renders.

function patchDOM(
  tableRef: React.RefObject<HTMLTableSectionElement | null>,
  row: StrikeRow,
  maxTotalOi: number,
) {
  const tbody = tableRef.current;
  if (!tbody) return;
  const sk = row.strike;
  const str = row.ce.ltp + row.pe.ltp;
  const cpSum = row.ce.cp + row.pe.cp;
  const chgPct = cpSum > 0 ? ((str - cpSum) / cpSum) * 100 : 0;
  const iv = (row.ce.iv + row.pe.iv) / 2;
  const delta = (row.ce.delta + row.pe.delta) / 2;
  const theta = (row.ce.theta + row.pe.theta) / 2;
  const vega  = (row.ce.vega  + row.pe.vega)  / 2;
  const totalOi = row.ce.oi + row.pe.oi;
  const totalOiPct = Math.min(100, (totalOi / Math.max(1, maxTotalOi)) * 100);

  const set = (field: string, text: string, color?: string) => {
    const el = tbody.querySelector<HTMLElement>(`[data-sk="${sk}-${field}"]`);
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    if (color && el.style.color !== color) el.style.color = color;
  };
  const setOiBar = (field: string, text: string, pct: number) => {
    const wrap = tbody.querySelector<HTMLElement>(`[data-sk="${sk}-${field}"]`);
    if (!wrap) return;
    const span = wrap.querySelector<HTMLElement>('span');
    if (span && span.textContent !== text) span.textContent = text;
    const bg = `linear-gradient(to left, rgba(255,152,0,0.25) ${pct.toFixed(1)}%, transparent ${pct.toFixed(1)}%)`;
    if (wrap.style.backgroundImage !== bg) wrap.style.backgroundImage = bg;
  };

  set('ce', fmtPrice(row.ce.ltp));
  set('pe', fmtPrice(row.pe.ltp));
  set('str', str > 0 ? str.toFixed(2) : '—');
  const chgColor = chgPct > 0 ? '#2ebd85' : chgPct < 0 ? '#ef5350' : '#787b86';
  set('chg', chgPct !== 0 ? (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%' : '—', chgColor);
  set('iv', iv > 0 ? iv.toFixed(2) + '%' : '—');
  set('delta', fmtGreek(delta));
  set('theta', fmtGreek(theta));
  set('vega', fmtGreek(vega));
  setOiBar('oi', fmtOi(totalOi), totalOiPct);
}

function StraddleTable({ ins }: { ins: Instrument }) {
  const [rows, setRows]       = useState<StrikeRow[]>([]);
  const [spot, setSpot]       = useState(0);
  const [atm, setAtm]         = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');
  const rowsRef    = useRef<StrikeRow[]>([]);
  const wsRef      = useRef<WebSocket | null>(null);
  const atmRowRef  = useRef<HTMLTableRowElement>(null);
  const tbodyRef   = useRef<HTMLTableSectionElement>(null);
  const rafRef     = useRef<number | null>(null);
  // Pending WS patches — flushed on next RAF
  const pendingRef = useRef<Map<number, StrikeRow>>(new Map());
  const maxOiRef   = useRef(1);

  const session = getSession();

  const parseRest = (opt: Record<string, number>): OptionSide => {
    const ltp = (opt.ltp ?? 0) / 100;
    const ltpchg = opt.ltpchg ?? 0;
    const cp = ltpchg !== -100 ? ltp / (1 + ltpchg / 100) : 0;
    const volume = opt.volume ?? opt.vol ?? opt.total_volume ?? 0;
    return {
      ltp, cp, oi: opt.oi ?? 0,
      oiChgPct: opt.prev_oi != null && opt.oi > 0 ? ((opt.oi - opt.prev_oi) / opt.oi) * 100 : 0,
      delta: opt.delta ?? 0, theta: opt.theta ?? 0, gamma: opt.gamma ?? 0, vega: opt.vega ?? 0, iv: (opt.iv ?? 0) * 100, volume,
    };
  };

  const parseWs = (opt: Record<string, number>): OptionSide => {
    const ltp = opt.last_traded_price ?? 0;
    const chg = opt.last_traded_price_change ?? 0;
    const curOi = opt.open_interest ?? 0; const prevOi = opt.previous_open_interest ?? 0;
    const volume = opt.volume ?? opt.traded_volume ?? opt.total_traded_volume ?? 0;
    return {
      ltp, cp: ltp - chg, oi: curOi,
      oiChgPct: curOi > 0 ? ((curOi - prevOi) / curOi) * 100 : 0,
      delta: opt.delta ?? 0, theta: opt.theta ?? 0, gamma: opt.gamma ?? 0, vega: opt.vega ?? 0, iv: (opt.iv ?? 0) * 100, volume,
    };
  };

  // Schedule a RAF flush — only patches DOM, no setState
  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const pending = pendingRef.current;
      if (pending.size === 0) return;
      pending.forEach(row => patchDOM(tbodyRef, row, maxOiRef.current));
      pending.clear();
    });
  }, []);

  const buildRows = useCallback((
    ceList: Record<string, number>[], peList: Record<string, number>[],
    atmRaw: number, spotRaw: number, isRest: boolean
  ) => {
    const scale = isRest ? 100 : 1;
    const sk    = isRest ? 'sp' : 'strike_price';
    const spotVal = spotRaw / scale;
    const atmVal  = atmRaw > 0 ? atmRaw / scale : spotVal;

    if (isRest) {
      const map = new Map<number, StrikeRow>();
      for (const opt of ceList) {
        const strike = (opt[sk] ?? 0) / scale;
        if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE }, isAtm: false });
        map.get(strike)!.ce = parseRest(opt);
      }
      for (const opt of peList) {
        const strike = (opt[sk] ?? 0) / scale;
        if (!map.has(strike)) map.set(strike, { strike, ce: { ...EMPTY_SIDE }, pe: { ...EMPTY_SIDE }, isAtm: false });
        map.get(strike)!.pe = parseRest(opt);
      }
      const sorted = [...map.values()].sort((a, b) => a.strike - b.strike);
      let atmIdx = 0, minD = Infinity;
      sorted.forEach((r, i) => { const d = Math.abs(r.strike - atmVal); if (d < minD) { minD = d; atmIdx = i; } });
      sorted.forEach((r, i) => { r.isAtm = i === atmIdx; });
      rowsRef.current = sorted;
      maxOiRef.current = Math.max(1, ...sorted.map(r => r.ce.oi + r.pe.oi));
      // Initial load: use React state to mount the DOM structure
      setSpot(spotVal); setAtm(atmVal);
      setRows([...sorted]);
      setLoading(false);
      requestAnimationFrame(() => atmRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    } else {
      // Live tick: mutate rowsRef, queue DOM patches — NO setState
      const existing = rowsRef.current;
      if (existing.length === 0) return;
      const ceMap = new Map<number, OptionSide>();
      const peMap = new Map<number, OptionSide>();
      for (const opt of ceList) { ceMap.set((opt[sk] ?? 0) / scale, parseWs(opt)); }
      for (const opt of peList) { peMap.set((opt[sk] ?? 0) / scale, parseWs(opt)); }

      // Update spot/atm via ref-tracked state only when changed
      setSpot(prev => Math.abs(prev - spotVal) > 0.5 ? spotVal : prev);
      setAtm(prev => prev !== atmVal ? atmVal : prev);

      for (const row of existing) {
        const newCe = ceMap.get(row.strike);
        const newPe = peMap.get(row.strike);
        if (!newCe && !newPe) continue;
        if (newCe) row.ce = newCe;
        if (newPe) row.pe = newPe;
        pendingRef.current.set(row.strike, row);
      }
      maxOiRef.current = Math.max(1, ...existing.map(r => r.ce.oi + r.pe.oi));
      scheduleFlush();
    }
  }, [scheduleFlush]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (!ins.selectedExpiry || !ins.sym || !session) { setRows([]); return; }
    setRows([]); setSpot(0); setAtm(0); rowsRef.current = []; setErr(''); setLoading(true);

    let wsActive = false;
    const restUrl = `/api/nubra-optionchain?session_token=${encodeURIComponent(session)}&instrument=${encodeURIComponent(ins.sym)}&exchange=${encodeURIComponent(ins.exchange)}&expiry=${encodeURIComponent(ins.selectedExpiry)}`;
    fetch(restUrl)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(json => {
        if (wsActive) return;
        const c = json.chain ?? json;
        buildRows(c.ce ?? [], c.pe ?? [], c.atm ?? 0, c.cp ?? c.current_price ?? 0, true);
      })
      .catch(e => { setErr(String(e)); setLoading(false); });

    if (!isMarketOpen()) return;

    const ws = new WebSocket(BRIDGE);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'subscribe', session_token: session, data_type: 'option', symbols: [`${ins.sym}:${ins.selectedExpiry}`], exchange: ins.exchange }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'option' && msg.data) {
          wsActive = true;
          const d = msg.data;
          buildRows(d.ce ?? [], d.pe ?? [], d.at_the_money_strike ?? 0, d.current_price ?? 0, false);
        }
      } catch { /* */ }
    };
    ws.onerror = () => {}; ws.onclose = () => {};
    return () => { ws.close(); wsRef.current = null; };
  }, [ins.sym, ins.exchange, ins.selectedExpiry, session, buildRows]);


  if (err) return <div className={s.tableErr}>{err}</div>;
  if (loading) return <div className={s.tableLoading}><span className={s.spinner}/>Loading chain…</div>;
  if (!ins.sym || !ins.selectedExpiry) return <div className={s.tableEmpty}>Select symbol and expiry</div>;
  if (rows.length === 0) return <div className={s.tableEmpty}>No data</div>;

  const straddlePrice = (row: StrikeRow) => row.ce.ltp + row.pe.ltp;
  const avgIv = (row: StrikeRow) => (row.ce.iv + row.pe.iv) / 2;
  // Straddle chg% — same method as StraddleChart: (ltp_sum - cp_sum) / cp_sum * 100
  const straddleChgPct = (row: StrikeRow) => {
    const ltpSum = row.ce.ltp + row.pe.ltp;
    const cpSum  = row.ce.cp  + row.pe.cp;
    return cpSum > 0 ? ((ltpSum - cpSum) / cpSum) * 100 : 0;
  };


  return (
    <div className={s.tableWrap}>
      <div className={s.spotBar}>
        <span className={s.spotLabel}>Spot</span>
        <span className={s.spotVal}>{spot > 0 ? spot.toFixed(2) : '—'}</span>
        <span className={s.spotSep}>·</span>
        <span className={s.spotLabel}>ATM</span>
        <span className={s.atmVal}>{atm > 0 ? atm.toFixed(0) : '—'}</span>
        <span className={s.spotSep}>·</span>
        <span className={s.spotLabel}>Lot Size</span>
        <span className={s.spotVal}>{ins.lotSize}</span>
      </div>

      <div className={s.tableScroll}>
        <table className={s.table}>
          <thead>
            {/* Super header */}
            <tr className={s.superRow}>
              <th className={s.thSuperStrike} />
              <th colSpan={2} style={{ padding: '6px 0', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'center', background: 'rgba(239,83,80,0.06)', color: '#ef5350', borderBottom: '1px solid rgba(239,83,80,0.15)' }}>CALLS</th>
              <th colSpan={7} className={s.thSuperMid}>SPREAD</th>
            </tr>
            {/* Sub header */}
            <tr className={s.subRow}>
              <th className={s.thStrike}>Strike</th>
              <th className={s.thCall}>Call LTP</th>
              <th className={s.thPut}>Put LTP</th>
              <th className={s.thMid}>Straddle</th>
              <th className={s.thMid}>Chg %</th>
              <th className={s.thMid}>Avg IV</th>
              <th className={s.thMid}>Avg Δ</th>
              <th className={s.thMid}>Avg θ</th>
              <th className={s.thMid}>Avg ν</th>
              <th className={s.thMid}>Total OI</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {rows.map(row => {
              const str        = straddlePrice(row);
              const chgPct     = straddleChgPct(row);
              const iv         = avgIv(row);
              const delta      = (row.ce.delta + row.pe.delta) / 2;
              const theta      = (row.ce.theta + row.pe.theta) / 2;
              const vega       = (row.ce.vega  + row.pe.vega)  / 2;
              const totalOi    = row.ce.oi + row.pe.oi;
              const totalOiPct = Math.min(100, (totalOi / maxOiRef.current) * 100);
              const isAtm      = row.isAtm;
              const sk         = row.strike;
              const chgColor   = chgPct > 0 ? '#2ebd85' : chgPct < 0 ? '#ef5350' : '#787b86';

              return (
                <tr key={sk} ref={isAtm ? atmRowRef : undefined} className={s.tr}>
                  {/* Strike — static, no data-sk needed */}
                  <td className={`${s.tdStrike} ${isAtm ? s.tdStrikeAtm : ''}`}>
                    {isAtm && <span className={s.atmPill}>ATM</span>}
                    <span className={isAtm ? s.strikeValAtm : s.strikeVal}>{sk.toFixed(0)}</span>
                  </td>

                  {/* Live cells — data-sk used by patchDOM */}
                  <td className={`${s.tdCall} ${isAtm ? s.tdCallAtm : ''}`}>
                    <span data-sk={`${sk}-ce`} className={s.priceCall}>{fmtPrice(row.ce.ltp)}</span>
                  </td>
                  <td className={`${s.tdPut} ${isAtm ? s.tdPutAtm : ''}`}>
                    <span data-sk={`${sk}-pe`} className={s.pricePut}>{fmtPrice(row.pe.ltp)}</span>
                  </td>
                  <td className={`${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`}>
                    <span data-sk={`${sk}-str`} className={s.straddleVal}>{str > 0 ? str.toFixed(2) : '—'}</span>
                  </td>
                  <td className={`${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`}>
                    <span data-sk={`${sk}-chg`} style={{ color: chgColor, fontWeight: 600 }}>
                      {chgPct !== 0 ? (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%' : '—'}
                    </span>
                  </td>
                  <td className={`${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`}>
                    <span data-sk={`${sk}-iv`} className={s.ivVal}>{iv > 0 ? iv.toFixed(2) + '%' : '—'}</span>
                  </td>
                  <td className={`${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`}>
                    <span data-sk={`${sk}-delta`} className={s.deltaVal}>{fmtGreek(delta)}</span>
                  </td>
                  <td className={`${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`}>
                    <span data-sk={`${sk}-theta`} className={s.greek}>{fmtGreek(theta)}</span>
                  </td>
                  <td className={`${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`}>
                    <span data-sk={`${sk}-vega`} className={s.greek}>{fmtGreek(vega)}</span>
                  </td>
                  <td className={`${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`}>
                    <div data-sk={`${sk}-oi`} className={s.oiBar}
                      style={{ backgroundImage: `linear-gradient(to left, rgba(255,152,0,0.25) ${totalOiPct.toFixed(1)}%, transparent ${totalOiPct.toFixed(1)}%)` }}>
                      <span className={s.oiVal}>{fmtOi(totalOi)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

function CalendarComparator({ ins }: { ins: Instrument }) {
  const session = getSession();
  const [pickedExpiries, setPickedExpiries] = useState<string[]>(() => ins.expiries.slice(0, 2).filter(Boolean));
  const [buyExpiry, setBuyExpiry] = useState(ins.selectedExpiry ?? '');
  const [sellExpiry, setSellExpiry] = useState(ins.expiries[1] ?? ins.selectedExpiry ?? '');
  const [chains, setChains] = useState<Record<string, ChainSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const fetchedRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const base = ins.expiries.slice(0, 2).filter(Boolean);
    setPickedExpiries(base);
    setBuyExpiry(ins.expiries[0] ?? '');
    setSellExpiry(ins.expiries[1] ?? ins.expiries[0] ?? '');
    setChains({});
    fetchedRef.current = new Set();
    setErr('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ins.id]);

  const compareExpiries = useMemo(() => {
    if (pickedExpiries.length > 0) return pickedExpiries;
    return ins.expiries.slice(0, 2).filter(Boolean);
  }, [pickedExpiries, ins.expiries]);

  useEffect(() => {
    if (!compareExpiries.includes(buyExpiry)) setBuyExpiry(compareExpiries[0] ?? '');
    if (!compareExpiries.includes(sellExpiry)) setSellExpiry(compareExpiries[1] ?? compareExpiries[0] ?? '');
  }, [compareExpiries, buyExpiry, sellExpiry]);

  // REST fetch for any new expiries not yet loaded
  useEffect(() => {
    if (!session || !ins.sym || compareExpiries.length === 0) {
      setChains({});
      fetchedRef.current = new Set();
      return;
    }
    const toFetch = compareExpiries.filter(e => e && !fetchedRef.current.has(e));
    if (toFetch.length === 0) return;

    toFetch.forEach(e => fetchedRef.current.add(e));

    let cancelled = false;
    setLoading(true);
    setErr('');
    Promise.all(
      toFetch.map(async expiry => ({ expiry, data: await fetchOptionChainSnapshot(session, ins.sym, ins.exchange, expiry) }))
    )
      .then(res => {
        if (cancelled) return;
        setChains(prev => {
          const next = { ...prev };
          res.forEach(({ expiry, data }) => { next[expiry] = data; });
          return next;
        });
      })
      .catch(e => {
        toFetch.forEach(exp => fetchedRef.current.delete(exp));
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      // Allow retry on next mount
      toFetch.forEach(exp => fetchedRef.current.delete(exp));
    };
  }, [session, ins.sym, ins.exchange, compareExpiries]);

  // WebSocket live updates for all selected expiries
  const compareExpiriesKey = compareExpiries.slice().sort().join(',');
  useEffect(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    const expList = compareExpiriesKey ? compareExpiriesKey.split(',') : [];
    if (!session || !ins.sym || expList.length === 0 || !isMarketOpen()) return;

    const ws = new WebSocket(BRIDGE);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        action: 'subscribe',
        session_token: session,
        data_type: 'option',
        symbols: expList.map(exp => `${ins.sym}:${exp}`),
        exchange: ins.exchange,
      }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'option' && msg.data && msg.data.expiry) {
          const expiry = String(msg.data.expiry);
          const d = msg.data;
          const snap = buildChainSnapshotWs(d.ce ?? [], d.pe ?? [], d.at_the_money_strike ?? 0, d.current_price ?? 0);
          setChains(prev => prev[expiry] ? { ...prev, [expiry]: snap } : prev);
        }
      } catch { /* */ }
    };
    ws.onerror = () => {};
    ws.onclose = () => {};
    return () => { ws.close(); wsRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, ins.sym, ins.exchange, compareExpiriesKey]);

  const rows = useMemo(() => {
    // Always: nearExpiry = smaller date, farExpiry = larger date
    const [nearExpiry, farExpiry] = buyExpiry <= sellExpiry
      ? [buyExpiry, sellExpiry]
      : [sellExpiry, buyExpiry];

    const nearRows = nearExpiry ? (chains[nearExpiry]?.rows ?? []) : [];
    const farRows  = farExpiry  ? (chains[farExpiry]?.rows  ?? []) : [];
    const nearAtm  = chains[nearExpiry]?.atm ?? 0;
    const farAtm   = chains[farExpiry]?.atm  ?? 0;
    const strikes  = new Set<number>();
    nearRows.forEach(r => strikes.add(r.strike));
    farRows.forEach(r  => strikes.add(r.strike));

    const nearMap = new Map(nearRows.map(r => [r.strike, r]));
    const farMap  = new Map(farRows.map(r  => [r.strike, r]));

    return [...strikes].sort((a, b) => a - b).map(strike => {
      const near = nearMap.get(strike);
      const far  = farMap.get(strike);
      const buyCe   = near?.ce.ltp    ?? 0;
      const buyPe   = near?.pe.ltp    ?? 0;
      const buyCeIv = near?.ce.iv     ?? 0;
      const buyPeIv = near?.pe.iv     ?? 0;
      const buyOi   = (near?.ce.oi ?? 0) + (near?.pe.oi ?? 0);
      const buyVol  = (near?.ce.volume ?? 0) + (near?.pe.volume ?? 0);
      const sellCe   = far?.ce.ltp    ?? 0;
      const sellPe   = far?.pe.ltp    ?? 0;
      const sellCeIv = far?.ce.iv     ?? 0;
      const sellPeIv = far?.pe.iv     ?? 0;
      const sellOi   = (far?.ce.oi ?? 0) + (far?.pe.oi ?? 0);
      const sellVol  = (far?.ce.volume ?? 0) + (far?.pe.volume ?? 0);
      return {
        strike,
        isAtm: (nearAtm > 0 && Math.abs(strike - nearAtm) < 0.5) || (farAtm > 0 && Math.abs(strike - farAtm) < 0.5),
        buyCe, buyPe, buyCeIv, buyPeIv, buyOi, buyVol,
        sellCe, sellPe, sellCeIv, sellPeIv, sellOi, sellVol,
        // Net = Far premium − Near premium (always)
        netCe: sellCe - buyCe,
        netPe: sellPe - buyPe,
        totalOi: buyOi + sellOi,
        totalVol: buyVol + sellVol,
      };
    });
  }, [chains, buyExpiry, sellExpiry]);

  const maxTotalOi  = useMemo(() => Math.max(1, ...rows.map(r => r.totalOi)),  [rows]);
  const maxTotalVol = useMemo(() => Math.max(1, ...rows.map(r => r.totalVol)), [rows]);

  const atmRowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (rows.length === 0) return;
    requestAnimationFrame(() => atmRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [rows]);

  const togglePickedExpiry = (expiry: string) => {
    setPickedExpiries(prev => prev.includes(expiry) ? prev.filter(e => e !== expiry) : [...prev, expiry]);
  };

  return (
    <div className={s.calendarWrap}>
      <div className={s.calendarControls}>
        <div className={s.calendarTopRow}>
          <div className={s.calendarPairSelect}>
            <span className={s.ctrlLabel}>Near Expiry</span>
            <InlineSelect value={buyExpiry || null} options={compareExpiries} onChange={v => setBuyExpiry(String(v))} placeholder="Near expiry" format={fmtExpiry} />
          </div>
          <div className={s.calendarPairSelect}>
            <span className={s.ctrlLabel}>Far Expiry</span>
            <InlineSelect value={sellExpiry || null} options={compareExpiries} onChange={v => setSellExpiry(String(v))} placeholder="Far expiry" format={fmtExpiry} />
          </div>
          <div className={s.netCard}>
            <span className={s.ctrlLabel}>Formula</span>
            <span className={s.netHint}>Net = Far LTP − Near LTP</span>
            <span className={s.netHint}>Per lot multiplier: {ins.lotSize}</span>
          </div>
        </div>
        <div className={s.calendarControlsRow}>
          <span className={s.ctrlLabel}>Calendar Expiries</span>
          <ExpiryMultiSelect options={ins.expiries} selected={compareExpiries} onToggle={togglePickedExpiry} />
        </div>
      </div>

      {err && <div className={s.tableErr}>{err}</div>}
      {loading && <div className={s.tableLoading}><span className={s.spinner} />Loading compare chains...</div>}
      {!loading && !err && rows.length === 0 && <div className={s.tableEmpty}>No data for selected expiries</div>}

      {!loading && !err && rows.length > 0 && (
        <div className={s.calendarTableWrap}>
          <table className={s.calendarTable}>
            <thead>
              {(() => {
                const nearExp = buyExpiry <= sellExpiry ? buyExpiry : sellExpiry;
                const farExp  = buyExpiry <= sellExpiry ? sellExpiry : buyExpiry;
                const nLabel = nearExp ? fmtExpiry(nearExp) : '—';
                const fLabel = farExp  ? fmtExpiry(farExp)  : '—';
                return (
                <tr>
                  <th className={s.thCall}>Near CE IV ({nLabel})</th>
                  <th className={s.thCall}>Far CE IV ({fLabel})</th>
                  <th className={s.thCall}>Near CE LTP ({nLabel})</th>
                  <th className={s.thCall}>Far CE LTP ({fLabel})</th>
                  <th className={s.thStrike}>Strike</th>
                  <th className={s.thPut}>Near PE LTP ({nLabel})</th>
                  <th className={s.thPut}>Far PE LTP ({fLabel})</th>
                  <th className={s.thPut}>Near PE IV ({nLabel})</th>
                  <th className={s.thPut}>Far PE IV ({fLabel})</th>
                  <th className={s.thMid}>Net CE (Far−Near)</th>
                  <th className={s.thMid}>Net PE (Far−Near)</th>
                  <th className={s.thMid}>Straddle OI ({nLabel})</th>
                  <th className={s.thMid}>Straddle OI ({fLabel})</th>
                  <th className={s.thMid}>Total OI</th>
                  <th className={s.thMid}>Straddle Vol ({nLabel})</th>
                  <th className={s.thMid}>Straddle Vol ({fLabel})</th>
                  <th className={s.thMid}>Total Vol</th>
                </tr>
                );
              })()}
            </thead>
            <tbody>
              {rows.map(r => {
                const totalOiPct  = (r.totalOi  / maxTotalOi)  * 100;
                const totalVolPct = (r.totalVol / maxTotalVol) * 100;
                return (
                <tr key={r.strike} ref={r.isAtm ? atmRowRef : undefined} className={s.tr}>
                  <td className={`${s.tdCall} ${r.isAtm ? s.tdCallAtm : ''}`}><span className={s.ivVal}>{r.buyCeIv > 0 ? `${r.buyCeIv.toFixed(2)}%` : '—'}</span></td>
                  <td className={`${s.tdCall} ${r.isAtm ? s.tdCallAtm : ''}`}><span className={s.ivVal}>{r.sellCeIv > 0 ? `${r.sellCeIv.toFixed(2)}%` : '—'}</span></td>
                  <td className={`${s.tdCall} ${r.isAtm ? s.tdCallAtm : ''}`}><span className={s.priceCall}>{fmtPrice(r.buyCe)}</span></td>
                  <td className={`${s.tdCall} ${r.isAtm ? s.tdCallAtm : ''}`}><span className={s.priceCall}>{fmtPrice(r.sellCe)}</span></td>
                  <td className={`${s.tdStrike} ${r.isAtm ? s.tdStrikeAtm : ''}`}>
                    {r.isAtm && <span className={s.atmPill}>ATM</span>}
                    <span className={r.isAtm ? s.strikeValAtm : s.strikeVal}>{r.strike.toFixed(0)}</span>
                  </td>
                  <td className={`${s.tdPut} ${r.isAtm ? s.tdPutAtm : ''}`}><span className={s.pricePut}>{fmtPrice(r.buyPe)}</span></td>
                  <td className={`${s.tdPut} ${r.isAtm ? s.tdPutAtm : ''}`}><span className={s.pricePut}>{fmtPrice(r.sellPe)}</span></td>
                  <td className={`${s.tdPut} ${r.isAtm ? s.tdPutAtm : ''}`}><span className={s.ivVal}>{r.buyPeIv > 0 ? `${r.buyPeIv.toFixed(2)}%` : '—'}</span></td>
                  <td className={`${s.tdPut} ${r.isAtm ? s.tdPutAtm : ''}`}><span className={s.ivVal}>{r.sellPeIv > 0 ? `${r.sellPeIv.toFixed(2)}%` : '—'}</span></td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}>
                    <span className={`${s.netPremium} ${r.netCe >= 0 ? s.netPos : s.netNeg}`}>{fmtPrice(r.netCe)}</span>
                  </td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}>
                    <span className={`${s.netPremium} ${r.netPe >= 0 ? s.netPos : s.netNeg}`}>{fmtPrice(r.netPe)}</span>
                  </td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}><span className={s.oiVal}>{fmtOi(r.buyOi)}</span></td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}><span className={s.oiVal}>{fmtOi(r.sellOi)}</span></td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}>
                    <div className={s.oiBar} style={{ backgroundImage: `linear-gradient(to left, rgba(255,152,0,0.25) ${totalOiPct.toFixed(1)}%, transparent ${totalOiPct.toFixed(1)}%)` }}>
                      <span className={s.oiVal}>{fmtOi(r.totalOi)}</span>
                    </div>
                  </td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}><span className={s.greek}>{fmtOi(r.buyVol)}</span></td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}><span className={s.greek}>{fmtOi(r.sellVol)}</span></td>
                  <td className={`${s.tdMid} ${r.isAtm ? s.tdMidAtm : ''}`}>
                    <div className={s.oiBar} style={{ backgroundImage: `linear-gradient(to left, rgba(99,179,237,0.2) ${totalVolPct.toFixed(1)}%, transparent ${totalVolPct.toFixed(1)}%)` }}>
                      <span className={s.oiVal}>{fmtOi(r.totalVol)}</span>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CombinedComparator({ ins }: { ins: Instrument }) {
  const session = getSession();
  const [pickedExpiries, setPickedExpiries] = useState<string[]>(() => ins.expiries.slice(0, 2).filter(Boolean));
  const [buyExpiry, setBuyExpiry] = useState(ins.expiries[0] ?? '');
  const [sellExpiry, setSellExpiry] = useState(ins.expiries[1] ?? ins.expiries[0] ?? '');
  const [chains, setChains] = useState<Record<string, ChainSnapshot>>({});
  const [visibleCols, setVisibleCols] = useState<string[]>(['baseCeLtp', 'basePeLtp', 'avgIv', 'delta', 'theta', 'vega', 'gamma', 'totalOi']);
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dragActiveKey, setDragActiveKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const dragKeyRef = useRef<string | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const lastSwapTargetRef = useRef<string | null>(null);
  const fetchedRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const base = ins.expiries.slice(0, 2).filter(Boolean);
    setPickedExpiries(base);
    setBuyExpiry(ins.expiries[0] ?? '');
    setSellExpiry(ins.expiries[1] ?? ins.expiries[0] ?? '');
    setChains({});
    fetchedRef.current = new Set();
    setErr('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ins.id]);

  const compareExpiries = useMemo(() => {
    if (pickedExpiries.length > 0) return pickedExpiries;
    return ins.expiries.slice(0, 2).filter(Boolean);
  }, [pickedExpiries, ins.expiries]);
  const selectedExpiries = useMemo(() => compareExpiries.length > 0 ? compareExpiries : (ins.selectedExpiry ? [ins.selectedExpiry] : []), [compareExpiries, ins.selectedExpiry]);
  const ivOptionExpiries = useMemo(
    () => Array.from(new Set([ins.selectedExpiry, buyExpiry, sellExpiry, ...selectedExpiries].filter(Boolean))),
    [ins.selectedExpiry, buyExpiry, sellExpiry, selectedExpiries]
  );
  const comboCols = useMemo(() => {
    const dynamic: ComboColDef[] = ivOptionExpiries.flatMap(exp => ([
      { key: `expStrIv:${exp}`, label: `Straddle IV (${fmtExpiry(exp)})` },
      { key: `expCeIv:${exp}`, label: `CE IV (${fmtExpiry(exp)})` },
      { key: `expPeIv:${exp}`, label: `PE IV (${fmtExpiry(exp)})` },
    ]));
    return [...STATIC_COMBO_COLS, ...dynamic];
  }, [ivOptionExpiries]);

  useEffect(() => {
    if (!compareExpiries.includes(buyExpiry)) setBuyExpiry(compareExpiries[0] ?? '');
    if (!compareExpiries.includes(sellExpiry)) setSellExpiry(compareExpiries[1] ?? compareExpiries[0] ?? '');
  }, [compareExpiries, buyExpiry, sellExpiry]);
  useEffect(() => {
    setVisibleCols(prev => prev.filter(k => comboCols.some(c => c.key === k)));
  }, [comboCols]);

  useEffect(() => {
    if (!session || !ins.sym) {
      setChains({});
      fetchedRef.current = new Set();
      return;
    }
    const needed = Array.from(new Set([ins.selectedExpiry, ...compareExpiries].filter(Boolean)));
    if (needed.length === 0) return;
    const toFetch = needed.filter(e => !fetchedRef.current.has(e));
    if (toFetch.length === 0) return;

    toFetch.forEach(e => fetchedRef.current.add(e));

    let cancelled = false;
    setLoading(true);
    setErr('');
    Promise.all(toFetch.map(async expiry => ({ expiry, data: await fetchOptionChainSnapshot(session, ins.sym, ins.exchange, expiry) })))
      .then(res => {
        if (cancelled) return;
        setChains(prev => {
          const next = { ...prev };
          res.forEach(({ expiry, data }) => { next[expiry] = data; });
          return next;
        });
      })
      .catch(e => {
        toFetch.forEach(exp => fetchedRef.current.delete(exp));
        if (!cancelled) setErr(String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      toFetch.forEach(exp => fetchedRef.current.delete(exp));
    };
  }, [session, ins.sym, ins.exchange, compareExpiries, ins.selectedExpiry]);

  // WebSocket live updates for all selected expiries
  const allExpiriesKey = Array.from(new Set([ins.selectedExpiry, ...compareExpiries].filter(Boolean))).sort().join(',');
  useEffect(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    const allExpiries = allExpiriesKey ? allExpiriesKey.split(',') : [];
    if (!session || !ins.sym || allExpiries.length === 0 || !isMarketOpen()) return;

    const ws = new WebSocket(BRIDGE);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        action: 'subscribe',
        session_token: session,
        data_type: 'option',
        symbols: allExpiries.map(exp => `${ins.sym}:${exp}`),
        exchange: ins.exchange,
      }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'option' && msg.data && msg.data.expiry) {
          const expiry = String(msg.data.expiry);
          const d = msg.data;
          const snap = buildChainSnapshotWs(d.ce ?? [], d.pe ?? [], d.at_the_money_strike ?? 0, d.current_price ?? 0);
          setChains(prev => prev[expiry] ? { ...prev, [expiry]: snap } : prev);
        }
      } catch { /* */ }
    };
    ws.onerror = () => {};
    ws.onclose = () => {};
    return () => { ws.close(); wsRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, ins.sym, ins.exchange, allExpiriesKey]);

  const rows = useMemo(() => {
    const baseRows = ins.selectedExpiry ? (chains[ins.selectedExpiry]?.rows ?? []) : [];
    const buyRows = buyExpiry ? (chains[buyExpiry]?.rows ?? []) : [];
    const sellRows = sellExpiry ? (chains[sellExpiry]?.rows ?? []) : [];
    const baseAtm = chains[ins.selectedExpiry]?.atm ?? 0;
    const strikes = new Set<number>();
    baseRows.forEach(r => strikes.add(r.strike));
    buyRows.forEach(r => strikes.add(r.strike));
    sellRows.forEach(r => strikes.add(r.strike));
    selectedExpiries.forEach(exp => (chains[exp]?.rows ?? []).forEach(r => strikes.add(r.strike)));

    const baseMap = new Map(baseRows.map(r => [r.strike, r]));
    const buyMap = new Map(buyRows.map(r => [r.strike, r]));
    const sellMap = new Map(sellRows.map(r => [r.strike, r]));
    const expMaps = new Map<string, Map<number, StrikeRow>>();
    selectedExpiries.forEach(exp => {
      expMaps.set(exp, new Map((chains[exp]?.rows ?? []).map(r => [r.strike, r])));
    });

    return [...strikes].sort((a, b) => a - b).map(strike => {
      const b = baseMap.get(strike);
      const buy = buyMap.get(strike);
      const sell = sellMap.get(strike);
      const baseCe = b?.ce ?? EMPTY_SIDE;
      const basePe = b?.pe ?? EMPTY_SIDE;
      const buyCe = buy?.ce ?? EMPTY_SIDE;
      const buyPe = buy?.pe ?? EMPTY_SIDE;
      const sellCe = sell?.ce ?? EMPTY_SIDE;
      const sellPe = sell?.pe ?? EMPTY_SIDE;
      const straddleByExpiry: Record<string, number> = {};
      const straddleIvByExpiry: Record<string, number> = {};
      const ceIvByExpiry: Record<string, number> = {};
      const peIvByExpiry: Record<string, number> = {};
      selectedExpiries.forEach(exp => {
        const r = expMaps.get(exp)?.get(strike);
        straddleByExpiry[exp] = r ? r.ce.ltp + r.pe.ltp : 0;
        straddleIvByExpiry[exp] = r ? ((r.ce.iv + r.pe.iv) / 2) : 0;
        ceIvByExpiry[exp] = r?.ce.iv ?? 0;
        peIvByExpiry[exp] = r?.pe.iv ?? 0;
      });
      return {
        strike,
        isAtm: baseAtm > 0 && Math.abs(strike - baseAtm) < 0.5,
        straddle: baseCe.ltp + basePe.ltp,
        straddleByExpiry,
        straddleIvByExpiry,
        ceIvByExpiry,
        peIvByExpiry,
        netCe: sellCe.ltp - buyCe.ltp,
        netPe: sellPe.ltp - buyPe.ltp,
        baseCeLtp: baseCe.ltp,
        basePeLtp: basePe.ltp,
        buyCeLtp: buyCe.ltp,
        buyPeLtp: buyPe.ltp,
        sellCeLtp: sellCe.ltp,
        sellPeLtp: sellPe.ltp,
        avgIv: (baseCe.iv + basePe.iv) / 2,
        delta: (baseCe.delta + basePe.delta) / 2,
        theta: (baseCe.theta + basePe.theta) / 2,
        vega: (baseCe.vega + basePe.vega) / 2,
        gamma: (baseCe.gamma + basePe.gamma) / 2,
        totalIv: baseCe.iv + basePe.iv,
        totalVol: baseCe.volume + basePe.volume,
        totalOi: baseCe.oi + basePe.oi,
      };
    });
  }, [chains, ins.selectedExpiry, buyExpiry, sellExpiry, selectedExpiries]);

  const togglePickedExpiry = (expiry: string) => {
    setPickedExpiries(prev => prev.includes(expiry) ? prev.filter(e => e !== expiry) : [...prev, expiry]);
  };
  const toggleCol = (key: string) => {
    setVisibleCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const renderOptCol = (k: string, r: (typeof rows)[number]) => {
    if (k.startsWith('expStrIv:')) {
      const exp = k.split(':')[1] ?? '';
      const v = r.straddleIvByExpiry[exp] ?? 0;
      return v > 0 ? `${v.toFixed(2)}%` : '—';
    }
    if (k.startsWith('expCeIv:')) {
      const exp = k.split(':')[1] ?? '';
      const v = r.ceIvByExpiry[exp] ?? 0;
      return v > 0 ? `${v.toFixed(2)}%` : '—';
    }
    if (k.startsWith('expPeIv:')) {
      const exp = k.split(':')[1] ?? '';
      const v = r.peIvByExpiry[exp] ?? 0;
      return v > 0 ? `${v.toFixed(2)}%` : '—';
    }
    if (k.endsWith('Ltp')) return fmtPrice(Number(r[k as keyof typeof r]));
    if (k === 'totalOi') return fmtOi(r.totalOi);
    if (k === 'totalVol') return r.totalVol > 0 ? r.totalVol.toLocaleString('en-IN') : '—';
    if (k === 'avgIv' || k === 'totalIv') return Number(r[k as keyof typeof r]) > 0 ? `${Number(r[k as keyof typeof r]).toFixed(2)}%` : '—';
    return fmtGreek(Number(r[k as keyof typeof r]));
  };
  const maxTotalOi = useMemo(() => Math.max(1, ...rows.map(r => r.totalOi || 0)), [rows]);
  const maxTotalVol = useMemo(() => Math.max(1, ...rows.map(r => r.totalVol || 0)), [rows]);

  const labelForCol = (key: string, fallback: string) => {
    const base = ins.selectedExpiry ? fmtExpiry(ins.selectedExpiry) : '—';
    const buy = buyExpiry ? fmtExpiry(buyExpiry) : '—';
    const sell = sellExpiry ? fmtExpiry(sellExpiry) : '—';
    if (key === 'baseCeLtp') return `CE LTP (${base})`;
    if (key === 'basePeLtp') return `PE LTP (${base})`;
    if (key === 'buyCeLtp') return `Buy CE LTP (${buy})`;
    if (key === 'buyPeLtp') return `Buy PE LTP (${buy})`;
    if (key === 'sellCeLtp') return `Sell CE LTP (${sell})`;
    if (key === 'sellPeLtp') return `Sell PE LTP (${sell})`;
    if (key.startsWith('expStrIv:')) return `Straddle IV (${fmtExpiry(key.split(':')[1] ?? '')})`;
    if (key.startsWith('expCeIv:')) return `CE IV (${fmtExpiry(key.split(':')[1] ?? '')})`;
    if (key.startsWith('expPeIv:')) return `PE IV (${fmtExpiry(key.split(':')[1] ?? '')})`;
    return fallback;
  };
  const straddleKeys = selectedExpiries.map(exp => `straddle:${exp}`);
  const availableDragKeys = [...straddleKeys, 'netCe', 'netPe', ...visibleCols];

  useEffect(() => {
    setColumnOrder(prev => {
      const kept = prev.filter(k => availableDragKeys.includes(k));
      const fresh = availableDragKeys.filter(k => !kept.includes(k));
      return [...kept, ...fresh];
    });
  }, [selectedExpiries, visibleCols, buyExpiry, sellExpiry]);

  const orderedKeys = columnOrder.length > 0
    ? columnOrder.filter(k => availableDragKeys.includes(k))
    : availableDragKeys;

  const keyToHeader = (key: string) => {
    if (key.startsWith('straddle:')) return `Straddle (${fmtExpiry(key.split(':')[1] ?? '')})`;
    if (key === 'netCe') return 'Net CE';
    if (key === 'netPe') return 'Net PE';
    return labelForCol(key, comboCols.find(c => c.key === key)?.label ?? key);
  };

  const keyToClass = (key: string) => {
    if (key.startsWith('straddle:') || key === 'netCe' || key === 'netPe') return s.thMid;
    if (key.includes('Pe')) return s.thPut;
    if (key.includes('Ce')) return s.thCall;
    return s.thMid;
  };

  const cellClassForKey = (key: string, isAtm: boolean) => {
    if (key.startsWith('straddle:') || key === 'netCe' || key === 'netPe') return `${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`;
    if (key.includes('Pe')) return `${s.tdPut} ${isAtm ? s.tdPutAtm : ''}`;
    if (key.includes('Ce')) return `${s.tdCall} ${isAtm ? s.tdCallAtm : ''}`;
    return `${s.tdMid} ${isAtm ? s.tdMidAtm : ''}`;
  };

  const moveColumn = (sourceKey: string, targetKey: string) => {
    if (sourceKey === targetKey) return;
    setColumnOrder(prev => {
      const cur = (prev.length > 0 ? prev : availableDragKeys).filter(k => availableDragKeys.includes(k));
      const sourceIdx = cur.indexOf(sourceKey);
      const targetIdx = cur.indexOf(targetKey);
      if (sourceIdx < 0 || targetIdx < 0 || sourceIdx === targetIdx) return cur;
      const next = [...cur];
      const [moved] = next.splice(sourceIdx, 1);
      const insertAt = next.indexOf(targetKey);
      next.splice(insertAt < 0 ? next.length : insertAt, 0, moved);
      return next;
    });
  };

  const onHeadDragStart = (key: string) => {
    dragKeyRef.current = key;
    setDragActiveKey(key);
    setDragOverKey(null);
    lastSwapTargetRef.current = null;
  };

  const onHeadDragOver = (targetKey: string) => {
    const sourceKey = dragKeyRef.current;
    if (!sourceKey || sourceKey === targetKey) return;
    if (lastSwapTargetRef.current === targetKey) return;
    lastSwapTargetRef.current = targetKey;
    if (dragRafRef.current !== null) cancelAnimationFrame(dragRafRef.current);
    dragRafRef.current = requestAnimationFrame(() => {
      moveColumn(sourceKey, targetKey);
      dragRafRef.current = null;
    });
  };

  const clearDragState = () => {
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    dragKeyRef.current = null;
    setDragActiveKey(null);
    setDragOverKey(null);
    lastSwapTargetRef.current = null;
  };

  const onHeadDrop = (targetKey: string) => {
    const sourceKey = dragKeyRef.current;
    if (!sourceKey || sourceKey === targetKey) return clearDragState();
    moveColumn(sourceKey, targetKey);
    clearDragState();
  };

  const renderDynamicCell = (k: string, r: (typeof rows)[number]) => {
    if (k.startsWith('straddle:')) {
      const exp = k.split(':')[1] ?? '';
      const v = r.straddleByExpiry[exp] ?? 0;
      return <span className={s.straddleVal}>{v > 0 ? v.toFixed(2) : '—'}</span>;
    }
    if (k === 'netCe') {
      return <span className={`${s.netPremium} ${r.netCe >= 0 ? s.netPos : s.netNeg}`}>{fmtPrice(r.netCe)}</span>;
    }
    if (k === 'netPe') {
      return <span className={`${s.netPremium} ${r.netPe >= 0 ? s.netPos : s.netNeg}`}>{fmtPrice(r.netPe)}</span>;
    }
    if (k === 'totalOi' || k === 'totalVol') {
      const pct = ((k === 'totalOi' ? r.totalOi : r.totalVol) / (k === 'totalOi' ? maxTotalOi : maxTotalVol)) * 100;
      return (
        <div className={s.comboBar} style={{ backgroundImage: `linear-gradient(to left, rgba(255,255,255,0.12) ${pct.toFixed(1)}%, transparent ${pct.toFixed(1)}%)` }}>
          <span className={s.comboBarVal}>{renderOptCol(k, r)}</span>
        </div>
      );
    }
    return <span className={k.includes('Pe') ? s.pricePut : k.includes('Ce') ? s.priceCall : s.greek}>{renderOptCol(k, r)}</span>;
  };

  return (
    <div className={s.calendarWrap}>
      <div className={s.calendarControls}>
        <div className={s.calendarTopRow}>
          <div className={s.calendarPairSelect}>
            <span className={s.ctrlLabel}>Base Expiry</span>
            <span className={s.ctrlVal}>{ins.selectedExpiry ? fmtExpiry(ins.selectedExpiry) : '—'}</span>
          </div>
          <div className={s.calendarPairSelect}>
            <span className={s.ctrlLabel}>Buy Expiry</span>
            <InlineSelect value={buyExpiry || null} options={compareExpiries} onChange={v => setBuyExpiry(String(v))} format={fmtExpiry} />
          </div>
          <div className={s.calendarPairSelect}>
            <span className={s.ctrlLabel}>Sell Expiry</span>
            <InlineSelect value={sellExpiry || null} options={compareExpiries} onChange={v => setSellExpiry(String(v))} format={fmtExpiry} />
          </div>
          <ColumnMultiSelect columns={comboCols} selected={visibleCols} onToggle={toggleCol} labelFor={labelForCol} />
        </div>
        <div className={s.calendarControlsRow}>
          <span className={s.ctrlLabel}>Calendar Expiries</span>
          <ExpiryMultiSelect options={ins.expiries} selected={compareExpiries} onToggle={togglePickedExpiry} />
        </div>
      </div>

      {err && <div className={s.tableErr}>{err}</div>}
      {loading && <div className={s.tableLoading}><span className={s.spinner} />Loading combined view...</div>}
      {!loading && !err && rows.length === 0 && <div className={s.tableEmpty}>No data for selected expiries</div>}

      {!loading && !err && rows.length > 0 && (
        <div className={s.calendarTableWrap}>
          <table className={s.calendarTable}>
            <thead>
              <tr>
                <th className={s.thStrike}>Strike</th>
                {orderedKeys.map(k => {
                  const narrow = (k === 'delta' || k === 'theta' || k === 'vega') ? s.comboNarrow : '';
                  return (
                    <th
                      key={k}
                      className={`${keyToClass(k)} ${narrow} ${s.draggableHead} ${dragOverKey === k ? s.dragOverHead : ''} ${dragActiveKey === k ? s.draggingHead : ''}`}
                      draggable
                      onDragStart={() => onHeadDragStart(k)}
                      onDragOver={e => { e.preventDefault(); setDragOverKey(k); onHeadDragOver(k); }}
                      onDragLeave={() => setDragOverKey(prev => (prev === k ? null : prev))}
                      onDrop={e => { e.preventDefault(); onHeadDrop(k); }}
                      onDragEnd={clearDragState}
                    >
                      {keyToHeader(k)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.strike} className={s.tr}>
                  <td className={`${s.tdStrike} ${r.isAtm ? s.tdStrikeAtm : ''}`}>
                    {r.isAtm && <span className={s.atmPill}>ATM</span>}
                    <span className={r.isAtm ? s.strikeValAtm : s.strikeVal}>{r.strike.toFixed(0)}</span>
                  </td>
                  {orderedKeys.map(k => (
                    <td key={k} className={`${cellClassForKey(k, r.isAtm)} ${(k === 'delta' || k === 'theta' || k === 'vega') ? s.comboNarrow : ''}`}>
                      {renderDynamicCell(k, r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SpreadAnalyzer({ visible }: Props) {
  const { nubraInstruments } = useInstrumentsCtx();
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [activeId, setActiveId]       = useState<string | null>(null);
  const [viewMode, setViewMode]       = useState<'chain' | 'combo' | 'calendar'>('chain');

  const addInstrument = useCallback(async (sym: string, exchange: string, lotSize: number) => {
    const expiries = await fetchExpiries(sym, exchange);
    const selectedExpiry = expiries[0] ?? '';
    const id = uid();
    const ins: Instrument = { id, sym, exchange, expiries, selectedExpiry, lotSize };
    setInstruments(prev => [...prev, ins]);
    setActiveId(id);
  }, []);

  const setExpiry = useCallback((id: string, expiry: string) => {
    setInstruments(prev => prev.map(i => i.id === id ? { ...i, selectedExpiry: expiry } : i));
  }, []);

  const removeInstrument = useCallback((id: string) => {
    setInstruments(prev => {
      const next = prev.filter(i => i.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }, [activeId]);

  const activeIns = instruments.find(i => i.id === activeId) ?? null;

  return (
    <div className={s.root} style={{ display: visible === false ? 'none' : 'flex' }}>

      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          {/* Tab strip */}
          <div className={s.tabStrip}>
            {instruments.map(ins => (
              <div
                key={ins.id}
                className={`${s.tab} ${ins.id === activeId ? s.tabActive : ''}`}
                onClick={() => setActiveId(ins.id)}
              >
                <span className={s.tabLabel}>{ins.sym}</span>
                <button
                  type="button"
                  className={s.tabClose}
                  onClick={e => { e.stopPropagation(); removeInstrument(ins.id); }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>
            ))}

            <SymbolSearch nubraInstruments={nubraInstruments} onSelect={addInstrument} />
          </div>

          {/* Expiry + info for active tab */}
          {activeIns && (
            <div className={s.controls}>
              <div className={s.viewTabs}>
                <button type="button" className={`${s.viewTab} ${viewMode === 'chain' ? s.viewTabActive : ''}`} onClick={() => setViewMode('chain')}>
                  Option Chain
                </button>
                <button type="button" className={`${s.viewTab} ${viewMode === 'combo' ? s.viewTabActive : ''}`} onClick={() => setViewMode('combo')}>
                  +
                </button>
                <button type="button" className={`${s.viewTab} ${viewMode === 'calendar' ? s.viewTabActive : ''}`} onClick={() => setViewMode('calendar')}>
                  Calendar
                </button>
              </div>
              <span className={s.ctrlLabel}>Expiry</span>
              <InlineSelect
                value={activeIns.selectedExpiry || null}
                options={activeIns.expiries}
                onChange={v => setExpiry(activeIns.id, String(v))}
                placeholder="Expiry"
                format={fmtExpiry}
              />
              <span className={s.ctrlSep}>·</span>
              <span className={s.ctrlLabel}>Lot Size</span>
              <span className={s.ctrlVal}>{activeIns.lotSize}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className={s.content}>
        {activeIns ? (
          viewMode === 'chain' ? (
            <StraddleTable key={`chain-${activeIns.id}`} ins={activeIns} />
          ) : viewMode === 'combo' ? (
            <CombinedComparator key={`combo-${activeIns.id}`} ins={activeIns} />
          ) : (
            <CalendarComparator key={`calendar-${activeIns.id}`} ins={activeIns} />
          )
        ) : (
          <div className={s.empty}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#2A2E39" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2"/>
              <polyline points="2 17 12 22 22 17"/>
              <polyline points="2 12 12 17 22 12"/>
            </svg>
            <p>Search and add a symbol to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}
