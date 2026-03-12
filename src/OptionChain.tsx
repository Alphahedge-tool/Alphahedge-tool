/**
 * OptionChain — Floating overlay panel with @tanstack/react-table
 * Opens from the right edge of the left panel, floats over content.
 * On open: scrolls to ATM ±10 strikes.
 */

import React, { useState, useEffect, useRef, useMemo, startTransition } from 'react';
import { format } from 'date-fns';
import { Clock } from 'lucide-react';

// ── Time slots ────────────────────────────────────────────────────────────────
const TIME_SLOTS = ['09:15','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:15','15:25'];

function CalendarPicker({ date, time, onDateChange, onTimeChange }: {
  date: string; time: string;
  onDateChange: (d: string) => void;
  onTimeChange: (t: string) => void;
}) {
  const displayDate = date ? format(new Date(date + 'T00:00:00'), 'dd MMM yyyy') : 'Select date';

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Date */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF' }}>Date</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0' }}>{displayDate}</span>
        </div>
        <input
          type="date"
          value={date}
          max={new Date().toISOString().slice(0, 10)}
          onChange={e => onDateChange(e.target.value)}
          style={{
            width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8, padding: '8px 10px', color: '#E2E8F0', fontSize: 12, fontWeight: 600,
          }}
        />
      </div>

      {/* Time */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF' }}>Time</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '6px 8px' }}>
          <Clock size={12} color="#6B7280" />
          <input type="time" value={time} onChange={e => onTimeChange(e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#E2E8F0', fontSize: 12, fontWeight: 600, minWidth: 0 }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {TIME_SLOTS.map(slot => {
            const sel = time === slot;
            return (
              <button key={slot} onClick={() => onTimeChange(slot)} style={{
                padding: '6px 0', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer', textAlign: 'center',
                background: sel ? 'rgba(255,152,0,0.18)' : 'rgba(255,255,255,0.03)',
                border: sel ? '1px solid rgba(255,152,0,0.6)' : '1px solid rgba(255,255,255,0.1)',
                color: sel ? '#FF9800' : '#9CA3AF',
              }}>{slot}</button>
            );
          })}
        </div>
      </div>

    </div>
  );
}
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import type { Instrument } from './useInstruments';
import { wsManager } from './lib/WebSocketManager';

interface OptionSide {
  ref_id?: number;
  ltp: number;
  chgPct: number;
  oi: number;
  oiChgPct: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  iv: number;
}

interface OptionRow {
  strike: number;
  ce: OptionSide;
  pe: OptionSide;
  isAtm: boolean;
}

const EMPTY: OptionSide = { ltp: 0, chgPct: 0, oi: 0, oiChgPct: 0, delta: 0, theta: 0, gamma: 0, vega: 0, iv: 0 };
const BRIDGE = 'ws://localhost:8765';

function isMarketOpen(): boolean {
  const now = new Date();
  const istMin = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + 330) % 1440;
  const istDay = new Date(now.getTime() + 330 * 60000);
  if ([0, 6].includes(istDay.getUTCDay())) return false;
  return istMin >= 9 * 60 + 15 && istMin < 15 * 60 + 30;
}

