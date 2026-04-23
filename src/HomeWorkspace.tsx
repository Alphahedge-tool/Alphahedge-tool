import React, { useState, useCallback, useId, useRef, useEffect, useMemo } from 'react';
import { useInstrumentsCtx } from './AppContext';
import type { Instrument } from './useInstruments';
import { TooltipWrap } from './components/ui/tooltip';
import s from './HomeWorkspace.module.css';

// Lazy imports
const OptionChain  = React.lazy(() => import('./OptionChain'));
const CandleChart  = React.lazy(() => import('./CandleChart'));
const IvChart      = React.lazy(() => import('./IvChart'));
const OpenInterest = React.lazy(() => import('./OpenInterest'));
const VolSkew      = React.lazy(() => import('./VolSkew'));
const FwdVolSpread = React.lazy(() => import('./FwdVolSpread'));
const PcrChart          = React.lazy(() => import('./PcrChart'));
const MaxPain           = React.lazy(() => import('./MaxPain'));
const OIBuildup         = React.lazy(() => import('./OIBuildup'));
const IVRank            = React.lazy(() => import('./IVRank'));
const OIHeatmap         = React.lazy(() => import('./OIHeatmap'));
const SupportResistance = React.lazy(() => import('./SupportResistance'));
const FiiDii            = React.lazy(() => import('./FiiDii'));
const AtmRollingStraddle = React.lazy(() => import('./AtmRollingStraddle'));
const GammaExposure = React.lazy(() => import('./GammaExposure'));
const TotalOiChart  = React.lazy(() => import('./TotalOiChart'));
const OiByExpiryChart = React.lazy(() => import('./OiByExpiryChart'));
const DeltaVolPcr   = React.lazy(() => import('./DeltaVolPcr'));
const ExpiryOiOverview = React.lazy(() => import('./ExpiryOiOverview'));

type PanelContent = 'empty' | 'option-chain' | 'candle-chart' | 'iv-chart' | 'open-interest' | 'vol-skew' | 'fwd-vol' | 'pcr-chart' | 'max-pain' | 'oi-buildup' | 'iv-rank' | 'oi-heatmap' | 'support-resistance' | 'fii-dii' | 'atm-rolling-straddle' | 'gamma-exposure' | 'total-oi-chart' | 'oi-by-expiry' | 'delta-vol-pcr' | 'expiry-oi-overview';

interface Panel {
  id: string;
  minimized: boolean;
  content: PanelContent;
  symbol: string;
  exchange: string;
  expiries: string[];
  instrument: Instrument | null;
}

// ── Grid structure ─────────────────────────────────────────────────────────────
// A Row is a horizontal band. Each row has N columns (panels).
// Rows have a flex size (number); columns within a row also have flex sizes.
interface GridRow {
  id: string;
  size: number;           // flex-grow / percentage height
  cols: GridCol[];
  colSizes: number[];     // flex sizes for each column
}
interface GridCol {
  panelId: string;
}

// Each pinned sidebar panel — multiple allowed, each resizable independently.
interface SidebarItem {
  panelId: string;
  size: number;  // flex-grow for this sidebar's width
}

interface SidebarLayout {
  items: SidebarItem[];
  rightSize: number;  // flex-grow for the main row area
}

// ── Persistence ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'hw_workspace_v6';
const OLD_KEYS = ['hw_workspace_v4', 'hw_workspace_v5'];
const SAVED_TPLS_KEY = 'hw_saved_templates_v1';
interface Saved { panels: Panel[]; rows: GridRow[]; sidebarLayout?: SidebarLayout }

const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = { items: [], rightSize: 1 };

function load(): Saved | null {
  try {
    OLD_KEYS.forEach(k => localStorage.removeItem(k));
    const r = localStorage.getItem(STORAGE_KEY);
    if (!r) return null;
    const parsed = JSON.parse(r) as any;
    if (!parsed.sidebarLayout || !Array.isArray(parsed.sidebarLayout?.items)) {
      parsed.sidebarLayout = DEFAULT_SIDEBAR_LAYOUT;
    }
    return parsed as Saved;
  } catch { return null; }
}
function save(panels: Panel[], rows: GridRow[], sidebarLayout: SidebarLayout) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ panels, rows, sidebarLayout })); } catch {}
}

// ── Saved templates ───────────────────────────────────────────────────────────
interface SavedTemplate {
  id: string;
  name: string;
  rows: number[];
  sourceTemplateId?: string;
  _colSizes: number[][];
  _rowSizes: number[];
  _colContents: PanelContent[][];
}
function loadSavedTemplates(): SavedTemplate[] {
  try { return JSON.parse(localStorage.getItem(SAVED_TPLS_KEY) ?? '[]'); } catch { return []; }
}
function persistSavedTemplates(tpls: SavedTemplate[]) {
  try { localStorage.setItem(SAVED_TPLS_KEY, JSON.stringify(tpls)); } catch {}
}

