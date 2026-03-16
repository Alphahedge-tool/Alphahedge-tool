'use client';

import { useState, useMemo, useEffect, useRef, useCallback, startTransition } from 'react';
import { createPortal } from 'react-dom';
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type HistogramData,
  type Time,
  type LogicalRange,
} from 'lightweight-charts';
import DataEditor, {
  GridCellKind,
  type GridColumn,
  type GridCell,
  type Item,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import type { Instrument } from './useInstruments';
import { useMarketDataMap } from './hooks/useMarketData';
import { wsManager } from './lib/WebSocketManager';
import { cx } from './lib/utils';
import s from './StraddleChart.module.css';

interface Props {
  instruments: Instrument[];
  visible?: boolean;
}

type ChartMode = 'straddle' | 'strangle' | 'calendar';
type Interval = { label: string; value: number };

const INTERVALS: Interval[] = [
  { label: '1m',  value: 1  },
  { label: '5m',  value: 5  },
  { label: '15m', value: 15 },
  { label: '30m', value: 30 },
];

const MARKET_OPEN_MIN  = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

const CHART_OPTIONS = {
  autoSize: true,
  layout: { background: { color: 'transparent' }, textColor: '#B2B5BE' },
  grid: {
    vertLines: { color: '#2A2E39' },
    horzLines: { color: '#2A2E39' },
  },
  crosshair: { mode: 1 },
  rightPriceScale: { borderColor: '#2A2E39' },
  timeScale: {
    borderColor: '#2A2E39',
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 8,
    tickMarkFormatter: (() => {
      let lastDateKey = '';
      return (ts: number) => {
        const d = new Date(ts * 1000);
        const istMin = (d.getUTCHours() * 60 + d.getUTCMinutes()) + 330;
        const istMinWrapped = istMin % (24 * 60);
        const dateKey = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
        const time = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
        if (istMinWrapped === MARKET_OPEN_MIN && dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          const day = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric' });
          const weekday = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
          return `${day} ${weekday}  ${time}`;
        }
        return time;
      };
    })(),
  },
  localization: {
    timeFormatter: (ts: number) =>
      new Date(ts * 1000).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }),
  },
} as const;

// 8 base colors — CE is a lighter/transparent shade, PE is reddish shade, OI is indigo tint
const STRIKE_COLORS = [
  '#facc15', '#60a5fa', '#34d399', '#f97316',
  '#c084fc', '#fb923c', '#2dd4bf', '#f87171',
];

// Derive CE / PE / OI colors from the strike base color
function ceColor(base: string)  { return base + 'aa'; } // semi-transparent
function peColor(_base: string) { return '#f87171aa'; } // always reddish, semi
function oiColor(base: string)  { return base + '55'; } // very transparent fill

// ── Fetch ─────────────────────────────────────────────────────────────────────
function todayEndMs(): number {
  const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime();
}

function intervalToUpstox(intervalMin: number): string {
  if (intervalMin === 5)  return 'I5';
  if (intervalMin === 15) return 'I15';
  if (intervalMin === 30) return 'I30';
  return 'I1';
}

