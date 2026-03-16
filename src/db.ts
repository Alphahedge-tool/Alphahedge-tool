'use client';

const DB_NAME = 'urjaa_instruments';
const DB_VERSION = 6;
const STORE_NAME = 'cache';
const KEY = 'instruments_blob';
const DATE_KEY = 'instruments_date';

const NUBRA_STORE = 'nubra_cache';
const NUBRA_KEY = 'nubra_instruments';
const NUBRA_DATE_KEY = 'nubra_date';

const DHAN_STORE = 'dhan_cache';
const DHAN_KEY = 'dhan_instruments';
const DHAN_DATE_KEY = 'dhan_date';

const AUTH_STORE  = 'auth_cache';   // { token, date } keyed by 'upstox'|'nubra'
const CREDS_STORE = 'user_creds';   // broker credentials keyed by google sub

const PM_STORE = 'premarket_candles';

// Stored value shape: { date: string; candles: Record<interval, number[][]> }
// Key: instrument_key

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(NUBRA_STORE)) {
        db.createObjectStore(NUBRA_STORE);
      }
      if (!db.objectStoreNames.contains(DHAN_STORE)) {
        db.createObjectStore(DHAN_STORE);
      }
      if (!db.objectStoreNames.contains(PM_STORE)) {
        db.createObjectStore(PM_STORE);
      }
      if (!db.objectStoreNames.contains(AUTH_STORE)) {
        db.createObjectStore(AUTH_STORE);
      }
      if (!db.objectStoreNames.contains(CREDS_STORE)) {
        db.createObjectStore(CREDS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Pre-market candle helpers ──────────────────────────────────────────────

export interface PreMarketEntry {
  date: string;                          // YYYY-MM-DD in IST
  // Raw 1-min ticks: [timestampSec, open, high, low, close, volume]
  ticks: number[][];
}

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export async function savePreMarketTicks(instrumentKey: string, ticks: number[][]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PM_STORE, 'readwrite');
    const store = tx.objectStore(PM_STORE);
    const entry: PreMarketEntry = { date: todayIST(), ticks };
    store.put(entry, instrumentKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPreMarketTicks(instrumentKey: string): Promise<number[][] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PM_STORE, 'readonly');
    const store = tx.objectStore(PM_STORE);
    const req = store.get(instrumentKey);
    tx.oncomplete = () => {
      const entry = req.result as PreMarketEntry | undefined;
      if (!entry) { resolve(null); return; }
      // Delete if stale: saved on a different date AND past 3:30 AM IST today
      const today = todayIST();
      const istTime = new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const [h, m] = istTime.split(':').map(Number);
      const isPast330AM = h > 3 || (h === 3 && m >= 30);
      if (entry.date !== today && isPast330AM) {
        // Stale — delete silently
        clearPreMarketTicks(instrumentKey).catch(() => {});
        resolve(null);
      } else {
        resolve(entry.ticks);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearPreMarketTicks(instrumentKey: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PM_STORE, 'readwrite');
    tx.objectStore(PM_STORE).delete(instrumentKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Upstox instruments ──
export async function saveBlob(data: Uint8Array, date: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(data, KEY);
    store.put(date, DATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadBlob(): Promise<{ data: Uint8Array; date: string } | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const dataReq = store.get(KEY);
    const dateReq = store.get(DATE_KEY);
    tx.oncomplete = () => {
      if (dataReq.result && dateReq.result) {
        resolve({ data: dataReq.result as Uint8Array, date: dateReq.result as string });
      } else {
        resolve(null);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearBlob(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(KEY);
    store.delete(DATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Nubra instruments ──
export async function saveNubraInstruments(data: string, date: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NUBRA_STORE, 'readwrite');
    const store = tx.objectStore(NUBRA_STORE);
    store.put(data, NUBRA_KEY);
    store.put(date, NUBRA_DATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearNubraInstruments(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NUBRA_STORE, 'readwrite');
    const store = tx.objectStore(NUBRA_STORE);
    store.delete(NUBRA_KEY);
    store.delete(NUBRA_DATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadNubraInstruments(): Promise<{ data: string; date: string } | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NUBRA_STORE, 'readonly');
    const store = tx.objectStore(NUBRA_STORE);
    const dataReq = store.get(NUBRA_KEY);
    const dateReq = store.get(NUBRA_DATE_KEY);
    tx.oncomplete = () => {
      if (dataReq.result && dateReq.result) {
        resolve({ data: dataReq.result, date: dateReq.result });
      } else {
        resolve(null);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ── Dhan instruments ──
export async function saveDhanInstruments(data: string, date: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DHAN_STORE, 'readwrite');
    const store = tx.objectStore(DHAN_STORE);
    store.put(data, DHAN_KEY);
    store.put(date, DHAN_DATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDhanInstruments(): Promise<{ data: string; date: string } | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DHAN_STORE, 'readonly');
    const store = tx.objectStore(DHAN_STORE);
    const dataReq = store.get(DHAN_KEY);
    const dateReq = store.get(DHAN_DATE_KEY);
    tx.oncomplete = () => {
      if (dataReq.result && dateReq.result) {
        resolve({ data: dataReq.result, date: dateReq.result });
      } else {
        resolve(null);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ── Auth tokens (Upstox + Nubra) ──────────────────────────────────────────────
// Stored as { token: string; date: string } keyed by broker name.
// date = IST YYYY-MM-DD — lets SetupScreen know if the token was created today.

export interface AuthEntry {
  token: string;
  date: string;
  // Nubra extras
  auth_token?: string;
  raw_cookie?: string;
  device_id?: string;
  // Upstox extras (none currently needed beyond token)
}

export async function saveAuthToken(
  key: 'upstox' | 'nubra',
  token: string,
  extras?: Omit<AuthEntry, 'token' | 'date'>,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTH_STORE, 'readwrite');
    tx.objectStore(AUTH_STORE).put({ token, date: todayIST(), ...extras }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAuthToken(key: 'upstox' | 'nubra'): Promise<AuthEntry | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTH_STORE, 'readonly');
    const req = tx.objectStore(AUTH_STORE).get(key);
    tx.oncomplete = () => resolve(req.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAuthToken(key: 'upstox' | 'nubra'): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTH_STORE, 'readwrite');
    tx.objectStore(AUTH_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── User broker credentials (stored per Google sub) ───────────────────────────
export interface UserCreds {
  upstox?: { phone: string; pin: string; totp_secret: string; api_key: string; api_secret: string; };
  nubra?:  { phone: string; mpin: string; totp_secret: string; };
}

export async function saveUserCreds(sub: string, creds: UserCreds): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CREDS_STORE, 'readwrite');
    tx.objectStore(CREDS_STORE).put(creds, sub);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadUserCreds(sub: string): Promise<UserCreds | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CREDS_STORE, 'readonly');
    const req = tx.objectStore(CREDS_STORE).get(sub);
    tx.oncomplete = () => resolve(req.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}
