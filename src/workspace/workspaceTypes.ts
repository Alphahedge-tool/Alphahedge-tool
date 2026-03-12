import type { Instrument } from '../useInstruments';

export type ViewType = 'candle' | 'straddle' | 'oiprofile';

export type LayoutId =
  | '1x1'
  | '1x2'
  | '2x1'
  | '2x2'
  | '1L2R'
  | '2L1R'
  | '1T2B'
  | '3col';

export interface PaneState {
  id: string;
  viewType: ViewType;
  instrument: Instrument | null;
  interval?: string;      // e.g. 'I1', 'I5', 'I15', 'I30'
  oiShow?: boolean;
  optionChainOpen?: boolean;
  vwapShow?: boolean;
  vwapAnchor?: 'daily' | 'weekly' | 'monthly' | 'expiry';
  vwapColor?: string;
  vwapExpiryDay?: 'tuesday' | 'thursday';
  twapShow?: boolean;
}

export interface LayoutTemplate {
  id: LayoutId;
  label: string;
  cols: number;
  rows: number;
  paneCount: number;
  // CSS gridArea per pane in gap-aware grid (pane cols at 1,3,5; divider cols at 2,4)
  areas: string[];
  thumbnail: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface WorkspaceState {
  activeLayout: LayoutId;
  panes: PaneState[];
  splitRatios: Record<string, number[]>; // 'col' | 'row' → ratios array summing to 1
}

export type WorkspaceAction =
  | { type: 'SET_LAYOUT'; layoutId: LayoutId }
  | { type: 'SET_VIEW'; paneId: string; viewType: ViewType }
  | { type: 'SET_INSTRUMENT'; paneId: string; instrument: Instrument | null }
  | { type: 'SET_INTERVAL'; paneId: string; interval: string }
  | { type: 'SET_OI_SHOW'; paneId: string; oiShow: boolean }
  | { type: 'SET_OC_OPEN'; paneId: string; optionChainOpen: boolean }
  | { type: 'SET_VWAP_SHOW'; paneId: string; vwapShow: boolean }
  | { type: 'SET_VWAP_ANCHOR'; paneId: string; vwapAnchor: 'daily' | 'weekly' | 'monthly' | 'expiry' }
  | { type: 'SET_VWAP_COLOR'; paneId: string; vwapColor: string }
  | { type: 'SET_VWAP_EXPIRY_DAY'; paneId: string; vwapExpiryDay: 'tuesday' | 'thursday' }
  | { type: 'SET_TWAP_SHOW'; paneId: string; twapShow: boolean }
  | { type: 'SET_RATIO'; key: 'col' | 'row'; ratios: number[] };