async function fetchCandlesRaw(
  instrumentKey: string, from: number, intervalMin = 1,
): Promise<{ candles: number[][]; prevTimestamp: number | null }> {
  const params = new URLSearchParams({ instrumentKey, interval: intervalToUpstox(intervalMin), from: String(from), limit: '375' });
  const res = await fetch(`/api/public-candles?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return {
    candles: json?.data?.data?.candles ?? json?.data?.candles ?? [],
    prevTimestamp: json?.data?.data?.meta?.prevTimestamp ?? json?.data?.meta?.prevTimestamp ?? null,
  };
}

async function fetchTodayCandles(instrumentKey: string, intervalMin = 1) {
  return fetchCandlesRaw(instrumentKey, todayEndMs(), intervalMin);
}

// ── Resampling ────────────────────────────────────────────────────────────────
function resample(candles1m: number[][], intervalMin: number): number[][] {
  if (candles1m.length === 0) return [];
  if (intervalMin === 1) return [...candles1m].sort((a, b) => a[0] - b[0]);

  const barMap = new Map<number, number[]>();
  for (const c of candles1m) {
    const tsSec = Math.floor(c[0] / 1000);
    const d = new Date(tsSec * 1000);
    const istMin = (d.getUTCHours() * 60 + d.getUTCMinutes()) + 330;
    const istMinWrapped = istMin % (24 * 60);
    const minSinceOpen = istMinWrapped - MARKET_OPEN_MIN;
    if (minSinceOpen < 0 || istMinWrapped > MARKET_CLOSE_MIN) continue;

    const bucketMin = Math.floor(minSinceOpen / intervalMin) * intervalMin + MARKET_OPEN_MIN;
    const barDateUtc = new Date(d); barDateUtc.setUTCHours(0, 0, 0, 0);
    const barTsSec = Math.floor((barDateUtc.getTime() + (bucketMin - 330) * 60 * 1000) / 1000);

    if (!barMap.has(barTsSec)) {
      barMap.set(barTsSec, [barTsSec * 1000, c[1], c[2], c[3], c[4], c[5] ?? 0, c[6] ?? 0]);
    } else {
      const bar = barMap.get(barTsSec)!;
      bar[2] = Math.max(bar[2], c[2]);
      bar[3] = Math.min(bar[3], c[3]);
      bar[4] = c[4];
      bar[5] = (bar[5] ?? 0) + (c[5] ?? 0);
      bar[6] = c[6] ?? bar[6];
    }
  }
  return Array.from(barMap.values()).sort((a, b) => a[0] - b[0]);
}

// ── Series builders ───────────────────────────────────────────────────────────
interface StrikeSeriesData {
  premium: LineData[];
  ce:      LineData[];
  pe:      LineData[];
  oi:      HistogramData[];
}

function buildStrikeData(ceCandles: number[][], peCandles: number[][], intervalMin: number): StrikeSeriesData {
  const ceR = resample(ceCandles, intervalMin);
  const peR = resample(peCandles, intervalMin);

  const ceMap = new Map(ceR.map(c => [Math.floor(c[0] / 1000), c]));
  const peMap = new Map(peR.map(c => [Math.floor(c[0] / 1000), c]));
  const keys  = Array.from(new Set([...ceMap.keys(), ...peMap.keys()]))
    .filter(k => ceMap.has(k) && peMap.has(k)).sort((a, b) => a - b);

  const premium: LineData[]     = [];
  const ce:      LineData[]     = [];
  const pe:      LineData[]     = [];
  const oi:      HistogramData[] = [];

  for (const k of keys) {
    const c = ceMap.get(k)!; const p = peMap.get(k)!;
    const t = k as Time;
    premium.push({ time: t, value: c[4] + p[4] });
    ce.push     ({ time: t, value: c[4] });
    pe.push     ({ time: t, value: p[4] });
    oi.push     ({ time: t, value: ((c[6] ?? 0) + (p[6] ?? 0)) / 1000, color: 'rgba(245,158,11,0.40)' });
  }
  return { premium, ce, pe, oi };
}

// Legacy builder for strangle (has volume too)
interface StraddleSeries { premium: LineData[]; ce: LineData[]; pe: LineData[]; oi: HistogramData[]; volume: HistogramData[]; }

function buildStraddleSeries(ceCandles: number[][], peCandles: number[][], intervalMin: number): StraddleSeries {
  const { premium, ce, pe, oi } = buildStrikeData(ceCandles, peCandles, intervalMin);
  const ceR = resample(ceCandles, intervalMin);
  const peR = resample(peCandles, intervalMin);
  const ceMap = new Map(ceR.map(c => [Math.floor(c[0] / 1000), c]));
  const peMap = new Map(peR.map(c => [Math.floor(c[0] / 1000), c]));
  const keys  = Array.from(new Set([...ceMap.keys(), ...peMap.keys()]))
    .filter(k => ceMap.has(k) && peMap.has(k)).sort((a, b) => a - b);
  const volume: HistogramData[] = keys.map(k => ({
    time: k as Time,
    value: ((ceMap.get(k)![5] ?? 0) + (peMap.get(k)![5] ?? 0)) / 1000,
    color: 'rgba(251,191,36,0.4)',
  }));
  return { premium, ce, pe, oi, volume };
}

interface CalendarSeries { near: LineData[]; far: LineData[]; nearOI: HistogramData[]; farOI: HistogramData[]; }

function buildCalendarSeries(
  nearCe: number[][], nearPe: number[][], farCe: number[][], farPe: number[][], intervalMin: number,
): CalendarSeries {
  const buildPrem = (ce: number[][], pe: number[][]): { prem: LineData[]; oi: HistogramData[] } => {
    const ceR = resample(ce, intervalMin); const peR = resample(pe, intervalMin);
    const ceMap = new Map(ceR.map(c => [Math.floor(c[0] / 1000), c]));
    const peMap = new Map(peR.map(c => [Math.floor(c[0] / 1000), c]));
    const keys = Array.from(new Set([...ceMap.keys(), ...peMap.keys()]))
      .filter(k => ceMap.has(k) && peMap.has(k)).sort((a, b) => a - b);
    return {
      prem: keys.map(k => ({ time: k as Time, value: ceMap.get(k)![4] + peMap.get(k)![4] })),
      oi:   keys.map(k => ({ time: k as Time, value: ((ceMap.get(k)![6] ?? 0) + (peMap.get(k)![6] ?? 0)) / 1000, color: 'rgba(245,158,11,0.35)' })),
    };
  };
  const n = buildPrem(resample(nearCe, intervalMin), resample(nearPe, intervalMin));
  const f = buildPrem(resample(farCe,  intervalMin), resample(farPe,  intervalMin));
  return { near: n.prem, far: f.prem, nearOI: n.oi, farOI: f.oi };
}

function zoomToEnd(chart: IChartApi, data: LineData[], visible = 80) {
  if (data.length === 0) return;
  const n = Math.min(visible, data.length);
  setTimeout(() => chart.timeScale().setVisibleRange({ from: data[data.length - n].time, to: data[data.length - 1].time }), 50);
}

// IST-aligned bar boundary snap (UTC+5:30 = 19800s)
const IST_OFFSET_SEC = 19800;
function snapToBarTime(tsMs: number, intervalMinutes: number): number {
  const intervalSec = intervalMinutes * 60;
  const nowSec = Math.floor(tsMs / 1000);
  return Math.floor((nowSec + IST_OFFSET_SEC) / intervalSec) * intervalSec - IST_OFFSET_SEC;
}

// ── Instrument helpers ────────────────────────────────────────────────────────
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

function fmtExpiry(ms: number) {
  return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' });
}



// ── UI components (shadcn/ui) ─────────────────────────────────────────────────
function UnderlyingInput({ underlyings, value, onChange }: { underlyings: string[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    return q ? underlyings.filter(u => u.toLowerCase().includes(q)) : underlyings;
  }, [underlyings, value]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const openDrop = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 180) });
    }
    setOpen(true);
  };

  return (
    <div className={s.underlyingWrap} ref={ref}>
      <span className={s.ctrlLabel}>Underlying</span>
      <div className={s.underlyingBox}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2.5" className={s.underlyingIcon}>
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          type="text"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => { onChange(e.target.value); openDrop(); }}
          onFocus={openDrop}
          placeholder="NIFTY…"
          className={`${s.underlyingInput} placeholder-[#9CA3AF]`}
        />
      </div>
      {open && filtered.length > 0 && dropPos && createPortal(
        <div className={s.dropdownShell} style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}>
          <div className={s.dropdownList}>
            {filtered.map(u => (
              <div key={u}
                onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); onChange(u); setOpen(false); }}
                className={s.dropdownItem}
              >
                {u}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function LabeledSelect({ label, value, options, onChange, formatLabel, disabled }: {
  label: string; value: string | number | null; options: (string | number)[];
  onChange: (v: string | number) => void; formatLabel?: (v: string | number) => string; disabled?: boolean;
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
    if (search === '') return true;
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
    <div className={s.selectWrap}>
      <span className={s.ctrlLabel}>{label}</span>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        className={cx(s.selectBtn, open && s.selectBtnOpen, isDisabled && s.selectBtnDisabled, displayLabel ? s.selectBtnHasValue : '')}
      >
        <span className={s.selectBtnText}>
          {displayLabel ?? 'Select…'}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className={cx(s.selectChevron, open && s.selectChevronOpen)}>
          <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div ref={dropRef} className={s.selectDropdown} style={{ top: pos.top, left: pos.left }}>
          <div className={s.selectSearchWrap}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className={s.selectSearchInput}
            />
          </div>
          <div className={s.selectOptionList}>
            {filtered.length === 0 && (
              <div className={s.selectNoMatch}>No matches</div>
            )}
            {filtered.map(o => {
              const lbl = formatLabel ? formatLabel(o) : String(o);
              const isActive = String(o) === String(value);
              return (
                <div key={String(o)}
                  onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); onChange(o); setOpen(false); setSearch(''); }}
                  className={cx(s.selectOption, isActive && s.selectOptionActive)}
                >
                  <span>{lbl}</span>
                  {isActive && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#E5E7EB" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
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

function IntervalButtons({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node)) setOpen(false);
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
    <div className={s.selectWrap}>
      <span className={s.ctrlLabel}>Interval</span>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        className={cx(s.intervalBtn, open && s.selectBtnOpen)}
      >
        <span>{value.label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className={cx(s.selectChevron, open && s.selectChevronOpen)}>
          <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div ref={dropRef} className={s.intervalDropdown} style={{ top: pos.top, left: pos.left }}>
          {INTERVALS.map(iv => {
            const isActive = iv.value === value.value;
            return (
              <div key={iv.value}
                onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); onChange(iv); setOpen(false); }}
                className={cx(s.intervalOption, isActive && s.intervalOptionActive)}
              >
                <span>{iv.label}</span>
                {isActive && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#E5E7EB" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// Toggle group for CE/PE/OI visibility — unified pill container
function ToggleGroup({ items }: { items: { label: string; active: boolean; color: string; onClick: () => void }[] }) {
  return (
    <div className={s.toggleGroup}>
      {items.map(({ label, active, color, onClick }) => (
        <button
          key={label}
          type="button"
          onClick={onClick}
          className={s.toggleBtn}
          style={{
            fontWeight: active ? 600 : 400,
            background: active ? color + '22' : 'transparent',
            color: active ? color : '#9CA3AF',
            boxShadow: active ? `0 0 0 1px ${color}44` : 'none',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Multi-expiry picker — searchable dropdown with checkboxes
function MultiExpiryPicker({ expiries, selected, onChange, disabled }: {
  expiries: number[]; selected: number[]; onChange: (v: number[]) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const toggle = (exp: number) =>
    selected.includes(exp)
      ? onChange(selected.filter(x => x !== exp))
      : onChange([...selected, exp].sort((a, b) => a - b));

  const filtered = expiries.filter(e => search === '' || fmtExpiry(e).toLowerCase().includes(search.toLowerCase()));

  const label = selected.length === 0 ? null
    : selected.length === 1 ? fmtExpiry(selected[0])
    : `${selected.length} expiries`;

  const isDisabled = disabled || expiries.length === 0;

  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef2 = useRef<HTMLButtonElement>(null);
  const dropRef2 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h2 = (e: MouseEvent) => {
      if (!btnRef2.current?.contains(e.target as Node) && !dropRef2.current?.contains(e.target as Node)) { setOpen(false); setSearch(''); }
    };
    document.addEventListener('mousedown', h2);
    return () => document.removeEventListener('mousedown', h2);
  }, []);

  const handleOpen2 = () => {
    if (isDisabled) return;
    if (!open && btnRef2.current) {
      const r = btnRef2.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  return (
    <div className={s.multiPickerWrap}>
      <span className={s.ctrlLabel}>Expiries</span>
      <button
        ref={btnRef2}
        type="button"
        onClick={handleOpen2}
        className={cx(
          s.multiPickerBtn,
          open ? s.multiPickerBtnOpen : s.multiPickerBtnClosed,
          isDisabled ? s.multiPickerBtnDisabled : s.multiPickerBtnEnabled,
          label ? s.multiPickerBtnHasValue : s.multiPickerBtnEmpty,
        )}
      >
        <span className={s.multiPickerBtnText}>
          {label ?? 'Select expiries'}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" className={s.multiPickerChevron}>
          <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div ref={dropRef2} className={s.multiPickerDropdown} style={{ top: pos.top, left: pos.left }}>
          <div className={s.multiPickerSearchWrap}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search expiry…"
              className={s.multiPickerSearchInput}
            />
          </div>

          <div className={s.multiPickerList}>
            {filtered.length === 0 && (
              <div className={s.multiPickerNoMatch}>No matches</div>
            )}
            {filtered.map(exp => {
              const isSel = selected.includes(exp);
              return (
                <div key={exp} onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); toggle(exp); }}
                  className={cx(s.multiPickerRow, isSel && s.multiPickerRowSelected)}>
                  <span className={cx(s.pickerCheckbox, isSel ? s.pickerCheckboxChecked : s.pickerCheckboxUnchecked)}>
                    {isSel && <span className={s.pickerCheckTick}>✓</span>}
                  </span>
                  <span className={cx(s.pickerLabel, isSel ? s.pickerLabelSelected : s.pickerLabelDefault)}>
                    {fmtExpiry(exp)}
                  </span>
                </div>
              );
            })}
          </div>

          {selected.length > 0 && (
            <div className={s.multiPickerFooter}>
              <button
                type="button"
                onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); onChange([]); setOpen(false); setSearch(''); }}
                className={s.clearBtn}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 7h14m-9 3v8m4-8v8M10 3h4a1 1 0 0 1 1 1v3H9V4a1 1 0 0 1 1-1ZM6 7h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7Z"/>
                </svg>
                Clear all
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

// Multi-strike picker — searchable dropdown with checkboxes
function MultiStrikePicker({ strikes, selected, onChange, disabled, highActivityStrikes }: {
  strikes: number[]; selected: number[]; onChange: (v: number[]) => void; disabled?: boolean;
  highActivityStrikes?: Set<number>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node)) { setOpen(false); setSearch(''); }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const toggle = (s: number) =>
    selected.includes(s)
      ? onChange(selected.filter(x => x !== s))
      : onChange([...selected, s].sort((a, b) => a - b));

  const filtered = strikes.filter(s => search === '' || String(s).includes(search));

  const label = selected.length === 0 ? null
    : selected.length === 1 ? String(selected[0])
    : `${selected.length} strikes`;

  const isDisabled = disabled || strikes.length === 0;

  const handleOpen = () => {
    if (isDisabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  return (
    <div className={s.multiPickerWrap}>
      <span className={s.ctrlLabel}>Strikes</span>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        className={cx(
          s.strikePickerBtn,
          open ? s.strikePickerBtnOpen : s.strikePickerBtnClosed,
          isDisabled ? s.multiPickerBtnDisabled : s.multiPickerBtnEnabled,
          label ? s.multiPickerBtnHasValue : s.multiPickerBtnEmpty,
        )}
      >
        <span className={s.multiPickerBtnText}>
          {label ?? 'Select strikes'}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className={s.multiPickerChevron}>
          <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div ref={dropRef} className={s.strikePickerDropdown} style={{ top: pos.top, left: pos.left }}>
          <div className={s.multiPickerSearchWrap}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search strike…"
              className={s.multiPickerSearchInput}
            />
          </div>

          <div className={s.multiPickerList}>
            {filtered.length === 0 && (
              <div className={s.multiPickerNoMatch}>No matches</div>
            )}
            {filtered.map(st => {
              const isHot = highActivityStrikes?.has(st);
              const isSel = selected.includes(st);
              const dot = isSel ? STRIKE_COLORS[selected.indexOf(st) % STRIKE_COLORS.length] : undefined;
              return (
                <div key={st} onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); toggle(st); }}
                  className={cx(s.strikeRow, isSel ? s.strikeRowSelected : isHot ? s.strikeRowHot : s.strikeRowNeutral)}>
                  <span className={cx(s.pickerCheckbox, isSel ? s.pickerCheckboxChecked : s.pickerCheckboxUnchecked)}>
                    {isSel && <span className={s.pickerCheckTick}>✓</span>}
                  </span>
                  <span className={isHot ? s.strikeLabelHot : isSel ? s.strikeLabelSelected : s.strikeLabelDefault}>{st}</span>
                  {isHot && <span className={s.hotBadge}>HOT</span>}
                  {dot && <span className={s.strikeDot} style={{ background: dot }} />}
                </div>
              );
            })}
          </div>

          {selected.length > 0 && (
            <div className={s.multiPickerFooter}>
              <button
                type="button"
                onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); onChange([]); setOpen(false); setSearch(''); }}
                className={s.clearBtn}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 7h14m-9 3v8m4-8v8M10 3h4a1 1 0 0 1 1 1v3H9V4a1 1 0 0 1 1-1ZM6 7h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7Z"/>
                </svg>
                Clear all
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Strike table (glide-data-grid) ───────────────────────────────────────────
const STRIKE_COLUMNS: GridColumn[] = [
  { title: 'Strike', width: 72, id: 'strike' },
  { title: 'LTP',   width: 68, id: 'ltp' },
  { title: 'OI',    width: 64, id: 'oi' },
  { title: 'IV',    width: 52, id: 'iv', grow: 1 },
];

const GRID_THEME = {
  bgCell:              'rgb(8,12,20)',
  bgCellMedium:        'rgb(10,14,24)',
  bgHeader:            'rgb(12,16,28)',
  bgHeaderHovered:     'rgba(255,255,255,0.05)',
  bgHeaderHasFocus:    'rgba(255,255,255,0.06)',
  bgBubble:            'rgba(255,255,255,0.08)',
  bgBubbleSelected:    'rgba(245,158,11,0.15)',
  bgSearchResult:      'rgba(245,158,11,0.10)',
  borderColor:         'rgba(255,255,255,0.05)',
  horizontalBorderColor: 'rgba(255,255,255,0.05)',
  headerFontStyle:     '700 12px',
  baseFontStyle:       '13px',
  fontFamily:          'ui-monospace, monospace',
  textDark:            '#ffffff',
  textMedium:          'rgba(255,255,255,0.55)',
  textLight:           'rgba(255,255,255,0.30)',
  textHeader:          '#ffffff',
  textHeaderSelected:  '#ffffff',
  textBubble:          '#fff',
  accentColor:         '#f59e0b',
  accentFg:            '#fff',
  accentLight:         'rgba(245,158,11,0.10)',
  cellHorizontalPadding: 10,
  cellVerticalPadding:   5,
  headerIconSize:      16,
  rowHeight:           30,
  headerHeight:        32,
  scrollbarSize:       5,
};

// Map of strike -> { ceKey, peKey }
type StrikeKeyMap = Map<number, { ceKey: string; peKey: string }>;

function fmt(n: number, decimals = 0): string {
  if (n === 0) return '—';
  if (n >= 1_00_000) return (n / 1_00_000).toFixed(1) + 'L';
  if (n >= 1_000)    return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(decimals);
}

// Compute high-activity strike set from live data (top strikes by combined OI)
function useHighActivityStrikes(
  strikes: number[],
  strikeKeyMap: StrikeKeyMap,
  liveMap: Map<string, any>,
): Set<number> {
  return useMemo(() => {
    if (strikes.length === 0) return new Set<number>();
    const scored: { strike: number; oi: number }[] = [];
    for (const strike of strikes) {
      const keys = strikeKeyMap.get(strike);
      if (!keys) continue;
      const ce = liveMap.get(keys.ceKey);
      const pe = liveMap.get(keys.peKey);
      const oi = (ce?.oi ?? 0) + (pe?.oi ?? 0);
      if (oi > 0) scored.push({ strike, oi });
    }
    if (scored.length === 0) return new Set<number>();
    scored.sort((a, b) => b.oi - a.oi);
    // Top 20% or at least top 3, whichever is larger
    const topN = Math.max(3, Math.ceil(scored.length * 0.2));
    const threshold = scored[Math.min(topN - 1, scored.length - 1)].oi;
    return new Set(scored.filter(s => s.oi >= threshold).map(s => s.strike));
  }, [strikes, strikeKeyMap, liveMap]);
}

function StrikeTable({
  strikes,
  selected,
  onToggle,
  strikeKeyMap,
  onHighActivityStrikes,
}: {
  strikes: number[];
  selected: number[];
  onToggle: (strike: number) => void;
  strikeKeyMap: StrikeKeyMap;
  onHighActivityStrikes?: (set: Set<number>) => void;
}) {
  // Collect all CE + PE instrument keys to subscribe
  const allKeys = useMemo(() => {
    const keys: string[] = [];
    for (const { ceKey, peKey } of strikeKeyMap.values()) {
      keys.push(ceKey, peKey);
    }
    return keys;
  }, [strikeKeyMap]);

  // Subscribe to live data via wsManager
  useEffect(() => {
    if (allKeys.length === 0) return;
    wsManager.requestKeys(allKeys);
  }, [allKeys]);

  // Get live map — re-renders on every tick for subscribed keys
  const liveMap = useMarketDataMap(allKeys);

  // Compute high-activity strikes
  const highActivity = useHighActivityStrikes(strikes, strikeKeyMap, liveMap);

  // Notify parent of high-activity strikes (for MultiStrikePicker auto-scroll)
  const prevHighRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (onHighActivityStrikes && highActivity.size > 0 && highActivity !== prevHighRef.current) {
      prevHighRef.current = highActivity;
      onHighActivityStrikes(highActivity);
    }
  }, [highActivity, onHighActivityStrikes]);

  const getCellContent = useCallback((cell: Item): GridCell => {
    const [col, row] = cell;
    const strike = strikes[row];
    if (strike == null) return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false };
    const isSelected = selected.includes(strike);
    const isHot = highActivity.has(strike);
    const keys = strikeKeyMap.get(strike);

    const selTheme = isSelected ? { textDark: '#f59e0b', bgCell: 'rgba(245,158,11,0.10)' } : undefined;
    const hotTheme = !isSelected && isHot ? { bgCell: 'rgba(251,191,36,0.06)' } : undefined;
    const baseTheme = selTheme ?? hotTheme;

    if (col === 0) {
      return {
        kind: GridCellKind.Text,
        data: String(strike),
        displayData: (isHot ? '\u25CF ' : '') + strike.toLocaleString('en-IN'),
        allowOverlay: false,
        contentAlign: 'right',
        themeOverride: isSelected ? selTheme : isHot ? { textDark: '#fbbf24', ...(hotTheme ?? {}) } : undefined,
      };
    }

    // Cols 1-3: live data
    if (!keys) {
      return { kind: GridCellKind.Text, data: '—', displayData: '—', allowOverlay: false, contentAlign: 'right', themeOverride: baseTheme };
    }
    const ce = liveMap.get(keys.ceKey);
    const pe = liveMap.get(keys.peKey);

    if (col === 1) {
      // Straddle LTP = CE LTP + PE LTP
      const ltp = (ce?.ltp ?? 0) + (pe?.ltp ?? 0);
      return {
        kind: GridCellKind.Text,
        data: String(ltp),
        displayData: ltp > 0 ? ltp.toFixed(1) : '—',
        allowOverlay: false,
        contentAlign: 'right',
        themeOverride: { textDark: '#fcd34d', ...(baseTheme ?? {}) },
      };
    }

    if (col === 2) {
      // OI = CE OI + PE OI
      const oi = (ce?.oi ?? 0) + (pe?.oi ?? 0);
      return {
        kind: GridCellKind.Text,
        data: String(oi),
        displayData: oi > 0 ? fmt(oi) : '—',
        allowOverlay: false,
        contentAlign: 'right',
        themeOverride: { textDark: isHot ? '#fbbf24' : '#f59e0b', ...(baseTheme ?? {}) },
      };
    }

    // col === 3: IV = avg(CE IV, PE IV)
    const ceIV = ce?.iv ?? 0;
    const peIV = pe?.iv ?? 0;
    const iv = ceIV > 0 && peIV > 0 ? (ceIV + peIV) / 2 : ceIV || peIV;
    return {
      kind: GridCellKind.Text,
      data: String(iv),
      displayData: iv > 0 ? iv.toFixed(1) + '%' : '—',
      allowOverlay: false,
      contentAlign: 'right',
      themeOverride: { textDark: '#6ee7b7', ...(baseTheme ?? {}) },
    };
  }, [strikes, selected, strikeKeyMap, liveMap, highActivity]);

  const onCellClicked = useCallback((cell: Item) => {
    const [, row] = cell;
    if (strikes[row] != null) onToggle(strikes[row]);
  }, [strikes, onToggle]);

  return (
    <div className="glass-panel flex flex-col h-full rounded-xl overflow-hidden">
      {/* header */}
      <div className={`px-3 py-2.5 shrink-0 flex items-center gap-2 ${s.strikeTableHeader}`}>
        <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Strike Prices</span>
        {strikes.length > 0 && (
          <span className="text-[10px] text-white/20">{strikes.length}</span>
        )}
        {highActivity.size > 0 && (
          <span className="text-[10px] text-amber-400/60">{highActivity.size} active</span>
        )}
        {selected.length > 0 && (
          <span className={`ml-auto text-[10px] ${s.strikeTableSelCount}`}>{selected.length} sel</span>
        )}
      </div>

      {/* grid */}
      <div className="flex-1 min-h-0 relative">
        <DataEditor
          columns={STRIKE_COLUMNS}
          rows={strikes.length}
          getCellContent={getCellContent}
          onCellClicked={onCellClicked}
          theme={GRID_THEME as any}
          width="100%"
          height="100%"
          rowHeight={30}
          headerHeight={32}
          smoothScrollX
          smoothScrollY
          rowMarkers="none"
          verticalBorder={false}
          getCellsForSelection
        />
        {strikes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-white/20 pointer-events-none">
            Select underlying &amp; expiry
          </div>
        )}
      </div>
    </div>
  );
}

// ── Per-strike series store ───────────────────────────────────────────────────
interface StrikeStore {
  strike:    number;
  color:     string;
  ceKey:     string;
  peKey:     string;
  ceCandles: number[][];
  peCandles: number[][];
  cePrev:    number | null;
  pePrev:    number | null;
  // chart series
  premSeries: ISeriesApi<'Line'> | null;
  ceSeries:   ISeriesApi<'Line'> | null;
  peSeries:   ISeriesApi<'Line'> | null;
  oiSeries:   ISeriesApi<'Histogram'> | null;
}

// ── Multi-expiry straddle view ────────────────────────────────────────────────
function MultiExpiryView({ instruments, visible = true, toolbarSlot }: { instruments: Instrument[]; visible?: boolean; toolbarSlot?: Element | null }) {
  const underlyings = useMemo(() => getUnderlyings(instruments), [instruments]);

  const [underlying, setUnderlying] = useState('');
  const [strike, setStrike]         = useState<number | null>(null);
  const [selectedExpiries, setSelectedExpiries] = useState<number[]>([]);
  const [interval, setInterval]     = useState<Interval>(INTERVALS[1]);
  const [loading, setLoading]       = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [loadedExpiries, setLoadedExpiries] = useState<{ expiry: number; color: string }[]>([]);

  const expiries = useMemo(() => underlying ? getExpiries(instruments, underlying) : [], [instruments, underlying]);
  // All strikes across all selected expiries for this underlying
  const allStrikes = useMemo(() => {
    if (!underlying) return [];
    const set = new Set<number>();
    for (const ins of instruments)
      if (ins.underlying_symbol === underlying && ins.strike_price != null)
        set.add(ins.strike_price);
    return Array.from(set).sort((a, b) => a - b);
  }, [instruments, underlying]);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const intervalRef  = useRef<Interval>(interval);
  const fetchingRef  = useRef(false);

  // Per-expiry series store
  interface ExpiryStore {
    expiry:     number;
    color:      string;
    ceKey:      string;
    peKey:      string;
    ceCandles:  number[][];
    peCandles:  number[][];
    cePrev:     number | null;
    pePrev:     number | null;
    premSeries: ISeriesApi<'Line'> | null;
  }
  const storesRef = useRef<ExpiryStore[]>([]);

  // WS refs
  const meSessionRef     = useRef(0);
  const meRestLoadRef    = useRef(false);
  const meLiveCeLtp      = useRef<Map<number, number>>(new Map()); // expiry -> CE ltp
  const meLivePeLtp      = useRef<Map<number, number>>(new Map()); // expiry -> PE ltp
  const meLiveBarTime    = useRef(0);
  const meBarTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meBarScheduled   = useRef(false);
  const meWsUnsubs       = useRef<(() => void)[]>([]);

  // Boot chart — observe containerRef itself (it is flex-1 and directly resizes)
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const chart = createChart(el, CHART_OPTIONS);
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  // Interval change — resample existing data, no refetch
  useEffect(() => {
    intervalRef.current = interval;
    const chart = chartRef.current;
    if (!chart || storesRef.current.length === 0) return;
    let first: LineData[] | null = null;
    for (const s of storesRef.current) {
      const data = buildStrikeData(s.ceCandles, s.peCandles, interval.value);
      if (s.premSeries) { s.premSeries.setData(data.premium); if (!first && data.premium.length > 0) first = data.premium; }
    }
    if (first) zoomToEnd(chart, first);
    meLiveBarTime.current = 0;
    meBarScheduled.current = false;
    if (meBarTimerRef.current) { clearTimeout(meBarTimerRef.current); meBarTimerRef.current = null; }
  }, [interval]);

  const removeAllSeries = useCallback(() => {
    const chart = chartRef.current; if (!chart) return;
    for (const s of storesRef.current) {
      if (s.premSeries) { try { chart.removeSeries(s.premSeries); } catch {} }
    }
    storesRef.current = [];
  }, []);

  // Schedule silent bar-boundary refetch
  const scheduleBarRefetch = useCallback((mySession: number) => {
    if (meBarScheduled.current) return;
    meBarScheduled.current = true;
    const iv = intervalRef.current;
    const nowMs = Date.now();
    const nextBarMs = (snapToBarTime(nowMs, iv.value) + iv.value * 60) * 1000;
    const delay = nextBarMs - nowMs + 500;
    meBarTimerRef.current = setTimeout(async () => {
      if (mySession !== meSessionRef.current) return;
      meRestLoadRef.current = true;
      const stores = storesRef.current;
      if (!stores.length) { meRestLoadRef.current = false; meBarScheduled.current = false; scheduleBarRefetch(mySession); return; }
      try {
        const iv2 = intervalRef.current.value;
        const fetches = stores.flatMap(s => [fetchTodayCandles(s.ceKey, iv2), fetchTodayCandles(s.peKey, iv2)]);
        const results = await Promise.all(fetches);
        if (mySession !== meSessionRef.current) return;
        const wallBarSec = snapToBarTime(Date.now(), iv2);
        let first: LineData[] | null = null;
        for (let i = 0; i < stores.length; i++) {
          const store = stores[i];
          let ceC = results[i * 2].candles; let peC = results[i * 2 + 1].candles;
          if (ceC.length === 0 && results[i * 2].prevTimestamp) ceC = (await fetchCandlesRaw(store.ceKey, results[i * 2].prevTimestamp!, iv2)).candles;
          if (peC.length === 0 && results[i * 2 + 1].prevTimestamp) peC = (await fetchCandlesRaw(store.peKey, results[i * 2 + 1].prevTimestamp!, iv2)).candles;
          if (mySession !== meSessionRef.current) return;
          store.ceCandles = ceC; store.peCandles = peC;
          const data = buildStrikeData(ceC, peC, iv2);
          if (data.premium.length > 0 && Number(data.premium[data.premium.length - 1].time) === wallBarSec) data.premium.pop();
          if (store.premSeries) { store.premSeries.setData(data.premium); if (!first && data.premium.length > 0) first = data.premium; }
          const ceLtp = meLiveCeLtp.current.get(store.expiry) ?? 0;
          const peLtp = meLivePeLtp.current.get(store.expiry) ?? 0;
          if ((ceLtp + peLtp) > 0 && store.premSeries)
            try { store.premSeries.update({ time: wallBarSec as Time, value: ceLtp + peLtp }); } catch {}
        }
      } catch (err) { console.warn('[MultiExpiry] barRefetch failed', err); }
      finally { if (mySession === meSessionRef.current) meRestLoadRef.current = false; meBarScheduled.current = false; scheduleBarRefetch(mySession); }
    }, delay);
  }, []);

  const applyLive = useCallback((expiry: number, mySession: number) => {
    if (meSessionRef.current !== mySession) return;
    const ceLtp = meLiveCeLtp.current.get(expiry) ?? 0;
    const peLtp = meLivePeLtp.current.get(expiry) ?? 0;
    const prem = ceLtp + peLtp;
    if (prem <= 0) return;
    const barTimeSec = snapToBarTime(Date.now(), intervalRef.current.value) as Time;
    meLiveBarTime.current = Number(barTimeSec);
    const store = storesRef.current.find(s => s.expiry === expiry);
    if (!store?.premSeries) return;
    try { store.premSeries.update({ time: barTimeSec, value: prem }); } catch {}
    if (!meBarScheduled.current) scheduleBarRefetch(mySession);
  }, [scheduleBarRefetch]);

  // Infinite scroll
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const handler = (range: LogicalRange | null) => {
      if (!range || range.from > 10 || fetchingRef.current) return;
      const stores = storesRef.current;
      if (!stores.length || !stores.some(s => s.cePrev !== null || s.pePrev !== null)) return;
      fetchingRef.current = true;
      setLoadingMore(true);
      const iv = intervalRef.current.value;
      Promise.all(stores.flatMap(s => {
        const ps: Promise<void>[] = [];
        if (s.cePrev) ps.push(fetchCandlesRaw(s.ceKey, s.cePrev, iv).then(r => { s.ceCandles = [...r.candles, ...s.ceCandles]; s.cePrev = r.prevTimestamp; }));
        if (s.pePrev) ps.push(fetchCandlesRaw(s.peKey, s.pePrev, iv).then(r => { s.peCandles = [...r.candles, ...s.peCandles]; s.pePrev = r.prevTimestamp; }));
        return ps;
      })).then(() => {
        const iv2 = intervalRef.current.value;
        for (const s of storesRef.current) {
          const data = buildStrikeData(s.ceCandles, s.peCandles, iv2);
          if (s.premSeries) s.premSeries.setData(data.premium);
        }
      }).catch(() => {}).finally(() => { fetchingRef.current = false; setLoadingMore(false); });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  }, []);

  const handleLoad = useCallback(async () => {
    if (!underlying || !strike || selectedExpiries.length === 0) return;
    const chart = chartRef.current; if (!chart) return;

    meWsUnsubs.current.forEach(u => u()); meWsUnsubs.current = [];
    meBarScheduled.current = false;
    if (meBarTimerRef.current) { clearTimeout(meBarTimerRef.current); meBarTimerRef.current = null; }
    meLiveCeLtp.current = new Map(); meLivePeLtp.current = new Map();
    meLiveBarTime.current = 0;
    const mySession = ++meSessionRef.current;
    meRestLoadRef.current = true;

    removeAllSeries();
    fetchingRef.current = false;
    setError(null); setLoadedExpiries([]);

    // Build defs: for each expiry find CE+PE key at the chosen strike
    const defs: { expiry: number; ceKey: string; peKey: string; color: string }[] = [];
    for (let i = 0; i < selectedExpiries.length; i++) {
      const exp = selectedExpiries[i];
      const ceKey = findKey(instruments, underlying, exp, strike, 'CE');
      const peKey = findKey(instruments, underlying, exp, strike, 'PE');
      if (!ceKey || !peKey) { setError(`Keys not found for ${underlying} ${strike} exp ${fmtExpiry(exp)}`); meRestLoadRef.current = false; return; }
      defs.push({ expiry: exp, ceKey, peKey, color: STRIKE_COLORS[i % STRIKE_COLORS.length] });
    }

    setLoading(true);
    try {
      const iv = interval.value;
      const allResults = await Promise.all(defs.flatMap(d => [fetchTodayCandles(d.ceKey, iv), fetchTodayCandles(d.peKey, iv)]));
      const fallbacks  = await Promise.all(defs.flatMap((d, i) => {
        const ceR = allResults[i * 2]; const peR = allResults[i * 2 + 1];
        return [
          ceR.candles.length === 0 && ceR.prevTimestamp ? fetchCandlesRaw(d.ceKey, ceR.prevTimestamp, iv) : Promise.resolve(null),
          peR.candles.length === 0 && peR.prevTimestamp ? fetchCandlesRaw(d.peKey, peR.prevTimestamp, iv) : Promise.resolve(null),
        ];
      }));

      const newStores: ExpiryStore[] = [];
      let first: LineData[] | null = null;

      for (let i = 0; i < defs.length; i++) {
        const def = defs[i];
        const ceRes = allResults[i * 2]; const peRes = allResults[i * 2 + 1];
        const ceFall = fallbacks[i * 2]; const peFall = fallbacks[i * 2 + 1];
        const ceCandles = ceFall ? ceFall.candles : ceRes.candles;
        const peCandles = peFall ? peFall.candles : peRes.candles;
        const cePrev    = ceFall ? ceFall.prevTimestamp : ceRes.prevTimestamp;
        const pePrev    = peFall ? peFall.prevTimestamp : peRes.prevTimestamp;
        const data = buildStrikeData(ceCandles, peCandles, iv);
        const premSer = chart.addSeries(LineSeries, { color: def.color, lineWidth: 2, title: fmtExpiry(def.expiry) });
        premSer.setData(data.premium);
        if (!first && data.premium.length > 0) first = data.premium;
        newStores.push({ expiry: def.expiry, color: def.color, ceKey: def.ceKey, peKey: def.peKey, ceCandles, peCandles, cePrev, pePrev, premSeries: premSer });
      }

      storesRef.current = newStores;
      setLoadedExpiries(newStores.map(s => ({ expiry: s.expiry, color: s.color })));
      if (first) zoomToEnd(chart, first);

      const allKeys = defs.flatMap(d => [d.ceKey, d.peKey]);
      wsManager.requestKeys(allKeys);
      meRestLoadRef.current = false;
      const newUnsubs: (() => void)[] = [];
      for (const def of defs) {
        newUnsubs.push(
          wsManager.subscribe(def.ceKey, (md) => {
            if (meRestLoadRef.current || meSessionRef.current !== mySession) return;
            const ltp = md.ltp ?? 0; if (!ltp) return;
            meLiveCeLtp.current.set(def.expiry, ltp);
            applyLive(def.expiry, mySession);
          }),
          wsManager.subscribe(def.peKey, (md) => {
            if (meRestLoadRef.current || meSessionRef.current !== mySession) return;
            const ltp = md.ltp ?? 0; if (!ltp) return;
            meLivePeLtp.current.set(def.expiry, ltp);
            applyLive(def.expiry, mySession);
          }),
        );
      }
      meWsUnsubs.current = newUnsubs;
    } catch (e) {
      setError(String(e)); meRestLoadRef.current = false;
    } finally {
      setLoading(false);
    }
  }, [underlying, strike, selectedExpiries, interval, instruments, removeAllSeries, applyLive]);

  // ── Page visibility: release/re-request WS keys on tab switch ───────────────
  const mePrevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = mePrevVisibleRef.current;
    mePrevVisibleRef.current = visible;
    if (was && !visible) {
      meWsUnsubs.current.forEach(u => u()); meWsUnsubs.current = [];
      const keys = storesRef.current.flatMap(s => [s.ceKey, s.peKey]);
      if (keys.length > 0) wsManager.releaseKeys(keys);
    } else if (!was && visible && storesRef.current.length > 0) {
      const keys = storesRef.current.flatMap(s => [s.ceKey, s.peKey]);
      wsManager.requestKeys(keys);
      handleLoad();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const toolbarControls = (
    <>
      <UnderlyingInput underlyings={underlyings} value={underlying}
        onChange={v => { setUnderlying(v); setStrike(null); setSelectedExpiries([]); }} />

      <LabeledSelect label="Strike" value={strike} options={allStrikes}
        onChange={v => setStrike(v as number)} disabled={!underlying} />

      <MultiExpiryPicker
        expiries={expiries}
        selected={selectedExpiries}
        onChange={setSelectedExpiries}
        disabled={!underlying}
      />

      <IntervalButtons value={interval} onChange={setInterval} />

      <div className={s.showControlWrap}>
        <span className={s.ctrlLabelHidden}>_</span>
        <button
          onClick={handleLoad}
          disabled={loading || !underlying || !strike || selectedExpiries.length === 0}
          className={cx(s.loadBtnAmber, (loading || !underlying || !strike || selectedExpiries.length === 0) ? s.loadBtnAmberDisabled : '')}
        >
          {loading
            ? <><span className={s.spinnerWhite} />Loading…</>
            : <>
                Load Chart
                {selectedExpiries.length > 0 && (
                  <span className={s.countBadgeAmber}>{selectedExpiries.length}</span>
                )}
              </>
          }
        </button>
      </div>

      {error       && <span className="text-red-400 text-xs self-end">{error}</span>}
      {loadingMore && <span className={`text-xs self-end animate-pulse ${s.loadingMoreText}`}>Loading older data...</span>}

      {loadedExpiries.length > 0 && (
        <div className="flex flex-wrap gap-3 self-end ml-auto text-xs">
          {loadedExpiries.map(({ expiry, color }) => (
            <span key={expiry} className="flex items-center gap-2">
              <span className={s.legendLineSwatch} style={{ background: color }} />
              <span className={s.legendLabel}>{fmtExpiry(expiry)}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {toolbarSlot
        ? createPortal(toolbarControls, toolbarSlot)
        : <div className="glass-bar flex flex-wrap items-end px-5 py-3 shrink-0 relative z-10" style={{ gap: '18px' }}>{toolbarControls}</div>
      }
      <div ref={containerRef} className="flex-1 w-full" />
    </div>
  );
}

// ── Straddle multi-strike ─────────────────────────────────────────────────────
// Toggle bar shared between both views
function StraddleMulti({ instruments, straddleMode, visible = true, toolbarSlot }: { instruments: Instrument[]; straddleMode: 'single' | 'multi'; visible?: boolean; toolbarSlot?: Element | null }) {
  const viewMode = straddleMode;

  const underlyings = useMemo(() => getUnderlyings(instruments), [instruments]);

  const [underlying, setUnderlying] = useState('');
  const [expiry, setExpiry]         = useState<number | null>(null);
  const [strikes, setStrikes]       = useState<number[]>([]);
  const [selected, setSelected]     = useState<number[]>([]);
  const [interval, setInterval]     = useState<Interval>(INTERVALS[1]);
  const [loading, setLoading]       = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [loadedStrikes, setLoadedStrikes] = useState<{ strike: number; color: string }[]>([]);
  const [highActivityStrikes, setHighActivityStrikes] = useState<Set<number>>(new Set());

  // Map of strike -> CE/PE instrument keys (built whenever underlying+expiry change)
  const strikeKeyMap = useMemo<StrikeKeyMap>(() => {
    const map: StrikeKeyMap = new Map();
    if (!underlying || !expiry) return map;
    const ceMap = new Map<number, string>();
    const peMap = new Map<number, string>();
    for (const ins of instruments) {
      if (ins.underlying_symbol !== underlying || ins.expiry !== expiry || ins.strike_price == null) continue;
      if (ins.instrument_type === 'CE') ceMap.set(ins.strike_price, ins.instrument_key);
      else if (ins.instrument_type === 'PE') peMap.set(ins.strike_price, ins.instrument_key);
    }
    for (const strike of strikes) {
      const ceKey = ceMap.get(strike);
      const peKey = peMap.get(strike);
      if (ceKey && peKey) map.set(strike, { ceKey, peKey });
    }
    return map;
  }, [instruments, underlying, expiry, strikes]);

  // Visibility toggles
  const [showCE, setShowCE] = useState(false);
  const [showPE, setShowPE] = useState(false);
  const [showOI, setShowOI] = useState(false);
  const [showTable, setShowTable] = useState(true);

  const expiries = useMemo(() => underlying ? getExpiries(instruments, underlying) : [], [instruments, underlying]);

  useEffect(() => {
    setSelected([]);
    setStrikes(underlying && expiry ? getStrikes(instruments, underlying, expiry) : []);
  }, [instruments, underlying, expiry]);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const containerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (el && !chartRef.current) {
      const chart = createChart(el, CHART_OPTIONS);
      chartRef.current = chart;
    } else if (!el && chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }
  }, []);
  const storesRef    = useRef<StrikeStore[]>([]);
  const intervalRef  = useRef<Interval>(interval);
  const fetchingRef  = useRef(false);
  // Keep visibility state accessible inside callbacks without stale closure
  const showCERef = useRef(showCE);
  const showPERef = useRef(showPE);
  const showOIRef = useRef(showOI);
  useEffect(() => { showCERef.current = showCE; }, [showCE]);
  useEffect(() => { showPERef.current = showPE; }, [showPE]);
  useEffect(() => { showOIRef.current = showOI; }, [showOI]);

  // ── WS live update refs (StraddleMulti) ─────────────────────────────────────
  const smSessionRef          = useRef(0);
  const smRestLoadingRef      = useRef(false);
  const smLiveCeLtpRef        = useRef<Map<number, number>>(new Map());
  const smLivePeLtpRef        = useRef<Map<number, number>>(new Map());
  const smLiveBarTimeRef      = useRef(0); // last live bar time (seconds)
  const smBarRefetchTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smBarRefetchScheduled = useRef(false);
  const smWsUnsubs            = useRef<(() => void)[]>([]);


  // ── helpers to add/remove optional series on a store ─────────────────────
  const addCESeries = useCallback((chart: IChartApi, store: StrikeStore, data: StrikeSeriesData) => {
    if (store.ceSeries) return;
    const ser = chart.addSeries(LineSeries, {
      color: ceColor(store.color), lineWidth: 1, lineStyle: 2,
      title: `CE ${store.strike}`, lastValueVisible: true, priceLineVisible: false,
    });
    ser.setData(data.ce);
    store.ceSeries = ser;
  }, []);

  const removeCESeries = useCallback((chart: IChartApi, store: StrikeStore) => {
    if (!store.ceSeries) return;
    try { chart.removeSeries(store.ceSeries); } catch {}
    store.ceSeries = null;
  }, []);

  const addPESeries = useCallback((chart: IChartApi, store: StrikeStore, data: StrikeSeriesData) => {
    if (store.peSeries) return;
    const ser = chart.addSeries(LineSeries, {
      color: peColor(store.color), lineWidth: 1, lineStyle: 2,
      title: `PE ${store.strike}`, lastValueVisible: true, priceLineVisible: false,
    });
    ser.setData(data.pe);
    store.peSeries = ser;
  }, []);

  const removePESeries = useCallback((chart: IChartApi, store: StrikeStore) => {
    if (!store.peSeries) return;
    try { chart.removeSeries(store.peSeries); } catch {}
    store.peSeries = null;
  }, []);

  const addOISeries = useCallback((chart: IChartApi, store: StrikeStore, data: StrikeSeriesData) => {
    if (store.oiSeries) return;
    const ser = chart.addSeries(HistogramSeries, {
      priceScaleId: `oi-${store.strike}`,
      color: oiColor(store.color),
      title: `OI ${store.strike}`, lastValueVisible: true, priceLineVisible: false,
    });
    ser.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.82, bottom: 0 } });
    ser.setData(data.oi);
    store.oiSeries = ser;
  }, []);

  const removeOISeries = useCallback((chart: IChartApi, store: StrikeStore) => {
    if (!store.oiSeries) return;
    try { chart.removeSeries(store.oiSeries); } catch {}
    store.oiSeries = null;
  }, []);

  // ── Toggle CE visibility ──────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || storesRef.current.length === 0) return;
    for (const store of storesRef.current) {
      const data = buildStrikeData(store.ceCandles, store.peCandles, intervalRef.current.value);
      if (showCE) addCESeries(chart, store, data);
      else        removeCESeries(chart, store);
    }
  }, [showCE, addCESeries, removeCESeries]);

  // ── Toggle PE visibility ──────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || storesRef.current.length === 0) return;
    for (const store of storesRef.current) {
      const data = buildStrikeData(store.ceCandles, store.peCandles, intervalRef.current.value);
      if (showPE) addPESeries(chart, store, data);
      else        removePESeries(chart, store);
    }
  }, [showPE, addPESeries, removePESeries]);

  // ── Toggle OI visibility ──────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || storesRef.current.length === 0) return;
    for (const store of storesRef.current) {
      const data = buildStrikeData(store.ceCandles, store.peCandles, intervalRef.current.value);
      if (showOI) addOISeries(chart, store, data);
      else        removeOISeries(chart, store);
    }
  }, [showOI, addOISeries, removeOISeries]);

  // ── Interval change → resample, no fetch ─────────────────────────────────
  useEffect(() => {
    intervalRef.current = interval;
    const chart = chartRef.current;
    if (!chart || storesRef.current.length === 0) return;
    let firstPremium: LineData[] | null = null;
    for (const store of storesRef.current) {
      const data = buildStrikeData(store.ceCandles, store.peCandles, interval.value);
      if (store.premSeries) { store.premSeries.setData(data.premium); if (!firstPremium && data.premium.length > 0) firstPremium = data.premium; }
      if (store.ceSeries)   store.ceSeries.setData(data.ce);
      if (store.peSeries)   store.peSeries.setData(data.pe);
      if (store.oiSeries)   store.oiSeries.setData(data.oi);
    }
    if (firstPremium) zoomToEnd(chart, firstPremium);
    // Invalidate live bar state on interval change
    smLiveBarTimeRef.current = 0;
    smBarRefetchScheduled.current = false;
    if (smBarRefetchTimerRef.current) { clearTimeout(smBarRefetchTimerRef.current); smBarRefetchTimerRef.current = null; }
  }, [interval]);

  const removeAllSeries = useCallback(() => {
    const chart = chartRef.current; if (!chart) return;
    for (const store of storesRef.current) {
      [store.premSeries, store.ceSeries, store.peSeries, store.oiSeries].forEach(s => {
        if (s) { try { chart.removeSeries(s); } catch {} }
      });
    }
    storesRef.current = [];
  }, []);

  // ── WS live helpers (StraddleMulti) ─────────────────────────────────────────
  const smScheduleBarRefetch = useCallback((mySession: number) => {
    if (smBarRefetchScheduled.current) return;
    smBarRefetchScheduled.current = true;
    const iv = intervalRef.current;
    const nowMs = Date.now();
    const wallBarMs = snapToBarTime(nowMs, iv.value) * 1000;
    const nextBarMs = wallBarMs + iv.value * 60 * 1000;
    const delay = nextBarMs - nowMs + 500;

    smBarRefetchTimerRef.current = setTimeout(async () => {
      if (mySession !== smSessionRef.current) return;
      smRestLoadingRef.current = true;
      const stores = storesRef.current;
      if (!stores.length) { smRestLoadingRef.current = false; smBarRefetchScheduled.current = false; smScheduleBarRefetch(mySession); return; }
      try {
        // Re-fetch CE+PE candles for all loaded strikes in parallel
        const iv2 = intervalRef.current.value;
        const fetches = stores.flatMap(s => [fetchTodayCandles(s.ceKey, iv2), fetchTodayCandles(s.peKey, iv2)]);
        const results = await Promise.all(fetches);
        if (mySession !== smSessionRef.current) return;

        const wallBarSec = snapToBarTime(Date.now(), iv2);
        let firstPremium: LineData[] | null = null;

        for (let i = 0; i < stores.length; i++) {
          const store = stores[i];
          const ceRes = results[i * 2]; const peRes = results[i * 2 + 1];
          // Fallback for empty today candles
          let ceCandles = ceRes.candles;
          let peCandles = peRes.candles;
          if (ceCandles.length === 0 && ceRes.prevTimestamp) ceCandles = (await fetchCandlesRaw(store.ceKey, ceRes.prevTimestamp, iv2)).candles;
          if (peCandles.length === 0 && peRes.prevTimestamp) peCandles = (await fetchCandlesRaw(store.peKey, peRes.prevTimestamp, iv2)).candles;
          if (mySession !== smSessionRef.current) return;
          store.ceCandles = ceCandles; store.peCandles = peCandles;

          const data = buildStrikeData(ceCandles, peCandles, iv2);
          // Pop live/forming bar if REST already includes it
          if (data.premium.length > 0 && Number(data.premium[data.premium.length - 1].time) === wallBarSec) {
            data.premium.pop(); data.ce.pop(); data.pe.pop(); data.oi.pop();
          }
          if (store.premSeries) { store.premSeries.setData(data.premium); if (!firstPremium && data.premium.length > 0) firstPremium = data.premium; }
          if (store.ceSeries)   store.ceSeries.setData(data.ce);
          if (store.peSeries)   store.peSeries.setData(data.pe);
          if (store.oiSeries)   store.oiSeries.setData(data.oi);
          // Re-apply live bar for this strike
          const ceLtp = smLiveCeLtpRef.current.get(store.strike) ?? 0;
          const peLtp = smLivePeLtpRef.current.get(store.strike) ?? 0;
          if ((ceLtp + peLtp) > 0 && store.premSeries) {
            try { store.premSeries.update({ time: wallBarSec as Time, value: ceLtp + peLtp }); } catch { /* ignore */ }
          }
        }
        console.log('[StraddleMulti] barRefetch done');
      } catch (err) {
        console.warn('[StraddleMulti] barRefetch failed', err);
      } finally {
        if (mySession === smSessionRef.current) smRestLoadingRef.current = false;
        smBarRefetchScheduled.current = false;
        smScheduleBarRefetch(mySession);
      }
    }, delay);
  }, []);

  const smApplyLive = useCallback((strike: number, mySession: number) => {
    if (smSessionRef.current !== mySession) return;
    const ceLtp = smLiveCeLtpRef.current.get(strike) ?? 0;
    const peLtp = smLivePeLtpRef.current.get(strike) ?? 0;
    const livePremium = ceLtp + peLtp;
    if (livePremium <= 0) return;
    const barTimeSec = snapToBarTime(Date.now(), intervalRef.current.value) as Time;
    smLiveBarTimeRef.current = Number(barTimeSec);
    const store = storesRef.current.find(s => s.strike === strike);
    if (!store?.premSeries) return;
    try { store.premSeries.update({ time: barTimeSec, value: livePremium }); } catch { /* ignore */ }
    if (!smBarRefetchScheduled.current) smScheduleBarRefetch(mySession);
  }, [smScheduleBarRefetch]);

  // ── Infinite scroll ───────────────────────────────────────────────────────
  const setupScrollHandler = useCallback((chart: IChartApi) => {
    const handler = (range: LogicalRange | null) => {
      if (!range || range.from > 10) return;
      if (fetchingRef.current) return;
      const stores = storesRef.current;
      if (!stores.length || !stores.some(s => s.cePrev !== null || s.pePrev !== null)) return;

      fetchingRef.current = true;
      setLoadingMore(true);

      const iv = intervalRef.current.value;
      const fetches: Promise<void>[] = [];
      for (const store of stores) {
        if (store.cePrev !== null)
          fetches.push(fetchCandlesRaw(store.ceKey, store.cePrev, iv).then(({ candles, prevTimestamp }) => { store.ceCandles = [...candles, ...store.ceCandles]; store.cePrev = prevTimestamp; }));
        if (store.pePrev !== null)
          fetches.push(fetchCandlesRaw(store.peKey, store.pePrev, iv).then(({ candles, prevTimestamp }) => { store.peCandles = [...candles, ...store.peCandles]; store.pePrev = prevTimestamp; }));
      }

      Promise.all(fetches)
        .then(() => {
          const iv = intervalRef.current.value;
          for (const store of storesRef.current) {
            const data = buildStrikeData(store.ceCandles, store.peCandles, iv);
            if (store.premSeries) store.premSeries.setData(data.premium);
            if (store.ceSeries)   store.ceSeries.setData(data.ce);
            if (store.peSeries)   store.peSeries.setData(data.pe);
            if (store.oiSeries)   store.oiSeries.setData(data.oi);
          }
        })
        .catch(() => {})
        .finally(() => { fetchingRef.current = false; setLoadingMore(false); });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  }, []);

  // ── Load ──────────────────────────────────────────────────────────────────
  const handleLoad = useCallback(async () => {
    if (!underlying || !expiry || selected.length === 0) return;
    const chart = chartRef.current; if (!chart) return;

    // Tear down previous WS subscriptions and live state
    smWsUnsubs.current.forEach(u => u()); smWsUnsubs.current = [];
    smBarRefetchScheduled.current = false;
    if (smBarRefetchTimerRef.current) { clearTimeout(smBarRefetchTimerRef.current); smBarRefetchTimerRef.current = null; }
    smLiveCeLtpRef.current = new Map(); smLivePeLtpRef.current = new Map();
    smLiveBarTimeRef.current = 0;
    const mySession = ++smSessionRef.current;
    smRestLoadingRef.current = true;

    removeAllSeries();
    fetchingRef.current = false;
    setError(null); setLoadedStrikes([]);

    const strikeDefs: { strike: number; ceKey: string; peKey: string; color: string }[] = [];
    for (let i = 0; i < selected.length; i++) {
      const strike = selected[i];
      const ceKey = findKey(instruments, underlying, expiry, strike, 'CE');
      const peKey = findKey(instruments, underlying, expiry, strike, 'PE');
      if (!ceKey || !peKey) { setError(`Keys not found for strike ${strike}`); smRestLoadingRef.current = false; return; }
      strikeDefs.push({ strike, ceKey, peKey, color: STRIKE_COLORS[i % STRIKE_COLORS.length] });
    }

    setLoading(true);
    try {
      const iv = interval.value;
      const allResults = await Promise.all(strikeDefs.flatMap(d => [fetchTodayCandles(d.ceKey, iv), fetchTodayCandles(d.peKey, iv)]));
      const fallbacks  = await Promise.all(strikeDefs.flatMap((d, i) => {
        const ceR = allResults[i * 2]; const peR = allResults[i * 2 + 1];
        return [
          ceR.candles.length === 0 && ceR.prevTimestamp ? fetchCandlesRaw(d.ceKey, ceR.prevTimestamp, iv) : Promise.resolve(null),
          peR.candles.length === 0 && peR.prevTimestamp ? fetchCandlesRaw(d.peKey, peR.prevTimestamp, iv) : Promise.resolve(null),
        ];
      }));

      const newStores: StrikeStore[] = [];
      let firstPremium: LineData[] | null = null;

      for (let i = 0; i < strikeDefs.length; i++) {
        const def    = strikeDefs[i];
        const ceRes  = allResults[i * 2];  const peRes  = allResults[i * 2 + 1];
        const ceFall = fallbacks[i * 2];   const peFall = fallbacks[i * 2 + 1];
        const ceCandles = ceFall ? ceFall.candles : ceRes.candles;
        const peCandles = peFall ? peFall.candles : peRes.candles;
        const cePrev    = ceFall ? ceFall.prevTimestamp : ceRes.prevTimestamp;
        const pePrev    = peFall ? peFall.prevTimestamp : peRes.prevTimestamp;

        const data = buildStrikeData(ceCandles, peCandles, interval.value);

        // Premium line — always shown
        const premSer = chart.addSeries(LineSeries, { color: def.color, lineWidth: 2, title: `${def.strike}` });
        premSer.setData(data.premium);
        if (!firstPremium && data.premium.length > 0) firstPremium = data.premium;

        const store: StrikeStore = {
          strike: def.strike, color: def.color,
          ceKey: def.ceKey, peKey: def.peKey,
          ceCandles, peCandles, cePrev, pePrev,
          premSeries: premSer, ceSeries: null, peSeries: null, oiSeries: null,
        };

        // Add optional series if toggles are already on
        if (showCERef.current) addCESeries(chart, store, data);
        if (showPERef.current) addPESeries(chart, store, data);
        if (showOIRef.current) addOISeries(chart, store, data);

        newStores.push(store);
      }

      storesRef.current = newStores;
      setLoadedStrikes(newStores.map(s => ({ strike: s.strike, color: s.color })));
      if (firstPremium) zoomToEnd(chart, firstPremium);

      // Subscribe WS for all loaded strikes
      const allKeys = strikeDefs.flatMap(d => [d.ceKey, d.peKey]);
      wsManager.requestKeys(allKeys);
      smRestLoadingRef.current = false;
      const newUnsubs: (() => void)[] = [];
      for (const def of strikeDefs) {
        newUnsubs.push(
          wsManager.subscribe(def.ceKey, (md) => {
            if (smRestLoadingRef.current || smSessionRef.current !== mySession) return;
            const ltp = md.ltp ?? 0; if (!ltp) return;
            smLiveCeLtpRef.current.set(def.strike, ltp);
            smApplyLive(def.strike, mySession);
          }),
          wsManager.subscribe(def.peKey, (md) => {
            if (smRestLoadingRef.current || smSessionRef.current !== mySession) return;
            const ltp = md.ltp ?? 0; if (!ltp) return;
            smLivePeLtpRef.current.set(def.strike, ltp);
            smApplyLive(def.strike, mySession);
          }),
        );
      }
      smWsUnsubs.current = newUnsubs;
    } catch (e) {
      setError(String(e)); smRestLoadingRef.current = false;
    } finally {
      setLoading(false);
    }
  }, [underlying, expiry, selected, interval, instruments, removeAllSeries, addCESeries, addPESeries, addOISeries, smApplyLive]);

  // ── Page visibility: release/re-request WS keys on tab switch ───────────────
  const smPrevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = smPrevVisibleRef.current;
    smPrevVisibleRef.current = visible;
    if (was && !visible) {
      smWsUnsubs.current.forEach(u => u()); smWsUnsubs.current = [];
      const keys = storesRef.current.flatMap(s => [s.ceKey, s.peKey]);
      if (keys.length > 0) wsManager.releaseKeys(keys);
    } else if (!was && visible && storesRef.current.length > 0) {
      const keys = storesRef.current.flatMap(s => [s.ceKey, s.peKey]);
      wsManager.requestKeys(keys);
      handleLoad();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    return setupScrollHandler(chart);
  }, [setupScrollHandler]);

  if (viewMode === 'multi') {
    return (
      <div className="flex flex-col h-full min-w-0 overflow-hidden">
        <div className="flex-1 overflow-hidden min-h-0 min-w-0">
          <MultiExpiryView instruments={instruments} visible={visible} toolbarSlot={toolbarSlot} />
        </div>
      </div>
    );
  }

  const singleToolbarControls = (
    <>
      <UnderlyingInput underlyings={underlyings} value={underlying}
        onChange={v => { setUnderlying(v); setExpiry(null); setSelected([]); }} />

      <LabeledSelect label="Expiry" value={expiry} options={expiries}
        onChange={v => { startTransition(() => { setExpiry(v as number); setSelected([]); }); }}
        formatLabel={v => fmtExpiry(v as number)} disabled={!underlying} />

      <MultiStrikePicker strikes={strikes} selected={selected} onChange={setSelected} disabled={!expiry} highActivityStrikes={highActivityStrikes} />

      <IntervalButtons value={interval} onChange={setInterval} />

      <div className={s.showControlWrap}>
        <span className={s.ctrlLabel}>Show</span>
        <ToggleGroup items={[
          { label: 'CE LTP', active: showCE, color: '#34d399', onClick: () => setShowCE(v => !v) },
          { label: 'PE LTP', active: showPE, color: '#f87171', onClick: () => setShowPE(v => !v) },
          { label: 'OI',     active: showOI, color: '#f59e0b', onClick: () => setShowOI(v => !v) },
        ]} />
      </div>

      <div className={s.selectWrap}>
        <span className={s.ctrlLabelHidden}>_</span>
        <button
          onClick={handleLoad}
          disabled={loading || !underlying || !expiry || selected.length === 0}
          className={cx(s.loadBtnGhost, (loading || !underlying || !expiry || selected.length === 0) && s.loadBtnGhostDisabled)}
        >
          {loading
            ? <><span className={s.spinnerFaint} />Loading…</>
            : <>
                Load Chart
                {selected.length > 0 && (
                  <span className={s.countBadgeGhost}>{selected.length}</span>
                )}
              </>
          }
        </button>
      </div>

      {error      && <span className="text-red-400 text-xs self-end">{error}</span>}
      {loadingMore && <span className={`text-xs self-end animate-pulse ${s.loadingMoreText}`}>Loading older data...</span>}

      {loadedStrikes.length > 0 && (
        <div className="flex flex-wrap gap-3 self-end ml-auto text-xs">
          {loadedStrikes.map(({ strike, color }) => (
            <span key={strike} className="flex items-center gap-2">
              <span className={s.legendLineSwatch} style={{ background: color }} />
              <span className="text-white/70">{strike}</span>
              {showCE && <span className={`text-[10px] ${s.legendCeLabel}`} style={{ color: ceColor(color) }}>CE</span>}
              {showPE && <span className="text-[10px] text-red-300/70">PE</span>}
              {showOI && <span className={`text-[10px] ${s.legendOiLabel}`}>OI</span>}
            </span>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {toolbarSlot
        ? createPortal(singleToolbarControls, toolbarSlot)
        : <div className="glass-bar flex flex-nowrap items-end px-5 py-3 shrink-0 relative z-10 overflow-x-auto" style={{ gap: '18px' }}>{singleToolbarControls}</div>
      }

      {/* Split: left = strike table, right = chart */}
      <div className="flex-1 flex gap-2 p-2 overflow-hidden" style={{ minHeight: 0 }}>
        {/* table + toggle button */}
        <div className="flex shrink-0 items-stretch">
          {/* animated table panel */}
          <div className={s.tablePanel} style={{ width: showTable ? 300 : 0 }}>
            <div className={s.tableInner + ' rounded-xl overflow-hidden'}>
              <StrikeTable
                strikes={strikes}
                selected={selected}
                strikeKeyMap={strikeKeyMap}
                onToggle={st =>
                  setSelected(prev =>
                    prev.includes(st) ? prev.filter(x => x !== st) : [...prev, st].sort((a, b) => a - b)
                  )
                }
                onHighActivityStrikes={setHighActivityStrikes}
              />
            </div>
          </div>
          {/* collapse/expand toggle */}
          <div className={s.collapseToggleWrap}>
            <button
              onClick={() => setShowTable(v => !v)}
              title={showTable ? 'Hide table' : 'Show table'}
              className={s.collapseToggleBtn}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                className={s.collapseIcon}
                style={{ transform: showTable ? 'rotate(0deg)' : 'rotate(180deg)' }}>
                <path d="M7 2L3 5L7 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
        {/* chart */}
        <div className={`glass-panel flex-1 rounded-xl relative ${s.chartPanel}`}>
          <div ref={containerCallbackRef} className={s.chartInset} />
        </div>
      </div>
    </div>
  );
}

// ── Strangle ──────────────────────────────────────────────────────────────────
function StrangleView({ instruments, visible = true, toolbarSlot }: { instruments: Instrument[]; visible?: boolean; toolbarSlot?: Element | null }) {
  const underlyings = useMemo(() => getUnderlyings(instruments), [instruments]);

  const [underlying, setUnderlying] = useState('');
  const [expiry, setExpiry]         = useState<number | null>(null);
  const [strikeA, setStrikeA]       = useState<number | null>(null);
  const [strikeB, setStrikeB]       = useState<number | null>(null);
  const [interval, setInterval]     = useState<Interval>(INTERVALS[1]);
  const [loading, setLoading]       = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const expiries = useMemo(() => underlying ? getExpiries(instruments, underlying) : [], [instruments, underlying]);
  const strikes  = useMemo(() => underlying && expiry ? getStrikes(instruments, underlying, expiry) : [], [instruments, underlying, expiry]);

  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const premSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ceSeriesRef   = useRef<ISeriesApi<'Line'> | null>(null);
  const peSeriesRef   = useRef<ISeriesApi<'Line'> | null>(null);
  const oiSeriesRef   = useRef<ISeriesApi<'Histogram'> | null>(null);
  const volSeriesRef  = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ceCandlesRef  = useRef<number[][]>([]);
  const peCandlesRef  = useRef<number[][]>([]);
  const prevTsRef     = useRef<[number | null, number | null]>([null, null]);
  const keysRef       = useRef<{ ceKey: string; peKey: string } | null>(null);
  const intervalRef   = useRef<Interval>(interval);
  const fetchingRef   = useRef(false);

  // ── WS live update refs ─────────────────────────────────────────────────────
  const svSessionRef          = useRef(0);
  const svRestLoadingRef      = useRef(false);
  const svLiveCeLtpRef        = useRef(0);
  const svLivePeLtpRef        = useRef(0);
  const svLivePremBarRef      = useRef<{ time: Time; value: number } | null>(null);
  const svLastRestTimeRef     = useRef(0);
  const svBarRefetchTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const svBarRefetchScheduled = useRef(false);
  const svWsUnsubs            = useRef<(() => void)[]>([]);

  // Boot chart — observe containerRef itself (flex-1, directly resizes)
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const chart = createChart(el, CHART_OPTIONS);
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  useEffect(() => {
    intervalRef.current = interval;
    const chart = chartRef.current;
    if (!chart || ceCandlesRef.current.length === 0) return;
    const { premium, ce, pe, oi, volume } = buildStraddleSeries(ceCandlesRef.current, peCandlesRef.current, interval.value);
    if (premSeriesRef.current) premSeriesRef.current.setData(premium);
    if (ceSeriesRef.current)   ceSeriesRef.current.setData(ce);
    if (peSeriesRef.current)   peSeriesRef.current.setData(pe);
    if (oiSeriesRef.current)   oiSeriesRef.current.setData(oi);
    if (volSeriesRef.current)  volSeriesRef.current.setData(volume);
    if (premium.length > 0) zoomToEnd(chart, premium);
    // Invalidate live bar — interval changed, bar time no longer valid
    svLivePremBarRef.current = null;
    svBarRefetchScheduled.current = false;
    if (svBarRefetchTimerRef.current) { clearTimeout(svBarRefetchTimerRef.current); svBarRefetchTimerRef.current = null; }
    // Update cached last REST time for new interval
    svLastRestTimeRef.current = premium.length > 0 ? Number(premium[premium.length - 1].time) : 0;
    // Re-apply live bar with new interval time (next WS tick will fire it)
  }, [interval]);

  // ── WS live helpers (StrangleView) ─────────────────────────────────────────
  const svScheduleBarRefetch = useCallback((mySession: number) => {
    if (svBarRefetchScheduled.current) return;
    svBarRefetchScheduled.current = true;
    const iv = intervalRef.current;
    const nowMs = Date.now();
    const wallBarMs = snapToBarTime(nowMs, iv.value) * 1000;
    const nextBarMs = wallBarMs + iv.value * 60 * 1000;
    const delay = nextBarMs - nowMs + 500;

    svBarRefetchTimerRef.current = setTimeout(async () => {
      if (mySession !== svSessionRef.current) return;
      svRestLoadingRef.current = true;
      const keys = keysRef.current;
      if (!keys) { svRestLoadingRef.current = false; return; }
      try {
        const iv2 = intervalRef.current.value;
        const [ceRes, peRes] = await Promise.all([
          fetchTodayCandles(keys.ceKey, iv2),
          fetchTodayCandles(keys.peKey, iv2),
        ]);
        if (mySession !== svSessionRef.current) return;
        if (ceRes.candles.length > 0) ceCandlesRef.current = ceRes.candles;
        else if (ceRes.prevTimestamp) ceCandlesRef.current = (await fetchCandlesRaw(keys.ceKey, ceRes.prevTimestamp, iv2)).candles;
        if (peRes.candles.length > 0) peCandlesRef.current = peRes.candles;
        else if (peRes.prevTimestamp) peCandlesRef.current = (await fetchCandlesRaw(keys.peKey, peRes.prevTimestamp, iv2)).candles;
        if (mySession !== svSessionRef.current) return;
        const { premium, ce, pe, oi, volume } = buildStraddleSeries(ceCandlesRef.current, peCandlesRef.current, iv2);
        const wallBarSec = snapToBarTime(Date.now(), intervalRef.current.value);
        if (premium.length > 0 && Number(premium[premium.length - 1].time) === wallBarSec) {
          premium.pop(); ce.pop(); pe.pop(); oi.pop(); volume.pop();
        }
        svLastRestTimeRef.current = premium.length > 0 ? Number(premium[premium.length - 1].time) : 0;
        if (premSeriesRef.current) premSeriesRef.current.setData(premium);
        if (ceSeriesRef.current)   ceSeriesRef.current.setData(ce);
        if (peSeriesRef.current)   peSeriesRef.current.setData(pe);
        if (oiSeriesRef.current)   oiSeriesRef.current.setData(oi);
        if (volSeriesRef.current)  volSeriesRef.current.setData(volume);
        const live = svLivePremBarRef.current;
        if (live && premSeriesRef.current) try { premSeriesRef.current.update(live); } catch { /* ignore */ }
        console.log('[StrangleView] barRefetch done');
      } catch (err) {
        console.warn('[StrangleView] barRefetch failed', err);
      } finally {
        if (mySession === svSessionRef.current) svRestLoadingRef.current = false;
        svBarRefetchScheduled.current = false;
        svScheduleBarRefetch(mySession); // re-schedule for next bar boundary
      }
    }, delay);
  }, []);

  const svApplyLive = useCallback((mySession: number) => {
    if (svSessionRef.current !== mySession) return;
    const livePremium = svLiveCeLtpRef.current + svLivePeLtpRef.current;
    if (livePremium <= 0) return;
    const barTimeSec = snapToBarTime(Date.now(), intervalRef.current.value) as Time;
    if (Number(barTimeSec) < svLastRestTimeRef.current) return;
    const liveBar = { time: barTimeSec, value: livePremium };
    svLivePremBarRef.current = liveBar;
    if (premSeriesRef.current) try { premSeriesRef.current.update(liveBar); } catch { /* ignore */ }
    if (!svBarRefetchScheduled.current) svScheduleBarRefetch(mySession);
  }, [svScheduleBarRefetch]);

  const removeSeries = useCallback(() => {
    const chart = chartRef.current; if (!chart) return;
    [premSeriesRef, ceSeriesRef, peSeriesRef, oiSeriesRef, volSeriesRef].forEach(r => {
      if (r.current) { try { chart.removeSeries(r.current); } catch {} r.current = null; }
    });
  }, []);

  const setupScrollHandler = useCallback((chart: IChartApi) => {
    const handler = (range: LogicalRange | null) => {
      if (!range || range.from > 10 || fetchingRef.current) return;
      const keys = keysRef.current; if (!keys) return;
      const [cePrev, pePrev] = prevTsRef.current;
      if (cePrev === null && pePrev === null) return;
      fetchingRef.current = true; setLoadingMore(true);
      const iv = intervalRef.current.value;
      const fetches: Promise<void>[] = [];
      if (cePrev !== null) fetches.push(fetchCandlesRaw(keys.ceKey, cePrev, iv).then(({ candles, prevTimestamp }) => { ceCandlesRef.current = [...candles, ...ceCandlesRef.current]; prevTsRef.current[0] = prevTimestamp; }));
      if (pePrev !== null) fetches.push(fetchCandlesRaw(keys.peKey, pePrev, iv).then(({ candles, prevTimestamp }) => { peCandlesRef.current = [...candles, ...peCandlesRef.current]; prevTsRef.current[1] = prevTimestamp; }));
      Promise.all(fetches).then(() => {
        const { premium, ce, pe, oi, volume } = buildStraddleSeries(ceCandlesRef.current, peCandlesRef.current, intervalRef.current.value);
        if (premSeriesRef.current) premSeriesRef.current.setData(premium);
        if (ceSeriesRef.current)   ceSeriesRef.current.setData(ce);
        if (peSeriesRef.current)   peSeriesRef.current.setData(pe);
        if (oiSeriesRef.current)   oiSeriesRef.current.setData(oi);
        if (volSeriesRef.current)  volSeriesRef.current.setData(volume);
      }).catch(() => {}).finally(() => { fetchingRef.current = false; setLoadingMore(false); });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  }, []);

  const handleLoad = useCallback(async () => {
    if (!underlying || !expiry || !strikeA || !strikeB) return;
    const chart = chartRef.current; if (!chart) return;

    // Tear down previous WS subscriptions and live state
    svWsUnsubs.current.forEach(u => u()); svWsUnsubs.current = [];
    svBarRefetchScheduled.current = false;
    if (svBarRefetchTimerRef.current) { clearTimeout(svBarRefetchTimerRef.current); svBarRefetchTimerRef.current = null; }
    svLiveCeLtpRef.current = 0; svLivePeLtpRef.current = 0;
    svLivePremBarRef.current = null;
    const mySession = ++svSessionRef.current;
    svRestLoadingRef.current = true;

    removeSeries(); keysRef.current = null; prevTsRef.current = [null, null];
    ceCandlesRef.current = []; peCandlesRef.current = []; fetchingRef.current = false;

    const ceKey = findKey(instruments, underlying, expiry, strikeA, 'CE');
    const peKey = findKey(instruments, underlying, expiry, strikeB, 'PE');
    if (!ceKey || !peKey) { setError('Instrument keys not found'); svRestLoadingRef.current = false; return; }
    setLoading(true); setError(null);
    try {
      const iv = interval.value;
      const [ceRes, peRes] = await Promise.all([fetchTodayCandles(ceKey, iv), fetchTodayCandles(peKey, iv)]);
      let ceCandles = ceRes.candles; let peCandles = peRes.candles;
      let cePrev = ceRes.prevTimestamp; let pePrev = peRes.prevTimestamp;
      const fb = await Promise.all([
        ceCandles.length === 0 && cePrev ? fetchCandlesRaw(ceKey, cePrev, iv) : null,
        peCandles.length === 0 && pePrev ? fetchCandlesRaw(peKey, pePrev, iv) : null,
      ]);
      if (fb[0]) { ceCandles = fb[0].candles; cePrev = fb[0].prevTimestamp; }
      if (fb[1]) { peCandles = fb[1].candles; pePrev = fb[1].prevTimestamp; }
      ceCandlesRef.current = ceCandles; peCandlesRef.current = peCandles;
      prevTsRef.current = [cePrev, pePrev]; keysRef.current = { ceKey, peKey };

      const { premium, ce, pe, oi, volume } = buildStraddleSeries(ceCandles, peCandles, interval.value);
      const pSer = chart.addSeries(LineSeries, { color: '#facc15', lineWidth: 2, title: 'Premium' }); pSer.setData(premium); premSeriesRef.current = pSer;
      const ceSer = chart.addSeries(LineSeries, { color: '#34d399', lineWidth: 1, lineStyle: 1, title: `CE ${strikeA}` }); ceSer.setData(ce); ceSeriesRef.current = ceSer;
      const peSer = chart.addSeries(LineSeries, { color: '#f87171', lineWidth: 1, lineStyle: 1, title: `PE ${strikeB}` }); peSer.setData(pe); peSeriesRef.current = peSer;
      const oiSer = chart.addSeries(HistogramSeries, { priceScaleId: 'oi', title: 'OI (K)', lastValueVisible: true, priceLineVisible: false });
      oiSer.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.82, bottom: 0 } }); oiSer.setData(oi); oiSeriesRef.current = oiSer;
      const volSer = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', title: 'Vol (K)', lastValueVisible: true, priceLineVisible: false });
      volSer.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.70, bottom: 0.20 } }); volSer.setData(volume); volSeriesRef.current = volSer;
      if (premium.length > 0) zoomToEnd(chart, premium);

      // Cache last REST bar time and subscribe WS
      svLastRestTimeRef.current = premium.length > 0 ? Number(premium[premium.length - 1].time) : 0;
      wsManager.requestKeys([ceKey, peKey]);
      svRestLoadingRef.current = false;
      svWsUnsubs.current = [
        wsManager.subscribe(ceKey, (md) => {
          if (svRestLoadingRef.current || svSessionRef.current !== mySession) return;
          const ltp = md.ltp ?? 0; if (!ltp) return;
          svLiveCeLtpRef.current = ltp;
          svApplyLive(mySession);
        }),
        wsManager.subscribe(peKey, (md) => {
          if (svRestLoadingRef.current || svSessionRef.current !== mySession) return;
          const ltp = md.ltp ?? 0; if (!ltp) return;
          svLivePeLtpRef.current = ltp;
          svApplyLive(mySession);
        }),
      ];
    } catch (e) { setError(String(e)); svRestLoadingRef.current = false; } finally { setLoading(false); }
  }, [underlying, expiry, strikeA, strikeB, interval, instruments, removeSeries, svApplyLive]);

  // ── Page visibility: release/re-request WS keys on tab switch ───────────────
  const svPrevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = svPrevVisibleRef.current;
    svPrevVisibleRef.current = visible;
    if (was && !visible) {
      svWsUnsubs.current.forEach(u => u()); svWsUnsubs.current = [];
      const keys = keysRef.current ? [keysRef.current.ceKey, keysRef.current.peKey] : [];
      if (keys.length > 0) wsManager.releaseKeys(keys);
    } else if (!was && visible && keysRef.current) {
      wsManager.requestKeys([keysRef.current.ceKey, keysRef.current.peKey]);
      handleLoad();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => { const chart = chartRef.current; if (!chart) return; return setupScrollHandler(chart); }, [setupScrollHandler]);

  const strangleToolbarControls = (
    <>
      <UnderlyingInput underlyings={underlyings} value={underlying} onChange={v => { setUnderlying(v); setExpiry(null); setStrikeA(null); setStrikeB(null); }} />
      <LabeledSelect label="Expiry" value={expiry} options={expiries} onChange={v => { setExpiry(v as number); setStrikeA(null); setStrikeB(null); }} formatLabel={v => fmtExpiry(v as number)} disabled={!underlying} />
      <LabeledSelect label="CE Strike" value={strikeA} options={strikes} onChange={v => setStrikeA(v as number)} disabled={!expiry} />
      <LabeledSelect label="PE Strike" value={strikeB} options={strikes} onChange={v => setStrikeB(v as number)} disabled={!expiry} />
      <IntervalButtons value={interval} onChange={setInterval} />
      <div className={s.showControlWrap}>
        <span className={s.ctrlLabelHidden}>_</span>
        <button
          onClick={handleLoad}
          disabled={loading || !underlying || !expiry || !strikeA || !strikeB}
          className={cx(s.loadBtnAmber, (loading || !underlying || !expiry || !strikeA || !strikeB) ? s.loadBtnAmberDisabled : '')}
        >
          {loading ? <><span className={s.spinnerWhite} />Loading…</> : 'Load Chart'}
        </button>
      </div>
      {error       && <span className="text-red-400 text-xs self-end">{error}</span>}
      {loadingMore && <span className={`text-xs self-end animate-pulse ${s.loadingMoreText}`}>Loading older data...</span>}
      <div className="flex gap-3 self-end ml-auto text-xs">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 bg-yellow-400" /><span className="text-white/65">Premium</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 bg-emerald-400" /><span className="text-white/65">CE</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 bg-red-400" /><span className="text-white/65">PE</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: "rgba(245,158,11,0.6)" }} /><span className="text-white/65">OI</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm bg-yellow-400/40" /><span className="text-white/65">Vol</span></span>
      </div>
    </>
  );

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {toolbarSlot
        ? createPortal(strangleToolbarControls, toolbarSlot)
        : <div className="glass-bar flex flex-wrap items-end gap-4 px-5 py-3 relative z-10">{strangleToolbarControls}</div>
      }
      <div ref={containerRef} className="flex-1 w-full" />
    </div>
  );
}

// ── Calendar spread ───────────────────────────────────────────────────────────
function CalendarSpread({ instruments, visible = true, toolbarSlot }: { instruments: Instrument[]; visible?: boolean; toolbarSlot?: Element | null }) {
  const underlyings = useMemo(() => getUnderlyings(instruments), [instruments]);

  const [underlying, setUnderlying] = useState('');
  const [expiryNear, setExpiryNear] = useState<number | null>(null);
  const [expiryFar, setExpiryFar]   = useState<number | null>(null);
  const [strike, setStrike]         = useState<number | null>(null);
  const [interval, setInterval]     = useState<Interval>(INTERVALS[1]);
  const [loading, setLoading]       = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const expiries    = useMemo(() => underlying ? getExpiries(instruments, underlying) : [], [instruments, underlying]);
  const farExpiries = useMemo(() => expiryNear ? expiries.filter(e => e > expiryNear) : expiries, [expiries, expiryNear]);
  const strikes     = useMemo(() => underlying && expiryNear ? getStrikes(instruments, underlying, expiryNear) : [], [instruments, underlying, expiryNear]);

  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const nearSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const farSeriesRef  = useRef<ISeriesApi<'Line'> | null>(null);
  const nearOIRef     = useRef<ISeriesApi<'Histogram'> | null>(null);
  const farOIRef      = useRef<ISeriesApi<'Histogram'> | null>(null);
  const nearCeCandlesRef = useRef<number[][]>([]);
  const nearPeCandlesRef = useRef<number[][]>([]);
  const farCeCandlesRef  = useRef<number[][]>([]);
  const farPeCandlesRef  = useRef<number[][]>([]);
  const prevTsRef  = useRef<[number | null, number | null, number | null, number | null]>([null, null, null, null]);
  const keysRef    = useRef<{ nearCeKey: string; nearPeKey: string; farCeKey: string; farPeKey: string } | null>(null);
  const intervalRef = useRef<Interval>(interval);
  const fetchingRef = useRef(false);

  // ── WS live update refs (CalendarSpread) ────────────────────────────────────
  const csSessionRef          = useRef(0);
  const csRestLoadingRef      = useRef(false);
  const csLiveNearCeLtpRef    = useRef(0);
  const csLiveNearPeLtpRef    = useRef(0);
  const csLiveFarCeLtpRef     = useRef(0);
  const csLiveFarPeLtpRef     = useRef(0);
  const csLiveNearBarRef      = useRef<{ time: Time; value: number } | null>(null);
  const csLiveFarBarRef       = useRef<{ time: Time; value: number } | null>(null);
  const csLastNearRestTimeRef = useRef(0);
  const csLastFarRestTimeRef  = useRef(0);
  const csBarRefetchTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const csBarRefetchScheduled = useRef(false);
  const csWsUnsubs            = useRef<(() => void)[]>([]);

  // Boot chart — observe containerRef itself (flex-1, directly resizes)
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const chart = createChart(el, CHART_OPTIONS);
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  useEffect(() => {
    intervalRef.current = interval;
    const chart = chartRef.current;
    if (!chart || nearCeCandlesRef.current.length === 0) return;
    const { near, far, nearOI, farOI } = buildCalendarSeries(nearCeCandlesRef.current, nearPeCandlesRef.current, farCeCandlesRef.current, farPeCandlesRef.current, interval.value);
    if (nearSeriesRef.current) nearSeriesRef.current.setData(near);
    if (farSeriesRef.current)  farSeriesRef.current.setData(far);
    if (nearOIRef.current)     nearOIRef.current.setData(nearOI);
    if (farOIRef.current)      farOIRef.current.setData(farOI);
    if (near.length > 0) zoomToEnd(chart, near);
    // Invalidate live bars on interval change
    csLiveNearBarRef.current = null; csLiveFarBarRef.current = null;
    csBarRefetchScheduled.current = false;
    if (csBarRefetchTimerRef.current) { clearTimeout(csBarRefetchTimerRef.current); csBarRefetchTimerRef.current = null; }
    csLastNearRestTimeRef.current = near.length > 0 ? Number(near[near.length - 1].time) : 0;
    csLastFarRestTimeRef.current  = far.length  > 0 ? Number(far[far.length - 1].time)  : 0;
  }, [interval]);

  // ── WS live helpers (CalendarSpread) ────────────────────────────────────────
  const csScheduleBarRefetch = useCallback((mySession: number) => {
    if (csBarRefetchScheduled.current) return;
    csBarRefetchScheduled.current = true;
    const iv = intervalRef.current;
    const nowMs = Date.now();
    const wallBarMs = snapToBarTime(nowMs, iv.value) * 1000;
    const nextBarMs = wallBarMs + iv.value * 60 * 1000;
    const delay = nextBarMs - nowMs + 500;

    csBarRefetchTimerRef.current = setTimeout(async () => {
      if (mySession !== csSessionRef.current) return;
      csRestLoadingRef.current = true;
      const keys = keysRef.current;
      if (!keys) { csRestLoadingRef.current = false; return; }
      try {
        const iv2 = intervalRef.current.value;
        const [ncRes, npRes, fcRes, fpRes] = await Promise.all([
          fetchTodayCandles(keys.nearCeKey, iv2), fetchTodayCandles(keys.nearPeKey, iv2),
          fetchTodayCandles(keys.farCeKey,  iv2), fetchTodayCandles(keys.farPeKey,  iv2),
        ]);
        if (mySession !== csSessionRef.current) return;
        if (ncRes.candles.length > 0) nearCeCandlesRef.current = ncRes.candles;
        else if (ncRes.prevTimestamp) nearCeCandlesRef.current = (await fetchCandlesRaw(keys.nearCeKey, ncRes.prevTimestamp, iv2)).candles;
        if (npRes.candles.length > 0) nearPeCandlesRef.current = npRes.candles;
        else if (npRes.prevTimestamp) nearPeCandlesRef.current = (await fetchCandlesRaw(keys.nearPeKey, npRes.prevTimestamp, iv2)).candles;
        if (fcRes.candles.length > 0) farCeCandlesRef.current = fcRes.candles;
        else if (fcRes.prevTimestamp) farCeCandlesRef.current = (await fetchCandlesRaw(keys.farCeKey, fcRes.prevTimestamp, iv2)).candles;
        if (fpRes.candles.length > 0) farPeCandlesRef.current = fpRes.candles;
        else if (fpRes.prevTimestamp) farPeCandlesRef.current = (await fetchCandlesRaw(keys.farPeKey, fpRes.prevTimestamp, iv2)).candles;
        if (mySession !== csSessionRef.current) return;
        const { near, far, nearOI, farOI } = buildCalendarSeries(
          nearCeCandlesRef.current, nearPeCandlesRef.current,
          farCeCandlesRef.current, farPeCandlesRef.current, iv2,
        );
        const wallBarSec = snapToBarTime(Date.now(), intervalRef.current.value);
        if (near.length > 0 && Number(near[near.length - 1].time) === wallBarSec) near.pop();
        if (far.length  > 0 && Number(far[far.length   - 1].time) === wallBarSec) far.pop();
        csLastNearRestTimeRef.current = near.length > 0 ? Number(near[near.length - 1].time) : 0;
        csLastFarRestTimeRef.current  = far.length  > 0 ? Number(far[far.length - 1].time)  : 0;
        if (nearSeriesRef.current) nearSeriesRef.current.setData(near);
        if (farSeriesRef.current)  farSeriesRef.current.setData(far);
        if (nearOIRef.current)     nearOIRef.current.setData(nearOI);
        if (farOIRef.current)      farOIRef.current.setData(farOI);
        if (csLiveNearBarRef.current && nearSeriesRef.current) try { nearSeriesRef.current.update(csLiveNearBarRef.current); } catch { /* ignore */ }
        if (csLiveFarBarRef.current  && farSeriesRef.current)  try { farSeriesRef.current.update(csLiveFarBarRef.current); } catch { /* ignore */ }
        console.log('[CalendarSpread] barRefetch done');
      } catch (err) {
        console.warn('[CalendarSpread] barRefetch failed', err);
      } finally {
        if (mySession === csSessionRef.current) csRestLoadingRef.current = false;
        csBarRefetchScheduled.current = false;
        csScheduleBarRefetch(mySession);
      }
    }, delay);
  }, []);

  const csApplyLive = useCallback((leg: 'near' | 'far', mySession: number) => {
    if (csSessionRef.current !== mySession) return;
    const livePremium = leg === 'near'
      ? csLiveNearCeLtpRef.current + csLiveNearPeLtpRef.current
      : csLiveFarCeLtpRef.current  + csLiveFarPeLtpRef.current;
    if (livePremium <= 0) return;
    const barTimeSec = snapToBarTime(Date.now(), intervalRef.current.value) as Time;
    const lastRestTime = leg === 'near' ? csLastNearRestTimeRef.current : csLastFarRestTimeRef.current;
    if (Number(barTimeSec) < lastRestTime) return;
    const liveBar = { time: barTimeSec, value: livePremium };
    if (leg === 'near') {
      csLiveNearBarRef.current = liveBar;
      if (nearSeriesRef.current) try { nearSeriesRef.current.update(liveBar); } catch { /* ignore */ }
    } else {
      csLiveFarBarRef.current = liveBar;
      if (farSeriesRef.current)  try { farSeriesRef.current.update(liveBar); } catch { /* ignore */ }
    }
    if (!csBarRefetchScheduled.current) csScheduleBarRefetch(mySession);
  }, [csScheduleBarRefetch]);

  const removeSeries = useCallback(() => {
    const chart = chartRef.current; if (!chart) return;
    [nearSeriesRef, farSeriesRef, nearOIRef, farOIRef].forEach(r => { if (r.current) { try { chart.removeSeries(r.current); } catch {} r.current = null; } });
  }, []);

  const setupScrollHandler = useCallback((chart: IChartApi) => {
    const handler = (range: LogicalRange | null) => {
      if (!range || range.from > 10 || fetchingRef.current) return;
      const keys = keysRef.current; if (!keys) return;
      const [ncPrev, npPrev, fcPrev, fpPrev] = prevTsRef.current;
      if (ncPrev === null && npPrev === null && fcPrev === null && fpPrev === null) return;
      fetchingRef.current = true; setLoadingMore(true);
      const fetches: Promise<void>[] = [];
      if (ncPrev !== null) fetches.push(fetchCandlesRaw(keys.nearCeKey, ncPrev).then(({ candles, prevTimestamp }) => { nearCeCandlesRef.current = [...candles, ...nearCeCandlesRef.current]; prevTsRef.current[0] = prevTimestamp; }));
      if (npPrev !== null) fetches.push(fetchCandlesRaw(keys.nearPeKey, npPrev).then(({ candles, prevTimestamp }) => { nearPeCandlesRef.current = [...candles, ...nearPeCandlesRef.current]; prevTsRef.current[1] = prevTimestamp; }));
      if (fcPrev !== null) fetches.push(fetchCandlesRaw(keys.farCeKey,  fcPrev).then(({ candles, prevTimestamp }) => { farCeCandlesRef.current  = [...candles, ...farCeCandlesRef.current];  prevTsRef.current[2] = prevTimestamp; }));
      if (fpPrev !== null) fetches.push(fetchCandlesRaw(keys.farPeKey,  fpPrev).then(({ candles, prevTimestamp }) => { farPeCandlesRef.current  = [...candles, ...farPeCandlesRef.current];  prevTsRef.current[3] = prevTimestamp; }));
      Promise.all(fetches).then(() => {
        const { near, far, nearOI, farOI } = buildCalendarSeries(nearCeCandlesRef.current, nearPeCandlesRef.current, farCeCandlesRef.current, farPeCandlesRef.current, intervalRef.current.value);
        if (nearSeriesRef.current) nearSeriesRef.current.setData(near);
        if (farSeriesRef.current)  farSeriesRef.current.setData(far);
        if (nearOIRef.current)     nearOIRef.current.setData(nearOI);
        if (farOIRef.current)      farOIRef.current.setData(farOI);
      }).catch(() => {}).finally(() => { fetchingRef.current = false; setLoadingMore(false); });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  }, []);

  const handleLoad = useCallback(async () => {
    if (!underlying || !expiryNear || !expiryFar || !strike) return;
    const chart = chartRef.current; if (!chart) return;

    // Tear down previous WS subscriptions and live state
    csWsUnsubs.current.forEach(u => u()); csWsUnsubs.current = [];
    csBarRefetchScheduled.current = false;
    if (csBarRefetchTimerRef.current) { clearTimeout(csBarRefetchTimerRef.current); csBarRefetchTimerRef.current = null; }
    csLiveNearCeLtpRef.current = 0; csLiveNearPeLtpRef.current = 0;
    csLiveFarCeLtpRef.current  = 0; csLiveFarPeLtpRef.current  = 0;
    csLiveNearBarRef.current = null; csLiveFarBarRef.current = null;
    const mySession = ++csSessionRef.current;
    csRestLoadingRef.current = true;

    removeSeries(); keysRef.current = null; prevTsRef.current = [null, null, null, null];
    nearCeCandlesRef.current = []; nearPeCandlesRef.current = []; farCeCandlesRef.current = []; farPeCandlesRef.current = [];
    fetchingRef.current = false;
    const nearCeKey = findKey(instruments, underlying, expiryNear, strike, 'CE');
    const nearPeKey = findKey(instruments, underlying, expiryNear, strike, 'PE');
    const farCeKey  = findKey(instruments, underlying, expiryFar,  strike, 'CE');
    const farPeKey  = findKey(instruments, underlying, expiryFar,  strike, 'PE');
    if (!nearCeKey || !nearPeKey || !farCeKey || !farPeKey) { setError('Some instrument keys not found'); csRestLoadingRef.current = false; return; }
    setLoading(true); setError(null);
    try {
      const [ncRes, npRes, fcRes, fpRes] = await Promise.all([fetchTodayCandles(nearCeKey), fetchTodayCandles(nearPeKey), fetchTodayCandles(farCeKey), fetchTodayCandles(farPeKey)]);
      let ncC = ncRes.candles; let ncP = ncRes.prevTimestamp;
      let npC = npRes.candles; let npP = npRes.prevTimestamp;
      let fcC = fcRes.candles; let fcP = fcRes.prevTimestamp;
      let fpC = fpRes.candles; let fpP = fpRes.prevTimestamp;
      const fb = await Promise.all([
        ncC.length === 0 && ncP ? fetchCandlesRaw(nearCeKey, ncP) : null,
        npC.length === 0 && npP ? fetchCandlesRaw(nearPeKey, npP) : null,
        fcC.length === 0 && fcP ? fetchCandlesRaw(farCeKey,  fcP) : null,
        fpC.length === 0 && fpP ? fetchCandlesRaw(farPeKey,  fpP) : null,
      ]);
      if (fb[0]) { ncC = fb[0].candles; ncP = fb[0].prevTimestamp; }
      if (fb[1]) { npC = fb[1].candles; npP = fb[1].prevTimestamp; }
      if (fb[2]) { fcC = fb[2].candles; fcP = fb[2].prevTimestamp; }
      if (fb[3]) { fpC = fb[3].candles; fpP = fb[3].prevTimestamp; }
      nearCeCandlesRef.current = ncC; nearPeCandlesRef.current = npC;
      farCeCandlesRef.current  = fcC; farPeCandlesRef.current  = fpC;
      prevTsRef.current = [ncP, npP, fcP, fpP];
      keysRef.current   = { nearCeKey, nearPeKey, farCeKey, farPeKey };
      const { near, far, nearOI, farOI } = buildCalendarSeries(ncC, npC, fcC, fpC, interval.value);
      const nearSer = chart.addSeries(LineSeries, { color: '#60a5fa', lineWidth: 2, title: `Near ${fmtExpiry(expiryNear)}` }); nearSer.setData(near); nearSeriesRef.current = nearSer;
      const farSer  = chart.addSeries(LineSeries, { color: '#f97316', lineWidth: 2, title: `Far ${fmtExpiry(expiryFar)}` });  farSer.setData(far);  farSeriesRef.current  = farSer;
      const noiSer = chart.addSeries(HistogramSeries, { priceScaleId: 'nearoi', color: 'rgba(96,165,250,0.45)', title: 'Near OI (K)', lastValueVisible: true, priceLineVisible: false });
      noiSer.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.82, bottom: 0 } }); noiSer.setData(nearOI); nearOIRef.current = noiSer;
      const foiSer = chart.addSeries(HistogramSeries, { priceScaleId: 'faroi',  color: 'rgba(249,115,22,0.45)',  title: 'Far OI (K)',  lastValueVisible: true, priceLineVisible: false });
      foiSer.priceScale().applyOptions({ visible: true, scaleMargins: { top: 0.70, bottom: 0.20 } }); foiSer.setData(farOI); farOIRef.current = foiSer;
      if (near.length > 0) zoomToEnd(chart, near);

      // Cache last REST bar times and subscribe WS
      csLastNearRestTimeRef.current = near.length > 0 ? Number(near[near.length - 1].time) : 0;
      csLastFarRestTimeRef.current  = far.length  > 0 ? Number(far[far.length - 1].time)  : 0;
      wsManager.requestKeys([nearCeKey, nearPeKey, farCeKey, farPeKey]);
      csRestLoadingRef.current = false;
      csWsUnsubs.current = [
        wsManager.subscribe(nearCeKey, (md) => {
          if (csRestLoadingRef.current || csSessionRef.current !== mySession) return;
          const ltp = md.ltp ?? 0; if (!ltp) return;
          csLiveNearCeLtpRef.current = ltp;
          csApplyLive('near', mySession);
        }),
        wsManager.subscribe(nearPeKey, (md) => {
          if (csRestLoadingRef.current || csSessionRef.current !== mySession) return;
          const ltp = md.ltp ?? 0; if (!ltp) return;
          csLiveNearPeLtpRef.current = ltp;
          csApplyLive('near', mySession);
        }),
        wsManager.subscribe(farCeKey, (md) => {
          if (csRestLoadingRef.current || csSessionRef.current !== mySession) return;
          const ltp = md.ltp ?? 0; if (!ltp) return;
          csLiveFarCeLtpRef.current = ltp;
          csApplyLive('far', mySession);
        }),
        wsManager.subscribe(farPeKey, (md) => {
          if (csRestLoadingRef.current || csSessionRef.current !== mySession) return;
          const ltp = md.ltp ?? 0; if (!ltp) return;
          csLiveFarPeLtpRef.current = ltp;
          csApplyLive('far', mySession);
        }),
      ];
    } catch (e) { setError(String(e)); csRestLoadingRef.current = false; } finally { setLoading(false); }
  }, [underlying, expiryNear, expiryFar, strike, interval, instruments, removeSeries, csApplyLive]);

  // ── Page visibility: release/re-request WS keys on tab switch ───────────────
  const csPrevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = csPrevVisibleRef.current;
    csPrevVisibleRef.current = visible;
    if (was && !visible) {
      csWsUnsubs.current.forEach(u => u()); csWsUnsubs.current = [];
      const keys = keysRef.current ? [keysRef.current.nearCeKey, keysRef.current.nearPeKey, keysRef.current.farCeKey, keysRef.current.farPeKey] : [];
      if (keys.length > 0) wsManager.releaseKeys(keys);
    } else if (!was && visible && keysRef.current) {
      const { nearCeKey, nearPeKey, farCeKey, farPeKey } = keysRef.current;
      wsManager.requestKeys([nearCeKey, nearPeKey, farCeKey, farPeKey]);
      handleLoad();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => { const chart = chartRef.current; if (!chart) return; return setupScrollHandler(chart); }, [setupScrollHandler]);

  const calendarToolbarControls = (
    <>
      <UnderlyingInput underlyings={underlyings} value={underlying} onChange={v => { setUnderlying(v); setExpiryNear(null); setExpiryFar(null); setStrike(null); }} />
      <LabeledSelect label="Near Expiry" value={expiryNear} options={expiries} onChange={v => { setExpiryNear(v as number); setExpiryFar(null); setStrike(null); }} formatLabel={v => fmtExpiry(v as number)} disabled={!underlying} />
      <LabeledSelect label="Far Expiry"  value={expiryFar}  options={farExpiries} onChange={v => setExpiryFar(v as number)} formatLabel={v => fmtExpiry(v as number)} disabled={!expiryNear} />
      <LabeledSelect label="Strike"      value={strike}      options={strikes}     onChange={v => setStrike(v as number)} disabled={!expiryNear} />
      <IntervalButtons value={interval} onChange={setInterval} />
      <div className={s.showControlWrap}>
        <span className={s.ctrlLabelHidden}>_</span>
        <button
          onClick={handleLoad}
          disabled={loading || !underlying || !expiryNear || !expiryFar || !strike}
          className={cx(s.loadBtnAmber, (loading || !underlying || !expiryNear || !expiryFar || !strike) ? s.loadBtnAmberDisabled : '')}
        >
          {loading ? <><span className={s.spinnerWhite} />Loading…</> : 'Load Chart'}
        </button>
      </div>
      {error       && <span className="text-red-400 text-xs self-end">{error}</span>}
      {loadingMore && <span className={`text-xs self-end animate-pulse ${s.loadingMoreText}`}>Loading older data...</span>}
      <div className="flex gap-3 self-end ml-auto text-xs">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 bg-white/70" /><span className="text-white/65">Near</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 bg-orange-400" /><span className="text-white/65">Far</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm bg-white/40" /><span className="text-white/65">Near OI</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm bg-orange-400/45" /><span className="text-white/65">Far OI</span></span>
      </div>
    </>
  );

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {toolbarSlot
        ? createPortal(calendarToolbarControls, toolbarSlot)
        : <div className="glass-bar flex flex-wrap items-end gap-4 px-5 py-3 relative z-10">{calendarToolbarControls}</div>
      }
      <div ref={containerRef} className="flex-1 w-full" />
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function StraddleChart({ instruments, visible = true }: Props) {
  const [mode, setMode]               = useState<ChartMode>('straddle');
  const [straddleMode, setStraddleMode] = useState<'single' | 'multi'>('single');
  const [toolbarSlotEl, setToolbarSlotEl] = useState<Element | null>(null);
  const toolbarSlotRef = useCallback((el: HTMLDivElement | null) => { setToolbarSlotEl(el); }, []);

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* Single unified toolbar */}
      <div className={`glass-bar flex flex-nowrap items-center gap-3 px-4 shrink-0 overflow-x-auto ${s.mainToolbar}`}>

        {/* Mode tab group */}
        <div className={s.modeTabGroup}>
          {(['straddle', 'strangle', 'calendar'] as ChartMode[]).map(m => (
            <button key={m} onClick={() => setMode(m)} className={cx(s.modeTabBtn, mode === m ? s.modeTabBtnActive : '')}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Single / Multi toggle — only shown when Straddle is active */}
        {mode === 'straddle' && (
          <div className={s.subModeGroup}>
            {(['single', 'multi'] as const).map(m => (
              <button key={m} onClick={() => setStraddleMode(m)} className={cx(s.subModeBtn, straddleMode === m ? s.subModeBtnActive : '')}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        )}

        {/* Divider */}
        <div className={s.toolbarDivider} />

        {/* Slot: active sub-view portals its controls here */}
        <div ref={toolbarSlotRef} className="flex flex-nowrap items-end gap-4 overflow-x-auto min-w-0 flex-1" />
      </div>

      <div className="flex-1 overflow-hidden grid min-w-0" style={{ gridTemplate: '1fr / 1fr' }}>
        <div className={s.viewLayer} style={{ visibility: mode === 'straddle' ? 'visible' : 'hidden', pointerEvents: mode === 'straddle' ? 'auto' : 'none' }}>
          <StraddleMulti instruments={instruments} straddleMode={straddleMode} visible={visible && mode === 'straddle'} toolbarSlot={mode === 'straddle' ? toolbarSlotEl : null} />
        </div>
        <div className={s.viewLayer} style={{ visibility: mode === 'strangle' ? 'visible' : 'hidden', pointerEvents: mode === 'strangle' ? 'auto' : 'none' }}>
          <StrangleView instruments={instruments} visible={visible && mode === 'strangle'} toolbarSlot={mode === 'strangle' ? toolbarSlotEl : null} />
        </div>
        <div className={s.viewLayer} style={{ visibility: mode === 'calendar' ? 'visible' : 'hidden', pointerEvents: mode === 'calendar' ? 'auto' : 'none' }}>
          <CalendarSpread instruments={instruments} visible={visible && mode === 'calendar'} toolbarSlot={mode === 'calendar' ? toolbarSlotEl : null} />
        </div>
      </div>
    </div>
  );
}
