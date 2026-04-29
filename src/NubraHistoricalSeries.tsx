'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as am5 from '@amcharts/amcharts5';
import * as am5xy from '@amcharts/amcharts5/xy';
import type { NubraInstrument } from './useNubraInstruments';
import s from './NubraHistoricalSeries.module.css';

type Mode = 'live' | 'historical';
type Metric = 'close' | 'premium_decay' | 'vega_change' | 'cumulative_oi' | 'gamma' | 'delta' | 'theta' | 'vega';
type StrikeMode = 'atm' | 'fixed' | 'custom';
type OptionSide = 'CE' | 'PE';

const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 260;
const COLORS = [0x60a5fa, 0xfacc15, 0xfb7185, 0x34d399, 0xc084fc, 0x2dd4bf, 0xf97316, 0xa3e635, 0xf472b6, 0x93c5fd];

interface Props {
  nubraInstruments: NubraInstrument[];
  initialSymbol?: string;
}

interface OptionDef {
  symbol: string;
  strike: number;
  side: OptionSide;
}

interface SeriesPoint {
  ts: number;
  value: number;
}

interface PremiumDecayPoint {
  ts: number;
  ceChange: number;
  peChange: number;
  cePremium: number;
  pePremium: number;
  ceBase: number;
  peBase: number;
}

interface AggregateChangePoint {
  ts: number;
  ceChange: number;
  peChange: number;
  ceCurrent: number;
  peCurrent: number;
  ceBase: number;
  peBase: number;
}