// ── Content options ───────────────────────────────────────────────────────────
const CONTENT_OPTIONS: { type: PanelContent; label: string; icon: React.ReactNode }[] = [
  { type: 'option-chain',  label: 'Option Chain',  icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> },
  { type: 'candle-chart',  label: 'Candle Chart',  icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  { type: 'iv-chart',      label: 'IV Chart',      icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3,12 6,6 10,18 14,10 18,4 21,8"/><path d="M3 20h18" strokeOpacity="0.4"/></svg> },
  { type: 'open-interest', label: 'Open Interest', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="4" height="18"/><rect x="10" y="8" width="4" height="13"/><rect x="18" y="5" width="4" height="16"/></svg> },
  { type: 'vol-skew',      label: 'Vol Skew',      icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
  { type: 'fwd-vol',       label: 'Fwd Vol Spread', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 20 L8 12 L14 16 L20 6"/><circle cx="20" cy="6" r="2"/></svg> },
  { type: 'pcr-chart',    label: 'PCR Chart',      icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg> },
  { type: 'max-pain',     label: 'Max Pain',       icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> },
  { type: 'oi-buildup',         label: 'OI Buildup',        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg> },
  { type: 'iv-rank',            label: 'IV Rank',           icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg> },
  { type: 'oi-heatmap',         label: 'OI Heatmap',        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M2 9h20M2 15h20M9 2v20M15 2v20"/></svg> },
  { type: 'support-resistance', label: 'Support/Resistance', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 18h18"/><path d="m3 12 9-6 9 6"/></svg> },
  { type: 'fii-dii',            label: 'FII / DII',         icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m3 15 4-4 4 4 4-6 4 2"/></svg> },
  { type: 'atm-rolling-straddle', label: 'ATM Rolling Straddle', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 20h18"/><path d="M6 16l4-4 3 3 5-7"/><circle cx="10" cy="12" r="1.5"/><circle cx="13" cy="15" r="1.5"/></svg> },
  { type: 'gamma-exposure', label: 'Gamma Exposure', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19h16"/><path d="M7 15V9"/><path d="M12 19V5"/><path d="M17 13v-3"/></svg> },
  { type: 'total-oi-chart', label: 'Total OI Chart', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-4"/></svg> },
  { type: 'oi-by-expiry', label: 'OI by Expiry', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-4"/><path d="M7 9h10" strokeDasharray="2 2"/></svg> },
  { type: 'delta-vol-pcr', label: 'Delta & Vol PCR', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m6 15 4-4 3 3 5-7"/><path d="M7 8h3"/><path d="M14 17h3"/></svg> },
  { type: 'expiry-oi-overview', label: 'Expiry OI Overview', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h18"/><path d="M3 10h18"/><path d="M3 20h18"/><path d="M7 10v10"/><path d="M12 13v7"/><path d="M17 16v4"/></svg> },
];

const MIN_COL_PX = 260;
const MIN_ROW_PX = 200;
const SPLITTER_PX = 3;

// ── Highlight ─────────────────────────────────────────────────────────────────
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return <>{text.slice(0, idx)}<span style={{ color: '#FF9800', fontWeight: 700 }}>{text.slice(idx, idx + query.length)}</span>{text.slice(idx + query.length)}</>;
}

// ── SymbolSearch ──────────────────────────────────────────────────────────────
function SymbolSearch({ symbol, nubraInstruments, workerRef, onChange }: {
  symbol: string;
  nubraInstruments: any[];
  workerRef: React.RefObject<Worker | null>;
  onChange: (symbol: string, exchange: string, expiries: string[]) => void;
}) {
  const [query, setQuery]     = useState(symbol);
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen]       = useState(false);
  const [cursor, setCursor]   = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const h = (e: MessageEvent) => {
      if (e.data.type === 'RESULTS') { setResults(e.data.results ?? []); setCursor(0); }
    };
    worker.addEventListener('message', h);
    return () => worker.removeEventListener('message', h);
  }, [workerRef]);

  const resolveExpiries = useCallback((sym: string, exch: string) => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const set = new Set<string>();
    const normSym  = sym.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normExch = exch.toUpperCase().replace(/_INDEX|_FO/g, '');
    for (const item of nubraInstruments) {
      const ie = (item.exchange ?? '').toUpperCase().replace(/_INDEX|_FO/g, '');
      if (normExch && ie && ie !== normExch) continue;
      const matches = [
        (item.asset ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        (item.stock_name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        (item.nubra_name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
      ];
      if (!matches.includes(normSym)) continue;
      if (item.expiry) { const e = String(item.expiry); if (e >= today) set.add(e); }
    }
    return [...set].sort();
  }, [nubraInstruments]);

  const select = useCallback((ins: any) => {
    const sym  = ins.trading_symbol ?? ins.name ?? '';
    const exch = (ins.exchange ?? 'NSE').replace('_INDEX', '').replace('_FO', '');
    setQuery(sym); setOpen(false); setResults([]);
    onChange(sym, exch, resolveExpiries(sym, exch));
  }, [resolveExpiries, onChange]);

  const handleInput = (v: string) => {
    setQuery(v); setCursor(0);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      if (workerRef.current) { workerRef.current.postMessage({ type: 'SEARCH', query: v }); setOpen(true); }
    }, 120);
  };

  const atColor: Record<string, string> = { INDEX_FO: '#818cf8', STOCK_FO: '#60a5fa', STOCKS: '#34d399', ETF: '#f59e0b', INDEX: '#818cf8', MCX: '#f97316' };
  const atBg:    Record<string, string> = { INDEX_FO: 'rgba(129,140,248,0.12)', STOCK_FO: 'rgba(96,165,250,0.10)', STOCKS: 'rgba(52,211,153,0.10)', ETF: 'rgba(245,158,11,0.10)', INDEX: 'rgba(129,140,248,0.12)', MCX: 'rgba(249,115,22,0.12)' };

  return (
    <div className={s.symbolSearch} onMouseDown={e => e.stopPropagation()}>
      <div className={s.searchBox}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>
        <input className={s.searchInput} value={query} placeholder="Search instruments…"
          onChange={e => handleInput(e.target.value)}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
            else if (e.key === 'Enter' && results.length > 0) select(results[cursor]);
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {query && <button className={s.searchClearBtn} onMouseDown={() => { setQuery(''); setOpen(false); }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>}
      </div>
      {open && (
        <div className={s.symbolDropdown}>
          <div className={s.dropdownList}>
            {results.length === 0
              ? <div className={s.dropdownEmpty}>No results for "{query}"</div>
              : results.map((ins, i) => {
                const nubraAt = (ins as any).nubraAssetType as string ?? '';
                return (
                  <div key={ins.instrument_key ?? i} className={`${s.dropdownItem} ${i === cursor ? s.dropdownItemActive : ''}`}
                    onMouseEnter={() => setCursor(i)} onMouseDown={() => select(ins)}>
                    <div className={s.dropdownItemIcon}>
                      {ins.exchange === 'NSE' ? <img src="https://s3-symbol-logo.tradingview.com/source/NSE.svg" alt="NSE" style={{ width: 18, height: 18, objectFit: 'contain', opacity: 0.8 }} />
                        : ins.exchange === 'BSE' ? <img src="https://s3-symbol-logo.tradingview.com/source/BSE.svg" alt="BSE" style={{ width: 18, height: 18, objectFit: 'contain', opacity: 0.8 }} />
                        : <span style={{ fontSize: 9, fontWeight: 700, color: '#9598A1' }}>{ins.exchange}</span>}
                    </div>
                    <div className={s.dropdownItemBody}>
                      <div className={s.dropdownItemName}><Highlight text={ins.trading_symbol ?? ''} query={query} /></div>
                      <div className={s.dropdownItemExch}>{ins.exchange}</div>
                    </div>
                    {nubraAt && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: atBg[nubraAt] ?? 'rgba(255,255,255,0.05)', color: atColor[nubraAt] ?? '#565A6B', fontWeight: 700, letterSpacing: '0.03em', flexShrink: 0 }}>{nubraAt}</span>}
                  </div>
                );
              })
            }
          </div>
          <div className={s.dropdownFooter}><span><kbd>↵</kbd> select</span><span><kbd>Esc</kbd> close</span></div>
        </div>
      )}
    </div>
  );
}

// ── CandleSymbolSearch ────────────────────────────────────────────────────────
function CandleSymbolSearch({ workerRef, selected, onChange }: {
  workerRef: React.RefObject<Worker | null>;
  selected: Instrument | null;
  onChange: (ins: Instrument) => void;
}) {
  const [query, setQuery]     = useState(selected?.trading_symbol ?? '');
  const [results, setResults] = useState<Instrument[]>([]);
  const [open, setOpen]       = useState(false);
  const [cursor, setCursor]   = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const h = (e: MessageEvent) => {
      if (e.data.type === 'RESULTS') { setResults(e.data.results ?? []); setCursor(0); setOpen((e.data.results ?? []).length > 0); }
    };
    worker.addEventListener('message', h);
    return () => worker.removeEventListener('message', h);
  }, [workerRef]);

  const select = useCallback((ins: Instrument) => {
    setQuery(ins.trading_symbol ?? ins.name ?? ''); setOpen(false); setResults([]); onChange(ins);
  }, [onChange]);

  const handleInput = (v: string) => {
    setQuery(v); setCursor(0);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { workerRef.current?.postMessage({ type: 'SEARCH', query: v }); }, 120);
  };

  return (
    <div className={s.symbolSearch} onMouseDown={e => e.stopPropagation()}>
      <div className={s.searchBox}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>
        <input className={s.searchInput} value={query} placeholder="Search symbol…"
          onChange={e => handleInput(e.target.value)}
          onFocus={() => { if (query.trim()) workerRef.current?.postMessage({ type: 'SEARCH', query }); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
            else if (e.key === 'Enter' && results.length > 0) select(results[cursor]);
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {query && <button className={s.searchClearBtn} onMouseDown={() => { setQuery(''); setOpen(false); }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>}
      </div>
      {open && (
        <div className={s.symbolDropdown}>
          <div className={s.dropdownList}>
            {results.length === 0 ? <div className={s.dropdownEmpty}>No results for "{query}"</div>
              : results.map((ins, i) => (
                <div key={ins.instrument_key} className={`${s.dropdownItem} ${i === cursor ? s.dropdownItemActive : ''}`}
                  onMouseEnter={() => setCursor(i)} onMouseDown={() => select(ins)}>
                  <div className={s.dropdownItemIcon}><span style={{ fontSize: 9, fontWeight: 700, color: '#9598A1' }}>{ins.exchange}</span></div>
                  <div className={s.dropdownItemBody}>
                    <div className={s.dropdownItemName}><Highlight text={ins.trading_symbol ?? ''} query={query} /></div>
                    <div className={s.dropdownItemExch}>{ins.instrument_type} · {ins.exchange}</div>
                  </div>
                </div>
              ))}
          </div>
          <div className={s.dropdownFooter}><span><kbd>↵</kbd> select</span><span><kbd>Esc</kbd> close</span></div>
        </div>
      )}
    </div>
  );
}

const noop = () => {};

// ── PanelBody ─────────────────────────────────────────────────────────────────
const PanelBody = React.memo(function PanelBody({ content, symbol, exchange, expiries, instrument, nubraSession, workerRef, chartWorkerRef, onSymbolChange, onSearchOpen }: {
  content: PanelContent; symbol: string; exchange: string; expiries: string[];
  instrument: Instrument | null; nubraSession: string;
  workerRef: React.RefObject<Worker | null>; chartWorkerRef: React.RefObject<Worker | null>;
  onSymbolChange: (s: string, e: string, exp: string[]) => void; onSearchOpen?: () => void;
}) {
  const { instruments, nubraInstruments } = useInstrumentsCtx();

  if (content === 'empty') return <div className={s.empty}><span>Empty panel</span></div>;

  return (
    <React.Suspense fallback={<div className={s.loading}>Loading…</div>}>
      {content === 'option-chain' && (
        <div className={s.panelInner}>
          <SymbolSearch symbol={symbol} nubraInstruments={nubraInstruments} workerRef={workerRef} onChange={onSymbolChange} />
          <div className={s.panelContent}>
            <OptionChain symbol={symbol} expiries={expiries} sessionToken={nubraSession} exchange={exchange} instruments={instruments} onClose={noop} />
          </div>
        </div>
      )}
      {content === 'candle-chart' && (
        <div style={{ width: '100%', height: '100%' }}>
          {instrument ? <CandleChart instrument={instrument} instruments={instruments} visible onSearchOpen={onSearchOpen} />
            : <div className={s.empty}><span>Loading…</span></div>}
        </div>
      )}
      {content === 'iv-chart' && (
        <div style={{ width: '100%', height: '100%' }}>
          <IvChart instruments={instruments} nubraInstruments={nubraInstruments} workerRef={chartWorkerRef} initialSymbol={symbol || 'NIFTY'} />
        </div>
      )}
      {content === 'open-interest' && (
        <div style={{ width: '100%', height: '100%' }}>
          <OpenInterest nubraInstruments={nubraInstruments} initialSymbol={symbol || 'NIFTY'} />
        </div>
      )}
      {content === 'vol-skew' && (
        <div style={{ width: '100%', height: '100%' }}>
          <VolSkew nubraInstruments={nubraInstruments} initialSymbol={symbol || 'NIFTY'} />
        </div>
      )}
      {content === 'fwd-vol' && (
        <div style={{ width: '100%', height: '100%' }}>
          <FwdVolSpread nubraInstruments={nubraInstruments} />
        </div>
      )}
      {content === 'pcr-chart' && (
        <div style={{ width: '100%', height: '100%' }}>
          <PcrChart nubraInstruments={nubraInstruments} />
        </div>
      )}
      {content === 'max-pain' && (
        <div style={{ width: '100%', height: '100%' }}>
          <MaxPain nubraInstruments={nubraInstruments} />
        </div>
      )}
      {content === 'oi-buildup' && (
        <div style={{ width: '100%', height: '100%' }}>
          <OIBuildup nubraInstruments={nubraInstruments} />
        </div>
      )}
      {content === 'iv-rank' && (
        <div style={{ width: '100%', height: '100%' }}>
          <IVRank nubraInstruments={nubraInstruments} />
        </div>
      )}
      {content === 'oi-heatmap' && (
        <div style={{ width: '100%', height: '100%' }}>
          <OIHeatmap nubraInstruments={nubraInstruments} />
        </div>
      )}
      {content === 'support-resistance' && (
        <div style={{ width: '100%', height: '100%' }}>
          <SupportResistance nubraInstruments={nubraInstruments} />
        </div>
      )}
      {content === 'fii-dii' && (
        <div style={{ width: '100%', height: '100%' }}>
          <FiiDii />
        </div>
      )}
      {content === 'atm-rolling-straddle' && (
        <div style={{ width: '100%', height: '100%' }}>
          <AtmRollingStraddle instruments={instruments} />
        </div>
      )}
      {content === 'gamma-exposure' && (
        <div style={{ width: '100%', height: '100%' }}>
          <GammaExposure nubraInstruments={nubraInstruments} initialSymbol={symbol || 'NIFTY'} sessionToken={nubraSession} />
        </div>
      )}
      {content === 'total-oi-chart' && (
        <div style={{ width: '100%', height: '100%' }}>
          <TotalOiChart nubraInstruments={nubraInstruments} initialSymbol={symbol || 'NIFTY'} />
        </div>
      )}
      {content === 'oi-by-expiry' && (
        <div style={{ width: '100%', height: '100%' }}>
          <OiByExpiryChart nubraInstruments={nubraInstruments} initialSymbol={symbol || 'NIFTY'} />
        </div>
      )}
      {content === 'delta-vol-pcr' && (
        <div style={{ width: '100%', height: '100%' }}>
          <DeltaVolPcr nubraInstruments={nubraInstruments} initialSymbol={symbol || 'NIFTY'} />
        </div>
      )}
      {content === 'expiry-oi-overview' && (
        <div style={{ width: '100%', height: '100%', padding: '10px', boxSizing: 'border-box', overflow: 'auto' }}>
          <ExpiryOiOverview
            nubraInstruments={nubraInstruments}
            initialSymbol={symbol || 'NIFTY'}
            initialSelectedExpiry={expiries[0]}
          />
        </div>
      )}
    </React.Suspense>
  );
});

// ── PanelCard ─────────────────────────────────────────────────────────────────
const PanelCard = React.memo(function PanelCard({ panel, onClose, onToggleMin, onSetContent, onSetSymbol, onSetInstrument, onAddSide, onAddBelow, onPinSidebar, onUnpinSidebar, nubraSession, workerRef, chartWorkerRef }: {
  panel: Panel; onClose: (id: string) => void; onToggleMin: (id: string) => void;
  onSetContent: (id: string, c: PanelContent) => void;
  onSetSymbol: (id: string, s: string, e: string, exp: string[]) => void;
  onSetInstrument: (id: string, ins: Instrument) => void;
  onAddSide: (id: string) => void;
  onAddBelow: (id: string) => void;
  onPinSidebar?: (id: string) => void;
  onUnpinSidebar?: () => void;
  nubraSession: string; workerRef: React.RefObject<Worker | null>; chartWorkerRef: React.RefObject<Worker | null>;
}) {
  const [showMenu, setShowMenu]           = useState(false);
  const [showPanelMenu, setShowPanelMenu] = useState(false);
  const [showCandleSearch, setShowCandleSearch] = useState(false);
  const candleWorkerRef = useRef<Worker | null>(null);
  const { instruments } = useInstrumentsCtx();

  useEffect(() => {
    if (panel.content !== 'candle-chart') return;
    const w = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    candleWorkerRef.current = w;
    if (instruments.length > 0) w.postMessage({ type: 'BUILD', instruments });
    return () => { w.terminate(); candleWorkerRef.current = null; };
  }, [panel.content]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!candleWorkerRef.current || instruments.length === 0) return;
    candleWorkerRef.current.postMessage({ type: 'BUILD', instruments });
  }, [instruments]);

  const handleSymbolChange = useCallback((sym: string, exch: string, exp: string[]) => onSetSymbol(panel.id, sym, exch, exp), [panel.id, onSetSymbol]);
  const handleInstrumentSelect = useCallback((ins: Instrument) => { onSetInstrument(panel.id, ins); setShowCandleSearch(false); }, [panel.id, onSetInstrument]);
  const handleSearchOpen = useCallback(() => setShowCandleSearch(true), []);

  const label = CONTENT_OPTIONS.find(o => o.type === panel.content)?.label ?? 'Panel';

  return (
    <div className={s.card}>
      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.titlePill}>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7eb8ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>
          </svg>
          <span className={s.titleText}>{panel.content === 'empty' ? 'Panel' : label}</span>
        </div>

        <div className={s.controls}>
          {/* Content menu */}
          <div className={s.menuWrap}>
            <TooltipWrap content="Change content" side="bottom" align="center" sideOffset={10}>
              <button className={`${s.ctrlBtn} ${s.addContentBtn}`}
                onClick={e => { e.stopPropagation(); setShowMenu(v => !v); setShowPanelMenu(false); }} aria-label="Change content">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <line x1="5" y1="1" x2="5" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </TooltipWrap>
            {showMenu && (
              <div className={s.menu} onMouseDown={e => e.stopPropagation()}>
                {CONTENT_OPTIONS.map(opt => (
                  <button key={opt.type} className={`${s.menuItem} ${panel.content === opt.type ? s.menuItemActive : ''}`}
                    onClick={() => { onSetContent(panel.id, opt.type); setShowMenu(false); }}>
                    <span className={s.menuIcon}>{opt.icon}</span>{opt.label}
                  </button>
                ))}
                {panel.content !== 'empty' && (
                  <button className={s.menuItem} onClick={() => { onSetContent(panel.id, 'empty'); setShowMenu(false); }}>
                    <span className={s.menuIcon}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Panel layout menu */}
          <div className={s.menuWrap}>
            <TooltipWrap content="Add panel" side="bottom" align="center" sideOffset={10}>
              <button className={`${s.ctrlBtn} ${s.minBtn}`}
                onClick={e => { e.stopPropagation(); setShowPanelMenu(v => !v); setShowMenu(false); }} aria-label="Add panel">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <rect x="0.5" y="0.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                  <rect x="6.5" y="0.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                  <rect x="0.5" y="6.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                  <rect x="6.5" y="6.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
              </button>
            </TooltipWrap>
            {showPanelMenu && (
              <div className={s.menu} onMouseDown={e => e.stopPropagation()}>
                <button className={s.menuItem} onClick={() => { onAddSide(panel.id); setShowPanelMenu(false); }}>
                  <span className={s.menuIcon}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/>
                    </svg>
                  </span>
                  Add to Right
                </button>
                <button className={s.menuItem} onClick={() => { onAddBelow(panel.id); setShowPanelMenu(false); }}>
                  <span className={s.menuIcon}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="18" height="7" rx="1"/>
                    </svg>
                  </span>
                  Add Below
                </button>
                <button className={s.menuItem} onClick={() => { onToggleMin(panel.id); setShowPanelMenu(false); }}>
                  <span className={s.menuIcon}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="4" y1="12" x2="20" y2="12"/>
                    </svg>
                  </span>
                  {panel.minimized ? 'Restore' : 'Minimize'}
                </button>
                {onPinSidebar && (
                  <button className={s.menuItem} onClick={() => { onPinSidebar(panel.id); setShowPanelMenu(false); }}>
                    <span className={s.menuIcon}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="7" height="18" rx="1"/><rect x="13" y="3" width="9" height="8" rx="1"/><rect x="13" y="14" width="9" height="7" rx="1"/>
                      </svg>
                    </span>
                    Pin as Sidebar
                  </button>
                )}
                {onUnpinSidebar && (
                  <button className={s.menuItem} onClick={() => { onUnpinSidebar(); setShowPanelMenu(false); }}>
                    <span className={s.menuIcon}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="18" rx="1"/><line x1="9" y1="3" x2="9" y2="21"/>
                      </svg>
                    </span>
                    Unpin Sidebar
                  </button>
                )}
              </div>
            )}
          </div>

          <TooltipWrap content="Close" side="bottom" align="center" sideOffset={10}>
            <button className={`${s.ctrlBtn} ${s.closeBtn}`} onClick={() => onClose(panel.id)} aria-label="Close">
              <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </TooltipWrap>
        </div>
      </div>

      {/* ── Body ── */}
      {!panel.minimized && (
        <div className={s.body} onClick={() => { setShowMenu(false); setShowPanelMenu(false); }}>
          {showCandleSearch && panel.content === 'candle-chart' && (
            <div className={s.candleSearchOverlay} onMouseDown={e => e.stopPropagation()}>
              <CandleSymbolSearch workerRef={candleWorkerRef} selected={panel.instrument} onChange={handleInstrumentSelect} />
              <button className={s.candleSearchClose} onClick={() => setShowCandleSearch(false)}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              </button>
            </div>
          )}
          <PanelBody
            content={panel.content} symbol={panel.symbol} exchange={panel.exchange}
            expiries={panel.expiries} instrument={panel.instrument}
            nubraSession={nubraSession} workerRef={workerRef} chartWorkerRef={chartWorkerRef}
            onSymbolChange={handleSymbolChange} onSearchOpen={handleSearchOpen}
          />
        </div>
      )}
    </div>
  );
});

// ── ColSplitter — drag to resize columns within a row ─────────────────────────
function ColSplitter({ onDrag }: { onDrag: (dx: number) => void }) {
  const dragging = useRef(false);
  const lastX    = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;

    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      onDrag(ev.clientX - lastX.current);
      lastX.current = ev.clientX;
    };
    const up = () => { dragging.current = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  return <div className={s.colSplitter} onMouseDown={onMouseDown} />;
}

// ── RowSplitter — drag to resize rows ─────────────────────────────────────────
function RowSplitter({ onDrag }: { onDrag: (dy: number) => void }) {
  const dragging = useRef(false);
  const lastY    = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastY.current = e.clientY;

    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      onDrag(ev.clientY - lastY.current);
      lastY.current = ev.clientY;
    };
    const up = () => { dragging.current = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  return <div className={s.rowSplitter} onMouseDown={onMouseDown} />;
}

// ── Layout templates ──────────────────────────────────────────────────────────
// Each template describes a grid as rows of column counts.
// e.g. [[1]] = 1 panel, [[2]] = 2 side by side, [[1],[1]] = 2 stacked
interface LayoutTemplate {
  id: string;
  label: string;
  // rows: each element = number of columns in that row
  rows: number[];
  preview: React.ReactNode;
}

const TEMPLATES: LayoutTemplate[] = [
  {
    id: '1',
    label: '1 Panel',
    rows: [1],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="56" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '2h',
    label: '2 Side by Side',
    rows: [2],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="26" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="32" y="2" width="26" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '2v',
    label: '2 Stacked',
    rows: [1, 1],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="56" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="22" width="56" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '3h',
    label: '3 Columns',
    rows: [3],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="16" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="22" y="2" width="16" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="42" y="2" width="16" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '3v',
    label: '3 Rows',
    rows: [1, 1, 1],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="56" height="10" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="15" width="56" height="10" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="28" width="56" height="10" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '1l2r',
    label: 'Main + 2 Right',
    rows: [1, 1],   // special — handled in applyTemplate
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="32" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="38" y="2" width="20" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="38" y="22" width="20" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '2t1b',
    label: '2 Top + 1 Bottom',
    rows: [2, 1],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="26" height="18" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="32" y="2" width="26" height="18" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="24" width="56" height="14" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '1t2b',
    label: '1 Top + 2 Bottom',
    rows: [1, 2],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="56" height="18" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="24" width="26" height="14" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="32" y="24" width="26" height="14" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '4',
    label: '4 Panels (2×2)',
    rows: [2, 2],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="26" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="32" y="2" width="26" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="22" width="26" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="32" y="22" width="26" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '6',
    label: '6 Panels (3×2)',
    rows: [3, 3],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="22" y="2" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="42" y="2" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="22" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="22" y="22" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="42" y="22" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '1l3r',
    label: 'Wide Left + 3 Right',
    rows: [1, 1, 1],  // special — handled in applyTemplate
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="30" height="36" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="36" y="2" width="22" height="10" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="36" y="15" width="22" height="10" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="36" y="28" width="22" height="10" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: '3t2b',
    label: '3 Top + 2 Bottom',
    rows: [3, 2],
    preview: (
      <svg viewBox="0 0 60 40" fill="none">
        <rect x="2" y="2" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="22" y="2" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="42" y="2" width="16" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="2" y="22" width="26" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
        <rect x="32" y="22" width="26" height="16" rx="3" fill="rgba(79,142,247,0.15)" stroke="rgba(79,142,247,0.5)" strokeWidth="1.5"/>
      </svg>
    ),
  },
];

// ── Custom builder types ───────────────────────────────────────────────────────
interface BuilderRow {
  cols: number;
  size: number;                           // row flex size
  sizes: number[];                        // col flex sizes
  contents: (PanelContent | 'empty')[];   // per-col content
}
const CONTENT_SHORT: Record<PanelContent, string> = {
  'empty':         'Empty',
  'option-chain':  'OC',
  'candle-chart':  'Chart',
  'iv-chart':      'IV',
  'open-interest': 'OI',
  'vol-skew':      'Skew',
  'fwd-vol':       'FwdVol',
  'pcr-chart':     'PCR',
  'max-pain':            'MaxPain',
  'oi-buildup':          'OI Build',
  'iv-rank':             'IV Rank',
  'oi-heatmap':          'OI Heat',
  'support-resistance':  'S/R',
  'fii-dii':             'FII/DII',
  'atm-rolling-straddle': 'ATM Roll',
  'gamma-exposure':      'GEX',
  'total-oi-chart':      'Total OI',
  'oi-by-expiry':        'OI/Expiry',
  'delta-vol-pcr':       'D/V PCR',
  'expiry-oi-overview':  'Expiry OI',
};

// ── TemplatePicker ─────────────────────────────────────────────────────────────
function TemplatePicker({ onApply }: { onApply: (tpl: LayoutTemplate) => void }) {
  const [mode, setMode] = useState<'templates' | 'custom' | 'saved'>('templates');
  const [builderRows, setBuilderRows] = useState<BuilderRow[]>([
    { cols: 2, size: 1, sizes: [1, 1], contents: ['empty', 'empty'] },
  ]);
  const [pickerOpen, setPickerOpen] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // ── Saved templates state ──
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => loadSavedTemplates());
  const [savingName, setSavingName]   = useState(false);
  const [nameInput,  setNameInput]    = useState('');
  const [savedFlash, setSavedFlash]   = useState(false);
  const [templateToSave, setTemplateToSave] = useState<LayoutTemplate | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const openSaveInput = () => {
    setTemplateToSave(null);
    setSavingName(true);
    setNameInput('');
    setTimeout(() => nameInputRef.current?.focus(), 30);
  };

  const openTemplateSaveInput = (tpl: LayoutTemplate) => {
    setTemplateToSave(tpl);
    setSavingName(true);
    setNameInput(tpl.label);
    setTimeout(() => nameInputRef.current?.focus(), 30);
  };

  const commitSave = () => {
    const name = nameInput.trim();
    if (!name) { setSavingName(false); setTemplateToSave(null); return; }

    const fromTemplate = templateToSave !== null;
    const rows = fromTemplate ? templateToSave.rows : builderRows.map(r => r.cols);
    const colSizes = fromTemplate ? ((templateToSave as any)._colSizes ?? []) : builderRows.map(r => r.sizes);
    const rowSizes = fromTemplate ? ((templateToSave as any)._rowSizes ?? []) : builderRows.map(r => r.size ?? 1);
    const colContents = fromTemplate ? ((templateToSave as any)._colContents ?? []) : builderRows.map(r => r.contents);

    const tpl: SavedTemplate = {
      id: `saved_${Date.now()}`,
      name,
      sourceTemplateId: fromTemplate ? templateToSave.id : undefined,
      rows,
      _colSizes: colSizes,
      _rowSizes: rowSizes,
      _colContents: colContents,
    };
    const next = [...savedTemplates, tpl];
    setSavedTemplates(next);
    persistSavedTemplates(next);
    setSavingName(false);
    setTemplateToSave(null);
    setNameInput('');
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  const quickApplyAndSave = (tpl: LayoutTemplate) => {
    const tplRecord: SavedTemplate = {
      id: `saved_${Date.now()}`,
      name: tpl.label,
      sourceTemplateId: tpl.id,
      rows: tpl.rows,
      _colSizes: (tpl as any)._colSizes ?? [],
      _rowSizes: (tpl as any)._rowSizes ?? [],
      _colContents: (tpl as any)._colContents ?? [],
    };
    const next = [...savedTemplates, tplRecord];
    setSavedTemplates(next);
    persistSavedTemplates(next);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
    onApply(tpl);
  };

  const deleteSaved = (id: string) => {
    const next = savedTemplates.filter(t => t.id !== id);
    setSavedTemplates(next);
    persistSavedTemplates(next);
  };

  const applySaved = (t: SavedTemplate) => {
    onApply({
      id: t.sourceTemplateId ?? t.id,
      label: t.name,
      rows: t.rows,
      preview: <></>,
      _colSizes: t._colSizes,
      _rowSizes: t._rowSizes,
      _colContents: t._colContents,
    } as any);
  };

  const addBuilderRow = () => {
    if (builderRows.length >= 8) return;
    setBuilderRows(r => [...r, { cols: 2, size: 1, sizes: [1, 1], contents: ['empty', 'empty'] }]);
  };
  const removeBuilderRow = (i: number) => setBuilderRows(r => r.filter((_, idx) => idx !== i));

  const setBuilderCols = (rowIdx: number, cols: number) => {
    setBuilderRows(r => r.map((row, i) => {
      if (i !== rowIdx) return row;
      return {
        cols,
        size:     row.size,
        sizes:    Array.from({ length: cols }, (_, ci) => row.sizes[ci] ?? 1),
        contents: Array.from({ length: cols }, (_, ci) => row.contents[ci] ?? 'empty') as PanelContent[],
      };
    }));
  };

  const setColContent = (rowIdx: number, colIdx: number, content: PanelContent) => {
    setBuilderRows(r => r.map((row, i) => {
      if (i !== rowIdx) return row;
      const contents = [...row.contents];
      contents[colIdx] = content;
      return { ...row, contents };
    }));
    setPickerOpen(null);
  };

  // ── Col splitter drag inside preview ──────────────────────────────────────
  const onPreviewColDrag = (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startSizes = [...builderRows[rowIdx].sizes];
    const container = previewRef.current;
    if (!container) return;
    const rowEl = container.children[rowIdx * 2] as HTMLElement; // *2 because row splitters in between
    const totalW = rowEl?.offsetWidth ?? container.offsetWidth;
    const totalSize = startSizes.reduce((a, b) => a + b, 0);

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const delta = (dx / totalW) * totalSize;
      const newSizes = [...startSizes];
      newSizes[colIdx]     = Math.max(0.1, startSizes[colIdx] + delta);
      newSizes[colIdx + 1] = Math.max(0.1, startSizes[colIdx + 1] - delta);
      setBuilderRows(r => r.map((row, i) => i === rowIdx ? { ...row, sizes: newSizes } : row));
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  // ── Row splitter drag inside preview ──────────────────────────────────────
  const onPreviewRowDrag = (rowIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const container = previewRef.current;
    if (!container) return;

    // Measure actual rendered heights of each row element (skip splitter divs)
    const rowEls = Array.from(container.querySelectorAll('[data-preview-row]')) as HTMLElement[];
    const renderedHeights = rowEls.map(el => el.offsetHeight);
    const totalRenderedH  = renderedHeights.reduce((a, b) => a + b, 0) || 1;

    const startRowSizes = builderRows.map(r => r.size ?? 1);
    const totalSize = startRowSizes.reduce((a, b) => a + b, 0);
    // px per size unit
    const pxPerUnit = totalRenderedH / totalSize;

    const move = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const delta = dy / pxPerUnit;
      setBuilderRows(r => r.map((row, i) => {
        if (i === rowIdx)     return { ...row, size: Math.max(0.08, startRowSizes[i] + delta) };
        if (i === rowIdx + 1) return { ...row, size: Math.max(0.08, startRowSizes[i] - delta) };
        return row;
      }));
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const applyCustom = () => {
    const tpl: LayoutTemplate = {
      id: 'custom', label: 'Custom',
      rows: builderRows.map(r => r.cols),
      preview: <></>,
      _colSizes:    builderRows.map(r => r.sizes),
      _rowSizes:    builderRows.map(r => (r as any).size ?? 1),
      _colContents: builderRows.map(r => r.contents),
    } as any;
    onApply(tpl);
  };

  const totalPanels = builderRows.reduce((a, r) => a + r.cols, 0);

  return (
    <div className={s.root}>
      <div className={s.templatePicker}>
        <div className={s.tplTabs}>
          <button className={`${s.tplTab} ${mode === 'templates' ? s.tplTabActive : ''}`} onClick={() => setMode('templates')}>Templates</button>
          <button className={`${s.tplTab} ${mode === 'custom'    ? s.tplTabActive : ''}`} onClick={() => setMode('custom')}>Custom</button>
          <button className={`${s.tplTab} ${mode === 'saved'     ? s.tplTabActive : ''}`} onClick={() => setMode('saved')}>
            Saved {savedTemplates.length > 0 && <span className={s.tplTabBadge}>{savedTemplates.length}</span>}
          </button>
        </div>
        {savingName && mode === 'templates' && (
          <div className={s.templateSaveBar}>
            <div className={s.saveNameRow}>
              <input
                ref={nameInputRef}
                className={s.saveNameInput}
                placeholder="Layout name…"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitSave();
                  else if (e.key === 'Escape') { setSavingName(false); setTemplateToSave(null); }
                }}
              />
              <button className={s.saveNameConfirm} onClick={commitSave} disabled={!nameInput.trim()}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
              <button className={s.saveNameCancel} onClick={() => { setSavingName(false); setTemplateToSave(null); }}>
                <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>
        )}

        {mode === 'templates' && (
          <>
            <div className={s.templatePickerTitle}>Choose a layout</div>
            <div className={s.templateGrid}>
              {TEMPLATES.map(tpl => (
                <div key={tpl.id} className={s.templateCardWrap}>
                  <TooltipWrap content="Apply and save layout" side="top" align="center" sideOffset={10}>
                    <button
                      className={s.templateCardApplySave}
                      aria-label="Apply and save layout"
                      onClick={(e) => { e.stopPropagation(); quickApplyAndSave(tpl); }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                      </svg>
                    </button>
                  </TooltipWrap>
                  <button className={s.templateCard} onClick={() => onApply(tpl)}>
                    <div className={s.templatePreview}>{tpl.preview}</div>
                    <div className={s.templateLabel}>{tpl.label}</div>
                  </button>
                  <TooltipWrap content="Save this template" side="top" align="center" sideOffset={10}>
                    <button
                      className={s.templateCardSave}
                      aria-label="Save this template"
                      onClick={(e) => { e.stopPropagation(); openTemplateSaveInput(tpl); }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                      </svg>
                    </button>
                  </TooltipWrap>
                </div>
              ))}
            </div>
          </>
        )}

        {mode === 'saved' && (
          <>
            <div className={s.templatePickerTitle}>Saved layouts</div>
            {savedTemplates.length === 0 ? (
              <div className={s.savedEmpty}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                </svg>
                <span>No saved layouts yet.<br/>Build a custom layout and save it.</span>
              </div>
            ) : (
              <div className={s.savedGrid}>
                {savedTemplates.map(t => (
                  <div key={t.id} className={s.savedCard}>
                    <button className={s.savedCardApply} onClick={() => applySaved(t)}>
                      <div className={s.savedCardPreview}>
                        {t.rows.map((cols, ri) => (
                          <div key={ri} className={s.savedCardPreviewRow}>
                            {Array.from({ length: cols }).map((_, ci) => (
                              <div key={ci} className={s.savedCardPreviewCell} />
                            ))}
                          </div>
                        ))}
                      </div>
                      <span className={s.savedCardName}>{t.name}</span>
                    </button>
                    <TooltipWrap content="Delete saved layout" side="top" align="center" sideOffset={10}>
                      <button className={s.savedCardDel} onClick={() => deleteSaved(t.id)} aria-label="Delete saved layout">
                        <svg width="9" height="9" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                      </button>
                    </TooltipWrap>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {mode === 'custom' && (
          <div className={s.customBuilder}>
            <div className={s.templatePickerTitle}>Build your layout</div>
            <div className={s.customBody}>

              {/* ── Left controls ── */}
              <div className={s.customControls}>
                {builderRows.map((row, ri) => (
                  <div key={ri} className={s.builderRow}>
                    <span className={s.builderRowLabel}>Row {ri + 1}</span>
                    <div className={s.builderColBtns}>
                      {[1, 2, 3, 4].map(n => (
                        <button key={n} className={`${s.builderColBtn} ${row.cols === n ? s.builderColBtnActive : ''}`} onClick={() => setBuilderCols(ri, n)}>{n}</button>
                      ))}
                      <button className={s.builderStepBtn} onClick={() => setBuilderCols(ri, Math.max(1, row.cols - 1))} disabled={row.cols <= 1}>−</button>
                      <span className={s.builderStepVal}>{row.cols}</span>
                      <button className={s.builderStepBtn} onClick={() => setBuilderCols(ri, Math.min(8, row.cols + 1))} disabled={row.cols >= 8}>+</button>
                    </div>
                    {builderRows.length > 1 && (
                      <button className={s.builderRemoveBtn} onClick={() => removeBuilderRow(ri)}>
                        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                      </button>
                    )}
                  </div>
                ))}
                <div className={s.builderActions}>
                  <div className={s.builderRowStepper}>
                    <span className={s.builderRowStepperLabel}>Rows</span>
                    <button className={s.builderStepBtn} onClick={() => builderRows.length > 1 && removeBuilderRow(builderRows.length - 1)} disabled={builderRows.length <= 1}>−</button>
                    <span className={s.builderStepVal}>{builderRows.length}</span>
                    <button className={s.builderStepBtn} onClick={addBuilderRow} disabled={builderRows.length >= 8}>+</button>
                  </div>
                  {/* Save icon button */}
                  {savingName ? (
                    <div className={s.saveNameRow}>
                      <input
                        ref={nameInputRef}
                        className={s.saveNameInput}
                        placeholder="Layout name…"
                        value={nameInput}
                        onChange={e => setNameInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitSave(); else if (e.key === 'Escape') setSavingName(false); }}
                      />
                      <button className={s.saveNameConfirm} onClick={commitSave} disabled={!nameInput.trim()}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      </button>
                      <button className={s.saveNameCancel} onClick={() => { setSavingName(false); setTemplateToSave(null); }}>
                        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                      </button>
                    </div>
                  ) : (
                    <button
                      className={`${s.saveIconBtn} ${savedFlash ? s.saveIconBtnFlash : ''}`}
                      onClick={openSaveInput}
                      title="Save layout"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                      </svg>
                      Save
                    </button>
                  )}
                  <button className={s.builderApplyBtn} onClick={applyCustom}>Create layout</button>
                </div>
              </div>

              {/* ── Right: interactive preview ── */}
              <div className={s.customPreviewBox} onClick={() => setPickerOpen(null)}>
                <div className={s.customPreviewLabel}>Preview — drag to resize · click panel to set content</div>
                {pickerOpen && (() => {
                  const [pri, pci] = pickerOpen.split('-').map(Number);
                  const pContent = builderRows[pri]?.contents[pci] ?? 'empty';
                  return (
                    <div className={s.pickerOverlay} onClick={e => e.stopPropagation()}>
                      <div className={s.pickerOverlayTitle}>Set content for panel {pci + 1} · row {pri + 1}</div>
                      <div className={s.pickerOverlayGrid}>
                        {CONTENT_OPTIONS.map(opt => (
                          <button key={opt.type} className={`${s.pickerOverlayItem} ${pContent === opt.type ? s.pickerOverlayItemActive : ''}`} onClick={() => setColContent(pri, pci, opt.type)}>
                            <span className={s.pickerOverlayIcon}>{opt.icon}</span>{opt.label}
                          </button>
                        ))}
                        <button className={`${s.pickerOverlayItem} ${pContent === 'empty' ? s.pickerOverlayItemActive : ''}`} onClick={() => setColContent(pri, pci, 'empty')}>
                          <span className={s.pickerOverlayIcon}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></span>Empty
                        </button>
                      </div>
                    </div>
                  );
                })()}
                <div ref={previewRef} className={s.livePreview}>
                  {builderRows.map((row, ri) => (
                    <React.Fragment key={ri}>
                      <div data-preview-row={ri} className={s.livePreviewRow} style={{ flex: row.size ?? 1 }}>
                        {row.contents.map((content, ci) => {
                          const key = `${ri}-${ci}`;
                          const isOpen = pickerOpen === key;
                          return (
                            <React.Fragment key={ci}>
                              <div className={`${s.livePreviewCell} ${isOpen ? s.livePreviewCellActive : ''}`} style={{ flex: row.sizes[ci] ?? 1 }} onClick={e => { e.stopPropagation(); setPickerOpen(isOpen ? null : key); }}>
                                <span className={s.livePreviewCellLabel}>{CONTENT_SHORT[content]}</span>
                              </div>
                              {ci < row.cols - 1 && <div className={s.livePreviewColSplit} onMouseDown={e => onPreviewColDrag(ri, ci, e)} />}
                            </React.Fragment>
                          );
                        })}
                      </div>
                      {ri < builderRows.length - 1 && <div data-preview-splitter className={s.livePreviewRowSplit} onMouseDown={e => onPreviewRowDrag(ri, e)} />}
                    </React.Fragment>
                  ))}
                </div>
                <div className={s.customPreviewHint}>
                  {totalPanels} panel{totalPanels !== 1 ? 's' : ''} · {builderRows.length} row{builderRows.length !== 1 ? 's' : ''}
                </div>
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── HomeWorkspace ─────────────────────────────────────────────────────────────
function makeId(uid: string, counter: React.MutableRefObject<number>) {
  counter.current += 1;
  return `${uid}-${counter.current}`;
}

function makePanel(id: string): Panel {
  return { id, minimized: false, content: 'empty', symbol: 'NIFTY', exchange: 'NSE', expiries: [], instrument: null };
}

export default function HomeWorkspace() {
  const uid     = useId();
  const counter = useRef(0);

  // ── Load saved state ──
  const savedRef = useRef(load());

  const [panels, setPanels] = useState<Panel[]>(() => {
    if (savedRef.current?.panels?.length) {
      counter.current = Math.max(0, ...savedRef.current.panels.map(p => parseInt(p.id.split('-').pop() ?? '0', 10)));
      return savedRef.current.panels;
    }
    // Default: single ATM Rolling Straddle panel for NIFTY
    return [{ id: 'default-panel-0', minimized: false, content: 'atm-rolling-straddle', symbol: 'NIFTY', exchange: 'NSE', expiries: [], instrument: null }];
  });

  const [rows, setRows] = useState<GridRow[]>(() => {
    if (savedRef.current?.rows?.length) return savedRef.current.rows;
    // Default: single row with single column for the default panel
    return [{ id: 'default-row-0', size: 1, cols: [{ panelId: 'default-panel-0' }], colSizes: [1] }];
  });

  const [sidebarLayout, setSidebarLayout] = useState<SidebarLayout>(() => {
    const sl = savedRef.current?.sidebarLayout;
    if (sl && Array.isArray(sl.items) && typeof sl.rightSize === 'number') return sl;
    return DEFAULT_SIDEBAR_LAYOUT;
  });

  // ── Boot screen: show cloud icon briefly, then reveal layout or picker ──
  const hasLayout = savedRef.current?.panels?.length && savedRef.current?.rows?.length;
  const [bootPhase, setBootPhase] = useState<'loading' | 'unloading' | 'done'>('loading');
  useEffect(() => {
    // 'loading' → animate in for 600ms, then start unload
    const t1 = setTimeout(() => setBootPhase('unloading'), 600);
    // 'unloading' → animate out for 300ms, then show content
    const t2 = setTimeout(() => setBootPhase('done'), 900);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const rowContainerRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);

  const { instruments, nubraInstruments } = useInstrumentsCtx();
  const nubraSession = useRef(localStorage.getItem('nubra_session_token') ?? '').current;

  // ── Workers ──
  const searchWorkerRef = useRef<Worker | null>(null);
  const chartWorkerRef  = useRef<Worker | null>(null);

  useEffect(() => {
    const w = new Worker(new URL('./mtmSearch.worker.ts', import.meta.url), { type: 'module' });
    searchWorkerRef.current = w;
    return () => { w.terminate(); searchWorkerRef.current = null; };
  }, []);

  useEffect(() => {
    const w = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    chartWorkerRef.current = w;
    return () => { w.terminate(); chartWorkerRef.current = null; };
  }, []);

  useEffect(() => {
    if (!chartWorkerRef.current || instruments.length === 0) return;
    const slim = instruments.map(i => ({
      instrument_key: i.instrument_key, trading_symbol: i.trading_symbol,
      underlying_symbol: i.underlying_symbol, name: i.name, exchange: i.exchange,
      segment: i.segment, instrument_type: i.instrument_type, expiry: i.expiry,
      strike_price: i.strike_price, lot_size: i.lot_size, asset_type: i.asset_type, weekly: i.weekly,
    }));
    chartWorkerRef.current.postMessage({ type: 'BUILD', instruments: slim });
  }, [instruments]);

  useEffect(() => {
    const worker = searchWorkerRef.current;
    if (!worker || (nubraInstruments.length === 0 && instruments.length === 0)) return;
    const seen = new Set<string>();
    const nubraItems: any[] = [];
    for (const item of nubraInstruments as any[]) {
      const sym = item.asset || item.nubra_name || item.stock_name || '';
      const key = `${item.exchange}:${sym}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nubraItems.push({ instrument_key: key, trading_symbol: sym, underlying_symbol: sym, name: sym, exchange: item.exchange, stock_name: item.stock_name, nubra_name: item.nubra_name, asset: item.asset, derivative_type: item.derivative_type, asset_type: item.asset_type, option_type: item.option_type, expiry: null, strike_price: null, nubraAssetType: item.asset_type ?? '' });
    }
    const mcxSeen = new Set<string>();
    const mcxItems: any[] = [];
    for (const ins of instruments) {
      if (ins.exchange !== 'MCX' && ins.exchange !== 'MCX_FO') continue;
      const sym = ins.underlying_symbol || ins.trading_symbol || '';
      if (mcxSeen.has(sym)) continue;
      mcxSeen.add(sym);
      mcxItems.push({ instrument_key: ins.instrument_key, trading_symbol: sym, underlying_symbol: sym, name: ins.name ?? sym, exchange: ins.exchange, stock_name: sym, nubra_name: '', asset: sym, derivative_type: 'FUT', asset_type: 'MCX', option_type: 'N/A', expiry: null, strike_price: null, nubraAssetType: 'MCX' });
    }
    worker.postMessage({ type: 'BUILD', instruments: [...nubraItems, ...mcxItems] });
  }, [nubraInstruments, instruments]);

  // ── Persist ──
  useEffect(() => { save(panels, rows, sidebarLayout); }, [panels, rows, sidebarLayout]);

  // ── Panel ops ──────────────────────────────────────────────────────────────
  const removePanel = useCallback((id: string) => {
    setPanels(p => p.filter(p => p.id !== id));
    setSidebarLayout(prev => ({ ...prev, items: prev.items.filter((s: SidebarItem) => s.panelId !== id) }));
    setRows(prev => {
      const next = prev.map(row => {
        const colIdx = row.cols.findIndex(c => c.panelId === id);
        if (colIdx === -1) return row;
        const newCols = row.cols.filter((_, i) => i !== colIdx);
        const newSizes = row.colSizes.filter((_, i) => i !== colIdx);
        return { ...row, cols: newCols, colSizes: newSizes };
      }).filter(row => row.cols.length > 0);
      return next;
    });
  }, []);

  const toggleMin = useCallback((id: string) => {
    setPanels(prev => prev.map(p => p.id !== id ? p : { ...p, minimized: !p.minimized }));
  }, []);

  const setContent = useCallback((id: string, content: PanelContent) => {
    setPanels(prev => prev.map(p => {
      if (p.id !== id) return p;
      if (content === 'candle-chart' && !p.instrument) {
        const nifty = instruments.find(i =>
          (i.instrument_type === 'INDEX' || i.segment?.includes('INDEX')) &&
          (i.trading_symbol === 'NIFTY 50' || i.trading_symbol === 'Nifty 50' || i.underlying_symbol === 'NIFTY' || i.name?.includes('Nifty 50'))
        ) ?? instruments.find(i => i.segment?.includes('INDEX')) ?? null;
        return { ...p, content, instrument: nifty };
      }
      if ((content === 'iv-chart' || content === 'open-interest' || content === 'vol-skew' || content === 'gamma-exposure' || content === 'delta-vol-pcr') && !p.symbol) {
        return { ...p, content, symbol: 'NIFTY' };
      }
      return { ...p, content };
    }));
  }, [instruments]);

  const setSymbol = useCallback((id: string, symbol: string, exchange: string, expiries: string[]) => {
    setPanels(prev => prev.map(p => p.id === id ? { ...p, symbol, exchange, expiries } : p));
  }, []);

  const setInstrument = useCallback((id: string, ins: Instrument) => {
    setPanels(prev => prev.map(p => p.id === id ? { ...p, instrument: ins } : p));
  }, []);

  // ── applyTemplate ──────────────────────────────────────────────────────────
  const applyTemplate = useCallback((tpl: LayoutTemplate) => {
    const newPanels: Panel[] = [];
    const newRows: GridRow[] = [];

    // Special asymmetric templates
    if (tpl.id === '1l2r') {
      // Left col (tall) + right col with 2 stacked
      const leftId = makeId(uid, counter);
      const tr1Id  = makeId(uid, counter);
      const tr2Id  = makeId(uid, counter);
      const r1Id   = makeId(uid, counter);
      const r2Id   = makeId(uid, counter);
      newPanels.push(makePanel(leftId), makePanel(tr1Id), makePanel(tr2Id));
      newRows.push(
        { id: r1Id, size: 1, cols: [{ panelId: leftId }, { panelId: tr1Id }], colSizes: [1.8, 1] },
        { id: r2Id, size: 1, cols: [{ panelId: leftId }, { panelId: tr2Id }], colSizes: [1.8, 1] },
      );
      // Actually this needs a different approach — left panel spanning rows isn't possible in row-based grid.
      // Fall back to 3-panel: row1=[left,top-right], row2=[left,bot-right] is same panel which is wrong.
      // Use: row1=[main(2cols wide), right1], row2=[main-cont, right2] — not possible.
      // Instead do: row1=[big, right1+right2 stacked]. Represent as row1 has 2 cols, right col shows 2 stacked via a sub-grid.
      // For simplicity: 2 rows, left col same panel can't span. Use [big, r1] and [big, r2] — same leftId in two rows is invalid.
      // Best achievable: row1=[big,r1], row2=[_, r2] with big being only in row1. Skip the true "spanning" approach.
      // Implementation: just do row1 has [main, r1] and row2 has [extra, r2] — 4 panels.
      newPanels.length = 0; newRows.length = 0;
      const ids = Array.from({ length: 4 }, () => makeId(uid, counter));
      ids.forEach(id => newPanels.push(makePanel(id)));
      const row1Id = makeId(uid, counter);
      const row2Id = makeId(uid, counter);
      newRows.push(
        { id: row1Id, size: 1, cols: [{ panelId: ids[0] }, { panelId: ids[1] }], colSizes: [1.8, 1] },
        { id: row2Id, size: 1, cols: [{ panelId: ids[2] }, { panelId: ids[3] }], colSizes: [1.8, 1] },
      );
    } else if (tpl.id === '1l3r') {
      // Wide left + 3 stacked right — use 3 rows each with [left-slice, right]
      // Since true column spanning isn't available, use 3 rows with 2 cols, left cols wider
      const ids = Array.from({ length: 6 }, () => makeId(uid, counter));
      ids.forEach(id => newPanels.push(makePanel(id)));
      for (let r = 0; r < 3; r++) {
        newRows.push({
          id: makeId(uid, counter),
          size: 1,
          cols: [{ panelId: ids[r * 2] }, { panelId: ids[r * 2 + 1] }],
          colSizes: [1.8, 1],
        });
      }
    } else {
      const customSizes:    number[][]         | undefined = (tpl as any)._colSizes;
      const customRowSizes: number[]           | undefined = (tpl as any)._rowSizes;
      const customContents: PanelContent[][]   | undefined = (tpl as any)._colContents;
      for (let ri = 0; ri < tpl.rows.length; ri++) {
        const colCount = tpl.rows[ri];
        const rowPanelIds = Array.from({ length: colCount }, (_, ci) => {
          const id = makeId(uid, counter);
          const content: PanelContent = customContents?.[ri]?.[ci] ?? 'empty';
          newPanels.push({ ...makePanel(id), content });
          return id;
        });
        const colSizes = customSizes?.[ri] ?? rowPanelIds.map(() => 1);
        const rowSize  = customRowSizes?.[ri] ?? 1;
        newRows.push({
          id: makeId(uid, counter),
          size: rowSize,
          cols: rowPanelIds.map(panelId => ({ panelId })),
          colSizes,
        });
      }
    }

    setPanels(newPanels);
    setRows(newRows);
  }, [uid]);

  // ── addPanel: to the right of a given panel ────────────────────────────────
  const addSide = useCallback((panelId: string) => {
    const id = makeId(uid, counter);
    const newPanel = makePanel(id);
    setPanels(prev => [...prev, newPanel]);
    setRows(prev => prev.map(row => {
      const colIdx = row.cols.findIndex(c => c.panelId === panelId);
      if (colIdx === -1) return row;
      // Insert new col immediately after the clicked panel's column
      const newCols = [...row.cols.slice(0, colIdx + 1), { panelId: id }, ...row.cols.slice(colIdx + 1)];
      const newSizes = [...row.colSizes.slice(0, colIdx + 1), row.colSizes[colIdx] ?? 1, ...row.colSizes.slice(colIdx + 1)];
      return { ...row, cols: newCols, colSizes: newSizes };
    }));
  }, [uid]);

  // ── addPanel: below the row containing a given panel ──────────────────────
  const addBelow = useCallback((panelId: string) => {
    const id = makeId(uid, counter);
    const rowId = makeId(uid, counter);
    const newPanel = makePanel(id);
    setPanels(prev => [...prev, newPanel]);
    setRows(prev => {
      const rowIdx = prev.findIndex(r => r.cols.some(c => c.panelId === panelId));
      if (rowIdx === -1) return [...prev, { id: rowId, size: 1, cols: [{ panelId: id }], colSizes: [1] }];
      const next = [...prev];
      next.splice(rowIdx + 1, 0, { id: rowId, size: prev[rowIdx].size, cols: [{ panelId: id }], colSizes: [1] });
      return next;
    });
  }, [uid]);

  // ── Col splitter drag ──────────────────────────────────────────────────────
  const onColDrag = useCallback((rowId: string, colIdx: number, dx: number) => {
    const container = rowContainerRef.current;
    if (!container) return;
    setRows(prev => prev.map(row => {
      if (row.id !== rowId) return row;
      const sizes = [...row.colSizes];
      if (colIdx < 0 || colIdx >= sizes.length - 1) return row;
      // Get total container width from DOM
      const rowEl = container.querySelector(`[data-row-id="${rowId}"]`) as HTMLElement | null;
      const totalW = rowEl?.offsetWidth ?? container.offsetWidth;
      const totalSize = sizes.reduce((a, b) => a + b, 0);
      const pxPerSize = totalW / totalSize;
      const delta = dx / pxPerSize;
      const minColSize = 260 / (pxPerSize || 1);
      const newA = Math.max(minColSize, sizes[colIdx] + delta);
      const newB = Math.max(minColSize, sizes[colIdx + 1] - delta);
      sizes[colIdx] = newA;
      sizes[colIdx + 1] = newB;
      return { ...row, colSizes: sizes };
    }));
  }, []);

  // ── Row splitter drag ──────────────────────────────────────────────────────
  const onRowDrag = useCallback((rowIdx: number, dy: number) => {
    const container = rowContainerRef.current;
    if (!container) return;
    setRows(prev => {
      if (rowIdx < 0 || rowIdx >= prev.length - 1) return prev;
      const sizes = prev.map(r => r.size);
      const totalH = container.offsetHeight;
      const totalSize = sizes.reduce((a, b) => a + b, 0);
      const pxPerSize = totalH / totalSize;
      const delta = dy / pxPerSize;
      // Min row height: 200px expressed in size units
      const minSize = 200 / (pxPerSize || 1);
      const newA = Math.max(minSize, sizes[rowIdx] + delta);
      const newB = Math.max(minSize, sizes[rowIdx + 1] - delta);
      return prev.map((r, i) => i === rowIdx ? { ...r, size: newA } : i === rowIdx + 1 ? { ...r, size: newB } : r);
    });
  }, []);

  // ── Pin panel as left sidebar ──────────────────────────────────────────────
  const pinAsSidebar = useCallback((panelId: string) => {
    setRows(prev => prev.map(row => {
      const colIdx = row.cols.findIndex(c => c.panelId === panelId);
      if (colIdx === -1) return row;
      return {
        ...row,
        cols: row.cols.filter((_, i) => i !== colIdx),
        colSizes: row.colSizes.filter((_, i) => i !== colIdx),
      };
    }).filter(r => r.cols.length > 0));
    setSidebarLayout(prev => ({
      items: [...prev.items, { panelId, size: 1 }],
      rightSize: prev.rightSize,
    }));
  }, []);

  const unpinSidebar = useCallback((panelId: string) => {
    setSidebarLayout(prev => ({
      items: prev.items.filter((s: SidebarItem) => s.panelId !== panelId),
      rightSize: prev.rightSize,
    }));
    setRows(prev => {
      if (prev.length === 0) return [{ id: panelId + '-row', size: 1, cols: [{ panelId }], colSizes: [1] }];
      const first = prev[0];
      return [
        { ...first, cols: [{ panelId }, ...first.cols], colSizes: [1, ...first.colSizes] },
        ...prev.slice(1),
      ];
    });
  }, []);

  // ── Sidebar width drag — idx is which sidebar is being dragged right edge ──
  // Dragging grows sidebar[idx] and shrinks sidebar[idx+1] if exists, else shrinks rightSize.
  const onSidebarDrag = useCallback((idx: number, dx: number) => {
    const container = outerRef.current;
    if (!container) return;
    setSidebarLayout(prev => {
      const items = prev.items as SidebarItem[];
      const totalW = container.offsetWidth;
      const totalSize = items.reduce((a: number, s: SidebarItem) => a + s.size, 0) + prev.rightSize;
      const pxPerSize = totalW / totalSize;
      const delta = dx / pxPerSize;
      const isLast = idx === items.length - 1;
      const newItems = items.map((s: SidebarItem, i: number) => {
        if (i === idx)     return { ...s, size: Math.max(0.1, s.size + delta) };
        if (i === idx + 1) return { ...s, size: Math.max(0.1, s.size - delta) };
        return s;
      });
      const newRightSize = isLast ? Math.max(0.5, prev.rightSize - delta) : prev.rightSize;
      return { items: newItems, rightSize: newRightSize };
    });
  }, []);

  const sidebarItems: SidebarItem[] = Array.isArray(sidebarLayout.items) ? sidebarLayout.items : [];
  const rightSize = typeof sidebarLayout.rightSize === 'number' ? sidebarLayout.rightSize : 1;

  const minCanvasWidth = useMemo(() => {
    if (rows.length === 0) return MIN_COL_PX;
    return Math.max(...rows.map(row => {
      const colCount = row.cols.length;
      const sizes = (row.colSizes?.length === colCount)
        ? row.colSizes
        : Array.from({ length: colCount }, () => 1);
      const panelWidth = sizes.reduce((sum, sz) => {
        const safe = Number.isFinite(sz) ? Math.max(0.1, sz) : 1;
        return sum + safe * MIN_COL_PX;
      }, 0);
      return panelWidth + Math.max(0, colCount - 1) * SPLITTER_PX + 2;
    }));
  }, [rows]);

  const minCanvasHeight = useMemo(() => {
    if (rows.length === 0) return MIN_ROW_PX;
    const rowsHeight = rows.reduce((sum, row) => {
      const safe = Number.isFinite(row.size) ? Math.max(0.08, row.size) : 1;
      return sum + safe * MIN_ROW_PX;
    }, 0);
    return rowsHeight + Math.max(0, rows.length - 1) * SPLITTER_PX + 2;
  }, [rows]);

  const [showLayoutPicker, setShowLayoutPicker] = useState(false);

  const handleApplyTemplate = useCallback((tpl: LayoutTemplate) => {
    applyTemplate(tpl);
    setShowLayoutPicker(false);
  }, [applyTemplate]);

  // ── Boot screen ──
  if (bootPhase !== 'done') {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0c0b0a', gap: 16,
        opacity: bootPhase === 'unloading' ? 0 : 1, transition: 'opacity 280ms ease', pointerEvents: 'none' }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 24 24" fill="none"
          stroke="rgba(79,142,247,0.85)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ animation: 'hwCloudPulse 1s ease-in-out infinite' }}>
          <path d="M12 13v8l-4-4"/>
          <path d="m12 21 4-4"/>
          <path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {hasLayout ? 'Restoring layout…' : 'Loading workspace…'}
        </span>
        <style>{`
          @keyframes hwCloudPulse {
            0%,100% { opacity: 0.5; transform: translateY(0px); }
            50%      { opacity: 1;   transform: translateY(-4px); }
          }
        `}</style>
      </div>
    );
  }

  // ── Empty state — template picker ──
  if (panels.length === 0 || rows.length === 0) {
    return <TemplatePicker onApply={applyTemplate} />;
  }

  const rowArea = (
    <div ref={canvasScrollRef} className={s.canvasScroll} style={{ flex: rightSize }}>
      <div
        ref={rowContainerRef}
        className={s.gridRoot}
        style={{ minWidth: `${minCanvasWidth}px`, minHeight: `${minCanvasHeight}px` }}
      >
        {rows.map((row, rowIdx) => (
          <React.Fragment key={row.id}>
            <div className={s.gridRow} data-row-id={row.id} style={{ flex: `${row.size} 0 200px` }}>
              {row.cols.map((col, colIdx) => {
                const panel = panels.find(p => p.id === col.panelId);
                if (!panel) return null;
                return (
                  <React.Fragment key={col.panelId}>
                    <div className={s.gridCell} style={{ flex: `${row.colSizes[colIdx] ?? 1} 0 260px` }}>
                      <PanelCard
                        panel={panel}
                        onClose={removePanel}
                        onToggleMin={toggleMin}
                        onSetContent={setContent}
                        onSetSymbol={setSymbol}
                        onSetInstrument={setInstrument}
                        onAddSide={addSide}
                        onAddBelow={addBelow}
                        onPinSidebar={pinAsSidebar}
                        nubraSession={nubraSession}
                        workerRef={searchWorkerRef}
                        chartWorkerRef={chartWorkerRef}
                      />
                    </div>
                    {colIdx < row.cols.length - 1 && (
                      <ColSplitter onDrag={dx => onColDrag(row.id, colIdx, dx)} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            {rowIdx < rows.length - 1 && (
              <RowSplitter onDrag={dy => onRowDrag(rowIdx, dy)} />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={outerRef} className={s.root}>
      {sidebarItems.map((sb: SidebarItem, idx: number) => {
        const sbPanel = panels.find(p => p.id === sb.panelId);
        if (!sbPanel) return null;
        return (
          <React.Fragment key={sb.panelId}>
            <div className={s.sidebarCell} style={{ flex: `${sb.size} 0 120px` }}>
              <PanelCard
                panel={sbPanel}
                onClose={removePanel}
                onToggleMin={toggleMin}
                onSetContent={setContent}
                onSetSymbol={setSymbol}
                onSetInstrument={setInstrument}
                onAddSide={addSide}
                onAddBelow={addBelow}
                onUnpinSidebar={() => unpinSidebar(sb.panelId)}
                nubraSession={nubraSession}
                workerRef={searchWorkerRef}
                chartWorkerRef={chartWorkerRef}
              />
            </div>
            <ColSplitter onDrag={dx => onSidebarDrag(idx, dx)} />
          </React.Fragment>
        );
      })}
      {rowArea}

      {/* ── Layout switcher button (TradingView-style) ── */}
      <TooltipWrap content="Switch layout" side="left" align="center" sideOffset={12}>
        <button
          className={s.layoutSwitchBtn}
          aria-label="Switch layout"
          onClick={() => setShowLayoutPicker(v => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
        </button>
      </TooltipWrap>

      {/* ── Layout picker overlay ── */}
      {showLayoutPicker && (
        <>
          <div className={s.layoutPickerBackdrop} onClick={() => setShowLayoutPicker(false)} />
          <div className={s.layoutPickerOverlay}>
            <TemplatePicker onApply={handleApplyTemplate} />
          </div>
        </>
      )}
    </div>
  );
}
