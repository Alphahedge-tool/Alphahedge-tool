'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { NubraInstrument } from './useNubraInstruments';
import s from './OpenInterest.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  nubraInstruments: NubraInstrument[];
}

type OptionType = 'CE' | 'PE' | 'BOTH';

interface RefDataItem {
  StrikePrice: number;     // in paise (divide by 100)
  OptionType: 'CE' | 'PE';
  StockName: string;
  Expiry: number;
  LotSize: number;
}

interface OIBar {
  strike: number;          // actual price (StrikePrice / 100)
  ce: number;
  pe: number;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function nubraHeaders() {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId     = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie    = localStorage.getItem('nubra_raw_cookie') ?? '';
  return {
    'x-session-token': sessionToken,
    'x-device-id':     deviceId,
    'x-raw-cookie':    rawCookie,
  };
}

// ── Nubra search helpers (mirrors IvChart resolveNubra) ───────────────────────

function resolveNubra(
  sym: string,
  nubraInstruments: NubraInstrument[],
): { nubraSym: string; exchange: string; nubraType: 'INDEX' | 'STOCK' } {
  const upper = sym.toUpperCase();
  const found = nubraInstruments.find(i =>
    (i.option_type === 'CE' || i.option_type === 'PE') &&
    (i.asset?.toUpperCase() === upper ||
     i.nubra_name?.toUpperCase() === upper ||
     i.stock_name?.toUpperCase().startsWith(upper))
  );
  if (found?.asset) {
    const isIndex = (found.asset_type ?? '').includes('INDEX');
    return { nubraSym: found.asset, exchange: found.exchange ?? 'NSE', nubraType: isIndex ? 'INDEX' : 'STOCK' };
  }
  const fallback = nubraInstruments.find(i =>
    i.asset?.toUpperCase() === upper ||
    i.nubra_name?.toUpperCase() === upper ||
    i.stock_name?.toUpperCase().startsWith(upper)
  );
  const isIndex = (fallback?.asset_type ?? '').includes('INDEX');
  return {
    nubraSym: fallback?.asset ?? sym,
    exchange:  fallback?.exchange ?? 'NSE',
    nubraType: isIndex ? 'INDEX' : 'STOCK',
  };
}

// ── Search suggestions ────────────────────────────────────────────────────────

interface Suggestion {
  sym: string;
  exchange: string;
  asset_type: string;
}

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

// ── ECharts loader (dynamic import so it doesn't bloat unless used) ───────────

async function getECharts() {
  const echarts = await import('echarts');
  return echarts;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function OpenInterest({ nubraInstruments }: Props) {
  // Search state
  const [query,        setQuery]        = useState('');
  const [suggestions,  setSuggestions]  = useState<Suggestion[]>([]);
  const [showDrop,     setShowDrop]     = useState(false);
  const [activeIdx,    setActiveIdx]    = useState(-1);

  // Selected symbol state
  const [symbol,    setSymbol]    = useState('');
  const [exchange,  setExchange]  = useState('NSE');
  const [nubraType, setNubraType] = useState<'INDEX' | 'STOCK'>('INDEX');

  // Expiry state
  const [expiries,    setExpiries]    = useState<string[]>([]);
  const [expiry,      setExpiry]      = useState('');

  // View
  const [optType, setOptType] = useState<OptionType>('BOTH');

  // Chart data
  const [bars,      setBars]      = useState<OIBar[]>([]);
  const [totalCe,   setTotalCe]   = useState(0);
  const [totalPe,   setTotalPe]   = useState(0);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  const chartRef   = useRef<HTMLDivElement>(null);
  const wrapRef    = useRef<HTMLDivElement>(null);
  const chartInst  = useRef<any>(null);
  const inputRef   = useRef<HTMLInputElement>(null);

  // ── Search suggestions ──────────────────────────────────────────────────────

  useEffect(() => {
    setSuggestions(buildSuggestions(query, nubraInstruments));
    setActiveIdx(-1);
    setShowDrop(query.length > 0);
  }, [query, nubraInstruments]);

  // ── Fetch expiries from /api/nubra-refdata ──────────────────────────────────

  const fetchExpiries = useCallback(async (sym: string, exch: string) => {
    const headers = nubraHeaders();
    if (!headers['x-session-token']) return;
    try {
      const res = await fetch(
        `/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exch}`,
        { headers }
      );
      if (!res.ok) return;
      const json = await res.json();
      const list: string[] = json?.expiries ?? [];
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const future = list.filter(e => String(e) >= today).sort();
      setExpiries(future);
      setExpiry(future[0] ?? '');
    } catch { /* ignore */ }
  }, []);

  // ── Fetch OI data for a specific expiry ────────────────────────────────────

  const fetchOI = useCallback(async (
    sym: string,
    exch: string,
    exp: string,
    _nType: 'INDEX' | 'STOCK',
  ) => {
    if (!sym || !exp) return;
    setLoading(true);
    setError('');

    const headers = nubraHeaders();
    if (!headers['x-session-token']) {
      setError('NOT LOGGED IN');
      setLoading(false);
      return;
    }

    try {
      // 1. Fetch refdata to get all strikes for this expiry
      const refRes = await fetch(
        `/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exch}&expiry=${exp}`,
        { headers }
      );
      if (!refRes.ok) throw new Error(`refdata ${refRes.status}`);
      const refJson = await refRes.json();
      const refdata: RefDataItem[] = refJson?.refdata ?? [];

      if (!refdata.length) {
        setBars([]);
        setLoading(false);
        return;
      }

      // Collect all unique strike values (in paise, as returned by Nubra)
      const allStrikes = [...new Set(refdata.map(r => r.StrikePrice))].sort((a, b) => a - b);
      const minStrike = allStrikes[0];
      const maxStrike = allStrikes[allStrikes.length - 1];

      // Build time: today at 10:00:00 UTC (= 15:30 IST, market close)
      const todayUtc = new Date();
      const time = `${todayUtc.toISOString().slice(0, 10)}T10:00:00.000Z`;

      // 2. Fetch OI using correct multistrike payload
      const oiRes = await fetch('/api/nubra-open-interest', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: [
            {
              exchange:  exch,
              asset:     sym,
              expiries:  [exp],
              strikes:   allStrikes,
              minStrike,
              maxStrike,
              fields:    ['cumulative_oi'],
              time,
            },
          ],
        }),
      });

      if (!oiRes.ok) throw new Error(`oi ${oiRes.status}`);
      const oiJson = await oiRes.json();

      // Response: result[exchange][asset][time][expiry][strikeInPaise][cumulative_oi][CE|PE]
      // e.g. result.NSE.NIFTY["2026-03-18T10:00:00.000Z"]["20260330"]["2125000"].cumulative_oi.PE
      const assetData = oiJson?.result?.[exch]?.[sym];
      // find the first time key
      const timeKey   = assetData ? Object.keys(assetData)[0] : null;
      const expiryMap = timeKey ? assetData[timeKey]?.[exp] : null;

      // Build bar map keyed by strike (in paise)
      const barMap = new Map<number, OIBar>();
      for (const sp of allStrikes) {
        barMap.set(sp, { strike: sp / 100, ce: 0, pe: 0 });
      }

      if (expiryMap) {
        for (const [spStr, val] of Object.entries(expiryMap as Record<string, any>)) {
          const sp  = parseInt(spStr, 10);
          const bar = barMap.get(sp);
          if (!bar) continue;
          const oiObj = val?.cumulative_oi ?? {};
          if (oiObj.CE != null) bar.ce = oiObj.CE;
          if (oiObj.PE != null) bar.pe = oiObj.PE;
        }
      }

      const sorted = [...barMap.values()].sort((a, b) => a.strike - b.strike);
      setBars(sorted);
      setTotalCe(sorted.reduce((s, b) => s + b.ce, 0));
      setTotalPe(sorted.reduce((s, b) => s + b.pe, 0));
    } catch (e: any) {
      setError(e.message ?? 'ERROR');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Symbol select ───────────────────────────────────────────────────────────

  const handleSymbolSelect = useCallback((sym: string, _exch: string) => {
    const resolved = resolveNubra(sym, nubraInstruments);
    setSymbol(resolved.nubraSym);
    setExchange(resolved.exchange);
    setNubraType(resolved.nubraType);
    setQuery(resolved.nubraSym);
    setShowDrop(false);
    setExpiries([]);
    setExpiry('');
    setBars([]);
    fetchExpiries(resolved.nubraSym, resolved.exchange);
  }, [nubraInstruments, fetchExpiries]);

  // ── Auto-load when expiry changes ───────────────────────────────────────────

  useEffect(() => {
    if (symbol && expiry) {
      fetchOI(symbol, exchange, expiry, nubraType);
    }
  }, [symbol, expiry, exchange, nubraType, fetchOI]);

  // ── ECharts rendering ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return;
    let inst = chartInst.current;

    getECharts().then(echarts => {
      if (!chartRef.current) return;
      if (!inst) {
        inst = echarts.init(chartRef.current, null, { renderer: 'canvas' });
        chartInst.current = inst;
      }

      if (!bars.length) {
        inst.clear();
        return;
      }

      const filtered = bars.filter(b => {
        if (optType === 'CE') return b.ce > 0;
        if (optType === 'PE') return b.pe > 0;
        return b.ce > 0 || b.pe > 0;
      });

      const strikes   = filtered.map(b => b.strike.toLocaleString('en-IN'));
      const ceValues  = filtered.map(b => b.ce);
      const peValues  = filtered.map(b => b.pe);

      const CE_COLOR = '#F6465D';   // red  — Call
      const PE_COLOR = '#0ECB81';   // green — Put

      const barW = optType === 'BOTH' ? 14 : 18;

      const series: any[] = [];
      if (optType === 'CE' || optType === 'BOTH') {
        series.push({
          name: 'Call OI',
          type: 'bar',
          data: ceValues,
          barMaxWidth: barW,
          barGap: '4%',
          itemStyle: { color: CE_COLOR, borderRadius: [3, 3, 0, 0] },
          emphasis: { focus: 'series', itemStyle: { shadowBlur: 8, shadowColor: 'rgba(33,150,243,0.5)' } },
        });
      }
      if (optType === 'PE' || optType === 'BOTH') {
        series.push({
          name: 'Put OI',
          type: 'bar',
          data: peValues,
          barMaxWidth: barW,
          barGap: '4%',
          itemStyle: { color: PE_COLOR, borderRadius: [3, 3, 0, 0] },
          emphasis: { focus: 'series', itemStyle: { shadowBlur: 8, shadowColor: 'rgba(255,87,34,0.5)' } },
        });
      }

      const fmtOI = (v: number) => {
        if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
        if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
        if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
        return String(v);
      };

      inst.setOption({
        backgroundColor: '#131110',
        animation: true,
        animationDuration: 350,
        animationEasing: 'cubicOut',
        grid: { left: 72, right: 12, top: optType === 'BOTH' ? 44 : 20, bottom: 62 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.025)' } },
          backgroundColor: '#1c1a17',
          borderColor: 'rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: [10, 14],
          extraCssText: 'box-shadow:0 12px 32px rgba(0,0,0,0.8);',
          formatter(params: any[]) {
            const strike = params[0]?.axisValue ?? '';
            let html = `<div style="font-size:14px;font-weight:700;margin-bottom:8px;color:#ffffff;letter-spacing:0.02em">${strike}</div>`;
            for (const p of params) {
              if (!p.value) continue;
              const color = p.seriesName === 'Call OI' ? '#F6465D' : '#0ECB81';
              const val   = fmtOI(Number(p.value));
              html += `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                <span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block;flex-shrink:0"></span>
                <span style="color:#ffffff;font-weight:600;font-size:12px">${p.seriesName}</span>
                <span style="color:${color};margin-left:12px;font-weight:700;font-size:13px">${val}</span>
              </div>`;
            }
            return html;
          },
        },
        legend: {
          show: optType === 'BOTH',
          top: 10,
          left: 'center',
          textStyle: { color: '#ffffff', fontSize: 12, fontWeight: 600 },
          itemWidth: 14,
          itemHeight: 10,
          itemStyle: { borderRadius: 2 },
          data: [
            { name: 'Call OI', itemStyle: { color: CE_COLOR } },
            { name: 'Put OI',  itemStyle: { color: PE_COLOR } },
          ],
        },
        xAxis: {
          type: 'category',
          data: strikes,
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 600,
            rotate: strikes.length > 24 ? 45 : 0,
            interval: Math.max(0, Math.floor(strikes.length / 18)),
            margin: 10,
          },
          splitLine: { show: false },
          name: 'Strike Price',
          nameLocation: 'middle',
          nameGap: strikes.length > 24 ? 46 : 28,
          nameTextStyle: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: 500 },
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)', type: 'dashed' } },
          axisLabel: {
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 600,
            margin: 10,
            formatter: fmtOI,
          },
        },
        dataZoom: [
          { type: 'inside', start: 0, end: 100, zoomOnMouseWheel: true },
          {
            type: 'slider',
            bottom: 8,
            height: 22,
            borderColor: 'rgba(255,255,255,0.08)',
            backgroundColor: 'rgba(255,255,255,0.03)',
            fillerColor: 'rgba(79,142,247,0.15)',
            handleStyle: { color: '#4f8ef7', borderColor: '#4f8ef7' },
            handleSize: '80%',
            moveHandleStyle: { color: '#4f8ef7' },
            dataBackground: {
              lineStyle: { color: 'rgba(255,255,255,0.1)' },
              areaStyle: { color: 'rgba(255,255,255,0.04)' },
            },
            selectedDataBackground: {
              lineStyle: { color: 'rgba(79,142,247,0.5)' },
              areaStyle: { color: 'rgba(79,142,247,0.1)' },
            },
            textStyle: { color: '#ffffff', fontSize: 10 },
            labelFormatter: (_: any, val: string) => val,
          },
        ],
        series,
      }, true);
    });
  }, [bars, optType]);

  // Resize observer — watch the wrap so resize fires even when bars mount/unmount
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => chartInst.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Cleanup
  useEffect(() => () => { chartInst.current?.dispose(); chartInst.current = null; }, []);

  // ── Keyboard nav ────────────────────────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showDrop || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      const sg = suggestions[activeIdx];
      handleSymbolSelect(sg.sym, sg.exchange);
    }
    else if (e.key === 'Escape') { setShowDrop(false); }
  }, [showDrop, suggestions, activeIdx, handleSymbolSelect]);

  // ── Formatters ───────────────────────────────────────────────────────────────

  function fmtLakh(v: number): string {
    if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
    if (v >= 1e5) return `${(v / 1e5).toFixed(2)} Lakh`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return String(v);
  }

  function fmtExpiry(e: string) {
    if (e.length !== 8) return e;
    return `${e.slice(6, 8)}/${e.slice(4, 6)}/${e.slice(0, 4)}`;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className={s.root}>
      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          {/* Symbol search */}
          <div className={s.searchWrap}>
            <div className={s.searchBox}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                ref={inputRef}
                className={s.searchInput}
                placeholder="Search symbol…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onFocus={() => query && setShowDrop(true)}
                onBlur={() => setTimeout(() => setShowDrop(false), 150)}
                onKeyDown={onKeyDown}
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button className={s.clearBtn} onMouseDown={e => { e.preventDefault(); setQuery(''); setShowDrop(false); setSuggestions([]); }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>

            {showDrop && suggestions.length > 0 && (
              <div className={s.dropdown}>
                <div className={s.dropdownList}>
                  {suggestions.map((sg, i) => (
                    <div
                      key={`${sg.sym}|${sg.exchange}`}
                      className={`${s.dropdownItem} ${i === activeIdx ? s.dropdownItemActive : ''}`}
                      onMouseDown={() => handleSymbolSelect(sg.sym, sg.exchange)}
                    >
                      <span className={s.dropdownExch}>{sg.exchange}</span>
                      <span className={s.dropdownSym}>{sg.sym}</span>
                      <span className={s.dropdownType}>
                        {sg.asset_type.includes('INDEX') ? 'INDEX' : 'STOCK'}
                      </span>
                    </div>
                  ))}
                </div>
                <div className={s.dropdownFooter}>
                  <span><kbd>↑↓</kbd> navigate</span>
                  <span><kbd>↵</kbd> select</span>
                  <span><kbd>Esc</kbd> close</span>
                </div>
              </div>
            )}
          </div>

          {/* Expiry */}
          {expiries.length > 0 && (
            <select
              className={s.expirySelect}
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
            >
              {expiries.map(e => (
                <option key={e} value={e}>{fmtExpiry(e)}</option>
              ))}
            </select>
          )}
        </div>

        <div className={s.toolbarRight}>
          {/* CE / PE / BOTH toggle */}
          <div className={s.typeToggle}>
            <button
              className={`${s.typeBtn} ${optType === 'CE' ? s.typeBtnCeActive : ''}`}
              onClick={() => setOptType('CE')}
            >CE</button>
            <button
              className={`${s.typeBtn} ${optType === 'BOTH' ? s.typeBtnBothActive : ''}`}
              onClick={() => setOptType('BOTH')}
            >BOTH</button>
            <button
              className={`${s.typeBtn} ${optType === 'PE' ? s.typeBtnPeActive : ''}`}
              onClick={() => setOptType('PE')}
            >PE</button>
          </div>

          {loading && <div className={s.loadingDot} />}
          {error   && <span className={s.errorLabel}>{error}</span>}
        </div>
      </div>

      {/* ── Chart ── */}
      <div ref={wrapRef} className={s.chartWrap}>
        {!symbol ? (
          <div className={s.placeholder}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="4" height="18"/><rect x="10" y="8" width="4" height="13"/><rect x="18" y="5" width="4" height="16"/>
            </svg>
            <span>Search a symbol to view open interest</span>
          </div>
        ) : !bars.length && !loading ? (
          <div className={s.placeholder}>
            <span>No OI data for selected expiry</span>
          </div>
        ) : (
          <div ref={chartRef} style={{ width: '100%', height: '100%' }} />
        )}

        {/* ── Info box ── */}
        {bars.length > 0 && (
          <div className={s.infoBox}>
            <div className={s.infoItem}>
              <span className={s.infoLabel}>Total Call OI</span>
              <span className={s.infoValueRed}>{fmtLakh(totalCe)}</span>
            </div>
            <div className={s.infoDivider} />
            <div className={s.infoItem}>
              <span className={s.infoLabel}>Total Put OI</span>
              <span className={s.infoValueGreen}>{fmtLakh(totalPe)}</span>
            </div>
            <div className={s.infoDivider} />
            <div className={s.infoItem}>
              <span className={s.infoLabel}>PCR</span>
              <span className={s.infoValueWhite}>
                {totalCe > 0 ? (totalPe / totalCe).toFixed(2) : '—'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