interface ChartRefs {
  root: am5.Root;
  xAxis: am5xy.DateAxis<am5xy.AxisRenderer>;
  yAxis: am5xy.ValueAxis<am5xy.AxisRenderer>;
  spotAxis: am5xy.ValueAxis<am5xy.AxisRenderer>;
  chart: am5xy.XYChart;
  legend: am5.Legend;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSym(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeExchange(raw: string) {
  const ex = String(raw || '').toUpperCase();
  if (ex.startsWith('BSE')) return 'BSE';
  if (ex.startsWith('MCX')) return 'MCX';
  return 'NSE';
}

function normalizeExpiry(raw: string | number | null | undefined) {
  const s = String(raw ?? '').replace(/\D/g, '');
  if (s.length === 8) return s;
  if (s.length === 6) return `20${s}`;
  return '';
}

function todayIstYmd() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function formatExpiry(exp: string) {
  if (exp.length !== 8) return exp;
  return new Date(`${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}T00:00:00Z`)
    .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function metricLabel(metric: Metric) {
  if (metric === 'close') return 'Close';
  if (metric === 'premium_decay') return 'Premium Decay';
  if (metric === 'vega_change') return 'Vega Change';
  if (metric === 'cumulative_oi') return 'OI';
  return metric.toUpperCase();
}

function toMinuteMs(rawTs: number) {
  if (!Number.isFinite(rawTs) || rawTs <= 0) return 0;
  const ms = rawTs > 1e15 ? rawTs / 1e6 : rawTs > 1e12 ? rawTs : rawTs * 1000;
  return Math.floor(ms / 60000) * 60000;
}

function parseHistoricalValueBlocks(json: any): Map<string, any> {
  const out = new Map<string, any>();
  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
  for (const block of valuesArr) {
    if (!block || typeof block !== 'object') continue;
    for (const [key, value] of Object.entries(block)) out.set(key, value);
  }
  return out;
}

function parseSeries(chartObj: any, field: string): SeriesPoint[] {
  const arr: any[] = chartObj?.[field] ?? [];
  return arr
    .map(p => {
      const rawValue = Number(p?.v ?? p?.value ?? 0);
      return {
        ts: toMinuteMs(Number(p?.ts ?? p?.timestamp ?? 0)),
        value: field === 'close' ? rawValue / 100 : rawValue,
      };
    })
    .filter(p => p.ts > 0 && Number.isFinite(p.value));
}

function buildPremiumDecaySeries(selected: OptionDef[], optionSeries: Map<string, SeriesPoint[]>): PremiumDecayPoint[] {
  const minuteSet = new Set<number>();
  const bySymbol = new Map<string, Map<number, number>>();

  for (const opt of selected) {
    const points = optionSeries.get(opt.symbol) ?? [];
    const map = new Map<number, number>();
    for (const point of points) {
      if (point.value > 0) {
        map.set(point.ts, point.value);
        minuteSet.add(point.ts);
      }
    }
    bySymbol.set(opt.symbol, map);
  }

  const minutes = [...minuteSet].sort((a, b) => a - b);
  const last = new Map<string, number>();
  let ceBase = 0;
  let peBase = 0;
  const out: PremiumDecayPoint[] = [];

  for (const ts of minutes) {
    for (const opt of selected) {
      const value = bySymbol.get(opt.symbol)?.get(ts);
      if (value != null && Number.isFinite(value) && value > 0) last.set(opt.symbol, value);
    }

    let cePremium = 0;
    let pePremium = 0;
    for (const opt of selected) {
      const value = last.get(opt.symbol) ?? 0;
      if (opt.side === 'CE') cePremium += value;
      else pePremium += value;
    }
    if (cePremium <= 0 && pePremium <= 0) continue;
    if (ceBase <= 0 && cePremium > 0) ceBase = cePremium;
    if (peBase <= 0 && pePremium > 0) peBase = pePremium;

    const ceChange = ceBase > 0 && cePremium > 0 ? cePremium - ceBase : 0;
    const peChange = peBase > 0 && pePremium > 0 ? pePremium - peBase : 0;
    out.push({
      ts,
      ceChange,
      peChange,
      cePremium,
      pePremium,
      ceBase,
      peBase,
    });
  }

  return out;
}

function buildAggregateChangeSeries(selected: OptionDef[], optionSeries: Map<string, SeriesPoint[]>): AggregateChangePoint[] {
  const minuteSet = new Set<number>();
  const bySymbol = new Map<string, Map<number, number>>();

  for (const opt of selected) {
    const points = optionSeries.get(opt.symbol) ?? [];
    const map = new Map<number, number>();
    for (const point of points) {
      map.set(point.ts, point.value);
      minuteSet.add(point.ts);
    }
    bySymbol.set(opt.symbol, map);
  }

  const minutes = [...minuteSet].sort((a, b) => a - b);
  const last = new Map<string, number>();
  let ceBase = Number.NaN;
  let peBase = Number.NaN;
  const out: AggregateChangePoint[] = [];

  for (const ts of minutes) {
    for (const opt of selected) {
      const value = bySymbol.get(opt.symbol)?.get(ts);
      if (value != null && Number.isFinite(value)) last.set(opt.symbol, value);
    }

    let ceCurrent = 0;
    let peCurrent = 0;
    for (const opt of selected) {
      const value = last.get(opt.symbol) ?? 0;
      if (opt.side === 'CE') ceCurrent += value;
      else peCurrent += value;
    }
    if (!Number.isFinite(ceBase)) ceBase = ceCurrent;
    if (!Number.isFinite(peBase)) peBase = peCurrent;

    out.push({
      ts,
      ceChange: ceCurrent - ceBase,
      peChange: peCurrent - peBase,
      ceCurrent,
      peCurrent,
      ceBase,
      peBase,
    });
  }

  return out;
}

function getSymbols(instruments: NubraInstrument[]) {
  const set = new Set<string>();
  for (const ins of instruments) {
    if (ins.option_type !== 'CE' && ins.option_type !== 'PE') continue;
    const sym = ins.asset || ins.nubra_name || '';
    if (sym) set.add(sym);
  }
  return [...set].sort();
}

function getSymbolMeta(instruments: NubraInstrument[], symbol: string) {
  const sNorm = normalizeSym(symbol);
  const scoped = instruments.filter(ins =>
    (ins.option_type === 'CE' || ins.option_type === 'PE') &&
    normalizeSym(ins.asset || ins.nubra_name || ins.stock_name || '') === sNorm,
  );
  const exchange = normalizeExchange(scoped[0]?.exchange || 'NSE');
  const expiries = [...new Set(scoped.map(ins => normalizeExpiry(ins.expiry)).filter(Boolean))].sort();
  const spotType: 'INDEX' | 'STOCK' = scoped.some(ins => String(ins.asset_type || '').includes('INDEX')) ? 'INDEX' : 'STOCK';
  return { exchange, expiries, spotType };
}

function getOptionsForExpiry(instruments: NubraInstrument[], symbol: string, exchange: string, expiry: string): OptionDef[] {
  const sNorm = normalizeSym(symbol);
  const eNorm = normalizeExchange(exchange);
  return instruments
    .filter(ins => {
      if (ins.option_type !== 'CE' && ins.option_type !== 'PE') return false;
      if (normalizeExpiry(ins.expiry) !== expiry) return false;
      if (normalizeExchange(ins.exchange) !== eNorm) return false;
      return normalizeSym(ins.asset || ins.nubra_name || ins.stock_name || '') === sNorm;
    })
    .map(ins => ({
      symbol: String(ins.stock_name || ins.nubra_name || '').trim(),
      strike: Number(ins.strike_price ?? 0) / 100,
      side: ins.option_type as OptionSide,
    }))
    .filter(def => def.symbol && Number.isFinite(def.strike) && def.strike > 0)
    .sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));
}

function getAuth() {
  return {
    sessionToken: localStorage.getItem('nubra_session_token') ?? '',
    authToken: localStorage.getItem('nubra_auth_token') ?? '',
    deviceId: localStorage.getItem('nubra_device_id') ?? '',
    rawCookie: localStorage.getItem('nubra_raw_cookie') ?? '',
  };
}

function windowFor(mode: Mode, date: string) {
  const ymd = date || todayIstYmd();
  return {
    startDate: `${ymd}T03:45:00.000Z`,
    endDate: mode === 'live' ? new Date().toISOString() : `${ymd}T10:00:00.000Z`,
    intraDay: mode === 'live',
    realTime: false,
  };
}

async function fetchHistoricalBatch(
  exchange: string,
  type: 'OPT' | 'INDEX' | 'STOCK',
  values: string[],
  fields: string[],
  mode: Mode,
  date: string,
) {
  const auth = getAuth();
  if (!auth.sessionToken) throw new Error('Nubra login required');
  const win = windowFor(mode, date);
  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: auth.sessionToken,
      auth_token: auth.authToken,
      device_id: auth.deviceId,
      raw_cookie: auth.rawCookie,
      exchange: normalizeExchange(exchange),
      type,
      values,
      fields,
      startDate: mode === 'live' && type === 'OPT' ? '' : win.startDate,
      endDate: mode === 'live' && type === 'OPT' ? '' : win.endDate,
      interval: '1m',
      intraDay: win.intraDay,
      realTime: win.realTime,
    }),
  });
  if (!res.ok) throw new Error(`historical ${res.status}`);
  return parseHistoricalValueBlocks(await res.json());
}

