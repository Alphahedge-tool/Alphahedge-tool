'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts';
import type { NubraInstrument } from './useNubraInstruments';

interface Props {
  nubraInstruments: NubraInstrument[];
  initialSymbol?: string;
}

interface SymbolChoice {
  sym: string;
  exchange: string;
  lotSize: number;
}

interface OptionSide {
  volume: number;
  oi: number;
  delta: number;
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

interface PcrMetrics {
  callVolume: number;
  putVolume: number;
  callDeltaPressure: number;
  putDeltaPressure: number;
  volumePcr: number | null;
  deltaPcr: number | null;
}

const EMPTY_SIDE: OptionSide = {
  volume: 0,
  oi: 0,
  delta: 0,
};

const BRIDGE = 'ws://localhost:8765';
const DEFAULT_SYMBOL = 'NIFTY';

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

function buildSuggestions(nubraInstruments: NubraInstrument[]): SymbolChoice[] {
  const seen = new Set<string>();
  const out: SymbolChoice[] = [];
  for (const item of nubraInstruments) {
    const sym = item.asset ?? item.nubra_name ?? '';
    if (!sym) continue;
    const assetType = (item.asset_type ?? '').toUpperCase();
    if (assetType !== 'INDEX_FO' && assetType !== 'STOCK_FO') continue;
    const exchange = item.exchange ?? 'NSE';
    const key = `${sym}|${exchange}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sym,
      exchange,
      lotSize: item.lot_size ?? 1,
    });
  }
  return out.sort((a, b) => a.sym.localeCompare(b.sym));
}

function resolveNubra(sym: string, nubraInstruments: NubraInstrument[]) {
  const upper = sym.toUpperCase();
  const found = nubraInstruments.find(item =>
    (item.option_type === 'CE' || item.option_type === 'PE') &&
    (
      item.asset?.toUpperCase() === upper ||
      item.nubra_name?.toUpperCase() === upper ||
      item.stock_name?.toUpperCase().startsWith(upper)
    )
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

function parseRestOption(opt: Record<string, number>): OptionSide {
  const volume = opt.volume ?? opt.vol ?? opt.total_volume ?? 0;
  return {
    volume,
    oi: opt.oi ?? 0,
    delta: opt.delta ?? 0,
  };
}

function parseWsOption(opt: Record<string, number>): OptionSide {
  const volume = opt.volume ?? opt.traded_volume ?? opt.total_traded_volume ?? 0;
  return {
    volume,
    oi: opt.open_interest ?? 0,
    delta: opt.delta ?? 0,
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
    volume: live?.volume ?? base?.volume ?? 0,
    oi: live?.oi ?? base?.oi ?? 0,
    delta: live?.delta ?? base?.delta ?? 0,
  };
}

function mergeChainSnapshot(base: ChainSnapshot | undefined, live: ChainSnapshot): ChainSnapshot {
  if (!base) return live;

  const baseMap = new Map(base.rows.map(row => [row.strike, row]));
  const liveMap = new Map(live.rows.map(row => [row.strike, row]));
  const strikes = new Set<number>([
    ...base.rows.map(row => row.strike),
    ...live.rows.map(row => row.strike),
  ]);

  const rows = [...strikes]
    .sort((a, b) => a - b)
    .map(strike => {
      const prev = baseMap.get(strike);
      const next = liveMap.get(strike);
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

async function fetchOptionChainSnapshot(session: string, sym: string, exchange: string, expiry: string): Promise<ChainSnapshot> {
  const url = `/api/nubra-optionchain?session_token=${encodeURIComponent(session)}&instrument=${encodeURIComponent(sym)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load option chain (${res.status})`);
  const json = await res.json();
  const chain = json.chain ?? json;
  return buildChainSnapshot(chain.ce ?? [], chain.pe ?? [], chain.atm ?? 0, chain.cp ?? chain.current_price ?? 0);
}

function fmtExpiry(expiry: string) {
  if (!expiry || !/^\d{8}$/.test(expiry)) return expiry || 'Select expiry';
  return new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function expiryLabel(expiry: string) {
  return fmtExpiry(expiry);
}

function fmtCompact(n: number) {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtRatio(n: number | null) {
  if (n == null || !Number.isFinite(n)) return '--';
  return n.toFixed(2);
}

function computeMetrics(chains: ChainSnapshot[]): PcrMetrics {
  if (chains.length === 0) {
    return {
      callVolume: 0,
      putVolume: 0,
      callDeltaPressure: 0,
      putDeltaPressure: 0,
      volumePcr: null,
      deltaPcr: null,
    };
  }

  let callVolume = 0;
  let putVolume = 0;
  let callDeltaPressure = 0;
  let putDeltaPressure = 0;

  for (const chain of chains) {
    for (const row of chain.rows) {
      callVolume += row.ce.volume;
      putVolume += row.pe.volume;
      callDeltaPressure += Math.abs(row.ce.delta) * row.ce.oi;
      putDeltaPressure += Math.abs(row.pe.delta) * row.pe.oi;
    }
  }

  return {
    callVolume,
    putVolume,
    callDeltaPressure,
    putDeltaPressure,
    volumePcr: callVolume > 0 ? putVolume / callVolume : null,
    deltaPcr: callDeltaPressure > 0 ? putDeltaPressure / callDeltaPressure : null,
  };
}

function upsertLineData(series: LineData[], point: LineData) {
  if (series.length === 0) return [point];
  const last = series[series.length - 1];
  if (last.time === point.time) {
    return [...series.slice(0, -1), point];
  }
  const next = [...series, point];
  return next.length > 360 ? next.slice(next.length - 360) : next;
}

export default function DeltaVolPcr({ nubraInstruments, initialSymbol = DEFAULT_SYMBOL }: Props) {
  const symbols = useMemo(() => buildSuggestions(nubraInstruments), [nubraInstruments]);
  const [symbol, setSymbol] = useState(initialSymbol);
  const [exchange, setExchange] = useState('NSE');
  const [lotSize, setLotSize] = useState(1);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiries, setSelectedExpiries] = useState<Set<string>>(new Set());
  const [expiryDropOpen, setExpiryDropOpen] = useState(false);
  const [chains, setChains] = useState<Record<string, ChainSnapshot>>({});
  const [deltaHistory, setDeltaHistory] = useState<LineData[]>([]);
  const [volumeHistory, setVolumeHistory] = useState<LineData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [wsState, setWsState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');

  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const deltaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryDropRef = useRef<HTMLDivElement | null>(null);
  const selectedExpiriesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    selectedExpiriesRef.current = selectedExpiries;
  }, [selectedExpiries]);

  const selectedSymbol = useMemo(
    () => symbols.find(item => item.sym.toUpperCase() === symbol.toUpperCase()) ?? null,
    [symbols, symbol],
  );

  const pickedExpiries = useMemo(() => [...selectedExpiries], [selectedExpiries]);
  const activeChains = useMemo(
    () => pickedExpiries.map(expiry => chains[expiry]).filter(Boolean) as ChainSnapshot[],
    [chains, pickedExpiries],
  );
  const metrics = useMemo(() => computeMetrics(activeChains), [activeChains]);
  const leadChain = activeChains[0] ?? null;

  useEffect(() => {
    if (!expiryDropOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (expiryDropRef.current && !expiryDropRef.current.contains(event.target as Node)) {
        setExpiryDropOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [expiryDropOpen]);

  useEffect(() => {
    if (selectedSymbol) {
      setExchange(selectedSymbol.exchange);
      setLotSize(selectedSymbol.lotSize);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    if (symbols.length === 0) return;
    const preferred = symbols.find(item => item.sym.toUpperCase() === initialSymbol.toUpperCase())
      ?? symbols.find(item => item.sym.toUpperCase() === DEFAULT_SYMBOL)
      ?? symbols[0];
    if (!preferred) return;
    setSymbol(preferred.sym);
    setExchange(preferred.exchange);
    setLotSize(preferred.lotSize);
  }, [initialSymbol, symbols]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
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
          const filtered = new Set([...prev].filter(expiry => nextExpiries.includes(expiry)));
          if (filtered.size > 0) return filtered;
          return new Set(nextExpiries.slice(0, Math.min(2, nextExpiries.length)));
        });
      } catch (err: any) {
        if (cancelled) return;
        setExpiries([]);
        setSelectedExpiries(new Set());
        setChains({});
        setError(err?.message ?? 'Failed to load expiries');
      }
    };
    load();
    return () => { cancelled = true; };
  }, [symbol, exchange, nubraInstruments]);

  useEffect(() => {
    let cancelled = false;
    const session = getSession();
    const resolved = resolveNubra(symbol, nubraInstruments);

    const load = async () => {
      if (!session || !resolved.nubraSym || pickedExpiries.length === 0) {
        setChains({});
        setDeltaHistory([]);
        setVolumeHistory([]);
        return;
      }

      setLoading(true);
      setError('');
      try {
        const entries = await Promise.all(
          pickedExpiries.map(async expiry => [expiry, await fetchOptionChainSnapshot(session, resolved.nubraSym, resolved.exchange, expiry)] as const),
        );
        if (cancelled) return;
        const nextChains = Object.fromEntries(entries);
        const nextMetrics = computeMetrics(Object.values(nextChains));
        const time = Math.floor(Date.now() / 60_000) * 60;
        setChains(nextChains);
        setDeltaHistory(nextMetrics.deltaPcr != null ? [{ time: time as Time, value: nextMetrics.deltaPcr }] : []);
        setVolumeHistory(nextMetrics.volumePcr != null ? [{ time: time as Time, value: nextMetrics.volumePcr }] : []);
        setLastUpdated(Date.now());
      } catch (err: any) {
        if (cancelled) return;
        setChains({});
        setDeltaHistory([]);
        setVolumeHistory([]);
        setError(err?.message ?? 'Failed to load option chain');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [symbol, pickedExpiries, nubraInstruments]);

  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (wsRetryRef.current) {
      clearTimeout(wsRetryRef.current);
      wsRetryRef.current = null;
    }

    const session = getSession();
    const resolved = resolveNubra(symbol, nubraInstruments);
    if (!session || !resolved.nubraSym || pickedExpiries.length === 0) {
      setWsState('idle');
      return;
    }

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      setWsState('connecting');

      const ws = new WebSocket(BRIDGE);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsState('live');
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
          if (msg.type === 'connected') {
            setWsState('live');
            return;
          }
          if (msg.type === 'error') {
            setWsState('error');
            return;
          }
          if (msg.type !== 'option' || !msg.data?.expiry) return;
          const expiry = String(msg.data.expiry);
          if (!selectedExpiriesRef.current.has(expiry)) return;
          const liveSnap = buildChainSnapshotWs(
            msg.data.ce ?? [],
            msg.data.pe ?? [],
            msg.data.at_the_money_strike ?? 0,
            msg.data.current_price ?? 0,
          );

          setChains(prev => {
            const mergedByExpiry = {
              ...prev,
              [expiry]: mergeChainSnapshot(prev[expiry] ?? undefined, liveSnap),
            };
            const nextMetrics = computeMetrics(
              [...selectedExpiriesRef.current].map(selected => mergedByExpiry[selected]).filter(Boolean) as ChainSnapshot[],
            );
            const pointTime = Math.floor(Date.now() / 60_000) * 60;

            if (nextMetrics.deltaPcr != null) {
              const deltaPcr = nextMetrics.deltaPcr;
              setDeltaHistory(prevSeries => upsertLineData(prevSeries, {
                time: pointTime as Time,
                value: deltaPcr,
              }));
            }

            if (nextMetrics.volumePcr != null) {
              const volumePcr = nextMetrics.volumePcr;
              setVolumeHistory(prevSeries => upsertLineData(prevSeries, {
                time: pointTime as Time,
                value: volumePcr,
              }));
            }

            setLastUpdated(Date.now());
            return mergedByExpiry;
          });
        } catch {
          // Ignore malformed bridge frames.
        }
      };

      ws.onerror = () => {
        setWsState('error');
      };

      ws.onclose = () => {
        if (cancelled) return;
        setWsState('error');
        wsRetryRef.current = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (wsRetryRef.current) {
        clearTimeout(wsRetryRef.current);
        wsRetryRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      setWsState('idle');
    };
  }, [symbol, pickedExpiries, nubraInstruments]);

  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { color: '#131110' },
        textColor: '#a09080',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: {
        visible: true,
        borderColor: 'rgba(255,255,255,0.1)',
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      leftPriceScale: { visible: false },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.1)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (t: Time) =>
          new Date(Number(t) * 1000).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }),
      },
      localization: {
        timeFormatter: (t: Time) =>
          new Date(Number(t) * 1000).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }),
        priceFormatter: (p: number) => p.toFixed(2),
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.3)', width: 1, style: 2, labelVisible: true },
        horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: 2, labelVisible: true },
      },
      handleScroll: true,
      handleScale: true,
    });

    const deltaSeries = chart.addSeries(LineSeries, {
      color: '#60a5fa',
      lineWidth: 2,
      title: 'Delta PCR',
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110',
      crosshairMarkerBackgroundColor: '#60a5fa',
    });

    const volumeSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      title: 'Vol PCR',
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#131110',
      crosshairMarkerBackgroundColor: '#f59e0b',
    });

    chartRef.current = chart;
    deltaSeriesRef.current = deltaSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chartRef.current?.remove();
      chartRef.current = null;
      deltaSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    deltaSeriesRef.current?.setData(deltaHistory);
    volumeSeriesRef.current?.setData(volumeHistory);
    if (deltaHistory.length || volumeHistory.length) {
      chartRef.current?.timeScale().fitContent();
    }
  }, [deltaHistory, volumeHistory]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#131110', color: '#e2e8f0', fontFamily: 'var(--font-family-sans, system-ui, sans-serif)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginRight: 4 }}>Delta & Vol PCR</span>

        <select value={symbol} onChange={e => setSymbol(e.target.value)} style={selectStyle}>
          {symbols.map(item => <option key={`${item.sym}-${item.exchange}`} value={item.sym}>{item.sym}</option>)}
        </select>

        <div ref={expiryDropRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setExpiryDropOpen(open => !open)}
            style={{ ...selectStyle, minWidth: 150, textAlign: 'left' }}
            disabled={expiries.length === 0}
          >
            {pickedExpiries.length === 0
              ? 'Select expiry'
              : pickedExpiries.length === 1
                ? expiryLabel(pickedExpiries[0])
                : `${pickedExpiries.length} expiries`}
          </button>
          {expiryDropOpen && expiries.length > 0 && (
            <div style={{
              position: 'absolute',
              top: '110%',
              left: 0,
              zIndex: 50,
              minWidth: 180,
              background: '#1c1a17',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              padding: '6px 0',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}>
              {expiries.map(expiry => {
                const checked = selectedExpiries.has(expiry);
                return (
                  <label
                    key={expiry}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 12px',
                      cursor: 'pointer',
                      fontSize: 12,
                      color: checked ? '#e2e8f0' : '#94a3b8',
                      background: checked ? 'rgba(96,165,250,0.12)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelectedExpiries(prev => {
                          const next = new Set(prev);
                          if (next.has(expiry)) {
                            next.delete(expiry);
                          } else {
                            next.add(expiry);
                          }
                          return next;
                        });
                      }}
                      style={{ accentColor: '#60a5fa' }}
                    />
                    {expiryLabel(expiry)}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 12, marginLeft: 8, fontSize: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 20, height: 2, background: '#60a5fa', display: 'inline-block', borderRadius: 1 }} />
            Delta PCR
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 20, height: 2, background: '#f59e0b', display: 'inline-block', borderRadius: 1 }} />
            Vol PCR
          </span>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <MetricPill label="Spot" value={leadChain?.spot ? leadChain.spot.toFixed(2) : '--'} tone="#cbd5e1" />
          <MetricPill label="ATM" value={leadChain?.atm ? leadChain.atm.toFixed(2) : '--'} tone="#93c5fd" />
          <MetricPill label="Lot" value={String(lotSize)} tone="#fcd34d" />
          <MetricPill
            label="WS"
            value={wsState === 'live' ? 'LIVE' : wsState === 'connecting' ? 'CONNECTING' : wsState === 'error' ? 'RETRYING' : 'IDLE'}
            tone={wsState === 'live' ? '#4ade80' : wsState === 'connecting' ? '#facc15' : wsState === 'error' ? '#f87171' : '#94a3b8'}
          />
          {lastUpdated && (
            <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>
              {new Date(lastUpdated).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: '6px 12px', background: 'rgba(239,68,68,0.12)', color: '#fca5a5', fontSize: 11, borderBottom: '1px solid rgba(239,68,68,0.2)', flexShrink: 0 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, padding: 12, borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <RatioDonutCard
          title="Delta PCR"
          ratio={metrics.deltaPcr}
          leftValue={metrics.callDeltaPressure}
          rightValue={metrics.putDeltaPressure}
          leftLabel="Call Delta"
          rightLabel="Put Delta"
          leftColor="#4ade80"
          rightColor="#f87171"
          subtitle="Sum(|delta| x OI) across selected expiries"
        />
        <RatioDonutCard
          title="Vol PCR"
          ratio={metrics.volumePcr}
          leftValue={metrics.callVolume}
          rightValue={metrics.putVolume}
          leftLabel="Call Vol"
          rightLabel="Put Vol"
          leftColor="#4ade80"
          rightColor="#f59e0b"
          subtitle="Total traded volume across selected expiries"
        />
      </div>

      <div style={{ flex: 1, minHeight: 220, position: 'relative' }}>
        <div ref={chartHostRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          <div style={overlayStyle}>Loading option chain...</div>
        )}
        {!loading && !error && deltaHistory.length === 0 && volumeHistory.length === 0 && (
          <div style={overlayStyle}>Waiting for snapshot data...</div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, padding: 12, borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <MiniStat label="Call Volume" value={fmtCompact(metrics.callVolume)} color="#4ade80" />
        <MiniStat label="Put Volume" value={fmtCompact(metrics.putVolume)} color="#f87171" />
        <MiniStat label="Expiries" value={pickedExpiries.length ? String(pickedExpiries.length) : '--'} color="#cbd5e1" />
        <MiniStat label="Exchange" value={exchange} color="#cbd5e1" />
      </div>
    </div>
  );
}

function RatioDonutCard({
  title,
  ratio,
  leftValue,
  rightValue,
  leftLabel,
  rightLabel,
  leftColor,
  rightColor,
  subtitle,
}: {
  title: string;
  ratio: number | null;
  leftValue: number;
  rightValue: number;
  leftLabel: string;
  rightLabel: string;
  leftColor: string;
  rightColor: string;
  subtitle: string;
}) {
  const total = Math.abs(leftValue) + Math.abs(rightValue);
  const leftPct = total > 0 ? Math.abs(leftValue) / total : 0;
  const rightPct = total > 0 ? Math.abs(rightValue) / total : 0;
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '12px 14px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ position: 'relative', width: 118, height: 118, flexShrink: 0 }}>
        <svg width="118" height="118" viewBox="0 0 118 118">
          <circle cx="59" cy="59" r="38" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="18" />
          <path
            d="M 59 21 A 38 38 0 0 0 59 97"
            fill="none"
            stroke={leftColor}
            strokeWidth="18"
            opacity={0.2 + leftPct * 0.8}
          />
          <path
            d="M 59 21 A 38 38 0 0 1 59 97"
            fill="none"
            stroke={rightColor}
            strokeWidth="18"
            opacity={0.2 + rightPct * 0.8}
          />
          <text x="59" y="50" textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.45)" letterSpacing="0.8">{title.toUpperCase()}</text>
          <text x="59" y="67" textAnchor="middle" fontSize="22" fontWeight="700" fill="#f8fafc">{fmtRatio(ratio)}</text>
        </svg>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.42)', marginBottom: 10 }}>{subtitle}</div>
        <LegendMetric label={leftLabel} value={fmtCompact(leftValue)} color={leftColor} />
        <LegendMetric label={rightLabel} value={fmtCompact(rightValue)} color={rightColor} />
      </div>
    </div>
  );
}

function LegendMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.68)' }}>{label}</span>
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

function MetricPill({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 999, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.09)', fontSize: 11 }}>
      <span style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</span>
      <span style={{ color: tone, fontWeight: 700 }}>{value}</span>
    </span>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: 12,
  padding: '4px 8px',
  cursor: 'pointer',
  outline: 'none',
};

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255,255,255,0.3)',
  fontSize: 13,
  pointerEvents: 'none',
};
