type MtmItem = {
  instrument_key: string;
  trading_symbol: string;
  underlying_symbol?: string;
  exchange?: string;
  name?: string;
  // Nubra fields
  stock_name?: string;
  nubra_name?: string;
  asset?: string;
  derivative_type?: string;
  asset_type?: string;
  option_type?: string;
  expiry?: string | number | null;
  strike_price?: number | null;
  // Upstox fields (optional)
  instrument_type?: string;
  segment?: string;
  nubraAssetType?: string;
};

let items: MtmItem[] = [];

const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const todayNum = parseInt(todayStr, 10);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickFields(i: MtmItem): string[] {
  return [
    i.stock_name ?? '',
    i.nubra_name ?? '',
    i.asset ?? '',
    i.trading_symbol ?? '',
    i.underlying_symbol ?? '',
    i.name ?? '',
  ];
}

function matchScore(i: MtmItem, q: string, qn: string): number {
  const fields = pickFields(i).map(s => s.toLowerCase());
  if (fields.some(f => f === q)) return 0;
  if (qn && fields.some(f => normalize(f) === qn)) return 0;
  if (fields.some(f => f.startsWith(q))) return 1;
  if (qn && fields.some(f => normalize(f).startsWith(qn))) return 1;
  return 2;
}

function rankByType(i: MtmItem, hasNumber: boolean): number {
  const dt = (i.derivative_type ?? '').toUpperCase();
  const at = (i.asset_type ?? '').toUpperCase();
  const isOpt = dt === 'OPT' || i.option_type === 'CE' || i.option_type === 'PE';
  const isFut = dt === 'FUT' || (i.instrument_type ?? '').toUpperCase().includes('FUT');
  const isIndex = dt === 'INDEX' || at === 'INDEX' || at === 'INDEX_FO';
  const isStock = dt === 'STOCK' || at === 'STOCKS' || at === 'STOCK_FO';
  const isMcx = at === 'MCX' || (i.exchange ?? '').toUpperCase() === 'MCX';

  if (hasNumber) {
    if (isIndex && isOpt) return 0;
    if (isStock && isOpt) return 1;
    if (isIndex && isFut) return 2;
    if (isStock && isFut) return 3;
    if (isMcx && isOpt) return 4;
    if (isMcx && isFut) return 5;
    if (dt === 'STOCK') return 6;
    if (dt === 'INDEX') return 7;
    return 8;
  }

  if (dt === 'STOCK' && at === 'STOCKS') return 0;
  if (dt === 'INDEX' || isIndex) return 1;
  if (isIndex && isFut) return 2;
  if (isStock && isFut) return 3;
  if (isIndex && isOpt) return 4;
  if (isStock && isOpt) return 5;
  if (isMcx && isFut) return 6;
  if (isMcx && isOpt) return 7;
  return 8;
}

function expiryToNum(e: MtmItem['expiry']): number {
  if (e == null) return 0;
  if (typeof e === 'string') {
    const n = parseInt(e, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof e === 'number') {
    if (e > 20000101 && e < 21000101) return Math.floor(e);
    if (e > 10_000_000_000) {
      const d = new Date(e);
      return parseInt(d.toISOString().slice(0, 10).replace(/-/g, ''), 10);
    }
    if (e > 1_000_000_000) {
      const d = new Date(e * 1000);
      return parseInt(d.toISOString().slice(0, 10).replace(/-/g, ''), 10);
    }
    return Math.floor(e);
  }
  return 0;
}

function filterAndSort(q: string): MtmItem[] {
  const hasNumber = /\d/.test(q);
  const qn = normalize(q);
  const matched = items.filter(i =>
    pickFields(i).some(f => f.toLowerCase().includes(q)) ||
    (qn.length > 0 && pickFields(i).some(f => normalize(f).includes(qn)))
  );

  return matched
    .sort((a, b) => {
      const md = matchScore(a, q, qn) - matchScore(b, q, qn);
      if (md !== 0) return md;
      const rd = rankByType(a, hasNumber) - rankByType(b, hasNumber);
      if (rd !== 0) return rd;
      const ea = expiryToNum(a.expiry);
      const eb = expiryToNum(b.expiry);
      const aExp = ea > 0 && ea < todayNum;
      const bExp = eb > 0 && eb < todayNum;
      if (aExp && !bExp) return 1;
      if (!aExp && bExp) return -1;
      if (ea === 0 && eb > 0) return -1;
      if (ea > 0 && eb === 0) return 1;
      return ea - eb;
    })
    .slice(0, 60);
}

function search(query: string): MtmItem[] {
  if (!query.trim()) return [];
  let q = query.toLowerCase();
  while (q.length > 0) {
    const results = filterAndSort(q);
    if (results.length > 0) return results;
    q = q.slice(0, -1);
  }
  return [];
}

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;
  if (type === 'BUILD' || type === 'LOAD') {
    items = (e.data.instruments ?? e.data.payload ?? []) as MtmItem[];
    self.postMessage({ type: 'READY', total: items.length });
  }
  if (type === 'SEARCH') {
    const query = e.data.query ?? e.data.payload ?? '';
    self.postMessage({ type: 'RESULTS', results: search(query as string) });
  }
};
