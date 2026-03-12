/**
 * dhanSearch.worker
 *
 * Off-thread search over deduplicated Dhan underlying symbols.
 * Pre-builds a compact index on LOAD so each SEARCH is fast.
 *
 * Ranking order (lower = better):
 *   0  INDEX F&O   (OPTIDX / FUTIDX, NSE/BSE)
 *   1  INDEX       (instrument = 'INDEX')
 *   2  EQ F&O      (OPTSTK / FUTSTK)
 *   3  EQ          (instrument = 'EQUITY' or series = 'EQ')
 *   4  everything else
 *
 * Within same rank: exact match > starts-with > includes
 */

interface DhanEntry {
  underlying_symbol: string;
  display_name: string;
  symbol_name: string;
  segment_key: string;
  u_seg_id: number;
  underlying_security_id: number;  // resolved u_id for opt_chart
  instrument: string;        // FUTIDX | OPTIDX | FUTSTK | OPTSTK | INDEX | EQUITY
  exch_id: string;
  rank: number;
}

let index: DhanEntry[] = [];

function computeRank(instrument: string): number {
  switch (instrument) {
    case 'FUTIDX':
    case 'OPTIDX': return 0;   // Index F&O
    case 'INDEX':  return 1;   // Index spot
    case 'FUTSTK':
    case 'OPTSTK': return 2;   // EQ F&O
    case 'EQUITY': return 3;   // EQ spot
    default:       return 4;
  }
}

function matchScore(entry: DhanEntry, q: string): number {
  const sym = entry.underlying_symbol.toLowerCase();
  const disp = entry.display_name.toLowerCase();
  if (sym === q || disp === q) return 0;           // exact
  if (sym.startsWith(q) || disp.startsWith(q)) return 1;  // prefix
  return 2;                                         // contains
}

function buildIndex(raw: any[]): void {
  const seen = new Set<string>();
  const entries: DhanEntry[] = [];

  for (const ins of raw) {
    const inst = (ins.instrument ?? '').toUpperCase();
    // Only underlyings we care about
    if (!['FUTIDX','OPTIDX','FUTSTK','OPTSTK','INDEX','EQUITY'].includes(inst)) continue;

    const key = `${ins.underlying_symbol}|${ins.u_seg_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // For EQ instruments, underlying_security_id is often 0 in the CSV.
    // In that case fall back to the row's own security_id as the u_id.
    const resolvedUid = (ins.underlying_security_id && ins.underlying_security_id !== 0)
      ? ins.underlying_security_id
      : (ins.security_id ?? 0);

    entries.push({
      underlying_symbol:      ins.underlying_symbol ?? '',
      display_name:           ins.display_name      ?? '',
      symbol_name:            ins.symbol_name       ?? '',
      segment_key:            ins.segment_key       ?? '',
      u_seg_id:               ins.u_seg_id          ?? 0,
      underlying_security_id: resolvedUid,
      instrument:             inst,
      exch_id:                ins.exch_id           ?? '',
      rank:                   computeRank(inst),
    });
  }

  // Pre-sort by rank so searching is already in order
  entries.sort((a, b) => a.rank - b.rank || a.underlying_symbol.localeCompare(b.underlying_symbol));
  index = entries;
}

function search(q: string): DhanEntry[] {
  const ql = q.toLowerCase().trim();
  if (!ql) return [];

  const matched = index.filter(e =>
    e.underlying_symbol.toLowerCase().includes(ql) ||
    e.display_name.toLowerCase().includes(ql)
  );

  // Sort: match score first, then pre-assigned rank, then alpha
  matched.sort((a, b) => {
    const ms = matchScore(a, ql) - matchScore(b, ql);
    if (ms !== 0) return ms;
    const rs = a.rank - b.rank;
    if (rs !== 0) return rs;
    return a.underlying_symbol.localeCompare(b.underlying_symbol);
  });

  return matched.slice(0, 40);
}

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;
  if (type === 'LOAD') {
    buildIndex(payload);
    self.postMessage({ type: 'READY', total: index.length });
  }
  if (type === 'SEARCH') {
    self.postMessage({ type: 'RESULTS', results: search(payload) });
  }
};
