'use client';

import React, { createContext, useContext, useState, useCallback, useRef, useEffect, startTransition, useMemo } from 'react';
import { useInstruments, type Instrument } from './useInstruments';
import { loadNubraInstruments } from './db';
import type { NubraInstrument } from './useNubraInstruments';
import type { BasketLeg } from './BasketOrder';

// ── Types ─────────────────────────────────────────────────────────────────────
export type Page = 'chart' | 'straddle' | 'oiprofile' | 'nubra' | 'backtest' | 'historical' | 'mtm';

export interface Greeks { delta: number; theta: number; vega: number; gamma: number; iv: number; }
export interface Leg {
  id: number;
  refId?: number;
  instrumentKey?: string;
  exchange?: string;
  symbol: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  action: 'B' | 'S';
  lots: number;
  lotSize: number;
  price: number;
  entrySpot: number;
  entryTime: string;
  entryDate: string;
  currLtp: number;
  checked: boolean;
  entryGreeks: Greeks;
  currGreeks: Greeks;
}

// ── Google User type ──────────────────────────────────────────────────────────
export interface GoogleUser { name: string; email: string; picture?: string; sub?: string; }

// ── Context 0: Google Auth ────────────────────────────────────────────────────
interface GoogleAuthContextValue {
  googleUser: GoogleUser | null;
  signOut: () => void;
}
const GoogleAuthContext = createContext<GoogleAuthContextValue | null>(null);
export function useGoogleAuth() {
  const ctx = useContext(GoogleAuthContext);
  return ctx ?? { googleUser: null, signOut: () => { localStorage.removeItem('google_user'); window.location.reload(); } };
}

