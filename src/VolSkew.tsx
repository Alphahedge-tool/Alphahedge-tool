'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { NubraInstrument } from './useNubraInstruments';
import s from './VolSkew.module.css';

interface Props { nubraInstruments: NubraInstrument[]; }

interface RefDataItem { StrikePrice: number; OptionType: 'CE' | 'PE'; }

interface SkewPoint { strike: number; ce: number; pe: number; }

// per-expiry data
type ExpiryData = Map<string, SkewPoint[]>; // expiry → sorted points

function nubraHeaders() {
  return {
    'x-session-token': localStorage.getItem('nubra_session_token') ?? '',
    'x-device-id':     localStorage.getItem('nubra_device_id') ?? 'web',
    'x-raw-cookie':    localStorage.getItem('nubra_raw_cookie') ?? '',
  };
}

function lastTradingUtcIso(): string {
  const istMs  = Date.now() + 5.5 * 3600 * 1000;
  const d      = new Date(istMs);
  const istMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const OPEN = 9 * 60 + 15, CLOSE = 15 * 60 + 30;
  const isWeekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  if (isWeekday && istMin >= OPEN && istMin <= CLOSE) {
    const utcMin = istMin - 330;
    const h = Math.floor(((utcMin % 1440) + 1440) % 1440 / 60);
    const m = ((utcMin % 1440) + 1440) % 1440 % 60;
    return `${d.toISOString().slice(0, 10)}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00.000Z`;
  }
  if (isWeekday && istMin < OPEN) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}T10:00:00.000Z`;
}

// colours per expiry index
const EXPIRY_COLORS = ['#4f8ef7','#f97316','#a78bfa','#0ECB81','#F6465D','#facc15','#22d3ee','#e879f9'];

interface Suggestion { sym: string; exchange: string; asset_type: string; }

function buildSuggestions(q: string, instruments: NubraInstrument[]): Suggestion[] {
  if (!q) return [];
  const uq = q.toUpperCase();
  const seen = new Set<string>(); const out: Suggestion[] = [];
  for (const i of instruments) {
    if (i.option_type !== 'CE' && i.option_type !== 'PE') continue;
    const sym = i.asset ?? i.nubra_name ?? ''; if (!sym) continue;
    const key = `${sym}|${i.exchange}`; if (seen.has(key)) continue;
    if (sym.toUpperCase().includes(uq) || i.stock_name?.toUpperCase().includes(uq)) {
      seen.add(key);
      out.push({ sym, exchange: i.exchange ?? 'NSE', asset_type: i.asset_type ?? '' });
      if (out.length >= 20) break;
    }
  }
  return out;
}

function resolveNubra(sym: string, instruments: NubraInstrument[]) {
  const upper = sym.toUpperCase();
  const found = instruments.find(i =>
    (i.option_type === 'CE' || i.option_type === 'PE') &&
    (i.asset?.toUpperCase() === upper || i.nubra_name?.toUpperCase() === upper || i.stock_name?.toUpperCase().startsWith(upper))
  );
  const isIndex = ((found ?? instruments.find(i => i.asset?.toUpperCase() === upper))?.asset_type ?? '').includes('INDEX');
  return { nubraSym: found?.asset ?? sym, exchange: found?.exchange ?? 'NSE', nubraType: isIndex ? 'INDEX' as const : 'STOCK' as const };
}

function fmtExpiry(e: string) {
  if (e.length !== 8) return e;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${e.slice(6,8)} ${months[+e.slice(4,6)-1]} ${e.slice(2,4)}`;
}

async function getECharts() { return import('echarts'); }

