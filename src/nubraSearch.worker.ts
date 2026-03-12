import type { NubraInstrument } from './useNubraInstruments';

let instruments: NubraInstrument[] = [];

// Today as YYYYMMDD number for expiry comparison
const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const todayNum = parseInt(todayStr, 10);

// 0 = exact match, 1 = starts with, 2 = partial match
function matchScore(i: NubraInstrument, q: string): number {
  const name = i.stock_name?.toLowerCase() ?? '';
  const nubra = i.nubra_name?.toLowerCase() ?? '';
  const asset = i.asset?.toLowerCase() ?? '';
  if (name === q || nubra === q || asset === q) return 0;
  if (name.startsWith(q) || nubra.startsWith(q) || asset.startsWith(q)) return 1;
  return 2;
}

// Same logic as Upstox: check if it's a stock first, then index, then F&O
function rankByType(i: NubraInstrument, hasNumber: boolean): number {
  const dt = i.derivative_type?.toUpperCase() ?? '';
  const at = i.asset_type?.toUpperCase() ?? '';
  if (hasNumber) {
    // Number in query → options/futures first (like Upstox NSE_FO/BSE_FO)
    if (at === 'INDEX_FO' && dt === 'OPT') return 0;
    if (at === 'STOCK_FO' && dt === 'OPT') return 1;
    if (at === 'INDEX_FO' && dt === 'FUT') return 2;
    if (at === 'STOCK_FO' && dt === 'FUT') return 3;
    if (dt === 'STOCK') return 4;
    if (dt === 'INDEX') return 5;
    return 6;
  }
  // No number → stocks first, then index, then F&O (same as Upstox EQ→INDEX→FO)
  if (dt === 'STOCK' && at === 'STOCKS') return 0;
  if (dt === 'INDEX') return 1;
  if (at === 'INDEX_FO' && dt === 'FUT') return 2;
  if (at === 'STOCK_FO' && dt === 'FUT') return 3;
  if (at === 'INDEX_FO' && dt === 'OPT') return 4;
  if (at === 'STOCK_FO' && dt === 'OPT') return 5;
  return 6;
}

function filterAndSort(q: string): NubraInstrument[] {
  const hasNumber = /\d/.test(q);
  const matched = instruments.filter(
    (i) =>
      i.stock_name?.toLowerCase().includes(q) ||
      i.nubra_name?.toLowerCase().includes(q) ||
      i.asset?.toLowerCase().includes(q)
  );

  return matched
    .sort((a, b) => {
      // 1. Exact/prefix match wins over partial
      const md = matchScore(a, q) - matchScore(b, q);
      if (md !== 0) return md;
      // 2. Type priority (context-aware like Upstox)
      const rd = rankByType(a, hasNumber) - rankByType(b, hasNumber);
      if (rd !== 0) return rd;
      // 3. Nearest upcoming expiry first, expired pushed to end (like Upstox)
      const ea = parseInt(String(a.expiry ?? '0'), 10);
      const eb = parseInt(String(b.expiry ?? '0'), 10);
      const aExp = ea > 0 && ea < todayNum;
      const bExp = eb > 0 && eb < todayNum;
      if (aExp && !bExp) return 1;
      if (!aExp && bExp) return -1;
      if (ea === 0 && eb > 0) return -1;  // no expiry (stocks) before expiry
      if (ea > 0 && eb === 0) return 1;
      return ea - eb;
    })
    .slice(0, 50);
}

function search(query: string): NubraInstrument[] {
  if (!query.trim()) return [];
  let q = query.toLowerCase();

  // Try full query first, if no match progressively trim last char
  // so a typo like "reliancx" falls back to "relianc" → shows nearest results
  while (q.length > 0) {
    const results = filterAndSort(q);
    if (results.length > 0) return results;
    q = q.slice(0, -1);
  }
  return [];
}

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'LOAD') {
    instruments = payload as NubraInstrument[];
    self.postMessage({ type: 'READY', total: instruments.length });
  }

  if (type === 'SEARCH') {
    const results = search(payload as string);
    self.postMessage({ type: 'RESULTS', results });
  }
};
