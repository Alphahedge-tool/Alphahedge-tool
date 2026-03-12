'use client';

import { useRef, useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Instrument } from '../useInstruments';
import type { WorkspaceState, WorkspaceAction, ViewType, LayoutId } from './workspaceTypes';
import { LAYOUT_TEMPLATES, buildGridTemplate } from './layoutTemplates';
import { LayoutPicker } from './LayoutPicker';
import { SplitDivider } from './SplitDivider';
import { PaneShell } from './PaneShell';
import { DrawingToolbar } from '../DrawingToolbar';
import type { DrawingEngineHandle } from '../DrawingToolbar';

// ── Interval definitions (mirrored from CandleChart) ─────────────────────────
const INTERVALS = [
  { label: '1m',  value: 'I1'  },
  { label: '5m',  value: 'I5'  },
  { label: '15m', value: 'I15' },
  { label: '30m', value: 'I30' },
];

// ── View options ─────────────────────────────────────────────────────────────
const VIEW_OPTIONS: { value: ViewType; label: string; icon: React.ReactNode }[] = [
  {
    value: 'candle', label: 'Candle',
    icon: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="7" width="4" height="10" rx="1"/><line x1="9" y1="3" x2="9" y2="7"/><line x1="9" y1="17" x2="9" y2="21"/><rect x="13" y="4" width="4" height="8" rx="1"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="15" y1="12" x2="15" y2="15"/></svg>,
  },
  {
    value: 'straddle', label: 'Straddle',
    icon: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 8 12 13 15 21 7"/><polyline points="3 7 8 12 13 9 21 17"/></svg>,
  },
  {
    value: 'oiprofile', label: 'OI',
    icon: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="20" x2="21" y2="20"/><rect x="4" y="12" width="4" height="8" rx="1"/><rect x="10" y="6" width="4" height="14" rx="1"/><rect x="16" y="9" width="4" height="11" rx="1"/></svg>,
  },
];