function getDefaultEntryDate(): string {
  const d = new Date();
  if (d.getHours() < 9 || (d.getHours() === 9 && d.getMinutes() < 15)) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

function fmtExpiry(exp: string | number) {
  const s = String(exp);
  return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`)
    .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function fmtOi(n: number) { return n === 0 ? '—' : n.toLocaleString('en-IN'); }
function fmtPrice(n: number) { return n === 0 ? '—' : '₹' + n.toFixed(2); }
function fmtPct(n: number) {
  if (n === 0) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function fmtGreek(n: number, d = 2) { return n === 0 ? '—' : n.toFixed(d); }

const ch = createColumnHelper<OptionRow>();
const CE_COLS = ['ce_iv', 'ce_gamma', 'ce_vega', 'ce_theta', 'ce_delta', 'ce_oi', 'ce_oichg', 'ce_chg', 'ce_price'];

const COL_MAP: Record<string, string[]> = {
  ltp:   ['ce_price', 'pe_price'],
  chg:   ['ce_chg',   'pe_chg'],
  oichg: ['ce_oichg', 'pe_oichg'],
  oi:    ['ce_oi',    'pe_oi'],
  delta: ['ce_delta', 'pe_delta'],
  theta: ['ce_theta', 'pe_theta'],
  gamma: ['ce_gamma', 'pe_gamma'],
  vega:  ['ce_vega',  'pe_vega'],
  iv:    ['ce_iv',    'pe_iv'],
};

const COL_LABELS: Record<string, string> = {
  ltp: 'LTP (Price)', chg: 'Chg %', oichg: 'OI Chg %', oi: 'OI',
  delta: 'Delta', theta: 'Theta', gamma: 'Gamma', vega: 'Vega', iv: 'IV',
};
const W: Record<string, number> = {
  ce_iv: 50, ce_gamma: 56, ce_vega: 50, ce_theta: 56, ce_delta: 52, ce_oi: 90, ce_oichg: 72, ce_chg: 96, ce_price: 76,
  strike: 72,
  pe_price: 76, pe_chg: 96, pe_oichg: 72, pe_oi: 90, pe_delta: 52, pe_theta: 56, pe_vega: 50, pe_gamma: 56, pe_iv: 50,
};

interface AddLegPayload {
  symbol: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  action: 'B' | 'S';
  price: number;
  lots: number;
  lotSize: number;
  refId?: number;
  instrumentKey?: string;
  greeks: { delta: number; theta: number; vega: number; gamma: number; iv: number };
  entryDate?: string;
  entryTime?: string;
  entrySpot?: number;
}

function OptionChainNubra({ symbol, expiries, sessionToken, exchange = 'NSE', onClose, onAddLeg, onLtpUpdateRef, lotSize = 1, isHistoricalMode, spotRefId }: {
  symbol: string;
  expiries: (string | number)[];
  sessionToken: string;
  exchange?: string;
  onClose: () => void;
  onAddLeg?: (leg: AddLegPayload) => void;
  onLtpUpdateRef?: React.MutableRefObject<((ltpMap: Map<number, { ce: number; pe: number; ceGreeks: { delta: number; theta: number; vega: number; gamma: number; iv: number }; peGreeks: { delta: number; theta: number; vega: number; gamma: number; iv: number } }>, spot: number, expiry: string) => void) | null>;
  lotSize?: number;
  isHistoricalMode?: boolean;
  spotRefId?: string;
}) {
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const [rows, setRows] = useState<OptionRow[]>([]);
  const [spot, setSpot] = useState(0);
  const [qty, setQty] = useState(1);
  const [entryDate, setEntryDate] = useState(() => getDefaultEntryDate());
  const [entryTime, setEntryTime] = useState('09:15');
  const [fetching, setFetching] = useState(false);
  const [popup, setPopup] = useState<{ x: number; y: number; strike: number; type: 'CE' | 'PE'; action: 'B' | 'S'; price: number; refId?: number; greeks: { delta: number; theta: number; vega: number; gamma: number; iv: number }; instrumentKey?: string | null; expiry?: string; } | null>(null);
  const openPopup = (p: NonNullable<typeof popup>) => startTransition(() => { setQty(1); setPopup(p); });
  const popupRef = useRef<HTMLDivElement>(null);
  const [atm, setAtm] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [colVis, setColVis] = useState<Record<string, boolean>>({
    ltp: true, chg: false, oichg: false, oi: true, delta: true, theta: false, gamma: false, vega: false, iv: true,
  });
  const expiriesKey = useMemo(() => expiries.map(e => String(e)).join('|'), [expiries]);
  const wsRef = useRef<WebSocket | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  const shouldScrollToAtm = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ceOverlayRef = useRef<HTMLDivElement>(null);
  const peOverlayRef = useRef<HTMLDivElement>(null);
  const overlayDataRef = useRef<{ strike: number; ceLtp: number; peLtp: number; ceRefId?: number; peRefId?: number; ceGreeks: any; peGreeks: any; } | null>(null);

  const showOverlay = (fixedTop: number, ceFixedLeft: number, ceW: number, peFixedLeft: number, peW: number, cellH: number, data: NonNullable<typeof overlayDataRef.current>, side?: 'CE' | 'PE') => {
    overlayDataRef.current = data;
    const ce = ceOverlayRef.current;
    const pe = peOverlayRef.current;
    if (ce) {
      if (side === 'CE' || !side) {
        ce.style.left = ceFixedLeft + 'px'; ce.style.top = fixedTop + 'px'; ce.style.width = ceW + 'px'; ce.style.height = cellH + 'px'; ce.style.display = 'flex';
      } else ce.style.display = 'none';
    }
    if (pe) {
      if (side === 'PE' || !side) {
        pe.style.left = peFixedLeft + 'px'; pe.style.top = fixedTop + 'px'; pe.style.width = peW + 'px'; pe.style.height = cellH + 'px'; pe.style.display = 'flex';
      } else pe.style.display = 'none';
    }
  };
  const hideOverlay = () => {
    const ce = ceOverlayRef.current; const pe = peOverlayRef.current;
    if (ce) ce.style.display = 'none';
    if (pe) pe.style.display = 'none';
  };

  // Dismiss popup on outside click
  useEffect(() => {
    if (!popup) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setPopup(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popup]);

  // Auto-select nearest expiry (reset when symbol/exchange changes or no expiries)
  useEffect(() => {
    if (expiries.length === 0) {
      setSelectedExpiry(null);
      return;
    }
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const strs = expiries.map(e => String(e));
    const nearest = strs.find(e => e >= today) ?? strs[strs.length - 1];
    queueMicrotask(() => setSelectedExpiry(nearest));
  }, [expiriesKey, symbol, exchange]);


  const parseRest = (opt: Record<string, number>): OptionSide => ({
    ref_id: opt.ref_id,
    ltp: (opt.ltp ?? 0) / 100,
    chgPct: opt.ltpchg ?? 0,
    oi: opt.oi ?? 0,
    oiChgPct: opt._oiChgPct ?? 0,
    delta: opt.delta ?? 0,
    theta: opt.theta ?? 0,
    gamma: opt.gamma ?? 0,
    vega: opt.vega ?? 0,
    iv: opt.iv ?? 0,
  });

  const parseWs = (opt: Record<string, number>): OptionSide => {
    const curOi = opt.open_interest ?? 0;
    const prevOi = opt.previous_open_interest ?? 0;
    const ltp = opt.last_traded_price ?? 0;
    const chg = opt.last_traded_price_change ?? 0;
    const prevLtp = ltp - chg;
    return {
      ref_id: opt.ref_id,
      ltp, chgPct: prevLtp > 0 ? (chg / prevLtp) * 100 : 0,
      oi: curOi, oiChgPct: curOi > 0 ? ((curOi - prevOi) / curOi) * 100 : 0,
      delta: opt.delta ?? 0, theta: opt.theta ?? 0,
      gamma: opt.gamma ?? 0, vega: opt.vega ?? 0, iv: opt.iv ?? 0,
    };
  };

  const rowsRef = useRef<OptionRow[]>([]);

  const buildRows = (ceList: Record<string, number>[], peList: Record<string, number>[], atmRaw: number, spotRaw: number, isRest: boolean) => {
    const scale = isRest ? 100 : 1;
    const sk = isRest ? 'sp' : 'strike_price';
    const spotVal = spotRaw / scale;
    const atmVal = atmRaw > 0 ? atmRaw / scale : spotVal;
    setSpot(spotVal); setAtm(atmVal);

    if (isRest) {
      // Initial load — build full sorted array
      const map = new Map<number, OptionRow>();
      for (const opt of ceList) {
        const s = (opt[sk] ?? 0) / scale;
        if (!map.has(s)) map.set(s, { strike: s, ce: { ...EMPTY }, pe: { ...EMPTY }, isAtm: false });
        map.get(s)!.ce = parseRest(opt);
      }
      for (const opt of peList) {
        const s = (opt[sk] ?? 0) / scale;
        if (!map.has(s)) map.set(s, { strike: s, ce: { ...EMPTY }, pe: { ...EMPTY }, isAtm: false });
        map.get(s)!.pe = parseRest(opt);
      }
      const sorted = [...map.values()].sort((a, b) => a.strike - b.strike);
      if (atmVal > 0) {
        let idx = 0, minD = Infinity;
        sorted.forEach((r, i) => { const d = Math.abs(r.strike - atmVal); if (d < minD) { minD = d; idx = i; } });
        sorted.forEach((r, i) => { r.isAtm = i === idx; });
      }
      rowsRef.current = sorted;
      setRows([...sorted]);
      if (shouldScrollToAtm.current) {
        shouldScrollToAtm.current = false;
        requestAnimationFrame(() => {
          atmRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      }
    } else {
      // WS live update — patch values in-place, no reorder
      const existing = rowsRef.current;
      if (existing.length === 0) return; // wait for REST to initialize
      const ceMap = new Map<number, OptionSide>();
      const peMap = new Map<number, OptionSide>();
      for (const opt of ceList) { const s = (opt[sk] ?? 0) / scale; ceMap.set(s, parseWs(opt)); }
      for (const opt of peList) { const s = (opt[sk] ?? 0) / scale; peMap.set(s, parseWs(opt)); }
      let atmIdx = 0, minD = Infinity;
      existing.forEach((r, i) => { const d = Math.abs(r.strike - atmVal); if (d < minD) { minD = d; atmIdx = i; } });
      const updated = existing.map((r, i) => ({
        ...r,
        isAtm: i === atmIdx,
        ...(ceMap.has(r.strike) ? { ce: ceMap.get(r.strike)! } : {}),
        ...(peMap.has(r.strike) ? { pe: peMap.get(r.strike)! } : {}),
      }));
      rowsRef.current = updated;
      setRows(updated);
    }

    const finalRows = rowsRef.current;
    if (onLtpUpdateRef && onLtpUpdateRef.current && finalRows.length > 0) {
      const ltpMap = new Map<number, { ce: number; pe: number; ceGreeks: { delta: number; theta: number; vega: number; gamma: number; iv: number }; peGreeks: { delta: number; theta: number; vega: number; gamma: number; iv: number } }>();
      finalRows.forEach(r => ltpMap.set(r.strike, {
        ce: r.ce.ltp, pe: r.pe.ltp,
        ceGreeks: { delta: r.ce.delta, theta: r.ce.theta, vega: r.ce.vega, gamma: r.ce.gamma, iv: r.ce.iv },
        peGreeks: { delta: r.pe.delta, theta: r.pe.theta, vega: r.pe.vega, gamma: r.pe.gamma, iv: r.pe.iv },
      }));
      if (selectedExpiry && onLtpUpdateRef.current) {
        onLtpUpdateRef.current(ltpMap, spotVal, selectedExpiry);
      }
    }
  };

  useEffect(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (!selectedExpiry || !symbol || !sessionToken) return;
    setRows([]); setSpot(0); setAtm(0); rowsRef.current = []; shouldScrollToAtm.current = true;

    // ── Step 1: Always fetch REST first for instant data ──────────────
    const restUrl = `/api/nubra-optionchain?session_token=${encodeURIComponent(sessionToken)}&instrument=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(selectedExpiry)}`;
    let wsActive = false; // once WS delivers data, stop using REST
    fetch(restUrl)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(json => {
        if (wsActive) return; // WS already took over, skip stale REST
        const c = json.chain ?? json;
        const curOi_calc = (opt: Record<string, number>) => {
          const cur = opt.oi ?? 0; const prev = opt.prev_oi ?? 0;
          return cur > 0 ? ((cur - prev) / cur) * 100 : 0;
        };
        (c.ce ?? []).forEach((o: Record<string, number>) => { o._oiChgPct = curOi_calc(o); });
        (c.pe ?? []).forEach((o: Record<string, number>) => { o._oiChgPct = curOi_calc(o); });
        buildRows(c.ce ?? [], c.pe ?? [], c.atm ?? 0, c.cp ?? c.current_price ?? 0, true);
      })
      .catch(err => console.error('[OC REST]', err));

    // ── Step 2: If market open, also connect WS for live updates ──────
    if (!isMarketOpen()) return;

    const ws = new WebSocket(BRIDGE);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'subscribe', session_token: sessionToken, data_type: 'option', symbols: [`${symbol}:${selectedExpiry}`], exchange }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'option' && msg.data) {
          wsActive = true; // WS data arrived, take over from REST
          const d = msg.data;
          buildRows(d.ce ?? [], d.pe ?? [], d.at_the_money_strike ?? 0, d.current_price ?? 0, false);
        }
      } catch { /**/ }
    };
    ws.onerror = () => {}; ws.onclose = () => {};
    return () => { ws.close(); wsRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExpiry, symbol, sessionToken, exchange]);

  // All possible column defs — filtered by colVis below
  const maxCeOi = useMemo(() => Math.max(1, ...rows.map(r => r.ce.oi)), [rows]);
  const maxPeOi = useMemo(() => Math.max(1, ...rows.map(r => r.pe.oi)), [rows]);

  const allColumns = useMemo(() => [
    ch.accessor(r => r.ce.iv,       { id: 'ce_iv',    header: 'IV',       cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    ch.accessor(r => r.ce.gamma,    { id: 'ce_gamma', header: 'Gamma',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue(), 4)}</span> }),
    ch.accessor(r => r.ce.vega,     { id: 'ce_vega',  header: 'Vega',     cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    ch.accessor(r => r.ce.theta,    { id: 'ce_theta', header: 'Theta',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    ch.accessor(r => r.ce.delta,    { id: 'ce_delta', header: 'Delta',    cell: i => <span style={{ color: '#26a69a' }}>{fmtGreek(i.getValue())}</span> }),
    ch.accessor(r => r.ce.oi,       { id: 'ce_oi',    header: 'Call OI',  cell: i => {
      const pct = Math.min(100, (i.getValue() / maxCeOi) * 100);
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: `linear-gradient(to left, rgba(38,210,164,0.45) ${pct}%, transparent ${pct}%)`, borderRadius: 2, padding: '2px 0' }}>
          <span style={{ color: '#E2E8F0', fontWeight: 600 }}>{fmtOi(i.getValue())}</span>
        </div>
      );
    } }),
    ch.accessor(r => r.ce.oiChgPct, { id: 'ce_oichg', header: 'OI Chg%', cell: i => { const v = i.getValue(); return <span style={{ color: v >= 0 ? '#6bbfaa' : '#ef5350' }}>{fmtPct(v)}</span>; } }),
    ch.accessor(r => r.ce.chgPct,   { id: 'ce_chg',   header: 'Chg%',    cell: i => { const v = i.getValue(); return <span style={{ color: v >= 0 ? '#6bbfaa' : '#ef5350' }}>{fmtPct(v)}</span>; } }),
    ch.accessor(r => r.ce.ltp,      { id: 'ce_price', header: 'Call LTP', cell: i => {
      const row = i.row.original;
      return (
        <div className="oc-ltp-cell">
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-b" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'CE', action: 'B', price: i.getValue(), refId: row.ce.ref_id, greeks: { delta: row.ce.delta, theta: row.ce.theta, vega: row.ce.vega, gamma: row.ce.gamma, iv: row.ce.iv } }); }}>B</button></span>
          <span style={{ color: '#C0C0C0', fontWeight: 700 }}>{fmtPrice(i.getValue())}</span>
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-s" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'CE', action: 'S', price: i.getValue(), refId: row.ce.ref_id, greeks: { delta: row.ce.delta, theta: row.ce.theta, vega: row.ce.vega, gamma: row.ce.gamma, iv: row.ce.iv } }); }}>S</button></span>
        </div>
      );
    } }),
    ch.accessor(r => r.strike, {
      id: 'strike', header: 'Strike',
      cell: i => {
        const row = i.row.original;
        return <span style={{ color: row.isAtm ? '#e0a800' : '#C0C0C0', fontWeight: row.isAtm ? 800 : 700 }}>{i.getValue() % 1 === 0 ? i.getValue().toFixed(0) : i.getValue().toFixed(2)}</span>;
      },
    }),
    ch.accessor(r => r.pe.ltp,      { id: 'pe_price', header: 'Put LTP',  cell: i => {
      const row = i.row.original;
      return (
        <div className="oc-ltp-cell">
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-b" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'PE', action: 'B', price: i.getValue(), refId: row.pe.ref_id, greeks: { delta: row.pe.delta, theta: row.pe.theta, vega: row.pe.vega, gamma: row.pe.gamma, iv: row.pe.iv } }); }}>B</button></span>
          <span style={{ color: '#C0C0C0', fontWeight: 700 }}>{fmtPrice(i.getValue())}</span>
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-s" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'PE', action: 'S', price: i.getValue(), refId: row.pe.ref_id, greeks: { delta: row.pe.delta, theta: row.pe.theta, vega: row.pe.vega, gamma: row.pe.gamma, iv: row.pe.iv } }); }}>S</button></span>
        </div>
      );
    } }),
    ch.accessor(r => r.pe.chgPct,   { id: 'pe_chg',   header: 'Chg%',     cell: i => { const v = i.getValue(); return <span style={{ color: v >= 0 ? '#6bbfaa' : '#ef5350' }}>{fmtPct(v)}</span>; } }),
    ch.accessor(r => r.pe.oiChgPct, { id: 'pe_oichg', header: 'OI Chg%',  cell: i => { const v = i.getValue(); return <span style={{ color: v >= 0 ? '#6bbfaa' : '#ef5350' }}>{fmtPct(v)}</span>; } }),
    ch.accessor(r => r.pe.oi,       { id: 'pe_oi',    header: 'Put OI',   cell: i => {
      const pct = Math.min(100, (i.getValue() / maxPeOi) * 100);
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', background: `linear-gradient(to right, rgba(242,54,69,0.45) ${pct}%, transparent ${pct}%)`, borderRadius: 2, padding: '2px 0' }}>
          <span style={{ color: '#E2E8F0', fontWeight: 600 }}>{fmtOi(i.getValue())}</span>
        </div>
      );
    } }),
    ch.accessor(r => r.pe.delta,    { id: 'pe_delta', header: 'Delta',    cell: i => <span style={{ color: '#f23645' }}>{fmtGreek(i.getValue())}</span> }),
    ch.accessor(r => r.pe.theta,    { id: 'pe_theta', header: 'Theta',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    ch.accessor(r => r.pe.vega,     { id: 'pe_vega',  header: 'Vega',     cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    ch.accessor(r => r.pe.gamma,    { id: 'pe_gamma', header: 'Gamma',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue(), 4)}</span> }),
    ch.accessor(r => r.pe.iv,       { id: 'pe_iv',    header: 'IV',       cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
  ], [maxCeOi, maxPeOi, onAddLeg, selectedExpiry, symbol]);


  const [colOrder, setColOrder] = useState(['ltp', 'chg', 'oichg', 'oi', 'delta', 'theta', 'gamma', 'vega', 'iv']);
  const dragIdx = useRef<number | null>(null);
  const dragKey = useRef<string | null>(null);

  const hiddenIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const [key, ids] of Object.entries(COL_MAP)) {
      if (!colVis[key]) ids.forEach(id => hidden.add(id));
    }
    return hidden;
  }, [colVis]);

  const columns = useMemo(() => {
    // Build ordered CE ids, then strike, then ordered PE ids — based on colOrder
    // CE is on the left of strike — reverse so the "first" item in modal is closest to strike
    const orderedCe = [...colOrder].reverse().flatMap(k => COL_MAP[k]?.[0] ? [COL_MAP[k][0]] : []).filter(id => !hiddenIds.has(id));
    const orderedPe = colOrder.flatMap(k => COL_MAP[k]?.[1] ? [COL_MAP[k][1]] : []).filter(id => !hiddenIds.has(id));
    const orderedIds = [...orderedCe, 'strike', ...orderedPe];
    return orderedIds.map(id => allColumns.find((c: any) => c.id === id)!).filter(Boolean);
  }, [allColumns, hiddenIds, colOrder]);

  // Recompute visible CE/PE col lists for super-header colSpan
  const visibleCeCols = [...colOrder].reverse().map(k => COL_MAP[k]?.[0]).filter((id): id is string => !!id && !hiddenIds.has(id));
  const visiblePeCols = colOrder.map(k => COL_MAP[k]?.[1]).filter((id): id is string => !!id && !hiddenIds.has(id));

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  const totalWidth = useMemo(() => {
    const ids = columns.map((c: any) => c.id as string);
    return ids.reduce((s, id) => s + (W[id] ?? 72), 0);
  }, [columns]);

  // Auto-scroll right when columns are added
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [totalWidth]);

  const expLabel = selectedExpiry ? fmtExpiry(selectedExpiry) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1d1a17', color: '#D1D5DB', position: 'relative' }}>
      <style>{`
        .oc-tbody tr.oc-row:hover td { background: rgba(255,255,255,0.03); }
        .oc-tbody tr.oc-row-atm td { background: rgba(224,168,0,0.04); }
        .oc-tbody tr.oc-row-atm:hover td { background: rgba(224,168,0,0.08); }
        .oc-tbody tr.oc-row-odd td { background: transparent; }
        .oc-tbody tr.oc-row-even td { background: rgba(255,255,255,0.015); }
        .oc-scroll { will-change: transform; }
        .oc-gear:hover { background: rgba(255,255,255,0.1) !important; }
        .oc-cb-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer; user-select: none; }
        .oc-cb-row:last-child { border-bottom: none; }
        .oc-cb-row:hover { background: rgba(255,255,255,0.03); border-radius: 6px; }
        .oc-cb-row.drag-over { background: rgba(79,142,247,0.1); border-radius: 6px; }
        .oc-drag-handle { cursor: grab; opacity: 0.3; flex-shrink: 0; padding: 2px; }
        .oc-drag-handle:hover { opacity: 0.8; }
        .oc-ltp-cell { display: flex; align-items: center; justify-content: center; gap: 8px; }
        .oc-ltp-btn-wrap { opacity: 0; pointer-events: none; transition: opacity 0.1s ease-in-out; }
        .oc-tbody tr.oc-row:hover .oc-ltp-btn-wrap { opacity: 1; pointer-events: auto; }
        .oc-btn { font-size: 11px; font-weight: 800; padding: 5px 10px; border-radius: 6px; border: none; cursor: pointer; letter-spacing: 0.08em; line-height: 1.5; transition: all 0.15s; }
        .oc-btn-b { background: rgba(38,166,154,0.15); color: #26a69a; border: 1px solid rgba(38,166,154,0.3); }
        .oc-btn-b:hover { background: rgba(38,166,154,0.25); border-color: rgba(38,166,154,0.5); }
        .oc-btn-s { background: rgba(242,54,69,0.15); color: #f23645; border: 1px solid rgba(242,54,69,0.3); }
        .oc-btn-s:hover { background: rgba(242,54,69,0.25); border-color: rgba(242,54,69,0.5); }
      `}</style>

      {/* Settings modal */}
      {settingsOpen && (
        <div
          onClick={() => setSettingsOpen(false)}
          style={{ position: 'absolute', inset: 0, zIndex: 50, backdropFilter: 'blur(6px)', background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#1f1f1f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, width: 300, padding: '18px 20px', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}
          >
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#E2E8F0' }}>Choose Columns</span>
              <button onClick={() => setSettingsOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#6b7280', display: 'flex', padding: 2 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            {/* Column rows — draggable */}
            <div>
              {colOrder.map((key) => (
                <div
                  key={key}
                  className="oc-cb-row"
                  onDragEnter={e => {
                    e.preventDefault();
                    e.currentTarget.classList.add('drag-over');
                    const fromKey = dragKey.current;
                    if (!fromKey || fromKey === key) return;
                    setColOrder(prev => {
                      const fromIdx = prev.indexOf(fromKey);
                      const toIdx = prev.indexOf(key);
                      if (fromIdx === -1 || toIdx === -1) return prev;
                      const next = [...prev];
                      next.splice(fromIdx, 1);
                      next.splice(toIdx, 0, fromKey);
                      return next;
                    });
                  }}
                  onDragOver={e => { e.preventDefault(); }}
                  onDragLeave={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      e.currentTarget.classList.remove('drag-over');
                    }
                  }}
                  onDrop={e => {
                    e.currentTarget.classList.remove('drag-over');
                    dragKey.current = null;
                    dragIdx.current = null;
                  }}
                  onClick={() => setColVis(v => ({ ...v, [key]: !v[key] }))}
                >
                  {/* Grab handle — dots only; drag starts here */}
                  <span
                    className="oc-drag-handle"
                    draggable
                    onDragStart={e => { e.stopPropagation(); dragKey.current = key; dragIdx.current = colOrder.indexOf(key); }}
                    onDragEnd={() => { dragKey.current = null; dragIdx.current = null; }}
                    onClick={e => e.stopPropagation()}
                  >
                    <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                      <circle cx="2.5" cy="2.5" r="1.5" fill="#9CA3AF"/>
                      <circle cx="7.5" cy="2.5" r="1.5" fill="#9CA3AF"/>
                      <circle cx="2.5" cy="7" r="1.5" fill="#9CA3AF"/>
                      <circle cx="7.5" cy="7" r="1.5" fill="#9CA3AF"/>
                      <circle cx="2.5" cy="11.5" r="1.5" fill="#9CA3AF"/>
                      <circle cx="7.5" cy="11.5" r="1.5" fill="#9CA3AF"/>
                    </svg>
                  </span>
                  {/* Checkbox */}
                  <div style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    background: colVis[key] ? '#f97316' : 'transparent',
                    border: `1.5px solid ${colVis[key] ? '#f97316' : 'rgba(255,255,255,0.2)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.15s ease',
                  }}>
                    {colVis[key] && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  <span style={{ fontSize: 13, color: colVis[key] ? '#E2E8F0' : '#6b7280', fontWeight: 500, flex: 1 }}>{COL_LABELS[key]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, background: 'var(--bg-panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 18, fontWeight: 800, color: '#E2E8F0', letterSpacing: '0.04em' }}>{symbol}</span>
          {spot > 0 && (
            <span style={{ fontSize: 14, fontWeight: 700, color: '#4F8EF7', background: 'rgba(79,142,247,0.1)', padding: '4px 12px', borderRadius: 8, border: '1px solid rgba(79,142,247,0.2)' }}>
              {spot.toFixed(2)}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7280' }}>{expLabel}</span>
          {/* Gear / settings button */}
          <button
            className="oc-gear"
            onClick={() => setSettingsOpen(true)}
            title="Choose columns"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', color: '#817E7E', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, transition: 'background 0.15s' }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 13.648 13.648" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M5.09373 0.995125C5.16241 0.427836 5.64541 0 6.21747 0H7.43151C8.0039 0 8.48663 0.428191 8.55525 0.996829C8.5553 0.997248 8.55536 0.997666 8.5554 0.9981L8.65947 1.81525C8.80015 1.86677 8.93789 1.92381 9.07227 1.98601L9.72415 1.47911C10.1776 1.12819 10.8237 1.16381 11.2251 1.57622L12.0753 2.42643C12.4854 2.82551 12.5214 3.47159 12.1697 3.92431L11.6628 4.57692C11.725 4.71124 11.782 4.84882 11.8335 4.98924L12.6526 5.09337C12.653 5.09342 12.6534 5.09348 12.6539 5.09352C13.2211 5.16221 13.6492 5.64522 13.6484 6.21766V7.4312C13.6484 8.00358 13.2203 8.48622 12.6517 8.5549C12.6513 8.55496 12.6508 8.55502 12.6503 8.55506L11.8338 8.65909C11.7824 8.7996 11.7254 8.93729 11.663 9.07168L12.1696 9.72354C12.5218 10.1776 12.4847 10.823 12.0728 11.2245L11.2224 12.0749C10.8233 12.485 10.1772 12.5209 9.72452 12.1692L9.07187 11.6624C8.93756 11.7246 8.79995 11.7815 8.65952 11.833L8.55539 12.6521C8.55533 12.6525 8.55528 12.653 8.55522 12.6534C8.48652 13.2206 8.00353 13.6484 7.43151 13.6484H6.21747C5.64485 13.6484 5.16232 13.22 5.09373 12.6506C5.09367 12.6501 5.09361 12.6496 5.09355 12.6491L4.98954 11.8328C4.84901 11.7814 4.71133 11.7244 4.57692 11.662L3.92477 12.1688C3.47111 12.5199 2.82587 12.4838 2.42408 12.0724L1.57358 11.2219C1.16354 10.8229 1.12761 10.1769 1.47927 9.72417L1.98614 9.0715C1.92397 8.93721 1.86696 8.7996 1.81546 8.65919L0.996348 8.55505C0.995929 8.555 0.995526 8.55494 0.995107 8.5549C0.427838 8.48619 0 8.00325 0 7.4312V6.21724C0 5.64481 0.428228 5.16211 0.996871 5.09351L1.81538 4.98929C1.86677 4.84897 1.92362 4.7113 1.98597 4.5768L1.47915 3.92465C1.12701 3.47063 1.1643 2.82485 1.57625 2.42329L2.42671 1.57338C2.82634 1.16348 3.47226 1.12815 3.92438 1.4792L4.57644 1.98589C4.71105 1.92352 4.84888 1.86662 4.98946 1.81519L5.09373 0.995125ZM6.82448 4.43525C5.50742 4.43525 4.43541 5.50723 4.43541 6.82422C4.43541 8.14119 5.50742 9.21317 6.82448 9.21317C8.14154 9.21317 9.21356 8.14119 9.21356 6.82422C9.21356 5.50723 8.14154 4.43525 6.82448 4.43525ZM3.79381 6.82422C3.79381 5.15287 5.15311 3.79365 6.82448 3.79365C8.49586 3.79365 9.85515 5.15287 9.85515 6.82422C9.85515 8.49556 8.49586 9.85477 6.82448 9.85477C5.15311 9.85477 3.79381 8.49556 3.79381 6.82422Z" />
            </svg>
          </button>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', color: '#9CA3AF', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      {/* Expiry dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.03)', flexShrink: 0, background: 'var(--bg-panel)' }}>
        <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Expiry</span>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <select
            value={selectedExpiry ?? ''}
            onChange={e => setSelectedExpiry(e.target.value)}
            style={{
              appearance: 'none',
              WebkitAppearance: 'none',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              color: '#E2E8F0',
              fontSize: 12,
              fontWeight: 700,
              padding: '5px 32px 5px 12px',
              cursor: 'pointer',
              outline: 'none',
              letterSpacing: '0.02em',
              minWidth: 110,
            }}
          >
            {expiries.map(exp => {
              const s = String(exp);
              return <option key={s} value={s} style={{ background: '#1f1f1f', color: '#E2E8F0' }}>{fmtExpiry(exp)}</option>;
            })}
          </select>
          <svg
            width="10" height="6" viewBox="0 0 10 6" fill="none"
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#6B7280' }}
          >
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {/* Table */}
      <div className="oc-scroll" style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '60px', textAlign: 'center', fontSize: 13, color: '#3D4150' }}>
            {selectedExpiry ? 'Loading data…' : 'Select an expiry'}
          </div>
        ) : (
          <table style={{ width: totalWidth, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--bg-panel)' }}>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <th colSpan={visibleCeCols.length} style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#e0a800', letterSpacing: '0.08em', background: '#333333' }}>Call</th>
                <th style={{ textAlign: 'center', padding: '10px 0', fontSize: 12, fontWeight: 700, color: '#9CA3AF', background: '#333333' }}>Strike</th>
                <th colSpan={visiblePeCols.length} style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#818cf8', letterSpacing: '0.08em', background: '#333333' }}>Put</th>
              </tr>
              {table.getHeaderGroups().map(hg => (
                <tr key={hg.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {hg.headers.map(h => {
                    const id = h.column.id;
                    const isStrike = id === 'strike';
                    const isCe = CE_COLS.includes(id);
                    return (
                      <th key={h.id} style={{
                        width: W[id], minWidth: W[id], padding: '8px 10px',
                        fontSize: 11, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase',
                        textAlign: isStrike ? 'center' : isCe ? 'right' : 'left',
                        background: isCe ? 'rgba(224,168,0,0.02)' : isStrike ? '#333333' : 'rgba(129,140,248,0.02)',
                        whiteSpace: 'nowrap',
                      }}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody ref={tbodyRef} className="oc-tbody">
              {table.getRowModel().rows.map((row, ri) => {
                const data = row.original;
                const prevData = table.getRowModel().rows[ri - 1]?.original;
                const showAtmLine = data.isAtm && prevData && !prevData.isAtm;
                // ITM logic: CE is ITM when strike < spot; PE is ITM when strike > spot
                const isCeItm = spot > 0 && data.strike < spot;
                const isPeItm = spot > 0 && data.strike > spot;
                return (
                  <React.Fragment key={row.id}>
                    {showAtmLine && (
                      <tr>
                        <td colSpan={visibleCeCols.length} style={{ padding: '2px 0', borderTop: '1px dashed rgba(224,168,0,0.4)', background: 'rgba(224,168,0,0.03)' }} />
                        <td style={{ textAlign: 'center', padding: '2px 0', fontSize: 11, fontWeight: 800, color: '#e0a800', borderTop: '1px dashed rgba(224,168,0,0.4)', background: 'rgba(224,168,0,0.03)' }}>
                          {atm > 0 ? atm.toFixed(2) : ''}
                        </td>
                        <td colSpan={visiblePeCols.length} style={{ padding: '2px 0', borderTop: '1px dashed rgba(224,168,0,0.4)', background: 'rgba(224,168,0,0.03)' }} />
                      </tr>
                    )}
                    <tr
                      className={`oc-row ${data.isAtm ? 'oc-row-atm' : ri % 2 === 0 ? 'oc-row-even' : 'oc-row-odd'}`}
                      ref={data.isAtm ? atmRowRef : undefined}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.10)' }}
                      onMouseMove={e => {
                        if (popup) return;
                        const tr = e.currentTarget;
                        const strikeTd = (tr.querySelector('td[data-col="strike"]') || tr.querySelector('td[data-col="mstrike"]')) as HTMLElement | null;
                        if (!strikeTd) return;
                        const ceLtpTd = strikeTd.previousElementSibling as HTMLElement | null;
                        const peLtpTd = strikeTd.nextElementSibling as HTMLElement | null;
                        const ceR = ceLtpTd?.getBoundingClientRect();
                        const peR = peLtpTd?.getBoundingClientRect();
                        if (!ceR || !peR) return;
                        // only show when mouse is over CE LTP or PE LTP cell
                        const overCe = e.clientX >= ceR.left && e.clientX <= ceR.right;
                        const overPe = e.clientX >= peR.left && e.clientX <= peR.right;
                        if (!overCe && !overPe) { hideOverlay(); return; }
                        const side = overCe ? 'CE' : 'PE';
                        const trR = tr.getBoundingClientRect();
                        showOverlay(trR.top, ceR.left, ceR.width, peR.left, peR.width, trR.height, {
                          strike: data.strike, ceLtp: data.ce.ltp, peLtp: data.pe.ltp, ceRefId: data.ce.ref_id ?? 0, peRefId: data.pe.ref_id ?? 0,
                          ceGreeks: { delta: data.ce.delta, theta: data.ce.theta, vega: data.ce.vega, gamma: data.ce.gamma, iv: data.ce.iv },
                          peGreeks: { delta: data.pe.delta, theta: data.pe.theta, vega: data.pe.vega, gamma: data.pe.gamma, iv: data.pe.iv }
                        }, side);
                      }}
                      onMouseLeave={e => { const rel = e.relatedTarget as HTMLElement | null; if (rel instanceof HTMLElement && (rel.closest('.oc-bs-overlay') || rel.closest('.oc-row'))) return; hideOverlay(); }}
                    >
                      {row.getVisibleCells().map(cell => {
                        const id = cell.column.id;
                        const isStrike = id === 'strike';
                        const isCe = CE_COLS.includes(id);
                        // Bloomberg-style ITM: vivid teal for CE, warm amber for PE
                        const cellBg = isCe && isCeItm
                          ? 'rgba(0,168,132,0.18)'      // Bloomberg teal/green — CE ITM (lighter)
                          : !isCe && !isStrike && isPeItm
                          ? 'rgba(210,130,0,0.28)'      // Bloomberg amber/orange — PE ITM
                          : undefined;
                        return (
                          <td key={cell.id} data-col={id} className={isStrike ? 'oc-strike-cell' : ''} style={{
                            width: W[id], minWidth: W[id], padding: '8px 10px',
                            fontSize: 13, fontWeight: id==='strike' ? 700 : 500, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
                            textAlign: isStrike ? 'center' : isCe ? 'right' : 'left',
                            whiteSpace: 'nowrap',
                            ...(cellBg ? { background: cellBg } : isStrike ? { background: '#333333' } : {}),
                          }}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div ref={ceOverlayRef} className="oc-bs-overlay" style={{ display: 'none', position: 'fixed', left: 0, top: 0, pointerEvents: 'none' }}>
        <button className="oc-btn oc-btn-b" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); openPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'CE', action: 'B', price: d.ceLtp, refId: d.ceRefId, greeks: d.ceGreeks }); }}>B</button>
        <button className="oc-btn oc-btn-s" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); openPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'CE', action: 'S', price: d.ceLtp, refId: d.ceRefId, greeks: d.ceGreeks }); }}>S</button>
      </div>
      <div ref={peOverlayRef} className="oc-bs-overlay" style={{ display: 'none', position: 'fixed', left: 0, top: 0, pointerEvents: 'none' }}>
        <button className="oc-btn oc-btn-b" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); openPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'PE', action: 'B', price: d.peLtp, refId: d.peRefId, greeks: d.peGreeks }); }}>B</button>
        <button className="oc-btn oc-btn-s" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); openPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'PE', action: 'S', price: d.peLtp, refId: d.peRefId, greeks: d.peGreeks }); }}>S</button>
      </div>

      {/* Qty popup */}
      {popup && (() => {
        const isBuy = popup.action === 'B';
        const accentColor = isBuy ? '#26a69a' : '#f23645';
        const accentBg = isBuy ? 'rgba(38,166,154,0.12)' : 'rgba(242,54,69,0.12)';
        const accentBorder = isBuy ? 'rgba(38,166,154,0.4)' : 'rgba(242,54,69,0.4)';
        return (
          <div ref={popupRef} style={{
            position: 'fixed', left: popup.x, top: popup.y, transform: 'translateX(-50%)',
            zIndex: 9999, background: '#1a1a1a', border: `1px solid ${accentBorder}`,
            borderRadius: 12, padding: '12px 14px', boxShadow: '0 12px 48px rgba(0,0,0,0.7)',
            display: 'flex', flexDirection: 'column', gap: 8,
            width: 240,
            maxHeight: 'calc(100vh - 40px)', overflowY: 'auto',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ padding: '2px 8px', borderRadius: 5, background: accentBg, border: `1px solid ${accentBorder}` }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: accentColor }}>{popup.action === 'B' ? 'BUY' : 'SELL'}</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa' }}>{popup.strike}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: popup.type === 'CE' ? '#facc15' : '#c084fc' }}>{popup.type}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4B5563', padding: 0, display: 'flex' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            {/* Price */}
            <div style={{ fontSize: 11, color: '#4B5563' }}>@ <span style={{ color: '#E2E8F0', fontWeight: 600 }}>₹{popup.price.toFixed(2)}</span></div>
            {/* Qty stepper */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 600, flex: 1 }}>Qty</span>
              <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, overflow: 'hidden' }}>
                <button onClick={() => setQty(q => Math.max(1, q - 1))} style={{ width: 26, height: 26, background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                <input type="number" value={qty} min={1} onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setQty(v); }} onBlur={e => { const v = parseInt(e.target.value); setQty(isNaN(v) || v < 1 ? 1 : v); }} style={{ width: 54, textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#E2E8F0', background: 'transparent', border: 'none', outline: 'none', MozAppearance: 'textfield' }} />
                <button onClick={() => setQty(q => q + 1)} style={{ width: 26, height: 26, background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
              </div>
            </div>
            {/* Date + time picker (historical only) */}
            {isHistoricalMode && (
              <CalendarPicker
                date={entryDate}
                time={entryTime}
                onDateChange={setEntryDate}
                onTimeChange={setEntryTime}
              />
            )}
            {/* Confirm */}
            <button disabled={fetching} onClick={async () => {
              if (!isHistoricalMode) {
                onAddLeg?.({ symbol, expiry: selectedExpiry!, strike: popup.strike, type: popup.type, action: popup.action, price: popup.price, lots: qty, lotSize, refId: popup.refId, greeks: popup.greeks, entryDate, entryTime, entrySpot: spot });
                setPopup(null);
                return;
              }
              // Historical mode: fetch close price at entryDate+entryTime from Nubra
              setFetching(true);
              try {
                const candleTs = new Date(`${entryDate}T${entryTime}:00+05:30`).getTime();
                // startDate = day before at 09:15 IST in UTC, endDate = entry time IST in UTC
                const startUtc = new Date(`${entryDate}T03:45:00Z`).toISOString();
                const endUtc = new Date(`${entryDate}T${entryTime}:00+05:30`).toISOString();

                // Build NSE option instrument name: e.g. NIFTY2631724500CE
                // selectedExpiry format: "20260317" (YYYYMMDD) → YY=26, M=3, DD=17
                const buildOptName = (exp: string) => {
                  const yy = exp.slice(2, 4);   // "26"
                  const m = String(parseInt(exp.slice(4, 6)));  // "3" (no leading zero)
                  const dd = exp.slice(6, 8);   // "17"
                  return `${symbol}${yy}${m}${dd}${popup.strike}${popup.type}`;
                };
                const optName = buildOptName(selectedExpiry ?? '');

                const fetchClose = async (nubraType: string, value: string) => {
                  const res = await fetch('/api/nubra-historical', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      session_token: sessionToken,
                      exchange,
                      type: nubraType,
                      values: [value],
                      fields: ['close'],
                      startDate: startUtc,
                      endDate: endUtc,
                      interval: '1m',
                      intraDay: false,
                    }),
                  });
                  const json = await res.json();
                  // Response: { result: [ { values: [ { "NIFTY...CE": { close: [{ts,v}] } } ] } ] }
                  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
                  let stockChart: any = null;
                  for (const dict of valuesArr) {
                    for (const v of Object.values(dict)) { stockChart = v; break; }
                    if (stockChart) break;
                  }
                  if (!stockChart) return null;
                  const closeArr: { ts: number; v: number }[] = stockChart.close ?? [];
                  if (!closeArr.length) return null;
                  // ts is nanoseconds — find candle closest to entryTime
                  let best = closeArr[closeArr.length - 1];
                  let bestDiff = Infinity;
                  for (const c of closeArr) {
                    const diff = Math.abs(c.ts / 1e6 - candleTs);
                    if (diff < bestDiff) { bestDiff = diff; best = c; }
                  }
                  return best.v / 100;
                };

                const fetchGreeks = async (nubraType: string, value: string) => {
                  const res = await fetch('/api/nubra-historical', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      session_token: sessionToken,
                      exchange,
                      type: nubraType,
                      values: [value],
                      fields: ['delta', 'theta', 'vega', 'gamma', 'iv_mid'],
                      startDate: startUtc,
                      endDate: endUtc,
                      interval: '1m',
                      intraDay: false,
                    }),
                  });
                  const json = await res.json();
                  const valuesArr: any[] = json?.result?.[0]?.values ?? [];
                  let stockChart: any = null;
                  for (const dict of valuesArr) {
                    for (const v of Object.values(dict)) { stockChart = v; break; }
                    if (stockChart) break;
                  }
                  if (!stockChart) return null;
                  const pick = (arr: { ts: number; v: number }[] | undefined) => {
                    const a = arr ?? [];
                    if (!a.length) return null;
                    let best = a[a.length - 1];
                    let bestDiff = Infinity;
                    for (const c of a) {
                      const diff = Math.abs(c.ts / 1e6 - candleTs);
                      if (diff < bestDiff) { bestDiff = diff; best = c; }
                    }
                    return best.v;
                  };
                  const delta = pick(stockChart.delta);
                  const theta = pick(stockChart.theta);
                  const vega  = pick(stockChart.vega);
                  const gamma = pick(stockChart.gamma);
                  const ivMid = pick(stockChart.iv_mid);
                  if (delta === null && theta === null && vega === null && gamma === null && ivMid === null) return null;
                  return {
                    delta: delta ?? 0,
                    theta: theta ?? 0,
                    vega:  vega ?? 0,
                    gamma: gamma ?? 0,
                    iv:    ivMid ?? 0,
                  };
                };

                const [optionClose, optionGreeks, spotClose] = await Promise.all([
                  optName ? fetchClose('OPT', optName) : Promise.resolve(null),
                  optName ? fetchGreeks('OPT', optName) : Promise.resolve(null),
                  spotRefId ? fetchClose('INDEX', symbol) : Promise.resolve(null),
                ]);
                const entryPrice = optionClose ?? popup.price;
                const entrySpotPrice = spotClose ?? spot;
                const entryGreeks = optionGreeks ?? popup.greeks;
                onAddLeg?.({ symbol, expiry: selectedExpiry!, strike: popup.strike, type: popup.type, action: popup.action, price: entryPrice, lots: qty, lotSize, refId: popup.refId, greeks: entryGreeks, entryDate, entryTime, entrySpot: entrySpotPrice } as any);
                setPopup(null);
              } catch {
                // fallback to current price on error
                onAddLeg?.({ symbol, expiry: selectedExpiry!, strike: popup.strike, type: popup.type, action: popup.action, price: popup.price, lots: qty, lotSize, refId: popup.refId, greeks: popup.greeks, entryDate, entryTime } as any);
                setPopup(null);
              } finally {
                setFetching(false);
              }
            }} style={{
              padding: '6px 0', borderRadius: 7, background: fetching ? 'rgba(255,255,255,0.05)' : accentBg, border: `1px solid ${accentBorder}`,
              color: fetching ? '#6B7280' : accentColor, fontSize: 12, fontWeight: 700, cursor: fetching ? 'not-allowed' : 'pointer', letterSpacing: '0.04em',
            }}>{fetching ? 'Fetching price…' : 'Add to Basket'}</button>
          </div>
        );
      })()}
    </div>
  );
}

