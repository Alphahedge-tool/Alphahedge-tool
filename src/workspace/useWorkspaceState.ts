'use client';

import { useReducer, useEffect, useRef } from 'react';
import type { Instrument } from '../useInstruments';
import type { WorkspaceState, WorkspaceAction, PaneState, LayoutId } from './workspaceTypes';
import { LAYOUT_TEMPLATES } from './layoutTemplates';

const STORAGE_KEY    = 'urjaa_workspace_v1';
const NIFTY_STUB_KEY = 'urjaa_nifty_stub';   // cached synchronously in localStorage
const NIFTY_IK       = 'NSE_INDEX|Nifty 50';

function makeDefaultPane(): PaneState {
  return { id: crypto.randomUUID(), viewType: 'candle', instrument: null };
}

function findNifty(instruments: Instrument[]): Instrument | null {
  return instruments.find(i => i.instrument_key === NIFTY_IK)
    ?? instruments.find(i => i.trading_symbol === 'NIFTY' || i.trading_symbol === 'Nifty 50')
    ?? null;
}

// Read NIFTY from localStorage stub — available synchronously before IndexedDB loads
function getNiftyStub(): Instrument | null {
  try {
    const raw = localStorage.getItem(NIFTY_STUB_KEY);
    return raw ? (JSON.parse(raw) as Instrument) : null;
  } catch { return null; }
}

// Persist NIFTY stub once instruments are known
function saveNiftyStub(instruments: Instrument[]) {
  const n = findNifty(instruments);
  if (n) localStorage.setItem(NIFTY_STUB_KEY, JSON.stringify(n));
}

function reconcilePanes(existing: PaneState[], count: number, fallback: Instrument | null): PaneState[] {
  const result: PaneState[] = [];
  for (let i = 0; i < count; i++) {
    result.push(existing[i] ?? { ...makeDefaultPane(), instrument: fallback });
  }
  return result;
}

const DEFAULT_STATE: WorkspaceState = {
  activeLayout: '1x1',
  panes: [makeDefaultPane()],
  splitRatios: {},
};

function reducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'SET_LAYOUT': {
      const template = LAYOUT_TEMPLATES.find(t => t.id === action.layoutId)!;
      return {
        ...state,
        activeLayout: action.layoutId,
        panes: reconcilePanes(state.panes, template.paneCount, null),
        splitRatios: {},
      };
    }
    case 'SET_VIEW':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, viewType: action.viewType } : p) };
    case 'SET_INSTRUMENT':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, instrument: action.instrument } : p) };
    case 'SET_INTERVAL':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, interval: action.interval } : p) };
    case 'SET_OI_SHOW':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, oiShow: action.oiShow } : p) };
    case 'SET_OC_OPEN':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, optionChainOpen: action.optionChainOpen } : p) };
    case 'SET_VWAP_SHOW':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, vwapShow: action.vwapShow } : p) };
    case 'SET_VWAP_ANCHOR':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, vwapAnchor: action.vwapAnchor } : p) };
    case 'SET_VWAP_COLOR':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, vwapColor: action.vwapColor } : p) };
    case 'SET_VWAP_EXPIRY_DAY':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, vwapExpiryDay: action.vwapExpiryDay } : p) };
    case 'SET_TWAP_SHOW':
      return { ...state, panes: state.panes.map(p => p.id === action.paneId ? { ...p, twapShow: action.twapShow } : p) };
    case 'SET_RATIO':
      return { ...state, splitRatios: { ...state.splitRatios, [action.key]: action.ratios } };
    default:
      return state;
  }
}

function loadState(_instruments: Instrument[]): WorkspaceState {
  // Use synchronous stub — available even before IndexedDB resolves
  const nifty = getNiftyStub();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_STATE, panes: [{ ...makeDefaultPane(), instrument: nifty }] };
    }
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!LAYOUT_TEMPLATES.find(t => t.id === parsed.activeLayout)) {
      return { ...DEFAULT_STATE, panes: [{ ...makeDefaultPane(), instrument: nifty }] };
    }
    // Re-hydrate: use saved instrument_key; fall back to stub if not yet in full list
    const panes = parsed.panes?.map(p => ({
      ...p,
      instrument: p.instrument
        ? (_instruments.find(i => i.instrument_key === p.instrument!.instrument_key) ?? p.instrument)
        : nifty,
    })) ?? [{ ...makeDefaultPane(), instrument: nifty }];
    return { ...parsed, panes };
  } catch {
    return { ...DEFAULT_STATE, panes: [{ ...makeDefaultPane(), instrument: nifty }] };
  }
}

export function useWorkspaceState(instruments: Instrument[]) {
  const [state, dispatch] = useReducer(reducer, instruments, loadState);

  // Once full instruments list arrives: save stub + re-hydrate any pane still on the stub object
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (instruments.length === 0) return;
    saveNiftyStub(instruments); // keep stub fresh for next session
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    // Replace stub objects with full instrument objects from the real list
    state.panes.forEach(p => {
      if (!p.instrument) {
        const nifty = findNifty(instruments);
        if (nifty) dispatch({ type: 'SET_INSTRUMENT', paneId: p.id, instrument: nifty });
      } else {
        const full = instruments.find(i => i.instrument_key === p.instrument!.instrument_key);
        if (full && full !== p.instrument) dispatch({ type: 'SET_INSTRUMENT', paneId: p.id, instrument: full });
      }
    });
  }, [instruments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist debounced 500ms
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }, 500);
  }, [state]);

  return { state, dispatch };
}

export type { LayoutId };