async function fetchOptionSeries(
  exchange: string,
  options: OptionDef[],
  metric: Metric,
  mode: Mode,
  date: string,
) {
  const out = new Map<string, SeriesPoint[]>();
  const fields = [metric];
  for (let i = 0; i < options.length; i += BATCH_SIZE) {
    const batch = options.slice(i, i + BATCH_SIZE);
    const blocks = await fetchHistoricalBatch(exchange, 'OPT', batch.map(opt => opt.symbol), fields, mode, date);
    for (const opt of batch) {
      const chartObj = blocks.get(opt.symbol);
      if (chartObj) out.set(opt.symbol, parseSeries(chartObj, metric));
    }
    if (i + BATCH_SIZE < options.length) await sleep(BATCH_PAUSE_MS);
  }
  return out;
}

async function fetchSpotSeries(exchange: string, symbol: string, spotType: 'INDEX' | 'STOCK', mode: Mode, date: string) {
  const blocks = await fetchHistoricalBatch(exchange, spotType, [symbol], ['close'], mode, date);
  const chartObj = blocks.get(symbol) ?? [...blocks.values()][0];
  return chartObj ? parseSeries(chartObj, 'close') : [];
}

export default function NubraHistoricalSeries({ nubraInstruments, initialSymbol = 'NIFTY' }: Props) {
  const symbols = useMemo(() => getSymbols(nubraInstruments), [nubraInstruments]);
  const [symbol, setSymbol] = useState(initialSymbol);
  const [exchange, setExchange] = useState('NSE');
  const [spotType, setSpotType] = useState<'INDEX' | 'STOCK'>('INDEX');
  const [expiry, setExpiry] = useState('');
  const [mode, setMode] = useState<Mode>('live');
  const [date, setDate] = useState(todayIstYmd());
  const [metric, setMetric] = useState<Metric>('close');
  const [strikeMode, setStrikeMode] = useState<StrikeMode>('atm');
  const [range, setRange] = useState(1);
  const [fixedStrike, setFixedStrike] = useState('');
  const [customStrikes, setCustomStrikes] = useState('');
  const [status, setStatus] = useState('Select settings and load.');
  const [loading, setLoading] = useState(false);
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const refsRef = useRef<ChartRefs | null>(null);

  const meta = useMemo(() => getSymbolMeta(nubraInstruments, symbol), [nubraInstruments, symbol]);
  const options = useMemo(() => getOptionsForExpiry(nubraInstruments, symbol, exchange, expiry), [nubraInstruments, symbol, exchange, expiry]);
  const strikes = useMemo(() => [...new Set(options.map(opt => opt.strike))].sort((a, b) => a - b), [options]);

  useEffect(() => {
    if (!symbols.length) return;
    const nextSymbol = symbols.includes(symbol) ? symbol : symbols.includes(initialSymbol) ? initialSymbol : symbols[0];
    if (nextSymbol !== symbol) setSymbol(nextSymbol);
  }, [symbols, symbol, initialSymbol]);

  useEffect(() => {
    setExchange(meta.exchange);
    setSpotType(meta.spotType);
    setExpiry(prev => (prev && meta.expiries.includes(prev) ? prev : meta.expiries[0] ?? ''));
  }, [meta.exchange, meta.expiries, meta.spotType]);

  useEffect(() => {
    if (!fixedStrike && strikes.length) setFixedStrike(String(strikes[Math.floor(strikes.length / 2)]));
  }, [fixedStrike, strikes]);

  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;
    const root = am5.Root.new(host);
    root.interfaceColors.set('grid', am5.color(0x334155));

    const chart = root.container.children.push(am5xy.XYChart.new(root, {
      panX: true,
      panY: false,
      wheelX: 'panX',
      wheelY: 'zoomX',
      layout: root.verticalLayout,
    }));
    const xRenderer = am5xy.AxisRendererX.new(root, { minGridDistance: 70 });
    xRenderer.labels.template.setAll({ fill: am5.color(0x94a3b8), fontSize: 10 });
    xRenderer.grid.template.setAll({ stroke: am5.color(0xffffff), strokeOpacity: 0.06 });
    const xAxis = chart.xAxes.push(am5xy.DateAxis.new(root, {
      baseInterval: { timeUnit: 'minute', count: 1 },
      renderer: xRenderer,
      tooltip: am5.Tooltip.new(root, {}),
    }));

    const yRenderer = am5xy.AxisRendererY.new(root, {});
    yRenderer.labels.template.setAll({ fill: am5.color(0xcbd5e1), fontSize: 10 });
    yRenderer.grid.template.setAll({ stroke: am5.color(0xffffff), strokeOpacity: 0.06 });
    const yAxis = chart.yAxes.push(am5xy.ValueAxis.new(root, { renderer: yRenderer }));

    const spotRenderer = am5xy.AxisRendererY.new(root, { opposite: true });
    spotRenderer.labels.template.setAll({ fill: am5.color(0x93c5fd), fontSize: 10 });
    spotRenderer.grid.template.setAll({ forceHidden: true });
    const spotAxis = chart.yAxes.push(am5xy.ValueAxis.new(root, { renderer: spotRenderer }));

    chart.set('cursor', am5xy.XYCursor.new(root, { behavior: 'zoomX' }));
    const legend = chart.children.push(am5.Legend.new(root, { centerX: am5.p50, x: am5.p50 }));
    legend.labels.template.setAll({ fill: am5.color(0xe5e7eb), fontSize: 11 });
    legend.valueLabels.template.setAll({ fill: am5.color(0x94a3b8), fontSize: 10 });

    refsRef.current = { root, chart, xAxis, yAxis, spotAxis, legend };
    return () => {
      root.dispose();
      refsRef.current = null;
    };
  }, []);

  const paintChart = useCallback((selected: OptionDef[], optionSeries: Map<string, SeriesPoint[]>, spotSeries: SeriesPoint[]) => {
    const refs = refsRef.current;
    if (!refs) return;
    const { root, chart, xAxis, yAxis, spotAxis, legend } = refs;
    chart.series.clear();
    yAxis.axisRanges.clear();

    const allSeries: am5xy.LineSeries[] = [];
    if (metric === 'premium_decay' || metric === 'vega_change') {
      const decayData = buildPremiumDecaySeries(selected, optionSeries);
      const aggregateData = metric === 'vega_change' ? buildAggregateChangeSeries(selected, optionSeries) : [];
      const values = metric === 'vega_change'
        ? aggregateData.flatMap(point => [point.ceChange, point.peChange])
        : decayData.flatMap(point => [point.ceChange, point.peChange]);
      const max = Math.max(0, ...values);
      const min = Math.min(0, ...values);
      yAxis.setAll({
        min: min === 0 && max === 0 ? -1 : min * 1.08,
        max: min === 0 && max === 0 ? 1 : max * 1.08,
        strictMinMax: true,
      });

      const zeroRange = yAxis.createAxisRange(yAxis.makeDataItem({ value: 0 }));
      zeroRange.get('grid')?.setAll({
        stroke: am5.color(0xe5e7eb),
        strokeOpacity: 0.72,
        strokeWidth: 1,
        strokeDasharray: [4, 4],
      });
      zeroRange.get('label')?.setAll({
        text: '0',
        fill: am5.color(0xe5e7eb),
        fontSize: 10,
        centerY: am5.p50,
      });

      if (metric === 'vega_change') {
        const ceVegaChange = chart.series.push(am5xy.LineSeries.new(root, {
          name: 'CE Vega Change',
          xAxis,
          yAxis,
          valueXField: 'ts',
          valueYField: 'ceChange',
          stroke: am5.color(0x22c55e),
          fill: am5.color(0x22c55e),
          tooltip: am5.Tooltip.new(root, {
            labelText: 'CE Vega Change\nChange: {ceChange.formatNumber("#.##")}\nCurrent CE Vega: {ceCurrent.formatNumber("#.##")}\nOpening CE Vega: {ceBase.formatNumber("#.##")}',
          }),
        }));
        ceVegaChange.strokes.template.setAll({ strokeWidth: 2 });
        ceVegaChange.fills.template.setAll({ visible: true, fillOpacity: 0.26 });
        ceVegaChange.data.setAll(aggregateData);

        const peVegaChange = chart.series.push(am5xy.LineSeries.new(root, {
          name: 'PE Vega Change',
          xAxis,
          yAxis,
          valueXField: 'ts',
          valueYField: 'peChange',
          stroke: am5.color(0xef4444),
          fill: am5.color(0xef4444),
          tooltip: am5.Tooltip.new(root, {
            labelText: 'PE Vega Change\nChange: {peChange.formatNumber("#.##")}\nCurrent PE Vega: {peCurrent.formatNumber("#.##")}\nOpening PE Vega: {peBase.formatNumber("#.##")}',
          }),
        }));
        peVegaChange.strokes.template.setAll({ strokeWidth: 2 });
        peVegaChange.fills.template.setAll({ visible: true, fillOpacity: 0.26 });
        peVegaChange.data.setAll(aggregateData);

        allSeries.push(ceVegaChange, peVegaChange);
      }

      if (metric === 'premium_decay') {
      const positive = chart.series.push(am5xy.LineSeries.new(root, {
        name: 'CE Change',
        xAxis,
        yAxis,
        valueXField: 'ts',
        valueYField: 'ceChange',
        stroke: am5.color(0x22c55e),
        fill: am5.color(0x22c55e),
        tooltip: am5.Tooltip.new(root, {
          labelText: 'CE Change\nChange: {ceChange.formatNumber("#.##")}\nCE Premium: {cePremium.formatNumber("#.##")}\nOpening CE: {ceBase.formatNumber("#.##")}',
        }),
      }));
      positive.strokes.template.setAll({ strokeWidth: 2 });
      positive.fills.template.setAll({ visible: true, fillOpacity: 0.28 });
      positive.data.setAll(decayData);

      const negative = chart.series.push(am5xy.LineSeries.new(root, {
        name: 'PE Change',
        xAxis,
        yAxis,
        valueXField: 'ts',
        valueYField: 'peChange',
        stroke: am5.color(0xef4444),
        fill: am5.color(0xef4444),
        tooltip: am5.Tooltip.new(root, {
          labelText: 'PE Change\nChange: {peChange.formatNumber("#.##")}\nPE Premium: {pePremium.formatNumber("#.##")}\nOpening PE: {peBase.formatNumber("#.##")}',
        }),
      }));
      negative.strokes.template.setAll({ strokeWidth: 2 });
      negative.fills.template.setAll({ visible: true, fillOpacity: 0.28 });
      negative.data.setAll(decayData);

      allSeries.push(positive, negative);
      }
    } else {
      yAxis.setAll({ min: undefined, max: undefined, strictMinMax: false });
    }

    if (metric !== 'premium_decay' && metric !== 'vega_change') {
      selected.forEach((opt, idx) => {
        const color = COLORS[idx % COLORS.length];
        const line = chart.series.push(am5xy.LineSeries.new(root, {
          name: `${opt.strike} ${opt.side}`,
          xAxis,
          yAxis,
          valueXField: 'ts',
          valueYField: 'value',
          stroke: am5.color(color),
          fill: am5.color(color),
          tooltip: am5.Tooltip.new(root, { labelText: `{name}\n${metricLabel(metric)}: {valueY}` }),
        }));
        line.strokes.template.setAll({ strokeWidth: 1.6 });
        line.data.setAll(optionSeries.get(opt.symbol) ?? []);
        allSeries.push(line);
      });
    }

    const spot = chart.series.push(am5xy.LineSeries.new(root, {
      name: metric === 'premium_decay' ? 'Future' : 'Spot',
      xAxis,
      yAxis: spotAxis,
      valueXField: 'ts',
      valueYField: 'value',
      stroke: am5.color(0x93c5fd),
      fill: am5.color(0x93c5fd),
      tooltip: am5.Tooltip.new(root, { labelText: `${metric === 'premium_decay' ? 'Future' : 'Spot'}\nClose: {valueY}` }),
    }));
    spot.strokes.template.setAll({ strokeWidth: 2, strokeDasharray: [4, 3] });
    spot.data.setAll(spotSeries);
    allSeries.push(spot);

    legend.data.setAll(allSeries);
  }, [metric]);

  const selectStrikes = useCallback((spotLast: number) => {
    if (!strikes.length) return [] as number[];
    if (strikeMode === 'custom') {
      const wanted = customStrikes.split(/[,\s]+/).map(Number).filter(Number.isFinite);
      return strikes.filter(strike => wanted.some(w => Math.abs(w - strike) < 0.01));
    }
    const base = strikeMode === 'fixed' && Number(fixedStrike) > 0
      ? Number(fixedStrike)
      : strikes.reduce((best, strike) => Math.abs(strike - spotLast) < Math.abs(best - spotLast) ? strike : best, strikes[0]);
    const baseIdx = Math.max(0, strikes.findIndex(strike => Math.abs(strike - base) < 0.01));
    return strikes.slice(Math.max(0, baseIdx - range), Math.min(strikes.length, baseIdx + range + 1));
  }, [customStrikes, fixedStrike, range, strikeMode, strikes]);

  const handleLoad = useCallback(async () => {
    if (!symbol || !expiry || !options.length) return;
    setLoading(true);
    setStatus('Loading spot history...');
    try {
      const spot = await fetchSpotSeries(exchange, symbol, spotType, mode, date);
      const spotLast = spot.at(-1)?.value ?? strikes[Math.floor(strikes.length / 2)] ?? 0;
      const selectedStrikes = selectStrikes(spotLast);
      const selectedOptions = options.filter(opt => selectedStrikes.includes(opt.strike));
      if (!selectedOptions.length) throw new Error('No CE/PE symbols found for selected strikes');

      setStatus(`Loading ${selectedOptions.length} option series in batches...`);
      const optionMetric = metric === 'premium_decay' ? 'close' : metric === 'vega_change' ? 'vega' : metric;
      const optSeries = await fetchOptionSeries(exchange, selectedOptions, optionMetric, mode, date);
      paintChart(selectedOptions, optSeries, spot);
      setStatus(`${selectedOptions.length} option series loaded. Spot: ${spotLast ? spotLast.toFixed(2) : '-'}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [date, exchange, expiry, metric, mode, options, paintChart, selectStrikes, spotType, strikes, symbol]);

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <div className={`${s.field} ${s.fieldWide}`}>
          <span className={s.label}>Underlying</span>
          <input className={s.input} list="nubra-hist-symbols" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} />
          <datalist id="nubra-hist-symbols">{symbols.map(sym => <option key={sym} value={sym} />)}</datalist>
        </div>

        <div className={s.field}>
          <span className={s.label}>Mode</span>
          <div className={s.segmented}>
            <button type="button" className={mode === 'live' ? s.active : ''} onClick={() => setMode('live')}>Live</button>
            <button type="button" className={mode === 'historical' ? s.active : ''} onClick={() => setMode('historical')}>Historical</button>
          </div>
        </div>

        {mode === 'historical' && (
          <div className={s.field}>
            <span className={s.label}>Date</span>
            <input className={s.input} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
        )}

        <div className={`${s.field} ${s.fieldWide}`}>
          <span className={s.label}>Expiry</span>
          <select className={s.select} value={expiry} onChange={e => setExpiry(e.target.value)}>
            {meta.expiries.map(exp => <option key={exp} value={exp}>{formatExpiry(exp)}</option>)}
          </select>
        </div>

        <div className={s.field}>
          <span className={s.label}>Metric</span>
          <select className={s.select} value={metric} onChange={e => setMetric(e.target.value as Metric)}>
            <option value="close">Close</option>
            <option value="premium_decay">Premium Decay</option>
            <option value="vega_change">Vega Change</option>
            <option value="cumulative_oi">OI</option>
            <option value="gamma">Gamma</option>
            <option value="delta">Delta</option>
            <option value="theta">Theta</option>
            <option value="vega">Vega</option>
          </select>
        </div>

        <div className={s.field}>
          <span className={s.label}>Strikes</span>
          <select className={s.select} value={strikeMode} onChange={e => setStrikeMode(e.target.value as StrikeMode)}>
            <option value="atm">ATM +/- range</option>
            <option value="fixed">Fixed +/- range</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        {strikeMode !== 'custom' ? (
          <>
            {strikeMode === 'fixed' && (
              <div className={s.field}>
                <span className={s.label}>Fixed Strike</span>
                <select className={s.select} value={fixedStrike} onChange={e => setFixedStrike(e.target.value)}>
                  {strikes.map(strike => <option key={strike} value={strike}>{strike}</option>)}
                </select>
              </div>
            )}
            <div className={s.field}>
              <span className={s.label}>Range</span>
              <input className={s.input} type="number" min={0} max={20} value={range} onChange={e => setRange(Math.max(0, Number(e.target.value) || 0))} />
            </div>
          </>
        ) : (
          <div className={`${s.field} ${s.fieldWide}`}>
            <span className={s.label}>Custom Strikes</span>
            <input className={s.input} value={customStrikes} onChange={e => setCustomStrikes(e.target.value)} placeholder="24200, 24300" />
          </div>
        )}

        <button className={s.button} onClick={handleLoad} disabled={loading || !expiry}>{loading ? 'Loading...' : 'Load'}</button>
        <div className={s.status}>{status}</div>
      </div>

      <div className={s.chartWrap}>
        <div ref={chartHostRef} className={s.chart} />
        {!loading && status === 'Select settings and load.' && <div className={s.empty}>Select settings and load Nubra historical series.</div>}
      </div>
    </div>
  );
}
