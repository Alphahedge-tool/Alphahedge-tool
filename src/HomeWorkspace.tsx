import React, { useState, useCallback, useId, useRef, useEffect, startTransition } from 'react';
import GridLayout, { horizontalCompactor } from 'react-grid-layout';
import type { LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { useInstrumentsCtx } from './AppContext';
import type { Instrument } from './useInstruments';
import s from './HomeWorkspace.module.css';

// Lazy imports so bundle doesn't bloat unless used
const OptionChain    = React.lazy(() => import('./OptionChain'));
const CandleChart    = React.lazy(() => import('./CandleChart'));
const IvChart        = React.lazy(() => import('./IvChart'));
const OpenInterest   = React.lazy(() => import('./OpenInterest'));

type PanelContent = 'empty' | 'option-chain' | 'candle-chart' | 'iv-chart' | 'open-interest';

interface Panel {
  id: string;
  title: string;
  minimized: boolean;
  content: PanelContent;
  symbol: string;
  exchange: string;
  expiries: string[];
  instrument: Instrument | null; // for CandleChart
}

function IconBoxes({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>
    </svg>
  );
}

const MAX_PANELS = 20;
const ROW_H      = 30;
const COLS       = 12;

const CONTENT_OPTIONS: { type: PanelContent; label: string; icon: React.ReactNode }[] = [
  {
    type: 'option-chain',
    label: 'Option Chain',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg>
    ),
  },
  {
    type: 'candle-chart',
    label: 'Candle Chart',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
      </svg>
    ),
  },
  {
    type: 'iv-chart',
    label: 'IV Chart',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12 C6 6 10 18 14 10 18 4 21 8"/>
        <path d="M3 20h18" strokeOpacity="0.4"/>
      </svg>
    ),
  },
  {
    type: 'open-interest',
    label: 'Open Interest',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="4" height="18"/><rect x="10" y="8" width="4" height="13"/><rect x="18" y="5" width="4" height="16"/>
      </svg>
    ),
  },
];

