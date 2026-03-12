'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo, useDeferredValue, startTransition } from 'react';
import { useInstruments, type Instrument } from './useInstruments';
import { loadNubraInstruments, clearNubraInstruments, saveNubraInstruments } from './db';
import type { NubraInstrument } from './useNubraInstruments';
import OptionChain from './OptionChain';
import BasketOrder, { type BasketLeg, DomSidePanel } from './BasketOrder';
import StrategyChart from './StrategyChart';
import LoadingScreen from './LoadingScreen';
import StraddleChart from './StraddleChart';
import OIProfileView from './OIProfileView';
import { WorkspaceRoot } from './workspace/WorkspaceRoot';
import { useWorkspaceState } from './workspace/useWorkspaceState';
import NubraApiTester from './NubraApiTester';
import Backtest from './Backtest';
import HistoricalWorkspace from './HistoricalWorkspace';
import { wsManager } from './lib/WebSocketManager';
import { useWsConnected } from './hooks/useMarketData';
import { cx } from './lib/utils';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
} from './components/ui/sidebar';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import './index.css';

function isMarketOpen(): boolean {
  const now = new Date();
  const istMin = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + 330) % 1440;
  const istDay = new Date(now.getTime() + 330 * 60000);
  if ([0, 6].includes(istDay.getUTCDay())) return false;
  return istMin >= 9 * 60 + 15 && istMin < 15 * 60 + 30;
}

type Page = 'chart' | 'straddle' | 'oiprofile' | 'nubra' | 'backtest' | 'historical' | 'mtm';
type Tab = 'ALL' | 'Cash' | 'F&O' | 'Currency' | 'Commodity';

const TABS: Tab[] = ['ALL', 'Cash', 'F&O', 'Currency', 'Commodity'];

function filterByTab(instruments: Instrument[], tab: Tab): Instrument[] {
  if (tab === 'ALL') return instruments;
  if (tab === 'Cash') return instruments.filter(i => i.instrument_type === 'EQ');
  if (tab === 'F&O') return instruments.filter(i => i.segment === 'NSE_FO' || i.segment === 'BSE_FO');
  if (tab === 'Currency') return instruments.filter(i => i.segment === 'NCD_FO' || i.asset_type === 'CUR');
  if (tab === 'Commodity') return instruments.filter(i => i.asset_type === 'COM' || i.segment?.includes('MCX') || i.segment === 'NSE_COM' || i.exchange === 'MCX');
  return instruments;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color: '#FF9800', fontWeight: 600 }}>{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────
function IconSearch() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>;
}
function IconClose() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
function IconBolt() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>;
}
function IconApi() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>;
}
function IconCookie() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="15" cy="9" r="1" fill="currentColor" /><circle cx="9" cy="15" r="1" fill="currentColor" /></svg>;
}

// ── Page nav items ────────────────────────────────────────────────────────────
// Charts — candlestick bars
function IconBarChart2() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
// Straddle — stacked layers (options spread)
function IconLayers() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
// OI Profile — pulse/waveform (open interest activity)
function IconActivity() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
// Nubra IV — beaker/flask (implied volatility lab)
function IconFlask() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6" />
      <path d="M10 3v7l-4 8a1 1 0 0 0 .9 1.45h10.2a1 1 0 0 0 .9-1.45L14 10V3" />
    </svg>
  );
}
// Backtest — play button inside circle (run simulation)
function IconClock() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" />
    </svg>
  );
}
// Historical — calendar with clock (historical data)
function IconHistory() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <polyline points="9 16 12 14 12 18" />
    </svg>
  );
}

// MTM Analyzer icon
function IconTrendingUp() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 16 16" fill="none">
      <path fillRule="evenodd" clipRule="evenodd" d="M2.36426 7.95608C2.36426 7.76678 2.51777 7.61328 2.70712 7.61328H3.05582C3.24517 7.61328 3.39867 7.76678 3.39867 7.95608C3.39867 8.14548 3.24517 8.29898 3.05582 8.29898H2.70712C2.51777 8.29898 2.36426 8.14548 2.36426 7.95608ZM3.63963 7.95608C3.63963 7.76678 3.79313 7.61328 3.98249 7.61328H4.67988C4.86923 7.61328 5.02274 7.76678 5.02274 7.95608C5.02274 8.14548 4.86923 8.29898 4.67988 8.29898H3.98249C3.79313 8.29898 3.63963 8.14548 3.63963 7.95608ZM5.26369 7.95608C5.26369 7.76678 5.4172 7.61328 5.60655 7.61328H6.30394C6.49328 7.61328 6.64678 7.76678 6.64678 7.95608C6.64678 8.14548 6.49328 8.29898 6.30394 8.29898H5.60655C5.4172 8.29898 5.26369 8.14548 5.26369 7.95608ZM6.88778 7.95608C6.88778 7.76678 7.04128 7.61328 7.23058 7.61328H7.92798C8.11738 7.61328 8.27088 7.76678 8.27088 7.95608C8.27088 8.14548 8.11738 8.29898 7.92798 8.29898H7.23058C7.04128 8.29898 6.88778 8.14548 6.88778 7.95608ZM8.51178 7.95608C8.51178 7.76678 8.66528 7.61328 8.85468 7.61328H9.55208C9.74138 7.61328 9.89488 7.76678 9.89488 7.95608C9.89488 8.14548 9.74138 8.29898 9.55208 8.29898H8.85468C8.66528 8.29898 8.51178 8.14548 8.51178 7.95608ZM10.1359 7.95608C10.1359 7.76678 10.2894 7.61328 10.4788 7.61328H11.1761C11.3655 7.61328 11.519 7.76678 11.519 7.95608C11.519 8.14548 11.3655 8.29898 11.1761 8.29898H10.4788C10.2894 8.29898 10.1359 8.14548 10.1359 7.95608ZM11.76 7.95608C11.76 7.76678 11.9135 7.61328 12.1028 7.61328H12.8002C12.9896 7.61328 13.1431 7.76678 13.1431 7.95608C13.1431 8.14548 12.9896 8.29898 12.8002 8.29898H12.1028C11.9135 8.29898 11.76 8.14548 11.76 7.95608ZM13.384 7.95608C13.384 7.76678 13.5375 7.61328 13.7269 7.61328H14.0756C14.2649 7.61328 14.4184 7.76678 14.4184 7.95608C14.4184 8.14548 14.2649 8.29898 14.0756 8.29898H13.7269C13.5375 8.29898 13.384 8.14548 13.384 7.95608Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M10.2382 3.31291C10.3093 3.1246 10.4896 3 10.6909 3H14.484C14.7514 3 14.9681 3.21671 14.9681 3.48403C14.9681 3.75136 14.7514 3.96807 14.484 3.96807H11.0255L7.76439 12.5963C7.69329 12.7847 7.51299 12.9093 7.31159 12.9093H2.48404C2.21671 12.9093 2 12.6925 2 12.4252C2 12.1579 2.21671 11.9412 2.48404 11.9412H6.97709L10.2382 3.31291Z" fill="currentColor" />
    </svg>
  );
}

function StatusDot({ status }: { status: 'ok' | 'warn' | 'indigo' | 'off' }) {
  const colors = {
    ok: 'bg-[#2ebd85] shadow-[0_0_5px_#2ebd85]',
    warn: 'bg-[#FF9800] shadow-[0_0_5px_#FF9800]',
    indigo: 'bg-[#818cf8] shadow-[0_0_5px_#818cf8] animate-pulse',
    off: 'bg-[#333333]',
  };
  return <span className={cx('inline-block w-1.5 h-1.5 rounded-full shrink-0', colors[status])} />;
}

function Btn({
  onClick, loading, children, variant = 'default', disabled, title,
}: {
  onClick?: () => void; loading?: boolean; children: React.ReactNode;
  variant?: 'default' | 'primary' | 'ghost' | 'green' | 'indigo' | 'amber';
  disabled?: boolean; title?: string;
}) {
  const base = 'inline-flex items-center gap-1.5 h-6 px-2.5 text-[11px] font-semibold tracking-[0.04em] border transition-colors duration-100 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    default: 'bg-transparent border-[#2a2a2a] text-[#787B86] hover:border-[#333333] hover:text-[#D1D4DC]',
    primary: 'bg-[rgba(255,152,0,0.85)] border-[rgba(255,152,0,0.5)] text-white hover:bg-[rgba(255,152,0,1)]',
    ghost: 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-400',
    green: 'bg-[rgba(46,189,133,0.08)] border-[rgba(46,189,133,0.4)] text-[#2ebd85] hover:bg-[rgba(46,189,133,0.15)]',
    indigo: 'bg-[rgba(129,140,248,0.08)] border-[rgba(129,140,248,0.35)] text-[#818cf8] hover:bg-[rgba(129,140,248,0.15)]',
    amber: 'bg-[rgba(255,152,0,0.10)] border-[rgba(255,152,0,0.45)] text-[#FF9800] hover:bg-[rgba(255,152,0,0.15)]',
  };
  return (
    <button onClick={onClick} disabled={disabled || loading} title={title} className={cx(base, variants[variant])}>
      {loading && <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />}
      {children}
    </button>
  );
}

function TextInput({ value, onChange, onEnter, onEscape, placeholder, autoFocus, width, type = 'text' }: {
  value: string; onChange: (v: string) => void; onEnter?: () => void; onEscape?: () => void;
  placeholder?: string; autoFocus?: boolean; width?: number | string; type?: string;
}) {
  return (
    <input
      type={type} value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') onEnter?.(); if (e.key === 'Escape') onEscape?.(); }}
      placeholder={placeholder} autoFocus={autoFocus}
      style={{ width }}
      className="h-6 px-2 text-[11px] bg-[#1f1f1f] border border-[#2a2a2a] text-[#D1D4DC] placeholder-[#4A4E5C] outline-none focus:border-[rgba(255,152,0,0.45)] transition-colors"
    />
  );
}

function TextAreaInput({ value, onChange, placeholder, autoFocus, width }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; width?: number | string;
}) {
  return (
    <textarea
      value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} autoFocus={autoFocus} rows={1}
      style={{ width, resize: 'none' }}
      className="px-2 py-1 text-[10px] bg-[#1f1f1f] border border-[#2a2a2a] text-[#D1D4DC] placeholder-[#4A4E5C] outline-none focus:border-[rgba(255,152,0,0.45)] transition-colors"
    />
  );
}

// Shows "Connecting…" for up to 8s, then "Token invalid" if still not connected
function WsStatus({ token }: { token: string }) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 20000);
    return () => { clearTimeout(t); setTimedOut(false); };
  }, [token]);
  return <>{timedOut ? <span className="text-red-400">Token expired — click Auto</span> : 'Connecting…'}</>;
}

// ── Leg type ──────────────────────────────────────────────────────────────────
interface Greeks { delta: number; theta: number; vega: number; gamma: number; iv: number; }
interface Leg {
  id: number;
  refId?: number;
  instrumentKey?: string; // Upstox instrument_key — used for MCX live LTP via wsManager
  exchange?: string;
  symbol: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  action: 'B' | 'S';
  lots: number;
  lotSize: number;     // contract lot size (e.g. 75 for NIFTY)
  price: number;       // entry LTP
  entrySpot: number;   // spot at time of entry
  entryTime: string;   // HH:MM:SS at time of entry
  entryDate: string;   // YYYY-MM-DD date of entry
  currLtp: number;     // live LTP (updated from OC feed)
  checked: boolean;    // include in MTM total
  entryGreeks: Greeks; // greeks at entry
  currGreeks: Greeks;  // live greeks
}

