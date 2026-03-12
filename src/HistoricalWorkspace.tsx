'use client';

/**
 * HistoricalWorkspace
 *
 * Search Dhan instruments → pick date range + interval → fetch opt_chart data
 * → display IV and Spot as TradingView lightweight-charts line series.
 *
 * Search is off-thread via dhanSearch.worker (no main-thread lag).
 * Results ranked: Index F&O → Index → EQ F&O → EQ
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createChart, LineSeries, LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { Button, Select, DateInput, NumberInput, TextInput, Badge } from './components/ui';
import { useDhanInstruments, DHAN_EXPIRY_CODE } from './useDhanInstruments';

const LS_DHAN_JWT = 'dhan_jwt';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayIst() {
  const ist = new Date(Date.now() + 330 * 60_000);
  return ist.toISOString().slice(0, 10);
}

function toUnixSec(dateStr: string, time: 'start' | 'end') {
  const iso = time === 'start'
    ? `${dateStr}T09:15:00+05:30`
    : `${dateStr}T15:30:00+05:30`;
  return Math.floor(new Date(iso).getTime() / 1000);
}

const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '1d'];
const EXP_FLAGS  = ['W', 'M'];
const EXP_CODES  = [
  { label: 'Near (current)', value: DHAN_EXPIRY_CODE.NEAR },
  { label: 'Next',           value: DHAN_EXPIRY_CODE.NEXT },
  { label: 'Far',            value: DHAN_EXPIRY_CODE.FAR  },
];

// Rank → label + color for the type badge
const RANK_META: Record<number, { label: string; color: string }> = {
  0: { label: 'IDX F&O', color: '#f59e0b' },
  1: { label: 'INDEX',   color: '#22d3ee' },
  2: { label: 'EQ F&O',  color: '#a78bfa' },
  3: { label: 'EQ',      color: '#34d399' },
  4: { label: 'OTHER',   color: '#6b7280' },
};

// ─── Small UI pieces ──────────────────────────────────────────────────────────

function GlassSelect({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string | number }[];
}) {
  return (
    <Select value={value} onValueChange={onChange} options={options} className="min-w-[90px] max-w-[160px]" />
  );
}

function GlassDateInput({ value, onChange, label }: {
  value: string; onChange: (v: string) => void; label: string;
}) {
  return (
    <DateInput value={value} onChange={e => onChange((e.target as HTMLInputElement).value)} label={label} className="w-[130px]" />
  );
}

// Highlight matching portion of text
function Hl({ text, q }: { text: string; q: string }) {
  if (!q || !text) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span style={{ color: '#f59e0b', fontWeight: 700 }}>{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

// ─── Chart panel ──────────────────────────────────────────────────────────────

interface ChartPoint { time: number; value: number }

// Series visibility toggles
type SeriesKey = 'ce' | 'pe' | 'mid' | 'spot';
const SERIES_META: { key: SeriesKey; label: string; color: string }[] = [
  { key: 'ce',   label: 'CE IV',  color: '#f59e0b' },
  { key: 'pe',   label: 'PE IV',  color: '#a78bfa' },
  { key: 'mid',  label: 'Mid IV', color: '#34d399' },
  { key: 'spot', label: 'Spot',   color: '#22d3ee' },
];

function DualChart({ ceIvData, peIvData, midIvData, spotData, symbol, visible, isPrepend }: {
  ceIvData: ChartPoint[];
  peIvData: ChartPoint[];
  midIvData: ChartPoint[];
  spotData: ChartPoint[];
  symbol: string;
  visible: Record<SeriesKey, boolean>;
  isPrepend: boolean;
}) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const chartRef        = useRef<IChartApi | null>(null);
  const ceIvSeriesRef   = useRef<ISeriesApi<any> | null>(null);
  const peIvSeriesRef   = useRef<ISeriesApi<any> | null>(null);
  const midIvSeriesRef  = useRef<ISeriesApi<any> | null>(null);
  const spotSeriesRef   = useRef<ISeriesApi<any> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#171717' } as any,
        textColor: '#B2B5BE',
        fontFamily: 'monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#2a2a2a' },
        horzLines: { color: '#2a2a2a' },
      },
      rightPriceScale: { borderColor: '#2a2a2a', scaleMargins: { top: 0.08, bottom: 0.08 } },
      leftPriceScale:  { borderColor: '#2a2a2a', visible: true, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: {
        borderColor: '#2a2a2a',
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
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: 'short',
            hour: '2-digit', minute: '2-digit', hour12: false,
          }),
      },
      crosshair: { mode: 0 },
    });

    ceIvSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 2, priceScaleId: 'left',
      title: `CE IV · ${symbol}`, lastValueVisible: true, priceLineVisible: false,
    });
    peIvSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#a78bfa', lineWidth: 2, priceScaleId: 'left',
      title: `PE IV · ${symbol}`, lastValueVisible: true, priceLineVisible: false,
    });
    midIvSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#34d399', lineWidth: 2, priceScaleId: 'left',
      title: `Mid IV · ${symbol}`, lastValueVisible: true, priceLineVisible: false,
    });
    spotSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#22d3ee', lineWidth: 1, lineStyle: LineStyle.Dashed,
      priceScaleId: 'right', title: `Spot · ${symbol}`, lastValueVisible: true, priceLineVisible: false,
    });

    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  // Update data — on prepend, save+restore logical range so view doesn't jump
  useEffect(() => {
    if (!ceIvSeriesRef.current || !peIvSeriesRef.current || !midIvSeriesRef.current || !spotSeriesRef.current) return;
    const sort = (arr: ChartPoint[]) => [...arr].sort((a, b) => a.time - b.time);
    const ts = chartRef.current?.timeScale();
    const savedRange = isPrepend ? ts?.getVisibleLogicalRange() : null;
    ceIvSeriesRef.current.setData(sort(ceIvData) as any);
    peIvSeriesRef.current.setData(sort(peIvData) as any);
    midIvSeriesRef.current.setData(sort(midIvData) as any);
    spotSeriesRef.current.setData(sort(spotData) as any);
    if (savedRange) {
      ts?.setVisibleLogicalRange(savedRange);
    } else if (ceIvData.length > 0 || spotData.length > 0) {
      ts?.fitContent();
    }
  }, [ceIvData, peIvData, midIvData, spotData]);

  // Toggle visibility
  useEffect(() => {
    ceIvSeriesRef.current?.applyOptions({ visible: visible.ce });
    peIvSeriesRef.current?.applyOptions({ visible: visible.pe });
    midIvSeriesRef.current?.applyOptions({ visible: visible.mid });
    spotSeriesRef.current?.applyOptions({ visible: visible.spot });
  }, [visible]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

// ─── Worker result type ───────────────────────────────────────────────────────

interface WorkerEntry {
  underlying_symbol: string;
  display_name: string;
  segment_key: string;
  u_seg_id: number;
  underlying_security_id: number;
  instrument: string;
  exch_id: string;
  rank: number;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function HistoricalWorkspace() {
  const { instruments, status: instrStatus, total } = useDhanInstruments();

  // ── Worker ──
  const workerRef    = useRef<Worker | null>(null);
  const workerReady  = useRef(false);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Search state ──
  const [query,     setQuery]     = useState('');
  const [results,   setResults]   = useState<WorkerEntry[]>([]);
  const [showDrop,  setShowDrop]  = useState(false);
  const [selected,  setSelected]  = useState<WorkerEntry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef  = useRef<HTMLDivElement>(null);

  // ── Query params ──
  const [startDate, setStartDate] = useState(todayIst());
  const [endDate,   setEndDate]   = useState(todayIst());
  const [interval,  setInterval]  = useState('5m');
  const [expFlag,   setExpFlag]   = useState('W');
  const [expCode,   setExpCode]   = useState(String(DHAN_EXPIRY_CODE.NEAR));
  const [strikePos, setStrikePos] = useState(0);

  // ── Fetch state ──
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [ceIvData,  setCeIvData]  = useState<ChartPoint[]>([]);
  const [peIvData,  setPeIvData]  = useState<ChartPoint[]>([]);
  const [midIvData, setMidIvData] = useState<ChartPoint[]>([]);
  const [spotData,  setSpotData]  = useState<ChartPoint[]>([]);
  const [elapsed,   setElapsed]   = useState<number | null>(null);

  // ── Series visibility ──
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    ce: true, pe: true, mid: false, spot: true,
  });
  const toggleSeries = (key: SeriesKey) =>
    setVisible(v => ({ ...v, [key]: !v[key] }));
  const [isPrepend, setIsPrepend] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ── Boot worker ──
  useEffect(() => {
    const w = new Worker(new URL('./dhanSearch.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'READY') { workerReady.current = true; }
      if (e.data.type === 'RESULTS') {
        setResults(e.data.results);
        setShowDrop(e.data.results.length > 0);
      }
    };
    return () => { w.terminate(); workerRef.current = null; workerReady.current = false; };
  }, []);

  // ── Load instruments into worker once ready ──
  useEffect(() => {
    if ((instrStatus === 'ready' || instrStatus === 'cache-hit') && instruments.length > 0) {
      workerRef.current?.postMessage({ type: 'LOAD', payload: instruments });
    }
  }, [instrStatus, instruments]);

  // ── Debounced search ──
  const handleQueryChange = useCallback((q: string) => {
    setQuery(q);
    if (!q.trim()) { setResults([]); setShowDrop(false); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (workerReady.current) {
        workerRef.current?.postMessage({ type: 'SEARCH', payload: q });
      }
    }, 80);
  }, []);

  // ── Outside click closes dropdown ──
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        dropRef.current  && !dropRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) setShowDrop(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectInstrument = useCallback((entry: WorkerEntry) => {
    setSelected(entry);
    setQuery(entry.underlying_symbol);
    setResults([]);
    setShowDrop(false);
    setCeIvData([]);
    setPeIvData([]);
    setMidIvData([]);
    setSpotData([]);
    setError('');
    setElapsed(null);
  }, []);

  // ── Shared fetch helper — returns parsed points or throws ──
  const fetchRange = async (
    start: string,
    end: string,
    signal: AbortSignal,
  ): Promise<{ ce: ChartPoint[]; pe: ChartPoint[]; mid: ChartPoint[]; spot: ChartPoint[] }> => {
    const jwt = localStorage.getItem(LS_DHAN_JWT)?.trim() ?? '';
    if (!jwt) throw new Error('No Dhan JWT found.');
    if (!selected) throw new Error('No instrument selected.');

    const res = await fetch('/api/dhan-opt-chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        auth: jwt,
        payload: {
          data: {
            start_time:    toUnixSec(start, 'start'),
            end_time:      toUnixSec(end,   'end'),
            u_id:          selected.underlying_security_id,
            u_seg_id:      selected.u_seg_id,
            exp_flag:      expFlag,
            exp_code:      Number(expCode),
            option_type:   '',
            required_data: ['iv', 'spot', 'strike'],
            interval,
            strikepos:     strikePos,
          },
        },
      }),
    });

    const json = await res.json();
    if (!res.ok) throw new Error(json?.error ?? json?.remarks ?? `HTTP ${res.status}`);

    const timeU = (json?.data?.ce?.time_u ?? []) as number[];
    const ceIv  = (json?.data?.ce?.iv     ?? []) as number[];
    const peIv  = (json?.data?.pe?.iv     ?? []) as number[];
    const spot  = (json?.data?.ce?.spot   ?? []) as number[];

    const zip = (vals: number[]): ChartPoint[] =>
      timeU.map((t, i) => ({ time: t, value: vals[i] ?? 0 }));
    const midIv = ceIv.map((v, i) => (v + (peIv[i] ?? 0)) / 2);

    return { ce: zip(ceIv), pe: zip(peIv), mid: zip(midIv), spot: zip(spot) };
  };

  // Merge two point arrays: deduplicate by time, keep sorted
  const mergePoints = (existing: ChartPoint[], incoming: ChartPoint[]): ChartPoint[] => {
    const map = new Map<number, number>();
    for (const p of existing) map.set(p.time, p.value);
    for (const p of incoming) map.set(p.time, p.value);
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
  };

  // ── Fetch (fresh load) ──
  const handleFetch = async () => {
    const jwt = localStorage.getItem(LS_DHAN_JWT)?.trim() ?? '';
    if (!jwt)     { setError('No Dhan JWT found. Paste it in Nubra IV → Dhan Chart tab first.'); return; }
    if (!selected){ setError('Select an instrument first.'); return; }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsPrepend(false);
    setLoading(true); setError(''); setCeIvData([]); setPeIvData([]); setMidIvData([]); setSpotData([]); setElapsed(null);

    const t0 = performance.now();
    try {
      const pts = await fetchRange(startDate, endDate, ctrl.signal);
      setElapsed(Math.round(performance.now() - t0));
      if (pts.ce.length === 0) { setError('No data returned for the selected range.'); return; }
      setCeIvData(pts.ce); setPeIvData(pts.pe); setMidIvData(pts.mid); setSpotData(pts.spot);
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setError(String(e));
    } finally { setLoading(false); }
  };

  // ── Extend ──
  const handleExtend = async (_days: number) => {
    if (!selected || ceIvData.length === 0) return;
    const existingOldest = ceIvData[0].time;
    const oldestDate = new Date(existingOldest * 1000);
    const fetchEndDt = new Date(oldestDate.getTime() - 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => {
      const ist = new Date(d.getTime() + 330 * 60_000);
      return ist.toISOString().slice(0, 10);
    };
    const fetchStart = startDate;
    const fetchEnd   = fmt(fetchEndDt);

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError('');

    const t0 = performance.now();
    try {
      const raw = await fetchRange(fetchStart, fetchEnd, ctrl.signal);
      setElapsed(Math.round(performance.now() - t0));
      const clip = (pts: ChartPoint[]) => pts.filter(p => p.time < existingOldest);
      const newCe = clip(raw.ce); const newPe = clip(raw.pe);
      const newMid = clip(raw.mid); const newSpot = clip(raw.spot);
      if (newCe.length === 0) { setError('No new data before current range.'); return; }
      setIsPrepend(true);
      setCeIvData(prev  => mergePoints(newCe,   prev));
      setPeIvData(prev  => mergePoints(newPe,   prev));
      setMidIvData(prev => mergePoints(newMid,  prev));
      setSpotData(prev  => mergePoints(newSpot, prev));
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setError(String(e));
    } finally { setLoading(false); }
  };

  const hasData = ceIvData.length > 0 || spotData.length > 0;
  const isReady = instrStatus === 'ready' || instrStatus === 'cache-hit';

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: '#171717', color: '#e5e7eb' }}>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="glass-bar flex items-center gap-2.5 px-3.5 py-2 shrink-0 flex-wrap">

        <span className="text-[11px] font-bold text-amber-400 tracking-[0.08em] uppercase whitespace-nowrap">
          Historical Workspace
        </span>
        <div className="w-px h-[18px] bg-[#2a2a2a] shrink-0" />

        {/* ── Instrument search ─────────────────────────────────────────────── */}
        <div className="relative" ref={dropRef}>
          <TextInput
            ref={inputRef as any}
            value={query}
            placeholder={isReady ? `Search symbol… (${total.toLocaleString()})` : 'Loading instruments…'}
            onChange={e => handleQueryChange(e.target.value)}
            onFocus={() => results.length > 0 && setShowDrop(true)}
            className="w-56"
          />

          {/* Dropdown */}
          {showDrop && results.length > 0 && (
            <div className="absolute top-[calc(100%+3px)] left-0 w-[480px] bg-[#171717] border border-[#2a2a2a] rounded-md z-[100] overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.65)]">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#2a2a2a]">
                <span className="text-[10px] text-amber-400 font-bold tracking-[0.1em] uppercase">SYMBOL SEARCH</span>
                <button type="button" onClick={() => setShowDrop(false)} className="text-[#52525b] hover:text-[#D1D4DC] px-1 text-sm">✕</button>
              </div>
              <div className="grid px-3 py-1 border-b border-[#2a2a2a] bg-[#171717]" style={{ gridTemplateColumns: '1fr 100px 80px 60px' }}>
                {['SYMBOL', 'TYPE', 'SEGMENT', 'SEG ID'].map(h => (
                  <span key={h} className="text-[9px] text-[#52525b] tracking-[0.08em] uppercase">{h}</span>
                ))}
              </div>
              <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                {results.map((entry, i) => {
                  const meta = RANK_META[entry.rank] ?? RANK_META[4];
                  return (
                    <div
                      key={i}
                      onMouseDown={() => selectInstrument(entry)}
                      className="grid px-3 py-1.5 cursor-pointer border-b border-white/[0.03] transition-colors hover:bg-amber-500/[0.07]"
                      style={{ gridTemplateColumns: '1fr 100px 80px 60px' }}
                    >
                      <div className="flex items-baseline gap-1.5 overflow-hidden">
                        <span className="text-[12px] font-bold text-[#e5e7eb] font-mono whitespace-nowrap">
                          <Hl text={entry.underlying_symbol} q={query} />
                        </span>
                        <span className="text-[10px] text-white/30 overflow-hidden text-ellipsis whitespace-nowrap">
                          <Hl text={entry.display_name} q={query} />
                        </span>
                      </div>
                      <span className="text-[9px] font-bold tracking-[0.06em] font-mono flex items-center" style={{ color: meta.color }}>{meta.label}</span>
                      <span className="text-[10px] text-indigo-400 font-mono flex items-center">{entry.segment_key}</span>
                      <span className="text-[10px] text-white/40 font-mono flex items-center">{entry.u_seg_id}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Selected badge */}
        {selected && (
          <Badge color="emerald">
            {selected.underlying_symbol} · {RANK_META[selected.rank]?.label ?? ''} · seg {selected.u_seg_id}
          </Badge>
        )}

        <div className="w-px h-[18px] bg-[#2a2a2a] shrink-0" />

        <GlassDateInput label="Start" value={startDate} onChange={setStartDate} />
        <GlassDateInput label="End"   value={endDate}   onChange={setEndDate} />

        <div className="w-px h-[18px] bg-[#2a2a2a] shrink-0" />

        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[#52525b] uppercase tracking-[0.08em]">Interval</span>
          <GlassSelect value={interval} onChange={setInterval} options={INTERVALS.map(v => ({ label: v, value: v }))} />
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[#52525b] uppercase tracking-[0.08em]">Expiry</span>
          <GlassSelect value={expFlag} onChange={setExpFlag} options={EXP_FLAGS.map(v => ({ label: v === 'W' ? 'Weekly' : 'Monthly', value: v }))} />
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[#52525b] uppercase tracking-[0.08em]">Exp Code</span>
          <GlassSelect value={expCode} onChange={setExpCode} options={EXP_CODES.map(o => ({ label: o.label, value: String(o.value) }))} />
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[#52525b] uppercase tracking-[0.08em]">Strike Pos</span>
          <NumberInput
            value={String(strikePos)}
            onValueChange={v => setStrikePos(v)}
            className="w-16"
            step={1}
            min={-5}
            max={5}
          />
        </div>

        <div className="flex-1" />

        {elapsed !== null && !loading && (
          <span className="text-[10px] text-white/30">{elapsed}ms</span>
        )}

        {loading ? (
          <Button size="xs" variant="danger" onClick={() => { abortRef.current?.abort(); setLoading(false); }}>
            Cancel
          </Button>
        ) : (<>
          {hasData && ([15, 30] as const).map(d => (
            <Button key={d} size="xs" variant="ghost" onClick={() => handleExtend(d)}>+{d}d</Button>
          ))}
          <Button size="xs" variant="primary" onClick={handleFetch} disabled={!selected}>Fetch →</Button>
        </>)}
      </div>

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-red-400 bg-red-500/[0.08] border-b border-red-500/20 shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {error}
        </div>
      )}

      {/* ── Series toggles ───────────────────────────────────────────────────── */}
      {hasData && (
        <div className="flex items-center gap-1.5 px-3.5 py-1.5 shrink-0 border-b border-[#2a2a2a] bg-[#171717]">
          {SERIES_META.map(s => (
            <button
              key={s.key}
              type="button"
              onMouseDown={e => { e.preventDefault(); toggleSeries(s.key); }}
              className="px-2 py-0.5 rounded text-[10px] font-bold font-mono tracking-[0.06em] uppercase border transition-colors"
              style={{
                border: `1px solid ${visible[s.key] ? s.color : 'rgba(255,255,255,0.12)'}`,
                background: visible[s.key] ? `${s.color}22` : 'rgba(0,0,0,0.5)',
                color: visible[s.key] ? s.color : 'rgba(255,255,255,0.25)',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Chart / empty state ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 gap-2.5">
            <svg className="animate-spin h-4 w-4 text-[#787B86]" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-[12px] text-white/40">Fetching data…</span>
          </div>
        )}
        {!hasData && !loading && !error && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-[#3f3f46] text-[12px] tracking-[0.1em] uppercase">SELECT AN INSTRUMENT AND FETCH DATA</p>
              {!isReady && (
                <p className="text-[#2a2a2a] text-[11px] mt-1.5 tracking-[0.06em]">Dhan instruments: {instrStatus}…</p>
              )}
            </div>
          </div>
        )}
        {hasData && (
          <DualChart
            ceIvData={ceIvData}
            peIvData={peIvData}
            midIvData={midIvData}
            spotData={spotData}
            symbol={selected?.underlying_symbol ?? ''}
            visible={visible}
            isPrepend={isPrepend}
          />
        )}
      </div>
    </div>
  );
}
