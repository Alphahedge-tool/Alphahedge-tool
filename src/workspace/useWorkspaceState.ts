'use client';

import { useReducer, useEffect, useRef } from 'react';
import type { Instrument } from '../useInstruments';
import type { WorkspaceState, WorkspaceAction, PaneState, LayoutId } from './workspaceTypes';
import { LAYOUT_TEMPLATES } from './layoutTemplates';

const STORAGE_KEY = 'urjaa_workspace_v1';

function makeDefaultPane(): PaneState {
  return { id: crypto.randomUUID(), viewType: 'candle', instrument: null };
}

function reconcilePanes(existing: PaneState[], count: number): PaneState[] {
  const result: PaneState[] = [];
  for (let i = 0; i < count; i++) {
    result.push(existing[i] ?? makeDefaultPane());
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
        panes: reconcilePanes(state.panes, template.paneCount),
        splitRatios: {},
      };
    }
    case 'SET_VIEW':
      return {
        ...state,
        panes: state.panes.map(p =>
          p.id === action.paneId ? { ...p, viewType: action.viewType } : p
        ),
      };
    case 'SET_INSTRUMENT':
      return {
        ...state,
        panes: state.panes.map(p =>
          p.id === action.paneId ? { ...p, instrument: action.instrument } : p
        ),
      };
    case 'SET_INTERVAL':
      return {
        ...state,
        panes: state.panes.map(p =>
          p.id === action.paneId ? { ...p, interval: action.interval } : p
        ),
      };
    case 'SET_OI_SHOW':
      return {
        ...state,
        panes: state.panes.map(p =>
          p.id === action.paneId ? { ...p, oiShow: action.oiShow } : p
        ),
      };
    case 'SET_OC_OPEN':
      return {
        ...state,
        panes: state.panes.map(p =>
          p.id === action.paneId ? { ...p, optionChainOpen: action.optionChainOpen } : p
        ),
      };
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
      return {
        ...state,
        splitRatios: { ...state.splitRatios, [action.key]: action.ratios },
      };
    default:
      return state;
  }
}

function loadState(instruments: Instrument[]): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as WorkspaceState;

    // Validate layout exists
    if (!LAYOUT_TEMPLATES.find(t => t.id === parsed.activeLayout)) return DEFAULT_STATE;

    // Re-hydrate instrument objects from instrument_key
    const panes = parsed.panes?.map(p => ({
      ...p,
      instrument: p.instrument
        ? instruments.find(i => i.instrument_key === p.instrument!.instrument_key) ?? null
        : null,
    })) ?? [makeDefaultPane()];

    return { ...parsed, panes };
  } catch {
    return DEFAULT_STATE;
  }
}

export function useWorkspaceState(instruments: Instrument[]) {
  const [state, dispatch] = useReducer(
    reducer,
    instruments,
    loadState,
  );

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
