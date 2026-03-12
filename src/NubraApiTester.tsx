'use client';

/**
 * NubraApiTester — Postman-style tester for the Nubra Multi-Strike IV API
 *
 * Sends requests through /api/nubra-timeseries (your local proxy) so CORS
 * is bypassed. Auth tokens are stored in localStorage for convenience.
 *
 * Request format:
 *   POST /api/nubra-timeseries
 *   { authToken, sessionToken, chart, query: [...] }
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Button, Input as AntInput, Tabs, Alert, Spin, Badge } from 'antd';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NubraQueryItem {
  exchange: string;
  type: 'STRIKE' | 'STOCK' | 'INDEX';
  values: string[];
  fields: string[];
  interval: string;
  intraDay: boolean;
  realTime: boolean;
  startDate: string;
  endDate: string;
}

type TabKey = 'auth' | 'query' | 'atm' | 'response' | 'quote' | 'dhan' | 'multistrike' | 'upstox-auth';
type StatusKind = 'idle' | 'loading' | 'ok' | 'error';

const LS_COOKIE = 'nubra_raw_cookie';
const LS_DHAN_JWT = 'dhan_jwt';

// Default Dhan opt_chart payload (matches captured request exactly)
// Dhan expects: POST { data: { ... } }
// u_id: 13 = NIFTY, u_seg_id: 0 = NSE F&O
// exp_flag: "W" = weekly, "M" = monthly
// exp_code: 1 = nearest expiry, 2 = next, etc.
// interval: "1m" | "3m" | "5m" | "15m" | "1h" | "1d"
function getDefaultDhanPayload() {
  const ist = new Date(Date.now() + 330 * 60_000);
  const ymd = ist.toISOString().slice(0, 10); // YYYY-MM-DD
  const startTime = Math.floor(new Date(`${ymd}T09:15:00+05:30`).getTime() / 1000);
  const endTime   = Math.floor(new Date(`${ymd}T15:30:00+05:30`).getTime() / 1000);
  return {
    data: {
      start_time:    startTime,
      end_time:      endTime,
      u_id:          13,
      u_seg_id:      0,
      exp_flag:      'W',
      exp_code:      1,
      option_type:   '',
      required_data: ['iv', 'strike', 'spot'],
      interval:      '5m',
      strikepos:     0,
    },
  };
}

// Default Multistrike OI payload
function getDefaultMultistrikePayload() {
  const now = new Date();
  // Round down to nearest 15m in IST
  const istMs = now.getTime() + 330 * 60_000;
  const istDate = new Date(istMs);
  istDate.setUTCMinutes(Math.floor(istDate.getUTCMinutes() / 15) * 15, 0, 0);
  const time = new Date(istDate.getTime() - 330 * 60_000).toISOString().replace('.000Z', '.000Z');
  return [
    {
      exchange: 'NSE',
      asset: 'NIFTY',
      expiries: ['20260302'],
      fields: ['cumulative_oi'],
      strikes: [23000, 23050, 23100, 23150, 23200, 23250, 23300, 23350, 23400, 23450, 23500].map(s => s * 100),
      minStrike: 2294690,
      maxStrike: 2804621,
      time,
    },
  ];
}

// Default ATM Volatility query
function getDefaultAtmQuery() {
  const { startDate, endDate } = getDefaultDates();
  return [
    {
      exchange: 'NSE',
      type: 'CHAIN',
      values: ['NIFTY_20260302'],
      fields: ['atm_iv'],
      interval: '1m',
      intraDay: false,
      realTime: false,
      startDate,
      endDate,
    },
    {
      exchange: 'NSE',
      type: 'INDEX',
      values: ['NIFTY'],
      fields: ['value'],
      interval: '1m',
      intraDay: false,
      realTime: false,
      startDate,
      endDate,
    },
  ];
}

// Default example query (same structure as the captured request)
const DEFAULT_QUERY: NubraQueryItem[] = [
  {
    exchange: 'NSE',
    type: 'STRIKE',
    values: ['PNB_20260224_12900'],
    fields: ['iv_otm'],
    interval: '1m',
    intraDay: false,
    realTime: false,
    startDate: '',
    endDate: '',
  },
  {
    exchange: 'NSE',
    type: 'STOCK',
    values: ['PNB'],
    fields: ['value'],
    interval: '1m',
    intraDay: false,
    realTime: false,
    startDate: '',
    endDate: '',
  },
];

// Fill today's IST date range as default
function getDefaultDates() {
  const now   = new Date();
  // IST offset = +5:30 = 330 min
  const ist   = new Date(now.getTime() + 330 * 60_000);
  const yyyy  = ist.getUTCFullYear();
  const mm    = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd    = String(ist.getUTCDate()).padStart(2, '0');

  // Previous trading day for startDate (simple: just subtract 1 day)
  const prev  = new Date(ist.getTime() - 24 * 60 * 60_000);
  const pyyyy = prev.getUTCFullYear();
  const pmm   = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const pdd   = String(prev.getUTCDate()).padStart(2, '0');

  return {
    startDate: `${pyyyy}-${pmm}-${pdd}T18:30:00.000Z`,
    endDate:   `${yyyy}-${mm}-${dd}T18:29:59.999Z`,
  };
}

// ─── Small UI helpers ────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, color: '#555', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>
      {children}
    </span>
  );
}

function Input({
  value, onChange, placeholder, mono, textarea, rows,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  textarea?: boolean;
  rows?: number;
}) {
  const sharedStyle: React.CSSProperties = {
    width: '100%',
    fontSize: mono ? 11 : 12,
    fontFamily: mono ? "'Fira Code', monospace" : 'inherit',
  };
  if (textarea) {
    return (
      <AntInput.TextArea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows ?? 4}
        style={{ ...sharedStyle, resize: 'vertical' }}
        spellCheck={false}
      />
    );
  }
  return (
    <AntInput
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={sharedStyle}
    />
  );
}

function Btn({
  onClick, children, disabled, variant = 'primary',
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  if (variant === 'danger') {
    return (
      <Button size="small" danger type="primary" onClick={onClick} disabled={disabled} style={{ whiteSpace: 'nowrap' }}>
        {children}
      </Button>
    );
  }
  if (variant === 'secondary') {
    return (
      <Button size="small" type="default" onClick={onClick} disabled={disabled} style={{ whiteSpace: 'nowrap' }}>
        {children}
      </Button>
    );
  }
  return (
    <Button size="small" type="primary" onClick={onClick} disabled={disabled} style={{ whiteSpace: 'nowrap' }}>
      {children}
    </Button>
  );
}

// ─── Timestamp converter (nubra uses nanoseconds) ────────────────────────────

function fmtTs(ns: number) {
  const ms = ns / 1_000_000;
  return new Date(ms).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ─── IV Timeseries table for a single strike ─────────────────────────────────

function IVTable({ label, points }: { label: string; points: { ts: number; v: number }[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? points : points.slice(0, 8);

  return (
    <div style={{ marginBottom: 8 }}>
      {/* Strike header */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          padding: '6px 10px', borderRadius: 6,
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.20)',
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 700, letterSpacing: '0.06em' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700, fontFamily: 'monospace' }}>{label}</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginLeft: 'auto' }}>
          {points.length} pts
        </span>
      </div>

      {/* Table */}
      <div className="glass-inset" style={{ overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          padding: '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.03)',
        }}>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Time (IST)</span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'right' }}>IV (OTM)</span>
        </div>
        {visible.map((pt, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            padding: '3px 10px',
            borderBottom: i < visible.length - 1 ? '1px solid rgba(255,255,255,0.04)' : undefined,
            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
          }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace' }}>
              {fmtTs(pt.ts)}
            </span>
            <span style={{ fontSize: 11, color: '#34d399', fontFamily: 'monospace', textAlign: 'right', fontWeight: 600 }}>
              {(pt.v * 100).toFixed(2)}%
            </span>
          </div>
        ))}
        {points.length > 8 && (
          <div
            onClick={() => setExpanded(e => !e)}
            style={{
              padding: '5px 10px', fontSize: 10, color: '#f59e0b', cursor: 'pointer',
              textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(245,158,11,0.04)',
            }}
          >
            {expanded ? '▲ Show less' : `▼ Show all ${points.length} rows`}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stock/Index price table ──────────────────────────────────────────────────

function PriceTable({ label, points }: { label: string; points: { ts: number; v: number }[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? points : points.slice(0, 8);

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          padding: '6px 10px', borderRadius: 6,
          background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.18)',
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 10, color: '#fb923c', fontWeight: 700 }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontSize: 12, color: '#fdba74', fontWeight: 700, fontFamily: 'monospace' }}>{label}</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginLeft: 'auto' }}>{points.length} pts</span>
      </div>
      <div className="glass-inset" style={{ overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          padding: '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.03)',
        }}>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Time (IST)</span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'right' }}>Price</span>
        </div>
        {visible.map((pt, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            padding: '3px 10px',
            borderBottom: i < visible.length - 1 ? '1px solid rgba(255,255,255,0.04)' : undefined,
            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
          }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace' }}>{fmtTs(pt.ts)}</span>
            <span style={{ fontSize: 11, color: '#fbbf24', fontFamily: 'monospace', textAlign: 'right', fontWeight: 600 }}>
              {pt.v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        ))}
        {points.length > 8 && (
          <div
            onClick={() => setExpanded(e => !e)}
            style={{
              padding: '5px 10px', fontSize: 10, color: '#fb923c', cursor: 'pointer',
              textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(251,146,60,0.04)',
            }}
          >
            {expanded ? '▲ Show less' : `▼ Show all ${points.length} rows`}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Structured response viewer ───────────────────────────────────────────────

function ResponseView({
  status, httpStatus, elapsed, responseText, statusColor, onCopy, onClear,
}: {
  status: StatusKind;
  httpStatus: number | null;
  elapsed: number | null;
  responseText: string;
  statusColor: string;
  onCopy: () => void;
  onClear: () => void;
}) {
  const parsed = useMemo(() => {
    if (!responseText) return null;
    try { return JSON.parse(responseText); } catch { return null; }
  }, [responseText]);

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 40 }}>
        <Spin size="small" />
        <span style={{ color: 'rgba(255,255,255,0.40)', fontSize: 12 }}>Sending request…</span>
      </div>
    );
  }

  if (status === 'idle' && !responseText) {
    return (
      <div style={{ color: 'rgba(255,255,255,0.20)', fontSize: 12, textAlign: 'center', paddingTop: 40 }}>
        Hit Send to see the response here.
      </div>
    );
  }

  if (!responseText) return null;

  const results: Array<{ exchange: string; type: string; values: Array<Record<string, Record<string, { ts: number; v: number }[]>>> }> =
    parsed?.result ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      {/* Status bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: statusColor, fontWeight: 700 }}>HTTP {httpStatus}</span>
        {elapsed !== null && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>{elapsed}ms</span>}
        {parsed?.market_time && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>
            market_time: {parsed.market_time}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Btn onClick={onCopy} variant="secondary">Copy JSON</Btn>
        <Btn onClick={onClear} variant="secondary">Clear</Btn>
      </div>

      {/* Structured view */}
      {parsed && results.length > 0 ? (
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {results.map((section, si) => (
            <div key={si}>
              {/* Section header */}
              <div style={{
                fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em',
                textTransform: 'uppercase', marginBottom: 8, paddingBottom: 4,
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
                {section.exchange} · {section.type}
              </div>

              {/* Each symbol in values array */}
              {(section.values ?? []).flatMap((valObj: Record<string, any>, vi: number) =>
                Object.entries(valObj).flatMap(([symbol, fields]) =>
                  Object.entries(fields as Record<string, { ts: number; v: number }[]>).map(([fieldName, pts]) => {
                    const points = Array.isArray(pts) ? pts : [];
                    const key = `${si}-${vi}-${symbol}-${fieldName}`;
                    const label = `${symbol} · ${fieldName}`;
                    if (section.type === 'STRIKE' || fieldName === 'iv_otm') {
                      return <IVTable key={key} label={label} points={points} />;
                    }
                    return <PriceTable key={key} label={label} points={points} />;
                  })
                )
              )}
            </div>
          ))}
        </div>
      ) : (
        /* Fallback: raw JSON */
        <pre className="glass-inset" style={{
          flex: 1, overflow: 'auto',
          padding: '12px', fontSize: 11, fontFamily: 'monospace',
          color: status === 'ok' ? '#a7f3d0' : '#fca5a5',
          lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          {responseText}
        </pre>
      )}
    </div>
  );
}

// ─── Full Market Quote result card ────────────────────────────────────────────

function QuoteCard({ symbol, data }: { symbol: string; data: any }) {
  const ohlc   = data?.ohlc ?? {};
  const ltp    = data?.last_price ?? 0;
  const change = data?.net_change ?? 0;
  const chgPct = ohlc.close > 0 ? ((ltp - ohlc.close) / ohlc.close) * 100 : 0;
  const bull   = change >= 0;

  // Feed timestamp (when the exchange sent the tick)
  const feedTs: string = data?.timestamp
    ? new Date(data.timestamp).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : '—';

  // Last trade time (ms epoch)
  const lttMs = Number(data?.last_trade_time ?? 0);
  const lttTs: string = lttMs > 0
    ? new Date(lttMs).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : '—';

  const row = (label: string, value: string | number, color?: string) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '4px 10px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.38)' }}>{label}</span>
      <span style={{ fontSize: 11, color: color ?? '#e5e7eb', fontFamily: 'monospace', fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div className="glass-panel" style={{ overflow: 'hidden', marginBottom: 12 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.04)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e5e7eb', fontFamily: 'monospace' }}>{symbol}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginLeft: 6 }}>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.30)', fontFamily: 'monospace' }}>Feed: {feedTs}</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace' }}>LTT: {lttTs}</span>
        </div>
        <span style={{
          marginLeft: 'auto',
          fontSize: 15, fontWeight: 800, fontFamily: 'monospace',
          color: bull ? '#34d399' : '#f87171',
        }}>{ltp.toFixed(2)}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, fontFamily: 'monospace',
          color: bull ? '#34d399' : '#f87171',
        }}>
          {bull ? '+' : ''}{change.toFixed(2)} ({chgPct.toFixed(2)}%)
        </span>
      </div>

      {/* OHLC */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        {row('Open',  ohlc.open?.toFixed(2)  ?? '—', '#93c5fd')}
        {row('High',  ohlc.high?.toFixed(2)  ?? '—', '#34d399')}
        {row('Low',   ohlc.low?.toFixed(2)   ?? '—', '#f87171')}
        {row('Close (prev)', ohlc.close?.toFixed(2) ?? '—', '#fbbf24')}
      </div>

      {/* Extra */}
      {row('Volume',   Number(data?.volume ?? 0).toLocaleString('en-IN'))}
      {row('Avg Price', data?.average_price?.toFixed(2) ?? '—')}
      {row('OI',        Number(data?.oi ?? 0).toLocaleString('en-IN'))}
      {row('Total Buy Qty',  Number(data?.total_buy_quantity  ?? 0).toLocaleString('en-IN'), '#34d399')}
      {row('Total Sell Qty', Number(data?.total_sell_quantity ?? 0).toLocaleString('en-IN'), '#f87171')}

      {/* Market Depth top-1 */}
      {(data?.depth?.buy?.[0]?.price > 0 || data?.depth?.sell?.[0]?.price > 0) && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          padding: '6px 10px', gap: 4,
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.30)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2 }}>Best Bid</div>
            <span style={{ fontSize: 11, color: '#34d399', fontFamily: 'monospace', fontWeight: 700 }}>
              {data.depth.buy[0].price?.toFixed(2)} × {data.depth.buy[0].quantity?.toLocaleString('en-IN')}
            </span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.30)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2 }}>Best Ask</div>
            <span style={{ fontSize: 11, color: '#f87171', fontFamily: 'monospace', fontWeight: 700 }}>
              {data.depth.sell[0].price?.toFixed(2)} × {data.depth.sell[0].quantity?.toLocaleString('en-IN')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function NubraApiTester() {
  const { startDate: defStart, endDate: defEnd } = getDefaultDates();

  // Auth — raw cookie string (auto-filled from Nubra login or pasted manually)
  const [rawCookie, setRawCookie] = useState(() => localStorage.getItem(LS_COOKIE) ?? '');

  // Sync cookie from localStorage on mount (picks up navbar login)
  useEffect(() => {
    const stored = localStorage.getItem(LS_COOKIE) ?? '';
    if (stored && stored !== rawCookie) setRawCookie(stored);
  }, []);

  // Query editor — edit as JSON text
  const [queryJson, setQueryJson] = useState(() => {
    const q = DEFAULT_QUERY.map(item => ({ ...item, startDate: defStart, endDate: defEnd }));
    return JSON.stringify(q, null, 2);
  });
  const [chart, setChart] = useState('Multi-Strike_IV');

  // UI state
  const [activeTab,    setActiveTab]    = useState<TabKey>('auth');
  const [status,       setStatus]       = useState<StatusKind>('idle');
  const [httpStatus,   setHttpStatus]   = useState<number | null>(null);
  const [responseText, setResponseText] = useState('');
  const [elapsed,      setElapsed]      = useState<number | null>(null);
  const [jsonError,    setJsonError]    = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // ── ATM Volatility state ─────────────────────────────────────────────────
  const [atmQueryJson,  setAtmQueryJson]  = useState(() => JSON.stringify(getDefaultAtmQuery(), null, 2));
  const [atmStatus,     setAtmStatus]     = useState<StatusKind>('idle');
  const [atmHttpStatus, setAtmHttpStatus] = useState<number | null>(null);
  const [atmResponseText, setAtmResponseText] = useState('');
  const [atmElapsed,    setAtmElapsed]    = useState<number | null>(null);
  const [atmJsonError,  setAtmJsonError]  = useState('');
  const atmAbortRef = useRef<AbortController | null>(null);

  const handleAtmSend = async () => {
    if (!rawCookie.trim()) {
      setAtmJsonError('Paste your full cookie string first (Auth tab).');
      setActiveTab('auth');
      return;
    }
    let query: unknown;
    try {
      const parsed = JSON.parse(atmQueryJson);
      if (!Array.isArray(parsed)) throw new Error('Must be an array');
      query = parsed;
      setAtmJsonError('');
    } catch (e: any) {
      setAtmJsonError(e.message);
      return;
    }
    atmAbortRef.current?.abort();
    const ctrl = new AbortController();
    atmAbortRef.current = ctrl;
    setAtmStatus('loading');
    setAtmResponseText('');
    setAtmHttpStatus(null);
    setAtmElapsed(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/nubra-timeseries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ rawCookie, chart: 'ATM_Volatility_vs_Spot', query }),
      });
      const ms   = Math.round(performance.now() - t0);
      const text = await res.text();
      setAtmHttpStatus(res.status);
      setAtmElapsed(ms);
      setAtmStatus(res.ok ? 'ok' : 'error');
      try { setAtmResponseText(JSON.stringify(JSON.parse(text), null, 2)); }
      catch { setAtmResponseText(text); }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setAtmStatus('error');
      setAtmResponseText(String(e));
    }
  };

  // ── Dhan Opt Chart state ─────────────────────────────────────────────────
  const [dhanJwt,         setDhanJwtState]  = useState(() => localStorage.getItem(LS_DHAN_JWT) ?? '');
  const [dhanPayloadJson, setDhanPayloadJson] = useState(() => JSON.stringify(getDefaultDhanPayload(), null, 2));
  const [dhanStatus,      setDhanStatus]    = useState<StatusKind>('idle');
  const [dhanHttpStatus,  setDhanHttpStatus] = useState<number | null>(null);
  const [dhanResponseText, setDhanResponseText] = useState('');
  const [dhanElapsed,     setDhanElapsed]   = useState<number | null>(null);
  const [dhanJsonError,   setDhanJsonError] = useState('');
  const dhanAbortRef = useRef<AbortController | null>(null);

  const handleDhanJwtChange = useCallback((v: string) => {
    setDhanJwtState(v);
    localStorage.setItem(LS_DHAN_JWT, v);
  }, []);

  const handleDhanSend = async () => {
    const jwt = dhanJwt.trim();
    if (!jwt) { setDhanJsonError('Paste your Dhan JWT (auth header value) first.'); return; }
    let payload: unknown;
    try {
      payload = JSON.parse(dhanPayloadJson);
      setDhanJsonError('');
    } catch (e: any) {
      setDhanJsonError(e.message);
      return;
    }
    dhanAbortRef.current?.abort();
    const ctrl = new AbortController();
    dhanAbortRef.current = ctrl;
    setDhanStatus('loading');
    setDhanResponseText('');
    setDhanHttpStatus(null);
    setDhanElapsed(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/dhan-opt-chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ auth: jwt, payload }),
      });
      const ms   = Math.round(performance.now() - t0);
      const text = await res.text();
      setDhanHttpStatus(res.status);
      setDhanElapsed(ms);
      setDhanStatus(res.ok ? 'ok' : 'error');
      try { setDhanResponseText(JSON.stringify(JSON.parse(text), null, 2)); }
      catch { setDhanResponseText(text); }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setDhanStatus('error');
      setDhanResponseText(String(e));
    }
  };

  // ── Upstox auto-login state ──────────────────────────────────────────────
  const [upstoxStatus,  setUpstoxStatus]  = useState<StatusKind>('idle');
  const [upstoxToken,   setUpstoxToken]   = useState('');
  const [upstoxMsg,     setUpstoxMsg]     = useState('');
  const upstoxAbortRef = useRef<AbortController | null>(null);

  const handleUpstoxLogin = async (force = false) => {
    upstoxAbortRef.current?.abort();
    const ctrl = new AbortController();
    upstoxAbortRef.current = ctrl;
    setUpstoxStatus('loading'); setUpstoxMsg(''); setUpstoxToken('');
    try {
      if (force) await fetch('/api/upstox-token', { method: 'DELETE', signal: ctrl.signal });
      const res  = await fetch('/api/upstox-login', { method: 'POST', signal: ctrl.signal });
      const data = await res.json() as any;
      if (!res.ok) { setUpstoxStatus('error'); setUpstoxMsg(data?.error ?? `HTTP ${res.status}`); return; }
      setUpstoxToken(data.access_token ?? '');
      setUpstoxMsg(data.cached ? 'Returned cached token (still valid).' : 'Headless login successful! Token saved.');
      setUpstoxStatus('ok');
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setUpstoxStatus('error'); setUpstoxMsg(String(e));
    }
  };

  // ── Multistrike OI state ─────────────────────────────────────────────────
  const [msPayloadJson,  setMsPayloadJson]  = useState(() => JSON.stringify(getDefaultMultistrikePayload(), null, 2));
  const [msStatus,       setMsStatus]       = useState<StatusKind>('idle');
  const [msHttpStatus,   setMsHttpStatus]   = useState<number | null>(null);
  const [msResponseText, setMsResponseText] = useState('');
  const [msElapsed,      setMsElapsed]      = useState<number | null>(null);
  const [msJsonError,    setMsJsonError]    = useState('');
  const msAbortRef = useRef<AbortController | null>(null);

  const handleMsSend = async () => {
    if (!rawCookie.trim()) { setMsJsonError('Paste your cookie string first (Auth tab).'); setActiveTab('auth'); return; }
    let query: unknown;
    try {
      const parsed = JSON.parse(msPayloadJson);
      if (!Array.isArray(parsed)) throw new Error('Must be an array');
      query = parsed;
      setMsJsonError('');
    } catch (e: any) { setMsJsonError(e.message); return; }
    msAbortRef.current?.abort();
    const ctrl = new AbortController();
    msAbortRef.current = ctrl;
    setMsStatus('loading'); setMsResponseText(''); setMsHttpStatus(null); setMsElapsed(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/nubra-multistrike', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ rawCookie, chart: 'Open_Interest_Change', query }),
      });
      const ms   = Math.round(performance.now() - t0);
      const text = await res.text();
      setMsHttpStatus(res.status); setMsElapsed(ms); setMsStatus(res.ok ? 'ok' : 'error');
      try { setMsResponseText(JSON.stringify(JSON.parse(text), null, 2)); }
      catch { setMsResponseText(text); }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setMsStatus('error'); setMsResponseText(String(e));
    }
  };

  // ── Full Market Quote state ──────────────────────────────────────────────
  const [quoteKeys,    setQuoteKeys]    = useState('NSE_EQ|INE848E01016');
  const [quoteStatus,  setQuoteStatus]  = useState<StatusKind>('idle');
  const [quoteResult,  setQuoteResult]  = useState<Record<string, any> | null>(null);
  const [quoteError,   setQuoteError]   = useState('');
  const [quoteElapsed, setQuoteElapsed] = useState<number | null>(null);
  const quoteAbortRef = useRef<AbortController | null>(null);

  const handleQuoteFetch = async () => {
    const token = localStorage.getItem('upstox_token') ?? '';
    if (!token) { setQuoteError('No Upstox token found. Set it via the token button in the navbar first.'); return; }
    const keys = quoteKeys.trim();
    if (!keys) { setQuoteError('Enter at least one instrument key.'); return; }
    quoteAbortRef.current?.abort();
    const ctrl = new AbortController();
    quoteAbortRef.current = ctrl;
    setQuoteStatus('loading');
    setQuoteError('');
    setQuoteResult(null);
    setQuoteElapsed(null);
    const t0 = performance.now();
    try {
      const res = await fetch(
        `/api/market-quote?instrument_key=${encodeURIComponent(keys)}&token=${encodeURIComponent(token)}`,
        { signal: ctrl.signal }
      );
      const ms   = Math.round(performance.now() - t0);
      const json = await res.json();
      setQuoteElapsed(ms);
      if (res.ok && json?.data) {
        setQuoteResult(json.data);
        setQuoteStatus('ok');
      } else {
        setQuoteError(json?.errors?.[0]?.message ?? json?.message ?? `HTTP ${res.status}`);
        setQuoteStatus('error');
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setQuoteError(String(e));
      setQuoteStatus('error');
    }
  };

  const handleCookieChange = useCallback((v: string) => {
    setRawCookie(v);
    localStorage.setItem(LS_COOKIE, v);
  }, []);

  // Parse + validate query JSON
  const parseQuery = (): NubraQueryItem[] | null => {
    try {
      const parsed = JSON.parse(queryJson);
      if (!Array.isArray(parsed)) throw new Error('Must be an array');
      setJsonError('');
      return parsed;
    } catch (e: any) {
      setJsonError(e.message);
      return null;
    }
  };

  const handleSend = async () => {
    if (!rawCookie.trim()) {
      setJsonError('Paste your full cookie string first (Auth tab).');
      setActiveTab('auth');
      return;
    }
    const query = parseQuery();
    if (!query) { setActiveTab('query'); return; }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus('loading');
    setResponseText('');
    setHttpStatus(null);
    setElapsed(null);

    const t0 = performance.now();
    try {
      const res = await fetch('/api/nubra-timeseries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ rawCookie, chart, query }),
      });
      const ms   = Math.round(performance.now() - t0);
      const text = await res.text();
      setHttpStatus(res.status);
      setElapsed(ms);
      setStatus(res.ok ? 'ok' : 'error');

      // Pretty-print JSON if possible
      try {
        const pretty = JSON.stringify(JSON.parse(text), null, 2);
        setResponseText(pretty);
      } catch {
        setResponseText(text);
      }
      setActiveTab('response');
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setStatus('error');
      setResponseText(String(e));
      setActiveTab('response');
    }
  };

  const handleCancel = () => { abortRef.current?.abort(); setStatus('idle'); };
  const handleCopyResponse = () => navigator.clipboard.writeText(responseText);
  const handleClearAuth = () => handleCookieChange('');

  // Status badge
  const statusColor = status === 'ok' ? '#34d399' : status === 'error' ? '#f87171' : 'rgba(255,255,255,0.35)';
  const statusLabel = status === 'loading' ? 'Sending…'
    : status === 'ok' ? `${httpStatus} OK`
    : status === 'error' ? `${httpStatus ?? 'Error'}`
    : 'Ready';

  // TAB_STYLE kept for reference but no longer used (replaced by antd Tabs)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'transparent',
        color: '#e5e7eb',
        fontFamily: 'inherit',
        overflow: 'hidden',
      }}
    >
      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div
        className="glass-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          flexShrink: 0,
        }}
      >
        {/* Method badge */}
        <span
          style={{
            background: 'rgba(245,158,11,0.15)',
            border: '1px solid rgba(245,158,11,0.35)',
            borderRadius: 4,
            padding: '3px 8px',
            fontSize: 11,
            fontWeight: 700,
            color: '#f59e0b',
            letterSpacing: '0.06em',
          }}
        >
          POST
        </span>

        {/* URL display */}
        <code
          className="glass-inset"
          style={{
            flex: 1,
            fontSize: 11,
            color: 'rgba(255,255,255,0.55)',
            padding: '5px 10px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          /api/nubra-timeseries → https://api.nubra.io/charts/timeseries?chart={chart}
        </code>

        {/* Status badge */}
        {status !== 'idle' && (
          <Badge
            status={status === 'ok' ? 'success' : status === 'error' ? 'error' : 'processing'}
            text={<span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{statusLabel}</span>}
          />
        )}
        {elapsed !== null && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>{elapsed}ms</span>
        )}

        {/* Send / Cancel */}
        {status === 'loading'
          ? <Btn onClick={handleCancel} variant="danger">Cancel</Btn>
          : <Btn onClick={handleSend}>Send</Btn>
        }
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <Tabs
        activeKey={activeTab}
        onChange={k => setActiveTab(k as TabKey)}
        size="small"
        style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        tabBarStyle={{ paddingLeft: 16, marginBottom: 0, flexShrink: 0 }}
        items={[
          {
            key: 'auth',
            label: 'Auth',
            children: null,
          },
          {
            key: 'query',
            label: 'Query',
            children: null,
          },
          {
            key: 'response',
            label: (
              <span>
                Response{' '}
                {status !== 'idle' && status !== 'loading' && (
                  <Badge status={status === 'ok' ? 'success' : 'error'} style={{ marginLeft: 4 }} />
                )}
              </span>
            ),
            children: null,
          },
          {
            key: 'atm',
            label: (
              <span>
                ATM Vol{' '}
                {atmStatus === 'ok' && <Badge status="success" style={{ marginLeft: 4 }} />}
                {atmStatus === 'error' && <Badge status="error" style={{ marginLeft: 4 }} />}
              </span>
            ),
            children: null,
          },
          {
            key: 'quote',
            label: (
              <span>
                Market Quote{' '}
                {quoteStatus === 'ok' && <Badge status="success" style={{ marginLeft: 4 }} />}
                {quoteStatus === 'error' && <Badge status="error" style={{ marginLeft: 4 }} />}
              </span>
            ),
            children: null,
          },
          {
            key: 'dhan',
            label: (
              <span>
                Dhan Chart{' '}
                {dhanStatus === 'ok' && <Badge status="success" style={{ marginLeft: 4 }} />}
                {dhanStatus === 'error' && <Badge status="error" style={{ marginLeft: 4 }} />}
              </span>
            ),
            children: null,
          },
          {
            key: 'multistrike',
            label: (
              <span>
                Multistrike OI{' '}
                {msStatus === 'ok' && <Badge status="success" style={{ marginLeft: 4 }} />}
                {msStatus === 'error' && <Badge status="error" style={{ marginLeft: 4 }} />}
              </span>
            ),
            children: null,
          },
          {
            key: 'upstox-auth',
            label: (
              <span>
                Upstox Login{' '}
                {upstoxStatus === 'ok' && <Badge status="success" style={{ marginLeft: 4 }} />}
                {upstoxStatus === 'error' && <Badge status="error" style={{ marginLeft: 4 }} />}
              </span>
            ),
            children: null,
          },
        ]}
        renderTabBar={(props, DefaultTabBar) => (
          <div className="glass-bar" style={{ flexShrink: 0 }}>
            <DefaultTabBar {...props} />
          </div>
        )}
      />

      {/* ── Tab content ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>

        {/* ── AUTH TAB ─────────────────────────────────────────────────────── */}
        {activeTab === 'auth' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
            <div
              style={{
                background: 'rgba(245,158,11,0.06)',
                border: '1px solid rgba(245,158,11,0.20)',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 11,
                color: 'rgba(255,255,255,0.55)',
                lineHeight: 1.8,
              }}
            >
              <strong style={{ color: '#f59e0b' }}>How to get the cookie string:</strong><br />
              1. Open <strong style={{ color: '#fff' }}>nubra.io</strong> in Chrome and log in<br />
              2. DevTools (F12) → <strong style={{ color: '#fff' }}>Network</strong> tab → click any request to <code style={{ color: '#f59e0b' }}>api.nubra.io</code><br />
              3. Scroll to <strong style={{ color: '#fff' }}>Request Headers</strong> → right-click the <code style={{ color: '#f59e0b' }}>Cookie</code> value → <strong style={{ color: '#fff' }}>Copy value</strong><br />
              4. Paste the entire string below. It is saved in <code style={{ color: '#f59e0b' }}>localStorage</code> and sent only through your local proxy.
            </div>

            <div>
              <Label>Full Cookie string (paste entire value from DevTools → Request Headers → Cookie)</Label>
              <AntInput.TextArea
                value={rawCookie}
                onChange={e => handleCookieChange(e.target.value)}
                placeholder={'_gcl_au=1.1...; authToken=7cb21c66-...; _hjSessionUser_5163143=eyJ...'}
                rows={7}
                spellCheck={false}
                style={{
                  width: '100%',
                  fontSize: 11,
                  fontFamily: "'Fira Code', monospace",
                  resize: 'vertical',
                  lineHeight: 1.6,
                  borderColor: rawCookie ? 'rgba(52,211,153,0.35)' : undefined,
                }}
              />
              {rawCookie && (
                <span style={{ fontSize: 10, color: '#34d399', marginTop: 4, display: 'block' }}>
                  Cookie saved ({rawCookie.length} chars)
                </span>
              )}
            </div>

            <div>
              <Label>chart (query param)</Label>
              <Input value={chart} onChange={setChart} placeholder="Multi-Strike_IV" />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn onClick={handleClearAuth} variant="secondary">Clear cookie</Btn>
              <Btn onClick={() => setActiveTab('query')}>Next: Query →</Btn>
            </div>
          </div>
        )}

        {/* ── QUERY TAB ────────────────────────────────────────────────────── */}
        {activeTab === 'query' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              className="glass-inset"
              style={{
                padding: '10px 14px',
                fontSize: 11,
                color: 'rgba(255,255,255,0.45)',
                lineHeight: 1.6,
              }}
            >
              Edit the <code style={{ color: '#f59e0b' }}>query</code> array directly as JSON.
              Each item is one timeseries query.<br />
              <strong style={{ color: 'rgba(255,255,255,0.6)' }}>type: "STRIKE"</strong> — use value like <code style={{ color: '#f59e0b' }}>PNB_20260224_12900</code><br />
              <strong style={{ color: 'rgba(255,255,255,0.6)' }}>type: "STOCK" / "INDEX"</strong> — use plain symbol like <code style={{ color: '#f59e0b' }}>PNB</code>
            </div>

            {jsonError && (
              <Alert type="error" message={`JSON error: ${jsonError}`} showIcon style={{ fontSize: 11 }} />
            )}

            <AntInput.TextArea
              value={queryJson}
              onChange={e => { setQueryJson(e.target.value); setJsonError(''); }}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: 360,
                fontSize: 12,
                fontFamily: "'Fira Code', monospace",
                lineHeight: 1.6,
                resize: 'vertical',
              }}
            />

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn onClick={() => {
                const q = DEFAULT_QUERY.map(item => ({ ...item, ...getDefaultDates() }));
                setQueryJson(JSON.stringify(q, null, 2));
                setJsonError('');
              }} variant="secondary">Reset to example</Btn>
              <Btn onClick={() => {
                try {
                  setQueryJson(JSON.stringify(JSON.parse(queryJson), null, 2));
                  setJsonError('');
                } catch (e: any) { setJsonError(e.message); }
              }} variant="secondary">Format JSON</Btn>
              <Btn onClick={handleSend} disabled={status === 'loading'}>Send →</Btn>
            </div>
          </div>
        )}

        {/* ── RESPONSE TAB ─────────────────────────────────────────────────── */}
        {activeTab === 'response' && (
          <ResponseView
            status={status}
            httpStatus={httpStatus}
            elapsed={elapsed}
            responseText={responseText}
            statusColor={statusColor}
            onCopy={handleCopyResponse}
            onClear={() => { setResponseText(''); setStatus('idle'); setHttpStatus(null); }}
          />
        )}

        {/* ── ATM VOLATILITY TAB ───────────────────────────────────────────── */}
        {activeTab === 'atm' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{
              background: 'rgba(245,158,11,0.06)',
              border: '1px solid rgba(245,158,11,0.20)',
              borderRadius: 8, padding: '10px 14px', fontSize: 11,
              color: 'rgba(255,255,255,0.55)', lineHeight: 1.8,
            }}>
              <strong style={{ color: '#f59e0b' }}>ATM Volatility vs Spot</strong> — calls{' '}
              <code style={{ color: '#f59e0b' }}>ATM_Volatility_vs_Spot</code> chart.<br />
              Use <code style={{ color: '#f59e0b' }}>type: "CHAIN"</code> with value like{' '}
              <code style={{ color: '#f59e0b' }}>NIFTY_20260302</code> for ATM IV,
              and <code style={{ color: '#f59e0b' }}>type: "INDEX"</code> for spot price.
            </div>

            {atmJsonError && (
              <Alert type="error" message={`JSON error: ${atmJsonError}`} showIcon style={{ fontSize: 11 }} />
            )}

            <AntInput.TextArea
              value={atmQueryJson}
              onChange={e => { setAtmQueryJson(e.target.value); setAtmJsonError(''); }}
              spellCheck={false}
              style={{
                width: '100%', minHeight: 320,
                fontSize: 12, fontFamily: "'Fira Code', monospace",
                lineHeight: 1.6, resize: 'vertical',
              }}
            />

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn onClick={() => { setAtmQueryJson(JSON.stringify(getDefaultAtmQuery(), null, 2)); setAtmJsonError(''); }} variant="secondary">Reset</Btn>
              <Btn onClick={() => {
                try { setAtmQueryJson(JSON.stringify(JSON.parse(atmQueryJson), null, 2)); setAtmJsonError(''); }
                catch (e: any) { setAtmJsonError(e.message); }
              }} variant="secondary">Format JSON</Btn>
              {atmStatus === 'loading'
                ? <Btn onClick={() => { atmAbortRef.current?.abort(); setAtmStatus('idle'); }} variant="danger">Cancel</Btn>
                : <Btn onClick={handleAtmSend}>Send →</Btn>
              }
              {atmElapsed !== null && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>{atmElapsed}ms</span>}
              {atmHttpStatus !== null && (
                <span style={{ fontSize: 11, fontWeight: 700, color: atmStatus === 'ok' ? '#34d399' : '#f87171' }}>
                  HTTP {atmHttpStatus}
                </span>
              )}
            </div>

            {atmResponseText && (
              <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                <Btn onClick={() => navigator.clipboard.writeText(atmResponseText)} variant="secondary">Copy JSON</Btn>
                <Btn onClick={() => { setAtmResponseText(''); setAtmStatus('idle'); setAtmHttpStatus(null); }} variant="secondary">Clear</Btn>
              </div>
            )}

            {atmStatus === 'loading' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 20 }}>
                <Spin size="small" />
                <span style={{ color: 'rgba(255,255,255,0.40)', fontSize: 12 }}>Sending request…</span>
              </div>
            )}

            {atmResponseText && atmStatus !== 'loading' && (
              <pre className="glass-inset" style={{
                flex: 1, overflow: 'auto', padding: '12px',
                fontSize: 11, fontFamily: 'monospace',
                color: atmStatus === 'ok' ? '#a7f3d0' : '#fca5a5',
                lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                {atmResponseText}
              </pre>
            )}
          </div>
        )}

        {/* ── MARKET QUOTE TAB ─────────────────────────────────────────────── */}
        {activeTab === 'quote' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900 }}>
            {/* Info */}
            <div style={{
              background: 'rgba(245,158,11,0.06)',
              border: '1px solid rgba(245,158,11,0.20)',
              borderRadius: 8, padding: '10px 14px', fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.8,
            }}>
              <strong style={{ color: '#f59e0b' }}>Upstox Full Market Quote</strong> — uses your saved Upstox token automatically.<br />
              Enter one or more instrument keys separated by commas.<br />
              Example: <code style={{ color: '#f59e0b' }}>NSE_EQ|INE848E01016</code> or <code style={{ color: '#f59e0b' }}>NSE_FO|123456,NSE_EQ|INE848E01016</code>
            </div>

            {/* Input row */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Label>Instrument Key(s) — comma separated</Label>
                <AntInput
                  value={quoteKeys}
                  onChange={e => setQuoteKeys(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleQuoteFetch(); }}
                  placeholder="NSE_EQ|INE848E01016"
                  style={{ fontSize: 12, fontFamily: "'Fira Code', monospace" }}
                />
              </div>
              <Btn onClick={handleQuoteFetch} disabled={quoteStatus === 'loading'}>
                {quoteStatus === 'loading' ? 'Fetching…' : 'Fetch Quote'}
              </Btn>
              {quoteStatus === 'loading' && (
                <Btn onClick={() => { quoteAbortRef.current?.abort(); setQuoteStatus('idle'); }} variant="danger">Cancel</Btn>
              )}
            </div>

            {/* Timing */}
            {quoteElapsed !== null && (
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>{quoteElapsed}ms</span>
            )}

            {/* Error */}
            {quoteError && (
              <Alert type="error" message={quoteError} showIcon style={{ fontSize: 11 }} />
            )}

            {/* Results */}
            {quoteResult && Object.keys(quoteResult).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {Object.entries(quoteResult).map(([sym, data]) => (
                  <QuoteCard key={sym} symbol={sym} data={data} />
                ))}
              </div>
            )}

            {quoteStatus === 'ok' && quoteResult && Object.keys(quoteResult).length === 0 && (
              <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>No data returned.</div>
            )}
          </div>
        )}

        {/* ── DHAN OPT CHART TAB ───────────────────────────────────────────── */}
        {activeTab === 'dhan' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900 }}>
            {/* Info */}
            <div style={{
              background: 'rgba(99,102,241,0.07)',
              border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: 8, padding: '10px 14px', fontSize: 11,
              color: 'rgba(255,255,255,0.55)', lineHeight: 1.8,
            }}>
              <strong style={{ color: '#818cf8' }}>Dhan Options Chart</strong> — proxies{' '}
              <code style={{ color: '#818cf8' }}>POST https://op-charts.dhan.co/api/opt_chart</code>.<br />
              Paste the <code style={{ color: '#818cf8' }}>auth</code> header value (JWT) from DevTools → Network → opt_chart request headers.<br />
              Edit the payload JSON below. Key fields: <code style={{ color: '#818cf8' }}>u_id</code> (underlying),{' '}
              <code style={{ color: '#818cf8' }}>exp_flag</code> (W/M), <code style={{ color: '#818cf8' }}>exp_code</code>,{' '}
              <code style={{ color: '#818cf8' }}>interval</code>, <code style={{ color: '#818cf8' }}>required_data</code>.
            </div>

            {/* JWT input */}
            <div>
              <Label>Dhan JWT (auth header value — paste from DevTools)</Label>
              <AntInput.TextArea
                value={dhanJwt}
                onChange={e => handleDhanJwtChange(e.target.value)}
                placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9..."
                rows={3}
                spellCheck={false}
                style={{
                  width: '100%', fontSize: 11,
                  fontFamily: "'Fira Code', monospace", resize: 'vertical', lineHeight: 1.5,
                  borderColor: dhanJwt ? 'rgba(129,140,248,0.40)' : undefined,
                }}
              />
              {dhanJwt && (
                <span style={{ fontSize: 10, color: '#818cf8', marginTop: 4, display: 'block' }}>
                  JWT saved ({dhanJwt.length} chars)
                </span>
              )}
            </div>

            {/* Payload JSON editor */}
            <div>
              <Label>Request Payload (JSON)</Label>
              {dhanJsonError && (
                <Alert type="error" message={`JSON error: ${dhanJsonError}`} showIcon style={{ fontSize: 11, marginBottom: 6 }} />
              )}
              <AntInput.TextArea
                value={dhanPayloadJson}
                onChange={e => { setDhanPayloadJson(e.target.value); setDhanJsonError(''); }}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 280,
                  fontSize: 12, fontFamily: "'Fira Code', monospace",
                  lineHeight: 1.6, resize: 'vertical',
                }}
              />
            </div>

            {/* Action row */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn onClick={() => { setDhanPayloadJson(JSON.stringify(getDefaultDhanPayload(), null, 2)); setDhanJsonError(''); }} variant="secondary">Reset</Btn>
              <Btn onClick={() => {
                try { setDhanPayloadJson(JSON.stringify(JSON.parse(dhanPayloadJson), null, 2)); setDhanJsonError(''); }
                catch (e: any) { setDhanJsonError(e.message); }
              }} variant="secondary">Format JSON</Btn>
              {dhanStatus === 'loading'
                ? <Btn onClick={() => { dhanAbortRef.current?.abort(); setDhanStatus('idle'); }} variant="danger">Cancel</Btn>
                : <Btn onClick={handleDhanSend}>Send →</Btn>
              }
              {dhanElapsed !== null && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>{dhanElapsed}ms</span>}
              {dhanHttpStatus !== null && (
                <span style={{ fontSize: 11, fontWeight: 700, color: dhanStatus === 'ok' ? '#34d399' : '#f87171' }}>
                  HTTP {dhanHttpStatus}
                </span>
              )}
              {dhanResponseText && (
                <>
                  <Btn onClick={() => navigator.clipboard.writeText(dhanResponseText)} variant="secondary">Copy JSON</Btn>
                  <Btn onClick={() => { setDhanResponseText(''); setDhanStatus('idle'); setDhanHttpStatus(null); }} variant="secondary">Clear</Btn>
                </>
              )}
            </div>

            {dhanStatus === 'loading' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 20 }}>
                <Spin size="small" />
                <span style={{ color: 'rgba(255,255,255,0.40)', fontSize: 12 }}>Sending request…</span>
              </div>
            )}

            {dhanResponseText && dhanStatus !== 'loading' && (
              <pre className="glass-inset" style={{
                overflow: 'auto', padding: '12px',
                fontSize: 11, fontFamily: 'monospace',
                color: dhanStatus === 'ok' ? '#a7f3d0' : '#fca5a5',
                lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                maxHeight: 500,
              }}>
                {dhanResponseText}
              </pre>
            )}
          </div>
        )}

        {/* ── MULTISTRIKE OI TAB ───────────────────────────────────────────── */}
        {activeTab === 'multistrike' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900 }}>
            <div style={{
              background: 'rgba(52,211,153,0.06)',
              border: '1px solid rgba(52,211,153,0.20)',
              borderRadius: 8, padding: '10px 14px', fontSize: 11,
              color: 'rgba(255,255,255,0.55)', lineHeight: 1.8,
            }}>
              <strong style={{ color: '#34d399' }}>Nubra Multistrike OI</strong> — proxies{' '}
              <code style={{ color: '#34d399' }}>POST https://api.nubra.io/charts/multistrike?chart=Open_Interest_Change</code>.<br />
              Each item in the array is one snapshot query. Key fields:{' '}
              <code style={{ color: '#34d399' }}>asset</code>,{' '}
              <code style={{ color: '#34d399' }}>expiries</code> (YYYYMMDD strings),{' '}
              <code style={{ color: '#34d399' }}>strikes</code> (×100 integers),{' '}
              <code style={{ color: '#34d399' }}>time</code> (ISO UTC),{' '}
              <code style={{ color: '#34d399' }}>fields</code> (e.g. <code style={{ color: '#34d399' }}>["cumulative_oi"]</code>).
            </div>

            {msJsonError && (
              <Alert type="error" message={`JSON error: ${msJsonError}`} showIcon style={{ fontSize: 11 }} />
            )}

            <AntInput.TextArea
              value={msPayloadJson}
              onChange={e => { setMsPayloadJson(e.target.value); setMsJsonError(''); }}
              spellCheck={false}
              style={{
                width: '100%', minHeight: 320,
                fontSize: 12, fontFamily: "'Fira Code', monospace",
                lineHeight: 1.6, resize: 'vertical',
              }}
            />

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn onClick={() => { setMsPayloadJson(JSON.stringify(getDefaultMultistrikePayload(), null, 2)); setMsJsonError(''); }} variant="secondary">Reset</Btn>
              <Btn onClick={() => {
                try { setMsPayloadJson(JSON.stringify(JSON.parse(msPayloadJson), null, 2)); setMsJsonError(''); }
                catch (e: any) { setMsJsonError(e.message); }
              }} variant="secondary">Format JSON</Btn>
              {msStatus === 'loading'
                ? <Btn onClick={() => { msAbortRef.current?.abort(); setMsStatus('idle'); }} variant="danger">Cancel</Btn>
                : <Btn onClick={handleMsSend}>Send →</Btn>
              }
              {msElapsed !== null && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>{msElapsed}ms</span>}
              {msHttpStatus !== null && (
                <span style={{ fontSize: 11, fontWeight: 700, color: msStatus === 'ok' ? '#34d399' : '#f87171' }}>
                  HTTP {msHttpStatus}
                </span>
              )}
              {msResponseText && (
                <>
                  <Btn onClick={() => navigator.clipboard.writeText(msResponseText)} variant="secondary">Copy JSON</Btn>
                  <Btn onClick={() => { setMsResponseText(''); setMsStatus('idle'); setMsHttpStatus(null); }} variant="secondary">Clear</Btn>
                </>
              )}
            </div>

            {msStatus === 'loading' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 20 }}>
                <Spin size="small" />
                <span style={{ color: 'rgba(255,255,255,0.40)', fontSize: 12 }}>Sending request…</span>
              </div>
            )}

            {msResponseText && msStatus !== 'loading' && (
              <pre className="glass-inset" style={{
                overflow: 'auto', padding: '12px',
                fontSize: 11, fontFamily: 'monospace',
                color: msStatus === 'ok' ? '#a7f3d0' : '#fca5a5',
                lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                maxHeight: 500,
              }}>
                {msResponseText}
              </pre>
            )}
          </div>
        )}

        {/* ── UPSTOX LOGIN TAB ─────────────────────────────────────────────── */}
        {activeTab === 'upstox-auth' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 600 }}>
            <div style={{
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: 8, padding: '12px 16px', fontSize: 11,
              color: 'rgba(255,255,255,0.55)', lineHeight: 1.9,
            }}>
              <strong style={{ color: '#818cf8' }}>Upstox Headless Auto-Login</strong><br />
              Launches a hidden Chromium browser, fills your credentials + TOTP, and returns an <code style={{ color: '#818cf8' }}>access_token</code> automatically.<br />
              Token is cached for <strong style={{ color: 'rgba(255,255,255,0.7)' }}>23 hours</strong> — subsequent calls return the cache instantly.<br />
              Credentials are read from <code style={{ color: '#818cf8' }}>urjaa/.env</code> on the server.
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {upstoxStatus === 'loading'
                ? <Btn onClick={() => { upstoxAbortRef.current?.abort(); setUpstoxStatus('idle'); }} variant="danger">Cancel</Btn>
                : <>
                    <Btn onClick={() => handleUpstoxLogin(false)}>Login / Use Cache →</Btn>
                    <Btn onClick={() => handleUpstoxLogin(true)} variant="secondary">Force Re-Login</Btn>
                  </>
              }
            </div>

            {upstoxStatus === 'loading' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Spin size="small" />
                <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>Running headless login… this takes ~15 seconds</span>
              </div>
            )}

            {upstoxMsg && (
              <Alert
                type={upstoxStatus === 'ok' ? 'success' : 'error'}
                message={upstoxMsg}
                showIcon
                style={{ fontSize: 12 }}
              />
            )}

            {upstoxToken && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Access Token</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code style={{
                    flex: 1, padding: '8px 12px', borderRadius: 6, fontSize: 11,
                    background: 'rgba(255,255,255,0.04)', border: '1px solid #2A2E39',
                    color: '#a7f3d0', wordBreak: 'break-all', lineHeight: 1.6,
                  }}>
                    {upstoxToken}
                  </code>
                  <Btn onClick={() => navigator.clipboard.writeText(upstoxToken)} variant="secondary">Copy</Btn>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