// ── MTM Analyzer layout (resizable 40/60 split) ──────────────────────────────
const columnHelper = createColumnHelper<Leg>();
const fmtG = (v: number, dec = 4) => v === 0 ? '—' : Math.abs(v) < 0.0001 ? v.toExponential(2) : parseFloat(v.toFixed(dec)).toString();
const fmtMtm = (v: number): string => {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1_00_00_00_00_000) return `${sign}₹${(abs / 1_00_00_00_00_000).toFixed(2)}LCr`;
  if (abs >= 1_00_00_00_000)    return `${sign}₹${(abs / 1_00_00_00_000).toFixed(2)}KCr`;
  if (abs >= 1_00_00_000)       return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000)          return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000)             return `${sign}₹${(abs / 1_000).toFixed(2)}K`;
  return `${sign}₹${abs.toFixed(2)}`;
};
const fmtExpiry = (e: string) => {
  if (e.length > 8) {
    // MCX: Unix ms timestamp string
    return new Date(Number(e)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  }
  // Nubra: YYYYMMDD
  return new Date(`${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
};
const greekItems: { key: keyof Greeks; label: string; name: string; color: string; dec: number }[] = [
  { key: 'delta', label: 'Δ', name: 'Delta', color: '#60a5fa', dec: 4 },
  { key: 'theta', label: 'Θ', name: 'Theta', color: '#f59e0b', dec: 2 },
  { key: 'vega',  label: 'V', name: 'Vega',  color: '#a78bfa', dec: 2 },
  { key: 'iv',    label: 'IV', name: 'IV',    color: '#34d399', dec: 2 },
  { key: 'gamma', label: 'Γ', name: 'Gamma', color: '#fb923c', dec: 5 },
];

// ── Theme 2: full flat TanStack table ─────────────────────────────────────────
const t2ColHelper = createColumnHelper<Leg>();


function MtmTheme2Table({ legs, updateLeg, removeLeg, showGreeks }: { legs: Leg[]; updateLeg: (id: number, patch: Partial<Leg>) => void; removeLeg: (id: number) => void; showGreeks: boolean }) {
  const allDefinedColumns = useMemo(() => [
    t2ColHelper.display({
      id: 'symbol', size: 80,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>Symbol</span>,
      cell: ({ row }) => {
        const leg = row.original;
        const symbolColors: Record<string, string> = { NIFTY: '#60a5fa', BANKNIFTY: '#a78bfa', FINNIFTY: '#34d399', SENSEX: '#fb923c' };
        const col = symbolColors[leg.symbol] ?? '#9CA3AF';
        return <span style={{ fontSize: 14, fontWeight: 800, color: col, letterSpacing: '0.02em' }}>{leg.symbol}</span>;
      },
    }),
    t2ColHelper.display({
      id: 'expiry', size: 76,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>Expiry</span>,
      cell: ({ row }) => <span style={{ fontSize: 13, color: '#C0C7D4', fontWeight: 500 }}>{fmtExpiry(row.original.expiry)}</span>,
    }),
    t2ColHelper.display({
      id: 'strike', size: 64,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>Strike</span>,
      cell: ({ row }) => <span style={{ fontSize: 14, fontWeight: 700, color: '#60a5fa', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{row.original.strike}</span>,
    }),
    t2ColHelper.display({
      id: 'type', size: 44,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>Type</span>,
      cell: ({ row }) => {
        const leg = row.original;
        return <span style={{ fontSize: 13, fontWeight: 700, color: leg.type === 'CE' ? '#26a69a' : '#f23645', background: leg.type === 'CE' ? 'rgba(38,166,154,0.1)' : 'rgba(242,54,69,0.1)', padding: '2px 6px', borderRadius: 4 }}>{leg.type}</span>;
      },
    }),
    // ── Buy columns ──────────────────────────────────────────────────────────
    t2ColHelper.display({
      id: 'buy_action', size: 52,
      header: () => <span style={{ fontSize: 12, color: '#26a69a', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>Side</span>,
      cell: ({ row }) => {
        const leg = row.original; const isBuy = leg.action === 'B';
        return (
          <div onClick={() => updateLeg(leg.id, { action: isBuy ? 'S' : 'B' })}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px', borderRadius: 4, background: isBuy ? 'rgba(38,166,154,0.15)' : 'rgba(242,54,69,0.15)', border: `1px solid ${isBuy ? 'rgba(38,166,154,0.5)' : 'rgba(242,54,69,0.5)'}`, cursor: 'pointer' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: isBuy ? '#26a69a' : '#f23645' }}>{isBuy ? 'Buy' : 'Sell'}</span>
          </div>
        );
      },
    }),
    t2ColHelper.display({
      id: 'lots', size: 80,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>Lots</span>,
      cell: ({ row }) => (
        <input
          type="number"
          min={1}
          value={row.original.lots}
          onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) updateLeg(row.original.id, { lots: v }); }}
          style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4, height: 24, textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#E2E8F0', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', outline: 'none', padding: '0 4px', MozAppearance: 'textfield' } as React.CSSProperties}
        />
      ),
    }),
    t2ColHelper.display({
      id: 'price', size: 72,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>Price</span>,
      cell: ({ row }) => <span style={{ fontSize: 15, fontWeight: 600, color: '#D1D4DC', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>₹{row.original.price.toFixed(2)}</span>,
    }),
    t2ColHelper.display({
      id: 'ltp', size: 72,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>LTP</span>,
      cell: ({ row }) => {
        const ltp = row.original.currLtp > 0 ? row.original.currLtp : row.original.price;
        const diff = ltp - row.original.price;
        const col = diff > 0 ? '#26a69a' : diff < 0 ? '#f23645' : '#E2E8F0';
        return <span style={{ fontSize: 15, fontWeight: 700, color: col, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>₹{ltp.toFixed(2)}</span>;
      },
    }),
    t2ColHelper.display({
      id: 'spot', size: 72,
      header: () => <span style={{ fontSize: 12, color: '#e0a800', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>E.Spot</span>,
      cell: ({ row }) => <span style={{ fontSize: 13, fontWeight: 600, color: '#e0a800', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{row.original.entrySpot > 0 ? row.original.entrySpot.toFixed(2) : '—'}</span>,
    }),
    t2ColHelper.display({
      id: 'time', size: 68,
      header: () => <span style={{ fontSize: 12, color: '#a78bfa', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>E.Time</span>,
      cell: ({ row }) => <span style={{ fontSize: 13, fontWeight: 500, color: '#a78bfa' }}>{row.original.entryTime}</span>,
    }),
    t2ColHelper.display({
      id: 'entry_date', size: 84,
      header: () => <span style={{ fontSize: 12, color: '#a78bfa', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>E.Date</span>,
      cell: ({ row }) => {
        const d = row.original.entryDate;
        if (!d) return <span style={{ fontSize: 13, fontWeight: 500, color: '#a78bfa' }}>—</span>;
        const dt = new Date(`${d}T00:00:00Z`);
        const fmt = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
        return <span style={{ fontSize: 13, fontWeight: 500, color: '#a78bfa' }}>{fmt}</span>;
      },
    }),
    t2ColHelper.display({
      id: 'mtm', size: 96,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em' }}>MTM</span>,
      cell: ({ row }) => {
        const leg = row.original;
        const currLtp = leg.currLtp > 0 ? leg.currLtp : leg.price;
        const mtm = (leg.action === 'B' ? currLtp - leg.price : leg.price - currLtp) * leg.lots * (leg.lotSize || 1);
        const pos = mtm >= 0;
        const fmt = fmtMtm(mtm);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 0, whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: pos ? '#26a69a' : '#f23645', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', lineHeight: 1, whiteSpace: 'nowrap' }}>{fmt}</span>
          </div>
        );
      },
    }),
    // ── Greeks: 3 columns per greek (Entry | Live | Chg) ────────────────────
    ...greekItems.flatMap((gk, gi) => {
      const isLast = gi === greekItems.length - 1;
      const groupBorder = !isLast ? '2px solid rgba(255,255,255,0.10)' : 'none';
      const hdr = (label: string) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
            <span style={{ fontSize: 13, color: gk.color, fontWeight: 800 }}>{gk.label}</span>
            <span style={{ fontSize: 11, color: '#D1D5DB', fontWeight: 600, textTransform: 'capitalize', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>{gk.name}</span>
          </div>
          <span style={{ fontSize: 11, color: 'rgba(209,213,219,0.7)', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'capitalize' }}>{label}</span>
        </div>
      );
      return [
        t2ColHelper.display({
          id: `greek_${gk.key}_entry`, size: 60,
          header: () => hdr('Entry'),
          cell: ({ row }) => {
            const leg = row.original;
            const sign = leg.action === 'S' ? -1 : 1;
            const isIv = gk.key === 'iv';
            const ivScale = isIv && !leg.instrumentKey ? 100 : 1;
            const lots = leg.lots || 1;
            const val = isIv ? leg.entryGreeks[gk.key] * ivScale : sign * leg.entryGreeks[gk.key] * lots;
            return <span style={{ fontSize: 13, fontWeight: 600, color: '#9CA3AF' }}>{fmtG(val, gk.dec)}{isIv ? '%' : ''}</span>;
          },
        }),
        t2ColHelper.display({
          id: `greek_${gk.key}_live`, size: 60,
          header: () => hdr('Live'),
          cell: ({ row }) => {
            const leg = row.original;
            const sign = leg.action === 'S' ? -1 : 1;
            const isIv = gk.key === 'iv';
            const ivScale = isIv && !leg.instrumentKey ? 100 : 1;
            const lots = leg.lots || 1;
            const val = isIv ? leg.currGreeks[gk.key] * ivScale : sign * leg.currGreeks[gk.key] * lots;
            return <span style={{ fontSize: 14, fontWeight: 800, color: gk.color }}>{fmtG(val, gk.dec)}{isIv ? '%' : ''}</span>;
          },
        }),
        t2ColHelper.display({
          id: `greek_${gk.key}_chg`, size: 56,
          header: () => hdr('Chg'),
          cell: ({ row }) => {
            const leg = row.original;
            const sign = leg.action === 'S' ? -1 : 1;
            const isIv = gk.key === 'iv';
            const ivScale = isIv && !leg.instrumentKey ? 100 : 1;
            const lots = leg.lots || 1;
            const curr  = isIv ? leg.currGreeks[gk.key] * ivScale  : sign * leg.currGreeks[gk.key] * lots;
            const entry = isIv ? leg.entryGreeks[gk.key] * ivScale : sign * leg.entryGreeks[gk.key] * lots;
            const chg = curr - entry;
            const col = chg > 0 ? '#26a69a' : chg < 0 ? '#f23645' : '#6B7280';
            const sfx = isIv ? '%' : '';
            return (
              <span style={{ fontSize: 13, fontWeight: 700, color: col, borderRight: groupBorder, paddingRight: !isLast ? 6 : 0, display: 'block' }}>
                {entry !== 0 ? `${chg >= 0 ? '+' : ''}${parseFloat(chg.toFixed(gk.dec))}${sfx}` : '—'}
              </span>
            );
          },
        }),
      ];
    }),
    t2ColHelper.display({
      id: 'delete', size: 30,
      header: () => <span />,
      cell: ({ row }) => (
        <button onClick={() => removeLeg(row.original.id)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#4B5563', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 3, borderRadius: 4, margin: 'auto' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#f23645')}
          onMouseLeave={e => (e.currentTarget.style.color = '#4B5563')}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>
        </button>
      ),
    }),
  ], [updateLeg, removeLeg]);

  // Greeks mode: show only check + symbol/expiry/strike/type + greeks + delete
  // Normal mode: show everything except greek_ columns
  const GREEK_VISIBLE_IDS = new Set(['symbol', 'expiry', 'strike', 'type', 'delete']);
  const columns = useMemo(
    () => allDefinedColumns.filter(c => {
      const id = (c as any).id as string;
      if (showGreeks) return GREEK_VISIBLE_IDS.has(id) || id.startsWith('greek_');
      return !id.startsWith('greek_');
    }),
    [allDefinedColumns, showGreeks]
  );

  const table = useReactTable({ data: legs, columns, getCoreRowModel: getCoreRowModel() });

  const totalMtm = legs.filter(l => l.checked).reduce((sum, leg) => {
    const currLtp = leg.currLtp > 0 ? leg.currLtp : leg.price;
    return sum + (leg.action === 'B' ? currLtp - leg.price : leg.price - currLtp) * leg.lots * (leg.lotSize || 1);
  }, 0);
  const totalColor = totalMtm >= 0 ? '#26a69a' : '#f23645';

  const allCols    = table.getAllColumns();
  const detailCols = allCols.filter(c => ['buy_action','lots','price','ltp'].includes(c.id));
  const pnlCols    = allCols.filter(c => ['spot','time','entry_date','mtm','delete'].includes(c.id));
  const greekCols  = allCols.filter(c => c.id.startsWith('greek_'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '0 6px 6px' }}>
      {/* Total MTM bar */}
      {legs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '5px 14px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 600, letterSpacing: '0.06em', fontFamily: 'var(--font-family-sans)' }}>Total MTM</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: totalColor, fontFamily: 'var(--font-family-sans)' }}>{fmtMtm(totalMtm)}</span>
        </div>
      )}
      {/* sticky cols: check=30, symbol=80, expiry=76, strike=64, type=44 → cumulative lefts */}
      <div style={{ flexShrink: 0, overflowX: 'auto', overflowY: 'visible', scrollbarWidth: 'thin', scrollbarColor: '#4F8EF7 #1a1a1a', padding: '8px 10px' }}>
      {(() => {
        const STICKY_IDS = ['symbol','expiry','strike','type'];
        const STICKY_SIZES: Record<string,number> = { symbol:80, expiry:76, strike:64, type:44 };
        // build cumulative left offsets
        const stickyLeft: Record<string,number> = {};
        let acc = 0;
        for (const id of STICKY_IDS) { stickyLeft[id] = acc; acc += STICKY_SIZES[id]; }

        const stickyThStyle = (id: string, bg: string, extraBorder?: string): React.CSSProperties => ({
          position: 'sticky', left: stickyLeft[id], zIndex: 4,
          background: bg, whiteSpace: 'nowrap',
          boxShadow: id === 'type' ? '4px 0 8px rgba(0,0,0,0.35)' : undefined,
          borderLeft: extraBorder ?? 'none',
        });
        const stickyTdStyle = (id: string, rowBg: string): React.CSSProperties => ({
          position: 'sticky', left: stickyLeft[id], zIndex: 2,
          background: rowBg,
          boxShadow: id === 'type' ? '4px 0 8px rgba(0,0,0,0.35)' : undefined,
        });

        // compute sticky col count from visible cols
        const visibleStickyIds = STICKY_IDS.filter(id => allCols.find(c => c.id === id));
        const stickySpan = visibleStickyIds.length;
        // compute exact pixel width of all sticky cols combined
        const stickyTotalW = visibleStickyIds.reduce((s, id) => s + STICKY_SIZES[id], 0);

        return (
          <div style={{ display: 'contents' }}>
            <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: 'max-content' }}>
              <colgroup>
                {allCols.map(col => (
                  <col key={col.id} style={{ width: STICKY_IDS.includes(col.id) ? STICKY_SIZES[col.id] : col.getSize() }} />
                ))}
              </colgroup>
              <thead style={{ position: 'sticky', top: 0, zIndex: 5 }}>
                {/* ── Super-header row ── */}
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {/* Position: sticky th spanning all sticky cols, width forced to exact pixel sum */}
                  <th colSpan={stickySpan} style={{ position: 'sticky', left: 0, zIndex: 5, width: stickyTotalW, minWidth: stickyTotalW, textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#9CA3AF', letterSpacing: '0.08em', background: '#333333' }}>Position</th>
                  {!showGreeks && <th colSpan={detailCols.length} style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#e0a800', background: '#333333', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>Buy / Sell</th>}
                  {!showGreeks && <th colSpan={pnlCols.length} style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#818cf8', background: '#333333', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>P&L</th>}
                  {greekCols.length > 0 && <th colSpan={greekCols.length} style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 800, color: '#34d399', background: '#333333', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>Greeks</th>}
                </tr>
                {/* ── Sub-header row ── */}
                {table.getHeaderGroups().map(hg => (
                  <tr key={hg.id} style={{ borderBottom: '2px solid rgba(255,255,255,0.12)' }}>
                    {hg.headers.map(h => {
                      const id = h.column.id;
                      const isSticky = STICKY_IDS.includes(id);
                      const sectionBg = '#333333';
                      const isFirstDetail = id === 'buy_action';
                      const isFirstEnd    = id === 'spot';
                      const isGreekGroupStartH = id.endsWith('_entry') && id.startsWith('greek_');
                      const needsLeftBorder = showGreeks ? isGreekGroupStartH : (isFirstDetail || isFirstEnd);
                      const borderL = needsLeftBorder ? '2px solid rgba(255,255,255,0.18)' : 'none';
                      if (isSticky) {
                        return (
                          <th key={h.id} style={{ ...stickyThStyle(id, '#333333', borderL), padding: '8px 8px', textAlign: 'left', fontSize: 13 }}>
                            {flexRender(h.column.columnDef.header, h.getContext())}
                          </th>
                        );
                      }
                      return (
                        <th key={h.id} style={{ padding: '8px 8px', textAlign: 'left', background: sectionBg, borderLeft: borderL, whiteSpace: 'nowrap', fontSize: 13 }}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {legs.length === 0 ? (
                  <tr>
                    <td colSpan={allCols.length} style={{ padding: '32px 16px', textAlign: 'center', color: '#3D4150', fontSize: 14 }}>
                      No legs yet — click B or S on the option chain to add
                    </td>
                  </tr>
                ) : (() => {
                  const rows = table.getRowModel().rows;
                  const symbolColors: Record<string, { accent: string }> = {
                    NIFTY: { accent: '#60a5fa' }, BANKNIFTY: { accent: '#a78bfa' },
                    FINNIFTY: { accent: '#34d399' }, SENSEX: { accent: '#fb923c' },
                  };

                  const renderNetRow = (symLegs: Leg[], key: string, labelText = 'Net Greeks', labelColor = '#D1D5DB', bg = '#1e1e1e', rowStyle: React.CSSProperties = {}) => {
                    const checked = symLegs.filter(l => l.checked);
                    const totals: Record<string, { entry: number; live: number }> = {};
                    greekItems.filter(g => g.key !== 'iv').forEach(g => {
                      totals[g.key] = {
                        entry: checked.reduce((s, l) => s + (l.action === 'S' ? -1 : 1) * l.entryGreeks[g.key] * (l.lots || 1), 0),
                        live:  checked.reduce((s, l) => s + (l.action === 'S' ? -1 : 1) * l.currGreeks[g.key] * (l.lots || 1), 0),
                      };
                    });
                    const baseStyle: React.CSSProperties = { padding: '8px 10px', fontSize: 13, fontWeight: 700, verticalAlign: 'middle', whiteSpace: 'nowrap', borderTop: '1px solid rgba(255,255,255,0.1)' };
                    return (
                      <tr key={`net-${key}`} style={{ background: bg, ...rowStyle }}>
                        {table.getVisibleLeafColumns().map(col => {
                          const id = col.id;
                          const isSticky = STICKY_IDS.includes(id);
                          const isGreekGroupStart = id.endsWith('_entry') && id.startsWith('greek_');
                          const borderL = isGreekGroupStart ? '2px solid rgba(255,255,255,0.18)' : '1px solid rgba(255,255,255,0.05)';
                          if (isSticky) {
                            const label = id === 'symbol' ? <span style={{ fontSize: 11, fontWeight: 700, color: labelColor, letterSpacing: '0.06em', fontFamily: 'var(--font-family-sans)' }}>{labelText}</span> : null;
                            return <td key={id} style={{ ...stickyTdStyle(id, bg), ...baseStyle }}>{label}</td>;
                          }
                          if (id.startsWith('greek_') && id.endsWith('_entry')) {
                            const k = id.replace('greek_', '').replace('_entry', '') as keyof Greeks;
                            if (k === 'iv') return <td key={id} style={{ ...baseStyle, borderLeft: borderL, background: bg, color: '#4B5563' }}>—</td>;
                            const gk = greekItems.find(g => g.key === k)!;
                            const v = totals[k]?.entry ?? 0;
                            return <td key={id} style={{ ...baseStyle, borderLeft: borderL, background: bg, color: '#9CA3AF' }}>{fmtG(v, gk.dec)}</td>;
                          }
                          if (id.startsWith('greek_') && id.endsWith('_live')) {
                            const k = id.replace('greek_', '').replace('_live', '') as keyof Greeks;
                            if (k === 'iv') return <td key={id} style={{ ...baseStyle, background: bg, color: '#4B5563' }}>—</td>;
                            const gk = greekItems.find(g => g.key === k)!;
                            const v = totals[k]?.live ?? 0;
                            return <td key={id} style={{ ...baseStyle, background: bg, color: gk.color }}>{fmtG(v, gk.dec)}</td>;
                          }
                          if (id.startsWith('greek_') && id.endsWith('_chg')) {
                            const k = id.replace('greek_', '').replace('_chg', '') as keyof Greeks;
                            if (k === 'iv') return <td key={id} style={{ ...baseStyle, background: bg, color: '#4B5563' }}>—</td>;
                            const gk = greekItems.find(g => g.key === k)!;
                            const chg = (totals[k]?.live ?? 0) - (totals[k]?.entry ?? 0);
                            const chgColor = chg > 0 ? '#26a69a' : chg < 0 ? '#f23645' : '#6B7280';
                            return <td key={id} style={{ ...baseStyle, background: bg, color: chgColor }}>{chg === 0 ? '—' : fmtG(chg, gk.dec)}</td>;
                          }
                          return <td key={id} style={{ ...baseStyle, background: bg }} />;
                        })}
                      </tr>
                    );
                  };

                  const result: React.ReactNode[] = [];
                  // group rows by symbol
                  const groups: { sym: string; rows: typeof rows }[] = [];
                  rows.forEach(row => {
                    const sym = row.original.symbol;
                    if (!groups.length || groups[groups.length - 1].sym !== sym) groups.push({ sym, rows: [] });
                    groups[groups.length - 1].rows.push(row);
                  });
                  const uniqueSymbols = new Set(groups.map(g => g.sym));

                  let rowIndex = 0;
                  groups.forEach((grp, gi) => {
                    const accent = symbolColors[grp.sym]?.accent ?? '#9CA3AF';
                    result.push(
                      <tr key={`grp-${grp.sym}-${gi}`} style={{ background: '#1a1a1a' }}>
                        <td colSpan={allCols.length} style={{
                          padding: '5px 10px',
                          borderTop: gi > 0 ? '2px solid rgba(255,255,255,0.1)' : undefined,
                          borderBottom: '1px solid rgba(255,255,255,0.06)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 3, height: 14, borderRadius: 2, background: accent, flexShrink: 0 }} />
                            <span style={{ fontSize: 11, fontWeight: 800, color: accent, letterSpacing: '0.08em', fontFamily: 'var(--font-family-sans)' }}>{grp.sym}</span>
                          </div>
                        </td>
                      </tr>
                    );
                    grp.rows.forEach(row => {
                      const ri = rowIndex++;
                      const rowBg = ri % 2 === 0 ? '#1c1c1c' : '#171717';
                      result.push(
                        <tr key={row.id} style={{ opacity: row.original.checked ? 1 : 0.38, transition: 'opacity 0.2s' }}>
                          {row.getVisibleCells().map(cell => {
                            const id = cell.column.id;
                            const isSticky = STICKY_IDS.includes(id);
                            const isFirstDetail = id === 'buy_action';
                            const isFirstEnd    = id === 'spot';
                            const isGreekGroupStart = id.endsWith('_entry') && id.startsWith('greek_');
                            const needsCellBorder = showGreeks ? isGreekGroupStart : (isFirstDetail || isFirstEnd);
                            if (isSticky) {
                              return (
                                <td key={cell.id} style={{
                                  ...stickyTdStyle(id, rowBg),
                                  padding: '3px 6px',
                                  borderBottom: '1px solid rgba(255,255,255,0.07)',
                                  fontSize: 13, verticalAlign: 'middle',
                                }}>
                                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </td>
                              );
                            }
                            const isGreek = cell.column.id.startsWith('greek_');
                            return (
                              <td key={cell.id} style={{
                                padding: isGreek ? '9px 10px' : '4px 8px',
                                borderBottom: '1px solid rgba(255,255,255,0.07)',
                                borderLeft: needsCellBorder ? '2px solid rgba(255,255,255,0.18)' : '1px solid rgba(255,255,255,0.05)',
                                verticalAlign: 'middle', fontSize: 14,
                                background: rowBg,
                              }}>
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    });
                    // net row per group (always shown, shows MTM in normal mode, greeks in greek mode)
                    result.push(renderNetRow(grp.rows.map(r => r.original), `${grp.sym}-${gi}`));
                  });
                  if (showGreeks && uniqueSymbols.size > 1) {
                    const allLegs = groups.flatMap(g => g.rows.map(r => r.original));
                    result.push(renderNetRow(allLegs, `total`, 'Total Greeks', '#E5E7EB', '#242424', {
                      borderTop: '2px solid rgba(255,255,255,0.2)',
                      borderBottom: '2px solid rgba(255,255,255,0.16)',
                    }));
                  }
                  return result;
                })()}
              </tbody>
            </table>
          </div>
        );
      })()}
      </div>
    </div>
  );
}

function MtmGroupTable({ group, showGreeks, columns }: { group: { symbol: string; legs: Leg[] }, showGreeks: boolean, columns: any }) {
  const groupMtm = group.legs.filter(l => l.checked).reduce((sum, leg) => {
    const currLtp = leg.currLtp > 0 ? leg.currLtp : leg.price;
    const diff = currLtp - leg.price;
    return sum + (leg.action === 'B' ? diff : -diff) * leg.lots * (leg.lotSize || 1);
  }, 0);
  const mtmColor = groupMtm >= 0 ? '#26a69a' : '#f23645';
  const symbolColors: Record<string, { accent: string; bg: string }> = {
    NIFTY: { accent: '#60a5fa', bg: 'rgba(96,165,250,0.08)' },
    BANKNIFTY: { accent: '#a78bfa', bg: 'rgba(167,139,250,0.08)' },
    FINNIFTY: { accent: '#34d399', bg: 'rgba(52,211,153,0.08)' },
    SENSEX: { accent: '#fb923c', bg: 'rgba(251,146,60,0.08)' },
  };
  const sc = symbolColors[group.symbol] ?? { accent: '#9CA3AF', bg: 'rgba(255,255,255,0.04)' };

  const table = useReactTable({
    data: group.legs,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Instrument group header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 10, background: sc.bg, border: `1px solid ${sc.accent}1a`, margin: '4px 0' }}>
        <div style={{ width: 4, height: 20, borderRadius: 2, background: sc.accent, flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 800, color: sc.accent, letterSpacing: '0.04em' }}>{group.symbol}</span>
        <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 500, paddingLeft: 4 }}>{group.legs.length} leg{group.legs.length > 1 ? 's' : ''}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 16, fontWeight: 700, color: mtmColor, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{fmtMtm(groupMtm)}</span>
        <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 500, textTransform: 'capitalize', letterSpacing: '0.03em' }}>net mtm</span>
      </div>
      {/* TanStack Legs */}
      {showGreeks ? (
        table.getRowModel().rows.map(row => (
          <div key={row.id} style={{
            background: 'var(--bg-inset)',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.03)',
            display: 'flex',
            alignItems: 'stretch',
            opacity: row.original.checked ? 1 : 0.45,
            transition: 'opacity 0.2s',
          }}>
            {row.getVisibleCells().map(cell => (
              <React.Fragment key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </React.Fragment>
            ))}
          </div>
        ))
      ) : (
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 4px', tableLayout: 'fixed' }}>
          <colgroup>
            {table.getAllColumns().map(col => (
              <col key={col.id} style={{ width: col.getSize() }} />
            ))}
          </colgroup>
          <tbody>
            {table.getRowModel().rows.map(row => (
              <tr key={row.id} style={{ opacity: row.original.checked ? 1 : 0.45, transition: 'opacity 0.2s' }}>
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id} style={{ padding: '0 3px', verticalAlign: 'middle' }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MtmLayout({ visible, mtmResultsCbRef, mtmWorkerRef, mtmWorkerReady, instruments, nubraInstruments, onAddToBasket, execBasketRef, strategyInfoRef }: {
  visible: boolean;
  mtmResultsCbRef: React.RefObject<((results: Instrument[]) => void) | null>;
  mtmWorkerRef: React.RefObject<Worker | null>;
  mtmWorkerReady: React.RefObject<boolean>;
  instruments: Instrument[];
  nubraInstruments: NubraInstrument[];
  onAddToBasket?: (leg: BasketLeg) => void;
  execBasketRef?: React.RefObject<((legs: BasketLeg[], targetStrategy: number) => void) | null>;
  strategyInfoRef?: React.RefObject<{ count: number; names: Record<number, string>; active: number }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(48);
  const dragging = useRef(false);

  const [legs, setLegs] = useState<Leg[]>([]);
  const legIdRef = useRef(0);
  const ocSpotRef = useRef(0); // latest spot from option chain feed (last active OC)
  const spotBySymbolRef = useRef<Map<string, number>>(new Map()); // spot per symbol
  const spotWsRef = useRef<WebSocket | null>(null); // dedicated WS for per-symbol spot
  const currentLtpMapRef = useRef<Map<string, { ce: number; pe: number; ceGreeks: Greeks; peGreeks: Greeks }>>(new Map()); // key: `${expiry}:${strike}`
  const isHistoricalModeRef = useRef(false);
  const [showGreeks, setShowGreeks] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [cloudTab, setCloudTab] = useState<'import' | 'export'>('import');
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [cloudList, setCloudList] = useState<any[]>([]);
  const [cloudName, setCloudName] = useState('');
  const [toastOpen, setToastOpen] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutTheme, setLayoutTheme] = useState<'theme1' | 'theme2'>('theme1');
  const [isHistoricalMode, setIsHistoricalMode] = useState(false);
  isHistoricalModeRef.current = isHistoricalMode;
  const [strategyCount, setStrategyCount] = useState(3);
  const [activeStrategy, setActiveStrategy] = useState(1);
  const activeStrategyRef = useRef(1);
  activeStrategyRef.current = activeStrategy;
  const [strategyLegs, setStrategyLegs] = useState<Record<number, Leg[]>>({ 1: [], 2: [], 3: [] });
  const strategyLegsRef = useRef<Record<number, Leg[]>>({ 1: [], 2: [], 3: [] });
  strategyLegsRef.current = strategyLegs;
  const legsRef = useRef<Leg[]>([]);
  legsRef.current = legs;
  const [strategyNames, setStrategyNames] = useState<Record<number, string>>({ 1: 'Strategy 1', 2: 'Strategy 2', 3: 'Strategy 3' });
  const [renamingStrategy, setRenamingStrategy] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [ocSymbol, setOcSymbol] = useState('');
  const [ocAssetType, setOcAssetType] = useState<'INDEX_FO' | 'STOCK_FO' | ''>('');
  const [ocExchange, setOcExchange] = useState<string>('NSE');
  const ocExchangeRef = useRef(ocExchange);
  useEffect(() => { ocExchangeRef.current = ocExchange; }, [ocExchange]);
  const [chartSymbol, setChartSymbol] = useState('');
  const [chartExchange, setChartExchange] = useState<string>('NSE');

  useEffect(() => {
    if (legs.length === 0) return;
    if (chartSymbol !== legs[0].symbol) setChartSymbol(legs[0].symbol);
    if (legs[0].exchange && chartExchange !== legs[0].exchange) setChartExchange(legs[0].exchange);
    else if (!chartExchange) setChartExchange(ocExchangeRef.current);
  }, [legs, chartSymbol, chartExchange]);

  const fetchCloudList = useCallback(async () => {
    setCloudLoading(true);
    setCloudError('');
    try {
      const res = await fetch('/api/mtm-strategy/list');
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 200));
      const json = JSON.parse(text);
      setCloudList(Array.isArray(json) ? json : []);
    } catch (e: any) {
      setCloudError(e.message ?? 'Failed to load');
    } finally {
      setCloudLoading(false);
    }
  }, []);

  const handleExport = useCallback(async () => {
    if (legs.length === 0) { setCloudError('No legs to export'); return; }
    setCloudLoading(true);
    setCloudError('');
    try {
      const payload = {
        name: cloudName.trim() || (strategyNames[activeStrategy] ?? `Strategy ${activeStrategy}`),
        oc_symbol: chartSymbol || ocSymbol,
        oc_exchange: chartExchange || ocExchange,
        oc_asset_type: ocAssetType,
        legs,
      };
      const res = await fetch('/api/mtm-strategy/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 200));
      await fetchCloudList();
      setToastOpen(true);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToastOpen(false), 3500);
    } catch (e: any) {
      setCloudError(e.message ?? 'Export failed');
    } finally {
      setCloudLoading(false);
    }
  }, [legs, cloudName, strategyNames, activeStrategy, ocSymbol, ocExchange, ocAssetType, fetchCloudList]);

  const handleImportSelect = useCallback((item: any) => {
    const incoming: Leg[] = (item?.legs ?? []).map((l: any) => ({
      ...l,
      id: ++legIdRef.current,
    }));
    setStrategyLegs(prev => ({ ...prev, [activeStrategy]: incoming }));
    setLegs(incoming);
    setStrategyNames(prev => ({ ...prev, [activeStrategy]: item?.name ?? prev[activeStrategy] }));
    if (item?.oc_symbol) { setChartSymbol(item.oc_symbol); setOcSymbol(item.oc_symbol); }
    if (item?.oc_exchange) { setChartExchange(item.oc_exchange); setOcExchange(item.oc_exchange); }
    const firstEx = incoming[0]?.exchange;
    if (firstEx) setChartExchange(firstEx);
    if (item?.oc_asset_type) setOcAssetType(item.oc_asset_type);
    setCloudOpen(false);
  }, [activeStrategy]);

  const handleDeleteStrategy = useCallback(async (id?: string) => {
    if (!id) return;
    setCloudLoading(true);
    setCloudError('');
    try {
      const res = await fetch(`/api/mtm-strategy/delete?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 200));
      await fetchCloudList();
    } catch (e: any) {
      setCloudError(e.message ?? 'Delete failed');
    } finally {
      setCloudLoading(false);
    }
  }, [fetchCloudList]);
  // Keep strategyLegs in sync with current legs
  useEffect(() => {
    setStrategyLegs(prev => ({ ...prev, [activeStrategy]: legs }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs]);

  // Keep strategyInfoRef (read by App's picker modal) in sync — set on every render so it's always fresh
  if (strategyInfoRef) {
    strategyInfoRef.current = { count: strategyCount, names: strategyNames, active: activeStrategy };
  }


  // Register "add basket legs to MTM" function into execBasketRef so App can call it on Execute
  useEffect(() => {
    if (!execBasketRef) return;
    (execBasketRef as React.RefObject<((legs: BasketLeg[], targetStrategy: number) => void) | null>).current = (basketLegsToAdd: BasketLeg[], targetStrategy: number) => {
      const now = new Date();
      const nowDate = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      const nowTime = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const ZERO: Greeks = { delta: 0, theta: 0, vega: 0, gamma: 0, iv: 0 };
      const newMtmLegs = basketLegsToAdd.map(bl => {
        const entryDate = isHistoricalModeRef.current ? (bl.entryDate ?? nowDate) : nowDate;
        const entryTime = isHistoricalModeRef.current ? (bl.entryTime ?? nowTime) : nowTime;
        return {
          id: ++legIdRef.current,
          exchange: ocExchangeRef.current,
          symbol: bl.symbol,
          expiry: bl.expiry,
          strike: bl.strike,
          type: bl.type,
          action: bl.action,
          lots: bl.lots,
          lotSize: bl.lotSize,
          price: bl.price,
          refId: bl.refId,
          instrumentKey: bl.instrumentKey,
          entrySpot: bl.entrySpot
            ?? spotBySymbolRef.current.get(bl.symbol?.toUpperCase() ?? '')
            ?? ocSpotRef.current,
          entryTime,
          entryDate,
          currLtp: (() => {
            if (!isHistoricalModeRef.current) return bl.price;
            let entry = currentLtpMapRef.current.get(`${bl.expiry}:${bl.strike}`);
            if (!entry) {
              for (const [k, v] of currentLtpMapRef.current.entries()) {
                const [kExp, kStrike] = k.split(':');
                if (kExp === bl.expiry && Math.abs(Number(kStrike) - bl.strike) < 0.01) { entry = v; break; }
              }
            }
            if (!entry) return bl.price;
            return bl.type === 'CE' ? entry.ce : entry.pe;
          })(),
          checked: true,
          entryGreeks: bl.greeks ?? ZERO,
          currGreeks: bl.greeks ?? ZERO,
        };
      });

      if (basketLegsToAdd.length > 0) {
        setChartSymbol(basketLegsToAdd[0].symbol);
        setChartExchange(ocExchangeRef.current);
      }

      if (targetStrategy === activeStrategyRef.current) {
        // Same strategy — just append to current legs
        setLegs(prev => [...prev, ...newMtmLegs]);
      } else {
        // Different strategy — save current legs, load target's, append new, switch tab
        setStrategyLegs(prev => {
          const updated = {
            ...prev,
            [activeStrategyRef.current]: legsRef.current,
            [targetStrategy]: [...(prev[targetStrategy] ?? []), ...newMtmLegs],
          };
          return updated;
        });
        const targetLegs = strategyLegsRef.current[targetStrategy] ?? [];
        setLegs([...targetLegs, ...newMtmLegs]);
        setActiveStrategy(targetStrategy);
      }
    };
    return () => { if (execBasketRef) (execBasketRef as React.RefObject<((legs: BasketLeg[], targetStrategy: number) => void) | null>).current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execBasketRef]);

  // addLeg: only sends to basket — MTM legs are added on Execute
  const addLeg = useCallback((leg: { symbol: string; expiry: string; strike: number; type: 'CE' | 'PE'; action: 'B' | 'S'; price: number; lots: number; lotSize: number; refId?: number; instrumentKey?: string; greeks: Greeks; entryDate?: string; entryTime?: string; entrySpot?: number }) => {
    onAddToBasket?.({
      id: Date.now() + Math.random(),
      symbol: leg.symbol,
      expiry: leg.expiry,
      strike: leg.strike,
      type: leg.type,
      action: leg.action,
      lots: leg.lots,
      lotSize: leg.lotSize ?? 1,
      price: leg.price,
      entrySpot: leg.entrySpot,
      greeks: leg.greeks,
      refId: leg.refId,
      instrumentKey: leg.instrumentKey,
      entryDate: leg.entryDate,
      entryTime: leg.entryTime,
    });
  }, [onAddToBasket]);

  const removeLeg = useCallback((id: number) => {
    setLegs(prev => prev.filter(l => l.id !== id));
  }, []);

  const updateLeg = useCallback((id: number, patch: Partial<Leg>) => {
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
  }, []);

  // ── MTM Live Greeks WebSocket ────────────────────────────────────────────────
  const mtmWsRef = useRef<WebSocket | null>(null);
  
  useEffect(() => {
    const sessionToken = localStorage.getItem('nubra_session_token');
    if (!sessionToken || legs.length === 0) {
      if (mtmWsRef.current) { mtmWsRef.current.close(); mtmWsRef.current = null; }
      return;
    }

    // Historical mode: only connect WS when market is open
    if (isHistoricalModeRef.current && !isMarketOpen()) return;

    // Collect refIds from ALL strategy tabs so inactive tabs also get live updates
    const allLegs = [
      ...legs,
      ...Object.entries(strategyLegsRef.current)
        .filter(([k]) => Number(k) !== activeStrategyRef.current)
        .flatMap(([, tabLegs]) => tabLegs),
    ];
    const refIds = Array.from(new Set(allLegs.map(l => l.refId).filter((id): id is number => id !== undefined)));
    if (refIds.length === 0) return;

    if (!mtmWsRef.current || mtmWsRef.current.readyState !== WebSocket.OPEN) {
      if (mtmWsRef.current) mtmWsRef.current.close();
      const ws = new WebSocket('ws://localhost:8765');
      mtmWsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          action: 'subscribe',
          session_token: sessionToken,
          data_type: 'greeks',
          symbols: [],
          ref_ids: refIds,
          exchange: 'NSE', // Using NSE by default for options
        }));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'greeks' && msg.data) {
            const d = msg.data;
            if (!d.ref_id) return;
            const newLtpVal = d.ltp !== undefined && d.ltp > 0 ? (d.ltp / 100) : null;
            // Update active tab legs
            setLegs(prev => {
              let changed = false;
              const next = prev.map(leg => {
                if (leg.refId !== d.ref_id) return leg;
                changed = true;
                const newLtp = newLtpVal ?? leg.currLtp;
                const newGreeks = {
                  delta: d.delta ?? leg.currGreeks.delta,
                  theta: d.theta ?? leg.currGreeks.theta,
                  vega: d.vega ?? leg.currGreeks.vega,
                  gamma: d.gamma ?? leg.currGreeks.gamma,
                  iv: d.iv !== undefined && d.iv > 0 ? d.iv : leg.currGreeks.iv,
                };
                const entryGreeks = leg.entryGreeks.delta === 0 && newGreeks.delta !== 0 ? newGreeks : leg.entryGreeks;
                return { ...leg, currLtp: newLtp, currGreeks: newGreeks, entryGreeks };
              });
              return changed ? next : prev;
            });
            // Also update inactive strategy tabs
            if (newLtpVal !== null) {
              setStrategyLegs(prev => {
                let anyChanged = false;
                const next: Record<number, Leg[]> = {};
                for (const [k, tabLegs] of Object.entries(prev)) {
                  const kn = Number(k);
                  if (kn === activeStrategyRef.current) { next[kn] = tabLegs; continue; }
                  let tabChanged = false;
                  const updated = tabLegs.map(leg => {
                    if (leg.refId !== d.ref_id) return leg;
                    tabChanged = true;
                    const newGreeks = {
                      delta: d.delta ?? leg.currGreeks.delta,
                      theta: d.theta ?? leg.currGreeks.theta,
                      vega: d.vega ?? leg.currGreeks.vega,
                      gamma: d.gamma ?? leg.currGreeks.gamma,
                      iv: d.iv !== undefined && d.iv > 0 ? d.iv : leg.currGreeks.iv,
                    };
                    const entryGreeks = leg.entryGreeks.delta === 0 && newGreeks.delta !== 0 ? newGreeks : leg.entryGreeks;
                    return { ...leg, currLtp: newLtpVal, currGreeks: newGreeks, entryGreeks };
                  });
                  next[kn] = tabChanged ? updated : tabLegs;
                  if (tabChanged) anyChanged = true;
                }
                return anyChanged ? next : prev;
              });
            }
          }
        } catch { /**/ }
      };
      
      ws.onerror = () => {};
      ws.onclose = () => { mtmWsRef.current = null; };
    } else {
      // If already connected, just send new subscription
      mtmWsRef.current.send(JSON.stringify({
        action: 'subscribe',
        session_token: sessionToken,
        data_type: 'greeks',
        symbols: [],
        ref_ids: refIds,
        exchange: 'NSE',
      }));
    }

    // Note: We intentionally don't close the WS on every dependency change to avoid rapid reconnects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // Re-subscribe whenever any strategy tab gets new legs
    [legs, ...Object.values(strategyLegs)].flatMap(l => l).map(l => l.refId).filter(Boolean).sort().join(',')
  ]);

  // ── MCX live LTP via Upstox wsManager ────────────────────────────────────────
  useEffect(() => {
    // Collect MCX legs from ALL strategy tabs
    const allStratLegs = [
      ...legs,
      ...Object.entries(strategyLegsRef.current)
        .filter(([k]) => Number(k) !== activeStrategyRef.current)
        .flatMap(([, tabLegs]) => tabLegs),
    ];
    const mcxLegs = allStratLegs.filter(l => l.instrumentKey);
    if (!mcxLegs.length) return;
    const keys = Array.from(new Set(mcxLegs.map(l => l.instrumentKey!)));
    wsManager.requestKeys(keys);
    // Seed immediately from cache
    setLegs(prev => prev.map(leg => {
      if (!leg.instrumentKey) return leg;
      const snap = wsManager.get(leg.instrumentKey);
      if (!snap?.ltp) return leg;
      const newGreeks = { delta: snap.delta ?? 0, theta: snap.theta ?? 0, vega: snap.vega ?? 0, gamma: snap.gamma ?? 0, iv: snap.iv ?? 0 };
      const entryGreeks = leg.entryGreeks.delta === 0 && newGreeks.delta !== 0 ? newGreeks : leg.entryGreeks;
      return { ...leg, currLtp: snap.ltp, currGreeks: newGreeks, entryGreeks };
    }));
    const unsubs = mcxLegs.map(leg =>
      wsManager.subscribe(leg.instrumentKey!, md => {
        if (!md.ltp) return;
        // Update active tab
        setLegs(prev => {
          const idx = prev.findIndex(l => l.id === leg.id);
          if (idx === -1) return prev;
          const cur = prev[idx];
          const newGreeks = { delta: md.delta ?? cur.currGreeks.delta, theta: md.theta ?? cur.currGreeks.theta, vega: md.vega ?? cur.currGreeks.vega, gamma: md.gamma ?? cur.currGreeks.gamma, iv: md.iv ?? cur.currGreeks.iv };
          const entryGreeks = cur.entryGreeks.delta === 0 && newGreeks.delta !== 0 ? newGreeks : cur.entryGreeks;
          if (cur.currLtp === md.ltp && cur.currGreeks.delta === newGreeks.delta) return prev;
          const next = [...prev];
          next[idx] = { ...cur, currLtp: md.ltp, currGreeks: newGreeks, entryGreeks };
          return next;
        });
        // Update inactive tabs by instrumentKey
        setStrategyLegs(prev => {
          let anyChanged = false;
          const next: Record<number, Leg[]> = {};
          for (const [k, tabLegs] of Object.entries(prev)) {
            const kn = Number(k);
            if (kn === activeStrategyRef.current) { next[kn] = tabLegs; continue; }
            let tabChanged = false;
            const updated = tabLegs.map(l => {
              if (l.instrumentKey !== leg.instrumentKey) return l;
              tabChanged = true;
              const newGreeks = { delta: md.delta ?? l.currGreeks.delta, theta: md.theta ?? l.currGreeks.theta, vega: md.vega ?? l.currGreeks.vega, gamma: md.gamma ?? l.currGreeks.gamma, iv: md.iv ?? l.currGreeks.iv };
              const entryGreeks = l.entryGreeks.delta === 0 && newGreeks.delta !== 0 ? newGreeks : l.entryGreeks;
              return { ...l, currLtp: md.ltp, currGreeks: newGreeks, entryGreeks };
            });
            next[kn] = tabChanged ? updated : tabLegs;
            if (tabChanged) anyChanged = true;
          }
          return anyChanged ? next : prev;
        });
      })
    );
    return () => unsubs.forEach(u => u());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    [legs, ...Object.values(strategyLegs)].flatMap(l => l).map(l => l.instrumentKey ?? '').filter(Boolean).sort().join(',')
  ]);

  const stdColumns = useMemo(() => [
    columnHelper.display({
      id: 'check', size: 28,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}></span>,
      cell: ({ row }) => {
        const leg = row.original;
        return (
          <div onClick={() => updateLeg(leg.id, { checked: !leg.checked })}
            style={{ width: 18, height: 18, borderRadius: 4, background: leg.checked ? 'rgba(129,140,248,0.15)' : 'rgba(255,255,255,0.03)', border: `1px solid ${leg.checked ? 'rgba(129,140,248,0.5)' : 'rgba(255,255,255,0.12)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            {leg.checked && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </div>
        );
      }
    }),
    columnHelper.display({
      id: 'action', size: 36,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>B/S</span>,
      cell: ({ row }) => {
        const leg = row.original; const isBuy = leg.action === 'B';
        return (
          <div onClick={() => updateLeg(leg.id, { action: isBuy ? 'S' : 'B' })}
            style={{ width: 28, height: 26, borderRadius: 5, background: isBuy ? 'rgba(38,166,154,0.15)' : 'rgba(242,54,69,0.15)', border: `1px solid ${isBuy ? 'rgba(38,166,154,0.45)' : 'rgba(242,54,69,0.45)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: isBuy ? '#26a69a' : '#f23645' }}>{leg.action}</span>
          </div>
        );
      }
    }),
    columnHelper.display({
      id: 'type', size: 44,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>Type</span>,
      cell: ({ row }) => {
        const leg = row.original;
        return (
          <div style={{ width: 36, height: 26, borderRadius: 5, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: leg.type === 'CE' ? '#facc15' : '#c084fc' }}>{leg.type}</span>
          </div>
        );
      }
    }),
    columnHelper.display({
      id: 'lots', size: 96,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>Lots</span>,
      cell: ({ row }) => (
        <div style={{ width: 88, height: 26, display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, overflow: 'hidden' }}>
          <button onClick={() => updateLeg(row.original.id, { lots: Math.max(1, row.original.lots - 1) })} style={{ width: 22, height: 26, background: 'transparent', border: 'none', color: '#6B7280', cursor: 'pointer', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>−</button>
          <input type="text" inputMode="numeric"
            key={`lots-${row.original.id}-${row.original.lots}`}
            defaultValue={row.original.lots}
            onBlur={e => { const v = parseInt(e.target.value); const safe = isNaN(v) || v < 1 ? 1 : v; e.target.value = String(safe); updateLeg(row.original.id, { lots: safe }); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{ flex: 1, textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#E2E8F0', background: 'transparent', border: 'none', outline: 'none', minWidth: 0, width: 0 }} />
          <button onClick={() => updateLeg(row.original.id, { lots: row.original.lots + 1 })} style={{ width: 22, height: 26, background: 'transparent', border: 'none', color: '#6B7280', cursor: 'pointer', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>+</button>
        </div>
      )
    }),
    columnHelper.display({
      id: 'expiry', size: 90,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>Expiry</span>,
      cell: ({ row }) => (
        <div style={{ height: 26, borderRadius: 5, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px' }}>
          <span style={{ fontSize: 13, color: '#9CA3AF', fontWeight: 500, whiteSpace: 'nowrap' }}>{fmtExpiry(row.original.expiry)}</span>
        </div>
      )
    }),
    columnHelper.display({
      id: 'strike', size: 72,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>Strike</span>,
      cell: ({ row }) => (
        <div style={{ height: 26, borderRadius: 5, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{row.original.strike}</span>
        </div>
      )
    }),
    columnHelper.display({
      id: 'price', size: 80,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>Price</span>,
      cell: ({ row }) => (
        <div style={{ height: 26, borderRadius: 5, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#D1D4DC', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>₹{row.original.price.toFixed(2)}</span>
        </div>
      )
    }),
    columnHelper.display({
      id: 'currLtp', size: 80,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>LTP</span>,
      cell: ({ row }) => (
        <div style={{ height: 26, borderRadius: 5, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#E2E8F0', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>₹{(row.original.currLtp > 0 ? row.original.currLtp : row.original.price).toFixed(2)}</span>
        </div>
      )
    }),
    columnHelper.display({
      id: 'spot', size: 80,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>Spot</span>,
      cell: ({ row }) => (
        <div style={{ height: 26, borderRadius: 5, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7280', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{row.original.entrySpot > 0 ? row.original.entrySpot.toFixed(2) : '—'}</span>
        </div>
      )
    }),
    columnHelper.display({
      id: 'time', size: 72,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>Time</span>,
      cell: ({ row }) => (
        <div style={{ height: 26, borderRadius: 5, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#6B7280' }}>{row.original.entryTime}</span>
        </div>
      )
    }),
    columnHelper.display({
      id: 'mtm', size: 88,
      header: () => <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700 }}>MTM</span>,
      cell: ({ row }) => {
        const leg = row.original;
        const currLtp = leg.currLtp > 0 ? leg.currLtp : leg.price;
        const mtm = (leg.action === 'B' ? currLtp - leg.price : leg.price - currLtp) * leg.lots * (leg.lotSize || 1);
        const pos = mtm >= 0;
        return (
          <div style={{ height: 26, borderRadius: 5, background: pos ? 'rgba(38,166,154,0.1)' : 'rgba(242,54,69,0.1)', border: `1px solid ${pos ? 'rgba(38,166,154,0.25)' : 'rgba(242,54,69,0.25)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: pos ? '#26a69a' : '#f23645', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{fmtMtm(mtm)}</span>
          </div>
        );
      }
    }),
    columnHelper.display({
      id: 'delete', size: 32,
      header: () => <span />,
      cell: ({ row }) => (
        <button onClick={() => removeLeg(row.original.id)}
          style={{ width: 24, height: 24, background: 'transparent', border: 'none', cursor: 'pointer', color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4 }}
          onMouseEnter={e => (e.currentTarget.style.color = '#f23645')}
          onMouseLeave={e => (e.currentTarget.style.color = '#374151')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>
        </button>
      )
    }),
  ], [updateLeg, removeLeg]);

  const greeksColumns = useMemo(() => [
    columnHelper.display({ id: 'position', header: () => <div style={{ width: 90, paddingLeft: 10, flexShrink: 0, display: 'flex', alignItems: 'center' }}><span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 700, letterSpacing: '0.04em', whiteSpace: 'nowrap', fontFamily: 'var(--font-family-sans)' }}>Position</span></div>, cell: ({ row }) => { const leg = row.original; const isBuy = leg.action === 'B'; return <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, padding: '8px 10px', borderRight: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, width: 90, background: 'rgba(0,0,0,0.12)' }}><div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div onClick={() => updateLeg(leg.id, { checked: !leg.checked })} style={{ width: 14, height: 14, borderRadius: 3, background: leg.checked ? 'rgba(129,140,248,0.2)' : 'rgba(255,255,255,0.04)', border: `1px solid ${leg.checked ? 'rgba(129,140,248,0.6)' : 'rgba(255,255,255,0.15)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }}>{leg.checked && <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}</div><div onClick={() => updateLeg(leg.id, { action: leg.action === 'B' ? 'S' : 'B' })} style={{ padding: '0px 6px', height: 18, borderRadius: 3, background: isBuy ? 'rgba(38,166,154,0.15)' : 'rgba(242,54,69,0.15)', border: `1px solid ${isBuy ? 'rgba(38,166,154,0.4)' : 'rgba(242,54,69,0.4)'}`, cursor: 'pointer', display: 'flex', alignItems: 'center' }}><span style={{ fontSize: 11, fontWeight: 800, color: isBuy ? '#26a69a' : '#f23645' }}>{leg.action}</span></div><span style={{ fontSize: 11, fontWeight: 800, color: leg.type === 'CE' ? '#facc15' : '#c084fc', letterSpacing: '0.02em' }}>{leg.type}</span></div><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', lineHeight: 1 }}>{leg.strike}</span><div style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, padding: '2px 5px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 700, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', lineHeight: 1 }}>{leg.lots}x</span></div></div></div>; } }),
    ...greekItems.map((gk, gi) => columnHelper.display({ id: gk.key, header: () => <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, padding: '0 6px', alignItems: 'center' }}><div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}><span style={{ fontSize: 13, color: gk.color, fontWeight: 800, letterSpacing: '0.02em' }}>{gk.label}</span><span style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.04em', whiteSpace: 'nowrap', fontFamily: 'var(--font-family-sans)' }}>{gk.name}</span></div><div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', padding: '0 2px' }}><span style={{ fontSize: 10, color: 'rgba(156,163,175,0.5)', fontWeight: 600, letterSpacing: '0.03em' }}>Ent</span><span style={{ fontSize: 10, color: 'rgba(156,163,175,0.7)', fontWeight: 700, letterSpacing: '0.03em' }}>Live</span></div></div>, cell: ({ row }) => { const leg = row.original; const isIv = gk.key === 'iv'; const lots = leg.lots || 1; const rawCurr = leg.currGreeks[gk.key]; const rawEntry = leg.entryGreeks[gk.key]; const curr = isIv ? rawCurr * 100 : rawCurr * lots; const entry = isIv ? rawEntry * 100 : rawEntry * lots; const chg = curr - entry; const chgColor = chg > 0 ? '#26a69a' : chg < 0 ? '#f23645' : '#6B7280'; return <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '4px 6px', borderRight: gi < 4 ? '1px solid rgba(255,255,255,0.12)' : 'none', height: '100%', gap: 2 }}><div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: 12, color: '#9CA3AF', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', fontWeight: 600 }}>{fmtG(entry, gk.dec)}{isIv ? '%' : ''}</span><span style={{ fontSize: 14, fontWeight: 800, color: gk.color, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{fmtG(curr, gk.dec)}{isIv ? '%' : ''}</span></div><div style={{ display: 'flex', justifyContent: 'center' }}><span style={{ fontSize: 13, fontWeight: 700, color: chgColor, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>{entry !== 0 ? `${chg >= 0 ? '+' : ''}${parseFloat(chg.toFixed(gk.dec))}${isIv ? '%' : ''}` : '—'}</span></div></div>; } })),
    columnHelper.display({ id: 'delete', header: () => <div style={{ width: 34, flexShrink: 0 }} />, cell: ({ row }) => <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px', borderLeft: '1px solid rgba(255,255,255,0.03)', flexShrink: 0, height: '100%' }}><button onClick={() => removeLeg(row.original.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#1f2937', display: 'flex', alignItems: 'center', padding: 2, borderRadius: 4 }} onMouseEnter={e => (e.currentTarget.style.color = '#f23645')} onMouseLeave={e => (e.currentTarget.style.color = '#1f2937')}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg></button></div> })
  ], [updateLeg, removeLeg]);

  const headerTable = useReactTable({
    data: [],
    columns: showGreeks ? greeksColumns : stdColumns,
    getCoreRowModel: getCoreRowModel()
  });

  // Called by OptionChain on every data tick
  const onLtpUpdate = useCallback((ltpMap: Map<number, { ce: number; pe: number; ceGreeks: Greeks; peGreeks: Greeks }>, spot: number, chainExpiry: string) => {
    ocSpotRef.current = spot;
    if (ocSymbol) spotBySymbolRef.current.set(ocSymbol.toUpperCase(), spot);
    // Always store latest OC prices so execute can read current price
    ltpMap.forEach((v, strike) => {
      currentLtpMapRef.current.set(`${chainExpiry}:${strike}`, v);
    });

    const marketOpen = isMarketOpen();

    setLegs(prev => prev.map(leg => {
      if (leg.expiry !== chainExpiry) return leg;

      // Historical mode + market open: WS handles currLtp, skip OC update
      if (isHistoricalModeRef.current && marketOpen) return leg;

      // Live mode OR historical + market closed: update currLtp from OC
      let entry = ltpMap.get(leg.strike);
      if (!entry) {
        for (const [k, v] of ltpMap.entries()) {
          if (Math.abs(k - leg.strike) < 0.01) { entry = v; break; }
        }
      }
      if (!entry) return leg;
      const newLtp = leg.type === 'CE' ? entry.ce : entry.pe;
      const newGreeks = leg.type === 'CE' ? entry.ceGreeks : entry.peGreeks;
      const entryGreeks = leg.entryGreeks.delta === 0 && newGreeks.delta !== 0 ? newGreeks : leg.entryGreeks;
      return { ...leg, currLtp: newLtp, currGreeks: newGreeks, entryGreeks };
    }));
  }, []);

  // Selected instrument for option chain
  const [ocOpen, setOcOpen] = useState(false);
  const nubraSession = localStorage.getItem('nubra_session_token') ?? '';
  const nubraExpiriesCache = useRef<Map<string, Set<string>>>(new Map());

  const [nubraIndexes] = useState<Record<string, string>[]>([]);

  const [ocExpiries, setOcExpiries] = useState<string[]>([]);

  // ── Dedicated WS to keep per-symbol spot live from all MTM legs ──────────────
  // Subscribes option chain for each unique (symbol, expiry) in legs — independent
  // of which OC panel is open — so spotBySymbolRef stays fresh for all underlyings.
  const legSymbolExpiriesKey = useMemo(() =>
    [...new Set(legs.map(l => `${l.symbol.toUpperCase()}:${l.expiry}`))].sort().join(','),
  [legs]);

  useEffect(() => {
    const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
    if (!sessionToken || legs.length === 0) return;

    // Unique (symbol, expiry, exchange) combos from current legs
    const combos = [...new Map(
      legs.map(l => [`${l.symbol.toUpperCase()}:${l.expiry}`, { sym: l.symbol.toUpperCase(), expiry: l.expiry, exchange: l.exchange ?? 'NSE' }])
    ).values()];

    if (combos.length === 0) return;

    spotWsRef.current?.close();
    const ws = new WebSocket('ws://localhost:8765');
    spotWsRef.current = ws;

    ws.onopen = () => {
      for (const { sym, expiry, exchange } of combos) {
        ws.send(JSON.stringify({
          action: 'subscribe',
          session_token: sessionToken,
          data_type: 'option',
          symbols: [`${sym}:${expiry}`],
          exchange,
        }));
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'option' || !msg.data) return;
        const d = msg.data;
        const asset: string = (d.asset ?? '').toUpperCase();
        const price = d.current_price ?? 0;
        if (asset && price > 0) {
          spotBySymbolRef.current.set(asset, price);
          // Also update ocSpotRef if this matches the active OC symbol
          if (asset === (ocSymbol ?? '').toUpperCase()) ocSpotRef.current = price;
        }
      } catch { /**/ }
    };

    ws.onerror = () => {};
    ws.onclose = () => {};

    return () => { ws.close(); spotWsRef.current = null; };
  }, [legSymbolExpiriesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lot size for the selected OC symbol
  const ocLotSize = useMemo(() => {
    if (!ocSymbol) return 1;
    const sym = ocSymbol.toUpperCase();
    const match = nubraInstruments.find(i =>
      (i.option_type === 'CE' || i.option_type === 'PE') &&
      ((i.asset ?? '').toUpperCase() === sym || (i.nubra_name ?? '').toUpperCase() === sym || (i.stock_name ?? '').toUpperCase() === sym)
    );
    return match?.lot_size ?? 1;
  }, [ocSymbol, nubraInstruments]);

  // refId of the underlying index/stock for historical spot price fetch
  const ocSpotRefId = useMemo(() => {
    if (!ocSymbol) return undefined;
    const sym = ocSymbol.toUpperCase();
    const match = nubraInstruments.find(i =>
      i.option_type === 'N/A' &&
      ((i.stock_name ?? '').toUpperCase() === sym || (i.nubra_name ?? '').toUpperCase() === sym || (i.asset ?? '').toUpperCase() === sym)
    );
    return match?.ref_id;
  }, [ocSymbol, nubraInstruments]);

  // Always-fresh refs so handleMtmSearch never has stale closure
  const nubraInstrumentsRef = useRef<NubraInstrument[]>([]);
  useEffect(() => { nubraInstrumentsRef.current = nubraInstruments; }, [nubraInstruments]);
  const upstoxInstrumentsRef = useRef<Instrument[]>([]);
  useEffect(() => { upstoxInstrumentsRef.current = instruments; }, [instruments]);

  // Search state
  const [mtmQuery, setMtmQuery] = useState('');
  const deferredMtmQuery = useDeferredValue(mtmQuery);
  const [mtmResults, setMtmResults] = useState<Instrument[]>([]);
  const deferredMtmResults = useDeferredValue(mtmResults);
  const mtmRenderResults = useMemo(() => deferredMtmResults.slice(0, 60), [deferredMtmResults]);
  const [mtmCursor, setMtmCursor] = useState(0);
  const [showMtmDropdown, setShowMtmDropdown] = useState(false);
  const mtmInputRef = useRef<HTMLInputElement>(null);
  const mtmDropdownRef = useRef<HTMLDivElement>(null);
  const mtmDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mtmListRef = useRef<HTMLDivElement>(null);

  const normalizeKey = useCallback((v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''), []);
  const normalizeExch = useCallback((v: string) => v.toUpperCase().replace(/_INDEX|_FO/g, ''), []);
  const resolveNubraSymbol = useCallback((ins: Partial<Instrument> & { stock_name?: string; nubra_name?: string; asset?: string }) => {
    return (ins.nubra_name || ins.stock_name || (ins as any).asset || ins.underlying_symbol || ins.trading_symbol || '').toString();
  }, [normalizeKey, normalizeExch]);

  const ensureNubraExpiries = useCallback((sym: string, exch: string) => {
    const key = `${sym}|${exch}`;
    const cached = nubraExpiriesCache.current.get(key);
    if (cached) return cached;
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const set = new Set<string>();
    const targetSym = normalizeKey(sym);
    const targetExch = normalizeExch(exch);
    for (const item of nubraInstrumentsRef.current) {
      const itemExch = normalizeExch(item.exchange ?? '');
      if (targetExch && itemExch && itemExch !== targetExch) continue;
      const matches = [
        normalizeKey(item.asset ?? ''),
        normalizeKey(item.stock_name ?? ''),
        normalizeKey(item.nubra_name ?? ''),
      ];
      if (!matches.includes(targetSym)) continue;
      if (item.expiry) {
        const expStr = String(item.expiry);
        if (expStr >= todayStr) set.add(expStr);
      }
    }
    nubraExpiriesCache.current.set(key, set);
    return set;
  }, []);

  // Register callback so App's worker handler can push results here
  useEffect(() => {
    mtmResultsCbRef.current = (results: Instrument[]) => {
      startTransition(() => {
        setMtmResults(results);
        setShowMtmDropdown(true);
        setMtmCursor(0);
      });
    };
    return () => { mtmResultsCbRef.current = null; };
  }, [mtmResultsCbRef]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!mtmInputRef.current?.contains(e.target as Node) && !mtmDropdownRef.current?.contains(e.target as Node)) {
        setShowMtmDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleMtmSearch = useCallback((v: string) => {
    if (mtmDebounce.current) clearTimeout(mtmDebounce.current);
    if (!v.trim()) {
      startTransition(() => { setMtmQuery(''); setMtmResults([]); setShowMtmDropdown(false); setMtmCursor(0); });
      return;
    }
    mtmDebounce.current = setTimeout(() => {
      if (mtmWorkerRef.current && mtmWorkerReady.current) {
        startTransition(() => { setMtmQuery(v); setMtmCursor(0); });
        mtmWorkerRef.current.postMessage({ type: 'SEARCH', query: v });
      }
    }, 120);
  }, [mtmWorkerRef, mtmWorkerReady]);

  const iconBtnBase: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.06)',
    background: 'rgba(255,255,255,0.03)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.15s',
    flexShrink: 0,
  };
  const iconBtnHover = (el: HTMLElement, active = false) => {
    if (active) return;
    el.style.background = 'rgba(255,255,255,0.08)';
    el.style.borderColor = 'rgba(255,255,255,0.12)';
  };
  const iconBtnLeave = (el: HTMLElement, active = false) => {
    if (active) return;
    el.style.background = 'rgba(255,255,255,0.03)';
    el.style.borderColor = 'rgba(255,255,255,0.06)';
  };

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(Math.max(pct, 20), 80));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex"
      style={{
        display: visible ? 'flex' : 'none',
        padding: 8,
        gap: 6,
        background: 'var(--bg-base)',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        alignItems: 'stretch',
      }}
    >
      {/* Left panel */}
      <div style={{
        width: `${leftPct}%`, minWidth: 0, flexShrink: 0,
        background: isHistoricalMode ? 'rgba(255,152,0,0.06)' : '#171717',
        borderRadius: isHistoricalMode ? 16 : 10,
        border: isHistoricalMode ? '1.5px solid rgba(255,152,0,0.45)' : '1px solid rgba(255,255,255,0.08)',
        boxShadow: isHistoricalMode ? '0 0 25px rgba(255,152,0,0.1) inset' : 'none',
        display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', minHeight: 0,
      }}>
        {/* Search bar + dropdown */}
        <div style={{ padding: '7px 10px', position: 'relative', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: '35%', position: 'relative', minWidth: 220 }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 28,
                padding: '0 4px',
                background: 'transparent',
                border: 'none',
                borderRadius: 4,
                transition: 'background 0.12s',
                minWidth: 0,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" />
              </svg>
              <input
                ref={mtmInputRef}
                onInput={e => handleMtmSearch((e.target as HTMLInputElement).value)}
                onKeyDown={e => {
                  const list = mtmRenderResults;
                  if (e.key === 'ArrowDown') { e.preventDefault(); setMtmCursor(c => Math.min(c + 1, list.length - 1)); mtmListRef.current?.children[mtmCursor + 1]?.scrollIntoView({ block: 'nearest' }); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setMtmCursor(c => Math.max(c - 1, 0)); mtmListRef.current?.children[mtmCursor - 1]?.scrollIntoView({ block: 'nearest' }); }
                  else if (e.key === 'Enter' && list.length > 0) {
                    const sel = list[mtmCursor];
                    const sym = resolveNubraSymbol(sel as any);
                    const exch = (sel.exchange ?? 'NSE').replace('_INDEX', '');
                    const nubraAt = (sel as any).nubraAssetType as string ?? '';
                    if (sel.exchange === 'MCX') {
                      setMtmQuery(sym); setShowMtmDropdown(false);
                      setOcExpiries([]);
                      setOcSymbol(sym); setOcAssetType('STOCK_FO'); setOcExchange('MCX'); setOcOpen(true);
                    } else {
                      const cached = ensureNubraExpiries(sym, exch);
                      setOcExpiries(cached ? [...cached].sort() : []);
                      setMtmQuery(sym); setShowMtmDropdown(false);
                      setOcSymbol(sym);
                      setOcAssetType(nubraAt === 'INDEX_FO' || nubraAt === 'INDEX' ? 'INDEX_FO' : 'STOCK_FO');
                      setOcExchange(exch); setOcOpen(true);
                    }
                  }
                  else if (e.key === 'Escape') { setShowMtmDropdown(false); }
                }}
                placeholder="Search instruments..."
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: '#D1D4DC', caretColor: '#818cf8', fontWeight: 600, letterSpacing: '0.02em', minWidth: 0 }}
              />
              {mtmQuery && <button onClick={() => { if (mtmInputRef.current) mtmInputRef.current.value = ''; handleMtmSearch(''); }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#787B86', display: 'flex', padding: 3, borderRadius: 4 }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg></button>}
            </div>
            {/* Dropdown */}
            {showMtmDropdown && (
              <div ref={mtmDropdownRef} style={{ position: 'absolute', top: '100%', left: 12, right: 12, zIndex: 999, background: '#1f1f1f', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: 340 }}>
                {/* Results list */}
                <div ref={mtmListRef} style={{ overflowY: 'auto', flex: 1, scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
                  {deferredMtmResults.length === 0 ? (
                    <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12, color: '#3D4150' }}>No results for "{deferredMtmQuery}"</div>
                  ) : mtmRenderResults.map((ins, i) => {
                    const nubraAt = (ins as any).nubraAssetType as string ?? '';
                    const isMcx = ins.exchange === 'MCX';
                    const atColor: Record<string, string> = { INDEX_FO: '#818cf8', STOCK_FO: '#60a5fa', STOCKS: '#34d399', ETF: '#f59e0b', INDEX: '#818cf8', MCX: '#f97316' };
                    const atBg: Record<string, string> = { INDEX_FO: 'rgba(129,140,248,0.12)', STOCK_FO: 'rgba(96,165,250,0.10)', STOCKS: 'rgba(52,211,153,0.10)', ETF: 'rgba(245,158,11,0.10)', INDEX: 'rgba(129,140,248,0.12)', MCX: 'rgba(249,115,22,0.12)' };
                    return (
                      <div key={`${ins.instrument_key}-${i}`}
                        onClick={() => {
                          const sym = resolveNubraSymbol(ins as any);
                          const exch = (ins.exchange ?? 'NSE').replace('_INDEX', '');
                          if (isMcx) {
                            // MCX: set symbol + exchange, no Nubra expiries needed
                            setMtmQuery(sym); setShowMtmDropdown(false);
                            setOcExpiries([]);
                            setOcSymbol(sym); setOcAssetType('STOCK_FO'); setOcExchange('MCX'); setOcOpen(true);
                          } else {
                            const cached = ensureNubraExpiries(sym, exch);
                            setOcExpiries(cached ? [...cached].sort() : []);
                            setMtmQuery(sym); setShowMtmDropdown(false);
                            setOcSymbol(sym);
                            setOcAssetType(nubraAt === 'INDEX_FO' || nubraAt === 'INDEX' ? 'INDEX_FO' : 'STOCK_FO');
                            setOcExchange(exch); setOcOpen(true);
                          }
                        }}
                        onMouseEnter={() => setMtmCursor(i)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.03)', background: i === mtmCursor ? 'rgba(79,142,247,0.10)' : 'transparent', transition: 'background 0.08s' }}
                      >
                        <div style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 7, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {ins.exchange === 'NSE' ? <img src="https://s3-symbol-logo.tradingview.com/source/NSE.svg" alt="NSE" style={{ width: 20, height: 20, objectFit: 'contain', opacity: 0.85 }} />
                            : ins.exchange === 'BSE' ? <img src="https://s3-symbol-logo.tradingview.com/source/BSE.svg" alt="BSE" style={{ width: 20, height: 20, objectFit: 'contain', opacity: 0.85 }} />
                              : <span style={{ fontSize: 9, fontWeight: 700, color: '#9598A1' }}>{ins.exchange}</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#E0E3EB' }}><Highlight text={ins.trading_symbol} query={deferredMtmQuery} /></div>
                          <div style={{ fontSize: 11, color: '#565A6B', marginTop: 1 }}>{ins.exchange}</div>
                        </div>
                        {nubraAt && (
                          <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: atBg[nubraAt] ?? 'rgba(255,255,255,0.05)', color: atColor[nubraAt] ?? '#565A6B', fontWeight: 700, textTransform: 'uppercase', flexShrink: 0, letterSpacing: '0.03em' }}>{nubraAt}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)', flexShrink: 0 }}>
                  <span style={{ fontSize: 11, color: '#4A4E5C' }}><kbd style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>↵</kbd> select</span>
                  <span style={{ fontSize: 11, color: '#4A4E5C' }}><kbd style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>Esc</kbd> close</span>
                </div>
              </div>
            )}
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label className="inline-flex items-center cursor-pointer">
            <span className={`select-none text-[13px] font-semibold tracking-wide mr-2 transition-colors duration-200 ${!isHistoricalMode ? 'text-[#34d399]' : 'text-[#6B7280]'}`} style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>Live</span>
            <input type="checkbox" className="sr-only peer" checked={isHistoricalMode} onChange={e => setIsHistoricalMode(e.target.checked)} />
            <div className={`relative w-10 h-[22px] rounded-full peer peer-focus:outline-none peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all ${isHistoricalMode ? 'bg-[#FF9800]' : 'bg-[#333333]'} shadow-inner border border-[rgba(255,255,255,0.05)]`}></div>
            <span className={`select-none text-[13px] font-semibold tracking-wide ml-2 transition-colors duration-200 ${isHistoricalMode ? 'text-[#FF9800]' : 'text-[#6B7280]'}`} style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>History</span>
          </label>
          <label className="inline-flex items-center cursor-pointer">
            <span className={`select-none text-[13px] font-semibold tracking-wide mr-2 transition-colors duration-200 ${showGreeks ? 'text-[#34d399]' : 'text-[#6B7280]'}`} style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>Greeks</span>
            <input type="checkbox" className="sr-only peer" checked={showGreeks} onChange={e => setShowGreeks(e.target.checked)} />
            <div className={`relative w-10 h-[22px] rounded-full peer peer-focus:outline-none peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all ${showGreeks ? 'bg-[#34d399]' : 'bg-[#333333]'} shadow-inner border border-[rgba(255,255,255,0.05)]`}></div>
          </label>
          </div>

          <div style={{ flex: 1 }} />
          {/* Layout theme switcher — far right */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {([
              { t: 'theme1' as const, label: 'Cards', icon: (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="1" y="1" width="6" height="6" rx="1.5" opacity="0.9" />
                  <rect x="9" y="1" width="6" height="6" rx="1.5" opacity="0.9" />
                  <rect x="1" y="9" width="6" height="6" rx="1.5" opacity="0.9" />
                  <rect x="9" y="9" width="6" height="6" rx="1.5" opacity="0.9" />
                </svg>
              )},
              { t: 'theme2' as const, label: 'Table', icon: (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="1" y="1" width="14" height="3.5" rx="1.5" opacity="0.9" />
                  <rect x="1" y="6.25" width="14" height="3.5" rx="1.5" opacity="0.7" />
                  <rect x="1" y="11.5" width="14" height="3.5" rx="1.5" opacity="0.5" />
                </svg>
              )},
            ]).map(({ t, label, icon }) => (
              <button
                key={t}
                onClick={() => setLayoutTheme(t)}
                title={label}
                style={{
                  ...iconBtnBase,
                  background: layoutTheme === t ? 'rgba(79,142,247,0.18)' : 'rgba(255,255,255,0.03)',
                  color: layoutTheme === t ? '#4F8EF7' : '#4B5563',
                  outline: layoutTheme === t ? '1px solid rgba(79,142,247,0.35)' : '1px solid rgba(255,255,255,0.06)',
                }}
                onMouseEnter={e => iconBtnHover(e.currentTarget as HTMLElement, layoutTheme === t)}
                onMouseLeave={e => iconBtnLeave(e.currentTarget as HTMLElement, layoutTheme === t)}
              >
                {icon}
              </button>
            ))}
          </div>
          {/* Open Option Chain button */}
          <button
            onClick={() => { if (ocSymbol) setOcOpen(true); else mtmInputRef.current?.focus(); }}
            title={ocSymbol ? `Open Option Chain · ${ocSymbol}` : 'Search a symbol first'}
            style={{
              ...iconBtnBase,
              background: ocOpen ? 'rgba(255,152,0,0.15)' : iconBtnBase.background,
              border: ocOpen ? '1px solid rgba(255,152,0,0.4)' : iconBtnBase.border,
            }}
            onMouseEnter={e => {
              if (ocOpen) return;
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,152,0,0.12)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,152,0,0.35)';
            }}
            onMouseLeave={e => {
              if (ocOpen) return;
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.06)';
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="9 10 20 17.6">
              <g id="Group 8174">
                <path d="M19.3956 10.4C19.3956 10.1791 19.2165 10 18.9956 10C18.7748 10 18.5957 10.1791 18.5957 10.4V27.2002C18.5957 27.4211 18.7748 27.6002 18.9956 27.6002C19.2165 27.6002 19.3956 27.4211 19.3956 27.2002V10.4Z" fill="#9CA3AF"/>
                <path d="M16.1929 11.5977H11.3936C10.9519 11.5977 10.5938 11.9558 10.5938 12.3977C10.5938 12.8395 10.9519 13.1977 11.3936 13.1977H16.1929C16.6347 13.1977 16.9928 12.8395 16.9928 12.3977C16.9928 11.9558 16.6347 11.5977 16.1929 11.5977Z" fill="#9CA3AF"/>
                <path d="M27.401 11.5977H21.8018C21.3601 11.5977 21.002 11.9558 21.002 12.3977C21.002 12.8395 21.3601 13.1977 21.8018 13.1977H27.401C27.8428 13.1977 28.2009 12.8395 28.2009 12.3977C28.2009 11.9558 27.8428 11.5977 27.401 11.5977Z" fill="#9CA3AF"/>
                <path d="M16.1989 19.6016H9.79988C9.35812 19.6016 9 19.9597 9 20.4016C9 20.8434 9.35812 21.2016 9.79988 21.2016H16.1989C16.6407 21.2016 16.9988 20.8434 16.9988 20.4016C16.9988 19.9597 16.6407 19.6016 16.1989 19.6016Z" fill="#9CA3AF"/>
                <path d="M25.0014 19.6016H21.8018C21.3601 19.6016 21.002 19.9597 21.002 20.4016C21.002 20.8434 21.3601 21.2016 21.8018 21.2016H25.0014C25.4431 21.2016 25.8013 20.8434 25.8013 20.4016C25.8013 19.9597 25.4431 19.6016 25.0014 19.6016Z" fill="#9CA3AF"/>
                <path d="M16.1928 15.6016H12.9932C12.5515 15.6016 12.1934 15.9597 12.1934 16.4016C12.1934 16.8434 12.5515 17.2016 12.9932 17.2016H16.1928C16.6345 17.2016 16.9927 16.8434 16.9927 16.4016C16.9927 15.9597 16.6345 15.6016 16.1928 15.6016Z" fill="#9CA3AF"/>
                <path d="M28.2009 15.6016H21.8018C21.3601 15.6016 21.002 15.9597 21.002 16.4016C21.002 16.8434 21.3601 17.2016 21.8018 17.2016H28.2009C28.6427 17.2016 29.0008 16.8434 29.0008 16.4016C29.0008 15.9597 28.6427 15.6016 28.2009 15.6016Z" fill="#9CA3AF"/>
                <path d="M16.1979 23.5996H10.5987C10.1569 23.5996 9.79883 23.9578 9.79883 24.3996C9.79883 24.8414 10.1569 25.1996 10.5987 25.1996H16.1979C16.6397 25.1996 16.9978 24.8414 16.9978 24.3996C16.9978 23.9578 16.6397 23.5996 16.1979 23.5996Z" fill="#9CA3AF"/>
                <path d="M26.6011 23.5996H21.8018C21.3601 23.5996 21.002 23.9578 21.002 24.3996C21.002 24.8414 21.3601 25.1996 21.8018 25.1996H26.6011C27.0429 25.1996 27.401 24.8414 27.401 24.3996C27.401 23.9578 27.0429 23.5996 26.6011 23.5996Z" fill="#9CA3AF"/>
              </g>
            </svg>
          </button>
          {/* Export strategy */}
          <button
            onClick={() => { setCloudTab('export'); setCloudName(strategyNames[activeStrategy] ?? `Strategy ${activeStrategy}`); setCloudError(''); setCloudOpen(true); }}
            title="Export strategy"
            style={iconBtnBase}
            onMouseEnter={e => iconBtnHover(e.currentTarget as HTMLElement)}
            onMouseLeave={e => iconBtnLeave(e.currentTarget as HTMLElement)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#9CA3AF' }}>
              <path d="M12 3v12" />
              <path d="M8 7l4-4 4 4" />
              <path d="M5 21h14a2 2 0 0 0 2-2v-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2" />
            </svg>
          </button>
          {/* Import strategy */}
          <button
            onClick={() => { setCloudTab('import'); setCloudError(''); setCloudOpen(true); fetchCloudList(); }}
            title="Import strategy"
            style={iconBtnBase}
            onMouseEnter={e => iconBtnHover(e.currentTarget as HTMLElement)}
            onMouseLeave={e => iconBtnLeave(e.currentTarget as HTMLElement)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#9CA3AF' }}>
              <path d="M12 21V9" />
              <path d="M16 13l-4 4-4-4" />
              <path d="M5 3h14a2 2 0 0 1 2 2v3" />
              <path d="M3 8V5a2 2 0 0 1 2-2" />
            </svg>
          </button>
        </div>
        {cloudOpen && (
          <div onClick={() => setCloudOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onClick={e => e.stopPropagation()} style={{ width: 420, maxWidth: '90vw', background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.6)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => { setCloudTab('import'); fetchCloudList(); }} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.03em', background: cloudTab === 'import' ? 'rgba(255,255,255,0.08)' : 'transparent', color: cloudTab === 'import' ? '#E2E8F0' : '#6B7280', borderColor: cloudTab === 'import' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)' }}>Import</button>
                  <button onClick={() => setCloudTab('export')} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.03em', background: cloudTab === 'export' ? 'rgba(255,255,255,0.08)' : 'transparent', color: cloudTab === 'export' ? '#E2E8F0' : '#6B7280', borderColor: cloudTab === 'export' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)' }}>Export</button>
                </div>
                <button onClick={() => setCloudOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#4B5563', display: 'flex', padding: 2 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>

              {cloudTab === 'export' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 600 }}>Save current strategy to cloud</div>
                  <input
                    value={cloudName}
                    onChange={e => setCloudName(e.target.value)}
                    placeholder="Strategy name"
                    style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 10px', color: '#E2E8F0', fontSize: 12, fontWeight: 600 }}
                  />
                  <button disabled={cloudLoading} onClick={handleExport} style={{ padding: '8px 0', borderRadius: 8, background: cloudLoading ? 'rgba(255,255,255,0.05)' : 'rgba(79,142,247,0.2)', border: '1px solid rgba(79,142,247,0.45)', color: cloudLoading ? '#6B7280' : '#7AA7FF', fontSize: 12, fontWeight: 700, cursor: cloudLoading ? 'not-allowed' : 'pointer' }}>
                    {cloudLoading ? 'Saving…' : 'Save to Cloud'}
                  </button>
                </div>
              )}

              {cloudTab === 'import' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 600 }}>Saved strategies</span>
                    <button disabled={cloudLoading} onClick={fetchCloudList} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '3px 8px', color: '#9CA3AF', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Refresh</button>
                  </div>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
                    {cloudLoading ? (
                      <div style={{ padding: 14, fontSize: 12, color: '#6B7280' }}>Loading…</div>
                    ) : cloudList.length === 0 ? (
                      <div style={{ padding: 14, fontSize: 12, color: '#6B7280' }}>No saved strategies</div>
                    ) : cloudList.map((s: any) => (
                      <div key={s.id ?? `${s.name}-${s.created_at}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <button onClick={() => handleImportSelect(s)} style={{ flex: 1, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0' }}>{s.name ?? 'Untitled'}</div>
                          <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>
                            {(s.created_at ? new Date(s.created_at).toLocaleString('en-IN') : '—')} · {(s.legs?.length ?? 0)} legs
                          </div>
                        </button>
                        <button onClick={() => handleDeleteStrategy(s.id)} title="Delete" style={{ width: 26, height: 26, borderRadius: 6, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.35)', color: '#f87171', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {cloudError && <div style={{ fontSize: 11, color: '#f87171', fontWeight: 600 }}>{cloudError}</div>}
            </div>
          </div>
        )}
        {toastOpen && (
          <div style={{ position: 'fixed', right: 16, top: 16, zIndex: 130 }}>
            <div id="toast-success" style={{ width: 320, maxWidth: '90vw', padding: 14, marginBottom: 8, fontSize: 12, color: '#14532D', borderRadius: 10, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)' }} role="alert">
              <h3 className="font-semibold">Strategy uploaded to cloud</h3>
              <div className="mt-2 mb-4">
                Your strategy has been saved successfully.
              </div>
              <div className="flex items-center space-x-3">
                <button type="button" style={{ display: 'inline-flex', alignItems: 'center', color: '#0B3D1E', background: 'rgba(34,197,94,0.2)', border: '1px solid rgba(34,197,94,0.5)', borderRadius: 7, fontSize: 11, fontWeight: 700, padding: '6px 10px', cursor: 'pointer' }}
                  onClick={() => { setCloudTab('import'); setCloudOpen(true); fetchCloudList(); setToastOpen(false); }}
                >
                  <svg className="w-3.5 h-3.5 me-1.5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 5v9m-5 0H5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1h-2M8 9l4-5 4 5m1 8h.01"/></svg>
                  View
                </button>
                <button type="button" style={{ display: 'inline-flex', alignItems: 'center', color: '#166534', background: 'transparent', border: '1px solid rgba(34,197,94,0.4)', borderRadius: 7, fontSize: 11, fontWeight: 700, padding: '6px 10px', cursor: 'pointer' }}
                  onClick={() => setToastOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Separator */}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.04)', margin: '0 14px 0 4px', flexShrink: 0 }} />

        {/* Strategy tabs */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '6px 10px', flexShrink: 0,
          background: 'rgba(0,0,0,0.15)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          {/* Card tabs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            {Array.from({ length: strategyCount }, (_, i) => i + 1).map(n => {
              const isActive = activeStrategy === n;
              const tabLegs = isActive ? legs : (strategyLegs[n] ?? []);
              const legCount = tabLegs.length;
              const totalPnl = tabLegs.filter(l => l.checked).reduce((sum, leg) => {
                const ltp = leg.currLtp > 0 ? leg.currLtp : leg.price;
                return sum + (leg.action === 'B' ? ltp - leg.price : leg.price - ltp) * leg.lots * (leg.lotSize || 1);
              }, 0);
              const hasPnl = legCount > 0;
              const pnlColor = totalPnl > 0 ? '#26a69a' : totalPnl < 0 ? '#f23645' : '#9CA3AF';
              const canDelete = strategyCount > 1;
              return (
                <div
                  key={n}
                  style={{
                    flex: '1 1 0', minWidth: 0, maxWidth: 160, position: 'relative',
                    height: 62, borderRadius: 8,
                    display: 'flex', flexDirection: 'row', alignItems: 'center',
                    background: isActive ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)',
                    border: isActive ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(255,255,255,0.1)',
                    boxShadow: isActive ? '0 2px 10px rgba(0,0,0,0.4)' : 'none',
                    transition: 'all 0.13s', overflow: 'hidden', cursor: 'pointer',
                  }}
                  onClick={() => {
                    setStrategyLegs(prev => ({ ...prev, [activeStrategy]: legs }));
                    const nextLegs = strategyLegs[n] ?? [];
                    setLegs(nextLegs);
                    if (nextLegs.length > 0) {
                      setChartSymbol(nextLegs[0].symbol);
                      if (nextLegs[0].exchange) setChartExchange(nextLegs[0].exchange);
                    }
                    setActiveStrategy(n);
                  }}
                  onMouseEnter={e => { if (!isActive) { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)'; (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.09)'; } }}
                  onMouseLeave={e => { if (!isActive) { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)'; (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.05)'; } }}
                >
                  {/* orange accent bar */}
                  {isActive && (
                    <div style={{
                      position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                      background: 'linear-gradient(90deg, #FF9800, rgba(255,152,0,0.35))',
                      borderRadius: '8px 8px 0 0',
                    }} />
                  )}

                  {/* column: name on top, PnL below */}
                  <div style={{
                    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
                    justifyContent: 'center', gap: 5, padding: '0 28px 0 10px',
                  }}>
                    {renamingStrategy === n ? (
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            setStrategyNames(prev => ({ ...prev, [n]: renameValue.trim() || `Strategy ${n}` }));
                            setRenamingStrategy(null);
                          } else if (e.key === 'Escape') {
                            setRenamingStrategy(null);
                          }
                        }}
                        onBlur={() => {
                          setStrategyNames(prev => ({ ...prev, [n]: renameValue.trim() || `Strategy ${n}` }));
                          setRenamingStrategy(null);
                        }}
                        onClick={e => e.stopPropagation()}
                        style={{
                          width: '100%', background: 'rgba(255,152,0,0.08)',
                          border: '1px solid rgba(255,152,0,0.45)', borderRadius: 5,
                          color: '#FFFFFF', fontSize: 13, fontWeight: 600,
                          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
                          padding: '3px 6px', outline: 'none',
                        }}
                        maxLength={20}
                        autoFocus
                      />
                    ) : (
                      <>
                        {/* name row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                          <span style={{
                            fontSize: 13, fontWeight: isActive ? 600 : 500,
                            color: isActive ? '#FFFFFF' : '#C0C4CE',
                            letterSpacing: '0.01em', lineHeight: 1,
                            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{strategyNames[n] ?? `Strategy ${n}`}</span>
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setRenameValue(strategyNames[n] ?? `Strategy ${n}`);
                              setRenamingStrategy(n);
                            }}
                            title="Rename"
                            style={{
                              flexShrink: 0, width: 14, height: 14, borderRadius: 3,
                              background: 'transparent', border: 'none', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              color: '#FFFFFF', opacity: 0.35, padding: 0, transition: 'opacity 0.1s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = '#FF9800'; }}
                            onMouseLeave={e => { e.currentTarget.style.opacity = '0.35'; e.currentTarget.style.color = '#FFFFFF'; }}
                          >
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                            </svg>
                          </button>
                        </div>
                        {/* PnL row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontSize: 16, lineHeight: 1, fontWeight: 800,
                            color: hasPnl ? pnlColor : (isActive ? '#3D4455' : '#252A36'),
                            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
                            letterSpacing: '0.01em',
                          }}>
                            {hasPnl ? `${totalPnl >= 0 ? '+' : ''}₹${Math.abs(totalPnl) >= 1000 ? (totalPnl / 1000).toFixed(1) + 'k' : totalPnl.toFixed(0)}` : '—'}
                          </span>
                          {legCount > 0 && (
                            <span style={{ fontSize: 11, fontWeight: 700, color: isActive ? '#D1D4DC' : '#9CA3AF' }}>
                              {legCount}L
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* delete × button */}
                  {canDelete && (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        const newLegs: Record<number, Leg[]> = {};
                        let newCount = 0;
                        Array.from({ length: strategyCount }, (_, i) => i + 1).forEach(k => {
                          if (k === n) return;
                          newCount++;
                          newLegs[newCount] = k === activeStrategy ? legs : (strategyLegs[k] ?? []);
                        });
                        const newActive = n === activeStrategy
                          ? Math.max(1, n - 1 <= newCount ? n - 1 || 1 : newCount)
                          : activeStrategy > n ? activeStrategy - 1 : activeStrategy;
                        setStrategyLegs(newLegs);
                        setStrategyCount(newCount);
                        setActiveStrategy(newActive);
                        const nextLegs = newLegs[newActive] ?? [];
                        setLegs(nextLegs);
                        if (nextLegs.length > 0) {
                          setChartSymbol(nextLegs[0].symbol);
                          if (nextLegs[0].exchange) setChartExchange(nextLegs[0].exchange);
                        }
                      }}
                      title="Remove strategy"
                      style={{
                        position: 'absolute', top: 6, right: 6,
                        width: 18, height: 18, borderRadius: 4,
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#555B6A', padding: 0, transition: 'all 0.1s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = '#f23645'; e.currentTarget.style.background = 'rgba(242,54,69,0.15)'; e.currentTarget.style.borderColor = 'rgba(242,54,69,0.3)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = '#555B6A'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* + Add strategy */}
          {strategyCount < 6 && (
            <button
              onClick={() => {
                const next = strategyCount + 1;
                setStrategyLegs(prev => ({ ...prev, [next]: [] }));
                setStrategyNames(prev => ({ ...prev, [next]: `Strategy ${next}` }));
                setStrategyCount(next);
              }}
              title="Add strategy"
              style={{
                flexShrink: 0, width: 38, height: 62, borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.07)',
                background: 'rgba(255,255,255,0.025)',
                color: '#4B5563', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.13s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#D1D4DC'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = '#4B5563'; e.currentTarget.style.background = 'rgba(255,255,255,0.025)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>

        {/* Leg rows table */}
        {layoutTheme === 'theme2' ? (
          /* ── Theme 2: flat TanStack table ── */
          <MtmTheme2Table legs={legs} updateLeg={updateLeg} removeLeg={removeLeg} showGreeks={showGreeks} />
        ) : (
          /* ── Theme 1: card / grouped layout ── */
          <div style={{ flex: 1, padding: '0 10px 14px 10px', overflowX: 'auto', overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Shared column header row */}
              {showGreeks ? (
                <div style={{ background: '#333333', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 0, padding: '8px 11px' }}>
                  {headerTable.getHeaderGroups().map(hg => (
                    <React.Fragment key={hg.id}>
                      {hg.headers.map(h => (
                        <React.Fragment key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</React.Fragment>
                      ))}
                    </React.Fragment>
                  ))}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <colgroup>
                    {headerTable.getAllColumns().map(col => (
                      <col key={col.id} style={{ width: col.getSize() }} />
                    ))}
                  </colgroup>
                  <thead>
                    {headerTable.getHeaderGroups().map(hg => (
                      <tr key={hg.id} style={{ background: '#333333', borderRadius: 6 }}>
                        {hg.headers.map(h => (
                          <th key={h.id} style={{ padding: '8px 6px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: '#9CA3AF', letterSpacing: '0.04em', whiteSpace: 'nowrap', fontFamily: 'var(--font-family-sans)' }}>
                            {flexRender(h.column.columnDef.header, h.getContext())}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                </table>
              )}
              {legs.length === 0 && (
                <div style={{ padding: '24px', textAlign: 'center', color: '#3D4150', fontSize: 13 }}>
                  No legs yet — click B or S on the option chain to add
                </div>
              )}
              {(() => {
                // Group legs by symbol
                const groups: { symbol: string; legs: Leg[] }[] = [];
                for (const leg of legs) {
                  const g = groups.find(g => g.symbol === leg.symbol);
                  if (g) g.legs.push(leg);
                  else groups.push({ symbol: leg.symbol, legs: [leg] });
                }
                return groups.map(group => (
                  <MtmGroupTable key={group.symbol} group={group} showGreeks={showGreeks} columns={showGreeks ? greeksColumns : stdColumns} />
                ));
              })()}

            </div>
          </div>
        )}


      </div>


      {/* Option Chain — floats OVER left panel, anchored to its right side */}
      {ocOpen && ocSymbol && (
        <div style={{
          position: 'absolute',
          left: 8, top: 8, bottom: 8,
          width: `calc(${leftPct}% - 16px)`,
          zIndex: 55,
          background: '#171717',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10,
          boxShadow: '0 8px 56px rgba(0,0,0,0.8)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <OptionChain symbol={ocSymbol} expiries={ocExpiries} sessionToken={nubraSession} exchange={ocExchange} onClose={() => setOcOpen(false)} onAddLeg={addLeg} onLtpUpdateRef={{ current: onLtpUpdate }} lotSize={ocLotSize} instruments={instruments} ocSpotRef={ocSpotRef} isHistoricalMode={isHistoricalMode} spotRefId={ocSpotRefId} />
        </div>
      )}

      {/* Divider */}
      <div
        onMouseDown={onMouseDown}
        onDoubleClick={() => setLeftPct(48)}
        style={{ width: 12, flexShrink: 0, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <div style={{ width: 4, height: 32, borderRadius: 2, background: 'rgba(255,255,255,0.08)', transition: 'background 0.15s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.08)'; }}
        />
      </div>

      {/* Right panel — Strategy Chart */}
      <div style={{ flex: 1, minWidth: 0, background: '#171717', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        <StrategyChart legs={legs} ocSymbol={chartSymbol || ocSymbol} ocExchange={chartExchange || ocExchange} instruments={instruments} nubraInstruments={nubraInstruments} nubraIndexes={nubraIndexes} isHistoricalMode={isHistoricalMode} />
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const { instruments, status } = useInstruments();

  // Nubra instruments loaded from IndexedDB — shared across MTM + StrategyChart
  // Auto-refreshes daily: if cached date != today (IST), clears and re-fetches silently
  const [nubraInstruments, setNubraInstruments] = useState<NubraInstrument[]>([]);
  useEffect(() => {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const cacheKey = `prod:${todayIST}`;

    function applyParsed(parsed: any) {
      const refdata: NubraInstrument[] = parsed.refdata ?? parsed;
      const indexRows: NubraInstrument[] = (parsed.indexes ?? []).map((idx: Record<string, string>) => {
        const indexSymbol = idx.INDEX_SYMBOL ?? idx.index_symbol ?? idx.symbol ?? idx.name ?? '';
        const indexName = idx.INDEX_NAME ?? idx.index_name ?? idx.name ?? idx.symbol ?? '';
        const zanskar = idx.ZANSKAR_INDEX_SYMBOL ?? idx.zanskar_index_symbol ?? idx.nubra_name ?? '';
        const exch = idx.EXCHANGE ?? idx.exchange ?? 'NSE';
        return {
          ref_id: idx.ref_id ?? idx.token ?? '',
          stock_name: indexSymbol || indexName,
          nubra_name: zanskar,
          strike_price: null,
          option_type: 'N/A',
          token: idx.token ?? '',
          lot_size: 1,
          tick_size: 0.05,
          asset: indexName || indexSymbol,
          expiry: null,
          exchange: exch,
          derivative_type: 'INDEX',
          isin: '',
          asset_type: 'INDEX',
        };
      });
      setNubraInstruments([...refdata, ...indexRows]);
    }

    async function fetchAndStore() {
      const sessionToken = localStorage.getItem('nubra_session_token');
      if (!sessionToken) return;
      const authToken = localStorage.getItem('nubra_auth_token') ?? '';
      const deviceId = localStorage.getItem('nubra_device_id') ?? '';
      const params = new URLSearchParams({ session_token: sessionToken });
      if (authToken) params.set('auth_token', authToken);
      if (deviceId) params.set('device_id', deviceId);
      try {
        const res = await fetch(`/api/nubra-instruments?${params}`);
        if (!res.ok) return;
        const json = await res.json();
        if ((json.refdata ?? []).length === 0) return;
        await saveNubraInstruments(JSON.stringify(json), cacheKey);
        applyParsed(json);
      } catch { /* silent */ }
    }

    loadNubraInstruments().then(cached => {
      if (cached && cached.date === cacheKey) {
        // Cache is fresh for today — use it
        try { applyParsed(JSON.parse(cached.data)); } catch { /* ignore */ }
      } else {
        // Stale or missing — clear and re-fetch silently
        clearNubraInstruments().catch(() => {});
        fetchAndStore();
      }
    });
  }, []);
  const [page, setPage] = useState<Page>('chart');
  // Tracks which pages have been visited — lazy-mount keep-alive pattern.
  // Once a page is visited it is never unmounted (state + WS survive tab switches).
  const [visited, setVisited] = useState<Set<Page>>(() => new Set<Page>(['chart']));
  const navigateTo = useCallback((p: Page) => { setVisited(prev => { const next = new Set(prev); next.add(p); return next; }); setPage(p); }, []);
  // ── Multi-pane workspace ────────────────────────────────────────────────────
  const { state: workspaceState, dispatch: workspaceDispatch } = useWorkspaceState(instruments);
  // Tracks which pane is currently "active" (last clicked) — navbar search routes here
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const activePaneIdRef = useRef<string | null>(null);
  // Sync ref with state
  const setActivePane = (id: string | null) => {
    activePaneIdRef.current = id;
    setActivePaneId(id);
  };
  // When a pane opens chart search, this routes the selection back to that pane
  const paneSearchCallbackRef = useRef<((ins: Instrument) => void) | null>(null);

  // ── Chart symbol search modal (TradingView-style) ──────────────────────────
  const [showChartSearch, setShowChartSearch] = useState(false);
  const [chartSearchQuery, setChartSearchQuery] = useState('');
  const [chartSearchResults, setChartSearchResults] = useState<Instrument[]>([]);
  const [chartSearchTab, setChartSearchTab] = useState<Tab>('ALL');
  const [chartSearchCursor, setChartSearchCursor] = useState(0);
  const chartSearchListRef = useRef<HTMLDivElement>(null);
  const chartSearchInputRef = useRef<HTMLInputElement>(null);

  const [token, setToken] = useState(() => localStorage.getItem('upstox_token') ?? '');
  const [tokenInput, setTokenInput] = useState(() => localStorage.getItem('upstox_token') ?? '');
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [autoLoginLoading, setAutoLoginLoading] = useState(false);
  const [autoLoginError, setAutoLoginError] = useState('');
  const isConnected = useWsConnected();

  const [showNubraPanel, setShowNubraPanel] = useState(false);
  const [nubraPhone, setNubraPhone] = useState(() => localStorage.getItem('nubra_phone') ?? '');
  const [nubraMpin, setNubraMpin] = useState(() => localStorage.getItem('nubra_mpin') ?? '');
  const [nubraTotpSecret, setNubraTotpSecret] = useState(() => localStorage.getItem('nubra_totp_secret') ?? '');
  const [nubraSession, setNubraSession] = useState(() => localStorage.getItem('nubra_session_token') ?? '');
  const [nubraLogging, setNubraLogging] = useState(false);
  const [nubraError, setNubraError] = useState('');
  const [setupStep, setSetupStep] = useState<'phone' | 'otp' | 'done'>('phone');
  const [setupOtp, setSetupOtp] = useState('');
  const [setupTempToken, setSetupTempToken] = useState('');

  const nubraLoggedIn = !!nubraSession;
  const hasSecret = !!nubraTotpSecret;

  // ── Basket state (lifted to App so navbar can show it) ──────────────────
  const [basketLegs, setBasketLegs] = useState<BasketLeg[]>([]);
  const basketIdRef = useRef(0);
  const [showBasket, setShowBasket] = useState(false);
  const [domLegs, setDomLegs] = useState<BasketLeg[]>([]);
  const [basketPos, setBasketPos] = useState<{ x: number; y: number } | null>(null);
  const basketWrapperRef = useRef<HTMLDivElement>(null);
  const basketDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const execBasketRef = useRef<((legs: BasketLeg[], targetStrategy: number) => void) | null>(null);
  const strategyInfoRef = useRef<{ count: number; names: Record<number, string>; active: number }>({ count: 1, names: { 1: 'Strategy 1' }, active: 1 });
  const [showExecPicker, setShowExecPicker] = useState(false);
  const [pendingBasketLegs, setPendingBasketLegs] = useState<BasketLeg[]>([]);
  const basketBtnRef = useRef<HTMLButtonElement>(null);

  const handleAddToBasket = useCallback((leg: BasketLeg) => {
    setBasketLegs(prev => [...prev, { ...leg, id: ++basketIdRef.current }]);
    setShowBasket(true);
  }, []);

  const handleExecuteBasket = useCallback(() => {
    if (basketLegs.length === 0) return;
    // If only 1 strategy, execute directly; else show picker
    if (strategyInfoRef.current.count <= 1) {
      execBasketRef.current?.(basketLegs, 1);
      setBasketLegs([]);
      setShowBasket(false);
    } else {
      setPendingBasketLegs(basketLegs);
      setShowExecPicker(true);
    }
  }, [basketLegs]);

  const [showCookieInput, setShowCookieInput] = useState(false);
  const [cookieInput, setCookieInput] = useState(() => localStorage.getItem('nubra_raw_cookie') ?? '');
  const nubraHasCookie = !!(localStorage.getItem('nubra_raw_cookie') ?? '').trim();

  const handleNubraLogin = useCallback(async () => {
    if (!nubraPhone || !nubraMpin || !nubraTotpSecret) { setNubraError('Setup required first'); return; }
    setNubraLogging(true); setNubraError('');
    try {
      const res = await fetch('/api/nubra-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: nubraPhone, mpin: nubraMpin, totp_secret: nubraTotpSecret }) });
      const data = await res.json();
      if (!res.ok || !data.session_token) { setNubraError(data.error ?? data.detail?.message ?? 'Login failed'); setNubraLogging(false); return; }
      localStorage.setItem('nubra_session_token', data.session_token);
      localStorage.setItem('nubra_auth_token', data.auth_token);
      if (data.device_id) localStorage.setItem('nubra_device_id', data.device_id);
      localStorage.setItem('nubra_raw_cookie', `authToken=${data.auth_token}; sessionToken=${data.session_token}`);
      setNubraSession(data.session_token); setShowNubraPanel(false);
    } catch (e) { setNubraError(e instanceof Error ? e.message : 'Network error'); }
    setNubraLogging(false);
  }, [nubraPhone, nubraMpin, nubraTotpSecret]);

  const handleNubraSendOtp = useCallback(async () => {
    if (!nubraPhone) { setNubraError('Enter phone number'); return; }
    setNubraLogging(true); setNubraError('');
    try {
      const res = await fetch('/api/nubra-send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: nubraPhone }) });
      const data = await res.json();
      if (!res.ok || !data.temp_token) { setNubraError(data.error ?? data.message ?? 'Failed to send OTP'); setNubraLogging(false); return; }
      setSetupTempToken(data.temp_token); setSetupStep('otp');
    } catch (e) { setNubraError(e instanceof Error ? e.message : 'Network error'); }
    setNubraLogging(false);
  }, [nubraPhone]);

  const handleNubraSetupTotp = useCallback(async () => {
    if (!setupOtp || !nubraMpin) { setNubraError('Enter OTP and MPIN'); return; }
    setNubraLogging(true); setNubraError('');
    try {
      const res = await fetch('/api/nubra-setup-totp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: nubraPhone, otp: setupOtp, mpin: nubraMpin, temp_token: setupTempToken }) });
      const data = await res.json();
      if (!res.ok || !data.secret_key) {
        setNubraError(`${data.error ?? 'Setup failed'}${data.step ? ` (step ${data.step})` : ''}${data.detail?.message ? ': ' + data.detail.message : ''}`);
        setNubraLogging(false); return;
      }
      localStorage.setItem('nubra_phone', nubraPhone); localStorage.setItem('nubra_mpin', nubraMpin);
      localStorage.setItem('nubra_totp_secret', data.secret_key); localStorage.setItem('nubra_session_token', data.session_token);
      localStorage.setItem('nubra_auth_token', data.auth_token);
      if (data.device_id) localStorage.setItem('nubra_device_id', data.device_id);
      localStorage.setItem('nubra_raw_cookie', `authToken=${data.auth_token}; sessionToken=${data.session_token}`);
      setNubraTotpSecret(data.secret_key); setNubraSession(data.session_token); setSetupStep('done'); setShowNubraPanel(false);
    } catch (e) { setNubraError(e instanceof Error ? e.message : 'Network error'); }
    setNubraLogging(false);
  }, [nubraPhone, nubraMpin, setupOtp, setupTempToken]);

  const handleNubraLogout = useCallback(() => {
    ['nubra_session_token', 'nubra_auth_token', 'nubra_raw_cookie'].forEach(k => localStorage.removeItem(k));
    setNubraSession('');
  }, []);

  const handleNubraReset = useCallback(() => {
    ['nubra_phone', 'nubra_mpin', 'nubra_totp_secret', 'nubra_session_token', 'nubra_auth_token', 'nubra_raw_cookie'].forEach(k => localStorage.removeItem(k));
    setNubraPhone(''); setNubraMpin(''); setNubraTotpSecret(''); setNubraSession('');
    setSetupStep('phone'); setSetupOtp(''); setSetupTempToken(''); setNubraError('');
  }, []);

  useEffect(() => { if (token) wsManager.connect(token); }, [token]);

  const handleTokenSave = useCallback(() => {
    const t = tokenInput.trim(); localStorage.setItem('upstox_token', t); setToken(t); setShowTokenInput(false); if (t) wsManager.connect(t);
  }, [tokenInput]);

  const handleAutoLogin = useCallback(() => {
    setAutoLoginLoading(true);
    setAutoLoginError('');
    // Connect directly to backend — bypasses Vite proxy which triggers HMR reload on SSE close
    const es = new EventSource('http://localhost:3001/api/upstox-login-stream');
    let done = false;

    es.addEventListener('token', (e) => {
      done = true;
      es.close();
      try {
        const { access_token } = JSON.parse(e.data);
        localStorage.setItem('upstox_token', access_token);
        setToken(access_token); setTokenInput(access_token); setShowTokenInput(false);
        wsManager.connect(access_token);
      } catch { setAutoLoginError('Invalid token response'); }
      setAutoLoginLoading(false);
    });

    es.addEventListener('error', (e: Event) => {
      done = true;
      es.close();
      try { const d = JSON.parse((e as MessageEvent).data ?? '{}'); setAutoLoginError(d.error ?? 'Login failed'); }
      catch { setAutoLoginError('Login failed'); }
      setAutoLoginLoading(false);
    });

    // onerror fires when SSE connection closes — only treat as error if we never got a token
    es.onerror = () => {
      if (done) return;
      es.close();
      setAutoLoginError('Connection lost');
      setAutoLoginLoading(false);
    };
  }, []);

  const workerRef = useRef<Worker | null>(null);
  const workerReady = useRef(false);
  const mtmWorkerRef = useRef<Worker | null>(null);
  const mtmWorkerReady = useRef(false);
  // 'chart' = chart-modal search, 'mtm' = MTM analyzer search
  const workerModeRef = useRef<'header' | 'chart' | 'mtm'>('header');
  const mtmSearchResultsCallbackRef = useRef<((results: Instrument[]) => void) | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    const mtmWorker = new Worker(new URL('./mtmSearch.worker.ts', import.meta.url), { type: 'module' });
    mtmWorkerRef.current = mtmWorker;
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'READY') workerReady.current = true;
      if (e.data.type === 'RESULTS') {
        if (workerModeRef.current === 'chart') {
          setChartSearchResults(e.data.results);
        } else if (workerModeRef.current === 'mtm') {
          mtmSearchResultsCallbackRef.current?.(e.data.results);
        }
      }
    };
    mtmWorker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'READY') mtmWorkerReady.current = true;
      if (e.data.type === 'RESULTS') {
        mtmSearchResultsCallbackRef.current?.(e.data.results);
      }
    };
    return () => { worker.terminate(); mtmWorker.terminate(); };
  }, []);

  useEffect(() => {
    if (status.phase === 'ready' && instruments.length > 0 && workerRef.current) {
      workerRef.current.postMessage({ type: 'BUILD', instruments });
    }
  }, [status.phase, instruments]);

  useEffect(() => {
    if (status.phase !== 'ready' || !mtmWorkerRef.current) return;
    if (nubraInstruments.length === 0 && instruments.length === 0) return;
    const up = (s?: string) => (s ?? '').toUpperCase().trim();

    const nubraItems = nubraInstruments.map(item => {
      const sym = item.stock_name || item.nubra_name || item.asset || '';
      const asset = item.asset || sym;
      return {
        instrument_key: `${item.exchange}:${sym || asset}`,
        trading_symbol: sym || asset,
        underlying_symbol: asset || sym,
        name: sym || asset,
        exchange: item.exchange,
        stock_name: item.stock_name,
        nubra_name: item.nubra_name,
        asset: item.asset,
        derivative_type: item.derivative_type,
        asset_type: item.asset_type,
        option_type: item.option_type,
        expiry: item.expiry ?? null,
        strike_price: item.strike_price ?? null,
        nubraAssetType: item.asset_type ?? '',
      };
    });

    const mcxItems = instruments
      .filter(ins => ins.exchange === 'MCX')
      .map(ins => {
        const sym = ins.trading_symbol ?? '';
        const asset = ins.underlying_symbol || sym;
        const it = (ins.instrument_type ?? '').toUpperCase();
        const opt = it === 'CE' || it === 'PE' ? it : 'N/A';
        const dt = opt !== 'N/A' ? 'OPT' : it.includes('FUT') ? 'FUT' : 'STOCK';
        return {
          instrument_key: ins.instrument_key,
          trading_symbol: sym,
          underlying_symbol: asset,
          name: ins.name ?? sym,
          exchange: ins.exchange,
          stock_name: sym,
          nubra_name: '',
          asset,
          derivative_type: dt,
          asset_type: 'MCX',
          option_type: opt,
          expiry: ins.expiry ?? null,
          strike_price: ins.strike_price ?? null,
          instrument_type: it,
          segment: ins.segment,
          nubraAssetType: 'MCX',
        };
      });

    const combined = [...nubraItems, ...mcxItems];
    mtmWorkerRef.current.postMessage({ type: 'BUILD', instruments: combined });
  }, [status.phase, nubraInstruments, instruments]);

  const chartSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChartSearchChange = useCallback((v: string) => {
    setChartSearchQuery(v);
    setChartSearchCursor(0);
    if (chartSearchDebounce.current) clearTimeout(chartSearchDebounce.current);
    if (!v.trim()) { setChartSearchResults([]); return; }
    chartSearchDebounce.current = setTimeout(() => {
      if (workerRef.current && workerReady.current) {
        workerModeRef.current = 'chart';
        workerRef.current.postMessage({ type: 'SEARCH', query: v });
      }
    }, 150);
  }, []);

  const openChartSearch = useCallback((seedChar?: string) => {
    setChartSearchQuery(seedChar ?? '');
    setChartSearchResults([]);
    setChartSearchTab('ALL');
    setShowChartSearch(true);
    if (seedChar && workerRef.current && workerReady.current) {
      workerModeRef.current = 'chart';
      workerRef.current.postMessage({ type: 'SEARCH', query: seedChar });
    }
    // Focus input after React has painted the modal
    requestAnimationFrame(() => {
      const el = chartSearchInputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, []);

  const closeChartSearch = useCallback(() => {
    setShowChartSearch(false);
    setChartSearchQuery('');
    setChartSearchResults([]);
    setChartSearchCursor(0);
  }, []);

  const chartTabResults = filterByTab(chartSearchResults, chartSearchTab);

  const handleChartSelectInstrument = useCallback((ins: Instrument) => {
    if (paneSearchCallbackRef.current) {
      paneSearchCallbackRef.current(ins);
      paneSearchCallbackRef.current = null;
    } else {
      navigateTo('chart');
    }
    closeChartSearch();
  }, [closeChartSearch, navigateTo]);

  // ── Global keydown → open chart search modal ───────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (showChartSearch) {
        if (e.key === 'Escape') { closeChartSearch(); e.preventDefault(); }
        return;
      }
      if (page !== 'chart') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { openChartSearch(''); e.preventDefault(); return; }
      if (e.key.length === 1) { openChartSearch(e.key); e.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [page, showChartSearch, openChartSearch, closeChartSearch]);

  // Auto-activate first pane on mount / when panes change and nothing is active
  useEffect(() => {
    if (!activePaneIdRef.current && workspaceState.panes.length > 0) {
      const id = workspaceState.panes[0].id;
      queueMicrotask(() => setActivePane(id));
    }
  }, [workspaceState.panes]);

  if (status.phase !== 'ready') return <LoadingScreen status={status} />;

  const NAV_ITEMS: { page: Page; label: string; icon: React.ReactNode }[] = [
    { page: 'chart', label: 'Charts', icon: <IconBarChart2 /> },
    { page: 'straddle', label: 'Straddle', icon: <IconLayers /> },
    { page: 'oiprofile', label: 'OI Profile', icon: <IconActivity /> },
    { page: 'nubra', label: 'Nubra IV', icon: <IconFlask /> },
    { page: 'backtest', label: 'Backtest', icon: <IconClock /> },
    { page: 'historical', label: 'Historical', icon: <IconHistory /> },
  ];

  return (
    <SidebarProvider defaultOpen={true}>
      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <Sidebar>
        {/* Logo */}
        <SidebarHeader>
          <div className="flex items-center gap-2 px-1 py-1">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-[rgba(255,152,0,0.15)] border border-[rgba(255,152,0,0.3)]">
              <IconBolt />
            </div>
            <span className="text-[13px] font-bold tracking-[0.15em] text-[#FF9800]" style={{ fontFamily: 'var(--font-family-sans)' }}>Urjaa</span>
          </div>
        </SidebarHeader>

        {/* Nav */}
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map(({ page: p, label, icon }) => (
                  <SidebarMenuItem key={p}>
                    <SidebarMenuButton
                      isActive={page === p}
                      onClick={() => navigateTo(p)}
                      className="cursor-pointer"
                    >
                      {icon}
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        {/* Footer — connection status */}
        <SidebarFooter>
          <div className="space-y-1.5">
            {/* Upstox WS */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <StatusDot status={isConnected ? 'ok' : 'off'} />
                <span className="text-[11px] font-medium text-[#787B86]">
                  {isConnected ? 'Upstox Live' : token ? <WsStatus key={token} token={token} /> : 'Upstox'}
                </span>
              </div>
              <Btn variant={isConnected ? 'green' : 'default'} onClick={() => setShowTokenInput(v => !v)} title="Set Upstox token">
                <IconBolt />
              </Btn>
            </div>

            {/* Token input panel */}
            {showTokenInput && (
              <div className="flex flex-col gap-1.5 pt-1">
                <TextInput value={tokenInput} onChange={setTokenInput} onEnter={handleTokenSave} onEscape={() => setShowTokenInput(false)} placeholder="Paste Upstox token…" autoFocus />
                <div className="flex gap-1">
                  <Btn variant="primary" onClick={handleTokenSave}>Connect</Btn>
                  <Btn variant="indigo" onClick={handleAutoLogin} loading={autoLoginLoading}>Auto</Btn>
                  <Btn variant="ghost" onClick={() => setShowTokenInput(false)}><IconClose /></Btn>
                </div>
                {autoLoginError && (
                  <span className="text-[11px] text-red-400 leading-tight">{autoLoginError}</span>
                )}
                {autoLoginLoading && (
                  <span className="text-[11px] text-[#787B86] animate-pulse">Launching browser login… (up to 90s)</span>
                )}
              </div>
            )}

            {/* Nubra */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <StatusDot status={nubraLoggedIn ? 'warn' : 'off'} />
                <span className="text-[11px] font-medium text-[#787B86]">
                  {nubraLoggedIn ? 'Nubra' : hasSecret ? 'Nubra' : 'Nubra'}
                </span>
              </div>
              <Btn variant={nubraLoggedIn ? 'amber' : 'default'} onClick={() => nubraLoggedIn ? handleNubraLogout() : setShowNubraPanel(v => !v)} title="Nubra login">
                <IconApi />
              </Btn>
            </div>

            {/* Nubra panel */}
            {showNubraPanel && (
              <div className="flex flex-col gap-1.5 pt-1">
                {!hasSecret ? (
                  setupStep === 'phone' ? (
                    <>
                      <TextInput value={nubraPhone} onChange={setNubraPhone} onEnter={handleNubraSendOtp} placeholder="Phone number" autoFocus />
                      <div className="flex gap-1">
                        <Btn variant="primary" loading={nubraLogging} onClick={handleNubraSendOtp}>Send OTP</Btn>
                        <Btn variant="ghost" onClick={() => { setShowNubraPanel(false); setNubraError(''); }}><IconClose /></Btn>
                      </div>
                    </>
                  ) : (
                    <>
                      <TextInput value={setupOtp} onChange={setSetupOtp} placeholder="OTP" autoFocus />
                      <TextInput value={nubraMpin} onChange={setNubraMpin} onEnter={handleNubraSetupTotp} placeholder="MPIN" type="password" />
                      <div className="flex gap-1">
                        <Btn variant="green" loading={nubraLogging} onClick={handleNubraSetupTotp}>Setup</Btn>
                        <Btn variant="ghost" onClick={() => { setShowNubraPanel(false); setNubraError(''); setSetupStep('phone'); setSetupOtp(''); }}><IconClose /></Btn>
                      </div>
                    </>
                  )
                ) : (
                  <>
                    <span className="text-[10px] text-[#787B86] px-1 truncate">{nubraPhone}</span>
                    <TextInput value={nubraMpin} onChange={setNubraMpin} onEnter={handleNubraLogin} placeholder="MPIN" type="password" autoFocus />
                    <div className="flex gap-1">
                      <Btn variant="primary" loading={nubraLogging} onClick={handleNubraLogin}>Login</Btn>
                      <Btn variant="ghost" onClick={handleNubraReset}>Reset</Btn>
                      <Btn variant="ghost" onClick={() => { setShowNubraPanel(false); setNubraError(''); }}><IconClose /></Btn>
                    </div>
                  </>
                )}
                {nubraError && <span className="text-[10px] text-[#f23645] px-1 truncate">{nubraError}</span>}
              </div>
            )}

            {/* Cookie */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <StatusDot status={nubraHasCookie ? 'indigo' : 'off'} />
                <span className="text-[11px] font-medium text-[#787B86]">{nubraHasCookie ? 'Cookie ✓' : 'Cookie'}</span>
              </div>
              <Btn variant={nubraHasCookie ? 'indigo' : 'default'} onClick={() => { setCookieInput(localStorage.getItem('nubra_raw_cookie') ?? ''); setShowCookieInput(v => !v); }} title="Set Nubra cookie">
                <IconCookie />
              </Btn>
            </div>

            {showCookieInput && (
              <div className="flex flex-col gap-1.5 pt-1">
                <TextAreaInput value={cookieInput} onChange={setCookieInput} placeholder="Paste Nubra cookie…" autoFocus />
                <div className="flex gap-1">
                  <Btn variant="indigo" onClick={() => { localStorage.setItem('nubra_raw_cookie', cookieInput.trim()); setShowCookieInput(false); }}>Save</Btn>
                  <Btn variant="ghost" onClick={() => setShowCookieInput(false)}><IconClose /></Btn>
                </div>
              </div>
            )}

            {/* Instrument count */}
            <div className="px-1 pt-1 text-[10px] text-[#787B86]">
              {status.total.toLocaleString()} instruments cached
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* ── Main area ───────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col min-w-0 h-screen">
        {/* Top bar */}
        <header className="glass-navbar flex h-12 shrink-0 items-center gap-3 px-4" style={{ minHeight: 48, fontFamily: 'var(--font-family-sans)', textTransform: 'none' }}>
          <SidebarTrigger />
          <div className="h-5 w-px bg-[#2a2a2a]" />

          {/* Page title when not on chart */}
          {page !== 'chart' && page !== 'mtm' && (
            <span className="text-[13px] font-semibold text-[#D1D4DC]" style={{ fontFamily: 'var(--font-family-sans)', textTransform: 'none' }}>
              {NAV_ITEMS.find(n => n.page === page)?.label}
            </span>
          )}

          {/* Navbar links */}
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={() => navigateTo('mtm')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                height: 32, padding: '0 14px',
                borderRadius: 7,
                fontSize: 13, fontWeight: 700, letterSpacing: '0.01em',
                cursor: 'pointer',
                border: page === 'mtm' ? '1px solid rgba(79,142,247,0.45)' : '1px solid transparent',
                background: page === 'mtm' ? 'rgba(79,142,247,0.18)' : 'transparent',
                color: page === 'mtm' ? '#FFFFFF' : '#D1D4DC',
                boxShadow: page === 'mtm' ? '0 0 12px rgba(79,142,247,0.25)' : 'none',
                transition: 'background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s',
              }}
              onMouseEnter={e => { if (page !== 'mtm') { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLElement).style.color = '#FFFFFF'; } }}
              onMouseLeave={e => { if (page !== 'mtm') { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#D1D4DC'; } }}
            >
              <span style={{ lineHeight: 0, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, background: page === 'mtm' ? 'rgba(79,142,247,0.25)' : 'rgba(255,255,255,0.08)', border: page === 'mtm' ? '1px solid rgba(79,142,247,0.55)' : '1px solid rgba(255,255,255,0.12)', color: page === 'mtm' ? '#7EB8FF' : '#C9D1DC', transition: 'background 0.15s, border-color 0.15s, color 0.15s' }}><IconTrendingUp /></span>
              <span style={{ lineHeight: 1, fontFamily: 'var(--font-family-sans)', textTransform: 'none' }}>Mtm Analyzer</span>
            </button>

            {/* Basket icon button */}
            <button
              ref={basketBtnRef}
              onClick={() => setShowBasket(b => !b)}
              title="Basket Order"
              style={{ position: 'relative', width: 36, height: 32, background: showBasket ? 'rgba(37,99,235,0.18)' : 'transparent', border: `1px solid ${showBasket ? 'rgba(37,99,235,0.5)' : 'transparent'}`, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={e => { if (!showBasket) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.07)'; }}
              onMouseLeave={e => { if (!showBasket) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={showBasket ? '#3b82f6' : '#9CA3AF'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
              {basketLegs.length > 0 && (
                <span style={{ position: 'absolute', top: 3, right: 3, minWidth: 14, height: 14, borderRadius: 7, background: '#2563eb', fontSize: 9, fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px', lineHeight: 1 }}>{basketLegs.length}</span>
              )}
            </button>
          </div>

        </header>

        {/* Page content
            Strategy: lazy-mount + keep-alive.
            - A page mounts only on first visit (no upfront cost).
            - After first visit it is never unmounted — state, WS subs, and
              chart instances all survive tab switches.
            - We use visibility:hidden / pointer-events:none (not display:none)
              so Ant Design / glide-data-grid can still measure the DOM and
              never trigger the "Maximum update depth exceeded" setState loop.
            - Heavy pages (OI Profile, Backtest) stay on-demand: mount on
              visit, unmount on leave, to avoid 300+ idle WS subscriptions.
        */}
        <main className="flex-1 overflow-hidden relative" style={{ background: '#171717' }}>
          {/* Keep-alive pattern: every page is absolute inset-0.
              - display:none  → safe for pages with no Ant Design (Chart, Straddle)
              - visibility:hidden → for pages with Ant Design (Nubra, Historical)
                so their components can still measure DOM without infinite setState loops.
              - Lazy-mount: only added to DOM on first visit. */}

          {/* Chart — multi-pane workspace */}
          {(page === 'chart' || visited.has('chart')) && (
            <div className="absolute inset-0" style={{ display: page === 'chart' ? 'flex' : 'none' }}>
              <WorkspaceRoot
                state={workspaceState}
                dispatch={workspaceDispatch}
                instruments={instruments}
                activePaneId={activePaneId}
                onPaneClick={setActivePane}
                onPaneSearch={(paneId, onSelect) => {
                  setActivePane(paneId);
                  paneSearchCallbackRef.current = onSelect;
                  openChartSearch('');
                }}
              />
            </div>
          )}

          {/* Straddle — display:none safe (no Ant Design) */}
          {(page === 'straddle' || visited.has('straddle')) && (
            <div className="absolute inset-0" style={{ display: page === 'straddle' ? 'block' : 'none' }}>
              <StraddleChart instruments={instruments} visible={page === 'straddle'} />
            </div>
          )}

          {/* Nubra IV — visibility:hidden (uses Ant Design, needs DOM measurement) */}
          {(page === 'nubra' || visited.has('nubra')) && (
            <div className="absolute inset-0" style={{ visibility: page === 'nubra' ? 'visible' : 'hidden', pointerEvents: page === 'nubra' ? 'auto' : 'none', zIndex: page === 'nubra' ? 1 : 0 }}>
              <NubraApiTester />
            </div>
          )}

          {/* Historical — visibility:hidden (uses Ant Design) */}
          {(page === 'historical' || visited.has('historical')) && (
            <div className="absolute inset-0" style={{ visibility: page === 'historical' ? 'visible' : 'hidden', pointerEvents: page === 'historical' ? 'auto' : 'none', zIndex: page === 'historical' ? 1 : 0 }}>
              <HistoricalWorkspace />
            </div>
          )}

          {/* OI Profile — keep-alive with visibility */}
          {(page === 'oiprofile' || visited.has('oiprofile')) && (
            <div className="absolute inset-0" style={{ visibility: page === 'oiprofile' ? 'visible' : 'hidden', pointerEvents: page === 'oiprofile' ? 'auto' : 'none', zIndex: page === 'oiprofile' ? 1 : 0 }}>
              <OIProfileView instruments={instruments} />
            </div>
          )}

          {/* Backtest — keep-alive with visibility */}
          {(page === 'backtest' || visited.has('backtest')) && (
            <div className="absolute inset-0" style={{ visibility: page === 'backtest' ? 'visible' : 'hidden', pointerEvents: page === 'backtest' ? 'auto' : 'none', zIndex: page === 'backtest' ? 1 : 0 }}>
              <Backtest />
            </div>
          )}

          {/* MTM Analyzer */}
          {(page === 'mtm' || visited.has('mtm')) && (
            <MtmLayout visible={page === 'mtm'} mtmResultsCbRef={mtmSearchResultsCallbackRef} mtmWorkerRef={mtmWorkerRef} mtmWorkerReady={mtmWorkerReady} instruments={instruments} nubraInstruments={nubraInstruments} onAddToBasket={handleAddToBasket} execBasketRef={execBasketRef} strategyInfoRef={strategyInfoRef} />
          )}

        </main>
      </div>

      {/* ── Basket Order (draggable) ───────────────────────────────── */}
      {showBasket && (
        <div
          ref={basketWrapperRef}
          style={{
            position: 'fixed',
            top: basketPos ? basketPos.y : 52,
            left: basketPos ? basketPos.x : 'unset',
            right: basketPos ? 'unset' : 16,
            zIndex: 300,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            willChange: 'transform',
          }}
        >
          {/* DOM side panel — floats to the left of the basket */}
          {domLegs.length > 0 && (
            <DomSidePanel
              legs={domLegs}
              onClose={id => setDomLegs(prev => prev.filter(l => l.id !== id))}
            />
          )}
          {/* Basket panel */}
          <div style={{ width: 680, borderRadius: 10, boxShadow: '0 8px 40px rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden', background: '#1a1a1a' }}>
            {basketLegs.length === 0 ? (
              <div style={{ padding: '32px 20px', textAlign: 'center', color: '#4B5563', fontSize: 13 }}>
                No legs — click B or S in the Option Chain to add
              </div>
            ) : (
              <BasketOrder
                legs={basketLegs}
                onRemove={id => { setBasketLegs(prev => prev.filter(l => l.id !== id)); setDomLegs(prev => prev.filter(l => l.id !== id)); }}
                onUpdateLots={(id, lots) => setBasketLegs(prev => prev.map(l => l.id === id ? { ...l, lots } : l))}
                onUpdateLeg={(id, patch) => {
                  setBasketLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
                  setDomLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
                }}
                onExecute={handleExecuteBasket}
                onClear={() => { setBasketLegs([]); setShowBasket(false); setDomLegs([]); }}
                domLegs={domLegs}
                onDomToggle={leg => setDomLegs(prev => prev.some(d => d.id === leg.id) ? prev.filter(d => d.id !== leg.id) : [...prev, leg])}
                onDragStart={e => {
                  e.preventDefault();
                  const el = basketWrapperRef.current;
                  if (!el) return;
                  // Snapshot current pixel position (works even on first drag from right:16)
                  const rect = el.getBoundingClientRect();
                  const startX = e.clientX;
                  const startY = e.clientY;
                  let curX = rect.left;
                  let curY = rect.top;
                  // Pin to left/top immediately so no jump
                  el.style.right = 'unset';
                  el.style.left = curX + 'px';
                  el.style.top = curY + 'px';
                  basketDragRef.current = { startX, startY, origX: curX, origY: curY };

                  const onMove = (me: MouseEvent) => {
                    if (!basketDragRef.current) return;
                    curX = basketDragRef.current.origX + me.clientX - basketDragRef.current.startX;
                    curY = basketDragRef.current.origY + me.clientY - basketDragRef.current.startY;
                    // Direct DOM update — zero re-renders during drag
                    el.style.left = curX + 'px';
                    el.style.top = curY + 'px';
                  };
                  const onUp = () => {
                    basketDragRef.current = null;
                    setBasketPos({ x: curX, y: curY });
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                  };
                  window.addEventListener('mousemove', onMove);
                  window.addEventListener('mouseup', onUp);
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Execute to Strategy Picker ───────────────────────────── */}
      {showExecPicker && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseDown={e => { if (e.target === e.currentTarget) setShowExecPicker(false); }}
        >
          <div style={{
            background: '#1a1d27', borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 40px 100px rgba(0,0,0,0.8)',
            padding: '24px 24px 20px',
            width: 360, maxWidth: '90vw',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#E2E8F0', letterSpacing: '0.01em' }}>
                  Execute to Strategy
                </div>
                <div style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>
                  {pendingBasketLegs.length} leg{pendingBasketLegs.length !== 1 ? 's' : ''} · choose a strategy tab
                </div>
              </div>
              <button
                onClick={() => setShowExecPicker(false)}
                style={{ background: 'none', border: 'none', color: '#6B7280', cursor: 'pointer', padding: 4, fontSize: 18, lineHeight: 1 }}
              >×</button>
            </div>

            {/* Strategy cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Array.from({ length: strategyInfoRef.current.count }, (_, i) => i + 1).map(n => {
                const isActive = strategyInfoRef.current.active === n;
                const name = strategyInfoRef.current.names[n] ?? `Strategy ${n}`;
                return (
                  <button
                    key={n}
                    onClick={() => {
                      execBasketRef.current?.(pendingBasketLegs, n);
                      setBasketLegs([]);
                      setShowBasket(false);
                      setShowExecPicker(false);
                      setPendingBasketLegs([]);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', borderRadius: 9,
                      background: isActive ? 'rgba(255,152,0,0.08)' : 'rgba(255,255,255,0.04)',
                      border: isActive ? '1px solid rgba(255,152,0,0.35)' : '1px solid rgba(255,255,255,0.08)',
                      cursor: 'pointer', transition: 'all 0.12s', textAlign: 'left',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLButtonElement).style.background = isActive ? 'rgba(255,152,0,0.14)' : 'rgba(255,255,255,0.08)';
                      (e.currentTarget as HTMLButtonElement).style.borderColor = isActive ? 'rgba(255,152,0,0.5)' : 'rgba(255,255,255,0.15)';
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLButtonElement).style.background = isActive ? 'rgba(255,152,0,0.08)' : 'rgba(255,255,255,0.04)';
                      (e.currentTarget as HTMLButtonElement).style.borderColor = isActive ? 'rgba(255,152,0,0.35)' : 'rgba(255,255,255,0.08)';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 7,
                        background: isActive ? 'rgba(255,152,0,0.15)' : 'rgba(255,255,255,0.06)',
                        border: isActive ? '1px solid rgba(255,152,0,0.4)' : '1px solid rgba(255,255,255,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 700, color: isActive ? '#FF9800' : '#9CA3AF',
                      }}>S{n}</div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? '#FF9800' : '#D1D5DB' }}>{name}</span>
                      {isActive && (
                        <span style={{ fontSize: 10, color: '#FF9800', background: 'rgba(255,152,0,0.12)', padding: '2px 7px', borderRadius: 5, fontWeight: 600 }}>active</span>
                      )}
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isActive ? '#FF9800' : '#6B7280'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Chart Symbol Search Modal ─────────────────────────────── */}
      {showChartSearch && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center pt-[8vh]"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', animation: 'fadeIn 0.12s ease' }}
          onMouseDown={e => { if (e.target === e.currentTarget) closeChartSearch(); }}
        >
          <div style={{
            width: 660, maxHeight: '78vh', display: 'flex', flexDirection: 'column',
            borderRadius: 14,
            background: 'rgba(15,18,27,0.98)',
            border: '1px solid rgba(255,255,255,0.09)',
            boxShadow: '0 40px 100px rgba(0,0,0,0.85), 0 1px 0 rgba(255,255,255,0.06) inset',
            overflow: 'hidden',
            animation: 'slideUp 0.14s cubic-bezier(0.16,1,0.3,1)',
          }}>
            {/* Search input — full-width, no title bar */}
            <div style={{ padding: '14px 16px 0' }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <span style={{ position: 'absolute', left: 14, color: '#4A4E5C', pointerEvents: 'none', display: 'flex', transition: 'color 0.15s' }}><IconSearch /></span>
                <input
                  ref={chartSearchInputRef}
                  value={chartSearchQuery}
                  onChange={e => handleChartSearchChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { closeChartSearch(); return; }
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      const next = Math.min(chartSearchCursor + 1, chartTabResults.length - 1);
                      setChartSearchCursor(next);
                      chartSearchListRef.current?.children[next]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      const prev = Math.max(chartSearchCursor - 1, 0);
                      setChartSearchCursor(prev);
                      chartSearchListRef.current?.children[prev]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    } else if (e.key === 'Enter' && chartTabResults.length > 0) {
                      handleChartSelectInstrument(chartTabResults[chartSearchCursor]);
                    }
                  }}
                  placeholder="Search symbol…"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '11px 40px 11px 42px',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 10, outline: 'none', fontSize: 15, fontWeight: 500,
                    color: '#E8EAF0', letterSpacing: '-0.01em', caretColor: '#4F8EF7',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(79,142,247,0.5)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(79,142,247,0.10)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = 'none'; }}
                />
                {chartSearchQuery && (
                  <button onClick={() => { setChartSearchQuery(''); setChartSearchResults([]); setChartSearchCursor(0); }} style={{ position: 'absolute', right: 12, background: 'rgba(255,255,255,0.07)', border: 'none', cursor: 'pointer', color: '#787B86', display: 'flex', padding: 3, borderRadius: 4 }}><IconClose /></button>
                )}
              </div>
            </div>

            {/* Tab pills */}
            <div style={{ display: 'flex', gap: 4, padding: '10px 16px 10px', flexWrap: 'wrap' }}>
              {TABS.map(t => (
                <button key={t} onClick={() => { setChartSearchTab(t); setChartSearchCursor(0); }} style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                  border: '1px solid', cursor: 'pointer', transition: 'all 0.12s', lineHeight: 1.5,
                  background: chartSearchTab === t ? 'rgba(79,142,247,0.15)' : 'transparent',
                  borderColor: chartSearchTab === t ? 'rgba(79,142,247,0.4)' : 'rgba(255,255,255,0.08)',
                  color: chartSearchTab === t ? '#4F8EF7' : '#565A6B',
                }}>
                  {t}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />

            {/* Results */}
            <div ref={chartSearchListRef} style={{ overflowY: 'auto', flex: 1, scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
              {!chartSearchQuery.trim() ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 12, color: '#2E3240', letterSpacing: '0.06em' }}>
                  Search across {status.total.toLocaleString()} instruments
                </div>
              ) : chartTabResults.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 12, color: '#3D4150' }}>No results for "{chartSearchQuery}"</div>
              ) : chartTabResults.map((ins, i) => (
                <div key={ins.instrument_key}
                  onClick={() => handleChartSelectInstrument(ins)}
                  onMouseEnter={() => setChartSearchCursor(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    padding: '11px 18px', cursor: 'pointer',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    background: i === chartSearchCursor ? 'rgba(79,142,247,0.10)' : 'transparent',
                    transition: 'background 0.08s',
                    willChange: 'background',
                  }}
                >
                  {/* Exchange logo / badge */}
                  <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {ins.exchange === 'NSE' ? (
                      <img src="https://s3-symbol-logo.tradingview.com/source/NSE.svg" alt="NSE" style={{ width: 24, height: 24, objectFit: 'contain', opacity: 0.85 }} />
                    ) : ins.exchange === 'BSE' ? (
                      <img src="https://s3-symbol-logo.tradingview.com/source/BSE.svg" alt="BSE" style={{ width: 24, height: 24, objectFit: 'contain', opacity: 0.85 }} />
                    ) : ins.exchange === 'MCX' ? (
                      <img src="https://s3-symbol-logo.tradingview.com/source/MCX.svg" alt="MCX" style={{ width: 24, height: 24, objectFit: 'contain', opacity: 0.85 }} />
                    ) : (
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#9598A1', letterSpacing: '0.04em' }}>{ins.exchange}</span>
                    )}
                  </div>

                  {/* Symbol + name */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#E0E3EB', letterSpacing: '0.01em' }}>
                      <Highlight text={ins.trading_symbol} query={chartSearchQuery} />
                    </div>
                    <div style={{ fontSize: 12, color: '#565A6B', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Highlight text={ins.name} query={chartSearchQuery} />
                    </div>
                  </div>

                  {/* Type pill */}
                  <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, background: 'rgba(255,255,255,0.05)', color: '#565A6B', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', flexShrink: 0 }}>
                    {ins.instrument_type}
                  </span>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)' }}>
              <span style={{ fontSize: 11, color: '#4A4E5C' }}><kbd style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>↵</kbd> select</span>
              <span style={{ fontSize: 11, color: '#4A4E5C' }}><kbd style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>Esc</kbd> close</span>
            </div>
          </div>
        </div>
      )}
    </SidebarProvider>
  );

}





