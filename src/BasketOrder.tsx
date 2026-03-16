'use client';

/**
 * BasketOrder — Zerodha-style basket order panel
 * DOM book floats as a small panel attached to the left side of the basket.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

// ── Margin types ──────────────────────────────────────────────────────────────
interface LegMargin {
  ref_id: number;
  span: number;
  exposure: number;
  total_margin: number;
}
interface MarginResult {
  total_margin: number;
  span: number;
  exposure: number;
  margin_benefit: number;
  premium_payable?: number;
  leg_margin?: LegMargin[];
}


async function callEvaluateApi(sessionToken: string, deviceId: string, body: object): Promise<any> {
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  const res = await fetch('/api/nubra-evaluate', {
    method: 'POST',
    headers: {
      'x-session-token': sessionToken,
      'x-device-id': deviceId,
      'x-raw-cookie': rawCookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = await res.json();
  console.log('[nubra evaluate raw]', JSON.stringify(json));
  return json;
}

function fromPaisa(v: any): number { return ((v ?? 0) as number) / 100; }

async function fetchMargin(legs: BasketLeg[]): Promise<MarginResult | null> {
  const sessionToken = localStorage.getItem('nubra_session_token');
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  if (!sessionToken) return null;

  const validLegs = legs.filter(l => l.refId);
  if (validLegs.length === 0) return null;

  // Use the first leg's entrySpot as custom_spot (in paisa)
  const customSpot = Math.round((validLegs[0].entrySpot ?? 0) * 100);

  // Calculate DTE from today (IST) to expiry date
  function dteFromExpiry(expiry: string): number {
    try {
      // Nubra expiry: YYYYMMDD
      const expiryDate = new Date(`${expiry.slice(0,4)}-${expiry.slice(4,6)}-${expiry.slice(6,8)}T00:00:00+05:30`);
      const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      nowIST.setHours(0, 0, 0, 0);
      const dte = Math.round((expiryDate.getTime() - nowIST.getTime()) / (1000 * 60 * 60 * 24));
      return Math.max(0, dte);
    } catch {
      return 0;
    }
  }

  // Use the earliest expiry leg's DTE as expiry_offset (most conservative)
  const expiryOffset = validLegs.reduce((minDte, l) => {
    const dte = dteFromExpiry(l.expiry);
    return dte < minDte ? dte : minDte;
  }, Infinity);
  const finalOffset = isFinite(expiryOffset) ? expiryOffset : 0;

  const makeEvaluateLeg = (l: BasketLeg) => ({
    ref_id:   l.refId!,
    price:    Math.round(l.price * 100),
    quantity: l.lots,
    lot_size: l.lotSize,
    buy:      l.action === 'B',
    sell:     l.action === 'S',
    exchange: 'NSE',
  });

  try {
    // Single evaluate call for all legs (1 leg or many)
    const result = await callEvaluateApi(sessionToken, deviceId, {
      custom_spot:   customSpot,
      expiry_offset: finalOffset,
      payoff:        true,
      legs:          validLegs.map(makeEvaluateLeg),
    });
    if (!result) return null;

    const m = result.margins;
    if (!m) return null;

    // Per-leg breakdown comes from margins.legs in the combined response
    const legMargins: LegMargin[] = validLegs.map(l => {
      const lm = (m.legs ?? []).find((x: any) => x.ref_id === l.refId);
      return {
        ref_id:       l.refId!,
        span:         fromPaisa(lm?.span),
        exposure:     fromPaisa(lm?.exposure),
        total_margin: fromPaisa(lm?.total),
      };
    });

    return {
      total_margin:    fromPaisa(m.required),
      span:            fromPaisa(m.span),
      exposure:        fromPaisa(m.exposure),
      margin_benefit:  fromPaisa(m.benefit),
      premium_payable: fromPaisa(m.premium_recievable),
      leg_margin:      legMargins,
    };
  } catch {
    return null;
  }
}

function fmtMargin(v: number) {
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ── Margin Breakdown component ────────────────────────────────────────────────
function MarginBreakdown({ legs }: { legs: BasketLeg[] }) {
  const [margin, setMargin] = useState<MarginResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchMargin(legs);
    setMargin(result);
    setLoading(false);
  }, [legs.map(l => `${l.refId}:${l.lots}:${l.action}`).join(',')]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div style={{ padding: '10px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, border: '1.5px solid rgba(255,255,255,0.15)', borderTopColor: '#60a5fa', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
      <span style={{ fontSize: 11, color: '#565A6B' }}>Calculating margin…</span>
    </div>
  );

  if (!margin) return null;

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 20px 4px' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0', letterSpacing: '0.04em' }}>Margin Breakdown</span>
        {margin.margin_benefit > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: '#26a69a' }}>
            Margin Benefit: {fmtMargin(margin.margin_benefit)}
          </span>
        )}
      </div>

      {/* Summary card */}
      <div style={{
        margin: '0 20px 8px',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 7,
        overflow: 'hidden',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', padding: '12px 16px' }}>
          {[
            { label: 'Span', value: fmtMargin(margin.span) },
            { label: 'Exposure', value: fmtMargin(margin.exposure) },
            { label: 'Total Margin', value: fmtMargin(margin.total_margin) },
            { label: 'Premium Payable', value: fmtMargin(margin.premium_payable ?? 0) },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontSize: 10, color: '#6B7280', fontWeight: 500, marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#E2E8F0', fontFamily: 'monospace' }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-leg toggle */}
      {margin.leg_margin && margin.leg_margin.length > 0 && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              width: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '4px 0 8px', color: '#565A6B',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
              style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </button>

          {expanded && (
            <div style={{ margin: '0 20px 10px', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 7, overflow: 'hidden' }}>
              {/* Table header */}
              <div style={{
                display: 'grid', gridTemplateColumns: '36px 1fr 90px 68px 90px 90px 100px',
                padding: '6px 12px', background: '#333',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
                {['B/S', 'Instrument', 'Strike', 'Qty', 'Span', 'Exposure', 'Total Margin'].map((h, i) => (
                  <span key={i} style={{ fontSize: 9, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: i >= 2 ? 'right' : 'left' }}>{h}</span>
                ))}
              </div>

              {/* Rows */}
              {margin.leg_margin!.map((lm, i) => {
                const leg = legs.find(l => l.refId === lm.ref_id);
                if (!leg) return null;
                const isBuy = leg.action === 'B';
                return (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '36px 1fr 90px 68px 90px 90px 100px',
                    alignItems: 'center', padding: '7px 12px',
                    borderBottom: i < margin.leg_margin!.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                  }}>
                    {/* B/S */}
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 22, height: 18, borderRadius: 4,
                      background: isBuy ? 'rgba(38,166,154,0.18)' : 'rgba(242,54,69,0.18)',
                      border: `1px solid ${isBuy ? 'rgba(38,166,154,0.45)' : 'rgba(242,54,69,0.45)'}`,
                    }}>
                      <span style={{ fontSize: 9, fontWeight: 800, color: isBuy ? '#26a69a' : '#f23645' }}>
                        {isBuy ? 'B' : 'S'}
                      </span>
                    </div>

                    {/* Instrument */}
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {fmtExpiry(leg.expiry)}
                    </span>

                    {/* Strike */}
                    <span style={{ fontSize: 11, color: '#E2E8F0', textAlign: 'right', fontFamily: 'monospace' }}>
                      {leg.strike} <span style={{ color: leg.type === 'CE' ? '#26a69a' : '#f23645' }}>{leg.type}</span>
                    </span>

                    {/* Qty */}
                    <span style={{ fontSize: 11, color: '#9CA3AF', textAlign: 'right', fontFamily: 'monospace' }}>
                      {leg.lots * leg.lotSize}
                    </span>

                    {/* Span */}
                    <span style={{ fontSize: 11, color: '#E2E8F0', textAlign: 'right', fontFamily: 'monospace' }}>
                      {fmtMargin(lm.span)}
                    </span>

                    {/* Exposure */}
                    <span style={{ fontSize: 11, color: '#E2E8F0', textAlign: 'right', fontFamily: 'monospace' }}>
                      {fmtMargin(lm.exposure)}
                    </span>

                    {/* Total Margin */}
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#E2E8F0', textAlign: 'right', fontFamily: 'monospace' }}>
                      {fmtMargin(lm.total_margin)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export interface BasketLegGreeks {
  delta: number; theta: number; vega: number; gamma: number; iv: number;
}

export interface BasketLeg {
  id: number;
  symbol: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  action: 'B' | 'S';
  lots: number;
  lotSize: number;
  price: number;
  entrySpot?: number;
  greeks?: BasketLegGreeks;
  refId?: number;
  instrumentKey?: string; // Upstox instrument_key for MCX legs
  entryDate?: string; // YYYY-MM-DD (historical mode)
  entryTime?: string; // HH:MM (historical mode)
}

interface OrderLevel { price: number; quantity: number; num_orders: number; }
interface OrderBook {
  ref_id: number;
  last_traded_price: number;
  bids: OrderLevel[];
  asks: OrderLevel[];
}

function fmtExpiry(e: string) {
  // MCX legs store expiry as Unix ms timestamp string; Nubra legs use YYYYMMDD
  if (e.length > 8) {
    return new Date(Number(e)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  }
  return new Date(`${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}T00:00:00Z`)
    .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function isMcxExpiry(e: string) { return e.length > 8; }

function fmtPx(v: number) { return (v / 100).toFixed(2); }

function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function buildOptName(symbol: string, expiry: string, strike: number, type: 'CE' | 'PE') {
  if (expiry.length < 8) return null;
  const yy = expiry.slice(2, 4);
  const m = String(parseInt(expiry.slice(4, 6)));
  const dd = expiry.slice(6, 8);
  return `${symbol}${yy}${m}${dd}${strike}${type}`;
}

async function fetchHistoricalOptionClose(optName: string, exchange: string, entryDate: string, entryTime: string): Promise<number | null> {
  const sessionToken = localStorage.getItem('nubra_session_token');
  if (!sessionToken) return null;
  const startUtc = new Date(`${entryDate}T03:45:00Z`).toISOString();
  const endUtc = new Date().toISOString();
  const res = await fetch('/api/nubra-historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: sessionToken,
      exchange,
      type: 'OPT',
      values: [optName],
      fields: ['close'],
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
  const closeArr: { ts: number; v: number }[] = stockChart.close ?? [];
  if (!closeArr.length) return null;
  const candleTs = new Date(`${entryDate}T${entryTime}:00+05:30`).getTime();
  let best = closeArr[closeArr.length - 1];
  let bestDiff = Infinity;
  for (const c of closeArr) {
    const diff = Math.abs(c.ts / 1e6 - candleTs);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best.v / 100;
}

// ── Single instrument DOM card ────────────────────────────────────────────────
function DomCard({ leg, books, onClose }: { leg: BasketLeg; books: Map<number, OrderBook>; onClose: (id: number) => void }) {
  const book = leg.refId ? books.get(leg.refId) ?? null : null;
  const asks = (book?.asks ?? []).slice(0, 5);
  const bids = (book?.bids ?? []).slice(0, 5);
  const ltp = book ? fmtPx(book.last_traded_price) : leg.price.toFixed(2);
  const maxQty = Math.max(...bids.map(b => b.quantity), ...asks.map(a => a.quantity), 1);

  return (
    <div style={{
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      paddingBottom: 2,
    }}>
      {/* Card header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 14px 6px',
        background: 'rgba(255,255,255,0.025)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: '#E2E8F0', letterSpacing: '0.03em' }}>
            {leg.symbol} {leg.strike} {leg.type}
          </span>
          <span style={{
            fontSize: 13, fontWeight: 800, color: '#E2E8F0', fontFamily: 'monospace',
          }}>₹{ltp}</span>
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: book ? '#26a69a' : '#6B7280',
            letterSpacing: '0.06em',
          }}>
            {book ? '● LIVE' : '○ …'}
          </span>
        </div>
        <button
          onClick={() => onClose(leg.id)}
          title="Remove from DOM"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#374151', padding: 2, display: 'flex', alignItems: 'center' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#f23645'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#374151'; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 72px 1px 72px 1fr',
        padding: '5px 14px 4px',
        background: '#333333',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#f23645', letterSpacing: '0.07em', textTransform: 'uppercase' }}>QTY</span>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#f23645', letterSpacing: '0.07em', textAlign: 'right', textTransform: 'uppercase' }}>ASK</span>
        <span />
        <span style={{ fontSize: 9, fontWeight: 700, color: '#26a69a', letterSpacing: '0.07em', textTransform: 'uppercase' }}>BID</span>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#26a69a', letterSpacing: '0.07em', textAlign: 'right', textTransform: 'uppercase' }}>QTY</span>
      </div>

      {/* Rows */}
      <div style={{ padding: '4px 14px 8px' }}>
        {Array(5).fill(null).map((_, i) => {
          const ask = asks[i] ?? null;
          const bid = bids[i] ?? null;
          const askBar = ask ? (ask.quantity / maxQty) * 100 : 0;
          const bidBar = bid ? (bid.quantity / maxQty) * 100 : 0;
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 72px 1px 72px 1fr',
              alignItems: 'center', padding: '2px 0',
              borderBottom: i < 4 ? '1px solid rgba(255,255,255,0.03)' : 'none',
            }}>
              {/* Ask qty bar */}
              <div style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center' }}>
                <div style={{
                  position: 'absolute', right: 0, top: 0, bottom: 0,
                  width: `${askBar}%`, background: 'rgba(242,54,69,0.12)', borderRadius: '2px 0 0 2px',
                }} />
                <span style={{ fontSize: 10, color: '#9CA3AF', position: 'relative', zIndex: 1 }}>
                  {ask ? ask.quantity.toLocaleString('en-IN') : '—'}
                </span>
              </div>
              {/* Ask price */}
              <span style={{ fontSize: 11, fontWeight: 700, color: '#f23645', textAlign: 'right', fontFamily: 'monospace' }}>
                {ask ? fmtPx(ask.price) : '—'}
              </span>
              {/* Divider */}
              <div style={{ width: 1, background: 'rgba(255,255,255,0.08)', alignSelf: 'stretch', margin: '0 4px' }} />
              {/* Bid price */}
              <span style={{ fontSize: 11, fontWeight: 700, color: '#26a69a', fontFamily: 'monospace' }}>
                {bid ? fmtPx(bid.price) : '—'}
              </span>
              {/* Bid qty bar */}
              <div style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${bidBar}%`, background: 'rgba(38,166,154,0.12)', borderRadius: '0 2px 2px 0',
                }} />
                <span style={{ fontSize: 10, color: '#9CA3AF', position: 'relative', zIndex: 1 }}>
                  {bid ? bid.quantity.toLocaleString('en-IN') : '—'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── DOM side panel — rendered by App next to the basket container ─────────────
export function DomSidePanel({ legs, onClose }: { legs: BasketLeg[]; onClose: (id: number) => void }) {
  const [books, setBooks] = useState<Map<number, OrderBook>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const legsRef = useRef<BasketLeg[]>(legs);
  legsRef.current = legs;

  useEffect(() => {
    if (legs.length === 0) return;
    const sessionToken = localStorage.getItem('nubra_session_token');
    if (!sessionToken) return;

    const ws = new WebSocket('ws://localhost:8765');
    wsRef.current = ws;

    ws.onopen = () => {
      const refIds = legs.filter(l => l.refId).map(l => l.refId!);
      if (refIds.length > 0) {
        ws.send(JSON.stringify({ action: 'subscribe', session_token: sessionToken, data_type: 'orderbook', ref_ids: refIds }));
      }
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'orderbook' && msg.data) {
          setBooks(prev => {
            const next = new Map(prev);
            next.set(msg.data.ref_id, msg.data);
            return next;
          });
        }
      } catch { /**/ }
    };
    ws.onerror = () => {};
    ws.onclose = () => { wsRef.current = null; };
    return () => { ws.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs.map(l => l.refId).join(',')]);

  // Subscribe newly added legs on the existing connection
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const sessionToken = localStorage.getItem('nubra_session_token');
    if (!sessionToken) return;
    const refIds = legs.filter(l => l.refId).map(l => l.refId!);
    if (refIds.length > 0) {
      ws.send(JSON.stringify({ action: 'subscribe', session_token: sessionToken, data_type: 'orderbook', ref_ids: refIds }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs.length]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') legs.forEach(l => onClose(l.id)); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [legs, onClose]);

  if (legs.length === 0) return null;

  return (
    <div style={{
      background: '#1d1a17',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 10,
      boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
      overflow: 'hidden',
      width: 300,
      flexShrink: 0,
    }}>
      {/* Panel header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: '#1d1a17',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="14" height="14" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill="#6B9EF8" d="M21 13a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm1-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-1 8a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm1-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 1a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm1 6a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm1-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm4-16c0-1.1.9-2 2-2h4a2 2 0 1 1 0 4h-4a2 2 0 0 1-2-2Zm2-1a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2h-4Zm0 5a2 2 0 1 0 0 4h4a2 2 0 1 0 0-4h-4Zm-1 2a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1ZM10 31c0-1.1.9-2 2-2h4a2 2 0 1 1 0 4h-4a2 2 0 0 1-2-2Zm2-1a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2h-4Zm0-7a2 2 0 1 0 0 4h4a2 2 0 1 0 0-4h-4Zm-1 2a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1Z"/>
          </svg>
          <span style={{ fontSize: 14, fontWeight: 800, color: '#E2E8F0', letterSpacing: '0.04em' }}>Order Book</span>
          <span style={{
            fontSize: 11, fontWeight: 700, color: '#4F8EF7',
            background: 'rgba(79,142,247,0.1)', padding: '3px 9px',
            borderRadius: 6, border: '1px solid rgba(79,142,247,0.2)',
          }}>{legs.length}</span>
        </div>
        <button
          onClick={() => legs.forEach(l => onClose(l.id))}
          title="Close all"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#4B5563', padding: 2, display: 'flex', alignItems: 'center' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#f23645'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#4B5563'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      {/* Cards */}
      <div style={{ maxHeight: 480, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
        {legs.map(leg => (
          <DomCard key={leg.id} leg={leg} books={books} onClose={onClose} />
        ))}
      </div>
    </div>
  );
}

// ── BasketOrder ───────────────────────────────────────────────────────────────
interface BasketOrderProps {
  legs: BasketLeg[];
  onRemove: (id: number) => void;
  onUpdateLots: (id: number, lots: number) => void;
  onUpdateLeg: (id: number, patch: Partial<BasketLeg>) => void;
  onExecute: () => void;
  onClear: () => void;
  domLegs: BasketLeg[];
  onDomToggle: (leg: BasketLeg) => void;
  onDragStart: (e: React.MouseEvent) => void;
}

export default function BasketOrder({ legs, onRemove, onUpdateLots, onUpdateLeg, onExecute, onClear, domLegs, onDomToggle, onDragStart }: BasketOrderProps) {
  const [executing, setExecuting] = useState(false);
  const [priceLoadingId, setPriceLoadingId] = useState<number | null>(null);

  if (legs.length === 0) return null;

  const handleExecute = () => {
    setExecuting(true);
    setTimeout(() => setExecuting(false), 1200);
    onExecute();
  };

  return (
    <div style={{ background: '#1d1a17', borderRadius: 10, overflow: 'hidden', flexShrink: 0 }}>

      {/* Header — drag handle */}
      <div
        onMouseDown={onDragStart}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0, background: 'var(--bg-panel, #1d1a17)',
          cursor: 'grab', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E2E8F0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <path d="M16 10a4 4 0 0 1-8 0"/>
          </svg>
          <span style={{ fontSize: 18, fontWeight: 800, color: '#E2E8F0', letterSpacing: '0.04em' }}>
            Basket Order
          </span>
          <span style={{
            fontSize: 12, fontWeight: 700, color: '#4F8EF7',
            background: 'rgba(79,142,247,0.1)', padding: '4px 12px',
            borderRadius: 8, border: '1px solid rgba(79,142,247,0.2)',
          }}>
            {legs.length} leg{legs.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={onClear}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
            background: 'rgba(242,54,69,0.1)', border: '1px solid rgba(242,54,69,0.35)',
            color: '#f23645', fontSize: 12, fontWeight: 700, letterSpacing: '0.03em',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(242,54,69,0.2)'; e.currentTarget.style.borderColor = 'rgba(242,54,69,0.6)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(242,54,69,0.1)'; e.currentTarget.style.borderColor = 'rgba(242,54,69,0.35)'; }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
          Clear all
        </button>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '68px 1fr 96px 80px 72px 90px 36px',
        padding: '7px 20px',
        background: '#333333',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        {['B/S', 'Instrument', 'Order', 'Qty', 'Time', 'Price', ''].map((h, i) => (
          <span key={i} style={{
            fontSize: 11, fontWeight: 700, color: '#9CA3AF',
            textTransform: 'uppercase', letterSpacing: '0.05em',
            textAlign: i === 3 || i === 4 || i === 5 ? 'center' : 'left',
          }}>{h}</span>
        ))}
      </div>

      {/* Leg rows */}
      <div style={{ maxHeight: 300, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
        {(() => {
          const groups: { symbol: string; legs: BasketLeg[] }[] = [];
          for (const leg of legs) {
            const g = groups.find(g => g.symbol === leg.symbol);
            if (g) g.legs.push(leg);
            else groups.push({ symbol: leg.symbol, legs: [leg] });
          }
          const multipleGroups = groups.length > 1;

          return groups.map(group => (
            <div key={group.symbol}>
              {multipleGroups && (
                <div style={{
                  padding: '5px 20px 4px',
                  background: 'rgba(255,255,255,0.035)',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  display: 'flex', alignItems: 'center', gap: 7,
                }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: '#9CA3AF', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {group.symbol}
                  </span>
                  <span style={{ fontSize: 10, color: '#4B5563', fontWeight: 600 }}>
                    {group.legs.length} leg{group.legs.length !== 1 ? 's' : ''}
                  </span>
                </div>
              )}

              {group.legs.map(leg => {
                const isBuy = leg.action === 'B';
                const instrName = `${leg.symbol} ${fmtExpiry(leg.expiry)} ${leg.strike} ${leg.type}`;
                const isActive = domLegs.some(d => d.id === leg.id);
                return (
                  <div
                    key={leg.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '68px 1fr 96px 80px 72px 90px 36px',
                      alignItems: 'center',
                      padding: '8px 20px',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      transition: 'background 0.1s',
                      background: isActive ? 'rgba(107,158,248,0.04)' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'; }}
                    onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                  >
                    {/* B/S badge */}
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 40, height: 22, borderRadius: 5,
                      background: isBuy ? 'rgba(38,166,154,0.18)' : 'rgba(242,54,69,0.18)',
                      border: `1px solid ${isBuy ? 'rgba(38,166,154,0.5)' : 'rgba(242,54,69,0.5)'}`,
                    }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: isBuy ? '#26a69a' : '#f23645', letterSpacing: '0.05em' }}>
                        {isBuy ? 'BUY' : 'SELL'}
                      </span>
                    </div>

                    {/* Instrument name */}
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingRight: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {instrName}
                      </span>
                      <span style={{ fontSize: 10, color: '#6B7280', fontWeight: 500, marginTop: 1 }}>
                        {leg.symbol} {isMcxExpiry(leg.expiry) ? 'MCX' : 'NFO'}
                      </span>
                    </div>

                    {/* Order type */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{
                        height: 22, borderRadius: 5, padding: '0 10px',
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em' }}>MARKET</span>
                      </div>
                    </div>

                    {/* Qty stepper */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 5, overflow: 'hidden', height: 24,
                    }}>
                      <button
                        onClick={() => onUpdateLots(leg.id, Math.max(1, leg.lots - 1))}
                        style={{ width: 20, height: 24, background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                      >−</button>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0', minWidth: 18, textAlign: 'center' }}>{leg.lots}</span>
                      <button
                        onClick={() => onUpdateLots(leg.id, leg.lots + 1)}
                        style={{ width: 20, height: 24, background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                      >+</button>
                    </div>

                    {/* Time picker (historical LTP) */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <input
                        type="time"
                        value={leg.entryTime ?? ''}
                        onChange={e => {
                          const v = e.target.value;
                          const date = leg.entryDate ?? todayIst();
                          onUpdateLeg(leg.id, { entryTime: v, entryDate: date });
                        }}
                        onBlur={async e => {
                          const v = e.target.value;
                          if (!v) return;
                          if (isMcxExpiry(leg.expiry) || (leg.instrumentKey ?? '').toUpperCase().includes('MCX')) return;
                          const date = leg.entryDate ?? todayIst();
                          const optName = buildOptName(leg.symbol, leg.expiry, leg.strike, leg.type);
                          if (!optName) return;
                          setPriceLoadingId(leg.id);
                          try {
                            const price = await fetchHistoricalOptionClose(optName, 'NSE', date, v);
                            if (price != null) onUpdateLeg(leg.id, { price });
                          } finally {
                            setPriceLoadingId(prev => (prev === leg.id ? null : prev));
                          }
                        }}
                        style={{
                          width: 66,
                          height: 24,
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: 5,
                          color: '#E2E8F0',
                          fontSize: 11,
                          fontWeight: 700,
                          textAlign: 'center',
                          outline: 'none',
                        }}
                      />
                    </div>

                    {/* Price + DOM toggle */}
                    <button
                      onClick={() => onDomToggle(leg)}
                      title="Toggle Order Book"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                        background: isActive ? 'rgba(107,158,248,0.12)' : 'transparent',
                        border: isActive ? '1px solid rgba(107,158,248,0.3)' : '1px solid transparent',
                        borderRadius: 5, cursor: 'pointer', padding: '2px 4px',
                        transition: 'all 0.15s',
                      }}
                    >
                      <svg width="20" height="20" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
                        <path fill={isActive ? '#6B9EF8' : '#4B6EA8'} d="M21 13a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm1-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-1 8a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm1-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 1a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm1 6a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm1-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm4-16c0-1.1.9-2 2-2h4a2 2 0 1 1 0 4h-4a2 2 0 0 1-2-2Zm2-1a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2h-4Zm0 5a2 2 0 1 0 0 4h4a2 2 0 1 0 0-4h-4Zm-1 2a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1ZM10 31c0-1.1.9-2 2-2h4a2 2 0 1 1 0 4h-4a2 2 0 0 1-2-2Zm2-1a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2h-4Zm0-7a2 2 0 1 0 0 4h4a2 2 0 1 0 0-4h-4Zm-1 2a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1Z"/>
                      </svg>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#C0C0C0', fontFamily: 'monospace' }}>
                        {priceLoadingId === leg.id ? '…' : `₹${leg.price.toFixed(2)}`}
                      </span>
                    </button>

                    {/* Remove */}
                    <button
                      onClick={() => { onRemove(leg.id); }}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 4 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#f23645'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#374151'; }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14H6L5 6"/>
                        <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          ));
        })()}
      </div>

      {/* Margin Breakdown */}
      <MarginBreakdown legs={legs} />

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 20px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
      }}>
        <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 500, flex: 1 }}>
          {legs.length} order{legs.length !== 1 ? 's' : ''} · Market
        </span>
        <button
          onClick={handleExecute}
          disabled={executing}
          style={{
            padding: '7px 24px', borderRadius: 7,
            background: executing ? 'rgba(37,99,235,0.4)' : 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
            border: '1px solid rgba(37,99,235,0.5)',
            color: '#fff', fontSize: 12, fontWeight: 700,
            cursor: executing ? 'default' : 'pointer',
            letterSpacing: '0.04em',
            boxShadow: executing ? 'none' : '0 2px 8px rgba(37,99,235,0.35)',
            transition: 'all 0.15s', opacity: executing ? 0.7 : 1,
          }}
        >
          {executing ? 'Placing…' : 'Execute'}
        </button>
      </div>
    </div>
  );
}
