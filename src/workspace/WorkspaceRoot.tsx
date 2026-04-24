'use client';

import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Instrument } from '../useInstruments';
import type { WorkspaceState, WorkspaceAction, ViewType, LayoutId } from './workspaceTypes';
import { LAYOUT_TEMPLATES, buildGridTemplate } from './layoutTemplates';
import { LayoutPicker } from './LayoutPicker';
import { SplitDivider } from './SplitDivider';
import { PaneShell } from './PaneShell';
import { DrawingToolbar } from '../DrawingToolbar';
import type { DrawingEngineHandle } from '../DrawingToolbar';
import { TooltipWrap } from '../components/ui/tooltip';
import s from './WorkspaceRoot.module.css';

// ── Interval definitions (mirrored from CandleChart) ─────────────────────────
const INTERVALS = [
  { label: '1m',  value: 'I1'   },
  { label: '5m',  value: 'I5'   },
  { label: '15m', value: 'I15'  },
  { label: '30m', value: 'I30'  },
  { label: '1h',  value: 'I60'  },
  { label: '1D',  value: 'I1D'  },
  { label: '1W',  value: 'I1W'  },
  { label: '1M',  value: 'I1Mo' },
];

// ── View options ─────────────────────────────────────────────────────────────
const VIEW_OPTIONS: { value: ViewType; label: string; icon: React.ReactNode }[] = [
  {
    value: 'candle', label: 'Candle',
    icon: <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="7" width="4" height="10" rx="1"/><line x1="9" y1="3" x2="9" y2="7"/><line x1="9" y1="17" x2="9" y2="21"/><rect x="13" y="4" width="4" height="8" rx="1"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="15" y1="12" x2="15" y2="15"/></svg>,
  },
  {
    value: 'straddle', label: 'Straddle',
    icon: <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 8 12 13 15 21 7"/><polyline points="3 7 8 12 13 9 21 17"/></svg>,
  },
  {
    value: 'oiprofile', label: 'OI',
    icon: <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="20" x2="21" y2="20"/><rect x="4" y="12" width="4" height="8" rx="1"/><rect x="10" y="6" width="4" height="14" rx="1"/><rect x="16" y="9" width="4" height="11" rx="1"/></svg>,
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
        className={s.intervalBtn}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
      >
        {current.label}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#787B86" strokeWidth="2.5" strokeLinecap="round"
          className={open ? s.chevronOpen : s.chevronClosed}>
          <path d="m19 9-7 7-7-7"/>
        </svg>
      </button>
      {open && createPortal(
        <>
          <div className={s.dropdownBackdrop} onClick={() => setOpen(false)} />
          <div className={s.intervalPanel} style={{ top: pos.top, left: pos.left }}>
            <div className={s.dropdownLabel}>Timeframe</div>
            {INTERVALS.map(iv => {
              const active = iv.value === value;
              return (
                <button
                  key={iv.value}
                  onClick={() => { onChange(iv.value); setOpen(false); }}
                  className={`${s.intervalItem} ${active ? s.intervalItemActive : s.intervalItemInactive}`}
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
        className={`${s.indicatorsBtn} ${anyActive ? s.indicatorsBtnActive : open ? s.indicatorsBtnOpen : s.indicatorsBtnInactive}`}
        onMouseEnter={e => { if (!anyActive && !open) { const el = e.currentTarget as HTMLButtonElement; el.style.background = 'rgba(255,255,255,0.06)'; el.style.color = '#9CA3AF'; } }}
        onMouseLeave={e => { if (!anyActive && !open) { const el = e.currentTarget as HTMLButtonElement; el.style.background = 'transparent'; el.style.color = '#6B7280'; } }}
      >
        <span className={s.indicatorsFxIcon}>
          ƒx
        </span>
        <span className={s.indicatorsLabel}>Indicators</span>
        {anyActive && (
          <span className={s.indicatorsBadge}>
            {(vwapShow ? 1 : 0) + (twapShow ? 1 : 0)}
          </span>
        )}
        <span className={s.indicatorsChevronWrap}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            className={open ? s.chevronOpen : s.chevronClosed}>
            <path d="m19 9-7 7-7-7"/>
          </svg>
        </span>
      </button>

      {open && createPortal(
        <>
          <div className={s.dropdownBackdrop} onClick={() => setOpen(false)} />
          <div className={s.indicatorsPanel} style={{ top: pos.top, left: pos.left }}>
            <div className={s.indicatorsPanelLabel}>Indicators</div>

            {/* ── VWAP row ── */}
            <div className={`${s.indicatorCardVwap} ${vwapShow ? s.indicatorCardVwapOn : s.indicatorCardVwapOff}`}>
              {/* VWAP toggle row */}
              <button
                onClick={onVwapToggle}
                className={s.indicatorToggleBtn}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                {/* Toggle pill */}
                <span className={`${s.togglePill} ${vwapShow ? s.togglePillOn : s.togglePillOff}`}>
                  <span className={`${s.toggleKnobBase} ${vwapShow ? s.toggleKnobOn : s.toggleKnobOff}`} />
                </span>
                {/* Line preview */}
                <svg width="28" height="14" viewBox="0 0 28 14" fill="none">
                  <path d="M1 10 L7 4 L14 7 L21 2 L27 5" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M1 12 L7 6 L14 9 L21 4 L27 7" stroke="rgba(255,215,0,0.4)" strokeWidth="1" strokeLinecap="round" strokeDasharray="2 2"/>
                </svg>
                <span className={s.indicatorTextBlock}>
                  <div className={vwapShow ? s.indicatorNameOn : s.indicatorNameOff}>VWAP</div>
                  <div className={s.indicatorDesc}>Volume Weighted Avg Price</div>
                </span>
              </button>

              {/* Settings — only when VWAP on */}
              {vwapShow && (
                <div className={s.vwapSettings}>

                  {/* Color row */}
                  <div>
                    <div className={s.settingsSectionLabel}>Line Color</div>
                    <div className={s.colorSwatchRow}>
                      {VWAP_COLORS.map(c => (
                        <button
                          key={c}
                          onClick={() => onVwapColor(c)}
                          title={c}
                          className={s.colorSwatch}
                          style={{
                            background: c,
                            border: vwapColor === c ? '2px solid #FFFFFF' : '2px solid transparent',
                            boxShadow: vwapColor === c ? `0 0 0 1px ${c}` : 'none',
                          }}
                        />
                      ))}
                      {/* Custom color input */}
                      <label title="Custom color" className={s.colorSwatchCustomLabel}>
                        <span className={s.colorSwatchCustomInner}>+</span>
                        <input type="color" value={vwapColor} onChange={e => onVwapColor(e.target.value)}
                          className={s.colorInputHidden} />
                      </label>
                    </div>
                  </div>

                  {/* Anchor row */}
                  <div>
                    <div className={s.settingsSectionLabel}>Anchor Period</div>
                    <div className={s.anchorRow}>
                      {VWAP_ANCHORS.map(a => {
                        const active = vwapAnchor === a.id;
                        return (
                          <button key={a.id} onClick={() => onVwapAnchor(a.id)}
                            className={`${s.anchorBtn} ${active ? s.anchorBtnActive : s.anchorBtnInactive}`}
                            style={active ? { border: `1px solid ${vwapColor}88`, color: vwapColor } : undefined}
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
                      <div className={s.settingsSectionLabel}>Expiry Day</div>
                      <div className={s.expiryRow}>
                        {(['tuesday','thursday'] as const).map(d => {
                          const active = vwapExpiryDay === d;
                          return (
                            <button key={d} onClick={() => onVwapExpiryDay(d)}
                              className={`${s.expiryBtn} ${active ? s.expiryBtnActive : s.expiryBtnInactive}`}
                              style={active ? { background: `${vwapColor}22`, border: `1px solid ${vwapColor}88`, color: vwapColor } : undefined}
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
            <div className={`${s.indicatorCardTwap} ${twapShow ? s.indicatorCardTwapOn : s.indicatorCardTwapOff}`}>
              <button
                onClick={onTwapToggle}
                className={s.indicatorToggleBtn}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                <span className={`${s.togglePill} ${twapShow ? s.togglePillTwapOn : s.togglePillOff}`}>
                  <span className={`${s.toggleKnobBase} ${twapShow ? s.toggleKnobOn : s.toggleKnobOff}`} />
                </span>
                <svg width="28" height="14" viewBox="0 0 28 14" fill="none">
                  <path d="M1 8 L5 5 L10 9 L15 4 L20 7 L27 3" stroke="#00BFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 2"/>
                </svg>
                <span className={s.indicatorTextBlock}>
                  <div className={twapShow ? s.indicatorNameOn : s.indicatorNameOff}>TWAP</div>
                  <div className={s.indicatorDesc}>Time Weighted Avg Price</div>
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
        className={`${s.layoutBtn} ${open ? s.layoutBtnActive : s.layoutBtnInactive}`}
        onMouseEnter={e => { if (!open) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLButtonElement).style.color = '#C4C7D0'; } }}
        onMouseLeave={e => { if (!open) { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#787B86'; } }}
      >
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      <TooltipWrap content={title} side="bottom" align="center" sideOffset={10}>
        <button
          ref={extraRef}
          onClick={onClick}
          aria-label={title}
          className={`${s.tbBtn} ${label ? s.tbBtnWithLabel : s.tbBtnIconOnly} ${active ? s.tbBtnActive : s.tbBtnInactive}`}
          style={{ background: aBg, border: `1px solid ${aBorder}`, color: aColor }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement;
            if (!active) { el.style.background = 'rgba(255,255,255,0.06)'; el.style.color = '#FFFFFF'; }
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement;
            if (!active) { el.style.background = 'transparent'; el.style.color = '#C9D1DC'; }
          }}
        >
          <span className={s.iconWrap}>{icon}</span>
          {label && <span className={s.labelWrap}>{label}</span>}
        </button>
      </TooltipWrap>
    );
  };

  const SEP = <div className={s.sep} />;

  return (
    <div className={s.toolbar}>

      {/* ── Symbol search container ── */}
      <TooltipWrap content="Search symbol" side="bottom" align="start" sideOffset={10}>
        <button
          onClick={onSearchOpen}
          aria-label="Search symbol"
          className={s.symbolSearch}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.18)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 0 2px rgba(255,255,255,0.04)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.09)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          {activePane.instrument ? (
            <span className={s.symbolLabel}>
              {activePane.instrument.name || activePane.instrument.trading_symbol}
            </span>
          ) : (
            <span className={s.symbolPlaceholder}>Search symbol…</span>
          )}
        </button>
      </TooltipWrap>

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
      <div className={s.viewGroup}>
        {VIEW_OPTIONS.map(opt => {
          const active = opt.value === activePane.viewType;
          return (
            <TooltipWrap key={opt.value} content={opt.label} side="bottom" align="center" sideOffset={10}>
              <button
                onClick={() => dispatch({ type: 'SET_VIEW', paneId: activePane.id, viewType: opt.value })}
                aria-label={opt.label}
                className={`${s.viewBtn} ${active ? s.viewBtnActive : s.viewBtnInactive}`}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#D1D4DC'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#787B86'; }}
              >
                <span className={s.iconWrap}>{opt.icon}</span>
                <span className={s.labelWrap}>{opt.label}</span>
              </button>
            </TooltipWrap>
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
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: optionChainOpen ? `drop-shadow(0 0 4px ${A.base}99)` : 'none', transition: 'filter 0.15s' }}>
              <path d="M12 2v20"/>
              <path d="M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4"/>
              <path d="M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4"/>
              <path d="M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1"/>
              <path d="M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1"/>
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
    <div className={s.workspaceRoot}>

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
      <div className={s.bodyRow}>

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
        className={s.paneGrid}
        style={{ gridTemplateColumns, gridTemplateRows }}
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
