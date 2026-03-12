'use client';

/**
 * OIProfileView — 3-panel OI Profile layout
 *
 * Layout: 2 panels top row, 1 panel bottom row
 * Each panel is a fully self-contained OIProfilePanel with its own
 * instrument/expiry selector, OI table, and TradingView chart + canvas overlay.
 *
 * Defaults: NIFTY (top-left), BANKNIFTY (top-right), SENSEX (bottom)
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useDeferredValue,
} from 'react';
import { createPortal } from 'react-dom';
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
import type { Instrument } from './useInstruments';
import { wsManager } from './lib/WebSocketManager';
import { fmtGex } from './lib/GexService';
import type { StrikeSpec } from './lib/GexService';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OIRow {
  strike: number;
  callOI: number;
  putOI: number;
  callGamma: number;
  putGamma: number;
  lotSize: number;
  callKey: string;
  putKey: string;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  strike: number;
  callOI: number;
  putOI: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instrument helpers
// ─────────────────────────────────────────────────────────────────────────────

function getUnderlyings(instruments: Instrument[]) {
  const set = new Set<string>();
  for (const ins of instruments)
    if ((ins.instrument_type === 'CE' || ins.instrument_type === 'PE') && ins.underlying_symbol)
      set.add(ins.underlying_symbol);
  return Array.from(set).sort();
}

function getExpiries(instruments: Instrument[], underlying: string) {
  const set = new Set<number>();
  for (const ins of instruments)
    if (ins.underlying_symbol === underlying && ins.expiry) set.add(ins.expiry);
  return Array.from(set).sort((a, b) => a - b);
}

function getStrikes(instruments: Instrument[], underlying: string, expiry: number) {
  const set = new Set<number>();
  for (const ins of instruments)
    if (ins.underlying_symbol === underlying && ins.expiry === expiry && ins.strike_price != null)
      set.add(ins.strike_price);
  return Array.from(set).sort((a, b) => a - b);
}

function findKey(instruments: Instrument[], underlying: string, expiry: number, strike: number, type: 'CE' | 'PE') {
  return instruments.find(
    i => i.underlying_symbol === underlying && i.expiry === expiry && i.strike_price === strike && i.instrument_type === type,
  )?.instrument_key ?? null;
}

function findUnderlyingKey(instruments: Instrument[], underlying: string) {
  return instruments.find(
    i => i.trading_symbol === underlying && (i.instrument_type === 'EQ' || i.instrument_type === 'INDEX' || i.exchange === 'NSE_INDEX'),
  )?.instrument_key
    ?? instruments.find(i => i.trading_symbol === underlying)?.instrument_key
    ?? null;
}

function fmtExpiry(ms: number) {
  return new Date(ms).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

function fmtOI(n: number) {
  if (n === 0) return '—';
  if (n >= 1_00_00_000) return (n / 1_00_00_000).toFixed(2) + ' Cr';
  if (n >= 1_00_000)    return (n / 1_00_000).toFixed(2) + ' L';
  if (n >= 1_000)       return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Candle fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCandles(instrumentKey: string, interval: string, from: number) {
  const params = new URLSearchParams({
    instrumentKey,
    interval,
    from: String(from),
    limit: '500',
  });
  const res = await fetch(`/api/public-candles?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return {
    candles: (json?.data?.candles ?? []) as number[][],
    prevTimestamp: (json?.data?.meta?.prevTimestamp ?? null) as number | null,
  };
}

function toCandleRow(c: number[]): CandlestickData {
  return { time: Math.floor(c[0] / 1000) as Time, open: c[1], high: c[2], low: c[3], close: c[4] };
}
function toVolRow(c: number[]): HistogramData {
  return {
    time: Math.floor(c[0] / 1000) as Time,
    value: c[5],
    color: c[4] >= c[1] ? 'rgba(46,189,133,0.4)' : 'rgba(242,54,69,0.4)',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small reusable select
// ─────────────────────────────────────────────────────────────────────────────

function GlassSelect({
  value, options, onChange, formatLabel, disabled, placeholder, minWidth = 110,
}: {
  value: string | number | null;
  options: (string | number)[];
  onChange: (v: string | number) => void;
  formatLabel?: (v: string | number) => string;
  disabled?: boolean;
  placeholder?: string;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node)) {
        setOpen(false); setSearch('');
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const isDisabled = disabled || options.length === 0;
  const displayLabel = value != null ? (formatLabel ? formatLabel(value) : String(value)) : null;
  const filtered = options.filter(o => {
    if (!search) return true;
    const lbl = formatLabel ? formatLabel(o) : String(o);
    return lbl.toLowerCase().includes(search.toLowerCase());
  });

  const handleOpen = () => {
    if (isDisabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  return (
    <div style={{ flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        style={{
          minWidth, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 8px', cursor: isDisabled ? 'not-allowed' : 'pointer', gap: 4,
          border: '1px solid rgba(255,255,255,0.12)', background: open ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
          borderRadius: 6, opacity: isDisabled ? 0.4 : 1, boxSizing: 'border-box', userSelect: 'none',
          color: displayLabel ? '#D1D4DC' : '#52525b', fontSize: 12, fontWeight: 600,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>
          {displayLabel ?? (placeholder ?? 'Select…')}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
          <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div ref={dropRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 99999,
          background: 'rgba(19,23,34,0.97)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,0.8)',
          minWidth: Math.max(minWidth, 160), overflow: 'hidden',
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '5px 8px',
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: 5, outline: 'none', fontSize: 12, color: '#D1D4DC',
              }}
            />
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto', padding: '4px 0' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '10px 12px', fontSize: 11, color: '#52525b', textAlign: 'center' }}>No matches</div>
            )}
            {filtered.map(o => {
              const lbl = formatLabel ? formatLabel(o) : String(o);
              const isActive = String(o) === String(value);
              return (
                <div key={String(o)}
                  onMouseDown={(e: React.MouseEvent) => {
                    e.preventDefault();
                    const first = options[0];
                    onChange(typeof first === 'number' ? Number(o) : o);
                    setOpen(false); setSearch('');
                  }}
                  className="oi-select-option"
                  style={{
                    padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                    color: isActive ? '#FF9800' : '#D1D4DC',
                    background: isActive ? 'rgba(255,152,0,0.08)' : undefined,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}
                >
                  <span>{lbl}</span>
                  {isActive && <span style={{ fontSize: 10, color: '#FF9800' }}>✓</span>}
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas OI Profile overlay
// ─────────────────────────────────────────────────────────────────────────────

const BAR_H   = 9;
const BAR_GAP = 1;
const BAR_FILL_RATIO = 0.22;

function drawOIProfile(
  canvas: HTMLCanvasElement,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  oiRows: OIRow[],
  hoveredStrike: number | null,
  viewMode: 'oi' | 'gex',
  gexMode: 'raw' | 'spot',
  spot: number,
  barFillRatio: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.width  / dpr;
  const cssH = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (oiRows.length === 0) return;

  const priceScaleW   = chart.priceScale('right').width();
  const anchor        = cssW - priceScaleW;
  const BAR_MAX_WIDTH = anchor * barFillRatio;

  if (viewMode === 'oi') {
    const maxOI = Math.max(...oiRows.flatMap(r => [r.callOI, r.putOI]), 1);
    for (const row of oiRows) {
      const yCenter = series.priceToCoordinate(row.strike);
      if (yCenter == null) continue;
      const callW     = (row.callOI / maxOI) * BAR_MAX_WIDTH;
      const putW      = (row.putOI  / maxOI) * BAR_MAX_WIDTH;
      const isHovered = hoveredStrike === row.strike;
      if (callW > 0) {
        ctx.fillStyle = isHovered ? 'rgba(242,54,69,0.95)' : 'rgba(242,54,69,0.75)';
        ctx.fillRect(anchor - callW, yCenter - BAR_H - BAR_GAP / 2, callW, BAR_H);
      }
      if (putW > 0) {
        ctx.fillStyle = isHovered ? 'rgba(46,189,133,0.95)' : 'rgba(46,189,133,0.75)';
        ctx.fillRect(anchor - putW, yCenter + BAR_GAP / 2, putW, BAR_H);
      }
      if (isHovered) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, yCenter); ctx.lineTo(anchor, yCenter); ctx.stroke();
        ctx.restore();
      }
    }
  } else {
    const multiplier = (gexMode === 'spot' && spot > 0) ? spot * spot : 1;
    const gexRows = oiRows.map(row => ({
      strike:  row.strike,
      callGex:  row.callGamma * row.callOI * row.lotSize * multiplier,
      putGex:  -row.putGamma  * row.putOI  * row.lotSize * multiplier,
    }));
    const maxAbsGex = Math.max(...gexRows.flatMap(g => [Math.abs(g.callGex), Math.abs(g.putGex)]), 1);

    for (let i = 0; i < oiRows.length; i++) {
      const row     = oiRows[i];
      const gex     = gexRows[i];
      const yCenter = series.priceToCoordinate(row.strike);
      if (yCenter == null) continue;
      const isHovered = hoveredStrike === row.strike;

      const callW = (Math.abs(gex.callGex) / maxAbsGex) * BAR_MAX_WIDTH;
      const putW  = (Math.abs(gex.putGex)  / maxAbsGex) * BAR_MAX_WIDTH;

      if (callW > 0) {
        ctx.fillStyle = isHovered ? 'rgba(129,140,248,0.95)' : 'rgba(129,140,248,0.75)';
        ctx.fillRect(anchor - callW, yCenter - BAR_H - BAR_GAP / 2, callW, BAR_H);
      }
      if (putW > 0) {
        ctx.fillStyle = isHovered ? 'rgba(255,152,0,0.95)' : 'rgba(255,152,0,0.75)';
        ctx.fillRect(anchor - putW, yCenter + BAR_GAP / 2, putW, BAR_H);
      }
      if (isHovered) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, yCenter); ctx.lineTo(anchor, yCenter); ctx.stroke();
        ctx.restore();
      }
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Live candle helpers (mirrors CandleChart.tsx)
// ─────────────────────────────────────────────────────────────────────────────

// IST-aligned bar boundary snap (UTC+5:30 = 19800s)
const IST_OFFSET_SEC = 19800;

/** Returns true if current IST time is within market hours (09:15 – 15:30) */
function isMarketOpen(): boolean {
  const now    = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes()) + 330; // IST minutes since midnight
  const istDay = new Date(now.getTime() + 330 * 60_000).getUTCDay();   // 0=Sun 6=Sat in IST
  if (istDay === 0 || istDay === 6) return false;
  return istMin >= 555 && istMin < 930; // 09:15 = 555, 15:30 = 930
}

