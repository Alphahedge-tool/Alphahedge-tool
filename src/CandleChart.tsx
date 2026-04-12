'use client';

import { useEffect, useRef, useState, useCallback, useMemo, startTransition, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type Time,
  type LogicalRange,
} from 'lightweight-charts';
import type { Instrument } from './useInstruments';
import { cx } from './lib/utils';
import s from './CandleChart.module.css';
import { wsManager, type InstrumentMarketData } from './lib/WebSocketManager';
import { LayoutPicker } from './workspace/LayoutPicker';
import type { LayoutId } from './workspace/workspaceTypes';
import { savePreMarketTicks, loadPreMarketTicks } from './db';
import { useDrawingEngine } from './DrawingToolbar';

interface Props {
  instrument: Instrument;
  instruments?: Instrument[];
  onSearchOpen?: () => void;
  visible?: boolean;
  onViewChange?: (v: 'candle' | 'straddle' | 'oiprofile') => void;
  activeLayout?: string;
  onLayoutChange?: (id: string) => void;
  /** When true, the built-in toolbar is hidden (workspace single-toolbar mode) */
  hideToolbar?: boolean;
  /** Initial interval value (e.g. 'I1', 'I5'). Only used on mount. */
  defaultInterval?: string;
  /** Called when user changes interval inside the chart */
  onIntervalChange?: (intervalValue: string) => void;
  /** Controlled OI overlay visibility (lifted to workspace toolbar) */
  oiShowProp?: boolean;
  onOiShowChange?: (v: boolean) => void;
  /** Controlled option chain panel visibility (lifted to workspace toolbar) */
  optionChainOpenProp?: boolean;
  onOptionChainOpenChange?: (v: boolean) => void;
  /** Ref to receive a callback to open OI settings from outside (workspace toolbar) */
  openOiSettingsRef?: { current: (() => void) | null };
  /** Anchor button ref from workspace toolbar, used to position OI settings modal */
  oiSettingsAnchorRef?: RefObject<HTMLButtonElement | null>;
  /** Controlled VWAP / TWAP state (lifted to workspace toolbar) */
  vwapShowProp?: boolean;
  onVwapShowChange?: (v: boolean) => void;
  vwapAnchorProp?: 'daily' | 'weekly' | 'monthly' | 'expiry';
  onVwapAnchorChange?: (a: 'daily' | 'weekly' | 'monthly' | 'expiry') => void;
  vwapColorProp?: string;
  onVwapColorChange?: (c: string) => void;
  vwapExpiryDayProp?: 'tuesday' | 'thursday';
  onVwapExpiryDayChange?: (d: 'tuesday' | 'thursday') => void;
  twapShowProp?: boolean;
  onTwapShowChange?: (v: boolean) => void;
  /** Ref to expose this pane's drawing engine to the workspace toolbar */
  drawingRef?: React.MutableRefObject<import('./DrawingToolbar').DrawingEngineHandle | null>;
  /** Called whenever tool/drawings change — lets WorkspaceRoot re-render the toolbar */
  onDrawingsChange?: (state: { activeTool: import('./DrawingToolbar').DrawToolId; drawingCount: number; canUndo: boolean }) => void;
}

// ── OI Profile overlay ────────────────────────────────────────────────────────

interface OIRow {
  strike: number;
  callOI: number;
  putOI: number;
  callVol: number;
  putVol: number;
  callIV: number;
  putIV: number;
  callGamma: number;
  putGamma: number;
  callDelta: number;
  putDelta: number;
  lotSize: number;
  callKey: string;
  putKey: string;
}

type OIMode = 'oi' | 'volume' | 'iv' | 'gex_raw' | 'gex_spot' | 'dex';


interface OITooltip {
  visible: boolean;
  x: number;
  y: number;
  strike: number;
  callOI: number;
  putOI: number;
  callVol: number;
  putVol: number;
  callIV: number;
  putIV: number;
}

const OI_BAR_H = 9;
const OI_BAR_GAP = 1;
const OI_BAR_FILL = 0.22;