// ── Highlight matching query text ─────────────────────────────────────────────
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color: '#FF9800', fontWeight: 700 }}>{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

// ── Symbol search bar ─────────────────────────────────────────────────────────
function SymbolSearch({ symbol, nubraInstruments, workerRef, onChange }: {
  symbol: string;
  nubraInstruments: any[];
  workerRef: React.RefObject<Worker | null>;
  onChange: (symbol: string, exchange: string, expiries: string[]) => void;
}) {
  const [query, setQuery]   = useState(symbol);
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen]     = useState(false);
  const [cursor, setCursor] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef  = useRef<HTMLDivElement>(null);

  // Listen for worker results
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const handler = (e: MessageEvent) => {
      if (e.data.type === 'RESULTS') {
        startTransition(() => { setResults(e.data.results ?? []); setCursor(0); });
      }
    };
    worker.addEventListener('message', handler);
    return () => worker.removeEventListener('message', handler);
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
      if (item.expiry) {
        const expStr = String(item.expiry);
        if (expStr >= today) set.add(expStr);
      }
    }
    return [...set].sort();
  }, [nubraInstruments]);

  const select = useCallback((ins: any) => {
    const sym  = ins.trading_symbol ?? ins.name ?? '';
    const exch = (ins.exchange ?? 'NSE').replace('_INDEX', '').replace('_FO', '');
    const expiries = resolveExpiries(sym, exch);
    setQuery(sym);
    setOpen(false);
    setResults([]);
    onChange(sym, exch, expiries);
  }, [resolveExpiries, onChange]);

  const handleInput = (v: string) => {
    setQuery(v);
    setCursor(0);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'SEARCH', query: v });
        setOpen(true);
      }
    }, 120);
  };

  const atColor: Record<string, string> = { INDEX_FO: '#818cf8', STOCK_FO: '#60a5fa', STOCKS: '#34d399', ETF: '#f59e0b', INDEX: '#818cf8', MCX: '#f97316' };
  const atBg:    Record<string, string> = { INDEX_FO: 'rgba(129,140,248,0.12)', STOCK_FO: 'rgba(96,165,250,0.10)', STOCKS: 'rgba(52,211,153,0.10)', ETF: 'rgba(245,158,11,0.10)', INDEX: 'rgba(129,140,248,0.12)', MCX: 'rgba(249,115,22,0.12)' };

  return (
    <div className={s.symbolSearch} onMouseDown={e => e.stopPropagation()}>
      <div className={s.searchBox}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>
        </svg>
        <input
          className={s.searchInput}
          value={query}
          placeholder="Search instruments…"
          onChange={e => handleInput(e.target.value)}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); listRef.current?.children[cursor + 1]?.scrollIntoView({ block: 'nearest' }); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); listRef.current?.children[cursor - 1]?.scrollIntoView({ block: 'nearest' }); }
            else if (e.key === 'Enter' && results.length > 0) select(results[cursor]);
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {query && (
          <button className={s.searchClearBtn} onMouseDown={() => { setQuery(''); setOpen(false); }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        )}
      </div>

      {open && (
        <div className={s.symbolDropdown}>
          <div ref={listRef} className={s.dropdownList}>
            {results.length === 0 ? (
              <div className={s.dropdownEmpty}>No results for "{query}"</div>
            ) : results.map((ins, i) => {
              const nubraAt = (ins as any).nubraAssetType as string ?? '';
              return (
                <div
                  key={ins.instrument_key ?? i}
                  className={`${s.dropdownItem} ${i === cursor ? s.dropdownItemActive : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={() => select(ins)}
                >
                  <div className={s.dropdownItemIcon}>
                    {ins.exchange === 'NSE'
                      ? <img src="https://s3-symbol-logo.tradingview.com/source/NSE.svg" alt="NSE" style={{ width: 18, height: 18, objectFit: 'contain', opacity: 0.8 }} />
                      : ins.exchange === 'BSE'
                        ? <img src="https://s3-symbol-logo.tradingview.com/source/BSE.svg" alt="BSE" style={{ width: 18, height: 18, objectFit: 'contain', opacity: 0.8 }} />
                        : <span style={{ fontSize: 9, fontWeight: 700, color: '#9598A1' }}>{ins.exchange}</span>
                    }
                  </div>
                  <div className={s.dropdownItemBody}>
                    <div className={s.dropdownItemName}><Highlight text={ins.trading_symbol ?? ''} query={query} /></div>
                    <div className={s.dropdownItemExch}>{ins.exchange}</div>
                  </div>
                  {nubraAt && (
                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: atBg[nubraAt] ?? 'rgba(255,255,255,0.05)', color: atColor[nubraAt] ?? '#565A6B', fontWeight: 700, letterSpacing: '0.03em', flexShrink: 0 }}>
                      {nubraAt}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className={s.dropdownFooter}>
            <span><kbd>↵</kbd> select</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Candle symbol search — uses search.worker.ts (same as main chart) ─────────
function CandleSymbolSearch({ workerRef, selected, onChange, searchRef }: {
  workerRef: React.RefObject<Worker | null>;
  selected: Instrument | null;
  onChange: (ins: Instrument) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery]   = useState(selected?.trading_symbol ?? '');
  const [results, setResults] = useState<Instrument[]>([]);
  const [open, setOpen]     = useState(false);
  const [cursor, setCursor] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef  = useRef<HTMLDivElement>(null);

  // Listen for worker RESULTS
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const handler = (e: MessageEvent) => {
      if (e.data.type === 'RESULTS') {
        startTransition(() => { setResults(e.data.results ?? []); setCursor(0); });
        setOpen((e.data.results ?? []).length > 0);
      }
    };
    worker.addEventListener('message', handler);
    return () => worker.removeEventListener('message', handler);
  }, [workerRef]);

  const select = useCallback((ins: Instrument) => {
    setQuery(ins.trading_symbol ?? ins.name ?? '');
    setOpen(false);
    setResults([]);
    onChange(ins);
  }, [onChange]);

  const handleInput = (v: string) => {
    setQuery(v);
    setCursor(0);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      workerRef.current?.postMessage({ type: 'SEARCH', query: v });
    }, 120);
  };

  return (
    <div className={s.symbolSearch} onMouseDown={e => e.stopPropagation()}>
      <div className={s.searchBox}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>
        </svg>
        <input
          ref={searchRef}
          className={s.searchInput}
          value={query}
          placeholder="Search symbol… (NIFTY, SENSEX, RELIANCE…)"
          onChange={e => handleInput(e.target.value)}
          onFocus={() => { if (query.trim()) workerRef.current?.postMessage({ type: 'SEARCH', query }); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); listRef.current?.children[cursor + 1]?.scrollIntoView({ block: 'nearest' }); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
            else if (e.key === 'Enter' && results.length > 0) select(results[cursor]);
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {query && (
          <button className={s.searchClearBtn} onMouseDown={() => { setQuery(''); setOpen(false); }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        )}
      </div>
      {open && (
        <div className={s.symbolDropdown}>
          <div ref={listRef} className={s.dropdownList}>
            {results.length === 0
              ? <div className={s.dropdownEmpty}>No results for "{query}"</div>
              : results.map((ins, i) => (
                <div
                  key={ins.instrument_key}
                  className={`${s.dropdownItem} ${i === cursor ? s.dropdownItemActive : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={() => select(ins)}
                >
                  <div className={s.dropdownItemIcon}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#9598A1' }}>{ins.exchange}</span>
                  </div>
                  <div className={s.dropdownItemBody}>
                    <div className={s.dropdownItemName}><Highlight text={ins.trading_symbol ?? ''} query={query} /></div>
                    <div className={s.dropdownItemExch}>{ins.instrument_type} · {ins.exchange}</div>
                  </div>
                </div>
              ))
            }
          </div>
          <div className={s.dropdownFooter}>
            <span><kbd>↵</kbd> select</span><span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Stable no-op so OptionChain memo never busts from an inline arrow
const noop = () => {};

// ── Panel content renderer ────────────────────────────────────────────────────
const PanelBody = React.memo(function PanelBody({
  content, symbol, exchange, expiries, instrument,
  nubraSession, workerRef, chartWorkerRef,
  onSymbolChange, onSearchOpen,
}: {
  content: PanelContent;
  symbol: string;
  exchange: string;
  expiries: string[];
  instrument: Instrument | null;
  nubraSession: string;
  workerRef: React.RefObject<Worker | null>;
  chartWorkerRef: React.RefObject<Worker | null>;
  onSymbolChange: (symbol: string, exchange: string, expiries: string[]) => void;
  onSearchOpen?: () => void;
}) {
  // Read directly from context — not re-rendered when sibling panels change
  const { instruments, nubraInstruments } = useInstrumentsCtx();

  if (content === 'empty') {
    return <div className={s.empty}><span>Empty panel</span></div>;
  }

  return (
    <React.Suspense fallback={<div className={s.loading}>Loading…</div>}>
      {content === 'option-chain' && (
        <div className={s.panelInner}>
          <SymbolSearch
            symbol={symbol}
            nubraInstruments={nubraInstruments}
            workerRef={workerRef}
            onChange={onSymbolChange}
          />
          <div className={s.panelContent}>
            <OptionChain
              symbol={symbol}
              expiries={expiries}
              sessionToken={nubraSession}
              exchange={exchange}
              instruments={instruments}
              onClose={noop}
            />
          </div>
        </div>
      )}
      {content === 'candle-chart' && (
        <div style={{ width: '100%', height: '100%' }}>
          {instrument
            ? <CandleChart instrument={instrument} instruments={instruments} visible onSearchOpen={onSearchOpen} />
            : <div className={s.empty}><span>Loading…</span></div>
          }
        </div>
      )}
      {content === 'iv-chart' && (
        <div style={{ width: '100%', height: '100%' }}>
          <IvChart instruments={instruments} nubraInstruments={nubraInstruments} workerRef={chartWorkerRef} />
        </div>
      )}
      {content === 'open-interest' && (
        <div style={{ width: '100%', height: '100%' }}>
          <OpenInterest nubraInstruments={nubraInstruments} />
        </div>
      )}
    </React.Suspense>
  );
});

// ── Panel card ────────────────────────────────────────────────────────────────
const PanelCard = React.memo(function PanelCard({
  panel, onClose, onToggleMin, onSetContent, onSetSymbol, onSetInstrument,
  nubraSession, workerRef, chartWorkerRef,
}: {
  panel: Panel;
  onClose: (id: string) => void;
  onToggleMin: (id: string) => void;
  onSetContent: (id: string, c: PanelContent) => void;
  onSetSymbol: (id: string, symbol: string, exchange: string, expiries: string[]) => void;
  onSetInstrument: (id: string, ins: Instrument) => void;
  nubraSession: string;
  workerRef: React.RefObject<Worker | null>;
  chartWorkerRef: React.RefObject<Worker | null>;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [showCandleSearch, setShowCandleSearch] = useState(false);
  const candleSearchWorkerRef = useRef<Worker | null>(null);
  // Read instruments from context — avoids re-render when sibling panels change
  const { instruments } = useInstrumentsCtx();

  // Boot search.worker for candle search (only when candle-chart panel)
  useEffect(() => {
    if (panel.content !== 'candle-chart') return;
    const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    candleSearchWorkerRef.current = worker;
    if (instruments.length > 0) worker.postMessage({ type: 'BUILD', instruments });
    return () => { worker.terminate(); candleSearchWorkerRef.current = null; };
  }, [panel.content]); // eslint-disable-line react-hooks/exhaustive-deps

  // Feed worker when instruments load
  useEffect(() => {
    if (!candleSearchWorkerRef.current || instruments.length === 0) return;
    candleSearchWorkerRef.current.postMessage({ type: 'BUILD', instruments });
  }, [instruments]);

  const handleSymbolChange = useCallback(
    (sym: string, exch: string, exp: string[]) => onSetSymbol(panel.id, sym, exch, exp),
    [panel.id, onSetSymbol],
  );

  const handleInstrumentSelect = useCallback((ins: Instrument) => {
    onSetInstrument(panel.id, ins);
    setShowCandleSearch(false);
  }, [panel.id, onSetInstrument]);

  const handleSearchOpen = useCallback(() => setShowCandleSearch(true), []);

  return (
    <div className={s.card}>
      {/* Header */}
      <div className={`${s.header} react-grid-drag-handle`}>
        <div className={s.titlePill}>
          <IconBoxes className={s.titleIcon} />
          <span className={s.titleText}>
            {panel.content === 'empty'
              ? 'Panel'
              : CONTENT_OPTIONS.find(o => o.type === panel.content)?.label ?? panel.title}
          </span>
        </div>
        <div className={s.controls}>

          {/* + Add content button */}
          <div className={s.menuWrap}>
            <button
              className={`${s.ctrlBtn} ${s.addContentBtn}`}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setShowMenu(v => !v); }}
              title="Add content"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <line x1="5" y1="1" x2="5" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>

            {showMenu && (
              <div className={s.menu} onMouseDown={e => e.stopPropagation()}>
                {CONTENT_OPTIONS.map(opt => (
                  <button
                    key={opt.type}
                    className={`${s.menuItem} ${panel.content === opt.type ? s.menuItemActive : ''}`}
                    onClick={() => { onSetContent(panel.id, opt.type); setShowMenu(false); }}
                  >
                    <span className={s.menuIcon}>{opt.icon}</span>
                    {opt.label}
                  </button>
                ))}
                {panel.content !== 'empty' && (
                  <button className={s.menuItem} onClick={() => { onSetContent(panel.id, 'empty'); setShowMenu(false); }}>
                    <span className={s.menuIcon}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </span>
                    Clear panel
                  </button>
                )}
              </div>
            )}
          </div>

          <button className={`${s.ctrlBtn} ${s.minBtn}`}
            onMouseDown={e => e.stopPropagation()}
            onClick={() => onToggleMin(panel.id)} title="Minimize">
            <svg width="10" height="2" viewBox="0 0 10 2"><rect width="10" height="2" rx="1" fill="currentColor"/></svg>
          </button>
          <button className={`${s.ctrlBtn} ${s.closeBtn}`}
            onMouseDown={e => e.stopPropagation()}
            onClick={() => onClose(panel.id)} title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      {!panel.minimized && (
        <div className={s.body} onClick={() => setShowMenu(false)}>
          {/* Candle chart inline search overlay */}
          {showCandleSearch && panel.content === 'candle-chart' && (
            <div className={s.candleSearchOverlay} onMouseDown={e => e.stopPropagation()}>
              <CandleSymbolSearch
                workerRef={candleSearchWorkerRef}
                selected={panel.instrument}
                onChange={handleInstrumentSelect}
              />
              <button className={s.candleSearchClose} onClick={() => setShowCandleSearch(false)}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          )}
          <PanelBody
            content={panel.content}
            symbol={panel.symbol}
            exchange={panel.exchange}
            expiries={panel.expiries}
            instrument={panel.instrument}
            nubraSession={nubraSession}
            workerRef={workerRef}
            chartWorkerRef={chartWorkerRef}
            onSymbolChange={handleSymbolChange}
            onSearchOpen={handleSearchOpen}
          />
        </div>
      )}
    </div>
  );
});

// ── HomeWorkspace ─────────────────────────────────────────────────────────────
export default function HomeWorkspace() {
  const [panels,  setPanels]  = useState<Panel[]>([]);
  const [layouts, setLayouts] = useState<LayoutItem[]>([]);
  const [width,   setWidth]   = useState(1200);
  const uid     = useId();
  const counter = useRef(0);

  const { instruments, nubraInstruments } = useInstrumentsCtx();
  // Read once — stable string, doesn't change during session
  const nubraSession = useRef(localStorage.getItem('nubra_session_token') ?? '').current;

  // Nubra/MCX search worker (for OptionChain symbol search)
  const searchWorkerRef = useRef<Worker | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL('./mtmSearch.worker.ts', import.meta.url), { type: 'module' });
    searchWorkerRef.current = worker;
    return () => { worker.terminate(); searchWorkerRef.current = null; };
  }, []);

  // Upstox full instrument search worker (for CandleChart symbol search — handles INDEX correctly)
  const chartWorkerRef = useRef<Worker | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    chartWorkerRef.current = worker;
    return () => { worker.terminate(); chartWorkerRef.current = null; };
  }, []);

  // Feed chartWorkerRef — only fields needed for search (saves structured-clone RAM)
  useEffect(() => {
    if (!chartWorkerRef.current || instruments.length === 0) return;
    const slim = instruments.map(i => ({
      instrument_key:    i.instrument_key,
      trading_symbol:    i.trading_symbol,
      underlying_symbol: i.underlying_symbol,
      name:              i.name,
      exchange:          i.exchange,
      segment:           i.segment,
      instrument_type:   i.instrument_type,
      expiry:            i.expiry,
      strike_price:      i.strike_price,
      lot_size:          i.lot_size,
      asset_type:        i.asset_type,
      weekly:            i.weekly,
    }));
    chartWorkerRef.current.postMessage({ type: 'BUILD', instruments: slim });
  }, [instruments]);

  // Feed the worker — deduplicated to one row per unique asset (not every CE/PE strike)
  useEffect(() => {
    const worker = searchWorkerRef.current;
    if (!worker || (nubraInstruments.length === 0 && instruments.length === 0)) return;

    // Only keep one entry per unique (asset, exchange) pair — massive RAM saving
    const seen = new Set<string>();
    const nubraItems: any[] = [];
    for (const item of nubraInstruments as any[]) {
      const sym = item.asset || item.nubra_name || item.stock_name || '';
      const key = `${item.exchange}:${sym}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nubraItems.push({
        instrument_key: key,
        trading_symbol: sym,
        underlying_symbol: sym,
        name: sym,
        exchange: item.exchange,
        stock_name: item.stock_name,
        nubra_name: item.nubra_name,
        asset: item.asset,
        derivative_type: item.derivative_type,
        asset_type: item.asset_type,
        option_type: item.option_type,
        expiry: null,
        strike_price: null,
        nubraAssetType: item.asset_type ?? '',
      });
    }

    // MCX: one row per unique underlying
    const mcxSeen = new Set<string>();
    const mcxItems: any[] = [];
    for (const ins of instruments) {
      if (ins.exchange !== 'MCX') continue;
      const sym = ins.underlying_symbol || ins.trading_symbol || '';
      if (mcxSeen.has(sym)) continue;
      mcxSeen.add(sym);
      mcxItems.push({
        instrument_key: ins.instrument_key,
        trading_symbol: sym,
        underlying_symbol: sym,
        name: ins.name ?? sym,
        exchange: ins.exchange,
        stock_name: sym,
        nubra_name: '',
        asset: sym,
        derivative_type: 'FUT',
        asset_type: 'MCX',
        option_type: 'N/A',
        expiry: null,
        strike_price: null,
        nubraAssetType: 'MCX',
      });
    }

    worker.postMessage({ type: 'BUILD', instruments: [...nubraItems, ...mcxItems] });
  }, [nubraInstruments, instruments]);

  const widthRafRef = useRef<number | null>(null);
  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setWidth(node.clientWidth);
    const ro = new ResizeObserver(([e]) => {
      // Debounce via rAF — fires once per frame instead of every pixel during sidebar animation
      if (widthRafRef.current) cancelAnimationFrame(widthRafRef.current);
      const w = e.contentRect.width;
      widthRafRef.current = requestAnimationFrame(() => {
        startTransition(() => setWidth(w));
      });
    });
    ro.observe(node);
  }, []);

  // Ref so addPanel always sees the latest layouts without being in its dep array
  const layoutsRef = useRef<LayoutItem[]>(layouts);
  layoutsRef.current = layouts;

  const addPanel = useCallback(() => {
    if (panels.length >= MAX_PANELS) return;
    counter.current += 1;
    const id = `${uid}-${counter.current}`;
    const MIN_W = 3;
    const DEF_H = 8;
    const newPanel: Panel = { id, title: `Panel ${counter.current}`, minimized: false, content: 'empty', symbol: 'NIFTY', exchange: 'NSE', expiries: [], instrument: null };

    // Compute new layout synchronously from the latest snapshot via ref
    const prev = layoutsRef.current;
    const maxRow = prev.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    let placed: LayoutItem | null = null;

    for (let row = 0; row <= maxRow && !placed; row++) {
      const taken = new Set<number>();
      for (const l of prev) {
        const overlapY = l.y < row + DEF_H && l.y + l.h > row;
        if (overlapY) {
          for (let c = l.x; c < l.x + l.w; c++) taken.add(c);
        }
      }
      let runStart = -1, bestStart = -1, bestLen = 0;
      for (let c = 0; c <= COLS; c++) {
        if (c < COLS && !taken.has(c)) {
          if (runStart === -1) runStart = c;
        } else {
          if (runStart !== -1) {
            const len = c - runStart;
            if (len > bestLen) { bestLen = len; bestStart = runStart; }
            runStart = -1;
          }
        }
      }
      if (bestLen >= MIN_W) {
        const w = Math.min(6, bestLen);
        placed = { i: id, x: bestStart, y: row, w, h: DEF_H, minW: MIN_W, minH: 4 };
      }
    }

    let newLayouts: LayoutItem[];
    if (!placed) {
      const ratio = (COLS - MIN_W) / Math.max(1, COLS);
      const compressed = prev.map(l => ({
        ...l,
        w: Math.max(l.minW ?? MIN_W, Math.floor(l.w * ratio)),
      }));
      placed = { i: id, x: 0, y: maxRow, w: Math.min(6, COLS), h: DEF_H, minW: MIN_W, minH: 4 };
      newLayouts = [...compressed, placed];
    } else {
      newLayouts = [...prev, placed];
    }

    // Batch both state updates together — React 18 auto-batches these in the same event
    setPanels(pp => [...pp, newPanel]);
    setLayouts(newLayouts);
  }, [panels.length, uid]);

  const removePanel  = useCallback((id: string) => {
    setPanels(prev  => prev.filter(p => p.id !== id));
    setLayouts(prev => prev.filter(l => l.i !== id));
  }, []);

  const toggleMin = useCallback((id: string) => {
    setPanels(prev => prev.map(p => p.id === id ? { ...p, minimized: !p.minimized } : p));
    setLayouts(prev => prev.map(l => {
      if (l.i !== id) return l;
      const isMin = panels.find(p => p.id === id)?.minimized;
      return isMin
        ? { ...l, h: 8, isResizable: true }
        : { ...l, h: 1, isResizable: false };
    }));
  }, [panels]);

  const setContent = useCallback((id: string, content: PanelContent) => {
    setPanels(prev => prev.map(p => {
      if (p.id !== id) return p;
      // Auto-set default NIFTY instrument when switching to candle-chart with no instrument yet
      if (content === 'candle-chart' && !p.instrument) {
        const nifty = instruments.find(i =>
          (i.instrument_type === 'INDEX' || i.segment?.includes('INDEX')) &&
          (i.trading_symbol === 'NIFTY 50' || i.trading_symbol === 'Nifty 50' || i.underlying_symbol === 'NIFTY' || i.name?.includes('Nifty 50'))
        ) ?? instruments.find(i => i.segment?.includes('INDEX')) ?? null;
        return { ...p, content, instrument: nifty };
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

  const onLayoutChange = useCallback((newLayout: readonly LayoutItem[]) => {
    // Defer layout state update so it never blocks a paint frame
    startTransition(() => setLayouts(newLayout as LayoutItem[]));
  }, []);

  // Snap-to-dock: after drag ends, snap edges to nearby panels (within 1 col)
  const onDragStop = useCallback((layout: readonly LayoutItem[], _old: LayoutItem | null, moved: LayoutItem | null) => {
    if (!moved) return;
    const SNAP = 1; // columns threshold
    const snapped = (layout as LayoutItem[]).map(item => {
      if (item.i !== moved.i) return item;
      let { x, y, w, h } = item;

      for (const other of layout) {
        if (other.i === item.i) continue;
        // Rows must overlap to be considered neighbours
        const rowOverlap = item.y < other.y + other.h && item.y + item.h > other.y;
        if (!rowOverlap) continue;

        const otherRight = other.x + other.w;
        const itemRight  = x + w;

        // Snap left edge to neighbour's right edge
        if (Math.abs(x - otherRight) <= SNAP) {
          x = otherRight;
        }
        // Snap right edge to neighbour's left edge
        if (Math.abs(itemRight - other.x) <= SNAP) {
          w = other.x - x;
        }
        // Snap right edge to neighbour's right edge (fill same width)
        if (Math.abs(itemRight - otherRight) <= SNAP) {
          w = otherRight - x;
        }
        // Snap left edge to neighbour's left edge
        if (Math.abs(x - other.x) <= SNAP) {
          x = other.x;
        }
      }

      // Also snap to grid boundaries (left=0, right=COLS)
      if (x <= SNAP) x = 0;
      if (x + w >= COLS - SNAP) w = COLS - x;

      // Clamp
      w = Math.max(item.minW ?? 3, Math.min(w, COLS - x));
      x = Math.max(0, Math.min(x, COLS - w));

      return { ...item, x, y, w, h };
    });
    setLayouts(snapped);
  }, []);

  if (panels.length === 0) {
    return (
      <div className={s.root}>
        <div className={s.placeholder}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5">
            <rect x="4" y="4" width="18" height="18" rx="3"/><rect x="26" y="4" width="18" height="18" rx="3"/>
            <rect x="4" y="26" width="18" height="18" rx="3"/><rect x="26" y="26" width="18" height="18" rx="3"/>
          </svg>
          <button className={s.addBtn} onClick={addPanel}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            Add Panel
          </button>
          <p className={s.sub}>Up to {MAX_PANELS} draggable &amp; resizable panels</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={measuredRef} className={s.root}>
      <GridLayout
        className={s.gridLayout}
        layout={layouts}
        width={width}
        compactor={horizontalCompactor}
        gridConfig={{ cols: COLS, rowHeight: ROW_H, margin: [8, 8] as [number, number], containerPadding: [8, 8] as [number, number] }}
        dragConfig={{ handle: '.react-grid-drag-handle' }}
        resizeConfig={{ handles: ['se', 'e', 's'] as const }}
        onDragStop={onDragStop}
        onLayoutChange={onLayoutChange}
      >
        {panels.map(panel => (
          <div key={panel.id}>
            <PanelCard
              panel={panel}
              onClose={removePanel}
              onToggleMin={toggleMin}
              onSetContent={setContent}
              onSetSymbol={setSymbol}
              onSetInstrument={setInstrument}
              nubraSession={nubraSession}
              workerRef={searchWorkerRef}
              chartWorkerRef={chartWorkerRef}
            />
          </div>
        ))}
      </GridLayout>

      <button
        className={s.floatBtn}
        onClick={addPanel}
        disabled={panels.length >= MAX_PANELS}
        title={panels.length >= MAX_PANELS ? 'Max 20 panels' : 'Add panel'}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <span>{panels.length}/{MAX_PANELS}</span>
      </button>
    </div>
  );
}