async function fetchSkewForExpiry(sym: string, exch: string, exp: string, headers: Record<string,string>): Promise<SkewPoint[]> {
  const refRes = await fetch(`/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exch}&expiry=${exp}`, { headers });
  if (!refRes.ok) return [];
  const refdata: RefDataItem[] = (await refRes.json())?.refdata ?? [];
  if (!refdata.length) return [];

  const allStrikes = [...new Set(refdata.map(r => r.StrikePrice))].sort((a, b) => a - b);
  const time = lastTradingUtcIso();

  const ivRes = await fetch('/api/nubra-iv', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: [{ exchange: exch, asset: sym, expiries: [exp], strikes: allStrikes, minStrike: allStrikes[0], maxStrike: allStrikes[allStrikes.length-1], fields: ['iv_mid'], time }] }),
  });
  if (!ivRes.ok) return [];
  const ivJson = await ivRes.json();

  const assetData = ivJson?.result?.[exch]?.[sym];
  const timeKey   = assetData ? Object.keys(assetData)[0] : null;
  const expiryMap = timeKey ? assetData[timeKey]?.[exp] : null;

  const ptMap = new Map<number, SkewPoint>();
  for (const sp of allStrikes) ptMap.set(sp, { strike: sp / 100, ce: 0, pe: 0 });
  if (expiryMap) {
    for (const [spStr, val] of Object.entries(expiryMap as Record<string,any>)) {
      const sp = parseInt(spStr, 10); const pt = ptMap.get(sp); if (!pt) continue;
      const iv = (val as any)?.iv_mid ?? {};
      if (iv.CE != null) pt.ce = iv.CE * 100;
      if (iv.PE != null) pt.pe = iv.PE * 100;
    }
  }
  return [...ptMap.values()].filter(p => p.ce > 0 || p.pe > 0).sort((a,b) => a.strike - b.strike);
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function VolSkew({ nubraInstruments }: Props) {
  const [query,     setQuery]     = useState('');
  const [showDrop,  setShowDrop]  = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const suggestions = useMemo(() => buildSuggestions(query, nubraInstruments), [query, nubraInstruments]);
  const inputRef = useRef<HTMLInputElement>(null);

  const [symbol,   setSymbol]   = useState('');
  const [exchange, setExchange] = useState('NSE');

  const [expiries,         setExpiries]         = useState<string[]>([]);
  const [selectedExpiries, setSelectedExpiries] = useState<Set<string>>(new Set());
  const [showExpiryDrop,   setShowExpiryDrop]   = useState(false);
  const expiryDDRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (expiryDDRef.current && !expiryDDRef.current.contains(e.target as Node)) setShowExpiryDrop(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const [optType, setOptType] = useState<'CE' | 'PE' | 'BOTH'>('BOTH');

  // per-expiry data
  const [expiryData, setExpiryData] = useState<ExpiryData>(new Map());
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');

  const chartRef  = useRef<HTMLDivElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  const chartInst = useRef<any>(null);

  useEffect(() => { setActiveIdx(-1); setShowDrop(query.length > 0); }, [query]);

  // ── Fetch expiries ───────────────────────────────────────────────────────────
  const fetchExpiries = useCallback(async (sym: string, exch: string) => {
    const headers = nubraHeaders();
    if (!headers['x-session-token']) return;
    try {
      const res  = await fetch(`/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exch}`, { headers });
      if (!res.ok) return;
      const list: string[] = (await res.json())?.expiries ?? [];
      const today  = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const future = list.filter(e => String(e) >= today).sort();
      setExpiries(future);
      // auto-select first expiry
      const first = new Set<string>(future.slice(0,1));
      setSelectedExpiries(first);
    } catch { /* ignore */ }
  }, []);

  // ── Fetch skew for selected expiries ─────────────────────────────────────────
  const fetchAllSkew = useCallback(async (sym: string, exch: string, exps: string[]) => {
    if (!sym || !exps.length) return;
    setLoading(true); setError('');
    const headers = nubraHeaders();
    if (!headers['x-session-token']) { setError('NOT LOGGED IN'); setLoading(false); return; }
    try {
      const results = await Promise.all(exps.map(exp => fetchSkewForExpiry(sym, exch, exp, headers)));
      const newMap: ExpiryData = new Map();
      exps.forEach((exp, i) => newMap.set(exp, results[i]));
      setExpiryData(newMap);
    } catch (e: any) { setError(e.message ?? 'ERROR'); }
    finally { setLoading(false); }
  }, []);

  // ── Symbol select ────────────────────────────────────────────────────────────
  const handleSymbolSelect = useCallback((sym: string, _exch: string) => {
    const r = resolveNubra(sym, nubraInstruments);
    setSymbol(r.nubraSym); setExchange(r.exchange);
    setQuery(r.nubraSym); setShowDrop(false);
    setExpiries([]); setSelectedExpiries(new Set()); setExpiryData(new Map());
    fetchExpiries(r.nubraSym, r.exchange);
  }, [nubraInstruments, fetchExpiries]);

  // ── Toggle expiry ────────────────────────────────────────────────────────────
  const toggleExpiry = useCallback((exp: string) => {
    setSelectedExpiries(prev => {
      const next = new Set(prev);
      if (next.has(exp)) { if (next.size > 1) next.delete(exp); }
      else next.add(exp);
      return next;
    });
  }, []);

  // ── Auto-load when symbol/expiries change ────────────────────────────────────
  useEffect(() => {
    if (!symbol || !selectedExpiries.size) return;
    fetchAllSkew(symbol, exchange, [...selectedExpiries]);
  }, [symbol, exchange, selectedExpiries, fetchAllSkew]);

  // ── ECharts ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    getECharts().then(echarts => {
      if (!chartRef.current) return;
      if (!chartInst.current) {
        chartInst.current = echarts.init(chartRef.current, null, { renderer: 'canvas' });
        // fit to container immediately after init
        chartInst.current.resize();
      }
      const inst = chartInst.current;

      const sortedExpiries = [...expiryData.keys()].sort();
      if (!sortedExpiries.length) { inst.clear(); return; }

      // collect all strikes across all expiries for unified x-axis
      const strikeSet = new Set<number>();
      for (const pts of expiryData.values()) pts.forEach(p => strikeSet.add(p.strike));
      const allStrikes = [...strikeSet].sort((a,b) => a - b);
      const strikeLabels = allStrikes.map(s => s.toLocaleString('en-IN'));

      const series: any[] = [];
      const legendData: any[] = [];

      sortedExpiries.forEach((exp, idx) => {
        const pts   = expiryData.get(exp) ?? [];
        const color = EXPIRY_COLORS[idx % EXPIRY_COLORS.length];
        const label = fmtExpiry(exp);

        // build strike→point lookup
        const ptByStrike = new Map<number, SkewPoint>();
        pts.forEach(p => ptByStrike.set(p.strike, p));

        if (optType === 'CE' || optType === 'PE') {
          const key   = optType === 'CE' ? 'ce' : 'pe';
          const sname = `${label} ${optType}`;
          const data  = allStrikes.map(sk => { const p = ptByStrike.get(sk); return p && p[key] > 0 ? +p[key].toFixed(2) : null; });
          series.push({ name: sname, type: 'line', data, smooth: true, connectNulls: false, lineStyle: { color, width: 2 }, itemStyle: { color }, symbol: 'circle', symbolSize: 4 });
          legendData.push({ name: sname, itemStyle: { color }, lineStyle: { color } });
        } else {
          // BOTH → avg (CE+PE)/2
          const sname = label;
          const data  = allStrikes.map(sk => {
            const p = ptByStrike.get(sk);
            if (!p) return null;
            if (p.ce > 0 && p.pe > 0) return +((p.ce + p.pe) / 2).toFixed(2);
            if (p.ce > 0) return +p.ce.toFixed(2);
            if (p.pe > 0) return +p.pe.toFixed(2);
            return null;
          });
          series.push({ name: sname, type: 'line', data, smooth: true, connectNulls: false, lineStyle: { color, width: 2 }, itemStyle: { color }, symbol: 'circle', symbolSize: 4 });
          legendData.push({ name: sname, itemStyle: { color }, lineStyle: { color } });
        }
      });

      inst.setOption({
        backgroundColor: '#131110',
        animation: true, animationDuration: 300,
        grid: { left: 56, right: 16, top: legendData.length > 0 ? 48 : 20, bottom: 56 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', crossStyle: { color: 'rgba(255,255,255,0.15)' } },
          backgroundColor: '#1c1a17', borderColor: 'rgba(255,255,255,0.1)', borderRadius: 8, padding: [10,14],
          formatter(params: any[]) {
            const strike = params[0]?.axisValue ?? '';
            let html = `<div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:6px">${strike}</div>`;
            for (const p of params) {
              if (p.value == null) continue;
              html += `<div style="display:flex;align-items:center;gap:8px;margin-top:3px">
                <span style="width:10px;height:3px;border-radius:2px;background:${p.color};display:inline-block"></span>
                <span style="color:#ccc;font-size:12px">${p.seriesName}</span>
                <span style="color:${p.color};font-weight:700;margin-left:auto;padding-left:12px">${p.value.toFixed(2)}%</span>
              </div>`;
            }
            return html;
          },
        },
        legend: { show: true, top: 8, left: 'center', textStyle: { color: '#ccc', fontSize: 11, fontWeight: 600 }, itemWidth: 20, itemHeight: 3, data: legendData },
        xAxis: {
          type: 'category', data: strikeLabels,
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, axisTick: { show: false },
          axisLabel: { color: '#fff', fontSize: 10, fontWeight: 600, rotate: strikeLabels.length > 20 ? 45 : 0, interval: Math.max(0, Math.floor(strikeLabels.length / 16)) },
          splitLine: { show: false },
          name: 'Strike Price', nameLocation: 'middle', nameGap: strikeLabels.length > 20 ? 46 : 28,
          nameTextStyle: { color: 'rgba(255,255,255,0.35)', fontSize: 11 },
        },
        yAxis: {
          type: 'value', axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)', type: 'dashed' } },
          axisLabel: { color: '#fff', fontSize: 10, formatter: (v: number) => `${v.toFixed(1)}%` },
        },
        dataZoom: [
          { type: 'inside', start: 0, end: 100 },
          { type: 'slider', bottom: 6, height: 20, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(255,255,255,0.03)', fillerColor: 'rgba(79,142,247,0.15)', handleStyle: { color: '#4f8ef7', borderColor: '#4f8ef7' }, textStyle: { color: '#fff', fontSize: 10 } },
        ],
        series,
      }, true);
    });
  }, [expiryData, optType]);

  // Resize observer — watch wrap so resize fires even before chart mounts
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      if (chartInst.current) chartInst.current.resize();
    });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // Also resize whenever chart data changes (chart may have just mounted)
  useEffect(() => {
    if (chartInst.current) chartInst.current.resize();
  }, [expiryData, optType]);

  useEffect(() => () => { chartInst.current?.dispose(); chartInst.current = null; }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showDrop || !suggestions.length) return;
    if (e.key === 'ArrowDown')  { e.preventDefault(); setActiveIdx(i => Math.min(i+1, suggestions.length-1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i-1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); const sg = suggestions[activeIdx]; handleSymbolSelect(sg.sym, sg.exchange); }
    else if (e.key === 'Escape') setShowDrop(false);
  }, [showDrop, suggestions, activeIdx, handleSymbolSelect]);

  return (
    <div className={s.root}>
      {/* Toolbar */}
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          <div className={s.searchWrap}>
            <div className={s.searchBox}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input ref={inputRef} className={s.searchInput} placeholder="Search symbol…" value={query}
                onChange={e => setQuery(e.target.value)} onFocus={() => query && setShowDrop(true)}
                onBlur={() => setTimeout(() => setShowDrop(false), 150)} onKeyDown={onKeyDown}
                autoComplete="off" spellCheck={false} />
              {query && (
                <button className={s.clearBtn} onMouseDown={e => { e.preventDefault(); setQuery(''); setShowDrop(false); }}>
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
                    <div key={`${sg.sym}|${sg.exchange}`} className={`${s.dropdownItem} ${i === activeIdx ? s.dropdownItemActive : ''}`} onMouseDown={() => handleSymbolSelect(sg.sym, sg.exchange)}>
                      <span className={s.dropdownExch}>{sg.exchange}</span>
                      <span className={s.dropdownSym}>{sg.sym}</span>
                      <span className={s.dropdownType}>{sg.asset_type.includes('INDEX') ? 'INDEX' : 'STOCK'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={s.toolbarRight}>
          {/* Expiry dropdown */}
          {expiries.length > 0 && (
            <div className={s.expiryDDWrap} ref={expiryDDRef}>
              <button className={s.expiryDDBtn} onClick={() => setShowExpiryDrop(p => !p)}>
                <span>
                  {selectedExpiries.size === 0 ? 'Expiry'
                    : selectedExpiries.size === 1 ? fmtExpiry([...selectedExpiries][0])
                    : `${selectedExpiries.size} Expiries`}
                </span>
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              {showExpiryDrop && (
                <div className={s.expiryDDList}>
                  {expiries.map((exp, idx) => {
                    const checked = selectedExpiries.has(exp);
                    const color   = EXPIRY_COLORS[idx % EXPIRY_COLORS.length];
                    return (
                      <label key={exp} className={s.expiryDDItem} onMouseDown={e => e.preventDefault()}>
                        <input type="checkbox" checked={checked} onChange={() => toggleExpiry(exp)} />
                        <span className={s.expiryChkBox} style={{ borderColor: checked ? color : 'rgba(255,255,255,0.25)', background: checked ? color + '33' : 'transparent' }}>
                          {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3l2 2 4-4" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        </span>
                        <span style={{ color: checked ? color : 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: 600 }}>{fmtExpiry(exp)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className={s.typeToggle}>
            <button className={`${s.typeBtn} ${optType === 'CE'   ? s.typeBtnActive : ''}`} onClick={() => setOptType('CE')}>CE</button>
            <button className={`${s.typeBtn} ${optType === 'BOTH' ? s.typeBtnActive : ''}`} onClick={() => setOptType('BOTH')}>AVG</button>
            <button className={`${s.typeBtn} ${optType === 'PE'   ? s.typeBtnActive : ''}`} onClick={() => setOptType('PE')}>PE</button>
          </div>
          {loading && <div className={s.loadingDot} />}
          {error   && <span className={s.errorLabel}>{error}</span>}
        </div>
      </div>

      {/* Chart */}
      <div ref={wrapRef} className={s.chartWrap}>
        {!symbol ? (
          <div className={s.placeholder}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span>Search a symbol to view volatility skew</span>
          </div>
        ) : !expiryData.size && !loading ? (
          <div className={s.placeholder}><span>No IV data for selected expiry</span></div>
        ) : (
          <div ref={chartRef} style={{ width: '100%', height: '100%' }} />
        )}
      </div>
    </div>
  );
}
