/**
 * Zustand stores for OptionChain live data.
 * Each strike's CE/PE data is stored in a flat map.
 * Row components subscribe only to their own strike key — zero cross-row re-renders on WS ticks.
 */
import { create } from 'zustand';

export interface StrikeData {
  ltp: number;
  chgPct: number;
  oi: number;
  oiChgPct: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  iv: number;
  ref_id?: number;
}

export const EMPTY_SIDE: StrikeData = {
  ltp: 0, chgPct: 0, oi: 0, oiChgPct: 0,
  delta: 0, theta: 0, gamma: 0, vega: 0, iv: 0,
};

export interface StrikeEntry {
  strike: number;
  ce: StrikeData;
  pe: StrikeData;
  isAtm: boolean;
}

interface OCState {
  strikeList: number[];
  strikeMap:  Map<number, StrikeEntry>;
  spot: number;
  atm:  number;
  initStrikes:  (entries: StrikeEntry[], spot: number, atm: number) => void;
  patchStrikes: (patches: { strike: number; ce?: Partial<StrikeData>; pe?: Partial<StrikeData> }[], spot: number, atm: number) => void;
  reset: () => void;
}

function makeStore() {
  return create<OCState>((set, get) => ({
    strikeList: [],
    strikeMap:  new Map(),
    spot: 0,
    atm:  0,

    initStrikes(entries, spot, atm) {
      const map = new Map<number, StrikeEntry>();
      for (const e of entries) map.set(e.strike, e);
      set({ strikeList: entries.map(e => e.strike), strikeMap: map, spot, atm });
    },

    patchStrikes(patches, spot, atm) {
      const prev = get().strikeMap;
      const next = new Map(prev);
      for (const p of patches) {
        const existing = next.get(p.strike);
        if (!existing) continue;
        next.set(p.strike, {
          ...existing,
          ...(p.ce ? { ce: { ...existing.ce, ...p.ce } } : {}),
          ...(p.pe ? { pe: { ...existing.pe, ...p.pe } } : {}),
        });
      }
      // Re-mark ATM only if it changed
      let atmStrike = get().atm;
      if (atm > 0) {
        let minD = Infinity;
        for (const s of get().strikeList) {
          const d = Math.abs(s - atm);
          if (d < minD) { minD = d; atmStrike = s; }
        }
        if (atmStrike !== get().atm) {
          const old = get().atm;
          const oldEntry = next.get(old);
          const newEntry = next.get(atmStrike);
          if (oldEntry) next.set(old,       { ...oldEntry, isAtm: false });
          if (newEntry) next.set(atmStrike, { ...newEntry, isAtm: true  });
        }
      }
      set({ strikeMap: next, spot, atm: atmStrike });
    },

    reset() {
      set({ strikeList: [], strikeMap: new Map(), spot: 0, atm: 0 });
    },
  }));
}

// Separate store instances so NSE and MCX chains don't share state
export const useOptionChainStore    = makeStore();
export const useOptionChainStoreMCX = makeStore();