function fmtOI(n: number) {
  if (n === 0) return '—';
  if (n >= 1_00_00_000) return (n / 1_00_00_000).toFixed(2) + ' Cr';
  if (n >= 1_00_000) return (n / 1_00_000).toFixed(2) + ' L';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

function drawOIBars(
  canvas: HTMLCanvasElement,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  rows: OIRow[],
  hoveredStrike: number | null,
  mode: OIMode = 'oi',
  callColor = '#2ebd85',
  putColor = '#f23645',
  opacity = 75,
  spot = 0,
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;

  if (rows.length === 0 || cssW === 0 || cssH === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const priceScaleW = chart.priceScale('right').width();
  const anchor = cssW - priceScaleW;
  const maxW = anchor * OI_BAR_FILL;
  const alpha = opacity / 100;
  const alphaHover = Math.min(1, alpha + 0.2);

  const isGex = mode === 'gex_raw' || mode === 'gex_spot';
  const isDex = mode === 'dex';

  let callVals: number[], putVals: number[], maxVal: number;
  let callRgb: string, putRgb: string;

  if (isGex) {
    const multiplier = (mode === 'gex_spot' && spot > 0) ? spot * spot : 1;
    const gexRows = rows.map(r => ({
      callGex: r.callGamma * r.callOI * r.lotSize * multiplier,
      putGex: -r.putGamma * r.putOI * r.lotSize * multiplier,
    }));
    callVals = gexRows.map(g => Math.abs(g.callGex));
    putVals = gexRows.map(g => Math.abs(g.putGex));
    maxVal = Math.max(...callVals, ...putVals, 1);
    callRgb = '129,140,248'; // indigo
    putRgb = '255,152,0';   // orange
  } else if (isDex) {
    // DEX = delta × OI × lotSize; put delta is negative so use abs
    callVals = rows.map(r => Math.abs(r.callDelta) * r.callOI * r.lotSize);
    putVals  = rows.map(r => Math.abs(r.putDelta)  * r.putOI  * r.lotSize);
    maxVal = Math.max(...callVals, ...putVals, 1);
    callRgb = '56,212,200';  // teal
    putRgb = '248,113,113';  // red
  } else {
    callVals = rows.map(r => mode === 'volume' ? r.callVol : mode === 'iv' ? r.callIV : r.callOI);
    putVals = rows.map(r => mode === 'volume' ? r.putVol : mode === 'iv' ? r.putIV : r.putOI);
    maxVal = Math.max(...callVals, ...putVals, 1);
    callRgb = hexToRgb(callColor);
    putRgb = hexToRgb(putColor);
  }

  rows.forEach((row, i) => {
    const yCenter = series.priceToCoordinate(row.strike);
    if (yCenter == null) return;
    const callW = (callVals[i] / maxVal) * maxW;
    const putW = (putVals[i] / maxVal) * maxW;
    const isHovered = hoveredStrike === row.strike;
    if (callW > 0) {
      ctx.fillStyle = `rgba(${callRgb},${isHovered ? alphaHover : alpha})`;
      ctx.fillRect(anchor - callW, yCenter - OI_BAR_H - OI_BAR_GAP / 2, callW, OI_BAR_H);
    }
    if (putW > 0) {
      ctx.fillStyle = `rgba(${putRgb},${isHovered ? alphaHover : alpha})`;
      ctx.fillRect(anchor - putW, yCenter + OI_BAR_GAP / 2, putW, OI_BAR_H);
    }
    if (isHovered) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, yCenter); ctx.lineTo(anchor, yCenter); ctx.stroke();
      ctx.restore();
    }
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ── Option Chain Panel ────────────────────────────────────────────────────────

interface StrikeRow {
  strike: number;
  ceKey: string | null;
  peKey: string | null;
}

function fmtExpiry(ms: number) {
  return new Date(ms).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

// ── Expiry Dropdown ───────────────────────────────────────────────────────────
type OcMetric = 'ltp' | 'delta' | 'theta' | 'iv' | 'vega' | 'gamma' | 'vol' | 'oi' | 'ask' | 'bid';
const OC_METRICS: { id: OcMetric; label: string; desc: string }[] = [
  { id: 'ltp', label: 'LTP', desc: 'Last traded price' },
  { id: 'delta', label: 'Delta', desc: 'Rate of price change' },
  { id: 'theta', label: 'Theta', desc: 'Time decay' },
  { id: 'iv', label: 'IV', desc: 'Implied volatility' },
  { id: 'vega', label: 'Vega', desc: 'IV sensitivity' },
  { id: 'gamma', label: 'Gamma', desc: 'Delta rate of change' },
  { id: 'vol', label: 'Vol', desc: 'Volume' },
  { id: 'oi', label: 'OI', desc: 'Open interest' },
  { id: 'ask', label: 'Ask', desc: 'Best ask price' },
  { id: 'bid', label: 'Bid', desc: 'Best bid price' },
];

function MetricDropdown({ value, onChange, metrics }: {
  value: OcMetric;
  onChange: (m: OcMetric) => void;
  metrics: typeof OC_METRICS;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen(o => !o);
  };

  const active = metrics.find(m => m.id === value);

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className={cx(
          'inline-flex items-center justify-center gap-1.5 h-7 px-3 border font-semibold text-[11px] tracking-[0.05em] transition-colors duration-150 cursor-pointer shadow-xs',
          open
            ? 'bg-[rgba(255,152,0,0.15)] border-[rgba(255,152,0,0.5)] text-[#FF9800]'
            : 'bg-[#1f1f1f] border-[#2a2a2a] text-[#9B9EA8] hover:bg-[#252525] hover:border-[rgba(255,152,0,0.4)] hover:text-[#FF9800]'
        )}
      >
        {/* bar-chart icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="14" width="4" height="8" /><rect x="9" y="8" width="4" height="14" /><rect x="16" y="2" width="4" height="20" />
        </svg>
        <span>{active?.label ?? 'Metric'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
          <path d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {open && createPortal(
          <div
          ref={menuRef}
          className={s.dropdownMenu}
          style={{ top: pos.top, right: pos.right, minWidth: 170 }}
        >
          <div className={s.dropdownMenuHeader}>
            <span className={s.dropdownMenuHeaderLabel}>Select Metric</span>
          </div>
          <ul className={s.dropdownMenuList} style={{ maxHeight: 320 }}>
            {metrics.map(m => {
              const isActive = m.id === value;
              return (
                <li key={m.id}>
                  <button
                    onClick={() => { onChange(m.id); setOpen(false); }}
                    className={cx(s.dropdownMenuItem, isActive ? s.dropdownMenuItemActive : '')}
                  >
                    <span className={s.dropdownMenuItemDesc}>
                      <span>{m.label}</span>
                      <span className={cx(s.dropdownMenuItemSub, isActive ? s.dropdownMenuItemSubActive : '')}>{m.desc}</span>
                    </span>
                    {isActive && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
}

function ExpiryDropdown({ expiries, selected, onChange }: {
  expiries: number[];
  selected: number | null;
  onChange: (e: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // anchor to right edge so it never clips off-screen
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen(o => !o);
  };

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className={cx(
          'inline-flex items-center justify-center gap-1.5 h-7 px-3 border font-semibold text-[11px] tracking-[0.05em] transition-colors duration-150 cursor-pointer shadow-xs',
          open
            ? 'bg-[rgba(255,152,0,0.15)] border-[rgba(255,152,0,0.5)] text-[#FF9800]'
            : 'bg-[#1f1f1f] border-[#2a2a2a] text-[#9B9EA8] hover:bg-[#252525] hover:border-[rgba(255,152,0,0.4)] hover:text-[#FF9800]'
        )}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
        <span>{selected ? fmtExpiry(selected) : 'Expiry'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
          <path d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {open && createPortal(
          <div
          ref={menuRef}
          className={s.dropdownMenu}
          style={{ top: pos.top, right: pos.right, minWidth: 160 }}
        >
          {/* Header */}
          <div className={s.dropdownMenuHeader}>
            <span className={s.dropdownMenuHeaderLabel}>Select Expiry</span>
          </div>
          {/* List */}
          <ul className={s.dropdownMenuList} style={{ maxHeight: 260 }}>
            {expiries.length === 0 ? (
              <li className={s.dropdownMenuEmpty}>No expiries found</li>
            ) : expiries.map(e => {
              const active = e === selected;
              return (
                <li key={e}>
                  <button
                    onClick={() => { onChange(e); setOpen(false); }}
                    className={cx(s.dropdownMenuItem, active ? s.dropdownMenuItemActive : '')}
                  >
                    <span>{fmtExpiry(e)}</span>
                    {active && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
}

function useOptionChain(instrument: Instrument, instruments: Instrument[], open: boolean, selectedExpiry: number | null) {
  const [rows, setRows] = useState<StrikeRow[]>([]);
  // mdRef is the source of truth; mdVer triggers re-render
  const mdRef = useRef<Map<string, InstrumentMarketData>>(new Map());
  const ltpRef = useRef<Map<string, number>>(new Map());
  const [ltpVer, setLtpVer] = useState(0);

  useEffect(() => {
    if (!open || !instruments.length || !selectedExpiry) { setRows([]); ltpRef.current = new Map(); return; }

    const underlying = instrument.underlying_symbol || instrument.trading_symbol;
    if (!underlying) { setRows([]); return; }

    const thisExpiry = instruments.filter(i =>
      (i.instrument_type === 'CE' || i.instrument_type === 'PE') &&
      i.underlying_symbol === underlying &&
      i.expiry === selectedExpiry
    );
    if (!thisExpiry.length) { setRows([]); return; }

    // Build strike rows
    const strikeMap = new Map<number, { ce: Instrument | null; pe: Instrument | null }>();
    for (const o of thisExpiry) {
      const s = o.strike_price ?? 0;
      if (!strikeMap.has(s)) strikeMap.set(s, { ce: null, pe: null });
      if (o.instrument_type === 'CE') strikeMap.get(s)!.ce = o;
      else strikeMap.get(s)!.pe = o;
    }
    const built: StrikeRow[] = [...strikeMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([strike, { ce, pe }]) => ({
        strike,
        ceKey: ce?.instrument_key ?? null,
        peKey: pe?.instrument_key ?? null,
      }));

    // Seed from WS snapshot immediately
    const seedMd = new Map<string, InstrumentMarketData>();
    const seedLtp = new Map<string, number>();
    for (const row of built) {
      if (row.ceKey) { const snap = wsManager.get(row.ceKey); if (snap) { seedMd.set(row.ceKey, snap); if (snap.ltp) seedLtp.set(row.ceKey, snap.ltp); } }
      if (row.peKey) { const snap = wsManager.get(row.peKey); if (snap) { seedMd.set(row.peKey, snap); if (snap.ltp) seedLtp.set(row.peKey, snap.ltp); } }
    }
    mdRef.current = seedMd;
    ltpRef.current = seedLtp;

    // Request all keys from wsManager
    const allKeys = built.flatMap(r => [r.ceKey, r.peKey]).filter(Boolean) as string[];
    wsManager.requestKeys(allKeys);

    setRows(built);

    // Throttled state trigger — max one re-render per 200ms
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleUpdate = () => {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; startTransition(() => { setLtpVer(v => v + 1); }); }, 200);
    };

    const unsubs = allKeys.map(key =>
      wsManager.subscribe(key, (md: InstrumentMarketData) => {
        mdRef.current.set(key, md);
        if (md.ltp) { ltpRef.current.set(key, md.ltp); scheduleUpdate(); }
        else scheduleUpdate();
      })
    );

    return () => {
      unsubs.forEach(u => u());
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, instrument.instrument_key, instrument.underlying_symbol, instrument.trading_symbol, instruments, selectedExpiry]);

  void ltpVer;
  return { rows, mdMap: mdRef.current };
}

function OptionChainPanel({
  instrument,
  instruments,
  open,
}: {
  instrument: Instrument;
  instruments: Instrument[];
  open: boolean;
}) {
  const underlying = instrument.underlying_symbol || instrument.trading_symbol;

  const expiries = useMemo(() => {
    if (!underlying || !instruments.length) return [];
    const today = Date.now();
    return [...new Set(
      instruments
        .filter(i => (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.underlying_symbol === underlying && i.expiry != null && i.expiry >= today - 86400000)
        .map(i => i.expiry as number)
    )].sort((a, b) => a - b);
  }, [underlying, instruments]);

  const [selectedExpiry, setSelectedExpiry] = useState<number | null>(null);
  useEffect(() => {
    if (expiries.length > 0 && (selectedExpiry === null || !expiries.includes(selectedExpiry))) {
      setSelectedExpiry(expiries[0]);
    }
  }, [expiries, selectedExpiry]);

  const { rows, mdMap } = useOptionChain(instrument, instruments, open, selectedExpiry);

  const [metric, setMetric] = useState<OcMetric>('ltp');
  const [settingsOpen, setSettingsOpen] = useState(false);

  function getMetricValue(key: string | null, m: OcMetric): string {
    if (!key) return '—';
    const md = mdMap.get(key);
    if (!md) return '—';
    switch (m) {
      case 'ltp': return md.ltp ? md.ltp.toFixed(2) : '—';
      case 'delta': return md.delta != null ? md.delta.toFixed(3) : '—';
      case 'theta': return md.theta != null ? md.theta.toFixed(3) : '—';
      case 'iv': return md.iv ? md.iv.toFixed(2) + '%' : '—';
      case 'vega': return md.vega != null ? md.vega.toFixed(3) : '—';
      case 'gamma': return md.gamma != null ? md.gamma.toFixed(4) : '—';
      case 'vol': { const bar = md.ohlc?.find(b => b.interval === 'I1'); return bar?.vol ? bar.vol : '—'; }
      case 'oi': return md.oi ? md.oi.toLocaleString('en-IN') : '—';
      case 'ask': return md.bidAskQuote?.[0]?.askP ? md.bidAskQuote[0].askP.toFixed(2) : '—';
      case 'bid': return md.bidAskQuote?.[0]?.bidP ? md.bidAskQuote[0].bidP.toFixed(2) : '—';
    }
  }

  const spotInstrumentKey = useMemo(() => {
    const t = instrument.instrument_type;
    if (t === 'INDEX' || t === 'EQ') return instrument.instrument_key;
    const u = instrument.underlying_symbol;
    if (!u || !instruments.length) return instrument.instrument_key;
    const found = instruments.find(i => (i.instrument_type === 'INDEX' || i.instrument_type === 'EQ') && i.trading_symbol === u);
    return found?.instrument_key ?? instrument.instrument_key;
  }, [instrument.instrument_key, instrument.instrument_type, instrument.underlying_symbol, instruments]);

  const [spot, setSpot] = useState(() => wsManager.get(spotInstrumentKey)?.ltp ?? 0);
  useEffect(() => {
    setSpot(wsManager.get(spotInstrumentKey)?.ltp ?? 0);
    wsManager.requestKeys([spotInstrumentKey]);
    return wsManager.subscribe(spotInstrumentKey, md => { if (md.ltp) setSpot(md.ltp); });
  }, [spotInstrumentKey]);

  const atmStrike = rows.length && spot
    ? rows.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best, rows[0].strike)
    : null;

  // Resizable panel
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(290);
  const dragRef = useRef({ dragging: false, startX: 0, startW: 0 });
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  const shouldScrollToAtm = useRef(true);

  // Scroll to ATM once on open/expiry change
  useEffect(() => { shouldScrollToAtm.current = true; }, [selectedExpiry, open]);
  useEffect(() => {
    if (rows.length === 0 || !shouldScrollToAtm.current || !atmRowRef.current) return;
    shouldScrollToAtm.current = false;
    requestAnimationFrame(() => atmRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [rows]);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { dragging: true, startX: e.clientX, startW: panelWidth };
    const onMove = (me: PointerEvent) => {
      const delta = dragRef.current.startX - me.clientX;
      setPanelWidth(Math.min(600, Math.max(220, dragRef.current.startW + delta)));
    };
    const onUp = () => { dragRef.current.dragging = false; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [panelWidth]);

  const curMetricLabel = OC_METRICS.find(m => m.id === metric)?.label ?? metric.toUpperCase();

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className={s.ocPanel}
      style={{ width: panelWidth }}
    >
      <style>{`
        .ocp-tbody tr.ocp-row:hover td { background: rgba(255,255,255,0.03); }
        .ocp-tbody tr.ocp-row-atm td { background: rgba(224,168,0,0.04); }
        .ocp-tbody tr.ocp-row-atm:hover td { background: rgba(224,168,0,0.08); }
        .ocp-tbody tr.ocp-row-odd td { background: transparent; }
        .ocp-tbody tr.ocp-row-even td { background: rgba(255,255,255,0.015); }
      `}</style>

      {/* Resize handle */}
      <div
        onPointerDown={onResizePointerDown}
        onDoubleClick={() => setPanelWidth(290)}
        className={s.ocResizeHandle}
      />

      {/* Metric picker modal */}
      {settingsOpen && (
        <div onClick={() => setSettingsOpen(false)} className={s.ocModalOverlay}>
          <div onClick={e => e.stopPropagation()} className={s.ocModalCard}>
            <div className={s.ocModalHeader}>
              <span className={s.ocModalTitle}>Choose Metric</span>
              <button onClick={() => setSettingsOpen(false)} className={s.ocModalClose}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className={s.ocModalList}>
              {OC_METRICS.map(m => (
                <button key={m.id} onClick={() => { setMetric(m.id); setSettingsOpen(false); }} className={cx(s.ocModalBtn, metric === m.id ? s.ocModalBtnActive : s.ocModalBtnDefault)}>
                  <div className={cx(s.ocModalCheck, metric === m.id ? s.ocModalCheckOn : s.ocModalCheckOff)}>
                    {metric === m.id && <svg width="8" height="6" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  <span className={s.ocModalBtnLabel}>{m.label}</span>
                  <span className={s.ocModalBtnDesc}>{m.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className={s.ocHeader}>
        <div className={s.ocHeaderLeft}>
          <span className={s.ocSymbol}>{underlying}</span>
          {spot > 0 && (
            <span className={s.ocSpotBadge}>{spot.toFixed(2)}</span>
          )}
        </div>
        <div className={s.ocHeaderRight}>
          {/* Active metric badge */}
          <span className={s.ocMetricBadge}>{curMetricLabel}</span>
          {/* Gear — opens metric picker */}
          <button className={s.ocGearBtn} onClick={() => setSettingsOpen(true)} title="Choose metric">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 13.648 13.648" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M5.09373 0.995125C5.16241 0.427836 5.64541 0 6.21747 0H7.43151C8.0039 0 8.48663 0.428191 8.55525 0.996829C8.5553 0.997248 8.55536 0.997666 8.5554 0.9981L8.65947 1.81525C8.80015 1.86677 8.93789 1.92381 9.07227 1.98601L9.72415 1.47911C10.1776 1.12819 10.8237 1.16381 11.2251 1.57622L12.0753 2.42643C12.4854 2.82551 12.5214 3.47159 12.1697 3.92431L11.6628 4.57692C11.725 4.71124 11.782 4.84882 11.8335 4.98924L12.6526 5.09337C12.653 5.09342 12.6534 5.09348 12.6539 5.09352C13.2211 5.16221 13.6492 5.64522 13.6484 6.21766V7.4312C13.6484 8.00358 13.2203 8.48622 12.6517 8.5549C12.6513 8.55496 12.6508 8.55502 12.6503 8.55506L11.8338 8.65909C11.7824 8.7996 11.7254 8.93729 11.663 9.07168L12.1696 9.72354C12.5218 10.1776 12.4847 10.823 12.0728 11.2245L11.2224 12.0749C10.8233 12.485 10.1772 12.5209 9.72452 12.1692L9.07187 11.6624C8.93756 11.7246 8.79995 11.7815 8.65952 11.833L8.55539 12.6521C8.55533 12.6525 8.55528 12.653 8.55522 12.6534C8.48652 13.2206 8.00353 13.6484 7.43151 13.6484H6.21747C5.64485 13.6484 5.16232 13.22 5.09373 12.6506C5.09367 12.6501 5.09361 12.6496 5.09355 12.6491L4.98954 11.8328C4.84901 11.7814 4.71133 11.7244 4.57692 11.662L3.92477 12.1688C3.47111 12.5199 2.82587 12.4838 2.42408 12.0724L1.57358 11.2219C1.16354 10.8229 1.12761 10.1769 1.47927 9.72417L1.98614 9.0715C1.92397 8.93721 1.86696 8.7996 1.81546 8.65919L0.996348 8.55505C0.995929 8.555 0.995526 8.55494 0.995107 8.5549C0.427838 8.48619 0 8.00325 0 7.4312V6.21724C0 5.64481 0.428228 5.16211 0.996871 5.09351L1.81538 4.98929C1.86677 4.84897 1.92362 4.7113 1.98597 4.5768L1.47915 3.92465C1.12701 3.47063 1.1643 2.82485 1.57625 2.42329L2.42671 1.57338C2.82634 1.16348 3.47226 1.12815 3.92438 1.4792L4.57644 1.98589C4.71105 1.92352 4.84888 1.86662 4.98946 1.81519L5.09373 0.995125ZM6.82448 4.43525C5.50742 4.43525 4.43541 5.50723 4.43541 6.82422C4.43541 8.14119 5.50742 9.21317 6.82448 9.21317C8.14154 9.21317 9.21356 8.14119 9.21356 6.82422C9.21356 5.50723 8.14154 4.43525 6.82448 4.43525ZM3.79381 6.82422C3.79381 5.15287 5.15311 3.79365 6.82448 3.79365C8.49586 3.79365 9.85515 5.15287 9.85515 6.82422C9.85515 8.49556 8.49586 9.85477 6.82448 9.85477C5.15311 9.85477 3.79381 8.49556 3.79381 6.82422Z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Expiry row */}
      <div className={s.ocExpiryRow}>
        <span className={s.ocExpiryLabel}>Expiry</span>
        <ExpiryDropdown expiries={expiries} selected={selectedExpiry} onChange={v => { setSelectedExpiry(v); shouldScrollToAtm.current = true; }} />
      </div>

      {/* Table */}
      <div className={s.ocTableScroll}>
        {rows.length === 0 ? (
          <div className={s.ocTableEmpty}>
            {instruments.length === 0 ? 'Loading…' : selectedExpiry ? 'No options found' : 'Select expiry'}
          </div>
        ) : (
          <table className={s.ocTable}>
            <thead className={s.ocThead}>
              <tr className={s.ocHeadRowTop}>
                <th className={s.ocThCall}>Call</th>
                <th className={s.ocThStrike}>Strike</th>
                <th className={s.ocThPut}>Put</th>
              </tr>
              <tr className={s.ocHeadRowSub}>
                <th className={s.ocThCallSub}>{curMetricLabel}</th>
                <th className={s.ocThStrikeSub}>Strike</th>
                <th className={s.ocThPutSub}>{curMetricLabel}</th>
              </tr>
            </thead>
            <tbody className="ocp-tbody">
              {rows.map((row, ri) => {
                const ceVal = getMetricValue(row.ceKey, metric);
                const peVal = getMetricValue(row.peKey, metric);
                const isAtm = row.strike === atmStrike;
                const prevRow = rows[ri - 1];
                const showAtmLine = isAtm && prevRow && prevRow.strike !== atmStrike;
                const isCeItm = spot > 0 && row.strike < spot;
                const isPeItm = spot > 0 && row.strike > spot;
                return (
                  <tr key={row.strike}
                    ref={isAtm ? atmRowRef : undefined}
                    className={`ocp-row ${isAtm ? 'ocp-row-atm' : ri % 2 === 0 ? 'ocp-row-even' : 'ocp-row-odd'}`}
                    style={{ borderBottom: showAtmLine ? '1px dashed rgba(224,168,0,0.4)' : '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <td className={cx(s.ocTdCall, ceVal === '—' ? s.ocTdCallEmpty : '')}
                      style={{ background: isCeItm ? 'rgba(0,168,132,0.18)' : undefined }}
                    >{ceVal}</td>
                    <td className={cx(s.ocTdStrike, isAtm ? s.ocTdStrikeAtm : '')}>
                      {row.strike % 1 === 0 ? row.strike.toFixed(0) : row.strike.toFixed(2)}
                    </td>
                    <td className={cx(s.ocTdPut, peVal === '—' ? s.ocTdPutEmpty : '')}
                      style={{ background: isPeItm ? 'rgba(210,130,0,0.28)' : undefined }}
                    >{peVal}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type Interval = { label: string; value: string; minutes: number };

const INTERVALS: Interval[] = [
  { label: '1m',  value: 'I1',   minutes: 1    },
  { label: '5m',  value: 'I5',   minutes: 5    },
  { label: '15m', value: 'I15',  minutes: 15   },
  { label: '30m', value: 'I30',  minutes: 30   },
  { label: '1h',  value: 'I60',  minutes: 60   },
  { label: '1D',  value: 'I1D',  minutes: 1440 },
  { label: '1W',  value: 'I1W',  minutes: 10080 },
  { label: '1M',  value: 'I1Mo', minutes: 43200 },
];

interface FetchResult {
  candles: number[][];
  prevTimestamp: number | null;
}

async function fetchCandles(
  instrumentKey: string,
  interval: string,
  from: number
): Promise<FetchResult> {
  const params = new URLSearchParams({
    instrumentKey,
    interval,
    from: String(from),
    limit: '500',
  });
  const res = await fetch(`/api/public-candles?${params}`);
  if (!res.ok) throw new Error('fetch error: ' + res.status);
  const json = await res.json();
  const rawCandles: number[][] = json?.data?.candles ?? [];
  // Upstox returns newest-first; lightweight-charts requires oldest-first.
  const candles = rawCandles.reverse();
  const prevTimestamp: number | null = json?.data?.meta?.prevTimestamp ?? null;
  return { candles, prevTimestamp };
}

// lightweight-charts v5 uses Unix seconds for time
function toCandleRow(c: number[]): CandlestickData {
  return {
    time: Math.floor(c[0] / 1000) as Time,
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
  };
}

function toVolRow(c: number[]): HistogramData {
  const bullish = c[4] >= c[1];
  return {
    time: Math.floor(c[0] / 1000) as Time,
    value: c[5],
    color: bullish ? 'rgba(46,189,133,0.45)' : 'rgba(242,54,69,0.45)',
  };
}

// IST-aligned bar boundary snap (UTC+5:30 = 19800s)
const IST_OFFSET_SEC = 19800;

function snapToBarTime(tsMs: number, intervalMinutes: number): number {
  const intervalSec = intervalMinutes * 60;
  const nowSec = Math.floor(tsMs / 1000);
  return Math.floor((nowSec + IST_OFFSET_SEC) / intervalSec) * intervalSec - IST_OFFSET_SEC;
}

const INITIAL_VISIBLE = 120;

// ── VWAP / TWAP types ────────────────────────────────────────────────────────
type VwapAnchor = 'daily' | 'weekly' | 'monthly' | 'expiry';
interface VwapPoint { time: Time; value: number; }
interface VwapResult {
  vwap: VwapPoint[];
  b1p: VwapPoint[]; b1n: VwapPoint[];
  b2p: VwapPoint[]; b2n: VwapPoint[];
  b3p: VwapPoint[]; b3n: VwapPoint[];
}

function isNewVwapSegment(
  prevSec: number,
  currSec: number,
  anchor: VwapAnchor,
  expiriesSec: number[],
): boolean {
  if (anchor === 'daily') {
    return Math.floor((prevSec + IST_OFFSET_SEC) / 86400) !== Math.floor((currSec + IST_OFFSET_SEC) / 86400);
  }
  if (anchor === 'weekly') {
    // Find IST Monday epoch for each bar: subtract days-since-Monday
    const weekStart = (sec: number) => {
      const d = new Date((sec + IST_OFFSET_SEC) * 1000);
      const dow = d.getUTCDay(); // 0=Sun,1=Mon...6=Sat
      const daysFromMon = (dow + 6) % 7;
      return Math.floor((sec + IST_OFFSET_SEC) / 86400) - daysFromMon;
    };
    return weekStart(prevSec) !== weekStart(currSec);
  }
  if (anchor === 'monthly') {
    const pd = new Date((prevSec + IST_OFFSET_SEC) * 1000);
    const cd = new Date((currSec + IST_OFFSET_SEC) * 1000);
    return pd.getUTCMonth() !== cd.getUTCMonth() || pd.getUTCFullYear() !== cd.getUTCFullYear();
  }
  // expiry: a boundary if any expiry timestamp falls in (prevSec, currSec]
  return expiriesSec.some(exp => exp > prevSec && exp <= currSec);
}

function calculateVWAP(
  candles: CandlestickData[],
  volData: HistogramData[],
  anchor: VwapAnchor,
  expiriesSec: number[],
): VwapResult {
  const result: VwapResult = { vwap: [], b1p: [], b1n: [], b2p: [], b2n: [], b3p: [], b3n: [] };
  if (candles.length === 0) return result;

  let cumTPV = 0, cumVol = 0, cumTPV2 = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const t = Number(c.time) as number;
    const tp = (c.high + c.low + c.close) / 3;
    const vol = volData[i]?.value ?? 0;

    if (i === 0 || isNewVwapSegment(Number(candles[i - 1].time), t, anchor, expiriesSec)) {
      cumTPV = tp * vol; cumVol = vol; cumTPV2 = tp * tp * vol;
    } else {
      cumTPV += tp * vol; cumVol += vol; cumTPV2 += tp * tp * vol;
    }

    const vwap = cumVol > 0 ? cumTPV / cumVol : tp;
    const variance = cumVol > 0 ? Math.max(0, cumTPV2 / cumVol - vwap * vwap) : 0;
    const sigma = Math.sqrt(variance);
    const pt = (v: number): VwapPoint => ({ time: c.time, value: v });

    result.vwap.push(pt(vwap));
    result.b1p.push(pt(vwap + sigma)); result.b1n.push(pt(vwap - sigma));
    result.b2p.push(pt(vwap + 2 * sigma)); result.b2n.push(pt(vwap - 2 * sigma));
    result.b3p.push(pt(vwap + 3 * sigma)); result.b3n.push(pt(vwap - 3 * sigma));
  }
  return result;
}

function calculateTWAP(candles: CandlestickData[]): VwapPoint[] {
  const result: VwapPoint[] = [];
  if (candles.length === 0) return result;
  let cumTP = 0, count = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    if (i === 0 || isNewVwapSegment(Number(candles[i - 1].time), Number(c.time), 'daily', [])) {
      cumTP = tp; count = 1;
    } else {
      cumTP += tp; count++;
    }
    result.push({ time: c.time, value: cumTP / count });
  }
  return result;
}

// ── Timeframe inline buttons (TradingView style) ─────────────────────────────
function TimeframeButtons({ interval, onChange }: { interval: Interval; onChange: (iv: Interval) => void }) {
  return (
    <div className={s.tfRow}>
      {INTERVALS.map(iv => {
        const active = iv.value === interval.value;
        return (
          <button
            key={iv.value}
            onClick={() => onChange(iv)}
            className={cx(s.tfBtn, active ? s.tfBtnActive : '')}
          >
            {iv.label}
          </button>
        );
      })}
    </div>
  );
}

// ── View Switcher (multi-pane) ────────────────────────────────────────────────
type ViewKey = 'candle' | 'straddle' | 'oiprofile';

function CandleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="6" height="14" x="4" y="5" rx="2"/>
      <rect width="6" height="10" x="14" y="7" rx="2"/>
      <path d="M17 22v-5"/>
      <path d="M17 7V2"/>
      <path d="M7 22v-3"/>
      <path d="M7 5V2"/>
    </svg>
  );
}

function StraddleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2 18 7 10 12 14 17 6 22 10" />
      <polyline points="2 18 7 14 12 10 17 16 22 12" strokeOpacity="0.45" />
    </svg>
  );
}

function OIProfileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="8" height="3" rx="1" />
      <rect x="2" y="11" width="14" height="3" rx="1" />
      <rect x="2" y="17" width="6" height="3" rx="1" />
      <line x1="2" y1="2" x2="2" y2="22" />
    </svg>
  );
}

const VIEW_OPTIONS: { value: ViewKey; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'candle', label: 'Candle Chart', icon: <CandleIcon />, color: '#26a69a' },
  { value: 'straddle', label: 'Straddle', icon: <StraddleIcon />, color: '#7B68EE' },
  { value: 'oiprofile', label: 'OI Profile', icon: <OIProfileIcon />, color: '#FF9800' },
];

function LayoutButtonInline({ activeLayout, onLayoutChange }: { activeLayout: LayoutId; onLayoutChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        title="Change layout"
        className={cx(s.layoutBtn, open ? s.layoutBtnOpen : '')}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </button>
      {open && (
        <LayoutPicker
          anchorRef={btnRef}
          activeLayout={activeLayout}
          onSelect={id => { onLayoutChange(id); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ViewSwitcher({ onViewChange }: { onViewChange: (v: ViewKey) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.right });
    }
    setOpen(o => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        title="Switch view type"
        className={cx(s.viewSwitchBtn, open ? s.viewSwitchBtnOpen : '')}
      >
        {/* Grid icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
        View
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          <path d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {open && createPortal(
        <div ref={menuRef} className={s.viewDropdownMenu} style={{ top: pos.top, left: pos.left, transform: 'translateX(-100%)' }}>
          <div className={s.viewDropdownTitle}>Switch View</div>
          {VIEW_OPTIONS.map(opt => (
            <button key={opt.value}
              onClick={() => { onViewChange(opt.value); setOpen(false); }}
              className={s.viewDropdownBtn}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = `rgba(${opt.color === '#26a69a' ? '38,166,154' :
                    opt.color === '#7B68EE' ? '123,104,238' : '255,152,0'
                  },0.10)`;
              }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <span className={s.viewDropdownIcon} style={{ background: `rgba(${opt.color === '#26a69a' ? '38,166,154' : opt.color === '#7B68EE' ? '123,104,238' : '255,152,0'},0.14)`, color: opt.color }}>
                {opt.icon}
              </span>
              <span className={s.viewDropdownLabel}>
                <span className={s.viewDropdownLabelText}>{opt.label}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// ── OI Profile Settings Modal ─────────────────────────────────────────────────
function OISettingsModal({
  anchorRef,
  panelRef,
  mode, onMode,
  callColor, onCallColor,
  putColor, onPutColor,
  opacity, onOpacity,
  expiries, selectedExpiry, onExpiry,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  mode: OIMode; onMode: (m: OIMode) => void;
  callColor: string; onCallColor: (c: string) => void;
  putColor: string; onPutColor: (c: string) => void;
  opacity: number; onOpacity: (v: number) => void;
  expiries: number[]; selectedExpiry: number | null; onExpiry: (e: number) => void;
  onClose: () => void;
}) {
  const fmtExpiry = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' });
  };
  // Compute position synchronously on first render — no flicker
  const pos = useMemo(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      return { top: r.bottom + 6, right: window.innerWidth - r.right };
    }
    return { top: 0, right: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !panelRef.current?.contains(t)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [anchorRef, panelRef, onClose]);

  const [gexExpanded, setGexExpanded] = useState(mode === 'gex_raw' || mode === 'gex_spot');

  type ModeItem = { id: OIMode; label: string; sub: string; icon: React.ReactNode; hasChildren?: boolean };
  const modes: ModeItem[] = [
    {
      id: 'oi', label: 'Open Interest', sub: 'Call & Put OI per strike',
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>,
    },
    {
      id: 'volume', label: 'Volume', sub: 'Traded volume per strike',
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="6" height="13" rx="1" /><rect x="9" y="3" width="6" height="17" rx="1" /><rect x="16" y="10" width="6" height="10" rx="1" /></svg>,
    },
    {
      id: 'iv', label: 'Implied Volatility', sub: 'IV per strike',
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s2-6 5-6 4 12 7 12 5-6 8-6" /></svg>,
    },
    {
      id: 'gex_raw', label: 'Gamma Exposure', sub: 'γ · OI · Lot  or  γ · OI · Lot · S²',
      hasChildren: true,
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>,
    },
    {
      id: 'dex', label: 'Delta Exposure', sub: '|δ| · OI · Lot per strike',
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 20 L12 4 L21 20 Z" /></svg>,
    },
  ];

  const isGexActive = mode === 'gex_raw' || mode === 'gex_spot';

  return createPortal(
    <div
      ref={panelRef as RefObject<HTMLDivElement>}
      className={s.oiSettingsPanel}
      style={{ top: pos.top, right: pos.right }}
    >
      {/* Header */}
      <div className={s.oiSettingsHeader}>
        <div className={s.oiSettingsHeaderLeft}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2ebd85" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6h-8m8 4H6m12 4h-8m8 4H6" />
          </svg>
          <span className={s.oiSettingsTitle}>OI Profile Settings</span>
        </div>
        <button onClick={onClose} className={s.oiSettingsClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 18 17.94 6M18 18 6.06 6" /></svg>
        </button>
      </div>

      <div className={s.oiSettingsBody}>

        {/* Expiry Picker */}
        {expiries.length > 0 && (
          <div>
            <div className={s.oiSectionLabel}>Expiry</div>
            <div className={s.oiExpiryWrap}>
              {expiries.map(exp => {
                const active = exp === selectedExpiry;
                return (
                  <button
                    key={exp}
                    onClick={() => onExpiry(exp)}
                    className={cx(s.oiExpiryBtn, active ? s.oiExpiryBtnActive : s.oiExpiryBtnInactive)}
                  >
                    {fmtExpiry(exp)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Data Mode */}
        <div>
          <div className={s.oiSectionLabel}>Data Mode</div>
          <div className={s.oiModeColumn}>
            {modes.map(m => {
              const active = m.hasChildren ? isGexActive : mode === m.id;
              return (
                <div key={m.id}>
                  <button
                    onClick={() => {
                      if (m.hasChildren) {
                        setGexExpanded(e => !e);
                        if (!isGexActive) onMode('gex_raw');
                      } else {
                        onMode(m.id);
                      }
                    }}
                    className={cx(s.oiModeBtn, active ? s.oiModeBtnActive : s.oiModeBtnInactive)}
                  >
                    <span className={cx(s.oiModeIcon, active ? s.oiModeIconActive : s.oiModeIconInactive)}>{m.icon}</span>
                    <span className={s.oiModeText}>
                      <div className={cx(s.oiModeLabel, active ? s.oiModeLabelActive : s.oiModeLabelInactive)}>{m.label}</div>
                      <div className={s.oiModeSub}>{m.sub}</div>
                    </span>
                    {m.hasChildren ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={active ? '#2ebd85' : '#4A4E5C'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ transform: gexExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
                        <path d="m9 5 7 7-7 7" />
                      </svg>
                    ) : active ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2ebd85" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : null}
                  </button>

                  {/* GEX sub-options */}
                  {m.hasChildren && gexExpanded && (
                    <div className={s.oiGexSubs}>
                      {([
                        { id: 'gex_raw' as OIMode, label: 'By OI', sub: 'γ · OI · Lot' },
                        { id: 'gex_spot' as OIMode, label: 'By Spot', sub: 'γ · OI · Lot · S²' },
                      ] as { id: OIMode; label: string; sub: string }[]).map(sub => {
                        const subActive = mode === sub.id;
                        return (
                          <button
                            key={sub.id}
                            onClick={() => onMode(sub.id)}
                            className={cx(s.oiGexSubBtn, subActive ? s.oiGexSubBtnActive : s.oiGexSubBtnInactive)}
                          >
                            <span className={cx(s.oiGexDot, subActive ? s.oiGexDotActive : s.oiGexDotInactive)} />
                            <span className={s.oiModeText}>
                              <div className={cx(s.oiGexSubLabel, subActive ? s.oiGexSubLabelActive : s.oiGexSubLabelInactive)}>{sub.label}</div>
                              <div className={s.oiGexSubSub}>{sub.sub}</div>
                            </span>
                            {subActive && (
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Colors */}
        <div>
          <div className={s.oiSectionLabel}>Bar Colors</div>
          <div className={s.oiColorRow}>
            {[
              { label: 'Call', value: callColor, onChange: onCallColor },
              { label: 'Put', value: putColor, onChange: onPutColor },
            ].map(({ label, value, onChange }) => (
              <label key={label} className={s.oiColorLabel}>
                <div className={s.oiColorName}>{label}</div>
                <div className={s.oiColorSwatch}>
                  <div className={s.oiColorDot} style={{ background: value }} />
                  <span className={s.oiColorHex}>{value}</span>
                  <input type="color" value={value} onChange={e => onChange(e.target.value)}
                    className={s.oiColorInputHidden}
                    id={`oi-color-${label}`}
                  />
                </div>
                <input type="color" value={value} onChange={e => onChange(e.target.value)}
                  className={s.oiColorInputRange}
                />
              </label>
            ))}
          </div>
        </div>

        {/* Opacity */}
        <div>
          <div className={s.oiOpacityHeader}>
            <div className={s.oiSectionLabel} style={{ marginBottom: 0 }}>Opacity</div>
            <span className={s.oiOpacityVal}>{opacity}%</span>
          </div>
          <input
            type="range" min={10} max={100} value={opacity}
            onChange={e => onOpacity(Number(e.target.value))}
            className={s.oiOpacitySlider}
          />
          <div className={s.oiOpacityHints}>
            <span className={s.oiOpacityHint}>10%</span>
            <span className={s.oiOpacityHint}>100%</span>
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}

// ── VWAP Settings Panel ───────────────────────────────────────────────────────
function VwapSettingsPanel({
  anchorRef,
  panelRef,
  anchor,
  onAnchor,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  anchor: VwapAnchor;
  onAnchor: (a: VwapAnchor) => void;
  onClose: () => void;
}) {
  const pos = useMemo(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      return { top: r.bottom + 6, right: window.innerWidth - r.right };
    }
    return { top: 0, right: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !panelRef.current?.contains(t)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [anchorRef, panelRef, onClose]);

  const anchors: { id: VwapAnchor; label: string; sub: string }[] = [
    { id: 'daily', label: 'Daily', sub: 'Reset at 9:15 AM IST each day' },
    { id: 'weekly', label: 'Weekly', sub: 'Reset each Monday' },
    { id: 'monthly', label: 'Monthly', sub: 'Reset at month start' },
    { id: 'expiry', label: 'Expiry-to-Expiry', sub: 'Reset at each F&O expiry boundary' },
  ];

  return createPortal(
    <div ref={panelRef as RefObject<HTMLDivElement>} className={s.vwapPanel} style={{ top: pos.top, right: pos.right }}>
      {/* Header */}
      <div className={s.vwapPanelHeader}>
        <span className={s.vwapPanelTitle}>VWAP Anchor</span>
        <button onClick={onClose} className={s.vwapPanelClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 18 17.94 6M18 18 6.06 6" /></svg>
        </button>
      </div>
      <div className={s.vwapPanelBody}>
        {anchors.map(a => {
          const active = anchor === a.id;
          return (
            <button key={a.id} onClick={() => { onAnchor(a.id); onClose(); }}
              className={cx(s.vwapAnchorBtn, active ? s.vwapAnchorBtnActive : s.vwapAnchorBtnInactive)}
            >
              <span className={cx(s.vwapAnchorDot, active ? s.vwapAnchorDotActive : s.vwapAnchorDotInactive)} />
              <span className={s.oiModeText}>
                <div className={cx(s.vwapAnchorLabel, active ? s.vwapAnchorLabelActive : s.vwapAnchorLabelInactive)}>{a.label}</div>
                <div className={s.vwapAnchorSub}>{a.sub}</div>
              </span>
              {active && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFD700" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
}

export default function CandleChart({ instrument, instruments = [], onSearchOpen, visible = true, onViewChange, activeLayout, onLayoutChange, hideToolbar = false, defaultInterval, onIntervalChange, oiShowProp, onOiShowChange, optionChainOpenProp, onOptionChainOpenChange, openOiSettingsRef, oiSettingsAnchorRef, vwapShowProp, onVwapShowChange, vwapAnchorProp, onVwapAnchorChange, vwapColorProp, onVwapColorChange, vwapExpiryDayProp, onVwapExpiryDayChange, twapShowProp, onTwapShowChange, drawingRef, onDrawingsChange }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const histLoadBarRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  // VWAP / TWAP series refs
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapB1pRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapB1nRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapB2pRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapB2nRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapB3pRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapB3nRef = useRef<ISeriesApi<'Line'> | null>(null);
  const twapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapRafRef = useRef<number | null>(null);
  const oiRowsRef = useRef<OIRow[]>([]);
  const hoveredStrikeRef = useRef<number | null>(null);
  const oiShowLiveRef = useRef(false);

  const allCandlesRef = useRef<CandlestickData[]>([]);
  const allVolRef = useRef<HistogramData[]>([]);
  const prevTimestampRef = useRef<number | null>(null);
  const isLoadingMoreRef = useRef(false);
  const loadLockRef = useRef(false);
  const initialZoomDoneRef = useRef(false);     // true after first zoomToEnd — never zoom again until instrument/interval changes
  const programmaticScrollRef = useRef(false); // true during programmatic scroll — suppresses scroll handler side-effects

  // Live bar refs — reset on every interval/instrument change
  const liveBarRef = useRef<CandlestickData | null>(null);
  const liveVolRef = useRef<HistogramData | null>(null);
  // Blocks WS updates while REST fetch is in flight
  const restLoadingRef = useRef(false);
  // True until the very first chart load completes — skeleton holds for MIN_SKELETON_MS on initial load
  const firstLoadRef = useRef(true);
  const MIN_SKELETON_MS = 600;
  // Pre-market tick accumulator (INDEX only, 08:59–09:07 IST)
  const pmTicksRef = useRef<number[][]>([]);
  const pmSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Version counter: incremented on each interval/instrument change.
  // WS callback captures its value at subscription time and bails if stale.
  const sessionRef = useRef(0);
  // Timer for the silent re-fetch at the next bar boundary after WS connects
  const barRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether we've already scheduled the silent re-fetch for this session
  const barRefetchScheduledRef = useRef(false);

  const [interval, setIntervalState] = useState<Interval>(
    () => INTERVALS.find(iv => iv.value === defaultInterval) ?? INTERVALS[0]
  );
  // Sync interval when toolbar changes it externally (defaultInterval prop updated)
  const prevDefaultInterval = useRef(defaultInterval);
  useEffect(() => {
    if (defaultInterval && defaultInterval !== prevDefaultInterval.current) {
      prevDefaultInterval.current = defaultInterval;
      const found = INTERVALS.find(iv => iv.value === defaultInterval);
      if (found) setIntervalState(found);
    }
  }, [defaultInterval]);
  const [chartReady, setChartReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [restLoadedKey, setRestLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false); // drives HIST spinner — set via rAF to avoid scroll jank
  const [showGoLatest, setShowGoLatest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsLive, setWsLive] = useState(false);
  const [optionChainOpenInternal, setOptionChainOpenInternal] = useState(false);
  const optionChainOpen = optionChainOpenProp ?? optionChainOpenInternal;
  const setOptionChainOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(optionChainOpen) : v;
    setOptionChainOpenInternal(next);
    onOptionChainOpenChange?.(next);
  };
  // Deferred mount — panel DOM is created one rAF after open so the click
  // never blocks the chart frame (Bloomberg-style: UI responds instantly, data loads after)
  const [ocPanelMounted, setOcPanelMounted] = useState(false);
  useEffect(() => {
    if (!optionChainOpen) { setOcPanelMounted(false); return; }
    const id = requestAnimationFrame(() => setOcPanelMounted(true));
    return () => cancelAnimationFrame(id);
  }, [optionChainOpen]);

  const [oiShowInternal, setOiShowInternal] = useState(false);
  const oiShow = oiShowProp ?? oiShowInternal;
  const setOiShow = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(oiShow) : v;
    setOiShowInternal(next);
    onOiShowChange?.(next);
  };
  // Sync internal state when controlled prop changes from toolbar
  useEffect(() => { if (oiShowProp !== undefined) setOiShowInternal(oiShowProp); }, [oiShowProp]);
  useEffect(() => { if (optionChainOpenProp !== undefined) setOptionChainOpenInternal(optionChainOpenProp); }, [optionChainOpenProp]);
  const [oiTooltip, setOiTooltip] = useState<OITooltip>({ visible: false, x: 0, y: 0, strike: 0, callOI: 0, putOI: 0, callVol: 0, putVol: 0, callIV: 0, putIV: 0 });
  const [crosshairOHLC, setCrosshairOHLC] = useState<{ open: number; high: number; low: number; close: number; change: number; changePct: number } | null>(null);
  const setCrosshairOHLCRef = useRef(setCrosshairOHLC);
  setCrosshairOHLCRef.current = setCrosshairOHLC;
  const oiTooltipVisRef = useRef(false);
  const [oiSettingsOpen, setOiSettingsOpen] = useState(false);
  const [oiMode, setOiMode] = useState<OIMode>('oi');
  const [oiCallColor, setOiCallColor] = useState('#2ebd85');
  const [oiPutColor, setOiPutColor] = useState('#f23645');
  const [oiOpacity, setOiOpacity] = useState(75);
  const [oiExpiry, setOiExpiry] = useState<number | null>(null);
  const oiSettingsBtnRef = useRef<HTMLButtonElement>(null);
  const oiSettingsPanelRef = useRef<HTMLDivElement>(null);
  // Expose toggle fn to workspace toolbar via ref
  if (openOiSettingsRef) openOiSettingsRef.current = () => setOiSettingsOpen(o => !o);

  // ── VWAP / TWAP state (controlled when props provided) ───────────────────
  const [vwapShowInternal, setVwapShowInternal] = useState(false);
  const [vwapAnchorInternal, setVwapAnchorInternal] = useState<VwapAnchor>('daily');
  const [vwapColorInternal, setVwapColorInternal] = useState('#FFD700');
  const [vwapExpiryDayInternal, setVwapExpiryDayInternal] = useState<'tuesday' | 'thursday'>('thursday');
  const [twapShowInternal, setTwapShowInternal] = useState(false);
  const vwapShow = vwapShowProp ?? vwapShowInternal;
  const vwapAnchor = vwapAnchorProp ?? vwapAnchorInternal;
  const vwapColor = vwapColorProp ?? vwapColorInternal;
  const vwapExpiryDay = vwapExpiryDayProp ?? vwapExpiryDayInternal;
  const twapShow = twapShowProp ?? twapShowInternal;
  const setVwapShow = (v: boolean) => { setVwapShowInternal(v); onVwapShowChange?.(v); };
  const setVwapAnchor = (a: VwapAnchor) => { setVwapAnchorInternal(a); onVwapAnchorChange?.(a); };
  const _setVwapColor = (c: string) => { setVwapColorInternal(c); onVwapColorChange?.(c); };
  const _setVwapExpiryDay = (d: 'tuesday' | 'thursday') => { setVwapExpiryDayInternal(d); onVwapExpiryDayChange?.(d); };
  const setTwapShow = (v: boolean) => { setTwapShowInternal(v); onTwapShowChange?.(v); };
  useEffect(() => { if (vwapShowProp !== undefined) setVwapShowInternal(vwapShowProp); }, [vwapShowProp]);
  useEffect(() => { if (vwapAnchorProp !== undefined) setVwapAnchorInternal(vwapAnchorProp); }, [vwapAnchorProp]);
  useEffect(() => { if (vwapColorProp !== undefined) setVwapColorInternal(vwapColorProp); }, [vwapColorProp]);
  useEffect(() => { if (vwapExpiryDayProp !== undefined) setVwapExpiryDayInternal(vwapExpiryDayProp); }, [vwapExpiryDayProp]);
  useEffect(() => { if (twapShowProp !== undefined) setTwapShowInternal(twapShowProp); }, [twapShowProp]);
  const [vwapSettingsOpen, setVwapSettingsOpen] = useState(false);
  const vwapBtnRef = useRef<HTMLButtonElement>(null);
  const vwapSettingsPanelRef = useRef<HTMLDivElement>(null);
  // Stable refs — mirror state for use inside callbacks without stale closures
  const vwapAnchorRef = useRef<VwapAnchor>('daily');
  vwapAnchorRef.current = vwapAnchor;
  const vwapColorRef = useRef('#FFD700');
  vwapColorRef.current = vwapColor;
  const vwapExpiryDayRef = useRef<'tuesday' | 'thursday'>('thursday');
  vwapExpiryDayRef.current = vwapExpiryDay;

  // Compute available expiries for OI overlay — only when OI panel is open (lazy)
  const oiUnderlying = instrument.underlying_symbol || instrument.trading_symbol;
  const oiExpiries = useMemo(() => {
    if (!oiShow || !oiUnderlying || !instruments.length) return [];
    const today = Date.now();
    return [...new Set(
      instruments
        .filter(i => (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.underlying_symbol === oiUnderlying && i.expiry != null && i.expiry >= today - 86400000)
        .map(i => i.expiry as number)
    )].sort((a, b) => a - b);
  }, [oiShow, oiUnderlying, instruments]);

  // Auto-select nearest expiry when list loads or instrument changes
  useEffect(() => {
    if (oiExpiries.length > 0 && (oiExpiry === null || !oiExpiries.includes(oiExpiry))) {
      setOiExpiry(oiExpiries[0]);
    }
  }, [oiExpiries, oiExpiry]);

  // Keep refs in sync so boot-effect closures can read latest values
  const oiModeRef = useRef<OIMode>('oi');
  const oiCallColorRef = useRef('#2ebd85');
  const oiPutColorRef = useRef('#f23645');
  const oiOpacityRef = useRef(75);
  const oiSpotRef = useRef(0);
  const oiExpiryRef = useRef<number | null>(null);
  oiModeRef.current = oiMode;
  oiCallColorRef.current = oiCallColor;
  oiPutColorRef.current = oiPutColor;
  oiOpacityRef.current = oiOpacity;
  oiExpiryRef.current = oiExpiry;

  // Stable refs — WS callback reads these without needing re-subscription
  const intervalRef = useRef<Interval>(interval);
  intervalRef.current = interval;

  // Show option chain/OI if: INDEX/EQ directly, or FUT/CE/PE with options.
  // Only computed after chart has loaded data — never blocks initial render.
  const hasOptions = useMemo(() => {
    if (!restLoadedKey) return false; // defer until chart is painted
    const t = instrument.instrument_type;
    if (t === 'INDEX' || t === 'EQ') return true;
    if (t === 'FUT' || t === 'CE' || t === 'PE') {
      const underlying = instrument.underlying_symbol;
      if (!underlying || !instruments?.length) return false;
      return instruments.some(i => (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.underlying_symbol === underlying);
    }
    return false;
  }, [restLoadedKey, instrument.instrument_type, instrument.underlying_symbol, instruments]);

  // ── Expiry list in Unix seconds for VWAP expiry-to-expiry anchor ───────────
  // Filtered by vwapExpiryDay: 2=Tue, 4=Thu (getUTCDay on IST-shifted date)
  // Only computed when VWAP is active and anchor is 'expiry' — lazy to avoid blocking chart init
  const vwapExpiriesSec = useMemo(() => {
    const under = instrument.underlying_symbol || instrument.trading_symbol;
    if (!vwapShow || vwapAnchor !== 'expiry' || !under || !instruments?.length) return [];
    const dayFilter = vwapExpiryDay === 'tuesday' ? 2 : 4; // IST weekday
    return [...new Set(
      instruments
        .filter(i => {
          if ((i.instrument_type !== 'CE' && i.instrument_type !== 'PE') || i.underlying_symbol !== under || i.expiry == null) return false;
          const expSec = Math.floor((i.expiry as number) / 1000);
          const dow = new Date((expSec + 19800) * 1000).getUTCDay();
          return dow === dayFilter;
        })
        .map(i => Math.floor((i.expiry as number) / 1000))
    )].sort((a, b) => a - b);
  }, [vwapShow, vwapAnchor, instrument.underlying_symbol, instrument.trading_symbol, instruments, vwapExpiryDay]);
  const vwapExpiriesSecRef = useRef<number[]>([]);
  vwapExpiriesSecRef.current = vwapExpiriesSec;

  // ── Boot chart once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !wrapperRef.current) return;

    // Defer chart creation by one rAF so React's flex layout has fully resolved.
    // Without this, on page refresh the container reports 0px dimensions at mount time —
    // LW-charts creates a 0px canvas, pointer events miss it, crosshair/scroll is
    // stuck until the ResizeObserver fires and resizes the chart.
    let chartCleanup: (() => void) | null = null;
    let rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!containerRef.current || !wrapperRef.current) return;

    const w = containerRef.current.clientWidth || wrapperRef.current.clientWidth || 800;
    const h = containerRef.current.clientHeight || wrapperRef.current.clientHeight || 500;

    const chart = createChart(containerRef.current, {
      autoSize: false,
      width: w,
      height: h,
      layout: {
        background: { color: '#171717' },
        textColor: '#B2B5BE',
        fontFamily: "'Work Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
        fontSize: 13,
      },
      grid: {
        vertLines: { color: '#2a2a2a' },
        horzLines: { color: '#2a2a2a' },
      },
      crosshair: { mode: 0 },
      rightPriceScale: {
        borderColor: '#2a2a2a',
        scaleMargins: { top: 0.05, bottom: 0.25 },
        ticksVisible: true,
        visible: true,
      },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: intervalRef.current.value !== 'I1D',
        secondsVisible: false,
        rightOffset: 8,
        tickMarkFormatter: intervalRef.current.value === 'I1D'
          ? (ts: number) => new Date(ts * 1000).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
          : (ts: number) => new Date(ts * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }),
      },
      localization: {
        timeFormatter: intervalRef.current.value === 'I1D'
          ? (ts: number) => new Date(ts * 1000).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
          : (ts: number) => new Date(ts * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#2ebd85',
      downColor: '#f23645',
      borderUpColor: '#2ebd85',
      borderDownColor: '#f23645',
      wickUpColor: '#2ebd85',
      wickDownColor: '#f23645',
    });
    candleSeriesRef.current = candleSeries;

    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volSeriesRef.current = volSeries;
    setChartReady(true);

    // Canvas sync — reads size from containerRef (absolute inset:0, sized by wrapper)
    const el = containerRef.current!;
    const resyncCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = el.clientWidth * dpr;
      canvas.height = el.clientHeight * dpr;
      canvas.style.width = el.clientWidth + 'px';
      canvas.style.height = el.clientHeight + 'px';
    };
    resyncCanvas();

    // Observe wrapperRef — RAF-throttled so resize is never more than 1 redraw/frame
    let roRaf: number | null = null;
    let roDebounce: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (!chartRef.current || !containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      if (!w || !h) return;
      // Manually resize — no autoSize so barSpacing is never reset by LW-charts internals
      if (roRaf !== null) cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => {
        roRaf = null;
        chart.resize(w, h, false);
        resyncCanvas();
      });
      // Heavy OI redraw only after resize settles
      if (roDebounce !== null) clearTimeout(roDebounce);
      roDebounce = setTimeout(() => {
        roDebounce = null;
        resyncCanvas();
        if (canvasRef.current && candleSeriesRef.current)
          drawOIBars(canvasRef.current, chart, candleSeriesRef.current, oiRowsRef.current, hoveredStrikeRef.current, oiModeRef.current, oiCallColorRef.current, oiPutColorRef.current, oiOpacityRef.current, oiSpotRef.current);
      }, 16);
    });
    ro.observe(wrapperRef.current!);

    // Redraw OI on scroll AND on visible range change (fires when chart loads data)
    let scrollRaf: number | null = null;
    const onScroll = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        resyncCanvas();
        if (canvasRef.current && chartRef.current && candleSeriesRef.current)
          drawOIBars(canvasRef.current, chartRef.current, candleSeriesRef.current, oiRowsRef.current, hoveredStrikeRef.current, oiModeRef.current, oiCallColorRef.current, oiPutColorRef.current, oiOpacityRef.current, oiSpotRef.current);
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onScroll);

    // Crosshair hover → OI tooltip
    const tooltipVisRef = oiTooltipVisRef;

    const clearOiHover = () => {
      if (hoveredStrikeRef.current !== null) { hoveredStrikeRef.current = null; redrawOI(); }
      if (tooltipVisRef.current) { tooltipVisRef.current = false; setOiTooltip(t => ({ ...t, visible: false })); }
    };

    chart.subscribeCrosshairMove((param) => {
      // OHLC crosshair header — update on every crosshair move
      const series = candleSeriesRef.current;
      if (series && param.time) {
        const data = param.seriesData.get(series) as CandlestickData | undefined;
        if (data && data.open !== undefined) {
          const change = data.close - data.open;
          const changePct = data.open > 0 ? (change / data.open) * 100 : 0;
          setCrosshairOHLCRef.current({ open: data.open, high: data.high, low: data.low, close: data.close, change, changePct });
        }
      } else if (!param.time) {
        setCrosshairOHLCRef.current(null);
      }

      // If OI overlay is off, never show tooltip
      if (!oiShowLiveRef.current) { clearOiHover(); return; }
      if (!param.point || !candleSeriesRef.current) { clearOiHover(); return; }

      const rows = oiRowsRef.current;
      if (rows.length === 0) { clearOiHover(); return; }

      // Compute bar zone: bars are anchored to right price scale edge
      const priceScaleW = chart.priceScale('right').width();
      const chartW = el.clientWidth;
      const anchor = chartW - priceScaleW;
      // Only activate when cursor is right of where bars start
      if (param.point.x < anchor * (1 - OI_BAR_FILL * 2)) { clearOiHover(); return; }

      // Find closest OI bar row by Y distance
      const HIT = 3;
      let closest: OIRow | null = null;
      let closestDist = Infinity;
      for (const row of rows) {
        const yc = candleSeriesRef.current!.priceToCoordinate(row.strike);
        if (yc == null) continue;
        const d = Math.abs(param.point.y - yc);
        if (d < HIT && d < closestDist) { closestDist = d; closest = row; }
      }

      if (closest) {
        const prev = hoveredStrikeRef.current;
        hoveredStrikeRef.current = closest.strike;
        const wRect = wrapperRef.current!.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const ox = eRect.left - wRect.left + param.point.x;
        const oy = eRect.top - wRect.top + param.point.y;
        tooltipVisRef.current = true;
        setOiTooltip({ visible: true, x: ox, y: oy, strike: closest.strike, callOI: closest.callOI, putOI: closest.putOI, callVol: closest.callVol, putVol: closest.putVol, callIV: closest.callIV, putIV: closest.putIV });
        if (prev !== closest.strike) redrawOI();
      } else {
        clearOiHover();
      }
    });

    chartCleanup = () => {
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      if (roRaf !== null) cancelAnimationFrame(roRaf);
      if (roDebounce !== null) clearTimeout(roDebounce);
      if (vwapRafRef.current !== null) { cancelAnimationFrame(vwapRafRef.current); vwapRafRef.current = null; }
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      setChartReady(false);
    };
    }); // end rAF

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      chartCleanup?.();
    };
  }, [interval.value === 'I1D']);  // recreate chart when switching daily ↔ intraday so localization applies

  // ── OI redraw callback ─────────────────────────────────────────────────────
  const redrawOI = useCallback(() => {
    if (!canvasRef.current || !chartRef.current || !candleSeriesRef.current) return;
    drawOIBars(canvasRef.current, chartRef.current, candleSeriesRef.current, oiRowsRef.current, hoveredStrikeRef.current, oiModeRef.current, oiCallColorRef.current, oiPutColorRef.current, oiOpacityRef.current, oiSpotRef.current);
  }, []);

  // ── Redraw OI when display settings change ─────────────────────────────────
  useEffect(() => {
    if (oiShow) redrawOI();
  }, [oiMode, oiCallColor, oiPutColor, oiOpacity, oiShow, redrawOI]);

  // ── VWAP / TWAP callbacks ─────────────────────────────────────────────────
  // Build rgba from hex color with given opacity
  const hexWithAlpha = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  const addVwapSeries = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || vwapSeriesRef.current) return;
    const c = vwapColorRef.current;
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: c, lineWidth: 2, title: 'VWAP', lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false });
    const band = (color: string) => ({ color, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    vwapB1pRef.current = chart.addSeries(LineSeries, { ...band(hexWithAlpha(c, 0.50)), title: '+1σ' });
    vwapB1nRef.current = chart.addSeries(LineSeries, { ...band(hexWithAlpha(c, 0.50)), title: '-1σ' });
    vwapB2pRef.current = chart.addSeries(LineSeries, { ...band(hexWithAlpha(c, 0.35)), title: '+2σ' });
    vwapB2nRef.current = chart.addSeries(LineSeries, { ...band(hexWithAlpha(c, 0.35)), title: '-2σ' });
    vwapB3pRef.current = chart.addSeries(LineSeries, { ...band(hexWithAlpha(c, 0.20)), title: '+3σ' });
    vwapB3nRef.current = chart.addSeries(LineSeries, { ...band(hexWithAlpha(c, 0.20)), title: '-3σ' });
  }, []);

  const applyVwapColor = useCallback((c: string) => {
    vwapSeriesRef.current?.applyOptions({ color: c });
    vwapB1pRef.current?.applyOptions({ color: hexWithAlpha(c, 0.50) });
    vwapB1nRef.current?.applyOptions({ color: hexWithAlpha(c, 0.50) });
    vwapB2pRef.current?.applyOptions({ color: hexWithAlpha(c, 0.35) });
    vwapB2nRef.current?.applyOptions({ color: hexWithAlpha(c, 0.35) });
    vwapB3pRef.current?.applyOptions({ color: hexWithAlpha(c, 0.20) });
    vwapB3nRef.current?.applyOptions({ color: hexWithAlpha(c, 0.20) });
  }, []);

  const removeVwapSeries = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    [vwapSeriesRef, vwapB1pRef, vwapB1nRef, vwapB2pRef, vwapB2nRef, vwapB3pRef, vwapB3nRef].forEach(r => {
      if (r.current) { try { chart.removeSeries(r.current); } catch { /* ignore */ } r.current = null; }
    });
  }, []);

  const addTwapSeries = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || twapSeriesRef.current) return;
    twapSeriesRef.current = chart.addSeries(LineSeries, { color: '#00BFFF', lineWidth: 2, lineStyle: LineStyle.Dotted, title: 'TWAP', lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false });
  }, []);

  const removeTwapSeries = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || !twapSeriesRef.current) return;
    try { chart.removeSeries(twapSeriesRef.current); } catch { /* ignore */ }
    twapSeriesRef.current = null;
  }, []);

  const updateVwapData = useCallback(() => {
    if (!vwapSeriesRef.current) return;
    const candles = [...allCandlesRef.current];
    const volData = [...allVolRef.current];
    if (liveBarRef.current) {
      candles.push(liveBarRef.current);
      volData.push(liveVolRef.current ?? { time: liveBarRef.current.time, value: 0, color: '' });
    }
    const r = calculateVWAP(candles, volData, vwapAnchorRef.current, vwapExpiriesSecRef.current);
    vwapSeriesRef.current?.setData(r.vwap);
    vwapB1pRef.current?.setData(r.b1p); vwapB1nRef.current?.setData(r.b1n);
    vwapB2pRef.current?.setData(r.b2p); vwapB2nRef.current?.setData(r.b2n);
    vwapB3pRef.current?.setData(r.b3p); vwapB3nRef.current?.setData(r.b3n);
  }, []);

  const updateTwapData = useCallback(() => {
    if (!twapSeriesRef.current) return;
    const candles = [...allCandlesRef.current];
    if (liveBarRef.current) candles.push(liveBarRef.current);
    twapSeriesRef.current.setData(calculateTWAP(candles));
  }, []);

  const scheduleVwapUpdate = useCallback(() => {
    if (vwapRafRef.current !== null) return;
    vwapRafRef.current = requestAnimationFrame(() => {
      vwapRafRef.current = null;
      if (vwapSeriesRef.current) updateVwapData();
      if (twapSeriesRef.current) updateTwapData();
    });
  }, [updateVwapData, updateTwapData]);

  // ── OI subscription effect ─────────────────────────────────────────────────
  useEffect(() => {
    oiShowLiveRef.current = oiShow;
    if (!oiShow) {
      // Clear canvas when toggled off
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    if (!instruments.length || !hasOptions) return;

    // Defer heavy instrument scan + WS subscription off the click frame
    let unsubs: (() => void)[] = [];
    let spotUnsub: (() => void) | null = null;
    let rafId: number | null = null;
    let cancelled = false;

    const tid = window.setTimeout(() => {
      if (cancelled) return;

      const underlying = instrument.underlying_symbol || instrument.trading_symbol;
      if (!underlying) return;

      const today = Date.now();
      const allExpiries = [...new Set(
        instruments
          .filter(i => (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.underlying_symbol === underlying && i.expiry != null && i.expiry >= today - 86400000)
          .map(i => i.expiry as number)
      )].sort((a, b) => a - b);
      if (!allExpiries.length) return;
      const expiry = (oiExpiryRef.current && allExpiries.includes(oiExpiryRef.current)) ? oiExpiryRef.current : allExpiries[0];

      const strikeMetaMap = new Map<number, { ceKey: string | null; peKey: string | null; lotSize: number }>();
      for (const ins of instruments) {
        if (ins.underlying_symbol !== underlying || ins.expiry !== expiry) continue;
        if (ins.instrument_type !== 'CE' && ins.instrument_type !== 'PE') continue;
        const s = ins.strike_price ?? 0;
        if (!strikeMetaMap.has(s)) strikeMetaMap.set(s, { ceKey: null, peKey: null, lotSize: ins.lot_size });
        const meta = strikeMetaMap.get(s)!;
        if (ins.instrument_type === 'CE') meta.ceKey = ins.instrument_key;
        else meta.peKey = ins.instrument_key;
      }

      const spotSnap = wsManager.get(instrument.instrument_key);
      if (spotSnap?.ltp) oiSpotRef.current = spotSnap.ltp;

      const rows: OIRow[] = [...strikeMetaMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, { ceKey, peKey }]) => ceKey && peKey)
        .map(([strike, { ceKey, peKey, lotSize }]) => {
          const ceSnap = wsManager.get(ceKey!);
          const peSnap = wsManager.get(peKey!);
          return {
            strike, callKey: ceKey!, putKey: peKey!, lotSize,
            callOI: ceSnap?.oi ?? 0, putOI: peSnap?.oi ?? 0,
            callVol: ceSnap?.ohlc?.reduce((s, o) => s + Number(o.vol || 0), 0) ?? 0,
            putVol: peSnap?.ohlc?.reduce((s, o) => s + Number(o.vol || 0), 0) ?? 0,
            callIV: ceSnap?.iv ?? 0, putIV: peSnap?.iv ?? 0,
            callGamma: ceSnap?.gamma ?? 0, putGamma: peSnap?.gamma ?? 0,
            callDelta: ceSnap?.delta ?? 0, putDelta: peSnap?.delta ?? 0,
          };
        });

      oiRowsRef.current = rows;
      const allKeys = rows.flatMap(r => [r.callKey, r.putKey]);
      wsManager.requestKeys(allKeys);
      setTimeout(() => redrawOI(), 120);

      const scheduleRedraw = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => { rafId = null; redrawOI(); });
      };

      unsubs = allKeys.map(key =>
        wsManager.subscribe(key, (md) => {
          const row = oiRowsRef.current.find(r => r.callKey === key || r.putKey === key);
          if (!row) return;
          const vol = md.ohlc?.reduce((s, o) => s + Number(o.vol || 0), 0) ?? 0;
          if (row.callKey === key) { row.callOI = md.oi || 0; row.callVol = vol; row.callIV = md.iv || 0; row.callGamma = md.gamma || 0; row.callDelta = md.delta || 0; }
          else { row.putOI = md.oi || 0; row.putVol = vol; row.putIV = md.iv || 0; row.putGamma = md.gamma || 0; row.putDelta = md.delta || 0; }
          scheduleRedraw();
        })
      );

      spotUnsub = wsManager.subscribe(instrument.instrument_key, (md) => {
        if (md.ltp) oiSpotRef.current = md.ltp;
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(tid);
      unsubs.forEach(u => u());
      spotUnsub?.();
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oiShow, oiExpiry, instrument.instrument_key, instrument.underlying_symbol, instrument.trading_symbol, instruments, hasOptions]);


  // ── VWAP / TWAP toggle effects ────────────────────────────────────────────
  useEffect(() => {
    if (vwapShow) { addVwapSeries(); updateVwapData(); }
    else removeVwapSeries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vwapShow]);

  useEffect(() => {
    if (vwapShow) updateVwapData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vwapAnchor, vwapShow, vwapExpiryDay]);

  useEffect(() => {
    if (vwapShow && vwapSeriesRef.current) applyVwapColor(vwapColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vwapColor, vwapShow]);

  useEffect(() => {
    if (twapShow) { addTwapSeries(); updateTwapData(); }
    else removeTwapSeries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twapShow]);

  // ── Zoom to last N candles (right-anchored) ────────────────────────────────
  const zoomToEnd = useCallback((data: CandlestickData[]) => {
    if (initialZoomDoneRef.current) return; // already zoomed — never override user's position
    if (data.length === 0) return;
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    initialZoomDoneRef.current = true;
    const visible = Math.min(INITIAL_VISIBLE, data.length);
    const containerWidth = containerRef.current?.clientWidth ?? 800;
    const spacing = Math.max(4, Math.floor(containerWidth / visible));
    programmaticScrollRef.current = true;
    ts.applyOptions({ barSpacing: spacing, rightOffset: 8 });
    // fitContent first so LW knows the full data range, then snap to right
    ts.fitContent();
    requestAnimationFrame(() => {
      ts.applyOptions({ barSpacing: spacing, rightOffset: 8 });
      ts.scrollToRealTime();
      requestAnimationFrame(() => { programmaticScrollRef.current = false; });
    });
  }, []);

  // ── Update time scale format when interval changes ────────────────────────
  useEffect(() => {
    if (!chartReady || !chartRef.current) return;
    const isDaily = interval.value === 'I1D';
    const dateOnlyFmt = (ts: number) => {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
    };
    const dateTimeFmt = (ts: number) => new Date(ts * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    chartRef.current.applyOptions({
      localization: { timeFormatter: isDaily ? dateOnlyFmt : dateTimeFmt },
    });
    chartRef.current.timeScale().applyOptions({
      timeVisible: !isDaily,
      secondsVisible: false,
    } as any);
    if (isDaily) {
      (chartRef.current.timeScale() as any).applyOptions({ tickMarkFormatter: dateOnlyFmt });
    } else {
      (chartRef.current.timeScale() as any).applyOptions({ tickMarkFormatter: (ts: number) => new Date(ts * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) });
    }
  }, [chartReady, interval.value]);

  // ── Load fresh candles whenever instrument OR interval changes ─────────────
  useEffect(() => {
    if (!chartReady || !candleSeriesRef.current || !volSeriesRef.current) return;

    // New session — bump version so any in-flight WS ticks for the old interval
    // are discarded by the WS callback's stale-session guard.
    const mySession = ++sessionRef.current;

    setLoading(true);
    setError(null);
    setWsLive(false);
    setRestLoadedKey(null);
    restLoadingRef.current = true;
    prevTimestampRef.current = null;
    allCandlesRef.current = [];
    allVolRef.current = [];
    liveBarRef.current = null;
    liveVolRef.current = null;
    loadLockRef.current = false;
    initialZoomDoneRef.current = false;
    barRefetchScheduledRef.current = false;
    if (barRefetchTimerRef.current) {
      clearTimeout(barRefetchTimerRef.current);
      barRefetchTimerRef.current = null;
    }

    // Clear chart immediately so old interval's candles disappear right away
    candleSeriesRef.current.setData([]);
    volSeriesRef.current.setData([]);

    const d = new Date(); d.setHours(23, 59, 59, 999);
    const from = d.getTime();

    // Capture for this fetch session — prevents stale closure issues
    const iv = interval.value;

    (async () => {
      try {
        // Fetch today → if empty, try prev day → if still empty, try day before that.
        // Stop as soon as we have candles. Max 3 fetches, never loads more than needed.
        let res = await fetchCandles(instrument.instrument_key, iv, from);
        if (mySession !== sessionRef.current) return;
        if (res.candles.length === 0 && res.prevTimestamp) {
          res = await fetchCandles(instrument.instrument_key, iv, res.prevTimestamp);
          if (mySession !== sessionRef.current) return;
          if (res.candles.length === 0 && res.prevTimestamp) {
            res = await fetchCandles(instrument.instrument_key, iv, res.prevTimestamp);
            if (mySession !== sessionRef.current) return;
          }
        }

        const candles = res.candles;
        const prevPrev = res.prevTimestamp;

        // Combine (no prev-day merge — only the day with data)
        const combined = [...candles];

        // ── Prepend saved pre-market candles (INDEX only) ──────────────────
        let pmCandles: number[][] = [];
        if (instrument.instrument_type === 'INDEX') {
          try {
            const saved = await loadPreMarketTicks(instrument.instrument_key);
            if (saved && saved.length > 0) {
              // Aggregate 1-min ticks to the current interval
              const ivMins = INTERVALS.find(i => i.value === iv)?.minutes ?? 1;
              if (ivMins === 1) {
                pmCandles = saved;
              } else {
                // Bucket ticks into ivMins-sized bars
                const buckets = new Map<number, number[]>();
                for (const tick of saved) {
                  const bucket = Math.floor(tick[0] / (ivMins * 60)) * (ivMins * 60);
                  if (!buckets.has(bucket)) {
                    buckets.set(bucket, [bucket, tick[1], tick[2], tick[3], tick[4], tick[5] || 0]);
                  } else {
                    const b = buckets.get(bucket)!;
                    b[2] = Math.max(b[2], tick[2]); // high
                    b[3] = Math.min(b[3], tick[3]); // low
                    b[4] = tick[4];                  // close = last
                    b[5] = (b[5] || 0) + (tick[5] || 0); // vol
                  }
                }
                pmCandles = [...buckets.values()].sort((a, b) => a[0] - b[0]);
              }
              // STRICT null-check on pmCandles numeric shapes before pushing
              pmCandles = pmCandles.filter(c => Array.isArray(c) && c.length >= 5 && isFinite(c[0]));
              pmTicksRef.current = pmCandles; // restore in-memory ref too (seconds)
              // Convert pmCandles timestamps from seconds → milliseconds so they
              // match REST candle format before being merged via toCandleRow(c[0]/1000)
              pmCandles = pmCandles.map(c => [c[0] * 1000, ...c.slice(1)]);
            }
          } catch { /* ignore */ }
        }

        const allRaw = [...pmCandles, ...combined].filter(c => Array.isArray(c) && c.length >= 5 && isFinite(c[0]) && isFinite(c[4]));
        const sorted = [...allRaw].sort((a, b) => a[0] - b[0]);
        const unique = sorted.filter((c, i) => i === 0 || c[0] !== sorted[i - 1][0]);

        const cData = unique.map(toCandleRow);
        const vData = unique.map(toVolRow);
        allCandlesRef.current = cData;
        allVolRef.current = vData;
        prevTimestampRef.current = prevPrev;

        // ── Pop live bar BEFORE setData so we only paint once ──────────────────
        const wallBarSec = snapToBarTime(Date.now(), INTERVALS.find(i => i.value === iv)?.minutes ?? 1);
        const lastCandle = cData.length > 0 ? cData[cData.length - 1] : null;
        if (lastCandle && Number(lastCandle.time) === wallBarSec) {
          const poppedCandle = cData.pop()!;
          const poppedVol = vData.pop();
          allCandlesRef.current = cData;
          allVolRef.current = vData;
          const snapshot = wsManager.get(instrument.instrument_key);
          const ltp = (snapshot?.ltp ?? 0) > 0 ? snapshot!.ltp : poppedCandle.close;
          liveBarRef.current = {
            time: poppedCandle.time,
            open: poppedCandle.open,
            high: Math.max(poppedCandle.high, ltp),
            low: Math.min(poppedCandle.low, ltp),
            close: ltp,
          };
          liveVolRef.current = poppedVol ? { ...poppedVol, color: ltp >= poppedCandle.open ? 'rgba(46,189,133,0.5)' : 'rgba(242,54,69,0.5)' } : null;
        } else {
          // Current bar not in REST data yet — seed it from last close so it shows immediately
          // WS will update it with real OHLC on first tick
          const lastClose = lastCandle?.close ?? 0;
          if (lastClose > 0) {
            const snapshot = wsManager.get(instrument.instrument_key);
            const ltp = (snapshot?.ltp ?? 0) > 0 ? snapshot!.ltp : lastClose;
            liveBarRef.current = {
              time: wallBarSec as unknown as Time,
              open: ltp, high: ltp, low: ltp, close: ltp,
            };
          } else {
            liveBarRef.current = null;
          }
          liveVolRef.current = null;
        }

        // Unblock WS ticks immediately (ref — no chart work needed)
        restLoadingRef.current = false;

        // Paint data in its own rAF so it never competes with pointer/scroll events.
        // In production builds, setData+zoomToEnd in the same microtask as chart init blocks input.
        const paintStart = Date.now();
        requestAnimationFrame(() => {
          if (mySession !== sessionRef.current) return;
          if (!candleSeriesRef.current || !volSeriesRef.current) return;
          candleSeriesRef.current.setData(cData);
          volSeriesRef.current.setData(vData);
          if (vwapSeriesRef.current) updateVwapData();
          if (twapSeriesRef.current) updateTwapData();
          if (liveBarRef.current) try { candleSeriesRef.current.update(liveBarRef.current); } catch { /* ignore */ }
          if (liveVolRef.current) try { volSeriesRef.current.update(liveVolRef.current); } catch { /* ignore */ }
          const zoomData = liveBarRef.current ? [...cData, liveBarRef.current] : cData;
          zoomToEnd(zoomData);
          // After paint settles — reset Y axis to fit visible candles (same as double-click)
          setTimeout(() => {
            try {
              const ps = chartRef.current?.priceScale('right');
              ps?.applyOptions({ autoScale: false });
              ps?.applyOptions({ autoScale: true });
            } catch { /* ignore */ }
          }, 50);
          setRestLoadedKey(instrument.instrument_key);
          setTimeout(() => { if (oiShowLiveRef.current) redrawOI(); }, 120);
          // On initial load, hold skeleton for MIN_SKELETON_MS so everything settles before revealing
          const isFirst = firstLoadRef.current;
          if (isFirst) firstLoadRef.current = false;
          const elapsed = Date.now() - paintStart;
          const remaining = isFirst ? Math.max(0, MIN_SKELETON_MS - elapsed) : 0;
          setTimeout(() => {
            if (mySession !== sessionRef.current) return;
            setLoading(false);
          }, remaining);
        });
      } catch (err) {
        if (mySession !== sessionRef.current) return;
        restLoadingRef.current = false;
        setError(String(err));
        setLoading(false);
      }
    })();
    // chartReady ensures this fires after chart series are created on mount
  }, [instrument.instrument_key, interval, chartReady, zoomToEnd, redrawOI]);

  // ── WebSocket live candle feed ─────────────────────────────────────────────
  // Single subscription per instrument — interval is read via intervalRef (no re-sub on switch)
  useEffect(() => {
    if (restLoadedKey !== instrument.instrument_key) return; // Wait for REST
    const key = instrument.instrument_key;
    wsManager.requestKeys([key]);

    // ── Silent re-fetch at next bar boundary ──────────────────────────────
    // Once WS connects and first tick arrives, schedule a one-shot REST reload
    // at the start of the NEXT bar. This gives us the correct historical OHLC
    // for the bar we connected mid-way through, then WS continues on top.
    const scheduleBarRefetch = (mySession: number) => {
      if (barRefetchScheduledRef.current) return;
      barRefetchScheduledRef.current = true;

      const iv = intervalRef.current;
      const nowMs = Date.now();
      const intervalMs = iv.minutes * 60 * 1000;
      const wallBarMs = snapToBarTime(nowMs, iv.minutes) * 1000;
      const nextBarMs = wallBarMs + intervalMs;
      const msUntilNextBar = nextBarMs - nowMs;
      // Add a small buffer (500ms) so the bar is definitely closed by then
      const delay = msUntilNextBar + 500;

      barRefetchTimerRef.current = setTimeout(async () => {
        if (mySession !== sessionRef.current) return;
        // Pause WS updates during re-fetch
        restLoadingRef.current = true;

        try {
          const d = new Date(); d.setHours(23, 59, 59, 999);
          const from = d.getTime();
          const ivVal = intervalRef.current.value;

          const todayRes = await fetchCandles(key, ivVal, from);
          if (mySession !== sessionRef.current) { restLoadingRef.current = false; return; }

          let candles = todayRes.candles;
          let prev = todayRes.prevTimestamp;

          if (candles.length === 0 && prev) {
            const fallback = await fetchCandles(key, ivVal, prev);
            if (mySession !== sessionRef.current) { restLoadingRef.current = false; return; }
            candles = fallback.candles;
            prev = fallback.prevTimestamp;
          }

          let prevCandles: number[][] = [];
          let prevPrev: number | null = null;
          if (prev) {
            const prevRes = await fetchCandles(key, ivVal, prev);
            if (mySession !== sessionRef.current) { restLoadingRef.current = false; return; }
            prevCandles = prevRes.candles;
            prevPrev = prevRes.prevTimestamp;
          }

          const combined = [...prevCandles, ...candles];
          const sorted = [...combined].sort((a, b) => a[0] - b[0]);
          const unique = sorted.filter((c, i) => i === 0 || c[0] !== sorted[i - 1][0]);

          const cData = unique.map(toCandleRow);
          const vData = unique.map(toVolRow);
          prevTimestampRef.current = prevPrev;

          // Pop the current forming bar if REST already includes it
          const wallBarSec = snapToBarTime(Date.now(), intervalRef.current.minutes);
          const lastCandle = cData.length > 0 ? cData[cData.length - 1] : null;
          if (lastCandle && Number(lastCandle.time) === wallBarSec) {
            cData.pop();
            vData.pop();
          }

          allCandlesRef.current = cData;
          allVolRef.current = vData;

          candleSeriesRef.current?.setData(cData);
          volSeriesRef.current?.setData(vData);

          // Re-apply live bar on top
          if (liveBarRef.current) {
            try { candleSeriesRef.current?.update(liveBarRef.current); } catch { /* ignore */ }
          }
          if (liveVolRef.current) {
            try { volSeriesRef.current?.update(liveVolRef.current); } catch { /* ignore */ }
          }

        } catch (err) {
        } finally {
          if (mySession === sessionRef.current) restLoadingRef.current = false;
        }
      }, delay);
    };

    let logged = false;
    const mySession = sessionRef.current;
    const unsubscribe = wsManager.subscribe(key, (md) => {
      // Block while REST fetch in flight
      if (restLoadingRef.current) return;

      const candleSeries = candleSeriesRef.current;
      const volSeries = volSeriesRef.current;
      if (!candleSeries || !volSeries) return;

      const ltp = md.ltp ?? 0;
      if (!ltp) return;

      const iv = intervalRef.current;

      // ── Try to use OHLC from WS for current interval ────────────────────
      const ohlcEntry = md.ohlc?.find(o => o.interval === iv.value);
      const ohlcBarTimeSec = ohlcEntry && Number(ohlcEntry.ts) > 0
        ? Math.floor(Number(ohlcEntry.ts) / 1000)
        : null;

      // Wall-clock is always authoritative for which bar we are IN
      const wallBarTimeSec = snapToBarTime(Date.now(), iv.minutes);
      const barTimeSec = wallBarTimeSec as Time;

      // Only use ohlc data if its ts matches the current wall-clock bar
      const useOhlc = ohlcEntry != null && ohlcBarTimeSec != null
        && ohlcBarTimeSec === wallBarTimeSec;

      if (!logged) {
        logged = true;
        // Schedule a silent REST re-fetch at the next bar boundary
        scheduleBarRefetch(mySession);
      }

      // Don't push a live bar older than the last REST bar
      const lastRestTime = allCandlesRef.current.length > 0
        ? Number(allCandlesRef.current[allCandlesRef.current.length - 1].time)
        : 0;
      if (Number(barTimeSec) < lastRestTime) return;

      const prev = liveBarRef.current;

      if (prev && Number(prev.time) === Number(barTimeSec)) {
        // ── Same bar: update using ohlc if it matches current bar, else ltp ─
        const updated: CandlestickData = useOhlc
          ? {
            time: barTimeSec,
            open: ohlcEntry!.open || prev.open,
            high: ohlcEntry!.high || Math.max(prev.high, ltp),
            low: ohlcEntry!.low || Math.min(prev.low, ltp),
            close: ltp,
          }
          : {
            time: barTimeSec,
            open: prev.open,
            high: Math.max(prev.high, ltp),
            low: Math.min(prev.low, ltp),
            close: ltp,
          };
        liveBarRef.current = updated;
        try { candleSeries.update(updated); } catch { /* lwc guard */ }

        const vol = useOhlc ? Number(ohlcEntry!.vol) || 0 : (liveVolRef.current?.value ?? 0);
        const updatedVol: HistogramData = {
          time: barTimeSec,
          value: vol,
          color: ltp >= updated.open ? 'rgba(46,189,133,0.5)' : 'rgba(242,54,69,0.5)',
        };
        liveVolRef.current = updatedVol;
        try { volSeries.update(updatedVol); } catch { /* lwc guard */ }
        scheduleVwapUpdate();

      } else {
        // ── New bar: commit old live bar to history, start fresh ──────────
        if (prev) {
          const existingIdx = allCandlesRef.current.findIndex(
            c => Number(c.time) === Number(prev.time)
          );
          if (existingIdx >= 0) {
            allCandlesRef.current[existingIdx] = prev;
          } else {
            allCandlesRef.current = [...allCandlesRef.current, prev];
          }
          if (liveVolRef.current) {
            const vi = allVolRef.current.findIndex(
              v => Number(v.time) === Number(prev.time)
            );
            if (vi >= 0) allVolRef.current[vi] = liveVolRef.current;
            else allVolRef.current = [...allVolRef.current, liveVolRef.current];
          }
        }

        // Seed new bar from ohlc only if it matches current wall-clock bar
        const newOpen = useOhlc ? ohlcEntry!.open : (prev ? prev.close : ltp);
        const newBar: CandlestickData = useOhlc
          ? {
            time: barTimeSec,
            open: ohlcEntry!.open || newOpen,
            high: ohlcEntry!.high || Math.max(newOpen, ltp),
            low: ohlcEntry!.low || Math.min(newOpen, ltp),
            close: ltp,
          }
          : {
            time: barTimeSec,
            open: newOpen,
            high: Math.max(newOpen, ltp),
            low: Math.min(newOpen, ltp),
            close: ltp,
          };
        liveBarRef.current = newBar;
        try { candleSeries.update(newBar); } catch { /* lwc guard */ }

        const newVol: HistogramData = {
          time: barTimeSec,
          value: useOhlc ? Number(ohlcEntry!.vol) || 0 : 0,
          color: ltp >= newBar.open ? 'rgba(46,189,133,0.5)' : 'rgba(242,54,69,0.5)',
        };
        liveVolRef.current = newVol;
        try { volSeries.update(newVol); } catch { /* lwc guard */ }
        scheduleVwapUpdate();
      }

      setWsLive(true);

      // ── Pre-market capture (INDEX only, 08:59–09:07 IST) ────────────────
      if (instrument.instrument_type === 'INDEX') {
        const istTime = new Date().toLocaleString('en-US', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const [h, m] = istTime.split(':').map(Number);
        const minuteOfDay = h * 60 + m;
        // 08:59 = 539, 09:07 = 547
        if (minuteOfDay >= 539 && minuteOfDay <= 547) {
          const barSec = snapToBarTime(Date.now(), 1); // always store as 1-min ticks
          const existing = pmTicksRef.current.find(t => t[0] === barSec);
          if (existing) {
            existing[2] = Math.max(existing[2], ltp); // high
            existing[3] = Math.min(existing[3], ltp); // low
            existing[4] = ltp;                         // close
          } else {
            pmTicksRef.current.push([barSec, ltp, ltp, ltp, ltp, 0]);
          }
          // Debounced save — write to IndexedDB 2s after last tick
          if (pmSaveTimerRef.current) clearTimeout(pmSaveTimerRef.current);
          pmSaveTimerRef.current = setTimeout(() => {
            savePreMarketTicks(instrument.instrument_key, pmTicksRef.current).catch(() => { });
          }, 2000);
        }
      }
    });

    return () => {
      unsubscribe();
      setWsLive(false);
      if (barRefetchTimerRef.current) {
        clearTimeout(barRefetchTimerRef.current);
        barRefetchTimerRef.current = null;
      }
      if (pmSaveTimerRef.current) {
        clearTimeout(pmSaveTimerRef.current);
        // Flush any pending ticks immediately on unmount
        if (pmTicksRef.current.length > 0 && instrument.instrument_type === 'INDEX') {
          savePreMarketTicks(instrument.instrument_key, pmTicksRef.current).catch(() => { });
        }
      }
    };
  }, [instrument.instrument_key, instrument.instrument_type, restLoadedKey]);
  // interval NOT in deps — read via intervalRef so subscription stays alive across switches

  // ── Page visibility: release WS key when tab hidden, re-request when shown ──
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    const key = instrument.instrument_key;
    if (was && !visible) {
      wsManager.releaseKeys([key]);
    } else if (!was && visible) {
      wsManager.requestKeys([key]);
      // bump session so the existing WS subscribe useEffect re-runs
      sessionRef.current += 1;
    }
  }, [visible, instrument.instrument_key]);

  // ── Infinite scroll: load older candles ───────────────────────────────────
  const loadMore = useCallback(async () => {
    if (
      loadLockRef.current ||
      isLoadingMoreRef.current ||
      !prevTimestampRef.current ||
      !candleSeriesRef.current ||
      !volSeriesRef.current
    ) return;

    isLoadingMoreRef.current = true;
    loadLockRef.current = true;
    histLoadBarRef.current?.classList.add(s.histLoadBarVisible);
    requestAnimationFrame(() => setLoadingMore(true));

    const ts = chartRef.current?.timeScale();
    const logicalRange = ts?.getVisibleLogicalRange();
    const iv = intervalRef.current.value;

    try {
      const { candles, prevTimestamp } = await fetchCandles(
        instrument.instrument_key,
        iv,
        prevTimestampRef.current
      );
      prevTimestampRef.current = prevTimestamp;

      if (candles.length > 0) {
        const sortedOlder = [...candles].sort((a, b) => a[0] - b[0]);

        // Drop dupes within the page, and any timestamps already in the chart
        const existingTimes = new Set(allCandlesRef.current.map(c => Number(c.time) * 1000));
        const uniqueOlder = sortedOlder.filter((c, i) =>
          (i === 0 || c[0] !== sortedOlder[i - 1][0]) && !existingTimes.has(c[0])
        );

        if (uniqueOlder.length > 0) {
          const older = uniqueOlder.map(toCandleRow);
          const olderVol = uniqueOlder.map(toVolRow);
          allCandlesRef.current = [...older, ...allCandlesRef.current];
          allVolRef.current = [...olderVol, ...allVolRef.current];

          // Snapshot logical range BEFORE setData to restore viewport exactly
          const rangeBefore = ts?.getVisibleLogicalRange();

          candleSeriesRef.current!.setData(allCandlesRef.current);
          volSeriesRef.current!.setData(allVolRef.current);
          if (vwapSeriesRef.current) updateVwapData();
          if (twapSeriesRef.current) updateTwapData();

          // Re-apply live bar on top after full setData
          if (liveBarRef.current) {
            try { candleSeriesRef.current!.update(liveBarRef.current); } catch { /* ignore */ }
          }
          if (liveVolRef.current) {
            try { volSeriesRef.current!.update(liveVolRef.current); } catch { /* ignore */ }
          }

          // Restore viewport shifted by prepended bars — prevents flicker/jump
          if (ts && rangeBefore) {
            programmaticScrollRef.current = true;
            ts.setVisibleLogicalRange({
              from: rangeBefore.from + uniqueOlder.length,
              to:   rangeBefore.to   + uniqueOlder.length,
            });
            requestAnimationFrame(() => { programmaticScrollRef.current = false; });
          }
        }
      }
    } catch {
      // ignore
    } finally {
      isLoadingMoreRef.current = false;
      requestAnimationFrame(() => {
        histLoadBarRef.current?.classList.remove(s.histLoadBarVisible);
        setLoadingMore(false);
      });
      setTimeout(() => { loadLockRef.current = false; }, 400);
    }
  }, [instrument.instrument_key]);
  // interval NOT in deps — read via intervalRef

  // ── Trigger loadMore when user pans to left edge ───────────────────────────
  useEffect(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;

    const handler = (range: LogicalRange | null) => {
      if (!range) return;
      // Show "go to latest" button when user has scrolled left (barsAfter > 5)
      if (!programmaticScrollRef.current) {
        const barsInfo = candleSeriesRef.current?.barsInLogicalRange(range);
        setShowGoLatest(!!barsInfo && barsInfo.barsAfter > 5);
      }
      if (loadLockRef.current || !prevTimestampRef.current) return;
      const barsInfo = candleSeriesRef.current?.barsInLogicalRange(range);
      if (barsInfo && barsInfo.barsBefore < 20) {
        loadMore();
      }
    };

    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
  }, [loadMore]);

  // ── Drawing engine ─────────────────────────────────────────────────────────
  const drawing = useDrawingEngine({ chartRef, seriesRef: candleSeriesRef, wrapperRef, onDrawingsChange: onDrawingsChange });

  // Expose drawing engine to workspace toolbar via ref
  useEffect(() => {
    if (!drawingRef) return;
    drawingRef.current = {
      activeTool: drawing.activeTool,
      setActiveTool: drawing.setActiveTool,
      drawings: drawing.drawings,
      clearAll: drawing.clearAll,
      undo: drawing.undo,
      canUndo: drawing.canUndo,
    };
    return () => { if (drawingRef) drawingRef.current = null; };
  });

  return (
    <div className={`chart-mono flex flex-col h-full ${s.root}`}>
      {/* Toolbar — hidden in workspace mode */}
      {!hideToolbar && (
        <div className={s.toolbar}>

          {/* ── Symbol search container ── */}
          <button onClick={onSearchOpen} title="Search symbol" className={s.symbolBtn}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2.5" strokeLinecap="round" className={s.searchIcon}>
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <span className={s.symbolName}>{instrument.name || instrument.trading_symbol}</span>
          </button>

          {/* ── Separator ── */}
          <div className={s.tbSep} />

          {/* ── Timeframe inline buttons ── */}
          <TimeframeButtons interval={interval} onChange={iv => { setIntervalState(iv); onIntervalChange?.(iv.value); }} />

          {/* ── Separator ── */}
          <div className={s.tbSep} />

          {/* ── Status indicators ── */}
          {loading && (
            <span className={s.statusWrap}>
              <span className={s.spinner} />
              <span className={s.loadingLabel}>LOADING</span>
            </span>
          )}
          {loadingMore && (
            <span className={s.statusWrap}>
              <span className={s.spinnerHist} />
              <span className={s.histLabel}>HIST</span>
            </span>
          )}
          {error && (
            <span className={s.errLabel} title={error}>ERR</span>
          )}
          {!loading && wsLive && (
            <span className={s.statusWrap}>
              <span className={s.liveDot} />
              <span className={s.liveLabel}>LIVE</span>
            </span>
          )}

          {/* ── Right side ── */}
          <div className={s.rightGroup}>

            {/* Layout picker */}
            {onLayoutChange && activeLayout && (
              <LayoutButtonInline activeLayout={activeLayout as LayoutId} onLayoutChange={onLayoutChange} />
            )}

            {/* View switcher */}
            {onViewChange && (
              <ViewSwitcher onViewChange={onViewChange} />
            )}

            {/* ── VWAP / TWAP indicators ── */}
            <div className={s.tbSep} />

            {/* VWAP toggle */}
            <button
              ref={vwapBtnRef}
              onClick={() => setVwapShow(!vwapShow)}
              title="Toggle VWAP"
              className={cx(s.indicatorBtn, vwapShow ? s.indicatorBtnVwapOn : '')}
            >
              <span className={s.indicatorIcon}>
                {/* Volume-weighted line icon */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12 C6 6, 10 18, 14 10, 18 4, 21 8"/>
                  <path d="M3 20h18" strokeOpacity="0.3"/>
                </svg>
              </span>
              VWAP
            </button>

            {/* VWAP anchor picker — only when VWAP active */}
            {vwapShow && (
              <button
                onClick={() => setVwapSettingsOpen(o => !o)}
                title="VWAP Anchor"
                className={cx(s.anchorBtn, vwapSettingsOpen ? s.anchorBtnOpen : '')}
              >
                <span className={s.anchorLabel}>
                  {vwapAnchor === 'daily' ? 'D' : vwapAnchor === 'weekly' ? 'W' : vwapAnchor === 'monthly' ? 'M' : 'EX'}
                </span>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
            )}

            {/* TWAP toggle */}
            <button
              onClick={() => setTwapShow(!twapShow)}
              title="Toggle TWAP"
              className={cx(s.indicatorBtn, twapShow ? s.indicatorBtnTwapOn : '')}
            >
              <span className={s.indicatorIcon}>
                {/* Time-weighted straight line icon */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="14" x2="21" y2="10"/>
                  <path d="M3 20h18" strokeOpacity="0.3"/>
                </svg>
              </span>
              TWAP
            </button>

            {/* VWAP Settings Panel (portal) */}
            {vwapShow && vwapSettingsOpen && (
              <VwapSettingsPanel
                anchorRef={vwapBtnRef}
                panelRef={vwapSettingsPanelRef}
                anchor={vwapAnchor}
                onAnchor={setVwapAnchor}
                onClose={() => setVwapSettingsOpen(false)}
              />
            )}

            {/* OI Profile + OC Panel */}
            {hasOptions && (
              <>
                <div className={s.tbSep} />

                {/* OI Profile toggle */}
                <button
                  onClick={() => setOiShow(o => !o)}
                  title="Toggle OI profile overlay"
                  className={cx(s.indicatorBtn, oiShow ? s.indicatorBtnOiOn : '')}
                >
                  <span className={s.indicatorIcon}>
                    {/* OI profile — bar chart with call/put symmetry */}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="10" width="4" height="10" rx="1"/>
                      <rect x="10" y="4" width="4" height="16" rx="1"/>
                      <rect x="18" y="7" width="4" height="13" rx="1"/>
                    </svg>
                  </span>
                  OI Profile
                </button>

                {/* OI Settings — only when OI active */}
                {oiShow && (
                  <button
                    ref={oiSettingsBtnRef}
                    title="OI Profile Settings"
                    onClick={() => setOiSettingsOpen(o => !o)}
                    className={cx(s.settingsBtn, oiSettingsOpen ? s.settingsBtnOpen : '')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                )}

                {/* OC Panel toggle */}
                <button
                  onClick={() => setOptionChainOpen(o => !o)}
                  title="Open Option Chain"
                  className={cx(s.indicatorBtn, optionChainOpen ? s.indicatorBtnOcOn : '')}
                >
                  <span className={s.indicatorIcon}>
                    {/* Option chain — layered table icon */}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <line x1="12" y1="3" x2="12" y2="21"/>
                      <line x1="3" y1="9" x2="21" y2="9"/>
                      <line x1="3" y1="15" x2="21" y2="15"/>
                    </svg>
                  </span>
                  OC
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* OI Settings Modal — rendered outside toolbar so it works in hideToolbar mode too */}
      {oiShow && oiSettingsOpen && (
        <OISettingsModal
          anchorRef={oiSettingsAnchorRef ?? oiSettingsBtnRef}
          panelRef={oiSettingsPanelRef}
          mode={oiMode} onMode={setOiMode}
          callColor={oiCallColor} onCallColor={setOiCallColor}
          putColor={oiPutColor} onPutColor={setOiPutColor}
          opacity={oiOpacity} onOpacity={setOiOpacity}
          expiries={oiExpiries} selectedExpiry={oiExpiry} onExpiry={setOiExpiry}
          onClose={() => setOiSettingsOpen(false)}
        />
      )}

      {/* Chart + option chain side by side */}
      <div className="flex flex-1 min-h-0">
        {/* Chart container + OI canvas overlay */}
        <div ref={wrapperRef} className={`flex-1 min-w-0 ${s.chartWrapper}`}>
          <div ref={containerRef} data-chart-container className={s.chartContainer} />

          {/* Left-edge loading shimmer — toggled via DOM ref, no React re-render during scroll */}
          <div ref={histLoadBarRef} className={s.histLoadBar} aria-hidden="true">
            <div className={s.histLoadShimmer} />
          </div>

          {/* Skeleton bars — unmounted entirely when not loading (no DOM nodes = no animation CPU cost) */}
          {loading && (
            <div className={s.skeleton} aria-hidden="true">
              {Array.from({ length: 40 }, (_, i) => (
                <div
                  key={i}
                  className={s.skeletonBar}
                  style={{
                    height: `${20 + Math.abs(Math.sin(i * 0.7 + 1.2)) * 65}%`,
                    ['--sk-delay' as string]: `${(i * 0.035) % 1.4}s`,
                  }}
                />
              ))}
            </div>
          )}

          {/* OI canvas */}
          <canvas
            ref={canvasRef}
            className={s.oiCanvas}
            style={{ display: oiShow ? 'block' : 'none' }}
          />

          {/* Drawing canvas */}
          <canvas ref={drawing.canvasRef} className={s.drawingCanvas} />

          {/* Drawing interaction overlay */}
          <div
            ref={drawing.overlayRef}
            className={s.drawingOverlay}
            style={{ pointerEvents: drawing.isPassive ? 'none' : 'all', cursor: drawing.cursorStyle }}
          />

          {/* Go to latest button — bottom right, visible when scrolled away from right edge */}
          <div
            onClick={() => {
              programmaticScrollRef.current = true;
              chartRef.current?.timeScale().scrollToRealTime();
              requestAnimationFrame(() => { programmaticScrollRef.current = false; });
              setShowGoLatest(false);
            }}
            style={{
              position: 'absolute', bottom: 36, right: 12,
              width: 28, height: 28, borderRadius: 6,
              background: 'rgba(15,16,32,0.75)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              opacity: showGoLatest ? 1 : 0,
              pointerEvents: showGoLatest ? 'all' : 'none',
              transition: 'opacity 0.18s ease',
              zIndex: 20,
            }}
            title="Go to latest"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M4.5 2L9.5 7L4.5 12" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M8.5 2L13.5 7L8.5 12" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.45"/>
            </svg>
          </div>

          {/* OHLC crosshair header overlay */}
          {(() => {
            // Use crosshair data when hovering, otherwise fall back to latest candle
            const lastCandle = liveBarRef.current ?? (allCandlesRef.current.length > 0 ? allCandlesRef.current[allCandlesRef.current.length - 1] : null);
            const raw = crosshairOHLC ?? (lastCandle ? { open: lastCandle.open, high: lastCandle.high, low: lastCandle.low, close: lastCandle.close, change: lastCandle.close - lastCandle.open, changePct: lastCandle.open > 0 ? ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100 : 0 } : null);
            const d = raw;
            const changeColor = d ? (d.change >= 0 ? '#2ebd85' : '#f23645') : '#D1D4DC';
            const symbolName = instrument.name || instrument.trading_symbol;
            const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return (
              <div className={s.ohlcOverlay}>
                {/* Symbol · interval · exchange */}
                <span className={s.ohlcSymbol}>
                  {symbolName}
                  <span className={s.ohlcMeta}>· {interval.label} · NSE</span>
                </span>
                {/* Live dot */}
                {wsLive && <span className={s.ohlcLiveDot} />}
                {/* OHLC values */}
                {d && (
                  <span className={s.ohlcValues}>
                    <span><span className={s.ohlcLabel}>O</span><span className={s.ohlcValueNeutral}>{fmt(d.open)}</span></span>
                    <span><span className={s.ohlcLabel}>H</span><span className={s.ohlcHigh}>{fmt(d.high)}</span></span>
                    <span><span className={s.ohlcLabel}>L</span><span className={s.ohlcLow}>{fmt(d.low)}</span></span>
                    <span><span className={s.ohlcLabel}>C</span><span className={s.ohlcValueNeutral}>{fmt(d.close)}</span></span>
                    <span style={{ color: changeColor, fontWeight: 600 }}>
                      {d.change >= 0 ? '+' : ''}{fmt(d.change)}<span className={s.ohlcChangePct}> ({d.changePct >= 0 ? '+' : ''}{d.changePct.toFixed(2)}%)</span>
                    </span>
                  </span>
                )}
              </div>
            );
          })()}

          {/* OI Hover Tooltip */}
          {oiShow && oiTooltip.visible && (() => {
            const tipW = 170;
            const left = Math.max(4, oiTooltip.x - tipW - 12);
            const top = Math.max(4, oiTooltip.y - 60);
            // Always read live values from ref, not stale state
            const liveRow = oiRowsRef.current.find(r => r.strike === oiTooltip.strike);
            const isGexMode = oiMode === 'gex_raw' || oiMode === 'gex_spot';
            let callVal = 0, putVal = 0, modeLabel = 'OI', ratioLabel = 'PCR';
            let callColor = oiCallColor, putColor = oiPutColor;
            let fmtVal: (v: number) => string = fmtOI;
            if (isGexMode) {
              const multiplier = (oiMode === 'gex_spot' && oiSpotRef.current > 0) ? oiSpotRef.current * oiSpotRef.current : 1;
              callVal = liveRow ? liveRow.callGamma * liveRow.callOI * liveRow.lotSize * multiplier : 0;
              putVal = liveRow ? liveRow.putGamma * liveRow.putOI * liveRow.lotSize * multiplier : 0;
              modeLabel = 'GEX'; ratioLabel = 'NET GEX';
              callColor = '#818cf8'; putColor = '#ff9800';
              fmtVal = (v: number) => {
                if (v === 0) return '—';
                const abs = Math.abs(v);
                if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
                if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
                if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'K';
                return v.toFixed(2);
              };
            } else if (oiMode === 'dex') {
              callVal = liveRow ? Math.abs(liveRow.callDelta) * liveRow.callOI * liveRow.lotSize : 0;
              putVal  = liveRow ? Math.abs(liveRow.putDelta)  * liveRow.putOI  * liveRow.lotSize : 0;
              modeLabel = 'DEX'; ratioLabel = 'NET DEX';
              callColor = '#38d4c8'; putColor = '#f87171';
              fmtVal = (v: number) => {
                if (v === 0) return '—';
                const abs = Math.abs(v);
                if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
                if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
                if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'K';
                return v.toFixed(2);
              };
            } else if (oiMode === 'iv') {
              callVal = liveRow?.callIV ?? 0;
              putVal = liveRow?.putIV ?? 0;
              modeLabel = 'IV'; ratioLabel = 'PE/CE IV';
              fmtVal = (v: number) => v > 0 ? v.toFixed(2) + '%' : '—';
            } else if (oiMode === 'volume') {
              callVal = liveRow?.callVol ?? 0;
              putVal = liveRow?.putVol ?? 0;
              modeLabel = 'VOL'; ratioLabel = 'P/C VOL';
            } else {
              callVal = liveRow?.callOI ?? 0;
              putVal = liveRow?.putOI ?? 0;
            }
            const ratio = (isGexMode || oiMode === 'dex')
              ? fmtVal(callVal - putVal)
              : callVal > 0 ? (putVal / callVal).toFixed(2) : '—';
            return (
              <div className={s.oiTooltip} style={{ left, top }}>
                <div className={s.oiTooltipLabel}>STRIKE</div>
                <div className={s.oiTooltipStrike}>{oiTooltip.strike.toLocaleString('en-IN')}</div>
                <div className={s.oiTooltipDivider} />
                <div className={s.oiTooltipRow}>
                  <span className={s.oiTooltipRowKey}>Call {modeLabel}</span>
                  <span className={s.oiTooltipRowVal} style={{ color: callColor }}>{fmtVal(callVal)}</span>
                </div>
                <div className={s.oiTooltipRow}>
                  <span className={s.oiTooltipRowKey}>Put {modeLabel}</span>
                  <span className={s.oiTooltipRowVal} style={{ color: putColor }}>{fmtVal(putVal)}</span>
                </div>
                <div className={s.oiTooltipDivider} />
                <div className={s.oiTooltipRowLast}>
                  <span className={s.oiTooltipRowKey}>{ratioLabel}</span>
                  <span className={cx(s.oiTooltipRowVal, s.oiTooltipNeutral)}>{ratio}</span>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Option chain panel — tab button floats on left edge */}
        {hasOptions && (
          <div className={s.ocTabContainer}>
            {/* Tab button — sticks out from the left edge of the panel */}
            <button
              onClick={() => setOptionChainOpen(o => !o)}
              title="Toggle option chain"
              className={cx(s.ocTabBtn, optionChainOpen ? s.ocTabBtnOpen : '')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20"/>
                <path d="M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4"/>
                <path d="M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4"/>
                <path d="M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1"/>
                <path d="M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1"/>
              </svg>
            </button>

            {/* Panel — mounted one rAF after open so click never blocks chart frame */}
            {ocPanelMounted && (
              <OptionChainPanel
                instrument={instrument}
                instruments={instruments}
                open={optionChainOpen}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