// ── Interval dropdown ────────────────────────────────────────────────────────
function IntervalDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = INTERVALS.find(i => i.value === value) ?? INTERVALS[0];

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        title="Timeframe"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          height: 32, padding: '0 6px',
          background: 'transparent',
          border: 'none',
          borderRadius: 4, cursor: 'pointer',
          fontSize: 13, fontWeight: 600, color: '#D1D4DC',
          letterSpacing: '0.02em',
          transition: 'color 0.12s, background 0.12s', whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
      >
        {current.label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          <path d="m19 9-7 7-7-7"/>
        </svg>
      </button>
      {open && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9500 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: 9501,
            background: '#181B27',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 8, padding: '6px',
            minWidth: 130,
            boxShadow: '0 12px 40px rgba(0,0,0,0.75)',
          }}>
            <div style={{ padding: '4px 8px 6px', fontSize: 10, fontWeight: 700, color: '#4A4E5C', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Timeframe</div>
            {INTERVALS.map(iv => {
              const active = iv.value === value;
              return (
                <button
                  key={iv.value}
                  onClick={() => { onChange(iv.value); setOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    width: '100%', padding: '7px 10px',
                    background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                    border: 'none', borderRadius: 5, cursor: 'pointer',
                    fontSize: 13, fontWeight: active ? 700 : 500,
                    color: active ? '#FFFFFF' : '#9B9EA8',
                    transition: 'all 0.1s',
                  }}
                  onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; (e.currentTarget as HTMLButtonElement).style.color = '#D1D4DC'; } }}
                  onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#9B9EA8'; } }}
                >
                  {iv.label}
                  {active && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}
    </>
  );
}

// ── Indicators dropdown ───────────────────────────────────────────────────────
const VWAP_ANCHORS: { id: VwapAnchor; label: string; short: string }[] = [
  { id: 'daily',   label: 'Daily',           short: 'D'   },
  { id: 'weekly',  label: 'Weekly',           short: 'W'   },
  { id: 'monthly', label: 'Monthly',          short: 'M'   },
  { id: 'expiry',  label: 'Expiry-to-Expiry', short: 'EXP' },
];

const VWAP_COLORS = ['#FFD700','#FF6B6B','#4ECDC4','#A78BFA','#F97316','#22C55E','#FFFFFF','#60A5FA'];

function IndicatorsDropdown({
  vwapShow, vwapAnchor, vwapColor, vwapExpiryDay, twapShow,
  onVwapToggle, onVwapAnchor, onVwapColor, onVwapExpiryDay, onTwapToggle,
}: {
  vwapShow: boolean; vwapAnchor: VwapAnchor; vwapColor: string; vwapExpiryDay: 'tuesday'|'thursday'; twapShow: boolean;
  onVwapToggle: () => void; onVwapAnchor: (a: VwapAnchor) => void; onVwapColor: (c: string) => void; onVwapExpiryDay: (d: 'tuesday'|'thursday') => void; onTwapToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const anyActive = vwapShow || twapShow;

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(o => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        title="Indicators"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 30, padding: '0 11px',
          background: anyActive ? 'rgba(79,142,247,0.12)' : open ? 'rgba(255,255,255,0.07)' : 'transparent',
          border: `1px solid ${anyActive ? 'rgba(79,142,247,0.35)' : open ? 'rgba(255,255,255,0.12)' : 'transparent'}`,
          borderRadius: 5, cursor: 'pointer',
          fontSize: 12, fontWeight: anyActive ? 600 : 400,
          color: anyActive ? '#4F8EF7' : '#6B7280',
          letterSpacing: '0.02em',
          transition: 'all 0.12s', whiteSpace: 'nowrap', userSelect: 'none',
          fontFamily: 'inherit',
        } as React.CSSProperties}
        onMouseEnter={e => { if (!anyActive && !open) { const el = e.currentTarget as HTMLButtonElement; el.style.background = 'rgba(255,255,255,0.06)'; el.style.color = '#9CA3AF'; } }}
        onMouseLeave={e => { if (!anyActive && !open) { const el = e.currentTarget as HTMLButtonElement; el.style.background = 'transparent'; el.style.color = '#6B7280'; } }}
      >
        <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0 }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 18 8 11 13 15 18 7 21 10"/>
            <circle cx="8" cy="11" r="1.8" fill="currentColor" stroke="none"/>
            <circle cx="13" cy="15" r="1.8" fill="currentColor" stroke="none"/>
            <circle cx="18" cy="7" r="1.8" fill="currentColor" stroke="none"/>
          </svg>
        </span>
        <span style={{ lineHeight: 1 }}>Indicators</span>
        {anyActive && (
          <span style={{
            width: 16, height: 16, borderRadius: '50%',
            background: '#4F8EF7', color: '#fff', fontSize: 10, fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            flexShrink: 0,
          }}>
            {(vwapShow ? 1 : 0) + (twapShow ? 1 : 0)}
          </span>
        )}
        <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0, opacity: 0.4 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
            <path d="m19 9-7 7-7-7"/>
          </svg>
        </span>
      </button>

      {open && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9500 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: 9501,
            background: '#181B27',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 10, padding: '8px',
            width: 240,
            boxShadow: '0 16px 48px rgba(0,0,0,0.80), inset 0 1px 0 rgba(255,255,255,0.05)',
          }}>
            <div style={{ padding: '2px 6px 8px', fontSize: 10, fontWeight: 700, color: '#4A4E5C', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Indicators</div>

            {/* ── VWAP row ── */}
            <div style={{
              borderRadius: 7,
              border: vwapShow ? '1px solid rgba(255,215,0,0.20)' : '1px solid rgba(255,255,255,0.06)',
              background: vwapShow ? 'rgba(255,215,0,0.05)' : 'rgba(255,255,255,0.02)',
              marginBottom: 6,
              overflow: 'hidden',
            }}>
              {/* VWAP toggle row */}
              <button
                onClick={onVwapToggle}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '9px 12px',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                {/* Toggle pill */}
                <span style={{
                  width: 32, height: 18, borderRadius: 9, flexShrink: 0,
                  background: vwapShow ? '#FFD700' : 'rgba(255,255,255,0.12)',
                  position: 'relative', transition: 'background 0.2s',
                  display: 'inline-block',
                }}>
                  <span style={{
                    position: 'absolute', top: 3, left: vwapShow ? 16 : 3,
                    width: 12, height: 12, borderRadius: '50%',
                    background: vwapShow ? '#000' : '#787B86',
                    transition: 'left 0.2s, background 0.2s',
                  }} />
                </span>
                {/* Line preview */}
                <svg width="28" height="14" viewBox="0 0 28 14" fill="none">
                  <path d="M1 10 L7 4 L14 7 L21 2 L27 5" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M1 12 L7 6 L14 9 L21 4 L27 7" stroke="rgba(255,215,0,0.4)" strokeWidth="1" strokeLinecap="round" strokeDasharray="2 2"/>
                </svg>
                <span style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: vwapShow ? '#FFFFFF' : '#9B9EA8', letterSpacing: '0.02em' }}>VWAP</div>
                  <div style={{ fontSize: 10, color: '#4A4E5C', marginTop: 1 }}>Volume Weighted Avg Price</div>
                </span>
              </button>

              {/* Settings — only when VWAP on */}
              {vwapShow && (
                <div style={{ borderTop: '1px solid rgba(255,215,0,0.12)', padding: '8px 12px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>

                  {/* Color row */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#4A4E5C', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Line Color</div>
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      {VWAP_COLORS.map(c => (
                        <button
                          key={c}
                          onClick={() => onVwapColor(c)}
                          title={c}
                          style={{
                            width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                            background: c, border: vwapColor === c ? '2px solid #FFFFFF' : '2px solid transparent',
                            cursor: 'pointer', padding: 0,
                            boxShadow: vwapColor === c ? `0 0 0 1px ${c}` : 'none',
                            transition: 'all 0.12s',
                          }}
                        />
                      ))}
                      {/* Custom color input */}
                      <label title="Custom color" style={{ position: 'relative', width: 20, height: 20, cursor: 'pointer', flexShrink: 0 }}>
                        <span style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: 20, height: 20, borderRadius: '50%',
                          background: 'rgba(255,255,255,0.08)',
                          border: '1.5px dashed rgba(255,255,255,0.25)',
                          fontSize: 12, color: '#787B86',
                        }}>+</span>
                        <input type="color" value={vwapColor} onChange={e => onVwapColor(e.target.value)}
                          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', border: 'none', padding: 0 }} />
                      </label>
                    </div>
                  </div>

                  {/* Anchor row */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#4A4E5C', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Anchor Period</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {VWAP_ANCHORS.map(a => {
                        const active = vwapAnchor === a.id;
                        return (
                          <button key={a.id} onClick={() => onVwapAnchor(a.id)}
                            style={{
                              height: 26, padding: '0 10px',
                              background: active ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.05)',
                              border: active ? `1px solid ${vwapColor}88` : '1px solid rgba(255,255,255,0.08)',
                              borderRadius: 5, cursor: 'pointer',
                              fontSize: 11, fontWeight: active ? 700 : 500,
                              color: active ? vwapColor : '#787B86',
                              transition: 'all 0.12s',
                            }}
                            onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.10)'; (e.currentTarget as HTMLButtonElement).style.color = '#C4C7D0'; } }}
                            onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; (e.currentTarget as HTMLButtonElement).style.color = '#787B86'; } }}
                          >
                            {a.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Expiry day — only when anchor = expiry */}
                  {vwapAnchor === 'expiry' && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#4A4E5C', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Expiry Day</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {(['tuesday','thursday'] as const).map(d => {
                          const active = vwapExpiryDay === d;
                          return (
                            <button key={d} onClick={() => onVwapExpiryDay(d)}
                              style={{
                                height: 28, padding: '0 12px', borderRadius: 5, cursor: 'pointer',
                                background: active ? `${vwapColor}22` : 'rgba(255,255,255,0.05)',
                                border: active ? `1px solid ${vwapColor}88` : '1px solid rgba(255,255,255,0.08)',
                                fontSize: 12, fontWeight: active ? 700 : 500,
                                color: active ? vwapColor : '#787B86',
                                transition: 'all 0.12s',
                              }}
                              onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.10)'; (e.currentTarget as HTMLButtonElement).style.color = '#C4C7D0'; } }}
                              onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; (e.currentTarget as HTMLButtonElement).style.color = '#787B86'; } }}
                            >
                              {d === 'tuesday' ? 'Tuesday' : 'Thursday'}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── TWAP row ── */}
            <div style={{
              borderRadius: 7,
              border: twapShow ? '1px solid rgba(0,191,255,0.20)' : '1px solid rgba(255,255,255,0.06)',
              background: twapShow ? 'rgba(0,191,255,0.05)' : 'rgba(255,255,255,0.02)',
              overflow: 'hidden',
            }}>
              <button
                onClick={onTwapToggle}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '9px 12px',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                <span style={{
                  width: 32, height: 18, borderRadius: 9, flexShrink: 0,
                  background: twapShow ? '#00BFFF' : 'rgba(255,255,255,0.12)',
                  position: 'relative', transition: 'background 0.2s',
                  display: 'inline-block',
                }}>
                  <span style={{
                    position: 'absolute', top: 3, left: twapShow ? 16 : 3,
                    width: 12, height: 12, borderRadius: '50%',
                    background: twapShow ? '#000' : '#787B86',
                    transition: 'left 0.2s, background 0.2s',
                  }} />
                </span>
                <svg width="28" height="14" viewBox="0 0 28 14" fill="none">
                  <path d="M1 8 L5 5 L10 9 L15 4 L20 7 L27 3" stroke="#00BFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 2"/>
                </svg>
                <span style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: twapShow ? '#FFFFFF' : '#9B9EA8', letterSpacing: '0.02em' }}>TWAP</div>
                  <div style={{ fontSize: 10, color: '#4A4E5C', marginTop: 1 }}>Time Weighted Avg Price</div>
                </span>
              </button>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}


