'use client';

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Instrument } from '../useInstruments';
import type { PaneState, ViewType } from './workspaceTypes';
import CandleChart from '../CandleChart';
import StraddleChart from '../StraddleChart';
import OIProfileView from '../OIProfileView';
import type { DrawingEngineHandle, DrawToolId } from '../DrawingToolbar';

// ── View type picker ──────────────────────────────────────────────────────────

const VIEW_OPTIONS: { value: ViewType; label: string; short: string }[] = [
  { value: 'candle',    label: 'Candle Chart', short: 'Candle'   },
  { value: 'straddle',  label: 'Straddle',     short: 'Straddle' },
  { value: 'oiprofile', label: 'OI Profile',   short: 'OI'       },
];

function ViewTypePicker({
  value, onChange,
}: { value: ViewType; onChange: (v: ViewType) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 3, left: r.left });
    }
    setOpen(o => !o);
  };

  const current = VIEW_OPTIONS.find(o => o.value === value)!;

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          height: 20, padding: '0 6px',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 4,
          fontSize: 10, fontWeight: 600, color: '#9B9EA8',
          cursor: 'pointer', letterSpacing: '0.04em',
          transition: 'border-color 0.1s, color 0.1s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.2)'; (e.currentTarget as HTMLButtonElement).style.color = '#D1D4DC'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.10)'; (e.currentTarget as HTMLButtonElement).style.color = '#9B9EA8'; }}
      >
        {current.short}
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
          <path d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed', top: pos.top, left: pos.left,
            zIndex: 9600,
            background: '#1f1f1f',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            padding: 4,
            minWidth: 130,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
          }}
        >
          {VIEW_OPTIONS.map(opt => {
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '6px 10px',
                  background: isActive ? 'rgba(255,152,0,0.10)' : 'transparent',
                  border: 'none', borderRadius: 4,
                  fontSize: 11, fontWeight: isActive ? 700 : 500,
                  color: isActive ? '#FF9800' : '#C4C7D0',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                {opt.label}
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

// ── Pane action modal ─────────────────────────────────────────────────────────

interface PaneActionModalProps {
  onSearch: () => void;
  onViewChange: (v: ViewType) => void;
  onClose: () => void;
}

function PaneActionModal({ onSearch, onViewChange, onClose }: PaneActionModalProps) {
  // Close on backdrop click
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        zIndex: 9700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'rgba(17,20,28,0.98)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 14,
          padding: '24px 20px 20px',
          width: 320,
          boxShadow: '0 24px 64px rgba(0,0,0,0.85)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#D1D4DC', letterSpacing: '0.02em' }}>
            What do you want to show here?
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4A4E5C', padding: 2, display: 'flex' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Search option */}
        <button
          onClick={() => { onClose(); onSearch(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            width: '100%', padding: '11px 14px',
            background: 'rgba(255,152,0,0.06)',
            border: '1px solid rgba(255,152,0,0.20)',
            borderRadius: 9, cursor: 'pointer',
            transition: 'background 0.12s, border-color 0.12s',
            textAlign: 'left',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,152,0,0.12)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,152,0,0.40)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,152,0,0.06)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,152,0,0.20)'; }}
        >
          <span style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'rgba(255,152,0,0.14)', color: '#FF9800',
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#FF9800' }}>Search Symbol</span>
            <span style={{ fontSize: 10, color: '#787B86' }}>Show candle chart for any instrument</span>
          </span>
        </button>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
          <span style={{ fontSize: 9, color: '#4A4E5C', letterSpacing: '0.08em', textTransform: 'uppercase' }}>or switch view</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
        </div>

        {/* Straddle option */}
        <button
          onClick={() => { onViewChange('straddle'); onClose(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            width: '100%', padding: '11px 14px',
            background: 'rgba(123,104,238,0.06)',
            border: '1px solid rgba(123,104,238,0.18)',
            borderRadius: 9, cursor: 'pointer',
            transition: 'background 0.12s, border-color 0.12s',
            textAlign: 'left',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(123,104,238,0.12)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(123,104,238,0.38)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(123,104,238,0.06)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(123,104,238,0.18)'; }}
        >
          <span style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'rgba(123,104,238,0.14)', color: '#7B68EE',
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 18 7 10 12 14 17 6 22 10"/>
              <polyline points="2 18 7 14 12 10 17 16 22 12" strokeOpacity="0.45"/>
            </svg>
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#7B68EE' }}>Straddle Chart</span>
            <span style={{ fontSize: 10, color: '#787B86' }}>Live straddle premium view</span>
          </span>
        </button>

        {/* OI Profile option */}
        <button
          onClick={() => { onViewChange('oiprofile'); onClose(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            width: '100%', padding: '11px 14px',
            background: 'rgba(255,152,0,0.04)',
            border: '1px solid rgba(255,152,0,0.14)',
            borderRadius: 9, cursor: 'pointer',
            transition: 'background 0.12s, border-color 0.12s',
            textAlign: 'left',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,152,0,0.10)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,152,0,0.32)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,152,0,0.04)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,152,0,0.14)'; }}
        >
          <span style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'rgba(255,152,0,0.12)', color: '#FF9800',
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="8" height="3" rx="1"/>
              <rect x="2" y="11" width="14" height="3" rx="1"/>
              <rect x="2" y="17" width="6" height="3" rx="1"/>
              <line x1="2" y1="2" x2="2" y2="22"/>
            </svg>
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#FF9800' }}>OI Profile</span>
            <span style={{ fontSize: 10, color: '#787B86' }}>Open interest strike-wise profile</span>
          </span>
        </button>
      </div>
    </div>,
    document.body
  );
}

// ── Empty pane prompt ─────────────────────────────────────────────────────────

function EmptyPane({ onSearch, onViewChange }: { onSearch: () => void; onViewChange: (v: ViewType) => void }) {
  const [showModal, setShowModal] = useState(false);
  return (
    <>
      <div
        onClick={() => setShowModal(true)}
        style={{
          width: '100%', height: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 10, cursor: 'pointer',
          background: '#171717',
          color: '#4A4E5C',
        }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: '#787B86', marginBottom: 4 }}>Empty pane</div>
          <div style={{ fontSize: 11, color: '#4A4E5C' }}>Click to select view</div>
        </div>
      </div>
      {showModal && (
        <PaneActionModal
          onSearch={onSearch}
          onViewChange={onViewChange}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

// ── PaneShell ─────────────────────────────────────────────────────────────────

interface PaneShellProps {
  pane: PaneState;
  instruments: Instrument[];
  isActive: boolean;
  onPaneClick: () => void;
  onViewChange: (v: ViewType) => void;
  onInstrumentChange: (ins: Instrument | null) => void;
  onSearchOpen: () => void;
  activeLayout: string;
  onLayoutChange: (id: string) => void;
  onIntervalChange: (iv: string) => void;
  onOiShowChange: (v: boolean) => void;
  onOptionChainOpenChange: (v: boolean) => void;
  openOiSettingsRef?: { current: (() => void) | null };
  oiSettingsAnchorRef?: React.RefObject<HTMLButtonElement | null>;
  onVwapShowChange: (v: boolean) => void;
  onVwapAnchorChange: (a: 'daily' | 'weekly' | 'monthly' | 'expiry') => void;
  onVwapColorChange: (c: string) => void;
  onVwapExpiryDayChange: (d: 'tuesday' | 'thursday') => void;
  onTwapShowChange: (v: boolean) => void;
  drawingRef?: React.MutableRefObject<DrawingEngineHandle | null>;
  onDrawingsChange?: (state: { activeTool: DrawToolId; drawingCount: number; canUndo: boolean }) => void;
  style?: React.CSSProperties;
}

export function PaneShell({
  pane, instruments, isActive, onPaneClick, onViewChange, onSearchOpen, activeLayout, onLayoutChange, onIntervalChange, onOiShowChange, onOptionChainOpenChange, openOiSettingsRef, oiSettingsAnchorRef, onVwapShowChange, onVwapAnchorChange, onVwapColorChange, onVwapExpiryDayChange, onTwapShowChange, drawingRef, onDrawingsChange, style,
}: PaneShellProps) {
  const isCandle = pane.viewType === 'candle';

  return (
    <div
      onMouseDown={onPaneClick}
      style={{
        ...style,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden', minWidth: 0, minHeight: 0,
        background: '#171717',
        border: `1px solid ${isActive ? 'rgba(255,152,0,0.45)' : 'rgba(255,255,255,0.05)'}`,
        transition: 'border-color 0.15s',
        boxShadow: isActive ? '0 0 0 1px rgba(255,152,0,0.15) inset' : 'none',
      }}>
      {/* For candle: no pane header — CandleChart has its own toolbar.
          For straddle/oiprofile: show a minimal header with view switcher. */}
      {!isCandle && (
        <div style={{
          height: 28, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '0 8px',
          background: 'rgba(255,255,255,0.02)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <ViewTypePicker value={pane.viewType} onChange={onViewChange} />
        </div>
      )}

      {/* Pane content */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        {isCandle && (
          pane.instrument
            ? <CandleChart
                instrument={pane.instrument}
                instruments={instruments}
                onSearchOpen={onSearchOpen}
                onViewChange={onViewChange}
                activeLayout={activeLayout}
                onLayoutChange={onLayoutChange}
                hideToolbar={true}
                defaultInterval={pane.interval}
                onIntervalChange={onIntervalChange}
                oiShowProp={pane.oiShow}
                onOiShowChange={onOiShowChange}
                optionChainOpenProp={pane.optionChainOpen}
                onOptionChainOpenChange={onOptionChainOpenChange}
                openOiSettingsRef={openOiSettingsRef}
                oiSettingsAnchorRef={oiSettingsAnchorRef}
                vwapShowProp={pane.vwapShow}
                onVwapShowChange={onVwapShowChange}
                vwapAnchorProp={pane.vwapAnchor}
                onVwapAnchorChange={onVwapAnchorChange}
                vwapColorProp={pane.vwapColor}
                onVwapColorChange={onVwapColorChange}
                vwapExpiryDayProp={pane.vwapExpiryDay}
                onVwapExpiryDayChange={onVwapExpiryDayChange}
                twapShowProp={pane.twapShow}
                onTwapShowChange={onTwapShowChange}
                drawingRef={drawingRef}
                onDrawingsChange={onDrawingsChange}
              />
            : <EmptyPane onSearch={onSearchOpen} onViewChange={onViewChange} />
        )}
        {pane.viewType === 'straddle' && (
          <StraddleChart instruments={instruments} visible={true} />
        )}
        {pane.viewType === 'oiprofile' && (
          <OIProfileView instruments={instruments} />
        )}
      </div>
    </div>
  );
}