function GoogleAuthProvider({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(() => {
    try { const s = localStorage.getItem('google_user'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const signOut = useCallback(() => {
    localStorage.removeItem('google_user');
    setGoogleUser(null);
    onSignOut?.();
  }, [onSignOut]);
  const value = useMemo<GoogleAuthContextValue>(() => ({ googleUser, signOut }), [googleUser, signOut]);
  return <GoogleAuthContext.Provider value={value}>{children}</GoogleAuthContext.Provider>;
}

// ── Context 1: Navigation — changes on every tab switch ───────────────────────
// Only components that need to know the current page subscribe here.
interface NavContextValue {
  page: Page;
  visited: Set<Page>;
  navigateTo: (p: Page) => void;
}
const NavContext = createContext<NavContextValue | null>(null);
export function useNav() {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used within AppProvider');
  return ctx;
}

// ── Context 2: Instruments — changes only when instruments load ───────────────
interface InstrumentsContextValue {
  instruments: Instrument[];
  nubraInstruments: NubraInstrument[];
  setNubraInstruments: React.Dispatch<React.SetStateAction<NubraInstrument[]>>;
}
const InstrumentsContext = createContext<InstrumentsContextValue | null>(null);
export function useInstrumentsCtx() {
  const ctx = useContext(InstrumentsContext);
  if (!ctx) throw new Error('useInstrumentsCtx must be used within AppProvider');
  return ctx;
}

// ── Context 3: Auth + Basket — changes only on auth/basket actions ────────────
interface AuthBasketContextValue {
  // Auth — Upstox
  token: string;
  setToken: React.Dispatch<React.SetStateAction<string>>;
  tokenInput: string;
  setTokenInput: React.Dispatch<React.SetStateAction<string>>;
  showTokenInput: boolean;
  setShowTokenInput: React.Dispatch<React.SetStateAction<boolean>>;
  autoLoginLoading: boolean;
  setAutoLoginLoading: React.Dispatch<React.SetStateAction<boolean>>;
  autoLoginError: string;
  setAutoLoginError: React.Dispatch<React.SetStateAction<string>>;
  // Auth — Nubra
  showNubraPanel: boolean;
  setShowNubraPanel: React.Dispatch<React.SetStateAction<boolean>>;
  nubraPhone: string;
  setNubraPhone: React.Dispatch<React.SetStateAction<string>>;
  nubraMpin: string;
  setNubraMpin: React.Dispatch<React.SetStateAction<string>>;
  nubraTotpSecret: string;
  setNubraTotpSecret: React.Dispatch<React.SetStateAction<string>>;
  nubraSession: string;
  setNubraSession: React.Dispatch<React.SetStateAction<string>>;
  nubraLogging: boolean;
  setNubraLogging: React.Dispatch<React.SetStateAction<boolean>>;
  nubraError: string;
  setNubraError: React.Dispatch<React.SetStateAction<string>>;
  setupStep: 'phone' | 'otp' | 'done';
  setSetupStep: React.Dispatch<React.SetStateAction<'phone' | 'otp' | 'done'>>;
  setupOtp: string;
  setSetupOtp: React.Dispatch<React.SetStateAction<string>>;
  setupTempToken: string;
  setSetupTempToken: React.Dispatch<React.SetStateAction<string>>;
  showCookieInput: boolean;
  setShowCookieInput: React.Dispatch<React.SetStateAction<boolean>>;
  cookieInput: string;
  setCookieInput: React.Dispatch<React.SetStateAction<string>>;
  // Auth — Dhan
  dhanLoggedIn: boolean;
  setDhanLoggedIn: React.Dispatch<React.SetStateAction<boolean>>;
  showDhanPanel: boolean;
  setShowDhanPanel: React.Dispatch<React.SetStateAction<boolean>>;
  dhanLoading: boolean;
  setDhanLoading: React.Dispatch<React.SetStateAction<boolean>>;
  dhanError: string;
  setDhanError: React.Dispatch<React.SetStateAction<string>>;
  dhanTokenInput: string;
  setDhanTokenInput: React.Dispatch<React.SetStateAction<string>>;
  // Basket
  basketLegs: BasketLeg[];
  setBasketLegs: React.Dispatch<React.SetStateAction<BasketLeg[]>>;
  showBasket: boolean;
  setShowBasket: React.Dispatch<React.SetStateAction<boolean>>;
  domLegs: BasketLeg[];
  setDomLegs: React.Dispatch<React.SetStateAction<BasketLeg[]>>;
  basketPos: { x: number; y: number } | null;
  setBasketPos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  basketIdRef: React.RefObject<number>;
  execBasketRef: React.RefObject<((legs: BasketLeg[], targetStrategy: number) => void) | null>;
  strategyInfoRef: React.RefObject<{ count: number; names: Record<number, string>; active: number }>;
  showExecPicker: boolean;
  setShowExecPicker: React.Dispatch<React.SetStateAction<boolean>>;
  pendingBasketLegs: BasketLeg[];
  setPendingBasketLegs: React.Dispatch<React.SetStateAction<BasketLeg[]>>;
}
const AuthBasketContext = createContext<AuthBasketContextValue | null>(null);
export function useAuthBasket() {
  const ctx = useContext(AuthBasketContext);
  if (!ctx) throw new Error('useAuthBasket must be used within AppProvider');
  return ctx;
}

// ── Legacy combined hook — for components that still use useAppContext ─────────
// Merges all three contexts so existing call sites don't need to change.
export interface AppContextValue extends NavContextValue, InstrumentsContextValue, AuthBasketContextValue {}
export function useAppContext(): AppContextValue {
  const nav = useNav();
  const ins = useInstrumentsCtx();
  const auth = useAuthBasket();
  return useMemo(() => ({ ...nav, ...ins, ...auth }), [nav, ins, auth]);
}

// ── Providers (split so each only re-renders its own consumers) ───────────────

function NavProvider({ children }: { children: React.ReactNode }) {
  const [page, setPage] = useState<Page>('chart');
  const [visited, setVisited] = useState<Set<Page>>(() => new Set<Page>(['chart']));
  const navigateTo = useCallback((p: Page) => {
    startTransition(() => {
      setPage(p);
      setVisited(prev => { const next = new Set(prev); next.add(p); return next; });
    });
  }, []);
  const value = useMemo<NavContextValue>(() => ({ page, visited, navigateTo }), [page, visited, navigateTo]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

function InstrumentsProvider({ children }: { children: React.ReactNode }) {
  const { instruments } = useInstruments();
  const [nubraInstruments, setNubraInstruments] = useState<NubraInstrument[]>([]);
  useEffect(() => {
    loadNubraInstruments().then(result => {
      if (!result) return;
      try {
        const parsed = JSON.parse(result.data);
        const refdata: NubraInstrument[] = Array.isArray(parsed.refdata ?? parsed) ? (parsed.refdata ?? parsed) : [];
        const indexRows: NubraInstrument[] = (parsed.indexes ?? []).map((idx: Record<string, string>) => {
          const indexSymbol = idx.INDEX_SYMBOL ?? idx.index_symbol ?? idx.symbol ?? idx.name ?? '';
          const indexName = idx.INDEX_NAME ?? idx.index_name ?? idx.name ?? idx.symbol ?? '';
          return {
            ref_id: idx.ref_id ?? idx.token ?? '',
            stock_name: indexSymbol || indexName,
            nubra_name: idx.ZANSKAR_INDEX_SYMBOL ?? idx.zanskar_index_symbol ?? idx.nubra_name ?? '',
            strike_price: null,
            option_type: 'N/A',
            token: idx.token ?? '',
            lot_size: 1,
            tick_size: 0.05,
            asset: indexName || indexSymbol,
            expiry: null,
            exchange: idx.EXCHANGE ?? idx.exchange ?? 'NSE',
            derivative_type: 'INDEX',
            isin: '',
            asset_type: 'INDEX',
          } as NubraInstrument;
        });
        if (refdata.length > 0 || indexRows.length > 0) setNubraInstruments([...refdata, ...indexRows]);
      } catch { /* ignore corrupt cache */ }
    });
  }, []);
  const value = useMemo<InstrumentsContextValue>(
    () => ({ instruments, nubraInstruments, setNubraInstruments }),
    [instruments, nubraInstruments],
  );
  return <InstrumentsContext.Provider value={value}>{children}</InstrumentsContext.Provider>;
}

function AuthBasketProvider({ children }: { children: React.ReactNode }) {
  // Auth — Upstox
  const [token, setToken] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('upstox_token') ?? '' : '');
  const [tokenInput, setTokenInput] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('upstox_token') ?? '' : '');
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [autoLoginLoading, setAutoLoginLoading] = useState(false);
  const [autoLoginError, setAutoLoginError] = useState('');
  // Auth — Nubra
  const [showNubraPanel, setShowNubraPanel] = useState(false);
  const [nubraPhone, setNubraPhone] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('nubra_phone') ?? '' : '');
  const [nubraMpin, setNubraMpin] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('nubra_mpin') ?? '' : '');
  const [nubraTotpSecret, setNubraTotpSecret] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('nubra_totp_secret') ?? '' : '');
  const [nubraSession, setNubraSession] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('nubra_session_token') ?? '' : '');
  const [nubraLogging, setNubraLogging] = useState(false);
  const [nubraError, setNubraError] = useState('');
  const [setupStep, setSetupStep] = useState<'phone' | 'otp' | 'done'>('phone');
  const [setupOtp, setSetupOtp] = useState('');
  const [setupTempToken, setSetupTempToken] = useState('');
  const [showCookieInput, setShowCookieInput] = useState(false);
  const [cookieInput, setCookieInput] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('nubra_raw_cookie') ?? '' : '');
  // Auth — Dhan
  const [dhanLoggedIn, setDhanLoggedIn] = useState(() => typeof window !== 'undefined' ? !!localStorage.getItem('dhan_access_token') : false);
  const [showDhanPanel, setShowDhanPanel] = useState(false);
  const [dhanLoading, setDhanLoading] = useState(false);
  const [dhanError, setDhanError] = useState('');
  const [dhanTokenInput, setDhanTokenInput] = useState('');
  // Basket
  const [basketLegs, setBasketLegs] = useState<BasketLeg[]>([]);
  const basketIdRef = useRef(0);
  const [showBasket, setShowBasket] = useState(false);
  const [domLegs, setDomLegs] = useState<BasketLeg[]>([]);
  const [basketPos, setBasketPos] = useState<{ x: number; y: number } | null>(null);
  const execBasketRef = useRef<((legs: BasketLeg[], targetStrategy: number) => void) | null>(null);
  const strategyInfoRef = useRef<{ count: number; names: Record<number, string>; active: number }>({ count: 1, names: { 1: 'Strategy 1' }, active: 1 });
  const [showExecPicker, setShowExecPicker] = useState(false);
  const [pendingBasketLegs, setPendingBasketLegs] = useState<BasketLeg[]>([]);

  const value = useMemo<AuthBasketContextValue>(() => ({
    token, setToken, tokenInput, setTokenInput, showTokenInput, setShowTokenInput,
    autoLoginLoading, setAutoLoginLoading, autoLoginError, setAutoLoginError,
    showNubraPanel, setShowNubraPanel, nubraPhone, setNubraPhone,
    nubraMpin, setNubraMpin, nubraTotpSecret, setNubraTotpSecret,
    nubraSession, setNubraSession, nubraLogging, setNubraLogging,
    nubraError, setNubraError, setupStep, setSetupStep,
    setupOtp, setSetupOtp, setupTempToken, setSetupTempToken,
    showCookieInput, setShowCookieInput, cookieInput, setCookieInput,
    dhanLoggedIn, setDhanLoggedIn, showDhanPanel, setShowDhanPanel,
    dhanLoading, setDhanLoading, dhanError, setDhanError, dhanTokenInput, setDhanTokenInput,
    basketLegs, setBasketLegs, showBasket, setShowBasket,
    domLegs, setDomLegs, basketPos, setBasketPos,
    basketIdRef, execBasketRef, strategyInfoRef,
    showExecPicker, setShowExecPicker, pendingBasketLegs, setPendingBasketLegs,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    token, tokenInput, showTokenInput, autoLoginLoading, autoLoginError,
    showNubraPanel, nubraPhone, nubraMpin, nubraTotpSecret, nubraSession,
    nubraLogging, nubraError, setupStep, setupOtp, setupTempToken,
    showCookieInput, cookieInput,
    dhanLoggedIn, showDhanPanel, dhanLoading, dhanError, dhanTokenInput,
    basketLegs, showBasket, domLegs, basketPos,
    showExecPicker, pendingBasketLegs,
  ]);

  return <AuthBasketContext.Provider value={value}>{children}</AuthBasketContext.Provider>;
}

// ── AppProvider — compose all providers ──────────────────────────────────────
export function AppProvider({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  return (
    <GoogleAuthProvider onSignOut={onSignOut}>
      <AuthBasketProvider>
        <InstrumentsProvider>
          <NavProvider>
            {children}
          </NavProvider>
        </InstrumentsProvider>
      </AuthBasketProvider>
    </GoogleAuthProvider>
  );
}
