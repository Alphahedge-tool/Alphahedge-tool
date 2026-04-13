'use client';

import React, { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import type { Instrument } from '../useInstruments';
import type { PaneState, ViewType } from './workspaceTypes';
import CandleChart from '../CandleChart';
import type { DrawingEngineHandle, DrawToolId } from '../DrawingToolbar';
import s from './PaneShell.module.css';

const StraddleChart = lazy(() => import('../StraddleChart'));
const OIProfileView = lazy(() => import('../OIProfileView'));

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
        className={s.viewPickerBtn}
      >
        {current.short}
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`${s.viewPickerChevron} ${open ? s.viewPickerChevronOpen : s.viewPickerChevronClosed}`}
        >
          <path d="m19 9-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className={s.viewPickerMenu}
          style={{ top: pos.top, left: pos.left }}
        >
          {VIEW_OPTIONS.map(opt => {
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={`${s.viewPickerOption} ${isActive ? s.viewPickerOptionActive : s.viewPickerOptionInactive}`}
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
      className={s.modalBackdrop}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={s.modalCard}
      >
        {/* Header */}
        <div className={s.modalHeader}>
          <span className={s.modalTitle}>
            What do you want to show here?
          </span>
          <button
            onClick={onClose}
            className={s.modalCloseBtn}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Search option */}
        <button
          onClick={() => { onClose(); onSearch(); }}
          className={s.modalOptionBtnSearch}
        >
          <span className={s.modalOptionIconSearch}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </span>
          <span className={s.modalOptionText}>
            <span className={s.modalOptionLabelSearch}>Search Symbol</span>
            <span className={s.modalOptionSubtitle}>Show candle chart for any instrument</span>
          </span>
        </button>

        {/* Divider */}
        <div className={s.modalDivider}>
          <div className={s.modalDividerLine} />
          <span className={s.modalDividerLabel}>or switch view</span>
          <div className={s.modalDividerLine} />
        </div>

        {/* Straddle option */}
        <button
          onClick={() => { onViewChange('straddle'); onClose(); }}
          className={s.modalOptionBtnStraddle}
        >
          <span className={s.modalOptionIconStraddle}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 18 7 10 12 14 17 6 22 10"/>
              <polyline points="2 18 7 14 12 10 17 16 22 12" strokeOpacity="0.45"/>
            </svg>
          </span>
          <span className={s.modalOptionText}>
            <span className={s.modalOptionLabelStraddle}>Straddle Chart</span>
            <span className={s.modalOptionSubtitle}>Live straddle premium view</span>
          </span>
        </button>

        {/* OI Profile option */}
        <button
          onClick={() => { onViewChange('oiprofile'); onClose(); }}
          className={s.modalOptionBtnOi}
        >
          <span className={s.modalOptionIconOi}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="8" height="3" rx="1"/>
              <rect x="2" y="11" width="14" height="3" rx="1"/>
              <rect x="2" y="17" width="6" height="3" rx="1"/>
              <line x1="2" y1="2" x2="2" y2="22"/>
            </svg>
          </span>
          <span className={s.modalOptionText}>
            <span className={s.modalOptionLabelOi}>OI Profile</span>
            <span className={s.modalOptionSubtitle}>Open interest strike-wise profile</span>
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
        className={s.emptyPane}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <div className={s.emptyPaneTextBlock}>
          <div className={s.emptyPaneTitle}>Empty pane</div>
          <div className={s.emptyPaneSubtitle}>Click to select view</div>
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

function resolveDefaultInstrument(instruments: Instrument[]) {
  return instruments.find(i => i.instrument_key === 'NSE_INDEX|Nifty 50')
    ?? instruments.find(i => i.trading_symbol === 'NIFTY' || i.trading_symbol === 'Nifty 50')
    ?? instruments[0]
    ?? null;
}

export function PaneShell({
  pane, instruments, isActive, onPaneClick, onViewChange, onInstrumentChange, onSearchOpen, activeLayout, onLayoutChange, onIntervalChange, onOiShowChange, onOptionChainOpenChange, openOiSettingsRef, oiSettingsAnchorRef, onVwapShowChange, onVwapAnchorChange, onVwapColorChange, onVwapExpiryDayChange, onTwapShowChange, drawingRef, onDrawingsChange, style,
}: PaneShellProps) {
  const isCandle = pane.viewType === 'candle';
  // If no instrument selected yet, fall back to NIFTY (or first available) so chart never shows blank
  const effectiveInstrument = pane.instrument ?? (instruments.length > 0 ? resolveDefaultInstrument(instruments) : null);

  return (
    <div
      onMouseDown={onPaneClick}
      className={`${s.paneShell} ${isActive ? s.paneShellActive : s.paneShellInactive}`}
      style={style}
    >
      {/* For candle: no pane header — CandleChart has its own toolbar.
          For straddle/oiprofile: show a minimal header with view switcher. */}
      {!isCandle && (
        <div className={s.paneHeader}>
          <ViewTypePicker value={pane.viewType} onChange={onViewChange} />
        </div>
      )}

      {/* Pane content */}
      <div className={s.paneContent}>
        {isCandle && (
          effectiveInstrument
            ? <CandleChart
                instrument={effectiveInstrument}
                instruments={instruments}
                onSearchOpen={onSearchOpen}
                onInstrumentChange={ins => onInstrumentChange(ins)}
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
          <Suspense fallback={null}><StraddleChart instruments={instruments} visible={true} /></Suspense>
        )}
        {pane.viewType === 'oiprofile' && (
          <Suspense fallback={null}><OIProfileView instruments={instruments} /></Suspense>
        )}
      </div>
    </div>
  );
}