function snapToBarTime(tsMs: number, intervalMinutes: number): number {
  const intervalSec = intervalMinutes * 60;
  const nowSec = Math.floor(tsMs / 1000);
  return Math.floor((nowSec + IST_OFFSET_SEC) / intervalSec) * intervalSec - IST_OFFSET_SEC;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATM IV helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert underlying + expiry ms → "SYMBOL_YYYYMMDD" for Nubra CHAIN query */
function toNubraChainValue(underlying: string, expiryMs: number): string {
  const d = new Date(expiryMs);
  const yyyy = d.toLocaleString('en-IN', { year: 'numeric', timeZone: 'Asia/Kolkata' });
  const mm   = d.toLocaleString('en-IN', { month: '2-digit', timeZone: 'Asia/Kolkata' });
  const dd   = d.toLocaleString('en-IN', { day: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${underlying}_${yyyy}${mm}${dd}`;
}

/** NSE indices / stocks → "NSE", BSE indices → "BSE" */
function nubraExchange(underlying: string, instruments: Instrument[]): 'NSE' | 'BSE' {
  const ins = instruments.find(i => i.underlying_symbol === underlying || i.trading_symbol === underlying);
  if (ins?.exchange === 'BSE' || ins?.exchange === 'BSE_INDEX' || ins?.segment === 'BSE_INDEX') return 'BSE';
  return 'NSE';
}

/** Build date range: startDate (YYYY-MM-DD) 09:15 IST → now */
function buildIstRange(startDateStr: string) {
  return {
    startDate: `${startDateStr}T03:45:00.000Z`, // 09:15 IST = 03:45 UTC
    endDate:   new Date().toISOString(),
  };
}

/** Returns YYYY-MM-DD string for a Date in IST */
function toIstDateStr(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const yyyy = ist.getUTCFullYear();
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Go back N business days from date (skip Sat/Sun) */
function subBusinessDays(d: Date, n: number): Date {
  const r = new Date(d);
  let remaining = n;
  while (remaining > 0) {
    r.setDate(r.getDate() - 1);
    const dow = r.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return r;
}

interface AtmIvPoint { ts: number; v: number; }

async function fetchAtmIv(
  underlying: string,
  expiryMs: number,
  exchange: 'NSE' | 'BSE',
  rawCookie: string,
  intervalMinutes: number,
  startDateStr: string,
): Promise<AtmIvPoint[]> {
  const chainValue = toNubraChainValue(underlying, expiryMs);
  const { startDate, endDate } = buildIstRange(startDateStr);
  const nubraInterval = `${intervalMinutes}m`;

  const query = [
    {
      exchange,
      type: 'CHAIN',
      values: [chainValue],
      fields: ['atm_iv'],
      interval: nubraInterval,
      intraDay: false,
      realTime: false,
      startDate,
      endDate,
    },
  ];

  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawCookie, chart: 'ATM_Volatility_vs_Spot', query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  // Navigate: result[0].values[0][chainValue].atm_iv → [{ts, v}]
  const pts: AtmIvPoint[] =
    json?.result?.[0]?.values?.[0]?.[chainValue]?.atm_iv ?? [];
  return pts;
}

function getStrikeInterval(underlying: string): number {
  if (underlying.includes('BANKNIFTY') || underlying.includes('Nifty Bank')) return 100;
  if (underlying.includes('FINNIFTY')  || underlying.includes('Nifty Fin'))  return 50;
  if (underlying.includes('SENSEX'))                                          return 100;
  return 50;
}

function calculateATMStrike(spotPrice: number, strikeInterval: number): number {
  if (spotPrice <= 0 || strikeInterval <= 0) return 0;
  const remainder      = spotPrice % strikeInterval;
  const adjustedStrike = spotPrice - remainder;
  return remainder > strikeInterval / 2 ? adjustedStrike + strikeInterval : adjustedStrike;
}


// ─────────────────────────────────────────────────────────────────────────────
// IvDateInput — inline calendar picker dropdown (portalled)
// ─────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function IvDateInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Parse value "YYYY-MM-DD"
  const [selYear, selMonth, selDay] = value.split('-').map(Number);
  const [viewYear, setViewYear] = useState(selYear);
  const [viewMonth, setViewMonth] = useState(selMonth - 1); // 0-indexed

  // Sync view when value changes externally
  useEffect(() => {
    const [y, m] = value.split('-').map(Number);
    setViewYear(y); setViewMonth(m - 1);
  }, [value]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  const today = toIstDateStr(new Date());
  const [todayY, todayM, todayD] = today.split('-').map(Number);

  // Build calendar days grid
  const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };

  const selectDay = (d: number) => {
    const mm = String(viewMonth + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const v = `${viewYear}-${mm}-${dd}`;
    if (v <= today) { onCommit(v); setOpen(false); }
  };

  // Format display label
  const displayDate = `${String(selDay).padStart(2,'0')} ${MONTH_NAMES[selMonth-1]} ${selYear}`;

  return (
    <div style={{ flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        style={{
          height: 26, display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '0 8px', cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box',
          border: '1px solid rgba(255,255,255,0.12)',
          background: open ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
          borderRadius: 6, color: '#D1D4DC', fontSize: 11, fontWeight: 600,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5, flexShrink: 0 }}>
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span>{displayDate}</span>
      </button>

      {open && createPortal(
        <div ref={dropRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 99999,
          background: 'rgba(19,23,34,0.97)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 10, boxShadow: '0 16px 48px rgba(0,0,0,0.8)',
          width: 230, padding: '12px 10px', userSelect: 'none',
        }}>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, padding: '0 2px' }}>
            <button type="button" onClick={prevMonth} style={{ background: 'none', border: 'none', color: '#787B86', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontSize: 14 }}>‹</button>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#D1D4DC' }}>{MONTH_NAMES[viewMonth]} {viewYear}</span>
            <button type="button" onClick={nextMonth}
              disabled={viewYear > todayY || (viewYear === todayY && viewMonth >= todayM - 1)}
              style={{ background: 'none', border: 'none', cursor: (viewYear > todayY || (viewYear === todayY && viewMonth >= todayM - 1)) ? 'not-allowed' : 'pointer', color: (viewYear > todayY || (viewYear === todayY && viewMonth >= todayM - 1)) ? '#3a3a3a' : '#787B86', padding: '2px 6px', borderRadius: 4, fontSize: 14 }}>›</button>
          </div>

          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 4 }}>
            {DAY_NAMES.map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: '#52525b', padding: '2px 0' }}>{d}</div>
            ))}
          </div>

          {/* Day cells */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
            {cells.map((d, i) => {
              if (!d) return <div key={i} />;
              const mm = String(viewMonth + 1).padStart(2, '0');
              const dd = String(d).padStart(2, '0');
              const cellDate = `${viewYear}-${mm}-${dd}`;
              const isFuture = cellDate > today;
              const isSelected = d === selDay && viewMonth === selMonth - 1 && viewYear === selYear;
              const isToday = d === todayD && viewMonth === todayM - 1 && viewYear === todayY;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={isFuture}
                  onClick={() => selectDay(d)}
                  style={{
                    height: 28, width: '100%', border: 'none', cursor: isFuture ? 'not-allowed' : 'pointer',
                    borderRadius: 6, fontSize: 11, fontWeight: isSelected ? 700 : 500,
                    background: isSelected ? '#FF9800' : isToday ? 'rgba(255,152,0,0.12)' : 'transparent',
                    color: isSelected ? '#000' : isFuture ? '#2e2e2e' : isToday ? '#FF9800' : '#D1D4DC',
                    outline: 'none',
                  }}
                >{d}</button>
              );
            })}
          </div>

          {/* Today shortcut */}
          <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 8, textAlign: 'center' }}>
            <button type="button" onClick={() => { onCommit(today); setOpen(false); }} style={{
              background: 'none', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 5,
              color: '#787B86', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: '3px 14px',
            }}>Today</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OIProfilePanel — self-contained single panel
// ─────────────────────────────────────────────────────────────────────────────

const INTERVALS = [
  { label: '1m',  value: 'I1',  minutes: 1  },
  { label: '5m',  value: 'I5',  minutes: 5  },
  { label: '15m', value: 'I15', minutes: 15 },
  { label: '30m', value: 'I30', minutes: 30 },
];

type IntervalDef = { label: string; value: string; minutes: number };

// Each option in the view-mode dropdown
const VIEW_OPTIONS: { label: string; sub?: string; viewMode: 'oi' | 'gex'; gexMode?: 'raw' | 'spot' }[] = [
  { label: 'OI',       sub: 'Open Interest',          viewMode: 'oi'  },
  { label: 'GEX Raw',  sub: 'γ · OI · Lot',           viewMode: 'gex', gexMode: 'raw'  },
  { label: 'GEX Spot', sub: 'γ · OI · Lot · S²',      viewMode: 'gex', gexMode: 'spot' },
];

function ViewModeDropdown({
  viewMode, gexMode, onViewMode, onGexMode,
}: {
  viewMode: 'oi' | 'gex';
  gexMode: 'raw' | 'spot';
  onViewMode: (m: 'oi' | 'gex') => void;
  onGexMode: (m: 'raw' | 'spot') => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  const activeOpt = VIEW_OPTIONS.find(o =>
    o.viewMode === viewMode && (o.viewMode === 'oi' || o.gexMode === gexMode)
  ) ?? VIEW_OPTIONS[0];

  return (
    <div style={{ padding: '0 6px', flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        style={{
          height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 8px', gap: 4, cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box',
          border: '1px solid rgba(255,255,255,0.12)',
          background: open ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
          borderRadius: 6, color: '#D1D4DC', fontSize: 12, fontWeight: 600, minWidth: 72,
        }}
      >
        <span>{activeOpt.label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
          <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div ref={dropRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 99999,
          background: 'rgba(19,23,34,0.97)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,0.8)',
          minWidth: 160, padding: '4px 0', overflow: 'hidden',
        }}>
          {VIEW_OPTIONS.map(opt => {
            const isActive = opt.viewMode === viewMode && (opt.viewMode === 'oi' || opt.gexMode === gexMode);
            return (
              <div
                key={opt.label}
                onMouseDown={(e: React.MouseEvent) => {
                  e.preventDefault();
                  onViewMode(opt.viewMode);
                  if (opt.gexMode) onGexMode(opt.gexMode);
                  setOpen(false);
                }}
                className="oi-select-option"
                style={{
                  padding: '7px 14px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                  background: isActive ? 'rgba(255,152,0,0.08)' : undefined,
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: isActive ? '#FF9800' : '#D1D4DC' }}>{opt.label}</div>
                  {opt.sub && <div style={{ fontSize: 10, color: '#52525b', marginTop: 1 }}>{opt.sub}</div>}
                </div>
                {isActive && <span style={{ fontSize: 10, color: '#FF9800' }}>✓</span>}
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

function IntervalDropdown({ value, onChange }: { value: IntervalDef; onChange: (v: IntervalDef) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  return (
    <div style={{ padding: '0 6px', flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        style={{
          height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 8px', gap: 4, cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box',
          border: '1px solid rgba(255,255,255,0.12)',
          background: open ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
          borderRadius: 6, color: '#D1D4DC', fontSize: 12, fontWeight: 600, minWidth: 64,
        }}
      >
        <span>{value.label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
          <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div ref={dropRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 99999,
          background: 'rgba(19,23,34,0.97)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,0.8)',
          minWidth: 120, padding: '4px 0', overflow: 'hidden',
        }}>
          {INTERVALS.map(iv => {
            const isActive = iv.value === value.value;
            return (
              <div
                key={iv.value}
                onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); onChange(iv); setOpen(false); }}
                className="oi-select-option"
                style={{
                  padding: '7px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  color: isActive ? '#FF9800' : '#D1D4DC',
                  background: isActive ? 'rgba(255,152,0,0.08)' : undefined,
                }}
              >
                <span>{iv.label}</span>
                {isActive && <span style={{ fontSize: 10, color: '#FF9800' }}>✓</span>}
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

interface PanelProps {
  instruments: Instrument[];
  underlyings: string[];
  defaultUnderlying?: string;
  barFillRatio?: number;
}

function OIProfilePanel({ instruments, underlyings, defaultUnderlying = '', barFillRatio = BAR_FILL_RATIO }: PanelProps) {
  // ── Controls ──────────────────────────────────────────────────────────────
  const [underlying, setUnderlying] = useState(defaultUnderlying);
  const [expiry, setExpiry]         = useState<number | null>(null);
  const deferredExpiry              = useDeferredValue(expiry);
  const [interval, setInterval]     = useState<IntervalDef>(INTERVALS[1]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [wsLive, setWsLive]         = useState(false);
  const [ivStartDate, setIvStartDate] = useState<string>(() => toIstDateStr(subBusinessDays(new Date(), 2)));
  const [tableCollapsed, setTableCollapsed] = useState(false);

  const expiries = useMemo(() => underlying ? getExpiries(instruments, underlying) : [], [instruments, underlying]);

  // Auto-select nearest expiry when underlying changes
  useEffect(() => {
    if (expiries.length > 0) setExpiry(expiries[0]);
    else setExpiry(null);
  }, [underlying, expiries.length]);

  // ── View mode ─────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'oi' | 'gex'>('oi');
  const viewModeRef = useRef<'oi' | 'gex'>('oi');
  viewModeRef.current = viewMode;

  const [gexMode, setGexMode] = useState<'raw' | 'spot'>('spot');
  const gexModeRef = useRef<'raw' | 'spot'>('spot');
  gexModeRef.current = gexMode;

  // ── Refs ──────────────────────────────────────────────────────────────────
  const barFillRatioRef = useRef(barFillRatio);
  barFillRatioRef.current = barFillRatio;
  const spotKeyRef      = useRef<string | null>(null);
  const strikeSpecsRef  = useRef<StrikeSpec[]>([]);
  const [oiRows, setOiRows] = useState<OIRow[]>([]);
  const oiRowsRef       = useRef<OIRow[]>([]);

  const wrapperRef      = useRef<HTMLDivElement>(null);
  const chartDivRef     = useRef<HTMLDivElement>(null);
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const chartRef        = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeriesRef    = useRef<ISeriesApi<'Histogram'> | null>(null);
  const atmIvSeriesRef  = useRef<ISeriesApi<'Line'> | null>(null);

  // Live bar refs — same pattern as CandleChart.tsx
  const liveBarRef             = useRef<CandlestickData | null>(null);
  const liveVolRef             = useRef<HistogramData | null>(null);
  const restLoadingRef         = useRef(false);
  const sessionRef             = useRef(0);
  const barRefetchTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barRefetchScheduledRef = useRef(false);
  const allCandlesRef          = useRef<CandlestickData[]>([]);
  const allVolRef              = useRef<HistogramData[]>([]);
  // Stable interval ref — WS callback reads this without re-subscription
  const intervalRef = useRef<IntervalDef>(INTERVALS[1]);
  intervalRef.current = interval;

  // ATM IV live bar refs
  const liveAtmIvBarRef     = useRef<LineData | null>(null);
  const currentAtmStrikeRef = useRef<number>(0);
  const atmIvSubsRef        = useRef<{ callUnsub: () => void; putUnsub: () => void } | null>(null);
  // Cached history for delta-load (prepend only what's missing)
  const atmIvHistoryRef     = useRef<LineData[]>([]);

  const [tooltip, setTooltip] = useState<TooltipState>({ visible: false, x: 0, y: 0, strike: 0, callOI: 0, putOI: 0 });
  const hoveredStrikeRef      = useRef<number | null>(null);

  // ── Redraw canvas ─────────────────────────────────────────────────────────
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const chart  = chartRef.current;
    const series = candleSeriesRef.current;
    if (!canvas || !chart || !series) return;
    const spot = spotKeyRef.current ? (wsManager.get(spotKeyRef.current)?.ltp ?? 0) : 0;
    drawOIProfile(canvas, chart, series, oiRowsRef.current, hoveredStrikeRef.current, viewModeRef.current, gexModeRef.current, spot, barFillRatioRef.current);
  }, []);

  // ── 1. Build OI rows + WS subscriptions ──────────────────────────────────
  useEffect(() => {
    if (!underlying || !deferredExpiry) { setOiRows([]); oiRowsRef.current = []; return; }

    const strikes = getStrikes(instruments, underlying, deferredExpiry);
    const rows: OIRow[] = [];
    const keysToSubscribe: string[] = [];

    const sampleInstrument = instruments.find(
      i => i.underlying_symbol === underlying && i.expiry === deferredExpiry && i.instrument_type === 'CE'
    );
    const lotSize = sampleInstrument?.lot_size ?? 1;

    const spotKey = instruments.find(
      i => i.underlying_symbol === underlying && (i.instrument_type === 'EQ' || i.segment === 'NSE_INDEX' || i.segment === 'BSE_INDEX'),
    )?.instrument_key ?? findUnderlyingKey(instruments, underlying);
    spotKeyRef.current = spotKey;

    const specs: StrikeSpec[] = [];

    for (const strike of strikes) {
      const callKey = findKey(instruments, underlying, deferredExpiry, strike, 'CE');
      const putKey  = findKey(instruments, underlying, deferredExpiry, strike, 'PE');
      if (!callKey || !putKey) continue;
      const cachedCall = wsManager.get(callKey);
      const cachedPut  = wsManager.get(putKey);
      rows.push({
        strike,
        callOI:    cachedCall?.oi    ?? 0,
        putOI:     cachedPut?.oi     ?? 0,
        callGamma: cachedCall?.gamma ?? 0,
        putGamma:  cachedPut?.gamma  ?? 0,
        lotSize,
        callKey,
        putKey,
      });
      specs.push({ strike, callKey, putKey, lotSize });
      keysToSubscribe.push(callKey, putKey);
    }

    strikeSpecsRef.current = specs;
    oiRowsRef.current = rows;
    setOiRows([...rows]);

    if (spotKey) wsManager.requestKeys([spotKey]);
    if (keysToSubscribe.length > 0) wsManager.requestKeys(keysToSubscribe);

    // Canvas redraws via rAF (once per frame max) — never blocks scroll
    let rafId: number | null = null;
    const scheduleRedraw = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        redrawCanvas();
      });
    };

    // Table React state throttled to 500ms — OI values don't need tick-rate updates
    let tableTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleTableUpdate = () => {
      if (tableTimer !== null) return;
      tableTimer = setTimeout(() => {
        tableTimer = null;
        setOiRows([...oiRowsRef.current]);
      }, 500);
    };

    const unsubs: (() => void)[] = [];
    for (const row of rows) {
      const callUnsub = wsManager.subscribe(row.callKey, (data) => {
        const r = oiRowsRef.current.find(x => x.strike === row.strike);
        if (!r) return;
        r.callOI    = data.oi    || 0;
        r.callGamma = data.gamma || 0;
        scheduleRedraw();
        scheduleTableUpdate();
      });
      const putUnsub = wsManager.subscribe(row.putKey, (data) => {
        const r = oiRowsRef.current.find(x => x.strike === row.strike);
        if (!r) return;
        r.putOI    = data.oi    || 0;
        r.putGamma = data.gamma || 0;
        scheduleRedraw();
        scheduleTableUpdate();
      });
      unsubs.push(callUnsub, putUnsub);
    }

    if (spotKey) {
      const spotUnsub = wsManager.subscribe(spotKey, () => {
        if (viewModeRef.current === 'gex') scheduleRedraw();
      });
      unsubs.push(spotUnsub);
    }

    return () => {
      unsubs.forEach(u => u());
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      if (tableTimer !== null) { clearTimeout(tableTimer); tableTimer = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, deferredExpiry, instruments]);

  // ── 2. Boot TradingView chart ─────────────────────────────────────────────
  useEffect(() => {
    if (!chartDivRef.current) return;

    const el = chartDivRef.current;
    const { width: initW, height: initH } = el.getBoundingClientRect();
    const chart = createChart(el, {
      autoSize: false,
      width: initW || 400,
      height: initH || 300,
      layout: {
        background: { color: '#171717' },
        textColor: '#B2B5BE',
        fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace",
        fontSize: 13,
        panes: {
          separatorColor: 'rgba(255,255,255,0.08)',
          separatorHoverColor: 'rgba(255,255,255,0.18)',
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: '#2a2a2a' },
        horzLines: { color: '#2a2a2a' },
      },
      crosshair: { mode: 0 },
      rightPriceScale: {
        borderColor: '#2a2a2a',
        scaleMargins: { top: 0.05, bottom: 0.22 },
      },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
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
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:        '#2ebd85', downColor:       '#f23645',
      borderUpColor: '#2ebd85', borderDownColor: '#f23645',
      wickUpColor:   '#2ebd85', wickDownColor:   '#f23645',
    });
    candleSeriesRef.current = candleSeries;

    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeriesRef.current = volSeries;

    const atmSeries = chart.addSeries(LineSeries, {
      color: '#818cf8',
      lineWidth: 2,
      title: 'ATM IV',
      priceScaleId: 'right',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    }, 1);
    chart.panes()[1]?.setHeight(150);
    atmIvSeriesRef.current = atmSeries;

    // Single scroll listener — rAF throttled, no double-fire
    let scrollRaf: number | null = null;
    const onScroll = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = null; redrawCanvas(); });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onScroll);

    // Single ResizeObserver: resize chart + canvas together
    const resyncCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = el.clientWidth  * dpr;
      canvas.height = el.clientHeight * dpr;
      canvas.style.width  = el.clientWidth  + 'px';
      canvas.style.height = el.clientHeight + 'px';
    };
    resyncCanvas(); // initial size

    let roRaf = 0;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      if (roRaf) cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => {
        roRaf = 0;
        if (!el || !chartRef.current) return;
        const { width, height } = el.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
        if (width === lastW && height === lastH) return;
        lastW = width; lastH = height;
        chartRef.current.applyOptions({ width, height });
        resyncCanvas();
        redrawCanvas();
      });
    });
    ro.observe(el);

    // Tooltip state tracked in a ref to avoid React re-renders on every mousemove
    const tooltipVisibleRef = { current: false };

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !candleSeriesRef.current || !wrapperRef.current || !chartDivRef.current) {
        if (tooltipVisibleRef.current) {
          tooltipVisibleRef.current = false;
          setTooltip(t => ({ ...t, visible: false }));
        }
        if (hoveredStrikeRef.current !== null) { hoveredStrikeRef.current = null; redrawCanvas(); }
        return;
      }

      const price = candleSeriesRef.current.coordinateToPrice(param.point.y);
      if (price == null) {
        if (tooltipVisibleRef.current) {
          tooltipVisibleRef.current = false;
          setTooltip(t => ({ ...t, visible: false }));
        }
        if (hoveredStrikeRef.current !== null) { hoveredStrikeRef.current = null; redrawCanvas(); }
        return;
      }

      const chartW = chartDivRef.current.clientWidth;
      const priceScaleW = chart.priceScale('right').width();
      const barAnchor = chartW - priceScaleW;
      const barZoneStart = barAnchor * (1 - barFillRatioRef.current * 1.5);
      const inBarZone = param.point.x >= barZoneStart;

      if (!inBarZone) {
        if (hoveredStrikeRef.current !== null || tooltipVisibleRef.current) {
          hoveredStrikeRef.current = null;
          tooltipVisibleRef.current = false;
          setTooltip(t => ({ ...t, visible: false }));
          redrawCanvas();
        }
        return;
      }

      const rows = oiRowsRef.current;
      if (rows.length === 0) return;

      let closestRow: OIRow | null = null;
      let closestPixelDist = Infinity;
      const HIT_RADIUS = BAR_H + BAR_GAP + 4;

      for (const row of rows) {
        const yCenter = candleSeriesRef.current!.priceToCoordinate(row.strike);
        if (yCenter == null) continue;
        const dist = Math.abs(param.point.y - yCenter);
        if (dist < HIT_RADIUS && dist < closestPixelDist) {
          closestPixelDist = dist;
          closestRow = row;
        }
      }

      if (closestRow) {
        const prevStrike = hoveredStrikeRef.current;
        hoveredStrikeRef.current = closestRow.strike;
        const wrapRect  = wrapperRef.current.getBoundingClientRect();
        const chartRect = chartDivRef.current.getBoundingClientRect();
        const offsetX = chartRect.left - wrapRect.left + param.point.x;
        const offsetY = chartRect.top  - wrapRect.top  + param.point.y;
        tooltipVisibleRef.current = true;
        setTooltip({ visible: true, x: offsetX, y: offsetY, strike: closestRow.strike, callOI: closestRow.callOI, putOI: closestRow.putOI });
        if (prevStrike !== closestRow.strike) redrawCanvas();
      } else {
        if (hoveredStrikeRef.current !== null || tooltipVisibleRef.current) {
          hoveredStrikeRef.current = null;
          tooltipVisibleRef.current = false;
          setTooltip(t => ({ ...t, visible: false }));
          redrawCanvas();
        }
      }
    });

    return () => {
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      if (roRaf) cancelAnimationFrame(roRaf);
      ro.disconnect();
      chart.remove();
      chartRef.current       = null;
      candleSeriesRef.current = null;
      volSeriesRef.current    = null;
      atmIvSeriesRef.current  = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 3a. ATM IV — live WS feed ────────────────────────────────────────────
  useEffect(() => {
    const series = atmIvSeriesRef.current;
    if (!series) return;

    // Full reset when underlying/expiry changes
    series.setData([]);
    liveAtmIvBarRef.current     = null;
    currentAtmStrikeRef.current = 0;
    atmIvHistoryRef.current     = [];
    if (atmIvSubsRef.current) {
      atmIvSubsRef.current.callUnsub();
      atmIvSubsRef.current.putUnsub();
      atmIvSubsRef.current = null;
    }

    if (!underlying || !deferredExpiry) return;

    const strikeInterval = getStrikeInterval(underlying);

    const subscribeAtmStrike = (atmStrike: number) => {
      if (atmIvSubsRef.current) {
        atmIvSubsRef.current.callUnsub();
        atmIvSubsRef.current.putUnsub();
        atmIvSubsRef.current = null;
      }
      const row = oiRowsRef.current.find(r => r.strike === atmStrike);
      if (!row) return;

      const { callKey, putKey } = row;

      const handleIvTick = () => {
        if (!isMarketOpen()) return;
        const callIv = wsManager.get(callKey)?.iv ?? 0;
        const putIv  = wsManager.get(putKey)?.iv  ?? 0;
        if (callIv <= 0 || putIv <= 0) return;

        const atmIv     = (callIv + putIv) / 2;
        const nowBarSec = snapToBarTime(Date.now(), intervalRef.current.minutes) as Time;
        const prev      = liveAtmIvBarRef.current;

        if (prev && Number(prev.time) === Number(nowBarSec)) {
          const updated: LineData = { time: nowBarSec, value: atmIv };
          liveAtmIvBarRef.current = updated;
          try { atmIvSeriesRef.current?.update(updated); } catch { /* lwc guard */ }
        } else {
          liveAtmIvBarRef.current = { time: nowBarSec, value: atmIv };
          try { atmIvSeriesRef.current?.update(liveAtmIvBarRef.current); } catch { /* lwc guard */ }
        }
      };

      const callUnsub = wsManager.subscribe(callKey, handleIvTick);
      const putUnsub  = wsManager.subscribe(putKey,  handleIvTick);
      atmIvSubsRef.current = { callUnsub, putUnsub };
    };

    const spotKey = spotKeyRef.current;
    let spotUnsub: (() => void) | null = null;

    if (spotKey) {
      spotUnsub = wsManager.subscribe(spotKey, (md) => {
        if (!isMarketOpen()) return;
        const ltp = md.ltp ?? 0;
        if (ltp <= 0) return;
        const newAtmStrike = calculateATMStrike(ltp, strikeInterval);
        if (newAtmStrike <= 0) return;
        if (newAtmStrike !== currentAtmStrikeRef.current) {
          currentAtmStrikeRef.current = newAtmStrike;
          subscribeAtmStrike(newAtmStrike);
        }
      });

      const cachedSpot = wsManager.get(spotKey)?.ltp ?? 0;
      if (cachedSpot > 0) {
        const seedAtm = calculateATMStrike(cachedSpot, strikeInterval);
        if (seedAtm > 0) {
          currentAtmStrikeRef.current = seedAtm;
          subscribeAtmStrike(seedAtm);
        }
      }
    }

    return () => {
      spotUnsub?.();
      if (atmIvSubsRef.current) {
        atmIvSubsRef.current.callUnsub();
        atmIvSubsRef.current.putUnsub();
        atmIvSubsRef.current = null;
      }
      liveAtmIvBarRef.current     = null;
      currentAtmStrikeRef.current = 0;
      atmIvHistoryRef.current     = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, deferredExpiry, instruments]);

  // ── 3b. ATM IV — Nubra history (delta-load: prepend only missing data) ──
  useEffect(() => {
    const series = atmIvSeriesRef.current;
    if (!series || !underlying || !deferredExpiry) return;

    const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
    if (!rawCookie.trim()) return;

    let cancelled = false;
    const exchange = nubraExchange(underlying, instruments);

    // Oldest time we already have — fetch only before this
    const existingOldest = atmIvHistoryRef.current.length > 0
      ? Number(atmIvHistoryRef.current[0].time)
      : null;

    let fetchStart = ivStartDate;

    if (existingOldest !== null) {
      // If requested start is not earlier than what we already have, nothing to load
      const oldestIstDate = toIstDateStr(new Date(existingOldest * 1000));
      if (fetchStart >= oldestIstDate) return;
    }

    fetchAtmIv(underlying, deferredExpiry, exchange, rawCookie, interval.minutes, fetchStart)
      .then(pts => {
        if (cancelled) return;

        let newPts = pts.filter(p => p.v > 0);

        // If we have an end boundary, drop points >= existingOldest
        if (existingOldest !== null) {
          newPts = newPts.filter(p => Math.floor(p.ts / 1_000_000_000) < existingOldest);
        }

        if (newPts.length === 0) return;

        const newData: LineData[] = newPts
          .map(p => ({ time: Math.floor(p.ts / 1_000_000_000) as Time, value: p.v * 100 }))
          .sort((a, b) => Number(a.time) - Number(b.time));

        // Prepend to existing history and re-set
        const merged = [...newData, ...atmIvHistoryRef.current]
          .sort((a, b) => Number(a.time) - Number(b.time));

        // Deduplicate by time
        const deduped = merged.filter((d, i) => i === 0 || Number(d.time) !== Number(merged[i - 1].time));

        atmIvHistoryRef.current = deduped;
        atmIvSeriesRef.current?.setData(deduped);

        // Re-apply live bar on top
        if (liveAtmIvBarRef.current) {
          try { atmIvSeriesRef.current?.update(liveAtmIvBarRef.current); } catch { /* lwc guard */ }
        }
      })
      .catch(e => console.warn('[OIProfileView] ATM IV fetch failed', e));

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, deferredExpiry, instruments, interval.minutes, ivStartDate]);

  // Canvas sizing is handled inside the chart init's ResizeObserver (see above)

  // Canvas is redrawn via scheduleRedraw() in WS callbacks — no extra effect needed here

  // ── 4. Load price candles (session-aware, mirrors CandleChart.tsx) ───────
  useEffect(() => {
    if (!underlying || !deferredExpiry) return;

    const candleSeries = candleSeriesRef.current;
    const volSeries    = volSeriesRef.current;
    if (!candleSeries || !volSeries) return;

    const spotKey = instruments.find(
      i => i.underlying_symbol === underlying && (i.instrument_type === 'EQ' || i.segment === 'NSE_INDEX' || i.segment === 'BSE_INDEX'),
    )?.instrument_key ?? findUnderlyingKey(instruments, underlying);

    if (!spotKey) { setError(`No spot instrument found for ${underlying}`); return; }

    // Bump session so stale WS ticks for old interval/underlying are discarded
    const mySession = ++sessionRef.current;

    setLoading(true);
    setError(null);
    setWsLive(false);
    restLoadingRef.current         = true;
    liveBarRef.current             = null;
    liveVolRef.current             = null;
    allCandlesRef.current          = [];
    allVolRef.current              = [];
    barRefetchScheduledRef.current = false;
    if (barRefetchTimerRef.current) {
      clearTimeout(barRefetchTimerRef.current);
      barRefetchTimerRef.current = null;
    }

    candleSeries.setData([]);
    volSeries.setData([]);

    const iv = interval.value;

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    (async () => {
      try {
        // Step 1: fetch today's candles
        const todayRes = await fetchCandles(spotKey, iv, todayEnd.getTime());
        if (mySession !== sessionRef.current) return;

        let candles = todayRes.candles;
        let prev    = todayRes.prevTimestamp;

        // Step 2: fallback to prevTimestamp if today is empty
        if (candles.length === 0 && prev) {
          const fallback = await fetchCandles(spotKey, iv, prev);
          if (mySession !== sessionRef.current) return;
          candles = fallback.candles;
          prev    = fallback.prevTimestamp;
        }

        // Step 3: also fetch previous day candles
        let prevCandles: number[][] = [];
        if (prev) {
          const prevRes = await fetchCandles(spotKey, iv, prev);
          if (mySession !== sessionRef.current) return;
          prevCandles = prevRes.candles;
        }

        const combined = [...prevCandles, ...candles];
        const sorted   = [...combined].sort((a, b) => a[0] - b[0]);
        const unique   = sorted.filter((c, i) => i === 0 || c[0] !== sorted[i - 1][0]);

        const cData = unique.map(toCandleRow);
        const vData = unique.map(toVolRow);
        allCandlesRef.current = cData;
        allVolRef.current     = vData;

        candleSeries.setData(cData);
        volSeries.setData(vData);

        // Pop current forming bar if REST already includes it — WS will own it
        const ivDef = INTERVALS.find(x => x.value === iv) ?? INTERVALS[0];
        const wallBarSec = snapToBarTime(Date.now(), ivDef.minutes);
        const lastCandle = cData.length > 0 ? cData[cData.length - 1] : null;
        if (lastCandle && Number(lastCandle.time) === wallBarSec) {
          const poppedCandle = cData.pop()!;
          const poppedVol    = vData.pop();
          allCandlesRef.current = cData;
          allVolRef.current     = vData;

          const snapshot = wsManager.get(spotKey);
          const ltp = (snapshot?.ltp ?? 0) > 0 ? snapshot!.ltp : poppedCandle.close;
          const seedBar: CandlestickData = {
            time:  poppedCandle.time,
            open:  poppedCandle.open,
            high:  Math.max(poppedCandle.high, ltp),
            low:   Math.min(poppedCandle.low,  ltp),
            close: ltp,
          };
          liveBarRef.current = seedBar;
          liveVolRef.current = poppedVol
            ? { ...poppedVol, color: ltp >= poppedCandle.open ? 'rgba(46,189,133,0.4)' : 'rgba(242,54,69,0.4)' }
            : null;

          candleSeries.setData(cData);
          volSeries.setData(vData);
          try { candleSeries.update(seedBar); } catch { /* ignore */ }
          if (liveVolRef.current) try { volSeries.update(liveVolRef.current); } catch { /* ignore */ }
        } else {
          liveBarRef.current = null;
          liveVolRef.current = null;
        }

        restLoadingRef.current = false;

        if (cData.length > 0) {
          const ts = chartRef.current?.timeScale();
          if (ts) setTimeout(() => ts.fitContent(), 50);
        }

        setLoading(false);
      } catch (err) {
        if (mySession !== sessionRef.current) return;
        restLoadingRef.current = false;
        setError(String(err));
        setLoading(false);
      }
    })();

    return () => {
      // Session bump on unmount / dep-change is handled by the next render's ++sessionRef
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, deferredExpiry, interval.value]);

  // ── 5. WebSocket live candle feed (mirrors CandleChart.tsx) ──────────────
  useEffect(() => {
    if (!underlying) return;

    const spotKey = instruments.find(
      i => i.underlying_symbol === underlying && (i.instrument_type === 'EQ' || i.segment === 'NSE_INDEX' || i.segment === 'BSE_INDEX'),
    )?.instrument_key ?? findUnderlyingKey(instruments, underlying);

    if (!spotKey) return;

    wsManager.requestKeys([spotKey]);

    // Silent re-fetch at next bar boundary
    const scheduleBarRefetch = (mySession: number) => {
      if (barRefetchScheduledRef.current) return;
      barRefetchScheduledRef.current = true;

      const iv = intervalRef.current;
      const nowMs = Date.now();
      const intervalMs = iv.minutes * 60 * 1000;
      const wallBarMs  = snapToBarTime(nowMs, iv.minutes) * 1000;
      const nextBarMs  = wallBarMs + intervalMs;
      const delay      = (nextBarMs - nowMs) + 500;

      barRefetchTimerRef.current = setTimeout(async () => {
        if (mySession !== sessionRef.current) return;
        restLoadingRef.current = true;

        try {
          const d = new Date(); d.setHours(23, 59, 59, 999);
          const ivVal = intervalRef.current.value;

          const todayRes = await fetchCandles(spotKey, ivVal, d.getTime());
          if (mySession !== sessionRef.current) { restLoadingRef.current = false; return; }

          let candles = todayRes.candles;
          let prev    = todayRes.prevTimestamp;

          if (candles.length === 0 && prev) {
            const fallback = await fetchCandles(spotKey, ivVal, prev);
            if (mySession !== sessionRef.current) { restLoadingRef.current = false; return; }
            candles = fallback.candles;
            prev    = fallback.prevTimestamp;
          }

          let prevCandles: number[][] = [];
          if (prev) {
            const prevRes = await fetchCandles(spotKey, ivVal, prev);
            if (mySession !== sessionRef.current) { restLoadingRef.current = false; return; }
            prevCandles = prevRes.candles;
          }

          const combined = [...prevCandles, ...candles];
          const sorted   = [...combined].sort((a, b) => a[0] - b[0]);
          const unique   = sorted.filter((c, i) => i === 0 || c[0] !== sorted[i - 1][0]);

          const cData = unique.map(toCandleRow);
          const vData = unique.map(toVolRow);

          // Pop current forming bar
          const wallBarSec = snapToBarTime(Date.now(), intervalRef.current.minutes);
          const lastCandle = cData.length > 0 ? cData[cData.length - 1] : null;
          if (lastCandle && Number(lastCandle.time) === wallBarSec) {
            cData.pop();
            vData.pop();
          }

          allCandlesRef.current = cData;
          allVolRef.current     = vData;

          candleSeriesRef.current?.setData(cData);
          volSeriesRef.current?.setData(vData);

          if (liveBarRef.current) {
            try { candleSeriesRef.current?.update(liveBarRef.current); } catch { /* ignore */ }
          }
          if (liveVolRef.current) {
            try { volSeriesRef.current?.update(liveVolRef.current); } catch { /* ignore */ }
          }
        } catch (err) {
          console.warn('[OIProfileView] Silent re-fetch failed', err);
        } finally {
          if (mySession === sessionRef.current) restLoadingRef.current = false;
        }
      }, delay);
    };

    let logged = false;
    const mySession = sessionRef.current;
    const unsubCandle = wsManager.subscribe(spotKey, (md) => {
      if (restLoadingRef.current) return;
      if (!isMarketOpen()) return;

      const candleSeries = candleSeriesRef.current;
      const volSeries    = volSeriesRef.current;
      if (!candleSeries || !volSeries) return;

      const ltp = md.ltp ?? 0;
      if (!ltp) return;

      const iv = intervalRef.current;

      const ohlcEntry    = md.ohlc?.find(o => o.interval === iv.value);
      const ohlcBarTimeSec = ohlcEntry && Number(ohlcEntry.ts) > 0
        ? Math.floor(Number(ohlcEntry.ts) / 1000)
        : null;

      const wallBarTimeSec = snapToBarTime(Date.now(), iv.minutes);
      const barTimeSec     = wallBarTimeSec as Time;

      const useOhlc = ohlcEntry != null && ohlcBarTimeSec != null
        && ohlcBarTimeSec === wallBarTimeSec;

      if (!logged) {
        logged = true;
        scheduleBarRefetch(mySession);
      }

      const lastRestTime = allCandlesRef.current.length > 0
        ? Number(allCandlesRef.current[allCandlesRef.current.length - 1].time)
        : 0;
      if (Number(barTimeSec) < lastRestTime) return;

      const prev = liveBarRef.current;

      if (prev && Number(prev.time) === Number(barTimeSec)) {
        // Same bar: update
        const updated: CandlestickData = useOhlc
          ? {
              time:  barTimeSec,
              open:  ohlcEntry!.open  || prev.open,
              high:  ohlcEntry!.high  || Math.max(prev.high, ltp),
              low:   ohlcEntry!.low   || Math.min(prev.low,  ltp),
              close: ltp,
            }
          : {
              time:  barTimeSec,
              open:  prev.open,
              high:  Math.max(prev.high, ltp),
              low:   Math.min(prev.low,  ltp),
              close: ltp,
            };
        liveBarRef.current = updated;
        try { candleSeries.update(updated); } catch { /* lwc guard */ }

        const vol = useOhlc ? Number(ohlcEntry!.vol) || 0 : (liveVolRef.current?.value ?? 0);
        const updatedVol: HistogramData = {
          time:  barTimeSec,
          value: vol,
          color: ltp >= updated.open ? 'rgba(46,189,133,0.4)' : 'rgba(242,54,69,0.4)',
        };
        liveVolRef.current = updatedVol;
        try { volSeries.update(updatedVol); } catch { /* lwc guard */ }

      } else {
        // New bar: commit old live bar to history
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

        const newOpen = useOhlc ? ohlcEntry!.open : (prev ? prev.close : ltp);
        const newBar: CandlestickData = useOhlc
          ? {
              time:  barTimeSec,
              open:  ohlcEntry!.open  || newOpen,
              high:  ohlcEntry!.high  || Math.max(newOpen, ltp),
              low:   ohlcEntry!.low   || Math.min(newOpen, ltp),
              close: ltp,
            }
          : {
              time:  barTimeSec,
              open:  newOpen,
              high:  Math.max(newOpen, ltp),
              low:   Math.min(newOpen, ltp),
              close: ltp,
            };
        liveBarRef.current = newBar;
        try { candleSeries.update(newBar); } catch { /* lwc guard */ }

        const newVol: HistogramData = {
          time:  barTimeSec,
          value: useOhlc ? Number(ohlcEntry!.vol) || 0 : 0,
          color: ltp >= newBar.open ? 'rgba(46,189,133,0.4)' : 'rgba(242,54,69,0.4)',
        };
        liveVolRef.current = newVol;
        try { volSeries.update(newVol); } catch { /* lwc guard */ }
      }

      setWsLive(true);
    });

    return () => {
      unsubCandle();
      setWsLive(false);
      if (barRefetchTimerRef.current) {
        clearTimeout(barRefetchTimerRef.current);
        barRefetchTimerRef.current = null;
      }
    };
  // underlying change re-subscribes; interval is read via intervalRef (no re-sub on switch)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying]);

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalCallOI = oiRows.reduce((s, r) => s + r.callOI, 0);
  const totalPutOI  = oiRows.reduce((s, r) => s + r.putOI,  0);
  const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : '—';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex overflow-hidden" style={{ height: '100%', background: 'transparent' }}>

      {/* Left: OI table */}
      <div
        className="flex flex-col shrink-0 overflow-hidden"
        style={{
          width: tableCollapsed ? 0 : 220,
          borderRight: tableCollapsed ? 'none' : '1px solid #2a2a2a',
          background: '#171717',
          transition: 'width 0.2s ease',
        }}
      >
        {/* PCR totals */}
        {(underlying && expiry) && (
          <div
            className="flex gap-3 px-3 py-2 shrink-0"
            style={{ borderBottom: '1px solid #2a2a2a' }}
          >
            <div>
              <span style={{ fontSize: 10, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>CALL OI</span>
              <p style={{ fontSize: 13, color: '#f23645', fontFamily: 'inherit', margin: 0 }}>{fmtOI(totalCallOI)}</p>
            </div>
            <div>
              <span style={{ fontSize: 10, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>PUT OI</span>
              <p style={{ fontSize: 13, color: '#2ebd85', fontFamily: 'inherit', margin: 0 }}>{fmtOI(totalPutOI)}</p>
            </div>
            <div>
              <span style={{ fontSize: 10, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>PCR</span>
              <p style={{ fontSize: 13, color: '#fafafa', fontFamily: 'inherit', margin: 0 }}>{pcr}</p>
            </div>
          </div>
        )}

        {/* OI rows */}
        <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
          {oiRows.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center px-3"
              style={{ fontSize: 10, color: '#3f3f46', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {underlying && expiry ? 'WAITING FOR LIVE DATA' : 'SELECT UNDERLYING & EXPIRY'}
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ background: '#171717', borderBottom: '1px solid #2a2a2a' }}>
                  <th className="text-right px-2 py-1" style={{ letterSpacing: '0.08em' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#f23645', textTransform: 'uppercase' }}>
                      {viewMode === 'oi' ? 'CALL OI' : 'CALL GEX'}
                    </span>
                  </th>
                  <th className="text-center px-1 py-1" style={{ letterSpacing: '0.08em' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#FF9800', textTransform: 'uppercase' }}>STRIKE</span>
                  </th>
                  <th className="text-left px-2 py-1" style={{ letterSpacing: '0.08em' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#2ebd85', textTransform: 'uppercase' }}>
                      {viewMode === 'oi' ? 'PUT OI' : 'PUT GEX'}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...oiRows].reverse().map(row => {
                  const isHot = tooltip.visible && tooltip.strike === row.strike;
                  const spot  = spotKeyRef.current ? (wsManager.get(spotKeyRef.current)?.ltp ?? 0) : 0;
                  const gexMult = (gexMode === 'spot' && spot > 0) ? spot * spot : 1;
                  const callGex =  row.callGamma * row.callOI * row.lotSize * gexMult;
                  const putGex  = -row.putGamma  * row.putOI  * row.lotSize * gexMult;
                  const maxOI   = Math.max(totalCallOI > 0 ? 1 : 0, row.callOI, row.putOI, 1);
                  const callPct = viewMode === 'oi' ? (row.callOI / Math.max(maxOI, 1)) * 100 : 0;
                  const putPct  = viewMode === 'oi' ? (row.putOI  / Math.max(maxOI, 1)) * 100 : 0;

                  return (
                    <tr
                      key={row.strike}
                      style={{
                        borderBottom: '1px solid #2a2a2a',
                        background: isHot ? 'rgba(255,152,0,0.08)' : undefined,
                      }}
                    >
                      <td className="px-2 py-0.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <span style={{ fontSize: 12, fontWeight: 600, width: 56, textAlign: 'right', flexShrink: 0, color: viewMode === 'oi' ? '#f23645' : '#818cf8' }}>
                            {viewMode === 'oi'
                              ? (row.callOI > 0 ? fmtOI(row.callOI) : '—')
                              : fmtGex(callGex)}
                          </span>
                          {viewMode === 'oi' && (
                            <div style={{ height: 4, flexShrink: 0, width: callPct * 0.3 + 'px', background: '#f23645', minWidth: row.callOI > 0 ? 2 : 0, opacity: 0.7 }} />
                          )}
                        </div>
                      </td>
                      <td className="px-1 py-0.5 text-center" style={{ fontSize: 12, fontWeight: 700, color: '#FF9800' }}>
                        {row.strike.toLocaleString('en-IN')}
                      </td>
                      <td className="px-2 py-0.5 text-left">
                        <div className="flex items-center gap-1">
                          {viewMode === 'oi' && (
                            <div style={{ height: 4, flexShrink: 0, width: putPct * 0.3 + 'px', background: '#2ebd85', minWidth: row.putOI > 0 ? 2 : 0, opacity: 0.7 }} />
                          )}
                          <span style={{ fontSize: 12, fontWeight: 600, width: 56, flexShrink: 0, color: viewMode === 'oi' ? '#2ebd85' : '#fb923c' }}>
                            {viewMode === 'oi'
                              ? (row.putOI > 0 ? fmtOI(row.putOI) : '—')
                              : fmtGex(putGex)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Legend */}
        <div
          className="flex gap-3 px-3 py-1.5 shrink-0"
          style={{ borderTop: '1px solid #2a2a2a', fontSize: 9, color: '#52525b', letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {viewMode === 'oi' ? (<>
            <span className="flex items-center gap-1">
              <span style={{ width: 8, height: 3, background: '#f23645', display: 'inline-block' }} />
              CALL
            </span>
            <span className="flex items-center gap-1">
              <span style={{ width: 8, height: 3, background: '#2ebd85', display: 'inline-block' }} />
              PUT
            </span>
          </>) : (<>
            <span className="flex items-center gap-1">
              <span style={{ width: 8, height: 3, background: '#818cf8', display: 'inline-block' }} />
              CALL GEX
            </span>
            <span className="flex items-center gap-1">
              <span style={{ width: 8, height: 3, background: '#fb923c', display: 'inline-block' }} />
              PUT GEX
            </span>
          </>)}
        </div>
      </div>

      {/* Right: toolbar + chart */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Toolbar */}
        <div
          className="flex items-center shrink-0 glass-bar"
          style={{ height: 36 }}
        >
          {/* Table collapse toggle */}
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); setTableCollapsed(c => !c); }}
            title={tableCollapsed ? 'Show OI table' : 'Hide OI table'}
            style={{
              width: 28, height: 36, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 0, background: 'none', border: 'none',
              borderRight: '1px solid #2a2a2a', cursor: 'pointer',
              color: '#a78bfa',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              {tableCollapsed
                ? <><path d="M3 2l5 5-5 5"/><line x1="10" y1="2" x2="10" y2="12"/></>
                : <><path d="M8 2l-5 5 5 5"/><line x1="4" y1="2" x2="4" y2="12"/></>
              }
            </svg>
          </button>

          {/* Symbol */}
          <div style={{ padding: '0 6px' }}>
            <GlassSelect
              value={underlying || null}
              options={underlyings}
              onChange={v => { setUnderlying(String(v)); setExpiry(null); }}
              placeholder="Symbol"
              minWidth={100}
            />
          </div>

          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          {/* Expiry */}
          <div style={{ padding: '0 6px' }}>
            <GlassSelect
              value={expiry}
              options={expiries}
              onChange={v => setExpiry(v as number)}
              formatLabel={v => fmtExpiry(v as number)}
              disabled={!underlying}
              placeholder="Expiry"
              minWidth={100}
            />
          </div>

          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          {/* Interval — dropdown */}
          <IntervalDropdown value={interval} onChange={setInterval} />

          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          {/* IV start date */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 6px', flexShrink: 0 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: '#787B86', letterSpacing: '0.08em', textTransform: 'uppercase' }}>IV FROM</span>
            <IvDateInput value={ivStartDate} onCommit={setIvStartDate} />
          </div>

          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          {/* OI / GEX dropdown */}
          <ViewModeDropdown
            viewMode={viewMode} gexMode={gexMode}
            onViewMode={m => { setViewMode(m); setTimeout(redrawCanvas, 0); }}
            onGexMode={m => { setGexMode(m); setTimeout(redrawCanvas, 0); }}
          />

          {/* Status area — DaisyUI */}
          <span className="flex items-center gap-2 ml-auto mr-2">
            {loading && (
              <span className="flex items-center gap-1.5">
                <span className="loading loading-dots loading-xs" style={{ color: '#787B86' }} />
                <span style={{ fontSize: 11, color: '#52525b', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Fetching</span>
              </span>
            )}
            {error && (
              <span className="flex items-center gap-1" title={error}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f23645" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="#f23645"/></svg>
                <span style={{ fontSize: 11, color: '#f23645', letterSpacing: '0.06em', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>
              </span>
            )}
            {!loading && !error && wsLive && (
              <span className="flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: '#2ebd85' }} />
                  <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: '#2ebd85' }} />
                </span>
                <span style={{ fontSize: 11, color: '#2ebd85', letterSpacing: '0.1em', fontWeight: 600 }}>LIVE</span>
              </span>
            )}
          </span>
        </div>

        {/* Chart area + ATM IV pane */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>

        {/* Candle chart */}
        <div className="relative overflow-hidden" ref={wrapperRef} style={{ background: '#171717', flex: '1 1 100%', minHeight: 60 }}>
          <div ref={chartDivRef} style={{ position: 'absolute', inset: 0 }} />

          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10 }}
          />

          {/* Hover tooltip */}
          {tooltip.visible && (() => {
            const tipW = 185;
            const left = tooltip.x - tipW - 14;
            const top  = tooltip.y - 56;
            const hovRow = oiRows.find(r => r.strike === tooltip.strike);
            const spot   = spotKeyRef.current ? (wsManager.get(spotKeyRef.current)?.ltp ?? 0) : 0;
            const tipGexMult = (gexMode === 'spot' && spot > 0) ? spot * spot : 1;
            const callGex = hovRow ? ( hovRow.callGamma * hovRow.callOI * hovRow.lotSize * tipGexMult) : 0;
            const putGex  = hovRow ? (-hovRow.putGamma  * hovRow.putOI  * hovRow.lotSize * tipGexMult) : 0;
            const netGex  = callGex + putGex;
            const pcrTip  = viewMode === 'oi' && tooltip.callOI > 0 ? (tooltip.putOI / tooltip.callOI).toFixed(2) : null;
            return (
              <div style={{
                position: 'absolute',
                left: Math.max(4, left),
                top:  Math.max(4, top),
                width: tipW,
                zIndex: 20,
                pointerEvents: 'none',
                background: '#171717',
                border: '1px solid #2a2a2a',
                borderRadius: 0,
                padding: '7px 10px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.95)',
              }}>
                <div style={{ fontSize: 11, color: '#888', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>STRIKE</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#FF9800', marginBottom: 6 }}>{tooltip.strike.toLocaleString('en-IN')}</div>
                <div style={{ height: 1, background: '#333', marginBottom: 5 }} />

                {viewMode === 'oi' ? (<>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#888', letterSpacing: '0.06em' }}>CALL OI</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#FF433D' }}>{fmtOI(tooltip.callOI)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: pcrTip ? 5 : 0 }}>
                    <span style={{ fontSize: 11, color: '#888', letterSpacing: '0.06em' }}>PUT OI</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1DB954' }}>{fmtOI(tooltip.putOI)}</span>
                  </div>
                </>) : (<>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#888', letterSpacing: '0.06em' }}>CALL GEX</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#FF9800' }}>{fmtGex(callGex)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 11, color: '#888', letterSpacing: '0.06em' }}>PUT GEX</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#fb923c' }}>{fmtGex(putGex)}</span>
                  </div>
                  <div style={{ height: 1, background: '#333', marginBottom: 5 }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: '#888', letterSpacing: '0.06em' }}>NET GEX</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: netGex >= 0 ? '#1DB954' : '#FF433D' }}>{fmtGex(netGex)}</span>
                  </div>
                </>)}

                {pcrTip && (<>
                  <div style={{ height: 1, background: '#333', marginBottom: 5, marginTop: 5 }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: '#888', letterSpacing: '0.06em' }}>PCR</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: Number(pcrTip) >= 1 ? '#1DB954' : '#FF433D' }}>{pcrTip}</span>
                  </div>
                </>)}
              </div>
            );
          })()}

          {!underlying && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none" style={{ zIndex: 5 }}>
              <p style={{ fontSize: 10, color: '#3f3f46', textTransform: 'uppercase', letterSpacing: '0.1em' }}>SELECT UNDERLYING & EXPIRY</p>
            </div>
          )}
        </div>

        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OIProfileView — 3-panel wrapper (2 top + 1 bottom)
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  instruments: Instrument[];
}

export default function OIProfileView({ instruments }: Props) {
  const underlyings = useMemo(() => getUnderlyings(instruments), [instruments]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: '1fr 1fr',
        gridTemplateColumns: '1fr 1fr',
        height: '100%',
        gap: 1,
        background: '#2a2a2a',
      }}
    >
      {/* Top-left: NIFTY */}
      <div style={{ gridRow: 1, gridColumn: 1, overflow: 'hidden', minHeight: 0 }}>
        <OIProfilePanel
          instruments={instruments}
          underlyings={underlyings}
          defaultUnderlying="NIFTY"
          barFillRatio={0.32}
        />
      </div>

      {/* Top-right: BANKNIFTY */}
      <div style={{ gridRow: 1, gridColumn: 2, overflow: 'hidden', minHeight: 0 }}>
        <OIProfilePanel
          instruments={instruments}
          underlyings={underlyings}
          defaultUnderlying="BANKNIFTY"
          barFillRatio={0.32}
        />
      </div>

      {/* Bottom: SENSEX — spans both columns */}
      <div style={{ gridRow: 2, gridColumn: '1 / -1', overflow: 'hidden', minHeight: 0 }}>
        <OIProfilePanel
          instruments={instruments}
          underlyings={underlyings}
          defaultUnderlying="SENSEX"
        />
      </div>
    </div>
  );
}