// ── Layout button ─────────────────────────────────────────────────────────────
function LayoutButton({ activeLayout, onLayoutChange }: { activeLayout: LayoutId; onLayoutChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        title="Change layout"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 32,
          background: open ? 'rgba(255,152,0,0.10)' : 'transparent',
          border: `1px solid ${open ? 'rgba(255,152,0,0.45)' : 'transparent'}`,
          borderRadius: 4, cursor: 'pointer',
          color: open ? '#FF9800' : '#787B86',
          transition: 'background 0.12s, border-color 0.12s, color 0.12s',
        }}
        onMouseEnter={e => { if (!open) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLButtonElement).style.color = '#C4C7D0'; } }}
        onMouseLeave={e => { if (!open) { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#787B86'; } }}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
      </button>
      {open && (
        <LayoutPicker
          anchorRef={btnRef}
          activeLayout={activeLayout}
          onSelect={id => { onLayoutChange(id); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ── VWAP anchor type (mirrored from CandleChart) ─────────────────────────────
type VwapAnchor = 'daily' | 'weekly' | 'monthly' | 'expiry';

// ── VWAP Settings Panel ───────────────────────────────────────────────────────
function VwapSettingsPanel({
  anchorRef, panelRef, anchor, onAnchor, onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  panelRef:  React.RefObject<HTMLDivElement | null>;
  anchor:    VwapAnchor;
  onAnchor:  (a: VwapAnchor) => void;
  onClose:   () => void;
}) {
  const pos = useMemo(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      return { top: r.bottom + 6, right: window.innerWidth - r.right };
    }
    return { top: 0, right: 0 };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !panelRef.current?.contains(t)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [anchorRef, panelRef, onClose]);

  const anchors: { id: VwapAnchor; label: string; sub: string }[] = [
    { id: 'daily',   label: 'Daily',           sub: 'Reset at 9:15 AM IST each day'     },
    { id: 'weekly',  label: 'Weekly',           sub: 'Reset each Monday'                  },
    { id: 'monthly', label: 'Monthly',          sub: 'Reset at month start'               },
    { id: 'expiry',  label: 'Expiry-to-Expiry', sub: 'Reset at each F&O expiry boundary'  },
  ];

  return createPortal(
    <div ref={panelRef as React.RefObject<HTMLDivElement>} style={{
      position: 'fixed', top: pos.top, right: pos.right, zIndex: 9999,
      width: 260, background: 'rgba(18,20,28,0.97)',
      border: '1px solid rgba(255,255,255,0.10)', borderRadius: 10,
      boxShadow: '0 16px 48px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.07)',
      backdropFilter: 'blur(20px)', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#D1D4DC', textTransform: 'uppercase' }}>VWAP Anchor</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4A4E5C', padding: 2, display: 'flex', alignItems: 'center' }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 18 17.94 6M18 18 6.06 6"/></svg>
        </button>
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {anchors.map(a => {
          const active = anchor === a.id;
          return (
            <button key={a.id} onClick={() => { onAnchor(a.id); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '9px 12px', borderRadius: 7, cursor: 'pointer', width: '100%', textAlign: 'left',
                border: active ? '1px solid rgba(255,215,0,0.40)' : '1px solid rgba(255,255,255,0.07)',
                background: active ? 'rgba(255,215,0,0.08)' : 'rgba(255,255,255,0.03)', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: active ? '#FFD700' : '#333333' }} />
              <span style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: active ? '#FFD700' : '#9B9EA8' }}>{a.label}</div>
                <div style={{ fontSize: 10, color: '#4A4E5C', marginTop: 1 }}>{a.sub}</div>
              </span>
              {active && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFD700" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
}

// ── WorkspaceToolbar ──────────────────────────────────────────────────────────
interface WorkspaceToolbarProps {
  state: WorkspaceState;
  dispatch: React.Dispatch<WorkspaceAction>;
  activePaneId: string | null;
  onSearchOpen: () => void;
  instruments: Instrument[];
  openOiSettingsRef: { current: (() => void) | null };
  oiSettingsAnchorRef: React.RefObject<HTMLButtonElement | null>;
}

function WorkspaceToolbar({ state, dispatch, activePaneId, onSearchOpen, instruments, openOiSettingsRef, oiSettingsAnchorRef }: WorkspaceToolbarProps) {
  const activePane = state.panes.find(p => p.id === activePaneId) ?? state.panes[0];
  if (!activePane) return null;

  const interval = activePane.interval ?? 'I1';
  const oiShow = activePane.oiShow ?? false;
  const optionChainOpen = activePane.optionChainOpen ?? false;
  const vwapShow      = activePane.vwapShow      ?? false;
  const vwapAnchor    = activePane.vwapAnchor    ?? 'daily';
  const vwapColor     = activePane.vwapColor     ?? '#FFD700';
  const vwapExpiryDay = activePane.vwapExpiryDay ?? 'thursday';
  const twapShow      = activePane.twapShow      ?? false;

  // Mirror hasOptions logic from CandleChart
  const ins = activePane.instrument;
  const hasOptions = ins
    ? (ins.instrument_type === 'INDEX' || ins.instrument_type === 'EQ'
        ? true
        : (ins.instrument_type === 'FUT' || ins.instrument_type === 'CE' || ins.instrument_type === 'PE')
          ? instruments.some(i => (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.underlying_symbol === ins.underlying_symbol)
          : false)
    : false;

  // accent palette — single slate-blue throughout
  const A = {
    base:   '#4F8EF7',
    bg:     'rgba(79,142,247,0.12)',
    border: 'rgba(79,142,247,0.35)',
    dim:    'rgba(79,142,247,0.60)',
  };

  // Reusable icon-only / icon+label toolbar button
  const tbBtn = (
    active: boolean,
    activeColor: string,
    onClick: () => void,
    title: string,
    icon: React.ReactNode,
    label?: string,
    extraRef?: React.RefObject<HTMLButtonElement | null>,
  ) => {
    const aBg     = active ? `${activeColor}18` : 'transparent';
    const aBorder = active ? `${activeColor}40` : 'transparent';
    const aColor  = active ? activeColor : '#C9D1DC';
    return (
      <button
        ref={extraRef}
        onClick={onClick}
        title={title}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: label ? 6 : 0,
          height: 32, padding: label ? '0 11px' : '0 8px',
          background: aBg,
          border: `1px solid ${aBorder}`,
          borderRadius: 5, cursor: 'pointer',
          fontSize: 13, fontWeight: active ? 600 : 500,
          color: aColor,
          transition: 'background 0.12s, color 0.12s, border-color 0.12s',
          whiteSpace: 'nowrap', flexShrink: 0, userSelect: 'none',
        } as React.CSSProperties}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLButtonElement;
          if (!active) { el.style.background = 'rgba(255,255,255,0.06)'; el.style.color = '#FFFFFF'; }
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLButtonElement;
          if (!active) { el.style.background = 'transparent'; el.style.color = '#C9D1DC'; }
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0, flexShrink: 0 }}>{icon}</span>
        {label && <span style={{ lineHeight: 1 }}>{label}</span>}
      </button>
    );
  };

  const SEP = (
    <div style={{ width: 1, alignSelf: 'stretch', margin: '10px 8px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
  );

  return (
    <div style={{
      height: 46, flexShrink: 0,
      display: 'flex', alignItems: 'center',
      padding: '0 14px', gap: 3,
      background: '#171717',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      overflow: 'hidden', minWidth: 0,
      userSelect: 'none',
      fontFamily: 'inherit',
    } as React.CSSProperties}>

      {/* ── Symbol search field (TradingView flat style) ── */}
      <button
        onClick={onSearchOpen}
        title="Search symbol"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          height: 32, padding: '0 6px',
          background: 'transparent',
          border: 'none',
          borderRadius: 4, cursor: 'pointer',
          flexShrink: 0, minWidth: 0,
          transition: 'background 0.12s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: 'block' }}>
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        {activePane.instrument ? (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#D1D4DC', letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
            {activePane.instrument.name || activePane.instrument.trading_symbol}
          </span>
        ) : (
          <span style={{ fontSize: 13, color: '#787B86', letterSpacing: '0.02em' }}>Symbol…</span>
        )}
      </button>

      {SEP}

      {/* ── Timeframe dropdown — candle view only ── */}
      {activePane.viewType === 'candle' && (
        <>
          <IntervalDropdown
            value={interval}
            onChange={v => dispatch({ type: 'SET_INTERVAL', paneId: activePane.id, interval: v })}
          />
          {SEP}
        </>
      )}

      {/* ── View type toggle group (flat style) ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        {VIEW_OPTIONS.map(opt => {
          const active = opt.value === activePane.viewType;
          return (
            <button
              key={opt.value}
              onClick={() => dispatch({ type: 'SET_VIEW', paneId: activePane.id, viewType: opt.value })}
              title={opt.label}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                height: 28, padding: '0 8px',
                background: 'transparent',
                border: 'none',
                borderRadius: 4, cursor: 'pointer',
                fontSize: 12, fontWeight: active ? 600 : 400,
                color: active ? '#D1D4DC' : '#787B86',
                transition: 'color 0.12s, background 0.12s', whiteSpace: 'nowrap',
                userSelect: 'none',
              } as React.CSSProperties}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#D1D4DC'; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#787B86'; }}
            >
              <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0, flexShrink: 0 }}>{opt.icon}</span>
              <span style={{ lineHeight: 1 }}>{opt.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── Indicators dropdown — candle only ── */}
      {activePane.viewType === 'candle' && (
        <>
          {SEP}
          <IndicatorsDropdown
            vwapShow={vwapShow}
            vwapAnchor={vwapAnchor}
            vwapColor={vwapColor}
            vwapExpiryDay={vwapExpiryDay}
            twapShow={twapShow}
            onVwapToggle={() => dispatch({ type: 'SET_VWAP_SHOW', paneId: activePane.id, vwapShow: !vwapShow })}
            onVwapAnchor={a => dispatch({ type: 'SET_VWAP_ANCHOR', paneId: activePane.id, vwapAnchor: a })}
            onVwapColor={c => dispatch({ type: 'SET_VWAP_COLOR', paneId: activePane.id, vwapColor: c })}
            onVwapExpiryDay={d => dispatch({ type: 'SET_VWAP_EXPIRY_DAY', paneId: activePane.id, vwapExpiryDay: d })}
            onTwapToggle={() => dispatch({ type: 'SET_TWAP_SHOW', paneId: activePane.id, twapShow: !twapShow })}
          />
        </>
      )}

      {/* ── OI Profile + OC Panel — candle + has options only ── */}
      {activePane.viewType === 'candle' && hasOptions && (
        <>
          {SEP}

          {/* OI Profile */}
          {tbBtn(
            oiShow, A.base,
            () => dispatch({ type: 'SET_OI_SHOW', paneId: activePane.id, oiShow: !oiShow }),
            'Toggle OI profile overlay',
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="3" x2="3" y2="21"/>
              <rect x="3" y="5" width="7" height="3" rx="1"/>
              <rect x="3" y="11" width="13" height="3" rx="1"/>
              <rect x="3" y="17" width="5" height="3" rx="1"/>
            </svg>,
            'OI Profile',
          )}

          {/* OI Settings gear — only when OI active */}
          {oiShow && tbBtn(
            false, '#6B7280',
            () => openOiSettingsRef.current?.(),
            'OI Profile Settings',
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>,
            undefined,
            oiSettingsAnchorRef,
          )}

          {/* OC Panel */}
          {tbBtn(
            optionChainOpen, A.base,
            () => dispatch({ type: 'SET_OC_OPEN', paneId: activePane.id, optionChainOpen: !optionChainOpen }),
            'Toggle option chain panel',
            <svg width="26" height="26" viewBox="0 0 38 38" fill="none" style={{ filter: optionChainOpen ? `drop-shadow(0 0 4px ${A.base}99)` : 'none', transition: 'filter 0.15s' }}>
              <path d="M19.3956 10.4C19.3956 10.1791 19.2165 10 18.9956 10C18.7748 10 18.5957 10.1791 18.5957 10.4V27.2002C18.5957 27.4211 18.7748 27.6002 18.9956 27.6002C19.2165 27.6002 19.3956 27.4211 19.3956 27.2002V10.4Z" fill="currentColor"/>
              <path d="M16.1929 11.5977H11.3936C10.9519 11.5977 10.5938 11.9558 10.5938 12.3977C10.5938 12.8395 10.9519 13.1977 11.3936 13.1977H16.1929C16.6347 13.1977 16.9928 12.8395 16.9928 12.3977C16.9928 11.9558 16.6347 11.5977 16.1929 11.5977Z" fill="currentColor"/>
              <path d="M27.401 11.5977H21.8018C21.3601 11.5977 21.002 11.9558 21.002 12.3977C21.002 12.8395 21.3601 13.1977 21.8018 13.1977H27.401C27.8428 13.1977 28.2009 12.8395 28.2009 12.3977C28.2009 11.9558 27.8428 11.5977 27.401 11.5977Z" fill="currentColor"/>
              <path d="M16.1989 19.6016H9.79988C9.35812 19.6016 9 19.9597 9 20.4016C9 20.8434 9.35812 21.2016 9.79988 21.2016H16.1989C16.6407 21.2016 16.9988 20.8434 16.9988 20.4016C16.9988 19.9597 16.6407 19.6016 16.1989 19.6016Z" fill="currentColor"/>
              <path d="M25.0014 19.6016H21.8018C21.3601 19.6016 21.002 19.9597 21.002 20.4016C21.002 20.8434 21.3601 21.2016 21.8018 21.2016H25.0014C25.4431 21.2016 25.8013 20.8434 25.8013 20.4016C25.8013 19.9597 25.4431 19.6016 25.0014 19.6016Z" fill="currentColor"/>
              <path d="M16.1928 15.6016H12.9932C12.5515 15.6016 12.1934 15.9597 12.1934 16.4016C12.1934 16.8434 12.5515 17.2016 12.9932 17.2016H16.1928C16.6345 17.2016 16.9927 16.8434 16.9927 16.4016C16.9927 15.9597 16.6345 15.6016 16.1928 15.6016Z" fill="currentColor"/>
              <path d="M28.2009 15.6016H21.8018C21.3601 15.6016 21.002 15.9597 21.002 16.4016C21.002 16.8434 21.3601 17.2016 21.8018 17.2016H28.2009C28.6427 17.2016 29.0008 16.8434 29.0008 16.4016C29.0008 15.9597 28.6427 15.6016 28.2009 15.6016Z" fill="currentColor"/>
              <path d="M16.1979 23.5996H10.5987C10.1569 23.5996 9.79883 23.9578 9.79883 24.3996C9.79883 24.8414 10.1569 25.1996 10.5987 25.1996H16.1979C16.6397 25.1996 16.9978 24.8414 16.9978 24.3996C16.9978 23.9578 16.6397 23.5996 16.1979 23.5996Z" fill="currentColor"/>
              <path d="M26.6011 23.5996H21.8018C21.3601 23.5996 21.002 23.9578 21.002 24.3996C21.002 24.8414 21.3601 25.1996 21.8018 25.1996H26.6011C27.0429 25.1996 27.401 24.8414 27.401 24.3996C27.401 23.9578 27.0429 23.5996 26.6011 23.5996Z" fill="currentColor"/>
            </svg>,
            'OC Panel',
          )}
        </>
      )}

      {/* ── Layout picker ── */}
      {SEP}
      <LayoutButton
        activeLayout={state.activeLayout}
        onLayoutChange={id => dispatch({ type: 'SET_LAYOUT', layoutId: id as LayoutId })}
      />
    </div>
  );
}

// ── WorkspaceRoot ─────────────────────────────────────────────────────────────
interface WorkspaceRootProps {
  state: WorkspaceState;
  dispatch: React.Dispatch<WorkspaceAction>;
  instruments: Instrument[];
  activePaneId: string | null;
  onPaneClick: (paneId: string) => void;
  onPaneSearch: (paneId: string, onSelect: (ins: Instrument) => void) => void;
}

export function WorkspaceRoot({
  state, dispatch, instruments, activePaneId, onPaneClick, onPaneSearch,
}: WorkspaceRootProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const template = LAYOUT_TEMPLATES.find(t => t.id === state.activeLayout)!;

  const colRatios = state.splitRatios['col'] ?? Array(template.cols).fill(1 / template.cols);
  const rowRatios = state.splitRatios['row'] ?? Array(template.rows).fill(1 / template.rows);

  const gridTemplateColumns = buildGridTemplate(colRatios);
  const gridTemplateRows    = buildGridTemplate(rowRatios);

  const activeOrFirstPaneId = activePaneId ?? state.panes[0]?.id ?? null;

  // OI settings refs — shared between toolbar button and active CandleChart
  const openOiSettingsRef = useRef<(() => void) | null>(null);
  const oiSettingsAnchorRef = useRef<HTMLButtonElement | null>(null);

  // Shared drawing engine ref — points to the active pane's drawing engine
  const drawingRef = useRef<DrawingEngineHandle | null>(null);
  // toolbarOpen is owned here so toggling it causes a re-render
  const [toolbarOpen, setToolbarOpen] = useState(true);
  // Toolbar reactive state — updated directly by the drawing engine callback
  const [drawingActiveTool, setDrawingActiveTool] = useState<import('../DrawingToolbar').DrawToolId>('crosshair');
  const [drawingCount, setDrawingCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  // Reset toolbar state when active pane changes
  useEffect(() => {
    setDrawingActiveTool('crosshair');
    setDrawingCount(0);
    setCanUndo(false);
    drawingRef.current?.setActiveTool('crosshair');
  }, [activeOrFirstPaneId]);

  // Stable callback ref — called by useDrawingEngine with fresh values directly
  const onDrawingsChangeRef = useRef(({ activeTool, drawingCount, canUndo }: { activeTool: import('../DrawingToolbar').DrawToolId; drawingCount: number; canUndo: boolean }) => {
    setDrawingActiveTool(activeTool);
    setDrawingCount(drawingCount);
    setCanUndo(canUndo);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#171717' }}>

      {/* ── Single toolbar above all panes — TradingView style ── */}
      <WorkspaceToolbar
        state={state}
        dispatch={dispatch}
        activePaneId={activeOrFirstPaneId}
        instruments={instruments}
        openOiSettingsRef={openOiSettingsRef}
        oiSettingsAnchorRef={oiSettingsAnchorRef}
        onSearchOpen={() => {
          const targetId = activeOrFirstPaneId;
          if (targetId) {
            onPaneSearch(targetId, ins => dispatch({ type: 'SET_INSTRUMENT', paneId: targetId, instrument: ins }));
          }
        }}
      />

      {/* ── Drawing toolbar + pane grid side by side ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>

        {/* One shared drawing toolbar for the whole workspace */}
        <DrawingToolbar
          activeTool={drawingActiveTool}
          onToolChange={t => drawingRef.current?.setActiveTool(t)}
          open={toolbarOpen}
          onToggle={() => setToolbarOpen(o => !o)}
          drawingCount={drawingCount}
          onClearAll={() => drawingRef.current?.clearAll()}
          onUndo={() => drawingRef.current?.undo()}
          canUndo={canUndo}
        />

      {/* ── Pane grid ── */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns,
          gridTemplateRows,
          minHeight: 0,
          userSelect: 'none',
          overflow: 'hidden',
        }}
      >
        {/* Panes */}
        {template.areas.map((area, i) => {
          const pane = state.panes[i];
          if (!pane) return null;
          return (
            <PaneShell
              key={pane.id}
              style={{ gridArea: area }}
              pane={pane}
              instruments={instruments}
              isActive={pane.id === activePaneId}
              onPaneClick={() => onPaneClick(pane.id)}
              onViewChange={v => dispatch({ type: 'SET_VIEW', paneId: pane.id, viewType: v })}
              onInstrumentChange={ins => dispatch({ type: 'SET_INSTRUMENT', paneId: pane.id, instrument: ins })}
              onSearchOpen={() => onPaneSearch(
                pane.id,
                ins => dispatch({ type: 'SET_INSTRUMENT', paneId: pane.id, instrument: ins })
              )}
              activeLayout={state.activeLayout}
              onLayoutChange={id => dispatch({ type: 'SET_LAYOUT', layoutId: id as LayoutId })}
              onIntervalChange={iv => dispatch({ type: 'SET_INTERVAL', paneId: pane.id, interval: iv })}
              onOiShowChange={v => dispatch({ type: 'SET_OI_SHOW', paneId: pane.id, oiShow: v })}
              onOptionChainOpenChange={v => dispatch({ type: 'SET_OC_OPEN', paneId: pane.id, optionChainOpen: v })}
              openOiSettingsRef={pane.id === activeOrFirstPaneId ? openOiSettingsRef : undefined}
              oiSettingsAnchorRef={pane.id === activeOrFirstPaneId ? oiSettingsAnchorRef : undefined}
              onVwapShowChange={v => dispatch({ type: 'SET_VWAP_SHOW', paneId: pane.id, vwapShow: v })}
              onVwapAnchorChange={a => dispatch({ type: 'SET_VWAP_ANCHOR', paneId: pane.id, vwapAnchor: a })}
              onVwapColorChange={c => dispatch({ type: 'SET_VWAP_COLOR', paneId: pane.id, vwapColor: c })}
              onVwapExpiryDayChange={d => dispatch({ type: 'SET_VWAP_EXPIRY_DAY', paneId: pane.id, vwapExpiryDay: d })}
              onTwapShowChange={v => dispatch({ type: 'SET_TWAP_SHOW', paneId: pane.id, twapShow: v })}
              drawingRef={pane.id === activeOrFirstPaneId ? drawingRef : undefined}
              onDrawingsChange={pane.id === activeOrFirstPaneId ? onDrawingsChangeRef.current : undefined}
            />
          );
        })}

        {/* Column dividers — one segment per pane row so they don't bleed across rows */}
        {Array.from({ length: template.cols - 1 }, (_, ci) =>
          Array.from({ length: template.rows }, (__, ri) => (
            <SplitDivider
              key={`col-${ci}-row-${ri}`}
              axis="col"
              containerRef={containerRef}
              ratios={colRatios}
              splitIndex={ci}
              onRatioChange={r => dispatch({ type: 'SET_RATIO', key: 'col', ratios: r })}
              style={{ gridColumn: ci * 2 + 2, gridRow: ri * 2 + 1 }}
            />
          ))
        )}

        {/* Row dividers */}
        {Array.from({ length: template.rows - 1 }, (_, i) => (
          <SplitDivider
            key={`row-${i}`}
            axis="row"
            containerRef={containerRef}
            ratios={rowRatios}
            splitIndex={i}
            onRatioChange={r => dispatch({ type: 'SET_RATIO', key: 'row', ratios: r })}
            style={{ gridRow: i * 2 + 2, gridColumn: `1 / ${template.cols * 2}` }}
          />
        ))}
      </div>
      </div>{/* end flex row: drawing toolbar + pane grid */}
    </div>
  );
}