// ── MCX Option Chain — uses Upstox wsManager, same UI as Nubra ───────────────

interface McxSide {
  ltp: number; chgPct: number; oi: number; delta: number; theta: number; gamma: number; vega: number; iv: number;
}
interface McxRow {
  strike: number; ce: McxSide; pe: McxSide; isAtm: boolean;
  ceKey: string | null; peKey: string | null;
}
const MCX_EMPTY: McxSide = { ltp: 0, chgPct: 0, oi: 0, delta: 0, theta: 0, gamma: 0, vega: 0, iv: 0 };

function fmtExpTs(ms: number): string {
  return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

const mch = createColumnHelper<McxRow>();
const MCX_CE_COLS = ['mce_iv', 'mce_gamma', 'mce_vega', 'mce_theta', 'mce_delta', 'mce_oi', 'mce_chg', 'mce_price'];
const MCX_COL_MAP: Record<string, string[]> = {
  ltp:   ['mce_price', 'mpe_price'],
  chg:   ['mce_chg',   'mpe_chg'],
  oi:    ['mce_oi',    'mpe_oi'],
  delta: ['mce_delta', 'mpe_delta'],
  theta: ['mce_theta', 'mpe_theta'],
  gamma: ['mce_gamma', 'mpe_gamma'],
  vega:  ['mce_vega',  'mpe_vega'],
  iv:    ['mce_iv',    'mpe_iv'],
};
const MCX_COL_LABELS: Record<string, string> = {
  ltp: 'LTP (Price)', chg: 'Chg %', oi: 'OI',
  delta: 'Delta', theta: 'Theta', gamma: 'Gamma', vega: 'Vega', iv: 'IV',
};
const MW: Record<string, number> = {
  mce_iv: 50, mce_gamma: 56, mce_vega: 50, mce_theta: 56, mce_delta: 52, mce_oi: 90, mce_chg: 72, mce_price: 76,
  mstrike: 72,
  mpe_price: 76, mpe_chg: 72, mpe_oi: 90, mpe_delta: 52, mpe_theta: 56, mpe_vega: 50, mpe_gamma: 56, mpe_iv: 50,
};

function OptionChainMCX({ symbol, instruments, onClose, onAddLeg, lotSize = 1, ocSpotRef, isHistoricalMode }: {
  symbol: string;
  instruments: Instrument[];
  onClose: () => void;
  onAddLeg?: (leg: AddLegPayload) => void;
  lotSize?: number;
  ocSpotRef?: { current: number };
  isHistoricalMode?: boolean;
}) {
  const underlying = useMemo(() => {
    const key = symbol.toUpperCase();
    const match = instruments.find(i =>
      i.exchange === 'MCX' && (
        i.trading_symbol?.toUpperCase() === key ||
        i.underlying_symbol?.toUpperCase() === key ||
        i.name?.toUpperCase() === key ||
        i.instrument_key?.toUpperCase() === key ||
        (i.underlying_symbol && key.startsWith(i.underlying_symbol.toUpperCase())) ||
        (i.trading_symbol && key.startsWith(i.trading_symbol.toUpperCase()))
      )
    );
    const base = match?.underlying_symbol || match?.trading_symbol || symbol;
    return base.toUpperCase();
  }, [symbol, instruments]);

  const expiries = useMemo(() => {
    const today = Date.now();
    return [...new Set(
      instruments.filter(i =>
        (i.instrument_type === 'CE' || i.instrument_type === 'PE') &&
        i.underlying_symbol?.toUpperCase() === underlying &&
        i.exchange === 'MCX' &&
        i.expiry != null && i.expiry >= today - 86400000
      ).map(i => i.expiry as number)
    )].sort((a, b) => a - b);
  }, [instruments, underlying]);

  const [selectedExpiry, setSelectedExpiry] = useState<number | null>(null);
  useEffect(() => {
    if (expiries.length > 0 && (selectedExpiry === null || !expiries.includes(selectedExpiry))) {
      setSelectedExpiry(expiries[0]);
    }
  }, [expiries, selectedExpiry]);

  const baseRows = useMemo(() => {
    if (!selectedExpiry) return [];
    const strikeMap = new Map<number, { ceKey: string | null; peKey: string | null }>();
    for (const ins of instruments) {
      if (ins.exchange !== 'MCX' || (ins.instrument_type !== 'CE' && ins.instrument_type !== 'PE')) continue;
      if (ins.underlying_symbol?.toUpperCase() !== underlying || ins.expiry !== selectedExpiry) continue;
      const s = ins.strike_price ?? 0;
      if (!strikeMap.has(s)) strikeMap.set(s, { ceKey: null, peKey: null });
      const row = strikeMap.get(s)!;
      if (ins.instrument_type === 'CE') row.ceKey = ins.instrument_key;
      else row.peKey = ins.instrument_key;
    }
    return [...strikeMap.entries()].sort((a, b) => a[0] - b[0]).map(([strike, { ceKey, peKey }]) => ({ strike, ceKey, peKey }));
  }, [instruments, underlying, selectedExpiry]);

  // Live data from wsManager — all mutable state in refs to avoid stale closures
  const [rows, setRows] = useState<McxRow[]>([]);
  const [spot, setSpot] = useState(0);
  const mdRef = useRef<Map<string, McxSide>>(new Map());
  const spotRef = useRef(0);
  const baseRowsRef = useRef(baseRows);
  baseRowsRef.current = baseRows;

  // Stable rebuild — reads from refs, never goes stale
  const rebuildRows = useRef((spotVal: number) => {
    const br = baseRowsRef.current;
    const atmStrike = br.length
      ? br.reduce((best, r) => Math.abs(r.strike - spotVal) < Math.abs(best - spotVal) ? r.strike : best, br[0].strike)
      : 0;
    setRows(br.map(r => ({
      strike: r.strike, ceKey: r.ceKey, peKey: r.peKey,
      ce: r.ceKey ? (mdRef.current.get(r.ceKey) ?? { ...MCX_EMPTY }) : { ...MCX_EMPTY },
      pe: r.peKey ? (mdRef.current.get(r.peKey) ?? { ...MCX_EMPTY }) : { ...MCX_EMPTY },
      isAtm: r.strike === atmStrike,
    })));
  }).current;

  useEffect(() => {
    const br = baseRowsRef.current;
    if (!br.length) return; // don't clear — keep showing old rows while expiry loads
    const allKeys = br.flatMap(r => [r.ceKey, r.peKey]).filter(Boolean) as string[];

    // Seed from wsManager cache immediately (no blank flash)
    for (const k of allKeys) {
      const md = wsManager.get(k);
      if (md) {
        const ltp = md.ltp ?? 0; const prev = md.cp ?? 0;
        mdRef.current.set(k, { ltp, chgPct: prev > 0 ? ((ltp - prev) / prev) * 100 : 0, oi: md.oi ?? 0, delta: md.delta ?? 0, theta: md.theta ?? 0, gamma: md.gamma ?? 0, vega: md.vega ?? 0, iv: md.iv ?? 0 });
      }
    }
    wsManager.requestKeys(allKeys);
    rebuildRows(spotRef.current);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = null; rebuildRows(spotRef.current); }, 200); };

    const unsubs = allKeys.map(k => wsManager.subscribe(k, md => {
      const ltp = md.ltp ?? 0; const prev = md.cp ?? 0;
      mdRef.current.set(k, { ltp, chgPct: prev > 0 ? ((ltp - prev) / prev) * 100 : 0, oi: md.oi ?? 0, delta: md.delta ?? 0, theta: md.theta ?? 0, gamma: md.gamma ?? 0, vega: md.vega ?? 0, iv: md.iv ?? 0 });
      schedule();
    }));

    return () => { unsubs.forEach(u => u()); if (timer) clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRows]);

  const spotKey = useMemo(() => {
    const now = Date.now();
    // Debug: log all MCX instruments matching this underlying so we can see real field values
    const mcxAll = instruments.filter(i => i.exchange === 'MCX' && (i.underlying_symbol?.toUpperCase() === underlying || i.trading_symbol?.toUpperCase().startsWith(underlying)));
    console.log('[MCX spotKey] underlying:', underlying, 'candidates:', mcxAll.map(i => ({ key: i.instrument_key, type: i.instrument_type, sym: i.trading_symbol, under: i.underlying_symbol, expiry: i.expiry })));

    // Pick the nearest-expiry MCX FUT for this underlying (front-month = closest to today)
    const futs = instruments.filter(i =>
      i.exchange === 'MCX' &&
      i.instrument_type === 'FUT' &&
      i.underlying_symbol?.toUpperCase() === underlying &&
      i.expiry != null && i.expiry >= now
    );
    if (futs.length) {
      futs.sort((a, b) => (a.expiry as number) - (b.expiry as number));
      console.log('[MCX spotKey] picked FUT:', futs[0].instrument_key, futs[0].trading_symbol);
      return futs[0].instrument_key;
    }
    // Fallback: any MCX instrument whose trading_symbol starts with underlying
    const fallback = instruments.find(i =>
      i.exchange === 'MCX' &&
      i.trading_symbol?.toUpperCase().startsWith(underlying)
    );
    console.log('[MCX spotKey] fallback:', fallback?.instrument_key, fallback?.trading_symbol);
    return fallback?.instrument_key ?? null;
  }, [instruments, underlying]);

  useEffect(() => {
    if (!spotKey) return;
    wsManager.requestKeys([spotKey]);
    const snap = wsManager.get(spotKey);
    if (snap?.ltp) { spotRef.current = snap.ltp; if (ocSpotRef) ocSpotRef.current = snap.ltp; setSpot(snap.ltp); rebuildRows(snap.ltp); }
    return wsManager.subscribe(spotKey, md => {
      if (md.ltp) { spotRef.current = md.ltp; if (ocSpotRef) ocSpotRef.current = md.ltp; setSpot(md.ltp); rebuildRows(md.ltp); }
    });
  }, [spotKey, rebuildRows]);

  const atmStrike = rows.find(r => r.isAtm)?.strike ?? null;
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  const shouldScrollToAtm = useRef(true);
  useEffect(() => { shouldScrollToAtm.current = true; }, [selectedExpiry]);
  useEffect(() => {
    if (!rows.length || !shouldScrollToAtm.current || !atmRowRef.current) return;
    shouldScrollToAtm.current = false;
    requestAnimationFrame(() => atmRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [rows]);

  // Columns — same as Nubra
  const maxCeOi = useMemo(() => Math.max(1, ...rows.map(r => r.ce.oi)), [rows]);
  const maxPeOi = useMemo(() => Math.max(1, ...rows.map(r => r.pe.oi)), [rows]);

  const [qty, setQty] = useState(1);
  const [entryDate, setEntryDate] = useState(() => getDefaultEntryDate());
  const [entryTime, setEntryTime] = useState('09:15');
  const [fetching, setFetching] = useState(false);
  const [popup, setPopup] = useState<{ x: number; y: number; strike: number; type: 'CE' | 'PE'; action: 'B' | 'S'; price: number; instrumentKey: string | null; greeks: { delta: number; theta: number; vega: number; gamma: number; iv: number } } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const ceOverlayRef = useRef<HTMLDivElement>(null);
  const peOverlayRef = useRef<HTMLDivElement>(null);
  const overlayDataRef = useRef<{ strike: number; ceLtp: number; peLtp: number; ceKey: string | null; peKey: string | null; ceGreeks: any; peGreeks: any } | null>(null);
  const showOverlay = (fixedTop: number, ceFixedLeft: number, ceW: number, peFixedLeft: number, peW: number, cellH: number, data: NonNullable<typeof overlayDataRef.current>, side?: 'CE' | 'PE') => {
    overlayDataRef.current = data;
    const ce = ceOverlayRef.current; const pe = peOverlayRef.current;
    if (ce) { if (side === 'CE' || !side) { ce.style.left = ceFixedLeft + 'px'; ce.style.top = fixedTop + 'px'; ce.style.width = ceW + 'px'; ce.style.height = cellH + 'px'; ce.style.display = 'flex'; } else ce.style.display = 'none'; }
    if (pe) { if (side === 'PE' || !side) { pe.style.left = peFixedLeft + 'px'; pe.style.top = fixedTop + 'px'; pe.style.width = peW + 'px'; pe.style.height = cellH + 'px'; pe.style.display = 'flex'; } else pe.style.display = 'none'; }
  };
  const hideOverlay = () => { const ce = ceOverlayRef.current; const pe = peOverlayRef.current; if (ce) ce.style.display = 'none'; if (pe) pe.style.display = 'none'; };
  useEffect(() => {
    if (!popup) return;
    const h = (e: MouseEvent) => { if (popupRef.current && !popupRef.current.contains(e.target as Node)) setPopup(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [popup]);

  const effLotSize = useMemo(() => {
    const ins = instruments.find(i => i.exchange === 'MCX' && (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.underlying_symbol?.toUpperCase() === underlying);
    return ins?.lot_size ?? lotSize;
  }, [instruments, underlying, lotSize]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [colVis, setColVis] = useState<Record<string, boolean>>({ ltp: true, chg: true, oi: true, delta: true, theta: true, gamma: false, vega: false, iv: true });
  const [colOrder, setColOrder] = useState(['ltp', 'chg', 'oi', 'delta', 'theta', 'gamma', 'vega', 'iv']);
  const dragIdx = useRef<number | null>(null);
  const dragKey = useRef<string | null>(null);

  const hiddenIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const [key, ids] of Object.entries(MCX_COL_MAP)) { if (!colVis[key]) ids.forEach(id => hidden.add(id)); }
    return hidden;
  }, [colVis]);

  const allColumns = useMemo(() => [
    mch.accessor(r => r.ce.iv,    { id: 'mce_iv',    header: 'IV',       cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    mch.accessor(r => r.ce.gamma, { id: 'mce_gamma', header: 'Gamma',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue(), 4)}</span> }),
    mch.accessor(r => r.ce.vega,  { id: 'mce_vega',  header: 'Vega',     cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    mch.accessor(r => r.ce.theta, { id: 'mce_theta', header: 'Theta',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    mch.accessor(r => r.ce.delta, { id: 'mce_delta', header: 'Delta',    cell: i => <span style={{ color: '#26a69a' }}>{fmtGreek(i.getValue())}</span> }),
    mch.accessor(r => r.ce.oi,    { id: 'mce_oi',    header: 'Call OI',  cell: i => {
      const pct = Math.min(100, (i.getValue() / maxCeOi) * 100);
      return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: `linear-gradient(to left, rgba(38,210,164,0.45) ${pct}%, transparent ${pct}%)`, borderRadius: 2, padding: '2px 0' }}><span style={{ color: '#E2E8F0', fontWeight: 600 }}>{fmtOi(i.getValue())}</span></div>;
    } }),
    mch.accessor(r => r.ce.chgPct, { id: 'mce_chg',  header: 'Chg%',    cell: i => { const v = i.getValue(); return <span style={{ color: v >= 0 ? '#6bbfaa' : '#ef5350' }}>{fmtPct(v)}</span>; } }),
    mch.accessor(r => r.ce.ltp,   { id: 'mce_price', header: 'Call LTP', cell: i => {
      const row = i.row.original;
      return (
        <div className="oc-ltp-cell oc-ltp-cell-ce">
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-b" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'CE', action: 'B', price: i.getValue(), instrumentKey: row.ceKey, greeks: { delta: row.ce.delta, theta: row.ce.theta, vega: row.ce.vega, gamma: row.ce.gamma, iv: row.ce.iv } }); }}>B</button></span>
          <span style={{ color: '#C0C0C0', fontWeight: 700 }}>{fmtPrice(i.getValue())}</span>
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-s" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'CE', action: 'S', price: i.getValue(), instrumentKey: row.ceKey, greeks: { delta: row.ce.delta, theta: row.ce.theta, vega: row.ce.vega, gamma: row.ce.gamma, iv: row.ce.iv } }); }}>S</button></span>
        </div>
      );
    } }),
    mch.accessor(r => r.strike, { id: 'mstrike', header: 'Strike',
      cell: i => { const row = i.row.original; return <span className="oc-strike-cell" style={{ color: row.isAtm ? '#e0a800' : '#C0C0C0', fontWeight: row.isAtm ? 800 : 700, display: 'block', width: '100%' }}>{i.getValue() % 1 === 0 ? i.getValue().toFixed(0) : i.getValue().toFixed(2)}</span>; },
    }),
    mch.accessor(r => r.pe.ltp,   { id: 'mpe_price', header: 'Put LTP',  cell: i => {
      const row = i.row.original;
      return (
        <div className="oc-ltp-cell oc-ltp-cell-pe">
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-b" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'PE', action: 'B', price: i.getValue(), instrumentKey: row.peKey, greeks: { delta: row.pe.delta, theta: row.pe.theta, vega: row.pe.vega, gamma: row.pe.gamma, iv: row.pe.iv } }); }}>B</button></span>
          <span style={{ color: '#C0C0C0', fontWeight: 700 }}>{fmtPrice(i.getValue())}</span>
          <span className="oc-ltp-btn-wrap"><button className="oc-btn oc-btn-s" onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: row.strike, type: 'PE', action: 'S', price: i.getValue(), instrumentKey: row.peKey, greeks: { delta: row.pe.delta, theta: row.pe.theta, vega: row.pe.vega, gamma: row.pe.gamma, iv: row.pe.iv } }); }}>S</button></span>
        </div>
      );
    } }),
    mch.accessor(r => r.pe.chgPct, { id: 'mpe_chg',  header: 'Chg%',    cell: i => { const v = i.getValue(); return <span style={{ color: v >= 0 ? '#6bbfaa' : '#ef5350' }}>{fmtPct(v)}</span>; } }),
    mch.accessor(r => r.pe.oi,    { id: 'mpe_oi',    header: 'Put OI',   cell: i => {
      const pct = Math.min(100, (i.getValue() / maxPeOi) * 100);
      return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', background: `linear-gradient(to right, rgba(242,54,69,0.45) ${pct}%, transparent ${pct}%)`, borderRadius: 2, padding: '2px 0' }}><span style={{ color: '#E2E8F0', fontWeight: 600 }}>{fmtOi(i.getValue())}</span></div>;
    } }),
    mch.accessor(r => r.pe.delta, { id: 'mpe_delta', header: 'Delta',    cell: i => <span style={{ color: '#f23645' }}>{fmtGreek(i.getValue())}</span> }),
    mch.accessor(r => r.pe.theta, { id: 'mpe_theta', header: 'Theta',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    mch.accessor(r => r.pe.vega,  { id: 'mpe_vega',  header: 'Vega',     cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
    mch.accessor(r => r.pe.gamma, { id: 'mpe_gamma', header: 'Gamma',    cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue(), 4)}</span> }),
    mch.accessor(r => r.pe.iv,    { id: 'mpe_iv',    header: 'IV',       cell: i => <span style={{ color: '#9CA3AF' }}>{fmtGreek(i.getValue())}</span> }),
  ], [maxCeOi, maxPeOi]);

  const columns = useMemo(() => {
    const orderedCe = [...colOrder].reverse().flatMap(k => MCX_COL_MAP[k]?.[0] ? [MCX_COL_MAP[k][0]] : []).filter(id => !hiddenIds.has(id));
    const orderedPe = colOrder.flatMap(k => MCX_COL_MAP[k]?.[1] ? [MCX_COL_MAP[k][1]] : []).filter(id => !hiddenIds.has(id));
    const orderedIds = [...orderedCe, 'mstrike', ...orderedPe];
    return orderedIds.map(id => allColumns.find((c: any) => c.id === id)!).filter(Boolean);
  }, [allColumns, hiddenIds, colOrder]);

  const visibleCeCols = [...colOrder].reverse().map(k => MCX_COL_MAP[k]?.[0]).filter((id): id is string => !!id && !hiddenIds.has(id));
  const visiblePeCols = colOrder.map(k => MCX_COL_MAP[k]?.[1]).filter((id): id is string => !!id && !hiddenIds.has(id));

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const totalWidth = useMemo(() => columns.map((c: any) => c.id as string).reduce((s, id) => s + (MW[id] ?? 72), 0), [columns]);
  const expLabel = selectedExpiry ? fmtExpTs(selectedExpiry) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1d1a17', color: '#D1D5DB', position: 'relative' }}>
      <style>{`
        .oc-tbody tr.oc-row:hover td { background: rgba(255,255,255,0.03); }
        .oc-tbody tr.oc-row-atm td { background: rgba(224,168,0,0.04); }
        .oc-tbody tr.oc-row-atm:hover td { background: rgba(224,168,0,0.08); }
        .oc-tbody tr.oc-row-odd td { background: transparent; }
        .oc-tbody tr.oc-row-even td { background: rgba(255,255,255,0.015); }
        .oc-gear:hover { background: rgba(255,255,255,0.1) !important; }
        .oc-cb-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer; user-select: none; }
        .oc-cb-row:last-child { border-bottom: none; }
        .oc-cb-row:hover { background: rgba(255,255,255,0.03); border-radius: 6px; }
        .oc-cb-row.drag-over { background: rgba(79,142,247,0.1); border-radius: 6px; }
        .oc-drag-handle { cursor: grab; opacity: 0.3; flex-shrink: 0; padding: 2px; }
        .oc-drag-handle:hover { opacity: 0.8; }
        .oc-ltp-cell { display: flex; align-items: center; justify-content: center; gap: 8px; }
        .oc-ltp-btn-wrap { opacity: 0; pointer-events: none; transition: none; }
        .oc-tbody tr.oc-row[data-hover-side="CE"]:hover .oc-ltp-cell-ce .oc-ltp-btn-wrap { opacity: 1; pointer-events: auto; }
        .oc-tbody tr.oc-row[data-hover-side="PE"]:hover .oc-ltp-cell-pe .oc-ltp-btn-wrap { opacity: 1; pointer-events: auto; }
        .oc-btn { font-size: 11px; font-weight: 800; padding: 5px 10px; border-radius: 6px; border: none; cursor: pointer; letter-spacing: 0.08em; line-height: 1.5; transition: all 0.15s; }
        .oc-btn-b { background: rgba(38,166,154,0.15); color: #26a69a; border: 1px solid rgba(38,166,154,0.3); }
        .oc-btn-b:hover { background: rgba(38,166,154,0.25); border-color: rgba(38,166,154,0.5); }
        .oc-btn-s { background: rgba(242,54,69,0.15); color: #f23645; border: 1px solid rgba(242,54,69,0.3); }
        .oc-btn-s:hover { background: rgba(242,54,69,0.25); border-color: rgba(242,54,69,0.5); }
      `}</style>

      {/* Settings modal */}
      {settingsOpen && (
        <div onClick={() => setSettingsOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: 50, backdropFilter: 'blur(6px)', background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#1f1f1f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, width: 300, padding: '18px 20px', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#E2E8F0' }}>Choose Columns</span>
              <button onClick={() => setSettingsOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#6b7280', display: 'flex', padding: 2 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div>
              {colOrder.map(key => (
                <div key={key} className="oc-cb-row"
                  onDragEnter={e => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); const fk = dragKey.current; if (!fk || fk === key) return; setColOrder(prev => { const fi = prev.indexOf(fk), ti = prev.indexOf(key); if (fi === -1 || ti === -1) return prev; const n = [...prev]; n.splice(fi, 1); n.splice(ti, 0, fk); return n; }); }}
                  onDragOver={e => e.preventDefault()}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) e.currentTarget.classList.remove('drag-over'); }}
                  onDrop={e => { e.currentTarget.classList.remove('drag-over'); dragKey.current = null; dragIdx.current = null; }}
                  onClick={() => setColVis(v => ({ ...v, [key]: !v[key] }))}
                >
                  <span className="oc-drag-handle" draggable onDragStart={e => { e.stopPropagation(); dragKey.current = key; dragIdx.current = colOrder.indexOf(key); }} onDragEnd={() => { dragKey.current = null; dragIdx.current = null; }} onClick={e => e.stopPropagation()}>
                    <svg width="10" height="14" viewBox="0 0 10 14" fill="none"><circle cx="2.5" cy="2.5" r="1.5" fill="#9CA3AF"/><circle cx="7.5" cy="2.5" r="1.5" fill="#9CA3AF"/><circle cx="2.5" cy="7" r="1.5" fill="#9CA3AF"/><circle cx="7.5" cy="7" r="1.5" fill="#9CA3AF"/><circle cx="2.5" cy="11.5" r="1.5" fill="#9CA3AF"/><circle cx="7.5" cy="11.5" r="1.5" fill="#9CA3AF"/></svg>
                  </span>
                  <div style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, background: colVis[key] ? '#f97316' : 'transparent', border: `1.5px solid ${colVis[key] ? '#f97316' : 'rgba(255,255,255,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s ease' }}>
                    {colVis[key] && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  <span style={{ fontSize: 13, color: colVis[key] ? '#E2E8F0' : '#6b7280', fontWeight: 500, flex: 1 }}>{MCX_COL_LABELS[key]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, background: 'var(--bg-panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 800, color: '#E2E8F0', letterSpacing: '0.04em' }}>{underlying}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#f97316', background: 'rgba(249,115,22,0.1)', padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(249,115,22,0.25)' }}>MCX</span>
          {spot > 0 && <span style={{ fontSize: 14, fontWeight: 700, color: '#4F8EF7', background: 'rgba(79,142,247,0.1)', padding: '4px 12px', borderRadius: 8, border: '1px solid rgba(79,142,247,0.2)' }}>{spot.toFixed(2)}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7280' }}>{expLabel}</span>
          <button className="oc-gear" onClick={() => setSettingsOpen(true)} title="Choose columns"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', color: '#817E7E', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, transition: 'background 0.15s' }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 13.648 13.648" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M5.09373 0.995125C5.16241 0.427836 5.64541 0 6.21747 0H7.43151C8.0039 0 8.48663 0.428191 8.55525 0.996829C8.5553 0.997248 8.55536 0.997666 8.5554 0.9981L8.65947 1.81525C8.80015 1.86677 8.93789 1.92381 9.07227 1.98601L9.72415 1.47911C10.1776 1.12819 10.8237 1.16381 11.2251 1.57622L12.0753 2.42643C12.4854 2.82551 12.5214 3.47159 12.1697 3.92431L11.6628 4.57692C11.725 4.71124 11.782 4.84882 11.8335 4.98924L12.6526 5.09337C12.653 5.09342 12.6534 5.09348 12.6539 5.09352C13.2211 5.16221 13.6492 5.64522 13.6484 6.21766V7.4312C13.6484 8.00358 13.2203 8.48622 12.6517 8.5549C12.6513 8.55496 12.6508 8.55502 12.6503 8.55506L11.8338 8.65909C11.7824 8.7996 11.7254 8.93729 11.663 9.07168L12.1696 9.72354C12.5218 10.1776 12.4847 10.823 12.0728 11.2245L11.2224 12.0749C10.8233 12.485 10.1772 12.5209 9.72452 12.1692L9.07187 11.6624C8.93756 11.7246 8.79995 11.7815 8.65952 11.833L8.55539 12.6521C8.55533 12.6525 8.55528 12.653 8.55522 12.6534C8.48652 13.2206 8.00353 13.6484 7.43151 13.6484H6.21747C5.64485 13.6484 5.16232 13.22 5.09373 12.6506C5.09367 12.6501 5.09361 12.6496 5.09355 12.6491L4.98954 11.8328C4.84901 11.7814 4.71133 11.7244 4.57692 11.662L3.92477 12.1688C3.47111 12.5199 2.82587 12.4838 2.42408 12.0724L1.57358 11.2219C1.16354 10.8229 1.12761 10.1769 1.47927 9.72417L1.98614 9.0715C1.92397 8.93721 1.86696 8.7996 1.81546 8.65919L0.996348 8.55505C0.995929 8.555 0.995526 8.55494 0.995107 8.5549C0.427838 8.48619 0 8.00325 0 7.4312V6.21724C0 5.64481 0.428228 5.16211 0.996871 5.09351L1.81538 4.98929C1.86677 4.84897 1.92362 4.7113 1.98597 4.5768L1.47915 3.92465C1.12701 3.47063 1.1643 2.82485 1.57625 2.42329L2.42671 1.57338C2.82634 1.16348 3.47226 1.12815 3.92438 1.4792L4.57644 1.98589C4.71105 1.92352 4.84888 1.86662 4.98946 1.81519L5.09373 0.995125ZM6.82448 4.43525C5.50742 4.43525 4.43541 5.50723 4.43541 6.82422C4.43541 8.14119 5.50742 9.21317 6.82448 9.21317C8.14154 9.21317 9.21356 8.14119 9.21356 6.82422C9.21356 5.50723 8.14154 4.43525 6.82448 4.43525ZM3.79381 6.82422C3.79381 5.15287 5.15311 3.79365 6.82448 3.79365C8.49586 3.79365 9.85515 5.15287 9.85515 6.82422C9.85515 8.49556 8.49586 9.85477 6.82448 9.85477C5.15311 9.85477 3.79381 8.49556 3.79381 6.82422Z" />
            </svg>
          </button>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', color: '#9CA3AF', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      {/* Expiry tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.03)', flexShrink: 0, background: 'var(--bg-panel)', overflowX: 'auto', scrollbarWidth: 'none' }}>
        <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Expiry</span>
        {expiries.length === 0
          ? <span style={{ fontSize: 11, color: '#3D4150' }}>No expiries found for {underlying}</span>
          : expiries.map(exp => (
            <button key={exp} onClick={() => { setSelectedExpiry(exp); shouldScrollToAtm.current = true; }} style={{
              padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600, border: '1px solid', cursor: 'pointer', whiteSpace: 'nowrap',
              background: selectedExpiry === exp ? 'rgba(249,115,22,0.15)' : 'transparent',
              borderColor: selectedExpiry === exp ? 'rgba(249,115,22,0.4)' : 'rgba(255,255,255,0.08)',
              color: selectedExpiry === exp ? '#f97316' : '#6B7280',
            }}>{fmtExpTs(exp)}</button>
          ))}
      </div>

      {/* Table */}
      <div className="oc-scroll" style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '60px', textAlign: 'center', fontSize: 13, color: '#3D4150' }}>
            {expiries.length === 0 ? `No MCX options found for "${underlying}"` : selectedExpiry ? 'Loading…' : 'Select expiry'}
          </div>
        ) : (
          <table style={{ width: totalWidth, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--bg-panel)' }}>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <th colSpan={visibleCeCols.length} style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#e0a800', letterSpacing: '0.08em', background: '#333333' }}>Call</th>
                <th style={{ textAlign: 'center', padding: '10px 0', fontSize: 12, fontWeight: 700, color: '#9CA3AF', background: '#333333' }}>Strike</th>
                <th colSpan={visiblePeCols.length} style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#818cf8', letterSpacing: '0.08em', background: '#333333' }}>Put</th>
              </tr>
              {table.getHeaderGroups().map(hg => (
                <tr key={hg.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {hg.headers.map(h => {
                    const id = h.column.id;
                    const isStrike = id === 'mstrike';
                    const isCe = MCX_CE_COLS.includes(id);
                    return (
                      <th key={h.id} style={{ width: MW[id], minWidth: MW[id], padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase', textAlign: isStrike ? 'center' : isCe ? 'right' : 'left', background: isCe ? 'rgba(224,168,0,0.02)' : isStrike ? '#333333' : 'rgba(129,140,248,0.02)', whiteSpace: 'nowrap' }}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className="oc-tbody">
              {table.getRowModel().rows.map((row, ri) => {
                const data = row.original;
                const prevData = table.getRowModel().rows[ri - 1]?.original;
                const showAtmLine = data.isAtm && prevData && !prevData.isAtm;
                const isCeItm = spot > 0 && data.strike < spot;
                const isPeItm = spot > 0 && data.strike > spot;
                return (
                  <React.Fragment key={row.id}>
                    {showAtmLine && (
                      <tr>
                        <td colSpan={visibleCeCols.length} style={{ padding: '2px 0', borderTop: '1px dashed rgba(224,168,0,0.4)', background: 'rgba(224,168,0,0.03)' }} />
                        <td style={{ textAlign: 'center', padding: '2px 0', fontSize: 11, fontWeight: 800, color: '#e0a800', borderTop: '1px dashed rgba(224,168,0,0.4)', background: 'rgba(224,168,0,0.03)' }}>{atmStrike ?? ''}</td>
                        <td colSpan={visiblePeCols.length} style={{ padding: '2px 0', borderTop: '1px dashed rgba(224,168,0,0.4)', background: 'rgba(224,168,0,0.03)' }} />
                      </tr>
                    )}
                    <tr className={`oc-row ${data.isAtm ? 'oc-row-atm' : ri % 2 === 0 ? 'oc-row-even' : 'oc-row-odd'}`}
                      ref={data.isAtm ? atmRowRef : undefined}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.10)' }}
                      onMouseMove={e => {
                        if (popup) return;
                        const tr = e.currentTarget;
                        const strikeTd = tr.querySelector('td[data-col="mstrike"]') as HTMLElement | null;
                        if (!strikeTd) return;
                        const strikeR = strikeTd.getBoundingClientRect();
                        if (e.clientX >= strikeR.left && e.clientX <= strikeR.right) { hideOverlay(); return; }
                        const side = e.clientX < strikeR.left ? 'CE' : 'PE';
                        const ceLtpTd = strikeTd.previousElementSibling as HTMLElement | null;
                        const peLtpTd = strikeTd.nextElementSibling as HTMLElement | null;
                        const ceR = ceLtpTd?.getBoundingClientRect();
                        const peR = peLtpTd?.getBoundingClientRect();
                        const trR = tr.getBoundingClientRect();
                        if (!ceR || !peR) return;
                        showOverlay(trR.top, ceR.left, ceR.width, peR.left, peR.width, trR.height, {
                          strike: data.strike, ceLtp: data.ce.ltp, peLtp: data.pe.ltp, ceKey: data.ceKey, peKey: data.peKey,
                          ceGreeks: { delta: data.ce.delta, theta: data.ce.theta, vega: data.ce.vega, gamma: data.ce.gamma, iv: data.ce.iv },
                          peGreeks: { delta: data.pe.delta, theta: data.pe.theta, vega: data.pe.vega, gamma: data.pe.gamma, iv: data.pe.iv }
                        }, side);
                      }}
                      onMouseLeave={e => { const rel = e.relatedTarget as HTMLElement | null; if (rel instanceof HTMLElement && (rel.closest('.oc-bs-overlay') || rel.closest('.oc-row'))) return; hideOverlay(); }}
                    >
                      {row.getVisibleCells().map(cell => {
                        const id = cell.column.id;
                        const isStrike = id === 'mstrike';
                        const isCe = MCX_CE_COLS.includes(id);
                        const cellBg = isCe && isCeItm ? 'rgba(0,168,132,0.18)' : !isCe && !isStrike && isPeItm ? 'rgba(210,130,0,0.28)' : undefined;
                        return (
                          <td key={cell.id} data-col={id} className={isStrike ? 'oc-strike-cell' : ''} style={{ width: MW[id], minWidth: MW[id], padding: '8px 10px', fontSize: 13, fontWeight: id === 'mstrike' ? 700 : 500, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', textAlign: isStrike ? 'center' : isCe ? 'right' : 'left', whiteSpace: 'nowrap', ...(cellBg ? { background: cellBg } : isStrike ? { background: '#333333' } : {}) }}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div ref={ceOverlayRef} className="oc-bs-overlay" style={{ display: 'none', position: 'fixed', left: 0, top: 0, pointerEvents: 'none' }}>
        <button className="oc-btn oc-btn-b" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'CE', action: 'B', price: d.ceLtp, instrumentKey: d.ceKey, greeks: d.ceGreeks }); }}>B</button>
        <button className="oc-btn oc-btn-s" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'CE', action: 'S', price: d.ceLtp, instrumentKey: d.ceKey, greeks: d.ceGreeks }); }}>S</button>
      </div>
      <div ref={peOverlayRef} className="oc-bs-overlay" style={{ display: 'none', position: 'fixed', left: 0, top: 0, pointerEvents: 'none' }}>
        <button className="oc-btn oc-btn-b" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'PE', action: 'B', price: d.peLtp, instrumentKey: d.peKey, greeks: d.peGreeks }); }}>B</button>
        <button className="oc-btn oc-btn-s" style={{ pointerEvents: 'auto' }} onMouseDown={e => { e.stopPropagation(); const d = overlayDataRef.current; if (!d) return; const r = (e.target as HTMLElement).getBoundingClientRect(); hideOverlay(); setQty(1); setPopup({ x: r.left + r.width / 2, y: r.bottom + 6, strike: d.strike, type: 'PE', action: 'S', price: d.peLtp, instrumentKey: d.peKey, greeks: d.peGreeks }); }}>S</button>
      </div>

      {/* Qty popup — same as Nubra */}
      {popup && (() => {
        const isBuy = popup.action === 'B';
        const accentColor = isBuy ? '#26a69a' : '#f23645';
        const accentBg = isBuy ? 'rgba(38,166,154,0.12)' : 'rgba(242,54,69,0.12)';
        const accentBorder = isBuy ? 'rgba(38,166,154,0.4)' : 'rgba(242,54,69,0.4)';
        return (
          <div ref={popupRef} style={{ position: 'fixed', left: popup.x, top: popup.y, transform: 'translateX(-50%)', zIndex: 9999, background: '#1a1a1a', border: `1px solid ${accentBorder}`, borderRadius: 10, padding: '10px 12px', boxShadow: '0 8px 32px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220, maxHeight: 'calc(100vh - 40px)', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ padding: '2px 8px', borderRadius: 5, background: accentBg, border: `1px solid ${accentBorder}` }}><span style={{ fontSize: 12, fontWeight: 800, color: accentColor }}>{popup.action === 'B' ? 'BUY' : 'SELL'}</span></div>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa' }}>{popup.strike}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: popup.type === 'CE' ? '#facc15' : '#c084fc' }}>{popup.type}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4B5563', padding: 0, display: 'flex' }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
            <div style={{ fontSize: 11, color: '#4B5563' }}>@ <span style={{ color: '#E2E8F0', fontWeight: 600 }}>₹{popup.price.toFixed(2)}</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 600, flex: 1 }}>Qty</span>
              <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, overflow: 'hidden' }}>
                <button onClick={() => setQty(q => Math.max(1, q - 1))} style={{ width: 26, height: 26, background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                <input type="number" value={qty} min={1} onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setQty(v); }} onBlur={e => { const v = parseInt(e.target.value); setQty(isNaN(v) || v < 1 ? 1 : v); }} style={{ width: 54, textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#E2E8F0', background: 'transparent', border: 'none', outline: 'none', MozAppearance: 'textfield' }} />
                <button onClick={() => setQty(q => q + 1)} style={{ width: 26, height: 26, background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
              </div>
            </div>
            {isHistoricalMode && (
              <CalendarPicker
                date={entryDate}
                time={entryTime}
                onDateChange={setEntryDate}
                onTimeChange={setEntryTime}
              />
            )}
            <button disabled={fetching} onClick={async () => {
              if (!isHistoricalMode) {
                const expStr = selectedExpiry ? String(selectedExpiry) : '';
                onAddLeg?.({ symbol, expiry: expStr, strike: popup.strike, type: popup.type, action: popup.action, price: popup.price, lots: qty, lotSize: effLotSize, instrumentKey: popup.instrumentKey ?? undefined, greeks: popup.greeks, entryDate, entryTime });
                setPopup(null);
                return;
              }

              const fetchClose = async (instrumentKey: string | null): Promise<number | null> => {
                if (!instrumentKey) return null;
                const fromMs = new Date(`${entryDate}T${entryTime}:00+05:30`).getTime();
                const params = new URLSearchParams({
                  instrumentKey,
                  interval: 'I1',
                  from: String(fromMs),
                  limit: '500',
                });
                const res = await fetch(`/api/public-candles?${params}`);
                if (!res.ok) return null;
                const json = await res.json();
                const candles: number[][] = json?.data?.candles ?? [];
                if (!candles.length) return null;
                let best = candles[0];
                let bestDiff = Math.abs(candles[0][0] - fromMs);
                for (const c of candles) {
                  const diff = Math.abs(c[0] - fromMs);
                  if (diff < bestDiff) { bestDiff = diff; best = c; }
                }
                return best[4];
              };

              setFetching(true);
              try {
                const [optClose, spotClose] = await Promise.all([
                  fetchClose(popup.instrumentKey ?? null),
                  fetchClose(spotKey ?? null),
                ]);
                const expStr = selectedExpiry ? String(selectedExpiry) : '';
                const entryPrice = optClose ?? popup.price;
                const entrySpotPrice = spotClose ?? spot;
                onAddLeg?.({ symbol, expiry: expStr, strike: popup.strike, type: popup.type, action: popup.action, price: entryPrice, lots: qty, lotSize: effLotSize, instrumentKey: popup.instrumentKey ?? undefined, greeks: popup.greeks, entryDate, entryTime, entrySpot: entrySpotPrice });
                setPopup(null);
              } catch {
                const expStr = selectedExpiry ? String(selectedExpiry) : '';
                onAddLeg?.({ symbol, expiry: expStr, strike: popup.strike, type: popup.type, action: popup.action, price: popup.price, lots: qty, lotSize: effLotSize, instrumentKey: popup.instrumentKey ?? undefined, greeks: popup.greeks, entryDate, entryTime });
                setPopup(null);
              } finally {
                setFetching(false);
              }
            }} style={{ padding: '6px 0', borderRadius: 7, background: fetching ? 'rgba(255,255,255,0.05)' : accentBg, border: `1px solid ${accentBorder}`, color: fetching ? '#6B7280' : accentColor, fontSize: 12, fontWeight: 700, cursor: fetching ? 'not-allowed' : 'pointer', letterSpacing: '0.04em' }}>{fetching ? 'Fetching price…' : 'Add to Basket'}</button>
          </div>
        );
      })()}
    </div>
  );
}

// ── Dispatcher — routes MCX to Upstox panel, rest to Nubra ───────────────────
export default function OptionChain({ symbol, expiries, sessionToken, exchange = 'NSE', onClose, onAddLeg, onLtpUpdateRef, lotSize = 1, instruments = [], ocSpotRef, isHistoricalMode, spotRefId }: {
  symbol: string;
  expiries: (string | number)[];
  sessionToken: string;
  exchange?: string;
  onClose: () => void;
  onAddLeg?: (leg: AddLegPayload) => void;
  onLtpUpdateRef?: React.MutableRefObject<((ltpMap: Map<number, { ce: number; pe: number; ceGreeks: { delta: number; theta: number; vega: number; gamma: number; iv: number }; peGreeks: { delta: number; theta: number; vega: number; gamma: number; iv: number } }>, spot: number, expiry: string) => void) | null>;
  lotSize?: number;
  instruments?: Instrument[];
  ocSpotRef?: { current: number };
  isHistoricalMode?: boolean;
  spotRefId?: string;
}) {
  if (exchange === 'MCX') {
    return <OptionChainMCX symbol={symbol} instruments={instruments} onClose={onClose} onAddLeg={onAddLeg} lotSize={lotSize} ocSpotRef={ocSpotRef} isHistoricalMode={isHistoricalMode} />;
  }
  return <OptionChainNubra symbol={symbol} expiries={expiries} sessionToken={sessionToken} exchange={exchange} onClose={onClose} onAddLeg={onAddLeg} onLtpUpdateRef={onLtpUpdateRef} lotSize={lotSize} isHistoricalMode={isHistoricalMode} spotRefId={spotRefId} />;
}
